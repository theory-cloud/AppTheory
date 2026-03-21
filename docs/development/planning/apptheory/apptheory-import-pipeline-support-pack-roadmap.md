# AppTheory: Import Pipeline Support Pack (Issue #169) — Implementation Roadmap

Epic: `theory-cloud/AppTheory#169` — “Import pipeline support pack (multi-account job orchestration)”.

Child issues:
- `#170` — CDK: EventBridge rule target construct (eventPattern + schedule)
- `#171` — CDK: S3 ingest construct (bucket/prefix → EventBridge/SQS)
- `#172` — CDK: CodeBuild job-runner construct for batch steps
- `#173` — Runtime/pkg: TableTheory-backed job ledger primitives (jobs/records + idempotency + leases)
- `#174` — CDK: Opinionated Jobs DynamoDB table construct (schema + GSIs + TTL)
- `#175` — Sanitization: treat common PAN field aliases as sensitive (e.g. `pan_value`)
- `#176` — Examples: end-to-end import pipeline reference stack

M0 decision lock: `docs/development/planning/apptheory/adr/0002-import-pipeline-support-pack-m0.md`

## Summary (what this support pack provides)

AppTheory already supports Lambda + common event sources (SQS/EventBridge/Streams) and has strong CDK patterns. This epic
adds a repeatable “import pipeline” baseline that teams can assemble into production workloads:

1) File arrives (often S3)
2) Control-plane creates a job record + audit trail
3) Batch step runs (e.g. decrypt/validate/transform)
4) Per-record fanout to SQS workers (partial failures + idempotency)
5) Finalization happens in the appropriate account (assume-role or partner-side consumer)
6) Artifacts + mapping outputs written; job marked complete

The intent is to standardize **primitives and wiring**, not to ship a workflow engine.

## Non-goals (explicit)

- Replace AWS Step Functions with an AppTheory workflow engine.
- Build a general ETL framework.
- Mandate a single compute style; CodeBuild/ECS/Lambda remain first-class options.

## Design anchors (cross-cutting decisions)

### A1 — “Exactly-once-ish” posture

Jobs should be safe across retries and partial failures:

- **Idempotency**: repeated requests/records do not double-apply side effects.
- **Leases/locks**: prevent concurrent processors from double-processing the same job/record.
- **Optimistic concurrency**: job state transitions are guarded by versioning/conditions.

This is “exactly once” at the application level (with DynamoDB conditional writes), not at the transport level.

### A2 — Canonical DynamoDB schema (TableTheory-first)

Lock the core item shapes early so CDK + runtime packages evolve together.

Proposed PK/SK shapes (from `#173`):
- `pk = JOB#<job_id>`, `sk = META`
- `pk = JOB#<job_id>`, `sk = REC#<record_id>`
- `pk = JOB#<job_id>`, `sk = LOCK`
- `pk = JOB#<job_id>`, `sk = REQ#<idempotency_key>`

**Why**: all job data for a job can be queried by PK; different SK namespaces keep shapes explicit.

### A3 — Environment variable conventions

Mirror existing AppTheory patterns (`APPTHEORY_*` first, with migration-friendly fallbacks only when needed):

- Jobs table name: `APPTHEORY_JOBS_TABLE_NAME`
- Example stacks should also export a short alias for app code if helpful, but AppTheory should prefer the `APPTHEORY_*`
  name everywhere.

### A4 — Multi-account is supported via primitives, not hidden magic

This epic should make cross-account posture easy and safe, but not opaque:

- CDK constructs can provide **bucket/table grant helpers** and sane bucket policies (least privilege).
- Runtime code should be role-agnostic; app code orchestrates assume-role boundaries.

## Deliverables (by child issue)

### #170 — CDK: EventBridge rule → Lambda target construct (schedule + eventPattern)

**Goal:** eliminate bespoke `events.Rule` + `targets.LambdaFunction` boilerplate.

**Implementation (done):**
- Construct: `cdk/lib/eventbridge-rule-target.ts` (`AppTheoryEventBridgeRuleTarget`)
- Exports: `cdk/lib/index.ts`
- Tests: `cdk/test/constructs.test.cjs` + snapshots under `cdk/test/snapshots/`
- Docs: `cdk/docs/eventbridge-rule-target.md`

