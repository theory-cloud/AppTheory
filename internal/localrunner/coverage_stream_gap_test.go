package localrunner

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"
)

// scriptedShardReader feeds a fixed sequence of batches and errors.
type scriptedShardReader struct {
	batches      [][]streamRecord
	errs         []error
	index        int
	done         bool
	onRead       func(int)
	reconnectErr error
}

func (r *scriptedShardReader) Read(ctx context.Context, _ int) ([]streamRecord, error) {
	if r.index >= len(r.batches) {
		return nil, ctx.Err()
	}
	if r.onRead != nil {
		r.onRead(r.index)
	}
	batch := r.batches[r.index]
	err := r.errs[r.index]
	r.index++
	if err != nil {
		return nil, err
	}
	return batch, nil
}

func (r *scriptedShardReader) Reconnect(context.Context, string) error {
	return r.reconnectErr
}

func (r *scriptedShardReader) Done() bool {
	return r.done
}

func streamTestRecords(count int) []streamRecord {
	records := make([]streamRecord, 0, count)
	for index := 1; index <= count; index++ {
		records = append(records, streamRecord{Sequence: itoa(index), Shard: "s", Value: "x"})
	}
	return records
}

func itoa(value int) string {
	return strconv.Itoa(value)
}

func TestStreamPollerBisectAndPartialRetry(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	reporter := &recordingDeliveryReporter{}
	records := streamTestRecords(4)
	conditions := make(chan string, 2)
	deliver := func(_ context.Context, batch []streamRecord) streamBatchOutcome {
		if len(batch) == len(records) {
			return streamBatchOutcome{WholeFailure: true, Err: errors.New("boom")}
		}
		if batch[0].Sequence == records[2].Sequence || batch[0].Sequence == records[3].Sequence {
			return streamBatchOutcome{WholeFailure: true, Err: errors.New("boom")}
		}
		return streamBatchOutcome{}
	}
	poller := newStreamPoller("m", DelivererEnv{Clock: clock, State: reporter}, &scriptedShardReader{}, streamPollerOptions{
		BatchSize:                  10,
		BisectBatchOnFunctionError: true,
		MaximumRetryAttempts:       0,
	}, deliver, func(_ context.Context, _ []streamRecord, condition string, _ int, _ error) {
		conditions <- condition
	})
	poller.process(context.Background(), records)
	select {
	case condition := <-conditions:
		if condition != "MaximumRetryAttempts" {
			t.Fatalf("condition: %q", condition)
		}
	default:
		t.Fatal("the failing half must be discarded")
	}

	// A partial response checkpoints at the lowest failed sequence and retries
	// only the tail; the second partial response advances the checkpoint again.
	partial := streamTestRecords(3)
	calls := 0
	partialPoller := newStreamPoller("m", DelivererEnv{Clock: clock, State: reporter}, &scriptedShardReader{}, streamPollerOptions{
		BatchSize:            10,
		MaximumRetryAttempts: 5,
	}, func(_ context.Context, batch []streamRecord) streamBatchOutcome {
		calls++
		switch calls {
		case 1:
			return streamBatchOutcome{FailedSequences: []string{partial[1].Sequence}}
		case 2:
			return streamBatchOutcome{FailedSequences: []string{partial[1].Sequence}}
		default:
			return streamBatchOutcome{}
		}
	}, nil)
	done := make(chan struct{})
	go func() {
		partialPoller.process(context.Background(), partial)
		close(done)
	}()
	for index := 0; index < 10; index++ {
		clock.Advance(time.Second) //nolint:errcheck // a test clock advance never fails
		select {
		case <-done:
		case <-time.After(50 * time.Millisecond):
			continue
		}
		break
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the partial retry never finished")
	}
	if calls < 3 {
		t.Fatalf("the partial retry must retry the tail: %d", calls)
	}
}

