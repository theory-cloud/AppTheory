package localrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"net/mail"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Received-mail delivery.
//
// One injected message runs the rule the way SES runs it: every action in the
// rule's order. The S3 action writes the raw message under the rule's object key
// prefix, and the Lambda action invokes the function with the received-message
// record. The body is deliberately absent from the Lambda record, which is what
// SES documents ("it omits the body of the incoming email"); the S3 copy is where
// the body lives.
//
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda-event.html
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html

// receivedMessage is one message the session injects.
type receivedMessage struct {
	// Source is the envelope sender.
	Source string
	// Recipients are the envelope recipients.
	Recipients []string
	// Raw is the complete RFC 5322 message.
	Raw string
	// MessageID overrides the generated SES message id.
	MessageID string
}

// receiptDelivery is what one injected message produced.
type receiptDelivery struct {
	MessageID  string           `json:"messageId"`
	Recipients []string         `json:"recipients"`
	Rules      []receiptOutcome `json:"rules"`
}

// receiptOutcome is one rule's result.
type receiptOutcome struct {
	LogicalID string              `json:"logicalId"`
	Actions   []receiptActionDone `json:"actions"`
}

// receiptActionDone is one action's result.
type receiptActionDone struct {
	Kind string `json:"kind"`
	// Function and StatusCode describe a Lambda action's invocation.
	Function   string `json:"function,omitempty"`
	StatusCode int    `json:"statusCode,omitempty"`
	// Bucket and Key describe an S3 action's object.
	Bucket string `json:"bucket,omitempty"`
	Key    string `json:"key,omitempty"`
}

// receiveMessage delivers one message to every matching receipt rule. A message
// no rule matches is refused by name, exactly as SES bounces a recipient the
// rule set does not accept.
//
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-concepts.html
func (s *localSession) receiveMessage(ctx context.Context, message receivedMessage) (receiptDelivery, error) {
	if strings.TrimSpace(message.Raw) == "" {
		return receiptDelivery{}, fmt.Errorf("ses.receive needs the raw message")
	}
	if len(message.Recipients) == 0 {
		return receiptDelivery{}, fmt.Errorf("ses.receive needs at least one recipient")
	}
	if len(s.spec.ReceiptRules) == 0 {
		return receiptDelivery{}, fmt.Errorf("the assembly declares no AWS::SES::ReceiptRule, so no message can be received")
	}
	now := s.runner.clock.Now()
	messageID := message.MessageID
	if messageID == "" {
		messageID = fmt.Sprintf("%s-%s-000000", s.runner.runID, now.Format("20060102T150405Z"))
	}
	delivery := receiptDelivery{MessageID: messageID, Recipients: message.Recipients}
	parsed, parseErr := parseReceiptMessage(message.Raw)
	if parseErr != nil {
		return delivery, parseErr
	}
	headers, common := parsed.headers, parsed.common
	for _, rule := range receiptRulesFor(s.spec.ReceiptRules, message.Recipients[0]) {
		outcome, err := s.runReceiptRule(ctx, rule, message, messageID, now, headers, common)
		if err != nil {
			return delivery, err
		}
		delivery.Rules = append(delivery.Rules, outcome)
	}
	if len(delivery.Rules) == 0 {
		return delivery, fmt.Errorf(
			"SES has no enabled receipt rule for recipient %q; the rule set refuses the message",
			message.Recipients[0])
	}
	return delivery, nil
}

