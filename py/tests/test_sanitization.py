from __future__ import annotations

import sys
import unittest
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.sanitization import (  # noqa: E402
    payment_xml_patterns,
    sanitize_field_value,
    sanitize_json,
    sanitize_log_string,
    sanitize_xml,
)


class TestSanitization(unittest.TestCase):
    def test_sanitize_log_string_strips_newlines(self) -> None:
        self.assertEqual(sanitize_log_string("a\nb\r\nc"), "abc")

    def test_sanitize_field_value_masks(self) -> None:
        self.assertEqual(sanitize_field_value("authorization", "Bearer secret"), "[REDACTED]")
        self.assertEqual(sanitize_field_value("client_secret", "x"), "[REDACTED]")
        self.assertEqual(sanitize_field_value("card_number", "4242 4242 4242 4242"), "424242******4242")

        nested = sanitize_field_value(
            "root",
            {
                "password": "p\nw",
                "ok": "a\r\nb",
                "list": [{"api_key": "x"}, "fine"],
            },
        )
        self.assertEqual(
            nested,
            {
                "password": "[REDACTED]",
                "ok": "ab",
                "list": [{"api_key": "[REDACTED]"}, "fine"],
            },
        )

    def test_sanitize_json_sanitizes_nested_body_json_strings(self) -> None:
        self.assertEqual(sanitize_json(b""), "(empty)")
        self.assertTrue(sanitize_json("{").startswith("(malformed JSON:"))

        out = sanitize_json(
            json.dumps(
                {
                "authorization": "Bearer secret",
                "body": '{"card_number":"4242 4242 4242 4242"}',
                }
            )
        )
        self.assertIn('"authorization": "[REDACTED]"', out)
        self.assertIn('"body": "{\\"card_number\\":\\"424242******4242\\"}"', out)

    def test_sanitize_xml_masks_payment_fields(self) -> None:
        xml = "<CardNum>4242424242424242</CardNum><CVV>123</CVV><TransArmorToken>abcd1234</TransArmorToken>"
        out = sanitize_xml(xml, payment_xml_patterns)
        self.assertEqual(
            out,
            "<CardNum>424242******4242</CardNum><CVV>[REDACTED]</CVV><TransArmorToken>****1234</TransArmorToken>",
        )
