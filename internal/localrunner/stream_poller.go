package localrunner

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// The stream poller is the part of DynamoDB Streams and Kinesis delivery that
// has the same semantics in both services: read batches from one shard, apply
// the mapping's filter criteria, invoke the function, and retry the checkpoint
// Lambda would retry. The two services differ in how a reader is built, how a
// record is shaped into an event and which iterator types exist; everything
// below is the shared rule set.
//
// Sources:
//   - https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html
//   - https://docs.aws.amazon.com/lambda/latest/dg/with-kinesis.html
//   - https://docs.aws.amazon.com/lambda/latest/dg/services-ddb-batchfailurereporting.html
//   - https://docs.aws.amazon.com/lambda/latest/dg/services-kinesis-batchfailurereporting.html
//   - https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html
//
// Rules implemented here:
//   - a batch is closed at BatchSize, at the batching window, or when the
//     stream has no more records;
//   - a record that matches no filter is dropped and the iterator advances past
//     it, as AWS documents for stream sources;
//   - a complete failure retries the batch; with BisectBatchOnFunctionError the
//     batch is split in half and each half retried;
//   - a partial batch response checkpoints at the lowest failed sequence
//     number, so only the records from that checkpoint on are retried;
//   - MaximumRetryAttempts and MaximumRecordAgeInSeconds stop the retry and send
//     the discarded records to the on-failure destination;
//   - an expired shard iterator is re-seeked after the last consumed record;
//   - a closed shard stops once its records are exhausted, and the deliverer
//     re-reads the stream to pick up child shards.

const (
	// streamIdlePoll is the stream poll interval. AWS polls DynamoDB streams
	// about four times per second; one poll every 150ms is in the same order and
	// keeps a row's wall-clock wait short. It is wall-clock on purpose: the test
	// clock controls batching windows, retries and record age, not how often a
	// backend is polled.
	streamIdlePoll = 150 * time.Millisecond
	// streamRetryBase and streamRetryMaximum bound the local retry backoff. AWS
	// does not document a fixed stream retry delay; the local delay is a clock
	// timer so a test clock can drive the retry deterministically.
	streamRetryBase    = time.Second
	streamRetryMaximum = 5 * time.Minute
	// streamUnlimitedRetries is the Lambda default for MaximumRetryAttempts
	// (-1): retry until the record expires.
	streamUnlimitedRetries = -1
)

// streamRecord is one record read from a stream shard.
type streamRecord struct {
	// Sequence is the DynamoDB sequence number or the Kinesis sequence number.
	Sequence string
	// Partition is the Kinesis partition key (or the DynamoDB partition key),
	// used to preserve order per key across parallel lanes.
	Partition string
	// Shard is the backend shard the record came from.
	Shard string
	// Arrival is the approximate arrival time the event carries.
	Arrival time.Time
	// Value is the backend record the deliverer turns into an event.
	Value any
}

// streamBatchOutcome is the result of one handler invocation.
type streamBatchOutcome struct {
	// FailedSequences lists the records the handler reported as failed. AWS
	// retries from the lowest sequence number in the list.
	FailedSequences []string
	// WholeFailure reports a failed invocation or an unusable response.
	WholeFailure bool
	// Err carries the invocation or response error for the delivery state.
	Err error
}

// streamBatchDeliver invokes the function for one batch. The deliverer builds
// the service event and interprets the function response.
type streamBatchDeliver func(ctx context.Context, records []streamRecord) streamBatchOutcome

// streamDiscard sends discarded records to the mapping's on-failure destination
// and records the discard. condition is the documented exhausted-retry
// condition: MaximumRetryAttempts or MaximumEventAgeInSeconds.
type streamDiscard func(ctx context.Context, records []streamRecord, condition string, attempts int, lastErr error)

// streamShardReader is one shard lane's backend reader.
type streamShardReader interface {
	// Read returns the records after the reader's current position. An empty
	// slice means no records were available yet.
	Read(ctx context.Context, limit int) ([]streamRecord, error)
	// Reconnect re-seeks after an expired iterator. afterSequence is the last
	// consumed record, empty when none was consumed.
	Reconnect(ctx context.Context, afterSequence string) error
	// Done reports a closed shard with no records left.
	Done() bool
}

