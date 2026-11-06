package localrunner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func canceledContext() context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return ctx
}

func TestDynamoStreamDelivererConstructionAndStart(t *testing.T) {
	if _, err := NewDynamoDBStreamDeliverer(DeliverySource{ID: "x"}, nil); err == nil {
		t.Fatal("a mapping-less source must fail")
	}
	wrong := &EventSourceSpec{Type: backendSQS}
	if _, err := NewDynamoDBStreamDeliverer(DeliverySource{ID: "x", Mapping: wrong}, nil); err == nil {
		t.Fatal("an SQS mapping is not a stream source")
	}
	deliverer := &DynamoDBStreamDeliverer{
		source:  DeliverySource{ID: "Mapping"},
		mapping: EventSourceSpec{SourceName: "table", BatchSize: 10},
	}
	if err := deliverer.Start(context.Background(), DelivererEnv{}); err == nil {
		t.Fatal("a missing Streams client must fail")
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.0")
		writeTestJSON(t, writer, `{"Table":{"TableName":"table","LatestStreamArn":"arn:aws:dynamodb:ddblocal:000000000000:table/table/stream/1","StreamSpecification":{"StreamViewType":"NEW_AND_OLD_IMAGES"}}}`)
	}))
	defer server.Close()
	disabled := &DynamoDBStreamDeliverer{
		source:  DeliverySource{ID: "Mapping"},
		mapping: EventSourceSpec{SourceName: "table", BatchSize: 10, Enabled: false},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	err := disabled.Start(ctx, DelivererEnv{
		Backend: DeliveryBackend{Client: &dynamoDBLocalBackend{data: newDynamoDBClient(server.URL), streams: newDynamoStreamsClient(server.URL)}},
		State:   &recordingDeliveryReporter{},
		Logf:    func(string, ...any) {},
	})
	if err != nil {
		t.Fatalf("the disabled mapping: %v", err)
	}
	emptyServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.0")
		writeTestJSON(t, writer, `{"Table":{"TableName":"table"}}`)
	}))
	defer emptyServer.Close()
	noStream := &DynamoDBStreamDeliverer{
		source:  DeliverySource{ID: "Mapping"},
		mapping: EventSourceSpec{SourceName: "table"},
	}
	if err := noStream.Start(context.Background(), DelivererEnv{
		Backend: DeliveryBackend{Client: &dynamoDBLocalBackend{data: newDynamoDBClient(emptyServer.URL), streams: newDynamoStreamsClient(emptyServer.URL)}},
		State:   &recordingDeliveryReporter{},
		Logf:    func(string, ...any) {},
	}); err == nil {
		t.Fatal("a table without a stream must fail")
	}
}

func TestKinesisDelivererConstructionAndStart(t *testing.T) {
	if _, err := NewKinesisDeliverer(DeliverySource{ID: "x"}); err == nil {
		t.Fatal("a mapping-less source must fail")
	}
	if _, err := NewKinesisDeliverer(DeliverySource{ID: "x", Mapping: &EventSourceSpec{Type: backendSQS}}); err == nil {
		t.Fatal("an SQS mapping is not a Kinesis source")
	}
	deliverer := &KinesisDeliverer{source: DeliverySource{ID: "Mapping"}, mapping: EventSourceSpec{SourceName: "stream", BatchSize: 10}}
	if err := deliverer.Start(context.Background(), DelivererEnv{}); err == nil {
		t.Fatal("a missing Kinesis client must fail")
	}
	disabled := &KinesisDeliverer{source: DeliverySource{ID: "Mapping"}, mapping: EventSourceSpec{SourceName: "stream", Enabled: false}}
	if err := disabled.Start(canceledContext(), DelivererEnv{
		Backend: DeliveryBackend{Client: newKinesisClient("http://127.0.0.1:1")},
		State:   &recordingDeliveryReporter{},
		Logf:    func(string, ...any) {},
	}); err != nil {
		t.Fatalf("the disabled mapping: %v", err)
	}
}

