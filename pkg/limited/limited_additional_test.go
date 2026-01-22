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

func TestErrorStringAndUnwrap(t *testing.T) {
	base := errors.New("boom")
	err := WrapError(base, ErrorTypeInternal, "wrapped")
	require.Equal(t, "wrapped: boom", err.Error())
	require.ErrorIs(t, err, base)

	require.Equal(t, "rate limiter error", (*Error)(nil).Error())
	require.Nil(t, (*Error)(nil).Unwrap())
}

func TestRateLimitEntry_TableNameEnvPrecedence(t *testing.T) {
	t.Setenv("APPTHEORY_RATE_LIMIT_TABLE_NAME", "apptheory-table")
	t.Setenv("RATE_LIMIT_TABLE_NAME", "rate-limit-table-name")
	t.Setenv("RATE_LIMIT_TABLE", "rate-limit-table")
	t.Setenv("LIMITED_TABLE_NAME", "limited-table")

	require.Equal(t, "apptheory-table", (RateLimitEntry{}).TableName())
}

func TestGetFixedWindow_ZeroDuration(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	w := GetFixedWindow(now, 0)
	require.Equal(t, "CUSTOM_0s", w.WindowType)
	require.Equal(t, now, w.Start)
	require.Equal(t, now, w.End)
}

func TestCheckLimit_NotFoundTreatsCountAsZero(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
	strategy := NewFixedWindowStrategy(time.Minute, 2)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("First", mock.Anything).Return(tableerrors.ErrItemNotFound)

	limiter := NewDynamoRateLimiter(db, DefaultConfig(), strategy)
	limiter.SetClock(fixedClock{now: now})

	decision, err := limiter.CheckLimit(context.Background(), RateLimitKey{
		Identifier: "user:123",
		Resource:   "/users",
		Operation:  "GET",
	})
	require.NoError(t, err)
	require.True(t, decision.Allowed)
	require.Equal(t, 0, decision.CurrentCount)
	require.Equal(t, 2, decision.Limit)
	require.Nil(t, decision.RetryAfter)
}

func TestCheckLimit_FailOpenOnDBError(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
	strategy := NewFixedWindowStrategy(time.Minute, 2)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("First", mock.Anything).Return(errors.New("db down"))

	cfg := DefaultConfig()
	cfg.FailOpen = true

	limiter := NewDynamoRateLimiter(db, cfg, strategy)
	limiter.SetClock(fixedClock{now: now})

	//nolint:staticcheck // Intentional: verify nil context is handled by falling back to context.Background().
	decision, err := limiter.CheckLimit(nil, RateLimitKey{
		Identifier: "user:123",
		Resource:   "/users",
		Operation:  "GET",
	})
	require.NoError(t, err)
	require.True(t, decision.Allowed)
	require.Equal(t, 0, decision.CurrentCount)
}

func TestCheckLimit_FailClosedOnDBError(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
	strategy := NewFixedWindowStrategy(time.Minute, 2)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("First", mock.Anything).Return(errors.New("db down"))

	cfg := DefaultConfig()
	cfg.FailOpen = false

	limiter := NewDynamoRateLimiter(db, cfg, strategy)
	limiter.SetClock(fixedClock{now: now})

	//nolint:staticcheck // Intentional: verify nil context is handled by falling back to context.Background().
	_, err := limiter.CheckLimit(nil, RateLimitKey{
		Identifier: "user:123",
		Resource:   "/users",
		Operation:  "GET",
	})
	require.Error(t, err)
}

func TestMultiWindow_ResetTimeUsesLatestExceededWindow(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 5, 30, 0, time.UTC)
	strategy := NewMultiWindowStrategy([]WindowConfig{
		{Duration: time.Minute, MaxRequests: 2},
		{Duration: time.Hour, MaxRequests: 1000},
	})

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
			record.Count = 2
			return
		}
		record.Count = 1000
	}).Return(nil)

	limiter := NewDynamoRateLimiter(db, DefaultConfig(), strategy)
	limiter.SetClock(fixedClock{now: now})

	decision, err := limiter.CheckLimit(context.Background(), RateLimitKey{
		Identifier: "user:123",
		Resource:   "/users",
		Operation:  "GET",
	})
	require.NoError(t, err)
	require.False(t, decision.Allowed)
	require.Equal(t, 2, decision.Limit)
	require.Equal(t, now.Truncate(time.Hour).Add(time.Hour), decision.ResetsAt)
	require.NotNil(t, decision.RetryAfter)
}

func TestMaxRequestsForWindow_ParsesDurationSuffix(t *testing.T) {
	strategy := NewMultiWindowStrategy([]WindowConfig{
		{Duration: time.Minute, MaxRequests: 2},
		{Duration: time.Hour, MaxRequests: 10},
	})
	require.Equal(t, 10, maxRequestsForWindow(strategy, TimeWindow{Key: "x_1h"}))
	require.Equal(t, 2, maxRequestsForWindow(strategy, TimeWindow{Key: "x_1m"}))
}
