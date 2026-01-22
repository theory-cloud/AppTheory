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

func TestRateLimitEntry_SetKeys(t *testing.T) {
	entry := &RateLimitEntry{
		Identifier:  "user:123",
		WindowStart: 1700000000,
		Resource:    "/users",
		Operation:   "GET",
	}
	entry.SetKeys()
	require.Equal(t, "user:123#1700000000", entry.PK)
	require.Equal(t, "/users#GET", entry.SK)
}

func TestRateLimitEntry_TableName_EnvPrecedence(t *testing.T) {
	entry := RateLimitEntry{}

	for _, tc := range []struct {
		name     string
		envVar   string
		envValue string
		want     string
	}{
		{name: "apptheory", envVar: "APPTHEORY_RATE_LIMIT_TABLE_NAME", envValue: "apptheory-rate-limits", want: "apptheory-rate-limits"},
		{name: "legacy", envVar: "RATE_LIMIT_TABLE_NAME", envValue: "legacy-rate-limits", want: "legacy-rate-limits"},
		{name: "lift", envVar: "RATE_LIMIT_TABLE", envValue: "lift-rate-limits", want: "lift-rate-limits"},
		{name: "limited", envVar: "LIMITED_TABLE_NAME", envValue: "limited-rate-limits", want: "limited-rate-limits"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("APPTHEORY_RATE_LIMIT_TABLE_NAME", "")
			t.Setenv("RATE_LIMIT_TABLE_NAME", "")
			t.Setenv("RATE_LIMIT_TABLE", "")
			t.Setenv("LIMITED_TABLE_NAME", "")
			t.Setenv(tc.envVar, tc.envValue)

			require.Equal(t, tc.want, entry.TableName())
		})
	}

	t.Setenv("APPTHEORY_RATE_LIMIT_TABLE_NAME", "")
	t.Setenv("RATE_LIMIT_TABLE_NAME", "")
	t.Setenv("RATE_LIMIT_TABLE", "")
	t.Setenv("LIMITED_TABLE_NAME", "")
	require.Equal(t, "rate-limits", entry.TableName())
}

func TestGetDayWindow_StartsAtMidnight(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 34, 56, 0, time.UTC)
	w := GetDayWindow(now)
	require.Equal(t, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), w.Start)
	require.Equal(t, time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC), w.End)
	require.Equal(t, "DAY", w.WindowType)
}

func TestGetFixedWindow_HandlesZeroAndRoundsToWindow(t *testing.T) {
	now := time.Date(2026, 1, 1, 10, 7, 30, 0, time.UTC)

	zero := GetFixedWindow(now, 0)
	require.Equal(t, "CUSTOM_0s", zero.WindowType)
	require.Equal(t, now, zero.Start)
	require.Equal(t, now, zero.End)

	window := GetFixedWindow(now, 15*time.Minute)
	require.Equal(t, "CUSTOM_15m0s", window.WindowType)
	require.Equal(t, time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC), window.Start)
	require.Equal(t, time.Date(2026, 1, 1, 10, 15, 0, 0, time.UTC), window.End)
}

func TestMinuteAndHourWindows(t *testing.T) {
	now := time.Date(2026, 1, 1, 10, 7, 30, 0, time.UTC)

	minute := GetMinuteWindow(now)
	require.Equal(t, "MINUTE", minute.WindowType)
	require.Equal(t, time.Date(2026, 1, 1, 10, 7, 0, 0, time.UTC), minute.Start)
	require.Equal(t, time.Date(2026, 1, 1, 10, 8, 0, 0, time.UTC), minute.End)

	hour := GetHourWindow(now)
	require.Equal(t, "HOUR", hour.WindowType)
	require.Equal(t, time.Date(2026, 1, 1, 10, 0, 0, 0, time.UTC), hour.Start)
	require.Equal(t, time.Date(2026, 1, 1, 11, 0, 0, 0, time.UTC), hour.End)
}
