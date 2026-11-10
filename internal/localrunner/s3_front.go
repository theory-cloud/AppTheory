package localrunner

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5" //nolint:gosec // S3's Content-MD5 is an integrity digest
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
)

// The runner-owned S3 front.
//
// s3proxy's filesystem backend refuses every server-side-encryption header by
// design: reporting AES256 over plaintext on a real disk "would be a claim
// S3Proxy has no business making", even on current releases whose transient
// backend answers SSE-S3 itself. AWS accepts SSE-S3 on PutObject and reports
// the applied algorithm on the put and on later HEAD/GET calls:
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingServerSideEncryption.html
//
// The front therefore applies SSE-S3 itself when, and only when, the put is a
// header-based SigV4 request whose SignedHeaders names
// x-amz-server-side-encryption and whose signature the front verified against
// the local identity: it strips the header before s3proxy (which cannot store
// it), records the object's algorithm, adds the documented response header,
// and echoes it on HeadObject and GetObject. Every other SSE put is forwarded
// unchanged, so the store answers it exactly as it did at v7.0.0 (s3proxy
// refused every SSE header with 501 on its filesystem backend): only a signed
// header the front removes has to be re-signed, and only a signature the local
// credentials vouch for may be re-signed. SSE-KMS and SSE-C are passed through
// unchanged: the runner cannot honor a KMS key binding or a customer key, so
// those requests keep s3proxy's 501 rather than pretending to encrypt.
//
// The record is kept in <data-dir>/s3sse/index.json with --data-dir, and in
// memory otherwise. The S3 endpoint injected into functions is the front's
// host-gateway IP literal so the SDK keeps path-style addressing (it treats an
// IP endpoint as path-style); the front is reached on a host listener the way
// the runtime API and the other control services are.
//
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/default-bucket-encryption.html

const (
	s3SSEAlgorithmHeader = "x-amz-server-side-encryption"
	s3SSEKMSKeyHeader    = "x-amz-server-side-encryption-aws-kms-key-id"
	s3SSEKMSContext      = "x-amz-server-side-encryption-context"
	s3SSEBucketKeyHeader = "x-amz-server-side-encryption-bucket-key-enabled"
	s3SSECAlgorithm      = "x-amz-server-side-encryption-customer-algorithm"
	s3SSECKey            = "x-amz-server-side-encryption-customer-key"
	s3SSECKeyMD5         = "x-amz-server-side-encryption-customer-key-md5"
	// s3FrontMaxBody is the largest request body the front buffers: a
	// DeleteObjects body it parses for SSE-S3 records, or a PutObject body it
	// must hash to re-sign. A DeleteObjects body above it is streamed through
	// unchanged, as the v7.0.0 path did.
	s3FrontMaxBody   = 1 << 20
	s3FrontIndexFile = "index.json"
	s3FrontMaxFlush  = 100 * time.Millisecond
	// s3FrontDeleteObjectsMaxBody bounds the DeleteObjects body the front
	// buffers to restore the Content-MD5 header the store requires. AWS caps the
	// request at 1000 keys of 1024 bytes (about 1.05 MiB of XML), so 8 MiB leaves
	// ample room while keeping the buffer bounded.
	// https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html
	s3FrontDeleteObjectsMaxBody = 8 << 20
	// s3FrontErrorBodyLimit bounds the response prefix the front reads to find
	// the <Error> document AWS embeds in a 2xx CompleteMultipartUpload or
	// CopyObject response. Both result documents are small XML.
	s3FrontErrorBodyLimit = 64 << 10
	// s3SignatureWindow is AWS's tolerance between a header-signed request's
	// X-Amz-Date and the service clock.
	s3SignatureWindow = 15 * time.Minute
)

// s3SSEIndex records which objects the front stored with SSE-S3.
type s3SSEIndex struct {
	mu      sync.Mutex
	path    string
	entries map[string]struct{}
}

func newS3SSEIndex(dataDir string) (*s3SSEIndex, error) {
	index := &s3SSEIndex{entries: map[string]struct{}{}}
	if strings.TrimSpace(dataDir) == "" {
		return index, nil
	}
	dir := filepath.Join(dataDir, "s3sse")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create the S3 SSE data directory %s: %w", dir, err)
	}
	index.path = filepath.Join(dir, s3FrontIndexFile)
	payload, err := os.ReadFile(index.path)
	if err != nil {
		if os.IsNotExist(err) {
			return index, nil
		}
		return nil, fmt.Errorf("read the persistent S3 SSE index %s: %w", index.path, err)
	}
	var file struct {
		Version int      `json:"version"`
		Objects []string `json:"objects"`
	}
	if err := json.Unmarshal(payload, &file); err != nil {
		return nil, fmt.Errorf("parse the persistent S3 SSE index %s: %w", index.path, err)
	}
	if file.Version != 1 {
		return nil, fmt.Errorf("the persistent S3 SSE index %s uses unsupported version %d", index.path, file.Version)
	}
	for _, object := range file.Objects {
		index.entries[object] = struct{}{}
	}
	return index, nil
}

func s3IndexKey(bucket, key string) string { return bucket + "/" + key }

func (i *s3SSEIndex) has(bucket, key string) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	_, ok := i.entries[s3IndexKey(bucket, key)]
	return ok
}

func (i *s3SSEIndex) set(bucket, key string) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	indexKey := s3IndexKey(bucket, key)
	if _, exists := i.entries[indexKey]; exists {
		return nil
	}
	i.entries[indexKey] = struct{}{}
	return i.saveLocked()
}

func (i *s3SSEIndex) remove(bucket, key string) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	indexKey := s3IndexKey(bucket, key)
	if _, exists := i.entries[indexKey]; !exists {
		return nil
	}
	delete(i.entries, indexKey)
	return i.saveLocked()
}

