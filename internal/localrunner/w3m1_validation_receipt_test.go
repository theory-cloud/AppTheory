package localrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// LOCAL-W3-M1 validation, eighth pass: the receipt rule's served actions, the
// SQS poll failure, and the local Lambda endpoint's name forms.

func TestRunReceiptRuleDeliversTheLambdaAndS3Actions(t *testing.T) {
	runner := iamTestRunner(t)
	runner.clock = RealClock{}
	fake := &fakeS3{}
	s3Server := httptest.NewServer(fake)
	t.Cleanup(s3Server.Close)
	runner.backends = map[string]backendProcess{
		"s3proxy": {HostURL: s3Server.URL, Endpoints: []Endpoint{{Service: "s3", URL: s3Server.URL}}},
	}

	// A Lambda action's invoke is answered by a real RIE-shaped endpoint.
	var received map[string]any
	rie := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		payload, _ := io.ReadAll(request.Body) //nolint:errcheck // the test decodes below
		_ = json.Unmarshal(payload, &received) //nolint:errcheck // the test asserts below
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"statusCode":200}`)) //nolint:errcheck // fixed body
	}))
	t.Cleanup(rie.Close)
	port := 0
	if parsed, err := url.Parse(rie.URL); err == nil {
		_, _ = fmt.Sscanf(parsed.Port(), "%d", &port) //nolint:errcheck // the test server always reports a port
	}
	runner.invokers["MailFn"] = &FunctionProcess{
		Function: FunctionSpec{LogicalID: "MailFn", Stack: "Stack"}, Port: port, rie: true,
	}

	spec := &Spec{
		accounts:  map[string]string{"Stack": LocalAccountID},
		Functions: []FunctionSpec{{LogicalID: "MailFn", Stack: "Stack"}},
		Resources: []ResourceSpec{
			{Stack: "Stack", LogicalID: "MailFn", Type: typeLambdaFunction,
				Properties: json.RawMessage(`{"FunctionName":"mail"}`)},
			{Stack: "Stack", LogicalID: "Bucket", Type: typeS3Bucket,
				Properties: json.RawMessage(`{"BucketName":"bucket"}`)},
		},
	}
	runner.spec = spec
	runner.resourceValues = resourceValues{"Stack/Bucket": {Type: typeS3Bucket, Name: "bucket"}}
	session := &localSession{runner: runner, spec: spec}
	rule := ReceiptRuleSpec{
		LogicalID: "Rule", Stack: "Stack", RuleSetName: "mail", Name: "inbound", Enabled: true,
		Recipients: []string{"inbound@example.test"},
		Actions: []ReceiptAction{
			{Kind: receiptActionS3, Bucket: "Stack/Bucket", ObjectKeyPrefix: "mail/"},
			{Kind: receiptActionLambda, Function: "MailFn", InvocationType: receiptInvocationEvent},
		},
	}
	spec.ReceiptRules = []ReceiptRuleSpec{rule}
	message := receivedMessage{
		Raw:        "From: sender@example.test\r\nTo: inbound@example.test\r\nSubject: hello\r\n\r\nbody",
		Recipients: []string{"inbound@example.test"},
		Source:     "sender@example.test",
	}
	now := time.Now()
	parsed, err := parseReceiptMessage(message.Raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	outcome, err := session.runReceiptRule(context.Background(), rule, message, "message-1", now,
		parsed.headers, parsed.common)
	if err != nil {
		t.Fatalf("runReceiptRule: %v", err)
	}
	if len(outcome.Actions) != 2 || outcome.Actions[0].Kind != receiptActionS3 ||
		outcome.Actions[1].Kind != receiptActionLambda || outcome.Actions[1].StatusCode != 200 {
		t.Fatalf("the actions are %+v", outcome.Actions)
	}
	if fake.deleted != 0 || len(fake.objects) != 1 || fake.objects[0] != "mail/message-1" {
		t.Fatalf("the S3 action must write the raw message: %+v", fake)
	}
	records, _ := received["Records"].([]any) //nolint:errcheck // the record shape is asserted below
	if len(records) != 1 {
		t.Fatalf("the Lambda action must receive one SES record: %+v", received)
	}
	record, _ := records[0].(map[string]any) //nolint:errcheck // the record shape is asserted below
	if record["eventSource"] != "aws:ses" {
		t.Fatalf("the Lambda action must receive the SES record: %+v", record)
	}

	// An unserved action kind is refused by name.
	unserved := rule
	unserved.Actions = []ReceiptAction{{Kind: "sns"}}
	if _, err := session.runReceiptRule(context.Background(), unserved, message, "id", now, nil, nil); err == nil ||
		!strings.Contains(err.Error(), "not served locally") {
		t.Fatalf("an unserved action must be named: %v", err)
	}

	// The whole receive path delivers against the matching rule.
	delivery, err := session.receiveMessage(context.Background(), message)
	if err != nil {
		t.Fatalf("receiveMessage: %v", err)
	}
	if delivery.MessageID == "" || len(delivery.Rules) != 1 {
		t.Fatalf("the delivery is %+v", delivery)
	}
}

func TestSQSDelivererReportsAReceiveFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.0")
		target := request.Header.Get("X-Amz-Target")
		if strings.Contains(target, "GetQueueUrl") {
			_, _ = writer.Write([]byte(`{"QueueUrl":"` + "http://127.0.0.1/queue/events" + `"}`)) //nolint:errcheck // a fixed answer
			return
		}
		if strings.Contains(target, "GetQueueAttributes") {
			_, _ = writer.Write([]byte(`{"Attributes":{"VisibilityTimeout":"30"}}`)) //nolint:errcheck // a fixed answer
			return
		}
		writer.WriteHeader(http.StatusInternalServerError)
		_, _ = writer.Write([]byte(`{"__type":"InternalError","message":"boom"}`)) //nolint:errcheck // fixed body
	}))
	t.Cleanup(server.Close)

	clock := NewTestClock(DefaultTestClockStart)
	resolver := func(kind DeliveryKind) (DeliveryBackend, error) {
		return DeliveryBackend{
			Service:  backendSQS,
			Endpoint: server.URL,
			Client:   newSQSClient(server.URL),
		}, nil
	}
	engine := NewDeliveryEngine(clock, 1, resolver,
		func(context.Context, string, []byte) (InvokeResult, error) { return InvokeResult{}, nil }, nil)
	engine.RegisterDeliverer(DeliveryKindSQS, NewSQSDeliverer)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := engine.Start(ctx, &Spec{EventSources: []EventSourceSpec{sqsSource("Mapping", "events")}}); err != nil {
		t.Fatalf("start: %v", err)
	}
	state := waitForSource(t, engine, "Mapping", func(state DeliveryState) bool { return state.Failed >= 1 })
	if state.State != DeliveryPhaseFailed || state.LastError == "" {
		t.Fatalf("a receive failure must be reported: %+v", state)
	}
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopCancel()
	if err := engine.Stop(stopCtx); err != nil {
		t.Fatalf("stop: %v", err)
	}
}

