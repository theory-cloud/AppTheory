package objectstore

import (
	"context"
	"errors"
	"testing"
)

var _ Store = (*contractStore)(nil)

type contractStore struct{}

func (*contractStore) Put(context.Context, PutInput) (ObjectRef, error)  { return ObjectRef{}, nil }
func (*contractStore) Get(context.Context, GetInput) (*GetOutput, error) { return nil, nil }
func (*contractStore) Delete(context.Context, DeleteInput) error         { return nil }

func TestValidateStoreInputs(t *testing.T) {
	ref := ObjectRef{Bucket: "bucket-a", Key: "key", VersionID: "version-1"}
	if err := validatePutInput(PutInput{Ref: ref, Payload: []byte("payload")}); err != nil {
		t.Fatalf("validatePutInput() error = %v", err)
	}
	if err := validateGetInput(GetInput{Ref: ref, MaxBytes: 1}); err != nil {
		t.Fatalf("validateGetInput() error = %v", err)
	}
	if err := validateDeleteInput(DeleteInput{Ref: ref}); err != nil {
		t.Fatalf("validateDeleteInput() error = %v", err)
	}
}

func TestValidateStoreInputsFailClosed(t *testing.T) {
	if err := validatePutInput(PutInput{Ref: ObjectRef{Bucket: "bucket-a"}}); !errors.Is(err, ErrInvalidObjectRef) {
		t.Fatalf("validatePutInput() error = %v, want ErrInvalidObjectRef", err)
	}
	if err := validateGetInput(GetInput{Ref: ObjectRef{Bucket: "bucket-a", Key: "key"}}); !errors.Is(err, ErrInvalidGetLimit) {
		t.Fatalf("validateGetInput() error = %v, want ErrInvalidGetLimit", err)
	}
	if err := validateGetInput(GetInput{Ref: ObjectRef{Bucket: "bucket-a", Key: "key"}, MaxBytes: -1}); !errors.Is(err, ErrInvalidGetLimit) {
		t.Fatalf("validateGetInput() negative cap error = %v, want ErrInvalidGetLimit", err)
	}
	if err := validateDeleteInput(DeleteInput{Ref: ObjectRef{Bucket: "bucket-a"}}); !errors.Is(err, ErrInvalidObjectRef) {
		t.Fatalf("validateDeleteInput() error = %v, want ErrInvalidObjectRef", err)
	}
}

func TestCloneHelpersCopyOnWrite(t *testing.T) {
	payload := []byte("payload")
	payloadCopy := cloneBytes(payload)
	payload[0] = 'P'
	if string(payloadCopy) != "payload" {
		t.Fatalf("cloneBytes() = %q, want payload", payloadCopy)
	}

	metadata := map[string]string{"a": "b"}
	metadataCopy := cloneMetadata(metadata)
	metadata["a"] = "changed"
	if metadataCopy["a"] != "b" {
		t.Fatalf("cloneMetadata() = %#v, want original value", metadataCopy)
	}
}
