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

func hasJSONContentType(headers map[string][]string) bool {
	for _, value := range headers["content-type"] {
		v := strings.ToLower(strings.TrimSpace(value))
		if strings.HasPrefix(v, "application/json") {
			return true
		}
	}
	return false
}
