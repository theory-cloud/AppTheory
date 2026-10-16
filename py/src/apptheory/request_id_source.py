"""Request-ID source selection for the HTTP runtime."""

from __future__ import annotations

REQUEST_ID_SOURCE_DEFAULT = "default"
REQUEST_ID_SOURCE_SERVER = "server"


def normalize_request_id_source(value: str | None) -> str:
    """Normalize a request-ID source, defaulting to the historical behavior."""
    if str(value or "").strip() == REQUEST_ID_SOURCE_SERVER:
        return REQUEST_ID_SOURCE_SERVER
    return REQUEST_ID_SOURCE_DEFAULT


# MAX_CLIENT_REQUEST_ID_LENGTH is the longest client-supplied x-request-id
# header value the framework treats as well-formed.
MAX_CLIENT_REQUEST_ID_LENGTH = 128

# _CLIENT_REQUEST_ID_WHITESPACE lists the leading and trailing characters
# trimmed from a client x-request-id before its shape is judged. It is
# ASCII-only so that Go, TypeScript, and Python trim exactly the same bytes.
_CLIENT_REQUEST_ID_WHITESPACE = " \t\n\v\f\r"


def is_well_formed_client_request_id(value: str | None) -> bool:
    """Report whether a client-supplied x-request-id header value is well-formed.

    A value is well-formed when, after trimming leading and trailing whitespace,
    it is 1 to ``MAX_CLIENT_REQUEST_ID_LENGTH`` characters long and every
    character is visible ASCII (0x21 through 0x7E). Spaces, tabs, carriage
    returns, line feeds, other control characters, and non-ASCII characters all
    make a value malformed.

    The runtime never uses a malformed value as the request ID. Consumer
    applications read well-formed client values through
    ``Context.client_request_id``.
    """
    return well_formed_client_request_id(value) != ""


def well_formed_client_request_id(value: str | None) -> str:
    """Return the trimmed client value when well-formed, else an empty string."""
    trimmed = str(value if value is not None else "").strip(_CLIENT_REQUEST_ID_WHITESPACE)
    if len(trimmed) == 0 or len(trimmed) > MAX_CLIENT_REQUEST_ID_LENGTH:
        return ""
    for character in trimmed:
        codepoint = ord(character)
        if codepoint < 0x21 or codepoint > 0x7E:
            return ""
    return trimmed
