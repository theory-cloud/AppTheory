package localrunner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeAssembly writes a minimal cloud assembly with one stack and returns its
// directory. Resource values are decoded from JSON so the fixtures mirror the
// synthesized templates exactly.
func writeAssembly(t *testing.T, resources map[string]any) string {
	t.Helper()
	dir := t.TempDir()
	manifest := map[string]any{
		"version": "54.0.0",
		"artifacts": map[string]any{
			"TestStack": map[string]any{
				"type":       "aws:cloudformation:stack",
				"properties": map[string]any{"templateFile": "TestStack.template.json"},
			},
		},
	}
	writeJSONFile(t, filepath.Join(dir, "manifest.json"), manifest)
	writeJSONFile(t, filepath.Join(dir, "TestStack.template.json"), map[string]any{"Resources": resources})
	return dir
}

func writeJSONFile(t *testing.T, path string, value any) {
	t.Helper()
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatalf("encode %s: %v", path, err)
	}
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func mkdirAsset(t *testing.T, dir string) {
	t.Helper()
	if err := os.Mkdir(filepath.Join(dir, "asset.deadbeef"), 0o750); err != nil {
		t.Fatal(err)
	}
}

func deriveAssembly(t *testing.T, dir string) (*Spec, error) {
	t.Helper()
	stacks, err := loadAssembly(dir)
	if err != nil {
		t.Fatalf("load assembly: %v", err)
	}
	return deriveSpec(dir, stacks)
}

func lambdaFunction(extra map[string]any) map[string]any {
	properties := map[string]any{
		"Runtime":       "provided.al2023",
		"Handler":       "bootstrap",
		"Architectures": []any{"arm64"},
		"MemorySize":    256,
		"Code": map[string]any{
			"S3Bucket": map[string]any{"Fn::Sub": "cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}"},
			"S3Key":    "deadbeef.zip",
		},
	}
	for key, value := range extra {
		properties[key] = value
	}
	return map[string]any{"Type": typeLambdaFunction, "Properties": properties}
}

func withAsset(function map[string]any, asset string) map[string]any {
	function["Metadata"] = map[string]any{assetPathMetadataKey: asset}
	return function
}

func httpAPIResources(routeKey string) map[string]any {
	return map[string]any{
		"Fn": lambdaFunction(nil),
		"Api": map[string]any{
			"Type":       typeHTTPAPI,
			"Properties": map[string]any{"Name": "test-api", "ProtocolType": "HTTP"},
		},
		"Stage": map[string]any{
			"Type":       typeHTTPStage,
			"Properties": map[string]any{"ApiId": map[string]any{"Ref": "Api"}, "StageName": "$default"},
		},
		"Integration": map[string]any{
			"Type": typeHTTPIntegration,
			"Properties": map[string]any{
				"ApiId":                map[string]any{"Ref": "Api"},
				"IntegrationType":      proxyIntegration,
				"IntegrationUri":       map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
				"PayloadFormatVersion": "2.0",
			},
		},
		"Route": map[string]any{
			"Type": typeHTTPRoute,
			"Properties": map[string]any{
				"ApiId":             map[string]any{"Ref": "Api"},
				"RouteKey":          routeKey,
				"AuthorizationType": noneAuthorization,
				"Target": map[string]any{
					"Fn::Join": []any{"", []any{"integrations/", map[string]any{"Ref": "Integration"}}},
				},
			},
		},
	}
}