**Recommended approach:** add a new construct for clarity/back-compat:
- `cdk/lib/eventbridge-rule-target.ts`: `AppTheoryEventBridgeRuleTarget`
- Keep existing `AppTheoryEventBridgeHandler` schedule-only (or deprecate later), to avoid a confusing “either/or” prop bag.

**Proposed props (close to the issue):**
- `handler: lambda.IFunction`
- `eventPattern?: events.EventPattern`
- `schedule?: events.Schedule`
- `eventBus?: events.IEventBus`
- `ruleName?`, `description?`, `enabled?`
- `targetProps?: targets.LambdaFunctionProps`

**Hard requirement:** `eventPattern` XOR `schedule` (fail closed in the constructor).

**Test plan:**
- Add snapshot tests in `cdk/test/constructs.test.cjs`:
  - schedule rule
  - eventPattern rule (default bus)
  - eventBus + eventPattern rule
- Add new snapshots in `cdk/test/snapshots/`.

**Docs/examples:**
- Add a short CDK docs page under `cdk/docs/` and link it from `cdk/docs/api-reference.md`.
- Add/extend an example under `examples/cdk/` showing eventPattern wiring (S3 and/or CodeBuild state changes).

---

### #171 — CDK: S3 ingest “front door” construct

**Goal:** standardize the first step of most import jobs: secure bucket + notifications + filters.

**Implementation (done):**
- Construct: `cdk/lib/s3-ingest.ts` (`AppTheoryS3Ingest`)
- Exports: `cdk/lib/index.ts`
- Tests: `cdk/test/constructs.test.cjs` + snapshots under `cdk/test/snapshots/`
- Docs: `cdk/docs/s3-ingest.md`

**Construct:** `cdk/lib/s3-ingest.ts`: `AppTheoryS3Ingest`

**API shape (proposed):**
- `bucket?: s3.IBucket` (attach) **or** create a new bucket (default)
- Filters:
  - `prefixes?: string[]`
  - `suffixes?: string[]`
- Notifications:
  - `enableEventBridge?: boolean` (bucket-level `eventBridgeEnabled`)
  - `queueTarget?: sqs.IQueue` (direct S3 → SQS notifications)
  - Optional convenience: `queueProps?: AppTheoryQueueProps` to create a queue if desired
- Security defaults when creating a bucket (mirror `cdk/lib/media-cdn.ts` defaults):
  - `blockPublicAccess: BLOCK_ALL`
  - `encryption: S3_MANAGED` (optional KMS)
  - `enforceSSL: true`
  - `objectOwnership: BUCKET_OWNER_ENFORCED` (important for cross-account writers)
  - safe removal policy defaults, configurable for non-prod
- Cross-account helpers:
  - `grantReadTo?: iam.IGrantable[]`
  - `grantWriteTo?: iam.IGrantable[]`
  - Optional: `writerPrincipals?: iam.IPrincipal[]` (least-priv bucket policy templates)

**Implementation notes:**
- For S3 → SQS prefix/suffix support, create notifications for the **cartesian product** of prefixes×suffixes (and handle
  “only prefixes” / “only suffixes” / “neither” cases explicitly).
- Do not attempt to encode S3 suffix matching into EventBridge until we lock what we can reliably express in patterns.

**Test plan:**
- Snapshot tests for:
  - bucket created with defaults
  - bucket + EventBridge enabled
  - bucket + SQS notification (with filters)

**Docs/examples:**
- `cdk/docs/s3-ingest.md`
- `examples/cdk/s3-ingest/` (standalone, small)

---

### #172 — CDK: CodeBuild job-runner construct

**Goal:** provide a safe default for “batch steps” that shouldn’t run in Lambda (PGP decrypt, large transforms, backfills).

**Implementation (done):**
- Construct: `cdk/lib/codebuild-job-runner.ts` (`AppTheoryCodeBuildJobRunner`)
- Exports: `cdk/lib/index.ts`
- Tests: `cdk/test/constructs.test.cjs` + snapshots under `cdk/test/snapshots/`
- Docs: `cdk/docs/codebuild-job-runner.md`
- Example: `examples/cdk/codebuild-job-runner/`

**Construct:** `cdk/lib/codebuild-job-runner.ts`: `AppTheoryCodeBuildJobRunner` (or `AppTheoryCodeBuildProject`)

