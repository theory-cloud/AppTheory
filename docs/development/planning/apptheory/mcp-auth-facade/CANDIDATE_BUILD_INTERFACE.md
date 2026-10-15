# Candidate-build interface for lab proof (M0, item 9)

Status: **implemented in M4**. `scripts/lab/candidate-build.sh` exists, is offline self-tested, and is wired into
`make rubric`; §4.1 records the interface as built and the integration note for the adoption stewards. Consuming it
is still the apps' work (M5): AppTheory builds nothing against an application and never calls AWS.
Last updated: 2026-10-14
Owner: AppTheory

ADV-P110-5: the "build AppTheory at a pinned commit" lab mode must bind **every consumed surface** to the
same commit with **per-surface hash verification**, and the receipt must stamp each. Otherwise a lab proof can
run a candidate runtime against a released CDK package (or vice versa) and prove nothing. The mode must be
driven by **encoded stage config**, never an operator environment variable, and must be **incapable of
targeting live**.

This document is the interface AppTheory offers to the application deploy scripts (TMS
`scripts/deploy/theorymcp-cdk.mjs`; Autheory `cdk/deploy.sh` + `app-theory/stages/{lab,live,staging}.json`).
Consuming it is the apps' work (M5); AppTheory specifies and, in M4, provides the builder script.

## 1. Consumed surfaces

| # | Surface | Consumer | Artifact / handle |
| --- | --- | --- | --- |
| S1 | Go runtime module `github.com/theory-cloud/apptheory/v6` | TMS Go API, Autheory Go services | exported **root Go module** tree of the pinned commit (the `git archive` of the repository minus the nested `cdk-go` module) |
| S2 | Go CDK bindings module `github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v6` | Go CDK consumers | exported **`cdk-go/apptheorycdk` module** tree of the pinned commit (a distinct subtree, so its hash differs from S1's) |
| S3 | npm CDK package `@theory-cloud/apptheory-cdk` | TMS CDK (`cdk/lib/mcp-server-surface.ts` import) | `theory-cloud-apptheory-cdk-<version>.tgz` |
| S4 | npm TS runtime `@theory-cloud/apptheory` | TS consumers | `theory-cloud-apptheory-<version>.tgz` |
| S5 | Python runtime `apptheory` | Python consumers | `apptheory-<version>-py3-none-any.whl`, `apptheory-<version>.tar.gz` |
| S6 | Python CDK `apptheory-cdk` (jsii) | Python CDK consumers | `apptheory_cdk-<version>-py3-none-any.whl`, `apptheory_cdk-<version>.tar.gz` |

An app consumes the subset it uses, but the **candidate record must bind the surfaces it consumes** — a
TMS-class app consumes S1 and S3 at minimum, so both must be bound to one commit.

## 2. Encoded stage config (no environment variables)

The deployment behavior is encoded configuration. The app's encoded stage config (the Autheory
`app-theory/stages/*.json` pattern) gains a `candidate` block:

```json
{
  "stage": "lab",
  "expected_account_id": "123456789012",
  "apptheory": {
    "candidate": {
      "commit": "<40-hex commit sha>",
      "tree": "<40-hex tree sha, git rev-parse <commit>^{tree}>",
      "source_date_epoch": 1760000000,
      "surfaces": {
        "go_runtime":            { "sha256": "<tree archive sha256>" },
        "go_cdk":                { "sha256": "<tree archive sha256>" },
        "npm_cdk":               { "file": "theory-cloud-apptheory-cdk-6.1.0.tgz", "sha256": "...", "integrity": "sha512-..." },
        "npm_ts_runtime":        { "file": "theory-cloud-apptheory-6.1.0.tgz",   "sha256": "...", "integrity": "sha512-..." },
        "py_runtime_wheel":      { "file": "apptheory-6.1.0-py3-none-any.whl",   "sha256": "..." },
        "py_runtime_sdist":      { "file": "apptheory-6.1.0.tar.gz",             "sha256": "..." },
        "py_cdk_wheel":          { "file": "apptheory_cdk-6.1.0-py3-none-any.whl", "sha256": "..." }
      }
    }
  }
}
```

Rules:

