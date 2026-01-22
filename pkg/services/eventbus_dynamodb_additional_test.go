package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	tablecore "github.com/theory-cloud/tabletheory/pkg/core"
	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"
	tablemocks "github.com/theory-cloud/tabletheory/pkg/mocks"
)

func resetEventBusTableNameOverride(t *testing.T) {
	t.Helper()
	eventBusTableNameMu.Lock()
	eventBusTableNameOverride = ""
	eventBusTableNameMu.Unlock()
}

func TestEvent_TableName_EnvAndOverride(t *testing.T) {
	resetEventBusTableNameOverride(t)
	t.Cleanup(func() { resetEventBusTableNameOverride(t) })
	t.Setenv("APPTHEORY_EVENTBUS_TABLE_NAME", "apptheory-events-table")
	require.Equal(t, "apptheory-events-table", (&Event{}).TableName())

	resetEventBusTableNameOverride(t)
	require.NoError(t, setEventBusTableNameOverride("override-table"))
	require.Equal(t, "override-table", (&Event{}).TableName())
	require.Error(t, setEventBusTableNameOverride("other-table"))
}

func TestEvent_MutatorsAndPayload(t *testing.T) {
	e := &Event{CreatedAt: time.Unix(0, 0).UTC(), Payload: []byte(`{"ok":true}`)}

	require.Equal(t, e, e.WithTTL(1*time.Hour))
	require.Equal(t, e, e.WithMetadata("k", "v"))
	require.Equal(t, e, e.WithTags("a", "b"))
	require.Equal(t, e, e.WithCorrelationID("c"))

	var parsed struct {
		OK bool `json:"ok"`
	}
	require.NoError(t, e.UnmarshalPayload(&parsed))
	require.True(t, parsed.OK)

	require.Error(t, (*Event)(nil).UnmarshalPayload(&parsed))
}

func TestDynamoDBEventBus_Subscribe_ValidatesInputs(t *testing.T) {
	bus := &DynamoDBEventBus{handlers: make(map[string][]EventHandler)}

	require.Error(t, bus.Subscribe(context.Background(), "", func(context.Context, *Event) error { return nil }))
	require.Error(t, bus.Subscribe(context.Background(), "x", nil))

	require.NoError(t, bus.Subscribe(context.Background(), "x", func(context.Context, *Event) error { return nil }))
	require.Len(t, bus.handlers["x"], 1)
}

func TestDynamoDBEventBus_Query_SetsNextKeyAndEmitsMetrics(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("OrderBy", mock.Anything, mock.Anything).Return(q)
	q.On("Filter", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("Limit", 10).Return(q)
	q.On("Cursor", "c0").Return(q)
	q.On("AllPaginated", mock.Anything).Run(func(args mock.Arguments) {
		dest, ok := args.Get(0).(*[]Event)
		require.True(t, ok)
		*dest = append(*dest, Event{
			ID:            "evt_1",
			EventType:     "partner.created",
			TenantID:      "tenant_1",
			PartitionKey:  "tenant_1#partner.created",
			SortKey:       "0#evt_1",
			PublishedAt:   time.Unix(0, 0).UTC(),
			CreatedAt:     time.Unix(0, 0).UTC(),
			Version:       1,
			RetryCount:    0,
			Payload:       []byte(`{}`),
			Tags:          nil,
			Metadata:      nil,
			CorrelationID: "",
		})
	}).Return(&tablecore.PaginatedResult{HasMore: true, NextCursor: "c1"}, nil)

	var metrics []MetricRecord
	bus := NewDynamoDBEventBus(db, EventBusConfig{
		EnableMetrics: true,
		EmitMetric: func(m MetricRecord) {
			metrics = append(metrics, m)
		},
	})

	query := &EventQuery{
		TenantID:         "tenant_1",
		EventType:        "partner.created",
		Tags:             []string{"audit"},
		Limit:            10,
		LastEvaluatedKey: map[string]any{"cursor": "c0"},
	}
	events, err := bus.Query(context.Background(), query)
	require.NoError(t, err)
	require.Len(t, events, 1)
	require.NotNil(t, query.NextKey)
	require.Equal(t, "c1", query.NextKey["cursor"])
	require.NotEmpty(t, metrics)
	require.Equal(t, "QuerySuccess", metrics[len(metrics)-1].Name)
}

func TestDynamoDBEventBus_GetEvent_NotFound(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Index", "event-id-index").Return(q)
	q.On("Where", "ID", "=", "evt_missing").Return(q)
	q.On("First", mock.Anything).Return(tableerrors.ErrItemNotFound)

	bus := NewDynamoDBEventBus(db, EventBusConfig{EnableMetrics: false})

	_, err := bus.GetEvent(context.Background(), "evt_missing")
	require.Error(t, err)
	require.Contains(t, err.Error(), "event not found")
}

func TestDynamoDBEventBus_DeleteEvent_Success(t *testing.T) {
	db := new(tablemocks.MockDB)
	qGet := new(tablemocks.MockQuery)
	qDel := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(qGet).Once()
	db.On("Model", mock.Anything).Return(qDel).Once()

	qGet.On("WithContext", mock.Anything).Return(qGet)
	qGet.On("Index", "event-id-index").Return(qGet)
	qGet.On("Where", "ID", "=", "evt_1").Return(qGet)
	qGet.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*Event)
		require.True(t, ok)
		out.PartitionKey = "tenant_1#partner.created"
		out.SortKey = "0#evt_1"
	}).Return(nil)

	qDel.On("WithContext", mock.Anything).Return(qDel)
	qDel.On("Where", "PartitionKey", "=", "tenant_1#partner.created").Return(qDel)
	qDel.On("Where", "SortKey", "=", "0#evt_1").Return(qDel)
	qDel.On("Delete").Return(nil)

	var metrics []MetricRecord
	bus := NewDynamoDBEventBus(db, EventBusConfig{
		EnableMetrics: true,
		EmitMetric: func(m MetricRecord) {
			metrics = append(metrics, m)
		},
	})

	require.NoError(t, bus.DeleteEvent(context.Background(), "evt_1"))
	require.NotEmpty(t, metrics)
	require.Equal(t, "DeleteSuccess", metrics[len(metrics)-1].Name)
}

func TestIsRetryableError_StringMatch(t *testing.T) {
	require.True(t, isRetryableError(errors.New("ProvisionedThroughputExceededException: nope")))
	require.False(t, isRetryableError(errors.New("non-retryable")))
	require.False(t, isRetryableError(nil))
}
