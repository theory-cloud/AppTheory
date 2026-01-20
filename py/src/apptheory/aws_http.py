from __future__ import annotations

import base64
import urllib.parse
from typing import Any

from apptheory.errors import AppError
from apptheory.request import Request
from apptheory.response import Response
from apptheory.util import normalize_path, to_bytes


def request_from_apigw_v2(event: dict[str, Any]) -> Request:
    return _request_from_http_event(event)


def request_from_lambda_function_url(event: dict[str, Any]) -> Request:
    return _request_from_http_event(event)


def apigw_v2_response_from_response(resp: Response) -> dict[str, Any]:
    headers: dict[str, str] = {}
    multi: dict[str, list[str]] = {}
    for key, values in (resp.headers or {}).items():
        if not values:
            continue
        headers[str(key)] = str(values[0])
        multi[str(key)] = [str(v) for v in values]

    body = (
        base64.b64encode(resp.body).decode("ascii")
        if resp.is_base64
        else resp.body.decode("utf-8", errors="replace")
    )

    return {
        "statusCode": int(resp.status),
        "headers": headers,
        "multiValueHeaders": multi,
        "body": body,
        "isBase64Encoded": bool(resp.is_base64),
        "cookies": [str(c) for c in (resp.cookies or [])],
    }


def lambda_function_url_response_from_response(resp: Response) -> dict[str, Any]:
    headers: dict[str, str] = {}
    for key, values in (resp.headers or {}).items():
        if not values:
            continue
        headers[str(key)] = ",".join([str(v) for v in values])

    body = (
        base64.b64encode(resp.body).decode("ascii")
        if resp.is_base64
        else resp.body.decode("utf-8", errors="replace")
    )

    return {
        "statusCode": int(resp.status),
        "headers": headers,
        "body": body,
        "isBase64Encoded": bool(resp.is_base64),
        "cookies": [str(c) for c in (resp.cookies or [])],
    }


def apigw_proxy_response_from_response(resp: Response) -> dict[str, Any]:
    headers: dict[str, str] = {}
    multi: dict[str, list[str]] = {}
    for key, values in (resp.headers or {}).items():
        if not values:
            continue
        headers[str(key)] = str(values[0])
        multi[str(key)] = [str(v) for v in values]

    if resp.cookies:
        headers["set-cookie"] = str(resp.cookies[0])
        multi["set-cookie"] = [str(c) for c in resp.cookies]

    body = (
        base64.b64encode(resp.body).decode("ascii")
        if resp.is_base64
        else resp.body.decode("utf-8", errors="replace")
    )

    return {
        "statusCode": int(resp.status),
        "headers": headers,
        "multiValueHeaders": multi,
        "body": body,
        "isBase64Encoded": bool(resp.is_base64),
    }


def build_apigw_v2_request(
    method: str,
    path: str,
    *,
    query: dict[str, list[str]] | None = None,
    headers: dict[str, str] | None = None,
    cookies: list[str] | None = None,
    body: Any = b"",
    is_base64: bool = False,
) -> dict[str, Any]:
    raw_path, raw_query_string = _split_path_and_query(path, query)
    body_bytes = to_bytes(body)
    body_str = (
        base64.b64encode(body_bytes).decode("ascii")
        if is_base64
        else body_bytes.decode("utf-8", errors="replace")
    )

    query_string_parameters: dict[str, str] = {}
    for key, values in (query or {}).items():
        if values:
            query_string_parameters[str(key)] = str(values[0])

    return {
        "version": "2.0",
        "routeKey": "$default",
        "rawPath": raw_path,
        "rawQueryString": raw_query_string,
        "cookies": [str(c) for c in (cookies or [])],
        "headers": dict(headers or {}),
        "queryStringParameters": query_string_parameters or None,
        "requestContext": {
            "http": {
                "method": str(method or "").strip().upper(),
                "path": raw_path,
            }
        },
        "body": body_str,
        "isBase64Encoded": bool(is_base64),
    }


def build_lambda_function_url_request(
    method: str,
    path: str,
    *,
    query: dict[str, list[str]] | None = None,
    headers: dict[str, str] | None = None,
    cookies: list[str] | None = None,
    body: Any = b"",
    is_base64: bool = False,
) -> dict[str, Any]:
    raw_path, raw_query_string = _split_path_and_query(path, query)
    body_bytes = to_bytes(body)
    body_str = (
        base64.b64encode(body_bytes).decode("ascii")
        if is_base64
        else body_bytes.decode("utf-8", errors="replace")
    )

    query_string_parameters: dict[str, str] = {}
    for key, values in (query or {}).items():
        if values:
            query_string_parameters[str(key)] = str(values[0])

    return {
        "version": "2.0",
        "rawPath": raw_path,
        "rawQueryString": raw_query_string,
        "cookies": [str(c) for c in (cookies or [])],
        "headers": dict(headers or {}),
        "queryStringParameters": query_string_parameters or None,
        "requestContext": {
            "http": {
                "method": str(method or "").strip().upper(),
                "path": raw_path,
            }
        },
        "body": body_str,
        "isBase64Encoded": bool(is_base64),
    }


def _request_from_http_event(event: dict[str, Any]) -> Request:
    cookies = [str(c) for c in (event.get("cookies") or [])]
    headers = _headers_from_single(event.get("headers"), ignore_cookie_header=bool(cookies))
    if cookies:
        headers["cookie"] = cookies

    raw_query_string = str(event.get("rawQueryString") or "").lstrip("?")
    query = (
        _parse_raw_query_string(raw_query_string)
        if raw_query_string
        else _query_from_single(event.get("queryStringParameters"))
    )

    request_context_http = (event.get("requestContext") or {}).get("http") or {}
    method = str(request_context_http.get("method") or "")
    raw_path = str(event.get("rawPath") or request_context_http.get("path") or "/")

    return Request(
        method=method,
        path=raw_path,
        query=query,
        headers=headers,
        body=str(event.get("body") or ""),
        is_base64=bool(event.get("isBase64Encoded")),
    )


def _headers_from_single(headers: dict[str, Any] | None, *, ignore_cookie_header: bool) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for key, value in (headers or {}).items():
        if ignore_cookie_header and str(key).strip().lower() == "cookie":
            continue
        out[str(key)] = [str(value)]
    return out


def _query_from_single(query: dict[str, Any] | None) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for key, value in (query or {}).items():
        out[str(key)] = [str(value)]
    return out


def _parse_raw_query_string(raw: str) -> dict[str, list[str]]:
    try:
        parsed = urllib.parse.parse_qs(raw, keep_blank_values=True, strict_parsing=False)
    except Exception:  # noqa: BLE001
        raise AppError("app.bad_request", "invalid query string") from None
    return {str(k): [str(v) for v in vs] for k, vs in parsed.items()}


def _split_path_and_query(path: str, query: dict[str, list[str]] | None) -> tuple[str, str]:
    raw_path = str(path or "").strip()
    raw_query_from_path = ""
    if "?" in raw_path:
        raw_path, raw_query_from_path = raw_path.split("?", 1)
    normalized_path = normalize_path(raw_path)

    if query:
        items: list[tuple[str, str]] = []
        for key in sorted(query.keys()):
            for value in query[key]:
                items.append((str(key), str(value)))
        return normalized_path, urllib.parse.urlencode(items, doseq=True)

    return normalized_path, raw_query_from_path
