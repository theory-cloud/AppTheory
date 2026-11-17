#!/usr/bin/env python3
"""Fail closed when the validation policy drifts from the release automation.

The policy registry is the machine-readable half of the operator-authorized
execution-policy change; docs/development/validation-evidence.md is the human
half. This checker keeps them in step with the release-please configuration and
the generated-file triggers, so neither an extra release-only path nor a new
source script can slip past the digest classification silently.
"""

from __future__ import annotations

import fnmatch
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REGISTRY = ROOT / "scripts/evidence/validation-gates.json"
DOCS = ROOT / "docs/development/validation-evidence.md"

APPROVED_GATES = {
    "rubric",
    "deterministic-builds",
    "go",
    "unit",
    "ts",
    "py",
    "contract-tests",
    "cdk-go-drift",
    "examples-local",
    "security-refresh",
    "release-delta",
}

REQUIRED_LEGS = {
    "pr-staging",
    "push-staging",
    "pr-staging-premain",
    "push-premain",
    "release-pr-premain",
    "release-merge-premain",
    "pr-premain-main",
    "push-main",
    "release-pr-main",
    "release-merge-main",
    "backmerge-main-staging",
}

SOURCE_RERUN_MARKERS = (
    "make rubric",
    "verify-contract-tests.sh",
    "examples-local",
    "verify-go.sh",
)

# The release-notes class is the one place where a tracked path can stop staling
# evidence: its files carry release history, not product bytes, so no record
# binds their content. That makes silent growth the risk the class has to
# survive, so the reviewed set is fixed here and the registry must match it
# exactly. Adding a path therefore needs both this allowlist and the registry
# edit in the same reviewed change.
APPROVED_RELEASE_NOTES = {
    "CHANGELOG.md",
    ".release-please-manifest.json",
    ".release-please-manifest.premain.json",
}

# The release-derived class is the only other place where a tracked path stops
# binding its bytes: these two artifacts are *rebuilt* by the release lane, so a
# release rewrites them in ways version-literal normalization cannot describe.
# The reviewed map is fixed here, the registry must match it exactly, and each
# entry names either one exact path or one anchored pattern with a single
# `{{version}}` placeholder in the file name -- no directories, no other globs.
APPROVED_RELEASE_DERIVED = {
    "cdk/.jsii": "jsii-assembly",
    "cdk-go/apptheorycdk/jsii/theory-cloud-apptheory-cdk-{{version}}.tgz": "jsii-tarball",
}
RELEASE_DERIVED_VERSION_TOKEN = "{{version}}"
RELEASE_DERIVED_VERSION_RE = re.compile(r"^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$")
RELEASE_DERIVED_PROJECTIONS = {"jsii-assembly", "jsii-tarball"}


def fail(message: str) -> None:
    print(f"validation-policy: FAIL ({message})", file=sys.stderr)
    raise SystemExit(1)


def is_release_only(relative: str, policy: dict) -> bool:
    if relative in set(policy.get("exact", [])):
        return True
    if any(relative.startswith(prefix) for prefix in policy.get("prefixes", [])):
        return True
    return any(fnmatch.fnmatchcase(relative, pattern) for pattern in policy.get("patterns", []))


def tracked_files() -> list[str]:
    completed = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        fail("tracked files cannot be enumerated")
    return [path for path in completed.stdout.decode("utf-8", "surrogateescape").split("\0") if path]


def paths_ignore(workflow: str) -> list[str]:
    text = (ROOT / ".github/workflows" / workflow).read_text(encoding="utf-8")
    try:
        block = text.split("    paths-ignore:\n", 1)[1]
    except IndexError:
        fail(f"{workflow} has no push paths-ignore block")
    entries: list[str] = []
    for line in block.splitlines():
        stripped = line.strip()
        if not stripped.startswith("- "):
            break
        entries.append(stripped[2:].strip().strip('"'))
    return entries


