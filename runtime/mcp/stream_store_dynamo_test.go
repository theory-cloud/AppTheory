package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	tablecore "github.com/theory-cloud/tabletheory/pkg/core"
	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"
)

func TestDynamoStreamStore_CreateSubscribeReplayAndDeleteSession(t *testing.T) {
	t.Setenv(envStreamTTLMinutes, "15")

	db := newFakeMCPTableDB()
	store1, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)
	store2, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)

	store1.idGen = staticIDGenerator{id: "stream-1"}
	store1.pollInterval = time.Millisecond
	store2.pollInterval = time.Millisecond

	now := time.Date(2026, 4, 10, 12, 0, 0, 0, time.UTC)
	store1.now = func() time.Time { return now }
	store2.now = func() time.Time { return now }

	streamID, err := store1.Create(context.Background(), "sess-1")
	require.NoError(t, err)
	require.Equal(t, "stream-1", streamID)

	meta, ok := db.getStreamRecord("sess-1", dynamoStreamMetadataEventID(streamID))
	require.True(t, ok)
	require.Equal(t, dynamoStreamRecordKindStream, meta.Kind)
	require.Equal(t, now.Add(15*time.Minute).Unix(), meta.ExpiresAt)

	eventID1, err := store1.Append(context.Background(), "sess-1", streamID, json.RawMessage(`{"seq":1}`))
	require.NoError(t, err)
	require.Equal(t, dynamoStreamEventIDForSeq(1), eventID1)

	event1, ok := db.getStreamRecord("sess-1", eventID1)
	require.True(t, ok)
	require.Equal(t, dynamoStreamRecordKindEvent, event1.Kind)
	require.Equal(t, streamID, event1.StreamID)
	require.Equal(t, json.RawMessage(`{"seq":1}`), event1.Data)
	require.Equal(t, now.Add(15*time.Minute).Unix(), event1.ExpiresAt)

	ch, err := store2.Subscribe(context.Background(), "sess-1", streamID, "")
	require.NoError(t, err)
	got1 := requireStreamEvent(t, ch)
	require.Equal(t, eventID1, got1.ID)
	require.JSONEq(t, `{"seq":1}`, string(got1.Data))

	now = now.Add(2 * time.Minute)
	eventID2, err := store1.Append(context.Background(), "sess-1", streamID, json.RawMessage(`{"seq":2}`))
	require.NoError(t, err)
	require.Equal(t, dynamoStreamEventIDForSeq(2), eventID2)

	got2 := requireStreamEvent(t, ch)
	require.Equal(t, eventID2, got2.ID)
	require.JSONEq(t, `{"seq":2}`, string(got2.Data))

	require.NoError(t, store1.Close(context.Background(), "sess-1", streamID))
	requireStreamClosed(t, ch)

	meta, ok = db.getStreamRecord("sess-1", dynamoStreamMetadataEventID(streamID))
	require.True(t, ok)
	require.True(t, meta.Closed)
	require.Equal(t, now.Add(15*time.Minute).Unix(), meta.ExpiresAt)

	replay, err := store2.Subscribe(context.Background(), "sess-1", streamID, eventID1)
	require.NoError(t, err)
	replayed := requireStreamEvent(t, replay)
	require.Equal(t, eventID2, replayed.ID)
	require.JSONEq(t, `{"seq":2}`, string(replayed.Data))
	requireStreamClosed(t, replay)

	gotStreamID, err := store2.StreamForEvent(context.Background(), "sess-1", eventID1)
	require.NoError(t, err)
	require.Equal(t, streamID, gotStreamID)

	state, ok := db.getStreamRecord("sess-1", dynamoStreamSessionStateEventID)
	require.True(t, ok)
	require.Equal(t, dynamoStreamRecordKindSession, state.Kind)
	require.Equal(t, int64(2), state.NextSeq)

	require.NoError(t, store1.DeleteSession(context.Background(), "sess-1"))
	_, err = store2.StreamForEvent(context.Background(), "sess-1", eventID1)
	require.ErrorIs(t, err, ErrEventNotFound)
	_, err = store2.Subscribe(context.Background(), "sess-1", streamID, "")
	require.ErrorIs(t, err, ErrStreamNotFound)

	records := db.sessionStreamRecords("sess-1")
	require.Len(t, records, 1)
	require.Equal(t, dynamoStreamSessionStateEventID, records[0].EventID)
	require.True(t, records[0].Deleted)
}

func TestDynamoStreamStore_ReplayPreservesSessionSequenceAcrossStreams(t *testing.T) {
	db := newFakeMCPTableDB()
	store, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)

	store.batchSize = 1
	store.pollInterval = time.Millisecond

	streamA, err := store.Create(context.Background(), "sess-1")
	require.NoError(t, err)
	streamB, err := store.Create(context.Background(), "sess-1")
	require.NoError(t, err)

	eventA1, err := store.Append(context.Background(), "sess-1", streamA, json.RawMessage(`{"stream":"A","seq":1}`))
	require.NoError(t, err)
	eventB1, err := store.Append(context.Background(), "sess-1", streamB, json.RawMessage(`{"stream":"B","seq":1}`))
	require.NoError(t, err)
	eventA2, err := store.Append(context.Background(), "sess-1", streamA, json.RawMessage(`{"stream":"A","seq":2}`))
	require.NoError(t, err)

	require.Equal(t, dynamoStreamEventIDForSeq(1), eventA1)
	require.Equal(t, dynamoStreamEventIDForSeq(2), eventB1)
	require.Equal(t, dynamoStreamEventIDForSeq(3), eventA2)

	state, ok := db.getStreamRecord("sess-1", dynamoStreamSessionStateEventID)
	require.True(t, ok)
	require.Equal(t, int64(3), state.NextSeq)

	require.NoError(t, store.Close(context.Background(), "sess-1", streamA))

	replay, err := store.Subscribe(context.Background(), "sess-1", streamA, eventA1)
	require.NoError(t, err)

	replayed := requireStreamEvent(t, replay)
	require.Equal(t, eventA2, replayed.ID)
	require.JSONEq(t, `{"stream":"A","seq":2}`, string(replayed.Data))
	requireStreamClosed(t, replay)
}

