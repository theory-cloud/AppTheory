package mcp

import (
	"context"
	"strings"

	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
	"github.com/theory-cloud/apptheory/v6/runtime/oauth"
)

type callerIdentityContextKey struct{}

func callerIdentity(c *apptheory.Context) string {
	if c == nil {
		return ""
	}
	if identity := strings.TrimSpace(c.AuthIdentity); identity != "" {
		return identity
	}
	if principal := c.SecurePrincipal(); principal != nil {
		if identity := strings.TrimSpace(principal.Identity); identity != "" {
			return identity
		}
	}
	if claims, ok := oauth.BearerTokenClaimsFromContext(c); ok {
		if subject := strings.TrimSpace(claims.Subject); subject != "" {
			return subject
		}
	}
	if c.TenantBound {
		return strings.TrimSpace(c.TenantID)
	}
	return ""
}

func withCallerIdentity(ctx context.Context, identity string) context.Context {
	if identity == "" {
		return ctx
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, callerIdentityContextKey{}, identity)
}

func callerIdentityFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	identity, ok := ctx.Value(callerIdentityContextKey{}).(string)
	if !ok {
		return ""
	}
	return identity
}

func sessionPrincipalMismatch(ctx context.Context, sess *Session) bool {
	return sess != nil && sess.Principal != "" && sess.Principal != callerIdentityFromContext(ctx)
}
