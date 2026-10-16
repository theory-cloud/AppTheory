"""Request-ID source selection for the HTTP runtime."""

from __future__ import annotations

REQUEST_ID_SOURCE_DEFAULT = "default"
REQUEST_ID_SOURCE_SERVER = "server"


def normalize_request_id_source(value: str | None) -> str:
    """Normalize a request-ID source, defaulting to the historical behavior."""
    if str(value or "").strip() == REQUEST_ID_SOURCE_SERVER:
        return REQUEST_ID_SOURCE_SERVER
    return REQUEST_ID_SOURCE_DEFAULT
