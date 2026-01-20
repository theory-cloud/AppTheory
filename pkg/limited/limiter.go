package limited

import (
	"context"
	"fmt"
	"strings"
	"time"

	tablecore "github.com/theory-cloud/tabletheory/pkg/core"
	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"
)

// DynamoRateLimiter implements RateLimiter using DynamoDB via TableTheory.
type DynamoRateLimiter struct {
	db       tablecore.DB
	config   *Config
	strategy RateLimitStrategy
	clock    Clock
}

var _ AtomicRateLimiter = (*DynamoRateLimiter)(nil)

type transactDB interface {
	TransactWrite(ctx context.Context, fn func(tablecore.TransactionBuilder) error) error
}

func NewDynamoRateLimiter(db tablecore.DB, config *Config, strategy RateLimitStrategy) *DynamoRateLimiter {
	if config == nil {
		config = DefaultConfig()
	}
	if strategy == nil {
		strategy = NewFixedWindowStrategy(time.Hour, config.DefaultRequestsPerHour)
	}

	return &DynamoRateLimiter{
		db:       db,
		config:   config,
		strategy: strategy,
		clock:    RealClock{},
	}
}

func DefaultConfig() *Config {
	return &Config{
		DefaultRequestsPerHour:   1000,
		DefaultRequestsPerMinute: 100,
		DefaultBurstCapacity:     10,
		EnableBurstCapacity:      false,
		EnableSoftLimits:         false,
		FailOpen:                 true,
		TableName:                "rate-limits",
		ConsistentRead:           false,
		TTLHours:                 1,
		IdentifierLimits:         make(map[string]Limit),
		ResourceLimits:           make(map[string]Limit),
	}
}

func (r *DynamoRateLimiter) CheckLimit(ctx context.Context, key RateLimitKey) (*LimitDecision, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := validateKey(key); err != nil {
		return nil, err
	}

	now := r.clock.Now()
	windows := r.strategy.CalculateWindows(now)
	if len(windows) == 0 {
		return nil, NewError(ErrorTypeInternal, "no windows calculated")
	}

	counts := make(map[string]int, len(windows))

	for _, window := range windows {
		entry := &RateLimitEntry{
			Identifier:  key.Identifier,
			WindowStart: window.Start.Unix(),
			Resource:    key.Resource,
			Operation:   key.Operation,
		}
		entry.SetKeys()

		var record RateLimitEntry
		err := r.db.Model(&RateLimitEntry{}).
			WithContext(ctx).
			Where("PK", "=", entry.PK).
			Where("SK", "=", entry.SK).
			First(&record)

		if err != nil {
			if tableerrors.IsNotFound(err) {
				counts[window.Key] = 0
				continue
			}

			if r.config.FailOpen {
				return &LimitDecision{
					Allowed:      true,
					CurrentCount: 0,
					Limit:        r.strategy.GetLimit(key),
					ResetsAt:     windows[0].End,
				}, nil
			}

			return nil, WrapError(err, ErrorTypeInternal, "failed to check rate limit")
		}

		counts[window.Key] = int(record.Count)
	}

	limit := r.strategy.GetLimit(key)
	allowed := r.strategy.ShouldAllow(counts, limit)

	currentCount := countForPrimaryWindow(r.strategy, windows, counts)
	resetsAt := resetTimeForDecision(r.strategy, now, windows, counts, allowed)
	decision := &LimitDecision{
		Allowed:      allowed,
		CurrentCount: currentCount,
		Limit:        limit,
		ResetsAt:     resetsAt,
	}

	if !allowed {
		retryAfter := resetsAt.Sub(now)
		decision.RetryAfter = &retryAfter
	}

	return decision, nil
}

func (r *DynamoRateLimiter) RecordRequest(ctx context.Context, key RateLimitKey) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := validateKey(key); err != nil {
		return err
	}

	now := r.clock.Now()
	windows := r.strategy.CalculateWindows(now)
	if len(windows) == 0 {
		return NewError(ErrorTypeInternal, "no windows calculated")
	}

	targetWindows := windows[:1]
	if isMultiWindowStrategy(r.strategy) {
		targetWindows = windows
	}

	for _, window := range targetWindows {
		entry := &RateLimitEntry{
			Identifier:  key.Identifier,
			WindowStart: window.Start.Unix(),
			Resource:    key.Resource,
			Operation:   key.Operation,
		}
		entry.SetKeys()

		ttl := window.End.Unix() + int64(r.config.TTLHours*3600)

		err := r.db.Model(&RateLimitEntry{}).
			WithContext(ctx).
			Where("PK", "=", entry.PK).
			Where("SK", "=", entry.SK).
			UpdateBuilder().
			Add("Count", int64(1)).
			SetIfNotExists("WindowType", nil, window.Key).
			SetIfNotExists("WindowID", nil, window.Start.UTC().Format("2006-01-02T15:04:05Z")).
			SetIfNotExists("Identifier", nil, key.Identifier).
			SetIfNotExists("Resource", nil, key.Resource).
			SetIfNotExists("Operation", nil, key.Operation).
			SetIfNotExists("WindowStart", nil, window.Start.Unix()).
			SetIfNotExists("TTL", nil, ttl).
			SetIfNotExists("CreatedAt", nil, now).
			Set("UpdatedAt", now).
			Execute()

		if err != nil {
			return WrapError(err, ErrorTypeInternal, "failed to record request")
		}
	}

	return nil
}

