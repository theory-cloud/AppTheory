from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from apptheory.response import Response, normalize_response


@dataclass(slots=True)
class AppError(Exception):
    code: str
    message: str

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


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
    headers_out: dict[str, Any] = dict(headers or {})
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
    headers_out: dict[str, Any] = dict(headers or {})
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


def response_for_error(exc: Exception) -> Response:
    if isinstance(exc, AppError):
        return error_response(exc.code, exc.message)
    return error_response("app.internal", "internal error")


def response_for_error_with_request_id(exc: Exception, request_id: str) -> Response:
    if isinstance(exc, AppError):
        return error_response_with_request_id(exc.code, exc.message, request_id=request_id)
    return error_response_with_request_id("app.internal", "internal error", request_id=request_id)
