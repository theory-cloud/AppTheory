package testkit

import (
	"context"
	"sync"
	"time"

	"github.com/theory-cloud/apptheory"
)

// Env is a deterministic local test environment for AppTheory apps.
type Env struct {
	Clock *ManualClock
}

func New() *Env {
	return NewWithTime(time.Unix(0, 0).UTC())
}

func NewWithTime(now time.Time) *Env {
	return &Env{Clock: NewManualClock(now)}
}

func (e *Env) App(opts ...apptheory.Option) *apptheory.App {
	combined := make([]apptheory.Option, 0, len(opts)+1)
	combined = append(combined, apptheory.WithClock(e.Clock))
	combined = append(combined, opts...)
	return apptheory.New(combined...)
}

func (e *Env) Invoke(ctx context.Context, app *apptheory.App, req apptheory.Request) apptheory.Response {
	if ctx == nil {
		ctx = context.Background()
	}
	return app.Serve(ctx, req)
}

// ManualClock is a deterministic, mutable clock for tests.
type ManualClock struct {
	mu  sync.Mutex
	now time.Time
}

var _ apptheory.Clock = (*ManualClock)(nil)

func NewManualClock(now time.Time) *ManualClock {
	return &ManualClock{now: now}
}

func (c *ManualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *ManualClock) Set(now time.Time) {
	c.mu.Lock()
	c.now = now
	c.mu.Unlock()
}

func (c *ManualClock) Advance(d time.Duration) time.Time {
	c.mu.Lock()
	c.now = c.now.Add(d)
	out := c.now
	c.mu.Unlock()
	return out
}

