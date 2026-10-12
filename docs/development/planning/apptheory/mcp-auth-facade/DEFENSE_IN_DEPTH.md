# Defense-in-depth floor for runtime-validated bearer (M0, item 4)

Status: mandatory floor for review (M0).
Last updated: 2026-10-12
Owner: AppTheory

ADV-P110-1 requires the plan gate to produce a **mandatory floor**, not a menu, for the `runtime-bearer` (and
`none-public`) postures. Under those postures the API Gateway transport route authorizer is `NONE`, so every
request — including a credential-free one — is forwarded to the Lambda. The runtime still fails closed (401 +
RFC 9728 challenge, no handler invocation), but the **invocation** happens, which is a cost-amplification and
an unbounded unauthenticated surface unless the floor below is in place.

This floor is mandatory **for any runtime-validated bearer posture** (`runtime-bearer`) and for `none-public`.
It does not apply to `iam`/`jwt` (the gateway rejects before the runtime).

## Mandatory (construct refuses to synthesize without it)

### DD-1 — Stage throttling is required

- **What:** the API stage serving MCP transport routes must have explicit throttling (rate and burst).
- **Why:** credential-free requests reach the Lambda; without a throttle the surface is unbounded and cost can
  be driven arbitrarily. TMS's attach-mode stage currently sets **no throttling at all**; construct-owned mode
  defaults to rate 100 / burst 200 (`cdk/lib/mcp-server.ts:14-15,757-785`).
- **How:** in owned-API mode the construct already creates the stage with throttle values
  (`cdk/lib/mcp-server.ts:401-411`); under runtime-bearer the construct must **require** an explicit throttle
  setting (a documented default is applied but its presence is asserted, not silently omitted). In attach mode
  the construct cannot create the stage, so it must require the app to record the owning API's throttle
  decision and fail synth otherwise.
- **Enforceable at synth:** yes.
- **Pinned by:** conformance kit `facade-transport-posture` — a `runtime-bearer` stack without a recorded
  throttle setting must fail synth; the pinned stack must carry `AWS::ApiGatewayV2::Stage` throttling.

### DD-2 — Explicit direct-origin reachability decision

- **What:** the app must record, in encoded config, whether the `execute-api` default endpoint (and any custom
  domain) is directly reachable, and if so either **disable** it (`disableExecuteApiEndpoint`) or **lock the
  origin** (CloudFront with a locked origin / VPC origin, or a custom domain that fronts the locked origin).
- **Why:** runtime bearer is fail-closed per request, but direct reachability changes who can reach that gate
  and whether the edge restoration/throttle path applies. It must be a decided, recorded posture — not an
  accident of deployment shape.
- **How:** a required `originReachability` decision on the construct (`disabled` | `locked` | `direct`), where
  `direct` is allowed only with DD-1 satisfied and is called out in the deploy receipt.
- **Enforceable at synth:** yes (presence + mutual-exclusion checks).

### DD-3 — Denial telemetry replacement

- **What:** under `NONE`, gateway **authorizer-denial telemetry disappears**. The framework must provide a
  named runtime signal for transport-route denials.
- **Why:** without a replacement, denial volume is invisible; the v6.0.0 flip was undetected partly because
  nothing observed the posture. The plan gate explicitly requires naming the replacement signal.
- **How (replacement signal names):**
  - **Metric:** `apptheory.mcp.auth_denied` (count), dimensioned on the bounded outcome value
    (`missing_token` | `invalid_token` | `insufficient_scope` | `forbidden`) and the route family — never on
    raw token values or unbounded paths.
  - **Log field:** a structured denial record carrying the outcome, the remediation scope set (when
    `insufficient_scope`), and the route kind; no bearer material.
  - **Access-log signal:** API Gateway access logs remain available and give status counts (401/403) for the
    transport routes, which is the coarse availability signal when the runtime signal is not wired.
- **Enforceable at synth:** the construct can require that access logging is enabled (it is today:
  `AppTheoryMcpServer` optional access logs, `cdk/lib/mcp-server.ts:392-424`) **and** that the app declares the
  runtime denial signal; the runtime emission itself is runtime behavior pinned by contract fixtures (M3), not
  by synth. State plainly: **synth can require the declaration; only fixtures + lab proof can observe the
  emission.**
- **Pinned by:** conformance kit (declaration present) + M3 facade fixtures (emission) + M6 lab receipt (real
  observation channels; see ADV-P110-6).

## Optional (recommended, not mandatory)

### DD-4 — Edge presence gate (CloudFront viewer-request)

- **What:** a CloudFront viewer-request function that rejects a request with no `Authorization` header before
  it reaches the origin, synthesizing the 401 + RFC 9728 challenge at the edge.
- **Why optional:** it duplicates the runtime gate, adds a distribution dependency, and is bypassed if the
  origin is reachable directly (which is why DD-2 is mandatory). It is valuable when a CloudFront front door
  already exists: it removes the Lambda invocation for credential-free traffic.
- **Recommendation:** ship as an optional framework front-door option; recommend when a distribution exists.
- **Enforceable at synth:** it can be offered as a construct option; whether it is present is the app's
  choice, recorded in config.

### DD-5 — WAF / rate-based rules

- **What:** a regional WAF rate-based rule on the transport routes.
- **Why optional:** DD-1's stage throttle is the mandatory backstop; WAF adds per-IP shaping and bot rules.
- **Recommendation:** documented, not enforced.

## Summary

| Control | Status | Synth-enforceable | Runtime-observable |
| --- | --- | --- | --- |
| DD-1 stage throttling | **Mandatory** | Yes | No (config) |
| DD-2 direct-origin decision | **Mandatory** | Yes | No (config) |
| DD-3 denial telemetry replacement | **Mandatory** | Declaration: yes; emission: no | Yes (metric/log/access-log) |
| DD-4 edge presence gate | Optional | Offered | Yes |
| DD-5 WAF rate rules | Optional | Offered | Yes |

**Does AppTheory enforce the floor at synth time?** Yes for DD-1, DD-2, and the *declaration* half of DD-3 —
the construct throws, so a misconfigured `runtime-bearer` stack cannot deploy. No for DD-3's emission, DD-4,
and DD-5 — those are runtime/optional concerns pinned by fixtures and lab receipts instead.

## Open decisions

1. Whether `originReachability: direct` should be allowed at all under `runtime-bearer`, or whether the
   construct should require `disabled`/`locked` (recommend: allow `direct` with DD-1 + a receipt flag, because
   a locked origin is a CloudFront dependency an app may not want).
2. The exact bounded dimension set for `apptheory.mcp.auth_denied` (recommend: outcome + route family only).
3. Whether the access-log requirement is mandatory for `runtime-bearer` even when the runtime denial signal is
   declared (recommend: mandatory; it is the coarse availability signal).
