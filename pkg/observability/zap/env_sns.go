package zap

import (
	"context"
	"os"
	"strings"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sns"
)

type EnvironmentErrorNotificationsOptions struct {
	TopicARNEnvVars []string
	SubjectEnvVars  []string
}

func WithEnvironmentErrorNotifications(ctx context.Context, config EnvironmentErrorNotificationsOptions) Option {
	return func(opts *loggerOptions) {
		topicARN := firstEnvValue(config.TopicARNEnvVars...)
		if topicARN == "" {
			return
		}

		if ctx == nil {
			ctx = context.Background()
		}

		awsCfg, err := awsconfig.LoadDefaultConfig(ctx)
		if err != nil {
			opts.initErr = err
			return
		}

		subject := firstEnvValue(config.SubjectEnvVars...)
		notifier := NewSNSNotifier(sns.NewFromConfig(awsCfg), topicARN, SNSNotifierOptions{
			Subject: subject,
		})
		opts.notifier = notifier
	}
}

func DefaultEnvironmentErrorNotifications() EnvironmentErrorNotificationsOptions {
	return EnvironmentErrorNotificationsOptions{
		TopicARNEnvVars: []string{
			"APPTHEORY_ERROR_NOTIFICATIONS_TOPIC_ARN",
			"APPTHEORY_SNS_ERROR_TOPIC_ARN",
			"ERROR_NOTIFICATION_SNS_TOPIC_ARN",
			"ERROR_NOTIFICATIONS_TOPIC_ARN",
			"SNS_ERROR_TOPIC_ARN",
		},
		SubjectEnvVars: []string{
			"APPTHEORY_ERROR_NOTIFICATIONS_SUBJECT",
			"APPTHEORY_SNS_ERROR_SUBJECT",
		},
	}
}

func firstEnvValue(keys ...string) string {
	for _, key := range keys {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}
