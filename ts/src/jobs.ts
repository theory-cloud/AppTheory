import {
  TheorydbClient,
  TheorydbError,
  defineModel,
  getLambdaDynamoDBClient,
} from "@theory-cloud/tabletheory-ts";

import { RealClock, type Clock } from "./clock.js";
import { sanitizeFieldValue, sanitizeLogString } from "./sanitization.js";

export type JobStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED";

export type RecordStatus =
  | "PENDING"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "SKIPPED";

export type IdempotencyStatus = "IN_PROGRESS" | "COMPLETED";

export type IdempotencyCreateOutcome =
  | "created"
  | "already_in_progress"
  | "already_completed";

export type JobLedgerErrorType =
  | "internal_error"
  | "invalid_input"
  | "conflict"
  | "not_found";

export class JobLedgerError extends Error {
  readonly type: JobLedgerErrorType;
  readonly cause: unknown;

  constructor(
    type: JobLedgerErrorType,
    message: string,
    cause: unknown = null,
  ) {
    super(String(message));
    this.name = "JobLedgerError";
    this.type = type;
    this.cause = cause;
  }
}

export function newJobLedgerError(
  type: JobLedgerErrorType,
  message: string,
): JobLedgerError {
  return new JobLedgerError(type, message);
}

export function wrapJobLedgerError(
  cause: unknown,
  type: JobLedgerErrorType,
  message: string,
): JobLedgerError {
  return new JobLedgerError(type, message, cause);
}

function isTheorydbCode(err: unknown, code: string): boolean {
  if (err instanceof TheorydbError) return String(err.code ?? "") === code;
  if (!err || typeof err !== "object") return false;
  const rec = err as Record<string, unknown>;
  return (
    String(rec["code"] ?? "").trim() === code ||
    String(rec["name"] ?? "").trim() === code
  );
}

function isConditionalCheckFailed(err: unknown): boolean {
  return isTheorydbCode(err, "ErrConditionFailed");
}

function isItemNotFound(err: unknown): boolean {
  return isTheorydbCode(err, "ErrItemNotFound");
}

export const EnvJobsTableName = "APPTHEORY_JOBS_TABLE_NAME";
export const defaultJobsTableName = "apptheory-jobs";

export function jobsTableName(): string {
  return (
    String(process.env[EnvJobsTableName] ?? "").trim() || defaultJobsTableName
  );
}

export function jobPartitionKey(jobId: string): string {
  return `JOB#${jobId}`;
}

export function jobMetaSortKey(): string {
  return "META";
}

export function jobRecordSortKey(recordId: string): string {
  return `REC#${recordId}`;
}

export function jobLockSortKey(): string {
  return "LOCK";
}

export function jobRequestSortKey(idempotencyKey: string): string {
  return `REQ#${idempotencyKey}`;
}

function unixSeconds(date: Date): number {
  return Math.floor(date.valueOf() / 1000);
}

function normalizeTtlUnixSeconds(
  now: Date,
  ttlSeconds: number | undefined,
  fallbackSeconds: number,
): number | undefined {
  const raw = ttlSeconds === undefined ? NaN : Number(ttlSeconds);
  const own = Number.isFinite(raw) ? Math.floor(raw) : 0;
  const fallback = Math.floor(Number(fallbackSeconds) || 0);
  const seconds = own === 0 ? fallback : own;
  if (seconds <= 0) return undefined;
  return unixSeconds(now) + seconds;
}

export type ErrorEnvelope = {
  type?: string;
  code?: string;
  message: string;
  retryable?: boolean;
  fields?: Record<string, unknown>;
};

export function sanitizeFields(
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const rec = fields ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    const key = String(k).trim();
    if (!key) continue;
    out[key] = sanitizeFieldValue(key, v);
  }
  return Object.keys(out).length ? out : undefined;
}

export function sanitizeErrorEnvelope(
  env: ErrorEnvelope | null | undefined,
): ErrorEnvelope | undefined {
  if (!env) return undefined;
  const message =
    sanitizeLogString(String(env.message ?? "")) || "unknown error";
  const fields = env.fields ? sanitizeFields(env.fields) : undefined;
  return {
    ...(env.type ? { type: sanitizeLogString(String(env.type)) } : {}),
    ...(env.code ? { code: sanitizeLogString(String(env.code)) } : {}),
    message,
    ...(env.retryable ? { retryable: true } : {}),
    ...(fields ? { fields } : {}),
  };
}

