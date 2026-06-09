// Package objectstore provides AppTheory's narrow object-store helper surface.
package objectstore

import (
	"errors"
	"strings"
	"unicode"
)

// ErrInvalidObjectRef is returned when an object reference is incomplete or unsupported.
var ErrInvalidObjectRef = errors.New("objectstore: invalid object ref")

// ObjectRef identifies one object in an S3-compatible object store.
//
// Bucket and Key are always required. VersionID is optional and is used only by
// version-aware operations such as Get and Delete.
type ObjectRef struct {
	Bucket    string
	Key       string
	VersionID string
}

// ParseObjectRef parses a strict s3://bucket/key reference.
//
// The parser does not normalize, decode, or default any component: valid bucket
// and key values are preserved exactly as they appear in the input reference.
func ParseObjectRef(raw string) (ObjectRef, error) {
	if raw == "" || raw != strings.TrimSpace(raw) {
		return ObjectRef{}, ErrInvalidObjectRef
	}
	if strings.ContainsAny(raw, "?#") {
		return ObjectRef{}, ErrInvalidObjectRef
	}

	const scheme = "s3://"
	rest, ok := strings.CutPrefix(raw, scheme)
	if !ok {
		return ObjectRef{}, ErrInvalidObjectRef
	}

	bucket, key, ok := strings.Cut(rest, "/")
	if !ok {
		return ObjectRef{}, ErrInvalidObjectRef
	}

	ref := ObjectRef{Bucket: bucket, Key: key}
	if err := ref.Validate(); err != nil {
		return ObjectRef{}, err
	}
	return ref, nil
}

// Validate verifies that the reference has the components required for an
// AppTheory object-store operation.
func (r ObjectRef) Validate() error {
	if r.Bucket == "" || r.Key == "" {
		return ErrInvalidObjectRef
	}
	if strings.Contains(r.Bucket, "/") || strings.ContainsAny(r.Bucket, "?#") {
		return ErrInvalidObjectRef
	}
	if strings.ContainsAny(r.Key, "?#") || strings.ContainsAny(r.VersionID, "?#") {
		return ErrInvalidObjectRef
	}
	if containsControlOrSpace(r.Bucket) || containsControl(r.Key) || containsControl(r.VersionID) {
		return ErrInvalidObjectRef
	}
	return nil
}

func containsControl(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

func containsControlOrSpace(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return true
		}
	}
	return false
}
