# SR-SERVICES — Lift `pkg/services` Parity (Start: EventBus)

Goal: AppTheory must replace Lift’s `pkg/services` surface area required by Pay Theory (starting with Autheory’s EventBus
usage) while preserving AppTheory’s multi-language + supply-chain posture.

This is Lift parity work, not optional: Autheory depends on Lift’s EventBus in production.

## Scope

- EventBus (durable event storage + query) parity:
  - DynamoDB-backed EventBus (Lift: `NewDynamoDBEventBus`)
  - Memory EventBus (tests)
  - Event model and query model compatibility
- Strict fakes/mocks for any AWS clients AppTheory wraps
- Migration documentation for Autheory (Lift EventBus → AppTheory EventBus)

Potential later scope (only after a real app proves it):

- SQS large payload helpers (`pkg/services/sqs_large_payload`)
- Service registry / discovery helpers
- Load balancer helpers
- Governance tagging helpers (if needed outside CDK)

Non-goals:

- A full re-implementation of Lift’s entire `pkg/services` package without a concrete migration target.

## Design constraints

- **No long-lived registry tokens:** distribution remains GitHub Releases only.
- **Prefer TableTheory for DynamoDB access** where it reduces duplication and supports Go/TS/Py, unless a lower-level AWS
  SDK implementation is required for correctness.
- **Portability must be explicit:** if EventBus cannot be made portable across Go/TS/Py in the first pass, ship Go-only
  first but document the boundary and keep the API stable for eventual portability.

## Milestones

### S0 — Inventory and scope lock (Autheory-focused)

**Acceptance criteria**
- A feature-level inventory exists of what Autheory uses from `lift/pkg/services`:
  - constructors used
  - methods called
  - query patterns
  - any required secondary features (checkpointing, schedule helpers, etc)
- A portability decision exists for EventBus:
  - portable API (Go/TS/Py) vs Go-only first

---

### S1 — Event model + query model (contracted surface)

**Acceptance criteria**
- AppTheory defines a stable Event model and EventQuery model sufficient to migrate Autheory.
- Unit tests cover deterministic serialization and filtering behavior.

---

### S2 — Memory EventBus (tests)

**Acceptance criteria**
- A memory-backed EventBus exists and supports the query patterns Autheory tests rely on.
- Tests are deterministic and require no AWS credentials.

---

### S3 — DynamoDB EventBus (production parity)

**Acceptance criteria**
- A DynamoDB-backed EventBus exists with the required methods and sane defaults.
- Any AWS client usage is mockable with strict fakes.
- A minimal integration test strategy exists (unit tests preferred; DynamoDB Local only if required).

---

### S4 — Autheory migration guide + representative migration

**Acceptance criteria**
- AppTheory includes Autheory-focused migration guidance:
  - mapping table (Lift EventBus → AppTheory EventBus)
  - behavior differences (if any) are explicit
- A representative Autheory component can be migrated in a controlled branch (outside this repo), with lessons recorded
  back into AppTheory docs.

## Risks and mitigation

- **Scope explosion:** keep SR-SERVICES anchored to Autheory needs; do not port unused Lift services “just in case”.
- **Portability pressure:** if EventBus is too hard to make portable immediately, ship Go-only with a clear interface and
  document the plan to extend.

