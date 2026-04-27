from __future__ import annotations

import unittest

from apptheory.event_workloads import normalize_eventbridge_scheduled_workload


class EventWorkloadHelperTests(unittest.TestCase):
    def test_scheduled_workload_ignores_pathological_integer_counters(self) -> None:
        summary = normalize_eventbridge_scheduled_workload(
            None,
            {
                "id": "evt_1",
                "source": "apptheory.test",
                "detail-type": "Scheduled Event",
                "detail": {
                    "result": {
                        "failed": 10**5000,
                        "processed": 7,
                        "status": "ok",
                    }
                },
            },
        )

        self.assertEqual(summary["result"]["failed"], 0)
        self.assertEqual(summary["result"]["processed"], 7)


if __name__ == "__main__":
    unittest.main()
