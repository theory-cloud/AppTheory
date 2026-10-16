from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory import (  # noqa: E402
    REQUEST_ID_SOURCE_DEFAULT,
    REQUEST_ID_SOURCE_SERVER,
    App,
    SecureApp,
    create_app,
)
from apptheory.request import Request  # noqa: E402
from apptheory.request_id_source import normalize_request_id_source  # noqa: E402
from apptheory.response import Response  # noqa: E402
from apptheory.response import json as json_response  # noqa: E402
from apptheory.secure_types import public  # noqa: E402

GENERATED = "req_server_issued"


class _FixedIds:
    def new_id(self) -> str:
        return GENERATED


class _LambdaContext:
    aws_request_id = "aws_req_fallback"
    awsRequestId = "aws_req_fallback"


def _context_request(headers: dict | None = None, path: str = "/context") -> Request:
    return Request(method="GET", path=path, headers=headers or {}, body="")


class RequestIDSourceTests(unittest.TestCase):
    def test_normalize_request_id_source_defaults_unknown_values(self) -> None:
        cases = {
            None: REQUEST_ID_SOURCE_DEFAULT,
            "": REQUEST_ID_SOURCE_DEFAULT,
            REQUEST_ID_SOURCE_DEFAULT: REQUEST_ID_SOURCE_DEFAULT,
            REQUEST_ID_SOURCE_SERVER: REQUEST_ID_SOURCE_SERVER,
            "SERVER": REQUEST_ID_SOURCE_DEFAULT,
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(normalize_request_id_source(value), expected)

    def test_default_source_honors_client_x_request_id(self) -> None:
        app = create_app(tier="p1", id_generator=_FixedIds())
        seen: list[str] = []

        def handler(ctx) -> Response:
            seen.append(ctx.request_id)
            return json_response(200, {"request_id": ctx.request_id})

        app.get("/context", handler)
        resp = app.serve(_context_request({"x-request-id": "req_client_supplied"}))

        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers["x-request-id"], ["req_client_supplied"])
        self.assertEqual(seen, ["req_client_supplied"])
        self.assertEqual(json.loads(resp.body)["request_id"], "req_client_supplied")

    def test_server_issued_source_ignores_client_x_request_id(self) -> None:
        app = create_app(tier="p1", id_generator=_FixedIds(), request_id_source=REQUEST_ID_SOURCE_SERVER)
        seen: list[str] = []

        def handler(ctx) -> Response:
            seen.append(ctx.request_id)
            return json_response(200, {"request_id": ctx.request_id})

        app.get("/context", handler)
        resp = app.serve(_context_request({"x-request-id": "req_client_forged"}))

        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers["x-request-id"], [GENERATED])
        self.assertEqual(seen, [GENERATED])
        body = json.loads(resp.body)
        self.assertEqual(body["request_id"], GENERATED)
        self.assertNotIn("req_client_forged", resp.body.decode("utf-8"))

    def test_server_issued_source_keeps_client_value_out_of_error_envelopes(self) -> None:
        app = create_app(tier="p1", id_generator=_FixedIds(), request_id_source=REQUEST_ID_SOURCE_SERVER)

        def handler(_ctx) -> Response:
            raise RuntimeError("boom")

        app.get("/handler-error", handler)

        cases = (
            ("handler error", "/handler-error", 500, "app.internal"),
            ("framework not found", "/missing", 404, "app.not_found"),
        )
        for name, path, status, code in cases:
            with self.subTest(name=name):
                resp = app.serve(_context_request({"x-request-id": "req_client_forged"}, path=path))
                self.assertEqual(resp.status, status)
                self.assertEqual(resp.headers["x-request-id"], [GENERATED])
                error = json.loads(resp.body)["error"]
                self.assertEqual(error["code"], code)
                self.assertEqual(error["request_id"], GENERATED)

    def test_server_issued_source_uses_lambda_fallback_id_on_appsync(self) -> None:
        app = create_app(tier="p2", id_generator=_FixedIds(), request_id_source=REQUEST_ID_SOURCE_SERVER)
        app.post("/createThing", lambda ctx: json_response(200, {"request_id": ctx.request_id}))

        output = app.serve_appsync(
            {
                "arguments": {},
                "request": {"headers": {"x-request-id": "req_client_forged"}},
                "info": {"fieldName": "createThing", "parentTypeName": "Mutation"},
            },
            ctx=_LambdaContext(),
        )

        self.assertEqual(output["request_id"], "aws_req_fallback")

    def test_secure_app_reaches_server_issued_source_through_closed_options(self) -> None:
        app = SecureApp(tier="p1", id_generator=_FixedIds(), request_id_source=REQUEST_ID_SOURCE_SERVER)
        seen: list[str] = []

        def handler(ctx) -> Response:
            seen.append(ctx.request_id)
            return json_response(200, {"request_id": ctx.request_id})

        app.handle("GET", "/context", handler, public())
        resp = app.serve(_context_request({"x-request-id": "req_client_forged"}))

        self.assertEqual(seen, [GENERATED])
        self.assertEqual(resp.headers["x-request-id"], [GENERATED])

    def test_legacy_app_constructor_accepts_request_id_source(self) -> None:
        app = App(tier="p1", id_generator=_FixedIds(), request_id_source=REQUEST_ID_SOURCE_SERVER)
        app.get("/context", lambda ctx: json_response(200, {"request_id": ctx.request_id}))

        resp = app.serve(_context_request({"x-request-id": "req_client_forged"}))

        self.assertEqual(resp.headers["x-request-id"], [GENERATED])


if __name__ == "__main__":
    unittest.main()
