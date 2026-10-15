from __future__ import annotations

import dataclasses
import datetime as dt
import json
import sys
import unittest
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from botocore.exceptions import ClientError  # noqa: E402
from tabletheory_py import StatefulDynamoDBClient, Table  # noqa: E402

from apptheory.clock import ManualClock  # noqa: E402
from apptheory.limited.errors import RateLimiterError  # noqa: E402
from apptheory.limited.limiter import _RATE_LIMIT_MODEL, DynamoRateLimiter, default_config  # noqa: E402
from apptheory.limited.strategies import MultiWindowStrategy, WindowConfig  # noqa: E402
from apptheory.limited.types import Config, LimitDecision, RateLimitKey  # noqa: E402

FIXTURE_PATH = REPO_ROOT / "contract-tests" / "fixtures" / "routing" / "limiter" / "multi-window-cancellation.v1.json"
FIXTURE_CASE_COUNT = 13
FIXTURE_CASE_IDS = (
    "limiter.cancellation.genuine_condition_failure",
    "limiter.cancellation.genuine_condition_failure_after_none",
    "limiter.cancellation.genuine_condition_failure_missing_code_in_position",
    "limiter.cancellation.throttle_only",
    "limiter.cancellation.throttle_after_none",
    "limiter.cancellation.transaction_conflict_only",
    "limiter.cancellation.ordered_conflict_after_throttle",
    "limiter.cancellation.ordered_throttle_before_condition",
    "limiter.cancellation.ambiguous_all_none",
    "limiter.cancellation.no_reasons",
    "limiter.cancellation.message_only_condition_text",
    "limiter.cancellation.unknown_reason_code",
    "limiter.transport.non_cancellation_error",
)
FIXTURE_EPOCH = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)
TABLE_NAME = "rate-limits"


def _load_fixture() -> dict[str, Any]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _cancellation_reasons(cancellation: dict[str, Any]) -> list[dict[str, Any]]:
    """Translate the fixture's reasons into the DynamoDB-shaped dicts TableTheory reads.

    A reason may omit ``code`` entirely (no code in that position) or carry
    DynamoDB's ``"None"`` placeholder; both are preserved positionally. Only the
    Code and Message keys are emitted, matching what DynamoDB surfaces.
    """
    reasons: list[dict[str, Any]] = []
    for reason in cancellation.get("reasons") or []:
        entry: dict[str, Any] = {}
        if "code" in reason:
            entry["Code"] = reason["code"]
        if "message" in reason:
            entry["Message"] = reason["message"]
        reasons.append(entry)
    return reasons


def _cancellation_client_error(cancellation: dict[str, Any]) -> ClientError:
    """Build the raw TransactionCanceledException the delivery seam re-raises.

    This preserves the row's exact message (which the fake's own cancellation seam
    would otherwise synthesize) as well as its ordered reasons, so message-sniffing
    regressions are actually exercised. The shape matches what
    ``tabletheory_py.aws_errors.map_transaction_error`` reads from ``response``.
    """
    return ClientError(
        {
            "Error": {
                "Code": "TransactionCanceledException",
                "Message": str(cancellation["message"]),
            },
            "CancellationReasons": _cancellation_reasons(cancellation),
        },
        "TransactWriteItems",
    )


def _strategy_from_fixture(limiter_spec: dict[str, Any]) -> MultiWindowStrategy:
    return MultiWindowStrategy(
        [
            WindowConfig(duration_ms=int(w["duration_seconds"]) * 1000, max_requests=int(w["max_requests"]))
            for w in limiter_spec["windows"]
        ]
    )


def _config(*, fail_open: bool) -> Config:
    return dataclasses.replace(default_config(), fail_open=fail_open)


