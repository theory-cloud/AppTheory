# AppTheory Troubleshooting

This guide maps common symptoms to verified fixes.

## Quick diagnosis

| Symptom | First check | Expected next step |
| --- | --- | --- |
| Versions or packages drift | `./scripts/verify-version-alignment.sh` | Align `VERSION`, package manifests, and generated outputs |
| Snapshot drift | `./scripts/verify-api-snapshots.sh` | Run `./scripts/update-api-snapshots.sh` and review the public API delta |
| Cross-language behavior mismatch | `./scripts/verify-contract-tests.sh` | Update fixtures/tests or fix runtime parity |
| CDK synth or package failure | `make rubric` | Inspect the failing `verify-cdk-*` or build step and regenerate outputs |
| Docs contract issue | `./scripts/verify-docs-standard.sh` | Restore the canonical docs set under `docs/` |

## Issue: version alignment check fails

Symptoms:

- `./scripts/verify-version-alignment.sh` exits non-zero
- `make test` or `make rubric` fails before deeper checks run

Cause:

- `VERSION`, `ts/package.json`, `py/pyproject.toml`, or `cdk/package.json` drifted

Fix:

- bump all release-train versions together
- keep generated package outputs in sync with the version change

Verification:

```bash
./scripts/verify-version-alignment.sh
make rubric
```

## Issue: API snapshot drift appears after a code change

Symptoms:

- `./scripts/verify-api-snapshots.sh` fails
- reviewers see a public surface mismatch that was not committed

Cause:

- exported APIs changed without refreshing `api-snapshots/*`
- or docs claimed a surface that is not actually exported

Fix:

```bash
./scripts/update-api-snapshots.sh
make rubric
```

Review the diff before committing. Snapshot changes are public API changes.

## Issue: TypeScript changes do not take effect

Symptoms:

- CI fails with API snapshot drift or runtime behavior mismatch
- local code changes are missing from release packaging checks

Cause:

- `ts/dist/**` was not regenerated after editing `ts/src/**`

Fix:

```bash
cd ts
npm ci
npm run build
```

Verification:

```bash
./scripts/update-api-snapshots.sh
make rubric
```

## Issue: response headers appear lowercased

Symptoms:

- you set `X-Thing` but see `x-thing` in output

Cause:

- AppTheory canonicalizes response header keys to lowercase for cross-language parity

Fix:

- treat request headers as case-insensitive
- assert lowercase response header keys in tests and examples

## Issue: a route silently never registers

Symptoms:

- expected handler returns `404`
- a route pattern looks invalid but no startup failure occurred

Cause:

- default route registration is compatibility-oriented and invalid patterns can be ignored

Fix:

- use `GetStrict` / `HandleStrict` / `handleStrict` / `handle_strict` in tests and CI
- correct the route pattern before relying on the non-strict registration path

## Issue: one Lambda behaves differently across HTTP, queue, or stream triggers

Symptoms:

- HTTP works but SQS or EventBridge paths do not
- custom branching misses an event shape

Cause:

- the handler manually inspects event shapes instead of using the runtime dispatcher

Fix:

- route untyped events through `HandleLambda`, `handleLambda`, or `handle_lambda`
- use the deterministic event builders in the test env when reproducing the failure
