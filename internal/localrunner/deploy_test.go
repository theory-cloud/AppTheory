package localrunner

import (
	"archive/zip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type deploymentStub struct {
	mu      sync.Mutex
	puts    map[string]deploymentPut
	lists   int
	deletes []string
}

type deploymentPut struct {
	contentType  string
	cacheControl string
	metadata     map[string]string
	body         string
}

func newDeploymentRunner(t *testing.T, assembly string, resources []ResourceSpec) (*Runner, *deploymentStub) {
	t.Helper()
	stub := &deploymentStub{puts: map[string]deploymentPut{}}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		stub.mu.Lock()
		defer stub.mu.Unlock()
		switch {
		case request.Method == http.MethodPut:
			body, _ := io.ReadAll(request.Body) //nolint:errcheck // test body
			stub.puts[request.URL.Path] = deploymentPut{
				contentType:  request.Header.Get("Content-Type"),
				cacheControl: request.Header.Get("Cache-Control"),
				metadata:     map[string]string{"owner": request.Header.Get("X-Amz-Meta-Owner")},
				body:         string(body),
			}
			writer.WriteHeader(http.StatusOK)
		case request.Method == http.MethodGet && request.URL.Query().Get("list-type") == "2":
			stub.lists++
			writer.Header().Set("Content-Type", "application/xml")
			response := `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<Name>bucket</Name><Prefix>assets</Prefix><KeyCount>2</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>
<Contents><Key>assets/stale.txt</Key><Size>1</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>"e"</ETag><StorageClass>STANDARD</StorageClass></Contents>
<Contents><Key>assets/new.txt</Key><Size>1</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>"e"</ETag><StorageClass>STANDARD</StorageClass></Contents>
</ListBucketResult>`
			_, _ = writer.Write([]byte(response)) //nolint:errcheck // test response fixture
		case request.Method == http.MethodPost && request.URL.Query().Has("delete"):
			body, _ := io.ReadAll(request.Body) //nolint:errcheck // test body
			stub.deletes = append(stub.deletes, string(body))
			writer.Header().Set("Content-Type", "application/xml")
			_, _ = writer.Write([]byte(`<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"></DeleteResult>`)) //nolint:errcheck // test response fixture
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"s3proxy": {
				Alias:     "s3proxy",
				Endpoints: []Endpoint{{Service: "s3"}},
				HostURL:   server.URL,
			},
		},
		resourceValues: resourceValues{
			"Stack/Bucket": {Type: typeS3Bucket, Name: "bucket"},
		},
	}
	spec := &Spec{AssemblyDir: assembly, Resources: resources}
	spec.Resources = append([]ResourceSpec{{Stack: "Stack", LogicalID: "Bucket", Type: typeS3Bucket}}, resources...)
	if err := runner.provisionDeployments(context.Background(), spec); err != nil {
		t.Fatalf("provision deployments: %v", err)
	}
	return runner, stub
}

func writeAssemblyAsset(t *testing.T, assembly, stack string, files map[string]string) {
	t.Helper()
	assetDir := filepath.Join(assembly, "asset.abc")
	for name, content := range files {
		full := filepath.Join(assetDir, name)
		if err := os.MkdirAll(filepath.Dir(full), 0o750); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(full, []byte(content), 0o600); err != nil {
			t.Fatalf("write asset: %v", err)
		}
	}
	manifest := map[string]any{
		"files": map[string]any{
			"hash": map[string]any{
				"source": map[string]any{"path": "asset.abc", "packaging": "zip"},
				"destinations": map[string]any{
					"current_account-current_region": map[string]any{"objectKey": "hash.zip"},
				},
			},
		},
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(assembly, stack+".assets.json"), raw, 0o600); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
}

func TestProvisionDeploymentsCopiesAssetSourcesWithMetadata(t *testing.T) {
	assembly := t.TempDir()
	writeAssemblyAsset(t, assembly, "Stack", map[string]string{"app.js": "console.log(1)\n", "index.html": "<h1>hi</h1>"})
	resource := ResourceSpec{
		Stack: "Stack", LogicalID: "Deployment", Type: typeBucketDeploy,
		Properties: json.RawMessage(`{
			"SourceObjectKeys": ["hash.zip"],
			"DestinationBucketName": {"Ref":"Bucket"},
			"DestinationBucketKeyPrefix": "assets",
			"Prune": false,
			"SystemMetadata": {"cache-control":"public, max-age=60"},
			"UserMetadata": {"Owner":"example"}
		}`),
	}
	_, stub := newDeploymentRunner(t, assembly, []ResourceSpec{resource})
	put, ok := stub.puts["/bucket/assets/app.js"]
	if !ok {
		t.Fatalf("app.js was not uploaded: %+v", stub.puts)
	}
	if put.contentType != "text/javascript" || put.cacheControl != "public, max-age=60" {
		t.Fatalf("metadata = %+v", put)
	}
	if put.metadata["owner"] != "example" {
		t.Fatalf("user metadata = %+v", put.metadata)
	}
	if put.body != "console.log(1)\n" {
		t.Fatalf("body = %q", put.body)
	}
	if put, ok := stub.puts["/bucket/assets/index.html"]; !ok || put.contentType != "text/html" {
		t.Fatalf("index.html upload = %+v", stub.puts)
	}
}

