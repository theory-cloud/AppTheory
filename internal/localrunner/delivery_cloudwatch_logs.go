package localrunner

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kinesis"
)

// The CloudWatch Logs subscription-filter deliverer observes log events the
// runner or an application writes through the real Logs API and delivers the
// documented payload to the filter's destination. moto stores log events but
// does not run subscription filters, so the runner polls the group itself and
// performs the delivery.
//
// The payload is gzip-compressed JSON with messageType, owner, logGroup,
// logStream, subscriptionFilters and logEvents. A Lambda destination receives
// it base64-encoded in awslogs.data; a Kinesis destination receives the gzip
// bytes as the record data, and the Kinesis event-source mapping delivers them.
//
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/SubscriptionFilters.html
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html

const (
	logsPollInterval = 200 * time.Millisecond
	logsSeenLimit    = 10000
	logsCursorBack   = time.Second
)

// logsLocalBackend is the DeliveryBackend.Client for a CloudWatch Logs
// subscription: the Logs client and, when moto's Kinesis runs, the client a
// stream destination needs.
type logsLocalBackend struct {
	logs    *cloudWatchLogsClient
	kinesis *kinesis.Client
}

// CloudWatchLogsDeliverer delivers one subscription filter.
type CloudWatchLogsDeliverer struct {
	source       DeliverySource
	subscription SubscriptionSpec
	logs         *cloudWatchLogsClient
	kinesis      *kinesis.Client

	mu     sync.Mutex
	cursor int64
	seen   map[string]struct{}
	order  []string
}

// NewCloudWatchLogsDeliverer builds the deliverer for one registered filter.
func NewCloudWatchLogsDeliverer(source DeliverySource) (Deliverer, error) {
	if source.Subscription == nil || source.Subscription.Kind != string(DeliveryKindCloudWatchLogs) {
		return nil, fmt.Errorf("source %s is not a CloudWatch Logs subscription filter", source.ID)
	}
	return &CloudWatchLogsDeliverer{
		source:       source,
		subscription: *source.Subscription,
		seen:         map[string]struct{}{},
	}, nil
}

// Start verifies the destination and polls the log group until the context
// ends.
func (d *CloudWatchLogsDeliverer) Start(ctx context.Context, env DelivererEnv) error {
	backend, ok := env.Backend.Client.(*logsLocalBackend)
	if !ok || backend == nil || backend.logs == nil {
		return errors.New("the CloudWatch Logs delivery backend has no Logs client")
	}
	d.logs = backend.logs
	d.kinesis = backend.kinesis
	if strings.TrimSpace(d.subscription.LogGroup) == "" {
		return fmt.Errorf("subscription %s has no log group", d.source.ID)
	}
	if err := d.logs.CreateLogGroup(ctx, d.subscription.LogGroup); err != nil {
		return fmt.Errorf("ensure log group %s: %w", d.subscription.LogGroup, err)
	}
	switch strings.ToLower(strings.TrimSpace(d.subscription.DestinationType)) {
	case ruleTargetFunction:
		if d.subscription.Function == "" {
			return fmt.Errorf("subscription %s has no Lambda destination", d.source.ID)
		}
	case "stream":
		if d.kinesis == nil {
			return fmt.Errorf("subscription %s needs the Kinesis backend for its stream destination", d.source.ID)
		}
		if _, err := d.kinesis.DescribeStreamSummary(ctx, &kinesis.DescribeStreamSummaryInput{
			StreamName: aws.String(d.subscription.StreamName),
		}); err != nil {
			return fmt.Errorf("resolve subscription destination stream %s: %w", d.subscription.StreamName, err)
		}
	default:
		return fmt.Errorf("subscription %s has unsupported destination type %q", d.source.ID, d.subscription.DestinationType)
	}
	env.State.SetPhase(DeliveryPhasePolling)
	// Log ingestion uses the emulator's wall-clock timestamps: moto rejects an
	// event older than its retention window, and AWS's own log event timestamps
	// are ingestion times, not a test clock. The run clock still drives the
	// Kinesis batching window and every retry.
	d.cursor = time.Now().Add(-logsCursorBack).UnixMilli()
	for {
		if ctx.Err() != nil {
			return nil
		}
		d.poll(ctx, env)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(logsPollInterval):
		}
	}
}

