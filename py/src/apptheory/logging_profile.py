from __future__ import annotations

import json
from typing import Any, NotRequired, TypedDict

LOGGING_PROFILE_SCHEMA_VERSION = "apptheory.logging/v1"

LOGGING_PROFILE_PAYTHEORY_ALERT_V1 = "paytheory-alert-v1"
LOGGING_PROFILE_CLOUDWATCH_JSON = "cloudwatch-json"
LOGGING_PROFILE_LEGACY = "legacy"
LOGGING_PROFILE_LOCAL_DEV = "local-dev"


class LoggingProfileEncoding(TypedDict, total=False):
    format: str
    timestamp_field: str
    timestamp_format: str
    level_field: str
    message_field: str


class LoggingProfileEnrichment(TypedDict, total=False):
    static: dict[str, str]
    context: dict[str, str]


class LoggingProfileErrorCapture(TypedDict, total=False):
    include_error_type: bool
    include_error_code: bool
    include_stack_trace: bool
    stack_trace_field: str
    stack_hash_field: str
    stack_hash_algorithm: str


class LoggingProfileSanitization(TypedDict, total=False):
    existing_sanitized_logging: bool
    notes: str


class LoggingProfileAlertingHints(TypedDict, total=False):
    fingerprint_fields: list[str]
    keeper_lookup_fields: list[str]


class LoggingProfileConfig(TypedDict, total=False):
    schema_version: str
    profile: str
    encoding: LoggingProfileEncoding
    levels: dict[str, str]
    required_fields: list[str]
    recommended_fields: list[str]
    field_map: dict[str, str]
    enrichment: LoggingProfileEnrichment
    error_capture: LoggingProfileErrorCapture
    sanitization: LoggingProfileSanitization
    alerting_hints: LoggingProfileAlertingHints


class LoggingProfileValidationError(Exception):
    def __init__(self, errors: list[str]) -> None:
        self.errors = list(errors)
        message = "logging profile validation failed"
        if self.errors:
            message += ": " + "; ".join(self.errors)
        super().__init__(message)


def built_in_logging_profile_names() -> list[str]:
    return sorted(
        [
            LOGGING_PROFILE_CLOUDWATCH_JSON,
            LOGGING_PROFILE_LEGACY,
            LOGGING_PROFILE_LOCAL_DEV,
            LOGGING_PROFILE_PAYTHEORY_ALERT_V1,
        ]
    )


def logging_profile_catalog() -> dict[str, Any]:
    return {
        "schema_version": LOGGING_PROFILE_SCHEMA_VERSION,
        "profiles": built_in_logging_profile_names(),
    }


def default_logging_profile(profile: str) -> LoggingProfileConfig:
    key = _normalize_profile_token(profile)
    if key == LOGGING_PROFILE_PAYTHEORY_ALERT_V1:
        return _paytheory_alert_profile()
    if key == LOGGING_PROFILE_CLOUDWATCH_JSON:
        cfg = _base_json_profile(LOGGING_PROFILE_CLOUDWATCH_JSON)
        cfg["required_fields"] = ["timestamp", "level", "message"]
        return cfg
    if key == LOGGING_PROFILE_LEGACY:
        cfg = _base_json_profile(LOGGING_PROFILE_LEGACY)
        cfg["encoding"]["timestamp_field"] = "timestamp"
        cfg["encoding"]["level_field"] = "level"
        cfg["encoding"]["message_field"] = "message"
        return cfg
    if key == LOGGING_PROFILE_LOCAL_DEV:
        cfg = _base_json_profile(LOGGING_PROFILE_LOCAL_DEV)
        cfg["levels"] = {"debug": "DEBUG", "info": "INFO", "warn": "WARN", "error": "ERROR"}
        return cfg
    raise ValueError(f"profile: unsupported value {str(profile or '').strip()}")


