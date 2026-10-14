# Upgrading AppTheory

AppTheory is released only through immutable GitHub Releases. Pin the version you consume, verify the downloaded asset,
and move one minor line at a time when possible.

This file is hand-maintained upgrade policy. It is not generated from Conventional Commits and it is not a replacement
for `CHANGELOG.md`:

- `CHANGELOG.md` is generated release history. It tells you what commits shipped.
- `UPGRADING.md` tells operators and framework consumers what action may be required, what deprecations exist, and what
  replacement path preserves AppTheory's single runtime contract.

Every minor release line that changes runtime behavior, deployment constructs, generated artifacts, dependency floors,
or deprecation posture must add or update a section here before the release is promoted.

## v6.x line

AppTheory v6 moves the Go runtime and the generated CDK Go bindings onto the next semantic import version. The release
range from the v5 line also carries other breaking runtime, CDK, TypeScript, and Python changes; read `CHANGELOG.md` and
the v6 release notes for the commit-level detail, and treat the import-path move below as the mechanical part of the
upgrade.

### Go module import paths

AppTheory v6 moves the Go runtime and the generated CDK Go bindings onto the next semantic import version. Replace the
`/v5` suffix on every AppTheory runtime import with the canonical `github.com/theory-cloud/apptheory/v6` path, pin the
v6 module tag, and run `go mod tidy`:

```bash
go get github.com/theory-cloud/apptheory/v6@v6.0.0-rc
```

Update the generated CDK Go bindings in the same release transaction: replace
`github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v5` with
`github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v6`, pin the matching v6 CDK module tag, and run `go mod tidy` in
the CDK application's module. Runtime and CDK module tags continue to target the same immutable release commit; do not
mix major lines or substitute registry-published artifacts.

The v6.0.0-rc tag is the first v6 release; pin the exact v6 release or RC tag you are moving to. Do not retain both
AppTheory major paths in one application: packages from `/v5` and `/v6` have distinct Go type identities even where
their APIs are otherwise unchanged.

Within the `/v5` to `/v6` module migration itself the Go API surface is unchanged beyond import paths: the api-snapshot
diff between the two lines is header-path-only, so Go code that compiles on v5 compiles on v6. The TypeScript and Python
runtimes carry no module-path change.

### MCP auth facade mounting in TypeScript and Python

`registerMcpFacade` (TypeScript) and `register_mcp_facade` (Python) previously mounted only the MCP transport routes
from an explicit `mcpPaths` / `mcp_paths` list. They now take the full facade configuration object that Go's
`RegisterMCPFacade` accepts and mount the same route surface as Go from the shared route algebra: the MCP transport
routes, the RFC 9728 protected-resource metadata route, both canonical and suffix-compatible RFC 8414
authorization-server metadata routes, the derived authorize/token route shapes (only when both handler factories are
supplied), the derived registration route shape (only when a register factory is supplied), the opt-in static root
discovery route, and the single stage-global callback route. There is no `mcpPaths` argument any more: the routes are
derived from the contract, not supplied.

Migration for a transport-only caller: replace the `mcpPaths` argument with the facade configuration fields
(`issuerURL`, `jwksURI`, `urlMode`, and per-kind `scopes` at minimum) and keep `mcpHandler` and `transportPosture` as
they were. The registrars still mount routes only; authorize, token, register, and callback bodies remain app-owned,
and nothing beyond what Go already mounts becomes reachable. `McpFacadeRegistration` is replaced by the `RouteInventory`
returned from the call. TypeScript and Python gain `FacadeConfig`, `FacadeRoute`, `RouteInventory`, `FacadeCapabilities`
/ `defaultCapabilities`, `RootDiscoveryConfig`, the URL-mode constants, and the `HandlerFactory` type.

### MCP auth facade front channel

The framework-owned MCP auth facade front channel is now mounted when the front-channel `FacadeConfig` field set is
declared. Setting `Provider` makes `RegisterMCPFacade` / `registerMcpFacade` / `register_mcp_facade` own and mount the
per-endpoint-kind `GET …/authorize` terminator, the one stage-global `GET /_oauth/mcp/callback`, and the
per-endpoint-kind `POST …/token` `authorization_code` grant, driven by the provider SPI and the five store SPIs. The
accompanying fields are `Stores`, `UpstreamClientID`, `UpstreamIssuer`, and optionally `LifecycleScopes` and
`ProviderHints`; the set is all-or-none, and setting any other front-channel field without a `Provider` is a
registration error. `Provider` is mutually exclusive with the application-owned `AuthorizeHandler`/`TokenHandler` pair
and `CallbackHandler`, because it claims the same routes.

Adopters that opt in must supply:

- a **provider adapter** (the Autheory adapter is the first implementation) and the **five stores**. A **durable store
  MUST encrypt every `Encrypted*` field at rest** — the facade performs no sealing and hands the store upstream
  material (including the upstream-minted access token in the code record and the upstream refresh token in the broker
  record) exactly as the provider returned it. The framework's in-memory reference stores are non-durable and do not
  encrypt, so they are for tests and local development only; a deployment supplies a durable store that discharges the
  encryption obligation.
- the facade's own **upstream client id** and the expected **upstream issuer** (the RFC 9207 `iss` the callback pins
  before consuming the transaction or exchanging the code).

Clients must be **pre-registered** through the `ClientStore`, keyed by the store hash helper (`oauthstore.HashKey` in
Go, `hashKey` in TypeScript, `hash_key` in Python) so the facade derives the same key when it looks the client up,
because dynamic client registration is not mounted.

**Not yet available in this line** (the follow-on milestone, M3c, owns them): DCR — the `/register` route is not
mounted, so no client is created by a request; the **`refresh_token` grant** — the code-exchange response already
returns a framework-minted opaque `refresh_token` handle, but the token endpoint answers `400 unsupported_grant_type`
for it, so **a handle returned by the code exchange cannot be redeemed yet**; and the **CDK `facade` wiring** — still no
`cdk/**` change, so the construct's attach prop does not wire the provider and stores or the callback-path override.

The store `put` normalization was also aligned across Go, TypeScript, and Python: the reference stores now preserve a
caller-supplied `status` verbatim and normalize a version below 1 to 1 in all three runtimes (Go was already the
reference), pinned by a new shared `put_payload` conformance scenario.

See `docs/features/mcp-auth-facade-spi.md` for the front-channel configuration table and
`docs/features/mcp-facade-helper.md` for what the three registrars mount.

## v5.x line

AppTheory v5 is a major release on two axes: the Go module path moves to the next semantic import version, and the Go
data-layer dependency moves to TableTheory v4. Go consumers must migrate both together.

### Go module import paths

AppTheory v5 moves the Go runtime and the generated CDK Go bindings onto the next semantic import version. Replace the
`/v4` suffix on every AppTheory runtime import with the canonical `github.com/theory-cloud/apptheory/v5` path, pin the
v5 module tag, and run `go mod tidy`:

```bash
go get github.com/theory-cloud/apptheory/v5@v5.0.0-rc
```

