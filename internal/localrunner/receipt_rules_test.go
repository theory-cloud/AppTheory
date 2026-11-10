package localrunner

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestDeriveReceiptRules(t *testing.T) {
	resources := map[string]any{
		"Fn":     withAsset(lambdaFunction(nil), "asset.deadbeef"),
		"Bucket": map[string]any{"Type": typeS3Bucket, "Properties": map[string]any{}},
		"Rule": map[string]any{
			"Type": typeSESReceiptRule,
			"Properties": map[string]any{
				"RuleSetName": "inbound",
				"Rule": map[string]any{
					"Name":       "forward",
					"Enabled":    true,
					"Recipients": []any{"ingress.example.test"},
					"Actions": []any{
						map[string]any{"S3Action": map[string]any{
							"BucketName":      map[string]any{"Ref": "Bucket"},
							"ObjectKeyPrefix": "mail/",
						}},
						map[string]any{"LambdaAction": map[string]any{
							"FunctionArn":    map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
							"InvocationType": "Event",
						}},
						map[string]any{"StopAction": map[string]any{"Scope": "RuleSet"}},
						map[string]any{"SNSAction": map[string]any{"TopicArn": "arn:aws:sns:us-east-1:123456789012:mail"}},
					},
				},
			},
		},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssemblyAllowNoSurface(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.ReceiptRules) != 1 {
		t.Fatalf("want one receipt rule, got %+v", spec.ReceiptRules)
	}
	rule := spec.ReceiptRules[0]
	if rule.RuleSetName != "inbound" || rule.Name != "forward" || !rule.Enabled {
		t.Fatalf("unexpected rule: %+v", rule)
	}
	if len(rule.Actions) != 3 {
		t.Fatalf("want three served actions, got %+v", rule.Actions)
	}
	if rule.Actions[0].Kind != receiptActionS3 || rule.Actions[0].ObjectKeyPrefix != "mail/" {
		t.Fatalf("the S3 action must be first: %+v", rule.Actions[0])
	}
	if rule.Actions[1].Kind != receiptActionLambda || rule.Actions[1].InvocationType != receiptInvocationEvent {
		t.Fatalf("the Lambda action must follow: %+v", rule.Actions[1])
	}
	if rule.Actions[2].Kind != receiptActionStop {
		t.Fatalf("the stop action must be kept: %+v", rule.Actions[2])
	}
	if len(rule.UnservedActions) != 1 || rule.UnservedActions[0] != "SNSAction" {
		t.Fatalf("an unserved action kind must be reported: %+v", rule.UnservedActions)
	}
	// The Lambda action's function must be a runtime target, or the row that
	// injects a message has no container to reach.
	targets := spec.RuntimeFunctions()
	found := false
	for _, id := range targets {
		if id == rule.Actions[1].Function {
			found = true
		}
	}
	if !found {
		t.Fatalf("the receipt rule's Lambda action must be started: %v", targets)
	}
}

func TestDeriveReceiptRuleReportsAnUnresolvableAction(t *testing.T) {
	resources := map[string]any{
		"Rule": map[string]any{
			"Type": typeSESReceiptRule,
			"Properties": map[string]any{
				"RuleSetName": "inbound",
				"Rule": map[string]any{
					"Enabled":    true,
					"Recipients": []any{"a@example.test"},
					"Actions": []any{
						map[string]any{"LambdaAction": map[string]any{"FunctionArn": "arn:aws:lambda:us-east-1:123456789012:function:external"}},
					},
				},
			},
		},
	}
	dir := writeAssembly(t, resources)
	spec, err := deriveAssemblyAllowNoSurface(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	reported := false
	for _, skipped := range spec.Skipped {
		if skipped.Kind == typeSESReceiptRule && strings.Contains(skipped.Reason, "does not name an AWS::Lambda::Function") {
			reported = true
		}
	}
	if !reported {
		t.Fatalf("an action naming an external function must be reported: %+v", spec.Skipped)
	}
}

func TestReceiptRulesForMatchesExactAndDomainRecipients(t *testing.T) {
	rules := []ReceiptRuleSpec{
		{LogicalID: "Exact", Enabled: true, Recipients: []string{"Ingress.Example.Test"}},
		{LogicalID: "Domain", Enabled: true, Recipients: []string{"example.test"}},
		{LogicalID: "Disabled", Enabled: false, Recipients: []string{"ingress.example.test"}},
		{LogicalID: "Other", Enabled: true, Recipients: []string{"elsewhere.test"}},
	}
	matched := receiptRulesFor(rules, "ingress@example.test")
	if len(matched) != 1 || matched[0].LogicalID != "Domain" {
		t.Fatalf("a domain recipient must match its addresses: %+v", matched)
	}
	matched = receiptRulesFor(rules, "ingress.example.test")
	if len(matched) != 1 || matched[0].LogicalID != "Exact" {
		t.Fatalf("an exact recipient must match exactly: %+v", matched)
	}
	if matched := receiptRulesFor(rules, "nobody@unrelated.test"); len(matched) != 0 {
		t.Fatalf("an unmatched recipient must match nothing: %+v", matched)
	}
	if matched := receiptRulesFor(rules, "nobody@elsewhere.test"); len(matched) != 1 || matched[0].LogicalID != "Other" {
		t.Fatalf("a domain recipient must match addresses in its domain: %+v", matched)
	}
}

func TestReceiptObjectKey(t *testing.T) {
	for _, tc := range []struct{ prefix, want string }{
		{"mail/", "mail/id"},
		{"mail", "mail/id"},
		{"", "id"},
		{"  ", "id"},
	} {
		if got := receiptObjectKey(tc.prefix, "id"); got != tc.want {
			t.Fatalf("receiptObjectKey(%q) = %q, want %q", tc.prefix, got, tc.want)
		}
	}
}

func TestReceiptEventMatchesTheDocumentedShape(t *testing.T) {
	raw := strings.Join([]string{
		"Return-Path: <bounce@example.test>",
		"From: Sender <sender@example.test>",
		"To: recipient@example.test",
		"Subject: hello",
		"Message-ID: <id@example.test>",
		"Date: Mon, 5 Aug 2019 21:29:57 +0000",
		"",
		"body",
	}, "\r\n")
	parsed, err := parseReceiptMessage(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	spec := &Spec{
		Functions: []FunctionSpec{{LogicalID: "EmailFn", Stack: "S"}},
		Resources: []ResourceSpec{{Stack: "S", LogicalID: "EmailFn", Type: typeLambdaFunction, Properties: json.RawMessage(`{"FunctionName":"email"}`)}},
	}
	runner := &Runner{spec: spec}
	event, err := runner.receiptEvent(spec, receiptEventInput{
		rule:       ReceiptRuleSpec{LogicalID: "Rule"},
		action:     ReceiptAction{Kind: receiptActionLambda, Function: "EmailFn", InvocationType: receiptInvocationEvent},
		message:    receivedMessage{Source: "bounce@example.test", Recipients: []string{"recipient@example.test"}, Raw: raw},
		messageID:  "1234",
		receivedAt: time.Date(2019, 8, 5, 21, 30, 2, 0, time.UTC),
		headers:    parsed.headers,
		common:     parsed.common,
	})
	if err != nil {
		t.Fatalf("receipt event: %v", err)
	}
	var document map[string]any
	if err := json.Unmarshal(event, &document); err != nil {
		t.Fatalf("decode: %v", err)
	}
	records, ok := document["Records"].([]any)
	if !ok || len(records) != 1 {
		t.Fatalf("want one record: %v", document)
	}
	record := mustMap(t, records[0])
	if record["eventSource"] != "aws:ses" || record["eventVersion"] != "1.0" {
		t.Fatalf("unexpected record envelope: %v", record)
	}
	ses := mustMap(t, record["ses"])
	mail := mustMap(t, ses["mail"])
	if mail["source"] != "bounce@example.test" || mail["messageId"] != "1234" {
		t.Fatalf("unexpected mail: %v", mail)
	}
	if mail["headersTruncated"] != false {
		t.Fatalf("headersTruncated must be false: %v", mail)
	}
	destination := mustSlice(t, mail["destination"])
	if len(destination) != 1 || destination[0] != "recipient@example.test" {
		t.Fatalf("unexpected destination: %v", destination)
	}
	headers := mustSlice(t, mail["headers"])
	if len(headers) != 6 {
		t.Fatalf("want six headers, got %v", headers)
	}
	first := mustMap(t, headers[0])
	if first["name"] != "Date" {
		t.Fatalf("headers are listed in name order: %v", headers)
	}
	common := mustMap(t, mail["commonHeaders"])
	if common["subject"] != "hello" || common["messageId"] != "<id@example.test>" {
		t.Fatalf("unexpected commonHeaders: %v", common)
	}
	from := mustSlice(t, common["from"])
	if len(from) != 1 || from[0] != "Sender <sender@example.test>" {
		t.Fatalf("unexpected from: %v", from)
	}
	receipt := mustMap(t, ses["receipt"])
	if receipt["recipients"] == nil {
		t.Fatalf("receipt.recipients is required: %v", receipt)
	}
	action := mustMap(t, receipt["action"])
	if action["type"] != "Lambda" || action["invocationType"] != "Event" {
		t.Fatalf("unexpected action: %v", action)
	}
	if !strings.Contains(mustString(t, action["functionArn"]), ":function:email") {
		t.Fatalf("the action must name the local function ARN: %v", action)
	}
	// The body is absent from the Lambda record, exactly as SES documents.
	if _, present := record["body"]; present {
		t.Fatalf("the Lambda record must omit the body: %v", record)
	}
}

func TestReceiptEventNeedsALocalFunction(t *testing.T) {
	runner := &Runner{}
	spec := &Spec{}
	if _, err := runner.receiptEvent(spec, receiptEventInput{
		action:  ReceiptAction{Kind: receiptActionLambda, Function: "Missing"},
		message: receivedMessage{Recipients: []string{"a@example.test"}},
	}); err == nil {
		t.Fatal("a receipt action with no local function must fail closed")
	}
}
