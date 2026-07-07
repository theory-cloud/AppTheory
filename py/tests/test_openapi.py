from __future__ import annotations

import json
import unittest
from pathlib import Path

import apptheory


class OpenAPITests(unittest.TestCase):
    def test_contract_fixture_canonical_json(self) -> None:
        root = Path(__file__).resolve().parents[2]
        fixture_dir = root / "contract-tests" / "fixtures" / "openapi"

        for fixture_path in sorted(fixture_dir.glob("*.json")):
            with self.subTest(fixture=fixture_path.name):
                fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
                expected_error = fixture["expect"].get("error")
                if expected_error is not None:
                    with self.assertRaisesRegex(ValueError, expected_error["message"]):
                        apptheory.generate_openapi_json(fixture["setup"]["openapi"])
                    continue
                actual = apptheory.generate_openapi_json(fixture["setup"]["openapi"])
                self.assertEqual(actual, fixture["expect"]["output_json"])

    def test_dataclass_spec_normalizes_route_and_tags(self) -> None:
        spec = apptheory.OpenAPISpec(
            title="  Orders API  ",
            version="  v1  ",
            routes=[
                apptheory.OpenAPIRouteSpec(
                    method="GET",
                    path="orders/{order_id}",
                    operation_id="getOrder",
                    tags=["orders", "internal", "orders"],
                    request=apptheory.OpenAPIRequestSpec(
                        fields=[
                            apptheory.OpenAPIFieldSpec(
                                field="order_id",
                                source="path",
                                name="order_id",
                                type="string",
                            ),
                            apptheory.OpenAPIFieldSpec(
                                field="include_items",
                                source="query",
                                name="include_items",
                                type="bool",
                            ),
                        ]
                    ),
                    response=apptheory.OpenAPIResponseSpec(
                        fields=[
                            apptheory.OpenAPIFieldSpec(
                                field="id",
                                source="response",
                                name="id",
                                type="string",
                                required=True,
                            )
                        ]
                    ),
                )
            ],
        )

        document = apptheory.generate_openapi(spec)
        operation = document["paths"]["/orders/{order_id}"]["get"]

        self.assertEqual(document["info"], {"title": "Orders API", "version": "v1"})
        self.assertEqual(operation["tags"], ["internal", "orders"])
        self.assertEqual(operation["parameters"][0]["required"], True)
        self.assertEqual(operation["parameters"][1]["schema"], {"type": "boolean"})

    def test_validation_errors_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "title is required"):
            apptheory.generate_openapi({"title": "", "version": "v1", "routes": []})
        with self.assertRaisesRegex(ValueError, "version is required"):
            apptheory.generate_openapi({"title": "API", "version": "", "routes": []})

        duplicate = {
            "title": "API",
            "version": "v1",
            "routes": [
                {"method": "GET", "path": "/x", "operation_id": "one", "response": {}},
                {"method": "get", "path": "x", "operation_id": "two", "response": {}},
            ],
        }
        with self.assertRaisesRegex(ValueError, "duplicated"):
            apptheory.generate_openapi(duplicate)

        invalid_source = {
            "title": "API",
            "version": "v1",
            "routes": [
                {
                    "method": "GET",
                    "path": "/x",
                    "operation_id": "one",
                    "request": {"fields": [{"field": "raw", "source": "cookie", "name": "raw", "type": "string"}]},
                    "response": {},
                }
            ],
        }
        with self.assertRaisesRegex(ValueError, "unsupported source"):
            apptheory.generate_openapi(invalid_source)

        invalid_status = {
            "title": "API",
            "version": "v1",
            "routes": [{"method": "GET", "path": "/x", "operation_id": "one", "success_status": 99, "response": {}}],
        }
        with self.assertRaisesRegex(ValueError, "success_status must be an HTTP status"):
            apptheory.generate_openapi(invalid_status)

        blank_parameter_name = {
            "title": "API",
            "version": "v1",
            "routes": [
                {
                    "method": "GET",
                    "path": "/x",
                    "operation_id": "one",
                    "request": {"fields": [{"field": "raw", "source": "query", "name": "", "type": "string"}]},
                    "response": {},
                }
            ],
        }
        with self.assertRaisesRegex(ValueError, "name is required"):
            apptheory.generate_openapi(blank_parameter_name)

        blank_response_name = {
            "title": "API",
            "version": "v1",
            "routes": [
                {
                    "method": "GET",
                    "path": "/x",
                    "operation_id": "one",
                    "response": {"fields": [{"field": "raw", "source": "response", "name": "", "type": "string"}]},
                }
            ],
        }
        with self.assertRaisesRegex(ValueError, "name is required"):
            apptheory.generate_openapi(blank_response_name)

        invalid_integer_rule = {
            "title": "API",
            "version": "v1",
            "routes": [
                {
                    "method": "GET",
                    "path": "/x",
                    "operation_id": "one",
                    "request": {
                        "fields": [
                            {
                                "field": "name",
                                "source": "query",
                                "name": "name",
                                "type": "string",
                                "validation": [{"rule": "min_length", "value": 3.5}],
                            }
                        ]
                    },
                    "response": {},
                }
            ],
        }
        with self.assertRaisesRegex(ValueError, "min_length must be an integer"):
            apptheory.generate_openapi(invalid_integer_rule)

        invalid_empty_integer_rule = {
            "title": "API",
            "version": "v1",
            "routes": [
                {
                    "method": "GET",
                    "path": "/x",
                    "operation_id": "one",
                    "request": {
                        "fields": [
                            {
                                "field": "name",
                                "source": "query",
                                "name": "name",
                                "type": "string",
                                "validation": [{"rule": "min_length", "value": ""}],
                            }
                        ]
                    },
                    "response": {},
                }
            ],
        }
        with self.assertRaisesRegex(ValueError, "min_length must be an integer"):
            apptheory.generate_openapi(invalid_empty_integer_rule)

        for invalid_number in ("", "0x10", "nan", "1_000"):
            with self.subTest(invalid_number=invalid_number):
                invalid_numeric_rule = {
                    "title": "API",
                    "version": "v1",
                    "routes": [
                        {
                            "method": "GET",
                            "path": "/x",
                            "operation_id": "one",
                            "request": {
                                "fields": [
                                    {
                                        "field": "count",
                                        "source": "query",
                                        "name": "count",
                                        "type": "integer",
                                        "validation": [{"rule": "min", "value": invalid_number}],
                                    }
                                ]
                            },
                            "response": {},
                        }
                    ],
                }
                with self.assertRaisesRegex(ValueError, "min must be a number"):
                    apptheory.generate_openapi(invalid_numeric_rule)

        invalid_float_nan = {
            "title": "API",
            "version": "v1",
            "routes": [
                {
                    "method": "GET",
                    "path": "/x",
                    "operation_id": "one",
                    "request": {
                        "fields": [
                            {
                                "field": "count",
                                "source": "query",
                                "name": "count",
                                "type": "integer",
                                "validation": [{"rule": "min", "value": float("nan")}],
                            }
                        ]
                    },
                    "response": {},
                }
            ],
        }
        with self.assertRaisesRegex(ValueError, "min must be a number"):
            apptheory.generate_openapi(invalid_float_nan)


if __name__ == "__main__":
    unittest.main()
