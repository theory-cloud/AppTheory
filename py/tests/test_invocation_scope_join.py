from __future__ import annotations

import sys
import threading
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

import apptheory.aws_http as aws_http  # noqa: E402
from apptheory.response import html_stream  # noqa: E402

# This file proves the invocation-scope invariant for the Python drain launch
# site the baseline justifies by waiting for the worker it abandons:
#
#   py/src/apptheory/aws_http.py|thread[#1]
#
# The tests are strict: the worker only records that it unwound after the slow
# release completes, so a drain that returned without joining its worker is
# caught by an ordering assertion, not by a settle window. Nothing here is left
# to wall-clock slack.

_DRAIN_THREAD_NAME = "apptheory-v2-streaming-drain"
_MAX_BYTES = aws_http._APIGATEWAY_V2_STREAMING_BODY_MAX_BYTES


def _drain_threads() -> list[threading.Thread]:
    return [t for t in threading.enumerate() if t.name == _DRAIN_THREAD_NAME]


class _SlowUnwindBody:
    """A blocking streaming body whose worker needs time to exit after release.

    The first read succeeds. The second blocks until ``close`` releases it,
    ``close`` itself takes ``close_delay`` to do that, and the worker then spends
    ``unwind_delay`` more before its last act: setting ``unwound``. A drain that
    joins the worker cannot return before ``unwound`` is set; one that returns as
    soon as it has closed the body can.
    """

    def __init__(self, *, close_delay: float, unwind_delay: float) -> None:
        self.first = True
        self.close_delay = close_delay
        self.unwind_delay = unwind_delay
        self.released = threading.Event()
        self.unwound = threading.Event()

    def __iter__(self) -> _SlowUnwindBody:
        return self

    def __next__(self) -> bytes:
        if self.first:
            self.first = False
            return b"data: first\n\n"
        self.released.wait()
        time.sleep(self.unwind_delay)
        self.unwound.set()
        raise StopIteration

    def close(self) -> None:
        time.sleep(self.close_delay)
        self.released.set()


class _DrainJoinTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._old_timeout = aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT
        aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT = 0.1

    def tearDown(self) -> None:
        aws_http._APIGATEWAY_V2_STREAMING_BODY_TIMEOUT = self._old_timeout
        # A failing run must not leak its worker into the next test.
        deadline = time.monotonic() + 2.0
        while _drain_threads() and time.monotonic() < deadline:
            time.sleep(0.01)


class TestDrainJoinsItsWorker(_DrainJoinTestCase):
    def test_drain_waits_for_a_worker_whose_close_is_slow(self) -> None:
        body = _SlowUnwindBody(close_delay=0.05, unwind_delay=0.1)
        workers_before = len(_drain_threads())

        started = time.monotonic()
        with self.assertRaises(aws_http._StreamingBodyBudgetError):
            aws_http._drain_streaming_body(body, _MAX_BYTES, 0.1)
        elapsed = time.monotonic() - started

        self.assertTrue(
            body.unwound.is_set(),
            "the drain returned before the worker it abandoned had exited",
        )
        self.assertEqual(
            len(_drain_threads()),
            workers_before,
            "the drain worker outlived the drain that abandoned it",
        )
        # 0.1s drain budget + 0.05s close + 0.1s unwind is the smallest total a
        # joined worker can produce; anything less returned while it still ran.
        self.assertGreaterEqual(
            elapsed,
            0.2,
            "the drain returned before the worker it abandoned had exited",
        )

    def test_buffered_adapter_waits_for_a_worker_whose_close_is_slow(self) -> None:
        body = _SlowUnwindBody(close_delay=0.05, unwind_delay=0.1)
        workers_before = len(_drain_threads())
        started = time.monotonic()
        response = aws_http.apigw_v2_response_from_response(html_stream(200, body))
        elapsed = time.monotonic() - started

        self.assertEqual(response["statusCode"], 500)
        self.assertTrue(
            body.unwound.is_set(),
            "the adapter returned before the drain worker it abandoned had exited",
        )
        self.assertEqual(
            len(_drain_threads()),
            workers_before,
            "the drain worker outlived the adapter that abandoned it",
        )
        self.assertGreaterEqual(
            elapsed,
            0.2,
            "the adapter returned before the drain worker it abandoned had exited",
        )


if __name__ == "__main__":
    unittest.main()
