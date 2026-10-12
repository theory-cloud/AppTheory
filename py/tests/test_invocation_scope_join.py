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

# This file proves the invocation-scope bound for the Python drain launch site:
#
#   py/src/apptheory/aws_http.py|_drain_streaming_body[#1]
#
# The guard's Python scanner discharges this site itself: `worker.join(...)`
# dominates every exit of `_drain_streaming_body`, so the site is no longer in
# scripts/invocation-scope-baseline.txt.
#
# The tests are strict: a worker whose close + unwind takes longer than the
# drain's unwind grace must not hold the drain open, so the drain returns before
# the worker records that it unwound. The worker is the documented residual and
# exits once its source releases it.

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
    def test_drain_bounds_its_wait_for_a_slow_worker(self) -> None:
        # close + unwind together take longer than the drain's unwind grace, so a
        # bounded drain returns before the worker finishes: it must not hold the
        # invocation open for a worker that does not settle within the bound.
        body = _SlowUnwindBody(close_delay=0.05, unwind_delay=0.5)
        started = time.monotonic()
        with self.assertRaises(aws_http._StreamingBodyBudgetError):
            aws_http._drain_streaming_body(body, _MAX_BYTES, 0.1)
        elapsed = time.monotonic() - started

        self.assertLess(elapsed, 0.9, "the bounded drain waited for a worker that did not settle")
        self.assertFalse(body.unwound.is_set(), "the worker settled within the grace window after all")

        # The slow worker is the documented residual; releasing it lets it exit.
        self.assertTrue(body.unwound.wait(timeout=2.0))
        deadline = time.monotonic() + 2.0
        while _drain_threads() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(len(_drain_threads()), 0, "the drain worker outlived the drain")

    def test_buffered_adapter_bounds_its_wait_for_a_slow_worker(self) -> None:
        body = _SlowUnwindBody(close_delay=0.05, unwind_delay=0.5)
        started = time.monotonic()
        response = aws_http.apigw_v2_response_from_response(html_stream(200, body))
        elapsed = time.monotonic() - started

        self.assertEqual(response["statusCode"], 500)
        self.assertLess(elapsed, 0.9, "the bounded adapter waited for a worker that did not settle")
        self.assertFalse(body.unwound.is_set(), "the worker settled within the grace window after all")

        self.assertTrue(body.unwound.wait(timeout=2.0))
        deadline = time.monotonic() + 2.0
        while _drain_threads() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(len(_drain_threads()), 0, "the drain worker outlived the adapter")


if __name__ == "__main__":
    unittest.main()
