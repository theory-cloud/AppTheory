package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

// The SQS deliverer is the local counterpart of the Lambda poller for an SQS
// event source mapping. It reproduces the documented behavior of "Using Lambda
// with Amazon SQS"
// (https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html) on ElasticMQ:
//
//   - a batch is gathered up to BatchSize, or for MaximumBatchingWindowInSeconds
//     when the mapping declares one;
//   - messages are received with the queue's visibility timeout and are never
//     given a longer visibility timeout while a batch is in flight;
//   - a successful batch deletes every message; a failed invocation deletes
//     none, so the messages return after the visibility timeout;
//   - ReportBatchItemFailures leaves only the reported messages, and a
//     malformed response or an identifier outside the batch fails the batch;
//   - a FIFO queue processes one batch per message group and keeps the order of
//     a failed group: the failed record and every later record of that group
//     stay in the queue;
//   - FilterCriteria is evaluated as Lambda documents and non-matching
//     messages are deleted without invoking the function;
//   - ScalingConfig.MaximumConcurrency bounds concurrent batches per mapping,
//     within the engine's global invocation bound.
//
// ElasticMQ observations that this implementation normalizes are documented in
// docs/examples/local-runner.md: QueueUrl responses name the container's
// localhost address (rewritten to the published loopback endpoint), queue ARNs
// use region "elasticmq" (the record carries the CDK-resolved ARN), named
// GetQueueAttributes subsets return an empty map (the deliverer asks for All),
// receipt handles rotate on every receive, and FIFO SequenceNumber values start
// at "0" (the value is passed through as an opaque string).

const (
	sqsReceiveMax                = 10
	sqsDefaultBatchSize          = 10
	sqsDefaultVisibility         = 30 * time.Second
	sqsMaxBatchSize              = 10000
	sqsReceiveWaitSeconds        = 1
	sqsErrorBackoff              = 250 * time.Millisecond
	sqsDeleteBatchLimit          = 10
	sqsFIFOMaximumBatchSize      = 10
	sqsVisibilityReapImmediately = 0
)

// SQSDeliverer polls one SQS event source mapping.
type SQSDeliverer struct {
	source  DeliverySource
	mapping EventSourceSpec
	queue   sqsQueueRuntime
	clock   Clock
	log     func(format string, args ...any)

	mu              sync.Mutex
	inflight        map[string]*sqsInflightMessage
	inflightBatches int32
}

type sqsQueueRuntime struct {
	URL             string
	ARN             string
	Visibility      time.Duration
	FIFO            bool
	MaxReceiveCount int
}

type sqsInflightMessage struct {
	messageID string
	receipt   string
	deadline  time.Time
}

// NewSQSDeliverer builds the SQS deliverer for one registered mapping.
func NewSQSDeliverer(source DeliverySource) (Deliverer, error) {
	if source.Mapping == nil || source.Mapping.Type != backendSQS {
		return nil, fmt.Errorf("source %s is not an SQS event source mapping", source.ID)
	}
	mapping := *source.Mapping
	if mapping.BatchSize <= 0 {
		mapping.BatchSize = sqsDefaultBatchSize
	}
	return &SQSDeliverer{
		source:   source,
		mapping:  mapping,
		inflight: map[string]*sqsInflightMessage{},
	}, nil
}

