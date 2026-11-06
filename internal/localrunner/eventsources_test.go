package localrunner

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"io"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

func TestBuildSQSEventUsesReceivedMessages(t *testing.T) {
	messages := []sqstypes.Message{{
		MessageId:     aws.String("m-1"),
		ReceiptHandle: aws.String("r-1"),
		Body:          aws.String(`{"ok":true}`),
		MD5OfBody:     aws.String("d41d8cd98f00b204e9800998ecf8427e"),
		Attributes: map[string]string{
			"ApproximateReceiveCount": "1",
			"SentTimestamp":           "1790000000000",
		},
	}}
	encoded, err := BuildSQSEvent("arn:aws:sqs:us-east-1:123456789012:events", messages)
	if err != nil {
		t.Fatalf("build sqs event: %v", err)
	}
	var event struct {
		Records []map[string]any `json:"Records"`
	}
	if err := json.Unmarshal(encoded, &event); err != nil {
		t.Fatalf("decode event: %v", err)
	}
	if len(event.Records) != 1 {
		t.Fatalf("want one record, got %d", len(event.Records))
	}
	record := event.Records[0]
	if record["messageId"] != "m-1" || record["body"] != `{"ok":true}` {
		t.Fatalf("message identity was not preserved: %+v", record)
	}
	if record["eventSource"] != "aws:sqs" || record["eventSourceARN"] != "arn:aws:sqs:us-east-1:123456789012:events" {
		t.Fatalf("source fields are not provider-shaped: %+v", record)
	}
	attributes, ok := record["attributes"].(map[string]any)
	if !ok || attributes["ApproximateReceiveCount"] != "1" {
		t.Fatalf("receive attributes missing: %+v", record["attributes"])
	}
}

func TestBuildDynamoDBStreamEventUsesTypedStoredImage(t *testing.T) {
	keys := map[string]types.AttributeValue{
		"pk": &types.AttributeValueMemberS{Value: "item-1"},
	}
	image := map[string]types.AttributeValue{
		"pk":    &types.AttributeValueMemberS{Value: "item-1"},
		"value": &types.AttributeValueMemberS{Value: "stored"},
		"count": &types.AttributeValueMemberN{Value: "2"},
	}
	encoded, err := BuildDynamoDBStreamEvent(DynamoDBStreamInput{
		EventSourceARN: "arn:aws:dynamodb:us-east-1:123456789012:table/items/stream/1",
		EventName:      "INSERT",
		Keys:           keys,
		NewImage:       image,
		StreamViewType: "NEW_AND_OLD_IMAGES",
		SequenceNumber: "100",
		Now:            time.Unix(1790000000, 0).UTC(),
	})
	if err != nil {
		t.Fatalf("build stream event: %v", err)
	}
	var event struct {
		Records []struct {
			EventName   string `json:"eventName"`
			EventSource string `json:"eventSource"`
			DynamoDB    struct {
				Keys           map[string]map[string]any `json:"Keys"`
				NewImage       map[string]map[string]any `json:"NewImage"`
				StreamViewType string                    `json:"StreamViewType"`
				SequenceNumber string                    `json:"SequenceNumber"`
			} `json:"dynamodb"`
		} `json:"Records"`
	}
	if err := json.Unmarshal(encoded, &event); err != nil {
		t.Fatalf("decode event: %v", err)
	}
	record := event.Records[0]
	if record.EventName != "INSERT" || record.EventSource != "aws:dynamodb" {
		t.Fatalf("unexpected record envelope: %+v", record)
	}
	if record.DynamoDB.Keys["pk"]["S"] != "item-1" {
		t.Fatalf("keys are not DynamoDB JSON: %+v", record.DynamoDB.Keys)
	}
	if record.DynamoDB.NewImage["value"]["S"] != "stored" || record.DynamoDB.NewImage["count"]["N"] != "2" {
		t.Fatalf("new image is not DynamoDB JSON: %+v", record.DynamoDB.NewImage)
	}
	if record.DynamoDB.StreamViewType != "NEW_AND_OLD_IMAGES" || record.DynamoDB.SequenceNumber != "100" {
		t.Fatalf("stream metadata lost: %+v", record.DynamoDB)
	}
}

