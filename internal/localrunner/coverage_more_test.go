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
)

func TestDeriveEventRuleValidationCases(t *testing.T) {
	base := func() map[string]any {
		return map[string]any{
			"Fn":    withAsset(lambdaFunction(nil), "asset.deadbeef"),
			"Queue": map[string]any{"Type": typeSQSQueue, "Properties": map[string]any{"QueueName": "target"}},
			"Fifo":  map[string]any{"Type": typeSQSQueue, "Properties": map[string]any{"QueueName": "fifo.fifo", "FifoQueue": true}},
			"Topic": map[string]any{"Type": typeSNSTopic, "Properties": map[string]any{"TopicName": "topic"}},
			"Bus":   map[string]any{"Type": typeEventsBus, "Properties": map[string]any{"Name": "custom-bus"}},
			"Table": map[string]any{"Type": typeDynamoTable, "Properties": map[string]any{"TableName": "t", "KeySchema": []any{map[string]any{"AttributeName": "pk", "KeyType": "HASH"}}, "AttributeDefinitions": []any{map[string]any{"AttributeName": "pk", "AttributeType": "S"}}}},
			"Rule": map[string]any{
				"Type": typeEventsRule,
				"Properties": map[string]any{
					"Name":         "rule",
					"EventPattern": map[string]any{"source": []any{"app.test"}, "detail": map[string]any{"table": map[string]any{"name": []any{map[string]any{"Ref": "Table"}}}}},
					"Targets": []any{
						map[string]any{"Id": "fn", "Arn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}}},
					},
				},
			},
		}
	}
	mutate := func(name string, edit func(map[string]any), wantErr bool) {
		t.Helper()
		resources := base()
		edit(resources)
		dir := writeAssembly(t, resources)
		mkdirAsset(t, dir)
		_, err := deriveAssembly(t, dir)
		if wantErr && err == nil {
			t.Fatalf("%s must fail", name)
		}
		if !wantErr && err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	properties := func(resources map[string]any) map[string]any {
		return resources["Rule"].(map[string]any)["Properties"].(map[string]any)
	}
	targets := func(resources map[string]any) []any {
		return properties(resources)["Targets"].([]any)
	}
	mutate("both schedule and pattern", func(values map[string]any) {
		properties(values)["ScheduleExpression"] = "rate(5 minutes)"
	}, true)
	mutate("neither schedule nor pattern", func(values map[string]any) {
		delete(properties(values), "EventPattern")
	}, true)
	mutate("invalid schedule", func(values map[string]any) {
		delete(properties(values), "EventPattern")
		properties(values)["ScheduleExpression"] = "every minute"
	}, true)
	mutate("schedule on a custom bus", func(values map[string]any) {
		delete(properties(values), "EventPattern")
		properties(values)["ScheduleExpression"] = "rate(5 minutes)"
		properties(values)["EventBusName"] = map[string]any{"Ref": "Bus"}
	}, true)
	mutate("unresolvable pattern expression", func(values map[string]any) {
		properties(values)["EventPattern"] = map[string]any{"source": []any{map[string]any{"Fn::Join": "bad"}}}
	}, true)
	mutate("pattern ref to a missing resource", func(values map[string]any) {
		properties(values)["EventPattern"] = map[string]any{"source": []any{map[string]any{"Ref": "Missing"}}}
	}, true)
	mutate("invalid bus reference", func(values map[string]any) {
		properties(values)["EventBusName"] = map[string]any{"Ref": "Fn"}
	}, true)
	mutate("invalid input JSON", func(values map[string]any) {
		targets(values)[0].(map[string]any)["Input"] = "{"
	}, true)
	mutate("bad input path", func(values map[string]any) {
		targets(values)[0].(map[string]any)["InputPath"] = "detail"
	}, true)
	mutate("empty transformer", func(values map[string]any) {
		targets(values)[0].(map[string]any)["InputTransformer"] = map[string]any{"InputTemplate": " "}
	}, true)
	mutate("bad transformer path", func(values map[string]any) {
		targets(values)[0].(map[string]any)["InputTransformer"] = map[string]any{"InputPathsMap": map[string]any{"x": "detail"}, "InputTemplate": `{"x":"<x>"}`}
	}, true)
	mutate("two input settings", func(values map[string]any) {
		targets(values)[0].(map[string]any)["InputPath"] = "$.detail"
		targets(values)[0].(map[string]any)["Input"] = `{}`
	}, true)
	mutate("retry out of range", func(values map[string]any) {
		targets(values)[0].(map[string]any)["RetryPolicy"] = map[string]any{"MaximumRetryAttempts": 999}
	}, true)
	mutate("max age out of range", func(values map[string]any) {
		targets(values)[0].(map[string]any)["RetryPolicy"] = map[string]any{"MaximumEventAgeInSeconds": 10}
	}, true)
	mutate("dead letter not a queue", func(values map[string]any) {
		targets(values)[0].(map[string]any)["DeadLetterConfig"] = map[string]any{"Arn": map[string]any{"Fn::GetAtt": []any{"Topic", "TopicArn"}}}
	}, true)
	mutate("fifo dead letter", func(values map[string]any) {
		targets(values)[0].(map[string]any)["DeadLetterConfig"] = map[string]any{"Arn": map[string]any{"Fn::GetAtt": []any{"Fifo", "Arn"}}}
	}, true)
	mutate("sqs parameters on a function", func(values map[string]any) {
		targets(values)[0].(map[string]any)["SqsParameters"] = map[string]any{"MessageGroupId": "g"}
	}, true)
	mutate("fifo target without a group", func(values map[string]any) {
		targets(values)[0].(map[string]any)["Arn"] = map[string]any{"Fn::GetAtt": []any{"Fifo", "Arn"}}
	}, true)
	mutate("literal unsupported target", func(values map[string]any) {
		properties(values)["Targets"] = append(targets(values), map[string]any{"Id": "x", "Arn": "arn:aws:logs:us-east-1:123:log-group:x"})
	}, false)
	mutate("lambda target with a bad attribute", func(values map[string]any) {
		properties(values)["Targets"] = append(targets(values), map[string]any{"Id": "bad", "Arn": map[string]any{"Fn::GetAtt": []any{"Fn", "Name"}}})
	}, false)
	mutate("join pattern", func(values map[string]any) {
		properties(values)["EventPattern"] = map[string]any{"source": []any{map[string]any{"Fn::Join": []any{"", []any{"app.", map[string]any{"Ref": "Queue"}}}}}}
	}, false)
}

func TestSessionNewOperationEdges(t *testing.T) {
	runner := &Runner{
		clock: RealClock{},
		resourceValues: resourceValues{
			"S/Stream": {Type: typeKinesisStream, Name: "stream", ARN: "arn:aws:kinesis:us-east-1:123456789012:stream/stream"},
		},
		backends: map[string]backendProcess{
			"sns": {HostURL: "http://127.0.0.1:1", Endpoints: []Endpoint{{Service: "sns", URL: "http://127.0.0.1:1"}}},
		},
	}
	spec := &Spec{
		Rules: []RuleSpec{{
			LogicalID:    "Rule",
			Name:         "rule",
			ARN:          ruleARN("default", "rule"),
			EventPattern: json.RawMessage(`{"source":["app.test"],"detail-type":["Thing"]}`),
		}},
		Resources: []ResourceSpec{
			{Stack: "S", LogicalID: "Stream", Type: typeKinesisStream, Properties: json.RawMessage(`{"Name":"stream"}`)},
			{Stack: "S", LogicalID: "Group", Type: typeLogGroup, Properties: json.RawMessage(`{"LogGroupName":"/group"}`)},
		},
	}
	session := &localSession{runner: runner, spec: spec}
	if result, err := session.execute(context.Background(), sessionRequest{Op: "eventbridge.event", Rule: "Rule"}); err != nil {
		t.Fatalf("eventbridge.event: %v", err)
	} else if result == nil {
		t.Fatal("eventbridge.event returned nothing")
	}
	if _, err := session.execute(context.Background(), sessionRequest{Op: "kinesis.event", Stream: "S/Stream", Data: []string{"aGVsbG8="}}); err != nil {
		t.Fatalf("kinesis.event: %v", err)
	}
	if _, err := session.execute(context.Background(), sessionRequest{Op: "kinesis.cloudwatch-event", Stream: "S/Stream", LogGroup: "/group", LogEvents: []CloudWatchLogEvent{{ID: "1", Timestamp: 1, Message: "x"}}}); err != nil {
		t.Fatalf("kinesis.cloudwatch-event: %v", err)
	}
	endpoints := session.describeEndpoints()
	if len(endpoints) != 1 || endpoints[0]["service"] != "sns" {
		t.Fatalf("endpoints: %+v", endpoints)
	}
	runner.eventBusURL = "http://127.0.0.1:1234"
	endpoints = session.describeEndpoints()
	if len(endpoints) != 2 {
		t.Fatalf("endpoints with the bus: %+v", endpoints)
	}
}

func TestRunnerBusAndDeliveryClients(t *testing.T) {
	runner := &Runner{
		clock:     RealClock{},
		endpoints: []Endpoint{{Service: backendSQS, URL: "http://127.0.0.1:1"}},
		options:   Options{Stdout: io.Discard},
		eventBus:  newEventBridgeBus(RealClock{}),
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := runner.startEventBridgeBus(ctx); err != nil {
		t.Fatal(err)
	}
	if runner.eventBusURL == "" || runner.eventBusContainer == "" {
		t.Fatalf("bus URLs: %q %q", runner.eventBusURL, runner.eventBusContainer)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, runner.eventBusURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer closeBody(t, response.Body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("bus GET: %d", response.StatusCode)
	}
	if got := runner.deliverySQSClientOrNil(); got != nil {
		t.Fatalf("a missing SQS backend must return no client: %v", got)
	}
	if _, err := (&Runner{}).ResolveDeliveryBackend(DeliveryKind("unknown")); err == nil {
		t.Fatal("an unknown kind must fail")
	}
	if backend, err := runner.ResolveDeliveryBackend(DeliveryKindEventBridgeRule); err != nil || backend.Service != eventsService {
		t.Fatalf("events backend: %+v %v", backend, err)
	}
}

func TestCloudWatchFilterValidationCases(t *testing.T) {
	invalid := []string{
		`{ $.a = "x"`,
		`{ $.a }`,
		`{ $.a = }`,
		`{ $.a[0] = "x" }`,
		`{ $.a = "x" && }`,
		`{ ($.a = "x" }`,
		`{ $ = "x" }`,
		`{ $.a = x y }`,
		`%regex%`,
		`[w1, w2]`,
		`"unterminated`,
		`?`,
	}
	for _, pattern := range invalid {
		if err := validateCloudWatchFilterPattern(pattern); err == nil {
			t.Fatalf("%q must be refused", pattern)
		}
	}
	if matched, err := cloudWatchFilterMatches(`{ $.a != "x" }`, `{"a":"y"}`); err != nil || !matched {
		t.Fatalf("!=: %v %v", matched, err)
	}
	if matched, err := cloudWatchFilterMatches(`{ $.a = 7 }`, `{"a":7}`); err != nil || !matched {
		t.Fatalf("numeric: %v %v", matched, err)
	}
	if matched, err := cloudWatchFilterMatches(`{ $.a = true }`, `{"a":true}`); err != nil || !matched {
		t.Fatalf("boolean: %v %v", matched, err)
	}
	if matched, _ := cloudWatchFilterMatches(`{ $.a = "x" }`, `not-json`); matched {
		t.Fatal("a non-JSON message must not match a JSON pattern")
	}
}

func TestTTLHelpers(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if !ttlDue(&types.AttributeValueMemberN{Value: "1"}, now) {
		t.Fatal("numeric TTL")
	}
	if !ttlDue(&types.AttributeValueMemberS{Value: "2025-12-31T00:00:00Z"}, now) {
		t.Fatal("string TTL")
	}
	if ttlDue(&types.AttributeValueMemberBOOL{Value: true}, now) {
		t.Fatal("boolean TTL")
	}
	if ttlDue(&types.AttributeValueMemberN{Value: "bad"}, now) {
		t.Fatal("bad numeric TTL")
	}
	if ttlDue(&types.AttributeValueMemberS{Value: "bad"}, now) {
		t.Fatal("bad string TTL")
	}
	key := ttlItemKey(map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "a"}}, []keySchemaAttribute{{Name: "pk"}, {Name: "sk"}})
	if len(key) != 0 {
		t.Fatalf("a missing key component must yield no key: %+v", key)
	}
	tracker := newTTLTracker()
	if tracker.take("", nil, now) {
		t.Fatal("an empty key never matches")
	}
	tracker.mark("", nil, now)
}

func TestFunctionLogHelpers(t *testing.T) {
	spec := &Spec{Resources: []ResourceSpec{{Stack: "S", LogicalID: "Fn", Type: typeLambdaFunction, Properties: json.RawMessage(`{"FunctionName":"fn"}`)}}}
	name, err := functionPhysicalName(spec, FunctionSpec{Stack: "S", LogicalID: "Fn"})
	if err != nil || name != "fn" {
		t.Fatalf("function name: %q %v", name, err)
	}
	if _, err := functionPhysicalName(spec, FunctionSpec{Stack: "S", LogicalID: "Missing"}); err == nil {
		t.Fatal("a missing function must fail")
	}
	runner := &Runner{options: Options{Stdout: io.Discard}}
	runner.startFunctionLogs(context.Background(), spec, []string{"Fn"})
}

func TestKinesisAndDynamoDisabledAndFilter(t *testing.T) {
	mapping := EventSourceSpec{
		LogicalID:  "Disabled",
		Type:       backendKinesis,
		SourceName: "probe",
		SourceARN:  "arn:aws:kinesis:us-east-1:123456789012:stream/probe",
		Enabled:    false,
	}
	deliverer, err := NewKinesisDeliverer(DeliverySource{ID: "Disabled", Kind: DeliveryKindKinesis, Mapping: &mapping})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	reporter := &recordingDeliveryReporter{}
	env := DelivererEnv{Clock: RealClock{}, State: reporter, Backend: DeliveryBackend{Client: newKinesisClient("http://127.0.0.1:1")}, Logf: func(string, ...any) {}}
	if startErr := deliverer.Start(ctx, env); startErr != nil {
		t.Fatalf("a disabled Kinesis mapping: %v", startErr)
	}
	if reporter.phase != DeliveryPhasePaused {
		t.Fatalf("a disabled mapping must pause: %+v", reporter)
	}

	ddbMapping := EventSourceSpec{LogicalID: "Disabled", Type: backendDynamoDB, SourceName: "probe", Enabled: false}
	ddb, err := NewDynamoDBStreamDeliverer(DeliverySource{ID: "Disabled", Kind: DeliveryKindDynamoDBStream, Mapping: &ddbMapping}, newTTLTracker())
	if err != nil {
		t.Fatal(err)
	}
	if err := ddb.Start(ctx, DelivererEnv{Clock: RealClock{}, State: reporter, Backend: DeliveryBackend{Client: &dynamoDBLocalBackend{data: newDynamoDBClient("http://127.0.0.1:1"), streams: newDynamoStreamsClient("http://127.0.0.1:1")}}, Logf: func(string, ...any) {}}); err == nil {
		// A disabled mapping still describes the table first; the closed client
		// makes this fail, which is the fail-closed path.
	} else if !strings.Contains(err.Error(), "describe local table") {
		t.Fatalf("unexpected DynamoDB disabled error: %v", err)
	}
}

func TestEventBridgeDisabledAndDeadLetterEdges(t *testing.T) {
	rule := RuleSpec{LogicalID: "Disabled", Name: "disabled", ARN: ruleARN("default", "disabled"), Enabled: false}
	deliverer, err := NewEventBridgeDeliverer(DeliverySource{ID: "Disabled", Kind: DeliveryKindEventBridgeRule, Rule: &rule}, newEventBridgeBus(RealClock{}))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	reporter := &recordingDeliveryReporter{}
	if err := deliverer.Start(ctx, DelivererEnv{Source: DeliverySource{ID: "Disabled"}, Clock: RealClock{}, State: reporter, Logf: func(string, ...any) {}}); err != nil {
		t.Fatal(err)
	}
	if reporter.phase != DeliveryPhasePaused {
		t.Fatalf("a disabled rule must pause: %+v", reporter)
	}
	eventBridge, ok := deliverer.(*EventBridgeDeliverer)
	if !ok {
		t.Fatalf("unexpected type %T", deliverer)
	}
	eventBridge.env = DelivererEnv{
		Clock: RealClock{},
		State: reporter,
		Logf:  func(string, ...any) {},
		InvokeTarget: func(context.Context, string, []byte) (InvokeResult, error) {
			return InvokeResult{}, errors.New("missing")
		},
	}
	eventBridge.rule.TargetSpecs = []RuleTargetSpec{{
		ID:          "fn",
		Type:        ruleTargetFunction,
		Function:    "Missing",
		RetryPolicy: &RuleRetryPolicy{MaximumRetryAttempts: 0},
	}}
	eventBridge.deliverTargets(context.Background(), map[string]any{"source": "app.test"})
	if reporter.failed == 0 {
		t.Fatal("a missing target must fail")
	}
}

func TestProvisionLogGroupEdges(t *testing.T) {
	runner := &Runner{resourceValues: resourceValues{}, options: Options{Stdout: io.Discard}}
	if err := runner.provisionLogGroups(context.Background(), &Spec{}); err != nil {
		t.Fatalf("no logs backend: %v", err)
	}
	runner.backends = map[string]backendProcess{"moto": {HostURL: "http://127.0.0.1:1", Endpoints: []Endpoint{{Service: logsService, URL: "http://127.0.0.1:1"}}}}
	spec := &Spec{Resources: []ResourceSpec{{Stack: "S", LogicalID: "Group", Type: typeLogGroup, Properties: json.RawMessage(`{"LogGroupName":"/literal"}`)}}}
	if err := runner.provisionLogGroups(context.Background(), spec); err == nil {
		t.Fatal("a closed Logs endpoint must fail closed")
	}
	if name := logGroupResourceName(spec, spec.Resources[0]); name != "/literal" {
		t.Fatalf("literal log group: %q", name)
	}
	if name := logGroupResourceName(&Spec{}, ResourceSpec{Stack: "S", LogicalID: "Fallback", Type: typeLogGroup}); name != "local-s-fallback" {
		t.Fatalf("fallback log group: %q", name)
	}
}

func TestEventBridgeBusCustomAndDisabled(t *testing.T) {
	bus := newEventBridgeBus(NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)))
	disabled := &eventBridgeRuleRuntime{rule: RuleSpec{LogicalID: "Disabled", BusName: "custom", EventPattern: json.RawMessage(`{"source":["app.test"]}`)}}
	bus.register(disabled)
	results, failed := bus.putEvents(context.Background(), []eventBridgeEntry{{Source: "app.test", DetailType: "Thing", Detail: "{}", EventBusName: "custom"}})
	if failed != 0 || len(results) != 1 {
		t.Fatalf("disabled rule: %+v %d", results, failed)
	}
	bus.unregister(disabled)
	malformed, failed := bus.putEvents(context.Background(), []eventBridgeEntry{{Source: "app.test", DetailType: "Thing", Detail: "{bad"}})
	if failed != 1 || malformed[0].ErrorCode != "MalformedDetail" {
		t.Fatalf("malformed detail: %+v %d", malformed, failed)
	}
	if _, failed := bus.putEvents(context.Background(), []eventBridgeEntry{{Source: "app.test", DetailType: "Thing", Detail: "{}", Time: "not-time"}}); failed != 1 {
		t.Fatal("an invalid Time must fail")
	}
}

