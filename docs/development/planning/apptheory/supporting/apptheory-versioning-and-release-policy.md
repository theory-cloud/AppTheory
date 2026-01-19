# AppTheory Versioning + Release Policy (GitHub Releases Only)

Goal: match TableTheory’s distribution model while shipping Go/TypeScript/Python from one monorepo.

Status: frozen for milestone `M0`; implementation tracked in `SR-RELEASE`.

## Principles

- **Git tags are the version:** the repo tag `vX.Y.Z` is the shared version for Go/TS/Py.
- **GitHub Releases are the source of truth:** assets attached to a release are how TS/Py are installed.
- **No registry publishing:** do not publish to npm or PyPI; avoid dangerous tokens.
- **Version alignment is enforced:** CI fails if Go/TS/Py disagree on version.
- **Prefer deterministic builds:** pinned tools where possible; reproducible artifacts; checksums for release assets.

## Branch model

- `main` is the default branch and is kept releasable (green).
- All work lands via feature branches and PRs into `main`.
- Releases are cut by tagging a commit on `main`:
  - stable: `vX.Y.Z`
  - pre-release: `vX.Y.Z-rc.N`
- If/when needed for backports, use short-lived `release/vX.Y` branches; otherwise prefer forward-only on `main`.

## Version scheme

- Stable releases: `vX.Y.Z`
- Pre-releases: `vX.Y.Z-rc.N` (recommended)

Breaking changes:

- Prefer semver major bumps for contract-breaking changes.
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
