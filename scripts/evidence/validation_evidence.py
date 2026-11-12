#!/usr/bin/env python3
"""Produce, verify, and schedule AppTheory validation evidence.

The evidence record binds the exact checked-in inputs a governed command set was
executed against, plus the supported proof profile that claim belongs to.
Verification recomputes the inputs digest from the candidate working tree and
compares it with the record; it never executes anything the record names.
Commands come only from the tracked gate registry
(``scripts/evidence/validation-gates.json``) and are executed as argv arrays,
never through a shell or ``eval``.

A proof profile is a tracked declaration of a supported environment (Go pin,
Node major, Python major.minor, and the producing OS/arch). The collector probes
the real versions it runs under and refuses to record a profile the live host
does not satisfy. Verification compares the recorded environment with the
tracked profile, never with the verifier runner: CI is an evidence verifier, not
the environment under test for portable source, packaging and journey claims. A
record also names the profile it was produced for, so a floor proof is reused
across every later release event for the same inputs and never doubles as a
different floor's proof.

Collection is incremental. ``collect --all`` enumerates the required coverage,
then schedules only missing, failed, stale or affected gates. A second run over
unchanged inputs executes zero commands. ``--force`` is the explicit override;
it is never the documented default. Gates declare their input scope, resource
group and dependencies so independent work can overlap while conflicting
filesystem/build/Docker work serializes. Completed records are written atomically
as each gate finishes, so an interrupted run keeps its completed results and a
restart executes only the incomplete or changed work.

The CI fallback (``run``, behind ``verify-or-execute.sh``) uses the same record
builder: it validates that the live host can truthfully produce the requested
tracked profile, executes the approved commands, and writes the record the
verifier accepts for those inputs. Failed, cancelled or tainted work is never
published as a PASS. A produced record is appended to the producer manifest
named by ``APPTHEORY_EVIDENCE_PRODUCED_MANIFEST`` so the upload step can require
the exact file this job wrote instead of a glob over the checkout.

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
from typing import Any

SCHEMA_VERSION = 1
SCOPE_DIGEST_VERSION = 1
COMMAND_DIGEST_VERSION = 2
EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_BLOCKED = 2
EXIT_INTERRUPTED = 130
EXIT_TERMINATED = 143
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
GATE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9.-]*$")
PRODUCED_MANIFEST_ENV = "APPTHEORY_EVIDENCE_PRODUCED_MANIFEST"
ENVIRONMENT_DIMENSIONS = ("go", "node", "python", "platform")
ENVIRONMENT_ALIASES = {
    "none": [],
    "toolchain": ["go", "node", "python"],
    "toolchain+platform": ["go", "node", "python", "platform"],
}
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
    "profile",
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
    def profiles(self) -> dict[str, dict[str, Any]]:
        return self.data.get("proofProfiles") or {}

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


def environment_dimensions(gate: dict[str, Any], gate_id: str) -> list[str]:
    """Return the environment dimensions a gate's claim depends on."""
    declared = gate.get("environment", "toolchain")
    if isinstance(declared, str):
        if declared not in ENVIRONMENT_ALIASES:
            raise EvidenceError(f"gate {gate_id!r} declares unknown environment binding {declared!r}")
        return list(ENVIRONMENT_ALIASES[declared])
    if not isinstance(declared, list) or not all(isinstance(item, str) for item in declared):
        raise EvidenceError(f"gate {gate_id!r} environment must be a binding name or dimension list")
    dimensions: list[str] = []
    for item in declared:
        if item not in ENVIRONMENT_DIMENSIONS:
            raise EvidenceError(f"gate {gate_id!r} declares unknown environment dimension {item!r}")
        if item not in dimensions:
            dimensions.append(item)
    return dimensions


def gate_profile_ids(gate: dict[str, Any], gate_id: str) -> list[str]:
    """Return the supported proof profiles for a gate, validated and non-empty."""
    declared = gate.get("profiles")
    if declared is None:
        declared = ["default"]
    if not isinstance(declared, list) or not declared:
        raise EvidenceError(f"gate {gate_id!r} must declare at least one supported proof profile")
    profiles: list[str] = []
    for item in declared:
        if not isinstance(item, str) or not PROFILE_ID_RE.fullmatch(item):
            raise EvidenceError(f"gate {gate_id!r} declares invalid proof profile {item!r}")
        if item not in profiles:
            profiles.append(item)
    return profiles


def validate_profile_declaration(profile_id: str, profile: Any) -> None:
    if not isinstance(profile, dict):
        raise EvidenceError(f"proof profile {profile_id!r} must be an object")
    environment = profile.get("environment")
    if not isinstance(environment, dict):
        raise EvidenceError(f"proof profile {profile_id!r} must declare an environment")
    for dimension in ("go", "node", "python"):
        value = environment.get(dimension)
        if not isinstance(value, str) or not value:
            raise EvidenceError(f"proof profile {profile_id!r} must declare {dimension}")
    if not re.fullmatch(r"go[0-9]+\.[0-9]+(\.[0-9]+)?", environment["go"]):
        raise EvidenceError(f"proof profile {profile_id!r} go pin must be a canonical goX.Y[.Z] version")
    if not re.fullmatch(r"[0-9]+", environment["node"]):
        raise EvidenceError(f"proof profile {profile_id!r} node must be the supported major")
    if not re.fullmatch(r"[0-9]+\.[0-9]+", environment["python"]):
        raise EvidenceError(f"proof profile {profile_id!r} python must be major.minor")
    platform_value = environment.get("platform")
    if not isinstance(platform_value, dict):
        raise EvidenceError(f"proof profile {profile_id!r} must declare platform os/arch")
    for key in ("os", "arch"):
        value = platform_value.get(key)
        if not isinstance(value, str) or not value:
            raise EvidenceError(f"proof profile {profile_id!r} must declare platform.{key}")


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
    profiles = data.get("proofProfiles")
    if not isinstance(profiles, dict) or not profiles:
        raise EvidenceError("gate registry must declare proofProfiles")
    for profile_id, profile in profiles.items():
        if not isinstance(profile_id, str) or not PROFILE_ID_RE.fullmatch(profile_id):
            raise EvidenceError(f"gate registry declares invalid proof profile id {profile_id!r}")
        validate_profile_declaration(profile_id, profile)
    for gate_id, gate in data["gates"].items():
        if not isinstance(gate, dict):
            raise EvidenceError(f"gate {gate_id!r} must be an object")
        environment_dimensions(gate, gate_id)
        for profile_id in gate_profile_ids(gate, gate_id):
            if profile_id not in profiles:
                raise EvidenceError(
                    f"gate {gate_id!r} supports undeclared proof profile {profile_id!r}"
                )
        fallbacks = gate.get("fallbackProfiles", [])
        if not isinstance(fallbacks, list):
            raise EvidenceError(f"gate {gate_id!r} fallbackProfiles must be a list")
        for fallback in fallbacks:
            if not isinstance(fallback, str) or fallback not in gate_profile_ids(gate, gate_id):
                raise EvidenceError(
                    f"gate {gate_id!r} declares fallback profile {fallback!r} it does not support"
                )
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


