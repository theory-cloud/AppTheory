package localrunner

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func eventSourceResources() map[string]any {
	return map[string]any{
		"Fn": withAsset(lambdaFunction(nil), "asset.deadbeef"),
		"Queue": map[string]any{
			"Type": typeSQSQueue,
			"Properties": map[string]any{
				"QueueName": "events",
			},
		},
		"Table": map[string]any{
			"Type": typeDynamoTable,
			"Properties": map[string]any{
				"TableName":            "items",
				"KeySchema":            []any{map[string]any{"AttributeName": "pk", "KeyType": "HASH"}},
				"AttributeDefinitions": []any{map[string]any{"AttributeName": "pk", "AttributeType": "S"}},
				"StreamSpecification":  map[string]any{"StreamViewType": "NEW_AND_OLD_IMAGES"},
			},
		},
		"Stream": map[string]any{
			"Type":       typeKinesisStream,
			"Properties": map[string]any{"Name": "logs"},
		},
		"SqsMap": map[string]any{
			"Type": typeEventSourceMap,
			"Properties": map[string]any{
				"EventSourceArn":        map[string]any{"Fn::GetAtt": []any{"Queue", "Arn"}},
				"FunctionName":          map[string]any{"Ref": "Fn"},
				"BatchSize":             7,
				"FunctionResponseTypes": []any{"ReportBatchItemFailures"},
			},
		},
		"DdbMap": map[string]any{
			"Type": typeEventSourceMap,
			"Properties": map[string]any{
				"EventSourceArn": map[string]any{"Fn::GetAtt": []any{"Table", "StreamArn"}},
				"FunctionName":   map[string]any{"Ref": "Fn"},
			},
		},
		"KinMap": map[string]any{
			"Type": typeEventSourceMap,
			"Properties": map[string]any{
				"EventSourceArn":   map[string]any{"Fn::GetAtt": []any{"Stream", "Arn"}},
				"FunctionName":     map[string]any{"Ref": "Fn"},
				"StartingPosition": "LATEST",
			},
		},
		"Schedule": map[string]any{
			"Type": typeEventsRule,
			"Properties": map[string]any{
				"ScheduleExpression": "rate(5 minutes)",
				"State":              "ENABLED",
				"Targets": []any{map[string]any{
					"Arn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
					"Id":  "Target0",
				}},
			},
		},
		"Pattern": map[string]any{
			"Type": typeEventsRule,
			"Properties": map[string]any{
				"EventPattern": map[string]any{
					"source":      []any{"apptheory.example"},
					"detail-type": []any{"example.item.changed"},
				},
				"State": "ENABLED",
				"Targets": []any{map[string]any{
					"Arn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
					"Id":  "Target0",
				}},
			},
		},
	}
}

