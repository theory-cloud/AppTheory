package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"sync"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
)

// StreamEvent is a single server->client JSON-RPC message framed as an SSE event.
//
// ID is the SSE event id (used for resumability via Last-Event-ID).
// Data is the raw JSON payload (a single JSON-RPC message).
type StreamEvent struct {
	ID   string
	Data json.RawMessage
}

// StreamStore persists stream events so a disconnected client can replay them
// via GET + Last-Event-ID.
type StreamStore interface {
	Create(ctx context.Context, sessionID string) (streamID string, err error)
	Append(ctx context.Context, sessionID, streamID string, data json.RawMessage) (eventID string, err error)
	Close(ctx context.Context, sessionID, streamID string) error

	// Subscribe streams events after afterEventID. If afterEventID is empty,
	// it streams from the beginning. If afterEventID is present, it must belong
	// to the requested stream.
	//
	// The returned channel is the store's subscription lifetime. An
	// implementation MUST close it when ctx is done, and MUST NOT leave a
	// producer goroutine writing to it after that close: a streamed MCP body
	// waits for the channel to close before the invocation that opened the
	// subscription returns, so a subscription that ignores ctx is abandoned work
	// in a frozen Lambda environment instead of a closed stream. A store that
	// keeps the channel open past ctx does not leak a goroutine of its own, but
	// it does hold the invocation open until the function timeout.
	Subscribe(ctx context.Context, sessionID, streamID, afterEventID string) (<-chan StreamEvent, error)

	// StreamForEvent returns the stream id that the given event id belongs to.
	StreamForEvent(ctx context.Context, sessionID, eventID string) (streamID string, err error)

	// DeleteSession removes all stream state for a session.
	DeleteSession(ctx context.Context, sessionID string) error
}

var (
	ErrStreamNotFound      = errors.New("stream not found")
	ErrEventNotFound       = errors.New("event not found")
	ErrStreamEventTooLarge = errors.New("stream event too large")
)

const (
	defaultMemoryStreamMaxEventBytes       = 10 << 20
	defaultMemoryStreamMaxEventsPerSession = 10000
	defaultMemoryStreamMaxSessionBytes     = 64 << 20
)

type MemoryStreamStoreOption func(*MemoryStreamStore)

func WithStreamIDGenerator(gen apptheory.IDGenerator) MemoryStreamStoreOption {
	return func(m *MemoryStreamStore) {
		m.idGen = gen
	}
}

func WithStreamEventByteLimit(maxBytes int) MemoryStreamStoreOption {
	return func(m *MemoryStreamStore) {
		if maxBytes > 0 {
			m.maxEventBytes = maxBytes
		}
	}
}

func WithStreamEventsPerSessionLimit(maxEvents int) MemoryStreamStoreOption {
	return func(m *MemoryStreamStore) {
		if maxEvents > 0 {
			m.maxEventsPerSession = maxEvents
		}
	}
}

func WithStreamSessionByteLimit(maxBytes int) MemoryStreamStoreOption {
	return func(m *MemoryStreamStore) {
		if maxBytes > 0 {
			m.maxBytesPerSession = maxBytes
		}
	}
}

// MemoryStreamStore is an in-memory StreamStore for testing and local development.
//
// It assigns monotonically increasing numeric event IDs per session (as strings).
type MemoryStreamStore struct {
	mu                  sync.Mutex
	idGen               apptheory.IDGenerator
	sessions            map[string]*memoryStreamSession
	maxEventBytes       int
	maxEventsPerSession int
	maxBytesPerSession  int
}

type memoryStreamSession struct {
	nextSeq     int64
	eventCount  int
	totalBytes  int
	seqToStream map[int64]string
	streams     map[string]*memoryStream
}

type memoryStream struct {
	events []memoryStreamEvent
	closed bool
	cond   *sync.Cond
}

type memoryStreamEvent struct {
	seq  int64
	data json.RawMessage
}

func NewMemoryStreamStore(opts ...MemoryStreamStoreOption) *MemoryStreamStore {
	m := &MemoryStreamStore{
		idGen:               apptheory.RandomIDGenerator{},
		sessions:            make(map[string]*memoryStreamSession),
		maxEventBytes:       defaultMemoryStreamMaxEventBytes,
		maxEventsPerSession: defaultMemoryStreamMaxEventsPerSession,
		maxBytesPerSession:  defaultMemoryStreamMaxSessionBytes,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(m)
		}
	}
	return m
}

