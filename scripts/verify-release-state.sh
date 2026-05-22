#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 - "$@" <<'PY'
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SEMVER_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")
REQUIRED_BRANCHES = ("main", "staging", "premain")
STABLE_MANIFEST = ".release-please-manifest.json"
PREMAIN_MANIFEST = ".release-please-manifest.premain.json"


@dataclass(frozen=True)
class Version:
    raw: str
    base: tuple[int, int, int]
    prerelease: str | None

    @property
    def is_prerelease(self) -> bool:
        return self.prerelease is not None

    @property
    def is_rc(self) -> bool:
        return self.prerelease is not None and self.prerelease.split(".", 1)[0] == "rc"


@dataclass
class Result:
    valid: bool
    classification: str
    diagnostics: list[dict[str, str]]
    active_tag: str | None


def parse_version(raw: Any) -> Version:
    if not isinstance(raw, str):
        raise ValueError(f"version must be a string, got {type(raw).__name__}")
    match = SEMVER_RE.match(raw.strip())
    if not match:
        raise ValueError(f"invalid semver version {raw!r}")
    return Version(
        raw=raw.strip().removeprefix("v"),
        base=(int(match.group(1)), int(match.group(2)), int(match.group(3))),
        prerelease=match.group(4),
    )


def parse_tag(tag: str) -> Version:
    if not tag.startswith("v"):
        raise ValueError(f"release tag {tag!r} must start with 'v'")
    return parse_version(tag)


def version_tag(version: str) -> str:
    return "v" + version.removeprefix("v")


def diag(diagnostics: list[dict[str, str]], code: str, message: str) -> None:
    diagnostics.append({"code": code, "message": message})


def manifest_value(manifest: Any, key: str) -> str | None:
    if not isinstance(manifest, dict):
        return None
    value = manifest.get(key)
    if isinstance(value, str):
        return value
    # Allow fixtures/live snapshots to keep the raw Release Please manifest shape.
    file_key = STABLE_MANIFEST if key == "stable" else PREMAIN_MANIFEST
    nested = manifest.get(file_key)
    if isinstance(nested, dict) and isinstance(nested.get("."), str):
        return nested["."]
    if isinstance(manifest.get("."), str):
        return manifest["."]
    return None


def release_state(release: Any) -> str:
    if not isinstance(release, dict):
        return "absent"
    if "state" in release:
        return str(release["state"]).lower()
    if release.get("isDraft") is True:
        return "draft"
    if release.get("isDraft") is False:
        return "published"
    return "absent"


def release_target(release: Any) -> str | None:
    if not isinstance(release, dict):
        return None
    for key in ("target", "targetCommitish", "target_commitish"):
        value = release.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def tag_target(tag_info: Any) -> str | None:
    if not isinstance(tag_info, dict):
        return None
    for key in ("target", "commit", "sha"):
        value = tag_info.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def resolve_ref(state: dict[str, Any], ref: str | None) -> str | None:
    if not ref:
        return None
    branches = state.get("branches", {})
    if isinstance(branches, dict) and isinstance(branches.get(ref), dict):
        head = branches[ref].get("head")
        if isinstance(head, str) and head:
            return head
    tags = state.get("tags", {})
    if isinstance(tags, dict) and isinstance(tags.get(ref), dict):
        target = tag_target(tags[ref])
        if target:
            return resolve_ref(state, target) or target
    return ref


def relation_pairs(state: dict[str, Any]) -> set[tuple[str, str]]:
    pairs: set[tuple[str, str]] = set()
    for key in ("relations", "ancestor_relations", "ancestry"):
        values = state.get(key, [])
        if not isinstance(values, list):
            continue
        for item in values:
            if not isinstance(item, dict):
                continue
            ancestor = item.get("ancestor")
            descendant = item.get("descendant")
            if isinstance(ancestor, str) and isinstance(descendant, str):
                pairs.add((ancestor, descendant))
    return pairs


def is_ancestor(state: dict[str, Any], ancestor_ref: str | None, descendant_ref: str | None) -> bool:
    ancestor = resolve_ref(state, ancestor_ref)
    descendant = resolve_ref(state, descendant_ref)
    if not ancestor or not descendant:
        return False
    if ancestor == descendant:
        return True

    pairs = relation_pairs(state)
    if (ancestor, descendant) in pairs:
        return True

    branches = state.get("branches", {})
    if isinstance(branches, dict):
        for branch_info in branches.values():
            if not isinstance(branch_info, dict):
                continue
            if branch_info.get("head") != descendant:
                continue
            ancestors = branch_info.get("ancestors", [])
            if isinstance(ancestors, list) and ancestor in ancestors:
                return True
    return False


