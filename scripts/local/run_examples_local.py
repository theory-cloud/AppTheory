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
    """Install the TypeScript runtime dependencies the examples and assets need.

    The TypeScript examples run on plain ``node`` against the checked-in
    ``ts/dist``; only the CDK synth the staging helper vendors into the Lambda
    assets needs ``ts/node_modules``. The repository's own install contract owns
    the stamp and the ``npm ci --ignore-scripts`` invocation, so the harness
    calls it instead of running npm itself.
    """
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


RUNNERS: dict[str, Callable[[Harness], str]] = {
    "testkit-ts": run_testkit_ts,
    "testkit-ts-streaming": run_testkit_ts_streaming,
    "testkit-py": run_testkit_py,
    "mcp-tools-only-ts": run_mcp_tools_only_ts,
    "mcp-tools-only-py": run_mcp_tools_only_py,
    "mcp-go-tools-only": run_mcp_go_tools_only,
    "mcp-go-tools-resources-prompts": run_mcp_go_tools_resources_prompts,
    "mcp-go-resumable-sse": run_mcp_go_resumable_sse,
    "cdk-synth-all": run_cdk_synth_all,
    "rate-limited-http": run_rate_limited_http,
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
