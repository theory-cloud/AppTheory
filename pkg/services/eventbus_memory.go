package services

import (
	"context"
	"encoding/base64"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/oklog/ulid/v2"
)

// MemoryEventBus provides an in-memory implementation for testing and development.
//
// WARNING: This is NOT suitable for production Lambda environments as events
// are lost when the Lambda container scales down or is recycled.
type MemoryEventBus struct {
	events   map[string]*Event         // events by ID
	handlers map[string][]EventHandler // registered handlers
	mu       sync.RWMutex
}

var _ EventBus = (*MemoryEventBus)(nil)

// NewMemoryEventBus creates a new in-memory event bus.
// This should only be used for testing or local development.
func NewMemoryEventBus() *MemoryEventBus {
	return &MemoryEventBus{
		events:   make(map[string]*Event),
		handlers: make(map[string][]EventHandler),
	}
}

func (m *MemoryEventBus) Publish(ctx context.Context, event *Event) (string, error) {
	if event == nil {
		return "", fmt.Errorf("event cannot be nil")
	}
	if ctx == nil {
		ctx = context.Background()
	}

	// Generate ID if not set.
	if strings.TrimSpace(event.ID) == "" {
		event.ID = ulid.Make().String()
	}

	// Ensure timestamps.
	now := time.Now().UTC()
	if event.PublishedAt.IsZero() {
		event.PublishedAt = now
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = now
	}

	// Ensure keys.
	if strings.TrimSpace(event.PartitionKey) == "" {
		event.PartitionKey = fmt.Sprintf("%s#%s", strings.TrimSpace(event.TenantID), strings.TrimSpace(event.EventType))
	}
	if strings.TrimSpace(event.SortKey) == "" {
		event.SortKey = fmt.Sprintf("%d#%s", event.PublishedAt.UnixNano(), event.ID)
	}

	// Store a shallow copy to avoid callers mutating internal state.
	stored := *event

	m.mu.Lock()
	m.events[event.ID] = &stored
	handlers := append([]EventHandler(nil), m.handlers[event.EventType]...)
	m.mu.Unlock()

	for _, handler := range handlers {
		if handler == nil {
			continue
		}
		if err := handler(ctx, &stored); err != nil {
			return event.ID, err
		}
	}

	return event.ID, nil
}

func (m *MemoryEventBus) Query(_ context.Context, query *EventQuery) ([]*Event, error) {
	if query == nil {
		return nil, fmt.Errorf("query cannot be nil")
	}

	candidates := m.snapshotEvents()
	filtered := filterEvents(candidates, query)
	sortEventsByPublishedAtDesc(filtered)

	offset, err := offsetFromQuery(query.LastEvaluatedKey)
	if err != nil {
		return nil, err
	}

	page, nextOffset := paginateEvents(filtered, offset, normalizeLimit(query.Limit))
	query.NextKey = nextKeyFromOffset(nextOffset, len(filtered))

	return copyEvents(page), nil
}

func (m *MemoryEventBus) Subscribe(_ context.Context, eventType string, handler EventHandler) error {
	eventType = strings.TrimSpace(eventType)
	if eventType == "" {
		return fmt.Errorf("event type cannot be empty")
	}
	if handler == nil {
		return fmt.Errorf("handler cannot be nil")
	}

	m.mu.Lock()
	m.handlers[eventType] = append(m.handlers[eventType], handler)
	m.mu.Unlock()
	return nil
}

func (m *MemoryEventBus) GetEvent(_ context.Context, eventID string) (*Event, error) {
	eventID = strings.TrimSpace(eventID)
	if eventID == "" {
		return nil, fmt.Errorf("event ID cannot be empty")
	}

	m.mu.RLock()
	evt, ok := m.events[eventID]
	m.mu.RUnlock()

	if !ok || evt == nil {
		return nil, fmt.Errorf("event not found: %s", eventID)
	}

	copied := *evt
	return &copied, nil
}

func (m *MemoryEventBus) DeleteEvent(_ context.Context, eventID string) error {
	eventID = strings.TrimSpace(eventID)
	if eventID == "" {
		return fmt.Errorf("event ID cannot be empty")
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.events[eventID]; !ok {
		return fmt.Errorf("event not found: %s", eventID)
	}
	delete(m.events, eventID)
	return nil
}

func eventMatchesQuery(evt *Event, query *EventQuery) bool {
	if evt == nil || query == nil {
		return false
	}

	if query.TenantID != "" && evt.TenantID != query.TenantID {
		return false
	}

	if query.EventType != "" && evt.EventType != query.EventType {
		return false
	}

	if query.StartTime != nil && evt.PublishedAt.Before(*query.StartTime) {
		return false
	}

	if query.EndTime != nil && evt.PublishedAt.After(*query.EndTime) {
		return false
	}

	for _, tag := range query.Tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		if !eventHasTag(evt, tag) {
			return false
		}
	}

	return true
}

func eventHasTag(evt *Event, tag string) bool {
	if evt == nil {
		return false
	}
	for _, candidate := range evt.Tags {
		if candidate == tag {
			return true
		}
	}
	return false
}

func encodeOffsetCursor(offset int) string {
	raw := strconv.Itoa(offset)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeOffsetCursor(cursor string) (int, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return 0, fmt.Errorf("invalid cursor")
	}
	value, err := strconv.Atoi(string(decoded))
	if err != nil || value < 0 {
		return 0, fmt.Errorf("invalid cursor")
	}
	return value, nil
}

func (m *MemoryEventBus) snapshotEvents() []*Event {
	m.mu.RLock()
	defer m.mu.RUnlock()

	candidates := make([]*Event, 0, len(m.events))
	for _, evt := range m.events {
		if evt == nil {
			continue
		}
		candidates = append(candidates, evt)
	}
	return candidates
}

func filterEvents(events []*Event, query *EventQuery) []*Event {
	filtered := make([]*Event, 0, len(events))
	for _, evt := range events {
		if !eventMatchesQuery(evt, query) {
			continue
		}
		filtered = append(filtered, evt)
	}
	return filtered
}

func sortEventsByPublishedAtDesc(events []*Event) {
	sort.Slice(events, func(i, j int) bool {
		return events[i].PublishedAt.After(events[j].PublishedAt)
	})
}

func offsetFromQuery(lastEvaluatedKey map[string]any) (int, error) {
	if lastEvaluatedKey == nil {
		return 0, nil
	}

	raw, ok := lastEvaluatedKey["cursor"].(string)
	if !ok || raw == "" {
		return 0, nil
	}

	return decodeOffsetCursor(raw)
}

func paginateEvents(events []*Event, offset, limit int) (page []*Event, nextOffset int) {
	if offset < 0 {
		offset = 0
	}
	if offset > len(events) {
		offset = len(events)
	}

	end := offset + limit
	if end > len(events) {
		end = len(events)
	}

	page = events[offset:end]

	if end < len(events) {
		return page, end
	}
	return page, -1
}

func nextKeyFromOffset(offset, total int) map[string]any {
	if offset >= 0 && offset < total {
		return map[string]any{"cursor": encodeOffsetCursor(offset)}
	}
	return nil
}

func copyEvents(events []*Event) []*Event {
	out := make([]*Event, 0, len(events))
	for _, evt := range events {
		if evt == nil {
			continue
		}
		copied := *evt
		out = append(out, &copied)
	}
	return out
}
