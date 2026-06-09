package objectstore

import (
	"bytes"
	"context"
	"errors"
	"io"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// ErrInvalidStoreConfig is returned when an object-store implementation is misconfigured.
var ErrInvalidStoreConfig = errors.New("objectstore: invalid store config")

// S3StoreConfig configures the narrow S3-backed Store implementation.
type S3StoreConfig struct{}

// NewS3Store loads AWS SDK v2 configuration and returns the S3-backed Store.
func NewS3Store(ctx context.Context, storeConfig S3StoreConfig) (Store, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, err
	}
	return newS3StoreWithClient(s3.NewFromConfig(cfg), storeConfig)
}

type s3Store struct {
	client s3StoreClient
}

type s3StoreClient interface {
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	DeleteObject(context.Context, *s3.DeleteObjectInput, ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
}

func newS3StoreWithClient(client s3StoreClient, _ S3StoreConfig) (*s3Store, error) {
	if client == nil {
		return nil, ErrInvalidStoreConfig
	}
	return &s3Store{client: client}, nil
}

func (s *s3Store) Put(ctx context.Context, input PutInput) (ObjectRef, error) {
	if err := s.requireClient(); err != nil {
		return ObjectRef{}, err
	}
	if err := validatePutInput(input); err != nil {
		return ObjectRef{}, err
	}

	params := &s3.PutObjectInput{
		Bucket: aws.String(input.Ref.Bucket),
		Key:    aws.String(input.Ref.Key),
		Body:   bytes.NewReader(input.Payload),
	}
	if input.ContentType != "" {
		params.ContentType = aws.String(input.ContentType)
	}
	if len(input.Metadata) > 0 {
		params.Metadata = cloneMetadata(input.Metadata)
	}

	out, err := s.client.PutObject(ctx, params)
	if err != nil {
		return ObjectRef{}, err
	}
	ref := input.Ref
	if out != nil && out.VersionId != nil {
		ref.VersionID = aws.ToString(out.VersionId)
	}
	return ref, nil
}

func (s *s3Store) Get(ctx context.Context, input GetInput) (*GetOutput, error) {
	if err := s.requireClient(); err != nil {
		return nil, err
	}
	if err := validateGetInput(input); err != nil {
		return nil, err
	}

	params := &s3.GetObjectInput{
		Bucket: aws.String(input.Ref.Bucket),
		Key:    aws.String(input.Ref.Key),
	}
	if input.Ref.VersionID != "" {
		params.VersionId = aws.String(input.Ref.VersionID)
	}

	out, err := s.client.GetObject(ctx, params)
	if err != nil {
		return nil, err
	}
	if out == nil || out.Body == nil {
		return nil, ErrInvalidStoreConfig
	}

	payload, readErr := readBounded(out.Body, input.MaxBytes)
	closeErr := out.Body.Close()
	if readErr != nil {
		return nil, readErr
	}
	if closeErr != nil {
		return nil, closeErr
	}

	ref := input.Ref
	if out.VersionId != nil {
		ref.VersionID = aws.ToString(out.VersionId)
	}
	return &GetOutput{
		Ref:         ref,
		Payload:     payload,
		ContentType: aws.ToString(out.ContentType),
		Metadata:    cloneMetadata(out.Metadata),
	}, nil
}

func (s *s3Store) Delete(ctx context.Context, input DeleteInput) error {
	if err := s.requireClient(); err != nil {
		return err
	}
	if err := validateDeleteInput(input); err != nil {
		return err
	}

	params := &s3.DeleteObjectInput{
		Bucket: aws.String(input.Ref.Bucket),
		Key:    aws.String(input.Ref.Key),
	}
	if input.Ref.VersionID != "" {
		params.VersionId = aws.String(input.Ref.VersionID)
	}
	_, err := s.client.DeleteObject(ctx, params)
	return err
}

func (s *s3Store) requireClient() error {
	if s == nil || s.client == nil {
		return ErrInvalidStoreConfig
	}
	return nil
}

func readBounded(body io.Reader, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		return nil, ErrInvalidGetLimit
	}
	payload, err := io.ReadAll(io.LimitReader(body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(payload)) > maxBytes {
		return nil, ErrObjectTooLarge
	}
	return payload, nil
}
