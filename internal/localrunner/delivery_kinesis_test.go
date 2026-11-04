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

// TestKinesisDelivererEventShape models the observed moto Kinesis responses at
// the AWS JSON protocol boundary: a single open shard, an opaque small sequence
// number, and a base64 Data blob.
func TestKinesisDelivererEventShape(t *testing.T) {
	var mu sync.Mutex
	reads := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		target := strings.TrimPrefix(request.Header.Get("X-Amz-Target"), "Kinesis_20131202.")
		writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
		switch target {
		case "DescribeStreamSummary":
			writeTestJSON(t, writer, `{"StreamDescriptionSummary":{"StreamName":"probe","StreamARN":"arn:aws:kinesis:us-east-1:123456789012:stream/probe","StreamStatus":"ACTIVE","OpenShardCount":1,"RetentionPeriodHours":24}}`)
		case "ListShards":
			writeTestJSON(t, writer, `{"Shards":[{"ShardId":"shardId-000000000000","SequenceNumberRange":{"StartingSequenceNumber":"1"}}]}`)
		case "GetShardIterator":
			writeTestJSON(t, writer, `{"ShardIterator":"it-1"}`)
		case "GetRecords":
			mu.Lock()
			reads++
			first := reads == 1
			mu.Unlock()
			if first {
				writeTestJSON(t, writer, `{"Records":[{"SequenceNumber":"1","PartitionKey":"p1","Data":"aGVsbG8=","ApproximateArrivalTimestamp":1.7937789e9}],"NextShardIterator":"it-2"}`)
				return
			}
			writeTestJSON(t, writer, `{"Records":[],"NextShardIterator":"it-2"}`)
		default:
			t.Errorf("unexpected target %q", target)
			writeTestJSON(t, writer, `{}`)
		}
	}))
	defer server.Close()

	mapping := EventSourceSpec{
		LogicalID:             "Kinesis",
		Stack:                 "S",
		Function:              "Fn",
		Type:                  backendKinesis,
		Source:                "Stream",
		SourceName:            "probe",
		SourceARN:             "arn:aws:kinesis:us-east-1:123456789012:stream/probe",
		BatchSize:             10,
		Enabled:               true,
		StartingPosition:      dynamoStreamIteratorTrimHorizon,
		ParallelizationFactor: 1,
		MaximumRetryAttempts:  -1,
	}
	source := DeliverySource{ID: "Kinesis", Kind: DeliveryKindKinesis, Mapping: &mapping}
	deliverer, err := NewKinesisDeliverer(source)
	if err != nil {
		t.Fatal(err)
	}
	invoked := make(chan []byte, 4)
	env := DelivererEnv{
		Source: source,
		Clock:  NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
		Backend: DeliveryBackend{
			Service: backendKinesis,
			Client:  newKinesisClient(server.URL),
		},
		Invoke: func(_ context.Context, event []byte) (InvokeResult, error) {
			invoked <- event
			return InvokeResult{}, nil
		},
		State: &recordingDeliveryReporter{},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = deliverer.Start(ctx, env) }() //nolint:errcheck // the test cancels the deliverer
	select {
	case event := <-invoked:
		var decoded struct {
			Records []struct {
				Kinesis struct {
					PartitionKey   string  `json:"partitionKey"`
					SequenceNumber string  `json:"sequenceNumber"`
					Data           string  `json:"data"`
					Arrival        float64 `json:"approximateArrivalTimestamp"`
				} `json:"kinesis"`
				EventSourceARN string `json:"eventSourceARN"`
				EventSource    string `json:"eventSource"`
			} `json:"Records"`
		}
		if err := json.Unmarshal(event, &decoded); err != nil {
			t.Fatalf("decode event: %v (%s)", err, event)
		}
		if len(decoded.Records) != 1 {
			t.Fatalf("records: %s", event)
		}
		record := decoded.Records[0]
		data, err := base64.StdEncoding.DecodeString(record.Kinesis.Data)
		if err != nil || string(data) != "hello" {
			t.Fatalf("data %q %v", record.Kinesis.Data, err)
		}
		if record.Kinesis.PartitionKey != "p1" || record.Kinesis.SequenceNumber != "1" {
			t.Fatalf("record: %+v", record.Kinesis)
		}
		if record.EventSourceARN != mapping.SourceARN || record.EventSource != "aws:kinesis" {
			t.Fatalf("record ARN/source: %+v", record)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the Kinesis deliverer never invoked the consumer")
	}
}

