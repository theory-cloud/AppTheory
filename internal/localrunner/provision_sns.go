package localrunner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

// provisionSNSDrain creates the runner-owned queue moto delivers a topic's
// notifications to, and subscribes it. The runner observes every publish by
// polling this queue; it never creates the application's own subscriptions in
// moto, because moto cannot reach the Runtime Interface Emulator or ElasticMQ.
//
// The drain subscription is a normal SQS subscription (not raw): moto then
// writes the documented SNS notification envelope, which preserves the SNS
// message id, subject, timestamp and message attributes. A FIFO topic gets a
// FIFO drain queue with content-based deduplication so moto also carries the
// message group and deduplication ids, and so a publish that relies on
// content-based deduplication is accepted.
//
// https://docs.aws.amazon.com/sns/latest/dg/sns-message-and-json-formats.html
// https://docs.aws.amazon.com/sns/latest/dg/sns-fifo-topics.html
func (r *Runner) provisionSNSDrain(
	ctx context.Context,
	topic *snsTopicRuntime,
	snsClient *sns.Client,
	sqsClient *sqs.Client,
) error {
	name := snsDrainQueueName(topic)
	attributes := map[string]string{}
	if topic.FIFO {
		attributes["FifoQueue"] = boolTrue
		// A FIFO drain queue must accept a publish that has no explicit
		// deduplication id; the topic's ContentBasedDeduplication setting is
		// what AWS uses in that case.
		attributes["ContentBasedDeduplication"] = boolTrue
	}
	attributes["VisibilityTimeout"] = fmt.Sprintf("%d", int(snsDrainVisibility.Seconds()))
	created, err := sqsClient.CreateQueue(ctx, &sqs.CreateQueueInput{
		QueueName:  aws.String(name),
		Attributes: attributes,
	})
	if err != nil && !queueAlreadyExists(err) {
		return fmt.Errorf("create the SNS drain queue %s for %s: %w", name, topic.LogicalID, err)
	}
	queueURL := ""
	if created != nil {
		queueURL = aws.ToString(created.QueueUrl)
	}
	if queueURL == "" {
		found, findErr := sqsClient.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{QueueName: aws.String(name)})
		if findErr != nil {
			return fmt.Errorf("find the SNS drain queue %s for %s: %w", name, topic.LogicalID, findErr)
		}
		queueURL = aws.ToString(found.QueueUrl)
	}
	attributesOut, err := sqsClient.GetQueueAttributes(ctx, &sqs.GetQueueAttributesInput{
		QueueUrl:       aws.String(queueURL),
		AttributeNames: []sqstypes.QueueAttributeName{sqstypes.QueueAttributeNameAll},
	})
	if err != nil {
		return fmt.Errorf("read the SNS drain queue %s attributes: %w", name, err)
	}
	topic.DrainURL = queueURL
	topic.DrainARN = strings.TrimSpace(attributesOut.Attributes[string(sqstypes.QueueAttributeNameQueueArn)])
	if topic.DrainARN == "" {
		topic.DrainARN = "arn:" + LocalPartition + ":sqs:" + LocalRegion + ":" + LocalAccountID + ":" + name
	}
	subscription, err := snsClient.Subscribe(ctx, &sns.SubscribeInput{
		TopicArn:              aws.String(topic.ARN),
		Protocol:              aws.String(backendSQS),
		Endpoint:              aws.String(topic.DrainARN),
		ReturnSubscriptionArn: true,
	})
	if err != nil {
		return fmt.Errorf("subscribe the SNS drain queue to %s: %w", topic.ARN, err)
	}
	topic.DrainSubscriptionARN = aws.ToString(subscription.SubscriptionArn)
	r.logf("provisioned SNS drain queue %s for %s", name, topic.LogicalID)
	return nil
}

// snsDrainQueueName is deterministic for a topic and stays inside SQS's
// 80-character name limit. A FIFO queue name must end in .fifo.
func snsDrainQueueName(topic *snsTopicRuntime) string {
	base := strings.TrimSuffix(topic.Name, snsFIFOTopicSuffix)
	base = sanitizeSQSName(base)
	suffix := ""
	if topic.FIFO {
		suffix = snsFIFOTopicSuffix
	}
	name := snsDrainQueuePrefix + base + suffix
	if len(name) <= snsDrainQueueMaximum {
		return name
	}
	sum := sha256.Sum256([]byte(topic.ARN))
	hash := hex.EncodeToString(sum[:4])
	keep := snsDrainQueueMaximum - len(snsDrainQueuePrefix) - len(suffix) - len(hash) - 1
	if keep < 1 {
		keep = 1
	}
	if len(base) > keep {
		base = base[:keep]
	}
	return snsDrainQueuePrefix + base + "-" + hash + suffix
}

// sanitizeSQSName keeps the characters SQS accepts in a queue name.
func sanitizeSQSName(name string) string {
	var builder strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			builder.WriteRune(r)
		default:
			builder.WriteByte('-')
		}
	}
	cleaned := strings.Trim(builder.String(), "-")
	if cleaned == "" {
		cleaned = "topic"
	}
	return cleaned
}
