# AppTheory: 10/10 Rubric (Quality, Consistency, Completeness, Security, Compliance Readiness, Maintainability, Docs)

This rubric defines what “10/10” means and how category grades are computed. It is designed to prevent goalpost drift and
“green by dilution” by making scoring **versioned, measurable, and repeatable**.

## Versioning (no moving goalposts)
- **Rubric version:** `v1.5.1` (2026-06-08)
- **Comparability rule:** grades are comparable only within the same version.
- **Change rule:** bump the version + changelog entry for any rubric change (what changed + why).

### Changelog
- `v1.5.1`: Align the AppTheory release lifecycle gate with the served `gov_rubric_report.v1` schema by reporting it as `CMP-4` while preserving the same repo-local release verifier.
- `v1.5.0`: Add release lifecycle governance evidence for the single AppTheory release train, including release state, promotion, and workflow invariant checks.
- `v1.4.0`: Enforce the Pay Theory documentation standard across shipped packages (repo docs + TS/Py/CDK docs), including the YAML knowledge-base triad, via deterministic verification.
- `v1.3.0`: Raise the coverage requirement to **≥ 90%** across all shipped runtimes (Go/TypeScript/Python) and enforce the same floor in the verifier.
- `v1.2.0`: Raise the coverage requirement to **≥ 75%** across all shipped runtimes (Go/TypeScript/Python) and enforce the same floor in the verifier.
- `v1.1.0`: Expand unit-test and coverage scope to **all shipped runtimes** (Go/TypeScript/Python). Previously the rubric and verifier only enforced Go coverage.
- `v1.0.0`: Initial GovTheory rubric for AppTheory (custom domain). Establishes cross-language contract parity, multi-module health, supply-chain checks, and anti-drift gates.

## Scoring (deterministic)
- Each category is scored **0–10**.
- Point weights sum to **10** per category.
- Requirements are **pass/fail** (either earn full points or 0).
- A category is **10/10 only if all requirements in that category pass**.

## Verification (commands + deterministic artifacts are the source of truth)
Every rubric item has exactly one verification mechanism:
- a command (`make ...`, `go test ...`, `bash scripts/...`), or
- a deterministic artifact check (required doc exists and matches an agreed format).

Enforcement rule (anti-drift):
- If an item’s verifier is a command/script, it only counts as passing once it runs in CI and produces evidence.

---

## Quality (QUA) — reliable, testable, change-friendly
| ID | Points | Requirement | How to verify |
| --- | ---: | --- | --- |
| QUA-1 | 4 | Unit tests stay green (Go/TypeScript/Python) | `gov_cmd_unit` (inside `gov-verify-rubric.sh`) |
| QUA-2 | 3 | Integration/runtime tests stay green | `scripts/verify-testkit-examples.sh` |
| QUA-3 | 3 | Coverage ≥ 90% (Go/TypeScript/Python; no denominator games) | `check_coverage` (inside `gov-verify-rubric.sh`) |

**10/10 definition:** QUA-1 through QUA-3 pass.

## Consistency (CON) — one way to do the important things
| ID | Points | Requirement | How to verify |
| --- | ---: | --- | --- |
| CON-1 | 3 | Formatter clean (no diffs) | `make fmt-check` |
| CON-2 | 5 | Lint/static analysis green (pinned version) | `make lint` |
| CON-3 | 2 | Public boundary contract parity (cross-language semantics) | `scripts/verify-contract-tests.sh` |

**10/10 definition:** CON-1 through CON-3 pass.

## Completeness (COM) — verify the verifiers (anti-drift)
| ID | Points | Requirement | How to verify |
| --- | ---: | --- | --- |
| COM-1 | 2 | All modules compile (no “mystery meat”) | `check_multi_module_health` (inside `gov-verify-rubric.sh`) |
| COM-2 | 2 | Toolchain pins align to repo (Go/Node/Python + lint tools) | `check_toolchain_pins` (inside `gov-verify-rubric.sh`) |
| COM-3 | 2 | Lint config schema-valid (no silent skip) | `check_lint_config_valid` (inside `gov-verify-rubric.sh`) |
| COM-4 | 2 | Coverage threshold not diluted (≥ 90%) | `check_coverage_threshold_floor` (inside `gov-verify-rubric.sh`) |
| COM-5 | 1 | Security scan config not diluted (no excluded high-signal rules) | `check_security_config` (inside `gov-verify-rubric.sh`) |
| COM-6 | 1 | Logging/operational standards enforced (if applicable) | `check_logging_ops_standards` (inside `gov-verify-rubric.sh`) |