def environment_subset(environment: dict[str, Any], dimensions: list[str]) -> dict[str, Any]:
    subset: dict[str, Any] = {}
    for dimension in dimensions:
        if dimension == "platform":
            subset["platform"] = dict(environment.get("platform") or {})
        else:
            subset[dimension] = environment.get(dimension, "")
    return subset


def _major(value: Any) -> str:
    text = str(value or "").strip().lstrip("v")
    return text.split(".", 1)[0]


def _major_minor(value: Any) -> str:
    parts = str(value or "").strip().split(".")
    return ".".join(parts[:2]) if len(parts) >= 2 else ""


def environment_mismatch(recorded: Any, declared: Any, dimensions: list[str]) -> str:
    """Compare a probed environment with the tracked profile's declaration.

    Go is matched at the repository pin, Node at its supported major, Python at
    its supported major.minor, and the OS/arch only when the gate's claim is
    platform-bound. Patch levels and the runner that performs verification are
    deliberately not part of the comparison.
    """
    if not dimensions:
        return ""
    if not isinstance(recorded, dict):
        return "recorded environment is missing"
    if not isinstance(declared, dict):
        return "tracked profile environment is missing"
    for dimension in ("go", "node", "python"):
        if dimension not in dimensions:
            continue
        value = recorded.get(dimension)
        if not isinstance(value, str) or not value:
            return f"recorded {dimension} version is missing"
    if "go" in dimensions and recorded["go"] != declared.get("go"):
        return f"go {recorded['go']} != profile {declared.get('go')}"
    if "node" in dimensions:
        recorded_major = _major(recorded["node"])
        if not recorded_major or recorded_major != str(declared.get("node")):
            return f"node {recorded['node']} != profile major {declared.get('node')}"
    if "python" in dimensions:
        recorded_minor = _major_minor(recorded["python"])
        if not recorded_minor or recorded_minor != str(declared.get("python")):
            return f"python {recorded['python']} != profile {declared.get('python')}"
    if "platform" in dimensions:
        recorded_platform = recorded.get("platform")
        declared_platform = declared.get("platform")
        if not isinstance(recorded_platform, dict) or not isinstance(declared_platform, dict):
            return "platform binding requires recorded and declared os/arch"
        if (
            recorded_platform.get("os") != declared_platform.get("os")
            or recorded_platform.get("arch") != declared_platform.get("arch")
        ):
            return (
                f"platform {recorded_platform.get('os')}/{recorded_platform.get('arch')} "
                f"!= profile {declared_platform.get('os')}/{declared_platform.get('arch')}"
            )
    return ""


def profile_environment(registry: Registry, profile_id: str) -> dict[str, Any]:
    profile = registry.profiles.get(profile_id)
    if not isinstance(profile, dict):
        raise EvidenceError(f"proof profile {profile_id!r} is not declared in the tracked registry")
    environment = profile.get("environment")
    if not isinstance(environment, dict):
        raise EvidenceError(f"proof profile {profile_id!r} has no declared environment")
    return dict(environment)


def resolve_profile(registry: Registry, gate_id: str, requested: str | None) -> str:
    gate = registry.gates.get(gate_id)
    if not isinstance(gate, dict):
        raise EvidenceError(f"gate {gate_id!r} is not approved in the tracked registry")
    allowed = gate_profile_ids(gate, gate_id)
    profile_id = requested or allowed[0]
    if profile_id not in registry.profiles:
        raise EvidenceError(f"proof profile {profile_id!r} is not declared in the tracked registry")
    if profile_id not in allowed:
        raise EvidenceError(
            f"gate {gate_id!r} does not support proof profile {profile_id!r} "
            f"(supported: {', '.join(allowed)})"
        )
    return profile_id


def select_producing_profile(
    registry: Registry,
    gate_id: str,
    requested: str,
    environment: dict[str, Any],
) -> str:
    """Choose the tracked profile this host can truthfully produce for the gate.

    The requested profile wins whenever the live host satisfies it. Otherwise
    the gate's tracked ``fallbackProfiles`` are tried in declaration order, so a
    platform-bound claim can be produced on its explicitly supported Linux
    producer instead of being mislabeled with the macOS default. Every candidate
    is a tracked profile the gate declares; a caller can never assert an
    arbitrary environment, and the recorded environment is always the real
    probe. When nothing matches, execution is refused instead of producing
    false provenance.
    """
    gate = registry.gates[gate_id]
    candidates = [requested]
    for fallback in gate.get("fallbackProfiles", []):
        fallback_id = str(fallback)
        if fallback_id not in candidates:
            candidates.append(fallback_id)
    dimensions = environment_dimensions(gate, gate_id)
    mismatches: list[str] = []
    for profile_id in candidates:
        declared = profile_environment(registry, profile_id)
        mismatch = environment_mismatch(environment, declared, dimensions)
        if not mismatch:
            return profile_id
        mismatches.append(f"{profile_id}: {mismatch}")
    raise EvidenceError(
        f"gate {gate_id!r} cannot be produced on this host for proof profile {requested!r} "
        f"({'; '.join(mismatches)}); run it under the governed toolchain for that profile "
        "or on a host the profile declares"
    )


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
    dimensions: list[str],
) -> str:
    payload = {
        "version": COMMAND_DIGEST_VERSION,
        "id": command["id"],
        "argv": command["argv"],
        "env": sorted(command_environment(gate, command).items()),
        "scope": scope,
        "environment": environment_subset(environment, dimensions),
        "resources": sorted(declared_resources(command, gate)),
    }
    return sha256_bytes(canonical_json(payload))


