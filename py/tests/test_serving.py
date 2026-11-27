from __future__ import annotations

import asyncio
import sys
import threading
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.app import App  # noqa: E402
from apptheory.context import Context  # noqa: E402
from apptheory.response import Response, html, html_stream, text  # noqa: E402
from apptheory.serving import ASGIApp, WSGIApp  # noqa: E402
from apptheory._safe_log import log_safe_value  # noqa: E402


def _scope(
    method: str = "GET",
    path: str = "/",
    query: str = "",
    headers: list[tuple[bytes, bytes]] | None = None,
) -> dict:
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method,
        "scheme": "https",
        "path": path,
        "raw_path": path.encode("latin-1"),
        "query_string": query.encode("latin-1"),
        "root_path": "",
        "headers": headers or [],
        "client": ("127.0.0.1", 1234),
        "server": ("127.0.0.1", 443),
    }


class _Receiver:
    """An ASGI receive channel that hands out the request and then holds the connection open.

    After the request has been delivered it behaves the way a server does: ``receive()`` sleeps until
    the client does something, and the something it can do is disconnect.
    """

    def __init__(self, body: bytes = b"", *, chunks: list[bytes] | None = None, disconnect: bool = False) -> None:
        parts: list[bytes] = [] if disconnect else ([body] if chunks is None else chunks)
        self._messages = [
            {"type": "http.request", "body": chunk, "more_body": index < len(parts) - 1}
            for index, chunk in enumerate(parts)
        ]
        self._disconnect = disconnect
        self._idle = asyncio.Event()

    async def __call__(self) -> dict:
        if self._messages:
            return self._messages.pop(0)
        if self._disconnect:
            return {"type": "http.disconnect"}
        await self._idle.wait()
        return {"type": "http.disconnect"}


class _DisconnectingReceiver:
    """Delivers the request body, then waits until the test says the client went away."""

    def __init__(self) -> None:
        self.request_read = False
        self.disconnected = asyncio.Event()

    async def __call__(self) -> dict:
        if not self.request_read:
            self.request_read = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await self.disconnected.wait()
        return {"type": "http.disconnect"}


class _RaisingReceiver:
    """Delivers the request body, then fails: a channel that is not the one ASGI defines.

    A conforming server reports a disconnect as `http.disconnect` and never raises, so this is the
    nonconforming edge: `receive()` itself blows up once the body is in. What the wrapper owes the
    server here is the response it already has, and nothing else.
    """

    def __init__(self, error: BaseException | None = None) -> None:
        self._error = error if error is not None else RuntimeError("receive() raised after the body")
        self._served = False

    async def __call__(self) -> dict:
        if not self._served:
            self._served = True
            return {"type": "http.request", "body": b"", "more_body": False}
        raise self._error


class _RequestLikeError(RuntimeError):
    """A channel failure that is carrying the request it was serving, as server code's own can."""


class _UnstringableError(RuntimeError):
    """A channel failure that cannot describe itself: its own ``str()`` raises."""

    def __str__(self) -> str:
        raise RuntimeError("this exception cannot describe itself")


def _collector() -> tuple[list[dict], list[float], object]:
    sent: list[dict] = []
    at: list[float] = []

    async def send(message: dict) -> None:
        at.append(time.monotonic())
        sent.append(message)

    return sent, at, send


def _drive(app: ASGIApp, scope: dict, receiver: _Receiver) -> list[dict]:
    sent, _, send = _collector()
    asyncio.run(app(scope, receiver, send))
    return sent


def _body(sent: list[dict]) -> bytes:
    return b"".join(message.get("body") or b"" for message in sent if message["type"] == "http.response.body")


def _headers(sent: list[dict]) -> dict[str, list[str]]:
    start = next(message for message in sent if message["type"] == "http.response.start")
    headers: dict[str, list[str]] = {}
    for name, value in start["headers"]:
        headers.setdefault(name.decode("latin-1"), []).append(value.decode("latin-1"))
    return headers


