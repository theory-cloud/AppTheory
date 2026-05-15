from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.errors import (  # noqa: E402
    AppError,
    AppTheoryError,
    app_theory_error_from_app_error,
    error_response,
    error_response_from_app_theory_error,
    error_response_with_format,
    error_response_with_request_id,
    normalize_http_error_format,
    response_for_error,
    response_for_error_with_format,
    response_for_error_with_request_id,
)


class TestErrors(unittest.TestCase):
    def test_app_theory_error_chainable_metadata(self) -> None:
        cause = ValueError("root")
        err = (
            AppTheoryError("app.conflict", "conflict")
            .with_details({"field": "name"})
            .with_request_id("req_1")
            .with_trace_id("trace_1")
            .with_timestamp("2026-05-14T12:00:00Z")
            .with_stack_trace("stack")
            .with_status_code(409)
            .with_cause(cause)
        )
        self.assertEqual(str(err), "app.conflict: conflict")
        self.assertIs(err.__cause__, cause)
        self.assertEqual(err.details, {"field": "name"})
        self.assertEqual(app_theory_error_from_app_error(AppError("app.not_found", "missing")).code, "app.not_found")

    def test_error_response_formats_and_request_ids(self) -> None:
        self.assertEqual(normalize_http_error_format("flat_legacy"), "flat_legacy")
        self.assertEqual(normalize_http_error_format(""), "nested")

        nested = error_response_with_request_id("app.not_found", "missing", request_id="req_1")
        nested_body = json.loads(nested.body.decode())
        self.assertEqual(nested.status, 404)
        self.assertEqual(nested_body["error"]["request_id"], "req_1")

        flat = error_response_with_format("flat_legacy", "app.unauthorized", "nope")
        flat_body = json.loads(flat.body.decode())
        self.assertEqual(flat.status, 401)
        self.assertEqual(flat_body["code"], "app.unauthorized")
        self.assertNotIn("error", flat_body)

        defaulted = error_response("app.internal", "boom")
        self.assertEqual(defaulted.status, 500)

    def test_error_response_from_app_theory_error(self) -> None:
        err = AppTheoryError("", "boom").with_status_code(418).with_request_id("err_req")
        resp = error_response_from_app_theory_error(err, request_id="fallback")
        body = json.loads(resp.body.decode())
        self.assertEqual(resp.status, 418)
        self.assertEqual(body["error"]["code"], "app.internal")
        self.assertEqual(body["error"]["request_id"], "err_req")
        self.assertEqual(body["error"]["status_code"], 418)

    def test_response_for_error_variants(self) -> None:
        app_resp = response_for_error_with_request_id(AppError("app.forbidden", "no"), "req_1")
        self.assertEqual(app_resp.status, 403)
        self.assertEqual(json.loads(app_resp.body.decode())["error"]["request_id"], "req_1")

        theory_resp = response_for_error(AppTheoryError("app.rate_limited", "slow").with_status_code(429))
        self.assertEqual(theory_resp.status, 429)

        flat = response_for_error_with_format("flat_legacy", RuntimeError("secret"))
        body = json.loads(flat.body.decode())
        self.assertEqual(flat.status, 500)
        self.assertEqual(body["message"], "internal error")


if __name__ == "__main__":
    unittest.main()
