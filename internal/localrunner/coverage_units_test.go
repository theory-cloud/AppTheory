package localrunner

// Focused unit tests for the derivation, projection-formatting and CloudFormation
// expression helpers the local runner uses. They are pure functions, so a table
// pins their contract without starting a container or a backend.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

func TestSplitAssemblyEnvironment(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in      string
		account string
		region  string
	}{
		{"aws://123456789012/us-east-1", "123456789012", "us-east-1"},
		{" aws://123456789012/eu-west-2 ", "123456789012", "eu-west-2"},
		{"aws://123456789012", "123456789012", ""},
		{"", "", ""},
		{"custom", "", ""},
	}
	for _, tc := range cases {
		account, region := splitAssemblyEnvironment(tc.in)
		if account != tc.account || region != tc.region {
			t.Fatalf("splitAssemblyEnvironment(%q) = (%q, %q), want (%q, %q)", tc.in, account, region, tc.account, tc.region)
		}
	}
}

func TestCanonicalURIAndQuery(t *testing.T) {
	t.Parallel()
	for input, want := range map[string]string{"": "/", "path": "/path", "/path": "/path"} {
		if got := canonicalURI(input); got != want {
			t.Fatalf("canonicalURI(%q) = %q, want %q", input, got, want)
		}
	}
	cases := map[string]string{
		"":                 "",
		"b=2&a=1":          "a=1&b=2",
		"a=1&a=2":          "a=1&a=2",
		"a=%zz":            "a=%zz",
		"key with space=1": "key+with+space=1",
	}
	for input, want := range cases {
		if got := canonicalQuery(input); got != want {
			t.Fatalf("canonicalQuery(%q) = %q, want %q", input, got, want)
		}
	}
	if got := sha256Hex([]byte("abc")); got != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Fatalf("sha256Hex = %q", got)
	}
}

func TestCollectGetAtt(t *testing.T) {
	t.Parallel()
	var refs []logicalRef
	collectGetAtt([]any{"Bucket", "Arn"}, &refs)
	collectGetAtt([]any{"Bucket"}, &refs)
	collectGetAtt([]any{42, "Arn"}, &refs)
	collectGetAtt([]any{"Bucket", 42}, &refs)
	collectGetAtt("Queue.Url", &refs)
	collectGetAtt("Queue", &refs)
	collectGetAtt(".Hidden", &refs)
	want := []logicalRef{{ID: "Bucket", Attr: "Arn"}, {ID: "Bucket"}, {ID: "Queue", Attr: "Url"}, {ID: "Queue"}}
	if len(refs) != len(want) {
		t.Fatalf("collectGetAtt collected %+v, want %+v", refs, want)
	}
	for index := range want {
		if refs[index] != want[index] {
			t.Fatalf("collectGetAtt[%d] = %+v, want %+v", index, refs[index], want[index])
		}
	}
}

func TestRefsInAndDirectRefID(t *testing.T) {
	t.Parallel()
	if refs := refsIn(nil); refs != nil {
		t.Fatalf("refsIn(nil) = %+v, want nil", refs)
	}
	if refs := refsIn(json.RawMessage(`{`)); refs != nil {
		t.Fatalf("refsIn(invalid) = %+v, want nil", refs)
	}
	refs := refsIn(json.RawMessage(`{"a":{"Ref":"One"},"b":[{"Fn::GetAtt":["Two","Arn"]},{"Fn::Sub":"x"}]}`))
	if len(refs) != 2 || refs[0].ID != "One" || refs[1].ID != "Two" || refs[1].Attr != "Arn" {
		t.Fatalf("refsIn = %+v", refs)
	}
	if id, ok := directRefID(json.RawMessage(`{"Ref":"One"}`)); !ok || id != "One" {
		t.Fatalf("directRefID Ref = %q %v", id, ok)
	}
	if _, ok := directRefID(json.RawMessage(`{"Ref":""}`)); ok {
		t.Fatalf("directRefID accepted an empty Ref")
	}
	if _, ok := directRefID(json.RawMessage(`{`)); ok {
		t.Fatalf("directRefID accepted invalid JSON")
	}
	if id, ok := findRefByType(json.RawMessage(`{"Fn::GetAtt":["Fn","Arn"]}`), map[string]string{"Fn": "AWS::Lambda::Function"}, "AWS::Lambda::Function", "Arn"); !ok || id != "Fn" {
		t.Fatalf("findRefByType = %q %v", id, ok)
	}
	if _, ok := findRefByType(json.RawMessage(`{"Ref":"Fn"}`), map[string]string{"Fn": "AWS::S3::Bucket"}, "AWS::Lambda::Function"); ok {
		t.Fatalf("findRefByType matched the wrong resource type")
	}
}

