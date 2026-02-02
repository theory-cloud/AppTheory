from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from apptheory.response import Response, normalize_response
from apptheory.util import canonicalize_headers


@dataclass(slots=True)
class AppError(Exception):
    code: str
    message: str

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


@dataclass(slots=True)
class AppTheoryError(Exception):
    code: str
    message: str
    status_code: int | None = None
    details: dict[str, Any] | None = None
    request_id: str = ""
    trace_id: str = ""
    timestamp: str = ""
    stack_trace: str = ""
    cause: Exception | None = None

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"

    def with_details(self, details: dict[str, Any]) -> AppTheoryError:
        self.details = details
        return self

    def with_request_id(self, request_id: str) -> AppTheoryError:
        self.request_id = str(request_id)
        return self

    def with_trace_id(self, trace_id: str) -> AppTheoryError:
        self.trace_id = str(trace_id)
        return self

    def with_timestamp(self, timestamp: str) -> AppTheoryError:
        self.timestamp = str(timestamp)
        return self

    def with_stack_trace(self, stack_trace: str) -> AppTheoryError:
        self.stack_trace = str(stack_trace)
        return self

    def with_status_code(self, status_code: int) -> AppTheoryError:
        self.status_code = int(status_code)
        return self

    def with_cause(self, cause: Exception) -> AppTheoryError:
        self.cause = cause
        self.__cause__ = cause
        return self


def app_theory_error_from_app_error(exc: AppError) -> AppTheoryError:
    return AppTheoryError(code=exc.code, message=exc.message)


def status_for_error_code(code: str) -> int:
    match code:
        case "app.bad_request" | "app.validation_failed":
            return 400
        case "app.unauthorized":
            return 401
        case "app.forbidden":
            return 403
        case "app.not_found":
            return 404
        case "app.method_not_allowed":
            return 405
        case "app.conflict":
            return 409
        case "app.too_large":
            return 413
        case "app.timeout":
            return 408
        case "app.rate_limited":
            return 429
        case "app.overloaded":
            return 503
        case "app.internal":
            return 500
        case _:
            return 500


def error_response(code: str, message: str, *, headers: dict[str, Any] | None = None) -> Response:
    headers_out = canonicalize_headers(headers or {})
    headers_out["content-type"] = ["application/json; charset=utf-8"]

    body = json.dumps(
        {"error": {"code": code, "message": message}},
        ensure_ascii=False,
        sort_keys=True,
    ).encode("utf-8")

    return normalize_response(
        Response(
            status=status_for_error_code(code),
            headers=headers_out,
            cookies=[],
            body=body,
            is_base64=False,
        )
    )


def error_response_with_request_id(
    code: str,
    message: str,
    *,
    headers: dict[str, Any] | None = None,
    request_id: str = "",
) -> Response:
    headers_out = canonicalize_headers(headers or {})
    headers_out["content-type"] = ["application/json; charset=utf-8"]

    error: dict[str, Any] = {"code": code, "message": message}
    if request_id:
        error["request_id"] = str(request_id)

    body = json.dumps(
        {"error": error},
        ensure_ascii=False,
        sort_keys=True,
    ).encode("utf-8")

    return normalize_response(
        Response(
            status=status_for_error_code(code),
            headers=headers_out,
            cookies=[],
            body=body,
            is_base64=False,
        )
    )


def error_response_from_app_theory_error(
    exc: AppTheoryError,
    *,
    headers: dict[str, Any] | None = None,
    request_id: str = "",
) -> Response:
    headers_out = canonicalize_headers(headers or {})
    headers_out["content-type"] = ["application/json; charset=utf-8"]

    code = str(exc.code or "").strip() or "app.internal"
    status = int(exc.status_code) if exc.status_code and exc.status_code > 0 else status_for_error_code(code)

    error: dict[str, Any] = {"code": code, "message": str(exc.message)}
    if exc.status_code and exc.status_code > 0:
        error["status_code"] = int(exc.status_code)
    if exc.details is not None:
        error["details"] = exc.details

    resolved_request_id = str(exc.request_id or "").strip() or str(request_id or "").strip()
    if resolved_request_id:
        error["request_id"] = resolved_request_id
    if str(exc.trace_id or "").strip():
        error["trace_id"] = str(exc.trace_id)
    if str(exc.timestamp or "").strip():
        error["timestamp"] = str(exc.timestamp)
    if str(exc.stack_trace or "").strip():
        error["stack_trace"] = str(exc.stack_trace)

    body = json.dumps(
        {"error": error},
        ensure_ascii=False,
        sort_keys=True,
    ).encode("utf-8")

    return normalize_response(
        Response(
            status=status,
            headers=headers_out,
            cookies=[],
            body=body,
            is_base64=False,
        )
    )


def response_for_error(exc: Exception) -> Response:
    if isinstance(exc, AppTheoryError):
        return error_response_from_app_theory_error(exc)
    if isinstance(exc, AppError):
        return error_response(exc.code, exc.message)
    return error_response("app.internal", "internal error")


def response_for_error_with_request_id(exc: Exception, request_id: str) -> Response:
    if isinstance(exc, AppTheoryError):
        return error_response_from_app_theory_error(exc, request_id=request_id)
    if isinstance(exc, AppError):
        return error_response_with_request_id(exc.code, exc.message, request_id=request_id)
    return error_response_with_request_id("app.internal", "internal error", request_id=request_id)
