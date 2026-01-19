package limited

import (
	"context"
	"fmt"
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
				counts[window.Start.Format(time.RFC3339)] = 0
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

		counts[window.Start.Format(time.RFC3339)] = int(record.Count)
	}

	limit := r.strategy.GetLimit(key)
	allowed := r.strategy.ShouldAllow(counts, limit)

	totalCount := 0
	for _, count := range counts {
		totalCount += count
	}

	decision := &LimitDecision{
		Allowed:      allowed,
		CurrentCount: totalCount,
		Limit:        limit,
		ResetsAt:     windows[0].End,
	}

	if !allowed {
		retryAfter := windows[0].End.Sub(now)
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

	window := windows[0]

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
		SetIfNotExists("WindowID", nil, window.Start.Format(time.RFC3339)).
		SetIfNotExists("Identifier", nil, key.Identifier).
		SetIfNotExists("Resource", nil, key.Resource).
		SetIfNotExists("Operation", nil, key.Operation).
		SetIfNotExists("WindowStart", nil, window.Start.Unix()).
		SetIfNotExists("TTL", nil, ttl).
		Set("UpdatedAt", now).
		Execute()

	if err != nil {
		return WrapError(err, ErrorTypeInternal, "failed to record request")
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
		// Either Count doesn't exist or Count >= limit.
		var currentEntry RateLimitEntry
		err2 := r.db.Model(&RateLimitEntry{}).
			WithContext(ctx).
			Where("PK", "=", entry.PK).
			Where("SK", "=", entry.SK).
			First(&currentEntry)

		if err2 == nil {
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

		if !tableerrors.IsNotFound(err2) {
			if r.config.FailOpen {
				return &LimitDecision{
					Allowed:      true,
					CurrentCount: 0,
					Limit:        limit,
					ResetsAt:     window.End,
				}, nil
			}
			return nil, WrapError(err2, ErrorTypeInternal, "failed to load rate limit entry")
		}

		// Entry doesn't exist; create it when limit permits.
		if limit > 0 {
			newEntry := &RateLimitEntry{
				Identifier:  key.Identifier,
				WindowStart: window.Start.Unix(),
				Resource:    key.Resource,
				Operation:   key.Operation,
				WindowType:  window.Key,
				WindowID:    window.Start.Format(time.RFC3339),
				Count:       1,
				CreatedAt:   now,
				UpdatedAt:   now,
				TTL:         ttl,
				Metadata:    key.Metadata,
			}
			newEntry.SetKeys()

			err3 := r.db.Model(newEntry).WithContext(ctx).IfNotExists().Create()
			if err3 == nil {
				return &LimitDecision{
					Allowed:      true,
					CurrentCount: 1,
					Limit:        limit,
					ResetsAt:     window.End,
				}, nil
			}

			if tableerrors.IsConditionFailed(err3) {
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
			return nil, WrapError(err3, ErrorTypeInternal, "failed to create rate limit entry")
		}

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

