#!/usr/bin/env python3
"""Produce, verify, and schedule AppTheory validation evidence.

The evidence record binds the exact checked-in inputs a governed command set was
executed against. Verification recomputes the inputs digest from the candidate
working tree and compares it with the record; it never executes anything the
record names. Commands come only from the tracked gate registry
(``scripts/evidence/validation-gates.json``) and are executed as argv arrays,
never through a shell or ``eval``.

Collection is incremental. ``collect --all`` enumerates the required coverage,
then schedules only missing, failed, stale or affected gates. A second run over
unchanged inputs executes zero commands. ``--force`` is the explicit override;
it is never the documented default. Gates declare their input scope, resource
group and dependencies so independent work can overlap while conflicting
filesystem/build/Docker work serializes. Completed records are written atomically
as each gate finishes, so an interrupted run keeps its completed results and a
restart executes only the incomplete or changed work.

Identity is content-addressed, so it is independent of commit SHAs, branch names,
and evidence-only commits. Inputs are partitioned into disjoint sets:

* source inputs -- every tracked or untracked-but-not-ignored file except the
  dedicated evidence directory and the release-only set;
* release-only inputs -- the explicit version-coupled and regenerated artifact
  paths named in the registry.

Each gate carries its own declared input scope. A gate record stores a scope
digest computed over exactly that scope, with release-only files normalized by
substituting the recorded version literal. A documentation or evidence-only
change therefore does not invalidate product proof, while an edit inside a
gate's scope does. A file that matches no product scope and no declared
non-product path is an unknown input: every product gate falls back to broad
execution instead of silently reusing proof.

Exit codes: 0 PASS, 1 FAIL, 2 BLOCKED, 130 interrupted, 143 terminated.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import platform
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

SCHEMA_VERSION = 1
SCOPE_DIGEST_VERSION = 1
COMMAND_DIGEST_VERSION = 1
EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_BLOCKED = 2
EXIT_INTERRUPTED = 130
EXIT_TERMINATED = 143
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
GATE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
VERSION_TOKEN = b"@@APPTHEORY_VERSION@@"
SOURCE_HEADER = b"apptheory-validation-source-v1\n"
RELEASE_HEADER = b"apptheory-validation-release-v1\n"
NORMALIZED_HEADER = b"apptheory-validation-release-normalized-v1\n"
SCOPE_HEADER = b"apptheory-validation-scope-v1\n"

DEFAULT_RUNNER = {
    "maxWorkers": 2,
    "resources": {"cpu": 2, "repo-write": 1, "docker": 1, "network": 1},
}
DEFAULT_NON_PRODUCT_PATHS = [
    "docs/",
    "gov-infra/",
    ".github/",
    "scripts/",
    "reference/",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
]

RECORD_KEYS = {
    "schemaVersion",
    "gate",
    "kind",
    "description",
    "verdict",
    "reason",
    "recordedAt",
    "environment",
    "scope",
    "source",
    "releaseOnly",
    "dependency",
    "scan",
    "commands",
    "consumed",
    "reviews",
    "producer",
}

COMMAND_KEYS = {
    "id",
    "argv",
    "exitCode",
    "startedAt",
    "finishedAt",
    "durationSeconds",
    "logDigest",
    "logRef",
    "inputsDigest",
    "executed",
    "reused",
    "sharedFrom",
}


class EvidenceError(Exception):
    """A validation-evidence condition that must fail closed."""


class RunCancelled(Exception):
    """The owning run was interrupted; no partial record may be published."""


@dataclass(frozen=True)
class Registry:
    path: Path
    data: dict[str, Any]

    @property
    def evidence_directory(self) -> str:
        return self.data["evidenceDirectory"].strip("/")

    @property
    def local_log_directory(self) -> str:
        return self.data["localLogDirectory"].strip("/")

    @property
    def clock_skew_seconds(self) -> int:
        return int(self.data.get("clockSkewSeconds", 300))

    @property
    def gates(self) -> dict[str, dict[str, Any]]:
        return self.data["gates"]

    @property
    def runner(self) -> dict[str, Any]:
        runner = self.data.get("runner") or {}
        merged = {
            "maxWorkers": int(runner.get("maxWorkers", DEFAULT_RUNNER["maxWorkers"])),
            "resources": dict(DEFAULT_RUNNER["resources"]),
        }
        merged["resources"].update(
            {str(name): int(capacity) for name, capacity in (runner.get("resources") or {}).items()}
        )
        return merged

    @property
    def non_product_paths(self) -> list[str]:
        return [str(item) for item in self.data.get("nonProductPaths", DEFAULT_NON_PRODUCT_PATHS)]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def format_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_timestamp(text: Any, label: str) -> datetime:
    if not isinstance(text, str) or not text.endswith("Z"):
        raise EvidenceError(f"{label} must be an ISO-8601 UTC timestamp ending in Z")
    try:
        parsed = datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as exc:
        raise EvidenceError(f"{label} is not a valid ISO-8601 UTC timestamp: {exc}") from exc
    return parsed.replace(tzinfo=timezone.utc)


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def load_registry(path: Path) -> Registry:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise EvidenceError(f"gate registry not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise EvidenceError(f"gate registry is not valid JSON: {exc}") from exc
    if not isinstance(data, dict) or data.get("schemaVersion") != SCHEMA_VERSION:
        raise EvidenceError("gate registry schemaVersion must be 1")
    if not isinstance(data.get("gates"), dict) or not data["gates"]:
        raise EvidenceError("gate registry must declare at least one gate")
    evidence_directory = data.get("evidenceDirectory")
    if not isinstance(evidence_directory, str) or not evidence_directory.strip("/"):
        raise EvidenceError("gate registry evidenceDirectory must be a non-empty path")
    runner = data.get("runner") or {}
    if int(runner.get("maxWorkers", DEFAULT_RUNNER["maxWorkers"])) < 1:
        raise EvidenceError("gate registry runner.maxWorkers must be positive")
    for name, capacity in (runner.get("resources") or {}).items():
        if int(capacity) < 1:
            raise EvidenceError(f"gate registry resource {name!r} capacity must be positive")
    return Registry(path=path, data=data)


def repo_root(explicit: Path | None) -> Path:
    start = explicit if explicit is not None else Path.cwd()
    completed = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=start,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise EvidenceError(f"{start} is not inside a git work tree")
    root = Path(completed.stdout.strip())
    if explicit is not None and root.resolve() != start.resolve():
        raise EvidenceError(f"{start} is not the work tree root ({root})")
    return root


def repo_files(root: Path) -> list[str]:
    completed = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=root,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise EvidenceError("git ls-files failed; the input surface cannot be enumerated")
    return sorted({path for path in completed.stdout.decode("utf-8", "surrogateescape").split("\0") if path})


def read_input_bytes(root: Path, relative: str) -> tuple[int, bytes]:
    path = root / relative
    try:
        metadata = os.lstat(path)
    except FileNotFoundError as exc:
        raise EvidenceError(f"relevant input is missing from the working tree: {relative}") from exc
    if os.path.islink(path):
        return metadata.st_mode & 0o7777, b"symlink:" + os.readlink(path).encode("utf-8", "surrogateescape")
    if not os.path.isfile(path):
        raise EvidenceError(f"relevant input is not a regular file: {relative}")
    try:
        return metadata.st_mode & 0o7777, path.read_bytes()
    except OSError as exc:
        raise EvidenceError(f"cannot read relevant input {relative}: {exc}") from exc


def is_evidence_path(relative: str, evidence_directory: str) -> bool:
    return relative == evidence_directory or relative.startswith(evidence_directory + "/")


def matches_path(relative: str, pattern: str) -> bool:
    if pattern == "**":
        return True
    if pattern.endswith("/"):
        return relative.startswith(pattern)
    return fnmatch.fnmatchcase(relative, pattern)


def matches_any(relative: str, patterns: list[str]) -> bool:
    return any(matches_path(relative, pattern) for pattern in patterns)


def matches_release_only(relative: str, registry: Registry) -> bool:
    policy = registry.data["releaseOnly"]
    if relative in set(policy.get("exact", [])):
        return True
    if any(relative.startswith(prefix) for prefix in policy.get("prefixes", [])):
        return True
    return any(fnmatch.fnmatchcase(relative, pattern) for pattern in policy.get("patterns", []))


def matches_security_input(relative: str, registry: Registry) -> bool:
    policy = registry.data["securityInputs"]
    if relative in set(policy.get("exact", [])):
        return True
    return any(fnmatch.fnmatchcase(relative, pattern) for pattern in policy.get("patterns", []))


def read_version(root: Path) -> str:
    version_file = root / "VERSION"
    try:
        text = version_file.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""
    for line in text.splitlines():
        stripped = line.split("#", 1)[0].strip()
        if stripped:
            return stripped
    return ""


def normalize_release_bytes(data: bytes, version: str) -> bytes:
    if not version:
        return data
    literal = version.encode("utf-8")
    data = data.replace(b"v" + literal, VERSION_TOKEN)
    return data.replace(literal, VERSION_TOKEN)


@dataclass(frozen=True)
class FileEntry:
    mode: int
    data: bytes
    release_only: bool


@dataclass(frozen=True)
class Snapshot:
    files: dict[str, FileEntry]
    source_digest: str
    source_count: int
    release_digest: str
    release_normalized_digest: str
    release_count: int
    release_version: str
    dependency_digest: str
    dependency_count: int

    def global_identity(self) -> tuple[str, str, str]:
        return (self.source_digest, self.release_digest, self.dependency_digest)


def load_snapshot(root: Path, registry: Registry) -> Snapshot:
    evidence_directory = registry.evidence_directory
    version = read_version(root)
    files: dict[str, FileEntry] = {}
    source_lines: list[bytes] = []
    release_lines: list[bytes] = []
    normalized_lines: list[bytes] = []
    dependency_lines: list[bytes] = []
    source_count = release_count = dependency_count = 0

    for relative in repo_files(root):
        if is_evidence_path(relative, evidence_directory):
            continue
        mode, data = read_input_bytes(root, relative)
        release_only = matches_release_only(relative, registry)
        files[relative] = FileEntry(mode=mode, data=data, release_only=release_only)
        content_digest = sha256_bytes(data)
        if matches_security_input(relative, registry):
            dependency_count += 1
            dependency_lines.append(b"%d\t%s\t%s\n" % (mode, relative.encode("utf-8"), content_digest.encode("ascii")))
        if release_only:
            release_count += 1
            release_lines.append(b"%d\t%s\t%s\n" % (mode, relative.encode("utf-8"), content_digest.encode("ascii")))
            normalized = normalize_release_bytes(data, version)
            normalized_lines.append(
                b"%d\t%s\t%s\n" % (mode, relative.encode("utf-8"), sha256_bytes(normalized).encode("ascii"))
            )
        else:
            source_count += 1
            source_lines.append(b"%d\t%s\t%s\n" % (mode, relative.encode("utf-8"), content_digest.encode("ascii")))

    return Snapshot(
        files=files,
        source_digest=sha256_bytes(SOURCE_HEADER + b"".join(sorted(source_lines))),
        source_count=source_count,
        release_digest=sha256_bytes(RELEASE_HEADER + b"".join(sorted(release_lines))),
        release_normalized_digest=sha256_bytes(NORMALIZED_HEADER + b"".join(sorted(normalized_lines))),
        release_count=release_count,
        release_version=version,
        dependency_digest=sha256_bytes(SOURCE_HEADER + b"".join(sorted(dependency_lines))),
        dependency_count=dependency_count,
    )


def scope_digest(snapshot: Snapshot, patterns: list[str]) -> tuple[str, int]:
    lines: list[bytes] = []
    count = 0
    for relative in sorted(snapshot.files):
        if not matches_any(relative, patterns):
            continue
        entry = snapshot.files[relative]
        data = normalize_release_bytes(entry.data, snapshot.release_version) if entry.release_only else entry.data
        kind = b"release-normalized" if entry.release_only else b"source"
        lines.append(
            b"%d\t%s\t%s\t%s\n" % (entry.mode, relative.encode("utf-8"), kind, sha256_bytes(data).encode("ascii"))
        )
        count += 1
    payload = (
        SCOPE_HEADER
        + canonical_json({"version": SCOPE_DIGEST_VERSION, "patterns": patterns})
        + b"\n"
        + b"".join(lines)
    )
    return sha256_bytes(payload), count


def unmatched_inputs(snapshot: Snapshot, registry: Registry) -> list[str]:
    """Files that are neither release-only, nor in any gate scope, nor declared non-product.

    Such a file has unknown impact. The collector must not silently reuse proof for
    it; it falls back to broad execution and the verifier refuses a record.

    A catch-all scope (``**``) describes the rubric's own reading surface, not a
    classification of product impact. It is deliberately excluded here: an
    unknown file must force the narrow product gates to re-run rather than being
    absorbed by the rubric's broad scope.
    """
    scopes = [
        gate.get("paths", [])
        for gate in registry.gates.values()
        if gate.get("kind") == "source" and "**" not in gate.get("paths", [])
    ]
    unknown: list[str] = []
    for relative, entry in snapshot.files.items():
        if entry.release_only:
            continue
        if matches_security_input(relative, registry):
            continue
        if matches_any(relative, registry.non_product_paths):
            continue
        if any(matches_any(relative, patterns) for patterns in scopes):
            continue
        unknown.append(relative)
    return sorted(unknown)


_ENVIRONMENT_CACHE: dict[str, Any] | None = None
_ENVIRONMENT_LOCK = threading.Lock()


def probe_environment() -> dict[str, Any]:
    global _ENVIRONMENT_CACHE
    with _ENVIRONMENT_LOCK:
        if _ENVIRONMENT_CACHE is not None:
            return _ENVIRONMENT_CACHE
        go_version = ""
        completed = subprocess.run(["go", "version"], capture_output=True, text=True, check=False)
        if completed.returncode == 0:
            fields = completed.stdout.split()
            if len(fields) >= 3 and fields[1] == "version":
                go_version = fields[2]
        node_version = ""
        completed = subprocess.run(["node", "--version"], capture_output=True, text=True, check=False)
        if completed.returncode == 0:
            node_version = completed.stdout.strip()
        python_version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
        _ENVIRONMENT_CACHE = {
            "go": go_version,
            "node": node_version,
            "python": python_version,
            "platform": {
                "os": "darwin" if sys.platform == "darwin" else "linux" if sys.platform.startswith("linux") else sys.platform,
                "arch": platform.machine(),
            },
        }
        return _ENVIRONMENT_CACHE


def environment_subset(environment: dict[str, Any], binding: str) -> dict[str, Any]:
    if binding == "none":
        return {}
    if binding == "toolchain+platform":
        return {
            "go": environment.get("go", ""),
            "node": environment.get("node", ""),
            "python": environment.get("python", ""),
            "platform": environment.get("platform", {}),
        }
    return {
        "go": environment.get("go", ""),
        "node": environment.get("node", ""),
        "python": environment.get("python", ""),
    }


def environment_mismatch(recorded: Any, current: dict[str, Any], binding: str) -> str:
    if binding == "none":
        return ""
    if not isinstance(recorded, dict):
        return "recorded environment is missing"
    for key in ("go", "node", "python"):
        value = recorded.get(key)
        if not isinstance(value, str) or not value:
            return f"recorded {key} version is missing"
    if recorded["go"] != current["go"]:
        return f"go {recorded['go']} != {current['go']}"
    recorded_node_major = recorded["node"].lstrip("v").split(".", 1)[0]
    current_node_major = current["node"].lstrip("v").split(".", 1)[0]
    if not current_node_major or recorded_node_major != current_node_major:
        return f"node {recorded['node']} != {current['node']}"
    recorded_python = ".".join(recorded["python"].split(".")[:2])
    current_python = ".".join(current["python"].split(".")[:2])
    if recorded_python != current_python:
        return f"python {recorded['python']} != {current['python']}"
    if binding == "toolchain+platform":
        recorded_platform = recorded.get("platform") or {}
        if recorded_platform.get("os") != current["platform"]["os"] or recorded_platform.get("arch") != current["platform"]["arch"]:
            return (
                f"platform {recorded_platform.get('os')}/{recorded_platform.get('arch')} "
                f"!= {current['platform']['os']}/{current['platform']['arch']}"
            )
    return ""


def working_tree_dirt(root: Path, registry: Registry) -> list[str]:
    completed = subprocess.run(
        ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        cwd=root,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise EvidenceError("git status failed; the candidate cannot be proven clean")
    records = [item for item in completed.stdout.decode("utf-8", "surrogateescape").split("\0") if item]
    dirty: list[str] = []
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if len(record) < 4:
            continue
        status = record[:2]
        path = record[3:]
        candidates = [path]
        if "R" in status or "C" in status:
            if index < len(records):
                candidates.append(records[index])
                index += 1
        for candidate in candidates:
            if not is_evidence_path(candidate, registry.evidence_directory):
                dirty.append(candidate)
    return sorted(set(dirty))


def gate_commands(gate: dict[str, Any]) -> list[dict[str, Any]]:
    commands = gate.get("commands")
    if not isinstance(commands, list) or not commands:
        raise EvidenceError("gate must declare at least one approved command")
    seen = set()
    for command in commands:
        if not isinstance(command, dict):
            raise EvidenceError("gate commands must be objects")
        command_id = command.get("id")
        argv = command.get("argv")
        if not isinstance(command_id, str) or not command_id or command_id in seen:
            raise EvidenceError("gate command ids must be unique non-empty strings")
        seen.add(command_id)
        if not isinstance(argv, list) or not argv or not all(isinstance(item, str) and item for item in argv):
            raise EvidenceError(f"gate command {command_id} must declare a non-empty argv array")
        env = command.get("env")
        if env is not None and not (isinstance(env, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in env.items())):
            raise EvidenceError(f"gate command {command_id} env must be a string map")
    return commands


def command_inputs_digest(
    command: dict[str, Any],
    gate: dict[str, Any],
    scope: str,
    environment: dict[str, Any],
    binding: str,
) -> str:
    payload = {
        "version": COMMAND_DIGEST_VERSION,
        "id": command["id"],
        "argv": command["argv"],
        "env": sorted(command_environment(gate, command).items()),
        "scope": scope,
        "environment": environment_subset(environment, binding),
        "resource": command.get("resource", gate.get("resource", "cpu")),
        "sharedKey": command.get("sharedKey", ""),
    }
    return sha256_bytes(canonical_json(payload))


def command_resources(command: dict[str, Any], gate: dict[str, Any], runner: dict[str, Any]) -> set[str]:
    resource = command.get("resource", gate.get("resource", "cpu"))
    if resource not in runner["resources"]:
        raise EvidenceError(f"gate command {command.get('id')!r} declares unknown resource {resource!r}")
    return {resource}


@dataclass
class CommandPlan:
    definition: dict[str, Any]
    inputs_digest: str
    resources: set[str]
    reusable: dict[str, Any] | None = None


@dataclass
class GatePlan:
    gate_id: str
    gate: dict[str, Any]
    scope_digest: str
    scope_count: int
    commands: list[CommandPlan]
    applicable: bool
    reason: str
    depends_on: list[str]
    resources: set[str]
    prior_record: dict[str, Any] | None = None
    force: bool = False


@dataclass
class GateRunResult:
    gate_id: str
    status: str
    record_path: Path | None
    commands_executed: int
    commands_reused: int
    verdict: str
    reason: str = ""


@dataclass
class RunSummary:
    verified: list[str] = field(default_factory=list)
    executed: list[GateRunResult] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    cancelled: bool = False
    input_changed: bool = False

    def exit_code(self) -> int:
        if self.cancelled:
            return EXIT_INTERRUPTED
        if self.input_changed or self.failed or any(result.verdict != "PASS" for result in self.executed):
            return EXIT_FAIL
        return EXIT_PASS


def record_path_for(root: Path, registry: Registry, gate_id: str) -> Path:
    return root / registry.evidence_directory / f"{gate_id}.json"


def load_prior_record(root: Path, registry: Registry, gate_id: str) -> dict[str, Any] | None:
    path = record_path_for(root, registry, gate_id)
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def find_command_entry(record: dict[str, Any], command: dict[str, Any]) -> dict[str, Any] | None:
    entries = record.get("commands")
    if not isinstance(entries, list):
        return None
    for entry in entries:
        if (
            isinstance(entry, dict)
            and entry.get("id") == command["id"]
            and entry.get("argv") == command["argv"]
        ):
            return entry
    return None


def record_tainted(record: dict[str, Any]) -> bool:
    reason = str(record.get("reason") or "")
    return "changed during the run" in reason


def dependency_scan_state(record: dict[str, Any], gate: dict[str, Any], snapshot: Snapshot) -> tuple[bool, str]:
    dependency = record.get("dependency")
    scan = record.get("scan")
    if not isinstance(dependency, dict) or dependency.get("digest") != snapshot.dependency_digest:
        return False, "dependency inputs changed"
    if not isinstance(scan, dict):
        return False, "scan freshness missing"
    max_age = int(gate.get("maxAgeSeconds", -1))
    if max_age <= 0:
        return False, "tracked maxAgeSeconds missing"
    try:
        scanned_at = parse_timestamp(scan.get("scannedAt"), "scan.scannedAt")
    except EvidenceError as exc:
        return False, str(exc)
    if utc_now() - scanned_at > timedelta(seconds=max_age):
        return False, "dependency scan is stale"
    return True, ""


def record_applicable(
    record: dict[str, Any] | None,
    gate_id: str,
    gate: dict[str, Any],
    scope: str,
    command_digests: dict[str, str],
    environment: dict[str, Any],
    snapshot: Snapshot,
) -> tuple[bool, str]:
    if record is None:
        return False, "no record"
    if record.get("gate") != gate_id or record.get("kind") != gate["kind"]:
        return False, "record does not match the tracked gate"
    if record.get("verdict") != "PASS":
        return False, f"recorded verdict is {record.get('verdict')}"
    if record_tainted(record):
        return False, "record was tainted by a during-run edit"
    recorded_scope = record.get("scope")
    if not isinstance(recorded_scope, dict):
        return False, "legacy record has no scope binding (historical; recollect)"
    if int(recorded_scope.get("version", -1)) != SCOPE_DIGEST_VERSION:
        return False, f"record scope digest version {recorded_scope.get('version')} is not supported"
    if recorded_scope.get("digest") != scope:
        return False, "gate scope inputs changed"
    mismatch = environment_mismatch(record.get("environment"), environment, gate.get("environment", "toolchain"))
    if mismatch:
        return False, f"environment-mismatch: {mismatch}"
    if gate["kind"] == "dependency-scan":
        fresh, reason = dependency_scan_state(record, gate, snapshot)
        if not fresh:
            return False, reason
    entries = record.get("commands")
    if not isinstance(entries, list):
        return False, "record commands are malformed"
    for command in gate_commands(gate):
        entry = find_command_entry(record, command)
        if entry is None:
            return False, f"record lacks command {command['id']}"
        if entry.get("inputsDigest") != command_digests[command["id"]]:
            return False, f"command {command['id']} inputs changed"
        if entry.get("exitCode") != 0:
            return False, f"command {command['id']} did not pass"
    return True, ""


def reusable_command_results(
    record: dict[str, Any] | None,
    gate: dict[str, Any],
    command_digests: dict[str, str],
    environment: dict[str, Any],
    snapshot: Snapshot,
) -> dict[str, dict[str, Any]]:
    if record is None or record.get("kind") != gate["kind"]:
        return {}
    if record_tainted(record):
        return {}
    mismatch = environment_mismatch(record.get("environment"), environment, gate.get("environment", "toolchain"))
    if mismatch:
        return {}
    if gate["kind"] == "dependency-scan":
        fresh, _ = dependency_scan_state(record, gate, snapshot)
        if not fresh:
            return {}
    reusable: dict[str, dict[str, Any]] = {}
    for command in gate_commands(gate):
        entry = find_command_entry(record, command)
        if entry is None:
            continue
        if entry.get("inputsDigest") != command_digests[command["id"]]:
            continue
        if entry.get("exitCode") != 0:
            continue
        if not DIGEST_RE.fullmatch(str(entry.get("logDigest", ""))):
            continue
        reusable[command["id"]] = dict(entry)
    return reusable


def build_plans(
    root: Path,
    registry: Registry,
    gate_ids: list[str],
    snapshot: Snapshot,
    environment: dict[str, Any],
    force: bool,
) -> list[GatePlan]:
    unknown = unmatched_inputs(snapshot, registry)
    scope_cache: dict[str, tuple[str, int, dict[str, str]]] = {}

    def gate_scope(gate_id: str) -> tuple[str, int, dict[str, str]]:
        if gate_id in scope_cache:
            return scope_cache[gate_id]
        gate = registry.gates[gate_id]
        paths = gate.get("paths")
        if not isinstance(paths, list) or not paths:
            raise EvidenceError(f"gate {gate_id!r} must declare a non-empty input scope")
        scope, scope_count = scope_digest(snapshot, [str(item) for item in paths])
        binding = gate.get("environment", "toolchain")
        command_digests = {
            command["id"]: command_inputs_digest(command, gate, scope, environment, binding)
            for command in gate_commands(gate)
        }
        scope_cache[gate_id] = (scope, scope_count, command_digests)
        return scope_cache[gate_id]

    plans: list[GatePlan] = []
    for gate_id in gate_ids:
        gate = registry.gates[gate_id]
        scope, scope_count, command_digests = gate_scope(gate_id)
        prior = None if force else load_prior_record(root, registry, gate_id)
        applicable, reason = record_applicable(prior, gate_id, gate, scope, command_digests, environment, snapshot)
        if unknown and gate.get("kind") == "source":
            applicable = False
            reason = f"unknown inputs require broad validation: {', '.join(unknown[:5])}"
        depends_on = [str(item) for item in gate.get("dependsOn", [])]
        for dependency in depends_on:
            if dependency not in registry.gates:
                raise EvidenceError(f"gate {gate_id!r} depends on unknown gate {dependency!r}")
        if applicable and depends_on:
            for dependency in depends_on:
                dependency_gate = registry.gates[dependency]
                dependency_scope, _, dependency_digests = gate_scope(dependency)
                dependency_record = load_prior_record(root, registry, dependency)
                dependency_ok, dependency_reason = record_applicable(
                    dependency_record,
                    dependency,
                    dependency_gate,
                    dependency_scope,
                    dependency_digests,
                    environment,
                    snapshot,
                )
                if not dependency_ok:
                    applicable = False
                    reason = f"dependency {dependency} is not reusable: {dependency_reason}"
                    break
        if applicable and prior is not None:
            for item in prior.get("consumed", []) or []:
                if not isinstance(item, dict):
                    applicable = False
                    reason = "recorded coverage attribution is malformed"
                    break
                consumed_gate = item.get("gate")
                if consumed_gate not in depends_on:
                    applicable = False
                    reason = f"recorded coverage names undeclared dependency {consumed_gate!r}"
                    break
                consumed_scope, _, _ = gate_scope(consumed_gate)
                if item.get("digest") != consumed_scope:
                    applicable = False
                    reason = f"consumed record for {consumed_gate} does not match current inputs"
                    break
        reusable = (
            {}
            if force or (unknown and gate.get("kind") == "source")
            else reusable_command_results(prior, gate, command_digests, environment, snapshot)
        )
        resources: set[str] = set()
        command_plans: list[CommandPlan] = []
        for command in gate_commands(gate):
            command_resources_set = command_resources(command, gate, registry.runner)
            resources.update(command_resources_set)
            command_plans.append(
                CommandPlan(
                    definition=command,
                    inputs_digest=command_digests[command["id"]],
                    resources=command_resources_set,
                    reusable=reusable.get(command["id"]),
                )
            )
        if not resources:
            resources = {"cpu"}
        plans.append(
            GatePlan(
                gate_id=gate_id,
                gate=gate,
                scope_digest=scope,
                scope_count=scope_count,
                commands=command_plans,
                applicable=applicable,
                reason=reason,
                depends_on=depends_on,
                resources=resources,
                prior_record=prior,
                force=force,
            )
        )
    return plans


def command_environment(gate: dict[str, Any], command: dict[str, Any]) -> dict[str, str]:
    env: dict[str, str] = {}
    for source in (gate.get("env"), command.get("env")):
        if isinstance(source, dict):
            for key, value in source.items():
                if isinstance(key, str) and isinstance(value, str):
                    env[key] = value
    return env


class ProcessRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._processes: dict[int, subprocess.Popen[bytes]] = {}

    def add(self, process: subprocess.Popen[bytes]) -> None:
        with self._lock:
            self._processes[process.pid] = process

    def remove(self, process: subprocess.Popen[bytes]) -> None:
        with self._lock:
            self._processes.pop(process.pid, None)

    def terminate_all(self, grace_seconds: float = 5.0) -> None:
        with self._lock:
            processes = list(self._processes.values())
        for process in processes:
            if process.poll() is not None:
                continue
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                continue
        deadline = time.monotonic() + grace_seconds
        while time.monotonic() < deadline:
            if all(process.poll() is not None for process in processes):
                return
            time.sleep(0.05)
        for process in processes:
            if process.poll() is not None:
                continue
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                continue


class CommandCache:
    """Runs a shared command node exactly once across gates in one collection."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[tuple[Any, ...], dict[str, Any]] = {}

    def run(
        self,
        key: tuple[Any, ...],
        origin_gate: str,
        run: Callable[[], dict[str, Any]],
    ) -> tuple[dict[str, Any], str]:
        with self._lock:
            entry = self._entries.get(key)
            owner = entry is None
            if entry is None:
                entry = {"event": threading.Event(), "result": None, "error": None, "origin": origin_gate}
                self._entries[key] = entry
        if owner:
            try:
                entry["result"] = run()
            except BaseException as exc:  # noqa: BLE001 - propagated to every waiter
                entry["error"] = exc
                raise
            finally:
                entry["event"].set()
            return dict(entry["result"]), origin_gate
        entry["event"].wait()
        if entry["error"] is not None:
            raise entry["error"]
        return dict(entry["result"]), str(entry["origin"])


