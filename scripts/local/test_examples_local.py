#!/usr/bin/env python3
"""Self-tests for the AppTheory local examples harness.

These run before every ``make examples-local``. They pin the discovery
conventions against the real tree and prove manifest validation fails closed
when an entrypoint is unclassified, when a row names a file that does not
exist, and when the local profile drifts onto a reserved port.

They never touch Docker: every case is either pure validation over the real
tree or a throwaway tree under the system temp directory.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import run_examples_local as harness  # noqa: E402


def write(root: Path, relative: str, content: str = "") -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


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
        self.assertEqual(57, len(classified))
        by_key = {entry.key: entry for entry in entries}
        expected = {
            "examples/cdk/ssr-site/bin/apptheory-ssr-site.ts": "ssr-site-gateway",
            "examples/cdk/ssr-only-provided-assets-site/bin/app.ts": "ssr-only-gateway",
            "examples/cdk/path-routed-frontend/bin/app.ts": "path-routed-gateway",
            "examples/cdk/media-cdn/bin/app.ts": "media-cdn-gateway",
            "examples/cdk/ssr-site/scripts/generate-assets-manifest.mjs": "ssr-assets-manifest",
            "examples/cdk/ssr-site/scripts/upload-assets.sh": "ssr-assets-upload",
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
