from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from apptheory.sanitization import (
    payment_xml_patterns,
    rapid_connect_xml_patterns,
    sanitize_field_value,
    sanitize_json,
    sanitize_log_string,
    sanitize_xml,
)


@runtime_checkable
class StructuredLogger(Protocol):
    def debug(self, message: str, *fields: dict[str, Any]) -> None: ...

    def info(self, message: str, *fields: dict[str, Any]) -> None: ...

    def warn(self, message: str, *fields: dict[str, Any]) -> None: ...

    def error(self, message: str, *fields: dict[str, Any]) -> None: ...

    def with_field(self, key: str, value: Any) -> StructuredLogger: ...

    def with_fields(self, fields: dict[str, Any]) -> StructuredLogger: ...

    def with_request_id(self, request_id: str) -> StructuredLogger: ...

    def with_tenant_id(self, tenant_id: str) -> StructuredLogger: ...

    def with_user_id(self, user_id: str) -> StructuredLogger: ...

    def with_trace_id(self, trace_id: str) -> StructuredLogger: ...

    def with_span_id(self, span_id: str) -> StructuredLogger: ...

    def flush(self) -> None: ...

    def close(self) -> None: ...

    def is_healthy(self) -> bool: ...

    def get_stats(self) -> dict[str, Any]: ...


class NoOpLogger:
    def debug(self, _message: str, *fields: dict[str, Any]) -> None:
        return None

    def info(self, _message: str, *fields: dict[str, Any]) -> None:
        return None

    def warn(self, _message: str, *fields: dict[str, Any]) -> None:
        return None

    def error(self, _message: str, *fields: dict[str, Any]) -> None:
        return None

    def with_field(self, _key: str, _value: Any) -> StructuredLogger:
        return self

    def with_fields(self, _fields: dict[str, Any]) -> StructuredLogger:
        return self

    def with_request_id(self, _request_id: str) -> StructuredLogger:
        return self

    def with_tenant_id(self, _tenant_id: str) -> StructuredLogger:
        return self

    def with_user_id(self, _user_id: str) -> StructuredLogger:
        return self

    def with_trace_id(self, _trace_id: str) -> StructuredLogger:
        return self

    def with_span_id(self, _span_id: str) -> StructuredLogger:
        return self

    def flush(self) -> None:
        return None

    def close(self) -> None:
        return None

    def is_healthy(self) -> bool:
        return True

    def get_stats(self) -> dict[str, Any]:
        return {}


_global_logger: StructuredLogger = NoOpLogger()


def get_logger() -> StructuredLogger:
    return _global_logger


def set_logger(logger: StructuredLogger | None) -> None:
    global _global_logger
    _global_logger = logger if logger is not None else NoOpLogger()


__all__ = [
    "NoOpLogger",
    "StructuredLogger",
    "get_logger",
    "payment_xml_patterns",
    "rapid_connect_xml_patterns",
    "sanitize_field_value",
    "sanitize_json",
    "sanitize_log_string",
    "sanitize_xml",
    "set_logger",
]
