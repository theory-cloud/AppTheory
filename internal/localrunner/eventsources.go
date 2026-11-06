package localrunner

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

// BuildSQSEvent builds the SQS event an event-source mapping delivers from
// messages a local ElasticMQ queue actually returned.
func BuildSQSEvent(queueARN string, messages []sqstypes.Message) ([]byte, error) {
	records := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		records = append(records, sqsRecordMap(queueARN, message))
	}
	return json.Marshal(map[string]any{"Records": records})
}

// sqsRecordMap builds one SQS record. The shape is the documented standard and
// FIFO event record, including the empty messageAttributes object:
// https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html#example-standard-queue-message-event
func sqsRecordMap(queueARN string, message sqstypes.Message) map[string]any {
	attributes := map[string]string{}
	for name, value := range message.Attributes {
		attributes[name] = value
	}
	record := map[string]any{
		"messageId":         stringValue(message.MessageId),
		"receiptHandle":     stringValue(message.ReceiptHandle),
		"body":              stringValue(message.Body),
		"attributes":        attributes,
		"messageAttributes": sqsMessageAttributes(message.MessageAttributes),
		"eventSource":       "aws:sqs",
		"eventSourceARN":    queueARN,
		"awsRegion":         LocalRegion,
	}
	if message.MD5OfBody != nil {
		record["md5OfBody"] = *message.MD5OfBody
	}
	if message.MD5OfMessageAttributes != nil {
		record["md5OfMessageAttributes"] = *message.MD5OfMessageAttributes
	}
	return record
}

