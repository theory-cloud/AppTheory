import type { KinesisEventRecord } from "./aws-types.js";
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
/**
 * Decode a Kinesis record containing a CloudWatch Logs subscription envelope.
 *
 * AWS delivers CloudWatch Logs subscription payloads to Kinesis as
 * gzip-compressed JSON bytes encoded in the Lambda Kinesis record's
 * `kinesis.data` field. The returned `safe_summary` intentionally excludes raw
 * log event messages so callers can use it in logs, metrics, spans, and
 * fixture summaries without copying customer log material.
 */
export declare function decodeCloudWatchLogsSubscription(record: KinesisEventRecord): CloudWatchLogsSubscription;
