package localrunner

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Signature Version 4 verification.
//
// The runner verifies the signature a caller sent with the credentials it issued
// (or with a session it minted), resolves the principal from those credentials
// and refuses anything it cannot verify by name. The canonical request has the
// documented six parts, and the derived key uses the request's own credential
// scope, so a caller that signs with any SDK is verified with that SDK's own
// canonicalization.
//
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-signing-elements.html
// https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_use-resources.html
// https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-control-access-using-iam-policies-to-invoke-api.html

const (
	// sigV4AuthorizationPrefix starts a header-signed request's Authorization.
	sigV4AuthorizationPrefix = "AWS4-HMAC-SHA256 "
	// sigV4Algorithm is the algorithm name every scope carries.
	sigV4Algorithm = "AWS4-HMAC-SHA256"
	// sigV4Terminator ends a credential scope.
	sigV4Terminator = "aws4_request"
	// sigV4DateHeader, sigV4TokenHeader and sigV4ContentHashHeader are the
	// headers the verification depends on.
	sigV4DateHeader  = "X-Amz-Date"
	sigV4TokenHeader = "X-Amz-Security-Token" //nolint:gosec // a header name, not a credential
	// sigV4ContentHashHeader carries the payload digest.
	sigV4ContentHashHeader = "X-Amz-Content-Sha256"
	// sigV4UnsignedPayload is the payload hash a presigned URL or a streaming
	// request carries.
	// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
	sigV4UnsignedPayload = "UNSIGNED-PAYLOAD"
	// sigV4EmptySHA256 is the SHA-256 of an empty body. It is a published
	// digest, not a credential.
	sigV4EmptySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" //nolint:gosec // a published digest
	// sigV4PresignAlgorithm is the query parameter a presigned URL carries.
	sigV4PresignAlgorithm     = "X-Amz-Algorithm"
	sigV4PresignCredential    = "X-Amz-Credential" //nolint:gosec // a query-parameter name
	sigV4PresignDate          = "X-Amz-Date"
	sigV4PresignExpires       = "X-Amz-Expires"
	sigV4PresignSignedHeaders = "X-Amz-SignedHeaders"
	sigV4PresignSignature     = "X-Amz-Signature"      //nolint:gosec // a query-parameter name
	sigV4PresignToken         = "X-Amz-Security-Token" //nolint:gosec // a query-parameter name
	// sigV4MaxPresignExpiry bounds a presigned URL's lifetime. AWS caps a
	// presigned URL at 7 days.
	// https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html
	sigV4MaxPresignExpiry = 7 * 24 * time.Hour
)

// sigV4Error is a named signature refusal.
type sigV4Error struct{ reason string }

func (e *sigV4Error) Error() string { return e.reason }

// sigV4Refusal builds a named refusal.
func sigV4Refusal(format string, args ...any) error {
	return &sigV4Error{reason: fmt.Sprintf(format, args...)}
}

// sigV4Request is the part of a request the canonicalization reads, extracted
// once so a header-signed and a presigned request share one code path.
type sigV4Request struct {
	Method         string
	CanonicalURI   string
	CanonicalQuery string
	Header         http.Header
	Host           string
	// ContentLength is the body length Go keeps out of http.Header; a signer
	// that signed a content-length header signed the number.
	ContentLength int64
	SignedHeaders []string
	PayloadHash   string
	AmzDate       string
	Credential    string
	Signature     string
	SessionToken  string
	Presigned     bool
	Expires       time.Duration
}

// verifySigV4 verifies one request's signature against the run's issued
// credentials and returns the caller's principal.
//
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
func (r *Runner) verifySigV4(request *http.Request, body []byte, now time.Time, service string) (iamPrincipal, error) {
	checker := &signatureChecker{now: now, service: service, records: r.iamCredential}
	return checker.verify(request, body)
}

// signatureChecker verifies one request against a credential lookup. The runner
// and the S3 front share it, so both verify the same canonical request.
type signatureChecker struct {
	now     time.Time
	service string
	// records resolves an access key to the credential the runner issued. The
	// runner and the S3 front share it, so both answer "who signed this?" the
	// same way.
	records func(accessKeyID string) (iamCredentialRecord, bool)
}