func (r *DynamoRateLimiter) GetUsage(ctx context.Context, key RateLimitKey) (*UsageStats, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := validateKey(key); err != nil {
		return nil, err
	}

	now := r.clock.Now()
	minuteWindow := GetMinuteWindow(now)
	hourWindow := GetHourWindow(now)

	stats := &UsageStats{
		Identifier:    key.Identifier,
		Resource:      key.Resource,
		CustomWindows: make(map[string]UsageWindow),
		CurrentMinute: UsageWindow{
			WindowStart: minuteWindow.Start,
			WindowEnd:   minuteWindow.End,
			Limit:       r.config.DefaultRequestsPerMinute,
		},
		CurrentHour: UsageWindow{
			WindowStart: hourWindow.Start,
			WindowEnd:   hourWindow.End,
			Limit:       r.config.DefaultRequestsPerHour,
		},
	}

	if identifierLimit, ok := r.config.IdentifierLimits[key.Identifier]; ok {
		if identifierLimit.RequestsPerMinute > 0 {
			stats.CurrentMinute.Limit = identifierLimit.RequestsPerMinute
		}
		if identifierLimit.RequestsPerHour > 0 {
			stats.CurrentHour.Limit = identifierLimit.RequestsPerHour
		}
	}

	minuteEntry := &RateLimitEntry{
		Identifier:  key.Identifier,
		WindowStart: minuteWindow.Start.Unix(),
		Resource:    key.Resource,
		Operation:   key.Operation,
	}
	minuteEntry.SetKeys()

	var minuteRecord RateLimitEntry
	err := r.db.Model(&RateLimitEntry{}).
		WithContext(ctx).
		Where("PK", "=", minuteEntry.PK).
		Where("SK", "=", minuteEntry.SK).
		First(&minuteRecord)
	if err == nil {
		stats.CurrentMinute.Count = int(minuteRecord.Count)
	} else if !tableerrors.IsNotFound(err) {
		return nil, WrapError(err, ErrorTypeInternal, "failed to get minute usage")
	}

	hourEntry := &RateLimitEntry{
		Identifier:  key.Identifier,
		WindowStart: hourWindow.Start.Unix(),
		Resource:    key.Resource,
		Operation:   key.Operation,
	}
	hourEntry.SetKeys()

	var hourRecord RateLimitEntry
	err = r.db.Model(&RateLimitEntry{}).
		WithContext(ctx).
		Where("PK", "=", hourEntry.PK).
		Where("SK", "=", hourEntry.SK).
		First(&hourRecord)
	if err == nil {
		stats.CurrentHour.Count = int(hourRecord.Count)
	} else if !tableerrors.IsNotFound(err) {
		return nil, WrapError(err, ErrorTypeInternal, "failed to get hour usage")
	}

	stats.DailyTotal = stats.CurrentHour.Count

	return stats, nil
}

func (r *DynamoRateLimiter) CheckAndIncrement(ctx context.Context, key RateLimitKey) (*LimitDecision, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := validateKey(key); err != nil {
		return nil, err
	}

	now := r.clock.Now()

	if multiWindow, ok := asMultiWindowStrategy(r.strategy); ok && multiWindow != nil {
		return r.checkAndIncrementMultiWindow(ctx, key, now, multiWindow)
	}

	return r.checkAndIncrementSingleWindow(ctx, key, now)
}

