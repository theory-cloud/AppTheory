# SR-APPSYNC — Full AppSync Resolver Support + Lift Compatibility

Goal: AppTheory MUST support standard AWS AppSync Lambda resolver events in Go/TypeScript/Python with Lift-compatible
runtime behavior, while also meeting the operational needs described in issue `#248`.

For this workstream, `pay-theory/lift` is the authoritative legacy reference for behavior that already existed. Issue
`#248` is input on the required problem to solve, but not the sole spec.

## Scope

- Standard AppSync Lambda resolver event detection in the universal Lambda dispatcher for Go/TS/Py
- Explicit AppSync runtime entrypoints:
  - Go: `ServeAppSync(...)`
  - TypeScript: `serveAppSync(...)`
  - Python: `serve_appsync(...)`
- Portable AppSync event models and testkit builders owned by AppTheory
- AppSync request adaptation into AppTheory routing semantics
- Typed AppSync request context exposure (`AsAppSync()` equivalent in Go/TS/Py)
- Lift-compatible AppSync success and error response behavior
- Contract fixtures, unit tests, API snapshots, and migration docs

Non-goals:

- AppSync schema generation
- AppSync client SDKs
- VTL/request-mapping-template generation or authoring tools
- AppSync Lambda authorizer support unless Lift-usage inventory proves it is required
- First-party AppSync CDK constructs in this milestone set; a documented wiring example is sufficient

## Locked decisions

These decisions are locked unless a later design review explicitly reopens them.

- Legacy compatibility reference: `github.com/pay-theory/lift`
- Canonical trigger spelling: `appsync`
- AppTheory owns its own AppSync resolver event models; do not depend on deprecated `aws-lambda-go` resolver template
  types
- AppSync support is a first-class runtime surface, not an undocumented `HandleLambda` special case
- Universal dispatchers MUST route AppSync events into explicit AppSync entrypoints
- AppSync metadata MUST be exposed through a typed request-context surface (`AsAppSync()`), not only ad hoc context keys
- AppSync request bodies adapted from `arguments` MUST synthesize `content-type: application/json` when absent
- AppSync success responses MUST return resolver payloads, not HTTP proxy envelopes
- AppSync error responses MUST use Lift-compatible AppSync error envelopes
- Final exit criteria require parity in Go/TS/Py, even if implementation lands in stages

## Confirmed legacy behavior to preserve

Verified from Lift's AppSync adapter and AppSync-specific app behavior:

- Detection is based on standard resolver event shape:
  - `info.fieldName`
  - `info.parentTypeName`
  - `arguments`
- Routing semantics:
  - `Mutation -> POST`
  - `Query -> GET`
  - `Subscription -> GET`
  - `fieldName -> /fieldName`
- Request shaping:
  - top-level `arguments` are serialized as the request body
  - `request.headers` are forwarded as request headers
  - metadata includes `fieldName`, `parentTypeName`, `variables`, `identity`, and `source`
- Trigger identity:
  - AppSync trigger type is `appsync`
- Success behavior:
  - the resolver receives the unwrapped response payload, not an API Gateway-style envelope
- Error behavior:
  - AppSync requests return a Lift-style error object with:
    - `pay_theory_error`
    - `error_message`
    - `error_type`
    - `error_data`
    - `error_info`

## AppTheory-specific compatibility decisions

Lift did not define every behavior AppTheory now needs because AppTheory's response model is more HTTP-centric. These
decisions close the gaps while preserving Lift behavior wherever it existed.

- Request ID for AppSync error responses SHOULD come from Lambda context request ID when available.
- AppSync response projection MUST convert AppTheory's canonical `Response` into a resolver payload:
  - `application/json` bodies are decoded back into native values
  - `text/*` bodies return UTF-8 strings
  - empty bodies return `null`
  - binary and streaming bodies are rejected with a deterministic AppSync system error unless a later milestone adds
    explicit support
- Successful non-error responses follow Lift semantics:
  - body value is returned
  - HTTP status code does not become an AppSync transport concept
- Raw AppSync event payload MUST remain available to user code in all languages.

## Design requirements

- Detection MUST support the AWS-native direct Lambda data source event shape without requiring request mapping template
  changes.
- AppSync support MUST not regress existing `HandleLambda` behavior for:
  - API Gateway v2
  - Lambda Function URL
  - API Gateway REST v1
  - ALB
  - WebSockets
  - SQS
  - Kinesis
  - SNS
  - EventBridge
  - DynamoDB Streams
