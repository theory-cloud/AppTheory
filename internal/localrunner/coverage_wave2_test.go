//nolint:errcheck // test fixtures decode protocol shapes with unchecked type assertions
package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestStreamDiscardHelpers(t *testing.T) {
	cases := []struct {
		raw     string
		failed  int
		whole   bool
		wantErr bool
	}{
		{raw: "", failed: 0},
		{raw: "null", failed: 0},
		{raw: "{}", failed: 0},
		{raw: `{"batchItemFailures":[{"itemIdentifier":"1"},{"itemIdentifier":"2"}]}`, failed: 2},
		{raw: `{"batchItemFailures":"bad"}`, whole: true, wantErr: true},
		{raw: `{"batchItemFailures":[{"itemIdentifier":""}]}`, whole: true, wantErr: true},
		{raw: `{"batchItemFailures":[{"itemIdentifier":7}]}`, whole: true, wantErr: true},
		{raw: `not-json`, whole: true, wantErr: true},
		{raw: `[]`, whole: true, wantErr: true},
	}
	for _, test := range cases {
		identifiers, whole, err := streamBatchFailureIdentifiers(InvokeResult{Raw: []byte(test.raw)})
		if len(identifiers) != test.failed || whole != test.whole || (err != nil) != test.wantErr {
			t.Fatalf("%q: identifiers=%v whole=%v err=%v", test.raw, identifiers, whole, err)
		}
	}
	if _, whole, err := streamBatchFailureIdentifiers(InvokeResult{Proxy: true}); !whole || err == nil {
		t.Fatal("a proxy response must be a whole failure")
	}

	fake := newFakeSQS(t)
	fake.queue("dlq", nil)
	env := DelivererEnv{Backend: DeliveryBackend{SQS: newSQSClient(fake.server.URL)}}
	if err := sendStreamDiscard(context.Background(), env, EventSourceSpec{DestinationType: backendSQS, DestinationName: "dlq"}, []byte(`{"x":1}`)); err != nil {
		t.Fatalf("SQS discard: %v", err)
	}
	var published string
	env.Backend.SQS = nil
	env.Backend.PublishSNS = func(_ context.Context, arn string, message LocalSNSMessage) error {
		published = arn + " " + message.Message
		return nil
	}
	if err := sendStreamDiscard(context.Background(), env, EventSourceSpec{DestinationType: backendSNS, DestinationARN: "arn:topic"}, []byte(`{"x":1}`)); err != nil {
		t.Fatalf("SNS discard: %v", err)
	}
	if published != "arn:topic {\"x\":1}" {
		t.Fatalf("SNS discard: %q", published)
	}
	if err := sendStreamDiscard(context.Background(), env, EventSourceSpec{DestinationType: "unknown"}, nil); err == nil {
		t.Fatal("an unknown destination must fail")
	}
	if err := sendStreamDiscard(context.Background(), DelivererEnv{}, EventSourceSpec{DestinationType: backendSQS, DestinationName: "x"}, nil); err == nil {
		t.Fatal("a missing SQS client must fail")
	}
	if discardCondition("MaximumEventAgeInSeconds") != "MaximumEventAgeExceeded" {
		t.Fatal("age condition")
	}
	if discardError(nil) != nil || discardError(context.Canceled) == nil {
		t.Fatal("discard error")
	}
	if streamRetryDelay(1) != time.Second || streamRetryDelay(20) != streamRetryMaximum {
		t.Fatalf("stream retry delay: %v", streamRetryDelay(20))
	}
	if eventBridgeRetryDelay(1) != eventBridgeRetryBase || eventBridgeRetryDelay(20) != eventBridgeRetryMaximum {
		t.Fatalf("eventbridge retry delay: %v", eventBridgeRetryDelay(20))
	}
	if !isExpiredStreamIterator(&awsJSONError{Code: "ExpiredIteratorException"}) || isExpiredStreamIterator(context.Canceled) {
		t.Fatal("expired iterator detection")
	}
}