// runReceiptRule applies one rule's actions in order.
func (s *localSession) runReceiptRule(
	ctx context.Context,
	rule ReceiptRuleSpec,
	message receivedMessage,
	messageID string,
	now time.Time,
	headers []receiptHeader,
	common map[string]any,
) (receiptOutcome, error) {
	outcome := receiptOutcome{LogicalID: rule.LogicalID}
	for _, action := range rule.Actions {
		switch action.Kind {
		case receiptActionStop:
			return outcome, nil
		case receiptActionS3:
			key := receiptObjectKey(action.ObjectKeyPrefix, messageID)
			if err := s.runner.writeReceiptObject(ctx, action.Bucket, key, message.Raw); err != nil {
				return outcome, err
			}
			outcome.Actions = append(outcome.Actions, receiptActionDone{Kind: receiptActionS3, Bucket: action.Bucket, Key: key})
		case receiptActionLambda:
			invoker, ok := s.runner.invokers[action.Function]
			if !ok {
				return outcome, fmt.Errorf("the receipt rule's Lambda action targets %s, which is not running", action.Function)
			}
			event, err := s.runner.receiptEvent(s.spec, receiptEventInput{
				rule:       rule,
				action:     action,
				message:    message,
				messageID:  messageID,
				receivedAt: now,
				headers:    headers,
				common:     common,
			})
			if err != nil {
				return outcome, err
			}
			raw, invokeErr := invoker.Invoke(ctx, event)
			status := 0
			if response, decodeErr := DecodeResponse(raw); decodeErr == nil {
				status = response.StatusCode
			}
			if invokeErr != nil {
				return outcome, fmt.Errorf("the receipt rule's Lambda action %s failed: %w", action.Function, invokeErr)
			}
			outcome.Actions = append(outcome.Actions, receiptActionDone{
				Kind:       receiptActionLambda,
				Function:   action.Function,
				StatusCode: status,
			})
		default:
			return outcome, fmt.Errorf("the receipt rule's %s action is not served locally", action.Kind)
		}
	}
	return outcome, nil
}

// receiptEventInput is everything one received-message record carries.
type receiptEventInput struct {
	rule       ReceiptRuleSpec
	action     ReceiptAction
	message    receivedMessage
	messageID  string
	receivedAt time.Time
	headers    []receiptHeader
	common     map[string]any
}

// parsedReceiptMessage is the part of an RFC 5322 message the receipt record
// carries.
type parsedReceiptMessage struct {
	headers []receiptHeader
	common  map[string]any
}

// parseReceiptMessage reads a raw message's headers. SES parses the message it
// accepts and puts the headers in the record; a message with no header block is
// refused rather than delivered with an empty record.
//
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda-event.html
func parseReceiptMessage(raw string) (parsedReceiptMessage, error) {
	parsed, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		return parsedReceiptMessage{}, fmt.Errorf("the received message is not a valid RFC 5322 message: %w", err)
	}
	return parsedReceiptMessage{
		headers: receiptHeaders(parsed.Header),
		common:  receiptCommonHeaders(parsed.Header),
	}, nil
}

// receiptHeader is one message header in the documented record.
type receiptHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// receiptHeaders renders the message headers in their original order.
func receiptHeaders(header mail.Header) []receiptHeader {
	names := make([]string, 0, len(header))
	for name := range header {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]receiptHeader, 0, len(header))
	for _, name := range names {
		for _, value := range header[name] {
			out = append(out, receiptHeader{Name: name, Value: value})
		}
	}
	return out
}

// receiptCommonHeaders renders the commonHeaders object SES documents.
func receiptCommonHeaders(header mail.Header) map[string]any {
	common := map[string]any{}
	if value := header.Get("Return-Path"); value != "" {
		common["returnPath"] = strings.Trim(value, "<>")
	}
	if value := header.Get("From"); value != "" {
		common["from"] = []string{value}
	}
	if value := header.Get("Date"); value != "" {
		common["date"] = value
	}
	if value := header.Get("To"); value != "" {
		common["to"] = splitAddressList(value)
	}
	if value := header.Get("Message-ID"); value != "" {
		common["messageId"] = value
	}
	if value := header.Get("Subject"); value != "" {
		common["subject"] = value
	}
	return common
}

// splitAddressList splits a To header into its addresses.
func splitAddressList(value string) []string {
	addresses, err := mail.ParseAddressList(value)
	if err != nil || len(addresses) == 0 {
		return []string{value}
	}
	out := make([]string, 0, len(addresses))
	for _, address := range addresses {
		out = append(out, address.Address)
	}
	return out
}

// receiptObjectKey is the S3 object key SES writes: the rule's prefix followed
// by the message id.
//
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html
func receiptObjectKey(prefix, messageID string) string {
	prefix = strings.TrimSpace(prefix)
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return prefix + messageID
}

