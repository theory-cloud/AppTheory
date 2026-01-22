package limited

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"
	tablemocks "github.com/theory-cloud/tabletheory/pkg/mocks"
)

func TestDynamoRateLimiter_String(t *testing.T) {
	var nilLimiter *DynamoRateLimiter
	require.Equal(t, "limited.DynamoRateLimiter<nil>", nilLimiter.String())

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	db.On("Model", mock.Anything).Return(q)
	limiter := NewDynamoRateLimiter(db, DefaultConfig(), NewFixedWindowStrategy(time.Minute, 1))
	require.Contains(t, limiter.String(), "fail_open:")
}

func TestDynamoRateLimiter_RecordRequest_SingleWindow(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
	strategy := NewFixedWindowStrategy(time.Minute, 2)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	ub := new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("UpdateBuilder").Return(ub)

	ub.On("Add", "Count", int64(1)).Return(ub)
	ub.On("SetIfNotExists", mock.Anything, mock.Anything, mock.Anything).Return(ub)
	ub.On("Set", "UpdatedAt", mock.Anything).Return(ub)
	ub.On("Execute").Return(nil)

	limiter := NewDynamoRateLimiter(db, DefaultConfig(), strategy)
	limiter.SetClock(fixedClock{now: now})

	err := limiter.RecordRequest(context.Background(), RateLimitKey{
		Identifier: "user:123",
		Resource:   "/users",
		Operation:  "GET",
	})
	require.NoError(t, err)
}

func TestDynamoRateLimiter_RecordRequest_NoWindows(t *testing.T) {
	db := new(tablemocks.MockDB)
	strategy := NewFixedWindowStrategy(0, 0)
	limiter := NewDynamoRateLimiter(db, DefaultConfig(), strategy)

	err := limiter.RecordRequest(context.Background(), RateLimitKey{
		Identifier: "user:123",
		Resource:   "/users",
		Operation:  "GET",
	})
	require.Error(t, err)
}

func TestDynamoRateLimiter_GetUsage_ReturnsCountsAndOverrides(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
	strategy := NewFixedWindowStrategy(time.Minute, 2)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)

	var firstCalls int
	q.On("First", mock.Anything).Run(func(args mock.Arguments) {
		firstCalls++
		record, ok := args.Get(0).(*RateLimitEntry)
		require.True(t, ok)
		if firstCalls == 1 {
			record.Count = 7
			return
		}
		record.Count = 42
	}).Return(nil)

	cfg := DefaultConfig()
	cfg.IdentifierLimits["user:123"] = Limit{RequestsPerMinute: 5, RequestsPerHour: 10}

	limiter := NewDynamoRateLimiter(db, cfg, strategy)
	limiter.SetClock(fixedClock{now: now})

	stats, err := limiter.GetUsage(context.Background(), RateLimitKey{
		Identifier: "user:123",
		Resource:   "/users",
		Operation:  "GET",
	})
	require.NoError(t, err)
	require.Equal(t, 7, stats.CurrentMinute.Count)
	require.Equal(t, 42, stats.CurrentHour.Count)
	require.Equal(t, 5, stats.CurrentMinute.Limit)
	require.Equal(t, 10, stats.CurrentHour.Limit)
	require.Equal(t, 42, stats.DailyTotal)
}

func TestDynamoRateLimiter_CheckAndIncrement_MultiWindowFallback(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 5, 30, 0, time.UTC)
	strategy := NewMultiWindowStrategy([]WindowConfig{
		{Duration: time.Minute, MaxRequests: 2},
		{Duration: time.Hour, MaxRequests: 1000},
	})

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	ub := new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("First", mock.Anything).Return(tableerrors.ErrItemNotFound)
	q.On("UpdateBuilder").Return(ub)

	ub.On("Add", "Count", int64(1)).Return(ub)
	ub.On("SetIfNotExists", mock.Anything, mock.Anything, mock.Anything).Return(ub)
	ub.On("Set", "UpdatedAt", mock.Anything).Return(ub)
	ub.On("Execute").Return(nil)

	limiter := NewDynamoRateLimiter(db, DefaultConfig(), strategy)
	limiter.SetClock(fixedClock{now: now})

	decision, err := limiter.CheckAndIncrement(context.Background(), RateLimitKey{
		Identifier: "user:123",
		Resource:   "/users",
		Operation:  "GET",
	})
	require.NoError(t, err)
	require.True(t, decision.Allowed)
	require.Equal(t, 1, decision.CurrentCount)
	require.Equal(t, 2, decision.Limit)
}