// TestDynamoDBStreamDelivererDeliversAndDiscards drives the deliverer's Start,
// event build, success, handler failure and on-failure destination against a
// fake DynamoDB data/Streams boundary.
func TestDynamoDBStreamDelivererDeliversAndDiscards(t *testing.T) {
	var mu sync.Mutex
	records := []string{
		`{"eventID":"e1","eventName":"INSERT","eventVersion":"1.1","eventSource":"aws:dynamodb","awsRegion":"ddblocal","dynamodb":{"ApproximateCreationDateTime":"2026-11-04T02:34:00-05:00","Keys":{"pk":{"S":"a"}},"NewImage":{"pk":{"S":"a"}},"SequenceNumber":"1","SizeBytes":13,"StreamViewType":"NEW_AND_OLD_IMAGES"}}`,
	}
	served := false
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.0")
		target := request.Header.Get("X-Amz-Target")
		switch {
		case strings.HasSuffix(target, ".DescribeTable"):
			writeTestJSON(t, writer, `{"Table":{"TableName":"probe","TableStatus":"ACTIVE","LatestStreamArn":"arn:aws:dynamodb:ddblocal:000000000000:table/probe/stream/1","StreamSpecification":{"StreamViewType":"NEW_AND_OLD_IMAGES"}}}`)
		case strings.HasSuffix(target, ".DescribeStream"):
			writeTestJSON(t, writer, `{"StreamDescription":{"StreamArn":"arn:aws:dynamodb:ddblocal:000000000000:table/probe/stream/1","StreamViewType":"NEW_AND_OLD_IMAGES","Shards":[{"ShardId":"shardId-1","SequenceNumberRange":{"StartingSequenceNumber":"1"}}]}}`)
		case strings.HasSuffix(target, ".GetShardIterator"):
			writeTestJSON(t, writer, `{"ShardIterator":"it-1"}`)
		case strings.HasSuffix(target, ".GetRecords"):
			mu.Lock()
			if served {
				writeTestJSON(t, writer, `{"Records":[],"NextShardIterator":"it-1"}`)
				mu.Unlock()
				return
			}
			served = true
			mu.Unlock()
			writeTestJSON(t, writer, `{"Records":[`+records[0]+`],"NextShardIterator":"it-1"}`)
		default:
			t.Errorf("unexpected target %s", target)
		}
	}))
	defer server.Close()

	mapping := EventSourceSpec{
		LogicalID:               "Probe",
		Stack:                   "S",
		Function:                "Fn",
		Type:                    backendDynamoDB,
		Source:                  "Table",
		SourceName:              "probe",
		SourceARN:               "arn:aws:dynamodb:us-east-1:123456789012:table/probe/stream/1",
		BatchSize:               10,
		ReportBatchItemFailures: true,
		Enabled:                 true,
		StartingPosition:        dynamoStreamIteratorTrimHorizon,
		ParallelizationFactor:   1,
		MaximumRetryAttempts:    -1,
	}
	source := DeliverySource{ID: "Probe", Kind: DeliveryKindDynamoDBStream, Mapping: &mapping}
	deliverer, err := NewDynamoDBStreamDeliverer(source, newTTLTracker())
	if err != nil {
		t.Fatal(err)
	}
	events := make(chan []byte, 4)
	reporter := &recordingDeliveryReporter{}
	env := DelivererEnv{
		Source: source,
		Clock:  NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
		Backend: DeliveryBackend{
			Service: backendDynamoDB,
			Client:  &dynamoDBLocalBackend{data: newDynamoDBClient(server.URL), streams: newDynamoStreamsClient(server.URL)},
		},
		Invoke: func(_ context.Context, event []byte) (InvokeResult, error) {
			events <- event
			return InvokeResult{Raw: []byte(`{"batchItemFailures":[]}`)}, nil
		},
		State: reporter,
		Logf:  func(string, ...any) {},
	}
	ctx, cancel := context.WithCancel(context.Background())
	firstDone := make(chan struct{})
	go func() {
		_ = deliverer.Start(ctx, env)
		close(firstDone)
	}()
	select {
	case event := <-events:
		var decoded map[string]any
		if decodeErr := json.Unmarshal(event, &decoded); decodeErr != nil {
			t.Fatal(decodeErr)
		}
		decodedRecords, _ := decoded["Records"].([]any)
		if len(decodedRecords) != 1 {
			t.Fatalf("records: %s", event)
		}
		record := decodedRecords[0].(map[string]any)
		if record["eventSourceARN"] != mapping.SourceARN || record["awsRegion"] != LocalRegion {
			t.Fatalf("record: %+v", record)
		}
	case <-time.After(10 * time.Second):
		cancel()
		<-firstDone
		t.Fatal("the deliverer never invoked the handler")
	}
	cancel()
	<-firstDone

	// Failure path with an SQS on-failure destination, driven directly so no
	// lane goroutine from the success phase can race the fake stream.
	fake := newFakeSQS(t)
	fake.queue("dlq", nil)
	mapping.DestinationType = backendSQS
	mapping.DestinationName = "dlq"
	mapping.MaximumRetryAttempts = 0
	mapping.RetryAttemptsSet = true
	failing, err := NewDynamoDBStreamDeliverer(source, newTTLTracker())
	if err != nil {
		t.Fatal(err)
	}
	typed, ok := failing.(*DynamoDBStreamDeliverer)
	if !ok {
		t.Fatalf("unexpected deliverer type %T", failing)
	}
	failingReporter := &recordingDeliveryReporter{}
	failingEnv := DelivererEnv{
		Source:  source,
		Clock:   env.Clock,
		Backend: DeliveryBackend{SQS: newSQSClient(fake.server.URL)},
		State:   failingReporter,
		Logf:    func(string, ...any) {},
	}
	typed.discard(failingEnv)(context.Background(), []streamRecord{{
		Sequence: "1",
		Shard:    "shardId-1",
		Arrival:  env.Clock.Now(),
		Value:    map[string]any{"eventName": "INSERT"},
	}}, "MaximumRetryAttempts", 1, errors.New("boom"))
	fake.mu.Lock()
	sent := append([]map[string]any(nil), fake.sent...)
	fake.mu.Unlock()
	if len(sent) != 1 {
		t.Fatalf("on-failure messages %d, want 1", len(sent))
	}
	if !strings.Contains(sent[0]["MessageBody"].(string), "DDBStreamBatchInfo") {
		t.Fatalf("on-failure body: %v", sent[0]["MessageBody"])
	}

}

