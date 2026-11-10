package localrunner

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// S3 event notification payloads.
//
// The record shape is the one the S3 Event Notifications content page
// documents, including the urlencoded object key and the s3.configurationId:
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html
//
// Event names in a bucket's notification configuration carry the s3: prefix
// (s3:ObjectCreated:*); the eventName a destination receives does not
// (ObjectCreated:Put):
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-event-types-and-destinations.html
//
// A bucket with EventBridge notifications enabled publishes a different
// envelope to the default bus; source aws.s3, a detail-type such as
// "Object Created", and a detail object with the bucket, the object and the S3
// API that caused the event:
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventBridge.html
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/ev-events.html

const (
	// s3EventVersion is the unified notification schema version the page shows.
	s3EventVersion = "2.6"
	// s3EventBridgeEventVersion is the detail.event-version for EventBridge.
	s3EventBridgeEventVersion = "1.2"
	// s3EventSource is the notification record's eventSource value. The
	// EventBridge envelope uses the dotted aws.s3 source instead.
	s3EventSource = "aws:s3"
	// s3EventBridgeSource is the EventBridge event source.
	// https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventBridge.html
	s3EventBridgeSource = "aws.s3"

	// Notification record event names.
	s3RecordObjectCreatedPut                 = "ObjectCreated:Put"
	s3RecordObjectCreatedCopy                = "ObjectCreated:Copy"
	s3RecordObjectCreatedCompleteMultipart   = "ObjectCreated:CompleteMultipartUpload"
	s3RecordObjectRemovedDelete              = "ObjectRemoved:Delete"
	s3RecordObjectRemovedDeleteMarkerCreated = "ObjectRemoved:DeleteMarkerCreated"

	// EventBridge detail-types.
	s3DetailTypeObjectCreated = "Object Created"
	s3DetailTypeObjectDeleted = "Object Deleted"

	// EventBridge detail reasons.
	s3ReasonPutObject    = "PutObject"
	s3ReasonCopyObject   = "CopyObject"
	s3ReasonDeleteObject = "DeleteObject"
)

// S3ObjectEvent is one observed object change the watcher turns into the
// provider's payload. The watcher observes real bucket state with
// ListObjectsV2; the event fields it cannot observe (request id, source IP)
// are derived the way S3 derives them for its own record.
type S3ObjectEvent struct {
	Bucket          string
	BucketARN       string
	Key             string
	EventName       string
	ConfigurationID string
	Size            int64
	ETag            string
	Sequencer       string
	Time            time.Time
	// Now is the observation instant; a delete has no object timestamp of its
	// own, so its event time comes from the run clock.
	Now       time.Time
	RequestID string
	SourceIP  string
	// Reason is the S3 API the EventBridge detail names, for example PutObject.
	Reason string
}

// BuildS3NotificationRecord builds the Records envelope a Lambda, SQS or SNS
// destination receives.
func BuildS3NotificationRecord(event S3ObjectEvent) ([]byte, error) {
	object := map[string]any{
		"key":       encodeS3Key(event.Key),
		"size":      event.Size,
		"eTag":      strings.Trim(event.ETag, "\""),
		"sequencer": event.Sequencer,
	}
	instant := event.Time
	if instant.IsZero() {
		instant = event.Now
	}
	record := map[string]any{
		"eventVersion": s3EventVersion,
		"eventSource":  s3EventSource,
		"awsRegion":    LocalRegion,
		"eventTime":    s3EventTime(instant),
		"eventName":    event.EventName,
		"userIdentity": map[string]any{
			"principalId": "AIDA" + stableHash(event.Bucket+"/"+event.Key, 17),
		},
		"requestParameters": map[string]any{
			"sourceIPAddress": event.SourceIP,
		},
		"responseElements": map[string]any{
			"x-amz-request-id": event.RequestID,
			"x-amz-id-2":       stableHash(event.Bucket+"/"+event.Key+"/"+event.RequestID, 64),
		},
		"s3": map[string]any{
			"s3SchemaVersion": "1.0",
			"configurationId": event.ConfigurationID,
			"bucket": map[string]any{
				"name":          event.Bucket,
				"ownerIdentity": map[string]any{"principalId": "A3NL1KOZZK" + stableHash(event.Bucket, 9)},
				"arn":           event.BucketARN,
			},
			"object": object,
		},
	}
	return json.Marshal(map[string]any{"Records": []any{record}})
}

