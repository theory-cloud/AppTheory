from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory import (  # noqa: E402
    KEEPER_ALLOWED_NO_EVENTS,
    KEEPER_EVENTS,
    KEEPER_NOT_SHARED,
    compile_visibility_policy,
    keeper_decision,
    log_group_name,
    naming_scope,
    physical_resource_name,
    source_visible,
    synth_check,
    validate_naming_context,
    visibility_manifest,
    visibility_preview,
)


def lab_context(**overrides):
    context = {
        "namespace": "theorycloud",
        "app": "autheory",
        "stage": "lab",
        "account": "998115851393",
        "region": "us-east-1",
    }
    context.update(overrides)
    return context


class NamingContextTests(unittest.TestCase):
    def test_valid_context_is_accepted(self) -> None:
        validate_naming_context(lab_context())

    def test_invalid_context_fields_are_rejected(self) -> None:
        cases = {
            "app": lab_context(app="Autheory"),
            "stage": lab_context(stage="Lab"),
            "account": lab_context(account="99811585"),
            "region": lab_context(region="useast1"),
            "namespace": lab_context(namespace="Theory_Cloud"),
        }
        for field, context in cases.items():
            with self.subTest(field=field):
                with self.assertRaises(ValueError):
                    validate_naming_context(context)


class PhysicalNameTests(unittest.TestCase):
    def test_s3_bucket_uses_account_regional_namespace(self) -> None:
        composed = physical_resource_name(lab_context(), "s3_bucket", "audit-events")
        self.assertEqual(composed["bucket_namespace"], "account-regional")
        self.assertEqual(composed["bucket_name_prefix"], "autheory-lab-audit-events")
        self.assertEqual(composed["name"], "autheory-lab-audit-events-998115851393-us-east-1-an")

    def test_over_budget_dash_name_is_shortened(self) -> None:
        context = lab_context(app="theory-mcp-server", account="191637461429")
        composed = physical_resource_name(
            context, "lambda_function", "namespace-vending/request-claim-handler-version-two"
        )
        self.assertEqual(composed["name"], "theory-mcp-server-lab-namespace-vending-request-claim-h-5mcmmerw")
        self.assertLessEqual(len(composed["name"]), 64)

    def test_legacy_profile_requires_pins(self) -> None:
        context = lab_context(stage="live", naming_profile="legacy")
        with self.assertRaises(ValueError):
            physical_resource_name(context, "dynamodb_table", "events")
        composed = physical_resource_name(
            context, "dynamodb_table", "events", {"dynamodb_table:events": "autheory-autheory-live-events"}
        )
        self.assertEqual(composed, {"name": "autheory-autheory-live-events", "pinned": True})

    def test_generated_entries_are_legacy_only(self) -> None:
        legacy = lab_context(stage="live", naming_profile="legacy")
        self.assertEqual(
            physical_resource_name(legacy, "s3_bucket", "audit-events", None, ["s3_bucket:audit-events"]),
            {"generated": True},
        )
        with self.assertRaises(ValueError):
            physical_resource_name(lab_context(), "s3_bucket", "audit-events", None, ["s3_bucket:audit-events"])
        with self.assertRaises(ValueError):
            physical_resource_name(
                legacy,
                "dynamodb_table",
                "events",
                {"dynamodb_table:events": "autheory-autheory-live-events"},
                ["dynamodb_table:events"],
            )

    def test_generated_api_name_is_rejected(self) -> None:
        legacy = lab_context(stage="live", naming_profile="legacy")
        for resource_type in ("api_rest", "api_http", "api_websocket"):
            with self.assertRaisesRegex(ValueError, "API name takes a pin", msg=resource_type):
                physical_resource_name(legacy, resource_type, "main", None, [f"{resource_type}:main"])

    def test_pin_takes_precedence_under_derived(self) -> None:
        composed = physical_resource_name(
            lab_context(), "dynamodb_table", "events", {"dynamodb_table:events": "autheory-lab-events"}
        )
        self.assertEqual(composed, {"name": "autheory-lab-events", "pinned": True})

    def test_api_websocket_composes(self) -> None:
        composed = physical_resource_name(
            lab_context(app="theory-mcp-server", account="191637461429"), "api_websocket", "agent-sessions"
        )
        self.assertEqual(composed["name"], "theory-mcp-server-lab-agent-sessions")

    def test_log_group_name_maps_logical_path(self) -> None:
        self.assertEqual(
            log_group_name(lab_context(), "logs/runtime/api"),
            "theorycloud_theorycloud_autheory_lab_logs_runtime_api",
        )
        with self.assertRaises(ValueError):
            log_group_name(lab_context(), "runtime/api")


