package localrunner

import (
	"bytes"
	"compress/gzip"
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
	"time"
)

func TestCloudWatchFilterPatterns(t *testing.T) {
	cases := []struct {
		pattern string
		message string
		want    bool
	}{
		{"", "anything", true},
		{"ERROR", "an ERROR occurred", true},
		{"ERROR timeout", "an ERROR occurred", false},
		{"ERROR timeout", "ERROR: timeout", true},
		{`"order processed"`, "an order processed line", true},
		{"?ERROR ?WARN", "a WARN line", true},
		{"?ERROR ?WARN", "an INFO line", false},
		{"-health", "health check ok", false},
		{"-health", "order ok", true},
		{`{ $.level = "ERROR" }`, `{"level":"ERROR","message":"x"}`, true},
		{`{ $.level != "ERROR" }`, `{"level":"INFO"}`, true},
		{`{ $.level = "ERROR" && $.code = 500 }`, `{"level":"ERROR","code":500}`, true},
		{`{ ($.level = "ERROR" || $.level = "WARN") && $.code = 500 }`, `{"level":"WARN","code":500}`, true},
		{`{ $.user.id = 7 }`, `{"user":{"id":7}}`, true},
		{`{ $.level = "ERROR" }`, `not json`, false},
	}
	for _, test := range cases {
		if err := validateCloudWatchFilterPattern(test.pattern); err != nil {
			t.Fatalf("pattern %q must validate: %v", test.pattern, err)
		}
		got, err := cloudWatchFilterMatches(test.pattern, test.message)
		if err != nil {
			t.Fatalf("pattern %q: %v", test.pattern, err)
		}
		if got != test.want {
			t.Fatalf("pattern %q on %q = %v, want %v", test.pattern, test.message, got, test.want)
		}
	}
	for _, unsupported := range []string{"%ERROR%", `{ $.items[0] = "x" }`, `{ $.level = "ERROR" && }`, `"unterminated`} {
		if err := validateCloudWatchFilterPattern(unsupported); err == nil {
			t.Fatalf("pattern %q must be refused by name", unsupported)
		}
	}
}

func TestCloudWatchLogsClientProtocol(t *testing.T) {
	var mu sync.Mutex
	var targets []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		target := request.Header.Get("X-Amz-Target")
		mu.Lock()
		targets = append(targets, target)
		mu.Unlock()
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body) //nolint:errcheck // the fake reads the request it expects
		if _, ok := body["logGroupName"]; !ok && target != "Logs_20140328.DescribeLogGroups" {
			t.Errorf("%s request lost lowerCamelCase logGroupName: %+v", target, body)
		}
		writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
		switch target {
		case "Logs_20140328.CreateLogGroup":
			writeTestJSON(t, writer, `{}`)
		case "Logs_20140328.CreateLogStream":
			writeTestJSON(t, writer, `{}`)
		case "Logs_20140328.PutLogEvents":
			events, _ := body["logEvents"].([]any) //nolint:errcheck // the fake response is known JSON
			if len(events) != 2 {
				t.Errorf("PutLogEvents events: %+v", body)
			}
			writeTestJSON(t, writer, `{"nextSequenceToken":"token-2"}`)
		case "Logs_20140328.FilterLogEvents":
			writeTestJSON(t, writer, `{"events":[{"eventId":"1","logStreamName":"s1","timestamp":1767225601000,"message":"hello","ingestionTime":1767225601001}]}`)
		case "Logs_20140328.DescribeLogGroups":
			writeTestJSON(t, writer, `{"logGroups":[{"logGroupName":"/aws/lambda/probe"}]}`)
		default:
			t.Errorf("unexpected target %s", target)
		}
	}))
	defer server.Close()

	client := newCloudWatchLogsClient(server.URL)
	ctx := context.Background()
	if err := client.CreateLogGroup(ctx, "/aws/lambda/probe"); err != nil {
		t.Fatal(err)
	}
	if err := client.CreateLogStream(ctx, "/aws/lambda/probe", "s1"); err != nil {
		t.Fatal(err)
	}
	if err := client.PutLogEvents(ctx, "/aws/lambda/probe", "s1", []cloudWatchLogEvent{
		{Timestamp: 1000, Message: "hello"},
		{Timestamp: 1001, Message: "world"},
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(targets, ","), "Logs_20140328.PutLogEvents") {
		t.Fatalf("targets: %v", targets)
	}
	events, err := client.FilterLogEvents(ctx, "/aws/lambda/probe", 0)
	if err != nil || len(events) != 1 || events[0].Message != "hello" || events[0].EventID != "1" {
		t.Fatalf("FilterLogEvents: %+v %v", events, err)
	}
	exists, err := client.GroupExists(ctx, "/aws/lambda/probe")
	if err != nil || !exists {
		t.Fatalf("GroupExists: %v %v", exists, err)
	}
}

