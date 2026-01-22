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

func TestNewDynamoRateLimiter_DefaultsWhenNilInputs(t *testing.T) {
	t.Parallel()

	limiter := NewDynamoRateLimiter(nil, nil, nil)
	require.NotNil(t, limiter)
	require.NotNil(t, limiter.config)
	require.NotNil(t, limiter.strategy)
	_, ok := limiter.clock.(RealClock)
	require.True(t, ok, "expected default clock to be RealClock")
	_, ok = limiter.strategy.(*FixedWindowStrategy)
	require.True(t, ok, "expected default strategy to be FixedWindowStrategy")
}

func TestMaxRequestsForWindow_ParsesDurationAndFallbacks(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	strategy := NewMultiWindowStrategy([]WindowConfig{
		{Duration: time.Minute, MaxRequests: 5},
		{Duration: time.Hour, MaxRequests: 10},
	})

	require.Equal(t, 0, maxRequestsForWindow(nil, TimeWindow{Key: "x_1m0s"}))
	require.Equal(t, 0, maxRequestsForWindow(NewMultiWindowStrategy(nil), TimeWindow{Key: "x_1m0s"}))
	require.Equal(t, 5, maxRequestsForWindow(strategy, TimeWindow{Key: "x_" + time.Minute.String()}))
	require.Equal(t, 5, maxRequestsForWindow(strategy, TimeWindow{Key: "x_bad"}), "expected fallback to first window")

	_ = now
}

func TestResetTimeForDecision_MultiWindow_SelectsLatestReset(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	minEnd := now.Add(time.Minute)
	hourEnd := now.Add(time.Hour)

	strategy := NewMultiWindowStrategy([]WindowConfig{
		{Duration: time.Minute, MaxRequests: 1},
		{Duration: time.Hour, MaxRequests: 2},
	})
	windows := []TimeWindow{
		{Key: "k_" + time.Minute.String(), End: minEnd},
		{Key: "k_" + time.Hour.String(), End: hourEnd},
	}
	counts := map[string]int{
		windows[0].Key: 1,
		windows[1].Key: 2,
	}

	reset := resetTimeForDecision(strategy, now, windows, counts, false)
	require.True(t, reset.Equal(hourEnd), "expected latest exceeded reset time")

	// maxAllowed <= 0 branch.
	strategy = NewMultiWindowStrategy([]WindowConfig{
		{Duration: time.Minute, MaxRequests: 1},
		{Duration: time.Hour, MaxRequests: 0},
	})
	reset = resetTimeForDecision(strategy, now, windows, counts, false)
	require.True(t, reset.Equal(hourEnd), "expected latest reset when a window has no max")

	// Allowed path returns primary window end.
	reset = resetTimeForDecision(strategy, now, windows, counts, true)
	require.True(t, reset.Equal(minEnd))

	// Defensive: empty windows returns now.
	reset = resetTimeForDecision(strategy, now, nil, counts, false)
	require.True(t, reset.Equal(now))
}

func TestLoadPrimaryWindowCount_NotFoundAndError(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
	window := TimeWindow{Start: now.Truncate(time.Minute), End: now.Truncate(time.Minute).Add(time.Minute)}

	// Not found => (0, nil).
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	db.On("Model", mock.Anything).Return(q).Once()
	q.On("WithContext", mock.Anything).Return(q).Once()
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q).Twice()
	q.On("First", mock.Anything).Return(tableerrors.ErrItemNotFound).Once()

	limiter := NewDynamoRateLimiter(db, DefaultConfig(), NewMultiWindowStrategy([]WindowConfig{{Duration: time.Minute, MaxRequests: 1}}))
	limiter.SetClock(fixedClock{now: now})

	count, err := limiter.loadPrimaryWindowCount(context.Background(), RateLimitKey{Identifier: "id", Resource: "r", Operation: "op"}, window)
	require.NoError(t, err)
	require.Equal(t, 0, count)

	// Other error => propagated.
	db = new(tablemocks.MockDB)
	q = new(tablemocks.MockQuery)
	db.On("Model", mock.Anything).Return(q).Once()
	q.On("WithContext", mock.Anything).Return(q).Once()
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q).Twice()
	q.On("First", mock.Anything).Return(errors.New("db down")).Once()

	limiter = NewDynamoRateLimiter(db, DefaultConfig(), NewMultiWindowStrategy([]WindowConfig{{Duration: time.Minute, MaxRequests: 1}}))
	limiter.SetClock(fixedClock{now: now})

	_, err = limiter.loadPrimaryWindowCount(context.Background(), RateLimitKey{Identifier: "id", Resource: "r", Operation: "op"}, window)
	require.Error(t, err)
}