func (i *s3SSEIndex) removeBucket(bucket string) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	prefix := bucket + "/"
	changed := false
	for key := range i.entries {
		if strings.HasPrefix(key, prefix) {
			delete(i.entries, key)
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return i.saveLocked()
}

// saveLocked writes the index atomically. The caller holds mu.
func (i *s3SSEIndex) saveLocked() error {
	if i.path == "" {
		return nil
	}
	objects := make([]string, 0, len(i.entries))
	for object := range i.entries {
		objects = append(objects, object)
	}
	sort.Strings(objects)
	payload, err := json.MarshalIndent(struct {
		Version int      `json:"version"`
		Objects []string `json:"objects"`
	}{Version: 1, Objects: objects}, "", "  ")
	if err != nil {
		return fmt.Errorf("encode the S3 SSE index: %w", err)
	}
	payload = append(payload, '\n')
	temp, err := os.CreateTemp(filepath.Dir(i.path), s3FrontIndexFile+".tmp-*")
	if err != nil {
		return fmt.Errorf("create the S3 SSE index: %w", err)
	}
	tempName := temp.Name()
	defer func() { _ = os.Remove(tempName) }() //nolint:errcheck // the rename removes it on success
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close() //nolint:errcheck // the create failure is reported below
		return fmt.Errorf("make the S3 SSE index private: %w", err)
	}
	if _, err := temp.Write(payload); err != nil {
		_ = temp.Close() //nolint:errcheck // the write failure is reported below
		return fmt.Errorf("write the S3 SSE index: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close the S3 SSE index: %w", err)
	}
	if err := os.Rename(tempName, i.path); err != nil {
		return fmt.Errorf("replace the S3 SSE index: %w", err)
	}
	return nil
}

// s3Front proxies object requests to s3proxy and carries the SSE-S3 answer.
type s3Front struct {
	upstream *url.URL
	index    *s3SSEIndex
	logf     func(string, ...any)
	proxy    *httputil.ReverseProxy
	signer   *v4.Signer
	// versions is the bucket version log: every successful write to a
	// version-enabled bucket is archived here, and reads by version id, the
	// version listing and delete markers are served from it.
	versions *s3VersionStore
	// client sends the front's own requests to the store: the archived-object
	// read, a restore, and a version deletion's live-object reconciliation. One
	// client per front keeps the timeout and the connection pool in one place.
	client *http.Client
	// credentials is the store's own static identity, which s3proxy verifies.
	credentials aws.Credentials
	// issuedRecord resolves a request signed with a credential the run issued.
	// s3proxy verifies only its own static pair, so the front adopts such a
	// request: it verifies the caller's signature against the issued secret and
	// re-signs the request with the store's identity. A request signed with
	// anything else is forwarded unchanged, exactly as before.
	issuedRecord func(accessKeyID string) (iamCredentialRecord, bool)
	hostURL      string
	// containerURL is the host.docker.internal address the preflight probe
	// checks; port is what the function-facing IP endpoint uses.
	containerURL string
	port         int
}

func newS3Front(dataDir, upstream string, logf func(string, ...any)) (*s3Front, error) {
	parsed, err := url.Parse(strings.TrimSpace(upstream))
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("the S3 front has no upstream endpoint: %q", upstream)
	}
	index, err := newS3SSEIndex(dataDir)
	if err != nil {
		return nil, err
	}
	versions, err := newS3VersionStore(dataDir)
	if err != nil {
		return nil, err
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	front := &s3Front{
		upstream:    parsed,
		index:       index,
		versions:    versions,
		client:      newS3UpstreamClient(),
		logf:        logf,
		signer:      newS3Signer(),
		credentials: aws.Credentials{AccessKeyID: "dummy", SecretAccessKey: "dummy"},
	}
	front.issuedRecord = func(string) (iamCredentialRecord, bool) { return iamCredentialRecord{}, false }
	front.proxy = &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.Out.URL.Scheme = parsed.Scheme
			request.Out.URL.Host = parsed.Host
			// Keep the inbound Host: SigV4 signed it, and s3proxy verifies
			// the signature against the header it receives.
			request.Out.Host = request.In.Host
		},
		Transport: &http.Transport{
			Proxy:               nil,
			DisableCompression:  true,
			MaxIdleConnsPerHost: 16,
			IdleConnTimeout:     60 * time.Second,
		},
		FlushInterval: s3FrontMaxFlush,
		ErrorHandler: func(writer http.ResponseWriter, _ *http.Request, proxyErr error) {
			logf("local S3 front: %v", proxyErr)
			http.Error(writer, "the local S3 backend is unavailable", http.StatusBadGateway)
		},
	}
	return front, nil
}

// s3ObjectOperation is the per-request decision the response modifier reads.
type s3ObjectOperation struct {
	bucket string
	key    string
	// ssePut is a PutObject that named SSE-S3 and no companion algorithm. The
	// front applies it only when a verified header-based SigV4 signature signed
	// the SSE header; otherwise the request passes through unchanged.
	ssePut bool
	// put is set when the front applies SSE-S3 itself (it stripped the signed
	// header and re-signed the request), so a successful response records it.
	put bool
	// overwrite is any write that names no algorithm and replaces the object (a
	// plain PutObject, a plain CopyObject or a successful
	// CompleteMultipartUpload): a success clears a previous SSE-S3 record.
	overwrite bool
	// read is a HeadObject or GetObject, including a part read. A subresource
	// read (tagging, ACL, attributes, legal hold, retention, a multipart part
	// list) is not a read of the object and is not classified.
	read bool
	// remove is a DeleteObject; an abort of a multipart upload is not.
	remove bool
	// removeKeys are the keys a DeleteObjects request named.
	removeKeys []string
	// removeIdentifiers are the key/version pairs a DeleteObjects request
	// named; a versioned bucket deletes those versions instead of creating a
	// marker for each key.
	removeIdentifiers []s3RemoveIdentifier
	// deleteObjects is a POST ?delete whose body names the keys.
	deleteObjects bool
	// removeBucket clears a deleted bucket's records.
	removeBucket bool
}

