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

- Port every Lift construct immediately (focus on the top 20% first).

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

---

### D3 — Port “top 20%” constructs (if jsii path chosen)

**Acceptance criteria**
- A small, high-value set of constructs is implemented and documented (examples: API + Lambda defaults, queue processor,
  stream processor, alarm/monitoring defaults).
- Constructs are consumable in Go/TS/Py via jsii and are included in the release artifacts.
- Snapshot tests cover generated templates.

---

### D4 — Integration with runtime contract + prod features

**Acceptance criteria**
- Constructs/examples align with runtime contract invariants (headers/cookies/base64, error envelope, etc).
- Constructs enable recommended defaults for observability and security without relying on hidden configuration.

## Risks and mitigation

- **Constructs explosion:** enforce a “top 20% first” rule and require usage in an example for every construct.
- **Multi-language pain:** prefer jsii constructs so all languages share the same infra abstractions.
- **Synth drift:** pin CDK versions and add deterministic synth gates early.