// TestSubscriptionKinesisDestinationPutsGzip proves a stream destination gets
// the same gzip payload as the Kinesis record data.
func TestSubscriptionKinesisDestinationPutsGzip(t *testing.T) {
	events := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
		switch request.Header.Get("X-Amz-Target") {
		case "Logs_20140328.CreateLogGroup":
			writeTestJSON(t, writer, `{}`)
		case "Logs_20140328.FilterLogEvents":
			now := time.Now().UnixMilli()
			writeTestJSON(t, writer, fmt.Sprintf(`{"events":[{"eventId":"1","logStreamName":"s1","timestamp":%d,"message":"order 42"}]}`, now))
		default:
			writeTestJSON(t, writer, `{}`)
		}
	}))
	defer events.Close()
	var mu sync.Mutex
	var putRecords []map[string]any
	stream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
		target := strings.TrimPrefix(request.Header.Get("X-Amz-Target"), "Kinesis_20131202.")
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body) //nolint:errcheck // the fake reads the request it expects
		switch target {
		case "DescribeStreamSummary":
			writeTestJSON(t, writer, `{"StreamDescriptionSummary":{"StreamName":"probe","StreamARN":"arn:aws:kinesis:us-east-1:123456789012:stream/probe","StreamStatus":"ACTIVE","OpenShardCount":1}}`)
		case "PutRecord":
			mu.Lock()
			putRecords = append(putRecords, body)
			mu.Unlock()
			writeTestJSON(t, writer, `{"SequenceNumber":"1","ShardId":"shardId-000000000000"}`)
		default:
			writeTestJSON(t, writer, `{}`)
		}
	}))
	defer stream.Close()

	source := DeliverySource{
		ID:   "Filter",
		Kind: DeliveryKindCloudWatchLogs,
		Subscription: &SubscriptionSpec{
			LogicalID:       "Filter",
			Kind:            string(DeliveryKindCloudWatchLogs),
			LogGroup:        "/aws/lambda/producer",
			FilterName:      "orders",
			FilterPattern:   "order",
			DestinationType: "stream",
			Stream:          "Stream",
			StreamName:      "probe",
			Distribution:    "ByLogStream",
		},
	}
	deliverer, err := NewCloudWatchLogsDeliverer(source)
	if err != nil {
		t.Fatal(err)
	}
	env := DelivererEnv{
		Source: source,
		Clock:  NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
		Backend: DeliveryBackend{Client: &logsLocalBackend{
			logs:    newCloudWatchLogsClient(events.URL),
			kinesis: newKinesisClient(stream.URL),
		}},
		State: &recordingDeliveryReporter{},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = deliverer.Start(ctx, env) }() //nolint:errcheck // the test cancels the deliverer
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		count := len(putRecords)
		mu.Unlock()
		if count > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	mu.Lock()
	defer mu.Unlock()
	if len(putRecords) != 1 {
		t.Fatalf("PutRecord calls %d, want 1", len(putRecords))
	}
	record := putRecords[0]
	if record["StreamName"] != "probe" || record["PartitionKey"] != "s1" {
		t.Fatalf("PutRecord: %+v", record)
	}
	compressed, err := base64.StdEncoding.DecodeString(record["Data"].(string)) //nolint:errcheck // the test built this shape
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
	if payload["logStream"] != "s1" || payload["messageType"] != "DATA_MESSAGE" {
		t.Fatalf("payload: %+v", payload)
	}
}

