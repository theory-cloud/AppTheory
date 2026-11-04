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

func TestSourceReporterCounters(t *testing.T) {
	engine := NewDeliveryEngine(RealClock{}, 2, nil, nil, nil)
	if err := engine.Start(context.Background(), deliveryTestSpec()); err != nil {
		t.Fatal(err)
	}
	reporter := &sourceReporter{engine: engine, id: "QueueMapping"}
	reporter.SetPhase(DeliveryPhasePolling)
	reporter.Delivered()
	reporter.Failed(nil)
	reporter.Failed(errors.New("boom"))
	reporter.Filtered()
	reporter.Discarded(2)
	reporter.Fired()
	reporter.DeadLettered()
	reporter.SetInflight(3)
	reporter.SetPaused(true)
	reporter.Left(4)
	state := engine.State()
	if len(state.Sources) == 0 {
		t.Fatal("no sources")
	}
	for _, source := range state.Sources {
		if source.ID == "QueueMapping" {
			if source.Delivered != 1 || source.Failed != 2 || source.Filtered != 1 ||
				source.Discarded != 2 || source.Fired != 1 || source.DeadLettered != 1 ||
				source.Inflight != 3 || source.PeakInflight != 3 || source.Left != 4 || !source.Paused {
				t.Fatalf("reporter state: %+v", source)
			}
		}
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = engine.Stop(stopCtx)
}

func TestPatternReferenceResolution(t *testing.T) {
	resources := map[string]any{
		"Fn":     withAsset(lambdaFunction(nil), "asset.deadbeef"),
		"Queue":  map[string]any{"Type": typeSQSQueue, "Properties": map[string]any{"QueueName": "q"}},
		"Topic":  map[string]any{"Type": typeSNSTopic, "Properties": map[string]any{"TopicName": "t"}},
		"Table":  map[string]any{"Type": typeDynamoTable, "Properties": map[string]any{"TableName": "tbl", "KeySchema": []any{map[string]any{"AttributeName": "pk", "KeyType": "HASH"}}, "AttributeDefinitions": []any{map[string]any{"AttributeName": "pk", "AttributeType": "S"}}}},
		"Stream": map[string]any{"Type": typeKinesisStream, "Properties": map[string]any{"Name": "stream"}},
		"Bucket": map[string]any{"Type": typeS3Bucket, "Properties": map[string]any{"BucketName": "bucket"}},
		"Rule":   map[string]any{"Type": typeEventsRule, "Properties": map[string]any{"Name": "rule", "EventPattern": map[string]any{"source": []any{"app.test"}}, "Targets": []any{map[string]any{"Id": "fn", "Arn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}}}}}},
		"Pattern": map[string]any{"Type": typeEventsRule, "Properties": map[string]any{"EventPattern": map[string]any{
			"source": []any{"app.test"},
			"detail": map[string]any{
				"fn":     []any{map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}}},
				"queue":  []any{map[string]any{"Fn::GetAtt": []any{"Queue", "Arn"}}},
				"topic":  []any{map[string]any{"Ref": "Topic"}},
				"table":  []any{map[string]any{"Ref": "Table"}},
				"stream": []any{map[string]any{"Fn::GetAtt": []any{"Stream", "Arn"}}},
				"bucket": []any{map[string]any{"Ref": "Bucket"}},
				"rule":   []any{map[string]any{"Fn::GetAtt": []any{"Rule", "Arn"}}},
			},
		}, "Targets": []any{map[string]any{"Id": "fn", "Arn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}}}}}},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatal(err)
	}
	pattern := string(spec.Rules[0].EventPattern)
	for _, needle := range []string{"arn:aws:lambda", "arn:aws:sqs", "arn:aws:sns", "\"table\":[\"tbl\"]", "arn:aws:kinesis", "\"bucket\":[\"bucket\"]", "arn:aws:events"} {
		if !strings.Contains(pattern, needle) {
			t.Fatalf("pattern missing %q: %s", needle, pattern)
		}
	}
}

func TestLogGroupNameResolution(t *testing.T) {
	resources := eventSourceResources()
	resources["Group"] = map[string]any{"Type": typeLogGroup, "Properties": map[string]any{"LogGroupName": map[string]any{"Fn::Join": []any{"", []any{"/aws/lambda/", map[string]any{"Ref": "Fn"}}}}}}
	resources["Filter"] = map[string]any{"Type": typeLogsSubscription, "Properties": map[string]any{
		"LogGroupName":   map[string]any{"Ref": "Group"},
		"FilterName":     "filter",
		"FilterPattern":  "",
		"DestinationArn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
	}}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(spec.Subscriptions) != 1 || !strings.HasPrefix(spec.Subscriptions[0].LogGroup, "/aws/lambda/") {
		t.Fatalf("subscription group: %+v", spec.Subscriptions)
	}
	stack := assemblyStack{Name: "S", Template: template{Resources: map[string]templateResource{
		"Fn":    {Type: typeLambdaFunction, Properties: json.RawMessage(`{"FunctionName":"fn"}`)},
		"Group": {Type: typeLogGroup, Properties: json.RawMessage(`{"LogGroupName":{"Fn::GetAtt":["Fn","Name"]}}`)},
	}}}
	if got := functionLogGroupName(stack, "Fn"); got != "/aws/lambda/fn" {
		t.Fatalf("function log group: %q", got)
	}
	if got := logGroupNameFromResource(stack, "Group"); got == "" {
		t.Fatal("GetAtt log group name")
	}
	if got := flattenLogGroupValue(stack, map[string]any{"Fn::Join": []any{"-", []any{"a", "b"}}}); got != "a-b" {
		t.Fatalf("join: %q", got)
	}
	if got := flattenLogGroupValue(stack, 7); got != "" {
		t.Fatalf("bad value: %q", got)
	}
	if got := flattenLogGroupValue(stack, map[string]any{"Ref": "Missing"}); got != "" {
		t.Fatalf("missing ref: %q", got)
	}
}

func TestDynamoShardLanesAndDiscard(t *testing.T) {
	deliverer := &DynamoDBStreamDeliverer{mapping: EventSourceSpec{PartitionKey: "pk"}}
	reader := &dynamoShardReader{deliverer: deliverer, lanes: 2, lane: 0}
	keys := map[string]any{"pk": map[string]any{"S": "a"}}
	if !reader.owns(keys) {
		t.Fatal("one lane must own a key")
	}
	if reader.owns(nil) != true {
		t.Fatal("an empty key belongs to every lane")
	}
	if got := partitionKeyValue(map[string]any{"pk": map[string]any{"S": "a"}}, ""); got != "a" {
		t.Fatalf("first key: %q", got)
	}
	if got := partitionKeyValue(map[string]any{"pk": map[string]any{"S": "a"}}, "missing"); got != "" {
		t.Fatalf("missing key: %q", got)
	}
	reader2 := &dynamoShardReader{deliverer: deliverer, lanes: 2, lane: 1}
	if reader2.owns(nil) != true {
		t.Fatal("empty keys own all lanes")
	}
	record := streamRecord{Sequence: "1", Shard: "s", Arrival: time.Now(), Value: map[string]any{"eventName": "REMOVE"}}
	deliverer.mapping.ReportBatchItemFailures = true
	deliverer.mapping.DestinationType = backendSQS
	deliverer.mapping.DestinationName = "x"
	reporter := &recordingDeliveryReporter{}
	env := DelivererEnv{Clock: RealClock{}, State: reporter, Backend: DeliveryBackend{}, Logf: func(string, ...any) {}}
	deliverer.discard(env)(context.Background(), []streamRecord{record}, "MaximumRetryAttempts", 1, errors.New("boom"))
	if reporter.failed == 0 {
		t.Fatal("a missing discard backend must be reported")
	}
	if deliverer.pollerOptions(env).MaximumRetryAttempts != streamUnlimitedRetries {
		t.Fatal("the retry default")
	}
}

func TestKinesisDelivererOptionsAndDeliver(t *testing.T) {
	deliverer := &KinesisDeliverer{mapping: EventSourceSpec{BatchSize: 10, ParallelizationFactor: 1, MaximumRetryAttempts: -1, MaximumRecordAgeInSeconds: 60}}
	env := DelivererEnv{Clock: NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)), State: &recordingDeliveryReporter{}, Logf: func(string, ...any) {}}
	deliverer.stream = "arn:aws:kinesis:us-east-1:123456789012:stream/probe"
	options := deliverer.pollerOptions(env)
	if options.MaximumRetryAttempts != -1 || options.MaximumRecordAge != time.Minute {
		t.Fatalf("options: %+v", options)
	}
	if options.Accept == nil {
		t.Fatal("the filter acceptance hook is missing")
	}
	if !options.Accept(streamRecord{Value: "not-a-record"}) {
		t.Fatal("an unexpected value is accepted")
	}
	if options.Accept(streamRecord{Value: KinesisRecordInput{Data: []byte("x")}}) != true {
		t.Fatal("an empty filter accepts")
	}
	deliverer.mapping.FilterCriteria = json.RawMessage(`{"Filters":[{"Pattern":"{\"eventSource\":[\"aws:kinesis\"]}"}]}`)
	if !options.Accept(streamRecord{Value: KinesisRecordInput{Data: []byte("x"), PartitionKey: "p"}}) {
		t.Fatal("the Kinesis filter should match")
	}
	deliverer.mapping.FilterCriteria = json.RawMessage(`{"Filters":[{"Pattern":"not-json"}]}`)
	if options.Accept(streamRecord{Value: KinesisRecordInput{Data: []byte("x")}}) {
		t.Fatal("an invalid filter must fail closed")
	}
	deliverer.mapping.FilterCriteria = nil
	deliverer.mapping.ReportBatchItemFailures = true
	env.Invoke = func(context.Context, []byte) (InvokeResult, error) {
		return InvokeResult{Raw: []byte(`{"batchItemFailures":[{"itemIdentifier":"2"}]}`)}, nil
	}
	outcome := deliverer.deliver(env)(context.Background(), []streamRecord{{Sequence: "1", Value: KinesisRecordInput{Data: []byte("x")}}, {Sequence: "2", Value: KinesisRecordInput{Data: []byte("y")}}})
	if outcome.WholeFailure || len(outcome.FailedSequences) != 1 {
		t.Fatalf("deliver outcome: %+v", outcome)
	}
	deliverer.mapping.ReportBatchItemFailures = false
	outcome = deliverer.deliver(env)(context.Background(), []streamRecord{{Sequence: "1", Value: KinesisRecordInput{}}})
	if outcome.WholeFailure || len(outcome.FailedSequences) != 0 {
		t.Fatalf("without partial failure: %+v", outcome)
	}
}

func TestSessionDescribeAndOperationErrors(t *testing.T) {
	runner := &Runner{
		clock:          RealClock{},
		resourceValues: resourceValues{"S/Table": {Type: typeDynamoTable, Name: "table"}},
		backends: map[string]backendProcess{
			backendSQS: {HostURL: "http://127.0.0.1:1", Endpoints: []Endpoint{{Service: backendSQS, URL: "http://127.0.0.1:1"}}},
		},
	}
	spec := &Spec{
		Functions: []FunctionSpec{{LogicalID: "Fn", Stack: "S", Runtime: "provided.al2023", Handler: "bootstrap"}},
		Resources: []ResourceSpec{{Stack: "S", LogicalID: "Table", Type: typeDynamoTable, Properties: json.RawMessage(`{"TableName":"table"}`)}},
	}
	session := &localSession{runner: runner, spec: spec}
	described, err := session.describe()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := described["functions"].([]map[string]any); !ok {
		t.Fatalf("describe functions: %+v", described["functions"])
	}
	if _, err := session.execute(context.Background(), sessionRequest{Op: "eventbridge.event", Rule: "Missing"}); err == nil {
		t.Fatal("a missing rule must fail")
	}
	if _, err := session.execute(context.Background(), sessionRequest{Op: "kinesis.event", Stream: "Missing"}); err == nil {
		t.Fatal("a missing stream must fail")
	}
	if _, err := session.execute(context.Background(), sessionRequest{Op: "sqs.send", Queue: "Missing"}); err == nil {
		t.Fatal("a missing queue must fail")
	}
	if _, err := session.execute(context.Background(), sessionRequest{Op: "ddb.get", Table: "Missing"}); err == nil {
		t.Fatal("a missing table must fail")
	}
	if _, err := session.execute(context.Background(), sessionRequest{Op: "unknown"}); err == nil {
		t.Fatal("an unknown op must fail")
	}
}

func TestProvisionLogGroupsSuccessAndErrors(t *testing.T) {
	var created []string
	fail := false
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body)
		if fail {
			writer.WriteHeader(http.StatusInternalServerError)
			writeTestJSON(t, writer, `{"__type":"ServiceException","message":"boom"}`)
			return
		}
		if name, ok := body["logGroupName"].(string); ok {
			created = append(created, name)
		}
		writeTestJSON(t, writer, `{}`)
	}))
	defer server.Close()
	runner := &Runner{
		resourceValues: resourceValues{},
		options:        Options{Stdout: io.Discard},
		backends: map[string]backendProcess{"moto": {
			HostURL:   server.URL,
			Endpoints: []Endpoint{{Service: logsService, URL: server.URL}},
		}},
	}
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "S", LogicalID: "Fn", Type: typeLambdaFunction, Properties: json.RawMessage(`{"FunctionName":"fn"}`)},
		{Stack: "S", LogicalID: "Group", Type: typeLogGroup, Properties: json.RawMessage(`{"LogGroupName":{"Fn::Join":["",["/aws/lambda/",{"Ref":"Fn"}]]}}`)},
	}}
	if err := runner.provisionLogGroups(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	if len(created) != 1 || created[0] != "/aws/lambda/fn" {
		t.Fatalf("created: %v", created)
	}
	fail = true
	if err := runner.provisionLogGroups(context.Background(), spec); err == nil {
		t.Fatal("a failed CreateLogGroup must fail provisioning")
	}
}

