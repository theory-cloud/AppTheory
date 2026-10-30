from __future__ import annotations

import sys
import threading
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

import apptheory  # noqa: E402
import apptheory.aws_http as aws_http  # noqa: E402
from apptheory.context import Context  # noqa: E402
from apptheory.errors import AppError  # noqa: E402
from apptheory.middleware import TimeoutConfig, timeout_middleware  # noqa: E402
from apptheory.request import Request  # noqa: E402
from apptheory.response import html_stream  # noqa: E402

# This file proves the invocation-scope invariant for the Python runtime: a
# thread the runtime starts to produce or consume a response body has finished
# before the adapter that owns it returns, so no work outlives the Lambda
# invocation that started it. The join is bounded: a producer that does not
# respond to cancellation is not detached and not claimed terminated, and the
# Lambda function timeout remains its outer bound.

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

    It models a source blocked inside a call it does not leave. The adapter's
    join for the worker is bounded, so it returns once the unwind grace elapses
    even though the worker is still blocked; the invocation (not the adapter)
    bounds such a body.
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
        # A bounded drain can leave an uninterruptible worker as its documented
        # residual; this is a belt-and-braces wait so the process is clean for the
        # next test.
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

    def test_adapter_bounds_its_wait_for_an_uninterruptible_body(self) -> None:
        # The canonicalized response wraps the handler's stream in a generator,
        # which cannot be closed while it is executing, so the worker only exits
        # when the source releases it. The adapter's join is bounded: it must
        # return once the unwind grace elapses rather than hold the invocation
        # open for a worker that does not settle.
        body = _UninterruptibleBlockingBody()
        out: dict[str, object] = {}

        def run() -> None:
            out["response"] = aws_http.apigw_v2_response_from_response(html_stream(200, body))

        caller = threading.Thread(target=run, daemon=True)
        started = time.monotonic()
        caller.start()
        caller.join(timeout=5.0)
        elapsed = time.monotonic() - started

        self.assertFalse(
            caller.is_alive(),
            "the adapter held the invocation open for an uninterruptible body",
        )
        self.assertLess(
            elapsed,
            1.5,
            "the bounded adapter did not return within its budget plus unwind grace",
        )
        self.assertEqual(out["response"]["statusCode"], 500)
        self.assertFalse(body.unwound.is_set(), "the uninterruptible worker settled unexpectedly")

        # The blocked worker is the documented residual; releasing it lets it
        # exit, so nothing outlives the test.
        body.release.set()
        self.assertTrue(body.unwound.wait(timeout=2.0))
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
    def test_timeout_middleware_returns_an_ordinary_result(self) -> None:
        mw = timeout_middleware(TimeoutConfig(default_timeout_ms=1000))
        ctx = Context(request=Request(method="GET", path="/"))

        self.assertEqual(mw(ctx, lambda _ctx: "ok"), "ok")
        self.assertEqual([t for t in threading.enumerate() if t.name == _TIMEOUT_THREAD_NAME], [])

    def test_timeout_middleware_reports_the_timeout_after_the_handler_unwinds(self) -> None:
        mw = timeout_middleware(TimeoutConfig(default_timeout_ms=10, timeout_message="too slow"))
        ctx = Context(request=Request(method="GET", path="/"))

        unwound = threading.Event()

        def cooperative(handler_ctx: Context):
            # Observes the deadline-bearing cancellation token and unwinds at the
            # deadline, so the middleware reports the timeout afterwards.
            carrier = getattr(handler_ctx, "ctx", None)
            cancelled = getattr(carrier, "cancelled", None)
            if cancelled is not None:
                cancelled.wait(timeout=2.0)
            unwound.set()
            return "late"

        with self.assertRaises(AppError) as cm:
            mw(ctx, cooperative)

        self.assertEqual(cm.exception.code, "app.timeout")
        # The handler runs on the invoking thread, so the middleware cannot
        # report the timeout before the handler has unwound.
        self.assertTrue(unwound.is_set(), "the middleware reported the timeout before the handler unwound")
        self.assertEqual([t for t in threading.enumerate() if t.name == _TIMEOUT_THREAD_NAME], [])

    def test_timeout_middleware_waits_for_a_handler_that_ignores_cancellation(self) -> None:
        mw = timeout_middleware(TimeoutConfig(default_timeout_ms=5, timeout_message="too slow"))
        ctx = Context(request=Request(method="GET", path="/"))

        started = threading.Event()
        release = threading.Event()
        finished = threading.Event()
        returned = threading.Event()
        errors: list[BaseException] = []

        def uncooperative(_ctx: Context):
            # Ignores the cancellation token: the middleware must not return
            # until this handler exits, so it cannot produce an early timeout or
            # a post-return side effect.
            started.set()
            release.wait()
            finished.set()
            return "late"

        def call() -> None:
            try:
                mw(ctx, uncooperative)
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)
            finally:
                returned.set()

        caller = threading.Thread(target=call, name="apptheory-timeout-test", daemon=True)
        caller.start()
        self.assertTrue(started.wait(timeout=2.0), "the middleware never ran the handler")

        # The deadline is 5 ms and the handler ignores it: the middleware must
        # keep waiting instead of raising while the handler still runs. The wait
        # is well past the removal's old 250 ms grace window, so only inline
        # execution holds here.
        self.assertFalse(
            returned.wait(timeout=0.5),
            "the middleware returned while the handler it timed out was still running",
        )
        self.assertFalse(finished.is_set(), "the handler ran its side effect before it was released")

        release.set()
        self.assertTrue(returned.wait(timeout=2.0), "the middleware did not return after the handler exited")
        caller.join(timeout=2.0)
        self.assertFalse(caller.is_alive(), "the middleware call thread outlived its invocation")

        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], AppError)
        self.assertEqual(errors[0].code, "app.timeout")
        self.assertTrue(finished.is_set(), "the middleware returned before the handler it timed out finished")
        self.assertEqual([t for t in threading.enumerate() if t.name == _TIMEOUT_THREAD_NAME], [])

    def test_timeout_middleware_holds_the_api_gateway_v2_adapter_until_the_handler_exits(self) -> None:
        app = apptheory.create_app(tier="p0")
        app.use(timeout_middleware(TimeoutConfig(default_timeout_ms=5, timeout_message="too slow")))

        started = threading.Event()
        release = threading.Event()
        finished = threading.Event()

        def handler(_ctx: Context):
            started.set()
            release.wait()
            finished.set()
            return apptheory.text(200, "late")

        app.get("/held", handler)

        result: list[dict] = []

        def call() -> None:
            result.append(
                app.serve_apigw_v2(
                    {
                        "version": "2.0",
                        "rawPath": "/held",
                        "rawQueryString": "",
                        "headers": {},
                        "requestContext": {"http": {"method": "GET", "path": "/held"}},
                        "body": "",
                        "isBase64Encoded": False,
                    }
                )
            )

        caller = threading.Thread(target=call, name="apptheory-timeout-adapter-test", daemon=True)
        caller.start()
        self.assertTrue(started.wait(timeout=2.0), "the adapter never ran the handler")

        # The deadline is 5 ms and the old middleware gave up after a 250 ms
        # grace window: wait past both, with the handler still held, to prove the
        # adapter cannot return while the handler can still write.
        time.sleep(0.5)
        self.assertFalse(result, "the adapter returned while the handler it timed out was still running")
        self.assertFalse(finished.is_set())

        release.set()
        caller.join(timeout=2.0)
        self.assertFalse(caller.is_alive(), "the adapter call thread outlived its invocation")

        self.assertEqual(len(result), 1)
        out = result[0]
        self.assertEqual(out["statusCode"], 408)
        self.assertIn("app.timeout", out["body"])
        self.assertTrue(finished.is_set(), "the adapter returned before the handler it timed out finished")
        self.assertEqual([t for t in threading.enumerate() if t.name == _TIMEOUT_THREAD_NAME], [])


if __name__ == "__main__":
    unittest.main()
