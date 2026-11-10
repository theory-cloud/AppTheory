package localrunner

// S3 object versioning.
//
// The pinned s3proxy does not implement versioning: a versioned-bucket put is
// answered 501 NotImplemented ("Versioning is not supported"), PutObject and
// CopyObject carry no x-amz-version-id, and ListObjectVersions answers 501.
// Its filesystem backend has never implemented versioning because a version
// history needs durable per-object metadata:
//
// https://github.com/gaul/s3proxy/issues/74
// https://github.com/gaul/s3proxy/issues/1138
//
// AWS S3, by contrast, writes a new version with a distinct version id for
// every successful write to a version-enabled bucket, serves an object by
// version id, and lists the version history (with delete markers):
//
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectVersions.html
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeleteMarker.html
//
// The smallest fix is therefore in the runner's S3 front, not a new image: the
// front already adopts the run's SigV4 credentials, re-signs requests for
// s3proxy and keeps per-object state beside it. This file gives it a version
// log: every successful write to a version-enabled bucket is copied out of
// s3proxy into the run's version store and answered with a new version id;
// GET/HEAD by versionId are served from that store; a delete without a version
// id records a delete marker; ListObjectVersions is synthesized from the log.
// A bucket whose template does not enable versioning takes exactly the v7.0.0
// path: no header is added and no byte is copied.

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	s3VersionIndexFile = "index.json"
	s3VersionBlobDir   = "blobs"
	s3VersionIdPrefix  = "v"
	// s3VersionMaxFetch bounds one archived object. A local test object is
	// small; a larger one is refused by name instead of being copied into a
	// store the runner cannot bound.
	s3VersionMaxFetch = 512 << 20
	// s3VersionMaxKeys is AWS's ListObjectVersions page size.
	// https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectVersions.html
	s3VersionMaxKeys = 1000
)

// s3Version is one entry in a bucket's version history.
type s3Version struct {
	VersionID    string    `json:"versionId"`
	Key          string    `json:"key"`
	DeleteMarker bool      `json:"deleteMarker,omitempty"`
	Size         int64     `json:"size,omitempty"`
	ETag         string    `json:"etag,omitempty"`
	ContentType  string    `json:"contentType,omitempty"`
	LastModified time.Time `json:"lastModified"`
	SSE          bool      `json:"sse,omitempty"`
	// Blob is the file name under blobs/<bucket>/ that holds the object's
	// bytes. A delete marker has no blob.
	Blob string `json:"blob,omitempty"`
}

// s3BucketVersions is the version state of one bucket.
type s3BucketVersions struct {
	Enabled bool `json:"enabled"`
	// Next is the sequence behind the next version id.
	Next     int         `json:"next"`
	Versions []s3Version `json:"versions,omitempty"`
}

// s3VersionStore is the run's version log. With --data-dir the log and the
// archived bytes live under <data-dir>/s3versions; otherwise they are kept in
// memory for the run's lifetime.
type s3VersionStore struct {
	mu      sync.Mutex
	path    string
	blobDir string
	buckets map[string]*s3BucketVersions
	memory  map[string][]byte
}

func newS3VersionStore(dataDir string) (*s3VersionStore, error) {
	store := &s3VersionStore{buckets: map[string]*s3BucketVersions{}, memory: map[string][]byte{}}
	if strings.TrimSpace(dataDir) == "" {
		return store, nil
	}
	dir := filepath.Join(dataDir, "s3versions")
	if err := os.MkdirAll(filepath.Join(dir, s3VersionBlobDir), 0o700); err != nil {
		return nil, fmt.Errorf("create the S3 version data directory %s: %w", dir, err)
	}
	store.path = filepath.Join(dir, s3VersionIndexFile)
	store.blobDir = filepath.Join(dir, s3VersionBlobDir)
	payload, err := os.ReadFile(store.path)
	if err != nil {
		if os.IsNotExist(err) {
			return store, nil
		}
		return nil, fmt.Errorf("read the persistent S3 version index %s: %w", store.path, err)
	}
	var file struct {
		Version int                          `json:"version"`
		Buckets map[string]*s3BucketVersions `json:"buckets"`
	}
	if err := json.Unmarshal(payload, &file); err != nil {
		return nil, fmt.Errorf("parse the persistent S3 version index %s: %w", store.path, err)
	}
	if file.Version != 1 {
		return nil, fmt.Errorf("the persistent S3 version index %s uses unsupported version %d", store.path, file.Version)
	}
	if file.Buckets != nil {
		store.buckets = file.Buckets
	}
	return store, nil
}

