package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	apptheory "github.com/theory-cloud/apptheory/runtime"
	"github.com/theory-cloud/apptheory/testkit"
)

func TestBuildApp_Routes(t *testing.T) {
	t.Setenv("APPTHEORY_TIER", "p0")
	t.Setenv("APPTHEORY_DEMO_NAME", "demo")
	t.Setenv("APPTHEORY_LANG", "go")

	app := buildApp()
	if app == nil {
		t.Fatal("expected app")
	}

	resp := app.Serve(context.Background(), apptheory.Request{Method: "GET", Path: "/"})
	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
	var body map[string]any
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["ok"] != true || body["lang"] != "go" || body["name"] != "demo" || body["tier"] != "p0" {
		t.Fatalf("unexpected body: %v", body)
	}

	resp = app.Serve(context.Background(), apptheory.Request{Method: "GET", Path: "/hello/world"})
	if resp.Status != 200 {
		t.Fatalf("expected status 200, got %d", resp.Status)
	}
	body = map[string]any{}
	if err := json.Unmarshal(resp.Body, &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["message"] != "hello world" {
		t.Fatalf("unexpected message: %v", body["message"])
	}
}

func TestBuildApp_StreamWebSocketAndEvents(t *testing.T) {
	t.Setenv("APPTHEORY_TIER", "p0")
	t.Setenv("APPTHEORY_DEMO_NAME", "demo")
	t.Setenv("APPTHEORY_LANG", "go")
	t.Setenv("APPTHEORY_DEMO_QUEUE_NAME", "queue1")
	t.Setenv("APPTHEORY_DEMO_RULE_NAME", "rule1")
	t.Setenv("APPTHEORY_DEMO_TABLE_NAME", "tbl")

	app := buildApp()
	if app == nil {
		t.Fatal("expected app")
	}

	env := testkit.New()

	stream := env.InvokeStreaming(context.Background(), app, apptheory.Request{Method: "GET", Path: "/sse"})
	if stream.Status != 200 {
		t.Fatalf("expected status 200, got %d", stream.Status)
	}
	if got := stream.Headers["content-type"]; len(got) != 1 || got[0] != "text/event-stream" {
		t.Fatalf("unexpected content-type: %#v", stream.Headers)
	}
	if stream.StreamErrorCode != "" {
		t.Fatalf("unexpected stream error: %q", stream.StreamErrorCode)
	}
	if !strings.Contains(string(stream.Body), `"seq":1`) {
		t.Fatalf("unexpected SSE body: %s", string(stream.Body))
	}

	connect := env.InvokeWebSocket(context.Background(), app, testkit.WebSocketEvent(testkit.WebSocketEventOptions{
		RouteKey:     "$connect",
		ConnectionID: "conn-1",
	}))
	if connect.StatusCode != 200 {
		t.Fatalf("expected connect status 200, got %d", connect.StatusCode)
	}

	disconnect := env.InvokeWebSocket(context.Background(), app, testkit.WebSocketEvent(testkit.WebSocketEventOptions{
		RouteKey:     "$disconnect",
		ConnectionID: "conn-1",
	}))
	if disconnect.StatusCode != 200 {
		t.Fatalf("expected disconnect status 200, got %d", disconnect.StatusCode)
	}

	sqs := env.InvokeSQS(context.Background(), app, testkit.SQSEvent(testkit.SQSEventOptions{
		QueueARN: "arn:aws:sqs:us-east-1:123:queue1",
		Records:  []testkit.SQSMessageOptions{{MessageID: "msg-1"}},
	}))
	if len(sqs.BatchItemFailures) != 0 {
		t.Fatalf("unexpected sqs failures: %#v", sqs.BatchItemFailures)
	}

	out, err := env.InvokeEventBridge(context.Background(), app, testkit.EventBridgeEvent(testkit.EventBridgeEventOptions{
		Resources:  []string{"arn:aws:events:us-east-1:123:rule/rule1"},
		DetailType: "scheduled",
	}))
	if err != nil {
		t.Fatalf("InvokeEventBridge: %v", err)
	}
	got, ok := out.(map[string]any)
	if !ok || got["trigger"] != "eventbridge" {
		t.Fatalf("unexpected eventbridge output: %#v", out)
	}

	ddb := env.InvokeDynamoDBStream(context.Background(), app, testkit.DynamoDBStreamEvent(testkit.DynamoDBStreamEventOptions{
		StreamARN: "arn:aws:dynamodb:us-east-1:123:table/tbl/stream/2020",
		Records:   []testkit.DynamoDBStreamRecordOptions{{EventID: "rec-1"}},
	}))
	if len(ddb.BatchItemFailures) != 0 {
		t.Fatalf("unexpected dynamodb failures: %#v", ddb.BatchItemFailures)
	}
}
