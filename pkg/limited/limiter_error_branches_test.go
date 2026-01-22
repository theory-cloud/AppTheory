package limited

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"
	tablemocks "github.com/theory-cloud/tabletheory/pkg/mocks"
)

func TestDynamoRateLimiter_CheckLimit_FailsClosedOnQueryError_WhenFailOpenFalse(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("First", mock.Anything).Return(errors.New("boom"))

	cfg := DefaultConfig()
	cfg.FailOpen = false

	limiter := NewDynamoRateLimiter(db, cfg, NewFixedWindowStrategy(time.Minute, 1))
	limiter.SetClock(fixedClock{now: now})

	_, err := limiter.CheckLimit(context.Background(), RateLimitKey{
		Identifier: "id",
		Resource:   "r",
		Operation:  "op",
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "failed to check rate limit")
}

func TestDynamoRateLimiter_GetUsage_ReturnsErrorOnMinuteQueryFailure(t *testing.T) {
	t.Parallel()

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("First", mock.Anything).Return(errors.New("boom")).Once()

	limiter := NewDynamoRateLimiter(db, DefaultConfig(), NewFixedWindowStrategy(time.Minute, 1))
	_, err := limiter.GetUsage(context.Background(), RateLimitKey{
		Identifier: "id",
		Resource:   "r",
		Operation:  "op",
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "failed to get minute usage")
}

func TestDynamoRateLimiter_GetUsage_ReturnsErrorOnHourQueryFailure(t *testing.T) {
	t.Parallel()

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)

	q.On("First", mock.Anything).Return(tableerrors.ErrItemNotFound).Once()
	q.On("First", mock.Anything).Return(errors.New("boom")).Once()

	limiter := NewDynamoRateLimiter(db, DefaultConfig(), NewFixedWindowStrategy(time.Minute, 1))
	_, err := limiter.GetUsage(context.Background(), RateLimitKey{
		Identifier: "id",
		Resource:   "r",
		Operation:  "op",
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "failed to get hour usage")
}

func TestDynamoRateLimiter_CheckAndIncrement_ReturnsErrorOnUpdateFailure_WhenFailOpenFalse(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
	strategy := NewFixedWindowStrategy(time.Minute, 10)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	ub := new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("UpdateBuilder").Return(ub)

	ub.On("Add", "Count", int64(1)).Return(ub)
	ub.On("Set", "UpdatedAt", now).Return(ub)
	ub.On("Condition", "Count", "<", 10).Return()
	ub.On("ExecuteWithResult", mock.Anything).Return(errors.New("boom"))

	cfg := DefaultConfig()
	cfg.FailOpen = false
	limiter := NewDynamoRateLimiter(db, cfg, strategy)
	limiter.SetClock(fixedClock{now: now})

	_, err := limiter.CheckAndIncrement(context.Background(), RateLimitKey{
		Identifier: "id",
		Resource:   "r",
		Operation:  "op",
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "failed to check and increment rate limit")
}

func TestDynamoRateLimiter_CheckAndIncrement_ConditionFailed_LoadEntryError_FailsClosedWhenFailOpenFalse(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
	strategy := NewFixedWindowStrategy(time.Minute, 10)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	ub := new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("UpdateBuilder").Return(ub)

	ub.On("Add", "Count", int64(1)).Return(ub)
	ub.On("Set", "UpdatedAt", now).Return(ub)
	ub.On("Condition", "Count", "<", 10).Return()
	ub.On("ExecuteWithResult", mock.Anything).Return(tableerrors.ErrConditionFailed)

	q.On("First", mock.Anything).Return(errors.New("boom")).Once()

	cfg := DefaultConfig()
	cfg.FailOpen = false
	limiter := NewDynamoRateLimiter(db, cfg, strategy)
	limiter.SetClock(fixedClock{now: now})

	_, err := limiter.CheckAndIncrement(context.Background(), RateLimitKey{
		Identifier: "id",
		Resource:   "r",
		Operation:  "op",
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "failed to load rate limit entry")
}

func TestDynamoRateLimiter_CreateSingleWindowEntry_LimitZero_Denies(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
	strategy := NewFixedWindowStrategy(time.Minute, 0)

	limiter := NewDynamoRateLimiter(nil, DefaultConfig(), strategy)
	limiter.SetClock(fixedClock{now: now})

	window := strategy.CalculateWindows(now)[0]
	decision, err := limiter.createSingleWindowEntry(context.Background(), RateLimitKey{
		Identifier: "id",
		Resource:   "r",
		Operation:  "op",
	}, now, window, 0, 0)
	require.NoError(t, err)
	require.False(t, decision.Allowed)
	require.NotNil(t, decision.RetryAfter)
}