func TestCheckAndIncrementMultiWindow_Fallback_RecordRequestSuccessAndError(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
	strategy := NewMultiWindowStrategy([]WindowConfig{
		{Duration: time.Minute, MaxRequests: 10},
		{Duration: time.Hour, MaxRequests: 100},
	})

	// DB without TransactWrite => fallback path. Not found for CheckLimit, then update fails.
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	ub := new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q).Times(3)
	q.On("WithContext", mock.Anything).Return(q).Times(3)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("First", mock.Anything).Return(tableerrors.ErrItemNotFound).Twice()
	q.On("UpdateBuilder").Return(ub).Once()

	ub.On("Add", "Count", int64(1)).Return(ub).Once()
	ub.On("SetIfNotExists", mock.Anything, mock.Anything, mock.Anything).Return(ub)
	ub.On("Set", mock.Anything, mock.Anything).Return(ub)
	ub.On("Execute").Return(errors.New("update failed")).Once()

	cfg := DefaultConfig()
	cfg.FailOpen = true
	limiter := NewDynamoRateLimiter(db, cfg, strategy)
	limiter.SetClock(fixedClock{now: now})

	decision, err := limiter.CheckAndIncrement(context.Background(), RateLimitKey{Identifier: "id", Resource: "r", Operation: "op"})
	require.NoError(t, err)
	require.True(t, decision.Allowed)

	// Same failure path but FailOpen=false should return an error.
	db = new(tablemocks.MockDB)
	q = new(tablemocks.MockQuery)
	ub = new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q).Times(3)
	q.On("WithContext", mock.Anything).Return(q).Times(3)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("First", mock.Anything).Return(tableerrors.ErrItemNotFound).Twice()
	q.On("UpdateBuilder").Return(ub).Once()

	ub.On("Add", "Count", int64(1)).Return(ub).Once()
	ub.On("SetIfNotExists", mock.Anything, mock.Anything, mock.Anything).Return(ub)
	ub.On("Set", mock.Anything, mock.Anything).Return(ub)
	ub.On("Execute").Return(errors.New("update failed")).Once()

	cfg.FailOpen = false
	limiter = NewDynamoRateLimiter(db, cfg, strategy)
	limiter.SetClock(fixedClock{now: now})
	_, err = limiter.CheckAndIncrement(context.Background(), RateLimitKey{Identifier: "id", Resource: "r", Operation: "op"})
	require.Error(t, err)

	// Successful RecordRequest increments decision.CurrentCount.
	db = new(tablemocks.MockDB)
	q = new(tablemocks.MockQuery)
	ub = new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q).Times(4)
	q.On("WithContext", mock.Anything).Return(q).Times(4)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("First", mock.Anything).Return(tableerrors.ErrItemNotFound).Twice()
	q.On("UpdateBuilder").Return(ub).Twice()

	ub.On("Add", "Count", int64(1)).Return(ub)
	ub.On("SetIfNotExists", mock.Anything, mock.Anything, mock.Anything).Return(ub)
	ub.On("Set", mock.Anything, mock.Anything).Return(ub)
	ub.On("Execute").Return(nil)

	limiter = NewDynamoRateLimiter(db, DefaultConfig(), strategy)
	limiter.SetClock(fixedClock{now: now})

	decision, err = limiter.CheckAndIncrement(context.Background(), RateLimitKey{Identifier: "id", Resource: "r", Operation: "op"})
	require.NoError(t, err)
	require.True(t, decision.Allowed)
	require.Equal(t, 1, decision.CurrentCount)
}

func TestCheckAndIncrementMultiWindow_TransactPath_SuccessAndLoadErrorFailOpen(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
	strategy := NewMultiWindowStrategy([]WindowConfig{{Duration: time.Minute, MaxRequests: 10}})

	db := tablemocks.NewMockExtendedDBStrict()
	q := new(tablemocks.MockQuery)
	db.On("TransactWrite", mock.Anything, mock.Anything).Return(nil).Once()
	db.On("Model", mock.Anything).Return(q).Once()
	q.On("WithContext", mock.Anything).Return(q).Once()
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q).Twice()
	q.On("First", mock.Anything).Run(func(args mock.Arguments) {
		record, ok := args.Get(0).(*RateLimitEntry)
		require.True(t, ok)
		record.Count = 3
	}).Return(nil).Once()

	limiter := NewDynamoRateLimiter(db, DefaultConfig(), strategy)
	limiter.SetClock(fixedClock{now: now})

	decision, err := limiter.CheckAndIncrement(context.Background(), RateLimitKey{Identifier: "id", Resource: "r", Operation: "op"})
	require.NoError(t, err)
	require.True(t, decision.Allowed)
	require.Equal(t, 3, decision.CurrentCount)

	// LoadPrimaryWindowCount error with FailOpen.
	db = tablemocks.NewMockExtendedDBStrict()
	q = new(tablemocks.MockQuery)
	db.On("TransactWrite", mock.Anything, mock.Anything).Return(nil).Once()
	db.On("Model", mock.Anything).Return(q).Once()
	q.On("WithContext", mock.Anything).Return(q).Once()
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q).Twice()
	q.On("First", mock.Anything).Return(errors.New("db down")).Once()

	cfg := DefaultConfig()
	cfg.FailOpen = true
	limiter = NewDynamoRateLimiter(db, cfg, strategy)
	limiter.SetClock(fixedClock{now: now})

	decision, err = limiter.CheckAndIncrement(context.Background(), RateLimitKey{Identifier: "id", Resource: "r", Operation: "op"})
	require.NoError(t, err)
	require.True(t, decision.Allowed)
}

func TestCheckAndIncrementMultiWindow_PrimaryLimitZeroDenies(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
	strategy := NewMultiWindowStrategy([]WindowConfig{{Duration: time.Minute, MaxRequests: 0}})
	limiter := NewDynamoRateLimiter(nil, DefaultConfig(), strategy)
	limiter.SetClock(fixedClock{now: now})

	decision, err := limiter.CheckAndIncrement(context.Background(), RateLimitKey{Identifier: "id", Resource: "r", Operation: "op"})
	require.NoError(t, err)
	require.False(t, decision.Allowed)
	require.NotNil(t, decision.RetryAfter)
}