- The builder reads `commit`, `tree`, `source_date_epoch`, and the per-surface hashes **only** from this
  config. No AppTheory build input comes from an environment variable (the app's own deploy config may set
  `stage`/`expected_account_id` by its existing mechanism; AppTheory never introduces a new operator env var).
- `commit` is one value for all surfaces; a per-surface commit is invalid.
- `tree` is verified with `git rev-parse <commit>^{tree}` (the AGENTS.md rule: cite a tree, not a bare SHA that
  a rebuild could orphan).
- The `live` stage config carries **no** `candidate` block, and the builder refuses any stage other than an
  explicitly allowed lab set.

## 3. Per-surface deterministic build commands

All artifact builds already honor `SOURCE_DATE_EPOCH` (`scripts/verify-ts-pack.sh`, `verify-cdk-ts-pack.sh`,
`verify-python-build.sh`), which is what makes the hashes reproducible. The builder sets
`SOURCE_DATE_EPOCH` from the config (not the clock) and builds from the **exported tree of the pinned commit**.

This table is the original sketch of the per-surface commands. The **as-built** commands — which invoke the
repository's own pack/build scripts (`scripts/verify-ts-pack.sh`, `verify-cdk-ts-pack.sh`,
`verify-python-build.sh`, `verify-cdk-python-build.sh`) instead of re-implementing the packaging — are recorded in
§4.1 and are what the builder runs.

| Surface | Command (builder-invoked) | Expected output |
| --- | --- | --- |
| S1 (go_runtime) | `git -C <apptheory> archive --format=tar <commit> -- . ':(exclude)cdk-go'` → `sha256`; unpack into a scratch module dir | `go_runtime.sha256` over the exported **root Go module** tree (`github.com/theory-cloud/apptheory/v6`; excludes the nested `cdk-go` module) |
| S2 (go_cdk) | `git -C <apptheory> archive --format=tar <commit> -- cdk-go/apptheorycdk` → `sha256`; unpack into a scratch module dir | `go_cdk.sha256` over the exported **`cdk-go/apptheorycdk` module** tree (`github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v6`) |
| S3 | `(cd cdk && npm ci --ignore-scripts && npm run build && npm pack)` with `SOURCE_DATE_EPOCH` | `theory-cloud-apptheory-cdk-<version>.tgz` |
| S4 | `(cd ts && npm ci --ignore-scripts && npm run build && npm pack)` with `SOURCE_DATE_EPOCH` | `theory-cloud-apptheory-<version>.tgz` |
| S5 | `(cd py && python -m build)` with `SOURCE_DATE_EPOCH` | `apptheory-<version>-py3-none-any.whl`, `apptheory-<version>.tar.gz` |
| S6 | `(cd cdk && python -m build)` (jsii python) with `SOURCE_DATE_EPOCH` | `apptheory_cdk-<version>-py3-none-any.whl`, `apptheory_cdk-<version>.tar.gz` |

App-side consumption of a candidate:

- **Go (S1/S2):** the app's `go.mod` uses a `replace` to the builder-produced scratch module path, so the
  built binary uses the candidate tree, not the module proxy. The builder verifies the scratch path's tree
  hash first.
- **npm (S3/S4):** the app installs from the local tarball (`npm ci` with a file dependency or an offline
  cache populated from the tarball) and verifies `sha256` **and** the npm `integrity` before install.
- **Python (S5/S6):** the app installs the wheel from a local path and verifies `sha256` before install.

## 4. Binding all surfaces to one commit

The builder is a single AppTheory-provided entry point (spec name: `scripts/lab/candidate-build.sh`, provided
in M4) that:

1. resolves `commit` from the encoded config and asserts it is reachable from a retained ref;
2. computes `git rev-parse <commit>^{tree}` and asserts it equals the encoded `tree`;
3. builds every consumed surface from that tree;
4. computes each surface hash and compares it to the encoded hash, **failing closed on any mismatch** (this is
   the check that prevents candidate-runtime-against-released-CDK);
5. writes a **receipt** stamping `commit`, `tree`, `source_date_epoch`, each surface's artifact name + hash,
   and the exact commands run.

