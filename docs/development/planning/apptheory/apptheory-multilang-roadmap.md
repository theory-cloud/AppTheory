# AppTheory: Multi-language Roadmap (Go + TypeScript + Python)

Goal: create **AppTheory** in `theory-cloud` as a **first-class** serverless application framework for **Go, TypeScript, and
Python**, informed by Lift, with **TableTheory-style distribution** (GitHub Releases only) and **fixture-driven drift
prevention** (a versioned runtime contract + contract tests).

This is a roadmap, not an API promise. The hard constraint is that multi-language AppTheory only works if we treat core
runtime behavior as a **versioned contract** and verify it continuously.

## Non-negotiables

- **No Lift repo move:** `pay-theory/lift` stays where it is. AppTheory is a new repo in `theory-cloud`.
- **First-class languages:** Go/TS/Py are peers. No “official language” plus two “ports”.
- **GitHub Releases only:** no npm/PyPI publishing; avoid long-lived registry tokens.
- **Contract over convenience:** core behavior is specified and fixture-tested; implementations must match.
- **CDK + mocks matter:** preserve Lift’s “ship-ready” experience by providing deployable templates and local testing tools.

## Definition of “first-class”

Each language is “first-class” when it has all of the following:

- An idiomatic public API (types, errors, conventions) that does not look like a translation.
- A complete quickstart that works from release assets (no registry publishing).
- A supported local testing story: event builders + deterministic time/randomness + strict fakes/mocks for any AWS clients
  AppTheory wraps.
- Contract tests passing (same fixtures).
- A maintained docs set and at least one deployable example.

## Parity tiers (portable surface area)

AppTheory parity is tracked by tier so scope remains explicit:

- **P0 (Runtime core):** HTTP event adapters + routing + request/response normalization + error envelope + validation rules.
- **P1 (Context + middleware):** request-id, auth hooks, tenant extraction, CORS, size/time guardrails, middleware ordering.
- **P2 (Prod features):** observability (logs/metrics/traces), rate limiting / load shedding semantics, policy hooks, “safe by
  default” controls.

Parity tracking document:

- `docs/development/planning/apptheory/supporting/apptheory-parity-matrix.md`

Tier ownership rules:

- If a feature is P0/P1/P2, it must be fixture-covered and pass in Go/TS/Py.
- Anything Go-only must be explicitly labeled as Go-only, with a documented non-portable boundary.

## Repo direction (decision)

Monorepo layout (TableTheory pattern):

- `/` — Go SDK + runtime (root module; Go toolchain `1.25.6`)
- `ts/` — TypeScript SDK + runtime (Node.js `24`)
- `py/` — Python SDK + runtime (Python `3.14`)
- `contract-tests/` — fixtures + runners (Go/TS/Py)
- `examples/` — deployable examples (including CDK)
- `docs/` — docs + planning + decision records

Versioning + distribution:

- **Single shared repo version:** Go/TS/Py move together under the same Git tag/release (`vX.Y.Z` and `vX.Y.Z-rc.N`).
- **Release assets:** TS `npm pack` tarball; Python wheel + sdist (plus checksums); Go is source-distributed via module tags.
- **No registry publishing:** installs happen from GitHub release assets or from source.

See: `docs/development/planning/apptheory/supporting/apptheory-versioning-and-release-policy.md`

## Roadmap overview

The milestones below are the shortest path to v0.1.0 while keeping parity and supply-chain posture intact.

Deep workstreams are tracked in dedicated sub-roadmaps:

- Contract tests: `subroadmaps/SR-CONTRACT.md`
- Releases and supply-chain: `subroadmaps/SR-RELEASE.md`
- CDK strategy: `subroadmaps/SR-CDK.md`
- Testkits + mocks: `subroadmaps/SR-MOCKS.md`
- Prod features parity: `subroadmaps/SR-PROD-FEATURES.md`
- Lift migration: `subroadmaps/SR-MIGRATION.md`

