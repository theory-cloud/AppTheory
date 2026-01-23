package limited

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestFixedWindowStrategy_SetLimitsOverrideDefault(t *testing.T) {
	s := NewFixedWindowStrategy(time.Minute, 10)
	s.SetIdentifierLimit("user:123", 5)
	s.SetResourceLimit("/users", 7)

	require.Equal(t, 5, s.GetLimit(RateLimitKey{Identifier: "user:123", Resource: "/other"}))
	require.Equal(t, 7, s.GetLimit(RateLimitKey{Identifier: "user:999", Resource: "/users"}))
	require.Equal(t, 10, s.GetLimit(RateLimitKey{Identifier: "user:999", Resource: "/other"}))
}

func TestSlidingWindowStrategy_CalculateWindows_DefaultGranularity(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 2, 30, 0, time.UTC)
	s := NewSlidingWindowStrategy(2*time.Minute, 10, 0)

	windows := s.CalculateWindows(now)
	require.Len(t, windows, 2)
	require.True(t, windows[0].End.After(windows[0].Start))
}

func TestSlidingWindowStrategy_ShouldAllow_SumsCounts(t *testing.T) {
	s := NewSlidingWindowStrategy(time.Minute, 3, time.Second)

	require.True(t, s.ShouldAllow(map[string]int{"a": 1, "b": 1}, 3))
	require.False(t, s.ShouldAllow(map[string]int{"a": 2, "b": 1}, 3))
}

func TestSlidingWindowStrategy_SetLimitsOverrideDefault(t *testing.T) {
	s := NewSlidingWindowStrategy(time.Minute, 10, time.Second)
	s.SetIdentifierLimit("user:123", 5)
	s.SetResourceLimit("/users", 7)

	require.Equal(t, 5, s.GetLimit(RateLimitKey{Identifier: "user:123", Resource: "/other"}))
	require.Equal(t, 7, s.GetLimit(RateLimitKey{Identifier: "user:999", Resource: "/users"}))
	require.Equal(t, 10, s.GetLimit(RateLimitKey{Identifier: "user:999", Resource: "/other"}))
}
