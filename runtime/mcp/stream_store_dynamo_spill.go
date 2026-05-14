package mcp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const (
	defaultDynamoStreamSpillInlineMaxBytes = 32 * 1024
	defaultDynamoStreamMaxInlineBytes      = 350 * 1024
	defaultDynamoStreamMaxEventBytes       = 10 * 1024 * 1024
	defaultDynamoStreamSpillPrefix         = "mcp-stream-events"
	dynamoStreamDataStorageS3              = "s3"
	envStreamSpillBucket                   = "MCP_STREAM_SPILL_BUCKET"
	envStreamSpillPrefix                   = "MCP_STREAM_SPILL_PREFIX"
	envStreamSpillInlineMaxBytes           = "MCP_STREAM_SPILL_INLINE_MAX_BYTES"
	envStreamMaxEventBytes                 = "MCP_STREAM_MAX_EVENT_BYTES"
)

type dynamoStreamSpillStore interface {
	put(ctx context.Context, key string, data []byte, expiresAt int64, sha256Hex string) error
	get(ctx context.Context, key string) ([]byte, error)
	delete(ctx context.Context, key string) error
}

type dynamoStreamS3SpillStore struct {
	bucket string
	prefix string

	mu         sync.Mutex
	client     dynamoStreamS3Client
	loadClient func(context.Context) (dynamoStreamS3Client, error)
}

type dynamoStreamS3Client interface {
	PutObject(ctx context.Context, params *s3.PutObjectInput, optFns ...func(*s3.Options)) (*s3.PutObjectOutput, error)
	GetObject(ctx context.Context, params *s3.GetObjectInput, optFns ...func(*s3.Options)) (*s3.GetObjectOutput, error)
	DeleteObject(ctx context.Context, params *s3.DeleteObjectInput, optFns ...func(*s3.Options)) (*s3.DeleteObjectOutput, error)
}

func newDynamoStreamSpillStoreFromEnv() dynamoStreamSpillStore {
	bucket := strings.TrimSpace(os.Getenv(envStreamSpillBucket))
	if bucket == "" {
		return nil
	}

	prefix := strings.Trim(strings.TrimSpace(os.Getenv(envStreamSpillPrefix)), "/")
	if prefix == "" {
		prefix = defaultDynamoStreamSpillPrefix
	}

	return &dynamoStreamS3SpillStore{
		bucket: bucket,
		prefix: prefix,
	}
}

func (s *dynamoStreamS3SpillStore) put(ctx context.Context, key string, data []byte, expiresAt int64, sha256Hex string) error {
	if s == nil {
		return errors.New("stream spill store not configured")
	}
	client, err := s.s3Client(ctx)
	if err != nil {
		return err
	}

	_, err = client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(data),
		ContentType: aws.String("application/json"),
		Metadata: map[string]string{
			"expires-at": strconv.FormatInt(expiresAt, 10),
			"sha256":     sha256Hex,
		},
	})
	return err
}

func (s *dynamoStreamS3SpillStore) get(ctx context.Context, key string) ([]byte, error) {
	if s == nil {
		return nil, errors.New("stream spill store not configured")
	}
	client, err := s.s3Client(ctx)
	if err != nil {
		return nil, err
	}

	out, err := client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, err
	}
	defer func() {
		if closeErr := out.Body.Close(); closeErr != nil {
			// The payload has already been read or the read path will return its own
			// error. Close failures do not alter the stream event contract.
			return
		}
	}()

	maxBytes := dynamoStreamMaxEventBytes()
	payload, err := io.ReadAll(io.LimitReader(out.Body, int64(maxBytes)+1))
	if err != nil {
		return nil, err
	}
	if len(payload) > maxBytes {
		return nil, fmt.Errorf("stream spill object exceeds max event bytes")
	}

	return payload, nil
}

func (s *dynamoStreamS3SpillStore) delete(ctx context.Context, key string) error {
	if s == nil {
		return errors.New("stream spill store not configured")
	}
	client, err := s.s3Client(ctx)
	if err != nil {
		return err
	}

	_, err = client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	return err
}

func (s *dynamoStreamS3SpillStore) s3Client(ctx context.Context) (dynamoStreamS3Client, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.client != nil {
		return s.client, nil
	}

	loadClient := s.loadClient
	if loadClient == nil {
		loadClient = newDynamoStreamS3Client
	}
	client, err := loadClient(ctx)
	if err != nil {
		return nil, err
	}

	s.client = client
	return s.client, nil
}

func newDynamoStreamS3Client(ctx context.Context) (dynamoStreamS3Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, err
	}
	return s3.NewFromConfig(cfg), nil
}

func (s *dynamoStreamS3SpillStore) objectKey(sessionID, eventID string) string {
	sessionHash := dynamoStreamPayloadSHA256([]byte(sessionID))
	name := fmt.Sprintf("sessions/%s/events/%s.json", sessionHash, eventID)
	prefix := strings.Trim(s.prefix, "/")
	if prefix == "" {
		return name
	}
	return prefix + "/" + name
}

func dynamoStreamPayloadSHA256(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func dynamoStreamSpillInlineMaxBytes() int {
	return clampDynamoStreamSpillInlineMaxBytes(
		envPositiveInt(envStreamSpillInlineMaxBytes, defaultDynamoStreamSpillInlineMaxBytes),
	)
}

func dynamoStreamMaxEventBytes() int {
	return envPositiveInt(envStreamMaxEventBytes, defaultDynamoStreamMaxEventBytes)
}

func clampDynamoStreamSpillInlineMaxBytes(n int) int {
	if n <= 0 {
		return defaultDynamoStreamSpillInlineMaxBytes
	}
	if n > defaultDynamoStreamMaxInlineBytes {
		return defaultDynamoStreamMaxInlineBytes
	}
	return n
}

func envPositiveInt(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}