## Milestones

### M0 — Charter, scope, and naming (freeze the “what”)

**Goal:** define what AppTheory is (and is not) so the repo bootstraps correctly.

**Acceptance criteria**
- Target audiences and top-level use cases are written (API Lambda, event-driven, internal tooling, etc).
- Public names are chosen and recorded: Go module path, npm scope/name, Python distribution name, Python import name.
- Supported runtimes are pinned: Go toolchain, Node.js runtime, Python runtime.
- Parity tiers (P0/P1/P2) are defined and linked to the parity matrix.

**Deliverables**
- `docs/development/planning/apptheory/supporting/apptheory-repo-layout.md`
- `docs/development/planning/apptheory/supporting/apptheory-parity-matrix.md`

**M0 decisions (frozen)**
- Charter + audiences/use-cases: `README.md`
- Go module path: `github.com/theory-cloud/apptheory`
- npm package: `@theory-cloud/apptheory`
- Python distribution/import: `apptheory` / `apptheory`
- Pinned runtimes: Go `1.25.6`, Node.js `24`, Python `3.14`

---

### M1 — Repo bootstrap to TableTheory pattern (make “the shape” real)

**Goal:** establish a repo skeleton that can support multi-language work without drift.

**Complex enough for sub-roadmap:** release and supply-chain checks. See `subroadmaps/SR-RELEASE.md`.

**Acceptance criteria**
- Repo has `docs/`, `contract-tests/`, `ts/`, `py/` scaffolds in place (even if empty packages initially).
- A root Makefile exists with targets mirroring TableTheory conventions (`build`, `test-unit`, `test`, `lint`, `fmt`,
  `rubric`).
- A version-alignment rule exists (repo version is single source of truth across Go/TS/Py).
- “No registry publishing” is documented and enforced in release tooling.

**Suggested verification (future)**
- `make rubric`

---

### M2 — Lift extraction plan + migration intent (decide what to port)

**Goal:** reduce risk by explicitly defining what is being imported from Lift and what is being re-designed.

**Complex enough for sub-roadmap:** migration strategy. See `subroadmaps/SR-MIGRATION.md`.

**Acceptance criteria**
- A Lift → AppTheory mapping exists for:
  - runtime core (handlers, context, router, middleware ordering)
  - CDK constructs (what to preserve, what to re-implement)
  - testing/mocks (what to preserve, what to redesign cross-language)
- A “minimum viable migration” playbook is written (what changes users must make; what can be automated).
- A “Go-only allowed” list exists (explicit non-portable features).

**Deliverables**
- `docs/development/planning/apptheory/supporting/apptheory-lift-to-apptheory-mapping.md`

---

### M3 — Runtime contract v0 + contract fixtures (truth moves out of code)

**Goal:** define portable semantics and fixtures before building three divergent SDKs.

**Complex enough for sub-roadmap:** yes. See `subroadmaps/SR-CONTRACT.md`.

**Acceptance criteria**
- Runtime contract v0 exists and includes at least:
  - canonical HTTP request representation (headers, query, path, body bytes, base64 rules)
  - canonical HTTP response representation (status, headers, cookies, body, base64 rules)
  - error taxonomy and status mapping
  - middleware ordering and invariants
- A P0 fixture set exists (routing, parsing, headers/cookies, error mapping, body/base64 behavior).
- Go/TS/Py runner harness exists (even if implementations fail initially).

**Deliverables**
- `docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`

---

### M4 — Go runtime P0 (contract-complete core)

**Goal:** produce a solid Go core that passes P0 fixtures and anchors the DX.

**Acceptance criteria**
- Go implementation passes all P0 contract fixtures.
- Public Go API surface is documented and stable enough for early adopters.
- Go testkit exists for local invocation and deterministic time.

---

### M5 — TypeScript runtime P0 (contract-complete core)

