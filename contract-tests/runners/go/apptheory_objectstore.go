package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	store "github.com/theory-cloud/apptheory/v4/pkg/objectstore"
	storetest "github.com/theory-cloud/apptheory/v4/testkit/objectstore"
)

const fixtureBackendFake = "fake"

type FixtureObjectStoreSetup struct {
	Backend string `json:"backend,omitempty"`
}

type FixtureObjectStoreInput struct {
	Steps []FixtureObjectStoreStep `json:"steps"`
}

type FixtureObjectStoreStep struct {
	Name           string            `json:"name"`
	Operation      string            `json:"operation"`
	Ref            json.RawMessage   `json:"ref,omitempty"`
	Payload        *FixtureBody      `json:"payload,omitempty"`
	ContentType    string            `json:"content_type,omitempty"`
	Metadata       map[string]string `json:"metadata,omitempty"`
	MaxBytes       int64             `json:"max_bytes,omitempty"`
	ChecksumSHA256 string            `json:"checksum_sha256,omitempty"`
	Bucket         string            `json:"bucket,omitempty"`
	Key            string            `json:"key,omitempty"`
	Prefix         string            `json:"prefix,omitempty"`

	// ContentLength and ExpiresIn are decoded as json.Number rather than int64 because the
	// fail-closed corpus probes mistyped (non-integer) values for them. The Go grant input is
	// int64-typed, so a fractional byte count or expiry cannot reach PresignPut at all; decoding is
	// that type boundary, and it reports ErrInvalidPresignPut so Go refuses such a field with the
	// same stable code the TypeScript and Python runtimes report.
	ContentLength json.Number `json:"content_length,omitempty"`
	ExpiresIn     json.Number `json:"expires_in,omitempty"`
}

