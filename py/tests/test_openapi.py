from __future__ import annotations

import json
import unittest
from pathlib import Path

import apptheory


class OpenAPITests(unittest.TestCase):
    def test_contract_fixture_canonical_json(self) -> None:
        root = Path(__file__).resolve().parents[2]
        fixture_path = root / "contract-tests" / "fixtures" / "openapi" / "typed-handler-validation.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

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


if __name__ == "__main__":
    unittest.main()
