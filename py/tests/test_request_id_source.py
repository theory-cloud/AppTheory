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
from apptheory.request_id_source import (  # noqa: E402
    MAX_CLIENT_REQUEST_ID_LENGTH,
    is_well_formed_client_request_id,
    normalize_request_id_source,
    well_formed_client_request_id,
)
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


MALFORMED_CLIENT_REQUEST_IDS = {
    "crlf": "evil\r\nx-injected: 1",
    "oversize": "a" * 129,
    "space": "has space",
    "nonascii": "caf\u00e9",
    "tab": "a\tb",
    "nul": "a\x00b",
}


class ClientRequestIDShapeTests(unittest.TestCase):
    def test_max_client_request_id_length_is_128(self) -> None:
        self.assertEqual(MAX_CLIENT_REQUEST_ID_LENGTH, 128)

    def test_is_well_formed_client_request_id(self) -> None:
        cases = {
            "": False,
            "  \t ": False,
            "req_client_wellformed": True,
            "  req_client_wellformed\t": True,
            "!~": True,
            "a" * MAX_CLIENT_REQUEST_ID_LENGTH: True,
            "a" * (MAX_CLIENT_REQUEST_ID_LENGTH + 1): False,
            "evil\r\nx-injected: 1": False,
            "evil\nx": False,
            "a\tb": False,
            "has space": False,
            "a\x00b": False,
            "a\x7fb": False,
            "caf\u00e9": False,
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(is_well_formed_client_request_id(value), expected)

    def test_well_formed_client_request_id_returns_the_trimmed_value(self) -> None:
        self.assertEqual(well_formed_client_request_id("  req_client_ok\t"), "req_client_ok")
        for value in MALFORMED_CLIENT_REQUEST_IDS.values():
            with self.subTest(value=value):
                self.assertEqual(well_formed_client_request_id(value), "")


def _request_id_app(source: str | None = None) -> tuple[App, list[dict]]:
    options = {"tier": "p1", "id_generator": _FixedIds()}
    if source is not None:
        options["request_id_source"] = source
    app = create_app(**options)
    seen: list[dict] = []

    def handler(ctx) -> Response:
        seen.append({"client_request_id": ctx.client_request_id, "request_id": ctx.request_id})
        return json_response(
            200,
            {"request_id": ctx.request_id, "client_request_id": ctx.client_request_id},
        )

    app.get("/context", handler)
    return app, seen


class ClientRequestIDAccessorTests(unittest.TestCase):
    def test_default_mode_exposes_the_well_formed_client_value(self) -> None:
        app, seen = _request_id_app(REQUEST_ID_SOURCE_DEFAULT)
        resp = app.serve(_context_request({"x-request-id": "req_client_wellformed"}))

        self.assertEqual(seen[0]["client_request_id"], "req_client_wellformed")
        self.assertEqual(resp.headers["x-request-id"], ["req_client_wellformed"])
        self.assertEqual(json.loads(resp.body)["client_request_id"], "req_client_wellformed")

    def test_default_mode_trims_edge_whitespace(self) -> None:
        app, seen = _request_id_app(REQUEST_ID_SOURCE_DEFAULT)
        resp = app.serve(_context_request({"x-request-id": "  req_client_wellformed\t"}))

        self.assertEqual(seen[0]["client_request_id"], "req_client_wellformed")
        self.assertEqual(resp.headers["x-request-id"], ["req_client_wellformed"])

    def test_default_mode_accepts_the_128_character_boundary(self) -> None:
        boundary = "a" * MAX_CLIENT_REQUEST_ID_LENGTH
        app, seen = _request_id_app(REQUEST_ID_SOURCE_DEFAULT)
        resp = app.serve(_context_request({"x-request-id": boundary}))

        self.assertEqual(seen[0]["client_request_id"], boundary)
        self.assertEqual(resp.headers["x-request-id"], [boundary])

    def test_default_mode_ignores_a_malformed_client_value(self) -> None:
        for name, value in MALFORMED_CLIENT_REQUEST_IDS.items():
            with self.subTest(name=name):
                app, seen = _request_id_app(REQUEST_ID_SOURCE_DEFAULT)
                resp = app.serve(_context_request({"x-request-id": value}))

                self.assertEqual(seen[0]["client_request_id"], "")
                self.assertEqual(resp.headers["x-request-id"], [GENERATED])
                self.assertEqual(seen[0]["request_id"], GENERATED)
                self.assertEqual(json.loads(resp.body)["request_id"], GENERATED)
                self.assertNotIn(value, resp.body.decode("utf-8"))

    def test_malformed_client_value_never_reaches_the_error_envelope(self) -> None:
        for name, value in MALFORMED_CLIENT_REQUEST_IDS.items():
            with self.subTest(name=name):
                app, _seen = _request_id_app(REQUEST_ID_SOURCE_DEFAULT)
                resp = app.serve(_context_request({"x-request-id": value}, path="/missing"))

                self.assertEqual(resp.status, 404)
                self.assertEqual(resp.headers["x-request-id"], [GENERATED])
                self.assertEqual(json.loads(resp.body)["error"]["request_id"], GENERATED)
                self.assertNotIn(value, resp.body.decode("utf-8"))

    def test_malformed_client_value_falls_back_on_appsync(self) -> None:
        app = create_app(tier="p2", id_generator=_FixedIds())
        app.post(
            "/createThing",
            lambda ctx: json_response(
                200,
                {"request_id": ctx.request_id, "client_request_id": ctx.client_request_id},
            ),
        )

        output = app.serve_appsync(
            {
                "arguments": {},
                "request": {"headers": {"x-request-id": "evil\r\nx-injected: 1"}},
                "info": {"fieldName": "createThing", "parentTypeName": "Mutation"},
            },
            ctx=_LambdaContext(),
        )

        self.assertEqual(output["request_id"], "aws_req_fallback")
        self.assertEqual(output["client_request_id"], "")

    def test_server_issued_mode_exposes_the_well_formed_client_value(self) -> None:
        app, seen = _request_id_app(REQUEST_ID_SOURCE_SERVER)
        resp = app.serve(_context_request({"x-request-id": "req_client_visible"}))

        self.assertEqual(seen[0]["client_request_id"], "req_client_visible")
        self.assertEqual(resp.headers["x-request-id"], [GENERATED])
        self.assertEqual(json.loads(resp.body)["request_id"], GENERATED)

    def test_server_issued_mode_exposes_nothing_for_a_malformed_client_value(self) -> None:
        for name, value in MALFORMED_CLIENT_REQUEST_IDS.items():
            with self.subTest(name=name):
                app, seen = _request_id_app(REQUEST_ID_SOURCE_SERVER)
                resp = app.serve(_context_request({"x-request-id": value}))

                self.assertEqual(seen[0]["client_request_id"], "")
                self.assertEqual(resp.headers["x-request-id"], [GENERATED])
                self.assertNotIn(value, resp.body.decode("utf-8"))

    def test_raw_request_headers_keep_the_client_value_as_received(self) -> None:
        app = create_app(tier="p1", id_generator=_FixedIds())
        raw: list[str] = []

        def handler(ctx) -> Response:
            raw.append(ctx.request.headers["x-request-id"][0])
            return json_response(200, {"request_id": ctx.request_id})

        app.get("/context", handler)
        app.serve(_context_request({"x-request-id": "evil\r\nx-injected: 1"}))

        self.assertEqual(raw, ["evil\r\nx-injected: 1"])

    def test_secure_app_populates_the_client_request_id_accessor(self) -> None:
        app = SecureApp(tier="p1", id_generator=_FixedIds())
        seen: list[str] = []

        def handler(ctx) -> Response:
            seen.append(ctx.client_request_id)
            return json_response(200, {"request_id": ctx.request_id})

        app.handle("GET", "/context", handler, public())
        resp = app.serve(_context_request({"x-request-id": "req_client_visible"}))

        self.assertEqual(seen, ["req_client_visible"])
        self.assertEqual(resp.headers["x-request-id"], ["req_client_visible"])

    def test_context_clone_keeps_the_client_request_id(self) -> None:
        from apptheory.middleware import _clone_context_with_timeout_ctx

        captured: list[str] = []

        def handler(ctx) -> Response:
            clone = _clone_context_with_timeout_ctx(ctx, ctx.ctx)
            captured.append(clone.client_request_id)
            return json_response(200, {"request_id": ctx.request_id})

        app = create_app(tier="p1", id_generator=_FixedIds(), request_id_source=REQUEST_ID_SOURCE_SERVER)
        app.get("/context", handler)
        app.serve(_context_request({"x-request-id": "req_client_visible"}))

        self.assertEqual(captured, ["req_client_visible"])


if __name__ == "__main__":
    unittest.main()