func TestStreamPollerExpiredWithoutDestination(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	reporter := &recordingDeliveryReporter{}
	records := streamTestRecords(2)
	poller := newStreamPoller("m", DelivererEnv{Clock: clock, State: reporter}, &scriptedShardReader{}, streamPollerOptions{
		BatchSize:            10,
		MaximumRecordAge:     time.Second,
		MaximumRetryAttempts: 10,
	}, func(context.Context, []streamRecord) streamBatchOutcome {
		return streamBatchOutcome{WholeFailure: true}
	}, nil)
	poller.firstSeen[records[0].Sequence] = clock.Now().Add(-time.Hour)
	poller.firstSeen[records[1].Sequence] = clock.Now().Add(-time.Hour)
	poller.process(context.Background(), records)
	if reporter.discarded == 0 {
		t.Fatalf("an expired batch must be discarded: %+v", reporter)
	}
}

func TestStreamPollerReadWindowAndFilter(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	reporter := &recordingDeliveryReporter{}
	records := streamTestRecords(3)
	reader := &scriptedShardReader{
		batches: [][]streamRecord{{records[0], records[1], records[2]}, {}},
		errs:    []error{nil, nil},
		onRead: func(index int) {
			if index == 1 {
				clock.Advance(5 * time.Second) //nolint:errcheck // a test clock advance never fails
			}
		},
	}
	poller := newStreamPoller("m", DelivererEnv{Clock: clock, State: reporter}, reader, streamPollerOptions{
		BatchSize: 10,
		Accept: func(record streamRecord) bool {
			return record.Sequence != records[1].Sequence
		},
	}, nil, nil)
	batch, err := poller.read(context.Background(), 5*time.Second)
	if err != nil || len(batch) != 2 || reporter.filtered != 1 {
		t.Fatalf("windowed read: %d %v %+v", len(batch), err, reporter)
	}

	emptyClock := NewTestClock(clock.Now())
	empty := newStreamPoller("m", DelivererEnv{Clock: emptyClock, State: reporter}, &scriptedShardReader{
		batches: [][]streamRecord{{}, {}},
		errs:    []error{nil, nil},
	}, streamPollerOptions{BatchSize: 0}, nil, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	if _, err := empty.read(ctx, 5*time.Second); err == nil {
		t.Fatal("a reader that stops answering must surface the context error")
	}
}

func TestStreamPollerReconnectFailure(t *testing.T) {
	clock := NewTestClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	reporter := &recordingDeliveryReporter{}
	reader := &scriptedShardReader{
		batches:      [][]streamRecord{{}, {}},
		errs:         []error{errors.New("ExpiredIteratorException"), nil},
		reconnectErr: errors.New("still expired"),
	}
	poller := newStreamPoller("m", DelivererEnv{Clock: clock, State: reporter, Logf: func(string, ...any) {}}, reader, streamPollerOptions{BatchSize: 10}, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		poller.run(ctx)
		close(done)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && reporter.failed == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	if reporter.failed == 0 {
		t.Fatalf("the reconnect failure must be reported: %+v", reporter)
	}
}

func TestSQSDelivererStartEdges(t *testing.T) {
	mapping := EventSourceSpec{LogicalID: "Mapping", SourceName: "queue", BatchSize: 10}
	deliverer := &SQSDeliverer{source: DeliverySource{ID: "Mapping"}, mapping: mapping}
	if err := deliverer.Start(context.Background(), DelivererEnv{}); err == nil {
		t.Fatal("a missing client must fail")
	}
	fake := newFakeSQS(t)
	queue := fake.queue("queue", nil)
	fake.seed(queue, "body", nil)
	client := newSQSClient(fake.server.URL)
	backend := DeliveryBackend{Client: client, Endpoint: fake.server.URL}
	disabled := &SQSDeliverer{source: DeliverySource{ID: "Mapping"}, mapping: EventSourceSpec{LogicalID: "Mapping", SourceName: "queue", Enabled: false}}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := disabled.Start(ctx, DelivererEnv{Backend: backend, State: &recordingDeliveryReporter{}, Logf: func(string, ...any) {}}); err != nil {
		t.Fatalf("the disabled mapping: %v", err)
	}
}
