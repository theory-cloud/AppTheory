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

func TestResourceAttributeValues(t *testing.T) {
	value := resourceValue{
		Name:  "name",
		ARN:   "arn",
		KeyID: "key-id",
		URL:   "http://queue",
	}
	cases := map[string]string{
		"Arn":                "arn",
		"Name":               "name",
		"QueueName":          "name",
		"FunctionName":       "name",
		"KeyId":              "key-id",
		"QueueUrl":           "http://queue",
		"DomainName":         "name.s3.amazonaws.com",
		"RegionalDomainName": "name.s3.us-east-1.amazonaws.com",
	}
	for attr, want := range cases {
		got, ok := value.attribute(attr)
		if !ok || got != want {
			t.Fatalf("attribute(%q) = %q, %v; want %q", attr, got, ok, want)
		}
	}
	if _, ok := value.attribute("Unknown"); ok {
		t.Fatal("an unknown attribute must not resolve")
	}
	if _, ok := (resourceValue{}).attribute("Arn"); ok {
		t.Fatal("an empty ARN must not resolve")
	}
}

func TestEventsBusRefAndArnResolveLocally(t *testing.T) {
	resource := ResourceSpec{
		Stack: "Stack", LogicalID: "Bus", Type: typeEventsBus,
		Properties: json.RawMessage(`{"Name":"app-events-local"}`),
	}
	value, err := localResourceValueFor(resource, resourceValues{}, nil)
	if err != nil {
		t.Fatalf("resolve event bus: %v", err)
	}
	if value.Name != "app-events-local" {
		t.Fatalf("bus name %q", value.Name)
	}
	if want := "arn:aws:events:us-east-1:123456789012:event-bus/app-events-local"; value.ARN != want {
		t.Fatalf("bus ARN %q != %q", value.ARN, want)
	}
	if got, ok := value.attribute("Arn"); !ok || got != value.ARN {
		t.Fatalf("GetAtt Arn = %q, %v", got, ok)
	}
	if got, err := refString(resource, value); err != nil || got != "app-events-local" {
		t.Fatalf("Ref = %q, %v", got, err)
	}
}

func TestParseGetAttForms(t *testing.T) {
	if id, attr, err := parseGetAtt([]any{"Fn", "Arn"}); err != nil || id != "Fn" || attr != "Arn" {
		t.Fatalf("array form: %q %q %v", id, attr, err)
	}
	if id, attr, err := parseGetAtt("Fn.Arn"); err != nil || id != "Fn" || attr != "Arn" {
		t.Fatalf("string form: %q %q %v", id, attr, err)
	}
	for _, raw := range []any{[]any{"Fn"}, []any{1, "Arn"}, "Fn", 3} {
		if _, _, err := parseGetAtt(raw); err == nil {
			t.Fatalf("malformed GetAtt %v must fail", raw)
		}
	}
}

func TestResolveExpressionRejectsMalformedValues(t *testing.T) {
	runner := &Runner{}
	if _, err := runner.resolveExpression("not-json", "Stack", nil, nil); err == nil {
		t.Fatal("malformed JSON must fail")
	}
	if _, err := runner.resolveExpression(`3`, "Stack", nil, nil); err == nil {
		t.Fatal("a non-string scalar must fail")
	}
}

func TestLocalPhysicalNameIsBounded(t *testing.T) {
	long := localPhysicalName("a-very-long-stack-name-that-keeps-going", "a-very-long-logical-id-that-keeps-going-too")
	if len(long) > 63 {
		t.Fatalf("local name is not S3-bounded: %q (%d)", long, len(long))
	}
	if localPhysicalName("S", "X") == localPhysicalName("S", "Y") {
		t.Fatal("distinct resources need distinct names")
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
