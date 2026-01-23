package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/oklog/ulid/v2"
)

// EventBus defines the interface for publishing and consuming events.
//
// This interface is intentionally Lift-compatible to minimize migration risk for
// Pay Theory services (Autheory/K3). AppTheory's DynamoDB implementation uses
// TableTheory as the data layer.
type EventBus interface {
	// Publish publishes an event to the bus and returns the event ID.
	Publish(ctx context.Context, event *Event) (string, error)

	// Query retrieves events based on filters. Implementations may mutate
	// query.NextKey to return a pagination cursor.
	Query(ctx context.Context, query *EventQuery) ([]*Event, error)

	// Subscribe registers a handler for specific event types (for stream processing).
	Subscribe(ctx context.Context, eventType string, handler EventHandler) error

	// GetEvent retrieves a specific event by ID.
	GetEvent(ctx context.Context, eventID string) (*Event, error)

	// DeleteEvent removes an event (for cleanup/GDPR).
	DeleteEvent(ctx context.Context, eventID string) error
}

// Event represents a single durable event.
type Event struct {
	_ struct{} `theorydb:"naming:snake_case"`

	// Primary identifiers and timestamps (8-byte aligned)
	PublishedAt time.Time `json:"published_at" theorydb:"index:tenant-timestamp-index,sk"`
	CreatedAt   time.Time `json:"created_at" theorydb:"created_at"`
	ExpiresAt   time.Time `json:"expires_at,omitempty" theorydb:"omitempty"`

	// String fields (16 bytes each)
	ID            string `json:"id" theorydb:"index:event-id-index,pk"`
	EventType     string `json:"event_type"`
	TenantID      string `json:"tenant_id" theorydb:"index:tenant-timestamp-index,pk"`
	SourceID      string `json:"source_id"`
	PartitionKey  string `json:"partition_key" theorydb:"pk,attr:pk"`
	SortKey       string `json:"sort_key" theorydb:"sk,attr:sk"`
	CorrelationID string `json:"correlation_id,omitempty" theorydb:"omitempty"`

	// Complex types
	Payload  json.RawMessage   `json:"payload"`
	Metadata map[string]string `json:"metadata,omitempty" theorydb:"omitempty"`
	Tags     []string          `json:"tags,omitempty" theorydb:"set,omitempty"`

	// TTL is stored in the DynamoDB TTL attribute ("ttl") as a Unix timestamp in seconds.
	TTL int64 `json:"-" theorydb:"ttl,omitempty"`

	// Smaller numeric types
	Version    int `json:"version"`
	RetryCount int `json:"retry_count"`
}

const (
	defaultEventBusTableName = "apptheory-events"
)

var (
	eventBusTableNameMu       sync.RWMutex
	eventBusTableNameOverride string
)

func (e *Event) TableName() string {
	if tableName := getEventBusTableNameOverride(); tableName != "" {
		return tableName
	}

	if name := os.Getenv("APPTHEORY_EVENTBUS_TABLE_NAME"); name != "" {
		return name
	}

	// Migration-friendly fallbacks.
	if name := os.Getenv("EVENTBUS_TABLE_NAME"); name != "" {
		return name
	}
	if name := os.Getenv("AUTHEORY_EVENTBUS_TABLE_NAME"); name != "" {
		return name
	}
	if base := os.Getenv("AUTHEORY_TABLE_NAME"); base != "" {
		return base + "-events"
	}

	return defaultEventBusTableName
}

func setEventBusTableNameOverride(tableName string) error {
	if tableName == "" {
		return nil
	}

	eventBusTableNameMu.Lock()
	defer eventBusTableNameMu.Unlock()

	if eventBusTableNameOverride != "" && eventBusTableNameOverride != tableName {
		return fmt.Errorf("event bus table name already set to %q (cannot change to %q)", eventBusTableNameOverride, tableName)
	}
	eventBusTableNameOverride = tableName
	return nil
}

