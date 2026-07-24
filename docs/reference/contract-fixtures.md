---
title: Contract Fixtures
description: "The 224 contract fixtures: Go, TypeScript, and Python execute all MCP, OAuth, and objectstore fixtures." # apptheory-fixture-count: 224
---

# Contract Fixtures

AppTheory ships **224 contract test fixtures** in `contract-tests/fixtures/`. <!-- apptheory-fixture-count: 224 --> Go, TypeScript, and Python execute the full fixture corpus on every commit, including the `tier: mcp` SP09 runtime contracts, the `tier: oauth` SP12 protected-resource, bearer, DCR, and PKCE contracts, and the `tier: objectstore` SP13 bounded object-store contract.

This page explains what the fixtures are, what they cover, and how to evolve them safely.

## What the fixtures are

A contract fixture is a language-neutral description of a scenario:

- An input event (HTTP request, AppSync resolver event, SQS batch, Kinesis batch, and similar Lambda event shapes)
- An app configuration (registered routes, tier, error format, event-source bindings, etc.)
- The expected output (response shape, status, headers, partial-batch failure list, normalized summary, etc.)

For implemented tiers, each fixture is loaded by language-specific runners that construct an AppTheory app from the configuration, invoke it with the input, and compare the output to the expected shape. The SP09 MCP tier and SP12 OAuth tier are now executed by Go, TypeScript, and Python. **The fixture is the specification.** The runners are not — they are independent test harnesses against the same source of truth.

## Why this matters

The single-path philosophy says there is one correct path per domain. The fixtures are how AppTheory enforces that across languages: if Go does something the fixture does not require, and TypeScript does something different, **neither is right** — they are both drifting from the contract.

When the shared runtime contract needs to grow, the fixture grows first. For shared surfaces, **all three runtimes converge to the new shape in the same change.** If a fixture tier is deliberately staged as a future runtime leg, that staging must be visible in the fixture tier and runner output; it is not parity proof until the remaining runtimes execute it.

## Behavior-domain layout

The fixture files are grouped by behavior domain, while each fixture keeps the historical P/M tier or milestone in
its `tier` field and stable `id`. Directory names are organizational metadata, not an alternate contract ID.

| Directory | Fixture metadata | Covers |
| --- | --- | --- |
| `http-core/` | `p0.*` / `tier = p0` | P0 runtime core: request/response normalization, source provenance, Lambda URL/ALB adapters, and baseline routing. |
| `binding/` | `p0.binding.*` / `tier = p0` | Canonical typed-handler body/query/path/header binding, conversions, strict JSON, and binding-error envelopes. |
| `validation/` | `p0.validation.*` / `tier = p0` | Declarative validation vocabulary, canonical 422 field-error envelope, and binding/validation precedence. |
| `errors/` | `p0.errors.*` / `tier = p0` | Canonical framework error envelopes, panic recovery, 404/405, and Lift flat-legacy JSON parse compatibility. |
| `routing/` | `p0.routing.*` / `tier = p0` | Fail-closed route registration setup errors for duplicate routes, invalid patterns, and nil/undefined/None handlers. |
| `openapi/` | `p0.openapi.*` / `tier = p0` | Descriptive OpenAPI generation and byte-pinned canonical JSON output. |
| `middleware-guardrails/` | `p1.*` / `tier = p1` | P1 request-id, tenant, auth, CORS, guardrails, and legacy flat-error behavior. |
| `appsync-observability-policies/` | `p2.*` / `tier = p2` | P2 AppSync, observability, logging profiles, rate limiting, and load shedding. |
| `observability/` | `p2.*` / `tier = p2` | Request-duration observability records and first-party CloudWatch EMF metric JSON lines. |
| `mcp/` | `mcp.*` / `tier = mcp` | SP09 MCP protocol, registry, session, Streamable HTTP, resumable SSE, and task-store contracts executed by Go, TypeScript, and Python. |
| `oauth/` | `oauth.*` / `tier = oauth` | SP12 OAuth protected-resource metadata, bearer expiry/audience/scope validation, dynamic client registration, and PKCE contracts executed by Go, TypeScript, and Python. |
| `objectstore/` | `objectstore.*` / `tier = objectstore` | SP13 bounded object-store Put, capped Get, Delete, deterministic fake behavior, and forbidden operation errors executed by Go, TypeScript, and Python. |
| `event-sources/` | `m1.*` / `tier = m1` | SQS, EventBridge, DynamoDB Streams, Kinesis, SNS, and non-HTTP middleware behavior. |
| `websockets/` | `m2.*` / `tier = m2` | API Gateway WebSockets and management client fakes. |
| `api-gateway-rest-sse/` | `m3.*` / `tier = m3` | API Gateway REST v1, Remote MCP path normalization, and SSE. |
| `middleware-timeout-sse/` | `m12.*` / `tier = m12` | Middleware ctx bag, timeout, naming, and SSE streaming extensions. |
| `edge-streaming-html/` | `m14.*` / `tier = m14` | Streaming, catch-all routing, HTML/cache/CloudFront helpers, and Step Functions helpers. |
| `microvm-foundation/` | `m15.*` / `tier = m15` | Lambda MicroVM validation-only lifecycle/controller/session vocabulary. |
| `microvm-operations/` | `m16.*` / `tier = m16` | Real Lambda MicroVM operations, routes, provider-state mappings, tenant boundaries, and token safety. |