def declared_resources(command: dict[str, Any], gate: dict[str, Any]) -> set[str]:
    """Return the resource groups a command declares (its own, else the gate's)."""
    declared = command.get("resources")
    if declared is None:
        declared = gate.get("resources")
    if declared is None:
        single = command.get("resource", gate.get("resource", "cpu"))
        declared = [single]
    if isinstance(declared, str):
        declared = [declared]
    if not isinstance(declared, list) or not declared:
        raise EvidenceError(f"gate command {command.get('id')!r} must declare at least one resource")
    resources: set[str] = set()
    for item in declared:
        if not isinstance(item, str) or not item:
            raise EvidenceError(f"gate command {command.get('id')!r} declares an invalid resource")
        resources.add(item)
    return resources


def command_resources(command: dict[str, Any], gate: dict[str, Any], runner: dict[str, Any]) -> set[str]:
    resources = declared_resources(command, gate)
    for resource in resources:
        if resource not in runner["resources"]:
            raise EvidenceError(f"gate command {command.get('id')!r} declares unknown resource {resource!r}")
    return resources


@dataclass
class CommandPlan:
    definition: dict[str, Any]
    inputs_digest: str
    resources: set[str]
    reusable: dict[str, Any] | None = None


@dataclass
class GatePlan:
    gate_id: str
    profile_id: str
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
    profile_id: str = ""


@dataclass
class RunSummary:
    verified: list[str] = field(default_factory=list)
    executed: list[GateRunResult] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)
    cancelled: bool = False
    input_changed: bool = False

    def exit_code(self) -> int:
        if self.cancelled:
            return EXIT_INTERRUPTED
        if self.input_changed or self.failed or self.blocked or any(result.verdict != "PASS" for result in self.executed):
            return EXIT_FAIL
        return EXIT_PASS


def record_path_for(root: Path, registry: Registry, gate_id: str, profile_id: str) -> Path:
    return root / registry.evidence_directory / gate_id / f"{profile_id}.json"


def load_prior_record(root: Path, registry: Registry, gate_id: str, profile_id: str) -> dict[str, Any] | None:
    path = record_path_for(root, registry, gate_id, profile_id)
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
    profile_id: str,
    scope: str,
    command_digests: dict[str, str],
    declared_environment: dict[str, Any],
    snapshot: Snapshot,
) -> tuple[bool, str]:
    if record is None:
        return False, "no record"
    if record.get("gate") != gate_id or record.get("kind") != gate["kind"]:
        return False, "record does not match the tracked gate"
    if record.get("profile") != profile_id:
        return False, f"record is for proof profile {record.get('profile')!r}, not {profile_id!r}"
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
    dimensions = environment_dimensions(gate, gate_id)
    mismatch = environment_mismatch(record.get("environment"), declared_environment, dimensions)
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
    gate_id: str,
    gate: dict[str, Any],
    profile_id: str,
    command_digests: dict[str, str],
    declared_environment: dict[str, Any],
    snapshot: Snapshot,
) -> dict[str, dict[str, Any]]:
    if record is None or record.get("kind") != gate["kind"]:
        return {}
    if record.get("profile") != profile_id:
        return {}
    if record_tainted(record):
        return {}
    mismatch = environment_mismatch(
        record.get("environment"), declared_environment, environment_dimensions(gate, gate_id)
    )
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
    profile_ids: dict[str, str],
    force: bool,
) -> list[GatePlan]:
    unknown = unmatched_inputs(snapshot, registry)
    scope_cache: dict[str, tuple[str, int, dict[str, str]]] = {}

    def gate_scope(gate_id: str) -> tuple[str, int, dict[str, str]]:
        if gate_id in scope_cache:
            return scope_cache[gate_id]
        gate = registry.gates[gate_id]
        profile_id = profile_ids[gate_id]
        paths = gate.get("paths")
        if not isinstance(paths, list) or not paths:
            raise EvidenceError(f"gate {gate_id!r} must declare a non-empty input scope")
        scope, scope_count = scope_digest(snapshot, [str(item) for item in paths])
        dimensions = environment_dimensions(gate, gate_id)
        declared_environment = profile_environment(registry, profile_id)
        command_digests = {
            command["id"]: command_inputs_digest(command, gate, scope, declared_environment, dimensions)
            for command in gate_commands(gate)
        }
        scope_cache[gate_id] = (scope, scope_count, command_digests)
        return scope_cache[gate_id]

    plans: list[GatePlan] = []
    for gate_id in gate_ids:
        gate = registry.gates[gate_id]
        profile_id = profile_ids[gate_id]
        scope, scope_count, command_digests = gate_scope(gate_id)
        declared_environment = profile_environment(registry, profile_id)
        prior = None if force else load_prior_record(root, registry, gate_id, profile_id)
        applicable, reason = record_applicable(
            prior,
            gate_id,
            gate,
            profile_id,
            scope,
            command_digests,
            declared_environment,
            snapshot,
        )
        if unknown and gate.get("kind") == "source":
            applicable = False
            reason = f"unknown inputs require broad validation: {', '.join(unknown[:5])}"
        depends_on = [str(item) for item in gate.get("dependsOn", [])]
        for dependency in depends_on:
            if dependency not in registry.gates:
                raise EvidenceError(f"gate {gate_id!r} depends on unknown gate {dependency!r}")
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
            else reusable_command_results(
                prior,
                gate_id,
                gate,
                profile_id,
                command_digests,
                declared_environment,
                snapshot,
            )
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
                profile_id=profile_id,
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
        "profile": plan.profile_id,
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
    directory = root / registry.evidence_directory / str(record["gate"])
    if not (root / registry.evidence_directory).is_dir():
        raise EvidenceError(f"evidence directory does not exist: {registry.evidence_directory}")
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{record['profile']}.json"
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


