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

func TestValidateKey_CoversMissingFields(t *testing.T) {
	t.Parallel()

	require.Error(t, validateKey(RateLimitKey{Resource: "r", Operation: "op"}))
	require.Error(t, validateKey(RateLimitKey{Identifier: "id", Operation: "op"}))
	require.Error(t, validateKey(RateLimitKey{Identifier: "id", Resource: "r"}))
	require.NoError(t, validateKey(RateLimitKey{Identifier: "id", Resource: "r", Operation: "op"}))
}

func TestSetClock_NilResetsToRealClock(t *testing.T) {
	t.Parallel()

	limiter := NewDynamoRateLimiter(nil, DefaultConfig(), NewFixedWindowStrategy(time.Minute, 1))
	limiter.SetClock(nil)
	_, ok := limiter.clock.(RealClock)
	require.True(t, ok, "expected SetClock(nil) to reset clock to RealClock")
}

func TestCountForPrimaryWindow_SlidingWindowSumsCounts(t *testing.T) {
	t.Parallel()

	require.Equal(t, 0, countForPrimaryWindow(NewFixedWindowStrategy(time.Minute, 1), nil, nil))

	windows := []TimeWindow{{Key: "k1"}}
	counts := map[string]int{"k1": 3, "k2": 2}

	require.Equal(t, 3, countForPrimaryWindow(NewFixedWindowStrategy(time.Minute, 1), windows, counts))
	require.Equal(t, 5, countForPrimaryWindow(NewSlidingWindowStrategy(time.Minute, 10, time.Second), windows, counts))
}

func TestCreateSingleWindowEntry_LimitZeroDenies(t *testing.T) {
	t.Parallel()

	limiter := NewDynamoRateLimiter(nil, DefaultConfig(), NewFixedWindowStrategy(time.Minute, 1))
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	window := TimeWindow{Start: now, End: now.Add(time.Minute), Key: "w"}

	decision, err := limiter.createSingleWindowEntry(context.Background(), RateLimitKey{Identifier: "id", Resource: "r", Operation: "op"}, now, window, 0, 0)
	require.NoError(t, err)
	require.False(t, decision.Allowed)
	require.NotNil(t, decision.RetryAfter)
}

func TestCheckAndIncrementSingleWindow_DBError_FailOpenAndFailClosed(t *testing.T) {
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
	ub.On("ExecuteWithResult", mock.Anything).Return(errors.New("db down"))

	cfg := DefaultConfig()
	cfg.FailOpen = true

	limiter := NewDynamoRateLimiter(db, cfg, strategy)
	limiter.SetClock(fixedClock{now: now})

	decision, err := limiter.CheckAndIncrement(context.Background(), RateLimitKey{
		Identifier: "user:123",
		Resource:   "/users",
		Operation:  "GET",
	})
	require.NoError(t, err)
	require.True(t, decision.Allowed)

	cfg = DefaultConfig()
	cfg.FailOpen = false
	limiter = NewDynamoRateLimiter(db, cfg, strategy)
	limiter.SetClock(fixedClock{now: now})
	_, err = limiter.CheckAndIncrement(context.Background(), RateLimitKey{
		Identifier: "user:123",
		Resource:   "/users",
		Operation:  "GET",
	})
	require.Error(t, err)
}

func TestCreateSingleWindowEntry_CreateError_FailOpenAndFailClosed(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
	window := TimeWindow{Start: now.Truncate(time.Minute), End: now.Truncate(time.Minute).Add(time.Minute), Key: "w"}

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("IfNotExists").Return(q)
	q.On("Create").Return(errors.New("create failed"))

	cfg := DefaultConfig()
	cfg.FailOpen = true
	limiter := NewDynamoRateLimiter(db, cfg, NewFixedWindowStrategy(time.Minute, 10))

	decision, err := limiter.createSingleWindowEntry(context.Background(), RateLimitKey{Identifier: "id", Resource: "r", Operation: "op"}, now, window, 10, 0)
	require.NoError(t, err)
	require.True(t, decision.Allowed)

	cfg.FailOpen = false
	limiter = NewDynamoRateLimiter(db, cfg, NewFixedWindowStrategy(time.Minute, 10))
	_, err = limiter.createSingleWindowEntry(context.Background(), RateLimitKey{Identifier: "id", Resource: "r", Operation: "op"}, now, window, 10, 0)
	require.Error(t, err)
}

func TestHandleMultiWindowIncrementError_ConditionFailedSetsRetryAfter(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 1, 1, 0, 5, 30, 0, time.UTC)
	strategy := NewMultiWindowStrategy([]WindowConfig{{Duration: time.Minute, MaxRequests: 1}})

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("First", mock.Anything).Run(func(args mock.Arguments) {
		record, ok := args.Get(0).(*RateLimitEntry)
		require.True(t, ok)
		record.Count = 1
	}).Return(nil)

	limiter := NewDynamoRateLimiter(db, DefaultConfig(), strategy)
	limiter.SetClock(fixedClock{now: now})

	decision, err := limiter.handleMultiWindowIncrementError(context.Background(), RateLimitKey{Identifier: "id", Resource: "r", Operation: "op"}, now, strategy.CalculateWindows(now), 1, tableerrors.ErrConditionFailed)
	require.NoError(t, err)
	require.False(t, decision.Allowed)
	require.NotNil(t, decision.RetryAfter)
}