func (m *MemoryStreamStore) Create(_ context.Context, sessionID string) (string, error) {
	if sessionID == "" {
		return "", errors.New("missing session id")
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	sess := m.sessions[sessionID]
	if sess == nil {
		sess = &memoryStreamSession{
			nextSeq:     0,
			seqToStream: make(map[int64]string),
			streams:     make(map[string]*memoryStream),
		}
		m.sessions[sessionID] = sess
	}

	streamID := m.idGen.NewID()
	stream := &memoryStream{
		events: nil,
		closed: false,
	}
	stream.cond = sync.NewCond(&m.mu)
	sess.streams[streamID] = stream

	return streamID, nil
}

func (m *MemoryStreamStore) Append(_ context.Context, sessionID, streamID string, data json.RawMessage) (string, error) {
	if sessionID == "" {
		return "", errors.New("missing session id")
	}
	if streamID == "" {
		return "", errors.New("missing stream id")
	}
	if m.maxEventBytes > 0 && len(data) > m.maxEventBytes {
		return "", ErrStreamEventTooLarge
	}
	if m.maxBytesPerSession > 0 && len(data) > m.maxBytesPerSession {
		return "", ErrStreamEventTooLarge
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	sess := m.sessions[sessionID]
	if sess == nil {
		return "", ErrStreamNotFound
	}
	stream := sess.streams[streamID]
	if stream == nil {
		return "", ErrStreamNotFound
	}

	for m.maxBytesPerSession > 0 && sess.totalBytes+len(data) > m.maxBytesPerSession {
		if !evictOldestMemoryStreamEventLocked(sess) {
			return "", ErrStreamEventTooLarge
		}
	}
	for m.maxEventsPerSession > 0 && sess.eventCount >= m.maxEventsPerSession {
		if !evictOldestMemoryStreamEventLocked(sess) {
			return "", ErrStreamEventTooLarge
		}
	}

	sess.nextSeq++
	seq := sess.nextSeq

	stored := make([]byte, len(data))
	copy(stored, data)

	stream.events = append(stream.events, memoryStreamEvent{
		seq:  seq,
		data: stored,
	})
	sess.seqToStream[seq] = streamID
	sess.eventCount++
	sess.totalBytes += len(stored)
	stream.cond.Broadcast()

	return strconv.FormatInt(seq, 10), nil
}

func evictOldestMemoryStreamEventLocked(sess *memoryStreamSession) bool {
	var oldest *memoryStream
	for _, stream := range sess.streams {
		if len(stream.events) == 0 {
			continue
		}
		if oldest == nil || stream.events[0].seq < oldest.events[0].seq {
			oldest = stream
		}
	}
	if oldest == nil {
		return false
	}

	event := oldest.events[0]
	oldest.events[0] = memoryStreamEvent{}
	oldest.events = oldest.events[1:]
	delete(sess.seqToStream, event.seq)
	sess.eventCount--
	sess.totalBytes -= len(event.data)
	return true
}

func (m *MemoryStreamStore) Close(_ context.Context, sessionID, streamID string) error {
	if sessionID == "" {
		return errors.New("missing session id")
	}
	if streamID == "" {
		return errors.New("missing stream id")
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	sess := m.sessions[sessionID]
	if sess == nil {
		return ErrStreamNotFound
	}
	stream := sess.streams[streamID]
	if stream == nil {
		return ErrStreamNotFound
	}

	stream.closed = true
	stream.cond.Broadcast()
	return nil
}

func (m *MemoryStreamStore) Subscribe(ctx context.Context, sessionID, streamID, afterEventID string) (<-chan StreamEvent, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if sessionID == "" {
		return nil, errors.New("missing session id")
	}
	if streamID == "" {
		return nil, errors.New("missing stream id")
	}

	afterSeq, err := afterSeqFromEventID(afterEventID)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	sess := m.sessions[sessionID]
	if sess == nil {
		m.mu.Unlock()
		return nil, ErrStreamNotFound
	}
	stream := sess.streams[streamID]
	if stream == nil {
		m.mu.Unlock()
		return nil, ErrStreamNotFound
	}
	if afterSeq > 0 {
		eventStreamID, ok := sess.seqToStream[afterSeq]
		if !ok || eventStreamID != streamID {
			m.mu.Unlock()
			return nil, ErrEventNotFound
		}
	}

	nextSeq := afterSeq
	m.mu.Unlock()

	out := make(chan StreamEvent)
	go m.pumpSubscription(ctx, stream, nextSeq, out)

	return out, nil
}

func afterSeqFromEventID(afterEventID string) (int64, error) {
	if afterEventID == "" {
		return 0, nil
	}
	seq, err := strconv.ParseInt(afterEventID, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid last-event-id: %w", err)
	}
	if seq > 0 {
		return seq, nil
	}
	return 0, nil
}

func (m *MemoryStreamStore) pumpSubscription(ctx context.Context, stream *memoryStream, afterSeq int64, out chan<- StreamEvent) {
	defer close(out)

	done := ctx.Done()
	stopBroadcast := make(chan struct{})
	waitBroadcast := m.broadcastOnDone(done, stopBroadcast, stream)
	// Declared after close(out) so it runs before the pump reports completion:
	// the watcher goroutine is part of the pump and must exit with it.
	defer waitBroadcast()
	defer close(stopBroadcast)

	nextSeq := afterSeq
	for {
		ev, ok := m.waitNextSubscriptionEvent(ctx, stream, &nextSeq)
		if !ok {
			return
		}

		select {
		case <-done:
			return
		case out <- ev:
		}
	}
}

// broadcastOnDone wakes the subscription condition variable when the
// subscription context is done. The returned function waits for the watcher, so
// the pump cannot return while a goroutine it started is still running.
func (m *MemoryStreamStore) broadcastOnDone(done <-chan struct{}, stop <-chan struct{}, stream *memoryStream) func() {
	if done == nil {
		return func() {}
	}

	var watcher sync.WaitGroup
	watcher.Add(1)
	go func() {
		defer watcher.Done()
		select {
		case <-done:
		case <-stop:
		}
		m.mu.Lock()
		stream.cond.Broadcast()
		m.mu.Unlock()
	}()

	return watcher.Wait
}

func (m *MemoryStreamStore) waitNextSubscriptionEvent(ctx context.Context, stream *memoryStream, nextSeq *int64) (StreamEvent, bool) {
	for {
		m.mu.Lock()

		idx := streamEventIndexAfterSeq(stream.events, *nextSeq)
		for idx >= len(stream.events) && !stream.closed && ctx.Err() == nil {
			stream.cond.Wait()
			idx = streamEventIndexAfterSeq(stream.events, *nextSeq)
		}

		if ctx.Err() != nil {
			m.mu.Unlock()
			return StreamEvent{}, false
		}

		if idx >= len(stream.events) {
			// No buffered events left.
			if stream.closed {
				m.mu.Unlock()
				return StreamEvent{}, false
			}
			m.mu.Unlock()
			continue
		}

		ev := stream.events[idx]
		*nextSeq = ev.seq

		data := make([]byte, len(ev.data))
		copy(data, ev.data)

		id := strconv.FormatInt(ev.seq, 10)
		m.mu.Unlock()

		return StreamEvent{ID: id, Data: data}, true
	}
}

func streamEventIndexAfterSeq(events []memoryStreamEvent, seq int64) int {
	return sort.Search(len(events), func(i int) bool {
		return events[i].seq > seq
	})
}

func (m *MemoryStreamStore) StreamForEvent(_ context.Context, sessionID, eventID string) (string, error) {
	if sessionID == "" {
		return "", errors.New("missing session id")
	}
	if eventID == "" {
		return "", errors.New("missing event id")
	}

	seq, err := strconv.ParseInt(eventID, 10, 64)
	if err != nil {
		return "", fmt.Errorf("invalid event id: %w", err)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	sess := m.sessions[sessionID]
	if sess == nil {
		return "", ErrEventNotFound
	}

	streamID, ok := sess.seqToStream[seq]
	if !ok {
		return "", ErrEventNotFound
	}
	return streamID, nil
}

func (m *MemoryStreamStore) DeleteSession(_ context.Context, sessionID string) error {
	if sessionID == "" {
		return errors.New("missing session id")
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	sess := m.sessions[sessionID]
	if sess == nil {
		return nil
	}

	for _, stream := range sess.streams {
		stream.closed = true
		stream.cond.Broadcast()
	}

	delete(m.sessions, sessionID)
	return nil
}
