package apptheory

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/lambdacontext"
)

// EventContext is the shared context for non-HTTP Lambda triggers (SQS, EventBridge, DynamoDB Streams).
type EventContext struct {
	ctx context.Context

	clock Clock
	ids   IDGenerator

	RequestID   string
	RemainingMS int

	rawEvent json.RawMessage
	values   map[string]any
}

func (c *EventContext) cloneForRecord() *EventContext {
	if c == nil {
		return nil
	}
	return &EventContext{
		ctx:         c.ctx,
		clock:       c.clock,
		ids:         c.ids,
		RequestID:   c.RequestID,
		RemainingMS: c.RemainingMS,
		rawEvent:    append(json.RawMessage(nil), c.rawEvent...),
	}
}

func (c *EventContext) Context() context.Context {
	if c == nil || c.ctx == nil {
		return context.Background()
	}
	return c.ctx
}

func (c *EventContext) Now() time.Time {
	if c == nil || c.clock == nil {
		return time.Now()
	}
	return c.clock.Now()
}

func (c *EventContext) NewID() string {
	if c == nil || c.ids == nil {
		return RandomIDGenerator{}.NewID()
	}
	return c.ids.NewID()
}

func (c *EventContext) Set(key string, value any) {
	if c == nil {
		return
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return
	}
	if c.values == nil {
		c.values = map[string]any{}
	}
	c.values[key] = value
}

func (c *EventContext) Get(key string) any {
	if c == nil || c.values == nil {
		return nil
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return nil
	}
	return c.values[key]
}

func (a *App) eventContext(ctx context.Context) *EventContext {
	if ctx == nil {
		ctx = context.Background()
	}

	requestID := ""
	if lc, ok := lambdacontext.FromContext(ctx); ok {
		requestID = strings.TrimSpace(lc.AwsRequestID)
	}
	if requestID == "" {
		requestID = a.newRequestID()
	}

	return &EventContext{
		ctx:         ctx,
		clock:       a.clock,
		ids:         a.ids,
		RequestID:   requestID,
		RemainingMS: remainingMSFromContext(ctx, a.clock),
	}
}
