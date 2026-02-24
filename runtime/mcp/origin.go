package mcp

import "strings"

// OriginValidator validates an HTTP Origin header value.
//
// If a request includes an Origin header and the validator returns false, the
// server should reject the request (fail closed).
type OriginValidator func(origin string) bool

func AllowOrigins(origins ...string) OriginValidator {
	allowed := make(map[string]struct{}, len(origins))
	for _, o := range origins {
		o = strings.TrimSpace(o)
		if o != "" {
			allowed[o] = struct{}{}
		}
	}

	return func(origin string) bool {
		origin = strings.TrimSpace(origin)
		if origin == "" {
			return false
		}
		_, ok := allowed[origin]
		return ok
	}
}
