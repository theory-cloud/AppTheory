package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// LOCAL-W3-M1 validation, tenth pass: the small remaining units the resource
// rows touch — the response shim, the resource index, the SSE put decision and
// the receipt event variants.

func TestPrepareNodeResponseShimWritesThePreload(t *testing.T) {
	runner := &Runner{scratch: t.TempDir()}
	path, err := runner.prepareNodeResponseShim()
	if err != nil {
		t.Fatalf("prepareNodeResponseShim: %v", err)
	}
	if !strings.HasSuffix(path, "cfn-response-port.cjs") {
		t.Fatalf("the shim path is %q", path)
	}
	payload, err := os.ReadFile(path) //nolint:gosec // the path is the shim the test just wrote
	if err != nil {
		t.Fatalf("read the shim: %v", err)
	}
	if len(payload) == 0 || !strings.Contains(string(payload), "APPTHEORY_LOCAL_CFN_PORT") {
		t.Fatalf("the shim content is wrong: %s", payload)
	}
	if _, err := runner.prepareNodeResponseShim(); err != nil {
		t.Fatalf("a second preparation must be idempotent: %v", err)
	}

	// A scratch path that is a regular file cannot hold the shim.
	file := t.TempDir() + "/scratch"
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := (&Runner{scratch: file}).prepareNodeResponseShim(); err == nil {
		t.Fatal("an unusable scratch directory must be refused")
	}
}

func TestResourceIndexGroupsByStack(t *testing.T) {
	runner := &Runner{spec: &Spec{Resources: []ResourceSpec{
		{Stack: "One", LogicalID: "A", Type: typeS3Bucket},
		{Stack: "Two", LogicalID: "B", Type: typeSQSQueue},
		{Stack: "One", LogicalID: "C", Type: typeDynamoTable},
	}}}
	index := runner.resourceIndex()
	if len(index) != 2 || len(index["One"]) != 2 || len(index["Two"]) != 1 {
		t.Fatalf("the index is %+v", index)
	}
	if index["One"]["A"].Type != typeS3Bucket || index["Two"]["B"].Type != typeSQSQueue {
		t.Fatalf("the indexed entries are %+v", index)
	}
	if empty := (&Runner{}).resourceIndex(); len(empty) != 0 {
		t.Fatalf("a runner with no spec indexes nothing: %+v", empty)
	}
}

func TestReceiptEventVariants(t *testing.T) {
	runner := iamTestRunner(t)
	spec := &Spec{
		accounts:  map[string]string{"Stack": LocalAccountID},
		Functions: []FunctionSpec{{LogicalID: "MailFn", Stack: "Stack"}},
		Resources: []ResourceSpec{
			{Stack: "Stack", LogicalID: "MailFn", Type: typeLambdaFunction,
				Properties: json.RawMessage(`{"FunctionName":"mail"}`)},
		},
	}
	runner.spec = spec
	input := receiptEventInput{
		rule:      ReceiptRuleSpec{LogicalID: "Rule", Stack: "Stack", RuleSetName: "mail", Name: "inbound"},
		action:    ReceiptAction{Kind: receiptActionLambda, Function: "MailFn"},
		message:   receivedMessage{Raw: "From: a@b\r\nTo: c@d\r\n\r\nbody", Recipients: []string{"c@d"}, Source: ""},
		messageID: "id-1",
	}
	event, err := runner.receiptEvent(spec, input)
	if err != nil {
		t.Fatalf("receiptEvent: %v", err)
	}
	if !strings.Contains(string(event), "0000000000000000-id-1@amazonses.com") {
		t.Fatalf("an empty source must synthesize the SES source: %s", event)
	}
	if !strings.Contains(string(event), `"invocationType":"Event"`) {
		t.Fatalf("an empty invocation type must default to Event: %s", event)
	}

	// A function the assembly does not declare has no ARN.
	missing := input
	missing.action.Function = "NoFn"
	if _, err := runner.receiptEvent(spec, missing); err == nil || !strings.Contains(err.Error(), "no local ARN") {
		t.Fatalf("a missing function must be named: %v", err)
	}
}

func TestSplitAddressListFallsBackOnAnInvalidHeader(t *testing.T) {
	if values := splitAddressList("not an address, <"); len(values) != 1 || values[0] != "not an address, <" {
		t.Fatalf("an unparseable list must be kept whole: %v", values)
	}
	if values := splitAddressList("a@example.test, b@example.test"); len(values) != 2 {
		t.Fatalf("a valid list must split: %v", values)
	}
}

func TestSTSRefusalRendersItsCode(t *testing.T) {
	refusal := &stsRefusal{status: 403, code: "AccessDenied", message: "nope"}
	if got := refusal.Error(); got != "AccessDenied: nope" {
		t.Fatalf("the refusal renders %q", got)
	}
}

