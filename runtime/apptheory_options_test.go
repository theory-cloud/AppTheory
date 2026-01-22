package apptheory

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type fixedClock struct{ now time.Time }

func (c fixedClock) Now() time.Time { return c.now }

type fixedIDs struct{ id string }

func (g fixedIDs) NewID() string { return g.id }

func TestNew_SkipsNilOptionAndSetsDefaults(t *testing.T) {
	app := New(nil)

	require.NotNil(t, app.router)
	require.NotNil(t, app.webSocketClientFactory)
	require.Equal(t, TierP2, app.tier)
}

func TestWithClock_SetsAndDefaults(t *testing.T) {
	now := time.Unix(123, 0).UTC()

	app := New(WithClock(fixedClock{now: now}))
	require.Equal(t, now, app.clock.Now())

	app = New(WithClock(nil))
	_, ok := app.clock.(RealClock)
	require.True(t, ok)
}

func TestWithIDGenerator_SetsAndDefaults(t *testing.T) {
	app := New(WithIDGenerator(fixedIDs{id: "x"}))
	require.Equal(t, "x", app.ids.NewID())

	app = New(WithIDGenerator(nil))
	_, ok := app.ids.(RandomIDGenerator)
	require.True(t, ok)
}
