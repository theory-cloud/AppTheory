from __future__ import annotations

import base64
from dataclasses import dataclass, field

from apptheory.errors import AppError
from apptheory.util import canonicalize_headers, clone_query, normalize_path, parse_cookies, to_bytes


@dataclass(slots=True)
class Request:
    method: str
    path: str
    query: dict[str, list[str]] = field(default_factory=dict)
    headers: dict[str, object] = field(default_factory=dict)
    cookies: dict[str, str] = field(default_factory=dict)
    body: object = b""
    is_base64: bool = False


def normalize_request(req: Request) -> Request:
    method = str(req.method or "").strip().upper()
    path = normalize_path(req.path)
    query = clone_query(req.query)
    headers = canonicalize_headers(req.headers)

    body = to_bytes(req.body)
    is_base64 = bool(req.is_base64)
    if is_base64:
        try:
            body = base64.b64decode(body, validate=True)
        except Exception:  # noqa: BLE001
            raise AppError("app.bad_request", "invalid base64") from None

    cookies = parse_cookies(headers.get("cookie", []))

    return Request(
        method=method,
        path=path,
        query=query,
        headers=headers,
        cookies=cookies,
        body=body,
        is_base64=is_base64,
    )