// ServeHTTP inspects one object operation, adjusts the upstream request and
// records the SSE-S3 result on success.
func (f *s3Front) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	operation := s3Operation(request)
	proxyRequest := request
	if f.issuedRecord != nil {
		adopted, err := f.adoptIssuedSignature(request)
		if err != nil {
			f.logf("local S3 front: %v", err)
			writeS3FrontError(writer, http.StatusForbidden, "SignatureDoesNotMatch", err.Error())
			return
		}
		if adopted {
			proxyRequest = request
		}
	}
	// Versioned operations that only the version log can answer (a read by
	// version id, the version listing, a versioning configuration, a delete of
	// one version) never reach s3proxy, which has no versioning.
	if f.versionedRequest(writer, request) {
		return
	}
	if operation.ssePut {
		// s3proxy refuses the header on its filesystem store; the front is
		// where the object's AES256 record lives. That is only sound when the
		// caller's own header-based SigV4 signature signed the header and the
		// front verified it: stripping a signed header invalidates the
		// signature, which the front then replaces as the same dummy local
		// identity. Every other SSE put (unsigned, presigned, or a header the
		// caller did not sign) is forwarded unchanged, so the store answers it
		// as it did at v7.0.0.
		apply, err := f.applySSEPut(request)
		if err != nil {
			f.logf("local S3 front: %v", err)
			writeS3FrontError(writer, http.StatusForbidden, "SignatureDoesNotMatch", err.Error())
			return
		}
		if apply {
			if err := s3StreamingPayloadError(request); err != nil {
				f.logf("local S3 front: %v", err)
				http.Error(writer, err.Error(), http.StatusBadRequest)
				return
			}
			clone := request.Clone(request.Context())
			clone.Header.Del(s3SSEAlgorithmHeader)
			if err := f.resign(clone); err != nil {
				f.logf("local S3 front: %v", err)
				http.Error(writer, err.Error(), http.StatusBadRequest)
				return
			}
			proxyRequest = clone
			operation.put = true
		}
	}
	if operation.deleteObjects {
		proxy, identifiers, parsed, err := bufferDeleteObjects(request)
		if err != nil {
			f.logf("local S3 front: %v", err)
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		if !parsed {
			f.logf("local S3 front: the DeleteObjects body is larger than %d bytes; it is forwarded unchanged and its SSE-S3 records are left in place", s3FrontMaxBody)
		}
		proxyRequest = proxy
		operation.removeIdentifiers = identifiers
		for _, identifier := range identifiers {
			operation.removeKeys = append(operation.removeKeys, identifier.Key)
		}
	}
	proxy := *f.proxy
	proxy.ModifyResponse = func(response *http.Response) error {
		if response.StatusCode >= 400 {
			f.logf("local S3 front: %s %s -> %d", request.Method, request.URL.Path, response.StatusCode)
		}
		return f.recordResponse(request.Context(), operation, response)
	}
	proxy.ServeHTTP(writer, proxyRequest)
}

// newS3Signer builds the SigV4 signer S3's canonical request requires. For S3
// the canonical URI is the URI-encoded path encoded exactly once, and the path
// is not normalized; every other service encodes the already-encoded path a
// second time. The SDK's own S3 client therefore sets
// DisableURIPathEscaping (service/s3/api_client.go, newDefaultV4Signer), and
// the front must sign the same path it forwards:
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
// https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
//
// Without the option, a key containing '=' is signed as %253D while the
// forwarded request line carries %3D, and s3proxy answers 403
// SignatureDoesNotMatch.
func newS3Signer() *v4.Signer {
	return v4.NewSigner(func(options *v4.SignerOptions) {
		options.DisableURIPathEscaping = true
	})
}

// newS3UpstreamClient is the client the front uses for its own requests to the
// store. The type assertion is intentionally checked: a test that replaced the
// default transport must not turn a panic into a failed version write.
func newS3UpstreamClient() *http.Client {
	transport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		transport = &http.Transport{}
	}
	return &http.Client{Timeout: 2 * time.Minute, Transport: transport.Clone()}
}

// resign replaces the caller's SigV4 signature after a signed header was
// removed. The local credentials are the profile's static dummy pair; s3proxy
// verifies the new signature against the headers it receives. The caller's own
// signature is checked by ServeHTTP before the signed SSE header is stripped;
// a streaming (aws-chunked) payload signs its chunks with the original seed
// signature and cannot be re-signed here, so it is refused with a clear error.
func (f *s3Front) resign(request *http.Request) error {
	if request.Header.Get("Authorization") == "" {
		return nil
	}
	return f.signRequest(request)
}

// signRequest signs one request with the store's identity, whether or not it
// already carried a signature. The front uses it both to replace a caller's
// signature after removing a signed header and to sign the request it sends to
// the store itself (the archived-object read, a restore and the version
// deletion's live-object reconciliation).
func (f *s3Front) signRequest(request *http.Request) error {
	payloadHash := strings.TrimSpace(request.Header.Get("X-Amz-Content-Sha256"))
	if err := s3StreamingPayloadError(request); err != nil {
		return err
	}
	if payloadHash == "" {
		if request.Body == nil {
			payloadHash = hex.EncodeToString(sha256.New().Sum(nil))
		} else {
			body, err := io.ReadAll(io.LimitReader(request.Body, s3FrontMaxBody))
			if err != nil {
				return fmt.Errorf("read the PutObject body to re-sign it: %w", err)
			}
			if len(body) >= s3FrontMaxBody {
				return fmt.Errorf("the local S3 front cannot re-sign a PutObject body larger than %d bytes without a payload hash", s3FrontMaxBody)
			}
			_ = request.Body.Close() //nolint:errcheck // the body is already read
			sum := sha256.Sum256(body)
			payloadHash = hex.EncodeToString(sum[:])
			request.Body = io.NopCloser(bytes.NewReader(body))
			request.ContentLength = int64(len(body))
		}
	}
	// s3proxy authenticates a v4 request by hashing the body it received and
	// comparing that digest with x-amz-content-sha256; a request without the
	// header is rejected with XAmzContentSHA256Mismatch, not treated as an
	// unsigned payload. A forwarded caller always sends it, but a request the
	// front builds itself (the archived-object read, a restore, a version
	// deletion's reconciliation) does not, so the digest just computed is
	// always written back.
	request.Header.Set("X-Amz-Content-Sha256", payloadHash)
	request.Header.Del("Authorization")
	stripUnimplementedStoreHeaders(request)
	// Sign exactly the headers the proxy will forward: ReverseProxy drops the
	// hop-by-hop family, and a header named by Connection goes with it.
	for _, name := range strings.Split(request.Header.Get("Connection"), ",") {
		if trimmed := strings.TrimSpace(name); trimmed != "" {
			request.Header.Del(trimmed)
		}
	}
	for _, name := range []string{
		"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
		"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
	} {
		request.Header.Del(name)
	}
	// The SDK for JavaScript v3 adds a trailing checksum to a DeleteObjects
	// request by default, and s3proxy answers such a header with
	// "A header you provided implies functionality that is not implemented".
	// The store cannot verify a checksum it does not implement, and the front
	// signs the request it forwards, so the header is dropped here.
	// https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html
	for _, name := range []string{
		"X-Amz-Sdk-Checksum-Algorithm", "X-Amz-Checksum-Crc32",
		"X-Amz-Checksum-Crc32c", "X-Amz-Checksum-Sha1",
		"X-Amz-Checksum-Sha256", "X-Amz-Checksum-Mode", "X-Amz-Trailer",
	} {
		request.Header.Del(name)
	}
	// s3proxy requires an integrity header on a DeleteObjects request, and the
	// SDK's flexible checksum was just removed, so the MD5 digest S3 accepts in
	// its place is restored from the body.
	// https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html
	if err := applyDeleteObjectsDigest(request); err != nil {
		return err
	}
	if err := f.signer.SignHTTP(request.Context(), f.credentials, request, payloadHash, "s3", LocalRegion, time.Now().UTC()); err != nil {
		return fmt.Errorf("re-sign the PutObject: %w", err)
	}
	return nil
}

