package apptheory

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// Context is the per-request context passed to handlers.
type Context struct {
	ctx     context.Context
	Request Request
	Params  map[string]string
	clock   Clock
	ids     IDGenerator

	RequestID       string
	TenantID        string
	AuthIdentity    string
	RemainingMS     int
	MiddlewareTrace []string

	ws *WebSocketContext

	values map[string]any
}

func (c *Context) Context() context.Context {
	if c == nil || c.ctx == nil {
		return context.Background()
	}
	return c.ctx
}

func (c *Context) Now() time.Time {
	if c == nil || c.clock == nil {
		return time.Now()
	}
	return c.clock.Now()
}

func (c *Context) NewID() string {
	if c == nil || c.ids == nil {
		return RandomIDGenerator{}.NewID()
	}
	return c.ids.NewID()
}

func (c *Context) Param(name string) string {
	if c == nil || c.Params == nil {
		return ""
	}
	return c.Params[name]
}

func (c *Context) JSONValue() (any, error) {
	if c == nil {
		return nil, &AppError{Code: errorCodeBadRequest, Message: errorMessageInvalidJSON}
	}
	if !hasJSONContentType(c.Request.Headers) {
		return nil, &AppError{Code: errorCodeBadRequest, Message: errorMessageInvalidJSON}
	}
	if len(c.Request.Body) == 0 {
		return nil, nil
	}

	var value any
	if err := json.Unmarshal(c.Request.Body, &value); err != nil {
		return nil, &AppError{Code: errorCodeBadRequest, Message: errorMessageInvalidJSON}
	}
	return value, nil
}

func (c *Context) AsWebSocket() *WebSocketContext {
	if c == nil {
		return nil
	}
	return c.ws
}

func (c *Context) Set(key string, value any) {
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

func (c *Context) Get(key string) any {
	if c == nil || c.values == nil {
		return nil
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return nil
	}
	return c.values[key]
}

func hasJSONContentType(headers map[string][]string) bool {
	for _, value := range headers["content-type"] {
		v := strings.ToLower(strings.TrimSpace(value))
		if strings.HasPrefix(v, "application/json") {
			return true
		}
	}
	return false
}
