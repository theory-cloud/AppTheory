package localrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// provisionResources creates the local resources a served function's
// environment references: one KMS key per AWS::KMS::Key and one S3 bucket per
// AWS::S3::Bucket, in the runner-managed backends. Nothing is created when the
// corresponding backend is not configured; resolution then fails closed if a
// function needs the value.
func (r *Runner) provisionResources(ctx context.Context, spec *Spec) error {
	r.resourceValues = resourceValues{}
	if err := r.provisionBuckets(ctx, spec); err != nil {
		return err
	}
	return r.provisionKeys(ctx, spec)
}

func (r *Runner) provisionBuckets(ctx context.Context, spec *Spec) error {
	backend, ok := r.backendForService("s3")
	if !ok {
		return nil
	}
	if backend.HostURL == "" {
		return fmt.Errorf("the s3 backend has no loopback endpoint for the runner to provision buckets")
	}
	client := s3.New(s3.Options{
		Region:       LocalRegion,
		Credentials:  aws.NewCredentialsCache(credentials.NewStaticCredentialsProvider("dummy", "dummy", "")),
		BaseEndpoint: aws.String(backend.HostURL),
		UsePathStyle: true,
	})
	for _, resource := range spec.Resources {
		if resource.Type != typeS3Bucket {
			continue
		}
		name, err := resourceName(resource)
		if err != nil {
			return err
		}
		if _, err := client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(name)}); err != nil && !alreadyExists(err) {
			return fmt.Errorf("create local bucket %s for %s: %w", name, resource.LogicalID, err)
		}
		r.resourceValues[resource.Stack+"/"+resource.LogicalID] = resourceValue{
			Name: name,
			ARN:  "arn:" + LocalPartition + ":s3:::" + name,
		}
		r.logf("provisioned s3 bucket %s for %s", name, resource.LogicalID)
	}
	return nil
}

func (r *Runner) provisionKeys(ctx context.Context, spec *Spec) error {
	backend, ok := r.backendForService("kms")
	if !ok {
		return nil
	}
	if backend.HostURL == "" {
		return fmt.Errorf("the kms backend has no loopback endpoint for the runner to provision keys")
	}
	client := kms.New(kms.Options{
		Region:       LocalRegion,
		Credentials:  aws.NewCredentialsCache(credentials.NewStaticCredentialsProvider("dummy", "dummy", "")),
		BaseEndpoint: aws.String(backend.HostURL),
	})
	for _, resource := range spec.Resources {
		if resource.Type != typeKMSKey {
			continue
		}
		description, err := resourceDescription(resource)
		if err != nil {
			return err
		}
		created, err := client.CreateKey(ctx, &kms.CreateKeyInput{Description: aws.String(description)})
		if err != nil {
			return fmt.Errorf("create local KMS key for %s: %w", resource.LogicalID, err)
		}
		if created.KeyMetadata == nil || aws.ToString(created.KeyMetadata.KeyId) == "" {
			return fmt.Errorf("create local KMS key for %s returned no key id", resource.LogicalID)
		}
		r.resourceValues[resource.Stack+"/"+resource.LogicalID] = resourceValue{
			Name:  aws.ToString(created.KeyMetadata.KeyId),
			KeyID: aws.ToString(created.KeyMetadata.KeyId),
			ARN:   aws.ToString(created.KeyMetadata.Arn),
		}
		r.logf("provisioned KMS key %s for %s", aws.ToString(created.KeyMetadata.KeyId), resource.LogicalID)
	}
	return nil
}

func resourceDescription(resource ResourceSpec) (string, error) {
	var props struct {
		Description string `json:"Description"`
	}
	if len(resource.Properties) > 0 {
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return "", fmt.Errorf("parse KMS key %s properties: %w", resource.LogicalID, err)
		}
	}
	description := strings.TrimSpace(props.Description)
	if description == "" {
		description = "AppTheory local key " + resource.LogicalID
	}
	return description, nil
}

func alreadyExists(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "bucketalreadyownedbyyou") ||
		strings.Contains(message, "bucketalreadyexists")
}

// backendForService returns the running backend that provides a service.
func (r *Runner) backendForService(service string) (backendProcess, bool) {
	for _, backend := range r.backends {
		for _, endpoint := range backend.Endpoints {
			if endpoint.Service == service {
				return backend, true
			}
		}
	}
	return backendProcess{}, false
}
