package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	tablecore "github.com/theory-cloud/tabletheory/v6/pkg/core"
)

const m3StateBoundsFixture = "../../contract-tests/conformance/state-bounds-conformance.v1.json"

type m3StateBoundsLimits struct {
	MemorySessionsPerStore        int   `json:"memory_sessions_per_store"`
	MemoryStreamEventsPerSession  int   `json:"memory_stream_events_per_session"`
	MemoryStreamBytesPerSession   int64 `json:"memory_stream_bytes_per_session"`
	DurableAggregateEventsPerSess int   `json:"durable_aggregate_events_per_session"`
	DurableAggregateBytesPerSess  int64 `json:"durable_aggregate_bytes_per_session"`
	DurableSpillInlineMaxBytes    int   `json:"durable_spill_inline_max_bytes"`
	DurableMaxEventBytes          int   `json:"durable_max_event_bytes"`
	DeletePaginationPageSize      int   `json:"delete_pagination_page_size"`
}

type m3StateBoundsErrors struct {
	SessionCapacity struct {
		Message       string `json:"message"`
		JSONRPCCode   int    `json:"jsonrpc_code"`
		HTTPStatus    int    `json:"http_status"`
		SessionHeader bool   `json:"session_header"`
	} `json:"session_capacity"`
	AggregateCapacity      string `json:"aggregate_capacity"`
	AggregateBackfill      string `json:"aggregate_backfill_required"`
	TransactionUnsupported string `json:"transaction_unsupported"`
}

type m3StateBoundsCase struct {
	ID       string         `json:"id"`
	Surface  string         `json:"surface"`
	Scenario string         `json:"scenario"`
	Params   map[string]any `json:"params"`
	Expect   map[string]any `json:"expect"`
}

type m3StateBoundsDocument struct {
	Contract struct {
		ID string `json:"id"`
	} `json:"contract"`
	Limits m3StateBoundsLimits `json:"limits"`
	Errors m3StateBoundsErrors `json:"errors"`
	Cases  []m3StateBoundsCase `json:"cases"`
}

func loadM3StateBounds(t *testing.T) m3StateBoundsDocument {
	t.Helper()
	raw, err := os.ReadFile(m3StateBoundsFixture)
	require.NoError(t, err, "read shared M3 state-bounds fixture")
	var document m3StateBoundsDocument
	require.NoError(t, json.Unmarshal(raw, &document), "parse shared M3 state-bounds fixture")
	require.NotEmpty(t, document.Cases)
	return document
}

func m3CaseIDs(document m3StateBoundsDocument) map[string]m3StateBoundsCase {
	out := make(map[string]m3StateBoundsCase, len(document.Cases))
	for _, testCase := range document.Cases {
		out[testCase.ID] = testCase
	}
	return out
}

func TestM3StateBoundsFixturePinsLimitsAndRequiredCases(t *testing.T) {
	document := loadM3StateBounds(t)
	require.Equal(t, "m3.mcp-state-bounds/v1", document.Contract.ID)

	require.Equal(t, defaultMemorySessionStoreCapacity, document.Limits.MemorySessionsPerStore)
	require.Equal(t, defaultMemoryStreamMaxEventsPerSession, document.Limits.MemoryStreamEventsPerSession)
	require.Equal(t, int64(defaultMemoryStreamMaxSessionBytes), document.Limits.MemoryStreamBytesPerSession)
	require.Equal(t, defaultDynamoStreamAggregateEvents, document.Limits.DurableAggregateEventsPerSess)
	require.Equal(t, defaultDynamoStreamAggregateBytes, document.Limits.DurableAggregateBytesPerSess)
	require.Equal(t, defaultDynamoStreamSpillInlineMaxBytes, document.Limits.DurableSpillInlineMaxBytes)
	require.Equal(t, defaultDynamoStreamMaxEventBytes, document.Limits.DurableMaxEventBytes)

	require.Equal(t, ErrSessionCapacityExceeded.Error(), document.Errors.SessionCapacity.Message)
	require.Equal(t, int(CodeServerError), document.Errors.SessionCapacity.JSONRPCCode)
	require.Equal(t, 200, document.Errors.SessionCapacity.HTTPStatus)
	require.False(t, document.Errors.SessionCapacity.SessionHeader)
	require.Equal(t, ErrStreamAggregateCapacityExceeded.Error(), document.Errors.AggregateCapacity)
	require.Equal(t, ErrStreamAggregateBackfillRequired.Error(), document.Errors.AggregateBackfill)
	require.Equal(t, ErrStreamTransactionRequired.Error(), document.Errors.TransactionUnsupported)

	cases := m3CaseIDs(document)
	required := []string{
		"memory.session.capacity_refuses_new_live_session",
		"memory.session.expired_first_reclaims_before_admission",
		"memory.session.same_id_live_refresh_consumes_no_capacity",
		"memory.session.expired_incoming_put_not_revived",
		"memory.session.cleanup_removes_associated_state",
		"http.initialize.capacity_refusal_maps_server_error",
		"batch.initialize.capacity_refusal_maps_server_error",
		"durable.aggregate.count_boundary",
		"durable.aggregate.byte_boundary",
		"durable.aggregate.spill_counts_toward_aggregate",
		"durable.aggregate.pre_aggregate_schema_refused",
		"durable.aggregate.concurrent_append_unique_sequence",
		"durable.aggregate.non_transactional_backend_refused",
		"durable.delete.paginates_beyond_1000_records",
		"durable.delete.late_append_refused",
	}
	for _, id := range required {
		require.Contains(t, cases, id, "shared fixture must carry %s", id)
	}
}

