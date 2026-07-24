package mcp

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/theory-cloud/apptheory/v2/pkg/objectstore"
	objectstoretest "github.com/theory-cloud/apptheory/v2/testkit/objectstore"
)

func TestDynamoStreamSpillStoreFromEnvAndObjectKey(t *testing.T) {
	t.Setenv(envStreamSpillBucket, "")
	require.Nil(t, newDynamoStreamSpillStoreFromEnv())

	t.Setenv(envStreamSpillBucket, " spill-bucket ")
	t.Setenv(envStreamSpillPrefix, " /custom/prefix/ ")
	store, ok := newDynamoStreamSpillStoreFromEnv().(*dynamoStreamObjectSpillStore)
	require.True(t, ok)
	require.Equal(t, "spill-bucket", store.bucket)
	require.Equal(t, "custom/prefix", store.prefix)

	key := store.objectKey("session-1", "event-1")
	require.True(t, strings.HasPrefix(key, "custom/prefix/sessions/"))
	require.True(t, strings.HasSuffix(key, "/events/event-1.json"))

	t.Setenv(envStreamSpillPrefix, " ")
	store, ok = newDynamoStreamSpillStoreFromEnv().(*dynamoStreamObjectSpillStore)
	require.True(t, ok)
	require.Equal(t, defaultDynamoStreamSpillPrefix, store.prefix)
}

func TestDynamoStreamS3SpillStorePutGetDelete(t *testing.T) {
	backend := objectstoretest.NewStore()
	loads := 0
	store := &dynamoStreamObjectSpillStore{
		bucket: "bucket-a",
		prefix: "prefix-a",
		loadStore: func(context.Context) (objectstore.Store, error) {
			loads++
			return backend, nil
		},
	}

	err := store.put(context.Background(), "key-1", []byte(`{"seq":1}`), 123, dynamoStreamPayloadSHA256([]byte(`{"seq":1}`)))
	require.NoError(t, err)
	require.Equal(t, 1, loads)

	calls := backend.Calls()
	require.Len(t, calls, 1)
	require.Equal(t, objectstoretest.OperationPut, calls[0].Operation)
	require.Equal(t, objectstore.ObjectRef{Bucket: "bucket-a", Key: "key-1"}, calls[0].Ref)
	require.Equal(t, []byte(`{"seq":1}`), calls[0].Payload)
	require.Equal(t, "application/json", calls[0].ContentType)
	require.Equal(t, "123", calls[0].Metadata["expires-at"])
	require.NotEmpty(t, calls[0].Metadata["sha256"])

	got, err := store.get(context.Background(), "key-1", 0)
	require.NoError(t, err)
	require.Equal(t, []byte(`{"seq":1}`), got)
	require.Equal(t, 1, loads, "cached object store should be reused")

	require.NoError(t, store.delete(context.Background(), "key-1"))
	calls = backend.Calls()
	require.Len(t, calls, 3)
	require.Equal(t, objectstoretest.OperationGet, calls[1].Operation)
	require.Equal(t, int64(defaultDynamoStreamMaxEventBytes), calls[1].MaxBytes)
	require.Equal(t, objectstoretest.OperationDelete, calls[2].Operation)
	require.Equal(t, objectstore.ObjectRef{Bucket: "bucket-a", Key: "key-1"}, calls[2].Ref)
}

func TestDynamoStreamS3SpillStoreGetBoundsPayload(t *testing.T) {
	t.Setenv(envStreamMaxEventBytes, "4")
	backend := objectstoretest.NewStore()
	_, err := backend.Put(context.Background(), objectstore.PutInput{
		Ref:     objectstore.ObjectRef{Bucket: "bucket-a", Key: "key-1"},
		Payload: []byte("12345"),
	})
	require.NoError(t, err)
	store := &dynamoStreamObjectSpillStore{
		bucket: "bucket-a",
		loadStore: func(context.Context) (objectstore.Store, error) {
			return backend, nil
		},
	}

	got, err := store.get(context.Background(), "key-1", 4)
	require.Nil(t, got)
	require.ErrorContains(t, err, "exceeds max event bytes")
}

func TestDynamoStreamStoreSpillReadLimitUsesRecordMetadata(t *testing.T) {
	store, ok := NewDynamoStreamStore(newFakeMCPTableDB()).(*DynamoStreamStore)
	require.True(t, ok)
	store.maxEventBytes = 1024

	require.Equal(t, 5, store.spillReadLimitBytes(dynamoStreamRecord{DataBytes: 5}))
	require.Equal(t, 1024, store.spillReadLimitBytes(dynamoStreamRecord{DataBytes: 2048}))
}

func TestDynamoStreamS3SpillStoreNilAndLoadErrors(t *testing.T) {
	var nilStore *dynamoStreamObjectSpillStore
	_, err := nilStore.get(context.Background(), "key", 0)
	require.ErrorContains(t, err, "not configured")
	require.ErrorContains(t, nilStore.put(context.Background(), "key", []byte("{}"), 0, ""), "not configured")
	require.ErrorContains(t, nilStore.delete(context.Background(), "key"), "not configured")

	loadErr := errors.New("load failed")
	store := &dynamoStreamObjectSpillStore{
		bucket: "bucket-a",
		loadStore: func(context.Context) (objectstore.Store, error) {
			return nil, loadErr
		},
	}
	_, err = store.get(context.Background(), "key", 0)
	require.ErrorIs(t, err, loadErr)
	require.ErrorIs(t, store.put(context.Background(), "key", []byte("{}"), 0, ""), loadErr)
	require.ErrorIs(t, store.delete(context.Background(), "key"), loadErr)
}