def record_produced_path(root: Path, target: Path) -> None:
    """Append a record this process actually wrote to the producer manifest.

    CI cannot upload a record it never wrote, and it must not upload a record
    bundled with the checkout as if this run produced it. The manifest names the
    exact files this process wrote, so the upload contract has real evidence to
    check instead of a glob over whatever the checkout happened to contain.
    """
    manifest = os.environ.get(PRODUCED_MANIFEST_ENV, "")
    if not manifest:
        return
    try:
        relative = target.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise EvidenceError(f"produced record {target} is outside the repository root") from exc
    try:
        digest = sha256_bytes(target.read_bytes())
    except OSError as exc:
        raise EvidenceError(f"cannot read the produced record {target}: {exc}") from exc
    try:
        descriptor = os.open(manifest, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    except OSError as exc:
        raise EvidenceError(f"cannot append to the produced-record manifest {manifest}: {exc}") from exc
    try:
        os.write(descriptor, f"{relative}\t{digest}\n".encode("utf-8"))
    finally:
        os.close(descriptor)


def execute_gate_commands(
    root: Path,
    registry: Registry,
    plan: GatePlan,
    environment: dict[str, Any],
    processes: ProcessRegistry,
    cancel: threading.Event,
) -> tuple[list[dict[str, Any]], list[dict[str, str]], int, int, list[str]]:
    """Execute (or reuse) a plan's commands and return the honest command entries."""
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
        # Composition, not a shared command cache, is the one dedup mechanism:
        # a leaf consumes a verified record through APPTHEORY_EVIDENCE_REUSE and
        # executes its real command whenever that record is not applicable.
        extra_env = command_environment(plan.gate, command)
        extra_env["APPTHEORY_EVIDENCE_PROFILE"] = plan.profile_id
        if plan.force:
            extra_env["EVIDENCE_FORCE_EXECUTE"] = "true"
        entry = execute_command(
            root=root,
            registry=registry,
            gate_id=plan.gate_id,
            command=command,
            environment=environment,
            processes=processes,
            cancel=cancel,
            extra_env=extra_env,
        )
        consumed.extend(entry.pop("_consumed", []))
        entry["inputsDigest"] = command_plan.inputs_digest
        if entry.get("exitCode") != 0:
            failures.append(f"{command['id']} exit={entry.get('exitCode')}")
        command_entries.append(entry)
        executed += 1
    return command_entries, consumed, executed, reused, failures


def produced_record_problem(
    registry: Registry,
    plan: GatePlan,
    record: dict[str, Any],
    snapshot: Snapshot,
    consumed: list[dict[str, str]],
) -> str:
    """Return why a just-executed PASS record would not verify, or an empty string.

    A successful execution may only claim a record that the verifier accepts on
    this same input set and profile. Anything else is retained as a FAIL record
    instead of a green claim.
    """
    if consumed:
        return "the executed run consumed nested evidence and cannot claim a reusable PASS"
    if plan.gate.get("kind") == "source":
        unknown = unmatched_inputs(snapshot, registry)
        if unknown:
            return "unknown inputs require broad validation: " + ", ".join(unknown[:5])
    digests = {command.definition["id"]: command.inputs_digest for command in plan.commands}
    applicable, reason = record_applicable(
        record,
        plan.gate_id,
        plan.gate,
        plan.profile_id,
        plan.scope_digest,
        digests,
        profile_environment(registry, plan.profile_id),
        snapshot,
    )
    return "" if applicable else reason


def finalize_gate_record(
    root: Path,
    registry: Registry,
    plan: GatePlan,
    snapshot: Snapshot,
    environment: dict[str, Any],
    commands: list[dict[str, Any]],
    consumed: list[dict[str, str]],
    verdict: str,
    reason: str,
    reviews: list[dict[str, str]],
    verify_when_pass: bool = False,
) -> GateRunResult:
    record = build_record(
        registry,
        plan.gate_id,
        plan.gate,
        plan,
        snapshot,
        environment,
        commands,
        verdict,
        reason,
        reviews,
        consumed,
    )
    if verdict == "PASS" and verify_when_pass:
        problem = produced_record_problem(registry, plan, record, snapshot, consumed)
        if problem:
            record["verdict"] = "FAIL"
            record["reason"] = f"produced record does not verify: {problem}"
    verdict = str(record["verdict"])
    reason = str(record.get("reason") or "")
    target = write_record(root, registry, record)
    record_produced_path(root, target)
    print(
        f"validation-evidence: gate={plan.gate_id} profile={plan.profile_id} action=executed verdict={verdict} "
        f"commands={len(commands)} executed={sum(1 for item in commands if item.get('executed'))} "
        f"reused={sum(1 for item in commands if item.get('reused'))} "
        f"consumed={len(consumed)} scope={plan.scope_digest} record={target.relative_to(root)}"
        + (f" reason={reason}" if reason else ""),
        file=sys.stderr,
    )
    return GateRunResult(
        gate_id=plan.gate_id,
        status=verdict.lower(),
        record_path=target,
        commands_executed=sum(1 for item in commands if item.get("executed")),
        commands_reused=sum(1 for item in commands if item.get("reused")),
        verdict=verdict,
        reason=reason,
        profile_id=plan.profile_id,
    )


def run_gate_plan(
    root: Path,
    registry: Registry,
    plan: GatePlan,
    snapshot: Snapshot,
    environment: dict[str, Any],
    processes: ProcessRegistry,
    cancel: threading.Event,
    reviews: list[dict[str, str]],
) -> GateRunResult:
    commands, consumed, _executed, _reused, failures = execute_gate_commands(
        root=root,
        registry=registry,
        plan=plan,
        environment=environment,
        processes=processes,
        cancel=cancel,
    )
    verdict = "FAIL" if failures else "PASS"
    reason = ("command failed: " + ", ".join(failures)) if failures else ""
    return finalize_gate_record(
        root=root,
        registry=registry,
        plan=plan,
        snapshot=snapshot,
        environment=environment,
        commands=commands,
        consumed=consumed,
        verdict=verdict,
        reason=reason,
        reviews=reviews,
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
                # A gate whose prerequisite did not pass is blocked, never
                # executed through a fallback in the same failed collection. Its
                # dependents are blocked in turn; a later explicit run retries
                # only the failed or missing work.
                for gate_id in sorted(pending):
                    failed = [
                        dependency
                        for dependency in pending[gate_id].depends_on
                        if dependency in selected
                        and dependency in completed
                        and completed[dependency] != "pass"
                    ]
                    if not failed:
                        continue
                    reason = f"prerequisite {failed[0]} did not pass"
                    results.append(
                        GateRunResult(
                            gate_id=gate_id,
                            status="blocked",
                            record_path=None,
                            commands_executed=0,
                            commands_reused=0,
                            verdict="BLOCKED",
                            reason=reason,
                        )
                    )
                    completed[gate_id] = "blocked"
                    del pending[gate_id]
                    print(
                        f"validation-evidence: gate={gate_id} action=blocked reason={reason}",
                        file=sys.stderr,
                    )
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
                        self.reviews,
                    )
                    futures[future] = (gate_id, acquired)
                    del pending[gate_id]
                    submitted = True
                    if len(futures) >= self.max_workers:
                        break
                if not futures:
                    if not submitted:
                        if not pending:
                            continue
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
            f"validation-evidence: gate={plan.gate_id} profile={plan.profile_id} action={action} "
            f"scope={plan.scope_digest} files={plan.scope_count} "
            f"depends={','.join(plan.depends_on) or '-'} resources={','.join(sorted(plan.resources))}"
            + (f" reason={plan.reason}" if not plan.applicable else ""),
            file=sys.stderr,
        )


