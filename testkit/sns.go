package testkit

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sns"
)

type SNSPublishCall struct {
	TopicARN string
	Subject  string
	Message  string
}

type FakeSNSClient struct {
	mu sync.Mutex

	Calls []SNSPublishCall

	PublishErr error
	nextID     int
}

func NewFakeSNSClient() *FakeSNSClient {
	return &FakeSNSClient{
		Calls:      nil,
		PublishErr: nil,
		nextID:     1,
	}
}

func (f *FakeSNSClient) Publish(
	_ context.Context,
	params *sns.PublishInput,
	_ ...func(*sns.Options),
) (*sns.PublishOutput, error) {
	if f == nil {
		return nil, errors.New("testkit: sns client is nil")
	}
	if params == nil {
		return nil, errors.New("testkit: publish input is nil")
	}

	topicARN := strings.TrimSpace(aws.ToString(params.TopicArn))
	if topicARN == "" {
		return nil, errors.New("testkit: topic arn is empty")
	}

	subject := aws.ToString(params.Subject)
	message := aws.ToString(params.Message)

	f.mu.Lock()
	f.Calls = append(f.Calls, SNSPublishCall{
		TopicARN: topicARN,
		Subject:  subject,
		Message:  message,
	})
	err := f.PublishErr
	id := f.nextID
	f.nextID++
	f.mu.Unlock()

	if err != nil {
		return nil, err
	}

	return &sns.PublishOutput{
		MessageId: aws.String("msg-" + strconv.Itoa(id)),
	}, nil
}