## Categories

The 224 fixtures span these behavior areas (counts approximate; see `contract-tests/fixtures/` for the canonical inventory). Go, TypeScript, and Python execute all 224 fixtures, including MCP, OAuth, and objectstore. <!-- apptheory-fixture-count: 224 -->

| Category | Covers |
| --- | --- |
| HTTP routing | Method/path matching, parameter extraction, fail-closed route registration, and registration-order tie-breaking. |
| HTTP normalization | Header lower-casing, body decoding, query parsing, cookie handling. |
| HTTP error envelope | Nested vs flat-legacy shape, `error.code` / `error.message` / `error.details`, `request_id` propagation. |
| Typed handlers | Body/query/path/header binding, typed conversion, strict unknown-field rejection, and binding-error details. |
| Declarative validation | Required/min/max/length/pattern/enum rules, canonical 422 status, field-error aggregation, and binding precedence. |
| OpenAPI | Descriptive OpenAPI 3.1 output generated from an explicit OpenAPISpec covering route, binding, response, and validation metadata. |
| Middleware tiers | P0 / P1 / P2 inclusion sets, ordering, request-id, tenant, auth, CORS, guardrails. |
| Observability | P2 request duration records and the blessed CloudWatch EMF request count/duration/error metric line. |
| Source provenance | `SourceProvenance` shape, canonical IP form, fail-closed `provider = "unknown"`. |
| Lambda Function URL | Streaming vs buffered, request shape, response headers. |
| API Gateway v2 | Event shape, route key, response shape, cookies. |
| API Gateway v1 (REST proxy) | Lift-compatible event/response shapes. |
| AppSync resolver | `Mutation -> POST`, `Query -> GET`, identity/source/prev/stash projection, error payload shape. |
| WebSocket | Connection ID dispatch, `$connect` / `$disconnect` / `$default` routes. |
| SQS | Partial-batch failure shape, batch ID propagation. |
| EventBridge | Envelope normalization, correlation-id, scheduled-event metadata. |
| DynamoDB Streams | Partial-batch response, record safe-summary shape. |
| Kinesis | Partial-batch response, stream routing, fail-closed for unregistered streams, CloudWatch Logs subscription envelope decoding. |
| Remote MCP path dispatch | API Gateway REST proxy path normalization for Remote MCP and protected-resource metadata routes. These HTTP-adapter fixtures are separate from the MCP and OAuth runtime tiers. |
| MCP JSON-RPC and Streamable HTTP | The `mcp/` fixture tier pins `initialize`, JSON-RPC envelopes, tools/resources/resource-templates/prompts registries, session lifecycle, Streamable HTTP framing, resumable SSE replay, and task-store behavior across Go, TypeScript, and Python. |
| OAuth protected resources | The `oauth/` fixture tier pins RFC 9728 protected-resource metadata, bearer `WWW-Authenticate` challenges, expiry/audience/scope denial semantics, DCR public-client constraints, and PKCE S256 verification across Go, TypeScript, and Python. Missing/expired bearer tokens are `401` challenge cases; invalid audience and insufficient scope are `403 app.forbidden` without a challenge. |
| Sanitization | Token-like value redaction, JSON/XML safe-logging output. |
| Object store | The `objectstore/` fixture tier pins strict object refs, Put, bounded Get, Delete, deterministic fake call logs, and forbidden list/presign/multipart operations across Go, TypeScript, and Python. |
| Lambda MicroVM support | M15 foundation fixtures plus M16 real operations `run/get/list/suspend/resume/terminate/invoke/auth-token/shell-auth-token`, provider-state mappings, protected controller routes, token-hidden workload invoke, endpoint-dispatched no-hook example images, deployment execution-role propagation, tenant-bound list/recovery, token no-leak denial, and raw SDK/lifecycle bypass denial. The feature line is evidence-bounded to repo-local runtime/CDK/example/conformance harness proof plus verified example-path live smoke, not EqualToAI/Host, customer workload, arbitrary cloud mutation, or unauthenticated-controller proof. |