func TestDeriveEventSourceMappingsAndRules(t *testing.T) {
	dir := writeAssembly(t, eventSourceResources())
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.EventSources) != 3 {
		t.Fatalf("want three event sources, got %+v", spec.EventSources)
	}
	byID := map[string]EventSourceSpec{}
	for _, source := range spec.EventSources {
		byID[source.LogicalID] = source
	}
	sqs := byID["SqsMap"]
	if sqs.Type != "sqs" || sqs.Source != "Queue" || sqs.SourceName != "events" {
		t.Fatalf("unexpected sqs mapping: %+v", sqs)
	}
	if sqs.BatchSize != 7 || !sqs.ReportBatchItemFailures || !sqs.Enabled {
		t.Fatalf("sqs batch options lost: %+v", sqs)
	}
	ddb := byID["DdbMap"]
	if ddb.Type != "dynamodb" || ddb.SourceName != "items" || ddb.BatchSize != 100 {
		t.Fatalf("unexpected dynamodb mapping: %+v", ddb)
	}
	if !strings.HasSuffix(ddb.SourceARN, "table/items/stream/local") {
		t.Fatalf("unexpected dynamodb source arn: %s", ddb.SourceARN)
	}
	kinesis := byID["KinMap"]
	if kinesis.Type != "kinesis" || kinesis.SourceName != "logs" || kinesis.StartingPosition != "LATEST" {
		t.Fatalf("unexpected kinesis mapping: %+v", kinesis)
	}
	if len(spec.Rules) != 2 {
		t.Fatalf("want two rules, got %+v", spec.Rules)
	}
	rules := map[string]RuleSpec{}
	for _, rule := range spec.Rules {
		rules[rule.LogicalID] = rule
	}
	if rules["Schedule"].Schedule != "rate(5 minutes)" || rules["Schedule"].Targets[0] != "Fn" {
		t.Fatalf("schedule rule lost: %+v", rules["Schedule"])
	}
	if !strings.Contains(string(rules["Pattern"].EventPattern), "apptheory.example") {
		t.Fatalf("pattern rule lost: %+v", rules["Pattern"])
	}
	runtimeFunctions := spec.RuntimeFunctions()
	if len(runtimeFunctions) != 1 || runtimeFunctions[0] != "Fn" {
		t.Fatalf("event targets must be runtime functions: %+v", runtimeFunctions)
	}
}

