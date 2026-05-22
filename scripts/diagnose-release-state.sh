#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 - "$@" <<'PY'
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

STABLE_MANIFEST = ".release-please-manifest.json"
PREMAIN_MANIFEST = ".release-please-manifest.premain.json"


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


def run(cmd: list[str]) -> CommandResult:
    completed = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
    return CommandResult(completed.returncode, completed.stdout.strip(), completed.stderr.strip())


def git(args: list[str]) -> str | None:
    completed = run(["git", *args])
    if completed.returncode != 0:
        return None
    return completed.stdout


def git_ref_exists(ref: str) -> bool:
    return run(["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"]).returncode == 0


def git_commit(ref: str) -> str | None:
    return git(["rev-parse", f"{ref}^{{commit}}"])


def short_sha(value: str | None) -> str:
    if not value:
        return "unknown"
    return value[:12]


def current_branch() -> str:
    github_ref = os.environ.get("GITHUB_REF", "")
    github_ref_name = os.environ.get("GITHUB_REF_NAME", "")
    if github_ref.startswith("refs/heads/"):
        return github_ref_name or github_ref.removeprefix("refs/heads/")
    if github_ref.startswith("refs/tags/"):
        return f"tag:{github_ref_name or github_ref.removeprefix('refs/tags/')}"

    branch = git(["branch", "--show-current"])
    if branch:
        return branch

    head = git_commit("HEAD")
    return f"detached@{short_sha(head)}"


def infer_tag(explicit_tag: str | None) -> str | None:
    for value in (
        explicit_tag,
        os.environ.get("TAG_NAME"),
    ):
        if value:
            return value

    github_ref = os.environ.get("GITHUB_REF", "")
    github_ref_name = os.environ.get("GITHUB_REF_NAME", "")
    if github_ref.startswith("refs/tags/"):
        return github_ref_name or github_ref.removeprefix("refs/tags/")

    if Path("scripts/read-version.sh").is_file():
        completed = run(["bash", "scripts/read-version.sh"])
        if completed.returncode == 0 and completed.stdout:
            return "v" + completed.stdout.removeprefix("v")
    return None


def manifest_version(ref: str, path: str) -> str:
    text = git(["show", f"{ref}:{path}"])
    if text is None:
        return "missing"
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return "invalid-json"
    value = data.get(".")
    return value if isinstance(value, str) and value else "missing-version"


def branch_refs() -> dict[str, str]:
    refs: dict[str, str] = {}
    for branch in ("main", "staging", "premain"):
        remote_ref = f"origin/{branch}"
        refs[branch] = remote_ref if git_ref_exists(remote_ref) else branch
    return refs


def manifest_state() -> list[tuple[str, str, str, str, str]]:
    rows: list[tuple[str, str, str, str, str]] = []
    for branch, ref in branch_refs().items():
        rows.append(
            (
                branch,
                ref,
                short_sha(git_commit(ref)),
                manifest_version(ref, STABLE_MANIFEST),
                manifest_version(ref, PREMAIN_MANIFEST),
            )
        )
    return rows


def gh_available() -> bool:
    return run(["bash", "-lc", "command -v gh >/dev/null 2>&1"]).returncode == 0


def release_state(tag: str | None) -> dict[str, Any]:
    if not tag:
        return {"state": "unknown", "reason": "no tag could be inferred"}
    if not gh_available():
        return {"state": "unknown", "reason": "gh not found"}

    completed = run(
        [
            "gh",
            "release",
            "view",
            tag,
            "--json",
            "assets,isDraft,isPrerelease,tagName,targetCommitish,url",
        ]
    )
    if completed.returncode != 0:
        return {"state": "absent", "reason": completed.stderr or completed.stdout}

    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {"state": "unknown", "reason": "gh returned invalid JSON"}

    assets = data.get("assets")
    asset_names = []
    if isinstance(assets, list):
        for asset in assets:
            if isinstance(asset, dict) and isinstance(asset.get("name"), str):
                asset_names.append(asset["name"])

    return {
        "state": "draft" if data.get("isDraft") is True else "published",
        "target": data.get("targetCommitish") or "unknown",
        "prerelease": data.get("isPrerelease"),
        "url": data.get("url") or "",
        "assets": sorted(asset_names),
    }


def tag_state(tag: str | None) -> tuple[str, str]:
    if not tag:
        return ("unknown", "no tag could be inferred")
    target = git_commit(f"refs/tags/{tag}")
    if target:
        return ("present", target)
    return ("absent", "not present in local refs")


def verify_release_state() -> dict[str, Any]:
    completed = run(["bash", "scripts/verify-release-state.sh", "--live", "--json"])
    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError:
        data = {
            "valid": False,
            "classification": "unavailable",
            "active_tag": None,
            "diagnostics": [
                {
                    "code": "release-state:unavailable",
                    "message": completed.stderr or completed.stdout or "verify-release-state did not return JSON",
                }
            ],
        }
    if completed.returncode != 0:
        data["valid"] = False
    return data


