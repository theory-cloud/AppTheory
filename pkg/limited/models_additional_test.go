package limited

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestRateLimitEntry_GetCompositeID(t *testing.T) {
	entry := &RateLimitEntry{
		Identifier:  "user:123",
		WindowStart: 1700000000,
		Resource:    "/users",
		Operation:   "GET",
	}
	require.Equal(t, "user:123#1700000000#/users#GET", entry.GetCompositeID())
}

func TestRateLimitEntry_SetTTL(t *testing.T) {
	entry := &RateLimitEntry{
		WindowStart: 1700000000,
	}
	entry.SetTTL(time.Hour, time.Minute)
	require.Equal(t, int64(1700000000+3600+60), entry.TTL)
}

func TestGetDayWindow_StartsAtMidnight(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 34, 56, 0, time.UTC)
	w := GetDayWindow(now)
	require.Equal(t, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), w.Start)
	require.Equal(t, time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC), w.End)
	require.Equal(t, "DAY", w.WindowType)
}
