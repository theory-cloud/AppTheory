from __future__ import annotations

import base64
import http
import urllib.parse
from typing import Any

from apptheory.errors import AppError
from apptheory.request import Request
from apptheory.response import Response
from apptheory.source_provenance import source_provenance_from_provider_request_context
from apptheory.util import normalize_path, to_bytes

_REMOTE_MCP_APIGW_CANONICAL_RESOURCES = frozenset(
    {
        "/mcp",
        "/mcp/{actor}",
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-protected-resource/mcp/{actor}",
    }
)


def request_from_apigw_v2(event: dict[str, Any]) -> Request:
    req = _request_from_http_event(event)
    req.source_provenance = source_provenance_from_provider_request_context(
        "apigw-v2",
        ((event.get("requestContext") or {}).get("http") or {}).get("sourceIp"),
    )
    return req


def request_from_lambda_function_url(event: dict[str, Any]) -> Request:
    req = _request_from_http_event(event)
    req.source_provenance = source_provenance_from_provider_request_context(
        "lambda-url",
        ((event.get("requestContext") or {}).get("http") or {}).get("sourceIp"),
    )
    return req


def request_from_apigw_proxy(event: dict[str, Any]) -> Request:
    request_context = event.get("requestContext") or {}
    if not isinstance(request_context, dict):
        request_context = {}

    headers = _headers_from_proxy(event.get("headers"), event.get("multiValueHeaders"))
    query = _query_from_proxy(
        event.get("queryStringParameters"),
        event.get("multiValueQueryStringParameters"),
    )

    return Request(
        method=str(event.get("httpMethod") or request_context.get("httpMethod") or ""),
        path=_apigw_proxy_request_path(event, request_context),
        query=query,
        headers=headers,
        body=str(event.get("body") or ""),
        is_base64=bool(event.get("isBase64Encoded")),
        source_provenance=source_provenance_from_provider_request_context(
            "apigw-v1",
            ((request_context.get("identity") or {}) if isinstance(request_context.get("identity"), dict) else {}).get(
                "sourceIp"
            ),
        ),
    )


def request_from_alb_target_group(event: dict[str, Any]) -> Request:
    headers = _headers_from_proxy(event.get("headers"), event.get("multiValueHeaders"))
    query = _query_from_proxy(
        event.get("queryStringParameters"),
        event.get("multiValueQueryStringParameters"),
    )

    return Request(
        method=str(event.get("httpMethod") or ""),
        path=str(event.get("path") or "/"),
        query=query,
        headers=headers,
        body=str(event.get("body") or ""),
        is_base64=bool(event.get("isBase64Encoded")),
    )


def apigw_v2_response_from_response(resp: Response) -> dict[str, Any]:
    headers: dict[str, str] = {}
    multi: dict[str, list[str]] = {}
    for key, values in (resp.headers or {}).items():
        if not values:
            continue
        headers[str(key)] = str(values[0])
        multi[str(key)] = [str(v) for v in values]

    body = (
        base64.b64encode(resp.body).decode("ascii") if resp.is_base64 else resp.body.decode("utf-8", errors="replace")
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
        base64.b64encode(resp.body).decode("ascii") if resp.is_base64 else resp.body.decode("utf-8", errors="replace")
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
        base64.b64encode(resp.body).decode("ascii") if resp.is_base64 else resp.body.decode("utf-8", errors="replace")
    )

    return {
        "statusCode": int(resp.status),
        "headers": headers,
        "multiValueHeaders": multi,
        "body": body,
        "isBase64Encoded": bool(resp.is_base64),
    }


