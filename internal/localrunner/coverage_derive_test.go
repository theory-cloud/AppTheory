//nolint:errcheck // test fixtures decode protocol shapes with unchecked type assertions
package localrunner

import (
	"encoding/json"
	"testing"
)

// TestDeriveStreamAndSubscriptionValidationCase covers the stream mapping,
// subscription filter and on-failure validation branches that the positive
// rows do not exercise.
func TestDeriveStreamAndSubscriptionValidationCase(t *testing.T) {
	base := eventSourceResources
	mapping := func(resources map[string]any, id string) map[string]any {
		return resources[id].(map[string]any)["Properties"].(map[string]any)
	}
	mutate := func(name string, edit func(map[string]any), wantErr bool) {
		t.Helper()
		resources := base()
		edit(resources)
		dir := writeAssembly(t, resources)
		mkdirAsset(t, dir)
		if _, err := deriveAssembly(t, dir); (err != nil) != wantErr {
			t.Fatalf("%s: wantErr=%v err=%v", name, wantErr, err)
		}
	}
	mutate("kin parallelization", func(values map[string]any) {
		mapping(values, "KinMap")["ParallelizationFactor"] = 11
	}, true)
	mutate("kin retry", func(values map[string]any) {
		mapping(values, "KinMap")["MaximumRetryAttempts"] = 10001
	}, true)
	mutate("kin retry negative", func(values map[string]any) {
		mapping(values, "KinMap")["MaximumRetryAttempts"] = -2
	}, true)
	mutate("kin record age", func(values map[string]any) {
		mapping(values, "KinMap")["MaximumRecordAgeInSeconds"] = 10
	}, true)
	mutate("kin record age negative", func(values map[string]any) {
		mapping(values, "KinMap")["MaximumRecordAgeInSeconds"] = -2
	}, true)
	mutate("kin tumbling", func(values map[string]any) {
		mapping(values, "KinMap")["TumblingWindowInSeconds"] = 10
	}, true)
	mutate("kin starting position", func(values map[string]any) {
		mapping(values, "KinMap")["StartingPosition"] = "BAD"
	}, true)
	mutate("kin at timestamp without time", func(values map[string]any) {
		mapping(values, "KinMap")["StartingPosition"] = "AT_TIMESTAMP"
	}, true)
	mutate("kin at timestamp", func(values map[string]any) {
		mapping(values, "KinMap")["StartingPosition"] = "AT_TIMESTAMP"
		mapping(values, "KinMap")["StartingPositionTimestamp"] = 1.0
	}, false)
	mutate("ddb at timestamp", func(values map[string]any) {
		mapping(values, "DdbMap")["StartingPosition"] = "AT_TIMESTAMP"
	}, true)
	mutate("ddb batch bounds", func(values map[string]any) {
		mapping(values, "DdbMap")["BatchSize"] = 10001
	}, true)
	mutate("ddb window bounds", func(values map[string]any) {
		mapping(values, "DdbMap")["MaximumBatchingWindowInSeconds"] = 301
	}, true)
	mutate("kin failure queue", func(values map[string]any) {
		mapping(values, "KinMap")["DestinationConfig"] = map[string]any{"OnFailure": map[string]any{"Destination": map[string]any{"Fn::GetAtt": []any{"Queue", "Arn"}}}}
	}, false)
	mutate("kin failure topic", func(values map[string]any) {
		values["Topic"] = map[string]any{"Type": typeSNSTopic, "Properties": map[string]any{"TopicName": "topic"}}
		mapping(values, "KinMap")["DestinationConfig"] = map[string]any{"OnFailure": map[string]any{"Destination": map[string]any{"Ref": "Topic"}}}
	}, false)
	mutate("kin failure literal", func(values map[string]any) {
		mapping(values, "KinMap")["DestinationConfig"] = map[string]any{"OnFailure": map[string]any{"Destination": "arn:aws:sqs:us-east-1:123456789012:dlq"}}
	}, false)
	mutate("kin failure invalid", func(values map[string]any) {
		mapping(values, "KinMap")["DestinationConfig"] = map[string]any{"OnFailure": map[string]any{"Destination": "arn:aws:logs:us-east-1:123456789012:log-group:x"}}
	}, true)
	mutate("kin filters", func(values map[string]any) {
		mapping(values, "KinMap")["FilterCriteria"] = map[string]any{"Filters": []any{map[string]any{"Pattern": `{"bad":`}}}
	}, true)
	mutate("kin batch window", func(values map[string]any) {
		mapping(values, "KinMap")["BatchSize"] = 10
		mapping(values, "KinMap")["MaximumBatchingWindowInSeconds"] = 301
	}, true)

	// Subscription filters.
	subscriptionRules := func() map[string]any {
		values := base()
		values["Group"] = map[string]any{"Type": typeLogGroup, "Properties": map[string]any{"LogGroupName": "/source"}}
		values["LogDestination"] = map[string]any{"Type": typeLogsDestination, "Properties": map[string]any{"DestinationName": "dest", "TargetArn": map[string]any{"Fn::GetAtt": []any{"Stream", "Arn"}}}}
		values["Filter"] = map[string]any{"Type": typeLogsSubscription, "Properties": map[string]any{
			"LogGroupName":   map[string]any{"Ref": "Group"},
			"FilterName":     "filter",
			"FilterPattern":  "",
			"DestinationArn": map[string]any{"Fn::GetAtt": []any{"LogDestination", "Arn"}},
		}}
		return values
	}
	subscriptionMutate := func(name string, edit func(map[string]any), wantErr bool) {
		t.Helper()
		values := subscriptionRules()
		edit(values)
		dir := writeAssembly(t, values)
		mkdirAsset(t, dir)
		if _, err := deriveAssembly(t, dir); (err != nil) != wantErr {
			t.Fatalf("%s: wantErr=%v err=%v", name, wantErr, err)
		}
	}
	subscriptionMutate("regex pattern", func(values map[string]any) {
		values["Filter"].(map[string]any)["Properties"].(map[string]any)["FilterPattern"] = "%regex%"
	}, true)
	subscriptionMutate("bad distribution", func(values map[string]any) {
		values["Filter"].(map[string]any)["Properties"].(map[string]any)["Distribution"] = "Bad"
	}, true)
	subscriptionMutate("literal group", func(values map[string]any) {
		values["Filter"].(map[string]any)["Properties"].(map[string]any)["LogGroupName"] = "/literal"
	}, false)
	subscriptionMutate("lambda destination", func(values map[string]any) {
		values["Filter"].(map[string]any)["Properties"].(map[string]any)["DestinationArn"] = map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}}
	}, false)
	subscriptionMutate("unsupported destination", func(values map[string]any) {
		values["Filter"].(map[string]any)["Properties"].(map[string]any)["DestinationArn"] = "arn:aws:firehose:us-east-1:123456789012:deliverystream/x"
	}, false)

	// A custom bus literal and a Ref to a legacy rule.
	busRules := func() map[string]any {
		values := base()
		values["LiteralBusRule"] = map[string]any{"Type": typeEventsRule, "Properties": map[string]any{
			"EventBusName": "literal-bus",
			"EventPattern": map[string]any{"source": []any{"app.test"}},
			"Targets":      []any{map[string]any{"Id": "fn", "Arn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}}}},
		}}
		return values
	}
	values := busRules()
	dir := writeAssembly(t, values)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, rule := range spec.Rules {
		if rule.LogicalID == "LiteralBusRule" && rule.BusName == "literal-bus" {
			found = true
		}
	}
	if !found {
		t.Fatalf("literal bus rule: %+v", spec.Rules)
	}
	_ = json.Valid
}