func TestDynamoStreamStore_DeleteSessionDrainsLateAppend(t *testing.T) {
	db := newFakeMCPTableDB()
	store, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)

	store.pollInterval = 10 * time.Millisecond

	streamID, err := store.Create(context.Background(), "sess-1")
	require.NoError(t, err)

	appendEntered := make(chan struct{})
	releaseAppend := make(chan struct{})
	db.beforeCreateStreamEvent = func(record dynamoStreamRecord) {
		if record.SessionID != "sess-1" || record.StreamID != streamID {
			return
		}
		select {
		case <-appendEntered:
		default:
			close(appendEntered)
		}
		<-releaseAppend
	}

	appendDone := make(chan struct{})
	var (
		eventID   string
		appendErr error
	)
	go func() {
		defer close(appendDone)
		eventID, appendErr = store.Append(context.Background(), "sess-1", streamID, json.RawMessage(`{"seq":1}`))
	}()

	select {
	case <-appendEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for append to reach event create")
	}

	deleteDone := make(chan error, 1)
	go func() {
		deleteDone <- store.DeleteSession(context.Background(), "sess-1")
	}()

	require.Eventually(t, func() bool {
		_, ok := db.getStreamRecord("sess-1", dynamoStreamMetadataEventID(streamID))
		return !ok
	}, time.Second, time.Millisecond)

	close(releaseAppend)

	select {
	case <-appendDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for append to finish")
	}
	require.NoError(t, appendErr)
	require.Equal(t, dynamoStreamEventIDForSeq(1), eventID)

	select {
	case deleteErr := <-deleteDone:
		require.NoError(t, deleteErr)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for DeleteSession")
	}

	require.Eventually(t, func() bool {
		return db.countNonSessionStreamRecords("sess-1") == 0
	}, time.Second, time.Millisecond)

	records := db.sessionStreamRecords("sess-1")
	require.Len(t, records, 1)
	require.Equal(t, dynamoStreamSessionStateEventID, records[0].EventID)
	require.True(t, records[0].Deleted)

	_, err = store.StreamForEvent(context.Background(), "sess-1", eventID)
	require.ErrorIs(t, err, ErrEventNotFound)
}

func TestDynamoStreamStore_ServerReplayFromSecondInstance(t *testing.T) {
	db := newFakeMCPTableDB()
	sessionStore := NewDynamoSessionStore(db)
	streamStore1, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)
	streamStore2, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)
	streamStore1.pollInterval = time.Millisecond
	streamStore2.pollInterval = time.Millisecond

	s1 := NewServer("test-server", "1.0.0", WithSessionStore(sessionStore), WithStreamStore(streamStore1))
	s2 := NewServer("test-server", "1.0.0", WithSessionStore(sessionStore), WithStreamStore(streamStore2))

	sessionID := initializeSession(t, s1)

	firstEmitted := make(chan struct{})
	continueTool := make(chan struct{})
	toolDone := make(chan struct{})

	err := s1.Registry().RegisterStreamingTool(
		ToolDef{
			Name:        "slow_tool",
			Description: "Emits progress then blocks",
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		func(ctx context.Context, _ json.RawMessage, emit func(SSEEvent)) (*ToolResult, error) {
			emit(SSEEvent{Data: map[string]any{"seq": 1}})
			close(firstEmitted)

			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-continueTool:
			}

			emit(SSEEvent{Data: map[string]any{"seq": 2}})
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: "ok"}}}, nil
		},
	)
	require.NoError(t, err)

	params := toolsCallParams{Name: "slow_tool", Arguments: json.RawMessage(`{}`)}
	params.Meta.ProgressToken = json.RawMessage(`"pt-123"`)
	body := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: methodToolsCall, Params: mustMarshal(t, params)})

	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"text/event-stream"}

	reqCtx, cancel := context.WithCancel(context.Background())
	resp, err := invokeHandlerWithMethod(reqCtx, s1, "POST", body, headers)
	require.NoError(t, err)
	require.NotNil(t, resp.BodyReader)

	reader := bufio.NewReader(resp.BodyReader)

	select {
	case <-firstEmitted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for first progress emission")
	}

	firstFrame, err := readSSEFrame(reader)
	require.NoError(t, err)
	require.Contains(t, firstFrame, `"method":"notifications/progress"`)
	require.Contains(t, firstFrame, `"progress":1`)

	lastID := ""
	for _, line := range strings.Split(firstFrame, "\n") {
		if strings.HasPrefix(line, "id: ") {
			lastID = strings.TrimSpace(strings.TrimPrefix(line, "id: "))
			break
		}
	}
	require.NotEmpty(t, lastID)

	cancel()

	go func() {
		defer close(toolDone)
		close(continueTool)
	}()

	select {
	case <-toolDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for tool completion")
	}

	getHeaders := sessionHeaders(sessionID)
	getHeaders["accept"] = []string{"text/event-stream"}
	getHeaders["last-event-id"] = []string{lastID}

	getResp, err := invokeHandlerWithMethod(context.Background(), s2, "GET", nil, getHeaders)
	require.NoError(t, err)
	require.NotNil(t, getResp.BodyReader)

	b, err := io.ReadAll(getResp.BodyReader)
	require.NoError(t, err)

	all := string(b)
	require.Contains(t, all, `"method":"notifications/progress"`)
	require.Contains(t, all, `"progress":2`)
	require.Contains(t, all, `"result"`)
	require.NotContains(t, all, `"progress":1`)
}

