package localrunner

import (
	"context"
	"strings"
	"testing"
)

// LOCAL-W3-M1 validation, fifth pass: the session's describe document, which is
// how a proving row asserts what a run derived.

func TestSessionDescribeReportsEverySurface(t *testing.T) {
	runner := iamTestRunner(t)
	dir := t.TempDir()
	state, err := newLocalCASigner(dir)
	if err != nil {
		t.Fatalf("newLocalCASigner: %v", err)
	}
	runner.tls = state
	runner.tlsBundlePath = dir + "/ca.pem"
	runner.publicTLS = true
	runner.apiURLs = map[string]string{
		"Api": "http://127.0.0.1:1/lab",
		"Url": "http://127.0.0.1:2/",
		"Ws":  "ws://127.0.0.1:3/lab",
	}
	runner.resourceValues = resourceValues{
		"Stack/Table": {
			Type: typeDynamoTable, Name: "table", ARN: "arn:aws:dynamodb:us-east-1:1:table/table",
			URL: "http://127.0.0.1/table", StreamARN: "stream", KeyID: "key",
		},
		"Stack/Pool": {
			Type: typeCognitoUserPool, Name: "pool", ProviderName: "provider",
			ProviderURL: "https://pool", LocalIssuer: "https://local", SSMType: "SecureString",
		},
	}
	runner.localSecrets = map[string]string{"Secret": "value"}
	runner.invokers = map[string]*FunctionProcess{
		"ApiFn": {Function: FunctionSpec{LogicalID: "ApiFn"}, Port: 9000},
	}

	spec := &Spec{
		Functions: []FunctionSpec{{LogicalID: "ApiFn", Stack: "Stack", Runtime: "provided.al2023",
			Environment: map[string]string{"A": "b"}}},
		APIs: []APISpec{{
			Class: APIRESTV1, LogicalID: "Api", Stack: "Stack", Stage: "lab",
			Routes: []Route{{Class: APIRESTV1, Method: "GET", Path: "/items", Function: "ApiFn"}},
		}},
		FunctionURLs: []FunctionURLSpec{{LogicalID: "Url", Stack: "Stack", Function: "ApiFn", IAM: true}},
		WebSockets: []WebSocketAPISpec{{
			Class: APIWebSocket, LogicalID: "Ws", Stack: "Stack", Stage: "lab",
			RouteSelectionExpression: "$request.body.action",
			Routes:                   []WebSocketRouteSpec{{RouteKey: "$connect", Function: "ApiFn"}},
			Authorizer:               &WebSocketAuthorizerSpec{Function: "ApiFn", MethodARN: "arn:aws:execute-api:us-east-1:1:api/lab/$connect"},
		}},
		CustomResources: []CustomResourceSpec{
			{LogicalID: "Refused", Stack: "Stack", Type: "Custom::X", Refusal: "refused by name"},
			{LogicalID: "Served", Stack: "Stack", Type: typeBucketDeploy, ServedBy: "the runner copies the asset"},
			{LogicalID: "Handler", Stack: "Stack", Type: "Custom::Y", Function: "ApiFn"},
		},
		ReceiptRules: []ReceiptRuleSpec{{LogicalID: "Rule", Stack: "Stack", RuleSetName: "mail"}},
		Notifications: []NotificationSpec{{
			LogicalID: "Notify", Bucket: "Bucket", BucketName: "bucket",
			DestinationType: "lambda", Destination: "ApiFn", Events: []string{"s3:ObjectCreated:*"},
			ConfigurationID: "config",
		}},
		EventSources: []EventSourceSpec{{LogicalID: "Source", Function: "ApiFn"}},
		Rules:        []RuleSpec{{LogicalID: "Rule", Name: "rule"}},
	}
	runner.spec = spec
	runner.customResourceData = map[string]map[string]string{"Stack/Handler": {"Value": "reported"}}
	runner.customResourcePhysicalIDs = map[string]string{"Stack/Handler": "handler-1"}
	session := &localSession{runner: runner, spec: spec}

	document, err := session.describe()
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	functions, _ := document["functions"].([]map[string]any) //nolint:errcheck // the document shape is asserted below
	if len(functions) != 1 || functions[0]["port"] != 9000 {
		t.Fatalf("the function entry is wrong: %+v", functions)
	}
	apis, _ := document["apis"].([]map[string]any) //nolint:errcheck // the document shape is asserted below
	if len(apis) != 3 {
		t.Fatalf("the API entries are wrong: %+v", apis)
	}
	custom, _ := document["customResources"].([]map[string]any) //nolint:errcheck // the document shape is asserted below
	if len(custom) != 3 || custom[0]["refused"] == nil || custom[1]["servedBy"] == nil || custom[2]["physicalResourceId"] != "handler-1" {
		t.Fatalf("the custom-resource entries are wrong: %+v", custom)
	}
	resources, _ := document["resources"].([]map[string]any) //nolint:errcheck // the document shape is asserted below
	if len(resources) != 2 {
		t.Fatalf("the provisioned resources are wrong: %+v", resources)
	}
	secrets, _ := document["secrets"].(map[string]string) //nolint:errcheck // the document shape is asserted below
	if secrets["Secret"] != "value" {
		t.Fatalf("the secrets entry is wrong: %+v", secrets)
	}
	tlsEntry, _ := document["tls"].(map[string]any) //nolint:errcheck // the document shape is asserted below
	if tlsEntry["enabled"] != true {
		t.Fatalf("the TLS entry is wrong: %+v", tlsEntry)
	}
	if document["iam"] == nil {
		t.Fatal("an IAM plane must be described")
	}
	notifications, _ := document["notifications"].([]map[string]any) //nolint:errcheck // the document shape is asserted below
	if len(notifications) != 1 || notifications[0]["logicalId"] != "Notify" {
		t.Fatalf("the notification entry is wrong: %+v", notifications)
	}
	if document["runtimeMode"] == nil {
		t.Fatal("the runtime mode must be reported")
	}
}

