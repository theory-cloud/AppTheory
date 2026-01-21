from __future__ import annotations

import hashlib
from typing import Any

from apptheory.util import canonicalize_headers, to_bytes


def cache_control_ssr() -> str:
    return "private, no-store"


def cache_control_ssg() -> str:
    return "public, max-age=0, s-maxage=31536000"


def cache_control_isr(revalidate_seconds: int, stale_while_revalidate_seconds: int = 0) -> str:
    revalidate = int(revalidate_seconds or 0)
    if revalidate < 0:
        revalidate = 0
    stale = int(stale_while_revalidate_seconds or 0)
    if stale < 0:
        stale = 0

    parts = ["public", "max-age=0", f"s-maxage={revalidate}"]
    if stale > 0:
        parts.append(f"stale-while-revalidate={stale}")
    return ", ".join(parts)


def etag(body: Any) -> str:
    b = to_bytes(body)
    digest = hashlib.sha256(b).hexdigest()
    return f'"{digest}"'


def matches_if_none_match(headers: dict[str, Any] | None, etag_value: str) -> bool:
    tag = str(etag_value or "").strip()
    if not tag:
        return False

    h = canonicalize_headers(headers)
    for raw in h.get("if-none-match", []):
        for token in _split_comma_values(raw):
            if token == "*":
                return True
            token = token.strip()
            if token.lower().startswith("w/"):
                token = token[2:].strip()
            if token == tag:
                return True
    return False


def vary(existing: list[str] | None, *add: str) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []

    def add_token(token: str) -> None:
        key = str(token or "").strip().lower()
        if not key:
            return
        if key in seen:
            return
        seen.add(key)
        out.append(key)

    def add_value(value: Any) -> None:
        for token in _split_comma_values(value):
            add_token(token)

    for value in existing or []:
        add_value(value)
    for value in add:
        add_value(value)

    out.sort()
    return out


def _split_comma_values(value: Any) -> list[str]:
    raw = str(value or "").strip()
    if not raw:
        return []
    parts = [p.strip() for p in raw.split(",")]
    return [p for p in parts if p]
