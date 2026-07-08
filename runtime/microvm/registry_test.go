package microvm

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	tablemocks "github.com/theory-cloud/tabletheory/v2/pkg/mocks"
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
	require.Equal(t, record.ProviderID, roundTrip.ProviderID)
	require.Equal(t, record.ProviderState, roundTrip.ProviderState)
	require.Equal(t, record.ImageVersion, roundTrip.ImageVersion)
	require.Equal(t, record.TokenMetadata, roundTrip.TokenMetadata)
	require.Equal(t, CommandStart, roundTrip.LastAction)

	bad := registry
	bad.PK = "TENANT#other#NAMESPACE#namespace-1"
	require.Error(t, ValidateSessionRegistryRecord(bad))

	bad = registry
	bad.Metadata = map[string]string{"aws_secret_access_key": "redacted"}
	require.Error(t, ValidateSessionRegistryRecord(bad))

	bad = registry
	bad.StatusMetadata = map[string]string{"provider_exception": "redacted"}
	require.Error(t, ValidateSessionRegistryRecord(bad))

	bad = registry
	bad.TokenMetadata = []SessionTokenMetadata{{TokenID: "token_value", TokenType: "auth", ExpiresAt: now.Add(time.Minute), Scope: []string{"ports:443"}}}
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
	require.Equal(t, DefaultSessionProviderID, created.ProviderID)
	require.Equal(t, "session-1", created.ProviderMicroVMID)
	require.Equal(t, string(StateRequested), created.ProviderState)

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
	require.Equal(t, string(StateStarting), started.ProviderState)
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

func TestReconstructSessionRegistryFailsClosed(t *testing.T) {
	now := time.Unix(700, 0).UTC()
	key := SessionKey{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: "session-1"}

	_, err := ReconstructSessionRecord(context.Background(), SessionReconstructionRequest{
		RequestID: "req-reconstruct",
		TenantID:  key.TenantID,
		Namespace: key.Namespace,
		SessionID: key.SessionID,
		Now:       now,
	}, nil)
	require.Error(t, err)

	_, err = ReconstructSessionRecord(context.Background(), SessionReconstructionRequest{
		RequestID: "req-reconstruct",
		TenantID:  key.TenantID,
		Namespace: key.Namespace,
		SessionID: key.SessionID,
		Now:       now,
	}, func(context.Context, SessionReconstructionRequest) (SessionRecord, error) {
		record := registryTestRecord(now)
		record.TenantID = "tenant-other"
		return record, nil
	})
	require.Error(t, err)

	_, err = ReconstructSessionRecord(context.Background(), SessionReconstructionRequest{
		RequestID: "req-reconstruct",
		TenantID:  key.TenantID,
		Namespace: key.Namespace,
		SessionID: key.SessionID,
		Now:       now.Add(2 * time.Hour),
	}, func(context.Context, SessionReconstructionRequest) (SessionRecord, error) {
		return registryTestRecord(now), nil
	})
	require.Error(t, err)

	registry := NewMemorySessionRegistry()
	wrapped, err := NewReconstructingSessionRegistry(
		registry,
		func(_ context.Context, request SessionReconstructionRequest) (SessionRecord, error) {
			record := registryTestRecord(now.Add(10 * time.Minute))
			record.TenantID = request.TenantID
			record.Namespace = request.Namespace
			record.SessionID = request.SessionID
			record.ProviderState = "running"
			record.AWSLifecycleState = "running"
			record.LastObservedAt = request.Now
			record.ExpiresAt = request.Now.Add(time.Hour)
			return record, nil
		},
		WithSessionReconstructionClock(fixedClock{now: now.Add(30 * time.Minute)}),
		WithSessionReconstructionStaleAfter(time.Minute),
	)
	require.NoError(t, err)
	reconstructed, err := wrapped.Get(context.Background(), key)
	require.NoError(t, err)
	require.Equal(t, "running", reconstructed.ProviderState)
	require.Equal(t, key, reconstructed.Key())

	_, err = NewReconstructingSessionRegistry(registry, nil)
	require.Error(t, err)
}

