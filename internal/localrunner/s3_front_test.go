package localrunner

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// fakeS3Proxy models the pinned s3proxy filesystem backend: every request that
// carries a server-side-encryption header is refused with 501, because the
// store writes plaintext to a real disk. The front must strip the header
// before the backend sees it.
type fakeS3Proxy struct {
	mu        sync.Mutex
	objects   map[string]map[string][]byte
	sawSSE    int
	refusals  int
	listCalls int
	// signedSSE counts forwarded requests whose SigV4 SignedHeaders still
	// names the SSE header, which s3proxy rejects (the real failure the
	// re-sign fixes).
	signedSSE int
	// signatureMismatches counts forwarded requests whose signature does not
	// cover the path and headers the backend received. s3proxy answers 403
	// SignatureDoesNotMatch; modeling it here catches a double-escaped
	// canonical URI.
	signatureMismatches int
	// signedPaths records every forwarded request path that carried a
	// signature, so a test can assert what the backend actually saw.
	signedPaths []string
	// lastDeleteBody is the body of the last DeleteObjects request the
	// backend received, so a test can assert the front forwarded it whole.
	lastDeleteBody []byte
}

func newFakeS3Proxy() *fakeS3Proxy {
	return &fakeS3Proxy{objects: map[string]map[string][]byte{}}
}