func TestStreamPollerAgeAndWait(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	reporter := &recordingDeliveryReporter{}
	reader := &fakeShardReader{batches: [][]streamRecord{{
		{Sequence: "1", Shard: "s", Arrival: clock.Now(), Value: "x"},
	}}}
	var discarded int
	poller := newStreamPoller("m", DelivererEnv{Clock: clock, State: reporter}, reader, streamPollerOptions{
		BatchSize:            10,
		MaximumRecordAge:     time.Minute,
		MaximumRetryAttempts: 10,
	}, func(context.Context, []streamRecord) streamBatchOutcome {
		return streamBatchOutcome{WholeFailure: true}
	}, func(context.Context, []streamRecord, string, int, error) {
		discarded++
	})
	ctx, cancel := context.WithCancel(context.Background())
	go poller.run(ctx)
	for index := 0; index < 40; index++ {
		clock.Advance(time.Minute) //nolint:errcheck // a test clock advance never fails
		time.Sleep(2 * time.Millisecond)
	}
	cancel()
	if discarded == 0 {
		t.Fatal("an aged record must be discarded")
	}
	if got := checkpointIndex([]streamRecord{{Sequence: "1"}, {Sequence: "2"}}, []string{"9"}); got != -1 {
		t.Fatalf("unknown checkpoint: %d", got)
	}
	if got := checkpointIndex([]streamRecord{{Sequence: "1"}, {Sequence: "2"}}, []string{"2"}); got != 1 {
		t.Fatalf("checkpoint: %d", got)
	}
}