func TestDeriveHTTPAPIV2(t *testing.T) {
	resources := httpAPIResources("ANY /{proxy+}")
	resources["Fn"] = withAsset(lambdaFunction(nil), "asset.deadbeef")
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)

	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.APIs) != 1 || spec.APIs[0].Class != APIHTTPV2 {
		t.Fatalf("unexpected APIs: %+v", spec.APIs)
	}
	if spec.APIs[0].Stage != "$default" || spec.APIs[0].Name != "test-api" {
		t.Fatalf("unexpected API metadata: %+v", spec.APIs[0])
	}
	if len(spec.APIs[0].Routes) != 1 {
		t.Fatalf("unexpected routes: %+v", spec.APIs[0].Routes)
	}
	route := spec.APIs[0].Routes[0]
	if route.Method != "ANY" || route.Path != "/{proxy+}" || route.Function != "Fn" || route.RouteKey != "ANY /{proxy+}" {
		t.Fatalf("unexpected route: %+v", route)
	}
	function, ok := spec.Function("Fn")
	if !ok {
		t.Fatalf("function Fn missing: %+v", spec.Functions)
	}
	if function.AssetDir != filepath.Join(dir, "asset.deadbeef") || function.MemoryMB != 256 || function.Architecture != "arm64" {
		t.Fatalf("unexpected function: %+v", function)
	}
}

func TestDeriveRESTAPIV1ResourceTree(t *testing.T) {
	resources := map[string]any{
		"Fn": lambdaFunction(nil),
		"Api": map[string]any{
			"Type":       typeRESTAPI,
			"Properties": map[string]any{"Name": "rest-api"},
		},
		"Stage": map[string]any{
			"Type":       typeRESTStage,
			"Properties": map[string]any{"RestApiId": map[string]any{"Ref": "Api"}, "StageName": "prod"},
		},
		"ApiResource": map[string]any{
			"Type": typeRESTResource,
			"Properties": map[string]any{
				"RestApiId": map[string]any{"Ref": "Api"},
				"ParentId":  map[string]any{"Fn::GetAtt": []any{"Api", "RootResourceId"}},
				"PathPart":  "api",
			},
		},
		"ItemsResource": map[string]any{
			"Type": typeRESTResource,
			"Properties": map[string]any{
				"RestApiId": map[string]any{"Ref": "Api"},
				"ParentId":  map[string]any{"Ref": "ApiResource"},
				"PathPart":  "items",
			},
		},
		"RootMethod":  restMethod("Api", map[string]any{"Fn::GetAtt": []any{"Api", "RootResourceId"}}, "GET", "/invocations"),
		"ItemsMethod": restMethod("Api", map[string]any{"Ref": "ItemsResource"}, "POST", "/response-streaming-invocations"),
	}
	resources["Fn"] = withAsset(lambdaFunction(nil), "asset.deadbeef")
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)

	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.APIs) != 1 || spec.APIs[0].Class != APIRESTV1 || spec.APIs[0].Stage != "prod" {
		t.Fatalf("unexpected APIs: %+v", spec.APIs)
	}
	routes := map[string]Route{}
	for _, route := range spec.APIs[0].Routes {
		routes[route.Method+" "+route.Path] = route
	}
	if _, ok := routes["GET /"]; !ok {
		t.Fatalf("root route missing: %+v", routes)
	}
	streaming, ok := routes["POST /api/items"]
	if !ok {
		t.Fatalf("nested route missing: %+v", routes)
	}
	if !streaming.Streaming {
		t.Fatalf("response-streaming integration was not marked streaming: %+v", streaming)
	}
}

func restMethod(apiID string, resource map[string]any, method, invocations string) map[string]any {
	return map[string]any{
		"Type": typeRESTMethod,
		"Properties": map[string]any{
			"RestApiId":         map[string]any{"Ref": apiID},
			"ResourceId":        resource,
			"HttpMethod":        method,
			"AuthorizationType": noneAuthorization,
			"Integration": map[string]any{
				"Type": proxyIntegration,
				"Uri": map[string]any{
					"Fn::Join": []any{"", []any{
						"arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/",
						map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
						invocations,
					}},
				},
			},
		},
	}
}

