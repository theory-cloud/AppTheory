package localrunner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/theory-cloud/apptheory/v6/internal/localcloudfront"
)

func TestValidateViewerCountry(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"US", "US", false},
		{" DE ", "DE", false},
		{"", "", false},
		{"us", "", true},
		{"USA", "", true},
		{"U1", "", true},
	}
	for _, test := range cases {
		got, err := validateViewerCountry(test.in)
		if test.wantErr {
			if err == nil {
				t.Fatalf("%q must be refused", test.in)
			}
			continue
		}
		if err != nil || got != test.want {
			t.Fatalf("%q = %q (%v), want %q", test.in, got, err, test.want)
		}
	}
}

type countingInvoker struct {
	calls int
}

func (c *countingInvoker) Invoke(_ context.Context, payload []byte) ([]byte, error) {
	c.calls++
	if string(payload) == "fail" {
		return nil, errors.New("invocation failed")
	}
	return []byte("ok"), nil
}

func TestEdgeInvokerAdapter(t *testing.T) {
	invoker := &countingInvoker{}
	adapter := &edgeInvokerAdapter{
		versions: map[string]string{"Version": "Function"},
		invokers: map[string]Invoker{"Function": invoker},
	}
	response, err := adapter.InvokeEdge(context.Background(), "Version", time.Second, []byte("event"))
	if err != nil || string(response) != "ok" || invoker.calls != 1 {
		t.Fatalf("InvokeEdge = %q (%v), calls %d", response, err, invoker.calls)
	}
	if _, err := adapter.InvokeEdge(context.Background(), "Missing", time.Second, nil); err == nil {
		t.Fatal("an unknown version must fail")
	}
	delete(adapter.invokers, "Function")
	if _, err := adapter.InvokeEdge(context.Background(), "Version", time.Second, nil); err == nil {
		t.Fatal("a function that is not running must fail")
	}
	adapter.invokers["Function"] = invoker
	if _, err := adapter.InvokeEdge(context.Background(), "Version", time.Second, []byte("fail")); err == nil {
		t.Fatal("an invoker error must propagate")
	}
}

func TestEdgeSecurityReports(t *testing.T) {
	key := &localcloudfront.PublicKey{LogicalID: "Key", Name: "key", ID: "K123"}
	group := &localcloudfront.KeyGroup{LogicalID: "Group", Name: "group", Items: []string{"Key"}}
	store := &localcloudfront.KeyValueStore{LogicalID: "Store", Name: "store", Values: map[string]string{"a": "1"}}
	spec := &Spec{
		CloudFrontPublicKeys:     []*localcloudfront.PublicKey{key},
		CloudFrontKeyGroups:      []*localcloudfront.KeyGroup{group},
		CloudFrontKeyValueStores: []*localcloudfront.KeyValueStore{store},
	}
	report := cloudFrontSecurityReport(spec)
	if report == nil {
		t.Fatal("the security report must not be nil")
	}
	keys, ok := report["publicKeys"].([]map[string]any)
	if !ok {
		t.Fatalf("publicKeys = %T", report["publicKeys"])
	}
	if keys[0]["keyPairId"] != "K123" {
		t.Fatalf("keys = %v", keys)
	}
	stores, ok := report["keyValueStores"].([]map[string]any)
	if !ok {
		t.Fatalf("keyValueStores = %T", report["keyValueStores"])
	}
	if stores[0]["keyCount"] != 1 {
		t.Fatalf("stores = %v", stores)
	}
	if cloudFrontSecurityReport(&Spec{}) != nil || cloudFrontSecurityReport(nil) != nil {
		t.Fatal("an empty spec has no security report")
	}

	distribution := &localcloudfront.Distribution{
		LogicalID:      "D",
		GeoRestriction: &localcloudfront.GeoRestriction{Type: "whitelist", Locations: []string{"US"}},
		DefaultBehavior: &localcloudfront.Behavior{
			PathPattern:            "*",
			TrustedKeyGroups:       &localcloudfront.TrustedKeyGroups{Enabled: true, Items: []string{"Group"}},
			FieldLevelEncryptionID: "Config",
			EdgeLambdas: map[string]*localcloudfront.EdgeFunction{
				"viewer-request": {EventType: "viewer-request", Version: "Version", Function: "Fn"},
			},
		},
	}
	entry := distributionSecurityReport(distribution)
	if entry["geoRestriction"] == nil || entry["signedAccess"] == nil || entry["fieldLevelEncryption"] == nil || entry["edgeLambdas"] == nil {
		t.Fatalf("distribution report = %v", entry)
	}
	if distributionSecurityReport(NULLDistribution) != nil {
		t.Fatal("a nil distribution has no report")
	}
}

// NULLDistribution is a nil pointer used to exercise the nil guard.
var NULLDistribution *localcloudfront.Distribution