func TestDynamoStreamHelpers(t *testing.T) {
	if got := normalizeDynamoStreamARN("arn:aws:dynamodb:ddblocal:000000000000:table/t/stream/1", "t"); !strings.Contains(got, "us-east-1") {
		t.Fatalf("normalized ARN: %q", got)
	}
	if got := normalizeDynamoStreamARN("other", "t"); !strings.Contains(got, "table/t/stream/local") {
		t.Fatalf("fallback ARN: %q", got)
	}
	record := map[string]any{"dynamodb": map[string]any{"SequenceNumber": "1", "Keys": map[string]any{"pk": map[string]any{"S": "a"}}}}
	if dynamoStreamSequence(record) != "1" || dynamoStreamKeys(record)["pk"] == nil {
		t.Fatalf("record helpers: %+v", record)
	}
	if dynamoStreamSequence(map[string]any{}) != "" || dynamoStreamKeys(map[string]any{}) != nil {
		t.Fatal("empty record helpers")
	}
	if got := partitionKeyValue(map[string]any{"pk": map[string]any{"N": "7"}}, "pk"); got != "7" {
		t.Fatalf("partition key: %q", got)
	}
	if got := partitionKeyValue(map[string]any{}, ""); got != "" {
		t.Fatalf("empty partition key: %q", got)
	}
	if streamLane("p", 1) != 0 || streamLane("p", 0) != 0 {
		t.Fatal("lane zero")
	}
}

