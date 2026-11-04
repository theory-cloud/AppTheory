package localrunner

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kinesis"
	kinestypes "github.com/aws/aws-sdk-go-v2/service/kinesis/types"
)

// The Kinesis deliverer is the local counterpart of the Lambda poller for a
// Kinesis event source mapping. It reproduces the documented behavior of
// "Using Lambda to process records from Amazon Kinesis Data Streams"
// (https://docs.aws.amazon.com/lambda/latest/dg/with-kinesis.html) and its
// partial-batch page
// (https://docs.aws.amazon.com/lambda/latest/dg/services-kinesis-batchfailurereporting.html)
// on the pinned moto Kinesis.
//
// Where the semantics coincide with DynamoDB Streams, this deliverer shares the
// stream poller core in stream_poller.go: batching, batching window on the run
// clock, filter criteria, partial failures, bisect on error, retry attempts,
// record age, the on-failure invocation record and iterator re-seek. Kinesis
// differs in three places:
//   - the starting positions are TRIM_HORIZON, LATEST and AT_TIMESTAMP;
//   - records carry a partition key, and ParallelizationFactor preserves order
//     per partition key;
//   - the event's record shape is the documented Kinesis record, not the
//     DynamoDB stream record.
//
// Moto observations the runner normalizes are documented in
// docs/examples/local-runner.md: sequence numbers are small decimals starting
// at "1" and are passed through as opaque strings, and the pinned image does
// not split or merge shards.

// KinesisDeliverer polls one Kinesis event source mapping.
type KinesisDeliverer struct {
	source  DeliverySource
	mapping EventSourceSpec
	client  *kinesis.Client
	stream  string
}

// NewKinesisDeliverer builds the deliverer for one registered mapping.
func NewKinesisDeliverer(source DeliverySource) (Deliverer, error) {
	if source.Mapping == nil || source.Mapping.Type != backendKinesis {
		return nil, fmt.Errorf("source %s is not a Kinesis event source mapping", source.ID)
	}
	mapping := *source.Mapping
	if mapping.BatchSize <= 0 {
		mapping.BatchSize = defaultStreamBatchSize
	}
	if mapping.ParallelizationFactor <= 0 {
		mapping.ParallelizationFactor = 1
	}
	return &KinesisDeliverer{source: source, mapping: mapping}, nil
}

// Start resolves the provisioned stream and polls its shards.
func (d *KinesisDeliverer) Start(ctx context.Context, env DelivererEnv) error {
	client, ok := env.Backend.Client.(*kinesis.Client)
	if !ok || client == nil {
		return errors.New("the Kinesis delivery backend has no Kinesis client")
	}
	d.client = client
	d.stream = d.mapping.SourceARN
	if d.stream == "" {
		d.stream = localSourceARN(backendKinesis, d.mapping.SourceName)
	}
	if !d.mapping.Enabled {
		env.State.SetPaused(true)
		env.State.SetPhase(DeliveryPhasePaused)
		<-ctx.Done()
		return nil
	}
	if _, err := client.DescribeStreamSummary(ctx, &kinesis.DescribeStreamSummaryInput{
		StreamName: aws.String(d.mapping.SourceName),
	}); err != nil {
		return fmt.Errorf("describe local Kinesis stream %s: %w", d.mapping.SourceName, err)
	}
	env.State.SetPaused(false)
	env.State.SetPhase(DeliveryPhasePolling)
	d.pollShards(ctx, env)
	return nil
}

