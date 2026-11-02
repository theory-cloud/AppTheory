package localrunner

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestProvisionBucketsCreatesDeclaredBuckets(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		paths = append(paths, request.URL.Path)
		mu.Unlock()
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"s3proxy": {
				Alias:     "s3proxy",
				Endpoints: []Endpoint{{Service: "s3"}},
				HostURL:   server.URL,
			},
		},
		resourceValues: resourceValues{},
	}
	spec := &Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Bucket", Type: typeS3Bucket,
		Properties: json.RawMessage(`{"BucketName":"explicit-bucket"}`),
	}}}
	if err := runner.provisionBuckets(context.Background(), spec); err != nil {
		t.Fatalf("provision buckets: %v", err)
	}
	value, ok := runner.resourceValues["Stack/Bucket"]
	if !ok || value.Name != "explicit-bucket" || value.ARN != "arn:aws:s3:::explicit-bucket" {
		t.Fatalf("unexpected provisioned bucket: %+v", runner.resourceValues)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(paths) != 1 || !strings.Contains(paths[0], "explicit-bucket") {
		t.Fatalf("create-bucket path not observed: %v", paths)
	}
}

func TestProvisionKeysCreatesDeclaredKeys(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body) //nolint:errcheck // the request body is diagnostic
		if !strings.Contains(string(body), "data key") {
			t.Errorf("description was not sent: %s", body)
		}
		writer.Header().Set("content-type", "application/x-amz-json-1.1")
		if _, err := writer.Write([]byte(`{"KeyMetadata":{"KeyId":"local-key-id","Arn":"arn:aws:kms:us-east-1:123456789012:key/local-key-id"}}`)); err != nil {
			t.Errorf("write key response: %v", err)
		}
	}))
	defer server.Close()

	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {
				Alias:     "moto",
				Endpoints: []Endpoint{{Service: "kms"}},
				HostURL:   server.URL,
			},
		},
		resourceValues: resourceValues{},
	}
	spec := &Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Key", Type: typeKMSKey,
		Properties: json.RawMessage(`{"Description":"data key"}`),
	}}}
	if err := runner.provisionKeys(context.Background(), spec); err != nil {
		t.Fatalf("provision keys: %v", err)
	}
	value, ok := runner.resourceValues["Stack/Key"]
	if !ok || value.KeyID != "local-key-id" || value.ARN != "arn:aws:kms:us-east-1:123456789012:key/local-key-id" {
		t.Fatalf("unexpected provisioned key: %+v", runner.resourceValues)
	}
}

func TestProvisioningWithoutBackendsDoesNothing(t *testing.T) {
	runner := &Runner{options: Options{Stdout: io.Discard}, resourceValues: resourceValues{}}
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "Stack", LogicalID: "Bucket", Type: typeS3Bucket},
		{Stack: "Stack", LogicalID: "Key", Type: typeKMSKey},
	}}
	if err := runner.provisionResources(context.Background(), spec); err != nil {
		t.Fatalf("provision without backends: %v", err)
	}
	if len(runner.resourceValues) != 0 {
		t.Fatalf("nothing may be provisioned without a backend: %+v", runner.resourceValues)
	}
}

func TestResourceDescriptionAndAlreadyExists(t *testing.T) {
	description, err := resourceDescription(ResourceSpec{LogicalID: "Key"})
	if err != nil || !strings.Contains(description, "Key") {
		t.Fatalf("default description: %q %v", description, err)
	}
	if !alreadyExists(errString("BucketAlreadyOwnedByYou")) || alreadyExists(errString("AccessDenied")) {
		t.Fatal("alreadyExists must recognize only an existing bucket")
	}
}

type errString string

func (e errString) Error() string { return string(e) }
