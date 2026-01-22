package services

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"
	tablemocks "github.com/theory-cloud/tabletheory/pkg/mocks"
)

func TestApplySortKeyTimeRange_Branches(t *testing.T) {
	t.Parallel()

	start := time.Unix(0, 1000).UTC()
	end := time.Unix(0, 2000).UTC()

	t.Run("between", func(t *testing.T) {
		q := new(tablemocks.MockQuery)
		query := &EventQuery{StartTime: &start, EndTime: &end}

		want := []any{
			fmt.Sprintf("%d#", start.UnixNano()),
			fmt.Sprintf("%d#", end.UnixNano()+1),
		}
		q.On("Where", "SortKey", "BETWEEN", mock.MatchedBy(func(v any) bool {
			got, ok := v.([]any)
			return ok && reflect.DeepEqual(want, got)
		})).Return(q).Once()

		applySortKeyTimeRange(q, query)
		q.AssertExpectations(t)
	})

	t.Run("start_only", func(t *testing.T) {
		q := new(tablemocks.MockQuery)
		query := &EventQuery{StartTime: &start}

		q.On("Where", "SortKey", ">=", fmt.Sprintf("%d#", start.UnixNano())).Return(q).Once()
		applySortKeyTimeRange(q, query)
		q.AssertExpectations(t)
	})

	t.Run("end_only", func(t *testing.T) {
		q := new(tablemocks.MockQuery)
		query := &EventQuery{EndTime: &end}

		q.On("Where", "SortKey", "<", fmt.Sprintf("%d#", end.UnixNano())).Return(q).Once()
		applySortKeyTimeRange(q, query)
		q.AssertExpectations(t)
	})
}

func TestApplyPublishedAtTimeRange_Branches(t *testing.T) {
	t.Parallel()

	start := time.Unix(0, 1000).UTC()
	end := time.Unix(0, 2000).UTC()

	t.Run("between", func(t *testing.T) {
		q := new(tablemocks.MockQuery)
		query := &EventQuery{StartTime: &start, EndTime: &end}

		want := []any{start, end}
		q.On("Where", "PublishedAt", "BETWEEN", mock.MatchedBy(func(v any) bool {
			got, ok := v.([]any)
			return ok && reflect.DeepEqual(want, got)
		})).Return(q).Once()

		applyPublishedAtTimeRange(q, query)
		q.AssertExpectations(t)
	})

	t.Run("start_only", func(t *testing.T) {
		q := new(tablemocks.MockQuery)
		query := &EventQuery{StartTime: &start}

		q.On("Where", "PublishedAt", ">=", start).Return(q).Once()
		applyPublishedAtTimeRange(q, query)
		q.AssertExpectations(t)
	})

	t.Run("end_only", func(t *testing.T) {
		q := new(tablemocks.MockQuery)
		query := &EventQuery{EndTime: &end}

		q.On("Where", "PublishedAt", "<=", end).Return(q).Once()
		applyPublishedAtTimeRange(q, query)
		q.AssertExpectations(t)
	})
}

func TestValidateEventForPublish_AndValidateEventQuery_Errors(t *testing.T) {
	t.Parallel()

	_, _, err := validateEventForPublish(nil)
	require.Error(t, err)

	_, _, err = validateEventForPublish(&Event{})
	require.Error(t, err)

	_, _, err = validateEventForPublish(&Event{EventType: "evt", TenantID: "  "})
	require.Error(t, err)

	require.Error(t, validateEventQuery(nil))
	require.Error(t, validateEventQuery(&EventQuery{}))
}

func TestDynamoDBEventBus_GetEvent_ReturnsErrorOnQueryFailure(t *testing.T) {
	t.Parallel()

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q).Once()
	q.On("WithContext", mock.Anything).Return(q).Once()
	q.On("Index", "event-id-index").Return(q).Once()
	q.On("Where", "ID", "=", "evt_1").Return(q).Once()
	q.On("First", mock.Anything).Return(errors.New("boom")).Once()

	bus := NewDynamoDBEventBus(db, EventBusConfig{})
	_, err := bus.GetEvent(context.Background(), "evt_1")
	require.Error(t, err)
	require.Contains(t, err.Error(), "failed to get event")
}

func TestDynamoDBEventBus_DeleteEvent_DeleteFailure_EmitsMetric(t *testing.T) {
	t.Parallel()

	db := new(tablemocks.MockDB)
	qGet := new(tablemocks.MockQuery)
	qDel := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(qGet).Once()
	db.On("Model", mock.Anything).Return(qDel).Once()

	qGet.On("WithContext", mock.Anything).Return(qGet).Once()
	qGet.On("Index", "event-id-index").Return(qGet).Once()
	qGet.On("Where", "ID", "=", "evt_1").Return(qGet)
	qGet.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*Event)
		require.True(t, ok)
		out.PartitionKey = "pk"
		out.SortKey = "sk"
	}).Return(nil).Once()

	qDel.On("WithContext", mock.Anything).Return(qDel).Once()
	qDel.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(qDel)
	qDel.On("Delete").Return(tableerrors.ErrConditionFailed).Once()

	metrics := []MetricRecord{}
	bus := NewDynamoDBEventBus(db, EventBusConfig{
		EnableMetrics: true,
		EmitMetric: func(rec MetricRecord) {
			metrics = append(metrics, rec)
		},
	})

	err := bus.DeleteEvent(context.Background(), "evt_1")
	require.Error(t, err)
	require.Contains(t, err.Error(), "failed to delete event")

	require.NotEmpty(t, metrics)
	require.Equal(t, "DeleteError", metrics[len(metrics)-1].Name)
}
