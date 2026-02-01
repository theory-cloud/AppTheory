# SR-CDK-LIFT-SUNSET — CDK Gaps Blocking Full Lift CDK Sunset (Issue #102)

Source: `https://github.com/theory-cloud/AppTheory/issues/102` (opened **2026-02-01**, pinned AppTheory **v0.5.0**).

This sub-roadmap is the implementation plan to remove the last **Lift CDK** dependency in `equaltoai/lesser` by closing
the missing capabilities in **AppTheory CDK** (jsii, TS-first; consumed from Go/TS/Py).

## Goal

Ship AppTheory CDK constructs that can fully replace the Lift constructs/patterns used by Lesser’s `infra/cdk`, without
requiring long-lived “native CDK escape hatches” for core infra patterns.

## Scope (in repo)

- CDK constructs (`cdk/lib/*.ts`) + deterministic snapshot tests (`cdk/test/*`).
- CDK docs updates (`cdk/docs/*`) and at least one deployable example (`examples/cdk/*`) proving each new construct.
- Version-aligned release artifacts (jsii output, Go bindings in `cdk-go/`).

Non-goals:
- Runtime routing/middleware changes (unless required to support the infra behavior).
- Publishing to npm/PyPI (AppTheory is GitHub Releases only).

## Gaps to close (from Issue #102)

1) **REST API v1**: multi-Lambda route mapping + *complete* response streaming integration + stage + custom domain.
2) **SQS**: DLQ support + optional consumer wiring + full event-source mapping options.
3) **DynamoDB table**: `DeletionProtection` (`DeletionProtectionEnabled`) support.
4) **CloudFront patterns**: path-routed “multi-SPA behind one stage domain” + media CDN distribution.
5) **IAM**: Lambda execution role helper parity (replace `LiftLambdaRole` usage).

## Roadmap (milestones)

### M1 — REST API v1 router: multi-Lambda + streaming parity + stage + domain ✅ COMPLETE

**Status**: Implemented 2026-02-01

**Implementation**:
- New construct: `AppTheoryRestApiRouter` in `cdk/lib/rest-api-router.ts`
- Exports via `cdk/lib/index.ts`
- Snapshot tests: `cdk/test/snapshots/rest-api-router-*.json`
- Documentation: `cdk/docs/rest-api-router-streaming.md`
- Example: `examples/cdk/restv1-router/`

**Deliverables**
- New construct (name flexible, but stable): `AppTheoryRestApiRouter` (or `AppTheoryRestApiV1Router`).
- Route API (example shape; keep it boring and explicit):
  - `addLambdaIntegration(path, methods, handler, opts)`
  - `opts.streaming` enabling *full* REST v1 response streaming behavior.
- Stage controls (all optional):
  - `stageName`
  - access logging destination + format (+ retention helper if we create the log group)
  - detailed metrics (method/stage)
  - throttling rate/burst
  - CORS (preflight + headers)
- Optional REST API custom domain wiring:
  - `domainName`
  - `certificate` or `certificateArn`
  - optional Route53 record creation when `hostedZone` is provided

**Implementation notes (must match Lift/Lesser behavior)**
- Multi-Lambda: each route/method can attach a different `lambda.IFunction`.
- Streaming: *do not stop at* `responseTransferMode: STREAM`.
  - Ensure the underlying `AWS::ApiGateway::Method` integration has:
    - `Integration.ResponseTransferMode = STREAM`
    - `Integration.Uri` ends with `/response-streaming-invocations`
    - `Integration.TimeoutInMillis = 900000` (15 minutes) when streaming is enabled
  - This will likely require CFN-level overrides (`apigateway.CfnMethod`) after `addMethod(...)`.

**Tests**
- Snapshot tests proving:
  - multiple Lambdas are wired to different resources/methods
  - streaming routes have the URI + timeout + responseTransferMode overrides
  - stage access logging + throttling render as expected
  - domain + mapping are synthesized correctly

**Docs + examples**
- Add a “REST API v1 router + streaming” example (prefer `examples/cdk/lesser-parity` or a focused `restv1-router`).
- Update CDK docs to include:
  - streaming enablement requirements and gotchas (timeout/URI)
  - recommended stage settings for SSE
  - domain wiring patterns