func TestReconstructingSessionRegistryStalePutDeleteAndTokenMetadata(t *testing.T) {
	now := time.Unix(900, 0).UTC()
	key := SessionKey{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: "session-1"}
	registry := NewMemorySessionRegistry()
	stale := registryTestRecord(now)
	stale.LastObservedAt = now.Add(-10 * time.Minute)
	stale.ExpiresAt = now.Add(time.Hour)
	_, err := registry.Put(context.Background(), stale)
	require.NoError(t, err)

	hookCalls := 0
	wrapped, err := NewReconstructingSessionRegistry(
		registry,
		func(_ context.Context, request SessionReconstructionRequest) (SessionRecord, error) {
			hookCalls++
			require.NotNil(t, request.Existing)
			require.Equal(t, key, request.Existing.Key())
			record := *request.Existing
			record.ProviderState = "running"
			record.AWSLifecycleState = "running"
			record.LastObservedAt = request.Now
			record.UpdatedAt = request.Now
			record.ExpiresAt = request.Now.Add(time.Hour)
			record.Generation++
			return record, nil
		},
		WithSessionReconstructionClock(fixedClock{now: now}),
		WithSessionReconstructionStaleAfter(time.Minute),
	)
	require.NoError(t, err)

	reconstructed, err := wrapped.Get(context.Background(), key)
	require.NoError(t, err)
	require.Equal(t, 1, hookCalls)
	require.Equal(t, "running", reconstructed.ProviderState)
	require.Equal(t, now, reconstructed.LastObservedAt)

	fresh := registryTestRecord(now.Add(time.Minute))
	fresh.SessionID = "session-put"
	stored, err := wrapped.Put(context.Background(), fresh)
	require.NoError(t, err)
	require.Equal(t, "session-put", stored.SessionID)
	require.NoError(t, wrapped.Delete(context.Background(), stored.Key()))
	_, err = registry.Get(context.Background(), stored.Key())
	require.Error(t, err)

	providerToken := ProviderToken{
		TenantID:          key.TenantID,
		Namespace:         key.Namespace,
		SessionID:         key.SessionID,
		ProviderMicroVMID: "provider-session-1",
		TokenID:           "tok-safe",
		TokenType:         "auth",
		ExpiresAt:         now.Add(5 * time.Minute),
		Scope:             []string{"ports:443"},
	}
	metadata, err := SessionTokenMetadataFromProviderToken(providerToken)
	require.NoError(t, err)
	require.Equal(t, providerToken.TokenID, metadata.TokenID)
	require.NoError(t, ValidateSessionTokenMetadata(metadata, "req-token"))

	metadata.TokenID = "token_value"
	require.Error(t, ValidateSessionTokenMetadata(metadata, "req-token"))

	_, err = SessionTokenMetadataFromProviderToken(ProviderToken{})
	require.Error(t, err)
}

func TestReconstructSessionRecordHookErrorsAndNilRegistryFailClosed(t *testing.T) {
	now := time.Unix(950, 0).UTC()
	request := SessionReconstructionRequest{
		RequestID: "req-reconstruct",
		TenantID:  "tenant-1",
		Namespace: "namespace-1",
		SessionID: "session-1",
		Now:       now,
	}

	_, err := ReconstructSessionRecord(context.Background(), request, func(context.Context, SessionReconstructionRequest) (SessionRecord, error) {
		return SessionRecord{}, errors.New("redacted")
	})
	require.Error(t, err)
	require.NotContains(t, err.Error(), "redacted")

	_, err = ReconstructSessionRecord(context.Background(), request, func(context.Context, SessionReconstructionRequest) (SessionRecord, error) {
		record := registryTestRecord(now)
		record.ProviderID = ""
		return record, nil
	})
	require.Error(t, err)

	var wrapped *ReconstructingSessionRegistry
	_, err = wrapped.Put(context.Background(), registryTestRecord(now))
	require.Error(t, err)
	_, err = wrapped.Get(context.Background(), SessionKey{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: "session-1"})
	require.Error(t, err)
	require.Error(t, wrapped.Delete(context.Background(), SessionKey{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: "session-1"}))

	_, err = NewReconstructingSessionRegistry(NewMemorySessionRegistry(), func(context.Context, SessionReconstructionRequest) (SessionRecord, error) {
		return registryTestRecord(now), nil
	}, WithSessionReconstructionClock(nil))
	require.NoError(t, err)
}