func (r *DynamoRateLimiter) checkAndIncrementSingleWindow(ctx context.Context, key RateLimitKey, now time.Time) (*LimitDecision, error) {
	windows := r.strategy.CalculateWindows(now)
	if len(windows) == 0 {
		return nil, NewError(ErrorTypeInternal, "no windows calculated")
	}

	window := windows[0]
	limit := r.strategy.GetLimit(key)

	entry := &RateLimitEntry{
		Identifier:  key.Identifier,
		WindowStart: window.Start.Unix(),
		Resource:    key.Resource,
		Operation:   key.Operation,
	}
	entry.SetKeys()

	ttl := window.End.Unix() + int64(r.config.TTLHours*3600)

	// Try atomic increment with a conditional check; this requires Count to exist and be < limit.
	var result RateLimitEntry
	err := r.db.Model(&RateLimitEntry{}).
		WithContext(ctx).
		Where("PK", "=", entry.PK).
		Where("SK", "=", entry.SK).
		UpdateBuilder().
		Add("Count", int64(1)).
		Set("UpdatedAt", now).
		Condition("Count", "<", limit).
		ExecuteWithResult(&result)

	if err == nil {
		return &LimitDecision{
			Allowed:      true,
			CurrentCount: int(result.Count),
			Limit:        limit,
			ResetsAt:     window.End,
		}, nil
	}

	if tableerrors.IsConditionFailed(err) {
		return r.handleSingleWindowConditionFailed(ctx, key, now, window, limit, ttl, entry)
	}

	if r.config.FailOpen {
		return &LimitDecision{
			Allowed:      true,
			CurrentCount: 0,
			Limit:        limit,
			ResetsAt:     window.End,
		}, nil
	}

	return nil, WrapError(err, ErrorTypeInternal, "failed to check and increment rate limit")
}

func (r *DynamoRateLimiter) handleSingleWindowConditionFailed(ctx context.Context, key RateLimitKey, now time.Time, window TimeWindow, limit int, ttl int64, entry *RateLimitEntry) (*LimitDecision, error) {
	currentEntry, found, err := r.loadEntry(ctx, entry)
	if err != nil {
		if r.config.FailOpen {
			return &LimitDecision{
				Allowed:      true,
				CurrentCount: 0,
				Limit:        limit,
				ResetsAt:     window.End,
			}, nil
		}
		return nil, WrapError(err, ErrorTypeInternal, "failed to load rate limit entry")
	}

	if found {
		decision := &LimitDecision{
			Allowed:      false,
			CurrentCount: int(currentEntry.Count),
			Limit:        limit,
			ResetsAt:     window.End,
		}
		retryAfter := window.End.Sub(now)
		decision.RetryAfter = &retryAfter
		return decision, nil
	}

	return r.createSingleWindowEntry(ctx, key, now, window, limit, ttl)
}

func (r *DynamoRateLimiter) loadEntry(ctx context.Context, entry *RateLimitEntry) (RateLimitEntry, bool, error) {
	var currentEntry RateLimitEntry
	err := r.db.Model(&RateLimitEntry{}).
		WithContext(ctx).
		Where("PK", "=", entry.PK).
		Where("SK", "=", entry.SK).
		First(&currentEntry)
	if err == nil {
		return currentEntry, true, nil
	}
	if tableerrors.IsNotFound(err) {
		return RateLimitEntry{}, false, nil
	}
	return RateLimitEntry{}, false, err
}

func (r *DynamoRateLimiter) createSingleWindowEntry(ctx context.Context, key RateLimitKey, now time.Time, window TimeWindow, limit int, ttl int64) (*LimitDecision, error) {
	if limit <= 0 {
		decision := &LimitDecision{
			Allowed:      false,
			CurrentCount: 0,
			Limit:        limit,
			ResetsAt:     window.End,
		}
		retryAfter := window.End.Sub(now)
		decision.RetryAfter = &retryAfter
		return decision, nil
	}

	newEntry := &RateLimitEntry{
		Identifier:  key.Identifier,
		WindowStart: window.Start.Unix(),
		Resource:    key.Resource,
		Operation:   key.Operation,
		WindowType:  window.Key,
		WindowID:    window.Start.UTC().Format("2006-01-02T15:04:05Z"),
		Count:       1,
		CreatedAt:   now,
		UpdatedAt:   now,
		TTL:         ttl,
		Metadata:    key.Metadata,
	}
	newEntry.SetKeys()

	err := r.db.Model(newEntry).WithContext(ctx).IfNotExists().Create()
	if err == nil {
		return &LimitDecision{
			Allowed:      true,
			CurrentCount: 1,
			Limit:        limit,
			ResetsAt:     window.End,
		}, nil
	}

	if tableerrors.IsConditionFailed(err) {
		// Race: item now exists; retry once.
		return r.CheckAndIncrement(ctx, key)
	}

	if r.config.FailOpen {
		return &LimitDecision{
			Allowed:      true,
			CurrentCount: 0,
			Limit:        limit,
			ResetsAt:     window.End,
		}, nil
	}
	return nil, WrapError(err, ErrorTypeInternal, "failed to create rate limit entry")
}