type m3MutableClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *m3MutableClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *m3MutableClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func TestM3MemorySessionCapacityExpiredFirstSameIDAndExpiredPut(t *testing.T) {
	now := time.Unix(10_000, 0).UTC()
	clock := &m3MutableClock{now: now}
	store := NewMemorySessionStore(WithClock(clock), WithSessionCapacityLimit(2))
	ctx := context.Background()

	require.NoError(t, store.Put(ctx, &Session{ID: "one", ExpiresAt: now.Add(time.Minute)}))
	require.NoError(t, store.Put(ctx, &Session{ID: "two", ExpiresAt: now.Add(time.Minute)}))

	require.ErrorIs(t, store.Put(ctx, &Session{ID: "three", ExpiresAt: now.Add(time.Minute)}), ErrSessionCapacityExceeded)
	_, err := store.Get(ctx, "one")
	require.NoError(t, err, "capacity refusal must not evict a live session")
	_, err = store.Get(ctx, "two")
	require.NoError(t, err, "capacity refusal must not evict a live session")
	_, err = store.Get(ctx, "three")
	require.ErrorIs(t, err, ErrSessionNotFound)

	require.NoError(t, store.Put(ctx, &Session{ID: "one", ExpiresAt: now.Add(time.Minute), Data: map[string]string{"refreshed": "true"}}),
		"a live same-ID overwrite must not consume new capacity")

	clock.Advance(2 * time.Minute)
	expired, err := store.PutAndCollectExpired(ctx, &Session{ID: "four", ExpiresAt: clock.Now().Add(time.Minute)})
	require.NoError(t, err)
	require.ElementsMatch(t, []string{"one", "two"}, expired)
	for _, id := range []string{"one", "two"} {
		_, getErr := store.Get(ctx, id)
		require.ErrorIs(t, getErr, ErrSessionNotFound)
	}

	require.ErrorIs(t, store.Put(ctx, &Session{ID: "stale", ExpiresAt: clock.Now().Add(-time.Second)}), ErrSessionExpired)
	_, err = store.Get(ctx, "stale")
	require.ErrorIs(t, err, ErrSessionNotFound)
}

type m3FailingSessionStore struct{ err error }

func (s m3FailingSessionStore) Get(context.Context, string) (*Session, error) { return nil, s.err }
func (s m3FailingSessionStore) Put(context.Context, *Session) error           { return s.err }
func (s m3FailingSessionStore) Delete(context.Context, string) error          { return s.err }

