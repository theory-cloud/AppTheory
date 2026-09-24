package objectstore

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// MaxPresignPutExpiresIn is the framework ceiling for a bounded object upload grant.
//
// An upload grant is the single narrow presigning exception in AppTheory's object-store
// contract. It never extends past fifteen minutes.
const MaxPresignPutExpiresIn = 15 * time.Minute

// ErrInvalidPresignPut is returned when an upload-grant request is incomplete or unsafe.
var ErrInvalidPresignPut = errors.New("objectstore: invalid presign put")

const (
	presignPutMethod              = "PUT"
	presignPutHeaderContentLength = "content-length"
	presignPutHeaderContentType   = "content-type"
	presignPutHeaderChecksum      = "x-amz-checksum-sha256"
	presignPutSignedHeadersParam  = "X-Amz-SignedHeaders"
	presignPutExpiresParam        = "X-Amz-Expires"
	presignPutMaxExpiresSeconds   = int64(MaxPresignPutExpiresIn / time.Second)
)

// presignPutRequiredHeaders are the constraint headers a signed upload grant must carry. They are
// signed request headers, never unsigned query parameters.
var presignPutRequiredHeaders = []string{
	presignPutHeaderContentLength,
	presignPutHeaderContentType,
	presignPutHeaderChecksum,
}

// UploadGranter is AppTheory's bounded upload-grant capability.
//
// It is deliberately separate from Store: the bounded Put/Get/Delete contract is unchanged, and a
// store opts in to minting upload links. The only grant it can mint authorizes a single PUT of
// declared bytes to one exact object reference, with a signed content length, content type and
// SHA-256 checksum, for at most MaxPresignPutExpiresIn.
//
// Presigned GET, presigning without a checksum, list, multipart, copy, head, public URLs and raw
// clients remain forbidden: they have no method here and none on Store.
type UploadGranter interface {
	PresignPut(context.Context, PresignPutInput) (*PresignPutOutput, error)
}

// PresignPutInput describes one bounded upload grant request.
//
// Every field is required. Ref must be an exact, unversioned s3://bucket/key reference;
// ContentLength must be positive and no larger than MaxBytes; ChecksumSHA256 must be the canonical
// base64 encoding of the 32-byte SHA-256 digest of the exact bytes the client will upload;
// ContentType must be non-empty; and ExpiresIn must be a whole number of seconds, positive and at
// most MaxPresignPutExpiresIn. ContentLength, MaxBytes and ExpiresIn are typed integers here, so a
// fractional byte count or expiry cannot even be expressed; the other runtimes refuse one with
// ErrInvalidPresignPut instead.
type PresignPutInput struct {
	Ref            ObjectRef
	ContentLength  int64
	ChecksumSHA256 string
	ContentType    string
	MaxBytes       int64
	ExpiresIn      time.Duration
}

// PresignPutOutput is a bounded upload grant.
//
// Headers holds exactly the headers the client must send with the upload. The URL only ever
// authorizes those bytes: content length, content type and checksum are part of the signed
// headers.
type PresignPutOutput struct {
	Ref       ObjectRef
	URL       string
	Method    string
	Headers   map[string]string
	ExpiresAt time.Time
}

// Validate verifies that an upload-grant request is complete and safe.
//
// Every failure mode is fail-closed: an unversioned exact reference, a positive content length no
// larger than MaxBytes, a non-empty unpadded content type, the canonical base64 SHA-256 digest,
// and an expiry of a whole number of seconds, above zero and at most MaxPresignPutExpiresIn.
//
// Whole seconds matter because the grant carries the expiry as X-Amz-Expires, an integer number of
// seconds. A sub-second or fractional expiry would be truncated to zero by the signer and mint a
// link that has already expired, so it is refused here with ErrInvalidPresignPut, identically for
// the S3 store and the test fake.
func (i PresignPutInput) Validate() error {
	if err := i.Ref.Validate(); err != nil {
		return err
	}
	if i.Ref.VersionID != "" {
		return ErrInvalidObjectRef
	}
	if i.ContentLength <= 0 || i.MaxBytes <= 0 || i.ContentLength > i.MaxBytes {
		return ErrInvalidPresignPut
	}
	if !validPresignPutContentType(i.ContentType) {
		return ErrInvalidPresignPut
	}
	if !validPresignPutChecksumSHA256(i.ChecksumSHA256) {
		return ErrInvalidPresignPut
	}
	if i.ExpiresIn <= 0 || i.ExpiresIn > MaxPresignPutExpiresIn || i.ExpiresIn%time.Second != 0 {
		return ErrInvalidPresignPut
	}
	return nil
}

