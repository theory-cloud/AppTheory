package localrunner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// lambdaTestInvoker is a container stand-in for the endpoints that only need a
// request to reach a handler.
type lambdaTestInvoker struct {
	fn func(payload []byte) ([]byte, error)
}

func (f lambdaTestInvoker) Invoke(_ context.Context, payload []byte) ([]byte, error) {
	return f.fn(payload)
}

func TestProblemResourceTypesCoverDocs127Problem4(t *testing.T) {
	// Every type docs/127 Problem 4 lists has a class and a reason; the reason
	// cites the docs/125 true limit for the class.
	for _, resourceType := range []string{
		"AWS::ApiGateway::DomainName",
		"AWS::ApiGateway::BasePathMapping",
		"AWS::ApiGatewayV2::DomainName",
		"AWS::ApiGatewayV2::ApiMapping",
		"AWS::CertificateManager::Certificate",
		"AWS::Route53::RecordSet",
		"AWS::CloudWatch::Alarm",
		"AWS::CloudWatch::Dashboard",
		"AWS::Lambda::NetworkConnector",
		"AWS::EC2::SecurityGroup",
		"AWS::SES::EmailIdentity",
		"AWS::Lambda::MicrovmImage",
	} {
		entry, ok := problemResourceTypes[resourceType]
		if !ok {
			t.Fatalf("%s has no handling", resourceType)
		}
		if entry.detail == "" {
			t.Fatalf("%s has no type-specific reason", resourceType)
		}
		switch entry.handling {
		case handlingDeployTimeOnly:
			if !strings.Contains(deployTimeOnlyReason, "docs/125 true limit") {
				t.Fatalf("the deploy-time-only reason must cite the true limit: %q", deployTimeOnlyReason)
			}
		case handlingRefused:
			if !strings.Contains(refusedMicrovmReason, "docs/125 true limit") {
				t.Fatalf("the refusal must cite the true limit: %q", refusedMicrovmReason)
			}
		default:
			t.Fatalf("%s must be deploy-time-only or refused, not served", resourceType)
		}
	}
	if _, served := problemResourceTypes["Custom::Trigger"]; served {
		t.Fatal("a custom resource is served, not classified as deploy-time-only")
	}
}

func TestClassifyProblemResourcesReportsEveryDeclaredType(t *testing.T) {
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "S", LogicalID: "Domain", Type: "AWS::ApiGateway::DomainName"},
		{Stack: "S", LogicalID: "Mapping", Type: "AWS::ApiGatewayV2::ApiMapping"},
		{Stack: "S", LogicalID: "Cert", Type: "AWS::CertificateManager::Certificate"},
		{Stack: "S", LogicalID: "Record", Type: "AWS::Route53::RecordSet"},
		{Stack: "S", LogicalID: "Alarm", Type: "AWS::CloudWatch::Alarm"},
		{Stack: "S", LogicalID: "Dashboard", Type: "AWS::CloudWatch::Dashboard"},
		{Stack: "S", LogicalID: "Connector", Type: "AWS::Lambda::NetworkConnector"},
		{Stack: "S", LogicalID: "Group", Type: "AWS::EC2::SecurityGroup"},
		{Stack: "S", LogicalID: "Identity", Type: "AWS::SES::EmailIdentity"},
		{Stack: "S", LogicalID: "Image", Type: "AWS::Lambda::MicrovmImage"},
		// A type outside the Problem 4 list stays as it was: not reported.
		{Stack: "S", LogicalID: "Table", Type: typeDynamoTable},
	}}
	classifyProblemResources(spec)
	got := map[string]string{}
	for _, skipped := range spec.Skipped {
		got[skipped.LogicalID] = skipped.Kind + " | " + skipped.Reason
	}
	if len(got) != 10 {
		t.Fatalf("want 10 reported types, got %d: %v", len(got), got)
	}
	if _, reported := got["Table"]; reported {
		t.Fatalf("a DynamoDB table is served and must not be reported: %v", got)
	}
	if reason := got["Image"]; !strings.Contains(reason, "refused") || !strings.Contains(reason, "MicroVM") {
		t.Fatalf("the MicroVM image must be refused by name: %q", reason)
	}
	if reason := got["Domain"]; !strings.Contains(reason, "deploy-time-only") {
		t.Fatalf("a custom domain must be deploy-time-only: %q", reason)
	}
	if reason := got["Identity"]; !strings.Contains(reason, "SES identity") {
		t.Fatalf("an SES identity must say what it is: %q", reason)
	}
}