func TestDynamoStreamStore_SubscribeDrainsTailEventsAfterClose(t *testing.T) {
	db := newFakeMCPTableDB()
	store, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)

	streamID, err := store.Create(context.Background(), "sess-1")
	require.NoError(t, err)

	eventID1, err := store.Append(context.Background(), "sess-1", streamID, json.RawMessage(`{"kind":"progress","seq":1}`))
	require.NoError(t, err)
	eventID2, err := store.Append(context.Background(), "sess-1", streamID, json.RawMessage(`{"kind":"progress","seq":2}`))
	require.NoError(t, err)

	finalData := json.RawMessage(`{"jsonrpc":"2.0","result":{"ok":true}}`)
	hookErrCh := make(chan error, 1)
	var injected sync.Once

	db.afterMatchStreamRecords = func(q *fakeMCPTableQuery, records []dynamoStreamRecord) {
		afterEventID, ok := q.whereString("EventID", ">")
		if !ok || afterEventID != eventID1 {
			return
		}
		if len(records) != 1 || records[0].EventID != eventID2 {
			return
		}

		injected.Do(func() {
			if _, appendErr := store.Append(context.Background(), "sess-1", streamID, finalData); appendErr != nil {
				hookErrCh <- appendErr
				return
			}
			if closeErr := store.Close(context.Background(), "sess-1", streamID); closeErr != nil {
				hookErrCh <- closeErr
			}
		})
	}

	ch, err := store.Subscribe(context.Background(), "sess-1", streamID, eventID1)
	require.NoError(t, err)

	ev := requireStreamEvent(t, ch)
	require.Equal(t, eventID2, ev.ID)
	require.JSONEq(t, string(json.RawMessage(`{"kind":"progress","seq":2}`)), string(ev.Data))

	ev = requireStreamEvent(t, ch)
	require.JSONEq(t, string(finalData), string(ev.Data))
	requireStreamClosed(t, ch)

	select {
	case hookErr := <-hookErrCh:
		require.NoError(t, hookErr)
	default:
	}
}

func TestDELETE_WithDynamoStreamStore_RemovesStreamState(t *testing.T) {
	db := newFakeMCPTableDB()
	sessionStore := NewDynamoSessionStore(db)
	streamStore, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)

	s := NewServer("test-server", "1.0.0", WithSessionStore(sessionStore), WithStreamStore(streamStore))
	sessionID := initializeSession(t, s)

	streamID, err := streamStore.Create(context.Background(), sessionID)
	require.NoError(t, err)
	eventID, err := streamStore.Append(context.Background(), sessionID, streamID, json.RawMessage(`{"jsonrpc":"2.0","result":{"ok":true}}`))
	require.NoError(t, err)

	headers := sessionHeaders(sessionID)
	resp, err := invokeHandlerWithMethod(context.Background(), s, "DELETE", nil, headers)
	require.NoError(t, err)
	require.Equal(t, 202, resp.Status)

	_, err = streamStore.StreamForEvent(context.Background(), sessionID, eventID)
	require.ErrorIs(t, err, ErrEventNotFound)
}

func TestDynamoStreamStore_Errors(t *testing.T) {
	store, ok := NewDynamoStreamStore(newFakeMCPTableDB()).(*DynamoStreamStore)
	require.True(t, ok)

	_, err := store.Create(context.Background(), "")
	require.Error(t, err)

	_, err = store.Append(context.Background(), "", "stream-1", nil)
	require.Error(t, err)
	_, err = store.Append(context.Background(), "sess-1", "", nil)
	require.Error(t, err)
	_, err = store.Append(context.Background(), "sess-1", "stream-1", nil)
	require.ErrorIs(t, err, ErrStreamNotFound)

	err = store.Close(context.Background(), "", "stream-1")
	require.Error(t, err)
	err = store.Close(context.Background(), "sess-1", "")
	require.Error(t, err)
	err = store.Close(context.Background(), "sess-1", "stream-1")
	require.ErrorIs(t, err, ErrStreamNotFound)

	_, err = store.StreamForEvent(context.Background(), "", "evt-1")
	require.Error(t, err)
	_, err = store.StreamForEvent(context.Background(), "sess-1", "")
	require.Error(t, err)
	_, err = store.StreamForEvent(context.Background(), "sess-1", "evt-1")
	require.ErrorIs(t, err, ErrEventNotFound)

	_, err = store.Subscribe(context.Background(), "", "stream-1", "")
	require.Error(t, err)
	_, err = store.Subscribe(context.Background(), "sess-1", "", "")
	require.Error(t, err)
	_, err = store.Subscribe(context.Background(), "sess-1", "stream-1", "")
	require.ErrorIs(t, err, ErrStreamNotFound)

	err = store.DeleteSession(context.Background(), "")
	require.Error(t, err)
	require.NoError(t, store.DeleteSession(context.Background(), "missing"))
}