func TestProvisionLogGroupsAndTTLStart(t *testing.T) {
	var created []string
	logsServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body)
		if name, ok := body["logGroupName"].(string); ok {
			created = append(created, name)
		}
		writeTestJSON(t, writer, `{}`)
	}))
	defer logsServer.Close()
	runner := &Runner{
		resourceValues: resourceValues{},
		backends: map[string]backendProcess{
			"moto": {HostURL: logsServer.URL, Endpoints: []Endpoint{{Service: logsService, URL: logsServer.URL}}},
		},
	}
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "S", LogicalID: "Fn", Type: typeLambdaFunction, Properties: json.RawMessage(`{}`)},
		{Stack: "S", LogicalID: "Group", Type: typeLogGroup, Properties: json.RawMessage(`{"LogGroupName":{"Fn::Join":["",["/aws/lambda/",{"Ref":"Fn"}]]}}`)},
	}}
	if err := runner.provisionLogGroups(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	if len(created) != 1 || !strings.HasPrefix(created[0], "/aws/lambda/") {
		t.Fatalf("created log groups: %v", created)
	}
	if value := runner.resourceValues["S/Group"]; value.Type != typeLogGroup || value.Name != created[0] {
		t.Fatalf("log group value: %+v", value)
	}

	var deleted []string
	ddbServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.0")
		switch {
		case strings.HasSuffix(request.Header.Get("X-Amz-Target"), ".Scan"):
			writeTestJSON(t, writer, `{"Items":[{"pk":{"S":"expired"},"expiresAt":{"N":"100"}}],"Count":1}`)
		case strings.HasSuffix(request.Header.Get("X-Amz-Target"), ".DeleteItem"):
			var body map[string]any
			_ = json.NewDecoder(request.Body).Decode(&body)
			key := body["Key"].(map[string]any)
			deleted = append(deleted, key["pk"].(map[string]any)["S"].(string))
			writeTestJSON(t, writer, `{}`)
		default:
			writeTestJSON(t, writer, `{}`)
		}
	}))
	defer ddbServer.Close()
	ttlRunner := &Runner{
		clock: RealClock{},
		ttl:   newTTLTracker(),
		ttlTables: map[string]ttlTable{
			"S/Table": {Name: "probe", Attribute: "expiresAt", KeySchema: []keySchemaAttribute{{Name: "pk", Type: "S"}}},
		},
		backends: map[string]backendProcess{backendDynamoDB: {
			HostURL:   ddbServer.URL,
			Endpoints: []Endpoint{{Service: backendDynamoDB, URL: ddbServer.URL}},
		}},
	}
	ttlCtx, ttlCancel := context.WithCancel(context.Background())
	ttlRunner.startTTLSweeper(ttlCtx)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(deleted) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	ttlCancel()
	if len(deleted) != 1 || deleted[0] != "expired" {
		t.Fatalf("TTL deletes: %v", deleted)
	}
}

