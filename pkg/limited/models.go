package limited

import (
	"fmt"
	"os"
	"time"
)

// RateLimitEntry tracks rate limit usage in DynamoDB.
//
// Storage key shape:
//   - PK: {identifier}#{window_start_unix}
//   - SK: {resource}#{operation}
type RateLimitEntry struct {
	PK string `theorydb:"pk" json:"pk"`
	SK string `theorydb:"sk" json:"sk"`

	Identifier string `json:"identifier"`
	Resource   string `json:"resource"`
	Operation  string `json:"operation"`

	WindowStart int64  `json:"window_start"`
	WindowType  string `json:"window_type"`
	WindowID    string `json:"window_id"`

	Count int64 `json:"count"`

	TTL int64 `theorydb:"ttl" json:"ttl"`

	CreatedAt time.Time         `theorydb:"created_at" json:"created_at"`
	UpdatedAt time.Time         `theorydb:"updated_at" json:"updated_at"`
	Metadata  map[string]string `json:"metadata,omitempty"`
}

func (r *RateLimitEntry) SetKeys() {
	r.PK = fmt.Sprintf("%s#%d", r.Identifier, r.WindowStart)
	r.SK = fmt.Sprintf("%s#%s", r.Resource, r.Operation)
}

func (r *RateLimitEntry) GetCompositeID() string {
	return fmt.Sprintf("%s#%d#%s#%s", r.Identifier, r.WindowStart, r.Resource, r.Operation)
}

func (r *RateLimitEntry) SetTTL(windowDuration time.Duration, bufferDuration time.Duration) {
	r.TTL = r.WindowStart + int64(windowDuration.Seconds()) + int64(bufferDuration.Seconds())
}

func (RateLimitEntry) TableName() string {
	// Prefer AppTheory-specific env var.
	if name := os.Getenv("APPTHEORY_RATE_LIMIT_TABLE_NAME"); name != "" {
		return name
	}
	// Back-compat for historical deployments/configs.
	if name := os.Getenv("RATE_LIMIT_TABLE_NAME"); name != "" {
		return name
	}
	// Back-compat for Lift's `LiftApp` env var naming.
	if name := os.Getenv("RATE_LIMIT_TABLE"); name != "" {
		return name
	}
	if name := os.Getenv("LIMITED_TABLE_NAME"); name != "" {
		return name
	}
	return "rate-limits"
}

// RateLimitWindow represents a time window for rate limiting.
type RateLimitWindow struct {
	WindowType string
	Start      time.Time
	End        time.Time
}

func GetMinuteWindow(now time.Time) RateLimitWindow {
	start := now.Truncate(time.Minute)
	return RateLimitWindow{
		WindowType: "MINUTE",
		Start:      start,
		End:        start.Add(time.Minute),
	}
}

func GetHourWindow(now time.Time) RateLimitWindow {
	start := now.Truncate(time.Hour)
	return RateLimitWindow{
		WindowType: "HOUR",
		Start:      start,
		End:        start.Add(time.Hour),
	}
}

func GetFixedWindow(now time.Time, duration time.Duration) RateLimitWindow {
	if duration <= 0 {
		return RateLimitWindow{WindowType: "CUSTOM_0s", Start: now, End: now}
	}

	windowNanos := duration.Nanoseconds()
	startNanos := (now.UnixNano() / windowNanos) * windowNanos
	start := time.Unix(0, startNanos).In(now.Location())

	return RateLimitWindow{
		WindowType: fmt.Sprintf("CUSTOM_%s", duration.String()),
		Start:      start,
		End:        start.Add(duration),
	}
}

func GetDayWindow(now time.Time) RateLimitWindow {
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	return RateLimitWindow{
		WindowType: "DAY",
		Start:      start,
		End:        start.AddDate(0, 0, 1),
	}
}
