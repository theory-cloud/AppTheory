from __future__ import annotations

import json
import unittest

import apptheory


def _ok(_ctx: apptheory.Context) -> apptheory.Response:
    return apptheory.text(200, "ok")


class SecureAppTests(unittest.TestCase):
    def test_closed_construction_and_facade_surface(self) -> None:
        for tier in ("p0", "p1", "p2"):
            app = apptheory.SecureApp(tier=tier)
            self.assertEqual(app._SecureApp__core._tier, tier)

        self.assertEqual(apptheory.SecureApp()._SecureApp__core._tier, "p2")
        with self.assertRaisesRegex(ValueError, "invalid secure configuration"):
            apptheory.SecureApp(tier="p3")
        with self.assertRaises(TypeError):
            apptheory.SecureApp(unknown_option=True)  # type: ignore[call-arg]
        with self.assertRaisesRegex(ValueError, "invalid secure configuration"):
            apptheory.SecureApp(websocket_client_factory=7)  # type: ignore[arg-type]

        required = {
            "serve",
            "serve_alb",
            "serve_apigw_proxy",
            "serve_apigw_v2",
            "serve_lambda_function_url",
            "serve_appsync",
            "serve_websocket",
            "serve_dynamodb_stream",
            "serve_eventbridge",
            "serve_kinesis",
            "serve_sns",
            "serve_sqs",
            "handle_lambda",
            "use",
            "use_events",
            "is_lambda",
            "sqs",
            "sns",
            "kinesis",
            "event_bridge",
            "dynamodb",
        }
        self.assertTrue(required.issubset(set(dir(apptheory.SecureApp))))
        self.assertTrue({"handle_strict", "get_strict", "core", "unwrap"}.isdisjoint(set(dir(apptheory.SecureApp))))

    def test_registration_validation_and_routes_are_defensive(self) -> None:
        app = apptheory.SecureApp()
        app.get(" widgets/:id?ignored=true ", _ok, apptheory.authenticated(" read ", "write", "read"))
        app.appsync_field("Subscription", "changed", _ok, apptheory.optional())
        app.websocket(" $default ", _ok, apptheory.internal_only())
        app.get(
            "/statuses",
            _ok,
            apptheory.authenticated_any_of(" read:statuses ", "read", "read:statuses", " "),
        )

        routes = app.routes()
        self.assertEqual(
            [(route.surface, route.method, route.path, route.posture, route.scopes) for route in routes],
            [
                ("http", "GET", "/widgets/{id}", "authenticated", ["read", "write"]),
                ("appsync", "GET", "/changed", "optional", []),
                ("websocket", "", "", "internal_only", []),
                ("http", "GET", "/statuses", "authenticated_any_of", ["read:statuses", "read"]),
            ],
        )
        self.assertEqual(routes[1].appsync_parent_type, "Subscription")
        self.assertEqual(routes[2].websocket_route_key, "$default")
        routes[0].path = "/mutated"
        routes[0].scopes[0] = "mutated"
        self.assertEqual(app.routes()[0].path, "/widgets/{id}")
        self.assertEqual(app.routes()[0].scopes, ["read", "write"])

        with self.assertRaisesRegex(TypeError, "invalid auth posture"):
            app.get("/zero", _ok, object())  # type: ignore[arg-type]
        with self.assertRaisesRegex(TypeError, "normalize to empty"):
            app.get("/empty", _ok, apptheory.authenticated(" "))
        with self.assertRaisesRegex(TypeError, "normalize to empty"):
            app.get("/empty-any", _ok, apptheory.authenticated_any_of())
        with self.assertRaisesRegex(TypeError, "normalize to empty"):
            app.get("/empty-any", _ok, apptheory.authenticated_any_of(" ", "\t"))
        with self.assertRaises(TypeError):
            app.get("/missing", _ok)  # type: ignore[call-arg]
        with self.assertRaisesRegex(apptheory.AppTheoryError, "duplicate route"):
            app.get("/widgets/{id}", _ok, apptheory.public())
        with self.assertRaisesRegex(ValueError, "duplicate websocket route"):
            app.websocket("$default", _ok, apptheory.public())
        with self.assertRaisesRegex(ValueError, "appsync parent type"):
            app.appsync_field("Query", " ", _ok, apptheory.public())

    def test_matched_records_without_posture_fail_closed(self) -> None:
        app = apptheory.SecureApp(tier="p0")
        core = app._SecureApp__core
        core._router.add("GET", "/synthetic", _ok)
        response = app.serve(apptheory.Request(method="GET", path="/synthetic"))
        self.assertEqual(response.status, 500)
        self.assertEqual(json.loads(response.body)["error"]["code"], "app.internal")

        core._ws_routes["synthetic"] = _ok
        output = app.serve_websocket(
            {
                "requestContext": {
                    "routeKey": "synthetic",
                    "connectionId": "c1",
                    "requestId": "r1",
                }
            }
        )
        self.assertEqual(output["statusCode"], 500)
        self.assertEqual(json.loads(output["body"])["error"]["code"], "app.internal")

    def test_principal_accessor_returns_independent_deep_copies(self) -> None:
        source_claims = {"nested": {"values": ["original"]}}

        def resolver(_ctx: apptheory.Context) -> apptheory.SecurePrincipal:
            return apptheory.SecurePrincipal(
                identity=" user ",
                kind="",
                scopes=[" read ", "read"],
                claims=source_claims,
            )

        app = apptheory.SecureApp(principal_resolver=resolver)

        def handler(ctx: apptheory.Context) -> apptheory.Response:
            first = ctx.secure_principal()
            self.assertIsNotNone(first)
            assert first is not None  # noqa: S101
            first.identity = "mutated"
            first.scopes[0] = "mutated"
            first.claims["nested"]["values"][0] = "mutated"
            second = ctx.secure_principal()
            self.assertIsNot(first, second)
            self.assertEqual(second.identity, "user")  # type: ignore[union-attr]
            self.assertEqual(second.scopes, ["read"])  # type: ignore[union-attr]
            self.assertEqual(second.claims, {"nested": {"values": ["original"]}})  # type: ignore[union-attr]
            return apptheory.text(200, "ok")

        app.get("/copy", handler, apptheory.authenticated())
        self.assertEqual(app.serve(apptheory.Request(method="GET", path="/copy")).status, 200)
        self.assertEqual(source_claims, {"nested": {"values": ["original"]}})

    def test_authenticated_any_of_authorization(self) -> None:
        cases = [
            ("unauthenticated", None, 401, "app.unauthorized"),
            ("zero-held", apptheory.SecurePrincipal(identity="user", scopes=[]), 403, "app.forbidden"),
            ("one-held", apptheory.SecurePrincipal(identity="user", scopes=["read"]), 200, ""),
            (
                "several-held",
                apptheory.SecurePrincipal(identity="user", scopes=["read", "read:statuses"]),
                200,
                "",
            ),
        ]
        for name, principal, status, code in cases:
            with self.subTest(name=name):
                app = apptheory.SecureApp(principal_resolver=lambda _ctx, value=principal: value)
                app.get(
                    "/statuses",
                    _ok,
                    apptheory.authenticated_any_of(" read:statuses ", "read", "read:statuses", " "),
                )
                response = app.serve(apptheory.Request(method="GET", path="/statuses"))
                self.assertEqual(response.status, status)
                if code:
                    self.assertEqual(json.loads(response.body)["error"]["code"], code)

                route = app.routes()[0]
                self.assertEqual(route.posture, "authenticated_any_of")
                self.assertEqual(route.scopes, ["read:statuses", "read"])

    def test_websocket_support_controls_lambda_recognition(self) -> None:
        event = {
            "requestContext": {
                "routeKey": "$default",
                "connectionId": "c1",
                "requestId": "r1",
            }
        }
        with self.assertRaisesRegex(RuntimeError, "unknown event type"):
            apptheory.SecureApp().handle_lambda(event)
        output = apptheory.SecureApp(websocket_support=True).handle_lambda(event)
        self.assertEqual(output["statusCode"], 404)

    def test_secure_openapi_exact_join_and_closed_scheme_values(self) -> None:
        app = apptheory.SecureApp()
        app.get("/items/{id}", _ok, apptheory.authenticated("items:read"))
        base = {
            "title": "Secure",
            "version": "1.0.0",
            "routes": [
                {
                    "method": "GET",
                    "path": "/items/:id",
                    "operation_id": "item",
                    "response": {"description": "ok", "fields": []},
                }
            ],
            "security_schemes": {"Bearer": {"type": "http", "scheme": "bearer"}},
            "auth_schemes": {"authenticated": ["Bearer"], "internal_only": []},
        }
        document = app.generate_openapi(base)
        operation = document["paths"]["/items/{id}"]["get"]
        self.assertEqual(document["x-apptheory-contract-mode"], "secure-v1")
        self.assertEqual(operation["x-apptheory-auth-posture"], "authenticated")
        self.assertEqual(operation["security"], [{"Bearer": ["items:read"]}])

        any_of_app = apptheory.SecureApp()
        any_of_app.get(
            "/statuses",
            _ok,
            apptheory.authenticated_any_of(" read:statuses ", "read", "read:statuses"),
        )
        any_of_document = any_of_app.generate_openapi(
            {
                "title": "Secure",
                "version": "1.0.0",
                "routes": [
                    {
                        "method": "GET",
                        "path": "/statuses",
                        "operation_id": "statuses",
                        "response": {"description": "ok", "fields": []},
                    }
                ],
                "security_schemes": {
                    "Bearer": {"type": "http", "scheme": "bearer"},
                    "Cookie": {"type": "apiKey", "in": "cookie", "name": "session"},
                },
                "auth_schemes": {"authenticated": ["Bearer", "Cookie"], "internal_only": []},
            }
        )
        any_of_operation = any_of_document["paths"]["/statuses"]["get"]
        self.assertEqual(any_of_operation["x-apptheory-auth-posture"], "authenticated_any_of")
        self.assertEqual(
            any_of_operation["security"],
            [
                {"Bearer": ["read:statuses"]},
                {"Bearer": ["read"]},
                {"Cookie": ["read:statuses"]},
                {"Cookie": ["read"]},
            ],
        )

        missing = {**base, "routes": []}
        with self.assertRaisesRegex(ValueError, "missing route"):
            app.generate_openapi(missing)
        extra = {
            **base,
            "routes": [
                *base["routes"],
                {"method": "GET", "path": "/extra", "operation_id": "extra", "response": {}},
            ],
        }
        with self.assertRaisesRegex(ValueError, "extra route"):
            app.generate_openapi(extra)
        with self.assertRaisesRegex(ValueError, "binding is required"):
            app.generate_openapi({**base, "auth_schemes": {}})
        with self.assertRaisesRegex(ValueError, "numeric values"):
            app.generate_openapi({**base, "security_schemes": {"Bearer": {"type": "http", "number": 1}}})
        cycle: dict[str, object] = {}
        cycle["self"] = cycle
        with self.assertRaisesRegex(ValueError, "cyclic values"):
            app.generate_openapi({**base, "security_schemes": {"Bearer": cycle}})
        app.generate_openapi(
            {
                **base,
                "security_schemes": {" Bearer ": {"type": "http", "scheme": "bearer"}},
            }
        )
        with self.assertRaisesRegex(ValueError, "duplicated"):
            app.generate_openapi(
                {
                    **base,
                    "security_schemes": {
                        "Bearer": {"type": "http", "scheme": "bearer"},
                        " Bearer ": {"type": "http", "scheme": "bearer"},
                    },
                }
            )

    def test_denial_challenge_headers_render_on_secure_denials(self) -> None:
        challenge = 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"'

        class FixedIds:
            def new_id(self) -> str:
                return "req_denial"

        def denied(_ctx: apptheory.Context) -> None:
            raise apptheory.AppTheoryError("app.unauthorized", "unauthorized").with_headers(
                {"WWW-Authenticate": [challenge]}
            )

        app = apptheory.SecureApp(id_generator=FixedIds(), principal_resolver=denied)
        app.get("/mcp", _ok, apptheory.authenticated())

        response = app.serve(apptheory.Request(method="GET", path="/mcp", headers={}, body=b"", is_base64=False))

        self.assertEqual(response.status, 401)
        self.assertEqual(response.headers["www-authenticate"], [challenge])
        self.assertEqual(response.headers["content-type"], ["application/json; charset=utf-8"])
        self.assertEqual(response.headers["x-request-id"], ["req_denial"])
        body = json.loads(bytes(response.body))
        self.assertEqual(
            body,
            {
                "error": {
                    "code": "app.unauthorized",
                    "message": "unauthorized",
                    "request_id": "req_denial",
                }
            },
        )

    def test_plain_denial_renders_without_challenge_headers(self) -> None:
        def denied(_ctx: apptheory.Context) -> None:
            raise apptheory.AppError("app.unauthorized", "unauthorized")

        app = apptheory.SecureApp(principal_resolver=denied)
        app.get("/mcp", _ok, apptheory.authenticated())

        response = app.serve(apptheory.Request(method="GET", path="/mcp", headers={}, body=b"", is_base64=False))

        self.assertEqual(response.status, 401)
        self.assertNotIn("www-authenticate", response.headers)
        body = json.loads(bytes(response.body))
        self.assertEqual(body["error"]["code"], "app.unauthorized")

    def test_forbidden_denial_carries_bounded_arbitrary_headers(self) -> None:
        challenge = 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"'

        def denied(_ctx: apptheory.Context) -> None:
            raise apptheory.AppTheoryError("app.forbidden", "forbidden").with_headers(
                {
                    "WWW-Authenticate": [challenge],
                    "X-Denial-Reason": ["insufficient_scope"],
                }
            )

        app = apptheory.SecureApp(principal_resolver=denied)
        app.get("/scoped", _ok, apptheory.authenticated("write"))

        response = app.serve(apptheory.Request(method="GET", path="/scoped", headers={}, body=b"", is_base64=False))

        self.assertEqual(response.status, 403)
        self.assertEqual(response.headers["www-authenticate"], [challenge])
        self.assertEqual(response.headers["x-denial-reason"], ["insufficient_scope"])
        body = json.loads(bytes(response.body))
        self.assertEqual(body["error"]["code"], "app.forbidden")


if __name__ == "__main__":
    unittest.main()