func (f *fakeS3Proxy) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if auth := request.Header.Get("Authorization"); auth != "" {
		if strings.Contains(auth, s3SSEAlgorithmHeader) {
			f.signedSSE++
		}
		f.signedPaths = append(f.signedPaths, request.URL.EscapedPath())
		if err := verifyForwardedS3Signature(request); err != nil {
			f.signatureMismatches++
			writer.WriteHeader(http.StatusForbidden)
			writeS3Error(writer, "SignatureDoesNotMatch", err.Error())
			return
		}
	}
	if request.Header.Get(s3SSEAlgorithmHeader) != "" ||
		request.Header.Get(s3SSEKMSKeyHeader) != "" ||
		request.Header.Get(s3SSECAlgorithm) != "" {
		f.sawSSE++
		f.refusals++
		writer.WriteHeader(http.StatusNotImplemented)
		writeS3Error(writer, "NotImplemented", "Server-side encryption is not supported.")
		return
	}
	bucket, key := splitS3Path(request.URL.Path)
	switch {
	case request.Method == http.MethodGet && bucket == "":
		f.listCalls++
		writer.Header().Set("Content-Type", "application/xml")
		_, _ = writer.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>`)) //nolint:errcheck // fixture
	case request.Method == http.MethodPut && bucket != "" && key != "" && request.Header.Get("x-amz-copy-source") != "":
		sourceBucket, sourceKey := splitS3Path(strings.TrimPrefix(request.Header.Get("x-amz-copy-source"), "/"))
		body := f.objects[sourceBucket][sourceKey]
		if f.objects[bucket] == nil {
			f.objects[bucket] = map[string][]byte{}
		}
		f.objects[bucket][key] = body
		writer.Header().Set("Content-Type", "application/xml")
		_, _ = writer.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>"fixture"</ETag></CopyObjectResult>`)) //nolint:errcheck // fixture
	case request.Method == http.MethodPut && bucket != "" && key != "":
		body, _ := io.ReadAll(request.Body) //nolint:errcheck // fixture
		if f.objects[bucket] == nil {
			f.objects[bucket] = map[string][]byte{}
		}
		f.objects[bucket][key] = body
		writer.Header().Set("ETag", `"fixture"`)
		writer.WriteHeader(http.StatusOK)
	case request.Method == http.MethodHead && bucket != "" && key != "":
		body, ok := f.objects[bucket][key]
		if !ok {
			writer.WriteHeader(http.StatusNotFound)
			writeS3Error(writer, "NoSuchKey", "The specified key does not exist.")
			return
		}
		writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
		writer.Header().Set("Content-Type", "text/plain")
		writer.Header().Set("ETag", `"fixture"`)
		writer.WriteHeader(http.StatusOK)
	case request.Method == http.MethodGet && bucket != "" && key != "":
		body, ok := f.objects[bucket][key]
		if !ok {
			writer.WriteHeader(http.StatusNotFound)
			writeS3Error(writer, "NoSuchKey", "The specified key does not exist.")
			return
		}
		writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
		writer.Header().Set("Content-Type", "text/plain")
		_, _ = writer.Write(body) //nolint:errcheck // fixture
	case request.Method == http.MethodDelete && bucket != "" && key == "":
		delete(f.objects, bucket)
		writer.WriteHeader(http.StatusNoContent)
	case request.Method == http.MethodDelete && bucket != "":
		delete(f.objects[bucket], key)
		writer.WriteHeader(http.StatusNoContent)
	case request.Method == http.MethodPost && request.URL.Query().Has("delete"):
		payload, _ := io.ReadAll(request.Body) //nolint:errcheck // fixture
		f.lastDeleteBody = payload
		var body struct {
			Objects []struct {
				Key string `xml:"Key"`
			} `xml:"Object"`
		}
		_ = xml.Unmarshal(payload, &body) //nolint:errcheck // fixture
		for _, object := range body.Objects {
			delete(f.objects[bucket], object.Key)
		}
		writer.Header().Set("Content-Type", "application/xml")
		_, _ = writer.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><DeleteResult></DeleteResult>`)) //nolint:errcheck // fixture
	default:
		writer.WriteHeader(http.StatusBadRequest)
		writeS3Error(writer, "InvalidRequest", request.Method+" "+request.URL.Path)
	}
}

// verifyForwardedS3Signature models s3proxy's SigV4 check at the backend: the
// signature must cover the path and headers as received, with S3's canonical
// URI rule (the URI-encoded path, encoded once). A double-escaped canonical
// URI is the real 403 SignatureDoesNotMatch Autheory observed.
func verifyForwardedS3Signature(request *http.Request) error {
	payloadHash := request.Header.Get("X-Amz-Content-Sha256")
	if payloadHash == "" {
		return fmt.Errorf("the forwarded request has no x-amz-content-sha256")
	}
	signedAt, err := time.Parse("20060102T150405Z", request.Header.Get("X-Amz-Date"))
	if err != nil {
		return fmt.Errorf("parse x-amz-date: %w", err)
	}
	clone := request.Clone(request.Context())
	clone.Header.Del("Authorization")
	clone.Body = nil
	signer := newS3Signer()
	if err := signer.SignHTTP(request.Context(), aws.Credentials{
		AccessKeyID: "dummy", SecretAccessKey: "dummy",
	}, clone, payloadHash, "s3", LocalRegion, signedAt); err != nil {
		return fmt.Errorf("re-sign the received request: %w", err)
	}
	if got, want := clone.Header.Get("Authorization"), request.Header.Get("Authorization"); got != want {
		return fmt.Errorf("the signature does not cover the received path %q", request.URL.EscapedPath())
	}
	return nil
}

func writeS3Error(writer http.ResponseWriter, code, message string) {
	writer.Header().Set("Content-Type", "application/xml")
	_, _ = writer.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>` + code + `</Code><Message>` + message + `</Message></Error>`)) //nolint:errcheck,gosec // fixture
}

func s3ClientFor(t *testing.T, endpoint string) *s3.Client {
	t.Helper()
	return s3.New(s3.Options{
		Region:       LocalRegion,
		Credentials:  localCredentials(),
		BaseEndpoint: aws.String(endpoint),
		UsePathStyle: true,
	})
}

func newS3FrontForTest(t *testing.T, dataDir string, backend *fakeS3Proxy) (*s3Front, *httptest.Server) {
	t.Helper()
	upstream := httptest.NewServer(backend)
	t.Cleanup(upstream.Close)
	front, err := newS3Front(dataDir, upstream.URL, func(string, ...any) {})
	if err != nil {
		t.Fatalf("new S3 front: %v", err)
	}
	server := httptest.NewServer(front)
	t.Cleanup(server.Close)
	return front, server
}

