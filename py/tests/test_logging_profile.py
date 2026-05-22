from __future__ import annotations

import json
import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.app import LogRecord  # noqa: E402
from apptheory.logging_profile import (  # noqa: E402
    LOGGING_PROFILE_PAYTHEORY_ALERT_V1,
    LOGGING_PROFILE_SCHEMA_VERSION,
    LoggingProfileValidationError,
    ProfileLogger,
    built_in_logging_profile_names,
    decode_logging_profile_json,
    default_logging_profile,
    encode_logging_profile_event,
    hooks_from_profile_logger,
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

    def test_encode_paytheory_alert_error(self) -> None:
        cfg = default_logging_profile(LOGGING_PROFILE_PAYTHEORY_ALERT_V1)
        got = encode_logging_profile_event(
            cfg,
            _profile_environment(),
            {
                "timestamp": "1970-01-01T00:00:00Z",
                "level": "error",
                "message": "charge authorization failed",
                "normalized_message": "charge authorization failed",
                "request": {
                    "request_id": "req_test_123",
                    "trace_id": "trace-profile-123",
                    "correlation_id": "corr-profile-123",
                    "route": "POST /payments/{payment_id}/authorize",
                },
                "job": {"name": "authorize-payment"},
                "error": {
                    "type": "ProcessorError",
                    "code": "processor.declined",
                    "message": "processor declined",
                    "stack_trace": "processor.go:42\nhandler.go:7",
                },
                "fields": {"safe_processor": "tesouro", "raw_payload": "must-not-appear"},
            },
        )
        self.assertEqual(
            got,
            {
                "ts": "1970-01-01T00:00:00Z",
                "level": "ERROR",
                "message": "charge authorization failed",
                "service": "payments-api",
                "stage": "live",
                "partner": "paytheory",
                "function": "payments-live-authorize",
                "aws_region": "us-east-1",
                "source_account_id": "111122223333",
                "account_family": "paytheory-live",
                "request_id": "req_test_123",
                "trace_id": "trace-profile-123",
                "correlation_id": "corr-profile-123",
                "error_type": "ProcessorError",
                "error_code": "processor.declined",
                "normalized_message": "charge authorization failed",
                "stack_trace": "processor.go:42\nhandler.go:7",
                "stack_hash": "sha256:d3d3dd723c56522d25492427bf8ca94b80feed197d55aa42e9bab0c1b5031bdc",
                "route": "POST /payments/{payment_id}/authorize",
                "job_name": "authorize-payment",
                "safe_processor": "tesouro",
            },
        )

    def test_caller_fields_do_not_override_profile_owned_fields(self) -> None:
        cfg = default_logging_profile(LOGGING_PROFILE_PAYTHEORY_ALERT_V1)
        got = encode_logging_profile_event(
            cfg,
            _minimal_profile_environment(),
            {
                "timestamp": "1970-01-01T00:00:00Z",
                "level": "error",
                "message": "profile-owned message",
                "fields": {
                    "ts": "2099-01-01T00:00:00Z",
                    "level": "INFO",
                    "message": "override-msg",
                    "service": "override-service",
                    "safe_processor": "tesouro",
                },
            },
        )
        self.assertEqual(got["ts"], "1970-01-01T00:00:00Z")
        self.assertEqual(got["level"], "ERROR")
        self.assertEqual(got["message"], "profile-owned message")
        self.assertEqual(got["service"], "payments-api")
        self.assertEqual(got["safe_processor"], "tesouro")

    def test_encode_missing_required_fields_fails(self) -> None:
        cfg = default_logging_profile(LOGGING_PROFILE_PAYTHEORY_ALERT_V1)
        with self.assertRaisesRegex(ValueError, "logging profile required fields missing: service"):
            encode_logging_profile_event(
                cfg,
                {},
                {"timestamp": "1970-01-01T00:00:00Z", "level": "error", "message": "missing env"},
            )

    def test_profile_logger_writes_entries_and_hooks(self) -> None:
        cfg = default_logging_profile(LOGGING_PROFILE_PAYTHEORY_ALERT_V1)
        lines: list[str] = []
        logger = ProfileLogger(
            cfg,
            environment=_minimal_profile_environment(),
            writer=lines.append,
            clock=lambda: datetime.fromtimestamp(0, UTC),
        )

        scoped = logger.with_request_id("req_test_123").with_tenant_id("tenant_test_123")
        scoped.error(
            "charge failed",
            {
                "normalized_message": "charge failed",
                "error_type": "ProcessorError",
                "error_code": "processor.declined",
                "safe_processor": "tesouro",
            },
        )

        entries = logger.entries()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["ts"], "1970-01-01T00:00:00Z")
        self.assertEqual(entries[0]["level"], "ERROR")
        self.assertEqual(entries[0]["request_id"], "req_test_123")
        self.assertEqual(lines, [json.dumps(entries[0], separators=(",", ":"))])
        self.assertEqual(logger.get_stats()["entries_logged"], 1)

        hook_lines: list[str] = []
        hooks, hook_logger = hooks_from_profile_logger(
            cfg,
            environment=_minimal_profile_environment(),
            writer=hook_lines.append,
            clock=lambda: datetime.fromtimestamp(0, UTC),
        )
        self.assertIsNotNone(hooks.log)
        assert hooks.log is not None
        hooks.log(
            LogRecord(
                level="warn",
                event="request.completed",
                request_id="req_hook_123",
                tenant_id="tenant_hook_123",
                method="POST",
                path="/payments/123/authorize",
                status=402,
                error_code="processor.declined",
            )
        )
        hook_entries = hook_logger.entries()
        self.assertEqual(hook_entries[0]["level"], "WARN")
        self.assertEqual(hook_entries[0]["message"], "request.completed")
        self.assertEqual(hook_entries[0]["request_id"], "req_hook_123")
        self.assertEqual(hook_entries[0]["method"], "POST")
        self.assertEqual(hook_lines, [json.dumps(hook_entries[0], separators=(",", ":"))])


def _profile_environment() -> dict[str, str]:
    return {
        **_minimal_profile_environment(),
        "SOURCE_ACCOUNT_ID": "111122223333",
        "ACCOUNT_FAMILY": "paytheory-live",
    }


def _minimal_profile_environment() -> dict[str, str]:
    return {
        "SERVICE_NAME": "payments-api",
        "STAGE": "live",
        "PARTNER": "paytheory",
        "AWS_LAMBDA_FUNCTION_NAME": "payments-live-authorize",
        "AWS_REGION": "us-east-1",
    }


if __name__ == "__main__":
    unittest.main()
