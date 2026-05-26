from __future__ import annotations

import json
import math
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory import create_kinesis_json_record, report_kinesis_put_records_failures  # noqa: E402


class KinesisProducerTests(unittest.TestCase):
    def test_create_kinesis_json_record_encodes_deterministic_payload_and_safe_summary(self) -> None:
        record = create_kinesis_json_record(
            partition_key=" tenant#1 ",
            explicit_hash_key="0007",
            payload={"b": 2, "a": {"z": "<ok>&", "m": [True, None]}},
        )

        self.assertEqual(record["data"].decode("utf-8"), '{"a":{"m":[true,null],"z":"<ok>&"},"b":2}')
        self.assertEqual(record["partition_key"], "tenant#1")
        self.assertEqual(record["explicit_hash_key"], "7")
        self.assertEqual(record["safe_summary"]["data_byte_length"], len(record["data"]))

        summary_json = json.dumps(record["safe_summary"], sort_keys=True)
        for forbidden in ["<ok>&", '"b":2', "true"]:
            self.assertNotIn(forbidden, summary_json)
            self.assertNotIn(forbidden, record["safe_summary"]["safe_log"])

    def test_create_kinesis_json_record_fails_closed_for_invalid_inputs(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "partition key is required"):
            create_kinesis_json_record(partition_key="", payload={"ok": True})
        with self.assertRaisesRegex(RuntimeError, "explicit hash key must be decimal digits"):
            create_kinesis_json_record(
                partition_key="pk-1",
                explicit_hash_key="not-decimal",
                payload={"ok": True},
            )
        with self.assertRaisesRegex(RuntimeError, "non-finite number"):
            create_kinesis_json_record(partition_key="pk-1", payload={"bad": math.inf})

    def test_report_kinesis_put_records_failures_aligns_failures_and_omits_payload_bodies(self) -> None:
        first = create_kinesis_json_record(partition_key="pk-1", payload={"customer": "alpha"})
        second = create_kinesis_json_record(
            partition_key="pk-2",
            explicit_hash_key="9",
            payload={"customer": "bravo"},
        )

        report = report_kinesis_put_records_failures(
            [first, second],
            [
                {"sequence_number": "1", "shard_id": "shardId-000000000000"},
                {
                    "error_code": "ProvisionedThroughputExceededException",
                    "error_message": 'failed payload {"customer":"bravo"}',
                },
            ],
        )

        self.assertEqual(report["record_count"], 2)
        self.assertEqual(report["failed_record_count"], 1)
        self.assertEqual(len(report["failures"]), 1)
        failure = report["failures"][0]
        self.assertEqual(failure["index"], 1)
        self.assertEqual(failure["partition_key"], "pk-2")
        self.assertEqual(failure["explicit_hash_key"], "9")
        self.assertTrue(failure["error_message_present"])
        self.assertGreater(failure["error_message_byte_length"], 0)

        report_json = json.dumps(report, sort_keys=True)
        for forbidden in ["alpha", "bravo", "customer", "failed payload"]:
            self.assertNotIn(forbidden, report_json)
        self.assertIn("failed_record_count=1", report["safe_summary"]["safe_log"])

    def test_report_kinesis_put_records_failures_fails_closed_for_shape_drift(self) -> None:
        record = create_kinesis_json_record(partition_key="pk-1", payload={"ok": True})

        with self.assertRaisesRegex(RuntimeError, "records/results length mismatch"):
            report_kinesis_put_records_failures([record], [])
        with self.assertRaisesRegex(RuntimeError, "error message without error code"):
            report_kinesis_put_records_failures([record], [{"error_message": "message without code"}])


if __name__ == "__main__":
    unittest.main()
