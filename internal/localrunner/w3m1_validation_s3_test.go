package localrunner

import (
	"context"
	"crypto/md5" //nolint:gosec // the test compares the S3 integrity digest
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// LOCAL-W3-M1 validation, ninth pass: the S3 front's SSE index, signature
// refusals and body-hash path.

func TestS3SSEIndexPersistsAndRefusesACorruptFile(t *testing.T) {
	dir := t.TempDir()
	index, err := newS3SSEIndex(dir)
	if err != nil {
		t.Fatalf("newS3SSEIndex: %v", err)
	}
	if setErr := index.set("bucket", "key"); setErr != nil {
		t.Fatalf("set: %v", setErr)
	}
	if !index.has("bucket", "key") {
		t.Fatal("the entry must be recorded")
	}
	if setErr := index.set("bucket", "key"); setErr != nil {
		t.Fatalf("a repeated set is a no-op: %v", setErr)
	}

	// A new index over the same directory reads the persisted entries.
	reloaded, err := newS3SSEIndex(dir)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if !reloaded.has("bucket", "key") {
		t.Fatal("the index must persist across runs")
	}

	// A corrupt index file fails closed rather than dropping the record.
	corruptDir := t.TempDir()
	sseDir := filepath.Join(corruptDir, "s3sse")
	if err := os.MkdirAll(sseDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sseDir, s3FrontIndexFile), []byte("not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := newS3SSEIndex(corruptDir); err == nil {
		t.Fatal("a corrupt index must be refused")
	}
	if err := os.WriteFile(filepath.Join(sseDir, s3FrontIndexFile), []byte(`{"version":1,"objects":["bucket/key"]}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := newS3SSEIndex(corruptDir); err != nil {
		t.Fatalf("a valid index must load: %v", err)
	}
}

func TestS3FrontVerifySigV4Refusals(t *testing.T) {
	front, err := newS3Front(t.TempDir(), "http://127.0.0.1:1", func(string, ...any) {})
	if err != nil {
		t.Fatalf("newS3Front: %v", err)
	}
	scope := func(service, date string) string {
		return front.credentials.AccessKeyID + "/" + date + "/" + LocalRegion + "/" + service + "/" + sigV4Terminator
	}
	request := func(authorization string) *http.Request {
		value := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://127.0.0.1/bucket/key", nil)
		value.Header.Set("Authorization", authorization)
		return value
	}
	// An unsigned request is forwarded as it arrived; verifySigV4 accepts it.
	if err := front.verifySigV4(request("")); err != nil {
		t.Fatalf("an unsigned request must be forwarded: %v", err)
	}
	cases := []struct {
		name string
		req  *http.Request
		want string
	}{
		{"another algorithm", request("AWS4-HMAC-SHA1 Credential=x"), "Signature Version 4"},
		{"short scope", request(sigV4Authorization("key/date", "host", "00")), "not signed for the local identity"},
		{"another access key", request(sigV4Authorization("OTHER/20261108/us-east-1/s3/aws4_request", "host", "00")), "not signed for the local identity"},
		{"another service", request(sigV4Authorization(scope("execute-api", "20261108"), "host", "00")), "not signed for the s3 service"},
	}
	for _, tc := range cases {
		if err := front.verifySigV4(tc.req); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s = %v, want %q", tc.name, err, tc.want)
		}
	}

	// A complete header set with a wrong signature reaches the comparison.
	requestWithDate := request(sigV4Authorization(scope("s3", "20261108"), "host;x-amz-date", "00"))
	requestWithDate.Header.Set("X-Amz-Date", "20261108T000000Z")
	if err := front.verifySigV4(requestWithDate); err == nil {
		t.Fatal("a wrong signature must be refused")
	}
	// A date and a scope that disagree are named.
	disagreeing := request(sigV4Authorization(scope("s3", "20261108"), "host;x-amz-date", "00"))
	disagreeing.Header.Set("X-Amz-Date", "20261109T000000Z")
	if err := front.verifySigV4(disagreeing); err == nil || !strings.Contains(err.Error(), "disagree") {
		t.Fatalf("a date mismatch must be named: %v", err)
	}
	// A date outside the signing window is named.
	stale := request(sigV4Authorization(scope("s3", "20250101"), "host;x-amz-date", "00"))
	stale.Header.Set("X-Amz-Date", "20250101T000000Z")
	if err := front.verifySigV4(stale); err == nil || !strings.Contains(err.Error(), "15-minute") {
		t.Fatalf("a stale date must be named: %v", err)
	}
	// No date at all is named.
	noDate := request(sigV4Authorization(scope("s3", "20261108"), "host", "00"))
	if err := front.verifySigV4(noDate); err == nil || !strings.Contains(err.Error(), "no X-Amz-Date") {
		t.Fatalf("a missing date must be named: %v", err)
	}
}

func TestS3FrontResignReadsTheBodyWhenNoHashIsCarried(t *testing.T) {
	front, err := newS3Front(t.TempDir(), "http://127.0.0.1:1", func(string, ...any) {})
	if err != nil {
		t.Fatalf("newS3Front: %v", err)
	}
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://127.0.0.1/bucket/key",
		strings.NewReader(`{"a":1}`))
	request.Header.Set("Authorization", sigV4Authorization("dummy/20261108/us-east-1/s3/aws4_request", "host", "00"))
	if err := front.resign(request); err != nil {
		t.Fatalf("resign: %v", err)
	}
	if !strings.HasPrefix(request.Header.Get("Authorization"), sigV4AuthorizationPrefix) {
		t.Fatalf("the request must be signed: %q", request.Header.Get("Authorization"))
	}
	if request.Header.Get("X-Amz-Content-Sha256") == "" {
		t.Fatal("the payload hash must be recorded")
	}

	// A body over the re-sign bound is refused rather than truncated.
	large := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://127.0.0.1/bucket/key",
		strings.NewReader(strings.Repeat("x", s3FrontMaxBody+1)))
	large.Header.Set("Authorization", sigV4Authorization("dummy/20261108/us-east-1/s3/aws4_request", "host", "00"))
	if err := front.resign(large); err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Fatalf("an oversized body must be refused: %v", err)
	}
}

func TestS3SSEIndexFileShape(t *testing.T) {
	dir := t.TempDir()
	index, err := newS3SSEIndex(dir)
	if err != nil {
		t.Fatalf("newS3SSEIndex: %v", err)
	}
	if setErr := index.set("bucket", "key"); setErr != nil {
		t.Fatalf("set: %v", setErr)
	}
	payload, err := os.ReadFile(filepath.Join(dir, "s3sse", s3FrontIndexFile)) //nolint:gosec // the test owns the directory
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var document struct {
		Version int      `json:"version"`
		Objects []string `json:"objects"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if document.Version != 1 || len(document.Objects) != 1 {
		t.Fatalf("the index file is %+v", document)
	}
}

func TestApplyDeleteObjectsDigestRestoresTheMD5Header(t *testing.T) {
	body := "<Delete><Object><Key>a</Key></Object></Delete>"
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost,
		"http://127.0.0.1/bucket?delete", strings.NewReader(body))
	request.Header.Set("X-Amz-Sdk-Checksum-Algorithm", "CRC32")
	if err := applyDeleteObjectsDigest(request); err != nil {
		t.Fatalf("applyDeleteObjectsDigest: %v", err)
	}
	sum := md5.Sum([]byte(body)) //nolint:gosec // the test compares the S3 integrity digest
	if got := request.Header.Get("Content-Md5"); got != base64.StdEncoding.EncodeToString(sum[:]) {
		t.Fatalf("Content-MD5 = %q", got)
	}
	restored, err := io.ReadAll(request.Body)
	if err != nil {
		t.Fatalf("read the restored body: %v", err)
	}
	if string(restored) != body || request.ContentLength != int64(len(body)) {
		t.Fatalf("the body must be restored: %q length=%d", restored, request.ContentLength)
	}

	// An existing digest is left alone.
	kept := httptest.NewRequestWithContext(context.Background(), http.MethodPost,
		"http://127.0.0.1/bucket?delete", strings.NewReader(body))
	kept.Header.Set("Content-Md5", "given")
	if err := applyDeleteObjectsDigest(kept); err != nil {
		t.Fatalf("an existing digest must be kept: %v", err)
	}
	if got := kept.Header.Get("Content-Md5"); got != "given" {
		t.Fatalf("Content-MD5 = %q", got)
	}

	// Another operation and another method are untouched.
	other := httptest.NewRequestWithContext(context.Background(), http.MethodPost,
		"http://127.0.0.1/bucket", strings.NewReader(body))
	if err := applyDeleteObjectsDigest(other); err != nil || other.Header.Get("Content-Md5") != "" {
		t.Fatalf("a non-delete POST must be untouched: %v", err)
	}
	put := httptest.NewRequestWithContext(context.Background(), http.MethodPut,
		"http://127.0.0.1/bucket?delete", strings.NewReader(body))
	if err := applyDeleteObjectsDigest(put); err != nil || put.Header.Get("Content-Md5") != "" {
		t.Fatalf("a PUT must be untouched: %v", err)
	}

	// A body over the digest bound is refused rather than truncated.
	large := httptest.NewRequestWithContext(context.Background(), http.MethodPost,
		"http://127.0.0.1/bucket?delete", strings.NewReader(strings.Repeat("x", s3FrontDeleteObjectsMaxBody+1)))
	if err := applyDeleteObjectsDigest(large); err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Fatalf("an oversized body must be refused: %v", err)
	}
}