func (s *s3VersionStore) bucketLocked(name string) *s3BucketVersions {
	bucket, ok := s.buckets[name]
	if !ok {
		bucket = &s3BucketVersions{}
		s.buckets[name] = bucket
	}
	return bucket
}

// enabled reports whether the bucket's template enables versioning.
func (s *s3VersionStore) enabled(name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	bucket, ok := s.buckets[name]
	return ok && bucket.Enabled
}

// setEnabled records the bucket's versioning status. Only Enabled is served.
func (s *s3VersionStore) setEnabled(name string, enabled bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	bucket := s.bucketLocked(name)
	if bucket.Enabled == enabled {
		return nil
	}
	bucket.Enabled = enabled
	return s.saveLocked()
}

// nextID reserves a version id for one write.
func (s *s3VersionStore) nextID(name string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	bucket := s.bucketLocked(name)
	bucket.Next++
	return fmt.Sprintf("%s%016d", s3VersionIdPrefix, bucket.Next)
}

// append records one version (or delete marker) as the bucket's latest.
func (s *s3VersionStore) append(name string, version s3Version) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	bucket := s.bucketLocked(name)
	bucket.Versions = append(bucket.Versions, version)
	return s.saveLocked()
}

// latest returns the bucket's most recent version for a key.
func (s *s3VersionStore) latest(name, key string) (s3Version, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bucket, ok := s.buckets[name]
	if !ok {
		return s3Version{}, false
	}
	for index := len(bucket.Versions) - 1; index >= 0; index-- {
		if bucket.Versions[index].Key == key {
			return bucket.Versions[index], true
		}
	}
	return s3Version{}, false
}

// byID returns one version of a key.
func (s *s3VersionStore) byID(name, key, versionID string) (s3Version, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bucket, ok := s.buckets[name]
	if !ok {
		return s3Version{}, false
	}
	for _, version := range bucket.Versions {
		if version.Key == key && version.VersionID == versionID {
			return version, true
		}
	}
	return s3Version{}, false
}

// removeVersion deletes one version entry and reports what it was.
func (s *s3VersionStore) removeVersion(name, key, versionID string) (s3Version, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bucket, ok := s.buckets[name]
	if !ok {
		return s3Version{}, false, nil
	}
	for index, version := range bucket.Versions {
		if version.Key != key || version.VersionID != versionID {
			continue
		}
		bucket.Versions = append(bucket.Versions[:index], bucket.Versions[index+1:]...)
		if err := s.saveLocked(); err != nil {
			return s3Version{}, false, err
		}
		s.removeBlobLocked(name, version)
		return version, true, nil
	}
	return s3Version{}, false, nil
}

// removeBucket forgets a deleted bucket's history.
func (s *s3VersionStore) removeBucket(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	bucket, ok := s.buckets[name]
	if !ok {
		return nil
	}
	for _, version := range bucket.Versions {
		s.removeBlobLocked(name, version)
	}
	delete(s.buckets, name)
	if s.blobDir != "" && safeVersionPathComponent(name) {
		_ = os.RemoveAll(filepath.Join(s.blobDir, name)) //nolint:errcheck // the bucket is being deleted
	}
	return s.saveLocked()
}

// safeVersionPathComponent reports whether a name may be used as one path
// component under the version store's data directory. A bucket name arrives
// from the request path, so a value that is not a plain name is refused rather
// than joined into a filesystem path.
func safeVersionPathComponent(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > 255 {
		return false
	}
	for _, char := range name {
		switch {
		case char >= 'a' && char <= 'z',
			char >= 'A' && char <= 'Z',
			char >= '0' && char <= '9',
			char == '-', char == '_', char == '.':
		default:
			return false
		}
	}
	return true
}

// isLatest reports whether a version is the newest for its key.
func (s *s3VersionStore) isLatest(name string, version s3Version) bool {
	latest, ok := s.latest(name, version.Key)
	return ok && latest.VersionID == version.VersionID
}

