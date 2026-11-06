package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// Stream on-failure destinations and the shared batchItemFailures parser.
//
// A stream mapping's DestinationConfig.OnFailure receives an invocation record
// that points at the discarded batch rather than the records themselves. An SQS
// destination receives the record as the message body; an SNS destination
// receives it as the message. The runner can reach both: ElasticMQ for SQS and
// the local SNS fan-out for SNS.
//
// https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-retain-records.html
// https://docs.aws.amazon.com/lambda/latest/dg/invocation-async.html

// streamBatchFailureIdentifiers parses a stream function's
// {"batchItemFailures":[{"itemIdentifier":"<sequence>"}]} response.
//
// Success conditions are an empty list, a null list, an empty response and a
// null response. Invalid JSON, a bad key name, an empty or null identifier and
// an identifier outside the batch are complete failure, as AWS documents:
// https://docs.aws.amazon.com/lambda/latest/dg/services-ddb-batchfailurereporting.html
// https://docs.aws.amazon.com/lambda/latest/dg/services-kinesis-batchfailurereporting.html
func streamBatchFailureIdentifiers(result InvokeResult) ([]string, bool, error) {
	if result.Proxy {
		return nil, true, errors.New("the handler returned a proxy response where a batchItemFailures response is required")
	}
	raw := strings.TrimSpace(string(result.Raw))
	if raw == "" || raw == jsonNull {
		return nil, false, nil
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, true, fmt.Errorf("invalid batch response JSON: %w", err)
	}
	if decoder.More() {
		return nil, true, errors.New("the batch response has content after the JSON value")
	}
	response, ok := value.(map[string]any)
	if !ok {
		return nil, true, errors.New("the batch response is not a JSON object")
	}
	rawFailures, exists := response["batchItemFailures"]
	if !exists || rawFailures == nil {
		return nil, false, nil
	}
	items, ok := rawFailures.([]any)
	if !ok {
		return nil, true, errors.New("batchItemFailures is not a list")
	}
	identifiers := make([]string, 0, len(items))
	for index, item := range items {
		object, ok := item.(map[string]any)
		if !ok {
			return nil, true, fmt.Errorf("batchItemFailures[%d] is not an object", index)
		}
		identifier, ok := object["itemIdentifier"].(string)
		if !ok || strings.TrimSpace(identifier) == "" {
			return nil, true, fmt.Errorf("batchItemFailures[%d] has no non-empty itemIdentifier", index)
		}
		identifiers = append(identifiers, identifier)
	}
	return identifiers, false, nil
}

// sendStreamDiscard sends one on-failure invocation record to the mapping's
// destination.
func sendStreamDiscard(ctx context.Context, env DelivererEnv, mapping EventSourceSpec, body []byte) error {
	switch strings.ToLower(strings.TrimSpace(mapping.DestinationType)) {
	case backendSQS:
		if env.Backend.SQS == nil {
			return errors.New("the SQS backend is not running for the on-failure destination")
		}
		name := strings.TrimSpace(mapping.DestinationName)
		if name == "" {
			return errors.New("the on-failure SQS destination has no queue name")
		}
		found, err := env.Backend.SQS.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{QueueName: aws.String(name)})
		if err != nil {
			return fmt.Errorf("resolve on-failure queue %s: %w", name, err)
		}
		if _, err := env.Backend.SQS.SendMessage(ctx, &sqs.SendMessageInput{
			QueueUrl:    found.QueueUrl,
			MessageBody: aws.String(string(body)),
		}); err != nil {
			return fmt.Errorf("send on-failure record to %s: %w", name, err)
		}
		return nil
	case backendSNS:
		if env.Backend.PublishSNS == nil {
			return errors.New("the SNS backend is not running for the on-failure destination")
		}
		arn := strings.TrimSpace(mapping.DestinationARN)
		if arn == "" {
			return errors.New("the on-failure SNS destination has no topic ARN")
		}
		if err := env.Backend.PublishSNS(ctx, arn, LocalSNSMessage{Message: string(body)}); err != nil {
			return fmt.Errorf("publish on-failure record to %s: %w", arn, err)
		}
		return nil
	default:
		return fmt.Errorf("unsupported on-failure destination type %q", mapping.DestinationType)
	}
}
