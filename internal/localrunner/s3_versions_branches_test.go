package localrunner

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestVersionedBucketDeletionForgetsTheLog covers the proxied bucket delete:
// the front clears the version log with the store's own delete.
func TestVersionedBucketDeletionForgetsTheLog(t *testing.T) {
	upstream := newFakeS3VersionUpstream()
	dataDir := t.TempDir()
	front := newVersionedFrontAt(t, dataDir, upstream)
	if err := front.versions.setEnabled("bucket", true); err != nil {
		t.Fatalf("setEnabled: %v", err)
	}
	if put := frontRequest(t, front, http.MethodPut, "/bucket/doc.md", "body", nil); put.Code != http.StatusOK {
		t.Fatalf("put = %d", put.Code)
	}
	if bucket := frontRequest(t, front, http.MethodDelete, "/bucket", "", nil); bucket.Code != http.StatusOK {
		t.Fatalf("delete bucket = %d %s", bucket.Code, bucket.Body.String())
	}
	if front.versions.enabled("bucket") {
		t.Fatal("the version log survived the bucket deletion")
	}
	if _, err := os.Stat(filepath.Join(dataDir, "s3versions", "blobs", "bucket")); !os.IsNotExist(err) {
		t.Fatalf("the archived bytes survived the bucket deletion: %v", err)
	}
}

// TestVersioningConfigurationBranches covers the configuration API's refusals
// and the unversioned bucket's unchanged path.
func TestVersioningConfigurationBranches(t *testing.T) {
	upstream := newFakeS3VersionUpstream()
	front, _ := newVersionedFront(t, upstream)
	unversionedGet := frontRequest(t, front, http.MethodGet, "/bucket?versioning", "", nil)
	unversionedPut := frontRequest(t, front, http.MethodPut, "/bucket?versioning", `<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>`, nil)
	if unversionedGet.Code != http.StatusNotImplemented || unversionedPut.Code != http.StatusNotImplemented {
		t.Fatalf("an unversioned bucket's versioning calls = %d/%d, want the store's 501", unversionedGet.Code, unversionedPut.Code)
	}
	if err := front.versions.setEnabled("bucket", true); err != nil {
		t.Fatalf("setEnabled: %v", err)
	}
	malformed := frontRequest(t, front, http.MethodPut, "/bucket?versioning", `not xml`, nil)
	if malformed.Code != http.StatusBadRequest || !strings.Contains(malformed.Body.String(), "MalformedXML") {
		t.Fatalf("malformed configuration = %d %s", malformed.Code, malformed.Body.String())
	}
	unknown := frontRequest(t, front, http.MethodPut, "/bucket?versioning", `<VersioningConfiguration><Status>Bogus</Status></VersioningConfiguration>`, nil)
	if unknown.Code != http.StatusBadRequest || !strings.Contains(unknown.Body.String(), "MalformedXML") {
		t.Fatalf("unknown status = %d %s", unknown.Code, unknown.Body.String())
	}
}

// TestVersionListingPrefixAndInvalidMaxKeys covers the listing filters.
func TestVersionListingPrefixAndInvalidMaxKeys(t *testing.T) {
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
	prefixed := frontRequest(t, front, http.MethodGet, "/bucket?versions&prefix=b", "", nil)
	if !strings.Contains(prefixed.Body.String(), "<Key>b.md</Key>") || strings.Contains(prefixed.Body.String(), "<Key>a.md</Key>") {
		t.Fatalf("prefix listing = %s", prefixed.Body.String())
	}
	invalid := frontRequest(t, front, http.MethodGet, "/bucket?versions&max-keys=abc", "", nil)
	if invalid.Code != http.StatusOK || !strings.Contains(invalid.Body.String(), "<MaxKeys>1000</MaxKeys>") {
		t.Fatalf("an invalid max-keys = %d %s", invalid.Code, invalid.Body.String())
	}
}

// TestVersionReadOfAMissingBlob covers the stored-version read failure.
func TestVersionReadOfAMissingBlob(t *testing.T) {
	upstream := newFakeS3VersionUpstream()
	dataDir := t.TempDir()
	front := newVersionedFrontAt(t, dataDir, upstream)
	if err := front.versions.setEnabled("bucket", true); err != nil {
		t.Fatalf("setEnabled: %v", err)
	}
	put := frontRequest(t, front, http.MethodPut, "/bucket/doc.md", "body", nil)
	versionID := put.Header().Get("x-amz-version-id")
	blob := filepath.Join(dataDir, "s3versions", "blobs", "bucket", versionID)
	if err := os.Remove(blob); err != nil {
		t.Fatalf("remove blob: %v", err)
	}
	read := frontRequest(t, front, http.MethodGet, "/bucket/doc.md?versionId="+versionID, "", nil)
	if read.Code != http.StatusInternalServerError || !strings.Contains(read.Body.String(), "InternalError") {
		t.Fatalf("read of a missing blob = %d %s", read.Code, read.Body.String())
	}
}

// TestVersionHeadOfADeleteMarker covers HEAD against a marker version.
func TestVersionHeadOfADeleteMarker(t *testing.T) {
	upstream := newFakeS3VersionUpstream()
	front, _ := newVersionedFront(t, upstream)
	if err := front.versions.setEnabled("bucket", true); err != nil {
		t.Fatalf("setEnabled: %v", err)
	}
	if put := frontRequest(t, front, http.MethodPut, "/bucket/doc.md", "body", nil); put.Code != http.StatusOK {
		t.Fatalf("put = %d", put.Code)
	}
	remove := frontRequest(t, front, http.MethodDelete, "/bucket/doc.md", "", nil)
	markerID := remove.Header().Get("x-amz-version-id")
	head := frontRequest(t, front, http.MethodHead, "/bucket/doc.md?versionId="+markerID, "", nil)
	if head.Code != http.StatusMethodNotAllowed || head.Header().Get("x-amz-delete-marker") != "true" {
		t.Fatalf("head of a delete marker = %d %v", head.Code, head.Header())
	}
}

// TestDeployTimeEnvironmentEdges covers the malformed and non-function edges the
// closure skips.
func TestDeployTimeEnvironmentEdges(t *testing.T) {
	stack := assemblyStack{
		Name: "Stack",
		Template: template{Resources: map[string]templateResource{
			"Fn":    {Type: typeLambdaFunction, Properties: []byte(`{"Environment":{"Variables":{"BAD":42,"OTHER":"x"}}}`)},
			"Other": {Type: "AWS::SNS::Topic", Properties: []byte(`{"DisplayName":{"Ref":"Fn"}}`)},
		}},
	}
	stacks := []assemblyStack{stack}
	if refs := environmentFunctionRefs([]byte(`not json`), stack, stacks); refs != nil {
		t.Fatalf("malformed properties = %v", refs)
	}
	if refs := environmentFunctionRefs(stack.Template.Resources["Fn"].Properties, stack, stacks); len(refs) != 0 {
		t.Fatalf("an environment with no Lambda reference = %v", refs)
	}
	if refs := lambdaFunctionRefs(stack.Template.Resources["Other"].Properties, stack, stacks); len(refs) != 1 {
		t.Fatalf("a Ref to a Lambda function = %v", refs)
	}
	if got := deployTimeClosure(stacks, []string{"Missing"}); len(got) != 0 {
		t.Fatalf("a closure over unknown seeds = %v", got)
	}
}