Update the generated CDK Go bindings in the same release transaction: replace
`github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v4` with
`github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v5`, pin the matching v5 CDK module tag, and run `go mod tidy` in
the CDK application's module. Runtime and CDK module tags continue to target the same immutable release commit; do not
mix major lines or substitute registry-published artifacts.

The v5.0.0-rc tag is the first v5 release; pin the exact v5 release or RC tag you are moving to. Do not retain both
AppTheory major paths in one application: packages from `/v4` and `/v5` have distinct Go type identities even where
their APIs are otherwise unchanged.

### TableTheory v5 dependency floor

The v5 line requires TableTheory v5.0.0 in all three runtimes. TableTheory's Go module path moves with the major to
`github.com/theory-cloud/tabletheory/v5`, so Go consumers must replace every TableTheory `/v4` import with `/v5` and
require `github.com/theory-cloud/tabletheory/v5`. Because `/v4` and `/v5` TableTheory packages are distinct Go types,
these **7 exported AppTheory constructors** now take a TableTheory v5 `tablecore.DB` and no longer accept a TableTheory
v4 client:

| Constructor | Package |
| --- | --- |
| `NewDynamoJobLedger(db tablecore.DB, config *Config) *DynamoJobLedger` | `pkg/jobs` |
| `NewDynamoRateLimiter(db tablecore.DB, config *Config, strategy RateLimitStrategy) *DynamoRateLimiter` | `pkg/limited` |
| `NewDynamoDBEventBus(db tablecore.DB, config EventBusConfig) *DynamoDBEventBus` | `pkg/services` |
| `NewDynamoSessionStore(db tablecore.DB) SessionStore` | `runtime/mcp` |
| `NewDynamoStreamStore(db tablecore.DB) StreamStore` | `runtime/mcp` |
| `NewDynamoTaskStore(db tablecore.DB) TaskStore` | `runtime/mcp` |
| `NewTableTheorySessionRegistry(db tablecore.DB) (*TableTheorySessionRegistry, error)` | `runtime/microvm` |

Before the v5 upgrade, Go consumers of those constructors must `go get github.com/theory-cloud/tabletheory/v5@v5.0.0`
and pass a TableTheory v5 client. Do not keep both TableTheory major paths in one application — their otherwise
similar interfaces are distinct Go types.

TableTheory v5 changes one TypeScript type declaration and no Go or Python API. On the default `TheorydbClient`
(`numberUnmarshalMode: 'string'`), typed items now declare a DynamoDB `N` attribute as `string` and `NS` as
`string[]`; both were declared as `number` and `number[]` before. Runtime behavior is unchanged, so the break is
compile-time only: a TypeScript consumer that reads numeric attributes through the typed item surface must either
handle the canonical decimal strings, which the documented default always produced, or construct the client in
explicit `'number'` mode where a number is genuinely intended. AppTheory converts numeric attributes at the call site
and does not read through the typed item surface, so it needs no adapter.

The AppTheory TypeScript and Python release metadata continues to install TableTheory only from immutable GitHub
Release assets. The v5 dependency assets pinned by this line are:

- TypeScript: `theory-cloud-tabletheory-ts-5.0.0.tgz`, verified with SHA-512
  `17WgG31fbj2URjvPTBJDJW0EOzkBXZixLdgWCYyekmfRxc2zzDYMPpa6Gkt90TJUzDVmFxFKCg6Jt4YCWj2y3g==`.
- Python: `tabletheory_py-5.0.0-py3-none-any.whl`, verified with SHA-256
  `b1105db11f8dfd06b2fd615f9e92f0e420080940878feccd07dcdb9f9168d65a`.

Use those pinned assets through AppTheory's package metadata; do not substitute registry-published packages or
mutable URLs.

Consumers crossing from an AppTheory v4 line, which pinned TableTheory v3, additionally inherit the TableTheory v4
changes. TableTheory v4 removes the ticker-driven memory monitor: `MemoryMonitor.Start` / `Stop`,
`ResourceProtector.StartMemoryMonitoring` / `StopMemoryMonitoring`, and `ResourceLimits.MemoryCheckInterval` are
gone, replaced by on-demand `MemoryMonitor.Sample`, `ResourceProtector.SampleMemory`, and
`ResourceProtector.SetMemoryAlertCallback`. A caller samples inside the request whose memory it records, so nothing
a sample starts can outlive the invocation. AppTheory does not use the removed API. TableTheory v4 also returns
`ErrInvalidOperator` from `ConsistentRead()` on GSI queries instead of silently dropping the flag, and converges
`[]byte`/set-tagged DynamoDB write shapes on the cross-runtime DMS matrix; AppTheory's TableTheory queries use
base-table key conditions, so the GSI change does not apply and no persisted-shape migration is required.

### MCP transport routes require credentials by default

This is a deliberate, declared security contract change. `AppTheoryMcpServer` MCP transport routes (`POST`, `GET`, and
`DELETE` on every MCP pattern) never default to a credential-free route; the construct resolves one `transportPosture`
selection and attaches the matching authorizer, so a credential-free request is rejected before the runtime handler
runs.

| `transportPosture` | Transport-route authorizer | Validator |
| --- | --- | --- |
| `iam` (the default for a plain transport server) | AWS IAM | application |
| `jwt` | static JWT authorizer (`transportAuthorizer` issuer + audience) | application |
| `runtime-bearer` (the default once the server attaches `facade`) | `NONE` | mandatory RFC 9728 bearer validation |
| `none-public` | `NONE` | none (deliberately public) |

The default is resolved from the construct's shape, not asked of the caller. An `AppTheoryMcpServer` that attaches the
`facade` property — declaring that it fronts an auth provider on one domain — resolves to `runtime-bearer`; a plain
transport server with no `facade` attachment keeps the `iam` default. Setting `transportPosture` explicitly overrides
the default.

`unauthenticatedMcp` is **removed** with no alias and no shim, and `AppTheoryMcpTransportAuthorizerKind` is removed
with it. `transportAuthorizer` is now only the static JWT configuration for
`transportPosture: AppTheoryMcpTransportPosture.JWT`, which requires an issuer and a non-empty audience; supplying it
under any other posture fails synthesis.

The OAuth surface is derived by route algebra `m17.mcp-route-algebra/v2`: RFC 9728 protected-resource metadata,
canonical and suffix RFC 8414 discovery, and the authorize/token routes per MCP pattern, plus the derived `/register`
path (canonical discovery path + `/register`) per pattern and one **stage-global** upstream callback route
(`/_oauth/mcp/callback` by default, overridable through `FacadeConfig.UpstreamCallbackPath` /
`routeFamily`-agnostic CDK derivation). Every OAuth-surface route is explicitly public (`NONE`) — OAuth clients must
fetch those documents before they hold a token — and the whole surface registers only when the posture is not
`none-public`: a `none-public` server registers no OAuth surface at all, so the runtime surface and the construct's
`authorizationRoutesAttached` inventory cannot disagree.