def branch_head(state: dict[str, Any], branch: str) -> str | None:
    branches = state.get("branches", {})
    if not isinstance(branches, dict):
        return None
    info = branches.get(branch)
    if not isinstance(info, dict):
        return None
    head = info.get("head")
    return head if isinstance(head, str) and head else None


def validate_branches(state: dict[str, Any], diagnostics: list[dict[str, str]]) -> None:
    for branch in REQUIRED_BRANCHES:
        if branch_head(state, branch) is None:
            diag(diagnostics, f"branch:missing-{branch}", f"missing {branch} branch head")

    main = branch_head(state, "main")
    staging = branch_head(state, "staging")
    premain = branch_head(state, "premain")
    if main and staging and not is_ancestor(state, main, staging):
        diag(
            diagnostics,
            "branch:staging-missing-main",
            "staging must contain the current main release baseline",
        )
    if main and premain and not is_ancestor(state, main, premain):
        diag(
            diagnostics,
            "branch:premain-missing-main",
            "premain must contain the current main release baseline",
        )


def validate_manifests(state: dict[str, Any], diagnostics: list[dict[str, str]]) -> dict[str, dict[str, Version]]:
    parsed: dict[str, dict[str, Version]] = {}
    manifests = state.get("manifests", {})
    if not isinstance(manifests, dict):
        diag(diagnostics, "manifest:missing", "missing manifests block")
        return parsed

    for branch in REQUIRED_BRANCHES:
        branch_manifest = manifests.get(branch)
        if not isinstance(branch_manifest, dict):
            diag(diagnostics, f"manifest:missing-{branch}", f"missing {branch} manifest state")
            continue
        parsed[branch] = {}
        for key in ("stable", "premain"):
            value = manifest_value(branch_manifest, key)
            if value is None:
                diag(diagnostics, f"manifest:missing-{branch}-{key}", f"missing {branch} {key} manifest version")
                continue
            try:
                parsed_version = parse_version(value)
            except ValueError as exc:
                diag(diagnostics, f"manifest:invalid-{branch}-{key}", str(exc))
                continue
            parsed[branch][key] = parsed_version
            if key == "stable" and parsed_version.is_prerelease:
                diag(
                    diagnostics,
                    f"manifest:{branch}-stable-is-prerelease",
                    f"{branch} stable manifest must not contain prerelease version {value}",
                )
            if key == "premain" and parsed_version.is_prerelease and not parsed_version.is_rc:
                diag(
                    diagnostics,
                    f"manifest:{branch}-premain-not-rc",
                    f"{branch} premain manifest prereleases must use the rc track ({value})",
                )

    main_stable = parsed.get("main", {}).get("stable")
    main_premain = parsed.get("main", {}).get("premain")
    if main_stable and main_premain and main_premain.raw != main_stable.raw:
        diag(
            diagnostics,
            "manifest:main-premain-not-reset",
            f"main premain manifest {main_premain.raw} must match stable manifest {main_stable.raw}",
        )

    for branch in ("staging", "premain"):
        branch_stable = parsed.get(branch, {}).get("stable")
        if main_stable and branch_stable and branch_stable.raw != main_stable.raw:
            diag(
                diagnostics,
                f"manifest:{branch}-stable-mismatch",
                f"{branch} stable manifest {branch_stable.raw} must match main {main_stable.raw}",
            )
        branch_premain = parsed.get(branch, {}).get("premain")
        if main_stable and branch_premain and branch_premain.base < main_stable.base:
            diag(
                diagnostics,
                f"manifest:{branch}-premain-behind-main",
                f"{branch} premain track {branch_premain.raw} is behind main {main_stable.raw}",
            )

    return parsed


