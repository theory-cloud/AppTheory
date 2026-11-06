# Worked minimal non-TMS consumer (M0, item 6b)

Status: reference walkthrough (M0), kept as-built through the closed-by-default SecureApp seam (G12).
Last updated: 2026-10-15
Owner: AppTheory

SAN-110-3: success criterion 2 ("a runtime-validated OAuth bearer MCP app behind an upstream provider on one
domain can be built without app-side route algebra, challenge emission, DCR route wiring, validator glue or
hand-wired facade routes") must be **proven by construction**, not inferred from TMS. This is that
construction: a fictional non-TMS application, `acme-mcp`, using a fictional provider **Acme ID**.

Nothing here was implemented in M0; it is the target shape M1–M4 made true. The fixture
`facade-journey.v1.json` — authored in this directory and now executed from the shared corpus — is the walkthrough's
machine-readable form.

## The whole application

### Runtime registration (Go)

```go
app := apptheory.New()

_, err := mcpfacade.RegisterMCPFacade(app, mcpfacade.FacadeConfig{
    URLMode:       mcpfacade.URLModePublicBaseURL,
    PublicBaseURL: "https://mcp.example.com",     // the single domain
    IssuerMode:    mcpfacade.IssuerModeRoute,      // each route is its own AS issuer
    TransportPosture: mcpfacade.TransportPostureRuntimeBearer,
    RequireBearerToken: &oauth.RequireBearerTokenOptions{
        Validator: validator,                      // framework JWKS/RS256 validator, wrapped with the Acme adapter
    },
    Scopes:             routeScopes,               // app policy: which scopes each route allows
    MCPHandler:         mcpHandler,
    Provider:           acmeID.Adapter(acmeConfig), // provider SPI: Autheory is the first adapter; Acme is another
    Stores:             stores,                     // store SPI: durable in prod, in-memory reference in tests
    UpstreamCallbackPath: "/_oauth/mcp/callback",   // framework default; shown for clarity
})
```

The TypeScript and Python registrars (`registerMcpFacade` / `register_mcp_facade`) take the same fields with
idiomatic casing. The framework **derives** every route: transport, protected-resource, canonical + suffix
discovery, authorize, token, `/register`, and the single callback.

### Runtime registration when the app is a SecureApp (Go)

An application that already runs its own route families on a closed-by-default `SecureApp` — the golden consumer runs
its MCP, download, GitHub, email, internal, and OAuth families on one `SecureApp`, whose principal resolver backs its
admission engine — mounts the same facade with the companion registrar instead of switching to a plain `App`:

```go
secure := apptheory.NewSecure(apptheory.SecureOptions{
    PrincipalResolver: acmePrincipalResolver, // the app's own admission engine, still governing its own routes
    PolicyHook:        acmePolicyHook,
})

// The app's non-MCP families keep their own postures.
secure.Get("/internal/audit", auditHandler, apptheory.Authenticated())

_, err := mcpfacade.RegisterMCPFacadeSecure(secure, mcpfacade.FacadeConfig{
    // the same FacadeConfig as above, unchanged
})
```

`registerMcpFacadeSecure` and `register_mcp_facade_secure` are the TypeScript and Python equivalents. The facade
declares the posture each of its routes has always had — the transport route keeps the RFC 9728 bearer validator as
its authority under `runtime-bearer`, and the OAuth metadata, authorize, token, `/register`, and callback routes stay
public by design — so nothing about the journey above changes. See
[Closed-by-default SecureApp mounts](../../../../features/mcp-facade-helper.md#closed-by-default-secureapp-mounts) for the full
route-authority table.

### CDK (TypeScript)

```ts
new AppTheoryMcpServer(this, "AcmeMcp", {
  handler: mcpFn,
  facade: { providerId: "acme" },                 // presence attaches the OAuth facade: selects the runtime-bearer default
  routeFamily: { patterns: ["/{client_namespace}/mcp"], rootAuthorizationServerDiscovery: false },
  runtimePosture: { requireBearerToken: true },    // the runtime-posture declaration the pairing requires
  originReachability: AppTheoryMcpOriginReachability.DISABLED, // mandatory proven decision (DD-2)
  ownedApi: {
    // The single public domain. DISABLED disables the execute-api default
    // endpoint and advertises only this domain.
    domain: { domainName: "mcp.example.com", certificate: acmeCertificate },
    // Mandatory explicit stage-throttling decision under runtime-bearer.
    stage: { throttlingEnabled: true },
  },
  denialSignal: { metricName: "apptheory.mcp.auth_denied" }, // mandatory declaration (DD-3)
});
```

`AppTheoryMcpOriginReachability.LOCKED` is stricter, not an alias: it additionally requires
`ownedApi.domain.mutualTlsAuthentication` and final proof that every mapped domain carries a truststore URI. Use it only
when every client can present a trusted certificate; attach-mode LOCKED is unsupported.

`transportPosture` is deliberately **not** set: the `facade` attach is the predicate that selects the
`runtime-bearer` default (`DEFAULT_SEMANTICS.md`). The prop names above are the shipped construct's; the
`facade` attachment is presence-only and its `providerId` must be a synthesis-time literal string.

The construct derives and mounts the transport routes, the OAuth surface, and the derived `/register` and
callback routes; it does **not** require the app to spell a single route string.

### What the app did NOT write

- No route algebra: no `/authorize`, `/token`, `/.well-known/*`, `/register`, or callback path strings.
- No challenge emission: no `WWW-Authenticate` construction, no `resource_metadata` derivation, no
  `insufficient_scope` handling.
- No validator glue: no JWT parsing, JWKS fetch/cache, discovery bootstrap, issuer/audience checks.
- No facade mechanics: no transaction/code store, no upstream redirect construction, no callback exchange, no
  brokered refresh.
- No posture selection for the common case: attaching `facade` selects the `runtime-bearer` default, so the app
  writes no `transportPosture` enum (`runtimePosture` is the runtime-posture declaration the pairing reads).
- Only policy: the scope vocabulary (`routeScopes`), the provider adapter, and the durable store bindings.

## The journey (what a client does, and what the framework answers)

Base URL `https://mcp.example.com`; route resource `https://mcp.example.com/acme/mcp`; provider issuer
`https://id.example.com`. These are exactly the fixture `world` domains in
`contract-tests/fixtures/routing/mcp-auth-facade/facade-journey.v1.json`, so the prose and the machine-readable
transcript agree — and that transcript is now executed by the Go, TypeScript, and Python suites rather than being
documentation only. The fictional provider `Acme ID` issues from `https://id.example.com`.

| # | Client action | Framework answer |
| --- | --- | --- |
| 1 | `POST /acme/mcp` with no token | `401` + `WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/acme/mcp"`; **handler not invoked** |
| 2 | `GET /.well-known/oauth-protected-resource/acme/mcp` | `200` `{ resource: "https://mcp.example.com/acme/mcp", authorization_servers: ["https://mcp.example.com/acme/mcp"], scopes_supported: [...] }` |
| 3 | `GET /.well-known/oauth-authorization-server/acme/mcp` | `200` `{ issuer: "https://mcp.example.com/acme/mcp", authorization_endpoint: ".../authorize", token_endpoint: ".../token", registration_endpoint: ".../register", jwks_uri: "https://id.example.com/.well-known/jwks.json" }` |
| 4 | `POST .../acme/mcp/register` (public client, PKCE, loopback https redirect) | `201` `{ client_id: "acme_…", token_endpoint_auth_method: "none", … }`; bound to the route; rate limited |
| 5 | `GET .../authorize?client_id=…&redirect_uri=…&response_type=code&code_challenge=…&code_challenge_method=S256&state=…&resource=https://mcp.example.com/acme/mcp` | `302` to the provider with the facade's own upstream client/callback/PKCE/fresh state/`resource`; single-use transaction recorded |
| 6 | provider redirects to `/_oauth/mcp/callback?code=…&state=…&iss=https://id.example.com` | facade verifies `iss`, consumes the state single-use, exchanges the code server-side, validates the upstream token fail-closed, opens the broker record, and `302`s to the client with `code=<facade code>&state=<client state>&iss=https://mcp.example.com/acme/mcp` |
| 7 | `POST .../token` `grant_type=authorization_code&code=<facade code>&code_verifier=…&redirect_uri=…&client_id=…` | `200` `{ access_token: <upstream token, byte-for-byte>, refresh_token: "rt_…" (opaque handle), token_type: "Bearer", expires_in, scope }` — **no `id_token`** |
| 8 | `POST /acme/mcp` with the access token | `200` MCP response; **handler invoked exactly once** |
| 9 | `POST .../token` `grant_type=refresh_token&refresh_token=rt_…` | `200` rotated handle + a fresh access token; upstream refresh material never serialized; concurrent callers single-flighted |
| 10 | `POST /acme/mcp` with an expired token | `401` challenge (step 1 shape) |
| 11 | `POST /acme/mcp` with a token missing `mcp:tools` | `403` + `insufficient_scope` and the scope set that remediates |

## Negative assertions the walkthrough pins (SAN-110-1)

- Step 6 and 7 responses contain **no** upstream authorization code, **no** upstream refresh token, and **no**
  `id_token`.
- Step 7's `access_token` is byte-identical to the upstream-minted token.
- Step 1's `handler_invocations == 0`; step 8's `handler_invocations == 1`.
- Step 4's client id is bound to `/acme/mcp`; a token for `/acme/mcp` is refused at another route.

## Fixtures that make this construction checkable

- `contract-tests/fixtures/routing/mcp-auth-facade/facade-journey.v1.json` — the ordered transcript above (steps
  1–11), with expected statuses, headers, and bodies, **executed** by the Go, TypeScript, and Python suites.
- `contract-tests/fixtures/routing/mcp-auth-facade/facade-threat-controls.v1.json` — T1-T11, each pinned to the
  executed row that proves it.
- `contract-tests/fixtures/routing/mcp-auth-facade/facade-conformance.v1.json` — the per-feature conformance groups,
  including `secure_app_mount`, which pins the authority table above for a `SecureApp` mount: the posture every facade
  route declares for each transport posture, the requests that must still be served or refused under the app's own
  principal authority, and the equality of the two registrars' route inventories, **executed** by all three suites.
- `contract-tests/fixtures/routing/mcp-auth-facade/facade-route-model.v1.json` — the derived paths and the `route`
  issuer/resource derivation the app never wrote (moved into the corpus in M1).
- `contract-tests/fixtures/routing/mcp-auth-facade/facade-transport-posture.v1.json` — the posture expectations pinned
  by the conformance kit (moved into the corpus in M1).
- planning-tree `fixtures/facade-provider-spi.v1.json` / `facade-store-spi.v1.json` — the seams the app *did* supply
  (the provider adapter and the durable stores).

## Why this proves scenario (a)

A developer with a provider, a scope vocabulary, and a store can reach a working single-domain MCP auth facade
with **config, an adapter, and a store** — no route strings, no challenge code, no validator code, no facade
mechanics. That is the exact outcome operator ruling 1 and success criterion 2 require, and it is proven here
against a provider that is **not** Autheory, so the design is not tailored to TMS.

## Open decisions

1. Whether `UpstreamCallbackPath` is a framework default (`/_oauth/mcp/callback`) or required config
   (recommend: default, overridable).
2. Whether the route scope vocabulary is supplied as a map keyed by endpoint kind (current `FacadeConfig.Scopes`
   shape) or as a function of the route (recommend: keep the map; add the per-route function only where a
   deployment needs dynamic scopes).
