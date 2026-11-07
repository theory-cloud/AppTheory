package localrunner

import (
	"bytes"
	"context"
	"crypto/sha256"
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
// The front therefore accepts x-amz-server-side-encryption: AES256, strips it
// before s3proxy (which cannot store it), records the object's algorithm, adds
// the documented response header, and echoes it on HeadObject and GetObject.
// SSE-KMS and SSE-C are passed through unchanged: the runner cannot honor a
// KMS key binding or a customer key, so those requests keep s3proxy's 501
// rather than pretending to encrypt.
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
	upstream    *url.URL
	index       *s3SSEIndex
	logf        func(string, ...any)
	proxy       *httputil.ReverseProxy
	signer      *v4.Signer
	credentials aws.Credentials
	hostURL     string
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
	if logf == nil {
		logf = func(string, ...any) {}
	}
	front := &s3Front{
		upstream:    parsed,
		index:       index,
		logf:        logf,
		signer:      newS3Signer(),
		credentials: aws.Credentials{AccessKeyID: "dummy", SecretAccessKey: "dummy"},
	}
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
	// put is a PutObject that named SSE-S3.
	put bool
	// overwrite is any other PutObject: it clears a previous SSE-S3 record.
	overwrite bool
	// read is a HeadObject or GetObject.
	read bool
	// remove is a DeleteObject.
	remove bool
	// removeKeys are the keys a DeleteObjects request named.
	removeKeys []string
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
	if operation.put {
		// s3proxy refuses the header on its filesystem store; the front is
		// where the object's AES256 record lives. The SDK signed the header
		// (SigV4 lists it in SignedHeaders), so the forwarded request must be
		// re-signed as the same dummy local identity.
		clone := request.Clone(request.Context())
		clone.Header.Del(s3SSEAlgorithmHeader)
		if err := f.resign(clone); err != nil {
			f.logf("local S3 front: %v", err)
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		proxyRequest = clone
	}
	if operation.deleteObjects {
		proxy, keys, parsed, err := bufferDeleteObjects(request)
		if err != nil {
			f.logf("local S3 front: %v", err)
			http.Error(writer, err.Error(), http.StatusBadRequest)
			return
		}
		if !parsed {
			f.logf("local S3 front: the DeleteObjects body is larger than %d bytes; it is forwarded unchanged and its SSE-S3 records are left in place", s3FrontMaxBody)
		}
		proxyRequest = proxy
		operation.removeKeys = keys
	}
	proxy := *f.proxy
	proxy.ModifyResponse = func(response *http.Response) error {
		f.recordResponse(operation, response)
		return nil
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

// resign replaces the caller's SigV4 signature after a signed header was
// removed. The local credentials are the profile's static dummy pair; s3proxy
// verifies the new signature against the headers it receives. A streaming
// (aws-chunked) payload signs its chunks with the original seed signature and
// cannot be re-signed here, so it is refused with a clear error.
func (f *s3Front) resign(request *http.Request) error {
	if request.Header.Get("Authorization") == "" {
		return nil
	}
	payloadHash := strings.TrimSpace(request.Header.Get("X-Amz-Content-Sha256"))
	if strings.HasPrefix(payloadHash, "STREAMING-") {
		return fmt.Errorf("the local S3 front cannot strip a signed SSE header from a streaming (aws-chunked) PutObject")
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
			request.Header.Set("X-Amz-Content-Sha256", payloadHash)
		}
	}
	request.Header.Del("Authorization")
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
	if err := f.signer.SignHTTP(request.Context(), f.credentials, request, payloadHash, "s3", LocalRegion, time.Now().UTC()); err != nil {
		return fmt.Errorf("re-sign the PutObject: %w", err)
	}
	return nil
}

// recordResponse applies the operation to the index and the response headers.
//
//nolint:gocognit,gocyclo // one branch per operation shape
func (f *s3Front) recordResponse(operation s3ObjectOperation, response *http.Response) {
	success := response.StatusCode >= 200 && response.StatusCode < 300
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
		if bucket == "" || key == "" || request.Header.Get("x-amz-copy-source") != "" {
			return s3ObjectOperation{}
		}
		if s3HasSubresource(query, "acl", "tagging", "uploads", "uploadId", "partNumber", "versionId", "restore", "legal-hold", "retention", "torrent", "encryption") {
			return s3ObjectOperation{}
		}
		if request.Header.Get(s3SSEAlgorithmHeader) == "AES256" && !s3HasSSECompanion(request.Header) {
			operation.put = true
			return operation
		}
		operation.overwrite = true
		return operation
	case http.MethodHead:
		if bucket != "" && key != "" && !s3HasSubresource(query, "versionId") {
			operation.read = true
		}
	case http.MethodGet:
		if bucket != "" && key != "" && !s3HasSubresource(query, "acl", "tagging", "versionId", "torrent") {
			operation.read = true
		}
	case http.MethodDelete:
		if bucket != "" && key != "" && !s3HasSubresource(query, "tagging", "versionId") {
			operation.remove = true
			return operation
		}
		if bucket != "" && key == "" {
			operation.removeBucket = true
			return operation
		}
	case http.MethodPost:
		if bucket != "" && query.Has("delete") {
			operation.deleteObjects = true
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

// bufferDeleteObjects preserves a DeleteObjects body for the upstream request
// and, when the body fits the front's buffer, returns the keys it names so the
// SSE-S3 records can be cleared. The forwarded body is always byte-identical:
// SigV4 signed the unchanged payload.
//
// AWS allows 1000 keys of up to 1024 bytes, a body of about 1.05 MiB, so a body
// above the buffer is a valid request the v7.0.0 path carried to s3proxy. It is
// replayed unchanged without being parsed, and its records are left for a later
// plain write to clear; refusing it would add a failure the released runner did
// not have.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html
func bufferDeleteObjects(request *http.Request) (*http.Request, []string, bool, error) {
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
			Key string `xml:"Key"`
		} `xml:"Object"`
	}
	keys := []string(nil)
	if err := xml.Unmarshal(payload, &body); err == nil {
		for _, object := range body.Objects {
			if object.Key != "" {
				keys = append(keys, object.Key)
			}
		}
	}
	return clone, keys, true, nil
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