**Acceptance criteria**
- A single REST API v1 can route:
  - SSE paths → `sse` Lambda
  - `/api/graphql` → `graphql` Lambda
  - `/{proxy+}` → `api` Lambda
  - at least one “inventory-driven” path → a separate Lambda (proof of multi-Lambda scaling)
- Streaming routes synthesize with `STREAM` + `/response-streaming-invocations` + `900000`.

---

### M2 — SQS queue + DLQ + optional consumer wiring (composable) ✅ COMPLETE

**Status**: Implemented 2026-02-01

**Implementation**:
- New construct: `AppTheoryQueue` in `cdk/lib/queue.ts`
- New construct: `AppTheoryQueueConsumer` in `cdk/lib/queue-consumer.ts`
- Refactored: `AppTheoryQueueProcessor` as wrapper over composable constructs
- Exports via `cdk/lib/index.ts`
- Snapshot tests: `cdk/test/snapshots/queue-*.json`
- Documentation: `cdk/docs/sqs-queue-consumer.md`
- Example: `examples/cdk/sqs-queue/`

**Design decision**
- Prefer **composition** over a monolithic “processor”:
  - `AppTheoryQueue` (queue + DLQ; outputs both)
  - `AppTheoryQueueConsumer` (optional event source mapping + grants)
- Keep `AppTheoryQueueProcessor` for backwards compatibility; either:
  - re-implement it as a thin wrapper over the two new constructs, or
  - expand it with non-breaking optional props (`dlq`, `enableEventSource`, etc.).

**Deliverables**
- DLQ support:
  - optional DLQ creation and exposure (`deadLetterQueue`)
  - `maxReceiveCount` control
- Optional consumer wiring:
  - a “queue only” mode (no event-source mapping)
  - explicit method to “attach consumer later” (stack composition)
- Full event-source options exposed:
  - `batchSize`
  - `maxBatchingWindow`
  - `reportBatchItemFailures`
  - `maxConcurrency`
  - `enabled`
- Permission ergonomics:
  - optional `grantConsumeMessages` behavior (on by default when consumer is attached)

**Tests**
- Snapshot tests for:
  - queue-only (with and without DLQ)
  - queue + consumer mapping with “full knobs” set

**Docs + examples**
- Example showing:
  - “queue only” (contract queue, manual sender)
  - “queue + consumer” (processor)

**Acceptance criteria**
- AppTheory can synthesize the same queue/DLQ/event-source mapping shape as Lesser’s Lift-era stack, without requiring
  bespoke IAM/event source mapping code in the application repo.

---

### M3 — DynamoDB table `DeletionProtection` support ✅ COMPLETE

**Status**: Implemented 2026-02-01

**Implementation**:
- Added `deletionProtection?: boolean` to `AppTheoryDynamoTableProps` in `cdk/lib/dynamo-table.ts`
- The construct passes `deletionProtection` to the underlying `dynamodb.Table` (supported in pinned `aws-cdk-lib@2.235.1`)
- Snapshot test: `cdk/test/snapshots/dynamo-table-deletion-protection.json`

**Deliverables**
- Add `deletionProtection?: boolean` to `AppTheoryDynamoTableProps`.
- Ensure the synthesized table sets `DeletionProtectionEnabled` when requested:
  - use `TableProps.deletionProtection` if supported in the pinned `aws-cdk-lib`
  - otherwise apply an L1 override on `AWS::DynamoDB::Table`

**Tests**
- Snapshot test with deletion protection enabled.

**Acceptance criteria**
- A production table can be created with deletion protection enabled via AppTheory CDK without dropping to raw CDK.

---

### M4 — CloudFront: path-routed SPA distribution + media CDN distribution

This milestone is intentionally **pattern-focused** (like Lift), not a “CloudFront primitives” wrapper.

#### M4A — Path-routed frontend distribution (multi-SPA + API behind one stage domain) ✅ COMPLETE

**Status**: Implemented 2026-02-01

