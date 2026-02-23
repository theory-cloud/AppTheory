package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"

	apptheory "github.com/theory-cloud/apptheory/runtime"
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
	// it streams from the beginning.
	Subscribe(ctx context.Context, sessionID, streamID, afterEventID string) (<-chan StreamEvent, error)

	// StreamForEvent returns the stream id that the given event id belongs to.
	StreamForEvent(ctx context.Context, sessionID, eventID string) (streamID string, err error)

	// DeleteSession removes all stream state for a session.
	DeleteSession(ctx context.Context, sessionID string) error
}

var (
	ErrStreamNotFound = errors.New("stream not found")
	ErrEventNotFound  = errors.New("event not found")
)

type MemoryStreamStoreOption func(*MemoryStreamStore)

func WithStreamIDGenerator(gen apptheory.IDGenerator) MemoryStreamStoreOption {
	return func(m *MemoryStreamStore) {
		m.idGen = gen
	}
}

// MemoryStreamStore is an in-memory StreamStore for testing and local development.
//
// It assigns monotonically increasing numeric event IDs per session (as strings).
type MemoryStreamStore struct {
	mu       sync.Mutex
	idGen    apptheory.IDGenerator
	sessions map[string]*memoryStreamSession
}

type memoryStreamSession struct {
	nextSeq     int64
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
		idGen:    apptheory.RandomIDGenerator{},
		sessions: make(map[string]*memoryStreamSession),
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

	sess.nextSeq++
	seq := sess.nextSeq

	stored := make([]byte, len(data))
	copy(stored, data)

	stream.events = append(stream.events, memoryStreamEvent{
		seq:  seq,
		data: stored,
	})
	sess.seqToStream[seq] = streamID
	stream.cond.Broadcast()

	return strconv.FormatInt(seq, 10), nil
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

	afterSeq := int64(0)
	if afterEventID != "" {
		seq, err := strconv.ParseInt(afterEventID, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid last-event-id: %w", err)
		}
		if seq > 0 {
			afterSeq = seq
		}
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

	nextIndex := 0
	for nextIndex < len(stream.events) && stream.events[nextIndex].seq <= afterSeq {
		nextIndex++
	}
	m.mu.Unlock()

	out := make(chan StreamEvent)

	go func() {
		defer close(out)

		done := ctx.Done()
		if done != nil {
			go func() {
				<-done
				m.mu.Lock()
				stream.cond.Broadcast()
				m.mu.Unlock()
			}()
		}

		for {
			m.mu.Lock()

			for nextIndex >= len(stream.events) && !stream.closed && ctx.Err() == nil {
				stream.cond.Wait()
			}

			if ctx.Err() != nil {
				m.mu.Unlock()
				return
			}

			if nextIndex >= len(stream.events) {
				// No buffered events left.
				if stream.closed {
					m.mu.Unlock()
					return
				}
				m.mu.Unlock()
				continue
			}

			ev := stream.events[nextIndex]
			nextIndex++

			data := make([]byte, len(ev.data))
			copy(data, ev.data)

			id := strconv.FormatInt(ev.seq, 10)
			m.mu.Unlock()

			select {
			case <-done:
				return
			case out <- StreamEvent{ID: id, Data: data}:
			}
		}
	}()

	return out, nil
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
