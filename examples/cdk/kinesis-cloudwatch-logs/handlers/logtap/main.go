package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"strings"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

const receiptQueueEnv = "RECEIPT_QUEUE_URL"

// CloudWatch Logs delivers a subscription payload as gzip-compressed JSON,
// base64-encoded in awslogs.data:
// https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/SubscriptionFilters.html
type awsLogsInput struct {
	AWSLogs struct {
		Data string `json:"data"`
	} `json:"awslogs"`
}

func decodePayload(encoded string) (map[string]any, error) {
	compressed, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, err
	}
	defer func() { _ = reader.Close() }() //nolint:errcheck // the reader is fully consumed
	raw, err := io.ReadAll(reader)
	if err != nil {
		return nil, err
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func handle(ctx context.Context, raw json.RawMessage) (any, error) {
	var input awsLogsInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, err
	}
	payload, err := decodePayload(input.AWSLogs.Data)
	if err != nil {
		return nil, err
	}
	receipt := map[string]any{
		"kind":    "logtap",
		"payload": payload,
	}
	queueURL := strings.TrimSpace(os.Getenv(receiptQueueEnv))
	if queueURL == "" {
		return receipt, nil
	}
	body, err := json.Marshal(receipt)
	if err != nil {
		return nil, err
	}
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, err
	}
	client := sqs.NewFromConfig(cfg)
	if _, err := client.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl:    aws.String(queueURL),
		MessageBody: aws.String(string(body)),
	}); err != nil {
		return nil, err
	}
	return receipt, nil
}

func main() {
	lambda.Start(handle)
}
