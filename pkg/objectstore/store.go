package objectstore

import (
	"context"
	"errors"
)

// Stable object-store operation errors.
var (
	// ErrInvalidGetLimit is returned when a Get request does not set a positive byte cap.
	ErrInvalidGetLimit = errors.New("objectstore: max bytes must be positive")
	// ErrObjectTooLarge is returned when a bounded Get would exceed its byte cap.
	ErrObjectTooLarge = errors.New("objectstore: object exceeds max bytes")
	// ErrObjectNotFound is returned by deterministic stores when the requested object is absent.
	ErrObjectNotFound = errors.New("objectstore: object not found")
)

// Store is AppTheory's narrow object-store contract.
//
// It intentionally supports only byte Put, bounded Get, and Delete. There is no
// unbounded read method and no listing, presigning, public URL, multipart, copy,
// head, or raw client escape hatch.
type Store interface {
	Put(context.Context, PutInput) (ObjectRef, error)
	Get(context.Context, GetInput) (*GetOutput, error)
	Delete(context.Context, DeleteInput) error
}

// PutInput writes a byte payload to one object reference.
type PutInput struct {
	Ref         ObjectRef
	Payload     []byte
	ContentType string
	Metadata    map[string]string
}

// GetInput reads one object reference with a required maximum byte cap.
type GetInput struct {
	Ref      ObjectRef
	MaxBytes int64
}

// GetOutput is the bounded byte payload returned by Store.Get.
type GetOutput struct {
	Ref         ObjectRef
	Payload     []byte
	ContentType string
	Metadata    map[string]string
}

// DeleteInput removes one object reference. Ref.VersionID is honored by stores
// that support versioned objects.
type DeleteInput struct {
	Ref ObjectRef
}

func validatePutInput(input PutInput) error {
	return input.Ref.Validate()
}

func validateGetInput(input GetInput) error {
	if err := input.Ref.Validate(); err != nil {
		return err
	}
	if input.MaxBytes <= 0 {
		return ErrInvalidGetLimit
	}
	return nil
}

func validateDeleteInput(input DeleteInput) error {
	return input.Ref.Validate()
}

func cloneBytes(in []byte) []byte {
	if in == nil {
		return nil
	}
	out := make([]byte, len(in))
	copy(out, in)
	return out
}

func cloneMetadata(in map[string]string) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
