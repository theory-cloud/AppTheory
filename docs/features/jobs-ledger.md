# Jobs ledger (job/record status + leases + idempotency)

This document describes AppTheory’s **job ledger primitives** introduced as part of the “import pipeline support pack”
(Epic `#169`, runtime `#173`). The goal is to make “exactly-once-ish” job workflows repeatable without shipping a workflow
engine.

## What this is (and isn’t)

**This is:**
- A canonical DynamoDB item schema (TableTheory-first) for job metadata, per-record status, job leases, and request
  idempotency.
- Small runtime helpers (Go/TypeScript/Python) that implement safe-by-default conditional write patterns.
- A safe logging story via `sanitization` helpers (no raw payload dumps).

**This is not:**
- A full workflow engine (Step Functions remains a first-class option).
- A generalized ETL framework.

## Canonical DynamoDB schema

All items for a job share the same partition key:

- `pk = JOB#<job_id>`, `sk = META`
- `pk = JOB#<job_id>`, `sk = REC#<record_id>`
- `pk = JOB#<job_id>`, `sk = LOCK`
- `pk = JOB#<job_id>`, `sk = REQ#<idempotency_key>`

The opinionated table construct is `cdk/lib/jobs-table.ts` (`AppTheoryJobsTable`) and uses:
- PK/SK: `pk` + `sk` (string)
- TTL attribute: `ttl` (number, optional)
- GSIs:
  - `status-created-index`: `status` + `created_at`
  - `tenant-created-index`: `tenant_id` + `created_at`

## Runtime primitives

These helpers give each runtime the same conceptual job-ledger operations even though the concrete APIs follow local
language conventions.

### Go

Package: `pkg/jobs`

- Models: `JobMeta`, `JobRecord`, `JobLock`, `JobRequest` (canonical PK/SK shapes above).
- Ledger: `DynamoJobLedger`:
  - `CreateJob` (conditional create)
  - `TransitionJobStatus` (optimistic concurrency via `version`)
  - `UpsertRecordStatus` (record status + safe error envelope)
  - `AcquireLease` / `RefreshLease` / `ReleaseLease`
  - `CreateIdempotencyRecord` / `CompleteIdempotencyRecord`
- Safe logging helpers:
  - `SanitizeLogString`
  - `SanitizeFields`
  - `sanitizeErrorEnvelope` is used internally to ensure envelopes are safe to store/log.

### TypeScript

Module: `ts/src/jobs.ts` (exported via `ts/src/index.ts`, shipped in `ts/dist/`)

- `DynamoJobLedger` class implementing the same conceptual primitives as Go.
- Uses `@theory-cloud/tabletheory-ts` `UpdateBuilder` conditions (`conditionVersion`, `conditionNotExists`, OR
  conditions) for correctness properties.

### Python

Module: `py/src/apptheory/jobs.py` (exported from `py/src/apptheory/__init__.py`)

- `DynamoJobLedger` class and canonical item dataclasses (`JobMeta`, `JobRecord`, `JobLock`, `JobRequest`).
- Uses `tabletheory-py` (`theorydb_py`) conditional expressions to implement version guards, lease semantics, and
  idempotency.

## Leases (“LOCK” item)

Leases are a concurrency primitive intended to prevent concurrent processors from double-processing a job.

Recommended fields on the `LOCK` item:
- `lease_owner` (string)
- `lease_expires_at` (unix seconds, number)

Acquire semantics (simplified):
- Succeeds if the lock is missing, expired, or already owned by the same owner.
- Fails closed if another owner holds a non-expired lease.

## Idempotency (“REQ#...” item)

Idempotency records enable “exactly-once-ish” effects across retries:

- `status = IN_PROGRESS` when first created
- `status = COMPLETED` once the effect is committed

Request items may optionally store a **sanitized** `result` or `error` envelope for replay/debugging. Avoid storing raw
input payloads.

## Safe error envelopes + safe logging

Job/record error context is treated as user data and must be sanitized:

- Use `sanitize_log_string` / `sanitizeLogString` to strip newlines (log-forging prevention).
- Use `sanitize_field_value` / `sanitizeFieldValue` to redact/mask sensitive fields (PAN, SSN, tokens, etc).

The job ledger helpers will sanitize envelopes passed into record/idempotency helpers before persisting.