def validate_tags_and_releases(
    state: dict[str, Any],
    manifests: dict[str, dict[str, Version]],
    diagnostics: list[dict[str, str]],
) -> tuple[str | None, str | None]:
    tags = state.get("tags", {})
    releases = state.get("releases", {})
    if not isinstance(tags, dict):
        diag(diagnostics, "tag:invalid-block", "tags must be an object")
        tags = {}
    if not isinstance(releases, dict):
        diag(diagnostics, "release:invalid-block", "releases must be an object")
        releases = {}

    for tag, info in tags.items():
        try:
            tag_version = parse_tag(tag)
        except ValueError as exc:
            diag(diagnostics, "tag:invalid-name", str(exc))
            continue
        target = tag_target(info)
        if not target:
            diag(diagnostics, "tag:missing-target", f"{tag} has no target commit")
            continue
        branch = "premain" if tag_version.is_prerelease else "main"
        if branch_head(state, branch) and not is_ancestor(state, target, branch):
            diag(
                diagnostics,
                "tag:target-not-on-branch",
                f"{tag} target {target} must be reachable from {branch}",
            )

    for tag, release in releases.items():
        state_name = release_state(release)
        if state_name not in {"absent", "draft", "published"}:
            diag(diagnostics, "release:invalid-state", f"{tag} has invalid release state {state_name!r}")
            continue
        if state_name == "absent":
            continue
        try:
            tag_version = parse_tag(tag)
        except ValueError as exc:
            diag(diagnostics, "release:invalid-tag", str(exc))
            continue
        target = release_target(release)
        if not target:
            diag(diagnostics, "release:missing-target", f"{tag} {state_name} release has no target")
            continue
        branch = "premain" if tag_version.is_prerelease else "main"
        if branch_head(state, branch) and not is_ancestor(state, target, branch):
            diag(
                diagnostics,
                "release:target-not-on-branch",
                f"{tag} release target {target} must be reachable from {branch}",
            )
        is_prerelease = release.get("prerelease") if isinstance(release, dict) else None
        if state_name == "published" and isinstance(is_prerelease, bool) and is_prerelease != tag_version.is_prerelease:
            diag(
                diagnostics,
                "release:published-prerelease-mismatch",
                f"{tag} published prerelease flag {is_prerelease} does not match tag kind",
            )
        current_tag_target = tag_target(tags.get(tag))
        if state_name == "published" and not current_tag_target:
            diag(diagnostics, "release:published-missing-tag", f"{tag} is published but has no immutable git tag")
        if current_tag_target and resolve_ref(state, current_tag_target) != resolve_ref(state, target):
            diag(
                diagnostics,
                "release:target-mismatch",
                f"{tag} release target {target} does not match tag target {current_tag_target}",
            )

    stable_tag = None
    prerelease_tag = None
    main_stable = manifests.get("main", {}).get("stable")
    if main_stable:
        stable_tag = version_tag(main_stable.raw)
        stable_state = release_state(releases.get(stable_tag))
        if stable_state == "absent":
            diag(diagnostics, "release:missing-stable", f"missing GitHub Release state for stable tag {stable_tag}")

    premain_version = manifests.get("premain", {}).get("premain")
    if premain_version and premain_version.is_prerelease:
        prerelease_tag = version_tag(premain_version.raw)
        prerelease_state = release_state(releases.get(prerelease_tag))
        if prerelease_state == "absent" and tag_target(tags.get(prerelease_tag)):
            diag(
                diagnostics,
                "release:prerelease-tag-without-release",
                f"{prerelease_tag} exists but has no GitHub Release state",
            )

    return stable_tag, prerelease_tag


def classify(
    state: dict[str, Any],
    manifests: dict[str, dict[str, Version]],
    stable_tag: str | None,
    prerelease_tag: str | None,
    diagnostics: list[dict[str, str]],
) -> Result:
    if diagnostics:
        return Result(False, "invalid", diagnostics, prerelease_tag or stable_tag)
    releases = state.get("releases", {}) if isinstance(state.get("releases", {}), dict) else {}
    if prerelease_tag:
        prerelease_state = release_state(releases.get(prerelease_tag))
        if prerelease_state in {"draft", "published"}:
            return Result(True, f"prerelease-{prerelease_state}", diagnostics, prerelease_tag)
        if tag_target(state.get("tags", {}).get(prerelease_tag)) if isinstance(state.get("tags", {}), dict) else None:
            return Result(True, "prerelease-tagged", diagnostics, prerelease_tag)
        return Result(True, "prerelease-ready", diagnostics, prerelease_tag)
    if stable_tag:
        stable_state = release_state(releases.get(stable_tag))
        if stable_state in {"draft", "published"}:
            return Result(True, f"stable-{stable_state}", diagnostics, stable_tag)
    # This is reachable for synthetic branch/manifest-only fixtures.
    active = None
    premain_version = manifests.get("premain", {}).get("premain")
    if premain_version:
        active = version_tag(premain_version.raw)
    return Result(True, "branch-manifest-ready", diagnostics, active)


