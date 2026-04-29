from __future__ import annotations

import base64
from dataclasses import dataclass, field

from apptheory.errors import AppError
from apptheory.source_provenance import SourceProvenance, normalize_source_provenance, unknown_source_provenance
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
    source_provenance: SourceProvenance = field(default_factory=unknown_source_provenance)


def normalize_request(req: Request) -> Request:
    return normalize_request_with_max_bytes(req, 0)


def _validated_base64_decoded_length(body: bytes) -> int:
    if not body:
        return 0
    if len(body) % 4 != 0:
        raise AppError("app.bad_request", "invalid base64")

    pad_start = len(body)
    pad_len = 0
    for index, byte in enumerate(body):
        is_alnum = (65 <= byte <= 90) or (97 <= byte <= 122) or (48 <= byte <= 57)
        if is_alnum or byte in (43, 47):  # + /
            if pad_len:
                raise AppError("app.bad_request", "invalid base64")
            continue
        if byte == 61:  # =
            if pad_start == len(body):
                pad_start = index
            pad_len += 1
            if pad_len > 2:
                raise AppError("app.bad_request", "invalid base64")
            continue
        raise AppError("app.bad_request", "invalid base64")

    if pad_len and len(body) - pad_start > 2:
        raise AppError("app.bad_request", "invalid base64")

    return (len(body) // 4) * 3 - pad_len


def normalize_request_with_max_bytes(req: Request, max_request_bytes: int = 0) -> Request:
    method = str(req.method or "").strip().upper()
    path = normalize_path(req.path)
    query = clone_query(req.query)
    headers = canonicalize_headers(req.headers)

    body = to_bytes(req.body)
    is_base64 = bool(req.is_base64)
    if is_base64:
        decoded_length = _validated_base64_decoded_length(body)
        if max_request_bytes > 0 and decoded_length > max_request_bytes:
            raise AppError("app.too_large", "request too large")
        body = base64.b64decode(body, validate=True)

    cookies = parse_cookies(headers.get("cookie", []))

    return Request(
        method=method,
        path=path,
        query=query,
        headers=headers,
        cookies=cookies,
        body=body,
        is_base64=is_base64,
        source_provenance=normalize_source_provenance(req.source_provenance),
    )
