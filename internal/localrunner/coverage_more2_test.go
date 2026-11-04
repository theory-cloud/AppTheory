//nolint:errcheck // test fixtures decode protocol shapes with unchecked type assertions
package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/theory-cloud/apptheory/v6/internal/localcloudfront"
)

func TestProvisionTablesWithFakeBackend(t *testing.T) {
	var created, ttl string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.0")
		target := request.Header.Get("X-Amz-Target")
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body)
		switch {
		case strings.HasSuffix(target, ".CreateTable"):
			created, _ = body["TableName"].(string)
			writeTestJSON(t, writer, `{}`)
		case strings.HasSuffix(target, ".DescribeTable"):
			writeTestJSON(t, writer, `{"Table":{"TableName":"table","TableStatus":"ACTIVE","TableArn":"arn:aws:dynamodb:us-east-1:123456789012:table/table","LatestStreamArn":"arn:aws:dynamodb:ddblocal:000000000000:table/table/stream/1","StreamSpecification":{"StreamViewType":"NEW_AND_OLD_IMAGES"}}}`)
		case strings.HasSuffix(target, ".UpdateTimeToLive"):
			spec := body["TimeToLiveSpecification"].(map[string]any)
			ttl, _ = spec["AttributeName"].(string)
			writeTestJSON(t, writer, `{}`)
		default:
			writeTestJSON(t, writer, `{}`)
		}
	}))
	defer server.Close()
	runner := &Runner{
		resourceValues: resourceValues{},
		tables:         map[string]tableInfo{},
		ttlTables:      map[string]ttlTable{},
		backends: map[string]backendProcess{backendDynamoDB: {
			HostURL:   server.URL,
			Endpoints: []Endpoint{{Service: backendDynamoDB, URL: server.URL}},
		}},
		options: Options{Stdout: io.Discard},
	}
	spec := &Spec{Resources: []ResourceSpec{{Stack: "S", LogicalID: "Table", Type: typeDynamoTable, Properties: json.RawMessage(`{
		"TableName":"table",
		"BillingMode":"PAY_PER_REQUEST",
		"KeySchema":[{"AttributeName":"pk","KeyType":"HASH"}],
		"AttributeDefinitions":[{"AttributeName":"pk","AttributeType":"S"}],
		"StreamSpecification":{"StreamEnabled":true,"StreamViewType":"NEW_AND_OLD_IMAGES"},
		"TimeToLiveSpecification":{"AttributeName":"expiresAt","Enabled":true}
	}`)}}}
	if err := runner.provisionTables(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	if created != "table" || ttl != "expiresAt" {
		t.Fatalf("created %q ttl %q", created, ttl)
	}
	value := runner.resourceValues["S/Table"]
	if value.StreamARN != "arn:aws:dynamodb:us-east-1:123456789012:table/table/stream/1" {
		t.Fatalf("stream ARN: %q", value.StreamARN)
	}
	if _, ok := runner.ttlTables["S/Table"]; !ok {
		t.Fatal("the TTL table was not registered")
	}
}

func TestFunctionLogCaptureSetup(t *testing.T) {
	var groups []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body)
		if name, ok := body["logGroupName"].(string); ok {
			groups = append(groups, name)
		}
		writeTestJSON(t, writer, `{}`)
	}))
	defer server.Close()
	runner := &Runner{
		clock: RealClock{},
		backends: map[string]backendProcess{"moto": {
			HostURL:   server.URL,
			Endpoints: []Endpoint{{Service: logsService, URL: server.URL}},
		}},
		invokers: map[string]*FunctionProcess{
			"Fn": {Function: FunctionSpec{LogicalID: "Fn", Stack: "S"}, Container: "container", Started: time.Now()},
		},
		docker:  NewDocker(),
		options: Options{Stdout: io.Discard},
	}
	spec := &Spec{
		Resources: []ResourceSpec{{Stack: "S", LogicalID: "Fn", Type: typeLambdaFunction, Properties: json.RawMessage(`{"FunctionName":"fn"}`)}},
		Functions: []FunctionSpec{{LogicalID: "Fn", Stack: "S"}},
	}
	ctx, cancel := context.WithCancel(context.Background())
	runner.startFunctionLogs(ctx, spec, []string{"Fn"})
	cancel()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(groups) >= 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(groups) < 2 || !strings.HasPrefix(groups[0], "/aws/lambda/") {
		t.Fatalf("log groups: %v", groups)
	}
}

