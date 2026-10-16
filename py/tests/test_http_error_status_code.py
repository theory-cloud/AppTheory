from __future__ import annotations

import json
import unittest

from apptheory import (
    App,
    AppError,
    AppTheoryError,
    Limits,
    PolicyDecision,
    Response,
    Request,
)


def _status_code_of(response: Response) -> int:
    body = json.loads(bytes(response.body))
    return int(body["error"]["status_code"])


def _ok(_ctx) -> Response:
    return Response(status=200, headers={}, cookies=[], body=b"ok")


def _unserializable_details_app(error_format: str) -> App:
    """An App whose handler raises an envelope that json cannot serialize."""
    app = App(tier="p0", http_error_format=error_format)

    def teapot(_ctx) -> Response:
        raise AppTheoryError(
            code="teapot",
            message="I am a teapot",
            status_code=418,
            details={"unserializable": object()},
        )

    app.get("/teapot", teapot)
    return app


class ServedErrorStatusCodeTests(unittest.TestCase):
    """The nested envelope must report the status the runtime actually sent (#1161)."""

    def _serve(self, app: App, request: Request) -> Response:
        return app.serve(request)

    def test_framework_producers_carry_the_served_status(self) -> None:
        def not_found_app() -> App:
            app = App(tier="p0")
            app.get("/ping", _ok)
            return app

        def panic_app() -> App:
            app = App(tier="p0")

            def boom(_ctx) -> Response:
                raise RuntimeError("boom")

            app.get("/panic", boom)
            return app

        cases = [
            ("routing not found", not_found_app, Request(method="GET", path="/missing")),
            ("routing method not allowed", not_found_app, Request(method="DELETE", path="/ping")),
            ("panic recovery", panic_app, Request(method="GET", path="/panic")),
            (
                "policy rate limit",
                lambda: App(tier="p2", policy_hook=lambda _ctx: PolicyDecision(code="app.rate_limited")),
                Request(method="GET", path="/limited"),
            ),
            (
                "policy load shed",
                lambda: App(tier="p2", policy_hook=lambda _ctx: PolicyDecision(code="app.overloaded")),
                Request(method="GET", path="/shed"),
            ),
            (
                "request too large",
                lambda: App(tier="p2", limits=Limits(max_request_bytes=1)),
                Request(method="GET", path="/big", body=b"too big"),
            ),
            (
                "response too large",
                lambda: self._oversized_response_app(),
                Request(method="GET", path="/big"),
            ),
            (
                "legacy AppError from a handler",
                lambda: self._raising_app(AppError("app.bad_request", "invalid json")),
                Request(method="GET", path="/legacy"),
            ),
            (
                "portable error without a status",
                lambda: self._raising_app(AppTheoryError("app.not_found", "not found")),
                Request(method="GET", path="/portable"),
            ),
        ]

        for name, build, request in cases:
            with self.subTest(name):
                response = self._serve(build(), request)
                self.assertEqual(_status_code_of(response), response.status, name)

    @staticmethod
    def _oversized_response_app() -> App:
        app = App(tier="p2", limits=Limits(max_response_bytes=1))

        def big(_ctx) -> Response:
            return Response(status=200, headers={}, cookies=[], body=b"too big")

        app.get("/big", big)
        return app

    @staticmethod
    def _raising_app(exc: Exception) -> App:
        app = App(tier="p0")

        def boom(_ctx) -> Response:
            raise exc

        app.get("/legacy", boom)
        app.get("/portable", boom)
        return app

    def test_flat_legacy_envelope_stays_byte_identical_and_has_no_status_code(self) -> None:
        app = App(tier="p0", http_error_format="flat_legacy")
        app.get("/ping", _ok)

        missing = self._serve(app, Request(method="GET", path="/missing"))
        self.assertEqual(
            bytes(missing.body).decode("utf-8"),
            '{"code": "app.not_found", "message": "not found"}',
        )
        self.assertNotIn("status_code", json.loads(bytes(missing.body)))

    def test_unserializable_details_nested_sends_the_internal_error_fallback_with_status_500(self) -> None:
        response = self._serve(_unserializable_details_app("nested"), Request(method="GET", path="/teapot"))
        self.assertEqual(response.status, 500)
        self.assertEqual(
            bytes(response.body).decode("utf-8"),
            '{"error":{"code":"app.internal","message":"internal error","status_code":500}}',
        )
        self.assertEqual(
            list(response.headers["content-type"]),
            ["application/json; charset=utf-8"],
        )

    def test_unserializable_details_flat_legacy_sends_the_internal_error_fallback_with_status_500(self) -> None:
        response = self._serve(_unserializable_details_app("flat_legacy"), Request(method="GET", path="/teapot"))
        self.assertEqual(response.status, 500)
        self.assertEqual(
            bytes(response.body).decode("utf-8"),
            '{"code":"app.internal","message":"internal error"}',
        )
        self.assertEqual(
            list(response.headers["content-type"]),
            ["application/json; charset=utf-8"],
        )


if __name__ == "__main__":
    unittest.main()
