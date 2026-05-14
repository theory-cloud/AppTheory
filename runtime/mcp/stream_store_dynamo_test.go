package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/stretchr/testify/require"
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

	_, err = store.Subscribe(context.Background(), "sess-1", streamA, eventB1)
	require.ErrorIs(t, err, ErrEventNotFound)
}

func TestDynamoStreamStore_DeleteSessionRejectsLateAppend(t *testing.T) {
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
	require.ErrorIs(t, appendErr, ErrStreamNotFound)
	require.Empty(t, eventID)

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

	_, err = store.StreamForEvent(context.Background(), "sess-1", dynamoStreamEventIDForSeq(1))
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
			defer close(toolDone)
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
	headers["accept"] = []string{"application/json, text/event-stream"}

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

	primingFrame, err := readSSEFrame(reader)
	require.NoError(t, err)
	requirePrimingSSEFrame(t, primingFrame)

	firstFrame, err := readSSEFrame(reader)
	require.NoError(t, err)
	require.Contains(t, firstFrame, `"method":"notifications/progress"`)
	require.Contains(t, firstFrame, `"progress":1`)

	lastID := sseFrameID(t, firstFrame)

	cancel()

	close(continueTool)

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

func TestHandleToolsCallStream_OversizeFinalResponseEmitsStableError(t *testing.T) {
	db := newFakeMCPTableDB()
	sessionStore := NewDynamoSessionStore(db)
	streamStore, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)
	streamStore.maxEventBytes = 192
	streamStore.pollInterval = time.Millisecond

	s := NewServer("test-server", "1.0.0", WithSessionStore(sessionStore), WithStreamStore(streamStore))
	err := s.Registry().RegisterStreamingTool(
		ToolDef{
			Name:        "large_tool",
			Description: "Returns a payload larger than the stream event limit.",
			InputSchema: json.RawMessage(`{"type":"object"}`),
		},
		func(context.Context, json.RawMessage, func(SSEEvent)) (*ToolResult, error) {
			return &ToolResult{Content: []ContentBlock{{Type: "text", Text: strings.Repeat("x", 256)}}}, nil
		},
	)
	require.NoError(t, err)

	sessionID := initializeSession(t, s)
	params := toolsCallParams{Name: "large_tool", Arguments: json.RawMessage(`{}`)}
	body := mustMarshal(t, Request{JSONRPC: "2.0", ID: 7, Method: methodToolsCall, Params: mustMarshal(t, params)})

	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"application/json, text/event-stream"}

	resp, err := invokeHandlerWithMethod(context.Background(), s, "POST", body, headers)
	require.NoError(t, err)
	require.NotNil(t, resp.BodyReader)

	b, err := io.ReadAll(resp.BodyReader)
	require.NoError(t, err)
	all := string(b)
	require.Contains(t, all, `"error"`)
	require.Contains(t, all, `"stream event too large"`)
	require.NotContains(t, all, strings.Repeat("x", 128))
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

func TestDynamoStreamStore_SpillsLargeEventsToS3AndRehydrates(t *testing.T) {
	db := newFakeMCPTableDB()
	spill := newFakeDynamoStreamSpillStore()
	store1, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)
	store2, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)
	store1.spillStore = spill
	store2.spillStore = spill
	store1.inlineMaxBytes = 8
	store2.inlineMaxBytes = 8
	store1.idGen = staticIDGenerator{id: "stream-1"}

	streamID, err := store1.Create(context.Background(), "sess-1")
	require.NoError(t, err)

	payload := json.RawMessage(`{"large":"payload"}`)
	eventID, err := store1.Append(context.Background(), "sess-1", streamID, payload)
	require.NoError(t, err)

	record, ok := db.getStreamRecord("sess-1", eventID)
	require.True(t, ok)
	require.Empty(t, record.Data)
	require.Equal(t, dynamoStreamDataStorageS3, record.DataStorage)
	require.NotEmpty(t, record.DataRef)
	require.Equal(t, int64(len(payload)), record.DataBytes)
	require.Equal(t, dynamoStreamPayloadSHA256(payload), record.DataSHA256)
	require.Equal(t, []byte(payload), spill.mustGet(t, record.DataRef))

	ch, err := store2.Subscribe(context.Background(), "sess-1", streamID, "")
	require.NoError(t, err)
	ev := requireStreamEvent(t, ch)
	require.Equal(t, eventID, ev.ID)
	require.JSONEq(t, string(payload), string(ev.Data))

	require.NoError(t, store1.Close(context.Background(), "sess-1", streamID))
	requireStreamClosed(t, ch)
}

