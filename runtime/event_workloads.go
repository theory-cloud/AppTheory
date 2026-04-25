package apptheory

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambdacontext"
)

const (
	eventWorkloadFailedMessage = "apptheory: event workload failed"

	eventBridgeCorrelationSourceMetadata     = "metadata.correlation_id"
	eventBridgeCorrelationSourceHeader       = "headers.x-correlation-id"
	eventBridgeCorrelationSourceDetail       = "detail.correlation_id"
	eventBridgeCorrelationSourceEventID      = "event.id"
	eventBridgeCorrelationSourceAWSRequestID = "lambda.aws_request_id"
)

// DynamoDBStreamRecordSummary is the portable, safe summary for a DynamoDB Streams record.
type DynamoDBStreamRecordSummary struct {
	AWSRegion      string `json:"aws_region"`
	EventID        string `json:"event_id"`
	EventName      string `json:"event_name"`
	SafeLog        string `json:"safe_log"`
	SequenceNumber string `json:"sequence_number"`
	SizeBytes      int64  `json:"size_bytes"`
	StreamViewType string `json:"stream_view_type"`
	TableName      string `json:"table_name"`
}

// NormalizeDynamoDBStreamRecord returns a portable, safe summary for a DynamoDB Streams record.
//
// The summary intentionally excludes raw Keys, NewImage, and OldImage values so sensitive item
// material cannot be copied into logs, metrics, spans, or handler summaries through this helper.
func NormalizeDynamoDBStreamRecord(record events.DynamoDBEventRecord) DynamoDBStreamRecordSummary {
	tableName := dynamoDBTableNameFromStreamARN(record.EventSourceArn)
	sequenceNumber := strings.TrimSpace(record.Change.SequenceNumber)
	eventID := strings.TrimSpace(record.EventID)
	eventName := strings.TrimSpace(record.EventName)
	return DynamoDBStreamRecordSummary{
		AWSRegion:      strings.TrimSpace(record.AWSRegion),
		EventID:        eventID,
		EventName:      eventName,
		SafeLog:        "table=" + tableName + " event_id=" + eventID + " event_name=" + eventName + " sequence_number=" + sequenceNumber,
		SequenceNumber: sequenceNumber,
		SizeBytes:      record.Change.SizeBytes,
		StreamViewType: strings.TrimSpace(record.Change.StreamViewType),
		TableName:      tableName,
	}
}

// EventBridgeWorkloadEnvelope is the portable, safe summary AppTheory exposes for EventBridge workloads.
type EventBridgeWorkloadEnvelope struct {
	Account           string   `json:"account"`
	CorrelationID     string   `json:"correlation_id"`
	CorrelationSource string   `json:"correlation_source"`
	DetailType        string   `json:"detail_type"`
	EventID           string   `json:"event_id"`
	Region            string   `json:"region"`
	RequestID         string   `json:"request_id"`
	Resources         []string `json:"resources"`
	Source            string   `json:"source"`
	Time              string   `json:"time"`
}

// NormalizeEventBridgeWorkloadEnvelope returns the canonical EventBridge workload envelope.
//
// Correlation IDs are selected in the contract-defined order:
// metadata.correlation_id, headers["x-correlation-id"], detail.correlation_id, event.id,
// and finally the Lambda awsRequestId.
func NormalizeEventBridgeWorkloadEnvelope(
	ctx *EventContext,
	event events.EventBridgeEvent,
) EventBridgeWorkloadEnvelope {
	rawObject := eventContextRawJSONObject(ctx)
	detail := eventBridgeDetailObject(event, rawObject)
	correlationID, correlationSource := eventBridgeCorrelationID(ctx, event, rawObject, detail)

	return EventBridgeWorkloadEnvelope{
		Account:           strings.TrimSpace(event.AccountID),
		CorrelationID:     correlationID,
		CorrelationSource: correlationSource,
		DetailType:        strings.TrimSpace(event.DetailType),
		EventID:           strings.TrimSpace(event.ID),
		Region:            strings.TrimSpace(event.Region),
		RequestID:         eventContextRequestID(ctx),
		Resources:         append([]string(nil), event.Resources...),
		Source:            strings.TrimSpace(event.Source),
		Time:              eventBridgeEventTime(event, rawObject),
	}
}