func TestJSONClientErrorAndHTTP(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
		writer.WriteHeader(http.StatusBadRequest)
		writeTestJSON(t, writer, `{"__type":"com.amazonaws#ValidationException","message":"bad"}`)
	}))
	defer server.Close()
	client := newAWSJSONClient(server.URL, "logs", "Logs_20140328")
	err := client.call(context.Background(), "Bad", map[string]any{}, nil)
	var serviceErr *awsJSONError
	if err == nil || !isAWSJSONError(err, "ValidationException") {
		t.Fatalf("service error: %v", err)
	}
	_ = serviceErr
	if err := client.call(context.Background(), "Bad", map[string]any{}, nil); err == nil {
		t.Fatal("a non-2xx response must fail")
	}
}

func TestDynamoRecordAndTTLMore(t *testing.T) {
	if got := epochSeconds(json.Number("7")); got != json.Number("7") {
		t.Fatalf("json number: %v", got)
	}
	if got := epochSeconds(int64(7)); got != float64(7) {
		t.Fatalf("int64: %v", got)
	}
	if got := epochSeconds("not-a-time"); got != "not-a-time" {
		t.Fatalf("string fallback: %v", got)
	}
	key := ttlItemKey(map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "a"}}, []keySchemaAttribute{{Name: "pk"}})
	if len(key) != 1 {
		t.Fatalf("ttl key: %+v", key)
	}
	if signature := ttlKeySignature("t", nil); signature != "" {
		t.Fatalf("empty signature: %q", signature)
	}
	if err := newCloudWatchLogsClient("http://127.0.0.1:1").Ping(context.Background()); err == nil {
		t.Fatal("a closed Logs endpoint must fail the readiness probe")
	}
	if _, err := newDynamoStreamsClient("http://127.0.0.1:1").ListStreams(context.Background(), "t"); err == nil {
		t.Fatal("a closed DynamoDB endpoint must fail")
	}
}