def resolve_collect_profiles(
    registry: Registry,
    gate_ids: list[str],
    requested: str | None,
) -> dict[str, str]:
    """Resolve the proof profile for each gate and fail closed on unsupported ones."""
    profile_ids: dict[str, str] = {}
    for gate_id in gate_ids:
        profile_ids[gate_id] = resolve_profile(registry, gate_id, requested)
    return profile_ids


def require_live_environment(
    registry: Registry,
    gate_ids: list[str],
    profile_ids: dict[str, str],
    environment: dict[str, Any],
) -> None:
    """Refuse to collect a profile the live host does not actually satisfy.

    This is what makes a receipt's environment truthful: a Node 24 host cannot
    record the Node 22 floor, and ambient Python 3.15 cannot record the tracked
    Python 3.14 profile.
    """
    mismatches: list[str] = []
    for gate_id in gate_ids:
        dimensions = environment_dimensions(registry.gates[gate_id], gate_id)
        declared = profile_environment(registry, profile_ids[gate_id])
        mismatch = environment_mismatch(environment, declared, dimensions)
        if mismatch:
            mismatches.append(f"{gate_id} (profile {profile_ids[gate_id]}): {mismatch}")
    if mismatches:
        raise EvidenceError(
            "live environment does not satisfy the requested proof profile: "
            + "; ".join(mismatches[:5])
            + " (select the governed toolchain for that profile before collecting)"
        )