func TestDynamoStreamRecord_TableName_Default(t *testing.T) {
	t.Setenv(envStreamTableName, "")
	require.Equal(t, defaultDynamoStreamTableName, dynamoStreamRecord{}.TableName())
}

func TestDynamoStreamRecord_TableName_EnvOverride(t *testing.T) {
	t.Setenv(envStreamTableName, "custom-streams")
	require.Equal(t, "custom-streams", dynamoStreamRecord{}.TableName())
}

func TestStreamTTL_EnvOverride(t *testing.T) {
	t.Setenv(envStreamTTLMinutes, "7")
	require.Equal(t, 7*time.Minute, streamTTL())

	t.Setenv(envStreamTTLMinutes, "-1")
	require.Equal(t, time.Duration(defaultStreamTTLMinutes)*time.Minute, streamTTL())
}

func TestDynamoStreamRecord_TheoryDBTagsMatchCanonicalStreamTableSchema(t *testing.T) {
	tp := reflect.TypeOf(dynamoStreamRecord{})

	sessionID, ok := tp.FieldByName("SessionID")
	require.True(t, ok)
	require.Equal(t, "pk,attr:sessionId", sessionID.Tag.Get("theorydb"))

	eventID, ok := tp.FieldByName("EventID")
	require.True(t, ok)
	require.Equal(t, "sk,attr:eventId", eventID.Tag.Get("theorydb"))

	expiresAt, ok := tp.FieldByName("ExpiresAt")
	require.True(t, ok)
	require.Equal(t, "ttl,attr:expiresAt", expiresAt.Tag.Get("theorydb"))
}

func requireStreamEvent(t *testing.T, ch <-chan StreamEvent) StreamEvent {
	t.Helper()

	select {
	case ev, ok := <-ch:
		if !ok {
			t.Fatal("expected stream event, channel closed")
		}
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for stream event")
	}

	return StreamEvent{}
}

func requireStreamClosed(t *testing.T, ch <-chan StreamEvent) {
	t.Helper()

	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("expected stream to close")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for stream close")
	}
}

type fakeMCPTableDB struct {
	mu                      sync.Mutex
	session                 map[string]sessionRecord
	streams                 map[string]map[string]dynamoStreamRecord
	beforeCreateStreamEvent func(dynamoStreamRecord)
	afterMatchStreamRecords func(*fakeMCPTableQuery, []dynamoStreamRecord)
}

func newFakeMCPTableDB() *fakeMCPTableDB {
	return &fakeMCPTableDB{
		session: make(map[string]sessionRecord),
		streams: make(map[string]map[string]dynamoStreamRecord),
	}
}

func (db *fakeMCPTableDB) Model(model any) tablecore.Query {
	return &fakeMCPTableQuery{
		db:    db,
		model: model,
	}
}

func (db *fakeMCPTableDB) Transaction(fn func(*tablecore.Tx) error) error {
	if fn == nil {
		return nil
	}
	return fn(nil)
}

func (db *fakeMCPTableDB) Migrate() error { return nil }

func (db *fakeMCPTableDB) AutoMigrate(models ...any) error { return nil }

func (db *fakeMCPTableDB) Close() error { return nil }

func (db *fakeMCPTableDB) WithContext(ctx context.Context) tablecore.DB { return db }

func (db *fakeMCPTableDB) getStreamRecord(sessionID, eventID string) (dynamoStreamRecord, bool) {
	db.mu.Lock()
	defer db.mu.Unlock()

	session := db.streams[sessionID]
	if session == nil {
		return dynamoStreamRecord{}, false
	}

	record, ok := session[eventID]
	return record, ok
}

func (db *fakeMCPTableDB) sessionStreamRecords(sessionID string) []dynamoStreamRecord {
	db.mu.Lock()
	defer db.mu.Unlock()

	session := db.streams[sessionID]
	if session == nil {
		return nil
	}

	out := make([]dynamoStreamRecord, 0, len(session))
	for _, record := range session {
		out = append(out, record)
	}

	sort.Slice(out, func(i, j int) bool {
		return out[i].EventID < out[j].EventID
	})
	return out
}

func (db *fakeMCPTableDB) countNonSessionStreamRecords(sessionID string) int {
	records := db.sessionStreamRecords(sessionID)
	count := 0
	for _, record := range records {
		if record.EventID == dynamoStreamSessionStateEventID {
			continue
		}
		count++
	}
	return count
}

type fakeMCPTableQuery struct {
	db         *fakeMCPTableDB
	model      any
	where      []fakeWhereClause
	orderField string
	order      string
	limit      int
}

type fakeWhereClause struct {
	field string
	op    string
	value any
}

type fakeMCPUpdateBuilder struct {
	query       *fakeMCPTableQuery
	sets        []fakeMCPUpdateOp
	setDefaults []fakeMCPUpdateOp
	adds        []fakeMCPUpdateOp
	conditions  []fakeMCPUpdateCondition
}

type fakeMCPUpdateOp struct {
	field string
	value any
}

type fakeMCPUpdateCondition struct {
	field    string
	operator string
	value    any
	logic    string
}

func (q *fakeMCPTableQuery) Where(field string, op string, value any) tablecore.Query {
	q.where = append(q.where, fakeWhereClause{field: field, op: op, value: value})
	return q
}

