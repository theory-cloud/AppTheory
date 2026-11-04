package localrunner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// TestDynamoStreamsClientProtocol models the pinned DynamoDB Local wire shapes:
// ListStreams returns "Streams" rather than AWS's "StreamDescriptions", stream
// ARNs use region ddblocal, and GetRecords returns ApproximateCreationDateTime
// as an ISO string.
func TestDynamoStreamsClientProtocol(t *testing.T) {
	var mu sync.Mutex
	var targets []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		target := request.Header.Get("X-Amz-Target")
		mu.Lock()
		targets = append(targets, target)
		mu.Unlock()
		if !strings.HasPrefix(request.Header.Get("Authorization"), "AWS4-HMAC-SHA256") {
			t.Errorf("request %s has no SigV4 authorization", target)
		}
		writer.Header().Set("Content-Type", "application/x-amz-json-1.0")
		switch target {
		case "DynamoDBStreams_20120810.ListStreams":
			writeTestJSON(t, writer, `{"Streams":[{"StreamArn":"arn:aws:dynamodb:ddblocal:000000000000:table/probe/stream/1","StreamLabel":"1","TableName":"probe"}]}`)
		case "DynamoDBStreams_20120810.DescribeStream":
			writeTestJSON(t, writer, `{"StreamDescription":{"StreamArn":"arn:aws:dynamodb:ddblocal:000000000000:table/probe/stream/1","StreamLabel":"1","StreamStatus":"ENABLED","StreamViewType":"NEW_AND_OLD_IMAGES","TableName":"probe","Shards":[{"ShardId":"shardId-1","SequenceNumberRange":{"StartingSequenceNumber":"000000000000000000001"}}]}}`)
		case "DynamoDBStreams_20120810.GetShardIterator":
			writeTestJSON(t, writer, `{"ShardIterator":"iterator-1"}`)
		case "DynamoDBStreams_20120810.GetRecords":
			writeTestJSON(t, writer, `{"Records":[{"eventID":"e1","eventName":"INSERT","eventVersion":"1.1","eventSource":"aws:dynamodb","awsRegion":"ddblocal","dynamodb":{"ApproximateCreationDateTime":"2026-11-04T02:34:00-05:00","Keys":{"pk":{"S":"a"}},"NewImage":{"pk":{"S":"a"}},"SequenceNumber":"000000000000000000001","SizeBytes":13,"StreamViewType":"NEW_AND_OLD_IMAGES"}}],"NextShardIterator":"iterator-2","MillisBehindLatest":0}`)
		default:
			t.Errorf("unexpected target %s", target)
		}
	}))
	defer server.Close()

	client := newDynamoStreamsClient(server.URL)
	streams, err := client.ListStreams(context.Background(), "probe")
	if err != nil || len(streams) != 1 || streams[0].StreamLabel != "1" {
		t.Fatalf("ListStreams: %+v %v", streams, err)
	}
	description, err := client.DescribeStream(context.Background(), streams[0].StreamArn)
	if err != nil || len(description.Shards) != 1 || description.Shards[0].ShardID != "shardId-1" {
		t.Fatalf("DescribeStream: %+v %v", description, err)
	}
	iterator, err := client.GetShardIterator(context.Background(), streams[0].StreamArn, "shardId-1", dynamoStreamIteratorTrimHorizon, "", nil)
	if err != nil || iterator != "iterator-1" {
		t.Fatalf("GetShardIterator: %q %v", iterator, err)
	}
	out, err := client.GetRecords(context.Background(), iterator, 10)
	if err != nil || len(out.Records) != 1 || out.NextShardIterator == nil {
		t.Fatalf("GetRecords: %+v %v", out, err)
	}
	if len(targets) != 4 {
		t.Fatalf("client made %d calls, want 4", len(targets))
	}
}