// RequireEventBridgeWorkloadEnvelope returns the canonical EventBridge workload envelope and fails closed
// when source, detail type, or correlation identity is missing.
func RequireEventBridgeWorkloadEnvelope(
	ctx *EventContext,
	event events.EventBridgeEvent,
) (EventBridgeWorkloadEnvelope, error) {
	envelope := NormalizeEventBridgeWorkloadEnvelope(ctx, event)
	if strings.TrimSpace(envelope.Source) == "" ||
		strings.TrimSpace(envelope.DetailType) == "" ||
		strings.TrimSpace(envelope.CorrelationID) == "" {
		return envelope, safeEventError{message: "apptheory: eventbridge workload envelope invalid"}
	}
	return envelope, nil
}

func eventWorkloadFailedError() error {
	return errors.New(eventWorkloadFailedMessage)
}

type safeEventError struct {
	message string
}

func (e safeEventError) Error() string { return e.message }

func (e safeEventError) safeEventError() {}

func sanitizeEventWorkloadError(err error) error {
	if err == nil {
		return nil
	}
	var safe interface{ safeEventError() }
	if errors.As(err, &safe) {
		return err
	}
	return eventWorkloadFailedError()
}

func eventBridgeObservation(ctx *EventContext, event events.EventBridgeEvent) eventObservation {
	envelope := NormalizeEventBridgeWorkloadEnvelope(ctx, event)
	return eventObservation{
		Trigger:       eventTriggerEventBridge,
		RequestID:     envelope.RequestID,
		CorrelationID: envelope.CorrelationID,
		Source:        envelope.Source,
		DetailType:    envelope.DetailType,
	}
}

func dynamoDBStreamObservation(ctx *EventContext, record events.DynamoDBEventRecord) eventObservation {
	summary := NormalizeDynamoDBStreamRecord(record)
	return eventObservation{
		Trigger:       eventTriggerDynamoDBStream,
		RequestID:     eventContextRequestID(ctx),
		CorrelationID: summary.EventID,
		TableName:     summary.TableName,
		EventID:       summary.EventID,
		EventName:     summary.EventName,
	}
}

// EventBridgeScheduledWorkloadSummary is the portable summary for EventBridge scheduled workloads.
type EventBridgeScheduledWorkloadSummary struct {
	CorrelationID     string                                    `json:"correlation_id"`
	CorrelationSource string                                    `json:"correlation_source"`
	DeadlineUnixMS    int64                                     `json:"deadline_unix_ms"`
	DetailType        string                                    `json:"detail_type"`
	EventID           string                                    `json:"event_id"`
	IdempotencyKey    string                                    `json:"idempotency_key"`
	Kind              string                                    `json:"kind"`
	RemainingMS       int                                       `json:"remaining_ms"`
	Result            EventBridgeScheduledWorkloadResultSummary `json:"result"`
	RunID             string                                    `json:"run_id"`
	ScheduledTime     string                                    `json:"scheduled_time"`
	Source            string                                    `json:"source"`
}

// EventBridgeScheduledWorkloadResultSummary is the safe result summary for a scheduled workload.
type EventBridgeScheduledWorkloadResultSummary struct {
	Failed    int    `json:"failed"`
	Processed int    `json:"processed"`
	Status    string `json:"status"`
}

// NormalizeEventBridgeScheduledWorkload returns the canonical scheduled workload summary for an
// EventBridge scheduled event.
func NormalizeEventBridgeScheduledWorkload(
	ctx *EventContext,
	event events.EventBridgeEvent,
) EventBridgeScheduledWorkloadSummary {
	rawObject := eventContextRawJSONObject(ctx)
	detail := eventBridgeDetailObject(event, rawObject)
	result := rawObjectField(detail, "result")
	envelope := NormalizeEventBridgeWorkloadEnvelope(ctx, event)

	runID := rawString(detail, "run_id")
	if runID == "" {
		runID = strings.TrimSpace(event.ID)
	}
	if runID == "" {
		runID = eventContextLambdaAWSRequestID(ctx)
	}

	idempotencyKey := rawString(detail, "idempotency_key")
	if idempotencyKey == "" {
		if eventID := strings.TrimSpace(event.ID); eventID != "" {
			idempotencyKey = "eventbridge:" + eventID
		} else if requestID := eventContextLambdaAWSRequestID(ctx); requestID != "" {
			idempotencyKey = "lambda:" + requestID
		}
	}

	status := rawString(result, "status")
	if status == "" {
		status = rawString(detail, "status")
	}
	if status == "" {
		status = "ok"
	}

	remainingMS := eventContextRemainingMS(ctx)
	var deadlineUnixMS int64
	if remainingMS > 0 && ctx != nil {
		deadlineUnixMS = ctx.Now().UnixMilli() + int64(remainingMS)
	}

	return EventBridgeScheduledWorkloadSummary{
		CorrelationID:     envelope.CorrelationID,
		CorrelationSource: envelope.CorrelationSource,
		DeadlineUnixMS:    deadlineUnixMS,
		DetailType:        envelope.DetailType,
		EventID:           envelope.EventID,
		IdempotencyKey:    idempotencyKey,
		Kind:              "scheduled",
		RemainingMS:       remainingMS,
		Result: EventBridgeScheduledWorkloadResultSummary{
			Failed:    rawInt(result, "failed"),
			Processed: rawInt(result, "processed"),
			Status:    status,
		},
		RunID:         runID,
		ScheduledTime: envelope.Time,
		Source:        envelope.Source,
	}
}

