from __future__ import annotations

import base64
import gzip
import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory import (  # noqa: E402
    build_kinesis_event,
    cloudwatch_logs_subscription_data,
    decode_cloudwatch_logs_subscription,
    kinesis_cloudwatch_logs_subscription_record,
)


class CloudWatchLogsSubscriptionTests(unittest.TestCase):
    def test_decode_cloudwatch_logs_subscription_preserves_events_and_safe_summary(self) -> None:
        raw_message = "contract log line alpha"
        event = build_kinesis_event(
            "arn:aws:kinesis:us-east-1:000000000000:stream/contract-logs-stream",
            [
                kinesis_cloudwatch_logs_subscription_record(
                    event_id="kin-cwl-1",
                    partition_key="pk-cwl-1",
                    subscription={
                        "message_type": "DATA_MESSAGE",
                        "owner": "111122223333",
                        "log_group": "/aws/lambda/apptheory-contract",
                        "log_stream": "2026/05/26/[$LATEST]contract-a",
                        "subscription_filters": ["apptheory-contract-filter"],
                        "log_events": [
                            {
                                "id": "cwl-event-a1",
                                "timestamp": 1779806400000,
                                "message": raw_message,
                            },
                            {
                                "id": "cwl-event-a2",
                                "timestamp": 1779806401000,
                                "message": "contract log line beta",
                            },
                        ],
                    },
                )
            ],
        )

        decoded = decode_cloudwatch_logs_subscription(event["Records"][0])

        self.assertEqual(decoded["record_id"], "kin-cwl-1")
        self.assertEqual(decoded["message_type"], "DATA_MESSAGE")
        self.assertEqual(decoded["owner"], "111122223333")
        self.assertEqual(decoded["log_group"], "/aws/lambda/apptheory-contract")
        self.assertEqual(decoded["log_stream"], "2026/05/26/[$LATEST]contract-a")
        self.assertEqual(decoded["subscription_filters"], ["apptheory-contract-filter"])
        self.assertEqual(
            decoded["log_events"],
            [
                {"id": "cwl-event-a1", "timestamp": 1779806400000, "message": raw_message},
                {"id": "cwl-event-a2", "timestamp": 1779806401000, "message": "contract log line beta"},
            ],
        )
        self.assertEqual(
            decoded["safe_summary"],
            {
                "record_id": "kin-cwl-1",
                "message_type": "DATA_MESSAGE",
                "owner": "111122223333",
                "log_group": "/aws/lambda/apptheory-contract",
                "log_stream": "2026/05/26/[$LATEST]contract-a",
                "subscription_filter_count": 1,
                "log_event_count": 2,
                "safe_log": "record_id=kin-cwl-1 owner=111122223333 "
                "log_group=/aws/lambda/apptheory-contract "
                "log_stream=2026/05/26/[$LATEST]contract-a "
                "message_type=DATA_MESSAGE log_events=2 subscription_filters=1",
            },
        )
        safe_summary_json = json.dumps(decoded["safe_summary"], sort_keys=True)
        self.assertNotIn(raw_message, safe_summary_json)
        self.assertNotIn("contract log line beta", safe_summary_json)

    def test_decode_failures_do_not_leak_raw_payload_data(self) -> None:
        raw_log_message = "do-not-log-customer-message"
        with self.assertRaisesRegex(RuntimeError, "invalid payload") as gzip_error:
            decode_cloudwatch_logs_subscription(
                {
                    "eventID": "kin-cwl-bad",
                    "kinesis": {
                        "data": base64.b64encode(f'{{"message":"{raw_log_message}"}}'.encode()).decode("ascii")
                    },
                }
            )
        self.assertNotIn(raw_log_message, str(gzip_error.exception))

        payload = gzip.compress(
            json.dumps(
                {
                    "messageType": "DATA_MESSAGE",
                    "logEvents": [{"id": "cwl-event-a1", "message": raw_log_message}],
                }
            ).encode("utf-8"),
            mtime=0,
        )
        with self.assertRaisesRegex(RuntimeError, "missing owner, logGroup") as missing_error:
            decode_cloudwatch_logs_subscription(
                {"eventID": "kin-cwl-missing", "kinesis": {"data": base64.b64encode(payload).decode("ascii")}}
            )
        self.assertNotIn(raw_log_message, str(missing_error.exception))

    def test_cloudwatch_logs_subscription_data_defaults_decode_through_runtime(self) -> None:
        event = build_kinesis_event(
            "arn:aws:kinesis:us-east-1:000000000000:stream/contract-logs-stream",
            [
                {
                    "eventID": "kin-cwl-data",
                    "data": cloudwatch_logs_subscription_data(
                        log_events=[{"id": "cwl-event-custom", "timestamp": 42, "message": "custom test line"}]
                    ),
                }
            ],
        )

        decoded = decode_cloudwatch_logs_subscription(event["Records"][0])

        self.assertEqual(decoded["record_id"], "kin-cwl-data")
        self.assertEqual(decoded["message_type"], "DATA_MESSAGE")
        self.assertEqual(decoded["owner"], "000000000000")
        self.assertEqual(decoded["log_group"], "/aws/lambda/apptheory-test")
        self.assertEqual(decoded["log_stream"], "1970/01/01/[$LATEST]apptheory-test")
        self.assertEqual(decoded["subscription_filters"], ["apptheory-test-filter"])
        self.assertEqual(
            decoded["log_events"],
            [{"id": "cwl-event-custom", "timestamp": 42, "message": "custom test line"}],
        )
        self.assertEqual(decoded["safe_summary"]["log_event_count"], 1)


if __name__ == "__main__":
    unittest.main()