// Start resolves the queue, reports polling and runs the mapping's pollers
// until ctx is canceled.
func (d *SQSDeliverer) Start(ctx context.Context, env DelivererEnv) error {
	client, ok := env.Backend.Client.(*sqs.Client)
	if !ok || client == nil {
		return errors.New("the SQS delivery backend has no SQS client")
	}
	if env.Clock == nil {
		env.Clock = RealClock{}
	}
	d.clock = env.Clock
	d.log = env.Logf
	queue, err := d.resolveQueue(ctx, env, client)
	if err != nil {
		return err
	}
	d.queue = queue
	if !d.mapping.Enabled {
		env.State.SetPaused(true)
		env.State.SetPhase(DeliveryPhasePaused)
		<-ctx.Done()
		return nil
	}
	env.State.SetPaused(false)
	env.State.SetPhase(DeliveryPhasePolling)
	if queue.FIFO {
		d.poll(ctx, env, client)
		return nil
	}
	concurrent := d.mapping.MaximumConcurrency
	if concurrent <= 0 {
		concurrent = env.Concurrency
	}
	if concurrent <= 0 {
		concurrent = 1
	}
	if env.Concurrency > 0 && concurrent > env.Concurrency {
		concurrent = env.Concurrency
	}
	var wait sync.WaitGroup
	for index := 0; index < concurrent; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			d.poll(ctx, env, client)
		}()
	}
	wait.Wait()
	return nil
}

// resolveQueue maps the queue name to the published loopback endpoint and reads
// the queue's visibility, FIFO and redrive settings.
func (d *SQSDeliverer) resolveQueue(ctx context.Context, env DelivererEnv, client *sqs.Client) (sqsQueueRuntime, error) {
	found, err := client.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{QueueName: aws.String(d.mapping.SourceName)})
	if err != nil {
		return sqsQueueRuntime{}, fmt.Errorf("resolve SQS queue %s: %w", d.mapping.SourceName, err)
	}
	queueURL, err := rewriteQueueURL(aws.ToString(found.QueueUrl), env.Backend.Endpoint)
	if err != nil {
		return sqsQueueRuntime{}, fmt.Errorf("rewrite the local SQS queue URL for %s: %w", d.mapping.SourceName, err)
	}
	attributes, err := client.GetQueueAttributes(ctx, &sqs.GetQueueAttributesInput{
		QueueUrl: aws.String(queueURL),
		// ElasticMQ returns an empty map for a named attribute subset; "All"
		// is the observed working request.
		AttributeNames: []sqstypes.QueueAttributeName{sqstypes.QueueAttributeNameAll},
	})
	if err != nil {
		return sqsQueueRuntime{}, fmt.Errorf("read attributes for local SQS queue %s: %w", d.mapping.SourceName, err)
	}
	values := attributes.Attributes
	runtime := sqsQueueRuntime{
		URL:             queueURL,
		ARN:             strings.TrimSpace(values[string(sqstypes.QueueAttributeNameQueueArn)]),
		Visibility:      sqsDefaultVisibility,
		FIFO:            strings.EqualFold(strings.TrimSpace(values[string(sqstypes.QueueAttributeNameFifoQueue)]), boolTrue) || d.mapping.FIFO,
		MaxReceiveCount: d.mapping.MaxReceiveCount,
	}
	if raw := strings.TrimSpace(values[string(sqstypes.QueueAttributeNameVisibilityTimeout)]); raw != "" {
		seconds, parseErr := parseIntJSON(json.RawMessage(raw))
		if parseErr == nil && seconds >= 0 {
			runtime.Visibility = time.Duration(seconds) * time.Second
		}
	}
	if policy := strings.TrimSpace(values[string(sqstypes.QueueAttributeNameRedrivePolicy)]); policy != "" {
		runtime.MaxReceiveCount = sqsMaxReceiveCount(json.RawMessage(policy))
	}
	return runtime, nil
}

// poll runs one receive/deliver loop. Every wait observes ctx so the engine's
// five-second drain-and-stop budget is respected.
func (d *SQSDeliverer) poll(ctx context.Context, env DelivererEnv, client *sqs.Client) {
	for {
		if ctx.Err() != nil {
			return
		}
		batch, err := d.receiveBatch(ctx, env, client)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			env.State.SetPhase(DeliveryPhaseFailed)
			env.State.Failed(err)
			d.logf("SQS mapping %s: receive failed: %v", d.source.ID, err)
			d.wait(ctx, sqsErrorBackoff)
			continue
		}
		if len(batch) == 0 {
			continue
		}
		// A failed invocation keeps reporting failed with its last error until
		// the next batch starts, which is the local counterpart of
		// LastProcessingResult.
		env.State.SetPhase(DeliveryPhasePolling)
		d.processBatch(ctx, env, client, batch)
	}
}