func TestDeriveFunctionURL(t *testing.T) {
	resources := map[string]any{
		"Fn": lambdaFunction(nil),
		"Url": map[string]any{
			"Type": typeFunctionURL,
			"Properties": map[string]any{
				"AuthType":          noneAuthorization,
				"InvokeMode":        responseStreamMode,
				"TargetFunctionArn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
			},
		},
	}
	resources["Fn"] = withAsset(lambdaFunction(nil), "asset.deadbeef")
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)

	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.FunctionURLs) != 1 {
		t.Fatalf("unexpected Function URLs: %+v", spec.FunctionURLs)
	}
	url := spec.FunctionURLs[0]
	if url.Function != "Fn" || !url.Streaming {
		t.Fatalf("unexpected Function URL: %+v", url)
	}
}

func TestDeriveInlineCode(t *testing.T) {
	resources := map[string]any{
		"Fn": map[string]any{
			"Type": typeLambdaFunction,
			"Properties": map[string]any{
				"Runtime": "nodejs24.x",
				"Handler": "index.handler",
				"Code":    map[string]any{"ZipFile": "exports.handler = async () => ({statusCode: 200});"},
			},
		},
		"Url": map[string]any{
			"Type": typeFunctionURL,
			"Properties": map[string]any{
				"AuthType":          noneAuthorization,
				"TargetFunctionArn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
			},
		},
	}
	spec, err := deriveAssembly(t, writeAssembly(t, resources))
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	function, _ := spec.Function("Fn")
	if function.InlineFile != "index.js" || function.InlineCode == "" {
		t.Fatalf("unexpected inline function: %+v", function)
	}
}

func TestDeriveFailsClosedOnUnsupportedConstructs(t *testing.T) {
	cases := map[string]map[string]any{
		"websocket": {
			"Fn": lambdaFunction(nil),
			"Api": map[string]any{
				"Type":       typeHTTPAPI,
				"Properties": map[string]any{"Name": "ws", "ProtocolType": "WEBSOCKET"},
			},
		},
		"authorizer": {
			"Fn": lambdaFunction(nil),
			"Authorizer": map[string]any{
				"Type":       typeHTTPAuthorizer,
				"Properties": map[string]any{},
			},
		},
		"non-proxy integration": {
			"Fn": lambdaFunction(nil),
			"Api": map[string]any{
				"Type":       typeHTTPAPI,
				"Properties": map[string]any{"ProtocolType": "HTTP"},
			},
			"Integration": map[string]any{
				"Type":       typeHTTPIntegration,
				"Properties": map[string]any{"IntegrationType": "HTTP_PROXY", "IntegrationUri": "https://example.com"},
			},
			"Route": map[string]any{
				"Type": typeHTTPRoute,
				"Properties": map[string]any{
					"ApiId":             map[string]any{"Ref": "Api"},
					"RouteKey":          "GET /",
					"AuthorizationType": noneAuthorization,
					"Target":            map[string]any{"Ref": "Integration"},
				},
			},
		},
		"function URL auth": {
			"Fn": lambdaFunction(nil),
			"Url": map[string]any{
				"Type": typeFunctionURL,
				"Properties": map[string]any{
					// AWS_IAM is served; a URL with an auth type the runner
					// cannot verify still fails closed.
					"AuthType":          "SIGNED_COOKIE",
					"TargetFunctionArn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
				},
			},
		},
	}
	for name, resources := range cases {
		t.Run(name, func(t *testing.T) {
			dir := writeAssembly(t, resources)
			mkdirAsset(t, dir)
			_, err := deriveAssembly(t, dir)
			if err == nil {
				t.Fatalf("expected %s to fail closed", name)
			}
			message := err.Error()
			for _, fragment := range []string{"WebSocket", "authorizer", "AWS_PROXY", "auth type", "CloudFormation expressions"} {
				if strings.Contains(message, fragment) {
					return
				}
			}
			t.Fatalf("error does not explain the unsupported construct: %v", err)
		})
	}
}

