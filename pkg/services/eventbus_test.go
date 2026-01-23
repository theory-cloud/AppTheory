package services

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"
	tablemocks "github.com/theory-cloud/tabletheory/pkg/mocks"
)

func TestNewEvent_SetsDefaultsAndKeys(t *testing.T) {
	t.Parallel()

	evt, err := NewEvent("partner.created", "tenant_1", "source_1", map[string]any{"ok": true})
	require.NoError(t, err)

	require.NotEmpty(t, evt.ID)
	require.Equal(t, "partner.created", evt.EventType)
	require.Equal(t, "tenant_1", evt.TenantID)
	require.Equal(t, "source_1", evt.SourceID)
	require.False(t, evt.PublishedAt.IsZero())
	require.False(t, evt.CreatedAt.IsZero())
	require.NotEmpty(t, evt.PartitionKey)
	require.NotEmpty(t, evt.SortKey)
	require.Equal(t, 1, evt.Version)
}

func TestMemoryEventBus_PublishAndQuery(t *testing.T) {
	t.Parallel()

	bus := NewMemoryEventBus()

	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	evt := &Event{
		ID:          "01HZZZZZZZZZZZZZZZZZZZZZZZ",
		EventType:   "partner.created",
		TenantID:    "tenant_1",
		SourceID:    "source_1",
		PublishedAt: now,
		CreatedAt:   now,
		Tags:        []string{"audit", "partner"},
		Payload:     []byte(`{"ok":true}`),
	}

	_, err := bus.Publish(context.Background(), evt)
	require.NoError(t, err)

	results, err := bus.Query(context.Background(), &EventQuery{
		TenantID:  "tenant_1",
		EventType: "partner.created",
		Tags:      []string{"audit"},
		Limit:     10,
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Equal(t, evt.ID, results[0].ID)
}

func TestMemoryEventBus_QueryByEventTypeOnly(t *testing.T) {
	t.Parallel()

	bus := NewMemoryEventBus()

	_, err := bus.Publish(context.Background(), &Event{
		ID:        "01HYYYYYYYYYYYYYYYYYYYYYYYYY",
		EventType: "staff.user.created",
		TenantID:  "autheory",
		SourceID:  "autheory",
		Payload:   []byte(`{}`),
	})
	require.NoError(t, err)

	results, err := bus.Query(context.Background(), &EventQuery{
		EventType: "staff.user.created",
		Limit:     10,
	})
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Equal(t, "autheory", results[0].TenantID)
}

func TestMemoryEventBus_Pagination(t *testing.T) {
	t.Parallel()

	bus := NewMemoryEventBus()

	base := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	for i := 0; i < 3; i++ {
		_, err := bus.Publish(context.Background(), &Event{
			ID:          "id-" + string(rune('a'+i)),
			EventType:   "partner.created",
			TenantID:    "tenant_1",
			SourceID:    "source_1",
			PublishedAt: base.Add(time.Duration(i) * time.Second),
			CreatedAt:   base.Add(time.Duration(i) * time.Second),
			Payload:     []byte(`{}`),
		})
		require.NoError(t, err)
	}

	q := &EventQuery{
		TenantID:  "tenant_1",
		EventType: "partner.created",
		Limit:     2,
	}
	first, err := bus.Query(context.Background(), q)
	require.NoError(t, err)
	require.Len(t, first, 2)
	require.NotNil(t, q.NextKey)

	q.LastEvaluatedKey = q.NextKey
	q.NextKey = nil
	second, err := bus.Query(context.Background(), q)
	require.NoError(t, err)
	require.Len(t, second, 1)
	require.Nil(t, q.NextKey)
}

func TestDynamoDBEventBus_Publish_DedupesOnConditionFailed(t *testing.T) {
	t.Parallel()

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("IfNotExists").Return(q)
	q.On("Create").Return(tableerrors.ErrConditionFailed)

	bus := NewDynamoDBEventBus(db, EventBusConfig{
		EnableMetrics: false,
	})

	evt := &Event{
		ID:        "01HTESTEVENTBUSDEDUPE00000000",
		EventType: "partner.created",
		TenantID:  "tenant_1",
		SourceID:  "source_1",
		Payload:   []byte(`{"ok":true}`),
	}

	id, err := bus.Publish(context.Background(), evt)
	require.NoError(t, err)
	require.Equal(t, evt.ID, id)

	db.AssertExpectations(t)
	q.AssertExpectations(t)
}