func TestDeriveUnsupportedEventSourceIsReported(t *testing.T) {
	resources := eventSourceResources()
	resources["Topic"] = map[string]any{"Type": "AWS::SNS::Topic", "Properties": map[string]any{}}
	resources["TopicMap"] = map[string]any{
		"Type": typeEventSourceMap,
		"Properties": map[string]any{
			"EventSourceArn": map[string]any{"Ref": "Topic"},
			"FunctionName":   map[string]any{"Ref": "Fn"},
		},
	}
	resources["ForeignRule"] = map[string]any{
		"Type": typeEventsRule,
		"Properties": map[string]any{
			"ScheduleExpression": "rate(1 hour)",
			"Targets":            []any{map[string]any{"Arn": "arn:aws:logs:us-east-1:123456789012:log-group:x", "Id": "T"}},
		},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	reasons := map[string]string{}
	for _, skipped := range spec.Skipped {
		reasons[skipped.LogicalID] = skipped.Reason
	}
	if !strings.Contains(reasons["TopicMap"], "not delivered locally") {
		t.Fatalf("unsupported event source was not reported: %+v", reasons)
	}
	if !strings.Contains(reasons["ForeignRule"], "no Lambda function target") {
		t.Fatalf("non-Lambda rule target was not reported: %+v", reasons)
	}
}

func TestDeriveHTTPAuthorizerResolvesTheFunction(t *testing.T) {
	resources := httpAPIResources("GET /hello")
	resources["Fn"] = withAsset(lambdaFunction(nil), "asset.deadbeef")
	resources["Authorizer"] = map[string]any{
		"Type": typeHTTPAuthorizer,
		"Properties": map[string]any{
			"AuthorizerType":        "REQUEST",
			"AuthorizerUri":         map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
			"EnableSimpleResponses": true,
			"IdentitySource":        []any{"$request.header.Authorization"},
		},
	}
	route := mustMap(t, mustMap(t, resources["Route"])["Properties"])
	route["AuthorizationType"] = "CUSTOM"
	route["AuthorizerId"] = map[string]any{"Ref": "Authorizer"}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	routeSpec := spec.APIs[0].Routes[0]
	if routeSpec.AuthorizerFunction != "Fn" {
		t.Fatalf("authorizer function not derived: %+v", routeSpec)
	}
	if len(routeSpec.AuthorizerIdentitySources) != 1 ||
		routeSpec.AuthorizerIdentitySources[0] != "$request.header.Authorization" {
		t.Fatalf("identity sources not derived: %+v", routeSpec)
	}
	if len(spec.RuntimeFunctions()) != 1 {
		t.Fatalf("the authorizer and handler are one function: %+v", spec.RuntimeFunctions())
	}
}

func TestDeriveHTTPAuthorizerRejectsUnsupportedIdentitySource(t *testing.T) {
	for _, source := range []string{"$context.accountId", "$stageVariables.tenant", "$request.header.", "$request.querystring."} {
		t.Run(source, func(t *testing.T) {
			resources := httpAPIResources("GET /hello")
			resources["Fn"] = withAsset(lambdaFunction(nil), "asset.deadbeef")
			resources["Authorizer"] = map[string]any{
				"Type": typeHTTPAuthorizer,
				"Properties": map[string]any{
					"AuthorizerType":        "REQUEST",
					"AuthorizerUri":         map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
					"EnableSimpleResponses": true,
					"IdentitySource":        []any{source},
				},
			}
			route := mustMap(t, mustMap(t, resources["Route"])["Properties"])
			route["AuthorizationType"] = "CUSTOM"
			route["AuthorizerId"] = map[string]any{"Ref": "Authorizer"}
			dir := writeAssembly(t, resources)
			mkdirAsset(t, dir)
			_, err := deriveAssembly(t, dir)
			if err == nil {
				t.Fatalf("identity source %q must fail closed", source)
			}
			var unsupportedErr *UnsupportedError
			if !errors.As(err, &unsupportedErr) {
				t.Fatalf("identity source %q must report a named unsupported error, got %T: %v", source, err, err)
			}
			if unsupportedErr.Construct != "TestStack/Authorizer" || !strings.Contains(unsupportedErr.Reason, source) {
				t.Fatalf("identity source %q error does not name the construct and source: %+v", source, unsupportedErr)
			}
		})
	}
}

func TestDeriveHTTPAuthorizerMustBeSimpleRequest(t *testing.T) {
	resources := httpAPIResources("GET /hello")
	resources["Fn"] = withAsset(lambdaFunction(nil), "asset.deadbeef")
	resources["Authorizer"] = map[string]any{
		"Type": typeHTTPAuthorizer,
		"Properties": map[string]any{
			"AuthorizerType":        "REQUEST",
			"AuthorizerUri":         map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
			"EnableSimpleResponses": false,
		},
	}
	route := mustMap(t, mustMap(t, resources["Route"])["Properties"])
	route["AuthorizationType"] = "CUSTOM"
	route["AuthorizerId"] = map[string]any{"Ref": "Authorizer"}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	if _, err := deriveAssembly(t, dir); err == nil || !strings.Contains(err.Error(), "simple responses") {
		t.Fatalf("a non-simple authorizer must fail closed, got %v", err)
	}
}

func TestDeriveEventRuleRejectsAmbiguousIdentity(t *testing.T) {
	resources := eventSourceResources()
	resources["Both"] = map[string]any{
		"Type": typeEventsRule,
		"Properties": map[string]any{
			"ScheduleExpression": "rate(1 minute)",
			"EventPattern":       map[string]any{"source": []any{"x"}},
			"Targets":            []any{map[string]any{"Arn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}}}},
		},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	if _, err := deriveAssembly(t, dir); err == nil || !strings.Contains(err.Error(), "both ScheduleExpression and EventPattern") {
		t.Fatalf("ambiguous rule must fail closed, got %v", err)
	}
}

func TestPlanJSONCarriesEventSourcesAndRules(t *testing.T) {
	dir := writeAssembly(t, eventSourceResources())
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	encoded, err := json.Marshal(spec)
	if err != nil {
		t.Fatalf("encode spec: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decode spec: %v", err)
	}
	if len(mustSlice(t, decoded["eventSources"])) != 3 {
		t.Fatalf("event sources missing from plan document: %+v", decoded["eventSources"])
	}
	if len(mustSlice(t, decoded["rules"])) != 2 {
		t.Fatalf("rules missing from plan document: %+v", decoded["rules"])
	}
}
