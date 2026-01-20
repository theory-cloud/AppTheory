# AppTheory Gap Analysis & Remediation Roadmap

Status snapshot:

- Repo: `AppTheory/`
- Commit: `6b8117236f9998c7cbb9b0f34dde7bb8c0b10787`
- Toolchains: Go `1.25.6`, Node `24`, Python `3.14` (per `go.mod` + docs)
- Current quality signal: `make rubric` passes locally

This document captures the remaining gaps *after* implementing the multi-language roadmap structure and the initial
end-to-end rubric gates, and proposes a concrete remediation roadmap to fully close out “v0.1.0-ready” expectations.

Primary roadmap reference:

- `docs/development/planning/apptheory/apptheory-multilang-roadmap.md`

## What’s already working (evidence)

`make rubric` (`scripts/verify-rubric.sh`) currently proves:

- Version alignment across Go/TS/Py/CDK (`scripts/verify-version-alignment.sh`)
- Go tests + vet (`scripts/verify-go.sh`)
- TS release packaging via `npm pack` (`scripts/verify-ts-pack.sh`)
- Python wheel + sdist build (`scripts/verify-python-build.sh`)
- CDK constructs tests + jsii packaging + Go bindings tests + synth drift gate (`scripts/verify-cdk-*.sh`)
- Contract tests pass in Go/TS/Py (27 fixtures) (`scripts/verify-contract-tests.sh`)
- Testkit examples run in TS + Py (`scripts/verify-testkit-examples.sh`)

Release workflow exists and is aligned with the “GitHub Releases only” posture:

- CI: `AppTheory/.github/workflows/ci.yml`
- Release-on-tag: `AppTheory/.github/workflows/release.yml`

## Gap analysis (what remains)

### Gap A — “Roadmap complete” vs “Release complete” (M11 outcome)

**Current state**

- `VERSION` is `0.0.0` (`AppTheory/VERSION:1`).
- No git tags exist (`git tag` is empty).
- Release workflow is in place (`.github/workflows/release.yml`) but has never been exercised end-to-end on a real tag.

**Why it matters**

- M11’s acceptance criteria is an actual tagged GitHub Release (`v0.1.0`) with attached assets + checksums + notes.

**Remediation**

- Decide the first public version (`v0.1.0` per policy) and cut the first tag from the correct branch (`main` for stable).
- Validate the release workflow produces the required assets and publishes a GitHub Release successfully.

**Acceptance criteria**

- `VERSION` is `0.1.0` (or `0.1.0-rc.1` for RC) and matches:
  - `ts/package.json`
  - `py/pyproject.toml`
  - `cdk/package.json`
- Tag exists and matches `VERSION`:
  - stable: `v0.1.0` from `main`
  - RC: `v0.1.0-rc.1` from `premain`
- GitHub Release contains (at minimum):
  - `theory-cloud-apptheory-<version>.tgz`
  - `apptheory-<version>-*.whl` + `apptheory-<version>.tar.gz`
  - `theory-cloud-apptheory-cdk-<version>.tgz`
  - `apptheory_cdk-<version>-*.whl` + `apptheory_cdk-<version>.tar.gz`
  - `SHA256SUMS.txt`
  - Release notes (`dist/RELEASE_NOTES.md`)

---

### Gap B — CI does not run the full rubric gate set

**Current state**

- CI runs a subset of gates (version alignment, Go test/vet, TS pack, Python build, deterministic builds, contract tests).
- CI does not run CDK construct tests or synth drift detection.
- CI does not run testkit examples.
- CI does not enforce formatting (`fmt-check`) and does not run “real lint”.

**Why it matters**

- If only the release workflow runs `make rubric`, drift can accumulate until tag-time.

**Remediation**

- Add a “Rubric” job to `AppTheory/.github/workflows/ci.yml` that runs `make rubric` (or add equivalent dedicated jobs for
  the missing gates: CDK + synth + examples).

**Acceptance criteria**

- Every PR to `main` / `premain` runs the same gate set that `release.yml` runs (or an explicitly documented subset),
  including CDK and synth drift detection.

---

### Gap C — Linting parity with TableTheory (requested: import TableTheory lint config)

