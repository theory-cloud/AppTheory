package apptheory

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

const (
	cloudWatchLogsSubscriptionMaxDecodedBytes   = 6 * 1024 * 1024
	cloudWatchLogsSubscriptionDecodeMessage     = "apptheory: decode cloudwatch logs subscription"
	cloudWatchLogsSubscriptionDecodeGzipMessage = cloudWatchLogsSubscriptionDecodeMessage + " gzip: %w"
)

// CloudWatchLogsSubscription is a decoded CloudWatch Logs subscription envelope carried by a Kinesis record.
type CloudWatchLogsSubscription struct {
	RecordID            string                               `json:"record_id"`
	MessageType         string                               `json:"message_type"`
	Owner               string                               `json:"owner"`
	LogGroup            string                               `json:"log_group"`
	LogStream           string                               `json:"log_stream"`
	SubscriptionFilters []string                             `json:"subscription_filters"`
	LogEvents           []CloudWatchLogsSubscriptionLogEvent `json:"log_events"`
	SafeSummary         CloudWatchLogsSubscriptionSummary    `json:"safe_summary"`
}

// CloudWatchLogsSubscriptionLogEvent is one decoded CloudWatch Logs event from a subscription envelope.
type CloudWatchLogsSubscriptionLogEvent struct {
	ID        string `json:"id"`
	Timestamp int64  `json:"timestamp"`
	Message   string `json:"message"`
}

// CloudWatchLogsSubscriptionSummary is the safe, non-message summary for a decoded subscription envelope.
type CloudWatchLogsSubscriptionSummary struct {
	RecordID                string `json:"record_id"`
	MessageType             string `json:"message_type"`
	Owner                   string `json:"owner"`
	LogGroup                string `json:"log_group"`
	LogStream               string `json:"log_stream"`
	SubscriptionFilterCount int    `json:"subscription_filter_count"`
	LogEventCount           int    `json:"log_event_count"`
	SafeLog                 string `json:"safe_log"`
}

type cloudWatchLogsSubscriptionPayload struct {
	MessageType         string                               `json:"messageType"`
	Owner               string                               `json:"owner"`
	LogGroup            string                               `json:"logGroup"`
	LogStream           string                               `json:"logStream"`
	SubscriptionFilters []string                             `json:"subscriptionFilters"`
	LogEvents           []CloudWatchLogsSubscriptionLogEvent `json:"logEvents"`
}

// DecodeCloudWatchLogsSubscription decodes a Kinesis record containing a CloudWatch Logs subscription envelope.
//
// AWS delivers CloudWatch Logs subscription payloads to Kinesis as gzip-compressed JSON bytes. The returned
// SafeSummary intentionally excludes raw log event messages so callers can use it in logs, metrics, spans,
// and fixture summaries without copying customer log material.
func DecodeCloudWatchLogsSubscription(record events.KinesisEventRecord) (CloudWatchLogsSubscription, error) {
	decoded := CloudWatchLogsSubscription{RecordID: strings.TrimSpace(record.EventID)}
	if decoded.RecordID == "" {
		return decoded, errors.New(cloudWatchLogsSubscriptionDecodeMessage + ": missing kinesis eventID")
	}

	payloadBytes, err := gunzipCloudWatchLogsSubscriptionData(record.Kinesis.Data)
	if err != nil {
		return decoded, err
	}

	var payload cloudWatchLogsSubscriptionPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return decoded, fmt.Errorf(cloudWatchLogsSubscriptionDecodeMessage+" json: %w", err)
	}

	decoded.MessageType = strings.TrimSpace(payload.MessageType)
	decoded.Owner = strings.TrimSpace(payload.Owner)
	decoded.LogGroup = strings.TrimSpace(payload.LogGroup)
	decoded.LogStream = strings.TrimSpace(payload.LogStream)
	decoded.SubscriptionFilters = trimCloudWatchLogsSubscriptionFilters(payload.SubscriptionFilters)
	decoded.LogEvents = cloneCloudWatchLogsSubscriptionLogEvents(payload.LogEvents)
	if err := validateCloudWatchLogsSubscription(decoded); err != nil {
		return decoded, err
	}
	decoded.SafeSummary = cloudWatchLogsSubscriptionSafeSummary(decoded)
	return decoded, nil
}

