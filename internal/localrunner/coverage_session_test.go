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

func TestSessionDataAndQueueOperations(t *testing.T) {
	ddbServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.0")
		switch {
		case strings.HasSuffix(request.Header.Get("X-Amz-Target"), ".GetItem"):
			writeTestJSON(t, writer, `{"Item":{"pk":{"S":"a"},"value":{"S":"stored"}}}`)
		case strings.HasSuffix(request.Header.Get("X-Amz-Target"), ".PutItem"):
			writeTestJSON(t, writer, `{}`)
		case strings.HasSuffix(request.Header.Get("X-Amz-Target"), ".Scan"):
			writeTestJSON(t, writer, `{"Items":[{"pk":{"S":"a"}}],"Count":1}`)
		default:
			writeTestJSON(t, writer, `{}`)
		}
	}))
	defer ddbServer.Close()
	fake := newFakeSQS(t)
	queue := fake.queue("queue", nil)
	fake.seed(queue, "hello", nil)

	runner := &Runner{
		clock: RealClock{},
		resourceValues: resourceValues{
			"S/Table": {Type: typeDynamoTable, Name: "table", StreamARN: "arn:aws:dynamodb:us-east-1:123456789012:table/table/stream/1"},
			"S/Queue": {Type: typeSQSQueue, Name: "queue", URL: "http://localhost:9324/000000000000/queue", ARN: "arn:aws:sqs:us-east-1:123456789012:queue"},
		},
		tables: map[string]tableInfo{
			"S/Table": {Name: "table", KeySchema: []keySchemaAttribute{{Name: "pk", Type: "S"}}, StreamARN: "arn:aws:dynamodb:us-east-1:123456789012:table/table/stream/1", StreamViewType: "NEW_AND_OLD_IMAGES"},
		},
		backends: map[string]backendProcess{
			backendDynamoDB: {HostURL: ddbServer.URL, Endpoints: []Endpoint{{Service: backendDynamoDB, URL: ddbServer.URL}}},
			backendSQS:      {HostURL: fake.server.URL, Endpoints: []Endpoint{{Service: backendSQS, URL: fake.server.URL}}},
		},
		localSecrets: map[string]string{"secret": "value"},
	}
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "S", LogicalID: "Table", Type: typeDynamoTable, Properties: json.RawMessage(`{"TableName":"table"}`)},
		{Stack: "S", LogicalID: "Queue", Type: typeSQSQueue, Properties: json.RawMessage(`{"QueueName":"queue"}`)},
	}}
	session := &localSession{runner: runner, spec: spec, previous: map[string]map[string]types.AttributeValue{}}
	if _, err := session.execute(context.Background(), sessionRequest{Op: "ddb.put", Table: "S/Table", Item: map[string]any{"pk": "a", "value": "stored"}}); err != nil {
		t.Fatalf("ddb.put: %v", err)
	}
	if result, err := session.execute(context.Background(), sessionRequest{Op: "ddb.get", Table: "S/Table", Key: map[string]any{"pk": "a"}}); err != nil || result == nil {
		t.Fatalf("ddb.get: %v", err)
	}
	if result, err := session.execute(context.Background(), sessionRequest{Op: "ddb.scan", Table: "S/Table"}); err != nil || result == nil {
		t.Fatalf("ddb.scan: %v", err)
	}
	if result, err := session.execute(context.Background(), sessionRequest{Op: "ddb.stream-event", Table: "S/Table", Key: map[string]any{"pk": "a"}, EventName: "INSERT"}); err != nil || result == nil {
		t.Fatalf("ddb.stream-event: %v", err)
	}
	if _, err := session.execute(context.Background(), sessionRequest{Op: "sqs.send", Queue: "S/Queue", Body: "message"}); err != nil {
		t.Fatalf("sqs.send: %v", err)
	}
	if result, err := session.execute(context.Background(), sessionRequest{Op: "sqs.receive", Queue: "S/Queue", Max: 1, WaitSeconds: 1, Delete: true}); err != nil || result == nil {
		t.Fatalf("sqs.receive: %v", err)
	}
	if result, err := session.execute(context.Background(), sessionRequest{Op: "sqs.attributes", Queue: "S/Queue"}); err != nil || result == nil {
		t.Fatalf("sqs.attributes: %v", err)
	}
	described, err := session.describe()
	if err != nil {
		t.Fatal(err)
	}
	if len(described["resources"].([]map[string]any)) != 2 {
		t.Fatalf("describe resources: %+v", described["resources"])
	}
	if len(described["secrets"].(map[string]string)) != 1 {
		t.Fatalf("describe secrets: %+v", described["secrets"])
	}
}

