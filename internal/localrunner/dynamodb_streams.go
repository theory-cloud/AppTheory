package localrunner

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// The DynamoDB Streams API is a separate AWS JSON protocol service from the
// DynamoDB data plane. The pinned DynamoDB Local serves both on the same port;
// the runner reads the stream so a real table write becomes a real Lambda
// stream event instead of a synthesized one.
//
// https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html
// https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Operations_Amazon_DynamoDB_Streams.html
const (
	dynamoStreamsService = "dynamodb"
	dynamoStreamsTarget  = "DynamoDBStreams_20120810"
	// dynamoStreamIteratorTrimHorizon and LATEST are the two starting positions
	// DynamoDB supports for a Lambda event source mapping. AT_TIMESTAMP is a
	// Kinesis starting position; DynamoDB returns an internal failure for it on
	// the pinned image, so it is refused at derive time.
	dynamoStreamIteratorTrimHorizon = "TRIM_HORIZON"
	dynamoStreamIteratorLatest      = "LATEST"
	dynamoStreamIteratorAfterSeq    = "AFTER_SEQUENCE_NUMBER"
)

type dynamoStream struct {
	StreamArn   string `json:"StreamArn"`
	StreamLabel string `json:"StreamLabel"`
	TableName   string `json:"TableName"`
}

type dynamoShard struct {
	ShardID             string `json:"ShardId"`
	ParentShardID       string `json:"ParentShardId"`
	SequenceNumberRange struct {
		StartingSequenceNumber string `json:"StartingSequenceNumber"`
		EndingSequenceNumber   string `json:"EndingSequenceNumber"`
	} `json:"SequenceNumberRange"`
}

type dynamoStreamDescription struct {
	StreamArn       string        `json:"StreamArn"`
	StreamLabel     string        `json:"StreamLabel"`
	StreamStatus    string        `json:"StreamStatus"`
	StreamViewType  string        `json:"StreamViewType"`
	TableName       string        `json:"TableName"`
	Shards          []dynamoShard `json:"Shards"`
	LastEvaluatedID string        `json:"LastEvaluatedShardId"`
}

type dynamoGetRecordsOutput struct {
	Records           []map[string]any `json:"Records"`
	NextShardIterator *string          `json:"NextShardIterator"`
	MillisBehind      *int64           `json:"MillisBehindLatest"`
}

// dynamoStreamsClient reads DynamoDB Local's Streams API.
type dynamoStreamsClient struct {
	client *awsJSONClient
}

func newDynamoStreamsClient(endpoint string) *dynamoStreamsClient {
	return &dynamoStreamsClient{client: newAWSJSONClient(endpoint, dynamoStreamsService, dynamoStreamsTarget)}
}

// ListStreams returns the table's streams. DynamoDB Local answers with
// "Streams"; AWS answers with "StreamDescriptions". The runner accepts both and
// never exposes the emulator spelling.
func (c *dynamoStreamsClient) ListStreams(ctx context.Context, table string) ([]dynamoStream, error) {
	var output struct {
		Streams            []dynamoStream `json:"Streams"`
		StreamDescriptions []dynamoStream `json:"StreamDescriptions"`
	}
	if err := c.client.call(ctx, "ListStreams", map[string]any{"TableName": table}, &output); err != nil {
		return nil, err
	}
	// AWS's field wins when both are present so a fixed emulator is read the
	// AWS way.
	if len(output.StreamDescriptions) > 0 {
		return output.StreamDescriptions, nil
	}
	return output.Streams, nil
}

// DescribeStream returns the stream description and follows the shard
// pagination DynamoDB documents.
func (c *dynamoStreamsClient) DescribeStream(ctx context.Context, streamARN string) (dynamoStreamDescription, error) {
	var description dynamoStreamDescription
	exclusive := ""
	for {
		input := map[string]any{"StreamArn": streamARN, "Limit": 100}
		if exclusive != "" {
			input["ExclusiveStartShardId"] = exclusive
		}
		var output struct {
			StreamDescription dynamoStreamDescription `json:"StreamDescription"`
		}
		if err := c.client.call(ctx, "DescribeStream", input, &output); err != nil {
			return dynamoStreamDescription{}, err
		}
		if description.StreamArn == "" {
			description = output.StreamDescription
		} else {
			description.Shards = append(description.Shards, output.StreamDescription.Shards...)
		}
		exclusive = strings.TrimSpace(output.StreamDescription.LastEvaluatedID)
		if exclusive == "" {
			return description, nil
		}
	}
}

