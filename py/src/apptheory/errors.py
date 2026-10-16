from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from apptheory.response import Response, normalize_response
from apptheory.util import canonicalize_headers

HTTP_ERROR_FORMAT_NESTED = "nested"
HTTP_ERROR_FORMAT_FLAT_LEGACY = "flat_legacy"

_FALLBACK_HTTP_ERROR_STATUS = 500
_FALLBACK_HTTP_ERROR_BODY_NESTED = b'{"error":{"code":"app.internal","message":"internal error","status_code":500}}'
_FALLBACK_HTTP_ERROR_BODY_FLAT_LEGACY = b'{"code":"app.internal","message":"internal error"}'


def normalize_http_error_format(value: str | None) -> str:
    if str(value or "").strip() == HTTP_ERROR_FORMAT_FLAT_LEGACY:
        return HTTP_ERROR_FORMAT_FLAT_LEGACY
    return HTTP_ERROR_FORMAT_NESTED


@dataclass(slots=True)
class AppError(Exception):
    """Legacy portable, client-safe error with a stable error code.

    Deprecated: return AppTheoryError from new code so status, request,
    trace, timestamp, details, and cause metadata use the canonical AppTheory
    error path.
    """

    code: str
    message: str

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


@dataclass(slots=True)
class AppTheoryError(Exception):
    """Canonical AppTheory portable, client-safe error.

    Return AppTheoryError from framework and application code when the runtime
    should preserve status, details, request, trace, timestamp, stack, or cause
    metadata in the AppTheory error envelope.

    ``headers`` carries a bounded caller-supplied response header set. The HTTP
    error renderer merges them (canonicalized) into the error response, so a
    SecureApp principal resolver can attach a ``WWW-Authenticate`` challenge to
    a 401/403 denial. The existing response vocabulary is unchanged: ``None``
    or empty ``headers`` renders byte-identical to before.
    """

    code: str
    message: str
    status_code: int | None = None
    details: dict[str, Any] | None = None
    request_id: str = ""
    trace_id: str = ""
    timestamp: str = ""
    stack_trace: str = ""
    headers: dict[str, Any] | None = None
    cause: Exception | None = None

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"

    def with_headers(self, headers: dict[str, Any]) -> AppTheoryError:
        self.headers = headers
        return self

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
        case "app.bad_request":
            return 400
        case "app.validation_failed":
            return 422
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


def _canonical_http_error_fields(error_format: str, code: str, message: str) -> tuple[str, str]:
    if normalize_http_error_format(error_format) == HTTP_ERROR_FORMAT_FLAT_LEGACY:
        return code, message
    match code:
        case "EMPTY_BODY":
            return "app.bad_request", "request body is empty"
        case "INVALID_JSON":
            return "app.bad_request", "invalid json"
        case _:
            return code, message


def _canonical_runtime_error_code(code: str) -> str:
    match code:
        case "EMPTY_BODY" | "INVALID_JSON":
            return "app.bad_request"
        case _:
            return code


def error_response(code: str, message: str, *, headers: dict[str, Any] | None = None) -> Response:
    return error_response_with_format(HTTP_ERROR_FORMAT_NESTED, code, message, headers=headers)


