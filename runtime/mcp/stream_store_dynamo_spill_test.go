package mcp

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/stretchr/testify/require"
)

func TestDynamoStreamSpillStoreFromEnvAndObjectKey(t *testing.T) {
	t.Setenv(envStreamSpillBucket, "")
	require.Nil(t, newDynamoStreamSpillStoreFromEnv())

	t.Setenv(envStreamSpillBucket, " spill-bucket ")
	t.Setenv(envStreamSpillPrefix, " /custom/prefix/ ")
	store, ok := newDynamoStreamSpillStoreFromEnv().(*dynamoStreamS3SpillStore)
	require.True(t, ok)
	require.Equal(t, "spill-bucket", store.bucket)
	require.Equal(t, "custom/prefix", store.prefix)

	key := store.objectKey("session-1", "event-1")
	require.True(t, strings.HasPrefix(key, "custom/prefix/sessions/"))
	require.True(t, strings.HasSuffix(key, "/events/event-1.json"))

	t.Setenv(envStreamSpillPrefix, " ")
	store, ok = newDynamoStreamSpillStoreFromEnv().(*dynamoStreamS3SpillStore)
	require.True(t, ok)
	require.Equal(t, defaultDynamoStreamSpillPrefix, store.prefix)
}

func TestDynamoStreamS3SpillStorePutGetDelete(t *testing.T) {
	client := &recordingDynamoStreamS3Client{
		getBody: []byte(`{"ok":true}`),
	}
	loads := 0
	store := &dynamoStreamS3SpillStore{
		bucket: "bucket-a",
		prefix: "prefix-a",
		loadClient: func(context.Context) (dynamoStreamS3Client, error) {
			loads++
			return client, nil
		},
	}

	err := store.put(context.Background(), "key-1", []byte(`{"seq":1}`), 123, dynamoStreamPayloadSHA256([]byte(`{"seq":1}`)))
	require.NoError(t, err)
	require.Equal(t, 1, loads)
	require.Equal(t, "bucket-a", aws.ToString(client.putInput.Bucket))
	require.Equal(t, "key-1", aws.ToString(client.putInput.Key))
	require.Equal(t, "123", client.putInput.Metadata["expires-at"])
	require.NotEmpty(t, client.putInput.Metadata["sha256"])

	got, err := store.get(context.Background(), "key-1", 0)
	require.NoError(t, err)
	require.Equal(t, []byte(`{"ok":true}`), got)
	require.True(t, client.bodyClosed)
	require.Equal(t, "bucket-a", aws.ToString(client.getInput.Bucket))
	require.Equal(t, "key-1", aws.ToString(client.getInput.Key))
	require.Equal(t, 1, loads, "cached S3 client should be reused")

	require.NoError(t, store.delete(context.Background(), "key-1"))
	require.Equal(t, "bucket-a", aws.ToString(client.deleteInput.Bucket))
	require.Equal(t, "key-1", aws.ToString(client.deleteInput.Key))
}

func TestDynamoStreamS3SpillStoreGetBoundsPayload(t *testing.T) {
	t.Setenv(envStreamMaxEventBytes, "4")
	client := &recordingDynamoStreamS3Client{getBody: []byte("12345")}
	store := &dynamoStreamS3SpillStore{
		bucket: "bucket-a",
		loadClient: func(context.Context) (dynamoStreamS3Client, error) {
			return client, nil
		},
	}

	got, err := store.get(context.Background(), "key-1", 4)
	require.Nil(t, got)
	require.ErrorContains(t, err, "exceeds max event bytes")
	require.True(t, client.bodyClosed)
}

func TestDynamoStreamStoreSpillReadLimitUsesRecordMetadata(t *testing.T) {
	store, ok := NewDynamoStreamStore(newFakeMCPTableDB()).(*DynamoStreamStore)
	require.True(t, ok)
	store.maxEventBytes = 1024

	require.Equal(t, 5, store.spillReadLimitBytes(dynamoStreamRecord{DataBytes: 5}))
	require.Equal(t, 1024, store.spillReadLimitBytes(dynamoStreamRecord{DataBytes: 2048}))
}

func TestDynamoStreamS3SpillStoreNilAndLoadErrors(t *testing.T) {
	var nilStore *dynamoStreamS3SpillStore
	_, err := nilStore.get(context.Background(), "key", 0)
	require.ErrorContains(t, err, "not configured")
	require.ErrorContains(t, nilStore.put(context.Background(), "key", []byte("{}"), 0, ""), "not configured")
	require.ErrorContains(t, nilStore.delete(context.Background(), "key"), "not configured")

	loadErr := errors.New("load failed")
	store := &dynamoStreamS3SpillStore{
		bucket: "bucket-a",
		loadClient: func(context.Context) (dynamoStreamS3Client, error) {
			return nil, loadErr
		},
	}
	_, err = store.get(context.Background(), "key", 0)
	require.ErrorIs(t, err, loadErr)
	require.ErrorIs(t, store.put(context.Background(), "key", []byte("{}"), 0, ""), loadErr)
	require.ErrorIs(t, store.delete(context.Background(), "key"), loadErr)
}

type recordingDynamoStreamS3Client struct {
	mu          sync.Mutex
	putInput    *s3.PutObjectInput
	getInput    *s3.GetObjectInput
	deleteInput *s3.DeleteObjectInput
	getBody     []byte
	bodyClosed  bool
}

func (c *recordingDynamoStreamS3Client) PutObject(
	_ context.Context,
	params *s3.PutObjectInput,
	_ ...func(*s3.Options),
) (*s3.PutObjectOutput, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.putInput = params
	return &s3.PutObjectOutput{}, nil
}

func (c *recordingDynamoStreamS3Client) GetObject(
	_ context.Context,
	params *s3.GetObjectInput,
	_ ...func(*s3.Options),
) (*s3.GetObjectOutput, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.getInput = params
	return &s3.GetObjectOutput{Body: &trackingReadCloser{Reader: bytes.NewReader(c.getBody), closed: &c.bodyClosed}}, nil
}

func (c *recordingDynamoStreamS3Client) DeleteObject(
	_ context.Context,
	params *s3.DeleteObjectInput,
	_ ...func(*s3.Options),
) (*s3.DeleteObjectOutput, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.deleteInput = params
	return &s3.DeleteObjectOutput{}, nil
}

type trackingReadCloser struct {
	io.Reader
	closed *bool
}

func (r *trackingReadCloser) Close() error {
	*r.closed = true
	return nil
}