**Current state**

- AppTheory has no `golangci-lint` config and no Go lint invocation.
- `make lint` currently runs `scripts/verify-go.sh` (test + vet), which is not equivalent to TableTheory’s lint posture.
- TableTheory’s Go lint config is in `TableTheory/.golangci-v2.yml`.

When the TableTheory config is run against AppTheory code as-is, it reports a sizable initial backlog (example categories
include `dupl`, `errcheck`, `gofmt`, `gosec`, `prealloc`, `revive`, and `govet` field alignment).

**Why it matters**

- You asked for TableTheory-style release patterns and first-class quality posture; linting is one of the main
  “fail-closed” gates that prevents quality drift.

**Remediation (plan only; do not implement in this step)**

1. Port `TableTheory/.golangci-v2.yml` into AppTheory as `AppTheory/.golangci-v2.yml`.
2. Update `goimports` `local-prefixes` to include `github.com/theory-cloud/apptheory`.
3. Decide whether AppTheory’s policy is:
   - “Match TableTheory strictly” (fix code until clean), or
   - “Match TableTheory with scoped exclusions” (documented carve-outs for generated/fixture/test harness code).
4. Wire `golangci-lint` into:
   - `AppTheory/Makefile` `lint` target (and optionally `rubric`)
   - `AppTheory/.github/workflows/ci.yml` (pinned install)
5. Burn down the initial lint backlog (or configure permitted exclusions).

**Complex enough for a dedicated sub-roadmap**

- Recommended: create `docs/development/planning/apptheory/subroadmaps/SR-LINT.md` to track:
  - linter set + config decisions
  - baseline backlog burn-down plan
  - CI/rubric integration strategy

**Acceptance criteria**

- `make lint` runs `golangci-lint` with a pinned config and fails closed.
- CI runs `make lint` (or `make rubric` if lint is part of rubric).
- Any exclusions are:
  - minimal
  - documented (why they exist and when they should be removed)

---

### Gap D — Contract coverage for AWS event adapters (fixture-backed)

**Current state**

- Contract v0 claims HTTP event sources are in-scope (`docs/.../apptheory-runtime-contract-v0.md`).
- The parity matrix marks Lambda URL and APIGW v2 adapters as implemented but **not fixture-backed** (`🟨`).

**Why it matters**

- Adapter behavior is where subtle drift happens (headers/cookies/base64/path/query edge cases).
- “Contract-first” is only as strong as fixture coverage.

**Remediation**

- Extend fixtures to include adapter-level cases:
  - event → canonical request normalization
  - canonical response → event response serialization
- Ensure Go/TS/Py runners execute those fixtures through:
  - `ServeAPIGatewayV2` / `ServeLambdaFunctionURL` (Go)
  - `serveAPIGatewayV2` / `serveLambdaFunctionURL` (TS)
  - `invoke_apigw_v2` / `invoke_lambda_function_url` (Py)

**Acceptance criteria**

- Parity matrix for adapters moves from `🟨` → `✅`.
- Fixtures explicitly cover edge cases (at minimum):
  - cookies (event cookie list vs `Cookie` header)
  - header normalization, multi-value behavior decisions
  - raw query vs parsed query precedence
  - base64 request/response handling

---

### Gap E — Migration toolkit is present but not yet “complete” (M10)

**Current state**

- Migration docs exist, but the main guide is explicitly a skeleton (`docs/migration/from-lift.md`).
- A real automation helper exists, but it only rewrites `pay-theory/limited` imports (`cmd/lift-migrate`).

**Why it matters**

- “Easy, not identical” still requires a playbook that is complete enough for Pay Theory migrations to be predictable.

**Remediation**

- Expand `SR-MIGRATION` deliverables to reach “first service migrated” for a representative Pay Theory service:
  - complete mapping tables (Lift runtime → AppTheory runtime)
  - explicit middleware ordering differences
  - “manual steps” checklists per subsystem (routing, auth, logging, limiting, DynamoDB)
- Extend automation beyond `limited` rewrites where safe:
  - optional rewriting of common Lift import paths
  - (optional) opt-in patterns for DynamORM → TableTheory migration helpers

