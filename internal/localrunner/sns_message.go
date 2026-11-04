package localrunner

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

// This file builds the three shapes an SNS notification takes at its targets,
// from one observed publish:
//
//   - a Lambda event record (the documented sample event shape):
//     https://docs.aws.amazon.com/lambda/latest/dg/with-sns.html
//   - the JSON notification an HTTP/HTTPS endpoint receives, with the
//     x-amz-sns-* headers:
//     https://docs.aws.amazon.com/sns/latest/dg/sns-message-and-json-formats.html
//   - the SNS envelope an SQS subscription receives, or the raw message body
//     plus SQS message attributes when RawMessageDelivery is enabled:
//     https://docs.aws.amazon.com/sns/latest/dg/sns-large-payload-raw-message-delivery.html
//
// A local signature is emitted so a handler that reads the field does not see
// an empty value. It is a deterministic hash over the subscription ARN and the
// message, not a signature that can be verified against an AWS certificate;
// the local runner has no SNS signing key.

const (
	// snsNotificationType is the SNS message Type for a published message.
	snsNotificationType = "Notification"
	// snsTimestampLayout is the timestamp form SNS puts in its envelopes.
	snsTimestampLayout = "2006-01-02T15:04:05.000Z"
	// snsMaxRawSQSMessageAttributes is the documented limit for raw message
	// delivery to an SQS subscription; SNS discards a message with more:
	// https://docs.aws.amazon.com/sns/latest/dg/sns-large-payload-raw-message-delivery.html
	snsMaxRawSQSMessageAttributes = 10
)

// snsMessageAttribute is one published message attribute. DataType is String,
// Number, String.Array or Binary; BinaryValue holds the decoded bytes.
type snsMessageAttribute struct {
	DataType    string
	StringValue string
	BinaryValue []byte
}

// snsMessage is one observed or locally published SNS notification.
type snsMessage struct {
	MessageID                 string
	TopicARN                  string
	Subject                   string
	Message                   string
	Timestamp                 time.Time
	Signature                 string
	SignatureVersion          string
	SigningCertURL            string
	UnsubscribeURL            string
	Attributes                map[string]snsMessageAttribute
	MessageGroupID            string
	MessageDeduplicationID    string
	ContentBasedDeduplication bool
}

// snsTopicRuntime is the provisioned state of one topic and its drain queue.
type snsTopicRuntime struct {
	LogicalID                 string
	ARN                       string
	Name                      string
	FIFO                      bool
	ContentBasedDeduplication bool
	DrainURL                  string
	DrainARN                  string
	DrainSubscriptionARN      string
	// SubscriptionCount is how many registered subscriptions the topic has.
	// The hub waits for all of them to attach before it starts the drain
	// poller, so a publish cannot overtake a subscription during startup.
	SubscriptionCount int
}

// LocalSNSAttribute is one attribute a local publisher supplies.
type LocalSNSAttribute struct {
	DataType    string
	StringValue string
	BinaryValue []byte
}

// LocalSNSMessage is one message the runner publishes through the local
// fan-out without going through moto. E3 and E4 use PublishLocal for rule and
// notification targets.
type LocalSNSMessage struct {
	Message                string
	Subject                string
	MessageAttributes      map[string]LocalSNSAttribute
	MessageGroupID         string
	MessageDeduplicationID string
}

// snsEnvelope is the JSON body moto delivers to the drain queue for a non-raw
// SQS subscription. Its field names are the documented SNS notification form;
// the URL spellings alternate between AWS's SQS/HTTP body (URL) and the Lambda
// event (Url), so the parser accepts either through encoding/json's
// case-insensitive field matching.
type snsEnvelope struct {
	Type              string `json:"Type"`
	MessageID         string `json:"MessageId"`
	TopicARN          string `json:"TopicArn"`
	Subject           string `json:"Subject"`
	Message           string `json:"Message"`
	Timestamp         string `json:"Timestamp"`
	Signature         string `json:"Signature"`
	SignatureVersion  string `json:"SignatureVersion"`
	SigningCertURL    string `json:"SigningCertURL"`
	UnsubscribeURL    string `json:"UnsubscribeURL"`
	MessageAttributes map[string]struct {
		Type  string `json:"Type"`
		Value string `json:"Value"`
	} `json:"MessageAttributes"`
}

