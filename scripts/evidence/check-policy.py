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


def fail(message: str) -> None:
    print(f"validation-policy: FAIL ({message})", file=sys.stderr)
    raise SystemExit(1)


def is_release_only(relative: str, policy: dict) -> bool:
    if relative in set(policy.get("exact", [])):
        return True
    if any(relative.startswith(prefix) for prefix in policy.get("prefixes", [])):
        return True
    return any(fnmatch.fnmatchcase(relative, pattern) for pattern in policy.get("patterns", []))


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

    policy = registry["releaseOnly"]
    for prefix in policy.get("prefixes", []):
        if not prefix.endswith("/") or len(prefix.strip("/")) < 3:
            fail(f"release-only prefix {prefix!r} is not a tightly named directory")

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

    docs = DOCS.read_text(encoding="utf-8")
    for leg_id in sorted(REQUIRED_LEGS):
        if f"| `{leg_id}` |" not in docs:
            fail(f"docs table is missing execution leg {leg_id}")

    result = subprocess.run(
        ["git", "check-ignore", "-q", "gov-infra/evidence/proportionate/rubric.json"],
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
