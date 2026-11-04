//nolint:errcheck // test fixtures decode protocol shapes with unchecked type assertions
package localrunner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// sessionResources is the minimal spec and provisioned state the session error
// paths need: one resource of each family the session operations resolve.
func sessionResources() (*Runner, *Spec) {
	runner := &Runner{
		clock: RealClock{},
		resourceValues: resourceValues{
			"S/Queue":  {Type: typeSQSQueue, Name: "queue", URL: "http://localhost:9324/000000000000/queue", ARN: "arn:aws:sqs:us-east-1:123456789012:queue"},
			"S/Table":  {Type: typeDynamoTable, Name: "table", StreamARN: "arn:aws:dynamodb:us-east-1:123456789012:table/table/stream/1"},
			"S/Bucket": {Type: typeS3Bucket, Name: "bucket"},
			"S/Stream": {Type: typeKinesisStream, Name: "stream", ARN: "arn:aws:kinesis:us-east-1:123456789012:stream/stream"},
		},
		invokers: map[string]*FunctionProcess{},
		tables: map[string]tableInfo{
			"S/Table": {Name: "table", KeySchema: []keySchemaAttribute{{Name: "pk", Type: "S"}}, StreamARN: "arn:aws:dynamodb:us-east-1:123456789012:table/table/stream/1", StreamViewType: "NEW_AND_OLD_IMAGES"},
		},
		localSecrets: map[string]string{"secret": "value"},
	}
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "S", LogicalID: "Queue", Type: typeSQSQueue, Properties: json.RawMessage(`{"QueueName":"queue"}`)},
		{Stack: "S", LogicalID: "Topic", Type: typeSNSTopic, Properties: json.RawMessage(`{"TopicName":"topic"}`)},
		{Stack: "S", LogicalID: "Table", Type: typeDynamoTable, Properties: json.RawMessage(`{"TableName":"table"}`)},
		{Stack: "S", LogicalID: "Bucket", Type: typeS3Bucket, Properties: json.RawMessage(`{"BucketName":"bucket"}`)},
		{Stack: "S", LogicalID: "Stream", Type: typeKinesisStream, Properties: json.RawMessage(`{"Name":"stream"}`)},
		{Stack: "S", LogicalID: "Fn", Type: typeLambdaFunction, Properties: json.RawMessage(`{"FunctionName":"fn"}`)},
	}, Functions: []FunctionSpec{{LogicalID: "Fn", Stack: "S"}}}
	return runner, spec
}

func sessionFor(runner *Runner, spec *Spec) *localSession {
	return &localSession{runner: runner, spec: spec, previous: map[string]map[string]types.AttributeValue{}}
}

func TestSessionLookupErrors(t *testing.T) {
	runner, spec := sessionResources()
	session := sessionFor(runner, spec)
	ctx := context.Background()

	if _, _, _, _, err := session.queue("Topic"); err == nil {
		t.Fatal("a topic is not a queue")
	}
	if _, _, _, _, err := session.queue("S/SQS"); err == nil {
		t.Fatal("an unknown resource must fail")
	}
	if _, _, _, err := session.table("Queue"); err == nil {
		t.Fatal("a queue is not a table")
	}
	if _, err := session.kinesisStream("Queue"); err == nil {
		t.Fatal("a queue is not a stream")
	}

	noValues := sessionFor(&Runner{clock: RealClock{}, tables: runner.tables}, spec)
	if _, _, _, _, err := noValues.queue("Queue"); err == nil {
		t.Fatal("an unprovisioned queue must fail")
	}
	if _, _, _, err := noValues.table("Table"); err == nil {
		t.Fatal("an unprovisioned table must fail")
	}
	noBackend := sessionFor(&Runner{clock: RealClock{}, resourceValues: runner.resourceValues}, spec)
	if _, _, _, _, err := noBackend.queue("Queue"); err == nil {
		t.Fatal("the missing sqs backend must fail")
	}
	if _, _, _, err := noBackend.table("Table"); err == nil {
		t.Fatal("the missing dynamodb backend must fail")
	}
	badURL := sessionFor(&Runner{
		clock:          RealClock{},
		resourceValues: resourceValues{"S/Queue": {Type: typeSQSQueue, Name: "queue", URL: "http://localhost:9324/q"}},
		backends:       map[string]backendProcess{backendSQS: {HostURL: "not-a-url"}},
	}, spec)
	if _, _, _, _, err := badURL.queue("Queue"); err == nil {
		t.Fatal("a relative backend endpoint must fail the queue URL rewrite")
	}

	if _, err := session.s3Put(ctx, sessionRequest{Bucket: "Queue"}); err == nil {
		t.Fatal("a queue is not a bucket")
	}
	if _, err := noValues.s3Put(ctx, sessionRequest{Bucket: "Bucket"}); err == nil {
		t.Fatal("an unprovisioned bucket must fail")
	}
	if _, err := noBackend.s3Put(ctx, sessionRequest{Bucket: "Bucket"}); err == nil {
		t.Fatal("the missing s3 backend must fail")
	}
	s3Runner := &Runner{
		clock:          RealClock{},
		resourceValues: resourceValues{"S/Bucket": {Type: typeS3Bucket, Name: "bucket"}},
		backends:       map[string]backendProcess{"s3": {HostURL: "http://127.0.0.1:1"}},
	}
	if _, err := sessionFor(s3Runner, spec).s3Put(ctx, sessionRequest{Bucket: "Bucket"}); err == nil {
		t.Fatal("s3.put needs an object key")
	}

	if _, err := session.invoke(ctx, sessionRequest{Function: "Fn", Event: json.RawMessage(`{}`)}); err == nil {
		t.Fatal("a function that is not running must fail")
	}
	runner.invokers["Fn"] = &FunctionProcess{}
	if _, err := session.invoke(ctx, sessionRequest{Function: "Fn"}); err == nil {
		t.Fatal("invoke needs a valid event")
	}
	delete(runner.invokers, "Fn")

	if _, err := session.kinesisCloudWatchEvent(sessionRequest{Stream: "Stream"}); err == nil {
		t.Fatal("a session without a log group must fail")
	}
}

func TestSessionDynamoMarshalingErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.0")
		writeTestJSON(t, writer, `{"Item":{"pk":{"S":"a"}}}`)
	}))
	defer server.Close()
	runner, spec := sessionResources()
	runner.backends = map[string]backendProcess{backendDynamoDB: {HostURL: server.URL}}
	session := sessionFor(runner, spec)
	ctx := context.Background()

	if _, err := session.ddbPut(ctx, sessionRequest{Table: "Table", Item: map[string]any{"pk": time.Now()}}); err == nil {
		t.Fatal("an unsupported attribute type must fail the write")
	}
	if _, err := session.ddbPut(ctx, sessionRequest{Table: "Table", Item: map[string]any{"other": "x"}}); err == nil {
		t.Fatal("an item without the key must fail")
	}
	if _, err := session.ddbGet(ctx, sessionRequest{Table: "Table", Key: map[string]any{"pk": time.Now()}}); err == nil {
		t.Fatal("an unsupported key type must fail")
	}
	if _, err := session.ddbGet(ctx, sessionRequest{Table: "Table", Key: map[string]any{"other": "x"}}); err == nil {
		t.Fatal("a key without the partition key must fail")
	}
	if _, err := session.ddbStreamEvent(ctx, sessionRequest{Table: "Table", Key: map[string]any{"pk": time.Now()}}); err == nil {
		t.Fatal("an unsupported stream key type must fail")
	}
	if _, err := session.ddbStreamEvent(ctx, sessionRequest{Table: "Table", Key: map[string]any{"other": "x"}}); err == nil {
		t.Fatal("a stream key without the partition key must fail")
	}
	if _, err := session.ddbStreamEvent(ctx, sessionRequest{Table: "Table", Key: map[string]any{"pk": "a"}, EventName: "REMOVE"}); err == nil {
		t.Fatal("REMOVE without a stored image must fail")
	}

	noStreamRunner, noStreamSpec := sessionResources()
	noStreamRunner.tables["S/Table"] = tableInfo{Name: "table", KeySchema: []keySchemaAttribute{{Name: "pk", Type: "S"}}}
	noStreamRunner.backends = map[string]backendProcess{backendDynamoDB: {HostURL: server.URL}}
	if _, err := sessionFor(noStreamRunner, noStreamSpec).ddbStreamEvent(ctx, sessionRequest{Table: "Table", Key: map[string]any{"pk": "a"}}); err == nil {
		t.Fatal("a table without a stream must fail")
	}

	// A stored previous image and an empty current image resolve to REMOVE.
	key := map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "a"}}
	session.previous[tableKeyString(key)] = map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "a"}}
	emptyServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.0")
		writeTestJSON(t, writer, `{}`)
	}))
	defer emptyServer.Close()
	emptyRunner, emptySpec := sessionResources()
	emptyRunner.backends = map[string]backendProcess{backendDynamoDB: {HostURL: emptyServer.URL, Endpoints: []Endpoint{{Service: backendDynamoDB, URL: emptyServer.URL}}}}
	empty := sessionFor(emptyRunner, emptySpec)
	empty.previous[tableKeyString(key)] = map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "a"}}
	event, err := empty.ddbStreamEvent(ctx, sessionRequest{Table: "Table", Key: map[string]any{"pk": "a"}})
	if err != nil || !strings.Contains(string(event.(json.RawMessage)), `"REMOVE"`) {
		t.Fatalf("the inferred remove event: %v", err)
	}
	itemServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.0")
		writeTestJSON(t, writer, `{"Item":{"pk":{"S":"a"},"value":{"S":"kept"}}}`)
	}))
	defer itemServer.Close()
	itemRunner, itemSpec := sessionResources()
	itemRunner.backends = map[string]backendProcess{backendDynamoDB: {HostURL: itemServer.URL, Endpoints: []Endpoint{{Service: backendDynamoDB, URL: itemServer.URL}}}}
	event, err = sessionFor(itemRunner, itemSpec).ddbStreamEvent(ctx, sessionRequest{Table: "Table", Key: map[string]any{"pk": "a"}, EventName: "MODIFY"})
	if err != nil || !strings.Contains(string(event.(json.RawMessage)), `"OldImage"`) {
		t.Fatalf("the modify event without a previous image: %v", err)
	}
}

func TestSessionDynamoServiceErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.0")
		target := request.Header.Get("X-Amz-Target")
		switch {
		case strings.HasSuffix(target, ".PutItem"), strings.HasSuffix(target, ".Scan"), strings.HasSuffix(target, ".GetItem"):
			writer.WriteHeader(http.StatusInternalServerError)
			writeTestJSON(t, writer, `{"__type":"InternalServerError","message":"boom"}`)
		default:
			writeTestJSON(t, writer, `{}`)
		}
	}))
	defer server.Close()
	runner, spec := sessionResources()
	runner.backends = map[string]backendProcess{backendDynamoDB: {HostURL: server.URL}}
	session := sessionFor(runner, spec)
	ctx := context.Background()

	// ddbPut reads the existing image before writing, so the failing GetItem is
	// the first error; a separate table state lets PutItem fail on its own.
	if _, err := session.ddbPut(ctx, sessionRequest{Table: "Table", Item: map[string]any{"pk": "a"}}); err == nil {
		t.Fatal("the get error must fail ddb.put")
	}
	if _, err := session.ddbGet(ctx, sessionRequest{Table: "Table", Key: map[string]any{"pk": "a"}}); err == nil {
		t.Fatal("the get error must fail ddb.get")
	}
	if _, err := session.ddbScan(ctx, sessionRequest{Table: "Table"}); err == nil {
		t.Fatal("the scan error must fail ddb.scan")
	}
	if _, err := session.ddbStreamEvent(ctx, sessionRequest{Table: "Table", Key: map[string]any{"pk": "a"}}); err == nil {
		t.Fatal("the get error must fail ddb.stream-event")
	}
}

func TestSessionSQSServiceErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.0")
		switch {
		case strings.HasSuffix(request.Header.Get("X-Amz-Target"), ".SendMessage"),
			strings.HasSuffix(request.Header.Get("X-Amz-Target"), ".GetQueueAttributes"),
			strings.HasSuffix(request.Header.Get("X-Amz-Target"), ".DeleteMessage"):
			writer.WriteHeader(http.StatusInternalServerError)
			writeTestJSON(t, writer, `{"__type":"InternalError","message":"boom"}`)
		case strings.HasSuffix(request.Header.Get("X-Amz-Target"), ".ReceiveMessage"):
			writeTestJSON(t, writer, `{"Messages":[{"MessageId":"m1","Body":"one"},{"MessageId":"m2","ReceiptHandle":"r2","Body":"two"}]}`)
		default:
			writeTestJSON(t, writer, `{}`)
		}
	}))
	defer server.Close()
	runner, spec := sessionResources()
	runner.resourceValues["S/Queue"] = resourceValue{Type: typeSQSQueue, Name: "queue", URL: "http://127.0.0.1:9324/000000000000/queue", ARN: "arn:aws:sqs:us-east-1:123456789012:queue"}
	runner.backends = map[string]backendProcess{backendSQS: {HostURL: server.URL}}
	session := sessionFor(runner, spec)
	ctx := context.Background()

	if _, err := session.sqsSend(ctx, sessionRequest{Queue: "Queue", Body: "x"}); err == nil {
		t.Fatal("the send error must fail")
	}
	if _, err := session.sqsAttributes(ctx, sessionRequest{Queue: "Queue"}); err == nil {
		t.Fatal("the attribute error must fail")
	}
	if _, err := session.sqsReceive(ctx, sessionRequest{Queue: "Queue", Delete: true}, false); err == nil {
		t.Fatal("the delete error must fail")
	}
	if _, err := session.sqsReceive(ctx, sessionRequest{Queue: "Queue", Max: 200}, false); err == nil {
		t.Fatal("the receive error must fail")
	}

	if count := queueAttributeCount(map[string]string{"ApproximateNumberOfMessages": "not-a-number"}, "ApproximateNumberOfMessages"); count != 0 {
		t.Fatalf("the unparsable count: %d", count)
	}

	empty := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.0")
		writeTestJSON(t, writer, `{"Messages":[]}`)
	}))
	defer empty.Close()
	messages, err := receiveSQSMessages(ctx, newSQSClient(empty.URL), empty.URL+"/q", 25, 0, -1)
	if err != nil || len(messages) != 0 {
		t.Fatalf("receive over the batch cap: %v %d", err, len(messages))
	}
}

func TestSessionValueConversionCases(t *testing.T) {
	if value, err := marshalItem(map[string]any{"n": nil, "f": 1.5}); err != nil {
		t.Fatalf("nil and float: %v", err)
	} else if len(value) != 2 {
		t.Fatalf("nil and float: %d", len(value))
	}
	if _, err := marshalItem(map[string]any{"l": []any{time.Now()}}); err == nil {
		t.Fatal("an unsupported list item must fail")
	}
	if _, err := marshalItem(map[string]any{"m": map[string]any{"x": time.Now()}}); err == nil {
		t.Fatal("an unsupported nested value must fail")
	}
	if _, err := marshalItem(map[string]any{"x": time.Now()}); err == nil {
		t.Fatal("an unsupported scalar must fail")
	}
	if _, err := unmarshalItem(map[string]types.AttributeValue{"x": nil}); err == nil {
		t.Fatal("an unknown attribute value must fail")
	}
	if _, err := unmarshalItem(map[string]types.AttributeValue{"x": &types.AttributeValueMemberL{Value: []types.AttributeValue{nil}}}); err == nil {
		t.Fatal("an unknown list item must fail")
	}
}

func TestSessionDescribeProviderFields(t *testing.T) {
	runner, spec := sessionResources()
	runner.resourceValues["S/Pool"] = resourceValue{
		Type: typeCognitoUserPool, Name: "pool", ProviderName: "provider", ProviderURL: "http://pool",
		LocalIssuer: "http://issuer", SSMType: "String", KeyID: "key",
	}
	runner.backends = map[string]backendProcess{"skip": {Endpoints: []Endpoint{{Service: "skip"}}}}
	session := sessionFor(runner, spec)
	described, err := session.describe()
	if err != nil {
		t.Fatal(err)
	}
	if len(described["resources"].([]map[string]any)) != 5 {
		t.Fatalf("resources: %+v", described["resources"])
	}
	for _, entry := range described["endpoints"].([]map[string]any) {
		if entry["service"] == "skip" {
			t.Fatal("a backend without a host URL must not be reported")
		}
	}
}

func TestSNSQueueLookupAndDeliveryClient(t *testing.T) {
	runner, _ := sessionResources()
	if _, ok := runner.snsQueueLookup("Missing"); ok {
		t.Fatal("an unknown queue must not resolve")
	}
	if _, ok := runner.snsQueueLookup("S/Table"); ok {
		t.Fatal("a non-queue must not resolve")
	}
	if _, ok := runner.snsQueueLookup("S/Queue"); !ok {
		t.Fatal("a provisioned queue must resolve")
	}
	if _, err := runner.deliverySQSClient(); err == nil {
		t.Fatal("a missing sqs backend must fail")
	}
	runner.backends = map[string]backendProcess{backendSQS: {HostURL: "http://127.0.0.1:9324", Endpoints: []Endpoint{{Service: backendSQS, URL: "http://127.0.0.1:9324"}}}}
	if _, err := runner.deliverySQSClient(); err != nil {
		t.Fatalf("the sqs client: %v", err)
	}
}