func TestLambdaFrontResolvesTheRunnerInvoker(t *testing.T) {
	runner := &Runner{invokers: map[string]*FunctionProcess{
		"ApiFn": {Function: FunctionSpec{LogicalID: "ApiFn"}},
	}}
	front := &lambdaInvokeFront{runner: runner}
	if _, ok := front.invoker("ApiFn"); !ok {
		t.Fatal("the runner's own invoker set must answer")
	}
	if _, ok := front.invoker("Missing"); ok {
		t.Fatal("an unknown function must not resolve")
	}
	if name, ok := lambdaInvokeFunctionPath(lambdaInvokePathPrefix + "arn%3Aaws%3Alambda%3Aus-east-1%3A1%3Afunction%3Aapi" + lambdaInvokePathSuffix); !ok ||
		name != "arn:aws:lambda:us-east-1:1:function:api" {
		t.Fatalf("an escaped path must decode: %q %v", name, ok)
	}
	if _, ok := lambdaInvokeFunctionPath("/not-the-path"); ok {
		t.Fatal("a foreign path must not resolve")
	}
	if _, ok := lambdaInvokeFunctionPath(lambdaInvokePathPrefix + lambdaInvokePathSuffix); ok {
		t.Fatal("an empty function name must not resolve")
	}
}

func TestS3FrontAppliesAnSSEPutDecision(t *testing.T) {
	front, err := newS3Front(t.TempDir(), "http://127.0.0.1:1", func(string, ...any) {})
	if err != nil {
		t.Fatalf("newS3Front: %v", err)
	}
	// An unsigned put is forwarded unchanged.
	unsigned := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://127.0.0.1/b/k", strings.NewReader("x"))
	if adopt, err := front.applySSEPut(unsigned); adopt || err != nil {
		t.Fatalf("an unsigned put must be left alone: %v %v", adopt, err)
	}
	// A signed put that does not sign the SSE header is forwarded unchanged.
	unsignedHeader := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://127.0.0.1/b/k", strings.NewReader("x"))
	unsignedHeader.Header.Set("Authorization", sigV4Authorization("dummy/20261108/us-east-1/s3/aws4_request", "host", "00"))
	if adopt, err := front.applySSEPut(unsignedHeader); adopt || err != nil {
		t.Fatalf("an unsigned SSE header must be left alone: %v %v", adopt, err)
	}
	// A malformed authorization header is reported.
	malformed := httptest.NewRequestWithContext(context.Background(), http.MethodPut, "http://127.0.0.1/b/k", strings.NewReader("x"))
	malformed.Header.Set("Authorization", sigV4AuthorizationPrefix+"not-fields")
	if _, err := front.applySSEPut(malformed); err == nil {
		t.Fatal("a malformed authorization must be reported")
	}
}

func TestWatchErrorWrappersPreserveTheirCause(t *testing.T) {
	cause := errors.New("the reload failed")
	reported := &watchStateReported{err: cause}
	if reported.Error() != cause.Error() || !errors.Is(reported, cause) {
		t.Fatalf("the reported marker must preserve its cause: %v", reported)
	}
	restore := &watchedRestoreFailure{err: cause}
	if restore.Error() != cause.Error() || !errors.Is(restore, cause) {
		t.Fatalf("the restore marker must preserve its cause: %v", restore)
	}
	if got := truncateForMessage(strings.Repeat("x", 2000)); len(got) == 0 {
		t.Fatal("a long message must be truncated, not dropped")
	}
	if got := firstNonEmpty("", "  ", "value", "other"); got != "value" {
		t.Fatalf("firstNonEmpty = %q", got)
	}
}

func TestDescribeNotificationsReportsDeliveryState(t *testing.T) {
	runner := iamTestRunner(t)
	spec := &Spec{Notifications: []NotificationSpec{{
		LogicalID: "Notify", Bucket: "Bucket", BucketName: "bucket",
		DestinationType: "lambda", Destination: "Fn", Events: []string{"s3:ObjectCreated:*"},
		FilterRules:     []NotificationFilterRule{{Name: "prefix", Value: "in/"}},
		ConfigurationID: "config",
	}}}
	session := &localSession{runner: runner, spec: spec}
	if session.describeNotifications(EngineState{}) == nil {
		t.Fatal("a configuration with no delivery state must still be reported")
	}
	entries := session.describeNotifications(EngineState{Sources: []DeliveryState{{
		ID: "Notify", State: DeliveryPhasePolling, Delivered: 2, Filtered: 1, Failed: 3,
	}}})
	if len(entries) != 1 || entries[0]["delivered"] != int64(2) || entries[0]["failed"] != int64(3) {
		t.Fatalf("the delivery state is %+v", entries)
	}
	if (&localSession{spec: &Spec{}}).describeNotifications(EngineState{}) != nil {
		t.Fatal("no configuration is reported as nil")
	}
}

func TestCustomResourceMicrovmRefusalCoversInlineImageProperties(t *testing.T) {
	stack := assemblyStack{Name: "Stack", Template: template{Resources: map[string]templateResource{
		"Prune": {Type: typeCloudFormationCustomResource,
			Properties: json.RawMessage(`{"ServiceToken":{"Fn::GetAtt":["Provider","Arn"]},` +
				`"MicrovmImageProperties":{"BaseImageArn":"arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1"}}`)},
		"Normal": {Type: "Custom::Migration", Properties: json.RawMessage(`{"Table":"items"}`)},
	}}}
	reason := customResourceMicrovmRefusal(stack, stack.Template.Resources["Prune"])
	if !strings.Contains(reason, "MicroVM managed provider") || !strings.Contains(reason, "MicrovmImageProperties") {
		t.Fatalf("an inline MicroVM image construct must be refused by name: %q", reason)
	}
	if reason := customResourceMicrovmRefusal(stack, stack.Template.Resources["Normal"]); reason != "" {
		t.Fatalf("an unrelated custom resource must not be refused: %q", reason)
	}
}