// pollShards starts one poller lane per shard and periodically re-reads the
// shard list. The pinned moto stream never splits, but a DescribeStream poll
// keeps the loop honest for an emulator that adds shards.
func (d *KinesisDeliverer) pollShards(ctx context.Context, env DelivererEnv) {
	started := map[string]bool{}
	for {
		if ctx.Err() != nil {
			return
		}
		shards, err := d.shards(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			env.State.Failed(err)
			env.State.SetPhase(DeliveryPhaseFailed)
			env.Logf("Kinesis stream %s: list shards failed: %v", d.source.ID, err)
			sleepWall(ctx, streamRetryBase)
			continue
		}
		factor := d.mapping.ParallelizationFactor
		if factor > 10 {
			factor = 10
		}
		for _, shard := range shards {
			for lane := 0; lane < factor; lane++ {
				key := shard + "#" + fmt.Sprint(lane)
				if started[key] {
					continue
				}
				started[key] = true
				reader := &kinesisShardReader{
					deliverer: d,
					shard:     shard,
					lane:      lane,
					lanes:     factor,
					position:  d.mapping.StartingPosition,
					timestamp: d.mapping.StartingPositionTimestamp,
				}
				poller := newStreamPoller(
					d.source.ID+"/"+shard,
					env,
					reader,
					d.pollerOptions(env),
					d.deliver(env),
					d.discard(env),
				)
				go poller.run(ctx)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

func (d *KinesisDeliverer) shards(ctx context.Context) ([]string, error) {
	out, err := d.client.ListShards(ctx, &kinesis.ListShardsInput{StreamName: aws.String(d.mapping.SourceName)})
	if err != nil {
		return nil, err
	}
	shards := make([]string, 0, len(out.Shards))
	for _, shard := range out.Shards {
		if id := strings.TrimSpace(aws.ToString(shard.ShardId)); id != "" {
			shards = append(shards, id)
		}
	}
	return shards, nil
}

func (d *KinesisDeliverer) pollerOptions(env DelivererEnv) streamPollerOptions {
	maxAttempts := d.mapping.MaximumRetryAttempts
	if maxAttempts == 0 && !d.mapping.RetryAttemptsSet {
		maxAttempts = streamUnlimitedRetries
	}
	maxAge := time.Duration(0)
	if d.mapping.MaximumRecordAgeInSeconds > 0 {
		maxAge = time.Duration(d.mapping.MaximumRecordAgeInSeconds) * time.Second
	}
	return streamPollerOptions{
		BatchSize:                  d.mapping.BatchSize,
		BatchingWindow:             time.Duration(d.mapping.MaximumBatchingWindowInSeconds) * time.Second,
		BisectBatchOnFunctionError: d.mapping.BisectBatchOnFunctionError,
		MaximumRetryAttempts:       maxAttempts,
		MaximumRecordAge:           maxAge,
		Accept: func(record streamRecord) bool {
			if _, ok := record.Value.(KinesisRecordInput); !ok {
				return true
			}
			target, err := kinesisRecordMap(record, d.stream)
			if err != nil {
				env.State.Failed(err)
				env.Logf("Kinesis stream %s: FilterCriteria could not be evaluated: %v", d.source.ID, err)
				return false
			}
			matched, err := recordMatchesEventFilters(d.mapping.FilterCriteria, target)
			if err != nil {
				env.State.Failed(err)
				env.Logf("Kinesis stream %s: FilterCriteria could not be evaluated: %v", d.source.ID, err)
				return false
			}
			return matched
		},
	}
}

// deliver builds the documented Kinesis event and interprets the response.
func (d *KinesisDeliverer) deliver(env DelivererEnv) streamBatchDeliver {
	return func(ctx context.Context, records []streamRecord) streamBatchOutcome {
		inputs := make([]KinesisRecordInput, 0, len(records))
		for _, record := range records {
			if value, ok := record.Value.(KinesisRecordInput); ok {
				inputs = append(inputs, value)
			}
		}
		event, err := BuildKinesisEvent(d.stream, inputs, env.Clock.Now())
		if err != nil {
			env.State.Failed(err)
			return streamBatchOutcome{WholeFailure: true, Err: err}
		}
		result, err := env.Invoke(ctx, event)
		if err != nil {
			return streamBatchOutcome{WholeFailure: true, Err: err}
		}
		if result.HandlerError != "" {
			return streamBatchOutcome{WholeFailure: true, Err: errors.New(result.HandlerError)}
		}
		if !d.mapping.ReportBatchItemFailures {
			return streamBatchOutcome{}
		}
		failed, whole, err := streamBatchFailureIdentifiers(result)
		if err != nil || whole {
			if err == nil {
				err = errors.New("the batch response is invalid")
			}
			return streamBatchOutcome{WholeFailure: true, Err: err}
		}
		return streamBatchOutcome{FailedSequences: failed}
	}
}

// discard sends the documented invocation record to the on-failure destination.
//
//nolint:dupl // the DynamoDB discard callback differs only in its batch-info key.
func (d *KinesisDeliverer) discard(env DelivererEnv) streamDiscard {
	return func(ctx context.Context, records []streamRecord, condition string, attempts int, lastErr error) {
		if d.mapping.DestinationType == "" {
			return
		}
		body, err := d.discardRecord(env, records, condition, attempts, lastErr)
		if err != nil {
			env.State.Failed(err)
			env.Logf("Kinesis stream %s: build on-failure record: %v", d.source.ID, err)
			return
		}
		if err := sendStreamDiscard(ctx, env, d.mapping, body); err != nil {
			env.State.Failed(err)
			env.Logf("Kinesis stream %s: send on-failure record: %v", d.source.ID, err)
			return
		}
	}
}

func (d *KinesisDeliverer) discardRecord(env DelivererEnv, records []streamRecord, condition string, attempts int, lastErr error) ([]byte, error) {
	if len(records) == 0 {
		return nil, errors.New("no records to discard")
	}
	first := records[0]
	last := records[len(records)-1]
	record := map[string]any{
		"version":   "1.0",
		"timestamp": env.Clock.Now().UTC().Format(time.RFC3339Nano),
		"requestContext": map[string]any{
			"requestId":              NewRequestID(),
			"functionArn":            "arn:" + LocalPartition + ":lambda:" + LocalRegion + ":" + LocalAccountID + ":function:" + d.mapping.FunctionName,
			"condition":              discardCondition(condition),
			"approximateInvokeCount": attempts,
		},
		"responseContext": map[string]any{
			"statusCode":      200,
			"executedVersion": "$LATEST",
			"functionError":   discardError(lastErr),
		},
		"KinesisBatchInfo": map[string]any{
			"shardId":                         first.Shard,
			"startSequenceNumber":             first.Sequence,
			"endSequenceNumber":               last.Sequence,
			"approximateArrivalOfFirstRecord": first.Arrival.UTC().Format(time.RFC3339),
			"approximateArrivalOfLastRecord":  last.Arrival.UTC().Format(time.RFC3339),
			"batchSize":                       len(records),
			"streamArn":                       d.stream,
		},
	}
	return json.Marshal(record)
}

// kinesisShardReader is one lane's reader for one shard.
type kinesisShardReader struct {
	deliverer *KinesisDeliverer
	shard     string
	lane      int
	lanes     int
	position  string
	timestamp float64
	iterator  string
	last      string
	done      bool
}

func (r *kinesisShardReader) Read(ctx context.Context, limit int) ([]streamRecord, error) {
	if r.done {
		return nil, nil
	}
	if r.iterator == "" {
		if err := r.Reconnect(ctx, ""); err != nil {
			return nil, err
		}
	}
	out, err := r.deliverer.client.GetRecords(ctx, &kinesis.GetRecordsInput{
		ShardIterator: aws.String(r.iterator),
		Limit:         aws.Int32(int32(minInt(limit, 10000))), //nolint:gosec // limit is clamped above
	})
	if err != nil {
		return nil, streamReaderError(r.shard, err)
	}
	if out.NextShardIterator == nil || strings.TrimSpace(*out.NextShardIterator) == "" {
		r.done = true
	} else {
		r.iterator = *out.NextShardIterator
	}
	records := make([]streamRecord, 0, len(out.Records))
	for _, record := range out.Records {
		sequence := strings.TrimSpace(aws.ToString(record.SequenceNumber))
		if sequence == "" {
			continue
		}
		partition := aws.ToString(record.PartitionKey)
		if r.lanes > 1 && streamLane(partition, r.lanes) != r.lane {
			continue
		}
		arrival := time.Now().UTC()
		if record.ApproximateArrivalTimestamp != nil {
			arrival = *record.ApproximateArrivalTimestamp
		}
		records = append(records, streamRecord{
			Sequence:  sequence,
			Partition: partition,
			Shard:     r.shard,
			Arrival:   arrival,
			Value: KinesisRecordInput{
				Data:           record.Data,
				PartitionKey:   partition,
				SequenceNumber: sequence,
				Arrival:        arrival,
			},
		})
		r.last = sequence
	}
	return records, nil
}

func (r *kinesisShardReader) Reconnect(ctx context.Context, afterSequence string) error {
	iteratorType := strings.ToUpper(strings.TrimSpace(r.position))
	if iteratorType == "" {
		iteratorType = dynamoStreamIteratorTrimHorizon
	}
	input := &kinesis.GetShardIteratorInput{
		StreamName:        aws.String(r.deliverer.mapping.SourceName),
		ShardId:           aws.String(r.shard),
		ShardIteratorType: kinestypes.ShardIteratorType(iteratorType),
	}
	if afterSequence != "" {
		input.ShardIteratorType = kinestypes.ShardIteratorTypeAfterSequenceNumber
		input.StartingSequenceNumber = aws.String(afterSequence)
	}
	if iteratorType == iteratorAtTimestamp {
		input.Timestamp = aws.Time(time.Unix(int64(r.timestamp), 0).UTC())
	}
	out, err := r.deliverer.client.GetShardIterator(ctx, input)
	if err != nil {
		return streamReaderError(r.shard, err)
	}
	if out.ShardIterator == nil || strings.TrimSpace(*out.ShardIterator) == "" {
		return fmt.Errorf("stream shard %s: GetShardIterator returned no iterator", r.shard)
	}
	r.iterator = *out.ShardIterator
	return nil
}

func (r *kinesisShardReader) Done() bool { return r.done }

// kinesisRecordMap builds the object FilterCriteria is evaluated against. For
// Kinesis the filter data key is `data`, whose value is the base64-encoded
// record payload as the Lambda event carries it:
// https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventfiltering.html
func kinesisRecordMap(record streamRecord, streamARN string) (map[string]any, error) {
	value, ok := record.Value.(KinesisRecordInput)
	if !ok {
		return nil, errors.New("the Kinesis record has an unexpected shape")
	}
	return map[string]any{
		"eventSource":    "aws:kinesis",
		"eventSourceARN": streamARN,
		"awsRegion":      LocalRegion,
		"kinesis": map[string]any{
			"partitionKey":   value.PartitionKey,
			"sequenceNumber": value.SequenceNumber,
			"data":           base64Encode(value.Data),
		},
	}, nil
}

func base64Encode(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}
