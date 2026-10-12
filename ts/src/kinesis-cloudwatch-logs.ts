import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";

import type { KinesisEventRecord } from "./aws-types.js";
import { logSafeValue } from "./internal/safe-log.js";

// CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_DECODED_BYTES is the schema-appropriate
// ceiling for one decompressed CloudWatch Logs subscription document.
// CloudWatch Logs caps its uncompressed payload near 1 MB, so this bound (down
// from 6 MiB) is generous for a real payload while keeping a hostile, highly
// compressed record from expanding into a far larger JavaScript object graph
// than the Lambda memory allocation can hold.
const CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_DECODED_BYTES = 2 * 1024 * 1024;
// CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_COMPRESSION_RATIO bounds the
// decoded/compressed ratio. A legitimate gzip of JSON log text is far below
// this; a record that decodes to many times the space it occupied (the "junk
// bomb" pattern) is rejected before JSON.parse materializes it.
const CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_COMPRESSION_RATIO = 500;
// CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_FILTERS and ..._MAX_LOG_EVENTS bound array
// cardinality before the accepted arrays are copied into the decoded result.
const CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_FILTERS = 1024;
const CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_LOG_EVENTS = 10000;
const CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE =
  "apptheory: decode cloudwatch logs subscription";

// CLOUDWATCH_LOGS_SUBSCRIPTION_KNOWN_FIELDS is the documented top-level
// CloudWatch Logs subscription envelope. Any other top-level field is rejected
// so an ignored, attacker-sized array (for example a "junk" array) cannot be
// smuggled into the document.
const CLOUDWATCH_LOGS_SUBSCRIPTION_KNOWN_FIELDS = new Set([
  "messageType",
  "owner",
  "logGroup",
  "logStream",
  "subscriptionFilters",
  "logEvents",
]);

/** One decoded CloudWatch Logs subscription envelope carried by a Kinesis record. */
export interface CloudWatchLogsSubscription {
  record_id: string;
  message_type: string;
  owner: string;
  log_group: string;
  log_stream: string;
  subscription_filters: string[];
  log_events: CloudWatchLogsSubscriptionLogEvent[];
  safe_summary: CloudWatchLogsSubscriptionSummary;
}

/** One decoded CloudWatch Logs event from a subscription envelope. */
export interface CloudWatchLogsSubscriptionLogEvent {
  id: string;
  timestamp: number;
  message: string;
}

/** Safe, non-message summary for a decoded subscription envelope. */
export interface CloudWatchLogsSubscriptionSummary {
  record_id: string;
  message_type: string;
  owner: string;
  log_group: string;
  log_stream: string;
  subscription_filter_count: number;
  log_event_count: number;
  safe_log: string;
}

type CloudWatchLogsSubscriptionWithoutSummary = Omit<
  CloudWatchLogsSubscription,
  "safe_summary"
>;

/**
 * Decode a Kinesis record containing a CloudWatch Logs subscription envelope.
 *
 * AWS delivers CloudWatch Logs subscription payloads to Kinesis as
 * gzip-compressed JSON bytes encoded in the Lambda Kinesis record's
 * `kinesis.data` field. The returned `safe_summary` intentionally excludes raw
 * log event messages so callers can use it in logs, metrics, spans, and
 * fixture summaries without copying customer log material.
 */
export function decodeCloudWatchLogsSubscription(
  record: KinesisEventRecord,
): CloudWatchLogsSubscription {
  const recordId = String(record?.eventID ?? "").trim();
  if (!recordId) {
    throw new Error(
      `${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: missing kinesis eventID`,
    );
  }

  const payloadBytes = gunzipCloudWatchLogsSubscriptionData(
    record?.kinesis?.data,
  );
  const payload = parseCloudWatchLogsSubscriptionPayload(payloadBytes);
  assertCloudWatchLogsSubscriptionCardinality(payload);
  const decoded: CloudWatchLogsSubscriptionWithoutSummary = {
    record_id: recordId,
    message_type: payloadString(payload, "messageType"),
    owner: payloadString(payload, "owner"),
    log_group: payloadString(payload, "logGroup"),
    log_stream: payloadString(payload, "logStream"),
    subscription_filters: payloadStringArray(payload, "subscriptionFilters"),
    log_events: payloadLogEvents(payload, "logEvents"),
  };

  validateCloudWatchLogsSubscription(decoded);
  return {
    ...decoded,
    safe_summary: cloudWatchLogsSubscriptionSafeSummary(decoded),
  };
}