func TestNormalizeDynamoStreamARNAndRecord(t *testing.T) {
	arn := normalizeDynamoStreamARN("arn:aws:dynamodb:ddblocal:000000000000:table/probe/stream/2026-11-04T07:34:53.499", "probe")
	want := "arn:aws:dynamodb:us-east-1:123456789012:table/probe/stream/2026-11-04T07:34:53.499"
	if arn != want {
		t.Fatalf("normalized ARN %q, want %q", arn, want)
	}
	if got := normalizeDynamoStreamARN("", "probe"); got != "" {
		t.Fatalf("an absent stream must stay absent, got %q", got)
	}
	record := map[string]any{
		"eventName":      "REMOVE",
		"awsRegion":      "ddblocal",
		"eventSourceARN": "arn:aws:dynamodb:ddblocal:000000000000:table/probe/stream/1",
		"dynamodb": map[string]any{
			"ApproximateCreationDateTime": "2026-11-04T02:34:00-05:00",
			"SequenceNumber":              "1",
		},
	}
	normalized := normalizeDynamoStreamRecord(record, want, true)
	if normalized["awsRegion"] != LocalRegion || normalized["eventSourceARN"] != want {
		t.Fatalf("record was not normalized: %+v", normalized)
	}
	if _, ok := normalized["dynamodb"].(map[string]any)["ApproximateCreationDateTime"].(float64); !ok {
		t.Fatalf("ApproximateCreationDateTime is not epoch seconds: %+v", normalized["dynamodb"])
	}
	identity, ok := normalized["userIdentity"].(map[string]any)
	if !ok || identity["type"] != "Service" || identity["principalId"] != "dynamodb.amazonaws.com" {
		t.Fatalf("TTL delete has no service userIdentity: %+v", normalized)
	}
	plain := normalizeDynamoStreamRecord(record, want, false)
	if _, exists := plain["userIdentity"]; exists {
		t.Fatalf("a normal delete must not carry a userIdentity: %+v", plain)
	}
	if got := dynamoStreamSequence(record); got != "1" {
		t.Fatalf("sequence %q", got)
	}
}

// TestStreamPollerBisectsAndDiscards models the documented partial-failure and
// on-failure behavior: a batch of [good, poison] reports the poison sequence,
// only the poison tail is retried, and after MaximumRetryAttempts it is sent to
// the destination while the good record stays delivered.
func TestStreamPollerBisectsAndDiscards(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	reporter := &recordingDeliveryReporter{}
	env := DelivererEnv{Clock: clock, State: reporter}
	reader := &fakeShardReader{batches: [][]streamRecord{{
		{Sequence: "1", Shard: "shardId-1", Arrival: clock.Now(), Value: "good"},
		{Sequence: "2", Shard: "shardId-1", Arrival: clock.Now(), Value: "poison"},
	}}}
	var mu sync.Mutex
	var deliveries [][]string
	deliver := func(_ context.Context, records []streamRecord) streamBatchOutcome {
		sequences := make([]string, 0, len(records))
		for _, record := range records {
			sequences = append(sequences, record.Sequence)
		}
		mu.Lock()
		deliveries = append(deliveries, sequences)
		mu.Unlock()
		for _, record := range records {
			if record.Sequence == "2" {
				return streamBatchOutcome{FailedSequences: []string{"2"}}
			}
		}
		return streamBatchOutcome{}
	}
	var discarded []string
	discard := func(_ context.Context, records []streamRecord, condition string, attempts int, _ error) {
		for _, record := range records {
			discarded = append(discarded, record.Sequence)
		}
		if condition != "MaximumRetryAttempts" || attempts != 3 {
			t.Errorf("discard condition %q attempts %d", condition, attempts)
		}
	}
	poller := newStreamPoller("mapping", env, reader, streamPollerOptions{
		BatchSize:                  10,
		MaximumRetryAttempts:       2,
		BisectBatchOnFunctionError: true,
	}, deliver, discard)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		poller.run(ctx)
		close(done)
	}()
	advance := func(step time.Duration) {
		for attempt := 0; attempt < 40; attempt++ {
			clock.Advance(step) //nolint:errcheck // a test clock advance never fails
			time.Sleep(5 * time.Millisecond)
		}
	}
	advance(time.Minute)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		done := len(discarded) == 1
		mu.Unlock()
		if done {
			break
		}
		advance(time.Minute)
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	<-done
	mu.Lock()
	discardedCount := len(discarded)
	mu.Unlock()
	if discardedCount != 1 {
		mu.Lock()
		got := append([][]string(nil), deliveries...)
		mu.Unlock()
		t.Fatalf("discarded %d records, want 1 (state %+v, deliveries %v)", discardedCount, reporter, got)
	}
	if reporter.delivered != 1 {
		t.Fatalf("delivered %d invocations, want the good record once (state %+v)", reporter.delivered, reporter)
	}
	if len(discarded) != 1 || discarded[0] != "2" {
		t.Fatalf("discarded sequences %v, want [2]", discarded)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(deliveries) < 3 {
		t.Fatalf("deliveries %v, want the initial batch and two retries", deliveries)
	}
	if len(deliveries[0]) != 2 {
		t.Fatalf("the first delivery was %v, want both records", deliveries[0])
	}
	for index, batch := range deliveries[1:] {
		if len(batch) != 1 || batch[0] != "2" {
			t.Fatalf("retry %d delivered %v, want only the poison record", index+1, batch)
		}
	}
	if reporter.left != 1 {
		t.Fatalf("left counter %d, want the one poison record counted once", reporter.left)
	}
}