func TestM3CapacityRefusalMapsIdenticallyThroughHTTPAndBatch(t *testing.T) {
	now := time.Now().UTC()
	store := NewMemorySessionStore(WithSessionCapacityLimit(1))
	require.NoError(t, store.Put(context.Background(), &Session{ID: "occupied", ExpiresAt: now.Add(time.Hour)}))

	server := NewServer("m3", "test", WithSessionStore(store))
	request := &Request{
		JSONRPC: "2.0",
		ID:      "init",
		Method:  methodInitialize,
		Params:  json.RawMessage(`{"protocolVersion":"2025-11-25"}`),
	}

	httpResponse, err := server.handleInitializeHTTP(context.Background(), request)
	require.NoError(t, err)
	require.Equal(t, 200, httpResponse.Status)
	require.Empty(t, firstHeader(httpResponse.Headers, headerMcpSessionID))
	var httpBody Response
	require.NoError(t, json.Unmarshal(httpResponse.Body, &httpBody))
	require.NotNil(t, httpBody.Error)
	require.Equal(t, CodeServerError, httpBody.Error.Code)
	require.Equal(t, "Session capacity exceeded", httpBody.Error.Message)

	batchResponse, session, batchErr := server.handleInitializeBatch(context.Background(), request, protocolVersion)
	require.Nil(t, batchResponse)
	require.Nil(t, session)
	require.NotNil(t, batchErr)
	require.NotNil(t, batchErr.Error)
	require.Equal(t, CodeServerError, batchErr.Error.Code)
	require.Equal(t, "Session capacity exceeded", batchErr.Error.Message)

	genericStore := m3FailingSessionStore{err: errors.New("store unavailable")}
	genericServer := NewServer("m3", "test", WithSessionStore(genericStore))
	genericResponse, err := genericServer.handleInitializeHTTP(context.Background(), request)
	require.NoError(t, err)
	require.Equal(t, 200, genericResponse.Status)
	require.Empty(t, firstHeader(genericResponse.Headers, headerMcpSessionID))
	var genericBody Response
	require.NoError(t, json.Unmarshal(genericResponse.Body, &genericBody))
	require.NotNil(t, genericBody.Error)
	require.Equal(t, CodeInternalError, genericBody.Error.Code)
	require.Equal(t, "session error", genericBody.Error.Message)
}

func TestM3SessionCleanupRemovesAssociatedState(t *testing.T) {
	now := time.Unix(20_000, 0).UTC()
	ctx := context.Background()
	clock := &m3MutableClock{now: now}
	sessionStore := NewMemorySessionStore(WithClock(clock), WithSessionCapacityLimit(2))
	streamStore := NewMemoryStreamStore()
	taskStore := NewMemoryTaskStore()
	server := NewServer("m3", "test",
		WithSessionStore(sessionStore),
		WithStreamStore(streamStore),
		WithTaskRuntime(TaskRuntimeOptions{Store: taskStore}),
	)

	require.NoError(t, sessionStore.Put(ctx, &Session{ID: "sess-cleanup", ExpiresAt: now.Add(time.Hour)}))
	streamID, err := streamStore.Create(ctx, "sess-cleanup")
	require.NoError(t, err)
	_, err = streamStore.Append(ctx, "sess-cleanup", streamID, json.RawMessage(`{"event":1}`))
	require.NoError(t, err)
	_, err = taskStore.Create(ctx, TaskRecord{
		SessionID: "sess-cleanup",
		Task: Task{
			TaskID:        "task-cleanup",
			Status:        TaskStatusWorking,
			CreatedAt:     now,
			LastUpdatedAt: now,
		},
	})
	require.NoError(t, err)
	trackedCtx, finish := server.cancellations.track(ctx, "sess-cleanup", "req-cleanup")
	require.NotNil(t, trackedCtx)
	defer finish()

	require.NoError(t, server.cleanupSessionState(ctx, "sess-cleanup"))

	_, err = streamStore.Subscribe(ctx, "sess-cleanup", streamID, "")
	require.Error(t, err)
	_, err = streamStore.StreamForEvent(ctx, "sess-cleanup", "1")
	require.Error(t, err)
	_, err = taskStore.Get(ctx, TaskLookup{SessionID: "sess-cleanup", TaskID: "task-cleanup"})
	require.ErrorIs(t, err, ErrTaskNotFound)
	require.False(t, server.cancellations.cancel("sess-cleanup", "req-cleanup"))
}

