from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from typing import Any

_PROVIDER_APIGW_V2 = "apigw-v2"
_PROVIDER_LAMBDA_URL = "lambda-url"
_PROVIDER_APIGW_V1 = "apigw-v1"
_PROVIDER_UNKNOWN = "unknown"
_SOURCE_PROVIDER_REQUEST_CONTEXT = "provider_request_context"
_SOURCE_UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class SourceProvenance:
    """Provider-derived HTTP source metadata."""

    source_ip: str = ""
    provider: str = _PROVIDER_UNKNOWN
    source: str = _SOURCE_UNKNOWN
    valid: bool = False


def unknown_source_provenance() -> SourceProvenance:
    return SourceProvenance()


def source_provenance_from_provider_request_context(provider: Any, source_ip: Any) -> SourceProvenance:
    provider_value = str(provider or "").strip()
    if not _known_provider(provider_value):
        return unknown_source_provenance()

    parsed = _parse_ip(source_ip)
    if parsed == "":
        return unknown_source_provenance()

    return SourceProvenance(
        source_ip=parsed,
        provider=provider_value,
        source=_SOURCE_PROVIDER_REQUEST_CONTEXT,
        valid=True,
    )


def normalize_source_provenance(value: Any) -> SourceProvenance:
    if isinstance(value, SourceProvenance):
        valid = value.valid
        provider = value.provider
        source = value.source
        source_ip = value.source_ip
    elif isinstance(value, dict):
        valid = value.get("valid") is True
        provider = value.get("provider")
        source = value.get("source")
        source_ip = value.get("source_ip")
    else:
        return unknown_source_provenance()

    if not valid:
        return unknown_source_provenance()

    provider_value = str(provider or "").strip()
    if not _known_provider(provider_value):
        return unknown_source_provenance()

    source_value = str(source or "").strip()
    if source_value != _SOURCE_PROVIDER_REQUEST_CONTEXT:
        return unknown_source_provenance()

    parsed = _parse_ip(source_ip)
    if parsed == "":
        return unknown_source_provenance()

    return SourceProvenance(
        source_ip=parsed,
        provider=provider_value,
        source=source_value,
        valid=True,
    )


def _parse_ip(value: Any) -> str:
    raw = str(value or "").strip()
    if raw == "":
        return ""
    try:
        return str(ipaddress.ip_address(raw))
    except ValueError:
        return ""


def _known_provider(provider: str) -> bool:
    return provider in {_PROVIDER_APIGW_V2, _PROVIDER_LAMBDA_URL, _PROVIDER_APIGW_V1}