func TestRefusedResourceReasonNamesOnlyRefusedTypes(t *testing.T) {
	reason, refused := refusedResourceReason("AWS::Lambda::MicrovmImage")
	if !refused || !strings.Contains(reason, "MicroVM") {
		t.Fatalf("a MicroVM image must be refused: %q %v", reason, refused)
	}
	if _, refused := refusedResourceReason("AWS::CloudWatch::Alarm"); refused {
		t.Fatal("a deploy-time-only type is not a refusal")
	}
	if _, refused := refusedResourceReason("AWS::S3::Bucket"); refused {
		t.Fatal("a served type is not a refusal")
	}
}

func TestDeriveCustomResources(t *testing.T) {
	resources := map[string]any{
		"Fn":     withAsset(lambdaFunction(nil), "asset.deadbeef"),
		"Deploy": map[string]any{"Type": typeBucketDeploy, "Properties": map[string]any{}},
		"Notes":  map[string]any{"Type": "Custom::S3BucketNotifications", "Properties": map[string]any{}},
		"Trigger": map[string]any{
			"Type": "Custom::Trigger",
			"Properties": map[string]any{
				"ServiceToken": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
				"HandlerArn":   map[string]any{"Ref": "Fn"},
				"Timeout":      "60000",
			},
		},
		"Provider": map[string]any{
			"Type": "Custom::Migration",
			"Properties": map[string]any{
				"ServiceToken":     map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
				"ServiceTimeout":   "30",
				"MigrationVersion": "1",
			},
		},
		"Generic": map[string]any{
			"Type": typeCloudFormationCustomResource,
			"Properties": map[string]any{
				"ServiceToken": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
			},
		},
		"Unknown": map[string]any{
			"Type": "Custom::Elsewhere",
			"Properties": map[string]any{
				// An SNS topic ARN is a service token CloudFormation accepts and
				// the runner cannot invoke.
				"ServiceToken": map[string]any{"Ref": "Topic"},
			},
		},
		"Topic": map[string]any{"Type": typeSNSTopic, "Properties": map[string]any{"TopicName": "tokens"}},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssemblyAllowNoSurface(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	byID := map[string]CustomResourceSpec{}
	for _, resource := range spec.CustomResources {
		byID[resource.LogicalID] = resource
	}
	if len(byID) != 5 {
		t.Fatalf("want 5 custom resources, got %d: %+v", len(byID), spec.CustomResources)
	}
	if byID["Deploy"].ServedBy == "" {
		t.Fatal("a bucket deployment is served by the runner's own copy")
	}
	if byID["Notes"].ServedBy == "" {
		t.Fatal("the bucket-notification handler is served by the runner's own derivation")
	}
	if byID["Trigger"].Function == "" || byID["Trigger"].Type != "Custom::Trigger" {
		t.Fatalf("a trigger must name its handler: %+v", byID["Trigger"])
	}
	if byID["Generic"].Function == "" {
		t.Fatalf("a generic custom resource must name its handler: %+v", byID["Generic"])
	}
	reported := false
	for _, skipped := range spec.Skipped {
		if skipped.LogicalID == "Unknown" && strings.Contains(skipped.Reason, "service token is not a Lambda function ARN") {
			reported = true
		}
	}
	if !reported {
		t.Fatalf("a non-Lambda service token must be reported: %+v", spec.Skipped)
	}
}

func TestCustomResourceMicrovmRefusal(t *testing.T) {
	resources := map[string]any{
		"Fn": withAsset(lambdaFunction(nil), "asset.deadbeef"),
		"Image": map[string]any{
			"Type":       typeMicrovmImage,
			"Properties": map[string]any{"Name": "runner"},
		},
		"Prune": map[string]any{
			"Type": typeCloudFormationCustomResource,
			"Properties": map[string]any{
				"ServiceToken":           map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
				"MicrovmImageProperties": map[string]any{"Name": map[string]any{"Ref": "Image"}},
			},
		},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssemblyAllowNoSurface(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.CustomResources) != 1 {
		t.Fatalf("want one custom resource, got %+v", spec.CustomResources)
	}
	refusal := spec.CustomResources[0].Refusal
	if !strings.Contains(refusal, "MicroVM") || !strings.Contains(refusal, typeMicrovmImage) {
		t.Fatalf("a custom resource targeting a MicroVM must be refused by name: %q", refusal)
	}
}

func TestDependencyOrderPutsReferencedResourcesFirst(t *testing.T) {
	resources := []CustomResourceSpec{
		{LogicalID: "B", Stack: "S", Properties: json.RawMessage(`{"Ref":"A"}`)},
		{LogicalID: "A", Stack: "S"},
	}
	ordered := dependencyOrder(resources)
	if ordered[0].LogicalID != "A" || ordered[1].LogicalID != "B" {
		t.Fatalf("a resource that references another must be invoked after it: %+v", ordered)
	}
}

func TestServiceTimeout(t *testing.T) {
	for _, tc := range []struct {
		properties map[string]any
		want       time.Duration
	}{
		{map[string]any{"ServiceTimeout": "30"}, 30 * time.Second},
		{map[string]any{"ServiceTimeout": float64(45)}, 45 * time.Second},
		{map[string]any{"Timeout": "60"}, 60 * time.Second},
		{map[string]any{}, 0},
		{map[string]any{"ServiceTimeout": "not-a-number"}, 0},
	} {
		if got := serviceTimeout(tc.properties); got != tc.want {
			t.Fatalf("serviceTimeout(%v) = %v, want %v", tc.properties, got, tc.want)
		}
	}
}

func TestCustomResourceResponseServerRoundTrip(t *testing.T) {
	server := &customResourceResponseServer{responses: map[string]chan customResourceResponse{}}
	waiter := server.expect("run.One")

	body := `{"Status":"SUCCESS","PhysicalResourceId":"bucket","Data":{"Key":"value"}}`
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPut, customResourceRequestPath+"run.One", strings.NewReader(body))
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("a response document must be accepted, got %d: %s", recorder.Code, recorder.Body.String())
	}
	select {
	case document := <-waiter:
		if document.Status != customResourceStatusSuccess || document.PhysicalResourceID != "bucket" {
			t.Fatalf("unexpected response document: %+v", document)
		}
		if document.Data["Key"] != "value" {
			t.Fatalf("the Data document must round-trip: %+v", document.Data)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the response waiter was never woken")
	}

	// A GET is refused and an unknown request id is 404, exactly as a handler
	// retrying against a stale URL would see.
	get := httptest.NewRecorder()
	server.ServeHTTP(get, httptest.NewRequestWithContext(context.Background(), http.MethodGet, customResourceRequestPath+"run.One", nil))
	if get.Code != http.StatusMethodNotAllowed {
		t.Fatalf("a GET must be refused, got %d", get.Code)
	}
	unknown := httptest.NewRecorder()
	server.ServeHTTP(unknown, httptest.NewRequestWithContext(context.Background(), http.MethodPut, customResourceRequestPath+"run.Unknown", strings.NewReader(`{"Status":"SUCCESS"}`)))
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("an unknown request id must be 404, got %d", unknown.Code)
	}
	invalid := httptest.NewRecorder()
	server.ServeHTTP(invalid, httptest.NewRequestWithContext(context.Background(), http.MethodPut, customResourceRequestPath+"run.One", strings.NewReader("not json")))
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("a non-JSON document must be refused, got %d", invalid.Code)
	}
	if url := server.responseURL("run.One"); url != customResourceRequestPath+"run.One" {
		t.Fatalf("the response URL must name the request id: %q", url)
	}
	server.close()
	server.forget("run.One")
}