func TestProjectionFormatting(t *testing.T) {
	t.Parallel()
	if got := formatActualProjection(nil); got != noIndexPart {
		t.Fatalf("formatActualProjection(nil) = %q", got)
	}
	if got := formatActualProjection(&types.Projection{ProjectionType: types.ProjectionTypeAll}); got != "ALL" {
		t.Fatalf("formatActualProjection(ALL) = %q", got)
	}
	if got := formatActualProjection(&types.Projection{
		ProjectionType:   types.ProjectionTypeInclude,
		NonKeyAttributes: []string{"a", "b"},
	}); got != "INCLUDE (a, b)" {
		t.Fatalf("formatActualProjection(INCLUDE) = %q", got)
	}
	if got := formatWantedProjection(dynamoProjection{}); got != noIndexPart {
		t.Fatalf("formatWantedProjection(zero) = %q", got)
	}
	if got := formatWantedProjection(dynamoProjection{ProjectionType: "ALL"}); got != "ALL" {
		t.Fatalf("formatWantedProjection(ALL) = %q", got)
	}
	if got := formatWantedProjection(dynamoProjection{ProjectionType: "INCLUDE", NonKeyAttributes: []string{"x"}}); got != "INCLUDE (x)" {
		t.Fatalf("formatWantedProjection(INCLUDE) = %q", got)
	}
}

func TestEventBridgeVariableJSON(t *testing.T) {
	t.Parallel()
	cases := []struct {
		value    any
		inString bool
		want     string
	}{
		{"plain", false, `"plain"`},
		{"plain", true, "plain"},
		{`quote"inside`, true, `quote\"inside`},
		{42, true, "42"},
		{map[string]any{"a": 1}, false, `{"a":1}`},
	}
	for _, tc := range cases {
		got, err := eventBridgeVariableJSON(tc.value, tc.inString)
		if err != nil {
			t.Fatalf("eventBridgeVariableJSON(%v, %v): %v", tc.value, tc.inString, err)
		}
		if string(got) != tc.want {
			t.Fatalf("eventBridgeVariableJSON(%v, %v) = %q, want %q", tc.value, tc.inString, got, tc.want)
		}
	}
	if _, err := eventBridgeVariableJSON(func() {}, false); err == nil {
		t.Fatalf("eventBridgeVariableJSON accepted an unmarshalable value")
	}
}

func TestStackOf(t *testing.T) {
	t.Parallel()
	spec := &Spec{Resources: []ResourceSpec{{Stack: "St", LogicalID: "Fn", Type: typeLambdaFunction}}}
	if got := spec.stackOf(FunctionSpec{LogicalID: "Fn", Stack: "Explicit"}); got != "Explicit" {
		t.Fatalf("stackOf explicit = %q", got)
	}
	if got := spec.stackOf(FunctionSpec{LogicalID: "Fn"}); got != "St" {
		t.Fatalf("stackOf derived = %q", got)
	}
	if got := spec.stackOf(FunctionSpec{LogicalID: "Missing"}); got != "" {
		t.Fatalf("stackOf missing = %q", got)
	}
}

func TestCustomResourceHandlerRefusal(t *testing.T) {
	t.Parallel()
	spec := &Spec{Functions: []FunctionSpec{
		{LogicalID: "Runnable", AssetDir: "/tmp/code"},
		{LogicalID: "Inline", InlineCode: "exports.handler = async () => {};"},
		{LogicalID: "Image", ImageAsset: &DockerImageAssetSpec{}},
		{LogicalID: "Problem", CodeProblem: "the asset is missing"},
		{LogicalID: "Empty"},
	}}
	if got := customResourceHandlerRefusal(spec, "Absent"); !strings.Contains(got, "not a Lambda function") {
		t.Fatalf("absent handler refusal = %q", got)
	}
	for _, id := range []string{"Runnable", "Inline", "Image"} {
		if got := customResourceHandlerRefusal(spec, id); got != "" {
			t.Fatalf("%s refusal = %q, want empty", id, got)
		}
	}
	if got := customResourceHandlerRefusal(spec, "Problem"); !strings.Contains(got, "the asset is missing") {
		t.Fatalf("problem refusal = %q", got)
	}
	if got := customResourceHandlerRefusal(spec, "Empty"); !strings.Contains(got, "code asset is not in the assembly") {
		t.Fatalf("empty refusal = %q", got)
	}
}

