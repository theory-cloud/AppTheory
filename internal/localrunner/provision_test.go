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

// TestProvisionKeysTagsOnlyTheFront is the Adv-4 proof: the identity tag is
// how the runner's KMS front finds persisted material, and the front strips it
// before moto sees the request. A caller-supplied --endpoint kms=... is never
// fronted, so no tag may be sent there: v7.0.0 stored none.
func TestProvisionKeysTagsOnlyTheFront(t *testing.T) {
	for name, fronted := range map[string]bool{
		"profile endpoint behind the front": true,
		"caller endpoint without a front":   false,
	} {
		t.Run(name, func(t *testing.T) {
			var mu sync.Mutex
			var bodies []string
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				body, _ := io.ReadAll(request.Body) //nolint:errcheck // the request body is diagnostic
				mu.Lock()
				bodies = append(bodies, string(body))
				mu.Unlock()
				writer.Header().Set("content-type", "application/x-amz-json-1.1")
				_, _ = writer.Write([]byte(`{"KeyMetadata":{"KeyId":"local-key-id","Arn":"arn:aws:kms:us-east-1:123456789012:key/local-key-id"}}`)) //nolint:errcheck // fixture
			}))
			defer server.Close()
			runner := &Runner{
				options: Options{Stdout: io.Discard},
				backends: map[string]backendProcess{
					"moto": {Alias: "moto", Endpoints: []Endpoint{{Service: "kms"}}, HostURL: server.URL},
				},
				resourceValues: resourceValues{},
			}
			var front *kmsFront
			if fronted {
				var err error
				front, err = newKMSFront("", server.URL, nil)
				if err != nil {
					t.Fatalf("new KMS front: %v", err)
				}
				frontServer := httptest.NewServer(front)
				defer frontServer.Close()
				front.hostURL = frontServer.URL
				runner.kmsFront = front
			}
			spec := &Spec{Resources: []ResourceSpec{{Stack: "Stack", LogicalID: "Key", Type: typeKMSKey}}}
			if err := runner.provisionKeys(context.Background(), spec); err != nil {
				t.Fatalf("provision keys: %v", err)
			}
			mu.Lock()
			seen := append([]string(nil), bodies...)
			mu.Unlock()
			if len(seen) != 1 {
				t.Fatalf("the endpoint saw %d CreateKey requests: %v", len(seen), seen)
			}
			if strings.Contains(seen[0], kmsFrontIdentityTag) {
				t.Fatalf("the identity tag reached the endpoint: %s", seen[0])
			}
			if fronted && front.store.identify("Stack/Key") == nil {
				t.Fatal("the front did not receive its identity tag")
			}
		})
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
