package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// dynamoDBLocalBackend is the DeliveryBackend.Client for a DynamoDB Streams
// mapping: the data-plane client (DescribeTable for the provisioned stream) and
// the Streams client (DescribeStream, shard iterators and GetRecords).
type dynamoDBLocalBackend struct {
	data    *dynamodb.Client
	streams *dynamoStreamsClient
}

// DynamoDBStreamDeliverer reads one table's stream on DynamoDB Local and
// invokes the mapping's function exactly as the Lambda poller documents.
//
// https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html
type DynamoDBStreamDeliverer struct {
	source  DeliverySource
	mapping EventSourceSpec
	tracker *ttlTracker
	clock   Clock
	data    *dynamodb.Client
	streams *dynamoStreamsClient
	// stream is the emulator ARN the Streams API calls use; eventARN is the
	// CDK-resolved ARN the handler sees.
	stream   string
	eventARN string
	viewType string
}

// NewDynamoDBStreamDeliverer builds the deliverer for one registered mapping.
func NewDynamoDBStreamDeliverer(source DeliverySource, tracker *ttlTracker) (Deliverer, error) {
	if source.Mapping == nil || source.Mapping.Type != backendDynamoDB {
		return nil, fmt.Errorf("source %s is not a DynamoDB Streams event source mapping", source.ID)
	}
	mapping := *source.Mapping
	if mapping.BatchSize <= 0 {
		mapping.BatchSize = defaultStreamBatchSize
	}
	if mapping.ParallelizationFactor <= 0 {
		mapping.ParallelizationFactor = 1
	}
	return &DynamoDBStreamDeliverer{source: source, mapping: mapping, tracker: tracker}, nil
}

// Start resolves the provisioned stream and polls its shards.
func (d *DynamoDBStreamDeliverer) Start(ctx context.Context, env DelivererEnv) error {
	backend, ok := env.Backend.Client.(*dynamoDBLocalBackend)
	if !ok || backend == nil || backend.data == nil || backend.streams == nil {
		return errors.New("the DynamoDB Streams delivery backend has no Streams client")
	}
	d.data = backend.data
	d.streams = backend.streams
	if env.Clock == nil {
		env.Clock = RealClock{}
	}
	d.clock = env.Clock
	description, err := d.data.DescribeTable(ctx, &dynamodb.DescribeTableInput{TableName: aws.String(d.mapping.SourceName)})
	if err != nil {
		return fmt.Errorf("describe local table %s for its stream: %w", d.mapping.SourceName, err)
	}
	if description.Table == nil || aws.ToString(description.Table.LatestStreamArn) == "" {
		return fmt.Errorf("local table %s has no stream; the mapping cannot deliver", d.mapping.SourceName)
	}
	d.stream = aws.ToString(description.Table.LatestStreamArn)
	d.eventARN = normalizeDynamoStreamARN(d.stream, d.mapping.SourceName)
	if description.Table.StreamSpecification != nil {
		d.viewType = string(description.Table.StreamSpecification.StreamViewType)
	}
	if d.viewType == "" {
		d.viewType = d.mapping.StreamViewType
	}
	env.Logf("DynamoDB stream %s: reading %s (handler ARN %s)", d.source.ID, d.stream, d.eventARN)
	if !d.mapping.Enabled {
		env.State.SetPaused(true)
		env.State.SetPhase(DeliveryPhasePaused)
		<-ctx.Done()
		return nil
	}
	env.State.SetPaused(false)
	env.State.SetPhase(DeliveryPhasePolling)
	d.pollShards(ctx, env)
	return nil
}