// GetShardIterator returns a shard iterator at one starting position.
func (c *dynamoStreamsClient) GetShardIterator(
	ctx context.Context,
	streamARN, shardID, iteratorType, sequenceNumber string,
	timestamp *time.Time,
) (string, error) {
	input := map[string]any{
		"StreamArn":         streamARN,
		"ShardId":           shardID,
		"ShardIteratorType": iteratorType,
	}
	if sequenceNumber != "" {
		input["SequenceNumber"] = sequenceNumber
	}
	if timestamp != nil {
		input["Timestamp"] = *timestamp
	}
	var output struct {
		ShardIterator string `json:"ShardIterator"`
	}
	if err := c.client.call(ctx, "GetShardIterator", input, &output); err != nil {
		return "", err
	}
	if output.ShardIterator == "" {
		return "", fmt.Errorf("GetShardIterator returned no iterator for shard %s", shardID)
	}
	return output.ShardIterator, nil
}

// GetRecords returns up to limit records after the iterator.
func (c *dynamoStreamsClient) GetRecords(ctx context.Context, iterator string, limit int) (dynamoGetRecordsOutput, error) {
	input := map[string]any{"ShardIterator": iterator}
	if limit > 0 {
		input["Limit"] = limit
	}
	var output dynamoGetRecordsOutput
	if err := c.client.call(ctx, "GetRecords", input, &output); err != nil {
		return dynamoGetRecordsOutput{}, err
	}
	return output, nil
}

// normalizeDynamoStreamARN rewrites the emulator's stream ARN into the ARN the
// CDK definition resolves to: the partition, region and account are the local
// values and the table and stream label are preserved.
//
// Observed on amazon/dynamodb-local@sha256:7ef4a2c4 (3.1.0): the ARN region is
// "ddblocal" and the account is "000000000000". The runner never hands either
// to a handler.
func normalizeDynamoStreamARN(streamARN, tableName string) string {
	trimmed := strings.TrimSpace(streamARN)
	if trimmed == "" {
		return ""
	}
	const prefix = "arn:aws:dynamodb:"
	if strings.HasPrefix(trimmed, prefix) {
		rest := strings.TrimPrefix(trimmed, prefix)
		// <region>:<account>:table/<name>/stream/<label>
		parts := strings.SplitN(rest, ":", 3)
		if len(parts) == 3 && strings.HasPrefix(parts[2], "table/") {
			return "arn:" + LocalPartition + ":dynamodb:" + LocalRegion + ":" + LocalAccountID + ":" + parts[2]
		}
	}
	return localSourceARN(backendDynamoDB, tableName)
}

// normalizeDynamoStreamRecord applies the AWS event shape to one record read
// from DynamoDB Local:
//   - awsRegion is the table's Region, not the emulator's "ddblocal";
//   - eventSourceARN is the CDK-resolved stream ARN;
//   - ApproximateCreationDateTime is epoch seconds, not the emulator's ISO
//     string;
//   - a record the runner's TTL sweep deleted carries the documented service
//     userIdentity.
//
// https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html#services-ddb-event
// https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/time-to-live-ttl-streams.html
func normalizeDynamoStreamRecord(record map[string]any, streamARN string, ttlDelete bool) map[string]any {
	normalized := make(map[string]any, len(record))
	for key, value := range record {
		normalized[key] = value
	}
	normalized["awsRegion"] = LocalRegion
	normalized["eventSourceARN"] = streamARN
	if _, ok := normalized["eventSource"]; !ok {
		normalized["eventSource"] = "aws:dynamodb"
	}
	if dynamodb, ok := normalized["dynamodb"].(map[string]any); ok {
		image := make(map[string]any, len(dynamodb))
		for key, value := range dynamodb {
			image[key] = value
		}
		if raw, exists := image["ApproximateCreationDateTime"]; exists {
			image["ApproximateCreationDateTime"] = epochSeconds(raw)
		}
		normalized["dynamodb"] = image
	}
	if ttlDelete {
		normalized["userIdentity"] = map[string]any{
			"type":        "Service",
			"principalId": "dynamodb.amazonaws.com",
		}
	}
	return normalized
}

// epochSeconds converts the emulator's ISO timestamp (or a numeric epoch) to
// the epoch-seconds number the Lambda event carries.
func epochSeconds(value any) any {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case string:
		parsed, err := time.Parse(time.RFC3339Nano, typed)
		if err != nil {
			return typed
		}
		return float64(parsed.UnixNano()) / float64(time.Second)
	default:
		return value
	}
}

// dynamoStreamSequence returns a record's sequence number as a string.
func dynamoStreamSequence(record map[string]any) string {
	dynamodb, ok := record["dynamodb"].(map[string]any)
	if !ok {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(dynamodb["SequenceNumber"]))
}

// dynamoStreamKeys returns the record's key map in DynamoDB JSON.
func dynamoStreamKeys(record map[string]any) map[string]any {
	dynamodb, ok := record["dynamodb"].(map[string]any)
	if !ok {
		return nil
	}
	keys, _ := dynamodb["Keys"].(map[string]any) //nolint:errcheck // a record without keys is filtered out later
	return keys
}
