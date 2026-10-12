# Conformance kit spec (M0, item 6a)

Status: spec for review (M0). The kit itself is built in M1 (synth/posture) and M2–M3 (runtime).
Last updated: 2026-10-12
Owner: AppTheory

The conformance kit is the mechanism that makes the M2 security goal **test-pinned** instead of asserted:
credential-free requests never reach an application handler on MCP transport routes, the posture is explicit,
and misconfiguration fails at synth/registration. It is the G10 gap ("nothing pins transport-route
authorization type").

## 1. What the kit pins (three layers)

### Layer A — synth-time transport-route authorization type

A CDK assertion test proves, for a synthesized `AppTheoryMcpServer` in each posture, that **every** MCP
transport route's `AuthorizationType` matches the posture:

| Posture | Transport route `AuthorizationType` | OAuth surface routes (PRM/discovery/authorize/token/register/callback) |
| --- | --- | --- |
| `iam` | `AWS_IAM` | `NONE` (public by design) |
| `jwt` | `JWT` + issuer/audience | `NONE` |
| `runtime-bearer` | `NONE` | `NONE` |
| `none-public` | `NONE` | `NONE` |

The test iterates the route inventory so a newly derived route (e.g. `/register`) cannot be added without an
authorization assertion. The expectation table is a versioned contract table (see §4).

### Layer B — runtime credential-free behavior

A runtime test (Go/TS/Py) mounts the facade with a `runtime-bearer` posture and proves:

1. a credential-free request to a transport route returns **401** with
   `WWW-Authenticate: Bearer resource_metadata="<route metadata URL>"` where the metadata URL is derived from
   the **matched route** (per-route, not family-wide in `route` issuer mode);
2. the **application handler is never invoked** — the test's MCP handler records an invocation counter and the
   assertion is `handler_invocations == 0` on the denied request;
3. the challenge's `resource_metadata` resolves to the route's RFC 9728 document, and that document advertises
   `resource` = route URL and `authorization_servers` = `[route URL]` in `route` issuer mode;
4. a valid token advances to the handler (`handler_invocations == 1`), proving the pin is not "always deny".

### Layer C — registration/synth fail-closed

The kit proves misconfiguration fails closed (§3).

## 2. Machine-readable expectations

The kit consumes versioned contract tables (the `routing/mcp-route-algebra/` precedent: a nested table loaded
directly by the Go and CDK-TS suites rather than by the generic three-language fixture runner):

- `facade-transport-posture.v1.json` — `posture → { transport_authorization_type, oauth_surface_authorization_type, requires: [throttling, origin_reachability, denial_signal] }` plus the per-posture expectation rows.
- `facade-route-model.v1.json` — the v2 route inventory (patterns + derived `register`/`callback` + issuer/resource derivation) that Layer A iterates.

M0 authors both tables under this planning directory in the repo's contract-table shape. **M1 moves them into
`contract-tests/fixtures/routing/mcp-auth-facade/`** (a nested table directory under the known `routing`
domain) and adds the Go + CDK-TS loaders that consume them, so route and posture literals exist exactly once,
matching how `facade-route-inventory.json` is consumed today by `runtime/mcpfacade/facade_test.go` and
`runtime/mcproutes/mcp_route_algebra_test.go`.

## 3. Fail-closed assertions

| Misconfiguration | Expected failure |
| --- | --- |
| CDK `runtime-bearer` without the runtime-posture declaration prop | synth throws |
| CDK `runtime-bearer` without a recorded throttle setting | synth throws (DD-1) |
| CDK `runtime-bearer` without an origin-reachability decision | synth throws (DD-2) |
| CDK `none-public` without the floor | synth throws |
| Runtime `TransportPosture == RuntimeBearer` without `RequireBearerToken` | `RegisterMCPFacade` returns an error; no route registered |
| Runtime `TransportPosture == RuntimeBearer` with `UnauthenticatedMcp` | registration error |
| Synthesized posture marker ≠ runtime registration output | kit fails (posture disagreement) |

## 4. Registration in the contract-test corpus (M1)

To register the tables as first-class contract fixtures in M1 (not M0), the change set is:

1. add the nested directory `contract-tests/fixtures/routing/mcp-auth-facade/` (nested tables are the documented
   exception to one-level discovery; they are loaded by tests, not the generic runner);
2. add the Go loader test (under `runtime/mcpfacade` and/or `runtime/mcproutes`) and the CDK-TS loader test
   (`cdk/test/`);
3. bump the public fixture-count markers (the corpus count is recursively counted by
   `scripts/verify-fixture-count.sh`, and the nested route/facade tables are already included and described as
   the "Go/CDK-TS MCP route/facade tables");
4. update `contract-tests/fixtures/README.md` (the `routing/` entry names the nested tables).

M0 does **not** do (1)–(4): with no runtime facade to load against and no loader permitted under `runtime/**`
in this milestone's write scope, adding the tables to the live corpus would create inert vectors and inflate
the public count without an executable pin. The M0 tables live in this planning directory and are the contract
of record.

## 5. Where the kit runs (docs/110 validation plan)

| Consumer | What it runs | Why |
| --- | --- | --- |
| AppTheory CI | Layers A/B/C (Go + CDK-TS + all three runtimes) | The framework's own parity and fail-closed proof. |
| TMS CI | Layer A against TMS's synthesized stack (which posture it deployed) + Layer B against TMS's real mount | Pins TMS's transport authorization type (docs/110 success criterion 4). |
| Autheory CI | The provider-facing fixtures (discovery/issuer/refresh-binding adapter contract) | Pins the first provider adapter's assumptions. |

The kit is a **specification and a library of assertions**, not a live service. Fixture-only coverage is
explicitly not sufficient for the cross-repo seam: the M6 lab proof is still required (see
`PARITY_AND_DELIVERY.md`).

## 6. Observation channels (ADV-P110-6)

For the lab-proof claims the kit cannot prove alone, the receipt must name the channel:

| Claim | Observation channel |
| --- | --- |
| credential-free request → 401 + challenge | captured response headers at the edge/API and the runtime denial log record |
| no application handler invocation | Lambda invocation count + handler-emitted structured log absence + the runtime denial record |
| transport route authorization type | the synthesized template (CloudFormation) for the deployed stack |
| no upstream material to client | captured token and callback response bodies inspected for upstream-token shapes |
| posture marker agrees | the synthesized marker read from the template vs the running registration output |

## 7. Open decisions

1. Whether the posture marker is CloudFormation `Metadata` on the construct or a jsii-side assertion recorded
   in the synth snapshot (recommend: CFN metadata, so the kit can read it from a deployed template).
2. Whether the kit's Layer B runs in the app's own CI via a published test helper or via the framework's
   testkit (recommend: a published testkit helper per runtime so all three apps share one implementation).
