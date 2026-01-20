from __future__ import annotations

import json as jsonlib
from dataclasses import dataclass
from typing import Any, Iterable, Iterator

from apptheory.response import Response, normalize_response


@dataclass(slots=True)
class SSEEvent:
    id: str = ""
    event: str = ""
    data: Any = ""

    def __init__(self, *, id: str = "", event: str = "", data: Any = "") -> None:
        self.id = str(id or "").strip()
        self.event = str(event or "").strip()
        self.data = data


def _sse_data_string(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, str):
        return value
    return jsonlib.dumps(value, separators=(",", ":"), ensure_ascii=False, sort_keys=True)


def format_sse_event(event: SSEEvent) -> bytes:
    parts: list[str] = []

    if event.id:
        parts.append(f"id: {event.id}\n")
    if event.event:
        parts.append(f"event: {event.event}\n")

    data = _sse_data_string(event.data).replace("\r\n", "\n").replace("\r", "\n")
    lines = data.split("\n") if data is not None else [""]
    if not lines:
        lines = [""]
    for line in lines:
        parts.append(f"data: {line}\n")

    parts.append("\n")
    return "".join(parts).encode("utf-8")


def sse(status: int, events: list[SSEEvent]) -> Response:
    framed = b"".join([format_sse_event(e) for e in (events or [])])
    return normalize_response(
        Response(
            status=int(status or 200),
            headers={
                "content-type": ["text/event-stream"],
                "cache-control": ["no-cache"],
                "connection": ["keep-alive"],
            },
            cookies=[],
            body=framed,
            is_base64=False,
        )
    )


def sse_event_stream(events: Iterable[SSEEvent] | None) -> Iterator[bytes]:
    for event in events or []:
        yield format_sse_event(event)
