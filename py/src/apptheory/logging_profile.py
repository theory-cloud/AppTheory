from __future__ import annotations

import hashlib
import json
import os
import sys
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, NotRequired, TypedDict

from apptheory.app import LogRecord, ObservabilityHooks
from apptheory.logger import StructuredLogger
from apptheory.sanitization import sanitize_field_value, sanitize_log_string

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


class LoggingProfileRequestContext(TypedDict, total=False):
    request_id: str
    tenant_id: str
    user_id: str
    trace_id: str
    span_id: str
    correlation_id: str
    route: str
    method: str
    path: str
    status: int


class LoggingProfileJobContext(TypedDict, total=False):
    name: str


class LoggingProfileError(TypedDict, total=False):
    type: str
    code: str
    message: str
    stack_trace: str


class LoggingProfileEvent(TypedDict, total=False):
    timestamp: datetime | str
    level: str
    event: str
    message: str
    normalized_message: str
    request: LoggingProfileRequestContext
    job: LoggingProfileJobContext
    error: LoggingProfileError
    fields: dict[str, Any]


LoggingProfileSanitizer = Callable[[str, Any], Any]


class ProfileLoggerOptions(TypedDict, total=False):
    environment: dict[str, str]
    writer: Callable[[str], None] | None
    sanitizer: LoggingProfileSanitizer
    clock: Callable[[], datetime]


_DEFAULT_PROFILE_WRITER = object()


class ProfileLogger:
    def __init__(
        self,
        config: LoggingProfileConfig,
        *,
        environment: dict[str, str] | None = None,
        writer: Callable[[str], None] | None | object = _DEFAULT_PROFILE_WRITER,
        sanitizer: LoggingProfileSanitizer | None = None,
        clock: Callable[[], datetime] | None = None,
        _root: ProfileLogger | None = None,
        _fields: dict[str, Any] | None = None,
        _request_id: str = "",
        _tenant_id: str = "",
        _user_id: str = "",
        _trace_id: str = "",
        _span_id: str = "",
    ) -> None:
        if _root is None:
            validate_logging_profile(config)
        self._root = _root or self
        self._config = config
        self._environment = dict(environment or {})
        self._writer = _default_profile_writer if writer is _DEFAULT_PROFILE_WRITER else writer
        self._sanitizer = sanitizer or sanitize_field_value
        self._clock = clock or (lambda: datetime.now(UTC))
        self._fields = dict(_fields or {})
        self._request_id = _request_id
        self._tenant_id = _tenant_id
        self._user_id = _user_id
        self._trace_id = _trace_id
        self._span_id = _span_id
        if _root is None:
            self._closed = False
            self._entries: list[dict[str, Any]] = []
            self._entries_logged = 0
            self._last_error = ""

    def debug(self, message: str, *fields: dict[str, Any]) -> None:
        self._log("debug", message, fields)

    def info(self, message: str, *fields: dict[str, Any]) -> None:
        self._log("info", message, fields)

    def warn(self, message: str, *fields: dict[str, Any]) -> None:
        self._log("warn", message, fields)

    def error(self, message: str, *fields: dict[str, Any]) -> None:
        self._log("error", message, fields)

    def with_field(self, key: str, value: Any) -> ProfileLogger:
        return self.with_fields({key: value})

    def with_fields(self, fields: dict[str, Any]) -> ProfileLogger:
        merged = {**self._fields, **fields}
        return self._clone(_fields=merged)

    def with_request_id(self, request_id: str) -> ProfileLogger:
        return self._clone(_request_id=request_id)

    def with_tenant_id(self, tenant_id: str) -> ProfileLogger:
        return self._clone(_tenant_id=tenant_id)

    def with_user_id(self, user_id: str) -> ProfileLogger:
        return self._clone(_user_id=user_id)

    def with_trace_id(self, trace_id: str) -> ProfileLogger:
        return self._clone(_trace_id=trace_id)

    def with_span_id(self, span_id: str) -> ProfileLogger:
        return self._clone(_span_id=span_id)

    def flush(self) -> None:
        return None

    def close(self) -> None:
        self._root._closed = True

    def is_healthy(self) -> bool:
        return not self._root._closed and not self._root._last_error

    def get_stats(self) -> dict[str, Any]:
        return {"entries_logged": self._root._entries_logged, "last_error": self._root._last_error}

    def entries(self) -> list[dict[str, Any]]:
        return [dict(entry) for entry in self._root._entries]

    def _clone(self, **overrides: Any) -> ProfileLogger:
        return ProfileLogger(
            self._config,
            environment=self._environment,
            writer=self._writer,
            sanitizer=self._sanitizer,
            clock=self._clock,
            _root=self._root,
            _fields=overrides.get("_fields", self._fields),
            _request_id=overrides.get("_request_id", self._request_id),
            _tenant_id=overrides.get("_tenant_id", self._tenant_id),
            _user_id=overrides.get("_user_id", self._user_id),
            _trace_id=overrides.get("_trace_id", self._trace_id),
            _span_id=overrides.get("_span_id", self._span_id),
        )

    def _log(self, level: str, message: str, field_sets: tuple[dict[str, Any], ...]) -> None:
        if self._root._closed:
            return
        merged = dict(self._fields)
        for fields in field_sets:
            merged.update(fields)
        event: LoggingProfileEvent = {
            "timestamp": self._clock(),
            "level": level,
            "message": message,
            "request": {
                "request_id": self._request_id,
                "tenant_id": self._tenant_id,
                "user_id": self._user_id,
                "trace_id": self._trace_id,
                "span_id": self._span_id,
            },
            "fields": merged,
        }
        _apply_known_profile_fields_to_event(event, merged)
        try:
            encoded = encode_logging_profile_event_with_sanitizer(
                self._config,
                self._environment,
                event,
                self._sanitizer,
            )
            self._root._entries.append(dict(encoded))
            if self._writer is not None:
                self._writer(json.dumps(encoded, separators=(",", ":")))
            self._root._entries_logged += 1
        except Exception as exc:  # noqa: BLE001 - logger records encoder failures instead of raising from hooks.
            self._root._last_error = str(exc)