func TestDynamoDeliverPartialAndOptions(t *testing.T) {
	deliverer := &DynamoDBStreamDeliverer{mapping: EventSourceSpec{
		ReportBatchItemFailures:        true,
		MaximumRetryAttempts:           2,
		RetryAttemptsSet:               true,
		MaximumRecordAgeInSeconds:      60,
		MaximumBatchingWindowInSeconds: 5,
		BatchSize:                      10,
		StreamViewType:                 "NEW_IMAGE",
	}}
	env := DelivererEnv{Clock: NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)), State: &recordingDeliveryReporter{}, Logf: func(string, ...any) {}}
	options := deliverer.pollerOptions(env)
	if options.MaximumRetryAttempts != 2 || options.MaximumRecordAge != time.Minute || options.BatchingWindow != 5*time.Second {
		t.Fatalf("options: %+v", options)
	}
	env.Invoke = func(context.Context, []byte) (InvokeResult, error) {
		return InvokeResult{Raw: []byte(`{"batchItemFailures":[{"itemIdentifier":"2"}]}`)}, nil
	}
	outcome := deliverer.deliver(env)(context.Background(), []streamRecord{{Sequence: "1", Value: map[string]any{"eventName": "INSERT"}}, {Sequence: "2", Value: map[string]any{"eventName": "INSERT"}}})
	if outcome.WholeFailure || len(outcome.FailedSequences) != 1 {
		t.Fatalf("outcome: %+v", outcome)
	}
	env.Invoke = func(context.Context, []byte) (InvokeResult, error) { return InvokeResult{HandlerError: "boom"}, nil }
	outcome = deliverer.deliver(env)(context.Background(), []streamRecord{{Sequence: "1", Value: map[string]any{}}})
	if !outcome.WholeFailure {
		t.Fatalf("handler error: %+v", outcome)
	}
	deliverer.mapping.FilterCriteria = json.RawMessage(`{"Filters":[{"Pattern":"{\"eventName\":[\"REMOVE\"]}"}]}`)
	if options.Accept(streamRecord{Value: map[string]any{"eventName": "INSERT"}}) {
		t.Fatal("the filter must reject")
	}
	deliverer.mapping.FilterCriteria = json.RawMessage(`{"Filters":[{"Pattern":"bad"}]}`)
	if options.Accept(streamRecord{Value: map[string]any{"eventName": "INSERT"}}) {
		t.Fatal("a bad filter must fail closed")
	}
}

func TestKinesisDeliverPartialAndErrors(t *testing.T) {
	deliverer := &KinesisDeliverer{mapping: EventSourceSpec{ReportBatchItemFailures: true, BatchSize: 10}}
	deliverer.stream = "arn:aws:kinesis:us-east-1:123456789012:stream/probe"
	reporter := &recordingDeliveryReporter{}
	env := DelivererEnv{Clock: NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)), State: reporter, Logf: func(string, ...any) {}}
	env.Invoke = func(context.Context, []byte) (InvokeResult, error) {
		return InvokeResult{Raw: []byte(`{"batchItemFailures":[{"itemIdentifier":"2"}]}`)}, nil
	}
	outcome := deliverer.deliver(env)(context.Background(), []streamRecord{{Sequence: "1", Value: KinesisRecordInput{}}, {Sequence: "2", Value: KinesisRecordInput{}}})
	if outcome.WholeFailure || len(outcome.FailedSequences) != 1 {
		t.Fatalf("outcome: %+v", outcome)
	}
	env.Invoke = func(context.Context, []byte) (InvokeResult, error) { return InvokeResult{HandlerError: "boom"}, nil }
	outcome = deliverer.deliver(env)(context.Background(), []streamRecord{{Sequence: "1", Value: KinesisRecordInput{}}})
	if !outcome.WholeFailure {
		t.Fatalf("handler error: %+v", outcome)
	}
	deliverer.mapping.DestinationType = backendSQS
	deliverer.mapping.DestinationName = "dlq"
	deliverer.mapping.FunctionName = "fn"
	deliverer.discard(env)(context.Background(), []streamRecord{{Sequence: "1", Shard: "s", Arrival: time.Now(), Value: KinesisRecordInput{}}}, "MaximumRetryAttempts", 1, errors.New("boom"))
	if reporter.failed == 0 {
		t.Fatal("a missing discard backend must be reported")
	}
}

