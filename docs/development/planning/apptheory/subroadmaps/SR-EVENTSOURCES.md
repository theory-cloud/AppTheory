# SR-EVENTSOURCES — Lift Parity for Non-HTTP Triggers (SQS / EventBridge / DynamoDB Streams)

Goal: AppTheory MUST match Lift’s non-HTTP Lambda trigger support in **Go/TypeScript/Python**, including:

- `app.SQS(...)`
- `app.EventBridge(...)` (scheduled rules + EventBridge bus events)
- `app.DynamoDB(...)` (DynamoDB Streams)

This is required for Lift parity (see `docs/development/planning/apptheory/apptheory-gap-analysis-lesser.md`).

## Scope

- Runtime trigger detection + deterministic routing
- Canonical context fields and error envelope behavior for non-HTTP invocations
- Contract fixtures + runners (Go/TS/Py) for each trigger type
- Testkits:
  - event builders (SQS/EventBridge/DynamoDB Streams)
  - deterministic request-id generation/propagation (where applicable)
  - strict fakes for any AWS clients AppTheory owns for these paths
- CDK examples wiring the triggers into handlers in all three languages

Non-goals:

- Supporting every AWS event source in the same milestone (SNS/Kinesis/S3/etc) unless proven required by Lift usage
  inventories.

## Design requirements (Lift parity constraints)

- A single entrypoint (`HandleRequest` equivalent per language) MUST route:
  - HTTP events
  - SQS events
  - EventBridge events
  - DynamoDB stream events
- Trigger routing MUST be deterministic and testable without AWS.
- The runtime MUST expose the raw event payload to user code (even if a canonical wrapper also exists).
- Error behavior MUST be consistent and documented:
  - “unknown trigger” behavior
  - handler error mapping to the standard error envelope (or an explicitly different non-HTTP error policy, but consistent
    across languages)

## Milestones

### E0 — Inventory + contract shape decision

**Acceptance criteria**
- Each trigger type has an explicit contract shape:
  - what gets routed on (queue name, event source ARN, detail-type/source, table ARN, etc)
  - what is available on context (request-id, remaining time, metadata)
  - how errors are represented and surfaced to the Lambda runtime
- Parity matrix includes these features and marks them as required.

---

### E1 — SQS runtime parity

**Acceptance criteria**
- Go/TS/Py can register SQS handlers and route SQS events.
- Contract fixtures cover:
  - routing selector behavior (matching rules)
  - partial batch failure semantics (when used)
  - deterministic request-id rules (if set/derived)
- Testkits provide SQS event builders.

---

### E2 — EventBridge runtime parity

**Acceptance criteria**
- Go/TS/Py can register EventBridge handlers and route events deterministically.
- Contract fixtures cover:
  - routing selector behavior (rule name, source/detail-type matching)
  - scheduled rule defaults (where applicable)
- Testkits provide EventBridge event builders.

---

### E3 — DynamoDB Streams runtime parity

**Acceptance criteria**
- Go/TS/Py can register DynamoDB Stream handlers and route stream events deterministically.
- Contract fixtures cover:
  - routing selector behavior
  - record decoding invariants (at least what Lift exposes)
  - retry/partial failure behavior (where applicable)
- Testkits provide DynamoDB Streams event builders.

---

### E4 — End-to-end examples + rubric integration

**Acceptance criteria**
- A CDK example exists that deploys:
  - one SQS-triggered function per language
  - one EventBridge-scheduled function per language
  - one DynamoDB-stream-triggered function per language
- `make rubric` includes the new contract fixtures and example smoke tests.