class ASGIRequestTests(unittest.TestCase):
    """The ASGI wrapper hands the runtime a normalized AppTheory request."""

    def test_method_path_query_headers_and_body_reach_the_handler(self) -> None:
        seen: dict[str, object] = {}

        def handler(ctx: Context) -> Response:
            seen["method"] = ctx.request.method
            seen["path"] = ctx.request.path
            seen["query"] = ctx.request.query
            seen["header"] = ctx.request.headers.get("x-tag")
            seen["body"] = ctx.request.body
            return text(200, "ok")

        app = App()
        app.post("/items", handler)
        sent = _drive(
            ASGIApp(app),
            _scope(
                "POST",
                "/items",
                "tag=first&tag=second&empty=",
                [(b"x-tag", b"overlap"), (b"content-type", b"text/plain")],
            ),
            _Receiver(b'{"a":1}'),
        )

        self.assertEqual("POST", seen["method"])
        self.assertEqual("/items", seen["path"])
        self.assertEqual({"tag": ["first", "second"], "empty": [""]}, seen["query"])
        self.assertEqual(["overlap"], seen["header"])
        self.assertEqual(b'{"a":1}', seen["body"])
        self.assertEqual(200, sent[0]["status"])
        self.assertEqual(b"ok", _body(sent))

    def test_a_body_split_across_messages_is_assembled(self) -> None:
        def handler(ctx: Context) -> Response:
            return text(200, ctx.request.body.decode("utf-8"))

        app = App()
        app.post("/echo", handler)
        sent = _drive(ASGIApp(app), _scope("POST", "/echo"), _Receiver(chunks=[b"one", b"-", b"two"]))
        self.assertEqual(b"one-two", _body(sent))

    def test_a_request_that_disconnects_mid_body_is_not_served(self) -> None:
        calls: list[str] = []

        def handler(_ctx: Context) -> Response:
            calls.append("served")
            return text(200, "ok")

        app = App()
        app.post("/items", handler)
        sent = _drive(ASGIApp(app), _scope("POST", "/items"), _Receiver(b"", disconnect=True))
        self.assertEqual([], sent, "an abandoned request must not answer")
        self.assertEqual([], calls, "an abandoned request must not reach the handler")


class ASGIResponseTests(unittest.TestCase):
    """The ASGI wrapper writes the AppTheory response back as ASGI messages."""

    def test_a_buffered_response_is_framed_with_content_length(self) -> None:
        app = App()
        app.get("/", lambda _ctx: html(200, "<h1>page</h1>"))
        sent = _drive(ASGIApp(app), _scope("GET", "/"), _Receiver())

        headers = _headers(sent)
        self.assertEqual(["text/html; charset=utf-8"], headers["content-type"])
        self.assertEqual([str(len(b"<h1>page</h1>"))], headers["content-length"])
        self.assertEqual(b"<h1>page</h1>", _body(sent))
        self.assertEqual([True], [message.get("more_body") is False for message in sent[1:]])

    def test_a_streamed_response_is_delivered_chunk_by_chunk(self) -> None:
        produced: list[float] = []

        def chunks():
            for tick in range(1, 4):
                produced.append(time.monotonic())
                yield f"tick {tick}\n".encode()
                time.sleep(0.02)

        app = App()
        app.get("/stream", lambda _ctx: html_stream(200, chunks()))
        sent, at, send = _collector()
        asyncio.run(ASGIApp(app)(_scope("GET", "/stream"), _Receiver(), send))

        headers = _headers(sent)
        self.assertNotIn("content-length", headers, "a streamed body has no length up front")
        bodies = [message for message in sent if message["type"] == "http.response.body"]
        self.assertEqual(4, len(bodies), "three chunks and the closing message")
        self.assertEqual([True, True, True, False], [message["more_body"] for message in bodies])
        self.assertEqual([b"tick 1\ntick 2\ntick 3\n"], [_body(sent)])

        # Delivery, not production: each chunk reaches the server before the next one is produced,
        # so a wrapper that buffered the whole stream could not pass this.
        for index in range(2):
            self.assertGreaterEqual(at[index + 1], produced[index])
            self.assertLess(
                at[index + 1],
                produced[index + 1],
                "chunk reached the server only after the next one was produced",
            )
        self.assertGreaterEqual(at[3], produced[2])

    def test_cookies_are_written_as_set_cookie_headers(self) -> None:
        app = App()
        app.get(
            "/",
            lambda _ctx: Response(
                status=200,
                headers={},
                cookies=["a=1; Path=/", "b=2; Path=/"],
                body=b"",
                is_base64=False,
            ),
        )
        sent = _drive(ASGIApp(app), _scope("GET", "/"), _Receiver())
        self.assertEqual(["a=1; Path=/", "b=2; Path=/"], _headers(sent)["set-cookie"])

    def test_a_head_request_sends_headers_and_no_body(self) -> None:
        app = App()
        app.handle("HEAD", "/", lambda _ctx: text(200, "ok"))
        sent = _drive(ASGIApp(app), _scope("HEAD", "/"), _Receiver())
        self.assertEqual(["2"], _headers(sent)["content-length"])
        self.assertEqual(b"", _body(sent))

    def test_the_lifespan_protocol_is_answered(self) -> None:
        app = ASGIApp(App())
        sent, _, send = _collector()
        received = [
            {"type": "lifespan.startup", "asgi": {"version": "3.0"}},
            {"type": "lifespan.shutdown", "asgi": {"version": "3.0"}},
        ]

        async def receive() -> dict:
            return received.pop(0)

        asyncio.run(app({"type": "lifespan", "asgi": {"version": "3.0"}}, receive, send))
        self.assertEqual(["lifespan.startup.complete", "lifespan.shutdown.complete"], [m["type"] for m in sent])

    def test_a_scope_that_is_not_http_is_refused(self) -> None:
        app = ASGIApp(App())
        sent, _, send = _collector()
        with self.assertRaises(RuntimeError) as raised:
            asyncio.run(app({"type": "websocket", "path": "/ws"}, _Receiver(), send))
        self.assertIn("serves HTTP requests only", str(raised.exception))
        self.assertEqual([], sent)


