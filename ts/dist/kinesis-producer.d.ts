/** Options for the bounded AppTheory Kinesis JSON producer record helper. */
export interface KinesisJsonRecordOptions {
    partitionKey: string;
    payload: unknown;
    explicitHashKey?: string;
}
/** Deterministic JSON payload plus bounded routing metadata for Kinesis producers. */
export interface KinesisJsonRecord {
    partition_key: string;
    data: Uint8Array;
    explicit_hash_key?: string;
    safe_summary: KinesisJsonRecordSummary;
}
/** Safe, non-payload summary for a Kinesis JSON producer record. */
export interface KinesisJsonRecordSummary {
    partition_key: string;
    data_byte_length: number;
    explicit_hash_key?: string;
    safe_log: string;
}
/** Bounded per-record result shape for Kinesis PutRecords-style responses. */
export interface KinesisPutRecordsResultRecord {
    sequence_number?: string;
    shard_id?: string;
    error_code?: string;
    error_message?: string;
}
/** Safe per-record failure summary aligned by input/result index. */
export interface KinesisPutRecordsFailure {
    index: number;
    partition_key: string;
    data_byte_length: number;
    error_code: string;
    error_message_present: boolean;
    error_message_byte_length: number;
    explicit_hash_key?: string;
    safe_log: string;
}
/** Safe aggregate summary for a PutRecords-style result. */
export interface KinesisPutRecordsFailureReportSummary {
    record_count: number;
    failed_record_count: number;
    safe_log: string;
}
/** Per-record PutRecords-style failures without JSON payload bodies. */
export interface KinesisPutRecordsFailureReport {
    record_count: number;
    failed_record_count: number;
    failures: KinesisPutRecordsFailure[];
    safe_summary: KinesisPutRecordsFailureReportSummary;
}
/**
 * Return one deterministic JSON record for Kinesis producer calls.
 *
 * The helper validates the partition key, canonicalizes the optional explicit
 * hash key, JSON-encodes the payload with sorted object keys, and enforces
 * Kinesis record bounds. It does not send the record or wrap an AWS SDK client.
 */
export declare function createKinesisJsonRecord(options: KinesisJsonRecordOptions): KinesisJsonRecord;
/**
 * Return safe per-record failures aligned by input and result index.
 *
 * The records must come from createKinesisJsonRecord or equivalent bounded
 * data. The results are the minimal PutRecords-style per-record result shape,
 * not raw SDK client instances or responses. Raw JSON payload bytes and raw
 * error messages are intentionally excluded from the returned summaries.
 */
export declare function reportKinesisPutRecordsFailures(records: KinesisJsonRecord[], results: KinesisPutRecordsResultRecord[]): KinesisPutRecordsFailureReport;
