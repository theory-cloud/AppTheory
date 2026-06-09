// Package objectstore provides deterministic test doubles for AppTheory object-store code.
package objectstore

import (
	"context"
	"fmt"
	"sort"
	"sync"

	store "github.com/theory-cloud/apptheory/pkg/objectstore"
)

// Operation names a Store operation recorded by FakeStore.
type Operation string

const (
	// OperationPut records a Store.Put call.
	OperationPut Operation = "Put"
	// OperationGet records a Store.Get call.
	OperationGet Operation = "Get"
	// OperationDelete records a Store.Delete call.
	OperationDelete Operation = "Delete"
)

// Call is one recorded FakeStore operation.
type Call struct {
	Operation   Operation
	Ref         store.ObjectRef
	MaxBytes    int64
	ContentType string
	Metadata    map[string]string
	Payload     []byte
}

// FakeStore is an in-memory Store for tests.
//
// FakeStore records calls in order, injects per-operation failures, and copies
// all byte slices and metadata maps at its boundary.
type FakeStore struct {
	mu       sync.Mutex
	seq      int64
	latest   map[objectName]string
	objects  map[objectVersion]storedObject
	calls    []Call
	failures map[Operation]error
}

var _ store.Store = (*FakeStore)(nil)

type objectName struct {
	bucket string
	key    string
}

type objectVersion struct {
	name    objectName
	version string
}

type storedObject struct {
	ref         store.ObjectRef
	payload     []byte
	contentType string
	metadata    map[string]string
}

// NewStore creates an empty FakeStore.
func NewStore() *FakeStore {
	return &FakeStore{
		latest:   make(map[objectName]string),
		objects:  make(map[objectVersion]storedObject),
		failures: make(map[Operation]error),
	}
}

// SetError injects err for subsequent calls to operation. Passing nil clears the injection.
func (s *FakeStore) SetError(operation Operation, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLocked()
	if err == nil {
		delete(s.failures, operation)
		return
	}
	s.failures[operation] = err
}

// Calls returns the recorded operations in call order.
func (s *FakeStore) Calls() []Call {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]Call, len(s.calls))
	for i, call := range s.calls {
		out[i] = cloneCall(call)
	}
	return out
}

// Put stores a payload copy and returns a version-aware reference.
func (s *FakeStore) Put(_ context.Context, input store.PutInput) (store.ObjectRef, error) {
	if err := input.Ref.Validate(); err != nil {
		return store.ObjectRef{}, err
	}
	if input.Ref.VersionID != "" {
		return store.ObjectRef{}, store.ErrInvalidObjectRef
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLocked()
	s.recordLocked(Call{
		Operation:   OperationPut,
		Ref:         input.Ref,
		Payload:     cloneBytes(input.Payload),
		ContentType: input.ContentType,
		Metadata:    cloneMetadata(input.Metadata),
	})
	if err := s.failureLocked(OperationPut); err != nil {
		return store.ObjectRef{}, err
	}

	s.seq++
	ref := input.Ref
	ref.VersionID = fmt.Sprintf("v%020d", s.seq)
	name := objectName{bucket: ref.Bucket, key: ref.Key}
	s.latest[name] = ref.VersionID
	s.objects[objectVersion{name: name, version: ref.VersionID}] = storedObject{
		ref:         ref,
		payload:     cloneBytes(input.Payload),
		contentType: input.ContentType,
		metadata:    cloneMetadata(input.Metadata),
	}
	return ref, nil
}

// Get returns a bounded payload copy. MaxBytes must be positive.
func (s *FakeStore) Get(_ context.Context, input store.GetInput) (*store.GetOutput, error) {
	if err := input.Ref.Validate(); err != nil {
		return nil, err
	}
	if input.MaxBytes <= 0 {
		return nil, store.ErrInvalidGetLimit
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLocked()
	s.recordLocked(Call{Operation: OperationGet, Ref: input.Ref, MaxBytes: input.MaxBytes})
	if err := s.failureLocked(OperationGet); err != nil {
		return nil, err
	}

	obj, ok := s.objectLocked(input.Ref)
	if !ok {
		return nil, store.ErrObjectNotFound
	}
	if int64(len(obj.payload)) > input.MaxBytes {
		return nil, store.ErrObjectTooLarge
	}
	return &store.GetOutput{
		Ref:         obj.ref,
		Payload:     cloneBytes(obj.payload),
		ContentType: obj.contentType,
		Metadata:    cloneMetadata(obj.metadata),
	}, nil
}

// Delete removes the referenced object. An unversioned ref removes all versions for the bucket/key.
func (s *FakeStore) Delete(_ context.Context, input store.DeleteInput) error {
	if err := input.Ref.Validate(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLocked()
	s.recordLocked(Call{Operation: OperationDelete, Ref: input.Ref})
	if err := s.failureLocked(OperationDelete); err != nil {
		return err
	}

	name := objectName{bucket: input.Ref.Bucket, key: input.Ref.Key}
	if input.Ref.VersionID == "" {
		delete(s.latest, name)
		for key := range s.objects {
			if key.name == name {
				delete(s.objects, key)
			}
		}
		return nil
	}

	delete(s.objects, objectVersion{name: name, version: input.Ref.VersionID})
	if s.latest[name] == input.Ref.VersionID {
		delete(s.latest, name)
	}
	return nil
}

func (s *FakeStore) ensureLocked() {
	if s.latest == nil {
		s.latest = make(map[objectName]string)
	}
	if s.objects == nil {
		s.objects = make(map[objectVersion]storedObject)
	}
	if s.failures == nil {
		s.failures = make(map[Operation]error)
	}
}

func (s *FakeStore) objectLocked(ref store.ObjectRef) (storedObject, bool) {
	name := objectName{bucket: ref.Bucket, key: ref.Key}
	version := ref.VersionID
	if version == "" {
		version = s.latest[name]
	}
	if version == "" {
		return storedObject{}, false
	}
	obj, ok := s.objects[objectVersion{name: name, version: version}]
	return obj, ok
}

func (s *FakeStore) recordLocked(call Call) {
	s.calls = append(s.calls, cloneCall(call))
}

func (s *FakeStore) failureLocked(operation Operation) error {
	return s.failures[operation]
}

func cloneCall(call Call) Call {
	call.Payload = cloneBytes(call.Payload)
	call.Metadata = cloneMetadata(call.Metadata)
	return call
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
	keys := make([]string, 0, len(in))
	for k := range in {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out[k] = in[k]
	}
	return out
}
