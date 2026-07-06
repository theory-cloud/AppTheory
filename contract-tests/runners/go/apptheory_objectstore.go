package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"unicode/utf8"

	store "github.com/theory-cloud/apptheory/pkg/objectstore"
	storetest "github.com/theory-cloud/apptheory/testkit/objectstore"
)

type FixtureObjectStoreSetup struct {
	Backend string `json:"backend,omitempty"`
}

type FixtureObjectStoreInput struct {
	Steps []FixtureObjectStoreStep `json:"steps"`
}

type FixtureObjectStoreStep struct {
	Name        string            `json:"name"`
	Operation   string            `json:"operation"`
	Ref         json.RawMessage   `json:"ref,omitempty"`
	Payload     *FixtureBody      `json:"payload,omitempty"`
	ContentType string            `json:"content_type,omitempty"`
	Metadata    map[string]string `json:"metadata,omitempty"`
	MaxBytes    int64             `json:"max_bytes,omitempty"`
	Bucket      string            `json:"bucket,omitempty"`
	Key         string            `json:"key,omitempty"`
	Prefix      string            `json:"prefix,omitempty"`
}

func runFixtureObjectStore(f Fixture) error {
	backend := strings.TrimSpace(f.Setup.ObjectStore.Backend)
	if backend == "" {
		backend = "fake"
	}
	if backend != "fake" {
		return fmt.Errorf("objectstore fixture backend %q is unsupported", backend)
	}
	if len(f.Input.ObjectStore.Steps) == 0 {
		return errors.New("objectstore fixture missing input.objectstore.steps")
	}

	fake := storetest.NewStore()
	steps := make([]map[string]any, 0, len(f.Input.ObjectStore.Steps))
	for _, step := range f.Input.ObjectStore.Steps {
		steps = append(steps, runObjectStoreStep(fake, step))
	}

	out := map[string]any{
		"steps": steps,
		"calls": objectStoreCallsJSON(fake.Calls()),
	}
	return compareFixtureOutputJSON(f, out)
}

func runObjectStoreStep(fake *storetest.FakeStore, step FixtureObjectStoreStep) map[string]any {
	operation := strings.TrimSpace(strings.ToLower(step.Operation))
	result := map[string]any{
		"name":      step.Name,
		"operation": operation,
	}

	switch operation {
	case "parse_ref":
		ref, err := objectStoreStepRef(step)
		return objectStoreStepResult(result, ref, nil, err)
	case "put":
		ref, err := objectStoreStepRef(step)
		if err != nil {
			return objectStoreStepResult(result, store.ObjectRef{}, nil, err)
		}
		payload, err := objectStoreStepPayload(step)
		if err != nil {
			return objectStoreStepResult(result, store.ObjectRef{}, nil, err)
		}
		storedRef, err := fake.Put(context.Background(), store.PutInput{
			Ref:         ref,
			Payload:     payload,
			ContentType: step.ContentType,
			Metadata:    cloneObjectStoreStringMap(step.Metadata),
		})
		return objectStoreStepResult(result, storedRef, nil, err)
	case "get":
		ref, err := objectStoreStepRef(step)
		if err != nil {
			return objectStoreStepResult(result, store.ObjectRef{}, nil, err)
		}
		got, err := fake.Get(context.Background(), store.GetInput{Ref: ref, MaxBytes: step.MaxBytes})
		return objectStoreStepResult(result, store.ObjectRef{}, got, err)
	case "delete":
		ref, err := objectStoreStepRef(step)
		if err != nil {
			return objectStoreStepResult(result, store.ObjectRef{}, nil, err)
		}
		err = fake.Delete(context.Background(), store.DeleteInput{Ref: ref})
		return objectStoreStepResult(result, store.ObjectRef{}, nil, err)
	case "list", "presign", "multipart":
		return objectStoreStepResult(result, store.ObjectRef{}, nil, forbiddenObjectStoreOperationError(fake, operation))
	default:
		return objectStoreStepResult(result, store.ObjectRef{}, nil, fmt.Errorf("objectstore: unsupported operation: %s", operation))
	}
}

func objectStoreStepResult(result map[string]any, ref store.ObjectRef, output *store.GetOutput, err error) map[string]any {
	if err != nil {
		result["ok"] = false
		result["error"] = objectStoreErrorJSON(err)
		return result
	}
	result["ok"] = true
	if output != nil {
		result["ref"] = objectStoreRefJSON(output.Ref)
		result["payload"] = objectStoreBodyJSON(output.Payload)
		if output.ContentType != "" {
			result["content_type"] = output.ContentType
		}
		if len(output.Metadata) > 0 {
			result["metadata"] = cloneObjectStoreStringMap(output.Metadata)
		}
		return result
	}
	if ref.Bucket != "" || ref.Key != "" || ref.VersionID != "" {
		result["ref"] = objectStoreRefJSON(ref)
	}
	return result
}

