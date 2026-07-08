package limited

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	tablecore "github.com/theory-cloud/tabletheory/v2/pkg/core"
	tableerrors "github.com/theory-cloud/tabletheory/v2/pkg/errors"
	tablemocks "github.com/theory-cloud/tabletheory/v2/pkg/mocks"
)

type duplicateDetectingTransactionBuilder struct {
	*tablemocks.MockTransactionBuilder

	keys      []string
	seen      map[string]struct{}
	duplicate string
}

func newDuplicateDetectingTransactionBuilder() *duplicateDetectingTransactionBuilder {
	return &duplicateDetectingTransactionBuilder{
		MockTransactionBuilder: &tablemocks.MockTransactionBuilder{},
		seen:                   make(map[string]struct{}),
	}
}

func (d *duplicateDetectingTransactionBuilder) UpdateWithBuilder(model any, updateFn func(tablecore.UpdateBuilder) error, conditions ...tablecore.TransactCondition) tablecore.TransactionBuilder {
	_ = updateFn
	_ = conditions

	entry, ok := model.(*RateLimitEntry)
	if ok {
		key := entry.PK + "||" + entry.SK
		d.keys = append(d.keys, key)
		if _, exists := d.seen[key]; exists {
			d.duplicate = key
		}
		d.seen[key] = struct{}{}
	}

	return d
}

func (d *duplicateDetectingTransactionBuilder) Execute() error {
	if d.duplicate != "" {
		return fmt.Errorf("duplicate transaction item %s", d.duplicate)
	}
	return nil
}

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

func TestDynamoRateLimiter_CheckAndIncrement_MultiWindow_TopOfHourUsesDistinctTransactionKeys(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 7, 0, time.UTC)
	strategy := NewMultiWindowStrategy([]WindowConfig{
		{Duration: time.Minute, MaxRequests: 240},
		{Duration: time.Hour, MaxRequests: 4800},
	})

	tx := newDuplicateDetectingTransactionBuilder()
	db := tablemocks.NewMockExtendedDBStrict()
	db.TransactWriteBuilder = tx
	q := new(tablemocks.MockQuery)

	db.On("TransactWrite", mock.Anything, mock.Anything).Return(nil).Once()
	db.On("Model", mock.Anything).Return(q).Once()
	q.On("WithContext", mock.Anything).Return(q).Once()
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q).Twice()
	q.On("First", mock.Anything).Run(func(args mock.Arguments) {
		record, ok := args.Get(0).(*RateLimitEntry)
		require.True(t, ok)
		record.Count = 1
	}).Return(nil).Once()

	cfg := DefaultConfig()
	cfg.FailOpen = false
	limiter := NewDynamoRateLimiter(db, cfg, strategy)
	limiter.SetClock(fixedClock{now: now})

	decision, err := limiter.CheckAndIncrement(context.Background(), RateLimitKey{
		Identifier: "subject",
		Resource:   "endpoint",
		Operation:  "tools/call:memory_recent",
	})
	require.NoError(t, err)
	require.True(t, decision.Allowed)
	require.Len(t, tx.keys, 2)
	require.NotEqual(t, tx.keys[0], tx.keys[1])
	require.Contains(t, tx.keys[0], time.Minute.String())
	require.Contains(t, tx.keys[1], time.Hour.String())
}
