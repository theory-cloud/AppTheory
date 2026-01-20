// Package limited provides DynamoDB-backed rate limiting for AppTheory.
//
// This package replicates the core functionality of `github.com/pay-theory/limited`,
// but uses TableTheory as the DynamoDB abstraction.
package limited

import (
	"context"
	"time"
)

// RateLimiter defines the interface for rate limiting implementations.
type RateLimiter interface {
	// CheckLimit checks whether a request should be allowed under the current strategy.
	CheckLimit(ctx context.Context, key RateLimitKey) (*LimitDecision, error)

	// RecordRequest records a request occurrence (for non-atomic implementations).
	RecordRequest(ctx context.Context, key RateLimitKey) error

	// GetUsage returns current usage statistics for a key.
	GetUsage(ctx context.Context, key RateLimitKey) (*UsageStats, error)
}

// AtomicRateLimiter is a RateLimiter that can atomically check and increment.
type AtomicRateLimiter interface {
	RateLimiter

	// CheckAndIncrement performs an atomic check-and-increment operation.
	CheckAndIncrement(ctx context.Context, key RateLimitKey) (*LimitDecision, error)
}

// RateLimitKey identifies a unique rate limit bucket.
type RateLimitKey struct {
	Identifier string
	Resource   string
	Operation  string
	Metadata   map[string]string
}

// LimitDecision represents the result of a rate limit check.
type LimitDecision struct {
	Allowed      bool
	CurrentCount int
	Limit        int
	ResetsAt     time.Time
	RetryAfter   *time.Duration
}

// UsageStats provides detailed usage information.
type UsageStats struct {
	Identifier    string
	Resource      string
	CurrentHour   UsageWindow
	CurrentMinute UsageWindow
	DailyTotal    int
	CustomWindows map[string]UsageWindow
}

// UsageWindow represents usage within a time window.
type UsageWindow struct {
	Count       int
	Limit       int
	WindowStart time.Time
	WindowEnd   time.Time
}

// RateLimitStrategy defines how windows and limits are calculated.
type RateLimitStrategy interface {
	CalculateWindows(now time.Time) []TimeWindow
	GetLimit(key RateLimitKey) int
	ShouldAllow(counts map[string]int, limit int) bool
}

// TimeWindow represents a time period for rate limiting.
type TimeWindow struct {
	Start time.Time
	End   time.Time
	Key   string
}

// Config contains configuration for the rate limiter.
type Config struct {
	DefaultRequestsPerHour   int
	DefaultRequestsPerMinute int
	DefaultBurstCapacity     int

	EnableBurstCapacity bool
	EnableSoftLimits    bool
	FailOpen            bool

	// TableName is kept for configuration parity; TableTheory table names are derived
	// from model metadata, so callers should set table name via environment before use.
	TableName      string
	ConsistentRead bool
	TTLHours       int

	IdentifierLimits map[string]Limit
	ResourceLimits   map[string]Limit
}

// Limit defines rate limits for a specific entity.
type Limit struct {
	RequestsPerHour   int
	RequestsPerMinute int
	BurstCapacity     int
	CustomWindows     map[string]WindowLimit
}

// WindowLimit defines limits for a custom time window.
type WindowLimit struct {
	Duration time.Duration
	Requests int
}

// Clock allows deterministic testing of time-sensitive logic.
type Clock interface {
	Now() time.Time
}

// RealClock implements Clock using actual time.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }

// ErrorType identifies the category of a rate limiter error.
type ErrorType string

const (
	ErrorTypeInternal     ErrorType = "internal_error"
	ErrorTypeRateLimit    ErrorType = "rate_limit_exceeded"
	ErrorTypeInvalidInput ErrorType = "invalid_input"
)

// Error represents a rate limiter error.
type Error struct {
	Type    ErrorType
	Message string
	Cause   error
}

func (e *Error) Error() string {
	if e == nil {
		return "rate limiter error"
	}
	if e.Cause != nil {
		return e.Message + ": " + e.Cause.Error()
	}
	return e.Message
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func NewError(errorType ErrorType, message string) *Error {
	return &Error{Type: errorType, Message: message}
}

func WrapError(cause error, errorType ErrorType, message string) *Error {
	return &Error{Type: errorType, Message: message, Cause: cause}
}
