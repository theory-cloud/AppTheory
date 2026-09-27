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
# thread the runtime starts to produce or consume a response body has finished
# before the adapter that owns it returns, so no work outlives the Lambda
# invocation that started it. There is no grace window that ends in abandoning a
# worker.

_DRAIN_THREAD_NAME = "apptheory-v2-streaming-drain"
_TIMEOUT_THREAD_NAME = "apptheory-timeout-handler"


def _worker_threads() -> list[threading.Thread]:
    return [t for t in threading.enumerate() if t.name == _DRAIN_THREAD_NAME]


def _remaining_worker_threads(deadline: float) -> int:
    while _worker_threads() and time.monotonic() < deadline:
        time.sleep(0.01)
    return len(_worker_threads())


class _InterruptibleBlockingBody:
    """A body whose blocked read is released by ``close``.

    The runtime closes a body it abandons, and every runtime-produced body is
    interruptible, so the drain worker can always exit and be joined.
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

    It models a source blocked inside a call it does not leave. The adapter must
    still not return while the drain worker reads it, so the wait for the worker
    is unconditional and the invocation (not the adapter) bounds such a body.
    """

    def __init__(self) -> None:
        self.first = True
        self.release = threading.Event()
        self.unwound = threading.Event()

    def __iter__(self) -> _UninterruptibleBlockingBody:
        return self

    def __next__(self) -> bytes:
        if self.first:
            self.first = False
            return b"data: first\n\n"
        self.release.wait()
        self.unwound.set()
        raise StopIteration

    def close(self) -> None:
        return


class TestStreamingDrainScope(unittest.TestCase):
    def setUp(self) -> None:
        self._old_timeout = aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT
        aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT = 0.2

    def tearDown(self) -> None:
        aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT = self._old_timeout
        # The adapter now joins its worker unconditionally, so no worker may be
        # left behind; this is a belt-and-braces check that the process is clean
        # for the next test.
        _remaining_worker_threads(time.monotonic() + 2.0)

    def test_drain_joins_the_worker_it_abandons(self) -> None:
        workers_before = len(_worker_threads())
        body = _InterruptibleBlockingBody()
        with self.assertRaises(aws_http._StreamingBodyBudgetError):
            aws_http._drain_streaming_body(body, aws_http._APIGATEWAY_V2_STREAMING_BODY_MAX_BYTES, 0.2)

        self.assertTrue(body.unwound.is_set(), "the abandoned read was not unwound before returning")
        self.assertLessEqual(
            len(_worker_threads()),
            workers_before,
            "drain worker outlived the adapter",
        )

    def test_adapter_waits_for_an_uninterruptible_body(self) -> None:
        # The canonicalized response wraps the handler's stream in a generator,
        # which cannot be closed while it is executing, so the worker only exits
        # when the source releases it. The adapter must wait for that instead of
        # returning while the worker still reads.
        body = _UninterruptibleBlockingBody()
        out: dict[str, object] = {}

        def run() -> None:
            out["response"] = aws_http.apigw_v2_response_from_response(html_stream(200, body))

        caller = threading.Thread(target=run, daemon=True)
        started = time.monotonic()
        caller.start()

        # Past the drain budget the adapter has closed the body and is waiting
        # for the worker; it must not have returned yet.
        caller.join(timeout=0.5)
        self.assertTrue(
            caller.is_alive(),
            "the adapter returned while the drain worker could still run",
        )

        body.release.set()
        caller.join(timeout=2.0)
        self.assertFalse(caller.is_alive(), "the adapter never returned after the body was released")

        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 0.4, "the adapter returned before its drain budget expired")
        self.assertEqual(out["response"]["statusCode"], 500)
        self.assertTrue(body.unwound.is_set())
        self.assertEqual(_remaining_worker_threads(time.monotonic() + 2.0), 0)

    def test_terminating_body_starts_no_worker_behind_the_adapter(self) -> None:
        def gen():
            yield b"data: first\n\n"
            yield b"data: second\n\n"

        workers_before = len(_worker_threads())
        out = aws_http.apigw_v2_response_from_response(html_stream(200, gen()))

        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(out["body"], "data: first\n\ndata: second\n\n")
        self.assertLessEqual(
            len(_worker_threads()),
            workers_before,
            "drain worker outlived a terminated body",
        )