function gunzipCloudWatchLogsSubscriptionData(
  data: string | undefined,
): Buffer {
  const dataB64 = String(data ?? "").trim();
  if (!dataB64) {
    throw new Error(
      `${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: empty kinesis data`,
    );
  }

  const compressed = Buffer.from(dataB64, "base64");
  let payload: Buffer;
  try {
    payload = gunzipSync(compressed, {
      maxOutputLength: CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_DECODED_BYTES + 1,
    });
  } catch (error) {
    if (isMaxOutputLengthError(error)) {
      throw new Error(
        `${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: payload too large`,
        { cause: error },
      );
    }
    throw new Error(
      `${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE} gzip: invalid payload`,
      { cause: error },
    );
  }

  if (payload.length > CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_DECODED_BYTES) {
    throw new Error(
      `${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: payload too large`,
    );
  }
  if (
    payload.length >
    compressed.length * CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_COMPRESSION_RATIO
  ) {
    throw new Error(
      `${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: payload compression ratio exceeded`,
    );
  }
  return payload;
}

function parseCloudWatchLogsSubscriptionPayload(
  payloadBytes: Buffer,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new Error(
      `${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE} json: invalid payload`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE} json: expected object`,
    );
  }
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (!CLOUDWATCH_LOGS_SUBSCRIPTION_KNOWN_FIELDS.has(key)) {
      throw new Error(
        `${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: unknown field ${JSON.stringify(key)}`,
      );
    }
  }
  return parsed as Record<string, unknown>;
}

function assertCloudWatchLogsSubscriptionCardinality(
  payload: Record<string, unknown>,
): void {
  const filters = payload["subscriptionFilters"];
  if (
    Array.isArray(filters) &&
    filters.length > CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_FILTERS
  ) {
    throw new Error(
      `${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: too many subscriptionFilters`,
    );
  }
  const logEvents = payload["logEvents"];
  if (
    Array.isArray(logEvents) &&
    logEvents.length > CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_LOG_EVENTS
  ) {
    throw new Error(
      `${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: too many logEvents`,
    );
  }
}

function validateCloudWatchLogsSubscription(
  decoded: CloudWatchLogsSubscriptionWithoutSummary,
): void {
  const missing: string[] = [];
  if (!decoded.message_type.trim()) missing.push("messageType");
  if (!decoded.owner.trim()) missing.push("owner");
  if (!decoded.log_group.trim()) missing.push("logGroup");
  if (!decoded.log_stream.trim()) missing.push("logStream");
  if (decoded.subscription_filters.length === 0) {
    missing.push("subscriptionFilters");
  }
  if (missing.length > 0) {
    throw new Error(
      `${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: missing ${missing.join(", ")}`,
    );
  }

  decoded.subscription_filters.forEach((filter, index) => {
    if (!filter.trim()) {
      throw new Error(
        `${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: empty subscriptionFilters[${index}]`,
      );
    }
  });
  decoded.log_events.forEach((event, index) => {
    if (!event.id.trim()) {
      throw new Error(
        `${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: empty logEvents[${index}].id`,
      );
    }
  });
}

function cloudWatchLogsSubscriptionSafeSummary(
  decoded: CloudWatchLogsSubscriptionWithoutSummary,
): CloudWatchLogsSubscriptionSummary {
  const subscriptionFilterCount = decoded.subscription_filters.length;
  const logEventCount = decoded.log_events.length;
  const safeLog =
    `record_id=${logSafeValue(decoded.record_id)} ` +
    `owner=${logSafeValue(decoded.owner)} ` +
    `log_group=${logSafeValue(decoded.log_group)} ` +
    `log_stream=${logSafeValue(decoded.log_stream)} ` +
    `message_type=${logSafeValue(decoded.message_type)} log_events=${logEventCount} ` +
    `subscription_filters=${subscriptionFilterCount}`;

  return {
    record_id: decoded.record_id,
    message_type: decoded.message_type,
    owner: decoded.owner,
    log_group: decoded.log_group,
    log_stream: decoded.log_stream,
    subscription_filter_count: subscriptionFilterCount,
    log_event_count: logEventCount,
    safe_log: safeLog,
  };
}

function payloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function payloadStringArray(
  payload: Record<string, unknown>,
  key: string,
): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }
  return value.map((item) => (typeof item === "string" ? item.trim() : ""));
}

function payloadLogEvents(
  payload: Record<string, unknown>,
  key: string,
): CloudWatchLogsSubscriptionLogEvent[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }
  return value.map((item) => {
    const event = objectRecord(item);
    return {
      id: recordString(event, "id").trim(),
      timestamp: recordInteger(event, "timestamp"),
      message: recordString(event, "message"),
    };
  });
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function recordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function recordInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.trunc(value);
}

function isMaxOutputLengthError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (code === "ERR_BUFFER_TOO_LARGE" || code === "ERR_OUT_OF_RANGE") {
    return true;
  }
  const message = String((error as { message?: unknown }).message ?? "");
  return message.includes("maxOutputLength") || message.includes("larger than");
}
