package microvm

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	tablemocks "github.com/theory-cloud/tabletheory/pkg/mocks"
)

func TestSessionRegistryRecordConversionAndValidation(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	record := registryTestRecord(now)
	registry, err := SessionRecordToRegistryRecord(record)
	require.NoError(t, err)
	require.Equal(t, SessionRegistryPartitionKey("tenant-1", "namespace-1"), registry.PK)
	require.Equal(t, SessionRegistrySortKey("session-1"), registry.SK)
	require.Equal(t, now.Add(time.Hour).Unix(), registry.TTL)
	require.Equal(t, int64(7), registry.Version)

	roundTrip, err := SessionRecordFromRegistryRecord(registry)
	require.NoError(t, err)
	require.Equal(t, record.Endpoint, roundTrip.Endpoint)
	require.Equal(t, record.MicroVMID, roundTrip.MicroVMID)
	require.Equal(t, CommandStart, roundTrip.LastAction)

	bad := registry
	bad.PK = "TENANT#other#NAMESPACE#namespace-1"
	require.Error(t, ValidateSessionRegistryRecord(bad))

	bad = registry
	bad.Metadata = map[string]string{"aws_secret_access_key": "secret"}
	require.Error(t, ValidateSessionRegistryRecord(bad))

	bad = registry
	bad.TTL++
	require.Error(t, ValidateSessionRegistryRecord(bad))
}

func TestMemorySessionRegistryAndRegistryClient(t *testing.T) {
	now := time.Unix(200, 0).UTC()
	registry := NewMemorySessionRegistry()
	client, err := NewRegistryClient(registry, WithRegistryClientTTL(30*time.Minute))
	require.NoError(t, err)

	created, err := client.Create(context.Background(), CreateSessionInput{
		RequestID:           "req-create",
		TenantID:            "tenant-1",
		Namespace:           "namespace-1",
		SessionID:           "session-1",
		ImageRef:            "image-ref",
		NetworkConnectorRef: "network-ref",
		SessionSpec:         SessionSpec{Metadata: map[string]string{"safe": "ok"}},
		ControllerID:        "controller-1",
		AuthSubject:         "subject-1",
		Now:                 now,
	})
	require.NoError(t, err)
	require.Equal(t, CommandCreate, created.LastAction)
	require.Equal(t, now.Add(30*time.Minute), created.ExpiresAt)

	started, err := client.Start(context.Background(), SessionCommandInput{
		RequestID:    "req-start",
		TenantID:     "tenant-1",
		Namespace:    "namespace-1",
		SessionID:    "session-1",
		ControllerID: "controller-1",
		AuthSubject:  "subject-1",
		DesiredState: StateStarted,
		Now:          now.Add(time.Minute),
	})
	require.NoError(t, err)
	require.Equal(t, StateStarting, started.State)
	require.Equal(t, CommandStart, started.LastAction)
	require.Equal(t, int64(2), started.Generation)

	status, err := client.Status(context.Background(), SessionQueryInput{
		RequestID:   "req-status",
		TenantID:    "tenant-1",
		Namespace:   "namespace-1",
		SessionID:   "session-1",
		AuthSubject: "subject-1",
	})
	require.NoError(t, err)
	require.Equal(t, CommandStart, status.LastAction)
	require.Equal(t, int64(2), status.RegistryVersion)

	_, err = registry.Get(context.Background(), SessionKey{TenantID: "tenant-1", Namespace: "other", SessionID: "session-1"})
	require.Error(t, err)
	require.NoError(t, registry.Delete(context.Background(), created.Key()))
	_, err = registry.Get(context.Background(), created.Key())
	require.Error(t, err)
}