**How the encoded hashes are first produced (SAN-1134-2).** The encoded `surfaces` hashes are **not** authored
by the builder — the builder only **verifies** them. They come from a **witnessed build**: an operator (or the
app steward acting for the operator) runs the same deterministic build once against the pinned commit, records
each artifact's `sha256`/`integrity` into the encoded stage config, and only then does the builder run and
compare. The **builder never writes the config and never self-attests**: if a hash is absent or wrong it fails
closed at step 4 rather than filling it in. The trust chain is therefore: witnessed build → operator records
the hashes → builder re-builds from the pinned tree and verifies → receipt. A new candidate is admitted only by
repeating the witnessed build and updating the encoded hashes.

Because all surfaces are built from the one exported tree and every hash is config-pinned, a proof that
consumes the receipts is provably a proof of a single commit across every surface. The receipt follows the
Factory docs/096 deployed-commit stamp convention so the lab proof can cite it.

## 4.1 As built (M4)

Entry point: **`scripts/lab/candidate-build.sh`** (the repo root is derived from the script location, so a caller
uses the path inside the AppTheory checkout it is building).

```text
candidate-build.sh --config <stage-config.json> --out <dir> [--repo <apptheory-root>] [--account-id <id>] [--print-plan]
```

Exit codes: `0` success, `1` a fail-closed refusal (every refusal prints `candidate-build: FAIL (<reason>)` on
stderr), `2` a usage error (unknown flag, missing `--config`, or `--out` absent without `--print-plan`).

