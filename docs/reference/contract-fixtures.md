---
title: Contract Fixtures
description: The 89 shared fixtures that arbitrate behavior across Go, TypeScript, and Python.
---

# Contract Fixtures

AppTheory ships **89 contract test fixtures** in `contract-tests/fixtures/` that define the language-neutral behavior every runtime must produce. The Go, TypeScript, and Python runtimes are each independently verified against the same fixture corpus on every commit.

This page explains what the fixtures are, what they cover, and how to evolve them safely.

## What the fixtures are

A contract fixture is a language-neutral description of a scenario:

- An input event (HTTP request, AppSync resolver event, SQS batch, MCP JSON-RPC message, etc.)
- An app configuration (registered routes, tier, error format, etc.)
- The expected output (response shape, status, headers, partial-batch failure list, MCP response, etc.)

Each fixture is loaded by language-specific runners that construct an AppTheory app from the configuration, invoke it with the input, and compare the output to the expected shape. **The fixture is the specification.** The runners are not — they are three independent test harnesses against the same source of truth.

## Why this matters

The single-path philosophy says there is one correct path per domain. The fixtures are how AppTheory enforces that across languages: if Go does something the fixture does not require, and TypeScript does something different, **neither is right** — they are both drifting from the contract.

When the contract needs to grow, the fixture grows first. When the fixture grows, **all three runtimes converge to the new shape in the same change.**

## Categories

The 89 fixtures span (counts approximate; see `contract-tests/fixtures/` for the canonical inventory):

| Category | Covers |
| --- | --- |
| HTTP routing | Method/path matching, parameter extraction, strict vs lenient registration, registration-order tie-breaking. |
| HTTP normalization | Header lower-casing, body decoding, query parsing, cookie handling. |
| HTTP error envelope | Nested vs flat-legacy shape, `error.code` / `error.message` / `error.details`, `request_id` propagation. |
| Middleware tiers | P0 / P1 / P2 inclusion sets, ordering, request-id, tenant, auth, CORS, guardrails. |
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
| MCP | Streamable HTTP transport (`POST/GET/DELETE /mcp`), protocol negotiation, session lifecycle, resumable SSE, JSON-RPC surface (`initialize`, `ping`, `tools/*`, `resources/*`, `prompts/*`, `notifications/*`). |
| OAuth | Protected-resource metadata, DCR, PKCE, bearer token validation, fail-closed `WWW-Authenticate` challenges. |
| Sanitization | Token-like value redaction, JSON/XML safe-logging output. |

## Running the fixtures

```bash
./scripts/verify-contract-tests.sh
```

This runs the Go, TypeScript, and Python runners against the full fixture corpus and fails if any runtime produces a divergent output. `make rubric` runs this gate as part of the full repo check, alongside lint, build, API snapshots, and example synthesis.

For single-runtime debugging:

```bash
go test ./contract-tests/...
(cd ts && npm run contract)
(cd py && python -m pytest contract-tests)
```

## Evolving the contract

Any change that affects cross-language behavior follows the same loop:

1. **Write or modify the fixture first.**
2. **Run the runners.** Confirm they fail in all three languages — and that they fail for the same reason. If only one language fails, the fixture is under-specified.
3. **Implement each runtime.** Go, TypeScript, and Python land in the same PR. Partial convergence is not a checkpoint.
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
- [MCP Method Surface](../integrations/mcp.md) — what the MCP fixtures pin
- [Development Guidelines](../development-guidelines.md) — the contract-only scope
