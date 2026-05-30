import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";
import { logSafeValue } from "./internal/safe-log.js";
const CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_DECODED_BYTES = 6 * 1024 * 1024;
const CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE = "apptheory: decode cloudwatch logs subscription";
/**
 * Decode a Kinesis record containing a CloudWatch Logs subscription envelope.
 *
 * AWS delivers CloudWatch Logs subscription payloads to Kinesis as
 * gzip-compressed JSON bytes encoded in the Lambda Kinesis record's
 * `kinesis.data` field. The returned `safe_summary` intentionally excludes raw
 * log event messages so callers can use it in logs, metrics, spans, and
 * fixture summaries without copying customer log material.
 */
export function decodeCloudWatchLogsSubscription(record) {
    const recordId = String(record?.eventID ?? "").trim();
    if (!recordId) {
        throw new Error(`${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: missing kinesis eventID`);
    }
    const payloadBytes = gunzipCloudWatchLogsSubscriptionData(record?.kinesis?.data);
    const payload = parseCloudWatchLogsSubscriptionPayload(payloadBytes);
    const decoded = {
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
function gunzipCloudWatchLogsSubscriptionData(data) {
    const dataB64 = String(data ?? "").trim();
    if (!dataB64) {
        throw new Error(`${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: empty kinesis data`);
    }
    const compressed = Buffer.from(dataB64, "base64");
    let payload;
    try {
        payload = gunzipSync(compressed, {
            maxOutputLength: CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_DECODED_BYTES + 1,
        });
    }
    catch (error) {
        if (isMaxOutputLengthError(error)) {
            throw new Error(`${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: payload too large`);
        }
        throw new Error(`${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE} gzip: invalid payload`);
    }
    if (payload.length > CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_DECODED_BYTES) {
        throw new Error(`${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: payload too large`);
    }
    return payload;
}
function parseCloudWatchLogsSubscriptionPayload(payloadBytes) {
    let parsed;
    try {
        parsed = JSON.parse(payloadBytes.toString("utf8"));
    }
    catch {
        throw new Error(`${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE} json: invalid payload`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE} json: expected object`);
    }
    return parsed;
}
function validateCloudWatchLogsSubscription(decoded) {
    const missing = [];
    if (!decoded.message_type.trim())
        missing.push("messageType");
    if (!decoded.owner.trim())
        missing.push("owner");
    if (!decoded.log_group.trim())
        missing.push("logGroup");
    if (!decoded.log_stream.trim())
        missing.push("logStream");
    if (decoded.subscription_filters.length === 0) {
        missing.push("subscriptionFilters");
    }
    if (missing.length > 0) {
        throw new Error(`${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: missing ${missing.join(", ")}`);
    }
    decoded.subscription_filters.forEach((filter, index) => {
        if (!filter.trim()) {
            throw new Error(`${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: empty subscriptionFilters[${index}]`);
        }
    });
    decoded.log_events.forEach((event, index) => {
        if (!event.id.trim()) {
            throw new Error(`${CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: empty logEvents[${index}].id`);
        }
    });
}
function cloudWatchLogsSubscriptionSafeSummary(decoded) {
    const subscriptionFilterCount = decoded.subscription_filters.length;
    const logEventCount = decoded.log_events.length;
    const safeLog = `record_id=${logSafeValue(decoded.record_id)} ` +
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
function payloadString(payload, key) {
    const value = payload[key];
    return typeof value === "string" ? value.trim() : "";
}
function payloadStringArray(payload, key) {
    const value = payload[key];
    if (!Array.isArray(value) || value.length === 0) {
        return [];
    }
    return value.map((item) => (typeof item === "string" ? item.trim() : ""));
}
function payloadLogEvents(payload, key) {
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
function objectRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    return value;
}
function recordString(record, key) {
    const value = record[key];
    return typeof value === "string" ? value : "";
}
function recordInteger(record, key) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return 0;
    }
    return Math.trunc(value);
}
function isMaxOutputLengthError(error) {
    if (!error || typeof error !== "object") {
        return false;
    }
    const code = error.code;
    if (code === "ERR_BUFFER_TOO_LARGE" || code === "ERR_OUT_OF_RANGE") {
        return true;
    }
    const message = String(error.message ?? "");
    return message.includes("maxOutputLength") || message.includes("larger than");
}
