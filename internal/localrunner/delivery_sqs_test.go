package localrunner

import (
	"context"
	"crypto/md5" //nolint:gosec // SQS's MD5OfBody is not a security hash
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

// fakeSQS models the pinned ElasticMQ responses the deliverer depends on, as
// observed against softwaremill/elasticmq-native@sha256:e4580ab9:
//   - GetQueueUrl answers with the container's localhost address;
//   - a named GetQueueAttributes subset answers with an empty map, while All
//     carries every attribute;
//   - a receipt handle is rotated on every receive and the previous handle is
//     rejected by DeleteMessageBatch and ChangeMessageVisibility;
//   - maxReceiveCount moves a message to the dead-letter queue when the next
//     receive would exceed it, carrying ApproximateReceiveCount one higher;
//   - FIFO messages are returned in per-group order and a group is blocked
//     while an earlier message of that group is in flight;
//   - FIFO SequenceNumber values are small decimal strings.
type fakeSQS struct {
	mu     sync.Mutex
	queues map[string]*fakeSQSQueue
	server *httptest.Server
}

type fakeSQSQueue struct {
	name            string
	fifo            bool
	visibility      time.Duration
	maxReceiveCount int
	dlq             *fakeSQSQueue
	messages        []*fakeSQSMessage
	sequence        int
}

type fakeSQSMessage struct {
	id                string
	body              string
	group             string
	deduplicationID   string
	sequence          string
	receipt           string
	receiveCount      int
	visibleAt         time.Time
	deleted           bool
	sentAt            time.Time
	messageAttributes map[string]string
}

func newFakeSQS(t *testing.T) *fakeSQS {
	t.Helper()
	fake := &fakeSQS{queues: map[string]*fakeSQSQueue{}}
	fake.server = httptest.NewServer(http.HandlerFunc(fake.handle))
	t.Cleanup(fake.server.Close)
	return fake
}

func (f *fakeSQS) queue(name string, configure func(*fakeSQSQueue)) *fakeSQSQueue {
	f.mu.Lock()
	defer f.mu.Unlock()
	queue := &fakeSQSQueue{name: name, visibility: 30 * time.Second}
	if configure != nil {
		configure(queue)
	}
	f.queues[name] = queue
	return queue
}

func (f *fakeSQS) seed(queue *fakeSQSQueue, body string, attributes map[string]string) *fakeSQSMessage {
	f.mu.Lock()
	defer f.mu.Unlock()
	message := &fakeSQSMessage{
		id:                fmt.Sprintf("msg-%d", len(queue.messages)+1),
		body:              body,
		sentAt:            time.Now(),
		messageAttributes: attributes,
	}
	if queue.fifo {
		message.sequence = fmt.Sprintf("%d", queue.sequence)
		queue.sequence++
		if group := attributes["group"]; group != "" {
			message.group = group
		}
		message.deduplicationID = fmt.Sprintf("dedup-%d", queue.sequence)
	}
	queue.messages = append(queue.messages, message)
	return message
}

func (f *fakeSQS) messageCount(queue *fakeSQSQueue) (visible, notVisible, deleted int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := time.Now()
	for _, message := range queue.messages {
		switch {
		case message.deleted:
			deleted++
		case message.visibleAt.After(now):
			notVisible++
		default:
			visible++
		}
	}
	return visible, notVisible, deleted
}

func (f *fakeSQS) handle(writer http.ResponseWriter, request *http.Request) {
	target := strings.TrimPrefix(request.Header.Get("X-Amz-Target"), "AmazonSQS.")
	body := map[string]any{}
	if request.Body != nil {
		decoder := json.NewDecoder(request.Body)
		decoder.UseNumber()
		if err := decoder.Decode(&body); err != nil {
			fail(writer, "InvalidRequest", "decode request: "+err.Error())
			return
		}
	}
	writer.Header().Set("Content-Type", "application/x-amz-json-1.0")
	f.mu.Lock()
	defer f.mu.Unlock()
	switch target {
	case "GetQueueUrl":
		name := stringField(body, "QueueName")
		if _, ok := f.queues[name]; !ok {
			fail(writer, "QueueDoesNotExist", "queue "+name+" does not exist")
			return
		}
		writeJSON(writer, map[string]any{"QueueUrl": "http://localhost:9324/000000000000/" + name})
	case "GetQueueAttributes":
		queue := f.queueForURL(stringField(body, "QueueUrl"))
		if queue == nil {
			fail(writer, "QueueDoesNotExist", "queue does not exist")
			return
		}
		writeJSON(writer, map[string]any{"Attributes": queue.attributes(time.Now())})
	case "ReceiveMessage":
		queue := f.queueForURL(stringField(body, "QueueUrl"))
		if queue == nil {
			fail(writer, "QueueDoesNotExist", "queue does not exist")
			return
		}
		max := intField(body, "MaxNumberOfMessages")
		if max <= 0 {
			max = 1
		}
		visibility := queue.visibility
		if value, ok := body["VisibilityTimeout"]; ok {
			visibility = time.Duration(intValue(value)) * time.Second
		}
		messages := queue.receive(max, visibility, time.Now())
		writeJSON(writer, map[string]any{"Messages": messages})
	case "ChangeMessageVisibility":
		queue := f.queueForURL(stringField(body, "QueueUrl"))
		if queue == nil {
			fail(writer, "QueueDoesNotExist", "queue does not exist")
			return
		}
		handle := stringField(body, "ReceiptHandle")
		message, ok := queue.byReceipt(handle)
		if !ok {
			fail(writer, "ReceiptHandleIsInvalid", "The receipt handle is not valid")
			return
		}
		message.visibleAt = time.Now().Add(time.Duration(intField(body, "VisibilityTimeout")) * time.Second)
		writeJSON(writer, map[string]any{})
	case "DeleteMessageBatch":
		queue := f.queueForURL(stringField(body, "QueueUrl"))
		if queue == nil {
			fail(writer, "QueueDoesNotExist", "queue does not exist")
			return
		}
		var successful, failed []map[string]any
		entries, ok := body["Entries"].([]any)
		if !ok {
			fail(writer, "InvalidRequest", "Entries is not a list")
			return
		}
		for _, raw := range entries {
			entry, ok := raw.(map[string]any)
			if !ok {
				fail(writer, "InvalidRequest", "an Entry is not an object")
				return
			}
			id := stringField(entry, "Id")
			message, ok := queue.byReceipt(stringField(entry, "ReceiptHandle"))
			if !ok {
				failed = append(failed, map[string]any{
					"Id": id, "SenderFault": true, "Code": "ReceiptHandleIsInvalid",
				})
				continue
			}
			message.deleted = true
			successful = append(successful, map[string]any{"Id": id})
		}
		writeJSON(writer, map[string]any{"Successful": successful, "Failed": failed})
	default:
		fail(writer, "InvalidAction", "unsupported fake action "+target)
	}
}

func (f *fakeSQS) queueForURL(queueURL string) *fakeSQSQueue {
	parsed, err := url.Parse(queueURL)
	if err != nil {
		return nil
	}
	return f.queues[path.Base(parsed.Path)]
}

func (q *fakeSQSQueue) attributes(now time.Time) map[string]string {
	visible, notVisible := 0, 0
	for _, message := range q.messages {
		if message.deleted {
			continue
		}
		if message.visibleAt.After(now) {
			notVisible++
		} else {
			visible++
		}
	}
	attributes := map[string]string{
		"ApproximateNumberOfMessages":           fmt.Sprintf("%d", visible),
		"ApproximateNumberOfMessagesNotVisible": fmt.Sprintf("%d", notVisible),
		"ApproximateNumberOfMessagesDelayed":    "0",
		"VisibilityTimeout":                     fmt.Sprintf("%d", int(q.visibility.Seconds())),
		"QueueArn":                              "arn:aws:sqs:elasticmq:000000000000:" + q.name,
	}
	if q.fifo {
		attributes["FifoQueue"] = "true"
	}
	if q.maxReceiveCount > 0 && q.dlq != nil {
		attributes["RedrivePolicy"] = fmt.Sprintf(
			`{"deadLetterTargetArn":"arn:aws:sqs:elasticmq:000000000000:%s","maxReceiveCount":%d}`,
			q.dlq.name,
			q.maxReceiveCount,
		)
	}
	return attributes
}

func (q *fakeSQSQueue) receive(max int, visibility time.Duration, now time.Time) []map[string]any {
	var received []*fakeSQSMessage
	blocked := map[string]bool{}
	for _, message := range q.messages {
		if len(received) >= max {
			break
		}
		if message.deleted {
			continue
		}
		if q.fifo && blocked[message.group] {
			continue
		}
		if q.maxReceiveCount > 0 && q.dlq != nil && message.receiveCount >= q.maxReceiveCount {
			moved := *message
			moved.deleted = false
			moved.receipt = ""
			moved.visibleAt = time.Time{}
			moved.receiveCount = message.receiveCount + 1
			message.deleted = true
			q.dlq.messages = append(q.dlq.messages, &moved)
			continue
		}
		if message.visibleAt.After(now) {
			if q.fifo {
				blocked[message.group] = true
			}
			continue
		}
		message.receiveCount++
		message.receipt = fmt.Sprintf("%s#%d", message.id, message.receiveCount)
		message.visibleAt = now.Add(visibility)
		received = append(received, message)
	}
	output := make([]map[string]any, 0, len(received))
	for _, message := range received {
		attributes := map[string]string{
			"ApproximateReceiveCount":          fmt.Sprintf("%d", message.receiveCount),
			"SentTimestamp":                    fmt.Sprintf("%d", message.sentAt.UnixMilli()),
			"SenderId":                         "dummy",
			"ApproximateFirstReceiveTimestamp": fmt.Sprintf("%d", message.sentAt.UnixMilli()),
		}
		if q.fifo {
			attributes["MessageGroupId"] = message.group
			attributes["MessageDeduplicationId"] = message.deduplicationID
			attributes["SequenceNumber"] = message.sequence
		}
		output = append(output, map[string]any{
			"MessageId":         message.id,
			"ReceiptHandle":     message.receipt,
			"Body":              message.body,
			"MD5OfBody":         md5Of(message.body),
			"Attributes":        attributes,
			"MessageAttributes": messageAttributes(message.messageAttributes),
		})
	}
	return output
}

func (q *fakeSQSQueue) byReceipt(handle string) (*fakeSQSMessage, bool) {
	for _, message := range q.messages {
		if !message.deleted && message.receipt != "" && message.receipt == handle {
			return message, true
		}
	}
	return nil, false
}

func messageAttributes(values map[string]string) map[string]any {
	output := map[string]any{}
	for name, value := range values {
		if name == "group" {
			continue
		}
		output[name] = map[string]any{"StringValue": value, "DataType": "String"}
	}
	return output
}

func md5Of(value string) string {
	sum := md5.Sum([]byte(value)) //nolint:gosec // matches the SQS MD5OfBody field
	return hex.EncodeToString(sum[:])
}

func writeJSON(writer http.ResponseWriter, value any) {
	writer.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(writer).Encode(value); err != nil {
		http.Error(writer, err.Error(), http.StatusInternalServerError)
	}
}

func fail(writer http.ResponseWriter, code, message string) {
	writer.Header().Set("X-Amzn-Errortype", code)
	writer.WriteHeader(http.StatusBadRequest)
	//nolint:errcheck // the fake response is best-effort once the status is written
	_ = json.NewEncoder(writer).Encode(map[string]any{"__type": code, "message": message})
}

func stringField(body map[string]any, name string) string {
	value, ok := body[name].(string)
	if !ok {
		return ""
	}
	return value
}

func intField(body map[string]any, name string) int {
	return intValue(body[name])
}

func intValue(value any) int {
	switch typed := value.(type) {
	case json.Number:
		number, err := typed.Int64()
		if err != nil {
			return 0
		}
		return int(number)
	case float64:
		return int(typed)
	case int:
		return typed
	default:
		return 0
	}
}

type deliveredEvent struct {
	function string
	event    []byte
}

func sqsMessageForTest(id, body string, attributes map[string]string) sqstypes.Message {
	return sqstypes.Message{
		MessageId:     aws.String(id),
		Body:          aws.String(body),
		ReceiptHandle: aws.String(id + "#1"),
		Attributes:    attributes,
	}
}

func waitForCondition(t *testing.T, condition func() bool, message string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal(message)
}

func startSQSDelivery(t *testing.T, fake *fakeSQS, clock Clock, concurrency int, sources []EventSourceSpec, invoker func(context.Context, string, []byte) (InvokeResult, error)) *DeliveryEngine {
	t.Helper()
	resolver := func(kind DeliveryKind) (DeliveryBackend, error) {
		if kind != DeliveryKindSQS {
			t.Fatalf("unexpected delivery kind %s", kind)
		}
		return DeliveryBackend{
			Service:  backendSQS,
			Endpoint: fake.server.URL,
			Client:   newSQSClient(fake.server.URL),
		}, nil
	}
	engine := NewDeliveryEngine(clock, concurrency, resolver, invoker, nil)
	engine.RegisterDeliverer(DeliveryKindSQS, NewSQSDeliverer)
	spec := &Spec{EventSources: sources}
	if err := engine.Start(context.Background(), spec); err != nil {
		t.Fatalf("start delivery: %v", err)
	}
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := engine.Stop(stopCtx); err != nil {
			t.Errorf("stop delivery: %v", err)
		}
	})
	return engine
}

