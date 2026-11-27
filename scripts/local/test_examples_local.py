#!/usr/bin/env python3
"""Self-tests for the AppTheory local examples harness.

They run before every ``make examples-local``. They pin the discovery
conventions against the real tree and prove manifest validation fails closed
when an entrypoint is unclassified, when a row names a file that does not
exist, and when the local profile drifts onto a reserved port.

Every case is pure validation over the real tree or a throwaway tree under the
system temp directory, with two exceptions. ``DockerImageStoreTests`` reads the
image store of a local daemon, skips when none answers, and removes what it
builds. ``WebFunctionDeliveryControlTests`` binds two loopback-only streaming
servers on an ephemeral port, because the web-function row's concurrent-delivery
claim is only worth what its negative control proves.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import py_compile
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import NamedTuple
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
        # executing), the two LOCAL-W3-X6 rows with the versioning handler
        # they cover, the three Python Web Function rows: the ASGI entry
        # point, the WSGI entry point and the local WSGI server that serves it,
        # and the staging script that builds the package the stack ships.
        self.assertEqual(153, len(classified))
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
            "examples/cdk/web-function-python/app/main.py": "web-function-python",
            "examples/cdk/web-function-python/app/main_wsgi.py": "web-function-python-wsgi",
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


def _control_handler(serial: bool, shared_tag: bool):
    """Build a request handler that streams one event per tick, in one of three control modes.

    ``serial`` holds a lock for the whole stream, so the second request gets no response — not even
    its headers — until the first stream has ended. That is strictly serial delivery: the two client
    calls still overlap, and nothing in either response is interleaved with the other.

    ``shared_tag`` is the module-level-state mutation the example must avoid: the tag lives in one
    place outside the request, each request assigns to it, and every tick reads whatever is there
    when it is written. Two concurrent streams then carry each other's tag.
    """
    gate = threading.Lock()
    module_state = {"tag": ""}

    class Handler(BaseHTTPRequestHandler):
        # HTTP/1.0 semantics on purpose: the handler returns, the connection closes, and the client
        # learns the stream ended from EOF. No content-length and no chunked framing take part, which
        # is the shape the row asserts against.
        def log_message(self, *_args) -> None:
            return

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler hook
            parts = urllib.parse.urlsplit(self.path)
            if parts.path != "/stream":
                self.send_error(404)
                return
            query = urllib.parse.parse_qs(parts.query)
            tag = (query.get("tag") or ["anonymous"])[0]
            ticks = int((query.get("ticks") or [str(harness.WEB_FUNCTION_TICKS)])[0])
            if serial:
                gate.acquire()
            try:
                if shared_tag:
                    module_state["tag"] = tag
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                for tick in range(1, ticks + 1):
                    carried = module_state["tag"] if shared_tag else tag
                    self._event("tick", {"tag": carried, "tick": tick, "ticks": ticks})
                    time.sleep(harness.WEB_FUNCTION_TICK_SECONDS)
                carried = module_state["tag"] if shared_tag else tag
                self._event("done", {"tag": carried, "ticks": ticks})
            finally:
                if serial:
                    gate.release()

        def _event(self, name: str, data: dict) -> None:
            self.wfile.write(f"event: {name}\ndata: {json.dumps(data)}\n\n".encode("utf-8"))
            self.wfile.flush()

    return Handler


class ControlServer:
    """A loopback-only streaming server, on an ephemeral port, for one delivery mode."""

    def __init__(self, *, serial: bool = False, shared_tag: bool = False) -> None:
        self.serial = serial
        self.shared_tag = shared_tag
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _control_handler(serial, shared_tag))
        self.base = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self) -> "ControlServer":
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=10)


class WebFunctionDeliveryControlTests(unittest.TestCase):
    """Run the web-function row's assertions against three test-only servers.

    The row used to time the two client calls, which includes the wait for a response: a server
    that delivered the second stream only after the first had finished still reported half a second
    of "overlap". ``serial`` is that server, and the row must keep failing it. The interleaved
    control holds the other end honest — the same assertion must pass it, so an assertion that
    simply failed everything could not pass for proof. ``shared_tag`` is the module-level-state
    mutation, reproduced at the server rather than mocked.
    """

    def test_an_interleaved_delivery_passes_the_assertion(self) -> None:
        with ControlServer() as server:
            summary = harness._assert_web_function_overlap(server.base)
        self.assertIn("chunks interleaved before either finished", summary)
        self.assertIn("each saw only its own tag", summary)

    def test_a_serial_delivery_fails_the_assertion(self) -> None:
        with ControlServer(serial=True) as server:
            with self.assertRaises(harness.HarnessFailure) as raised:
                harness._assert_web_function_overlap(server.base)
        message = str(raised.exception)
        self.assertIn("so the two responses were not delivered concurrently", message)
        print(f"\nserial-delivery control output: {message}")

    def test_a_module_level_request_tag_still_fails_the_assertion(self) -> None:
        with ControlServer(shared_tag=True) as server:
            with self.assertRaises(harness.HarnessFailure) as raised:
                harness._assert_web_function_overlap(server.base)
        message = str(raised.exception)
        self.assertIn("so one request read another's state", message)
        print(f"\nmodule-level-tag control output: {message}")


class WebFunctionPythonDeliveryControlTests(unittest.TestCase):
    """The same three controls, against the Python row's overlap assertion.

    The Python rows assert the same thing the Node.js row does — concurrent delivery, request-scoped
    state — through the same primitives, so the same servers must produce the same verdicts. Running
    both directions here is what keeps the Python assertion from degrading into one that simply
    fails everything (or passes everything).
    """

    def test_an_interleaved_delivery_passes_the_assertion(self) -> None:
        with ControlServer() as server:
            summary = harness._assert_web_function_python_overlap(server.base, "asgi")
        self.assertIn("chunks interleaved before either finished", summary)
        self.assertIn("each saw only its own tag", summary)

    def test_a_serial_delivery_fails_the_assertion(self) -> None:
        with ControlServer(serial=True) as server:
            with self.assertRaises(harness.HarnessFailure) as raised:
                harness._assert_web_function_python_overlap(server.base, "asgi")
        message = str(raised.exception)
        self.assertIn("so the two responses were not delivered concurrently", message)
        print(f"\npython serial-delivery control output: {message}")

    def test_a_module_level_request_tag_still_fails_the_assertion(self) -> None:
        with ControlServer(shared_tag=True) as server:
            with self.assertRaises(harness.HarnessFailure) as raised:
                harness._assert_web_function_python_overlap(server.base, "wsgi")
        message = str(raised.exception)
        self.assertIn("so one request read another's state", message)
        print(f"\npython module-level-tag control output: {message}")


def clean_python_env(**overrides: str) -> dict[str, str]:
    """An environment that cannot import AppTheory from anywhere the command does not name.

    The launch commands the example documents are written for an operator's own interpreter, so the
    only things this removes are what a developer's shell might carry: an inherited `PYTHONPATH`
    (which would make the example importable from a directory the command never names) and the
    `AWS_*` surface the rows never use. `PATH` is pinned to the interpreter running these tests
    first, so `python3` in a documented command is the interpreter the harness dependency set
    belongs to.
    """
    env = {
        key: value
        for key, value in os.environ.items()
        if key != "PYTHONPATH" and not key.startswith("AWS_")
    }
    env["PATH"] = os.pathsep.join([str(Path(sys.executable).parent), env.get("PATH", "")])
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.update(overrides)
    return env


def apptheory_is_importable(env: dict[str, str], cwd: Path) -> bool:
    """Whether a bare ``import apptheory`` works in this environment."""
    result = subprocess.run(
        [sys.executable, "-c", "import apptheory"],
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0


def ephemeral_port() -> int:
    """A port nothing is listening on right now, for a server about to bind it."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


