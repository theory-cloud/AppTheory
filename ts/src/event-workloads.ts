import type { EventBridgeEvent } from "./aws-types.js";
import type { EventContext } from "./context.js";

const EVENTBRIDGE_ENVELOPE_INVALID =
  "apptheory: eventbridge workload envelope invalid";

const CORRELATION_SOURCE_METADATA = "metadata.correlation_id";
const CORRELATION_SOURCE_HEADER = "headers.x-correlation-id";
const CORRELATION_SOURCE_DETAIL = "detail.correlation_id";
const CORRELATION_SOURCE_EVENT_ID = "event.id";
const CORRELATION_SOURCE_AWS_REQUEST_ID = "lambda.aws_request_id";

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

class SafeEventError extends Error {
  readonly safeEventError = true;

  constructor(message: string) {
    super(message);
    this.name = "SafeEventError";
  }
}

/**
 * Return the canonical EventBridge workload envelope.
 *
 * Correlation IDs are selected in contract order: metadata.correlation_id,
 * headers["x-correlation-id"], detail.correlation_id, event.id, and finally the
 * Lambda awsRequestId.
 */
export function normalizeEventBridgeWorkloadEnvelope(
  ctx: EventContext | null | undefined,
  event: EventBridgeEvent,
): EventBridgeWorkloadEnvelope {
  const detail = objectFromValue(event?.detail);
  const { correlationId, correlationSource } = eventBridgeCorrelationId(
    ctx,
    event,
    detail,
  );

  return {
    account: objectString(event, "account"),
    correlation_id: correlationId,
    correlation_source: correlationSource,
    detail_type: eventDetailType(event),
    event_id: objectString(event, "id"),
    region: objectString(event, "region"),
    request_id: eventContextRequestId(ctx),
    resources: Array.isArray(event?.resources)
      ? event.resources.map((resource) => String(resource))
      : [],
    source: objectString(event, "source"),
    time: eventTime(event),
  };
}

/**
 * Return the canonical EventBridge workload envelope and fail closed when source,
 * detail type, or correlation identity is missing.
 */
export function requireEventBridgeWorkloadEnvelope(
  ctx: EventContext | null | undefined,
  event: EventBridgeEvent,
): EventBridgeWorkloadEnvelope {
  const envelope = normalizeEventBridgeWorkloadEnvelope(ctx, event);
  if (!envelope.source || !envelope.detail_type || !envelope.correlation_id) {
    throw new SafeEventError(EVENTBRIDGE_ENVELOPE_INVALID);
  }
  return envelope;
}

function eventBridgeCorrelationId(
  ctx: EventContext | null | undefined,
  event: EventBridgeEvent,
  detail: Record<string, unknown>,
): { correlationId: string; correlationSource: string } {
  const metadataCorrelation = objectString(
    objectFromValue((event as Record<string, unknown>)["metadata"]),
    "correlation_id",
  );
  if (metadataCorrelation) {
    return {
      correlationId: metadataCorrelation,
      correlationSource: CORRELATION_SOURCE_METADATA,
    };
  }

  const headerCorrelation = headerString(
    objectFromValue((event as Record<string, unknown>)["headers"]),
    "x-correlation-id",
  );
  if (headerCorrelation) {
    return {
      correlationId: headerCorrelation,
      correlationSource: CORRELATION_SOURCE_HEADER,
    };
  }

  const detailCorrelation = objectString(detail, "correlation_id");
  if (detailCorrelation) {
    return {
      correlationId: detailCorrelation,
      correlationSource: CORRELATION_SOURCE_DETAIL,
    };
  }

  const eventId = objectString(event, "id");
  if (eventId) {
    return {
      correlationId: eventId,
      correlationSource: CORRELATION_SOURCE_EVENT_ID,
    };
  }

  const awsRequestId = lambdaAWSRequestId(ctx);
  if (awsRequestId) {
    return {
      correlationId: awsRequestId,
      correlationSource: CORRELATION_SOURCE_AWS_REQUEST_ID,
    };
  }

  return { correlationId: "", correlationSource: "" };
}

function eventDetailType(event: EventBridgeEvent): string {
  return asTrimmedString(
    (event as Record<string, unknown>)["detail-type"] ?? event?.detailType,
  );
}

function eventTime(event: EventBridgeEvent): string {
  const value = (event as Record<string, unknown>)["time"];
  if (typeof value === "string") return value.trim();
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  return "";
}

function eventContextRequestId(ctx: EventContext | null | undefined): string {
  return typeof ctx?.requestId === "string" ? ctx.requestId.trim() : "";
}

function lambdaAWSRequestId(ctx: EventContext | null | undefined): string {
  const lambdaContext = ctx?.ctx;
  if (!lambdaContext || typeof lambdaContext !== "object") return "";
  return objectString(lambdaContext as Record<string, unknown>, "awsRequestId");
}

function objectFromValue(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function objectString(object: Record<string, unknown>, key: string): string {
  return asTrimmedString(object[key]);
}

function headerString(headers: Record<string, unknown>, key: string): string {
  const wanted = key.trim().toLowerCase();
  if (!wanted) return "";

  for (const [name, value] of Object.entries(headers)) {
    if (name.trim().toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const candidate = asTrimmedString(entry);
        if (candidate) return candidate;
      }
      return "";
    }
    return asTrimmedString(value);
  }
  return "";
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
