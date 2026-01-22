from __future__ import annotations

import json as jsonlib
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

_REDACTED_VALUE = "[REDACTED]"

_ALLOWED_FIELDS: set[str] = {
    "card_bin",
    "card_brand",
    "card_type",
}

_SENSITIVE_FIELDS: dict[str, str] = {
    "cvv": "fully",
    "security_code": "fully",
    "cvv2": "fully",
    "cvc": "fully",
    "cvc2": "fully",
    "cardholder": "fully",
    "cardholder_name": "fully",
    "card_number": "partial",
    "number": "partial",
    "account_number": "partial",
    "ssn": "partial",
    "tin": "partial",
    "tax_id": "partial",
    "ein": "partial",
    "password": "fully",
    "secret": "fully",
    "private_key": "fully",
    "secret_key": "fully",
    "api_token": "fully",
    "api_key_id": "partial",
    "authorization": "fully",
    "authorization_id": "fully",
    "authorization_header": "fully",
}


def sanitize_log_string(value: str) -> str:
    v = str(value or "")
    if not v:
        return v
    return v.replace("\r", "").replace("\n", "")


def _strip_non_digits(value: str) -> str:
    return re.sub(r"[^\d]+", "", str(value or ""))


def _mask_restricted_string(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return _REDACTED_VALUE

    digits = _strip_non_digits(raw)
    if len(digits) >= 4:
        if len(digits) == 4:
            return "****"
        return ("*" * (len(digits) - 4)) + digits[-4:]

    if len(raw) >= 4:
        return "..." + raw[-4:]
    return _REDACTED_VALUE


def _mask_card_number_string(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return _REDACTED_VALUE

    digits = _strip_non_digits(raw)
    if len(digits) < 4:
        return _REDACTED_VALUE
    if len(digits) > 10:
        return digits[:6] + ("*" * (len(digits) - 10)) + digits[-4:]
    if len(digits) > 4:
        return ("*" * (len(digits) - 4)) + digits[-4:]
    return "****"


def sanitize_field_value(key: str, value: Any) -> Any:
    k = str(key or "").strip().lower()
    if not k:
        return _sanitize_value(value)
    if k in _ALLOWED_FIELDS:
        return _sanitize_value(value)

    explicit = _SENSITIVE_FIELDS.get(k)
    if explicit == "fully":
        return _REDACTED_VALUE
    if explicit == "partial":
        if k in {"card_number", "number"}:
            return _mask_card_number_string(str(value or ""))
        return _mask_restricted_string(str(value or ""))

    blocked_substrings = [
        "secret",
        "token",
        "password",
        "private_key",
        "client_secret",
        "api_key",
        "authorization",
    ]
    for s in blocked_substrings:
        if s in k:
            return _REDACTED_VALUE

    return _sanitize_value(value)


def _sanitize_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        return sanitize_log_string(value)
    if isinstance(value, (bytes, bytearray)):
        return sanitize_log_string(bytes(value).decode("utf-8", errors="replace"))
    if isinstance(value, list):
        return [_sanitize_value(v) for v in value]
    if isinstance(value, dict):
        return {k: sanitize_field_value(str(k), v) for k, v in value.items()}
    return sanitize_log_string(str(value))


def sanitize_json(json_bytes: bytes | str) -> str:
    if json_bytes is None:
        return "(empty)"

    raw = json_bytes.encode("utf-8") if isinstance(json_bytes, str) else bytes(json_bytes)

    if not raw:
        return "(empty)"

    try:
        data = jsonlib.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        return f"(malformed JSON: {exc})"

    sanitized = _sanitize_json_value(data)
    try:
        return jsonlib.dumps(sanitized, indent=2, ensure_ascii=False, sort_keys=True)
    except Exception:  # noqa: BLE001
        return "(error marshaling sanitized JSON)"


def _sanitize_json_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, list):
        return [_sanitize_json_value(v) for v in value]
    if not isinstance(value, dict):
        return _sanitize_value(value)

    out: dict[str, Any] = {}
    for key, raw in value.items():
        if key == "body" and isinstance(raw, str):
            try:
                parsed = jsonlib.loads(raw)
            except jsonlib.JSONDecodeError:
                parsed = None
            else:
                out[key] = jsonlib.dumps(
                    _sanitize_json_value(parsed),
                    separators=(",", ":"),
                    ensure_ascii=False,
                    sort_keys=True,
                )
                continue
        out[str(key)] = sanitize_field_value(str(key), raw)
    return out


@dataclass(frozen=True, slots=True)
class XMLSanitizationPattern:
    name: str
    pattern: re.Pattern[str]
    masking_func: Callable[[str], str]


def sanitize_xml(xml_string: str, patterns: list[XMLSanitizationPattern]) -> str:
    out = str(xml_string or "")
    for pattern in patterns or []:
        masking_func = pattern.masking_func
        out = pattern.pattern.sub(lambda m, masking_func=masking_func: masking_func(m.group(0)), out)
    return out


def _mask_card_number_xml(match: str) -> str:
    m = str(match or "")
    is_escaped = "&gt;" in m

    if is_escaped:
        start = m.find("&gt;") + 4
        end = m.rfind("&lt;")
    else:
        start = m.find(">") + 1
        end = m.rfind("<")

    if end > start:
        number = m[start:end]
        masked = _mask_card_number_string(number)
        return m[:start] + masked + m[end:]
    return m


def _mask_completely_xml(replacement: str) -> Callable[[str], str]:
    rep = str(replacement or "")

    def _mask(match: str) -> str:
        m = str(match or "")
        is_escaped = "&gt;" in m

        if is_escaped:
            start = m.find("&gt;") + 4
            end = m.rfind("&lt;")
        else:
            start = m.find(">") + 1
            end = m.rfind("<")

        if end >= start:
            return m[:start] + rep + m[end:]
        return m

    return _mask


def _mask_token_last_four_xml(match: str) -> str:
    m = str(match or "")
    is_escaped = "&gt;" in m

    if "><" in m or "&gt;&lt;" in m:
        return m

    if is_escaped:
        start = m.find("&gt;") + 4
        end = m.rfind("&lt;")
    else:
        start = m.find(">") + 1
        end = m.rfind("<")

    if end > start:
        token = m[start:end]
        if len(token) > 4:
            masked = ("*" * (len(token) - 4)) + token[-4:]
            return m[:start] + masked + m[end:]
    return m


payment_xml_patterns: list[XMLSanitizationPattern] = [
    XMLSanitizationPattern(
        name="AcctNum",
        pattern=re.compile(r"(<AcctNum>[^<]*</AcctNum>|&lt;AcctNum&gt;[^&]*&lt;/AcctNum&gt;)", re.IGNORECASE),
        masking_func=_mask_card_number_xml,
    ),
    XMLSanitizationPattern(
        name="CardNum",
        pattern=re.compile(r"(<CardNum>[^<]*</CardNum>|&lt;CardNum&gt;[^&]*&lt;/CardNum&gt;)", re.IGNORECASE),
        masking_func=_mask_card_number_xml,
    ),
    XMLSanitizationPattern(
        name="CardNumber",
        pattern=re.compile(
            r"(<CardNumber>[^<]*</CardNumber>|&lt;CardNumber&gt;[^&]*&lt;/CardNumber&gt;)",
            re.IGNORECASE,
        ),
        masking_func=_mask_card_number_xml,
    ),
    XMLSanitizationPattern(
        name="TrackData",
        pattern=re.compile(r"(<TrackData>[^<]*</TrackData>|&lt;TrackData&gt;[^&]*&lt;/TrackData&gt;)", re.IGNORECASE),
        masking_func=_mask_completely_xml(_REDACTED_VALUE),
    ),
    XMLSanitizationPattern(
        name="CVV",
        pattern=re.compile(r"(<CVV>[^<]*</CVV>|&lt;CVV&gt;[^&]*&lt;/CVV&gt;)", re.IGNORECASE),
        masking_func=_mask_completely_xml(_REDACTED_VALUE),
    ),
    XMLSanitizationPattern(
        name="CVV2",
        pattern=re.compile(r"(<CVV2>[^<]*</CVV2>|&lt;CVV2&gt;[^&]*&lt;/CVV2&gt;)", re.IGNORECASE),
        masking_func=_mask_completely_xml(_REDACTED_VALUE),
    ),
    XMLSanitizationPattern(
        name="CVC",
        pattern=re.compile(r"(<CVC>[^<]*</CVC>|&lt;CVC&gt;[^&]*&lt;/CVC&gt;)", re.IGNORECASE),
        masking_func=_mask_completely_xml(_REDACTED_VALUE),
    ),
    XMLSanitizationPattern(
        name="ExpDate",
        pattern=re.compile(r"(<ExpDate>[^<]*</ExpDate>|&lt;ExpDate&gt;[^&]*&lt;/ExpDate&gt;)", re.IGNORECASE),
        masking_func=_mask_completely_xml(_REDACTED_VALUE),
    ),
    XMLSanitizationPattern(
        name="ExpiryDate",
        pattern=re.compile(
            r"(<ExpiryDate>[^<]*</ExpiryDate>|&lt;ExpiryDate&gt;[^&]*&lt;/ExpiryDate&gt;)",
            re.IGNORECASE,
        ),
        masking_func=_mask_completely_xml(_REDACTED_VALUE),
    ),
    XMLSanitizationPattern(
        name="Password",
        pattern=re.compile(r"(<Password>[^<]*</Password>|&lt;Password&gt;[^&]*&lt;/Password&gt;)", re.IGNORECASE),
        masking_func=_mask_completely_xml(_REDACTED_VALUE),
    ),
    XMLSanitizationPattern(
        name="TransArmorToken",
        pattern=re.compile(
            r"(<TransArmorToken>[^<]*</TransArmorToken>|&lt;TransArmorToken&gt;[^&]*&lt;/TransArmorToken&gt;)",
            re.IGNORECASE,
        ),
        masking_func=_mask_token_last_four_xml,
    ),
]

rapid_connect_xml_patterns = payment_xml_patterns
