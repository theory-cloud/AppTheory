# AppTheory Versioning + Release Policy (GitHub Releases Only)

Goal: match TableTheory’s distribution model while shipping Go/TypeScript/Python from one monorepo.

Status: frozen for milestone `M11` (`SR-RELEASE` R0).

## Principles

- **Git tags are the version:** the repo tag `vX.Y.Z` is the shared version for Go/TS/Py.
- **GitHub Releases are the source of truth:** assets attached to a release are how TS/Py are installed.
- **No registry publishing:** do not publish to npm or PyPI; avoid dangerous tokens.
- **Version alignment is enforced:** CI fails if Go/TS/Py disagree on version.
- **Prefer deterministic builds:** pinned tools where possible; reproducible artifacts; checksums for release assets.

## Branch model

- `staging` is the integration branch (all day-to-day work lands here first).
- `premain` is the prerelease branch (RCs like `vX.Y.Z-rc.N`).
- `main` is the stable release branch (stable tags like `vX.Y.Z`).

Release flow (TableTheory pattern):

- **staging → premain**: merge a PR from `staging` into `premain` to start the prerelease pipeline.
  - The `Prerelease PR (premain)` workflow opens/updates a **release-please PR** (branch `release-please--branches--premain`).
  - **Merging the release-please PR** is what cuts the RC tag + GitHub prerelease.
- **premain → main**: merge a PR from `premain` into `main` to promote an RC line to stable.
  - The `Release PR (main)` workflow aligns stable releases to the premain RC baseline (via `release-as`), then opens the stable
    release-please PR.
  - **Merging the stable release-please PR** cuts the stable tag + GitHub release.
- **post-release sync**: back-merge `main` into `staging` (and `premain` as needed) so the next cycle starts from the latest stable baseline.

Important: release automation is driven by **Conventional Commits**. Commits typed as `fix:` / `feat:` are treated as user-facing
and will advance the release line; `chore:` commits may be ignored by release-please. If a change must ship, prefer `fix(<scope>): ...`
or `feat(<scope>): ...` (this matches TableTheory’s release flow expectations).

## Branch/version invariants (enforced)

AppTheory follows the TableTheory invariant set so prereleases cannot get “stuck” on an old semver track:

- `premain` must stay aligned to the latest stable version on `main`:
  - `.release-please-manifest.json` on `premain` must match `main`.
  - The prerelease track in `.release-please-manifest.premain.json` must not be behind `main`’s stable semver base.

These are enforced in the rubric via:

- `bash scripts/verify-branch-release-supply-chain.sh`
- `bash scripts/verify-branch-version-sync.sh`

## Version scheme

- Stable releases: `vX.Y.Z`
- Pre-releases: `vX.Y.Z-rc.N` (recommended)

Initial public release:

- The first public AppTheory release is planned as `v0.1.0` (tag on `main`).

Breaking changes:

- Prefer semver major bumps for contract-breaking changes.
- While AppTheory is `0.x`, breaking changes may ship in `0.(Y+1).0` as needed; keep `0.Y.Z` patch releases non-breaking.
- If contract changes, the contract fixtures must change in the same release.

## Release assets (required)

Each GitHub Release must attach:

- TypeScript package tarball (`npm pack` output from `ts/`)
- Python wheel + sdist (built from `py/`)
- Checksums (at least SHA-256) for each attached asset

## Install guidance (from release assets)

TypeScript:

- Download the `.tgz` from the GitHub Release.
- Install via file path: `npm i ./theory-cloud-apptheory-<version>.tgz`

Python:

- Download the wheel from the GitHub Release.
- Install via file path: `pip install ./apptheory-<version>-py3-none-any.whl`

Go:

- Install by tag: `go get github.com/theory-cloud/apptheory@vX.Y.Z`

## CI/CD rules (no dangerous tokens)

- No npm publish tokens or PyPI tokens.
- Use `GITHUB_TOKEN` with minimal permissions required to create releases and attach assets.
- Default to “fail closed” when a verifier cannot run due to missing pinned tooling.

## Reproducing release artifacts (local)

To reproduce release assets from a tag:

- Checkout the tag: `git checkout vX.Y.Z` (or `vX.Y.Z-rc.N`).
- Run `make rubric` to build the TS tarball + Python wheel/sdist and run verification.
- Optional: run `make verify-builds` to build twice and compare checksums (reproducibility check).
- Run `scripts/generate-checksums.sh` to produce `dist/SHA256SUMS.txt`.

Artifacts are written to `dist/`.
