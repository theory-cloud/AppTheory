package localrunner

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// fakeSQSServer is a minimal AWS JSON SQS endpoint for session operation tests.
type fakeSQSServer struct {
	mu       sync.Mutex
	messages []map[string]any
	next     int
}

func (s *fakeSQSServer) handler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read sqs request: %v", err)
			return
		}
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		target := request.Header.Get("X-Amz-Target")
		switch {
		case strings.Contains(target, "SendMessage"):
			s.mu.Lock()
			s.next++
			id := fmt.Sprintf("m-%d", s.next)
			var payload map[string]any
			if err := json.Unmarshal(body, &payload); err != nil {
				t.Errorf("decode send: %v", err)
			}
			s.messages = append(s.messages, map[string]any{
				"MessageId":     id,
				"ReceiptHandle": "rh-" + id,
				"Body":          payload["MessageBody"],
				"Attributes":    map[string]any{"ApproximateReceiveCount": "1"},
			})
			s.mu.Unlock()
			writeTestResponse(t, writer, `{"MessageId":"`+id+`"}`)
		case strings.Contains(target, "ReceiveMessage"):
			s.mu.Lock()
			var out []map[string]any
			if len(s.messages) > 0 {
				out = append(out, s.messages[0])
				s.messages = s.messages[1:]
			}
			s.mu.Unlock()
			encoded, err := json.Marshal(map[string]any{"Messages": out})
			if err != nil {
				t.Errorf("encode messages: %v", err)
				return
			}
			writeTestResponse(t, writer, string(encoded))
		case strings.Contains(target, "DeleteMessage"):
			writeTestResponse(t, writer, `{}`)
		case strings.Contains(target, "GetQueueAttributes"):
			writeTestResponse(t, writer, `{"Attributes":{"ApproximateNumberOfMessages":"1","ApproximateNumberOfMessagesNotVisible":"2","ApproximateNumberOfMessagesDelayed":"0","VisibilityTimeout":"30"}}`)
		default:
			writer.WriteHeader(http.StatusBadRequest)
		}
	})
}

type fakeDynamoServer struct {
	mu    sync.Mutex
	items map[string]map[string]any
}

func (s *fakeDynamoServer) handler(t *testing.T) http.Handler {
	t.Helper()
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read dynamodb request: %v", err)
			return
		}
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Errorf("decode dynamodb request: %v", err)
			return
		}
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		target := request.Header.Get("X-Amz-Target")
		switch {
		case strings.Contains(target, "PutItem"):
			item, ok := payload["Item"].(map[string]any)
			if !ok {
				t.Errorf("dynamodb PutItem has no item object")
				return
			}
			pk, ok := item["pk"].(map[string]any)
			if !ok {
				t.Errorf("dynamodb PutItem item has no pk")
				return
			}
			key := fmt.Sprint(pk["S"])
			s.mu.Lock()
			s.items[key] = item
			s.mu.Unlock()
			writeTestResponse(t, writer, `{}`)
		case strings.Contains(target, "GetItem"):
			keyValue, ok := payload["Key"].(map[string]any)
			if !ok {
				t.Errorf("dynamodb GetItem has no key object")
				return
			}
			pk, ok := keyValue["pk"].(map[string]any)
			if !ok {
				t.Errorf("dynamodb GetItem key has no pk")
				return
			}
			key := fmt.Sprint(pk["S"])
			s.mu.Lock()
			item, found := s.items[key]
			s.mu.Unlock()
			if !found {
				writeTestResponse(t, writer, `{}`)
				return
			}
			encoded, err := json.Marshal(map[string]any{"Item": item})
			if err != nil {
				t.Errorf("encode item: %v", err)
				return
			}
			writeTestResponse(t, writer, string(encoded))
		case strings.Contains(target, "Scan"):
			s.mu.Lock()
			items := make([]map[string]any, 0, len(s.items))
			for _, item := range s.items {
				items = append(items, item)
			}
			s.mu.Unlock()
			encoded, err := json.Marshal(map[string]any{"Items": items, "Count": len(items)})
			if err != nil {
				t.Errorf("encode scan: %v", err)
				return
			}
			writeTestResponse(t, writer, string(encoded))
		default:
			writer.WriteHeader(http.StatusBadRequest)
		}
	})
}

