# SR-RELEASE — GitHub Releases Only (Versioning + Supply Chain)

Goal: match TableTheory’s distribution posture while shipping a multi-language monorepo:

- **Single repo version** for Go/TypeScript/Python
- **GitHub Releases are the source of truth**
- No npm/PyPI publishing (avoid dangerous tokens)
- Deterministic, verifiable artifacts with minimal CI permissions

## Scope

- Versioning policy (including pre-releases)
- Asset generation for TS + Python
- Version alignment checks across languages
- CI/CD workflows and gates
- Release notes and upgrade notes (including Lift migration guidance)

Non-goals:

- Registry publishing (npm, PyPI)
- Complex signing infrastructure beyond checksums unless required later

## Milestones

### R0 — Freeze versioning + branch model

**Acceptance criteria**
- Single version policy is written (repo tag is the shared version).
- Pre-release naming is chosen and documented (`vX.Y.Z-rc.N` recommended).
- Branch model is chosen (example: `main` + optional `premain` for pre-release automation).

**Deliverables**
- `docs/development/planning/apptheory/supporting/apptheory-versioning-and-release-policy.md`

---

### R1 — Version alignment gates (fail closed)

**Acceptance criteria**
- A verifier exists that fails if versions drift between:
  - `go.mod` (module version via tag expectations)
  - `ts/package.json`
  - `py/pyproject.toml`
  - any docs that declare versions (if used)
- The verifier runs in CI and is runnable locally.

---

### R2 — Build + package scripts per language

**Acceptance criteria**
- TypeScript: `npm pack` produces a tarball from `ts/` with the intended entrypoints and docs.
- Python: wheel + sdist build from `py/` works locally and in CI.
- Go: `go test ./...` and `go vet` (and lints) pass under pinned toolchain.
- All artifacts are produced without network calls beyond fetching Go modules / npm deps / python deps (as permitted by CI).

---

### R3 — Release workflow that attaches assets

**Acceptance criteria**
- A GitHub Release workflow produces:
  - TS tarball
  - Python wheel + sdist
  - checksums for each asset
  - release notes / changelog entry
- Workflow uses minimal permissions and avoids long-lived secrets.

---

### R4 — Determinism + reproducibility verification

**Acceptance criteria**
- “Verify builds” scripts exist (similar to TableTheory’s `scripts/verify-builds.sh`) and run in CI.
- A local developer can reproduce the release artifacts from the same tag.
- Artifact names are stable and unambiguous (include version).

---

### R5 — Upgrade notes + migration notes embedded in releases

**Acceptance criteria**
- Release notes include:
  - breaking changes (if any)
  - upgrade steps
  - Lift migration pointers (link to SR-MIGRATION deliverables)
- A “from Lift” migration doc exists and is linked from the root README.

## Risks and mitigation

- **Supply-chain regressions:** keep workflows minimal and deterministic; prefer pinned tools; fail closed.
- **Version drift:** enforce version alignment with a single script gate.
- **Asset confusion:** use consistent naming conventions and checksums; document install-from-release procedures for TS/Py.