// BuildS3TestEvent builds the message S3 sends to an SQS queue or SNS topic when
// its notification configuration is applied. It is deliberately a different
// shape from a record event.
func BuildS3TestEvent(bucket string, now time.Time) ([]byte, error) {
	return json.Marshal(map[string]any{
		"Service":   "Amazon S3",
		"Event":     "s3:TestEvent",
		"Time":      s3EventTime(now),
		"Bucket":    bucket,
		"RequestId": NewRequestID(),
		"HostId":    stableHash(bucket+"/"+NewRequestID(), 64),
	})
}

// s3EventBridgeEntry returns the PutEvents entry the runner's own bus accepts
// for an observed object change. The bus adds the envelope fields the EventBridge
// page documents (version, id, account, time, region, resources).
func s3EventBridgeEntry(event S3ObjectEvent) eventBridgeEntry {
	detail := map[string]any{
		"version":           "0",
		"event-version":     s3EventBridgeEventVersion,
		"bucket":            map[string]any{"name": event.Bucket},
		"request-id":        event.RequestID,
		"requester":         LocalAccountID,
		"source-ip-address": event.SourceIP,
		"reason":            event.Reason,
	}
	object := map[string]any{
		"key":       event.Key,
		"etag":      strings.Trim(event.ETag, "\""),
		"sequencer": event.Sequencer,
	}
	if event.EventName == s3RecordObjectRemovedDelete || event.EventName == s3RecordObjectRemovedDeleteMarkerCreated {
		detail["deletion-type"] = "Permanently Deleted"
	} else {
		object["size"] = event.Size
	}
	detail["object"] = object
	encoded, err := json.Marshal(detail)
	if err != nil {
		encoded = []byte("{}")
	}
	detailType := s3DetailTypeObjectCreated
	if event.EventName == s3RecordObjectRemovedDelete || event.EventName == s3RecordObjectRemovedDeleteMarkerCreated {
		detailType = s3DetailTypeObjectDeleted
	}
	return eventBridgeEntry{
		Source:     s3EventBridgeSource,
		DetailType: detailType,
		Detail:     string(encoded),
		Resources:  []string{event.BucketARN},
		Time:       eventBridgeTimeOf(event.Time),
	}
}

// encodeS3Key renders an object key the way S3 renders it in a notification:
// space becomes "+", "/" is kept, and every other reserved character is
// percent-encoded.
// https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html
func encodeS3Key(key string) string {
	var builder strings.Builder
	for _, char := range []byte(key) {
		switch {
		case char >= 'a' && char <= 'z', char >= 'A' && char <= 'Z', char >= '0' && char <= '9',
			char == '-', char == '_', char == '.', char == '~', char == '/':
			builder.WriteByte(char)
		case char == ' ':
			builder.WriteByte('+')
		default:
			fmt.Fprintf(&builder, "%%%02X", char)
		}
	}
	return builder.String()
}

// s3EventTime formats an instant as the ISO-8601 millisecond timestamp S3 puts
// in eventTime and the test event.
func s3EventTime(instant time.Time) string {
	return instant.UTC().Format("2006-01-02T15:04:05.000Z")
}

// notificationMatches reports whether an observed record event and key satisfy
// one notification configuration: every declared event name and each prefix and
// suffix filter rule.
func notificationMatches(notification NotificationSpec, recordEvent, key string) bool {
	if notification.EventBridge {
		return true
	}
	matchesEvent := false
	for _, declared := range notification.Events {
		if s3EventNameMatches(declared, recordEvent) {
			matchesEvent = true
			break
		}
	}
	if !matchesEvent {
		return false
	}
	for _, rule := range notification.FilterRules {
		switch strings.ToLower(strings.TrimSpace(rule.Name)) {
		case "prefix":
			if !strings.HasPrefix(key, rule.Value) {
				return false
			}
		case "suffix":
			if !strings.HasSuffix(key, rule.Value) {
				return false
			}
		}
	}
	return true
}

// s3EventNameMatches compares a configuration event name (with the s3: prefix,
// possibly ending in ":*") with a record event name (without the prefix).
func s3EventNameMatches(declared, recordEvent string) bool {
	pattern := strings.TrimPrefix(strings.TrimSpace(declared), "s3:")
	if pattern == recordEvent {
		return true
	}
	if !strings.HasSuffix(pattern, ":*") {
		return false
	}
	family := strings.TrimSuffix(pattern, ":*")
	return strings.HasPrefix(recordEvent, family+":")
}