//nolint:gocognit,gocyclo // one branch per documented signing element.
func (c *signatureChecker) verify(request *http.Request, body []byte) (iamPrincipal, error) {
	now, service := c.now, c.service
	extracted, err := extractSigV4(request, body)
	if err != nil {
		return iamPrincipal{}, err
	}
	scope := strings.Split(extracted.Credential, "/")
	if len(scope) != 5 {
		return iamPrincipal{}, sigV4Refusal("the credential scope is not <access key>/<date>/<region>/<service>/aws4_request")
	}
	accessKeyID, scopeDate, scopeRegion, scopeService := scope[0], scope[1], scope[2], scope[3]
	if scope[4] != sigV4Terminator {
		return iamPrincipal{}, sigV4Refusal("the credential scope does not end with aws4_request")
	}
	if scopeService != service {
		return iamPrincipal{}, sigV4Refusal("the request is signed for the %q service; this endpoint requires %q",
			scopeService, service)
	}
	if scopeRegion != LocalRegion {
		// The runner's APIs are served in one region; a signature for another
		// region is not a signature this run can verify.
		return iamPrincipal{}, sigV4Refusal("the request is signed for region %q; the local execute-api surface serves %q",
			scopeRegion, LocalRegion)
	}
	signedAt, err := time.Parse("20060102T150405Z", extracted.AmzDate)
	if err != nil {
		return iamPrincipal{}, sigV4Refusal("the request has no valid %s header", sigV4DateHeader)
	}
	if signedAt.Format("20060102") != scopeDate {
		return iamPrincipal{}, sigV4Refusal("the %s date and the credential scope date disagree", sigV4DateHeader)
	}
	if signedAt.After(now.Add(iamSignatureWindow)) || signedAt.Before(now.Add(-iamSignatureWindow)) {
		return iamPrincipal{}, sigV4Refusal(
			"the request is signed %s from the local clock, outside AWS's 15-minute window",
			now.Sub(signedAt).Round(time.Second))
	}
	if extracted.Presigned {
		if extracted.Expires <= 0 || extracted.Expires > sigV4MaxPresignExpiry {
			return iamPrincipal{}, sigV4Refusal("a presigned URL must expire within 7 days")
		}
		if now.After(signedAt.Add(extracted.Expires)) {
			return iamPrincipal{}, sigV4Refusal("the presigned URL expired at %s", signedAt.Add(extracted.Expires).UTC().Format(time.RFC3339))
		}
	}
	record, ok := c.records(accessKeyID)
	if !ok {
		return iamPrincipal{}, sigV4Refusal(
			"the access key %s is not a credential this run (or a co-resident run) issued, or it has expired",
			accessKeyID)
	}
	if record.SessionToken != "" {
		if extracted.SessionToken == "" {
			return iamPrincipal{}, sigV4Refusal(
				"the credential is a session; the request must carry %s and sign it", sigV4TokenHeader)
		}
		if extracted.SessionToken != record.SessionToken {
			return iamPrincipal{}, sigV4Refusal("the session token does not match the credential's session")
		}
		if !containsStringList(extracted.SignedHeaders, strings.ToLower(sigV4TokenHeader)) {
			return iamPrincipal{}, sigV4Refusal("the session token header is not in the signed headers")
		}
	}
	if !containsStringList(extracted.SignedHeaders, "host") {
		return iamPrincipal{}, sigV4Refusal("the signed headers do not include host")
	}
	canonicalRequest := strings.Join([]string{
		extracted.Method,
		extracted.CanonicalURI,
		extracted.CanonicalQuery,
		sigV4CanonicalHeaders(extracted),
		strings.Join(extracted.SignedHeaders, ";"),
		extracted.PayloadHash,
	}, "\n")
	scopeLine := strings.Join([]string{scopeDate, scopeRegion, scopeService, sigV4Terminator}, "/")
	stringToSign := strings.Join([]string{
		sigV4Algorithm,
		extracted.AmzDate,
		scopeLine,
		hex.EncodeToString(sigV4Hash(canonicalRequest)),
	}, "\n")
	expected := sigV4Signature(record.Secret, scopeDate, scopeRegion, scopeService, stringToSign)
	provided, err := hex.DecodeString(extracted.Signature)
	if err != nil {
		return iamPrincipal{}, sigV4Refusal("the signature is not hexadecimal")
	}
	if !hmac.Equal(expected, provided) {
		return iamPrincipal{}, sigV4Refusal(
			"the request signature does not match the credential (AWS4-HMAC-SHA256 over the canonical request)")
	}
	return iamPrincipal{
		ARN:         record.PrincipalARN,
		Account:     record.Account,
		BaseARN:     record.BaseARN,
		Session:     strings.Contains(record.PrincipalARN, ":assumed-role/"),
		AccessKeyID: record.AccessKeyID,
		UserID:      "AROALOCAL:" + accessKeyID,
	}, nil
}

