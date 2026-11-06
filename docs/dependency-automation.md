---
title: Dependency Automation for Release-Pinned Installs
---

# Dependency Automation for Release-Pinned Installs

AppTheory and the rest of the Theory Cloud framework stack distribute TypeScript and Python packages as immutable
GitHub Release assets, not through npm or PyPI publication. Consumers that pin release tarballs and wheels need a
release-aware dependency bot; otherwise direct URLs stay invisible until a human edits them.

Use Renovate's `github-releases` datasource with regex managers. Dependabot can still help with ordinary registry
packages in your application, but it does not provide an equivalent custom manager for AppTheory's tarball/wheel URLs.

## Renovate config

Put this in `renovate.json` (or merge the same fields into your existing Renovate config):

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "customManagers": [
    {
      "customType": "regex",
      "description": "AppTheory GitHub Release asset URLs and Go module tags",
      "managerFilePatterns": [
        "/(^|/)(package\\.json|package-lock\\.json|requirements\\.txt|pyproject\\.toml|go\\.mod)$/"
      ],
      "matchStrings": [
        "github\\.com/theory-cloud/AppTheory/releases/download/v(?<currentValue>\\d+\\.\\d+\\.\\d+(?:-rc(?:\\.\\d+)?)?)",
        "github\\.com/theory-cloud/apptheory/v6\\s+v(?<currentValue>\\d+\\.\\d+\\.\\d+(?:-rc(?:\\.\\d+)?)?)",
        "theory-cloud-apptheory(?:-cdk)?-(?<currentValue>\\d+\\.\\d+\\.\\d+)\\.tgz",
        "apptheory(?:_cdk)?-(?<currentValue>\\d+\\.\\d+\\.\\d+)-py3-none-any\\.whl"
      ],
      "depNameTemplate": "theory-cloud/AppTheory",
      "datasourceTemplate": "github-releases",
      "versioningTemplate": "semver"
    },
    {
      "customType": "regex",
      "description": "TableTheory GitHub Release asset URLs and Go module tags",
      "managerFilePatterns": [
        "/(^|/)(package\\.json|package-lock\\.json|requirements\\.txt|pyproject\\.toml|go\\.mod)$/"
      ],
      "matchStrings": [
        "github\\.com/theory-cloud/TableTheory/releases/download/v(?<currentValue>\\d+\\.\\d+\\.\\d+(?:-rc\\.\\d+)?)",
        "github\\.com/theory-cloud/tabletheory\\s+v(?<currentValue>\\d+\\.\\d+\\.\\d+(?:-rc\\.\\d+)?)",
        "theory-cloud-tabletheory(?:-ts)?-(?<currentValue>\\d+\\.\\d+\\.\\d+)\\.tgz",
        "tabletheory_py-(?<currentValue>\\d+\\.\\d+\\.\\d+)-py3-none-any\\.whl"
      ],
      "depNameTemplate": "theory-cloud/TableTheory",
      "datasourceTemplate": "github-releases",
      "versioningTemplate": "semver"
    }
  ],
  "packageRules": [
    {
      "description": "Review AppTheory and TableTheory release pins together",
      "matchPackageNames": ["theory-cloud/AppTheory", "theory-cloud/TableTheory"],
      "groupName": "Theory Cloud framework release pins"
    }
  ]
}
```

This config intentionally matches both direct release assets and Go module requirements:

```text
github.com/theory-cloud/apptheory/v6 v4.0.0
https://github.com/theory-cloud/AppTheory/releases/download/v4.0.0/theory-cloud-apptheory-4.0.0.tgz
https://github.com/theory-cloud/AppTheory/releases/download/v4.0.0/theory-cloud-apptheory-cdk-4.0.0.tgz
https://github.com/theory-cloud/AppTheory/releases/download/v4.0.0/apptheory-4.0.0-py3-none-any.whl
https://github.com/theory-cloud/AppTheory/releases/download/v4.0.0/apptheory_cdk-4.0.0-py3-none-any.whl
```

Each release asset URL carries the version twice — once in the `download/v<version>` tag path and once in the file name.
A regex manager updates one occurrence per `matchString`, so the config above matches both: the tag-relative strings
and the release-version file-name strings (`*-<version>.tgz`, `*-<version>-py3-none-any.whl`). Without the file-name
strings, a bump rewrites only the tag path, leaves the file name pinned to the old version, and produces an asset URL
that 404s — the install path fails closed rather than silently pinning a stale asset. Pre-release lines normalize the
Python wheel file name pre-release suffix differently (`-rc` becomes `rc0`), so treat a pre-release bump as needing a
manual check of the file name.

When Renovate opens a bump PR, keep AppTheory's runtime package, CDK package, and generated lockfiles in the same PR.
If your app also consumes TableTheory directly, review that bump in the same change so TableTheory data-layer pins and
AppTheory runtime/CDK pins do not drift independently.

## Checksum discipline

Renovate can move URLs, but it cannot prove that your downloaded release assets still match `SHA256SUMS.txt`. Keep the
checksum verification step from the install docs in your CI or bootstrap script:

```bash
VERSION=4.0.0
TAG="v${VERSION}"
PYTHON_VERSION="${VERSION/-rc/rc0}"
gh release download "${TAG}" --repo theory-cloud/AppTheory --pattern "SHA256SUMS.txt" --clobber
grep -E " (theory-cloud-apptheory-${VERSION}\\.tgz|apptheory-${PYTHON_VERSION}-py3-none-any\\.whl)$" SHA256SUMS.txt | sha256sum -c -
```

For npm lockfiles, run `npm install` after Renovate updates the release URL so `package-lock.json` records the new
integrity. For Python, keep the wheel URL in `requirements.txt` or `pyproject.toml` and verify the downloaded release
asset before installing it in production bootstrap.

The TypeScript package's `.npmrc` sets npm's `allow-remote` policy to `root`. This is the narrow permission required for
the integrity-pinned TableTheory GitHub Release tarball: transitive dependencies remain unable to introduce remote URL
fetches.

## Dependabot notes

Dependabot remains useful for ordinary registry dependencies such as `aws-cdk-lib`, `constructs`, or application-only
npm packages. It is not the single path for AppTheory because AppTheory intentionally does not publish npm or PyPI
registry packages. Do not replace the GitHub Release pins with registry coordinates to make Dependabot work; use
Renovate for the release-pinned framework assets and Dependabot only for the dependencies that already come from a
registry.

## Maintainer override notes

AppTheory only carries package-manager `overrides` while a current audit, compatibility, or deterministic-build gate
requires them. In SP17, the TypeScript runtime package removed stale transitive overrides after the regenerated lockfile
passed `npm audit` with zero vulnerabilities. The removal rationale was:

- `@typescript-eslint/typescript-estree` → `minimatch`: upstream now resolves to `minimatch@10.2.5`, so the local
  pin was no longer carrying a security fix.
- `@eslint/eslintrc` / `eslint` → `ajv`: ESLint selects its compatible `ajv@6.14.0`; AppTheory does not override
  lint-tool internals without an active advisory.
- `@eslint/config-array` / `eslint` / `eslint-plugin-import-x` → `minimatch`: the lint stack remains audit-clean on its
  upstream-selected `minimatch` versions, and none of these packages are runtime dependencies. **Reinstated
  2026-11-01** for `GHSA-g3hv-75wg-m249`: the fresh advisory affects every minimatch `< 11.0.1`, and the lint stack
  cannot simply take 11 because `eslint-plugin-import-x` imports the removed `makeRe` export. The overrides now pin
  `11.0.1` for every consumer except `eslint-plugin-import-x`, which keeps `10.2.6` under the reviewed dev-only
  exception described above.
- `fast-xml-parser` / `fast-xml-builder`: the regenerated TypeScript lockfile no longer contains those packages, so
  keeping orphan overrides would hide dependency graph drift instead of fixing it.
- `flatted` / `js-yaml`: upstream-selected lint-tool transitive versions remain audit-clean; local pins were redundant.
- `yaml`: the TableTheory release asset now resolves `yaml@2.9.1`; AppTheory should not override TableTheory's
  transitive dependency unless a current advisory or contract gate requires it.

The repository pins AWS CDK `2.275.0`, whose published tarball bundles the patched `brace-expansion@5.0.12`. That meets
the documented removal condition of the former `brace-expansion 5.0.9` bundled-dependency exception (operator-ruled
2026-10-03), so that exception is retired - standard maintenance, not a new exception grant. The CDK npm-audit and
GovTheory OSV gates still verify the exact bundled graph, now as a positive assertion (`brace-expansion >= 5.0.12`),
and accept exactly two reviewed, self-expiring exceptions - `braces 3.0.3` reached only through the
`jsii-pacmak` / `jsii-rosetta` / `fast-glob` / `micromatch` dev chain (operator-ruled 2026-10-04), and
`minimatch 10.2.6` bundled inside `aws-cdk-lib` (`GHSA-g3hv-75wg-m249`; operator-ruled 2026-10-03, the original
bundled-dependency ruling) - carrying hard `recheck_by` deadlines (2026-12-01 for both; the `braces` deadline was
renewed 2026-11-01 from 2026-11-02 because the registry still published no patched `braces`, latest `3.0.3`) and
removal conditions (see `gov-infra/planning/apptheory-10of10-rubric.md` SEC-2). The 2026-11-01 refresh moved the pin
from `2.273.0` to `2.275.0`; the newer tarball still bundles `minimatch 10.2.6` (below the advisory's `11.0.1`
fix), so the bundled-minimatch exception is unchanged in scope and its anchor now records `2.275.0` / `10.2.6`.
Any vulnerable bundle, AWS CDK, minimatch, brace-expansion, package-path, or finding drift fails closed.

The TypeScript lint graph carries one active `overrides` block and one dev-only exception. `ts/package.json`
overrides `minimatch` to the patched `11.0.1` for `eslint`, `@eslint/config-array`, and
`@typescript-eslint/typescript-estree` (each override is explicit because npm may otherwise dedupe a consumer onto
the exception copy), while `eslint-plugin-import-x` keeps `10.2.6`:
minimatch 11 removed the `makeRe` export that `eslint-plugin-import-x` 4.17.1 imports at module load, so a
minimatch 11 override there throws at ESLint config load and the plugin's rules stop evaluating. 4.17.1 is the
latest published release and still declares `^9.0.3 || ^10.1.2`. The 2026-11-01 refresh let npm re-hoist the
override target: the patched `11.0.1` now lives at the single hoisted `node_modules/minimatch` node, the three
overridden consumers dedupe onto it, and the single remaining `minimatch@10.2.6` node sits at
`node_modules/eslint-plugin-import-x/node_modules/minimatch`. That node is covered by the operator-ruled
2026-11-01 **dev-only exception** (`GHSA-g3hv-75wg-m249`), recorded in
`scripts/check-visible-ts-brace-finding.mjs` with `recheck_by` 2026-12-01 and the removal condition
"`eslint-plugin-import-x` publishes a release compatible with `minimatch >= 11.0.1`". It is lint tooling only:
every minimatch node is `dev: true`, the root package declares no minimatch runtime dependency,
`npm ls --omit=dev --all` inside `ts/` reports none, and the published package ships only `dist`, `LICENSE`,
`README.md`, and `package.json`. The checker requires the exact minimatch / brace-expansion / runner
(`@isaacs/nonrecursive-glob-match`) graph, the exact minimatch parent set, and the exact reviewed override map, and
any drift - or any other advisory, version, path, or lockfile - fails closed. The `ts/` brace-expansion path
itself remains exception-free: the only instance (`5.0.12`) is past every recorded 5.x fix.

The 2026-11-06 `eslint` 10.13.0 -> 10.14.0 move (Dependabot #1222) is an in-family devDependency bump. eslint's own
`minimatch` range moved `^10.2.5` -> `^10.2.6`, which the reviewed override still resolves onto the hoisted
`11.0.1`, so the minimatch node set, the brace-expansion node, and the single reviewed `10.2.6` exception node are
unchanged. Only the anchor's recorded `eslint` parent version and range moved with the package; no override was
added, dropped, or loosened, and `@humanfs/node` re-resolved `0.16.6` -> `0.16.8` inside eslint's own range.

## Refresh register (2026-11-01, LOCAL-M0)

The 2026-11-01 dependency refresh re-resolved every checked-in lockfile against its declared range, aligned
`aws-cdk-lib` and the `aws-cdk` CLI, and re-checked the two pinned audit tools. No `npm --before` or
`uv --exclude-newer` cutoff was required: every fresh resolution passed the repository gates. One tool upgrade is
held.

### Holds

| Held item | Kept at | Reason | Re-check condition |
| --- | --- | --- | --- |
| `osv-scanner` v2.x | `v1.9.2` | `v2.7.0` cannot replace the gate's scanner yet. On `ts/package-lock.json` (which pins the TableTheory GitHub-release tarball by sha512) it exits `127` with `vulnmatch/osvdev ... 400 Bad Request ... invalid hash` and emits `{"results":[]}`. The rubric accepts only exit `0` (clean) or `1` (findings with the reviewed exception marker); `127` is an operational failure. On `cdk/package-lock.json` and example locks it exits `0` but returns zero packages, so it misses the reviewed bundled `minimatch` finding and would pass vacuously instead of proving the exception. | Retry when v2 parses `ts/package-lock.json` without the hash error and reproduces the v1.9.2 findings on `cdk/package-lock.json` and the example locks. |

### Applied moves (ranges raised only where alignment required it)

| Surface | Change |
| --- | --- |
| `cdk/` | `aws-cdk-lib` 2.273.0 -> 2.275.0 (dev and peer), `jsii-pacmak` 1.141.0 -> 1.142.0, `jsii-rosetta` 6.0.19 -> 6.0.20. This absorbs dependabot #1202; its `aws-cdk-lib` 2.274.0 step is superseded by 2.275.0. |
| `examples/cdk/*` | `aws-cdk-lib` 2.273.0 -> 2.275.0 in all 15 manifests; `aws-cdk` CLI 2.1129.0 -> 2.1147.0 in the 14 manifests that pin it. |
| `.github/workflows/pages.yml` | `ruby/setup-ruby` v1.334.0 -> v1.335.0 at the same SHA-pinned commit (absorbs dependabot #1205). |
| `ts/` | No manifest range changed. `npm update` moved caret/transitive nodes, re-hoisted the patched minimatch, and left every exact devDependency pin in place. |
| `go.mod` / `go.sum` | No directive or module path changed. `go get -u ./...` moved the AWS SDK graph to its latest patch/minor releases. TableTheory remains `v6.1.1`. |
| `py/` | No lockfile exists: `requirements-build.txt` and `requirements-lint.txt` are exact pins, and every pin is the newest compatible release, re-checked against the PyPI JSON metadata on 2026-11-01 (build 1.6.1, setuptools 84.2.1, wheel 0.48.0, ruff 0.17.3, pyright 1.1.414). Only `ruff` moved: 0.17.2 -> 0.17.3 (published 2026-10-27), and `make lint` passes on the new pin with no lint or format drift. |
| `contract-tests/runners/` | No package-manager manifest: the Go runner builds from the root module, and the Python/TypeScript runners use the stdlib and source imports, so there is no runner lockfile to refresh. |

### Exception re-evaluation

- **E2 `braces 3.0.3`**: keep. The registry still publishes no `braces > 3.0.3` (latest 3.0.3), so the removal
  condition is unmet; `recheck_by` stays 2026-12-01.
- **E3 bundled `minimatch`**: keep. `aws-cdk-lib` 2.275.0 bundles `minimatch 10.2.6`, below the advisory's
  `11.0.1` fix; the anchor now records `2.275.0` / `10.2.6`, and `recheck_by` stays 2026-12-01.
- **E4 `minimatch 10.2.6` for `eslint-plugin-import-x`**: keep. 4.17.1 is still the latest release and still
  declares `^9.0.3 || ^10.1.2`; `recheck_by` stays 2026-12-01. The anchor now records the refreshed topology
  (patched `11.0.1` at the hoisted root, the exception nested under `eslint-plugin-import-x`).

### Synth hashes

Only the three stacks whose bundled Go assets include the refreshed module graph moved:
`AppTheoryHelloWorldGo` (`0d48e5da…` -> `b73043ab…`), `AppTheoryMicrovmControllerDemo`
(`f02a7602…` -> `8916027b…`), and `AppTheoryS3VectorsSemanticSearch` (`0f5e1203…` -> `0791b952…`). The other
eight stacks kept their hashes. `scripts/verify-cdk-synth.sh` passed from the primary checkout and from a `cp -R`
copy at a different absolute path; the copy was removed after the run.