def decode_logging_profile_json(raw: str | bytes | bytearray) -> LoggingProfileConfig:
    try:
        text = raw.decode("utf-8") if isinstance(raw, bytes | bytearray) else str(raw)
        parsed = json.loads(text)
    except Exception as exc:
        raise ValueError(f"logging profile json: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("logging profile json: root must be an object")

    strict_errors = _validate_logging_profile_json_options("", parsed, _LOGGING_PROFILE_JSON_OPTIONS)
    config = parsed
    errors = [*strict_errors, *logging_profile_validation_errors(config)]
    if errors:
        raise LoggingProfileValidationError(errors)
    return config


def validate_logging_profile(config: LoggingProfileConfig) -> None:
    errors = logging_profile_validation_errors(config)
    if errors:
        raise LoggingProfileValidationError(errors)


def logging_profile_validation_errors(config: LoggingProfileConfig) -> list[str]:
    errors: list[str] = []

    schema = _trim(config.get("schema_version"))
    if not schema:
        errors.append("schema_version: required")
    elif schema != LOGGING_PROFILE_SCHEMA_VERSION:
        errors.append("schema_version: unsupported value " + schema)

    profile = _normalize_profile_token(config.get("profile", ""))
    if not profile:
        errors.append("profile: required")
    elif not _is_supported_profile(profile):
        errors.append("profile: unsupported value " + _trim(config.get("profile")))

    encoding = config.get("encoding") or {}
    format_value = _trim(encoding.get("format")).lower()
    if not format_value:
        errors.append("encoding.format: required")
    elif format_value != "json":
        errors.append("encoding.format: unsupported value " + _trim(encoding.get("format")))

    timestamp_format = _trim(encoding.get("timestamp_format")).lower()
    if timestamp_format and timestamp_format not in {"rfc3339nano", "rfc3339"}:
        errors.append("encoding.timestamp_format: unsupported value " + _trim(encoding.get("timestamp_format")))
    errors.extend(_validate_encoding_output_field("encoding.timestamp_field", encoding.get("timestamp_field")))
    errors.extend(_validate_encoding_output_field("encoding.level_field", encoding.get("level_field")))
    errors.extend(_validate_encoding_output_field("encoding.message_field", encoding.get("message_field")))

    errors.extend(_validate_level_map(config.get("levels")))
    errors.extend(_validate_profile_field_list("required_fields", config.get("required_fields")))
    errors.extend(_validate_profile_field_list("recommended_fields", config.get("recommended_fields")))
    errors.extend(_validate_field_map(config.get("field_map")))
    enrichment = config.get("enrichment") or {}
    errors.extend(_validate_static_enrichment(enrichment.get("static")))
    errors.extend(_validate_context_enrichment(enrichment.get("context")))
    errors.extend(_validate_error_capture(config.get("error_capture") or {}))
    errors.extend(_validate_alerting_hints(config.get("alerting_hints") or {}))
    return errors


class _JSONOptionSchema(TypedDict):
    allowed: set[str]
    nested: NotRequired[dict[str, _JSONOptionSchema]]


def _option_name_set(*names: str) -> set[str]:
    return set(names)


_LOGGING_PROFILE_JSON_OPTIONS: _JSONOptionSchema = {
    "allowed": _option_name_set(
        "schema_version",
        "profile",
        "encoding",
        "levels",
        "required_fields",
        "recommended_fields",
        "field_map",
        "enrichment",
        "error_capture",
        "sanitization",
        "alerting_hints",
    ),
    "nested": {
        "encoding": {
            "allowed": _option_name_set(
                "format",
                "timestamp_field",
                "timestamp_format",
                "level_field",
                "message_field",
            )
        },
        "enrichment": {"allowed": _option_name_set("static", "context")},
        "error_capture": {
            "allowed": _option_name_set(
                "include_error_type",
                "include_error_code",
                "include_stack_trace",
                "stack_trace_field",
                "stack_hash_field",
                "stack_hash_algorithm",
            )
        },
        "sanitization": {"allowed": _option_name_set("existing_sanitized_logging", "notes")},
        "alerting_hints": {"allowed": _option_name_set("fingerprint_fields", "keeper_lookup_fields")},
    },
}


def _validate_logging_profile_json_options(path: str, obj: dict[str, Any], schema: _JSONOptionSchema) -> list[str]:
    errors: list[str] = []
    nested = schema.get("nested", {})
    for key in sorted(obj):
        child_path = f"{path}.{key}" if path else key
        if key not in schema["allowed"]:
            errors.append(child_path + ": unsupported option")
            continue
        child_schema = nested.get(key)
        child = obj.get(key)
        if child_schema is not None and isinstance(child, dict):
            errors.extend(_validate_logging_profile_json_options(child_path, child, child_schema))
    return errors


def _base_json_profile(profile: str) -> LoggingProfileConfig:
    return {
        "schema_version": LOGGING_PROFILE_SCHEMA_VERSION,
        "profile": profile,
        "encoding": {
            "format": "json",
            "timestamp_field": "timestamp",
            "timestamp_format": "rfc3339nano",
            "level_field": "level",
            "message_field": "message",
        },
        "levels": {"debug": "DEBUG", "info": "INFO", "warn": "WARN", "error": "ERROR"},
        "field_map": {
            "timestamp": "timestamp",
            "severity": "level",
            "message": "message",
        },
    }


def _paytheory_alert_profile() -> LoggingProfileConfig:
    cfg = _base_json_profile(LOGGING_PROFILE_PAYTHEORY_ALERT_V1)
    cfg["encoding"] = {
        "format": "json",
        "timestamp_field": "ts",
        "timestamp_format": "rfc3339nano",
        "level_field": "level",
        "message_field": "message",
    }
    cfg["required_fields"] = ["ts", "level", "message", "service", "stage", "partner", "function", "aws_region"]
    cfg["recommended_fields"] = [
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
    ]
    cfg["field_map"] = {
        "timestamp": "ts",
        "severity": "level",
        "message": "message",
        "normalized_message": "normalized_message",
        "error_type": "error_type",
        "error_code": "error_code",
        "request_id": "request_id",
        "trace_id": "trace_id",
        "correlation_id": "correlation_id",
        "stack_trace": "stack_trace",
        "stack_hash": "stack_hash",
        "service": "service",
        "stage": "stage",
        "partner": "partner",
        "function": "function",
        "account_family": "account_family",
        "source_account_id": "source_account_id",
        "aws_region": "aws_region",
        "route": "route",
        "job_name": "job_name",
    }
    cfg["enrichment"] = {
        "static": {
            "service": "${SERVICE_NAME}",
            "stage": "${STAGE}",
            "partner": "${PARTNER}",
            "function": "${AWS_LAMBDA_FUNCTION_NAME}",
            "aws_region": "${AWS_REGION}",
            "source_account_id": "${SOURCE_ACCOUNT_ID}",
            "account_family": "${ACCOUNT_FAMILY}",
        },
        "context": {
            "request_id": "request.request_id",
            "trace_id": "request.trace_id",
            "correlation_id": "request.correlation_id",
            "route": "request.route",
            "job_name": "job.name",
        },
    }
    cfg["error_capture"] = {
        "include_error_type": True,
        "include_error_code": True,
        "include_stack_trace": True,
        "stack_trace_field": "stack_trace",
        "stack_hash_field": "stack_hash",
        "stack_hash_algorithm": "sha256",
    }
    cfg["sanitization"] = {"existing_sanitized_logging": True}
    cfg["alerting_hints"] = {
        "fingerprint_fields": ["service", "normalized_message", "error_type", "stack_hash"],
        "keeper_lookup_fields": [
            "partner",
            "stage",
            "account_family",
            "aws_region",
            "service",
            "function",
            "request_id",
            "trace_id",
        ],
    }
    return cfg


def _validate_level_map(levels: dict[str, str] | None) -> list[str]:
    errors: list[str] = []
    for key in sorted(levels or {}):
        normalized = _trim(key).lower()
        if normalized not in {"debug", "info", "warn", "error"}:
            errors.append(f"levels.{key}: unsupported level {key}")
            continue
        if not _trim((levels or {}).get(key)):
            errors.append(f"levels.{key}: required")
    return errors


def _validate_profile_field_list(path: str, fields: list[str] | None) -> list[str]:
    errors: list[str] = []
    for idx, field in enumerate(fields or []):
        trimmed = _trim(field)
        if not trimmed:
            errors.append(f"{path}[{idx}]: required")
            continue
        if not is_supported_profile_output_field(trimmed):
            errors.append(f"{path}[{idx}]: unsupported field {trimmed}")
    return errors


def _validate_encoding_output_field(path: str, field: str | None) -> list[str]:
    trimmed = _trim(field)
    if not trimmed:
        return []
    if not is_supported_profile_output_field(trimmed):
        return [f"{path}: unsupported field {trimmed}"]
    return []


def _validate_field_map(field_map: dict[str, str] | None) -> list[str]:
    errors: list[str] = []
    for key in sorted(field_map or {}):
        canonical = _trim(key)
        if not _is_supported_canonical_field(canonical):
            errors.append(f"field_map.{key}: unsupported source {canonical}")
        out = _trim((field_map or {}).get(key))
        if not out:
            errors.append(f"field_map.{key}: required")
        elif not is_supported_profile_output_field(out):
            errors.append(f"field_map.{key}: unsupported field {out}")
    return errors


def _validate_static_enrichment(static: dict[str, str] | None) -> list[str]:
    errors: list[str] = []
    for key in sorted(static or {}):
        trimmed = _trim(key)
        if not is_supported_profile_output_field(trimmed):
            errors.append(f"enrichment.static.{key}: unsupported field {trimmed}")
    return errors


def _validate_context_enrichment(context: dict[str, str] | None) -> list[str]:
    errors: list[str] = []
    for key in sorted(context or {}):
        trimmed = _trim(key)
        if not is_supported_profile_output_field(trimmed):
            errors.append(f"enrichment.context.{key}: unsupported field {trimmed}")
        source = _trim((context or {}).get(key))
        if not source:
            errors.append(f"enrichment.context.{key}: required")
        elif not _is_supported_context_source(source):
            errors.append(f"enrichment.context.{key}: unsupported source {source}")
    return errors


def _validate_error_capture(capture: LoggingProfileErrorCapture) -> list[str]:
    errors: list[str] = []
    stack_trace_field = _trim(capture.get("stack_trace_field"))
    if stack_trace_field and not is_supported_profile_output_field(stack_trace_field):
        errors.append("error_capture.stack_trace_field: unsupported field " + stack_trace_field)
    stack_hash_field = _trim(capture.get("stack_hash_field"))
    if stack_hash_field and not is_supported_profile_output_field(stack_hash_field):
        errors.append("error_capture.stack_hash_field: unsupported field " + stack_hash_field)
    algorithm = _trim(capture.get("stack_hash_algorithm")).lower()
    if algorithm and algorithm != "sha256":
        errors.append(
            "error_capture.stack_hash_algorithm: unsupported value " + _trim(capture.get("stack_hash_algorithm"))
        )
    return errors


def _validate_alerting_hints(hints: LoggingProfileAlertingHints) -> list[str]:
    return [
        *_validate_profile_field_list("alerting_hints.fingerprint_fields", hints.get("fingerprint_fields")),
        *_validate_profile_field_list("alerting_hints.keeper_lookup_fields", hints.get("keeper_lookup_fields")),
    ]


def is_supported_profile_output_field(field: str) -> bool:
    return field in {
        "ts",
        "timestamp",
        "level",
        "severity",
        "message",
        "event",
        "service",
        "stage",
        "partner",
        "function",
        "aws_region",
        "source_account_id",
        "account_family",
        "request_id",
        "tenant_id",
        "user_id",
        "trace_id",
        "span_id",
        "correlation_id",
        "error_type",
        "error_code",
        "normalized_message",
        "stack_trace",
        "stack_hash",
        "route",
        "job_name",
        "method",
        "path",
        "status",
    }


def _is_supported_profile(profile: str) -> bool:
    return _normalize_profile_token(profile) in {
        LOGGING_PROFILE_PAYTHEORY_ALERT_V1,
        LOGGING_PROFILE_CLOUDWATCH_JSON,
        LOGGING_PROFILE_LEGACY,
        LOGGING_PROFILE_LOCAL_DEV,
    }


def _is_supported_canonical_field(field: str) -> bool:
    return field in {
        "timestamp",
        "severity",
        "message",
        "event",
        "normalized_message",
        "error_type",
        "error_code",
        "request_id",
        "tenant_id",
        "user_id",
        "trace_id",
        "span_id",
        "correlation_id",
        "stack_trace",
        "stack_hash",
        "service",
        "stage",
        "partner",
        "function",
        "account_family",
        "source_account_id",
        "aws_region",
        "route",
        "job_name",
        "method",
        "path",
        "status",
    }


def _is_supported_context_source(source: str) -> bool:
    return source in {
        "request.request_id",
        "request.tenant_id",
        "request.user_id",
        "request.trace_id",
        "request.span_id",
        "request.correlation_id",
        "request.route",
        "request.method",
        "request.path",
        "request.status",
        "job.name",
    }


def _normalize_profile_token(value: object) -> str:
    return _trim(value).lower()


def _trim(value: object) -> str:
    return str(value or "").strip()


__all__ = [
    "LOGGING_PROFILE_CLOUDWATCH_JSON",
    "LOGGING_PROFILE_LEGACY",
    "LOGGING_PROFILE_LOCAL_DEV",
    "LOGGING_PROFILE_PAYTHEORY_ALERT_V1",
    "LOGGING_PROFILE_SCHEMA_VERSION",
    "LoggingProfileAlertingHints",
    "LoggingProfileConfig",
    "LoggingProfileEncoding",
    "LoggingProfileEnrichment",
    "LoggingProfileErrorCapture",
    "LoggingProfileSanitization",
    "LoggingProfileValidationError",
    "built_in_logging_profile_names",
    "decode_logging_profile_json",
    "default_logging_profile",
    "is_supported_profile_output_field",
    "logging_profile_catalog",
    "logging_profile_validation_errors",
    "validate_logging_profile",
]
