"""The AppTheory application the example's Python Web Function serves.

Both entry points beside this module serve this one application: ``main.py`` as an ASGI app and
``main_wsgi.py`` as a WSGI app. Nothing here touches a port, starts a server or reads an address:
Lambda manages the HTTP server for a Python Web Function and passes each request to the application
through the interface the entry point declares.

The concurrency rule this example exists to demonstrate: one execution environment answers many
concurrent requests, so per-request state lives in the request's own arguments and never in a
module-level variable. Read a module global from two overlapping requests and each one sees the
other's data; that is exactly what ``scripts/local/run_examples_local.py``'s
``web-function-python`` row refuses to let regress.
"""

from __future__ import annotations

import time
from collections.abc import Iterator

from apptheory import Context, Response, SSEEvent, SecureApp, html, public, sse_event_stream, text

TICK_SECONDS = 0.12
DEFAULT_TICKS = 3
MAX_TICKS = 20

PAGE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>AppTheory Python Web Function</title>
  </head>
  <body>
    <h1>AppTheory Python Web Function</h1>
    <p>Lambda manages the HTTP server and passes each request to this application through ASGI or
    WSGI; one execution environment answers many concurrent requests.</p>
    <p><a href="/stream?tag=browser">Stream a response</a></p>
  </body>
</html>
"""


def ticks_from(ctx: Context) -> int:
    """The tick count this request asked for, bounded by the example's own limit."""
    requested = (ctx.request.query.get("ticks") or [""])[0]
    try:
        ticks = int(requested)
    except ValueError:
        return DEFAULT_TICKS
    if ticks < 1:
        return DEFAULT_TICKS
    return min(ticks, MAX_TICKS)


def tick_events(tag: str, ticks: int) -> Iterator[SSEEvent]:
    """Produce one event per tick.

    Every value here is derived from this request's own arguments, which is what keeps two
    overlapping streams from sharing a tag or a tick counter.
    """
    for tick in range(1, ticks + 1):
        yield SSEEvent(event="tick", data={"tag": tag, "tick": tick, "ticks": ticks})
        time.sleep(TICK_SECONDS)
    yield SSEEvent(event="done", data={"tag": tag, "ticks": ticks})


def streamed_sse(tag: str, ticks: int) -> Response:
    """A server-sent event response delivered as the events are produced."""
    return Response(
        status=200,
        headers={"content-type": ["text/event-stream"], "cache-control": ["no-store"]},
        cookies=[],
        body=b"",
        is_base64=False,
        body_stream=sse_event_stream(tick_events(tag, ticks)),
    )


def build_app() -> SecureApp:
    """Build the application both entry points serve."""

    app = SecureApp()

    def page(_ctx: Context) -> Response:
        return html(200, PAGE)

    def health(_ctx: Context) -> Response:
        return text(200, "ok")

    def stream(ctx: Context) -> Response:
        tag = (ctx.request.query.get("tag") or ["anonymous"])[0]
        return streamed_sse(tag, ticks_from(ctx))

    app.get("/", page, public())
    app.get("/health", health, public())
    app.get("/stream", stream, public())
    return app