// list returns the bucket's versions newest first, keys ascending, honoring an
// optional prefix and a page bound.
func (s *s3VersionStore) list(name, prefix string, maxKeys int) []s3Version {
	s.mu.Lock()
	defer s.mu.Unlock()
	bucket, ok := s.buckets[name]
	if !ok {
		return nil
	}
	if maxKeys <= 0 || maxKeys > s3VersionMaxKeys {
		maxKeys = s3VersionMaxKeys
	}
	var out []s3Version
	for _, version := range bucket.Versions {
		if prefix != "" && !strings.HasPrefix(version.Key, prefix) {
			continue
		}
		out = append(out, version)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Key != out[j].Key {
			return out[i].Key < out[j].Key
		}
		// The version id's sequence is the write order, and it is exact even
		// when two writes share a Last-Modified second.
		return out[i].VersionID > out[j].VersionID
	})
	if len(out) > maxKeys {
		out = out[:maxKeys]
	}
	return out
}

func (s *s3VersionStore) saveLocked() error {
	if s.path == "" {
		return nil
	}
	payload, err := json.MarshalIndent(struct {
		Version int                          `json:"version"`
		Buckets map[string]*s3BucketVersions `json:"buckets"`
	}{Version: 1, Buckets: s.buckets}, "", "  ")
	if err != nil {
		return fmt.Errorf("encode the S3 version index: %w", err)
	}
	payload = append(payload, '\n')
	temp, err := os.CreateTemp(filepath.Dir(s.path), s3VersionIndexFile+".tmp-*")
	if err != nil {
		return fmt.Errorf("create the S3 version index: %w", err)
	}
	tempName := temp.Name()
	defer func() { _ = os.Remove(tempName) }() //nolint:errcheck // the rename removes it on success
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close() //nolint:errcheck // the create failure is reported below
		return fmt.Errorf("make the S3 version index private: %w", err)
	}
	if _, err := temp.Write(payload); err != nil {
		_ = temp.Close() //nolint:errcheck // the write failure is reported below
		return fmt.Errorf("write the S3 version index: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close the S3 version index: %w", err)
	}
	if err := os.Rename(tempName, s.path); err != nil {
		return fmt.Errorf("replace the S3 version index: %w", err)
	}
	return nil
}

func (s *s3VersionStore) removeBlobLocked(bucket string, version s3Version) {
	if version.Blob == "" {
		return
	}
	if s.blobDir == "" {
		delete(s.memory, version.Blob)
		return
	}
	if !safeVersionPathComponent(bucket) || !safeVersionPathComponent(version.Blob) {
		return
	}
	_ = os.Remove(filepath.Join(s.blobDir, bucket, version.Blob)) //nolint:errcheck,gosec // best effort; both components are validated
}

// writeBlob stores one archived object and returns its blob name and size.
func (s *s3VersionStore) writeBlob(bucket, versionID string, body io.Reader) (string, int64, error) {
	if !safeVersionPathComponent(bucket) {
		return "", 0, fmt.Errorf("the version store refuses the bucket name %q", bucket)
	}
	if s.blobDir == "" {
		payload, err := io.ReadAll(io.LimitReader(body, s3VersionMaxFetch+1))
		if err != nil {
			return "", 0, err
		}
		if int64(len(payload)) > s3VersionMaxFetch {
			return "", 0, fmt.Errorf("the object is larger than %d bytes", s3VersionMaxFetch)
		}
		name := bucket + "/" + versionID
		s.mu.Lock()
		s.memory[name] = payload
		s.mu.Unlock()
		return name, int64(len(payload)), nil
	}
	dir := filepath.Join(s.blobDir, bucket)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", 0, err
	}
	file, err := os.CreateTemp(dir, versionID+".tmp-*")
	if err != nil {
		return "", 0, err
	}
	name := file.Name()
	written, copyErr := io.Copy(file, io.LimitReader(body, s3VersionMaxFetch+1))
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(name) //nolint:errcheck // the copy failed
		return "", 0, copyErr
	}
	if closeErr != nil {
		_ = os.Remove(name) //nolint:errcheck // the close failed
		return "", 0, closeErr
	}
	if written > s3VersionMaxFetch {
		_ = os.Remove(name) //nolint:errcheck // the object is too large
		return "", 0, fmt.Errorf("the object is larger than %d bytes", s3VersionMaxFetch)
	}
	final := filepath.Join(dir, versionID)
	if err := os.Rename(name, final); err != nil {
		_ = os.Remove(name) //nolint:errcheck // the rename failed
		return "", 0, err
	}
	return versionID, written, nil
}

