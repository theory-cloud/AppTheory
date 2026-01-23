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

func TestDynamoRateLimiter_CheckAndIncrement_MultiWindow_TransactWriteSuccess(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 5, 30, 0, time.UTC)
	strategy := NewMultiWindowStrategy([]WindowConfig{
		{Duration: time.Minute, MaxRequests: 2},
		{Duration: time.Hour, MaxRequests: 10},
	})

	db := tablemocks.NewMockExtendedDBStrict()
	q := new(tablemocks.MockQuery)

	db.On("TransactWrite", mock.Anything, mock.Anything).Return(nil)
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

	decision, err := limiter.CheckAndIncrement(context.Background(), RateLimitKey{
		Identifier: "user:123",
		Resource:   "/users",
		Operation:  "GET",
	})
	require.NoError(t, err)
	require.True(t, decision.Allowed)
	require.Equal(t, 1, decision.CurrentCount)
	require.Equal(t, 2, decision.Limit)
	require.Equal(t, now.Truncate(time.Minute).Add(time.Minute), decision.ResetsAt)
}

func TestDynamoRateLimiter_CheckAndIncrement_MultiWindow_TransactWriteConditionFailed_SetsRetryAfter(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 5, 30, 0, time.UTC)
	strategy := NewMultiWindowStrategy([]WindowConfig{
		{Duration: time.Minute, MaxRequests: 2},
		{Duration: time.Hour, MaxRequests: 10},
	})

	db := tablemocks.NewMockExtendedDBStrict()
	q := new(tablemocks.MockQuery)

	db.On("TransactWrite", mock.Anything, mock.Anything).Return(tableerrors.ErrConditionFailed)
	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("First", mock.Anything).Run(func(args mock.Arguments) {
		record, ok := args.Get(0).(*RateLimitEntry)
		require.True(t, ok)
		record.Count = 0
	}).Return(nil)

	limiter := NewDynamoRateLimiter(db, DefaultConfig(), strategy)
	limiter.SetClock(fixedClock{now: now})

	decision, err := limiter.CheckAndIncrement(context.Background(), RateLimitKey{
		Identifier: "user:123",
		Resource:   "/users",
		Operation:  "GET",
	})
	require.NoError(t, err)
	require.False(t, decision.Allowed)
	require.NotNil(t, decision.RetryAfter)
}