func eventBridgeCorrelationID(
	ctx *EventContext,
	event events.EventBridgeEvent,
	raw map[string]any,
	detail map[string]any,
) (string, string) {
	if value := rawString(rawObjectField(raw, "metadata"), "correlation_id"); value != "" {
		return value, eventBridgeCorrelationSourceMetadata
	}
	if value := rawHeaderString(rawObjectField(raw, "headers"), "x-correlation-id"); value != "" {
		return value, eventBridgeCorrelationSourceHeader
	}
	if value := rawString(detail, "correlation_id"); value != "" {
		return value, eventBridgeCorrelationSourceDetail
	}
	if value := strings.TrimSpace(event.ID); value != "" {
		return value, eventBridgeCorrelationSourceEventID
	}
	if value := eventContextLambdaAWSRequestID(ctx); value != "" {
		return value, eventBridgeCorrelationSourceAWSRequestID
	}
	return "", ""
}

func eventBridgeDetailObject(event events.EventBridgeEvent, raw map[string]any) map[string]any {
	detail := rawObjectField(raw, "detail")
	if len(detail) > 0 {
		return detail
	}
	return rawJSONObject(event.Detail)
}

func eventBridgeEventTime(event events.EventBridgeEvent, raw map[string]any) string {
	if value := rawString(raw, "time"); value != "" {
		return value
	}
	if event.Time.IsZero() {
		return ""
	}
	return event.Time.UTC().Format(time.RFC3339)
}

func eventContextRequestID(ctx *EventContext) string {
	if ctx == nil {
		return ""
	}
	return strings.TrimSpace(ctx.RequestID)
}

func eventContextLambdaAWSRequestID(ctx *EventContext) string {
	if ctx == nil {
		return ""
	}
	lambdaCtx, ok := lambdacontext.FromContext(ctx.Context())
	if !ok || lambdaCtx == nil {
		return ""
	}
	return strings.TrimSpace(lambdaCtx.AwsRequestID)
}

func eventContextRawJSONObject(ctx *EventContext) map[string]any {
	if ctx == nil || len(ctx.rawEvent) == 0 {
		return map[string]any{}
	}
	return rawJSONObject(ctx.rawEvent)
}

func rawJSONObject(raw json.RawMessage) map[string]any {
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return map[string]any{}
	}
	return object
}

func rawObjectField(object map[string]any, key string) map[string]any {
	if object == nil {
		return map[string]any{}
	}
	value, ok := object[key]
	if !ok {
		return map[string]any{}
	}
	child, ok := value.(map[string]any)
	if !ok || child == nil {
		return map[string]any{}
	}
	return child
}

func rawString(object map[string]any, key string) string {
	if object == nil {
		return ""
	}
	value, ok := object[key]
	if !ok {
		return ""
	}
	return asTrimmedString(value)
}

func rawHeaderString(headers map[string]any, key string) string {
	key = strings.TrimSpace(strings.ToLower(key))
	if key == "" || headers == nil {
		return ""
	}
	for name, value := range headers {
		if strings.TrimSpace(strings.ToLower(name)) != key {
			continue
		}
		if single := asTrimmedString(value); single != "" {
			return single
		}
		if values, ok := value.([]any); ok {
			for _, entry := range values {
				if single := asTrimmedString(entry); single != "" {
					return single
				}
			}
		}
	}
	return ""
}

func eventContextRemainingMS(ctx *EventContext) int {
	if ctx == nil {
		return 0
	}
	return ctx.RemainingMS
}

func rawInt(object map[string]any, key string) int {
	if object == nil {
		return 0
	}
	value, ok := object[key]
	if !ok {
		return 0
	}
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return 0
		}
		return int(parsed)
	default:
		return 0
	}
}

func asTrimmedString(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	default:
		return ""
	}
}
