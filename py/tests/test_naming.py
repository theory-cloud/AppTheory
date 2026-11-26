from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory import (  # noqa: E402
    HOSTED_NAMESPACE_MAX,
    KEEPER_ALLOWED_NO_EVENTS,
    KEEPER_EVENTS,
    KEEPER_NOT_SHARED,
    compile_visibility_policy,
    keeper_decision,
    log_group_name,
    namespaced_context,
    naming_scope,
    physical_resource_name,
    source_visible,
    synth_check,
    validate_hosted_namespace,
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

# ---- hosted namespaces (contract sections 1, 2, 2.4 and 4, r5) -------------
#
# The five actor/state scenarios of the AT-N5 milestone, one test per scenario,
# so every runtime surface can be compared line for line.


def hosted_context(**overrides):
    context = {
        "namespace": "acme",
        "app": "shop",
        "stage": "lab",
        "account": "123456789012",
        "region": "us-east-1",
        "hosted": True,
    }
    context.update(overrides)
    return context


class HostedNamingTests(unittest.TestCase):
    def test_scenario_1_platform_app_keeps_r4_names(self) -> None:
        platform = {"app": "theory-mcp-server", "stage": "lab", "account": "191637461429", "region": "us-east-1"}
        expected = {
            ("lambda_function", "worker"): {"name": "theory-mcp-server-lab-worker"},
            ("dynamodb_table", "events"): {"name": "theory-mcp-server-lab-events"},
            ("s3_bucket", "media"): {
                "name": "theory-mcp-server-lab-media-191637461429-us-east-1-an",
                "bucket_name_prefix": "theory-mcp-server-lab-media",
                "bucket_namespace": "account-regional",
            },
            ("secret", "provider/stripe"): {"name": "theory-mcp-server/lab/provider/stripe"},
            ("ssm_parameter", "config"): {"name": "/theory-mcp-server/lab/config"},
            ("kms_alias", "data"): {"name": "alias/theory-mcp-server/lab/data"},
            ("log_group", "logs/runtime/api"): {
                "name": "theorycloud_theorycloud_theory-mcp-server_lab_logs_runtime_api"
            },
        }
        for (resource_type, logical), want in expected.items():
            with self.subTest(resource_type=resource_type, logical=logical):
                self.assertEqual(physical_resource_name(platform, resource_type, logical), want)

        # An explicit platform namespace and an omitted one are the same context.
        self.assertFalse(namespaced_context(platform))
        self.assertFalse(namespaced_context({**platform, "namespace": "theorycloud"}))
        self.assertEqual(
            physical_resource_name({**platform, "namespace": "theorycloud"}, "lambda_function", "worker"),
            physical_resource_name(platform, "lambda_function", "worker"),
        )

        # The pins and generated entries a platform app relies on today still apply.
        self.assertEqual(
            physical_resource_name(
                {**platform, "namespace": "theorycloud"},
                "lambda_function",
                "worker",
                {"lambda_function:worker": "theory-mcp-server-lab-worker-v1"},
            ),
            {"name": "theory-mcp-server-lab-worker-v1", "pinned": True},
        )
        self.assertEqual(
            physical_resource_name(
                {**platform, "namespace": "theorycloud", "naming_profile": "legacy"},
                "dynamodb_table",
                "events",
                None,
                ["dynamodb_table:events"],
            ),
            {"generated": True},
        )

    def test_scenario_2_hosted_names_carry_the_namespace(self) -> None:
        cases = [
            (hosted_context(), "lambda_function", "worker", {"name": "acme-shop-lab-worker"}),
            (hosted_context(), "dynamodb_table", "orders", {"name": "acme-shop-lab-orders"}),
            (
                hosted_context(),
                "s3_bucket",
                "uploads",
                {
                    "name": "acme-shop-lab-uploads-123456789012-us-east-1-an",
                    "bucket_name_prefix": "acme-shop-lab-uploads",
                    "bucket_namespace": "account-regional",
                },
            ),
            (
                hosted_context(app="storefront-checkout"),
                "s3_bucket",
                "customer-uploads-archive",
                {
                    "name": "acme-storefront-checkout-lab-5cs2pek2-123456789012-us-east-1-an",
                    "bucket_name_prefix": "acme-storefront-checkout-lab-5cs2pek2",
                    "bucket_namespace": "account-regional",
                },
            ),
            (
                hosted_context(namespace="northwind", app="customer-portal-analytics"),
                "iam_role",
                "keeper-reader-cross-account",
                {"name": "northwind-customer-portal-analytics-lab-keeper-reader-c-r3njssl4"},
            ),
            (hosted_context(), "secret", "provider/stripe", {"name": "acme/shop/lab/provider/stripe"}),
            (
                hosted_context(),
                "ssm_parameter",
                "config/feature-flags",
                {"name": "/acme/shop/lab/config/feature-flags"},
            ),
            (hosted_context(), "kms_alias", "data", {"name": "alias/acme/shop/lab/data"}),
            (
                hosted_context(),
                "log_group",
                "logs/runtime/api",
                {"name": "theorycloud_acme_shop_lab_logs_runtime_api"},
            ),
        ]
        for context, resource_type, logical, want in cases:
            with self.subTest(resource_type=resource_type, logical=logical):
                self.assertEqual(physical_resource_name(context, resource_type, logical), want)

        # A hosted pin is returned verbatim when it starts with its namespace
        # component, exactly where the derived form puts it.
        self.assertEqual(
            physical_resource_name(
                hosted_context(),
                "dynamodb_table",
                "events",
                {"dynamodb_table:events": "acme-shop-lab-events-v1"},
            ),
            {"name": "acme-shop-lab-events-v1", "pinned": True},
        )
        for resource_type, logical, pin in (
            ("ssm_parameter", "config", "/acme/shop/lab/config-v2"),
            ("kms_alias", "data", "alias/acme/shop/lab/data-v2"),
            ("log_group", "logs/runtime/api", "theorycloud_acme_shop_lab_logs_runtime_api"),
        ):
            with self.subTest(resource_type=resource_type):
                physical_resource_name(hosted_context(), resource_type, logical, {f"{resource_type}:{logical}": pin})

    def test_scenario_3_every_broken_hosted_context_is_refused(self) -> None:
        cases = [
            (
                "missing namespace",
                {"app": "shop", "stage": "lab", "account": "123456789012", "region": "us-east-1", "hosted": True},
                None,
                "a hosted deployment must supply its namespace",
            ),
            ("empty namespace", hosted_context(namespace=""), None, "a hosted deployment must supply its namespace"),
            (
                "namespace over 12 characters",
                hosted_context(namespace="northwind-trade"),
                None,
                "hosted namespace longer than 12 characters",
            ),
            (
                "namespace starts with aws",
                hosted_context(namespace="awsome"),
                None,
                "hosted namespace must not start with aws or ssm",
            ),
            (
                "namespace starts with ssm",
                hosted_context(namespace="ssmtools"),
                None,
                "hosted namespace must not start with aws or ssm",
            ),
            (
                "reserved platform namespace",
                hosted_context(namespace="theorycloud"),
                None,
                "namespace theorycloud is reserved for first-party platform apps",
            ),
            (
                "hosted pin without the namespace component",
                hosted_context(),
                {"dynamodb_table:events": "shop-lab-events"},
                "a hosted pin must start with the namespace component",
            ),
            (
                "hosted pin with the namespace as a substring only",
                hosted_context(namespace="hop"),
                {"dynamodb_table:events": "shop-lab-events"},
                "a hosted pin must start with the namespace component",
            ),
        ]
        for name, context, pins, want in cases:
            with self.subTest(name):
                with self.assertRaisesRegex(ValueError, want):
                    physical_resource_name(context, "dynamodb_table", "events", pins)
                if "pin" not in want:
                    with self.assertRaisesRegex(ValueError, want):
                        validate_naming_context(context)

        # The two live-compatibility tools are first-party only (section 4 r5 rev2).
        legacy = hosted_context(naming_profile="legacy")
        for call in (
            lambda: physical_resource_name(
                legacy, "dynamodb_table", "events", {"dynamodb_table:events": "acme-shop-lab-events"}
            ),
            lambda: physical_resource_name(legacy, "dynamodb_table", "events", None, ["dynamodb_table:events"]),
        ):
            with self.assertRaisesRegex(ValueError, "a hosted deployment takes no legacy profile or generated entries"):
                call()

        # The lambda service path is not a hosted log source either.
        with self.assertRaisesRegex(ValueError, "a hosted pin must start with the namespace component"):
            physical_resource_name(
                hosted_context(),
                "log_group",
                "logs/runtime/api",
                {"log_group:logs/runtime/api": "/aws/lambda/acme-shop-lab-worker"},
            )

    def test_scenario_3b_forbidden_profile_refused_without_a_composed_name(self) -> None:
        """SAN-AT-N5-01: the legacy profile is refused at the context.

        The legacy profile is a property of the context, so a hosted context is
        refused when the context is validated -- with no naming declarations at
        all, and with only a log-source name -- not only when a construct
        composes a physical name.
        """
        want = "a hosted deployment takes no legacy profile or generated entries"
        legacy = hosted_context(naming_profile="legacy")

        # No declarations: the context is the only naming input, and it is refused.
        with self.assertRaisesRegex(ValueError, want):
            validate_naming_context(legacy)

        # A log-only declaration: the log-source path refuses too.
        with self.assertRaisesRegex(ValueError, want):
            log_group_name(legacy, "logs/runtime/api")

        # A composed name keeps refusing, on the same reason.
        with self.assertRaisesRegex(ValueError, want):
            physical_resource_name(
                legacy, "dynamodb_table", "events", {"dynamodb_table:events": "acme-shop-lab-events"}
            )

        # A generated entry declared on the context is a context property too.
        with self.assertRaisesRegex(ValueError, want):
            validate_naming_context(hosted_context(generated=["dynamodb_table:events"]))

        # Control: the valid derived hosted context still validates, still
        # resolves a log source, and still composes the hosted name.
        derived = hosted_context()
        validate_naming_context(derived)
        self.assertEqual(log_group_name(derived, "logs/runtime/api"), "theorycloud_acme_shop_lab_logs_runtime_api")
        self.assertEqual(
            physical_resource_name(derived, "lambda_function", "worker"), {"name": "acme-shop-lab-worker"}
        )

        # Control: the platform app keeps the legacy profile, exactly as r4
        # allowed, so the platform path is not narrowed.
        platform = lab_context(naming_profile="legacy")
        validate_naming_context(platform)
        self.assertEqual(
            physical_resource_name(platform, "dynamodb_table", "events", {"dynamodb_table:events": "autheory-lab-events"}),
            {"name": "autheory-lab-events", "pinned": True},
        )

    def test_scenario_4_two_namespaces_stay_distinct(self) -> None:
        acme = physical_resource_name(hosted_context(), "lambda_function", "worker")
        globex = physical_resource_name(hosted_context(namespace="globex"), "lambda_function", "worker")
        self.assertEqual(acme, {"name": "acme-shop-lab-worker"})
        self.assertEqual(globex, {"name": "globex-shop-lab-worker"})
        self.assertNotEqual(acme["name"], globex["name"])

        # The section 11.4 artifact carries the hosted names, so the reservation
        # index reserves the namespaced forms and never collides.
        artifact = synth_check(
            [
                {"name": acme["name"], "type": "lambda_function", "logical_id": "AcmeWorker"},
                {"name": globex["name"], "type": "lambda_function", "logical_id": "GlobexWorker"},
            ]
        )
        self.assertEqual([row["name"] for row in artifact], ["acme-shop-lab-worker", "globex-shop-lab-worker"])

    def test_scenario_5_account_and_region_are_caller_inputs(self) -> None:
        import os

        saved = {}
        for key in ("AWS_ACCOUNT_ID", "AWS_REGION", "AWS_DEFAULT_REGION", "NAMESPACE", "APP_THEORY_NAMESPACE"):
            saved[key] = os.environ.get(key)
            os.environ[key] = "999999999999"
        try:
            self.assertEqual(
                physical_resource_name(hosted_context(), "s3_bucket", "uploads"),
                {
                    "name": "acme-shop-lab-uploads-123456789012-us-east-1-an",
                    "bucket_name_prefix": "acme-shop-lab-uploads",
                    "bucket_namespace": "account-regional",
                },
            )
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

        # An unresolved CDK token is not a concrete account or Region, so synth
        # fails instead of deferring a deploy-time name.
        for context in (
            hosted_context(account="${Token[TOKEN.1]}"),
            hosted_context(region="${Token[TOKEN.2]}"),
            hosted_context(account=""),
            hosted_context(region=""),
        ):
            with self.assertRaises(ValueError):
                validate_naming_context(context)

        # The label rule applies to any non-platform namespace, hosted or not.
        with self.assertRaisesRegex(ValueError, "hosted namespace longer than 12 characters"):
            validate_naming_context(
                {
                    "namespace": "northwind-trade",
                    "app": "shop",
                    "stage": "lab",
                    "account": "123456789012",
                    "region": "us-east-1",
                }
            )

        # The exported surface agrees on the cap and the reserved prefixes.
        self.assertEqual(HOSTED_NAMESPACE_MAX, 12)
        validate_hosted_namespace("twelve-chars")
        validate_hosted_namespace("theorycloud")
        with self.assertRaisesRegex(ValueError, "12 characters"):
            validate_hosted_namespace("thirteen-char")


if __name__ == "__main__":
    unittest.main()