def _default_profile_writer(line: str) -> None:
    sys.stdout.write(line + "\n")


def encode_logging_profile_event(
    config: LoggingProfileConfig,
    environment: dict[str, str] | None,
    event: LoggingProfileEvent,
) -> dict[str, Any]:
    return encode_logging_profile_event_with_sanitizer(config, environment, event, sanitize_field_value)


def encode_logging_profile_event_with_sanitizer(
    config: LoggingProfileConfig,
    environment: dict[str, str] | None,
    event: LoggingProfileEvent,
    sanitizer: LoggingProfileSanitizer | None,
) -> dict[str, Any]:
    validate_logging_profile(config)
    sanitizer_fn = sanitizer or sanitize_field_value
    out: dict[str, Any] = {}
    encoding = config.get("encoding") or {}

    _put_profile_field(
        out,
        _timestamp_field(config),
        _format_profile_timestamp(event.get("timestamp"), encoding.get("timestamp_format")),
        sanitizer_fn,
    )
    _put_profile_field(out, _level_field(config), _profile_level(config, event.get("level")), sanitizer_fn)
    _put_profile_field(
        out,
        _message_field(config),
        sanitize_log_string(str(event.get("message") or "")),
        sanitizer_fn,
    )
    if _trim(event.get("event")):
        _put_canonical_mapped_field(out, config, "event", event.get("event"), sanitizer_fn)
    if _trim(event.get("normalized_message")):
        _put_canonical_mapped_field(out, config, "normalized_message", event.get("normalized_message"), sanitizer_fn)

    _apply_static_enrichment(out, config, environment, sanitizer_fn)
    _apply_context_enrichment(out, config, event, sanitizer_fn)
    _apply_error_capture(out, config, event, sanitizer_fn)
    _apply_safe_event_fields(out, event.get("fields"), sanitizer_fn)

    missing = _missing_required_profile_fields(out, config.get("required_fields"))
    if missing:
        raise ValueError("logging profile required fields missing: " + ", ".join(missing))
    return out


def hooks_from_profile_logger(
    config: LoggingProfileConfig,
    *,
    environment: dict[str, str] | None = None,
    writer: Callable[[str], None] | None | object = _DEFAULT_PROFILE_WRITER,
    sanitizer: LoggingProfileSanitizer | None = None,
    clock: Callable[[], datetime] | None = None,
) -> tuple[ObservabilityHooks, ProfileLogger]:
    logger = ProfileLogger(config, environment=environment, writer=writer, sanitizer=sanitizer, clock=clock)
    return hooks_from_logger(logger), logger


def hooks_from_logger(logger: StructuredLogger | None) -> ObservabilityHooks:
    if logger is None:
        return ObservabilityHooks()

    def log(record: LogRecord) -> None:
        fields: dict[str, Any] = {
            "event": record.event,
            "method": record.method,
            "path": record.path,
            "status": record.status,
            "error_code": record.error_code,
        }
        _add_if_present(fields, "trigger", record.trigger)
        _add_if_present(fields, "correlation_id", record.correlation_id)
        _add_if_present(fields, "source", record.source)
        _add_if_present(fields, "detail_type", record.detail_type)
        _add_if_present(fields, "table_name", record.table_name)
        _add_if_present(fields, "event_id", record.event_id)
        _add_if_present(fields, "event_name", record.event_name)

        scoped = logger.with_request_id(record.request_id).with_tenant_id(record.tenant_id)
        if record.level == "error":
            scoped.error(record.event, fields)
        elif record.level == "warn":
            scoped.warn(record.event, fields)
        elif record.level == "debug":
            scoped.debug(record.event, fields)
        else:
            scoped.info(record.event, fields)

    return ObservabilityHooks(log=log)