// receiveBatch gathers a batch for one mapping. A zero batching window invokes
// the function with whatever one receive returned; a positive window keeps
// gathering until the batch is full or the run clock reaches the window.
func (d *SQSDeliverer) receiveBatch(ctx context.Context, env DelivererEnv, client *sqs.Client) ([]sqstypes.Message, error) {
	batchSize := d.batchSize()
	window := time.Duration(d.mapping.MaximumBatchingWindowInSeconds) * time.Second
	if window <= 0 {
		return d.receiveOnce(ctx, env, client, minInt(batchSize, sqsReceiveMax), sqsReceiveWaitSeconds)
	}
	deadline := env.Clock.Now().Add(window)
	var messages []sqstypes.Message
	for len(messages) < batchSize {
		if ctx.Err() != nil {
			return messages, ctx.Err()
		}
		remaining := deadline.Sub(env.Clock.Now())
		if remaining <= 0 {
			break
		}
		want := minInt(batchSize-len(messages), sqsReceiveMax)
		received, err := d.receiveOnce(ctx, env, client, want, sqsReceiveWaitSeconds)
		if err != nil {
			return messages, err
		}
		messages = append(messages, received...)
		if len(messages) >= batchSize || deadline.Sub(env.Clock.Now()) <= 0 {
			break
		}
		if len(received) > 0 {
			// More messages may be available in the same window; keep
			// receiving without spending a poll interval.
			continue
		}
		// Wait for the batching window or the stop. A test clock fires this
		// timer when the harness advances it, which is what closes the window
		// deterministically.
		d.wait(ctx, minDuration(remaining, time.Second))
	}
	// Pick up anything that arrived while the window was closing.
	for len(messages) < batchSize {
		want := minInt(batchSize-len(messages), sqsReceiveMax)
		received, err := d.receiveOnce(ctx, env, client, want, 0)
		if err != nil {
			return messages, err
		}
		if len(received) == 0 {
			break
		}
		messages = append(messages, received...)
	}
	return messages, nil
}

func (d *SQSDeliverer) receiveOnce(ctx context.Context, env DelivererEnv, client *sqs.Client, count, waitSeconds int) ([]sqstypes.Message, error) {
	if count <= 0 {
		return nil, nil
	}
	if count > sqsReceiveMax {
		count = sqsReceiveMax
	}
	input := &sqs.ReceiveMessageInput{
		QueueUrl:                    aws.String(d.queue.URL),
		MaxNumberOfMessages:         int32(count), //nolint:gosec // count is clamped to 1..10 above
		MessageSystemAttributeNames: []sqstypes.MessageSystemAttributeName{sqstypes.MessageSystemAttributeNameAll},
		MessageAttributeNames:       []string{"All"},
	}
	if waitSeconds > 0 {
		input.WaitTimeSeconds = int32(waitSeconds) //nolint:gosec // the only value is 1
	}
	output, err := client.ReceiveMessage(ctx, input)
	if err != nil {
		return nil, err
	}
	for _, message := range output.Messages {
		if entry := d.track(envMessageID(message), message.ReceiptHandle, d.queue.Visibility); entry != nil {
			// The visibility deadline is watched from the moment of receipt,
			// so a batch that is still in flight when the run clock reaches
			// the timeout is AWS's redelivery case even while the handler runs.
			go d.reapOne(ctx, env, client, entry)
		}
	}
	return output.Messages, nil
}

