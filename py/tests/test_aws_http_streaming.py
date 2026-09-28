from __future__ import annotations

import json
import sys
import threading
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

import apptheory.aws_http as aws_http  # noqa: E402
from apptheory.app import Limits, create_app  # noqa: E402
from apptheory.aws_http import (  # noqa: E402
    _APIGATEWAY_V2_STREAMING_BODY_MAX_BYTES,
    _APIGATEWAY_V2_STREAMING_BODY_TIMEOUT,
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


def _live_stream(first: bytes):
    """A live listener that never terminates on its own.

    It does not race its own unwind, so asking it to unwind cannot complete until
    it is released. That is exactly the body the adapter must still join instead
    of abandoning, so the test releases it once the drain budget has expired and
    asserts the adapter waited.
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


def _assert_live_body_joined(testcase: unittest.TestCase, out: dict, message: str, unwound: threading.Event) -> None:
    _assert_streaming_error(testcase, out, message)
    testcase.assertTrue(
        unwound.is_set(),
        "the adapter returned while the live body it gave up on could still run",
    )


def _release_after_budget(release: threading.Event) -> threading.Timer:
    timer = threading.Timer(aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT + 0.1, release.set)
    timer.daemon = True
    timer.start()
    return timer


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
        {"error": {"code": "app.internal", "message": message}},
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
        {"error": {"code": "app.too_large", "message": "response too large"}},
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

    def test_apigw_v2_live_stream_fails_closed_and_is_joined(self) -> None:
        stream, release, unwound = _live_stream(b"data: first\n\n")
        timer = _release_after_budget(release)
        try:
            out = apigw_v2_response_from_response(_streaming_response(stream))
        finally:
            timer.cancel()
        _assert_live_body_joined(self, out, V2_ERROR_MESSAGE, unwound)

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

    def test_lambda_function_url_live_stream_fails_closed_and_is_joined(self) -> None:
        stream, release, unwound = _live_stream(b"data: first\n\n")
        timer = _release_after_budget(release)
        try:
            out = lambda_function_url_response_from_response(_streaming_response(stream))
        finally:
            timer.cancel()
        _assert_live_body_joined(self, out, URL_ERROR_MESSAGE, unwound)

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

    def test_serve_apigw_v2_live_streaming_handler_fails_closed_and_is_joined(self) -> None:
        stream, release, unwound = _live_stream(b"data: first\n\n")
        app = create_app(tier="p0")
        app.get("/live", lambda _ctx: _streaming_response(stream))
        timer = _release_after_budget(release)
        try:
            out = app.serve_apigw_v2(build_apigw_v2_request("GET", "/live"))
        finally:
            timer.cancel()
        _assert_live_body_joined(self, out, V2_ERROR_MESSAGE, unwound)

    def test_serve_lambda_function_url_delivers_terminating_streaming_handler(self) -> None:
        app = create_app(tier="p0")
        app.get("/sse", lambda _ctx: _streaming_response(_terminating_stream(b"data: first\n\n", b"data: second\n\n")))
        out = app.serve_lambda_function_url(build_lambda_function_url_request("GET", "/sse"))
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(out["body"], "data: first\n\ndata: second\n\n")

    def test_serve_lambda_function_url_live_streaming_handler_fails_closed_and_is_joined(self) -> None:
        stream, release, unwound = _live_stream(b"data: first\n\n")
        app = create_app(tier="p0")
        app.get("/live", lambda _ctx: _streaming_response(stream))
        timer = _release_after_budget(release)
        try:
            out = app.serve_lambda_function_url(build_lambda_function_url_request("GET", "/live"))
        finally:
            timer.cancel()
        _assert_live_body_joined(self, out, URL_ERROR_MESSAGE, unwound)

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
