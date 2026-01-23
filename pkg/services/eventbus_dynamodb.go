package services

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"

	tablecore "github.com/theory-cloud/tabletheory/pkg/core"
	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"
)

// minInt returns the smaller of two integers.
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// DynamoDBEventBus implements EventBus using TableTheory-backed DynamoDB storage.
//
// This implementation is serverless-safe and survives Lambda container recycling.
type DynamoDBEventBus struct {
	handlers map[string][]EventHandler
	db       tablecore.DB
	config   EventBusConfig
}

var _ EventBus = (*DynamoDBEventBus)(nil)

// NewDynamoDBEventBus creates a new DynamoDB-backed event bus using TableTheory.
func NewDynamoDBEventBus(db tablecore.DB, config EventBusConfig) *DynamoDBEventBus {
	if config.TTL == 0 {
		config.TTL = 30 * 24 * time.Hour
	}
	if config.RetryAttempts == 0 {
		config.RetryAttempts = 3
	}
	if config.RetryBaseDelay == 0 {
		config.RetryBaseDelay = 100 * time.Millisecond
	}
	if config.MaxBatchSize == 0 {
		config.MaxBatchSize = 25
	}
	if config.MetricsNamespace == "" {
		config.MetricsNamespace = "AppTheory/EventBus"
	}

	if config.TableName != "" {
		// Override Event.TableName() for the process lifetime.
		// TableTheory caches model metadata, so table names must be stable.
		if err := setEventBusTableNameOverride(config.TableName); err != nil {
			panic(fmt.Sprintf("failed to set event bus table name override: %v", err))
		}
	} else {
		config.TableName = (&Event{}).TableName()
	}

	return &DynamoDBEventBus{
		db:       db,
		config:   config,
		handlers: make(map[string][]EventHandler),
	}
}

func (d *DynamoDBEventBus) Publish(ctx context.Context, event *Event) (string, error) {
	ctx = ensureContext(ctx)

	eventType, tenantID, err := validateEventForPublish(event)
	if err != nil {
		return "", err
	}

	now := time.Now().UTC()
	prepareEventForPublish(event, now, d.config.TTL, eventType, tenantID)

	return d.createWithRetry(ctx, event, eventType, tenantID)
}

func (d *DynamoDBEventBus) Query(ctx context.Context, query *EventQuery) ([]*Event, error) {
	ctx = ensureContext(ctx)

	if err := validateEventQuery(query); err != nil {
		return nil, err
	}

	q := d.buildQuery(ctx, query)
	q = applyQueryCursor(q, query)

	events, err := d.executeQuery(q, query)
	if err != nil {
		return nil, err
	}

	d.emitMetric("QuerySuccess", 1, map[string]string{
		"event_type": query.EventType,
	})

	return events, nil
}

func applySortKeyTimeRange(q tablecore.Query, query *EventQuery) {
	switch {
	case query.StartTime != nil && query.EndTime != nil:
		startKey := fmt.Sprintf("%d#", query.StartTime.UnixNano())
		endKey := fmt.Sprintf("%d#", query.EndTime.UnixNano()+1) // exclusive upper bound
		q.Where("SortKey", "BETWEEN", []any{startKey, endKey})
	case query.StartTime != nil:
		startKey := fmt.Sprintf("%d#", query.StartTime.UnixNano())
		q.Where("SortKey", ">=", startKey)
	case query.EndTime != nil:
		endKey := fmt.Sprintf("%d#", query.EndTime.UnixNano())
		q.Where("SortKey", "<", endKey)
	}
}

func applyPublishedAtTimeRange(q tablecore.Query, query *EventQuery) {
	switch {
	case query.StartTime != nil && query.EndTime != nil:
		q.Where("PublishedAt", "BETWEEN", []any{*query.StartTime, *query.EndTime})
	case query.StartTime != nil:
		q.Where("PublishedAt", ">=", *query.StartTime)
	case query.EndTime != nil:
		q.Where("PublishedAt", "<=", *query.EndTime)
	}
}