def _add_if_present(fields: dict[str, Any], key: str, value: Any) -> None:
    if _trim(value):
        fields[key] = value


def _timestamp_field(config: LoggingProfileConfig) -> str:
    field = _trim((config.get("encoding") or {}).get("timestamp_field"))
    return field or _mapped_field_or_default(config, "timestamp", "timestamp")


def _level_field(config: LoggingProfileConfig) -> str:
    field = _trim((config.get("encoding") or {}).get("level_field"))
    return field or _mapped_field_or_default(config, "severity", "level")


def _message_field(config: LoggingProfileConfig) -> str:
    field = _trim((config.get("encoding") or {}).get("message_field"))
    return field or _mapped_field_or_default(config, "message", "message")


def _mapped_field_or_default(config: LoggingProfileConfig, canonical: str, fallback: str) -> str:
    return _trim((config.get("field_map") or {}).get(canonical)) or fallback


def _put_canonical_mapped_field(
    out: dict[str, Any],
    config: LoggingProfileConfig,
    canonical: str,
    value: Any,
    sanitizer: LoggingProfileSanitizer,
) -> None:
    _put_profile_field(out, _mapped_field_or_default(config, canonical, canonical), value, sanitizer)


def _put_profile_field(out: dict[str, Any], field: str, value: Any, sanitizer: LoggingProfileSanitizer) -> None:
    key = _trim(field)
    if not key or _is_zero_profile_value(value):
        return
    out[key] = sanitizer(key, value)


def _put_profile_raw_string(out: dict[str, Any], field: str, value: str | None) -> None:
    key = _trim(field)
    if not key or not _trim(value):
        return
    out[key] = value


def _profile_level(config: LoggingProfileConfig, level: str | None) -> str:
    key = _trim(level).lower() or "info"
    return _trim((config.get("levels") or {}).get(key)) or key.upper()


def _format_profile_timestamp(value: datetime | str | None, timestamp_format: str | None) -> str:
    dt = _normalize_datetime(value).astimezone(UTC)
    base = dt.strftime("%Y-%m-%dT%H:%M:%S")
    if _trim(timestamp_format).lower() == "rfc3339" or dt.microsecond == 0:
        return base + "Z"
    fraction = f"{dt.microsecond:06d}".rstrip("0")
    return f"{base}.{fraction}Z"


def _normalize_datetime(value: datetime | str | None) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return datetime.fromtimestamp(0, UTC)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=UTC)
        return parsed
    return datetime.fromtimestamp(0, UTC)


def _apply_static_enrichment(
    out: dict[str, Any],
    config: LoggingProfileConfig,
    environment: dict[str, str] | None,
    sanitizer: LoggingProfileSanitizer,
) -> None:
    static = (config.get("enrichment") or {}).get("static") or {}
    for field in sorted(static):
        _put_profile_field(out, field, _resolve_static_enrichment_value(static.get(field), environment), sanitizer)


def _resolve_static_enrichment_value(value: str | None, environment: dict[str, str] | None) -> str:
    trimmed = _trim(value)
    if trimmed.startswith("${") and trimmed.endswith("}") and len(trimmed) > 3:
        name = trimmed[2:-1].strip()
        return (environment or {}).get(name) or os.environ.get(name, "")
    return str(value or "")


def _apply_context_enrichment(
    out: dict[str, Any],
    config: LoggingProfileConfig,
    event: LoggingProfileEvent,
    sanitizer: LoggingProfileSanitizer,
) -> None:
    context = (config.get("enrichment") or {}).get("context") or {}
    for field in sorted(context):
        _put_profile_field(out, field, _context_source_value(context.get(field), event), sanitizer)


def _context_source_value(source: str | None, event: LoggingProfileEvent) -> Any:
    request = event.get("request") or {}
    job = event.get("job") or {}
    match _trim(source):
        case "request.request_id":
            return request.get("request_id")
        case "request.tenant_id":
            return request.get("tenant_id")
        case "request.user_id":
            return request.get("user_id")
        case "request.trace_id":
            return request.get("trace_id")
        case "request.span_id":
            return request.get("span_id")
        case "request.correlation_id":
            return request.get("correlation_id")
        case "request.route":
            return request.get("route")
        case "request.method":
            return request.get("method")
        case "request.path":
            return request.get("path")
        case "request.status":
            return request.get("status")
        case "job.name":
            return job.get("name")
    return None