- AppSync routing MUST be deterministic and testable without AWS.
- The same AppSync fixture inputs MUST produce equivalent behavior in Go/TS/Py.
- Migration docs MUST describe AppSync as a supported Lift-compatibility path once shipped.

## Current status (main as of March 11, 2026)

- AppTheory does not currently recognize AppSync resolver events in:
  - `runtime/aws_eventsources.go`
  - `ts/src/app.ts`
  - `py/src/apptheory/app.py`
- AppTheory docs currently omit AppSync from supported `HandleLambda` trigger coverage.
- Lift already has AppSync-specific behavior in:
  - `pkg/lift/adapters/appsync.go`
  - AppSync-specific app error handling in `pkg/lift/app.go`
- AppTheory's current `Response` model stores bodies as bytes, so full AppSync compatibility requires explicit response
  projection logic rather than only adding a new dispatcher branch.

## Milestones

### A0 — Legacy inventory + formal AppSync spec

**Acceptance criteria**
- Lift's real AppSync behavior is documented from source, including:
  - detection rules
  - request adaptation rules
  - success response behavior
  - error envelope behavior
- This roadmap is treated as the formal AppSync compatibility spec for AppTheory.
- The following unresolved policies are explicitly locked in writing:
  - request-id policy
  - response projection rules
  - unsupported binary/streaming policy
  - AppSync Lambda authorizer non-goal unless usage inventory changes
- Parity matrix and migration references point at this roadmap as the AppSync plan of record.

**Deliverables**
- `docs/development/planning/apptheory/subroadmaps/SR-APPSYNC.md`
- follow-on doc references from planning index and parity docs

---

### A1 — Public AppSync event model + explicit entrypoints

**Acceptance criteria**
- Go/TS/Py expose first-class AppSync resolver event types in their public API surfaces.
- Go exposes `ServeAppSync`.
- TS exposes `serveAppSync`.
- Py exposes `serve_appsync`.
- Public API snapshots are updated for all three languages.
- AppSync support is no longer discoverable only by reading dispatcher internals.

**Deliverables**
- Go runtime exported AppSync types and entrypoint
- `ts/src/aws-types.ts`, `ts/src/index.ts`, `ts/dist/*`
- `py/src/apptheory/aws_events.py`, `py/src/apptheory/__init__.py`
- `api-snapshots/go.txt`
- `api-snapshots/ts.txt`
- `api-snapshots/py.txt`

---

### A2 — Universal dispatcher detection + request adaptation parity

**Acceptance criteria**
- `HandleLambda` / `handleLambda` / `handle_lambda` recognize standard AppSync resolver events using:
  - `info.fieldName`
  - `info.parentTypeName`
  - `arguments`
- Detection does not create false positives for existing trigger types.
- Request adaptation matches Lift semantics:
  - `Mutation -> POST`
  - `Query -> GET`
  - `Subscription -> GET`
  - path = `"/" + fieldName`
  - body = JSON-encoded `arguments`
  - request headers copied from `request.headers`
- Adapted requests synthesize `content-type: application/json` when absent.
- Preserved metadata includes:
  - `identity`
  - `source`
  - `info.variables`
  - `stash`
  - `prev`
  - raw event

**Deliverables**
- `runtime/aws_eventsources.go`
- `ts/src/app.ts`
- `py/src/apptheory/app.py`
- new unit tests in Go/TS/Py for AppSync detection and adaptation

---

### A3 — Typed AppSync context surface

**Acceptance criteria**
- Go/TS/Py provide an AppSync-specific typed context surface analogous to `AsWebSocket()`.
- The context surface exposes at minimum:
  - field name
  - parent type name
  - arguments
  - identity
  - source
  - variables
  - stash
  - prev
  - raw event
  - request headers
- Handlers can reach this metadata without parsing raw event blobs.
- Context APIs are aligned closely enough that contract fixtures can assert the same portable behavior across languages.

**Deliverables**
- `runtime/context.go`
- `ts/src/context.ts`
- `py/src/apptheory/context.py`
- context-focused tests in Go/TS/Py

---

### A4 — AppSync success response projection

**Acceptance criteria**
- AppSync requests return resolver payloads, not HTTP proxy envelopes.
- Projection rules are implemented and tested:
  - JSON response body -> decoded native value
  - text response body -> UTF-8 string
  - empty body -> `null`
  - binary body -> deterministic unsupported error
  - body stream -> deterministic unsupported error
