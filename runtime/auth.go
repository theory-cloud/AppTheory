package apptheory

import "strings"

// AuthPrincipal captures richer auth state for a request.
type AuthPrincipal struct {
	Identity string
	Scopes   []string
	Claims   map[string]any
}

// PrincipalAuthHook resolves the current request principal.
type PrincipalAuthHook func(*Context) (*AuthPrincipal, error)

// WithAuthPrincipalHook configures a principal-aware auth hook for the app.
func WithAuthPrincipalHook(hook PrincipalAuthHook) Option {
	return func(app *App) {
		app.principalAuth = hook
	}
}

func (a *App) authenticate(ctx *Context) (*AuthPrincipal, error) {
	if a == nil {
		return nil, nil
	}
	if a.principalAuth != nil {
		principal, err := a.principalAuth(ctx)
		if err != nil {
			return nil, err
		}
		return normalizeAuthPrincipal(principal), nil
	}
	if a.auth == nil {
		return nil, nil
	}

	identity, err := a.auth(ctx)
	if err != nil {
		return nil, err
	}
	identity = strings.TrimSpace(identity)
	if identity == "" {
		return nil, nil
	}
	return &AuthPrincipal{Identity: identity}, nil
}

func normalizeAuthPrincipal(principal *AuthPrincipal) *AuthPrincipal {
	if principal == nil {
		return nil
	}

	out := &AuthPrincipal{
		Identity: strings.TrimSpace(principal.Identity),
		Scopes:   normalizeScopeList(principal.Scopes),
	}
	if len(principal.Claims) > 0 {
		out.Claims = make(map[string]any, len(principal.Claims))
		for key, value := range principal.Claims {
			out.Claims[key] = value
		}
	}
	return out
}

func normalizeScopeList(scopes []string) []string {
	if len(scopes) == 0 {
		return nil
	}

	out := make([]string, 0, len(scopes))
	seen := make(map[string]struct{}, len(scopes))
	for _, scope := range scopes {
		scope = strings.TrimSpace(scope)
		if scope == "" {
			continue
		}
		if _, ok := seen[scope]; ok {
			continue
		}
		seen[scope] = struct{}{}
		out = append(out, scope)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func principalHasScope(principal *AuthPrincipal, scope string) bool {
	if principal == nil || scope == "" {
		return false
	}
	for _, candidate := range principal.Scopes {
		if candidate == scope {
			return true
		}
	}
	return false
}

func principalHasAllScopes(principal *AuthPrincipal, scopes []string) bool {
	for _, scope := range normalizeScopeList(scopes) {
		if !principalHasScope(principal, scope) {
			return false
		}
	}
	return true
}

func principalHasAnyScope(principal *AuthPrincipal, scopes []string) bool {
	normalized := normalizeScopeList(scopes)
	if len(normalized) == 0 {
		return true
	}
	for _, scope := range normalized {
		if principalHasScope(principal, scope) {
			return true
		}
	}
	return false
}
