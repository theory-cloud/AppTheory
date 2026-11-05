package localrunner

import (
	"path/filepath"
	"strings"
	"testing"
)

// Round-1 rework tests for the LOCAL-W2-R5b delta.

func keyValueStoreSpec(t *testing.T, dir string) *Spec {
	t.Helper()
	spec, err := deriveSpec(dir, mustLoadAssembly(t, dir))
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	return spec
}

func keyValueStoreResources() map[string]any {
	return map[string]any{
		"Store": map[string]any{
			"Type": "AWS::CloudFront::KeyValueStore",
			"Properties": map[string]any{
				"ImportSource": map[string]any{"SourceType": "S3", "SourceArn": "arn:aws:s3:::bucket/config.json"},
			},
		},
		"Distribution": map[string]any{
			"Type": typeCloudFront,
			"Properties": map[string]any{
				"DistributionConfig": map[string]any{
					"Enabled": true,
					"DefaultCacheBehavior": map[string]any{
						"PathPattern": "*", "TargetOriginId": "Origin",
						"CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
					},
					"Origins": []any{map[string]any{
						"Id": "Origin", "DomainName": "bucket.s3.local",
						"S3OriginConfig": map[string]any{"OriginAccessIdentity": ""},
					}},
				},
			},
		},
	}
}

// A-R5b-res: two assets sharing a final path segment are a named refusal, not a
// nondeterministic pick.
func TestMaterializeKeyValueStoreAmbiguousSuffixIsRefused(t *testing.T) {
	dir := writeAssembly(t, keyValueStoreResources())
	writeJSONFile(t, filepath.Join(dir, "TestStack.assets.json"), map[string]any{
		"version": "54.0.0",
		"files": map[string]any{
			"one": map[string]any{
				"source":       map[string]any{"path": "asset.kvs/a.json", "packaging": "file"},
				"destinations": map[string]any{"dest": map[string]any{"bucketName": "bucket", "objectKey": "a/config.json"}},
			},
			"two": map[string]any{
				"source":       map[string]any{"path": "asset.kvs/b.json", "packaging": "file"},
				"destinations": map[string]any{"dest": map[string]any{"bucketName": "bucket", "objectKey": "b/config.json"}},
			},
		},
	})
	spec := keyValueStoreSpec(t, dir)
	runner := &Runner{}
	if err := runner.materializeKeyValueStores(spec); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	store := spec.CloudFrontKeyValueStores[0]
	if store.Servable() {
		t.Fatal("an import source with two suffix matches must be refused")
	}
	refusals := strings.Join(store.Refusals, "\n")
	for _, needle := range []string{"more than one asset by suffix", "a/config.json", "b/config.json"} {
		if !strings.Contains(refusals, needle) {
			t.Fatalf("refusals do not contain %q: %v", needle, refusals)
		}
	}
}

// A-R5b-res: an exact object key wins over a suffix match.
func TestMaterializeKeyValueStorePrefersExactObjectKey(t *testing.T) {
	dir := writeAssembly(t, keyValueStoreResources())
	writeFile(t, filepath.Join(dir, "asset.kvs", "config.json"), `{"data":[{"key":"k","value":"v"}]}`)
	writeJSONFile(t, filepath.Join(dir, "TestStack.assets.json"), map[string]any{
		"version": "54.0.0",
		"files": map[string]any{
			"exact": map[string]any{
				"source":       map[string]any{"path": "asset.kvs/config.json", "packaging": "file"},
				"destinations": map[string]any{"dest": map[string]any{"bucketName": "bucket", "objectKey": "config.json"}},
			},
			"suffix": map[string]any{
				"source":       map[string]any{"path": "asset.kvs/a.json", "packaging": "file"},
				"destinations": map[string]any{"dest": map[string]any{"bucketName": "bucket", "objectKey": "a/config.json"}},
			},
		},
	})
	spec := keyValueStoreSpec(t, dir)
	runner := &Runner{}
	if err := runner.materializeKeyValueStores(spec); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	store := spec.CloudFrontKeyValueStores[0]
	if !store.Servable() {
		t.Fatalf("the exact object key must resolve: %v", store.Refusals)
	}
	if store.KeyCount() != 1 || store.Values["k"] != "v" {
		t.Fatalf("store values = %v", store.Values)
	}
}