def error_response_with_format(
    error_format: str,
    code: str,
    message: str,
    *,
    headers: dict[str, Any] | None = None,
) -> Response:
    headers_out = canonicalize_headers(headers or {})
    headers_out["content-type"] = ["application/json; charset=utf-8"]

    status = status_for_error_code(_canonical_runtime_error_code(code))
    body_code, body_message = _canonical_http_error_fields(error_format, code, message)
    error: dict[str, Any] = {"code": body_code, "message": body_message}
    if normalize_http_error_format(error_format) != HTTP_ERROR_FORMAT_FLAT_LEGACY:
        error["status_code"] = status
    status, body = _serialize_error_response_body(error_format, status, error)

    return normalize_response(
        Response(
            status=status,
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
    return error_response_with_request_id_and_format(
        HTTP_ERROR_FORMAT_NESTED,
        code,
        message,
        headers=headers,
        request_id=request_id,
    )


def error_response_with_request_id_and_format(
    error_format: str,
    code: str,
    message: str,
    *,
    headers: dict[str, Any] | None = None,
    request_id: str = "",
) -> Response:
    return error_response_with_request_id_trace_id_and_format(
        error_format,
        code,
        message,
        headers=headers,
        request_id=request_id,
        trace_id="",
    )


def error_response_with_request_id_trace_id_and_format(
    error_format: str,
    code: str,
    message: str,
    *,
    headers: dict[str, Any] | None = None,
    request_id: str = "",
    trace_id: str = "",
) -> Response:
    headers_out = canonicalize_headers(headers or {})
    headers_out["content-type"] = ["application/json; charset=utf-8"]

    body_code, body_message = _canonical_http_error_fields(error_format, code, message)
    status = status_for_error_code(_canonical_runtime_error_code(code))
    error: dict[str, Any] = {"code": body_code, "message": body_message}
    if normalize_http_error_format(error_format) != HTTP_ERROR_FORMAT_FLAT_LEGACY:
        error["status_code"] = status
        if request_id:
            error["request_id"] = str(request_id)
        resolved_trace_id = str(trace_id or "").strip()
        if resolved_trace_id:
            error["trace_id"] = resolved_trace_id

    status, body = _serialize_error_response_body(error_format, status, error)

    return normalize_response(
        Response(
            status=status,
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
    return error_response_from_app_theory_error_with_format(
        HTTP_ERROR_FORMAT_NESTED,
        exc,
        headers=headers,
        request_id=request_id,
    )


def error_response_from_app_theory_error_with_format(
    error_format: str,
    exc: AppTheoryError,
    *,
    headers: dict[str, Any] | None = None,
    request_id: str = "",
    trace_id: str = "",
) -> Response:
    headers_out = canonicalize_headers(headers or {})
    headers_out["content-type"] = ["application/json; charset=utf-8"]
    normalized_format = normalize_http_error_format(error_format)

    code = str(exc.code or "").strip() or "app.internal"
    body_code, body_message = _canonical_http_error_fields(error_format, code, str(exc.message))
    status = int(exc.status_code) if exc.status_code and exc.status_code > 0 else status_for_error_code(body_code)

    error: dict[str, Any] = {"code": body_code, "message": body_message}
    if normalized_format != HTTP_ERROR_FORMAT_FLAT_LEGACY:
        error["status_code"] = status
    if exc.details is not None:
        error["details"] = exc.details

    if normalized_format != HTTP_ERROR_FORMAT_FLAT_LEGACY:
        resolved_request_id = str(exc.request_id or "").strip() or str(request_id or "").strip()
        if resolved_request_id:
            error["request_id"] = resolved_request_id
        resolved_trace_id = str(exc.trace_id or "").strip() or str(trace_id or "").strip()
        if resolved_trace_id:
            error["trace_id"] = resolved_trace_id
        if str(exc.timestamp or "").strip():
            error["timestamp"] = str(exc.timestamp)
        if str(exc.stack_trace or "").strip():
            error["stack_trace"] = str(exc.stack_trace)

    status, body = _serialize_error_response_body(error_format, status, error)

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
    return response_for_error_with_format(HTTP_ERROR_FORMAT_NESTED, exc)


def response_for_error_with_format(error_format: str, exc: Exception) -> Response:
    if isinstance(exc, AppTheoryError):
        return error_response_from_app_theory_error_with_format(error_format, exc, headers=exc.headers)
    if isinstance(exc, AppError):
        return error_response_with_format(error_format, exc.code, exc.message)
    return error_response_with_format(error_format, "app.internal", "internal error")


def response_for_error_with_request_id(exc: Exception, request_id: str) -> Response:
    return response_for_error_with_request_id_and_format(HTTP_ERROR_FORMAT_NESTED, exc, request_id)


def response_for_error_with_request_id_and_format(error_format: str, exc: Exception, request_id: str) -> Response:
    return response_for_error_with_request_id_trace_id_and_format(error_format, exc, request_id, "")


def response_for_error_with_request_id_trace_id_and_format(
    error_format: str,
    exc: Exception,
    request_id: str,
    trace_id: str,
) -> Response:
    if isinstance(exc, AppTheoryError):
        return error_response_from_app_theory_error_with_format(
            error_format,
            exc,
            headers=exc.headers,
            request_id=request_id,
            trace_id=trace_id,
        )
    if isinstance(exc, AppError):
        return error_response_with_request_id_trace_id_and_format(
            error_format,
            exc.code,
            exc.message,
            request_id=request_id,
            trace_id=trace_id,
        )
    return error_response_with_request_id_trace_id_and_format(
        error_format,
        "app.internal",
        "internal error",
        request_id=request_id,
        trace_id=trace_id,
    )


def _serialize_http_error_body(error_format: str, error: dict[str, Any]) -> bytes:
    payload = error if normalize_http_error_format(error_format) == HTTP_ERROR_FORMAT_FLAT_LEGACY else {"error": error}
    return json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")


def _fallback_http_error_body(error_format: str) -> bytes:
    """The internal-error envelope sent when the intended envelope cannot be serialized.

    It carries no request id, trace id, timestamp, or stack trace: a response that failed
    to serialize reports the internal error and nothing about the original error.
    """
    if normalize_http_error_format(error_format) == HTTP_ERROR_FORMAT_FLAT_LEGACY:
        return _FALLBACK_HTTP_ERROR_BODY_FLAT_LEGACY
    return _FALLBACK_HTTP_ERROR_BODY_NESTED


def _serialize_error_response_body(
    error_format: str,
    status: int,
    error: dict[str, Any],
) -> tuple[int, bytes]:
    """Render the error envelope, or the internal-error fallback sent with status 500.

    A serialization failure — for example ``details`` carrying a value ``json`` cannot
    represent, which raises ``TypeError``, or a circular reference, which raises
    ``ValueError`` — never escapes the renderer. The fallback status keeps the nested body's
    ``status_code`` equal to the status on the wire.
    """
    try:
        return status, _serialize_http_error_body(error_format, error)
    except (TypeError, ValueError):
        return _FALLBACK_HTTP_ERROR_STATUS, _fallback_http_error_body(error_format)