func TestFunctionByInvokeNameForms(t *testing.T) {
	runner := &Runner{
		spec: &Spec{
			Functions: []FunctionSpec{{LogicalID: "ApiFn", Stack: "Stack"}},
			Resources: []ResourceSpec{
				{Stack: "Stack", LogicalID: "ApiFn", Type: typeLambdaFunction,
					Properties: json.RawMessage(`{"FunctionName":"api"}`)},
			},
		},
	}
	cases := []struct {
		name string
		ok   bool
	}{
		{"api", true},
		{"arn:aws:lambda:us-east-1:123456789012:function:api", true},
		{"arn:aws:lambda:us-east-1:123456789012:function:api:1", true},
		{"missing", false},
		{"", false},
	}
	for _, tc := range cases {
		if id, ok := runner.functionByInvokeName(tc.name); ok != tc.ok || (ok && id != "ApiFn") {
			t.Fatalf("%q -> %q %v, want ok=%v", tc.name, id, ok, tc.ok)
		}
	}
}

func TestReceiptObjectKeyAndRuleMatching(t *testing.T) {
	if key := receiptObjectKey("mail/", "id-1"); key != "mail/id-1" {
		t.Fatalf("the object key is %q", key)
	}
	if key := receiptObjectKey("", "id-1"); key != "id-1" {
		t.Fatalf("an empty prefix keeps the message id: %q", key)
	}
	rules := []ReceiptRuleSpec{
		{LogicalID: "B", Enabled: true, Recipients: []string{"Example.test"}},
		{LogicalID: "A", Enabled: true, Recipients: []string{"inbound@example.test"}},
		{LogicalID: "Disabled", Enabled: false, Recipients: []string{"inbound@example.test"}},
		{LogicalID: "Empty", Enabled: true, Recipients: []string{""}},
	}
	matched := receiptRulesFor(rules, "inbound@example.test")
	if len(matched) != 2 || matched[0].LogicalID != "A" || matched[1].LogicalID != "B" {
		t.Fatalf("the matching rules are %+v", matched)
	}
}