// Kinesis event filtering evaluates the top-level data key against the
// base64-DECODED payload when that payload is valid JSON.
// https://docs.aws.amazon.com/lambda/latest/dg/with-kinesis-filtering.html
func TestKinesisFilterUsesDecodedData(t *testing.T) {
	record := streamRecord{
		Sequence: "7",
		Shard:    "shardId-000000000000",
		Value: KinesisRecordInput{
			Data:           []byte(`{"level":"ERROR","message":"boom"}`),
			PartitionKey:   "p1",
			SequenceNumber: "7",
		},
	}
	target, err := kinesisRecordMap(record, "arn:aws:kinesis:us-east-1:123456789012:stream/probe")
	if err != nil {
		t.Fatalf("record map: %v", err)
	}
	cases := []struct {
		name    string
		pattern string
		want    bool
	}{
		{"documented data pattern", `{"Filters":[{"Pattern":"{\"data\":{\"level\":[\"ERROR\"]}}"}]}`, true},
		{"non-matching data pattern", `{"Filters":[{"Pattern":"{\"data\":{\"level\":[\"INFO\"]}}"}]}`, false},
		{"metadata eventSource", `{"Filters":[{"Pattern":"{\"eventSource\":[\"aws:kinesis\"]}"}]}`, true},
		{"metadata partitionKey", `{"Filters":[{"Pattern":"{\"kinesis\":{\"partitionKey\":[\"p1\"]}}"}]}`, true},
	}
	for _, testCase := range cases {
		matched, matchErr := recordMatchesEventFilters(json.RawMessage(testCase.pattern), target)
		if matchErr != nil || matched != testCase.want {
			t.Fatalf("%s: matched=%v err=%v want %v", testCase.name, matched, matchErr, testCase.want)
		}
	}
}

// A non-JSON payload cannot satisfy a data pattern (Lambda drops the record),
// while a metadata-only pattern still matches.
// https://docs.aws.amazon.com/lambda/latest/dg/with-kinesis-filtering.html
func TestKinesisFilterDropsNonJSONData(t *testing.T) {
	record := streamRecord{
		Sequence: "8",
		Shard:    "shardId-000000000000",
		Value: KinesisRecordInput{
			Data:           []byte("not-json"),
			PartitionKey:   "p1",
			SequenceNumber: "8",
		},
	}
	target, err := kinesisRecordMap(record, "arn:aws:kinesis:us-east-1:123456789012:stream/probe")
	if err != nil {
		t.Fatalf("record map: %v", err)
	}
	if _, ok := target["data"]; ok {
		t.Fatalf("non-JSON data must not populate the data key: %v", target)
	}
	matched, err := recordMatchesEventFilters(
		json.RawMessage(`{"Filters":[{"Pattern":"{\"eventSource\":[\"aws:kinesis\"]}"}]}`), target)
	if err != nil || !matched {
		t.Fatalf("a metadata-only pattern must still match: %v %v", matched, err)
	}
}

