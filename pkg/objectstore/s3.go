package objectstore

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// ErrInvalidStoreConfig is returned when an object-store implementation is misconfigured.
var ErrInvalidStoreConfig = errors.New("objectstore: invalid store config")

// ErrInvalidEncryptionConfig is returned when S3 encryption options are contradictory or incomplete.
var ErrInvalidEncryptionConfig = errors.New("objectstore: invalid encryption config")

// S3EncryptionMode selects the server-side encryption headers emitted for S3 PutObject.
type S3EncryptionMode string

const (
	// S3EncryptionBucketDefault emits no server-side encryption headers and relies on bucket policy/defaults.
	S3EncryptionBucketDefault S3EncryptionMode = "bucket-default"
	// S3EncryptionS3Managed emits the S3-managed AES256 server-side encryption header.
	S3EncryptionS3Managed S3EncryptionMode = "s3-managed"
	// S3EncryptionKMS emits AWS KMS server-side encryption headers with a required key ID.
	S3EncryptionKMS S3EncryptionMode = "kms"
)

// S3EncryptionConfig configures fail-closed S3 server-side encryption headers.
type S3EncryptionConfig struct {
	Mode     S3EncryptionMode
	KMSKeyID string
}

// S3StoreConfig configures the narrow S3-backed Store implementation.
type S3StoreConfig struct {
	Encryption S3EncryptionConfig
}

// NewS3Store loads AWS SDK v2 configuration and returns the S3-backed Store.
func NewS3Store(ctx context.Context, storeConfig S3StoreConfig) (Store, error) {
	if _, err := normalizeS3StoreConfig(storeConfig); err != nil {
		return nil, err
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, err
	}
	return newS3StoreWithClient(s3.NewFromConfig(cfg), storeConfig)
}

type s3Store struct {
	client     s3StoreClient
	encryption S3EncryptionConfig
}

type s3StoreClient interface {
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	GetObject(context.Context, *s3.GetObjectInput, ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	DeleteObject(context.Context, *s3.DeleteObjectInput, ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
}

func newS3StoreWithClient(client s3StoreClient, storeConfig S3StoreConfig) (*s3Store, error) {
	normalized, err := normalizeS3StoreConfig(storeConfig)
	if err != nil {
		return nil, err
	}
	if client == nil {
		return nil, ErrInvalidStoreConfig
	}
	return &s3Store{client: client, encryption: normalized.Encryption}, nil
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
	applyS3Encryption(params, s.encryption)

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

func normalizeS3StoreConfig(storeConfig S3StoreConfig) (S3StoreConfig, error) {
	mode := storeConfig.Encryption.Mode
	if mode == "" {
		mode = S3EncryptionBucketDefault
	}
	kmsKeyID := storeConfig.Encryption.KMSKeyID
	if kmsKeyID != strings.TrimSpace(kmsKeyID) {
		return S3StoreConfig{}, ErrInvalidEncryptionConfig
	}

	switch mode {
	case S3EncryptionBucketDefault, S3EncryptionS3Managed:
		if kmsKeyID != "" {
			return S3StoreConfig{}, ErrInvalidEncryptionConfig
		}
	case S3EncryptionKMS:
		if kmsKeyID == "" {
			return S3StoreConfig{}, ErrInvalidEncryptionConfig
		}
	default:
		return S3StoreConfig{}, ErrInvalidEncryptionConfig
	}

	storeConfig.Encryption.Mode = mode
	storeConfig.Encryption.KMSKeyID = kmsKeyID
	return storeConfig, nil
}

func applyS3Encryption(params *s3.PutObjectInput, encryption S3EncryptionConfig) {
	switch encryption.Mode {
	case S3EncryptionS3Managed:
		params.ServerSideEncryption = types.ServerSideEncryptionAes256
	case S3EncryptionKMS:
		params.ServerSideEncryption = types.ServerSideEncryptionAwsKms
		params.SSEKMSKeyId = aws.String(encryption.KMSKeyID)
	}
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