func TestReconstructingSessionRegistryFreshRecordAndStaleHelpers(t *testing.T) {
	now := time.Unix(990, 0).UTC()
	record := registryTestRecord(now)
	record.LastObservedAt = now
	record.ExpiresAt = now.Add(time.Hour)
	registry := NewMemorySessionRegistry()
	_, err := registry.Put(context.Background(), record)
	require.NoError(t, err)

	hookCalled := false
	wrapped, err := NewReconstructingSessionRegistry(
		registry,
		func(context.Context, SessionReconstructionRequest) (SessionRecord, error) {
			hookCalled = true
			return SessionRecord{}, errors.New("redacted")
		},
		WithSessionReconstructionClock(fixedClock{now: now.Add(time.Minute)}),
		WithSessionReconstructionStaleAfter(time.Hour),
	)
	require.NoError(t, err)
	loaded, err := wrapped.Get(context.Background(), record.Key())
	require.NoError(t, err)
	require.False(t, hookCalled)
	require.Equal(t, record.ProviderState, loaded.ProviderState)

	require.True(t, reconstructionNow(nil).IsZero())
	require.True(t, reconstructionNow(zeroClock{}).IsZero())
	require.False(t, sessionRecordIsStale(record, time.Time{}, time.Minute))
	require.False(t, sessionRecordIsStale(record, now.Add(time.Minute), 0))
	missingObservation := record
	missingObservation.LastObservedAt = time.Time{}
	require.True(t, sessionRecordIsStale(missingObservation, now.Add(time.Minute), time.Second))
	expired := record
	expired.ExpiresAt = now.Add(-time.Second)
	require.True(t, sessionRecordIsStale(expired, now, time.Second))
}

type zeroClock struct{}

func (zeroClock) Now() time.Time { return time.Time{} }

func TestRegistryClientStopSessionAndFailClosedPaths(t *testing.T) {
	ctx := context.TODO()

	_, err := NewRegistryClient(nil)
	require.Error(t, err)

	registry := NewMemorySessionRegistry()
	client, err := NewRegistryClient(registry, nil, WithRegistryClientTTL(0))
	require.NoError(t, err)

	created, err := client.Create(ctx, CreateSessionInput{
		RequestID:           "req-create",
		TenantID:            "tenant-1",
		Namespace:           "namespace-1",
		SessionID:           "session-1",
		ImageRef:            "image-ref",
		NetworkConnectorRef: "network-ref",
		SessionSpec:         SessionSpec{Metadata: map[string]string{"safe": "ok"}},
		ControllerID:        "controller-1",
		AuthSubject:         "subject-1",
	})
	require.NoError(t, err)
	require.Equal(t, time.Unix(0, 0).UTC().Add(time.Hour), created.ExpiresAt)

	stopped, err := client.Stop(ctx, SessionCommandInput{
		RequestID:    "req-stop",
		TenantID:     "tenant-1",
		Namespace:    "namespace-1",
		SessionID:    "session-1",
		ControllerID: "controller-1",
		AuthSubject:  "subject-1",
		DesiredState: StateStopped,
	})
	require.NoError(t, err)
	require.Equal(t, StateStopping, stopped.State)
	require.Equal(t, StateStopped, stopped.DesiredState)
	require.Equal(t, CommandStop, stopped.LastAction)
	require.Equal(t, int64(2), stopped.Generation)

	session, err := client.Session(ctx, SessionQueryInput{
		RequestID:   "req-session",
		TenantID:    "tenant-1",
		Namespace:   "namespace-1",
		SessionID:   "session-1",
		AuthSubject: "subject-1",
	})
	require.NoError(t, err)
	require.Equal(t, CommandStop, session.LastAction)

	var nilClient *RegistryClient
	_, err = nilClient.Create(ctx, CreateSessionInput{RequestID: "req-create"})
	require.Error(t, err)
	_, err = nilClient.Stop(ctx, SessionCommandInput{RequestID: "req-stop"})
	require.Error(t, err)
	_, err = nilClient.Session(ctx, SessionQueryInput{RequestID: "req-session"})
	require.Error(t, err)
}

func TestMemorySessionRegistryNilAndInvalidKeysFailClosed(t *testing.T) {
	var nilRegistry *MemorySessionRegistry
	_, err := nilRegistry.Put(context.Background(), registryTestRecord(time.Unix(250, 0).UTC()))
	require.Error(t, err)
	_, err = nilRegistry.Get(context.Background(), SessionKey{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: "session-1"})
	require.Error(t, err)
	require.Error(t, nilRegistry.Delete(context.Background(), SessionKey{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: "session-1"}))

	registry := NewMemorySessionRegistry()
	_, err = registry.Get(context.Background(), SessionKey{TenantID: "", Namespace: "namespace-1", SessionID: "session-1"})
	require.Error(t, err)
	require.Error(t, registry.Delete(context.Background(), SessionKey{TenantID: "tenant-1", Namespace: "", SessionID: "session-1"}))
}

