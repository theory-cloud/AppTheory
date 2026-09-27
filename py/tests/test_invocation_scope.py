from __future__ import annotations

import sys
import threading
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

import apptheory.aws_http as aws_http  # noqa: E402
from apptheory.context import Context  # noqa: E402
from apptheory.errors import AppError  # noqa: E402
from apptheory.middleware import TimeoutConfig, timeout_middleware  # noqa: E402
from apptheory.request import Request  # noqa: E402
from apptheory.response import html_stream  # noqa: E402

# This file proves the invocation-scope invariant for the Python runtime: a
# thread the runtime starts to produce or consume a response body must have
# finished before the adapter that owns it returns, so no work outlives the
# Lambda invocation that started it.

_DRAIN_THREAD_NAME = "apptheory-v2-streaming-drain"


def _worker_threads() -> list[threading.Thread]:
    return [t for t in threading.enumerate() if t.name == _DRAIN_THREAD_NAME]


class _InterruptibleBlockingBody:
    """A body whose blocked read is released by ``close``.

    The runtime closes a body it abandons, and every runtime-produced body is
    interruptible, so the drain worker can always exit.
    """

    def __init__(self) -> None:
        self.first = True
        self.closed = threading.Event()
        self.release = threading.Event()
        self.unwound = threading.Event()

    def __iter__(self) -> _InterruptibleBlockingBody:
        return self

    def __next__(self) -> bytes:
        if self.first:
            self.first = False
            return b"data: first\n\n"
        self.release.wait()
        if self.closed.is_set():
            self.unwound.set()
            raise StopIteration
        return b"data: more\n\n"

    def close(self) -> None:
        self.closed.set()
        self.release.set()


class _UninterruptibleBlockingBody:
    """A body whose blocked read cannot be released by ``close``.

    It models a source blocked inside a call it does not leave. The adapter's
    wait for the worker must stay bounded for such a body.
    """

    def __init__(self) -> None:
        self.first = True
        self.release = threading.Event()

    def __iter__(self) -> _UninterruptibleBlockingBody:
        return self

    def __next__(self) -> bytes:
        if self.first:
            self.first = False
            return b"data: first\n\n"
        self.release.wait()
        raise StopIteration

    def close(self) -> None:
        return


class TestStreamingDrainScope(unittest.TestCase):
    def setUp(self) -> None:
        self._old_timeout = aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT
        aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT = 0.2

    def tearDown(self) -> None:
        aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT = self._old_timeout
        # A test that leaves an uninterruptible worker blocked would poison the
        # thread assertions in later tests, so release every worker here.
        deadline = time.monotonic() + 2.0
        while _worker_threads() and time.monotonic() < deadline:
            time.sleep(0.01)

    def test_drain_joins_the_worker_it_abandons(self) -> None:
        body = _InterruptibleBlockingBody()
        with self.assertRaises(aws_http._StreamingBodyBudgetError):
            aws_http._drain_streaming_body(body, aws_http._APIGATEWAY_V2_STREAMING_BODY_MAX_BYTES, 0.2)

        self.assertTrue(body.unwound.is_set(), "the abandoned read was not unwound before returning")
        self.assertEqual(_worker_threads(), [], "drain worker outlived the adapter")

    def test_adapter_bounds_an_uninterruptible_body(self) -> None:
        # The canonicalized response wraps the handler's stream in a generator,
        # which cannot be closed while it is executing, so the adapter's wait for
        # the worker stays bounded instead of holding the invocation open.
        body = _UninterruptibleBlockingBody()
        started = time.monotonic()
        out = aws_http.apigw_v2_response_from_response(html_stream(200, body))
        elapsed = time.monotonic() - started

        self.assertEqual(out["statusCode"], 500)
        self.assertLess(elapsed, 2.0, "adapter held the invocation on an uninterruptible body")

        # Releasing the source lets the abandoned worker finish, so it does not
        # outlive the test process.
        body.release.set()
        deadline = time.monotonic() + 2.0
        while _worker_threads() and time.monotonic() < deadline:
            time.sleep(0.01)

    def test_terminating_body_starts_no_worker_behind_the_adapter(self) -> None:
        def gen():
            yield b"data: first\n\n"
            yield b"data: second\n\n"

        out = aws_http.apigw_v2_response_from_response(html_stream(200, gen()))

        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(out["body"], "data: first\n\ndata: second\n\n")
        self.assertEqual(_worker_threads(), [], "drain worker outlived a terminated body")


class TestTimeoutMiddlewareScope(unittest.TestCase):
    def test_timeout_middleware_joins_a_cooperative_handler(self) -> None:
        mw = timeout_middleware(TimeoutConfig(default_timeout_ms=5, timeout_message="too slow"))
        ctx = Context(request=Request(method="GET", path="/"))

        finished = threading.Event()

        def cooperative(handler_ctx: Context):
            carrier = getattr(handler_ctx, "ctx", None)
            cancelled = getattr(carrier, "cancelled", None)
            if isinstance(cancelled, threading.Event):
                cancelled.wait(timeout=2.0)
            finished.set()
            return "cancelled"

        started = time.monotonic()
        with self.assertRaises(AppError) as cm:
            mw(ctx, cooperative)
        elapsed = time.monotonic() - started

        self.assertEqual(cm.exception.code, "app.timeout")
        self.assertTrue(finished.is_set(), "the middleware returned while its handler was still running")
        self.assertLess(elapsed, 1.0, "cooperative cancellation did not release the invocation promptly")

    def test_timeout_middleware_bounds_a_handler_that_ignores_cancellation(self) -> None:
        mw = timeout_middleware(TimeoutConfig(default_timeout_ms=5, timeout_message="too slow"))
        ctx = Context(request=Request(method="GET", path="/"))

        release = threading.Event()
        handler_finished = threading.Event()

        def uncooperative(_ctx: Context):
            release.wait()
            handler_finished.set()
            return "late"

        started = time.monotonic()
        with self.assertRaises(AppError) as cm:
            mw(ctx, uncooperative)
        elapsed = time.monotonic() - started

        self.assertEqual(cm.exception.code, "app.timeout")
        self.assertLess(elapsed, 1.0, "the timeout response waited for the handler's full runtime")
        self.assertFalse(handler_finished.is_set())

        release.set()


if __name__ == "__main__":
    unittest.main()