// The delivery path must hand Lambda only the records the decoded-data filter
// accepts and count the rest as filtered.
// https://docs.aws.amazon.com/lambda/latest/dg/with-kinesis-filtering.html
func TestKinesisDelivererFiltersOnDecodedData(t *testing.T) {
	var mu sync.Mutex
	reads := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
		target := strings.TrimPrefix(request.Header.Get("X-Amz-Target"), "Kinesis_20131202.")
		switch target {
		case "DescribeStreamSummary":
			writeTestJSON(t, writer, `{"StreamDescriptionSummary":{"StreamName":"probe","StreamARN":"arn:aws:kinesis:us-east-1:123456789012:stream/probe","StreamStatus":"ACTIVE","OpenShardCount":1,"RetentionPeriodHours":24}}`)
		case "ListShards":
			writeTestJSON(t, writer, `{"Shards":[{"ShardId":"shardId-000000000000","SequenceNumberRange":{"StartingSequenceNumber":"1"}}]}`)
		case "GetShardIterator":
			writeTestJSON(t, writer, `{"ShardIterator":"it-1"}`)
		case "GetRecords":
			mu.Lock()
			reads++
			first := reads == 1
			mu.Unlock()
			if !first {
				writeTestJSON(t, writer, `{"Records":[],"NextShardIterator":"it-2"}`)
				return
			}
			payloads := []string{
				base64.StdEncoding.EncodeToString([]byte(`{"level":"ERROR","message":"boom"}`)),
				base64.StdEncoding.EncodeToString([]byte(`{"level":"INFO","message":"ok"}`)),
				base64.StdEncoding.EncodeToString([]byte("not-json")),
			}
			records := make([]map[string]any, 0, len(payloads))
			for index, data := range payloads {
				records = append(records, map[string]any{
					"SequenceNumber":     fmt.Sprintf("%d", index+1),
					"PartitionKey":       "p1",
					"Data":               data,
					"ApproximateArrival": float64(1.7937789e9 + index),
				})
			}
			encoded, err := json.Marshal(map[string]any{"Records": records, "NextShardIterator": "it-2"})
			if err != nil {
				t.Errorf("marshal records: %v", err)
				return
			}
			writer.Write(encoded) //nolint:errcheck // the test writer never fails
		default:
			writeTestJSON(t, writer, `{}`)
		}
	}))
	defer server.Close()

	mapping := EventSourceSpec{
		LogicalID:             "Kinesis",
		Stack:                 "S",
		Function:              "Fn",
		Type:                  backendKinesis,
		Source:                "Stream",
		SourceName:            "probe",
		SourceARN:             "arn:aws:kinesis:us-east-1:123456789012:stream/probe",
		BatchSize:             10,
		Enabled:               true,
		StartingPosition:      dynamoStreamIteratorTrimHorizon,
		ParallelizationFactor: 1,
		MaximumRetryAttempts:  -1,
		FilterCriteria:        json.RawMessage(`{"Filters":[{"Pattern":"{\"data\":{\"level\":[\"ERROR\"]}}"}]}`),
	}
	source := DeliverySource{ID: "Kinesis", Kind: DeliveryKindKinesis, Mapping: &mapping}
	deliverer, err := NewKinesisDeliverer(source)
	if err != nil {
		t.Fatal(err)
	}
	reporter := &recordingDeliveryReporter{}
	invoked := make(chan []byte, 4)
	env := DelivererEnv{
		Source:  source,
		Clock:   NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
		Backend: DeliveryBackend{Service: backendKinesis, Client: newKinesisClient(server.URL)},
		Invoke: func(_ context.Context, event []byte) (InvokeResult, error) {
			invoked <- event
			return InvokeResult{}, nil
		},
		State: reporter,
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = deliverer.Start(ctx, env); close(done) }() //nolint:errcheck // the test cancels the deliverer
	select {
	case event := <-invoked:
		var decoded struct {
			Records []struct {
				Kinesis struct {
					Data string `json:"data"`
				} `json:"kinesis"`
			} `json:"Records"`
		}
		if err := json.Unmarshal(event, &decoded); err != nil {
			t.Fatalf("decode event: %v (%s)", err, event)
		}
		if len(decoded.Records) != 1 {
			t.Fatalf("delivered %d records, want only the ERROR record: %s", len(decoded.Records), event)
		}
		data, err := base64.StdEncoding.DecodeString(decoded.Records[0].Kinesis.Data)
		if err != nil || string(data) != `{"level":"ERROR","message":"boom"}` {
			t.Fatalf("delivered data %q %v", data, err)
		}
	case <-time.After(10 * time.Second):
		cancel()
		<-done
		t.Fatal("the decoded-data filter never let the ERROR record through")
	}
	cancel()
	<-done
	if reporter.filtered != 2 {
		t.Fatalf("filtered %d records, want 2", reporter.filtered)
	}
}