class VisibilityTests(unittest.TestCase):
    rules = {"include": ["logs/runtime/*"], "exclude": ["logs/runtime/debug/*"]}

    def test_exclusions_win_and_lookalikes_do_not_match(self) -> None:
        self.assertTrue(source_visible(self.rules, "logs/runtime/api"))
        self.assertFalse(source_visible(self.rules, "logs/runtime/debug/fulfillment"))
        self.assertFalse(source_visible(self.rules, "logs/runtime-shadow/api"))

    def test_compiled_policy_never_grants_discovery(self) -> None:
        policy = compile_visibility_policy(lab_context(), self.rules)
        rendered = repr(policy)
        for banned in ("DescribeLogGroups", "StartQuery", "StartLiveTail"):
            self.assertNotIn(banned, rendered)
        self.assertEqual([s["Effect"] for s in policy["Statement"]], ["Allow", "Allow", "Deny"])

    def test_preview_matches_contract_vector(self) -> None:
        sources = ["logs/runtime/api", "logs/runtime/debug/fulfillment", "logs/access/api/main"]
        preview = visibility_preview(lab_context(), self.rules, sources)
        self.assertEqual(preview["rule_version"], "ccfcb6ec1e50")
        self.assertEqual(preview["matched_now"], ["logs/runtime/api"])
        self.assertEqual(preview["not_matched_now"], ["logs/access/api/main", "logs/runtime/debug/fulfillment"])

    def test_duplicate_selectors_are_a_set(self) -> None:
        duplicated = {
            "include": ["logs/runtime/*", "logs/runtime/*"],
            "exclude": ["logs/runtime/debug/*", "logs/runtime/debug/*"],
        }
        policy = compile_visibility_policy(lab_context(), duplicated)
        self.assertEqual(len(policy["Statement"][1]["Resource"]), 1)
        self.assertEqual(len(policy["Statement"][2]["Resource"]), 1)
        self.assertEqual(
            visibility_preview(lab_context(), duplicated, ["logs/runtime/api"])["rule_version"],
            visibility_preview(lab_context(), self.rules, ["logs/runtime/api"])["rule_version"],
        )

    def test_preview_and_manifest_reject_invalid_selector(self) -> None:
        invalid = {"include": ["logs/run*time"]}
        with self.assertRaises(ValueError):
            visibility_preview(lab_context(), invalid, ["logs/runtime/api"])
        with self.assertRaises(ValueError):
            visibility_manifest(lab_context(), invalid, ["logs/runtime/api"])

    def test_manifest_omits_private_inventory(self) -> None:
        manifest = visibility_manifest(lab_context(), self.rules, ["logs/runtime/api"])
        self.assertNotIn("not_matched_now", manifest)

    def test_keeper_decision_fails_closed(self) -> None:
        cases = {
            ("logs/runtime/api", "events"): KEEPER_EVENTS,
            ("logs/runtime/api", "empty"): KEEPER_ALLOWED_NO_EVENTS,
            ("logs/runtime/api", "not_found"): KEEPER_ALLOWED_NO_EVENTS,
            ("logs/runtime/api", "denied"): KEEPER_NOT_SHARED,
            ("logs/runtime/api", "unreachable"): KEEPER_NOT_SHARED,
            ("logs/access/api/main", "events"): KEEPER_NOT_SHARED,
        }
        for (logical, aws_result), want in cases.items():
            with self.subTest(logical=logical, aws_result=aws_result):
                self.assertEqual(keeper_decision(self.rules, logical, aws_result), want)
        self.assertEqual(keeper_decision(None, "logs/runtime/api", "events"), KEEPER_NOT_SHARED)

    def test_naming_scope_follows_contract_section_11(self) -> None:
        cases = {
            "iam_role": "account",
            "iam_managed_policy": "account",
            "dashboard": "account",
            "api_rest": "not_unique",
            "api_http": "not_unique",
            "api_websocket": "not_unique",
            "lambda_function": "account_region",
            "log_group": "account_region",
            "s3_bucket": "account_region",
        }
        for resource_type, want in cases.items():
            with self.subTest(resource_type=resource_type):
                self.assertEqual(naming_scope(resource_type), want)
        with self.assertRaisesRegex(ValueError, "no stated naming scope"):
            naming_scope("opensearch_domain")

    def test_synth_check_refuses_one_name_in_one_scope(self) -> None:
        shared = synth_check(
            [
                {"name": "shop-lab-worker", "type": "lambda_function", "logical_id": "Worker"},
                {"name": "shop-lab-worker", "type": "iam_role", "logical_id": "WorkerRole"},
            ]
        )
        self.assertEqual(
            shared,
            [
                {"name": "shop-lab-worker", "type": "lambda_function", "scope": "account_region", "logical_id": "Worker"},
                {"name": "shop-lab-worker", "type": "iam_role", "scope": "account", "logical_id": "WorkerRole"},
            ],
        )

        # Two APIs may share a name: AWS does not keep API display names unique.
        synth_check(
            [
                {"name": "shop-lab-api", "type": "api_http", "logical_id": "First"},
                {"name": "shop-lab-api", "type": "api_http", "logical_id": "Second"},
            ]
        )

        with self.assertRaisesRegex(
            ValueError,
            "LabSiteStatus and SiteStatus derive shop-lab-lab-site-status in scope account",
        ):
            synth_check(
                [
                    {"name": "shop-lab-lab-site-status", "type": "dashboard", "logical_id": "LabSiteStatus"},
                    {"name": "shop-lab-lab-site-status", "type": "dashboard", "logical_id": "SiteStatus"},
                ]
            )

        # A generated entry carries no name and takes no part in the check.
        self.assertEqual(
            synth_check([{"type": "lambda_function", "logical_id": "Worker", "generated": True}]),
            [{"type": "lambda_function", "scope": "account_region", "logical_id": "Worker", "generated": True}],
        )

    def test_synth_check_keeps_types_apart_and_admits_a_redeclaration(self) -> None:
        # Same name, same scope, different types: each type is its own
        # namespace, so one name may belong to a Lambda function and a DynamoDB
        # table at once (contract section 11.2, SANITY-NAMING-R4-06).
        shared = synth_check(
            [
                {"name": "shop-lab-worker", "type": "lambda_function", "logical_id": "Worker"},
                {"name": "shop-lab-worker", "type": "dynamodb_table", "logical_id": "WorkerStore"},
            ]
        )
        self.assertEqual(
            [(row["type"], row["scope"]) for row in shared],
            [("lambda_function", "account_region"), ("dynamodb_table", "account_region")],
        )

        # The same logical id declaring the same name twice is one resource, not
        # a collision: the reference synth_check compares the held logical id
        # (ADV-N3-R0-R1-04).
        repeated = synth_check(
            [
                {"name": "shop-lab-worker", "type": "lambda_function", "logical_id": "Worker"},
                {"name": "shop-lab-worker", "type": "lambda_function", "logical_id": "Worker"},
            ]
        )
        self.assertEqual([row["logical_id"] for row in repeated], ["Worker", "Worker"])

    def test_inherited_property_names_are_unknown_types(self) -> None:
        # Python has no prototype chain, so the equivalent surface is parity: the
        # same names JavaScript inherits must be refused here too (r4,
        # SANITY-AT-N3-03).
        for inherited in ("constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"):
            with self.subTest(resource_type=inherited):
                with self.assertRaisesRegex(ValueError, "no stated naming scope"):
                    naming_scope(inherited)
                with self.assertRaisesRegex(ValueError, "no stated naming scope"):
                    synth_check([{"name": "shop-lab-worker", "type": inherited, "logical_id": "Worker"}])


if __name__ == "__main__":
    unittest.main()