func TestSpecNeedsInternalHTTPS(t *testing.T) {
	if specNeedsInternalHTTPS(&Spec{}) {
		t.Fatal("an assembly with no custom resource needs no internal HTTPS endpoint")
	}
	if specNeedsInternalHTTPS(&Spec{CustomResources: []CustomResourceSpec{
		{LogicalID: "Deploy", ServedBy: "the runner copies the asset"},
	}}) {
		t.Fatal("a custom resource the runner serves itself needs no handler endpoint")
	}
	if specNeedsInternalHTTPS(&Spec{CustomResources: []CustomResourceSpec{
		{LogicalID: "Prune", Refusal: "refused"},
	}}) {
		t.Fatal("a refused custom resource needs no handler endpoint")
	}
	if !specNeedsInternalHTTPS(&Spec{CustomResources: []CustomResourceSpec{
		{LogicalID: "Trigger", Function: "Fn"},
	}}) {
		t.Fatal("a handler-invoked custom resource needs the internal HTTPS endpoint")
	}
}

func TestLambdaInvokeFunctionPath(t *testing.T) {
	for _, tc := range []struct {
		path string
		want string
		ok   bool
	}{
		{lambdaInvokePathPrefix + "my-function" + lambdaInvokePathSuffix, "my-function", true},
		{lambdaInvokePathPrefix + "arn%3Aaws%3Alambda%3Aus-east-1%3A123456789012%3Afunction%3Amy-function" + lambdaInvokePathSuffix, "arn:aws:lambda:us-east-1:123456789012:function:my-function", true},
		{lambdaInvokePathPrefix + lambdaInvokePathSuffix, "", false},
		{"/2015-03-31/functions/my-function", "", false},
		{"/other", "", false},
	} {
		got, ok := lambdaInvokeFunctionPath(tc.path)
		if ok != tc.ok || got != tc.want {
			t.Fatalf("lambdaInvokeFunctionPath(%q) = %q,%v want %q,%v", tc.path, got, ok, tc.want, tc.ok)
		}
	}
}