// TestS3FrontSSES3PutHeadGet is the G3 proof: a real SDK put names AES256, the
// backend never sees the header, and HEAD and GET report the algorithm.
func TestS3FrontSSES3PutHeadGet(t *testing.T) {
	backend := newFakeS3Proxy()
	_, server := newS3FrontForTest(t, "", backend)
	client := s3ClientFor(t, server.URL)
	ctx := context.Background()
	put, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:               aws.String("audit-bucket"),
		Key:                  aws.String("events/one.json"),
		Body:                 strings.NewReader(`{"event":1}`),
		ServerSideEncryption: s3types.ServerSideEncryptionAes256,
	})
	if err != nil {
		t.Fatalf("put with SSE-S3: %v", err)
	}
	if put.ServerSideEncryption != s3types.ServerSideEncryptionAes256 {
		t.Fatalf("PutObject response algorithm %q", put.ServerSideEncryption)
	}
	if backend.sawSSE != 0 {
		t.Fatalf("the backend saw the SSE header %d time(s)", backend.sawSSE)
	}
	if backend.signedSSE != 0 {
		t.Fatalf("the forwarded request still declared the stripped SSE header as signed")
	}
	head, err := client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String("audit-bucket"), Key: aws.String("events/one.json"),
	})
	if err != nil {
		t.Fatalf("head: %v", err)
	}
	if head.ServerSideEncryption != s3types.ServerSideEncryptionAes256 {
		t.Fatalf("HeadObject algorithm %q", head.ServerSideEncryption)
	}
	get, err := client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String("audit-bucket"), Key: aws.String("events/one.json"),
	})
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() { _ = get.Body.Close() }() //nolint:errcheck // fixture
	body, _ := io.ReadAll(get.Body)         //nolint:errcheck // fixture
	if string(body) != `{"event":1}` {
		t.Fatalf("get body %q", body)
	}
	if get.ServerSideEncryption != s3types.ServerSideEncryptionAes256 {
		t.Fatalf("GetObject algorithm %q", get.ServerSideEncryption)
	}
}

// s3EscapedKeyPath escapes one object key the way a path-style S3 request
// carries it: every segment is URI-encoded, and the '/' separators stay.
func s3EscapedKeyPath(key string) string {
	segments := strings.Split(key, "/")
	for index, segment := range segments {
		segments[index] = url.PathEscape(segment)
	}
	return strings.Join(segments, "/")
}

// TestS3FrontResignSignsTheForwardedPath is the G7 unit proof: the re-signed
// canonical URI is the URI-encoded path encoded once, so it matches the path
// the backend receives for keys with '=', spaces, '+', '%', unicode and '/'
// segments. The generic signer (which escapes the path a second time) does not
// match for every escaping shape, which is the defect the test pins.
func TestS3FrontResignSignsTheForwardedPath(t *testing.T) {
	front, err := newS3Front("", "http://127.0.0.1:1", nil)
	if err != nil {
		t.Fatalf("new S3 front: %v", err)
	}
	keys := []string{
		"events/one.json",
		"environment=local/organization=acme/tenant_id=acme/event.json",
		"audit logs/with space.txt",
		"plus+sign.txt",
		"percent%.txt",
		"ünïcode/日本語.txt",
		"segments/with/slashes.txt",
	}
	payloadHash := strings.Repeat("a", 64)
	for _, key := range keys {
		t.Run(key, func(t *testing.T) {
			parsed, parseErr := url.Parse("http://front.invalid/audit-bucket/" + s3EscapedKeyPath(key))
			if parseErr != nil {
				t.Fatalf("parse the object URL: %v", parseErr)
			}
			request := &http.Request{
				Method: http.MethodPut,
				URL:    parsed,
				Host:   "front.invalid",
				Header: http.Header{},
			}
			request.Header.Set("X-Amz-Content-Sha256", payloadHash)
			if signErr := newS3Signer().SignHTTP(context.Background(), front.credentials, request, payloadHash, "s3", LocalRegion, time.Now().UTC()); signErr != nil {
				t.Fatalf("sign the incoming request: %v", signErr)
			}
			if resignErr := front.resign(request); resignErr != nil {
				t.Fatalf("resign: %v", resignErr)
			}
			signedAt, parseErr := time.Parse("20060102T150405Z", request.Header.Get("X-Amz-Date"))
			if parseErr != nil {
				t.Fatalf("parse x-amz-date: %v", parseErr)
			}
			if got, want := resignWith(t, front, request, payloadHash, signedAt, newS3Signer()), request.Header.Get("Authorization"); got != want {
				t.Fatalf("the S3 signer does not reproduce the forwarded signature for %q", request.URL.EscapedPath())
			}
			// A path with no byte the second pass escapes is identical under
			// both signers; every escaping shape must differ.
			if strings.ContainsAny(request.URL.EscapedPath(), "%+") &&
				resignWith(t, front, request, payloadHash, signedAt, v4.NewSigner()) == request.Header.Get("Authorization") {
				t.Fatalf("the double-escaping signer unexpectedly matched %q; the test no longer pins the defect", request.URL.EscapedPath())
			}
		})
	}
}