// extractSigV4 reads the request's signing elements without verifying them.
func extractSigV4(request *http.Request, body []byte) (sigV4Request, error) {
	extracted := sigV4Request{
		Method:        strings.ToUpper(request.Method),
		CanonicalURI:  sigV4CanonicalURI(request.URL),
		Header:        request.Header,
		Host:          request.Host,
		ContentLength: request.ContentLength,
	}
	authorization := request.Header.Get("Authorization")
	switch {
	case strings.HasPrefix(authorization, sigV4AuthorizationPrefix):
		fields, err := sigV4AuthorizationFields(authorization)
		if err != nil {
			return extracted, err
		}
		signed := strings.Split(fields["SignedHeaders"], ";")
		if len(signed) == 0 || fields["SignedHeaders"] == "" {
			return extracted, sigV4Refusal("the Authorization header carries no SignedHeaders list")
		}
		extracted.SignedHeaders = signed
		extracted.Credential = fields["Credential"]
		extracted.Signature = fields["Signature"]
		extracted.AmzDate = request.Header.Get(sigV4DateHeader)
		extracted.SessionToken = request.Header.Get(sigV4TokenHeader)
		extracted.PayloadHash = sigV4PayloadHash(request.Header.Get(sigV4ContentHashHeader), body)
		extracted.CanonicalQuery = sigV4CanonicalQuery(request.URL.Query())
		return extracted, nil
	case authorization != "":
		return extracted, sigV4Refusal("the Authorization header does not use AWS4-HMAC-SHA256")
	}
	query := request.URL.Query()
	if query.Get(sigV4PresignAlgorithm) == "" {
		return extracted, sigV4Refusal(
			"the request is not signed (no AWS4-HMAC-SHA256 Authorization header and no X-Amz-Signature query parameter)")
	}
	if query.Get(sigV4PresignAlgorithm) != sigV4Algorithm {
		return extracted, sigV4Refusal("the presigned URL uses %q instead of %q", query.Get(sigV4PresignAlgorithm), sigV4Algorithm)
	}
	extracted.Presigned = true
	extracted.Credential = query.Get(sigV4PresignCredential)
	extracted.Signature = query.Get(sigV4PresignSignature)
	extracted.AmzDate = query.Get(sigV4PresignDate)
	extracted.SessionToken = query.Get(sigV4PresignToken)
	extracted.SignedHeaders = strings.Split(query.Get(sigV4PresignSignedHeaders), ";")
	extracted.PayloadHash = sigV4UnsignedPayload
	if query.Get(sigV4PresignSignedHeaders) == "" {
		return extracted, sigV4Refusal("the presigned URL carries no X-Amz-SignedHeaders")
	}
	if raw := query.Get(sigV4PresignExpires); raw != "" {
		var seconds int
		if _, err := fmt.Sscanf(raw, "%d", &seconds); err != nil || seconds <= 0 {
			return extracted, sigV4Refusal("the presigned URL's X-Amz-Expires is not a positive integer")
		}
		extracted.Expires = time.Duration(seconds) * time.Second
	}
	withoutSignature := url.Values{}
	for key, list := range query {
		if key == sigV4PresignSignature {
			continue
		}
		withoutSignature[key] = list
	}
	extracted.CanonicalQuery = sigV4CanonicalQuery(withoutSignature)
	return extracted, nil
}

