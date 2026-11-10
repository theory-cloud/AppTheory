package localrunner

import (
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newVersionedFrontAt is newVersionedFront with a persistent data directory, so
// the tests can reopen the same version log the way a restarted run does.
func newVersionedFrontAt(t *testing.T, dataDir string, upstream *fakeS3VersionUpstream) *s3Front {
	t.Helper()
	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)
	front, err := newS3Front(dataDir, server.URL, t.Logf)
	if err != nil {
		t.Fatalf("newS3Front: %v", err)
	}
	return front
}

// TestVersionStorePersistsAcrossAFrontRestart covers the file-backed log: the
// version ids a run issued stay readable after the front reopens, deleting a
// version reconciles the live object to the new latest (restoring it from the
// archive when needed), and deleting the bucket forgets the history.
func TestVersionStorePersistsAcrossAFrontRestart(t *testing.T) {
	upstream := newFakeS3VersionUpstream()
	dataDir := t.TempDir()
	front := newVersionedFrontAt(t, dataDir, upstream)
	if err := front.versions.setEnabled("bucket", true); err != nil {
		t.Fatalf("setEnabled: %v", err)
	}
	first := frontRequest(t, front, http.MethodPut, "/bucket/doc.md", "first body", nil)
	second := frontRequest(t, front, http.MethodPut, "/bucket/doc.md", "second body", nil)
	firstID := first.Header().Get("x-amz-version-id")
	secondID := second.Header().Get("x-amz-version-id")
	if firstID == "" || secondID == "" || firstID == secondID {
		t.Fatalf("version ids = %q and %q", firstID, secondID)
	}

	// A new front over the same directory serves both versions from the log.
	reopened := newVersionedFrontAt(t, dataDir, upstream)
	for id, want := range map[string]string{firstID: "first body", secondID: "second body"} {
		read := frontRequest(t, reopened, http.MethodGet, "/bucket/doc.md?versionId="+id, "", nil)
		if read.Code != http.StatusOK || read.Body.String() != want {
			t.Fatalf("read %s after reopen = %d %q, want %q", id, read.Code, read.Body.String(), want)
		}
	}

	// Deleting the latest version makes the previous one live again: the front
	// restores its bytes into the store.
	remove := frontRequest(t, reopened, http.MethodDelete, "/bucket/doc.md?versionId="+secondID, "", nil)
	if remove.Code != http.StatusNoContent {
		t.Fatalf("delete version = %d %s", remove.Code, remove.Body.String())
	}
	live := frontRequest(t, reopened, http.MethodGet, "/bucket/doc.md", "", nil)
	if live.Code != http.StatusOK || live.Body.String() != "first body" {
		t.Fatalf("live object after deleting the latest version = %d %q", live.Code, live.Body.String())
	}
	if got := live.Header().Get("x-amz-version-id"); got != firstID {
		t.Fatalf("live object version = %q, want %q", got, firstID)
	}

	// Deleting the bucket forgets the whole history, files included.
	if bucket := frontRequest(t, reopened, http.MethodDelete, "/bucket", "", nil); bucket.Code != http.StatusOK {
		t.Fatalf("delete bucket = %d %s", bucket.Code, bucket.Body.String())
	}
	if reopened.versions.enabled("bucket") {
		t.Fatal("the version log survived the bucket deletion")
	}
	if _, err := os.Stat(filepath.Join(dataDir, "s3versions", "blobs", "bucket")); !os.IsNotExist(err) {
		t.Fatalf("the archived bytes survived the bucket deletion: %v", err)
	}
}

// TestVersionListingPagesByMarker covers the documented key-marker /
// version-id-marker paging.
func TestVersionListingPagesByMarker(t *testing.T) {
	upstream := newFakeS3VersionUpstream()
	front, _ := newVersionedFront(t, upstream)
	if err := front.versions.setEnabled("bucket", true); err != nil {
		t.Fatalf("setEnabled: %v", err)
	}
	for _, key := range []string{"a.md", "b.md", "c.md"} {
		if put := frontRequest(t, front, http.MethodPut, "/bucket/"+key, key, nil); put.Code != http.StatusOK {
			t.Fatalf("put %s = %d", key, put.Code)
		}
	}
	page := frontRequest(t, front, http.MethodGet, "/bucket?versions&max-keys=1", "", nil)
	var first struct {
		IsTruncated         bool   `xml:"IsTruncated"`
		NextKeyMarker       string `xml:"NextKeyMarker"`
		NextVersionIdMarker string `xml:"NextVersionIdMarker"`
		Versions            []struct {
			Key string `xml:"Key"`
		} `xml:"Version"`
	}
	if err := xml.Unmarshal(page.Body.Bytes(), &first); err != nil {
		t.Fatalf("parse first page: %v", err)
	}
	if !first.IsTruncated || first.NextKeyMarker != "a.md" || len(first.Versions) != 1 {
		t.Fatalf("first page = %+v", first)
	}
	next := frontRequest(
		t, front, http.MethodGet,
		"/bucket?versions&max-keys=1&key-marker="+first.NextKeyMarker+"&version-id-marker="+first.NextVersionIdMarker,
		"", nil)
	var second struct {
		Versions []struct {
			Key string `xml:"Key"`
		} `xml:"Version"`
	}
	if err := xml.Unmarshal(next.Body.Bytes(), &second); err != nil {
		t.Fatalf("parse second page: %v", err)
	}
	if len(second.Versions) != 1 || second.Versions[0].Key != "b.md" {
		t.Fatalf("second page = %+v", second)
	}
}

