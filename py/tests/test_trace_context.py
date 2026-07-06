from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.context import Context  # noqa: E402
from apptheory.request import Request, normalize_request  # noqa: E402
from apptheory.trace_context import extract_trace_id_from_headers  # noqa: E402


class TestTraceContext(unittest.TestCase):
    def test_traceparent_wins_over_xray(self) -> None:
        trace_id = extract_trace_id_from_headers(
            {
                "traceparent": ["00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"],
                "x-amzn-trace-id": ["Root=1-67891233-abcdef012345678912345678"],
            }
        )
        self.assertEqual(trace_id, "4bf92f3577b34da6a3ce929d0e0e4736")

    def test_xray_root_is_used_when_traceparent_absent(self) -> None:
        trace_id = extract_trace_id_from_headers(
            {"x-amzn-trace-id": ["Self=abc; Root=1-67891233-abcdef012345678912345678; Sampled=1"]}
        )
        self.assertEqual(trace_id, "1-67891233-abcdef012345678912345678")

    def test_invalid_headers_do_not_synthesize_trace_id(self) -> None:
        self.assertEqual(
            extract_trace_id_from_headers(
                {
                    "traceparent": ["00-00000000000000000000000000000000-00f067aa0ba902b7-01"],
                    "x-amzn-trace-id": ["Root=1-67891233-000000000000000000000000"],
                }
            ),
            "",
        )
        self.assertEqual(extract_trace_id_from_headers({"traceparent": ["bad"]}), "")
        self.assertEqual(extract_trace_id_from_headers({"x-amzn-trace-id": ["Sampled=1"]}), "")
        self.assertEqual(extract_trace_id_from_headers(None), "")

    def test_normalized_request_and_context_expose_trace_id(self) -> None:
        req = normalize_request(
            Request(
                method="GET",
                path="/trace",
                headers={"TraceParent": ["00-11111111111111111111111111111111-00f067aa0ba902b7-01"]},
            )
        )
        self.assertEqual(req.trace_id, "11111111111111111111111111111111")
        ctx = Context(request=req)
        self.assertEqual(ctx.trace_id, req.trace_id)
        self.assertEqual(ctx.trace_context_id(), req.trace_id)


if __name__ == "__main__":
    unittest.main()