func TestProvisionDeploymentsPrunesObjectsNotInTheDeployment(t *testing.T) {
	assembly := t.TempDir()
	writeAssemblyAsset(t, assembly, "Stack", map[string]string{"new.txt": "new"})
	resource := ResourceSpec{
		Stack: "Stack", LogicalID: "Deployment", Type: typeBucketDeploy,
		Properties: json.RawMessage(`{
			"SourceObjectKeys": ["hash.zip"],
			"DestinationBucketName": {"Ref":"Bucket"},
			"DestinationBucketKeyPrefix": "assets",
			"Prune": true
		}`),
	}
	_, stub := newDeploymentRunner(t, assembly, []ResourceSpec{resource})
	if stub.lists == 0 {
		t.Fatal("prune did not list the bucket")
	}
	if len(stub.deletes) != 1 || !strings.Contains(stub.deletes[0], "assets/stale.txt") || strings.Contains(stub.deletes[0], "assets/new.txt") {
		t.Fatalf("deletes = %+v", stub.deletes)
	}
}

func TestProvisionDeploymentsRefusesUnknownSourcesAndPatterns(t *testing.T) {
	assembly := t.TempDir()
	writeAssemblyAsset(t, assembly, "Stack", map[string]string{"new.txt": "new"})
	cases := []struct {
		name  string
		props string
		want  string
	}{
		{
			name:  "unknown source",
			props: `{"SourceObjectKeys":["missing.zip"],"DestinationBucketName":{"Ref":"Bucket"}}`,
			want:  "not an asset in this assembly",
		},
		{
			name:  "include pattern",
			props: `{"SourceObjectKeys":["hash.zip"],"DestinationBucketName":{"Ref":"Bucket"},"Include":["*.txt"]}`,
			want:  "Include/Exclude",
		},
		{
			name:  "extract false",
			props: `{"SourceObjectKeys":["hash.zip"],"DestinationBucketName":{"Ref":"Bucket"},"Extract":false}`,
			want:  "Extract=false",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			resource := ResourceSpec{
				Stack: "Stack", LogicalID: "Deployment", Type: typeBucketDeploy,
				Properties: json.RawMessage(testCase.props),
			}
			server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				t.Error("a refused deployment must not contact S3")
			}))
			defer server.Close()
			runner := &Runner{
				options:  Options{Stdout: io.Discard},
				backends: map[string]backendProcess{"s3proxy": {HostURL: server.URL, Endpoints: []Endpoint{{Service: "s3"}}}},
				resourceValues: resourceValues{
					"Stack/Bucket": {Type: typeS3Bucket, Name: "bucket"},
				},
			}
			spec := &Spec{AssemblyDir: assembly, Resources: []ResourceSpec{resource}}
			err := runner.provisionDeployments(context.Background(), spec)
			if err == nil || !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("err = %v, want %q", err, testCase.want)
			}
		})
	}
}

func TestProvisionDeploymentsRequiresAProvisionedBucket(t *testing.T) {
	assembly := t.TempDir()
	writeAssemblyAsset(t, assembly, "Stack", map[string]string{"new.txt": "new"})
	runner := &Runner{
		options:        Options{Stdout: io.Discard},
		backends:       map[string]backendProcess{"s3proxy": {HostURL: "http://127.0.0.1:1", Endpoints: []Endpoint{{Service: "s3"}}}},
		resourceValues: resourceValues{},
	}
	resource := ResourceSpec{
		Stack: "Stack", LogicalID: "Deployment", Type: typeBucketDeploy,
		Properties: json.RawMessage(`{"SourceObjectKeys":["hash.zip"],"DestinationBucketName":{"Ref":"Bucket"}}`),
	}
	err := runner.provisionDeployments(context.Background(), &Spec{AssemblyDir: assembly, Resources: []ResourceSpec{resource}})
	if err == nil || !strings.Contains(err.Error(), "was not provisioned") {
		t.Fatalf("err = %v", err)
	}
}

