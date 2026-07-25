package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/theory-cloud/apptheory/v2/pkg/objectstore"
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
	get(ctx context.Context, key string, maxBytes int) ([]byte, error)
	delete(ctx context.Context, key string) error
}

type dynamoStreamObjectSpillStore struct {
	bucket string
	prefix string

	mu        sync.Mutex
	store     objectstore.Store
	loadStore func(context.Context) (objectstore.Store, error)
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

	return &dynamoStreamObjectSpillStore{
		bucket: bucket,
		prefix: prefix,
	}
}

func (s *dynamoStreamObjectSpillStore) put(ctx context.Context, key string, data []byte, expiresAt int64, sha256Hex string) error {
	if s == nil {
		return errors.New("stream spill store not configured")
	}
	store, err := s.objectStore(ctx)
	if err != nil {
		return err
	}

	_, err = store.Put(ctx, objectstore.PutInput{
		Ref:         objectstore.ObjectRef{Bucket: s.bucket, Key: key},
		Payload:     data,
		ContentType: "application/json",
		Metadata: map[string]string{
			"expires-at": strconv.FormatInt(expiresAt, 10),
			"sha256":     sha256Hex,
		},
	})
	return err
}

func (s *dynamoStreamObjectSpillStore) get(ctx context.Context, key string, maxBytes int) ([]byte, error) {
	if s == nil {
		return nil, errors.New("stream spill store not configured")
	}
	store, err := s.objectStore(ctx)
	if err != nil {
		return nil, err
	}

	if maxBytes <= 0 {
		maxBytes = dynamoStreamMaxEventBytes()
	}
	out, err := store.Get(ctx, objectstore.GetInput{
		Ref:      objectstore.ObjectRef{Bucket: s.bucket, Key: key},
		MaxBytes: int64(maxBytes),
	})
	if err != nil {
		if errors.Is(err, objectstore.ErrObjectTooLarge) {
			return nil, fmt.Errorf("stream spill object exceeds max event bytes")
		}
		return nil, err
	}
	payload := make([]byte, len(out.Payload))
	copy(payload, out.Payload)
	return payload, nil
}

func (s *dynamoStreamObjectSpillStore) delete(ctx context.Context, key string) error {
	if s == nil {
		return errors.New("stream spill store not configured")
	}
	store, err := s.objectStore(ctx)
	if err != nil {
		return err
	}

	return store.Delete(ctx, objectstore.DeleteInput{Ref: objectstore.ObjectRef{Bucket: s.bucket, Key: key}})
}

func (s *dynamoStreamObjectSpillStore) objectStore(ctx context.Context) (objectstore.Store, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.store != nil {
		return s.store, nil
	}

	loadStore := s.loadStore
	if loadStore == nil {
		loadStore = newDynamoStreamObjectStore
	}
	store, err := loadStore(ctx)
	if err != nil {
		return nil, err
	}

	s.store = store
	return s.store, nil
}

func newDynamoStreamObjectStore(ctx context.Context) (objectstore.Store, error) {
	return objectstore.NewS3Store(ctx, objectstore.S3StoreConfig{
		Encryption: objectstore.S3EncryptionConfig{Mode: objectstore.S3EncryptionS3Managed},
	})
}

func (s *dynamoStreamObjectSpillStore) objectKey(sessionID, eventID string) string {
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
