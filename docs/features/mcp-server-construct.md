---
title: MCP Server Facade Construct
---

# MCP Server Facade Construct

`AppTheoryMcpServer` is the CDK deployment contract for the route-algebra MCP OAuth facade. Its primary mode attaches
an ordered MCP route family to a caller-owned API Gateway v2 `IHttpApi`; omitting `api` creates the same surface on a
standalone `HttpApi`. The construct routes traffic only. Go `runtime/mcpfacade.RegisterMCPFacade` owns runtime
composition, and the application owns issuer, JWKS, scopes, capabilities, and authorize/token behavior through its
explicit `FacadeConfig`.

This is the one path for both the four-pattern `theory-mcp-server` topology and a standalone specialization. It does
not accept an origin or resource URL, does not inject OAuth metadata configuration, and does not rederive OAuth routes
outside `AppTheoryMcpRouteAlgebra`.

## Route families

A route family is an ordered `patterns` list. Each pattern must be a synthesis-time string whose segments are either
RFC 3986 literal path segments or complete `{parameter_name}` segments. Parameter names start with a letter or
underscore and continue with letters, digits, or underscores. Tokens, origins, relative paths, empty segments,
`.`/`..`, mixed literal/parameter segments, greedy parameters, and duplicate patterns fail synthesis.

The default family is the contract's ordered endpoint quartet:

```ts
const server = new AppTheoryMcpServer(this, "McpServer", {
  handler,
});
```

| Kind | Default MCP pattern |
| --- | --- |
| namespace | `/{client_namespace}/mcp` |
| partner namespace | `/{client_namespace}/partners/{partner_id}/mcp` |
| agent | `/{client_namespace}/agents/{agent_id}/mcp` |
| partner agent | `/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp` |

For every pattern, the construct calls `AppTheoryMcpRouteAlgebra` to derive and wire the exact runtime facade:

- `POST`, `GET`, and `DELETE` on the MCP pattern;
- `GET` on RFC 9728 protected-resource metadata;
- `GET` on canonical and suffix-compatible RFC 8414 discovery;
- `GET` on the application-owned authorize endpoint;
- `POST` on the application-owned token endpoint.

`routeInventory` exposes the contract version and the ordered derived paths. Its shape intentionally matches the
relevant fields of `mcpfacade.RouteInventory`. A shared fixture is asserted by both the Go helper tests and CDK synth
tests, so dropping a pattern, transport method, or facade route fails the repository gates. Set
`routeFamily.rootAuthorizationServerDiscovery: true` only when the runtime also supplies
`FacadeConfig.RootAuthorizationServer`; both sides then install the algebra-derived root discovery route.

`runtime/mcpfacade.RegisterMCPFacade` serves exactly this canonical four-pattern family. A noncanonical `routeFamily`
still uses the construct's route algebra, but it is runtime-bring-your-own-registration: the application must register
handlers for every entry in `routeInventory` and must not assume `RegisterMCPFacade` can be configured with those
patterns. This boundary keeps the shipped helper and the deployed routes congruent instead of presenting a facade
that returns 404 for every configured path.

## Stage-global upstream callback

The upstream OAuth callback is installed once per deployment rather than once per MCP kind: the callback is correlated
by the single-use upstream state the facade minted, so no per-kind callback multiplies. The construct wires one `GET`
route for it, exposed as `routeInventory.callbackPattern`.

`upstreamCallbackPath` overrides the path. It must be a synthesis-time literal absolute path with no query, fragment, or
dot segment, and it is normalized with the same rules as every other route path (`/cb/` becomes `/cb`). An empty value
keeps the contract default, `AppTheoryMcpRouteAlgebra.DEFAULT_CALLBACK_PATH` (`/_oauth/mcp/callback`); a token, a
relative path, or a value that collides with another derived route fails synthesis.

```ts
new AppTheoryMcpServer(this, "McpServer", {
  handler,
  upstreamCallbackPath: "/_oauth/mcp/callback",
});
```

The construct resolves the prop through `AppTheoryMcpRouteAlgebra.callbackPathForConfiguredPath`, the same algebra the
runtime applies to `FacadeConfig.UpstreamCallbackPath` in Go, TypeScript, and Python. Supplying the same value to the
construct and to the runtime `FacadeConfig` keeps the CDK-mounted route and the runtime-registered route congruent
instead of letting them diverge. `transportPosture: none-public` attaches no OAuth surface, so it refuses
`upstreamCallbackPath`.

## Attach mode and owned mode

Attach mode is for a shared front door. It adds `HttpRoute` resources to the supplied `IHttpApi` and creates no
`AWS::ApiGatewayV2::Api`:

```ts
new AppTheoryMcpServer(this, "PublicMcpFacade", {
  handler: apiFunction,
  api: publicHttpApi,
  routeFamily: {
    patterns: AppTheoryMcpRouteAlgebra.supportedEndpointTemplates().map(
      (route) => route.mcpPattern,
    ),
    rootAuthorizationServerDiscovery: true,
  },
  // The shared front door already owns its stage posture.
  sessionState: { enabled: false },
});
```