func (d *DynamoDBEventBus) Subscribe(_ context.Context, eventType string, handler EventHandler) error {
	eventType = strings.TrimSpace(eventType)
	if eventType == "" {
		return fmt.Errorf("event type cannot be empty")
	}
	if handler == nil {
		return fmt.Errorf("handler cannot be nil")
	}

	d.handlers[eventType] = append(d.handlers[eventType], handler)
	return nil
}

func (d *DynamoDBEventBus) GetEvent(ctx context.Context, eventID string) (*Event, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	eventID = strings.TrimSpace(eventID)
	if eventID == "" {
		return nil, fmt.Errorf("event ID cannot be empty")
	}

	var out Event
	err := d.db.Model(&Event{}).
		WithContext(ctx).
		Index("event-id-index").
		Where("ID", "=", eventID).
		First(&out)
	if err != nil {
		if tableerrors.IsNotFound(err) {
			return nil, fmt.Errorf("event not found: %s", eventID)
		}
		return nil, fmt.Errorf("failed to get event: %w", err)
	}

	return &out, nil
}

func (d *DynamoDBEventBus) DeleteEvent(ctx context.Context, eventID string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	eventID = strings.TrimSpace(eventID)
	if eventID == "" {
		return fmt.Errorf("event ID cannot be empty")
	}

	event, err := d.GetEvent(ctx, eventID)
	if err != nil {
		return err
	}

	err = d.db.Model(&Event{}).
		WithContext(ctx).
		Where("PartitionKey", "=", event.PartitionKey).
		Where("SortKey", "=", event.SortKey).
		Delete()
	if err != nil {
		d.emitMetric("DeleteError", 1, map[string]string{
			"error_type": "delete_failed",
		})
		return fmt.Errorf("failed to delete event: %w", err)
	}

	d.emitMetric("DeleteSuccess", 1, nil)
	return nil
}

func (d *DynamoDBEventBus) emitMetric(name string, value float64, tags map[string]string) {
	if !d.config.EnableMetrics || d.config.EmitMetric == nil {
		return
	}

	if tags == nil {
		tags = make(map[string]string, 1)
	}
	if d.config.TableName != "" {
		if _, ok := tags["table_name"]; !ok {
			tags["table_name"] = d.config.TableName
		}
	}

	d.config.EmitMetric(MetricRecord{
		Namespace: d.config.MetricsNamespace,
		Name:      name,
		Value:     value,
		Tags:      tags,
	})
}

func isRetryableError(err error) bool {
	if err == nil {
		return false
	}

	// TableTheory wraps AWS SDK errors; string matching is the most portable
	// approach across SDK versions without introducing new AWS touchpoints.
	msg := err.Error()
	retryable := []string{
		"ProvisionedThroughputExceededException",
		"ThrottlingException",
		"RequestLimitExceeded",
		"ServiceUnavailable",
		"InternalServerError",
		"RequestThrottled",
	}

	for _, needle := range retryable {
		if strings.Contains(msg, needle) {
			return true
		}
	}
	return false
}

func ensureContext(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return ctx
}

func validateEventForPublish(event *Event) (eventType string, tenantID string, err error) {
	if event == nil {
		return "", "", fmt.Errorf("event cannot be nil")
	}

	eventType = strings.TrimSpace(event.EventType)
	if eventType == "" {
		return "", "", fmt.Errorf("event type cannot be empty")
	}

	tenantID = strings.TrimSpace(event.TenantID)
	if tenantID == "" {
		return "", "", fmt.Errorf("tenant ID cannot be empty")
	}

	return eventType, tenantID, nil
}

func prepareEventForPublish(event *Event, now time.Time, ttl time.Duration, eventType, tenantID string) {
	if event == nil {
		return
	}

	if strings.TrimSpace(event.ID) == "" {
		event.ID = ulid.Make().String()
	}

	if event.PublishedAt.IsZero() {
		event.PublishedAt = now
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = now
	}

	if strings.TrimSpace(event.PartitionKey) == "" {
		event.PartitionKey = fmt.Sprintf("%s#%s", tenantID, eventType)
	}
	if strings.TrimSpace(event.SortKey) == "" {
		event.SortKey = fmt.Sprintf("%d#%s", event.PublishedAt.UnixNano(), event.ID)
	}

	if ttl > 0 && event.ExpiresAt.IsZero() {
		event.ExpiresAt = now.Add(ttl)
	}
	if !event.ExpiresAt.IsZero() {
		event.TTL = event.ExpiresAt.Unix()
	}
}

