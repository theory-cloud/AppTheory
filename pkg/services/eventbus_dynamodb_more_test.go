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

func TestMinInt_AndRetryableHelpers(t *testing.T) {
	t.Parallel()

	require.Equal(t, 1, minInt(1, 2))
	require.Equal(t, 1, minInt(2, 1))

	require.False(t, isRetryableError(nil))
	require.True(t, isRetryableError(errors.New("ThrottlingException: slow down")))
	require.False(t, isRetryableError(errors.New("nope")))
}

func TestEnsureContext_ReturnsSameContextWhenNonNil(t *testing.T) {
	t.Parallel()

	type ctxKey struct{}
	ctx := context.WithValue(context.Background(), ctxKey{}, "v")
	require.True(t, ensureContext(ctx) == ctx)
}

func TestDynamoDBEventBus_Publish_DedupedConditionFailed_EmitsMetric(t *testing.T) {
	t.Parallel()

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q).Once()
	q.On("WithContext", mock.Anything).Return(q).Once()
	q.On("IfNotExists").Return(q).Once()
	q.On("Create").Return(tableerrors.ErrConditionFailed).Once()

	metrics := []MetricRecord{}
	bus := NewDynamoDBEventBus(db, EventBusConfig{
		EnableMetrics:  true,
		RetryAttempts:  0,
		RetryBaseDelay: 0,
		EmitMetric: func(rec MetricRecord) {
			metrics = append(metrics, rec)
		},
	})

	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	evt := &Event{
		ID:          "evt_1",
		EventType:   "evt",
		TenantID:    "t1",
		SourceID:    "s1",
		PublishedAt: now,
		CreatedAt:   now,
		Payload:     []byte(`{}`),
	}

	id, err := bus.Publish(context.Background(), evt)
	require.NoError(t, err)
	require.Equal(t, "evt_1", id)

	var saw bool
	for _, m := range metrics {
		if m.Name == "PublishDeduped" {
			saw = true
		}
	}
	require.True(t, saw)
}

func TestDynamoDBEventBus_Publish_RetryableErrorThenSuccess_Retries(t *testing.T) {
	t.Parallel()

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q).Twice()
	q.On("WithContext", mock.Anything).Return(q).Twice()
	q.On("IfNotExists").Return(q).Twice()
	q.On("Create").Return(errors.New("ThrottlingException: slow")).Once()
	q.On("Create").Return(nil).Once()

	bus := NewDynamoDBEventBus(db, EventBusConfig{
		RetryAttempts:  1,
		RetryBaseDelay: 0,
	})

	evt := &Event{
		ID:        "evt_1",
		EventType: "evt",
		TenantID:  "t1",
		SourceID:  "s1",
		Payload:   []byte(`{}`),
	}
	id, err := bus.Publish(context.Background(), evt)
	require.NoError(t, err)
	require.Equal(t, "evt_1", id)
}

func TestDynamoDBEventBus_Publish_NonRetryableError_Fails_EmitsMetric(t *testing.T) {
	t.Parallel()

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q).Once()
	q.On("WithContext", mock.Anything).Return(q).Once()
	q.On("IfNotExists").Return(q).Once()
	q.On("Create").Return(errors.New("boom")).Once()

	metrics := []MetricRecord{}
	bus := NewDynamoDBEventBus(db, EventBusConfig{
		EnableMetrics:  true,
		RetryAttempts:  0,
		RetryBaseDelay: 0,
		EmitMetric: func(rec MetricRecord) {
			metrics = append(metrics, rec)
		},
	})

	_, err := bus.Publish(context.Background(), &Event{
		ID:        "evt_1",
		EventType: "evt",
		TenantID:  "t1",
		SourceID:  "s1",
		Payload:   []byte(`{}`),
	})
	require.Error(t, err)

	var saw bool
	for _, m := range metrics {
		if m.Name == "PublishError" {
			saw = true
		}
	}
	require.True(t, saw)
}