def main() -> int:
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    if registry.get("schemaVersion") != 1:
        fail("registry schemaVersion must be 1")
    gates = registry.get("gates", {})
    if set(gates) != APPROVED_GATES:
        fail(f"approved gate set drifted: {sorted(set(gates) ^ APPROVED_GATES)}")

    runner = registry.get("runner") or {}
    if int(runner.get("maxWorkers", 0)) < 1:
        fail("runner.maxWorkers must be a positive conservative bound")
    resources = runner.get("resources") or {}
    if not resources:
        fail("runner.resources must declare the tracked resource groups")
    for name, capacity in resources.items():
        if int(capacity) < 1:
            fail(f"resource {name!r} must have a positive capacity")
    if not registry.get("nonProductPaths"):
        fail("nonProductPaths must declare the paths whose change cannot affect product proof")

    profiles = registry.get("proofProfiles")
    if not isinstance(profiles, dict) or not profiles:
        fail("registry must declare proofProfiles")
    for profile_id, profile in profiles.items():
        if not isinstance(profile, dict):
            fail(f"proof profile {profile_id} must be an object")
        environment = profile.get("environment")
        if not isinstance(environment, dict):
            fail(f"proof profile {profile_id} must declare an environment")
        for dimension in ("go", "node", "python"):
            if not isinstance(environment.get(dimension), str) or not environment[dimension]:
                fail(f"proof profile {profile_id} must declare {dimension}")
        platform_value = environment.get("platform")
        if not isinstance(platform_value, dict) or not platform_value.get("os") or not platform_value.get("arch"):
            fail(f"proof profile {profile_id} must declare platform os/arch")

    for gate_id, gate in gates.items():
        paths = gate.get("paths")
        if not isinstance(paths, list) or not paths:
            fail(f"gate {gate_id} must declare its input scope")
        gate_profiles = gate.get("profiles") or ["default"]
        if not isinstance(gate_profiles, list) or not gate_profiles:
            fail(f"gate {gate_id} must declare at least one supported proof profile")
        for profile_id in gate_profiles:
            if profile_id not in profiles:
                fail(f"gate {gate_id} supports undeclared proof profile {profile_id!r}")
        fallbacks = gate.get("fallbackProfiles", [])
        if not isinstance(fallbacks, list):
            fail(f"gate {gate_id} fallbackProfiles must be a list")
        for fallback_profile in fallbacks:
            if fallback_profile not in gate_profiles:
                fail(
                    f"gate {gate_id} declares fallback profile {fallback_profile!r} "
                    "it does not support"
                )
        declared_resources = gate.get("resources", [gate.get("resource")])
        if isinstance(declared_resources, str):
            declared_resources = [declared_resources]
        if not declared_resources:
            fail(f"gate {gate_id} must declare its resource groups")
        for declared_resource in declared_resources:
            if declared_resource not in resources:
                fail(f"gate {gate_id} declares unknown resource {declared_resource!r}")
        for dependency in gate.get("dependsOn", []):
            if dependency not in gates:
                fail(f"gate {gate_id} depends on unknown gate {dependency!r}")
        composed_from = gate.get("composedFrom", [])
        if not isinstance(composed_from, list):
            fail(f"gate {gate_id} composedFrom must be a list")
        for dependency in composed_from:
            if dependency not in gates:
                fail(f"gate {gate_id} composes unknown gate {dependency!r}")
            if dependency not in gate.get("dependsOn", []):
                fail(f"gate {gate_id} composes {dependency!r} without a declared dependency")
            for command in gate.get("commands", []):
                reuse = (command.get("env") or {}).get("APPTHEORY_EVIDENCE_REUSE", "")
                if dependency not in reuse.split(","):
                    fail(
                        f"gate {gate_id} command {command.get('id')} does not reuse "
                        f"its composed gate {dependency!r}"
                    )
        for command in gate.get("commands", []):
            command_resources = command.get("resources", command.get("resource", declared_resources))
            if isinstance(command_resources, str):
                command_resources = [command_resources]
            for command_resource in command_resources:
                if command_resource not in resources:
                    fail(f"gate {gate_id} command {command.get('id')} declares unknown resource {command_resource!r}")
            reuse = (command.get("env") or {}).get("APPTHEORY_EVIDENCE_REUSE", "")
            for reused in [item for item in reuse.split(",") if item]:
                if reused not in gates:
                    fail(f"gate {gate_id} command {command.get('id')} reuses unknown gate {reused!r}")
                if reused not in gate.get("dependsOn", []):
                    fail(
                        f"gate {gate_id} command {command.get('id')} reuses {reused!r} "
                        "without a declared dependency"
                    )

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(gate_id: str) -> None:
        if gate_id in visited:
            return
        if gate_id in visiting:
            fail(f"gate dependency cycle at {gate_id!r}")
        visiting.add(gate_id)
        for dependency in gates[gate_id].get("dependsOn", []):
            visit(dependency)
        visiting.remove(gate_id)
        visited.add(gate_id)

    for gate_id in gates:
        visit(gate_id)

    rubric_commands = gates["rubric"].get("commands", [])
    rubric_reuse = ",".join(
        (command.get("env") or {}).get("APPTHEORY_EVIDENCE_REUSE", "") for command in rubric_commands
    )
    if not rubric_reuse.strip(","):
        fail("the rubric gate must compose verified product records instead of re-running them")
    for required in ("go", "unit", "contract-tests", "cdk-go-drift", "deterministic-builds"):
        if required not in rubric_reuse.split(","):
            fail(f"the rubric gate must compose the {required!r} record")

    policy = registry["releaseOnly"]
    for prefix in policy.get("prefixes", []):
        if not prefix.endswith("/") or len(prefix.strip("/")) < 3:
            fail(f"release-only prefix {prefix!r} is not a tightly named directory")

    notes = registry.get("releaseNotes")
    if not isinstance(notes, dict):
        fail("registry must declare the releaseNotes class")
    if set(notes) - {"exact"}:
        fail(f"releaseNotes must declare exact paths only: unexpected {sorted(set(notes) - {'exact'})}")
    declared_notes = notes.get("exact")
    if not isinstance(declared_notes, list) or not declared_notes:
        fail("releaseNotes.exact must be a non-empty list of paths")
    if set(declared_notes) != APPROVED_RELEASE_NOTES:
        fail(
            "releaseNotes must match the reviewed allowlist exactly: "
            f"missing {sorted(APPROVED_RELEASE_NOTES - set(declared_notes))}, "
            f"unreviewed {sorted(set(declared_notes) - APPROVED_RELEASE_NOTES)}"
        )
    security_inputs = registry.get("securityInputs") or {}
    for path in sorted(declared_notes):
        if any(char in path for char in "*?[]") or path.endswith("/"):
            fail(f"release-notes path {path!r} must name one file, never a glob or a directory")
        if not (ROOT / path).is_file():
            fail(f"release-notes path {path!r} is not a tracked file in this repository")
        if not is_release_only(path, policy):
            fail(f"release-notes path {path!r} must also be release-only, so it stays out of the source projection")
        for prefix in policy.get("prefixes", []):
            if path.startswith(prefix):
                fail(f"release-notes path {path!r} is inside the product-bytes prefix {prefix!r}")
        if path in set(security_inputs.get("exact", [])):
            fail(f"release-notes path {path!r} must not also be a dependency-scan input")
        for pattern in security_inputs.get("patterns", []):
            if fnmatch.fnmatchcase(path, pattern):
                fail(f"release-notes path {path!r} matches dependency-scan input {pattern!r}")

    derived = registry.get("releaseDerived")
    if not isinstance(derived, dict):
        fail("registry must declare the releaseDerived class")
    if set(derived) - {"projections"}:
        fail(f"releaseDerived must declare projections only: unexpected {sorted(set(derived) - {'projections'})}")
    projections = derived.get("projections")
    if not isinstance(projections, dict) or not projections:
        fail("releaseDerived.projections must be a non-empty object")
    if projections != APPROVED_RELEASE_DERIVED:
        fail(
            "releaseDerived.projections must match the reviewed allowlist exactly: "
            f"missing {sorted(set(APPROVED_RELEASE_DERIVED) - set(projections))}, "
            f"unreviewed {sorted(set(projections) - set(APPROVED_RELEASE_DERIVED))}, "
            f"or a changed projection {sorted(k for k in projections if k in APPROVED_RELEASE_DERIVED and projections[k] != APPROVED_RELEASE_DERIVED[k])}"
        )
    tracked = tracked_files()
    for entry, projection in sorted(projections.items()):
        if projection not in RELEASE_DERIVED_PROJECTIONS:
            fail(f"release-derived entry {entry!r} declares unknown projection {projection!r}")
        if entry in APPROVED_RELEASE_NOTES:
            fail(f"release-derived entry {entry!r} must not also be release-notes history")
        if not is_release_only(entry, policy):
            fail(f"release-derived entry {entry!r} must also be release-only")
        if entry.count(RELEASE_DERIVED_VERSION_TOKEN) > 1:
            fail(f"release-derived entry {entry!r} may use {RELEASE_DERIVED_VERSION_TOKEN} at most once")
        if entry.endswith("/"):
            fail(f"release-derived entry {entry!r} must name a file, never a directory")
        if entry in set(security_inputs.get("exact", [])) or any(
            fnmatch.fnmatchcase(entry, pattern) for pattern in security_inputs.get("patterns", [])
        ):
            fail(f"release-derived entry {entry!r} must not also be a dependency-scan input")
        if RELEASE_DERIVED_VERSION_TOKEN in entry:
            prefix, _, suffix = entry.partition(RELEASE_DERIVED_VERSION_TOKEN)
            if not prefix or not suffix:
                fail(f"release-derived entry {entry!r} must anchor both sides of {RELEASE_DERIVED_VERSION_TOKEN}")
            if "*" in prefix + suffix or "?" in prefix + suffix or "[" in prefix + suffix:
                fail(f"release-derived entry {entry!r} must not mix {RELEASE_DERIVED_VERSION_TOKEN} with another glob")
            if "/" in suffix:
                fail(f"release-derived entry {entry!r} must keep {RELEASE_DERIVED_VERSION_TOKEN} inside the file name")
            matches = [
                path
                for path in tracked
                if path.startswith(prefix)
                and path.endswith(suffix)
                and RELEASE_DERIVED_VERSION_RE.fullmatch(path[len(prefix) : len(path) - len(suffix)])
            ]
            if len(matches) != 1:
                fail(
                    f"release-derived entry {entry!r} must describe exactly one tracked file; "
                    f"found {len(matches)}: {sorted(matches)}"
                )
            directory = prefix.rsplit("/", 1)[0]
            if not (ROOT / directory).is_dir():
                fail(f"release-derived entry {entry!r} names a missing directory {directory!r}")
        elif entry not in tracked:
            fail(f"release-derived entry {entry!r} is not a tracked file in this repository")

    for config_name in ("release-please-config.json", "release-please-config.premain.json"):
        config = json.loads((ROOT / config_name).read_text(encoding="utf-8"))
        for package in config.get("packages", {}).values():
            for extra in package.get("extra-files", []):
                path = extra.get("path", "")
                if path and not is_release_only(path, policy):
                    fail(f"{config_name} extra-file {path} is not classified as release-only")

    for workflow in ("prerelease-pr.yml", "release-pr.yml"):
        for path in paths_ignore(workflow):
            if not is_release_only(path, policy):
                fail(f"{workflow} paths-ignore {path} is not classified as release-only")

    for required in ("cdk/.jsii", "cdk/lib/app.js", "cdk-go/apptheorycdk/apptheorycdk.go", "VERSION"):
        if not is_release_only(required, policy):
            fail(f"release-only set must cover {required}")

    delta = gates["release-delta"]
    for command in delta.get("commands", []):
        argv = " ".join(command.get("argv", []))
        for marker in SOURCE_RERUN_MARKERS:
            if marker in argv:
                fail(f"release-delta must not repeat the source suite; found {marker!r} in {argv!r}")

    security = gates["security-refresh"]
    if int(security.get("maxAgeSeconds", -1)) != 86400:
        fail("security-refresh maxAgeSeconds must stay the tracked 24-hour default")
    if int(registry.get("securityMaxAgeSeconds", -1)) != 86400:
        fail("registry securityMaxAgeSeconds must stay the tracked 24-hour default")

    matrix = {entry.get("id"): entry for entry in registry.get("executionMatrix", [])}
    if set(matrix) != REQUIRED_LEGS:
        fail(f"execution matrix drifted: {sorted(set(matrix) ^ REQUIRED_LEGS)}")
    for leg_id, entry in matrix.items():
        if not entry.get("old") or not entry.get("new"):
            fail(f"execution matrix leg {leg_id} must record both old and new execution")

    for gate_id, gate in gates.items():
        composed_from = gate.get("composedFrom") or []
        if not composed_from:
            continue
        for command in gate.get("commands", []):
            argv = command.get("argv") or []
            if len(argv) < 2 or argv[0] != "bash":
                fail(f"gate {gate_id} composed command {command.get('id')} must run a tracked shell script")
            script_path = ROOT / argv[1]
            if not script_path.is_file():
                fail(f"gate {gate_id} composed command {command.get('id')} script {argv[1]} is missing")
            script = script_path.read_text(encoding="utf-8")
            for dependency in composed_from:
                if f"reuse-if-recorded.sh {dependency}" not in script:
                    fail(
                        f"gate {gate_id} command {command.get('id')} composes {dependency!r} "
                        f"but {argv[1]} never consumes it"
                    )

    docs = DOCS.read_text(encoding="utf-8")
    for leg_id in sorted(REQUIRED_LEGS):
        if f"| `{leg_id}` |" not in docs:
            fail(f"docs table is missing execution leg {leg_id}")
    for token in (
        "--force",
        "--dry-run",
        "zero commands",
        "resource group",
        "declared input scope",
        "--profile",
        "proof profile",
        "fallback profile",
        "executed once per profile",
        "Linux release artifact construction",
        "produced record",
        "tc-toolchain",
        "release-notes",
        "release-derived",
        "jsii",
    ):
        if token not in docs:
            fail(f"docs must document the corrected collector default: missing {token!r}")

    result = subprocess.run(
        ["git", "check-ignore", "-q", "gov-infra/evidence/proportionate/rubric/default.json"],
        cwd=ROOT,
        check=False,
    )
    if result.returncode == 0:
        fail("evidence records must be trackable, but the records path is git-ignored")
    result = subprocess.run(
        ["git", "check-ignore", "-q", "gov-infra/evidence/proportionate/local/rubric.log"],
        cwd=ROOT,
        check=False,
    )
    if result.returncode != 0:
        fail("local evidence logs must stay ignored")

    print(
        "validation-policy: PASS "
        f"({len(gates)} gates, {len(matrix)} execution legs, release-only paths cover both release-please configs)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