func gunzipCloudWatchLogsSubscriptionData(data []byte) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New(cloudWatchLogsSubscriptionDecodeMessage + ": empty kinesis data")
	}
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf(cloudWatchLogsSubscriptionDecodeGzipMessage, err)
	}

	limited := io.LimitReader(reader, cloudWatchLogsSubscriptionMaxDecodedBytes+1)
	payload, readErr := io.ReadAll(limited)
	closeErr := reader.Close()
	if readErr != nil {
		return nil, fmt.Errorf(cloudWatchLogsSubscriptionDecodeGzipMessage, readErr)
	}
	if closeErr != nil {
		return nil, fmt.Errorf(cloudWatchLogsSubscriptionDecodeGzipMessage, closeErr)
	}
	if len(payload) > cloudWatchLogsSubscriptionMaxDecodedBytes {
		return nil, errors.New(cloudWatchLogsSubscriptionDecodeMessage + ": payload too large")
	}
	return payload, nil
}

func validateCloudWatchLogsSubscription(decoded CloudWatchLogsSubscription) error {
	var missing []string
	if strings.TrimSpace(decoded.MessageType) == "" {
		missing = append(missing, "messageType")
	}
	if strings.TrimSpace(decoded.Owner) == "" {
		missing = append(missing, "owner")
	}
	if strings.TrimSpace(decoded.LogGroup) == "" {
		missing = append(missing, "logGroup")
	}
	if strings.TrimSpace(decoded.LogStream) == "" {
		missing = append(missing, "logStream")
	}
	if len(decoded.SubscriptionFilters) == 0 {
		missing = append(missing, "subscriptionFilters")
	}
	if len(missing) > 0 {
		return fmt.Errorf(cloudWatchLogsSubscriptionDecodeMessage+": missing %s", strings.Join(missing, ", "))
	}

	for i, filter := range decoded.SubscriptionFilters {
		if strings.TrimSpace(filter) == "" {
			return fmt.Errorf(cloudWatchLogsSubscriptionDecodeMessage+": empty subscriptionFilters[%d]", i)
		}
	}
	for i, event := range decoded.LogEvents {
		if strings.TrimSpace(event.ID) == "" {
			return fmt.Errorf(cloudWatchLogsSubscriptionDecodeMessage+": empty logEvents[%d].id", i)
		}
	}
	return nil
}

func trimCloudWatchLogsSubscriptionFilters(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, len(in))
	for i, value := range in {
		out[i] = strings.TrimSpace(value)
	}
	return out
}

func cloneCloudWatchLogsSubscriptionLogEvents(in []CloudWatchLogsSubscriptionLogEvent) []CloudWatchLogsSubscriptionLogEvent {
	if len(in) == 0 {
		return nil
	}
	out := make([]CloudWatchLogsSubscriptionLogEvent, len(in))
	for i, event := range in {
		event.ID = strings.TrimSpace(event.ID)
		out[i] = event
	}
	return out
}

func cloudWatchLogsSubscriptionSafeSummary(decoded CloudWatchLogsSubscription) CloudWatchLogsSubscriptionSummary {
	filterCount := len(decoded.SubscriptionFilters)
	logEventCount := len(decoded.LogEvents)
	safeLog := fmt.Sprintf(
		"record_id=%s owner=%s log_group=%s log_stream=%s message_type=%s log_events=%d subscription_filters=%d",
		decoded.RecordID,
		decoded.Owner,
		decoded.LogGroup,
		decoded.LogStream,
		decoded.MessageType,
		logEventCount,
		filterCount,
	)
	return CloudWatchLogsSubscriptionSummary{
		RecordID:                decoded.RecordID,
		MessageType:             decoded.MessageType,
		Owner:                   decoded.Owner,
		LogGroup:                decoded.LogGroup,
		LogStream:               decoded.LogStream,
		SubscriptionFilterCount: filterCount,
		LogEventCount:           logEventCount,
		SafeLog:                 safeLog,
	}
}