def _apply_error_capture(
    out: dict[str, Any],
    config: LoggingProfileConfig,
    event: LoggingProfileEvent,
    sanitizer: LoggingProfileSanitizer,
) -> None:
    capture = config.get("error_capture") or {}
    error = event.get("error") or {}
    if capture.get("include_error_type"):
        _put_canonical_mapped_field(out, config, "error_type", error.get("type"), sanitizer)
    if capture.get("include_error_code"):
        _put_canonical_mapped_field(out, config, "error_code", error.get("code"), sanitizer)
    if capture.get("include_stack_trace"):
        field = _trim(capture.get("stack_trace_field")) or _mapped_field_or_default(
            config,
            "stack_trace",
            "stack_trace",
        )
        _put_profile_raw_string(out, field, error.get("stack_trace"))
    stack_hash_field = _trim(capture.get("stack_hash_field"))
    if stack_hash_field and _trim(error.get("stack_trace")):
        _put_profile_field(out, stack_hash_field, _profile_stack_hash(error.get("stack_trace") or ""), sanitizer)


def _profile_stack_hash(stack_trace: str) -> str:
    return "sha256:" + hashlib.sha256(stack_trace.encode()).hexdigest()


def _apply_safe_event_fields(
    out: dict[str, Any],
    fields: dict[str, Any] | None,
    sanitizer: LoggingProfileSanitizer,
) -> None:
    for key in sorted(fields or {}):
        trimmed = _trim(key)
        if not _is_allowed_profile_event_field(trimmed) or trimmed in out:
            continue
        _put_profile_field(out, trimmed, (fields or {}).get(key), sanitizer)


def _is_allowed_profile_event_field(field: str) -> bool:
    return field.startswith("safe_") or is_supported_profile_output_field(field)


def _missing_required_profile_fields(out: dict[str, Any], required: list[str] | None) -> list[str]:
    missing: list[str] = []
    for field in required or []:
        key = _trim(field)
        if key and (key not in out or _is_zero_profile_value(out.get(key))):
            missing.append(key)
    return missing


def _is_zero_profile_value(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, int | float):
        return value == 0
    return False


def _apply_known_profile_fields_to_event(event: LoggingProfileEvent, fields: dict[str, Any]) -> None:
    event["normalized_message"] = event.get("normalized_message") or _string_field(fields, "normalized_message")
    event["event"] = event.get("event") or _string_field(fields, "event")
    request = event.setdefault("request", {})
    job = event.setdefault("job", {})
    error = event.setdefault("error", {})
    request["correlation_id"] = request.get("correlation_id") or _string_field(fields, "correlation_id")
    request["route"] = request.get("route") or _string_field(fields, "route")
    request["method"] = request.get("method") or _string_field(fields, "method")
    request["path"] = request.get("path") or _string_field(fields, "path")
    request["status"] = request.get("status") or _int_field(fields, "status")
    job["name"] = job.get("name") or _string_field(fields, "job_name")
    error["type"] = error.get("type") or _first_string_field(fields, "error_type", "error.type")
    error["code"] = error.get("code") or _first_string_field(fields, "error_code", "error.code")
    error["stack_trace"] = error.get("stack_trace") or _string_field(fields, "stack_trace")


def _first_string_field(fields: dict[str, Any], *names: str) -> str:
    for name in names:
        value = _string_field(fields, name)
        if value:
            return value
    return ""


def _string_field(fields: dict[str, Any], name: str) -> str:
    value = fields.get(name)
    if value is None:
        return ""
    return value if isinstance(value, str) else str(value)


def _int_field(fields: dict[str, Any], name: str) -> int:
    value = fields.get(name)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return 0
    return 0


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
        if key not in {"debug", "info", "warn", "error"}:
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
    "LoggingProfileError",
    "LoggingProfileErrorCapture",
    "LoggingProfileEvent",
    "LoggingProfileJobContext",
    "LoggingProfileRequestContext",
    "LoggingProfileSanitization",
    "LoggingProfileSanitizer",
    "LoggingProfileValidationError",
    "ProfileLogger",
    "ProfileLoggerOptions",
    "built_in_logging_profile_names",
    "decode_logging_profile_json",
    "default_logging_profile",
    "encode_logging_profile_event",
    "encode_logging_profile_event_with_sanitizer",
    "hooks_from_logger",
    "hooks_from_profile_logger",
    "is_supported_profile_output_field",
    "logging_profile_catalog",
    "logging_profile_validation_errors",
    "validate_logging_profile",
]