// s3SignatureMismatch is an incoming signature the local identity does not
// vouch for. The front answers it with the S3 SignatureDoesNotMatch document,
// as s3proxy would.
type s3SignatureMismatch struct{ reason string }

func (e *s3SignatureMismatch) Error() string { return e.reason }

// s3AuthorizationFields splits an AWS4-HMAC-SHA256 Authorization header into
// its field map and signed-header list. Only the header form is understood: a
// presigned (query-string) request carries no Authorization header.
func s3AuthorizationFields(authorization string) (map[string]string, []string, error) {
	const algorithm = "AWS4-HMAC-SHA256 "
	if !strings.HasPrefix(authorization, algorithm) {
		return nil, nil, fmt.Errorf("the local S3 front only re-signs Signature Version 4 header authentication")
	}
	fields := map[string]string{}
	for _, field := range strings.Split(strings.TrimPrefix(authorization, algorithm), ",") {
		name, value, ok := strings.Cut(strings.TrimSpace(field), "=")
		if !ok {
			return nil, nil, fmt.Errorf("the Authorization header is malformed")
		}
		fields[strings.TrimSpace(name)] = strings.TrimSpace(value)
	}
	signedHeaders := strings.Split(fields["SignedHeaders"], ";")
	if len(signedHeaders) == 0 || signedHeaders[0] == "" {
		return nil, nil, fmt.Errorf("the request has no SignedHeaders list")
	}
	return fields, signedHeaders, nil
}

// s3SignedHeaderListed reports whether a signed-header list names one header.
func s3SignedHeaderListed(signedHeaders []string, name string) bool {
	for _, signed := range signedHeaders {
		if signed == name {
			return true
		}
	}
	return false
}

// s3StreamingPayloadError names the aws-chunked put the front cannot re-sign:
// each chunk is signed with the seed signature over the original headers,
// which include the SSE header the front must strip.
func s3StreamingPayloadError(request *http.Request) error {
	if strings.HasPrefix(strings.TrimSpace(request.Header.Get("X-Amz-Content-Sha256")), "STREAMING-") {
		return fmt.Errorf("the local S3 front cannot strip a signed SSE header from a streaming (aws-chunked) PutObject")
	}
	return nil
}

// applySSEPut reports whether the front should apply SSE-S3 itself: strip the
// SSE header, re-sign, and record the object. That is only sound when the
// request is header-based SigV4 whose SignedHeaders names the SSE header and
// whose signature the front verified against the local identity. Removing a
// signed header invalidates the caller's signature, and only a signature the
// local credentials vouch for can be replaced by the front's own. Every other
// SSE put is forwarded unchanged, so the store answers it exactly as it did at
// v7.0.0; s3proxy's filesystem backend refused every SSE header with 501.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
// https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
func (f *s3Front) applySSEPut(request *http.Request) (bool, error) {
	authorization := request.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "AWS4-HMAC-SHA256 ") {
		// Unsigned, presigned (query-string authentication), or another scheme:
		// there is no header signature to replace, so forward unchanged.
		return false, nil
	}
	_, signedHeaders, err := s3AuthorizationFields(authorization)
	if err != nil {
		return false, err
	}
	if !s3SignedHeaderListed(signedHeaders, s3SSEAlgorithmHeader) {
		// The caller sent the SSE header without signing it. AWS requires every
		// x-amz-* header to be signed, so the store refuses the request as it
		// did at v7.0.0; the front must not strip a header the signature does
		// not cover.
		return false, nil
	}
	if err := f.verifySigV4(request); err != nil {
		return false, err
	}
	return true, nil
}

