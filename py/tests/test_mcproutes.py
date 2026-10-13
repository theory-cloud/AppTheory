from __future__ import annotations

import json
import unittest
from pathlib import Path

from apptheory import (
    AGENT_MCP_PATTERN,
    AUTHORIZATION_SERVER_PREFIX,
    CALLBACK_PATTERN_KEY,
    CONTRACT_VERSION,
    CONTRACT_VERSION_V1,
    DEFAULT_CALLBACK_PATH,
    ENDPOINT_KIND_AGENT,
    ENDPOINT_KIND_NAMESPACE,
    ENDPOINT_KIND_PARTNER_AGENT,
    ENDPOINT_KIND_PARTNER_NAMESPACE,
    NAMESPACE_MCP_PATTERN,
    PARTNER_AGENT_MCP_PATTERN,
    PARTNER_NAMESPACE_MCP_PATTERN,
    PROTECTED_RESOURCE_PREFIX,
    EndpointPath,
    authorization_authorize_path_for_resource_path,
    authorization_register_path_for_resource_path,
    authorization_server_path_for_resource_path,
    authorization_server_suffix_path_for_resource_path,
    authorization_token_path_for_resource_path,
    callback_path_for_configured_path,
    normalize_callback_path,
    parse_mcp_path,
    protected_resource_path_for_resource_path,
    protected_resource_path_from_mcp_path,
    resource_path_from_protected_resource_path,
    supported_endpoint_templates,
    supported_issuer_modes,
    supported_oauth_discovery_templates,
    supported_oauth_facade_templates,
    supported_stage_global_routes,
    validate_endpoint_path,
)
from apptheory.mcproutes import _is_path_segment, _normalize_path

EXPECTATIONS_PATH = (
    Path(__file__).resolve().parents[2]
    / "contract-tests"
    / "fixtures"
    / "routing"
    / "mcp-route-algebra"
    / "expectations.json"
)


def load_expectations() -> dict:
    return json.loads(EXPECTATIONS_PATH.read_text(encoding="utf-8"))


def endpoint_from(row: dict) -> EndpointPath:
    return EndpointPath(
        kind=row.get("kind", ""),
        client_namespace=row.get("client_namespace", ""),
        partner_id=row.get("partner_id", ""),
        agent_id=row.get("agent_id", ""),
    )