**Goal:** TS SDK is a peer implementation, not a wrapper.

**Acceptance criteria**
- TS implementation passes the same P0 contract fixtures.
- TS package builds cleanly, typechecks, and has a public testkit.
- TS docs and a minimal example exist (local invocation).

---

### M6 — Python runtime P0 (contract-complete core)

**Goal:** Python SDK is a peer implementation, not a wrapper.

**Acceptance criteria**
- Python implementation passes the same P0 contract fixtures.
- Python package builds a wheel + sdist locally (and in CI) and includes a public testkit.
- Python docs and a minimal example exist (local invocation).

---

### M7 — Testkits + AWS mocks (portable local testing)

**Goal:** preserve Lift’s “batteries included” local testing story across all three languages.

**Complex enough for sub-roadmap:** yes. See `subroadmaps/SR-MOCKS.md`.

**Acceptance criteria**
- Each language ships a testkit that supports:
  - deterministic clock
  - deterministic randomness (for IDs/correlation IDs)
  - strict fakes/mocks for any AWS clients AppTheory wraps directly
  - event builders for supported event sources
- Docs show “unit test without AWS” per language.

---

### M8 — P1/P2 parity (context, middleware, prod features)

**Goal:** deliver the “production-ready” surfaces that made Lift valuable, without breaking portability.

**Complex enough for sub-roadmap:** yes. See `subroadmaps/SR-PROD-FEATURES.md`.

**Acceptance criteria**
- P1 fixtures pass (middleware ordering, request-id, auth hooks, tenant extraction, CORS, size/time guardrails).
- P2 fixtures pass for any “portable” prod feature surfaces (observability envelope, rate limit semantics, policy hooks).
- Anything not ported is explicitly documented as Go-only.

---

### M9 — CDK story (examples first; constructs strategy second)

**Goal:** preserve/extend Lift’s deployment story across languages.

**Complex enough for sub-roadmap:** yes. See `subroadmaps/SR-CDK.md`.

**Acceptance criteria**
- A deployable CDK example exists showing the same app in Go/Node/Python deployed together.
- `cdk synth` verification exists and is pinned/deterministic.
- A constructs strategy decision is made:
  - either TS-first jsii constructs (preferred for multi-language) or
  - a documented “examples/templates are first-class; constructs are Go-only for now” posture.

---

### M10 — Lift → AppTheory migration toolkit (easy, not identical)

**Goal:** enable Pay Theory apps to migrate with minimal friction.

**Complex enough for sub-roadmap:** yes. See `subroadmaps/SR-MIGRATION.md`.

**Acceptance criteria**
- Migration guide is complete, with mapping tables and code examples.
- At least one automated helper exists (import rewrite, API adapter, or compatibility shim).
- A representative Pay Theory app can migrate following the playbook.

---

### M11 — Releases + rubric gates + v0.1.0

**Goal:** ship v0.1.0 with supply-chain posture and parity guarantees.

**Complex enough for sub-roadmap:** yes. See `subroadmaps/SR-RELEASE.md`.

**Acceptance criteria**
- GitHub Release for `v0.1.0` contains:
  - TS `npm pack` tarball
  - Python wheel + sdist
  - checksums for assets
  - release notes including upgrade notes from Lift
- CI has deterministic gates for:
  - version alignment across languages
  - build/test/lint/format checks
  - contract tests across languages
  - CDK synth (for examples/constructs)
- `make rubric` (or equivalent single command) proves the repo is v0.1.0-ready.

## Notes on governance artifacts (`hgm-infra/`)

Hypergenium’s applied outputs often live under `hgm-infra/` today, but that structure is expected to evolve as migrations
complete and governance is consolidated into GovTheory.

Roadmap rule: keep this plan and core engineering artifacts in `docs/` so they remain stable even if governance
infrastructure is reworked.

See: `docs/development/planning/apptheory/supporting/apptheory-governance-note.md`