// readBlob returns one archived object's bytes.
func (s *s3VersionStore) readBlob(bucket string, version s3Version) ([]byte, error) {
	if version.Blob == "" {
		return nil, errors.New("the version has no stored object")
	}
	if s.blobDir == "" {
		s.mu.Lock()
		payload, ok := s.memory[version.Blob]
		s.mu.Unlock()
		if !ok {
			return nil, os.ErrNotExist
		}
		return payload, nil
	}
	if !safeVersionPathComponent(bucket) || !safeVersionPathComponent(version.Blob) {
		return nil, fmt.Errorf("the version store refuses the bucket or blob name %q/%q", bucket, version.Blob)
	}
	return os.ReadFile(filepath.Join(s.blobDir, bucket, version.Blob)) //nolint:gosec // both components passed safeVersionPathComponent
}

// --- request handling -------------------------------------------------------

// versionedRequest answers a request that only the version log can serve: a
// versioning configuration read or write, a read by version id, a version
// listing, and a delete of one version. It returns false for every other
// request, which keeps an unversioned bucket on the v7.0.0 path.
//
//nolint:gocyclo,gocognit // one branch per versioned operation.
func (f *s3Front) versionedRequest(writer http.ResponseWriter, request *http.Request) bool {
	if f.versions == nil {
		return false
	}
	bucket, key := splitS3Path(request.URL.Path)
	if bucket == "" {
		return false
	}
	query := request.URL.Query()
	if key == "" && query.Has("versioning") {
		switch request.Method {
		case http.MethodGet:
			if !f.versions.enabled(bucket) {
				return false
			}
			writeVersioningConfiguration(writer, "Enabled")
			return true
		case http.MethodPut:
			// Versioning is a template property here. A bucket the template did
			// not enable keeps the store's answer, so an unversioned bucket
			// behaves exactly as it did before this front kept a version log.
			if !f.versions.enabled(bucket) {
				return false
			}
			var configuration struct {
				Status string `xml:"Status"`
			}
			payload, err := io.ReadAll(io.LimitReader(request.Body, 64<<10))
			if err != nil || xml.Unmarshal(payload, &configuration) != nil {
				writeS3VersionError(writer, http.StatusBadRequest, "MalformedXML", "the versioning configuration is not XML")
				return true
			}
			switch configuration.Status {
			case "Enabled":
				if err := f.versions.setEnabled(bucket, true); err != nil {
					writeS3VersionError(writer, http.StatusInternalServerError, "InternalError", err.Error())
					return true
				}
				writer.WriteHeader(http.StatusOK)
				return true
			case "Suspended":
				writeS3VersionError(writer, http.StatusNotImplemented, "NotImplemented",
					"the local S3 front serves versioning Enabled only; suspending versioning is a docs/125 true limit")
				return true
			default:
				writeS3VersionError(writer, http.StatusBadRequest, "MalformedXML", "Status must be Enabled or Suspended")
				return true
			}
		}
	}
	if !f.versions.enabled(bucket) {
		return false
	}
	if request.Method == http.MethodPut && strings.Contains(request.Header.Get("x-amz-copy-source"), "versionId=") {
		writeS3VersionError(writer, http.StatusNotImplemented, "NotImplemented",
			"the local S3 front serves a copy of the current object only; copying a specific version is a docs/125 true limit")
		return true
	}
	if key == "" && query.Has("versions") && request.Method == http.MethodGet {
		f.listVersions(writer, request, bucket)
		return true
	}
	if key == "" {
		return false
	}
	if versionID := query.Get("versionId"); versionID != "" {
		switch request.Method {
		case http.MethodGet, http.MethodHead:
			f.serveVersion(writer, request, bucket, key, versionID)
			return true
		case http.MethodDelete:
			f.deleteVersion(writer, request, bucket, key, versionID)
			return true
		}
	}
	return false
}