func TestEventBridgeAttemptAndDeadLetterErrors(t *testing.T) {
	deliverer := &EventBridgeDeliverer{rule: RuleSpec{ARN: "arn:rule"}}
	reporter := &recordingDeliveryReporter{}
	deliverer.env = DelivererEnv{
		Clock: RealClock{},
		State: reporter,
		Logf:  func(string, ...any) {},
		InvokeTarget: func(context.Context, string, []byte) (InvokeResult, error) {
			return InvokeResult{}, errors.New("boom")
		},
	}
	if _, err := deliverer.attemptTarget(context.Background(), RuleTargetSpec{Type: backendSQS}, nil, nil); err == nil {
		t.Fatal("an SQS target without a backend must fail")
	}
	if _, err := deliverer.attemptTarget(context.Background(), RuleTargetSpec{Type: ruleTargetSNS}, nil, nil); err == nil {
		t.Fatal("an SNS target without a backend must fail")
	}
	if _, err := deliverer.attemptTarget(context.Background(), RuleTargetSpec{Type: ruleTargetFunction}, nil, nil); err == nil {
		t.Fatal("a function target without an invoker must fail")
	}
	if _, err := deliverer.attemptTarget(context.Background(), RuleTargetSpec{Type: "other"}, nil, nil); err == nil {
		t.Fatal("an unknown target must fail")
	}
	deliverer.deadLetter(context.Background(), RuleTargetSpec{ID: "x"}, nil, eventBridgeErrorFromTarget, errors.New("boom"), eventBridgeConditionRetries, 1)
	deliverer.deadLetter(context.Background(), RuleTargetSpec{ID: "x", DeadLetterQueueName: "dlq"}, nil, eventBridgeErrorFromTarget, errors.New("boom"), eventBridgeConditionRetries, 1)
	if reporter.failed == 0 {
		t.Fatal("a missing DLQ backend must be reported")
	}
	if eventBridgeMessageGroup("", nil) != "" || eventBridgeMessageGroup("$.missing", nil) != "" {
		t.Fatal("message group edges")
	}
}

