package localrunner

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// sesReceive injects one received message and delivers it to every matching
// receipt rule.
//
// https://docs.aws.amazon.com/ses/latest/dg/receiving-email.html
func (s *localSession) sesReceive(ctx context.Context, request sessionRequest) (any, error) {
	delivery, err := s.runner.receiveMessage(ctx, s.spec, receivedMessage{
		Source:     request.Source,
		Recipients: request.Recipients,
		Raw:        request.RawMessage,
		MessageID:  request.MessageID,
	})
	if err != nil {
		return nil, err
	}
	return delivery, nil
}

// customResourceDeleteOp runs one custom resource's Delete handler.
func (s *localSession) customResourceDeleteOp(ctx context.Context, request sessionRequest) (any, error) {
	if request.Resource == "" {
		return nil, fmt.Errorf("customResource.delete needs the resource logical id")
	}
	return s.runner.customResourceDelete(ctx, s.spec, request.Resource)
}

// s3List lists one bucket's objects through the run's S3 client, which is how a
// session asserts what a handler wrote or deleted.
func (s *localSession) s3List(ctx context.Context, request sessionRequest) (any, error) {
	resource, key, err := s.findResource(request.Bucket)
	if err != nil {
		return nil, err
	}
	if resource.Type != typeS3Bucket {
		return nil, fmt.Errorf("%s is %s, not an S3 bucket", request.Bucket, resource.Type)
	}
	value, ok := s.runner.resourceValues[key]
	if !ok {
		return nil, fmt.Errorf("S3 bucket %s is not provisioned; start the run with --backend s3proxy", request.Bucket)
	}
	backend, ok := s.runner.backendForService("s3")
	if !ok || backend.HostURL == "" {
		return nil, fmt.Errorf("the s3 backend is not running")
	}
	listing, err := newS3Client(backend.HostURL).ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket: aws.String(value.Name),
	})
	if err != nil {
		return nil, err
	}
	objects := make([]map[string]any, 0, len(listing.Contents))
	for _, object := range listing.Contents {
		objects = append(objects, map[string]any{
			"key":  aws.ToString(object.Key),
			"size": aws.ToInt64(object.Size),
		})
	}
	return map[string]any{"bucket": value.Name, "objects": objects}, nil
}
