# Candidate-build interface for lab proof (M0, item 9)

Status: specification only for review (M0). Implementation is M4/M5; M0 does not build or deploy anything.
Last updated: 2026-10-12
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
| S1 | Go runtime module `github.com/theory-cloud/apptheory/v6` | TMS Go API, Autheory Go services | exported source tree of the pinned commit |
| S2 | Go CDK bindings module `github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v6` | Go CDK consumers | exported source tree of the pinned commit |
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

| Surface | Command (builder-invoked) | Expected output |
| --- | --- | --- |
| S1/S2 | `git -C <apptheory> archive --format=tar <commit>` → `sha256`; unpack into a scratch module dir | `go_runtime.sha256` / `go_cdk.sha256` over the exported tree |
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

Because all surfaces are built from the one exported tree and every hash is config-pinned, a proof that
consumes the receipts is provably a proof of a single commit across every surface. The receipt follows the
Factory docs/096 deployed-commit stamp convention so the lab proof can cite it.

## 5. Incapable of targeting live

The builder refuses to run unless **all** of:

- `stage` is in the allowed lab set (e.g. `{lab}`; `staging`/`live` are not candidate stages);
- the resolved AWS account id (or the app's configured expected account for that stage) equals the encoded
  `expected_account_id`;
- the `candidate` block is present.

If the app's active stage is `live`, the live config has no `candidate` block and the account guard fails, so
the mode cannot target live. The app deploy scripts must also refuse a live stage when a candidate block is
absent (their existing stage guards), but AppTheory's builder is independently incapable of live.

## 6. What is out of scope in M0

- No builder script, no app-side changes, no AWS calls, no credentials, no deploys.
- The interface is specified so the app stewards (TMS/Autheory) can implement their side in M5 against a frozen
  shape, and so the M4 builder has a contract to satisfy.

## 7. Open decisions

1. Whether `source_date_epoch` is encoded explicitly or derived from the commit's committer timestamp
   (recommend: derive from the commit; it is intrinsic to the commit and cannot drift).
2. Whether the Go surfaces are bound by exported-tree hash or by a built binary hash (recommend: tree hash +
   the app's own binary hash in its receipt; the tree hash is the framework-side binding).
3. The exact lab stage allowlist (`{lab}` vs `{lab, staging}`); recommend `{lab}` only for the first proof.
