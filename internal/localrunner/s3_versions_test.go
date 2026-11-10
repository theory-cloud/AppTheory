package localrunner

import (
	"crypto/md5" //nolint:gosec // S3's ETag is an MD5 of the object
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeS3VersionUpstream is a minimal s3proxy stand-in: it stores object bytes,
// answers object reads, and refuses both versioning APIs with 501, which is what
// the pinned s3proxy does (the front must answer them itself).
type fakeS3VersionUpstream struct {
	mu       sync.Mutex
	objects  map[string][]byte
	etags    map[string]string
	modified map[string]time.Time
}

func newFakeS3VersionUpstream() *fakeS3VersionUpstream {
	return &fakeS3VersionUpstream{objects: map[string][]byte{}, etags: map[string]string{}, modified: map[string]time.Time{}}
}

func (u *fakeS3VersionUpstream) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	// The pinned s3proxy hashes every v4 request body and compares the digest
	// with x-amz-content-sha256; a request without the header is refused with
	// XAmzContentSHA256Mismatch rather than treated as unsigned. The front
	// builds its own reads, restores and reconciliations, so it must send the
	// header on every one of them.
	// https://github.com/gaul/s3proxy/blob/master/src/main/java/org/gaul/s3proxy/S3ProxyHandler.java
	if request.Header.Get("Authorization") != "" && request.Header.Get("X-Amz-Content-Sha256") == "" {
		writer.WriteHeader(http.StatusBadRequest)
		_, _ = writer.Write([]byte(`<Error><Code>XAmzContentSHA256Mismatch</Code><Message>The provided 'x-amz-content-sha256' header does not match what was computed.</Message></Error>`)) //nolint:errcheck // the test's stand-in store
		return
	}
	trimmed := strings.TrimPrefix(request.URL.Path, "/")
	bucket, key, _ := strings.Cut(trimmed, "/")
	u.mu.Lock()
	defer u.mu.Unlock()
	if key == "" {
		if request.URL.Query().Has("versioning") || request.URL.Query().Has("versions") {
			writer.WriteHeader(http.StatusNotImplemented)
			_, _ = writer.Write([]byte(`<Error><Code>NotImplemented</Code><Message>Versioning is not supported.</Message></Error>`)) //nolint:errcheck // the test's stand-in store
			return
		}
		writer.WriteHeader(http.StatusOK)
		return
	}
	objectKey := bucket + "/" + key
	switch request.Method {
	case http.MethodPut:
		payload, _ := io.ReadAll(request.Body) //nolint:errcheck // the test's stand-in store
		u.objects[objectKey] = payload
		sum := md5.Sum(payload) //nolint:gosec // S3's ETag is an MD5 of the object
		u.etags[objectKey] = `"` + hex.EncodeToString(sum[:]) + `"`
		u.modified[objectKey] = time.Now().UTC()
		writer.Header().Set("ETag", u.etags[objectKey])
		writer.WriteHeader(http.StatusOK)
	case http.MethodGet, http.MethodHead:
		payload, ok := u.objects[objectKey]
		if !ok {
			writer.WriteHeader(http.StatusNotFound)
			_, _ = writer.Write([]byte(`<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>`)) //nolint:errcheck // the test's stand-in store
			return
		}
		writer.Header().Set("ETag", u.etags[objectKey])
		writer.Header().Set("Last-Modified", u.modified[objectKey].Format(http.TimeFormat))
		writer.Header().Set("Content-Type", "text/markdown")
		writer.Header().Set("Content-Length", fmt.Sprint(len(payload)))
		writer.WriteHeader(http.StatusOK)
		if request.Method == http.MethodGet {
			_, _ = writer.Write(payload) //nolint:errcheck // the test's stand-in store
		}
	case http.MethodDelete:
		delete(u.objects, objectKey)
		delete(u.etags, objectKey)
		delete(u.modified, objectKey)
		writer.WriteHeader(http.StatusNoContent)
	default:
		writer.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func newVersionedFront(t *testing.T, upstream *fakeS3VersionUpstream) (*s3Front, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)
	front, err := newS3Front("", server.URL, t.Logf)
	if err != nil {
		t.Fatalf("newS3Front: %v", err)
	}
	return front, server
}

func frontRequest(t *testing.T, front *s3Front, method, target string, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequestWithContext(t.Context(), method, target, reader)
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	front.ServeHTTP(recorder, request)
	return recorder
}

// TestVersionedBucketReturnsDistinctVersionIDs is the X6a proving row at the
// unit level: two puts yield two distinct version ids, both readable by id.
func TestVersionedBucketReturnsDistinctVersionIDs(t *testing.T) {
	upstream := newFakeS3VersionUpstream()
	front, _ := newVersionedFront(t, upstream)
	if err := front.versions.setEnabled("bucket", true); err != nil {
		t.Fatalf("setEnabled: %v", err)
	}
	first := frontRequest(t, front, http.MethodPut, "/bucket/doc.md", "first body", nil)
	if first.Code != http.StatusOK {
		t.Fatalf("first put = %d %s", first.Code, first.Body.String())
	}
	firstID := first.Header().Get("x-amz-version-id")
	second := frontRequest(t, front, http.MethodPut, "/bucket/doc.md", "second body", nil)
	if second.Code != http.StatusOK {
		t.Fatalf("second put = %d %s", second.Code, second.Body.String())
	}
	secondID := second.Header().Get("x-amz-version-id")
	if firstID == "" || secondID == "" || firstID == secondID {
		t.Fatalf("version ids = %q and %q, want two distinct ids", firstID, secondID)
	}
	for id, want := range map[string]string{firstID: "first body", secondID: "second body"} {
		read := frontRequest(t, front, http.MethodGet, "/bucket/doc.md?versionId="+id, "", nil)
		if read.Code != http.StatusOK || read.Body.String() != want {
			t.Fatalf("read %s = %d %q, want %q", id, read.Code, read.Body.String(), want)
		}
		if got := read.Header().Get("x-amz-version-id"); got != id {
			t.Fatalf("read %s has version header %q", id, got)
		}
		head := frontRequest(t, front, http.MethodHead, "/bucket/doc.md?versionId="+id, "", nil)
		if head.Code != http.StatusOK || head.Header().Get("Content-Length") != fmt.Sprint(len(want)) {
			t.Fatalf("head %s = %d %v", id, head.Code, head.Header())
		}
	}
	latest := frontRequest(t, front, http.MethodGet, "/bucket/doc.md", "", nil)
	if latest.Body.String() != "second body" || latest.Header().Get("x-amz-version-id") != secondID {
		t.Fatalf("latest read = %q %v", latest.Body.String(), latest.Header())
	}
}

// TestUnversionedBucketKeepsTodaysBehaviour pins the no-regression half: no
// version header, no archive, and versioning operations still reach the store.
func TestUnversionedBucketKeepsTodaysBehaviour(t *testing.T) {
	upstream := newFakeS3VersionUpstream()
	front, _ := newVersionedFront(t, upstream)
	put := frontRequest(t, front, http.MethodPut, "/bucket/plain.txt", "plain", nil)
	if put.Code != http.StatusOK || put.Header().Get("x-amz-version-id") != "" {
		t.Fatalf("unversioned put = %d %v", put.Code, put.Header())
	}
	read := frontRequest(t, front, http.MethodGet, "/bucket/plain.txt", "", nil)
	if read.Code != http.StatusOK || read.Header().Get("x-amz-version-id") != "" {
		t.Fatalf("unversioned read = %d %v", read.Code, read.Header())
	}
	list := frontRequest(t, front, http.MethodGet, "/bucket?versions", "", nil)
	if list.Code != http.StatusNotImplemented {
		t.Fatalf("an unversioned bucket's version listing must reach the store, got %d", list.Code)
	}
}

// TestDeleteMarkerAndVersionListing covers AWS's delete-marker semantics and
// the synthesized ListObjectVersions document.
func TestDeleteMarkerAndVersionListing(t *testing.T) {
	upstream := newFakeS3VersionUpstream()
	front, _ := newVersionedFront(t, upstream)
	if err := front.versions.setEnabled("bucket", true); err != nil {
		t.Fatalf("setEnabled: %v", err)
	}
	put := frontRequest(t, front, http.MethodPut, "/bucket/doc.md", "kept", nil)
	keptID := put.Header().Get("x-amz-version-id")
	remove := frontRequest(t, front, http.MethodDelete, "/bucket/doc.md", "", nil)
	if remove.Code != http.StatusNoContent {
		t.Fatalf("delete = %d %s", remove.Code, remove.Body.String())
	}
	markerID := remove.Header().Get("x-amz-version-id")
	if markerID == "" || markerID == keptID || remove.Header().Get("x-amz-delete-marker") != "true" {
		t.Fatalf("delete headers = %v", remove.Header())
	}
	missing := frontRequest(t, front, http.MethodGet, "/bucket/doc.md", "", nil)
	if missing.Code != http.StatusNotFound || missing.Header().Get("x-amz-delete-marker") != "true" ||
		missing.Header().Get("x-amz-version-id") != markerID {
		t.Fatalf("read after delete = %d %v", missing.Code, missing.Header())
	}
	previous := frontRequest(t, front, http.MethodGet, "/bucket/doc.md?versionId="+keptID, "", nil)
	if previous.Code != http.StatusOK || previous.Body.String() != "kept" {
		t.Fatalf("previous version = %d %q", previous.Code, previous.Body.String())
	}
	list := frontRequest(t, front, http.MethodGet, "/bucket?versions", "", nil)
	if list.Code != http.StatusOK {
		t.Fatalf("version listing = %d %s", list.Code, list.Body.String())
	}
	var document struct {
		Versions []struct {
			Key       string `xml:"Key"`
			VersionID string `xml:"VersionId"`
			IsLatest  bool   `xml:"IsLatest"`
		} `xml:"Version"`
		Markers []struct {
			Key       string `xml:"Key"`
			VersionID string `xml:"VersionId"`
			IsLatest  bool   `xml:"IsLatest"`
		} `xml:"DeleteMarker"`
	}
	if err := xml.Unmarshal(list.Body.Bytes(), &document); err != nil {
		t.Fatalf("parse listing: %v\n%s", err, list.Body.String())
	}
	if len(document.Versions) != 1 || document.Versions[0].VersionID != keptID || document.Versions[0].IsLatest {
		t.Fatalf("versions = %+v", document.Versions)
	}
	if len(document.Markers) != 1 || document.Markers[0].VersionID != markerID || !document.Markers[0].IsLatest {
		t.Fatalf("markers = %+v", document.Markers)
	}
}

// TestRangeReadByVersionID covers GetObject's documented single-range read.
func TestRangeReadByVersionID(t *testing.T) {
	upstream := newFakeS3VersionUpstream()
	front, _ := newVersionedFront(t, upstream)
	if err := front.versions.setEnabled("bucket", true); err != nil {
		t.Fatalf("setEnabled: %v", err)
	}
	put := frontRequest(t, front, http.MethodPut, "/bucket/doc.md", "0123456789", nil)
	id := put.Header().Get("x-amz-version-id")
	read := frontRequest(t, front, http.MethodGet, "/bucket/doc.md?versionId="+id, "", map[string]string{"Range": "bytes=2-5"})
	if read.Code != http.StatusPartialContent || read.Body.String() != "2345" {
		t.Fatalf("range read = %d %q", read.Code, read.Body.String())
	}
	if got := read.Header().Get("Content-Range"); got != "bytes 2-5/10" {
		t.Fatalf("content range = %q", got)
	}
}

// TestVersioningConfigurationIsServedByTheFront covers the API a function uses
// on a bucket the template enabled, and pins that an unversioned bucket's
// configuration calls still reach the store.
func TestVersioningConfigurationIsServedByTheFront(t *testing.T) {
	upstream := newFakeS3VersionUpstream()
	front, _ := newVersionedFront(t, upstream)
	unversioned := frontRequest(t, front, http.MethodPut, "/bucket?versioning", `<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>`, nil)
	if unversioned.Code != http.StatusNotImplemented {
		t.Fatalf("an unversioned bucket's PutBucketVersioning = %d, want the store's 501", unversioned.Code)
	}
	if err := front.versions.setEnabled("bucket", true); err != nil {
		t.Fatalf("setEnabled: %v", err)
	}
	enable := frontRequest(t, front, http.MethodPut, "/bucket?versioning", `<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>`, nil)
	if enable.Code != http.StatusOK {
		t.Fatalf("enable = %d %s", enable.Code, enable.Body.String())
	}
	read := frontRequest(t, front, http.MethodGet, "/bucket?versioning", "", nil)
	if read.Code != http.StatusOK || !strings.Contains(read.Body.String(), "<Status>Enabled</Status>") {
		t.Fatalf("configuration = %d %s", read.Code, read.Body.String())
	}
	suspended := frontRequest(t, front, http.MethodPut, "/bucket?versioning", `<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>`, nil)
	if suspended.Code != http.StatusNotImplemented {
		t.Fatalf("suspend = %d, want a named 501 limit", suspended.Code)
	}
}

func TestBucketVersioningEnabledReadsTheTemplate(t *testing.T) {
	if !bucketVersioningEnabled([]byte(`{"VersioningConfiguration":{"Status":"Enabled"}}`)) {
		t.Fatal("an Enabled template must be versioned")
	}
	if bucketVersioningEnabled([]byte(`{"VersioningConfiguration":{"Status":"Suspended"}}`)) {
		t.Fatal("a Suspended template is not version-enabled")
	}
	if bucketVersioningEnabled([]byte(`not json`)) {
		t.Fatal("malformed properties are not version-enabled")
	}
}

// TestEmptyAutoDeleteBucketDeletesEveryVersion pins the interaction the CDK
// auto-delete handler depends on: a versioned bucket is emptied by deleting its
// version list, not by plain object deletes that would only add markers.
func TestEmptyAutoDeleteBucketDeletesEveryVersion(t *testing.T) {
	var mu sync.Mutex
	versionDeletes := 0
	plainDeletes := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case request.Method == http.MethodGet && request.URL.Query().Has("versions"):
			_, _ = writer.Write([]byte(`<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` + //nolint:errcheck // the test's stand-in store
				`<Name>bucket</Name><IsTruncated>false</IsTruncated>` +
				`<Version><Key>doc.md</Key><VersionId>v0000000000000001</VersionId><IsLatest>false</IsLatest></Version>` +
				`<Version><Key>doc.md</Key><VersionId>v0000000000000002</VersionId><IsLatest>true</IsLatest></Version>` +
				`<DeleteMarker><Key>gone.md</Key><VersionId>v0000000000000003</VersionId><IsLatest>true</IsLatest></DeleteMarker>` +
				`</ListVersionsResult>`))
		case request.Method == http.MethodDelete:
			if request.URL.Query().Get("versionId") != "" {
				versionDeletes++
			} else {
				plainDeletes++
			}
			writer.WriteHeader(http.StatusNoContent)
		default:
			writer.WriteHeader(http.StatusBadRequest)
		}
	}))
	t.Cleanup(server.Close)

	runner := iamTestRunner(t)
	runner.backends = map[string]backendProcess{
		"s3proxy": {HostURL: server.URL, Endpoints: []Endpoint{{Service: "s3", URL: server.URL}}},
	}
	store := &s3VersionStore{buckets: map[string]*s3BucketVersions{"bucket": {Enabled: true}}, memory: map[string][]byte{}}
	runner.s3Front = &s3Front{versions: store}
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "Stack", LogicalID: "Bucket", Type: typeS3Bucket, Properties: []byte(`{"BucketName":"bucket"}`)},
	}}
	runner.spec = spec
	runner.resourceValues = resourceValues{"Stack/Bucket": {Type: typeS3Bucket, Name: "bucket"}}
	result, err := runner.emptyAutoDeleteBucket(t.Context(), spec, CustomResourceSpec{
		LogicalID: "Auto", Stack: "Stack", Properties: []byte(`{"BucketName":"bucket"}`),
	})
	if err != nil {
		t.Fatalf("emptyAutoDeleteBucket: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if versionDeletes != 3 || plainDeletes != 0 {
		t.Fatalf("deletes: %d versioned, %d plain; want 3 versioned", versionDeletes, plainDeletes)
	}
	if result["deletedObjects"] != 3 {
		t.Fatalf("the delete leg reported %+v", result)
	}
}

