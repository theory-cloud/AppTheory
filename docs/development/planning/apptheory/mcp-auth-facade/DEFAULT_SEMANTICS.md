# Default semantics decision (M0, item 3) — **operator review required**

Status: recommended decision, for the operator to accept or change at the M0 PR.
Last updated: 2026-10-12
Owner: AppTheory

This document resolves the ruling tension flagged by the plan gate (ADV-P110-4). Operator ruling 2 says the
v6.0.0 corrections are **not** breaking, there are **no back-compat shims and no opt-in flags**, and the
framework must **design the right default directly**. The M1 sketch in Factory docs/110 read as an *additive*
posture (a third authorizer kind beside IAM/JWT, IAM default untouched). Those are different designs. This is
the explicit recommendation.

## Recommendation (one paragraph)

**Default the MCP transport posture to `runtime-bearer` for a facade-configured server, keep `iam` as the
default for a plain (non-facade) `AppTheoryMcpServer`, and replace `unauthenticatedMcp` with an explicit
`transportPosture` selection whose `none-public` value is never a default.** The default is resolved by the
construct, not asked of the caller. For an MCP server that attaches the OAuth facade (RFC 9728 protected
resource + RFC 8414 discovery + authorize/token/register routes, i.e. a server fronting an auth provider on
one domain), the only fail-closed posture that also completes the RFC 9728 handshake is runtime-validated
bearer; making the caller opt in would re-create exactly the v6.0.0 failure mode where the app default was
wrong for its shape. IAM stays available **explicitly** for AWS-native callers; JWT stays available
**explicitly** where a static issuer+audience suffices. `none-public` remains possible but must be named,
carries the defense-in-depth floor, and is conformance-pinned.

## Options considered

### Option A — Facade-scoped default flip (recommended)

`AppTheoryMcpServer` resolves transport posture as:

| Construct shape | Default posture |
| --- | --- |
| Facade-configured (facade routes / `routeFamily` attached) | `runtime-bearer` |
| Plain transport only | `iam` (unchanged from v6.0.0) |

`transportPosture` is a single selection: `iam` | `jwt` | `runtime-bearer` | `none-public`. `unauthenticatedMcp`
is removed. Selecting `runtime-bearer` is paired with the runtime posture at registration and synth (§Failure
behavior). Selecting `none-public` is explicit, requires `rootAuthorizationServerDiscovery` to be either off
or explicitly declared public, and is pinned by the conformance kit.

- **Keeps the M2 goal:** credential-free requests still never reach an application handler on transport
  routes; the posture is explicit, fail-closed, and test-pinned.
- **Satisfies ruling 2's plain reading:** the corrected default is what the app *is*, not what it opts into.
- **No shim:** `unauthenticatedMcp` is replaced, not aliased. `runtime-bearer` is not a boolean to unset a
  v6.0.0 default; it is the shape of a facade server.
- **Consequence:** a plain `new AppTheoryMcpServer(this, "Mcp", { handler })` with no facade still defaults
  to IAM (unchanged), so the diff for AWS-native servers is zero.

### Option B — Additive explicit posture (the M1 sketch)

Keep IAM default; add `runtime-bearer` as a kind the caller must choose.

- **Fails the operator ruling's plain reading:** the app must opt in, which is an opt-in flag by another name,
  and it leaves the wrong default in place for the shape that needs the change. It is also why the v6.0.0
  flip went undetected: nothing tied posture to shape.
- **Consequence:** TMS-class apps keep hand-wiring routes and continue to be the framework's proof by
  accident, not design. Rejected.

### Option C — Replacing `unauthenticatedMcp` semantics (make it mean "runtime-owned bearer")

Repurpose the existing all-public opt-out to mean runtime-bearer.

- **Rejected on meaning:** "unauthenticated" and "runtime-validated bearer" are opposites. Repurposing the
  name is a shim in spirit (callers silently change meaning) and is confusing to read. The explicit
  `transportPosture` enum is the honest replacement.
- The useful part of C — removing the boolean — is folded into Option A.

## Failure behavior (fail closed, no silent degradation)

| Where | Trigger | Result |
| --- | --- | --- |
| **CDK synth** | `runtime-bearer` selected but no runtime-posture declaration prop | Construct throws at synth. |
| **CDK synth** | `none-public` selected without the defense-in-depth floor (throttling/lock decision) | Construct throws at synth. |
| **CDK synth** | `jwt` selected without a static issuer + non-empty audience | Construct throws at synth (existing behavior, `cdk/lib/mcp-server.ts:869-900`). |
| **CDK synth** | `runtime-bearer` in attach mode where the owning API's throttling/lock decision is unrecorded | Construct throws at synth (see `DEFENSE_IN_DEPTH.md`). |
| **Runtime registration** | `FacadeConfig.TransportPosture == RuntimeBearer` without `RequireBearerToken` (or an equivalent explicit posture assertion) | `RegisterMCPFacade` returns an error **before any route is registered**. |
| **Runtime registration** | `TransportPosture == RuntimeBearer` combined with `UnauthenticatedMcp` / a public transport handler | Registration error. |
| **Runtime registration** | authorize/token factories not all-or-none | Registration error (existing, `runtime/mcpfacade/facade.go:448-466`). |
| **Registration/synth** | posture and runtime disagree (CDK says runtime-bearer, runtime does not validate) | The conformance kit fails: the synthesized posture marker and the runtime registration output must agree. |

The invariant that must never regress: **a credential-free request cannot silently reach an application
handler on an MCP transport route.** Every row above fails closed rather than degrading to "authenticate in
the runtime and hope the app wired it".

## Runtime counterpart (Go / TS / Py)

| Surface | Go | TypeScript | Python |
| --- | --- | --- | --- |
| Facade registrar | `mcpfacade.RegisterMCPFacade` | `registerMcpFacade` | `register_mcp_facade` |
| Posture field | `FacadeConfig.TransportPosture` | `transportPosture` | `transport_posture` |
| Runtime validation | `RequireBearerToken` (`oauth.RequireBearerTokenOptions`) | `requireBearerTokenMiddleware` | `require_bearer_token_middleware` |
| Pairing failure | registration error | registration error | registration error |

Today the route algebra and the registrar exist **only in Go** (gap G3); the TS/Py registrars are a mandatory
part of M1/M3 so the pairing is enforceable in every runtime, per the atomic-parity rule.

## Operator decisions requested

1. Accept Option A (facade-scoped default flip) — **recommended**, or choose B/C with reasons.
2. Accept removing `unauthenticatedMcp` in favor of `transportPosture` (no alias, no shim).
3. Accept that `none-public` composes with `rootAuthorizationServerDiscovery` when both are explicitly
   declared public (today the construct throws); confirm the defense-in-depth floor in `DEFENSE_IN_DEPTH.md`
   is the intended safeguard instead of a hard throw.