class ASGIReleaseTests(unittest.TestCase):
    """Every way out of a streamed response releases the producer behind it.

    A response nobody is reading must stop being produced. A client that goes away is reported by
    ASGI through ``receive()`` — a send on the dead transport does not fail under the reference
    server — and a send failure is reported by a raise. Both have to release the stream.
    """

    def test_a_failed_start_send_still_releases_the_producer(self) -> None:
        producer = _Producer()
        app = App()
        app.get("/stream", lambda _ctx: html_stream(200, producer))

        async def send(_message: dict) -> None:
            raise ConnectionError("the transport is gone before the response starts")

        with self.assertRaises(ConnectionError):
            asyncio.run(ASGIApp(app)(_scope("GET", "/stream"), _Receiver(), send))
        self.assertTrue(producer.closed, "a send that fails before the response starts must release the producer")

    def test_a_disconnect_during_the_response_stops_the_producer(self) -> None:
        ticks = 40
        produced: list[int] = []
        released: list[str] = []

        def chunks():
            try:
                for tick in range(1, ticks + 1):
                    produced.append(tick)
                    yield f"tick {tick}\n".encode()
                    time.sleep(0.01)
            finally:
                released.append("closed")

        app = App()
        app.get("/stream", lambda _ctx: html_stream(200, chunks()))
        receiver = _DisconnectingReceiver()
        _, _, send = _collector()

        async def drive() -> None:
            task = asyncio.ensure_future(ASGIApp(app)(_scope("GET", "/stream"), receiver, send))
            while len(produced) < 3:
                await asyncio.sleep(0.01)
            receiver.disconnected.set()
            await asyncio.wait_for(task, timeout=15)

        asyncio.run(drive())
        self.assertEqual(["closed"], released, "the client went away, so the producer must be released")
        self.assertLess(len(produced), ticks, "the producer ran to exhaustion after the client went away")

    def test_a_disconnect_before_the_response_starts_is_not_answered(self) -> None:
        started = threading.Event()
        producer = _Producer()

        def handler(_ctx: Context) -> Response:
            started.set()
            time.sleep(0.05)
            return html_stream(200, producer)

        app = App()
        app.get("/stream", handler)
        receiver = _DisconnectingReceiver()
        sent, _, send = _collector()

        async def drive() -> None:
            task = asyncio.ensure_future(ASGIApp(app)(_scope("GET", "/stream"), receiver, send))
            while not started.is_set():
                await asyncio.sleep(0.01)
            receiver.disconnected.set()
            await asyncio.wait_for(task, timeout=15)

        asyncio.run(drive())
        self.assertEqual([], sent, "a client that left before the response started must not be answered")
        self.assertTrue(producer.closed, "the release must reach the producer when nobody is left to answer")


