package services

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	tablecore "github.com/theory-cloud/tabletheory/pkg/core"
	tablemocks "github.com/theory-cloud/tabletheory/pkg/mocks"
)

func TestMemoryEventBus_Subscribe_ValidationAndHandlerError(t *testing.T) {
	t.Parallel()

	bus := NewMemoryEventBus()

	require.Error(t, bus.Subscribe(context.Background(), "", func(context.Context, *Event) error { return nil }))
	require.Error(t, bus.Subscribe(context.Background(), "x", nil))

	var called int
	require.NoError(t, bus.Subscribe(context.Background(), "evt", func(_ context.Context, _ *Event) error {
		called++
		return errors.New("boom")
	}))

	id, err := bus.Publish(context.Background(), &Event{
		ID:        "evt-1",
		EventType: "evt",
		TenantID:  "t1",
		SourceID:  "s1",
		Payload:   []byte(`{}`),
	})
	require.Error(t, err)
	require.Equal(t, "evt-1", id)
	require.Equal(t, 1, called)
}

func TestMemoryEventBus_GetAndDeleteEvent_Validation(t *testing.T) {
	t.Parallel()

	bus := NewMemoryEventBus()

	_, err := bus.Publish(context.TODO(), &Event{
		EventType: "evt",
		TenantID:  "t1",
		SourceID:  "s1",
		Payload:   []byte(`{}`),
	})
	require.NoError(t, err)

	_, err = bus.GetEvent(context.Background(), "")
	require.Error(t, err)

	_, err = bus.GetEvent(context.Background(), "missing")
	require.Error(t, err)

	// Delete validation.
	require.Error(t, bus.DeleteEvent(context.Background(), ""))
	require.Error(t, bus.DeleteEvent(context.Background(), "missing"))
}

func TestMemoryEventBus_Query_InvalidCursorAndPaginationHelpers(t *testing.T) {
	t.Parallel()

	bus := NewMemoryEventBus()

	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 2; i++ {
		_, err := bus.Publish(context.Background(), &Event{
			ID:          "id-" + string(rune('a'+i)),
			EventType:   "evt",
			TenantID:    "t1",
			SourceID:    "s1",
			PublishedAt: now.Add(time.Duration(i) * time.Second),
			CreatedAt:   now.Add(time.Duration(i) * time.Second),
			Tags:        []string{"a"},
			Payload:     []byte(`{}`),
		})
		require.NoError(t, err)
	}

	// Invalid base64 cursor.
	q := &EventQuery{
		TenantID:         "t1",
		EventType:        "evt",
		Limit:            1,
		LastEvaluatedKey: map[string]any{"cursor": "!!!"},
	}
	_, err := bus.Query(context.Background(), q)
	require.Error(t, err)

	// Negative cursor.
	neg := base64.RawURLEncoding.EncodeToString([]byte("-1"))
	q.LastEvaluatedKey = map[string]any{"cursor": neg}
	_, err = bus.Query(context.Background(), q)
	require.Error(t, err)

	// paginateEvents clamps offsets.
	page, next := paginateEvents([]*Event{{ID: "a"}, {ID: "b"}}, -5, 1)
	require.Len(t, page, 1)
	require.Equal(t, 1, next)

	page, next = paginateEvents([]*Event{{ID: "a"}}, 10, 5)
	require.Len(t, page, 0)
	require.Equal(t, -1, next)
}

func TestDynamoDBEventBus_Publish_Success_EmitsMetric(t *testing.T) {
	t.Parallel()

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q).Once()
	q.On("WithContext", mock.Anything).Return(q).Once()
	q.On("IfNotExists").Return(q).Once()
	q.On("Create").Return(nil).Once()

	metrics := []MetricRecord{}
	bus := NewDynamoDBEventBus(db, EventBusConfig{
		EnableMetrics:    true,
		MetricsNamespace: "AppTheory/EventBus",
		RetryAttempts:    0,
		RetryBaseDelay:   0,
		MaxBatchSize:     25,
		EmitMetric: func(rec MetricRecord) {
			metrics = append(metrics, rec)
		},
	})

	evt := &Event{
		EventType: "evt",
		TenantID:  "t1",
		SourceID:  "s1",
		Payload:   []byte(`{}`),
	}
	id, err := bus.Publish(context.Background(), evt)
	require.NoError(t, err)
	require.NotEmpty(t, id)
	require.NotEmpty(t, evt.PartitionKey)
	require.NotEmpty(t, evt.SortKey)
	require.NotZero(t, evt.TTL)

	var sawPublish bool
	for _, m := range metrics {
		if m.Name == "PublishSuccess" {
			sawPublish = true
		}
	}
	require.True(t, sawPublish)
}

func TestDynamoDBEventBus_Query_GSI_SetsNextKey_EmitsMetric(t *testing.T) {
	t.Parallel()

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q).Once()
	q.On("WithContext", mock.Anything).Return(q).Once()
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("Index", mock.Anything).Return(q).Once()
	q.On("OrderBy", mock.Anything, mock.Anything).Return(q).Once()
	q.On("Limit", 100).Return(q).Once()
	q.On("Filter", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("Cursor", mock.Anything).Return(q).Once()

	page := &tablecore.PaginatedResult{HasMore: true, NextCursor: "cursor_1"}
	q.On("AllPaginated", mock.Anything).Run(func(args mock.Arguments) {
		dest, ok := args.Get(0).(*[]Event)
		require.True(t, ok)
		*dest = append(*dest, Event{ID: "e1", TenantID: "t1", EventType: "evt"})
	}).Return(page, nil).Once()

	metrics := []MetricRecord{}
	bus := NewDynamoDBEventBus(db, EventBusConfig{
		EnableMetrics:    true,
		MetricsNamespace: "AppTheory/EventBus",
		RetryAttempts:    0,
		RetryBaseDelay:   0,
		MaxBatchSize:     25,
		EmitMetric: func(rec MetricRecord) {
			metrics = append(metrics, rec)
		},
	})

	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	end := start.Add(time.Minute)
	query := &EventQuery{
		TenantID:         "t1",
		EventType:        "",
		Tags:             []string{"", "tag1"},
		Limit:            0,
		StartTime:        &start,
		EndTime:          &end,
		LastEvaluatedKey: map[string]any{"cursor": "c0"},
	}
	events, err := bus.Query(context.Background(), query)
	require.NoError(t, err)
	require.Len(t, events, 1)
	require.NotNil(t, query.NextKey)

	var sawQuery bool
	for _, m := range metrics {
		if m.Name == "QuerySuccess" {
			sawQuery = true
		}
	}
	require.True(t, sawQuery)
}

func TestDynamoDBEventBus_DeleteEvent_DeleteError_EmitsMetric(t *testing.T) {
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
	qDel.On("Delete").Return(errors.New("delete failed")).Once()

	metrics := []MetricRecord{}
	bus := NewDynamoDBEventBus(db, EventBusConfig{
		EnableMetrics:    true,
		MetricsNamespace: "AppTheory/EventBus",
		EmitMetric: func(rec MetricRecord) {
			metrics = append(metrics, rec)
		},
	})

	err := bus.DeleteEvent(context.Background(), "e1")
	require.Error(t, err)

	var sawDeleteErr bool
	for _, m := range metrics {
		if m.Name == "DeleteError" {
			sawDeleteErr = true
		}
	}
	require.True(t, sawDeleteErr)
}
