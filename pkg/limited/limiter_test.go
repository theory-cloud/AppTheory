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

type fixedClock struct {
	now time.Time
}

func (c fixedClock) Now() time.Time { return c.now }

func TestDynamoRateLimiter_CheckAndIncrement_AllowsWhenUnderLimit(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
	strategy := NewFixedWindowStrategy(time.Minute, 10)

	mockDB := new(tablemocks.MockDB)
	mockQuery := new(tablemocks.MockQuery)
	mockUpdate := new(tablemocks.MockUpdateBuilder)

	mockDB.On("Model", mock.Anything).Return(mockQuery)
	mockQuery.On("WithContext", mock.Anything).Return(mockQuery)
	mockQuery.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(mockQuery)
	mockQuery.On("UpdateBuilder").Return(mockUpdate)

	mockUpdate.On("Add", "Count", int64(1)).Return(mockUpdate)
	mockUpdate.On("Set", "UpdatedAt", now).Return(mockUpdate)
	mockUpdate.On("Condition", "Count", "<", 10).Return()
	mockUpdate.On("ExecuteWithResult", mock.Anything).Run(func(args mock.Arguments) {
		result, ok := args.Get(0).(*RateLimitEntry)
		require.True(t, ok)
		result.Count = 5
	}).Return(nil)

	limiter := NewDynamoRateLimiter(mockDB, DefaultConfig(), strategy)
	limiter.SetClock(fixedClock{now: now})

	decision, err := limiter.CheckAndIncrement(context.Background(), RateLimitKey{
		Identifier: "user:123",
		Resource:   "/users",
		Operation:  "GET",
	})
	require.NoError(t, err)
	require.True(t, decision.Allowed)
	require.Equal(t, 5, decision.CurrentCount)
	require.Equal(t, 10, decision.Limit)
	require.Nil(t, decision.RetryAfter)
	require.Equal(t, now.Truncate(time.Minute).Add(time.Minute), decision.ResetsAt)

	mockDB.AssertExpectations(t)
	mockQuery.AssertExpectations(t)
	mockUpdate.AssertExpectations(t)
}

func TestDynamoRateLimiter_CheckAndIncrement_DeniesWhenOverLimit(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
	strategy := NewFixedWindowStrategy(time.Minute, 10)

	mockDB := new(tablemocks.MockDB)
	mockQuery := new(tablemocks.MockQuery)
	mockUpdate := new(tablemocks.MockUpdateBuilder)

	mockDB.On("Model", mock.Anything).Return(mockQuery)
	mockQuery.On("WithContext", mock.Anything).Return(mockQuery)
	mockQuery.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(mockQuery)
	mockQuery.On("UpdateBuilder").Return(mockUpdate)

	mockUpdate.On("Add", "Count", int64(1)).Return(mockUpdate)
	mockUpdate.On("Set", "UpdatedAt", now).Return(mockUpdate)
	mockUpdate.On("Condition", "Count", "<", 10).Return()
	mockUpdate.On("ExecuteWithResult", mock.Anything).Return(tableerrors.ErrConditionFailed)

	mockQuery.On("First", mock.Anything).Run(func(args mock.Arguments) {
		record, ok := args.Get(0).(*RateLimitEntry)
		require.True(t, ok)
		record.Count = 10
	}).Return(nil)

	limiter := NewDynamoRateLimiter(mockDB, DefaultConfig(), strategy)
	limiter.SetClock(fixedClock{now: now})

	decision, err := limiter.CheckAndIncrement(context.Background(), RateLimitKey{
		Identifier: "user:123",
		Resource:   "/users",
		Operation:  "GET",
	})
	require.NoError(t, err)
	require.False(t, decision.Allowed)
	require.Equal(t, 10, decision.CurrentCount)
	require.Equal(t, 10, decision.Limit)
	require.NotNil(t, decision.RetryAfter)

	mockDB.AssertExpectations(t)
	mockQuery.AssertExpectations(t)
	mockUpdate.AssertExpectations(t)
}

func TestDynamoRateLimiter_CheckAndIncrement_CreatesEntryWhenMissing(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 30, 0, time.UTC)
	strategy := NewFixedWindowStrategy(time.Minute, 10)

	mockDB := new(tablemocks.MockDB)
	mockQuery := new(tablemocks.MockQuery)
	mockUpdate := new(tablemocks.MockUpdateBuilder)

	mockDB.On("Model", mock.Anything).Return(mockQuery)
	mockQuery.On("WithContext", mock.Anything).Return(mockQuery)
	mockQuery.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(mockQuery)
	mockQuery.On("UpdateBuilder").Return(mockUpdate)

	mockUpdate.On("Add", "Count", int64(1)).Return(mockUpdate)
	mockUpdate.On("Set", "UpdatedAt", now).Return(mockUpdate)
	mockUpdate.On("Condition", "Count", "<", 10).Return()
	mockUpdate.On("ExecuteWithResult", mock.Anything).Return(tableerrors.ErrConditionFailed)

	mockQuery.On("First", mock.Anything).Return(tableerrors.ErrItemNotFound)
	mockQuery.On("IfNotExists").Return(mockQuery)
	mockQuery.On("Create").Return(nil)

	limiter := NewDynamoRateLimiter(mockDB, DefaultConfig(), strategy)
	limiter.SetClock(fixedClock{now: now})

	decision, err := limiter.CheckAndIncrement(context.Background(), RateLimitKey{
		Identifier: "user:123",
		Resource:   "/users",
		Operation:  "GET",
	})
	require.NoError(t, err)
	require.True(t, decision.Allowed)
	require.Equal(t, 1, decision.CurrentCount)
	require.Equal(t, 10, decision.Limit)
	require.Nil(t, decision.RetryAfter)

	mockDB.AssertExpectations(t)
	mockQuery.AssertExpectations(t)
	mockUpdate.AssertExpectations(t)
}

func TestDynamoRateLimiter_CheckLimit_MultiWindowDeniesWhenAnyWindowExceeded(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 5, 30, 0, time.UTC)

	strategy := NewMultiWindowStrategy([]WindowConfig{
		{Duration: time.Minute, MaxRequests: 2},
		{Duration: time.Hour, MaxRequests: 1000},
	})

	mockDB := new(tablemocks.MockDB)
	mockQuery := new(tablemocks.MockQuery)

	mockDB.On("Model", mock.Anything).Return(mockQuery)
	mockQuery.On("WithContext", mock.Anything).Return(mockQuery)
	mockQuery.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(mockQuery)

	var firstCalls int
	mockQuery.On("First", mock.Anything).Run(func(args mock.Arguments) {
		firstCalls++
		record, ok := args.Get(0).(*RateLimitEntry)
		require.True(t, ok)
		if firstCalls == 1 {
			record.Count = 2
			return
		}
		record.Count = 0
	}).Return(nil)

	limiter := NewDynamoRateLimiter(mockDB, DefaultConfig(), strategy)
	limiter.SetClock(fixedClock{now: now})

	decision, err := limiter.CheckLimit(context.Background(), RateLimitKey{
		Identifier: "user:123",
		Resource:   "/users",
		Operation:  "GET",
	})
	require.NoError(t, err)
	require.False(t, decision.Allowed)
	require.Equal(t, 2, decision.CurrentCount)
	require.Equal(t, 2, decision.Limit)
	require.NotNil(t, decision.RetryAfter)
	require.Equal(t, now.Truncate(time.Minute).Add(time.Minute), decision.ResetsAt)

	mockDB.AssertExpectations(t)
	mockQuery.AssertExpectations(t)
}
