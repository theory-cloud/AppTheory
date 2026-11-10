package localrunner

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// failingDeleteUpstream refuses every object delete, so the version front's
// live-object reconciliation fails after it has already removed the version.
type failingDeleteUpstream struct{ *fakeS3VersionUpstream }

func (u failingDeleteUpstream) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodDelete && request.URL.Path != "/bucket" {
		writer.WriteHeader(http.StatusInternalServerError)
		return
	}
	u.fakeS3VersionUpstream.ServeHTTP(writer, request)
}

// TestVersionDeleteReconcileFailureIsReported covers the logged reconcile
// failure: the version delete itself still answers 204.
func TestVersionDeleteReconcileFailureIsReported(t *testing.T) {
	upstream := failingDeleteUpstream{fakeS3VersionUpstream: newFakeS3VersionUpstream()}
	server := httptest.NewServer(upstream)
	defer server.Close()
	front, err := newS3Front(t.TempDir(), server.URL, t.Logf)
	if err != nil {
		t.Fatalf("newS3Front: %v", err)
	}
	if enableErr := front.versions.setEnabled("bucket", true); enableErr != nil {
		t.Fatalf("setEnabled: %v", enableErr)
	}
	put := frontRequest(t, front, http.MethodPut, "/bucket/doc.md", "body", nil)
	versionID := put.Header().Get("x-amz-version-id")
	remove := frontRequest(t, front, http.MethodDelete, "/bucket/doc.md?versionId="+versionID, "", nil)
	if remove.Code != http.StatusNoContent {
		t.Fatalf("delete version = %d %s", remove.Code, remove.Body.String())
	}
}

// TestVersionListingKeyMarkerWithoutVersionMarker covers the documented marker
// shape that skips a whole key.
func TestVersionListingKeyMarkerWithoutVersionMarker(t *testing.T) {
	upstream := newFakeS3VersionUpstream()
	front, _ := newVersionedFront(t, upstream)
	if err := front.versions.setEnabled("bucket", true); err != nil {
		t.Fatalf("setEnabled: %v", err)
	}
	for _, key := range []string{"a.md", "b.md"} {
		if put := frontRequest(t, front, http.MethodPut, "/bucket/"+key, key, nil); put.Code != http.StatusOK {
			t.Fatalf("put %s = %d", key, put.Code)
		}
	}
	page := frontRequest(t, front, http.MethodGet, "/bucket?versions&key-marker=a.md", "", nil)
	if strings.Contains(page.Body.String(), "<Key>a.md</Key>") || !strings.Contains(page.Body.String(), "<Key>b.md</Key>") {
		t.Fatalf("key-marker page = %s", page.Body.String())
	}
}
