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
export declare function isSupportedProfileOutputField(field: string): boolean;
