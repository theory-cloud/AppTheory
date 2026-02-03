package zap

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/sns"

	"github.com/theory-cloud/apptheory/pkg/observability"
)

type fakeSNSClient struct {
	last *sns.PublishInput
	err  error
}

func (f *fakeSNSClient) Publish(_ context.Context, params *sns.PublishInput, _ ...func(*sns.Options)) (*sns.PublishOutput, error) {
	f.last = params
	if f.err != nil {
		return nil, f.err
	}
	return &sns.PublishOutput{}, nil
}

func TestSNSNotifier_ValidatesInputsAndSanitizesSubject(t *testing.T) {
	var n *snsNotifier
	if err := n.Notify(context.Background(), observability.LogEntry{}); err == nil {
		t.Fatal("expected error for nil notifier")
	}

	client := &fakeSNSClient{}
	notifierAny := NewSNSNotifier(client, "  arn:aws:sns:us-east-1:000000000000:topic  ", SNSNotifierOptions{
		Subject: "line1\r\nline2",
	})
	notifier, ok := notifierAny.(*snsNotifier)
	if !ok {
		t.Fatalf("expected sns notifier, got %#v", notifierAny)
	}

	entry := observability.LogEntry{
		Level:   "error",
		Message: "boom",
		Fields: map[string]any{
			"payload": strings.Repeat("x", 300*1024),
		},
	}

	if err := notifier.Notify(context.Background(), entry); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if client.last == nil || client.last.TopicArn == nil || *client.last.TopicArn == "" {
		t.Fatalf("expected publish input")
	}
	if client.last.Subject == nil || strings.Contains(*client.last.Subject, "\n") || strings.Contains(*client.last.Subject, "\r") {
		t.Fatalf("expected sanitized subject, got %#v", client.last.Subject)
	}
	if client.last.Message == nil || len(*client.last.Message) > 256*1024 {
		t.Fatalf("expected message to be truncated; len=%d", len(*client.last.Message))
	}
}

func TestSNSNotifier_TopicARNRequired(t *testing.T) {
	client := &fakeSNSClient{}
	notifierAny := NewSNSNotifier(client, "", SNSNotifierOptions{})
	notifier, ok := notifierAny.(*snsNotifier)
	if !ok {
		t.Fatalf("expected sns notifier, got %#v", notifierAny)
	}
	if err := notifier.Notify(context.Background(), observability.LogEntry{}); err == nil {
		t.Fatal("expected error")
	}
}

func TestSNSNotifier_PropagatesPublishError(t *testing.T) {
	client := &fakeSNSClient{err: errors.New("publish failed")}
	notifierAny := NewSNSNotifier(client, "arn:aws:sns:us-east-1:000000000000:topic", SNSNotifierOptions{})
	notifier, ok := notifierAny.(*snsNotifier)
	if !ok {
		t.Fatalf("expected sns notifier, got %#v", notifierAny)
	}
	if err := notifier.Notify(context.Background(), observability.LogEntry{}); err == nil {
		t.Fatal("expected error")
	}
}

func TestEnvironmentErrorNotifications_ConfiguresNotifierOrInitErr(t *testing.T) {
	t.Setenv("APPTHEORY_ERROR_NOTIFICATIONS_TOPIC_ARN", "")
	t.Setenv("ERROR_NOTIFICATION_SNS_TOPIC_ARN", "")

	opts := &loggerOptions{}
	WithEnvironmentErrorNotifications(context.Background(), DefaultEnvironmentErrorNotifications())(opts)
	if opts.notifier != nil || opts.initErr != nil {
		t.Fatalf("expected no notifier when env vars unset")
	}

	t.Setenv("APPTHEORY_ERROR_NOTIFICATIONS_TOPIC_ARN", "arn:aws:sns:us-east-1:000000000000:topic")
	t.Setenv("APPTHEORY_ERROR_NOTIFICATIONS_SUBJECT", "  hello ")
	t.Setenv("AWS_REGION", "us-east-1")
	t.Setenv("AWS_ACCESS_KEY_ID", "dummy")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "dummy")

	opts = &loggerOptions{}
	WithEnvironmentErrorNotifications(context.Background(), DefaultEnvironmentErrorNotifications())(opts)
	if opts.notifier == nil || opts.initErr != nil {
		t.Fatalf("expected notifier to be set, got notifier=%v err=%v", opts.notifier, opts.initErr)
	}

	n, ok := opts.notifier.(*snsNotifier)
	if !ok {
		t.Fatalf("expected sns notifier, got %#v", opts.notifier)
	}
	if n.subject != "hello" {
		t.Fatalf("expected subject from env, got %q", n.subject)
	}
}

func TestEnvironmentErrorNotifications_AllowsLegacyEnvVar(t *testing.T) {
	t.Setenv("APPTHEORY_ERROR_NOTIFICATIONS_TOPIC_ARN", "")
	t.Setenv("ERROR_NOTIFICATION_SNS_TOPIC_ARN", "arn:aws:sns:us-east-1:000000000000:topic")
	t.Setenv("AWS_REGION", "us-east-1")
	t.Setenv("AWS_ACCESS_KEY_ID", "dummy")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "dummy")

	opts := &loggerOptions{}
	WithEnvironmentErrorNotifications(context.Background(), DefaultEnvironmentErrorNotifications())(opts)
	if opts.notifier == nil || opts.initErr != nil {
		t.Fatalf("expected notifier to be set, got notifier=%v err=%v", opts.notifier, opts.initErr)
	}
}

func TestZapLoggerFactory_CreatesLoggers(t *testing.T) {
	f := NewZapLoggerFactory()
	if f == nil {
		t.Fatal("expected factory")
	}
	if _, err := f.CreateConsoleLogger(observability.LoggerConfig{Level: "info"}); err != nil {
		t.Fatalf("CreateConsoleLogger: %v", err)
	}
	if f.CreateTestLogger() == nil {
		t.Fatal("expected test logger")
	}
	if f.CreateNoOpLogger() == nil {
		t.Fatal("expected noop logger")
	}
}