func TestEventBridgeHTTPAndTargetEdges(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	bus := newEventBridgeBus(clock)
	runtime := &eventBridgeRuleRuntime{
		rule: RuleSpec{LogicalID: "Rule", BusName: "default", EventPattern: json.RawMessage(`{"source":["app.test"]}`)},
		fire: func(context.Context, map[string]any) {},
	}
	runtime.setActive(true)
	bus.register(runtime)

	handler := func(method, target, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequestWithContext(context.Background(), method, "/", strings.NewReader(body))
		if target != "" {
			request.Header.Set("X-Amz-Target", target)
		}
		recorder := httptest.NewRecorder()
		bus.serveEventBridgeHTTP(context.Background(), recorder, request)
		return recorder
	}
	if code := handler(http.MethodGet, "", "").Code; code != http.StatusOK {
		t.Fatalf("GET: %d", code)
	}
	if code := handler(http.MethodPut, "", "").Code; code != http.StatusBadRequest {
		t.Fatalf("PUT: %d", code)
	}
	if code := handler(http.MethodPost, "Wrong.Target", `{}`).Code; code != http.StatusNotFound {
		t.Fatalf("wrong target: %d", code)
	}
	if code := handler(http.MethodPost, eventBridgeTarget, `not-json`).Code; code != http.StatusBadRequest {
		t.Fatalf("bad json: %d", code)
	}
	if code := handler(http.MethodPost, eventBridgeTarget, `{"Entries":[]}`).Code; code != http.StatusBadRequest {
		t.Fatalf("empty entries: %d", code)
	}
	entries := make([]map[string]any, 11)
	for index := range entries {
		entries[index] = map[string]any{"Source": "app.test", "DetailType": "Thing", "Detail": "{}"}
	}
	body, _ := json.Marshal(map[string]any{"Entries": entries})
	if code := handler(http.MethodPost, eventBridgeTarget, string(body)).Code; code != http.StatusBadRequest {
		t.Fatalf("too many entries: %d", code)
	}
	valid := handler(http.MethodPost, eventBridgeTarget, `{"Entries":[{"Source":"app.test","DetailType":"Thing","Detail":"{}"},{"Source":"","DetailType":"Thing"}]}`)
	if valid.Code != http.StatusOK || !strings.Contains(valid.Body.String(), `"FailedEntryCount":1`) {
		t.Fatalf("valid put: %d %s", valid.Code, valid.Body.String())
	}
	bus.unregister(runtime)

	// Target edges: an SQS target, an SNS target and a missing DLQ.
	fake := newFakeSQS(t)
	fake.queue("target", nil)
	reporter := &recordingDeliveryReporter{}
	env := DelivererEnv{
		Clock:   clock,
		Backend: DeliveryBackend{SQS: newSQSClient(fake.server.URL), PublishSNS: func(context.Context, string, LocalSNSMessage) error { return nil }},
		State:   reporter,
		InvokeTarget: func(context.Context, string, []byte) (InvokeResult, error) {
			return InvokeResult{}, nil
		},
		Logf: func(string, ...any) {},
	}
	rule := RuleSpec{LogicalID: "Rule", Name: "rule", ARN: ruleARN("default", "rule"), Enabled: true}
	deliverer, err := NewEventBridgeDeliverer(DeliverySource{ID: "Rule", Kind: DeliveryKindEventBridgeRule, Rule: &rule}, bus)
	if err != nil {
		t.Fatal(err)
	}
	eventBridge, ok := deliverer.(*EventBridgeDeliverer)
	if !ok {
		t.Fatalf("unexpected deliverer type %T", deliverer)
	}
	eventBridge.env = env
	eventBridge.deliverTargets(context.Background(), map[string]any{
		"source": "app.test", "detail": map[string]any{"group": "g1"}, "resources": []any{},
	})
	targets := []RuleTargetSpec{
		{ID: "sqs", Type: backendSQS, QueueName: "target", ARN: "arn:sqs", SQSMessageGroupID: "$.detail.group"},
		{ID: "sns", Type: ruleTargetSNS, TopicARN: "arn:topic", ARN: "arn:topic"},
		{ID: "lambda", Type: ruleTargetFunction, Function: "Fn", ARN: "arn:fn"},
		{ID: "dlq", Type: ruleTargetFunction, Function: "Fn", ARN: "arn:fn", RetryPolicy: &RuleRetryPolicy{MaximumRetryAttempts: 0}, DeadLetterQueueName: "target"},
	}
	eventBridge.rule.TargetSpecs = targets
	eventBridge.deliverTargets(context.Background(), map[string]any{"source": "app.test", "detail": map[string]any{"group": "g1"}})
	if reporter.delivered == 0 {
		t.Fatal("targets were not delivered")
	}
	eventBridge.rule.TargetSpecs = []RuleTargetSpec{{ID: "bad", Type: "unknown", RetryPolicy: &RuleRetryPolicy{MaximumRetryAttempts: 0}}}
	eventBridge.deliverTargets(context.Background(), map[string]any{})
	if reporter.failed == 0 {
		t.Fatal("an unknown target must be reported")
	}
}

