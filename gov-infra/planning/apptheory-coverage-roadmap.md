# AppTheory: Coverage Roadmap (to 60%) (Rubric v1.0.0)

Goal: raise and maintain meaningful coverage to **≥ 60%** as measured by the rubric’s Go coverage gate, without
reducing the measurement surface.

This exists as a standalone roadmap because coverage improvements are usually multi-PR efforts that need clear
intermediate milestones, guardrails, and repeatable measurement.

## Prerequisites
- The coverage verifier is deterministic and uses a stable default threshold (no “lower it to pass” override).
- Lint and tests are green (or have dedicated remediation roadmaps), so coverage work does not accumulate unreviewed debt.

## Current state
Snapshot (2026-01-21):
- Coverage gate: `check_go_coverage` (via `bash gov-infra/verifiers/gov-verify-rubric.sh`)
- Current result: unknown (run the verifier once to establish baseline)
- Measurement surface (initial policy): all packages under the root Go module (`go test ./...`) excluding generated/vendor.

## Progress snapshots
- Baseline (2026-01-21): TBD
- After COV-1 (date): TBD
- After COV-2 (date): TBD

## Guardrails (no denominator games)
- Do not exclude additional production code from the coverage denominator to “hit the number”.
- Do not move logic into excluded areas (examples/tests/generated) to claim progress.
- If package/module floors are needed, add explicit target-based verification rather than weakening the global gate.

## How we measure
Suggested flow:
1) Generate/refresh the coverage artifact with the canonical command:
   - `bash gov-infra/verifiers/gov-verify-rubric.sh`
2) Inspect output:
   - `gov-infra/evidence/go-coverage-summary.txt`
   - `gov-infra/evidence/go-coverage.out`
3) Re-run the full quality loop (tests + lint) as a regression gate:
   - `make test-unit`
   - `make lint`

## Proposed milestones (incremental, reviewable)
- COV-1: remove “0% islands” (every in-scope package has at least a smoke test)
- COV-2: broad floor (25%+ across in-scope packages)
- COV-3: meaningful safety net (50%+)
- COV-4: finish line (≥ 60% and gate is green)

## Workstreams (target the highest-leverage paths first)
- Hotspots: event normalization and response/streaming boundaries
- Common gap patterns: error paths, option/zero-value handling, boundary validation, serialization/deserialization

## Helpful commands
```bash
bash gov-infra/verifiers/gov-verify-rubric.sh
make test-unit
make lint
```