// fakeShardReader returns each prepared batch once, then no records.
type fakeShardReader struct {
	mu      sync.Mutex
	batches [][]streamRecord
	index   int
	done    bool
}

func (r *fakeShardReader) Read(_ context.Context, _ int) ([]streamRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.index >= len(r.batches) {
		return nil, nil
	}
	batch := r.batches[r.index]
	r.index++
	return batch, nil
}

func (r *fakeShardReader) Reconnect(_ context.Context, _ string) error { return nil }

func (r *fakeShardReader) Done() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.done
}

// TestTTLSweeperDeletesExpiredItems drives the sweep against a DynamoDB JSON
// boundary and proves the deleted key is marked for the stream record.
func TestTTLSweeperDeletesExpiredItems(t *testing.T) {
	var deleted []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body) //nolint:errcheck // the fake reads the request it expects
		switch request.Header.Get("X-Amz-Target") {
		case "DynamoDB_20120810.Scan":
			writeTestJSON(t, writer, `{"Items":[{"pk":{"S":"expired"},"expiresAt":{"N":"100"}},{"pk":{"S":"live"},"expiresAt":{"N":"9999999999"}}],"Count":2}`)
		case "DynamoDB_20120810.DeleteItem":
			key := body["Key"].(map[string]any)                                 //nolint:errcheck // the fake reads the request it expects
			deleted = append(deleted, key["pk"].(map[string]any)["S"].(string)) //nolint:errcheck // the test built this shape
			writeTestJSON(t, writer, `{}`)
		default:
			t.Errorf("unexpected target %s", request.Header.Get("X-Amz-Target"))
		}
	}))
	defer server.Close()

	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	runner := &Runner{clock: NewTestClock(start), ttl: newTTLTracker()}
	client := dynamodb.New(dynamodb.Options{
		Region:       LocalRegion,
		Credentials:  localCredentials(),
		BaseEndpoint: aws.String(server.URL),
	})
	runner.sweepTTL(context.Background(), client, ttlTable{
		Name:      "probe",
		Attribute: "expiresAt",
		KeySchema: []keySchemaAttribute{{Name: "pk", Type: "S"}},
	})
	if len(deleted) != 1 || deleted[0] != "expired" {
		t.Fatalf("deleted %v, want only the expired item", deleted)
	}
	if !runner.ttl.take("probe", map[string]any{"pk": map[string]any{"S": "expired"}}, start.Add(time.Minute)) {
		t.Fatal("the TTL delete was not marked for the stream record")
	}
	if runner.ttl.take("probe", map[string]any{"pk": map[string]any{"S": "expired"}}, start.Add(time.Minute)) {
		t.Fatal("a TTL marker must be consumed once")
	}
}