type sessionFixture struct {
	runner  *Runner
	spec    *Spec
	session *localSession
}

func newSessionFixture(t *testing.T) *sessionFixture {
	t.Helper()
	sqs := &fakeSQSServer{}
	sqsServer := httptest.NewServer(sqs.handler(t))
	t.Cleanup(sqsServer.Close)
	dynamo := &fakeDynamoServer{items: map[string]map[string]any{}}
	dynamoServer := httptest.NewServer(dynamo.handler(t))
	t.Cleanup(dynamoServer.Close)
	s3Server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if _, err := io.Copy(io.Discard, request.Body); err != nil {
			t.Errorf("drain body: %v", err)
		}
		writer.Header().Set("ETag", `"etag"`)
		writer.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(s3Server.Close)
	rieServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("content-type", "application/json")
		writeTestResponse(t, writer, `{"statusCode":200,"headers":{"content-type":"application/json"},"body":"{\"ok\":true}"}`)
	}))
	t.Cleanup(rieServer.Close)

	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"sqs": {
				HostURL:   sqsServer.URL,
				Endpoints: []Endpoint{{Service: "sqs", URL: "http://sqs:9324"}},
			},
			"dynamodb": {
				HostURL:   dynamoServer.URL,
				Endpoints: []Endpoint{{Service: "dynamodb", URL: "http://dynamodb-local:8000"}},
			},
			"s3proxy": {
				HostURL:   s3Server.URL,
				Endpoints: []Endpoint{{Service: "s3", URL: "http://s3proxy:80"}},
			},
		},
		resourceValues: resourceValues{
			"Stack/Queue":  {Type: typeSQSQueue, Name: "q", URL: "http://sqs:9324/000000000000/q", ARN: "arn:aws:sqs:us-east-1:123456789012:q"},
			"Stack/Table":  {Type: typeDynamoTable, Name: "t", ARN: "arn:aws:dynamodb:us-east-1:123456789012:table/t", StreamARN: "arn:aws:dynamodb:us-east-1:123456789012:table/t/stream/1"},
			"Stack/Bucket": {Type: typeS3Bucket, Name: "b", ARN: "arn:aws:s3:::b"},
		},
		tables: map[string]tableInfo{
			"Stack/Table": {
				Name:           "t",
				KeySchema:      []keySchemaAttribute{{Name: "pk", Type: "S"}},
				StreamARN:      "arn:aws:dynamodb:us-east-1:123456789012:table/t/stream/1",
				StreamViewType: "NEW_AND_OLD_IMAGES",
			},
		},
		invokers: map[string]*FunctionProcess{
			"Fn": {Function: FunctionSpec{LogicalID: "Fn"}, Container: "c", Port: serverPort(t, rieServer.URL)},
		},
		apiURLs:      map[string]string{"Api": "http://127.0.0.1:1234"},
		localSecrets: map[string]string{"TOKEN": "local-secret"},
	}
	spec := &Spec{
		Functions: []FunctionSpec{{LogicalID: "Fn", Stack: "Stack", Runtime: "nodejs24.x", Handler: "index.handler", Environment: map[string]string{"MODE": "test"}}},
		APIs: []APISpec{{
			Class: APIHTTPV2, LogicalID: "Api", Stage: "$default",
			Routes: []Route{{Class: APIHTTPV2, Method: "GET", Path: "/", RouteKey: "GET /", Function: "Fn"}},
		}},
		Resources: []ResourceSpec{
			{Stack: "Stack", LogicalID: "Queue", Type: typeSQSQueue},
			{Stack: "Stack", LogicalID: "Table", Type: typeDynamoTable},
			{Stack: "Stack", LogicalID: "Bucket", Type: typeS3Bucket},
			{Stack: "Stack", LogicalID: "Stream", Type: typeKinesisStream, Properties: json.RawMessage(`{"Name":"logs"}`)},
			{Stack: "Stack", LogicalID: "LogGroup", Type: "AWS::Logs::LogGroup", Properties: json.RawMessage(`{"LogGroupName":"/aws/test"}`)},
			{Stack: "Stack", LogicalID: "Filter", Type: "AWS::Logs::SubscriptionFilter", Properties: json.RawMessage(`{"FilterName":"test-filter"}`)},
		},
		Rules: []RuleSpec{
			{LogicalID: "Rule", Name: "rule", ARN: "arn:aws:events:us-east-1:123456789012:rule/rule", Schedule: "rate(1 minute)", Targets: []string{"Fn"}, Enabled: true},
			{LogicalID: "Pattern", Name: "pattern", ARN: "arn:aws:events:us-east-1:123456789012:rule/pattern", EventPattern: json.RawMessage(`{"source":["test.source"],"detail-type":["test.changed"]}`), Targets: []string{"Fn"}, Enabled: true},
		},
		EventSources: []EventSourceSpec{{
			LogicalID: "Map", Function: "Fn", Type: "sqs", Source: "Queue", SourceName: "q", Enabled: true,
		}},
	}
	return &sessionFixture{
		runner: runner,
		spec:   spec,
		session: &localSession{
			runner: runner, spec: spec, previous: map[string]map[string]types.AttributeValue{},
		},
	}
}

