import { Buffer } from "node:buffer";
const KINESIS_JSON_RECORD_INVALID_MESSAGE = "apptheory: kinesis json record invalid";
const KINESIS_PUT_RECORDS_INVALID_MESSAGE = "apptheory: kinesis put-records result invalid";
const KINESIS_MAX_PARTITION_KEY_BYTES = 256;
const KINESIS_MAX_RECORD_DATA_BYTES = 1024 * 1024;
const KINESIS_MAX_PUT_RECORDS_RECORDS = 500;
const KINESIS_MAX_EXPLICIT_HASH_KEY = "340282366920938463463374607431768211455";
const KINESIS_MAX_ERROR_CODE_BYTES = 128;
const KINESIS_MAX_ERROR_MESSAGE_BYTES = 4096;
/**
 * Return one deterministic JSON record for Kinesis producer calls.
 *
 * The helper validates the partition key, canonicalizes the optional explicit
 * hash key, JSON-encodes the payload with sorted object keys, and enforces
 * Kinesis record bounds. It does not send the record or wrap an AWS SDK client.
 */
export function createKinesisJsonRecord(options) {
    const partitionKey = normalizeKinesisPartitionKey(options.partitionKey);
    const explicitHashKey = normalizeKinesisExplicitHashKey(options.explicitHashKey);
    const data = encodeKinesisJsonPayload(options.payload);
    const record = {
        partition_key: partitionKey,
        data,
        safe_summary: kinesisJsonRecordSafeSummary(partitionKey, data.byteLength, explicitHashKey),
    };
    if (explicitHashKey)
        record.explicit_hash_key = explicitHashKey;
    return record;
}
/**
 * Return safe per-record failures aligned by input and result index.
 *
 * The records must come from createKinesisJsonRecord or equivalent bounded
 * data. The results are the minimal PutRecords-style per-record result shape,
 * not raw SDK client instances or responses. Raw JSON payload bytes and raw
 * error messages are intentionally excluded from the returned summaries.
 */
