package mcp

import (
	"bufio"
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

func TestInitialSessionListenerBudgetDuration(t *testing.T) {
	t.Parallel()

	t.Run("disabled without option", func(t *testing.T) {
		t.Parallel()

		s := NewServer("test", "dev")
		if got, ok := s.initialSessionListenerBudgetDuration(30_000); ok || got != 0 {
			t.Fatalf("budget = %v, %v; want disabled", got, ok)
		}
	})

	t.Run("zero values use defaults", func(t *testing.T) {
		t.Parallel()

		s := NewServer("test", "dev", WithInitialSessionListenerBudget(InitialSessionListenerBudgetOptions{}))

		got, ok := s.initialSessionListenerBudgetDuration(31_000)
		if !ok {
			t.Fatalf("expected budgeting to be enabled")
		}
		if got != 25*time.Second {
			t.Fatalf("budget = %v, want %v", got, 25*time.Second)
		}

		got, ok = s.initialSessionListenerBudgetDuration(20_000)
		if !ok {
			t.Fatalf("expected budgeting to be enabled")
		}
		if got != 15*time.Second {
			t.Fatalf("budget = %v, want %v", got, 15*time.Second)
		}
	})

	t.Run("max duration clamps remaining budget", func(t *testing.T) {
		t.Parallel()

		s := NewServer("test", "dev", WithInitialSessionListenerBudget(InitialSessionListenerBudgetOptions{
			SafetyBuffer: 100 * time.Millisecond,
			MaxDuration:  50 * time.Millisecond,
		}))

		got, ok := s.initialSessionListenerBudgetDuration(400)
		if !ok {
			t.Fatalf("expected budgeting to be enabled")
		}
		if got != 50*time.Millisecond {
			t.Fatalf("budget = %v, want %v", got, 50*time.Millisecond)
		}
	})

	t.Run("remaining time below safety buffer closes immediately", func(t *testing.T) {
		t.Parallel()

		s := NewServer("test", "dev", WithInitialSessionListenerBudget(InitialSessionListenerBudgetOptions{
			SafetyBuffer: 100 * time.Millisecond,
			MaxDuration:  50 * time.Millisecond,
		}))

		got, ok := s.initialSessionListenerBudgetDuration(80)
		if !ok {
			t.Fatalf("expected budgeting to be enabled")
		}
		if got != 0 {
			t.Fatalf("budget = %v, want immediate close", got)
		}
	})

	t.Run("missing remaining time leaves keepalive unchanged", func(t *testing.T) {
		t.Parallel()

		s := NewServer("test", "dev", WithInitialSessionListenerBudget(InitialSessionListenerBudgetOptions{}))
		if got, ok := s.initialSessionListenerBudgetDuration(0); ok || got != 0 {
			t.Fatalf("budget = %v, %v; want disabled without RemainingMS", got, ok)
		}
	})
}

func TestGET_NoLastEventID_WithInitialSessionListenerBudget_NoRemainingTime_KeepsAlive(t *testing.T) {
	s := NewServer("test-server", "1.0.0", WithInitialSessionListenerBudget(InitialSessionListenerBudgetOptions{
		SafetyBuffer: 100 * time.Millisecond,
		MaxDuration:  50 * time.Millisecond,
	}))
	sessionID := initializeSession(t, s)

	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"text/event-stream"}

	reqCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	resp, err := invokeHandlerWithMethod(reqCtx, s, "GET", nil, headers)
	if err != nil {
		t.Fatalf("invoke GET: %v", err)
	}
	if resp.BodyReader == nil {
		t.Fatalf("expected GET listener BodyReader to be set")
	}

	reader := bufio.NewReader(resp.BodyReader)
	frame, err := readSSEFrame(reader)
	if err != nil {
		t.Fatalf("read keepalive SSE frame: %v (frame=%q)", err, frame)
	}
	if !strings.HasPrefix(frame, ":") || !strings.Contains(frame, "keepalive") {
		t.Fatalf("expected keepalive comment frame, got:\n%s", frame)
	}
}

func TestGET_NoLastEventID_WithInitialSessionListenerBudget_ClosesBeforeParentDeadline(t *testing.T) {
	s := NewServer("test-server", "1.0.0", WithInitialSessionListenerBudget(InitialSessionListenerBudgetOptions{
		SafetyBuffer: 200 * time.Millisecond,
		MaxDuration:  2 * time.Second,
	}))
	sessionID := initializeSession(t, s)

	headers := sessionHeaders(sessionID)
	headers["accept"] = []string{"text/event-stream"}

	reqCtx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	defer cancel()

	start := time.Now()
	resp, err := invokeHandlerWithMethod(reqCtx, s, "GET", nil, headers)
	if err != nil {
		t.Fatalf("invoke GET: %v", err)
	}
	if resp.BodyReader == nil {
		t.Fatalf("expected GET listener BodyReader to be set")
	}

	reader := bufio.NewReader(resp.BodyReader)
	frame, err := readSSEFrame(reader)
	if err != nil {
		t.Fatalf("read keepalive SSE frame: %v (frame=%q)", err, frame)
	}
	if !strings.HasPrefix(frame, ":") || !strings.Contains(frame, "keepalive") {
		t.Fatalf("expected keepalive comment frame, got:\n%s", frame)
	}

	if _, err := io.ReadAll(reader); err != nil {
		t.Fatalf("read listener until close: %v", err)
	}

	if err := reqCtx.Err(); err != nil {
		t.Fatalf("expected listener to close before parent deadline, got %v", err)
	}

	if elapsed := time.Since(start); elapsed >= 300*time.Millisecond {
		t.Fatalf("listener closed too late: got %v, want < %v", elapsed, 300*time.Millisecond)
	}
}