export type JobsConfig = {
  tableName: string;
  defaultLeaseDurationMs: number;
  defaultIdempotencyTtlSeconds: number;
  defaultJobTtlSeconds: number;
  defaultRecordTtlSeconds: number;
  defaultRequestResultTtlSeconds: number;
};

export function defaultJobsConfig(): JobsConfig {
  return {
    tableName: jobsTableName(),
    defaultLeaseDurationMs: 5 * 60_000,
    defaultIdempotencyTtlSeconds: 24 * 60 * 60,
    defaultJobTtlSeconds: 0,
    defaultRecordTtlSeconds: 0,
    defaultRequestResultTtlSeconds: 0,
  };
}

function normalizeJobsConfig(
  config: Partial<JobsConfig> | undefined,
): JobsConfig {
  const base = defaultJobsConfig();
  const merged: JobsConfig = { ...base, ...config };
  merged.tableName = String(merged.tableName ?? "").trim() || base.tableName;
  merged.defaultLeaseDurationMs = Math.floor(
    Number(merged.defaultLeaseDurationMs) || 0,
  );
  merged.defaultIdempotencyTtlSeconds = Math.floor(
    Number(merged.defaultIdempotencyTtlSeconds) || 0,
  );
  merged.defaultJobTtlSeconds = Math.floor(
    Number(merged.defaultJobTtlSeconds) || 0,
  );
  merged.defaultRecordTtlSeconds = Math.floor(
    Number(merged.defaultRecordTtlSeconds) || 0,
  );
  merged.defaultRequestResultTtlSeconds = Math.floor(
    Number(merged.defaultRequestResultTtlSeconds) || 0,
  );
  return merged;
}

const jobLedgerModelName = "JobLedgerItem";

function jobLedgerModel(tableName: string) {
  return defineModel({
    name: jobLedgerModelName,
    table: { name: tableName },
    naming: { convention: "snake_case" },
    keys: {
      partition: { attribute: "pk", type: "S" },
      sort: { attribute: "sk", type: "S" },
    },
    attributes: [
      { attribute: "pk", type: "S" },
      { attribute: "sk", type: "S" },

      { attribute: "job_id", type: "S" },
      { attribute: "tenant_id", type: "S", optional: true },
      { attribute: "record_id", type: "S", optional: true },
      { attribute: "idempotency_key", type: "S", optional: true },

      { attribute: "status", type: "S" },
      { attribute: "created_at", type: "S", optional: true },
      { attribute: "updated_at", type: "S", optional: true },
      { attribute: "completed_at", type: "S", optional: true },

      { attribute: "version", type: "N", optional: true, roles: ["version"] },
      { attribute: "ttl", type: "N", optional: true, roles: ["ttl"] },

      { attribute: "lease_owner", type: "S", optional: true },
      { attribute: "lease_expires_at", type: "N", optional: true },

      { attribute: "error", type: "M", optional: true },
      { attribute: "result", type: "M", optional: true },
    ],
  });
}

export type JobMeta = {
  pk: string;
  sk: string;
  jobId: string;
  tenantId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  version: number;
  ttl?: number;
};

export type JobRecord = {
  pk: string;
  sk: string;
  jobId: string;
  recordId: string;
  status: RecordStatus;
  error?: ErrorEnvelope;
  createdAt: string;
  updatedAt: string;
  ttl?: number;
};

export type JobLock = {
  pk: string;
  sk: string;
  jobId: string;
  leaseOwner: string;
  leaseExpiresAt: number;
  createdAt: string;
  updatedAt: string;
  ttl?: number;
};

export type JobRequest = {
  pk: string;
  sk: string;
  jobId: string;
  idempotencyKey: string;
  status: IdempotencyStatus;
  result?: Record<string, unknown>;
  error?: ErrorEnvelope;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  ttl?: number;
};

type JobMetaItem = {
  pk: string;
  sk: string;
  job_id: string;
  tenant_id: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  version: number;
  ttl?: number;
};

type JobRequestItem = {
  pk: string;
  sk: string;
  job_id: string;
  idempotency_key: string;
  status: IdempotencyStatus;
  result?: Record<string, unknown>;
  error?: ErrorEnvelope;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  ttl?: number;
};

function requireStr(value: unknown, field: string): string {
  const v = String(value ?? "").trim();
  if (!v) throw newJobLedgerError("internal_error", `missing field: ${field}`);
  return v;
}

