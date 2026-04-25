# AppTheory Troubleshooting

This guide maps common symptoms to verified fixes.

## Quick diagnosis

| Symptom | First check | Expected next step |
| --- | --- | --- |
| Versions or packages drift | `./scripts/verify-version-alignment.sh` | Align `VERSION`, package manifests, and generated outputs |
| Snapshot drift | `./scripts/verify-api-snapshots.sh` | Run `./scripts/update-api-snapshots.sh` and review the public API delta |
| Cross-language behavior mismatch | `./scripts/verify-contract-tests.sh` | Update fixtures/tests or fix runtime parity |
| CDK synth or package failure | `make rubric` | Inspect the failing `verify-cdk-*` or build step and regenerate outputs |
| Live SSR smoke failure | `./scripts/verify-ssr-site-smoke.sh` | Check AWS credentials, deploy outputs, and CloudFront / Function URL reachability |
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
./scripts/verify-api-snapshots.sh
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
./scripts/verify-api-snapshots.sh
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


## Issue: event workload logs include raw event details

Symptoms:

- EventBridge or DynamoDB stream logs include domain payloads, DynamoDB keys, or image values
- correlation IDs differ across languages
- retry diagnostics expose raw record data

Cause:

- the handler logged raw AWS events instead of the AppTheory event workload safe summary
- the producer treated top-level EventBridge `headers` as AWS-native instead of an AppTheory portable envelope convention
- idempotency was derived from an unstable execution ID instead of the event/run key

Fix:

- use the correlation precedence documented in `docs/features/event-workloads.md`
- put producer-owned correlation in `detail.correlation_id` unless you are deliberately using an AppTheory portable envelope
- for DynamoDB Streams, log only table name, event ID/name, sequence number, size, and stream view type
- use scheduled workload `detail.idempotency_key` or the derived `eventbridge:<event.id>` / `lambda:<awsRequestId>` fallback before committing side effects

Verification:

```bash
./scripts/verify-contract-tests.sh
make rubric
```

## Issue: Python build fails in CI but passes locally

Symptoms:

- `./scripts/verify-python-build.sh` fails in CI
- local virtualenv hides a missing dependency or stale build artifact

Cause:

- local package state differs from the isolated build environment used by the repo verifiers

Fix:

```bash
./scripts/verify-python-build.sh
```

If the verifier fails after a Python packaging change, fix the package metadata or generated artifacts instead of
relying on the local virtualenv state.

## Issue: CDK synth fails in CI

Symptoms:

- `./scripts/verify-cdk-synth.sh` fails
- `make rubric` fails in the CDK verification stage

Cause:

- a construct change, example drift, or generated-output mismatch broke deterministic synth

Fix:

```bash
./scripts/verify-cdk-synth.sh
make rubric
```

Review the failing synth example or construct before changing the verifier.

## Issue: manual SSR smoke verification fails

Symptoms:

- `./scripts/verify-ssr-site-smoke.sh` fails
- CloudFront returns `403`, `502`, or never serves the SSR example root path

Cause:

- AWS credentials are missing
- CloudFront cannot reach the Lambda Function URL under the selected auth model
- a header-policy regression reintroduced a bad SSR origin contract

Fix:

- run the smoke verifier locally with valid AWS credentials to reproduce the deployed failure
- inspect the deployed stack outputs, CloudFront root response, asset response, CloudFront `POST` action response, and
  direct Function URL response

Verification:

```bash
./scripts/verify-ssr-site-smoke.sh
make rubric
```

## Issue: docs-standard fails after a docs change

Symptoms:

- `./scripts/verify-docs-standard.sh` fails
- a docs page was added, renamed, or reworded in a way that broke the fixed docs contract

Cause:

- a required file is missing
- a README stopped linking `./_contract.yaml`
- a contract-only page no longer clearly states its scope
- package-local docs started competing with `docs/` as the canonical external root

Fix:

- restore the required fixed files under `docs/`
- keep package-local docs in `ts/docs/`, `py/docs/`, and `cdk/docs/` clearly secondary to `docs/`
- ensure contract-only pages still say `contract-only`

Verification:

```bash
./scripts/verify-docs-standard.sh
```