func TestCloudWatchSubscriptionPollAndSeen(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
		now := time.Now().UnixMilli()
		switch request.Header.Get("X-Amz-Target") {
		case "Logs_20140328.FilterLogEvents":
			writeTestJSON(t, writer, `{"events":[{"eventId":"1","logStreamName":"s1","timestamp":`+jsonNumber(now)+`,"message":"order"},{"eventId":"2","logStreamName":"s1","timestamp":`+jsonNumber(now+1)+`,"message":"health"}]}`)
		default:
			writeTestJSON(t, writer, `{}`)
		}
	}))
	defer server.Close()
	source := DeliverySource{ID: "Filter", Kind: DeliveryKindCloudWatchLogs, Subscription: &SubscriptionSpec{
		LogicalID: "Filter", Kind: string(DeliveryKindCloudWatchLogs), LogGroup: "/group",
		FilterName: "orders", FilterPattern: "order", DestinationType: "function", Function: "Fn",
	}}
	deliverer, err := NewCloudWatchLogsDeliverer(source)
	if err != nil {
		t.Fatal(err)
	}
	typed := deliverer.(*CloudWatchLogsDeliverer)
	reporter := &recordingDeliveryReporter{}
	env := DelivererEnv{
		Source:  source,
		Clock:   NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
		Backend: DeliveryBackend{Client: &logsLocalBackend{logs: newCloudWatchLogsClient(server.URL)}},
		Invoke: func(context.Context, []byte) (InvokeResult, error) {
			return InvokeResult{}, errors.New("boom")
		},
		State: reporter,
		Logf:  func(string, ...any) {},
	}
	typed.logs = newCloudWatchLogsClient(server.URL)
	typed.cursor = 0
	typed.poll(context.Background(), env)
	if reporter.failed == 0 {
		t.Fatal("a failed target must be reported")
	}
	if typed.markSeen("x") || !typed.markSeen("x") {
		t.Fatal("markSeen must be idempotent")
	}
	for index := 0; index < logsSeenLimit+10; index++ {
		typed.markSeen("k" + jsonNumber(int64(index)))
	}
	if typed.partitionKey("s1") != "s1" {
		t.Fatal("partition key")
	}
	typed.subscription.Distribution = "Random"
	if typed.partitionKey("s1") == "" {
		t.Fatal("random partition key")
	}
	typed.subscription.DestinationType = "stream"
	typed.subscription.StreamName = "stream"
	typed.kinesis = nil
	if err := typed.deliverStream(context.Background(), env, "s1", []cloudWatchFilterEvent{{EventID: "1", Timestamp: 1, Message: "x"}}); err == nil {
		t.Fatal("a stream destination without a Kinesis client must fail")
	}
	typed.subscription.DestinationType = "other"
	if err := typed.deliverStream(context.Background(), env, "s1", nil); err == nil {
		t.Fatal("an unknown destination must fail")
	}
}

func TestTTLAndDynamoHelpersMore(t *testing.T) {
	if got := ttlDue(&types.AttributeValueMemberS{Value: "2026-01-01T00:00:00Z"}, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)); !got {
		t.Fatal("string ttl due")
	}
	if got := ttlItemKey(map[string]types.AttributeValue{}, []keySchemaAttribute{{Name: "pk"}}); len(got) != 0 {
		t.Fatal("missing ttl key")
	}
	if got := ttlKeySignature("t", map[string]any{"pk": map[string]any{"S": "a"}}); got == "" {
		t.Fatal("signature")
	}
	tracker := newTTLTracker()
	tracker.mark("t", map[string]any{"pk": map[string]any{"S": "a"}}, time.Now())
	tracker.mu.Lock()
	tracker.deleted = map[string]time.Time{"t\x00{}": time.Now().Add(-time.Hour)}
	tracker.mu.Unlock()
	if tracker.take("t", map[string]any{}, time.Now()) {
		t.Fatal("an old marker must not match")
	}
}

func jsonNumber(value int64) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
