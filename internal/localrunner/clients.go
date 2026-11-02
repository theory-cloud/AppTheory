package localrunner

import (
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

// localCredentials is the static dummy credential set every client talking to a
// loopback emulator uses. It is never valid against real AWS.
func localCredentials() aws.CredentialsProvider {
	return aws.NewCredentialsCache(credentials.NewStaticCredentialsProvider("dummy", "dummy", ""))
}

func newDynamoDBClient(hostURL string) *dynamodb.Client {
	return dynamodb.New(dynamodb.Options{
		Region:       LocalRegion,
		Credentials:  localCredentials(),
		BaseEndpoint: aws.String(hostURL),
	})
}

func newKMSClient(hostURL string) *kms.Client {
	return kms.New(kms.Options{
		Region:       LocalRegion,
		Credentials:  localCredentials(),
		BaseEndpoint: aws.String(hostURL),
	})
}

// newS3Client forces path-style addressing: s3proxy serves the path form for an
// IP endpoint, not the virtual-host form the SDK picks for a named host.
func newS3Client(hostURL string) *s3.Client {
	return s3.New(s3.Options{
		Region:       LocalRegion,
		Credentials:  localCredentials(),
		BaseEndpoint: aws.String(hostURL),
		UsePathStyle: true,
	})
}

func newSQSClient(hostURL string) *sqs.Client {
	return sqs.New(sqs.Options{
		Region:       LocalRegion,
		Credentials:  localCredentials(),
		BaseEndpoint: aws.String(hostURL),
	})
}

func newSTSClient(hostURL string) *sts.Client {
	return sts.New(sts.Options{
		Region:       LocalRegion,
		Credentials:  localCredentials(),
		BaseEndpoint: aws.String(hostURL),
	})
}
