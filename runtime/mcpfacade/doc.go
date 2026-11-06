// Package mcpfacade composes AppTheory's Go runtime MCP OAuth facade.
//
// The package registers the route families defined by
// runtime/mcproutes.ContractVersion. It serves RFC 9728 protected-resource metadata
// and RFC 8414 authorization-server discovery while leaving authorization and
// token behavior in application-owned handlers.
//
// MCP transport routes (POST, GET, and DELETE on every MCP pattern) are
// registered with an authenticated posture by default: requests without a
// verified principal are rejected with HTTP 401 and the MCP handler never runs.
// Set FacadeConfig.TransportPosture to select another posture: runtime-bearer
// pairs with FacadeConfig.RequireBearerToken to validate an RFC 9728 bearer
// token in a route-level guard that runs before application middleware, and
// none-public is the explicit public posture.
//
// # Mounting on a closed-by-default SecureApp
//
// RegisterMCPFacade installs the facade on the legacy App surface.
// RegisterMCPFacadeSecure installs the same route inventory, with the same
// request-time behavior, on a closed-by-default SecureApp. Use the SecureApp
// registrar for an application that already runs its non-MCP route families on
// a SecureApp: mounting the facade on the legacy surface instead would drop the
// application's SecurePrincipalResolver, tier, and PolicyHook for every route
// that shares the app.
//
// SecureApp requires every route to declare exactly one auth posture at
// registration, so the SecureApp registrar declares the posture each facade
// route has always had. The table below is the authority for each family; it is
// the same table on both surfaces, restated in SecureApp's vocabulary.
//
//	Route family                          SecureApp posture  Authority
//	MCP transport, posture iam or jwt     Authenticated()    the app's SecurePrincipalResolver (the gateway has already validated the caller)
//	MCP transport, posture runtime-bearer Public()           the facade's route-level RFC 9728 bearer guard, which runs before application middleware and fails closed
//	MCP transport, posture none-public    Public()           none, by explicit facade contract
//	protected-resource metadata           Public()           none: RFC 9728 metadata is public by design
//	authorization-server discovery        Public()           none: RFC 8414 metadata is public by design
//	/authorize and /token                 Public()           the client-facing protocol surface itself: PKCE and the single-use code
//	/register (RFC 7591)                  Public()           the DCR handler, which admits public clients only
//	upstream callback                     Public()           the callback handler, which pins state and iss before consuming anything
//	root authorization server             Public()           none: RFC 8414 metadata is public by design
//
// "Public" here is a declaration, never an omission: a route this package does
// not register is not reachable at all, and the application's own resolver,
// tier, and PolicyHook keep governing every route the facade does not own. The
// PolicyHook (tier P2) runs before the posture gate on both surfaces, so a
// consumer that denies a request in its hook denies it on facade routes too;
// that is the consumer's declared authority, not a framework loophole.
package mcpfacade
