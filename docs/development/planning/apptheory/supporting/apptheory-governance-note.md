# Governance Note — `hgm-infra/`, Hypergenium Pack Outputs, and GovTheory

Context:

- In existing repos, Hypergenium’s applied outputs often live under `hgm-infra/`.
- `hgm-infra/` is derived from the server-owned Hypergenium pack (`hgm/`) and represents *applied governance outputs*
  (rubric checks, evidence artifacts, verifiers).
- The longer-term direction is to consolidate these applied governance concerns into **GovTheory** after migrations
  complete.

## Practical guidance for AppTheory

- Keep engineering plans and technical truth in `docs/` (stable paths).
- Treat any `hgm-infra/` content as “infrastructure that may move” during the GovTheory migration.
- If AppTheory adopts `hgm-infra/` initially, prefer:
  - deterministic verifiers
  - pinned tooling
  - fail-closed behavior (`BLOCKED` rather than weakening gates)
- Avoid coupling core workflows to `hgm-infra/` internals until the GovTheory migration path is finalized.

## What this means for this roadmap

- Roadmap documents live under `docs/development/planning/apptheory/` so they remain stable regardless of governance
  migrations.
- When AppTheory’s build/test/release gates are implemented, they should be callable from `make rubric` (or equivalent)
  even if underlying governance tooling changes.

