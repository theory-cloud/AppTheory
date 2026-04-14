from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.cloudfront import client_ip, origin_url, original_host, original_uri  # noqa: E402


class TestCloudFront(unittest.TestCase):
    def test_origin_url_prefers_edge_host_headers_before_forwarded_fallbacks(self) -> None:
        self.assertEqual(origin_url(None), "")

        out = origin_url(
            {
                "x-apptheory-original-host": "edge.example.com",
                "cloudfront-forwarded-proto": "https",
            }
        )
        self.assertEqual(out, "https://edge.example.com")

        out = origin_url(
            {
                "x-facetheory-original-host": "tenant.example.com",
                "cloudfront-forwarded-proto": "https",
            }
        )
        self.assertEqual(out, "https://tenant.example.com")

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

    def test_original_host_and_uri_helpers_support_app_and_face_headers(self) -> None:
        self.assertEqual(
            original_host({"x-apptheory-original-host": "app.example.com"}),
            "app.example.com",
        )
        self.assertEqual(
            original_uri({"x-apptheory-original-uri": "/from-app"}),
            "/from-app",
        )
        self.assertEqual(
            original_host({"x-facetheory-original-host": "face.example.com"}),
            "face.example.com",
        )
        self.assertEqual(
            original_uri({"x-facetheory-original-uri": "/from-face"}),
            "/from-face",
        )

    def test_client_ip_parses_viewer_address_and_falls_back_to_xff(self) -> None:
        self.assertEqual(client_ip({"cloudfront-viewer-address": "1.2.3.4:123"}), "1.2.3.4")
        self.assertEqual(client_ip({"cloudfront-viewer-address": '"[2001:db8::1]:443"'}), "2001:db8::1")
        self.assertEqual(client_ip({"x-forwarded-for": "10.0.0.1, 10.0.0.2"}), "10.0.0.1")