func resignWith(t *testing.T, front *s3Front, request *http.Request, payloadHash string, signedAt time.Time, signer *v4.Signer) string {
	t.Helper()
	clone := request.Clone(context.Background())
	clone.Body = nil
	clone.Header.Del("Authorization")
	if err := signer.SignHTTP(context.Background(), front.credentials, clone, payloadHash, "s3", LocalRegion, signedAt); err != nil {
		t.Fatalf("re-sign: %v", err)
	}
	return clone.Header.Get("Authorization")
}

// TestS3FrontSSES3AcceptsEscapedKeys is the G7 real-path proof: keys that
// carry '=' (the audit sink's form), spaces, '+', '%', unicode and '/'
// segments go through the SDK, the front re-signs after stripping the SSE
// header, and the backend's SigV4 check accepts every one.
func TestS3FrontSSES3AcceptsEscapedKeys(t *testing.T) {
	backend := newFakeS3Proxy()
	_, server := newS3FrontForTest(t, "", backend)
	client := s3ClientFor(t, server.URL)
	ctx := context.Background()
	keys := []string{
		"events/one.json",
		"environment=local/organization=acme/tenant_id=acme/event_type=audit/date=2026-11-07/x.json",
		"audit logs/with space.txt",
		"plus+sign.txt",
		"percent%.txt",
		"ünïcode/日本語.txt",
		"segments/with/slashes.txt",
	}
	for _, key := range keys {
		body := "body:" + key
		if _, err := client.PutObject(ctx, &s3.PutObjectInput{
			Bucket:               aws.String("audit-bucket"),
			Key:                  aws.String(key),
			Body:                 strings.NewReader(body),
			ServerSideEncryption: s3types.ServerSideEncryptionAes256,
		}); err != nil {
			t.Fatalf("put %q with SSE-S3: %v", key, err)
		}
		head, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String("audit-bucket"), Key: aws.String(key)})
		if err != nil {
			t.Fatalf("head %q: %v", key, err)
		}
		if head.ServerSideEncryption != s3types.ServerSideEncryptionAes256 {
			t.Fatalf("head %q algorithm %q", key, head.ServerSideEncryption)
		}
		get, err := client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String("audit-bucket"), Key: aws.String(key)})
		if err != nil {
			t.Fatalf("get %q: %v", key, err)
		}
		stored, _ := io.ReadAll(get.Body) //nolint:errcheck // fixture
		_ = get.Body.Close()              //nolint:errcheck // fixture
		if string(stored) != body {
			t.Fatalf("get %q body %q", key, stored)
		}
	}
	if backend.signatureMismatches != 0 {
		t.Fatalf("the backend rejected %d forwarded signature(s); paths seen: %v", backend.signatureMismatches, backend.signedPaths)
	}
}