`none-public` is the explicit replacement for the removed `unauthenticatedMcp: true` opt-out. It is never a default,
and because the transport authorizer is `NONE` it now carries the defense-in-depth floor: `originReachability` must be
`disabled` or `locked` (a directly reachable origin is refused), and the throttling and access-logging decisions must be
explicit. In owned-API mode the explicit throttling decision is `ownedApi.stage.throttlingEnabled: true`; in attach mode
it is an `owningApiDefense` record of the owning API's access logging and throttle settings. Selecting `runtime-bearer`
additionally requires an explicit `runtimePosture: { requireBearerToken: true }` declaration and a `denialSignal` (the
denial metric is `apptheory.mcp.auth_denied`, dimensioned on the bounded outcome and route family only). Each missing
requirement fails synthesis rather than degrading to a credential-free route.

CDK before / after:

```ts
// Before: every route was public and the runtime owned bearer validation.
new AppTheoryMcpServer(this, "McpServer", { handler });

// After (recommended): attach the facade; it selects the runtime-bearer default.
new AppTheoryMcpServer(this, "McpServer", {
  handler,
  facade: { providerId: "autheory" },
  runtimePosture: { requireBearerToken: true },
  originReachability: AppTheoryMcpOriginReachability.LOCKED,
  denialSignal: { metricName: "apptheory.mcp.auth_denied" },
  ownedApi: { stage: { throttlingEnabled: true } },
});

// After (explicit JWT): a static issuer and audience at the gateway.
new AppTheoryMcpServer(this, "McpServer", {
  handler,
  transportPosture: AppTheoryMcpTransportPosture.JWT,
  transportAuthorizer: {
    issuer: "https://accounts.example.com",
    audience: ["https://mcp.example.com"],
  },
});

// After (explicit public): the deliberate, never-default opt-out.
new AppTheoryMcpServer(this, "McpServer", {
  handler,
  transportPosture: AppTheoryMcpTransportPosture.NONE_PUBLIC,
  originReachability: AppTheoryMcpOriginReachability.DISABLED,
  ownedApi: { stage: { throttlingEnabled: true } },
});
```

On the Go side, `mcpfacade.RegisterMCPFacade` registers the MCP transport routes with an authenticated posture by
default, and a request without a verified principal is rejected with HTTP `401` before the MCP handler runs. The
removed `FacadeConfig.UnauthenticatedMcp` field is replaced by `FacadeConfig.TransportPosture`
(`mcpfacade.TransportPostureIAM` | `...JWT` | `...RuntimeBearer` | `...NonePublic`). `FacadeConfig.RequireBearerToken`
is now valid **only** with `TransportPostureRuntimeBearer`: registration fails closed when the bearer validator is
missing under `runtime-bearer`, and when it is supplied under `iam`, `jwt`, or `none-public`. TypeScript and Python gain
the matching `registerMcpFacade` / `register_mcp_facade` registrars, which enforce the same posture/validator pairing.

Go before / after:

```go
// Before: transport routes inherited whatever the application did.
_, err := mcpfacade.RegisterMCPFacade(app, mcpfacade.FacadeConfig{
    IssuerURL:    issuer,
    JWKSURI:      jwksURI,
    URLMode:      mcpfacade.URLModePublicBaseURL,
    PublicBaseURL: baseURL,
    Scopes:       scopes,
    MCPHandler:   mcpHandler,
})

// After (recommended): validate RFC 9728 bearer tokens on the transport routes.
_, err = mcpfacade.RegisterMCPFacade(app, mcpfacade.FacadeConfig{
    IssuerURL:          issuer,
    JWKSURI:            jwksURI,
    URLMode:            mcpfacade.URLModePublicBaseURL,
    PublicBaseURL:      baseURL,
    Scopes:             scopes,
    MCPHandler:         mcpHandler,
    TransportPosture:   mcpfacade.TransportPostureRuntimeBearer,
    RequireBearerToken: &oauth.RequireBearerTokenOptions{Validator: myValidator},
})

// After (explicit public): register the transport routes without authentication.
config := mcpfacade.FacadeConfig{ /* as before */ }
config.TransportPosture = mcpfacade.TransportPostureNonePublic
_, err = mcpfacade.RegisterMCPFacade(app, config)
```

The default runtime tier enforces the route-level authenticated posture. The explicit `apptheory.TierP0` preflight fast
path does not evaluate route-level auth; applications on that tier must rely on the API Gateway authorizer or wrap the
MCP handler themselves. Applications that already wrap the handler or configure
`apptheory.WithAuthPrincipalHook` are unaffected: the default posture delegates to that principal hook. Wrapping the
MCP handler without also configuring a principal hook does not exempt an application — route authorization runs before
middleware and the handler, so every MCP transport request is still rejected with HTTP `401`.

### MCP route algebra v2, route-aware bearer validation, and the RFC 9728/8707 challenge

Route algebra `m17.mcp-route-algebra/v2` is now implemented in Go (`runtime/mcproutes`), TypeScript
(`ts/src/mcproutes.ts`), Python (`apptheory.mcproutes`), and the jsii CDK construct, all driven by one shared
expectation table. Beyond the v1 derivations it adds the derived `/register` path per MCP pattern, one stage-global
upstream callback route, and the `IssuerMode` vocabulary (`family` | `route`).

`FacadeConfig.IssuerMode = mcpfacade.IssuerModeRoute` (and the equivalent per-language option) makes each route its own
authorization server: the routed RFC 9728 and RFC 8414 documents advertise the **route URL** as `resource`,
`authorization_servers`, and `issuer`, and the discovered `registration_endpoint` is the route's own derived
`/register` path. `jwks_uri` stays the upstream JWKS, because the upstream signs the access tokens the route hands to
clients. `family` mode keeps the previous single-issuer behavior.

The bearer validator is now **route-aware**: the Go validator types receive the AppTheory request context, and all three
runtimes accept route-derived audience, scope, and challenge metadata resolvers, so the audience can be the exact
matched route URL. The challenge's `resource_metadata` is built from the matched route whenever a route-derived
resolver is configured; the bearer middleware otherwise falls back to the explicit `ResourceMetadataURL` option and,
last, to the `MCP_ENDPOINT` environment variable that the CDK construct injects in owned mode. It is never derived from
the request's `Host` or forwarded headers.

AppTheory ships its first JWT/JWKS access-token validator in all three runtimes. It pins `RS256` (the `alg: none` and
`HS*` algorithm-confusion families are refused), requires a bounded `kid` cache with one cooldown-limited refresh per
unknown kid **under a global unknown-kid fetch budget** (32 key-set fetches per 60-second window by default) and an
expiry-driven rotation refresh, caps `kid` strings at 256 characters, and keeps the `kid`-window map and the key cache
bounded and evicting (1024 windows / 128 keys). Every discovery and JWKS fetch is bounded end to end — the response
headers and its body alike — by a 10-second framework timeout, so a hung, stalled, or trickling upstream cannot stall
validation, and a refresh never holds the key lock across the network. It checks the issuer before and after signature
verification, enforces the route-derived audience/scope and an `azp`/`client_id` allow-list — an absent `azp` falls back
to `client_id`, while a present but blank `azp` is refused rather than falling back, identically in all three runtimes —
and bootstraps OIDC discovery over HTTPS only, verifying the discovery issuer before trusting `jwks_uri` and refusing
cross-origin redirects. Every failure path fails closed. The timeout and the budgets are framework defaults with a
documented per-validator override (Go `FetchTimeout` / `MaxUnknownKidFetches` / `UnknownKidFetchWindow`, TypeScript
`fetchTimeoutSeconds` / `maxUnknownKidFetches` / `unknownKidFetchWindowSeconds`, Python `http_timeout_seconds` /
`max_unknown_kid_fetches` / `unknown_kid_fetch_window_seconds`).