// receiptEvent builds the received-message record a Lambda action delivers.
//
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda-event.html
func (r *Runner) receiptEvent(spec *Spec, in receiptEventInput) ([]byte, error) {
	timestamp := in.receivedAt.UTC().Format(time.RFC3339Nano)
	functionARN := r.functionARN(spec, in.action.Function)
	if functionARN == "" {
		return nil, fmt.Errorf("the receipt rule's Lambda action %s has no local ARN", in.action.Function)
	}
	invocationType := in.action.InvocationType
	if invocationType == "" {
		invocationType = receiptInvocationEvent
	}
	destination := make([]any, 0, len(in.message.Recipients))
	for _, recipient := range in.message.Recipients {
		destination = append(destination, recipient)
	}
	recipients := make([]any, 0, len(in.message.Recipients))
	for _, recipient := range in.message.Recipients {
		recipients = append(recipients, recipient)
	}
	headers := make([]any, 0, len(in.headers))
	for _, header := range in.headers {
		headers = append(headers, map[string]any{"name": header.Name, "value": header.Value})
	}
	source := in.message.Source
	if source == "" {
		source = fmt.Sprintf("0000000000000000-%s@amazonses.com", in.messageID)
	}
	event := map[string]any{
		"Records": []any{map[string]any{
			"eventSource":  "aws:ses",
			"eventVersion": "1.0",
			"ses": map[string]any{
				"mail": map[string]any{
					"timestamp":        timestamp,
					"source":           source,
					"messageId":        in.messageID,
					"destination":      destination,
					"headersTruncated": false,
					"headers":          headers,
					"commonHeaders":    in.common,
				},
				"receipt": map[string]any{
					"timestamp":            timestamp,
					"processingTimeMillis": int64(1),
					"recipients":           recipients,
					"spamVerdict":          map[string]any{"status": "PASS"},
					"virusVerdict":         map[string]any{"status": "PASS"},
					"spfVerdict":           map[string]any{"status": "PASS"},
					"dkimVerdict":          map[string]any{"status": "PASS"},
					"dmarcVerdict":         map[string]any{"status": "GRAY"},
					"action": map[string]any{
						"type":           "Lambda",
						"functionArn":    functionARN,
						"invocationType": invocationType,
					},
				},
			},
		}},
	}
	return json.Marshal(event)
}

// writeReceiptObject stores one raw message through the run's S3 client. The
// object key is the rule's prefix plus the message id, which is where an
// application reads the body from.
//
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html
func (r *Runner) writeReceiptObject(ctx context.Context, qualifiedBucket, key, body string) error {
	resource, ok := r.bucketResource(qualifiedBucket)
	if !ok {
		return fmt.Errorf("the receipt rule's S3 action names %s, which the assembly does not declare", qualifiedBucket)
	}
	value, ok := r.resourceValues[resource.Stack+"/"+resource.LogicalID]
	if !ok {
		return fmt.Errorf("S3 bucket %s is not provisioned; start the run with --backend s3proxy", qualifiedBucket)
	}
	backend, ok := r.backendForService("s3")
	if !ok || backend.HostURL == "" {
		return fmt.Errorf("the receipt rule's S3 action needs the s3proxy backend (--backend s3proxy)")
	}
	_, err := newS3Client(backend.HostURL).PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(value.Name),
		Key:         aws.String(key),
		Body:        strings.NewReader(body),
		ContentType: aws.String("text/plain"),
	})
	return err
}

// bucketResource finds the AWS::S3::Bucket a qualified logical id names.
func (r *Runner) bucketResource(qualified string) (ResourceSpec, bool) {
	spec := r.CurrentSpec()
	if spec == nil {
		return ResourceSpec{}, false
	}
	stack, logicalID := "", qualified
	if prefix, rest, ok := strings.Cut(qualified, "/"); ok {
		stack, logicalID = prefix, rest
	}
	for _, resource := range spec.Resources {
		if resource.Type != typeS3Bucket || resource.LogicalID != logicalID {
			continue
		}
		if stack != "" && resource.Stack != stack {
			continue
		}
		return resource, true
	}
	return ResourceSpec{}, false
}