func TestM3InitializeSweepCleansAssociatedExpiredState(t *testing.T) {
	now := time.Unix(30_000, 0).UTC()
	ctx := context.Background()
	clock := &m3MutableClock{now: now}
	sessionStore := NewMemorySessionStore(WithClock(clock), WithSessionCapacityLimit(2))
	streamStore := NewMemoryStreamStore()
	taskStore := NewMemoryTaskStore()
	server := NewServer("m3", "test",
		WithSessionStore(sessionStore),
		WithStreamStore(streamStore),
		WithTaskRuntime(TaskRuntimeOptions{Store: taskStore}),
	)

	require.NoError(t, sessionStore.Put(ctx, &Session{ID: "sess-expired", ExpiresAt: now.Add(time.Minute)}))
	streamID, err := streamStore.Create(ctx, "sess-expired")
	require.NoError(t, err)
	_, err = streamStore.Append(ctx, "sess-expired", streamID, json.RawMessage(`{"event":1}`))
	require.NoError(t, err)
	_, err = taskStore.Create(ctx, TaskRecord{
		SessionID: "sess-expired",
		Task: Task{
			TaskID:        "task-expired",
			Status:        TaskStatusWorking,
			CreatedAt:     now,
			LastUpdatedAt: now,
		},
	})
	require.NoError(t, err)

	clock.Advance(2 * time.Minute)
	response, err := server.handleInitializeHTTP(ctx, &Request{
		JSONRPC: "2.0",
		ID:      "init-sweep",
		Method:  methodInitialize,
		Params:  json.RawMessage(`{"protocolVersion":"2025-11-25"}`),
	})
	require.NoError(t, err)
	require.Equal(t, 200, response.Status)
	require.NotEmpty(t, firstHeader(response.Headers, headerMcpSessionID))

	_, err = streamStore.Subscribe(ctx, "sess-expired", streamID, "")
	require.Error(t, err)
	_, err = taskStore.Get(ctx, TaskLookup{SessionID: "sess-expired", TaskID: "task-expired"})
	require.ErrorIs(t, err, ErrTaskNotFound)
}

// m3NonTransactDB intentionally hides TransactWrite from DynamoStreamStore.
type m3NonTransactDB struct{ inner *fakeMCPTableDB }

func (d m3NonTransactDB) Model(model any) tablecore.Query { return d.inner.Model(model) }
func (m3NonTransactDB) Migrate() error                    { return nil }
func (m3NonTransactDB) AutoMigrate(...any) error          { return nil }
func (m3NonTransactDB) Close() error                      { return nil }
func (d m3NonTransactDB) WithContext(context.Context) tablecore.DB {
	return d
}

func newM3DynamoStore(db tablecore.DB, now time.Time) *DynamoStreamStore {
	store, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	if !ok {
		panic("NewDynamoStreamStore returned a non-DynamoStreamStore")
	}
	store.now = func() time.Time { return now }
	return store
}

func TestM3DynamoAggregateCountBoundaryAndReplayContinuity(t *testing.T) {
	now := time.Unix(40_000, 0).UTC()
	ctx := context.Background()
	db := newFakeMCPTableDB()
	store := newM3DynamoStore(db, now)
	store.maxAggregateEvents = 3

	streamID, err := store.Create(ctx, "sess-count")
	require.NoError(t, err)
	for i := 0; i < 3; i++ {
		eventID, appendErr := store.Append(ctx, "sess-count", streamID, json.RawMessage(`{"ok":true}`))
		require.NoError(t, appendErr)
		require.Equal(t, int64(i+1), parseEventSeq(t, eventID))
	}
	_, err = store.Append(ctx, "sess-count", streamID, json.RawMessage(`{"ok":true}`))
	require.ErrorIs(t, err, ErrStreamAggregateCapacityExceeded)
	require.Equal(t, 3, countM3EventRecords(db, "sess-count"))

	state, err := store.getSessionState(ctx, "sess-count")
	require.NoError(t, err)
	require.Equal(t, int64(3), state.EventCount)
	require.Equal(t, int64(3), state.NextSeq)
}