func TestDeriveEmptySurfaceFails(t *testing.T) {
	_, err := deriveAssembly(t, writeAssembly(t, map[string]any{"Fn": lambdaFunction(nil)}))
	if err == nil || !strings.Contains(err.Error(), "no HTTP API v2 route") {
		t.Fatalf("expected a clear no-surface error, got %v", err)
	}
}

func TestDeriveFailsClosedOnUnresolvedLimits(t *testing.T) {
	cases := map[string]struct {
		property string
		value    any
	}{
		"memory":  {"MemorySize", map[string]any{"Ref": "FunctionMemory"}},
		"timeout": {"Timeout", map[string]any{"Fn::If": []any{"IsProd", 30, 60}}},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			resources := map[string]any{
				"Fn": withAsset(lambdaFunction(map[string]any{testCase.property: testCase.value}), "asset.deadbeef"),
				"Url": map[string]any{
					"Type": typeFunctionURL,
					"Properties": map[string]any{
						"AuthType":          noneAuthorization,
						"TargetFunctionArn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
					},
				},
			}
			dir := writeAssembly(t, resources)
			mkdirAsset(t, dir)
			_, err := deriveAssembly(t, dir)
			if err == nil {
				t.Fatalf("an unresolved %s must fail closed", testCase.property)
			}
			for _, fragment := range []string{"Fn", testCase.property, "CloudFormation expressions"} {
				if !strings.Contains(err.Error(), fragment) {
					t.Fatalf("error %q does not name %q", err, fragment)
				}
			}
		})
	}
}

func TestParseFunctionNamesUnresolvedLimitExpressions(t *testing.T) {
	properties, err := json.Marshal(map[string]any{
		"Runtime":    "nodejs24.x",
		"Handler":    "index.handler",
		"MemorySize": map[string]any{"Ref": "Memory"},
		"Timeout":    map[string]any{"Fn::If": []any{"UseLong", 30, 3}},
		"Code":       map[string]any{"ZipFile": "exports.handler = async () => ({});"},
	})
	if err != nil {
		t.Fatal(err)
	}
	function, err := parseFunction(t.TempDir(), assemblyStack{Name: "TestStack"}, "Fn", templateResource{
		Type:       typeLambdaFunction,
		Properties: properties,
	})
	if err != nil {
		t.Fatalf("parse function: %v", err)
	}
	if !function.UnresolvedMemorySize || function.MemorySizeExpression != "Ref" {
		t.Fatalf("MemorySize expression = %q, unresolved = %v", function.MemorySizeExpression, function.UnresolvedMemorySize)
	}
	if !function.UnresolvedTimeout || function.TimeoutExpression != "Fn::If" {
		t.Fatalf("Timeout expression = %q, unresolved = %v", function.TimeoutExpression, function.UnresolvedTimeout)
	}
	if function.MemoryMB != 128 || function.Timeout != 3 {
		t.Fatalf("internal fallbacks changed: memory=%d timeout=%d", function.MemoryMB, function.Timeout)
	}
}

func TestDeriveUsesDefaultsOnlyForAbsentLimits(t *testing.T) {
	function := lambdaFunction(nil)
	properties, ok := function["Properties"].(map[string]any)
	if !ok {
		t.Fatal("test function has no properties")
	}
	delete(properties, "MemorySize")
	delete(properties, "Timeout")
	resources := map[string]any{
		"Fn": withAsset(function, "asset.deadbeef"),
		"Url": map[string]any{
			"Type": typeFunctionURL,
			"Properties": map[string]any{
				"AuthType":          noneAuthorization,
				"TargetFunctionArn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
			},
		},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	derived, ok := spec.Function("Fn")
	if !ok {
		t.Fatal("function Fn missing")
	}
	if derived.MemoryMB != 128 || derived.Timeout != 3 {
		t.Fatalf("absent limits must use the AWS defaults: %+v", derived)
	}
	if derived.UnresolvedMemorySize || derived.UnresolvedTimeout {
		t.Fatalf("absent limits are not unresolved: %+v", derived)
	}
}