**10/10 definition:** COM-1 through COM-6 pass.

## Security (SEC) — abuse-resilient and reviewable
| ID | Points | Requirement | How to verify |
| --- | ---: | --- | --- |
| SEC-1 | 3 | Static security scan green (pinned version) | `scripts/verify-go-lint.sh` |
| SEC-2 | 3 | Dependency vulnerability scan green | `gov_cmd_vuln` (inside `gov-verify-rubric.sh`) |
| SEC-3 | 2 | Supply-chain verification green | `check_supply_chain` (inside `gov-verify-rubric.sh`) |
| SEC-4 | 2 | P0 integrity regression tests (build determinism) | `scripts/verify-builds.sh` |

**10/10 definition:** SEC-1 through SEC-4 pass.

### SEC-2 dependency-audit exceptions: two live operator-ruled exceptions

SEC-2 grants **no dependency-audit exceptions** beyond the two live ones below (E2 is the AWS-published jsii
dev-toolchain chain in the CDK lockfile class; E5 is the 2026-11-17 dev-only picomatch chain). Each is an exact match
(lockfile, package, version, node path / dependency chain, and advisory ids) and is **self-expiring and
fail-closed**: it carries a hard `recheck_by` deadline, a removal probe runs on every invocation so a stale exception
cannot survive by never matching again (registry-backed for the jsii chain and for E5's `ts/` shape, lockfile-local
for E5's `cdk/` shape), and when a removal condition is met the checker fails with a clear message. Any
*other* finding, in any lockfile, still fails the gate. Nothing beyond these two may be added without a new operator
ruling.

Operator rulings, quoted verbatim:

> 2026-10-03: "if a vulnerable dependency is bundled in AWS we make an exception until its updated there."

> 2026-10-04: the same treatment applies, for consistency, to AWS-published build toolchain transitive
> chains with no upstream fix.

> 2026-11-01: "Dev-only exception" - override minimatch to 11.0.1 everywhere except eslint-plugin-import-x,
> keep import-x on 10.2.6, and record the single remaining 10.2.6 node path as a reviewed exception.
> (Retired with E4 on 2026-11-06; kept here as the ruling that created it.)

> 2026-11-17: a scoped, expiring exception for `picomatch` while `GHSA-fc5q-39xc-vjpf` has no patched upstream
> release: only that advisory, only `picomatch`, and only on lockfile paths that are proven dev-only, with
> `recheck_by: 2026-12-01`, the removal condition "a picomatch release patches GHSA-fc5q-39xc-vjpf", and a
> justification recorded in the checker. (E5, below. The ruling is quoted in Factory docs/058 DEPS-20261117.)

**E1 (retired 2026-10-10) - brace-expansion 5.0.9 bundled inside aws-cdk-lib.** Findings
`GHSA-q2hr-2g5m-vwhr`, `GHSA-qhr7-859c-m2p7`, and `GHSA-6j4f-fj2g-mc7p` on
`brace-expansion@5.0.9` at `node_modules/aws-cdk-lib/node_modules/brace-expansion` (bundled), reached only
through aws-cdk-lib's own bundled `minimatch`. AWS publishes it and only AWS can publish a tarball that
bundles the patched release (`brace-expansion >= 5.0.12` exists on npm but cannot be installed into the
bundled subtree); it is build-time only and no AppTheory runtime package or Lambda ships it. Scope
(widened 2026-10-06): every npm lockfile in this repository whose installed tree carries that bundled path
- the cdk lockfile plus the `examples/cdk/*/package-lock.json` files (twelve at the widening; fifteen after
LOCAL-A1 added media-cdn, path-routed-frontend and restv1-router). Before the widening the scope was cdk/
plus four examples, which left eight example lockfiles carrying the identical vulnerable AWS path with no
gate coverage and no recorded exception; the SEC-2 Node scan set is now the same full list, so every
lockfile is either reported vulnerable or reported excepted. Owner: AppTheory steward
(Factory dependency sweeps). **Removal condition:** the `aws-cdk-lib` version this repository pins bundles
`brace-expansion >= 5.0.12`. **That condition was met:** the pinned aws-cdk-lib 2.275.0 tarball bundles
the patched `brace-expansion@5.0.12`, so the exception was retired as standard maintenance and the
bundled-graph anchor now asserts the fixed bundle positively.

**E2 - braces 3.0.3 in the jsii build toolchain.** Finding `GHSA-vfj7-8cjw-p6xm` (high) on `braces@3.0.3`
at `node_modules/braces`, reached only via `jsii-pacmak -> jsii-rosetta -> fast-glob -> micromatch ->
braces`; npm also lists the derived `micromatch`, `fast-glob`, `jsii-rosetta`, and `jsii-pacmak` entries,
which are pure propagation of this single advisory. The advisory's range is `affected <= 3.0.3` and npm
publishes **no** patched `braces`, so no installable version pair clears it; the chain is the dev
toolchain of the cdk devDependency `jsii-pacmak`, build-time only. Scope: `cdk/package-lock.json` only
(the example lockfiles do not carry the jsii chain). **Removal condition:** a patched `braces` (> 3.0.3)
is published, or the jsii toolchain no longer resolves `braces <= 3.0.3`. **Hard recheck by 2026-12-01
(renewed 2026-11-01 from 2026-11-02).** The renewal is standard maintenance under the same 2026-10-04
ruling, not a new exception grant: on **2026-11-01** the npm registry's latest published `braces` was still
**3.0.3**, so no patched release exists and the removal condition remains unmet. The checker records the
renewal and its evidence in `E2.renewal`.

**E3 (retired 2026-11-21) - minimatch 10.2.6 bundled inside aws-cdk-lib.** Finding
`GHSA-g3hv-75wg-m249` (moderate, `CVE-2026-118764`) on `minimatch@10.2.6` at
`node_modules/aws-cdk-lib/node_modules/minimatch` (bundled), reached only through aws-cdk-lib's own bundled
`minimatch`. **Removal condition:** the pinned `aws-cdk-lib` bundles `minimatch >= 11.0.1`. **That condition was met
on 2026-11-21:** this repository moved the exact peer/dev pin to `aws-cdk-lib` 2.278.0, whose public npm tarball
(registry integrity checked) bundles `minimatch 11.0.9`. The exception,
its `recheck_by`, and its removal probe were removed as standard maintenance, not a new exception grant. The
bundled-graph anchor now asserts the fixed bundle positively (exact `minimatch 11.0.9`, never below the `11.0.1`
floor, plus `brace-expansion 5.0.13`), so an affected bundled copy, a second `minimatch` instance, or any
node-path drift still fails closed as an unexpected finding.

**E5 - picomatch <= 4.0.7 in the dev-only lint and build toolchains (added 2026-11-17).** Finding
`GHSA-fc5q-39xc-vjpf` (high, `CVE-2026-112366`) on `picomatch`, whose advisory range is `<= 4.0.7` with **no
`fixed` event**: `npm view picomatch version` is `4.0.7` (checked 2026-11-17), so no installable release clears it.
OSV flags exactly two copies across the whole SEC-2 scan set, and both are `dev: true`:

- `ts/package-lock.json`: `picomatch@4.0.7` at `node_modules/picomatch`, reached only through
  `@typescript-eslint/parser` (a ts `devDependency`) -> `@typescript-eslint/typescript-estree` -> `tinyglobby`
  (`picomatch ^4.0.4`) and `tinyglobby`'s `fdir` peer edge (`picomatch ^3 || ^4`). Every chain node is `dev: true`,
  the root package declares no picomatch runtime dependency, and `npm ls --omit=dev --all` inside `ts/` reports none.
- `cdk/package-lock.json`: `picomatch@2.3.2` at `node_modules/picomatch`, reached only through `jsii-rosetta` (a cdk
  `devDependency`) -> `fast-glob` -> `micromatch` (`picomatch ^2.3.1`); the cdk override pins `2.3.2`. Every chain
  node is `dev: true`, and `cdk/package.json` declares **no** runtime `dependencies` at all.
- Every `examples/cdk/*/package-lock.json` carries **no** picomatch copy, so the exception has no example scope.

**Removal condition:** a picomatch release patches `GHSA-fc5q-39xc-vjpf` (a stable `picomatch >= 4.0.8`, the first
release above the advisory's last affected `4.0.7`, is published) and the affected toolchain resolves it, or the
lockfile no longer resolves picomatch `<= 4.0.7`. **Hard recheck by 2026-12-01.** For the `ts/` shape the removal
probe reads the npm registry on every invocation; for the `cdk/` shape it is lockfile-local, because a published
`4.0.8` cannot reach the cdk graph until `micromatch` changes its `^2.3.1` range, so a registry read there would fire
the removal message while no installable fix exists. The checkers fail closed on the same advisory on a non-dev or
additional node path, another advisory on picomatch, another package carrying this GHSA, a drifted chain, or a passed
`recheck_by`. Operator ruling: 2026-11-17 (quoted above; Factory docs/058 DEPS-20261117). Owner: AppTheory steward
(Factory dependency sweeps).

The scan-set completeness is itself gated: `gov-verify-rubric.sh` compares `node_lockfiles` with
`git ls-files '*package-lock.json' '*npm-shrinkwrap.json'` before scanning and fails when a tracked
lockfile is missing, and `check-visible-aws-cdk-finding.mjs --self-test` performs the same comparison
against `AWS_CDK_LOCKFILES`. A new example lockfile therefore cannot be added without either being
scanned or failing SEC-2.

**E4 (retired 2026-11-06) - minimatch 10.2.6 kept for eslint-plugin-import-x (TypeScript lint tooling, dev-only).**
Finding `GHSA-g3hv-75wg-m249` (moderate, `CVE-2026-118764`) on `minimatch@10.2.6` at
`node_modules/eslint-plugin-import-x/node_modules/minimatch`, resolved only by the
`eslint-plugin-import-x` lint-plugin edge. Every other minimatch consumer in `ts/package-lock.json` -
`eslint`, `@eslint/config-array`, and `@typescript-eslint/typescript-estree` - was overridden to the
patched `minimatch@11.0.1`; the graph anchor pinned both minimatch nodes and the exact parent set, and any
parent, path, version, or override drift failed closed. The blocked upgrade at the time: `minimatch 11`
removed the `makeRe` export that `eslint-plugin-import-x` 4.17.1 imports at module load, so loading the
plugin under a minimatch 11 override threw and ESLint could not load its config; 4.17.1 was the latest
published release and declared minimatch `^9.0.3 || ^10.1.2`. **Dev-only:** the node was `dev: true`, the
root package's runtime dependencies do not mention minimatch, `npm ls --omit=dev --all` inside `ts/`
reported no minimatch, and the published package ships only `dist`, `LICENSE`, `README.md`, and
`package.json`. Scope: `ts/package-lock.json` only. Owner: AppTheory steward (Factory dependency sweeps).
**Removal condition:** `eslint-plugin-import-x` publishes a release compatible with `minimatch >= 11.0.1`.
**That condition was met:** on 2026-11-06 the operator adopted `eslint-plugin-import-x` 4.18.0, whose
published minimatch range is `^9.0.3 || ^10.1.2 || ^11.0.1` and whose `no-internal-modules` rule no longer
imports `makeRe` (upstream #570). The dev-only override, the exception, its registry-backed removal probe,
and its recheck deadline were removed; `ts/package-lock.json` now resolves a single `minimatch@11.0.9` for
every consumer (moved from `11.0.1` on 2026-11-17 when `eslint` 10.15.0 raised its own range to `^11.0.5`). Operator ruling: 2026-11-01 (the dev-only exception quoted above).

The remaining exceptions (E2 and E5's `cdk/` shape) live in the ONE shared list in `scripts/check-visible-aws-cdk-finding.mjs`; the npm and OSV scanner paths match findings against that same list,
`scripts/verify-cdk-audit.sh` and `gov-verify-rubric.sh`'s `osv_scan_lockfile` accept a non-zero scanner exit only
when the checker emits the `exception-applied:` machine marker, and the checker's `--self-test` battery proves the
negative cases (a different advisory id, version, node path, or lockfile, a non-dev copy, an expired `recheck_by`, or
a met removal condition) still fail closed.

The TypeScript lockfile keeps the patched minimatch graph and adds E5's `ts/` shape.
`scripts/check-visible-ts-brace-finding.mjs`, which the same `osv_scan_lockfile` routes `ts/package-lock.json` to,
enforces exactly one minimatch node (`11.0.9` at `node_modules/minimatch`), any minimatch below `11.0.1` at any node
path failing closed, the exact brace-expansion and runner nodes, the exact minimatch parent set, the exact override
map, and E5's single dev `picomatch@4.0.7` with its exact chain. Its `--self-test` battery proves that a vulnerable
copy reintroduced at the old `eslint-plugin-import-x` path, any other minimatch path, version, parent, override map,
or lockfile, any finding outside E5, the same GHSA on another package, another advisory on picomatch, a non-dev or
additional picomatch path, a drifted chain, an expired `recheck_by`, and a met removal condition all fail (48 offline
cases). The gate now requires the `exception-applied:` marker for the TypeScript lockfile too, so a status-1 scan
without E5's marker fails closed.

This section previously recorded that SEC-2 carried **no** exception. The pattern reused here is the one
SEC-2's earlier exception established: advisory `GHSA-528h-pc64-c93x` / `CVE-2026-71429` for
`stream-json < 3.5.0`, reached only through `jsii-rosetta` (a peer of the `jsii-pacmak` cdk
devDependency), operator-ruled 2026-09-20 (Factory sweep 2026-09; companion to PR #998) and matched
exactly (no severity, count, or blanket allowlists). It was upstream-blocked: every patched `stream-json`
release was ESM-only, which broke `jsii-rosetta`'s CommonJS subpath requires under `jsii-pacmak`, while
every stable `jsii-rosetta` inside `jsii-pacmak`'s peer range (`>= 5.9.0`, 5.9.0 through 6.0.15) pinned
`stream-json ^1.9.1`.

**Resolution (2026-09-22).** That exception's own removal condition fired: the npm registry published a
STABLE `jsii-rosetta >= 6.0.16`, `cdk/package.json` now pins `jsii-rosetta 6.0.16`, and
`cdk/package-lock.json` resolves `stream-json` 3.7.0, so `npm audit` on `cdk/` reported an empty
vulnerability map. The exception and all of its machinery were removed at the time and are re-created
here, narrowed to the AWS-blocked findings recorded in this section.

## Compliance Readiness (CMP) — auditability and evidence
| ID | Points | Requirement | How to verify |
| --- | ---: | --- | --- |
| CMP-1 | 3 | Controls matrix exists and is current | File exists: `gov-infra/planning/apptheory-controls-matrix.md` |
| CMP-2 | 2 | Evidence plan exists and is reproducible | File exists: `gov-infra/planning/apptheory-evidence-plan.md` |
| CMP-3 | 2 | Threat model exists and is current | File exists: `gov-infra/planning/apptheory-threat-model.md` |
| CMP-4 | 3 | Release lane invariants stay enforced: `staging` → `premain` → `main` → `staging`, Release Please state, publisher recovery, and promotion guards | `check_release_lifecycle_invariants` (inside `gov-verify-rubric.sh`) |

**10/10 definition:** CMP-1 through CMP-4 pass.

## Maintainability (MAI) — convergent codebase (recommended for AI-heavy repos)
| ID | Points | Requirement | How to verify |
| --- | ---: | --- | --- |
| MAI-1 | 4 | File-size/complexity budgets enforced | `check_file_budgets` (inside `gov-verify-rubric.sh`) |
| MAI-2 | 3 | Maintainability roadmap current | `check_maintainability_roadmap` (inside `gov-verify-rubric.sh`) |
| MAI-3 | 3 | Canonical implementations (no duplicate semantics) | `check_duplicate_semantics` (inside `gov-verify-rubric.sh`) |

**10/10 definition:** MAI-1 through MAI-3 pass.

## Docs (DOC) — integrity and parity
| ID | Points | Requirement | How to verify |
| --- | ---: | --- | --- |
| DOC-1 | 1 | Threat model present | File exists: `gov-infra/planning/apptheory-threat-model.md` |
| DOC-2 | 1 | Evidence plan present | File exists: `gov-infra/planning/apptheory-evidence-plan.md` |
| DOC-3 | 1 | Rubric + roadmap present | Files exist: `gov-infra/planning/apptheory-10of10-rubric.md`, `gov-infra/planning/apptheory-10of10-roadmap.md` |
| DOC-4 | 2 | Gov doc integrity (tokens, version claims) | `check_doc_integrity` (inside `gov-verify-rubric.sh`) |
| DOC-5 | 2 | Threat ↔ controls parity | (built into verifier; writes `gov-infra/evidence/DOC-5-parity.log`) |
| DOC-6 | 3 | Pay Theory documentation standard enforced (packages) | `check_docs_standard` (inside `gov-verify-rubric.sh`) |

**10/10 definition:** DOC-1 through DOC-6 pass.

## Maintaining 10/10 (recommended CI surface)
Minimal command set CI should run in protected branches (no `latest` tools; pinned versions only):

```bash
make fmt-check
make lint
make test-unit
scripts/verify-testkit-examples.sh
scripts/verify-contract-tests.sh
bash gov-infra/verifiers/gov-verify-rubric.sh
```

Notes:
- `bash gov-infra/verifiers/gov-verify-rubric.sh` is the deterministic single entrypoint; it produces the machine report at
  `gov-infra/evidence/gov-rubric-report.json`.
- Items explicitly marked **BLOCKED** are treated as **BLOCKED** until implemented; do not remove them without a rubric version bump.