func (q *fakeMCPTableQuery) Index(indexName string) tablecore.Query { return q }

func (q *fakeMCPTableQuery) Filter(field string, op string, value any) tablecore.Query { return q }

func (q *fakeMCPTableQuery) OrFilter(field string, op string, value any) tablecore.Query { return q }

func (q *fakeMCPTableQuery) FilterGroup(fn func(tablecore.Query)) tablecore.Query {
	if fn != nil {
		fn(q)
	}
	return q
}

func (q *fakeMCPTableQuery) OrFilterGroup(fn func(tablecore.Query)) tablecore.Query {
	if fn != nil {
		fn(q)
	}
	return q
}

func (q *fakeMCPTableQuery) IfNotExists() tablecore.Query { return q }

func (q *fakeMCPTableQuery) IfExists() tablecore.Query { return q }

func (q *fakeMCPTableQuery) WithCondition(field, operator string, value any) tablecore.Query {
	return q
}

func (q *fakeMCPTableQuery) WithConditionExpression(expr string, values map[string]any) tablecore.Query {
	return q
}

func (q *fakeMCPTableQuery) OrderBy(field string, order string) tablecore.Query {
	q.orderField = field
	q.order = order
	return q
}

func (q *fakeMCPTableQuery) Limit(limit int) tablecore.Query {
	q.limit = limit
	return q
}

func (q *fakeMCPTableQuery) Offset(offset int) tablecore.Query { return q }

func (q *fakeMCPTableQuery) Select(fields ...string) tablecore.Query { return q }

func (q *fakeMCPTableQuery) ConsistentRead() tablecore.Query { return q }

func (q *fakeMCPTableQuery) WithRetry(maxRetries int, initialDelay time.Duration) tablecore.Query {
	return q
}

func (b *fakeMCPUpdateBuilder) Set(field string, value any) tablecore.UpdateBuilder {
	b.sets = append(b.sets, fakeMCPUpdateOp{field: field, value: value})
	return b
}

func (b *fakeMCPUpdateBuilder) SetIfNotExists(field string, value any, defaultValue any) tablecore.UpdateBuilder {
	b.setDefaults = append(b.setDefaults, fakeMCPUpdateOp{field: field, value: defaultValue})
	return b
}

func (b *fakeMCPUpdateBuilder) Add(field string, value any) tablecore.UpdateBuilder {
	b.adds = append(b.adds, fakeMCPUpdateOp{field: field, value: value})
	return b
}

func (b *fakeMCPUpdateBuilder) Increment(field string) tablecore.UpdateBuilder {
	return b.Add(field, int64(1))
}

func (b *fakeMCPUpdateBuilder) Decrement(field string) tablecore.UpdateBuilder {
	return b.Add(field, int64(-1))
}

func (b *fakeMCPUpdateBuilder) Remove(field string) tablecore.UpdateBuilder { return b }

func (b *fakeMCPUpdateBuilder) Delete(field string, value any) tablecore.UpdateBuilder { return b }

func (b *fakeMCPUpdateBuilder) AppendToList(field string, values any) tablecore.UpdateBuilder {
	return b
}

func (b *fakeMCPUpdateBuilder) PrependToList(field string, values any) tablecore.UpdateBuilder {
	return b
}

func (b *fakeMCPUpdateBuilder) RemoveFromListAt(field string, index int) tablecore.UpdateBuilder {
	return b
}

func (b *fakeMCPUpdateBuilder) SetListElement(field string, index int, value any) tablecore.UpdateBuilder {
	return b
}

func (b *fakeMCPUpdateBuilder) Condition(field string, operator string, value any) tablecore.UpdateBuilder {
	b.conditions = append(b.conditions, fakeMCPUpdateCondition{
		field:    field,
		operator: operator,
		value:    value,
		logic:    "AND",
	})
	return b
}

func (b *fakeMCPUpdateBuilder) OrCondition(field string, operator string, value any) tablecore.UpdateBuilder {
	b.conditions = append(b.conditions, fakeMCPUpdateCondition{
		field:    field,
		operator: operator,
		value:    value,
		logic:    "OR",
	})
	return b
}

func (b *fakeMCPUpdateBuilder) ConditionExists(field string) tablecore.UpdateBuilder {
	return b.Condition(field, "attribute_exists", nil)
}

func (b *fakeMCPUpdateBuilder) ConditionNotExists(field string) tablecore.UpdateBuilder {
	return b.Condition(field, "attribute_not_exists", nil)
}

func (b *fakeMCPUpdateBuilder) ConditionVersion(currentVersion int64) tablecore.UpdateBuilder {
	return b.Condition("Version", "=", currentVersion)
}

func (b *fakeMCPUpdateBuilder) ReturnValues(option string) tablecore.UpdateBuilder { return b }

func (b *fakeMCPUpdateBuilder) Execute() error {
	return b.execute(nil)
}

func (b *fakeMCPUpdateBuilder) ExecuteWithResult(result any) error {
	return b.execute(result)
}