func TestCustomResourceHandlerTarget(t *testing.T) {
	t.Parallel()
	stack := assemblyStack{
		Name: "St",
		Template: template{
			Resources: map[string]templateResource{
				"Fn":  {Type: "AWS::Lambda::Function"},
				"Ver": {Type: "AWS::Lambda::Version", Properties: json.RawMessage(`{"FunctionName":{"Ref":"Fn"}}`)},
			},
		},
	}
	cases := []struct {
		properties string
		want       string
	}{
		{``, ""},
		{`{"HandlerArn":{"Ref":"Fn"}}`, "Fn"},
		{`{"HandlerArn":{"Fn::GetAtt":["Fn","Arn"]}}`, "Fn"},
		{`{"HandlerArn":{"Ref":"Ver"}}`, "Fn"},
		{`{"HandlerArn":{"Ref":"Missing"}}`, ""},
		{`{"Other":1}`, ""},
	}
	for _, tc := range cases {
		resource := templateResource{Type: "Custom::Trigger", Properties: json.RawMessage(tc.properties)}
		if got := customResourceHandlerTarget(stack, resource); got != tc.want {
			t.Fatalf("customResourceHandlerTarget(%s) = %q, want %q", tc.properties, got, tc.want)
		}
	}
}

func TestSNSSubscriptionsForTopic(t *testing.T) {
	t.Parallel()
	spec := &Spec{Subscriptions: []SubscriptionSpec{
		{LogicalID: "One", Kind: string(DeliveryKindSNS), Topic: "St/Topic"},
		{LogicalID: "Two", Kind: string(DeliveryKindSNS), Topic: "Topic"},
		{LogicalID: "Logs", Kind: "cloudwatch-logs", Topic: "Topic"},
		{LogicalID: "Other", Kind: string(DeliveryKindSNS), Topic: "Elsewhere"},
	}}
	runner := &Runner{}
	indices := runner.snsSubscriptionsForTopic(spec, ResourceSpec{Stack: "St", LogicalID: "Topic"})
	if len(indices) != 2 || indices[0] != 0 || indices[1] != 1 {
		t.Fatalf("snsSubscriptionsForTopic = %v, want [0 1]", indices)
	}
}

func TestQualify(t *testing.T) {
	t.Parallel()
	if got := qualify(nil, "St", "Fn"); got != "Fn" {
		t.Fatalf("qualify(single) = %q", got)
	}
	if got := qualify([]assemblyStack{{Name: "A"}, {Name: "B"}}, "B", "Fn"); got != "B/Fn" {
		t.Fatalf("qualify(multi) = %q", got)
	}
}

func TestRefusedResourceReason(t *testing.T) {
	t.Parallel()
	cases := map[string]bool{
		"AWS::Lambda::Function":               false,
		"AWS::Lambda::MicrovmImage":           true,
		"AWS::S3::Bucket":                     false,
		"AWS::ApiGateway::Account":            false,
		"AWS::CloudFormation::CustomResource": false,
		"Custom::Trigger":                     false,
	}
	for resourceType, refused := range cases {
		_, got := refusedResourceReason(resourceType)
		if got != refused {
			t.Fatalf("refusedResourceReason(%q) refused = %v, want %v", resourceType, got, refused)
		}
	}
	if reason, refused := refusedResourceReason("AWS::Lambda::MicrovmImage"); !refused || !strings.Contains(reason, "MicroVM") {
		t.Fatalf("MicroVM refusal = %q %v", reason, refused)
	}
	if !customResourceType("Custom::Trigger") || !customResourceType("AWS::CloudFormation::CustomResource") {
		t.Fatalf("customResourceType rejected a custom resource type")
	}
	if customResourceType("AWS::S3::Bucket") {
		t.Fatalf("customResourceType accepted an AWS type")
	}
}

