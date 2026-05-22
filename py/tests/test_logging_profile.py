from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.logging_profile import (  # noqa: E402
    LOGGING_PROFILE_PAYTHEORY_ALERT_V1,
    LOGGING_PROFILE_SCHEMA_VERSION,
    LoggingProfileValidationError,
    built_in_logging_profile_names,
    decode_logging_profile_json,
    default_logging_profile,
    logging_profile_catalog,
    logging_profile_validation_errors,
    validate_logging_profile,
)


class TestLoggingProfile(unittest.TestCase):
    def test_built_in_catalog(self) -> None:
        want = ["cloudwatch-json", "legacy", "local-dev", "paytheory-alert-v1"]
        self.assertEqual(built_in_logging_profile_names(), want)
        self.assertEqual(
            logging_profile_catalog(),
            {"schema_version": LOGGING_PROFILE_SCHEMA_VERSION, "profiles": want},
        )

    def test_default_paytheory_alert_validates(self) -> None:
        cfg = default_logging_profile(LOGGING_PROFILE_PAYTHEORY_ALERT_V1)
        validate_logging_profile(cfg)
        self.assertEqual(cfg["encoding"]["timestamp_field"], "ts")
        self.assertEqual(cfg["field_map"]["stack_hash"], "stack_hash")
        self.assertTrue(cfg["error_capture"]["include_stack_trace"])
        self.assertEqual(cfg["error_capture"]["stack_hash_algorithm"], "sha256")

    def test_validation_errors_are_deterministic(self) -> None:
        cfg = {
            "schema_version": "apptheory.logging/v2",
            "profile": "custom-alert",
            "encoding": {"format": "xml", "timestamp_format": "epoch_ms"},
            "required_fields": ["raw_payload"],
            "enrichment": {"context": {"request_id": "lambda.raw_event.requestContext.requestId"}},
            "error_capture": {"include_stack_trace": True, "stack_hash_algorithm": "md5"},
        }
        want = [
            "schema_version: unsupported value apptheory.logging/v2",
            "profile: unsupported value custom-alert",
            "encoding.format: unsupported value xml",
            "encoding.timestamp_format: unsupported value epoch_ms",
            "required_fields[0]: unsupported field raw_payload",
            "enrichment.context.request_id: unsupported source lambda.raw_event.requestContext.requestId",
            "error_capture.stack_hash_algorithm: unsupported value md5",
        ]
        self.assertEqual(logging_profile_validation_errors(cfg), want)
        with self.assertRaises(LoggingProfileValidationError) as ctx:
            validate_logging_profile(cfg)
        self.assertEqual(ctx.exception.errors, want)

    def test_encoding_field_names_fail_closed(self) -> None:
        cfg = default_logging_profile(LOGGING_PROFILE_PAYTHEORY_ALERT_V1)
        cfg["encoding"]["timestamp_field"] = "raw_payload"
        cfg["encoding"]["level_field"] = "raw_payload"
        cfg["encoding"]["message_field"] = "raw_payload"
        self.assertEqual(
            logging_profile_validation_errors(cfg),
            [
                "encoding.timestamp_field: unsupported field raw_payload",
                "encoding.level_field: unsupported field raw_payload",
                "encoding.message_field: unsupported field raw_payload",
            ],
        )

    def test_decode_json_unknown_options_fail_closed(self) -> None:
        raw = json.dumps(
            {
                "schema_version": "apptheory.logging/v1",
                "profile": "paytheory-alert-v1",
                "encoding": {
                    "format": "json",
                    "timestamp_field": "ts",
                    "timestamp_format": "rfc3339nano",
                    "level_field": "level",
                    "message_field": "message",
                    "unknown_encoding_option": True,
                },
                "unknown_top_level": True,
            }
        )
        with self.assertRaises(LoggingProfileValidationError) as ctx:
            decode_logging_profile_json(raw)
        self.assertEqual(
            ctx.exception.errors,
            [
                "encoding.unknown_encoding_option: unsupported option",
                "unknown_top_level: unsupported option",
            ],
        )

    def test_unknown_default_profile_fails(self) -> None:
        with self.assertRaises(ValueError):
            default_logging_profile("custom-alert")


if __name__ == "__main__":
    unittest.main()