**API shape (proposed):**
- Basics: `projectName?`, `description?`, `buildImage?`, `computeType?`, `timeout?`
- Buildspec: `buildSpec: codebuild.BuildSpec`
- Env vars: `environmentVariables?: Record<string, codebuild.BuildEnvironmentVariable>`
- Optional env var encryption key: `encryptionKey?: kms.IKey`
- IAM:
  - baseline role (logs, artifact access as needed)
  - `additionalStatements?: iam.PolicyStatement[]`
  - helper methods (S3 read/write, SecretsManager get, Dynamo read/write) as ergonomic wrappers
- Observability:
  - log group retention defaults
  - optional EventBridge rule for build state changes (expose `rule?: events.Rule`)

**Test plan:**
- Snapshot tests for:
  - baseline project
  - project with env vars + KMS key
  - project with additionalStatements

**Docs/examples:**
- CDK docs page that clarifies “compute packaging lives outside infra; CodeBuild is just an execution primitive”.
- `examples/cdk/codebuild-job-runner/`

---

### #173 — Runtime/pkg: Job ledger primitives (jobs/records + idempotency + leases)

**Goal:** make correctness properties repeatable: job lifecycle, record status, audit, idempotency, leases.

**Implementation (done):**
- Go: `pkg/jobs/*` (`DynamoJobLedger`, models, safe logging wrappers) + tests in `pkg/jobs/ledger_test.go`
- TypeScript: `ts/src/jobs.ts` (exported via `ts/src/index.ts`, shipped as `ts/dist/jobs.*`) + exercised in
  `contract-tests/runners/ts/fixtures.test.cjs`
- Python: `py/src/apptheory/jobs.py` (`DynamoJobLedger` + canonical item dataclasses) + tests in `py/tests/test_jobs.py`
  + exported via `py/src/apptheory/__init__.py`
- Docs: `docs/features/jobs-ledger.md`

---

### #174 — CDK: Opinionated Jobs DynamoDB table construct

**Goal:** standardize the backing table for `pkg/jobs` so stacks don’t drift.

**Implementation (done):**
- Construct: `cdk/lib/jobs-table.ts` (`AppTheoryJobsTable`)
- Exports: `cdk/lib/index.ts`
- Tests: `cdk/test/constructs.test.cjs` + snapshots under `cdk/test/snapshots/`
- Docs: `cdk/docs/jobs-table.md`

**Construct:** `cdk/lib/jobs-table.ts`: `AppTheoryJobsTable`

**Defaults (recommended):**
- PK/SK string: `pk`, `sk`
- TTL attribute: `ttl` (configurable)
- PITR: enabled by default
- Removal: `RETAIN` unless explicitly overridden
- Encryption: AWS-managed default; optional customer-managed KMS
- Optional `deletionProtection` (consider default `true` in prod-focused constructs)

**GSIs (finalize after query needs are locked):**
- `status-created-index`: `status` (pk) + `created_at` (sk) for operations dashboards
- `tenant-created-index`: `tenant_id` (pk) + `created_at` (sk) for partner/tenant views
- Optional `job-id-index` only if we ever stop encoding job_id into PK (otherwise unnecessary)

**Ergonomics:**
- `grantReadTo` / `grantWriteTo` / `grantReadWriteTo`
- `bindEnvironment(fn)` helper that sets `APPTHEORY_JOBS_TABLE_NAME`

**Test plan:**
- Snapshot tests for baseline table + GSIs + TTL.

**Docs/examples:**
- CDK docs page under `cdk/docs/`.
- Example stack that wires `AppTheoryJobsTable` with an SQS worker.

---

### #175 — Sanitization: PAN field aliases

**Goal:** “safe logging” must not leak PAN when datasets use different field names.

**Implementation (done):**
- Go: `pkg/sanitization/sanitization.go` treats these aliases as `PartialMask` and routes them through card-number masking:
  - `pan_value`
  - `pan`
  - `primary_account_number`
- TS: `ts/src/sanitization.ts` adds the same aliases and routes them through card-number masking.
- Py: `py/src/apptheory/sanitization.py` adds the same aliases and routes them through card-number masking.

**Tests (done):**
- Go: `pkg/sanitization/sanitization_additional_test.go`
- TS: `contract-tests/runners/ts/fixtures.test.cjs`
- Py: `py/tests/test_sanitization.py`