Decisions the specification left open, as resolved by the operator (Factory docs/110, "M0 outcome and operator
decisions" 2026-10-12, item 8) and implemented here:

- **`source_date_epoch` is derived from the commit** (`git show -s --format=%ct <commit>`) and exported to the
  builds. An encoded `source_date_epoch` is accepted only if it equals that value; a mismatch fails closed. The
  commit timestamp is intrinsic to the commit and cannot drift, so an encoded copy is never the authority.
- **The lab stage allowlist is `{lab}` only.** `live` and `staging` are refused by name.
- **The framework builds and verifies the DECLARED surface subset.** The config's `surfaces` map names the
  surfaces the consumer uses, at least one of them; only declared surfaces are built, verified, handed over and
  receipted, and an undeclared surface is never built (so a TMS-class consumer that uses S1 and S3 declares S1 and
  S3 and gets exactly those artifacts and receipt rows). Every declared surface is bound to the one pinned commit
  exactly as a complete set would be, and a declared surface whose encoded witness is missing its `sha256` (or, for
  an npm surface, its `file`/`integrity`) fails closed, naming the surface. A surface key that is not one of the
  seven, or any non-annotation field on a declared surface, is refused rather than ignored (`§4.1` step 4). One
  declared Python runtime surface runs the single python build, which produces both the wheel and the sdist; only
  the declared artifacts are verified, handed over and receipted. The app's own receipt still carries its binary
  hash (operator decision 8).
- **The encoded `file` must equal the version-derived artifact basename** (`scripts/read-version.sh`, with the
  same `-rc.N` → `rcN` normalization the Python build scripts apply).

The checks run in this order, and each one fails closed before any artifact is handed over:

1. **No environment input.** Any environment variable named `APPTHEORY_CANDIDATE_*` is refused by name. No
   AppTheory build input comes from the environment; `SOURCE_DATE_EPOCH` is *set* by the builder from the config's
   commit and is never read as input.
2. **Stage allowlist** — `lab` only.
3. **Candidate block present** — the builder never builds a stage without an encoded `candidate` block.
4. **Declared surface completeness and surface vocabulary** — at least one surface declared, and every declared
   surface carrying a non-empty `sha256`, plus `file` + `integrity` for a declared npm surface. An undeclared
   surface is not checked because it is never built. A surface key outside the seven, and any field on a declared
   surface that is neither an input (`file`, `sha256`, `integrity`) nor a `_`-prefixed annotation, is refused
   rather than ignored: a per-surface `commit` in particular is invalid, because the one encoded `commit` binds
   every surface, and a misspelled input would otherwise look like an unbound surface.
5. `commit` and `tree` are 40 lowercase hex characters.
6. `expected_account_id` is non-empty and equals a supplied `--account-id` when one is given. Resolving the
   account from AWS is the app deploy script's job; the builder takes the app's already-resolved value as an
   argument rather than reaching for credentials, and never reads it from the environment.
7. **Repository binding** — a dirty working tree fails (naming the first offending path); `HEAD` must equal the
   encoded `commit`; `git rev-parse <commit>^{tree}` must equal the encoded `tree`; and the commit must be
   reachable from at least one ref (`git for-each-ref --contains`).
8. **Per-surface verification** — each surface is built with the repository's own deterministic build script,
   then hashed; a `sha256` mismatch (or an npm `integrity` mismatch) prints the encoded value, the observed value
   and the artifact path, removes the artifact from `--out`, and exits 1. An artifact is copied into `--out` only
   **after** it verifies.

Surface → command as built (the S1/S2 tree archives are hashed directly; S3–S6 invoke the repository's own
pack/build scripts, which already honor `SOURCE_DATE_EPOCH` and normalize artifact mtimes):

| Surface | Command | Artifact |
| --- | --- | --- |
| S1 `go_runtime` | `git -C <repo> archive --format=tar <commit> -- . ':(exclude)cdk-go'` | `go_runtime.tar` |
| S2 `go_cdk` | `git -C <repo> archive --format=tar <commit> -- cdk-go/apptheorycdk` | `go_cdk.tar` |
| S3 `npm_cdk` | `./scripts/verify-cdk-ts-pack.sh` | `theory-cloud-apptheory-cdk-<version>.tgz` |
| S4 `npm_ts_runtime` | `./scripts/verify-ts-pack.sh` | `theory-cloud-apptheory-<version>.tgz` |
| S5 `py_runtime_wheel` | `./scripts/verify-python-build.sh` (one run) | `apptheory-<pyversion>-py3-none-any.whl` |
| S5 `py_runtime_sdist` | (the same run) | `apptheory-<pyversion>.tar.gz` |
| S6 `py_cdk_wheel` | `./scripts/verify-cdk-python-build.sh` | `apptheory_cdk-<pyversion>-py3-none-any.whl` |

The npm and Python builds emit into the repository's own `dist/` (exactly as `make build` does); the builder copies
the **verified** artifacts into `--out` and leaves that repository build output in place.

**Receipt** (`<out>/candidate-receipt.json`, pretty-printed with sorted keys, no wall-clock timestamp so it is
reproducible): `schema` (`apptheory.candidate-receipt/v1`), `stage`, `commit`, `tree`, `source_date_epoch`
(integer), `builder` (the script's path), `surfaces` (surface key → `{artifact, sha256[, integrity]}` for the
declared surfaces only), and `commands` (surface key → the command string for that surface). The command strings are
recorded in their reproducible template form — the literal `--repo` and scratch paths are the only values not
embedded — which is the same notation as the table in §3. Standard output ends with
`candidate-build: PASS (<stage> <commit>; <N> surfaces verified)`, where `<N>` is the declared surface count.

**`--print-plan`** runs every check above, prints the resolved commit/tree/epoch/account, the per-surface command
plan and the expected hashes, and exits 0 **without building anything and without writing a receipt**, so the plan
can never be mistaken for a verified candidate.

**Self-test.** `scripts/lab/candidate-build-self-test.sh` exercises the builder against a throwaway fixture git
repository (no network, no AWS, no credentials) and asserts: the example config shape is runnable; a valid config
builds and verifies; a declared subset builds exactly its declared artifacts, hands none of the undeclared ones over,
receipts only the declared ones and never runs an undeclared surface's build script; an empty declared surface set
and a declared surface missing its witness are refused; an unknown surface key, a per-surface `commit` and a
misspelled surface field are refused rather than ignored; a tampered `sha256`, a tampered npm `integrity`, a wrong
tree, a mismatched `source_date_epoch`, a wrong encoded `file`, a declared npm surface without its integrity, an
environment variables-only attempt, a `live`/`staging` stage and an account mismatch all fail closed; and
`--print-plan` writes nothing. It is wired into `make rubric`, so a builder that stops failing closed fails CI rather
than the lab proof.

## 4.2 Integration note for the adoption stewards (TMS and Autheory)

**Where the block lives.** The builder reads the candidate block from `apptheory.candidate` at the top level of the
config document, or from `deployment.apptheory.candidate`; if both are present they must be equal or the builder
fails closed as ambiguous. `stage` and `expected_account_id` are read from the top level with a
`deployment.*` fallback.

- **Autheory** stage files are shaped `{"schema": 1, "deployment": {...}}` and `cdk/deploy.sh`'s loader reads
  everything under `deployment` (`expected_account_id` at `deployment.expected_account_id`, enforced at
  `cdk/deploy.sh:736-742`). Autheory should therefore place the block at **`deployment.apptheory.candidate`** so
  its existing loader sees it, and add the `lab` stage entry as part of its adoption work. The call shape is:

  ```bash
  bash <apptheory-checkout>/scripts/lab/candidate-build.sh \
    --config app-theory/stages/lab.json \
    --repo <apptheory-checkout> \
    --account-id "${CONFIG_EXPECTED_ACCOUNT}" \
    --out "${CANDIDATE_OUT}"
  ```

  The `--account-id` value is the account the app already resolved and asserted for the stage; passing it makes
  the builder re-check the encoded value independently. Omitting it keeps the builder's own guards (stage
  allowlist, candidate-block presence, tree/HEAD binding) in force.