func TestCloudWatchSubscriptionDeliversAwsLogsPayload(t *testing.T) {
	var mu sync.Mutex
	var invoked []map[string]any
	logs := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
		switch request.Header.Get("X-Amz-Target") {
		case "Logs_20140328.CreateLogGroup":
			writeTestJSON(t, writer, `{}`)
		case "Logs_20140328.FilterLogEvents":
			now := time.Now().UnixMilli()
			writeTestJSON(t, writer, fmt.Sprintf(`{"events":[
				{"eventId":"1","logStreamName":"s1","timestamp":%d,"message":"processed order 42"},
				{"eventId":"2","logStreamName":"s1","timestamp":%d,"message":"ignored health check"}
			]}`, now, now+1))
		default:
			writeTestJSON(t, writer, `{}`)
		}
	}))
	defer logs.Close()

	source := DeliverySource{
		ID:   "Filter",
		Kind: DeliveryKindCloudWatchLogs,
		Subscription: &SubscriptionSpec{
			LogicalID:       "Filter",
			Kind:            string(DeliveryKindCloudWatchLogs),
			LogGroup:        "/aws/lambda/producer",
			FilterName:      "orders",
			FilterPattern:   "order",
			DestinationType: "function",
			Function:        "Target",
		},
	}
	deliverer, err := NewCloudWatchLogsDeliverer(source)
	if err != nil {
		t.Fatal(err)
	}
	reporter := &recordingDeliveryReporter{}
	env := DelivererEnv{
		Source: source,
		Clock:  NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
		Backend: DeliveryBackend{Client: &logsLocalBackend{
			logs: newCloudWatchLogsClient(logs.URL),
		}},
		Invoke: func(_ context.Context, event []byte) (InvokeResult, error) {
			var decoded map[string]any
			if decodeErr := json.Unmarshal(event, &decoded); decodeErr != nil {
				return InvokeResult{}, decodeErr
			}
			mu.Lock()
			invoked = append(invoked, decoded)
			mu.Unlock()
			return InvokeResult{}, nil
		},
		State: reporter,
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		_ = deliverer.Start(ctx, env) //nolint:errcheck // the test cancels the deliverer
		close(done)
	}()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		count := len(invoked)
		mu.Unlock()
		if count > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	if len(invoked) != 1 {
		t.Fatalf("invocations %d, want 1: %+v", len(invoked), invoked)
	}
	encoded := invoked[0]["awslogs"].(map[string]any)["data"].(string) //nolint:errcheck // the test built this shape
	compressed, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["messageType"] != "DATA_MESSAGE" || payload["logGroup"] != "/aws/lambda/producer" ||
		payload["logStream"] != "s1" {
		t.Fatalf("payload: %+v", payload)
	}
	filters, _ := payload["subscriptionFilters"].([]any) //nolint:errcheck // the test built this shape
	if len(filters) != 1 || filters[0] != "orders" {
		t.Fatalf("subscription filters: %+v", payload)
	}
	events, _ := payload["logEvents"].([]any) //nolint:errcheck // the test built this shape
	if len(events) != 1 {
		t.Fatalf("filtered log events: %+v", payload)
	}
	if reporter.delivered != 1 || reporter.filtered != 1 {
		t.Fatalf("reporter delivered/filtered: %+v", reporter)
	}
}

func TestLogMessageLine(t *testing.T) {
	if got := logMessageLine("2026-11-04T07:47:31.123456789Z hello world"); got != "hello world" {
		t.Fatalf("line: %q", got)
	}
	if got := logMessageLine("plain line"); got != "plain line" {
		t.Fatalf("plain line: %q", got)
	}
}