func objectStoreStepRef(step FixtureObjectStoreStep) (store.ObjectRef, error) {
	if len(step.Ref) == 0 || string(step.Ref) == "null" {
		return store.ObjectRef{}, store.ErrInvalidObjectRef
	}
	var raw string
	if err := json.Unmarshal(step.Ref, &raw); err == nil {
		return store.ParseObjectRef(raw)
	}
	var ref struct {
		Bucket    string `json:"bucket"`
		Key       string `json:"key"`
		VersionID string `json:"version_id"`
	}
	if err := json.Unmarshal(step.Ref, &ref); err != nil {
		return store.ObjectRef{}, store.ErrInvalidObjectRef
	}
	out := store.ObjectRef{Bucket: ref.Bucket, Key: ref.Key, VersionID: ref.VersionID}
	if err := out.Validate(); err != nil {
		return store.ObjectRef{}, err
	}
	return out, nil
}

func objectStoreStepPayload(step FixtureObjectStoreStep) ([]byte, error) {
	if step.Payload == nil {
		return nil, nil
	}
	return decodeFixtureBody(*step.Payload)
}

func objectStoreErrorJSON(err error) map[string]string {
	code := "objectstore.error"
	switch {
	case errors.Is(err, store.ErrInvalidObjectRef):
		code = "objectstore.invalid_ref"
	case errors.Is(err, store.ErrInvalidGetLimit):
		code = "objectstore.invalid_get_limit"
	case errors.Is(err, store.ErrObjectTooLarge):
		code = "objectstore.object_too_large"
	case errors.Is(err, store.ErrObjectNotFound):
		code = "objectstore.not_found"
	case strings.HasPrefix(err.Error(), "objectstore: unsupported operation"):
		code = "objectstore.unsupported_operation"
	}
	return map[string]string{"code": code, "message": err.Error()}
}

func forbiddenObjectStoreOperationError(fake *storetest.FakeStore, operation string) error {
	methodNames := map[string][]string{
		"list":      {"List", "ListObjects"},
		"presign":   {"Presign", "PresignGet", "PresignPut", "PublicURL"},
		"multipart": {"Multipart", "CreateMultipartUpload", "UploadPart", "CompleteMultipartUpload", "AbortMultipartUpload"},
	}
	for _, method := range methodNames[operation] {
		if objectStoreMethodExists(method, fake) {
			return fmt.Errorf("objectstore: forbidden operation exposed: %s", operation)
		}
	}
	return fmt.Errorf("objectstore: unsupported operation: %s", operation)
}

func objectStoreMethodExists(method string, fake *storetest.FakeStore) bool {
	if _, ok := reflect.TypeOf((*store.Store)(nil)).Elem().MethodByName(method); ok {
		return true
	}
	if fake != nil {
		if _, ok := reflect.TypeOf(fake).MethodByName(method); ok {
			return true
		}
	}
	return false
}

func objectStoreCallsJSON(calls []storetest.Call) []map[string]any {
	out := make([]map[string]any, 0, len(calls))
	for _, call := range calls {
		item := map[string]any{
			"operation": string(call.Operation),
			"ref":       objectStoreRefJSON(call.Ref),
		}
		if call.MaxBytes != 0 {
			item["max_bytes"] = call.MaxBytes
		}
		if call.Payload != nil {
			item["payload"] = objectStoreBodyJSON(call.Payload)
		}
		if call.ContentType != "" {
			item["content_type"] = call.ContentType
		}
		if len(call.Metadata) > 0 {
			item["metadata"] = cloneObjectStoreStringMap(call.Metadata)
		}
		out = append(out, item)
	}
	return out
}

func objectStoreRefJSON(ref store.ObjectRef) map[string]string {
	out := map[string]string{
		"bucket": ref.Bucket,
		"key":    ref.Key,
	}
	if ref.VersionID != "" {
		out["version_id"] = ref.VersionID
	}
	return out
}

func objectStoreBodyJSON(payload []byte) map[string]string {
	if utf8.Valid(payload) {
		return map[string]string{"encoding": "utf8", "value": string(payload)}
	}
	return map[string]string{"encoding": "base64", "value": base64.StdEncoding.EncodeToString(payload)}
}

func cloneObjectStoreStringMap(in map[string]string) map[string]string {
	if len(in) == 0 {
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