func getEventBusTableNameOverride() string {
	eventBusTableNameMu.RLock()
	defer eventBusTableNameMu.RUnlock()
	return eventBusTableNameOverride
}

// EventQuery defines parameters for querying events.
type EventQuery struct {
	// Lift-compatible cursor shape.
	LastEvaluatedKey map[string]any
	NextKey          map[string]any // Returned pagination token for next query

	StartTime *time.Time
	EndTime   *time.Time

	TenantID  string
	EventType string
	Tags      []string
	Limit     int
}

// EventHandler is a function that processes events.
type EventHandler func(ctx context.Context, event *Event) error

// MetricRecord is a minimal, portable metric payload used by the EventBus.
//
// AppTheory does not wrap CloudWatch in core packages; callers can bridge this to
// their metrics backend (CloudWatch, OTEL, etc).
type MetricRecord struct {
	Namespace string
	Name      string
	Value     float64
	Tags      map[string]string
}

// EventBusConfig configures the event bus behavior.
type EventBusConfig struct {
	TableName        string
	MetricsNamespace string
	TTL              time.Duration
	RetryBaseDelay   time.Duration
	RetryAttempts    int
	MaxBatchSize     int
	EnableMetrics    bool
	EmitMetric       func(MetricRecord)
}

// DefaultEventBusConfig returns sensible defaults.
func DefaultEventBusConfig() EventBusConfig {
	return EventBusConfig{
		TTL:              30 * 24 * time.Hour, // 30 days
		EnableMetrics:    true,
		MetricsNamespace: "AppTheory/EventBus",
		RetryAttempts:    3,
		RetryBaseDelay:   100 * time.Millisecond,
		MaxBatchSize:     25, // DynamoDB limit
	}
}

// NewEvent creates a new event with generated ID and timestamps.
func NewEvent(eventType, tenantID, sourceID string, payload any) (*Event, error) {
	// Generate ULID for time-ordered IDs.
	id := ulid.Make().String()

	// Marshal payload.
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal payload: %w", err)
	}

	now := time.Now().UTC()

	// Construct partition and sort keys:
	// - partition: tenant_id#event_type
	// - sort: timestamp_nanos#id
	partitionKey := fmt.Sprintf("%s#%s", tenantID, eventType)
	sortKey := fmt.Sprintf("%d#%s", now.UnixNano(), id)

	return &Event{
		ID:           id,
		EventType:    eventType,
		TenantID:     tenantID,
		SourceID:     sourceID,
		Payload:      payloadBytes,
		PublishedAt:  now,
		CreatedAt:    now,
		PartitionKey: partitionKey,
		SortKey:      sortKey,
		Version:      1,
		Metadata:     make(map[string]string),
		Tags:         make([]string, 0),
	}, nil
}

// WithTTL sets an expiration time for the event.
func (e *Event) WithTTL(ttl time.Duration) *Event {
	if e == nil {
		return nil
	}
	e.ExpiresAt = e.CreatedAt.Add(ttl)
	return e
}

// WithMetadata adds metadata to the event.
func (e *Event) WithMetadata(key, value string) *Event {
	if e == nil {
		return nil
	}
	if e.Metadata == nil {
		e.Metadata = make(map[string]string)
	}
	e.Metadata[key] = value
	return e
}

// WithTags adds tags to the event.
func (e *Event) WithTags(tags ...string) *Event {
	if e == nil {
		return nil
	}
	e.Tags = append(e.Tags, tags...)
	return e
}

// WithCorrelationID sets a correlation ID for tracing related events.
func (e *Event) WithCorrelationID(correlationID string) *Event {
	if e == nil {
		return nil
	}
	e.CorrelationID = correlationID
	return e
}

// UnmarshalPayload unmarshals the event payload into the provided struct.
func (e *Event) UnmarshalPayload(v any) error {
	if e == nil {
		return fmt.Errorf("event is nil")
	}
	return json.Unmarshal(e.Payload, v)
}
