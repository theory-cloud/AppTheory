package localrunner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadAssemblyErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := loadAssembly(dir); err == nil || !strings.Contains(err.Error(), "manifest") {
		t.Fatalf("missing manifest must fail: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadAssembly(dir); err == nil || !strings.Contains(err.Error(), "parse") {
		t.Fatalf("invalid manifest must fail: %v", err)
	}
	writeJSONFile(t, filepath.Join(dir, "manifest.json"), map[string]any{"version": "54.0.0", "artifacts": map[string]any{}})
	if _, err := loadAssembly(dir); err == nil || !strings.Contains(err.Error(), "no CloudFormation stacks") {
		t.Fatalf("empty assembly must fail: %v", err)
	}
	writeJSONFile(t, filepath.Join(dir, "manifest.json"), map[string]any{
		"version": "54.0.0",
		"artifacts": map[string]any{"Stack": map[string]any{
			"type": "aws:cloudformation:stack", "properties": map[string]any{"templateFile": "missing.json"},
		}},
	})
	if _, err := loadAssembly(dir); err == nil {
		t.Fatal("a missing template must fail")
	}
	if err := os.WriteFile(filepath.Join(dir, "missing.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadAssembly(dir); err == nil {
		t.Fatal("an invalid template must fail")
	}
}

func TestParseFunctionCodeProblemsDoNotBlockUnservedFunctions(t *testing.T) {
	cases := map[string]map[string]any{
		"container image": {
			"Type":       typeLambdaFunction,
			"Properties": map[string]any{"Runtime": "nodejs24.x", "Handler": "h", "Code": map[string]any{"ImageUri": "123.dkr.ecr/x:latest"}},
		},
		"inline provided": {
			"Type":       typeLambdaFunction,
			"Properties": map[string]any{"Runtime": "provided.al2023", "Handler": "bootstrap", "Code": map[string]any{"ZipFile": "x"}},
		},
		"no code": {
			"Type":       typeLambdaFunction,
			"Properties": map[string]any{"Runtime": "nodejs24.x", "Handler": "h"},
		},
		"missing asset": {
			"Type":       typeLambdaFunction,
			"Metadata":   map[string]any{assetPathMetadataKey: "asset.missing"},
			"Properties": map[string]any{"Runtime": "nodejs24.x", "Handler": "h", "Code": map[string]any{"S3Key": "k"}},
		},
	}
	for name, resource := range cases {
		t.Run(name, func(t *testing.T) {
			resources := map[string]any{
				"Fn": resource,
				"Url": map[string]any{
					"Type": typeFunctionURL,
					"Properties": map[string]any{
						"AuthType":          noneAuthorization,
						"TargetFunctionArn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
					},
				},
			}
			dir := writeAssembly(t, resources)
			_, err := deriveSpec(dir, mustLoad(t, dir))
			if err == nil {
				t.Fatalf("%s must fail for a served function", name)
			}
		})
	}
}

func mustLoad(t *testing.T, dir string) []assemblyStack {
	t.Helper()
	stacks, err := loadAssembly(dir)
	if err != nil {
		t.Fatalf("load assembly: %v", err)
	}
	return stacks
}

func TestServedFunctionMetadataProblems(t *testing.T) {
	base := map[string]any{
		"Type":     typeLambdaFunction,
		"Metadata": map[string]any{assetPathMetadataKey: "asset.deadbeef"},
		"Properties": map[string]any{
			"Runtime": "nodejs24.x", "Handler": "h", "Code": map[string]any{"S3Key": "k"},
		},
	}
	t.Run("layers", func(t *testing.T) {
		resource := map[string]any{"Type": base["Type"], "Metadata": base["Metadata"], "Properties": map[string]any{
			"Runtime": "nodejs24.x", "Handler": "h", "Code": map[string]any{"S3Key": "k"},
			"Layers": []any{"layer-arn"},
		}}
		_, err := servedFunctionSpec(t, resource)
		if err == nil || !strings.Contains(err.Error(), "layer") {
			t.Fatalf("layers must fail: %v", err)
		}
	})
	t.Run("asset is a file", func(t *testing.T) {
		resource := map[string]any{"Type": base["Type"], "Metadata": base["Metadata"], "Properties": map[string]any{
			"Runtime": "nodejs24.x", "Handler": "h", "Code": map[string]any{"S3Key": "k"},
		}}
		dir := writeAssembly(t, servedFunctionResources(resource))
		if err := os.WriteFile(filepath.Join(dir, "asset.deadbeef"), []byte("file"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := deriveSpec(dir, mustLoad(t, dir)); err == nil || !strings.Contains(err.Error(), "not a directory") {
			t.Fatalf("a file asset must fail: %v", err)
		}
	})
	t.Run("metadata is not a string", func(t *testing.T) {
		resource := map[string]any{"Type": base["Type"], "Metadata": map[string]any{assetPathMetadataKey: 42}, "Properties": base["Properties"]}
		if _, err := servedFunctionSpec(t, resource); err == nil {
			t.Fatal("non-string asset metadata must fail")
		}
	})
}

func servedFunctionResources(function map[string]any) map[string]any {
	return map[string]any{
		"Fn": function,
		"Url": map[string]any{
			"Type": typeFunctionURL,
			"Properties": map[string]any{
				"AuthType":          noneAuthorization,
				"TargetFunctionArn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
			},
		},
	}
}

func servedFunctionSpec(t *testing.T, function map[string]any) (*Spec, error) {
	t.Helper()
	dir := writeAssembly(t, servedFunctionResources(function))
	if err := os.Mkdir(filepath.Join(dir, "asset.deadbeef"), 0o750); err != nil {
		t.Fatal(err)
	}
	return deriveSpec(dir, mustLoad(t, dir))
}

func TestHTTPRouteKeyParsing(t *testing.T) {
	cases := map[string]struct {
		method string
		path   string
		fail   bool
	}{
		"$default":      {method: "ANY", path: catchAllPath},
		"ANY /{proxy+}": {method: "ANY", path: "/{proxy+}"},
		"get /items":    {method: "GET", path: "/items"},
		"GET":           {fail: true},
		"GET items":     {fail: true},
		"":              {fail: true},
	}
	for key, expected := range cases {
		method, path, err := parseHTTPRouteKey(key)
		if expected.fail {
			if err == nil {
				t.Fatalf("%q must fail", key)
			}
			continue
		}
		if err != nil || method != expected.method || path != expected.path {
			t.Fatalf("parseHTTPRouteKey(%q) = %q %q %v", key, method, path, err)
		}
	}
}

func TestDeriveHTTPAPIFailures(t *testing.T) {
	base := func(route map[string]any, integration map[string]any) map[string]any {
		resources := httpAPIResources("ANY /")
		if route != nil {
			resources["Route"] = map[string]any{"Type": typeHTTPRoute, "Properties": route}
		}
		if integration != nil {
			resources["Integration"] = map[string]any{"Type": typeHTTPIntegration, "Properties": integration}
		}
		return resources
	}
	cases := map[string]map[string]any{
		"unsupported protocol": {
			"Fn":  withAsset(lambdaFunction(nil), "asset.deadbeef"),
			"Api": map[string]any{"Type": typeHTTPAPI, "Properties": map[string]any{"ProtocolType": "WEBSOCKET"}},
		},
		"invalid route key": base(map[string]any{
			"ApiId": map[string]any{"Ref": "Api"}, "RouteKey": "nonsense", "Target": map[string]any{"Ref": "Integration"},
		}, nil),
		"target not an integration": base(map[string]any{
			"ApiId": map[string]any{"Ref": "Api"}, "RouteKey": "ANY /", "Target": map[string]any{"Ref": "Nope"},
		}, nil),
		"authorization": base(map[string]any{
			"ApiId": map[string]any{"Ref": "Api"}, "RouteKey": "ANY /", "AuthorizationType": "AWS_IAM",
			"Target": map[string]any{"Ref": "Integration"},
		}, nil),
		"authorizer id": base(map[string]any{
			"ApiId": map[string]any{"Ref": "Api"}, "RouteKey": "ANY /", "AuthorizerId": map[string]any{"Ref": "Auth"},
			"Target": map[string]any{"Ref": "Integration"},
		}, nil),
	}
	for name, resources := range cases {
		t.Run(name, func(t *testing.T) {
			dir := writeAssembly(t, resources)
			mkdirAsset(t, dir)
			if _, err := deriveSpec(dir, mustLoad(t, dir)); err == nil {
				t.Fatalf("%s must fail", name)
			}
		})
	}
}

func TestDeriveRESTAPIFailures(t *testing.T) {
	restWith := func(method map[string]any, extra map[string]any) map[string]any {
		resources := map[string]any{
			"Fn":     withAsset(lambdaFunction(nil), "asset.deadbeef"),
			"Api":    map[string]any{"Type": typeRESTAPI, "Properties": map[string]any{"Name": "rest"}},
			"Method": map[string]any{"Type": typeRESTMethod, "Properties": method},
		}
		for key, value := range extra {
			resources[key] = value
		}
		return resources
	}
	baseMethod := func() map[string]any {
		return map[string]any{
			"RestApiId":  map[string]any{"Ref": "Api"},
			"ResourceId": map[string]any{"Fn::GetAtt": []any{"Api", "RootResourceId"}},
			"HttpMethod": "GET",
			"Integration": map[string]any{
				"Type": proxyIntegration,
				"Uri": map[string]any{"Fn::Join": []any{"", []any{
					"arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/",
					map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
					"/invocations",
				}}},
			},
		}
	}
	cases := map[string]map[string]any{
		"rest authorizer": restWith(baseMethod(), map[string]any{
			"RestAuth": map[string]any{"Type": typeRESTAuthorizer, "Properties": map[string]any{}},
		}),
		"authorization": func() map[string]any {
			method := baseMethod()
			method["AuthorizationType"] = "COGNITO_USER_POOLS"
			return restWith(method, nil)
		}(),
		"integration type": func() map[string]any {
			method := baseMethod()
			mustMap(t, method["Integration"])["Type"] = "MOCK"
			return restWith(method, nil)
		}(),
		"uri is not a function": func() map[string]any {
			method := baseMethod()
			mustMap(t, method["Integration"])["Uri"] = "https://example.com"
			return restWith(method, nil)
		}(),
	}
	for name, resources := range cases {
		t.Run(name, func(t *testing.T) {
			dir := writeAssembly(t, resources)
			mkdirAsset(t, dir)
			if _, err := deriveSpec(dir, mustLoad(t, dir)); err == nil {
				t.Fatalf("%s must fail", name)
			}
		})
	}
}

func TestDeriveReportsUnservedFunctions(t *testing.T) {
	resources := httpAPIResources("ANY /")
	resources["Fn"] = withAsset(lambdaFunction(nil), "asset.deadbeef")
	resources["Worker"] = withAsset(lambdaFunction(nil), "asset.deadbeef")
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveSpec(dir, mustLoad(t, dir))
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	found := false
	for _, skipped := range spec.Skipped {
		if skipped.LogicalID == "Worker" {
			found = true
		}
	}
	if !found {
		t.Fatalf("unserved function not reported: %+v", spec.Skipped)
	}
}

func TestInlineFileNames(t *testing.T) {
	cases := map[string]string{
		"nodejs24.x:index.handler":   "index.js",
		"python3.14:handler.handler": "handler.py",
		"provided.al2023:bootstrap":  "",
		"nodejs24.x:":                "",
	}
	for input, expected := range cases {
		runtimeName, handler, _ := strings.Cut(input, ":")
		if actual := inlineFileName(runtimeName, handler); actual != expected {
			t.Fatalf("inlineFileName(%q) = %q, want %q", input, actual, expected)
		}
	}
}