def safe_next_action(classification: str, release_status: str, tag_status: str, diagnostics: list[dict[str, str]]) -> str:
    if diagnostics:
        return (
            "Fix the reported branch/manifest/tag/release invariant, then rerun the same publisher. "
            "Do not delete tags/releases or overwrite published assets."
        )
    if release_status == "published":
        return (
            "The release is already immutable. Rerun the publisher only to verify matching assets; "
            "if assets are wrong or missing, cut a new version instead of clobbering this release."
        )
    if release_status == "draft":
        return (
            "Rerun the same serialized publisher. Draft assets may be replaced only while the release "
            "is still draft; once published, reruns must verify and skip."
        )
    if tag_status == "present" or classification.endswith("-tagged"):
        return (
            "Rerun the same serialized publisher to recover the existing immutable tag into a draft "
            "release and publish it after verification."
        )
    if classification.endswith("-ready") or classification == "branch-manifest-ready":
        return "Rerun the release workflow from the same branch after fixing the failed job; no release mutation is required first."
    return "Stop and inspect the diagnostics before rerunning; do not mutate GitHub Releases manually."


def print_diagnostics(tag: str | None) -> None:
    head = git_commit("HEAD")
    tag_status, tag_detail = tag_state(tag)
    release = release_state(tag)
    release_status = str(release.get("state", "unknown"))
    verifier = verify_release_state()
    diagnostics = verifier.get("diagnostics") if isinstance(verifier.get("diagnostics"), list) else []
    classification = str(verifier.get("classification") or "unknown")

    print("release-diagnostics: BEGIN")
    print(f"release-diagnostics: branch={current_branch()} head={short_sha(head)}")
    print(f"release-diagnostics: tag={tag or 'unknown'} state={tag_status} target={tag_detail}")
    release_line = (
        f"release-diagnostics: release={tag or 'unknown'} state={release_status} "
        f"target={release.get('target', 'unknown')} prerelease={release.get('prerelease', 'unknown')}"
    )
    if release.get("url"):
        release_line += f" url={release['url']}"
    if release.get("reason"):
        release_line += f" reason={release['reason']}"
    print(release_line)
    assets = release.get("assets")
    if isinstance(assets, list):
        print(f"release-diagnostics: release-assets={','.join(assets) if assets else 'none'}")

    print("release-diagnostics: manifests:")
    for branch, ref, head_sha, stable, premain in manifest_state():
        print(
            "release-diagnostics: "
            f"  {branch} ref={ref} head={head_sha} stable={stable} premain={premain}"
        )

    valid = bool(verifier.get("valid"))
    active_tag = verifier.get("active_tag") or "none"
    print(f"release-diagnostics: verifier={'PASS' if valid else 'FAIL'} classification={classification} active={active_tag}")
    for item in diagnostics:
        if isinstance(item, dict):
            print(
                "release-diagnostics: "
                f"  {item.get('code', 'diagnostic')}: {item.get('message', '')}"
            )
    print(
        "release-diagnostics: safe-next-action="
        + safe_next_action(classification, release_status, tag_status, [item for item in diagnostics if isinstance(item, dict)])
    )
    print("release-diagnostics: END")


def self_test() -> int:
    cases = [
        (
            "invalid state blocks manual mutation",
            "invalid",
            "draft",
            "present",
            [{"code": "manifest:staging-stable-mismatch", "message": "staging is stale"}],
            "Fix the reported branch/manifest/tag/release invariant",
        ),
        (
            "published release is immutable",
            "stable-published",
            "published",
            "present",
            [],
            "already immutable",
        ),
        (
            "draft release reruns are safe",
            "prerelease-draft",
            "draft",
            "present",
            [],
            "Draft assets may be replaced only while the release is still draft",
        ),
        (
            "tagged release recovers through publisher",
            "prerelease-tagged",
            "absent",
            "present",
            [],
            "recover the existing immutable tag",
        ),
    ]
    failures: list[str] = []
    for name, classification, release_status, tag_status, diagnostics, expected in cases:
        actual = safe_next_action(classification, release_status, tag_status, diagnostics)
        if expected not in actual:
            failures.append(f"{name}: expected {expected!r} in {actual!r}")
    if failures:
        print("release-diagnostics: self-test FAIL")
        for failure in failures:
            print(f"release-diagnostics: {failure}")
        return 1
    print(f"release-diagnostics: self-test PASS ({len(cases)} cases)")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Print read-only AppTheory release-state diagnostics.")
    parser.add_argument("--tag", help="release tag to diagnose; defaults to TAG_NAME/GITHUB_REF/read-version")
    parser.add_argument("--self-test", action="store_true", help="run deterministic diagnostics self-tests")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    print_diagnostics(infer_tag(args.tag))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
PY