func validPresignPutContentType(contentType string) bool {
	if contentType == "" || contentType != strings.TrimSpace(contentType) {
		return false
	}
	return !containsControl(contentType)
}

// validPresignPutChecksumSHA256 accepts only the canonical base64 encoding of a 32-byte digest.
// The explicit length, alphabet, padding and round-trip checks keep every runtime identical: some
// language standard decoders silently accept non-canonical input.
func validPresignPutChecksumSHA256(checksum string) bool {
	const encodedSHA256Length = 44
	if len(checksum) != encodedSHA256Length || !strings.HasSuffix(checksum, "=") {
		return false
	}
	for index := 0; index < encodedSHA256Length-1; index++ {
		if !isBase64StandardByte(checksum[index]) {
			return false
		}
	}
	decoded, err := base64.StdEncoding.DecodeString(checksum)
	if err != nil {
		return false
	}
	if len(decoded) != sha256.Size {
		return false
	}
	return base64.StdEncoding.EncodeToString(decoded) == checksum
}

func isBase64StandardByte(value byte) bool {
	switch {
	case value >= 'A' && value <= 'Z', value >= 'a' && value <= 'z', value >= '0' && value <= '9':
		return true
	case value == '+' || value == '/':
		return true
	default:
		return false
	}
}

func presignPutHeaders(input PresignPutInput) map[string]string {
	return map[string]string{
		presignPutHeaderContentLength: strconv.FormatInt(input.ContentLength, 10),
		presignPutHeaderContentType:   input.ContentType,
		presignPutHeaderChecksum:      input.ChecksumSHA256,
	}
}

// verifyPresignPutURL enforces the grant's post-condition on a presigned URL.
//
// A URL is only returned when the constraint headers really are signed headers and are not hoisted
// into unsigned query parameters, and when the embedded expiry cannot outlive the requested one.
// X-Amz-Expires must be bare ASCII digits. Anything else is a misconfigured signer and fails closed.
func verifyPresignPutURL(rawURL string, requested time.Duration) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ErrInvalidStoreConfig
	}
	query := parsed.Query()
	if len(query) == 0 {
		return ErrInvalidStoreConfig
	}

	signedRaw, ok := presignQueryValue(query, presignPutSignedHeadersParam)
	if !ok {
		return ErrInvalidStoreConfig
	}
	signed := make(map[string]struct{})
	for _, name := range strings.Split(strings.ToLower(signedRaw), ";") {
		signed[strings.TrimSpace(name)] = struct{}{}
	}
	for _, required := range presignPutRequiredHeaders {
		if _, isSigned := signed[required]; !isSigned {
			return ErrInvalidStoreConfig
		}
		if _, hoisted := presignQueryValue(query, required); hoisted {
			return ErrInvalidStoreConfig
		}
	}

	expiresRaw, ok := presignQueryValue(query, presignPutExpiresParam)
	if !ok {
		return ErrInvalidStoreConfig
	}
	expiresSeconds, ok := presignPutExpirySeconds(expiresRaw)
	if !ok || expiresSeconds <= 0 || expiresSeconds > presignPutMaxExpiresSeconds {
		return ErrInvalidStoreConfig
	}
	if requested > 0 && expiresSeconds > int64(requested/time.Second) {
		return ErrInvalidStoreConfig
	}
	return nil
}

// presignPutExpirySeconds parses X-Amz-Expires as bare ASCII digits.
//
// A signer writes a plain decimal integer, but the lenient parsers this replaces also tolerated a
// leading sign (strconv), surrounding whitespace and underscores (Python's int()), and non-ASCII
// decimal digits (Python's int()). Accepting only [0-9]+ keeps all three runtimes' post-condition
// on exactly the same input domain.
func presignPutExpirySeconds(raw string) (int64, bool) {
	if raw == "" {
		return 0, false
	}
	for index := 0; index < len(raw); index++ {
		if raw[index] < '0' || raw[index] > '9' {
			return 0, false
		}
	}
	seconds, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, false
	}
	return seconds, true
}

func presignQueryValue(query url.Values, name string) (string, bool) {
	for key, values := range query {
		if !strings.EqualFold(key, name) || len(values) == 0 {
			continue
		}
		return values[0], true
	}
	return "", false
}
