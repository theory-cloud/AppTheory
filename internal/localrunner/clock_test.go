package localrunner

import (
	"testing"
	"time"
)

func TestParseClockSpec(t *testing.T) {
	realClock, err := ParseClockSpec("")
	if err != nil {
		t.Fatalf("empty clock: %v", err)
	}
	if ClockModeOf(realClock) != ClockModeReal {
		t.Fatalf("empty clock must be the real clock")
	}
	realClock, err = ParseClockSpec("real")
	if err != nil || ClockModeOf(realClock) != ClockModeReal {
		t.Fatalf("real clock: %v %v", realClock, err)
	}
	testClock, err := ParseClockSpec("test")
	if err != nil {
		t.Fatalf("test clock: %v", err)
	}
	if ClockModeOf(testClock) != ClockModeTest || !testClock.Now().Equal(DefaultTestClockStart) {
		t.Fatalf("test clock must start at the default instant: %v", testClock.Now())
	}
	start := "2026-11-03T09:30:00Z"
	testClock, err = ParseClockSpec("test=" + start)
	if err != nil {
		t.Fatalf("test clock with a start: %v", err)
	}
	want, parseErr := time.Parse(time.RFC3339, start)
	if parseErr != nil {
		t.Fatalf("parse start: %v", parseErr)
	}
	if !testClock.Now().Equal(want) {
		t.Fatalf("test clock start: got %s want %s", testClock.Now(), want)
	}
	for _, value := range []string{"wall", "test=not-a-time", "test=2026-11-03"} {
		if _, err := ParseClockSpec(value); err == nil {
			t.Fatalf("clock spec %q must fail", value)
		}
	}
}

func TestTestClockAdvancesAndFiresDueTimers(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	clock := NewTestClock(start)
	first := clock.After(30 * time.Minute)
	second := clock.After(2 * time.Hour)
	if fired, err := clock.Advance(45 * time.Minute); err != nil || fired != 1 {
		t.Fatalf("advance 45m: fired=%d err=%v", fired, err)
	}
	select {
	case at := <-first:
		if !at.Equal(start.Add(30 * time.Minute)) {
			t.Fatalf("first timer fired at %s", at)
		}
	default:
		t.Fatal("the 30m timer did not fire")
	}
	select {
	case at := <-second:
		t.Fatalf("the 2h timer fired early at %s", at)
	default:
	}
	if fired, err := clock.Advance(75 * time.Minute); err != nil || fired != 1 {
		t.Fatalf("advance 75m: fired=%d err=%v", fired, err)
	}
	select {
	case at := <-second:
		if !at.Equal(start.Add(2 * time.Hour)) {
			t.Fatalf("second timer fired at %s", at)
		}
	default:
		t.Fatal("the 2h timer did not fire")
	}
	if !clock.Now().Equal(start.Add(2 * time.Hour)) {
		t.Fatalf("clock now: %s", clock.Now())
	}
}

func TestRealClockAfter(t *testing.T) {
	select {
	case at := <-(RealClock{}).After(time.Millisecond):
		if time.Since(at) > time.Minute {
			t.Fatalf("the real clock fired at %s", at)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the real clock did not fire")
	}
}

func TestTestClockRejectsABackwardsMove(t *testing.T) {
	clock := NewTestClock(DefaultTestClockStart)
	if _, err := clock.Advance(-time.Minute); err == nil {
		t.Fatal("a backwards advance must fail")
	}
}

func TestTestClockFiresDifferentDueTimersInOrder(t *testing.T) {
	clock := NewTestClock(DefaultTestClockStart)
	first := clock.After(time.Minute)
	second := clock.After(2 * time.Minute)
	if fired, err := clock.Advance(5 * time.Minute); err != nil || fired != 2 {
		t.Fatalf("advance: fired=%d err=%v", fired, err)
	}
	firstAt := <-first
	secondAt := <-second
	if !firstAt.Before(secondAt) {
		t.Fatalf("timers fired out of order: %s then %s", firstAt, secondAt)
	}
}

func TestTestClockFiresEqualTimersInRegistrationOrder(t *testing.T) {
	clock := NewTestClock(DefaultTestClockStart)
	first := clock.After(time.Minute)
	second := clock.After(time.Minute)
	if fired, err := clock.Advance(time.Minute); err != nil || fired != 2 {
		t.Fatalf("advance: fired=%d err=%v", fired, err)
	}
	firstAt := <-first
	secondAt := <-second
	if !firstAt.Equal(secondAt) || !firstAt.Equal(DefaultTestClockStart.Add(time.Minute)) {
		t.Fatalf("equal timers fired at %s and %s", firstAt, secondAt)
	}
}

func TestTestClockFiresImmediateTimers(t *testing.T) {
	clock := NewTestClock(DefaultTestClockStart)
	select {
	case at := <-clock.After(0):
		if !at.Equal(DefaultTestClockStart) {
			t.Fatalf("immediate timer at %s", at)
		}
	default:
		t.Fatal("a zero-duration timer must fire immediately")
	}
}