func TestM3DynamoAggregateByteBoundaryAndSpillAccounting(t *testing.T) {
	now := time.Unix(50_000, 0).UTC()
	ctx := context.Background()
	db := newFakeMCPTableDB()
	store := newM3DynamoStore(db, now)
	spill := newFakeDynamoStreamSpillStore()
	store.spillStore = spill
	store.inlineMaxBytes = 8
	payload := json.RawMessage(`{"a":"0123456789"}`)
	store.maxAggregateBytes = int64(2 * len(payload))

	streamID, err := store.Create(ctx, "sess-bytes")
	require.NoError(t, err)
	firstEvent, err := store.Append(ctx, "sess-bytes", streamID, payload)
	require.NoError(t, err)
	require.NotEmpty(t, firstEvent)
	record, ok := db.getStreamRecord("sess-bytes", firstEvent)
	require.True(t, ok)
	require.NotEmpty(t, record.DataRef, "payload above the inline threshold must spill")
	require.Equal(t, 1, spill.count())

	_, err = store.Append(ctx, "sess-bytes", streamID, payload)
	require.NoError(t, err)
	_, err = store.Append(ctx, "sess-bytes", streamID, payload)
	require.ErrorIs(t, err, ErrStreamAggregateCapacityExceeded)

	state, err := store.getSessionState(ctx, "sess-bytes")
	require.NoError(t, err)
	require.Equal(t, int64(2*len(payload)), state.AggregateBytes, "inline and spilled bytes share one aggregate")
	require.Equal(t, 2, spill.count())
}

func TestM3DynamoPreAggregateSessionRefusesAppend(t *testing.T) {
	now := time.Unix(60_000, 0).UTC()
	ctx := context.Background()
	db := newFakeMCPTableDB()
	store := newM3DynamoStore(db, now)

	// An earlier release left a session record without aggregate counters.
	db.streams["sess-legacy"] = map[string]dynamoStreamRecord{
		dynamoStreamSessionStateEventID: {
			SessionID: "sess-legacy",
			EventID:   dynamoStreamSessionStateEventID,
			Kind:      dynamoStreamRecordKindSession,
			CreatedAt: now,
			ExpiresAt: now.Add(time.Hour).Unix(),
			NextSeq:   7,
		},
	}
	streamID, err := store.Create(ctx, "sess-legacy")
	require.NoError(t, err)
	_, err = store.Append(ctx, "sess-legacy", streamID, json.RawMessage(`{"ok":true}`))
	require.ErrorIs(t, err, ErrStreamAggregateBackfillRequired)
	require.Equal(t, 0, countM3EventRecords(db, "sess-legacy"))
}

func TestM3DynamoNonTransactionalBackendRefusesBeforeWrite(t *testing.T) {
	now := time.Unix(70_000, 0).UTC()
	ctx := context.Background()
	db := newFakeMCPTableDB()
	store := newM3DynamoStore(m3NonTransactDB{inner: db}, now)

	streamID, err := store.Create(ctx, "sess-no-tx")
	require.NoError(t, err)
	_, err = store.Append(ctx, "sess-no-tx", streamID, json.RawMessage(`{"ok":true}`))
	require.ErrorIs(t, err, ErrStreamTransactionRequired)
	require.Equal(t, 0, countM3EventRecords(db, "sess-no-tx"))
}

func TestM3DynamoConcurrentAppendDoesNotOvershoot(t *testing.T) {
	now := time.Unix(80_000, 0).UTC()
	ctx := context.Background()
	db := newFakeMCPTableDB()
	store := newM3DynamoStore(db, now)
	store.maxAggregateEvents = 1
	store.appendRetries = 16

	streamID, err := store.Create(ctx, "sess-race")
	require.NoError(t, err)

	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, appendErr := store.Append(ctx, "sess-race", streamID, json.RawMessage(`{"ok":true}`))
			results <- appendErr
		}()
	}
	wg.Wait()
	close(results)

	succeeded := 0
	var denied error
	for appendErr := range results {
		if appendErr == nil {
			succeeded++
			continue
		}
		denied = appendErr
	}
	require.Equal(t, 1, succeeded)
	require.ErrorIs(t, denied, ErrStreamAggregateCapacityExceeded)
	require.Equal(t, 1, countM3EventRecords(db, "sess-race"))
	state, err := store.getSessionState(ctx, "sess-race")
	require.NoError(t, err)
	require.Equal(t, int64(1), state.EventCount)
}

