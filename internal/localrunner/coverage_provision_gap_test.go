package localrunner

import (
	"context"
	"encoding/json"
	"testing"
)

// TestProvisionResourcesBackendErrors proves every provisioner fails closed
// when its backend has an endpoint but no loopback URL.
func TestProvisionResourcesBackendErrors(t *testing.T) {
	cases := []struct {
		name     string
		resource ResourceSpec
		service  string
	}{
		{"log group", ResourceSpec{Stack: "S", LogicalID: "Group", Type: typeLogGroup, Properties: json.RawMessage(`{"LogGroupName":"/group"}`)}, logsService},
		{"bucket", ResourceSpec{Stack: "S", LogicalID: "Bucket", Type: typeS3Bucket, Properties: json.RawMessage(`{"BucketName":"bucket"}`)}, "s3"},
		{"deployment", ResourceSpec{Stack: "S", LogicalID: "Deploy", Type: typeBucketDeploy, Properties: json.RawMessage(`{}`)}, "s3"},
		{"key", ResourceSpec{Stack: "S", LogicalID: "Key", Type: typeKMSKey, Properties: json.RawMessage(`{}`)}, "kms"},
		{"alias", ResourceSpec{Stack: "S", LogicalID: "Alias", Type: typeKMSAlias, Properties: json.RawMessage(`{"AliasName":"alias"}`)}, "kms"},
		{"table", ResourceSpec{Stack: "S", LogicalID: "Table", Type: typeDynamoTable, Properties: json.RawMessage(`{"TableName":"table"}`)}, backendDynamoDB},
		{"queue", ResourceSpec{Stack: "S", LogicalID: "Queue", Type: typeSQSQueue, Properties: json.RawMessage(`{"QueueName":"queue"}`)}, backendSQS},
		{"parameter", ResourceSpec{Stack: "S", LogicalID: "Parameter", Type: typeSSMParameter, Properties: json.RawMessage(`{"Name":"parameter","Value":"v"}`)}, backendSSM},
		{"secret", ResourceSpec{Stack: "S", LogicalID: "Secret", Type: typeSecretsSecret, Properties: json.RawMessage(`{}`)}, backendSecretsManager},
		{"topic", ResourceSpec{Stack: "S", LogicalID: "Topic", Type: typeSNSTopic, Properties: json.RawMessage(`{"TopicName":"topic"}`)}, backendSNS},
		{"stream", ResourceSpec{Stack: "S", LogicalID: "Stream", Type: typeKinesisStream, Properties: json.RawMessage(`{"Name":"stream"}`)}, backendKinesis},
		{"pool", ResourceSpec{Stack: "S", LogicalID: "Pool", Type: typeCognitoUserPool, Properties: json.RawMessage(`{"UserPoolName":"pool"}`)}, backendCognito},
	}
	for _, testCase := range cases {
		runner := &Runner{backends: map[string]backendProcess{testCase.service: {
			Endpoints: []Endpoint{{Service: testCase.service, URL: "http://127.0.0.1:1"}},
		}}}
		spec := &Spec{Resources: []ResourceSpec{testCase.resource}}
		if err := runner.provisionResources(context.Background(), spec); err == nil {
			t.Errorf("%s: the missing loopback endpoint must fail", testCase.name)
		}
	}
}

func TestLogGroupNameFallbacks(t *testing.T) {
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "S", LogicalID: "Fn", Type: typeLambdaFunction, Properties: json.RawMessage(`{"FunctionName":"fn"}`)},
		{Stack: "S", LogicalID: "Group", Type: typeLogGroup, Properties: json.RawMessage(`{"LogGroupName":"/group"}`)},
	}}
	if got := logGroupResourceName(spec, ResourceSpec{Stack: "S", LogicalID: "Bad", Type: typeLogGroup, Properties: json.RawMessage(`bad`)}); got == "" {
		t.Fatal("invalid properties need a fallback name")
	}
	if got := logGroupResourceName(spec, ResourceSpec{Stack: "S", LogicalID: "Empty", Type: typeLogGroup}); got == "" {
		t.Fatal("a missing log group name needs a fallback")
	}
	if got := logGroupResourceName(spec, ResourceSpec{Stack: "S", LogicalID: "Joined", Type: typeLogGroup, Properties: json.RawMessage(`{"LogGroupName":{"Fn::Join":["",["/aws/lambda/",{"Ref":"Fn"}]]}}`)}); got != "/aws/lambda/fn" {
		t.Fatalf("joined name: %q", got)
	}
	if got := logGroupResourceName(spec, ResourceSpec{Stack: "S", LogicalID: "Nested", Type: typeLogGroup, Properties: json.RawMessage(`{"LogGroupName":{"Fn::Join":["",[{"Ref":"Group"}]]}}`)}); got != "/group" {
		t.Fatalf("nested group name: %q", got)
	}
	for _, value := range []any{
		map[string]any{"Ref": "Missing"},
		map[string]any{"Ref": "Fn"},
		map[string]any{"Fn::Join": "bad"},
		map[string]any{"Fn::Join": []any{1, []any{"a"}}},
		map[string]any{"Fn::Join": []any{"-", "bad"}},
		map[string]any{"Fn::Join": []any{"-", []any{"a", map[string]any{"Ref": "Missing"}}}},
		[]any{"a"},
		7,
	} {
		_ = flattenLogGroupValueInSpec(spec, "S", value)
	}
	if got := flattenLogGroupValueInSpec(spec, "S", map[string]any{"Ref": "Missing"}); got != "" {
		t.Fatalf("missing ref: %q", got)
	}
	if got := flattenLogGroupValueInSpec(spec, "S", map[string]any{"Ref": "Group"}); got != "/group" {
		t.Fatalf("group ref: %q", got)
	}
	if got := flattenLogGroupValueInSpec(spec, "S", map[string]any{"Ref": "Fn"}); got != "fn" {
		t.Fatalf("function ref: %q", got)
	}
	if got := flattenLogGroupValueInSpec(spec, "S", map[string]any{"Fn::Join": []any{"-", []any{"a", map[string]any{"Ref": "Missing"}}}}); got != "" {
		t.Fatalf("unresolved join: %q", got)
	}
}
