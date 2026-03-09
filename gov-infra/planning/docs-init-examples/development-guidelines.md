# AppTheory Development Guidelines (Example)

This file is an example for `docs/development-guidelines.md`.

This guide is **contract-only** maintainer guidance.

## Standards

- Keep docs grounded in canonical repo evidence (`api-snapshots/*`, `Makefile`, `scripts/*`, manifests).
- Do not present unverified behavior as fact.
- Keep ingestible docs free of planning/process internals.
- Preserve explicit CORRECT/INCORRECT examples in pattern-oriented docs.

## Review Checklist

- API claims are validated against `api-snapshots/go.txt`, `api-snapshots/ts.txt`, and `api-snapshots/py.txt`.
- Verification commands are runnable and repo-realistic.
- Required headings and fixed contract sections are present in each docs file.
- Troubleshooting entries include concrete verification steps.
- Migration guidance remains user-facing.

## Documentation Expectations

- Use concise, reproducible commands for evidence.
- Mark missing details as `TODO:` or `UNKNOWN:` rather than guessing.
- Keep contract-only surfaces limited to maintainer alignment.
- Avoid linking ingestible docs to out-of-scope trees (`docs/development/**`, `docs/planning/**`, `docs/archive/**`).