func TestTableTheorySessionRegistryFailClosedPaths(t *testing.T) {
	_, err := NewTableTheorySessionRegistry(nil)
	require.Error(t, err)

	key := SessionKey{TenantID: "tenant-1", Namespace: "namespace-1", SessionID: "session-1"}
	var nilStore *TableTheorySessionRegistry
	_, err = nilStore.Put(context.Background(), registryTestRecord(time.Unix(500, 0).UTC()))
	require.Error(t, err)
	_, err = nilStore.Get(context.Background(), key)
	require.Error(t, err)
	require.Error(t, nilStore.Delete(context.Background(), key))

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	db.On("Model", mock.Anything).Return(q).Once()
	q.On("WithContext", mock.Anything).Return(q).Once()
	q.On("CreateOrUpdate").Return(errors.New("raw table failure")).Once()

	store, err := NewTableTheorySessionRegistry(db)
	require.NoError(t, err)
	_, err = store.Put(context.Background(), registryTestRecord(time.Unix(501, 0).UTC()))
	require.Error(t, err)
	require.NotContains(t, err.Error(), "raw table failure")

	db.AssertExpectations(t)
	q.AssertExpectations(t)
}

func TestTableTheorySessionRegistryGetAndDelete(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(520, 0).UTC()
	record := registryTestRecord(now)
	registryRecord, err := SessionRecordToRegistryRecord(record)
	require.NoError(t, err)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	db.On("Model", mock.Anything).Return(q).Twice()
	q.On("WithContext", mock.Anything).Return(q).Twice()
	q.On("Where", "PK", "=", registryRecord.PK).Return(q).Twice()
	q.On("Where", "SK", "=", registryRecord.SK).Return(q).Twice()
	q.On("First", mock.Anything).Run(func(args mock.Arguments) {
		dest, ok := args.Get(0).(*SessionRegistryRecord)
		require.True(t, ok)
		*dest = registryRecord
	}).Return(nil).Once()
	q.On("Delete").Return(nil).Once()

	store, err := NewTableTheorySessionRegistry(db)
	require.NoError(t, err)
	loaded, err := store.Get(ctx, record.Key())
	require.NoError(t, err)
	require.Equal(t, record.ProviderID, loaded.ProviderID)
	require.NoError(t, store.Delete(ctx, record.Key()))

	db.AssertExpectations(t)
	q.AssertExpectations(t)
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
		TenantID:                    "tenant-1",
		Namespace:                   "namespace-1",
		SessionID:                   "session-1",
		State:                       StateStarting,
		DesiredState:                StateStarted,
		Endpoint:                    "https://microvm.example.test/session-1",
		MicroVMID:                   "microvm-1",
		ProviderID:                  AWSLambdaMicroVMProviderID,
		ProviderMicroVMID:           "provider-session-1",
		ProviderState:               "starting",
		AWSLifecycleState:           "Starting",
		ImageRef:                    "image-ref",
		ImageVersion:                "image-version-1",
		NetworkConnectorRef:         "network-ref",
		IngressNetworkConnectorRefs: []string{"ingress-ref"},
		EgressNetworkConnectorRefs:  []string{"egress-ref"},
		ControllerID:                "controller-1",
		CreatedAt:                   now,
		UpdatedAt:                   now.Add(time.Minute),
		LastObservedAt:              now.Add(2 * time.Minute),
		ProviderStartedAt:           now.Add(3 * time.Minute),
		ExpiresAt:                   now.Add(time.Hour),
		Generation:                  7,
		LastAction:                  CommandStart,
		LastCommandID:               "req-start",
		AuthSubject:                 "subject-1",
		ReasonMetadata:              map[string]string{"reason_code": "safe"},
		StatusMetadata:              map[string]string{"provider_status": "observed"},
		TokenMetadata: []SessionTokenMetadata{{
			TokenID:   "tok-safe",
			TokenType: "auth",
			ExpiresAt: now.Add(10 * time.Minute),
			Scope:     []string{"ports:443"},
		}},
		Metadata: map[string]string{"safe": "ok"},
	}
}

type fixedClock struct{ now time.Time }

func (c fixedClock) Now() time.Time { return c.now }