func TestCloudFrontEdgeFunctionsAndVersions(t *testing.T) {
	spec := &Spec{CloudFront: []*localcloudfront.Distribution{{
		LogicalID: "D",
		DefaultBehavior: &localcloudfront.Behavior{
			PathPattern: "*",
			EdgeLambdas: map[string]*localcloudfront.EdgeFunction{
				"viewer-request": {EventType: "viewer-request", Version: "Version", Function: "Fn"},
			},
		},
		CacheBehaviors: []*localcloudfront.Behavior{nil, {
			PathPattern: "/api/*",
			EdgeLambdas: map[string]*localcloudfront.EdgeFunction{
				"origin-request": {EventType: "origin-request", Version: "Version2", Function: "Fn2"},
			},
		}},
	}}}
	functions := spec.CloudFrontEdgeFunctions()
	if strings.Join(functions, ",") != "Fn,Fn2" {
		t.Fatalf("edge functions = %v", functions)
	}
	versions := edgeVersions(spec)
	if versions["Version"] != "Fn" || versions["Version2"] != "Fn2" {
		t.Fatalf("versions = %v", versions)
	}
	if len((&Spec{}).CloudFrontEdgeFunctions()) != 0 {
		t.Fatal("a spec with no distributions has no edge functions")
	}
	if len(edgeVersions(&Spec{})) != 0 {
		t.Fatal("a spec with no distributions has no versions")
	}
}

func TestMaterializeKeyValueStores(t *testing.T) {
	resources := map[string]any{
		"Store": map[string]any{
			"Type": "AWS::CloudFront::KeyValueStore",
			"Properties": map[string]any{
				"Name": "store",
				"ImportSource": map[string]any{
					"SourceType": "S3",
					"SourceArn":  "arn:aws:s3:::bucket/abc.json",
				},
			},
		},
		"Function": map[string]any{
			"Type": typeCloudFrontFn,
			"Properties": map[string]any{
				"FunctionCode": "import cf from 'cloudfront';\nasync function handler(event) { return event.request; }",
				"FunctionConfig": map[string]any{
					"Runtime": "cloudfront-js-2.0",
					"KeyValueStoreAssociations": []any{map[string]any{
						"KeyValueStoreARN": map[string]any{"Ref": "Store"},
					}},
				},
			},
		},
		"Distribution": map[string]any{
			"Type": typeCloudFront,
			"Properties": map[string]any{
				"DistributionConfig": map[string]any{
					"Enabled": true,
					"DefaultCacheBehavior": map[string]any{
						"PathPattern":    "*",
						"TargetOriginId": "Origin",
						"CachePolicyId":  "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
						"FunctionAssociations": []any{map[string]any{
							"EventType":   "viewer-request",
							"FunctionARN": map[string]any{"Fn::GetAtt": []any{"Function", "FunctionARN"}},
						}},
					},
					"Origins": []any{map[string]any{
						"Id": "Origin", "DomainName": "bucket.s3.local",
						"S3OriginConfig": map[string]any{"OriginAccessIdentity": ""},
					}},
				},
			},
		},
	}
	dir := writeAssembly(t, resources)
	assetDir := filepath.Join(dir, "asset.kvs")
	writeFile(t, filepath.Join(assetDir, "abc.json"), `{"data":[{"key":"target","value":"/edge"}]}`)
	writeJSONFile(t, filepath.Join(dir, "TestStack.assets.json"), map[string]any{
		"version": "54.0.0",
		"files": map[string]any{
			"abc": map[string]any{
				"source":       map[string]any{"path": "asset.kvs/abc.json", "packaging": "file"},
				"destinations": map[string]any{"dest": map[string]any{"bucketName": "bucket", "objectKey": "abc.json"}},
			},
		},
	})
	spec, err := deriveSpec(dir, mustLoadAssembly(t, dir))
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	runner := &Runner{}
	if err := runner.materializeKeyValueStores(spec); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	store := spec.CloudFrontKeyValueStores[0]
	if store.KeyCount() != 1 || store.Values["target"] != "/edge" {
		t.Fatalf("store values = %v", store.Values)
	}
	function := spec.CloudFrontFunctions[0]
	if function.Store() == nil || function.Store().KeyCount() != 1 {
		t.Fatalf("the function was not bound to the store: %+v", function.Store())
	}
	if spec.CloudFront[0].Servable() != true {
		t.Fatalf("distribution refused: %v", spec.CloudFront[0].Refusals)
	}
}