func TestDeriveRuleTargetsAndValidation(t *testing.T) {
	resources := map[string]any{
		"Fn":    withAsset(lambdaFunction(nil), "asset.deadbeef"),
		"Queue": map[string]any{"Type": typeSQSQueue, "Properties": map[string]any{"QueueName": "target"}},
		"Dlq":   map[string]any{"Type": typeSQSQueue, "Properties": map[string]any{"QueueName": "dlq"}},
		"Fifo":  map[string]any{"Type": typeSQSQueue, "Properties": map[string]any{"QueueName": "fifo.fifo", "FifoQueue": true}},
		"Topic": map[string]any{"Type": typeSNSTopic, "Properties": map[string]any{"TopicName": "topic"}},
		"Bus":   map[string]any{"Type": typeEventsBus, "Properties": map[string]any{"Name": "custom-bus"}},
		"Rule": map[string]any{
			"Type": typeEventsRule,
			"Properties": map[string]any{
				"Name":         "custom-rule",
				"EventBusName": map[string]any{"Ref": "Bus"},
				"EventPattern": map[string]any{"source": []any{"app.test"}},
				"Targets": []any{
					map[string]any{
						"Id":        "sqs",
						"Arn":       map[string]any{"Fn::GetAtt": []any{"Queue", "Arn"}},
						"InputPath": "$.detail",
					},
					map[string]any{
						"Id":               "sns",
						"Arn":              map[string]any{"Ref": "Topic"},
						"InputTransformer": map[string]any{"InputPathsMap": map[string]any{"item": "$.detail.item"}, "InputTemplate": `{"item":"<item>"}`},
					},
					map[string]any{
						"Id":    "lambda",
						"Arn":   map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
						"Input": `{"static":true}`,
						"RetryPolicy": map[string]any{
							"MaximumRetryAttempts":     2,
							"MaximumEventAgeInSeconds": 3600,
						},
						"DeadLetterConfig": map[string]any{"Arn": map[string]any{"Fn::GetAtt": []any{"Dlq", "Arn"}}},
					},
				},
			},
		},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.Rules) != 1 {
		t.Fatalf("rules: %+v", spec.Rules)
	}
	rule := spec.Rules[0]
	if rule.BusName != "custom-bus" || !strings.Contains(rule.ARN, "rule/custom-bus/custom-rule") {
		t.Fatalf("rule bus/arn: %+v", rule)
	}
	if len(rule.TargetSpecs) != 3 || len(rule.Targets) != 1 || rule.Targets[0] != "Fn" {
		t.Fatalf("targets: %+v", rule.TargetSpecs)
	}
	if rule.TargetSpecs[0].InputPath != "$.detail" || rule.TargetSpecs[0].QueueName != "target" {
		t.Fatalf("sqs target: %+v", rule.TargetSpecs[0])
	}
	if rule.TargetSpecs[1].InputTransformer == nil || rule.TargetSpecs[1].TopicARN == "" {
		t.Fatalf("sns target: %+v", rule.TargetSpecs[1])
	}
	if rule.TargetSpecs[2].DeadLetterQueueName != "dlq" || rule.TargetSpecs[2].RetryPolicy == nil {
		t.Fatalf("lambda target: %+v", rule.TargetSpecs[2])
	}
	if !strings.Contains(string(rule.EventPattern), "app.test") {
		t.Fatalf("pattern: %s", rule.EventPattern)
	}

	invalid := func(name string, mutate func(map[string]any)) {
		t.Helper()
		copied := map[string]any{}
		raw, _ := json.Marshal(resources)
		_ = json.Unmarshal(raw, &copied)
		mutate(copied)
		badDir := writeAssembly(t, copied)
		mkdirAsset(t, badDir)
		if _, err := deriveAssembly(t, badDir); err == nil {
			t.Fatalf("%s must be refused", name)
		}
	}
	invalid("two input settings", func(values map[string]any) {
		target := values["Rule"].(map[string]any)["Properties"].(map[string]any)["Targets"].([]any)[0].(map[string]any)
		target["Input"] = `{"x":1}`
	})
	invalid("bad input path", func(values map[string]any) {
		target := values["Rule"].(map[string]any)["Properties"].(map[string]any)["Targets"].([]any)[0].(map[string]any)
		delete(target, "InputPath")
		target["InputPath"] = "detail"
	})
	invalid("fifo dead letter queue", func(values map[string]any) {
		values["Dlq"] = values["Fifo"]
	})
	invalid("scheduled custom bus", func(values map[string]any) {
		properties := values["Rule"].(map[string]any)["Properties"].(map[string]any)
		delete(properties, "EventPattern")
		properties["ScheduleExpression"] = "rate(5 minutes)"
	})
	invalid("retry out of range", func(values map[string]any) {
		target := values["Rule"].(map[string]any)["Properties"].(map[string]any)["Targets"].([]any)[2].(map[string]any)
		target["RetryPolicy"].(map[string]any)["MaximumRetryAttempts"] = 999
	})
}