func (b *fakeMCPUpdateBuilder) execute(result any) error {
	if classifyMCPModel(b.query.model) != fakeMCPModelStream {
		return errors.New("unsupported model")
	}

	sessionID, ok := b.query.whereString("SessionID", "=")
	if !ok {
		return errors.New("missing session id")
	}
	eventID, ok := b.query.whereString("EventID", "=")
	if !ok {
		return errors.New("missing event id")
	}

	b.query.db.mu.Lock()
	defer b.query.db.mu.Unlock()

	session := b.query.db.streams[sessionID]
	existing, exists := dynamoStreamRecord{}, false
	if session != nil {
		existing, exists = session[eventID]
	}

	if !b.conditionsMet(existing, exists) {
		return tableerrors.ErrConditionFailed
	}

	updated := existing
	if !exists {
		updated.SessionID = sessionID
		updated.EventID = eventID
	}

	for _, op := range b.setDefaults {
		if fakeMCPStreamFieldExists(existing, exists, op.field) {
			continue
		}
		if err := fakeMCPSetStreamField(&updated, op.field, op.value); err != nil {
			return err
		}
	}

	for _, op := range b.adds {
		if err := fakeMCPAddStreamField(&updated, op.field, op.value); err != nil {
			return err
		}
	}

	for _, op := range b.sets {
		if err := fakeMCPSetStreamField(&updated, op.field, op.value); err != nil {
			return err
		}
	}

	if b.query.db.streams[sessionID] == nil {
		b.query.db.streams[sessionID] = make(map[string]dynamoStreamRecord)
	}
	b.query.db.streams[sessionID][eventID] = updated

	if result != nil {
		return assignStreamRecord(result, updated)
	}
	return nil
}

func (b *fakeMCPUpdateBuilder) conditionsMet(record dynamoStreamRecord, exists bool) bool {
	if len(b.conditions) == 0 {
		return true
	}

	result := false
	for i, condition := range b.conditions {
		matched := fakeMCPMatchStreamCondition(record, exists, condition)
		if i == 0 {
			result = matched
			continue
		}
		if condition.logic == "OR" {
			result = result || matched
			continue
		}
		result = result && matched
	}
	return result
}

func (q *fakeMCPTableQuery) First(dest any) error {
	switch classifyMCPModel(q.model) {
	case fakeMCPModelSession:
		record, ok := q.lookupSession()
		if !ok {
			return tableerrors.ErrItemNotFound
		}
		return assignSessionRecord(dest, record)
	case fakeMCPModelStream:
		records := q.matchStreamRecords()
		if len(records) == 0 {
			return tableerrors.ErrItemNotFound
		}
		return assignStreamRecord(dest, records[0])
	default:
		return errors.New("unsupported model")
	}
}

func (q *fakeMCPTableQuery) All(dest any) error {
	switch classifyMCPModel(q.model) {
	case fakeMCPModelStream:
		return assignStreamRecords(dest, q.matchStreamRecords())
	case fakeMCPModelSession:
		record, ok := q.lookupSession()
		if !ok {
			return assignSessionRecords(dest, nil)
		}
		return assignSessionRecords(dest, []sessionRecord{record})
	default:
		return errors.New("unsupported model")
	}
}

func (q *fakeMCPTableQuery) AllPaginated(dest any) (*tablecore.PaginatedResult, error) {
	return nil, errors.New("not implemented")
}

func (q *fakeMCPTableQuery) Count() (int64, error) {
	switch classifyMCPModel(q.model) {
	case fakeMCPModelStream:
		return int64(len(q.matchStreamRecords())), nil
	case fakeMCPModelSession:
		if _, ok := q.lookupSession(); ok {
			return 1, nil
		}
		return 0, nil
	default:
		return 0, errors.New("unsupported model")
	}
}

func (q *fakeMCPTableQuery) Create() error {
	switch classifyMCPModel(q.model) {
	case fakeMCPModelSession:
		record, ok := extractSessionRecord(q.model)
		if !ok {
			return errors.New("invalid session record")
		}
		q.db.mu.Lock()
		q.db.session[record.SessionID] = record
		q.db.mu.Unlock()
		return nil
	case fakeMCPModelStream:
		record, ok := extractStreamRecord(q.model)
		if !ok {
			return errors.New("invalid stream record")
		}
		if record.Kind == dynamoStreamRecordKindEvent && q.db.beforeCreateStreamEvent != nil {
			q.db.beforeCreateStreamEvent(record)
		}
		q.db.mu.Lock()
		if q.db.streams[record.SessionID] == nil {
			q.db.streams[record.SessionID] = make(map[string]dynamoStreamRecord)
		}
		q.db.streams[record.SessionID][record.EventID] = record
		q.db.mu.Unlock()
		return nil
	default:
		return errors.New("unsupported model")
	}
}

func (q *fakeMCPTableQuery) CreateOrUpdate() error {
	return q.Create()
}

func (q *fakeMCPTableQuery) Update(fields ...string) error {
	return errors.New("not implemented")
}

func (q *fakeMCPTableQuery) UpdateBuilder() tablecore.UpdateBuilder {
	return &fakeMCPUpdateBuilder{query: q}
}

func (q *fakeMCPTableQuery) Delete() error {
	switch classifyMCPModel(q.model) {
	case fakeMCPModelSession:
		sessionID, ok := q.whereString("SessionID", "=")
		if !ok {
			return errors.New("missing session id")
		}
		q.db.mu.Lock()
		delete(q.db.session, sessionID)
		q.db.mu.Unlock()
		return nil
	case fakeMCPModelStream:
		sessionID, ok := q.whereString("SessionID", "=")
		if !ok {
			return errors.New("missing session id")
		}
		eventID, ok := q.whereString("EventID", "=")
		if !ok {
			return errors.New("missing event id")
		}
		q.db.mu.Lock()
		if q.db.streams[sessionID] != nil {
			delete(q.db.streams[sessionID], eventID)
			if len(q.db.streams[sessionID]) == 0 {
				delete(q.db.streams, sessionID)
			}
		}
		q.db.mu.Unlock()
		return nil
	default:
		return errors.New("unsupported model")
	}
}

