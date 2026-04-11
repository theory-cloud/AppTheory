import { TheorydbClient } from "@theory-cloud/tabletheory-ts";
import { type Clock } from "./clock.js";
export type JobStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";
export type RecordStatus = "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "SKIPPED";
export type IdempotencyStatus = "IN_PROGRESS" | "COMPLETED";
export type IdempotencyCreateOutcome = "created" | "already_in_progress" | "already_completed";
export type JobLedgerErrorType = "internal_error" | "invalid_input" | "conflict" | "not_found";
export declare class JobLedgerError extends Error {
    readonly type: JobLedgerErrorType;
    readonly cause: unknown;
    constructor(type: JobLedgerErrorType, message: string, cause?: unknown);
}
export declare function newJobLedgerError(type: JobLedgerErrorType, message: string): JobLedgerError;
export declare function wrapJobLedgerError(cause: unknown, type: JobLedgerErrorType, message: string): JobLedgerError;
export declare const EnvJobsTableName = "APPTHEORY_JOBS_TABLE_NAME";
export declare const defaultJobsTableName = "apptheory-jobs";
export declare function jobsTableName(): string;
export declare function jobPartitionKey(jobId: string): string;
export declare function jobMetaSortKey(): string;
export declare function jobRecordSortKey(recordId: string): string;
export declare function jobLockSortKey(): string;
export declare function jobRequestSortKey(idempotencyKey: string): string;
export declare function semaphorePartitionKey(scope: string, subject: string): string;
export declare function semaphoreSlotSortKey(slot: number): string;
export type ErrorEnvelope = {
    type?: string;
    code?: string;
    message: string;
    retryable?: boolean;
    fields?: Record<string, unknown>;
};
export declare function sanitizeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined;
export declare function sanitizeErrorEnvelope(env: ErrorEnvelope | null | undefined): ErrorEnvelope | undefined;
export type JobsConfig = {
    tableName: string;
    defaultLeaseDurationMs: number;
    defaultIdempotencyTtlSeconds: number;
    defaultJobTtlSeconds: number;
    defaultRecordTtlSeconds: number;
    defaultRequestResultTtlSeconds: number;
};
export declare function defaultJobsConfig(): JobsConfig;
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
export type SemaphoreLease = {
    pk: string;
    sk: string;
    scope: string;
    subject: string;
    slot: number;
    leaseOwner: string;
    leaseExpiresAt: number;
    createdAt: string;
    updatedAt: string;
    ttl?: number;
};
export type SemaphoreInspection = {
    scope: string;
    subject: string;
    occupancy: number;
    activeLeases: SemaphoreLease[];
};
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
export type AcquireSemaphoreSlotInput = {
    scope: string;
    subject: string;
    limit: number;
    owner: string;
    leaseDurationMs?: number;
    ttlSeconds?: number;
};
export type RefreshSemaphoreSlotInput = {
    scope: string;
    subject: string;
    slot: number;
    owner: string;
    leaseDurationMs?: number;
    ttlSeconds?: number;
};
export type ReleaseSemaphoreSlotInput = {
    scope: string;
    subject: string;
    slot: number;
    owner: string;
};
export type InspectSemaphoreInput = {
    scope: string;
    subject: string;
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
export declare class DynamoJobLedger {
    private readonly _theorydb;
    private readonly _config;
    private _clock;
    constructor(options?: {
        theorydb?: TheorydbClient;
        config?: Partial<JobsConfig>;
        clock?: Clock;
    });
    setClock(clock: Clock | null | undefined): void;
    createJob(input: CreateJobInput): Promise<JobMeta>;
    transitionJobStatus(input: TransitionJobStatusInput): Promise<JobMeta>;
    upsertRecordStatus(input: UpsertRecordStatusInput): Promise<JobRecord>;
    acquireLease(input: AcquireLeaseInput): Promise<JobLock>;
    refreshLease(input: RefreshLeaseInput): Promise<JobLock>;
    releaseLease(input: ReleaseLeaseInput): Promise<void>;
    acquireSemaphoreSlot(input: AcquireSemaphoreSlotInput): Promise<SemaphoreLease>;
    refreshSemaphoreSlot(input: RefreshSemaphoreSlotInput): Promise<SemaphoreLease>;
    releaseSemaphoreSlot(input: ReleaseSemaphoreSlotInput): Promise<void>;
    inspectSemaphore(input: InspectSemaphoreInput): Promise<SemaphoreInspection>;
    createIdempotencyRecord(input: CreateIdempotencyRecordInput): Promise<{
        request: JobRequest;
        outcome: IdempotencyCreateOutcome;
    }>;
    completeIdempotencyRecord(input: CompleteIdempotencyRecordInput): Promise<JobRequest>;
}
