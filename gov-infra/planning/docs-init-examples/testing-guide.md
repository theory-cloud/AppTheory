# AppTheory Testing Guide

This guide documents how AppTheory is verified locally and in automation.

## Test Strategy

AppTheory relies on several complementary verification layers:
- unit tests for repo behavior and public runtime expectations
- contract and snapshot checks that guard cross-language drift
- packaging/build verification for Go, TypeScript, Python, and CDK artifacts
- documentation examples that stay aligned with runnable repo commands

## Fast Unit Test Loop

```bash
make test-unit
```

This currently runs `go test ./...` through the Makefile and is the fastest repo-level verification path.

## Cross-Language Contract and Snapshot Verification

```bash
./scripts/verify-contract-tests.sh
./scripts/update-api-snapshots.sh
```

Use these when public behavior or exported symbols change.

## Full Repo Verification

```bash
make test
make rubric
make build
```

What these commands cover, based on the current Makefile and existing docs:
- `make test` runs unit tests and version-alignment verification
- `make rubric` runs the broader rubric verification bundle
- `make build` runs packaging/build verification scripts for TypeScript, Python, and CDK outputs

## Governance Verification

```bash
bash gov-infra/verifiers/gov-verify-rubric.sh
```

Evidence is expected under `gov-infra/evidence/` according to the current repo testing docs.

## Language-Specific Verification Notes

### TypeScript

```bash
cd ts
npm ci
npm run build
npm run check
```

Use this when `ts/src/**` changes or when `api-snapshots/ts.txt` drifts.

### Python

```bash
TODO: confirm the repo's preferred Python test command beyond lint/build validation
```

Grounded evidence from `py/pyproject.toml` confirms the package runtime and build metadata, but this bounded pass did not confirm a dedicated repo-level Python unit-test command.

### CDK

```bash
cd cdk
npm test
```

This is grounded in `cdk/package.json`.

## Evidence To Capture

- Passing output from `make test-unit` for the fast happy path
- Passing output from `./scripts/verify-version-alignment.sh` when versions or package manifests change
- Updated `api-snapshots/` when exported public surfaces change
- Build/package verification output when release artifacts or jsii bindings change
- Any failure output needed to support a concrete troubleshooting entry

## Documentation Expectations for Tests

- Prefer commands that exist in `Makefile`, package manifests, or current docs.
- If a test workflow is not confirmed from the repo, document it as `TODO:` rather than guessing.
- Keep example verification steps synchronized with [Getting Started](./getting-started.md), [API Reference](./api-reference.md), and [Troubleshooting](./troubleshooting.md).