// sigV4AuthorizationFields parses the fields of an Authorization header.
func sigV4AuthorizationFields(authorization string) (map[string]string, error) {
	trimmed := strings.TrimPrefix(authorization, sigV4AuthorizationPrefix)
	fields := map[string]string{}
	for _, part := range strings.Split(trimmed, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			return nil, sigV4Refusal("the Authorization header has a field %q with no value", part)
		}
		fields[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	for _, required := range []string{"Credential", "SignedHeaders", "Signature"} {
		if fields[required] == "" {
			return nil, sigV4Refusal("the Authorization header is missing %s", required)
		}
	}
	return fields, nil
}

// sigV4CanonicalURI is the request path as the signer encoded it: each segment
// URI-encoded once, with no normalization.
//
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
func sigV4CanonicalURI(parsed *url.URL) string {
	path := parsed.EscapedPath()
	if path == "" {
		return "/"
	}
	return path
}

// sigV4CanonicalQuery sorts the query parameters by name and value and encodes
// them the way AWS does.
//
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
func sigV4CanonicalQuery(values url.Values) string {
	type pair struct{ key, value string }
	pairs := make([]pair, 0, len(values))
	for key, list := range values {
		for _, value := range list {
			pairs = append(pairs, pair{key: sigV4Escape(key), value: sigV4Escape(value)})
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].key != pairs[j].key {
			return pairs[i].key < pairs[j].key
		}
		return pairs[i].value < pairs[j].value
	})
	parts := make([]string, 0, len(pairs))
	for _, entry := range pairs {
		parts = append(parts, entry.key+"="+entry.value)
	}
	return strings.Join(parts, "&")
}

// sigV4Escape encodes one canonical query component: every byte outside the
// unreserved set is percent-encoded, and a space is %20 rather than +.
//
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
func sigV4Escape(value string) string {
	const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~"
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		char := value[index]
		if strings.IndexByte(unreserved, char) >= 0 {
			builder.WriteByte(char)
			continue
		}
		fmt.Fprintf(&builder, "%%%02X", char)
	}
	return builder.String()
}

// sigV4CanonicalHeaders renders the signed headers block.
//
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
func sigV4CanonicalHeaders(request sigV4Request) string {
	var builder strings.Builder
	for _, name := range request.SignedHeaders {
		name = strings.ToLower(strings.TrimSpace(name))
		builder.WriteString(name)
		builder.WriteByte(':')
		switch name {
		case "host":
			builder.WriteString(strings.TrimSpace(request.Host))
		case "content-length":
			// Go keeps Content-Length out of http.Header; a signer that signed
			// it signed the number.
			builder.WriteString(strconv.FormatInt(request.ContentLength, 10))
		default:
			values := request.Header.Values(name)
			trimmed := make([]string, 0, len(values))
			for _, value := range values {
				trimmed = append(trimmed, strings.Join(strings.Fields(value), " "))
			}
			builder.WriteString(strings.Join(trimmed, ","))
		}
		builder.WriteByte('\n')
	}
	return builder.String()
}

// sigV4PayloadHash is the payload hash the canonical request carries.
func sigV4PayloadHash(header string, body []byte) string {
	if header != "" {
		return header
	}
	if len(body) == 0 {
		return sigV4EmptySHA256
	}
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// sigV4Signature derives the signing key from the secret and the request's own
// scope, then signs the string to sign.
//
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-signing-elements.html
func sigV4Signature(secret, date, region, service, stringToSign string) []byte {
	key := []byte("AWS4" + secret)
	for _, part := range []string{date, region, service, sigV4Terminator} {
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte(part))
		key = mac.Sum(nil)
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(stringToSign))
	return mac.Sum(nil)
}

// sigV4Hash is the SHA-256 of the canonical request.
func sigV4Hash(value string) []byte {
	sum := sha256.Sum256([]byte(value))
	return sum[:]
}

// verifySigV4SignedRequest verifies a signed form request whose body the
// verifier must read itself (the STS query protocol).
func (r *Runner) verifySigV4SignedRequest(request *http.Request, service string) (iamPrincipal, error) {
	body := []byte{}
	if request.Body != nil && request.Method == http.MethodPost {
		raw, err := io.ReadAll(io.LimitReader(request.Body, 1<<20))
		if err != nil {
			return iamPrincipal{}, sigV4Refusal("read the signed request body: %v", err)
		}
		body = raw
		request.Body = io.NopCloser(bytes.NewReader(raw))
	}
	return r.verifySigV4(request, body, time.Now(), service)
}