class McpRouteAlgebraTests(unittest.TestCase):
    def test_shared_expectation_row_counts(self) -> None:
        expected = load_expectations()
        sections = [
            ("contract.patterns", len(expected["contract"]["patterns"]), 4),
            ("normalization", len(expected["normalization"]), 8),
            ("derivations", len(expected["derivations"]), 3),
            ("parser.accept", len(expected["parser"]["accept"]), 4),
            ("parser.reject", len(expected["parser"]["reject"]), 23),
            ("validation", len(expected["validation"]), 23),
            ("whitespace_boundary", len(expected["whitespace_boundary"]), 26),
            ("protected_resource_inverse.accept", len(expected["protected_resource_inverse"]["accept"]), 3),
            ("protected_resource_inverse.reject", len(expected["protected_resource_inverse"]["reject"]), 3),
            ("builders", len(expected["builders"]), 4),
        ]

        total = 0
        for name, got, want in sections:
            with self.subTest(section=name):
                self.assertEqual(got, want)
            total += got
        self.assertEqual(total, 101)

    def test_shared_contract_constants_and_templates(self) -> None:
        contract = load_expectations()["contract"]

        self.assertEqual(CONTRACT_VERSION, contract["version"])
        self.assertEqual(CONTRACT_VERSION_V1, "m17.mcp-route-algebra/v1")
        self.assertEqual(PROTECTED_RESOURCE_PREFIX, contract["protected_resource_prefix"])
        self.assertEqual(AUTHORIZATION_SERVER_PREFIX, contract["authorization_server_prefix"])

        kinds = [
            ENDPOINT_KIND_NAMESPACE,
            ENDPOINT_KIND_PARTNER_NAMESPACE,
            ENDPOINT_KIND_AGENT,
            ENDPOINT_KIND_PARTNER_AGENT,
        ]
        self.assertEqual(kinds, contract["endpoint_kinds"])

        patterns = [
            NAMESPACE_MCP_PATTERN,
            PARTNER_NAMESPACE_MCP_PATTERN,
            AGENT_MCP_PATTERN,
            PARTNER_AGENT_MCP_PATTERN,
        ]
        self.assertEqual(patterns, [row["mcp_pattern"] for row in contract["patterns"]])

        self.assertEqual(
            supported_endpoint_templates(),
            [
                {
                    "kind": row["kind"],
                    "mcp_pattern": row["mcp_pattern"],
                    "protected_resource_path": row["protected_resource_path"],
                }
                for row in contract["patterns"]
            ],
        )
        self.assertEqual(
            supported_oauth_facade_templates(),
            [
                {
                    "kind": row["kind"],
                    "authorize_pattern": row["authorize_path"],
                    "token_pattern": row["token_path"],
                    "register_pattern": row["register_path"],
                }
                for row in contract["patterns"]
            ],
        )
        self.assertEqual(
            supported_oauth_discovery_templates(),
            [
                {
                    "kind": row["kind"],
                    "canonical_pattern": row["authorization_server_path"],
                    "suffix_pattern": row["authorization_server_suffix_path"],
                }
                for row in contract["patterns"]
            ],
        )

    def test_shared_normalization_and_derivations(self) -> None:
        expected = load_expectations()

        for row in expected["normalization"]:
            with self.subTest(row=row["name"]):
                self.assertEqual(_normalize_path(row["input"]), row["normalized"])

        for row in expected["derivations"]:
            with self.subTest(row=row["name"]):
                self.assertEqual(_normalize_path(row["input"]), row["normalized"])
                self.assertEqual(
                    protected_resource_path_for_resource_path(row["input"]),
                    row["protected_resource_path"],
                )
                self.assertEqual(protected_resource_path_from_mcp_path(row["input"]), row["protected_resource_path"])
                self.assertEqual(
                    authorization_server_path_for_resource_path(row["input"]),
                    row["authorization_server_path"],
                )
                self.assertEqual(
                    authorization_authorize_path_for_resource_path(row["input"]),
                    row["authorize_path"],
                )
                self.assertEqual(
                    authorization_token_path_for_resource_path(row["input"]),
                    row["token_path"],
                )
                self.assertEqual(
                    authorization_register_path_for_resource_path(row["input"]),
                    row["register_path"],
                )
                self.assertEqual(
                    authorization_server_suffix_path_for_resource_path(row["input"]),
                    row["authorization_server_suffix_path"],
                )

    def test_shared_ascii_whitespace_boundary(self) -> None:
        expected = load_expectations()
        contract = expected["contract"]

        got_included: list[str] = []
        got_excluded: list[str] = []
        for row in expected["whitespace_boundary"]:
            with self.subTest(code_point=row["code_point"]):
                self.assertEqual(_normalize_path(row["normalization_input"]), row["normalized"])
                self.assertEqual(parse_mcp_path(row["parser_input"]), endpoint_from(row["parser_endpoint"]))
                self.assertEqual(_is_path_segment(row["character"]), row["segment_valid"])
            (got_included if row["in_trim_set"] else got_excluded).append(row["code_point"])

        self.assertEqual(sorted(got_included), sorted(contract["ascii_trim_code_points"]))
        self.assertEqual(sorted(got_excluded), sorted(contract["excluded_whitespace_code_points"]))

    def test_shared_parser_expectations(self) -> None:
        parser = load_expectations()["parser"]

        for row in parser["accept"]:
            with self.subTest(case=f"accept {row['name']}"):
                self.assertEqual(parse_mcp_path(row["input"]), endpoint_from(row["endpoint"]))

        for row in parser["reject"]:
            with self.subTest(case=f"reject {row['name']}"), self.assertRaises(ValueError):
                parse_mcp_path(row["input"])

    def test_shared_validation_expectations(self) -> None:
        for row in load_expectations()["validation"]:
            with self.subTest(case=row["name"]):
                endpoint = endpoint_from(row["endpoint"])
                if row["valid"]:
                    self.assertIsNone(endpoint.validate())
                    self.assertIsNone(validate_endpoint_path(endpoint))
                else:
                    with self.assertRaises(ValueError):
                        endpoint.validate()
                    with self.assertRaises(ValueError):
                        validate_endpoint_path(endpoint)

    def test_shared_builder_expectations(self) -> None:
        for row in load_expectations()["builders"]:
            endpoint = endpoint_from(row["endpoint"])
            with self.subTest(endpoint=row["endpoint"]):
                self.assertEqual(endpoint.mcp_path(), row["mcp_path"])
                self.assertEqual(endpoint.protected_resource_path(), row["protected_resource_path"])
                self.assertEqual(endpoint.oauth_authorization_server_path(), row["authorization_server_path"])
                self.assertEqual(endpoint.oauth_authorize_path(), row["authorize_path"])
                self.assertEqual(endpoint.oauth_token_path(), row["token_path"])
                self.assertEqual(endpoint.oauth_register_path(), row["register_path"])
                self.assertEqual(
                    endpoint.oauth_authorization_server_suffix_path(),
                    row["authorization_server_suffix_path"],
                )

    def test_stage_global_callback_and_issuer_modes(self) -> None:
        expected = load_expectations()
        rows = expected["stage_global"]
        self.assertEqual(len(rows), 1)
        routes = supported_stage_global_routes()
        self.assertEqual(
            [{"name": r.name, "pattern": r.pattern, "methods": r.methods} for r in routes],
            rows,
        )
        self.assertEqual(CALLBACK_PATTERN_KEY, rows[0]["name"])
        self.assertEqual(DEFAULT_CALLBACK_PATH, rows[0]["pattern"])
        self.assertEqual(supported_issuer_modes(), expected["issuer_modes"])

        table = expected["callback_path"]
        self.assertEqual(DEFAULT_CALLBACK_PATH, table["default"])
        for row in table["accept"]:
            with self.subTest(configured=row["configured"]):
                self.assertEqual(callback_path_for_configured_path(row["configured"]), row["expected"])

        for bad in table["reject"]:
            with self.subTest(rejected=bad), self.assertRaises(ValueError):
                normalize_callback_path(bad)

    def test_shared_protected_resource_inverse_expectations(self) -> None:
        expected = load_expectations()["protected_resource_inverse"]

        for row in expected["accept"]:
            with self.subTest(input=row["input"]):
                self.assertEqual(resource_path_from_protected_resource_path(row["input"]), row["resource_path"])

        for input_path in expected["reject"]:
            with self.subTest(input=input_path), self.assertRaises(ValueError):
                resource_path_from_protected_resource_path(input_path)

    def test_endpoint_path_builders_reject_invalid_endpoint(self) -> None:
        invalid = EndpointPath(kind=ENDPOINT_KIND_PARTNER_AGENT, client_namespace="acme", partner_id="pay")
        with self.assertRaises(ValueError):
            validate_endpoint_path(invalid)

        builders = [
            invalid.mcp_path,
            invalid.protected_resource_path,
            invalid.oauth_authorization_server_path,
            invalid.oauth_authorize_path,
            invalid.oauth_token_path,
            invalid.oauth_register_path,
            invalid.oauth_authorization_server_suffix_path,
        ]
        for builder in builders:
            with self.subTest(builder=builder.__name__), self.assertRaises(ValueError):
                builder()


if __name__ == "__main__":
    unittest.main()
