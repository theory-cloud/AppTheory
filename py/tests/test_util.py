from __future__ import annotations

import datetime as dt
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.clock import ManualClock  # noqa: E402
from apptheory.ids import ManualIdGenerator  # noqa: E402
from apptheory.util import (  # noqa: E402
    canonicalize_headers,
    clone_query,
    normalize_path,
    parse_cookies,
    to_bytes,
)


class TestUtil(unittest.TestCase):
    def test_normalize_path_handles_empty_query_and_missing_slash(self) -> None:
        self.assertEqual(normalize_path(""), "/")
        self.assertEqual(normalize_path(" /x?y=1 "), "/x")
        self.assertEqual(normalize_path("x"), "/x")

    def test_canonicalize_headers_skips_empty_keys_and_normalizes_values(self) -> None:
        out = canonicalize_headers({"": "skip", "X-One": "1", "X-Two": ["2", 3]})
        self.assertNotIn("", out)
        self.assertEqual(out["x-one"], ["1"])
        self.assertEqual(out["x-two"], ["2", "3"])

    def test_clone_query_coerces_scalars_and_lists(self) -> None:
        out = clone_query({"a": "1", "b": ["2", 3]})
        self.assertEqual(out, {"a": ["1"], "b": ["2", "3"]})

    def test_parse_cookies_skips_malformed_segments(self) -> None:
        out = parse_cookies([" ; a=b; c; =bad; d=e "])
        self.assertEqual(out, {"a": "b", "d": "e"})

    def test_to_bytes_supports_common_types_and_errors_for_other_values(self) -> None:
        self.assertEqual(to_bytes(None), b"")
        self.assertEqual(to_bytes(bytearray(b"x")), b"x")
        self.assertEqual(to_bytes(memoryview(b"y")), b"y")
        with self.assertRaisesRegex(TypeError, "bytes-like or str"):
            to_bytes(123)

    def test_manual_clock_and_ids_are_mutable_test_doubles(self) -> None:
        clock = ManualClock(dt.datetime.fromtimestamp(0, tz=dt.UTC))
        self.assertEqual(clock.now().timestamp(), 0)
        clock.advance(dt.timedelta(seconds=1))
        self.assertEqual(clock.now().timestamp(), 1)
        clock.set(dt.datetime.fromtimestamp(5, tz=dt.UTC))
        self.assertEqual(clock.now().timestamp(), 5)

        ids = ManualIdGenerator(prefix="t", start=2)
        self.assertEqual(ids.new_id(), "t-2")
        ids.push("q1")
        self.assertEqual(ids.new_id(), "q1")
        ids.reset()
        self.assertEqual(ids.new_id(), "t-1")