function getNum(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toJobMeta(item: Record<string, unknown>): JobMeta {
  return {
    pk: requireStr(item["pk"], "pk"),
    sk: requireStr(item["sk"], "sk"),
    jobId: requireStr(item["job_id"], "job_id"),
    tenantId: requireStr(item["tenant_id"], "tenant_id"),
    status: String(item["status"] ?? "") as JobStatus,
    createdAt: requireStr(item["created_at"], "created_at"),
    updatedAt: requireStr(item["updated_at"], "updated_at"),
    version: Math.floor(getNum(item["version"])),
    ...(Number.isFinite(Number(item["ttl"]))
      ? { ttl: Math.floor(getNum(item["ttl"])) }
      : {}),
  };
}

function toJobRecord(item: Record<string, unknown>): JobRecord {
  return {
    pk: requireStr(item["pk"], "pk"),
    sk: requireStr(item["sk"], "sk"),
    jobId: requireStr(item["job_id"], "job_id"),
    recordId: requireStr(item["record_id"], "record_id"),
    status: String(item["status"] ?? "") as RecordStatus,
    ...(item["error"] ? { error: item["error"] as ErrorEnvelope } : {}),
    createdAt: requireStr(item["created_at"], "created_at"),
    updatedAt: requireStr(item["updated_at"], "updated_at"),
    ...(Number.isFinite(Number(item["ttl"]))
      ? { ttl: Math.floor(getNum(item["ttl"])) }
      : {}),
  };
}

function toJobLock(item: Record<string, unknown>): JobLock {
  return {
    pk: requireStr(item["pk"], "pk"),
    sk: requireStr(item["sk"], "sk"),
    jobId: requireStr(item["job_id"], "job_id"),
    leaseOwner: requireStr(item["lease_owner"], "lease_owner"),
    leaseExpiresAt: Math.floor(getNum(item["lease_expires_at"])),
    createdAt: requireStr(item["created_at"], "created_at"),
    updatedAt: requireStr(item["updated_at"], "updated_at"),
    ...(Number.isFinite(Number(item["ttl"]))
      ? { ttl: Math.floor(getNum(item["ttl"])) }
      : {}),
  };
}

function toJobRequest(item: Record<string, unknown>): JobRequest {
  return {
    pk: requireStr(item["pk"], "pk"),
    sk: requireStr(item["sk"], "sk"),
    jobId: requireStr(item["job_id"], "job_id"),
    idempotencyKey: requireStr(item["idempotency_key"], "idempotency_key"),
    status: String(item["status"] ?? "") as IdempotencyStatus,
    ...(item["result"]
      ? { result: item["result"] as Record<string, unknown> }
      : {}),
    ...(item["error"] ? { error: item["error"] as ErrorEnvelope } : {}),
    createdAt: requireStr(item["created_at"], "created_at"),
    updatedAt: requireStr(item["updated_at"], "updated_at"),
    ...(item["completed_at"]
      ? { completedAt: String(item["completed_at"]) }
      : {}),
    ...(Number.isFinite(Number(item["ttl"]))
      ? { ttl: Math.floor(getNum(item["ttl"])) }
      : {}),
  };
}

export type CreateJobInput = {
  jobId: string;
  tenantId: string;
  status?: JobStatus;
  ttlSeconds?: number;
};

export type TransitionJobStatusInput = {
  jobId: string;
  expectedVersion: number;
  toStatus: JobStatus;
  fromStatus?: JobStatus;
};

export type UpsertRecordStatusInput = {
  jobId: string;
  recordId: string;
  status: RecordStatus;
  error?: ErrorEnvelope;
  ttlSeconds?: number;
};

export type AcquireLeaseInput = {
  jobId: string;
  owner: string;
  leaseDurationMs?: number;
  ttlSeconds?: number;
};

export type RefreshLeaseInput = {
  jobId: string;
  owner: string;
  leaseDurationMs?: number;
  ttlSeconds?: number;
};

export type ReleaseLeaseInput = {
  jobId: string;
  owner: string;
};

export type CreateIdempotencyRecordInput = {
  jobId: string;
  idempotencyKey: string;
  ttlSeconds?: number;
};

export type CompleteIdempotencyRecordInput = {
  jobId: string;
  idempotencyKey: string;
  result?: Record<string, unknown>;
  error?: ErrorEnvelope;
  ttlSeconds?: number;
};

function requireNonEmpty(value: unknown, field: string): string {
  const v = String(value ?? "").trim();
  if (!v) throw newJobLedgerError("invalid_input", `${field} is required`);
  return v;
}

export class DynamoJobLedger {
  private readonly _theorydb: TheorydbClient;
  private readonly _config: JobsConfig;
  private _clock: Clock;

  constructor(
    options: {
      theorydb?: TheorydbClient;
      config?: Partial<JobsConfig>;
      clock?: Clock;
    } = {},
  ) {
    this._config = normalizeJobsConfig(options.config);
    const model = jobLedgerModel(this._config.tableName);
    this._theorydb =
      options.theorydb ?? new TheorydbClient(getLambdaDynamoDBClient());
    this._theorydb.register(model);
    this._clock = options.clock ?? new RealClock();
  }

  setClock(clock: Clock | null | undefined): void {
    this._clock = clock ?? new RealClock();
  }

  async createJob(input: CreateJobInput): Promise<JobMeta> {
    const jobId = requireNonEmpty(input?.jobId, "jobId");
    const tenantId = requireNonEmpty(input?.tenantId, "tenantId");
    const status = (input?.status ?? "PENDING") as JobStatus;

    const now = this._clock.now();
    const nowIso = now.toISOString();
    const pk = jobPartitionKey(jobId);
    const sk = jobMetaSortKey();

    const ttl = normalizeTtlUnixSeconds(
      now,
      input?.ttlSeconds,
      this._config.defaultJobTtlSeconds,
    );

    const item: JobMetaItem = {
      pk,
      sk,
      job_id: jobId,
      tenant_id: tenantId,
      status,
      created_at: nowIso,
      updated_at: nowIso,
      version: 1,
      ...(ttl ? { ttl } : {}),
    };

    try {
      await this._theorydb.create(jobLedgerModelName, item, {
        ifNotExists: true,
      });
      return toJobMeta(item);
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        throw newJobLedgerError("conflict", "job already exists");
      }
      throw wrapJobLedgerError(err, "internal_error", "failed to create job");
    }
  }

  async transitionJobStatus(input: TransitionJobStatusInput): Promise<JobMeta> {
    const jobId = requireNonEmpty(input?.jobId, "jobId");
    const toStatus = requireNonEmpty(input?.toStatus, "toStatus") as JobStatus;
    const expectedVersion = Math.floor(Number(input?.expectedVersion) || 0);
    if (expectedVersion <= 0) {
      throw newJobLedgerError("invalid_input", "expectedVersion must be > 0");
    }

    const pk = jobPartitionKey(jobId);
    const sk = jobMetaSortKey();
    const now = this._clock.now();
    const nowIso = now.toISOString();

    try {
      const builder = this._theorydb.updateBuilder(jobLedgerModelName, {
        pk,
        sk,
      });
      builder.set("status", toStatus);
      builder.add("version", 1);
      builder.set("updated_at", nowIso);
      builder.conditionExists("pk");
      builder.conditionVersion(expectedVersion);
      if (input?.fromStatus) {
        builder.condition("status", "=", input.fromStatus);
      }
      builder.returnValues("ALL_NEW");

      const out = await builder.execute();
      if (!out)
        throw newJobLedgerError("internal_error", "missing update result");
      return toJobMeta(out);
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        throw newJobLedgerError("conflict", "job status transition conflict");
      }
      throw wrapJobLedgerError(
        err,
        "internal_error",
        "failed to transition job status",
      );
    }
  }

  async upsertRecordStatus(input: UpsertRecordStatusInput): Promise<JobRecord> {
    const jobId = requireNonEmpty(input?.jobId, "jobId");
    const recordId = requireNonEmpty(input?.recordId, "recordId");
    const status = requireNonEmpty(input?.status, "status") as RecordStatus;

    const pk = jobPartitionKey(jobId);
    const sk = jobRecordSortKey(recordId);
    const now = this._clock.now();
    const nowIso = now.toISOString();
    const ttl = normalizeTtlUnixSeconds(
      now,
      input?.ttlSeconds,
      this._config.defaultRecordTtlSeconds,
    );

    try {
      const builder = this._theorydb.updateBuilder(jobLedgerModelName, {
        pk,
        sk,
      });
      builder.set("status", status);
      builder.setIfNotExists("job_id", null, jobId);
      builder.setIfNotExists("record_id", null, recordId);
      builder.setIfNotExists("created_at", null, nowIso);
      builder.set("updated_at", nowIso);
      if (ttl) builder.set("ttl", ttl);

      const env = sanitizeErrorEnvelope(input?.error);
      if (env) builder.set("error", env);
      else builder.remove("error");

      builder.returnValues("ALL_NEW");
      const out = await builder.execute();
      if (!out)
        throw newJobLedgerError("internal_error", "missing update result");
      return toJobRecord(out);
    } catch (err) {
      throw wrapJobLedgerError(
        err,
        "internal_error",
        "failed to upsert record status",
      );
    }
  }

  async acquireLease(input: AcquireLeaseInput): Promise<JobLock> {
    const jobId = requireNonEmpty(input?.jobId, "jobId");
    const owner = requireNonEmpty(input?.owner, "owner");

    const leaseDurationMs = Math.floor(
      Number(input?.leaseDurationMs ?? this._config.defaultLeaseDurationMs) ||
        0,
    );
    if (leaseDurationMs <= 0) {
      throw newJobLedgerError("invalid_input", "leaseDurationMs must be > 0");
    }

    const pk = jobPartitionKey(jobId);
    const sk = jobLockSortKey();
    const now = this._clock.now();
    const nowIso = now.toISOString();
    const expiresAt = Math.floor((now.valueOf() + leaseDurationMs) / 1000);
    const ttl = normalizeTtlUnixSeconds(now, input?.ttlSeconds, 0);

    try {
      const builder = this._theorydb.updateBuilder(jobLedgerModelName, {
        pk,
        sk,
      });
      builder.setIfNotExists("job_id", null, jobId);
      builder.set("lease_owner", owner);
      builder.set("lease_expires_at", expiresAt);
      builder.setIfNotExists("created_at", null, nowIso);
      builder.set("updated_at", nowIso);
      if (ttl) builder.set("ttl", ttl);

      builder.conditionNotExists("lease_expires_at");
      builder.orCondition("lease_expires_at", "<", unixSeconds(now));
      builder.orCondition("lease_owner", "=", owner);

      builder.returnValues("ALL_NEW");
      const out = await builder.execute();
      if (!out)
        throw newJobLedgerError("internal_error", "missing update result");
      return toJobLock(out);
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        throw newJobLedgerError("conflict", "lease already held");
      }
      throw wrapJobLedgerError(
        err,
        "internal_error",
        "failed to acquire lease",
      );
    }
  }

  async refreshLease(input: RefreshLeaseInput): Promise<JobLock> {
    const jobId = requireNonEmpty(input?.jobId, "jobId");
    const owner = requireNonEmpty(input?.owner, "owner");

    const leaseDurationMs = Math.floor(
      Number(input?.leaseDurationMs ?? this._config.defaultLeaseDurationMs) ||
        0,
    );
    if (leaseDurationMs <= 0) {
      throw newJobLedgerError("invalid_input", "leaseDurationMs must be > 0");
    }

    const pk = jobPartitionKey(jobId);
    const sk = jobLockSortKey();
    const now = this._clock.now();
    const nowIso = now.toISOString();
    const expiresAt = Math.floor((now.valueOf() + leaseDurationMs) / 1000);
    const ttl = normalizeTtlUnixSeconds(now, input?.ttlSeconds, 0);

    try {
      const builder = this._theorydb.updateBuilder(jobLedgerModelName, {
        pk,
        sk,
      });
      builder.set("lease_expires_at", expiresAt);
      builder.set("updated_at", nowIso);
      if (ttl) builder.set("ttl", ttl);

      builder.condition("lease_owner", "=", owner);
      builder.condition("lease_expires_at", ">", unixSeconds(now));

      builder.returnValues("ALL_NEW");
      const out = await builder.execute();
      if (!out)
        throw newJobLedgerError("internal_error", "missing update result");
      return toJobLock(out);
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        throw newJobLedgerError("conflict", "lease refresh conflict");
      }
      throw wrapJobLedgerError(
        err,
        "internal_error",
        "failed to refresh lease",
      );
    }
  }

  async releaseLease(input: ReleaseLeaseInput): Promise<void> {
    const jobId = requireNonEmpty(input?.jobId, "jobId");
    const owner = requireNonEmpty(input?.owner, "owner");

    const pk = jobPartitionKey(jobId);
    const sk = jobLockSortKey();
    const nowIso = this._clock.now().toISOString();

    try {
      const builder = this._theorydb.updateBuilder(jobLedgerModelName, {
        pk,
        sk,
      });
      builder.set("lease_expires_at", 0);
      builder.remove("lease_owner");
      builder.set("updated_at", nowIso);
      builder.condition("lease_owner", "=", owner);
      await builder.execute();

      try {
        await this._theorydb.delete(jobLedgerModelName, { pk, sk });
      } catch (delErr) {
        if (!isItemNotFound(delErr)) {
          throw delErr;
        }
      }
      return;
    } catch (err) {
      if (!isConditionalCheckFailed(err)) {
        throw wrapJobLedgerError(
          err,
          "internal_error",
          "failed to release lease",
        );
      }
    }

    try {
      const existing = await this._theorydb.get(jobLedgerModelName, { pk, sk });
      if (String(existing["lease_owner"] ?? "") !== owner) {
        throw newJobLedgerError("conflict", "lease not owned");
      }
    } catch (err) {
      if (isItemNotFound(err)) return;
      throw wrapJobLedgerError(
        err,
        "internal_error",
        "failed to load lease after release conflict",
      );
    }
  }

  async createIdempotencyRecord(
    input: CreateIdempotencyRecordInput,
  ): Promise<{ request: JobRequest; outcome: IdempotencyCreateOutcome }> {
    const jobId = requireNonEmpty(input?.jobId, "jobId");
    const idempotencyKey = requireNonEmpty(
      input?.idempotencyKey,
      "idempotencyKey",
    );

    const pk = jobPartitionKey(jobId);
    const sk = jobRequestSortKey(idempotencyKey);
    const now = this._clock.now();
    const nowIso = now.toISOString();
    const ttl = normalizeTtlUnixSeconds(
      now,
      input?.ttlSeconds,
      this._config.defaultIdempotencyTtlSeconds,
    );

    const item: JobRequestItem = {
      pk,
      sk,
      job_id: jobId,
      idempotency_key: idempotencyKey,
      status: "IN_PROGRESS",
      created_at: nowIso,
      updated_at: nowIso,
      ...(ttl ? { ttl } : {}),
    };

    try {
      await this._theorydb.create(jobLedgerModelName, item, {
        ifNotExists: true,
      });
      return { request: toJobRequest(item), outcome: "created" };
    } catch (err) {
      if (!isConditionalCheckFailed(err)) {
        throw wrapJobLedgerError(
          err,
          "internal_error",
          "failed to create idempotency record",
        );
      }
    }

    try {
      const existing = await this._theorydb.get(jobLedgerModelName, { pk, sk });
      const req = toJobRequest(existing);
      const outcome: IdempotencyCreateOutcome =
        req.status === "COMPLETED"
          ? "already_completed"
          : "already_in_progress";
      return { request: req, outcome };
    } catch (err) {
      throw wrapJobLedgerError(
        err,
        "internal_error",
        "failed to load existing idempotency record",
      );
    }
  }

  async completeIdempotencyRecord(
    input: CompleteIdempotencyRecordInput,
  ): Promise<JobRequest> {
    const jobId = requireNonEmpty(input?.jobId, "jobId");
    const idempotencyKey = requireNonEmpty(
      input?.idempotencyKey,
      "idempotencyKey",
    );

    const pk = jobPartitionKey(jobId);
    const sk = jobRequestSortKey(idempotencyKey);
    const now = this._clock.now();
    const nowIso = now.toISOString();
    const ttl = normalizeTtlUnixSeconds(
      now,
      input?.ttlSeconds,
      this._config.defaultRequestResultTtlSeconds,
    );

    try {
      const builder = this._theorydb.updateBuilder(jobLedgerModelName, {
        pk,
        sk,
      });
      builder.set("status", "COMPLETED");
      builder.setIfNotExists("completed_at", null, nowIso);
      builder.set("updated_at", nowIso);
      builder.setIfNotExists("job_id", null, jobId);
      builder.setIfNotExists("idempotency_key", null, idempotencyKey);
      builder.conditionExists("pk");

      if (ttl) builder.setIfNotExists("ttl", null, ttl);

      const result = sanitizeFields(input?.result);
      if (result) builder.setIfNotExists("result", null, result);

      const env = sanitizeErrorEnvelope(input?.error);
      if (env) builder.setIfNotExists("error", null, env);

      builder.returnValues("ALL_NEW");
      const out = await builder.execute();
      if (!out)
        throw newJobLedgerError("internal_error", "missing update result");
      return toJobRequest(out);
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        throw newJobLedgerError("not_found", "idempotency record not found");
      }
      throw wrapJobLedgerError(
        err,
        "internal_error",
        "failed to complete idempotency record",
      );
    }
  }
}
