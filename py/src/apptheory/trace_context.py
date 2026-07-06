from __future__ import annotations

from typing import Any

TRACEPARENT_HEADER = "traceparent"
X_AMZN_TRACE_ID_HEADER = "x-amzn-trace-id"


def extract_trace_id_from_headers(headers: dict[str, Any] | None) -> str:
    traceparent = _trace_id_from_traceparent(_first_non_empty_header_value(headers, TRACEPARENT_HEADER))
    if traceparent:
        return traceparent
    return _trace_id_from_x_amzn_trace_id(_first_non_empty_header_value(headers, X_AMZN_TRACE_ID_HEADER))


def _first_non_empty_header_value(headers: dict[str, Any] | None, key: str) -> str:
    values = (headers or {}).get(str(key or "").strip().lower(), [])
    if not isinstance(values, list):
        values = [values]
    for value in values:
        candidate = str(value or "").strip()
        if candidate:
            return candidate
    return ""


def _trace_id_from_traceparent(value: str) -> str:
    parts = str(value or "").strip().split("-")
    if len(parts) < 4:
        return ""
    trace_id = str(parts[1] or "").strip().lower()
    if len(trace_id) != 32 or not all(ch in "0123456789abcdef" for ch in trace_id):
        return ""
    if set(trace_id) == {"0"}:
        return ""
    return trace_id


def _trace_id_from_x_amzn_trace_id(value: str) -> str:
    header = str(value or "").strip()
    if not header:
        return ""
    for part in header.split(";"):
        if "=" not in part:
            continue
        name, raw = part.split("=", 1)
        if name.strip().lower() != "root":
            continue
        root = raw.strip()
        return root if _valid_xray_root(root) else ""
    return ""


def _valid_xray_root(root: str) -> bool:
    parts = str(root or "").split("-")
    if len(parts) != 3:
        return False
    version, epoch, unique = parts
    if version != "1" or len(epoch) != 8 or len(unique) != 24:
        return False
    hexdigits = set("0123456789abcdefABCDEF")
    if any(ch not in hexdigits for ch in epoch):
        return False
    if any(ch not in hexdigits for ch in unique):
        return False
    return set(unique) != {"0"}