func sqsMessageAttributes(attributes map[string]sqstypes.MessageAttributeValue) map[string]any {
	out := make(map[string]any, len(attributes))
	for name, attribute := range attributes {
		converted := map[string]any{"dataType": stringValue(attribute.DataType)}
		if attribute.StringValue != nil {
			converted["stringValue"] = *attribute.StringValue
		}
		if len(attribute.BinaryValue) > 0 {
			converted["binaryValue"] = base64.StdEncoding.EncodeToString(attribute.BinaryValue)
		}
		out[name] = converted
	}
	return out
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// BuildDynamoDBStreamEvent builds the DynamoDB stream record a stream mapping
// delivers. The images are the typed attribute values read from the local table,
// so the record is generated from the stored image rather than a literal.
func BuildDynamoDBStreamEvent(input DynamoDBStreamInput) ([]byte, error) {
	if input.EventSourceARN == "" {
		return nil, fmt.Errorf("a DynamoDB stream event needs the table stream ARN")
	}
	switch input.EventName {
	case streamEventInsert, streamEventModify, streamEventRemove:
	default:
		return nil, fmt.Errorf("unsupported DynamoDB stream event name %q", input.EventName)
	}
	if len(input.Keys) == 0 {
		return nil, fmt.Errorf("a DynamoDB stream event needs the item keys")
	}
	viewType := strings.TrimSpace(input.StreamViewType)
	if viewType == "" {
		viewType = "NEW_AND_OLD_IMAGES"
	}
	if input.Now.IsZero() {
		input.Now = time.Now().UTC()
	}
	dynamodb := map[string]any{
		"ApproximateCreationDateTime": float64(input.Now.UnixNano()) / float64(time.Second),
		"Keys":                        attributeMapJSON(input.Keys),
		"SequenceNumber":              input.SequenceNumber,
		"SizeBytes":                   streamRecordSize(input),
		"StreamViewType":              viewType,
	}
	switch viewType {
	case "KEYS_ONLY":
	case "NEW_IMAGE":
		if len(input.NewImage) > 0 {
			dynamodb["NewImage"] = attributeMapJSON(input.NewImage)
		}
	case "OLD_IMAGE":
		if len(input.OldImage) > 0 {
			dynamodb["OldImage"] = attributeMapJSON(input.OldImage)
		}
	default:
		if len(input.NewImage) > 0 {
			dynamodb["NewImage"] = attributeMapJSON(input.NewImage)
		}
		if len(input.OldImage) > 0 {
			dynamodb["OldImage"] = attributeMapJSON(input.OldImage)
		}
	}
	record := map[string]any{
		"eventID":        NewRequestID(),
		"eventName":      input.EventName,
		"eventVersion":   "1.1",
		"eventSource":    "aws:dynamodb",
		"awsRegion":      LocalRegion,
		"dynamodb":       dynamodb,
		"eventSourceARN": input.EventSourceARN,
	}
	return json.Marshal(map[string]any{"Records": []any{record}})
}

// DynamoDBStreamInput is one stream record built from a real local write.
type DynamoDBStreamInput struct {
	EventSourceARN string
	EventName      string
	Keys           map[string]types.AttributeValue
	NewImage       map[string]types.AttributeValue
	OldImage       map[string]types.AttributeValue
	StreamViewType string
	SequenceNumber string
	Now            time.Time
}

func streamRecordSize(input DynamoDBStreamInput) int64 {
	var total int
	for _, image := range []map[string]types.AttributeValue{input.Keys, input.NewImage, input.OldImage} {
		if len(image) == 0 {
			continue
		}
		encoded, err := json.Marshal(attributeMapJSON(image))
		if err == nil {
			total += len(encoded)
		}
	}
	return int64(total)
}

// attributeMapJSON converts SDK attribute values into the DynamoDB JSON shape
// AWS puts in a stream record: {"S":"..."}, {"N":"..."} and so on.
func attributeMapJSON(values map[string]types.AttributeValue) map[string]any {
	out := make(map[string]any, len(values))
	for name, value := range values {
		converted, err := attributeValueJSON(value)
		if err != nil {
			continue
		}
		out[name] = converted
	}
	return out
}

func attributeValueJSON(value types.AttributeValue) (any, error) {
	switch typed := value.(type) {
	case *types.AttributeValueMemberS:
		return map[string]any{"S": typed.Value}, nil
	case *types.AttributeValueMemberN:
		return map[string]any{"N": typed.Value}, nil
	case *types.AttributeValueMemberB:
		return map[string]any{"B": base64.StdEncoding.EncodeToString(typed.Value)}, nil
	case *types.AttributeValueMemberBOOL:
		return map[string]any{"BOOL": typed.Value}, nil
	case *types.AttributeValueMemberNULL:
		return map[string]any{"NULL": typed.Value}, nil
	case *types.AttributeValueMemberSS:
		return map[string]any{"SS": append([]string(nil), typed.Value...)}, nil
	case *types.AttributeValueMemberNS:
		return map[string]any{"NS": append([]string(nil), typed.Value...)}, nil
	case *types.AttributeValueMemberBS:
		values := make([]string, 0, len(typed.Value))
		for _, item := range typed.Value {
			values = append(values, base64.StdEncoding.EncodeToString(item))
		}
		return map[string]any{"BS": values}, nil
	case *types.AttributeValueMemberL:
		values := make([]any, 0, len(typed.Value))
		for _, item := range typed.Value {
			converted, err := attributeValueJSON(item)
			if err != nil {
				return nil, err
			}
			values = append(values, converted)
		}
		return map[string]any{"L": values}, nil
	case *types.AttributeValueMemberM:
		return map[string]any{"M": attributeMapJSON(typed.Value)}, nil
	default:
		return nil, fmt.Errorf("unsupported DynamoDB attribute value %T", value)
	}
}

// BuildEventBridgeEvent builds the event an EventBridge rule delivers. A
// scheduled rule gets the Scheduled Event envelope; a pattern rule gets the
// source and detail-type the template declares unless the caller supplies them.
func BuildEventBridgeEvent(rule RuleSpec, detail json.RawMessage, source, detailType string, now time.Time) ([]byte, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if strings.TrimSpace(rule.Schedule) != "" {
		if strings.TrimSpace(source) == "" {
			source = "aws.events"
		}
		if strings.TrimSpace(detailType) == "" {
			detailType = "Scheduled Event"
		}
	} else {
		patternSource, patternDetailType := rulePatternIdentity(rule.EventPattern)
		if strings.TrimSpace(source) == "" {
			source = patternSource
		}
		if strings.TrimSpace(detailType) == "" {
			detailType = patternDetailType
		}
	}
	if strings.TrimSpace(source) == "" || strings.TrimSpace(detailType) == "" {
		return nil, fmt.Errorf("EventBridge rule %s does not declare a source and detail-type", rule.LogicalID)
	}
	if len(bytes.TrimSpace(detail)) == 0 {
		detail = json.RawMessage(`{}`)
	}
	if !json.Valid(detail) {
		return nil, fmt.Errorf("EventBridge detail is not valid JSON")
	}
	event := map[string]any{
		"version":     "0",
		"id":          NewRequestID(),
		"detail-type": detailType,
		"source":      source,
		"account":     LocalAccountID,
		"time":        now.UTC().Format(time.RFC3339),
		"region":      LocalRegion,
		"resources":   []string{rule.ARN},
		"detail":      detail,
	}
	return json.Marshal(event)
}

func rulePatternIdentity(raw json.RawMessage) (string, string) {
	var pattern map[string]any
	if err := json.Unmarshal(raw, &pattern); err != nil {
		return "", ""
	}
	return firstStringValue(pattern["source"]), firstStringValue(pattern["detail-type"])
}

func firstStringValue(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case []any:
		for _, item := range typed {
			if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
				return strings.TrimSpace(text)
			}
		}
	}
	return ""
}