class ResourcePool:
    def __init__(self, capacities: dict[str, int]) -> None:
        self._semaphores = {name: threading.Semaphore(capacity) for name, capacity in capacities.items()}

    def acquire(self, names: set[str]) -> list[str] | None:
        acquired: list[str] = []
        for name in sorted(names):
            semaphore = self._semaphores.get(name)
            if semaphore is None:
                raise EvidenceError(f"unknown resource {name!r}")
            if not semaphore.acquire(blocking=False):
                for held in acquired:
                    self._semaphores[held].release()
                return None
            acquired.append(name)
        return acquired

    def release(self, names: list[str]) -> None:
        for name in names:
            self._semaphores[name].release()


def execute_command(
    root: Path,
    registry: Registry,
    gate_id: str,
    command: dict[str, Any],
    environment: dict[str, Any],
    processes: ProcessRegistry,
    cancel: threading.Event,
    extra_env: dict[str, str] | None = None,
) -> dict[str, Any]:
    if cancel.is_set():
        raise RunCancelled()
    started = utc_now()
    log_directory = root / registry.local_log_directory
    log_directory.mkdir(parents=True, exist_ok=True)
    log_name = f"{gate_id}-{command['id']}-{started.strftime('%Y%m%dT%H%M%SZ')}-{os.getpid()}.log"
    log_path = log_directory / log_name
    env = os.environ.copy()
    env.update(command_environment({}, command))
    if extra_env:
        env.update(extra_env)
    consume_log_path: Path | None = None
    if command.get("consumeLog"):
        handle_fd, consume_name = tempfile.mkstemp(
            prefix=f".consumed-{gate_id}-", suffix=".log", dir=log_directory
        )
        os.close(handle_fd)
        consume_log_path = Path(consume_name)
        env["APPTHEORY_EVIDENCE_CONSUME_LOG"] = str(consume_log_path)
    print(f"validation-evidence: running gate={gate_id} command={command['id']}", file=sys.stderr)
    with log_path.open("wb") as handle:
        process = subprocess.Popen(
            command["argv"],
            cwd=root,
            stdout=handle,
            stderr=subprocess.STDOUT,
            shell=False,
            start_new_session=True,
            env=env,
        )
        processes.add(process)
        if cancel.is_set():
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
        try:
            exit_code = process.wait()
        finally:
            processes.remove(process)
    if cancel.is_set():
        raise RunCancelled()
    finished = utc_now()
    result: dict[str, Any] = {
        "id": command["id"],
        "argv": command["argv"],
        "exitCode": exit_code,
        "startedAt": format_timestamp(started),
        "finishedAt": format_timestamp(finished),
        "durationSeconds": round((finished - started).total_seconds(), 3),
        "logDigest": sha256_bytes(log_path.read_bytes()),
        "logRef": str(log_path.relative_to(root)),
        "executed": True,
        "reused": False,
    }
    if consume_log_path is not None:
        consumed = parse_consumed_log(consume_log_path)
        result["_consumed"] = consumed
        try:
            consume_log_path.unlink()
        except FileNotFoundError:
            pass
    print(
        f"validation-evidence: gate={gate_id} command={command['id']} exit={exit_code}",
        file=sys.stderr,
    )
    return result