// TestS3FrontOverwriteAndDeleteClearTheRecord proves an unheadered overwrite
// and a delete do not leave a stale AES256 answer.
func TestS3FrontOverwriteAndDeleteClearTheRecord(t *testing.T) {
	backend := newFakeS3Proxy()
	_, server := newS3FrontForTest(t, "", backend)
	client := s3ClientFor(t, server.URL)
	ctx := context.Background()
	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String("b"), Key: aws.String("k"), Body: strings.NewReader("one"),
		ServerSideEncryption: s3types.ServerSideEncryptionAes256,
	}); err != nil {
		t.Fatalf("put SSE: %v", err)
	}
	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String("b"), Key: aws.String("k"), Body: strings.NewReader("two"),
	}); err != nil {
		t.Fatalf("overwrite: %v", err)
	}
	head, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String("b"), Key: aws.String("k")})
	if err != nil {
		t.Fatalf("head after overwrite: %v", err)
	}
	if head.ServerSideEncryption != "" {
		t.Fatalf("an unheadered overwrite kept the AES256 answer: %q", head.ServerSideEncryption)
	}
	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String("b"), Key: aws.String("k"), Body: strings.NewReader("three"),
		ServerSideEncryption: s3types.ServerSideEncryptionAes256,
	}); err != nil {
		t.Fatalf("put SSE again: %v", err)
	}
	if _, err := client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String("b"), Key: aws.String("k")}); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String("b"), Key: aws.String("k")}); err == nil {
		t.Fatal("head after delete succeeded")
	}
	if len(backend.objects["b"]) != 0 {
		t.Fatalf("the backend still holds %v", backend.objects["b"])
	}
}

// TestS3FrontPersistsTheRecord proves --data-dir keeps the answer across a
// front restart while the object stays in the backend.
func TestS3FrontPersistsTheRecord(t *testing.T) {
	backend := newFakeS3Proxy()
	dataDir := t.TempDir()
	_, first := newS3FrontForTest(t, dataDir, backend)
	client := s3ClientFor(t, first.URL)
	if _, err := client.PutObject(context.Background(), &s3.PutObjectInput{
		Bucket: aws.String("b"), Key: aws.String("k"), Body: strings.NewReader("x"),
		ServerSideEncryption: s3types.ServerSideEncryptionAes256,
	}); err != nil {
		t.Fatalf("put: %v", err)
	}
	_, second := newS3FrontForTest(t, dataDir, backend)
	client2 := s3ClientFor(t, second.URL)
	head, err := client2.HeadObject(context.Background(), &s3.HeadObjectInput{Bucket: aws.String("b"), Key: aws.String("k")})
	if err != nil {
		t.Fatalf("head after restart: %v", err)
	}
	if head.ServerSideEncryption != s3types.ServerSideEncryptionAes256 {
		t.Fatalf("the record did not survive the restart: %q", head.ServerSideEncryption)
	}
	info, err := os.Stat(filepath.Join(dataDir, "s3sse", s3FrontIndexFile))
	if err != nil {
		t.Fatalf("the index file: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("the index mode is %v, want 0600", info.Mode().Perm())
	}
}

// TestS3FrontLeavesSSEKMSRefused proves aws:kms keeps the backend's answer.
func TestS3FrontLeavesSSEKMSRefused(t *testing.T) {
	backend := newFakeS3Proxy()
	_, server := newS3FrontForTest(t, "", backend)
	client := s3ClientFor(t, server.URL)
	_, err := client.PutObject(context.Background(), &s3.PutObjectInput{
		Bucket:               aws.String("b"),
		Key:                  aws.String("k"),
		Body:                 strings.NewReader("x"),
		ServerSideEncryption: s3types.ServerSideEncryptionAwsKms,
		SSEKMSKeyId:          aws.String("alias/aws/s3"),
	})
	if err == nil {
		t.Fatal("an aws:kms put succeeded; the runner cannot honor it")
	}
	if !strings.Contains(err.Error(), "NotImplemented") && !strings.Contains(err.Error(), "Server-side encryption is not supported") {
		t.Fatalf("unexpected aws:kms error: %v", err)
	}
	if backend.refusals == 0 {
		t.Fatal("the backend did not refuse the aws:kms request")
	}
}

// TestS3FrontDeleteObjectsClearsTheRecord proves a batch delete does not leave
// stale answers.
func TestS3FrontDeleteObjectsClearsTheRecord(t *testing.T) {
	backend := newFakeS3Proxy()
	_, server := newS3FrontForTest(t, "", backend)
	client := s3ClientFor(t, server.URL)
	ctx := context.Background()
	for _, key := range []string{"a", "b"} {
		if _, err := client.PutObject(ctx, &s3.PutObjectInput{
			Bucket: aws.String("bucket"), Key: aws.String(key), Body: strings.NewReader("x"),
			ServerSideEncryption: s3types.ServerSideEncryptionAes256,
		}); err != nil {
			t.Fatalf("put %s: %v", key, err)
		}
	}
	if _, err := client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
		Bucket: aws.String("bucket"),
		Delete: &s3types.Delete{Objects: []s3types.ObjectIdentifier{
			{Key: aws.String("a")}, {Key: aws.String("b")},
		}},
	}); err != nil {
		t.Fatalf("delete objects: %v", err)
	}
	// Write a plain object under one of the deleted keys; a stale record would
	// claim AES256.
	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String("bucket"), Key: aws.String("a"), Body: strings.NewReader("plain"),
	}); err != nil {
		t.Fatalf("put plain: %v", err)
	}
	head, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String("bucket"), Key: aws.String("a")})
	if err != nil {
		t.Fatalf("head: %v", err)
	}
	if head.ServerSideEncryption != "" {
		t.Fatalf("a deleted key kept its AES256 record: %q", head.ServerSideEncryption)
	}
}