func TestTableTheorySessionRegistryUsesCanonicalModel(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	now := time.Unix(300, 0).UTC()
	record := registryTestRecord(now)

	db.On("Model", mock.Anything).Run(func(args mock.Arguments) {
		modelRecord, ok := args.Get(0).(*SessionRegistryRecord)
		require.True(t, ok)
		require.Equal(t, SessionRegistryPartitionKey("tenant-1", "namespace-1"), modelRecord.PK)
		require.Equal(t, SessionRegistrySortKey("session-1"), modelRecord.SK)
	}).Return(q).Once()
	q.On("WithContext", mock.Anything).Return(q).Once()
	q.On("CreateOrUpdate").Return(nil).Once()

	store, err := NewTableTheorySessionRegistry(db)
	require.NoError(t, err)
	stored, err := store.Put(context.Background(), record)
	require.NoError(t, err)
	require.Equal(t, record.LastAction, stored.LastAction)

	db.AssertExpectations(t)
	q.AssertExpectations(t)
}

func TestTableTheorySessionRegistryGetAndDelete(t *testing.T) {
	db := new(tablemocks.MockDB)
	qGet := new(tablemocks.MockQuery)
	qDelete := new(tablemocks.MockQuery)
	now := time.Unix(400, 0).UTC()
	registryRecord, err := SessionRecordToRegistryRecord(registryTestRecord(now))
	require.NoError(t, err)

	db.On("Model", mock.Anything).Return(qGet).Once()
	qGet.On("WithContext", mock.Anything).Return(qGet).Once()
	qGet.On("Where", "PK", "=", registryRecord.PK).Return(qGet).Once()
	qGet.On("Where", "SK", "=", registryRecord.SK).Return(qGet).Once()
	qGet.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*SessionRegistryRecord)
		require.True(t, ok)
		*out = registryRecord
	}).Return(nil).Once()

	db.On("Model", mock.Anything).Return(qDelete).Once()
	qDelete.On("WithContext", mock.Anything).Return(qDelete).Once()
	qDelete.On("Where", "PK", "=", registryRecord.PK).Return(qDelete).Once()
	qDelete.On("Where", "SK", "=", registryRecord.SK).Return(qDelete).Once()
	qDelete.On("Delete").Return(nil).Once()

	store, err := NewTableTheorySessionRegistry(db)
	require.NoError(t, err)
	got, err := store.Get(context.Background(), registryTestRecord(now).Key())
	require.NoError(t, err)
	require.Equal(t, "session-1", got.SessionID)
	require.NoError(t, store.Delete(context.Background(), got.Key()))
}

func TestSessionRegistryRecordTheoryDBTags(t *testing.T) {
	t.Setenv(EnvSessionRegistryTableName, "")
	require.Equal(t, DefaultSessionRegistryTableName, SessionRegistryRecord{}.TableName())
	t.Setenv(EnvSessionRegistryTableName, "custom-microvm-sessions")
	require.Equal(t, "custom-microvm-sessions", SessionRegistryRecord{}.TableName())

	tp := reflect.TypeOf(SessionRegistryRecord{})
	pk, ok := tp.FieldByName("PK")
	require.True(t, ok)
	require.Equal(t, "pk,attr:pk", pk.Tag.Get("theorydb"))
	sk, ok := tp.FieldByName("SK")
	require.True(t, ok)
	require.Equal(t, "sk,attr:sk", sk.Tag.Get("theorydb"))
	ttl, ok := tp.FieldByName("TTL")
	require.True(t, ok)
	require.Equal(t, "ttl,attr:ttl", ttl.Tag.Get("theorydb"))
	version, ok := tp.FieldByName("Version")
	require.True(t, ok)
	require.Equal(t, "version,attr:version", version.Tag.Get("theorydb"))
}

func registryTestRecord(now time.Time) SessionRecord {
	return SessionRecord{
		TenantID:            "tenant-1",
		Namespace:           "namespace-1",
		SessionID:           "session-1",
		State:               StateStarting,
		DesiredState:        StateStarted,
		Endpoint:            "https://microvm.example.test/session-1",
		MicroVMID:           "microvm-1",
		ImageRef:            "image-ref",
		NetworkConnectorRef: "network-ref",
		ControllerID:        "controller-1",
		CreatedAt:           now,
		UpdatedAt:           now.Add(time.Minute),
		ExpiresAt:           now.Add(time.Hour),
		Generation:          7,
		LastAction:          CommandStart,
		LastCommandID:       "req-start",
		AuthSubject:         "subject-1",
		Metadata:            map[string]string{"safe": "ok"},
	}
}