class TestBufferedAdapterScopes(unittest.TestCase):
    """The ALB and buffered API Gateway REST v1 adapters drain and join bodies."""

    def setUp(self) -> None:
        self._old_timeout = aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT
        aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT = 0.2

    def tearDown(self) -> None:
        aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT = self._old_timeout

    def test_alb_and_v1_deliver_a_terminating_body(self) -> None:
        def gen():
            yield b"streamed body"

        alb = aws_http.alb_target_group_response_from_response(html_stream(200, gen()))
        self.assertEqual(alb["statusCode"], 200)
        self.assertEqual(alb["body"], "streamed body")

        def gen2():
            yield b"streamed body"

        v1 = aws_http.apigw_proxy_response_from_response(html_stream(200, gen2()))
        self.assertEqual(v1["statusCode"], 200)
        self.assertEqual(v1["body"], "streamed body")

    def test_alb_and_v1_join_an_interruptible_body(self) -> None:
        body = _InterruptibleBlockingBody()
        alb = aws_http.alb_target_group_response_from_response(html_stream(200, body))
        self.assertEqual(alb["statusCode"], 500)
        self.assertTrue(body.unwound.is_set(), "the ALB adapter abandoned its drain worker")
        self.assertEqual(_remaining_worker_threads(time.monotonic() + 2.0), 0)

        body = _InterruptibleBlockingBody()
        v1 = aws_http.apigw_proxy_response_from_response(html_stream(200, body))
        self.assertEqual(v1["statusCode"], 500)
        self.assertTrue(body.unwound.is_set(), "the buffered v1 adapter abandoned its drain worker")
        self.assertEqual(_remaining_worker_threads(time.monotonic() + 2.0), 0)


class TestTimeoutMiddlewareScope(unittest.TestCase):
    def test_timeout_middleware_runs_the_handler_on_the_invoking_thread(self) -> None:
        mw = timeout_middleware(TimeoutConfig(default_timeout_ms=5, timeout_message="too slow"))
        ctx = Context(request=Request(method="GET", path="/"))

        handled_on: list[int] = []
        invoking = threading.get_ident()

        def cooperative(handler_ctx: Context):
            handled_on.append(threading.get_ident())
            carrier = getattr(handler_ctx, "ctx", None)
            cancelled = getattr(carrier, "cancelled", None)
            if cancelled is not None:
                cancelled.wait(timeout=2.0)
            return "cancelled"

        started = time.monotonic()
        with self.assertRaises(AppError) as cm:
            mw(ctx, cooperative)
        elapsed = time.monotonic() - started

        self.assertEqual(cm.exception.code, "app.timeout")
        self.assertEqual(handled_on, [invoking], "the timeout middleware ran the handler on another thread")
        self.assertLess(elapsed, 1.0, "cooperative cancellation did not release the invocation promptly")
        self.assertEqual([t for t in threading.enumerate() if t.name == _TIMEOUT_THREAD_NAME], [])

    def test_timeout_middleware_never_abandons_a_handler_that_ignores_cancellation(self) -> None:
        mw = timeout_middleware(TimeoutConfig(default_timeout_ms=5, timeout_message="too slow"))
        ctx = Context(request=Request(method="GET", path="/"))

        side_effect = threading.Event()

        def uncooperative(_ctx: Context):
            # Ignores the cancellation token: it runs to completion on the
            # invoking thread, so its side effect is inside the invocation and
            # the middleware reports the timeout afterwards.
            time.sleep(0.05)
            side_effect.set()
            return "late"

        started = time.monotonic()
        with self.assertRaises(AppError) as cm:
            mw(ctx, uncooperative)
        elapsed = time.monotonic() - started

        self.assertEqual(cm.exception.code, "app.timeout")
        self.assertGreaterEqual(elapsed, 0.05, "the middleware returned before the handler finished")
        self.assertTrue(side_effect.is_set(), "the handler it timed out was abandoned")
        self.assertEqual([t for t in threading.enumerate() if t.name == _TIMEOUT_THREAD_NAME], [])


if __name__ == "__main__":
    unittest.main()