// serveVersion answers GET/HEAD for one version id from the version log.
func (f *s3Front) serveVersion(writer http.ResponseWriter, request *http.Request, bucket, key, versionID string) {
	version, ok := f.versions.byID(bucket, key, versionID)
	if !ok {
		writeS3VersionError(writer, http.StatusNotFound, "NoSuchVersion", "The specified version does not exist.")
		return
	}
	if version.DeleteMarker {
		writer.Header().Set("x-amz-delete-marker", "true")
		writer.Header().Set("x-amz-version-id", version.VersionID)
		writer.Header().Set("Last-Modified", version.LastModified.UTC().Format(http.TimeFormat))
		writeS3VersionError(writer, http.StatusMethodNotAllowed, "MethodNotAllowed",
			"The specified method is not allowed against this resource.")
		return
	}
	payload, err := f.versions.readBlob(bucket, version)
	if err != nil {
		writeS3VersionError(writer, http.StatusInternalServerError, "InternalError", "the stored version cannot be read: "+err.Error())
		return
	}
	headers := writer.Header()
	headers.Set("x-amz-version-id", version.VersionID)
	headers.Set("Accept-Ranges", "bytes")
	if version.ETag != "" {
		headers.Set("ETag", version.ETag)
	}
	if version.ContentType != "" {
		headers.Set("Content-Type", version.ContentType)
	}
	if version.SSE {
		headers.Set(s3SSEAlgorithmHeader, "AES256")
	}
	headers.Set("Last-Modified", version.LastModified.UTC().Format(http.TimeFormat))
	if request.Method == http.MethodHead {
		headers.Set("Content-Length", strconv.FormatInt(int64(len(payload)), 10))
		writer.WriteHeader(http.StatusOK)
		return
	}
	serveS3VersionBytes(writer, request, payload)
}

// serveS3VersionBytes writes a stored object, honoring a single byte range the
// way GetObject documents it.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
func serveS3VersionBytes(writer http.ResponseWriter, request *http.Request, payload []byte) {
	total := int64(len(payload))
	rangeHeader := strings.TrimSpace(request.Header.Get("Range"))
	if rangeHeader == "" {
		writer.Header().Set("Content-Length", strconv.FormatInt(total, 10))
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write(payload) //nolint:errcheck // the client may hang up
		return
	}
	start, end, ok := parseS3Range(rangeHeader, total)
	if !ok {
		writer.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", total))
		writeS3VersionError(writer, http.StatusRequestedRangeNotSatisfiable, "InvalidRange", "The requested range is not satisfiable")
		return
	}
	writer.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, total))
	writer.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
	writer.WriteHeader(http.StatusPartialContent)
	_, _ = writer.Write(payload[start : end+1]) //nolint:errcheck // the client may hang up
}

// parseS3Range reads GetObject's single byte range.
//
//nolint:gocyclo // one branch per range shape.
func parseS3Range(header string, total int64) (int64, int64, bool) {
	if !strings.HasPrefix(header, "bytes=") || strings.Contains(header, ",") {
		return 0, 0, false
	}
	spec := strings.TrimPrefix(header, "bytes=")
	startPart, endPart, found := strings.Cut(spec, "-")
	if !found || total == 0 {
		return 0, 0, false
	}
	if startPart == "" {
		// A suffix range: the last N bytes.
		length, err := strconv.ParseInt(endPart, 10, 64)
		if err != nil || length <= 0 {
			return 0, 0, false
		}
		if length > total {
			length = total
		}
		return total - length, total - 1, true
	}
	start, err := strconv.ParseInt(startPart, 10, 64)
	if err != nil || start < 0 || start >= total {
		return 0, 0, false
	}
	end := total - 1
	if endPart != "" {
		parsed, parseErr := strconv.ParseInt(endPart, 10, 64)
		if parseErr != nil || parsed < start {
			return 0, 0, false
		}
		if parsed < end {
			end = parsed
		}
	}
	return start, end, true
}

// deleteVersion removes one version, keeping the live object consistent: a
// removed latest object deletes it from the store, and a removed latest delete
// marker restores the previous object.
func (f *s3Front) deleteVersion(writer http.ResponseWriter, request *http.Request, bucket, key, versionID string) {
	version, ok, err := f.versions.removeVersion(bucket, key, versionID)
	if err != nil {
		writeS3VersionError(writer, http.StatusInternalServerError, "InternalError", err.Error())
		return
	}
	if !ok {
		writeS3VersionError(writer, http.StatusNotFound, "NoSuchVersion", "The specified version does not exist.")
		return
	}
	// Reconcile the store's live object with what is now the latest version:
	// a removed latest object removes it, and a removed delete marker exposes
	// the previous object again.
	if err := f.reconcileLiveObject(request.Context(), bucket, key); err != nil {
		f.logf("local S3 front: reconcile %s/%s after deleting version %s: %v", bucket, key, versionID, err)
	}
	writer.Header().Set("x-amz-version-id", versionID)
	if version.DeleteMarker {
		writer.Header().Set("x-amz-delete-marker", "true")
	}
	writer.WriteHeader(http.StatusNoContent)
}

