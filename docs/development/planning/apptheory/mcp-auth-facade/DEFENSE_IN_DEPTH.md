# Defense-in-depth floor for runtime-validated bearer (M0, item 4)

Status: mandatory floor for review (M0).
Last updated: 2026-10-12
Owner: AppTheory

ADV-P110-1 requires the plan gate to produce a **mandatory floor**, not a menu, for the `runtime-bearer` (and
`none-public`) postures. Under those postures the API Gateway transport route authorizer is `NONE`, so every
request — including a credential-free one — is forwarded to the Lambda. The runtime still fails closed (401 +
RFC 9728 challenge, no handler invocation), but the **invocation** happens, which is a cost-amplification and
an unbounded unauthenticated surface unless the floor below is in place.

This floor is mandatory **for `runtime-bearer` and for `none-public`**, and does not apply to `iam`/`jwt` (the
gateway rejects before the runtime). DD-1 (throttling) and DD-2 (origin reachability) apply to both postures.
**DD-3 (denial telemetry) applies to `runtime-bearer` only**: `none-public` performs no validation, so it
produces no auth denials and has nothing to signal — its only signal is the API Gateway access log.

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
  origin** with concrete, in-stack mutual-TLS evidence on the custom domain that fronts the API.
- **Why:** runtime bearer is fail-closed per request, but direct reachability changes who can reach that gate
  and whether the edge restoration/throttle path applies. It must be a decided, recorded posture — not an
  accident of deployment shape, and not an assertion the construct cannot verify.
- **How:** a required `originReachability` decision on the construct (`disabled` | `locked`), enforced against the
  resources the construct can inspect:
  - owned `disabled`: requires the effective `ownedApi.domain` (an ordinary domain, no mTLS), emits
    `DisableExecuteApiEndpoint: true`, and advertises only the custom-domain authority. Final synthesis rejects a
    later L1 re-enable; a disabled execute-api endpoint is never advertised.
  - owned `locked`: additionally requires `ownedApi.domain.mutualTlsAuthentication` and a final whole-stack proof
    that the default endpoint stays disabled and every `AWS::ApiGatewayV2::ApiMapping` bound to the owned API
    resolves to an in-stack `AWS::ApiGatewayV2::DomainName` carrying
    `MutualTlsAuthentication.TruststoreUri`. An additional ordinary domain, removed mTLS, a re-enabled endpoint,
    or unresolvable mapping/domain evidence fails synthesis. LOCKED is therefore an ingress-enforcement model,
    not an alias of DISABLED and not a CloudFront/VPC-origin assertion.
  - attach mode: `LOCKED` is unsupported because an API owned outside the construct carries no in-stack lock
    evidence. `DISABLED` is accepted only on a same-stack concrete `HttpApi` whose emitted
    `DisableExecuteApiEndpoint` resolves to literal `true`; imported APIs and assertion-only external front doors
    fail.
  - Supplying `mutualTlsAuthentication` without owned `LOCKED` fails as contradictory rather than silently
    changing the declared posture.
- **Operator decision (2026-10-12), security-lean:** a directly reachable origin (`direct`) is **not** allowed
  under `runtime-bearer` or `none-public`; the construct refuses it at synthesis. The CDK-owner M5 selection
  (owned mutual-TLS domain) supplies the concrete LOCKED model; it does not reopen that decision.
- **Enforceable at synth:** yes (source validation plus final whole-stack resource proof).

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
| DD-3 denial telemetry replacement (`runtime-bearer` only) | **Mandatory** | Declaration: yes; emission: no | Yes (metric/log/access-log) |
| DD-4 edge presence gate | Optional | Offered | Yes |
| DD-5 WAF rate rules | Optional | Offered | Yes |

**Does AppTheory enforce the floor at synth time?** Yes for DD-1, DD-2, and the *declaration* half of DD-3 —
the construct throws, so a misconfigured `runtime-bearer` stack cannot deploy. No for DD-3's emission, DD-4,
and DD-5 — those are runtime/optional concerns pinned by fixtures and lab receipts instead.

## Open decisions

1. ~~Whether `originReachability: direct` should be allowed at all under `runtime-bearer`~~ — **decided (operator,
   2026-10-12, security-lean): `direct` is NOT allowed; only `disabled` or `locked` synthesize.** Recorded in DD-2
   above and implemented in `cdk/lib/mcp-server.ts`.
2. The exact bounded dimension set for `apptheory.mcp.auth_denied` — **decided (operator, 2026-10-12): outcome +
   route family only**; the construct pins exactly `["outcome","route_family"]`.
3. Whether the access-log requirement is mandatory for `runtime-bearer` even when the runtime denial signal is
   declared — **decided (operator, 2026-10-12): mandatory**; it is the coarse availability signal.