func TestFunctionByInvokeNameResolvesANameAndAnArn(t *testing.T) {
	spec := &Spec{
		Functions: []FunctionSpec{{LogicalID: "Worker", Stack: "S"}},
		Resources: []ResourceSpec{
			{Stack: "S", LogicalID: "Worker", Type: typeLambdaFunction, Properties: json.RawMessage(`{"FunctionName":"worker"}`)},
		},
	}
	runner := &Runner{spec: spec}
	if id, ok := runner.functionByInvokeName("worker"); !ok || id != "Worker" {
		t.Fatalf("a bare name must resolve: %q %v", id, ok)
	}
	if id, ok := runner.functionByInvokeName("arn:aws:lambda:us-east-1:123456789012:function:worker"); !ok || id != "Worker" {
		t.Fatalf("an ARN must resolve: %q %v", id, ok)
	}
	if _, ok := runner.functionByInvokeName("missing"); ok {
		t.Fatal("an unknown name must not resolve")
	}
}

func TestLambdaInvokeFrontDispatchesToTheContainer(t *testing.T) {
	invoked := make(chan []byte, 1)
	runner := &Runner{
		options: Options{},
		spec: &Spec{
			Functions: []FunctionSpec{{LogicalID: "Worker", Stack: "S"}},
			Resources: []ResourceSpec{
				{Stack: "S", LogicalID: "Worker", Type: typeLambdaFunction, Properties: json.RawMessage(`{"FunctionName":"worker"}`)},
			},
		},
	}
	front := &lambdaInvokeFront{runner: runner, invokerFor: func(id string) (Invoker, bool) {
		if id != "Worker" {
			return nil, false
		}
		return lambdaTestInvoker{fn: func(payload []byte) ([]byte, error) {
			invoked <- payload
			return []byte(`{"ok":true}`), nil
		}}, true
	}}
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, lambdaInvokePathPrefix+"worker"+lambdaInvokePathSuffix, strings.NewReader(`{"hello":"world"}`))
	recorder := httptest.NewRecorder()
	front.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("an invocation must answer 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.String() != `{"ok":true}` {
		t.Fatalf("the handler payload must be returned unchanged: %q", recorder.Body.String())
	}
	select {
	case payload := <-invoked:
		if string(payload) != `{"hello":"world"}` {
			t.Fatalf("the handler received %q", payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the handler was never invoked")
	}

	missing := httptest.NewRecorder()
	front.ServeHTTP(missing, httptest.NewRequestWithContext(context.Background(), http.MethodPost, lambdaInvokePathPrefix+"missing"+lambdaInvokePathSuffix, nil))
	if missing.Code != http.StatusNotFound || !strings.Contains(missing.Body.String(), "ResourceNotFoundException") {
		t.Fatalf("an unknown function must be a named 404, got %d: %s", missing.Code, missing.Body.String())
	}
	badPath := httptest.NewRecorder()
	front.ServeHTTP(badPath, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/nope", nil))
	if badPath.Code != http.StatusNotFound {
		t.Fatalf("an unknown path must be 404, got %d", badPath.Code)
	}
	get := httptest.NewRecorder()
	front.ServeHTTP(get, httptest.NewRequestWithContext(context.Background(), http.MethodGet, lambdaInvokePathPrefix+"worker"+lambdaInvokePathSuffix, nil))
	if get.Code != http.StatusMethodNotAllowed {
		t.Fatalf("a GET must be refused, got %d", get.Code)
	}
}