The framework's own JWKS/discovery transport refuses to connect to an endpoint host that is not a public address —
loopback, link-local (including the cloud metadata address `169.254.169.254`), private, unspecified, or multicast —
both for literal IPs and for the addresses a name resolves to at connect time, so there is no DNS-rebinding window
between the check and the connection. Local development and the repository's loopback test suites opt in through the
documented `AllowPrivateHosts` (Go) / `allowPrivateHosts` (TypeScript) / `allow_private_hosts` (Python) override; it is
off by default and is never enabled by the framework itself. The standalone discovery bootstrap helpers
(`BootstrapOIDCDiscovery`, `bootstrapOidcDiscovery`, `bootstrap_oidc_discovery`) take the transport as an injected
client/fetch/`http_get`, so the same override reaches them: a caller-supplied transport keeps its own connection policy,
and each helper installs the guard only when the framework chooses the transport itself.

Denials now carry the route-derived challenge. A missing, malformed, invalid, or expired token returns `401` with
`WWW-Authenticate: Bearer resource_metadata="<matched route's protected-resource metadata URL>"`. A scope failure
returns `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<remediation scopes>",
resource_metadata="<…>"` and body `{"error":{"code":"app.insufficient_scope"}}`; an audience failure and every other
forbidden denial still return the plain `403` with no error code or scope set. RFC 8707 `resource` is canonicalized and
must exactly equal the route resource (the resulting `aud` must equal the route URL).

### MCP auth facade provider and store SPIs

The facade's provider SPI and store SPIs now exist in all three runtimes, together with their normal parts. **Nothing
is mounted and no action is required yet:** the packages are inert, no facade route is registered, and `FacadeConfig`
does not consume them until the facade mechanics land.

- The **provider SPI** (discovery, authorization-URL construction, code exchange, refresh, token validation through the
  shipped JWKS/RS256 validator) ships with the **Autheory adapter** as the first implementation, a second tiny test
  adapter proving provider-neutrality, and typed errors mapped to a closed client-facing vocabulary. Every upstream call
  goes through the same bounded, SSRF-guarded, size-capped HTTP path the discovery and JWKS bootstraps use.
- The **store SPIs** — `TransactionStore`, `AuthorizationCodeStore`, `ClientStore`, `RouteRefreshBrokerStore`,
  `RateLimitStore` — ship with in-memory reference implementations and an injectable clock. Consume-once and
  compare-and-swap are required atomic operations. **Production needs a durable store; the framework does not ship
  one** — durable implementations are application-owned, and **no upstream material may be persisted unencrypted**.
- Two shared conformance tables (`facade-provider-conformance.v1.json`, `facade-store-conformance.v1.json`) drive the
  provider adapter and any store, and a fake upstream provider (real RSA keys, real local HTTP) ships in test support.

See `docs/features/mcp-auth-facade-spi.md` for the interface reference and the framework-versus-application split.

Not yet in this line: the facade mechanics themselves — front-channel termination, the upstream callback handler, the
DCR handler, the code/refresh wiring, and the brokered refresh — and the edge `WWW-Authenticate` restoration construct
plus the challenge alias bridge. The derived `/register` and callback **routes** exist and are mountable; their
handlers remain application-owned until the mechanics land.

## v4.x line

### Go module import paths

AppTheory v4 moves the Go runtime and the generated CDK Go bindings onto the next semantic import version. Replace the
`/v3` suffix on every AppTheory runtime import with the canonical `github.com/theory-cloud/apptheory/v4` path, pin the
v4 module tag, and run `go mod tidy`:

```bash
go get github.com/theory-cloud/apptheory/v4@v4.0.0-rc
```

Update the generated CDK Go bindings in the same release transaction: replace
`github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v3` with `github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v4`,
pin the matching v4 module tag, and run `go mod tidy` in the CDK application's module. Runtime and CDK module tags
continue to target the same immutable release commit; do not mix major lines or substitute registry-published
artifacts.

The v4.0.0-rc tag is the first v4 release; pin the exact v4 release or RC tag you are moving to. Within the /v3→/v4
module migration itself, the Go API surface is unchanged beyond import paths: the api-snapshot diff between v3.3.0 and
the v4 line is header-path-only. Do not retain both AppTheory major paths in one application: packages from `/v3` and
`/v4` have distinct Go type identities even where their APIs are otherwise unchanged.

### Breaking runtime behavior changes