// verifySigV4 checks the caller's header-based SigV4 signature against the
// local dummy identity before the front re-signs the request. The front strips
// the SSE header the caller signed, so it must sign again; verifying first
// keeps the store's answer for a request signed with other credentials. The
// SSE path is new (s3proxy refused every SSE header with 501 at v7.0.0), so no
// request that succeeded before can be refused by this check.
//
// The front also applies AWS's 15-minute window for header-signed requests: a
// client timestamp more than 15 minutes from the service clock is refused, to
// bound replay. Only the new SSE path reaches this check.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
// https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
func (f *s3Front) verifySigV4(request *http.Request) error {
	authorization := request.Header.Get("Authorization")
	if authorization == "" {
		// Unsigned and presigned requests are forwarded as they arrived; the
		// store answers them exactly as it did at v7.0.0.
		return nil
	}
	fields, signedHeaders, err := s3AuthorizationFields(authorization)
	if err != nil {
		return &s3SignatureMismatch{reason: err.Error()}
	}
	scope := strings.Split(fields["Credential"], "/")
	if len(scope) != 5 || scope[0] != f.credentials.AccessKeyID || scope[4] != sigV4Terminator {
		return &s3SignatureMismatch{reason: "the request is not signed for the local identity"}
	}
	date, region, service := scope[1], scope[2], scope[3]
	if service != "s3" {
		return &s3SignatureMismatch{reason: "the request is not signed for the s3 service"}
	}
	amzDate := request.Header.Get("X-Amz-Date")
	if amzDate == "" {
		return &s3SignatureMismatch{reason: "the request has no X-Amz-Date header"}
	}
	signedAt, err := time.Parse("20060102T150405Z", amzDate)
	if err != nil {
		return &s3SignatureMismatch{reason: "the request has no valid X-Amz-Date header"}
	}
	if amzDate[:8] != date {
		return &s3SignatureMismatch{reason: "the X-Amz-Date and the credential scope date disagree"}
	}
	if skew := time.Since(signedAt); skew > s3SignatureWindow || skew < -s3SignatureWindow {
		return &s3SignatureMismatch{reason: "the request X-Amz-Date is outside the 15-minute signing window"}
	}
	canonicalRequest := strings.Join([]string{
		request.Method,
		s3CanonicalURI(request.URL),
		s3CanonicalQuery(request.URL.Query()),
		s3CanonicalHeaders(request, signedHeaders),
		strings.Join(signedHeaders, ";"),
		request.Header.Get("X-Amz-Content-Sha256"),
	}, "\n")
	scopeLine := strings.Join([]string{date, region, service, sigV4Terminator}, "/")
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scopeLine,
		hex.EncodeToString(s3Hash(canonicalRequest)),
	}, "\n")
	signature, err := hex.DecodeString(fields["Signature"])
	if err != nil {
		return &s3SignatureMismatch{reason: "the Authorization signature is not hexadecimal"}
	}
	expected := s3Signature(f.credentials.SecretAccessKey, date, region, service, stringToSign)
	if !hmac.Equal(expected, signature) {
		return &s3SignatureMismatch{reason: "the request signature does not match the local credentials"}
	}
	return nil
}

func s3Hash(value string) []byte {
	sum := sha256.Sum256([]byte(value))
	return sum[:]
}

// s3Signature derives the SigV4 signing key from the request's own credential
// scope, so the check verifies the caller's secret without imposing a region
// the store itself does not impose.
func s3Signature(secret, date, region, service, stringToSign string) []byte {
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

// s3CanonicalURI is S3's canonical URI: the URI-encoded path encoded exactly
// once, with no normalization.
func s3CanonicalURI(parsed *url.URL) string {
	escaped := parsed.EscapedPath()
	if escaped == "" {
		return "/"
	}
	return escaped
}

// s3CanonicalQuery sorts the query's encoded names and values as SigV4
// requires. url.Values has already decoded them, so a space is %20 here, not
// '+'.
func s3CanonicalQuery(values url.Values) string {
	type pair struct{ name, value string }
	pairs := make([]pair, 0, len(values))
	for name, list := range values {
		for _, value := range list {
			pairs = append(pairs, pair{name: s3URIEncode(name), value: s3URIEncode(value)})
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].name != pairs[j].name {
			return pairs[i].name < pairs[j].name
		}
		return pairs[i].value < pairs[j].value
	})
	var builder strings.Builder
	for index, item := range pairs {
		if index > 0 {
			builder.WriteByte('&')
		}
		builder.WriteString(item.name)
		builder.WriteByte('=')
		builder.WriteString(item.value)
	}
	return builder.String()
}

// s3URIEncode is SigV4's UriEncode: unreserved bytes stay, every other byte is
// percent-encoded with uppercase hex.
func s3URIEncode(value string) string {
	var builder strings.Builder
	const hexDigits = "0123456789ABCDEF"
	for index := 0; index < len(value); index++ {
		char := value[index]
		switch {
		case char >= 'A' && char <= 'Z', char >= 'a' && char <= 'z',
			char >= '0' && char <= '9', char == '-', char == '.', char == '_', char == '~':
			builder.WriteByte(char)
		default:
			builder.WriteByte('%')
			builder.WriteByte(hexDigits[char>>4])
			builder.WriteByte(hexDigits[char&0x0f])
		}
	}
	return builder.String()
}

// s3CanonicalHeaders rebuilds the canonical headers from the signed-header
// list the caller sent. Go keeps the request's Content-Length outside Header,
// so that name reads the parsed length.
func s3CanonicalHeaders(request *http.Request, names []string) string {
	var builder strings.Builder
	for _, name := range names {
		builder.WriteString(name)
		builder.WriteByte(':')
		switch name {
		case "host":
			builder.WriteString(s3StripSpaces(request.Host))
		case "content-length":
			if value := request.Header.Get("Content-Length"); value != "" {
				builder.WriteString(s3StripSpaces(value))
			} else if request.ContentLength >= 0 {
				builder.WriteString(strconv.FormatInt(request.ContentLength, 10))
			}
		default:
			values := request.Header.Values(name)
			for index, value := range values {
				if index > 0 {
					builder.WriteByte(',')
				}
				builder.WriteString(s3StripSpaces(strings.TrimSpace(value)))
			}
		}
		builder.WriteByte('\n')
	}
	return builder.String()
}

// s3StripSpaces trims a header value's leading and trailing spaces and
// collapses each run of spaces to one, as SigV4 requires.
func s3StripSpaces(value string) string {
	return strings.Join(strings.FieldsFunc(value, func(char rune) bool { return char == ' ' }), " ")
}

