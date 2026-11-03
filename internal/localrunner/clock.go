package localrunner

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Clock is the run's time source. The delivery engine, the events a session
// builds and every future schedule, TTL expiry and visibility timeout take
// their time from it. Real time is the default; `--clock test[=<RFC3339>]`
// makes a run deterministic.
type Clock interface {
	// Now is the current instant.
	Now() time.Time
	// After returns a channel that receives the instant d from now.
	After(d time.Duration) <-chan time.Time
}

// RealClock is the wall clock and the default.
type RealClock struct{}

// Now returns the current UTC instant.
func (RealClock) Now() time.Time {
	return time.Now().UTC()
}

// After is time.After.
func (RealClock) After(d time.Duration) <-chan time.Time {
	return time.After(d)
}

// ClockMode names the clock a run uses.
type ClockMode string

const (
	// ClockModeReal is the wall clock.
	ClockModeReal ClockMode = "real"
	// ClockModeTest is a deterministic clock advanced by `clock.advance`.
	ClockModeTest ClockMode = "test"
)

// DefaultTestClockStart is where `--clock test` starts when no instant is
// given. A fixed instant keeps every test run reproducible.
var DefaultTestClockStart = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// ClockModeOf reports the mode of a clock.
func ClockModeOf(clock Clock) ClockMode {
	if _, ok := clock.(*TestClock); ok {
		return ClockModeTest
	}
	return ClockModeReal
}

// ParseClockSpec parses the `--clock` value: real, test, or
// test=<RFC3339 start>. The empty value is the real clock.
func ParseClockSpec(spec string) (Clock, error) {
	spec = strings.TrimSpace(spec)
	switch {
	case spec == "", spec == string(ClockModeReal):
		return RealClock{}, nil
	case spec == string(ClockModeTest):
		return NewTestClock(DefaultTestClockStart), nil
	case strings.HasPrefix(spec, string(ClockModeTest)+"="):
		value := strings.TrimSpace(strings.TrimPrefix(spec, string(ClockModeTest)+"="))
		start, err := time.Parse(time.RFC3339, value)
		if err != nil {
			return nil, fmt.Errorf("--clock test=<RFC3339 start>: %q is not an RFC3339 instant: %w", value, err)
		}
		return NewTestClock(start.UTC()), nil
	default:
		return nil, fmt.Errorf(`--clock must be "real" or "test[=<RFC3339 start>]" (got %q)`, spec)
	}
}

// TestClock is a deterministic clock. It never reads the wall clock; Advance
// moves it forward and fires every timer that is due, in scheduled order.
type TestClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*testClockTimer
	seq    uint64
}

type testClockTimer struct {
	at  time.Time
	seq uint64
	ch  chan time.Time
}

// NewTestClock builds a test clock at start.
func NewTestClock(start time.Time) *TestClock {
	return &TestClock{now: start.UTC()}
}

// Now returns the clock's current instant.
func (c *TestClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// After registers a timer that fires when the clock reaches d from now.
func (c *TestClock) After(d time.Duration) <-chan time.Time {
	ch := make(chan time.Time, 1)
	c.mu.Lock()
	defer c.mu.Unlock()
	if d <= 0 {
		ch <- c.now
		return ch
	}
	c.seq++
	c.timers = append(c.timers, &testClockTimer{at: c.now.Add(d), seq: c.seq, ch: ch})
	return ch
}

// Advance moves the clock forward by d and fires every due timer with its
// scheduled instant. It reports how many timers fired.
func (c *TestClock) Advance(d time.Duration) (int, error) {
	if d < 0 {
		return 0, fmt.Errorf("a test clock cannot move backwards (%s)", d)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	target := c.now.Add(d)
	var due []*testClockTimer
	var pending []*testClockTimer
	for _, timer := range c.timers {
		if !timer.at.After(target) {
			due = append(due, timer)
			continue
		}
		pending = append(pending, timer)
	}
	sort.Slice(due, func(i, j int) bool {
		if !due[i].at.Equal(due[j].at) {
			return due[i].at.Before(due[j].at)
		}
		return due[i].seq < due[j].seq
	})
	c.now = target
	c.timers = pending
	for _, timer := range due {
		timer.ch <- timer.at
	}
	return len(due), nil
}
