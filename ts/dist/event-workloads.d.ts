import type { DynamoDBStreamRecord, EventBridgeEvent } from "./aws-types.js";
import type { EventContext } from "./context.js";
/** Portable, safe summary for a DynamoDB Streams record. */
export interface DynamoDBStreamRecordSummary {
    aws_region: string;
    event_id: string;
    event_name: string;
    safe_log: string;
    sequence_number: string;
    size_bytes: number;
    stream_view_type: string;
    table_name: string;
}
/** Portable, safe summary AppTheory exposes for EventBridge workloads. */
export interface EventBridgeWorkloadEnvelope {
    account: string;
    correlation_id: string;
    correlation_source: string;
    detail_type: string;
    event_id: string;
    region: string;
    request_id: string;
    resources: string[];
    source: string;
    time: string;
}
/** Safe result summary for a scheduled EventBridge workload. */
export interface EventBridgeScheduledWorkloadResultSummary {
    failed: number;
    processed: number;
    status: string;
}
/** Portable summary for EventBridge scheduled workloads. */
export interface EventBridgeScheduledWorkloadSummary {
    correlation_id: string;
    correlation_source: string;
    deadline_unix_ms: number;
    detail_type: string;
    event_id: string;
    idempotency_key: string;
    kind: "scheduled";
    remaining_ms: number;
    result: EventBridgeScheduledWorkloadResultSummary;
    run_id: string;
    scheduled_time: string;
    source: string;
}
/**
 * Return a portable, safe summary for a DynamoDB Streams record.
 *
 * Raw Keys, NewImage, and OldImage values are intentionally excluded so item
 * material cannot be copied into logs, metrics, spans, or handler summaries
 * through this helper.
 */
export declare function normalizeDynamoDBStreamRecord(record: DynamoDBStreamRecord): DynamoDBStreamRecordSummary;
/**
 * Return the canonical EventBridge workload envelope.
 *
 * Correlation IDs are selected in contract order: metadata.correlation_id,
 * headers["x-correlation-id"], detail.correlation_id, event.id, and finally the
 * Lambda awsRequestId.
 */
export declare function normalizeEventBridgeWorkloadEnvelope(ctx: EventContext | null | undefined, event: EventBridgeEvent): EventBridgeWorkloadEnvelope;
/**
 * Return the canonical EventBridge workload envelope and fail closed when source,
 * detail type, or correlation identity is missing.
 */
export declare function requireEventBridgeWorkloadEnvelope(ctx: EventContext | null | undefined, event: EventBridgeEvent): EventBridgeWorkloadEnvelope;
/** Return the canonical scheduled workload summary for an EventBridge scheduled event. */
export declare function normalizeEventBridgeScheduledWorkload(ctx: EventContext | null | undefined, event: EventBridgeEvent): EventBridgeScheduledWorkloadSummary;