**Acceptance criteria**

- `docs/migration/from-lift.md` is a complete guide (not a skeleton):
  - end-to-end “before/after” migration outline
  - mapping table(s) for commonly used Lift surfaces
  - known divergence list (explicit non-drop-in differences)
- At least one non-trivial Pay Theory service migrates following the guide (with recorded deltas and lessons learned).

---

### Gap F — Package metadata consistency (licenses, provenance, and consumer clarity)

**Current state**

- Repo has Apache 2.0 in `LICENSE`, but:
  - `ts/package.json` is `UNLICENSED`
  - `cdk/package.json` is `UNLICENSED`
  - `py/pyproject.toml` uses `LicenseRef-Proprietary`

**Why it matters**

- Even with GitHub Releases only, consumers will inspect package metadata.
- Mismatched metadata complicates compliance and internal adoption.

**Remediation**

- Align TS/Py/CDK package metadata with repo licensing intent (and ensure license files are included in release assets as
  appropriate).

**Acceptance criteria**

- License metadata is consistent across Go/TS/Py/CDK and matches repository policy.
- Release artifacts include the expected licensing files.

## Remediation roadmap (proposed)

### R0 — Decide release target + policy confirmations (small)

**Goal:** remove ambiguity before tightening gates.

**Steps**

- Confirm the first public tag (`v0.1.0` vs `v0.0.1`) and whether an RC (`v0.1.0-rc.1`) is desired.
- Confirm package licensing metadata policy (align manifests).
- Confirm whether TS should remain “dist-only” or move to “source + build”.

**Acceptance criteria**

- A written decision in `docs/` (ADR if needed) for version target and package metadata policy.

---

### R1 — CI gate parity with release rubric (medium)

**Goal:** prevent drift between PR-time and tag-time.

**Steps**

- Add a `rubric` job to `AppTheory/.github/workflows/ci.yml` that runs `make rubric`.
- If CI runtime is too heavy, split into parallel jobs but ensure equivalence to release gates.

**Acceptance criteria**

- PRs to `main` / `premain` run the same verification set as tag releases.

---

### R2 — Linting parity workstream (large; merits `SR-LINT`)

**Goal:** adopt TableTheory-style lint posture in AppTheory without weakening gates.

**Steps**

- Port `TableTheory/.golangci-v2.yml` → `AppTheory/.golangci-v2.yml` (adjust `local-prefixes`).
- Wire `golangci-lint` into `make lint` (and optionally `make rubric`).
- Burn down or explicitly exclude the initial backlog (with documentation).
- (Optional) expand to TS/Py lint parity (eslint/ruff) if first-class contributor DX is required.

**Acceptance criteria**

- `make lint` is fail-closed and runs in CI with pinned tools.
- A documented policy exists for any allowed exclusions (minimized).

---

### R3 — Adapter fixtures for Lambda URL + APIGWv2 (medium)

**Goal:** make “HTTP event sources are in the contract” true in fixtures.

**Steps**

- Add adapter-focused fixtures and run them via each language’s event-serving entrypoint.
- Update parity matrix to reflect fixture coverage.

**Acceptance criteria**

- Adapter lines in `apptheory-parity-matrix.md` are `✅` and enforced by contract tests.

---

### R4 — Migration guide + tooling to “first service migrated” (large; already tracked by `SR-MIGRATION`)

**Goal:** make Pay Theory migrations predictable and repeatable.

**Steps**

- Complete `docs/migration/from-lift.md`.
- Expand automation (safe rewrites) and document what remains manual.
- Run (and record) at least one representative migration.

**Acceptance criteria**

- Migration guide is complete and validated by a real service migration.

---

### R5 — Cut `v0.1.0` release (medium)

**Goal:** finish M11 as an outcome.

**Steps**

- Bump `VERSION` and aligned files.
- Merge to the correct branch (`main` for stable).
- Tag and push `v0.1.0`; verify `release.yml` publishes assets correctly.

**Acceptance criteria**

- GitHub Release exists for `v0.1.0` with the required assets + checksums + notes, and `make rubric` passes from the tag.

