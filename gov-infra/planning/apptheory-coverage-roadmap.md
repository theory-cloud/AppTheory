# AppTheory: Coverage Roadmap (to 75%) (Rubric v1.2.0)

Goal: raise and maintain meaningful coverage to **≥ 75%** across the shipped runtimes (Go/TypeScript/Python) as measured
by the rubric’s deterministic coverage gate, without reducing the measurement surface.

This exists as a standalone roadmap because coverage improvements are usually multi-PR efforts that need clear
intermediate milestones, guardrails, and repeatable measurement.

## Prerequisites
- The coverage verifier is deterministic and uses a stable default threshold (no “lower it to pass” override).
- Lint and tests are green (or have dedicated remediation roadmaps), so coverage work does not accumulate unreviewed debt.

## Current state
Snapshot (2026-01-22):
- Coverage gate: `check_coverage` (via `bash gov-infra/verifiers/gov-verify-rubric.sh`)
- Current result (baseline):
  - Go: 61.7% (below 75%)
  - TypeScript: 65.5% (below 75%; line coverage across `ts/dist/**`)
  - Python: 69.6% (below 75%; statement coverage across `py/src/apptheory/**`)
- Measurement surface (policy):
  - Go: all packages under the root Go module (`go test ./...`) excluding generated/vendor.
  - TypeScript: all runtime JS under `ts/dist/**` (output of `ts/src/**`), excluding tests and `node_modules`.
  - Python: all runtime modules under `py/src/apptheory/**`, excluding tests and caches.

## Progress snapshots
- Baseline (2026-01-22): Go 61.7% / TS 65.5% / Py 69.6% (COV-4 achieved on v1.1.0; COV-5 pending)

## Guardrails (no denominator games)
- Do not exclude additional production code from the coverage denominator to “hit the number”.
- Do not move logic into excluded areas (examples/tests/generated) to claim progress.
- If package/module floors are needed, add explicit target-based verification rather than weakening the global gate.

## How we measure
Suggested flow:
1) Generate/refresh the coverage artifact with the canonical command:
   - `bash gov-infra/verifiers/gov-verify-rubric.sh`
2) Inspect output:
   - Go: `gov-infra/evidence/go-coverage-summary.txt` + `gov-infra/evidence/go-coverage.out`
   - TypeScript: `gov-infra/evidence/ts-coverage-summary.txt`
   - Python: `gov-infra/evidence/py-coverage-summary.txt`
3) Re-run the full quality loop (tests + lint) as a regression gate:
   - `make test-unit`
   - `make lint`

## Proposed milestones (incremental, reviewable)
- COV-1: remove “0% islands” (every in-scope package has at least a smoke test) — achieved (2026-01-22)
- COV-2: broad floor (25%+ across in-scope packages) — achieved (2026-01-22)
- COV-3: meaningful safety net (50%+) — achieved (2026-01-22)
- COV-4: baseline gate (≥ 60% and gate is green) — achieved (2026-01-22; rubric v1.1.0)
- COV-5: finish line (≥ 75% and gate is green) — planned

## Workstreams (target the highest-leverage paths first)
- Hotspots: event normalization and response/streaming boundaries
- Common gap patterns: error paths, option/zero-value handling, boundary validation, serialization/deserialization

## Helpful commands
```bash
bash gov-infra/verifiers/gov-verify-rubric.sh
make test-unit
make lint
```