// TestVersionedFrontRefusals covers the named true limits and the delete-marker
// read.
func TestVersionedFrontRefusals(t *testing.T) {
	upstream := newFakeS3VersionUpstream()
	front, _ := newVersionedFront(t, upstream)
	if err := front.versions.setEnabled("bucket", true); err != nil {
		t.Fatalf("setEnabled: %v", err)
	}
	put := frontRequest(t, front, http.MethodPut, "/bucket/doc.md", "body", nil)
	versionID := put.Header().Get("x-amz-version-id")
	remove := frontRequest(t, front, http.MethodDelete, "/bucket/doc.md", "", nil)
	markerID := remove.Header().Get("x-amz-version-id")
	readMarker := frontRequest(t, front, http.MethodGet, "/bucket/doc.md?versionId="+markerID, "", nil)
	if readMarker.Code != http.StatusMethodNotAllowed || readMarker.Header().Get("x-amz-delete-marker") != "true" {
		t.Fatalf("read of a delete marker = %d %v", readMarker.Code, readMarker.Header())
	}
	copyVersion := frontRequest(t, front, http.MethodPut, "/bucket/copy.md", "", map[string]string{
		"x-amz-copy-source": "/bucket/doc.md?versionId=" + versionID,
	})
	if copyVersion.Code != http.StatusNotImplemented {
		t.Fatalf("copy from a version = %d, want the named 501", copyVersion.Code)
	}
	unknown := frontRequest(t, front, http.MethodGet, "/bucket/doc.md?versionId=missing", "", nil)
	if unknown.Code != http.StatusNotFound || !strings.Contains(unknown.Body.String(), "NoSuchVersion") {
		t.Fatalf("unknown version = %d %s", unknown.Code, unknown.Body.String())
	}
}

// TestParseS3RangeShapes covers the range shapes GetObject documents and the
// malformed ones it refuses.
func TestParseS3RangeShapes(t *testing.T) {
	cases := []struct {
		header            string
		total, start, end int64
		ok                bool
	}{
		{"bytes=0-0", 3, 0, 0, true},
		{"bytes=1-", 5, 1, 4, true},
		{"bytes=2-99", 5, 2, 4, true},
		{"bytes=-2", 5, 3, 4, true},
		{"bytes=-99", 5, 0, 4, true},
		{"bytes=5-", 5, 0, 0, false},
		{"bytes=2-1", 5, 0, 0, false},
		{"bytes=0-1,3-4", 5, 0, 0, false},
		{"bytes=abc-", 5, 0, 0, false},
		{"bytes=0-", 0, 0, 0, false},
		{"items=0-1", 5, 0, 0, false},
		{"bytes=-0", 5, 0, 0, false},
	}
	for _, testCase := range cases {
		start, end, ok := parseS3Range(testCase.header, testCase.total)
		if ok != testCase.ok || (ok && (start != testCase.start || end != testCase.end)) {
			t.Fatalf("parseS3Range(%q, %d) = %d,%d,%v want %d,%d,%v",
				testCase.header, testCase.total, start, end, ok, testCase.start, testCase.end, testCase.ok)
		}
	}
}

// TestVersionStoreRefusesACorruptIndex covers the load-time failures.
func TestVersionStoreRefusesACorruptIndex(t *testing.T) {
	for name, payload := range map[string]string{
		"malformed":   "{",
		"unsupported": `{"version":9}`,
	} {
		dir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(dir, "s3versions", "blobs"), 0o700); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if err := os.WriteFile(filepath.Join(dir, "s3versions", "index.json"), []byte(payload), 0o600); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if _, err := newS3VersionStore(dir); err == nil {
			t.Fatalf("%s index was accepted", name)
		}
	}
}

// TestSafeVersionPathComponent covers the names the store refuses to join into a
// filesystem path.
func TestSafeVersionPathComponent(t *testing.T) {
	for _, name := range []string{"", ".", "..", "a/b", "a b", strings.Repeat("x", 256)} {
		if safeVersionPathComponent(name) {
			t.Fatalf("%q was accepted as a path component", name)
		}
	}
	for _, name := range []string{"bucket", "my-bucket.local", "v0000000000000001", "A_b-9"} {
		if !safeVersionPathComponent(name) {
			t.Fatalf("%q was refused as a path component", name)
		}
	}
}

// TestEmptyVersionedBucketReportsAPagingStore pins the auto-delete leg over a
// store that pages its version listing.
func TestEmptyVersionedBucketReportsAPagingStore(t *testing.T) {
	var pages int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Has("versions") {
			pages++
			if pages == 1 {
				_, _ = writer.Write([]byte(`<ListVersionsResult><Version><Key>a</Key><VersionId>v1</VersionId></Version><DeleteMarker><Key>b</Key><VersionId>v2</VersionId></DeleteMarker><IsTruncated>true</IsTruncated><NextKeyMarker>b</NextKeyMarker><NextVersionIdMarker>v2</NextVersionIdMarker></ListVersionsResult>`)) //nolint:errcheck // the test's stand-in store
				return
			}
			_, _ = writer.Write([]byte(`<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>`)) //nolint:errcheck // the test's stand-in store
			return
		}
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	runner := &Runner{options: Options{Stdout: io.Discard}, s3Front: &s3Front{versions: &s3VersionStore{buckets: map[string]*s3BucketVersions{"bucket": {Enabled: true}}}}}
	verdict, err := runner.emptyVersionedBucket(t.Context(), newS3Client(server.URL), CustomResourceSpec{LogicalID: "AutoDelete"}, "bucket")
	if err != nil {
		t.Fatalf("emptyVersionedBucket: %v", err)
	}
	if pages != 2 || verdict["deletedObjects"] != 2 {
		t.Fatalf("pages = %d, verdict = %v", pages, verdict)
	}
	if fmt.Sprint(verdict["physicalResourceId"]) != "bucket" {
		t.Fatalf("verdict = %v", verdict)
	}
}
