# Agent Instructions (GovTheory)

Scope: this file applies to `gov-infra/**`.

## Start Here

1) Read `gov-infra/README.md`.
2) Run the deterministic verifier from repo root:
   - `bash gov-infra/verifiers/gov-verify-rubric.sh`
3) Inspect results:
   - `gov-infra/evidence/gov-rubric-report.json`
   - `gov-infra/evidence/*-output.log`

## Constraints

- Keep changes under `gov-infra/` unless explicitly asked to modify application code.
- Treat the rubric/roadmap as living documents: they are not static; keep them versioned in git and evolve them intentionally.
- Do not weaken gates (no threshold reductions, no excludes, no disabling checks).
- If a verifier cannot be executed deterministically, return `BLOCKED` rather than guessing.
- Do not make scripts executable automatically; run them via `bash`.
- Do not introduce secrets.
- For `SEC-3` false positives (Node/Python/Go), add the exact finding ID to `gov-infra/planning/apptheory-supply-chain-allowlist.txt` with a short justification.