def parse_consumed_log(path: Path) -> list[dict[str, str]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    consumed: list[dict[str, str]] = []
    seen = set()
    for line in lines:
        fields: dict[str, str] = {}
        for item in line.split("\t"):
            if "=" in item:
                key, value = item.split("=", 1)
                fields[key] = value
        gate = fields.get("gate")
        if not gate or gate in seen:
            continue
        seen.add(gate)
        consumed.append(
            {
                "gate": gate,
                "digest": fields.get("digest", ""),
                "recordedAt": fields.get("recordedAt", ""),
            }
        )
    return sorted(consumed, key=lambda item: item["gate"])


def build_record(
    registry: Registry,
    gate_id: str,
    gate: dict[str, Any],
    plan: GatePlan,
    snapshot: Snapshot,
    environment: dict[str, Any],
    commands: list[dict[str, Any]],
    verdict: str,
    reason: str,
    reviews: list[dict[str, str]],
    consumed: list[dict[str, str]],
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "gate": gate_id,
        "kind": gate["kind"],
        "description": gate.get("description", ""),
        "verdict": verdict,
        "reason": reason,
        "recordedAt": format_timestamp(utc_now()),
        "environment": environment,
        "scope": {
            "version": SCOPE_DIGEST_VERSION,
            "digest": plan.scope_digest,
            "fileCount": plan.scope_count,
            "paths": [str(item) for item in gate.get("paths", [])],
        },
        "source": {
            "digest": snapshot.source_digest,
            "fileCount": snapshot.source_count,
        },
        "releaseOnly": {
            "digest": snapshot.release_digest,
            "normalizedDigest": snapshot.release_normalized_digest,
            "fileCount": snapshot.release_count,
            "version": snapshot.release_version,
        },
        "commands": commands,
        "consumed": consumed,
        "reviews": reviews,
        "producer": {
            "tool": "scripts/evidence/validation_evidence.py",
            "registry": str(registry.path.name),
        },
    }
    if gate["kind"] == "dependency-scan":
        record["dependency"] = {
            "digest": snapshot.dependency_digest,
            "fileCount": snapshot.dependency_count,
        }
        record["scan"] = {
            "scannedAt": format_timestamp(utc_now()),
            "maxAgeSeconds": int(gate.get("maxAgeSeconds", registry.data["securityMaxAgeSeconds"])),
        }
    return record


def write_record(root: Path, registry: Registry, record: dict[str, Any]) -> Path:
    directory = root / registry.evidence_directory
    if not directory.is_dir():
        raise EvidenceError(f"evidence directory does not exist: {registry.evidence_directory}")
    target = directory / f"{record['gate']}.json"
    payload = json.dumps(record, indent=2, sort_keys=True) + "\n"
    handle = tempfile.NamedTemporaryFile("w", dir=directory, prefix=".evidence.", suffix=".tmp", delete=False)
    try:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    finally:
        handle.close()
    os.replace(handle.name, target)
    return target


def run_gate_plan(
    root: Path,
    registry: Registry,
    plan: GatePlan,
    snapshot: Snapshot,
    environment: dict[str, Any],
    processes: ProcessRegistry,
    cancel: threading.Event,
    cache: CommandCache,
    reviews: list[dict[str, str]],
) -> GateRunResult:
    gate_id = plan.gate_id
    gate = plan.gate
    command_entries: list[dict[str, Any]] = []
    consumed: list[dict[str, str]] = []
    executed = 0
    reused = 0
    failures: list[str] = []
    for command_plan in plan.commands:
        command = command_plan.definition
        if command_plan.reusable is not None:
            entry = dict(command_plan.reusable)
            entry["executed"] = False
            entry["reused"] = True
            command_entries.append(entry)
            reused += 1
            continue
        if cancel.is_set():
            raise RunCancelled()
        key: tuple[Any, ...]
        if command.get("sharedKey"):
            key = ("shared", command["sharedKey"])
        else:
            key = (
                "command",
                command["id"],
                tuple(command["argv"]),
                command_plan.inputs_digest,
                tuple(sorted(command_environment(gate, command).items())),
                plan.force,
            )

        def execute() -> dict[str, Any]:
            extra_env = command_environment(gate, command)
            if plan.force:
                extra_env["EVIDENCE_FORCE_EXECUTE"] = "true"
            return execute_command(
                root=root,
                registry=registry,
                gate_id=gate_id,
                command=command,
                environment=environment,
                processes=processes,
                cancel=cancel,
                extra_env=extra_env,
            )

        entry, origin = cache.run(key, gate_id, execute)
        consumed.extend(entry.pop("_consumed", []))
        entry["inputsDigest"] = command_plan.inputs_digest
        if origin != gate_id:
            entry["sharedFrom"] = origin
        if entry.get("exitCode") != 0:
            failures.append(f"{command['id']} exit={entry.get('exitCode')}")
        command_entries.append(entry)
        executed += 1

    verdict = "FAIL" if failures else "PASS"
    reason = ("command failed: " + ", ".join(failures)) if failures else ""
    record = build_record(
        registry,
        gate_id,
        gate,
        plan,
        snapshot,
        environment,
        command_entries,
        verdict,
        reason,
        reviews,
        consumed,
    )
    target = write_record(root, registry, record)
    print(
        f"validation-evidence: gate={gate_id} action=executed verdict={verdict} "
        f"commands={len(command_entries)} executed={executed} reused={reused} "
        f"consumed={len(consumed)} scope={plan.scope_digest}"
        + (f" reason={reason}" if reason else ""),
        file=sys.stderr,
    )
    return GateRunResult(
        gate_id=gate_id,
        status=verdict.lower(),
        record_path=target,
        commands_executed=executed,
        commands_reused=reused,
        verdict=verdict,
        reason=reason,
    )


class Scheduler:
    def __init__(
        self,
        root: Path,
        registry: Registry,
        snapshot: Snapshot,
        environment: dict[str, Any],
        reviews: list[dict[str, str]],
        max_workers: int,
        cancel: threading.Event,
        processes: ProcessRegistry,
    ) -> None:
        self.root = root
        self.registry = registry
        self.snapshot = snapshot
        self.environment = environment
        self.reviews = reviews
        self.max_workers = max_workers
        self.cancel = cancel
        self.processes = processes
        self.pool = ResourcePool(registry.runner["resources"])
        self.cache = CommandCache()

    def run(self, plans: list[GatePlan]) -> list[GateRunResult]:
        pending = {plan.gate_id: plan for plan in plans}
        selected = set(pending)
        completed: dict[str, str] = {}
        results: list[GateRunResult] = []
        futures: dict[Any, tuple[str, list[str]]] = {}
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            while pending or futures:
                if self.cancel.is_set():
                    break
                submitted = False
                for gate_id in sorted(pending):
                    if self.cancel.is_set():
                        break
                    plan = pending[gate_id]
                    if any(dependency in selected and dependency not in completed for dependency in plan.depends_on):
                        continue
                    acquired = self.pool.acquire(plan.resources)
                    if acquired is None:
                        continue
                    future = executor.submit(
                        run_gate_plan,
                        self.root,
                        self.registry,
                        plan,
                        self.snapshot,
                        self.environment,
                        self.processes,
                        self.cancel,
                        self.cache,
                        self.reviews,
                    )
                    futures[future] = (gate_id, acquired)
                    del pending[gate_id]
                    submitted = True
                    if len(futures) >= self.max_workers:
                        break
                if not futures:
                    if not submitted:
                        raise EvidenceError(
                            "scheduler made no progress; check gate dependencies and resource capacities"
                        )
                    continue
                done, _ = wait(futures, return_when=FIRST_COMPLETED)
                for future in done:
                    gate_id, acquired = futures.pop(future)
                    self.pool.release(acquired)
                    try:
                        result = future.result()
                    except RunCancelled:
                        self.cancel.set()
                        continue
                    except Exception as exc:  # noqa: BLE001 - every failure is recorded and returns nonzero
                        failure = GateRunResult(
                            gate_id=gate_id,
                            status="failed",
                            record_path=None,
                            commands_executed=0,
                            commands_reused=0,
                            verdict="FAIL",
                            reason=f"collector exception: {exc}",
                        )
                        results.append(failure)
                        completed[gate_id] = "failed"
                        print(f"validation-evidence: gate={gate_id} action=failed reason={exc}", file=sys.stderr)
                        continue
                    results.append(result)
                    completed[gate_id] = result.status
        if self.cancel.is_set() and pending:
            for gate_id in sorted(pending):
                print(f"validation-evidence: gate={gate_id} action=cancelled", file=sys.stderr)
        return results


def select_gate_ids(registry: Registry, args: argparse.Namespace) -> list[str]:
    if args.all and args.gate:
        raise EvidenceError("collect accepts either --all or --gate, not both")
    if args.all:
        gate_ids = sorted(
            gate_id for gate_id, gate in registry.gates.items() if gate.get("kind") != "generated-delta"
        )
    else:
        gate_ids = list(args.gate or [])
        if not gate_ids:
            raise EvidenceError("collect requires --gate <id> or --all")
    for gate_id in gate_ids:
        if not GATE_ID_RE.fullmatch(gate_id) or gate_id not in registry.gates:
            raise EvidenceError(f"gate {gate_id!r} is not approved in the tracked registry")
        if registry.gates[gate_id].get("kind") == "generated-delta":
            raise EvidenceError(
                f"gate {gate_id!r} is a generated-delta smoke; it executes in CI and is not collected as reusable evidence"
            )
    return gate_ids


def print_plan(plans: list[GatePlan], registry: Registry) -> None:
    for plan in sorted(plans, key=lambda item: item.gate_id):
        action = "verified" if plan.applicable else "would-run"
        print(
            f"validation-evidence: gate={plan.gate_id} action={action} "
            f"scope={plan.scope_digest} files={plan.scope_count} "
            f"depends={','.join(plan.depends_on) or '-'} resources={','.join(sorted(plan.resources))}"
            + (f" reason={plan.reason}" if not plan.applicable else ""),
            file=sys.stderr,
        )


def collect(args: argparse.Namespace) -> int:
    registry = load_registry(args.registry)
    root = repo_root(args.root)
    gate_ids = select_gate_ids(registry, args)

    dirty = working_tree_dirt(root, registry)
    if dirty:
        preview = ", ".join(dirty[:10])
        raise EvidenceError(f"working tree must be clean before collecting evidence (dirty: {preview})")

    reviews = [{"ref": ref, "kind": "review-reference"} for ref in args.review_ref]
    environment = probe_environment()
    before = load_snapshot(root, registry)
    plans = build_plans(root, registry, gate_ids, before, environment, force=args.force)

    if args.dry_run:
        print_plan(plans, registry)
        verified = [plan.gate_id for plan in plans if plan.applicable]
        print(
            "validation-evidence: dry-run "
            f"gates={len(plans)} verified={len(verified)} would-execute={len(plans) - len(verified)}"
        )
        return EXIT_PASS

    cancel = threading.Event()
    processes = ProcessRegistry()
    received_signal: list[int] = []

    def handle_signal(signum: int, _frame: Any) -> None:
        received_signal.append(signum)
        cancel.set()
        processes.terminate_all()

    previous_int = signal.signal(signal.SIGINT, handle_signal)
    previous_term = signal.signal(signal.SIGTERM, handle_signal)
    summary = RunSummary()
    summary.verified = sorted(plan.gate_id for plan in plans if plan.applicable)
    to_run = [plan for plan in plans if not plan.applicable]
    try:
        for gate_id in summary.verified:
            record = load_prior_record(root, registry, gate_id)
            scope = record.get("scope", {}).get("digest", "?") if record else "?"
            print(
                f"validation-evidence: gate={gate_id} action=verified scope={scope} "
                "(no command executed in this run)"
            )
        if to_run:
            max_workers = args.jobs if args.jobs is not None else int(registry.runner["maxWorkers"])
            if max_workers < 1 or max_workers > 8:
                raise EvidenceError("--jobs must be between 1 and 8")
            scheduler = Scheduler(
                root=root,
                registry=registry,
                snapshot=before,
                environment=environment,
                reviews=reviews,
                max_workers=max_workers,
                cancel=cancel,
                processes=processes,
            )
            summary.executed = scheduler.run(to_run)
        if cancel.is_set():
            summary.cancelled = True
            processes.terminate_all()
        after = load_snapshot(root, registry)
        if after.global_identity() != before.global_identity():
            summary.input_changed = True
            for result in summary.executed:
                if result.record_path is None:
                    continue
                try:
                    record = json.loads(result.record_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                record["verdict"] = "FAIL"
                record["reason"] = "relevant inputs changed during the run; the record is not reusable"
                write_record(root, registry, record)
            print(
                "validation-evidence: FAIL (relevant inputs changed during the run; "
                "completed records were marked FAIL and retained)",
                file=sys.stderr,
            )
    finally:
        signal.signal(signal.SIGINT, previous_int)
        signal.signal(signal.SIGTERM, previous_term)

    summary.failed = sorted(result.gate_id for result in summary.executed if result.verdict != "PASS")
    commands_executed = sum(result.commands_executed for result in summary.executed)
    commands_reused = sum(result.commands_reused for result in summary.executed)
    executed = len(summary.executed)
    print(
        "validation-evidence: summary "
        f"gates={len(plans)} verified={len(summary.verified)} executed={executed} "
        f"commands={commands_executed} reused={commands_reused} failed={len(summary.failed)} "
        f"cancelled={'true' if summary.cancelled else 'false'} "
        f"inputChanged={'true' if summary.input_changed else 'false'}"
    )
    if summary.cancelled:
        code = EXIT_TERMINATED if 15 in received_signal else EXIT_INTERRUPTED
        print("validation-evidence: interrupted (completed records retained; rerun resumes)", file=sys.stderr)
        return code
    code = summary.exit_code()
    if code == EXIT_PASS:
        print(
            "validation-evidence: PASS "
            f"(source={before.source_digest}; release={before.release_digest}; "
            f"executed={executed} verified={len(summary.verified)})"
        )
    else:
        print(
            "validation-evidence: FAIL (failed: "
            + (", ".join(summary.failed) or "input change")
            + "; evidence records retained honestly)",
            file=sys.stderr,
        )
    return code


def validate_record_shape(gate_id: str, gate: dict[str, Any], record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise EvidenceError("record must be a JSON object")
    extra = set(record) - RECORD_KEYS
    missing = {
        "schemaVersion",
        "gate",
        "kind",
        "verdict",
        "recordedAt",
        "scope",
        "source",
        "releaseOnly",
        "commands",
    } - set(record)
    if extra:
        raise EvidenceError(f"record has unknown keys: {', '.join(sorted(extra))}")
    if missing:
        raise EvidenceError(f"record is missing keys: {', '.join(sorted(missing))}")
    if record["schemaVersion"] != SCHEMA_VERSION:
        raise EvidenceError("record schemaVersion is not the supported version")
    if record["gate"] != gate_id:
        raise EvidenceError(f"record gate {record['gate']!r} does not match {gate_id!r}")
    if record["kind"] != gate["kind"]:
        raise EvidenceError("record kind does not match the tracked gate definition")
    if record["verdict"] not in {"PASS", "FAIL"}:
        raise EvidenceError("record verdict must be PASS or FAIL")
    if record["verdict"] != "PASS":
        raise EvidenceError(f"recorded verdict is {record['verdict']}: {record.get('reason') or 'no reason recorded'}")

    scope = record["scope"]
    if not isinstance(scope, dict):
        raise EvidenceError("record scope is malformed")
    if int(scope.get("version", -1)) != SCOPE_DIGEST_VERSION:
        raise EvidenceError(
            f"record scope version {scope.get('version')} is not supported "
            "(historical record; recollect to bind the current scope)"
        )
    if not DIGEST_RE.fullmatch(str(scope.get("digest", ""))):
        raise EvidenceError("record scope digest is malformed")

    source = record["source"]
    if not isinstance(source, dict) or not DIGEST_RE.fullmatch(str(source.get("digest", ""))):
        raise EvidenceError("record source digest is malformed")
    release = record["releaseOnly"]
    if not isinstance(release, dict):
        raise EvidenceError("record releaseOnly projection is malformed")
    for key in ("digest", "normalizedDigest"):
        if not DIGEST_RE.fullmatch(str(release.get(key, ""))):
            raise EvidenceError(f"record releaseOnly.{key} is malformed")

    expected_commands = gate_commands(gate)
    recorded_commands = record["commands"]
    if not isinstance(recorded_commands, list) or len(recorded_commands) != len(expected_commands):
        raise EvidenceError("recorded command set does not match the approved gate command set")
    for expected, recorded in zip(expected_commands, recorded_commands):
        if not isinstance(recorded, dict):
            raise EvidenceError("recorded command entry is malformed")
        extra_command = set(recorded) - COMMAND_KEYS
        if extra_command:
            raise EvidenceError(f"recorded command has unknown keys: {', '.join(sorted(extra_command))}")
        if recorded.get("id") != expected["id"] or recorded.get("argv") != expected["argv"]:
            raise EvidenceError(f"recorded command {recorded.get('id')!r} is not the approved command")
        if recorded.get("exitCode") != 0:
            raise EvidenceError(f"recorded command {expected['id']!r} exited non-zero")
        if not DIGEST_RE.fullmatch(str(recorded.get("logDigest", ""))):
            raise EvidenceError(f"recorded command {expected['id']!r} log digest is malformed")
        if not DIGEST_RE.fullmatch(str(recorded.get("inputsDigest", ""))):
            raise EvidenceError(f"recorded command {expected['id']!r} inputs digest is malformed")
        started = parse_timestamp(recorded.get("startedAt"), f"command {expected['id']} startedAt")
        finished = parse_timestamp(recorded.get("finishedAt"), f"command {expected['id']} finishedAt")
        if finished < started:
            raise EvidenceError(f"recorded command {expected['id']!r} finished before it started")

    recorded_at = parse_timestamp(record["recordedAt"], "recordedAt")
    now = utc_now()
    if recorded_at > now + timedelta(seconds=300):
        raise EvidenceError("recordedAt is in the future")
    for command in recorded_commands:
        if parse_timestamp(command["finishedAt"], "command finishedAt") > recorded_at + timedelta(seconds=300):
            raise EvidenceError("a command finished after the record timestamp")

    consumed = record.get("consumed", [])
    if not isinstance(consumed, list):
        raise EvidenceError("record consumed coverage must be a list")
    for item in consumed:
        if not isinstance(item, dict):
            raise EvidenceError("record consumed coverage entry is malformed")
        extra_item = set(item) - {"gate", "digest", "recordedAt"}
        if extra_item:
            raise EvidenceError(f"record consumed coverage has unknown keys: {', '.join(sorted(extra_item))}")
        if not GATE_ID_RE.fullmatch(str(item.get("gate", ""))):
            raise EvidenceError("record consumed coverage names an invalid gate")
        if not DIGEST_RE.fullmatch(str(item.get("digest", ""))):
            raise EvidenceError("record consumed coverage digest is malformed")

    if gate["kind"] == "dependency-scan":
        dependency = record.get("dependency")
        scan = record.get("scan")
        if not isinstance(dependency, dict) or not DIGEST_RE.fullmatch(str(dependency.get("digest", ""))):
            raise EvidenceError("dependency-scan record lacks a valid dependency digest")
        if not isinstance(scan, dict):
            raise EvidenceError("dependency-scan record lacks scan freshness")
        scanned_at = parse_timestamp(scan.get("scannedAt"), "scan.scannedAt")
        max_age = int(scan.get("maxAgeSeconds", -1))
        tracked_max_age = int(gate.get("maxAgeSeconds", -1))
        if tracked_max_age <= 0:
            raise EvidenceError("tracked dependency-scan gate lacks a positive maxAgeSeconds")
        if max_age != tracked_max_age:
            raise EvidenceError(
                f"record maxAgeSeconds {max_age} does not match the tracked policy {tracked_max_age}"
            )
        if scanned_at > now + timedelta(seconds=300):
            raise EvidenceError("scan.scannedAt is in the future")
        if now - scanned_at > timedelta(seconds=max_age):
            raise EvidenceError(f"dependency scan is stale ({scanned_at.isoformat()} older than {max_age}s)")

    return record


def verify(args: argparse.Namespace) -> int:
    registry = load_registry(args.registry)
    root = repo_root(args.root)
    gate_id = args.gate
    if not gate_id or gate_id not in registry.gates:
        raise EvidenceError(f"gate {gate_id!r} is not approved in the tracked registry")
    gate = registry.gates[gate_id]
    record_path = record_path_for(root, registry, gate_id)
    if not record_path.is_file():
        raise EvidenceError(f"no evidence record at {record_path.relative_to(root)}")
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise EvidenceError(f"malformed evidence record: {exc}") from exc
    record = validate_record_shape(gate_id, gate, record)

    snapshot = load_snapshot(root, registry)
    environment = probe_environment()
    mismatch = environment_mismatch(record.get("environment"), environment, gate.get("environment", "toolchain"))
    if mismatch:
        raise EvidenceError(f"environment-mismatch: {mismatch}")

    unknown = unmatched_inputs(snapshot, registry)
    if unknown and gate.get("kind") == "source":
        raise EvidenceError(
            "unknown-inputs: "
            + ", ".join(unknown[:10])
            + " (no declared gate scope; re-run the affected broad validation)"
        )

    scope, _ = scope_digest(snapshot, [str(item) for item in gate.get("paths", [])])
    recorded_scope = record["scope"]
    if recorded_scope["digest"] != scope:
        raise EvidenceError(
            "gate-scope-inputs-changed: recorded "
            f"{recorded_scope['digest']} candidate {scope} (the affected validation must run again)"
        )
    binding = gate.get("environment", "toolchain")
    command_digests = {
        command["id"]: command_inputs_digest(command, gate, scope, environment, binding)
        for command in gate_commands(gate)
    }
    for command in record["commands"]:
        expected = command_digests[command["id"]]
        if command.get("inputsDigest") != expected:
            raise EvidenceError(
                f"command-inputs-changed: {command['id']} recorded {command.get('inputsDigest')} candidate {expected}"
            )

    declared_dependencies = {str(item) for item in gate.get("dependsOn", [])}
    for item in record.get("consumed", []) or []:
        consumed_gate = str(item.get("gate", ""))
        if consumed_gate not in declared_dependencies:
            raise EvidenceError(f"consumed coverage names undeclared dependency {consumed_gate!r}")
        dependency_gate = registry.gates.get(consumed_gate)
        if dependency_gate is None:
            raise EvidenceError(f"consumed dependency {consumed_gate!r} is not an approved gate")
        dependency_record_path = record_path_for(root, registry, consumed_gate)
        if not dependency_record_path.is_file():
            raise EvidenceError(
                f"consumed dependency {consumed_gate!r} has no record; the composed proof is not applicable"
            )
        dependency_record = validate_record_shape(
            consumed_gate,
            dependency_gate,
            json.loads(dependency_record_path.read_text(encoding="utf-8")),
        )
        dependency_scope, _ = scope_digest(
            snapshot, [str(item) for item in dependency_gate.get("paths", [])]
        )
        if item.get("digest") != dependency_scope:
            raise EvidenceError(
                f"consumed dependency {consumed_gate!r} inputs changed; the composed proof is not applicable"
            )
        dependency_binding = dependency_gate.get("environment", "toolchain")
        dependency_digests = {
            command["id"]: command_inputs_digest(
                command, dependency_gate, dependency_scope, environment, dependency_binding
            )
            for command in gate_commands(dependency_gate)
        }
        dependency_ok, dependency_reason = record_applicable(
            dependency_record,
            consumed_gate,
            dependency_gate,
            dependency_scope,
            dependency_digests,
            environment,
            snapshot,
        )
        if not dependency_ok:
            raise EvidenceError(
                f"consumed dependency {consumed_gate!r} is not reusable: {dependency_reason}"
            )

    mode = "evidence-verified"
    if gate["kind"] == "dependency-scan":
        dependency = record["dependency"]
        if dependency["digest"] != snapshot.dependency_digest:
            raise EvidenceError(
                "dependency-inputs-changed: recorded "
                f"{dependency['digest']} candidate {snapshot.dependency_digest}"
            )
        fresh, reason = dependency_scan_state(record, gate, snapshot)
        if not fresh:
            raise EvidenceError(f"dependency-scan-not-reusable: {reason}")
        mode = "dependency-scan-verified"
    else:
        source_changed = record["source"]["digest"] != snapshot.source_digest
        release = record["releaseOnly"]
        release_changed = release["digest"] != snapshot.release_digest
        if (
            release_changed
            and not source_changed
            and release.get("normalizedDigest") == snapshot.release_normalized_digest
        ):
            mode = "release-transformation-verified"
        elif source_changed:
            mode = "evidence-verified-declared-out-of-scope-inputs"

    reviews = record.get("reviews") or []
    review_refs = ", ".join(str(item.get("ref", "")) for item in reviews if isinstance(item, dict) and item.get("ref"))
    recorded_at = record["recordedAt"]
    print(
        "validation-evidence: "
        f"gate={gate_id} mode={mode} scope={scope} source={record['source']['digest']} "
        f"recorded={recorded_at} "
        f"environment=go{record['environment'].get('go', '?')}/node{record['environment'].get('node', '?')}/"
        f"python{record['environment'].get('python', '?')} "
        f"platform={(record['environment'].get('platform') or {}).get('os', '?')}/"
        f"{(record['environment'].get('platform') or {}).get('arch', '?')} "
        f"reviews={(review_refs or 'none')} (declared, unauthenticated)"
    )
    if args.json:
        print(
            json.dumps(
                {
                    "gate": gate_id,
                    "mode": mode,
                    "scopeDigest": scope,
                    "sourceDigest": record["source"]["digest"],
                    "recordedAt": recorded_at,
                    "reviews": reviews,
                },
                sort_keys=True,
            )
        )
    return EXIT_PASS


def run_gate(args: argparse.Namespace) -> int:
    registry = load_registry(args.registry)
    root = repo_root(args.root)
    gate_id = args.gate
    if not gate_id or gate_id not in registry.gates:
        raise EvidenceError(f"gate {gate_id!r} is not approved in the tracked registry")
    gate = registry.gates[gate_id]
    processes = ProcessRegistry()
    cancel = threading.Event()

    def handle_signal(signum: int, _frame: Any) -> None:
        cancel.set()
        processes.terminate_all()

    previous_int = signal.signal(signal.SIGINT, handle_signal)
    previous_term = signal.signal(signal.SIGTERM, handle_signal)
    failures: list[str] = []
    executed = 0
    try:
        for command in gate_commands(gate):
            result = execute_command(
                root=root,
                registry=registry,
                gate_id=gate_id,
                command=command,
                environment=probe_environment(),
                processes=processes,
                cancel=cancel,
                extra_env=command_environment(gate, command),
            )
            executed += 1
            if result["exitCode"] != 0:
                failures.append(f"{command['id']} exit={result['exitCode']}")
            if cancel.is_set():
                break
    finally:
        signal.signal(signal.SIGINT, previous_int)
        signal.signal(signal.SIGTERM, previous_term)
    if cancel.is_set():
        processes.terminate_all()
        print("validation-evidence: interrupted", file=sys.stderr)
        return EXIT_INTERRUPTED
    if failures:
        print(
            "validation-evidence: FAIL (executed "
            + ", ".join(failures)
            + ")",
            file=sys.stderr,
        )
        return EXIT_FAIL
    print(f"validation-evidence: PASS (executed {executed} approved command(s) for gate={gate_id})")
    return EXIT_PASS


def project(args: argparse.Namespace) -> int:
    registry = load_registry(args.registry)
    root = repo_root(args.root)
    snapshot = load_snapshot(root, registry)
    print(
        json.dumps(
            {
                "sourceDigest": snapshot.source_digest,
                "sourceFileCount": snapshot.source_count,
                "releaseDigest": snapshot.release_digest,
                "releaseNormalizedDigest": snapshot.release_normalized_digest,
                "releaseFileCount": snapshot.release_count,
                "releaseVersion": snapshot.release_version,
                "dependencyDigest": snapshot.dependency_digest,
                "dependencyFileCount": snapshot.dependency_count,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return EXIT_PASS


def finalize(args: argparse.Namespace) -> int:
    registry = load_registry(args.registry)
    root = repo_root(args.root)
    gate_ids = sorted(registry.gates) if args.all else [args.gate]
    if not gate_ids or any(gate_id not in registry.gates for gate_id in gate_ids):
        raise EvidenceError("finalize requires approved gate ids")
    for gate_id in gate_ids:
        gate = registry.gates[gate_id]
        record_path = record_path_for(root, registry, gate_id)
        if not record_path.is_file():
            raise EvidenceError(f"no evidence record at {record_path.relative_to(root)}")
        record = validate_record_shape(gate_id, gate, json.loads(record_path.read_text(encoding="utf-8")))
        existing = {(item.get("ref"), item.get("kind")) for item in record.get("reviews", []) if isinstance(item, dict)}
        for ref in args.review_ref:
            if (ref, "review-reference") not in existing:
                record.setdefault("reviews", []).append({"ref": ref, "kind": "review-reference"})
        write_record(root, registry, record)
        print(f"validation-evidence: finalized {record_path.relative_to(root)} reviews={len(record.get('reviews', []))}")
    return EXIT_PASS


def build_parser() -> argparse.ArgumentParser:
    default_registry = Path(__file__).resolve().with_name("validation-gates.json")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--registry", type=Path, default=default_registry, help="tracked gate registry")
    subparsers = parser.add_subparsers(dest="command", required=True)

    collect_parser = subparsers.add_parser(
        "collect",
        help="schedule missing/affected approved gates and record evidence (incremental by default)",
    )
    collect_parser.add_argument("--root", type=Path)
    collect_parser.add_argument("--gate", action="append", default=[])
    collect_parser.add_argument("--all", action="store_true", help="enumerate required coverage; only affected work runs")
    collect_parser.add_argument("--force", action="store_true", help="ignore applicable records and execute")
    collect_parser.add_argument("--dry-run", action="store_true", help="print the schedule without executing")
    collect_parser.add_argument("--jobs", type=int, help="bounded worker count (1-8)")
    collect_parser.add_argument("--review-ref", action="append", default=[])
    collect_parser.set_defaults(handler=collect)

    verify_parser = subparsers.add_parser("verify", help="verify evidence without executing the recorded commands")
    verify_parser.add_argument("--root", type=Path)
    verify_parser.add_argument("--gate", required=True)
    verify_parser.add_argument("--json", action="store_true")
    verify_parser.set_defaults(handler=verify)

    project_parser = subparsers.add_parser("inputs-digest", help="print the current input projections")
    project_parser.add_argument("--root", type=Path)
    project_parser.set_defaults(handler=project)

    run_parser = subparsers.add_parser("run", help="execute the approved commands for one gate without recording")
    run_parser.add_argument("--root", type=Path)
    run_parser.add_argument("--gate", required=True)
    run_parser.set_defaults(handler=run_gate)

    finalize_parser = subparsers.add_parser("finalize", help="add review references to an existing record")
    finalize_parser.add_argument("--root", type=Path)
    finalize_parser.add_argument("--gate")
    finalize_parser.add_argument("--all", action="store_true")
    finalize_parser.add_argument("--review-ref", action="append", default=[])
    finalize_parser.set_defaults(handler=finalize)

    return parser


def main(argv: list[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except EvidenceError as exc:
        print(f"validation-evidence: FAIL ({exc})", file=sys.stderr)
        return EXIT_FAIL
    except KeyboardInterrupt:
        return EXIT_INTERRUPTED


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