// objectStoreStepInteger converts an optional fixture integer field, refusing anything that is not
// an integer literal. An absent field reads as zero, which the grant validation then refuses.
func objectStoreStepInteger(raw json.Number) (int64, bool) {
	if raw == "" {
		return 0, true
	}
	value, err := strconv.ParseInt(string(raw), 10, 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

func runFixtureObjectStore(f Fixture) error {
	backend := strings.TrimSpace(f.Setup.ObjectStore.Backend)
	if backend == "" {
		backend = fixtureBackendFake
	}
	if backend != fixtureBackendFake {
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
	case "presign_put":
		ref, err := objectStoreStepRef(step)
		if err != nil {
			return objectStoreStepResult(result, store.ObjectRef{}, nil, err)
		}
		contentLength, ok := objectStoreStepInteger(step.ContentLength)
		if !ok {
			return objectStoreStepResult(result, store.ObjectRef{}, nil, store.ErrInvalidPresignPut)
		}
		expiresIn, ok := objectStoreStepInteger(step.ExpiresIn)
		if !ok {
			return objectStoreStepResult(result, store.ObjectRef{}, nil, store.ErrInvalidPresignPut)
		}
		grant, err := fake.PresignPut(context.Background(), store.PresignPutInput{
			Ref:            ref,
			ContentLength:  contentLength,
			ChecksumSHA256: step.ChecksumSHA256,
			ContentType:    step.ContentType,
			MaxBytes:       step.MaxBytes,
			ExpiresIn:      time.Duration(expiresIn) * time.Second,
		})
		if err != nil {
			return objectStoreStepResult(result, store.ObjectRef{}, nil, err)
		}
		return objectStoreGrantResult(result, grant)
	case "list", "presign", "presign_get", "multipart", "copy", "head", "raw_client":
		return objectStoreStepResult(result, store.ObjectRef{}, nil, forbiddenObjectStoreOperationError(fake, operation))
	default:
		return objectStoreStepResult(result, store.ObjectRef{}, nil, fmt.Errorf("objectstore: unsupported operation: %s", operation))
	}
}

func objectStoreGrantResult(result map[string]any, grant *store.PresignPutOutput) map[string]any {
	result["ok"] = true
	result["ref"] = objectStoreRefJSON(grant.Ref)
	result["url"] = grant.URL
	result["method"] = grant.Method
	result["headers"] = cloneObjectStoreStringMap(grant.Headers)
	result["expires_at"] = grant.ExpiresAt.UTC().Format(time.RFC3339)
	return result
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
	case errors.Is(err, store.ErrInvalidPresignPut):
		code = "objectstore.invalid_presign_put"
	case strings.HasPrefix(err.Error(), "objectstore: unsupported operation"):
		code = "objectstore.unsupported_operation"
	}
	return map[string]string{"code": code, "message": err.Error()}
}

// forbiddenObjectStoreOperationError proves a forbidden operation is absent from the object-store
// surface, not merely unimplemented by the fixture runner.
//
// The upload grant is the one authorized presigning exception, so the generic presign family is
// asserted absent while PresignPut is asserted to be the only presign-family method on the
// surfaces. Every other family must be absent outright.
func forbiddenObjectStoreOperationError(fake *storetest.FakeStore, operation string) error {
	methodNames := map[string][]string{
		"list":        {"List", "ListObjects"},
		"presign":     {"Presign", "PresignGet", "PresignGetObject", "PresignURL", "PublicURL"},
		"presign_get": {"PresignGet", "PresignGetObject", "PresignURL", "PublicURL"},
		"multipart":   {"Multipart", "CreateMultipartUpload", "UploadPart", "CompleteMultipartUpload", "AbortMultipartUpload"},
		"copy":        {"Copy", "CopyObject"},
		"head":        {"Head", "HeadObject"},
		"raw_client":  {"Client", "RawClient", "S3Client"},
	}
	for _, method := range methodNames[operation] {
		if objectStoreMethodExists(method, fake) {
			return fmt.Errorf("objectstore: forbidden operation exposed: %s", operation)
		}
	}
	if operation == "presign" {
		if err := narrowPresignPutSurfaceError(fake); err != nil {
			return err
		}
	}
	return fmt.Errorf("objectstore: unsupported operation: %s", operation)
}

const presignPutGrantMethod = "PresignPut"

// narrowPresignPutSurfaceError proves the sanctioned grant is the only presign-shaped method on
// both the bounded Store contract and the fake store.
func narrowPresignPutSurfaceError(fake *storetest.FakeStore) error {
	found := map[string]bool{}
	for _, name := range objectStoreMethodNames(reflect.TypeOf((*store.Store)(nil)).Elem(), nil) {
		if isPresignFamilyMethod(name) {
			found[name] = true
		}
	}
	for _, name := range objectStoreMethodNames(nil, fake) {
		if isPresignFamilyMethod(name) {
			found[name] = true
		}
	}
	for name := range found {
		if name != presignPutGrantMethod {
			return fmt.Errorf("objectstore: forbidden presign surface exposed: %s", name)
		}
	}
	if !found[presignPutGrantMethod] {
		return fmt.Errorf("objectstore: upload grant surface missing: %s", presignPutGrantMethod)
	}
	if _, ok := reflect.TypeOf((*store.UploadGranter)(nil)).Elem().MethodByName(presignPutGrantMethod); !ok {
		return fmt.Errorf("objectstore: upload grant surface missing from UploadGranter: %s", presignPutGrantMethod)
	}
	return nil
}

func isPresignFamilyMethod(name string) bool {
	lowered := strings.ToLower(name)
	return strings.Contains(lowered, "presign") || lowered == "publicurl" || lowered == "signedurl"
}

func objectStoreMethodNames(interfaceType reflect.Type, fake *storetest.FakeStore) []string {
	names := make([]string, 0, 32)
	if interfaceType != nil {
		for index := 0; index < interfaceType.NumMethod(); index++ {
			names = append(names, interfaceType.Method(index).Name)
		}
	}
	if fake != nil {
		fakeType := reflect.TypeOf(fake)
		for index := 0; index < fakeType.NumMethod(); index++ {
			names = append(names, fakeType.Method(index).Name)
		}
	}
	return names
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
		if call.ContentLength != 0 {
			item["content_length"] = call.ContentLength
		}
		if call.ChecksumSHA256 != "" {
			item["checksum_sha256"] = call.ChecksumSHA256
		}
		if call.ExpiresIn != 0 {
			item["expires_in"] = call.ExpiresIn
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