// streamPollerOptions are the mapping settings the shared poller applies.
type streamPollerOptions struct {
	BatchSize                  int
	BatchingWindow             time.Duration
	BisectBatchOnFunctionError bool
	// MaximumRetryAttempts is -1 for unlimited, 0 for no retry, or a positive
	// attempt count. AWS's default is -1.
	MaximumRetryAttempts int
	// MaximumRecordAge is zero for unlimited.
	MaximumRecordAge time.Duration
	// Accept applies FilterCriteria to one record. nil accepts every record.
	Accept func(record streamRecord) bool
}

// streamPoller runs one shard lane.
type streamPoller struct {
	id      string
	env     DelivererEnv
	reader  streamShardReader
	opts    streamPollerOptions
	deliver streamBatchDeliver
	discard streamDiscard

	attempts  map[string]int
	firstSeen map[string]time.Time
	lastSeq   string
}

// newStreamPoller builds one shard lane's poller.
func newStreamPoller(id string, env DelivererEnv, reader streamShardReader, opts streamPollerOptions, deliver streamBatchDeliver, discard streamDiscard) *streamPoller {
	return &streamPoller{
		id:        id,
		env:       env,
		reader:    reader,
		opts:      opts,
		deliver:   deliver,
		discard:   discard,
		attempts:  map[string]int{},
		firstSeen: map[string]time.Time{},
	}
}

// run polls until the context ends or the shard is exhausted. It reports
// polling as soon as it starts and a failure when a read fails.
func (p *streamPoller) run(ctx context.Context) {
	window := p.opts.BatchingWindow
	for {
		if ctx.Err() != nil || p.reader.Done() {
			return
		}
		batch, err := p.read(ctx, window)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if isExpiredStreamIterator(err) {
				if reconnectErr := p.reader.Reconnect(ctx, p.lastSeq); reconnectErr != nil && ctx.Err() == nil {
					p.env.State.Failed(reconnectErr)
					p.env.State.SetPhase(DeliveryPhaseFailed)
					p.logf("stream %s: re-seek after an expired iterator failed: %v", p.id, reconnectErr)
				}
				continue
			}
			p.env.State.Failed(err)
			p.env.State.SetPhase(DeliveryPhaseFailed)
			p.logf("stream %s: read failed: %v", p.id, err)
			sleepWall(ctx, streamRetryBase)
			continue
		}
		if len(batch) == 0 {
			if window <= 0 {
				// Polling a backend is wall-clock, not the run clock: a test
				// clock must not freeze the poller between writes. Only the
				// batching window, retries and record age use the run clock.
				sleepWall(ctx, streamIdlePoll)
			}
			continue
		}
		p.env.State.SetPhase(DeliveryPhasePolling)
		p.process(ctx, batch)
	}
}

// read gathers a batch. With a batching window it keeps reading until the batch
// is full or the run clock reaches the window; without one it is a single read.
func (p *streamPoller) read(ctx context.Context, window time.Duration) ([]streamRecord, error) {
	limit := p.opts.BatchSize
	if limit <= 0 {
		limit = defaultStreamBatchSize
	}
	deadline := p.env.Clock.Now().Add(window)
	var batch []streamRecord
	for {
		want := limit - len(batch)
		if want <= 0 {
			break
		}
		records, err := p.reader.Read(ctx, want)
		if err != nil {
			return batch, err
		}
		for _, record := range records {
			if p.opts.Accept != nil && !p.opts.Accept(record) {
				// The iterator already advanced; a filtered record is dropped,
				// not retried. https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html
				p.env.State.Filtered()
				continue
			}
			batch = append(batch, record)
			if len(batch) >= limit {
				break
			}
		}
		if window <= 0 || len(batch) >= limit {
			break
		}
		if p.env.Clock.Now().After(deadline) || p.env.Clock.Now().Equal(deadline) {
			break
		}
		if len(records) > 0 {
			// More records may be available in the same window. Yield briefly so
			// a slow test clock does not spin on the backend.
			sleepWall(ctx, 20*time.Millisecond)
			continue
		}
		if len(records) == 0 {
			// A test clock closes the window when it is advanced; the loop
			// checks the deadline after each wall-clock poll so records that
			// arrive before an advance are still read.
			sleepWall(ctx, minDuration(streamIdlePoll, deadline.Sub(p.env.Clock.Now())))
		}
	}
	return batch, nil
}