func TestDynamoDBEventBus_Query_PartitionKeyAndCursorBranches(t *testing.T) {
	t.Parallel()

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q).Once()
	q.On("WithContext", mock.Anything).Return(q).Once()
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("OrderBy", mock.Anything, mock.Anything).Return(q).Once()
	q.On("Limit", 100).Return(q).Once()
	q.On("Filter", mock.Anything, mock.Anything, mock.Anything).Return(q)

	q.On("AllPaginated", mock.Anything).Return((*tablecore.PaginatedResult)(nil), nil).Once()

	metrics := []MetricRecord{}
	bus := NewDynamoDBEventBus(db, EventBusConfig{
		EnableMetrics: true,
		EmitMetric: func(rec MetricRecord) {
			metrics = append(metrics, rec)
		},
	})

	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	query := &EventQuery{
		TenantID:         "t1",
		EventType:        "evt",
		StartTime:        &start,
		EndTime:          nil,
		Tags:             []string{"", "tag1"},
		Limit:            0,
		LastEvaluatedKey: map[string]any{"cursor": 123}, // wrong type => ignored
	}

	out, err := bus.Query(context.Background(), query)
	require.NoError(t, err)
	require.Len(t, out, 0)
	require.Nil(t, query.NextKey)

	var saw bool
	for _, m := range metrics {
		if m.Name == "QuerySuccess" {
			saw = true
		}
	}
	require.True(t, saw)
}

func TestDynamoDBEventBus_Query_ExecuteQueryError_EmitsMetric(t *testing.T) {
	t.Parallel()

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q).Once()
	q.On("WithContext", mock.Anything).Return(q).Once()
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("Index", mock.Anything).Return(q).Once()
	q.On("OrderBy", mock.Anything, mock.Anything).Return(q).Once()
	q.On("Limit", 100).Return(q).Once()

	q.On("AllPaginated", mock.Anything).Return((*tablecore.PaginatedResult)(nil), errors.New("query failed")).Once()

	metrics := []MetricRecord{}
	bus := NewDynamoDBEventBus(db, EventBusConfig{
		EnableMetrics: true,
		EmitMetric: func(rec MetricRecord) {
			metrics = append(metrics, rec)
		},
	})

	_, err := bus.Query(context.Background(), &EventQuery{TenantID: "t1"})
	require.Error(t, err)

	var saw bool
	for _, m := range metrics {
		if m.Name == "QueryError" {
			saw = true
		}
	}
	require.True(t, saw)
}

func TestSetNextKey_ClearsWhenNoMore(t *testing.T) {
	t.Parallel()

	query := &EventQuery{TenantID: "t1"}
	setNextKey(query, nil)
	require.Nil(t, query.NextKey)

	setNextKey(query, &tablecore.PaginatedResult{HasMore: false, NextCursor: "c"})
	require.Nil(t, query.NextKey)

	setNextKey(query, &tablecore.PaginatedResult{HasMore: true, NextCursor: ""})
	require.Nil(t, query.NextKey)
}

func TestDynamoDBEventBus_GetEvent_ValidationAndNotFound(t *testing.T) {
	t.Parallel()

	bus := NewDynamoDBEventBus(nil, EventBusConfig{})
	_, err := bus.GetEvent(context.Background(), "")
	require.Error(t, err)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q).Once()
	q.On("WithContext", mock.Anything).Return(q).Once()
	q.On("Index", mock.Anything).Return(q).Once()
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("First", mock.Anything).Return(tableerrors.ErrItemNotFound).Once()

	bus = NewDynamoDBEventBus(db, EventBusConfig{})
	_, err = bus.GetEvent(context.Background(), "missing")
	require.Error(t, err)
	require.Contains(t, err.Error(), "event not found")
}

func TestDynamoDBEventBus_DeleteEvent_Success_EmitsMetric(t *testing.T) {
	t.Parallel()

	db := new(tablemocks.MockDB)
	qGet := new(tablemocks.MockQuery)
	qDel := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(qGet).Once()
	db.On("Model", mock.Anything).Return(qDel).Once()

	qGet.On("WithContext", mock.Anything).Return(qGet).Once()
	qGet.On("Index", mock.Anything).Return(qGet).Once()
	qGet.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(qGet)
	qGet.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*Event)
		require.True(t, ok)
		out.PartitionKey = "pk"
		out.SortKey = "sk"
	}).Return(nil).Once()

	qDel.On("WithContext", mock.Anything).Return(qDel).Once()
	qDel.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(qDel)
	qDel.On("Delete").Return(nil).Once()

	metrics := []MetricRecord{}
	bus := NewDynamoDBEventBus(db, EventBusConfig{
		EnableMetrics: true,
		EmitMetric: func(rec MetricRecord) {
			metrics = append(metrics, rec)
		},
	})

	require.NoError(t, bus.DeleteEvent(context.Background(), "e1"))

	var saw bool
	for _, m := range metrics {
		if m.Name == "DeleteSuccess" {
			saw = true
		}
	}
	require.True(t, saw)
}
