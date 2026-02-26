# ADR 0002 — Import Pipeline Support Pack (Issue #169) M0 Decisions

Status: accepted

## Context

AppTheory is already strong for Lambda + event sources and for CDK patterns (queues, tables, Lambda roles). A recurring
platform need (Pay Theory / partner migrations) is a repeatable import pipeline pattern that works across:

- **Multiple AWS accounts** (central/kernel + per-partner accounts)
- Multiple compute styles (Lambda, CodeBuild, ECS, Step Functions orchestration)

We want AppTheory to provide **primitives and standard wiring** (infra + runtime glue), not a workflow engine.

Epic: `theory-cloud/AppTheory#169` (“Import pipeline support pack”).

## Decision

### D1 — CDK constructs added for import pipelines

AppTheory CDK will ship a small set of opinionated, composable constructs:

1) `AppTheoryEventBridgeRuleTarget`
   - Standardizes “EventBridge rule → Lambda target” wiring for both:
     - `schedule`, and
     - `eventPattern` (+ optional `eventBus`)
   - Enforces `schedule` XOR `eventPattern` (fail closed).
   - Back-compat: keep `AppTheoryEventBridgeHandler` schedule-only for now (no breaking prop-bag expansion).

2) `AppTheoryS3Ingest`
   - Standardizes the “secure S3 ingest front door”:
     - secure bucket defaults when creating a bucket
     - prefix/suffix filtering
     - notifications via S3 → EventBridge and/or S3 → SQS
   - Includes optional cross-account grant/policy helpers, but remains explicit and least-privilege by default.

3) `AppTheoryCodeBuildJobRunner` (name may be shortened to `AppTheoryCodeBuildProject` if it reads better)
   - Standardizes CodeBuild projects used as “batch steps” (decrypt/validate/transform/backfill).
   - Provides safe defaults (timeouts, logs), env var support (incl. optional KMS encryption), and an IAM escape hatch.

4) `AppTheoryJobsTable`
   - Standardizes the DynamoDB table backing the job ledger primitives (see D2).
   - Defaults:
     - `pk`/`sk` string keys
     - TTL attribute `ttl`
     - PITR enabled
     - encryption AWS-managed by default (optional CMK)
     - removal policy `RETAIN` unless explicitly overridden
   - GSIs (first-class, locked for initial implementation):
     - `status-created-index`: `status` (pk) + `created_at` (sk)
     - `tenant-created-index`: `tenant_id` (pk) + `created_at` (sk)

### D2 — Canonical job ledger schema (TableTheory-backed)

Runtime job ledger items will use the following canonical key shapes:

- `pk = JOB#<job_id>`, `sk = META`
- `pk = JOB#<job_id>`, `sk = REC#<record_id>`
- `pk = JOB#<job_id>`, `sk = LOCK`
- `pk = JOB#<job_id>`, `sk = REQ#<idempotency_key>`

This keeps all job data queryable by a single partition key, while reserving clear namespaces in the sort key.

### D3 — Environment variable conventions

The canonical env var for the jobs table is:

- `APPTHEORY_JOBS_TABLE_NAME`

AppTheory runtime packages and examples should prefer the `APPTHEORY_*` names first. Any migration-friendly fallbacks
must be explicitly justified (do not add “alias sprawl” by default).

### D4 — Correctness posture (idempotency + leases)

The job ledger supports “exactly-once-ish” correctness via DynamoDB conditional writes:

- Idempotency records prevent duplicate side effects across retries.
- Leases/locks prevent concurrent processors from double-processing a job/record.
- Job state transitions use optimistic concurrency (versioning/conditions).

### D5 — Multi-account support is explicit

The support pack enables multi-account patterns without hiding them:

- CDK constructs may offer safe cross-account grants/policy templates.
- Runtime primitives remain role-agnostic; app code owns assume-role boundaries and account routing.

## Consequences

- New CDK constructs require:
  - snapshot tests in `cdk/test/constructs.test.cjs`
  - docs under `cdk/docs/`
  - at least one example stack exercising each construct
- New runtime `jobs` primitives (Go/TS/Py) require:
  - deterministic unit tests per language
  - API snapshot updates if exports change
- The schema + env var conventions here are the contract that subsequent issues (`#173`, `#174`, `#176`) must follow.

## References

- Roadmap: `docs/development/planning/apptheory/apptheory-import-pipeline-support-pack-roadmap.md`
- Epic: `theory-cloud/AppTheory#169`
- Child issues: `#170`–`#176`