func (q *fakeMCPTableQuery) Scan(dest any) error { return errors.New("not implemented") }

func (q *fakeMCPTableQuery) ParallelScan(segment int32, totalSegments int32) tablecore.Query {
	return q
}

func (q *fakeMCPTableQuery) ScanAllSegments(dest any, totalSegments int32) error {
	return errors.New("not implemented")
}

func (q *fakeMCPTableQuery) BatchGet(keys []any, dest any) error {
	return errors.New("not implemented")
}

func (q *fakeMCPTableQuery) BatchGetWithOptions(keys []any, dest any, opts *tablecore.BatchGetOptions) error {
	return errors.New("not implemented")
}

func (q *fakeMCPTableQuery) BatchGetBuilder() tablecore.BatchGetBuilder { return nil }

func (q *fakeMCPTableQuery) BatchCreate(items any) error { return errors.New("not implemented") }

func (q *fakeMCPTableQuery) BatchDelete(keys []any) error { return errors.New("not implemented") }

func (q *fakeMCPTableQuery) Cursor(cursor string) tablecore.Query { return q }

func (q *fakeMCPTableQuery) SetCursor(cursor string) error { return nil }

func (q *fakeMCPTableQuery) WithContext(ctx context.Context) tablecore.Query { return q }

func (q *fakeMCPTableQuery) BatchWrite(putItems []any, deleteKeys []any) error {
	return errors.New("not implemented")
}

func (q *fakeMCPTableQuery) BatchUpdateWithOptions(items []any, fields []string, options ...any) error {
	return errors.New("not implemented")
}

func (q *fakeMCPTableQuery) lookupSession() (sessionRecord, bool) {
	sessionID, ok := q.whereString("SessionID", "=")
	if !ok {
		return sessionRecord{}, false
	}

	q.db.mu.Lock()
	defer q.db.mu.Unlock()

	record, ok := q.db.session[sessionID]
	return record, ok
}

func (q *fakeMCPTableQuery) matchStreamRecords() []dynamoStreamRecord {
	sessionID, ok := q.whereString("SessionID", "=")
	if !ok {
		return nil
	}

	q.db.mu.Lock()
	session := q.db.streams[sessionID]
	if session == nil {
		q.db.mu.Unlock()
		return nil
	}

	out := make([]dynamoStreamRecord, 0, len(session))
	for _, record := range session {
		if q.matchesStreamRecord(record) {
			out = append(out, record)
		}
	}
	q.db.mu.Unlock()

	sort.Slice(out, func(i, j int) bool {
		if q.orderField != "EventID" {
			return out[i].EventID < out[j].EventID
		}
		if strings.EqualFold(q.order, "DESC") {
			return out[i].EventID > out[j].EventID
		}
		return out[i].EventID < out[j].EventID
	})

	if q.limit > 0 && len(out) > q.limit {
		out = out[:q.limit]
	}

	if hook := q.db.afterMatchStreamRecords; hook != nil {
		records := append([]dynamoStreamRecord(nil), out...)
		hook(q, records)
	}

	return out
}

func (q *fakeMCPTableQuery) matchesStreamRecord(record dynamoStreamRecord) bool {
	for _, clause := range q.where {
		want, ok := clause.value.(string)
		if !ok {
			return false
		}

		switch clause.field {
		case "SessionID":
			if !compareString(record.SessionID, clause.op, want) {
				return false
			}
		case "EventID":
			if !compareString(record.EventID, clause.op, want) {
				return false
			}
		default:
			return false
		}
	}

	return true
}

func (q *fakeMCPTableQuery) whereString(field, op string) (string, bool) {
	for _, clause := range q.where {
		if clause.field == field && clause.op == op {
			value, ok := clause.value.(string)
			return value, ok
		}
	}
	return "", false
}

func fakeMCPMatchStreamCondition(record dynamoStreamRecord, exists bool, condition fakeMCPUpdateCondition) bool {
	switch condition.operator {
	case "attribute_exists":
		return fakeMCPStreamFieldExists(record, exists, condition.field)
	case "attribute_not_exists":
		return !fakeMCPStreamFieldExists(record, exists, condition.field)
	case "=":
		value, ok := fakeMCPStreamFieldValue(record, exists, condition.field)
		if !ok {
			return false
		}
		return reflect.DeepEqual(value, condition.value)
	default:
		return false
	}
}

func fakeMCPStreamFieldExists(record dynamoStreamRecord, exists bool, field string) bool {
	if !exists {
		return false
	}

	switch field {
	case "SessionID", "EventID":
		return true
	case "StreamID":
		return record.StreamID != ""
	case "Kind":
		return record.Kind != ""
	case "CreatedAt":
		return !record.CreatedAt.IsZero()
	case "ExpiresAt":
		return record.ExpiresAt != 0
	case "NextSeq":
		return record.Kind == dynamoStreamRecordKindSession
	case "Closed":
		return record.Kind == dynamoStreamRecordKindStream
	case "Deleted":
		return record.Kind == dynamoStreamRecordKindSession
	case "Data":
		return len(record.Data) > 0
	default:
		return false
	}
}

