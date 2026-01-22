from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.cloudfront import client_ip, origin_url  # noqa: E402


class TestCloudFront(unittest.TestCase):
    def test_origin_url_prefers_forwarded_and_x_forwarded_host(self) -> None:
        self.assertEqual(origin_url(None), "")

        out = origin_url(
            {
                "x-forwarded-host": "example.com,other",
                "cloudfront-forwarded-proto": "https",
            }
        )
        self.assertEqual(out, "https://example.com")

        out2 = origin_url(
            {
                "forwarded": 'for=1.2.3.4;proto=http;host="api.example.com:8443"',
            }
        )
        self.assertEqual(out2, "http://api.example.com:8443")

    def test_client_ip_parses_viewer_address_and_falls_back_to_xff(self) -> None:
        self.assertEqual(client_ip({"cloudfront-viewer-address": "1.2.3.4:123"}), "1.2.3.4")
        self.assertEqual(client_ip({"cloudfront-viewer-address": '"[2001:db8::1]:443"'}), "2001:db8::1")
        self.assertEqual(client_ip({"x-forwarded-for": "10.0.0.1, 10.0.0.2"}), "10.0.0.1")

