import { createHash } from "node:crypto";
import { sanitizeFieldValue, sanitizeLogString } from "./sanitization.js";
export const LOGGING_PROFILE_SCHEMA_VERSION = "apptheory.logging/v1";
export const LOGGING_PROFILE_PAYTHEORY_ALERT_V1 = "paytheory-alert-v1";
export const LOGGING_PROFILE_CLOUDWATCH_JSON = "cloudwatch-json";
export const LOGGING_PROFILE_LEGACY = "legacy";
export const LOGGING_PROFILE_LOCAL_DEV = "local-dev";
export class LoggingProfileValidationError extends Error {
    errors;
    constructor(errors) {
        const message = errors.length === 0
            ? "logging profile validation failed"
            : `logging profile validation failed: ${errors.join("; ")}`;
        super(message);
        this.name = "LoggingProfileValidationError";
        this.errors = [...errors];
    }
}
export function builtInLoggingProfileNames() {
    return [
        LOGGING_PROFILE_CLOUDWATCH_JSON,
        LOGGING_PROFILE_LEGACY,
        LOGGING_PROFILE_LOCAL_DEV,
        LOGGING_PROFILE_PAYTHEORY_ALERT_V1,
    ].sort();
}
export function loggingProfileCatalog() {
    return {
        schema_version: LOGGING_PROFILE_SCHEMA_VERSION,
        profiles: builtInLoggingProfileNames(),
    };
}
export function defaultLoggingProfile(profile) {
    const key = normalizeProfileToken(profile);
    if (key === LOGGING_PROFILE_PAYTHEORY_ALERT_V1)
        return payTheoryAlertProfile();
    if (key === LOGGING_PROFILE_CLOUDWATCH_JSON) {
        const cfg = baseJSONProfile(LOGGING_PROFILE_CLOUDWATCH_JSON);
        cfg.required_fields = ["timestamp", "level", "message"];
        return cfg;
    }
    if (key === LOGGING_PROFILE_LEGACY) {
        const cfg = baseJSONProfile(LOGGING_PROFILE_LEGACY);
        cfg.encoding = {
            ...cfg.encoding,
            timestamp_field: "timestamp",
            level_field: "level",
            message_field: "message",
        };
        return cfg;
    }
    if (key === LOGGING_PROFILE_LOCAL_DEV) {
        const cfg = baseJSONProfile(LOGGING_PROFILE_LOCAL_DEV);
        cfg.levels = { debug: "DEBUG", info: "INFO", warn: "WARN", error: "ERROR" };
        return cfg;
    }
    throw new Error(`profile: unsupported value ${String(profile ?? "").trim()}`);
}
export function decodeLoggingProfileJSON(raw) {
    let parsed;
    try {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        parsed = JSON.parse(text);
    }
    catch (error) {
        throw new Error(`logging profile json: ${errorMessage(error)}`);
    }
    if (!isRecord(parsed)) {
        throw new Error("logging profile json: root must be an object");
    }
    const strictErrors = validateLoggingProfileJSONOptions("", parsed, loggingProfileJSONOptions);
    const config = parsed;
    const errors = [...strictErrors, ...loggingProfileValidationErrors(config)];
    if (errors.length > 0)
        throw new LoggingProfileValidationError(errors);
    return config;
}
export function validateLoggingProfile(config) {
    const errors = loggingProfileValidationErrors(config);
    if (errors.length > 0)
        throw new LoggingProfileValidationError(errors);
}
export function loggingProfileValidationErrors(config) {
    const errors = [];
    const schema = trimString(config.schema_version);
    if (!schema) {
        errors.push("schema_version: required");
    }
    else if (schema !== LOGGING_PROFILE_SCHEMA_VERSION) {
        errors.push(`schema_version: unsupported value ${schema}`);
    }
    const profile = normalizeProfileToken(config.profile ?? "");
    if (!profile) {
        errors.push("profile: required");
    }
    else if (!isSupportedProfile(profile)) {
        errors.push(`profile: unsupported value ${trimString(config.profile)}`);
    }
    const encoding = config.encoding ?? {};
    const format = trimString(encoding.format).toLowerCase();
    if (!format) {
        errors.push("encoding.format: required");
    }
    else if (format !== "json") {
        errors.push(`encoding.format: unsupported value ${trimString(encoding.format)}`);
    }
    const timestampFormat = trimString(encoding.timestamp_format).toLowerCase();
    if (timestampFormat &&
        timestampFormat !== "rfc3339nano" &&
        timestampFormat !== "rfc3339") {
        errors.push(`encoding.timestamp_format: unsupported value ${trimString(encoding.timestamp_format)}`);
    }
    errors.push(...validateEncodingOutputField("encoding.timestamp_field", encoding.timestamp_field));
    errors.push(...validateEncodingOutputField("encoding.level_field", encoding.level_field));
    errors.push(...validateEncodingOutputField("encoding.message_field", encoding.message_field));
    errors.push(...validateLevelMap(config.levels));
    errors.push(...validateProfileFieldList("required_fields", config.required_fields));
    errors.push(...validateProfileFieldList("recommended_fields", config.recommended_fields));
    errors.push(...validateFieldMap(config.field_map));
    errors.push(...validateStaticEnrichment(config.enrichment?.static));
    errors.push(...validateContextEnrichment(config.enrichment?.context));
    errors.push(...validateErrorCapture(config.error_capture));
    errors.push(...validateAlertingHints(config.alerting_hints));
    return errors;
}
export class ProfileLogger {
    root;
    config;
    environment;
    writer;
    sanitizer;
    clock;
    context;
    closed = false;
    profileEntries = [];
    entriesLogged = 0;
    lastError = "";
    constructor(config, options = {}) {
        validateLoggingProfile(config);
        this.root = this;
        this.config = config;
        this.environment = { ...(options.environment ?? {}) };
        this.writer =
            options.writer === undefined
                ? (line) => process.stdout.write(`${line}\n`)
                : options.writer;
        this.sanitizer = options.sanitizer ?? sanitizeFieldValue;
        this.clock = options.clock ?? (() => new Date());
        this.context = {
            fields: {},
            requestId: "",
            tenantId: "",
            userId: "",
            traceId: "",
            spanId: "",
        };
    }
    static fromRoot(root, context) {
        const logger = Object.create(ProfileLogger.prototype);
        const mutable = logger;
        mutable["root"] = root.root;
        mutable["config"] = root.config;
        mutable["environment"] = { ...root.environment };
        mutable["writer"] = root.writer;
        mutable["sanitizer"] = root.sanitizer;
        mutable["clock"] = root.clock;
        mutable["context"] = context;
        mutable["closed"] = false;
        mutable["profileEntries"] = [];
        mutable["entriesLogged"] = 0;
        mutable["lastError"] = "";
        return logger;
    }
    debug(message, ...fields) {
        this.log("debug", message, fields);
    }
    info(message, ...fields) {
        this.log("info", message, fields);
    }
    warn(message, ...fields) {
        this.log("warn", message, fields);
    }
    error(message, ...fields) {
        this.log("error", message, fields);
    }
    withField(key, value) {
        return this.withFields({ [key]: value });
    }
    withFields(fields) {
        return this.clone({ fields: { ...this.context.fields, ...fields } });
    }
    withRequestID(requestId) {
        return this.clone({ requestId });
    }
    withTenantID(tenantId) {
        return this.clone({ tenantId });
    }
    withUserID(userId) {
        return this.clone({ userId });
    }
    withTraceID(traceId) {
        return this.clone({ traceId });
    }
    withSpanID(spanId) {
        return this.clone({ spanId });
    }
    flush() { }
    close() {
        this.root.closed = true;
    }
    isHealthy() {
        return !this.root.closed && !this.root.lastError;
    }
    getStats() {
        return {
            entries_logged: this.root.entriesLogged,
            last_error: this.root.lastError,
        };
    }
    entries() {
        return this.root.profileEntries.map((entry) => ({ ...entry }));
    }
    clone(overrides) {
        return ProfileLogger.fromRoot(this, {
            fields: overrides.fields ?? { ...this.context.fields },
            requestId: overrides.requestId ?? this.context.requestId,
            tenantId: overrides.tenantId ?? this.context.tenantId,
            userId: overrides.userId ?? this.context.userId,
            traceId: overrides.traceId ?? this.context.traceId,
            spanId: overrides.spanId ?? this.context.spanId,
        });
    }
    log(level, message, fieldSets) {
        if (this.root.closed)
            return;
        const merged = { ...this.context.fields };
        for (const fields of fieldSets)
            Object.assign(merged, fields);
        const event = {
            timestamp: this.clock(),
            level,
            message,
            request: {
                request_id: this.context.requestId,
                tenant_id: this.context.tenantId,
                user_id: this.context.userId,
                trace_id: this.context.traceId,
                span_id: this.context.spanId,
            },
            fields: merged,
        };
        applyKnownProfileFieldsToEvent(event, merged);
        try {
            const encoded = encodeLoggingProfileEventWithSanitizer(this.config, this.environment, event, this.sanitizer);
            this.root.profileEntries.push({ ...encoded });
            if (this.writer)
                this.writer(JSON.stringify(encoded));
            this.root.entriesLogged += 1;
        }
        catch (error) {
            this.root.lastError = errorMessage(error);
        }
    }
}
export function encodeLoggingProfileEvent(config, environment, event) {
    return encodeLoggingProfileEventWithSanitizer(config, environment, event, sanitizeFieldValue);
}
export function encodeLoggingProfileEventWithSanitizer(config, environment, event, sanitizer) {
    validateLoggingProfile(config);
    const sanitizerFn = sanitizer ?? sanitizeFieldValue;
    const out = {};
    putProfileField(out, timestampField(config), formatProfileTimestamp(event.timestamp, config.encoding?.timestamp_format), sanitizerFn);
    putProfileField(out, levelField(config), profileLevel(config, event.level), sanitizerFn);
    putProfileField(out, messageField(config), sanitizeLogString(String(event.message ?? "")), sanitizerFn);
    if (trimString(event.event)) {
        putCanonicalMappedField(out, config, "event", event.event, sanitizerFn);
    }
    if (trimString(event.normalized_message)) {
        putCanonicalMappedField(out, config, "normalized_message", event.normalized_message, sanitizerFn);
    }
    applyStaticEnrichment(out, config, environment, sanitizerFn);
    applyContextEnrichment(out, config, event, sanitizerFn);
    applyErrorCapture(out, config, event, sanitizerFn);
    applySafeEventFields(out, event.fields, sanitizerFn);
    const missing = missingRequiredProfileFields(out, config.required_fields);
    if (missing.length > 0) {
        throw new Error(`logging profile required fields missing: ${missing.join(", ")}`);
    }
    return out;
}
export function hooksFromProfileLogger(config, options = {}) {
    const logger = new ProfileLogger(config, options);
    return { hooks: hooksFromLogger(logger), logger };
}
export function hooksFromLogger(logger) {
    if (!logger)
        return {};
    return {
        log(record) {
            const fields = {
                event: record.event,
                method: record.method,
                path: record.path,
                status: record.status,
                error_code: record.errorCode,
            };
            addIfPresent(fields, "trigger", record.trigger);
            addIfPresent(fields, "correlation_id", record.correlationId);
            addIfPresent(fields, "source", record.source);
            addIfPresent(fields, "detail_type", record.detailType);
            addIfPresent(fields, "table_name", record.tableName);
            addIfPresent(fields, "event_id", record.eventId);
            addIfPresent(fields, "event_name", record.eventName);
            const scoped = logger
                .withRequestID(record.requestId)
                .withTenantID(record.tenantId);
            if (record.level === "error")
                scoped.error(record.event, fields);
            else if (record.level === "warn")
                scoped.warn(record.event, fields);
            else if (record.level === "debug")
                scoped.debug(record.event, fields);
            else
                scoped.info(record.event, fields);
        },
    };
}
function addIfPresent(fields, key, value) {
    if (trimString(value))
        fields[key] = value;
}
function timestampField(config) {
    const field = trimString(config.encoding?.timestamp_field);
    if (field)
        return field;
    return mappedFieldOrDefault(config, "timestamp", "timestamp");
}
function levelField(config) {
    const field = trimString(config.encoding?.level_field);
    if (field)
        return field;
    return mappedFieldOrDefault(config, "severity", "level");
}
function messageField(config) {
    const field = trimString(config.encoding?.message_field);
    if (field)
        return field;
    return mappedFieldOrDefault(config, "message", "message");
}
function mappedFieldOrDefault(config, canonical, fallback) {
    const mapped = trimString(config.field_map?.[canonical]);
    return mapped || fallback;
}
function putCanonicalMappedField(out, config, canonical, value, sanitizer) {
    putProfileField(out, mappedFieldOrDefault(config, canonical, canonical), value, sanitizer);
}
function putProfileField(out, field, value, sanitizer) {
    const key = trimString(field);
    if (!key || isZeroProfileValue(value))
        return;
    out[key] = sanitizer(key, value);
}
function putProfileRawString(out, field, value) {
    const key = trimString(field);
    const text = trimString(value);
    if (!key || !text)
        return;
    out[key] = value;
}
function profileLevel(config, level) {
    const key = trimString(level).toLowerCase() || "info";
    const mapped = trimString(config.levels?.[key]);
    return mapped || key.toUpperCase();
}
function formatProfileTimestamp(value, format) {
    const date = normalizeDate(value);
    const iso = date.toISOString();
    const normalizedFormat = trimString(format).toLowerCase();
    if (normalizedFormat === "rfc3339")
        return iso.replace(/\.\d{3}Z$/, "Z");
    return iso.replace(/\.(\d{3})Z$/, (_match, millis) => {
        const trimmed = millis.replace(/0+$/, "");
        return trimmed ? `.${trimmed}Z` : "Z";
    });
}
function normalizeDate(value) {
    if (value instanceof Date && Number.isFinite(value.getTime()))
        return value;
    if (typeof value === "string" && trimString(value)) {
        const parsed = new Date(value);
        if (Number.isFinite(parsed.getTime()))
            return parsed;
    }
    return new Date(0);
}
function applyStaticEnrichment(out, config, environment, sanitizer) {
    for (const field of sortedKeys(config.enrichment?.static)) {
        const value = resolveStaticEnrichmentValue(config.enrichment?.static?.[field], environment);
        putProfileField(out, field, value, sanitizer);
    }
}
function resolveStaticEnrichmentValue(value, environment) {
    const trimmed = trimString(value);
    if (trimmed.startsWith("${") && trimmed.endsWith("}") && trimmed.length > 3) {
        const name = trimmed.slice(2, -1).trim();
        return environment?.[name] ?? process.env[name] ?? "";
    }
    return String(value ?? "");
}
function applyContextEnrichment(out, config, event, sanitizer) {
    for (const field of sortedKeys(config.enrichment?.context)) {
        const value = contextSourceValue(config.enrichment?.context?.[field], event);
        putProfileField(out, field, value, sanitizer);
    }
}
function contextSourceValue(source, event) {
    switch (trimString(source)) {
        case "request.request_id":
            return event.request?.request_id;
        case "request.tenant_id":
            return event.request?.tenant_id;
        case "request.user_id":
            return event.request?.user_id;
        case "request.trace_id":
            return event.request?.trace_id;
        case "request.span_id":
            return event.request?.span_id;
        case "request.correlation_id":
            return event.request?.correlation_id;
        case "request.route":
            return event.request?.route;
        case "request.method":
            return event.request?.method;
        case "request.path":
            return event.request?.path;
        case "request.status":
            return event.request?.status;
        case "job.name":
            return event.job?.name;
        default:
            return undefined;
    }
}
function applyErrorCapture(out, config, event, sanitizer) {
    if (config.error_capture?.include_error_type) {
        putCanonicalMappedField(out, config, "error_type", event.error?.type, sanitizer);
    }
    if (config.error_capture?.include_error_code) {
        putCanonicalMappedField(out, config, "error_code", event.error?.code, sanitizer);
    }
    if (config.error_capture?.include_stack_trace) {
        const field = trimString(config.error_capture.stack_trace_field) ||
            mappedFieldOrDefault(config, "stack_trace", "stack_trace");
        putProfileRawString(out, field, event.error?.stack_trace);
    }
    const stackHashField = trimString(config.error_capture?.stack_hash_field);
    if (stackHashField && trimString(event.error?.stack_trace)) {
        putProfileField(out, stackHashField, profileStackHash(event.error?.stack_trace ?? ""), sanitizer);
    }
}
function profileStackHash(stackTrace) {
    return `sha256:${createHash("sha256").update(stackTrace).digest("hex")}`;
}
function applySafeEventFields(out, fields, sanitizer) {
    for (const key of sortedKeys(fields)) {
        const trimmed = trimString(key);
        if (!isAllowedProfileEventField(trimmed))
            continue;
        if (Object.prototype.hasOwnProperty.call(out, trimmed))
            continue;
        putProfileField(out, trimmed, fields?.[key], sanitizer);
    }
}
function isAllowedProfileEventField(field) {
    return field.startsWith("safe_") || isSupportedProfileOutputField(field);
}
function missingRequiredProfileFields(out, required) {
    const missing = [];
    for (const field of required ?? []) {
        const key = trimString(field);
        if (!key)
            continue;
        if (!Object.prototype.hasOwnProperty.call(out, key) ||
            isZeroProfileValue(out[key])) {
            missing.push(key);
        }
    }
    return missing;
}
function isZeroProfileValue(value) {
    if (value === null || value === undefined)
        return true;
    if (typeof value === "string")
        return value.trim() === "";
    if (typeof value === "number")
        return value === 0;
    return false;
}
function applyKnownProfileFieldsToEvent(event, fields) {
    event.normalized_message =
        event.normalized_message || stringField(fields, "normalized_message");
    event.event = event.event || stringField(fields, "event");
    event.request = event.request ?? {};
    event.job = event.job ?? {};
    event.error = event.error ?? {};
    event.request.correlation_id =
        event.request.correlation_id || stringField(fields, "correlation_id");
    event.request.route = event.request.route || stringField(fields, "route");
    event.request.method = event.request.method || stringField(fields, "method");
    event.request.path = event.request.path || stringField(fields, "path");
    event.request.status = event.request.status || numberField(fields, "status");
    event.job.name = event.job.name || stringField(fields, "job_name");
    event.error.type =
        event.error.type || firstStringField(fields, "error_type", "error.type");
    event.error.code =
        event.error.code || firstStringField(fields, "error_code", "error.code");
    event.error.stack_trace =
        event.error.stack_trace || stringField(fields, "stack_trace");
}
function firstStringField(fields, ...names) {
    for (const name of names) {
        const value = stringField(fields, name);
        if (value)
            return value;
    }
    return "";
}
function stringField(fields, name) {
    const value = fields[name];
    if (value === null || value === undefined)
        return "";
    return typeof value === "string" ? value : String(value);
}
function numberField(fields, name) {
    const value = fields[name];
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string") {
        const n = Number(value);
        if (Number.isFinite(n))
            return n;
    }
    return 0;
}
const loggingProfileJSONOptions = {
    allowed: optionNameSet("schema_version", "profile", "encoding", "levels", "required_fields", "recommended_fields", "field_map", "enrichment", "error_capture", "sanitization", "alerting_hints"),
    nested: {
        encoding: {
            allowed: optionNameSet("format", "timestamp_field", "timestamp_format", "level_field", "message_field"),
        },
        enrichment: { allowed: optionNameSet("static", "context") },
        error_capture: {
            allowed: optionNameSet("include_error_type", "include_error_code", "include_stack_trace", "stack_trace_field", "stack_hash_field", "stack_hash_algorithm"),
        },
        sanitization: {
            allowed: optionNameSet("existing_sanitized_logging", "notes"),
        },
        alerting_hints: {
            allowed: optionNameSet("fingerprint_fields", "keeper_lookup_fields"),
        },
    },
};
function validateLoggingProfileJSONOptions(path, object, schema) {
    const errors = [];
    for (const key of sortedKeys(object)) {
        const childPath = profileJSONOptionPath(path, key);
        if (!schema.allowed.has(key)) {
            errors.push(`${childPath}: unsupported option`);
            continue;
        }
        const childSchema = schema.nested?.[key];
        const child = object[key];
        if (!childSchema || !isRecord(child))
            continue;
        errors.push(...validateLoggingProfileJSONOptions(childPath, child, childSchema));
    }
    return errors;
}
function profileJSONOptionPath(parent, key) {
    return parent ? `${parent}.${key}` : key;
}
function baseJSONProfile(profile) {
    return {
        schema_version: LOGGING_PROFILE_SCHEMA_VERSION,
        profile,
        encoding: {
            format: "json",
            timestamp_field: "timestamp",
            timestamp_format: "rfc3339nano",
            level_field: "level",
            message_field: "message",
        },
        levels: { debug: "DEBUG", info: "INFO", warn: "WARN", error: "ERROR" },
        field_map: {
            timestamp: "timestamp",
            severity: "level",
            message: "message",
        },
    };
}
function payTheoryAlertProfile() {
    const cfg = baseJSONProfile(LOGGING_PROFILE_PAYTHEORY_ALERT_V1);
    cfg.encoding = {
        format: "json",
        timestamp_field: "ts",
        timestamp_format: "rfc3339nano",
        level_field: "level",
        message_field: "message",
    };
    cfg.required_fields = [
        "ts",
        "level",
        "message",
        "service",
        "stage",
        "partner",
        "function",
        "aws_region",
    ];
    cfg.recommended_fields = [
        "source_account_id",
        "account_family",
        "request_id",
        "trace_id",
        "correlation_id",
        "error_type",
        "error_code",
        "normalized_message",
        "stack_hash",
        "route",
        "job_name",
    ];
    cfg.field_map = {
        timestamp: "ts",
        severity: "level",
        message: "message",
        normalized_message: "normalized_message",
        error_type: "error_type",
        error_code: "error_code",
        request_id: "request_id",
        trace_id: "trace_id",
        correlation_id: "correlation_id",
        stack_trace: "stack_trace",
        stack_hash: "stack_hash",
        service: "service",
        stage: "stage",
        partner: "partner",
        function: "function",
        account_family: "account_family",
        source_account_id: "source_account_id",
        aws_region: "aws_region",
        route: "route",
        job_name: "job_name",
    };
    cfg.enrichment = {
        static: {
            service: "${SERVICE_NAME}",
            stage: "${STAGE}",
            partner: "${PARTNER}",
            function: "${AWS_LAMBDA_FUNCTION_NAME}",
            aws_region: "${AWS_REGION}",
            source_account_id: "${SOURCE_ACCOUNT_ID}",
            account_family: "${ACCOUNT_FAMILY}",
        },
        context: {
            request_id: "request.request_id",
            trace_id: "request.trace_id",
            correlation_id: "request.correlation_id",
            route: "request.route",
            job_name: "job.name",
        },
    };
    cfg.error_capture = {
        include_error_type: true,
        include_error_code: true,
        include_stack_trace: true,
        stack_trace_field: "stack_trace",
        stack_hash_field: "stack_hash",
        stack_hash_algorithm: "sha256",
    };
    cfg.sanitization = { existing_sanitized_logging: true };
    cfg.alerting_hints = {
        fingerprint_fields: [
            "service",
            "normalized_message",
            "error_type",
            "stack_hash",
        ],
        keeper_lookup_fields: [
            "partner",
            "stage",
            "account_family",
            "aws_region",
            "service",
            "function",
            "request_id",
            "trace_id",
        ],
    };
    return cfg;
}
function validateLevelMap(levels) {
    const errors = [];
    for (const key of sortedKeys(levels)) {
        if (!optionNameSet("debug", "info", "warn", "error").has(key)) {
            errors.push(`levels.${key}: unsupported level ${key}`);
            continue;
        }
        if (!trimString(levels?.[key]))
            errors.push(`levels.${key}: required`);
    }
    return errors;
}
function validateProfileFieldList(path, fields) {
    const errors = [];
    for (const [index, field] of (fields ?? []).entries()) {
        const trimmed = trimString(field);
        if (!trimmed) {
            errors.push(`${path}[${index}]: required`);
            continue;
        }
        if (!isSupportedProfileOutputField(trimmed)) {
            errors.push(`${path}[${index}]: unsupported field ${trimmed}`);
        }
    }
    return errors;
}
function validateEncodingOutputField(path, field) {
    const trimmed = trimString(field);
    if (!trimmed)
        return [];
    if (!isSupportedProfileOutputField(trimmed))
        return [`${path}: unsupported field ${trimmed}`];
    return [];
}
function validateFieldMap(fieldMap) {
    const errors = [];
    for (const key of sortedKeys(fieldMap)) {
        const canonical = trimString(key);
        if (!isSupportedCanonicalField(canonical)) {
            errors.push(`field_map.${key}: unsupported source ${canonical}`);
        }
        const out = trimString(fieldMap?.[key]);
        if (!out) {
            errors.push(`field_map.${key}: required`);
        }
        else if (!isSupportedProfileOutputField(out)) {
            errors.push(`field_map.${key}: unsupported field ${out}`);
        }
    }
    return errors;
}
function validateStaticEnrichment(staticFields) {
    const errors = [];
    for (const key of sortedKeys(staticFields)) {
        const trimmed = trimString(key);
        if (!isSupportedProfileOutputField(trimmed)) {
            errors.push(`enrichment.static.${key}: unsupported field ${trimmed}`);
        }
    }
    return errors;
}
function validateContextEnrichment(contextFields) {
    const errors = [];
    for (const key of sortedKeys(contextFields)) {
        const trimmed = trimString(key);
        if (!isSupportedProfileOutputField(trimmed)) {
            errors.push(`enrichment.context.${key}: unsupported field ${trimmed}`);
        }
        const source = trimString(contextFields?.[key]);
        if (!source) {
            errors.push(`enrichment.context.${key}: required`);
        }
        else if (!isSupportedContextSource(source)) {
            errors.push(`enrichment.context.${key}: unsupported source ${source}`);
        }
    }
    return errors;
}
function validateErrorCapture(capture) {
    const errors = [];
    const stackTraceField = trimString(capture?.stack_trace_field);
    if (stackTraceField && !isSupportedProfileOutputField(stackTraceField)) {
        errors.push(`error_capture.stack_trace_field: unsupported field ${stackTraceField}`);
    }
    const stackHashField = trimString(capture?.stack_hash_field);
    if (stackHashField && !isSupportedProfileOutputField(stackHashField)) {
        errors.push(`error_capture.stack_hash_field: unsupported field ${stackHashField}`);
    }
    const algorithm = trimString(capture?.stack_hash_algorithm).toLowerCase();
    if (algorithm && algorithm !== "sha256") {
        errors.push(`error_capture.stack_hash_algorithm: unsupported value ${trimString(capture?.stack_hash_algorithm)}`);
    }
    return errors;
}
function validateAlertingHints(hints) {
    return [
        ...validateProfileFieldList("alerting_hints.fingerprint_fields", hints?.fingerprint_fields),
        ...validateProfileFieldList("alerting_hints.keeper_lookup_fields", hints?.keeper_lookup_fields),
    ];
}
export function isSupportedProfileOutputField(field) {
    return optionNameSet("ts", "timestamp", "level", "severity", "message", "event", "service", "stage", "partner", "function", "aws_region", "source_account_id", "account_family", "request_id", "tenant_id", "user_id", "trace_id", "span_id", "correlation_id", "error_type", "error_code", "normalized_message", "stack_trace", "stack_hash", "route", "job_name", "method", "path", "status").has(field);
}
function isSupportedProfile(profile) {
    return optionNameSet(LOGGING_PROFILE_PAYTHEORY_ALERT_V1, LOGGING_PROFILE_CLOUDWATCH_JSON, LOGGING_PROFILE_LEGACY, LOGGING_PROFILE_LOCAL_DEV).has(normalizeProfileToken(profile));
}
function isSupportedCanonicalField(field) {
    return optionNameSet("timestamp", "severity", "message", "event", "normalized_message", "error_type", "error_code", "request_id", "tenant_id", "user_id", "trace_id", "span_id", "correlation_id", "stack_trace", "stack_hash", "service", "stage", "partner", "function", "account_family", "source_account_id", "aws_region", "route", "job_name", "method", "path", "status").has(field);
}
function isSupportedContextSource(source) {
    return optionNameSet("request.request_id", "request.tenant_id", "request.user_id", "request.trace_id", "request.span_id", "request.correlation_id", "request.route", "request.method", "request.path", "request.status", "job.name").has(source);
}
function normalizeProfileToken(value) {
    return trimString(value).toLowerCase();
}
function optionNameSet(...names) {
    return new Set(names);
}
function sortedKeys(object) {
    return Object.keys(object ?? {}).sort();
}
function trimString(value) {
    return String(value ?? "").trim();
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
