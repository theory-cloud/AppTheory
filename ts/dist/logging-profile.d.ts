import type { ObservabilityHooks } from "./app.js";
import type { LogFields, StructuredLogger } from "./logger.js";
export declare const LOGGING_PROFILE_SCHEMA_VERSION = "apptheory.logging/v1";
export declare const LOGGING_PROFILE_PAYTHEORY_ALERT_V1 = "paytheory-alert-v1";
export declare const LOGGING_PROFILE_CLOUDWATCH_JSON = "cloudwatch-json";
export declare const LOGGING_PROFILE_LEGACY = "legacy";
export declare const LOGGING_PROFILE_LOCAL_DEV = "local-dev";
export interface LoggingProfileConfig {
    schema_version?: string;
    profile?: string;
    encoding?: LoggingProfileEncoding;
    levels?: Record<string, string>;
    required_fields?: string[];
    recommended_fields?: string[];
    field_map?: Record<string, string>;
    enrichment?: LoggingProfileEnrichment;
    error_capture?: LoggingProfileErrorCapture;
    sanitization?: LoggingProfileSanitization;
    alerting_hints?: LoggingProfileAlertingHints;
}
export interface LoggingProfileEncoding {
    format?: string;
    timestamp_field?: string;
    timestamp_format?: string;
    level_field?: string;
    message_field?: string;
}
export interface LoggingProfileEnrichment {
    static?: Record<string, string>;
    context?: Record<string, string>;
}
export interface LoggingProfileErrorCapture {
    include_error_type?: boolean;
    include_error_code?: boolean;
    include_stack_trace?: boolean;
    stack_trace_field?: string;
    stack_hash_field?: string;
    stack_hash_algorithm?: string;
}
export interface LoggingProfileSanitization {
    existing_sanitized_logging?: boolean;
    notes?: string;
}
export interface LoggingProfileAlertingHints {
    fingerprint_fields?: string[];
    keeper_lookup_fields?: string[];
}
export declare class LoggingProfileValidationError extends Error {
    readonly errors: string[];
    constructor(errors: string[]);
}
export declare function builtInLoggingProfileNames(): string[];
export declare function loggingProfileCatalog(): Record<string, unknown>;
export declare function defaultLoggingProfile(profile: string): LoggingProfileConfig;
export declare function decodeLoggingProfileJSON(raw: string | Uint8Array): LoggingProfileConfig;
export declare function validateLoggingProfile(config: LoggingProfileConfig): void;
export declare function loggingProfileValidationErrors(config: LoggingProfileConfig): string[];
export interface LoggingProfileEvent {
    timestamp?: Date | string;
    level?: string;
    event?: string;
    message?: string;
    normalized_message?: string;
    request?: LoggingProfileRequestContext;
    job?: LoggingProfileJobContext;
    error?: LoggingProfileError;
    fields?: Record<string, unknown>;
}
export interface LoggingProfileRequestContext {
    request_id?: string;
    tenant_id?: string;
    user_id?: string;
    trace_id?: string;
    span_id?: string;
    correlation_id?: string;
    route?: string;
    method?: string;
    path?: string;
    status?: number;
}
export interface LoggingProfileJobContext {
    name?: string;
}
export interface LoggingProfileError {
    type?: string;
    code?: string;
    message?: string;
    stack_trace?: string;
}
export type LoggingProfileSanitizer = (key: string, value: unknown) => unknown;
export interface ProfileLoggerOptions {
    environment?: Record<string, string>;
    writer?: ((line: string) => void) | null;
    sanitizer?: LoggingProfileSanitizer;
    clock?: () => Date;
}
export declare class ProfileLogger implements StructuredLogger {
    private readonly root;
    private readonly config;
    private readonly environment;
    private readonly writer;
    private readonly sanitizer;
    private readonly clock;
    private readonly context;
    private closed;
    private readonly profileEntries;
    private entriesLogged;
    private lastError;
    constructor(config: LoggingProfileConfig, options?: ProfileLoggerOptions);
    private static fromRoot;
    debug(message: string, ...fields: LogFields[]): void;
    info(message: string, ...fields: LogFields[]): void;
    warn(message: string, ...fields: LogFields[]): void;
    error(message: string, ...fields: LogFields[]): void;
    withField(key: string, value: unknown): StructuredLogger;
    withFields(fields: LogFields): StructuredLogger;
    withRequestID(requestId: string): StructuredLogger;
    withTenantID(tenantId: string): StructuredLogger;
    withUserID(userId: string): StructuredLogger;
    withTraceID(traceId: string): StructuredLogger;
    withSpanID(spanId: string): StructuredLogger;
    flush(): void;
    close(): void;
    isHealthy(): boolean;
    getStats(): LogFields;
    entries(): Record<string, unknown>[];
    private clone;
    private log;
    private retainEntry;
}
export declare function encodeLoggingProfileEvent(config: LoggingProfileConfig, environment: Record<string, string> | undefined, event: LoggingProfileEvent): Record<string, unknown>;
export declare function encodeLoggingProfileEventWithSanitizer(config: LoggingProfileConfig, environment: Record<string, string> | undefined, event: LoggingProfileEvent, sanitizer: LoggingProfileSanitizer | undefined): Record<string, unknown>;
export declare function hooksFromProfileLogger(config: LoggingProfileConfig, options?: ProfileLoggerOptions): {
    hooks: ObservabilityHooks;
    logger: ProfileLogger;
};
export declare function hooksFromLogger(logger: StructuredLogger | null | undefined): ObservabilityHooks;
export declare function isSupportedProfileOutputField(field: string): boolean;
//# sourceMappingURL=logging-profile.d.ts.map