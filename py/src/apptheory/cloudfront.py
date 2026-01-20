from __future__ import annotations

from typing import Any

from apptheory.util import canonicalize_headers


def origin_url(headers: dict[str, Any] | None) -> str:
    h = canonicalize_headers(headers)
    forwarded = _parse_forwarded(_first_header_value(h, "forwarded"))

    host = _first_header_value(h, "x-forwarded-host") or forwarded.get("host") or _first_header_value(h, "host")
    host = _first_comma_token(host).strip()
    if not host:
        return ""

    proto = (
        _first_header_value(h, "cloudfront-forwarded-proto")
        or _first_header_value(h, "x-forwarded-proto")
        or forwarded.get("proto", "")
    )
    proto = _first_comma_token(proto).strip().lower()
    if not proto:
        proto = "https"

    return f"{proto}://{host}"


def client_ip(headers: dict[str, Any] | None) -> str:
    h = canonicalize_headers(headers)

    viewer = _first_header_value(h, "cloudfront-viewer-address")
    if viewer:
        ip = _parse_cloudfront_viewer_address(viewer)
        if ip:
            return ip

    xff = _first_header_value(h, "x-forwarded-for")
    if xff:
        ip = _first_comma_token(xff).strip()
        if ip:
            return ip

    return ""


def _first_header_value(headers: dict[str, list[str]], key: str) -> str:
    values = headers.get(str(key or "").strip().lower(), [])
    return str(values[0]) if values else ""


def _first_comma_token(value: Any) -> str:
    return str(value or "").split(",", 1)[0]


def _parse_forwarded(value: Any) -> dict[str, str]:
    raw = str(value or "").strip()
    if not raw:
        return {}

    first = raw.split(",", 1)[0]
    out: dict[str, str] = {}
    for part in first.split(";"):
        part = part.strip()
        if "=" not in part:
            continue
        key, val = part.split("=", 1)
        key = key.strip().lower()
        val = val.strip().strip("\"")
        if key in {"proto", "host"} and key not in out and val:
            out[key] = val
    return out


def _parse_cloudfront_viewer_address(value: Any) -> str:
    raw = str(value or "").strip().strip("\"")
    if not raw:
        return ""

    if raw.startswith("[") and "]" in raw:
        return raw.split("]", 1)[0].lstrip("[").strip()

    idx = raw.rfind(":")
    if idx <= 0:
        return raw
    ip_part = raw[:idx].strip()
    port_part = raw[idx + 1 :].strip()
    if not ip_part or not port_part:
        return raw
    if not port_part.isdigit():
        return raw
    return ip_part