// process delivers records and applies the retry and bisect rules. A partial
// failure keeps the records from the lowest failed sequence number on; a whole
// failure with BisectBatchOnFunctionError retries each half independently.
func (p *streamPoller) process(ctx context.Context, records []streamRecord) {
	if len(records) == 0 || ctx.Err() != nil {
		return
	}
	p.markFirstSeen(records)
	outcome := p.deliver(ctx, records)
	if !outcome.WholeFailure && len(outcome.FailedSequences) == 0 {
		p.env.State.Delivered()
		p.forget(records)
		p.env.State.Left(0)
		return
	}
	if outcome.Err != nil || outcome.WholeFailure || len(outcome.FailedSequences) > 0 {
		// A partial batch response is a processing failure for the records it
		// names; report it even when the invocation itself returned.
		p.env.State.Failed(outcome.Err)
	}
	checkpoint := records
	if len(outcome.FailedSequences) > 0 {
		if index := checkpointIndex(records, outcome.FailedSequences); index >= 0 {
			if index > 0 {
				// The prefix before the checkpoint was processed: AWS advances
				// the checkpoint to the lowest failed sequence number and never
				// re-delivers the prefix.
				p.env.State.Delivered()
			}
			checkpoint = records[index:]
		}
	}
	if outcome.WholeFailure && p.opts.BisectBatchOnFunctionError && len(checkpoint) > 1 {
		middle := len(checkpoint) / 2
		p.process(ctx, checkpoint[:middle])
		p.process(ctx, checkpoint[middle:])
		return
	}
	p.retry(ctx, checkpoint, outcome.Err)
}

// retry retries one checkpoint tail until it succeeds, is discarded for its
// age, or exhausts MaximumRetryAttempts.
func (p *streamPoller) retry(ctx context.Context, records []streamRecord, lastErr error) {
	p.env.State.Left(len(records))
	for {
		if ctx.Err() != nil {
			return
		}
		if expired, condition := p.expired(records); expired {
			p.discardRecords(ctx, records, condition, lastErr)
			return
		}
		attempt := p.nextAttempt(records)
		if p.opts.MaximumRetryAttempts >= 0 && attempt > p.opts.MaximumRetryAttempts {
			p.discardRecords(ctx, records, "MaximumRetryAttempts", lastErr)
			return
		}
		p.wait(ctx, streamRetryDelay(attempt))
		if ctx.Err() != nil {
			return
		}
		outcome := p.deliver(ctx, records)
		if !outcome.WholeFailure && len(outcome.FailedSequences) == 0 {
			p.env.State.Delivered()
			p.forget(records)
			p.env.State.Left(0)
			return
		}
		if outcome.Err != nil || outcome.WholeFailure || len(outcome.FailedSequences) > 0 {
			lastErr = outcome.Err
			p.env.State.Failed(outcome.Err)
		}
		if len(outcome.FailedSequences) > 0 {
			if index := checkpointIndex(records, outcome.FailedSequences); index > 0 {
				// Records before the checkpoint were processed; retry only the
				// tail. https://docs.aws.amazon.com/lambda/latest/dg/services-ddb-batchfailurereporting.html
				p.env.State.Delivered()
				records = records[index:]
				p.env.State.Left(len(records))
			}
		}
	}
}

// discardRecords reports the discarded batch to the destination. A delivery
// that cannot reach the destination is reported but does not block the shard:
// the record is gone locally either way.
func (p *streamPoller) discardRecords(ctx context.Context, records []streamRecord, condition string, lastErr error) {
	attempts := p.attemptsFor(records)
	if p.discard != nil {
		p.discard(ctx, records, condition, attempts, lastErr)
	}
	p.env.State.Discarded(len(records))
	p.forget(records)
	p.env.State.Left(0)
	p.logf("stream %s: discarded %d record(s) (%s) after %d attempt(s)", p.id, len(records), condition, attempts)
}