func (r *DynamoRateLimiter) SetClock(clock Clock) {
	if clock == nil {
		r.clock = RealClock{}
		return
	}
	r.clock = clock
}

func validateKey(key RateLimitKey) error {
	if key.Identifier == "" {
		return NewError(ErrorTypeInvalidInput, "identifier is required")
	}
	if key.Resource == "" {
		return NewError(ErrorTypeInvalidInput, "resource is required")
	}
	if key.Operation == "" {
		return NewError(ErrorTypeInvalidInput, "operation is required")
	}
	return nil
}

func (r *DynamoRateLimiter) String() string {
	if r == nil {
		return "limited.DynamoRateLimiter<nil>"
	}
	return fmt.Sprintf("limited.DynamoRateLimiter{fail_open:%t}", r.config != nil && r.config.FailOpen)
}

func asMultiWindowStrategy(strategy RateLimitStrategy) (*MultiWindowStrategy, bool) {
	typed, ok := strategy.(*MultiWindowStrategy)
	return typed, ok
}

func isMultiWindowStrategy(strategy RateLimitStrategy) bool {
	_, ok := asMultiWindowStrategy(strategy)
	return ok
}

func countForPrimaryWindow(strategy RateLimitStrategy, windows []TimeWindow, counts map[string]int) int {
	if len(windows) == 0 || len(counts) == 0 {
		return 0
	}

	if _, ok := strategy.(*SlidingWindowStrategy); ok {
		total := 0
		for _, count := range counts {
			total += count
		}
		return total
	}

	return counts[windows[0].Key]
}

func resetTimeForDecision(strategy RateLimitStrategy, now time.Time, windows []TimeWindow, counts map[string]int, allowed bool) time.Time {
	if len(windows) == 0 {
		return now
	}
	if allowed || !isMultiWindowStrategy(strategy) {
		return windows[0].End
	}

	// For multi-window limits, surface the earliest time a request could succeed.
	// When multiple windows are exceeded, this is the latest reset time among them.
	multiWindow, _ := asMultiWindowStrategy(strategy)
	maxReset := windows[0].End
	for _, window := range windows {
		maxAllowed := maxRequestsForWindow(multiWindow, window)
		if maxAllowed <= 0 {
			if window.End.After(maxReset) {
				maxReset = window.End
			}
			continue
		}

		if counts[window.Key] >= maxAllowed && window.End.After(maxReset) {
			maxReset = window.End
		}
	}
	return maxReset
}

func (r *DynamoRateLimiter) checkAndIncrementMultiWindow(ctx context.Context, key RateLimitKey, now time.Time, strategy *MultiWindowStrategy) (*LimitDecision, error) {
	windows := strategy.CalculateWindows(now)
	if len(windows) == 0 {
		return nil, NewError(ErrorTypeInternal, "no windows calculated")
	}

	primaryLimit := strategy.GetLimit(key)
	if primaryLimit <= 0 {
		decision := &LimitDecision{
			Allowed:      false,
			CurrentCount: 0,
			Limit:        primaryLimit,
			ResetsAt:     windows[0].End,
		}
		retryAfter := windows[0].End.Sub(now)
		decision.RetryAfter = &retryAfter
		return decision, nil
	}

	ext, ok := r.db.(transactDB)
	if !ok {
		return r.checkAndIncrementMultiWindowFallback(ctx, key)
	}

	if err := r.transactIncrementMultiWindow(ctx, ext, key, now, strategy, windows); err != nil {
		return r.handleMultiWindowIncrementError(ctx, key, now, windows, primaryLimit, err)
	}

	primary := windows[0]
	currentCount, err := r.loadPrimaryWindowCount(ctx, key, primary)
	if err != nil {
		if r.config.FailOpen {
			return &LimitDecision{
				Allowed:      true,
				CurrentCount: 0,
				Limit:        primaryLimit,
				ResetsAt:     primary.End,
			}, nil
		}
		return nil, WrapError(err, ErrorTypeInternal, "failed to load updated rate limit entry")
	}

	return &LimitDecision{
		Allowed:      true,
		CurrentCount: currentCount,
		Limit:        primaryLimit,
		ResetsAt:     primary.End,
	}, nil
}

func (r *DynamoRateLimiter) checkAndIncrementMultiWindowFallback(ctx context.Context, key RateLimitKey) (*LimitDecision, error) {
	decision, err := r.CheckLimit(ctx, key)
	if err != nil {
		return nil, err
	}
	if !decision.Allowed {
		return decision, nil
	}
	if err := r.RecordRequest(ctx, key); err != nil {
		if r.config.FailOpen {
			return decision, nil
		}
		return nil, WrapError(err, ErrorTypeInternal, "failed to record request")
	}
	decision.CurrentCount++
	return decision, nil
}