func TestSessionSQSAttributes(t *testing.T) {
	fixture := newSessionFixture(t)
	result, err := fixture.session.sqsAttributes(context.Background(), sessionRequest{Queue: "Queue"})
	if err != nil {
		t.Fatalf("sqs.attributes: %v", err)
	}
	fields := mustMap(t, result)
	if fields["visible"] != 1 || fields["notVisible"] != 2 || fields["delayed"] != 0 {
		t.Fatalf("unexpected queue counts: %+v", fields)
	}
	attributes, ok := fields["attributes"].(map[string]string)
	if !ok || attributes["VisibilityTimeout"] != "30" {
		t.Fatalf("unexpected queue attributes: %+v", fields["attributes"])
	}
	if _, err := fixture.session.sqsAttributes(context.Background(), sessionRequest{Queue: "Missing"}); err == nil {
		t.Fatal("a queue that is not provisioned must fail closed")
	}
}

func mustRawMap(t *testing.T, value any) map[string]any {
	t.Helper()
	raw, ok := value.(json.RawMessage)
	if !ok {
		t.Fatalf("unexpected raw value type %T", value)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode raw map: %v", err)
	}
	return out
}

func TestSessionDescribeInvokeAndDispatch(t *testing.T) {
	fixture := newSessionFixture(t)
	described, err := fixture.session.describe()
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	functions, ok := described["functions"].([]map[string]any)
	if !ok || len(functions) != 1 {
		t.Fatalf("describe functions: %+v", described["functions"])
	}
	secrets, ok := described["secrets"].(map[string]string)
	if !ok || secrets["TOKEN"] != "local-secret" {
		t.Fatalf("describe secrets: %+v", described["secrets"])
	}
	apis, ok := described["apis"].([]map[string]any)
	if !ok || len(apis) != 1 {
		t.Fatalf("describe apis: %+v", described["apis"])
	}
	result := fixture.session.handle(context.Background(), `{"op":"describe"}`)
	if !result.OK {
		t.Fatalf("dispatch describe: %+v", result)
	}
	shutdown := fixture.session.handle(context.Background(), `{"op":"shutdown"}`)
	if !shutdown.OK || fixture.session.lastOp != "shutdown" {
		t.Fatalf("dispatch shutdown: %+v", shutdown)
	}
	unknown := fixture.session.handle(context.Background(), `{"op":"nope"}`)
	if unknown.OK {
		t.Fatalf("unknown op must fail: %+v", unknown)
	}
	invoked, err := fixture.session.invoke(context.Background(), sessionRequest{
		Function: "Fn", Event: json.RawMessage(`{"ok":true}`),
	})
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	invokeResult, ok := invoked.(InvokeResult)
	if !ok || !invokeResult.Proxy || invokeResult.StatusCode != 200 {
		t.Fatalf("invoke result: %+v", invoked)
	}
}