func TestCloudWatchSubscriptionStartAndPayload(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
		switch request.Header.Get("X-Amz-Target") {
		case "Logs_20140328.CreateLogGroup":
			writeTestJSON(t, writer, `{}`)
		case "Logs_20140328.FilterLogEvents":
			now := time.Now().UnixMilli()
			writeTestJSON(t, writer, `{"events":[{"eventId":"1","logStreamName":"s1","timestamp":`+jsonNumber(now)+`,"message":"order 42"}]}`)
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
	reporter := &recordingDeliveryReporter{}
	observed := make(chan []byte, 2)
	env := DelivererEnv{
		Source:  source,
		Clock:   NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
		Backend: DeliveryBackend{Client: &logsLocalBackend{logs: newCloudWatchLogsClient(server.URL)}},
		Invoke: func(_ context.Context, event []byte) (InvokeResult, error) {
			observed <- event
			return InvokeResult{}, nil
		},
		State: reporter,
		Logf:  func(string, ...any) {},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_ = deliverer.Start(ctx, env)
		close(done)
	}()
	select {
	case event := <-observed:
		if !strings.Contains(string(event), "awslogs") {
			t.Fatalf("payload: %s", event)
		}
	case <-time.After(5 * time.Second):
		cancel()
		<-done
		t.Fatal("the subscription never delivered")
	}
	cancel()
	<-done
	if reporter.delivered == 0 {
		t.Fatalf("reporter: %+v", reporter)
	}
}

func TestProvisionCreateTableInputAndNames(t *testing.T) {
	input := createTableInput("table", dynamoTableProperties{
		BillingMode: "PROVISIONED",
		KeySchema:   []dynamoKeySchemaElement{{AttributeName: "pk", KeyType: "HASH"}},
		AttributeDefinitions: []dynamoAttributeDefinition{
			{AttributeName: "pk", AttributeType: "S"},
		},
		ProvisionedThroughput: dynamoProvisionedThroughput{ReadCapacityUnits: 1, WriteCapacityUnits: 1},
		GlobalSecondaryIndexes: []dynamoGlobalSecondaryIndex{{
			IndexName:             "gsi",
			KeySchema:             []dynamoKeySchemaElement{{AttributeName: "pk", KeyType: "HASH"}},
			Projection:            dynamoProjection{ProjectionType: "ALL"},
			ProvisionedThroughput: dynamoProvisionedThroughput{ReadCapacityUnits: 1, WriteCapacityUnits: 1},
		}},
		StreamSpecification: dynamoStreamSpecification{StreamEnabled: true, StreamViewType: "NEW_IMAGE"},
	})
	if input.BillingMode != types.BillingModeProvisioned || len(input.GlobalSecondaryIndexes) != 1 ||
		input.StreamSpecification == nil || input.ProvisionedThroughput == nil {
		t.Fatalf("table input: %+v", input)
	}
	if _, ok := attributeType([]dynamoAttributeDefinition{{AttributeName: "pk", AttributeType: "S"}}, "missing"); ok {
		t.Fatal("missing attribute")
	}
	if got := maxInt64(0, 5); got != 5 {
		t.Fatalf("maxInt64: %d", got)
	}
	if got := localSourceARN(backendDynamoDB, "t"); !strings.Contains(got, "/stream/local") {
		t.Fatalf("source ARN: %q", got)
	}
	if got := eventSourceBatchSize(backendSQS, 0); got != 10 {
		t.Fatalf("sqs default: %d", got)
	}
	if got := eventSourceBatchSize(backendKinesis, 0); got != 100 {
		t.Fatalf("stream default: %d", got)
	}
}
