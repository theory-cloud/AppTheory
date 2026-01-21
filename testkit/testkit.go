package testkit

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/theory-cloud/apptheory/runtime"
)

// Env is a deterministic local test environment for AppTheory apps.
type Env struct {
	Clock *ManualClock
	IDs   *ManualIDGenerator
}

func New() *Env {
	return NewWithTime(time.Unix(0, 0).UTC())
}

func NewWithTime(now time.Time) *Env {
	return &Env{
		Clock: NewManualClock(now),
		IDs:   NewManualIDGenerator(),
	}
}

func (e *Env) App(opts ...apptheory.Option) *apptheory.App {
	combined := make([]apptheory.Option, 0, len(opts)+1)
	combined = append(combined, apptheory.WithClock(e.Clock))
	combined = append(combined, apptheory.WithIDGenerator(e.IDs))
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

// ManualIDGenerator is a deterministic, predictable ID generator for tests.
type ManualIDGenerator struct {
	mu     sync.Mutex
	prefix string
	next   int64
	queue  []string
}

var _ apptheory.IDGenerator = (*ManualIDGenerator)(nil)

func NewManualIDGenerator() *ManualIDGenerator {
	return &ManualIDGenerator{prefix: "test-id", next: 1}
}

func (g *ManualIDGenerator) Queue(ids ...string) {
	g.mu.Lock()
	g.queue = append(g.queue, ids...)
	g.mu.Unlock()
}

func (g *ManualIDGenerator) Reset() {
	g.mu.Lock()
	g.queue = nil
	g.next = 1
	g.mu.Unlock()
}

func (g *ManualIDGenerator) NewID() string {
	g.mu.Lock()
	defer g.mu.Unlock()

	if len(g.queue) > 0 {
		out := g.queue[0]
		g.queue = g.queue[1:]
		return out
	}

	out := fmt.Sprintf("%s-%s", g.prefix, strconv.FormatInt(g.next, 10))
	g.next++
	return out
}