func TestDeploymentContentType(t *testing.T) {
	cases := map[string]string{
		"a.html": "text/html", "a.css": "text/css", "a.js": "text/javascript",
		"a.json": "application/json", "a.txt": "text/plain", "a.svg": "image/svg+xml",
		"a.unknown": "application/octet-stream",
	}
	for key, want := range cases {
		if got := deploymentContentType(key, nil); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
	if got := deploymentContentType("a.bin", map[string]string{"content-type": "application/custom"}); got != "application/custom" {
		t.Fatalf("declared content type = %q", got)
	}
}

func TestProvisionDeploymentsCopiesAZipSource(t *testing.T) {
	assembly := t.TempDir()
	zipPath := filepath.Join(assembly, "asset.zip")
	zipFile, err := os.Create(zipPath) //nolint:gosec // test fixture path under t.TempDir
	if err != nil {
		t.Fatalf("create zip: %v", err)
	}
	archive := zip.NewWriter(zipFile)
	entry, err := archive.Create("assets/app.js")
	if err != nil {
		t.Fatalf("create zip entry: %v", err)
	}
	if _, writeErr := entry.Write([]byte("console.log(1)\n")); writeErr != nil {
		t.Fatalf("write zip entry: %v", writeErr)
	}
	if closeErr := archive.Close(); closeErr != nil {
		t.Fatalf("close zip: %v", closeErr)
	}
	if closeErr := zipFile.Close(); closeErr != nil {
		t.Fatalf("close zip file: %v", closeErr)
	}
	manifest := map[string]any{
		"files": map[string]any{
			"hash": map[string]any{
				"source": map[string]any{"path": "asset.zip", "packaging": "zip"},
				"destinations": map[string]any{
					"current_account-current_region": map[string]any{"objectKey": "hash.zip"},
				},
			},
		},
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(assembly, "Stack.assets.json"), raw, 0o600); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	resource := ResourceSpec{
		Stack: "Stack", LogicalID: "Deployment", Type: typeBucketDeploy,
		Properties: json.RawMessage(`{"SourceObjectKeys":["hash.zip"],"DestinationBucketName":{"Ref":"Bucket"}}`),
	}
	_, stub := newDeploymentRunner(t, assembly, []ResourceSpec{resource})
	put, ok := stub.puts["/bucket/assets/app.js"]
	if !ok || put.body != "console.log(1)\n" || put.contentType != "text/javascript" {
		t.Fatalf("zip upload = %+v", stub.puts)
	}
}

func TestProvisionDeploymentsWithoutTheS3BackendDoesNothing(t *testing.T) {
	runner := &Runner{options: Options{Stdout: io.Discard}}
	err := runner.provisionDeployments(context.Background(), &Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Deployment", Type: typeBucketDeploy,
	}}})
	if err != nil {
		t.Fatalf("provision without s3: %v", err)
	}
}

func TestProvisionDeploymentsRequiresTheAssetManifest(t *testing.T) {
	runner := &Runner{
		options:        Options{Stdout: io.Discard},
		backends:       map[string]backendProcess{"s3proxy": {HostURL: "http://127.0.0.1:1", Endpoints: []Endpoint{{Service: "s3"}}}},
		resourceValues: resourceValues{"Stack/Bucket": {Type: typeS3Bucket, Name: "bucket"}},
	}
	resource := ResourceSpec{
		Stack: "Stack", LogicalID: "Deployment", Type: typeBucketDeploy,
		Properties: json.RawMessage(`{"SourceObjectKeys":["hash.zip"],"DestinationBucketName":{"Ref":"Bucket"}}`),
	}
	err := runner.provisionDeployments(context.Background(), &Spec{AssemblyDir: t.TempDir(), Resources: []ResourceSpec{resource}})
	if err == nil || !strings.Contains(err.Error(), "read asset manifest") {
		t.Fatalf("err = %v", err)
	}
}

func TestDeploymentBucketRejectsANonReference(t *testing.T) {
	runner := &Runner{options: Options{Stdout: io.Discard}, resourceValues: resourceValues{}}
	_, err := runner.deploymentBucket(ResourceSpec{Stack: "Stack", LogicalID: "Deployment"}, bucketDeploymentProperties{
		DestinationBucketName: json.RawMessage(`"literal-bucket"`),
	})
	if err == nil || !strings.Contains(err.Error(), "direct reference") {
		t.Fatalf("err = %v", err)
	}
}

func TestPutDeploymentObjectRejectsAnInvalidExpires(t *testing.T) {
	runner := &Runner{options: Options{Stdout: io.Discard}}
	err := runner.putDeploymentObject(context.Background(), nil, "bucket", "key", []byte("x"), bucketDeploymentProperties{
		SystemMetadata: map[string]string{"expires": "not an HTTP date"},
	})
	if err == nil || !strings.Contains(err.Error(), "HTTP date") {
		t.Fatalf("err = %v", err)
	}
}