// parseSNSEnvelope decodes one observed SNS envelope. The SQS MessageId and
// system attributes are supplied by the caller; the envelope carries the SNS
// message id, subject, timestamp and attributes.
func parseSNSEnvelope(body string, system map[string]string) (snsMessage, error) {
	var envelope snsEnvelope
	decoder := json.NewDecoder(strings.NewReader(body))
	if err := decoder.Decode(&envelope); err != nil {
		return snsMessage{}, fmt.Errorf("decode the SNS notification envelope: %w", err)
	}
	message := snsMessage{
		MessageID:        envelope.MessageID,
		TopicARN:         envelope.TopicARN,
		Subject:          envelope.Subject,
		Message:          envelope.Message,
		Signature:        envelope.Signature,
		SignatureVersion: envelope.SignatureVersion,
		SigningCertURL:   envelope.SigningCertURL,
		UnsubscribeURL:   envelope.UnsubscribeURL,
		Attributes:       make(map[string]snsMessageAttribute, len(envelope.MessageAttributes)),
	}
	if parsed, err := time.Parse(time.RFC3339Nano, envelope.Timestamp); err == nil {
		message.Timestamp = parsed.UTC()
	}
	for name, attribute := range envelope.MessageAttributes {
		parsed := snsMessageAttribute{
			DataType:    attribute.Type,
			StringValue: attribute.Value,
		}
		if attribute.Type == snsDataTypeBinary {
			if decoded, err := base64.StdEncoding.DecodeString(attribute.Value); err == nil {
				parsed.BinaryValue = decoded
			}
		}
		message.Attributes[name] = parsed
	}
	if system != nil {
		message.MessageGroupID = system[string(sqstypes.MessageSystemAttributeNameMessageGroupId)]
		message.MessageDeduplicationID = system[string(sqstypes.MessageSystemAttributeNameMessageDeduplicationId)]
		if message.MessageDeduplicationID == "" {
			message.MessageDeduplicationID = system["MessageDeduplicationId"]
		}
	}
	return message, nil
}

// snsLocalMessage converts a local publish into the observed-message model.
func snsLocalMessage(topic snsTopicRuntime, input LocalSNSMessage, now time.Time) snsMessage {
	message := snsMessage{
		MessageID:        stableUUID("sns-publish:" + topic.ARN + ":" + now.UTC().Format(time.RFC3339Nano)),
		TopicARN:         topic.ARN,
		Subject:          input.Subject,
		Message:          input.Message,
		Timestamp:        now.UTC(),
		SignatureVersion: "1",
		Attributes:       make(map[string]snsMessageAttribute, len(input.MessageAttributes)),
	}
	if topic.FIFO {
		message.MessageGroupID = input.MessageGroupID
	}
	for name, attribute := range input.MessageAttributes {
		value := snsMessageAttribute(attribute)
		if value.DataType == snsDataTypeBinary && value.StringValue == "" && len(value.BinaryValue) > 0 {
			value.StringValue = base64.StdEncoding.EncodeToString(value.BinaryValue)
		}
		message.Attributes[name] = value
	}
	if topic.FIFO {
		message.MessageDeduplicationID = input.MessageDeduplicationID
		if message.MessageDeduplicationID == "" && topic.ContentBasedDeduplication {
			message.MessageDeduplicationID = snsContentHash(input.Message)
			message.ContentBasedDeduplication = true
		}
	}
	return message
}

// snsContentHash is SNS's content-based deduplication value: the SHA-256 of
// the message body.
// https://docs.aws.amazon.com/sns/latest/dg/sns-fifo-topics.html
func snsContentHash(message string) string {
	sum := sha256.Sum256([]byte(message))
	return fmt.Sprintf("%x", sum[:])
}

// snsObservedDedupID returns the deduplication id SNS used for an observed
// FIFO publish. moto delivers the publish's explicit id through the drain
// queue's system attributes; when the publisher relied on content-based
// deduplication, moto instead reports the SHA-256 of the envelope it built.
// The envelope hash is recomputed here to tell the two cases apart, and the
// SNS deduplication id is then the SHA-256 of the message body, as AWS
// defines it.
func snsObservedDedupID(envelopeBody string, message snsMessage) (string, bool) {
	if message.MessageDeduplicationID == "" {
		return "", false
	}
	if message.MessageDeduplicationID == snsContentHash(envelopeBody) {
		return snsContentHash(message.Message), true
	}
	return message.MessageDeduplicationID, false
}