class ASGIReceiveFailureTests(unittest.TestCase):
    """A `receive()` that raises must not disturb a response that is already under way.

    ADV-W1B-R1-01: the disconnect watcher dies with the channel's exception. Awaiting it in the
    wrapper's `finally` then re-raised that exception after a delivery that had completed — the
    server saw a spurious error for a response it had been given in full — and, worse, replaced an
    exception already on its way out of the request. The watcher's failure is the watcher's problem:
    the wrapper logs it and lets the response's own outcome stand.
    """

    def test_a_raising_receive_channel_leaves_a_completed_delivery_alone(self) -> None:
        producer = _Producer([b"one\n", b"two\n"])
        app = App()
        app.get("/stream", lambda _ctx: html_stream(200, producer))
        sent, _, send = _collector()

        # A completed delivery: the body is written in full, the producer is released, and the
        # channel's failure must not surface as an error from the application.
        asyncio.run(ASGIApp(app)(_scope("GET", "/stream"), _RaisingReceiver(), send))
        self.assertEqual(b"one\ntwo\n", _body(sent), "the response was not delivered in full")
        self.assertTrue(producer.closed, "the delivery must release the producer")
        starts = [message for message in sent if message["type"] == "http.response.start"]
        self.assertEqual(1, len(starts), "the response was started more than once")

        # An in-flight failure: the send fails mid-response while the watcher is also failing. The
        # send's exception is the request's outcome; the watcher must not mask it.
        in_flight = _Producer([b"one\n", b"two\n"])
        app = App()
        app.get("/stream", lambda _ctx: html_stream(200, in_flight))

        async def failing_send(message: dict) -> None:
            if message["type"] == "http.response.body":
                raise ConnectionError("the transport is gone")
            sent.append(message)

        with self.assertRaises(ConnectionError):
            asyncio.run(ASGIApp(app)(_scope("GET", "/stream"), _RaisingReceiver(), failing_send))
        self.assertTrue(in_flight.closed, "a failed send must still release the producer")

    def test_the_warning_names_the_exception_type_and_carries_none_of_its_text(self) -> None:
        """The warning identifies the failure without copying what it was holding. (SAN-AT-W1B-06)

        A `receive()` channel is server code, and the exception it raises is free to describe the
        request it was serving — the path, a query string, a header. The wrapper's warning used to
        log `str(exc)`: percent-encoded, so it could not forge a log field, but the request-shaped
        text was still recoverable from the log. The type name is the whole report now.
        """
        marker = "REQLIKE-MARKER-9f3c"
        text = f"GET /admin/tenants?token={marker}"
        producer = _Producer([b"one\n"])
        app = App()
        app.get("/stream", lambda _ctx: html_stream(200, producer))
        sent, _, send = _collector()

        with self.assertLogs("apptheory.serving", level="WARNING") as captured:
            asyncio.run(
                ASGIApp(app)(_scope("GET", "/stream"), _RaisingReceiver(_RequestLikeError(text)), send)
            )
        log = "\n".join(captured.output)

        self.assertIn(
            "_RequestLikeError",
            log,
            f"the warning does not name the failing exception's type: {log!r}",
        )
        self.assertNotIn(
            marker,
            log,
            f"the warning copied the exception's own text into the log: {log!r}",
        )
        self.assertNotIn(
            log_safe_value(text),
            log,
            f"the warning logged the exception's message in its percent-encoded form: {log!r}",
        )
        self.assertNotIn("admin", log, f"the warning carries request-shaped text from the exception: {log!r}")
        self.assertEqual(b"one\n", _body(sent), "the response was not delivered in full")
        self.assertTrue(producer.closed, "the delivery must release the producer")

    def test_a_warning_that_cannot_be_formatted_neither_escapes_nor_masks_a_send_error(self) -> None:
        """Reporting a failure must not become one. (SAN-AT-W1B-06)

        The warning runs in the wrapper's `finally`, where an exception raised by *formatting* would
        take the request's outcome: it escaped after a delivery that had completed, and it replaced
        an in-flight `ConnectionError` with the formatter's own error. An exception whose `str()`
        raises is the case that produced both, so both are driven here.
        """
        completed = _Producer([b"one\n", b"two\n"])
        app = App()
        app.get("/stream", lambda _ctx: html_stream(200, completed))
        sent, _, send = _collector()

        with self.assertLogs("apptheory.serving", level="WARNING") as captured:
            asyncio.run(ASGIApp(app)(_scope("GET", "/stream"), _RaisingReceiver(_UnstringableError()), send))
        self.assertEqual(b"one\ntwo\n", _body(sent), "the delivery must survive the watcher's failure")
        self.assertTrue(completed.closed, "the delivery must release the producer")
        self.assertIn(
            "_UnstringableError",
            "\n".join(captured.output),
            "an exception that cannot describe itself must still be named by type",
        )

        in_flight = _Producer([b"one\n", b"two\n"])
        app = App()
        app.get("/stream", lambda _ctx: html_stream(200, in_flight))

        async def failing_send(message: dict) -> None:
            if message["type"] == "http.response.body":
                raise ConnectionError("the transport is gone")

        with self.assertLogs("apptheory.serving", level="WARNING"):
            with self.assertRaises(ConnectionError):
                asyncio.run(
                    ASGIApp(app)(_scope("GET", "/stream"), _RaisingReceiver(_UnstringableError()), failing_send)
                )
        self.assertTrue(in_flight.closed, "a failed send must still release the producer")