func TestStreamPollerWindowAndErrors(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	reader := &failingReader{}
	reporter := &recordingDeliveryReporter{}
	poller := newStreamPoller("m", DelivererEnv{Clock: clock, State: reporter, Logf: func(string, ...any) {}}, reader, streamPollerOptions{
		BatchSize: 10,
	}, func(context.Context, []streamRecord) streamBatchOutcome { return streamBatchOutcome{} }, nil)
	ctx, cancel := context.WithCancel(context.Background())
	go poller.run(ctx)
	time.Sleep(50 * time.Millisecond)
	cancel()
	if reporter.failed == 0 {
		t.Fatal("a read error must be reported")
	}
	if !isExpiredStreamIterator(errors.New("an expired iterator")) {
		t.Fatal("the expired iterator text")
	}
	if streamReaderError("s", errors.New("boom")) == nil {
		t.Fatal("stream reader error")
	}
	if streamRetryDelay(0) != time.Second {
		t.Fatal("retry delay zero")
	}
}

type failingReader struct{}

func (f *failingReader) Read(context.Context, int) ([]streamRecord, error) {
	return nil, errors.New("read failed")
}
func (f *failingReader) Reconnect(context.Context, string) error { return nil }
func (f *failingReader) Done() bool                              { return false }

func TestSessionDescribeSurfaces(t *testing.T) {
	runner := &Runner{
		clock:          RealClock{},
		apiURLs:        map[string]string{"Api": "http://127.0.0.1:1", "Url": "http://127.0.0.1:2", "Dist": "http://127.0.0.1:3"},
		resourceValues: resourceValues{},
		backends:       map[string]backendProcess{},
	}
	spec := &Spec{
		APIs:         []APISpec{{Class: APIHTTPV2, LogicalID: "Api", Name: "api", Stage: "$default"}},
		FunctionURLs: []FunctionURLSpec{{LogicalID: "Url", Function: "Fn"}},
		CloudFront:   []*localcloudfront.Distribution{{LogicalID: "Dist", Refusals: []string{"reason"}}},
		Functions:    []FunctionSpec{{LogicalID: "Fn", Stack: "S"}},
	}
	session := &localSession{runner: runner, spec: spec}
	described, err := session.describe()
	if err != nil {
		t.Fatal(err)
	}
	if len(described["apis"].([]map[string]any)) != 2 || len(described["cloudFront"].([]map[string]any)) != 1 {
		t.Fatalf("describe surfaces: %+v", described)
	}
}

func TestTTLAndDynamoMore(t *testing.T) {
	key := ttlItemKey(map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "a"}, "sk": &types.AttributeValueMemberS{Value: "b"}}, []keySchemaAttribute{{Name: "pk"}, {Name: "sk"}})
	if len(key) != 2 {
		t.Fatalf("ttl key: %+v", key)
	}
	now := time.Now()
	tracker := newTTLTracker()
	tracker.mark("t", map[string]any{"pk": map[string]any{"S": "a"}}, now)
	if !tracker.take("t", map[string]any{"pk": map[string]any{"S": "a"}}, now) {
		t.Fatal("fresh marker")
	}
	if tracker.take("t", map[string]any{"pk": map[string]any{"S": "a"}}, now) {
		t.Fatal("a marker is consumed once")
	}
	if ttlDue(&types.AttributeValueMemberS{Value: "not-time"}, now) {
		t.Fatal("bad string TTL")
	}
}

func TestEventBridgeInputAndScheduleMore(t *testing.T) {
	rule := RuleSpec{Name: "rule", ARN: "arn:rule"}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if _, err := eventBridgeInput(RuleTargetSpec{Input: "{bad"}, map[string]any{}, rule, now); err != nil {
		t.Fatal(err)
	}
	if _, err := eventBridgeInput(RuleTargetSpec{}, map[string]any{"detail": map[string]any{"a": "b"}}, rule, now); err != nil {
		t.Fatal(err)
	}
	if got, err := parseScheduleExpression("cron(0 0 * * ? *)"); err != nil || got.cron == nil {
		t.Fatalf("cron: %+v %v", got, err)
	}
	if _, err := parseScheduleExpression("rate(1 minute"); err == nil {
		t.Fatal("unclosed rate")
	}
	if _, err := parseCronExpression("0 0 * * ?"); err == nil {
		t.Fatal("five cron fields")
	}
	if _, err := parseCronExpression("0 0 1 1 ? 2020"); err != nil {
		t.Fatal(err)
	}
}