func TestKinesisDelivererStartAndDiscard(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
		target := request.Header.Get("X-Amz-Target")
		switch {
		case strings.HasSuffix(target, ".DescribeStreamSummary"):
			writeTestJSON(t, writer, `{"StreamDescriptionSummary":{"StreamName":"probe","StreamARN":"arn:aws:kinesis:us-east-1:123456789012:stream/probe","StreamStatus":"ACTIVE","OpenShardCount":1}}`)
		case strings.HasSuffix(target, ".ListShards"):
			writeTestJSON(t, writer, `{"Shards":[{"ShardId":"shardId-1","SequenceNumberRange":{"StartingSequenceNumber":"1"}}]}`)
		case strings.HasSuffix(target, ".GetShardIterator"):
			writeTestJSON(t, writer, `{"ShardIterator":"it-1"}`)
		case strings.HasSuffix(target, ".GetRecords"):
			writeTestJSON(t, writer, `{"Records":[{"SequenceNumber":"1","PartitionKey":"p1","Data":"aGVsbG8="}],"NextShardIterator":"it-1"}`)
		default:
			writeTestJSON(t, writer, `{}`)
		}
	}))
	defer server.Close()

	mapping := EventSourceSpec{
		LogicalID:                  "Kinesis",
		Stack:                      "S",
		Function:                   "Fn",
		Type:                       backendKinesis,
		Source:                     "Stream",
		SourceName:                 "probe",
		SourceARN:                  "arn:aws:kinesis:us-east-1:123456789012:stream/probe",
		BatchSize:                  10,
		Enabled:                    true,
		StartingPosition:           iteratorAtTimestamp,
		StartingPositionTimestamp:  100,
		ParallelizationFactor:      2,
		MaximumRetryAttempts:       0,
		RetryAttemptsSet:           true,
		DestinationType:            backendSQS,
		DestinationName:            "dlq",
		BisectBatchOnFunctionError: true,
	}
	fake := newFakeSQS(t)
	fake.queue("dlq", nil)
	source := DeliverySource{ID: "Kinesis", Kind: DeliveryKindKinesis, Mapping: &mapping}
	deliverer, err := NewKinesisDeliverer(source)
	if err != nil {
		t.Fatal(err)
	}
	reporter := &recordingDeliveryReporter{}
	env := DelivererEnv{
		Source: source,
		Clock:  NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
		Backend: DeliveryBackend{
			Service: backendKinesis,
			Client:  newKinesisClient(server.URL),
			SQS:     newSQSClient(fake.server.URL),
		},
		Invoke: func(context.Context, []byte) (InvokeResult, error) {
			return InvokeResult{HandlerError: "boom"}, nil
		},
		State: reporter,
		Logf:  func(string, ...any) {},
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = deliverer.Start(ctx, env) }()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if reporter.discarded > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if reporter.discarded == 0 {
		t.Fatal("the Kinesis on-failure discard was not reported")
	}
	fake.mu.Lock()
	sent := len(fake.sent)
	fake.mu.Unlock()
	if sent == 0 {
		t.Fatal("the Kinesis on-failure record was not sent")
	}
}