func (d *DynamoDBEventBus) createWithRetry(ctx context.Context, event *Event, eventType, tenantID string) (string, error) {
	var lastErr error
	for attempt := 0; attempt <= d.config.RetryAttempts; attempt++ {
		if attempt > 0 {
			backoffMultiplier := 1 << minInt(attempt-1, 10) // cap at 2^10
			delay := d.config.RetryBaseDelay * time.Duration(backoffMultiplier)
			time.Sleep(delay)
		}

		err := d.db.Model(event).WithContext(ctx).IfNotExists().Create()
		if err == nil {
			d.emitMetric("PublishSuccess", 1, map[string]string{
				"event_type": eventType,
				"tenant_id":  tenantID,
			})
			return event.ID, nil
		}

		if tableerrors.IsConditionFailed(err) {
			d.emitMetric("PublishDeduped", 1, map[string]string{
				"event_type": eventType,
				"tenant_id":  tenantID,
			})
			return event.ID, nil
		}

		lastErr = err
		if !isRetryableError(err) {
			break
		}
	}

	d.emitMetric("PublishError", 1, map[string]string{
		"error_type": "put_item_failed",
		"event_type": eventType,
	})
	return "", fmt.Errorf("failed to publish event after %d attempts: %w", d.config.RetryAttempts+1, lastErr)
}

func validateEventQuery(query *EventQuery) error {
	if query == nil {
		return fmt.Errorf("query cannot be nil")
	}
	if strings.TrimSpace(query.TenantID) == "" {
		return fmt.Errorf("tenant_id is required for queries")
	}
	return nil
}

func (d *DynamoDBEventBus) buildQuery(ctx context.Context, query *EventQuery) tablecore.Query {
	q := d.db.Model(&Event{}).WithContext(ctx)

	useGSI := strings.TrimSpace(query.EventType) == ""
	if useGSI {
		q = q.Index("tenant-timestamp-index").Where("TenantID", "=", query.TenantID)
		applyPublishedAtTimeRange(q, query)
		q = q.OrderBy("PublishedAt", "DESC")
	} else {
		partitionKey := fmt.Sprintf("%s#%s", query.TenantID, query.EventType)
		q = q.Where("PartitionKey", "=", partitionKey)
		applySortKeyTimeRange(q, query)
		q = q.OrderBy("SortKey", "DESC")
	}

	q = applyQueryTags(q, query.Tags)
	q = q.Limit(normalizeLimit(query.Limit))

	return q
}

func applyQueryTags(q tablecore.Query, tags []string) tablecore.Query {
	for _, tag := range tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		q = q.Filter("Tags", "CONTAINS", tag)
	}
	return q
}

func normalizeLimit(limit int) int {
	if limit > 0 && limit <= 1000 {
		return limit
	}
	return 100
}

func applyQueryCursor(q tablecore.Query, query *EventQuery) tablecore.Query {
	if query == nil || query.LastEvaluatedKey == nil {
		return q
	}
	if cursor, ok := query.LastEvaluatedKey["cursor"].(string); ok && strings.TrimSpace(cursor) != "" {
		return q.Cursor(cursor)
	}
	return q
}

func (d *DynamoDBEventBus) executeQuery(q tablecore.Query, query *EventQuery) ([]*Event, error) {
	var out []Event
	page, err := q.AllPaginated(&out)
	if err != nil {
		d.emitMetric("QueryError", 1, map[string]string{
			"error_type": "query_failed",
		})
		return nil, fmt.Errorf("failed to query events: %w", err)
	}

	setNextKey(query, page)

	events := make([]*Event, 0, len(out))
	for i := range out {
		events = append(events, &out[i])
	}
	return events, nil
}

func setNextKey(query *EventQuery, page *tablecore.PaginatedResult) {
	if query == nil {
		return
	}
	if page != nil && page.HasMore && strings.TrimSpace(page.NextCursor) != "" {
		query.NextKey = map[string]any{"cursor": page.NextCursor}
		return
	}
	query.NextKey = nil
}
