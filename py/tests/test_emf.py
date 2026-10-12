from __future__ import annotations

import datetime as dt
import io
import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory import create_emf_metric_sink  # noqa: E402
from apptheory.app import MetricRecord  # noqa: E402


class EMFMetricSinkTests(unittest.TestCase):
    def _sink(self, buffer: io.StringIO):
        return create_emf_metric_sink(
            writer=buffer,
            clock=lambda: dt.datetime(1970, 1, 1, tzinfo=dt.UTC),
        )

    def test_request_metric_dimensions_are_bounded(self) -> None:
        buffer = io.StringIO()
        sink = self._sink(buffer)
        sink.record_metric(
            MetricRecord(
                name="apptheory.request",
                value=1,
                duration_ms=25,
                tags={
                    "method": "GET",
                    "route": "/users/{id}",
                    "path": "/users/attacker-unique-path",
                    "status": "200",
                    "tenant_id": "attacker-tenant",
                    "error_code": "",
                },
            )
        )

        line = buffer.getvalue().strip()
        parsed = json.loads(line)
        self.assertEqual(
            parsed["_aws"]["CloudWatchMetrics"][0]["Dimensions"],
            [["service", "method", "route", "status_class", "error_code"]],
        )
        self.assertEqual(parsed["route"], "/users/{id}")
        self.assertEqual(parsed["status_class"], "2xx")
        self.assertEqual(parsed["RequestCount"], 1)

        # The attacker-selected path and unverified tenant hint must not reach the
        # metric envelope as values or dimensions.
        self.assertNotIn("attacker-unique-path", line)
        self.assertNotIn("attacker-tenant", line)

    def test_unmatched_route_is_not_a_per_path_dimension(self) -> None:
        buffer = io.StringIO()
        sink = self._sink(buffer)
        sink.record_metric(
            MetricRecord(
                name="apptheory.request",
                value=1,
                duration_ms=1,
                tags={
                    "method": "GET",
                    "path": "/random/xyz",
                    "status": "404",
                    "error_code": "app.not_found",
                    "tenant_id": "attacker",
                },
            )
        )

        line = buffer.getvalue().strip()
        parsed = json.loads(line)
        self.assertEqual(parsed["route"], "unmatched")
        self.assertEqual(parsed["status_class"], "4xx")
        self.assertNotIn("xyz", line)
        self.assertNotIn("attacker", line)


if __name__ == "__main__":
    unittest.main()