export function reportKinesisPutRecordsFailures(records, results) {
    if (records.length !== results.length) {
        throw new Error(`${KINESIS_PUT_RECORDS_INVALID_MESSAGE}: records/results length mismatch records=${records.length} results=${results.length}`);
    }
    if (records.length > KINESIS_MAX_PUT_RECORDS_RECORDS) {
        throw new Error(`${KINESIS_PUT_RECORDS_INVALID_MESSAGE}: record count ${records.length} exceeds ${KINESIS_MAX_PUT_RECORDS_RECORDS}`);
    }
    const failures = [];
    for (const [index, record] of records.entries()) {
        const normalizedRecord = normalizeKinesisReportRecord(record, index);
        const result = normalizeKinesisPutRecordsResultRecord(results[index] ?? {}, index);
        if (!result.error_code)
            continue;
        failures.push(kinesisPutRecordsFailure(index, normalizedRecord, result));
    }
    return {
        record_count: records.length,
        failed_record_count: failures.length,
        failures,
        safe_summary: kinesisPutRecordsFailureReportSummary(records.length, failures.length),
    };
}
function encodeKinesisJsonPayload(payload) {
    const json = stableJsonStringify(payload);
    const data = Buffer.from(json, "utf8");
    if (data.byteLength === 0) {
        throw new Error(`${KINESIS_JSON_RECORD_INVALID_MESSAGE}: empty json payload`);
    }
    if (data.byteLength > KINESIS_MAX_RECORD_DATA_BYTES) {
        throw new Error(`${KINESIS_JSON_RECORD_INVALID_MESSAGE}: json payload size ${data.byteLength} exceeds ${KINESIS_MAX_RECORD_DATA_BYTES}`);
    }
    return Uint8Array.from(data);
}
function normalizeKinesisPartitionKey(value) {
    const partitionKey = String(value ?? "").trim();
    if (!partitionKey) {
        throw new Error(`${KINESIS_JSON_RECORD_INVALID_MESSAGE}: partition key is required`);
    }
    const byteLength = Buffer.byteLength(partitionKey, "utf8");
    if (byteLength > KINESIS_MAX_PARTITION_KEY_BYTES) {
        throw new Error(`${KINESIS_JSON_RECORD_INVALID_MESSAGE}: partition key length ${byteLength} exceeds ${KINESIS_MAX_PARTITION_KEY_BYTES} bytes`);
    }
    return partitionKey;
}
function normalizeKinesisExplicitHashKey(value) {
    let explicitHashKey = String(value ?? "").trim();
    if (!explicitHashKey)
        return "";
    if (!/^\d+$/u.test(explicitHashKey)) {
        throw new Error(`${KINESIS_JSON_RECORD_INVALID_MESSAGE}: explicit hash key must be decimal digits`);
    }
    explicitHashKey = explicitHashKey.replace(/^0+/u, "") || "0";
    if (explicitHashKey.length > KINESIS_MAX_EXPLICIT_HASH_KEY.length ||
        (explicitHashKey.length === KINESIS_MAX_EXPLICIT_HASH_KEY.length &&
            explicitHashKey > KINESIS_MAX_EXPLICIT_HASH_KEY)) {
        throw new Error(`${KINESIS_JSON_RECORD_INVALID_MESSAGE}: explicit hash key exceeds Kinesis hash key range`);
    }
    return explicitHashKey;
}
function kinesisJsonRecordSafeSummary(partitionKey, dataByteLength, explicitHashKey) {
    const summary = {
        partition_key: partitionKey,
        data_byte_length: dataByteLength,
        safe_log: `partition_key=${partitionKey} data_bytes=${dataByteLength}`,
    };
    if (explicitHashKey) {
        summary.explicit_hash_key = explicitHashKey;
        summary.safe_log = `partition_key=${partitionKey} explicit_hash_key=${explicitHashKey} data_bytes=${dataByteLength}`;
    }
    return summary;
}
function normalizeKinesisReportRecord(record, index) {
    let partitionKey;
    let explicitHashKey;
    try {
        partitionKey = normalizeKinesisPartitionKey(record.partition_key);
        explicitHashKey = normalizeKinesisExplicitHashKey(record.explicit_hash_key);
    }
    catch (error) {
        throw new Error(`${String(error.message)} at index ${index}`);
    }
    if (!(record.data instanceof Uint8Array) || record.data.byteLength === 0) {
        throw new Error(`${KINESIS_PUT_RECORDS_INVALID_MESSAGE}: empty record data at index ${index}`);
    }
    if (record.data.byteLength > KINESIS_MAX_RECORD_DATA_BYTES) {
        throw new Error(`${KINESIS_PUT_RECORDS_INVALID_MESSAGE}: record data size ${record.data.byteLength} exceeds ${KINESIS_MAX_RECORD_DATA_BYTES} at index ${index}`);
    }
    const normalized = {
        partition_key: partitionKey,
        data: record.data,
        safe_summary: kinesisJsonRecordSafeSummary(partitionKey, record.data.byteLength, explicitHashKey),
    };
    if (explicitHashKey)
        normalized.explicit_hash_key = explicitHashKey;
    return normalized;
}
function normalizeKinesisPutRecordsResultRecord(result, index) {
    const normalized = {
        sequence_number: String(result.sequence_number ?? "").trim(),
        shard_id: String(result.shard_id ?? "").trim(),
        error_code: String(result.error_code ?? "").trim(),
        error_message: String(result.error_message ?? "").trim(),
    };
    if (!normalized.error_code && normalized.error_message) {
        throw new Error(`${KINESIS_PUT_RECORDS_INVALID_MESSAGE}: error message without error code at index ${index}`);
    }
    if (Buffer.byteLength(normalized.error_code, "utf8") >
        KINESIS_MAX_ERROR_CODE_BYTES) {
        throw new Error(`${KINESIS_PUT_RECORDS_INVALID_MESSAGE}: error code too long at index ${index}`);
    }
    if (hasUnsafeErrorCodeRune(normalized.error_code)) {
        throw new Error(`${KINESIS_PUT_RECORDS_INVALID_MESSAGE}: unsafe error code at index ${index}`);
    }
    if (Buffer.byteLength(normalized.error_message, "utf8") >
        KINESIS_MAX_ERROR_MESSAGE_BYTES) {
        throw new Error(`${KINESIS_PUT_RECORDS_INVALID_MESSAGE}: error message too long at index ${index}`);
    }
    return normalized;
}
function hasUnsafeErrorCodeRune(value) {
    for (const char of value) {
        const codePoint = char.codePointAt(0) ?? 0;
        if (codePoint <= 0x20 || codePoint === 0x7f)
            return true;
    }
    return false;
}
function kinesisPutRecordsFailure(index, record, result) {
    const errorMessageByteLength = Buffer.byteLength(result.error_message, "utf8");
    const failure = {
        index,
        partition_key: record.partition_key,
        data_byte_length: record.data.byteLength,
        error_code: result.error_code,
        error_message_present: result.error_message !== "",
        error_message_byte_length: errorMessageByteLength,
        safe_log: "",
    };
    if (record.explicit_hash_key) {
        failure.explicit_hash_key = record.explicit_hash_key;
    }
    failure.safe_log = kinesisPutRecordsFailureSafeLog(failure);
    return failure;
}
function kinesisPutRecordsFailureSafeLog(failure) {
    if (failure.explicit_hash_key) {
        return (`kinesis_put_records_failure index=${failure.index} ` +
            `partition_key=${failure.partition_key} explicit_hash_key=${failure.explicit_hash_key} ` +
            `data_bytes=${failure.data_byte_length} error_code=${failure.error_code} ` +
            `error_message_present=${failure.error_message_present} ` +
            `error_message_bytes=${failure.error_message_byte_length}`);
    }
    return (`kinesis_put_records_failure index=${failure.index} ` +
        `partition_key=${failure.partition_key} data_bytes=${failure.data_byte_length} ` +
        `error_code=${failure.error_code} ` +
        `error_message_present=${failure.error_message_present} ` +
        `error_message_bytes=${failure.error_message_byte_length}`);
}
function kinesisPutRecordsFailureReportSummary(recordCount, failedRecordCount) {
    return {
        record_count: recordCount,
        failed_record_count: failedRecordCount,
        safe_log: `kinesis_put_records record_count=${recordCount} failed_record_count=${failedRecordCount}`,
    };
}
function stableJsonStringify(value) {
    return stableJsonStringifyValue(value, new WeakSet());
}
function stableJsonStringifyValue(value, seen) {
    if (value === null)
        return "null";
    if (typeof value === "string")
        return JSON.stringify(value);
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error(`${KINESIS_JSON_RECORD_INVALID_MESSAGE}: json encode: non-finite number`);
        }
        return JSON.stringify(value);
    }
    if (typeof value !== "object") {
        throw new Error(`${KINESIS_JSON_RECORD_INVALID_MESSAGE}: json encode: unsupported value`);
    }
    if (seen.has(value)) {
        throw new Error(`${KINESIS_JSON_RECORD_INVALID_MESSAGE}: json encode: circular value`);
    }
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return `[${value.map((item) => stableJsonStringifyValue(item, seen)).join(",")}]`;
        }
        if (!isPlainRecord(value)) {
            throw new Error(`${KINESIS_JSON_RECORD_INVALID_MESSAGE}: json encode: unsupported object`);
        }
        const record = value;
        const fields = Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableJsonStringifyValue(record[key], seen)}`);
        return `{${fields.join(",")}}`;
    }
    finally {
        seen.delete(value);
    }
}
function isPlainRecord(value) {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