// listVersions synthesizes ListObjectVersions from the version log. Keys are
// ascending and each key's versions newest first, which is the order AWS
// documents; key-marker/version-id-marker page through that order.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectVersions.html
func (f *s3Front) listVersions(writer http.ResponseWriter, request *http.Request, bucket string) {
	query := request.URL.Query()
	prefix := query.Get("prefix")
	keyMarker := query.Get("key-marker")
	versionMarker := query.Get("version-id-marker")
	maxKeys := s3VersionMaxKeys
	if raw := query.Get("max-keys"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			maxKeys = parsed
		}
	}
	versions := f.versions.list(bucket, prefix, 0)
	if keyMarker != "" {
		at := 0
		for at < len(versions) {
			version := versions[at]
			if version.Key < keyMarker {
				at++
				continue
			}
			if version.Key == keyMarker {
				if versionMarker == "" || version.VersionID != versionMarker {
					at++
					continue
				}
				at++
			}
			break
		}
		versions = versions[at:]
	}
	truncated := false
	nextKey, nextVersion := "", ""
	if len(versions) > maxKeys {
		versions = versions[:maxKeys]
		truncated = true
		last := versions[len(versions)-1]
		nextKey, nextVersion = last.Key, last.VersionID
	}
	type xmlVersion struct {
		Key          string `xml:"Key"`
		VersionID    string `xml:"VersionId"`
		IsLatest     bool   `xml:"IsLatest"`
		LastModified string `xml:"LastModified"`
		ETag         string `xml:"ETag,omitempty"`
		Size         int64  `xml:"Size,omitempty"`
		StorageClass string `xml:"StorageClass,omitempty"`
	}
	type xmlDeleteMarker struct {
		Key          string `xml:"Key"`
		VersionID    string `xml:"VersionId"`
		IsLatest     bool   `xml:"IsLatest"`
		LastModified string `xml:"LastModified"`
	}
	type result struct {
		XMLName             xml.Name          `xml:"ListVersionsResult"`
		Xmlns               string            `xml:"xmlns,attr"`
		Name                string            `xml:"Name"`
		Prefix              string            `xml:"Prefix"`
		KeyMarker           string            `xml:"KeyMarker"`
		VersionIdMarker     string            `xml:"VersionIdMarker"`
		NextKeyMarker       string            `xml:"NextKeyMarker,omitempty"`
		NextVersionIdMarker string            `xml:"NextVersionIdMarker,omitempty"`
		MaxKeys             int               `xml:"MaxKeys"`
		IsTruncated         bool              `xml:"IsTruncated"`
		Versions            []xmlVersion      `xml:"Version"`
		Markers             []xmlDeleteMarker `xml:"DeleteMarker"`
	}
	document := result{
		Xmlns:               "http://s3.amazonaws.com/doc/2006-03-01/",
		Name:                bucket,
		Prefix:              prefix,
		KeyMarker:           keyMarker,
		VersionIdMarker:     versionMarker,
		NextKeyMarker:       nextKey,
		NextVersionIdMarker: nextVersion,
		MaxKeys:             maxKeys,
		IsTruncated:         truncated,
	}
	for _, version := range versions {
		latest := f.versions.isLatest(bucket, version)
		modified := version.LastModified.UTC().Format(time.RFC3339)
		if version.DeleteMarker {
			document.Markers = append(document.Markers, xmlDeleteMarker{
				Key: version.Key, VersionID: version.VersionID, IsLatest: latest, LastModified: modified,
			})
			continue
		}
		document.Versions = append(document.Versions, xmlVersion{
			Key:          version.Key,
			VersionID:    version.VersionID,
			IsLatest:     latest,
			LastModified: modified,
			ETag:         version.ETag,
			Size:         version.Size,
			StorageClass: "STANDARD",
		})
	}
	payload, err := xml.Marshal(document)
	if err != nil {
		writeS3VersionError(writer, http.StatusInternalServerError, "InternalError", err.Error())
		return
	}
	writer.Header().Set("Content-Type", "application/xml")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write([]byte(xml.Header)) //nolint:errcheck // the client may hang up
	_, _ = writer.Write(payload)            //nolint:errcheck // the client may hang up
}

