#!/usr/bin/env python3
"""Self-tests for the AppTheory local examples harness.

They run before every ``make examples-local``. They pin the discovery
conventions against the real tree and prove manifest validation fails closed
when an entrypoint is unclassified, when a row names a file that does not
exist, and when the local profile drifts onto a reserved port.

Every case is pure validation over the real tree or a throwaway tree under the
system temp directory, except ``DockerImageStoreTests``: it reads the image
store of a local daemon, skips when none answers, and removes what it builds.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import run_examples_local as harness  # noqa: E402


def write(root: Path, relative: str, content: str = "") -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


FIDELITY_CLASSES = ("L1", "L2", "L3", "I")


def fidelity_table_errors(document: str, entries: list[harness.Entry]) -> list[str]:
    """Check the fidelity table against the manifest, row by row.

    Every classified entrypoint must appear exactly once in the table, under the
    class the manifest gives it. The table is the document a developer trusts for
    a row's class, so a missing, duplicated or misclassified row is an error.
    """
    stated: dict[str, list[str]] = {}
    in_table = False
    for line in document.splitlines():
        if line.startswith("### ") and "rows" in line:
            in_table = True
            continue
        if line.startswith("## ") or (line.startswith("### ") and "rows" not in line):
            in_table = False
            continue
        if not in_table or not line.startswith("| `"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 2 or cells[1] not in FIDELITY_CLASSES:
            continue
        for path in re.findall(r"`([^`]+)`", cells[0]):
            stated.setdefault(path, []).append(cells[1])

    errors = []
    for entry in entries:
        if entry.kind != "entrypoint" or not entry.class_name:
            continue
        classes = stated.get(entry.key, [])
        if not classes:
            errors.append(f"{entry.key}: missing from the fidelity table")
        elif len(classes) > 1:
            errors.append(f"{entry.key}: listed {len(classes)} times ({', '.join(classes)})")
        elif classes[0] != entry.class_name:
            errors.append(
                f"{entry.key}: listed as {classes[0]}, but the manifest class is {entry.class_name}"
            )
    return errors


class RealTreeTests(unittest.TestCase):
    """The checked-in manifest must classify every discovered entrypoint."""

    def test_manifest_validates_against_the_real_tree(self) -> None:
        profile, entries = harness.load_manifest(harness.MANIFEST_PATH)
        discovered = harness.discover(harness.ROOT)
        errors = harness.validate_manifest(
            harness.ROOT,
            harness.MANIFEST_PATH,
            profile,
            entries,
            discovered,
            harness.RUNNERS,
        )
        self.assertEqual([], errors)
        self.assertGreater(len(discovered), 40)

    def test_readme_rows_state_the_manifest_class(self) -> None:
        _, entries = harness.load_manifest(harness.MANIFEST_PATH)
        readme = (harness.ROOT / "examples" / "README.md").read_text(encoding="utf-8")
        rows = []
        for line in readme.splitlines():
            if not line.startswith("| `examples/"):
                continue
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            match = re.search(r"`(examples/[^`]+)`", cells[0])
            self.assertIsNotNone(match, line)
            rows.append((match.group(1), cells[2]))
        self.assertGreater(len(rows), 15)
        for path, stated in rows:
            classes = {
                entry.class_name
                for entry in entries
                if entry.kind == "entrypoint"
                and (entry.key == path or entry.key.startswith(path.rstrip("/") + "/"))
                and entry.class_name
            }
            self.assertTrue(classes, f"{path} names no manifest entrypoint")
            for klass in sorted(classes):
                self.assertRegex(
                    stated,
                    rf"(?<![A-Za-z0-9]){re.escape(klass)}(?![A-Za-z0-9])",
                    f"{path}: the row must state class {klass}: {stated!r}",
                )

    def test_fidelity_table_matches_the_manifest(self) -> None:
        _, entries = harness.load_manifest(harness.MANIFEST_PATH)
        document = (harness.ROOT / "docs" / "examples" / "local-harness.md").read_text(encoding="utf-8")
        self.assertEqual([], fidelity_table_errors(document, entries))

    def test_fidelity_table_checker_fails_closed(self) -> None:
        entry = harness.Entry(key="examples/a/main.go", kind="entrypoint", data={"class": "L2", "run": "row"})
        misclassified = "### L1 rows\n\n| `examples/a/main.go` | L1 | proof | — |\n"
        self.assertEqual(
            ["examples/a/main.go: listed as L1, but the manifest class is L2"],
            fidelity_table_errors(misclassified, [entry]),
        )
        missing = fidelity_table_errors("### L1 rows\n\n", [entry])
        self.assertEqual(["examples/a/main.go: missing from the fidelity table"], missing)
        duplicated = (
            "### L2 rows\n\n"
            "| `examples/a/main.go` | L2 | proof | — |\n"
            "| `examples/a/main.go` | L2 | proof | — |\n"
        )
        self.assertEqual(
            ["examples/a/main.go: listed 2 times (L2, L2)"],
            fidelity_table_errors(duplicated, [entry]),
        )

    def test_documented_exclusions_hold_in_the_real_tree(self) -> None:
        discovered = harness.discover(harness.ROOT)
        self.assertIn("examples/cdk/hello-world/bin/apptheory-hello-world.ts", discovered)
        self.assertIn("examples/cdk/multilang/bin/apptheory-multilang.ts", discovered)
        self.assertNotIn(
            "examples/cdk/hello-world/lib/hello-world-stack.ts", discovered
        )
        self.assertNotIn(
            "examples/cdk/hello-world/handlers/ts/handler.test.mjs", discovered
        )
        self.assertNotIn(
            "examples/cdk/ssr-only-provided-assets-site/assets/app.js", discovered
        )
        self.assertNotIn(
            "examples/migration/rate-limited-http/before/main.go", discovered
        )
        self.assertFalse(any(".cdk-asset-stage" in path for path in discovered))
        self.assertFalse(any("node_modules" in path for path in discovered))

    def test_a5b_rows_are_wired(self) -> None:
        _, entries = harness.load_manifest(harness.MANIFEST_PATH)
        self.assertEqual([], [entry.key for entry in entries if entry.pending])
        classified = [entry for entry in entries if not entry.pending]
        # 59 wave-1/P1 rows, the E6 SNS targets row and consumer, the E3
        # sqs-event-targets row with its publisher, the covered Kinesis log tap
        # and rule target handlers, the wave-2 E4 S3 consumer, R1 WebSocket
        # authorizer, R2a authorizer echo, R2b policy authorizer and R4
        # lambda-packaging rows, the R3a Runtime API conformance suite, the
        # AD1 two-edit watch row, the KMS DIGEST/data-dir rows, the S3
        # SSE-S3 row, the seven LOCAL-W2-TLS rows, the five
        # LOCAL-W2-TLS-GAPS rows, the origin-redirect row, the six
        # LOCAL-W3-M1 resource-type rows, the fourteen narrow-IAM rows, the
        # five co-residence/declared-port rows, the two mail-surface rows and
        # the ten LOCAL-W3-X5 MCP refresh rows (three covered helpers, seven
        # executing), and the two LOCAL-W3-X6 rows with the versioning handler
        # they cover.
        self.assertEqual(146, len(classified))
        by_key = {entry.key: entry for entry in entries}
        expected = {
            "examples/cdk/ssr-site/bin/apptheory-ssr-site.ts": "ssr-site-gateway",
            "examples/cdk/ssr-only-provided-assets-site/bin/app.ts": "ssr-only-gateway",
            "examples/cdk/path-routed-frontend/bin/app.ts": "path-routed-gateway",
            "examples/cdk/media-cdn/bin/app.ts": "media-cdn-gateway",
            "examples/cdk/edge-gateway/bin/app.ts": "edge-gateway",
            "examples/cdk/ssr-site/scripts/generate-assets-manifest.mjs": "ssr-assets-manifest",
            "examples/cdk/ssr-site/scripts/upload-assets.sh": "ssr-assets-upload",
            "examples/cdk/kinesis-cloudwatch-logs/handlers/signing/main.go": "kinesis-signing",
            "examples/cdk/kinesis-cloudwatch-logs/scripts/data-dir-kms.sh": "data-dir-kms",
            "examples/cdk/lambda-role/scripts/s3-sse.sh": "s3-sse",
            "examples/cdk/sqs-queue/handlers/sns-publisher.mjs": "sqs-sns-publisher",
            "examples/cdk/sqs-queue/handlers/sns-scenario-publisher.mjs": "sqs-sns-targets",
            "examples/cdk/sqs-queue/handlers/rule-publisher.mjs": "sqs-event-targets",
            "examples/cdk/local-tls/bin/app.ts": "local-tls-surfaces",
            "examples/cdk/local-resources/scripts/inventory.sh": "local-resources-inventory",
            "examples/cdk/local-resources/scripts/custom-resources.sh": "local-resources-custom",
            "examples/cdk/local-resources/scripts/ses-receipt.sh": "local-resources-ses-receipt",
            "examples/cdk/local-iam/scripts/grants.sh": "local-iam-grants",
            "examples/cdk/local-iam/scripts/refusals.sh": "local-iam-refusals",
            "examples/cdk/local-iam/scripts/function-url.sh": "local-iam-function-url",
            "examples/cdk/local-iam/scripts/shared-plane.sh": "local-iam-shared-plane",
            "examples/cdk/local-mcp-auth-facade/scripts/rotation-chain.py": "mcp-facade-rotation-chain",
            "examples/cdk/local-mcp-auth-facade/scripts/stale-predecessor.py": "mcp-facade-stale-predecessor",
            "examples/cdk/local-mcp-auth-facade/scripts/concurrent-refresh.py": "mcp-facade-concurrent-refresh",
            "examples/cdk/local-mcp-auth-facade/scripts/restart-mid-chain.py": "mcp-facade-restart-mid-chain",
            "examples/cdk/local-mcp-auth-facade/scripts/retry-storm.py": "mcp-facade-retry-storm",
            "examples/cdk/local-mcp-auth-facade/scripts/genuine-replay.py": "mcp-facade-genuine-replay",
            "examples/cdk/local-mcp-auth-facade/scripts/legacy-continuity.py": "mcp-facade-legacy-continuity",
            "examples/cdk/local-tls/handlers/go/main.go": "local-tls-callback-go",
            "examples/cdk/local-tls/scripts/callback-node.sh": "local-tls-callback-node",
            "examples/cdk/local-tls/handlers/python/caller.py": "local-tls-callback-py",
            "examples/cdk/local-tls/scripts/oidc.sh": "local-tls-oidc",
            "examples/cdk/local-tls/scripts/browser-webauthn.sh": "local-tls-webauthn",
            "examples/cdk/local-tls/scripts/aux-cert.sh": "local-tls-aux-cert",
            "examples/cdk/local-tls/scripts/awssdk-go.sh": "local-tls-awssdk-go",
            "examples/cdk/local-tls/scripts/awssdk-node.sh": "local-tls-awssdk-node",
            "examples/cdk/local-tls/scripts/awssdk-py.sh": "local-tls-awssdk-py",
            "examples/cdk/local-tls/scripts/cloudfront-origin.sh": "local-tls-cloudfront-origin",
            "examples/cdk/local-tls/scripts/cloudfront-redirect.sh": "local-tls-cloudfront-redirect",
            "examples/cdk/local-tls/scripts/cloudfront-http-only-error.sh": "local-tls-cloudfront-http-only-error",
        }
        for key, runner in expected.items():
            self.assertEqual(runner, by_key[key].runner, key)
            self.assertIn(by_key[key].class_name, harness.CLASSES, key)

    def test_l3_rows_name_a_gap(self) -> None:
        _, entries = harness.load_manifest(harness.MANIFEST_PATH)
        for entry in entries:
            if entry.class_name == "L3":
                self.assertTrue(
                    str(entry.data.get("gap", "")).strip(),
                    f"{entry.key}: an L3 row must name its cloud gap",
                )

    def test_profile_ports_stay_off_reserved_ranges(self) -> None:
        profile, _ = harness.load_manifest(harness.MANIFEST_PATH)
        ports = profile["ports"]
        for slot in range(harness.slot_count(profile)):
            base, http_port, aux_port = harness.slot_ports(profile, slot)
            for port in (base, http_port, aux_port):
                self.assertGreaterEqual(port, ports["first"])
                self.assertLessEqual(port, ports["last"])
                self.assertNotIn(port, harness.PORT_RESERVED)


class DiscoveryTests(unittest.TestCase):
    """Discovery is structural, so a rogue entrypoint cannot hide."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="apptheory-harness-test-"))
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_rogue_entrypoints_are_discovered(self) -> None:
        write(self.root, "examples/demo/main.go", "package main\nfunc main() {}\n")
        write(self.root, "examples/demo/run.mjs", "console.log('x')\n")
        write(self.root, "examples/demo/tool.py", "print('x')\n")
        write(self.root, "examples/demo/entry.sh", "#!/bin/sh\n")
        write(self.root, "examples/demo/bin/app.ts", "export {};\n")
        discovered = harness.discover(self.root)
        for path in (
            "examples/demo/main.go",
            "examples/demo/run.mjs",
            "examples/demo/tool.py",
            "examples/demo/entry.sh",
            "examples/demo/bin/app.ts",
        ):
            self.assertIn(path, discovered)

    def test_support_files_and_build_ignore_are_not_entrypoints(self) -> None:
        write(self.root, "examples/demo/lib/stack.ts", "export {};\n")
        write(self.root, "examples/demo/assets/app.js", "console.log('x')\n")
        write(self.root, "examples/demo/main.test.mjs", "console.log('x')\n")
        write(self.root, "examples/demo/main_test.go", "package main\nfunc main() {}\n")
        write(
            self.root,
            "examples/demo/before/main.go",
            "//go:build ignore\n\npackage main\nfunc main() {}\n",
        )
        write(
            self.root,
            "examples/demo/generated.ts",
            "// Code generated by tool. DO NOT EDIT.\n",
        )
        write(self.root, "examples/demo/.cdk-asset-stage/ts/handler.mjs", "export {};\n")
        self.assertEqual({}, harness.discover(self.root))


