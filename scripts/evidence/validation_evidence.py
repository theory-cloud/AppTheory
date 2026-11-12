#!/usr/bin/env python3
"""Produce and verify AppTheory validation evidence.

The evidence record binds the exact checked-in inputs a governed command set was
executed against. Verification recomputes the inputs digest from the candidate
working tree and compares it with the record; it never executes anything the
record names. Commands come only from the tracked gate registry
(``scripts/evidence/validation-gates.json``) and are executed as argv arrays,
never through a shell or ``eval``.

Identity is content-addressed, so it is independent of commit SHAs, branch names,
and evidence-only commits. Inputs are partitioned into two disjoint sets:

* source inputs -- every tracked or untracked-but-not-ignored file except the
  dedicated evidence directory and the release-only set;
* release-only inputs -- the explicit version-coupled and regenerated artifact
  paths named in the registry.

The source digest identifies ordinary proof. The release-only projection is
stored with a second digest computed after substituting the recorded version
literal with a fixed token. When the source digest matches and only the
release-only projection differs, a matching normalized digest proves the delta
is exactly the version substitution release automation performs. Anything else
requires the affected validation to run again.

Exit codes: 0 PASS, 1 FAIL, 2 BLOCKED.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_BLOCKED = 2
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
GATE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
VERSION_TOKEN = b"@@APPTHEORY_VERSION@@"
SOURCE_HEADER = b"apptheory-validation-source-v1\n"
RELEASE_HEADER = b"apptheory-validation-release-v1\n"
NORMALIZED_HEADER = b"apptheory-validation-release-normalized-v1\n"

RECORD_KEYS = {
    "schemaVersion",
    "gate",
    "kind",
    "description",
    "verdict",
    "reason",
    "recordedAt",
    "environment",
    "source",
    "releaseOnly",
    "dependency",
    "scan",
    "commands",
    "reviews",
    "producer",
}


class EvidenceError(Exception):
    """A validation-evidence condition that must fail closed."""


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
class Projection:
    source_digest: str
    source_count: int
    release_digest: str
    release_normalized_digest: str
    release_count: int
    release_version: str
    dependency_digest: str
    dependency_count: int


def project_inputs(root: Path, registry: Registry) -> Projection:
    evidence_directory = registry.evidence_directory
    version = read_version(root)
    source_lines: list[bytes] = []
    release_lines: list[bytes] = []
    normalized_lines: list[bytes] = []
    dependency_lines: list[bytes] = []
    source_count = release_count = dependency_count = 0

    for relative in repo_files(root):
        if is_evidence_path(relative, evidence_directory):
            continue
        mode, data = read_input_bytes(root, relative)
        content_digest = sha256_bytes(data)
        if matches_security_input(relative, registry):
            dependency_count += 1
            dependency_lines.append(b"%d\t%s\t%s\n" % (mode, relative.encode("utf-8"), content_digest.encode("ascii")))
        if matches_release_only(relative, registry):
            release_count += 1
            release_lines.append(b"%d\t%s\t%s\n" % (mode, relative.encode("utf-8"), content_digest.encode("ascii")))
            normalized = normalize_release_bytes(data, version)
            normalized_lines.append(
                b"%d\t%s\t%s\n" % (mode, relative.encode("utf-8"), sha256_bytes(normalized).encode("ascii"))
            )
        else:
            source_count += 1
            source_lines.append(b"%d\t%s\t%s\n" % (mode, relative.encode("utf-8"), content_digest.encode("ascii")))

    return Projection(
        source_digest=sha256_bytes(SOURCE_HEADER + b"".join(sorted(source_lines))),
        source_count=source_count,
        release_digest=sha256_bytes(RELEASE_HEADER + b"".join(sorted(release_lines))),
        release_normalized_digest=sha256_bytes(NORMALIZED_HEADER + b"".join(sorted(normalized_lines))),
        release_count=release_count,
        release_version=version,
        dependency_digest=sha256_bytes(SOURCE_HEADER + b"".join(sorted(dependency_lines))),
        dependency_count=dependency_count,
    )


def probe_environment() -> dict[str, Any]:
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
    return {
        "go": go_version,
        "node": node_version,
        "python": python_version,
        "platform": {
            "os": "darwin" if sys.platform == "darwin" else "linux" if sys.platform.startswith("linux") else sys.platform,
            "arch": platform.machine(),
        },
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
    return commands


def run_gate_commands(
    root: Path,
    registry: Registry,
    gate_id: str,
    gate: dict[str, Any],
    log_directory: Path,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for command in gate_commands(gate):
        started = utc_now()
        log_directory.mkdir(parents=True, exist_ok=True)
        log_name = f"{gate_id}-{command['id']}-{started.strftime('%Y%m%dT%H%M%SZ')}.log"
        log_path = log_directory / log_name
        print(f"validation-evidence: running gate={gate_id} command={command['id']}", file=sys.stderr)
        with log_path.open("wb") as handle:
            completed = subprocess.run(
                command["argv"],
                cwd=root,
                stdout=handle,
                stderr=subprocess.STDOUT,
                shell=False,
                check=False,
            )
        finished = utc_now()
        log_digest = sha256_bytes(log_path.read_bytes())
        records.append(
            {
                "id": command["id"],
                "argv": command["argv"],
                "exitCode": completed.returncode,
                "startedAt": format_timestamp(started),
                "finishedAt": format_timestamp(finished),
                "durationSeconds": round((finished - started).total_seconds(), 3),
                "logDigest": log_digest,
                "logRef": str(log_path.relative_to(root)),
            }
        )
        print(
            f"validation-evidence: gate={gate_id} command={command['id']} exit={completed.returncode}",
            file=sys.stderr,
        )
    return records


def build_record(
    root: Path,
    registry: Registry,
    gate_id: str,
    gate: dict[str, Any],
    projection: Projection,
    commands: list[dict[str, Any]],
    verdict: str,
    reason: str,
    environment: dict[str, Any],
    reviews: list[dict[str, str]],
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
        "source": {
            "digest": projection.source_digest,
            "fileCount": projection.source_count,
        },
        "releaseOnly": {
            "digest": projection.release_digest,
            "normalizedDigest": projection.release_normalized_digest,
            "fileCount": projection.release_count,
            "version": projection.release_version,
        },
        "commands": commands,
        "reviews": reviews,
        "producer": {
            "tool": "scripts/evidence/validation_evidence.py",
            "registry": str(registry.path.name),
        },
    }
    if gate["kind"] == "dependency-scan":
        record["dependency"] = {
            "digest": projection.dependency_digest,
            "fileCount": projection.dependency_count,
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


def collect(args: argparse.Namespace) -> int:
    registry = load_registry(args.registry)
    root = repo_root(args.root)
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

    dirty = working_tree_dirt(root, registry)
    if dirty:
        preview = ", ".join(dirty[:10])
        raise EvidenceError(f"working tree must be clean before collecting evidence (dirty: {preview})")

    reviews = [{"ref": ref, "kind": "review-reference"} for ref in args.review_ref]
    before = project_inputs(root, registry)
    environment = probe_environment()
    log_directory = root / registry.local_log_directory

    records: list[dict[str, Any]] = []
    failed = False
    for gate_id in gate_ids:
        gate = registry.gates[gate_id]
        commands = run_gate_commands(root, registry, gate_id, gate, log_directory)
        exit_failures = [command for command in commands if command["exitCode"] != 0]
        verdict = "FAIL" if exit_failures else "PASS"
        reason = ""
        if exit_failures:
            failed = True
            reason = "command failed: " + ", ".join(command["id"] for command in exit_failures)
        records.append(build_record(root, registry, gate_id, gate, before, commands, verdict, reason, environment, reviews))

    after = project_inputs(root, registry)
    if (before.source_digest, before.release_digest) != (after.source_digest, after.release_digest):
        failed = True
        for record in records:
            record["verdict"] = "FAIL"
            record["reason"] = "relevant inputs changed during the run; the record is not reusable"

    for record in records:
        target = write_record(root, registry, record)
        print(f"validation-evidence: wrote {target.relative_to(root)} verdict={record['verdict']}")

    if failed:
        print("validation-evidence: FAIL (evidence records retained honestly; fix the failure and recollect)", file=sys.stderr)
        return EXIT_FAIL
    print(
        "validation-evidence: PASS "
        f"({len(records)} record(s); source={before.source_digest}; release={before.release_digest})"
    )
    return EXIT_PASS


def validate_record_shape(gate_id: str, gate: dict[str, Any], record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise EvidenceError("record must be a JSON object")
    extra = set(record) - RECORD_KEYS
    missing = {"schemaVersion", "gate", "kind", "verdict", "recordedAt", "source", "releaseOnly", "commands"} - set(record)
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
        if recorded.get("id") != expected["id"] or recorded.get("argv") != expected["argv"]:
            raise EvidenceError(f"recorded command {recorded.get('id')!r} is not the approved command")
        if recorded.get("exitCode") != 0:
            raise EvidenceError(f"recorded command {expected['id']!r} exited non-zero")
        if not DIGEST_RE.fullmatch(str(recorded.get("logDigest", ""))):
            raise EvidenceError(f"recorded command {expected['id']!r} log digest is malformed")
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
    record_path = root / registry.evidence_directory / f"{gate_id}.json"
    if not record_path.is_file():
        raise EvidenceError(f"no evidence record at {record_path.relative_to(root)}")
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise EvidenceError(f"malformed evidence record: {exc}") from exc
    record = validate_record_shape(gate_id, gate, record)

    current = project_inputs(root, registry)
    environment = probe_environment()
    mismatch = environment_mismatch(record.get("environment"), environment, gate.get("environment", "toolchain"))
    if mismatch:
        raise EvidenceError(f"environment-mismatch: {mismatch}")

    mode = "evidence-verified"
    if gate["kind"] == "dependency-scan":
        dependency = record["dependency"]
        if dependency["digest"] != current.dependency_digest:
            raise EvidenceError(
                "dependency-inputs-changed: recorded "
                f"{dependency['digest']} candidate {current.dependency_digest}"
            )
    else:
        source = record["source"]
        release = record["releaseOnly"]
        if source["digest"] != current.source_digest:
            raise EvidenceError(
                "source-inputs-changed: recorded "
                f"{source['digest']} candidate {current.source_digest} "
                "(the affected validation must run again)"
            )
        if release["digest"] != current.release_digest:
            if release["normalizedDigest"] != current.release_normalized_digest:
                raise EvidenceError(
                    "release-only-inputs-changed beyond the version substitution: "
                    f"recorded {release['digest']} candidate {current.release_digest} "
                    "(the affected validation must run again)"
                )
            mode = "release-transformation-verified"

    reviews = record.get("reviews") or []
    review_refs = ", ".join(str(item.get("ref", "")) for item in reviews if isinstance(item, dict) and item.get("ref"))
    recorded_at = record["recordedAt"]
    print(
        "validation-evidence: "
        f"gate={gate_id} mode={mode} source={record['source']['digest']} "
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
    commands = run_gate_commands(root, registry, gate_id, registry.gates[gate_id], root / registry.local_log_directory)
    failures = [command for command in commands if command["exitCode"] != 0]
    if failures:
        print(
            "validation-evidence: FAIL (executed "
            + ", ".join(f"{command['id']} exit={command['exitCode']}" for command in failures)
            + ")",
            file=sys.stderr,
        )
        return EXIT_FAIL
    print(f"validation-evidence: PASS (executed {len(commands)} approved command(s) for gate={gate_id})")
    return EXIT_PASS


def project(args: argparse.Namespace) -> int:
    registry = load_registry(args.registry)
    root = repo_root(args.root)
    projection = project_inputs(root, registry)
    print(
        json.dumps(
            {
                "sourceDigest": projection.source_digest,
                "sourceFileCount": projection.source_count,
                "releaseDigest": projection.release_digest,
                "releaseNormalizedDigest": projection.release_normalized_digest,
                "releaseFileCount": projection.release_count,
                "releaseVersion": projection.release_version,
                "dependencyDigest": projection.dependency_digest,
                "dependencyFileCount": projection.dependency_count,
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
        record_path = root / registry.evidence_directory / f"{gate_id}.json"
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

    collect_parser = subparsers.add_parser("collect", help="execute approved gate commands and record evidence")
    collect_parser.add_argument("--root", type=Path)
    collect_parser.add_argument("--gate", action="append", default=[])
    collect_parser.add_argument("--all", action="store_true")
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
        return EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
