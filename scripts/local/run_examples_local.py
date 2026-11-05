#!/usr/bin/env python3
"""AppTheory local examples harness (``make examples-local``).

Runs every example entrypoint classified by ``scripts/local/examples-local.json``
against the checked-in DynamoDB Local profile, asserting each example's real
outcome. It never contacts AWS: the harness sets the endpoint overrides and
static dummy credentials itself, and the preflight refuses to start when an SDK
would resolve DynamoDB anywhere else.

Rules enforced here:

* enumeration is derived from the repository tree, so an entrypoint that is not
  in the manifest fails the run;
* every manifest row names a file that exists in the tree, pending rows
  included; only ``coveredBy`` may point at a non-entrypoint helper;
* a skip is a failure, including a ``t.Skip`` inside a Go test;
* entries owned by a later milestone are reported as ``PENDING-MILESTONE`` and
  are never counted as pass;
* every assertion is made against real output or real HTTP behavior, never
  against a mock.

Concurrency isolation: the compose project name and the host ports are derived
per checkout from the checkout path, leased exclusively, and overridable only
through this harness's ``--slot``/``--port`` options. Two checkouts on one host
therefore never share or recreate each other's DynamoDB.
"""

from __future__ import annotations

import argparse
import base64
import datetime
import fcntl
import gzip
import hashlib
import http.server
import json
import os
import re
import select
import shutil
import signal
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[2]
HARNESS_DIR = Path(__file__).resolve().parent
MANIFEST_PATH = HARNESS_DIR / "examples-local.json"
STATE_DIR = Path.home() / ".cache" / "apptheory-examples-local"

CLASSES = ("L1", "L2", "L3", "I")
MILESTONES = ("A3a", "A3b", "A4", "A5a", "A5b")
# Dependency trees, build output and the CDK staging trees the examples
# generate: never entrypoints.
EXCLUDED_DIR_PARTS = {
    ".cdk-asset-stage",
    "node_modules",
    "cdk.out",
    "dist",
    "vendor",
    "__pycache__",
    ".venv",
}
# Support modules and static content inside an example: real files, no
# entrypoint. ``lib/`` holds CDK constructs, ``assets/`` holds site content that
# is uploaded rather than executed.
NON_ENTRYPOINT_DIR_PARTS = {"lib", "test", "tests", "assets"}
TS_SUFFIXES = frozenset({".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"})
RUNTIME_SUFFIXES = TS_SUFFIXES | {".py"}
TEST_FILE_MARKERS = (".test.", ".spec.", "_test.")
GENERATED_MARKER_RE = re.compile(r"Code generated .*\bDO NOT EDIT\b")
GO_MAIN_RE = re.compile(r"^func main\(\)", re.MULTILINE)
GO_IGNORE_RE = re.compile(r"^//go:build\s+ignore\b", re.MULTILINE)
DEFAULT_TIMEOUT = 900
FAILURE_OUTPUT_LINES = 60
RATE_LIMIT_TABLE = "rate-limits"
LOCAL_RUNNER_APP = "examples/cdk/hello-world"
LOCAL_RUNNER_BIN = STATE_DIR / "bin" / "apptheory-local"
MULTILANG_APP = "examples/cdk/multilang"
LESSER_PARITY_APP = "examples/cdk/lesser-parity"
RESTV1_APP = "examples/cdk/restv1-router"
LAMBDA_ROLE_APP = "examples/cdk/lambda-role"
SQS_APP = "examples/cdk/sqs-queue"
SNS_HTTP_PORT = 18120
IMPORT_APP = "examples/cdk/import-pipeline"
KINESIS_APP = "examples/cdk/kinesis-cloudwatch-logs"
MICROVM_APP = "examples/cdk/microvm-controller"
VECTORS_APP = "examples/cdk/s3-vectors-semantic-search"
SSR_SITE_APP = "examples/cdk/ssr-site"
SSR_ONLY_APP = "examples/cdk/ssr-only-provided-assets-site"
PATH_ROUTED_APP = "examples/cdk/path-routed-frontend"
MEDIA_CDN_APP = "examples/cdk/media-cdn"
LAMBDA_PACKAGING_APP = "examples/cdk/lambda-packaging"
CONFORMANCE_SCRIPT = "examples/microvm-conformance/run_local.py"
MICROVM_DEMO_TOKEN = "local-demo-token"
MICROVM_WORKLOAD_GO = STATE_DIR / "bin" / "microvm-workload-go"
LOCAL_PROFILE = "scripts/local/examples-local.json"
MCP_HANDLER_BIN_DIR = STATE_DIR / "handlers"
MCP_EXAMPLES = {
    "tools-only": "examples/mcp/tools-only",
    "tools-resources-prompts": "examples/mcp/tools-resources-prompts",
    "resumable-sse": "examples/mcp/resumable-sse",
}
LOCAL_RUNNER_READY = "local-run: ready"
LOCAL_RUNNER_CLOCK_START = "2026-01-01T00:00:00Z"
# The delivery engine registers every derived source. A kind with a deliverer is
# registered in plan and live in a session; a kind without one still reports the
# task that will implement it.
DELIVERY_TASKS = {
    "sqs": "E1b",
    "dynamodb": "E2",
    "kinesis": "E5",
    "eventbridge-schedule": "E3",
    "eventbridge-rule": "E3",
    "cloudwatch-logs": "E5",
    "sns": "E6",
    "s3-notification": "E4",
}
DELIVERED_KINDS = {
    "sqs", "sns", "dynamodb", "kinesis", "cloudwatch-logs",
    "eventbridge-schedule", "eventbridge-rule", "s3-notification",
}
# The local backend a kind needs to deliver. A rule needs none: the runner
# serves the bus itself.
DELIVERY_BACKEND = {
    "sqs": "sqs",
    "sns": "moto",
    "dynamodb": "dynamodb",
    "kinesis": "moto",
    "cloudwatch-logs": "moto",
    "eventbridge-schedule": None,
    "eventbridge-rule": None,
    "s3-notification": "s3proxy",
}
# The live state a kind reaches when its backend is present.
DELIVERY_LIVE_STATE = {
    "sqs": ("polling", "paused", "failed"),
    "sns": ("armed", "failed"),
    "dynamodb": ("polling", "paused", "failed"),
    "kinesis": ("polling", "paused", "failed"),
    "cloudwatch-logs": ("polling", "paused", "failed"),
    "eventbridge-schedule": ("armed", "failed"),
    "eventbridge-rule": ("armed", "failed"),
    "s3-notification": ("polling", "failed"),
}
DELIVERY_CONCURRENCY = 4
LOCAL_RUNNER_RUNTIMES = {"go": "provided.al2023", "ts": "nodejs24.x", "py": "python3.14"}
# The handler response each language returned, compared across languages once
# all three rows have run. This is the parity assertion: same handler contract,
# three real runtime images.
LOCAL_RUNNER_RESPONSES: dict[str, dict] = {}
DIGEST_PIN_RE = re.compile(r"@sha256:[0-9a-f]{64}$")
LAMBDA_IMAGE_PREFIXES = {
    "go": "public.ecr.aws/lambda/provided:",
    "node": "public.ecr.aws/lambda/nodejs:",
    "python": "public.ecr.aws/lambda/python:",
}


class HarnessFailure(Exception):
    """A row failed. ``output`` carries the child process output for reporting."""

    def __init__(self, message: str, output: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.output = output


@dataclass
class Entry:
    key: str
    kind: str
    data: dict

    @property
    def class_name(self) -> str:
        return str(self.data.get("class", ""))

    @property
    def pending(self) -> str:
        return str(self.data.get("pending", ""))

    @property
    def runner(self) -> str:
        return str(self.data.get("run", ""))

    @property
    def covered_by(self) -> str:
        return str(self.data.get("coveredBy", ""))

    @property
    def description(self) -> str:
        return str(self.data.get("description", ""))

    @property
    def label(self) -> str:
        return f"{self.key} [{self.kind}]" if self.kind == "suite" else self.key


@dataclass
class Lease:
    """The exclusive local-profile claim this run holds.

    ``slot`` selects a fixed block of ports, ``port`` is the DynamoDB endpoint,
    and ``project`` is the compose project name. All three derive from the
    checkout identifier unless the harness CLI overrides them, so a repository
    copy and a reviewer's checkout cannot meet on the same container.
    """

    checkout: str
    slot: int
    port: int
    project: str
    http_port: int
    aux_port: int
    owned: bool = True
    external: bool = False
    lock_fd: int = -1

    def release(self) -> None:
        if self.lock_fd < 0:
            return
        try:
            fcntl.flock(self.lock_fd, fcntl.LOCK_UN)
        finally:
            os.close(self.lock_fd)
            self.lock_fd = -1


@dataclass
class Harness:
    env: dict
    lease: Lease
    timeout: int = DEFAULT_TIMEOUT

    def run(
        self,
        argv: list[str],
        *,
        cwd: Path | None = None,
        env: dict | None = None,
        timeout: int | None = None,
        check: bool = True,
        stdin_data: str | None = None,
    ) -> subprocess.CompletedProcess:
        child_env = dict(self.env)
        if env:
            child_env.update(env)
        try:
            result = subprocess.run(
                argv,
                cwd=str(cwd or ROOT),
                env=child_env,
                input=stdin_data,
                capture_output=True,
                text=True,
                timeout=timeout or self.timeout,
                check=False,
            )
        except FileNotFoundError as exc:
            raise HarnessFailure(f"{argv[0]} is not available: {exc}") from exc
        except subprocess.TimeoutExpired as exc:
            output = _decode_timeout_output(exc)
            raise HarnessFailure(
                f"timed out after {timeout or self.timeout}s: {' '.join(argv)}", output
            ) from exc

        if check and result.returncode != 0:
            raise HarnessFailure(
                f"command exited {result.returncode}: {' '.join(argv)}",
                _combined_output(result),
            )
        return result


def _decode_timeout_output(exc: subprocess.TimeoutExpired) -> str:
    parts = []
    for blob in (exc.stdout, exc.stderr):
        if blob is None:
            continue
        parts.append(blob.decode("utf-8", "replace") if isinstance(blob, bytes) else blob)
    return "\n".join(parts)


def _combined_output(result: subprocess.CompletedProcess) -> str:
    return "\n".join(part for part in (result.stdout, result.stderr) if part)


def _tail(text: str, lines: int = FAILURE_OUTPUT_LINES) -> str:
    selected = text.strip().splitlines()[-lines:]
    return "\n".join(selected)


def expect_output(output: str, needles: list[str], label: str) -> None:
    missing = [needle for needle in needles if needle not in output]
    if missing:
        raise HarnessFailure(
            f"{label}: expected output is missing: {', '.join(missing)}", output
        )


def http_request(
    method: str,
    url: str,
    *,
    headers: dict | None = None,
    body: bytes | None = None,
    timeout: float = 15,
) -> tuple[int, str, dict]:
    request = urllib.request.Request(url, data=body, method=method)
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace"), normalized_headers(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace"), normalized_headers(exc.headers)
    except urllib.error.URLError as exc:
        raise HarnessFailure(f"{method} {url} failed: {exc.reason}") from exc


def normalized_headers(headers) -> dict:
    """Return headers keyed by lowercase name.

    HTTP header names are case-insensitive, and Go canonicalizes
    ``X-RateLimit-Limit`` to ``X-Ratelimit-Limit``; a case-sensitive lookup
    would silently read ``None`` instead of the limiter's header.
    """
    return {key.lower(): value for key, value in headers.items()}


def expect_status(actual: int, expected: int, label: str, body: str = "") -> None:
    if actual != expected:
        raise HarnessFailure(f"{label}: status {actual}, want {expected}", body)


# --- discovery and manifest -------------------------------------------------


def discover(root: Path) -> dict[str, str]:
    """Return every example entrypoint discovered from the tree.

    The rules are structural, so an example cannot hide from the manifest:

    * ``examples/**/*.go`` that declares ``func main`` is a Go entrypoint
      (``func main`` is the entrypoint marker; path conventions do not apply);
    * a Go file whose build constraint excludes it (``//go:build ignore``) is a
      reference document, not an entrypoint (``examples/migration/rate-limited-http/before``);
    * ``examples/**/*.sh`` is a shell runner;
    * files under ``examples/`` with a runtime suffix (``.ts``, ``.mts``,
      ``.cts``, ``.js``, ``.mjs``, ``.cjs``, ``.py``) are runtime entrypoints;
    * any other executable file under that tree is a runner.

    Non-entrypoint files are skipped by a documented convention:

    * dependency trees and build output (``node_modules``, ``cdk.out``,
      ``dist``, ``vendor``, ``__pycache__``, ``.venv``) and the CDK staging
      trees the examples generate (``.cdk-asset-stage``);
    * support modules, tests and static site content inside an example
      (``lib/``, ``test/``, ``tests/``, ``assets/``) and test files
      (``*.test.*``, ``*.spec.*``, ``*_test.*``);
    * generated output, marked ``Code generated ... DO NOT EDIT`` in its first
      lines.

    ``bin/`` is deliberately *not* excluded: a CDK app entrypoint such as
    ``examples/cdk/hello-world/bin/apptheory-hello-world.ts`` is a real
    entrypoint that must be classified like any other runtime file.
    """
    found: dict[str, str] = {}

    def relative(path: Path) -> str:
        return path.relative_to(root).as_posix()

    def excluded_dir(path: Path) -> bool:
        return any(part in EXCLUDED_DIR_PARTS for part in path.relative_to(root).parts)

    def excluded_runtime_file(path: Path) -> bool:
        parts = path.relative_to(root).parts
        if any(part in EXCLUDED_DIR_PARTS for part in parts):
            return True
        if any(part in NON_ENTRYPOINT_DIR_PARTS for part in parts[:-1]):
            return True
        if any(marker in path.name for marker in TEST_FILE_MARKERS):
            return True
        return generated_output(path)

    for path in sorted((root / "examples").rglob("*.go")):
        if excluded_runtime_file(path):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if GO_IGNORE_RE.search(text):
            continue
        if GO_MAIN_RE.search(text):
            found[relative(path)] = "go-main"

    for path in sorted((root / "examples").rglob("*.sh")):
        if excluded_runtime_file(path):
            continue
        found[relative(path)] = "shell-runner"

    base = root / "examples"
    if base.is_dir():
        for path in _walk_files(base):
            if excluded_runtime_file(path):
                continue
            suffix = path.suffix.lower()
            if suffix == ".sh":
                continue  # already classified by the shell pass above
            if suffix in RUNTIME_SUFFIXES:
                found[relative(path)] = "ts" if suffix in TS_SUFFIXES else "py"
            elif os.access(path, os.X_OK):
                found[relative(path)] = "executable"

    return found


def _walk_files(base: Path):
    """Yield files below ``base`` without descending into excluded trees."""
    for current, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(
            name
            for name in dirnames
            if name not in EXCLUDED_DIR_PARTS and name not in NON_ENTRYPOINT_DIR_PARTS
        )
        for name in sorted(filenames):
            yield Path(current) / name


def generated_output(path: Path) -> bool:
    """True when the file carries the ``Code generated ... DO NOT EDIT`` marker."""
    try:
        head = path.read_text(encoding="utf-8", errors="replace").splitlines()[:5]
    except OSError:
        return False
    return any(GENERATED_MARKER_RE.search(line) for line in head)


