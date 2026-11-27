"""ASGI and WSGI entry points for a Lambda Web Function.

A Python Lambda Web Function does not call a handler. Lambda manages the HTTP server and passes
each request to the application through the Asynchronous Server Gateway Interface (ASGI) or the
Web Server Gateway Interface (WSGI); the application exposes the callable, and Lambda loads
``main:app`` unless ``AWS_LAMBDA_PYTHON_ENTRYPOINT`` names another module and callable. These two
wrappers are that application for an AppTheory runtime: they turn an ASGI or WSGI request into an
AppTheory :class:`~apptheory.request.Request`, call the runtime's ``serve``, and write the
:class:`~apptheory.response.Response` back — streaming a ``Response.body_stream`` chunk by chunk
as it is produced rather than buffering the whole body.

Where the handler runs, and why it is safe to run it there:

* **ASGI** — the wrapper is one async callable on the server's single event loop, so the loop
  accepts other requests, delivers other responses' chunks, and handles disconnects while this
  request is in flight. The request's synchronous ``serve`` call runs on the loop's default worker
  thread, and every blocking ``next()`` on a streamed body runs there too, so a synchronous
  AppTheory handler never blocks the loop. This is the shape an ASGI framework gives a ``def``
  endpoint, and it is the shape upstream documents for AWS: "when you create a synchronous endpoint
  using ``def`` instead of ``async def``, ASGI frameworks such as FastAPI and Starlette can run the
  endpoint in a thread pool".
* **WSGI** — the server calls the wrapper on one of its worker threads, which is upstream's WSGI
  concurrency model ("a pool of worker threads, with each request running in its own thread"), and
  the handler runs on that thread.

Both paths are also what keeps the runtime's awaitable resolution intact. ``App.serve`` and the
bindings resolve ``async def`` handlers with ``asyncio.run``, which is only legal when the calling
thread has no running event loop; neither entry point ever enters ``serve`` with one.

Per-request state stays isolated because everything AppTheory carries across a request lives in the
request's own objects — the normalized ``Request``, the ``Context``, the handler's return value, and
the body stream. Nothing in these wrappers is stored on the module, on the runtime, or in a
thread-local, so two overlapping requests cannot observe each other. AWS states the same rule for
applications: "avoid storing request-specific data in global variables".
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterable, Mapping
from http import HTTPStatus
from typing import Any, Protocol
from urllib.parse import parse_qsl

from apptheory.request import Request
from apptheory.response import Response

ASGIScope = Mapping[str, Any]
ASGIReceive = Callable[[], Awaitable[Mapping[str, Any]]]
ASGISend = Callable[[Mapping[str, Any]], Awaitable[None]]
WSGIEnviron = Mapping[str, Any]
WSGIStartResponse = Callable[[str, list[tuple[str, str]]], Any]

# ASGI servers ask the application for its lifespan events before serving. These entry points hold
# no startup or shutdown state, so the protocol is answered immediately instead of making the server
# treat the application as lifespan-unsupported.
_LIFESPAN_STARTUP = "lifespan.startup"
_LIFESPAN_SHUTDOWN = "lifespan.shutdown"
_LIFESPAN_STARTUP_COMPLETE = "lifespan.startup.complete"
_LIFESPAN_SHUTDOWN_COMPLETE = "lifespan.shutdown.complete"

_CONTENT_LENGTH = "content-length"
_COOKIE_HEADER = "set-cookie"


class ServingApp(Protocol):
    """The one runtime method an entry point calls.

    :class:`apptheory.App` and :class:`apptheory.SecureApp` both satisfy it.
    """

    def serve(self, request: Request, ctx: Any | None = None) -> Response: ...


def _require_app(app: Any) -> Any:
    serve = getattr(app, "serve", None)
    if not callable(serve):
        raise RuntimeError(
            "apptheory: an AppTheory runtime with serve(request) is required; "
            "pass the App or SecureApp the application is built on"
        )
    return app


def _header_pairs(headers: dict[str, Any]) -> list[tuple[str, str]]:
    """Flatten canonicalized response headers into ordered name/value pairs."""
    pairs: list[tuple[str, str]] = []
    for name, values in headers.items():
        pairs.extend((str(name), str(value)) for value in values)
    return pairs


def _response_headers(response: Response, *, has_body_length: bool) -> list[tuple[str, str]]:
    """Return the headers to write, adding the framing header a buffered body needs.

    A streamed body has no length until it ends, so it is left to the server's chunked framing. A
    buffered body is framed with ``content-length`` unless the response already carries one.
    """
    pairs = _header_pairs(response.headers)
    for cookie in response.cookies:
        pairs.append((_COOKIE_HEADER, str(cookie)))
    if has_body_length and not any(name.lower() == _CONTENT_LENGTH for name, _ in pairs):
        pairs.append((_CONTENT_LENGTH, str(len(response.body))))
    return pairs


def _asgi_headers(raw: Any) -> dict[str, list[str]]:
    headers: dict[str, list[str]] = {}
    for name, value in raw or []:
        key = name.decode("latin-1") if isinstance(name, bytes | bytearray) else str(name)
        text = value.decode("latin-1") if isinstance(value, bytes | bytearray) else str(value)
        headers.setdefault(key, []).append(text)
    return headers


def _query_from_string(query_string: Any) -> dict[str, list[str]]:
    text = query_string.decode("latin-1") if isinstance(query_string, bytes | bytearray) else str(query_string or "")
    if not text:
        return {}
    query: dict[str, list[str]] = {}
    for name, value in parse_qsl(text, keep_blank_values=True):
        query.setdefault(name, []).append(value)
    return query


def _wsgi_headers(environ: WSGIEnviron) -> dict[str, list[str]]:
    headers: dict[str, list[str]] = {}
    for key, value in environ.items():
        if not isinstance(key, str):
            continue
        if key.startswith("HTTP_"):
            name = key[len("HTTP_") :].replace("_", "-")
        elif key in {"CONTENT_TYPE", "CONTENT_LENGTH"}:
            name = key.replace("_", "-")
        else:
            continue
        headers.setdefault(name, []).append(str(value))
    return headers


def _wsgi_body(environ: WSGIEnviron) -> bytes:
    """Read the request body WSGI declares, and refuse a stream that ends early."""
    raw_length = str(environ.get("CONTENT_LENGTH") or "0").strip()
    try:
        length = int(raw_length or "0")
    except ValueError as exc:
        raise ValueError(f"apptheory: invalid CONTENT_LENGTH {raw_length!r}") from exc
    if length <= 0:
        return b""
    stream = environ.get("wsgi.input")
    if stream is None:
        raise ValueError("apptheory: CONTENT_LENGTH is set but wsgi.input is missing")
    body = stream.read(length)
    if len(body) != length:
        raise ValueError(f"apptheory: request body ended after {len(body)} of {length} bytes")
    return bytes(body)


async def _asgi_body(receive: ASGIReceive) -> bytes | None:
    """Read the whole request body, or return ``None`` when the client disconnected first."""
    chunks: list[bytes] = []
    while True:
        message = await receive()
        if message.get("type") == "http.disconnect":
            return None
        if message.get("type") != "http.request":
            continue
        chunk = message.get("body") or b""
        chunks.append(bytes(chunk))
        if not message.get("more_body"):
            return b"".join(chunks)


def _next_chunk(iterator: Any) -> bytes | None:
    """Return the next streamed chunk, or ``None`` when the stream ended.

    Executors cannot carry ``StopIteration`` across a thread boundary, so the end of the stream is
    reported as ``None`` instead of an exception.
    """
    try:
        return next(iterator)
    except StopIteration:
        return None


class ASGIApp:
    """An ASGI 3.0 application that serves an AppTheory runtime.

    ``main.py`` exposing ``app = ASGIApp(runtime)`` is the default entry point a Python Lambda Web
    Function loads, and ``asgi:main:app`` names the interface explicitly.
    """

    __slots__ = ("_app",)

    def __init__(self, app: ServingApp) -> None:
        self._app = _require_app(app)

    async def __call__(self, scope: ASGIScope, receive: ASGIReceive, send: ASGISend) -> None:
        scope_type = str(scope.get("type") or "")
        if scope_type == "lifespan":
            await _serve_lifespan(receive, send)
            return
        if scope_type != "http":
            raise RuntimeError(
                f"apptheory: the ASGI entry point serves HTTP requests only; received a {scope_type!r} scope"
            )

        body = await _asgi_body(receive)
        if body is None:
            # The client went away before the request arrived in full, so there is no request to
            # answer and no connection left to answer it on.
            return

        request = Request(
            method=str(scope.get("method") or "GET"),
            path=str(scope.get("path") or "/"),
            query=_query_from_string(scope.get("query_string") or b""),
            headers=_asgi_headers(scope.get("headers")),
            body=body,
        )
        response = await asyncio.to_thread(self._app.serve, request)
        await _send_asgi_response(response, request.method.upper() == "HEAD", send)


async def _serve_lifespan(receive: ASGIReceive, send: ASGISend) -> None:
    while True:
        message = await receive()
        if message.get("type") == _LIFESPAN_STARTUP:
            await send({"type": _LIFESPAN_STARTUP_COMPLETE})
            continue
        if message.get("type") == _LIFESPAN_SHUTDOWN:
            await send({"type": _LIFESPAN_SHUTDOWN_COMPLETE})
            return


async def _send_asgi_response(response: Response, head_only: bool, send: ASGISend) -> None:
    stream = response.body_stream
    headers = _response_headers(response, has_body_length=stream is None)
    await send(
        {
            "type": "http.response.start",
            "status": int(response.status),
            "headers": [(name.encode("latin-1"), value.encode("latin-1")) for name, value in headers],
        }
    )

    if head_only:
        _close_stream(stream)
        await send({"type": "http.response.body", "body": b"", "more_body": False})
        return
    if stream is None:
        await send({"type": "http.response.body", "body": bytes(response.body), "more_body": False})
        return

    iterator = iter(stream)
    try:
        while True:
            chunk = await asyncio.to_thread(_next_chunk, iterator)
            if chunk is None:
                break
            await send({"type": "http.response.body", "body": chunk, "more_body": True})
        await send({"type": "http.response.body", "body": b"", "more_body": False})
    finally:
        # A disconnect surfaces here as a failed send; releasing the stream is what lets a producer
        # blocked on its next write stop instead of running until the revision times out.
        _close_stream(stream)


def _close_stream(stream: Any) -> None:
    close = getattr(stream, "close", None)
    if callable(close):
        close()


class WSGIApp:
    """A WSGI application that serves an AppTheory runtime.

    ``main.py`` exposing ``application = WSGIApp(runtime)`` is loaded as ``wsgi:main:application``.
    """

    __slots__ = ("_app",)

    def __init__(self, app: ServingApp) -> None:
        self._app = _require_app(app)

    def __call__(self, environ: WSGIEnviron, start_response: WSGIStartResponse) -> Iterable[bytes]:
        request = Request(
            method=str(environ.get("REQUEST_METHOD") or "GET"),
            path=str(environ.get("PATH_INFO") or "/"),
            query=_query_from_string(environ.get("QUERY_STRING") or ""),
            headers=_wsgi_headers(environ),
            body=_wsgi_body(environ),
        )
        response = self._app.serve(request)
        stream = response.body_stream
        head_only = request.method.upper() == "HEAD"
        headers = _response_headers(response, has_body_length=stream is None)
        start_response(f"{int(response.status)} {_reason(int(response.status))}", headers)

        if head_only:
            _close_stream(stream)
            return []
        if stream is None:
            return [bytes(response.body)]
        # The response's canonical body stream forwards close() to whoever produced it, which is the
        # method a WSGI server calls when it stops reading.
        return stream


def _reason(status: int) -> str:
    try:
        return HTTPStatus(status).phrase
    except ValueError:
        return "Unknown"