func writeVersioningConfiguration(writer http.ResponseWriter, status string) {
	payload := fmt.Sprintf(
		`<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>%s</Status></VersioningConfiguration>`,
		status)
	writer.Header().Set("Content-Type", "application/xml")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write([]byte(payload)) //nolint:errcheck // the client may hang up
}

func writeS3VersionError(writer http.ResponseWriter, status int, code, message string) {
	writer.Header().Set("Content-Type", "application/xml")
	writer.WriteHeader(status)
	payload := fmt.Sprintf(
		`<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>%s</Message><RequestId>local</RequestId></Error>`,
		code, message)
	_, _ = writer.Write([]byte(payload)) //nolint:errcheck // the client may hang up
}

// applyVersionedDeleteObjects applies one DeleteObjects request to a versioned
// bucket: an entry with a version id removes that version, and a plain entry
// creates a delete marker, exactly as AWS documents. Every affected key's live
// object is reconciled once, so an emptied prefix leaves no bytes behind.
//
// https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html
func (f *s3Front) applyVersionedDeleteObjects(ctx context.Context, bucket string, identifiers []s3RemoveIdentifier) error {
	affected := map[string]struct{}{}
	for _, identifier := range identifiers {
		if identifier.VersionID == "" {
			if err := f.versions.append(bucket, s3Version{
				VersionID:    f.versions.nextID(bucket),
				Key:          identifier.Key,
				DeleteMarker: true,
				LastModified: time.Now().UTC(),
			}); err != nil {
				return err
			}
			affected[identifier.Key] = struct{}{}
			continue
		}
		if _, _, err := f.versions.removeVersion(bucket, identifier.Key, identifier.VersionID); err != nil {
			return err
		}
		affected[identifier.Key] = struct{}{}
	}
	keys := make([]string, 0, len(affected))
	for key := range affected {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if err := f.reconcileLiveObject(ctx, bucket, key); err != nil {
			return err
		}
	}
	return nil
}

// reconcileLiveObject makes s3proxy's live object the bucket's latest version.
func (f *s3Front) reconcileLiveObject(ctx context.Context, bucket, key string) error {
	latest, ok := f.versions.latest(bucket, key)
	if !ok || latest.DeleteMarker {
		return f.deleteUpstreamObject(ctx, bucket, key)
	}
	payload, err := f.versions.readBlob(bucket, latest)
	if err != nil {
		return err
	}
	return f.putUpstreamObject(ctx, bucket, key, payload, latest.ContentType)
}

// --- archival and live-object reconciliation --------------------------------

// archiveWrite records the object a successful write just produced. It is
// called from the response modifier, so a failure turns the write into an
// error: a version-enabled bucket must never answer a successful write without
// the version id that makes it retrievable.
func (f *s3Front) archiveWrite(ctx context.Context, bucket, key string, response *http.Response) error {
	versionID := f.versions.nextID(bucket)
	upstream, err := f.fetchUpstreamObject(ctx, bucket, key)
	if err != nil {
		return err
	}
	defer func() { _ = upstream.Body.Close() }() //nolint:errcheck // the body is copied or discarded
	if upstream.StatusCode != http.StatusOK {
		payload, _ := io.ReadAll(io.LimitReader(upstream.Body, s3FrontErrorBodyLimit)) //nolint:errcheck // the error body is diagnostic only
		return fmt.Errorf("the store answered the archived read with %d: %s", upstream.StatusCode, strings.TrimSpace(string(payload)))
	}
	blob, size, err := f.versions.writeBlob(bucket, versionID, upstream.Body)
	if err != nil {
		return err
	}
	lastModified := time.Now().UTC()
	if raw := upstream.Header.Get("Last-Modified"); raw != "" {
		if parsed, parseErr := http.ParseTime(raw); parseErr == nil {
			lastModified = parsed.UTC()
		}
	}
	version := s3Version{
		VersionID:    versionID,
		Key:          key,
		Size:         size,
		ETag:         strings.TrimSpace(upstream.Header.Get("ETag")),
		ContentType:  upstream.Header.Get("Content-Type"),
		LastModified: lastModified,
		SSE:          f.index.has(bucket, key),
		Blob:         blob,
	}
	if err := f.versions.append(bucket, version); err != nil {
		return err
	}
	response.Header.Set("x-amz-version-id", versionID)
	if version.SSE {
		response.Header.Set(s3SSEAlgorithmHeader, "AES256")
	}
	return nil
}