- AppTheory JSON helpers remain usable for AppSync handlers because request adaptation provides a JSON content type.
- Successful AppSync responses preserve Lift semantics even though AppTheory internally uses canonical HTTP `Response`
  objects.

**Deliverables**
- Go/TS/Py AppSync response projection logic
- tests covering JSON, text, empty, binary, and streaming cases

---

### A5 — Lift-compatible AppSync error semantics

**Acceptance criteria**
- AppSync requests return a Lift-compatible AppSync error object on handler errors.
- Error envelope fields are present and deterministic:
  - `pay_theory_error`
  - `error_message`
  - `error_type`
  - `error_data`
  - `error_info`
- `error_type` matches Lift-compatible classification:
  - 4xx -> `CLIENT_ERROR`
  - 5xx and unexpected failures -> `SYSTEM_ERROR`
- Error enrichment includes, when available:
  - request ID
  - error code
  - details
  - path
  - method
  - trigger type
- Existing non-AppSync error behavior remains unchanged for all other trigger types.

**Deliverables**
- AppSync-specific error mapping in Go/TS/Py runtime error paths
- tests for:
  - portable AppTheory errors
  - AppError/client-safe errors
  - unexpected errors
  - request-id propagation

---

### A6 — Testkit builders + shared contract fixtures

**Acceptance criteria**
- Go/TS/Py testkits expose AppSync event builders and invoke helpers.
- Shared fixtures cover:
  - standard mutation event
  - standard query event
  - standard subscription event
  - missing `info.fieldName` is not treated as AppSync
  - header passthrough
  - metadata preservation (`identity`, `source`, `variables`, `stash`, `prev`)
  - Lift-compatible error formatting
  - unsupported binary/streaming response behavior
- Contract runners pass the same AppSync fixtures in Go/TS/Py.

**Deliverables**
- `testkit/event_sources.go`
- `ts/src/testkit.ts`
- `py/src/apptheory/testkit.py`
- `contract-tests/fixtures/*` for AppSync
- contract runners updated to execute the new fixtures

---

### A7 — Documentation, migration guidance, and examples

**Acceptance criteria**
- Public docs list AppSync as a supported AppTheory runtime capability.
- Lift migration docs explain:
  - standard AppSync event support
  - Lift-compatible success/error behavior
  - differences that remain out of scope
- API reference documents the explicit AppSync entrypoints and event models.
- A documented example shows how to wire an AppSync Lambda resolver to an AppTheory app without request mapping
  template changes.

**Deliverables**
- `docs/migration/from-lift.md`
- `docs/api-reference.md`
- planning index updates
- example or recipe doc for AppSync Lambda resolver wiring

---

### A8 — Rubric integration + release gate

**Acceptance criteria**
- `make rubric` or the equivalent repo gate exercises AppSync runtime coverage through unit and contract tests.
- API snapshots are updated in the same change that exposes AppSync public APIs.
- Release notes guidance calls out AppSync support as a Lift-compatibility milestone.
- The workstream is not considered complete until Go/TS/Py all pass the shared AppSync fixtures.

**Deliverables**
- rubric/test integration updates
- release-note and migration-note updates as needed

## Recommended implementation sequence

1. A0
2. A1
3. A2
4. A3
5. A4
6. A5
7. A6
8. A7
9. A8

Pragmatic merge strategy:

- PR 1 may land Go runtime support first if needed to unblock production migration work.
- The roadmap is not complete until TS and Py parity land and the shared fixtures pass in all three languages.

## Risks and mitigation

- **False confidence from issue-driven implementation:** use Lift source and this roadmap as the compatibility spec, not
  just issue `#248`.
- **Response-model mismatch:** AppTheory stores response bodies as bytes; lock and test AppSync response projection before
  claiming parity.
- **Silent metadata loss:** add typed AppSync context APIs and contract fixtures for preserved fields.
- **Behavior drift across languages:** require shared fixtures and API snapshot updates.
- **Undocumented edge cases:** lock unsupported binary/streaming behavior explicitly and fail deterministically.
- **Scope creep into AppSync infra/features:** keep schema generation, client SDKs, and authorizers out of scope unless
  usage evidence demands expansion.

## Exit criteria

This workstream is complete only when all of the following are true:

- Go/TS/Py support standard AppSync resolver events through explicit runtime entrypoints and universal dispatchers
- AppTheory exposes a typed AppSync context surface in all three languages
- Success and error behavior match Lift compatibility targets
- Testkits and shared contract fixtures cover AppSync end to end
- Public docs and migration guides treat AppSync as a supported Lift-compatibility path