class StartedServer:
    """A server process started for one test, with the port waited for and its output captured."""

    def __init__(
        self,
        command: list[str],
        *,
        cwd: Path,
        env: dict[str, str],
        port: int,
        label: str,
        seconds: int = 120,
    ) -> None:
        self.command = command
        self.cwd = cwd
        self.env = env
        self.port = port
        self.label = label
        self.seconds = seconds
        self.process: subprocess.Popen | None = None
        self._log = tempfile.NamedTemporaryFile(prefix="apptheory-self-test-", suffix=".log", delete=False)

    def __enter__(self) -> "StartedServer":
        self.process = subprocess.Popen(
            self.command,
            cwd=str(self.cwd),
            env=self.env,
            stdout=self._log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            harness._wait_for_tcp(self.process, self.port, seconds=self.seconds, label=self.label)
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def output(self) -> str:
        self._log.flush()
        return Path(self._log.name).read_text(encoding="utf-8", errors="replace")

    def __exit__(self, *_exc: object) -> None:
        if self.process is not None:
            harness._stop_process(self.process)
        self._log.close()
        try:
            os.unlink(self._log.name)
        except FileNotFoundError:
            pass


def documented_cd(cwd: Path, command: str) -> Path:
    """Apply the `cd` steps of a documented shell command and return where it ends up."""
    target = cwd
    for directory in re.findall(r"(?:^|&&\s*)cd\s+(\S+)", command):
        target = (target / directory).resolve()
    return target


ASGI_DISCONNECT_PROBE = '''
"""A streaming AppTheory application that records how far its producer got."""
from __future__ import annotations

import os

import time

from apptheory import Response, SSEEvent, SecureApp, public, sse_event_stream

TICKS = 200
TICK_SECONDS = 0.05
STATE = os.environ["PROBE_STATE"]


def record(line: str) -> None:
    with open(STATE, "a", encoding="utf-8") as handle:
        handle.write(line + "\\n")


def events():
    try:
        for tick in range(1, TICKS + 1):
            record(f"tick {tick}")
            yield SSEEvent(event="tick", data={"tick": tick})
            time.sleep(TICK_SECONDS)
        record("done")
    finally:
        record("closed")


def build_app() -> SecureApp:
    app = SecureApp()

    def stream(_ctx) -> Response:
        return Response(
            status=200,
            headers={"content-type": ["text/event-stream"], "cache-control": ["no-store"]},
            cookies=[],
            body=b"",
            is_base64=False,
            body_stream=sse_event_stream(events()),
        )

    app.get("/stream", stream, public())
    return app
'''

ASGI_PROBE_MAIN = '''
from __future__ import annotations

from apptheory import ASGIApp

from probe_stream import build_app

app = ASGIApp(build_app())
'''

WSGI_PROBE_MAIN = '''
from __future__ import annotations

from apptheory import WSGIApp

from probe_stream import build_app

application = WSGIApp(build_app())
'''

# How many of the probe's 200 ticks may be produced after the client goes away. The full stream
# takes ten seconds; a wrapper that keeps producing after the disconnect reaches 200, and one that
# stops at the first chunk boundary stays in single digits.
DISCONNECT_TICK_CEILING = 100
DISCONNECT_CLOSE_SECONDS = 8.0


def producer_state(state: Path) -> list[str]:
    """The lines the probe's producer has written so far."""
    if not state.exists():
        return []
    return state.read_text(encoding="utf-8").splitlines()


def wait_for_producer_close(state: Path, *, seconds: float = DISCONNECT_CLOSE_SECONDS) -> float:
    """Wait for the producer to report its close, and return how long that took."""
    started = time.monotonic()
    deadline = started + seconds
    while time.monotonic() < deadline:
        if "closed" in producer_state(state):
            return time.monotonic() - started
        time.sleep(0.02)
    raise harness.HarnessFailure(
        f"the producer had not closed {seconds:.0f}s after the client went away "
        f"(it had produced {len(producer_ticks(state))} chunks)"
    )


def producer_ticks(state: Path) -> list[int]:
    """The ticks the producer emitted, in order."""
    ticks = []
    for line in producer_state(state):
        if line.startswith("tick "):
            ticks.append(int(line.split()[1]))
    return ticks


class WebFunctionPythonLaunchTests(unittest.TestCase):
    """The example's launch commands work as written, and the rows reach AppTheory the same way.

    SAN-AT-W1B-01: both documented commands were one directory short of `py/src`, and no row could
    see it because the harness injected `<repo>/py/src` itself as an absolute path. The README's
    fenced block is now the single source of truth: these tests read the commands out of the
    README, hold the row constants to the same relative expression, and run the commands as written
    in an environment with no ambient AppTheory install.
    """

    def setUp(self) -> None:
        self.commands = harness.web_function_python_launch_commands()
        self.example = harness.WEB_FUNCTION_PYTHON_EXAMPLE

    def test_the_rows_reach_apptheory_by_the_documented_path(self) -> None:
        """Both sides must land on this checkout's `py/src`, spelled the way their directory needs.

        The rows and the README run from different directories, so comparing the two relative
        expressions would be comparing the wrong thing. What has to match is where they arrive: a
        row that injects a path the README never names is exactly the masking this finding was.
        """
        expected = (harness.ROOT / "py" / "src").resolve()
        row_paths = {
            "asgi": (harness.WEB_FUNCTION_PYTHON_ASGI_APP / harness.WEB_FUNCTION_PYTHON_PYTHONPATH["asgi"]).resolve(),
            "wsgi": (harness.WEB_FUNCTION_PYTHON_EXAMPLE / harness.WEB_FUNCTION_PYTHON_PYTHONPATH["wsgi"]).resolve(),
        }
        for label, command in zip(("asgi", "wsgi"), self.commands, strict=True):
            documented = documented_cd(self.example, command)
            resolved = (documented / harness.web_function_python_launch_pythonpath(command)).resolve()
            self.assertEqual(
                expected,
                resolved,
                f"the documented {label} command puts {resolved} on PYTHONPATH instead of {expected}",
            )
            self.assertTrue(
                (resolved / "apptheory" / "__init__.py").is_file(),
                f"{command} puts {resolved} on PYTHONPATH, which holds no apptheory package",
            )
            self.assertEqual(
                expected,
                row_paths[label],
                f"the {label} row reaches AppTheory by a path the README does not document",
            )

    def test_the_documented_asgi_command_serves_without_an_apptheory_install(self) -> None:
        self._run_documented_launch(0, label="asgi")

    def test_the_documented_wsgi_command_serves_without_an_apptheory_install(self) -> None:
        self._run_documented_launch(1, label="wsgi")

    def _run_documented_launch(self, index: int, *, label: str) -> None:
        command = self.commands[index]
        port = 3000  # the port both documented commands name
        self.assertFalse(
            harness.port_open("127.0.0.1", port, timeout=0.25),
            f"something is already listening on 127.0.0.1:{port}, so the documented launch command "
            f"cannot be run as written: {command}",
        )
        env = clean_python_env()
        self.assertFalse(
            apptheory_is_importable(env, self.example),
            "this test needs an environment with no ambient AppTheory install",
        )

        marker = (
            f"Uvicorn running on http://127.0.0.1:{port}"
            if label == "asgi"
            else f"web-function wsgi listening on 127.0.0.1:{port}"
        )
        with StartedServer(
            ["bash", "-c", command],
            cwd=self.example,
            env=env,
            port=port,
            label=f"documented {label} launch command",
        ) as server:
            page = harness._assert_web_function_python_page(f"http://127.0.0.1:{port}", label)
            stream = harness._assert_web_function_python_stream(f"http://127.0.0.1:{port}", label)
            output = server.output()
        self.assertIn(marker, output, f"the documented {label} command did not report its startup")
        print(f"\ndocumented {label} command, run as written: {command}\n  {page}; {stream}")


class WebFunctionPythonPackageTests(unittest.TestCase):
    """The package the stack stages is the package that would run.

    SAN-AT-W1B-02: the stack staged `app/` alone, so neither entry point could import `apptheory`
    from the staged asset, and the README described a build directory nothing staged. The stack now
    stages what `examples/cdk/_shared/python-package-asset.mjs` builds; these tests build that
    directory and prove both entry points import and serve from it with no other AppTheory on the
    path.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.stage = cls._stage()

    @classmethod
    def _stage(cls) -> Path:
        result = run_python_package_staging(harness.WEB_FUNCTION_PYTHON_EXAMPLE)
        if result.returncode != 0:
            raise harness.HarnessFailure(f"staging the Python package failed: {result.stderr.strip()}")
        return Path(result.stdout.strip())

    def test_the_staged_package_holds_the_application_and_the_runtime(self) -> None:
        for name in ("main.py", "main_wsgi.py", "lib/application.py"):
            self.assertTrue((self.stage / name).is_file(), f"the staged package is missing {name}")
        self.assertTrue(
            (self.stage / "apptheory" / "__init__.py").is_file(),
            "the staged package does not carry the AppTheory runtime",
        )
        caches = [path for path in self.stage.rglob("__pycache__")] + list(self.stage.rglob("*.pyc"))
        self.assertEqual([], [str(path) for path in caches], "a byte-code cache reached the staged package")

    def test_both_entry_points_import_from_the_staged_package_alone(self) -> None:
        env = clean_python_env(PYTHONPATH=str(self.stage))
        self.assertFalse(
            apptheory_is_importable(clean_python_env(), Path(tempfile.gettempdir())),
            "this test needs an environment with no ambient AppTheory install",
        )
        for module in ("main", "main_wsgi"):
            result = subprocess.run(
                [sys.executable, "-c", f"import {module}"],
                cwd=str(self.stage),
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(0, result.returncode, f"import {module} from the staged package: {result.stderr}")
        print(f"\nthe staged package imported both entry points from {self.stage}")

    def test_the_staged_package_serves_the_asgi_entry_point(self) -> None:
        port = ephemeral_port()
        # No PYTHONPATH at all: the package root is the import root, which is what Lambda gives it.
        env = clean_python_env()
        env.pop("PYTHONPATH", None)
        with StartedServer(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--log-level",
                "warning",
            ],
            cwd=self.stage,
            env=env,
            port=port,
            label="staged package ASGI entry point",
        ):
            page = harness._assert_web_function_python_page(f"http://127.0.0.1:{port}", "staged asgi")
            stream = harness._assert_web_function_python_stream(f"http://127.0.0.1:{port}", "staged asgi")
        print(f"\nstaged package, ASGI: {page}; {stream}")

    def test_the_staged_package_serves_the_wsgi_entry_point(self) -> None:
        port = ephemeral_port()
        # No PYTHONPATH either: `serve-wsgi.py` puts the package it is given on the path and the
        # entry module imports the runtime from beside itself, which is the deployed layout.
        env = clean_python_env(PORT=str(port))
        env.pop("PYTHONPATH", None)
        with StartedServer(
            [sys.executable, str(harness.WEB_FUNCTION_PYTHON_EXAMPLE / "scripts" / "serve-wsgi.py"), str(self.stage)],
            cwd=self.stage,
            env=env,
            port=port,
            label="staged package WSGI entry point",
        ):
            page = harness._assert_web_function_python_page(f"http://127.0.0.1:{port}", "staged wsgi")
        print(f"\nstaged package, WSGI: {page}")


WEB_FUNCTION_PYTHON_STACK = "AppTheoryWebFunctionPythonExample"

# One script builds every example's Python deployment package, so there is one rule to test:
# `examples/cdk/_shared/python-package-asset.mjs`.
PYTHON_PACKAGE_ASSET = harness.ROOT / "examples" / "cdk" / "_shared" / "python-package-asset.mjs"

class PythonPackageExample(NamedTuple):
    """One example that stages a Python asset, with the stack the synth gate pins for it.

    `runtime` is what the example declares about the AppTheory runtime it ships: hello-world,
    multilang and web-function-python handlers import `apptheory`, so their packages carry it under
    `apptheory/`; lambda-packaging's handler and layer, and the local-iam and local-tls callers,
    import the standard library or botocore, so their packages carry no runtime. The tests read the
    declaration from the staging step — the runtime is the last tree `--trees` prints when the
    package ships it — rather than restating it here.
    """

    name: str
    stack: str
    args: tuple[str, ...]
    runtime: bool


# Every example that stages a Python asset, with the stack the synth gate pins and the context the
# example needs. The stack name and the pin are the gate's: `scripts/verify-cdk-synth.sh`
# synthesizes each of these rows and compares the template with the committed snapshot.
PYTHON_PACKAGE_EXAMPLES: tuple[PythonPackageExample, ...] = (
    PythonPackageExample("web-function-python", "AppTheoryWebFunctionPythonExample", (), True),
    PythonPackageExample("hello-world", "AppTheoryHelloWorldPy", ("-c", "lang=py"), True),
    PythonPackageExample("multilang", "AppTheoryMultilangDemo", (), True),
)

# Synthetic local-only files, planted in every packaged tree of every Python example to prove they
# stay out of the deployment package. None of them is or contains a credential: the values are this
# test's own strings, and what the plant is about is the file's *presence*, never its contents. They
# are the shapes a developer leaves behind that Python cannot import — a dotenv, a pytest cache, a
# dot-file, a note, an editor swap file — which is exactly the residue the allow-list drops in
# silence. A local *test tree* is not in this set, because a directory of test modules is importable
# from the archive root and staging refuses it by name (SAN-AT-W1B-05); those cases live in
# WebFunctionPythonPackageInputTests.test_growth_anywhere_in_either_tree_fails_staging and
# PythonPackageAllowListTests.
PYTHON_LOCAL_ONLY_PLANTS: dict[str, str] = {
    ".env": "APPTHEORY_LOCAL_ONLY_PLANT=this-is-not-a-credential\n",
    ".pytest_cache/v/cache/lastfailed": "{}\n",
    ".dotfile-local-only": "a dot-file nobody declared\n",
    ".main.py.swp": "an editor swap file nobody declared\n",
    "local-notes.txt": "a note nobody declared\n",
}


def web_function_python_package_trees() -> list[Path]:
    """The trees the deployment package is built from, as the staging step declares them."""
    return python_package_trees(harness.WEB_FUNCTION_PYTHON_EXAMPLE)


@contextlib.contextmanager
def planted_local_only_files(trees: list[Path], plants: dict[str, str]):
    """Place synthetic local-only files in the package trees, and take them back out again.

    They go into the real trees, because the real trees are what synthesis reads: planting in a copy
    would prove nothing about the asset. Every file this adds is recorded and removed in `finally`,
    and so is every directory it had to create, so a failed assertion cannot leave residue behind
    for the next test or the next gate. The content is text for the shapes the interpreter never
    writes and bytes for the ones it does — a `.pyc` plant is real byte-code, because a stand-in
    would leave the test silently unable to tell a cache from a sourceless module.
    """
    planted: list[Path] = []
    created: list[Path] = []
    try:
        for tree in trees:
            for relative, content in plants.items():
                staged = tree / relative
                if staged.exists():
                    raise harness.HarnessFailure(f"{staged} already exists; refusing to overwrite it")
                missing: list[Path] = []
                parent = staged.parent
                while parent != tree and not parent.exists():
                    missing.append(parent)
                    parent = parent.parent
                for directory in reversed(missing):
                    directory.mkdir()
                    created.append(directory)
                if isinstance(content, bytes):
                    staged.write_bytes(content)
                else:
                    staged.write_text(content, encoding="utf-8")
                # Narrow mode on purpose: a plant is nobody's input, and the harness keeps its own
                # scratch files owner-only (os.chmod(..., 0o600) there too). The plant's *presence* is
                # what the tests are about, never its mode, so nothing here needs a wider bit.
                os.chmod(staged, 0o600)
                planted.append(staged)
        yield planted
    finally:
        for staged in planted:
            with contextlib.suppress(FileNotFoundError):
                staged.unlink()
        for directory in reversed(created):
            with contextlib.suppress(OSError):
                directory.rmdir()


@contextlib.contextmanager
def planted_links(entries: list[tuple[Path, str, Path]]):
    """Point an entry of a package tree at another path, and take the link back out again.

    A symbolic link is the entry shape the staging walk cannot classify: `Dirent.isFile()` and
    `Dirent.isDirectory()` are both false for it, so an entry that trusts them sees nothing at all.
    Python sees the opposite — a linked `.py` module and a linked package directory import from the
    archive root exactly like the file or the directory they stand for — which is why the link has to
    be planted in the real tree and refused by name (SAN-AT-W1B-05). Every link this adds is recorded
    and removed in `finally`, so a failed assertion cannot leave one behind for the next test.
    """
    planted: list[Path] = []
    try:
        for tree, name, target in entries:
            link = tree / name
            if link.exists() or link.is_symlink():
                raise harness.HarnessFailure(f"{link} already exists; refusing to overwrite it")
            os.symlink(target, link)
            planted.append(link)
        yield planted
    finally:
        for link in planted:
            with contextlib.suppress(FileNotFoundError):
                link.unlink()


def run_python_package_staging(example: Path, asset: str | None = None) -> subprocess.CompletedProcess[str]:
    """Run the shared staging step — the one `cdk synth` runs — and report what it said.

    One script builds every Python asset, so a test names the example and, when the example stages
    more than one, the asset; the rule is the same rule the stack runs:
    `examples/cdk/_shared/python-package-asset.mjs`.
    """
    command = [shutil.which("node") or "node", str(PYTHON_PACKAGE_ASSET), str(example)]
    if asset is not None:
        command.append(asset)
    return subprocess.run(command, cwd=str(example), capture_output=True, text=True, check=False)


def byte_code_module() -> bytes:
    """Real byte-code, as the interpreter writes it: what the `.pyc` plants are made of.

    A textual stand-in would be a `.pyc` in name only, and the tests would then be unable to tell a
    cache the interpreter wrote from a sourceless module an author kept on purpose — the two shapes
    they are about. This compiles a module in a throwaway directory and reads the file back.
    """
    with tempfile.TemporaryDirectory(prefix="apptheory-byte-code-") as directory:
        source = Path(directory) / "helper_source.py"
        source.write_text('MESSAGE = "helper"\n\n\ndef greet():\n    return MESSAGE\n', encoding="utf-8")
        return Path(py_compile.compile(str(source), doraise=True)).read_bytes()


def run_web_function_python_staging() -> subprocess.CompletedProcess[str]:
    """Run the staging step for the Python Web Function example."""
    return run_python_package_staging(harness.WEB_FUNCTION_PYTHON_EXAMPLE)


def python_package_assets(example: Path) -> list[str]:
    """The names of the Python assets one example stages, as the staging step declares them.

    An example may stage more than one (lambda-packaging stages a function and a layer), and each is
    staged on its own so two archives never merge into one. The tests read the names back from the
    script rather than restating them, for the same reason they read the trees back.
    """
    result = subprocess.run(
        [shutil.which("node") or "node", str(PYTHON_PACKAGE_ASSET), "--assets", str(example)],
        cwd=str(example),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise harness.HarnessFailure(f"reading the staged assets failed: {result.stderr.strip()}")
    assets = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not assets:
        raise harness.HarnessFailure(f"{example} declares no staged assets")
    return assets


def python_package_trees(example: Path, asset: str | None = None) -> list[Path]:
    """The trees one asset is built from, as the staging step declares them.

    The declaration is the thing the guard holds the trees to, so the tests plant residue in the
    trees the script names rather than in a second list that could drift from it. A plant in a tree
    the script does not package would prove nothing about the package.
    """
    command = [shutil.which("node") or "node", str(PYTHON_PACKAGE_ASSET), "--trees", str(example)]
    if asset is not None:
        command.append(asset)
    result = subprocess.run(command, cwd=str(example), capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise harness.HarnessFailure(f"reading the packaged trees failed: {result.stderr.strip()}")
    trees = [Path(line.strip()) for line in result.stdout.splitlines() if line.strip()]
    if not trees:
        raise harness.HarnessFailure(f"{example} declares no packaged trees")
    return trees


def python_asset_trees(example: Path) -> list[tuple[str, list[Path]]]:
    """Every asset one example stages, paired with the trees each is built from."""
    return [(asset, python_package_trees(example, asset)) for asset in python_package_assets(example)]


def ensure_example_cdk_dependencies(example: Path) -> None:
    """Install an example's CDK dependency tree the way the synth gate does.

    The finding was observed through a real synthesis, so the test runs the real thing rather than
    a stand-in. `npm ci` is the same prerequisite `scripts/verify-cdk-synth.sh` provisions for every
    example, and it is skipped when the tree is already installed.
    """
    if (example / "node_modules" / "aws-cdk-lib" / "package.json").is_file():
        return
    result = subprocess.run(
        ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        cwd=str(example),
        env=clean_python_env(),
        capture_output=True,
        text=True,
        check=False,
        timeout=900,
    )
    if result.returncode != 0:
        raise harness.HarnessFailure(
            f"installing the example's CDK dependencies failed: {result.stderr.strip() or result.stdout.strip()}"
        )


def synthesize_example(example: Path, stack: str, output: Path, *args: str) -> str:
    """Synthesize an example exactly as the synth gate does, and return the template's sha256.

    The epoch and the environment are the gate's: `SOURCE_DATE_EPOCH` from HEAD, and no
    `CDK_DEFAULT_*` folded into an environment-agnostic template. That is what makes the committed
    pin the oracle for the asset hash these tests are about.
    """
    ensure_example_cdk_dependencies(example)
    epoch = subprocess.run(
        ["git", "show", "-s", "--format=%ct", "HEAD"],
        cwd=str(harness.ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    if epoch.returncode != 0 or not epoch.stdout.strip():
        raise harness.HarnessFailure(f"reading HEAD's commit time for SOURCE_DATE_EPOCH failed: {epoch.stderr.strip()}")
    env = clean_python_env(SOURCE_DATE_EPOCH=epoch.stdout.strip())
    for key in ("CDK_DEFAULT_ACCOUNT", "CDK_DEFAULT_REGION", "CDK_CONTEXT_JSON"):
        env.pop(key, None)
    result = subprocess.run(
        [
            str(example / "node_modules" / ".bin" / "cdk"),
            "synth",
            "--quiet",
            "--no-notices",
            "--no-version-reporting",
            "-o",
            str(output),
            *args,
        ],
        cwd=str(example),
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=900,
    )
    if result.returncode != 0:
        raise harness.HarnessFailure(
            f"synthesizing {example.name} failed: {result.stderr.strip() or result.stdout.strip()}"
        )
    template = output / f"{stack}.template.json"
    if not template.is_file():
        raise harness.HarnessFailure(f"the synthesis produced no {template.name}")
    return hashlib.sha256(template.read_bytes()).hexdigest()


def synthesize_web_function_python(output: Path) -> str:
    """Synthesize the Python Web Function example as the synth gate does."""
    return synthesize_example(
        harness.WEB_FUNCTION_PYTHON_EXAMPLE, WEB_FUNCTION_PYTHON_STACK, output
    )


def python_package_asset(output: Path, staged_files: list[str]) -> Path:
    """The asset directory CDK staged that holds exactly the files the staging step built.

    A stack also emits asset directories for its other code — a Go bootstrap, a Docker build
    context, a Node bundle — so the Python package is identified by the one thing only it can be:
    the exact set of files staging put in it. An entry module alone would not do:
    lambda-packaging's Docker context carries an `app.py` too, and the layer's archive root holds no
    entry module at all.

    Exactly one directory has to match. Two would mean two assets claim the same package, and the
    template the tests then compare with the pin would be ambiguous about which one they read.
    """
    wanted = sorted(staged_files)
    matches = [
        candidate
        for candidate in sorted(output.glob("asset.*"))
        if candidate.is_dir() and python_package_files(candidate) == wanted
    ]
    if len(matches) != 1:
        raise harness.HarnessFailure(
            f"no single asset directory under {output} holds the {len(wanted)} files the staging step built "
            f"(found {[candidate.name for candidate in matches]}): the synthesized package is not the staged "
            "package"
        )
    return matches[0]


# A module named like a test: `test_*.py` or `*_test.py`. The runtime legitimately ships
# `testkit.py`, so the name is matched as a shape rather than by substring.
PY_TEST_MODULE_RE = re.compile(r"^(?:test_.*\.py|.*_test\.py)$")


def python_package_files(package: Path) -> list[str]:
    """Every file in a staged package, relative to it."""
    return sorted(path.relative_to(package).as_posix() for path in package.rglob("*") if path.is_file())


class WebFunctionPythonPackageInputTests(unittest.TestCase):
    """The deployed package is its allow-list, and local-only files cannot join it. (SAN-AT-W1B-04)

    The package used to be every file under `app/` and every file under `py/src/apptheory` minus a
    list of names to skip. A deny-list cannot promise a stable package: a `.env`, a local test tree
    or a `.pytest_cache` nobody predicted lands in the CDK asset and moves its hash, so what an
    operator deploys depends on what the author happened to leave in the tree. Both trees are now
    bounded by an explicit allow-list of the importable modules and the declared package data, and
    these tests plant the shapes that used to leak.

    The allow-list is held to the trees recursively (SAN-AT-W1B-05). Every importable unit in either
    tree has to be named — a `.py` module, a package directory with `__init__.py`, or a namespace
    package directory that Python imports because it holds modules — at any depth, because staging
    refuses rather than deploying an archive that is missing code the source tree has. The rule is
    total, and it decides what happens to local residue: what Python cannot import (a `.env`, a
    `.pytest_cache`, a swap file, a note) stays out in silence, while a local *Python* test tree is
    importable from the archive root, so it is refused by name instead of being dropped or shipped.

    The walk reads entry types, so the trees may hold only the two types it reads (ADV-W1B-R3-01): a
    `.py` module, a package directory and a namespace directory are importable through a symbolic link
    just as they are directly, but `isFile()`/`isDirectory()` are false for the link, so a linked entry
    used to pass unchecked and unshipped. Every entry that is not a regular file or a regular directory
    is now refused by name and not followed, and that is asserted per tree and per shape in
    test_a_linked_entry_in_either_tree_fails_staging.
    """

    def test_local_only_files_stay_out_of_the_synthesized_cdk_asset(self) -> None:
        """Plant residue in both trees, synthesize, and hold the actual asset to the allow-list.

        The plants are the residue Python cannot import, which is the residue staging drops without
        saying anything: a dotenv, a pytest cache, a dot-file, a swap file, a note. Adding any of
        them changes neither the asset nor the template hash. Residue that *is* importable — a local
        test tree — is refused by name instead, and that is asserted in
        test_growth_anywhere_in_either_tree_fails_staging.
        """
        example = harness.WEB_FUNCTION_PYTHON_EXAMPLE
        trees = web_function_python_package_trees()
        pinned = (example / "snapshots" / f"{WEB_FUNCTION_PYTHON_STACK}.template.sha256").read_text(encoding="utf-8")
        pinned = pinned.strip()
        self.assertEqual(64, len(pinned), f"the committed template pin is not a sha256: {pinned!r}")
        staged = run_web_function_python_staging()
        self.assertEqual(0, staged.returncode, f"staging refused the trees as committed: {staged.stderr.strip()}")
        staged_files = python_package_files(Path(staged.stdout.strip()))
        with tempfile.TemporaryDirectory(prefix="apptheory-web-function-clean-") as clean_dir:
            clean = synthesize_web_function_python(Path(clean_dir))
            asset = python_package_asset(Path(clean_dir), staged_files)
            self.assertEqual(pinned, clean, "the synthesis of the clean tree does not reproduce the committed pin")
            print(f"\nclean tree: template {clean[:12]}, package asset {asset.name} with {len(list(asset.rglob('*')))} entries")

            with planted_local_only_files(trees, PYTHON_LOCAL_ONLY_PLANTS) as planted:
                with tempfile.TemporaryDirectory(prefix="apptheory-web-function-planted-") as planted_dir:
                    observed = synthesize_web_function_python(Path(planted_dir))
                    package = python_package_asset(Path(planted_dir), staged_files)
                    self.assertEqual(
                        pinned,
                        observed,
                        "local-only files in the package trees changed the synthesized template (and its "
                        f"asset hash): planted {[str(path.relative_to(harness.ROOT)) for path in planted]}",
                    )
                    self.assertEqual(
                        clean,
                        observed,
                        "the synthesized template differs between a clean tree and one carrying local-only files",
                    )
                    self.assertEqual(
                        [],
                        self._undeclared_package_files(package),
                        "the synthesized asset carries files the package does not declare",
                    )
                    self._assert_both_entry_points_import_and_serve(package)
                    print(
                        f"planted {len(planted)} local-only files in both trees: template still {observed[:12]}, "
                        f"package asset {package.name} and both entry points still serve from it alone"
                    )

    def _undeclared_package_files(self, package: Path) -> list[str]:
        """Every file in the asset that the package does not declare.

        The declared package is small enough to state as a shape: the application's entry modules,
        the application module they import, the runtime's importable modules, and the runtime's one
        package-data file. Anything else is local residue that reached the deployment package.
        """
        declared = {"main.py", "main_wsgi.py", "lib/application.py", "apptheory/py.typed"}
        undeclared: list[str] = []
        for path in sorted(package.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(package).as_posix()
            if relative in declared:
                continue
            if relative.startswith("apptheory/") and relative.endswith(".py"):
                continue
            undeclared.append(relative)
        return undeclared

    def _assert_both_entry_points_import_and_serve(self, package: Path) -> None:
        """The allow-listed package is complete: both entry points import and serve from it alone."""
        env = clean_python_env()
        self.assertFalse(
            apptheory_is_importable(env, Path(tempfile.gettempdir())),
            "this test needs an environment with no ambient AppTheory install",
        )
        for module in ("main", "main_wsgi"):
            result = subprocess.run(
                [sys.executable, "-c", f"import {module}"],
                cwd=str(package),
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(
                0, result.returncode, f"import {module} from the synthesized asset failed: {result.stderr}"
            )

        asgi_port = ephemeral_port()
        with StartedServer(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(asgi_port),
                "--log-level",
                "warning",
            ],
            cwd=package,
            env=env,
            port=asgi_port,
            label="synthesized asset ASGI entry point",
        ):
            asgi = harness._assert_web_function_python_page(f"http://127.0.0.1:{asgi_port}", "synthesized asgi")

        wsgi_port = ephemeral_port()
        with StartedServer(
            [
                sys.executable,
                str(harness.WEB_FUNCTION_PYTHON_EXAMPLE / "scripts" / "serve-wsgi.py"),
                str(package),
            ],
            cwd=package,
            env=clean_python_env(PORT=str(wsgi_port)),
            port=wsgi_port,
            label="synthesized asset WSGI entry point",
        ):
            wsgi = harness._assert_web_function_python_page(f"http://127.0.0.1:{wsgi_port}", "synthesized wsgi")
        print(f"\n  {asgi}; {wsgi}")

    def test_a_module_the_allow_list_does_not_name_fails_staging(self) -> None:
        """Growth is a decision, not a silent omission: an undeclared module must stop the build.

        The allow-list is only safe if it cannot quietly fall behind the runtime. A new module at the
        runtime's root is importable as `apptheory.<name>`, so it belongs in the package; staging
        refuses instead of deploying a package that is missing what the source tree has.
        """
        tree = harness.ROOT / "py" / "src" / "apptheory"
        undeclared = tree / "undeclared_growth.py"
        if undeclared.exists():
            raise harness.HarnessFailure(f"{undeclared} already exists; refusing to overwrite it")
        try:
            undeclared.write_text("VALUE = 1\n", encoding="utf-8")
            # Owner-only, like the other scratch files this harness writes: the module's presence is
            # the subject, and a world-readable mode is a finding the scanner reports, not a need.
            os.chmod(undeclared, 0o600)
            result = run_web_function_python_staging()
        finally:
            with contextlib.suppress(FileNotFoundError):
                undeclared.unlink()
        self.assertNotEqual(0, result.returncode, "staging accepted a runtime module the allow-list does not name")
        self.assertIn(
            "undeclared_growth.py",
            result.stderr,
            "the staging failure does not name the module that made the allow-list incomplete",
        )
        refused = [line for line in result.stderr.splitlines() if line.startswith("Error: ")]
        self.assertTrue(refused, f"the staging failure does not report an error: {result.stderr.strip()}")
        print(f"\nundeclared runtime module: staging refused with {refused[0]}")

    def test_growth_anywhere_in_either_tree_fails_staging(self) -> None:
        """Depth and shape do not make a unit unimportable. (SAN-AT-W1B-05 / ADV-W1B-R2-01)

        The growth guard used to look only at the directories its allow-list walked: a top-level
        module was refused, but a subpackage under an existing package, a module two directories
        down, and a namespace package at the runtime root were all accepted and silently left out of
        the asset — the build said nothing, the pin did not move, and the deployed function failed at
        import. Python imports all three shapes, so the walk covers both trees at every depth.
        """
        runtime = harness.ROOT / "py" / "src" / "apptheory"
        application = harness.WEB_FUNCTION_PYTHON_ASGI_APP
        cases: dict[str, tuple[Path, dict[str, str], tuple[str, str]]] = {
            "a subpackage under an existing runtime package": (
                runtime,
                {
                    "oauth/newsub/__init__.py": '"""A subpackage the allow-list does not walk."""\n',
                    "oauth/newsub/client.py": "VALUE = 1\n",
                },
                ("oauth/newsub/", "a package the allow-list does not walk"),
            ),
            "a module nested two directories down": (
                runtime,
                {"oauth/nesteddir/helper.py": "VALUE = 2\n"},
                ("oauth/nesteddir/", "a namespace package the allow-list does not walk"),
            ),
            "a module in a walked directory that the allow-list does not name": (
                runtime,
                {"oauth/extra.py": "VALUE = 2\n"},
                ("oauth/extra.py", "a module the allow-list does not name"),
            ),
            "a namespace package at the runtime root": (
                runtime,
                {"nsx/mod.py": "VALUE = 3\n"},
                ("nsx/", "a namespace package the allow-list does not walk"),
            ),
            "a namespace directory deep in the application tree": (
                application,
                {"lib/deeper/mod.py": "VALUE = 4\n"},
                ("lib/deeper/", "a namespace package the allow-list does not walk"),
            ),
            "a local test tree inside the application tree": (
                application,
                {"tests/test_local_only.py": "def test_local_only():\n    assert True\n"},
                ("tests/", "a namespace package the allow-list does not walk"),
            ),
        }
        for label, (tree, plants, expected) in cases.items():
            with self.subTest(label):
                with planted_local_only_files([tree], plants) as planted:
                    result = run_web_function_python_staging()
                self.assertNotEqual(
                    0,
                    result.returncode,
                    f"staging accepted {label}, planted as {[str(path.relative_to(harness.ROOT)) for path in planted]}",
                )
                refused = [line for line in result.stderr.splitlines() if line.startswith("Error: ")]
                self.assertTrue(refused, f"the staging failure for {label} does not report an error: {result.stderr.strip()}")
                for fragment in expected:
                    self.assertIn(
                        fragment,
                        refused[0],
                        f"the staging refusal for {label} does not name it: {refused[0]}",
                    )
                print(f"\n{label}: staging refused with {refused[0]}")

    def test_a_linked_entry_in_either_tree_fails_staging(self) -> None:
        """A link is a shape the walk cannot classify, so staging refuses it by name. (SAN-AT-W1B-05 / ADV-W1B-R3-01)

        The walk classifies each entry with `Dirent.isFile()` / `isDirectory()`, and both are false
        for a symbolic link, so a linked `.py` module or a linked package directory was neither
        checked nor shipped: staging exited 0, the staged package stayed byte-identical, and the
        entry point imported from the source tree but not from the asset — the same silent omission
        the recursive walk refuses, arriving through a linked entry. Python imports through a link,
        so the guard cannot classify it as nothing; the rule is the shape of the whole tree: every
        entry in `app/` or `py/src/apptheory` is a regular file or a regular directory, and any other
        entry stops the build by name.

        Both shapes are planted in both trees, because the runtime tree is the one that ships under
        `apptheory/` and the application tree is the archive root. The committed trees still stage
        without complaint afterwards, which is the other half of the rule: it refuses links, not the
        package.
        """
        runtime = harness.ROOT / "py" / "src" / "apptheory"
        application = harness.WEB_FUNCTION_PYTHON_ASGI_APP
        cases: dict[str, tuple[Path, str, Path, str]] = {
            "a linked module in the application tree": (
                application,
                "aliased_module.py",
                application / "lib" / "application.py",
                "aliased_module.py (a symbolic link)",
            ),
            "a linked package directory in the application tree": (
                application,
                "aliased_pkg",
                application / "lib",
                "aliased_pkg (a symbolic link)",
            ),
            "a linked module in the runtime tree": (
                runtime,
                "aliased_module.py",
                runtime / "router.py",
                "aliased_module.py (a symbolic link)",
            ),
            "a linked package directory in the runtime tree": (
                runtime,
                "aliased_pkg",
                runtime / "limited",
                "aliased_pkg (a symbolic link)",
            ),
        }

        clean = run_web_function_python_staging()
        self.assertEqual(0, clean.returncode, f"staging refused the trees as committed: {clean.stderr.strip()}")
        committed = self._staged_files(clean)

        for label, (tree, name, target, expected) in cases.items():
            with self.subTest(label):
                with planted_links([(tree, name, target)]) as planted:
                    result = run_web_function_python_staging()
                self.assertNotEqual(
                    0,
                    result.returncode,
                    f"staging accepted {label}, planted as {[str(path.relative_to(harness.ROOT)) for path in planted]}",
                )
                refused = [line for line in result.stderr.splitlines() if line.startswith("Error: ")]
                self.assertTrue(
                    refused,
                    f"the staging failure for {label} does not report an error: {result.stderr.strip()}",
                )
                self.assertIn(
                    expected,
                    refused[0],
                    f"the staging refusal for {label} does not name the linked entry: {refused[0]}",
                )
                self.assertIn(
                    "not a regular file or a regular directory",
                    refused[0],
                    f"the staging refusal for {label} does not state the rule: {refused[0]}",
                )
                print(f"\n{label}: staging refused with {refused[0]}")

        after = run_web_function_python_staging()
        self.assertEqual(
            0,
            after.returncode,
            f"the trees as committed stopped staging after the links were removed: {after.stderr.strip()}",
        )
        self.assertEqual(
            committed,
            self._staged_files(after),
            "the trees as committed no longer stage the package they staged before the linked entries were planted",
        )
        print(f"\nthe trees as committed still stage {len(committed)} files")

    @staticmethod
    def _staged_files(result: subprocess.CompletedProcess[str]) -> list[str]:
        """The files one staging run produced, relative to the staged directory."""
        staged = Path(result.stdout.strip())
        return sorted(path.relative_to(staged).as_posix() for path in staged.rglob("*") if path.is_file())

    def test_the_allow_list_walk_matches_the_tree_it_guards(self) -> None:
        """The trees as they ship pass the guard: the walk names nothing it should not. (SAN-AT-W1B-05)

        A walk that is too shallow is a silent omission; a walk that is too eager refuses the tree
        that exists. This runs staging on the real trees as committed, so a recursive walk that
        caught a byte-code cache, a local test tree, or a directory the package legitimately holds
        as a namespace would fail here rather than at the next author's synth.
        """
        result = run_web_function_python_staging()
        self.assertEqual(0, result.returncode, f"staging refused the trees as committed: {result.stderr.strip()}")
        staged = Path(result.stdout.strip())
        files = sorted(path.relative_to(staged).as_posix() for path in staged.rglob("*") if path.is_file())
        self.assertEqual(
            [],
            [name for name in files if "__pycache__" in name or name.endswith(".pyc")],
            "a byte-code cache reached the deployment package",
        )
        print(f"\nthe trees as committed stage {len(files)} files and the recursive walk refuses nothing in them")


class PythonPackageAllowListTests(unittest.TestCase):
    """Every example that stages Python is packaged by its allow-list. (ADV-W1B-R2-02 / ADV-W1C-R0-01)

    The Python Web Function example was brought onto an allow-list first (SAN-AT-W1B-04); the
    hello-world and multilang examples still vendored the runtime by *copying every file and
    skipping a list of names*, so a `.env`, a local `tests/` tree or a `.pytest_cache` in either
    tree reached the synthesized asset and moved its pinned hash — what an operator deploys depended
    on what the author happened to leave lying in the tree. All three now stage through
    `examples/cdk/_shared/python-package-asset.mjs`, which is one rule stated once: the files a
    package contains are the files its trees name, an importable unit the list does not name fails
    the build by name, an entry that is not a regular file or a regular directory fails it by name,
    and the residue Python cannot import stays out in silence.

    That claim is only true of *every* Python asset, so the same rule now builds lambda-packaging's
    function and layer, and the local-iam and local-tls callers (ADV-W1C-R0-01). Those four assets
    were still `lambda.Code.fromAsset(handlers/python)` with nothing but a list of names to skip,
    and a planted `.env` reached them; pointing them at their directories is what the rule exists to
    replace.

    These tests are the examples' own: they plant the shapes in the trees the staging step declares
    — read back from the script, so a plant cannot land in a tree the package does not read — and
    then hold both halves of the rule. Residue that Python cannot import changes neither the asset
    nor the pinned template hash. A local test tree and a symbolic link are refused by name, because
    Python imports both from the archive root and neither is a thing the guard can call nothing.

    The importable shapes are the whole of what the rule decides, so each is asserted directly
    (SAN-AT-W1C-01): a `.py` module, a sourceless `<module>.pyc` kept beside its siblings, an
    extension module (`.so`, `.pyd`), a package directory and a namespace directory. A sourceless
    module is the one that used to fall through: the walk listed `.py` files, so a `helper.pyc` was
    neither declared, refused nor copied, staging exited 0, and the asset could not import a module
    its own source tree could.
    """

    @staticmethod
    def _example(name: str) -> Path:
        return harness.ROOT / "examples" / "cdk" / name

    @staticmethod
    def _pinned(example: Path, stack: str) -> str:
        pin = (example / "snapshots" / f"{stack}.template.sha256").read_text(encoding="utf-8").strip()
        if len(pin) != 64:
            raise harness.HarnessFailure(f"{example.name}: the committed template pin is not a sha256: {pin!r}")
        return pin

    @staticmethod
    def _staged_files(result: subprocess.CompletedProcess[str]) -> list[str]:
        """The files one staging run produced, relative to the staged directory."""
        staged = Path(result.stdout.strip())
        return sorted(path.relative_to(staged).as_posix() for path in staged.rglob("*") if path.is_file())

    def _stage(self, example: Path, asset: str | None = None) -> list[str]:
        """Stage one asset as the stack does, and return the package it built."""
        result = run_python_package_staging(example, asset)
        self.assertEqual(
            0,
            result.returncode,
            f"{example.name}: staging refused the trees as committed ({asset or 'default asset'}): "
            f"{result.stderr.strip()}",
        )
        return self._staged_files(result)

    def test_local_only_residue_stays_out_of_the_synthesized_asset(self) -> None:
        """Residue Python cannot import changes neither the asset nor the pinned hash.

        The trees are read from the staging step, so this asserts the rule where it is applied. The
        clean synthesis must reproduce the committed pin — that is what makes the pin the oracle —
        and the planted one must reproduce it byte for byte, with no planted name anywhere in the
        asset and no file in the asset that the staged package does not hold.
        """
        for example_spec in PYTHON_PACKAGE_EXAMPLES:
            name, stack = example_spec.name, example_spec.stack
            with self.subTest(name):
                example = self._example(name)
                pinned = self._pinned(example, stack)
                for asset, trees in python_asset_trees(example):
                    self.assertEqual(
                        example_spec.runtime,
                        trees[-1] == harness.ROOT / "py" / "src" / "apptheory",
                        f"{name}: the runtime tree is not the last tree of the {asset} package, or it ships "
                        "a runtime the example does not declare",
                    )
                    staged_files = self._stage(example, asset)
                    with tempfile.TemporaryDirectory(prefix=f"apptheory-{name}-clean-") as clean_dir:
                        clean = synthesize_example(example, stack, Path(clean_dir), *example_spec.args)
                        package = python_package_asset(Path(clean_dir), staged_files)
                        self.assertEqual(
                            pinned,
                            clean,
                            f"{name}: the synthesis of the clean tree does not reproduce the committed pin",
                        )

                        with planted_local_only_files(trees, PYTHON_LOCAL_ONLY_PLANTS) as planted:
                            with tempfile.TemporaryDirectory(prefix=f"apptheory-{name}-planted-") as planted_dir:
                                observed = synthesize_example(example, stack, Path(planted_dir), *example_spec.args)
                                self.assertEqual(
                                    pinned,
                                    observed,
                                    f"{name}: local-only files in the packaged trees changed the synthesized "
                                    f"template (and its asset hash): planted "
                                    f"{[str(path.relative_to(harness.ROOT)) for path in planted]}",
                                )
                                planted_package = python_package_asset(Path(planted_dir), staged_files)
                                self.assertEqual(
                                    [],
                                    self._residue_in(planted_package),
                                    f"{name}: the synthesized asset carries residue the package does not declare",
                                )
                                self.assertEqual(
                                    staged_files,
                                    python_package_files(planted_package),
                                    f"{name}: the planted tree and the clean tree staged different packages",
                                )
                                print(
                                    f"\n{name}/{asset}: {len(planted)} local-only files in {len(trees)} trees, "
                                    f"template still {observed[:12]}, package {planted_package.name} with "
                                    f"{len(staged_files)} files"
                                )

    @staticmethod
    def _residue_in(package: Path) -> list[str]:
        """Every planted name that reached the asset, at any depth."""
        names = {"tests"} | {Path(relative).name for relative in PYTHON_LOCAL_ONLY_PLANTS}
        return sorted(path.relative_to(package).as_posix() for path in package.rglob("*") if path.name in names)

    def test_the_committed_examples_stage_the_package_they_pin(self) -> None:
        """The trees as committed pass the rule, and each asset is exactly what staging built.

        A guard that refuses the tree that exists is as broken as one that ships a tree it never
        read. Every asset of every example stages without complaint, the staged directory holds
        exactly the declared files and no test module or byte-code cache, and the synthesized asset
        holds exactly the staged files — one package, no second filtering pass that could add or
        drop a file after staging.
        """
        for example_spec in PYTHON_PACKAGE_EXAMPLES:
            name, stack = example_spec.name, example_spec.stack
            example = self._example(name)
            for asset in python_package_assets(example):
                with self.subTest(f"{name}/{asset}"):
                    staged_files = self._stage(example, asset)
                    self.assertEqual(
                        example_spec.runtime,
                        "apptheory/__init__.py" in staged_files,
                        f"{name}: the {asset} package ships the runtime only when the example declares it",
                    )
                    self.assertEqual(
                        [],
                        [path for path in staged_files if PY_TEST_MODULE_RE.match(Path(path).name)],
                        f"{name}: the {asset} package ships a test module",
                    )
                    self.assertEqual(
                        [],
                        [path for path in staged_files if "__pycache__" in path or path.endswith((".pyc", ".pyo"))],
                        f"{name}: the {asset} package ships a byte-code cache",
                    )
            with tempfile.TemporaryDirectory(prefix=f"apptheory-{name}-pin-") as out_dir:
                synthesized = synthesize_example(example, stack, Path(out_dir), *example_spec.args)
                self.assertEqual(
                    self._pinned(example, stack),
                    synthesized,
                    f"{name}: the committed template pin is not what the committed trees synthesize",
                )
                for asset in python_package_assets(example):
                    staged_files = self._stage(example, asset)
                    staged_asset = python_package_asset(Path(out_dir), staged_files)
                    print(
                        f"\n{name}/{asset}: {len(staged_files)} files staged, synthesized as pinned, asset "
                        f"{staged_asset.name} identical"
                    )

    def test_a_local_test_tree_in_every_tree_is_refused_by_name(self) -> None:
        """A directory of test modules is importable from the archive root, so it is refused.

        It is not residue: Python imports it exactly like code the package might need, so a guard
        that dropped it silently would be guessing which unnamed importable unit was meant to ship.
        The refusal names the directory and the files it would have brought in, in every packaged
        tree of every example.
        """
        for example_spec in PYTHON_PACKAGE_EXAMPLES:
            name = example_spec.name
            example = self._example(name)
            for asset, trees in python_asset_trees(example):
                for tree in trees:
                    label = f"{name}: a local test tree in {tree.relative_to(harness.ROOT).as_posix()}"
                    with self.subTest(label):
                        plants = {"tests/test_local_only.py": "def test_local_only():\n    assert True\n"}
                        with planted_local_only_files([tree], plants) as planted:
                            result = run_python_package_staging(example, asset)
                        self._assert_refused(result, label, [str(path.relative_to(harness.ROOT)) for path in planted])
                        self.assertIn("tests/", self._refusal(result), f"{label}: the refusal does not name the tree")
                        self.assertIn(
                            "test_local_only.py",
                            self._refusal(result),
                            f"{label}: the refusal does not name the files the tree would have brought in",
                        )

    def test_a_linked_entry_in_every_tree_is_refused_by_name(self) -> None:
        """A symbolic link is a shape the walk cannot classify, so staging refuses it by name.

        `isFile()` and `isDirectory()` are both false for a link, so a linked module used to be
        classified as nothing: not checked, not shipped, and staging exited 0 — an import Python
        would satisfy from the source tree and the asset never could. The rule is the shape of the
        whole tree, so a link is refused rather than followed, whatever it points at.
        """
        for example_spec in PYTHON_PACKAGE_EXAMPLES:
            name = example_spec.name
            example = self._example(name)
            for asset, trees in python_asset_trees(example):
                # Every declared tree gets both link shapes: a module somewhere in it becomes the
                # target of a linked module, and its first directory the target of a linked one.
                for tree in trees:
                    module = next(iter(sorted(tree.rglob("*.py"))), None)
                    subdirectory = next((path for path in sorted(tree.iterdir()) if path.is_dir()), None)
                    cases = []
                    if module is not None:
                        cases.append(("a linked module", "linked_local.py", module))
                    if subdirectory is not None:
                        cases.append(("a linked directory", "linked_local_dir", subdirectory))
                    for label, link_name, target in cases:
                        with self.subTest(f"{name}/{asset}/{tree.name}: {label}"):
                            with planted_links([(tree, link_name, target)]) as planted:
                                result = run_python_package_staging(example, asset)
                            self._assert_refused(
                                result,
                                f"{name}: {label} in {tree}",
                                [str(path.relative_to(harness.ROOT)) for path in planted],
                            )
                            self.assertIn(
                                f"{link_name} (a symbolic link)",
                                self._refusal(result),
                                f"{name}: the refusal for {label} does not name the link: {self._refusal(result)}",
                            )
                            self.assertIn(
                                "not a regular file or a regular directory",
                                self._refusal(result),
                                f"{name}: the refusal for {label} does not state the rule",
                            )

    def test_an_undeclared_module_in_every_tree_is_refused_by_name(self) -> None:
        """Growth is a decision, not a silent omission: an unnamed module stops the build."""
        for example_spec in PYTHON_PACKAGE_EXAMPLES:
            name = example_spec.name
            example = self._example(name)
            for asset, trees in python_asset_trees(example):
                for tree in trees:
                    label = f"{name}: an undeclared module in {tree.relative_to(harness.ROOT).as_posix()}"
                    with self.subTest(label):
                        with planted_local_only_files([tree], {"undeclared_growth.py": "VALUE = 1\n"}) as planted:
                            result = run_python_package_staging(example, asset)
                        self._assert_refused(result, label, [str(path.relative_to(harness.ROOT)) for path in planted])
                        self.assertIn(
                            "undeclared_growth.py",
                            self._refusal(result),
                            f"{label}: the refusal does not name the module that made the allow-list incomplete",
                        )

    def test_a_standalone_byte_code_module_in_every_tree_is_refused_by_name(self) -> None:
        """A sourceless `<module>.pyc` is importable, so it is shipped or refused, never dropped.

        Python 3 imports a `<module>.pyc` that sits beside its siblings with no `.py` anywhere: it is
        a module in byte-code form, and the import system loads it exactly like the source it was
        compiled from. The walk used to list `.py` files only, so a `helper.pyc` in a packaged tree
        was not declared, not refused and not copied — staging exited 0, the asset shipped without
        it, and the deployed function failed to import a module its own source tree could
        (SAN-AT-W1C-01). Every declared tree of every example refuses it by name, which is the only
        answer that fails closed.
        """
        byte_code = byte_code_module()
        for example_spec in PYTHON_PACKAGE_EXAMPLES:
            name = example_spec.name
            example = self._example(name)
            for asset, trees in python_asset_trees(example):
                for tree in trees:
                    label = f"{name}: a sourceless module in {tree.relative_to(harness.ROOT).as_posix()}"
                    with self.subTest(label):
                        with planted_local_only_files([tree], {"helper.pyc": byte_code}) as planted:
                            result = run_python_package_staging(example, asset)
                        self._assert_refused(result, label, [str(path.relative_to(harness.ROOT)) for path in planted])
                        self.assertIn(
                            "helper.pyc",
                            self._refusal(result),
                            f"{label}: the refusal does not name the sourceless module it would have dropped",
                        )

    def test_an_extension_module_in_every_tree_is_refused_by_name(self) -> None:
        """An extension module is importable from the archive root, so it is named or refused.

        `.so` and `.pyd` are the same module written for the two loader families, and the import
        system loads either from a directory it has on `sys.path`. A walk that knows only `.py` would
        leave one behind in silence, so both are planted, and each is refused by name.
        """
        for example_spec in PYTHON_PACKAGE_EXAMPLES:
            name = example_spec.name
            example = self._example(name)
            for asset, trees in python_asset_trees(example):
                for tree in trees:
                    for planted_name in ("native.so", "native.pyd"):
                        label = (
                            f"{name}: an extension module {planted_name} in "
                            f"{tree.relative_to(harness.ROOT).as_posix()}"
                        )
                        with self.subTest(label):
                            with planted_local_only_files([tree], {planted_name: b"\x7fELF"}) as planted:
                                result = run_python_package_staging(example, asset)
                            self._assert_refused(
                                result, label, [str(path.relative_to(harness.ROOT)) for path in planted]
                            )
                            self.assertIn(
                                planted_name,
                                self._refusal(result),
                                f"{label}: the refusal does not name the extension module it would have dropped",
                            )

    def test_a_byte_code_cache_in_every_tree_stays_out_of_the_package(self) -> None:
        """A `__pycache__` is residue: the interpreter writes it, and nothing imports from it.

        The interpreter writes `<module>.<tag>.pyc` beside the source it compiled, and the import
        system never loads a file from inside a `__pycache__` — it looks for `<module>.py`,
        `<module>.pyc` and `<module>.so` in the directory it is importing from. So a cache is
        dropped in silence, at any depth, in every declared tree of every example, and the package
        it stages is the one it staged without a cache. The shape is planted as real byte-code:
        the files are what `py_compile` writes, under the name the running interpreter uses.
        """
        byte_code = byte_code_module()
        cache_name = importlib.util.cache_from_source("helper.py")
        for example_spec in PYTHON_PACKAGE_EXAMPLES:
            name = example_spec.name
            example = self._example(name)
            for asset, trees in python_asset_trees(example):
                clean = self._stage(example, asset)
                for tree in trees:
                    label = f"{name}: a byte-code cache in {tree.relative_to(harness.ROOT).as_posix()}"
                    with self.subTest(label):
                        plants = {cache_name: byte_code, f"nested/{cache_name}": byte_code}
                        with planted_local_only_files([tree], plants) as planted:
                            result = run_python_package_staging(example, asset)
                        self.assertEqual(
                            0,
                            result.returncode,
                            f"{label}: staging refused a byte-code cache it should drop in silence: "
                            f"{result.stderr.strip()}",
                        )
                        staged_files = self._staged_files(result)
                        self.assertEqual(
                            clean,
                            staged_files,
                            f"{label}: the cache changed the package, planted as "
                            f"{[str(path.relative_to(harness.ROOT)) for path in planted]}",
                        )
                        self.assertEqual(
                            [],
                            [path for path in staged_files if "__pycache__" in path or path.endswith(".pyc")],
                            f"{label}: the package ships the cache",
                        )

    def test_a_source_file_inside_a_cache_directory_is_still_refused(self) -> None:
        """A cache is residue; a source file that happens to sit in a `__pycache__` is not.

        `__pycache__` is a legal package name, and a `.py` file inside it imports — so a walk that
        skips the directory wholesale would drop a unit it cannot say is residue. Only byte-code is
        what the interpreter writes there, so only byte-code is dropped; a source file in the same
        directory is refused by name like any other undeclared module.
        """
        for example_spec in PYTHON_PACKAGE_EXAMPLES:
            name = example_spec.name
            example = self._example(name)
            for asset, trees in python_asset_trees(example):
                tree = trees[0]
                label = f"{name}: a source file inside a __pycache__ in {tree.relative_to(harness.ROOT).as_posix()}"
                with self.subTest(label):
                    with planted_local_only_files(
                        [tree], {"__pycache__/smuggled.py": "VALUE = 1\n"}
                    ) as planted:
                        result = run_python_package_staging(example, asset)
                    self._assert_refused(result, label, [str(path.relative_to(harness.ROOT)) for path in planted])
                    self.assertIn(
                        "smuggled.py",
                        self._refusal(result),
                        f"{label}: the refusal does not name the source file inside the cache directory",
                    )

    def _assert_refused(self, result: subprocess.CompletedProcess[str], label: str, planted: list[str]) -> None:
        self.assertNotEqual(0, result.returncode, f"staging accepted {label}, planted as {planted}")
        self.assertTrue(
            self._refusal(result),
            f"the staging failure for {label} does not report an error: {result.stderr.strip()}",
        )

    @staticmethod
    def _refusal(result: subprocess.CompletedProcess[str]) -> str:
        """The refusal line staging printed, or an empty string when it printed none."""
        refused = [line for line in result.stderr.splitlines() if line.startswith("Error: ")]
        return refused[0] if refused else ""


class WebFunctionPythonDisconnectTests(unittest.TestCase):
    """A client that leaves mid-response releases the producer, under real servers.

    SAN-AT-W1B-03 / ADV-W1B-01: uvicorn does not fail a send on a dead transport, so the ASGI wrapper
    has to watch `receive()` for `http.disconnect`; the WSGI direction already released because the
    server's write fails and the iterable is closed. Both directions are driven here through the
    real servers the rows use, against a probe application that records how far its producer got.
    """

    def test_an_asgi_client_that_goes_away_stops_the_producer(self) -> None:
        port = ephemeral_port()
        with self._probe() as (directory, state):
            env = clean_python_env(
                PYTHONPATH=str(harness.ROOT / "py" / "src"),
                PROBE_STATE=str(state),
            )
            with StartedServer(
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "main:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--log-level",
                    "warning",
                ],
                cwd=directory,
                env=env,
                port=port,
                label="ASGI disconnect probe server",
            ):
                self._read_one_chunk_and_leave(port, "asgi")
                elapsed = wait_for_producer_close(state)
        ticks = producer_ticks(state)
        self.assertLess(
            len(ticks),
            DISCONNECT_TICK_CEILING,
            f"the ASGI producer ran on after the client went away: {len(ticks)} of 200 chunks, "
            f"released after {elapsed:.2f}s",
        )
        self.assertNotIn("done", producer_state(state), "the ASGI producer ran to the end of a response nobody read")
        print(f"\nasgi disconnect: producer released {elapsed:.2f}s after the client left, at chunk {len(ticks)} of 200")

    def test_a_wsgi_client_that_goes_away_stops_the_producer(self) -> None:
        port = ephemeral_port()
        with self._probe() as (directory, state):
            env = clean_python_env(
                PYTHONPATH=str(harness.ROOT / "py" / "src"),
                PROBE_STATE=str(state),
                PORT=str(port),
            )
            with StartedServer(
                [
                    sys.executable,
                    str(harness.WEB_FUNCTION_PYTHON_EXAMPLE / "scripts" / "serve-wsgi.py"),
                    str(directory),
                ],
                cwd=directory,
                env=env,
                port=port,
                label="WSGI disconnect probe server",
            ):
                self._read_one_chunk_and_leave(port, "wsgi")
                elapsed = wait_for_producer_close(state)
        ticks = producer_ticks(state)
        self.assertLess(
            len(ticks),
            DISCONNECT_TICK_CEILING,
            f"the WSGI producer ran on after the client went away: {len(ticks)} of 200 chunks, "
            f"released after {elapsed:.2f}s",
        )
        self.assertNotIn("done", producer_state(state), "the WSGI producer ran to the end of a response nobody read")
        print(f"\nwsgi disconnect: producer released {elapsed:.2f}s after the client left, at chunk {len(ticks)} of 200")

    @contextlib.contextmanager
    def _probe(self) -> object:
        """A temporary probe application, with the file its producer records into."""
        directory = Path(tempfile.mkdtemp(prefix="apptheory-web-function-probe-"))
        try:
            write(directory, "probe_stream.py", ASGI_DISCONNECT_PROBE)
            write(directory, "main.py", ASGI_PROBE_MAIN)
            write(directory, "main_wsgi.py", WSGI_PROBE_MAIN)
            yield directory, directory / "producer-state.txt"
        finally:
            shutil.rmtree(directory, ignore_errors=True)

    def _read_one_chunk_and_leave(self, port: int, label: str) -> None:
        """Open the stream, read one chunk, and close the connection: the client is gone."""
        with socket.create_connection(("127.0.0.1", port), timeout=30) as client:
            client.sendall(b"GET /stream HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            first = client.recv(4096)
        if not first:
            raise harness.HarnessFailure(f"the {label} probe stream sent nothing before the client left")


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
