package localrunner

import (
	"context"
	"encoding/xml"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
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
}

func newFakeS3Proxy() *fakeS3Proxy {
	return &fakeS3Proxy{objects: map[string]map[string][]byte{}}
}

func (f *fakeS3Proxy) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if auth := request.Header.Get("Authorization"); auth != "" && strings.Contains(auth, s3SSEAlgorithmHeader) {
		f.signedSSE++
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