// TestS3FrontDeleteObjectsForwardsBodiesAboveTheBuffer is the B1 proof: AWS
// allows 1000 keys of up to 1024 bytes, a DeleteObjects body of about 1.05 MiB
// that v7.0.0 carried straight to s3proxy. The front forwards it byte-identical
// instead of answering 400, giving up only the best-effort SSE-S3 record clear.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html
func TestS3FrontDeleteObjectsForwardsBodiesAboveTheBuffer(t *testing.T) {
	backend := newFakeS3Proxy()
	front, server := newS3FrontForTest(t, "", backend)
	client := s3ClientFor(t, server.URL)
	ctx := context.Background()
	const bucket = "bucket"
	staleKey := "stale-object"
	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(bucket), Key: aws.String(staleKey), Body: strings.NewReader("x"),
		ServerSideEncryption: s3types.ServerSideEncryptionAes256,
	}); err != nil {
		t.Fatalf("put with SSE-S3: %v", err)
	}
	if !front.index.has(bucket, staleKey) {
		t.Fatal("the SSE-S3 record was not set")
	}
	objects := make([]s3types.ObjectIdentifier, 0, 1000)
	objects = append(objects, s3types.ObjectIdentifier{Key: aws.String(staleKey)})
	for index := 1; index < 1000; index++ {
		objects = append(objects, s3types.ObjectIdentifier{
			Key: aws.String(fmt.Sprintf("%s%08d", strings.Repeat("k", 1016), index)),
		})
	}
	if _, err := client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
		Bucket: aws.String(bucket), Delete: &s3types.Delete{Objects: objects},
	}); err != nil {
		t.Fatalf("DeleteObjects with 1000 keys of 1024 bytes: %v", err)
	}
	backend.mu.Lock()
	received := append([]byte(nil), backend.lastDeleteBody...)
	backend.mu.Unlock()
	if len(received) <= s3FrontMaxBody {
		t.Fatalf("the backend received %d bytes, want the over-buffer body", len(received))
	}
	var sent struct {
		Objects []struct {
			Key string `xml:"Key"`
		} `xml:"Object"`
	}
	if err := xml.Unmarshal(received, &sent); err != nil {
		t.Fatalf("the forwarded DeleteObjects body is not whole: %v", err)
	}
	if len(sent.Objects) != 1000 || sent.Objects[0].Key != staleKey || len(sent.Objects[999].Key) != 1024 {
		t.Fatalf("forwarded %d keys, first %q, last of length %d",
			len(sent.Objects), sent.Objects[0].Key, len(sent.Objects[999].Key))
	}
	if !front.index.has(bucket, staleKey) {
		t.Fatal("the front parsed an over-buffer body; the record clear is documented best-effort")
	}
}

