package apptheory

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

type policyContextObservation struct {
	tenantID          string
	requestedTenantID string
	authIdentity      string
	authPrincipal     bool
}

func TestP2PolicyHookDoesNotSeeCallerControlledTenant(t *testing.T) {
	var observations []policyContextObservation
	policyCalls := 0

	app := New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDGenerator("req_1")),
		WithAuthPrincipalHook(func(*Context) (*AuthPrincipal, error) {
			return &AuthPrincipal{
				Identity: "subject-1",
				Claims:   map[string]any{"tenant_id": "tenant-verified"},
			}, nil
		}),
		WithTenantClaim("tenant_id"),
		WithPolicyHook(func(ctx *Context) (*PolicyDecision, error) {
			policyCalls++
			observations = append(observations, policyContextObservation{
				tenantID:          ctx.TenantID,
				requestedTenantID: ctx.RequestedTenantID,
				authIdentity:      ctx.AuthIdentity,
				authPrincipal:     ctx.AuthPrincipal != nil,
			})
			return nil, nil
		}),
	)

	handlerTenants := make([]string, 0, 2)
	app.Get("/protected", func(ctx *Context) (*Response, error) {
		handlerTenants = append(handlerTenants, ctx.TenantID)
		return Text(200, "ok"), nil
	}, RequireAuth())
	app.Get("/open", func(ctx *Context) (*Response, error) {
		handlerTenants = append(handlerTenants, ctx.TenantID)
		return Text(200, "ok"), nil
	})

	headerResp := app.Serve(context.Background(), Request{
		Method: "GET",
		Path:   "/protected",
		Headers: map[string][]string{
			"x-tenant-id": {"tenant-caller"},
		},
	})
	require.Equal(t, 200, headerResp.Status)

	queryResp := app.Serve(context.Background(), Request{
		Method: "GET",
		Path:   "/protected",
		Query:  map[string][]string{"tenant": {"tenant-query"}},
	})
	require.Equal(t, 200, queryResp.Status)

	// An unauthenticated route keeps today's behavior: the handler still sees
	// the caller-supplied tenant, while the policy hook never does.
	openResp := app.Serve(context.Background(), Request{
		Method: "GET",
		Path:   "/open",
		Headers: map[string][]string{
			"x-tenant-id": {"tenant-open"},
		},
	})
	require.Equal(t, 200, openResp.Status)

	require.Equal(t, 3, policyCalls, "one policy evaluation per served request")
	require.Len(t, observations, 3)
	for _, observation := range observations {
		require.Empty(t, observation.tenantID, "the policy hook must not see a caller-controlled tenant")
		require.Empty(t, observation.authIdentity, "the policy hook runs before authentication")
		require.False(t, observation.authPrincipal, "the policy hook runs before authentication")
	}
	require.Equal(t, "tenant-caller", observations[0].requestedTenantID)
	require.Equal(t, "tenant-query", observations[1].requestedTenantID)
	require.Equal(t, "tenant-open", observations[2].requestedTenantID)

	// Handlers keep the existing tenant behavior: authentication rebinds
	// TenantID to the verified claim, and unauthenticated routes still expose
	// the caller-supplied value.
	require.Equal(t, []string{"tenant-verified", "tenant-verified", "tenant-open"}, handlerTenants)
}

func TestP2PolicyHookTenantClearingDoesNotMutateRequestContext(t *testing.T) {
	var policyCtxTenant string
	var policyCtxRequested string
	var handlerCtxTenant string
	var handlerCtxRequested string

	app := New(
		WithTier(TierP2),
		WithIDGenerator(fixedIDGenerator("req_1")),
		WithPolicyHook(func(ctx *Context) (*PolicyDecision, error) {
			policyCtxTenant = ctx.TenantID
			policyCtxRequested = ctx.RequestedTenantID
			// Mutating the policy copy must not leak into the request context.
			ctx.TenantID = "policy-mutated"
			return nil, nil
		}),
	)
	app.Get("/ok", func(ctx *Context) (*Response, error) {
		handlerCtxTenant = ctx.TenantID
		handlerCtxRequested = ctx.RequestedTenantID
		return Text(200, "ok"), nil
	})

	resp := app.Serve(context.Background(), Request{
		Method: "GET",
		Path:   "/ok",
		Headers: map[string][]string{
			"x-tenant-id": {"tenant-caller"},
		},
	})
	require.Equal(t, 200, resp.Status)
	require.Empty(t, policyCtxTenant)
	require.Equal(t, "tenant-caller", policyCtxRequested)
	require.Equal(t, "tenant-caller", handlerCtxTenant)
	require.Equal(t, "tenant-caller", handlerCtxRequested)
}