class ASGIConcurrencyTests(unittest.TestCase):
    """Overlapping requests share one event loop and still keep their own state."""

    def test_two_overlapping_requests_keep_their_own_state(self) -> None:
        first_started = threading.Event()
        release = threading.Event()

        def handler(ctx: Context) -> Response:
            tag = ctx.request.query["tag"][0]
            if tag == "first":
                first_started.set()
                release.wait(15)
            else:
                # The second request only reaches here while the first one is still in flight: a
                # wrapper that ran the handler on the loop would never get this far.
                first_started.wait(15)
                release.set()
            return text(200, tag)

        app = App()
        app.get("/stream", handler)
        asgi = ASGIApp(app)

        async def overlap() -> list[bytes]:
            tags = ("first", "second")
            sends = {tag: _collector() for tag in tags}

            async def one(tag: str) -> None:
                _, _, send = sends[tag]
                await asgi(_scope("GET", "/stream", f"tag={tag}"), _Receiver(), send)

            await asyncio.wait_for(asyncio.gather(*(one(tag) for tag in tags)), timeout=20)
            return [_body(sends[tag][0]) for tag in tags]

        bodies = asyncio.run(overlap())
        self.assertEqual([b"first", b"second"], bodies, "one request read another's state")

    def test_an_async_handler_is_resolved_off_the_event_loop(self) -> None:
        async def handler(_ctx: Context) -> Response:
            await asyncio.sleep(0)
            return text(200, "async ok")

        app = App()
        app.get("/", handler)
        sent = _drive(ASGIApp(app), _scope("GET", "/"), _Receiver())
        self.assertEqual(b"async ok", _body(sent))

    def test_the_handler_runs_on_a_worker_thread_and_never_on_the_event_loop(self) -> None:
        """The property that keeps awaitable resolution legal.

        ``App.serve`` resolves ``async def`` handlers with ``asyncio.run``, which raises when the
        calling thread already has a running loop. The entry point therefore enters ``serve`` from a
        worker thread, and this asserts the thread actually differs from the loop's.
        """
        loop_thread = threading.get_ident()
        seen: dict[str, int] = {}

        def handler(_ctx: Context) -> Response:
            seen["thread"] = threading.get_ident()
            return text(200, "ok")

        app = App()
        app.get("/", handler)
        _drive(ASGIApp(app), _scope("GET", "/"), _Receiver())
        self.assertIn("thread", seen)
        self.assertNotEqual(loop_thread, seen["thread"], "the handler ran on the event loop thread")


class ASGIWrapperContractTests(unittest.TestCase):
    """The wrapper refuses a runtime it cannot serve."""

    def test_a_runtime_without_serve_is_refused(self) -> None:
        with self.assertRaises(RuntimeError) as raised:
            ASGIApp(object())
        self.assertIn("AppTheory runtime with serve(request) is required", str(raised.exception))
        with self.assertRaises(RuntimeError):
            WSGIApp(object())


def _environ(
    method: str = "GET",
    path: str = "/",
    query: str = "",
    headers: dict[str, str] | None = None,
    body: bytes = b"",
) -> dict:
    environ: dict = {
        "REQUEST_METHOD": method,
        "SCRIPT_NAME": "",
        "PATH_INFO": path,
        "QUERY_STRING": query,
        "SERVER_PROTOCOL": "HTTP/1.1",
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": "https",
        "wsgi.input": __import__("io").BytesIO(body),
        "wsgi.errors": sys.stderr,
        "wsgi.multithread": True,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
    }
    if body:
        environ["CONTENT_LENGTH"] = str(len(body))
    environ.update(headers or {})
    return environ


class _Producer:
    """A stream produced outside AppTheory, which records the close the adapter forwards."""

    def __init__(self, chunks: list[bytes] | None = None) -> None:
        self._chunks = list(chunks if chunks is not None else [b"one\n", b"two\n"])
        self.closed = False

    def __iter__(self) -> _Producer:
        return self

    def __next__(self) -> bytes:
        if not self._chunks:
            raise StopIteration
        return self._chunks.pop(0)

    def close(self) -> None:
        self.closed = True


