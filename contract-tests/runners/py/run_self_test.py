#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from typing import Any


def load_runner() -> Any:
    runner_path = Path(__file__).with_name("run.py")
    spec = importlib.util.spec_from_file_location("apptheory_contract_py_runner", runner_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load runner from {runner_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


runner = load_runner()


def cloudwatch_logs_subscription_fixture() -> dict[str, Any]:
    return {
        "setup": {
            "kinesis": [
                {"stream": "stream", "handler": runner.CLOUDWATCH_LOGS_SUBSCRIPTION_HANDLER},
            ],
        },
        "input": {
            "aws_event": {
                "source": "kinesis",
                "event": {"Records": [{"eventID": "r1"}, {"eventID": "r2"}]},
            },
        },
        "expect": {
            "cloudwatch_logs_subscription": {
                "records": [
                    {
                        "record_id": "r1",
                        "message_type": "DATA_MESSAGE",
                        "owner": "111122223333",
                        "log_group": "/aws/lambda/example",
                        "log_stream": "2026/05/26/[$LATEST]example",
                        "subscription_filters": ["filter"],
                        "log_events": [
                            {
                                "id": "event-1",
                                "timestamp": 1779806400000,
                                "message": "contract log line alpha",
                            },
                        ],
                        "safe_summary": {
                            "record_id": "r1",
                            "message_type": "DATA_MESSAGE",
                            "owner": "111122223333",
                            "log_group": "/aws/lambda/example",
                            "log_stream": "2026/05/26/[$LATEST]example",
                            "subscription_filter_count": 1,
                            "log_event_count": 1,
                            "safe_log": "record_id=r1 owner=111122223333 log_events=1 subscription_filters=1",
                        },
                        "forbidden_safe_log_substrings": ["contract log line alpha"],
                    },
                    {"record_id": "r2", "decode_error": True},
                ],
            },
        },
    }


class CloudWatchLogsSubscriptionScaffoldTests(unittest.TestCase):
    def test_expectation_hygiene_maps_each_input_record_once(self) -> None:
        fixture = cloudwatch_logs_subscription_fixture()
        expectations = runner.build_cloudwatch_logs_subscription_expectations(fixture)
        self.assertEqual({"r1", "r2"}, set(expectations or {}))

        missing = cloudwatch_logs_subscription_fixture()
        missing["expect"]["cloudwatch_logs_subscription"]["records"] = missing["expect"][
            "cloudwatch_logs_subscription"
        ]["records"][:1]
        with self.assertRaisesRegex(RuntimeError, "missing cloudwatch logs subscription expectation"):
            runner.build_cloudwatch_logs_subscription_expectations(missing)

        extra = cloudwatch_logs_subscription_fixture()
        extra["expect"]["cloudwatch_logs_subscription"]["records"].append(
            {"record_id": "unexpected", "decode_error": True}
        )
        with self.assertRaisesRegex(RuntimeError, "extra cloudwatch logs subscription expectation"):
            runner.build_cloudwatch_logs_subscription_expectations(extra)

        duplicate = cloudwatch_logs_subscription_fixture()
        duplicate["expect"]["cloudwatch_logs_subscription"]["records"].append(
            duplicate["expect"]["cloudwatch_logs_subscription"]["records"][0]
        )
        with self.assertRaisesRegex(RuntimeError, "duplicate cloudwatch logs subscription expectation"):
            runner.build_cloudwatch_logs_subscription_expectations(duplicate)

        malformed_not_marked = cloudwatch_logs_subscription_fixture()
        malformed_not_marked["expect"]["cloudwatch_logs_subscription"]["records"][1] = {"record_id": "r2"}
        with self.assertRaisesRegex(RuntimeError, "malformed records must set decode_error=true"):
            runner.build_cloudwatch_logs_subscription_expectations(malformed_not_marked)

        decode_error_with_fields = cloudwatch_logs_subscription_fixture()
        decode_error_with_fields["expect"]["cloudwatch_logs_subscription"]["records"][1] = {
            "record_id": "r2",
            "decode_error": True,
            "message_type": "DATA_MESSAGE",
        }
        with self.assertRaisesRegex(RuntimeError, "decode_error=true and decoded fields"):
            runner.build_cloudwatch_logs_subscription_expectations(decode_error_with_fields)

    def test_handler_compares_decoder_result(self) -> None:
        fixture = cloudwatch_logs_subscription_fixture()
        expected = fixture["expect"]["cloudwatch_logs_subscription"]["records"][0]

        def decoder(record: dict[str, Any]) -> dict[str, Any]:
            if record["eventID"] == "r2":
                raise RuntimeError("decode failed")
            return expected

        handler = runner.make_cloudwatch_logs_subscription_kinesis_handler(fixture, decoder)
        handler(None, {"eventID": "r1"})
        with self.assertRaisesRegex(RuntimeError, "decode failed"):
            handler(None, {"eventID": "r2"})

        mismatched = dict(expected)
        mismatched["message_type"] = "CONTROL_MESSAGE"
        mismatch_handler = runner.make_cloudwatch_logs_subscription_kinesis_handler(
            fixture,
            lambda _record: mismatched,
        )
        with self.assertRaisesRegex(RuntimeError, "message_type mismatch"):
            mismatch_handler(None, {"eventID": "r1"})

        unsafe = dict(expected)
        unsafe["safe_summary"] = dict(expected["safe_summary"], safe_log="contract log line alpha")
        ok, reason = runner.compare_cloudwatch_logs_subscription_decoded_record(expected, unsafe)
        self.assertFalse(ok)
        self.assertIn("safe_summary mismatch", reason)

        missing_helper_handler = runner.make_cloudwatch_logs_subscription_kinesis_handler(fixture)
        with self.assertRaisesRegex(RuntimeError, runner.CLOUDWATCH_LOGS_SUBSCRIPTION_MISSING_HELPER):
            missing_helper_handler(None, {"eventID": "r1"})


if __name__ == "__main__":
    unittest.main()