// recordDeleteMarker records the delete marker a successful delete created.
func (f *s3Front) recordDeleteMarker(bucket, key string, response *http.Response) error {
	versionID := f.versions.nextID(bucket)
	version := s3Version{
		VersionID:    versionID,
		Key:          key,
		DeleteMarker: true,
		LastModified: time.Now().UTC(),
	}
	if err := f.versions.append(bucket, version); err != nil {
		return err
	}
	response.Header.Set("x-amz-version-id", versionID)
	response.Header.Set("x-amz-delete-marker", "true")
	return nil
}

// decorateVersionedRead adds the live version id, or the delete marker that
// makes the object missing, to a proxied GET/HEAD.
func (f *s3Front) decorateVersionedRead(bucket, key string, response *http.Response) {
	latest, ok := f.versions.latest(bucket, key)
	if !ok {
		return
	}
	if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusMethodNotAllowed {
		if latest.DeleteMarker {
			response.Header.Set("x-amz-delete-marker", "true")
			response.Header.Set("x-amz-version-id", latest.VersionID)
		}
		return
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 && !latest.DeleteMarker {
		response.Header.Set("x-amz-version-id", latest.VersionID)
	}
}

// fetchUpstreamObject reads one object from s3proxy with the store's identity.
// The request is signed the same way the front signs a forwarded write, so keys
// with reserved characters keep the one encoding s3proxy expects.
func (f *s3Front) fetchUpstreamObject(ctx context.Context, bucket, key string) (*http.Response, error) {
	request, err := f.upstreamObjectRequest(ctx, http.MethodGet, bucket, key, nil)
	if err != nil {
		return nil, err
	}
	response, err := f.client.Do(request) //nolint:gosec // the request targets the run's own s3proxy upstream
	if err != nil {
		return nil, fmt.Errorf("read %s/%s from the local store: %w", bucket, key, err)
	}
	return response, nil
}

// putUpstreamObject restores one archived object to s3proxy, used when a
// removed delete marker exposes the previous version again.
func (f *s3Front) putUpstreamObject(ctx context.Context, bucket, key string, payload []byte, contentType string) error {
	request, err := f.upstreamObjectRequest(ctx, http.MethodPut, bucket, key, payload)
	if err != nil {
		return err
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := f.client.Do(request) //nolint:gosec // the request targets the run's own s3proxy upstream
	if err != nil {
		return fmt.Errorf("restore %s/%s in the local store: %w", bucket, key, err)
	}
	defer func() { _ = response.Body.Close() }()                                     //nolint:errcheck // the body is drained or discarded
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, s3FrontErrorBodyLimit)) //nolint:errcheck // the body is drained or discarded
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("the store answered the restore with %d", response.StatusCode)
	}
	return nil
}

// deleteUpstreamObject removes the live copy of one key.
func (f *s3Front) deleteUpstreamObject(ctx context.Context, bucket, key string) error {
	request, err := f.upstreamObjectRequest(ctx, http.MethodDelete, bucket, key, nil)
	if err != nil {
		return err
	}
	response, err := f.client.Do(request) //nolint:gosec // the request targets the run's own s3proxy upstream
	if err != nil {
		return fmt.Errorf("delete %s/%s from the local store: %w", bucket, key, err)
	}
	defer func() { _ = response.Body.Close() }()                                     //nolint:errcheck // the body is drained or discarded
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, s3FrontErrorBodyLimit)) //nolint:errcheck // the body is drained or discarded
	if response.StatusCode >= 300 && response.StatusCode != http.StatusNotFound {
		return fmt.Errorf("the store answered the delete with %d", response.StatusCode)
	}
	return nil
}

// upstreamObjectRequest builds and signs one request to the store's object
// path. The front signs the same headers it forwards, so the store's SigV4
// check sees a valid signature for its own identity.
func (f *s3Front) upstreamObjectRequest(ctx context.Context, method, bucket, key string, payload []byte) (*http.Request, error) {
	path := "/" + bucket + "/" + key
	target := *f.upstream
	target.Path = path
	target.RawPath = ""
	target.RawQuery = ""
	var body io.Reader
	if payload != nil {
		body = strings.NewReader(string(payload))
	}
	request, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return nil, err
	}
	request.Host = f.upstream.Host
	if payload != nil {
		request.ContentLength = int64(len(payload))
	}
	if err := f.signRequest(request); err != nil {
		return nil, err
	}
	return request, nil
}