def verify_state(state: dict[str, Any]) -> Result:
    diagnostics: list[dict[str, str]] = []
    validate_branches(state, diagnostics)
    manifests = validate_manifests(state, diagnostics)
    stable_tag, prerelease_tag = validate_tags_and_releases(state, manifests, diagnostics)
    return classify(state, manifests, stable_tag, prerelease_tag, diagnostics)


def run(cmd: list[str], *, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, check=check, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def git_output(args: list[str]) -> str | None:
    completed = run(["git", *args])
    if completed.returncode != 0:
        return None
    return completed.stdout.strip()


def git_ref_exists(ref: str) -> bool:
    return run(["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"]).returncode == 0


def git_commit(ref: str) -> str | None:
    return git_output(["rev-parse", f"{ref}^{{commit}}"])


def git_is_ancestor(ancestor: str, descendant: str) -> bool:
    return run(["git", "merge-base", "--is-ancestor", ancestor, descendant]).returncode == 0


def git_manifest(ref: str, path: str) -> str | None:
    text = git_output(["show", f"{ref}:{path}"])
    if text is None:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    value = data.get(".")
    return value if isinstance(value, str) else None


def resolve_live_ref(ref: str) -> str | None:
    if git_ref_exists(ref):
        return git_commit(ref)
    return None


def release_from_github(tag: str) -> dict[str, Any]:
    if run(["bash", "-lc", "command -v gh >/dev/null 2>&1"]).returncode != 0:
        return {"state": "absent"}
    completed = run(
        [
            "gh",
            "release",
            "view",
            tag,
            "--json",
            "isDraft,isPrerelease,targetCommitish,tagName,url",
        ]
    )
    if completed.returncode != 0:
        return {"state": "absent"}
    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {"state": "absent"}
    raw_target = data.get("targetCommitish")
    target = raw_target if isinstance(raw_target, str) else ""
    resolved_target = resolve_live_ref(target) if target else None
    return {
        "state": "draft" if data.get("isDraft") is True else "published",
        "target": resolved_target or target,
        "targetCommitish": target,
        "prerelease": data.get("isPrerelease"),
        "url": data.get("url"),
    }


def collect_live_state() -> dict[str, Any]:
    if run(["git", "rev-parse", "--is-inside-work-tree"]).returncode != 0:
        raise SystemExit("release-state: FAIL (not a git repository)")

    refs = {
        "main": "origin/main" if git_ref_exists("origin/main") else "main",
        "staging": "origin/staging" if git_ref_exists("origin/staging") else "staging",
        "premain": "origin/premain" if git_ref_exists("origin/premain") else "premain",
    }
    branches: dict[str, dict[str, Any]] = {}
    for branch, ref in refs.items():
        head = git_commit(ref)
        if head:
            branches[branch] = {"head": head, "ref": ref, "ancestors": []}

    relations: list[dict[str, str]] = []
    for ancestor_branch, descendant_branch in (("main", "staging"), ("main", "premain")):
        ancestor = branches.get(ancestor_branch, {}).get("head")
        descendant = branches.get(descendant_branch, {}).get("head")
        if ancestor and descendant and git_is_ancestor(ancestor, descendant):
            relations.append({"ancestor": ancestor, "descendant": descendant})

    manifests: dict[str, dict[str, str]] = {}
    for branch, ref in refs.items():
        stable = git_manifest(ref, STABLE_MANIFEST)
        premain = git_manifest(ref, PREMAIN_MANIFEST)
        manifests[branch] = {}
        if stable:
            manifests[branch]["stable"] = stable
        if premain:
            manifests[branch]["premain"] = premain

    expected_tags: set[str] = set()
    main_stable = manifests.get("main", {}).get("stable")
    if main_stable:
        expected_tags.add(version_tag(main_stable))
    premain_track = manifests.get("premain", {}).get("premain")
    if premain_track:
        try:
            if parse_version(premain_track).is_prerelease:
                expected_tags.add(version_tag(premain_track))
        except ValueError:
            pass

    tags: dict[str, dict[str, str]] = {}
    releases: dict[str, dict[str, Any]] = {}
    for tag in sorted(expected_tags):
        commit = git_commit(f"refs/tags/{tag}")
        if commit:
            tags[tag] = {"target": commit}
        releases[tag] = release_from_github(tag)
        release_target_sha = resolve_ref({"branches": branches, "tags": tags}, release_target(releases[tag]))
        for branch in ("main", "premain"):
            branch_sha = branches.get(branch, {}).get("head")
            if release_target_sha and branch_sha and git_ref_exists(release_target_sha) and git_is_ancestor(release_target_sha, branch_sha):
                relations.append({"ancestor": release_target_sha, "descendant": branch_sha})
        tag_sha = tags.get(tag, {}).get("target")
        for branch in ("main", "premain"):
            branch_sha = branches.get(branch, {}).get("head")
            if tag_sha and branch_sha and git_is_ancestor(tag_sha, branch_sha):
                relations.append({"ancestor": tag_sha, "descendant": branch_sha})

    return {
        "case": "live",
        "branches": branches,
        "relations": relations,
        "manifests": manifests,
        "tags": tags,
        "releases": releases,
    }


def print_result(result: Result, *, case: str | None = None, as_json: bool = False) -> None:
    if as_json:
        print(
            json.dumps(
                {
                    "case": case,
                    "valid": result.valid,
                    "classification": result.classification,
                    "active_tag": result.active_tag,
                    "diagnostics": result.diagnostics,
                },
                indent=2,
                sort_keys=True,
            )
        )
        return
    prefix = f"release-state[{case}]" if case else "release-state"
    status = "PASS" if result.valid else "FAIL"
    active = f", active={result.active_tag}" if result.active_tag else ""
    print(f"{prefix}: {status} ({result.classification}{active})")
    for item in result.diagnostics:
        print(f"{prefix}: {item['code']}: {item['message']}")


def load_state(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise SystemExit(f"release-state: FAIL ({path} must contain a JSON object)")
    return data


def iter_self_test_cases() -> list[Path]:
    root = Path("scripts/testdata/release-state")
    return sorted(path for path in root.rglob("*.json") if path.is_file())


def self_test(as_json: bool = False) -> int:
    paths = iter_self_test_cases()
    if not paths:
        print("release-state: FAIL (no self-test fixtures found)")
        return 1
    failures: list[str] = []
    summaries: list[dict[str, Any]] = []
    for path in paths:
        state = load_state(path)
        case = str(state.get("case") or path.stem)
        expected = state.get("expected", {})
        result = verify_state(state)
        expected_valid = expected.get("valid") if isinstance(expected, dict) else None
        expected_classification = expected.get("classification") if isinstance(expected, dict) else None
        expected_codes = expected.get("diagnostic_codes", []) if isinstance(expected, dict) else []
        actual_codes = [item["code"] for item in result.diagnostics]
        if expected_valid is not None and bool(expected_valid) != result.valid:
            failures.append(f"{case}: expected valid={expected_valid}, got {result.valid}")
        if expected_classification and expected_classification != result.classification:
            failures.append(
                f"{case}: expected classification={expected_classification}, got {result.classification}"
            )
        for code in expected_codes:
            if code not in actual_codes:
                failures.append(f"{case}: expected diagnostic code {code!r}, got {actual_codes!r}")
        summaries.append(
            {
                "case": case,
                "valid": result.valid,
                "classification": result.classification,
                "diagnostics": actual_codes,
            }
        )
    if as_json:
        print(json.dumps({"ok": not failures, "cases": summaries, "failures": failures}, indent=2, sort_keys=True))
    elif failures:
        print("release-state: self-test FAIL")
        for failure in failures:
            print(f"release-state: {failure}")
    else:
        for summary in summaries:
            status = "PASS" if summary["valid"] else "EXPECTED-FAIL"
            print(f"release-state: {status} {summary['case']} ({summary['classification']})")
        print(f"release-state: self-test PASS ({len(paths)} cases)")
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Classify AppTheory release train state without mutating GitHub state.")
    parser.add_argument("--state-file", type=Path, help="classify a fixture/state JSON file")
    parser.add_argument("--self-test", action="store_true", help="run deterministic fixture-backed verifier tests")
    parser.add_argument("--live", action="store_true", help="classify the current repository using local git refs and read-only gh calls")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = parser.parse_args(argv)

    selected = sum(1 for value in (args.state_file, args.self_test, args.live) if value)
    if selected > 1:
        parser.error("choose only one of --state-file, --self-test, or --live")

    if args.self_test:
        return self_test(args.json)

    if args.state_file:
        state = load_state(args.state_file)
    else:
        state = collect_live_state()
    result = verify_state(state)
    print_result(result, case=str(state.get("case")) if state.get("case") else None, as_json=args.json)
    return 0 if result.valid else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
PY
