# AppTheory: Lint Green Roadmap (Rubric v1.0.0)

Goal: get to a green `make lint` pass using the repo’s strict lint configuration, **without** weakening thresholds or
adding blanket exclusions.

This exists as a standalone roadmap because lint issues often require large, mechanical change sets that should be kept
reviewable and should not block unrelated remediation work (coverage/security/etc).

## Why this is a dedicated roadmap
- A failing linter blocks claiming CON-* and often blocks later work.
- “Green by dilution” (disabling rules, widening excludes) is not an acceptable solution.

## Baseline (start of remediation)
Snapshot (2026-01-21):
- Primary command: `make lint`
- Current status: unknown (run `make lint` and capture failures into `gov-infra/evidence/CON-2-output.log` via the verifier)
- Top failure sources (expected by repo tooling):
  - Go: `golangci-lint` using `.golangci-v2.yml` (pinned in CI at `v2.9.0`)
  - TS: `eslint` (ts/devDependencies: `eslint@9.39.2`)
  - Python: `ruff==0.14.13`

## Progress snapshots
- Baseline (2026-01-21): TBD
- After LINT-1 (date): TBD
- After LINT-2 (date): TBD

## Guardrails (no “green by dilution”)
- Do not add blanket excludes (directory-wide or linter-wide) unless the scope is demonstrably out-of-signal.
- Prefer line-scoped suppressions with justification over disablements.
- Keep tool versions pinned (no `latest`) and verify config schema validity where supported.
- Keep formatter checks enabled so “fixes” don’t drift into style churn.

## Milestones (small, reviewable change sets)

### LINT-1 — Hygiene and mechanical fixes
Focus: reduce noise fast with low behavior risk.

Examples:
- Auto-fix formatting/imports.
- Fix typos/lint directives.
- Remove/replace stale suppressions.

Done when:
- `make lint` issue count drops meaningfully without changing linter policy.

### LINT-2 — Low-risk rule families (API-safe)
Focus: rules that are typically mechanical.

Examples:
- Unused parameter renames to `_` / `_unused`.
- Simplify repetitive patterns flagged by the linter.

Done when:
- The dominant “mechanical” linter families are cleared.

### LINT-3 — Correctness and error handling
Focus: stop ignoring errors and restore durable invariants.

Done when:
- “Ignored error” findings are eliminated or narrowly justified.

### LINT-4 — Refactors for duplication and complexity
Focus: highest behavior risk; do last.

Done when:
- `make lint` is green (0 issues) under the strict config.

## Helpful commands
```bash
make lint
scripts/verify-go-lint.sh
scripts/verify-ts-lint.sh
scripts/verify-python-lint.sh
```