The API owner owns its stage, logging, throttling, domain, CDN, and public authority. Therefore `ownedApi`, and the
deprecated top-level `apiName`, `domain`, and `stage` props, are invalid with `api`; synthesis names every conflicting
prop. This is the topology needed for a control plane such as `theory-mcp-server`, where MCP, OAuth, downloads,
webhooks, and control-plane routes share one front door.

Attach-mode `endpoint` and `endpoints` values are execute-api origin templates, not declarations of that public
authority. The construct derives their origin from `api.apiId`, the stack region, and the AWS URL suffix; it never
consults an `apiEndpoint` supplied through `HttpApi.fromHttpApiAttributes`. Set `attachedApiStageName` when the intended
stage is known so a non-`$default` stage such as `prod` appears in each template. If the stage is not supplied, the
construct cannot determine it and retains the bare execute-api origin. This accessor behavior does not change the
front door's ownership of its public URL.

Owned mode is the standalone specialization. Omit `api` and optionally configure `ownedApi`:

```ts
new AppTheoryMcpServer(this, "StandaloneMcp", {
  handler,
  ownedApi: {
    apiName: "cloud-keeper-mcp",
    stage: { stageName: "live" },
  },
});
```

Only owned mode may create or configure a custom domain or stage. `attachedApiStageName` only identifies an existing
attach-mode stage for endpoint-template derivation; it does not create, import, or mutate that stage. `endpoints`
returns one execute-api or owned-domain template per family member; parameterized values remain templates until
request time.

## Transport posture

The full facade is wired by default, and the three MCP transport routes (`POST`, `GET`, and `DELETE` on every MCP
pattern) require credentials. A plain transport server defaults to an IAM authorizer; attaching `facade` marks the
server facade-configured and flips the default to `runtime-bearer`, where the gateway authorizer is `NONE` and the
runtime validates RFC 9728 bearer tokens. A credential-free request is then rejected by API Gateway (IAM/JWT) or by the
runtime before the application handler runs.

`transportPosture` selects the posture explicitly and overrides that default. The four values are `iam`, `jwt` (a static
issuer and audience through `transportAuthorizer`), `runtime-bearer` (runtime-validated RFC 9728 bearer tokens), and
`none-public` (deliberately public, never a default). `jwt` is the only posture that accepts `transportAuthorizer`;
supplying it with `iam`, `runtime-bearer`, or `none-public` fails synthesis.

`runtime-bearer` and `none-public` carry a mandatory defense-in-depth floor and fail synthesis without it:

- `originReachability` must be `disabled` or `locked`; a directly reachable origin is refused;
- `runtime-bearer` requires `runtimePosture: { requireBearerToken: true }`, which asserts the runtime registers the
  transport routes with the runtime-validated bearer posture;
- in owned mode the throttling decision must be explicit (`ownedApi.stage.throttlingEnabled: true`) and access logging
  must stay on; in attach mode `owningApiDefense` records the owning API's access-logging and throttling decisions;
- `runtime-bearer` also requires a `denialSignal` declaration naming the `apptheory.mcp.auth_denied` metric with the
  bounded `outcome` and `route_family` dimensions.

Discovery, protected-resource metadata, authorize, and token routes stay explicitly `NONE` so a supplied API's default
authorizer cannot intercept OAuth traffic: OAuth clients must fetch those documents before they hold a token. Scope
policy and authorize/token behavior belong to the AppTheory runtime composition helper. Applications must call
`RegisterMCPFacade` with non-empty per-kind scopes and an application-owned authorize/token handler pair. The helper
fails closed if that pair is partial and does not install authorize/token runtime routes when both are absent.

`none-public` wires only the three MCP transport methods and no OAuth facade, and it cannot be combined with
`transportAuthorizer`, root discovery, the deprecated issuer/JWKS props, `upstreamCallbackPath`, or `runtimePosture`.
`RegisterMCPFacade` now registers the MCP transport routes with an authenticated posture by default and pairs its
`FacadeConfig.TransportPosture` with `FacadeConfig.RequireBearerToken`, which validates RFC 9728 bearer tokens on those
routes. Omitting runtime auth config is not an opt-out: the default CDK facade remains present and the runtime must
initialize its explicit `FacadeConfig` successfully.

The synthesized template records the resolved posture as CloudFormation `Metadata` under
`apptheory:mcp-transport-posture` (`posture`, `contract_id`, `route_count`, `runtime_posture_declared`) so a
conformance kit can compare a deployed posture with the runtime registration output.

The v3.1.x `authorizationServerIssuer` and `jwksUri` props are deprecated together. They remain pair-validated for
migration safety but no longer control facade wiring and no longer become environment variables. Move them into
`mcpfacade.FacadeConfig.IssuerURL` and `.JWKSURI`; scopes and capabilities move into the same app-owned struct.

## Production defaults and opt-outs