class TestLimitedMultiWindowCancellation(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = _load_fixture()
        cls.limiter_spec = cls.fixture["limiter"]
        cls.cases = cls.fixture["cases"]

    def _assert_fixture_shape(self) -> None:
        self.assertEqual(self.limiter_spec["strategy"], "multi_window")
        self.assertEqual(len(self.limiter_spec["windows"]), 2)
        self.assertEqual(len(self.cases), FIXTURE_CASE_COUNT)
        self.assertEqual(
            [case["id"] for case in self.cases],
            list(FIXTURE_CASE_IDS),
            "fixture case ids must match the pinned list exactly, in order",
        )

    def _key(self) -> RateLimitKey:
        key = self.limiter_spec["key"]
        return RateLimitKey(
            identifier=key["identifier"],
            resource=key["resource"],
            operation=key["operation"],
        )

    def _run_case(self, case: dict[str, Any], *, fail_open: bool) -> LimitDecision:
        """Drive a fresh real limiter over a real TableTheory client for one case."""
        fake = StatefulDynamoDBClient()
        if "transport_error" in case:
            fake.queue_transaction_error(RuntimeError(str(case["transport_error"]["message"])))
        elif case.get("deliver") == "canceled_exception":
            # Deliver the row's exact message and reasons, bypassing the fake's
            # synthesized message so the classifier really sees this text.
            fake.queue_transaction_error(_cancellation_client_error(case["cancellation"]))
        else:
            fake.queue_transaction_cancellation(_cancellation_reasons(case["cancellation"]))

        table = Table(_RATE_LIMIT_MODEL, client=fake, table_name=TABLE_NAME)
        limiter = DynamoRateLimiter(
            table=table,
            config=_config(fail_open=fail_open),
            strategy=_strategy_from_fixture(self.limiter_spec),
            clock=ManualClock(FIXTURE_EPOCH),
        )
        return limiter.check_and_increment(self._key())

    def _assert_outcome(self, outcome: str, case_id: str, *, fail_open: bool) -> None:
        case = next(c for c in self.cases if c["id"] == case_id)

        if outcome == "internal_error":
            with self.assertRaises(RateLimiterError) as ctx:
                self._run_case(case, fail_open=fail_open)
            self.assertEqual(ctx.exception.type, "internal_error")
            return

        decision = self._run_case(case, fail_open=fail_open)
        self.assertIsInstance(decision, LimitDecision)
        if outcome == "admitted":
            self.assertTrue(decision.allowed, f"{case_id} should be admitted")
        elif outcome == "soft_denial":
            self.assertFalse(decision.allowed, f"{case_id} should be softly denied")
            self.assertIsNotNone(decision.retry_after_ms, f"{case_id} should carry a retry-after")
        else:  # pragma: no cover - guards against an unrecognized fixture outcome
            self.fail(f"unknown outcome {outcome!r} for {case_id}")

    def test_fixture_shape_and_non_vacuity(self) -> None:
        self._assert_fixture_shape()

        fail_open_outcomes = {case["expect"]["fail_open"] for case in self.cases}
        fail_closed_outcomes = {case["expect"]["fail_closed"] for case in self.cases}
        self.assertIn("soft_denial", fail_open_outcomes)
        self.assertIn("soft_denial", fail_closed_outcomes)
        self.assertIn("admitted", fail_open_outcomes)
        self.assertIn("internal_error", fail_closed_outcomes)

        for case in self.cases:
            has_cancellation = "cancellation" in case
            has_transport_error = "transport_error" in case
            self.assertNotEqual(
                has_cancellation,
                has_transport_error,
                f"{case['id']} must carry exactly one of cancellation/transport_error",
            )
            if "deliver" in case:
                self.assertEqual(
                    case["deliver"],
                    "canceled_exception",
                    f"{case['id']} has an unrecognized deliver mode",
                )
                self.assertTrue(
                    has_cancellation,
                    f"{case['id']} delivers a cancellation exception and needs a cancellation block",
                )

    def test_cases_fail_open(self) -> None:
        self._assert_fixture_shape()
        for case in self.cases:
            with self.subTest(case=case["id"], policy="fail_open"):
                self._assert_outcome(case["expect"]["fail_open"], case["id"], fail_open=True)

    def test_cases_fail_closed(self) -> None:
        self._assert_fixture_shape()
        for case in self.cases:
            with self.subTest(case=case["id"], policy="fail_closed"):
                self._assert_outcome(case["expect"]["fail_closed"], case["id"], fail_open=False)
