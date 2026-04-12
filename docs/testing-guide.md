# AppTheory Testing Guide

AppTheory relies on layered deterministic verification: fast unit tests, package-focused checks, contract fixtures,
snapshot checks, docs contract checks, and full rubric validation.

## Test strategy

Use the smallest gate that proves the change, then escalate to the full rubric before merge:

- fast local loop: `make test-unit`
- package-focused checks: `./scripts/verify-ts-tests.sh`, `./scripts/verify-python-tests.sh`, `cd ts && npm run check`, `cd cdk && npm test`
- cross-language parity: `./scripts/verify-contract-tests.sh`
- public API drift: `./scripts/update-api-snapshots.sh`, `./scripts/verify-api-snapshots.sh`
- docs contract: `./scripts/verify-docs-standard.sh`
- full repo gate: `make rubric`
- release-only live SSR smoke: `./scripts/verify-ssr-site-smoke.sh`

## Fast local loop

```bash
make test-unit
```

This runs `go test ./...` from the repo root and is the fastest default check.

## Package-focused checks

```bash
./scripts/verify-ts-tests.sh
./scripts/verify-python-tests.sh
cd ts && npm run check
cd cdk && npm test
```

Use these when you need quicker feedback inside one language/package before running the cross-language gates.

## Cross-language and release verification

Run these from the repo root when behavior changes span runtimes or documentation claims:

```bash
./scripts/verify-ts-tests.sh
./scripts/verify-python-tests.sh
./scripts/verify-contract-tests.sh
./scripts/verify-api-snapshots.sh
./scripts/verify-docs-standard.sh
make rubric
```

`make rubric` includes the language-specific unit-test verifiers above, shared contract fixtures, snapshot verification,
docs contract checks, and release-build validation.

For the FaceTheory-first SSR deployment path, the release and prerelease GitHub workflows also run:

```bash
./scripts/verify-ssr-site-smoke.sh
```

That verifier deploys `examples/cdk/ssr-site`, checks CloudFront root reachability, asset delivery, and the direct
Function URL auth model, then destroys the stack. It also keeps the previous Host-header 403 regression covered by
exercising the CloudFront-to-Function URL path end to end. It requires AWS credentials and is intentionally separate
from the deterministic local rubric.

If exported APIs changed, refresh snapshots first and then re-run snapshot verification:

```bash
./scripts/update-api-snapshots.sh
./scripts/verify-api-snapshots.sh
```

## Feature-specific deterministic harnesses

Use the repo testkits to prove feature behavior without deploying infrastructure:

- AppSync resolvers:
  - Go: `testkit.AppSyncEvent(...)`, `env.InvokeAppSync(...)`
  - TypeScript: `buildAppSyncEvent(...)`, `env.invokeAppSync(...)`
  - Python: `build_appsync_event(...)`, `env.invoke_appsync(...)`
- MCP servers:
  - high-level client: `testkit/mcp` `NewClient(...).Initialize/ListTools/CallTool/ListResources/ReadResource/ListPrompts/GetPrompt`
  - streaming helpers: `Client.RawStream(...)`, `Client.ResumeStream(...)`, `Stream.Response()`, `Stream.Cancel()`,
    `Stream.Next()`, `Stream.ReadAll()`
  - low-level JSON-RPC builders: `InitializeRequest`, `ListToolsRequest`, `CallToolRequest`, `ListResourcesRequest`,
    `ReadResourceRequest`, `ListPromptsRequest`, `GetPromptRequest`
  - OAuth harness: `testkit/oauth` `NewClaudePublicClient(nil).Authorize(...)`

## Evidence to capture

- commands run
- pass or fail outcomes
- snapshot updates, generated outputs, or logs that explain the change
- explicit gaps when a check was not run

## CORRECT vs INCORRECT test posture

CORRECT:

- tie docs examples to runnable repo commands
- treat snapshot changes as public API changes
- update fixtures or tests before weakening a gate

INCORRECT:

- claiming parity without running `./scripts/verify-contract-tests.sh`
- claiming AppSync parity without running the TypeScript and Python unit suites or `make rubric`
- updating API docs without refreshing `api-snapshots/*` when exports changed
- publishing docs changes that fail `./scripts/verify-docs-standard.sh`

## Governance bundle

```bash
bash gov-infra/verifiers/gov-verify-rubric.sh
```

Evidence is written to `gov-infra/evidence/`.