Owned mode enables these defaults:

| Surface | Default | Explicit opt-out |
| --- | --- | --- |
| DynamoDB session state | on; pay-per-request, AWS-managed encryption, PITR, TTL, retain removal policy | `sessionState: { enabled: false }` |
| Access logging | on; one-month retention | `ownedApi.stage.accessLogging: false` |
| Stage throttling | on; 100 requests/second, burst 200 | `ownedApi.stage.throttlingEnabled: false` |

Disabled surfaces reject their dependent options. For example, a disabled session table cannot also specify
`tableName`, `ttlMinutes`, or `removalPolicy`; disabled throttling cannot specify rate or burst limits. Under
`runtime-bearer` and `none-public` the access-logging and throttling opt-outs are refused outright: the owned stage must
keep access logging and an explicit throttling decision. Attach mode still creates the session table by default, but
logging and throttling belong to the supplied API's owner. A shared front door must configure those controls on its own
stage rather than asking an attached child construct to mutate them.

## Runtime helper and environment contract

The construct and `runtime/mcpfacade` share routes, not configuration environment variables. `FacadeConfig` has no env
reads. Issuer, JWKS, optional registration endpoint, URL mode, public base URL or hostname allowlist, per-kind scopes,
capabilities, MCP handler, authorize/token factories, optional root discovery, and the transport posture
(`FacadeConfig.TransportPosture` paired with `FacadeConfig.RequireBearerToken`) are app-owned values.

The construct writes only environment variables consumed by existing runtime code:

| Variable | When written | Runtime consumer |
| --- | --- | --- |
| `MCP_SESSION_TABLE` | session state enabled | `runtime/mcp` DynamoDB session store |
| `MCP_SESSION_TTL_MINUTES` | session state enabled | `runtime/mcp` session policy |

`MCP_ENDPOINT` is retired in v6 in both directions: no construct writes it and no runtime reads it, so there is no shim.
The bearer challenge is app-owned configuration — a route-derived `ResourceMetadataURLFunc`, the per-actor
`ResourceMetadataURLTemplate` (TypeScript `resourceMetadataURLTemplate`, Python `resource_metadata_url_template`), or an
explicit `ResourceMetadataURL` (precedence: resolver > template > static) — and with none configured the middleware
advertises the bare `Bearer` challenge. `AppTheoryRemoteMcpServer` exposes the route-derived
`protectedResourceMetadataUrl` (the RFC 9728 metadata URL template, with `{actor}` preserved when `actorPath` is
enabled); pass it into your own app config and configure it as the template option so the middleware resolves `{actor}`
from the matched route. The construct emits a synth warning on the per-actor route and injects no environment variable
for this. `AppTheoryMcpServer` exposes its route-derived protected-resource paths through `routeInventory` and
`protectedResourceMetadataPaths`. The construct still does not accept an origin prop — adding one would reintroduce the
THE-2861 failure class.

The construct never writes the retired `APPTHEORY_MCP_PATH`, `APPTHEORY_MCP_PROTECTED_RESOURCE_PATH`,
`APPTHEORY_MCP_AUTHORIZATION_SERVER_ISSUER`, or `APPTHEORY_MCP_JWKS_URI` variables.

## v3.1.x A6 migration

The A6 shape is deprecated in place for the next minor. There is no parallel legacy construct and no major-version
fork.

| A6 surface | Redesign fate |
| --- | --- |
| `handler` | retained unchanged |
| `mcpPath` prop | deprecated; use `routeFamily.patterns` |
| `authorizationServerIssuer` prop | deprecated; move to `FacadeConfig.IssuerURL` |
| `jwksUri` prop | deprecated; move to `FacadeConfig.JWKSURI` |
| `apiName` prop | deprecated; use `ownedApi.apiName` |
| `enableSessionTable` prop | deprecated; use `sessionState.enabled`; default flips from off to on |
| `sessionTableName` prop | deprecated; use `sessionState.tableName` |
| `sessionTtlMinutes` prop | deprecated; use `sessionState.ttlMinutes` |
| `domain` prop | deprecated; use `ownedApi.domain`; invalid in attach mode |
| `stage` prop | deprecated; use `ownedApi.stage`; invalid in attach mode |
| `api` accessor | retained and generalized from `HttpApi` to `IHttpApi` |
| `endpoint` accessor | deprecated; use ordered `endpoints` |
| `mcpPath` accessor | deprecated; use ordered `mcpPaths` |
| `protectedResourceMetadataPath` accessor | deprecated; use `protectedResourceMetadataPaths` or `routeInventory` |
| POST-only/no-facade default | removed; full three-method OAuth facade is the default |
| session/logging/throttling off by default | removed; production defaults are on |
| issuer/JWKS env injection | removed; `FacadeConfig` is explicit app-owned configuration |

`AppTheoryMcpProtectedResource` remains only for existing REST API stacks that intentionally synthesize a static
metadata document. Its URL-valued props are deprecated and are not an alternate namespace deployment path.