func TestSessionExecuteRefusesAnUnknownOperation(t *testing.T) {
	runner := iamTestRunner(t)
	session := &localSession{runner: runner, spec: &Spec{}}
	if _, err := session.execute(context.Background(), sessionRequest{Op: "nope"}); err == nil {
		t.Fatal("an unknown operation must be refused by name")
	}
	if session.handle(context.Background(), "not json").Error == "" {
		t.Fatal("a command that is not JSON must be refused by name")
	}
}

func TestBookkeepingAndPolicyTypesAreReported(t *testing.T) {
	spec := &Spec{
		Resources: []ResourceSpec{
			{Stack: "Stack", LogicalID: "Metadata", Type: typeCDKMetadata},
			{Stack: "Stack", LogicalID: "Account", Type: typeAPIGatewayAccount},
			{Stack: "Stack", LogicalID: "Filter", Type: typeLogsMetricFilter},
			{Stack: "Stack", LogicalID: "BucketPolicy", Type: typeS3BucketPolicy},
			{Stack: "Stack", LogicalID: "LogPolicy", Type: typeLogsResourcePolicy},
			{Stack: "Stack", LogicalID: "Served", Type: typeS3Bucket},
		},
	}
	stacks := []assemblyStack{{Name: "Stack", Template: template{Resources: map[string]templateResource{
		"BucketPolicy": {Type: typeS3BucketPolicy},
		"LogPolicy":    {Type: typeLogsResourcePolicy},
		"Served":       {Type: typeS3Bucket},
	}}}}
	classifyProblemResources(spec)
	deriveProvisioningSkips(spec, stacks)
	reported := map[string]string{}
	for _, skipped := range spec.Skipped {
		reported[skipped.LogicalID] = skipped.Reason
	}
	for _, id := range []string{"Metadata", "Account", "Filter"} {
		if reason := reported[id]; reason == "" || !containsAll(reason, "deploy-time-only", "docs/125 true limit") {
			t.Fatalf("%s must be reported as deploy-time-only: %q", id, reason)
		}
	}
	for _, id := range []string{"BucketPolicy", "LogPolicy"} {
		if reason := reported[id]; reason == "" || !containsAll(reason, "docs/125 true limit") {
			t.Fatalf("%s must carry the IAM true-limit reason: %q", id, reason)
		}
	}
	if _, ok := reported["Served"]; ok {
		t.Fatal("a served type is reported by the component that serves it")
	}
}

func containsAll(value string, parts ...string) bool {
	for _, part := range parts {
		if !strings.Contains(value, part) {
			return false
		}
	}
	return true
}
