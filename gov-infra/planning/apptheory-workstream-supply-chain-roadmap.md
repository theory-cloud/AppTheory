# AppTheory: Supply-Chain Roadmap (Rubric v1.0.0)

This document exists because supply-chain integrity is a high-leverage risk area for AppTheory (multi-language
dependencies + GitHub Actions). It is also currently a likely blocker because the repo uses GitHub Actions with floating
`uses: ...@vN` tags.

The rubric remains the source of truth:
- the definition of “passing” does not move unless the rubric version is bumped,
- missing verifiers are **BLOCKED** (never treated as green),
- “green by dilution” fixes are not allowed (no blanket excludes; no lowered thresholds).

## Scope and blockers
- **Workstream:** supply-chain
- **Goal:** make supply-chain checks deterministic and enforce integrity pinning for CI and dependencies.
- **Blocking rubric IDs:** SEC-3 (and indirectly COM-2)
- **Primary verifier:** SEC-3 supply-chain gate (via `gov-infra/verifiers/gov-verify-rubric.sh`)
- **Primary evidence:** `gov-infra/evidence/SEC-3-output.log`

## Baseline (start of remediation)
Snapshot (2026-01-21):
- Current status: expected FAIL (GitHub Actions workflows use `@v4`, `@v5`, etc; SEC-3 requires pin-by-SHA)
- Failure modes:
  - GitHub Actions integrity pinning not enforced (floating action tags)
  - Node dependency lifecycle risks may appear once Node deps are materialized for scanning
  - Python dependency files may reference custom indexes (future risk) or contain typosquats (guardrail)

## Guardrails (no “green by dilution”)
- Do not disable SEC-3 or add blanket allowlists.
- Allowlist only *specific* findings with justification (one ID per line) in:
  - `gov-infra/planning/apptheory-supply-chain-allowlist.txt`
- Keep workflow changes minimal, reviewable, and tied to integrity improvements.

## Progress snapshots
- Baseline (2026-01-21): TBD (run verifier to capture exact findings)
- After SC-1 (date): TBD
- After SC-2 (date): TBD

## Milestones

### SC-1 — Pin GitHub Actions by commit SHA
Focus: eliminate floating tags (`@v4`, `@v5`, etc.).

Acceptance criteria:
- No `uses: ...@vN` entries in `.github/workflows/*.yml`.
- All actions are pinned by commit SHA (40 hex chars).

Suggested verification:
```bash
bash gov-infra/verifiers/gov-verify-rubric.sh
```

### SC-2 — Make Node dependency scans deterministic (without executing scripts)
Focus: ensure Node projects can be installed with scripts disabled and scanned.

Acceptance criteria:
- Each Node project has exactly one lockfile type (npm/pnpm/yarn).
- `npm ci --ignore-scripts` works where applicable.
- Any lifecycle-script findings are either fixed (preferred) or allowlisted with justification.

### SC-3 — Add pinned vulnerability scanning (SEC-2)
Focus: add toolchain-pinned dependency vulnerability scanning for Go/Node/Python.

Acceptance criteria:
- A pinned vuln scan runs deterministically and fails closed.
- Evidence is produced under `gov-infra/evidence/SEC-2-output.log`.

## Notes
- After implementation, update the main roadmap and bump rubric version if the definition of SEC-3 changes.
