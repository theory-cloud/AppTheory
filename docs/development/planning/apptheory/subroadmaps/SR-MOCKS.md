# SR-MOCKS — Local Testkits + AWS Mocks (Go/TS/Py)

Goal: keep AppTheory “generative-coding friendly” and production-ready by providing a strong local testing story in each
language:

- deterministic time/randomness
- event builders / local invocation harness
- strict fakes/mocks for any AWS clients AppTheory wraps
- examples that require zero AWS credentials

## Scope

- Language-specific testkits (public API, documented)
- Deterministic clock/randomness injection points
- Mock/fake implementations for AWS SDK calls AppTheory makes (only for what AppTheory owns)

Non-goals:

- Full-featured local AWS emulation (LocalStack-style) unless it becomes necessary; prefer strict fakes for unit tests and
  DynamoDB Local only when required by integration semantics.

## Milestones

### K0 — Inventory AWS touchpoints (what AppTheory wraps)

**Acceptance criteria**
- A list exists of AWS clients AppTheory will wrap directly (if any) per language.
- Anything not wrapped is documented as user-space (and not part of AppTheory’s mocks).

---

### K1 — Determinism primitives (clock + randomness)

**Acceptance criteria**
- Each language runtime can inject:
  - a clock/`now()` provider
  - a randomness/ID provider
- Testkits expose helpers to fix time and deterministic IDs.

---

### K2 — Local invocation harness + event builders

**Acceptance criteria**
- Each language exposes helpers to build supported events (starting with HTTP/Lambda URL/APIGWv2).
- Each language supports local invocation without AWS credentials and without network calls.

---

### K3 — Strict fakes/mocks for AWS clients (owned surface)

**Acceptance criteria**
- Each language provides strict, expectation-driven fakes for the AWS clients it wraps.
- Tests can assert:
  - the exact API calls made
  - argument shapes
  - call counts
  - deterministic ordering where relevant

---

### K4 — Documentation + canonical examples

**Acceptance criteria**
- Each language’s docs include a full “unit test without AWS” example using the testkit.
- Examples run in CI without credentials.

## Risks and mitigation

- **Mock drift:** keep mocks small and strict; only mock what AppTheory owns.
- **Non-deterministic tests:** make determinism injectable by default; no hidden global time/entropy use in core code.

