from __future__ import annotations

import json
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

import apptheory.aws_http as aws_http  # noqa: E402
from apptheory.app import Limits, create_app  # noqa: E402
from apptheory.aws_http import (  # noqa: E402
    _APIGATEWAY_V2_STREAMING_BODY_MAX_BYTES,
    _STREAMING_BODY_MAX_CHUNKS,
    apigw_v2_response_from_response,
    build_apigw_v2_request,
    build_lambda_function_url_request,
    lambda_function_url_response_from_response,
)
from apptheory.response import Response, html_stream  # noqa: E402

V2_ERROR_MESSAGE = "streaming response body cannot be delivered by the HTTP API v2 adapter"
URL_ERROR_MESSAGE = "streaming response body cannot be delivered by the Function URL adapter"


def _terminating_stream(first: bytes, second: bytes = b""):
    def gen():
        yield first
        if second:
            yield second

    return gen()


class _CooperativeSpyStream:
    """A blocking body stream that records the adapter's release hooks.

    It yields one chunk and then blocks until released by ``cancel``, so only a
    cooperative cancel lets the drain worker settle within the unwind grace.
    """

    def __init__(self, first: bytes) -> None:
        self.release = threading.Event()
        self.close_calls = 0
        self.cancel_calls = 0
        self.iterations = 0
        self._first = first
        self._sent = False

    def __iter__(self) -> _CooperativeSpyStream:
        return self

    def __next__(self) -> bytes:
        self.iterations += 1
        if not self._sent:
            self._sent = True
            return self._first
        self.release.wait(timeout=5.0)
        raise StopIteration

    def close(self) -> None:
        self.close_calls += 1

    def cancel(self) -> None:
        self.cancel_calls += 1
        self.release.set()


class _AsyncCloseSpyStream(_CooperativeSpyStream):
    """A blocking body stream whose only cooperative hook is async ``aclose``."""

    def __init__(self, first: bytes) -> None:
        super().__init__(first)
        self.aclose_calls = 0

    def cancel(self) -> None:
        return None

    async def aclose(self) -> None:
        self.aclose_calls += 1
        self.release.set()


class _EmptyChunkForeverStream:
    """A body stream that yields empty chunks forever and counts its reads."""

    def __init__(self) -> None:
        self.iterations = 0

    def __iter__(self) -> _EmptyChunkForeverStream:
        return self

    def __next__(self) -> bytes:
        self.iterations += 1
        return b""