// TestVersionedDeleteObjectsDeletesNamedVersions covers the purge shape TMS's
// s3util uses: DeleteObjects entries that name a VersionId remove those
// versions, and emptying a key's history removes the live object too.
func TestVersionedDeleteObjectsDeletesNamedVersions(t *testing.T) {
	upstream := newFakeS3VersionUpstream()
	front, _ := newVersionedFront(t, upstream)
	if err := front.versions.setEnabled("bucket", true); err != nil {
		t.Fatalf("setEnabled: %v", err)
	}
	first := frontRequest(t, front, http.MethodPut, "/bucket/doc.md", "one", nil)
	second := frontRequest(t, front, http.MethodPut, "/bucket/doc.md", "two", nil)
	body := "<Delete><Object><Key>doc.md</Key><VersionId>" + first.Header().Get("x-amz-version-id") +
		"</VersionId></Object><Object><Key>doc.md</Key><VersionId>" + second.Header().Get("x-amz-version-id") +
		"</VersionId></Object></Delete>"
	remove := frontRequest(t, front, http.MethodPost, "/bucket?delete", body, nil)
	if remove.Code < 200 || remove.Code >= 300 {
		t.Fatalf("delete objects = %d %s", remove.Code, remove.Body.String())
	}
	list := frontRequest(t, front, http.MethodGet, "/bucket?versions", "", nil)
	if strings.Contains(list.Body.String(), "<Version>") || strings.Contains(list.Body.String(), "<DeleteMarker>") {
		t.Fatalf("the version history survived the purge:\n%s", list.Body.String())
	}
	live := frontRequest(t, front, http.MethodGet, "/bucket/doc.md", "", nil)
	if live.Code != http.StatusNotFound {
		t.Fatalf("the live object survived the purge: %d", live.Code)
	}
}