func TestDynamoStreamStore_SubscribeSkipsExpiredInlineEvents(t *testing.T) {
	db := newFakeMCPTableDB()
	store, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)

	now := time.Date(2026, 5, 12, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	store.idGen = staticIDGenerator{id: "stream-1"}
	store.pollInterval = time.Millisecond

	streamID, err := store.Create(context.Background(), "sess-1")
	require.NoError(t, err)
	eventID, err := store.Append(context.Background(), "sess-1", streamID, json.RawMessage(`{"seq":1}`))
	require.NoError(t, err)
	expireStreamRecord(t, db, "sess-1", eventID, now.Add(-time.Second).Unix())
	require.NoError(t, store.Close(context.Background(), "sess-1", streamID))

	_, err = store.StreamForEvent(context.Background(), "sess-1", eventID)
	require.ErrorIs(t, err, ErrEventNotFound)

	ch, err := store.Subscribe(context.Background(), "sess-1", streamID, "")
	require.NoError(t, err)
	requireStreamClosed(t, ch)
}

func TestDynamoStreamStore_SubscribeSkipsExpiredSpilledEventsWithoutRehydrate(t *testing.T) {
	db := newFakeMCPTableDB()
	spill := newFakeDynamoStreamSpillStore()
	store, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)
	store.spillStore = spill
	store.inlineMaxBytes = 1
	store.pollInterval = time.Millisecond

	now := time.Date(2026, 5, 12, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }

	streamID, err := store.Create(context.Background(), "sess-1")
	require.NoError(t, err)
	eventID, err := store.Append(context.Background(), "sess-1", streamID, json.RawMessage(`{"seq":1}`))
	require.NoError(t, err)

	record, ok := db.getStreamRecord("sess-1", eventID)
	require.True(t, ok)
	require.NotEmpty(t, record.DataRef)
	require.True(t, spill.exists(record.DataRef))

	expireStreamRecord(t, db, "sess-1", eventID, now.Add(-time.Second).Unix())
	require.NoError(t, store.Close(context.Background(), "sess-1", streamID))

	_, err = store.StreamForEvent(context.Background(), "sess-1", eventID)
	require.ErrorIs(t, err, ErrEventNotFound)

	ch, err := store.Subscribe(context.Background(), "sess-1", streamID, "")
	require.NoError(t, err)
	requireStreamClosed(t, ch)
	require.Zero(t, spill.getCount())
}

func TestDynamoStreamStore_DeleteSessionDeletesSpilledObjects(t *testing.T) {
	db := newFakeMCPTableDB()
	spill := newFakeDynamoStreamSpillStore()
	store, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)
	store.spillStore = spill
	store.inlineMaxBytes = 1

	streamID, err := store.Create(context.Background(), "sess-1")
	require.NoError(t, err)
	eventID, err := store.Append(context.Background(), "sess-1", streamID, json.RawMessage(`{"seq":1}`))
	require.NoError(t, err)

	record, ok := db.getStreamRecord("sess-1", eventID)
	require.True(t, ok)
	require.NotEmpty(t, record.DataRef)
	require.True(t, spill.exists(record.DataRef))

	require.NoError(t, store.DeleteSession(context.Background(), "sess-1"))
	require.False(t, spill.exists(record.DataRef))
}

func TestDynamoStreamStore_DeleteSessionRejectsInFlightSpilledAppend(t *testing.T) {
	db := newFakeMCPTableDB()
	spill := newFakeDynamoStreamSpillStore()
	store, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)
	store.spillStore = spill
	store.inlineMaxBytes = 1
	store.pollInterval = time.Millisecond

	streamID, err := store.Create(context.Background(), "sess-1")
	require.NoError(t, err)

	putEntered := make(chan struct{})
	releasePut := make(chan struct{})
	spill.beforePut = func(_ string) {
		select {
		case <-putEntered:
		default:
			close(putEntered)
		}
		<-releasePut
	}

	appendDone := make(chan struct{})
	var appendErr error
	go func() {
		defer close(appendDone)
		_, appendErr = store.Append(context.Background(), "sess-1", streamID, json.RawMessage(`{"seq":1}`))
	}()

	select {
	case <-putEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for append to reach spill put")
	}

	deleteDone := make(chan error, 1)
	go func() {
		deleteDone <- store.DeleteSession(context.Background(), "sess-1")
	}()

	select {
	case deleteErr := <-deleteDone:
		require.NoError(t, deleteErr)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for DeleteSession")
	}

	close(releasePut)

	select {
	case <-appendDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for append to finish")
	}
	require.ErrorIs(t, appendErr, ErrStreamNotFound)
	require.Zero(t, spill.count())
	require.Zero(t, db.countNonSessionStreamRecords("sess-1"))

	records := db.sessionStreamRecords("sess-1")
	require.Len(t, records, 1)
	require.Equal(t, dynamoStreamSessionStateEventID, records[0].EventID)
	require.True(t, records[0].Deleted)
}

