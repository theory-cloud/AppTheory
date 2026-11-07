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

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
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
        # SSE-S3 row and the seven LOCAL-W2-TLS rows.
        self.assertEqual(106, len(classified))
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
            "examples/cdk/local-tls/handlers/go/main.go": "local-tls-callback-go",
            "examples/cdk/local-tls/scripts/callback-node.sh": "local-tls-callback-node",
            "examples/cdk/local-tls/handlers/python/caller.py": "local-tls-callback-py",
            "examples/cdk/local-tls/scripts/oidc.sh": "local-tls-oidc",
            "examples/cdk/local-tls/scripts/browser-webauthn.sh": "local-tls-webauthn",
            "examples/cdk/local-tls/scripts/aux-cert.sh": "local-tls-aux-cert",
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