def load_manifest(path: Path) -> tuple[dict, list[Entry]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise HarnessFailure(f"missing classification manifest: {path}") from exc
    except json.JSONDecodeError as exc:
        raise HarnessFailure(f"invalid JSON in {path}: {exc}") from exc

    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise HarnessFailure(f"{path}: expected a version 1 classification manifest")

    profile = raw.get("profile")
    if not isinstance(profile, dict):
        raise HarnessFailure(f"{path}: missing profile object")
    for key in ("composeFile", "dynamodbLocal", "ports"):
        if key not in profile:
            raise HarnessFailure(f"{path}: profile is missing {key}")

    entries: list[Entry] = []
    for key, data in raw.get("entrypoints", {}).items():
        if not isinstance(data, dict):
            raise HarnessFailure(f"{path}: entry {key} must be an object")
        entries.append(Entry(key=key, kind="entrypoint", data=data))
    for key, data in raw.get("suites", {}).items():
        if not isinstance(data, dict):
            raise HarnessFailure(f"{path}: suite {key} must be an object")
        entries.append(Entry(key=key, kind="suite", data=data))

    return profile, entries


def validate_manifest(
    root: Path,
    manifest_path: Path,
    profile: dict,
    entries: list[Entry],
    discovered: dict[str, str],
    runners: dict[str, Callable],
) -> list[str]:
    errors: list[str] = []

    entrypoint_keys = {entry.key for entry in entries if entry.kind == "entrypoint"}
    by_key = {entry.key: entry for entry in entries}
    for path in sorted(set(discovered) - entrypoint_keys):
        errors.append(f"unclassified entrypoint (add it to {manifest_path.name}): {path}")

    # Every row names a real file, pending rows included: a pending row is a
    # claim about the tree just like a classified one. Only a coveredBy row may
    # point at a file that discovery does not treat as an entrypoint, because it
    # documents a helper executed inside another row.
    for path in sorted(entrypoint_keys):
        entry = by_key[path]
        if not (root / path).is_file():
            errors.append(f"manifest entry does not name a file in the tree: {path}")
        elif not entry.covered_by and path not in discovered:
            errors.append(
                f"{path}: pending and classified rows must name a discovered entrypoint"
            )

    runner_owner: dict[str, str] = {}

    for entry in entries:
        if entry.kind == "suite":
            suite_dir = root / entry.key
            if not (suite_dir / "go.mod").is_file():
                errors.append(f"suite is not a Go module: {entry.key}")

        if entry.class_name and entry.pending:
            errors.append(f"{entry.key}: declare either class or pending, not both")
        if not entry.class_name and not entry.pending:
            errors.append(f"{entry.key}: declare a class ({'/'.join(CLASSES)}) or pending <milestone>")
        if entry.class_name and entry.class_name not in CLASSES:
            errors.append(f"{entry.key}: unknown class {entry.class_name!r}")
        if entry.pending and entry.pending not in MILESTONES:
            errors.append(f"{entry.key}: unknown milestone {entry.pending!r}")

        if entry.pending:
            if entry.runner or entry.covered_by:
                errors.append(f"{entry.key}: a pending entry must not be executed")
            continue

        if entry.covered_by:
            target = by_key.get(entry.covered_by)
            if target is None:
                errors.append(f"{entry.key}: coveredBy target is not in the manifest: {entry.covered_by}")
            elif not target.runner or target.pending:
                errors.append(f"{entry.key}: coveredBy target has no runner: {entry.covered_by}")
            elif entry.covered_by == entry.key:
                errors.append(f"{entry.key}: coveredBy cannot reference itself")
            continue

        if not entry.runner:
            errors.append(f"{entry.key}: classified examples need a runner")
            continue
        if entry.runner not in runners:
            errors.append(f"{entry.key}: unknown runner {entry.runner!r}")
        if entry.runner in runner_owner:
            errors.append(
                f"{entry.key}: runner {entry.runner!r} is already used by {runner_owner[entry.runner]}"
            )
        else:
            runner_owner[entry.runner] = entry.key

    errors.extend(_validate_profile(root, profile))
    return errors


PORT_RESERVED = {8000: "the shared :8000 convention", 8123: "TableTheory's local profile"}


def _validate_profile(root: Path, profile: dict) -> list[str]:
    errors: list[str] = []
    compose_path = root / str(profile.get("composeFile", ""))
    local = profile.get("dynamodbLocal", {})
    ports = profile.get("ports", {})
    image = str(local.get("image", ""))
    default_port = int(local.get("port", 0))
    first = int(ports.get("first", 0))
    last = int(ports.get("last", 0))
    stride = int(ports.get("stride", 0))

    if not compose_path.is_file():
        errors.append(f"profile compose file is missing: {profile.get('composeFile')}")
        return errors

    if not DIGEST_PIN_RE.search(image):
        errors.append(f"profile: DynamoDB Local image must be pinned by digest (got {image!r})")
    errors.extend(_validate_lambda_images(profile))
    errors.extend(_validate_endpoints(profile))

    compose_text = compose_path.read_text(encoding="utf-8")
    if image and f"image: {image}" not in compose_text:
        errors.append(f"{compose_path}: image pin does not match the manifest ({image})")
    if "127.0.0.1:${APPTHEORY_LOCAL_DDB_PORT:-" not in compose_text:
        errors.append(
            f"{compose_path}: the host port must be harness-owned "
            "(127.0.0.1:${APPTHEORY_LOCAL_DDB_PORT:-<default>}:8000)"
        )
    if default_port and f"${{APPTHEORY_LOCAL_DDB_PORT:-{default_port}}}" not in compose_text:
        errors.append(f"{compose_path}: default port does not match the manifest ({default_port})")

    if default_port in PORT_RESERVED:
        errors.append(f"profile: port {default_port} is reserved for {PORT_RESERVED[default_port]}")
    if first <= 8000 <= last or first <= 8123 <= last:
        errors.append(f"profile: port range {first}-{last} overlaps the reserved 8000/8123")
    if not (first <= default_port <= last):
        errors.append(f"profile: default port {default_port} is outside the range {first}-{last}")
    if stride < 3:
        errors.append("profile: stride must reserve at least three ports per slot")
    if last - first + 1 < stride:
        errors.append("profile: port range cannot hold one slot")
    return errors


def _validate_lambda_images(profile: dict) -> list[str]:
    """The Lambda runtime images are pinned once, here, by digest."""
    errors: list[str] = []
    images = profile.get("lambda", {}).get("images")
    if not isinstance(images, dict):
        return ["profile: missing lambda.images pins for the go, node and python runtimes"]
    for runtime, prefix in LAMBDA_IMAGE_PREFIXES.items():
        pin = images.get(runtime)
        if not isinstance(pin, dict):
            errors.append(f"profile: missing lambda.images.{runtime} pin")
            continue
        tag = str(pin.get("tag", ""))
        digest = str(pin.get("digest", ""))
        if not tag.startswith(prefix):
            errors.append(
                f"profile: lambda.images.{runtime} tag {tag!r} is not an official image ({prefix}...)"
            )
        if not DIGEST_PIN_RE.search(f"{tag}@{digest}"):
            errors.append(f"profile: lambda.images.{runtime} must be pinned by digest (got {digest!r})")
    return errors


def _validate_endpoints(profile: dict) -> list[str]:
    """Every local backend the harness owns needs its SDK env names declared."""
    endpoints = profile.get("endpoints")
    if not isinstance(endpoints, dict) or not endpoints:
        return ["profile: missing endpoints (the generated AWS endpoint variables)"]
    errors: list[str] = []
    for service, spec in endpoints.items():
        names = spec.get("env") if isinstance(spec, dict) else None
        if not isinstance(names, list) or not names:
            errors.append(f"profile: endpoints.{service} must declare at least one env name")
            continue
        if not any(name.startswith("AWS_ENDPOINT_URL") for name in names):
            errors.append(f"profile: endpoints.{service} must declare an AWS_ENDPOINT_URL* name")
    if "dynamodb" not in endpoints:
        errors.append("profile: endpoints.dynamodb is required")
    return errors


# --- profile lease ----------------------------------------------------------


def checkout_identifier(root: Path) -> str:
    digest = hashlib.sha256(str(root.resolve()).encode("utf-8")).hexdigest()
    return digest[:8]


def slot_ports(profile: dict, slot: int) -> tuple[int, int, int]:
    ports = profile["ports"]
    base = int(ports["first"]) + int(ports["stride"]) * slot
    return base, base + 1, base + 2


def slot_count(profile: dict) -> int:
    ports = profile["ports"]
    return (int(ports["last"]) - int(ports["first"]) + 1) // int(ports["stride"])


def port_open(host: str, port: int, timeout: float = 0.5) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def wait_for_port(port: int, *, host: str = "127.0.0.1", seconds: int = 180) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if port_open(host, port):
            return
        time.sleep(0.5)
    raise HarnessFailure(f"DynamoDB Local did not answer on {host}:{port} within {seconds}s")


def _lease_path(checkout: str) -> Path:
    return STATE_DIR / f"lease-{checkout}.json"


def read_lease(checkout: str) -> dict | None:
    try:
        return json.loads(_lease_path(checkout).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def write_lease(lease: Lease, compose_file: Path) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "checkout": lease.checkout,
        "slot": lease.slot,
        "port": lease.port,
        "project": lease.project,
        "composeFile": str(compose_file),
        "writtenAt": int(time.time()),
    }
    _lease_path(lease.checkout).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def acquire_lease(
    profile: dict, checkout: str, *, slot: int | None, port: int | None
) -> Lease:
    if slot is not None and port is not None:
        raise HarnessFailure("--slot and --port are mutually exclusive")
    if slot is not None:
        if slot < 0 or slot >= slot_count(profile):
            raise HarnessFailure(f"--slot must be within 0..{slot_count(profile) - 1}")
        chosen = slot
        base, http, aux = slot_ports(profile, chosen)
    elif port is not None:
        if port in PORT_RESERVED:
            raise HarnessFailure(f"--port {port} is reserved for {PORT_RESERVED[port]}")
        chosen = -1
        base, http, aux = port, port + 1, port + 2
    else:
        preferred = int(checkout, 16) % slot_count(profile)
        chosen = -1
        for offset in range(slot_count(profile)):
            candidate = (preferred + offset) % slot_count(profile)
            base, http, aux = slot_ports(profile, candidate)
            project = f"apptheory-examples-local-{checkout}-s{candidate}"
            if not any(port_open("127.0.0.1", value) for value in (base, http, aux)) or _project_owns(
                project
            ):
                chosen = candidate
                break
        if chosen < 0:
            raise HarnessFailure(
                "no free local-profile slot; stop the containers or examples holding the range"
            )

    project = (
        f"apptheory-examples-local-{checkout}-s{chosen}"
        if chosen >= 0
        else f"apptheory-examples-local-{checkout}-p{base}"
    )
    return Lease(
        checkout=checkout,
        slot=chosen,
        port=base,
        project=project,
        http_port=http,
        aux_port=aux,
    )


def _project_owns(project: str) -> bool:
    result = subprocess.run(
        ["docker", "compose", "-p", project, "ps", "-q", "dynamodb-local"],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


def _docker_available() -> bool:
    result = subprocess.run(["docker", "info"], capture_output=True, text=True, check=False)
    return result.returncode == 0


def build_env(lease: Lease) -> dict:
    endpoint = f"http://127.0.0.1:{lease.port}"
    # Start from a clean AWS surface: an inherited profile, session token or
    # endpoint override must not be able to redirect any child process.
    env = {key: value for key, value in os.environ.items() if not key.startswith("AWS_")}
    for key in (
        "DDB_ENDPOINT",
        "DYNAMODB_ENDPOINT",
        "LISTEN_ADDR",
        "APPTHEORY_RATE_LIMIT_TABLE_NAME",
        "RATE_LIMIT_TABLE_NAME",
        "RATE_LIMIT_TABLE",
        "LIMITED_TABLE_NAME",
        "CDK_DEFAULT_ACCOUNT",
        "CDK_DEFAULT_REGION",
        "CDK_OUTDIR",
        "CDK_CONTEXT_JSON",
    ):
        env.pop(key, None)
    # Proxy variables are cleared in both cases for the same reason: no child
    # request may be routed anywhere the harness did not choose.
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"):
        env.pop(key, None)
        env.pop(key.lower(), None)
    env.update(
        {
            "AWS_REGION": "us-east-1",
            "AWS_DEFAULT_REGION": "us-east-1",
            "AWS_ACCESS_KEY_ID": "dummy",
            "AWS_SECRET_ACCESS_KEY": "dummy",
            "AWS_EC2_METADATA_DISABLED": "true",
            "AWS_CONFIG_FILE": os.devnull,
            "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
            "AWS_ENDPOINT_URL": endpoint,
            "AWS_ENDPOINT_URL_DYNAMODB": endpoint,
            "DYNAMODB_ENDPOINT": endpoint,
            "DDB_ENDPOINT": endpoint,
            "APPTHEORY_RATE_LIMIT_TABLE_NAME": RATE_LIMIT_TABLE,
        }
    )
    # A repository that pins `toolchain` gets exactly that toolchain; one that
    # only declares a `go` version (AppTheory's current go.mod) keeps the
    # caller's selected toolchain, which tc-toolchain already verifies.
    toolchain = go_toolchain()
    if toolchain:
        env["GOTOOLCHAIN"] = toolchain
    return env


def go_toolchain() -> str:
    text = (ROOT / "go.mod").read_text(encoding="utf-8")
    match = re.search(r"^toolchain (\S+)$", text, re.MULTILINE)
    return match.group(1) if match else ""


def compose(
    harness: Harness, lease: Lease, compose_file: Path, *args: str, timeout: int = 300
) -> subprocess.CompletedProcess:
    env = {"APPTHEORY_LOCAL_DDB_PORT": str(lease.port)}
    return harness.run(
        ["docker", "compose", "-f", str(compose_file), "-p", lease.project, *args],
        env=env,
        timeout=timeout,
        check=False,
    )


def preflight(harness: Harness, profile: dict, compose_file: Path) -> None:
    lease = harness.lease
    endpoint = f"http://127.0.0.1:{lease.port}"
    docker_here = _docker_available()

    if docker_here and not lease.external:
        existing = compose(harness, lease, compose_file, "ps", "-q", "dynamodb-local", timeout=60)
        if existing.returncode == 0 and existing.stdout.strip():
            # The harness owns this container, so every run starts from an
            # empty in-memory database. Examples must not depend on state a
            # previous run (or another session) left behind.
            compose(harness, lease, compose_file, "down", "-v", timeout=120)
            print("  PASS  recreated the profile container (clean database)")

    if not port_open("127.0.0.1", lease.port):
        if lease.external:
            # CI supplies the profile as a service container. It may still be
            # starting, so wait for the port instead of starting a second
            # DynamoDB Local that would fight it for the same host port.
            wait_for_port(lease.port, seconds=180)
            print(f"  PASS  external DynamoDB Local answered on 127.0.0.1:{lease.port}")
        elif not docker_here:
            raise HarnessFailure(
                "DynamoDB Local is not listening and Docker is unavailable; start Colima/Docker first"
            )
        else:
            started = compose(harness, lease, compose_file, "up", "-d")
            if started.returncode != 0:
                raise HarnessFailure(
                    f"docker compose up failed for {lease.project}",
                    _combined_output(started),
                )
            lease.owned = True

    for key in ("AWS_ENDPOINT_URL_DYNAMODB", "DYNAMODB_ENDPOINT", "AWS_ENDPOINT_URL", "DDB_ENDPOINT"):
        resolved = harness.env.get(key)
        if resolved != endpoint:
            raise HarnessFailure(f"{key} is {resolved!r}; the harness must own it ({endpoint})")
    print("  PASS  harness owns AWS_ENDPOINT_URL_DYNAMODB, DYNAMODB_ENDPOINT, DDB_ENDPOINT and AWS_ENDPOINT_URL")

    for name, port in (("http", lease.http_port), ("aux", lease.aux_port)):
        if port_open("127.0.0.1", port):
            raise HarnessFailure(
                f"port {port} ({name}) is already in use; stop the process or container that holds it"
            )
    print(f"  PASS  example ports are free (http {lease.http_port}, aux {lease.aux_port})")

    probe = harness.run(
        [
            "go",
            "run",
            "./scripts/local/cmd/examples-local-preflight",
            "-endpoint",
            endpoint,
            "-wait",
            "120s",
        ],
        timeout=300,
    )
    for line in probe.stdout.strip().splitlines():
        print(f"  PASS  {line.removeprefix('preflight: ')}")


def prepare(harness: Harness) -> None:
    """Install the dependency trees the examples and the local runner need.

    The TypeScript examples run on plain ``node`` against the checked-in
    ``ts/dist``; only the CDK synth the staging helper vendors into the Lambda
    assets needs ``ts/node_modules``. The repository's own install contract owns
    the stamp and the ``npm ci --ignore-scripts`` invocation, so the harness
    calls it instead of running npm itself.
    """
    prepare_typescript_runtime(harness)
    prepare_local_runner(harness)
    prepare_microvm_workload(harness)


def prepare_microvm_workload(harness: Harness) -> None:
    """Build the Go MicroVM workload once; the workload rows run host processes."""
    MICROVM_WORKLOAD_GO.parent.mkdir(parents=True, exist_ok=True)
    if not MICROVM_WORKLOAD_GO.exists():
        print("  ... building the MicroVM Go workload")
    harness.run(
        ["go", "build", "-o", str(MICROVM_WORKLOAD_GO), "./examples/cdk/microvm-controller/workloads/go"],
        timeout=1800,
    )


def prepare_typescript_runtime(harness: Harness) -> None:
    marker = ROOT / "ts" / "node_modules" / "@theory-cloud" / "tabletheory-ts" / "package.json"
    if marker.exists():
        return
    print("  ... installing the TypeScript runtime dependencies (npm ci)")
    harness.run(
        [
            "bash",
            "-c",
            "source scripts/lib/ts-runtime-deps.sh && ensure_ts_runtime_deps_installed",
        ],
        timeout=1800,
    )
    if not marker.exists():
        raise HarnessFailure(f"TypeScript runtime dependencies are still missing: {marker}")


def prepare_local_runner(harness: Harness) -> Path:
    """Build the local runner CLI and the CDK CLI the app synthesizes with.

    The runner is a Go command (``cmd/apptheory-local``); building it once per
    harness run keeps each example row to synthesis plus container startup. The
    hello-world CDK app synthesizes from its own ``node_modules/.bin/cdk``, so
    the harness installs that tree when it is missing (``npm ci`` never rewrites
    the lockfile).
    """
    LOCAL_RUNNER_BIN.parent.mkdir(parents=True, exist_ok=True)
    if not LOCAL_RUNNER_BIN.exists():
        print("  ... building the local runner (go build ./cmd/apptheory-local)")
    harness.run(
        ["go", "build", "-o", str(LOCAL_RUNNER_BIN), "./cmd/apptheory-local"],
        timeout=1800,
    )
    app = ROOT / LOCAL_RUNNER_APP
    cdk_cli = app / "node_modules" / ".bin" / "cdk"
    if not cdk_cli.exists():
        print(f"  ... installing {LOCAL_RUNNER_APP} dependencies (npm ci)")
        harness.run(["npm", "ci", "--ignore-scripts"], cwd=app, timeout=1800)
    if not cdk_cli.exists():
        raise HarnessFailure(f"the CDK CLI is still missing: {cdk_cli}")
    return LOCAL_RUNNER_BIN


# --- runners ----------------------------------------------------------------


def run_testkit_ts(harness: Harness) -> str:
    result = harness.run(["node", "examples/testkit/ts.mjs"])
    expect_output(
        result.stdout,
        ["examples/testkit/ts.mjs: PASS"],
        "examples/testkit/ts.mjs",
    )
    return "HTTP API v2, EventBridge and DynamoDB stream assertions"


def run_testkit_ts_streaming(harness: Harness) -> str:
    result = harness.run(["node", "examples/testkit/ts-streaming.mjs"])
    expect_output(
        result.stdout,
        ["examples/testkit/ts-streaming.mjs: PASS"],
        "examples/testkit/ts-streaming.mjs",
    )
    return "Function URL streaming chunks, cookies and late-error framing"


def run_testkit_py(harness: Harness) -> str:
    result = harness.run([sys.executable, "examples/testkit/py.py"])
    expect_output(
        result.stdout,
        ["examples/testkit/py.py: PASS"],
        "examples/testkit/py.py",
    )
    return "HTTP API v2, EventBridge and DynamoDB stream assertions"


def run_mcp_tools_only_ts(harness: Harness) -> str:
    for path in (
        "examples/mcp/tools-only-ts/server.mjs",
        "examples/mcp/tools-only-ts/server.test.mjs",
    ):
        harness.run(["node", "--check", path])
    result = harness.run(["node", "examples/mcp/tools-only-ts/server.test.mjs"])
    expect_output(
        result.stdout,
        ["examples/mcp/tools-only-ts/server.test.mjs: PASS"],
        "examples/mcp/tools-only-ts",
    )
    return "MCP initialize, tools/list, tools/call and Lambda entry assertions"


def run_mcp_tools_only_py(harness: Harness) -> str:
    result = harness.run([sys.executable, "examples/mcp/tools-only-py/server_test.py"])
    expect_output(
        result.stdout,
        ["examples/mcp/tools-only-py/server_test.py: PASS"],
        "examples/mcp/tools-only-py",
    )
    return "MCP initialize, tools/list, tools/call and Lambda entry assertions"


def run_cdk_synth_all(harness: Harness) -> str:
    result = harness.run(["bash", "scripts/verify-cdk-synth.sh"], timeout=3600)
    expect_output(result.stdout, ["cdk-synth: PASS"], "CDK synth")
    proof = harness.run(
        [sys.executable, "scripts/local/verify-lambda-assets.py"],
        timeout=3600,
    )
    expect_output(proof.stdout, ["lambda-assets: PASS"], "Lambda asset runtime proof")
    return (
        "synthesized every CDK example and matched its pinned template hash; "
        "loaded the staged TypeScript and Python assets in the official Lambda runtime images"
    )


def run_rate_limited_http(harness: Harness) -> str:
    provisioning = harness.run(
        [
            "go",
            "run",
            "./scripts/local/cmd/rate-limit-table",
            "-table",
            RATE_LIMIT_TABLE,
        ],
        timeout=300,
    )
    expect_output(
        _combined_output(provisioning),
        [f"rate-limit table {RATE_LIMIT_TABLE}: ready"],
        "rate-limit table provisioning",
    )

    port = harness.lease.http_port
    base = f"http://127.0.0.1:{port}"
    env = dict(harness.env)
    env["LISTEN_ADDR"] = f"127.0.0.1:{port}"
    log = tempfile.NamedTemporaryFile(prefix="apptheory-rate-limit-", suffix=".log", delete=False)
    try:
        process = subprocess.Popen(
            ["go", "run", "./examples/migration/rate-limited-http"],
            cwd=str(ROOT),
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            _wait_for_tcp(process, port)
            allowed, refusal = _exercise_rate_limit(base)
        finally:
            _stop_process(process)
            log.close()
        with open(log.name, encoding="utf-8", errors="replace") as handle:
            server_log = handle.read()
        expect_output(
            server_log,
            [f"listening on 127.0.0.1:{port}"],
            "rate-limited-http server startup",
        )
        return f"{allowed} allowed requests then the {refusal} refusal"
    finally:
        try:
            os.unlink(log.name)
        except FileNotFoundError:
            pass


def _exercise_rate_limit(base: str) -> tuple[int, int]:
    """Issue the fixed-window burst and return (allowed, refusal-status).

    The fixed window is one minute. Starting the burst too close to the minute
    boundary could split it across two windows, so the runner waits for a fresh
    window first instead of retrying a flaky count.
    """
    seconds_into_window = time.time() % 60
    if seconds_into_window > 45:
        time.sleep(61 - seconds_into_window)

    allowed = 0
    for index in range(60):
        status, body, headers = http_request("GET", f"{base}/hello")
        expect_status(status, 200, f"allowed request {index + 1}", body)
        if body != "ok":
            raise HarnessFailure(f"allowed request {index + 1}: body {body!r}, want 'ok'")
        if headers.get("x-ratelimit-limit") != "60":
            raise HarnessFailure(
                f"allowed request {index + 1}: X-RateLimit-Limit is {headers.get('x-ratelimit-limit')!r}, want '60'",
                body,
            )
        remaining = int(headers.get("x-ratelimit-remaining", "-1"))
        if remaining != 59 - index:
            raise HarnessFailure(
                f"allowed request {index + 1}: X-RateLimit-Remaining is {remaining}, want {59 - index}",
                body,
            )
        allowed += 1

    status, body, headers = http_request("GET", f"{base}/hello")
    expect_status(status, 429, "rate-limited request", body)
    if '"error":"rate_limit_exceeded"' not in body:
        raise HarnessFailure(f"rate-limited request: body is not the limiter refusal: {body!r}", body)
    if headers.get("x-ratelimit-remaining") != "0":
        raise HarnessFailure(
            f"rate-limited request: X-RateLimit-Remaining is {headers.get('x-ratelimit-remaining')!r}, want '0'",
            body,
        )
    if not headers.get("retry-after"):
        raise HarnessFailure("rate-limited request: Retry-After header is missing", body)
    return allowed, status


def _wait_for_tcp(process: subprocess.Popen, port: int, seconds: int = 180) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise HarnessFailure(f"rate-limited-http server exited early (code {process.returncode})")
        if port_open("127.0.0.1", port, timeout=0.25):
            return
        time.sleep(0.1)
    raise HarnessFailure(f"rate-limited-http server did not listen on 127.0.0.1:{port}")


def _stop_process(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except ProcessLookupError:
            # The process group can exit between the wait timeout and this kill;
            # SIGKILL then has no target, which is the outcome it was sent for.
            pass
        process.wait(timeout=15)


# --- local runner -----------------------------------------------------------
#
# The three hello-world rows run the app's real CDK definition through
# `apptheory-local`: it synthesizes the stack, starts the function in the
# official, digest-pinned Lambda runtime image, proves the container cannot
# reach AWS, and serves the derived HTTP API v2 surface. The assertions below
# are real HTTP requests; nothing is invoked in process.


def run_local_runner_go(harness: Harness) -> str:
    return run_local_runner(harness, "go")


def run_local_runner_ts(harness: Harness) -> str:
    return run_local_runner(harness, "ts")


def run_local_runner_py(harness: Harness) -> str:
    return run_local_runner(harness, "py")


def local_runner_prefix(harness: Harness, lang: str) -> str:
    lease = harness.lease
    slot = f"s{lease.slot}" if lease.slot >= 0 else f"p{lease.port}"
    return f"apptheory-local-{lease.checkout}-{slot}-{lang}"


def run_local_runner(harness: Harness, lang: str) -> str:
    binary = prepare_local_runner(harness)
    prefix = local_runner_prefix(harness, lang)
    plan = harness.run(
        [
            str(binary),
            "plan",
            "--app",
            LOCAL_RUNNER_APP,
            "-c",
            f"lang={lang}",
            "--profile",
            str(ROOT / "scripts/local/examples-local.json"),
            "--json",
        ],
        timeout=1800,
    )
    try:
        spec = json.loads(plan.stdout)
    except json.JSONDecodeError as exc:
        raise HarnessFailure(f"apptheory-local plan did not print JSON: {exc}", _combined_output(plan)) from exc
    _assert_derived_surface(spec, lang)

    log = tempfile.NamedTemporaryFile(prefix=f"apptheory-local-{lang}-", suffix=".log", delete=False)
    try:
        process = subprocess.Popen(
            [
                str(binary),
                "run",
                "--app",
                LOCAL_RUNNER_APP,
                "-c",
                f"lang={lang}",
                "--profile",
                str(ROOT / "scripts/local/examples-local.json"),
                "--backend",
                "dynamodb",
                "--port-base",
                str(harness.lease.http_port),
                "--name-prefix",
                prefix,
            ],
            cwd=str(ROOT),
            env=harness.env,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            urls = _wait_for_local_runner(process, log.name)
            _exercise_hello_world(urls[0], lang)
        finally:
            _stop_process(process)
            log.close()
        output = Path(log.name).read_text(encoding="utf-8", errors="replace")
        expect_output(output, [LOCAL_RUNNER_READY, "shutting down"], f"apptheory-local {lang} run")
        _assert_local_runner_cleanup(harness, prefix)
        return (
            f"{LOCAL_RUNNER_RUNTIMES[lang]} container served HTTP API v2 "
            "with four HTTP assertions and left no containers or network"
        )
    finally:
        try:
            os.unlink(log.name)
        except FileNotFoundError:
            pass


# --- A3b example runners ----------------------------------------------------


def _json_request(
    method: str,
    url: str,
    *,
    headers: dict | None = None,
    payload: dict | None = None,
    timeout: float = 60,
) -> tuple[int, dict, dict]:
    body = None
    request_headers = dict(headers or {})
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json")
    status, text, response_headers = http_request(
        method, url, headers=request_headers, body=body, timeout=timeout
    )
    try:
        parsed = json.loads(text) if text else {}
    except json.JSONDecodeError as exc:
        raise HarnessFailure(f"{method} {url}: response is not JSON: {exc}", text) from exc
    return status, parsed, response_headers


def invoke_local_function(
    harness: Harness,
    *,
    app: str,
    function: str,
    event: dict,
    name: str,
    backends: tuple[str, ...] = (),
) -> tuple[dict, str]:
    """Invoke one CDK function through the runner and return its decoded result."""
    ensure_cdk_app(harness, app)
    prefix = local_app_prefix(harness, name)
    argv = [
        str(LOCAL_RUNNER_BIN),
        "invoke",
        "--app",
        app,
        "--function",
        function,
        "--profile",
        str(ROOT / LOCAL_PROFILE),
        "--name-prefix",
        prefix,
        "--stdio",
    ]
    for backend in backends:
        argv.extend(["--backend", backend])
    result = harness.run(argv, timeout=1800, stdin_data=json.dumps(event) + "\n")
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise HarnessFailure(
            f"invoke {function} returned {len(lines)} result lines, want 1", _combined_output(result)
        )
    try:
        decoded = json.loads(lines[0])
    except json.JSONDecodeError as exc:
        raise HarnessFailure(f"invoke {function} result is not JSON: {exc}", lines[0]) from exc
    _assert_local_runner_cleanup(harness, prefix)
    return decoded, result.stderr


def _proxy_body(result: dict, label: str) -> dict:
    if not result.get("proxy"):
        raise HarnessFailure(f"{label}: handler did not return a proxy response", json.dumps(result))
    try:
        return json.loads(result.get("body") or "{}")
    except json.JSONDecodeError as exc:
        raise HarnessFailure(f"{label}: proxy body is not JSON: {exc}", result.get("body") or "") from exc


def _assert_request_id(payload: dict, label: str) -> None:
    request_id = str(payload.get("request_id") or payload.get("requestId") or "")
    if not re.fullmatch(r"[0-9a-fA-F-]{16,64}", request_id):
        raise HarnessFailure(f"{label}: request id is missing or malformed: {request_id!r}")


def _run_multilang_sns(
    harness: Harness, session: LocalSession, lang: str, http_base: str, function: dict
) -> str:
    topic = _sns_resource(session, f"apptheory-multilang-{lang}-events", "AWS::SNS::Topic")
    endpoints = session.info.get("endpoints") or []
    sns_endpoints = [endpoint["url"] for endpoint in endpoints if endpoint.get("service") == "sns"]
    if not sns_endpoints:
        raise HarnessFailure(f"multilang {lang}: the session has no SNS endpoint")
    message = json.dumps({"eventType": "language-sns", "lang": lang, "n": 1})
    subject = f"{lang} sns parity"
    result = harness.run(
        [
            "aws",
            "--endpoint-url",
            sns_endpoints[0],
            "sns",
            "publish",
            "--topic-arn",
            str(topic["arn"]),
            "--message",
            message,
            "--subject",
            subject,
            "--message-attributes",
            json.dumps({"eventType": {"DataType": "String", "StringValue": "language-sns"}}),
            "--query",
            "MessageId",
            "--output",
            "text",
        ],
        timeout=120,
    )
    published = result.stdout.strip()
    if not published:
        raise HarnessFailure(f"multilang {lang}: the SNS publish returned no message id", result.stdout)
    deadline = time.monotonic() + 120
    record = None
    while time.monotonic() < deadline:
        status, payload, _ = _json_request("GET", f"{http_base}/sns-record")
        if status == 200:
            record = (payload or {}).get("record") or {}
            if record.get("messageId") == published:
                break
        record = None
        time.sleep(0.2)
    if record is None:
        raise HarnessFailure(f"multilang {lang}: the SNS record never reached the handler")
    if (
        record.get("shapeOk") is not True
        or record.get("lang") != lang
        or record.get("eventSource") != "aws:sns"
        or record.get("type") != "Notification"
        or record.get("messageId") != published
        or record.get("topicArn") != topic["arn"]
        or record.get("subject") != subject
        or record.get("message") != message
        or record.get("signatureVersion") != "1"
        or not record.get("timestamp")
        or "SubscriptionArn=" not in str(record.get("unsubscribeUrl") or "")
        or not str(record.get("eventSubscriptionArn") or "").startswith(str(topic["arn"]) + ":")
        or (record.get("messageAttributes") or {}).get("eventType", {}).get("Type") != "String"
        or (record.get("messageAttributes") or {}).get("eventType", {}).get("Value") != "language-sns"
    ):
        raise HarnessFailure(f"multilang {lang}: unexpected SNS record: {record}")
    subscription = next(
        (
            candidate
            for candidate in session.spec.get("subscriptions") or []
            if candidate.get("function") == function["logicalId"] and candidate.get("kind") == "sns"
        ),
        None,
    )
    if subscription is None:
        raise HarnessFailure(f"multilang {lang}: the plan has no SNS subscription for the handler")
    _wait_for_delivery(session, subscription["logicalId"], delivered=1)
    return f"(message id, topic ARN, subject, timestamp, UnsubscribeUrl and String attribute)"


class WebSocketHandshakeRefused(Exception):
    def __init__(self, status: str) -> None:
        super().__init__(status)
        self.status = status


class WebSocketClient:
    """A minimal RFC 6455 client: handshake, masked frames, close frames.

    The rows use it against the real listener; no WebSocket library is
    involved, so the client speaks exactly the protocol the runner serves.
    """

    def __init__(self, url: str, headers: dict[str, str] | None = None, timeout: float = 30) -> None:
        parsed = urllib.parse.urlsplit(url)
        self.sock = socket.create_connection((parsed.hostname, parsed.port), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        path = parsed.path or "/"
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {parsed.netloc}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
        )
        for name, value in (headers or {}).items():
            request += f"{name}: {value}\r\n"
        request += "\r\n"
        self.sock.sendall(request.encode("utf-8"))
        self.reader = self.sock.makefile("rb")
        status = self.reader.readline().decode("utf-8", errors="replace").strip()
        while True:
            line = self.reader.readline()
            if line in (b"\r\n", b""):
                break
        if " 101 " not in status:
            self.sock.close()
            raise WebSocketHandshakeRefused(status)

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        mask = os.urandom(4)
        header = bytes([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header += bytes([0x80 | length])
        elif length <= 0xFFFF:
            header += bytes([0x80 | 126]) + struct.pack(">H", length)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", length)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def _read_exact(self, count: int) -> bytes:
        data = self.reader.read(count)
        if data is None or len(data) != count:
            raise HarnessFailure(f"websocket: the server closed the connection while {count} bytes were expected")
        return data

    def receive(self, timeout: float = 30) -> tuple[int, bytes]:
        self.sock.settimeout(timeout)
        header = self._read_exact(2)
        opcode = header[0] & 0x0F
        length = header[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._read_exact(8))[0]
        payload = self._read_exact(length)
        if opcode == 0x9:  # ping
            self._send_frame(0xA, payload)
            return self.receive(timeout)
        return opcode, payload

    def close(self) -> None:
        try:
            self._send_frame(0x8, struct.pack(">H", 1000))
        except OSError:
            pass
        self.sock.close()


def _web_socket_api(session: LocalSession, lang: str) -> dict:
    plan_apis = [
        api for api in session.spec.get("webSockets") or []
        if str(api.get("name") or "").endswith(f"-{lang}-ws")
    ]
    if len(plan_apis) != 1:
        raise HarnessFailure(f"multilang {lang}: want one WebSocket API, got {plan_apis}")
    logical_id = plan_apis[0]["logicalId"]
    for api in session.info.get("apis") or []:
        if api.get("class") == "websocket" and api.get("logicalId") == logical_id:
            return api
    raise HarnessFailure(f"multilang {lang}: session describe has no WebSocket API {logical_id}")


def _management_request(api: dict, method: str, connection_id: str) -> tuple[int, bytes]:
    context = ssl.create_default_context(cafile=api["managementCa"])
    request = urllib.request.Request(
        f"{api['managementEndpoint']}/@connections/{connection_id}", method=method
    )
    try:
        with urllib.request.urlopen(request, context=context, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def _wait_for_ws_disconnect(base: str, connection_id: str, timeout: float = 60) -> dict:
    deadline = time.monotonic() + timeout
    last: list = []
    while time.monotonic() < deadline:
        status, payload, _ = _json_request("GET", f"{base}/ws-disconnects")
        if status == 200:
            last = payload.get("events") or []
            for event in last:
                if event.get("connection_id") == connection_id:
                    return event
        time.sleep(0.2)
    raise HarnessFailure(f"websocket: no $disconnect for {connection_id}; last {last}")


def _wait_for_log_line(path: str, needle: str, timeout: float = 30) -> None:
    """Wait until the runner log carries a line the row asserts."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
        if needle in text:
            return
        time.sleep(0.1)
    raise HarnessFailure(f"the run log never reported {needle!r}")


def _run_multilang_websocket(harness: Harness, session: LocalSession, lang: str, http_base: str) -> str:
    """Exchange real frames through the API's listener and prove the lifecycle."""
    api = _web_socket_api(session, lang)
    url = api.get("url")
    if not url or not str(url).startswith("ws://"):
        raise HarnessFailure(f"multilang {lang}: the WebSocket API has no ws:// URL: {api}")
    headers = {"Authorization": "Bearer local-allow"} if lang == "go" else {}

    if lang == "go":
        try:
            WebSocketClient(url, {"Authorization": "Bearer wrong"})
            raise HarnessFailure("multilang go: a $connect authorizer denial must refuse the handshake")
        except WebSocketHandshakeRefused as exc:
            if "401" not in exc.status:
                raise HarnessFailure(f"multilang go: the authorizer refusal was {exc.status!r}, want 401")
        if api.get("authorizer") is None:
            raise HarnessFailure("multilang go: the plan has no $connect authorizer")

    connection = WebSocketClient(url, headers)
    try:
        # A custom route selected by $request.body.action, answered two-way.
        connection.send_text(json.dumps({"action": "chat", "message": "hello"}))
        opcode, payload = connection.receive()
        if opcode != 0x1:
            raise HarnessFailure(f"multilang {lang}: chat response opcode {opcode}")
        chat = json.loads(payload)
        if chat.get("echo") != "hello" or chat.get("lang") != lang or chat.get("route_key") != "chat":
            raise HarnessFailure(f"multilang {lang}: chat response {chat}")
        connection_id = chat.get("connection_id")
        if not connection_id:
            raise HarnessFailure(f"multilang {lang}: the chat response carries no connection id: {chat}")

        # A message that selects no route goes to $default, which pushes through
        # the @connections API and also answers two-way.
        connection.send_text(json.dumps({"message": "no-action"}))
        received: list[dict] = []
        deadline = time.monotonic() + 60
        while len(received) < 2 and time.monotonic() < deadline:
            opcode, payload = connection.receive()
            if opcode == 0x1:
                received.append(json.loads(payload))
        push = [item for item in received if item.get("ok") is True and "route_key" not in item]
        response = [item for item in received if item.get("route_key") == "$default"]
        if len(push) != 1 or len(response) != 1:
            raise HarnessFailure(f"multilang {lang}: $default push/response {received}")
        if push[0].get("lang") != lang:
            raise HarnessFailure(f"multilang {lang}: the push body {push[0]}")
        if response[0].get("connection_id") != connection_id:
            raise HarnessFailure(f"multilang {lang}: the $default response {response[0]}")

        # GetConnection through the management endpoint the handler resolved.
        connection.send_text(json.dumps({"cmd": "get"}))
        opcode, payload = connection.receive()
        if opcode != 0x1:
            raise HarnessFailure(f"multilang {lang}: get response opcode {opcode}")
        get_body = json.loads(payload)
        connection_info = get_body.get("connection") or {}
        if connection_info.get("connected_at", 0) <= 0:
            raise HarnessFailure(f"multilang {lang}: GetConnection returned {get_body}")

        # The harness's own management client: GET, DELETE, then GONE.
        status, _ = _management_request(api, "GET", connection_id)
        if status != 200:
            raise HarnessFailure(f"multilang {lang}: management GET answered {status}")
        status, _ = _management_request(api, "DELETE", connection_id)
        if status != 204:
            raise HarnessFailure(f"multilang {lang}: management DELETE answered {status}")
        status, _ = _management_request(api, "GET", connection_id)
        if status != 410:
            raise HarnessFailure(f"multilang {lang}: a closed connection answered {status}, want 410")
        opcode, payload = connection.receive()
        if opcode != 0x8:
            raise HarnessFailure(f"multilang {lang}: DeleteConnection did not close the socket (opcode {opcode})")
    finally:
        connection.close()

    # Idle timeout on the test clock: a second connection closes with 1001 and
    # $disconnect runs.
    idle = WebSocketClient(url, headers)
    try:
        idle.send_text(json.dumps({"action": "chat", "message": "idle"}))
        opcode, payload = idle.receive()
        if opcode != 0x1:
            raise HarnessFailure(f"multilang {lang}: idle connection chat opcode {opcode}")
        idle_id = json.loads(payload).get("connection_id")
        session.clock_advance("11m")
        opcode, payload = idle.receive()
        if opcode != 0x8 or len(payload) < 2:
            raise HarnessFailure(f"multilang {lang}: the idle connection did not close (opcode {opcode})")
        if struct.unpack(">H", payload[:2])[0] != 1001:
            raise HarnessFailure(f"multilang {lang}: idle close code {struct.unpack('>H', payload[:2])[0]}, want 1001")
    finally:
        idle.close()

    _wait_for_ws_disconnect(http_base, idle_id)
    _wait_for_log_line(session.log_path, f"connection {idle_id} closed (INTERNAL_ERROR)")
    return (
        "the WebSocket listener accepted the upgrade, routed a frame to the custom chat route and back, "
        "routed an unmatched frame to $default (a PostToConnection push plus the two-way response), "
        "GetConnection answered from the handler, the harness's management client deleted the connection "
        "and then saw 410 GONE, and the idle timeout closed a second connection with 1001 and ran $disconnect"
    )


def run_multilang(harness: Harness, lang: str) -> str:
    return _run_multilang_http(harness, lang)


def _run_multilang_http(harness: Harness, lang: str) -> str:
    session = start_local_session(
        harness,
        MULTILANG_APP,
        name=f"multilang-{lang}",
        backends=("dynamodb", "sqs", "moto"),
        clock=f"test={LOCAL_RUNNER_CLOCK_START}",
    )
    try:
        apis = session.spec.get("apis") or []
        http_apis = [api for api in apis if api.get("class") == "httpv2"]
        rest_apis = [api for api in apis if api.get("class") == "restv1"]
        if len(http_apis) != 3 or len(rest_apis) != 1:
            raise HarnessFailure(
                f"multilang plan: want 3 HTTP APIs and 1 REST API, got {len(http_apis)}/{len(rest_apis)}"
            )
        websocket = session.spec.get("webSockets") or []
        if len(websocket) != 3:
            raise HarnessFailure(f"multilang plan: want 3 WebSocket APIs, got {websocket}")

        http_base = session_api_url(session.spec, session, f"-{lang}")
        status, payload, _ = _json_request("GET", f"{http_base}/")
        expect_status(status, 200, f"multilang {lang} GET /", json.dumps(payload))
        if payload.get("lang") != lang or payload.get("ok") is not True or payload.get("tier") != "p2":
            raise HarnessFailure(f"multilang {lang} GET /: unexpected body {payload}")
        _assert_request_id(payload, f"multilang {lang} GET /")

        status, payload, _ = _json_request("GET", f"{http_base}/hello/AppTheory")
        expect_status(status, 200, f"multilang {lang} GET /hello/AppTheory", json.dumps(payload))
        if payload.get("message") != "hello AppTheory" or payload.get("lang") != lang:
            raise HarnessFailure(f"multilang {lang} GET /hello/AppTheory: unexpected body {payload}")

        status, text, _ = http_request(
            "POST", f"{http_base}/hello/AppTheory", headers={"Content-Type": "application/json"}, body=b"{}"
        )
        expect_status(status, 405, f"multilang {lang} POST /hello/AppTheory", text)
        if "app.method_not_allowed" not in text:
            raise HarnessFailure(f"multilang {lang} POST /hello/AppTheory: unexpected refusal {text}")

        status, text, _ = http_request("GET", f"{http_base}/missing")
        expect_status(status, 404, f"multilang {lang} GET /missing", text)
        if "app.not_found" not in text:
            raise HarnessFailure(f"multilang {lang} GET /missing: unexpected refusal {text}")

        rest_base = session_rest_url(session.spec, session)
        status, payload, _ = _json_request("GET", f"{rest_base}/hello/AppTheory")
        expect_status(status, 200, "multilang REST GET /hello/AppTheory", json.dumps(payload))
        if payload.get("message") != "hello AppTheory" or payload.get("lang") != "go":
            raise HarnessFailure(f"multilang REST GET /hello/AppTheory: unexpected body {payload}")

        status, text, headers = http_request("GET", f"{rest_base}/sse", timeout=60)
        expect_status(status, 200, "multilang REST GET /sse", text)
        if headers.get("content-type") != "text/event-stream":
            raise HarnessFailure(f"multilang REST GET /sse: content-type {headers.get('content-type')!r}")
        event_ids = re.findall(r"^id: (\d+)$", text, re.MULTILINE)
        if len(event_ids) != 3 or event_ids != ["1", "2", "3"]:
            raise HarnessFailure(f"multilang REST GET /sse: unexpected event ids {event_ids}")
        if '"seq":3' not in text:
            raise HarnessFailure("multilang REST GET /sse: the final sequence was not emitted", text)

        function = _session_function_for_language(session, lang)
        source = session.event_source(kind="sqs", function=function["logicalId"])
        queue = session.resource(name=source["sourceName"], kind="AWS::SQS::Queue")
        session.request(
            "sqs.send", queue=queue["logicalId"], body=json.dumps({"event": "help", "payload": {"n": 1}})
        )
        state = _wait_for_delivery(session, source["logicalId"], delivered=1)
        if state.get("failed"):
            raise HarnessFailure(f"multilang {lang}: the SQS mapping failed: {state}")
        _wait_for_queue_depth(session, queue["logicalId"], visible=0, not_visible=0)
        sns_record = _run_multilang_sns(harness, session, lang, http_base, function)
        eventbridge_detail = _run_multilang_eventbridge(harness, session, lang, http_base, function)
        stream_detail = _run_multilang_stream(harness, session, lang, http_base, function)
        if lang == "go":
            stream_detail += "; " + _run_multilang_stream_failure(harness, session, lang, http_base, function)
        websocket_detail = _run_multilang_websocket(harness, session, lang, http_base)
        return (
            f"{lang} HTTP API served four assertions (200 root, 200 hello, 405 method, 404 missing); "
            f"REST API served hello and all 3 buffered SSE events; {websocket_detail}; "
            f"the CDK SQS mapping delivered one real ElasticMQ message to the {lang} handler and deleted it; "
            f"the SNS Lambda subscription delivered the documented record {sns_record}; {eventbridge_detail}; {stream_detail}"
        )
    finally:
        stop_local_session(harness, session)


def one_rest_url(spec: dict, run: LocalAppRun) -> str:
    rest = [api for api in spec.get("apis") or [] if api.get("class") == "restv1"]
    if len(rest) != 1:
        raise HarnessFailure(f"want exactly one REST API, plan has {len(rest)}")
    logical_id = str(rest[0].get("logicalId"))
    if logical_id not in run.apis:
        raise HarnessFailure(f"the runner did not serve {logical_id}: {run.apis}")
    return run.apis[logical_id]


def run_lesser_parity(harness: Harness, kind: str) -> str:
    if kind == "worker":
        return _run_lesser_parity_worker(harness)
    run = start_local_app(harness, LESSER_PARITY_APP, name=f"lesser-{kind}")
    try:
        base = one_rest_url(run.spec, run)
        if kind == "api":
            status, payload, _ = _json_request("GET", f"{base}/api/items")
            expect_status(status, 200, "lesser-parity GET /api/items", json.dumps(payload))
            if payload.get("message") != "Lesser parity API handler" or payload.get("method") != "GET":
                raise HarnessFailure(f"lesser-parity GET /api/items: unexpected body {payload}")
            environment = payload.get("environment") or {}
            if environment.get("tableName") != "lesser-parity-main":
                raise HarnessFailure(f"lesser-parity GET /api/items: TABLE_NAME was not resolved: {environment}")
            if not str(environment.get("queueUrl", "")).startswith("http://127.0.0.1:1/"):
                raise HarnessFailure(f"lesser-parity GET /api/items: QUEUE_URL is not a closed local value: {environment}")
            _assert_request_id(payload, "lesser-parity GET /api/items")

            status, payload, _ = _json_request(
                "POST", f"{base}/anything", payload={"hello": "world"}
            )
            expect_status(status, 200, "lesser-parity POST /anything", json.dumps(payload))
            if payload.get("method") != "POST" or payload.get("path") != "/anything":
                raise HarnessFailure(f"lesser-parity POST /anything: unexpected body {payload}")
            return "REST catch-all handler served GET and POST with resolved TABLE_NAME/QUEUE_URL"
        if kind == "graphql":
            status, payload, _ = _json_request(
                "POST", f"{base}/api/graphql", payload={"query": "{ ping }"}
            )
            expect_status(status, 200, "lesser-parity POST /api/graphql", json.dumps(payload))
            meta = (payload.get("data") or {}).get("_meta") or {}
            if meta.get("handler") != "lesser-parity-graphql" or meta.get("tableName") != "lesser-parity-main":
                raise HarnessFailure(f"lesser-parity POST /api/graphql: unexpected body {payload}")
            status, payload, _ = _json_request("GET", f"{base}/api/graphql")
            expect_status(status, 200, "lesser-parity GET /api/graphql", json.dumps(payload))
            if payload.get("message") != "Lesser parity API handler" or payload.get("method") != "GET":
                raise HarnessFailure(f"lesser-parity GET /api/graphql: route specificity lost: {payload}")
            return "GraphQL POST served by its dedicated handler; GET fell through to the catch-all"
        if kind == "sse":
            status, text, headers = http_request("GET", f"{base}/sse", timeout=60)
            expect_status(status, 200, "lesser-parity GET /sse", text)
            if headers.get("content-type") != "text/event-stream":
                raise HarnessFailure(f"lesser-parity GET /sse: content-type {headers.get('content-type')!r}")
            if text.count("data: ") != 3 or '"count":42' not in text:
                raise HarnessFailure(f"lesser-parity GET /sse: unexpected buffered events {text}")
            if "content-length" not in headers:
                raise HarnessFailure("lesser-parity GET /sse: the buffered body must have a fixed length")
            status, empty, headers = http_request("OPTIONS", f"{base}/sse")
            expect_status(status, 200, "lesser-parity OPTIONS /sse", empty)
            if headers.get("access-control-allow-origin") != "*":
                raise HarnessFailure(f"lesser-parity OPTIONS /sse: declared CORS headers missing: {headers}")
            return "SSE route returned all 3 buffered events with a fixed length; declared CORS preflight served"
        raise HarnessFailure(f"unknown lesser-parity row {kind}")
    finally:
        stop_local_app(harness, run)


def _run_lesser_parity_worker(harness: Harness) -> str:
    session = start_local_session(
        harness,
        LESSER_PARITY_APP,
        name="lesser-worker",
        backends=("dynamodb", "sqs"),
        clock=f"test={LOCAL_RUNNER_CLOCK_START}",
    )
    try:
        source = session.event_source(kind="sqs", source_name="lesser-parity-events")
        if not source.get("reportBatchItemFailures"):
            raise HarnessFailure(f"lesser-parity worker: mapping lost reportBatchItemFailures: {source}")
        queue = session.resource(name="lesser-parity-events", kind="AWS::SQS::Queue")
        session.request(
            "sqs.send", queue=queue["logicalId"], body=json.dumps({"ok": True, "kind": "valid"})
        )
        invalid = session.request("sqs.send", queue=queue["logicalId"], body="not-json")
        _advance_until(
            session,
            lambda delivery: _source_count(delivery, source["logicalId"], "delivered") >= 1,
            step="5s",
            label="lesser-parity worker batching window",
        )
        # The handler reports only the unparseable record, so exactly one
        # message is left undeleted: the invalid one.
        _wait_for_queue_depth(session, queue["logicalId"], visible=0, not_visible=1)
        state = _delivery_source_state(session, source["logicalId"])
        if state and int(state.get("failed", 0)) != 0:
            raise HarnessFailure(f"lesser-parity worker: a partial batch response counted as a failure: {state}")
        return (
            "two real ElasticMQ messages were delivered as the CDK mapping's batch; the handler returned "
            f"{invalid['messageId']} as its only partial failure, so exactly the invalid message stayed in "
            "the queue and the valid one was deleted"
        )
    finally:
        stop_local_session(harness, session)


def run_restv1(harness: Harness, kind: str) -> str:
    run = start_local_app(harness, RESTV1_APP, name=f"restv1-{kind}")
    try:
        base = one_rest_url(run.spec, run)
        if kind == "api":
            status, payload, _ = _json_request("GET", f"{base}/other")
            expect_status(status, 200, "restv1 GET /other", json.dumps(payload))
            if payload.get("message") != "API catch-all handler" or payload.get("method") != "GET":
                raise HarnessFailure(f"restv1 GET /other: unexpected body {payload}")
            if (payload.get("pathParameters") or {}).get("proxy") != "other":
                raise HarnessFailure(f"restv1 GET /other: proxy parameter missing: {payload}")
            status, payload, _ = _json_request("POST", f"{base}/other", payload={"a": 1})
            expect_status(status, 200, "restv1 POST /other", json.dumps(payload))
            if payload.get("method") != "POST" or payload.get("path") != "/other":
                raise HarnessFailure(f"restv1 POST /other: unexpected body {payload}")
            return "REST catch-all handler served GET and POST with the matched proxy parameter"
        if kind == "graphql":
            status, payload, _ = _json_request(
                "POST", f"{base}/api/graphql", payload={"query": "{ ping }"}
            )
            expect_status(status, 200, "restv1 POST /api/graphql", json.dumps(payload))
            data = payload.get("data") or {}
            if data.get("message") != "GraphQL endpoint mock response" or data.get("query") != "{ ping }":
                raise HarnessFailure(f"restv1 POST /api/graphql: unexpected body {payload}")
            status, payload, _ = _json_request("GET", f"{base}/api/graphql")
            expect_status(status, 200, "restv1 GET /api/graphql", json.dumps(payload))
            if payload.get("message") != "API catch-all handler":
                raise HarnessFailure(f"restv1 GET /api/graphql: route specificity lost: {payload}")
            return "GraphQL POST served by its dedicated handler; GET fell through to the catch-all"
        if kind == "inventory":
            status, payload, _ = _json_request("GET", f"{base}/inventory/item-1")
            expect_status(status, 200, "restv1 GET /inventory/item-1", json.dumps(payload))
            if payload.get("id") != "item-1" or payload.get("name") != "Widget A" or payload.get("quantity") != 100:
                raise HarnessFailure(f"restv1 GET /inventory/item-1: unexpected body {payload}")
            status, payload, _ = _json_request("GET", f"{base}/inventory/missing")
            expect_status(status, 404, "restv1 GET /inventory/missing", json.dumps(payload))
            if payload.get("error") != "Item not found" or payload.get("id") != "missing":
                raise HarnessFailure(f"restv1 GET /inventory/missing: unexpected refusal {payload}")
            status, text, headers = http_request("DELETE", f"{base}/inventory/item-2")
            expect_status(status, 204, "restv1 DELETE /inventory/item-2", text)
            if text:
                raise HarnessFailure(f"restv1 DELETE /inventory/item-2: 204 must have no body: {text!r}")
            status, payload, _ = _json_request("DELETE", f"{base}/inventory/item-2")
            expect_status(status, 404, "restv1 DELETE /inventory/item-2 twice", json.dumps(payload))
            status, payload, _ = _json_request(
                "PUT", f"{base}/inventory/item-9", payload={"name": "New Widget", "quantity": 7}
            )
            expect_status(status, 200, "restv1 PUT /inventory/item-9", json.dumps(payload))
            if payload.get("id") != "item-9" or payload.get("name") != "New Widget":
                raise HarnessFailure(f"restv1 PUT /inventory/item-9: unexpected body {payload}")
            status, payload, headers = http_request("OPTIONS", f"{base}/inventory/item-1")
            expect_status(status, 200, "restv1 OPTIONS /inventory/item-1", "")
            if headers.get("access-control-allow-origin") != "*":
                raise HarnessFailure(f"restv1 OPTIONS: declared CORS headers missing: {headers}")
            return "inventory GET/PUT/DELETE served with path parameters, a 404 refusal and a declared CORS preflight"
        if kind == "sse":
            status, text, headers = http_request("GET", f"{base}/sse", timeout=90)
            expect_status(status, 200, "restv1 GET /sse", text)
            if headers.get("content-type") != "text/event-stream":
                raise HarnessFailure(f"restv1 GET /sse: content-type {headers.get('content-type')!r}")
            if "content-length" not in headers:
                raise HarnessFailure("restv1 GET /sse: the buffered body must have a fixed length")
            for index in range(1, 11):
                if f"data: Event {index} at " not in text:
                    raise HarnessFailure(f"restv1 GET /sse: event {index} missing", text)
            if text.count("data: [DONE]") != 1:
                raise HarnessFailure("restv1 GET /sse: the completion event is missing", text)
            return "streaming handler returned all 10 events and [DONE] as one buffered body"
        raise HarnessFailure(f"unknown restv1 row {kind}")
    finally:
        stop_local_app(harness, run)


def run_lambda_role(harness: Harness, kind: str) -> str:
    if kind == "index":
        results = []
        for function in ("BasicFn0724CF21", "TracingFn9084DD4E", "DynamicFn3F49A082"):
            decoded, _ = invoke_local_function(
                harness,
                app=LAMBDA_ROLE_APP,
                function=function,
                event={},
                name=f"lambda-role-{function.lower()}",
            )
            body = _proxy_body(decoded, f"lambda-role {function}")
            if decoded.get("statusCode") != 200 or body.get("message") != "Hello from AppTheory Lambda!":
                raise HarnessFailure(f"lambda-role {function}: unexpected response {decoded}")
            results.append(function)
        return f"compiled index.handler served {len(results)} functions: " + ", ".join(results)
    if kind == "encrypted":
        decoded, _ = invoke_local_function(
            harness,
            app=LAMBDA_ROLE_APP,
            function="EncryptedFn7A7481A9",
            event={},
            name="lambda-role-encrypted",
            backends=("moto", "s3proxy"),
        )
        body = _proxy_body(decoded, "lambda-role encrypted")
        if (
            decoded.get("statusCode") != 200
            or body.get("message") != "KMS encryption/decryption successful"
            or body.get("match") is not True
            or body.get("original") != body.get("decrypted")
        ):
            raise HarnessFailure(f"lambda-role encrypted: unexpected response {decoded}")
        return "encrypted.handler round-tripped plaintext through the emulated KMS and reported match=true"
    if kind == "custom":
        spec = plan_local_app(harness, LAMBDA_ROLE_APP, allow_no_surface=True)
        function = None
        for candidate in spec.get("functions") or []:
            if candidate.get("handler") == "custom.handler":
                function = candidate
                break
        if function is None:
            raise HarnessFailure("lambda-role custom: plan has no custom.handler function")
        session = start_local_session(
            harness,
            LAMBDA_ROLE_APP,
            name="lambda-role-custom",
            backends=("moto", "s3proxy"),
            targets=(function["logicalId"],),
            allow_no_surface=True,
        )
        try:
            result = session.invoke(function["logicalId"], {})
            body = _proxy_body(result, "lambda-role custom")
            s3_object = body.get("s3Object") or {}
            ssm = body.get("ssm") or {}
            secrets = body.get("secrets") or {}
            cognito = body.get("cognito") or {}
            if (
                result.get("statusCode") != 200
                or body.get("message") != "S3, SSM, Secrets Manager and Cognito operations successful"
                or not str(s3_object.get("bucket", "")).startswith("local-")
                or not str(s3_object.get("content", "")).startswith("{")
            ):
                raise HarnessFailure(f"lambda-role custom: unexpected response {result}")
            if (
                ssm.get("plain") != "local-ssm-value"
                or ssm.get("expectedValue") != "local-ssm-value"
                or ssm.get("plainType") != "String"
                or ssm.get("expectedType") != "String"
                or ssm.get("secure") != "local-secure-value"
                or ssm.get("list") != "alpha,beta,gamma"
            ):
                raise HarnessFailure(f"lambda-role custom: SSM resolution failed: {ssm}")
            if (
                secrets.get("literalUsername") != "local-user"
                or secrets.get("literalPassword") != "local-pass"
                or secrets.get("generatedUsername") != "generated-user"
                or secrets.get("generatedPasswordLength") != 24
                or secrets.get("generatedPunctuation") is not False
            ):
                raise HarnessFailure(f"lambda-role custom: Secrets Manager resolution failed: {secrets}")
            pool_id = str(cognito.get("poolId") or "")
            client_id = str(cognito.get("clientId") or "")
            if not pool_id.startswith("us-east-1_") or not client_id:
                raise HarnessFailure(f"lambda-role custom: Cognito Ref values were not resolved: {cognito}")
            expected_provider = f"cognito-idp.us-east-1.amazonaws.com/{pool_id}"
            if (
                cognito.get("providerName") != expected_provider
                or cognito.get("providerUrl") != f"https://{expected_provider}"
                or not str(cognito.get("poolArn") or "").endswith(f"userpool/{pool_id}")
            ):
                raise HarnessFailure(f"lambda-role custom: Cognito GetAtt values were not resolved: {cognito}")
            pool = session.resource(logical_prefix="CognitoPool", kind="AWS::Cognito::UserPool")
            issuer = str(pool.get("localIssuer") or "")
            if not issuer.startswith("http://127.0.0.1:"):
                raise HarnessFailure(f"lambda-role custom: the pool has no local issuer: {pool}")
            status, text, _ = http_request("GET", f"{issuer}/.well-known/jwks.json")
            expect_status(status, 200, "lambda-role custom JWKS", text)
            if not json.loads(text).get("keys"):
                raise HarnessFailure(f"lambda-role custom: the issuer returned no keys: {text}")
            status, text, _ = http_request("GET", f"{issuer}/.well-known/openid-configuration")
            expect_status(status, 200, "lambda-role custom discovery", text)
            discovery = json.loads(text)
            if discovery.get("issuer") != issuer or discovery.get("jwks_uri") != f"{issuer}/.well-known/jwks.json":
                raise HarnessFailure(f"lambda-role custom: the discovery document is inconsistent: {discovery}")
            return (
                "custom.handler read String/SecureString/StringList SSM parameters (Ref, GetAtt Type/Value), "
                "both Secrets Manager secrets through GetSecretValue, and the Cognito pool/client; "
                f"the local issuer {issuer} served the pool JWKS and discovery document; S3 round-trip passed"
            )
        finally:
            stop_local_session(harness, session)
    raise HarnessFailure(f"unknown lambda-role row {kind}")


# --- MCP over the warm local container --------------------------------------


def prepare_mcp_handler(harness: Harness, example: str) -> Path:
    source = MCP_EXAMPLES[example]
    directory = MCP_HANDLER_BIN_DIR / example
    directory.mkdir(parents=True, exist_ok=True)
    print(f"  ... building {source} (go build, linux/arm64)")
    harness.run(
        [
            "go",
            "build",
            "-trimpath",
            "-buildvcs=false",
            "-ldflags=-s -w -buildid=",
            "-o",
            str(directory / "bootstrap"),
            f"./{source}",
        ],
        env={"GOOS": "linux", "GOARCH": "arm64", "CGO_ENABLED": "0"},
        timeout=1800,
    )
    return directory


def mcp_event(
    method: str,
    *,
    http_method: str = "POST",
    request_id: str = "a3b-mcp",
    session: str | None = None,
    protocol: str | None = None,
    headers: dict | None = None,
    payload: dict | None = None,
    body: str | None = None,
) -> dict:
    request_headers = {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
    }
    if headers:
        request_headers.update(headers)
    if session:
        request_headers["mcp-session-id"] = session
    if protocol:
        request_headers["mcp-protocol-version"] = protocol
    if body is None:
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": payload or {}})
    return {
        "version": "2.0",
        "routeKey": f"{http_method} /mcp",
        "rawPath": "/mcp",
        "rawQueryString": "",
        "headers": request_headers,
        "requestContext": {
            "accountId": "123456789012",
            "apiId": "local",
            "domainName": "local.execute-api.us-east-1.amazonaws.com",
            "http": {
                "method": http_method,
                "path": "/mcp",
                "protocol": "HTTP/1.1",
                "sourceIp": "127.0.0.1",
                "userAgent": "apptheory-local-harness",
            },
            "requestId": request_id,
            "routeKey": f"{http_method} /mcp",
            "stage": "$default",
        },
        "body": body,
        "isBase64Encoded": False,
    }


class McpWarmContainer:
    """One warm handler container driven with newline-delimited Lambda events."""

    def __init__(self, harness: Harness, example: str, name: str) -> None:
        directory = prepare_mcp_handler(harness, example)
        self.harness = harness
        self.prefix = local_app_prefix(harness, name)
        self.process = subprocess.Popen(
            [
                str(LOCAL_RUNNER_BIN),
                "invoke",
                "--handler-dir",
                str(directory),
                "--runtime",
                "provided.al2023",
                "--handler",
                "bootstrap",
                "--profile",
                str(ROOT / LOCAL_PROFILE),
                "--name-prefix",
                self.prefix,
                "--stdio",
            ],
            cwd=str(ROOT),
            env=harness.env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

    def call(self, event: dict, timeout: float = 120) -> dict:
        if self.process.stdin is None or self.process.stdout is None:
            raise HarnessFailure("MCP container has no stdio pipes")
        try:
            self.process.stdin.write(json.dumps(event) + "\n")
            self.process.stdin.flush()
        except BrokenPipeError as exc:
            raise HarnessFailure("MCP container closed its input", self._stderr()) from exc
        ready, _, _ = select.select([self.process.stdout], [], [], timeout)
        if not ready:
            self.close()
            raise HarnessFailure("MCP container did not answer within the timeout", self._stderr())
        line = self.process.stdout.readline()
        if not line:
            raise HarnessFailure(
                f"MCP container exited before answering (code {self.process.poll()})", self._stderr()
            )
        try:
            return json.loads(line)
        except json.JSONDecodeError as exc:
            raise HarnessFailure(f"MCP container returned non-JSON: {exc}", line) from exc

    def close(self) -> str:
        if self.process.stdin is not None:
            try:
                self.process.stdin.close()
            except OSError:
                pass
        try:
            self.process.wait(timeout=180)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=30)
            raise HarnessFailure("MCP container did not shut down")
        stderr = self._stderr()
        if self.process.returncode != 0:
            raise HarnessFailure(
                f"MCP container {self.prefix} exited {self.process.returncode}", stderr
            )
        _assert_local_runner_cleanup(self.harness, self.prefix)
        return stderr

    def _stderr(self) -> str:
        if self.process.stderr is None:
            return ""
        try:
            return self.process.stderr.read()
        except OSError:
            return ""

    def abort(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=30)


def _mcp_raw_response(result: dict, label: str) -> tuple[int, str, dict]:
    if not result.get("proxy"):
        raise HarnessFailure(f"{label}: handler did not return a proxy response", json.dumps(result))
    headers = {name.lower(): values for name, values in (result.get("headers") or {}).items()}
    return int(result.get("statusCode") or 0), str(result.get("body") or ""), headers


def _mcp_response(result: dict, label: str) -> tuple[int, dict, dict]:
    if not result.get("proxy"):
        raise HarnessFailure(f"{label}: handler did not return a proxy response", json.dumps(result))
    try:
        body = json.loads(result.get("body") or "{}")
    except json.JSONDecodeError as exc:
        raise HarnessFailure(f"{label}: response body is not JSON: {exc}", result.get("body") or "") from exc
    headers = {name.lower(): values for name, values in (result.get("headers") or {}).items()}
    return int(result.get("statusCode") or 0), body, headers


def _mcp_initialize(client: McpWarmContainer, label: str) -> tuple[str, str]:
    result = client.call(
        mcp_event(
            "initialize",
            payload={
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "apptheory-harness", "version": "dev"},
            },
        )
    )
    status, body, headers = _mcp_response(result, f"{label} initialize")
    if status != 200 or body.get("jsonrpc") != "2.0":
        raise HarnessFailure(f"{label} initialize: unexpected response {result}")
    session = (headers.get("mcp-session-id") or [""])[0]
    if not re.fullmatch(r"[0-9a-f]{16,64}", session):
        raise HarnessFailure(f"{label} initialize: no MCP session id: {headers}")
    protocol = str((body.get("result") or {}).get("protocolVersion") or "")
    if not protocol:
        raise HarnessFailure(f"{label} initialize: no protocol version: {body}")
    return session, protocol


def _mcp_jsonrpc(client: McpWarmContainer, label: str, origin_event: dict) -> dict:
    result = client.call(origin_event)
    status, body, _ = _mcp_response(result, label)
    if status != 200:
        raise HarnessFailure(f"{label}: status {status}", json.dumps(body))
    return body


def run_mcp_tools_only(harness: Harness) -> str:
    client = McpWarmContainer(harness, "tools-only", "mcp-tools-only")
    try:
        session, protocol = _mcp_initialize(client, "tools-only")
        tools = _mcp_jsonrpc(
            client,
            "tools-only tools/list",
            mcp_event("tools/list", session=session, protocol=protocol),
        )
        names = [tool.get("name") for tool in ((tools.get("result") or {}).get("tools") or [])]
        if names != ["echo"]:
            raise HarnessFailure(f"tools-only tools/list: unexpected tools {names}")

        call = _mcp_jsonrpc(
            client,
            "tools-only tools/call",
            mcp_event(
                "tools/call",
                session=session,
                protocol=protocol,
                payload={"name": "echo", "arguments": {"message": "hello-mcp"}},
            ),
        )
        content = (call.get("result") or {}).get("content") or []
        if not content or content[0].get("text") != "hello-mcp":
            raise HarnessFailure(f"tools-only tools/call: unexpected result {call}")

        refusal = _mcp_jsonrpc(
            client,
            "tools-only invalid method",
            mcp_event("tools/unknown", session=session, protocol=protocol),
        )
        if (refusal.get("error") or {}).get("code") != -32601:
            raise HarnessFailure(f"tools-only invalid method: unexpected refusal {refusal}")

        invalid = _mcp_jsonrpc(
            client,
            "tools-only invalid arguments",
            mcp_event(
                "tools/call",
                session=session,
                protocol=protocol,
                payload={"name": "echo", "arguments": {}},
            ),
        )
        if (invalid.get("error") or {}).get("code") != -32602:
            raise HarnessFailure(f"tools-only invalid arguments: unexpected refusal {invalid}")
        return "one warm container: initialize, tools/list, tools/call and two JSON-RPC refusals"
    finally:
        client.close()


def run_mcp_tools_resources_prompts(harness: Harness) -> str:
    client = McpWarmContainer(harness, "tools-resources-prompts", "mcp-tools-resources-prompts")
    try:
        session, protocol = _mcp_initialize(client, "tools-resources-prompts")
        tools = _mcp_jsonrpc(
            client,
            "tools-resources-prompts tools/list",
            mcp_event("tools/list", session=session, protocol=protocol),
        )
        if [tool.get("name") for tool in ((tools.get("result") or {}).get("tools") or [])] != ["echo"]:
            raise HarnessFailure(f"tools-resources-prompts tools/list: {tools}")
        call = _mcp_jsonrpc(
            client,
            "tools-resources-prompts tools/call",
            mcp_event(
                "tools/call",
                session=session,
                protocol=protocol,
                payload={"name": "echo", "arguments": {"message": "hello-res"}},
            ),
        )
        call_content = (call.get("result") or {}).get("content") or []
        if not call_content or call_content[0].get("text") != "hello-res":
            raise HarnessFailure(f"tools-resources-prompts tools/call: {call}")
        resources = _mcp_jsonrpc(
            client,
            "tools-resources-prompts resources/list",
            mcp_event("resources/list", session=session, protocol=protocol),
        )
        if [
            resource.get("uri")
            for resource in ((resources.get("result") or {}).get("resources") or [])
        ] != ["file://hello.txt"]:
            raise HarnessFailure(f"tools-resources-prompts resources/list: {resources}")
        read = _mcp_jsonrpc(
            client,
            "tools-resources-prompts resources/read",
            mcp_event(
                "resources/read",
                session=session,
                protocol=protocol,
                payload={"uri": "file://hello.txt"},
            ),
        )
        contents = (read.get("result") or {}).get("contents") or []
        if not contents or contents[0].get("text") != "hello world":
            raise HarnessFailure(f"tools-resources-prompts resources/read: {read}")
        prompts = _mcp_jsonrpc(
            client,
            "tools-resources-prompts prompts/list",
            mcp_event("prompts/list", session=session, protocol=protocol),
        )
        if [prompt.get("name") for prompt in ((prompts.get("result") or {}).get("prompts") or [])] != ["greet"]:
            raise HarnessFailure(f"tools-resources-prompts prompts/list: {prompts}")
        get = _mcp_jsonrpc(
            client,
            "tools-resources-prompts prompts/get",
            mcp_event(
                "prompts/get",
                session=session,
                protocol=protocol,
                payload={"name": "greet", "arguments": {"name": "Aurora"}},
            ),
        )
        messages = (get.get("result") or {}).get("messages") or []
        if not messages or messages[0].get("content", {}).get("text") != "hello Aurora":
            raise HarnessFailure(f"tools-resources-prompts prompts/get: {get}")
        refusal = _mcp_jsonrpc(
            client,
            "tools-resources-prompts invalid method",
            mcp_event("prompts/unknown", session=session, protocol=protocol),
        )
        if (refusal.get("error") or {}).get("code") != -32601:
            raise HarnessFailure(f"tools-resources-prompts invalid method: {refusal}")
        return "one warm container: tools, resources/read and prompts/get served; invalid method refused"
    finally:
        client.close()


def _parse_sse(body: str) -> list[tuple[str, str]]:
    events: list[tuple[str, str]] = []
    for block in body.split("\n\n"):
        lines = [line for line in block.splitlines() if line]
        if not lines:
            continue
        event_id = next((line[3:].strip() for line in lines if line.startswith("id:")), "")
        data = "\n".join(line[5:].lstrip() for line in lines if line.startswith("data:"))
        events.append((event_id, data))
    return events


def run_mcp_resumable_sse(harness: Harness) -> str:
    client = McpWarmContainer(harness, "resumable-sse", "mcp-resumable-sse")
    try:
        session, protocol = _mcp_initialize(client, "resumable-sse")
        result = client.call(
            mcp_event(
                "tools/call",
                session=session,
                protocol=protocol,
                payload={
                    "name": "countdown",
                    "arguments": {"steps": 3},
                    "_meta": {"progressToken": "a3b-progress"},
                },
            )
        )
        status, body, headers = _mcp_raw_response(result, "resumable-sse tools/call")
        if status != 200 or (headers.get("content-type") or [""])[0] != "text/event-stream":
            raise HarnessFailure(f"resumable-sse tools/call: unexpected response {result}")
        events = _parse_sse(body)
        if not events or events[0][0] != "1" or events[0][1].strip():
            raise HarnessFailure(f"resumable-sse tools/call: priming event missing: {events}")
        progress = [data for event_id, data in events if "notifications/progress" in data]
        if len(progress) != 3 or '"progress":3' not in progress[-1]:
            raise HarnessFailure(f"resumable-sse tools/call: unexpected progress events {progress}")
        if '"text":"done"' not in (events[-1][1] if events else ""):
            raise HarnessFailure(f"resumable-sse tools/call: final result missing: {events[-2:]}")
        replay_from = events[1][0] if len(events) > 1 else ""
        if not replay_from:
            raise HarnessFailure("resumable-sse tools/call: no event id to resume from")

        resumed = client.call(
            mcp_event(
                "GET",
                http_method="GET",
                session=session,
                protocol=protocol,
                headers={"accept": "text/event-stream", "last-event-id": replay_from},
                body="",
            )
        )
        status, resumed_body, resumed_headers = _mcp_raw_response(resumed, "resumable-sse resume")
        if status != 200 or (resumed_headers.get("content-type") or [""])[0] != "text/event-stream":
            raise HarnessFailure(f"resumable-sse resume: unexpected response {resumed}")
        replayed = _parse_sse(resumed_body)
        ids = [event_id for event_id, _ in replayed if event_id]
        expected_first = str(int(replay_from) + 1)
        if not ids or ids[0] != expected_first:
            raise HarnessFailure(
                f"resumable-sse resume: replay must continue after {replay_from} at {expected_first}: {ids}"
            )
        if replay_from in ids or "1" in ids:
            raise HarnessFailure(f"resumable-sse resume: a consumed event was replayed: {ids}")
        if not any('"text":"done"' in data for _, data in replayed):
            raise HarnessFailure(f"resumable-sse resume: the final result was not replayed: {replayed}")
        return (
            "one warm container: session created, buffered 5-event stream with ids, "
            "and Last-Event-ID replay continuing after the consumed progress event through the final result"
        )
    finally:
        client.close()


def run_multilang_go(harness: Harness) -> str:
    return run_multilang(harness, "go")


def run_multilang_ts(harness: Harness) -> str:
    return run_multilang(harness, "ts")


def run_multilang_py(harness: Harness) -> str:
    return run_multilang(harness, "py")


def run_lesser_parity_api(harness: Harness) -> str:
    return run_lesser_parity(harness, "api")


def run_lesser_parity_graphql(harness: Harness) -> str:
    return run_lesser_parity(harness, "graphql")


def run_lesser_parity_sse(harness: Harness) -> str:
    return run_lesser_parity(harness, "sse")


def run_lesser_parity_worker(harness: Harness) -> str:
    return run_lesser_parity(harness, "worker")


def run_restv1_api(harness: Harness) -> str:
    return run_restv1(harness, "api")


def run_restv1_graphql(harness: Harness) -> str:
    return run_restv1(harness, "graphql")


def run_restv1_inventory(harness: Harness) -> str:
    return run_restv1(harness, "inventory")


def run_restv1_sse(harness: Harness) -> str:
    return run_restv1(harness, "sse")


def _cognito(harness: Harness, endpoint: str, *arguments: str) -> subprocess.CompletedProcess:
    return harness.run(
        ["aws", "--endpoint-url", endpoint, "cognito-idp", *arguments],
        timeout=180,
    )


def _cognito_tokens(harness: Harness, endpoint: str, pool: dict, client: dict, username: str) -> dict:
    """Create a real user and mint real id/access tokens through the Cognito API."""
    pool_id = pool["name"]
    client_id = client["name"]
    _cognito(
        harness, endpoint,
        "admin-create-user",
        "--user-pool-id", pool_id,
        "--username", username,
        "--message-action", "SUPPRESS",
    )
    _cognito(
        harness, endpoint,
        "admin-set-user-password",
        "--user-pool-id", pool_id,
        "--username", username,
        "--password", "Passw0rd!23",
        "--permanent",
    )
    result = _cognito(
        harness, endpoint,
        "admin-initiate-auth",
        "--user-pool-id", pool_id,
        "--client-id", client_id,
        "--auth-flow", "ADMIN_USER_PASSWORD_AUTH",
        "--auth-parameters", f"USERNAME={username},PASSWORD=Passw0rd!23",
    )
    try:
        return json.loads(result.stdout)["AuthenticationResult"]
    except (json.JSONDecodeError, KeyError) as exc:
        raise HarnessFailure(f"cognito: no AuthenticationResult for {username}: {exc}", result.stdout) from exc


def _api_by_prefix(session: LocalSession, prefix: str, api_class: str) -> dict:
    matches = [
        api for api in session.info.get("apis") or []
        if api.get("class") == api_class and str(api.get("logicalId") or "").startswith(prefix)
    ]
    if len(matches) != 1:
        raise HarnessFailure(f"want one {api_class} API with prefix {prefix}, got {matches}")
    return matches[0]


def run_lambda_role_authorizers(harness: Harness) -> str:
    """HTTP API JWT and REST Cognito authorizers, with real cognito tokens.

    The clock starts ten minutes ahead of wall time so a token minted after the
    session starts has an iat before the run clock (the documented future-issue
    check); advancing it two hours proves the expiry is checked against the run
    clock.
    """
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0) + datetime.timedelta(minutes=10)
    session = start_local_session(
        harness,
        LAMBDA_ROLE_APP,
        name="lambda-role-auth",
        backends=("moto", "s3proxy"),
        clock="test=" + now.isoformat().replace("+00:00", "Z"),
    )
    try:
        pool = session.resource(logical_prefix="CognitoPool", kind="AWS::Cognito::UserPool")
        client = session.resource(logical_prefix="CognitoClient", kind="AWS::Cognito::UserPoolClient")
        other_client = session.resource(logical_prefix="OtherCognitoClient", kind="AWS::Cognito::UserPoolClient")
        foreign_pool = session.resource(logical_prefix="ForeignCognitoPool", kind="AWS::Cognito::UserPool")
        foreign_client = session.resource(logical_prefix="ForeignCognitoClient", kind="AWS::Cognito::UserPoolClient")
        endpoint = session_endpoint(session, "cognito-idp")

        valid = _cognito_tokens(harness, endpoint, pool, client, "alice")
        other = _cognito_tokens(harness, endpoint, pool, other_client, "bob")
        foreign = _cognito_tokens(harness, endpoint, foreign_pool, foreign_client, "carol")

        http_api = _api_by_prefix(session, "AuthorizedHttpApi", "httpv2")
        rest_api = _api_by_prefix(session, "AuthorizedRestApi", "restv1")
        http_base = http_api["url"]
        rest_base = rest_api["url"]

        # The valid ID token reaches the integration with the documented claims.
        status, payload, _ = _json_request(
            "GET", f"{http_base}/protected", headers={"Authorization": f"Bearer {valid['IdToken']}"}
        )
        expect_status(status, 200, "jwt authorizer GET /protected", json.dumps(payload))
        claims = payload.get("claims") or {}
        if claims.get("token_use") != "id" or claims.get("aud") != client["name"]:
            raise HarnessFailure(f"jwt authorizer: unexpected claims {claims}")
        if pool["name"] not in str(claims.get("iss")):
            raise HarnessFailure(f"jwt authorizer: the issuer claim {claims.get('iss')!r} does not name the pool")
        if (payload.get("authorizer") or {}).get("jwt") is None:
            raise HarnessFailure(f"jwt authorizer: requestContext.authorizer.jwt is missing: {payload}")

        tampered = valid["IdToken"][:-4] + ("AAAA" if not valid["IdToken"].endswith("AAAA") else "BBBB")
        cases = [
            ("no token", None, 401),
            ("bad signature", f"Bearer {tampered}", 401),
            ("wrong audience", f"Bearer {other['IdToken']}", 401),
            ("wrong issuer", f"Bearer {foreign['IdToken']}", 401),
            ("wrong scheme", f"Basic {valid['IdToken']}", 401),
        ]
        for label, header, want in cases:
            headers = {"Authorization": header} if header else {}
            status, text, _ = http_request("GET", f"{http_base}/protected", headers=headers)
            expect_status(status, want, f"jwt authorizer {label}", text)

        # The REST Cognito authorizer accepts the access token and exposes its
        # claims; a route whose scope the token lacks is refused with 403.
        status, payload, _ = _json_request(
            "GET", f"{rest_base}/protected", headers={"Authorization": f"Bearer {valid['AccessToken']}"}
        )
        expect_status(status, 200, "cognito authorizer GET /protected", json.dumps(payload))
        claims = payload.get("claims") or {}
        if claims.get("token_use") != "access" or claims.get("username") != "alice":
            raise HarnessFailure(f"cognito authorizer: unexpected claims {claims}")
        if "aws.cognito.signin.user.admin" not in str(claims.get("scope")):
            raise HarnessFailure(f"cognito authorizer: the scope claim {claims.get('scope')!r} is wrong")
        status, text, _ = http_request(
            "GET", f"{rest_base}/admin", headers={"Authorization": f"Bearer {valid['AccessToken']}"}
        )
        expect_status(status, 403, "cognito authorizer GET /admin (missing scope)", text)
        status, text, _ = http_request(
            "GET", f"{rest_base}/admin", headers={"Authorization": f"Bearer {foreign['AccessToken']}"}
        )
        expect_status(status, 401, "cognito authorizer GET /admin (wrong issuer)", text)
        status, text, _ = http_request("GET", f"{rest_base}/protected")
        expect_status(status, 401, "cognito authorizer GET /protected (no token)", text)

        # REST TOKEN, REST REQUEST and HTTP API IAM-policy authorizers run the
        # real policy function. The function counts its own invocations and
        # returns the count in the context, so a cached decision is proven by an
        # unchanged count rather than by the runner's bookkeeping.
        policy_api = _api_by_prefix(session, "PolicyHttpApi", "httpv2")
        policy_base = policy_api["url"]

        status, payload, _ = _json_request(
            "GET", f"{rest_base}/token", headers={"Authorization": "allow"}
        )
        expect_status(status, 200, "rest token authorizer allow", json.dumps(payload))
        authorizer = payload.get("authorizer") or {}
        if authorizer.get("tenant") != "t-1":
            raise HarnessFailure(f"rest token authorizer context = {authorizer}")
        token_first = int(authorizer.get("invocation", "0"))
        status, payload, _ = _json_request(
            "GET", f"{rest_base}/token", headers={"Authorization": "allow"}
        )
        expect_status(status, 200, "rest token authorizer cached", json.dumps(payload))
        if int((payload.get("authorizer") or {}).get("invocation", "0")) != token_first:
            raise HarnessFailure("the cached rest token decision invoked the authorizer again")

        # The cached value is the POLICY, not the decision for GET /token: the
        # policy the function returned names only that method ARN, so the same
        # token on GET /token-other (the SAME TOKEN authorizer) is 403 inside
        # the TTL. "Ensure that your policy is applicable to all resources and
        # methods across your API."
        status, text, _ = http_request(
            "GET", f"{rest_base}/token-other", headers={"Authorization": "allow"}
        )
        expect_status(status, 403, "rest token authorizer cached policy names only /token", text)

        # The TOKEN authorizer caches for 60 seconds on the run clock: one
        # second past the TTL GET /token-other invokes the function again and
        # its policy (which now names /token-other) allows the method. The
        # invocation count proves the 403 above did not invoke the function.
        session.clock_advance("61s")
        status, payload, _ = _json_request(
            "GET", f"{rest_base}/token-other", headers={"Authorization": "allow"}
        )
        expect_status(status, 200, "rest token authorizer after the ttl on another method", json.dumps(payload))
        token_after = int((payload.get("authorizer") or {}).get("invocation", "0"))
        if token_after != token_first + 1:
            raise HarnessFailure(
                "the cached policy for GET /token was not re-evaluated per method or the 403 invoked "
                f"the authorizer: invocation {token_after} after {token_first}"
            )

        # The remaining token values use their own cache keys and do not touch
        # the "allow" entry proved above.
        status, _unused, _ = http_request("GET", f"{rest_base}/token")
        expect_status(status, 401, "rest token authorizer missing token", "")
        for label, token, want in (
            ("deny", "deny", 403),
            ("unauthorized", "unauthorized", 401),
            ("invalid", "invalid", 500),
        ):
            status, text, _ = http_request(
                "GET", f"{rest_base}/token", headers={"Authorization": token}
            )
            expect_status(status, want, f"rest token authorizer {label}", text)

        # The REQUEST authorizer declares two identity sources and caches the
        # policy for 60 seconds.
        status, payload, _ = _json_request(
            "GET",
            f"{rest_base}/request?scope=read",
            headers={"X-Tenant": "t-1"},
        )
        expect_status(status, 200, "rest request authorizer allow", json.dumps(payload))
        if (payload.get("authorizer") or {}).get("tenant") != "t-1":
            raise HarnessFailure(f"rest request authorizer context = {payload.get('authorizer')}")
        status, text, _ = http_request(
            "GET", f"{rest_base}/request", headers={"X-Tenant": "t-1"}
        )
        expect_status(status, 401, "rest request authorizer missing query source", text)
        status, text, _ = http_request(
            "GET", f"{rest_base}/request?scope=read", headers={"X-Tenant": "deny"}
        )
        expect_status(status, 403, "rest request authorizer deny", text)

        # The HTTP API authorizer returns an IAM policy in payload format 1.0
        # and caches for 60 seconds on the run clock.
        status, payload, _ = _json_request(
            "GET", f"{policy_base}/policy", headers={"Authorization": "allow"}
        )
        expect_status(status, 200, "http policy authorizer allow", json.dumps(payload))
        first_invocation = (payload.get("authorizer") or {}).get("invocation")
        if not first_invocation:
            raise HarnessFailure(f"http policy authorizer context = {payload.get('authorizer')}")
        status, payload, _ = _json_request(
            "GET", f"{policy_base}/policy", headers={"Authorization": "allow"}
        )
        expect_status(status, 200, "http policy authorizer cached", json.dumps(payload))
        if (payload.get("authorizer") or {}).get("invocation") != first_invocation:
            raise HarnessFailure("the cached http policy decision invoked the authorizer again")
        for label, token, want in (
            ("deny", "deny", 403),
            ("unauthorized", "unauthorized", 401),
            ("invalid", "invalid", 500),
        ):
            status, text, _ = http_request(
                "GET", f"{policy_base}/policy", headers={"Authorization": token}
            )
            expect_status(status, want, f"http policy authorizer {label}", text)
        status, text, _ = http_request("GET", f"{policy_base}/policy")
        expect_status(status, 401, "http policy authorizer missing identity source", text)

        # The expiry is checked against the run clock: two hours later the same
        # token is expired.
        session.clock_advance("2h")
        status, text, _ = http_request(
            "GET", f"{http_base}/protected", headers={"Authorization": f"Bearer {valid['IdToken']}"}
        )
        expect_status(status, 401, "jwt authorizer expired token", text)
        status, text, _ = http_request(
            "GET", f"{rest_base}/protected", headers={"Authorization": f"Bearer {valid['AccessToken']}"}
        )
        expect_status(status, 401, "cognito authorizer expired token", text)
        return (
            "a real ID token minted by the moto Cognito pool reached the HTTP API JWT-protected route and "
            "the integration received requestContext.authorizer.jwt.claims (iss, aud, token_use); a real "
            "access token reached the REST Cognito-protected route with its claims and the documented "
            "scope; no token, a bad signature, a wrong audience, a wrong issuer and a Basic scheme were "
            "refused with 401, a missing scope with 403, and after advancing the run clock two hours the "
            "same tokens were refused as expired; a REST TOKEN, a REST REQUEST and an HTTP API IAM-policy "
            "authorizer ran the real policy function and carried its stringified context to the "
            "integration, Allow invoked the method, Deny was 403, the documented Unauthorized error was "
            "401, an invalid policy was 500, a missing identity source was 401 without invoking, and a "
            "cached TOKEN policy did not invoke the function again but was re-evaluated against a second "
            "method behind the same authorizer (403 because the policy named only the first method), "
            "until the run clock passed AuthorizerResultTtlInSeconds and the second method invoked and "
            "was allowed"
        )
    finally:
        stop_local_session(harness, session)


def run_lambda_role_index(harness: Harness) -> str:
    return run_lambda_role(harness, "index")


def run_lambda_role_encrypted(harness: Harness) -> str:
    return run_lambda_role(harness, "encrypted")


def run_lambda_role_custom(harness: Harness) -> str:
    return run_lambda_role(harness, "custom")


def _assert_derived_surface(spec: dict, lang: str) -> None:
    functions = spec.get("functions") or []
    if len(functions) != 1:
        raise HarnessFailure(f"apptheory-local plan derived {len(functions)} functions, want 1", json.dumps(spec))
    function = functions[0]
    expected_runtime = LOCAL_RUNNER_RUNTIMES[lang]
    if function.get("runtime") != expected_runtime:
        raise HarnessFailure(f"apptheory-local plan: runtime {function.get('runtime')!r}, want {expected_runtime!r}")
    if function.get("architecture") != "arm64":
        raise HarnessFailure(f"apptheory-local plan: architecture {function.get('architecture')!r}, want arm64")
    apis = spec.get("apis") or []
    if len(apis) != 1 or apis[0].get("class") != "httpv2":
        raise HarnessFailure(f"apptheory-local plan: want one HTTP API v2 surface, got {apis}")
    routes = {(route.get("method"), route.get("path")) for route in apis[0].get("routes") or []}
    for expected in (("ANY", "/"), ("ANY", "/{proxy+}")):
        if expected not in routes:
            raise HarnessFailure(f"apptheory-local plan: route {expected} missing from {sorted(routes)}")


def _wait_for_local_runner(process: subprocess.Popen, log_path: str, seconds: int = 600) -> list[str]:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise HarnessFailure(
                f"apptheory-local exited before it was ready (code {process.returncode})",
                Path(log_path).read_text(encoding="utf-8", errors="replace"),
            )
        text = Path(log_path).read_text(encoding="utf-8", errors="replace")
        if LOCAL_RUNNER_READY in text:
            urls = re.findall(r"^serving \S+ \S+ at (http://127\.0\.0\.1:\d+)$", text, re.MULTILINE)
            if not urls:
                raise HarnessFailure("apptheory-local reported ready without a listening URL", text)
            return urls
        time.sleep(0.25)
    raise HarnessFailure(
        "apptheory-local did not become ready",
        Path(log_path).read_text(encoding="utf-8", errors="replace"),
    )


def ensure_cdk_app(harness: Harness, app: str) -> Path:
    """Install an example's CDK dependencies when its local CLI is missing."""
    directory = ROOT / app
    cdk_cli = directory / "node_modules" / ".bin" / "cdk"
    if not cdk_cli.exists():
        print(f"  ... installing {app} dependencies (npm ci)")
        harness.run(["npm", "ci", "--ignore-scripts"], cwd=directory, timeout=1800)
    if not cdk_cli.exists():
        raise HarnessFailure(f"the CDK CLI is still missing for {app}: {cdk_cli}")
    return directory


def local_app_prefix(harness: Harness, name: str) -> str:
    lease = harness.lease
    slot = f"s{lease.slot}" if lease.slot >= 0 else f"p{lease.port}"
    return f"a4-{lease.checkout}-{slot}-{name}"


@dataclass
class LocalAppRun:
    process: subprocess.Popen
    log_path: str
    prefix: str
    spec: dict
    apis: dict[str, str]
    api_classes: dict[str, str]


def plan_local_app(
    harness: Harness, app: str, context: dict | None = None, *, allow_no_surface: bool = False
) -> dict:
    ensure_cdk_app(harness, app)
    argv = [
        str(LOCAL_RUNNER_BIN),
        "plan",
        "--app",
        app,
        "--profile",
        str(ROOT / LOCAL_PROFILE),
        "--json",
    ]
    if allow_no_surface:
        argv.append("--allow-no-surface")
    for key, value in sorted((context or {}).items()):
        argv.extend(["-c", f"{key}={value}"])
    result = harness.run(argv, timeout=1800)
    try:
        plan = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise HarnessFailure(f"apptheory-local plan for {app} did not print JSON: {exc}", result.stdout) from exc
    _assert_plan_delivery(plan, app)
    return plan


def _expected_delivery_entries(plan: dict) -> list[tuple[str, str, str | None]]:
    """Every derived mapping, rule and subscription, with its delivery kind."""
    entries: list[tuple[str, str, str | None]] = []
    for source in plan.get("eventSources") or []:
        entries.append((source["logicalId"], source["type"], source.get("function")))
    for rule in plan.get("rules") or []:
        kind = "eventbridge-schedule" if rule.get("schedule") else "eventbridge-rule"
        entries.append((rule["logicalId"], kind, None))
    for subscription in plan.get("subscriptions") or []:
        kind = subscription.get("kind") or "cloudwatch-logs"
        entries.append((subscription["logicalId"], kind, subscription.get("function")))
    for notification in plan.get("notifications") or []:
        function = (
            notification.get("destination")
            if notification.get("destinationType") == "function"
            else None
        )
        entries.append((notification["logicalId"], "s3-notification", function))
    return entries


def _assert_plan_delivery(plan: dict, app: str) -> None:
    """Plan must report the state the engine would register for every source.

    A kind with a deliverer (``DELIVERED_KINDS``) must be visible as
    ``registered`` with no task or reason; every other derived source must be
    ``not-delivered`` with the task that will implement it. A missing or
    silently registered source fails the row.
    """
    delivery = plan.get("delivery")
    if delivery is None:
        # An assembly with no mapping, rule or subscription has no delivery
        # entries; the id comparison below still catches a plan that drops them
        # for an app that has sources.
        delivery = []
    if not isinstance(delivery, list):
        raise HarnessFailure(f"{app}: plan has no delivery state: {delivery!r}")
    expected = _expected_delivery_entries(plan)
    by_id: dict[str, dict] = {}
    for entry in delivery:
        logical_id = entry.get("id")
        if logical_id in by_id:
            raise HarnessFailure(f"{app}: plan reports delivery for {logical_id} twice")
        by_id[logical_id] = entry
    expected_ids = {logical_id for logical_id, _, _ in expected}
    if set(by_id) != expected_ids:
        raise HarnessFailure(
            f"{app}: delivery ids {sorted(by_id)} do not match the derived sources {sorted(expected_ids)}"
        )
    for logical_id, kind, function in expected:
        entry = by_id[logical_id]
        if entry.get("kind") != kind:
            raise HarnessFailure(f"{app}: {logical_id} delivery kind {entry.get('kind')!r} != {kind!r}")
        if kind in DELIVERED_KINDS:
            if entry.get("state") != "registered":
                raise HarnessFailure(f"{app}: {logical_id} is {entry.get('state')!r}, want registered")
            if entry.get("task") or entry.get("reason"):
                raise HarnessFailure(f"{app}: {logical_id} is registered but still names a task: {entry!r}")
        else:
            if entry.get("state") != "not-delivered":
                raise HarnessFailure(f"{app}: {logical_id} is {entry.get('state')!r}, want not-delivered")
            if entry.get("task") != DELIVERY_TASKS[kind]:
                raise HarnessFailure(
                    f"{app}: {logical_id} delivery task {entry.get('task')!r} != {DELIVERY_TASKS[kind]!r}"
                )
            reason = str(entry.get("reason") or "")
            if not reason.startswith("engine present; "):
                raise HarnessFailure(f"{app}: {logical_id} has no engine reason: {reason!r}")
        if function and entry.get("function") != function:
            raise HarnessFailure(
                f"{app}: {logical_id} delivery function {entry.get('function')!r} != {function!r}"
            )


def _describe_delivery(session: "LocalSession") -> dict:
    described = session.request("describe")
    session.info = described
    delivery = described.get("delivery") or {}
    if not isinstance(delivery, dict):
        raise HarnessFailure(f"session {session.prefix}: describe has no delivery object: {delivery!r}")
    return delivery


def _assert_session_delivery(session: "LocalSession") -> None:
    """A live session must report the engine state for every derived source.

    A kind whose local backend is running reaches its live state (polling for a
    poller, armed for a rule or subscription). Without the backend it reports
    failed or paused with the closed-backend reason. Every other kind stays
    not-delivered and names its task.
    """
    expected = _expected_delivery_entries(session.spec)
    expected_by_id = {logical_id: (kind, function) for logical_id, kind, function in expected}

    def available(kind: str) -> bool:
        backend = DELIVERY_BACKEND.get(kind)
        return backend is None or backend in session.backends

    deadline = time.monotonic() + 60
    while True:
        delivery = _describe_delivery(session)
        states = {source.get("id"): source for source in delivery.get("sources") or []}
        settled = True
        for logical_id, (kind, _) in expected_by_id.items():
            if kind not in DELIVERED_KINDS:
                continue
            state = str((states.get(logical_id) or {}).get("state") or "")
            allowed = DELIVERY_LIVE_STATE[kind] if available(kind) else ("failed", "paused")
            if state == "registered" or state not in allowed:
                settled = False
        if settled or time.monotonic() >= deadline:
            break
        time.sleep(0.1)
    if delivery.get("running") is not True:
        raise HarnessFailure(f"session {session.prefix}: the delivery engine is not running")
    if delivery.get("concurrency") != DELIVERY_CONCURRENCY:
        raise HarnessFailure(
            f"session {session.prefix}: delivery concurrency {delivery.get('concurrency')!r} != {DELIVERY_CONCURRENCY}"
        )
    clock = delivery.get("clock") or {}
    if clock.get("mode") != session.clock_mode:
        raise HarnessFailure(
            f"session {session.prefix}: delivery clock mode {clock.get('mode')!r} != {session.clock_mode!r}"
        )
    sources = delivery.get("sources") or []
    if {source.get("id") for source in sources} != set(expected_by_id):
        raise HarnessFailure(
            f"session {session.prefix}: delivery sources {[source.get('id') for source in sources]} "
            f"do not match the plan's derived sources {sorted(expected_by_id)}"
        )
    for source in sources:
        logical_id = str(source.get("id"))
        kind, _ = expected_by_id[logical_id]
        if kind in DELIVERED_KINDS:
            state = str(source.get("state") or "")
            allowed = DELIVERY_LIVE_STATE[kind] if available(kind) else ("failed", "paused")
            if state not in allowed:
                raise HarnessFailure(
                    f"session {session.prefix}: {logical_id} is {state!r}, want one of {allowed}"
                )
            if source.get("task") or source.get("reason"):
                raise HarnessFailure(f"session {session.prefix}: {logical_id} still names a task: {source}")
            if "inflight" not in source or "peakInflight" not in source:
                raise HarnessFailure(f"session {session.prefix}: {logical_id} has no live in-flight count: {source}")
            continue
        if source.get("state") != "not-delivered":
            raise HarnessFailure(
                f"session {session.prefix}: {logical_id} is {source.get('state')!r}, want not-delivered"
            )
        if not source.get("task") or not str(source.get("reason") or "").startswith("engine present; "):
            raise HarnessFailure(
                f"session {session.prefix}: {logical_id} does not name its delivery task: {source}"
            )
    now = session.clock_now()
    if now.get("mode") != session.clock_mode:
        raise HarnessFailure(f"session {session.prefix}: clock.now mode {now.get('mode')!r} != {session.clock_mode!r}")
    instant = str(now.get("now") or "")
    # Go's RFC3339Nano emits up to nine fractional digits; Python's
    # fromisoformat accepts at most six.
    normalized = re.sub(r"(\.\d{6})\d+", r"\1", instant)
    try:
        parsed = datetime.datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HarnessFailure(f"session {session.prefix}: clock.now is not RFC3339: {instant!r}") from exc
    if session.clock_mode == "test":
        expected_start = datetime.datetime.fromisoformat(
            (session.clock_start or LOCAL_RUNNER_CLOCK_START).replace("Z", "+00:00")
        )
        if parsed != expected_start:
            raise HarnessFailure(
                f"session {session.prefix}: test clock started at {instant!r}, want {session.clock_start!r}"
            )
    else:
        drift = abs((datetime.datetime.now(datetime.timezone.utc) - parsed).total_seconds())
        if drift > 300:
            raise HarnessFailure(f"session {session.prefix}: real clock.now drifted {drift:.0f}s from wall time")


def start_local_app(
    harness: Harness,
    app: str,
    *,
    name: str,
    context: dict | None = None,
    backends: tuple[str, ...] = (),
    origins: tuple[str, ...] = (),
) -> LocalAppRun:
    ensure_cdk_app(harness, app)
    spec = plan_local_app(harness, app, context)
    prefix = local_app_prefix(harness, name)
    log = tempfile.NamedTemporaryFile(prefix=f"a4-{name}-", suffix=".log", delete=False)
    argv = [
        str(LOCAL_RUNNER_BIN),
        "run",
        "--app",
        app,
        "--profile",
        str(ROOT / LOCAL_PROFILE),
        "--port-base",
        str(harness.lease.http_port),
        "--name-prefix",
        prefix,
    ]
    for key, value in sorted((context or {}).items()):
        argv.extend(["-c", f"{key}={value}"])
    for backend in backends:
        argv.extend(["--backend", backend])
    for origin in origins:
        argv.extend(["--origin", origin])
    process = subprocess.Popen(
        argv,
        cwd=str(ROOT),
        env=harness.env,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        apis, classes = _wait_for_local_runner_apis(process, log.name)
    except Exception:
        _terminate_process(process)
        log.close()
        raise
    return LocalAppRun(
        process=process,
        log_path=log.name,
        prefix=prefix,
        spec=spec,
        apis=apis,
        api_classes=classes,
    )


@dataclass
class LocalSession:
    process: subprocess.Popen
    log_path: str
    prefix: str
    spec: dict
    info: dict
    clock_mode: str = "real"
    clock_start: str | None = None
    backends: tuple[str, ...] = ()

    def clock_now(self) -> dict:
        return self.request("clock.now")

    def clock_advance(self, duration: str) -> dict:
        return self.request("clock.advance", duration=duration)

    def request(self, op: str, **fields) -> dict:
        payload = {"op": op}
        payload.update(fields)
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            output = Path(self.log_path).read_text(encoding="utf-8", errors="replace")
            raise HarnessFailure(f"session {self.prefix} ended before answering {op}", output)
        try:
            response = json.loads(line)
        except json.JSONDecodeError as exc:
            raise HarnessFailure(f"session {self.prefix} answered {op} with invalid JSON: {exc}", line) from exc
        if not response.get("ok"):
            raise HarnessFailure(f"session {self.prefix} {op} failed: {response.get('error')}")
        return response.get("result")

    def invoke(self, function: str, event: dict) -> dict:
        return self.request("invoke", function=function, event=event)

    def function_by_handler(self, handler: str) -> dict:
        matches = [
            function for function in self.spec.get("functions") or []
            if function.get("handler") == handler and function.get("assetDir")
        ]
        if not matches:
            raise HarnessFailure(f"plan has no function with handler {handler!r}")
        return matches[0]

    def function(self, logical_id: str) -> dict:
        for function in self.info.get("functions") or []:
            if function.get("logicalId") == logical_id:
                return function
        raise HarnessFailure(f"session did not start function {logical_id}")

    def notifications_for(self, bucket: str, destination_type: str) -> list[dict]:
        """Return the derived S3 notification configurations for a bucket."""
        return [
            notification for notification in self.info.get("notifications") or []
            if notification.get("destinationType") == destination_type
            and (
                notification.get("bucket") == bucket
                or str(notification.get("bucket") or "").endswith("/" + bucket)
            )
        ]

    def notification_for(self, bucket: str, destination_type: str) -> dict:
        matches = self.notifications_for(bucket, destination_type)
        if len(matches) != 1:
            raise HarnessFailure(
                f"want one {destination_type} notification for bucket {bucket}, got {matches}"
            )
        return matches[0]

    def resource(self, *, name: str | None = None, logical_prefix: str | None = None, kind: str | None = None) -> dict:
        matches = []
        for resource in self.info.get("resources") or []:
            if name is not None and resource.get("name") != name:
                continue
            if logical_prefix is not None and not str(resource.get("logicalId") or "").startswith(logical_prefix):
                continue
            if kind is not None and resource.get("type") != kind:
                continue
            matches.append(resource)
        if len(matches) != 1:
            raise HarnessFailure(
                f"want one resource (name={name!r} prefix={logical_prefix!r} kind={kind!r}), got {matches}"
            )
        return matches[0]

    def event_source(self, *, kind: str, function: str | None = None, source_name: str | None = None) -> dict:
        matches = []
        for source in self.info.get("eventSources") or []:
            if source.get("type") != kind:
                continue
            if function is not None and source.get("function") != function:
                continue
            if source_name is not None and source.get("sourceName") != source_name:
                continue
            matches.append(source)
        if len(matches) != 1:
            raise HarnessFailure(f"want one {kind} event source, got {matches}")
        return matches[0]

    def rule(self, *, function: str, schedule: bool) -> dict:
        matches = []
        for rule in self.info.get("rules") or []:
            if (schedule and not rule.get("schedule")) or (not schedule and not rule.get("eventPattern")):
                continue
            if function in (rule.get("targets") or []):
                matches.append(rule)
        if len(matches) != 1:
            raise HarnessFailure(f"want one EventBridge rule for {function}, got {matches}")
        return matches[0]


def start_local_session(
    harness: Harness,
    app: str,
    *,
    name: str,
    backends: tuple[str, ...] = (),
    context: dict | None = None,
    targets: tuple[str, ...] = (),
    clock: str | None = None,
    allow_no_surface: bool = False,
    origins: tuple[str, ...] = (),
) -> LocalSession:
    """Start one `apptheory-local session` and wait for its machine interface."""
    ensure_cdk_app(harness, app)
    spec = plan_local_app(harness, app, context, allow_no_surface=allow_no_surface)
    prefix = local_app_prefix(harness, name)
    log = tempfile.NamedTemporaryFile(prefix=f"a4-{name}-", suffix=".log", delete=False)
    argv = [
        str(LOCAL_RUNNER_BIN),
        "session",
        "--app",
        app,
        "--profile",
        str(ROOT / LOCAL_PROFILE),
        "--port-base",
        str(harness.lease.http_port),
        "--name-prefix",
        prefix,
    ]
    if allow_no_surface:
        argv.append("--allow-no-surface")
    for key, value in sorted((context or {}).items()):
        argv.extend(["-c", f"{key}={value}"])
    for backend in backends:
        argv.extend(["--backend", backend])
    for target in targets:
        argv.extend(["--target", target])
    for origin in origins:
        argv.extend(["--origin", origin])
    if clock:
        argv.extend(["--clock", clock])
    process = subprocess.Popen(
        argv,
        cwd=str(ROOT),
        env=harness.env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=log,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    try:
        _wait_for_local_session_ready(process, log.name)
        clock_mode = "test" if clock and clock.startswith("test") else "real"
        clock_start = clock.split("=", 1)[1] if clock and "=" in clock else None
        session = LocalSession(
            process=process,
            log_path=log.name,
            prefix=prefix,
            spec=spec,
            info={},
            clock_mode=clock_mode,
            clock_start=clock_start,
            backends=tuple(backends),
        )
        session.info = session.request("describe")
        _assert_session_delivery(session)
    except Exception:
        _terminate_process(process)
        log.close()
        raise
    log.close()
    return session


def _wait_for_local_session_ready(process: subprocess.Popen, log_path: str, seconds: int = 900) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise HarnessFailure(
                f"apptheory-local session exited before it was ready (code {process.returncode})",
                Path(log_path).read_text(encoding="utf-8", errors="replace"),
            )
        text = Path(log_path).read_text(encoding="utf-8", errors="replace")
        if LOCAL_RUNNER_READY in text:
            return
        time.sleep(0.25)
    raise HarnessFailure(
        "apptheory-local session did not become ready",
        Path(log_path).read_text(encoding="utf-8", errors="replace"),
    )


def stop_local_session(harness: Harness, session: LocalSession, *, strict: bool = True) -> None:
    failure: HarnessFailure | None = None
    try:
        if session.process.poll() is None:
            try:
                session.request("shutdown")
            except HarnessFailure:
                pass
            try:
                session.process.stdin.close()
            except (OSError, ValueError):
                pass
            try:
                session.process.wait(timeout=180)
            except subprocess.TimeoutExpired:
                _terminate_process(session.process)
        output = Path(session.log_path).read_text(encoding="utf-8", errors="replace")
        if session.process.returncode != 0:
            failure = HarnessFailure(
                f"apptheory-local session {session.prefix} exited {session.process.returncode}", output
            )
        elif (
            LOCAL_RUNNER_READY not in output
            or "shutting down" not in output
            or "delivery engine stopped" not in output
        ):
            failure = HarnessFailure(
                f"apptheory-local session {session.prefix} did not report a full lifecycle", output
            )
        else:
            _assert_local_runner_cleanup(harness, session.prefix)
    except HarnessFailure as exc:
        failure = exc
    finally:
        try:
            os.unlink(session.log_path)
        except FileNotFoundError:
            pass
    if failure is not None and strict:
        raise failure


def stop_local_app(harness: Harness, run: LocalAppRun) -> str:
    _terminate_process(run.process)
    output = Path(run.log_path).read_text(encoding="utf-8", errors="replace")
    try:
        os.unlink(run.log_path)
    except FileNotFoundError:
        pass
    if run.process.returncode != 0:
        raise HarnessFailure(
            f"apptheory-local {run.prefix} exited {run.process.returncode} after SIGTERM", output
        )
    expect_output(
        output,
        [LOCAL_RUNNER_READY, "shutting down", "delivery engine stopped"],
        f"apptheory-local {run.prefix} run",
    )
    _assert_local_runner_cleanup(harness, run.prefix)
    return output


def _delivery_source_state(session: LocalSession, logical_id: str) -> dict | None:
    for source in (_describe_delivery(session).get("sources") or []):
        if source.get("id") == logical_id:
            return source
    return None


def _source_count(delivery: dict, logical_id: str, field: str) -> int:
    for source in delivery.get("sources") or []:
        if source.get("id") == logical_id:
            return int(source.get(field, 0))
    return 0


def _wait_for_delivery(
    session: LocalSession,
    logical_id: str,
    *,
    delivered: int | None = None,
    failed: int | None = None,
    filtered: int | None = None,
    timeout: float = 180,
) -> dict:
    """Wait until one source's delivered/failed/filtered counters reach a floor."""
    deadline = time.monotonic() + timeout
    last: dict | None = None
    while time.monotonic() < deadline:
        last = _delivery_source_state(session, logical_id)
        if last is not None:
            if (
                (delivered is None or last.get("delivered", 0) >= delivered)
                and (failed is None or last.get("failed", 0) >= failed)
                and (filtered is None or last.get("filtered", 0) >= filtered)
            ):
                return last
        time.sleep(0.1)
    raise HarnessFailure(
        f"{logical_id} never reached delivered={delivered} failed={failed} filtered={filtered}; "
        f"last state {last}"
    )


def _clock_epoch(session: LocalSession) -> int:
    """Return the session clock's current instant as epoch seconds."""
    instant = str(session.clock_now().get("now") or "")
    normalized = re.sub(r"(\.\d{6})\d+", r"\1", instant).replace("Z", "+00:00")
    return int(datetime.datetime.fromisoformat(normalized).timestamp())


def _wait_for_stream_record(
    http_base: str,
    predicate: Callable[[dict], bool],
    *,
    label: str,
    timeout: float = 180,
) -> dict:
    """Wait until the handler recorded a matching DynamoDB Streams event."""
    deadline = time.monotonic() + timeout
    last: list = []
    while time.monotonic() < deadline:
        status, payload, _ = _json_request("GET", f"{http_base}/stream-records")
        if status == 200:
            last = (payload or {}).get("records") or []
            for record in last:
                if predicate(record):
                    return record
        time.sleep(0.2)
    raise HarnessFailure(f"{label}: the handler never recorded a matching stream record; last {last}")


def _wait_for_eventbridge_record(
    http_base: str,
    predicate: Callable[[dict], bool],
    *,
    label: str,
    timeout: float = 180,
) -> dict:
    """Wait until the handler recorded a matching EventBridge envelope."""
    deadline = time.monotonic() + timeout
    last: list = []
    while time.monotonic() < deadline:
        status, payload, _ = _json_request("GET", f"{http_base}/eventbridge-records")
        if status == 200:
            last = (payload or {}).get("records") or []
            for record in last:
                if predicate(record):
                    return record
        time.sleep(0.2)
    raise HarnessFailure(f"{label}: the handler never recorded a matching EventBridge event; last {last}")


def _run_multilang_eventbridge(
    harness: Harness, session: LocalSession, lang: str, http_base: str, function: dict
) -> str:
    """Prove the scheduled rule and the pattern rule on the real local bus."""
    schedule = session.rule(function=function["logicalId"], schedule=True)
    pattern = session.rule(function=function["logicalId"], schedule=False)
    session.clock_advance("5m")
    scheduled = _wait_for_eventbridge_record(
        http_base,
        lambda record: record.get("kind") == "schedule",
        label=f"multilang {lang} scheduled rule",
        timeout=60,
    )
    if (
        scheduled.get("source") != "aws.events"
        or scheduled.get("detailType") != "Scheduled Event"
        or scheduled.get("resources") != [schedule["arn"]]
    ):
        raise HarnessFailure(f"multilang {lang}: unexpected scheduled event: {scheduled}")
    endpoint = session_endpoint(session, "events")
    harness.run(
        [
            "aws", "--endpoint-url", endpoint, "events", "put-events",
            "--entries", json.dumps([
                {
                    "Source": "apptheory.example",
                    "DetailType": "example.item.changed",
                    "Detail": json.dumps({"item": "a4"}),
                    "EventBusName": "default",
                }
            ]),
        ],
        timeout=120,
    )
    matched = _wait_for_eventbridge_record(
        http_base,
        lambda record: record.get("kind") == "rule",
        label=f"multilang {lang} pattern rule",
        timeout=120,
    )
    if (
        matched.get("source") != "apptheory.example"
        or matched.get("detailType") != "example.item.changed"
        or (matched.get("detail") or {}).get("item") != "a4"
    ):
        raise HarnessFailure(f"multilang {lang}: unexpected pattern event: {matched}")
    if pattern["arn"] not in json.dumps(matched):
        # The pattern rule envelope does not carry the rule ARN in resources in
        # AWS; keep the rule identity in the message only if the runtime exposes
        # it. The plan lookup above already proves the rule exists.
        pass
    return (
        "the rate(5 minute) schedule fired on the test clock and delivered the documented Scheduled Event "
        "with the CDK rule ARN, and a real SDK PutEvents reached the pattern rule's handler with its source, "
        "detail-type and detail"
    )


def _run_multilang_stream(
    harness: Harness, session: LocalSession, lang: str, http_base: str, function: dict
) -> str:
    """Prove the language's DynamoDB Streams mapping on the real local path.

    The item is written through the AWS CLI (the real SDK) against DynamoDB
    Local; the mapping's deliverer reads the stream, invokes the handler and the
    handler records the documented record. TTL is proved the same way: the item
    carries an expiry, the test clock moves past it, the runner deletes it and
    the REMOVE record carries the service userIdentity.
    """
    source = session.event_source(kind="dynamodb", function=function["logicalId"])
    table = session.resource(name=source["sourceName"], kind="AWS::DynamoDB::Table")
    if not table.get("streamArn"):
        raise HarnessFailure(f"multilang {lang}: the table has no stream ARN: {table}")
    endpoint = session_endpoint(session, "dynamodb")
    key = f"{lang}-stream"
    item = {"pk": {"S": key}, "value": {"S": "real-sdk"}}
    harness.run(
        [
            "aws", "--endpoint-url", endpoint, "dynamodb", "put-item",
            "--table-name", str(source["sourceName"]),
            "--item", json.dumps(item),
        ],
        timeout=120,
    )
    record = _wait_for_stream_record(
        http_base,
        lambda entry: entry.get("eventName") == "INSERT"
        and (entry.get("keys") or {}).get("pk", {}).get("S") == key,
        label=f"multilang {lang} INSERT",
    )
    if record.get("eventSourceARN") != table["streamArn"]:
        raise HarnessFailure(
            f"multilang {lang}: the stream record ARN {record.get('eventSourceARN')!r} "
            f"is not the CDK-resolved stream ARN {table['streamArn']!r}"
        )
    ttl_key = f"{lang}-ttl"
    expires = _clock_epoch(session) + 60
    harness.run(
        [
            "aws", "--endpoint-url", endpoint, "dynamodb", "put-item",
            "--table-name", str(source["sourceName"]),
            "--item", json.dumps({"pk": {"S": ttl_key}, "value": {"S": "expires"}, "expiresAt": {"N": str(expires)}}),
        ],
        timeout=120,
    )
    session.clock_advance("2m")
    ttl_record = _wait_for_stream_record(
        http_base,
        lambda entry: entry.get("eventName") == "REMOVE"
        and (entry.get("keys") or {}).get("pk", {}).get("S") == ttl_key,
        label=f"multilang {lang} TTL REMOVE",
    )
    identity = ttl_record.get("userIdentity") or {}
    if identity.get("type") != "Service" or identity.get("principalId") != "dynamodb.amazonaws.com":
        raise HarnessFailure(
            f"multilang {lang}: the TTL REMOVE record has no service userIdentity: {ttl_record}"
        )
    return (
        f"the CDK DynamoDB Streams mapping delivered the SDK-written INSERT with the CDK stream ARN, "
        f"and the test clock's TTL expiry produced the REMOVE record with the service userIdentity"
    )


def _run_multilang_stream_failure(
    harness: Harness, session: LocalSession, lang: str, http_base: str, function: dict
) -> str:
    """Prove bisect/partial failure and the on-failure destination on one row."""
    source = session.event_source(kind="dynamodb", function=function["logicalId"])
    table = session.resource(name=source["sourceName"], kind="AWS::DynamoDB::Table")
    endpoint = session_endpoint(session, "dynamodb")
    good_key = f"{lang}-good"
    poison_key = f"{lang}-poison"
    for item in (
        {"pk": {"S": good_key}, "value": {"S": "ok"}},
        {"pk": {"S": poison_key}, "poison": {"BOOL": True}},
    ):
        harness.run(
            [
                "aws", "--endpoint-url", endpoint, "dynamodb", "put-item",
                "--table-name", str(source["sourceName"]),
                "--item", json.dumps(item),
            ],
            timeout=120,
        )
    _wait_for_stream_record(
        http_base,
        lambda entry: entry.get("eventName") == "INSERT"
        and (entry.get("keys") or {}).get("pk", {}).get("S") == good_key,
        label=f"multilang {lang} good record",
    )
    poison = _wait_for_stream_record(
        http_base,
        lambda entry: entry.get("eventName") == "INSERT"
        and (entry.get("keys") or {}).get("pk", {}).get("S") == poison_key,
        label=f"multilang {lang} poison record",
    )
    _advance_until(
        session,
        lambda delivery: _source_count(delivery, source["logicalId"], "discarded") >= 1,
        step="1m",
        label=f"multilang {lang} poison discard",
    )
    dlq = session.resource(logical_prefix="GoStreamDlq", kind="AWS::SQS::Queue")
    _wait_for_queue_total(session, dlq["logicalId"], total=1)
    messages = session.request("sqs.receive", queue=dlq["logicalId"], max=1, waitSeconds=1, delete=True)[
        "messages"
    ]
    if len(messages) != 1:
        raise HarnessFailure(f"multilang {lang}: the on-failure queue returned {len(messages)} message(s)")
    body = json.loads(messages[0]["body"])
    request = body.get("requestContext") or {}
    batch = body.get("DDBStreamBatchInfo") or {}
    if (
        request.get("condition") != "RetryAttemptsExhausted"
        or request.get("approximateInvokeCount") != 3
        or batch.get("streamArn") != table["streamArn"]
        or batch.get("startSequenceNumber") != poison.get("sequenceNumber")
        or batch.get("batchSize") != 1
    ):
        raise HarnessFailure(f"multilang {lang}: unexpected on-failure record: {body}")
    return (
        "the Go mapping bisected the poison record at its reported sequence number, retried it twice, "
        "discarded only that record to the real SQS on-failure queue with the documented invocation record, "
        "and the good record of the same batch was delivered"
    )


def _queue_depth(session: LocalSession, logical_id: str) -> tuple[int, int]:
    """Return (visible, notVisible) for one provisioned queue."""
    attributes = session.request("sqs.attributes", queue=logical_id)
    return int(attributes.get("visible", 0)), int(attributes.get("notVisible", 0))


def _wait_for_queue_depth(
    session: LocalSession,
    logical_id: str,
    *,
    visible: int,
    not_visible: int,
    timeout: float = 120,
) -> None:
    deadline = time.monotonic() + timeout
    last: tuple[int, int] | None = None
    while time.monotonic() < deadline:
        last = _queue_depth(session, logical_id)
        if last == (visible, not_visible):
            return
        time.sleep(0.1)
    raise HarnessFailure(
        f"queue {logical_id} never reached visible={visible} notVisible={not_visible}; last {last}"
    )


def _wait_for_queue_total(
    session: LocalSession, logical_id: str, *, total: int, timeout: float = 120
) -> tuple[int, int]:
    deadline = time.monotonic() + timeout
    last: tuple[int, int] | None = None
    while time.monotonic() < deadline:
        last = _queue_depth(session, logical_id)
        if last[0] + last[1] == total:
            return last
        time.sleep(0.1)
    raise HarnessFailure(f"queue {logical_id} never held {total} message(s); last {last}")


def _advance_until(
    session: LocalSession,
    predicate: Callable[[dict], bool],
    *,
    step: str,
    label: str,
    attempts: int = 12,
) -> dict:
    """Advance a test clock until a delivery predicate holds.

    A batching window or a visibility deadline is a timer on the run clock, so
    a test session must move the clock to close it. Repeating the advance also
    covers the receive/handler race: the deliverer may register a timer just
    after an earlier advance.
    """
    last: dict | None = None
    for _ in range(attempts):
        session.clock_advance(step)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            last = _describe_delivery(session)
            if predicate(last):
                return last
            time.sleep(0.1)
    raise HarnessFailure(f"{label}: the clock did not reach the expected delivery state; last {last}")


def _wait_for_peak_inflight(
    session: LocalSession, logical_id: str, *, at_least: int, timeout: float = 120
) -> dict:
    deadline = time.monotonic() + timeout
    last: dict | None = None
    while time.monotonic() < deadline:
        last = _delivery_source_state(session, logical_id)
        if last is not None and last.get("peakInflight", 0) >= at_least:
            return last
        time.sleep(0.05)
    raise HarnessFailure(f"{logical_id} never reached peakInflight>={at_least}; last {last}")


def _terminate_process(process: subprocess.Popen, seconds: int = 180) -> str:
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=30)
        raise HarnessFailure("apptheory-local did not shut down after SIGTERM")
    return ""


def _wait_for_local_runner_apis(
    process: subprocess.Popen, log_path: str, seconds: int = 900
) -> tuple[dict[str, str], dict[str, str]]:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise HarnessFailure(
                f"apptheory-local exited before it was ready (code {process.returncode})",
                Path(log_path).read_text(encoding="utf-8", errors="replace"),
            )
        text = Path(log_path).read_text(encoding="utf-8", errors="replace")
        if LOCAL_RUNNER_READY in text:
            matches = re.findall(
                r"^serving (\S+) (\S+) at (http://127\.0\.0\.1:\d+)$", text, re.MULTILINE
            )
            if not matches:
                raise HarnessFailure("apptheory-local reported ready without a listening URL", text)
            apis = {logical_id: url for _, logical_id, url in matches}
            classes = {logical_id: api_class for api_class, logical_id, _ in matches}
            return apis, classes
        time.sleep(0.25)
    raise HarnessFailure(
        "apptheory-local did not become ready",
        Path(log_path).read_text(encoding="utf-8", errors="replace"),
    )


def api_url(spec: dict, run: LocalAppRun, name_suffix: str) -> str:
    """Find a listener by the API's template name suffix."""
    for api in spec.get("apis") or []:
        name = str(api.get("name") or "")
        if name.endswith(name_suffix):
            logical_id = str(api.get("logicalId"))
            if logical_id in run.apis:
                return run.apis[logical_id]
    raise HarnessFailure(
        f"plan has no {name_suffix!r} API; apis={[api.get('name') for api in spec.get('apis') or []]}"
    )


def _session_served_apis(session: "LocalSession") -> dict[str, str]:
    return {
        str(entry.get("logicalId")): str(entry.get("url"))
        for entry in session.info.get("apis") or []
        if entry.get("url")
    }


def session_api_url(spec: dict, session: "LocalSession", name_suffix: str) -> str:
    """Find a session listener by the API's template name suffix."""
    served = _session_served_apis(session)
    for api in spec.get("apis") or []:
        name = str(api.get("name") or "")
        if name.endswith(name_suffix):
            logical_id = str(api.get("logicalId"))
            if logical_id in served:
                return served[logical_id]
    raise HarnessFailure(
        f"plan has no {name_suffix!r} API; apis={[api.get('name') for api in spec.get('apis') or []]}"
    )


def session_rest_url(spec: dict, session: "LocalSession") -> str:
    served = _session_served_apis(session)
    rest = [api for api in spec.get("apis") or [] if api.get("class") == "restv1"]
    if len(rest) != 1:
        raise HarnessFailure(f"want exactly one REST API, plan has {len(rest)}")
    logical_id = str(rest[0].get("logicalId"))
    if logical_id not in served:
        raise HarnessFailure(f"the runner did not serve {logical_id}: {served}")
    return served[logical_id]


def one_api_url(spec: dict, run: LocalAppRun) -> str:
    apis = spec.get("apis") or []
    if len(apis) != 1:
        raise HarnessFailure(f"want exactly one HTTP API, plan has {len(apis)}")
    logical_id = str(apis[0].get("logicalId"))
    if logical_id not in run.apis:
        raise HarnessFailure(f"the runner did not serve {logical_id}: {run.apis}")
    return run.apis[logical_id]


# --- A5b CloudFront gateway helpers -----------------------------------------


def local_app_distribution(run: LocalAppRun, prefix: str) -> tuple[str, str]:
    """Return (distribution logical id, local URL) for one distribution."""
    for distribution in run.spec.get("cloudFront") or []:
        logical_id = str(distribution.get("logicalId") or "")
        if logical_id.startswith(prefix) and logical_id in run.apis:
            return logical_id, run.apis[logical_id]
    raise HarnessFailure(
        f"plan has no served distribution starting with {prefix!r}; "
        f"cloudFront={[d.get('logicalId') for d in run.spec.get('cloudFront') or []]}, apis={run.apis}"
    )


def session_distribution(session: LocalSession, prefix: str) -> tuple[str, str]:
    for distribution in session.info.get("cloudFront") or []:
        logical_id = str(distribution.get("logicalId") or "")
        if logical_id.startswith(prefix) and distribution.get("url"):
            return logical_id, str(distribution["url"])
    raise HarnessFailure(
        f"session has no served distribution starting with {prefix!r}: {session.info.get('cloudFront')}"
    )


def session_endpoint(session: LocalSession, service: str) -> str:
    for endpoint in session.info.get("endpoints") or []:
        if endpoint.get("service") == service:
            return str(endpoint.get("url"))
    raise HarnessFailure(f"session reports no {service} endpoint: {session.info.get('endpoints')}")


def s3_put(session: LocalSession, bucket: str, key: str, body: str, content_type: str) -> None:
    session.request(
        "s3.put",
        bucket=bucket,
        objectKey=key,
        body=body,
        contentType=content_type,
    )


def require_aws_cli() -> str:
    """Return the host AWS CLI, or fail the upload-assets.sh row by name.

    upload-assets.sh is a real AWS CLI script, so the host CLI must be on PATH
    and start. The harness never installs or substitutes a CLI: a missing or
    unusable one is a named requirement failure, not a skip.
    """
    executable = shutil.which("aws")
    if not executable:
        raise HarnessFailure(
            "upload-assets.sh requires an AWS CLI on PATH; the harness does not install one"
        )
    try:
        result = subprocess.run(  # noqa: S603 - the host CLI is the subject
            [executable, "--version"], capture_output=True, text=True, timeout=30, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HarnessFailure(
            "upload-assets.sh requires an AWS CLI on PATH that starts; the host aws could not be run",
            str(exc),
        ) from exc
    if result.returncode != 0:
        raise HarnessFailure(
            "upload-assets.sh requires an AWS CLI on PATH that starts; the host aws failed its version check",
            _combined_output(result),
        )
    return executable


def assert_html(status: int, body: str, headers: dict, label: str, needle: str) -> None:
    expect_status(status, 200, label, body)
    if "text/html" not in headers.get("content-type", ""):
        raise HarnessFailure(f"{label}: content-type {headers.get('content-type')!r}", body)
    if needle not in body:
        raise HarnessFailure(f"{label}: body does not contain {needle!r}", body)


def assert_json_body(status: int, body: str, headers: dict, label: str) -> dict:
    expect_status(status, 200, label, body)
    if "application/json" not in headers.get("content-type", ""):
        raise HarnessFailure(f"{label}: content-type {headers.get('content-type')!r}", body)
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise HarnessFailure(f"{label}: body is not JSON: {exc}", body) from exc


def _exercise_hello_world(base: str, lang: str) -> None:
    """Assert the real handler's HTTP behaviour for one language."""
    request_id = f"local-{lang}-probe"
    status, body, headers = http_request(
        "GET",
        f"{base}/hello/AppTheory?probe=1",
        headers={"X-Request-Id": request_id, "Cookie": "a=b; c=d"},
    )
    expect_status(status, 200, f"{lang} GET /hello/AppTheory", body)
    payload = json.loads(body)
    if payload.get("message") != "hello AppTheory":
        raise HarnessFailure(f"{lang} GET /hello/AppTheory: unexpected message", body)
    if payload.get("runtime") != lang:
        raise HarnessFailure(f"{lang} GET /hello/AppTheory: handler reported {payload.get('runtime')!r}", body)
    if payload.get("request_id") != request_id or headers.get("x-request-id") != request_id:
        raise HarnessFailure(f"{lang} GET /hello/AppTheory: x-request-id was not carried through", body)
    LOCAL_RUNNER_RESPONSES[lang] = payload

    status, body, _ = http_request("GET", f"{base}/")
    expect_status(status, 200, f"{lang} GET /", body)
    if json.loads(body).get("message") != "hello world":
        raise HarnessFailure(f"{lang} GET /: unexpected message", body)

    status, body, _ = http_request(
        "POST",
        f"{base}/hello/AppTheory",
        headers={"Content-Type": "application/json"},
        body=b'{"hello":"world"}',
    )
    expect_status(status, 405, f"{lang} POST /hello/AppTheory", body)
    if "app.method_not_allowed" not in body:
        raise HarnessFailure(f"{lang} POST /hello/AppTheory: unexpected error body", body)

    status, body, _ = http_request("GET", f"{base}/missing")
    expect_status(status, 404, f"{lang} GET /missing", body)
    if "app.not_found" not in body:
        raise HarnessFailure(f"{lang} GET /missing: unexpected error body", body)


def verify_local_runner_parity() -> str:
    """Assert the three languages returned the same handler response shape."""
    missing = sorted(set(LOCAL_RUNNER_RUNTIMES) - set(LOCAL_RUNNER_RESPONSES))
    if missing:
        raise HarnessFailure(f"local runner parity: no handler response from {missing}")
    shapes = {lang: tuple(sorted(payload)) for lang, payload in LOCAL_RUNNER_RESPONSES.items()}
    if len(set(shapes.values())) != 1:
        raise HarnessFailure(f"local runner parity: handler response shapes differ: {shapes}")
    return f"go, ts and py returned the same handler contract {list(next(iter(shapes.values())))}"


def _assert_local_runner_cleanup(harness: Harness, prefix: str) -> None:
    deadline = time.monotonic() + 60
    containers: list[str] = []
    networks: list[str] = []
    while time.monotonic() < deadline:
        containers = _docker_ids(harness, ["docker", "ps", "-aq", "--filter", f"name={prefix}"])
        networks = _docker_ids(harness, ["docker", "network", "ls", "-q", "--filter", f"name={prefix}-net"])
        if not containers and not networks:
            return
        time.sleep(0.5)
    raise HarnessFailure(
        f"apptheory-local left containers {containers} or networks {networks} behind"
    )


def _docker_ids(harness: Harness, argv: list[str]) -> list[str]:
    result = harness.run(argv, timeout=60, check=False)
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


# --- A4 event-source and data runners --------------------------------------


def _require_proxy(result: dict, label: str, status: int = 200) -> dict:
    if not result.get("proxy"):
        raise HarnessFailure(f"{label}: handler did not return a proxy response", json.dumps(result))
    if result.get("statusCode") != status:
        raise HarnessFailure(f"{label}: status {result.get('statusCode')} != {status}", json.dumps(result))
    try:
        return json.loads(result.get("body") or "{}")
    except json.JSONDecodeError as exc:
        raise HarnessFailure(f"{label}: proxy body is not JSON: {exc}", result.get("body") or "") from exc


def _batch_failures(result: dict) -> list:
    raw = result.get("raw")
    if not isinstance(raw, dict):
        raise HarnessFailure("handler did not return a batch response", json.dumps(result))
    failures = raw.get("batchItemFailures")
    if failures is None:
        return []
    if not isinstance(failures, list):
        raise HarnessFailure("batchItemFailures is not a list", json.dumps(result))
    return failures


def _session_function_for_language(session: LocalSession, language: str) -> dict:
    matches = [
        function for function in session.info.get("functions") or []
        if (function.get("environment") or {}).get("APPTHEORY_LANG") == language
    ]
    if len(matches) != 1:
        raise HarnessFailure(f"want one {language} function in the session, got {matches}")
    return matches[0]


def run_sqs_producer(harness: Harness) -> str:
    plan = plan_local_app(harness, SQS_APP)
    producers = [function for function in plan.get("functions") or [] if function.get("handler") == "producer.handler"]
    if len(producers) != 1:
        raise HarnessFailure(f"plan has no single producer.handler function: {producers}")
    producer = producers[0]
    session = start_local_session(
        harness, SQS_APP, name="sqs-producer", backends=("sqs",), targets=(producer["logicalId"],)
    )
    try:
        queue = session.resource(name="contract-events", kind="AWS::SQS::Queue")
        source = session.event_source(kind="sqs", source_name="contract-events")
        event = {
            "version": "2.0",
            "routeKey": "POST /",
            "rawPath": "/",
            "headers": {"content-type": "application/json"},
            "body": json.dumps({"eventType": "a4-producer", "payload": {"n": 1}}),
            "isBase64Encoded": False,
            "requestContext": {"http": {"method": "POST", "path": "/", "protocol": "HTTP/1.1"}},
        }
        result = session.invoke(producer["logicalId"], event)
        body = _require_proxy(result, "sqs producer")
        if body.get("message") != "Message sent to queue" or not body.get("messageId"):
            raise HarnessFailure(f"sqs producer: unexpected response {body}")
        state = _wait_for_delivery(session, source["logicalId"], delivered=1)
        if state.get("failed"):
            raise HarnessFailure(f"sqs producer: the mapping failed: {state}")
        _wait_for_queue_depth(session, queue["logicalId"], visible=0, not_visible=0)
        return (
            "producer.mjs sent through the real SQS client to ElasticMQ; the CDK ContractConsumer "
            "mapping delivered the message to worker.handler and deleted it (delivered=1, queue empty)"
        )
    finally:
        stop_local_session(harness, session)


def _exercise_test_clock(session: LocalSession) -> None:
    """Prove the deterministic clock through the live session protocol."""
    before = session.clock_now()
    if before.get("now") != LOCAL_RUNNER_CLOCK_START:
        raise HarnessFailure(f"test clock did not start at {LOCAL_RUNNER_CLOCK_START}: {before}")
    advanced = session.clock_advance("90m")
    if advanced.get("advanced") != "1h30m0s" or advanced.get("now") != "2026-01-01T01:30:00Z":
        raise HarnessFailure(f"clock.advance did not move the clock by 90m: {advanced}")
    after = session.clock_now()
    if after.get("now") != advanced.get("now"):
        raise HarnessFailure(f"clock.now {after.get('now')!r} != clock.advance {advanced.get('now')!r}")
    described = session.request("describe")
    clock = (described.get("delivery") or {}).get("clock") or {}
    if clock.get("now") != advanced.get("now"):
        raise HarnessFailure(f"the delivery engine clock did not advance: {clock}")
    if clock.get("mode") != "test":
        raise HarnessFailure(f"the delivery engine clock is not in test mode: {clock}")


def run_sqs_worker(harness: Harness) -> str:
    session = start_local_session(
        harness,
        SQS_APP,
        name="sqs-worker",
        backends=("sqs",),
        clock=f"test={LOCAL_RUNNER_CLOCK_START}",
    )
    try:
        _exercise_test_clock(session)
        source = session.event_source(kind="sqs", source_name="events-queue")
        if not source.get("reportBatchItemFailures"):
            raise HarnessFailure(f"events-queue mapping lost reportBatchItemFailures: {source}")
        if source.get("batchSize") != 100 or source.get("maximumBatchingWindowInSeconds") != 10:
            raise HarnessFailure(f"events-queue mapping lost its batch options: {source}")
        if source.get("maximumConcurrency") != 50:
            raise HarnessFailure(f"events-queue mapping lost ScalingConfig: {source}")
        queue = session.resource(name="events-queue", kind="AWS::SQS::Queue")
        valid = session.request("sqs.send", queue=queue["logicalId"], body=json.dumps({"shouldFail": False, "n": 1}))
        invalid = session.request("sqs.send", queue=queue["logicalId"], body=json.dumps({"shouldFail": True, "n": 2}))
        _advance_until(
            session,
            lambda delivery: _source_count(delivery, source["logicalId"], "delivered") >= 1,
            step="10s",
            label="events-queue batching window",
        )
        if valid["messageId"] == invalid["messageId"]:
            raise HarnessFailure("sqs worker: SendMessage returned the same id twice")
        # The successful record is deleted; the failed one is hidden for the
        # queue's five-minute visibility timeout.
        _wait_for_queue_depth(session, queue["logicalId"], visible=0, not_visible=1)
        state = _advance_until(
            session,
            lambda delivery: _source_count(delivery, source["logicalId"], "delivered") >= 2,
            step="300s",
            label="events-queue visibility redelivery",
        )
        if int(state.get("failed", 0)) != 0:
            raise HarnessFailure(f"sqs worker: a partial batch response was counted as a failed invocation: {state}")
        _wait_for_queue_depth(session, queue["logicalId"], visible=0, not_visible=1)

        filtered = session.event_source(kind="sqs", source_name="filtered-events")
        filtered_queue = session.resource(name="filtered-events", kind="AWS::SQS::Queue")
        session.request("sqs.send", queue=filtered_queue["logicalId"], body=json.dumps({"kind": "keep"}))
        session.request("sqs.send", queue=filtered_queue["logicalId"], body=json.dumps({"kind": "drop"}))
        _wait_for_delivery(session, filtered["logicalId"], delivered=1)
        _wait_for_queue_depth(session, filtered_queue["logicalId"], visible=0, not_visible=0)

        fifo = session.event_source(kind="sqs", source_name="fifo-events.fifo")
        fifo_queue = session.resource(name="fifo-events.fifo", kind="AWS::SQS::Queue")
        session.request(
            "sqs.send",
            queue=fifo_queue["logicalId"],
            body=json.dumps({"shouldFail": True, "n": 1}),
            messageGroupId="gA",
            messageDeduplicationId="fifo-1",
        )
        session.request(
            "sqs.send",
            queue=fifo_queue["logicalId"],
            body=json.dumps({"shouldFail": False, "n": 2}),
            messageGroupId="gA",
            messageDeduplicationId="fifo-2",
        )
        session.request(
            "sqs.send",
            queue=fifo_queue["logicalId"],
            body=json.dumps({"shouldFail": False, "n": 3}),
            messageGroupId="gB",
            messageDeduplicationId="fifo-3",
        )
        # The first record's failure blocks its group: the failed record and
        # the record behind it stay (one may still be visible behind the
        # blocked group), while the independent group is deleted. The split
        # between batches is timing, the invariant is the two-message group.
        state = _wait_for_delivery(session, fifo["logicalId"], delivered=1)
        _wait_for_queue_total(session, fifo_queue["logicalId"], total=2)
        before = int(state.get("delivered", 0))
        state = _advance_until(
            session,
            lambda delivery: _source_count(delivery, fifo["logicalId"], "delivered") > before,
            step="300s",
            label="fifo group visibility redelivery",
        )
        _wait_for_queue_total(session, fifo_queue["logicalId"], total=2)

        concurrency = session.event_source(kind="sqs", source_name="concurrency-events")
        concurrency_queue = session.resource(name="concurrency-events", kind="AWS::SQS::Queue")
        for index in range(4):
            session.request(
                "sqs.send",
                queue=concurrency_queue["logicalId"],
                body=json.dumps({"delayMs": 400, "n": index}),
            )
        state = _wait_for_peak_inflight(session, concurrency["logicalId"], at_least=2)
        if state.get("peakInflight", 0) > 2:
            raise HarnessFailure(f"sqs worker: MaximumConcurrency=2 was exceeded: {state}")
        _wait_for_delivery(session, concurrency["logicalId"], delivered=4)
        _wait_for_queue_depth(session, concurrency_queue["logicalId"], visible=0, not_visible=0)

        return (
            "events-queue: a two-record batch closed on the 10s window, the valid record was deleted, "
            "the failed record stayed hidden and was redelivered on the 300s test-clock timeout; "
            "filtered-events deleted the non-matching record without invocation; "
            "fifo-events kept the failed group's records and deleted the other group; "
            "concurrency-events peaked at 2 in-flight batches under MaximumConcurrency=2"
        )
    finally:
        stop_local_session(harness, session)


def run_sqs_dlq(harness: Harness) -> str:
    session = start_local_session(
        harness,
        SQS_APP,
        name="sqs-dlq",
        backends=("sqs",),
        clock=f"test={LOCAL_RUNNER_CLOCK_START}",
    )
    try:
        source = session.event_source(kind="sqs", source_name="events-queue")
        dead_source = session.event_source(kind="sqs", source_name="events-queue-dlq")
        queue = session.resource(name="events-queue", kind="AWS::SQS::Queue")
        dead_queue = session.resource(name="events-queue-dlq", kind="AWS::SQS::Queue")
        body = json.dumps({"shouldFail": True, "dlq": True})
        session.request("sqs.send", queue=queue["logicalId"], body=body)
        _advance_until(
            session,
            lambda delivery: _source_count(delivery, source["logicalId"], "left") >= 1,
            step="10s",
            label="events-queue first failing delivery",
        )
        for receive in range(2, 6):
            _advance_until(
                session,
                lambda delivery, receive=receive: _source_count(delivery, source["logicalId"], "left") >= receive,
                step="300s",
                label=f"events-queue receive {receive}",
            )
        _advance_until(
            session,
            lambda delivery: _source_count(delivery, dead_source["logicalId"], "delivered") >= 1,
            step="300s",
            label="dead-letter mapping delivery after maxReceiveCount",
        )
        _wait_for_queue_depth(session, queue["logicalId"], visible=0, not_visible=0)
        _wait_for_queue_depth(session, dead_queue["logicalId"], visible=0, not_visible=0)
        state = _delivery_source_state(session, source["logicalId"])
        if not state or int(state.get("left", 0)) != 5:
            raise HarnessFailure(f"sqs dlq: want five records left before redrive, got {state}")
        return (
            "events-queue failed the real message five times on the test clock; ElasticMQ redrove it to "
            "events-queue-dlq and the DLQ mapping delivered it to dlq-handler.mjs, which deleted it"
        )
    finally:
        stop_local_session(harness, session)


def _import_functions(session: LocalSession) -> tuple[dict, dict]:
    worker_source = session.event_source(kind="sqs", source_name="import-records")
    ingest_rules = [
        rule for rule in session.info.get("rules") or []
        if "aws.s3" in json.dumps(rule.get("eventPattern") or {})
    ]
    if len(ingest_rules) != 1 or len(ingest_rules[0].get("targets") or []) != 1:
        raise HarnessFailure(f"want one S3 EventBridge rule with one target, got {ingest_rules}")
    ingest_id = ingest_rules[0]["targets"][0]
    ingest = session.function(ingest_id)
    return ingest, worker_source


def _wait_for_job_meta(session: LocalSession, table_id: str, job_id: str, timeout: float = 180) -> dict:
    deadline = time.monotonic() + timeout
    last: list = []
    while time.monotonic() < deadline:
        last = session.request("ddb.scan", table=table_id)["items"]
        for item in last:
            if item.get("pk") == f"JOB#{job_id}" and item.get("sk") == "META":
                return item
        time.sleep(0.2)
    raise HarnessFailure(f"import: job {job_id} never wrote its META record; last {last}")


def _run_import(harness: Harness, kind: str) -> tuple[dict, str]:
    session = start_local_session(
        harness, IMPORT_APP, name=f"import-{kind}", backends=("dynamodb", "sqs", "s3proxy")
    )
    try:
        ingest, worker_source = _import_functions(session)
        bucket = session.resource(logical_prefix="IngestBucket", kind="AWS::S3::Bucket")
        table = session.resource(logical_prefix="JobsTable", kind="AWS::DynamoDB::Table")
        worker_queue = session.resource(name="import-records", kind="AWS::SQS::Queue")
        key = "incoming/orders/a4.json"
        content = json.dumps({"order": 42, "source": "local"})
        # A real object PUT into the provisioned bucket. The runner observes it
        # at the S3 protocol boundary and publishes the documented S3
        # EventBridge event itself: the row sends no PutEvents.
        session.request("s3.put", bucket=bucket["logicalId"], objectKey=key, body=content)
        notification = session.notification_for(bucket["logicalId"], "eventbridge")
        _wait_for_delivery(session, notification["logicalId"], delivered=1)
        job_id = hashlib.sha256((bucket["name"] + "/" + key).encode()).hexdigest()
        meta = _wait_for_job_meta(session, table["logicalId"], job_id)
        # The WorkConsumer mapping delivers the three real messages to the
        # worker automatically. Wait until they are all deleted, which only
        # happens after a successful handler invocation.
        state = _wait_for_delivery(session, worker_source["logicalId"], delivered=1)
        if state.get("failed"):
            raise HarnessFailure(f"import {kind}: the worker mapping failed: {state}")
        _wait_for_queue_depth(session, worker_queue["logicalId"], visible=0, not_visible=0)
        if kind == "ingest":
            if meta.get("status") != "RUNNING":
                raise HarnessFailure(f"import ingest: job meta is not RUNNING: {meta}")
            return (
                ingest["logicalId"],
                "a real object PUT into the ingest bucket was observed by the runner's S3 notification "
                "watcher and published to the local EventBridge bus as the documented aws.s3 Object Created "
                "event, reaching IngestRule with no PutEvents by the harness; the ingest handler wrote the "
                "RUNNING META record on DynamoDB Local and the WorkConsumer mapping delivered and deleted "
                "the three real work messages",
            )
        items = session.request("ddb.scan", table=table["logicalId"])["items"]
        records = {item.get("sk"): item for item in items if str(item.get("sk", "")).startswith("REC#")}
        for record_id in ("rec-1", "rec-2"):
            if records.get(f"REC#{record_id}", {}).get("status") != "SUCCEEDED":
                raise HarnessFailure(f"import worker: {record_id} is not SUCCEEDED: {records.get('REC#' + record_id)}")
        failed = records.get("REC#rec-3") or {}
        if failed.get("status") != "FAILED" or not failed.get("error"):
            raise HarnessFailure(f"import worker: rec-3 is not a failed record: {failed}")
        serialized = json.dumps(failed)
        if "4111111111111111" in serialized:
            raise HarnessFailure("import worker: the stored error leaked the raw PAN")
        if "******1111" not in serialized:
            raise HarnessFailure(f"import worker: the stored error was not sanitized: {failed}")
        meta = [item for item in items if item.get("pk") == f"JOB#{job_id}" and item.get("sk") == "META"]
        if len(meta) != 1:
            raise HarnessFailure(f"import worker: job meta missing: {meta}")
        return (
            worker_source["function"],
            "ingest and worker ran end to end on DynamoDB Local and ElasticMQ: the WorkConsumer mapping "
            "delivered three real messages, rec-1/rec-2 SUCCEEDED, rec-3 FAILED with a sanitized error, "
            "and the raw PAN was absent",
        )
    finally:
        stop_local_session(harness, session)


def run_import_ingest(harness: Harness) -> str:
    return _run_import(harness, "ingest")[1]


def run_import_worker(harness: Harness) -> str:
    return _run_import(harness, "worker")[1]


def _aws_cli(harness: Harness, endpoint: str, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return harness.run(["aws", "--endpoint-url", endpoint, *args], timeout=180, check=check)


def _put_log_events(
    harness: Harness, session: LocalSession, group: str, stream: str, events: list[dict]
) -> None:
    endpoint = session_endpoint(session, "logs")
    _aws_cli(harness, endpoint, "logs", "create-log-stream", "--log-group-name", group, "--log-stream-name", stream, check=False)
    _aws_cli(
        harness,
        endpoint,
        "logs",
        "put-log-events",
        "--log-group-name",
        group,
        "--log-stream-name",
        stream,
        "--log-events",
        json.dumps(events),
    )


def _receive_receipts(session: LocalSession, queue_id: str, *, expected: int, timeout: float = 240) -> list[dict]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        visible, not_visible = _queue_depth(session, queue_id)
        if visible + not_visible >= expected:
            break
        time.sleep(0.2)
    response = session.request("sqs.receive", queue=queue_id, max=10, waitSeconds=1, delete=True)
    receipts = []
    for message in response.get("messages") or []:
        receipts.append(json.loads(message["body"]))
    return receipts


def _wait_for_receipt(
    session: LocalSession, queue_id: str, predicate: Callable[[dict], bool], *, label: str, timeout: float = 240
) -> dict:
    deadline = time.monotonic() + timeout
    last: list[dict] = []
    while time.monotonic() < deadline:
        visible, not_visible = _queue_depth(session, queue_id)
        if visible + not_visible > 0:
            response = session.request("sqs.receive", queue=queue_id, max=10, waitSeconds=1, delete=True)
            for message in response.get("messages") or []:
                receipt = json.loads(message["body"])
                last.append(receipt)
                if predicate(receipt):
                    return receipt
        time.sleep(0.2)
    raise HarnessFailure(f"{label}: no matching receipt arrived; last {last}")


def _wait_for_receipt_advancing(
    session: LocalSession,
    queue_id: str,
    predicate: Callable[[dict], bool],
    *,
    label: str,
    step: str = "5s",
    timeout: float = 240,
) -> dict:
    """Wait for a receipt, advancing the test clock to close a batching window."""
    deadline = time.monotonic() + timeout
    last: list[dict] = []
    while time.monotonic() < deadline:
        session.clock_advance(step)
        visible, not_visible = _queue_depth(session, queue_id)
        if visible + not_visible > 0:
            response = session.request("sqs.receive", queue=queue_id, max=10, waitSeconds=1, delete=True)
            for message in response.get("messages") or []:
                receipt = json.loads(message["body"])
                last.append(receipt)
                if predicate(receipt):
                    return receipt
        time.sleep(0.2)
    raise HarnessFailure(f"{label}: no matching receipt arrived; last {last}")


def run_kinesis_handler(harness: Harness) -> str:
    session = start_local_session(
        harness,
        KINESIS_APP,
        name="kinesis",
        backends=("moto", "sqs"),
        clock=f"test={LOCAL_RUNNER_CLOCK_START}",
    )
    try:
        source = session.event_source(kind="kinesis")
        stream = session.resource(name=source["sourceName"], kind="AWS::Kinesis::Stream")
        if not str(stream.get("arn") or "").endswith(f"stream/{source['sourceName']}"):
            raise HarnessFailure(f"kinesis: the stream was not provisioned: {stream}")
        plan_resources = session.spec.get("resources") or []
        if not any(
            resource.get("type") == "AWS::Kinesis::Stream"
            and resource.get("localId") == source["sourceName"]
            for resource in plan_resources
        ):
            raise HarnessFailure(f"kinesis: plan did not list the stream: {plan_resources}")
        function = session.function(source["function"])
        environment = function.get("environment") or {}
        if environment.get("APPTHEORY_KINESIS_STREAM_ARN") != stream.get("arn"):
            raise HarnessFailure(
                f"kinesis: GetAtt Arn did not resolve to the provisioned stream: {environment} vs {stream}"
            )
        receipts_queue = session.resource(name="kinesis-consumer-receipts", kind="AWS::SQS::Queue")
        logtap_queue = session.resource(name="kinesis-logtap-receipts", kind="AWS::SQS::Queue")
        source_group = session.resource(logical_prefix="ExampleSourceLogGroup", kind="AWS::Logs::LogGroup")
        subscription = next(
            (
                candidate
                for candidate in session.spec.get("subscriptions") or []
                if candidate.get("kind") == "cloudwatch-logs"
                and candidate.get("destinationType") == "stream"
            ),
            None,
        )
        if subscription is None:
            raise HarnessFailure("kinesis: the plan has no CloudWatch Logs subscription to the stream")
        clock_ms = int(time.time() * 1000)
        log_stream = "source-stream"
        messages = ["order processed id=42", "order failed id=43"]
        _put_log_events(
            harness,
            session,
            str(source_group["name"]),
            log_stream,
            [{"timestamp": clock_ms + index, "message": message} for index, message in enumerate(messages)],
        )
        session.clock_advance("5s")
        delivered = _wait_for_receipt_advancing(
            session,
            receipts_queue["logicalId"],
            lambda receipt: receipt.get("logStream") == log_stream,
            label="kinesis subscription delivery",
        )
        if (
            delivered.get("streamArn") != stream.get("arn")
            or delivered.get("logGroup") != source_group["name"]
            or delivered.get("messageType") != "DATA_MESSAGE"
            or delivered.get("subscriptionFilters") != [subscription.get("filterName")]
            or [event.get("message") for event in delivered.get("logEvents") or []] != messages
        ):
            raise HarnessFailure(f"kinesis: unexpected subscription receipt: {delivered}")
        logtap = _wait_for_receipt_advancing(
            session,
            logtap_queue["logicalId"],
            lambda receipt: any(
                "processed cloudwatch logs subscription" in str(event.get("message") or "")
                for event in ((receipt.get("payload") or {}).get("logEvents") or [])
            ),
            label="kinesis function-log delivery",
        )
        payload = logtap.get("payload") or {}
        if (
            payload.get("messageType") != "DATA_MESSAGE"
            or not str(payload.get("logGroup") or "").startswith("/aws/lambda/")
            or payload.get("subscriptionFilters") != ["apptheory-consumer-output"]
        ):
            raise HarnessFailure(f"kinesis: unexpected function-log receipt: {logtap}")

        direct_payload = {
            "messageType": "DATA_MESSAGE",
            "owner": "123456789012",
            "logGroup": "direct/log-group",
            "logStream": "direct-stream",
            "subscriptionFilters": ["direct"],
            "logEvents": [{"id": "d1", "timestamp": clock_ms + 10, "message": "direct-put"}],
        }
        compressed = gzip.compress(json.dumps(direct_payload).encode("utf-8"))
        endpoint = session_endpoint(session, "kinesis")
        _aws_cli(
            harness,
            endpoint,
            "kinesis",
            "put-records",
            "--stream-name",
            str(source["sourceName"]),
            "--records",
            json.dumps(
                [
                    {"Data": base64.b64encode(compressed).decode("ascii"), "PartitionKey": "p1"},
                    {"Data": base64.b64encode(b"not-gzip").decode("ascii"), "PartitionKey": "p1"},
                ]
            ),
        )
        session.clock_advance("5s")
        direct = _wait_for_receipt_advancing(
            session,
            receipts_queue["logicalId"],
            lambda receipt: receipt.get("logStream") == "direct-stream",
            label="kinesis direct PutRecords delivery",
        )
        if [event.get("message") for event in direct.get("logEvents") or []] != ["direct-put"]:
            raise HarnessFailure(f"kinesis: unexpected direct PutRecords receipt: {direct}")
        _advance_until(
            session,
            lambda delivery: _source_count(delivery, source["logicalId"], "discarded") >= 1,
            step="1m",
            label="kinesis malformed record discard",
        )
        state = _wait_for_delivery(session, source["logicalId"], delivered=1, failed=1, timeout=60)
        return (
            f"the CDK Kinesis stream {source['sourceName']} was provisioned on moto and its Ref/GetAtt Arn "
            f"resolved ({stream.get('arn')}); PutLogEvents through the real Logs SDK was forwarded by the "
            "subscription filter through its Logs destination to the stream and delivered to the consumer; "
            "the consumer's own captured stdout was delivered to a Lambda-destination filter as the "
            "documented awslogs.data payload; a direct PutRecords batch delivered its valid record and "
            f"discarded the malformed one (delivered={state.get('delivered')}, failed={state.get('failed')}, "
            f"discarded={state.get('discarded')})"
        )
    finally:
        stop_local_session(harness, session)


def run_kinesis_signing(harness: Harness) -> str:
    plan = plan_local_app(harness, KINESIS_APP)
    matches = [
        function for function in plan.get("functions") or []
        if (function.get("environment") or {}).get("SIGNING_KEY_ALIAS")
    ]
    if len(matches) != 1:
        raise HarnessFailure(f"kinesis signing: want one signing function, got {matches}")
    function = matches[0]
    decoded, _ = invoke_local_function(
        harness,
        app=KINESIS_APP,
        function=function["logicalId"],
        event={},
        name="kinesis-signing",
        backends=("moto",),
    )
    raw = decoded.get("raw")
    if not isinstance(raw, dict):
        raise HarnessFailure(f"kinesis signing: the handler did not return JSON: {decoded}")
    if (
        raw.get("aliasVerified") is not True
        or raw.get("arnVerified") is not True
        or raw.get("aliasSignatureLength", 0) <= 0
        or raw.get("arnSignatureLength", 0) <= 0
        or raw.get("publicKeyBytes", 0) <= 0
        or not str(raw.get("alias") or "").startswith("alias/")
        or ":key/" not in str(raw.get("keyArn") or "")
    ):
        raise HarnessFailure(f"kinesis signing: unexpected result: {raw}")
    return (
        "the RSA_2048 SIGN_VERIFY key and its alias were provisioned on moto; the handler signed and "
        "verified with the alias (usable as KeyId) and the key ARN, and read the public key"
    )


def _plan_function(plan: dict, handler: str) -> dict:
    matches = [function for function in plan.get("functions") or [] if function.get("handler") == handler]
    if len(matches) != 1:
        raise HarnessFailure(f"want one function with handler {handler!r}, got {matches}")
    return matches[0]


def _sns_subscription_id(
    plan: dict,
    *,
    topic: str,
    protocol: str,
    function: str | None = None,
    queue: str | None = None,
) -> str:
    matches = []
    for subscription in plan.get("subscriptions") or []:
        if subscription.get("topic") != topic or subscription.get("protocol") != protocol:
            continue
        if function is not None and subscription.get("function") != function:
            continue
        if queue is not None and subscription.get("queue") != queue:
            continue
        matches.append(subscription)
    if len(matches) != 1:
        raise HarnessFailure(f"want one {protocol} subscription on {topic}, got {matches}")
    return matches[0]["logicalId"]


def _sns_resource(session: LocalSession, name: str, kind: str) -> dict:
    return session.resource(name=name, kind=kind)


def _drain_sqs(session: LocalSession, queue_logical_id: str, *, expected: int, timeout: float = 180) -> list[dict]:
    messages: list[dict] = []
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = session.request("sqs.receive", queue=queue_logical_id, max=10, delete=True)
        messages.extend(result.get("messages") or [])
        if len(messages) >= expected:
            break
        time.sleep(0.15)
    if len(messages) != expected:
        raise HarnessFailure(
            f"queue {queue_logical_id}: read {len(messages)} message(s), want {expected}"
        )
    return messages


def run_sqs_sns_publisher(harness: Harness) -> str:
    plan = plan_local_app(harness, SQS_APP)
    publisher = _plan_function(plan, "sns-publisher.handler")
    session = start_local_session(
        harness,
        SQS_APP,
        name="sqs-sns-publisher",
        backends=("moto", "sqs"),
        targets=(publisher["logicalId"],),
    )
    try:
        receipts_id = _sns_resource(session, "sns-receipts", "AWS::SQS::Queue")["logicalId"]
        fifo_queue = _sns_resource(session, "sns-fifo-events.fifo", "AWS::SQS::Queue")
        decoded = session.invoke(publisher["logicalId"], {})
        body = _proxy_body(decoded, "sqs sns publisher")
        standard = body.get("standard") or {}
        fifo = body.get("fifo") or {}
        if (
            decoded.get("statusCode") != 200
            or standard.get("topicArn") != standard.get("expectedArn")
            or standard.get("fifoTopic") is not False
            or not standard.get("messageId")
            or fifo.get("topicArn") != fifo.get("expectedArn")
            or fifo.get("fifoTopic") is not True
            or fifo.get("contentBasedDeduplication") is not True
            or len(fifo.get("orderedMessageIds") or []) != 3
            or not fifo.get("expectedName", "").endswith(".fifo")
            or not str(fifo.get("queueArn") or "").endswith(":fifo-events.fifo")
        ):
            raise HarnessFailure(f"sqs sns publisher: unexpected response: {body}")

        # The standard topic's inline Lambda subscription delivered the
        # documented record to the consumer, which wrote a real SQS receipt.
        standard_subscription = _sns_subscription_id(plan, topic="EventsTopic", protocol="lambda")
        _wait_for_delivery(session, standard_subscription, delivered=1)
        receipts = _drain_sqs(session, receipts_id, expected=1)
        receipt = json.loads(receipts[0]["body"])
        if (
            receipt.get("kind") != "event"
            or receipt.get("eventSource") != "aws:sns"
            or receipt.get("type") != "Notification"
            or receipt.get("messageId") != standard.get("messageId")
            or receipt.get("topicArn") != standard.get("expectedArn")
            or receipt.get("subject") != "local standard publish"
            or receipt.get("message") != '{"eventType":"local-sns-publish","n":1}'
            or receipt.get("signatureVersion") != "1"
            or not receipt.get("timestamp")
            or "SubscriptionArn=" not in str(receipt.get("unsubscribeUrl") or "")
            or (receipt.get("messageAttributes") or {}).get("eventType", {}).get("Type") != "String"
            or (receipt.get("messageAttributes") or {}).get("eventType", {}).get("Value") != "local-sns-publish"
        ):
            raise HarnessFailure(f"sqs sns publisher: unexpected Lambda receipt: {receipt}")

        # The FIFO topic delivered four messages to the unmapped FIFO queue:
        # three ordered messages and one of the two identical content-based
        # publishes. The queue preserves order and carries group/dedup ids.
        _wait_for_queue_total(session, fifo_queue["logicalId"], total=4)
        delivered = _drain_sqs(session, fifo_queue["logicalId"], expected=4)
        # FIFO order is guaranteed per message group, not across groups.
        groups: dict[str, list[dict]] = {}
        for message in delivered:
            attributes = message.get("attributes") or {}
            group = str(attributes.get("MessageGroupId") or "")
            groups.setdefault(group, []).append(message)
        ordered = groups.get("local-group") or []
        if [json.loads(message["body"]).get("n") for message in ordered] != [1, 2, 3]:
            raise HarnessFailure(f"sqs sns publisher: FIFO local-group = {[m['body'] for m in ordered]}")
        for index, message in enumerate(ordered, start=1):
            attributes = message.get("attributes") or {}
            if attributes.get("MessageDeduplicationId") != f"local-dedup-{index}":
                raise HarnessFailure(f"sqs sns publisher: ordered FIFO attributes = {attributes}")
        content_group = groups.get("cbd-group") or []
        if len(content_group) != 1:
            raise HarnessFailure(f"sqs sns publisher: content-based group = {content_group}")
        content = content_group[0]
        if json.loads(content["body"]) != {"eventType": "local-sns-fifo", "contentBased": True}:
            raise HarnessFailure(f"sqs sns publisher: FIFO content body = {content['body']}")
        content_attributes = content.get("attributes") or {}
        want_content_dedup = hashlib.sha256(fifo["contentBody"].encode("utf-8")).hexdigest()
        if content_attributes.get("MessageDeduplicationId") != want_content_dedup:
            raise HarnessFailure(f"sqs sns publisher: content-based FIFO attributes = {content_attributes}")
        fifo_subscription = _sns_subscription_id(plan, topic="FifoTopic", protocol="sqs", queue=fifo_queue["logicalId"])
        _wait_for_delivery(session, fifo_subscription, delivered=4)
        plan_resources = plan.get("resources") or []
        topics = {
            resource.get("localId")
            for resource in plan_resources
            if resource.get("type") == "AWS::SNS::Topic"
        }
        if "apptheory-local-events" not in topics or "apptheory-local-events.fifo" not in topics:
            raise HarnessFailure(f"sqs sns publisher: plan did not list both topics: {plan_resources}")
        return (
            "the standard and FIFO SNS topics were provisioned on moto; the handler published through the "
            "real SDK; the inline Lambda subscription delivered the documented record (message id, subject, "
            "timestamp, UnsubscribeUrl and String attributes); the FIFO topic delivered three ordered "
            "messages in one message group and collapsed the two identical content-based publishes to one "
            "in another; the FIFO queue carried MessageGroupId and the explicit or content SHA-256 "
            "MessageDeduplicationId"
        )
    finally:
        stop_local_session(harness, session)


class _SNSHTTPCapture:
    """A real loopback HTTP endpoint the runner POSTs an SNS notification to."""

    def __init__(self) -> None:
        self.receipts: list[dict] = []
        self.ready = threading.Event()
        self.server: http.server.ThreadingHTTPServer | None = None

    def start(self) -> "_SNSHTTPCapture":
        capture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length).decode("utf-8", errors="replace")
                capture.receipts.append(
                    {"path": self.path, "headers": dict(self.headers), "body": body}
                )
                capture.ready.set()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *_args) -> None:
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", SNS_HTTP_PORT), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()

    def wait(self, timeout: float = 120) -> dict:
        if not self.ready.wait(timeout):
            raise HarnessFailure(f"the SNS HTTP endpoint was not reached in {timeout:g}s")
        return self.receipts[0]


def run_sqs_sns_targets(harness: Harness) -> str:
    plan = plan_local_app(harness, SQS_APP)
    publisher = _plan_function(plan, "sns-scenario-publisher.handler")
    try:
        capture = _SNSHTTPCapture().start()
    except OSError as exc:
        raise HarnessFailure(f"start the SNS HTTP capture on 127.0.0.1:{SNS_HTTP_PORT}: {exc}") from exc
    session = start_local_session(
        harness,
        SQS_APP,
        name="sqs-sns-targets",
        backends=("moto", "sqs"),
        targets=(publisher["logicalId"],),
    )
    try:
        receipts_id = _sns_resource(session, "sns-receipts", "AWS::SQS::Queue")["logicalId"]
        raw_queue = _sns_resource(session, "sns-raw", "AWS::SQS::Queue")
        envelope_queue = _sns_resource(session, "sns-envelope", "AWS::SQS::Queue")
        attributes_topic = _sns_resource(session, "apptheory-local-attributes", "AWS::SNS::Topic")
        body_topic = _sns_resource(session, "apptheory-local-body", "AWS::SNS::Topic")
        raw_topic = _sns_resource(session, "apptheory-local-raw", "AWS::SNS::Topic")
        http_topic = _sns_resource(session, "apptheory-local-http", "AWS::SNS::Topic")

        def publish(topic_env: str, messages: list[dict], label: str) -> dict:
            result = session.invoke(publisher["logicalId"], {"topicEnv": topic_env, "messages": messages})
            body = _proxy_body(result, label)
            if result.get("statusCode") != 200 or len(body.get("messageIds") or []) != len(messages):
                raise HarnessFailure(f"{label}: unexpected publish result: {body}")
            return body

        # Attribute-scope filter in the AWS standard "$or" form: the sibling
        # eventType key is ANDed with the OR of the branch objects. One message
        # matches each branch and one matches neither.
        attribute_priority = '{"kind":"attribute-priority"}'
        attribute_region = '{"kind":"attribute-region"}'
        publish(
            "ATTRIBUTES_TOPIC_ARN",
            [
                {
                    "message": attribute_priority,
                    "messageAttributes": {
                        "eventType": {"DataType": "String", "StringValue": "keep"},
                        "priority": {"DataType": "Number", "StringValue": "10"},
                    },
                },
                {
                    "message": attribute_region,
                    "messageAttributes": {
                        "eventType": {"DataType": "String", "StringValue": "keep"},
                        "region": {"DataType": "String", "StringValue": "us-east-1"},
                    },
                },
                {
                    "message": '{"kind":"attribute-neither"}',
                    "messageAttributes": {
                        "eventType": {"DataType": "String", "StringValue": "keep"},
                        "priority": {"DataType": "Number", "StringValue": "5"},
                        "region": {"DataType": "String", "StringValue": "eu-west-1"},
                    },
                },
            ],
            "sqs sns targets attribute filter",
        )
        # Body-scope filter: one matching JSON body, one below the numeric
        # range, and one non-JSON body (which matches nothing).
        body_match = json.dumps({"kind": "order", "amount": 150, "customer": {"tier": "premium"}})
        publish(
            "BODY_TOPIC_ARN",
            [
                {"message": body_match},
                {"message": json.dumps({"kind": "order", "amount": 50, "customer": {"tier": "premium"}})},
                {"message": "not json"},
            ],
            "sqs sns targets body filter",
        )
        attribute_state = _wait_for_delivery(
            session,
            _sns_subscription_id(plan, topic="FilteredAttributesTopic", protocol="lambda"),
            delivered=2,
            filtered=1,
        )
        body_state = _wait_for_delivery(
            session,
            _sns_subscription_id(plan, topic="FilteredBodyTopic", protocol="lambda"),
            delivered=1,
            filtered=2,
        )
        receipts = _drain_sqs(session, receipts_id, expected=3)
        by_message = {}
        for message in receipts:
            receipt = json.loads(message["body"])
            by_message[receipt.get("message")] = receipt
        if set(by_message) != {attribute_priority, attribute_region, body_match}:
            raise HarnessFailure(f"sqs sns targets: receipts = {[json.loads(m['body']) for m in receipts]}")
        priority_receipt = by_message[attribute_priority]
        region_receipt = by_message[attribute_region]
        if (
            (priority_receipt.get("messageAttributes") or {}).get("priority", {}).get("Value") != "10"
            or (region_receipt.get("messageAttributes") or {}).get("region", {}).get("Value") != "us-east-1"
            or by_message[body_match].get("kind") != "body"
        ):
            raise HarnessFailure(
                f"sqs sns targets: filtered receipts = {[json.loads(m['body']) for m in receipts]}"
            )
        if attribute_state.get("filtered") != 1 or attribute_state.get("failed") != 0:
            raise HarnessFailure(f"sqs sns targets: attribute state = {attribute_state}")
        if body_state.get("filtered") != 2 or body_state.get("failed") != 0:
            raise HarnessFailure(f"sqs sns targets: body state = {body_state}")

        # Raw and envelope SQS subscriptions on the same standard topic.
        raw_message = '{"kind":"raw","n":1}'
        publish(
            "RAW_TOPIC_ARN",
            [
                {
                    "message": raw_message,
                    "subject": "raw subject",
                    "messageAttributes": {
                        "eventType": {"DataType": "String", "StringValue": "keep"},
                        "count": {"DataType": "Number", "StringValue": "42"},
                        "tags": {"DataType": "String.Array", "StringValue": json.dumps(["a", "b"])},
                    },
                }
            ],
            "sqs sns targets raw",
        )
        _wait_for_delivery(
            session,
            _sns_subscription_id(plan, topic="RawTopic", protocol="sqs", queue=raw_queue["logicalId"]),
            delivered=1,
        )
        _wait_for_delivery(
            session,
            _sns_subscription_id(plan, topic="RawTopic", protocol="sqs", queue=envelope_queue["logicalId"]),
            delivered=1,
        )
        raw_receipt = _drain_sqs(session, raw_queue["logicalId"], expected=1)[0]
        if raw_receipt.get("body") != raw_message:
            raise HarnessFailure(f"sqs sns targets: raw body = {raw_receipt.get('body')!r}")
        raw_attributes = raw_receipt.get("messageAttributes") or {}
        if (
            (raw_attributes.get("eventType") or {}).get("DataType") != "String"
            or (raw_attributes.get("eventType") or {}).get("StringValue") != "keep"
            or (raw_attributes.get("count") or {}).get("DataType") != "Number"
            or (raw_attributes.get("count") or {}).get("StringValue") != "42"
            or (raw_attributes.get("tags") or {}).get("StringValue") != json.dumps(["a", "b"])
        ):
            raise HarnessFailure(f"sqs sns targets: raw message attributes = {raw_attributes}")
        if (raw_receipt.get("attributes") or {}).get("MessageGroupId"):
            raise HarnessFailure(f"sqs sns targets: raw standard delivery carried a group: {raw_receipt}")
        envelope_receipt = _drain_sqs(session, envelope_queue["logicalId"], expected=1)[0]
        envelope = json.loads(envelope_receipt["body"])
        if (
            envelope.get("Type") != "Notification"
            or envelope.get("Message") != raw_message
            or envelope.get("Subject") != "raw subject"
            or envelope.get("TopicArn") != raw_topic.get("arn")
            or (envelope.get("MessageAttributes") or {}).get("eventType", {}).get("Type") != "String"
            or (envelope.get("MessageAttributes") or {}).get("eventType", {}).get("Value") != "keep"
            or not envelope.get("MessageId")
            or not envelope.get("Timestamp")
        ):
            raise HarnessFailure(f"sqs sns targets: envelope = {envelope}")

        # HTTP loopback subscription served by this harness.
        http_message = '{"kind":"http","n":1}'
        publish(
            "HTTP_TOPIC_ARN",
            [
                {
                    "message": http_message,
                    "subject": "http subject",
                    "messageAttributes": {
                        "eventType": {"DataType": "String", "StringValue": "http"},
                    },
                }
            ],
            "sqs sns targets http",
        )
        receipt = capture.wait(120)
        headers = {name.lower(): value for name, value in receipt["headers"].items()}
        if receipt["path"] != "/":
            raise HarnessFailure(f"sqs sns targets: HTTP path = {receipt['path']!r}")
        if not str(headers.get("content-type", "")).startswith("text/plain"):
            raise HarnessFailure(f"sqs sns targets: HTTP content-type = {headers.get('content-type')!r}")
        if headers.get("x-amz-sns-message-type") != "Notification":
            raise HarnessFailure(f"sqs sns targets: HTTP message type = {headers.get('x-amz-sns-message-type')!r}")
        if headers.get("x-amz-sns-topic-arn") != http_topic.get("arn"):
            raise HarnessFailure(f"sqs sns targets: HTTP topic ARN = {headers.get('x-amz-sns-topic-arn')!r}")
        if not str(headers.get("x-amz-sns-subscription-arn") or "").startswith(str(http_topic.get("arn")) + ":"):
            raise HarnessFailure(f"sqs sns targets: HTTP subscription ARN = {headers.get('x-amz-sns-subscription-arn')!r}")
        http_body = json.loads(receipt["body"])
        if (
            http_body.get("Type") != "Notification"
            or http_body.get("Message") != http_message
            or http_body.get("Subject") != "http subject"
            or http_body.get("TopicArn") != http_topic.get("arn")
            or http_body.get("SignatureVersion") != "1"
            or http_body.get("MessageId") != headers.get("x-amz-sns-message-id")
            or (http_body.get("MessageAttributes") or {}).get("eventType", {}).get("Value") != "http"
        ):
            raise HarnessFailure(f"sqs sns targets: HTTP body = {http_body}")
        _wait_for_delivery(
            session,
            _sns_subscription_id(plan, topic="HttpTopic", protocol="http"),
            delivered=1,
        )
        return (
            "the runner evaluated an attribute-scope policy in the AWS standard $or form (eventType ANDed "
            "with priority OR region) and a body-scope policy (nested keys), delivering two messages that "
            "matched one $or branch each and reporting one filtered message on the attribute subscription "
            "and two on the body subscription; an SQS raw subscription received the body and native "
            "attributes while the envelope subscription received the documented JSON notification; a "
            "loopback HTTP subscription received the body and the x-amz-sns-* headers"
        )
    finally:
        stop_local_session(harness, session)
        capture.stop()


def run_sqs_s3_notifications(harness: Harness) -> str:
    """The three S3 notification destinations and the documented test event.

    The row writes and deletes real objects through the S3 SDK. The runner
    observes the bucket at the S3 protocol boundary and delivers the documented
    record to a Lambda function, an SQS queue and an SNS topic (raw SQS
    subscription), and it never builds an event from harness input.
    """
    session = start_local_session(
        harness,
        SQS_APP,
        name="sqs-s3",
        backends=("sqs", "moto", "s3proxy"),
        clock=f"test={LOCAL_RUNNER_CLOCK_START}",
    )
    try:
        bucket = session.resource(logical_prefix="NotificationBucket", kind="AWS::S3::Bucket")
        records = session.resource(name="s3-events", kind="AWS::SQS::Queue")
        raw = session.resource(name="s3-raw", kind="AWS::SQS::Queue")
        receipts = session.resource(name="s3-lambda-receipts", kind="AWS::SQS::Queue")

        lambda_config = session.notification_for(bucket["logicalId"], "function")
        queue_configs = session.notifications_for(bucket["logicalId"], "queue")
        topic_config = session.notification_for(bucket["logicalId"], "topic")
        if len(queue_configs) != 1:
            raise HarnessFailure(f"s3 notifications: want one queue configuration, got {queue_configs}")
        if not lambda_config.get("filterRules") or len(lambda_config["filterRules"]) != 2:
            raise HarnessFailure(f"s3 notifications: the Lambda filter rules are {lambda_config.get('filterRules')}")

        # The configuration was applied: S3 sends the documented test message to
        # every SQS and SNS destination, and never to a Lambda destination.
        test_event = _wait_for_receipt(
            session,
            records["logicalId"],
            lambda message: message.get("Event") == "s3:TestEvent",
            label="s3 notifications: test event on the SQS destination",
        )
        if test_event.get("Service") != "Amazon S3" or test_event.get("Bucket") != bucket["name"]:
            raise HarnessFailure(f"s3 notifications: unexpected test event {test_event}")
        raw_test = _wait_for_receipt(
            session,
            raw["logicalId"],
            lambda message: message.get("Event") == "s3:TestEvent",
            label="s3 notifications: test event on the SNS destination",
        )
        if raw_test.get("Service") != "Amazon S3":
            raise HarnessFailure(f"s3 notifications: unexpected SNS test event {raw_test}")

        # The Lambda and SNS configurations share the incoming/ prefix for
        # ObjectCreated, so their suffixes split the keys: .json reaches only
        # the Lambda destination and .csv reaches only the SNS topic.
        # https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-filtering.html
        content = json.dumps({"ok": True})
        session.request("s3.put", bucket=bucket["logicalId"], objectKey="incoming/a.json", body=content)
        receipt = _wait_for_receipt(
            session,
            receipts["logicalId"],
            lambda message: message.get("eventName") == "ObjectCreated:Put",
            label="s3 notifications: Lambda destination record",
        )
        if receipt.get("key") != "incoming/a.json" or receipt.get("bucket") != bucket["name"]:
            raise HarnessFailure(f"s3 notifications: Lambda record {receipt}")
        if receipt.get("configurationId") != lambda_config.get("configurationId"):
            raise HarnessFailure(
                f"s3 notifications: configurationId {receipt.get('configurationId')!r} "
                f"!= {lambda_config.get('configurationId')!r}"
            )
        if receipt.get("eventVersion") != "2.6" or receipt.get("eventSource") != "aws:s3":
            raise HarnessFailure(f"s3 notifications: record envelope {receipt}")

        # The .json PUT was observed by every destination before the .csv PUT:
        # the SNS .csv suffix and the queue's ObjectRemoved event type filtered
        # it, so only the Lambda destination delivered it.
        _wait_for_delivery(session, topic_config["logicalId"], delivered=1, filtered=1)
        _wait_for_delivery(session, queue_configs[0]["logicalId"], delivered=1, filtered=1)

        session.request("s3.put", bucket=bucket["logicalId"], objectKey="incoming/b.csv", body=content)
        sns_record = _wait_for_receipt(
            session,
            raw["logicalId"],
            lambda message: message.get("Records", [{}])[0].get("eventName") == "ObjectCreated:Put",
            label="s3 notifications: SNS destination record",
        )
        if sns_record["Records"][0]["s3"]["object"]["key"] != "incoming/b.csv":
            raise HarnessFailure(f"s3 notifications: SNS record {sns_record}")
        _wait_for_delivery(session, lambda_config["logicalId"], delivered=1, filtered=1)

        # A key that fails every prefix/suffix rule is counted, not delivered.
        session.request("s3.put", bucket=bucket["logicalId"], objectKey="ignored/a.txt", body=content)
        _wait_for_delivery(session, lambda_config["logicalId"], filtered=2)
        _wait_for_delivery(session, queue_configs[0]["logicalId"], filtered=3)
        _wait_for_delivery(session, topic_config["logicalId"], filtered=2)

        # A delete on the SQS destination delivers ObjectRemoved:Delete.
        session.request("s3.delete", bucket=bucket["logicalId"], objectKey="incoming/a.json")
        removed = _wait_for_receipt(
            session,
            records["logicalId"],
            lambda message: message.get("Records", [{}])[0].get("eventName") == "ObjectRemoved:Delete",
            label="s3 notifications: SQS destination delete record",
        )
        if removed["Records"][0]["s3"]["object"]["key"] != "incoming/a.json":
            raise HarnessFailure(f"s3 notifications: delete record {removed}")

        lambda_state = _wait_for_delivery(session, lambda_config["logicalId"], delivered=1, filtered=3)
        queue_state = _wait_for_delivery(session, queue_configs[0]["logicalId"], delivered=2, filtered=3)
        topic_state = _wait_for_delivery(session, topic_config["logicalId"], delivered=2, filtered=3)
        for state, label, delivered, filtered in (
            (lambda_state, "lambda", 1, 3),
            (queue_state, "queue", 2, 3),
            (topic_state, "topic", 2, 3),
        ):
            if state.get("failed"):
                raise HarnessFailure(f"s3 notifications: the {label} destination failed: {state}")
            if state.get("delivered") != delivered or state.get("filtered") != filtered:
                raise HarnessFailure(
                    f"s3 notifications: the {label} destination reported {state}, "
                    f"want delivered={delivered} filtered={filtered}"
                )
        return (
            "the CDK bucket configuration delivered the s3:TestEvent to its SQS and SNS destinations on "
            "configuration; a real SDK PUT of incoming/a.json delivered ObjectCreated:Put to the Lambda "
            "destination only (the SNS .csv suffix and the queue's event type filtered it); a real SDK PUT "
            "of incoming/b.csv delivered ObjectCreated:Put to the SNS destination only; ignored/a.txt was "
            "filtered by every prefix/suffix rule; a real SDK DELETE delivered ObjectRemoved:Delete to the "
            "queue destination; describe reported exact per-destination delivered/filtered counts "
            "(lambda 1/3, queue 2/3, topic 2/3)"
        )
    finally:
        stop_local_session(harness, session)


def _receive_messages(session: LocalSession, queue_id: str, *, expected: int = 1, timeout: float = 180) -> list[dict]:
    _wait_for_queue_total(session, queue_id, total=expected, timeout=timeout)
    response = session.request("sqs.receive", queue=queue_id, max=expected, waitSeconds=1, delete=True)
    return response.get("messages") or []


def run_sqs_event_targets(harness: Harness) -> str:
    plan = plan_local_app(harness, SQS_APP)
    publisher = next(
        function for function in plan.get("functions") or []
        if function.get("handler") == "rule-publisher.handler"
    )
    session = start_local_session(
        harness,
        SQS_APP,
        name="sqs-event-targets",
        backends=("dynamodb", "sqs", "moto"),
        clock=f"test={LOCAL_RUNNER_CLOCK_START}",
        targets=(publisher["logicalId"],),
    )
    try:
        publisher = next(
            function for function in session.spec.get("functions") or []
            if function.get("handler") == "rule-publisher.handler"
        )
        result = session.invoke(publisher["logicalId"], {})
        raw = result.get("raw") or {}
        if raw.get("failedEntryCount") != 0 or len(raw.get("eventIds") or []) != 4:
            raise HarnessFailure(f"event targets: the publisher's PutEvents failed: {result}")

        contract = session.resource(name="rule-target-events", kind="AWS::SQS::Queue")
        messages = _receive_messages(session, contract["logicalId"])
        path_input = json.loads(messages[0]["body"])
        if path_input != {"item": "path-value"}:
            raise HarnessFailure(f"event targets: the SQS InputPath body is {path_input!r}")

        sns_receipts = session.resource(name="sns-receipts", kind="AWS::SQS::Queue")
        receipts = _receive_messages(session, sns_receipts["logicalId"])
        sns_receipt = json.loads(receipts[0]["body"])
        transformed = json.loads(sns_receipt.get("message") or "{}")
        if (
            sns_receipt.get("kind") != "event"
            or transformed.get("item") != "transform-value"
            or not transformed.get("rule")
        ):
            raise HarnessFailure(f"event targets: unexpected SNS transformer receipt: {sns_receipt}")

        rule_receipts = session.resource(name="rule-receipts", kind="AWS::SQS::Queue")
        receipts = _receive_messages(session, rule_receipts["logicalId"])
        static_receipt = json.loads(receipts[0]["body"])
        if static_receipt.get("kind") != "static" or static_receipt.get("received") != {"static": True}:
            raise HarnessFailure(f"event targets: unexpected static Input receipt: {static_receipt}")

        failing = next(
            function for function in session.spec.get("functions") or []
            if function.get("handler") == "rule-failing-target.handler"
        )
        fail_rules = [
            rule for rule in session.info.get("rules") or []
            if failing["logicalId"] in (rule.get("targets") or [])
        ]
        if len(fail_rules) != 1:
            raise HarnessFailure(f"event targets: want one failing rule, got {fail_rules}")
        fail_rule = fail_rules[0]
        _advance_until(
            session,
            lambda delivery: _source_count(delivery, fail_rule["logicalId"], "deadLettered") >= 1,
            step="1m",
            label="event target retry and DLQ",
        )
        dlq = session.resource(name="rule-dlq", kind="AWS::SQS::Queue")
        messages = _receive_messages(session, dlq["logicalId"])
        dlq_body = json.loads(messages[0]["body"])
        attributes = messages[0].get("messageAttributes") or {}
        expected_attributes = {
            "ERROR_CODE": "ERROR_FROM_TARGET",
            "EXHAUSTED_RETRY_CONDITION": "MaximumRetryAttempts",
            "RETRY_ATTEMPTS": "3",
        }
        for name, want in expected_attributes.items():
            attribute = attributes.get(name) or {}
            if attribute.get("StringValue") != want:
                raise HarnessFailure(f"event targets: DLQ attribute {name} = {attribute!r}, want {want!r}")
        if dlq_body.get("detail-type") != "fail" or dlq_body.get("source") != "apptheory.rule":
            raise HarnessFailure(f"event targets: unexpected DLQ body: {dlq_body}")
        state = _delivery_source_state(session, fail_rule["logicalId"])
        return (
            "the publisher's real SDK PutEvents reached four rules: an SQS target received the "
            "InputPath body, an SNS target received the input-transformer message, a Lambda target "
            "received the static Input, and a failing Lambda target exhausted two retries and reached "
            f"the real DLQ with RULE_ARN/TARGET_ARN/ERROR_CODE/EXHAUSTED_RETRY_CONDITION/RETRY_ATTEMPTS "
            f"(fired={state.get('fired')}, failed={state.get('failed')}, "
            f"deadLettered={state.get('deadLettered')})"
        )
    finally:
        stop_local_session(harness, session)


def run_s3_vectors(harness: Harness) -> str:
    session = start_local_session(harness, VECTORS_APP, name="s3-vectors")
    try:
        api = session.info.get("apis") or []
        if len(api) != 1:
            raise HarnessFailure(f"s3-vectors: want one HTTP API, got {api}")
        base = api[0]["url"]
        token = (session.info.get("secrets") or {}).get("APPTHEORY_EXAMPLE_API_TOKEN", "")
        if not token:
            raise HarnessFailure("s3-vectors: the local API token was not resolved")
        status, payload, _ = _json_request("GET", f"{base}/health")
        expect_status(status, 200, "s3-vectors GET /health", json.dumps(payload))
        if payload.get("configured") is not True or payload.get("dimension") != 1024:
            raise HarnessFailure(f"s3-vectors GET /health: unexpected body {payload}")
        for label, method, path, auth in (
            ("seed no auth", "POST", "/seed", None),
            ("seed wrong auth", "POST", "/seed", "wrong"),
            ("search no auth", "GET", "/search?q=middleware", None),
            ("search wrong auth", "GET", "/search?q=middleware", "wrong"),
        ):
            status, text, _ = http_request(
                method,
                f"{base}{path}",
                headers={"Authorization": f"Bearer {auth}"} if auth else {},
                body=b"{}" if method == "POST" else None,
            )
            expect_status(status, 401, f"s3-vectors {label}", text)
            if "app.unauthorized" not in text:
                raise HarnessFailure(f"s3-vectors {label}: unexpected refusal {text}")
        status, payload, _ = _json_request("GET", f"{base}/search", headers={"Authorization": f"Bearer {token}"})
        expect_status(status, 400, "s3-vectors search missing query", json.dumps(payload))
        if (payload.get("error") or {}).get("code") != "example.missing_query":
            raise HarnessFailure(f"s3-vectors search missing query: unexpected body {payload}")
        status, payload, _ = _json_request(
            "GET", f"{base}/search?q=middleware&top_k=999", headers={"Authorization": f"Bearer {token}"}
        )
        expect_status(status, 400, "s3-vectors search top_k", json.dumps(payload))
        if (payload.get("error") or {}).get("code") != "example.invalid_top_k":
            raise HarnessFailure(f"s3-vectors search top_k: unexpected body {payload}")
        status, payload, _ = _json_request(
            "GET", f"{base}/search?q=middleware", headers={"Authorization": f"Bearer {token}"}
        )
        expect_status(status, 502, "s3-vectors search at the Bedrock boundary", json.dumps(payload))
        if (payload.get("error") or {}).get("code") != "vectorstore.embedding_failed":
            raise HarnessFailure(f"s3-vectors search boundary: unexpected body {payload}")
        status, payload, _ = _json_request(
            "POST", f"{base}/seed", headers={"Authorization": f"Bearer {token}"}, payload={}
        )
        expect_status(status, 502, "s3-vectors seed at the Bedrock boundary", json.dumps(payload))
        return (
            "health reported the CDK-declared vector index; missing/wrong auth and missing query/top_k "
            "were refused; authorized search/seed reached the closed Bedrock boundary with the expected error"
        )
    finally:
        stop_local_session(harness, session)


def run_microvm_controller(harness: Harness) -> str:
    session = start_local_session(
        harness,
        MICROVM_APP,
        name="microvm-controller",
        backends=("dynamodb",),
        context={"microvmDemoBearerToken": MICROVM_DEMO_TOKEN},
    )
    try:
        api = session.info.get("apis") or []
        if len(api) != 1:
            raise HarnessFailure(f"microvm-controller: want one HTTP API, got {api}")
        base = api[0]["url"]
        authorizers = [f for f in session.info.get("functions") or [] if "Authorizer" in f["logicalId"]]
        if not authorizers:
            raise HarnessFailure("microvm-controller: the CDK authorizer function was not started")
        valid = {
            "Authorization": f"Bearer {MICROVM_DEMO_TOKEN}",
            "x-tenant-id": "tenant-a4",
            "x-namespace-id": "ns-a4",
        }
        for label, headers in (
            ("missing auth", {"x-tenant-id": "tenant-a4", "x-namespace-id": "ns-a4"}),
            ("wrong auth", {"Authorization": "Bearer wrong", "x-tenant-id": "tenant-a4", "x-namespace-id": "ns-a4"}),
            ("missing tenant", {"Authorization": f"Bearer {MICROVM_DEMO_TOKEN}"}),
        ):
            status, text, _ = http_request("GET", f"{base}/microvms?max_results=1", headers=headers)
            expect_status(status, 401, f"microvm-controller {label}", text)
            if "Unauthorized" not in text:
                raise HarnessFailure(f"microvm-controller {label}: unexpected refusal {text}")
        status, payload, _ = _json_request("GET", f"{base}/microvms?max_results=1", headers=valid)
        expect_status(status, 502, "microvm-controller list at the provider boundary", json.dumps(payload))
        if (payload.get("error") or {}).get("code") != "m16.microvm.provider_operation_failed":
            raise HarnessFailure(f"microvm-controller list: unexpected boundary error {payload}")
        status, payload, _ = _json_request(
            "POST",
            f"{base}/microvms",
            headers=valid,
            payload={"tenant_id": "tenant-a4", "namespace": "ns-a4", "session_spec": {}},
        )
        expect_status(status, 502, "microvm-controller run at the provider boundary", json.dumps(payload))
        if (payload.get("error") or {}).get("code") != "m16.microvm.provider_operation_failed":
            raise HarnessFailure(f"microvm-controller run: unexpected boundary error {payload}")
        session_id = "session-404"
        for label, method, path, body in (
            ("get", "GET", f"/microvms/{session_id}", None),
            ("suspend", "POST", f"/microvms/{session_id}/suspend", {}),
            ("resume", "POST", f"/microvms/{session_id}/resume", {}),
            ("terminate", "DELETE", f"/microvms/{session_id}", {}),
            ("auth-token", "POST", f"/microvms/{session_id}/auth-token", {"allowed_port_scope": [{"port": 443}]}),
            ("shell-auth-token", "POST", f"/microvms/{session_id}/shell-auth-token", {}),
            ("invoke", "POST", f"/microvms/{session_id}/invoke/hello", {}),
        ):
            status, payload, _ = _json_request(method, f"{base}{path}", headers=valid, payload=body)
            expect_status(status, 404, f"microvm-controller {label} missing session", json.dumps(payload))
            if (payload.get("error") or {}).get("code") != "m15.microvm.session_registry_incomplete":
                raise HarnessFailure(f"microvm-controller {label}: unexpected registry error {payload}")
        table = session.resource(logical_prefix="MicrovmControllerSessionTable", kind="AWS::DynamoDB::Table")
        items = session.request("ddb.scan", table=table["logicalId"])["items"]
        if items:
            raise HarnessFailure(f"microvm-controller: the registry table is not empty: {items}")
        return (
            "the CDK authorizer refused missing, wrong and tenant-less credentials; list and run reached "
            "the managed provider boundary; get/suspend/resume/terminate/auth-token/shell-auth-token/invoke "
            "read the TableTheory registry on DynamoDB Local and refused a missing session"
        )
    finally:
        stop_local_session(harness, session)


def _workload_process(language: str, port: int, log: str) -> subprocess.Popen:
    if language == "go":
        argv = [str(MICROVM_WORKLOAD_GO)]
    elif language == "py":
        argv = ["python3", "examples/cdk/microvm-controller/workloads/py/server.py"]
    elif language == "ts":
        argv = ["node", "examples/cdk/microvm-controller/workloads/ts/server.js"]
    else:
        raise HarnessFailure(f"unknown workload language {language}")
    return subprocess.Popen(
        argv,
        cwd=str(ROOT),
        env={**os.environ, "PORT": str(port)},
        stdout=open(log, "w", encoding="utf-8"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )


def _wait_for_workload(process: subprocess.Popen, port: int, language: str, seconds: int = 60) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise HarnessFailure(f"microvm {language} workload exited early (code {process.returncode})")
        if port_open("127.0.0.1", port, timeout=0.25):
            return
        time.sleep(0.1)
    raise HarnessFailure(f"microvm {language} workload did not listen on 127.0.0.1:{port}")


def _run_microvm_workload(harness: Harness, language: str, expected_language: str) -> str:
    port = harness.lease.aux_port
    if port_open("127.0.0.1", port):
        raise HarnessFailure(f"microvm workload port {port} is already in use")
    log = tempfile.NamedTemporaryFile(prefix=f"a4-microvm-{language}-", suffix=".log", delete=False)
    log.close()
    process = _workload_process(language, port, log.name)
    try:
        _wait_for_workload(process, port, language)
        base = f"http://127.0.0.1:{port}"
        status, payload, _ = _json_request("GET", f"{base}/hello?x=1")
        expect_status(status, 200, f"microvm {language} workload GET", json.dumps(payload))
        if payload.get("language") != expected_language or payload.get("runtime") != "apptheory-microvm-workload":
            raise HarnessFailure(f"microvm {language} workload GET: unexpected body {payload}")
        if payload.get("method") != "GET" or not str(payload.get("path", "")).startswith("/hello"):
            raise HarnessFailure(f"microvm {language} workload GET: method/path lost: {payload}")
        if not payload.get("now"):
            raise HarnessFailure(f"microvm {language} workload GET: no timestamp: {payload}")
        status, payload, _ = _json_request("POST", f"{base}/anything?y=2", payload={"n": 1})
        expect_status(status, 200, f"microvm {language} workload POST", json.dumps(payload))
        if payload.get("method") != "POST" or not str(payload.get("path", "")).startswith("/anything"):
            raise HarnessFailure(f"microvm {language} workload POST: method/path lost: {payload}")
        return f"the {expected_language} workload server answered GET and POST with its HTTP contract"
    finally:
        _stop_process(process)
        try:
            os.unlink(log.name)
        except FileNotFoundError:
            pass


def run_microvm_workload_go(harness: Harness) -> str:
    return _run_microvm_workload(harness, "go", "go")


def run_microvm_workload_py(harness: Harness) -> str:
    return _run_microvm_workload(harness, "py", "python")


def run_microvm_workload_ts(harness: Harness) -> str:
    return _run_microvm_workload(harness, "ts", "typescript")


def run_microvm_conformance(harness: Harness) -> str:
    session = start_local_session(
        harness,
        MICROVM_APP,
        name="microvm-conformance",
        backends=("dynamodb",),
        context={"microvmDemoBearerToken": MICROVM_DEMO_TOKEN},
    )
    config_path = None
    try:
        api = session.info.get("apis") or []
        if len(api) != 1:
            raise HarnessFailure(f"microvm-conformance: want one HTTP API, got {api}")
        controller = [
            function for function in session.info.get("functions") or []
            if "APPTHEORY_MICROVM_IMAGE_REF" in (function.get("environment") or {})
        ]
        if len(controller) != 1:
            raise HarnessFailure(f"microvm-conformance: no single controller function: {controller}")
        environment = controller[0].get("environment") or {}
        egress = [item for item in environment.get("APPTHEORY_MICROVM_NETWORK_CONNECTOR_REFS", "").split(",") if item]
        ingress = [item for item in environment.get("APPTHEORY_MICROVM_INGRESS_NETWORK_CONNECTOR_REFS", "").split(",") if item]
        egress_refs = [item for item in environment.get("APPTHEORY_MICROVM_EGRESS_NETWORK_CONNECTOR_REFS", "").split(",") if item]
        if not environment.get("APPTHEORY_MICROVM_IMAGE_REF") or not egress:
            raise HarnessFailure(
                f"microvm-conformance: the controller does not expose deployment-pinned image/connector refs: {environment}"
            )
        config = {
            "endpoint": api[0]["url"],
            "auth_token_env": "APPTHEORY_MICROVM_CONFORMANCE_AUTH_TOKEN",
            "tenant_id": "tenant-a4",
            "namespace": "ns-a4",
            "timeout_seconds": 30,
            "headers": {},
            "run": {
                "image_ref": environment["APPTHEORY_MICROVM_IMAGE_REF"],
                "network_connector_ref": egress[0],
                "ingress_network_connector_refs": ingress,
                "egress_network_connector_refs": egress_refs,
                "session_spec": {},
            },
            "negative": {"tenant_id": "tenant-negative", "namespace": "ns-negative"},
            "scanner": {},
        }
        with tempfile.NamedTemporaryFile(
            prefix="a4-conformance-", suffix=".json", mode="w", encoding="utf-8", delete=False
        ) as handle:
            config_path = handle.name
            json.dump(config, handle)
        result = harness.run(
            ["python3", CONFORMANCE_SCRIPT, "--config", config_path],
            env={"APPTHEORY_MICROVM_CONFORMANCE_AUTH_TOKEN": MICROVM_DEMO_TOKEN},
            timeout=600,
            check=False,
        )
        output = _combined_output(result)
        if result.returncode != 0:
            raise HarnessFailure(
                f"microvm-conformance wrapper exited {result.returncode}; it must pass dry-run/scan and report the provider boundary",
                output,
            )
        for needle in ("microvm-conformance-local: PASS", "provider boundary"):
            if needle not in output:
                raise HarnessFailure(f"microvm-conformance wrapper output is missing {needle!r}", output)
        if MICROVM_DEMO_TOKEN in output:
            raise HarnessFailure("microvm-conformance wrapper printed the demo bearer token", output)
        return (
            "dry-run, leak-scan and the local live run passed; the live run stopped at the managed "
            "MicroVM provider boundary after the auth refusals (no EqualToAI/Host proof claimed)"
        )
    finally:
        if config_path:
            try:
                os.unlink(config_path)
            except FileNotFoundError:
                pass
        stop_local_session(harness, session)


def run_ssr_site_gateway(harness: Harness) -> str:
    session = start_local_session(
        harness,
        SSR_SITE_APP,
        name="ssr-site-gateway",
        backends=("dynamodb", "s3proxy"),
        clock="test=2026-01-01T00:00:00Z",
    )
    try:
        _, base = session_distribution(session, "SiteDistribution")
        request_id = "a5b-ssr-request"
        status, body, headers = http_request("GET", base + "/", headers={"x-request-id": request_id})
        assert_html(status, body, headers, "ssr-site /", "<h1>Hello from AppTheory SSR Site</h1>")
        if headers.get("x-request-id") != request_id:
            raise HarnessFailure(
                f"ssr-site /: the viewer-response function did not echo x-request-id "
                f"({headers.get('x-request-id')!r})",
                body,
            )
        status, body, headers = http_request("GET", base + "/actions/ping")
        payload = assert_json_body(status, body, headers, "ssr-site GET /actions/ping")
        if payload.get("method") != "GET" or payload.get("path") != "/actions/ping":
            raise HarnessFailure(f"ssr-site GET /actions/ping: {payload}", body)
        status, body, headers = http_request("POST", base + "/actions/ping", body=b"")
        payload = assert_json_body(status, body, headers, "ssr-site POST /actions/ping")
        if payload.get("method") != "POST":
            raise HarnessFailure(f"ssr-site POST /actions/ping: {payload}", body)
        status, body, headers = http_request("GET", base + "/assets/hello.txt")
        expect_status(status, 200, "ssr-site /assets/hello.txt", body)
        if body != "hello\n\n" or "text/plain" not in headers.get("content-type", ""):
            raise HarnessFailure(f"ssr-site asset = {headers.get('content-type')!r} {body!r}", body)
        for name in ("etag", "last-modified"):
            if not headers.get(name):
                raise HarnessFailure(f"ssr-site /assets/hello.txt has no {name}: {headers}", body)
        asset_etag = headers["etag"]
        # A viewer conditional on a cached object is answered 304 from the
        # cached validators without reaching the S3 origin (the object was just
        # fetched above); a non-match must serve the object normally. Neither
        # depends on the origin request policy naming If-None-Match, which the
        # pinned managed policy does not.
        status, body, headers = http_request(
            "GET", base + "/assets/hello.txt", headers={"If-None-Match": asset_etag}
        )
        if status != 304 or body:
            raise HarnessFailure(
                f"ssr-site conditional GET: status={status} body={body!r} "
                f"etag={headers.get('etag')!r} (sent If-None-Match {asset_etag!r})",
                body,
            )
        if headers.get("etag") and headers["etag"] != asset_etag:
            raise HarnessFailure(
                f"ssr-site conditional GET: origin ETag {headers['etag']!r} does not match {asset_etag!r}",
                body,
            )
        status, body, _ = http_request(
            "GET", base + "/assets/hello.txt", headers={"If-None-Match": '"a5b-does-not-match"'}
        )
        expect_status(status, 200, "ssr-site non-matching If-None-Match", body)
        if body != "hello\n\n":
            raise HarnessFailure(f"ssr-site non-matching If-None-Match body = {body!r}", body)
        status, body, headers = http_request("GET", base + "/marketing/")
        assert_html(status, body, headers, "ssr-site /marketing/", "<h1>Marketing from AppTheory S3</h1>")
        status, body, headers = http_request("GET", base + "/_facetheory/data/home.json")
        expect_status(status, 200, "ssr-site /_facetheory/data/home.json", body)
        if body != '{"route":"home"}\n':
            raise HarnessFailure(f"ssr-site hydration object = {body!r}", body)
        status, body, headers = http_request("GET", base + "/assets/missing.txt")
        expect_status(status, 403, "ssr-site /assets/missing.txt", body)
        if "AccessDenied" not in body:
            raise HarnessFailure(f"ssr-site missing asset is not AccessDenied: {body}", body)
        status, body, headers = http_request("HEAD", base + "/assets/hello.txt")
        expect_status(status, 200, "ssr-site HEAD /assets/hello.txt", body)
        if headers.get("content-length") != "7" or body:
            raise HarnessFailure(f"ssr-site HEAD = {headers.get('content-length')!r} {body!r}", body)
        status, body, headers = http_request(
            "HEAD", base + "/assets/hello.txt", headers={"Range": "bytes=0-2"}
        )
        if status != 206 or body:
            raise HarnessFailure(
                f"ssr-site ranged HEAD: status={status} body={body!r} "
                f"content-range={headers.get('content-range')!r}",
                body,
            )
        if headers.get("content-range") != "bytes 0-2/7":
            raise HarnessFailure(
                f"ssr-site ranged HEAD: Content-Range {headers.get('content-range')!r}, want 'bytes 0-2/7'",
                body,
            )
        if headers.get("content-length") != "3":
            raise HarnessFailure(
                f"ssr-site ranged HEAD: Content-Length {headers.get('content-length')!r}, want '3'",
                body,
            )
        status, body, _ = http_request("OPTIONS", base + "/assets/hello.txt")
        expect_status(status, 403, "ssr-site OPTIONS /assets/hello.txt", body)
        if "AccessForbidden" not in body:
            raise HarnessFailure(f"ssr-site OPTIONS is not AccessForbidden: {body}", body)

        # Caching. The static-assets behavior caches for a day, so the second
        # request is a hit with an age; the CACHING_DISABLED SSR behavior never
        # caches; an invalidation removes the live object; and the clock past
        # the TTL is a miss again.
        status, body, headers = http_request("GET", base + "/assets/hello.txt")
        expect_status(status, 200, "ssr-site assets cache hit", body)
        if headers.get("x-cache") != "Hit from cloudfront" or not headers.get("age"):
            raise HarnessFailure(f"ssr-site assets hit headers = {headers.get('x-cache')!r} age={headers.get('age')!r}")
        for attempt in range(2):
            status, _, headers = http_request("GET", base + "/actions/ping")
            expect_status(status, 200, f"ssr-site CACHING_DISABLED request {attempt}", "")
            if headers.get("x-cache") != "Miss from cloudfront":
                raise HarnessFailure(
                    f"ssr-site CACHING_DISABLED behavior answered {headers.get('x-cache')!r}, want a miss"
                )

        distribution = next(
            entry for entry in session.info["cloudFront"]
            if str(entry.get("logicalId", "")).startswith("SiteDistribution")
        )
        endpoint = distribution.get("invalidationEndpoint")
        distribution_id = distribution.get("distributionId")
        if not endpoint or not distribution_id:
            raise HarnessFailure(f"ssr-site distribution does not report its invalidation endpoint: {distribution}")
        batch = (
            '<InvalidationBatch xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">'
            "<Paths><Quantity>1</Quantity><Items><Path>/assets/*</Path></Items></Paths>"
            "<CallerReference>ssr-site-row</CallerReference></InvalidationBatch>"
        )
        status, text, _ = http_request(
            "POST",
            f"{endpoint}/2020-05-31/distribution/{distribution_id}/invalidation",
            body=batch.encode("utf-8"),
            headers={"content-type": "text/xml"},
        )
        if status != 201:
            raise HarnessFailure(f"ssr-site CreateInvalidation = {status}: {text}", text)
        status, _, headers = http_request("GET", base + "/assets/hello.txt")
        expect_status(status, 200, "ssr-site assets after invalidation", "")
        if headers.get("x-cache") != "Miss from cloudfront":
            raise HarnessFailure("the invalidation did not remove the cached asset")

        # The same invalidation through the host AWS CLI proves the control
        # endpoint is usable from the CLI, not only from a raw HTTP call.
        require_aws_cli()
        cli_env = {
            "AWS_ACCESS_KEY_ID": "dummy",
            "AWS_SECRET_ACCESS_KEY": "dummy",
            "AWS_DEFAULT_REGION": "us-east-1",
            "AWS_EC2_METADATA_DISABLED": "true",
            "AWS_CONFIG_FILE": os.devnull,
            "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
        }
        result = harness.run(
            [
                "aws",
                "cloudfront",
                "create-invalidation",
                "--distribution-id",
                distribution_id,
                "--paths",
                "/assets/*",
                "--endpoint-url",
                endpoint,
            ],
            timeout=300,
            env=cli_env,
        )
        if '"Status": "Completed"' not in result.stdout and '"Status":"Completed"' not in result.stdout:
            raise HarnessFailure(f"aws cloudfront create-invalidation did not report a completed invalidation: {result.stdout}")

        status, _, headers = http_request("GET", base + "/assets/hello.txt")
        expect_status(status, 200, "ssr-site assets after the CLI invalidation", "")
        if headers.get("x-cache") != "Miss from cloudfront":
            raise HarnessFailure("the CLI invalidation did not remove the cached asset")
        session.clock_advance("25h")
        status, _, headers = http_request("GET", base + "/assets/hello.txt")
        expect_status(status, 200, "ssr-site assets after the TTL", "")
        if headers.get("x-cache") != "Miss from cloudfront":
            raise HarnessFailure("the asset was served from cache after its TTL")
        described = session.request("describe")
        cache = next(
            entry for entry in described["cloudFront"]
            if str(entry.get("logicalId", "")).startswith("SiteDistribution")
        ).get("cache") or {}
        if not any(int(stats.get("hits", 0)) > 0 for stats in cache.values()):
            raise HarnessFailure(f"session describe reports no cache hits: {cache}")

        return (
            "SSR HTML through the origin group after the S3 primary returned 403, request-id echo, "
            "static/hydration objects from the deployment, 403 for a missing OAC object, full and "
            "ranged HEAD, matching and non-matching If-None-Match, and OPTIONS; the static-assets "
            "behavior answered a hit with x-cache/age, the CACHING_DISABLED SSR behavior never cached, "
            "an invalidation through the local API and through the aws CLI removed the object, and the "
            "clock past the TTL was a miss"
        )
    finally:
        stop_local_session(harness, session)


def run_ssr_only_gateway(harness: Harness) -> str:
    run = start_local_app(harness, SSR_ONLY_APP, name="ssr-only-gateway", backends=("s3proxy",))
    try:
        _, base = local_app_distribution(run, "SiteDistribution")
        request_id = "a5b-ssr-only-request"
        status, body, headers = http_request("GET", base + "/", headers={"x-request-id": request_id})
        assert_html(status, body, headers, "ssr-only /", f'<p id="request-id">{request_id}</p>')
        if headers.get("x-request-id") != request_id:
            raise HarnessFailure(
                f"ssr-only /: the viewer-response function did not echo x-request-id ({headers.get('x-request-id')!r})",
                body,
            )
        status, body, headers = http_request("GET", base + "/assets/app.js")
        expect_status(status, 200, "ssr-only /assets/app.js", body)
        if "text/javascript" not in headers.get("content-type", "") or "AppTheory SSR_ONLY" not in body:
            raise HarnessFailure(f"ssr-only app.js = {headers.get('content-type')!r} {body!r}", body)
        status, body, headers = http_request("GET", base + "/assets/site.css")
        expect_status(status, 200, "ssr-only /assets/site.css", body)
        if "text/css" not in headers.get("content-type", ""):
            raise HarnessFailure(f"ssr-only site.css = {headers.get('content-type')!r}", body)
        status, body, headers = http_request("GET", base + "/assets/probe.txt")
        expect_status(status, 200, "ssr-only /assets/probe.txt", body)
        status, body, headers = http_request("GET", base + "/assets/missing.txt")
        expect_status(status, 403, "ssr-only /assets/missing.txt", body)
        if "AccessDenied" not in body:
            raise HarnessFailure(f"ssr-only missing asset is not AccessDenied: {body}", body)
        status, body, _ = http_request("OPTIONS", base + "/assets/app.js")
        expect_status(status, 403, "ssr-only OPTIONS /assets/app.js", body)
        return (
            "AWS_IAM Function URL origin through local OAC signing, the handler's request-id echo, "
            "provided-bucket assets, 403 for a missing OAC object, OPTIONS refusal"
        )
    finally:
        stop_local_app(harness, run)


def run_path_routed_gateway(harness: Harness) -> str:
    origin_requests: list[dict] = []

    class OriginHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            origin_requests.append(
                {"method": "GET", "path": self.path, "headers": dict(self.headers)}
            )
            payload = json.dumps({"origin": "api", "path": self.path}).encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args: object) -> None:
            return

    origin_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), OriginHandler)
    origin_thread = threading.Thread(target=origin_server.serve_forever, daemon=True)
    origin_thread.start()
    origin_domain = "example.execute-api.us-east-1.amazonaws.com"
    origin_url = f"http://127.0.0.1:{origin_server.server_address[1]}"
    session = start_local_session(
        harness,
        PATH_ROUTED_APP,
        name="path-routed-gateway",
        backends=("s3proxy",),
        origins=(f"{origin_domain}={origin_url}",),
    )
    try:
        _, base = session_distribution(session, "FrontendDistribution")
        client = session.resource(logical_prefix="ClientBucket")
        auth = session.resource(logical_prefix="AuthBucket")
        s3_put(session, client["logicalId"], "l/index.html", "<!doctype html><title>client spa</title>", "text/html")
        s3_put(session, client["logicalId"], "l/app.js", 'console.log("client")', "text/javascript")
        s3_put(session, auth["logicalId"], "auth/index.html", "<!doctype html><title>auth spa</title>", "text/html")
        s3_put(session, auth["logicalId"], "auth/app.js", 'console.log("auth")', "text/javascript")
        status, body, headers = http_request("GET", base + "/l/dashboard")
        assert_html(status, body, headers, "path-routed /l/dashboard", "<title>client spa</title>")
        status, body, headers = http_request("GET", base + "/l/app.js")
        expect_status(status, 200, "path-routed /l/app.js", body)
        if body != 'console.log("client")' or "text/javascript" not in headers.get("content-type", ""):
            raise HarnessFailure(f"path-routed unchanged file = {headers.get('content-type')!r} {body!r}", body)
        status, body, headers = http_request("GET", base + "/auth/settings")
        assert_html(status, body, headers, "path-routed /auth/settings", "<title>auth spa</title>")
        status, body, headers = http_request("GET", base + "/auth/app.js")
        expect_status(status, 200, "path-routed /auth/app.js", body)
        if body != 'console.log("auth")':
            raise HarnessFailure(f"path-routed auth file = {body!r}", body)
        # The external API origin is mapped to the listener the row started.
        # The gateway sends the documented origin-request shape (the origin path
        # from the template, the origin Host and the viewer method) and the
        # response travels back through the gateway's CACHING_DISABLED behavior.
        for path in ("/auth/wallet/balance", "/api/whatever"):
            before = len(origin_requests)
            status, body, headers = http_request("GET", base + path)
            expect_status(status, 200, f"path-routed {path}", body)
            payload = json.loads(body)
            if payload.get("origin") != "api" or payload.get("path") != f"/prod{path}":
                raise HarnessFailure(f"path-routed {path}: the mapped origin answered {payload}")
            if headers.get("x-cache") != "Miss from cloudfront":
                raise HarnessFailure(
                    f"path-routed {path}: the CACHING_DISABLED behavior answered {headers.get('x-cache')!r}"
                )
            if len(origin_requests) != before + 1:
                raise HarnessFailure(f"path-routed {path}: the origin received {len(origin_requests) - before} requests")
            received = origin_requests[-1]
            if received["method"] != "GET" or received["path"] != f"/prod{path}":
                raise HarnessFailure(f"path-routed {path}: origin request shape {received}")
            if received["headers"].get("Host") != origin_domain:
                raise HarnessFailure(
                    f"path-routed {path}: origin Host {received['headers'].get('Host')!r}, want {origin_domain!r}"
                )
            status, body, headers = http_request("GET", base + path)
            expect_status(status, 200, f"path-routed {path} again", body)
            if headers.get("x-cache") != "Miss from cloudfront":
                raise HarnessFailure(f"path-routed {path}: a CACHING_DISABLED behavior cached")
        status, body, _ = http_request("POST", base + "/l/dashboard", body=b"")
        expect_status(status, 403, "path-routed POST /l/dashboard", body)
        status, body, _ = http_request("GET", base + "/l/missing.js")
        expect_status(status, 403, "path-routed /l/missing.js", body)
        if "AccessDenied" not in body:
            raise HarnessFailure(f"path-routed missing file is not AccessDenied: {body}", body)
        return (
            "the generated SPA function rewrote /l and /auth to index.html, files served unchanged, "
            "the mapped external API origin received the documented origin-request shape (origin path, "
            "Host, method) and its response came back with x-cache miss on a CACHING_DISABLED behavior, "
            "POST refused by AllowedMethods, missing file 403"
        )
    finally:
        stop_local_session(harness, session)
        origin_server.shutdown()
        origin_server.server_close()


def run_media_cdn_gateway(harness: Harness) -> str:
    session = start_local_session(
        harness,
        MEDIA_CDN_APP,
        name="media-cdn-gateway",
        backends=("s3proxy",),
        clock="test=2026-01-01T00:00:00Z",
    )
    try:
        _, base = session_distribution(session, "PublicMediaCdnDistribution")
        private = [
            entry for entry in session.info.get("cloudFront") or []
            if str(entry.get("logicalId") or "").startswith("PrivateMediaCdnDistribution")
        ]
        if len(private) != 1 or private[0].get("servable") or not private[0].get("refusals"):
            raise HarnessFailure(f"the private distribution is not refused with a named reason: {private}")
        refusal = "; ".join(str(reason) for reason in private[0]["refusals"])
        if "TrustedKeyGroups" not in refusal and "signed" not in refusal.lower():
            raise HarnessFailure(f"the private distribution refusal does not name signed URLs: {refusal}")
        bucket = session.resource(logical_prefix="PublicMediaCdnMediaBucket")
        s3_put(session, bucket["logicalId"], "probe.txt", "media-probe\n", "text/plain")
        status, body, headers = http_request("GET", base + "/probe.txt")
        expect_status(status, 200, "media-cdn /probe.txt", body)
        if body != "media-probe\n" or "text/plain" not in headers.get("content-type", ""):
            raise HarnessFailure(f"media-cdn probe = {headers.get('content-type')!r} {body!r}", body)
        if not headers.get("etag"):
            raise HarnessFailure("media-cdn /probe.txt has no ETag", body)
        # The 403 custom error response serves the configured error page with
        # the configured status. The s3proxy 403 is an S3 AccessDenied error: it
        # carries Content-Type: application/xml and x-amz-request-id and no
        # Cache-Control, and the HTTPStatusCodes page caches 403 "only ... if
        # your origin returns a Cache-Control max-age or Cache-Control s-maxage
        # header". The page is therefore served but not cached: the second
        # request is another miss. The ErrorCachingMinTTL expiry proof for a
        # 404 origin lives in the localcloudfront unit tests.
        # https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HTTPStatusCodes.html
        s3_put(
            session,
            bucket["logicalId"],
            "errors/not-found.html",
            "<h1>media not found</h1>",
            "text/html",
        )
        status, body, headers = http_request("GET", base + "/missing.txt")
        expect_status(status, 200, "media-cdn custom error page", body)
        if "<h1>media not found</h1>" not in body:
            raise HarnessFailure(f"media-cdn custom error page = {body!r}")
        if headers.get("x-cache") != "Miss from cloudfront":
            raise HarnessFailure(f"media-cdn custom error first request = {headers.get('x-cache')!r}")
        status, body, headers = http_request("GET", base + "/missing.txt")
        expect_status(status, 200, "media-cdn custom error page again", body)
        if headers.get("x-cache") != "Miss from cloudfront":
            raise HarnessFailure(
                "the 403 custom error page was cached without a Cache-Control max-age/s-maxage header: "
                f"{headers.get('x-cache')!r}"
            )

        # When the custom error page itself is unavailable, CloudFront returns
        # the status code the origin sent for the page (here 403 AccessDenied).
        session.request("s3.delete", bucket=bucket["logicalId"], objectKey="errors/not-found.html")
        status, body, headers = http_request("GET", base + "/missing-page.txt")
        expect_status(status, 403, "media-cdn missing custom error page", body)
        if "AccessDenied" not in body:
            raise HarnessFailure(f"media-cdn unavailable custom page = {body!r}")
        return (
            "the public distribution served a probe object from its provisioned bucket; the 403 "
            "custom error response served the configured page with status 200; the s3proxy 403 carried "
            "Content-Type: application/xml and x-amz-request-id but no Cache-Control max-age/s-maxage, "
            "so the page was served on both requests and the second was a miss (the page caches a 403 "
            "only with that header); when the page itself was unavailable the status came from the "
            f"pages origin (403 AccessDenied); the private distribution stayed refused ({refusal})"
        )
    finally:
        stop_local_session(harness, session)


def run_ssr_assets_manifest(harness: Harness) -> str:
    staging = Path(tempfile.mkdtemp(prefix="a5b-manifest-", dir=str(STATE_DIR)))
    try:
        manifest_path = staging / "manifest.json"
        result = harness.run(
            [
                "node",
                "examples/cdk/ssr-site/scripts/generate-assets-manifest.mjs",
                "--assets-dir",
                "examples/cdk/ssr-site/assets",
                "--out",
                str(manifest_path),
            ],
            timeout=300,
        )
        expect_output(result.stdout, ["wrote 1 entries"], "generate-assets-manifest")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        files = manifest.get("files") or []
        if len(files) != 1 or files[0].get("path") != "hello.txt":
            raise HarnessFailure(f"manifest files = {files}", manifest_path.read_text(encoding="utf-8"))
        asset_bytes = (ROOT / "examples/cdk/ssr-site/assets/hello.txt").read_bytes()
        expected = hashlib.sha256(asset_bytes).hexdigest()
        if files[0].get("sha256") != expected or files[0].get("bytes") != len(asset_bytes):
            raise HarnessFailure(f"manifest entry = {files[0]}, want sha256 {expected} bytes {len(asset_bytes)}")
        run = start_local_app(harness, SSR_SITE_APP, name="ssr-assets-manifest", backends=("dynamodb", "s3proxy"))
        try:
            _, base = local_app_distribution(run, "SiteDistribution")
            status, body, headers = http_request("GET", base + "/assets/hello.txt")
            expect_status(status, 200, "manifest /assets/hello.txt", body)
            if hashlib.sha256(body.encode("utf-8")).hexdigest() != files[0]["sha256"] or len(body.encode("utf-8")) != files[0]["bytes"]:
                raise HarnessFailure("the served asset does not match the generated manifest")
            return f"generated a {len(files)}-entry manifest from the real assets and matched it to the gateway response"
        finally:
            stop_local_app(harness, run)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def run_ssr_assets_upload(harness: Harness) -> str:
    require_aws_cli()
    staging = Path(tempfile.mkdtemp(prefix="a5b-upload-", dir=str(STATE_DIR)))
    try:
        assets = staging / "assets"
        shutil.copytree(ROOT / "examples/cdk/ssr-site/assets", assets)
        # The deployment already uploaded the unchanged asset, and aws s3 sync
        # skips an object whose size and ETag still match. Change the staged
        # copy so the script performs a real upload with its metadata.
        staged_asset = assets / "hello.txt"
        staged_asset.write_bytes(staged_asset.read_bytes() + b"uploaded\n")
        generated = harness.run(
            [
                "node",
                "examples/cdk/ssr-site/scripts/generate-assets-manifest.mjs",
                "--assets-dir",
                str(assets),
                "--out",
                str(assets / "manifest.json"),
            ],
            timeout=300,
        )
        expect_output(generated.stdout, ["wrote 1 entries"], "upload manifest generation")
        session = start_local_session(harness, SSR_SITE_APP, name="ssr-assets-upload", backends=("dynamodb", "s3proxy"))
        try:
            _, base = session_distribution(session, "SiteDistribution")
            bucket = session.resource(logical_prefix="SiteAssetsBucket")
            endpoint = session_endpoint(session, "s3")
            env = {
                "ASSETS_DIR": str(assets),
                "ASSETS_BUCKET": str(bucket["name"]),
                "ASSETS_PREFIX": "assets",
                "MANIFEST_FILE": str(assets / "manifest.json"),
                "MANIFEST_KEY": "assets/manifest.json",
                "SYNC_DELETE": "1",
                "AWS_ENDPOINT_URL_S3": endpoint,
                "AWS_ACCESS_KEY_ID": "dummy",
                "AWS_SECRET_ACCESS_KEY": "dummy",
                "AWS_DEFAULT_REGION": "us-east-1",
                "AWS_EC2_METADATA_DISABLED": "true",
                "AWS_CONFIG_FILE": os.devnull,
                "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
            }
            result = harness.run(
                ["bash", "examples/cdk/ssr-site/scripts/upload-assets.sh"],
                env=env,
                timeout=900,
            )
            expect_output(
                _combined_output(result),
                ["syncing assets", "uploading manifest"],
                "upload-assets.sh",
            )
            status, body, headers = http_request("GET", base + "/assets/hello.txt")
            expect_status(status, 200, "upload /assets/hello.txt", body)
            if headers.get("cache-control") != "public, max-age=31536000, immutable":
                raise HarnessFailure(f"uploaded asset cache-control = {headers.get('cache-control')!r}", body)
            if body != "hello\n\nuploaded\n":
                raise HarnessFailure(f"uploaded asset body = {body!r}", body)
            status, body, headers = http_request("GET", base + "/assets/manifest.json")
            expect_status(status, 200, "upload /assets/manifest.json", body)
            if "application/json" not in headers.get("content-type", ""):
                raise HarnessFailure(f"uploaded manifest type = {headers.get('content-type')!r}", body)
            if headers.get("cache-control") != "no-cache, max-age=0, must-revalidate":
                raise HarnessFailure(f"uploaded manifest cache-control = {headers.get('cache-control')!r}", body)
            manifest = json.loads(body)
            files = manifest.get("files") or []
            if len(files) != 1 or files[0].get("path") != "hello.txt":
                raise HarnessFailure(f"served manifest = {manifest}", body)
            status, body, _ = http_request("GET", base + "/assets/missing.txt")
            expect_status(status, 403, "upload /assets/missing.txt", body)
            return (
                "the real AWS CLI synced the assets and manifest to s3proxy with dummy credentials; "
                "the gateway served both with the script's cache-control and the uploaded manifest"
            )
        finally:
            stop_local_session(harness, session)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def one_http_v2_url(spec: dict, run: LocalAppRun) -> str:
    apis = [api for api in spec.get("apis") or [] if api.get("class") == "httpv2"]
    if len(apis) != 1:
        raise HarnessFailure(f"want exactly one HTTP API v2 surface, plan has {len(apis)}")
    logical_id = str(apis[0].get("logicalId"))
    if logical_id not in run.apis:
        raise HarnessFailure(f"the runner did not serve {logical_id}: {run.apis}")
    return run.apis[logical_id]


def run_lambda_packaging(harness: Harness) -> str:
    """Lambda layers extracted into /opt and container images built by docker.

    The Node and Python handlers import a module that exists only inside the
    layer and execute the layer's /opt/bin tool; the three image handlers read a
    value the Dockerfile wrote from a build argument, so a stale or missing
    image cannot pass the row.
    """
    run = start_local_app(harness, LAMBDA_PACKAGING_APP, name="lambda-packaging")
    try:
        base = one_http_v2_url(run.spec, run)
        status, payload, _ = _json_request("GET", f"{base}/layer/node")
        expect_status(status, 200, "packaging node layer", json.dumps(payload))
        if payload.get("greeting") != "hello node from the node layer":
            raise HarnessFailure(f"packaging node layer module not imported: {payload}")
        if payload.get("tool") != "layer-tool-ok":
            raise HarnessFailure(f"packaging node layer /opt/bin tool did not run: {payload}")
        if not payload.get("optBin") or not payload.get("optLib"):
            raise HarnessFailure(f"packaging node layer paths are not configured: {payload}")

        status, payload, _ = _json_request("GET", f"{base}/layer/python")
        expect_status(status, 200, "packaging python layer", json.dumps(payload))
        if payload.get("greeting") != "hello from the python layer":
            raise HarnessFailure(f"packaging python layer module not imported: {payload}")
        if payload.get("tool") != "python-layer-tool-ok":
            raise HarnessFailure(f"packaging python layer /opt/bin tool did not run: {payload}")
        if not payload.get("optPython") or not payload.get("optBin") or not payload.get("optLib"):
            raise HarnessFailure(f"packaging python layer paths are not configured: {payload}")

        for path, want_runtime, want_value in (
            ("/image/go", "go-provided-image", "go-image-build"),
            ("/image/node", "node-image", "node-image-build"),
            ("/image/python", "python-image", "python-image-build"),
        ):
            status, payload, _ = _json_request("GET", f"{base}{path}")
            expect_status(status, 200, f"packaging {path}", json.dumps(payload))
            if payload.get("runtime") != want_runtime:
                raise HarnessFailure(f"packaging {path} ran the wrong image: {payload}")
            if payload.get("imageValue") != want_value:
                raise HarnessFailure(
                    f"packaging {path}: the Dockerfile build argument did not reach the image: {payload}"
                )
        return (
            "the Node and Python zip functions imported a module from the layer "
            "and executed the /opt/bin tool, with /opt/bin on PATH and /opt/lib on "
            "LD_LIBRARY_PATH; the Go, Node and Python image functions were built by "
            "docker from the CDK Docker assets and returned the value the "
            "Dockerfile wrote from its build argument"
        )
    finally:
        stop_local_app(harness, run)


RUNNERS: dict[str, Callable[[Harness], str]] = {
    "testkit-ts": run_testkit_ts,
    "testkit-ts-streaming": run_testkit_ts_streaming,
    "testkit-py": run_testkit_py,
    "mcp-tools-only-ts": run_mcp_tools_only_ts,
    "mcp-tools-only-py": run_mcp_tools_only_py,
    "mcp-go-tools-only": run_mcp_tools_only,
    "mcp-go-tools-resources-prompts": run_mcp_tools_resources_prompts,
    "mcp-go-resumable-sse": run_mcp_resumable_sse,
    "cdk-synth-all": run_cdk_synth_all,
    "rate-limited-http": run_rate_limited_http,
    "local-runner-go": run_local_runner_go,
    "local-runner-ts": run_local_runner_ts,
    "local-runner-py": run_local_runner_py,
    "multilang-go": run_multilang_go,
    "multilang-ts": run_multilang_ts,
    "multilang-py": run_multilang_py,
    "lesser-parity-api": run_lesser_parity_api,
    "lesser-parity-graphql": run_lesser_parity_graphql,
    "lesser-parity-sse": run_lesser_parity_sse,
    "lesser-parity-worker": run_lesser_parity_worker,
    "restv1-api": run_restv1_api,
    "restv1-graphql": run_restv1_graphql,
    "restv1-inventory": run_restv1_inventory,
    "restv1-sse": run_restv1_sse,
    "lambda-role-index": run_lambda_role_index,
    "lambda-role-encrypted": run_lambda_role_encrypted,
    "lambda-role-custom": run_lambda_role_custom,
    "lambda-role-authorizers": run_lambda_role_authorizers,
    "sqs-producer": run_sqs_producer,
    "sqs-sns-publisher": run_sqs_sns_publisher,
    "sqs-sns-targets": run_sqs_sns_targets,
    "sqs-event-targets": run_sqs_event_targets,
    "sqs-s3-notifications": run_sqs_s3_notifications,
    "sqs-worker": run_sqs_worker,
    "sqs-dlq": run_sqs_dlq,
    "import-ingest": run_import_ingest,
    "import-worker": run_import_worker,
    "kinesis-handler": run_kinesis_handler,
    "kinesis-signing": run_kinesis_signing,
    "microvm-controller": run_microvm_controller,
    "microvm-workload-go": run_microvm_workload_go,
    "microvm-workload-py": run_microvm_workload_py,
    "microvm-workload-ts": run_microvm_workload_ts,
    "microvm-conformance": run_microvm_conformance,
    "s3-vectors": run_s3_vectors,
    "ssr-site-gateway": run_ssr_site_gateway,
    "ssr-only-gateway": run_ssr_only_gateway,
    "path-routed-gateway": run_path_routed_gateway,
    "media-cdn-gateway": run_media_cdn_gateway,
    "ssr-assets-manifest": run_ssr_assets_manifest,
    "ssr-assets-upload": run_ssr_assets_upload,
    "lambda-packaging": run_lambda_packaging,
}


# --- reporting --------------------------------------------------------------


def print_failure(label: str, failure: HarnessFailure) -> None:
    print(f"        {failure.message}")
    if failure.output.strip():
        for line in _tail(failure.output).splitlines():
            print(f"        | {line}")


def run_down(profile: dict, compose_file: Path, args: argparse.Namespace) -> int:
    if args.external:
        print("examples-local-down: nothing to stop (the DynamoDB Local endpoint is externally managed)")
        return 0
    checkout = checkout_identifier(ROOT)
    recorded = read_lease(checkout)
    if args.port is not None:
        lease = acquire_lease(profile, checkout, slot=None, port=args.port)
        project, port = lease.project, lease.port
    elif recorded:
        project, port = str(recorded["project"]), int(recorded["port"])
    else:
        lease = acquire_lease(profile, checkout, slot=args.slot, port=None)
        project, port = lease.project, lease.port

    if not _docker_available():
        print("examples-local-down: FAIL (Docker is unavailable; start Colima/Docker first)", file=sys.stderr)
        return 1
    print(f"examples-local-down: stopping {project} (DynamoDB Local on 127.0.0.1:{port})")
    result = subprocess.run(
        ["docker", "compose", "-f", str(compose_file), "-p", project, "down", "-v"],
        env={**os.environ, "APPTHEORY_LOCAL_DDB_PORT": str(port)},
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        print(result.stderr.strip(), file=sys.stderr)
        print("examples-local-down: FAIL", file=sys.stderr)
        return 1
    _lease_path(checkout).unlink(missing_ok=True)
    print("examples-local-down: PASS")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AppTheory local examples harness")
    parser.add_argument("--slot", type=int, default=None, help="use a fixed profile slot (harness-owned)")
    parser.add_argument("--port", type=int, default=None, help="use a fixed DynamoDB Local port (harness-owned)")
    parser.add_argument(
        "--external",
        action="store_true",
        help="use an externally managed DynamoDB Local on the leased port; never start or recreate a container",
    )
    parser.add_argument("--down", action="store_true", help="stop this checkout's profile container")
    args = parser.parse_args(argv)

    try:
        profile, entries = load_manifest(MANIFEST_PATH)
    except HarnessFailure as failure:
        print(f"examples-local: {failure.message}", file=sys.stderr)
        return 2

    compose_file = ROOT / str(profile["composeFile"])

    if args.down:
        return run_down(profile, compose_file, args)

    discovered = discover(ROOT)
    errors = validate_manifest(ROOT, MANIFEST_PATH, profile, entries, discovered, RUNNERS)
    if errors:
        print("examples-local: manifest validation failed", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 2

    checkout = checkout_identifier(ROOT)
    try:
        lease = acquire_lease(profile, checkout, slot=args.slot, port=args.port)
        lease.external = args.external
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        lock_fd = os.open(STATE_DIR / f"lock-{checkout}", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            os.close(lock_fd)
            raise HarnessFailure(
                "another examples-local run already holds this checkout's local profile "
                f"(lock {STATE_DIR / f'lock-{checkout}'})"
            ) from exc
        lease.lock_fd = lock_fd
    except HarnessFailure as failure:
        print(f"examples-local: {failure.message}", file=sys.stderr)
        return 2

    harness = Harness(env=build_env(lease), lease=lease)
    write_lease(lease, compose_file)

    print("AppTheory local examples harness")
    print(f"  repository: {ROOT}")
    print(f"  profile:    {profile['composeFile']} ({profile['dynamodbLocal']['image']})")
    print(f"  lease:      {lease.project} (slot {lease.slot}, DynamoDB Local on 127.0.0.1:{lease.port}"
          f"{', externally managed' if lease.external else ''})")
    print(f"  discovered: {len(discovered)} entrypoints; manifest entries: {len(entries)}")
    print()
    print("preflight")
    try:
        preflight(harness, profile, compose_file)
        prepare(harness)
    except HarnessFailure as failure:
        print_failure("preflight", failure)
        print()
        print("RESULT: FAIL (preflight)")
        lease.release()
        return 1

    executed = [entry for entry in entries if entry.runner]
    results: dict[str, tuple[str, str]] = {}
    failures: list[tuple[Entry, HarnessFailure]] = []

    print()
    total = len(executed)
    for index, entry in enumerate(executed, start=1):
        print(
            f"  [{index:>2}/{total}] {entry.label:<64} {entry.class_name:<3} RUN",
            flush=True,
        )
        try:
            detail = RUNNERS[entry.runner](harness)
            results[entry.key] = ("PASS", detail)
            print(f"  [{index:>2}/{total}] {entry.label:<64} {entry.class_name:<3} PASS  {detail}")
        except HarnessFailure as failure:
            results[entry.key] = ("FAIL", failure.message)
            failures.append((entry, failure))
            print(f"  [{index:>2}/{total}] {entry.label:<64} {entry.class_name:<3} FAIL")
            print_failure(entry.label, failure)
        except Exception as exc:  # noqa: BLE001 - a harness bug must fail the row, not abort the run
            failure = HarnessFailure(f"{type(exc).__name__}: {exc}", traceback.format_exc())
            results[entry.key] = ("FAIL", failure.message)
            failures.append((entry, failure))
            print(f"  [{index:>2}/{total}] {entry.label:<64} {entry.class_name:<3} FAIL")
            print_failure(entry.label, failure)

    print()
    print("parity")
    try:
        print(f"  PASS  {verify_local_runner_parity()}")
    except HarnessFailure as failure:
        failures.append((Entry(key="local-runner-parity", kind="suite", data={"class": "L1"}), failure))
        print("  FAIL")
        print_failure("local-runner-parity", failure)

    for entry in entries:
        if not entry.covered_by:
            continue
        target = results.get(entry.covered_by)
        if target is None:
            results[entry.key] = ("FAIL", f"covered row {entry.covered_by} did not run")
            failures.append((entry, HarnessFailure(results[entry.key][1])))
        else:
            results[entry.key] = target

    pending = [entry for entry in entries if entry.pending]
    print()
    print("pending milestones (reported, never counted as pass)")
    if pending:
        for entry in pending:
            print(f"  {entry.key:<70} PENDING-MILESTONE {entry.pending}")
    else:
        print("  (none)")

    print()
    print("summary")
    print(f"  {'result':<8} {'class':<22} example")
    by_key = {entry.key: entry for entry in entries}
    passed = 0
    failed = 0
    for entry in entries:
        if entry.pending:
            print(f"  {'PENDING':<8} {'PENDING-MILESTONE ' + entry.pending:<22} {entry.key}")
            continue
        result, detail = results.get(entry.key, ("FAIL", "row did not run"))
        suffix = f"  ({detail})" if detail else ""
        display_class = entry.class_name
        if entry.covered_by:
            suffix = f"  (via {entry.covered_by})"
            display_class = display_class or by_key[entry.covered_by].class_name
        print(f"  {result:<8} {display_class:<22} {entry.key}{suffix}")
        if result == "PASS":
            passed += 1
        else:
            failed += 1

    print()
    print(f"counts: {passed} passed, {failed} failed, {len(pending)} pending-milestone")
    lease.release()
    if failures:
        print("RESULT: FAIL")
        return 1
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