**Implementation**:
- New construct: `AppTheoryPathRoutedFrontend` in `cdk/lib/path-routed-frontend.ts`
- Exports via `cdk/lib/index.ts`
- Snapshot tests: `cdk/test/snapshots/path-routed-frontend-*.json`
- Documentation: `cdk/docs/path-routed-frontend.md`
- Example: `examples/cdk/path-routed-frontend/`

**Deliverables**
- New construct (name flexible): `AppTheoryPathRoutedFrontend` (or similar).
- Inputs cover:
  - stage domain name (apex) + Route53 + ACM (us-east-1) creation when desired
  - API origin (default behavior)
  - two SPA origins (S3) routed by path:
    - `/l/*` → client SPA
    - `/auth/*` → auth SPA
    - `/auth/wallet/*` → API origin (bypass auth SPA)
  - CloudFront Function for viewer-request rewrite to support SPA routing under prefixes
  - pluggable static headers policy (response headers policy input)

**Tests**
- Snapshot tests proving:
  - additional behaviors are configured for `/l/*`, `/auth/*`, `/auth/wallet/*`
  - the CloudFront Function is created and associated on the correct behaviors
  - optional domain/cert/Route53 wiring synthesizes

#### M4B — Media CDN

**Deliverables**
- New construct (name flexible): `AppTheoryMediaCdn`.
- Creates (or accepts) an S3 bucket + CloudFront distribution with:
  - domain + certificate + Route53
  - response headers policy input
  - optional private media:
    - accept `cloudfront.IKeyGroup` (or inputs to create one) and set `trustedKeyGroups`

**Acceptance criteria**
- Lesser’s “stage domain + routed SPAs + media subdomain CDN” can be deployed using AppTheory constructs/patterns.

---

### M5 — IAM: `AppTheoryLambdaRole` helper (LiftLambdaRole replacement)

**Deliverables**
- New construct `AppTheoryLambdaRole` (minimal, explicit).
- Inputs:
  - optional `roleName`
  - optional X-Ray enablement (managed policy)
  - optional KMS key grants for environment encryption and app-level KMS usage
  - escape hatch to attach extra inline policy statements (common real-world need)

**Tests**
- Snapshot tests verifying:
  - the role exists with baseline Lambda execution permissions
  - optional X-Ray and KMS permissions render correctly

**Acceptance criteria**
- Application stacks can stop using Lift role constructs for “basic + encryption” Lambda execution roles.

---

### M6 — Lesser parity example + migration validation gate

**Deliverables**
- Add a CDK example that intentionally mirrors Lesser’s infra patterns at a high level:
  - REST API v1 router with multiple Lambdas + SSE streaming route
  - SQS with DLQ + optional consumer wiring
  - DynamoDB table with deletion protection
  - CloudFront distribution with multi-SPA routing + separate media CDN
  - Lambda roles created via `AppTheoryLambdaRole`
- Add/extend deterministic synth verification for this example (fits the existing `verify-cdk-synth` posture).

**Acceptance criteria**
- The example contains **no** Lift CDK imports.
- The example’s synth output is pinned and verified in CI/`make rubric`.

---

### M7 — Release packaging + docs finalization

**Deliverables**
- Version bump (single aligned version across the repo) and release notes summarizing the new CDK surfaces.
- Update API snapshots if any public non-CDK APIs changed as part of the work.
- Update CDK docs API reference inventory and migration patterns.

**Acceptance criteria**
- `make rubric` passes, including CDK construct build/tests and synth verification.
- Consumers can pin the new AppTheory release and remove Lift CDK usage for the patterns covered.

## Open questions / decisions to resolve early

1) **Naming:** keep new constructs explicitly scoped (`RestApiV1Router`) vs reusing `AppTheoryRestApiRouter`.
2) **Backwards compatibility:** whether to deprecate `AppTheoryRestApi` or keep it as a “single-proxy convenience”.
3) **Streaming defaults:** whether `streaming=true` should automatically set the 15-minute timeout or accept an override.
4) **CloudFront Function rewrite spec:** define a single, tested rewrite policy (extension detection, index fallback,
   prefix preservation).
5) **Key group inputs:** accept existing `IKeyGroup` only vs also creating key groups from PEM strings.