func fakeMCPStreamFieldValue(record dynamoStreamRecord, exists bool, field string) (any, bool) {
	if !fakeMCPStreamFieldExists(record, exists, field) {
		return nil, false
	}

	switch field {
	case "SessionID":
		return record.SessionID, true
	case "EventID":
		return record.EventID, true
	case "StreamID":
		return record.StreamID, true
	case "Kind":
		return record.Kind, true
	case "CreatedAt":
		return record.CreatedAt, true
	case "ExpiresAt":
		return record.ExpiresAt, true
	case "NextSeq":
		return record.NextSeq, true
	case "Closed":
		return record.Closed, true
	case "Deleted":
		return record.Deleted, true
	case "Data":
		return record.Data, true
	default:
		return nil, false
	}
}

func fakeMCPSetStreamField(record *dynamoStreamRecord, field string, value any) error {
	if record == nil {
		return errors.New("missing record")
	}

	switch field {
	case "SessionID":
		v, ok := value.(string)
		if !ok {
			return errors.New("expected SessionID to be a string")
		}
		record.SessionID = v
	case "EventID":
		v, ok := value.(string)
		if !ok {
			return errors.New("expected EventID to be a string")
		}
		record.EventID = v
	case "StreamID":
		v, ok := value.(string)
		if !ok {
			return errors.New("expected StreamID to be a string")
		}
		record.StreamID = v
	case "Kind":
		v, ok := value.(string)
		if !ok {
			return errors.New("expected Kind to be a string")
		}
		record.Kind = v
	case "CreatedAt":
		v, ok := value.(time.Time)
		if !ok {
			return errors.New("expected CreatedAt to be a time")
		}
		record.CreatedAt = v
	case "ExpiresAt":
		v, ok := fakeMCPInt64(value)
		if !ok {
			return errors.New("expected ExpiresAt to be numeric")
		}
		record.ExpiresAt = v
	case "NextSeq":
		v, ok := fakeMCPInt64(value)
		if !ok {
			return errors.New("expected NextSeq to be numeric")
		}
		record.NextSeq = v
	case "Closed":
		v, ok := value.(bool)
		if !ok {
			return errors.New("expected Closed to be a bool")
		}
		record.Closed = v
	case "Deleted":
		v, ok := value.(bool)
		if !ok {
			return errors.New("expected Deleted to be a bool")
		}
		record.Deleted = v
	case "Data":
		v, ok := value.(json.RawMessage)
		if !ok {
			return errors.New("expected Data to be json.RawMessage")
		}
		record.Data = append(record.Data[:0], v...)
	default:
		return errors.New("unsupported stream field")
	}
	return nil
}

func fakeMCPAddStreamField(record *dynamoStreamRecord, field string, value any) error {
	delta, ok := fakeMCPInt64(value)
	if !ok {
		return errors.New("expected numeric delta")
	}

	switch field {
	case "NextSeq":
		record.NextSeq += delta
	default:
		return errors.New("unsupported add field")
	}
	return nil
}

func fakeMCPInt64(value any) (int64, bool) {
	switch v := value.(type) {
	case int:
		return int64(v), true
	case int8:
		return int64(v), true
	case int16:
		return int64(v), true
	case int32:
		return int64(v), true
	case int64:
		return v, true
	default:
		return 0, false
	}
}

func compareString(got, op, want string) bool {
	switch op {
	case "=":
		return got == want
	case ">":
		return got > want
	case ">=":
		return got >= want
	case "<":
		return got < want
	case "<=":
		return got <= want
	default:
		return false
	}
}

type fakeMCPModel int

const (
	fakeMCPModelUnknown fakeMCPModel = iota
	fakeMCPModelSession
	fakeMCPModelStream
)

func classifyMCPModel(model any) fakeMCPModel {
	switch model.(type) {
	case sessionRecord, *sessionRecord:
		return fakeMCPModelSession
	case dynamoStreamRecord, *dynamoStreamRecord:
		return fakeMCPModelStream
	default:
		return fakeMCPModelUnknown
	}
}

func extractSessionRecord(model any) (sessionRecord, bool) {
	switch v := model.(type) {
	case sessionRecord:
		return v, true
	case *sessionRecord:
		if v == nil {
			return sessionRecord{}, false
		}
		return *v, true
	default:
		return sessionRecord{}, false
	}
}

func extractStreamRecord(model any) (dynamoStreamRecord, bool) {
	switch v := model.(type) {
	case dynamoStreamRecord:
		return v, true
	case *dynamoStreamRecord:
		if v == nil {
			return dynamoStreamRecord{}, false
		}
		return *v, true
	default:
		return dynamoStreamRecord{}, false
	}
}

func assignSessionRecord(dest any, record sessionRecord) error {
	out, ok := dest.(*sessionRecord)
	if !ok {
		return errors.New("expected *sessionRecord")
	}
	*out = record
	return nil
}

func assignSessionRecords(dest any, records []sessionRecord) error {
	out, ok := dest.(*[]sessionRecord)
	if !ok {
		return errors.New("expected *[]sessionRecord")
	}
	*out = append((*out)[:0], records...)
	return nil
}

func assignStreamRecord(dest any, record dynamoStreamRecord) error {
	out, ok := dest.(*dynamoStreamRecord)
	if !ok {
		return errors.New("expected *dynamoStreamRecord")
	}
	*out = record
	return nil
}

func assignStreamRecords(dest any, records []dynamoStreamRecord) error {
	out, ok := dest.(*[]dynamoStreamRecord)
	if !ok {
		return errors.New("expected *[]dynamoStreamRecord")
	}
	*out = append((*out)[:0], records...)
	return nil
}