func waitForSource(t *testing.T, engine *DeliveryEngine, id string, predicate func(DeliveryState) bool) DeliveryState {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, state := range engine.State().Sources {
			if state.ID == id && predicate(state) {
				return state
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("source %s never reached the expected state: %+v", id, engine.State().Sources)
	return DeliveryState{}
}

func sqsSource(logicalID, queueName string) EventSourceSpec {
	return EventSourceSpec{
		LogicalID:               logicalID,
		Stack:                   "Stack",
		Function:                "Stack/Worker",
		Type:                    backendSQS,
		Source:                  "Stack/" + queueName,
		SourceName:              queueName,
		SourceARN:               "arn:aws:sqs:us-east-1:123456789012:" + queueName,
		BatchSize:               10,
		ReportBatchItemFailures: true,
		Enabled:                 true,
	}
}

func TestSQSDelivererDeletesASuccessfulBatchAndReportsPolling(t *testing.T) {
	fake := newFakeSQS(t)
	queue := fake.queue("events", nil)
	fake.seed(queue, `{"n":1}`, nil)
	fake.seed(queue, `{"n":2}`, nil)
	clock := NewTestClock(DefaultTestClockStart)
	events := make(chan deliveredEvent, 4)
	engine := startSQSDelivery(t, fake, clock, 2, []EventSourceSpec{sqsSource("Mapping", "events")},
		func(_ context.Context, function string, event []byte) (InvokeResult, error) {
			events <- deliveredEvent{function: function, event: event}
			return InvokeResult{Raw: json.RawMessage(`{"batchItemFailures":[]}`)}, nil
		})
	state := waitForSource(t, engine, "Mapping", func(state DeliveryState) bool { return state.Delivered == 1 })
	if state.State != DeliveryPhasePolling || state.Failed != 0 {
		t.Fatalf("unexpected delivery state: %+v", state)
	}
	delivered := <-events
	var event map[string]any
	if err := json.Unmarshal(delivered.event, &event); err != nil {
		t.Fatalf("decode event: %v", err)
	}
	records, ok := event["Records"].([]any)
	if !ok || len(records) != 2 {
		t.Fatalf("want a two-record batch, got %s", delivered.event)
	}
	visible, notVisible, deleted := fake.messageCount(queue)
	if deleted != 2 || visible != 0 || notVisible != 0 {
		t.Fatalf("a successful batch must delete every record: visible=%d notVisible=%d deleted=%d", visible, notVisible, deleted)
	}
}

func TestSQSDelivererLeavesAFailedBatchAndRedeliversOnTheTestClock(t *testing.T) {
	fake := newFakeSQS(t)
	queue := fake.queue("events", func(queue *fakeSQSQueue) { queue.visibility = 300 * time.Second })
	fake.seed(queue, `{"n":1}`, nil)
	clock := NewTestClock(DefaultTestClockStart)
	var invocations atomic.Int32
	engine := startSQSDelivery(t, fake, clock, 1, []EventSourceSpec{sqsSource("Mapping", "events")},
		func(context.Context, string, []byte) (InvokeResult, error) {
			invocations.Add(1)
			return InvokeResult{}, fmt.Errorf("handler exploded")
		})
	state := waitForSource(t, engine, "Mapping", func(state DeliveryState) bool { return state.Failed == 1 })
	if state.State != DeliveryPhaseFailed || state.LastError != "handler exploded" {
		t.Fatalf("an invocation failure must report failed with its error: %+v", state)
	}
	if state.Left != 1 {
		t.Fatalf("an invocation failure must count the record it left, got left=%d", state.Left)
	}
	visible, notVisible, deleted := fake.messageCount(queue)
	if visible != 0 || notVisible != 1 || deleted != 0 {
		t.Fatalf("a failed batch must leave its messages: visible=%d notVisible=%d deleted=%d", visible, notVisible, deleted)
	}
	if _, err := clock.Advance(300 * time.Second); err != nil {
		t.Fatalf("advance clock: %v", err)
	}
	waitForSource(t, engine, "Mapping", func(state DeliveryState) bool { return state.Failed == 2 })
	if invocations.Load() != 2 {
		t.Fatalf("want a second invocation after the visibility timeout, got %d", invocations.Load())
	}
}

func TestSQSDelivererPartialBatchFailureLeavesOnlyTheReportedRecord(t *testing.T) {
	fake := newFakeSQS(t)
	queue := fake.queue("events", func(queue *fakeSQSQueue) { queue.visibility = 300 * time.Second })
	first := fake.seed(queue, `{"id":"first"}`, nil)
	second := fake.seed(queue, `{"id":"second"}`, nil)
	third := fake.seed(queue, `{"id":"third"}`, nil)
	clock := NewTestClock(DefaultTestClockStart)
	var invoked atomic.Int32
	engine := startSQSDelivery(t, fake, clock, 1, []EventSourceSpec{sqsSource("Mapping", "events")},
		func(context.Context, string, []byte) (InvokeResult, error) {
			invoked.Add(1)
			return InvokeResult{Raw: json.RawMessage(`{"batchItemFailures":[{"itemIdentifier":"` + second.id + `"}]}`)}, nil
		})
	state := waitForSource(t, engine, "Mapping", func(state DeliveryState) bool { return state.Delivered == 1 })
	if state.Left != 1 {
		t.Fatalf("a partial batch failure must count one left record, got %d", state.Left)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if !first.deleted || second.deleted || !third.deleted {
		t.Fatalf("partial failure must leave only %s: first=%t second=%t third=%t", second.id, first.deleted, second.deleted, third.deleted)
	}
	if second.receiveCount != 1 {
		t.Fatalf("the failed record must stay received once, got %d", second.receiveCount)
	}
}

func TestSQSDelivererMalformedPartialFailureFailsTheWholeBatch(t *testing.T) {
	cases := map[string]string{
		"unknown identifier": `{"batchItemFailures":[{"itemIdentifier":"not-in-batch"}]}`,
		"empty identifier":   `{"batchItemFailures":[{"itemIdentifier":""}]}`,
		"bad key name":       `{"batchItemFailures":[{"messageId":"msg-1"}]}`,
		"not an object":      `{"batchItemFailures":["msg-1"]}`,
		"invalid json":       `{`,
	}
	for name, response := range cases {
		t.Run(name, func(t *testing.T) {
			fake := newFakeSQS(t)
			queue := fake.queue("events", func(queue *fakeSQSQueue) { queue.visibility = 300 * time.Second })
			fake.seed(queue, `{"n":1}`, nil)
			clock := NewTestClock(DefaultTestClockStart)
			engine := startSQSDelivery(t, fake, clock, 1, []EventSourceSpec{sqsSource("Mapping", "events")},
				func(context.Context, string, []byte) (InvokeResult, error) {
					return InvokeResult{Raw: json.RawMessage(response)}, nil
				})
			state := waitForSource(t, engine, "Mapping", func(state DeliveryState) bool { return state.Failed == 1 })
			if state.State != DeliveryPhaseFailed || state.LastError == "" {
				t.Fatalf("a malformed response must fail the batch: %+v", state)
			}
			if _, _, deleted := fake.messageCount(queue); deleted != 0 {
				t.Fatalf("a malformed response must delete nothing, deleted=%d", deleted)
			}
		})
	}
}

func TestSQSDelivererDeletesMessagesThatMatchNoFilter(t *testing.T) {
	fake := newFakeSQS(t)
	queue := fake.queue("events", nil)
	fake.seed(queue, `{"kind":"keep","n":1}`, nil)
	fake.seed(queue, `{"kind":"drop","n":2}`, nil)
	fake.seed(queue, `{"kind":"keep","n":3}`, nil)
	mapping := sqsSource("Mapping", "events")
	mapping.FilterCriteria = json.RawMessage(`{"Filters":[{"Pattern":"{\"body\":{\"kind\":[\"keep\"]}}"}]}`)
	clock := NewTestClock(DefaultTestClockStart)
	events := make(chan []byte, 4)
	engine := startSQSDelivery(t, fake, clock, 1, []EventSourceSpec{mapping},
		func(_ context.Context, _ string, event []byte) (InvokeResult, error) {
			events <- event
			return InvokeResult{Raw: json.RawMessage(`{"batchItemFailures":[]}`)}, nil
		})
	waitForSource(t, engine, "Mapping", func(state DeliveryState) bool { return state.Delivered == 1 })
	event := <-events
	var decoded struct {
		Records []struct {
			Body string `json:"body"`
		} `json:"Records"`
	}
	if err := json.Unmarshal(event, &decoded); err != nil {
		t.Fatalf("decode event: %v", err)
	}
	if len(decoded.Records) != 2 {
		t.Fatalf("want the two matching records, got %s", event)
	}
	for _, record := range decoded.Records {
		if !strings.Contains(record.Body, `"keep"`) {
			t.Fatalf("a non-matching record reached the handler: %s", record.Body)
		}
	}
	visible, notVisible, deleted := fake.messageCount(queue)
	if deleted != 3 || visible != 0 || notVisible != 0 {
		t.Fatalf("non-matching messages must be deleted without invocation: visible=%d notVisible=%d deleted=%d", visible, notVisible, deleted)
	}
}

func TestSQSDelivererFIFOProtectsAFailedGroupAndItsOrder(t *testing.T) {
	fake := newFakeSQS(t)
	queue := fake.queue("events.fifo", func(queue *fakeSQSQueue) {
		queue.fifo = true
		queue.visibility = 300 * time.Second
	})
	group := map[string]string{"group": "gA"}
	a1 := fake.seed(queue, "A1", group)
	a2 := fake.seed(queue, "A2", group)
	b1 := fake.seed(queue, "B1", map[string]string{"group": "gB"})
	clock := NewTestClock(DefaultTestClockStart)
	var round atomic.Int32
	events := make(chan []byte, 4)
	engine := startSQSDelivery(t, fake, clock, 1, []EventSourceSpec{sqsSource("Mapping", "events.fifo")},
		func(_ context.Context, _ string, event []byte) (InvokeResult, error) {
			events <- event
			if round.Add(1) == 1 {
				return InvokeResult{Raw: json.RawMessage(`{"batchItemFailures":[{"itemIdentifier":"` + a1.id + `"}]}`)}, nil
			}
			return InvokeResult{Raw: json.RawMessage(`{"batchItemFailures":[]}`)}, nil
		})
	waitForSource(t, engine, "Mapping", func(state DeliveryState) bool { return state.Delivered == 1 })
	first := <-events
	if !strings.Contains(string(first), "A1") || !strings.Contains(string(first), "B1") {
		t.Fatalf("unexpected first FIFO batch: %s", first)
	}
	fake.mu.Lock()
	b1Deleted, a1Deleted, a2Deleted := b1.deleted, a1.deleted, a2.deleted
	fake.mu.Unlock()
	if !b1Deleted {
		t.Fatalf("a successful message in another group must be deleted")
	}
	if a1Deleted || a2Deleted {
		t.Fatalf("a failed FIFO group must keep its failed record and every later record: a1=%t a2=%t", a1Deleted, a2Deleted)
	}
	if _, err := clock.Advance(300 * time.Second); err != nil {
		t.Fatalf("advance clock: %v", err)
	}
	waitForCondition(t, func() bool {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		return a1.deleted && a2.deleted
	}, "the successful FIFO redelivery must delete both records")
	var redeliveredBodies []string
	for {
		select {
		case event := <-events:
			var batch struct {
				Records []struct {
					Body string `json:"body"`
				} `json:"Records"`
			}
			if err := json.Unmarshal(event, &batch); err != nil {
				t.Fatalf("decode redelivered event: %v", err)
			}
			for _, record := range batch.Records {
				redeliveredBodies = append(redeliveredBodies, record.Body)
			}
		default:
			if len(redeliveredBodies) == 0 {
				t.Fatal("the failed FIFO group was never redelivered")
			}
			if strings.Join(redeliveredBodies, ",") != "A1,A2" {
				t.Fatalf("the failed group must redeliver in order A1,A2 (got %v)", redeliveredBodies)
			}
			return
		}
	}
}

func TestSQSDelivererBatchingWindowWaitsForTheRunClock(t *testing.T) {
	fake := newFakeSQS(t)
	queue := fake.queue("events", nil)
	fake.seed(queue, `{"n":1}`, nil)
	fake.seed(queue, `{"n":2}`, nil)
	mapping := sqsSource("Mapping", "events")
	mapping.BatchSize = 100
	mapping.MaximumBatchingWindowInSeconds = 10
	clock := NewTestClock(DefaultTestClockStart)
	events := make(chan []byte, 4)
	engine := startSQSDelivery(t, fake, clock, 1, []EventSourceSpec{mapping},
		func(_ context.Context, _ string, event []byte) (InvokeResult, error) {
			events <- event
			return InvokeResult{Raw: json.RawMessage(`{"batchItemFailures":[]}`)}, nil
		})
	time.Sleep(300 * time.Millisecond)
	for _, state := range engine.State().Sources {
		if state.Delivered != 0 {
			t.Fatalf("a batch window must not invoke before the clock reaches the window: %+v", state)
		}
	}
	for delivered := false; !delivered; {
		if _, err := clock.Advance(10 * time.Second); err != nil {
			t.Fatalf("advance clock: %v", err)
		}
		select {
		case event := <-events:
			var decoded struct {
				Records []any `json:"Records"`
			}
			if err := json.Unmarshal(event, &decoded); err != nil {
				t.Fatalf("decode event: %v", err)
			}
			if len(decoded.Records) != 2 {
				t.Fatalf("want both messages in the window batch, got %s", event)
			}
			delivered = true
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func TestSQSDelivererBoundsConcurrentBatches(t *testing.T) {
	fake := newFakeSQS(t)
	queue := fake.queue("events", nil)
	for index := 0; index < 12; index++ {
		fake.seed(queue, fmt.Sprintf(`{"n":%d}`, index), nil)
	}
	mapping := sqsSource("Mapping", "events")
	mapping.BatchSize = 1
	mapping.MaximumConcurrency = 2
	clock := NewTestClock(DefaultTestClockStart)
	var current, peak int32
	started := make(chan struct{}, 12)
	release := make(chan struct{})
	engine := startSQSDelivery(t, fake, clock, 4, []EventSourceSpec{mapping},
		func(context.Context, string, []byte) (InvokeResult, error) {
			value := atomic.AddInt32(&current, 1)
			for {
				observed := atomic.LoadInt32(&peak)
				if value <= observed || atomic.CompareAndSwapInt32(&peak, observed, value) {
					break
				}
			}
			started <- struct{}{}
			<-release
			atomic.AddInt32(&current, -1)
			return InvokeResult{Raw: json.RawMessage(`{"batchItemFailures":[]}`)}, nil
		})
	for index := 0; index < 2; index++ {
		select {
		case <-started:
		case <-time.After(10 * time.Second):
			t.Fatalf("only %d concurrent batch(es) started with MaximumConcurrency=2", index)
		}
	}
	close(release)
	state := waitForSource(t, engine, "Mapping", func(state DeliveryState) bool { return state.Delivered == 12 })
	if observed := atomic.LoadInt32(&peak); observed > 2 {
		t.Fatalf("MaximumConcurrency=2 allowed %d concurrent batches", observed)
	}
	if state.PeakInflight > 2 || state.PeakInflight < 2 {
		t.Fatalf("the engine must report the observed peak of 2, got %d", state.PeakInflight)
	}
}

func TestSQSDelivererRedrivesToTheDeadLetterMapping(t *testing.T) {
	fake := newFakeSQS(t)
	dead := fake.queue("events-dlq", nil)
	main := fake.queue("events", func(queue *fakeSQSQueue) {
		queue.visibility = 300 * time.Second
		queue.maxReceiveCount = 2
		queue.dlq = dead
	})
	fake.seed(main, `{"fail":true}`, nil)
	clock := NewTestClock(DefaultTestClockStart)
	var mainInvocations, deadInvocations atomic.Int32
	engine := startSQSDelivery(t, fake, clock, 2, []EventSourceSpec{
		sqsSource("MainMapping", "events"),
		{LogicalID: "DeadMapping", Stack: "Stack", Function: "Stack/DLQ", Type: backendSQS, SourceName: "events-dlq", SourceARN: "arn:aws:sqs:us-east-1:123456789012:events-dlq", BatchSize: 1, Enabled: true},
	}, func(_ context.Context, function string, event []byte) (InvokeResult, error) {
		if function == "Stack/Worker" {
			mainInvocations.Add(1)
			return InvokeResult{}, fmt.Errorf("keep failing")
		}
		deadInvocations.Add(1)
		return InvokeResult{Raw: json.RawMessage(`{"batchItemFailures":[]}`)}, nil
	})
	waitForSource(t, engine, "MainMapping", func(state DeliveryState) bool { return state.Failed == 1 })
	if _, err := clock.Advance(300 * time.Second); err != nil {
		t.Fatalf("advance clock: %v", err)
	}
	state := waitForSource(t, engine, "MainMapping", func(state DeliveryState) bool { return state.Failed == 2 })
	if state.Left != 2 {
		t.Fatalf("want two left records before redrive, got %d", state.Left)
	}
	if _, err := clock.Advance(300 * time.Second); err != nil {
		t.Fatalf("advance clock: %v", err)
	}
	waitForSource(t, engine, "DeadMapping", func(state DeliveryState) bool { return state.Delivered == 1 })
	if mainInvocations.Load() != 2 || deadInvocations.Load() != 1 {
		t.Fatalf("want two main invocations and one DLQ invocation, got %d/%d", mainInvocations.Load(), deadInvocations.Load())
	}
	visible, notVisible, deleted := fake.messageCount(dead)
	if visible != 0 || notVisible != 0 || deleted != 1 {
		t.Fatalf("the DLQ mapping must delete the redriven message: visible=%d notVisible=%d deleted=%d", visible, notVisible, deleted)
	}
}

func TestSQSRecordMatchesFiltersMetadataAndBody(t *testing.T) {
	message := sqsMessageForTest("msg-1", `{"kind":"keep"}`, map[string]string{"SentTimestamp": "123"})
	record := sqsRecordMap("arn:aws:sqs:us-east-1:123456789012:q", message)
	metadata := json.RawMessage(`{"Filters":[{"Pattern":"{\"attributes\":{\"SentTimestamp\":[\"123\"]}}"}]}`)
	if !sqsRecordMatchesFilters(metadata, record, `{"kind":"keep"}`) {
		t.Fatal("a metadata filter must match the record attributes")
	}
	body := json.RawMessage(`{"Filters":[{"Pattern":"{\"body\":{\"kind\":[\"keep\"]}}"}]}`)
	if !sqsRecordMatchesFilters(body, record, `{"kind":"keep"}`) {
		t.Fatal("a body filter must match the parsed body")
	}
	if sqsRecordMatchesFilters(body, record, `not-json`) {
		t.Fatal("a body filter must not match an unparseable body")
	}
}

func TestSQSMaxReceiveCountAcceptsBothRedriveForms(t *testing.T) {
	cases := map[string]int{
		`{"deadLetterTargetArn":"arn","maxReceiveCount":5}`: 5,
		"\"{\\\"maxReceiveCount\\\":3}\"":                   3,
		`{}`:                                                0,
		`not-json`:                                          0,
	}
	for raw, want := range cases {
		if got := sqsMaxReceiveCount(json.RawMessage(raw)); got != want {
			t.Fatalf("sqsMaxReceiveCount(%s) = %d, want %d", raw, got, want)
		}
	}
}

func TestNormalizeEventFilterCriteria(t *testing.T) {
	if _, err := normalizeEventFilterCriteria(nil, "Mapping"); err != nil {
		t.Fatalf("no filter criteria: %v", err)
	}
	if encoded, err := normalizeEventFilterCriteria(json.RawMessage(`{}`), "Mapping"); err != nil || encoded != nil {
		t.Fatalf("empty filter criteria: %v %s", err, encoded)
	}
	if _, err := normalizeEventFilterCriteria(json.RawMessage(`{"Filters":[{"Pattern":"[]"}]}`), "Mapping"); err == nil {
		t.Fatal("a non-object pattern must be refused")
	}
	if _, err := normalizeEventFilterCriteria(json.RawMessage(`{"Filters":[{"Pattern":"{"}]}`), "Mapping"); err == nil {
		t.Fatal("invalid JSON must be refused")
	}
	six := `{"Filters":[{"Pattern":"{}"},{"Pattern":"{}"},{"Pattern":"{}"},{"Pattern":"{}"},{"Pattern":"{}"},{"Pattern":"{}"}]}`
	if _, err := normalizeEventFilterCriteria(json.RawMessage(six), "Mapping"); err == nil {
		t.Fatal("more than five filters must be refused")
	}
}

func TestEventPatternMatching(t *testing.T) {
	cases := []struct {
		name    string
		pattern string
		target  string
		want    bool
	}{
		{name: "equals", pattern: `{"kind":["keep"]}`, target: `{"kind":"keep"}`, want: true},
		{name: "equals miss", pattern: `{"kind":["keep"]}`, target: `{"kind":"drop"}`, want: false},
		{name: "prefix", pattern: `{"kind":[{"prefix":"ke"}]}`, target: `{"kind":"keep"}`, want: true},
		{name: "suffix", pattern: `{"kind":[{"suffix":"ep"}]}`, target: `{"kind":"keep"}`, want: true},
		{name: "ignore case", pattern: `{"kind":[{"equals-ignore-case":"KEEP"}]}`, target: `{"kind":"keep"}`, want: true},
		{name: "anything but", pattern: `{"kind":[{"anything-but":["drop"]}]}`, target: `{"kind":"keep"}`, want: true},
		{name: "anything but match", pattern: `{"kind":[{"anything-but":["drop"]}]}`, target: `{"kind":"drop"}`, want: false},
		{name: "anything but prefix", pattern: `{"kind":[{"anything-but":{"prefix":"dr"}}]}`, target: `{"kind":"keep"}`, want: true},
		{name: "anything but prefix match", pattern: `{"kind":[{"anything-but":{"prefix":"ke"}}]}`, target: `{"kind":"keep"}`, want: false},
		{name: "exists", pattern: `{"kind":[{"exists":true}]}`, target: `{"kind":"keep"}`, want: true},
		{name: "missing exists", pattern: `{"kind":[{"exists":true}]}`, target: `{"other":"x"}`, want: false},
		{name: "not exists", pattern: `{"kind":[{"exists":false}]}`, target: `{"other":"x"}`, want: true},
		{name: "null", pattern: `{"kind":[null]}`, target: `{"kind":null}`, want: true},
		{name: "missing null", pattern: `{"kind":[null]}`, target: `{"other":"x"}`, want: true},
		{name: "numeric range", pattern: `{"n":[{"numeric":[">",1,"<=",10]}]}`, target: `{"n":10}`, want: true},
		{name: "numeric outside", pattern: `{"n":[{"numeric":["<",1,">=",10]}]}`, target: `{"n":10}`, want: false},
		{name: "numeric representation", pattern: `{"n":[300]}`, target: `{"n":300.0}`, want: false},
		{name: "metadata attributes", pattern: `{"attributes":{"SentTimestamp":["123"]}}`, target: `{"attributes":{"SentTimestamp":"123"}}`, want: true},
		{name: "bad operator", pattern: `{"kind":[{"prefix":"k","suffix":"p"}]}`, target: `{"kind":"keep"}`, want: false},
		{name: "or", pattern: `{"$or":[{"a":["x"]},{"b":["y"]}]}`, target: `{"b":"y"}`, want: true},
		{name: "nested", pattern: `{"body":{"kind":["keep"]}}`, target: `{"body":{"kind":"keep"}}`, want: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			pattern, err := decodePatternValue([]byte(testCase.pattern))
			if err != nil {
				t.Fatalf("pattern: %v", err)
			}
			target, err := decodePatternValue([]byte(testCase.target))
			if err != nil {
				t.Fatalf("target: %v", err)
			}
			if got := eventPatternMatches(pattern, target); got != testCase.want {
				t.Fatalf("matched=%t want %t", got, testCase.want)
			}
		})
	}
}

func TestApplySQSMappingOptionsRejectsInvalidSQSConfiguration(t *testing.T) {
	cases := []struct {
		name       string
		queue      string
		batchSize  int
		window     int
		concurrent int
	}{
		{name: "window over 300", queue: `{"QueueName":"q"}`, batchSize: 10, window: 301},
		{name: "large batch without window", queue: `{"QueueName":"q"}`, batchSize: 11},
		{name: "fifo window", queue: `{"QueueName":"q.fifo","FifoQueue":true}`, batchSize: 10, window: 5},
		{name: "fifo batch", queue: `{"QueueName":"q.fifo","FifoQueue":true}`, batchSize: 11},
		{name: "concurrency low", queue: `{"QueueName":"q"}`, batchSize: 10, concurrent: 1},
		{name: "concurrency high", queue: `{"QueueName":"q"}`, batchSize: 10, concurrent: 1001},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			source := EventSourceSpec{LogicalID: "Mapping", BatchSize: testCase.batchSize}
			properties := eventSourceMappingProperties{
				BatchSize:                      testCase.batchSize,
				MaximumBatchingWindowInSeconds: testCase.window,
			}
			if testCase.concurrent != 0 {
				properties.ScalingConfig = &struct {
					MaximumConcurrency int `json:"MaximumConcurrency"`
				}{MaximumConcurrency: testCase.concurrent}
			}
			if err := applySQSMappingOptions(&source, properties, json.RawMessage(testCase.queue)); err == nil {
				t.Fatalf("want a refusal for %s", testCase.name)
			}
		})
	}
	valid := EventSourceSpec{LogicalID: "Mapping", BatchSize: 100}
	properties := eventSourceMappingProperties{
		BatchSize:                      100,
		MaximumBatchingWindowInSeconds: 10,
		FilterCriteria:                 json.RawMessage(`{"Filters":[{"Pattern":"{\"body\":{\"kind\":[\"keep\"]}}"}]}`),
	}
	properties.ScalingConfig = &struct {
		MaximumConcurrency int `json:"MaximumConcurrency"`
	}{MaximumConcurrency: 5}
	if err := applySQSMappingOptions(&valid, properties, json.RawMessage(`{"QueueName":"q","VisibilityTimeout":300}`)); err != nil {
		t.Fatalf("valid mapping: %v", err)
	}
	if valid.VisibilityTimeout != 300 || valid.MaximumConcurrency != 5 || len(valid.FilterCriteria) == 0 {
		t.Fatalf("mapping options were not recorded: %+v", valid)
	}
}

func TestNewSQSDelivererAndBatchSize(t *testing.T) {
	if _, err := NewSQSDeliverer(DeliverySource{ID: "Mapping"}); err == nil {
		t.Fatal("a source without an SQS mapping must be refused")
	}
	factory, err := NewSQSDeliverer(DeliverySource{
		ID:      "Mapping",
		Mapping: &EventSourceSpec{Type: backendSQS, SourceName: "q"},
	})
	if err != nil {
		t.Fatalf("new deliverer: %v", err)
	}
	deliverer, ok := factory.(*SQSDeliverer)
	if !ok {
		t.Fatalf("unexpected deliverer type %T", factory)
	}
	if deliverer.batchSize() != 10 {
		t.Fatalf("default batch size = %d, want 10", deliverer.batchSize())
	}
	deliverer.mapping.BatchSize = 50000
	if deliverer.batchSize() != 10000 {
		t.Fatalf("batch size clamp = %d, want 10000", deliverer.batchSize())
	}
	deliverer.queue.FIFO = true
	if deliverer.batchSize() != 10 {
		t.Fatalf("FIFO batch size clamp = %d, want 10", deliverer.batchSize())
	}
	if deliverer.clockNow().IsZero() {
		t.Fatal("a deliverer without a clock must fall back to real time")
	}
}

func TestSQSDelivererWaitObservesCancellation(t *testing.T) {
	deliverer := &SQSDeliverer{clock: NewTestClock(DefaultTestClockStart)}
	deliverer.wait(context.Background(), 0)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	deliverer.wait(ctx, time.Hour)
}

func TestSQSRecordMapCarriesFIFOAttributes(t *testing.T) {
	message := sqsMessageForTest("msg-1", `{"n":1}`, map[string]string{
		"MessageGroupId":         "gA",
		"MessageDeduplicationId": "d1",
		"SequenceNumber":         "0",
	})
	record := sqsRecordMap("arn:aws:sqs:us-east-1:123456789012:q.fifo", message)
	attributes, ok := record["attributes"].(map[string]string)
	if !ok {
		t.Fatalf("record attributes are %T", record["attributes"])
	}
	for name, want := range map[string]string{
		"MessageGroupId":         "gA",
		"MessageDeduplicationId": "d1",
		"SequenceNumber":         "0",
	} {
		if attributes[name] != want {
			t.Fatalf("attribute %s = %q, want %q", name, attributes[name], want)
		}
	}
	if _, ok := record["messageAttributes"].(map[string]any); !ok {
		t.Fatalf("a record must carry an (empty) messageAttributes object")
	}
}

func TestBatchFailuresInterpretsAWSDocumentedResponses(t *testing.T) {
	batch := []sqstypes.Message{sqsMessageForTest("msg-1", "{}", nil), sqsMessageForTest("msg-2", "{}", nil)}
	cases := []struct {
		name        string
		report      bool
		raw         string
		proxy       bool
		want        []string
		whole       bool
		expectError bool
	}{
		{name: "no report", raw: `{"batchItemFailures":[]}`, want: nil},
		{name: "empty list", report: true, raw: `{"batchItemFailures":[]}`, want: nil},
		{name: "null list", report: true, raw: `{"batchItemFailures":null}`, want: nil},
		{name: "empty object", report: true, raw: `{}`, want: nil},
		{name: "null response", report: true, raw: `null`, want: nil},
		{name: "one failure", report: true, raw: `{"batchItemFailures":[{"itemIdentifier":"msg-2"}]}`, want: []string{"msg-2"}},
		{name: "unknown id", report: true, raw: `{"batchItemFailures":[{"itemIdentifier":"nope"}]}`, whole: true, expectError: true},
		{name: "empty id", report: true, raw: `{"batchItemFailures":[{"itemIdentifier":""}]}`, whole: true, expectError: true},
		{name: "bad key", report: true, raw: `{"batchItemFailures":[{"messageId":"msg-2"}]}`, whole: true, expectError: true},
		{name: "invalid list", report: true, raw: `{"batchItemFailures":"msg-2"}`, whole: true, expectError: true},
		{name: "invalid json", report: true, raw: `{`, whole: true, expectError: true},
		{name: "proxy response", report: true, proxy: true, whole: true, expectError: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			deliverer := &SQSDeliverer{mapping: EventSourceSpec{ReportBatchItemFailures: testCase.report}}
			failed, whole, err := deliverer.batchFailures(
				InvokeResult{Proxy: testCase.proxy, Raw: json.RawMessage(testCase.raw)},
				batch,
			)
			if whole != testCase.whole {
				t.Fatalf("whole=%t want %t (err %v)", whole, testCase.whole, err)
			}
			if (err != nil) != testCase.expectError {
				t.Fatalf("err=%v want error=%t", err, testCase.expectError)
			}
			got := make([]string, 0, len(failed))
			for id := range failed {
				got = append(got, id)
			}
			sort.Strings(got)
			if strings.Join(got, ",") != strings.Join(testCase.want, ",") {
				t.Fatalf("failures=%v want %v", got, testCase.want)
			}
		})
	}
}
