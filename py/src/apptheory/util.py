from __future__ import annotations

from typing import Any


def normalize_path(path: str) -> str:
    value = str(path or "").strip()
    if not value:
        return "/"
    if "?" in value:
        value = value.split("?", 1)[0]
    if not value.startswith("/"):
        value = "/" + value
    return value or "/"


def canonicalize_headers(headers: dict[str, Any] | None) -> dict[str, list[str]]:
    if not headers:
        return {}
    out: dict[str, list[str]] = {}
    for key in sorted(headers.keys()):
        lower = str(key).strip().lower()
        if not lower:
            continue
        value = headers[key]
        values = value if isinstance(value, list) else [value]
        out.setdefault(lower, []).extend([str(v) for v in values])
    return out


def clone_query(query: dict[str, Any] | None) -> dict[str, list[str]]:
    if not query:
        return {}
    out: dict[str, list[str]] = {}
    for key, value in query.items():
        if isinstance(value, list):
            out[key] = [str(v) for v in value]
        else:
            out[key] = [str(value)]
    return out


def parse_cookies(cookie_headers: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for header in cookie_headers:
        for part in str(header).split(";"):
            trimmed = part.strip()
            if not trimmed:
                continue
            if "=" not in trimmed:
                continue
            name, value = trimmed.split("=", 1)
            name = name.strip()
            if not name:
                continue
            out[name] = value.strip()
    return out


def to_bytes(value: Any) -> bytes:
    if value is None:
        return b""
    if isinstance(value, bytes):
        return bytes(value)
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, memoryview):
        return value.tobytes()
    if isinstance(value, str):
        return value.encode("utf-8")
    raise TypeError("body must be bytes-like or str")
