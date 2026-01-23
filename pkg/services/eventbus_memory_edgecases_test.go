package services

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestMemoryEventBus_Publish_ValidatesNilEventAndSetsDefaults(t *testing.T) {
	t.Parallel()

	bus := NewMemoryEventBus()

	_, err := bus.Publish(context.Background(), nil)
	require.Error(t, err)

	var called int
	bus.handlers["evt"] = []EventHandler{
		nil,
		func(_ context.Context, e *Event) error {
			called++
			require.NotNil(t, e)
			require.NotEmpty(t, e.ID)
			return nil
		},
	}

	evt := &Event{
		EventType: "evt",
		TenantID:  " t1 ",
		SourceID:  "s1",
		Payload:   []byte(`{}`),
	}

	id, err := bus.Publish(context.TODO(), evt)
	require.NoError(t, err)
	require.NotEmpty(t, id)
	require.Equal(t, 1, called)
	require.NotZero(t, evt.PublishedAt)
	require.NotZero(t, evt.CreatedAt)
	require.Equal(t, "t1#evt", evt.PartitionKey)
	require.Contains(t, evt.SortKey, "#"+evt.ID)
}

func TestMemoryEventBus_Query_ValidationAndCursorType(t *testing.T) {
	t.Parallel()

	bus := NewMemoryEventBus()

	_, err := bus.Query(context.Background(), nil)
	require.Error(t, err)

	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 2; i++ {
		_, pubErr := bus.Publish(context.Background(), &Event{
			ID:          "id-" + string(rune('a'+i)),
			EventType:   "evt",
			TenantID:    "t1",
			SourceID:    "s1",
			PublishedAt: now.Add(time.Duration(i) * time.Second),
			CreatedAt:   now.Add(time.Duration(i) * time.Second),
			Payload:     []byte(`{}`),
		})
		require.NoError(t, pubErr)
	}

	q := &EventQuery{
		TenantID:         "t1",
		EventType:        "evt",
		Limit:            1,
		LastEvaluatedKey: map[string]any{"cursor": 123},
	}
	results, err := bus.Query(context.Background(), q)
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.NotNil(t, q.NextKey)
}

func TestMemoryEventBus_GetAndDelete_SuccessAndCopies(t *testing.T) {
	t.Parallel()

	bus := NewMemoryEventBus()

	id, err := bus.Publish(context.Background(), &Event{
		ID:        "evt-1",
		EventType: "evt",
		TenantID:  "t1",
		SourceID:  "s1",
		Payload:   []byte(`{"ok":true}`),
	})
	require.NoError(t, err)

	first, err := bus.GetEvent(context.Background(), id)
	require.NoError(t, err)
	first.Payload = []byte(`{"ok":false}`)

	second, err := bus.GetEvent(context.Background(), id)
	require.NoError(t, err)
	require.Equal(t, `{"ok":true}`, string(second.Payload))

	require.NoError(t, bus.DeleteEvent(context.Background(), id))
	_, err = bus.GetEvent(context.Background(), id)
	require.Error(t, err)
}

func TestEventMatchesQuery_CoversBranches(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	evt := &Event{
		EventType:   "evt",
		TenantID:    "t1",
		PublishedAt: now,
		Tags:        []string{"a", "b"},
	}

	require.False(t, eventMatchesQuery(nil, &EventQuery{}))
	require.False(t, eventMatchesQuery(evt, nil))

	require.False(t, eventMatchesQuery(evt, &EventQuery{TenantID: "other"}))
	require.False(t, eventMatchesQuery(evt, &EventQuery{EventType: "other"}))

	start := now.Add(time.Second)
	require.False(t, eventMatchesQuery(evt, &EventQuery{StartTime: &start}))

	end := now.Add(-time.Second)
	require.False(t, eventMatchesQuery(evt, &EventQuery{EndTime: &end}))

	require.False(t, eventMatchesQuery(evt, &EventQuery{Tags: []string{"c"}}))

	// Empty tags should be ignored.
	require.True(t, eventMatchesQuery(evt, &EventQuery{Tags: []string{"", " a "}}))
}

func TestMemoryEventBus_SnapshotAndCopyEvents_SkipNil(t *testing.T) {
	t.Parallel()

	bus := NewMemoryEventBus()
	bus.events["nil"] = nil
	bus.events["evt"] = &Event{ID: "evt", EventType: "evt", TenantID: "t1", PublishedAt: time.Now().UTC()}

	snapshot := bus.snapshotEvents()
	require.Len(t, snapshot, 1)

	copied := copyEvents([]*Event{nil, snapshot[0]})
	require.Len(t, copied, 1)
	require.Equal(t, snapshot[0].ID, copied[0].ID)
}