- **TMS** has no per-stage config file at `origin/staging` (stage is a `-c stage=<lab|live>` context flag on
  `scripts/deploy/theorymcp-cdk.mjs` and the account comes from the AWS profile), so adoption must first
  materialize a stage config carrying the `candidate` block — top-level `apptheory.candidate` or a `deployment`
  wrapper, either is accepted — and then pass it to the builder exactly as above. TMS's tooling consumes S1 and S3,
  so its config declares S1 and S3; the builder builds, verifies, hands over and receipts exactly those declared
  surfaces and never builds the rest.

**Before calling the builder**, the app's deploy step must place the AppTheory checkout on the pinned commit with a
clean working tree: the builder requires `HEAD == commit`, an empty `git status --porcelain`, and
`git rev-parse <commit>^{tree}` equal to the encoded tree. The lab flow is therefore
`git -C <apptheory> fetch && git -C <apptheory> checkout <commit>` → run the builder → consume
`<out>/candidate-receipt.json` plus the artifacts in `--out`.

**What the builder never does:** it does not write or amend the app's stage config (the hashes come from the
app's witnessed build, never from the builder), it does not contact AWS or read credentials, it does not deploy
anything, and it cannot target `live`.

## 5. Incapable of targeting live

The builder refuses to run unless **all** of:

- `stage` is in the allowed lab set (e.g. `{lab}`; `staging`/`live` are not candidate stages);
- the resolved AWS account id (or the app's configured expected account for that stage) equals the encoded
  `expected_account_id`;
- the `candidate` block is present.

If the app's active stage is `live`, the live config has no `candidate` block and the account guard fails, so
the mode cannot target live. The app deploy scripts must also refuse a live stage when a candidate block is
absent (their existing stage guards), but AppTheory's builder is independently incapable of live.

## 6. What was out of scope in M0

- No builder script, no app-side changes, no AWS calls, no credentials, no deploys.
- The interface was specified so the app stewards (TMS/Autheory) can implement their side in M5 against a frozen
  shape, and so the M4 builder has a contract to satisfy. M4 delivered the contract's builder side only: the
  builder script, its self-test, and the example config. No application was edited and no AWS call was made.

## 7. Decisions (resolved)

All three were resolved by the operator (Factory docs/110, "M0 outcome and operator decisions" 2026-10-12, item 8)
and are implemented as described in §4.1:

1. `source_date_epoch` is **derived from the commit** (`git show -s --format=%ct <commit>`); an encoded copy is
   accepted only when it matches, and a mismatch fails closed.
2. The Go surfaces are bound by **exported-tree hash** (S1/S2 `git archive` sha256), plus the app's own binary hash
   in the app's receipt.
3. The lab stage allowlist is **`{lab}` only**; `live` and `staging` are refused by name.