func TestDynamoStreamStore_OversizeEventFailsBeforeAppend(t *testing.T) {
	db := newFakeMCPTableDB()
	store, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)
	store.maxEventBytes = 8

	streamID, err := store.Create(context.Background(), "sess-1")
	require.NoError(t, err)

	_, err = store.Append(context.Background(), "sess-1", streamID, json.RawMessage(`{"too":"large"}`))
	require.ErrorIs(t, err, ErrStreamEventTooLarge)

	records := db.sessionStreamRecords("sess-1")
	require.Len(t, records, 2)
	for _, record := range records {
		require.NotEqual(t, dynamoStreamRecordKindEvent, record.Kind)
	}
	state, ok := db.getStreamRecord("sess-1", dynamoStreamSessionStateEventID)
	require.True(t, ok)
	require.Zero(t, state.NextSeq)
}

func TestDynamoStreamStore_InlineSpillThresholdClampsToSafeDynamoSize(t *testing.T) {
	t.Setenv(envStreamSpillInlineMaxBytes, strconv.Itoa(defaultDynamoStreamMaxInlineBytes+1))

	db := newFakeMCPTableDB()
	spill := newFakeDynamoStreamSpillStore()
	store, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)
	store.spillStore = spill
	require.Equal(t, defaultDynamoStreamMaxInlineBytes, store.inlineMaxBytes)

	streamID, err := store.Create(context.Background(), "sess-1")
	require.NoError(t, err)

	payload := json.RawMessage(strings.Repeat("x", defaultDynamoStreamMaxInlineBytes+1))
	eventID, err := store.Append(context.Background(), "sess-1", streamID, payload)
	require.NoError(t, err)

	record, ok := db.getStreamRecord("sess-1", eventID)
	require.True(t, ok)
	require.Empty(t, record.Data)
	require.NotEmpty(t, record.DataRef)
	require.Equal(t, dynamoStreamDataStorageS3, record.DataStorage)
	require.Equal(t, 1, spill.count())
}