func TestBuildDynamoDBStreamEventHonoursKeysOnly(t *testing.T) {
	encoded, err := BuildDynamoDBStreamEvent(DynamoDBStreamInput{
		EventSourceARN: "arn:aws:dynamodb:us-east-1:123456789012:table/items/stream/1",
		EventName:      "MODIFY",
		Keys: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: "item-1"},
		},
		NewImage: map[string]types.AttributeValue{
			"pk": &types.AttributeValueMemberS{Value: "item-1"},
		},
		StreamViewType: "KEYS_ONLY",
	})
	if err != nil {
		t.Fatalf("build stream event: %v", err)
	}
	var event map[string]any
	if decodeErr := json.Unmarshal(encoded, &event); decodeErr != nil {
		t.Fatalf("decode event: %v", decodeErr)
	}
	record := mustMap(t, mustSlice(t, event["Records"])[0])
	dynamodb := mustMap(t, record["dynamodb"])
	if _, ok := dynamodb["NewImage"]; ok {
		t.Fatalf("KEYS_ONLY must not carry an image: %+v", dynamodb)
	}
}

func TestBuildEventBridgeEventUsesTheRuleIdentity(t *testing.T) {
	schedule := RuleSpec{
		LogicalID: "Schedule", Name: "schedule-rule",
		ARN:      "arn:aws:events:us-east-1:123456789012:rule/schedule-rule",
		Schedule: "rate(5 minutes)", Enabled: true,
	}
	encoded, err := BuildEventBridgeEvent(schedule, nil, "", "", time.Unix(1790000000, 0).UTC())
	if err != nil {
		t.Fatalf("build schedule event: %v", err)
	}
	var event map[string]any
	if decodeErr := json.Unmarshal(encoded, &event); decodeErr != nil {
		t.Fatalf("decode event: %v", decodeErr)
	}
	if event["source"] != "aws.events" || event["detail-type"] != "Scheduled Event" {
		t.Fatalf("schedule identity lost: %+v", event)
	}
	resources := mustSlice(t, event["resources"])
	if len(resources) != 1 || resources[0] != schedule.ARN {
		t.Fatalf("schedule resources lost: %+v", resources)
	}

	pattern := RuleSpec{
		LogicalID: "Pattern", Name: "pattern-rule",
		ARN:          "arn:aws:events:us-east-1:123456789012:rule/pattern-rule",
		EventPattern: json.RawMessage(`{"source":["apptheory.example"],"detail-type":["example.item.changed"]}`),
		Enabled:      true,
	}
	encoded, err = BuildEventBridgeEvent(pattern, json.RawMessage(`{"item":"a4"}`), "", "", time.Unix(1790000000, 0).UTC())
	if err != nil {
		t.Fatalf("build pattern event: %v", err)
	}
	if err := json.Unmarshal(encoded, &event); err != nil {
		t.Fatalf("decode pattern event: %v", err)
	}
	if event["source"] != "apptheory.example" || event["detail-type"] != "example.item.changed" {
		t.Fatalf("pattern identity was not read from the CDK rule: %+v", event)
	}
}

func TestBuildCloudWatchLogsKinesisEventIsGzipBase64(t *testing.T) {
	encoded, err := BuildCloudWatchLogsKinesisEvent(
		"arn:aws:kinesis:us-east-1:123456789012:stream/logs",
		"/aws/example", "stream-1", []string{"filter-1"},
		[]CloudWatchLogEvent{{ID: "1", Timestamp: 1790000000000, Message: "order processed"}},
		time.Unix(1790000000, 0).UTC(),
	)
	if err != nil {
		t.Fatalf("build kinesis event: %v", err)
	}
	var event struct {
		Records []struct {
			Kinesis struct {
				Data string `json:"data"`
			} `json:"kinesis"`
		} `json:"Records"`
	}
	if decodeErr := json.Unmarshal(encoded, &event); decodeErr != nil {
		t.Fatalf("decode event: %v", decodeErr)
	}
	compressed, err := base64.StdEncoding.DecodeString(event.Records[0].Kinesis.Data)
	if err != nil {
		t.Fatalf("decode data: %v", err)
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	payload, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read payload: %v", err)
	}
	if err := reader.Close(); err != nil {
		t.Fatalf("close gzip reader: %v", err)
	}
	var decoded struct {
		MessageType string `json:"messageType"`
		LogEvents   []struct {
			Message string `json:"message"`
		} `json:"logEvents"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if decoded.MessageType != "DATA_MESSAGE" || len(decoded.LogEvents) != 1 || decoded.LogEvents[0].Message != "order processed" {
		t.Fatalf("unexpected CloudWatch Logs payload: %s", payload)
	}
}