func TestRewriteQueueURL(t *testing.T) {
	t.Parallel()
	rewritten, err := rewriteQueueURL("https://sqs.us-east-1.amazonaws.com/123/queue", "http://127.0.0.1:9324")
	if err != nil || rewritten != "http://127.0.0.1:9324/123/queue" {
		t.Fatalf("rewriteQueueURL = %q, %v", rewritten, err)
	}
	if _, err := rewriteQueueURL("://bad", "http://127.0.0.1:9324"); err == nil {
		t.Fatalf("rewriteQueueURL accepted a malformed queue URL")
	}
	if _, err := rewriteQueueURL("https://sqs.example/queue", "not-a-url"); err == nil {
		t.Fatalf("rewriteQueueURL accepted a relative base endpoint")
	}
}

func TestEndpointForService(t *testing.T) {
	t.Parallel()
	endpoints := []Endpoint{{Service: "dynamodb", URL: "http://127.0.0.1:8000"}, {Service: "sqs"}}
	endpoint, ok := endpointForService(endpoints, "dynamodb")
	if !ok || endpoint.URL != "http://127.0.0.1:8000" {
		t.Fatalf("endpointForService = %+v %v", endpoint, ok)
	}
	if _, ok := endpointForService(endpoints, "missing"); ok {
		t.Fatalf("endpointForService found a missing service")
	}
}

func TestQueueErrorPredicates(t *testing.T) {
	t.Parallel()
	if !tableAlreadyExists(&testError{"ResourceInUseException: table exists"}) {
		t.Fatalf("tableAlreadyExists missed the emulator message")
	}
	if tableAlreadyExists(&testError{"other"}) {
		t.Fatalf("tableAlreadyExists accepted an unrelated error")
	}
	if !ttlAlreadyEnabled(&testError{"TimeToLive is already enabled"}) {
		t.Fatalf("ttlAlreadyEnabled missed the emulator message")
	}
	if ttlAlreadyEnabled(&testError{"other"}) {
		t.Fatalf("ttlAlreadyEnabled accepted an unrelated error")
	}
}

func TestRedrivePolicy(t *testing.T) {
	t.Parallel()
	runner := &Runner{resourceValues: resourceValues{
		"St/Dlq": {ARN: "arn:aws:sqs:us-east-1:123456789012:dlq"},
	}}
	success, err := runner.redrivePolicy(ResourceSpec{Stack: "St", LogicalID: "Queue"},
		json.RawMessage(`{"deadLetterTargetArn":{"Fn::GetAtt":["Dlq","Arn"]},"maxReceiveCount":"3"}`))
	if err != nil {
		t.Fatalf("redrivePolicy: %v", err)
	}
	if !strings.Contains(success["RedrivePolicy"], "arn:aws:sqs:us-east-1:123456789012:dlq") ||
		!strings.Contains(success["RedrivePolicy"], `"maxReceiveCount":3`) {
		t.Fatalf("redrivePolicy = %v", success)
	}
	for _, raw := range []string{
		`{`,
		`{}`,
		`{"deadLetterTargetArn":{"Ref":"Missing"},"maxReceiveCount":1}`,
		`{"deadLetterTargetArn":{"Ref":"Dlq"},"maxReceiveCount":"zero"}`,
	} {
		if _, err := runner.redrivePolicy(ResourceSpec{Stack: "St", LogicalID: "Queue"}, json.RawMessage(raw)); err == nil {
			t.Fatalf("redrivePolicy(%s) accepted an invalid policy", raw)
		}
	}
}

func TestAWSJSONErrorFormatting(t *testing.T) {
	t.Parallel()
	if got := (&awsJSONError{Code: "ResourceNotFoundException", Status: 400}).Error(); got != "ResourceNotFoundException (HTTP 400)" {
		t.Fatalf("awsJSONError without a message = %q", got)
	}
	if got := (&awsJSONError{Code: "ResourceNotFoundException", Message: "gone", Status: 400}).Error(); got != "ResourceNotFoundException: gone" {
		t.Fatalf("awsJSONError with a message = %q", got)
	}
}

type testError struct{ message string }

func (e *testError) Error() string { return e.message }
