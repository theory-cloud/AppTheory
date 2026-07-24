package objectstore

import (
	"context"
	"errors"
	"testing"

	store "github.com/theory-cloud/apptheory/v2/pkg/objectstore"
)

func TestFakeStorePutGetDeleteAndCallOrder(t *testing.T) {
	fake := NewStore()
	ref := store.ObjectRef{Bucket: "bucket-a", Key: "objects/1.json"}

	storedRef, err := fake.Put(context.Background(), store.PutInput{
		Ref:         ref,
		Payload:     []byte(`{"ok":true}`),
		ContentType: "application/json",
		Metadata:    map[string]string{"sha256": "abc"},
	})
	if err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	if storedRef.VersionID == "" {
		t.Fatalf("Put() VersionID is empty")
	}

	_, err = fake.Get(context.Background(), store.GetInput{Ref: ref, MaxBytes: 4})
	if !errors.Is(err, store.ErrObjectTooLarge) {
		t.Fatalf("bounded Get() error = %v, want ErrObjectTooLarge", err)
	}

	got, err := fake.Get(context.Background(), store.GetInput{Ref: storedRef, MaxBytes: 64})
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if string(got.Payload) != `{"ok":true}` {
		t.Fatalf("Get() payload = %q", got.Payload)
	}
	if got.Ref != storedRef {
		t.Fatalf("Get() ref = %#v, want %#v", got.Ref, storedRef)
	}
	if got.ContentType != "application/json" || got.Metadata["sha256"] != "abc" {
		t.Fatalf("Get() metadata/content type mismatch: %#v", got)
	}

	if deleteErr := fake.Delete(context.Background(), store.DeleteInput{Ref: ref}); deleteErr != nil {
		t.Fatalf("Delete() error = %v", deleteErr)
	}
	_, err = fake.Get(context.Background(), store.GetInput{Ref: storedRef, MaxBytes: 64})
	if !errors.Is(err, store.ErrObjectNotFound) {
		t.Fatalf("Get() after delete error = %v, want ErrObjectNotFound", err)
	}

	calls := fake.Calls()
	if got, want := len(calls), 5; got != want {
		t.Fatalf("len(Calls()) = %d, want %d", got, want)
	}
	wantOps := []Operation{OperationPut, OperationGet, OperationGet, OperationDelete, OperationGet}
	for i, want := range wantOps {
		if calls[i].Operation != want {
			t.Fatalf("Calls()[%d].Operation = %s, want %s", i, calls[i].Operation, want)
		}
	}
	if calls[1].MaxBytes != 4 || calls[2].Ref.VersionID != storedRef.VersionID {
		t.Fatalf("Get call details not recorded: %#v", calls)
	}
}

func TestFakeStoreCopyOnWriteSafety(t *testing.T) {
	fake := NewStore()
	payload := []byte("payload")
	metadata := map[string]string{"a": "b"}
	ref, err := fake.Put(context.Background(), store.PutInput{
		Ref:      store.ObjectRef{Bucket: "bucket-a", Key: "key"},
		Payload:  payload,
		Metadata: metadata,
	})
	if err != nil {
		t.Fatalf("Put() error = %v", err)
	}
	payload[0] = 'P'
	metadata["a"] = "changed"

	got, err := fake.Get(context.Background(), store.GetInput{Ref: ref, MaxBytes: 64})
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	got.Payload[0] = 'G'
	got.Metadata["a"] = "changed again"

	gotAgain, err := fake.Get(context.Background(), store.GetInput{Ref: ref, MaxBytes: 64})
	if err != nil {
		t.Fatalf("Get() again error = %v", err)
	}
	if string(gotAgain.Payload) != "payload" || gotAgain.Metadata["a"] != "b" {
		t.Fatalf("FakeStore did not preserve stored copies: %#v", gotAgain)
	}

	calls := fake.Calls()
	calls[0].Payload[0] = 'C'
	calls[0].Metadata["a"] = "mutated call"
	callsAgain := fake.Calls()
	if string(callsAgain[0].Payload) != "payload" || callsAgain[0].Metadata["a"] != "b" {
		t.Fatalf("Calls() did not return copies: %#v", callsAgain[0])
	}
}

func TestFakeStoreFailureInjection(t *testing.T) {
	fake := NewStore()
	boom := errors.New("boom")
	fake.SetError(OperationPut, boom)
	_, err := fake.Put(context.Background(), store.PutInput{
		Ref:     store.ObjectRef{Bucket: "bucket-a", Key: "key"},
		Payload: []byte("payload"),
	})
	if !errors.Is(err, boom) {
		t.Fatalf("Put() error = %v, want injected error", err)
	}
	if got, want := len(fake.Calls()), 1; got != want {
		t.Fatalf("len(Calls()) = %d, want %d", got, want)
	}

	fake.SetError(OperationPut, nil)
	if _, err := fake.Put(context.Background(), store.PutInput{
		Ref:     store.ObjectRef{Bucket: "bucket-a", Key: "key"},
		Payload: []byte("payload"),
	}); err != nil {
		t.Fatalf("Put() after clearing error = %v", err)
	}
}

func TestFakeStoreFailClosedValidation(t *testing.T) {
	fake := NewStore()
	if _, err := fake.Get(context.Background(), store.GetInput{Ref: store.ObjectRef{Bucket: "bucket-a", Key: "key"}}); !errors.Is(err, store.ErrInvalidGetLimit) {
		t.Fatalf("Get() without cap error = %v, want ErrInvalidGetLimit", err)
	}
	if _, err := fake.Put(context.Background(), store.PutInput{Ref: store.ObjectRef{Bucket: "bucket-a", Key: "key", VersionID: "v1"}}); !errors.Is(err, store.ErrInvalidObjectRef) {
		t.Fatalf("Put() with VersionID error = %v, want ErrInvalidObjectRef", err)
	}
	if err := fake.Delete(context.Background(), store.DeleteInput{Ref: store.ObjectRef{Bucket: "bucket-a"}}); !errors.Is(err, store.ErrInvalidObjectRef) {
		t.Fatalf("Delete() invalid ref error = %v, want ErrInvalidObjectRef", err)
	}
}
