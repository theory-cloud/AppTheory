# SR-LINT — Lint Parity Across Go/TypeScript/Python (TableTheory Pattern)

Goal: AppTheory MUST maintain TableTheory-level quality gates across **all three** languages.

This is a release-quality requirement: lint must fail closed under `make rubric` and in CI.

## Scope

- Go lint configuration (golangci-lint) and CI/rubric integration
- TypeScript lint configuration (ESLint + formatting rules) and CI/rubric integration
- Python lint configuration (ruff + formatting rules) and CI/rubric integration
- Documented “how to run lint locally” per language

Non-goals:

- Introducing new tooling if TableTheory already has an accepted pattern; prefer adopting TableTheory’s configs.

## Milestones

### L0 — Confirm Go lint parity (baseline)

**Acceptance criteria**
- `make lint` fails closed and is part of `make rubric`.
- Go lint config is tracked in-repo and matches TableTheory intent.

Status: implemented (`.golangci-v2.yml`, `scripts/verify-go-lint.sh`).

---

### L1 — Adopt TableTheory TypeScript lint config

**Acceptance criteria**
- AppTheory `ts/` uses TableTheory-aligned ESLint config and scripts.
- `make rubric` includes TS lint (not just `npm pack`).
- CI runs TS lint.

Source reference: TableTheory `ts/.eslintrc.cjs`.

---

### L2 — Adopt TableTheory Python lint config

**Acceptance criteria**
- AppTheory `py/` uses TableTheory-aligned ruff config and scripts.
- `make rubric` includes Python lint (not just wheel/sdist build).
- CI runs Python lint.

Source reference: TableTheory `py/pyproject.toml` (ruff config).