// expired reports whether any record in the batch exceeded the mapping's
// MaximumRecordAgeInSeconds.
func (p *streamPoller) expired(records []streamRecord) (bool, string) {
	if p.opts.MaximumRecordAge <= 0 {
		return false, ""
	}
	now := p.env.Clock.Now()
	for _, record := range records {
		seen, ok := p.firstSeen[record.Sequence]
		if ok && now.Sub(seen) >= p.opts.MaximumRecordAge {
			return true, "MaximumEventAgeInSeconds"
		}
	}
	return false, ""
}

func (p *streamPoller) markFirstSeen(records []streamRecord) {
	now := p.env.Clock.Now()
	for _, record := range records {
		if _, ok := p.firstSeen[record.Sequence]; !ok {
			p.firstSeen[record.Sequence] = now
		}
	}
}

// nextAttempt records one attempt for every record in the batch and returns
// the highest attempt count.
func (p *streamPoller) nextAttempt(records []streamRecord) int {
	highest := 0
	for _, record := range records {
		p.attempts[record.Sequence]++
		if p.attempts[record.Sequence] > highest {
			highest = p.attempts[record.Sequence]
		}
	}
	return highest
}

func (p *streamPoller) attemptsFor(records []streamRecord) int {
	highest := 0
	for _, record := range records {
		if p.attempts[record.Sequence] > highest {
			highest = p.attempts[record.Sequence]
		}
	}
	return highest
}

func (p *streamPoller) forget(records []streamRecord) {
	for _, record := range records {
		delete(p.attempts, record.Sequence)
		delete(p.firstSeen, record.Sequence)
		if record.Sequence != "" {
			p.lastSeq = record.Sequence
		}
	}
}

// wait waits on the run clock. Retries and record age use it so a test clock
// drives them deterministically.
func (p *streamPoller) wait(ctx context.Context, duration time.Duration) {
	if duration <= 0 {
		return
	}
	select {
	case <-ctx.Done():
	case <-p.env.Clock.After(duration):
	}
}

// sleepWall waits in wall-clock time. Backend polling must never depend on the
// run clock: a test clock is static until a harness advances it, and a poller
// that slept on it would miss every write between advances.
func sleepWall(ctx context.Context, duration time.Duration) {
	if duration <= 0 {
		return
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

func (p *streamPoller) logf(format string, args ...any) {
	if p.env.Logf != nil {
		p.env.Logf(format, args...)
	}
}

// checkpointIndex returns the index of the lowest failed record in the batch,
// using the batch order when several sequence numbers are reported.
func checkpointIndex(records []streamRecord, failed []string) int {
	failedSet := make(map[string]struct{}, len(failed))
	for _, sequence := range failed {
		failedSet[sequence] = struct{}{}
	}
	for index, record := range records {
		if _, ok := failedSet[record.Sequence]; ok {
			return index
		}
	}
	return -1
}

// streamRetryDelay is the local retry backoff: one second, doubling with the
// attempt, capped at five minutes. It is a clock timer, never time.Sleep, so a
// test clock drives it.
func streamRetryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	delay := streamRetryBase
	for index := 1; index < attempt; index++ {
		delay *= 2
		if delay >= streamRetryMaximum {
			return streamRetryMaximum
		}
	}
	return delay
}

// isExpiredStreamIterator recognizes the expired-iterator errors of both
// services.
func isExpiredStreamIterator(err error) bool {
	if err == nil {
		return false
	}
	if isAWSJSONError(err, "ExpiredIteratorException", "TrimmedDataAccessException") {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "expirediterator") ||
		strings.Contains(message, "expired iterator") ||
		strings.Contains(message, "trimmeddataaccess")
}

// defaultStreamBatchSize is the AWS default batch size for a stream mapping.
const defaultStreamBatchSize = 100

// streamReaderError wraps a read error with the shard it came from. The wrap
// keeps the service error type so an expired iterator is still recognized.
func streamReaderError(shard string, err error) error {
	return fmt.Errorf("stream shard %s: %w", shard, err)
}
