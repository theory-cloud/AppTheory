package localrunner

import (
	"encoding/json"
	"strings"
	"testing"
)

func environmentSpec(expressions map[string]string) *Spec {
	return &Spec{
		Functions: []FunctionSpec{{
			LogicalID:              "Fn",
			Stack:                  "Stack",
			Runtime:                "nodejs24.x",
			Handler:                "index.handler",
			Architecture:           "x86_64",
			Environment:            map[string]string{"LITERAL": "kept"},
			UnresolvedEnvironment:  sortedKeys(expressions),
			EnvironmentExpressions: expressions,
		}},
		APIs: []APISpec{{Class: APIHTTPV2, Routes: []Route{{Function: "Fn", Method: "GET", Path: "/"}}}},
		Resources: []ResourceSpec{
			{Stack: "Stack", LogicalID: "Table", Type: typeDynamoTable},
			{Stack: "Stack", LogicalID: "Queue", Type: typeSQSQueue},
			{Stack: "Stack", LogicalID: "Rule", Type: typeEventsRule, Properties: json.RawMessage(`{"Name":"local-rule"}`)},
			{Stack: "Stack", LogicalID: "Bucket", Type: typeS3Bucket},
			{Stack: "Stack", LogicalID: "Key", Type: typeKMSKey, Properties: json.RawMessage(`{"Description":"data key"}`)},
			{Stack: "Stack", LogicalID: "Lambda", Type: typeLambdaFunction},
		},
	}
}

func TestResolveEnvironmentExpressions(t *testing.T) {
	spec := environmentSpec(map[string]string{
		"TABLE":      `{"Ref":"Table"}`,
		"QUEUE":      `{"Ref":"Queue"}`,
		"QUEUE_NAME": `{"Fn::GetAtt":["Queue","QueueName"]}`,
		"RULE":       `{"Ref":"Rule"}`,
		"BUCKET":     `{"Ref":"Bucket"}`,
		"BUCKET_ARN": `{"Fn::GetAtt":["Bucket","Arn"]}`,
		"KEY":        `{"Fn::GetAtt":["Key","Arn"]}`,
		"FUNCTION":   `{"Fn::GetAtt":["Lambda","Arn"]}`,
		"JOINED":     `{"Fn::Join":["-",["prefix",{"Ref":"Rule"},"suffix"]]}`,
		"PARTITION":  `{"Ref":"AWS::Partition"}`,
		"REGION":     `{"Ref":"AWS::Region"}`,
		"ACCOUNT":    `{"Ref":"AWS::AccountId"}`,
		"STACK":      `{"Ref":"AWS::StackName"}`,
	})
	runner := &Runner{
		endpoints: []Endpoint{{Service: "sqs", URL: "http://sqs:9324"}},
		resourceValues: resourceValues{
			"Stack/Bucket": {Name: "local-bucket", ARN: "arn:aws:s3:::local-bucket"},
			"Stack/Key":    {Name: "key-id", KeyID: "key-id", ARN: "arn:aws:kms:us-east-1:123456789012:key/key-id"},
		},
	}
	if err := runner.resolveEnvironment(spec, []string{"Fn"}); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	function := spec.Functions[0]
	if function.Environment["LITERAL"] != "kept" {
		t.Fatalf("literal value lost: %+v", function.Environment)
	}
	expect := map[string]string{
		"TABLE":      localPhysicalName("Stack", "Table"),
		"QUEUE":      "http://sqs:9324/123456789012/" + localPhysicalName("Stack", "Queue"),
		"QUEUE_NAME": localPhysicalName("Stack", "Queue"),
		"RULE":       "local-rule",
		"BUCKET":     "local-bucket",
		"BUCKET_ARN": "arn:aws:s3:::local-bucket",
		"KEY":        "arn:aws:kms:us-east-1:123456789012:key/key-id",
		"FUNCTION":   "arn:aws:lambda:us-east-1:123456789012:function:" + localPhysicalName("Stack", "Lambda"),
		"JOINED":     "prefix-local-rule-suffix",
		"PARTITION":  "aws",
		"REGION":     "us-east-1",
		"ACCOUNT":    "123456789012",
		"STACK":      "Stack",
	}
	for name, want := range expect {
		if got := function.Environment[name]; got != want {
			t.Fatalf("%s = %q, want %q", name, got, want)
		}
	}
	if function.UnresolvedEnvironment != nil || function.EnvironmentExpressions != nil {
		t.Fatalf("resolved expressions must be cleared: %+v %+v", function.UnresolvedEnvironment, function.EnvironmentExpressions)
	}
}

func TestResolveEnvironmentFailsClosed(t *testing.T) {
	cases := map[string]struct {
		expressions map[string]string
		provisioned resourceValues
		want        string
	}{
		"missing KMS provisioning": {
			expressions: map[string]string{"KEY": `{"Ref":"Key"}`},
			want:        "backend moto",
		},
		"missing S3 provisioning": {
			expressions: map[string]string{"BUCKET": `{"Ref":"Bucket"}`},
			want:        "backend s3proxy",
		},
		"unknown resource": {
			expressions: map[string]string{"MISSING": `{"Ref":"Missing"}`},
			want:        "names no resource",
		},
		"unsupported intrinsic": {
			expressions: map[string]string{"SUB": `{"Fn::Sub":"${Thing}"}`},
			want:        "unsupported CloudFormation expression",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			spec := environmentSpec(tc.expressions)
			runner := &Runner{resourceValues: tc.provisioned}
			err := runner.resolveEnvironment(spec, []string{"Fn"})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want error containing %q, got %v", tc.want, err)
			}
		})
	}
}

func TestResolveEnvironmentSkipsUnservedFunctions(t *testing.T) {
	spec := environmentSpec(map[string]string{"KEY": `{"Ref":"Key"}`})
	spec.APIs = nil
	runner := &Runner{}
	if err := runner.resolveEnvironment(spec, nil); err != nil {
		t.Fatalf("an unserved function's environment must not block the run: %v", err)
	}
}

func TestLiteralPhysicalNameWins(t *testing.T) {
	name, err := resourceName(ResourceSpec{
		Stack: "Stack", LogicalID: "Bucket", Type: typeS3Bucket,
		Properties: json.RawMessage(`{"BucketName":"explicit-bucket"}`),
	})
	if err != nil || name != "explicit-bucket" {
		t.Fatalf("explicit name: %q %v", name, err)
	}
	derived := localPhysicalName("Stack", "Bucket")
	if len(derived) > 63 || strings.ContainsAny(derived, "_ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
		t.Fatalf("derived name is not S3-safe: %q", derived)
	}
}
