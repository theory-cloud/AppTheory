"""Drive the generated CDK Python binding through the jsii kernel.

Contract section 11.4 (synth refusal and the derived-name artifact) is a jsii
surface, so it is proved in TypeScript, Go and Python. The Go half lives in
`cdk-go/apptheorycdk/naming_synth_test.py`'s sibling `naming_synth_test.go`;
this file is the Python half, run by `scripts/verify-cdk-python-bindings.sh`
against the wheel `jsii-pacmak` builds from `cdk/`.

(r4, SANITY-AT-N3-04)
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest

import aws_cdk as cdk
from aws_cdk import aws_lambda as lambda_module

import apptheory_cdk as apptheory

DERIVED_NAMES_KEY = "apptheory:resource-naming/derived-names"


def _stack(app: cdk.App, stack_id: str) -> cdk.Stack:
    return cdk.Stack(
        app,
        stack_id,
        env=cdk.Environment(account="998115851393", region="us-east-1"),
    )


def _context(scope: cdk.Stack) -> apptheory.AppTheoryNamingContext:
    return apptheory.AppTheoryNamingContext(
        scope,
        "Naming",
        app="shop",
        stage="lab",
        account="998115851393",
        region="us-east-1",
    )


def _function(scope: cdk.Stack, construct_id: str, logical: str, context) -> None:
    apptheory.AppTheoryFunction(
        scope,
        construct_id,
        naming_context=context,
        logical_name=logical,
        code=lambda_module.Code.from_inline("exports.handler = async () => ({ statusCode: 204 });"),
        runtime=lambda_module.Runtime.NODEJS_24_X,
        handler="index.handler",
    )


def _artifact_documents(outdir: str, stack_id: str) -> list[dict]:
    path = os.path.join(outdir, f"{stack_id}.metadata.json")
    with open(path, encoding="utf-8") as handle:
        metadata = json.load(handle)
    documents = []
    for entries in metadata.values():
        for entry in entries:
            if entry.get("type") == DERIVED_NAMES_KEY:
                documents.append(entry["data"])
    return documents


def _template(outdir: str, stack_id: str) -> dict:
    path = os.path.join(outdir, f"{stack_id}.template.json")
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


class NamingBindingTests(unittest.TestCase):
    def test_scenario_1_refusal_names_both_logical_ids(self) -> None:
        outdir = tempfile.mkdtemp()
        app = cdk.App(outdir=outdir)
        stack = _stack(app, "Stack")
        context = _context(stack)
        # `site/status` and `site-status` both compose shop-lab-site-status, the
        # separator ambiguity the r4 contract exists to catch.
        _function(stack, "Slash", "site/status", context)
        _function(stack, "Dash", "site-status", context)

        with self.assertRaises(Exception) as raised:
            app.synth()
        message = str(raised.exception)
        self.assertIn("derive shop-lab-site-status in scope account_region", message)
        self.assertIn(
            "two different logical resources in one naming context cannot share a physical name",
            message,
        )
        slash = message.split("SlashFunction")[1][:16] if "SlashFunction" in message else ""
        dash = message.split("DashFunction")[1][:16] if "DashFunction" in message else ""
        self.assertTrue(slash, message)
        self.assertTrue(dash, message)
        self.assertNotEqual(slash, dash)

    def test_scenario_4_artifact_carries_the_expected_rows(self) -> None:
        outdir = tempfile.mkdtemp()
        app = cdk.App(outdir=outdir)
        stack = _stack(app, "Stack")
        context = _context(stack)
        _function(stack, "Worker", "worker", context)
        apptheory.AppTheoryKeeperVisibility(
            stack,
            "Visibility",
            naming_context=context,
            reader_principal_arn="arn:aws:iam::123456789012:role/cloud-keeper",
            rules=apptheory.AppTheoryVisibilityRules(),
        )
        app.synth()

        documents = _artifact_documents(outdir, "Stack")
        self.assertEqual(len(documents), 1)
        document = documents[0]
        self.assertEqual(document["contract"], "theorycloud_resource_naming.v0.1")
        self.assertEqual(document["schema"], "apptheory_resource_naming.derived_names.v1")
        self.assertEqual(document["context"]["app"], "shop")
        self.assertEqual(document["context"]["stage"], "lab")

        rows = [(row["type"], row["name"], row["scope"]) for row in document["entries"]]
        self.assertEqual(
            rows,
            [
                ("iam_role", "shop-lab-keeper-reader", "account"),
                ("iam_role", "shop-lab-worker", "account"),
                ("lambda_function", "shop-lab-worker", "account_region"),
                ("log_group", "/aws/lambda/shop-lab-worker", "account_region"),
                ("ssm_parameter", "/theorycloud/visibility/shop/lab/manifest", "account_region"),
            ],
        )

        logical_ids = set(_template(outdir, "Stack")["Resources"])
        for row in document["entries"]:
            self.assertIn(row["logical_id"], logical_ids)

    def test_stack_attribution_follows_the_owning_stack(self) -> None:
        # A context in one stack used by a construct in another attributes the
        # entry to the stack that holds the logical id (F2 / SANITY-AT-N3-02).
        outdir = tempfile.mkdtemp()
        app = cdk.App(outdir=outdir)
        owner = _stack(app, "Owner")
        consumer = _stack(app, "Consumer")
        context = _context(owner)
        apptheory.AppTheoryBucket(owner, "Assets", naming_context=context, logical="site-assets")
        _function(consumer, "Worker", "worker", context)
        app.synth()

        consumer_documents = _artifact_documents(outdir, "Consumer")
        self.assertEqual(len(consumer_documents), 1)
        consumer_rows = consumer_documents[0]["entries"]
        self.assertTrue(consumer_rows)
        consumer_resources = _template(outdir, "Consumer")["Resources"]
        for row in consumer_rows:
            self.assertIn(row["logical_id"], consumer_resources)

        owner_documents = _artifact_documents(outdir, "Owner")
        self.assertEqual(len(owner_documents), 1)
        owner_rows = owner_documents[0]["entries"]
        self.assertEqual([row["type"] for row in owner_rows], ["s3_bucket"])
        owner_resources = _template(outdir, "Owner")["Resources"]
        for row in owner_rows:
            self.assertIn(row["logical_id"], owner_resources)
            self.assertNotIn(row["logical_id"], consumer_resources)


if __name__ == "__main__":
    unittest.main(verbosity=2)