class ManifestFailureTests(unittest.TestCase):
    """Manifest validation must fail closed, with the reason named."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="apptheory-harness-test-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.image = f"amazon/dynamodb-local@sha256:{'a' * 64}"
        self.profile = {
            "composeFile": "scripts/local/docker-compose.yml",
            "dynamodbLocal": {"image": self.image, "port": 8130},
            "ports": {"first": 8130, "last": 8199, "stride": 10},
            "lambda": {
                "images": {
                    "go": {"tag": "public.ecr.aws/lambda/provided:al2023", "digest": f"sha256:{'b' * 64}"},
                    "node": {"tag": "public.ecr.aws/lambda/nodejs:24", "digest": f"sha256:{'c' * 64}"},
                    "python": {"tag": "public.ecr.aws/lambda/python:3.14", "digest": f"sha256:{'d' * 64}"},
                }
            },
            "endpoints": {
                "dynamodb": {"env": ["AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_DYNAMODB"]},
            },
        }
        write(self.root, "scripts/local/docker-compose.yml", self._compose_text(8130))
        write(self.root, "examples/demo/main.go", "package main\nfunc main() {}\n")
        write(self.root, "examples/demo/run.mjs", "console.log('x')\n")
        write(self.root, "examples/demo/extra.py", "print('x')\n")
        self.discovered = harness.discover(self.root)

    def _compose_text(self, port: int) -> str:
        return (
            "services:\n"
            "  dynamodb-local:\n"
            f"    image: {self.image}\n"
            "    ports:\n"
            f'      - "127.0.0.1:${{APPTHEORY_LOCAL_DDB_PORT:-{port}}}:8000"\n'
        )

    def entries(self, rows: dict) -> list[harness.Entry]:
        return [harness.Entry(key=key, kind="entrypoint", data=data) for key, data in rows.items()]

    def validate(self, rows: dict) -> list[str]:
        runners = {name: (lambda _harness: "ok") for name in ("run", "run2", "run3")}
        return harness.validate_manifest(
            self.root,
            Path("examples-local.json"),
            self.profile,
            self.entries(rows),
            self.discovered,
            runners,
        )

    def test_unclassified_entrypoint_fails(self) -> None:
        rows = {
            "examples/demo/main.go": {"run": "run", "class": "L1"},
            "examples/demo/run.mjs": {"run": "run2", "class": "L1"},
        }
        errors = self.validate(rows)
        self.assertTrue(
            any("unclassified entrypoint" in error and "extra.py" in error for error in errors),
            errors,
        )

    def test_pending_row_naming_a_missing_file_fails(self) -> None:
        rows = {
            "examples/demo/main.go": {"run": "run", "class": "L1"},
            "examples/demo/run.mjs": {"run": "run2", "class": "L1"},
            "examples/demo/extra.py": {"pending": "A4"},
            "examples/demo/missing.py": {"pending": "A4"},
        }
        errors = self.validate(rows)
        self.assertTrue(
            any("does not name a file in the tree" in error for error in errors), errors
        )

    def test_class_and_pending_are_exclusive(self) -> None:
        rows = {
            "examples/demo/main.go": {"run": "run", "class": "L1"},
            "examples/demo/run.mjs": {"run": "run2", "class": "L1"},
            "examples/demo/extra.py": {"run": "run3", "class": "L1", "pending": "A4"},
        }
        errors = self.validate(rows)
        self.assertTrue(any("declare either class or pending" in error for error in errors), errors)

    def test_a_suite_script_must_name_a_real_file(self) -> None:
        rows = {
            "examples/demo/main.go": {"run": "run", "class": "L1"},
            "examples/demo/run.mjs": {"run": "run2", "class": "L1"},
            "examples/demo/extra.py": {"pending": "A4"},
        }
        entries = self.entries(rows) + [
            harness.Entry(
                key="scripts/local/missing_conformance.py",
                kind="suite",
                data={"class": "L2", "run": "run3", "script": "scripts/local/missing_conformance.py"},
            )
        ]
        runners = {"run": lambda _harness: "ok", "run2": lambda _harness: "ok", "run3": lambda _harness: "ok"}
        errors = harness.validate_manifest(
            self.root, Path("examples-local.json"), self.profile, entries, self.discovered, runners
        )
        self.assertTrue(
            any("suite script does not name a file in the tree" in error for error in errors), errors
        )

        write(self.root, "scripts/local/conformance.py", "print('ok')\n")
        entries[-1] = harness.Entry(
            key="scripts/local/conformance.py",
            kind="suite",
            data={"class": "L2", "run": "run3", "script": "scripts/local/conformance.py"},
        )
        errors = harness.validate_manifest(
            self.root, Path("examples-local.json"), self.profile, entries, self.discovered, runners
        )
        self.assertEqual([], errors)

    def test_covered_by_resolves_to_a_running_row(self) -> None:
        rows = {
            "examples/demo/main.go": {"run": "run", "class": "I"},
            "examples/demo/run.mjs": {"coveredBy": "examples/demo/main.go", "class": "I"},
            "examples/demo/extra.py": {"pending": "A4"},
        }
        self.assertEqual([], self.validate(rows))

    def test_reserved_profile_port_fails(self) -> None:
        self.profile["dynamodbLocal"]["port"] = 8000
        rows = {
            "examples/demo/main.go": {"run": "run", "class": "L1"},
            "examples/demo/run.mjs": {"run": "run2", "class": "L1"},
            "examples/demo/extra.py": {"pending": "A4"},
        }
        errors = self.validate(rows)
        self.assertTrue(any("reserved" in error for error in errors), errors)

    def test_tag_only_image_fails_digest_pinning(self) -> None:
        self.profile["dynamodbLocal"]["image"] = "amazon/dynamodb-local:3.1.0"
        write(self.root, "scripts/local/docker-compose.yml", self._compose_text(8130).replace(self.image, "amazon/dynamodb-local:3.1.0"))
        rows = {
            "examples/demo/main.go": {"run": "run", "class": "L1"},
            "examples/demo/run.mjs": {"run": "run2", "class": "L1"},
            "examples/demo/extra.py": {"pending": "A4"},
        }
        errors = self.validate(rows)
        self.assertTrue(any("DynamoDB Local image must be pinned by digest" in error for error in errors), errors)

    def test_tag_only_lambda_image_fails_digest_pinning(self) -> None:
        self.profile["lambda"]["images"]["go"]["digest"] = ""
        rows = {
            "examples/demo/main.go": {"run": "run", "class": "L1"},
            "examples/demo/run.mjs": {"run": "run2", "class": "L1"},
            "examples/demo/extra.py": {"pending": "A4"},
        }
        errors = self.validate(rows)
        self.assertTrue(any("lambda.images.go must be pinned by digest" in error for error in errors), errors)

    def test_lambda_image_must_match_its_runtime(self) -> None:
        self.profile["lambda"]["images"]["go"]["tag"] = "public.ecr.aws/lambda/nodejs:24"
        rows = {
            "examples/demo/main.go": {"run": "run", "class": "L1"},
            "examples/demo/run.mjs": {"run": "run2", "class": "L1"},
            "examples/demo/extra.py": {"pending": "A4"},
        }
        errors = self.validate(rows)
        self.assertTrue(any("not an official image" in error for error in errors), errors)

    def test_missing_endpoint_declarations_fail(self) -> None:
        del self.profile["endpoints"]
        rows = {
            "examples/demo/main.go": {"run": "run", "class": "L1"},
            "examples/demo/run.mjs": {"run": "run2", "class": "L1"},
            "examples/demo/extra.py": {"pending": "A4"},
        }
        errors = self.validate(rows)
        self.assertTrue(any("missing endpoints" in error for error in errors), errors)

    def test_unknown_milestone_fails(self) -> None:
        rows = {
            "examples/demo/main.go": {"run": "run", "class": "L1"},
            "examples/demo/run.mjs": {"run": "run2", "class": "L1"},
            "examples/demo/extra.py": {"pending": "T9"},
        }
        errors = self.validate(rows)
        self.assertTrue(any("unknown milestone" in error for error in errors), errors)


class LeaseTests(unittest.TestCase):
    """The compose project and ports derive from the checkout path."""

    def test_checkout_identifier_is_stable_and_path_specific(self) -> None:
        first = harness.checkout_identifier(harness.ROOT)
        self.assertEqual(first, harness.checkout_identifier(harness.ROOT))
        self.assertEqual(8, len(first))
        with tempfile.TemporaryDirectory(prefix="apptheory-lease-") as other:
            self.assertNotEqual(first, harness.checkout_identifier(Path(other)))

    def test_slots_are_isolated(self) -> None:
        profile, _ = harness.load_manifest(harness.MANIFEST_PATH)
        seen: set[int] = set()
        for slot in range(harness.slot_count(profile)):
            base, http_port, aux_port = harness.slot_ports(profile, slot)
            self.assertNotIn(base, seen)
            self.assertNotIn(http_port, seen)
            self.assertNotIn(aux_port, seen)
            seen.update((base, http_port, aux_port))


class LocalRunnerHelperTests(unittest.TestCase):
    """The A3b helpers keep the wire format and assertions honest."""

    def test_parse_sse_reads_ids_and_data(self) -> None:
        events = harness._parse_sse(
            "id: 1\ndata: \n\n"
            'id: 2\nevent: message\ndata: {"jsonrpc":"2.0"}\n\n'
        )
        self.assertEqual([("1", ""), ("2", '{"jsonrpc":"2.0"}')], events)

    def test_mcp_event_is_an_http_api_v2_request(self) -> None:
        event = harness.mcp_event(
            "tools/list", session="abc123", protocol="2025-11-25"
        )
        self.assertEqual("2.0", event["version"])
        self.assertEqual("POST /mcp", event["routeKey"])
        self.assertEqual("local.execute-api.us-east-1.amazonaws.com", event["requestContext"]["domainName"])
        self.assertEqual("abc123", event["headers"]["mcp-session-id"])
        self.assertEqual("2025-11-25", event["headers"]["mcp-protocol-version"])
        self.assertFalse(event["isBase64Encoded"])

    def test_request_id_accepts_both_runtime_shapes(self) -> None:
        harness._assert_request_id({"request_id": "a" * 32}, "hex")
        harness._assert_request_id({"request_id": "7f08dd02-7030-4ecc-9c60-0cd609076abf"}, "uuid")
        with self.assertRaises(harness.HarnessFailure):
            harness._assert_request_id({"request_id": ""}, "empty")


class AwsCLIRequirementTests(unittest.TestCase):
    """The upload row requires a working host AWS CLI; it never installs one."""

    def test_missing_cli_fails_with_the_requirement(self) -> None:
        with mock.patch.object(harness.shutil, "which", return_value=None):
            with self.assertRaises(harness.HarnessFailure) as raised:
                harness.require_aws_cli()
        self.assertIn("requires an AWS CLI on PATH", str(raised.exception))

    def test_unstartable_cli_fails_with_the_requirement(self) -> None:
        failed = mock.Mock(returncode=127, stdout="", stderr="dyld: Library not loaded")
        with mock.patch.object(harness.shutil, "which", return_value="/opt/homebrew/bin/aws"):
            with mock.patch.object(harness.subprocess, "run", return_value=failed):
                with self.assertRaises(harness.HarnessFailure) as raised:
                    harness.require_aws_cli()
        self.assertIn("requires an AWS CLI on PATH that starts", str(raised.exception))

    def test_unrunnable_cli_fails_with_the_requirement(self) -> None:
        with mock.patch.object(harness.shutil, "which", return_value="/opt/homebrew/bin/aws"):
            with mock.patch.object(harness.subprocess, "run", side_effect=OSError("cannot execute")):
                with self.assertRaises(harness.HarnessFailure) as raised:
                    harness.require_aws_cli()
        self.assertIn("requires an AWS CLI on PATH that starts", str(raised.exception))

    def test_working_cli_returns_its_path(self) -> None:
        working = mock.Mock(returncode=0, stdout="aws-cli/2.39.3", stderr="")
        with mock.patch.object(harness.shutil, "which", return_value="/opt/homebrew/bin/aws"):
            with mock.patch.object(harness.subprocess, "run", return_value=working):
                self.assertEqual("/opt/homebrew/bin/aws", harness.require_aws_cli())


class DockerImageStoreTests(unittest.TestCase):
    """Report the daemon's image-reference shape, which the watch cleanup's
    digest rule depends on.

    ``internal/localrunner/watch.go`` removes a rebuilt image only while no
    foreign tag, foreign digest or container names it. A daemon using the
    containerd image store records a digest for each repository its tags name,
    so a locally built image carries one even when nothing outside the run
    references it; that digest must leave with its tag, or a rollback could not
    remove the rebuild. This case prints what the daemon reports, so the CI log
    records the store the harness ran against, and requires the tag-move
    invariant. It skips when no daemon answers, so a machine without Docker
    still runs the self-tests.
    """

    REFERENCE_FORMAT = "{{json .RepoTags}} {{json .RepoDigests}}"

    def test_a_built_digest_is_derived_from_its_tag_and_leaves_with_it(self) -> None:
        if shutil.which("docker") is None:
            self.skipTest("docker is not installed")
        probe = subprocess.run(
            ["docker", "info", "--format", "{{.Driver}}"], capture_output=True, text=True, check=False
        )
        if probe.returncode != 0:
            self.skipTest(f"no docker daemon: {probe.stderr.strip()}")

        def docker(*args: str) -> str:
            result = subprocess.run(["docker", *args], capture_output=True, text=True, check=False)
            if result.returncode != 0:
                self.fail(f"docker {' '.join(args)}: {result.stderr.strip()}")
            return result.stdout

        def references(reference: str) -> tuple[list[str], list[str]]:
            raw = docker("image", "inspect", "--format", self.REFERENCE_FORMAT, reference)
            decoder = json.JSONDecoder()
            tags, offset = decoder.raw_decode(raw)
            digests, _ = decoder.raw_decode(raw[offset:].lstrip())
            return tags, digests

        version = subprocess.run(
            ["docker", "version", "--format", "client {{.Client.Version}} server {{.Server.Version}}"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout.strip()
        prefix = f"apptheory-local-imagerefs-{os.getpid()}"
        old_tag, new_tag = f"{prefix}-old", f"{prefix}-new"
        scratch = Path(tempfile.mkdtemp(prefix="apptheory-local-imagerefs-"))
        old_id = new_id = ""
        try:
            for tag, revision in ((old_tag, "old"), (new_tag, "new")):
                dockerfile = scratch / f"{revision}.Dockerfile"
                dockerfile.write_text(
                    f"FROM scratch\nLABEL apptheory.local.imagerefs={revision}\n", encoding="utf-8"
                )
                docker("build", "-q", "-t", tag, "-f", str(dockerfile), str(scratch))
            old_id = docker("image", "inspect", "--format", "{{.Id}}", old_tag).strip()
            new_id = docker("image", "inspect", "--format", "{{.Id}}", new_tag).strip()
            tags, digests = references(new_tag)
            print(
                f"docker: {version}; store {probe.stdout.strip()}; "
                f"built {new_tag} -> tags {tags} digests {digests}"
            )
            self.assertEqual([f"{new_tag}:latest"], tags)
            repositories = {tag.rsplit(":", 1)[0] for tag in tags}
            for digest in digests:
                self.assertIn(
                    digest.split("@", 1)[0],
                    repositories,
                    f"digest {digest} was not derived from a tag on the image",
                )
            docker("tag", old_id, new_tag)
            moved_tags, moved_digests = references(new_id)
            print(
                f"docker: after moving {new_tag} back to {old_id}, the rebuilt image "
                f"reports tags {moved_tags} digests {moved_digests}"
            )
            self.assertEqual([], moved_tags)
            self.assertEqual([], moved_digests)
        finally:
            for reference in (old_tag, new_tag, new_id, old_id):
                if reference:
                    subprocess.run(
                        ["docker", "image", "rm", "-f", reference], capture_output=True, text=True, check=False
                    )
            shutil.rmtree(scratch, ignore_errors=True)


class WorkerFlagTests(unittest.TestCase):
    """``--workers``/``EXAMPLES_WORKERS`` is validated before anything is allocated."""

    def test_ordinary_runs_use_four_workers(self) -> None:
        self.assertEqual(4, harness.DEFAULT_EXAMPLES_WORKERS)
        self.assertEqual(
            harness.DEFAULT_EXAMPLES_WORKERS,
            harness.parse_workers(str(harness.DEFAULT_EXAMPLES_WORKERS)),
        )
        self.assertEqual("4", harness.build_parser().parse_args([]).workers)
        self.assertEqual("2", harness.build_parser().parse_args(["--workers", "2"]).workers)

    def test_auto_lease_reserves_a_span_that_leaves_existing_fixtures_alone(self) -> None:
        profile, _ = harness.load_manifest(harness.MANIFEST_PATH)
        occupied = {0, 2}

        def project_owns(project: str) -> bool:
            return any(project.endswith(f"-s{slot}") for slot in occupied)

        def port_open(_host: str, port: int, timeout: float = 0.5) -> bool:
            return any(port in harness.slot_ports(profile, slot) for slot in occupied)

        with mock.patch.object(harness, "port_open", side_effect=port_open):
            with mock.patch.object(harness, "_project_owns", side_effect=project_owns):
                lease = harness.acquire_lease(profile, "00000000", slot=None, port=None, span=4)

        # The only free four-slot span is s3..s6; the occupied fixtures stay put.
        self.assertEqual(3, lease.slot)
        self.assertEqual(harness.slot_ports(profile, 3)[1], lease.http_port)
        self.assertTrue(lease.project.endswith("-s3"))

    def test_auto_lease_refuses_a_missing_span_without_falling_back(self) -> None:
        profile, _ = harness.load_manifest(harness.MANIFEST_PATH)
        with mock.patch.object(harness, "port_open", return_value=True):
            with mock.patch.object(harness, "_project_owns", return_value=False):
                with self.assertRaises(harness.HarnessFailure) as raised:
                    harness.acquire_lease(profile, "00000000", slot=None, port=None, span=4)
        self.assertIn("no free span of 4", str(raised.exception))
        self.assertIn("EXAMPLES_WORKERS", str(raised.exception))

    def test_default_main_reserves_four_lanes_before_any_state_change(self) -> None:
        seen: dict[str, int] = {}

        def must_not_run(*_args, **_kwargs):
            raise AssertionError("a missing four-lane span must not write a lease or preflight")

        def fail_lease(_profile, _checkout, *, slot, port, span=1, external=False):
            seen["span"] = span
            raise harness.HarnessFailure("no free span of 4 adjacent local-profile slots")

        with tempfile.TemporaryDirectory(prefix="apptheory-workers-") as scratch:
            with mock.patch.object(harness, "STATE_DIR", Path(scratch)):
                with mock.patch.object(harness, "discover", return_value={}):
                    with mock.patch.object(harness, "validate_manifest", return_value=[]):
                        with mock.patch.object(harness, "acquire_lease", side_effect=fail_lease):
                            with mock.patch.object(harness, "write_lease", side_effect=must_not_run):
                                with mock.patch.object(harness, "preflight", side_effect=must_not_run):
                                    stderr = io.StringIO()
                                    with contextlib.redirect_stderr(stderr):
                                        self.assertEqual(2, harness.main([]))
        self.assertEqual(4, seen["span"])
        self.assertIn("no free span of 4", stderr.getvalue())

    def test_parse_workers_accepts_the_supported_range(self) -> None:
        for value in ("1", "2", str(harness.MAX_EXAMPLES_WORKERS), " 3 "):
            self.assertEqual(int(value), harness.parse_workers(value))

    def test_parse_workers_rejects_non_numbers_and_out_of_range(self) -> None:
        for value, needle in (
            ("0", "at least 1"),
            ("-1", "at least 1"),
            ("two", "whole number"),
            (str(harness.MAX_EXAMPLES_WORKERS + 1), "above the harness maximum"),
        ):
            with self.assertRaises(harness.HarnessFailure) as raised:
                harness.parse_workers(value)
            self.assertIn(needle, str(raised.exception))

    def test_worker_lanes_need_distinct_free_blocks(self) -> None:
        profile, _ = harness.load_manifest(harness.MANIFEST_PATH)
        base, http, aux = harness.slot_ports(profile, 0)
        lease = harness.Lease(
            checkout="t", slot=0, port=base, project="p", http_port=http, aux_port=aux
        )
        with mock.patch.object(harness, "port_open", return_value=False):
            with mock.patch.object(harness, "_project_owns", return_value=False):
                lanes = harness.plan_worker_lanes(profile, lease, harness.MAX_EXAMPLES_WORKERS)
        bases = [lane.port_base for lane in lanes]
        self.assertEqual(harness.MAX_EXAMPLES_WORKERS, len(set(bases)))
        self.assertEqual(http, lanes[0].port_base)
        # The co-resident rows put their second run at port_base + 40; that block
        # must stay outside every lane this run reserved.
        for lane in lanes:
            for other in lanes:
                self.assertFalse(other.port_base <= lane.port_base + 40 < other.port_base + 10)

    def test_worker_lanes_refuse_over_capacity_before_preflight(self) -> None:
        profile, _ = harness.load_manifest(harness.MANIFEST_PATH)
        last = harness.slot_count(profile) - 1
        base, http, aux = harness.slot_ports(profile, last)
        lease = harness.Lease(
            checkout="t", slot=last, port=base, project="p", http_port=http, aux_port=aux
        )
        with mock.patch.object(harness, "_project_owns", return_value=False):
            with self.assertRaises(harness.HarnessFailure) as raised:
                harness.plan_worker_lanes(profile, lease, 2)
        self.assertIn("last usable one", str(raised.exception))

    def test_worker_lanes_refuse_a_busy_or_owned_slot(self) -> None:
        profile, _ = harness.load_manifest(harness.MANIFEST_PATH)
        base, http, aux = harness.slot_ports(profile, 0)
        lease = harness.Lease(
            checkout="t", slot=0, port=base, project="p", http_port=http, aux_port=aux
        )
        with mock.patch.object(harness, "port_open", return_value=True):
            with mock.patch.object(harness, "_project_owns", return_value=False):
                with self.assertRaises(harness.HarnessFailure) as raised:
                    harness.plan_worker_lanes(profile, lease, 2)
        self.assertIn("already answered", str(raised.exception))
        with mock.patch.object(harness, "port_open", return_value=False):
            with mock.patch.object(harness, "_project_owns", return_value=True):
                with self.assertRaises(harness.HarnessFailure) as owned:
                    harness.plan_worker_lanes(profile, lease, 2)
        self.assertIn("already owns", str(owned.exception))

    def test_pinned_occupied_primary_is_refused_before_lease_or_teardown(self) -> None:
        profile, _ = harness.load_manifest(harness.MANIFEST_PATH)

        def project_owns(project: str) -> bool:
            # The recorded post-cleanup state: s2 still holds a fixture, s3-s5 free.
            return project.endswith("-s2")

        with mock.patch.object(harness, "port_open", return_value=False):
            with mock.patch.object(harness, "_project_owns", side_effect=project_owns):
                with self.assertRaises(harness.HarnessFailure) as raised:
                    harness.acquire_lease(profile, "00000000", slot=2, port=None, span=4)
        self.assertIn("worker lane 1 needs slot s2", str(raised.exception))
        self.assertIn("already owns", str(raised.exception))

        def must_not_run(*_args, **_kwargs):
            raise AssertionError("an occupied pinned primary must not write a lease or preflight")

        with tempfile.TemporaryDirectory(prefix="apptheory-workers-") as scratch:
            with mock.patch.object(harness, "STATE_DIR", Path(scratch)):
                with mock.patch.object(harness, "discover", return_value={}):
                    with mock.patch.object(harness, "validate_manifest", return_value=[]):
                        with mock.patch.object(harness, "_project_owns", side_effect=project_owns):
                            with mock.patch.object(harness, "port_open", return_value=False):
                                with mock.patch.object(harness, "write_lease", side_effect=must_not_run):
                                    with mock.patch.object(harness, "preflight", side_effect=must_not_run):
                                        stderr = io.StringIO()
                                        with contextlib.redirect_stderr(stderr):
                                            self.assertEqual(
                                                2, harness.main(["--slot", "2", "--workers", "4"])
                                            )
                                        self.assertIn("worker lane 1 needs slot s2", stderr.getvalue())
                                        self.assertFalse(list(Path(scratch).glob("lease-*.json")))

        # The supported reuse paths stay intact: a serial run may reclaim this
        # checkout's own s2 container, and an external service on the pinned
        # slot is reused instead of refused.
        with mock.patch.object(harness, "port_open", return_value=False):
            with mock.patch.object(harness, "_project_owns", side_effect=project_owns):
                serial = harness.acquire_lease(profile, "00000000", slot=2, port=None, span=1)
                external = harness.acquire_lease(
                    profile, "00000000", slot=2, port=None, span=4, external=True
                )
        self.assertEqual(2, serial.slot)
        self.assertEqual(2, external.slot)

    def test_lane_availability_includes_the_function_url_port(self) -> None:
        profile, _ = harness.load_manifest(harness.MANIFEST_PATH)
        base, http, aux = harness.slot_ports(profile, 2)
        function_url = http + 2

        def port_open(_host: str, port: int, timeout: float = 0.5) -> bool:
            return port == function_url

        with mock.patch.object(harness, "port_open", side_effect=port_open):
            with mock.patch.object(harness, "_project_owns", return_value=False):
                self.assertFalse(
                    harness._slot_available(profile, "00000000", 2, reclaim_owned=False)
                )
                # Only s2's Function URL port is occupied, so the four-lane
                # allocation must skip that slot and take the s3 span.
                lease = harness.acquire_lease(profile, "00000000", slot=None, port=None, span=4)
        self.assertEqual(3, lease.slot)

        # A selected span preflights the same port for its extra lanes.
        extra_function_url = harness.slot_ports(profile, 3)[1] + 2

        def extra_open(_host: str, port: int, timeout: float = 0.5) -> bool:
            return port == extra_function_url

        lane0 = harness.Lease(
            checkout="t", slot=2, port=base, project="p", http_port=http, aux_port=aux
        )
        with mock.patch.object(harness, "port_open", side_effect=extra_open):
            with mock.patch.object(harness, "_project_owns", return_value=False):
                with self.assertRaises(harness.HarnessFailure) as raised:
                    harness.plan_worker_lanes(profile, lane0, 2)
        self.assertIn("worker lane 2", str(raised.exception))
        self.assertIn(str(extra_function_url), str(raised.exception))

    def test_only_filter_keeps_the_selected_row_through_dispatch(self) -> None:
        profile, _ = harness.load_manifest(harness.MANIFEST_PATH)
        base, http, aux = harness.slot_ports(profile, 0)
        lease = harness.Lease(checkout="t", slot=0, port=base, project="p", http_port=http, aux_port=aux)
        lane = harness.WorkerLane(index=0, slot=0, port_base=http, aux_port=aux)
        entry = harness.Entry(
            key="only-row", kind="entrypoint", data={"class": "L1", "run": "only-row"}
        )
        seen: dict[str, object] = {}

        class FakeScheduler:
            def __init__(self, _harnesses, _lanes, tasks, _report, _runners):
                seen["tasks"] = [(task.entry.key, task.entry.runner) for task in tasks]

            def run(self):
                return {"only-row": ("PASS", "the selected row ran")}, []

        with tempfile.TemporaryDirectory(prefix="apptheory-only-") as scratch:
            with mock.patch.object(harness, "STATE_DIR", Path(scratch)):
                with mock.patch.object(harness, "load_manifest", return_value=(profile, [entry])):
                    with mock.patch.object(harness, "discover", return_value={}):
                        with mock.patch.object(harness, "validate_manifest", return_value=[]):
                            with mock.patch.object(harness, "worker_resources", return_value=frozenset()):
                                with mock.patch.object(harness, "acquire_lease", return_value=lease):
                                    with mock.patch.object(
                                        harness, "plan_worker_lanes", return_value=[lane]
                                    ):
                                        with mock.patch.object(harness, "build_env", return_value={}):
                                            with mock.patch.object(harness, "write_lease"):
                                                with mock.patch.object(harness, "preflight"):
                                                    with mock.patch.object(harness, "prepare"):
                                                        with mock.patch.object(
                                                            harness, "RowScheduler", FakeScheduler
                                                        ):
                                                            out = io.StringIO()
                                                            with contextlib.redirect_stdout(out):
                                                                status = harness.main(
                                                                    ["--only", "only-row", "--workers", "1"]
                                                                )
        self.assertEqual(0, status)
        self.assertEqual([("only-row", "only-row")], seen["tasks"])
        self.assertIn("filter:     only-row", out.getvalue())
        self.assertIn("only-row", out.getvalue())

    def test_bad_workers_is_rejected_before_any_lease_or_container(self) -> None:
        def must_not_run(*_args, **_kwargs):
            raise AssertionError("a rejected worker request must not reach the lease or preflight")

        with tempfile.TemporaryDirectory(prefix="apptheory-workers-") as scratch:
            with mock.patch.object(harness, "STATE_DIR", Path(scratch)):
                with mock.patch.object(harness, "discover", return_value={}):
                    with mock.patch.object(harness, "validate_manifest", return_value=[]):
                        with mock.patch.object(harness, "acquire_lease", side_effect=must_not_run):
                            with mock.patch.object(harness, "preflight", side_effect=must_not_run):
                                for value in ("0", "nope", str(harness.MAX_EXAMPLES_WORKERS + 1)):
                                    stderr = io.StringIO()
                                    with contextlib.redirect_stderr(stderr):
                                        self.assertEqual(2, harness.main(["--workers", value]))
                                    self.assertIn("EXAMPLES_WORKERS/--workers", stderr.getvalue())

    def test_capacity_refusal_writes_no_lease_and_runs_no_preflight(self) -> None:
        profile, _ = harness.load_manifest(harness.MANIFEST_PATH)
        base, http, aux = harness.slot_ports(profile, 0)
        lease = harness.Lease(
            checkout="t", slot=0, port=base, project="p", http_port=http, aux_port=aux
        )

        def must_not_run(*_args, **_kwargs):
            raise AssertionError("a capacity refusal must not write a lease or start a container")

        with tempfile.TemporaryDirectory(prefix="apptheory-workers-") as scratch:
            with mock.patch.object(harness, "STATE_DIR", Path(scratch)):
                with mock.patch.object(harness, "discover", return_value={}):
                    with mock.patch.object(harness, "validate_manifest", return_value=[]):
                        with mock.patch.object(harness, "acquire_lease", return_value=lease):
                            with mock.patch.object(
                                harness,
                                "plan_worker_lanes",
                                side_effect=harness.HarnessFailure("no free worker lane"),
                            ):
                                with mock.patch.object(harness, "write_lease", side_effect=must_not_run):
                                    with mock.patch.object(harness, "preflight", side_effect=must_not_run):
                                        stderr = io.StringIO()
                                        with contextlib.redirect_stderr(stderr):
                                            self.assertEqual(2, harness.main(["--workers", "2"]))
        self.assertIn("no free worker lane", stderr.getvalue())


def worker_harnesses(count: int) -> tuple[list[harness.WorkerLane], list[harness.Harness]]:
    """Synthetic lanes and harnesses; the scheduler never touches the network."""
    lanes = [
        harness.WorkerLane(index=index, slot=-1, port_base=9000 + index * 10, aux_port=9001 + index * 10)
        for index in range(count)
    ]
    lease = harness.Lease(
        checkout="t", slot=-1, port=9000, project="p", http_port=9000, aux_port=9001
    )
    harnesses = [
        harness.Harness(env={}, lease=lease, port_base=lane.port_base, aux_port=lane.aux_port)
        for lane in lanes
    ]
    return lanes, harnesses


def worker_tasks(specs: list[tuple[str, set[str]]]) -> list[harness.RowTask]:
    tasks = []
    for index, (key, resources) in enumerate(specs, start=1):
        entry = harness.Entry(key=key, kind="entrypoint", data={"class": "L1", "run": key})
        tasks.append(
            harness.RowTask(
                index=index, total=len(specs), entry=entry, resources=frozenset(resources)
            )
        )
    return tasks


class WorkerSchedulerTests(unittest.TestCase):
    """Rows run once, never overlap inside a resource, and failures propagate."""

    def test_rows_of_one_resource_never_overlap_and_each_runs_once(self) -> None:
        spans: list[tuple[str, float, float]] = []
        lock = threading.Lock()

        def record(name: str):
            def run(_harness: harness.Harness) -> str:
                started = time.monotonic()
                time.sleep(0.05)
                finished = time.monotonic()
                with lock:
                    spans.append((name, started, finished))
                return name

            return run

        specs = [
            ("a1", {"app:a"}),
            ("b1", {"app:b"}),
            ("a2", {"app:a"}),
            ("b2", {"app:b"}),
            ("a3", {"app:a"}),
            ("b3", {"app:b"}),
        ]
        runners = {key: record(key) for key, _ in specs}
        lanes, harnesses = worker_harnesses(2)
        scheduler = harness.RowScheduler(
            harnesses, lanes, worker_tasks(specs), harness.RowReport(workers=2), runners
        )
        with contextlib.redirect_stdout(io.StringIO()):
            results, failures = scheduler.run()

        self.assertEqual([], failures)
        self.assertEqual({key for key, _ in specs}, set(results))
        self.assertEqual(len(specs), len(spans), "a row ran twice or not at all")
        for family in ({"a1", "a2", "a3"}, {"b1", "b2", "b3"}):
            rows = [span for span in spans if span[0] in family]
            for index, first in enumerate(rows):
                for second in rows[index + 1 :]:
                    self.assertFalse(
                        first[1] < second[2] and second[1] < first[2],
                        f"{first[0]} and {second[0]} overlapped inside one resource",
                    )
        overlaps = [
            (first[0], second[0])
            for index, first in enumerate(spans)
            for second in spans[index + 1 :]
            if first[1] < second[2] and second[1] < first[2]
        ]
        self.assertTrue(overlaps, "two lanes never ran independent rows at once")

    def test_one_lane_runs_rows_in_manifest_order(self) -> None:
        order: list[str] = []

        def record(name: str):
            return lambda _harness: (order.append(name) or name)

        specs = [(f"r{index}", {f"app:{index}"}) for index in range(6)]
        runners = {key: record(key) for key, _ in specs}
        lanes, harnesses = worker_harnesses(1)
        scheduler = harness.RowScheduler(
            harnesses, lanes, worker_tasks(specs), harness.RowReport(workers=1), runners
        )
        with contextlib.redirect_stdout(io.StringIO()):
            _, failures = scheduler.run()
        self.assertEqual([], failures)
        self.assertEqual([key for key, _ in specs], order)

    def test_a_failed_row_is_recorded_and_the_others_still_run(self) -> None:
        def explode(_harness: harness.Harness) -> str:
            raise harness.HarnessFailure("row exploded", "the child wrote this")

        specs = [("ok1", {"app:a"}), ("bad", {"app:b"}), ("ok2", {"app:c"})]
        runners = {"ok1": lambda _h: "fine", "bad": explode, "ok2": lambda _h: "fine"}
        lanes, harnesses = worker_harnesses(2)
        scheduler = harness.RowScheduler(
            harnesses, lanes, worker_tasks(specs), harness.RowReport(workers=2), runners
        )
        with contextlib.redirect_stdout(io.StringIO()) as out:
            results, failures = scheduler.run()

        self.assertEqual(("FAIL", "row exploded"), results["bad"])
        self.assertEqual(("PASS", "fine"), results["ok1"])
        self.assertEqual(("PASS", "fine"), results["ok2"])
        self.assertEqual(["bad"], [entry.key for entry, _ in failures])
        self.assertIn("FAIL", out.getvalue())
        self.assertIn("| the child wrote this", out.getvalue())

    def test_an_unexpected_exception_fails_only_its_row(self) -> None:
        def bug(_harness: harness.Harness) -> str:
            raise RuntimeError("harness bug")

        specs = [("bug", {"app:a"}), ("ok", {"app:b"})]
        runners = {"bug": bug, "ok": lambda _h: "fine"}
        lanes, harnesses = worker_harnesses(1)
        scheduler = harness.RowScheduler(
            harnesses, lanes, worker_tasks(specs), harness.RowReport(workers=1), runners
        )
        with contextlib.redirect_stdout(io.StringIO()):
            results, failures = scheduler.run()
        self.assertEqual(("FAIL", "RuntimeError: harness bug"), results["bug"])
        self.assertEqual(("PASS", "fine"), results["ok"])
        self.assertEqual(["bug"], [entry.key for entry, _ in failures])

    def test_stop_finishes_the_in_flight_row_and_skips_the_queue(self) -> None:
        started: list[str] = []

        def slow(_harness: harness.Harness) -> str:
            started.append("slow")
            time.sleep(0.3)
            return "slow"

        def queued(_harness: harness.Harness) -> str:
            started.append("queued")
            return "queued"

        specs = [("slow", {"app:a"}), ("queued", {"app:b"})]
        runners = {"slow": slow, "queued": queued}
        lanes, harnesses = worker_harnesses(1)
        scheduler = harness.RowScheduler(
            harnesses, lanes, worker_tasks(specs), harness.RowReport(workers=1), runners
        )
        timer = threading.Timer(0.05, scheduler.stop)
        timer.start()
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                results, failures = scheduler.run()
        finally:
            timer.cancel()
        self.assertEqual(["slow"], started)
        self.assertEqual({"slow": ("PASS", "slow")}, results)
        self.assertEqual([], failures)

    def test_a_wide_row_is_not_starved_by_a_stream_of_app_rows(self) -> None:
        specs = [
            ("app1", {"app:a"}),
            ("wide", {"app:a", "app:b", "synth:all"}),
            ("app2", {"app:b"}),
            ("standalone", {"mcp:x"}),
        ]
        lanes, harnesses = worker_harnesses(2)
        scheduler = harness.RowScheduler(
            harnesses, lanes, worker_tasks(specs), harness.RowReport(workers=2), runners={}
        )
        with scheduler.cond:
            wide = scheduler._pick(0)
            standalone = scheduler._pick(1)
            self.assertEqual(("wide", "standalone"), (wide.entry.key, standalone.entry.key))
            # App rows conflict with the wide row, so they wait for it instead
            # of building a stream that would push it to the end of the run.
            self.assertIsNone(scheduler._pick(1))
            for key in wide.resources:
                scheduler.held.pop(key, None)
            scheduler.active -= 1
            first = scheduler._pick(0)
            second = scheduler._pick(1)
        self.assertEqual(("app1", "app2"), (first.entry.key, second.entry.key))

    def test_second_block_rows_stay_on_the_primary_lane(self) -> None:
        for name in (
            "local-iam-shared-plane",
            "local-co-residence-ca",
            "local-co-residence-iam",
            "local-co-residence-backends",
        ):
            self.assertIn("ports:second-block", harness.ROW_RESOURCES[name])
        specs = [("second", {"ports:second-block"}), ("other", {"app:z"})]
        lanes, harnesses = worker_harnesses(2)
        scheduler = harness.RowScheduler(
            harnesses, lanes, worker_tasks(specs), harness.RowReport(workers=2), runners={}
        )
        with scheduler.cond:
            lane1 = scheduler._pick(1)
            self.assertIsNotNone(lane1)
            self.assertEqual(
                "other", lane1.entry.key, "lane 1 must skip the second-block row"
            )
            self.assertIsNone(scheduler._pick(1))
            picked = scheduler._pick(0)
        self.assertIsNotNone(picked)
        self.assertEqual("second", picked.entry.key)

    def test_the_synth_row_holds_every_app_family(self) -> None:
        app_keys = {f"app:{app}" for app in harness.APP_RUNNERS}
        self.assertTrue(app_keys <= harness.ROW_RESOURCES["cdk-synth-all"])
        for app, names in harness.APP_RUNNERS.items():
            for name in names:
                self.assertIn(f"app:{app}", harness.ROW_RESOURCES[name])

    def test_every_runner_declares_a_resource_set(self) -> None:
        self.assertEqual(set(harness.RUNNERS), set(harness.ROW_RESOURCES))
        with self.assertRaises(harness.HarnessFailure):
            harness.worker_resources("no-such-row")

    def test_a_harness_defaults_to_the_primary_lane(self) -> None:
        lease = harness.Lease(
            checkout="t", slot=2, port=8150, project="p", http_port=8151, aux_port=8152
        )
        plain = harness.Harness(env={}, lease=lease)
        self.assertEqual(lease.http_port, plain.port_base)
        self.assertEqual(lease.aux_port, plain.aux_port)


if __name__ == "__main__":
    unittest.main(verbosity=2)
