package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// The resources example's handler. Two entry points share one binary:
//
//   - APPTHEORY_LOCAL_RESOURCES_ROLE=mail makes the handler the SES receipt
//     rule's Lambda action: it records the received-message record's fields and
//     the object the rule's S3 action wrote, and serves that record over
//     GET /state.
//   - Otherwise it is the plain state API's handler.
//
// The received-message record is the one SES documents:
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda-event.html

// receivedRecord is what the mail handler records for one received message.
type receivedRecord struct {
	MessageID    string   `json:"messageId"`
	Source       string   `json:"source"`
	Destination  []string `json:"destination"`
	Recipients   []string `json:"recipients"`
	Subject      string   `json:"subject"`
	From         []string `json:"from"`
	HeaderCount  int      `json:"headerCount"`
	ActionType   string   `json:"actionType"`
	FunctionARN  string   `json:"functionArn"`
	Invocation   string   `json:"invocationType"`
	ReceiptStamp string   `json:"receiptTimestamp"`
	RawObject    string   `json:"rawObject"`
}

// state is the in-memory record the state API serves.
var state []receivedRecord

func main() {
	lambda.Start(handle)
}

func handle(ctx context.Context, event json.RawMessage) (any, error) {
	// One function serves both entry points the example declares: the SES
	// receipt rule's Lambda action, whose event carries Records, and the state
	// API's GET, whose event carries requestContext.
	if os.Getenv("APPTHEORY_LOCAL_RESOURCES_ROLE") != "" && strings.Contains(string(event), `"Records"`) {
		return receive(ctx, event)
	}
	return stateResponse()
}

// receive renders the received-message record and reads the object the rule's
// S3 action wrote.
//
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda-event.html
func receive(ctx context.Context, event json.RawMessage) (any, error) {
	var payload struct {
		Records []struct {
			EventSource string `json:"eventSource"`
			SES         struct {
				Mail struct {
					MessageID   string   `json:"messageId"`
					Source      string   `json:"source"`
					Destination []string `json:"destination"`
					Headers     []struct {
						Name  string `json:"name"`
						Value string `json:"value"`
					} `json:"headers"`
					CommonHeaders struct {
						Subject string   `json:"subject"`
						From    []string `json:"from"`
					} `json:"commonHeaders"`
				} `json:"mail"`
				Receipt struct {
					Timestamp  string   `json:"timestamp"`
					Recipients []string `json:"recipients"`
					Action     struct {
						Type           string `json:"type"`
						FunctionARN    string `json:"functionArn"`
						InvocationType string `json:"invocationType"`
					} `json:"action"`
				} `json:"receipt"`
			} `json:"ses"`
		} `json:"Records"`
	}
	if err := json.Unmarshal(event, &payload); err != nil {
		return nil, fmt.Errorf("the mail handler needs a received-message record: %w", err)
	}
	if len(payload.Records) == 0 {
		return nil, fmt.Errorf("the received-message record carries no Records entry")
	}
	record := payload.Records[0]
	if record.EventSource != "aws:ses" {
		return nil, fmt.Errorf("the record's eventSource is %q, not aws:ses", record.EventSource)
	}
	entry := receivedRecord{
		MessageID:    record.SES.Mail.MessageID,
		Source:       record.SES.Mail.Source,
		Destination:  record.SES.Mail.Destination,
		Recipients:   record.SES.Receipt.Recipients,
		Subject:      record.SES.Mail.CommonHeaders.Subject,
		From:         record.SES.Mail.CommonHeaders.From,
		HeaderCount:  len(record.SES.Mail.Headers),
		ActionType:   record.SES.Receipt.Action.Type,
		FunctionARN:  record.SES.Receipt.Action.FunctionARN,
		Invocation:   record.SES.Receipt.Action.InvocationType,
		ReceiptStamp: record.SES.Receipt.Timestamp,
	}
	key := "mail/" + entry.MessageID
	if object, err := readObject(ctx, key); err == nil {
		entry.RawObject = object
	}
	state = append(state, entry)
	return map[string]any{"ok": true, "messageId": entry.MessageID}, nil
}

// readObject reads the raw message the rule's S3 action wrote, which is how the
// row proves the body landed in the bucket while the Lambda record omitted it.
func readObject(ctx context.Context, key string) (string, error) {
	bucket := os.Getenv("RAW_MAIL_BUCKET")
	if bucket == "" {
		return "", fmt.Errorf("no bucket is configured")
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion("us-east-1"))
	if err != nil {
		return "", err
	}
	client := s3.NewFromConfig(cfg, func(options *s3.Options) {
		// The runner's S3 endpoint is an IP literal, which the SDK treats as a
		// path-style endpoint.
		options.UsePathStyle = true
	})
	object, err := client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil {
		return "", err
	}
	defer func() { _ = object.Body.Close() }()
	body := make([]byte, 0, 4096)
	buffer := make([]byte, 4096)
	for {
		read, readErr := object.Body.Read(buffer)
		body = append(body, buffer[:read]...)
		if readErr != nil {
			break
		}
	}
	return string(body), nil
}

// stateResponse serves what the mail handler recorded.
func stateResponse() (any, error) {
	body, err := json.Marshal(map[string]any{
		"records": state,
		"count":   len(state),
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"statusCode": 200,
		"headers":    map[string]string{"content-type": "application/json"},
		"body":       string(body),
	}, nil
}

// APIGatewayProxyRequest is referenced so the handler accepts a REST event when
// it is invoked through the state API as well.
var _ = events.APIGatewayProxyRequest{}

// ensure the strings import is used by the compiler when the record is trimmed.
var _ = strings.TrimSpace