// KinesisRecordInput is one Kinesis record. Data is the raw payload the
// provider base64-encodes into the event.
type KinesisRecordInput struct {
	Data           []byte
	PartitionKey   string
	SequenceNumber string
	// Arrival is the record's approximate arrival time. A zero value uses the
	// batch time, which is what a hand-built session event does.
	Arrival time.Time
}

// BuildKinesisEvent builds the Kinesis event a stream mapping delivers.
func BuildKinesisEvent(streamARN string, records []KinesisRecordInput, now time.Time) ([]byte, error) {
	if streamARN == "" {
		return nil, fmt.Errorf("a Kinesis event needs the stream ARN")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	out := make([]map[string]any, 0, len(records))
	for index, record := range records {
		sequence := strings.TrimSpace(record.SequenceNumber)
		if sequence == "" {
			sequence = fmt.Sprintf("%d", now.UnixNano()+int64(index))
		}
		partition := strings.TrimSpace(record.PartitionKey)
		if partition == "" {
			partition = "local"
		}
		arrival := record.Arrival
		if arrival.IsZero() {
			arrival = now
		}
		out = append(out, map[string]any{
			"kinesis": map[string]any{
				"kinesisSchemaVersion":        "1.0",
				"partitionKey":                partition,
				"sequenceNumber":              sequence,
				"data":                        base64.StdEncoding.EncodeToString(record.Data),
				"approximateArrivalTimestamp": float64(arrival.UnixNano()) / float64(time.Second),
			},
			"eventSource":       "aws:kinesis",
			"eventVersion":      "1.0",
			"eventID":           NewRequestID(),
			"eventName":         "aws:kinesis:record",
			"invokeIdentityArn": "arn:" + LocalPartition + ":iam::" + LocalAccountID + ":role/local-kinesis",
			"awsRegion":         LocalRegion,
			"eventSourceARN":    streamARN,
		})
	}
	return json.Marshal(map[string]any{"Records": out})
}

// CloudWatchLogEvent is one log event in a CloudWatch Logs subscription
// payload.
type CloudWatchLogEvent struct {
	ID        string `json:"id"`
	Timestamp int64  `json:"timestamp"`
	Message   string `json:"message"`
}

// BuildCloudWatchLogsKinesisEvent encodes a CloudWatch Logs subscription
// payload as the gzip+base64 Kinesis record AWS delivers.
func BuildCloudWatchLogsKinesisEvent(streamARN, logGroup, logStream string, subscriptionFilters []string, logEvents []CloudWatchLogEvent, now time.Time) ([]byte, error) {
	if len(logEvents) == 0 {
		return nil, fmt.Errorf("a CloudWatch Logs subscription payload needs at least one log event")
	}
	if strings.TrimSpace(logGroup) == "" || strings.TrimSpace(logStream) == "" {
		return nil, fmt.Errorf("a CloudWatch Logs subscription payload needs a log group and log stream")
	}
	if len(subscriptionFilters) == 0 {
		subscriptionFilters = []string{"local-subscription"}
	}
	payload := map[string]any{
		"messageType":         "DATA_MESSAGE",
		"owner":               LocalAccountID,
		"logGroup":            logGroup,
		"logStream":           logStream,
		"subscriptionFilters": subscriptionFilters,
		"logEvents":           logEvents,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(encoded); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return BuildKinesisEvent(streamARN, []KinesisRecordInput{{
		Data:         compressed.Bytes(),
		PartitionKey: logStream,
	}}, now)
}
