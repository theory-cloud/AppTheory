package testkit

import (
	"context"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sns"
)

func TestFakeSNSClient_Publish(t *testing.T) {
	var nilClient *FakeSNSClient
	if _, err := nilClient.Publish(context.Background(), &sns.PublishInput{}); err == nil {
		t.Fatal("expected error for nil client")
	}

	client := NewFakeSNSClient()
	if _, err := client.Publish(context.Background(), nil); err == nil {
		t.Fatal("expected error for nil publish input")
	}
	if _, err := client.Publish(context.Background(), &sns.PublishInput{TopicArn: aws.String(" ")}); err == nil {
		t.Fatal("expected error for empty topic arn")
	}

	out, err := client.Publish(context.Background(), &sns.PublishInput{
		TopicArn: aws.String("arn:aws:sns:us-east-1:123:topic1"),
		Subject:  aws.String("sub"),
		Message:  aws.String("msg"),
	})
	if err != nil {
		t.Fatalf("Publish returned error: %v", err)
	}
	if aws.ToString(out.MessageId) != "msg-1" {
		t.Fatalf("unexpected message id: %q", aws.ToString(out.MessageId))
	}
	if len(client.Calls) != 1 || client.Calls[0].TopicARN == "" || client.Calls[0].Message != "msg" {
		t.Fatalf("unexpected calls: %#v", client.Calls)
	}

	client.PublishErr = context.Canceled
	if _, err := client.Publish(context.Background(), &sns.PublishInput{TopicArn: aws.String("arn:aws:sns:us-east-1:123:topic1")}); err == nil {
		t.Fatal("expected publish error to be returned")
	}
}
