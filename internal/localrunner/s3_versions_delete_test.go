package localrunner

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestVersionedDeleteRefusalsAndIdempotentDeletes covers the delete API's
// refusals and the no-op a repeated version delete is.
func TestVersionedDeleteRefusalsAndIdempotentDeletes(t *testing.T) {
	upstream := newFakeS3VersionUpstream()
	front, _ := newVersionedFront(t, upstream)
	if err := front.versions.setEnabled("bucket", true); err != nil {
		t.Fatalf("setEnabled: %v", err)
	}
	missing := frontRequest(t, front, http.MethodDelete, "/bucket/doc.md?versionId=missing", "", nil)
	if missing.Code != http.StatusNotFound || !strings.Contains(missing.Body.String(), "NoSuchVersion") {
		t.Fatalf("delete of an unknown version = %d %s", missing.Code, missing.Body.String())
	}
	first := frontRequest(t, front, http.MethodPut, "/bucket/doc.md", "one", nil)
	second := frontRequest(t, front, http.MethodPut, "/bucket/doc.md", "two", nil)
	body := "<Delete>" +
		"<Object><Key>doc.md</Key><VersionId>" + first.Header().Get("x-amz-version-id") + "</VersionId></Object>" +
		"<Object><Key>doc.md</Key><VersionId>missing</VersionId></Object>" +
		"</Delete>"
	remove := frontRequest(t, front, http.MethodPost, "/bucket?delete", body, nil)
	if remove.Code < 200 || remove.Code >= 300 {
		t.Fatalf("delete objects = %d %s", remove.Code, remove.Body.String())
	}
	live := frontRequest(t, front, http.MethodGet, "/bucket/doc.md", "", nil)
	if live.Code != http.StatusOK || live.Body.String() != "two" {
		t.Fatalf("live object after the purge = %d %q", live.Code, live.Body.String())
	}
	if got := live.Header().Get("x-amz-version-id"); got != second.Header().Get("x-amz-version-id") {
		t.Fatalf("live version = %q", got)
	}
}

// TestEmptyVersionedBucketReportsListingErrors covers the auto-delete leg's
// failure when the store cannot list the versions.
func TestEmptyVersionedBucketReportsListingErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	runner := &Runner{s3Front: &s3Front{versions: &s3VersionStore{buckets: map[string]*s3BucketVersions{"bucket": {Enabled: true}}}}}
	if _, err := runner.emptyVersionedBucket(t.Context(), newS3Client(server.URL), CustomResourceSpec{LogicalID: "AutoDelete"}, "bucket"); err == nil {
		t.Fatal("a failing version listing was reported as success")
	}
}

// TestVersionStoreListBounds covers the page-size clamp and an unknown bucket.
func TestVersionStoreListBounds(t *testing.T) {
	store := &s3VersionStore{buckets: map[string]*s3BucketVersions{}}
	if listed := store.list("missing", "", 0); listed != nil {
		t.Fatalf("an unknown bucket listed %v", listed)
	}
	if err := store.setEnabled("bucket", true); err != nil {
		t.Fatalf("setEnabled: %v", err)
	}
	if err := store.append("bucket", s3Version{VersionID: "v1", Key: "a.md"}); err != nil {
		t.Fatalf("append: %v", err)
	}
	for _, maxKeys := range []int{-1, 0, 2000} {
		if listed := store.list("bucket", "", maxKeys); len(listed) != 1 {
			t.Fatalf("list with max-keys %d = %v", maxKeys, listed)
		}
	}
}