func TestEventBridgeInputEdges(t *testing.T) {
	rule := RuleSpec{Name: "rule", ARN: ruleARN("default", "rule")}
	event := map[string]any{
		"source": "app.test",
		"detail": map[string]any{"item": "x", "number": json.Number("7")},
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	transformer := &RuleInputTransformer{
		InputPathsMap: map[string]string{"item": "$.detail.item", "number": "$.detail.number"},
		InputTemplate: `{"item": "<item>", "number": <number>, "event": <aws.events.event.json>, "missing": "<missing>"}`,
	}
	shaped, err := renderEventBridgeTemplate(transformer, event, rule, now)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(shaped, &decoded); err != nil {
		t.Fatalf("rendered template: %s %v", shaped, err)
	}
	if decoded["item"] != "x" || decoded["event"].(map[string]any)["source"] != "app.test" {
		t.Fatalf("rendered template: %s", shaped)
	}
	if decoded["missing"] != "" {
		t.Fatalf("a missing variable must leave an empty string: %s", shaped)
	}
	if _, err := eventBridgeInput(RuleTargetSpec{InputPath: "$.detail.missing"}, event, rule, now); err != nil {
		t.Fatal(err)
	}
	if _, err := eventBridgeInput(RuleTargetSpec{InputTransformer: &RuleInputTransformer{InputTemplate: ""}}, event, rule, now); err == nil {
		t.Fatal("an empty template must fail")
	}
}

func TestScheduleEdges(t *testing.T) {
	if _, err := parseScheduleExpression("every minute"); err == nil {
		t.Fatal("a non-rate/cron expression must fail")
	}
	if _, err := parseRateExpression("1"); err == nil {
		t.Fatal("a short rate must fail")
	}
	if _, err := parseCronField("*", 0, 59, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := parseCronField("1-2/0", 0, 59, nil); err == nil {
		t.Fatal("a zero step must fail")
	}
	if _, err := parseCronField("9-1", 0, 59, nil); err == nil {
		t.Fatal("a backwards range must fail")
	}
	if _, err := parseCronField("99", 0, 59, nil); err == nil {
		t.Fatal("an out-of-range value must fail")
	}
	cron, err := parseCronExpression("0 0 1 1 ? 2020")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cron.next(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)); err == nil {
		t.Fatal("a past year must not fire")
	}
	if _, err := parseCronExpression("0 0 ? * 1#2 *"); err == nil {
		t.Fatal("the # wildcard must be refused")
	}
	if _, err := parseCronExpression("0 0 L * ? *"); err == nil {
		t.Fatal("the L wildcard must be refused")
	}
}

func TestCloudWatchClientAndSubscriptionEdges(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
		switch request.Header.Get("X-Amz-Target") {
		case "Logs_20140328.CreateLogGroup":
			writer.WriteHeader(http.StatusBadRequest)
			writeTestJSON(t, writer, `{"__type":"ResourceAlreadyExistsException","message":"exists"}`)
		case "Logs_20140328.DescribeLogGroups":
			writeTestJSON(t, writer, `{"logGroups":[{"logGroupName":"/aws/lambda/probe"}]}`)
		case "Logs_20140328.DescribeLogStreams":
			writeTestJSON(t, writer, `{"logStreams":[{"logStreamName":"s1"}]}`)
		case "Logs_20140328.PutLogEvents":
			writeTestJSON(t, writer, `{"nextSequenceToken":"t2"}`)
		default:
			writeTestJSON(t, writer, `{}`)
		}
	}))
	defer server.Close()
	client := newCloudWatchLogsClient(server.URL)
	ctx := context.Background()
	if err := client.CreateLogGroup(ctx, "/aws/lambda/probe"); err != nil {
		t.Fatalf("an existing group must be accepted: %v", err)
	}
	if err := client.CreateLogStream(ctx, "/aws/lambda/probe", "s1"); err != nil {
		t.Fatal(err)
	}
	if err := client.PutLogEvents(ctx, "/aws/lambda/probe", "s1", nil); err != nil {
		t.Fatal(err)
	}
	if err := client.PutLogEvents(ctx, "/aws/lambda/probe", "s1", []cloudWatchLogEvent{{Timestamp: 1, Message: "x"}}); err != nil {
		t.Fatal(err)
	}
	streams, err := client.DescribeLogStreams(ctx, "/aws/lambda/probe")
	if err != nil || len(streams) != 1 {
		t.Fatalf("streams: %+v %v", streams, err)
	}
	if _, err := client.FilterLogEvents(ctx, "/aws/lambda/probe", 0); err != nil {
		t.Fatal(err)
	}
	if got := logMessageLine("2026-11-04T07:47:31Z hello"); got != "hello" {
		t.Fatalf("log line: %q", got)
	}
	if got := logMessageLine("plain"); got != "plain" {
		t.Fatalf("plain line: %q", got)
	}
}