// track records a message's visibility deadline on the run clock. The deadline
// is what makes a failed batch redeliver deterministically when a test clock is
// advanced; it never extends the visibility timeout ElasticMQ applied.
func (d *SQSDeliverer) track(messageID string, receipt *string, visibility time.Duration) *sqsInflightMessage {
	if messageID == "" {
		return nil
	}
	entry := &sqsInflightMessage{
		messageID: messageID,
		receipt:   aws.ToString(receipt),
		deadline:  d.clockNow().Add(visibility),
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.inflight[messageID] = entry
	return entry
}

// clockNow is replaced by the deliverer's own clock when it starts; before then
// the zero deadline is harmless.
func (d *SQSDeliverer) clockNow() time.Time {
	if d.clock == nil {
		return time.Now().UTC()
	}
	return d.clock.Now()
}

// processBatch applies filter criteria, invokes the function and deletes exactly
// the records AWS would delete.
//
//nolint:gocyclo // each branch is one AWS batch outcome.
func (d *SQSDeliverer) processBatch(ctx context.Context, env DelivererEnv, client *sqs.Client, batch []sqstypes.Message) {
	queueARN := d.mapping.SourceARN
	if queueARN == "" {
		queueARN = d.queue.ARN
	}

	matching := make([]sqstypes.Message, 0, len(batch))
	var filtered []sqstypes.Message
	if len(d.mapping.FilterCriteria) > 0 {
		for _, message := range batch {
			record := sqsRecordMap(queueARN, message)
			if sqsRecordMatchesFilters(d.mapping.FilterCriteria, record, aws.ToString(message.Body)) {
				matching = append(matching, message)
			} else {
				filtered = append(filtered, message)
			}
		}
	} else {
		matching = batch
	}
	if len(filtered) > 0 {
		// AWS removes messages that do not satisfy the filter criteria and does
		// not invoke the function for them.
		d.deleteMessages(ctx, client, filtered)
		d.logf("SQS mapping %s: deleted %d message(s) that matched no FilterCriteria", d.source.ID, len(filtered))
		for _, message := range filtered {
			d.forget(envMessageID(message), aws.ToString(message.ReceiptHandle))
		}
	}
	if len(matching) == 0 {
		return
	}

	event, err := BuildSQSEvent(queueARN, matching)
	if err != nil {
		env.State.Failed(err)
		env.State.SetPhase(DeliveryPhaseFailed)
		d.logf("SQS mapping %s: build event: %v", d.source.ID, err)
		return
	}
	result, err := d.invoke(ctx, env, event)
	if err != nil {
		env.State.Failed(err)
		env.State.SetPhase(DeliveryPhaseFailed)
		env.State.Left(len(matching))
		d.logf("SQS mapping %s: invocation failed for %d record(s): %v", d.source.ID, len(matching), err)
		return
	}
	if result.HandlerError != "" {
		handlerErr := errors.New(result.HandlerError)
		env.State.Failed(handlerErr)
		env.State.SetPhase(DeliveryPhaseFailed)
		env.State.Left(len(matching))
		d.logf("SQS mapping %s: handler error for %d record(s): %s", d.source.ID, len(matching), result.HandlerError)
		return
	}

	failed, wholeFailure, err := d.batchFailures(result, matching)
	if err != nil {
		wholeFailure = true
	}
	if wholeFailure {
		reason := "the batch response is invalid"
		if err != nil {
			reason = err.Error()
		}
		batchErr := errors.New(reason)
		env.State.Failed(batchErr)
		env.State.SetPhase(DeliveryPhaseFailed)
		env.State.Left(len(matching))
		d.logf("SQS mapping %s: %s; leaving all %d record(s) for redelivery", d.source.ID, reason, len(matching))
		return
	}

	if d.queue.FIFO {
		failed = d.protectFIFOOrder(matching, failed)
	}
	successes := make([]sqstypes.Message, 0, len(matching))
	remaining := 0
	for _, message := range matching {
		if failed[envMessageID(message)] {
			remaining++
			continue
		}
		successes = append(successes, message)
	}
	if len(successes) > 0 {
		d.deleteMessages(ctx, client, successes)
		for _, message := range successes {
			d.forget(envMessageID(message), aws.ToString(message.ReceiptHandle))
		}
	}
	env.State.Delivered()
	if remaining > 0 {
		env.State.Left(remaining)
	}
	env.State.SetPhase(DeliveryPhasePolling)
	d.logf(
		"SQS mapping %s: delivered %d record(s), left %d for redelivery",
		d.source.ID,
		len(successes),
		remaining,
	)
}

// invoke performs one handler invocation and reports the live batch count, so
// a mapping's MaximumConcurrency is observable from session describe.
func (d *SQSDeliverer) invoke(ctx context.Context, env DelivererEnv, event []byte) (InvokeResult, error) {
	current := int(atomic.AddInt32(&d.inflightBatches, 1))
	env.State.SetInflight(current)
	defer func() {
		env.State.SetInflight(int(atomic.AddInt32(&d.inflightBatches, -1)))
	}()
	return env.Invoke(ctx, event)
}

// batchFailures interprets the function response. It reports the set of
// message ids to leave undeleted, whether the whole batch must be retried, and
// the malformed-response error.
//
// AWS treats an empty or null batchItemFailures list, an empty response and a
// null response as success, and treats invalid JSON, a bad key name, an empty
// or null itemIdentifier and an identifier outside the batch as a complete
// failure:
// https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html
//
//nolint:gocyclo // the validation branches are the documented responses.
func (d *SQSDeliverer) batchFailures(result InvokeResult, batch []sqstypes.Message) (map[string]bool, bool, error) {
	if !d.mapping.ReportBatchItemFailures {
		return map[string]bool{}, false, nil
	}
	if result.Proxy {
		return nil, true, errors.New("the handler returned a proxy response where a batchItemFailures response is required")
	}
	raw := strings.TrimSpace(string(result.Raw))
	if raw == "" || raw == "null" {
		return map[string]bool{}, false, nil
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, true, fmt.Errorf("invalid batch response JSON: %w", err)
	}
	if decoder.More() {
		return nil, true, errors.New("the batch response has content after the JSON value")
	}
	response, ok := value.(map[string]any)
	if !ok {
		return nil, true, errors.New("the batch response is not a JSON object")
	}
	rawFailures, exists := response["batchItemFailures"]
	if !exists || rawFailures == nil {
		return map[string]bool{}, false, nil
	}
	items, ok := rawFailures.([]any)
	if !ok {
		return nil, true, errors.New("batchItemFailures is not a list")
	}
	known := make(map[string]bool, len(batch))
	for _, message := range batch {
		known[envMessageID(message)] = true
	}
	failed := make(map[string]bool, len(items))
	for index, item := range items {
		object, ok := item.(map[string]any)
		if !ok {
			return nil, true, fmt.Errorf("batchItemFailures[%d] is not an object", index)
		}
		identifier, ok := object["itemIdentifier"].(string)
		if !ok || strings.TrimSpace(identifier) == "" {
			return nil, true, fmt.Errorf("batchItemFailures[%d] has no non-empty itemIdentifier", index)
		}
		if !known[identifier] {
			return nil, true, fmt.Errorf("batchItemFailures[%d] names message %s, which is not in the batch", index, identifier)
		}
		failed[identifier] = true
	}
	return failed, false, nil
}

// protectFIFOOrder leaves the first failed record of each message group and
// every later record of that group undeleted, so a failed group cannot overtake
// its failure. AWS documents this ordering requirement for FIFO queues:
// https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html
func (d *SQSDeliverer) protectFIFOOrder(batch []sqstypes.Message, failed map[string]bool) map[string]bool {
	blocked := map[string]bool{}
	for _, message := range batch {
		id := envMessageID(message)
		group := message.Attributes[string(sqstypes.MessageSystemAttributeNameMessageGroupId)]
		if failed[id] {
			blocked[group] = true
			continue
		}
		if blocked[group] {
			failed[id] = true
		}
	}
	return failed
}

// deleteMessages deletes records in SQS's documented 10-entry batches.
func (d *SQSDeliverer) deleteMessages(ctx context.Context, client *sqs.Client, messages []sqstypes.Message) {
	for start := 0; start < len(messages); start += sqsDeleteBatchLimit {
		end := minInt(start+sqsDeleteBatchLimit, len(messages))
		chunk := messages[start:end]
		entries := make([]sqstypes.DeleteMessageBatchRequestEntry, 0, len(chunk))
		for index, message := range chunk {
			if message.ReceiptHandle == nil {
				continue
			}
			entries = append(entries, sqstypes.DeleteMessageBatchRequestEntry{
				Id:            aws.String(fmt.Sprintf("%d", index)),
				ReceiptHandle: message.ReceiptHandle,
			})
		}
		if len(entries) == 0 {
			continue
		}
		output, err := client.DeleteMessageBatch(ctx, &sqs.DeleteMessageBatchInput{
			QueueUrl: aws.String(d.queue.URL),
			Entries:  entries,
		})
		if err != nil {
			d.logf("SQS mapping %s: delete batch failed: %v", d.source.ID, err)
			continue
		}
		for _, failure := range output.Failed {
			d.logf(
				"SQS mapping %s: delete %s failed: %s %s",
				d.source.ID,
				aws.ToString(failure.Id),
				aws.ToString(failure.Code),
				aws.ToString(failure.Message),
			)
		}
		for _, success := range output.Successful {
			index, parseErr := parseIntJSON(json.RawMessage(aws.ToString(success.Id)))
			if parseErr != nil || index < 0 || index >= len(chunk) {
				continue
			}
			d.forget(envMessageID(chunk[index]), aws.ToString(chunk[index].ReceiptHandle))
		}
	}
}

func (d *SQSDeliverer) reapOne(ctx context.Context, env DelivererEnv, client *sqs.Client, entry *sqsInflightMessage) {
	wait := entry.deadline.Sub(env.Clock.Now())
	if wait < 0 {
		wait = 0
	}
	timer := env.Clock.After(wait)
	select {
	case <-ctx.Done():
		return
	case <-timer:
	}
	d.mu.Lock()
	current, ok := d.inflight[entry.messageID]
	d.mu.Unlock()
	if !ok || current.receipt != entry.receipt {
		return
	}
	_, err := client.ChangeMessageVisibility(ctx, &sqs.ChangeMessageVisibilityInput{
		QueueUrl:          aws.String(d.queue.URL),
		ReceiptHandle:     aws.String(entry.receipt),
		VisibilityTimeout: sqsVisibilityReapImmediately,
	})
	if err != nil && ctx.Err() == nil {
		// The message may already have become visible or been deleted by
		// ElasticMQ's own timer; either way there is nothing left to do.
		d.logf("SQS mapping %s: visibility expiry for %s: %v", d.source.ID, entry.messageID, err)
	}
	d.mu.Lock()
	if current, ok := d.inflight[entry.messageID]; ok && current.receipt == entry.receipt {
		delete(d.inflight, entry.messageID)
	}
	d.mu.Unlock()
}

func (d *SQSDeliverer) forget(messageID, receipt string) {
	if messageID == "" {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if entry, ok := d.inflight[messageID]; ok && entry.receipt == receipt {
		delete(d.inflight, messageID)
	}
}

func (d *SQSDeliverer) batchSize() int {
	size := d.mapping.BatchSize
	if size <= 0 {
		size = sqsDefaultBatchSize
	}
	if d.queue.FIFO && size > sqsFIFOMaximumBatchSize {
		size = sqsFIFOMaximumBatchSize
	}
	if size > sqsMaxBatchSize {
		size = sqsMaxBatchSize
	}
	return size
}

func (d *SQSDeliverer) logf(format string, args ...any) {
	if d.log != nil {
		d.log(format, args...)
	}
}

func (d *SQSDeliverer) wait(ctx context.Context, duration time.Duration) {
	if duration <= 0 {
		return
	}
	select {
	case <-ctx.Done():
	case <-d.clock.After(duration):
	}
}

func envMessageID(message sqstypes.Message) string {
	return aws.ToString(message.MessageId)
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func minDuration(left, right time.Duration) time.Duration {
	if left < right {
		return left
	}
	return right
}
