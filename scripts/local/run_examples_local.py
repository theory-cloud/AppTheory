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
import fcntl
import hashlib
import json
import os
import re
import select
import signal
import socket
import subprocess
import sys
import tempfile
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
LOCAL_PROFILE = "scripts/local/examples-local.json"
MCP_HANDLER_BIN_DIR = STATE_DIR / "handlers"
MCP_EXAMPLES = {
    "tools-only": "examples/mcp/tools-only",
    "tools-resources-prompts": "examples/mcp/tools-resources-prompts",
    "resumable-sse": "examples/mcp/resumable-sse",
}
LOCAL_RUNNER_READY = "local-run: ready"
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


def _go_test_json(
    harness: Harness,
    args: list[str],
    *,
    cwd: Path | None = None,
    label: str,
) -> tuple[subprocess.CompletedProcess, set[str]]:
    result = harness.run(
        ["go", "test", "-count=1", "-json", *args],
        cwd=cwd or ROOT,
        timeout=harness.timeout,
        check=False,
    )
    passed: set[str] = set()
    skipped: set[str] = set()
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        action = event.get("Action")
        test = event.get("Test")
        if action == "pass" and test:
            passed.add(test)
        elif action == "skip" and test:
            skipped.add(test)

    if skipped:
        raise HarnessFailure(
            f"{label}: {len(skipped)} test(s) skipped; a skip is a failure: {', '.join(sorted(skipped))}",
            _combined_output(result),
        )
    if result.returncode != 0:
        raise HarnessFailure(f"{label}: go test exited {result.returncode}", _combined_output(result))
    return result, passed


def _go_mcp_runner(harness: Harness, package: str, expected: set[str]) -> str:
    pattern = "^(" + "|".join(sorted(expected)) + ")$"
    _, passed = _go_test_json(
        harness,
        ["-run", pattern, package],
        label=f"go test {package}",
    )
    missing = sorted(expected - passed)
    if missing:
        raise HarnessFailure(f"{package}: tests did not run: {', '.join(missing)}")
    return f"{len(expected)} MCP protocol tests passed"


def run_mcp_go_tools_only(harness: Harness) -> str:
    return _go_mcp_runner(
        harness,
        "./examples/mcp/tools-only",
        {"TestToolsOnlyExample", "TestToolsOnlyBuildApp"},
    )


def run_mcp_go_tools_resources_prompts(harness: Harness) -> str:
    return _go_mcp_runner(
        harness,
        "./examples/mcp/tools-resources-prompts",
        {"TestToolsResourcesPromptsExample"},
    )


def run_mcp_go_resumable_sse(harness: Harness) -> str:
    return _go_mcp_runner(
        harness,
        "./examples/mcp/resumable-sse",
        {"TestResumableSSEExample"},
    )


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