class WSGITests(unittest.TestCase):
    """The WSGI wrapper maps a WSGI request onto the runtime and streams the response."""

    def test_request_and_response_round_trip(self) -> None:
        seen: dict[str, object] = {}

        def handler(ctx: Context) -> Response:
            seen["method"] = ctx.request.method
            seen["path"] = ctx.request.path
            seen["query"] = ctx.request.query
            seen["header"] = ctx.request.headers.get("x-tag")
            seen["body"] = ctx.request.body
            return text(201, "created")

        app = App()
        app.post("/items", handler)
        started: list[tuple[str, list[tuple[str, str]]]] = []
        body = b"".join(
            WSGIApp(app)(
                _environ("POST", "/items", "tag=first", {"HTTP_X_TAG": "overlap"}, body=b'{"a":1}'),
                lambda status, headers: started.append((status, headers)),
            )
        )

        self.assertEqual("POST", seen["method"])
        self.assertEqual("/items", seen["path"])
        self.assertEqual({"tag": ["first"]}, seen["query"])
        self.assertEqual(["overlap"], seen["header"])
        self.assertEqual(b'{"a":1}', seen["body"])
        self.assertEqual("201 Created", started[0][0])
        self.assertIn(("content-length", "7"), started[0][1])
        self.assertEqual(b"created", body)

    def test_a_streamed_body_is_returned_as_a_closable_iterable(self) -> None:
        released: list[str] = []

        def chunks():
            try:
                yield b"one\n"
                yield b"two\n"
            finally:
                released.append("closed")

        app = App()
        app.get("/stream", lambda _ctx: html_stream(200, chunks()))
        started: list[tuple[str, list[tuple[str, str]]]] = []
        iterable = WSGIApp(app)(_environ("GET", "/stream"), lambda status, headers: started.append((status, headers)))

        self.assertEqual("200 OK", started[0][0])
        self.assertFalse([name for name, _ in started[0][1] if name == "content-length"])
        self.assertEqual([b"one\n", b"two\n"], list(iterable))

        producer = _Producer()
        app2 = App()
        app2.get("/stream", lambda _ctx: html_stream(200, producer))
        stream = WSGIApp(app2)(_environ("GET", "/stream"), lambda _status, _headers: None)
        next(iter(stream))
        stream.close()  # type: ignore[attr-defined]
        self.assertTrue(producer.closed, "close must reach the producer")

    def test_a_head_request_returns_no_body(self) -> None:
        producer = _Producer()
        app = App()
        app.handle("HEAD", "/stream", lambda _ctx: html_stream(200, producer))
        iterable = WSGIApp(app)(_environ("HEAD", "/stream"), lambda _status, _headers: None)
        self.assertEqual([], list(iterable))
        self.assertTrue(producer.closed, "a head request must still release the producer")

    def test_a_declared_body_that_ends_early_is_refused(self) -> None:
        app = App()
        app.post("/items", lambda _ctx: text(200, "ok"))
        environ = _environ("POST", "/items")
        environ["CONTENT_LENGTH"] = "10"
        with self.assertRaises(ValueError) as raised:
            WSGIApp(app)(environ, lambda _status, _headers: None)
        self.assertIn("request body ended after 0 of 10 bytes", str(raised.exception))

    def test_an_invalid_content_length_is_refused(self) -> None:
        app = App()
        app.post("/items", lambda _ctx: text(200, "ok"))
        environ = _environ("POST", "/items")
        environ["CONTENT_LENGTH"] = "ten"
        with self.assertRaises(ValueError) as raised:
            WSGIApp(app)(environ, lambda _status, _headers: None)
        self.assertIn("invalid CONTENT_LENGTH 'ten'", str(raised.exception))


class ServingImportTests(unittest.TestCase):
    """Both entry points are exported from the package root, where an entry module imports them."""

    def test_the_package_root_exports_both_entry_points(self) -> None:
        import apptheory

        self.assertIs(apptheory.ASGIApp, ASGIApp)
        self.assertIs(apptheory.WSGIApp, WSGIApp)
        self.assertIn("ASGIApp", apptheory.__all__)
        self.assertIn("WSGIApp", apptheory.__all__)


if __name__ == "__main__":
    unittest.main()
