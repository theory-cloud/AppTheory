package mcp

import (
	"context"
	"testing"
	"time"

	"pgregory.net/rapid"

	apptheory "github.com/theory-cloud/apptheory/runtime"
)

// Feature: cloud-mcp-gateway, Property 9: Session Store Round-Trip
// Validates: Requirements 4.2, 4.6
//
// For any valid Session object, storing it via Put and then retrieving it via
// Get with the same ID SHALL return a session equal to the original.
func TestProperty9_SessionStoreRoundTrip(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		base := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
		sess := genSession(base).Draw(t, "session")

		store := NewMemorySessionStore(WithClock(fixedClock(base)))
		ctx := context.Background()

		if err := store.Put(ctx, &sess); err != nil {
			t.Fatalf("Put failed: %v", err)
		}

		got, err := store.Get(ctx, sess.ID)
		if err != nil {
			t.Fatalf("Get failed: %v", err)
		}

		// Verify all fields match.
		if got.ID != sess.ID {
			t.Fatalf("ID mismatch: got %q, want %q", got.ID, sess.ID)
		}
		if !got.CreatedAt.Equal(sess.CreatedAt) {
			t.Fatalf("CreatedAt mismatch: got %v, want %v", got.CreatedAt, sess.CreatedAt)
		}
		if !got.ExpiresAt.Equal(sess.ExpiresAt) {
			t.Fatalf("ExpiresAt mismatch: got %v, want %v", got.ExpiresAt, sess.ExpiresAt)
		}

		// Compare Data maps.
		if len(got.Data) != len(sess.Data) {
			t.Fatalf("Data length mismatch: got %d, want %d", len(got.Data), len(sess.Data))
		}
		for k, want := range sess.Data {
			if v, ok := got.Data[k]; !ok || v != want {
				t.Fatalf("Data[%q]: got %q, want %q", k, v, want)
			}
		}
	})
}

// fixedClock returns a Clock that always returns the given time.
type fixedClockImpl struct {
	now time.Time
}

func (c fixedClockImpl) Now() time.Time { return c.now }

func fixedClock(t time.Time) fixedClockImpl { return fixedClockImpl{now: t} }

// Feature: cloud-mcp-gateway, Property 8: Session ID Generation
// Validates: Requirements 4.1, 4.3
//
// For any sequence of N session ID generations, each ID SHALL be non-empty
// and no two IDs SHALL be the same.
func TestProperty8_SessionIDGeneration(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		n := rapid.IntRange(2, 50).Draw(t, "count")

		gen := apptheory.RandomIDGenerator{}
		seen := make(map[string]bool, n)

		for i := range n {
			id := gen.NewID()
			if id == "" {
				t.Fatalf("NewID() returned empty string at iteration %d", i)
			}
			if seen[id] {
				t.Fatalf("duplicate ID %q at iteration %d", id, i)
			}
			seen[id] = true
		}
	})
}
