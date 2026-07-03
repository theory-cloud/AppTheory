from __future__ import annotations

import json
import unittest
from dataclasses import dataclass
from datetime import timedelta

from apptheory import (
    AppError,
    AppTheoryError,
    BindConfig,
    bind_handler,
    bind_request,
    body,
    format_duration,
    header,
    min_value,
    path,
    query,
    required,
)
from apptheory.context import Context
from apptheory.request import Request


class BindHandlerTests(unittest.TestCase):
    def test_bind_handler_binds_all_sources_and_formats_json(self) -> None:
        @dataclass
        class TypedRequest:
            Name: str = body("name")
            Tenant: str = path("tenant")
            RequestID: str = header("x-request-id")
            Enabled: bool = query("enabled", value_type="bool")
            Ratio: float = query("ratio", value_type="float")
            Tags: list[str] = query("tag", value_type="string", array=True)  # noqa: RUF009
            TTL: timedelta = query("ttl", value_type="duration")  # noqa: RUF009

        ctx = Context(
            request=Request(
                method="POST",
                path="/typed/tenant_123",
                query={"enabled": ["false"], "ratio": ["1.5"], "tag": ["a", "b"], "ttl": ["1h2m3s"]},
                headers={"x-request-id": ["req_1"]},
                body=b'{"name":"Bob"}',
                is_base64=False,
            ),
            params={"tenant": "tenant_123"},
        )
        handler = bind_handler(
            BindConfig(model=TypedRequest, body=True, query=True, path=True, headers=True, success_status=201),
            lambda _ctx, req: {
                "name": req.Name,
                "tenant": req.Tenant,
                "request_id": req.RequestID,
                "enabled": req.Enabled,
                "ratio": req.Ratio,
                "tags": req.Tags,
                "ttl": format_duration(req.TTL),
            },
        )

        resp = handler(ctx)

        self.assertEqual(resp.status, 201)
        self.assertEqual(
            json.loads(resp.body.decode("utf-8")),
            {
                "name": "Bob",
                "tenant": "tenant_123",
                "request_id": "req_1",
                "enabled": False,
                "ratio": 1.5,
                "tags": ["a", "b"],
                "ttl": "1h2m3s",
            },
        )

    def test_bind_request_declarative_validation_returns_canonical_errors(self) -> None:
        @dataclass
        class ProfileRequest:
            name: str = body("name", validate=[required()])
            age: int = body("age", value_type="int", validate=[min_value(18)])

        ctx = Context(
            request=Request(
                method="POST",
                path="/validate",
                query={},
                headers={"content-type": ["application/json"]},
                body=b'{"name":"","age":17}',
                is_base64=False,
            )
        )

        with self.assertRaises(AppTheoryError) as raised:
            bind_request(ctx, BindConfig(model=ProfileRequest, body=True))

        err = raised.exception
        self.assertEqual(err.code, "app.validation_failed")
        self.assertEqual(err.status_code, 422)
        self.assertEqual(
            err.details,
            {
                "errors": [
                    {"field": "name", "rule": "required", "message": "name is required"},
                    {"field": "age", "rule": "min", "message": "age must be >= 18"},
                ]
            },
        )

    def test_binding_errors_precede_validation(self) -> None:
        @dataclass
        class ProfileRequest:
            name: str = body("name", validate=[required()])
            Age: int = query("age", value_type="int", validate=[min_value(18)])

        ctx = Context(
            request=Request(
                method="POST",
                path="/validate-query",
                query={"age": ["not-an-int"]},
                headers={"content-type": ["application/json"]},
                body=b'{"name":"Alice"}',
                is_base64=False,
            )
        )

        with self.assertRaises(AppTheoryError) as raised:
            bind_request(ctx, BindConfig(model=ProfileRequest, body=True, query=True))

        err = raised.exception
        self.assertEqual(err.code, "app.bad_request")
        self.assertEqual(err.status_code, 400)
        self.assertEqual(err.details, {"source": "query", "name": "age", "field": "Age"})

    def test_strict_unknown_and_body_parse_errors_are_canonical(self) -> None:
        @dataclass
        class BodyRequest:
            name: str = body("name")

        config = BindConfig(model=BodyRequest, body=True, strict_json=True)
        unknown_ctx = Context(
            request=Request(method="POST", path="/typed", body=b'{"name":"Bob","extra":true}', is_base64=False)
        )
        with self.assertRaises(AppTheoryError) as raised:
            bind_request(unknown_ctx, config)
        self.assertEqual(raised.exception.details, {"source": "body", "name": "extra"})

        invalid_ctx = Context(request=Request(method="POST", path="/typed", body=b"not-json", is_base64=False))
        with self.assertRaises(AppTheoryError) as invalid:
            bind_request(invalid_ctx, config)
        self.assertEqual(invalid.exception.message, "invalid json")

        empty_ctx = Context(request=Request(method="POST", path="/typed", body=b"", is_base64=False))
        with self.assertRaises(AppTheoryError) as empty:
            bind_request(empty_ctx, config)
        self.assertEqual(empty.exception.message, "request body is empty")

    def test_plain_annotated_models_and_validation_hooks(self) -> None:
        class PlainRequest:
            name: str

            def __init__(self, *, name: str) -> None:
                self.name = name

        ctx = Context(request=Request(method="POST", path="/typed", body=b'{"name":"Bob"}', is_base64=False))
        req = bind_request(ctx, BindConfig(model=PlainRequest, body=True))
        self.assertEqual(req.name, "Bob")

        def app_error(_ctx: Context, _req: PlainRequest) -> None:
            raise AppError("app.validation_failed", "bad input")

        with self.assertRaises(AppTheoryError) as raised:
            bind_request(ctx, BindConfig(model=PlainRequest, body=True, validate=app_error))
        self.assertEqual(raised.exception.status_code, 422)

        def unexpected(_ctx: Context, _req: PlainRequest) -> None:
            raise ValueError("boom")

        with self.assertRaises(AppTheoryError) as generic:
            bind_request(ctx, BindConfig(model=PlainRequest, body=True, validate=unexpected))
        self.assertEqual(generic.exception.code, "app.validation_failed")
        self.assertEqual(generic.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