// TestS3FrontVerifiesTheCallerSignature is the Adv-1 proof: the front re-signs
// an SSE put as the local identity after stripping the signed SSE header, so it
// checks the caller's own SigV4 against that identity first. A request s3proxy
// would answer 403 to is refused here and never reaches the store.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
func TestS3FrontVerifiesTheCallerSignature(t *testing.T) {
	backend := newFakeS3Proxy()
	front, server := newS3FrontForTest(t, "", backend)
	for name, credentials := range map[string]aws.Credentials{
		"wrong secret":     {AccessKeyID: "dummy", SecretAccessKey: "not-dummy", Source: "static"},
		"foreign identity": {AccessKeyID: "other", SecretAccessKey: "dummy", Source: "static"},
	} {
		t.Run(name, func(t *testing.T) {
			client := s3.New(s3.Options{
				Region: LocalRegion,
				Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
					return credentials, nil
				}),
				BaseEndpoint: aws.String(server.URL),
				UsePathStyle: true,
			})
			_, err := client.PutObject(context.Background(), &s3.PutObjectInput{
				Bucket: aws.String("bucket"), Key: aws.String("key"), Body: strings.NewReader("x"),
				ServerSideEncryption: s3types.ServerSideEncryptionAes256,
			})
			if err == nil {
				t.Fatal("an SSE put signed with other credentials was accepted")
			}
			if !strings.Contains(err.Error(), "SignatureDoesNotMatch") {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
	// A malformed Authorization header is refused the same way.
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://front/bucket/key", strings.NewReader("x"))
	request.Header.Set(s3SSEAlgorithmHeader, "AES256")
	request.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=stale")
	recorder := httptest.NewRecorder()
	front.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "SignatureDoesNotMatch") {
		t.Fatalf("malformed Authorization: status %d body %s", recorder.Code, recorder.Body.String())
	}
	backend.mu.Lock()
	forwarded := len(backend.signedPaths) + backend.refusals
	backend.mu.Unlock()
	if forwarded != 0 {
		t.Fatalf("a refused request reached the backend (%d)", forwarded)
	}
}

// TestS3FrontCopyObjectClearsTheRecord is the Adv-3 proof: a plain CopyObject
// writes the destination without naming an encryption algorithm, so a previous
// SSE-S3 record no longer describes it. AWS reports no SSE header for that
// write; the front must not keep claiming AES256.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html
func TestS3FrontCopyObjectClearsTheRecord(t *testing.T) {
	backend := newFakeS3Proxy()
	_, server := newS3FrontForTest(t, "", backend)
	client := s3ClientFor(t, server.URL)
	ctx := context.Background()
	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String("bucket"), Key: aws.String("source"), Body: strings.NewReader("plain"),
	}); err != nil {
		t.Fatalf("put source: %v", err)
	}
	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String("bucket"), Key: aws.String("target"), Body: strings.NewReader("sse"),
		ServerSideEncryption: s3types.ServerSideEncryptionAes256,
	}); err != nil {
		t.Fatalf("put target with SSE-S3: %v", err)
	}
	head, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String("bucket"), Key: aws.String("target")})
	if err != nil {
		t.Fatalf("head before the copy: %v", err)
	}
	if head.ServerSideEncryption != s3types.ServerSideEncryptionAes256 {
		t.Fatalf("head before the copy reports %q", head.ServerSideEncryption)
	}
	if _, err := client.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket: aws.String("bucket"), Key: aws.String("target"), CopySource: aws.String("bucket/source"),
	}); err != nil {
		t.Fatalf("copy: %v", err)
	}
	head, err = client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String("bucket"), Key: aws.String("target")})
	if err != nil {
		t.Fatalf("head after the copy: %v", err)
	}
	if head.ServerSideEncryption != "" {
		t.Fatalf("a plain copy kept the AES256 record: %q", head.ServerSideEncryption)
	}
}

// TestS3FrontNonSSEPutHasNoAnswer proves an ordinary put is unchanged.
func TestS3FrontNonSSEPutHasNoAnswer(t *testing.T) {
	backend := newFakeS3Proxy()
	_, server := newS3FrontForTest(t, "", backend)
	client := s3ClientFor(t, server.URL)
	put, err := client.PutObject(context.Background(), &s3.PutObjectInput{
		Bucket: aws.String("b"), Key: aws.String("k"), Body: strings.NewReader("x"),
	})
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if put.ServerSideEncryption != "" {
		t.Fatalf("a plain put reported %q", put.ServerSideEncryption)
	}
	head, err := client.HeadObject(context.Background(), &s3.HeadObjectInput{Bucket: aws.String("b"), Key: aws.String("k")})
	if err != nil {
		t.Fatalf("head: %v", err)
	}
	if head.ServerSideEncryption != "" {
		t.Fatalf("a plain object reported %q", head.ServerSideEncryption)
	}
}