// snsSignature builds the documented-signature placeholder. It is not
// verifiable against AWS: the runner has no SNS signing key. The value is
// deterministic for a subscription and message so a local test can compare it.
func snsSignature(subscriptionARN string, message snsMessage) string {
	sum := sha256.Sum256([]byte(subscriptionARN + "\x00" + message.MessageID + "\x00" + message.Message))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// snsSigningCertURL returns the certificate URL a local notification names.
func snsSigningCertURL(message snsMessage) string {
	if strings.TrimSpace(message.SigningCertURL) != "" {
		return message.SigningCertURL
	}
	return "https://sns." + LocalRegion + ".amazonaws.com/SimpleNotificationService-local.pem"
}

// snsUnsubscribeURL builds the documented UnsubscribeUrl for a local
// subscription. The runner does not serve the unsubscribe action; the value is
// metadata, and it names the subscription the runner actually registered
// rather than moto's placeholder.
func snsUnsubscribeURL(endpoint, subscriptionARN string) string {
	base := strings.TrimRight(strings.TrimSpace(endpoint), "/")
	if base == "" {
		base = "https://sns." + LocalRegion + ".amazonaws.com"
	}
	return base + "/?Action=Unsubscribe&SubscriptionArn=" + subscriptionARN
}

// snsLambdaEvent builds the documented Lambda SNS event record for one
// subscription. The Lambda sample renames only the unsubscribe field to
// "UnsubscribeUrl"; the certificate field stays "SigningCertURL".
// https://docs.aws.amazon.com/lambda/latest/dg/with-sns.html
func snsLambdaEvent(message snsMessage, subscriptionARN, endpoint string) []byte {
	fields := snsNotificationFields(message, subscriptionARN, endpoint)
	fields["UnsubscribeUrl"] = fields["UnsubscribeURL"]
	delete(fields, "UnsubscribeURL")
	record := map[string]any{
		"EventVersion":         "1.0",
		"EventSubscriptionArn": subscriptionARN,
		"EventSource":          "aws:sns",
		"Sns":                  fields,
	}
	encoded, err := json.Marshal(map[string]any{"Records": []any{record}})
	if err != nil {
		return nil
	}
	return encoded
}

// snsNotificationJSON builds the JSON body an SQS or HTTP/HTTPS subscription
// receives when raw message delivery is disabled. SQS and HTTP/HTTPS use the
// same body; both name the fields with "URL".
// https://docs.aws.amazon.com/sns/latest/dg/sns-message-and-json-formats.html
func snsNotificationJSON(message snsMessage, subscriptionARN, endpoint string) []byte {
	encoded, err := json.Marshal(snsNotificationFields(message, subscriptionARN, endpoint))
	if err != nil {
		return nil
	}
	return encoded
}

// snsNotificationFields builds the shared notification object.
func snsNotificationFields(message snsMessage, subscriptionARN, endpoint string) map[string]any {
	timestamp := message.Timestamp.UTC()
	if timestamp.IsZero() {
		timestamp = time.Now().UTC()
	}
	fields := map[string]any{
		"SignatureVersion": "1",
		"Timestamp":        timestamp.Format(snsTimestampLayout),
		"Signature":        snsSignature(subscriptionARN, message),
		"SigningCertURL":   snsSigningCertURL(message),
		"MessageId":        message.MessageID,
		"Message":          message.Message,
		"Type":             snsNotificationType,
		"UnsubscribeURL":   snsUnsubscribeURL(endpoint, subscriptionARN),
		"TopicArn":         message.TopicARN,
	}
	if message.Subject != "" {
		fields["Subject"] = message.Subject
	}
	if len(message.Attributes) > 0 {
		attributes := make(map[string]any, len(message.Attributes))
		for name, attribute := range message.Attributes {
			attributes[name] = map[string]any{
				"Type":  attribute.DataType,
				"Value": attribute.StringValue,
			}
		}
		fields["MessageAttributes"] = attributes
	}
	return fields
}

// snsSQSRawAttributes converts SNS message attributes to the SQS message
// attributes that accompany raw delivery.
func snsSQSRawAttributes(attributes map[string]snsMessageAttribute) map[string]sqstypes.MessageAttributeValue {
	if len(attributes) == 0 {
		return nil
	}
	out := make(map[string]sqstypes.MessageAttributeValue, len(attributes))
	for name, attribute := range attributes {
		value := sqstypes.MessageAttributeValue{DataType: &attribute.DataType}
		switch attribute.DataType {
		case snsDataTypeBinary:
			value.BinaryValue = append([]byte(nil), attribute.BinaryValue...)
		default:
			text := attribute.StringValue
			value.StringValue = &text
		}
		out[name] = value
	}
	return out
}

// stableUUID renders a deterministic UUID-shaped identifier from a seed.
func stableUUID(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	value := sum[:16]
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
}

// snsSubscriptionARN builds the local subscription ARN the runner reports in
// Lambda records, HTTP headers and the UnsubscribeUrl.
func snsSubscriptionARN(topicARN, logicalID string) string {
	return topicARN + ":" + stableUUID("sns-subscription:"+logicalID)
}