def collect(args: argparse.Namespace) -> int:
    registry = load_registry(args.registry)
    root = repo_root(args.root)
    gate_ids = select_gate_ids(registry, args)
    if args.all and args.profile:
        gate_ids = [
            gate_id
            for gate_id in gate_ids
            if args.profile in gate_profile_ids(registry.gates[gate_id], gate_id)
        ]
        if not gate_ids:
            raise EvidenceError(f"proof profile {args.profile!r} is not supported by any collectable gate")
    profile_ids = resolve_collect_profiles(registry, gate_ids, args.profile)

    dirty = working_tree_dirt(root, registry)
    if dirty:
        preview = ", ".join(dirty[:10])
        raise EvidenceError(f"working tree must be clean before collecting evidence (dirty: {preview})")

    reviews = [{"ref": ref, "kind": "review-reference"} for ref in args.review_ref]
    environment = probe_environment()
    require_live_environment(registry, gate_ids, profile_ids, environment)
    before = load_snapshot(root, registry)
    plans = build_plans(root, registry, gate_ids, before, profile_ids, force=args.force)

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
            record = load_prior_record(root, registry, gate_id, profile_ids[gate_id])
            scope = record.get("scope", {}).get("digest", "?") if record else "?"
            print(
                f"validation-evidence: gate={gate_id} profile={profile_ids[gate_id]} action=verified scope={scope} "
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
                rewritten = write_record(root, registry, record)
                record_produced_path(root, rewritten)
            print(
                "validation-evidence: FAIL (relevant inputs changed during the run; "
                "completed records were marked FAIL and retained)",
                file=sys.stderr,
            )
    finally:
        signal.signal(signal.SIGINT, previous_int)
        signal.signal(signal.SIGTERM, previous_term)

    summary.failed = sorted(
        result.gate_id for result in summary.executed if result.status not in ("pass", "blocked")
    )
    summary.blocked = sorted(result.gate_id for result in summary.executed if result.status == "blocked")
    commands_executed = sum(result.commands_executed for result in summary.executed)
    commands_reused = sum(result.commands_reused for result in summary.executed)
    executed = len(summary.executed) - len(summary.blocked)
    print(
        "validation-evidence: summary "
        f"gates={len(plans)} verified={len(summary.verified)} executed={executed} "
        f"commands={commands_executed} reused={commands_reused} failed={len(summary.failed)} "
        f"blocked={len(summary.blocked)} "
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
        detail = ", ".join(summary.failed + summary.blocked) or "input change"
        print(
            "validation-evidence: FAIL (failed or blocked: "
            + detail
            + "; evidence records retained honestly)",
            file=sys.stderr,
        )
    return code


def validate_record_shape(
    registry: Registry,
    gate_id: str,
    gate: dict[str, Any],
    record: Any,
    profile_id: str,
) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise EvidenceError("record must be a JSON object")
    extra = set(record) - RECORD_KEYS
    missing = {
        "schemaVersion",
        "gate",
        "kind",
        "profile",
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
    if record["profile"] != profile_id:
        raise EvidenceError(
            f"record profile {record['profile']!r} does not match proof profile {profile_id!r}"
        )
    if record["profile"] not in gate_profile_ids(gate, gate_id):
        raise EvidenceError(f"record profile {record['profile']!r} is not supported by gate {gate_id!r}")
    if record["profile"] not in registry.profiles:
        raise EvidenceError(f"record profile {record['profile']!r} is not declared in the tracked registry")
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
    if gate.get("kind") == "generated-delta":
        raise EvidenceError(
            f"gate {gate_id!r} is a generated-delta smoke; it executes in CI and is not verified as reusable evidence"
        )
    profile_id = resolve_profile(registry, gate_id, args.profile)
    declared_environment = profile_environment(registry, profile_id)
    record_path = record_path_for(root, registry, gate_id, profile_id)
    if not record_path.is_file():
        raise EvidenceError(
            f"no evidence record at {record_path.relative_to(root)} for proof profile {profile_id!r}"
        )
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise EvidenceError(f"malformed evidence record: {exc}") from exc
    record = validate_record_shape(registry, gate_id, gate, record, profile_id)

    snapshot = load_snapshot(root, registry)
    dimensions = environment_dimensions(gate, gate_id)
    mismatch = environment_mismatch(record.get("environment"), declared_environment, dimensions)
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
    command_digests = {
        command["id"]: command_inputs_digest(command, gate, scope, declared_environment, dimensions)
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
        dependency_profile = resolve_profile(registry, consumed_gate, profile_id)
        if dependency_profile != profile_id:
            raise EvidenceError(
                f"consumed dependency {consumed_gate!r} is not proven for profile {profile_id!r}"
            )
        dependency_record_path = record_path_for(root, registry, consumed_gate, profile_id)
        if not dependency_record_path.is_file():
            raise EvidenceError(
                f"consumed dependency {consumed_gate!r} has no record for profile {profile_id!r}; "
                "the composed proof is not applicable"
            )
        dependency_record = validate_record_shape(
            registry,
            consumed_gate,
            dependency_gate,
            json.loads(dependency_record_path.read_text(encoding="utf-8")),
            profile_id,
        )
        dependency_scope, _ = scope_digest(
            snapshot, [str(item) for item in dependency_gate.get("paths", [])]
        )
        if item.get("digest") != dependency_scope:
            raise EvidenceError(
                f"consumed dependency {consumed_gate!r} inputs changed; the composed proof is not applicable"
            )
        dependency_digests = {
            command["id"]: command_inputs_digest(
                command,
                dependency_gate,
                dependency_scope,
                profile_environment(registry, profile_id),
                environment_dimensions(dependency_gate, consumed_gate),
            )
            for command in gate_commands(dependency_gate)
        }
        dependency_ok, dependency_reason = record_applicable(
            dependency_record,
            consumed_gate,
            dependency_gate,
            profile_id,
            dependency_scope,
            dependency_digests,
            declared_environment,
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
        f"gate={gate_id} profile={profile_id} mode={mode} scope={scope} source={record['source']['digest']} "
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
                    "profile": profile_id,
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
    """Execute one gate as the CI fallback and persist what actually ran.

    This is the entry point behind ``verify-or-execute.sh`` when no applicable
    record exists. It must not merely print PASS: the whole reuse policy depends
    on the execution writing a record the verifier accepts later. It therefore
    validates that the live host can truthfully produce the requested profile
    (or a tracked fallback), snapshots the inputs before and after, retains a
    FAIL record for failed or tainted work, and writes the completed record
    atomically with the same schema and builder the collector uses.
    """
    registry = load_registry(args.registry)
    root = repo_root(args.root)
    gate_id = args.gate
    if not gate_id or gate_id not in registry.gates:
        raise EvidenceError(f"gate {gate_id!r} is not approved in the tracked registry")
    gate = registry.gates[gate_id]
    requested_profile = resolve_profile(registry, gate_id, args.profile)
    forced = bool(getattr(args, "forced", False))
    if not forced:
        raise EvidenceError(
            "run executes the approved commands and records the result; pass --forced "
            "(the CI fallback path always does)"
        )
    generated_delta = gate.get("kind") == "generated-delta"
    environment = probe_environment()

    if generated_delta:
        # A generated-delta smoke is deliberately never reusable evidence: it
        # runs on the event that changed the generated artifact set and writes
        # no record, so it cannot be mistaken for proof of a later input set.
        profile_id = requested_profile
    else:
        dirty = working_tree_dirt(root, registry)
        if dirty:
            preview = ", ".join(dirty[:10])
            raise EvidenceError(
                f"working tree must be clean before executing gate evidence (dirty: {preview})"
            )
        profile_id = select_producing_profile(registry, gate_id, requested_profile, environment)
        if profile_id != requested_profile:
            print(
                f"validation-evidence: requested profile {requested_profile!r} cannot be produced on this host; "
                f"producing tracked fallback profile {profile_id!r} with its real environment",
                file=sys.stderr,
            )

    before = load_snapshot(root, registry)
    plan = build_plans(root, registry, [gate_id], before, {gate_id: profile_id}, force=True)[0]
    processes = ProcessRegistry()
    cancel = threading.Event()
    received_signal: list[int] = []

    def handle_signal(signum: int, _frame: Any) -> None:
        received_signal.append(signum)
        cancel.set()
        processes.terminate_all()

    previous_int = signal.signal(signal.SIGINT, handle_signal)
    previous_term = signal.signal(signal.SIGTERM, handle_signal)
    try:
        commands, consumed, executed, reused, failures = execute_gate_commands(
            root=root,
            registry=registry,
            plan=plan,
            environment=environment,
            processes=processes,
            cancel=cancel,
        )
    except RunCancelled:
        processes.terminate_all()
        print("validation-evidence: interrupted (no record written)", file=sys.stderr)
        return EXIT_TERMINATED if signal.SIGTERM in received_signal else EXIT_INTERRUPTED
    finally:
        signal.signal(signal.SIGINT, previous_int)
        signal.signal(signal.SIGTERM, previous_term)

    if generated_delta:
        if failures:
            print(
                "validation-evidence: FAIL (executed " + ", ".join(failures) + ")",
                file=sys.stderr,
            )
            return EXIT_FAIL
        print(
            f"validation-evidence: PASS (executed {executed} approved command(s) for gate={gate_id} "
            f"profile={profile_id}; generated-delta smoke is never reusable evidence)"
        )
        return EXIT_PASS

    after = load_snapshot(root, registry)
    tainted = after.global_identity() != before.global_identity()
    if tainted:
        verdict = "FAIL"
        reason = "relevant inputs changed during the run; the record is not reusable"
    elif failures:
        verdict = "FAIL"
        reason = "command failed: " + ", ".join(failures)
    else:
        verdict = "PASS"
        reason = ""
    result = finalize_gate_record(
        root=root,
        registry=registry,
        plan=plan,
        snapshot=after,
        environment=environment,
        commands=commands,
        consumed=consumed,
        verdict=verdict,
        reason=reason,
        reviews=[],
        verify_when_pass=True,
    )
    record_ref = str(result.record_path.relative_to(root)) if result.record_path else "?"
    if result.verdict != "PASS":
        print(
            f"validation-evidence: FAIL (gate={gate_id} profile={profile_id} record={record_ref} "
            f"{result.reason})",
            file=sys.stderr,
        )
        return EXIT_FAIL
    print(
        f"validation-evidence: PASS (executed {executed} approved command(s) for gate={gate_id} "
        f"profile={profile_id} reused={reused}; wrote {record_ref})"
    )
    return EXIT_PASS


def probe(args: argparse.Namespace) -> int:
    print(json.dumps(probe_environment(), indent=2, sort_keys=True))
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
    finalized = 0
    for gate_id in gate_ids:
        gate = registry.gates[gate_id]
        profile_id = resolve_profile(registry, gate_id, args.profile)
        record_path = record_path_for(root, registry, gate_id, profile_id)
        if not record_path.is_file():
            continue
        record = validate_record_shape(
            registry, gate_id, gate, json.loads(record_path.read_text(encoding="utf-8")), profile_id
        )
        existing = {(item.get("ref"), item.get("kind")) for item in record.get("reviews", []) if isinstance(item, dict)}
        for ref in args.review_ref:
            if (ref, "review-reference") not in existing:
                record.setdefault("reviews", []).append({"ref": ref, "kind": "review-reference"})
        write_record(root, registry, record)
        finalized += 1
        print(
            f"validation-evidence: finalized {record_path.relative_to(root)} "
            f"profile={profile_id} reviews={len(record.get('reviews', []))}"
        )
    if finalized == 0:
        raise EvidenceError("finalize found no record for the requested gate and proof profile")
    return EXIT_PASS


def produced_records(args: argparse.Namespace) -> int:
    """Resolve the records this job actually wrote into uploadable paths.

    A workflow must upload the record its execution produced, not whatever
    ``*.json`` the checkout happened to contain. This reads the producer
    manifest written by real record writes, checks each named path is the exact
    gate/profile record for the tracked registry, is present, is not bundled
    with the checkout, and (for a PASS record) still verifies on the current
    inputs. When nothing was produced it reports ``any=false`` so the upload
    step is skipped instead of publishing stale receipts as new proof.
    """
    registry = load_registry(args.registry)
    root = repo_root(args.root)
    manifest_value = args.manifest or os.environ.get(PRODUCED_MANIFEST_ENV, "")
    if args.require_manifest and not manifest_value:
        raise EvidenceError(
            f"no producer manifest is configured; set {PRODUCED_MANIFEST_ENV} "
            "so a CI job can require the records it actually wrote"
        )
    entries: list[tuple[str, str]] = []
    if manifest_value:
        manifest_path = Path(manifest_value)
        if not manifest_path.is_absolute():
            manifest_path = root / manifest_path
        if manifest_path.is_file():
            for line in manifest_path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                relative_text, _, digest_text = line.strip().partition("\t")
                candidate = Path(relative_text.strip())
                if candidate.is_absolute():
                    try:
                        candidate = candidate.resolve().relative_to(root.resolve())
                    except ValueError as exc:
                        raise EvidenceError(
                            f"produced record {relative_text!r} is outside the repository"
                        ) from exc
                entry = (str(candidate).strip("/"), digest_text.strip())
                # A later write of the same record supersedes an earlier one (a
                # taint rewrite keeps the retained FAIL result authoritative).
                entries = [item for item in entries if item[0] != entry[0]]
                entries.append(entry)

    verified: list[str] = []
    evidence_directory = registry.evidence_directory
    for relative, expected_digest in entries:
        # The evidence directory is itself a path, so a record sits at
        # <directory>/<gate>/<profile>.json at whatever depth the registry names.
        record_parts: tuple[str, ...] = ()
        if is_evidence_path(relative, evidence_directory):
            record_parts = Path(relative[len(evidence_directory) :].lstrip("/")).parts
        if len(record_parts) != 2 or not record_parts[1].endswith(".json"):
            raise EvidenceError(
                f"produced evidence path {relative!r} is not "
                f"{evidence_directory}/<gate>/<profile>.json"
            )
        gate_id, profile_id = record_parts[0], record_parts[1][: -len(".json")]
        if not GATE_ID_RE.fullmatch(gate_id) or not PROFILE_ID_RE.fullmatch(profile_id):
            raise EvidenceError(f"produced evidence path {relative!r} names an invalid gate or profile")
        if gate_id not in registry.gates:
            raise EvidenceError(f"produced evidence path {relative!r} names an unapproved gate")
        gate = registry.gates[gate_id]
        if profile_id not in gate_profile_ids(gate, gate_id) or profile_id not in registry.profiles:
            raise EvidenceError(
                f"produced evidence path {relative!r} names a profile the gate does not support"
            )
        target = record_path_for(root, registry, gate_id, profile_id)
        if not target.is_file():
            raise EvidenceError(f"produced record is missing: {relative}")
        try:
            payload = target.read_bytes()
        except OSError as exc:
            raise EvidenceError(f"produced record {relative} is unreadable: {exc}") from exc
        if expected_digest and not DIGEST_RE.fullmatch(expected_digest):
            raise EvidenceError(f"produced manifest digest for {relative} is malformed")
        if expected_digest and sha256_bytes(payload) != expected_digest:
            raise EvidenceError(f"produced record {relative} changed after it was written")
        tracked = subprocess.run(
            ["git", "ls-files", "--error-unmatch", "--", relative],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
        if tracked.returncode == 0:
            unchanged = subprocess.run(
                ["git", "diff", "--quiet", "--", relative],
                cwd=root,
                capture_output=True,
                text=True,
                check=False,
            )
            if unchanged.returncode == 0:
                raise EvidenceError(
                    f"{relative} is bundled with the checkout, not produced by this run"
                )
            if unchanged.returncode != 1:
                raise EvidenceError(f"cannot compare {relative} with the checkout: {unchanged.stderr.strip()}")
        try:
            record = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise EvidenceError(f"produced record {relative} is unreadable: {exc}") from exc
        if not isinstance(record, dict) or record.get("gate") != gate_id or record.get("profile") != profile_id:
            raise EvidenceError(f"produced record {relative} does not describe {gate_id}/{profile_id}")
        verdict = record.get("verdict")
        if verdict not in {"PASS", "FAIL"}:
            raise EvidenceError(f"produced record {relative} has an invalid verdict {verdict!r}")
        if verdict == "PASS":
            completed = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--registry",
                    str(registry.path),
                    "verify",
                    "--root",
                    str(root),
                    "--gate",
                    gate_id,
                    "--profile",
                    profile_id,
                ],
                cwd=root,
                capture_output=True,
                text=True,
                check=False,
            )
            if completed.returncode != 0:
                detail = (completed.stderr.strip().splitlines() or ["verification failed"])[-1]
                raise EvidenceError(f"produced record {relative} does not verify: {detail}")
        verified.append(relative)

    any_value = "true" if verified else "false"
    output_path = os.environ.get("GITHUB_OUTPUT", "")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as handle:
            handle.write(f"any={any_value}\n")
        if verified:
            with open(output_path, "a", encoding="utf-8") as handle:
                handle.write("paths<<APPTHEORY_PRODUCED_RECORDS\n")
                for relative in verified:
                    handle.write(f"{relative}\n")
                handle.write("APPTHEORY_PRODUCED_RECORDS\n")
    else:
        for relative in verified:
            print(relative)
    print(f"produced-records: any={any_value} records={len(verified)}")
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
    collect_parser.add_argument("--profile", help="tracked proof profile to collect (default: the gate's first)")
    collect_parser.add_argument("--force", action="store_true", help="ignore applicable records and execute")
    collect_parser.add_argument("--dry-run", action="store_true", help="print the schedule without executing")
    collect_parser.add_argument("--jobs", type=int, help="bounded worker count (1-8)")
    collect_parser.add_argument("--review-ref", action="append", default=[])
    collect_parser.set_defaults(handler=collect)

    verify_parser = subparsers.add_parser("verify", help="verify evidence without executing the recorded commands")
    verify_parser.add_argument("--root", type=Path)
    verify_parser.add_argument("--gate", required=True)
    verify_parser.add_argument("--profile", help="tracked proof profile to verify (default: the gate's first)")
    verify_parser.add_argument("--json", action="store_true")
    verify_parser.set_defaults(handler=verify)

    project_parser = subparsers.add_parser("inputs-digest", help="print the current input projections")
    project_parser.add_argument("--root", type=Path)
    project_parser.set_defaults(handler=project)

    probe_parser = subparsers.add_parser("probe", help="print the probed live environment")
    probe_parser.set_defaults(handler=probe)

    run_parser = subparsers.add_parser(
        "run",
        help="execute the approved commands for one gate and record the producing environment",
    )
    run_parser.add_argument("--root", type=Path)
    run_parser.add_argument("--gate", required=True)
    run_parser.add_argument("--profile", help="tracked proof profile to record (requests a fallback when the host cannot produce it)")
    run_parser.add_argument("--forced", action="store_true", help="required: execute every command and refuse nested composition")
    run_parser.set_defaults(handler=run_gate)

    produced_parser = subparsers.add_parser(
        "produced-records",
        help="resolve the records this job wrote into strict upload paths",
    )
    produced_parser.add_argument("--root", type=Path)
    produced_parser.add_argument(
        "--manifest",
        help=f"producer manifest (default: ${PRODUCED_MANIFEST_ENV})",
    )
    produced_parser.add_argument(
        "--require-manifest",
        action="store_true",
        help="fail when no producer manifest is configured (CI upload contract)",
    )
    produced_parser.set_defaults(handler=produced_records)

    finalize_parser = subparsers.add_parser("finalize", help="add review references to an existing record")
    finalize_parser.add_argument("--root", type=Path)
    finalize_parser.add_argument("--gate")
    finalize_parser.add_argument("--profile", help="tracked proof profile whose record is finalized")
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