func (r *DynamoRateLimiter) transactIncrementMultiWindow(ctx context.Context, db transactDB, key RateLimitKey, now time.Time, strategy *MultiWindowStrategy, windows []TimeWindow) error {
	return db.TransactWrite(ctx, func(tx tablecore.TransactionBuilder) error {
		tx.WithContext(ctx)
		for _, window := range windows {
			if err := r.addMultiWindowUpdate(tx, key, now, strategy, window); err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *DynamoRateLimiter) addMultiWindowUpdate(tx tablecore.TransactionBuilder, key RateLimitKey, now time.Time, strategy *MultiWindowStrategy, window TimeWindow) error {
	maxAllowed := maxRequestsForWindow(strategy, window)
	if maxAllowed <= 0 {
		return tableerrors.ErrConditionFailed
	}

	entry := &RateLimitEntry{
		Identifier:  key.Identifier,
		WindowStart: window.Start.Unix(),
		Resource:    key.Resource,
		Operation:   key.Operation,
	}
	entry.SetKeys()

	ttl := window.End.Unix() + int64(r.config.TTLHours*3600)

	tx.UpdateWithBuilder(entry, func(ub tablecore.UpdateBuilder) error {
		ub.Add("Count", int64(1)).
			SetIfNotExists("WindowType", nil, window.Key).
			SetIfNotExists("WindowID", nil, window.Start.UTC().Format("2006-01-02T15:04:05Z")).
			SetIfNotExists("Identifier", nil, key.Identifier).
			SetIfNotExists("Resource", nil, key.Resource).
			SetIfNotExists("Operation", nil, key.Operation).
			SetIfNotExists("WindowStart", nil, window.Start.Unix()).
			SetIfNotExists("TTL", nil, ttl).
			SetIfNotExists("CreatedAt", nil, now).
			Set("UpdatedAt", now)

		ub.ConditionNotExists("Count")
		ub.OrCondition("Count", "<", maxAllowed)

		var ignored RateLimitEntry
		return ub.ExecuteWithResult(&ignored)
	})

	return nil
}

func (r *DynamoRateLimiter) loadPrimaryWindowCount(ctx context.Context, key RateLimitKey, window TimeWindow) (int, error) {
	entry := &RateLimitEntry{
		Identifier:  key.Identifier,
		WindowStart: window.Start.Unix(),
		Resource:    key.Resource,
		Operation:   key.Operation,
	}
	entry.SetKeys()

	var record RateLimitEntry
	err := r.db.Model(&RateLimitEntry{}).
		WithContext(ctx).
		Where("PK", "=", entry.PK).
		Where("SK", "=", entry.SK).
		First(&record)
	if err == nil {
		return int(record.Count), nil
	}
	if tableerrors.IsNotFound(err) {
		return 0, nil
	}
	return 0, err
}

func (r *DynamoRateLimiter) handleMultiWindowIncrementError(ctx context.Context, key RateLimitKey, now time.Time, windows []TimeWindow, primaryLimit int, err error) (*LimitDecision, error) {
	if tableerrors.IsConditionFailed(err) {
		decision, decisionErr := r.CheckLimit(ctx, key)
		if decisionErr != nil {
			return nil, WrapError(decisionErr, ErrorTypeInternal, "failed to load rate limit state after condition failure")
		}
		decision.Allowed = false
		if decision.RetryAfter == nil {
			retryAfter := decision.ResetsAt.Sub(now)
			decision.RetryAfter = &retryAfter
		}
		return decision, nil
	}

	if r.config.FailOpen {
		return &LimitDecision{
			Allowed:      true,
			CurrentCount: 0,
			Limit:        primaryLimit,
			ResetsAt:     windows[0].End,
		}, nil
	}

	return nil, WrapError(err, ErrorTypeInternal, "failed to check and increment rate limit")
}

func maxRequestsForWindow(strategy *MultiWindowStrategy, window TimeWindow) int {
	if strategy == nil {
		return 0
	}

	idx := strings.LastIndex(window.Key, "_")
	if idx != -1 && idx < len(window.Key)-1 {
		if dur, err := time.ParseDuration(window.Key[idx+1:]); err == nil {
			for _, config := range strategy.Windows {
				if config.Duration == dur {
					return config.MaxRequests
				}
			}
		}
	}

	if len(strategy.Windows) > 0 {
		return strategy.Windows[0].MaxRequests
	}
	return 0
}