// writeS3FrontError answers with the S3 error document shape, so S3 SDKs map
// the status to the documented error code.
func writeS3FrontError(writer http.ResponseWriter, status int, code, message string) {
	var escaped bytes.Buffer
	_ = xml.EscapeText(&escaped, []byte(message)) //nolint:errcheck // a bytes.Buffer cannot fail
	writer.Header().Set("Content-Type", "application/xml")
	writer.WriteHeader(status)
	_, _ = fmt.Fprintf(writer, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>%s</Message></Error>`, code, escaped.String()) //nolint:errcheck // the response is committed
}

// s3ResponseCarriesError reports whether a successful write response carries
// the <Error> document AWS documents for a CompleteMultipartUpload that fails
// after the 200 header was sent. The body is read only up to
// s3FrontErrorBodyLimit and put back for the client unchanged. A CopyObject
// can use the same shape, so every object-overwriting write is checked.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html
func s3ResponseCarriesError(response *http.Response) bool {
	if response.Body == nil {
		return false
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, s3FrontErrorBodyLimit))
	response.Body = io.NopCloser(io.MultiReader(bytes.NewReader(body), response.Body))
	if err != nil || len(body) == 0 {
		return false
	}
	var root struct {
		XMLName xml.Name
	}
	if err := xml.Unmarshal(body, &root); err != nil {
		return false
	}
	return root.XMLName.Local == "Error"
}

// recordResponse applies the operation to the index and the response headers,
// and, on a version-enabled bucket, archives a successful write or records the
// version-shaped result AWS would return.
//
//nolint:gocognit,gocyclo // one branch per operation shape
func (f *s3Front) recordResponse(ctx context.Context, operation s3ObjectOperation, response *http.Response) error {
	success := response.StatusCode >= 200 && response.StatusCode < 300
	if success && (operation.put || operation.overwrite) && s3ResponseCarriesError(response) {
		// The write did not happen; keep the record as it was.
		success = false
	}
	switch {
	case operation.put:
		if success {
			if err := f.index.set(operation.bucket, operation.key); err != nil {
				f.logf("local S3 front: record %s/%s: %v", operation.bucket, operation.key, err)
			}
			response.Header.Set(s3SSEAlgorithmHeader, "AES256")
		}
	case operation.overwrite:
		if success {
			if err := f.index.remove(operation.bucket, operation.key); err != nil {
				f.logf("local S3 front: clear %s/%s: %v", operation.bucket, operation.key, err)
			}
		}
	case operation.read:
		if success && f.index.has(operation.bucket, operation.key) {
			response.Header.Set(s3SSEAlgorithmHeader, "AES256")
		}
	case operation.remove:
		if success || response.StatusCode == http.StatusNotFound {
			if err := f.index.remove(operation.bucket, operation.key); err != nil {
				f.logf("local S3 front: clear %s/%s: %v", operation.bucket, operation.key, err)
			}
		}
	case len(operation.removeKeys) > 0:
		if success {
			for _, key := range operation.removeKeys {
				if err := f.index.remove(operation.bucket, key); err != nil {
					f.logf("local S3 front: clear %s/%s: %v", operation.bucket, key, err)
				}
			}
		}
	case operation.removeBucket:
		if success {
			if err := f.index.removeBucket(operation.bucket); err != nil {
				f.logf("local S3 front: clear bucket %s: %v", operation.bucket, err)
			}
		}
	}
	return f.recordVersionedResponse(ctx, operation, response, success)
}

// recordVersionedResponse keeps the version log in step with a proxied
// response. An unversioned bucket takes no action at all: that is the v7.0.0
// path without a byte copied and without an added header.
//
//nolint:gocyclo // one branch per operation shape.
func (f *s3Front) recordVersionedResponse(ctx context.Context, operation s3ObjectOperation, response *http.Response, success bool) error {
	if f.versions == nil || operation.bucket == "" || !f.versions.enabled(operation.bucket) {
		return nil
	}
	switch {
	case (operation.put || operation.overwrite) && success:
		if err := f.archiveWrite(ctx, operation.bucket, operation.key, response); err != nil {
			return fmt.Errorf("archive %s/%s: %w", operation.bucket, operation.key, err)
		}
	case operation.read:
		f.decorateVersionedRead(operation.bucket, operation.key, response)
	case operation.remove && success:
		if err := f.recordDeleteMarker(operation.bucket, operation.key, response); err != nil {
			return fmt.Errorf("record the delete marker for %s/%s: %w", operation.bucket, operation.key, err)
		}
	case len(operation.removeKeys) > 0 && success:
		identifiers := operation.removeIdentifiers
		if len(identifiers) == 0 {
			for _, key := range operation.removeKeys {
				identifiers = append(identifiers, s3RemoveIdentifier{Key: key})
			}
		}
		if err := f.applyVersionedDeleteObjects(ctx, operation.bucket, identifiers); err != nil {
			return fmt.Errorf("record the versioned delete for bucket %s: %w", operation.bucket, err)
		}
	case operation.removeBucket && success:
		if err := f.versions.removeBucket(operation.bucket); err != nil {
			return fmt.Errorf("clear the version log for bucket %s: %w", operation.bucket, err)
		}
	}
	return nil
}

// s3Operation classifies one request. Only the operations whose AWS shape the
// front implements are named; everything else is a plain proxy.
//
//nolint:gocyclo // one branch per S3 method and subresource shape
func s3Operation(request *http.Request) s3ObjectOperation {
	bucket, key := splitS3Path(request.URL.Path)
	operation := s3ObjectOperation{bucket: bucket, key: key}
	query := request.URL.Query()
	switch request.Method {
	case http.MethodPut:
		if bucket == "" || key == "" {
			return s3ObjectOperation{}
		}
		// A subresource write (tagging, ACL, a part upload or copy, an object
		// lock setting) does not replace the object, so it must not change the
		// record. UploadPartCopy also carries x-amz-copy-source, but it writes
		// a part of an in-flight upload, not the destination object.
		if s3HasSubresource(query, "acl", "tagging", "uploads", "uploadId", "partNumber", "versionId", "restore", "legal-hold", "retention", "torrent", "encryption") {
			return s3ObjectOperation{}
		}
		if request.Header.Get("x-amz-copy-source") != "" {
			// CopyObject writes the destination without naming an algorithm,
			// so a previous SSE-S3 record no longer describes it. An SSE
			// header on the copy still passes through and keeps the store's
			// 501; only a successful copy clears the record.
			// https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html
			operation.overwrite = true
			return operation
		}
		if request.Header.Get(s3SSEAlgorithmHeader) == "AES256" && !s3HasSSECompanion(request.Header) {
			operation.ssePut = true
			return operation
		}
		operation.overwrite = true
		return operation
	case http.MethodHead:
		if bucket != "" && key != "" && !s3HasSubresource(query, "versionId") {
			operation.read = true
		}
	case http.MethodGet:
		// A subresource read answers about metadata or an upload, not the
		// object's stored representation, and AWS returns no SSE header for it:
		// GetObjectAttributes, GetObjectLegalHold, GetObjectRetention,
		// ListParts, GetObjectTagging, GetObjectAcl and GetObjectTorrent.
		// A plain GetObject (including ?partNumber=) does return the header.
		//
		// https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectAttributes.html
		// https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectLegalHold.html
		// https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectRetention.html
		// https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListParts.html
		if bucket != "" && key != "" && !s3HasSubresource(query, "acl", "tagging", "versionId", "torrent", "uploadId", "attributes", "legal-hold", "retention") {
			operation.read = true
		}
	case http.MethodDelete:
		// An AbortMultipartUpload (?uploadId=) frees the upload's parts; it does
		// not delete the object, so its record must stay.
		// https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html
		if bucket != "" && key != "" && !s3HasSubresource(query, "tagging", "versionId", "uploadId") {
			operation.remove = true
			return operation
		}
		// Only a plain DeleteBucket removes the bucket's objects. A bucket
		// subresource delete (?policy, ?cors, ?lifecycle, ...) removes that
		// configuration and leaves every object in place.
		if bucket != "" && key == "" && s3PlainBucketOperation(query) {
			operation.removeBucket = true
			return operation
		}
	case http.MethodPost:
		if bucket != "" && query.Has("delete") {
			operation.deleteObjects = true
			return operation
		}
		if bucket != "" && key != "" && query.Has("uploadId") {
			// CompleteMultipartUpload writes the destination without naming an
			// encryption algorithm; the upload's CreateMultipartUpload names it,
			// and the store refuses an SSE-headed create on its filesystem
			// backend, so a successful completion here is a plain write. It
			// clears a previous SSE-S3 record like a plain PutObject does.
			// https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html
			operation.overwrite = true
			return operation
		}
	}
	return operation
}

func s3HasSSECompanion(header http.Header) bool {
	return header.Get(s3SSEKMSKeyHeader) != "" ||
		header.Get(s3SSEKMSContext) != "" ||
		header.Get(s3SSEBucketKeyHeader) != "" ||
		header.Get(s3SSECAlgorithm) != "" ||
		header.Get(s3SSECKey) != "" ||
		header.Get(s3SSECKeyMD5) != ""
}

func s3HasSubresource(query url.Values, names ...string) bool {
	for _, name := range names {
		if query.Has(name) {
			return true
		}
	}
	return false
}

// s3PlainBucketOperation reports whether a bucket-level request names no
// subresource. The SDKs add x-id as an operation marker on the request line;
// that is not a subresource. Any other query parameter names a bucket
// subresource operation (policy, cors, lifecycle, encryption, tagging, ...),
// whose success leaves the bucket and its objects in place.
func s3PlainBucketOperation(query url.Values) bool {
	for name := range query {
		if name != "x-id" {
			return false
		}
	}
	return true
}

func splitS3Path(path string) (string, string) {
	trimmed := strings.TrimPrefix(path, "/")
	if trimmed == "" {
		return "", ""
	}
	bucket, key, found := strings.Cut(trimmed, "/")
	if !found {
		return bucket, ""
	}
	return bucket, key
}

// s3RemoveIdentifier is one Object entry of a DeleteObjects request. VersionId
// is empty for a plain object delete.
type s3RemoveIdentifier struct {
	Key       string
	VersionID string
}

// bufferDeleteObjects preserves a DeleteObjects body for the upstream request
// and, when the body fits the front's buffer, returns the keys and versions it
// names so the SSE-S3 records and the version log stay in step. The forwarded
// body is always byte-identical: SigV4 signed the unchanged payload.
//
// AWS allows 1000 keys of up to 1024 bytes, a body of about 1.05 MiB, so a body
// above the buffer is a valid request the v7.0.0 path carried to s3proxy. It is
// replayed unchanged without being parsed, and its records are left for a later
// clearing write (a plain PutObject, a plain CopyObject or a successful
// CompleteMultipartUpload); refusing it would add a failure the released runner
// did not have.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html
func bufferDeleteObjects(request *http.Request) (*http.Request, []s3RemoveIdentifier, bool, error) {
	if request.Body == nil {
		return request, nil, true, nil
	}
	payload, err := io.ReadAll(io.LimitReader(request.Body, s3FrontMaxBody+1))
	if err != nil {
		return nil, nil, false, fmt.Errorf("read the DeleteObjects body: %w", err)
	}
	clone := request.Clone(request.Context())
	if len(payload) > s3FrontMaxBody {
		clone.Body = &s3ReplayBody{
			Reader: io.MultiReader(bytes.NewReader(payload), request.Body),
			closer: request.Body,
		}
		return clone, nil, false, nil
	}
	_ = request.Body.Close() //nolint:errcheck // the body is already read
	clone.Body = io.NopCloser(bytes.NewReader(payload))
	clone.ContentLength = int64(len(payload))
	var body struct {
		Objects []struct {
			Key       string `xml:"Key"`
			VersionID string `xml:"VersionId"`
		} `xml:"Object"`
	}
	identifiers := []s3RemoveIdentifier(nil)
	if err := xml.Unmarshal(payload, &body); err == nil {
		for _, object := range body.Objects {
			if object.Key != "" {
				identifiers = append(identifiers, s3RemoveIdentifier{Key: object.Key, VersionID: object.VersionID})
			}
		}
	}
	return clone, identifiers, true, nil
}

// s3ReplayBody replays the bytes the front read before deciding a body was too
// large to parse, then streams the rest unchanged; Close releases the original
// request body.
type s3ReplayBody struct {
	io.Reader
	closer io.Closer
}

func (b *s3ReplayBody) Close() error { return b.closer.Close() }

// startS3Front starts the front when the run's S3 endpoint is the profile's
// s3proxy container. A caller-supplied --endpoint s3=... is left alone.
func (r *Runner) startS3Front(ctx context.Context) error {
	backend, ok := r.backendForService("s3")
	if !ok || backend.HostURL == "" {
		return nil
	}
	// A caller-supplied --endpoint s3=... wins over the profile, and is never
	// fronted.
	if !r.profileEndpointServices["s3"] {
		return nil
	}
	front, err := newS3Front(r.dataDir, backend.HostURL, r.logf)
	if err != nil {
		return err
	}
	listeners, err := r.listenControl(ctx, "S3")
	if err != nil {
		return err
	}
	server := &http.Server{
		Handler:           front,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	r.servers = append(r.servers, server)
	serve := func(listener net.Listener) {
		go func() {
			if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) && !errors.Is(serveErr, net.ErrClosed) {
				r.logf("local S3 front stopped: %v", serveErr)
			}
		}()
	}
	serve(listeners.Loopback)
	if listeners.Gateway != nil {
		serve(listeners.Gateway)
	}
	front.hostURL = listeners.HostURL
	front.containerURL = listeners.ContainerURL
	front.port = listeners.Port
	front.issuedRecord = r.iamCredential
	r.s3Front = front
	persistence := "in memory"
	if r.dataDir != "" {
		persistence = "under " + filepath.Join(r.dataDir, "s3sse", s3FrontIndexFile)
	}
	r.logf("local S3 front at %s (containers: %s; s3proxy upstream %s; SSE-S3 records %s)", listeners.HostURL, listeners.ContainerURL, backend.HostURL, persistence)
	return nil
}

// wireS3FrontEndpoint points the function-facing S3 endpoint at the front's
// host-gateway IP. An IP endpoint keeps the SDK on path-style addressing, the
// form s3proxy serves and the form v7.0.0 injected.
func (r *Runner) wireS3FrontEndpoint(hostGateway string) error {
	if r.s3Front == nil {
		return nil
	}
	hostGateway = strings.TrimSpace(hostGateway)
	if hostGateway == "" {
		return fmt.Errorf("the S3 SSE front is running but the function container could not resolve host.docker.internal; the local S3 endpoint needs an IP for path-style addressing")
	}
	endpoint := fmt.Sprintf("http://%s:%d", hostGateway, r.s3Front.port)
	r.replaceEndpoint("s3", endpoint)
	r.logf("local S3 endpoint for functions: %s (the front, path style)", endpoint)
	return nil
}

// adoptIssuedSignature verifies a request signed with a credential the run
// issued and re-signs it with the store's own identity, which s3proxy verifies.
// It reports whether it adopted the request; a request signed with any other
// key is left exactly as it arrived, so the store's answer does not change.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
func (f *s3Front) adoptIssuedSignature(request *http.Request) (bool, error) {
	authorization := request.Header.Get("Authorization")
	if !strings.HasPrefix(authorization, "AWS4-HMAC-SHA256 ") {
		return false, nil
	}
	fields, _, err := s3AuthorizationFields(authorization)
	if err != nil {
		return false, nil
	}
	scope := strings.Split(fields["Credential"], "/")
	if len(scope) != 5 || scope[4] != sigV4Terminator {
		return false, nil
	}
	record, ok := f.issuedRecord(scope[0])
	if !ok {
		// Not a credential this run issued: the store decides, as before.
		return false, nil
	}
	body := bodyForSignature(request)
	checker := &signatureChecker{
		now:     time.Now(),
		service: "s3",
		records: func(accessKey string) (iamCredentialRecord, bool) {
			if accessKey != scope[0] {
				return iamCredentialRecord{}, false
			}
			return record, true
		},
	}
	if _, verifyErr := checker.verify(request, body); verifyErr != nil {
		return false, verifyErr
	}
	if err := f.resign(request); err != nil {
		return false, err
	}
	return true, nil
}

// stripUnimplementedStoreHeaders removes the SDK checksum headers s3proxy
// answers with "A header you provided implies functionality that is not
// implemented". The store has no checksum support, so a checksum it cannot
// verify is not forwarded; a request the front re-signs keeps a valid
// signature, and one it forwards unchanged was never verified by the store
// anyway.
//
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html
func stripUnimplementedStoreHeaders(request *http.Request) {
	for _, name := range []string{
		"X-Amz-Sdk-Checksum-Algorithm", "X-Amz-Checksum-Crc32",
		"X-Amz-Checksum-Crc32c", "X-Amz-Checksum-Sha1",
		"X-Amz-Checksum-Sha256", "X-Amz-Checksum-Mode", "X-Amz-Trailer",
	} {
		request.Header.Del(name)
	}
}

// bodyForSignature returns the request body a signature check must hash. A
// request that carries an X-Amz-Content-Sha256 header needs no body.
func bodyForSignature(request *http.Request) []byte {
	if strings.TrimSpace(request.Header.Get("X-Amz-Content-Sha256")) != "" {
		return nil
	}
	if request.Body == nil {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, s3FrontMaxBody))
	if err != nil {
		return nil
	}
	_ = request.Body.Close() //nolint:errcheck // the body is already read
	request.Body = io.NopCloser(bytes.NewReader(body))
	return body
}

// applyDeleteObjectsDigest restores the Content-MD5 header S3 requires on a
// DeleteObjects request. The SDKs send a flexible checksum instead, which the
// front removes because s3proxy does not implement it; the store then refuses
// the request for the missing digest. The body is buffered, digested and
// restored, and the header is set before the front signs the request.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html
func applyDeleteObjectsDigest(request *http.Request) error {
	if request.Method != http.MethodPost || request.Body == nil {
		return nil
	}
	if _, ok := request.URL.Query()["delete"]; !ok {
		return nil
	}
	if request.Header.Get("Content-Md5") != "" {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, s3FrontDeleteObjectsMaxBody))
	if err != nil {
		return fmt.Errorf("read the DeleteObjects body to digest it: %w", err)
	}
	if len(body) >= s3FrontDeleteObjectsMaxBody {
		return fmt.Errorf(
			"the local S3 front cannot digest a DeleteObjects body larger than %d bytes",
			s3FrontDeleteObjectsMaxBody)
	}
	_ = request.Body.Close() //nolint:errcheck // the body is already read
	request.Body = io.NopCloser(bytes.NewReader(body))
	request.ContentLength = int64(len(body))
	sum := md5.Sum(body) //nolint:gosec // S3's Content-MD5 is an integrity digest, not a security hash
	request.Header.Set("Content-Md5", base64.StdEncoding.EncodeToString(sum[:]))
	return nil
}