func TestM3DynamoConcurrentAppendAllocatesUniqueSequences(t *testing.T) {
	now := time.Unix(90_000, 0).UTC()
	ctx := context.Background()
	db := newFakeMCPTableDB()
	store := newM3DynamoStore(db, now)
	store.maxAggregateEvents = 64
	store.appendRetries = 64

	streamID, err := store.Create(ctx, "sess-concurrent")
	require.NoError(t, err)

	const writers = 8
	var wg sync.WaitGroup
	eventIDs := make(chan string, writers)
	errs := make(chan error, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			eventID, appendErr := store.Append(ctx, "sess-concurrent", streamID, json.RawMessage(`{"ok":true}`))
			eventIDs <- eventID
			errs <- appendErr
		}()
	}
	wg.Wait()
	close(eventIDs)
	close(errs)

	for appendErr := range errs {
		require.NoError(t, appendErr)
	}
	seen := map[int64]struct{}{}
	for eventID := range eventIDs {
		seen[parseEventSeq(t, eventID)] = struct{}{}
	}
	require.Len(t, seen, writers)
	state, err := store.getSessionState(ctx, "sess-concurrent")
	require.NoError(t, err)
	require.Equal(t, int64(writers), state.EventCount)
	require.Equal(t, int64(writers), state.NextSeq)
}

func TestM3DynamoSpillRefusalCleanupIsJoined(t *testing.T) {
	now := time.Unix(100_000, 0).UTC()
	ctx := context.Background()
	db := newFakeMCPTableDB()
	store := newM3DynamoStore(db, now)
	spill := newFakeDynamoStreamSpillStore()
	store.spillStore = spill
	store.inlineMaxBytes = 8
	store.appendRetries = 1

	streamID, err := store.Create(ctx, "sess-spill-refusal")
	require.NoError(t, err)
	db.beforeCreateStreamEvent = func(record dynamoStreamRecord) {
		if record.Kind != dynamoStreamRecordKindEvent {
			return
		}
		db.mu.Lock()
		defer db.mu.Unlock()
		state := db.streams["sess-spill-refusal"][dynamoStreamSessionStateEventID]
		state.Deleted = true
		db.streams["sess-spill-refusal"][dynamoStreamSessionStateEventID] = state
	}

	_, err = store.Append(ctx, "sess-spill-refusal", streamID, json.RawMessage(`{"a":"0123456789"}`))
	require.ErrorIs(t, err, ErrStreamNotFound)
	require.Equal(t, 0, spill.count(), "a refused append must delete its spilled object")
	require.Equal(t, 0, countM3EventRecords(db, "sess-spill-refusal"))
}

func TestM3DynamoDeletePaginatesBeyond1000AndRejectsLateAppend(t *testing.T) {
	now := time.Unix(110_000, 0).UTC()
	ctx := context.Background()
	db := newFakeMCPTableDB()
	store := newM3DynamoStore(db, now)
	store.pollInterval = time.Millisecond

	streamID, err := store.Create(ctx, "sess-delete")
	require.NoError(t, err)
	db.mu.Lock()
	for i := 0; i < 1001; i++ {
		eventID := dynamoStreamEventIDForSeq(int64(i + 1))
		db.streams["sess-delete"][eventID] = dynamoStreamRecord{
			SessionID: "sess-delete",
			EventID:   eventID,
			StreamID:  streamID,
			Kind:      dynamoStreamRecordKindEvent,
			CreatedAt: now,
			ExpiresAt: now.Add(time.Hour).Unix(),
			DataBytes: 2,
			Data:      json.RawMessage(`{}`),
		}
	}
	db.mu.Unlock()
	require.Equal(t, 1001, countM3EventRecords(db, "sess-delete"))

	require.NoError(t, store.DeleteSession(ctx, "sess-delete"))
	require.Equal(t, 0, db.countNonSessionStreamRecords("sess-delete"))

	_, err = store.Append(ctx, "sess-delete", streamID, json.RawMessage(`{"late":true}`))
	require.ErrorIs(t, err, ErrStreamNotFound)
}

func countM3EventRecords(db *fakeMCPTableDB, sessionID string) int {
	count := 0
	for _, record := range db.sessionStreamRecords(sessionID) {
		if record.Kind == dynamoStreamRecordKindEvent {
			count++
		}
	}
	return count
}

func parseEventSeq(t *testing.T, eventID string) int64 {
	t.Helper()
	seq, err := strconv.ParseInt(eventID, 10, 64)
	require.NoError(t, err)
	return seq
}
