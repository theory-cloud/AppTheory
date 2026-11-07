package localrunner

import (
	"context"
	"encoding/hex"
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
	// uploads are the multipart uploads the backend created.
	uploads map[string]*fakeMultipartUpload
	// completeErrors names the keys whose CompleteMultipartUpload answers 200
	// with an embedded <Error> document, the failure shape AWS documents after
	// the 200 header has been sent.
	completeErrors map[string]string
}

// fakeMultipartUpload is one in-flight multipart upload.
type fakeMultipartUpload struct {
	bucket string
	key    string
	parts  map[int][]byte
}

func newFakeS3Proxy() *fakeS3Proxy {
	return &fakeS3Proxy{
		objects:        map[string]map[string][]byte{},
		uploads:        map[string]*fakeMultipartUpload{},
		completeErrors: map[string]string{},
	}
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
	case request.Method == http.MethodPost && bucket != "" && key != "" && request.URL.Query().Has("uploads"):
		uploadID := fmt.Sprintf("upload-%d", len(f.uploads)+1)
		f.uploads[uploadID] = &fakeMultipartUpload{bucket: bucket, key: key, parts: map[int][]byte{}}
		writer.Header().Set("Content-Type", "application/xml")
		_, _ = fmt.Fprintf(writer, `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>%s</Bucket><Key>%s</Key><UploadId>%s</UploadId></InitiateMultipartUploadResult>`, bucket, key, uploadID) //nolint:errcheck,gosec // fixture
	case request.Method == http.MethodPut && bucket != "" && key != "" && request.URL.Query().Has("uploadId"):
		uploadID := request.URL.Query().Get("uploadId")
		upload, ok := f.uploads[uploadID]
		if !ok {
			writer.WriteHeader(http.StatusNotFound)
			writeS3Error(writer, "NoSuchUpload", "The specified upload does not exist.")
			return
		}
		part, _ := strconv.Atoi(request.URL.Query().Get("partNumber")) //nolint:errcheck // fixture
		body, _ := io.ReadAll(request.Body)                            //nolint:errcheck // fixture
		upload.parts[part] = body
		writer.Header().Set("ETag", fmt.Sprintf(`"part-%d"`, part))
		writer.WriteHeader(http.StatusOK)
	case request.Method == http.MethodPost && bucket != "" && key != "" && request.URL.Query().Has("uploadId"):
		uploadID := request.URL.Query().Get("uploadId")
		upload, ok := f.uploads[uploadID]
		if !ok {
			writer.WriteHeader(http.StatusNotFound)
			writeS3Error(writer, "NoSuchUpload", "The specified upload does not exist.")
			return
		}
		if code, embedded := f.completeErrors[upload.key]; embedded {
			// AWS can send the 200 header before the failure is known and embed
			// an <Error> document in the 200 response body.
			// https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html
			writer.Header().Set("Content-Type", "application/xml")
			writer.WriteHeader(http.StatusOK)
			_, _ = fmt.Fprintf(writer, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>embedded failure</Message></Error>`, code) //nolint:errcheck,gosec // fixture
			return
		}
		var completed struct {
			Parts []struct {
				PartNumber int    `xml:"PartNumber"`
				ETag       string `xml:"ETag"`
			} `xml:"Part"`
		}
		payload, _ := io.ReadAll(request.Body) //nolint:errcheck // fixture
		_ = xml.Unmarshal(payload, &completed) //nolint:errcheck // fixture
		var assembled []byte
		for number := 1; number <= len(upload.parts); number++ {
			assembled = append(assembled, upload.parts[number]...)
		}
		if f.objects[upload.bucket] == nil {
			f.objects[upload.bucket] = map[string][]byte{}
		}
		f.objects[upload.bucket][upload.key] = assembled
		delete(f.uploads, uploadID)
		writer.Header().Set("Content-Type", "application/xml")
		_, _ = fmt.Fprintf(writer, `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Bucket>%s</Bucket><Key>%s</Key><ETag>"fixture"</ETag></CompleteMultipartUploadResult>`, upload.bucket, upload.key) //nolint:errcheck,gosec // fixture
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
	case request.Method == http.MethodGet && bucket != "" && key != "" && request.URL.Query().Has("uploadId"):
		uploadID := request.URL.Query().Get("uploadId")
		upload, ok := f.uploads[uploadID]
		if !ok {
			writer.WriteHeader(http.StatusNotFound)
			writeS3Error(writer, "NoSuchUpload", "The specified upload does not exist.")
			return
		}
		writer.Header().Set("Content-Type", "application/xml")
		_, _ = fmt.Fprintf(writer, `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult><Bucket>%s</Bucket><Key>%s</Key><UploadId>%s</UploadId><MaxParts>1000</MaxParts><IsTruncated>false</IsTruncated></ListPartsResult>`, upload.bucket, upload.key, uploadID) //nolint:errcheck,gosec // fixture
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
	case request.Method == http.MethodDelete && bucket != "" && key == "" && len(request.URL.Query()) > 0:
		// A bucket subresource delete (?policy, ?cors, ...) removes that
		// configuration; the bucket and its objects stay.
		writer.WriteHeader(http.StatusNoContent)
	case request.Method == http.MethodDelete && bucket != "" && key == "":
		delete(f.objects, bucket)
		writer.WriteHeader(http.StatusNoContent)
	case request.Method == http.MethodDelete && bucket != "" && request.URL.Query().Has("uploadId"):
		// AbortMultipartUpload frees the upload's parts; the object stays.
		delete(f.uploads, request.URL.Query().Get("uploadId"))
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
	if _, copyErr := client.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket: aws.String("bucket"), Key: aws.String("target"), CopySource: aws.String("bucket/source"),
	}); copyErr != nil {
		t.Fatalf("copy: %v", copyErr)
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

// replaceS3Signature swaps the hex signature in an Authorization header.
func replaceS3Signature(authorization, signature string) string {
	index := strings.LastIndex(authorization, "Signature=")
	if index < 0 {
		return authorization
	}
	return authorization[:index+len("Signature=")] + signature
}

// TestS3FrontVerifySigV4 covers every refusal the caller check makes and the
// canonical-request helpers, so a malformed or foreign signature never reaches
// the store.
func TestS3FrontVerifySigV4(t *testing.T) {
	front, err := newS3Front("", "http://127.0.0.1:1", nil)
	if err != nil {
		t.Fatalf("new S3 front: %v", err)
	}
	newRequest := func() *http.Request {
		request := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://front/bucket/key?x-id=PutObject", strings.NewReader("x"))
		request.Header.Set("X-Amz-Content-Sha256", strings.Repeat("a", 64))
		request.Header.Set("X-Amz-Server-Side-Encryption", "AES256")
		if err := newS3Signer().SignHTTP(context.Background(), front.credentials, request, strings.Repeat("a", 64), "s3", LocalRegion, time.Now().UTC()); err != nil {
			t.Fatalf("sign the request: %v", err)
		}
		return request
	}
	if err := front.verifySigV4(newRequest()); err != nil {
		t.Fatalf("a valid signature was refused: %v", err)
	}
	unsigned := newRequest()
	unsigned.Header.Del("Authorization")
	if err := front.verifySigV4(unsigned); err != nil {
		t.Fatalf("an unsigned request was refused: %v", err)
	}
	for name, mutate := range map[string]func(*http.Request){
		"not version 4": func(r *http.Request) { r.Header.Set("Authorization", "AWS access:signature") },
		"malformed field": func(r *http.Request) {
			r.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential")
		},
		"short scope": func(r *http.Request) {
			r.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=dummy/20261107/us-east-1/s3, SignedHeaders=host, Signature=00")
		},
		"foreign identity": func(r *http.Request) {
			r.Header.Set("Authorization", strings.Replace(r.Header.Get("Authorization"), "Credential=dummy/", "Credential=other/", 1))
		},
		"foreign scope terminator": func(r *http.Request) {
			r.Header.Set("Authorization", strings.Replace(r.Header.Get("Authorization"), "/aws4_request,", "/aws4_request-x,", 1))
		},
		"non-s3 service": func(r *http.Request) {
			r.Header.Set("Authorization", strings.Replace(r.Header.Get("Authorization"), "/s3/aws4_request", "/kms/aws4_request", 1))
		},
		"no signed headers": func(r *http.Request) {
			r.Header.Set("Authorization", strings.Replace(r.Header.Get("Authorization"), "SignedHeaders=", "SignedHeaders=;", 1))
		},
		"no date": func(r *http.Request) { r.Header.Del("X-Amz-Date") },
		"bad hex": func(r *http.Request) {
			r.Header.Set("Authorization", replaceS3Signature(r.Header.Get("Authorization"), "zz"))
		},
		"mismatch": func(r *http.Request) {
			r.URL.Path = "/bucket/other"
			r.URL.RawPath = ""
		},
	} {
		t.Run(name, func(t *testing.T) {
			request := newRequest()
			mutate(request)
			if err := front.verifySigV4(request); err == nil {
				t.Fatalf("%s was accepted", name)
			}
		})
	}
}

// TestS3FrontCanonicalHelpers pins the SigV4 canonical shapes.
// TestS3FrontUnverifiedSSEPutsKeepTheStoreAnswer is the round-5 proof that the
// front applies SSE-S3 only for a put whose verified header-based SigV4
// signature covers the SSE header. Every other SSE put is forwarded unchanged,
// so the store answers it as it did at v7.0.0. The fake store models the pinned
// s3proxy: it refuses the SSE header itself (501) and rejects a forwarded
// signature that does not cover an x-amz-* header added after signing (403).
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
func TestS3FrontUnverifiedSSEPutsKeepTheStoreAnswer(t *testing.T) {
	backend := newFakeS3Proxy()
	front, server := newS3FrontForTest(t, "", backend)
	client := s3ClientFor(t, server.URL)
	ctx := context.Background()
	presigner := s3.NewPresignClient(client)
	const bucket = "bucket"

	send := func(t *testing.T, target string, header http.Header) (int, string) {
		t.Helper()
		request, err := http.NewRequestWithContext(ctx, http.MethodPut, target, strings.NewReader("payload"))
		if err != nil {
			t.Fatalf("build the put: %v", err)
		}
		for name, values := range header {
			for _, value := range values {
				request.Header.Add(name, value)
			}
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("send the put: %v", err)
		}
		defer func() { _ = response.Body.Close() }() //nolint:errcheck // fixture
		body, _ := io.ReadAll(response.Body)         //nolint:errcheck // fixture
		return response.StatusCode, string(body)
	}

	t.Run("presigned URL with an unsigned SSE header", func(t *testing.T) {
		presigned, err := presigner.PresignPutObject(ctx, &s3.PutObjectInput{
			Bucket: aws.String(bucket), Key: aws.String("presigned/unsigned"),
		})
		if err != nil {
			t.Fatalf("presign: %v", err)
		}
		before := backend.sawSSE
		status, body := send(t, presigned.URL, http.Header{s3SSEAlgorithmHeader: {"AES256"}})
		if status != http.StatusNotImplemented {
			t.Fatalf("status %d body %s; the front stripped a header the presigned URL did not sign", status, body)
		}
		if backend.sawSSE != before+1 {
			t.Fatal("the store never saw the SSE header; the front must forward it unchanged")
		}
		if front.index.has(bucket, "presigned/unsigned") {
			t.Fatal("the front recorded an SSE-S3 object the store refused")
		}
	})

	t.Run("presigned URL that signed the SSE header", func(t *testing.T) {
		presigned, err := presigner.PresignPutObject(ctx, &s3.PutObjectInput{
			Bucket:               aws.String(bucket),
			Key:                  aws.String("presigned/signed"),
			ServerSideEncryption: s3types.ServerSideEncryptionAes256,
		})
		if err != nil {
			t.Fatalf("presign with SSE-S3: %v", err)
		}
		before := backend.sawSSE
		status, body := send(t, presigned.URL, presigned.SignedHeader)
		if status != http.StatusNotImplemented {
			t.Fatalf("status %d body %s; the store's refusal must reach the caller unchanged", status, body)
		}
		if backend.sawSSE != before+1 {
			t.Fatal("the store never saw the SSE header")
		}
		if front.index.has(bucket, "presigned/signed") {
			t.Fatal("the front recorded an SSE-S3 object the store refused")
		}
	})

	t.Run("unsigned raw SSE put", func(t *testing.T) {
		before := backend.sawSSE
		status, body := send(t, server.URL+"/"+bucket+"/unsigned", http.Header{s3SSEAlgorithmHeader: {"AES256"}})
		if status != http.StatusNotImplemented {
			t.Fatalf("status %d body %s; an unsigned SSE put must keep the store's refusal", status, body)
		}
		if backend.sawSSE != before+1 {
			t.Fatal("the store never saw the SSE header")
		}
		if front.index.has(bucket, "unsigned") {
			t.Fatal("the front recorded an SSE-S3 object for an unsigned put")
		}
	})

	t.Run("header-signed put with an unsigned SSE header", func(t *testing.T) {
		payloadHash := hex.EncodeToString(s3Hash("payload"))
		request, err := http.NewRequestWithContext(ctx, http.MethodPut, server.URL+"/"+bucket+"/unsigned-header", strings.NewReader("payload"))
		if err != nil {
			t.Fatalf("build the put: %v", err)
		}
		request.Header.Set("X-Amz-Content-Sha256", payloadHash)
		if signErr := newS3Signer().SignHTTP(ctx, front.credentials, request, payloadHash, "s3", LocalRegion, time.Now().UTC()); signErr != nil {
			t.Fatalf("sign the put: %v", signErr)
		}
		// Add the SSE header after signing: the signature does not cover it, so
		// the front must not strip it and the store must refuse the request.
		request.Header.Set(s3SSEAlgorithmHeader, "AES256")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("send the put: %v", err)
		}
		defer func() { _ = response.Body.Close() }() //nolint:errcheck // fixture
		if response.StatusCode != http.StatusForbidden {
			t.Fatalf("status %d; the store must refuse an unsigned x-amz-* header", response.StatusCode)
		}
		if backend.signatureMismatches == 0 {
			t.Fatal("the front stripped a signed request's SSE header and re-signed around it")
		}
		if front.index.has(bucket, "unsigned-header") {
			t.Fatal("the front recorded an SSE-S3 object for an unsigned header")
		}
	})
}

// TestS3FrontVerifySigV4ClockWindow proves the front applies AWS's 15-minute
// header-signing window: a signature more than 15 minutes from the local clock
// is refused before the store sees it, so a replayed SSE put is not re-signed
// with a fresh timestamp. Only the new SSE path reaches verifySigV4.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
func TestS3FrontVerifySigV4ClockWindow(t *testing.T) {
	front, err := newS3Front("", "http://127.0.0.1:1", nil)
	if err != nil {
		t.Fatalf("new S3 front: %v", err)
	}
	signed := func(at time.Time) *http.Request {
		request := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://front/bucket/key", strings.NewReader("x"))
		request.Header.Set("X-Amz-Content-Sha256", strings.Repeat("a", 64))
		request.Header.Set("X-Amz-Server-Side-Encryption", "AES256")
		if err := newS3Signer().SignHTTP(context.Background(), front.credentials, request, strings.Repeat("a", 64), "s3", LocalRegion, at); err != nil {
			t.Fatalf("sign the request at %s: %v", at, err)
		}
		return request
	}
	if err := front.verifySigV4(signed(time.Now().UTC())); err != nil {
		t.Fatalf("a fresh signature was refused: %v", err)
	}
	if err := front.verifySigV4(signed(time.Now().UTC().Add(-15*time.Minute - time.Minute))); err == nil {
		t.Fatal("a signature 16 minutes old was accepted")
	}
	if err := front.verifySigV4(signed(time.Now().UTC().Add(15*time.Minute + time.Minute))); err == nil {
		t.Fatal("a signature 16 minutes in the future was accepted")
	}
}

// TestS3FrontMultipartCompletionClearsTheRecord is the round-5 proof for the
// stale-record class: a successful CompleteMultipartUpload writes the
// destination without naming an encryption algorithm (the upload's
// CreateMultipartUpload names it), so a previous SSE-S3 record no longer
// describes it. The store refuses an SSE-headed CreateMultipartUpload, so every
// completion the front sees is a plain write; a failed completion clears
// nothing.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html
func TestS3FrontMultipartCompletionClearsTheRecord(t *testing.T) {
	backend := newFakeS3Proxy()
	_, server := newS3FrontForTest(t, "", backend)
	client := s3ClientFor(t, server.URL)
	ctx := context.Background()
	const bucket, key = "bucket", "multipart/object"

	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(bucket), Key: aws.String(key), Body: strings.NewReader("first"),
		ServerSideEncryption: s3types.ServerSideEncryptionAes256,
	}); err != nil {
		t.Fatalf("put with SSE-S3: %v", err)
	}
	head, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil {
		t.Fatalf("head before the completion: %v", err)
	}
	if head.ServerSideEncryption != s3types.ServerSideEncryptionAes256 {
		t.Fatalf("head before the completion reports %q", head.ServerSideEncryption)
	}

	create, err := client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: aws.String(bucket), Key: aws.String(key),
	})
	if err != nil {
		t.Fatalf("create the multipart upload: %v", err)
	}
	part, err := client.UploadPart(ctx, &s3.UploadPartInput{
		Bucket: aws.String(bucket), Key: aws.String(key), UploadId: create.UploadId,
		PartNumber: aws.Int32(1), Body: strings.NewReader("multipart-body"),
	})
	if err != nil {
		t.Fatalf("upload the part: %v", err)
	}
	if _, completeErr := client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket: aws.String(bucket), Key: aws.String(key), UploadId: create.UploadId,
		MultipartUpload: &s3types.CompletedMultipartUpload{Parts: []s3types.CompletedPart{
			{ETag: part.ETag, PartNumber: aws.Int32(1)},
		}},
	}); completeErr != nil {
		t.Fatalf("complete the multipart upload: %v", completeErr)
	}
	head, err = client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil {
		t.Fatalf("head after the completion: %v", err)
	}
	if head.ServerSideEncryption != "" {
		t.Fatalf("a plain multipart completion kept the AES256 record: %q", head.ServerSideEncryption)
	}
	get, err := client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil {
		t.Fatalf("get after the completion: %v", err)
	}
	body, _ := io.ReadAll(get.Body) //nolint:errcheck // fixture
	_ = get.Body.Close()            //nolint:errcheck // fixture
	if string(body) != "multipart-body" {
		t.Fatalf("the completed object body is %q", body)
	}

	// A failed completion must not clear the record: the front only clears on a
	// successful write, as it did for CopyObject.
	const failedKey = "multipart/failed"
	if _, putErr := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(bucket), Key: aws.String(failedKey), Body: strings.NewReader("kept"),
		ServerSideEncryption: s3types.ServerSideEncryptionAes256,
	}); putErr != nil {
		t.Fatalf("put the failed-completion key with SSE-S3: %v", putErr)
	}
	if _, completeErr := client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket: aws.String(bucket), Key: aws.String(failedKey), UploadId: aws.String("missing-upload"),
		MultipartUpload: &s3types.CompletedMultipartUpload{Parts: []s3types.CompletedPart{
			{ETag: aws.String(`"part-1"`), PartNumber: aws.Int32(1)},
		}},
	}); completeErr == nil {
		t.Fatal("completing a missing upload succeeded")
	}
	head, err = client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(bucket), Key: aws.String(failedKey)})
	if err != nil {
		t.Fatalf("head after the failed completion: %v", err)
	}
	if head.ServerSideEncryption != s3types.ServerSideEncryptionAes256 {
		t.Fatalf("a failed completion cleared the record: %q", head.ServerSideEncryption)
	}

	// CreateMultipartUpload carrying an SSE header keeps the store's answer.
	if _, err := client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: aws.String(bucket), Key: aws.String("multipart/sse"),
		ServerSideEncryption: s3types.ServerSideEncryptionAes256,
	}); err == nil {
		t.Fatal("an SSE-headed CreateMultipartUpload succeeded; the store keeps its refusal")
	} else if !strings.Contains(err.Error(), "NotImplemented") {
		t.Fatalf("unexpected CreateMultipartUpload error: %v", err)
	}
	if backend.sawSSE == 0 {
		t.Fatal("the store never saw the CreateMultipartUpload SSE header")
	}
}

// TestS3FrontAbortMultipartUploadKeepsTheRecord is the round-6 residual-1
// proof: AbortMultipartUpload frees the upload's parts and the object stays, so
// the destination's SSE-S3 record must stay too.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html
func TestS3FrontAbortMultipartUploadKeepsTheRecord(t *testing.T) {
	backend := newFakeS3Proxy()
	front, server := newS3FrontForTest(t, "", backend)
	client := s3ClientFor(t, server.URL)
	ctx := context.Background()
	const bucket, key = "bucket", "abort/object"

	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(bucket), Key: aws.String(key), Body: strings.NewReader("original"),
		ServerSideEncryption: s3types.ServerSideEncryptionAes256,
	}); err != nil {
		t.Fatalf("put with SSE-S3: %v", err)
	}
	create, err := client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: aws.String(bucket), Key: aws.String(key),
	})
	if err != nil {
		t.Fatalf("create the multipart upload: %v", err)
	}
	if _, uploadErr := client.UploadPart(ctx, &s3.UploadPartInput{
		Bucket: aws.String(bucket), Key: aws.String(key), UploadId: create.UploadId,
		PartNumber: aws.Int32(1), Body: strings.NewReader("part"),
	}); uploadErr != nil {
		t.Fatalf("upload the part: %v", uploadErr)
	}
	if _, abortErr := client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
		Bucket: aws.String(bucket), Key: aws.String(key), UploadId: create.UploadId,
	}); abortErr != nil {
		t.Fatalf("abort the multipart upload: %v", abortErr)
	}
	if !front.index.has(bucket, key) {
		t.Fatal("aborting the upload cleared the destination's SSE-S3 record")
	}
	head, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil {
		t.Fatalf("head after the abort: %v", err)
	}
	if head.ServerSideEncryption != s3types.ServerSideEncryptionAes256 {
		t.Fatalf("after the abort HEAD reports %q, want AES256", head.ServerSideEncryption)
	}
	get, err := client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil {
		t.Fatalf("get after the abort: %v", err)
	}
	body, _ := io.ReadAll(get.Body) //nolint:errcheck // fixture
	_ = get.Body.Close()            //nolint:errcheck // fixture
	if string(body) != "original" {
		t.Fatalf("the object body changed after the abort: %q", body)
	}
	if _, err := client.ListParts(ctx, &s3.ListPartsInput{
		Bucket: aws.String(bucket), Key: aws.String(key), UploadId: create.UploadId,
	}); err == nil {
		t.Fatal("the aborted upload is still listable")
	}
}

// TestS3FrontUploadPartCopyKeepsTheRecord proves an UploadPartCopy writes a
// part of an in-flight upload, not the destination object: the object's SSE-S3
// record must stay.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_UploadPartCopy.html
func TestS3FrontUploadPartCopyKeepsTheRecord(t *testing.T) {
	backend := newFakeS3Proxy()
	front, server := newS3FrontForTest(t, "", backend)
	client := s3ClientFor(t, server.URL)
	ctx := context.Background()
	const bucket, key = "bucket", "copypart/dest"

	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(bucket), Key: aws.String(key), Body: strings.NewReader("recorded"),
		ServerSideEncryption: s3types.ServerSideEncryptionAes256,
	}); err != nil {
		t.Fatalf("put with SSE-S3: %v", err)
	}
	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(bucket), Key: aws.String("copypart/source"), Body: strings.NewReader("source"),
	}); err != nil {
		t.Fatalf("put the copy source: %v", err)
	}
	create, err := client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: aws.String(bucket), Key: aws.String(key),
	})
	if err != nil {
		t.Fatalf("create the multipart upload: %v", err)
	}
	if _, copyErr := client.UploadPartCopy(ctx, &s3.UploadPartCopyInput{
		Bucket: aws.String(bucket), Key: aws.String(key), UploadId: create.UploadId,
		PartNumber: aws.Int32(1), CopySource: aws.String(bucket + "/copypart/source"),
	}); copyErr != nil {
		t.Fatalf("copy the part: %v", copyErr)
	}
	if !front.index.has(bucket, key) {
		t.Fatal("UploadPartCopy cleared the destination's SSE-S3 record")
	}
	head, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil {
		t.Fatalf("head after the part copy: %v", err)
	}
	if head.ServerSideEncryption != s3types.ServerSideEncryptionAes256 {
		t.Fatalf("after the part copy HEAD reports %q, want AES256", head.ServerSideEncryption)
	}
}

// TestS3FrontDeleteBucketSubresourceKeepsTheRecord proves a bucket subresource
// delete (?policy, ?cors, ...) removes that configuration, not the bucket or
// its objects, so the objects' records stay.
func TestS3FrontDeleteBucketSubresourceKeepsTheRecord(t *testing.T) {
	backend := newFakeS3Proxy()
	front, server := newS3FrontForTest(t, "", backend)
	client := s3ClientFor(t, server.URL)
	ctx := context.Background()
	const bucket, key = "bucket", "policy/object"

	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(bucket), Key: aws.String(key), Body: strings.NewReader("kept"),
		ServerSideEncryption: s3types.ServerSideEncryptionAes256,
	}); err != nil {
		t.Fatalf("put with SSE-S3: %v", err)
	}
	if _, err := client.DeleteBucketPolicy(ctx, &s3.DeleteBucketPolicyInput{Bucket: aws.String(bucket)}); err != nil {
		t.Fatalf("delete the bucket policy: %v", err)
	}
	if !front.index.has(bucket, key) {
		t.Fatal("DeleteBucketPolicy cleared the bucket's SSE-S3 records")
	}
	head, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil {
		t.Fatalf("head after the policy delete: %v", err)
	}
	if head.ServerSideEncryption != s3types.ServerSideEncryptionAes256 {
		t.Fatalf("after the policy delete HEAD reports %q, want AES256", head.ServerSideEncryption)
	}
}

// TestS3FrontSubresourceReadsDoNotClaimSSE is the round-6 residual-2 proof:
// AWS returns no x-amz-server-side-encryption header for a metadata subresource
// read, so the front must not add the destination object's record to one.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectAttributes.html
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectLegalHold.html
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectRetention.html
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListParts.html
func TestS3FrontSubresourceReadsDoNotClaimSSE(t *testing.T) {
	backend := newFakeS3Proxy()
	front, server := newS3FrontForTest(t, "", backend)
	client := s3ClientFor(t, server.URL)
	ctx := context.Background()
	const bucket, key = "bucket", "read/object"

	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(bucket), Key: aws.String(key), Body: strings.NewReader("recorded"),
		ServerSideEncryption: s3types.ServerSideEncryptionAes256,
	}); err != nil {
		t.Fatalf("put with SSE-S3: %v", err)
	}
	create, err := client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: aws.String(bucket), Key: aws.String(key),
	})
	if err != nil {
		t.Fatalf("create the multipart upload: %v", err)
	}
	for name, query := range map[string]string{
		"GetObjectTagging":    "tagging",
		"GetObjectAcl":        "acl",
		"GetObjectAttributes": "attributes",
		"GetObjectLegalHold":  "legal-hold",
		"GetObjectRetention":  "retention",
		"ListParts":           "uploadId=" + aws.ToString(create.UploadId),
		"GetObjectTorrent":    "torrent",
	} {
		t.Run(name, func(t *testing.T) {
			target := "http://front/" + bucket + "/" + key + "?" + query
			request := httptest.NewRequestWithContext(ctx, http.MethodGet, target, nil)
			recorder := httptest.NewRecorder()
			front.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusOK {
				t.Fatalf("%s answered %d: %s", name, recorder.Code, recorder.Body.String())
			}
			if got := recorder.Header().Get(s3SSEAlgorithmHeader); got != "" {
				t.Fatalf("%s answered x-amz-server-side-encryption: %q; AWS returns no SSE header", name, got)
			}
		})
	}
	// A plain GET and a part read of the object do return the header.
	for _, query := range []string{"", "partNumber=1"} {
		target := "http://front/" + bucket + "/" + key
		if query != "" {
			target += "?" + query
		}
		request := httptest.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		recorder := httptest.NewRecorder()
		front.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("GET ?%s answered %d", query, recorder.Code)
		}
		if got := recorder.Header().Get(s3SSEAlgorithmHeader); got != "AES256" {
			t.Fatalf("GET ?%s reports %q, want AES256", query, got)
		}
	}
}

// TestS3FrontMultipartCompletionEmbeddedErrorKeepsTheRecord is the round-6
// residual-4 proof: AWS can answer CompleteMultipartUpload with 200 and an
// <Error> body, and such a completion did not write the object, so the record
// must stay.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html
func TestS3FrontMultipartCompletionEmbeddedErrorKeepsTheRecord(t *testing.T) {
	backend := newFakeS3Proxy()
	front, server := newS3FrontForTest(t, "", backend)
	client := s3ClientFor(t, server.URL)
	ctx := context.Background()
	const bucket, key = "bucket", "multipart/embedded-error"

	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(bucket), Key: aws.String(key), Body: strings.NewReader("original"),
		ServerSideEncryption: s3types.ServerSideEncryptionAes256,
	}); err != nil {
		t.Fatalf("put with SSE-S3: %v", err)
	}
	create, err := client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: aws.String(bucket), Key: aws.String(key),
	})
	if err != nil {
		t.Fatalf("create the multipart upload: %v", err)
	}
	part, err := client.UploadPart(ctx, &s3.UploadPartInput{
		Bucket: aws.String(bucket), Key: aws.String(key), UploadId: create.UploadId,
		PartNumber: aws.Int32(1), Body: strings.NewReader("new-body"),
	})
	if err != nil {
		t.Fatalf("upload the part: %v", err)
	}
	backend.mu.Lock()
	backend.completeErrors[key] = "InternalError"
	backend.mu.Unlock()
	_, completeErr := client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket: aws.String(bucket), Key: aws.String(key), UploadId: create.UploadId,
		MultipartUpload: &s3types.CompletedMultipartUpload{Parts: []s3types.CompletedPart{
			{ETag: part.ETag, PartNumber: aws.Int32(1)},
		}},
	})
	if completeErr == nil {
		t.Fatal("a 200 response carrying an <Error> body reported success")
	}
	if !strings.Contains(completeErr.Error(), "InternalError") {
		t.Fatalf("unexpected completion error: %v", completeErr)
	}
	if !front.index.has(bucket, key) {
		t.Fatal("a 200-with-error-body completion cleared the SSE-S3 record")
	}
	head, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil {
		t.Fatalf("head after the failed completion: %v", err)
	}
	if head.ServerSideEncryption != s3types.ServerSideEncryptionAes256 {
		t.Fatalf("after the failed completion HEAD reports %q, want AES256", head.ServerSideEncryption)
	}
}

func TestS3FrontCanonicalHelpers(t *testing.T) {
	if got := s3CanonicalURI(&url.URL{}); got != "/" {
		t.Fatalf("empty canonical URI %q", got)
	}
	if got := s3CanonicalURI(&url.URL{Path: "/a b/key=1"}); got != "/a%20b/key=1" {
		t.Fatalf("canonical URI %q", got)
	}
	query := url.Values{"b": {"2", "1"}, "a": {"x y", "plus+", "ü"}}
	if got, want := s3CanonicalQuery(query), "a=%C3%BC&a=plus%2B&a=x%20y&b=1&b=2"; got != want {
		t.Fatalf("canonical query %q, want %q", got, want)
	}
	if got, want := s3URIEncode("A-z 0/9+~"), "A-z%200%2F9%2B~"; got != want {
		t.Fatalf("URI encode %q, want %q", got, want)
	}
	request := &http.Request{Host: "front", Header: http.Header{"X-Multi": {"a  b", "c"}}}
	if got, want := s3CanonicalHeaders(request, []string{"host", "x-multi"}), "host:front\nx-multi:a b,c\n"; got != want {
		t.Fatalf("canonical headers %q, want %q", got, want)
	}
	length := &http.Request{Host: "front", ContentLength: 12, Header: http.Header{}}
	if got, want := s3CanonicalHeaders(length, []string{"content-length"}), "content-length:12\n"; got != want {
		t.Fatalf("content-length canonical header %q, want %q", got, want)
	}
	length.Header.Set("Content-Length", "7")
	if got, want := s3CanonicalHeaders(length, []string{"content-length"}), "content-length:7\n"; got != want {
		t.Fatalf("header content-length %q, want %q", got, want)
	}
	recorder := httptest.NewRecorder()
	writeS3FrontError(recorder, http.StatusForbidden, "SignatureDoesNotMatch", "a < b")
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "a &lt; b") {
		t.Fatalf("error document %d %q", recorder.Code, recorder.Body.String())
	}
}