The v4 line is a major release for more than its import paths: the v3.3.0→v4 range also ships Go-runtime-observable
breaking wire changes from the [#956](https://github.com/theory-cloud/AppTheory/pull/956) and
[#957](https://github.com/theory-cloud/AppTheory/pull/957) trains:

- Streaming responses on the HTTP API v2 and buffered Function URL adapters are no longer silently dropped. A
  terminating stream is drained into the buffered body within a bounded budget (4 MiB / 5 s), and a stream that does
  not terminate in time fails closed with the documented HTTP 500 JSON error instead of reaching clients as a 200
  with an empty body and immediate EOF.
- A streamed-body drain byte overrun maps to HTTP 413 payload too large with the `app.too_large` error shape, matching
  the buffered-body size semantics, instead of the generic 500 fail-closed shape. The 500 shape is retained only for
  non-size drain failures such as non-termination and stream errors.
- A response carrying both a non-empty buffered body and a streaming body is rejected and fails closed, because
  different adapters previously picked different representations and produced divergent wire bytes for the same
  response.
- MCP method-not-allowed responses now carry the RFC 9110 `Allow` header: `Allow: POST` on the stateless shape,
  `Allow: DELETE, GET, POST` on the session-ful transport.
- Panicking event callbacks on the SQS, Kinesis, and SNS adapters are recovered into the established event-workload
  failure shape instead of crashing the invocation; a panicking SQS/Kinesis record no longer aborts the whole batch.

These are wire-contract changes, not source-level API changes: after the import-path migration, Go code that compiles
on v3 compiles on v4, but the wire behavior an application observes can differ. See `CHANGELOG.md` and the v4 release
notes for the complete commit-level detail in this range.

### Invocation-scoped work

AppTheory no longer starts work that outlives the Lambda invocation that started it. Handlers and middleware may still
run work concurrently inside one invocation, but the runtime joins it before returning, because the Lambda execution
environment is frozen once the handler returns: detached work resumes at an unpredictable time on a later invocation of
the same environment (or never), and can half-apply writes, lose results, or hold state that belongs to an ended
invocation.

Action required depends on what your application relies on today:

There are **no documented residuals and no grace windows**: every launch the runtime starts is joined before the
adapter or middleware that owns it returns, or it does not exist. Where an earlier draft of this entry described a
bounded grace window that ended in abandoning work, that behavior is gone.

- **Task-augmented `tools/call`.** The tool body runs to completion inside the `tools/call` invocation and the
  `CreateTaskResult` it returns carries a task that is already terminal; it is no longer returned as `working` while a
  detached goroutine, thread, or promise runs the body. `tasks/get`, `tasks/result`, `tasks/list`, and `tasks/cancel`
  behave as before, and a client that only polls is unaffected. Two consequences are worth planning for:
  - the `tools/call` response now blocks for the duration of the tool body, bounded by your Lambda timeout (previously
    it returned immediately);
  - the terminal state is the tool body's own outcome, identical in Go, TypeScript, and Python: `completed`, or
    `failed` when the body returns an error — including an error caused by the invocation ending (client disconnect,
    request cancellation, deadline). `canceled` is the client-requested state, recorded by `tasks/cancel`; a body that
    errors after a client cancel still reports `canceled`, because the stored terminal state is authoritative. Go
    previously recorded `canceled` for a request-context cancellation that `tasks/cancel` had not requested; that
    cross-runtime divergence is gone (see ADV-1070-R0-04). A **hard Lambda function timeout is not observable
    in-process**: the execution environment is frozen, so nothing is recorded and the task stays `working` until its
    TTL expires (see ADV-1070-R0-03). If your product needs work to survive a disconnect, own that hand-off: queue the
    work and run it in an invocation triggered by a consumer, instead of relying on detached execution. In-process
    `tasks/cancel` still cancels an in-flight body reached by a concurrent connection.
- **Streamed `tools/call` and SSE responses.** The tool body and the SSE relay are joined to the response body. A
  response-streaming adapter still delivers progress incrementally, and a disconnect still does not cancel the tool body,
  so a client can resume with `Last-Event-ID`; an adapter that stops reading the body now waits for the tool body to
  finish instead of returning while it runs.
- **Every buffered adapter.** HTTP API v2, the Lambda Function URL, the **ALB target group**, and the **buffered API
  Gateway REST v1** shape now deliver a streaming body through the same bounded drain, close and join. ALB and the
  buffered v1 conversion previously dropped a streaming body entirely (returning a response while its producer could
  still run); they now drain it into the buffered body, fail closed with a message naming the adapter when it cannot be
  delivered (`"...cannot be delivered by the ALB target group adapter"`, `"...by the API Gateway REST v1 adapter"`), and
  map a byte-budget overrun to HTTP 413 as the other adapters do. When the drain time budget expires the adapter closes
  the body and waits for the read it gave up on before failing closed — unconditionally.
- **The response-streaming adapter.** The API Gateway REST v1 response-streaming route now delivers a
  handler-supplied `Response.BodyStream` as well. A `BodyStream` is a channel, so it is converted through `streamjoin`
  under the invocation's serve context before it is handed to the transport: the resulting body reports EOF only after
  the stream's producer has exited, and closing it on a client disconnect cancels the serve context and joins the
  producer the response-size limiter started. The route previously dropped a `BodyStream` and returned an empty 200
  while the limiter's producer was still running. The Lambda Function URL streaming handler also unwinds the body's
  async iterator when the first transport write fails, so a producer is never left suspended. Python delivers buffered
  only, and the TypeScript buffered adapters already drain and join.
- **Bodies the adapter cannot interrupt.** A handler-supplied body that is neither closable nor terminating cannot be
  interrupted by construction. It is read on the invoking goroutine, or waited for unconditionally, so the Lambda
  function timeout bounds it; the adapter no longer walks away from it after a grace window. Every body the runtime
  itself produces (an SSE body, a streamjoin body, a limited body, a composed reader) is closable, and closing it
  forwards to its producer and joins it.
- **What a handler-supplied streaming body must do.** A `Response.BodyStream` (Go), `bodyStream` (TypeScript) or
  `body_stream` (Python) producer must release the body when the invocation context ends: close the channel (Go), let
  the async iterable unwind through `return()`/`destroy()` (TypeScript), or implement `close()` (Python). The adapter
  gives up on a body that does not terminate within its drain budget, closes it and then **waits for it
  unconditionally**, so a body that cannot be released holds the invocation until the Lambda function timeout instead
  of being abandoned after a grace window. The shared contract fixtures (`sse_stream_live`) now use an interruptible
  live producer — a handler that closes its stream with the invocation — so they pin both the documented fail-closed
  500 and the join that follows it. The runtime's own producers already comply: every runtime-produced stream observes
  the invocation context (Go's limiter pump, the SSE bodies, the MCP stream scope) or closes on the transport's close
  (TypeScript's generators, Python's `close()` forwarding).
- **Timeout middleware (all three runtimes).** It runs the handler chain **on the invoking goroutine/thread/task** with
  a deadline-bearing context or cancellation token, and reports `app.timeout` once the chain returns if the deadline
  passed. It starts no second execution context, so there is nothing to abandon and no grace window. A handler that
  ignores the token runs to completion and is bounded by the Lambda function timeout; its response is no longer
  produced by a middleware that gave up on it. The Python timeout test that pinned the previous abandonment behavior
  now pins this one.
- **Observability log notifications (`pkg/observability/zap`).** The process-lifetime notifier goroutine and its entry
  queue are gone. An error notification is delivered synchronously inside the call that logs, bounded by the configured
  retry policy (`MaxRetries` attempts with `RetryDelay` between them); a notifier that ignores its context is bounded by
  the Lambda function timeout. `LoggerConfig.BufferSize` is accepted for compatibility and no longer sizes anything;
  `EntriesDropped` now counts only notifications that could not be delivered because the logger was closed. The
  TypeScript and Python observability surfaces have no equivalent background notifier, so they are unchanged.

These are behavior changes, not source-level API changes: no exported signature changed, and applications that poll
tasks, read SSE streams, or rely on the documented budgets keep working. The TypeScript and Python packages carry the
same behavior, and no new configuration is required in any runtime.

### CDK Node.js floor

The v4.x CDK construct library declares `engines.node` `>=22` instead of `>=20`, and CI builds the package and
regenerates its jsii Go bindings on Node.js 22 and 24. The floor follows the dependency graph the CDK package actually
installs: jsii-rosetta 6.0.16 resolves stream-json 3.7.0, which resolves stream-chain, and stream-chain has declared
`engines.node` `>=22` since 4.2.3. Node.js 20 reached end of life in April 2026.

Consuming CDK applications must run Node.js 22 or newer to install, synthesize, and deploy against this line.

### TypeScript runtime Node.js floor

The runtime package (`ts/`) also declares `engines.node` `>=22` instead of `>=20`. The pinned
`@theory-cloud/tabletheory-ts` release requires Node.js 22, and `scripts/verify-runtime-floor-claims.sh` fails closed
while a package's declared floor sits below the floor its pinned TableTheory release requires, so the runtime package
follows the CDK construct library onto the same floor. Consuming runtime applications must run Node.js 22 or newer.

### CDK construct fail-closed defaults

Several CDK construct defaults changed to fail closed. Each is a breaking default change: an existing stack that did
not set the relevant prop synthesizes a different template after the upgrade.

- `AppTheoryHttpApi` disables the default `execute-api` endpoint whenever `domain.mutualTlsAuthentication` is set, so a
  mutual-TLS custom domain is the only way in. Non-mTLS custom domains and APIs without a domain keep the endpoint
  enabled.
- `AppTheoryFunction` and `AppTheoryApp` default their AppTheory-created function log groups to `RemovalPolicy.RETAIN`
  instead of `RemovalPolicy.DESTROY`, so deleting a stack now preserves the execution logs. Set
  `logRemovalPolicy: RemovalPolicy.DESTROY` to opt back into deleting them with the stack.
- `AppTheoryS3VersionedIngress` rejects unresolved CDK token locations in `grantUpload`/`grantVersionedRead` instead of
  passing them through, so every grant stays an exact, wildcard-free object key. Pass literal `namespaceSlug` and
  `bundleId` values.
- `AppTheoryVectorIndex.grantBedrockInvokeModel` scopes its default `bedrock:InvokeModel` resource ARN to the configured
  Titan embedding model in the stack's partition and region instead of `"*"`. Pass `modelResourceArn` explicitly
  (including `"*"`) to set a different scope.

The generated Go and Python `apptheory-init` scaffold templates also stop shell-interpolating local build paths: they
run `go build` and `python3 -m pip install` through an argv array, so a project path containing shell metacharacters is
passed through literally.

### HTTP API v2 route permission scope

`AppTheoryMcpServer`, `AppTheoryHttpApi`, `AppTheoryHttpIngestionEndpoint`, `AppTheoryMicrovmController`, and
`AppTheoryApp` gain an optional `scopePermissionToRoute` prop that defaults to `true`, so existing deployments
synthesize exactly the same templates as before and no action is required.

Set `scopePermissionToRoute: false` when one Lambda backs many HTTP API v2 routes and the per-route
`AWS::Lambda::Permission` entries approach the 20 KB Lambda resource-policy limit. The construct then grants one
API-scoped permission per Lambda instead of one permission per route, which lets every route on that API invoke the
handler — not only the routes the construct owns. Prefer `AppTheoryRestApi` / `AppTheoryRestApiRouter` and their
existing `scopePermissionToMethod` prop for REST API v1 route bundles; this is the HTTP API v2 counterpart of that
prop and mirrors it in name, default, and semantics.

### Stream mapping on-failure destinations

`AppTheoryDynamoDBStreamMapping` and `AppTheoryKinesisStreamMapping` gain an optional `onFailure` destination for the
records AWS Lambda discards after retries are exhausted or `maxRecordAge` is exceeded. When `onFailure` is omitted the
constructs emit no `DestinationConfig` and grant no destination permission, so existing deployments synthesize exactly
the same templates as before and no action is required.

Pass an event source DLQ the same way the CDK event sources do: `new lambdaEventSources.SqsDlq(queue)`,
`new lambdaEventSources.SnsDlq(topic)`, or `new lambdaEventSources.S3OnFailureDestination(bucket)`. Binding the DLQ adds
exactly the permission the destination needs to the consumer execution role — `sqs:SendMessage` (with the read-only
`sqs:GetQueueAttributes` and `sqs:GetQueueUrl` actions CDK pairs with it) for a queue, `sns:Publish` for a topic.

Lambda only sends to the destination once retries are exhausted or the record ages out, so a mapping that leaves
`retryAttempts` and `maxRecordAge` unbounded (the AWS Lambda default of `-1`, retry until the record expires in the
stream) never sends anything. Pair `onFailure` with a bounded `retryAttempts` and `bisectBatchOnError: true` so a poison
record is retained for repair instead of blocking its shard. `reportBatchItemFailures` is independent of the destination
and remains on by default.

An SQS or SNS destination carries metadata about the discarded batch — the shard ID and the start and end sequence
numbers — not the record payloads, so original records must be re-read from the stream while they are still inside the
stream retention window. An S3 destination instead receives the full records, including their payloads. With
`bisectBatchOnError` enabled, the metadata's `BatchSize` can exceed 1 because Lambda consolidates the failed messages it
writes to the destination.

## v3.x line

### Toolchain and CDK dependency floors

The v3.x runtime requires Go 1.26.6 or newer, as declared by the root `go.mod`. Upgrade local toolchains and CI images
before moving a Go application onto this line.

The v3.x CDK package pins its `aws-cdk-lib` peer dependency exactly to 2.265.0 rather than accepting a version range.
Align the consuming CDK application's `aws-cdk-lib` dependency to 2.265.0 before installing the matching AppTheory CDK
GitHub Release asset; mixing CDK versions is outside the supported jsii surface.

### Go module paths

AppTheory v3 uses Go semantic import versioning. Replace the `/v2` suffix on every AppTheory runtime import with the
canonical `github.com/theory-cloud/apptheory/v3` path, update the root module requirement to the pinned v3 release tag,
and run `go mod tidy`. Do not retain both AppTheory major paths in one
application: packages from `/v2` and `/v3` have distinct Go type identities even where their APIs are otherwise
unchanged.

The generated CDK Go bindings move in the same release transaction. Replace the bindings' `/v2` suffix with
`github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v3`, pin the matching `v3.x` tag, and run `go mod tidy` in the
CDK application's module. Runtime and CDK module tags continue to target the same immutable release commit; do not mix
major lines or substitute registry-published artifacts.

### Function log group removal policies

Starting in v3.1.0, function log groups created by `AppTheoryFunction` and `AppTheoryApp` default to
`RemovalPolicy.DESTROY` instead of the inherited CDK `RemovalPolicy.RETAIN` default. The first `cdk deploy` after
upgrading changes those AppTheory-managed resources to delete on stack deletion or replacement. Applications that must
retain their function logs must set `logRemovalPolicy: RemovalPolicy.RETAIN` explicitly.

AppTheory also fails synthesis when `logGroup` and `logRemovalPolicy` are passed together. Earlier releases silently
ignored `logRemovalPolicy` in that configuration. Existing callers that pass both must choose one ownership path:
either omit `logGroup` and configure the AppTheory-managed group with `logRemovalPolicy`, or pass a caller-managed
`logGroup`, omit `logRemovalPolicy`, and configure the removal policy where that group is created.

The CDK TypeScript library, jsii metadata, and generated Go bindings must come from the same pinned AppTheory GitHub
Release so this validation and default stay aligned; do not mix `cdk/lib`, `.jsii`, or `cdk-go` artifacts across
versions.

### MCP server facade redesign and A6 deprecation

The next v3 minor redesigns `AppTheoryMcpServer` around the route-algebra facade. The default changes intentionally:

- the default route family is the four canonical parameterized MCP patterns rather than singleton `POST /mcp`;
- `POST`, `GET`, and `DELETE` MCP transport plus protected-resource, canonical/suffix discovery, authorize, and token
  routes are wired by default;
- the session table defaults on with retain semantics, and owned APIs default access logging and throttling on;
- omitting issuer/JWKS no longer means unauthenticated MCP; the deliberate no-facade opt-out is the explicit public
  transport posture (`transportPosture: AppTheoryMcpTransportPosture.NONE_PUBLIC`) with the defense-in-depth floor. The
  intermediate `unauthenticatedMcp` opt-out is removed with no alias —
  see [MCP transport routes require credentials by default](#mcp-transport-routes-require-credentials-by-default);
- issuer/JWKS are no longer injected into `APPTHEORY_MCP_*` environment variables. Configure the explicit Go
  `mcpfacade.FacadeConfig`, including per-kind scopes and application-owned authorize/token handlers.

Attach mode is now primary. Pass `api: IHttpApi` to add the complete family to a shared HTTP API without creating an
`AWS::ApiGatewayV2::Api`. The supplied API owns its stage, access logs, throttling, domain, CDN, and public authority;
therefore `ownedApi` and the deprecated `apiName`, `domain`, and `stage` props fail synthesis in attach mode. Omit `api`
for the standalone specialization and configure those resources under `ownedApi`.

Every v3.1.x A6 prop except `handler` is deprecated in place: move `mcpPath` to `routeFamily.patterns`, `apiName` /
`domain` / `stage` under `ownedApi`, and `enableSessionTable` / `sessionTableName` / `sessionTtlMinutes` under
`sessionState`. Move `authorizationServerIssuer` and `jwksUri` into `FacadeConfig.IssuerURL` and `.JWKSURI`. The
`endpoint`, `mcpPath`, and `protectedResourceMetadataPath` accessors are deprecated in favor of their ordered plural
forms and `routeInventory`. The `api` accessor remains but is generalized to `IHttpApi`.

`MCP_SESSION_TABLE` and `MCP_SESSION_TTL_MINUTES` remain construct-managed when session state is enabled.
`MCP_ENDPOINT` is written only in owned mode, where the construct knows the public endpoint it owns. Attach-mode
applications behind a front door or CDN must configure the correct request-specific bearer challenge in app-owned
runtime configuration; the construct does not accept an origin prop. Review the complete migration table in
[the MCP server facade guide](docs/features/mcp-server-construct.md) before upgrading.

`AppTheoryMcpProtectedResource` remains supported only for existing synth-time-static REST API documents. Its
URL-valued `resource` and `authorizationServers` props stay deprecated; it is not a parallel namespace deployment
path.

### Governed namespace install parameters

Starting in v3.1.0, namespace stacks should instantiate `AppTheoryInstallParameters` and pass its typed tokens to
consuming constructs. The construct emits the ten required governed CloudFormation parameters and the
`TargetAccountMatchesCaller` rule without embedding account-, tenant-, stage-, or DNS-specific identity in the
template. Deployment runners must inject every parameter because none has a default.

Parameter patterns and allowed values are evaluated by CloudFormation, not at synthesis. The governed install-profile
validator must continue enforcing `DnsHost == cloud-keeper.<NamespaceSlug>.theorycloud.app`: CloudFormation Rules
cannot express that relationship with `Fn::Join`, although the parameter pattern still enforces the
`theorycloud.app` suffix. Consume matching TypeScript/jsii and `cdk-go` artifacts from one immutable AppTheory GitHub
Release so the parameter and accessor surfaces stay aligned.

### Versioned namespace artifact ingress

Starting in v3.1.0, operator-owned platform stacks can use `AppTheoryS3VersionedIngress` for the namespace release
bucket. The construct fixes versioning, all four public-access-block settings, S3-managed encryption, TLS-only access,
bucket-owner-enforced ownership, retain semantics, and an enabled lifecycle rule that aborts incomplete multipart
uploads after 7 days. It intentionally defines no object expiration or noncurrent-version deletion because the
namespace artifact contract does not authorize deletion of pinned versions.

Use `grantUpload` for exact-key `s3:PutObject` and `grantVersionedRead` for exact-key `s3:GetObjectVersion`. Both helpers
address `ns/<namespaceSlug>/<bundleId>` and reject invalid literals at synthesis. Token-valued slug and bundle inputs
remain supported for account-agnostic templates. CloudFormation resolves them at deployment, and AppTheory cannot
guarantee exactness for token-valued inputs; required-input checks and CloudFormation-safe key composition remain
enforced. Consumers should replace copied `ns/` literals with
`AppTheoryS3VersionedIngress.KEY_ROOT` or the instance `keyRoot` accessor when adopting the v3.1.0 release. AppTheory
does not issue STS credentials or presigned requests and does not transfer platform provisioning authority to
application stacks.

### Versioned artifact attestation member modes

Starting in v3.1.0, the aggregate digest for a verified versioned artifact includes each regular tar member's mode.
Every sorted digest entry now has the fixed wire format
`path<two spaces>four-digit-octal-mode<two spaces>content-sha256`, with the mode rendered using `%04o`. Attestations
produced by the earlier path-and-content-only scheme do not verify under this scheme. Before upgrading, regenerate
every stored artifact digest with the current derivation and re-pin the resulting digest anywhere the operator stores
or supplies `ExpectedDigest`.

`ArtifactEntry.Mode` exposes the normalized value used by attestation, not the raw tar header value. AppTheory masks
the header with `header.Mode & 0o7777`, so only the permission and special-mode bits (execute, setuid, setgid, and
sticky) enter the digest; bits outside that mask are neither returned in `ArtifactEntry.Mode` nor attested.

### TableTheory v3 dependency floor

The current AppTheory v3 line requires TableTheory v3.0.5 in all three runtimes. This changes the Go type identity exposed
by AppTheory constructors and adapters that accept TableTheory interfaces: Go consumers must replace the previous
TableTheory `/v2` import path with `github.com/theory-cloud/tabletheory/v3` and require v3.0.5 or later when upgrading
AppTheory. Do not keep both TableTheory major paths in one application; their otherwise similar interfaces are distinct
Go types.

TableTheory v3 also adopts DMS v0.2 explicit-empty update semantics. An explicitly selected empty field marked
`omitempty` / `omit_empty` is removed instead of stored, while an unselected empty field remains unchanged. Audit
conditions, sparse indexes, projections, streams, and tests that depend on the presence of empty attributes. Follow the
canonical [TableTheory v3 migration guide](https://github.com/theory-cloud/TableTheory/blob/v3.0.2/docs/migration/v3.md)
for the complete persisted-shape and transaction changes.

TableTheory v3.0.1 established the legacy Go `Transaction.Update(model)` lifecycle contract: implicit selection excludes
`version` / `created_at` / `updated_at`, preserves stored `created_at`, and replaces caller-set `updated_at` with the
library timestamp. TableTheory v3.0.2 additionally treats zero as valid persisted optimistic-lock state on this surface:
it locks and increments version 0, so a missing or mismatched item fails its condition and aborts the whole transaction
group instead of being upserted. Call `Rollback`, then issue an explicit create when the item is absent. The legacy
transactional `Transaction.Delete(model)` surface and the explicit query `Delete()` surface add a lock condition only
for non-zero versions. `TransactionBuilder.Delete` attaches no automatic version lock; callers who need one must supply
the condition themselves.

Handle every legacy `Create`, `Update`, or `Delete` construction error. An ignored error now poisons the transaction;
`Commit` returns the stored first error and submits nothing, and `Rollback` is required before reuse. Unsigned Go
version fields from `uint` through `uint64` now work across every version path instead of panicking.

TableTheory v3.0.2 also rejects duplicate database attribute mappings at model parse or registration time, including Go
embedding shadowing shapes. Models accepted by v3.0.1 may now fail registration. Rename the Go field, assign a distinct
attribute tag, or exclude one mapping with `theorydb:"-"`; for same-name embedding collisions, changing only the
attribute tag is insufficient, so rename the Go field or exclude the embedded mapping.

AppTheory's TypeScript and Python release metadata continues to install TableTheory only from immutable GitHub Release
assets. The v3 dependency assets pinned by this line are:

- TypeScript: `theory-cloud-tabletheory-ts-3.0.2.tgz`, verified with SHA-512
  `K+jT8P2m+8QHvM+Y1hZxThnQfumcMVVwb8BltkEI8vs7bOg8PbUFR5w92ihBQbiA1pCvxG3kz7vwFhqNT0VUtw==`.
- Python: `tabletheory_py-3.0.2-py3-none-any.whl`, verified with SHA-256
  `f6a7d6876a6e7bb71c342023e002b2e5a92a2dc3d704ae233d9fb58354cbe8db`.

Use those pinned assets through AppTheory's package metadata; do not substitute registry-published packages or mutable
URLs.

## v1.15.x line

The v1.15 line contains the Strengthening Program work that made AppTheory stricter without creating a v1 breaking
release. The intended upgrade posture is additive: existing code keeps working, while deprecated compatibility helpers
point at the single future path.

### Canonical framework errors

New code should raise/return `AppTheoryError` for framework-emitted errors. `AppError` remains supported for legacy
code/message compatibility, but it is deprecated as the primary framework error type.

| Runtime | Legacy surface | Replacement | Horizon |
| --- | --- | --- | --- |
| Go | `AppError` | `AppTheoryError` | Supported for v1.x; earliest removal is v2.0. |
| TypeScript | `AppError` | `AppTheoryError` | Supported for v1.x; earliest removal is v2.0. |
| Python | `AppError` | `AppTheoryError` | Supported for v1.x; earliest removal is v2.0. |

Default nested HTTP error envelopes remap any error whose code string is `EMPTY_BODY` or `INVALID_JSON` to the
canonical `app.bad_request` code and message. The remap is keyed by the error code string so that legacy
JSONHandler-originated errors and callers that still return those Lift-era codes converge to the same nested envelope.
If you temporarily need the old flat shape during a Lift migration, opt into the legacy HTTP error format explicitly:

- Go: `apptheory.WithHTTPErrorFormat(apptheory.HTTPErrorFormatFlatLegacy)` or `apptheory.WithLegacyHTTPErrorShape()`
- TypeScript: `createApp({ httpErrorFormat: HTTP_ERROR_FORMAT_FLAT_LEGACY })`
- Python: `create_app(http_error_format=HTTP_ERROR_FORMAT_FLAT_LEGACY)`

Treat that flat legacy format as a migration bridge, not the target state for new applications. Flat legacy preserves
the Lift-era `EMPTY_BODY` / `INVALID_JSON` codes and messages; the nested AppTheory envelope remains the v1 default
and the future-major path.

### Legacy JSON helpers

Go `JSONHandler` remains available for compatibility with Lift-era handlers, but new code should return AppTheory
`Response` values through normal route handlers and use the canonical response helpers (`JSON`, `Text`, `Binary`, SSE,
and stream helpers as appropriate).

| Runtime | Legacy surface | Replacement | Horizon |
| --- | --- | --- | --- |
| Go | `JSONHandler` | AppTheory route handlers returning `Response` / `JSON` / `Text` / `Binary` | Supported for v1.x; earliest removal is v2.0. |

### Fail-closed route registration

The fluent registration path is now fail-closed across runtimes. Invalid route patterns, duplicate canonical
method/pattern pairs, and nil/undefined/None handlers fail during registration instead of producing a dead route at
runtime. This is an intentional behavior change for misconfigured applications that older v1 lines could silently
ignore; treat it as action-required upgrade guidance before promoting a service that constructs routes dynamically.

Use the normal registration path for new code:

| Runtime | Preferred path |
| --- | --- |
| Go | `app.Get(...)`, `app.Post(...)`, `app.Handle(...)`, and other fluent methods |
| TypeScript | `app.get(...)`, `app.post(...)`, `app.handle(...)`, and other fluent methods |
| Python | `app.get(...)`, `app.post(...)`, `app.handle(...)`, and other fluent methods |

Strict helpers are deprecated compatibility wrappers for callers that already depend on their error-returning/throwing shape.
Their failure details now share the canonical AppTheory error path: Python `add_strict` / `handle_strict` raise
`AppTheoryError` instead of `ValueError`, and Go `GetStrict` / `HandleStrict` / related helpers return canonical
`AppTheoryError` messages where applicable rather than older segment-specific strings. Update tests that asserted the
legacy exception class or exact message text:

| Runtime | Deprecated compatibility helper | Replacement | Horizon |
| --- | --- | --- | --- |
| Go | `GetStrict`, `HandleStrict`, and related `*Strict` helpers | Normal fluent registration; catch startup panics in tests if you need setup-error assertions | Supported for v1.x; earliest removal is v2.0. |
| TypeScript | `handleStrict` | `handle` / `get` / `post` / normal fluent registration | Supported for v1.x; earliest removal is v2.0. |
| Python | `handle_strict` | `handle` / `get` / `post` / normal fluent registration | Supported for v1.x; earliest removal is v2.0. |

When upgrading, run application startup tests that construct every route and include duplicate-route, invalid-pattern,
and nil/undefined/None-handler cases if your service builds route tables programmatically. A route typo that was
previously ignored may now fail fast during app initialization. That is expected fail-closed behavior; fix the route
pattern rather than wrapping it in a fallback router.

## v1.14.x and older v1 lines

Before the v1.15 strengthening work, some documentation and examples used strict helpers as the recommended way to
catch bad route patterns. When moving from older v1 lines to v1.15 or later:

1. Replace strict helper usage in ordinary app setup with normal fluent registration.
2. Keep strict helpers only where a test deliberately asserts the compatibility shape.
3. Replace new framework-emitted `AppError` usage with `AppTheoryError`.
4. Plan migration away from Go `JSONHandler` if you still have Lift-era handler adapters.
5. Keep any temporary flat legacy HTTP error format opt-in isolated to migration boundaries.

## Maintainer checklist for future lines

For every minor line, update this file when any of the following change:

- public API deprecation posture;
- default runtime behavior, even when the change is fail-closed and additive;
- dependency floors or installation asset names;
- CDK construct defaults that affect deployed infrastructure;
- migration-only compatibility formats;
- generated artifact expectations such as `ts/dist`, `cdk/lib`, `cdk-go`, or API snapshots.

Do not rely on the generated changelog for action-required guidance. If a consumer must do something, document it here
and link to the exact canonical guide or release note.
