from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.response import Response, normalize_response  # noqa: E402


class TestNormalizeResponseSetCookie(unittest.TestCase):
    def test_non_empty_set_cookie_relocates_into_cookies(self) -> None:
        out = normalize_response(
            Response(
                status=200,
                headers={
                    "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
                    "x-keep": ["v"],
                },
                cookies=["c=1; Path=/"],
                body=b"",
                is_base64=False,
            )
        )
        self.assertNotIn("set-cookie", out.headers)
        self.assertEqual(out.headers["x-keep"], ["v"])
        self.assertEqual(out.cookies, ["c=1; Path=/", "a=1; Path=/", "b=2; Path=/"])

    def test_empty_set_cookie_stays_in_headers(self) -> None:
        out = normalize_response(
            Response(
                status=200,
                headers={"set-cookie": []},
                cookies=[],
                body=b"",
                is_base64=False,
            )
        )
        self.assertIn("set-cookie", out.headers)
        self.assertEqual(out.headers["set-cookie"], [])
        self.assertEqual(out.cookies, [])
