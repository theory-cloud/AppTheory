from __future__ import annotations

import unicodedata


def log_safe_value(value: object) -> str:
    raw = "" if value is None else str(value)
    if not raw:
        return raw

    out: list[str] = []
    for char in raw:
        if not _is_unsafe_log_value_char(char):
            out.append(char)
            continue
        out.extend(f"%{byte:02X}" for byte in char.encode("utf-8", errors="replace"))
    return "".join(out)


def _is_unsafe_log_value_char(char: str) -> bool:
    return char in {"%", "="} or char.isspace() or unicodedata.category(char) == "Cc"
