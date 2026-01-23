package zap

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sns"

	"github.com/theory-cloud/apptheory/pkg/observability"
	"github.com/theory-cloud/apptheory/pkg/sanitization"
)

type snsAPI interface {
	Publish(
		ctx context.Context,
		params *sns.PublishInput,
		optFns ...func(*sns.Options),
	) (*sns.PublishOutput, error)
}

type SNSNotifierOptions struct {
	Subject string
}

type snsNotifier struct {
	client   snsAPI
	topicARN string
	subject  string
}

var _ observability.ErrorNotifier = (*snsNotifier)(nil)

func NewSNSNotifier(client snsAPI, topicARN string, opts SNSNotifierOptions) observability.ErrorNotifier {
	return &snsNotifier{
		client:   client,
		topicARN: strings.TrimSpace(topicARN),
		subject:  strings.TrimSpace(opts.Subject),
	}
}

func (n *snsNotifier) Notify(ctx context.Context, entry observability.LogEntry) error {
	if n == nil || n.client == nil {
		return errors.New("observability/zap: sns notifier is nil")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if n.topicARN == "" {
		return errors.New("observability/zap: sns topic arn is empty")
	}

	payload := map[string]any{
		"entry": entry,
		"env": map[string]string{
			"aws_region":               os.Getenv("AWS_REGION"),
			"aws_lambda_function_name": os.Getenv("AWS_LAMBDA_FUNCTION_NAME"),
			"aws_execution_env":        os.Getenv("AWS_EXECUTION_ENV"),
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	subject := n.subject
	if subject == "" {
		subject = "apptheory error"
	}
	subject = sanitization.SanitizeLogString(subject)
	if len(subject) > 100 {
		subject = subject[:100]
	}

	message := string(body)
	if len(message) > 256*1024 {
		message = message[:256*1024]
	}

	_, err = n.client.Publish(ctx, &sns.PublishInput{
		TopicArn: aws.String(n.topicARN),
		Subject:  aws.String(subject),
		Message:  aws.String(message),
	})
	return err
}