---

### #176 — Example: end-to-end import pipeline reference stack

**Goal:** provide a copy/pasteable reference that demonstrates the full pattern.

**Example directory:** `examples/cdk/import-pipeline/` (stack: `AppTheoryImportPipelineDemo`)

**Implementation (done):**
- Example stack + handlers + docs: `examples/cdk/import-pipeline/`
- Go: add missing AWS SDK dependency for the ingest handler (`service/sqs`): `go.mod` + `go.sum`
- Synth snapshot: `examples/cdk/import-pipeline/snapshots/AppTheoryImportPipelineDemo.template.sha256`
- Gate: `scripts/verify-cdk-synth.sh` includes `examples/cdk/import-pipeline|AppTheoryImportPipelineDemo`

**Infra in the example:**
- S3 ingest wiring (`AppTheoryS3Ingest`)
- EventBridge pattern routing (`AppTheoryEventBridgeRuleTarget`)
- Jobs table (`AppTheoryJobsTable`)
- SQS queue + consumer (`AppTheoryQueue*`)
- Optional CodeBuild batch step (`AppTheoryCodeBuildJobRunner`)

**Runtime in the example:**
- Ingest handler (EventBridge) creates job + enqueues record work
- Worker handler (SQS) processes records with:
  - idempotency records
  - record status + error envelope
  - lease usage (if needed for concurrency control)
- Demonstrate safe logging via `pkg/sanitization` (and TS/Py equivalents if using those runtimes)

**Verification gate:**
- Add deterministic synth snapshot:
  - commit `examples/cdk/import-pipeline/snapshots/<StackName>.template.sha256`
  - update `scripts/verify-cdk-synth.sh` to include the new example

## Sequencing / milestones (recommended)

### M0 — Schema lock + API sketches

Deliverables:
- Decide final job ledger schema (A2) + required GSIs (A2/A4).
- Decide construct names (`AppTheoryEventBridgeRuleTarget`, `AppTheoryS3Ingest`, `AppTheoryJobsTable`, etc).
- Write/adjust docs so CDK + runtime packages agree on env vars + item shapes.

### M1 — Safety footgun fixes (sanitization)

Deliverables:
- Implement `#175` across Go/TS/Py + tests (done).

### M2 — CDK primitives (routing + ingest + table)

Deliverables:
- Implement `#170` (EventBridge rule target) + snapshots + docs.
- Implement `#171` (S3 ingest) + snapshots + docs.
- Implement `#174` (Jobs table) + snapshots + docs.

Status: done (implements `#170`, `#171`, `#174`).

### M3 — Runtime primitives (job ledger)

Deliverables:
- Implement `#173` Go package + tests + docs.
- Implement TS/Py parity (recommended) + tests + API snapshots updates.

Status: done (implements `#173`).

### M4 — Batch primitive (CodeBuild)

Deliverables:
- Implement `#172` + snapshots + docs + small example.

Status: done (implements `#172`).

### M5 — Reference example (end-to-end)

Deliverables:
- Implement `#176` example stack + handlers + README.
- Add synth snapshot + gate in `scripts/verify-cdk-synth.sh`.

Status: done (implements `#176`).

## Repo gates / “done means done”

When implementing, each milestone should keep the repo green:

- `make test` (Go tests + version alignment)
- `make lint` (Go/TS/Py)
- `cd cdk && npm test` (jsii build + CDK snapshot tests)
- `./scripts/verify-contract-tests.sh` (TS/Py/Go contract runners)
- `./scripts/update-api-snapshots.sh` (commit updates when exports change)
- `./scripts/verify-cdk-synth.sh` (once the new example is added)

## Open questions (to resolve early)

- EventBridge filtering: do we want to support suffix matching in EventBridge patterns, or require suffix filtering via
  direct S3 notifications (SQS mode)?
- Jobs table GSIs: which operational queries must be “first-class” (status, tenant, created_at)? Lock before `#174`.
- Lease semantics: default lease duration and refresh strategy; how to surface “stolen lease” / contention errors.
- Idempotency semantics: how to represent in-progress vs complete, and what TTL/replay windows we expect.
- Error envelopes: which fields are safe to store by default (message, code, category) and how to avoid payload leakage.