func TestSessionSQSAndDynamoOperations(t *testing.T) {
	fixture := newSessionFixture(t)
	sent, err := fixture.session.sqsSend(context.Background(), sessionRequest{
		Queue: "Queue", Body: `{"n":1}`,
	})
	if err != nil || mustString(t, mustMap(t, sent)["messageId"]) == "" {
		t.Fatalf("sqs send: %+v %v", sent, err)
	}
	received, err := fixture.session.sqsReceive(context.Background(), sessionRequest{
		Queue: "Queue", Max: 2, Delete: true,
	}, false)
	if err != nil {
		t.Fatalf("sqs receive: %v", err)
	}
	messages, ok := mustMap(t, received)["messages"].([]map[string]any)
	if !ok || len(messages) != 1 {
		t.Fatalf("sqs receive messages: %+v", received)
	}
	if _, sendErr := fixture.session.sqsSend(context.Background(), sessionRequest{Queue: "Queue", Body: "x"}); sendErr != nil {
		t.Fatalf("sqs send again: %v", sendErr)
	}
	event, err := fixture.session.sqsReceive(context.Background(), sessionRequest{
		Queue: "Queue", Max: 1, Delete: true,
	}, true)
	if err != nil {
		t.Fatalf("sqs event: %v", err)
	}
	if len(mustSlice(t, mustRawMap(t, mustMap(t, event)["event"])["Records"])) != 1 {
		t.Fatalf("sqs event records: %+v", event)
	}

	put, err := fixture.session.ddbPut(context.Background(), sessionRequest{
		Table: "Table", Item: map[string]any{"pk": "a", "value": "one"},
	})
	if err != nil {
		t.Fatalf("ddb put: %v", err)
	}
	if mustMap(t, put)["item"] == nil {
		t.Fatalf("ddb put result: %+v", put)
	}
	got, err := fixture.session.ddbGet(context.Background(), sessionRequest{
		Table: "Table", Key: map[string]any{"pk": "a"},
	})
	if err != nil || mustMap(t, got)["item"] == nil {
		t.Fatalf("ddb get: %+v %v", got, err)
	}
	scanned, err := fixture.session.ddbScan(context.Background(), sessionRequest{Table: "Table"})
	items, ok := mustMap(t, scanned)["items"].([]map[string]any)
	if err != nil || !ok || len(items) != 1 {
		t.Fatalf("ddb scan: %+v %v", scanned, err)
	}
	stream, err := fixture.session.ddbStreamEvent(context.Background(), sessionRequest{
		Table: "Table", Key: map[string]any{"pk": "a"}, EventName: "INSERT",
	})
	if err != nil {
		t.Fatalf("ddb stream insert: %v", err)
	}
	if len(mustSlice(t, mustRawMap(t, stream)["Records"])) != 1 {
		t.Fatalf("ddb stream records: %+v", stream)
	}
	if _, err := fixture.session.ddbPut(context.Background(), sessionRequest{
		Table: "Table", Item: map[string]any{"pk": "a", "value": "two"},
	}); err != nil {
		t.Fatalf("ddb put modify: %v", err)
	}
	if _, err := fixture.session.ddbStreamEvent(context.Background(), sessionRequest{
		Table: "Table", Key: map[string]any{"pk": "a"}, EventName: "MODIFY",
	}); err != nil {
		t.Fatalf("ddb stream modify: %v", err)
	}
	if _, err := fixture.session.ddbStreamEvent(context.Background(), sessionRequest{
		Table: "Table", Key: map[string]any{"pk": "a"}, EventName: "REMOVE",
	}); err != nil {
		t.Fatalf("ddb stream remove: %v", err)
	}
}