def alb_target_group_response_from_response(resp: Response) -> dict[str, Any]:
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

    code = int(resp.status)
    phrase = ""
    try:
        phrase = http.HTTPStatus(code).phrase
    except Exception:  # noqa: BLE001
        phrase = ""

    body = (
        base64.b64encode(resp.body).decode("ascii") if resp.is_base64 else resp.body.decode("utf-8", errors="replace")
    )

    return {
        "statusCode": code,
        "statusDescription": f"{code} {phrase}".strip(),
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
        base64.b64encode(body_bytes).decode("ascii") if is_base64 else body_bytes.decode("utf-8", errors="replace")
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
        base64.b64encode(body_bytes).decode("ascii") if is_base64 else body_bytes.decode("utf-8", errors="replace")
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


def build_alb_target_group_request(
    method: str,
    path: str,
    *,
    query: dict[str, list[str]] | None = None,
    headers: dict[str, str] | None = None,
    multi_headers: dict[str, list[str]] | None = None,
    body: Any = b"",
    is_base64: bool = False,
    target_group_arn: str = "arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/test/0000000000000000",
) -> dict[str, Any]:
    raw_path, raw_query_string = _split_path_and_query(path, query)

    query_map = query or {}
    if not query_map and raw_query_string:
        query_map = _parse_raw_query_string(raw_query_string)

    single_query: dict[str, str] = {}
    for key, values in query_map.items():
        if values:
            single_query[str(key)] = str(values[0])

    headers_single: dict[str, str] = dict(headers or {})
    headers_multi: dict[str, list[str]] = {
        str(k): [str(v) for v in (vs or [])] for k, vs in (multi_headers or {}).items()
    }
    for key, value in headers_single.items():
        if key not in headers_multi:
            headers_multi[key] = [str(value)]
    for key, values in headers_multi.items():
        if key not in headers_single and values:
            headers_single[key] = str(values[0])

    body_bytes = to_bytes(body)
    body_str = (
        base64.b64encode(body_bytes).decode("ascii") if is_base64 else body_bytes.decode("utf-8", errors="replace")
    )

    return {
        "httpMethod": str(method or "").strip().upper(),
        "path": raw_path,
        "queryStringParameters": single_query or None,
        "multiValueQueryStringParameters": query_map or None,
        "headers": headers_single,
        "multiValueHeaders": headers_multi or None,
        "requestContext": {"elb": {"targetGroupArn": str(target_group_arn or "").strip()}},
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


def _headers_from_proxy(
    headers: dict[str, Any] | None,
    multi: dict[str, Any] | None,
) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for key, values in (multi or {}).items():
        if values is None:
            continue
        if isinstance(values, list):
            out[str(key)] = [str(v) for v in values]
        else:
            out[str(key)] = [str(values)]
    for key, value in (headers or {}).items():
        if str(key) in out:
            continue
        out[str(key)] = [str(value)]
    return out


def _query_from_proxy(
    query: dict[str, Any] | None,
    multi: dict[str, Any] | None,
) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for key, values in (multi or {}).items():
        if values is None:
            continue
        if isinstance(values, list):
            out[str(key)] = [str(v) for v in values]
        else:
            out[str(key)] = [str(values)]
    for key, value in (query or {}).items():
        if str(key) in out:
            continue
        out[str(key)] = [str(value)]
    return out


def _apigw_proxy_request_path(event: dict[str, Any], request_context: dict[str, Any]) -> str:
    path = str(event.get("path") or request_context.get("path") or "/")
    if not _should_canonicalize_apigw_proxy_request_path(event, request_context):
        return path
    return _canonicalize_apigw_proxy_request_path(path)


def _should_canonicalize_apigw_proxy_request_path(event: dict[str, Any], request_context: dict[str, Any]) -> bool:
    return _apigw_proxy_matched_resource(event, request_context) in _REMOTE_MCP_APIGW_CANONICAL_RESOURCES


def _apigw_proxy_matched_resource(event: dict[str, Any], request_context: dict[str, Any]) -> str:
    resource = _normalize_apigw_proxy_route_path(event.get("resource"))
    if resource != "/":
        return resource

    request_context_resource = _normalize_apigw_proxy_route_path(request_context.get("resourcePath"))
    if request_context_resource != "/":
        return request_context_resource

    return ""


def _normalize_apigw_proxy_route_path(path: Any) -> str:
    trimmed = str(path or "").strip().strip("/")
    if not trimmed:
        return "/"

    parts = [part.strip() for part in trimmed.split("/") if part.strip()]
    if not parts:
        return "/"
    return "/" + "/".join(parts)


def _canonicalize_apigw_proxy_request_path(path: str) -> str:
    normalized = normalize_path(path)
    if normalized == "/":
        return normalized
    return normalized.rstrip("/") or "/"


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
            items.extend((str(key), str(value)) for value in query[key])
        return normalized_path, urllib.parse.urlencode(items, doseq=True)

    return normalized_path, raw_query_from_path