func TestCloudWatchLogsDelivererConstructionAndStart(t *testing.T) {
	if _, err := NewCloudWatchLogsDeliverer(DeliverySource{ID: "x"}); err == nil {
		t.Fatal("a subscription-less source must fail")
	}
	if _, err := NewCloudWatchLogsDeliverer(DeliverySource{ID: "x", Subscription: &SubscriptionSpec{Kind: "other"}}); err == nil {
		t.Fatal("a foreign subscription kind must fail")
	}
	if err := (&CloudWatchLogsDeliverer{source: DeliverySource{ID: "x"}}).Start(context.Background(), DelivererEnv{}); err == nil {
		t.Fatal("a missing Logs backend must fail")
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
		writeTestJSON(t, writer, `{}`)
	}))
	defer server.Close()
	backend := DeliveryBackend{Client: &logsLocalBackend{logs: newCloudWatchLogsClient(server.URL)}}
	cases := []SubscriptionSpec{
		{Kind: string(DeliveryKindCloudWatchLogs), LogGroup: ""},
		{Kind: string(DeliveryKindCloudWatchLogs), LogGroup: "/group", DestinationType: ruleTargetFunction},
		{Kind: string(DeliveryKindCloudWatchLogs), LogGroup: "/group", DestinationType: "stream", StreamName: "stream"},
		{Kind: string(DeliveryKindCloudWatchLogs), LogGroup: "/group", DestinationType: "other"},
	}
	for index, subscription := range cases {
		deliverer := &CloudWatchLogsDeliverer{source: DeliverySource{ID: "x"}, subscription: subscription, seen: map[string]struct{}{}}
		if err := deliverer.Start(context.Background(), DelivererEnv{Backend: backend, State: &recordingDeliveryReporter{}, Logf: func(string, ...any) {}}); err == nil {
			t.Errorf("case %d: the start must fail", index)
		}
	}
	failing := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
		writer.WriteHeader(http.StatusInternalServerError)
		writeTestJSON(t, writer, `{"__type":"InternalError","message":"boom"}`)
	}))
	defer failing.Close()
	deliverer := &CloudWatchLogsDeliverer{
		source: DeliverySource{ID: "x"},
		subscription: SubscriptionSpec{
			Kind: string(DeliveryKindCloudWatchLogs), LogGroup: "/group", DestinationType: ruleTargetFunction, Function: "Fn",
		},
		seen: map[string]struct{}{},
	}
	if err := deliverer.Start(context.Background(), DelivererEnv{
		Backend: DeliveryBackend{Client: &logsLocalBackend{logs: newCloudWatchLogsClient(failing.URL)}},
		State:   &recordingDeliveryReporter{},
		Logf:    func(string, ...any) {},
	}); err == nil {
		t.Fatal("the log group creation must fail")
	}
}

func TestEventBridgeDelivererConstructionAndStart(t *testing.T) {
	if _, err := NewEventBridgeDeliverer(DeliverySource{ID: "x"}, nil); err == nil {
		t.Fatal("a rule-less source must fail")
	}
	if _, err := NewEventBridgeDeliverer(DeliverySource{ID: "x", Rule: &RuleSpec{Schedule: "bad"}}, nil); err == nil {
		t.Fatal("an invalid schedule must fail")
	}
	disabled := &EventBridgeDeliverer{source: DeliverySource{ID: "x"}, rule: RuleSpec{Schedule: "rate(5 minutes)"}}
	if err := disabled.Start(canceledContext(), DelivererEnv{State: &recordingDeliveryReporter{}, Logf: func(string, ...any) {}}); err != nil {
		t.Fatalf("the disabled rule: %v", err)
	}
	noBus := &EventBridgeDeliverer{
		source: DeliverySource{ID: "x"},
		rule:   RuleSpec{Enabled: true, EventPattern: json.RawMessage(`{"source":["a"]}`)},
	}
	if err := noBus.Start(context.Background(), DelivererEnv{State: &recordingDeliveryReporter{}, Logf: func(string, ...any) {}}); err == nil {
		t.Fatal("a pattern rule without a bus must fail")
	}
}
