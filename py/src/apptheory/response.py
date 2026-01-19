from __future__ import annotations

import json as jsonlib
from dataclasses import dataclass
from typing import Any

from apptheory.util import canonicalize_headers, to_bytes


@dataclass(slots=True)
class Response:
    status: int
    headers: dict[str, Any]
    cookies: list[str]
    body: bytes
    is_base64: bool


def text(status: int, body: str) -> Response:
    return normalize_response(
        Response(
            status=status,
            headers={"content-type": ["text/plain; charset=utf-8"]},
            cookies=[],
            body=str(body).encode("utf-8"),
            is_base64=False,
        )
    )


def json(status: int, value: Any) -> Response:
    body = jsonlib.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return normalize_response(
        Response(
            status=status,
            headers={"content-type": ["application/json; charset=utf-8"]},
            cookies=[],
            body=body,
            is_base64=False,
        )
    )


def binary(status: int, body: Any, content_type: str | None = None) -> Response:
    headers: dict[str, Any] = {}
    if content_type:
        headers["content-type"] = [str(content_type)]
    return normalize_response(
        Response(
            status=status,
            headers=headers,
            cookies=[],
            body=to_bytes(body),
            is_base64=True,
        )
    )


def normalize_response(resp: Response) -> Response:
    status = int(resp.status or 200)
    headers = canonicalize_headers(resp.headers)
    cookies = [str(c) for c in (resp.cookies or [])]
    body = to_bytes(resp.body)
    return Response(
        status=status,
        headers=headers,
        cookies=cookies,
        body=body,
        is_base64=bool(resp.is_base64),
    )