def run_multilang(harness: Harness, lang: str) -> str:
    run = start_local_app(harness, MULTILANG_APP, name=f"multilang-{lang}")
    try:
        apis = run.spec.get("apis") or []
        http_apis = [api for api in apis if api.get("class") == "httpv2"]
        rest_apis = [api for api in apis if api.get("class") == "restv1"]
        if len(http_apis) != 3 or len(rest_apis) != 1:
            raise HarnessFailure(
                f"multilang plan: want 3 HTTP APIs and 1 REST API, got {len(http_apis)}/{len(rest_apis)}"
            )
        websocket = [item for item in run.spec.get("skipped") or [] if "WebSocket" in str(item.get("reason"))]
        if len(websocket) != 3:
            raise HarnessFailure(f"multilang plan: want 3 reported WebSocket APIs, got {websocket}")

        http_base = api_url(run.spec, run, f"-{lang}")
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

        rest_base = one_rest_url(run.spec, run)
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
        return (
            f"{lang} HTTP API served four assertions (200 root, 200 hello, 405 method, 404 missing); "
            f"REST API served hello and all 3 buffered SSE events; 3 WebSocket APIs reported not served"
        )
    finally:
        stop_local_app(harness, run)


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
    event = {
        "Records": [
            {
                "messageId": "a3b-valid",
                "receiptHandle": "a3b-receipt-1",
                "body": json.dumps({"ok": True}),
                "attributes": {
                    "ApproximateReceiveCount": "1",
                    "SentTimestamp": "1793610000000",
                    "SenderId": "dummy",
                    "ApproximateFirstReceiveTimestamp": "1793610000000",
                },
                "messageAttributes": {},
                "md5OfBody": "0",
                "eventSource": "aws:sqs",
                "eventSourceARN": "arn:aws:sqs:us-east-1:123456789012:lesser-parity-events",
                "awsRegion": "us-east-1",
            },
            {
                "messageId": "a3b-invalid",
                "receiptHandle": "a3b-receipt-2",
                "body": "not-json",
                "attributes": {
                    "ApproximateReceiveCount": "1",
                    "SentTimestamp": "1793610000000",
                    "SenderId": "dummy",
                    "ApproximateFirstReceiveTimestamp": "1793610000000",
                },
                "messageAttributes": {},
                "md5OfBody": "0",
                "eventSource": "aws:sqs",
                "eventSourceARN": "arn:aws:sqs:us-east-1:123456789012:lesser-parity-events",
                "awsRegion": "us-east-1",
            },
        ]
    }
    decoded, _ = invoke_local_function(
        harness,
        app=LESSER_PARITY_APP,
        function="WorkerFn847949AF",
        event=event,
        name="lesser-worker",
    )
    if decoded.get("proxy"):
        raise HarnessFailure(f"lesser-parity worker: unexpected proxy response {decoded}")
    raw = decoded.get("raw") or {}
    failures = raw.get("batchItemFailures") or []
    if failures != [{"itemIdentifier": "a3b-invalid"}]:
        raise HarnessFailure(f"lesser-parity worker: unexpected partial failures {failures}")
    return "generated SQS batch processed; the invalid record was returned as a partial batch failure"


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
        decoded, _ = invoke_local_function(
            harness,
            app=LAMBDA_ROLE_APP,
            function="CustomFnFE03B841",
            event={},
            name="lambda-role-custom",
            backends=("moto", "s3proxy"),
        )
        body = _proxy_body(decoded, "lambda-role custom")
        s3_object = body.get("s3Object") or {}
        if (
            decoded.get("statusCode") != 200
            or body.get("message") != "S3 and SSM operations successful"
            or not str(s3_object.get("bucket", "")).startswith("local-")
            or not str(s3_object.get("content", "")).startswith("{")
            or body.get("ssmParameter") != "not-configured"
        ):
            raise HarnessFailure(f"lambda-role custom: unexpected response {decoded}")
        return "custom.handler wrote and read back an object on s3proxy; the SSM lookup failed closed to not-configured"
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
    return f"a3b-{lease.checkout}-{slot}-{name}"


@dataclass
class LocalAppRun:
    process: subprocess.Popen
    log_path: str
    prefix: str
    spec: dict
    apis: dict[str, str]
    api_classes: dict[str, str]


def plan_local_app(harness: Harness, app: str, context: dict | None = None) -> dict:
    argv = [
        str(LOCAL_RUNNER_BIN),
        "plan",
        "--app",
        app,
        "--profile",
        str(ROOT / LOCAL_PROFILE),
        "--json",
    ]
    for key, value in sorted((context or {}).items()):
        argv.extend(["-c", f"{key}={value}"])
    result = harness.run(argv, timeout=1800)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise HarnessFailure(f"apptheory-local plan for {app} did not print JSON: {exc}", result.stdout) from exc


def start_local_app(
    harness: Harness,
    app: str,
    *,
    name: str,
    context: dict | None = None,
    backends: tuple[str, ...] = (),
) -> LocalAppRun:
    ensure_cdk_app(harness, app)
    spec = plan_local_app(harness, app, context)
    prefix = local_app_prefix(harness, name)
    log = tempfile.NamedTemporaryFile(prefix=f"a3b-{name}-", suffix=".log", delete=False)
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


def stop_local_app(harness: Harness, run: LocalAppRun) -> str:
    _terminate_process(run.process)
    output = Path(run.log_path).read_text(encoding="utf-8", errors="replace")
    try:
        os.unlink(run.log_path)
    except FileNotFoundError:
        pass
    expect_output(output, [LOCAL_RUNNER_READY, "shutting down"], f"apptheory-local {run.prefix} run")
    _assert_local_runner_cleanup(harness, run.prefix)
    return output


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


def one_api_url(spec: dict, run: LocalAppRun) -> str:
    apis = spec.get("apis") or []
    if len(apis) != 1:
        raise HarnessFailure(f"want exactly one HTTP API, plan has {len(apis)}")
    logical_id = str(apis[0].get("logicalId"))
    if logical_id not in run.apis:
        raise HarnessFailure(f"the runner did not serve {logical_id}: {run.apis}")
    return run.apis[logical_id]


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