// pollShards starts one poller lane per open shard and re-reads the stream
// description to pick up the children of a closed shard.
func (d *DynamoDBStreamDeliverer) pollShards(ctx context.Context, env DelivererEnv) {
	started := map[string]bool{}
	for {
		if ctx.Err() != nil {
			return
		}
		description, err := d.streams.DescribeStream(ctx, d.stream)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			env.State.Failed(err)
			env.State.SetPhase(DeliveryPhaseFailed)
			env.Logf("DynamoDB stream %s: describe failed: %v", d.source.ID, err)
			sleepWall(ctx, streamRetryBase)
			continue
		}
		shards := description.Shards
		if description.StreamViewType != "" {
			d.viewType = description.StreamViewType
		}
		factor := d.mapping.ParallelizationFactor
		if factor > 10 {
			factor = 10
		}
		for _, shard := range shards {
			for lane := 0; lane < factor; lane++ {
				key := shard.ShardID + "#" + fmt.Sprint(lane)
				if started[key] {
					continue
				}
				started[key] = true
				reader := &dynamoShardReader{
					deliverer: d,
					shard:     shard.ShardID,
					lane:      lane,
					lanes:     factor,
					position:  d.mapping.StartingPosition,
				}
				poller := newStreamPoller(
					d.source.ID+"/"+shard.ShardID,
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

func (d *DynamoDBStreamDeliverer) pollerOptions(env DelivererEnv) streamPollerOptions {
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
			value, ok := record.Value.(map[string]any)
			if !ok {
				return true
			}
			matched, err := recordMatchesEventFilters(d.mapping.FilterCriteria, value)
			if err != nil {
				env.State.Failed(err)
				env.Logf("DynamoDB stream %s: FilterCriteria could not be evaluated: %v", d.source.ID, err)
				return false
			}
			return matched
		},
	}
}

// deliver builds the documented DynamoDB stream event and interprets the
// function response.
func (d *DynamoDBStreamDeliverer) deliver(env DelivererEnv) streamBatchDeliver {
	return func(ctx context.Context, records []streamRecord) streamBatchOutcome {
		values := make([]any, 0, len(records))
		for _, record := range records {
			if value, ok := record.Value.(map[string]any); ok {
				values = append(values, value)
			}
		}
		event, err := json.Marshal(map[string]any{"Records": values})
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

// discard sends the documented invocation record to the mapping's on-failure
// destination.
//
// The destination receives a pointer to the discarded batch, not the records:
// https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-retain-records.html
//
//nolint:dupl // the Kinesis discard callback differs only in its batch-info key.
func (d *DynamoDBStreamDeliverer) discard(env DelivererEnv) streamDiscard {
	return func(ctx context.Context, records []streamRecord, condition string, attempts int, lastErr error) {
		if d.mapping.DestinationType == "" {
			return
		}
		body, err := d.discardRecord(env, records, condition, attempts, lastErr)
		if err != nil {
			env.State.Failed(err)
			env.Logf("DynamoDB stream %s: build on-failure record: %v", d.source.ID, err)
			return
		}
		if err := sendStreamDiscard(ctx, env, d.mapping, body); err != nil {
			env.State.Failed(err)
			env.Logf("DynamoDB stream %s: send on-failure record: %v", d.source.ID, err)
			return
		}
	}
}

func (d *DynamoDBStreamDeliverer) discardRecord(env DelivererEnv, records []streamRecord, condition string, attempts int, lastErr error) ([]byte, error) {
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
		"DDBStreamBatchInfo": map[string]any{
			"shardId":                         first.Shard,
			"startSequenceNumber":             first.Sequence,
			"endSequenceNumber":               last.Sequence,
			"approximateArrivalOfFirstRecord": first.Arrival.UTC().Format(time.RFC3339),
			"approximateArrivalOfLastRecord":  last.Arrival.UTC().Format(time.RFC3339),
			"batchSize":                       len(records),
			"streamArn":                       d.eventARN,
		},
	}
	return json.Marshal(record)
}

func discardCondition(condition string) string {
	switch condition {
	case "MaximumEventAgeInSeconds":
		return "MaximumEventAgeExceeded"
	default:
		return "RetryAttemptsExhausted"
	}
}

func discardError(err error) any {
	if err == nil {
		return nil
	}
	return err.Error()
}

// dynamoShardReader is one lane's reader for one shard.
type dynamoShardReader struct {
	deliverer *DynamoDBStreamDeliverer
	shard     string
	lane      int
	lanes     int
	position  string
	iterator  string
	last      string
	done      bool
}

func (r *dynamoShardReader) Read(ctx context.Context, limit int) ([]streamRecord, error) {
	if r.done {
		return nil, nil
	}
	if r.iterator == "" {
		if err := r.Reconnect(ctx, ""); err != nil {
			return nil, err
		}
	}
	out, err := r.deliverer.streams.GetRecords(ctx, r.iterator, limit)
	if err != nil {
		return nil, streamReaderError(r.shard, err)
	}
	if out.NextShardIterator == nil || strings.TrimSpace(*out.NextShardIterator) == "" {
		r.done = true
	} else {
		r.iterator = *out.NextShardIterator
	}
	records := make([]streamRecord, 0, len(out.Records))
	for _, raw := range out.Records {
		sequence := dynamoStreamSequence(raw)
		if sequence == "" {
			continue
		}
		keys := dynamoStreamKeys(raw)
		if !r.owns(keys) {
			// Another lane owns this partition key. Its own iterator reads the
			// record and processes it in order.
			continue
		}
		eventName, _ := raw["eventName"].(string) //nolint:errcheck // a missing or non-string name is an ordinary record
		ttlDelete := strings.EqualFold(eventName, streamEventRemove) && r.deliverer.tracker.take(r.deliverer.mapping.SourceName, keys, r.deliverer.clock.Now())
		normalized := normalizeDynamoStreamRecord(raw, r.deliverer.eventARN, ttlDelete)
		records = append(records, streamRecord{
			Sequence:  sequence,
			Partition: partitionKeyValue(keys, r.deliverer.mapping.PartitionKey),
			Shard:     r.shard,
			Arrival:   approximateArrival(normalized),
			Value:     normalized,
		})
		r.last = sequence
	}
	return records, nil
}

// owns reports whether this lane processes the record's partition key.
func (r *dynamoShardReader) owns(keys map[string]any) bool {
	if r.lanes <= 1 || len(keys) == 0 {
		return true
	}
	partition := partitionKeyValue(keys, r.deliverer.mapping.PartitionKey)
	if partition == "" {
		encoded, err := json.Marshal(keys)
		if err != nil {
			return true
		}
		partition = string(encoded)
	}
	return streamLane(partition, r.lanes) == r.lane
}

func (r *dynamoShardReader) Reconnect(ctx context.Context, afterSequence string) error {
	iteratorType := strings.ToUpper(strings.TrimSpace(r.position))
	if iteratorType == "" {
		iteratorType = dynamoStreamIteratorTrimHorizon
	}
	sequence := ""
	if afterSequence != "" {
		iteratorType = dynamoStreamIteratorAfterSeq
		sequence = afterSequence
	}
	iterator, err := r.deliverer.streams.GetShardIterator(ctx, r.deliverer.stream, r.shard, iteratorType, sequence, nil)
	if err != nil {
		return streamReaderError(r.shard, err)
	}
	r.iterator = iterator
	return nil
}

func (r *dynamoShardReader) Done() bool {
	return r.done
}

// partitionKeyValue reads a key attribute's scalar value from a DynamoDB JSON
// key map.
func partitionKeyValue(keys map[string]any, attribute string) string {
	if attribute == "" {
		// Use the first key attribute in a deterministic order when the table's
		// hash key was not derived.
		for _, name := range sortedKeys(keys) {
			return scalarKeyValue(keys[name])
		}
		return ""
	}
	value, ok := keys[attribute]
	if !ok {
		return ""
	}
	return scalarKeyValue(value)
}

func scalarKeyValue(value any) string {
	object, ok := value.(map[string]any)
	if !ok {
		return ""
	}
	for _, name := range []string{"S", "N", "B"} {
		if scalar, ok := object[name].(string); ok {
			return scalar
		}
	}
	return ""
}

// streamLane maps a partition key to one of lanes deterministically.
func streamLane(partition string, lanes int) int {
	if lanes <= 1 {
		return 0
	}
	hash := fnv.New32a()
	_, _ = hash.Write([]byte(partition))     //nolint:errcheck // hash.Hash never fails
	return int(hash.Sum32() % uint32(lanes)) //nolint:gosec // lanes is a small positive int
}

// approximateArrival reads a DynamoDB record's approximate creation time.
func approximateArrival(record map[string]any) time.Time {
	dynamodbValue, ok := record["dynamodb"].(map[string]any)
	if !ok {
		return time.Now().UTC()
	}
	value, ok := dynamodbValue["ApproximateCreationDateTime"].(float64)
	if !ok {
		return time.Now().UTC()
	}
	seconds := int64(value)
	nanos := int64((value - float64(seconds)) * float64(time.Second))
	return time.Unix(seconds, nanos).UTC()
}

// waitClock waits for a duration on the run clock.
func waitClock(ctx context.Context, clock Clock, duration time.Duration) {
	if duration <= 0 {
		return
	}
	select {
	case <-ctx.Done():
	case <-clock.After(duration):
	}
}
