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
        "github\\.com/theory-cloud/apptheory/v7\\s+v(?<currentValue>\\d+\\.\\d+\\.\\d+(?:-rc(?:\\.\\d+)?)?)",
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
github.com/theory-cloud/apptheory/v7 v7.0.0
https://github.com/theory-cloud/AppTheory/releases/download/v7.0.0/theory-cloud-apptheory-7.0.0.tgz
https://github.com/theory-cloud/AppTheory/releases/download/v7.0.0/theory-cloud-apptheory-cdk-7.0.0.tgz
https://github.com/theory-cloud/AppTheory/releases/download/v7.0.0/apptheory-7.0.0-py3-none-any.whl
https://github.com/theory-cloud/AppTheory/releases/download/v7.0.0/apptheory_cdk-7.0.0-py3-none-any.whl
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
VERSION=7.0.0
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
- `@eslint/config-array` / `eslint` / `@typescript-eslint/typescript-estree` / `eslint-plugin-import-x` → `minimatch`:
  the lint stack remains audit-clean on its upstream-selected `minimatch` versions, and none of these packages are
  runtime dependencies. **Reinstated 2026-11-01** for `GHSA-g3hv-75wg-m249`: the fresh advisory affected every
  minimatch `< 11.0.1`, and the lint stack could not simply take 11 because `eslint-plugin-import-x` imported the
  removed `makeRe` export. **Simplified 2026-11-06:** `eslint-plugin-import-x` 4.18.0 accepts minimatch 11
  (`^9.0.3 || ^10.1.2 || ^11.0.1`) and no longer imports `makeRe` (upstream #570), so the dev-only 10.2.6 override
  and its exception were removed; the overrides now pin `11.0.1` for every consumer.
- `fast-xml-parser` / `fast-xml-builder`: the regenerated TypeScript lockfile no longer contains those packages, so
  keeping orphan overrides would hide dependency graph drift instead of fixing it.
- `flatted` / `js-yaml`: upstream-selected lint-tool transitive versions remain audit-clean; local pins were redundant.
- `yaml`: the TableTheory release asset now resolves `yaml@2.9.1`; AppTheory should not override TableTheory's
  transitive dependency unless a current advisory or contract gate requires it.

The repository pins AWS CDK `2.278.0`, whose public npm tarball (registry integrity checked) bundles the patched
`minimatch@11.0.9` and `brace-expansion@5.0.13`. That meets the documented removal conditions of two former
bundled-dependency exceptions, so both are retired - standard maintenance, not a new exception grant:
`brace-expansion 5.0.9` (operator-ruled 2026-10-03) and `minimatch < 11.0.1` (`GHSA-g3hv-75wg-m249`, retired
2026-11-21). The CDK npm-audit and GovTheory OSV gates still verify the exact bundled graph, now as a positive
assertion (`minimatch 11.0.9`, never below the `11.0.1` floor, and `brace-expansion >= 5.0.12`), and accept exactly
one reviewed, self-expiring CDK-lockfile exception - `braces 3.0.3` reached only through the
`jsii-pacmak` / `jsii-rosetta` / `fast-glob` / `micromatch` dev chain (operator-ruled 2026-10-04) - plus the
2026-11-17 dev-only picomatch chain (E5). The `braces` exception carries a hard `recheck_by` deadline (2026-12-01;
renewed 2026-11-01 from 2026-11-02 because the registry still published no patched `braces`, latest `3.0.3`) and a
removal condition (see `gov-infra/planning/apptheory-10of10-rubric.md` SEC-2). The 2026-11-01 refresh moved the pin
from `2.273.0` to `2.275.0`; the 2026-11-17 refresh moved it to `2.277.0`; the 2026-11-21 AT-CDK2278 change moved it
to `2.278.0`, whose tarball no longer carries an affected `minimatch`. The stale `aws-cdk-lib.minimatch: 10.2.4`
overrides were removed from `cdk/` and the affected examples at the same time: a probe proved npm never rewrites
bundled dependency contents, so the pin was inert and only named an affected release in the manifests.
Any vulnerable bundle, AWS CDK, minimatch, brace-expansion, package-path, or finding drift fails closed.

The TypeScript lint graph carries one active `overrides` block and no dependency-audit exception. `ts/package.json`
overrides `minimatch` to the patched `11.0.9` for `eslint`, `@eslint/config-array`, and
`@typescript-eslint/typescript-estree`, and `eslint-plugin-import-x` declares
`^9.0.3 || ^10.1.2 || ^11.0.1`, so every consumer dedupes onto the single hoisted `node_modules/minimatch` node.
The 2026-11-17 refresh moved the override from `11.0.1` to `11.0.9` because `eslint` 10.15.0 raised its own
minimatch range to `^11.0.5`; `11.0.9` is the newest `11.x`, satisfies every consumer's range, and still clears the
advisory's `11.0.1` floor.
The 2026-11-06 adoption of 4.18.0 retired the dev-only exception E4: upstream #570 replaced the
`no-internal-modules` rule's `makeRe` import with `Minimatch#match`, which is what had blocked minimatch 11 under
4.17.1. The 10.2.6 override, the exception, its registry-backed removal probe, and its `recheck_by` deadline were
removed. It remains lint tooling only: every minimatch node is `dev: true`, the root package declares no minimatch
runtime dependency, `npm ls --omit=dev --all` inside `ts/` reports none, and the published package ships only
`dist`, `LICENSE`, `README.md`, and `package.json`. The checker requires the exact minimatch / brace-expansion /
runner (`@isaacs/nonrecursive-glob-match`) graph, the exact minimatch parent set, and the exact override map; any
minimatch below `11.0.1` at any node path, and any other advisory, version, path, or lockfile, fails closed. The
`ts/` brace-expansion path is likewise exception-free: the only instance (`5.0.12`) is past every recorded 5.x fix.

The TypeScript lint graph also carries the 2026-11-17 dev-only picomatch exception, E5. `GHSA-fc5q-39xc-vjpf`
(high, `CVE-2026-112366`) covers every picomatch `<= 4.0.7` with no patched release - npm's latest is `4.0.7` and the
advisory has no `fixed` event - so the `@typescript-eslint/parser -> @typescript-eslint/typescript-estree ->
tinyglobby -> picomatch` chain cannot be upgraded out of it. Operator-ruled 2026-11-17 for this exact dev-only
chain; `ts/package-lock.json` resolves a single `picomatch@4.0.7` at `node_modules/picomatch` with `dev: true`, the
root package declares no picomatch runtime dependency, and `npm ls --omit=dev --all` inside `ts/` reports none. The
checker pins the exact node, version, dev flag, chain edges, and advisory id/aliases; a stable picomatch `>= 4.0.8`
publish (registry-backed probe), a removal-condition match, or the `2026-12-01` `recheck_by` deadline fails the gate
until the exception is removed or renewed.


The 2026-11-06 `eslint` 10.13.0 -> 10.14.0 move (Dependabot #1222) is an in-family devDependency bump. eslint's own
`minimatch` range moved `^10.2.5` -> `^10.2.6`, which the override resolves onto the hoisted `11.0.1`, so the
minimatch node set and the brace-expansion node are unchanged, and no exception node remains. Only the anchor's
recorded `eslint` parent version and range moved with the package; no override was added, dropped, or loosened, and
`@humanfs/node` re-resolved `0.16.6` -> `0.16.8` inside eslint's own range.

## Refresh register (2026-11-01, LOCAL-M0)

The 2026-11-01 dependency refresh re-resolved every checked-in lockfile against its declared range, aligned
`aws-cdk-lib` and the `aws-cdk` CLI, and re-checked the two pinned audit tools. No `npm --before` or
`uv --exclude-newer` cutoff was required: every fresh resolution passed the repository gates. One tool upgrade is
held.

### Holds

| Held item | Kept at | Reason | Re-check condition |
| --- | --- | --- | --- |
| `osv-scanner` v2.x | `v1.9.2` | `v2.7.0` cannot replace the gate's scanner yet. On `ts/package-lock.json` (which pins the TableTheory GitHub-release tarball by sha512) it exits `127` with `vulnmatch/osvdev ... 400 Bad Request ... invalid hash` and emits `{"results":[]}`. The rubric accepts only exit `0` (clean) or `1` (findings covered by a reviewed exception marker - `ts/` now carries the E5 picomatch exception, so a status-1 scan needs its `exception-applied: ts-dev-picomatch` marker); `127` is an operational failure. On `cdk/package-lock.json` and example locks it exits `0` but returns zero packages, so it would not independently confirm the bundled graph; the lockfile-local fixed-graph anchor still fails closed on a vulnerable bundle. | Retry when v2 parses `ts/package-lock.json` without the hash error and reproduces the v1.9.2 findings on `cdk/package-lock.json` and the example locks. |

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
- **E4 `minimatch 10.2.6` for `eslint-plugin-import-x`**: **retired 2026-11-06.** `eslint-plugin-import-x` 4.18.0
  declares `^9.0.3 || ^10.1.2 || ^11.0.1` and no longer imports `makeRe` (upstream #570), meeting the removal
  condition. The 10.2.6 override, the exception, and its probe were removed; `ts/package-lock.json` now resolves a
  single `minimatch 11.0.1` for every consumer.

### Synth hashes

Only the three stacks whose bundled Go assets include the refreshed module graph moved:
`AppTheoryHelloWorldGo` (`0d48e5da…` -> `b73043ab…`), `AppTheoryMicrovmControllerDemo`
(`f02a7602…` -> `8916027b…`), and `AppTheoryS3VectorsSemanticSearch` (`0f5e1203…` -> `0791b952…`). The other
eight stacks kept their hashes. `scripts/verify-cdk-synth.sh` passed from the primary checkout and from a `cp -R`
copy at a different absolute path; the copy was removed after the run.

## Refresh register (2026-11-21, AT-CDK2278)

The exact AWS CDK peer/dev pin moved from `2.277.0` to `2.278.0` in `cdk/package.json`, in all 22
`examples/cdk/*/package.json` manifests, and in the three `templates/apptheory-init/*/package.json.tmpl` files; the cdk
and example lockfiles, `cdk/.jsii`, `cdk/lib`, and the generated `cdk-go` bindings were regenerated through the
repository's own scripts. No runtime package, version literal, or compatibility range changed.

- **Physical package verification.** The public `aws-cdk-lib@2.278.0` tarball was downloaded from the npm registry and
  its SHA-512/SHA-1 matched the registry metadata exactly. Its own `package.json` declares `minimatch ^11.0.9`, and the
  extracted tarball carries exactly one `node_modules/minimatch` at **11.0.9** (with `brace-expansion 5.0.13`) and no
  10.x copy. The `2.277.0` tarball, by contrast, carries `10.2.6`.
- **E3 retired.** The retired `minimatch 10.2.6` bundled exception's removal condition was met, so the exception, its
  `recheck_by`, and its lockfile-local removal probe were removed. The bundled-graph anchor now asserts the fixed graph
  positively: `aws-cdk-lib` 2.278.0, bundled `minimatch 11.0.9` never below `11.0.1`, and `brace-expansion 5.0.13`.
  The checker's self-test proves the former E3 finding shapes no longer match any exception.
- **Stale overrides removed.** The inert `overrides.aws-cdk-lib.minimatch: 10.2.4` entries were removed from `cdk/` and
  thirteen example manifests. An isolated install probe showed npm never rewrites bundled dependency contents, so the
  pin never changed resolution; it only named an affected release in the manifests (including the published package).
- **Synth drift.** Three snapshots moved, and every changed line is an asset identity only: the `aws-cdk-lib`
  `AwsCliLayer` zip used by `BucketDeployment` (`ssr-site`, `ssr-only-provided-assets-site`) and the
  `AwsCustomResource` provider asset (`local-resources`). No CloudFormation resource, property, IAM statement, route, or
  output changed. Old/new hashes: `ssr-site` `a4d1b4d9…` -> `1c432fe2…`, `ssr-only-provided-assets-site`
  `55186ad7…` -> `fb43a448…`, `local-resources` `d918d5cc…` -> `7ea4a461…`. The other 21 example snapshots are
  unchanged. This is offline synth evidence, not deployment proof.

## Refresh register (2026-11-24, TT-6.5.3)

TableTheory moved from `6.5.2` to `6.5.3` in all three runtimes at once, because a pinned runtime that lags the others
is a parity defect rather than a staged rollout. The release is stable (`v6.5.3`, eight assets, tag
`dd65abb9faa7ebd14a19b5acdd9b98f0df6fcb4d`).

| Surface | Change |
| --- | --- |
| `go.mod` / `go.sum` | `github.com/theory-cloud/tabletheory/v6` `v6.5.2` -> `v6.5.3` via `go get` + `go mod tidy`. No other module in the graph moved: the diff is one `require` line and two `go.sum` lines. |
| `py/pyproject.toml`, `py/requirements-lint.txt` | Wheel URL `v6.5.3/tabletheory_py-6.5.3-py3-none-any.whl`, checksum `sha256:52852ade5da87749306898ae4249824f7254cd2fa3a78e8c2fa55bb77b3c42d3`. |
| `ts/package.json`, `ts/package-lock.json` | Tarball URL `v6.5.3/theory-cloud-tabletheory-ts-6.5.3.tgz`, integrity `sha512-Up6C1FwuVS5YHl4J1rp3MspC/HXF82eO97DONd4XT9powu97mApBsaPDt4OI9WRvzjsE7PuVuREOjzhL20wmJA==`, lockfile regenerated by `npm install` and re-resolved to that single node. |

- **Checksum discipline.** Both digests were computed from the downloaded release assets and cross-checked against the
  release's published `tabletheory-SHA256SUMS.txt`; npm additionally verified the tarball's `sha512` on install.
- **Synth hashes.** Six pinned templates moved — exactly the stacks whose bundled Go binary or vendored TypeScript
  runtime closure contains the TableTheory code, and therefore the ones the pins exist to move:

  | Stack | Old | New |
  | --- | --- | --- |
  | `AppTheoryHelloWorldGo` | `ad356e1a…` | `d7ce9fcc…` |
  | `AppTheoryHelloWorldTs` | `6c9f705f…` | `6d8a47c5…` |
  | `AppTheoryMultilangDemo` | `7819f6d5…` | `e1227e18…` |
  | `AppTheoryMicrovmControllerDemo` | `6d391599…` | `96c76883…` |
  | `AppTheoryS3VectorsSemanticSearch` | `8ada7b95…` | `d90998bd…` |
  | `AppTheoryLocalMcpAuthFacade` | `4daa4beb…` | `168a1297…` |

  `local-mcp-auth-facade` moves because it sets an explicit `assetHashType: CUSTOM` hash over the handler directory,
  `runtime/`, `go.mod`, and `go.sum` precisely so a dependency move surfaces in the pinned template; the other five
  move because their staged assets contain the built runtime. In every case the move is the designed behaviour rather
  than drift: synthesizing each stack at the pre-bump tree reproduced the old pin and at the bumped tree reproduced the
  new one, and each template diff is asset identity only (`Code.S3Key` and the `aws:asset:path` metadata) with no
  CloudFormation resource, property, IAM statement, route, or output changed. The other 18 example snapshots kept their
  hashes.
- **No other version literal, fixture, API snapshot, or manifest range changed.** `VERSION` stays `7.5.0-rc.2`; the move
  ships with the next AppTheory release instead of forcing one now.

This is offline synth evidence, plus the repository's own contract and rubric gates, not deployment proof.
