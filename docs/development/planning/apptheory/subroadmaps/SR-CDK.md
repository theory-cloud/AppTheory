# SR-CDK — CDK + Deployment Story (Examples → Constructs)

Goal: preserve and extend Lift’s CDK experience in a way that remains first-class for Go/TypeScript/Python users.

Strategy: ship a **deployable multi-language CDK example first**, then decide whether AppTheory ships reusable constructs
as a multi-language library (recommended: **jsii constructs authored in TypeScript**).

## Scope

- Deployable examples (CDK app that deploys Go/Node/Python functions)
- CDK verification gates (`cdk synth` pinned and deterministic)
- Constructs strategy decision:
  - TS-first jsii constructs (preferred for multi-language)
  - or documented Go-only constructs + examples/templates for TS/Py

Non-goals:

- Treating Lift parity as optional. AppTheory must provide construct parity for what our Lift apps actually use (at
  minimum: Pay Theory + Lesser inventories), and track any remaining Lift constructs explicitly until parity is complete.

## Current status (AppTheory `v0.2.0-rc.1`)

- A deployable multi-language CDK demo exists: `examples/cdk/multilang` (Go, Node.js 24, Python 3.14).
- Deterministic synth gate exists and fails closed: `./scripts/verify-cdk-synth.sh`.
- TS-first jsii constructs strategy is recorded (ADR): `docs/development/planning/apptheory/adr/0001-cdk-constructs-via-jsii.md`.
- Build/consumption gates are in CI: `./scripts/verify-cdk-constructs.sh`, `./scripts/verify-cdk-go.sh`,
  `./scripts/verify-cdk-python-build.sh`.
- Lift parity construct coverage includes an EventBus table construct for Autheory migrations:
  - `cdk/lib/eventbus-table.ts` (`AppTheoryEventBusTable`) provisions `pk/sk`, TTL, and the required GSIs
    (`event-id-index`, `tenant-timestamp-index`).

## Milestones

### D0 — Multi-language CDK demo (template quality)

**Acceptance criteria**
- A CDK example exists that deploys:
  - a Go handler built from the repo (bundled)
  - a Node.js 24 handler using the TS SDK
  - a Python 3.14 handler using the Py SDK
- The demo shares one contract-relevant configuration story (env vars, config parsing) across languages.
- `cdk synth` succeeds locally with documented prerequisites.

---

### D1 — Deterministic synth gate

**Acceptance criteria**
- A CI verifier runs `cdk synth` for the example(s) and fails on drift.
- CDK dependencies are pinned.
- The repo documents how to run synth locally.

---

### D2 — Constructs strategy decision (ADR)

**Acceptance criteria**
- Decision doc exists choosing one of:
  - `jsii` constructs in TypeScript (multi-language consumption)
  - Go-only constructs for now (with a clear rationale and a future plan)
- Decision includes:
  - how constructs are tested (snapshot tests)
  - how constructs are versioned with the repo
  - how constructs are distributed (GitHub Releases only)

Decision: `docs/development/planning/apptheory/adr/0001-cdk-constructs-via-jsii.md`

---

### D3 — Port required Lift constructs (if jsii path chosen)

**Acceptance criteria**
- Constructs required by the Lift usage inventories are implemented and documented (examples include):
  - API Gateway REST API v1 (with method-level streaming toggles for SSE)
  - API Gateway v2 WebSocket API wiring helpers (or a first-class example + shared helpers)
  - SQS queue + DLQ patterns used by processors
  - DynamoDB stream event source mappings
  - EventBridge schedule → Lambda wiring
  - sane Lambda defaults wrapper (runtime/arch/logging/alarms)
- Constructs are consumable in Go/TS/Py via jsii and are included in the release artifacts.
- Snapshot tests cover generated templates.

---

### D4 — Integration with runtime contract + prod features

**Acceptance criteria**
- Constructs/examples align with runtime contract invariants (headers/cookies/base64, error envelope, etc).
- Constructs enable recommended defaults for observability and security without relying on hidden configuration.

## Risks and mitigation

- **Constructs explosion:** scope constructs to what our Lift apps use first; require usage in an example for every
  construct.
- **Multi-language pain:** prefer jsii constructs so all languages share the same infra abstractions.
- **Synth drift:** pin CDK versions and add deterministic synth gates early.