// poll reads one page of events and delivers the matching ones.
func (d *CloudWatchLogsDeliverer) poll(ctx context.Context, env DelivererEnv) {
	events, err := d.logs.FilterLogEvents(ctx, d.subscription.LogGroup, d.cursor)
	if err != nil {
		if ctx.Err() == nil {
			env.State.Failed(err)
			env.State.SetPhase(DeliveryPhaseFailed)
			env.Logf("subscription %s: read log group %s: %v", d.source.ID, d.subscription.LogGroup, err)
		}
		return
	}
	if len(events) == 0 {
		return
	}
	byStream := map[string][]cloudWatchFilterEvent{}
	streamOrder := make([]string, 0, 2)
	maxTimestamp := d.cursor
	for _, event := range events {
		if event.Timestamp < d.cursor {
			continue
		}
		if event.Timestamp+1 > maxTimestamp {
			maxTimestamp = event.Timestamp + 1
		}
		key := event.EventID
		if key == "" {
			key = fmt.Sprintf("%s/%d/%s", event.LogStreamName, event.Timestamp, event.Message)
		}
		if d.markSeen(key) {
			continue
		}
		matched, matchErr := cloudWatchFilterMatches(d.subscription.FilterPattern, event.Message)
		if matchErr != nil {
			env.State.Failed(matchErr)
			env.Logf("subscription %s: filter pattern could not be evaluated: %v", d.source.ID, matchErr)
			continue
		}
		if !matched {
			env.State.Filtered()
			continue
		}
		stream := event.LogStreamName
		if _, ok := byStream[stream]; !ok {
			streamOrder = append(streamOrder, stream)
		}
		byStream[stream] = append(byStream[stream], event)
	}
	for _, stream := range streamOrder {
		if err := d.deliverStream(ctx, env, stream, byStream[stream]); err != nil {
			env.State.Failed(err)
			env.Logf("subscription %s: deliver %s: %v", d.source.ID, stream, err)
			continue
		}
		env.State.Delivered()
	}
	d.cursor = maxTimestamp
}

// deliverStream sends one stream's matching events to the destination.
func (d *CloudWatchLogsDeliverer) deliverStream(ctx context.Context, env DelivererEnv, stream string, events []cloudWatchFilterEvent) error {
	filterName := strings.TrimSpace(d.subscription.FilterName)
	if filterName == "" {
		filterName = d.source.LogicalID
	}
	logEvents := make([]cloudWatchLogEvent, 0, len(events))
	for _, event := range events {
		logEvents = append(logEvents, cloudWatchLogEvent{
			ID:        event.EventID,
			Timestamp: event.Timestamp,
			Message:   event.Message,
		})
	}
	payload := cloudWatchSubscriptionPayload{
		MessageType:         "DATA_MESSAGE",
		Owner:               LocalAccountID,
		LogGroup:            d.subscription.LogGroup,
		LogStream:           stream,
		SubscriptionFilters: []string{filterName},
		LogEvents:           logEvents,
	}
	compressed, err := payload.gzip()
	if err != nil {
		return fmt.Errorf("encode subscription payload: %w", err)
	}
	switch strings.ToLower(strings.TrimSpace(d.subscription.DestinationType)) {
	case ruleTargetFunction:
		event, err := json.Marshal(map[string]any{
			"awslogs": map[string]any{"data": base64.StdEncoding.EncodeToString(compressed)},
		})
		if err != nil {
			return err
		}
		result, err := env.Invoke(ctx, event)
		if err != nil {
			return err
		}
		if result.HandlerError != "" {
			return errors.New(result.HandlerError)
		}
		return nil
	case "stream":
		if d.kinesis == nil {
			return errors.New("the Kinesis destination client is not available")
		}
		partition := d.partitionKey(stream)
		if _, err := d.kinesis.PutRecord(ctx, &kinesis.PutRecordInput{
			StreamName:   aws.String(d.subscription.StreamName),
			PartitionKey: aws.String(partition),
			Data:         compressed,
		}); err != nil {
			return fmt.Errorf("put subscription payload to %s: %w", d.subscription.StreamName, err)
		}
		return nil
	default:
		return fmt.Errorf("unsupported destination type %q", d.subscription.DestinationType)
	}
}

// partitionKey applies the subscription's Distribution. CloudWatch Logs
// defaults to ByLogStream; Random distributes records across shards.
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/SubscriptionFilters.html
func (d *CloudWatchLogsDeliverer) partitionKey(stream string) string {
	if strings.EqualFold(strings.TrimSpace(d.subscription.Distribution), "Random") {
		return NewRequestID()
	}
	if strings.TrimSpace(stream) != "" {
		return stream
	}
	return "local"
}

// markSeen reports whether the event was already delivered and records it
// otherwise.
func (d *CloudWatchLogsDeliverer) markSeen(key string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.seen[key]; ok {
		return true
	}
	d.seen[key] = struct{}{}
	d.order = append(d.order, key)
	if len(d.order) > logsSeenLimit {
		drop := len(d.order) - logsSeenLimit
		for _, old := range d.order[:drop] {
			delete(d.seen, old)
		}
		d.order = append([]string(nil), d.order[drop:]...)
	}
	return false
}