func TestDynamoStreamS3SpillStore_RetriesClientInitAfterCanceledContext(t *testing.T) {
	attempts := 0
	store := &dynamoStreamS3SpillStore{
		bucket: "bucket",
		loadClient: func(ctx context.Context) (dynamoStreamS3Client, error) {
			attempts++
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			return fakeDynamoStreamS3Client{}, nil
		},
	}

	canceled, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := store.s3Client(canceled)
	require.ErrorIs(t, err, context.Canceled)
	require.Nil(t, store.client)

	client, err := store.s3Client(context.Background())
	require.NoError(t, err)
	require.NotNil(t, client)
	require.NotNil(t, store.client)
	require.Equal(t, 2, attempts)
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

	dataRef, ok := tp.FieldByName("DataRef")
	require.True(t, ok)
	require.Equal(t, "attr:dataRef,omitempty", dataRef.Tag.Get("theorydb"))

	dataStorage, ok := tp.FieldByName("DataStorage")
	require.True(t, ok)
	require.Equal(t, "attr:dataStorage,omitempty", dataStorage.Tag.Get("theorydb"))
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

func TestDynamoStreamStore_HelperErrorBranches(t *testing.T) {
	db := newFakeMCPTableDB()
	store, ok := NewDynamoStreamStore(db).(*DynamoStreamStore)
	require.True(t, ok)

	_, err := store.Create(context.Background(), " ")
	require.ErrorContains(t, err, "missing session id")

	store.idGen = staticIDGenerator{id: " "}
	_, err = store.Create(context.Background(), "sess-empty-id")
	require.ErrorContains(t, err, "missing stream id")

	_, _, _, err = store.appendTarget(context.Background(), " ", "stream-1")
	require.ErrorContains(t, err, "missing session id")
	_, _, _, err = store.appendTarget(context.Background(), "sess-1", " ")
	require.ErrorContains(t, err, "missing stream id")

	store.maxEventBytes = 1
	require.ErrorIs(t, store.preflightStreamPayloadSize(json.RawMessage(`{}`)), ErrStreamEventTooLarge)
	store.maxEventBytes = 0
	store.spillStore = nil
	require.ErrorIs(t, store.preflightStreamPayloadSize(json.RawMessage(strings.Repeat("x", defaultDynamoStreamMaxInlineBytes+1))), ErrStreamEventTooLarge)

	store.batchSize = 0
	require.Equal(t, defaultDynamoStreamBatchSize, store.queryBatchSize())
	store.batchSize = 3
	require.Equal(t, 3, store.queryBatchSize())
	store.pollInterval = 0
	require.Equal(t, defaultDynamoStreamPollInterval, store.effectivePollInterval())
	store.pollInterval = time.Millisecond
	require.Equal(t, time.Millisecond, store.effectivePollInterval())
	require.NotNil(t, normalizeStreamContext(context.TODO()))
}

func TestDynamoStreamStore_StreamRecordDataValidationBranches(t *testing.T) {
	store, ok := NewDynamoStreamStore(newFakeMCPTableDB()).(*DynamoStreamStore)
	require.True(t, ok)
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }

	_, err := store.streamRecordData(context.Background(), dynamoStreamRecord{ExpiresAt: now.Add(-time.Second).Unix()})
	require.ErrorIs(t, err, ErrEventNotFound)
	require.False(t, store.streamRecordExpired(dynamoStreamRecord{}, now))
	require.True(t, store.streamRecordExpired(dynamoStreamRecord{ExpiresAt: now.Unix()}, now))

	store.spillStore = nil
	_, err = store.streamRecordData(context.Background(), dynamoStreamRecord{DataStorage: dynamoStreamDataStorageS3, DataRef: "missing"})
	require.ErrorContains(t, err, "not configured")

	spill := newFakeDynamoStreamSpillStore()
	store.spillStore = spill
	require.NoError(t, spill.put(context.Background(), "key", []byte(`{"ok":true}`), 0, dynamoStreamPayloadSHA256([]byte(`{"ok":true}`))))
	_, err = store.streamRecordData(context.Background(), dynamoStreamRecord{DataRef: "key", DataBytes: 1})
	require.ErrorContains(t, err, "exceeds max event bytes")
	_, err = store.streamRecordData(context.Background(), dynamoStreamRecord{DataRef: "key", DataBytes: int64(len(`{"ok":true}`) + 1)})
	require.ErrorContains(t, err, "size mismatch")
	_, err = store.streamRecordData(context.Background(), dynamoStreamRecord{DataRef: "key", DataBytes: int64(len(`{"ok":true}`)), DataSHA256: "bad"})
	require.ErrorContains(t, err, "hash mismatch")

	got, err := store.streamRecordData(context.Background(), dynamoStreamRecord{Data: json.RawMessage(`{"inline":true}`)})
	require.NoError(t, err)
	require.JSONEq(t, `{"inline":true}`, string(got))
}

func TestDynamoStreamStore_SpillStreamDataS3BranchAndWaitCancel(t *testing.T) {
	client := &recordingDynamoStreamS3Client{}
	store, ok := NewDynamoStreamStore(newFakeMCPTableDB()).(*DynamoStreamStore)
	require.True(t, ok)
	store.spillStore = &dynamoStreamS3SpillStore{
		bucket: "bucket-a",
		prefix: "prefix-a",
		loadClient: func(context.Context) (dynamoStreamS3Client, error) {
			return client, nil
		},
	}

	ref, err := store.spillStreamData(context.Background(), "sess-1", "event-1", []byte(`{"ok":true}`), 123, dynamoStreamPayloadSHA256([]byte(`{"ok":true}`)))
	require.NoError(t, err)
	require.Contains(t, ref, "prefix-a/sessions/")
	require.Equal(t, ref, aws.ToString(client.putInput.Key))

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	require.ErrorIs(t, store.waitForPoll(ctx), context.Canceled)
}