func TestSessionS3EventBridgeAndKinesisOperations(t *testing.T) {
	fixture := newSessionFixture(t)
	put, err := fixture.session.s3Put(context.Background(), sessionRequest{
		Bucket: "Bucket", ObjectKey: "incoming/a.json", Body: `{"ok":true}`,
	})
	if err != nil || mustString(t, mustMap(t, put)["etag"]) == "" {
		t.Fatalf("s3 put: %+v %v", put, err)
	}
	schedule, err := fixture.session.eventBridgeEvent(sessionRequest{Rule: "Rule"})
	if err != nil {
		t.Fatalf("eventbridge schedule: %v", err)
	}
	if mustString(t, mustRawMap(t, schedule)["detail-type"]) != "Scheduled Event" {
		t.Fatalf("schedule event: %+v", schedule)
	}
	pattern, err := fixture.session.eventBridgeEvent(sessionRequest{Rule: "Pattern", Detail: json.RawMessage(`{"x":1}`)})
	if err != nil {
		t.Fatalf("eventbridge pattern: %v", err)
	}
	if mustString(t, mustRawMap(t, pattern)["source"]) != "test.source" {
		t.Fatalf("pattern event: %+v", pattern)
	}
	data := base64.StdEncoding.EncodeToString([]byte("record"))
	kinesis, err := fixture.session.kinesisEvent(sessionRequest{
		Stream: "Stream", Data: []string{data}, SequenceNumbers: []string{"1"}, PartitionKeys: []string{"p"},
	})
	if err != nil {
		t.Fatalf("kinesis event: %v", err)
	}
	if len(mustSlice(t, mustRawMap(t, kinesis)["Records"])) != 1 {
		t.Fatalf("kinesis records: %+v", kinesis)
	}
	cloudwatch, err := fixture.session.kinesisCloudWatchEvent(sessionRequest{
		Stream: "Stream", LogStream: "s",
		LogEvents: []CloudWatchLogEvent{{ID: "1", Timestamp: 1, Message: "hello"}},
	})
	if err != nil {
		t.Fatalf("kinesis cloudwatch: %v", err)
	}
	if len(mustSlice(t, mustRawMap(t, cloudwatch)["Records"])) != 1 {
		t.Fatalf("kinesis cloudwatch records: %+v", cloudwatch)
	}
}

func TestSessionHelpers(t *testing.T) {
	if stack, id := splitResourceKey("Stack/Id"); stack != "Stack" || id != "Id" {
		t.Fatalf("splitResourceKey: %s %s", stack, id)
	}
	if stack, id := splitResourceKey("Id"); stack != "" || id != "Id" {
		t.Fatalf("splitResourceKey plain: %s %s", stack, id)
	}
	if boundedInt32(-1, 10) != 0 || boundedInt32(99, 10) != 10 || boundedInt32(5, 10) != 5 {
		t.Fatalf("boundedInt32 bounds failed")
	}
	fixture := newSessionFixture(t)
	if _, err := fixture.session.findFunction("Missing"); err == nil {
		t.Fatal("findFunction must fail for an unknown id")
	}
	if _, _, err := fixture.session.findResource("Missing"); err == nil {
		t.Fatal("findResource must fail for an unknown id")
	}
	if _, err := fixture.session.findRule("Missing"); err == nil {
		t.Fatal("findRule must fail for an unknown id")
	}
	if _, err := fixture.session.findFunction("Stack/Fn"); err != nil {
		t.Fatalf("qualified function lookup: %v", err)
	}
	if _, _, err := fixture.session.findResource("Stack/Queue"); err != nil {
		t.Fatalf("qualified resource lookup: %v", err)
	}
	if _, _, _, _, err := fixture.session.queue("Missing"); err == nil {
		t.Fatal("queue lookup must fail for a missing resource")
	}
	if _, _, _, err := fixture.session.table("Missing"); err == nil {
		t.Fatal("table lookup must fail for a missing resource")
	}
	if result := fixture.session.handle(context.Background(), `not-json`); result.OK {
		t.Fatalf("invalid JSON must fail: %+v", result)
	}
	fixture.session.runner.logShutdown()
}