func TestMaterializeKeyValueStoreRefusals(t *testing.T) {
	resources := map[string]any{
		"Store": map[string]any{
			"Type": "AWS::CloudFront::KeyValueStore",
			"Properties": map[string]any{
				"ImportSource": map[string]any{"SourceType": "S3", "SourceArn": "arn:aws:s3:::bucket/missing.json"},
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
	dir := writeAssembly(t, resources)
	writeJSONFile(t, filepath.Join(dir, "TestStack.assets.json"), map[string]any{"version": "54.0.0", "files": map[string]any{}})
	spec, err := deriveSpec(dir, mustLoadAssembly(t, dir))
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	runner := &Runner{}
	if err := runner.materializeKeyValueStores(spec); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if spec.CloudFrontKeyValueStores[0].Servable() {
		t.Fatal("a store whose asset is missing must be refused")
	}
	if !strings.Contains(strings.Join(spec.CloudFrontKeyValueStores[0].Refusals, "\n"), "not an asset") {
		t.Fatalf("refusals = %v", spec.CloudFrontKeyValueStores[0].Refusals)
	}
	if len((&Spec{}).CloudFrontKeyValueStores) != 0 {
		t.Fatal("an empty spec has no stores")
	}
	if err := (&Runner{}).materializeKeyValueStores(&Spec{}); err != nil {
		t.Fatalf("an empty spec must not fail: %v", err)
	}
	// A function that names a store the assembly does not carry is refused.
	spec.CloudFrontFunctions = []*localcloudfront.Function{{LogicalID: "Fn", Stack: "TestStack", KeyValueStore: "Missing"}}
	spec.CloudFrontKeyValueStores = nil
	if err := runner.materializeKeyValueStores(spec); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if len(spec.CloudFrontFunctions[0].Refusals) == 0 {
		t.Fatal("a missing store must refuse the function")
	}
}

func TestRefreshCloudFrontSkipsDropsServedRows(t *testing.T) {
	spec := &Spec{
		Skipped: []Skipped{
			{LogicalID: "Fn", Kind: typeLambdaFunction, Reason: "not targeted"},
			{LogicalID: "Gone", Kind: typeLambdaFunction, Reason: "not targeted"},
			{LogicalID: "D", Kind: "cloudfront distribution", Reason: "refused"},
		},
		CloudFront: []*localcloudfront.Distribution{{
			LogicalID: "D",
			DefaultBehavior: &localcloudfront.Behavior{
				PathPattern: "*",
				EdgeLambdas: map[string]*localcloudfront.EdgeFunction{
					"viewer-request": {EventType: "viewer-request", Version: "V", Function: "Fn"},
				},
			},
		}},
	}
	refreshCloudFrontSkips(spec)
	ids := make([]string, 0, len(spec.Skipped))
	for _, skipped := range spec.Skipped {
		ids = append(ids, skipped.LogicalID)
	}
	if strings.Join(ids, ",") != "Gone" {
		t.Fatalf("skipped = %v", ids)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestMaterializeKeyValueStoreMissingManifest(t *testing.T) {
	resources := map[string]any{
		"Store": map[string]any{
			"Type": "AWS::CloudFront::KeyValueStore",
			"Properties": map[string]any{
				"ImportSource": map[string]any{"SourceType": "S3", "SourceArn": "arn:aws:s3:::bucket/abc.json"},
			},
		},
		"Distribution": map[string]any{
			"Type": typeCloudFront,
			"Properties": map[string]any{"DistributionConfig": map[string]any{
				"Enabled": true,
				"DefaultCacheBehavior": map[string]any{
					"PathPattern": "*", "TargetOriginId": "Origin",
					"CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
				},
				"Origins": []any{map[string]any{"Id": "Origin", "DomainName": "b.s3.local", "S3OriginConfig": map[string]any{"OriginAccessIdentity": ""}}},
			}},
		},
	}
	dir := writeAssembly(t, resources)
	spec, err := deriveSpec(dir, mustLoadAssembly(t, dir))
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if err := (&Runner{}).materializeKeyValueStores(spec); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if spec.CloudFrontKeyValueStores[0].Servable() {
		t.Fatal("a store without an asset manifest must be refused")
	}
	if !strings.Contains(strings.Join(spec.CloudFrontKeyValueStores[0].Refusals, "\n"), "asset manifest") {
		t.Fatalf("refusals = %v", spec.CloudFrontKeyValueStores[0].Refusals)
	}
}

func TestMaterializeRefusesTheDistributionThatUsesAStore(t *testing.T) {
	resources := map[string]any{
		"Store": map[string]any{
			"Type":       "AWS::CloudFront::KeyValueStore",
			"Properties": map[string]any{"ImportSource": map[string]any{"SourceType": "Inline"}},
		},
		"Function": map[string]any{
			"Type": typeCloudFrontFn,
			"Properties": map[string]any{
				"FunctionCode": "x",
				"FunctionConfig": map[string]any{
					"Runtime":                   "cloudfront-js-2.0",
					"KeyValueStoreAssociations": []any{map[string]any{"KeyValueStoreARN": map[string]any{"Ref": "Store"}}},
				},
			},
		},
		"Distribution": map[string]any{
			"Type": typeCloudFront,
			"Properties": map[string]any{"DistributionConfig": map[string]any{
				"Enabled": true,
				"DefaultCacheBehavior": map[string]any{
					"PathPattern":    "*",
					"TargetOriginId": "Origin",
					"CachePolicyId":  "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
					"FunctionAssociations": []any{map[string]any{
						"EventType":   "viewer-request",
						"FunctionARN": map[string]any{"Fn::GetAtt": []any{"Function", "FunctionARN"}},
					}},
				},
				"Origins": []any{map[string]any{"Id": "Origin", "DomainName": "b.s3.local", "S3OriginConfig": map[string]any{"OriginAccessIdentity": ""}}},
			}},
		},
	}
	dir := writeAssembly(t, resources)
	writeJSONFile(t, filepath.Join(dir, "TestStack.assets.json"), map[string]any{"version": "54.0.0", "files": map[string]any{}})
	spec, err := deriveSpec(dir, mustLoadAssembly(t, dir))
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if err := (&Runner{}).materializeKeyValueStores(spec); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if len(spec.CloudFront[0].Refusals) == 0 {
		t.Fatal("the distribution that uses a refused store must be refused")
	}
}

func TestRefreshCloudFrontSkipsAddsANewRefusal(t *testing.T) {
	spec := &Spec{CloudFront: []*localcloudfront.Distribution{{LogicalID: "D", Refusals: []string{"refused later"}}}}
	refreshCloudFrontSkips(spec)
	if len(spec.Skipped) != 1 || !strings.Contains(spec.Skipped[0].Reason, "refused later") {
		t.Fatalf("skipped = %+v", spec.Skipped)
	}
}

func TestSecurityReportNilGuards(t *testing.T) {
	if distributionSecurityReport(nil) != nil {
		t.Fatal("a nil distribution has no report")
	}
	empty := &localcloudfront.Distribution{LogicalID: "D", DefaultBehavior: &localcloudfront.Behavior{PathPattern: "*"}, CacheBehaviors: []*localcloudfront.Behavior{nil}}
	if distributionSecurityReport(empty) != nil {
		t.Fatal("a distribution without security settings has no report")
	}
	report := cloudFrontSecurityReport(&Spec{CloudFrontKeyGroups: []*localcloudfront.KeyGroup{{LogicalID: "G", Name: "g", Items: []string{"Key"}}}})
	if report == nil {
		t.Fatal("the key group report must not be nil")
	}
	groups, ok := report["keyGroups"].([]map[string]any)
	if !ok {
		t.Fatalf("keyGroups = %T", report["keyGroups"])
	}
	if groups[0]["logicalId"] != "G" {
		t.Fatalf("groups = %v", groups)
	}
	if keys, ok := report["publicKeys"].([]map[string]any); ok && len(keys) != 0 {
		t.Fatalf("an empty public key list = %v", keys)
	}
}

func TestNormalizeOptionsBranches(t *testing.T) {
	appDir := t.TempDir()
	cases := []struct {
		name    string
		options Options
		needle  string
	}{
		{"no app", Options{}, "app directory is required"},
		{"not a directory", Options{AppDir: filepath.Join(appDir, "missing")}, "is not a directory"},
		{"negative port base", Options{AppDir: appDir, PortBase: -1}, "--port-base"},
		{"max concurrency low", Options{AppDir: appDir, MaxConcurrency: -1}, "--max-concurrency"},
		{"max concurrency high", Options{AppDir: appDir, MaxConcurrency: 100}, "--max-concurrency"},
		{"delivery concurrency high", Options{AppDir: appDir, DeliveryConcurrency: 100}, "--delivery-concurrency"},
		{"bad viewer country", Options{AppDir: appDir, ViewerCountry: "usa"}, "viewer country"},
		{"bad origin", Options{AppDir: appDir, Origins: map[string]string{"example.com": "https://example.org"}}, "loopback"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			_, err := normalizeOptions(test.options)
			if err == nil || !strings.Contains(err.Error(), test.needle) {
				t.Fatalf("%s: %v does not name %q", test.name, err, test.needle)
			}
		})
	}
	options, err := normalizeOptions(Options{AppDir: appDir, ViewerCountry: "us"})
	if err == nil {
		t.Fatalf("a lower-case country must fail: %+v", options)
	}
	options, err = normalizeOptions(Options{AppDir: appDir, ViewerCountry: " US "})
	if err != nil || options.ViewerCountry != "US" {
		t.Fatalf("a padded country = %q (%v)", options.ViewerCountry, err)
	}
}
