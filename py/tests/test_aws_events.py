from __future__ import annotations

import base64
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.aws_events import (  # noqa: E402
    build_eventbridge_event,
    build_kinesis_event,
    build_sns_event,
    build_sqs_event,
    stepfunctions_task_token,
)


class TestAwsEvents(unittest.TestCase):
    def test_build_sqs_event_defaults(self) -> None:
        event = build_sqs_event("arn:aws:sqs:us-east-1:000000000000:q", records=[{"body": "ok"}])
        self.assertIn("Records", event)
        self.assertEqual(event["Records"][0]["body"], "ok")

    def test_build_eventbridge_event_includes_rule_arn(self) -> None:
        evt = build_eventbridge_event(rule_arn="arn:aws:events:us-east-1:000000000000:rule/r")
        self.assertIn("resources", evt)
        self.assertIn("arn:aws:events:us-east-1:000000000000:rule/r", evt["resources"])

    def test_build_kinesis_event_encodes_bytes(self) -> None:
        raw = b"hello"
        evt = build_kinesis_event(
            "arn:aws:kinesis:us-east-1:000000000000:stream/s",
            records=[{"data": raw}],
        )
        rec = evt["Records"][0]["kinesis"]["data"]
        self.assertEqual(rec, base64.b64encode(raw).decode("ascii"))

    def test_build_sns_event_defaults(self) -> None:
        evt = build_sns_event("arn:aws:sns:us-east-1:000000000000:t", records=[{"message": "m"}])
        self.assertEqual(evt["Records"][0]["EventSource"], "aws:sns")

    def test_stepfunctions_task_token(self) -> None:
        self.assertEqual(stepfunctions_task_token({"taskToken": " t "}), "t")
        self.assertEqual(stepfunctions_task_token({"TaskToken": "x"}), "x")
        self.assertEqual(stepfunctions_task_token({"task_token": "y"}), "y")
        self.assertEqual(stepfunctions_task_token({"nope": True}), "")

