import type { EventBridgeEvent } from "./aws-types.js";
import type { EventContext } from "./context.js";
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
