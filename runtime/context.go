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
	TraceID         string
	TenantID        string
	AuthIdentity    string
	AuthPrincipal   *AuthPrincipal
	RemainingMS     int
	MiddlewareTrace []string

	// TenantBound reports that TenantID was derived from the verified
	// principal's configured tenant claim rather than a caller-supplied
	// header or query value.
	TenantBound bool
	// TenantBindingRequired reports that the app is configured with a
	// principal-aware resolver, so surfaces that bind tenant to identity must
	// require a claim-derived tenant. False in legacy mode.
	TenantBindingRequired bool

	ws              *WebSocketContext
	appsync         *AppSyncContext
	securePrincipal *SecurePrincipal

	// clientRequestID is the well-formed, client-supplied x-request-id header
	// value, or empty when the header is absent or malformed. It is exposed
	// read-only through ClientRequestID.
	clientRequestID string

	values map[string]any
}

// AppSyncContext exposes AppSync-specific resolver metadata on request contexts.
type AppSyncContext struct {
	FieldName      string
	ParentTypeName string
	Arguments      map[string]any
	Identity       map[string]any
	Source         map[string]any
	Variables      map[string]any
	Stash          map[string]any
	Prev           any
	RequestHeaders map[string]string
	RawEvent       AppSyncResolverEvent
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

func (c *Context) Header(name string) string {
	if c == nil {
		return ""
	}
	return firstHeaderValue(c.Request.Headers, name)
}

func (c *Context) Query(name string) string {
	values := c.QueryAll(name)
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func (c *Context) QueryAll(name string) []string {
	if c == nil || c.Request.Query == nil {
		return nil
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	values := c.Request.Query[name]
	if len(values) == 0 {
		return nil
	}
	return append([]string(nil), values...)
}

// SourceProvenance returns provider-derived HTTP source metadata for the request.
//
// Forwarded and X-Forwarded-For headers are not parsed or trusted by this API.
func (c *Context) SourceProvenance() SourceProvenance {
	if c == nil {
		return unknownSourceProvenance()
	}
	return normalizeSourceProvenance(c.Request.SourceProvenance)
}

// SourceIP returns the provider-derived source IP convenience value.
func (c *Context) SourceIP() string {
	return c.SourceProvenance().SourceIP
}

// TraceContextID returns the inbound trace ID extracted during request normalization.
//
// The runtime records inbound trace context only; it does not synthesize a new
// trace ID when no supported trace header is present.
func (c *Context) TraceContextID() string {
	if c == nil {
		return ""
	}
	return strings.TrimSpace(c.TraceID)
}

// ClientRequestID returns the well-formed client-supplied x-request-id header
// value, or an empty string when the header is absent or malformed.
//
// The value is client-supplied and untrusted. Use it for identity and
// correlation only — never for authorization. A value is well-formed when,
// after trimming leading and trailing whitespace, it is 1 to
// MaxClientRequestIDLength visible ASCII characters; see
// IsWellFormedClientRequestID.
//
// The value is available in both request-ID source modes. In
// RequestIDSourceServer mode it is exposed here and nowhere else: it is never
// the request ID, the error envelope request_id, the x-request-id response
// header, or a log field.
func (c *Context) ClientRequestID() string {
	if c == nil {
		return ""
	}
	return c.clientRequestID
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

func (c *Context) AsAppSync() *AppSyncContext {
	if c == nil {
		return nil
	}
	return c.appsync
}

// SecurePrincipal returns a defensive deep copy of the resolved secure principal.
func (c *Context) SecurePrincipal() *SecurePrincipal {
	if c == nil {
		return nil
	}
	return cloneSecurePrincipal(c.securePrincipal)
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