## Running the fixtures

```bash
./scripts/verify-contract-tests.sh
```

This validates the fixture schema for all 224 files and runs the Go, TypeScript, and Python runners against the same fixture tree. `make rubric` runs this gate as part of the full repo check, alongside lint, build, API snapshots, and example synthesis.

For single-runtime debugging from the repository root:

```bash
go run ./contract-tests/runners/go
node contract-tests/runners/ts/run.cjs
python3 contract-tests/runners/py/run.py
```

The TypeScript runner expects dependencies to be installed first; `./scripts/verify-contract-tests.sh` runs `(cd ts && npm ci)` before invoking it.

## Evolving the contract

Any change that affects cross-language behavior follows the same loop:

1. **Write or modify the fixture first.**
2. **Run the runners.** For shared surfaces, confirm they fail in all three languages — and that they fail for the same reason. If only one language fails, the fixture is under-specified.
3. **Implement each runtime.** For shared surfaces, Go, TypeScript, and Python land in the same PR. Partial convergence is not a checkpoint. A deliberately staged future-runtime tier must name the staged runtime work and report explicit runner skips until the remaining runtimes execute it.
4. **Update the API snapshot.** If the public surface moved, run `./scripts/update-api-snapshots.sh` and commit the diff alongside the fixture change.
5. **Verify.** `make rubric` must pass.

What you do **not** do:

- Mark a fixture as language-specific. "Known failing in Python" is a contract bug, not a state.
- Add behavior to a runtime without a fixture. If it's not in the fixture, it isn't part of the contract.
- Disable contract tests to unblock a PR. The contract tests existing as a gate is the whole point.
- Add a flag that bypasses the contract for one caller. Bypasses fragment the framework.

## API snapshots

`api-snapshots/*.txt` captures the exported public API in each language:

- `api-snapshots/go.txt` — exports from `runtime/`, `pkg/`, `testkit/`.
- `api-snapshots/ts.txt` — exports from `ts/dist/index.d.ts`.
- `api-snapshots/py.txt` — exports from `py/src/apptheory/__init__.py` and `py/src/apptheory/limited/__init__.py`.

Snapshot diffs are intentional signals: a moved snapshot says "a public contract changed." Regenerate via `./scripts/update-api-snapshots.sh` and commit the result alongside the change that caused it.

## Related

- [HTTP Runtime](../features/http-runtime.md) — what the HTTP fixtures pin
- [Event Shape Dispatch](event-shapes.md) — what `HandleLambda` detection fixtures pin
- [AWS Lambda MicroVM Golden Path](../features/lambda-microvm-contract-foundation.md) — the corrective M16 MicroVM
  golden path and evidence boundary
- [MCP Method Surface](../integrations/mcp.md) — MCP behavior pinned by the `mcp/` fixture tier across Go, TypeScript, and Python
- [Development Guidelines](../development-guidelines.md) — the contract-only scope