def _wait_for_drain_workers(testcase: unittest.TestCase, expected: int, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    live = aws_http._live_streaming_body_drain_workers()
    while live != expected and time.monotonic() < deadline:
        time.sleep(0.005)
        live = aws_http._live_streaming_body_drain_workers()
    testcase.assertEqual(live, expected, f"expected {expected} live drain worker(s), found {live}")


def _live_stream(first: bytes):
    """A live listener that never terminates on its own.

    It does not race its own unwind, so asking it to unwind cannot complete until
    it is released. That is exactly the body whose producer cannot be
    interrupted: the adapter's join is bounded, so it returns at its budget plus
    the unwind grace while this body is still blocked, and the test releases it
    afterwards to confirm the residual producer exits.
    """
    release = threading.Event()
    unwound = threading.Event()

    def gen():
        try:
            yield first
            release.wait()
            yield b"data: more\n\n"
        finally:
            unwound.set()

    return gen(), release, unwound


def _assert_live_body_bounded(
    testcase: unittest.TestCase,
    out: dict,
    message: str,
    unwound: threading.Event,
    release: threading.Event,
) -> None:
    _assert_streaming_error(testcase, out, message)
    # The body ignores release, so the drain worker survives the grace window and
    # must stay tracked as an abandoned worker instead of being claimed settled.
    testcase.assertGreaterEqual(
        aws_http._live_streaming_body_drain_workers(),
        1,
        "an abandoned drain worker must stay tracked while it is still alive",
    )
    # The adapter's join is bounded, so it returns at its budget plus the unwind
    # grace without waiting for the live body, which is still blocked.
    testcase.assertFalse(
        unwound.is_set(),
        "the adapter waited for the live body instead of returning at its bound",
    )
    # The blocked producer is the documented residual; releasing it lets it exit.
    release.set()
    testcase.assertTrue(unwound.wait(timeout=5.0), "the live body's producer was never released")
    _wait_for_drain_workers(testcase, 0)


def _error_stream():
    def gen():
        yield b"data: first\n\n"
        raise RuntimeError("stream exploded")

    return gen()


def _streaming_response(stream) -> Response:
    return html_stream(200, stream)


def _assert_streaming_error(testcase: unittest.TestCase, out: dict, message: str) -> None:
    testcase.assertEqual(out["statusCode"], 500)
    testcase.assertIn("application/json", out["headers"]["content-type"])
    testcase.assertEqual(
        json.loads(out["body"]),
        {"error": {"code": "app.internal", "message": message, "status_code": 500}},
    )


def _assert_streaming_too_large(testcase: unittest.TestCase, out: dict) -> None:
    """Assert the size-semantics denial shape for a body over the byte budget.

    A streaming body that exceeds the drain byte budget maps to 413
    (app.too_large), not the 500 delivery-failure shape used for
    non-termination and stream errors.
    """
    testcase.assertEqual(out["statusCode"], 413)
    testcase.assertIn("application/json", out["headers"]["content-type"])
    testcase.assertEqual(
        json.loads(out["body"]),
        {"error": {"code": "app.too_large", "message": "response too large", "status_code": 413}},
    )


class TestStreamingAdapters(unittest.TestCase):
    def setUp(self) -> None:
        # Shorten the drain deadline so live-stream fail-closed tests stay
        # fast; the production budget (5 s) is pinned by the contract fixture.
        self._old_timeout = aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT
        aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT = 0.2

    def tearDown(self) -> None:
        aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT = self._old_timeout

    def test_apigw_v2_delivers_terminating_stream_as_buffered_body(self) -> None:
        out = apigw_v2_response_from_response(
            _streaming_response(_terminating_stream(b"data: first\n\n", b"data: second\n\n"))
        )
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(out["headers"]["content-type"], "text/html; charset=utf-8")
        self.assertEqual(out["body"], "data: first\n\ndata: second\n\n")
        self.assertFalse(out["isBase64Encoded"])
        # A stream that terminates leaves no drain worker behind.
        _wait_for_drain_workers(self, 0)

    def test_apigw_v2_live_stream_fails_closed_and_is_bounded(self) -> None:
        stream, release, unwound = _live_stream(b"data: first\n\n")
        with self.assertLogs("apptheory.aws_http", level="WARNING") as logs:
            out = apigw_v2_response_from_response(_streaming_response(stream))
        self.assertTrue(
            any("still alive" in line for line in logs.output),
            f"abandoned drain worker was not logged: {logs.output}",
        )
        _assert_live_body_bounded(self, out, V2_ERROR_MESSAGE, unwound, release)

    def test_apigw_v2_timeout_releases_stream_cooperatively(self) -> None:
        spy = _CooperativeSpyStream(b"data: first\n\n")
        out = apigw_v2_response_from_response(_streaming_response(spy))
        _assert_streaming_error(self, out, V2_ERROR_MESSAGE)
        self.assertEqual(spy.close_calls, 1, "the abandoned stream was not closed")
        self.assertEqual(spy.cancel_calls, 1, "the abandoned stream was not cancelled")
        # cancel released the blocked iterator, so the worker settled in the grace.
        _wait_for_drain_workers(self, 0)

    def test_lambda_function_url_timeout_awaits_aclose_hook(self) -> None:
        spy = _AsyncCloseSpyStream(b"data: first\n\n")
        out = lambda_function_url_response_from_response(_streaming_response(spy))
        _assert_streaming_error(self, out, URL_ERROR_MESSAGE)
        self.assertEqual(spy.close_calls, 1, "the abandoned stream was not closed")
        self.assertEqual(spy.aclose_calls, 1, "the async close hook was not awaited")
        _wait_for_drain_workers(self, 0)

    def test_apigw_v2_infinite_empty_chunks_hit_the_chunk_cap(self) -> None:
        stream = _EmptyChunkForeverStream()
        with mock.patch.object(aws_http, "_STREAMING_BODY_MAX_CHUNKS", 10):
            started = time.monotonic()
            out = apigw_v2_response_from_response(_streaming_response(stream))
            elapsed = time.monotonic() - started
        _assert_streaming_error(self, out, V2_ERROR_MESSAGE)
        self.assertEqual(stream.iterations, 11, "empty chunks must count toward the chunk cap")
        self.assertLess(
            elapsed,
            aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT,
            "the chunk cap must terminate the drain before the time budget",
        )
        _wait_for_drain_workers(self, 0)

    def test_lambda_function_url_infinite_empty_chunks_are_bounded(self) -> None:
        stream = _EmptyChunkForeverStream()
        out = lambda_function_url_response_from_response(_streaming_response(stream))
        _assert_streaming_error(self, out, URL_ERROR_MESSAGE)
        self.assertLessEqual(stream.iterations, _STREAMING_BODY_MAX_CHUNKS + 1)
        _wait_for_drain_workers(self, 0)

    def test_apigw_v2_overrun_stream_maps_to_413(self) -> None:
        out = apigw_v2_response_from_response(
            _streaming_response(_terminating_stream(b"x" * (_APIGATEWAY_V2_STREAMING_BODY_MAX_BYTES + 1)))
        )
        _assert_streaming_too_large(self, out)

    def test_apigw_v2_stream_error_fails_closed(self) -> None:
        out = apigw_v2_response_from_response(_streaming_response(_error_stream()))
        _assert_streaming_error(self, out, V2_ERROR_MESSAGE)

    def test_lambda_function_url_delivers_terminating_stream_as_buffered_body(self) -> None:
        out = lambda_function_url_response_from_response(
            _streaming_response(_terminating_stream(b"data: first\n\n", b"data: second\n\n"))
        )
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(out["headers"]["content-type"], "text/html; charset=utf-8")
        self.assertEqual(out["body"], "data: first\n\ndata: second\n\n")
        self.assertFalse(out["isBase64Encoded"])

    def test_lambda_function_url_live_stream_fails_closed_and_is_bounded(self) -> None:
        stream, release, unwound = _live_stream(b"data: first\n\n")
        with self.assertLogs("apptheory.aws_http", level="WARNING"):
            out = lambda_function_url_response_from_response(_streaming_response(stream))
        _assert_live_body_bounded(self, out, URL_ERROR_MESSAGE, unwound, release)

    def test_lambda_function_url_overrun_stream_maps_to_413(self) -> None:
        out = lambda_function_url_response_from_response(
            _streaming_response(_terminating_stream(b"x" * (_APIGATEWAY_V2_STREAMING_BODY_MAX_BYTES + 1)))
        )
        _assert_streaming_too_large(self, out)

    def test_lambda_function_url_stream_error_fails_closed(self) -> None:
        out = lambda_function_url_response_from_response(_streaming_response(_error_stream()))
        _assert_streaming_error(self, out, URL_ERROR_MESSAGE)


class TestStreamingThroughApp(unittest.TestCase):
    def setUp(self) -> None:
        self._old_timeout = aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT
        aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT = 0.2

    def tearDown(self) -> None:
        aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT = self._old_timeout

    def test_serve_apigw_v2_delivers_terminating_streaming_handler(self) -> None:
        app = create_app(tier="p0")
        app.get("/sse", lambda _ctx: _streaming_response(_terminating_stream(b"data: first\n\n", b"data: second\n\n")))
        out = app.serve_apigw_v2(build_apigw_v2_request("GET", "/sse"))
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(out["body"], "data: first\n\ndata: second\n\n")

    def test_serve_apigw_v2_live_streaming_handler_fails_closed_and_is_bounded(self) -> None:
        stream, release, unwound = _live_stream(b"data: first\n\n")
        app = create_app(tier="p0")
        app.get("/live", lambda _ctx: _streaming_response(stream))
        with self.assertLogs("apptheory.aws_http", level="WARNING"):
            out = app.serve_apigw_v2(build_apigw_v2_request("GET", "/live"))
        _assert_live_body_bounded(self, out, V2_ERROR_MESSAGE, unwound, release)

    def test_serve_lambda_function_url_delivers_terminating_streaming_handler(self) -> None:
        app = create_app(tier="p0")
        app.get("/sse", lambda _ctx: _streaming_response(_terminating_stream(b"data: first\n\n", b"data: second\n\n")))
        out = app.serve_lambda_function_url(build_lambda_function_url_request("GET", "/sse"))
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(out["body"], "data: first\n\ndata: second\n\n")

    def test_serve_lambda_function_url_live_streaming_handler_fails_closed_and_is_bounded(self) -> None:
        stream, release, unwound = _live_stream(b"data: first\n\n")
        app = create_app(tier="p0")
        app.get("/live", lambda _ctx: _streaming_response(stream))
        with self.assertLogs("apptheory.aws_http", level="WARNING"):
            out = app.serve_lambda_function_url(build_lambda_function_url_request("GET", "/live"))
        _assert_live_body_bounded(self, out, URL_ERROR_MESSAGE, unwound, release)

    def test_serve_apigw_v2_limiter_wrapped_stream_is_released_cooperatively(self) -> None:
        # The limiter wraps the normalized stream, so the adapter sees two
        # forwarding layers; the cooperative hook must still reach the producer.
        spy = _CooperativeSpyStream(b"data: first\n\n")
        app = create_app(limits=Limits(max_response_bytes=1024))
        app.get("/live", lambda _ctx: _streaming_response(spy))
        out = app.serve_apigw_v2(build_apigw_v2_request("GET", "/live"))
        _assert_streaming_error(self, out, V2_ERROR_MESSAGE)
        self.assertEqual(spy.close_calls, 1, "the abandoned stream was not closed")
        self.assertEqual(spy.cancel_calls, 1, "the abandoned stream was not cancelled")
        _wait_for_drain_workers(self, 0)

    def test_serve_apigw_v2_max_response_bytes_limiter_overrun_maps_to_413(self) -> None:
        # The MaxResponseBytes limiter wraps the stream in the portable serve
        # path; when the adapter drains a stream that trips the limiter, the
        # overrun must map to 413 app.too_large (same size semantics as the
        # drain byte-budget overrun), not the 500 delivery-failure shape.
        app = create_app(limits=Limits(max_response_bytes=8))
        app.get("/big", lambda _ctx: _streaming_response(_terminating_stream(b"abcdefghij")))
        out = app.serve_apigw_v2(build_apigw_v2_request("GET", "/big"))
        _assert_streaming_too_large(self, out)

    def test_serve_lambda_function_url_max_response_bytes_limiter_overrun_maps_to_413(self) -> None:
        app = create_app(limits=Limits(max_response_bytes=8))
        app.get("/big", lambda _ctx: _streaming_response(_terminating_stream(b"abcdefghij")))
        out = app.serve_lambda_function_url(build_lambda_function_url_request("GET", "/big"))
        _assert_streaming_too_large(self, out)


if __name__ == "__main__":
    unittest.main()
