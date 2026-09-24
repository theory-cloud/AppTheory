package objectstore

import (
	"context"
	"strconv"
	"strings"
	"time"

	store "github.com/theory-cloud/apptheory/v4/pkg/objectstore"
)

// fakePresignPutInstant is the clock instant used when no clock is injected. It keeps fake upload
// grants byte-identical across runs and across the Go, TypeScript, and Python fakes.
var fakePresignPutInstant = time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)

const (
	fakePresignPutBaseURL        = "https://objectstore.fake"
	fakePresignPutAlgorithm      = "AWS4-HMAC-SHA256"
	fakePresignPutCredential     = "apptheory-fake"
	fakePresignPutSignature      = "fake"
	fakePresignPutSignedHeaders  = "content-length;content-type;host;x-amz-checksum-sha256"
	fakePresignPutMethod         = "PUT"
	fakePresignPutHeaderLength   = "content-length"
	fakePresignPutHeaderType     = "content-type"
	fakePresignPutHeaderChecksum = "x-amz-checksum-sha256"
	fakeHexDigits                = "0123456789ABCDEF"
)

// PresignPut mints a deterministic fake upload grant.
//
// The URL encodes the signed constraints instead of hashing them, so tests can assert the exact
// grant without AWS. A real S3 store additionally signs the request host; the fake signs it too,
// which keeps the signed-header set identical between fake and real.
func (s *FakeStore) PresignPut(_ context.Context, input store.PresignPutInput) (*store.PresignPutOutput, error) {
	if err := input.Validate(); err != nil {
		return nil, err
	}

	expiresIn := int64(input.ExpiresIn / time.Second)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLocked()
	s.recordLocked(Call{
		Operation:      OperationPresignPut,
		Ref:            input.Ref,
		MaxBytes:       input.MaxBytes,
		ContentLength:  input.ContentLength,
		ChecksumSHA256: input.ChecksumSHA256,
		ExpiresIn:      expiresIn,
		ContentType:    input.ContentType,
	})
	if err := s.failureLocked(OperationPresignPut); err != nil {
		return nil, err
	}

	now := s.nowLocked()
	return &store.PresignPutOutput{
		Ref:    input.Ref,
		URL:    fakePresignPutURL(input, now, expiresIn),
		Method: fakePresignPutMethod,
		Headers: map[string]string{
			fakePresignPutHeaderLength:   strconv.FormatInt(input.ContentLength, 10),
			fakePresignPutHeaderType:     input.ContentType,
			fakePresignPutHeaderChecksum: input.ChecksumSHA256,
		},
		ExpiresAt: now.Add(time.Duration(expiresIn) * time.Second),
	}, nil
}

func (s *FakeStore) nowLocked() time.Time {
	if s.clock != nil {
		return s.clock().UTC()
	}
	return fakePresignPutInstant
}

func fakePresignPutURL(input store.PresignPutInput, now time.Time, expiresIn int64) string {
	parameters := []string{
		fakeQueryParameter("X-Amz-Algorithm", fakePresignPutAlgorithm),
		fakeQueryParameter("X-Amz-Credential", fakePresignPutCredential),
		fakeQueryParameter("X-Amz-Date", now.Format("20060102T150405Z")),
		fakeQueryParameter("X-Amz-Expires", strconv.FormatInt(expiresIn, 10)),
		fakeQueryParameter("X-Amz-Signature", fakePresignPutSignature),
		fakeQueryParameter("X-Amz-SignedHeaders", fakePresignPutSignedHeaders),
		fakeQueryParameter("x-amz-checksum-sha256", input.ChecksumSHA256),
		fakeQueryParameter("x-amz-content-length", strconv.FormatInt(input.ContentLength, 10)),
		fakeQueryParameter("x-amz-content-type", input.ContentType),
	}

	var builder strings.Builder
	builder.WriteString(fakePresignPutBaseURL)
	builder.WriteByte('/')
	builder.WriteString(fakePercentEncode(input.Ref.Bucket, true))
	builder.WriteByte('/')
	builder.WriteString(fakePercentEncode(input.Ref.Key, true))
	builder.WriteByte('?')
	builder.WriteString(strings.Join(parameters, "&"))
	return builder.String()
}

func fakeQueryParameter(name, value string) string {
	return name + "=" + fakePercentEncode(value, false)
}

// fakePercentEncode escapes every byte outside the RFC 3986 unreserved set, using uppercase hex.
// Path segments additionally keep "/" literal. All three runtimes share this rule byte-for-byte.
func fakePercentEncode(value string, keepSlash bool) string {
	var builder strings.Builder
	builder.Grow(len(value))
	for index := 0; index < len(value); index++ {
		current := value[index]
		if fakePercentEncodeLiteral(current, keepSlash) {
			builder.WriteByte(current)
			continue
		}
		builder.WriteByte('%')
		builder.WriteByte(fakeHexDigits[current>>4])
		builder.WriteByte(fakeHexDigits[current&0x0f])
	}
	return builder.String()
}

func fakePercentEncodeLiteral(value byte, keepSlash bool) bool {
	switch {
	case value >= 'A' && value <= 'Z', value >= 'a' && value <= 'z', value >= '0' && value <= '9':
		return true
	case value == '-' || value == '_' || value == '.' || value == '~':
		return true
	case keepSlash && value == '/':
		return true
	default:
		return false
	}
}
