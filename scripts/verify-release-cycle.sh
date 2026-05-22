#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 - "$@" <<'PY'
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REQUIRED_COVERAGE = {
    "happy_path": "happy path",
    "publish_recovery_race": "publish/recovery race",
    "stale_release_please_pr": "stale Release Please PR state",
    "promotion_drift": "promotion drift",
    "back_merge_drift": "back-merge drift",
}

VALID_RELEASE_EDGES = {
    ("staging", "premain"),
    ("premain", "main"),
    ("main", "staging"),
}

HAPPY_PATH_EDGES = [
    ("staging", "premain"),
    ("premain", "main"),
    ("main", "staging"),
]


@dataclass(frozen=True)
class Diagnostic:
    code: str
    message: str


def as_bool(value: Any) -> bool:
    return value is True


def add(diags: list[Diagnostic], code: str, message: str) -> None:
    diags.append(Diagnostic(code, message))


def run_release_state(case: str, name: str, state: dict[str, Any]) -> tuple[bool, list[Diagnostic], str]:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as handle:
        path = Path(handle.name)
        json.dump(state, handle, indent=2, sort_keys=True)
        handle.write("\n")

    try:
        completed = subprocess.run(
            ["bash", "scripts/verify-release-state.sh", "--state-file", str(path), "--json"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    finally:
        path.unlink(missing_ok=True)

    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return (
            False,
            [
                Diagnostic(
                    "release-state:unavailable",
                    f"{case}/{name}: verify-release-state did not return JSON: "
                    f"{(completed.stderr or completed.stdout).strip()}",
                )
            ],
            "unavailable",
        )

    diagnostics = []
    for item in payload.get("diagnostics", []):
        if not isinstance(item, dict):
            continue
        code = item.get("code")
        message = item.get("message")
        if isinstance(code, str) and isinstance(message, str):
            diagnostics.append(Diagnostic(code, f"{case}/{name}: {message}"))

    valid = completed.returncode == 0 and payload.get("valid") is True
    classification = payload.get("classification") if isinstance(payload.get("classification"), str) else "unknown"
    return valid, diagnostics, classification


def validate_state_snapshots(fixture: dict[str, Any], diags: list[Diagnostic]) -> None:
    case = str(fixture.get("case") or "unnamed")
    states = fixture.get("states", [])
    if states is None:
        return
    if not isinstance(states, list):
        add(diags, "fixture:states-invalid", f"{case}: states must be an array")
        return

    for index, entry in enumerate(states):
        if not isinstance(entry, dict):
            add(diags, "fixture:state-invalid", f"{case}: state entry {index} must be an object")
            continue
        name = str(entry.get("name") or f"state-{index}")
        state = entry.get("state")
        if not isinstance(state, dict):
            add(diags, "fixture:state-invalid", f"{case}/{name}: state must be an object")
            continue
        expected_classification = entry.get("classification")
        valid, state_diags, classification = run_release_state(case, name, state)
        if not valid:
            diags.extend(state_diags)
        if isinstance(expected_classification, str) and expected_classification != classification:
            add(
                diags,
                "release-state:classification-drift",
                f"{case}/{name}: expected {expected_classification}, got {classification}",
            )


def validate_integration(event: dict[str, Any], diags: list[Diagnostic]) -> None:
    target = event.get("to")
    if target != "staging":
        add(diags, "integration:invalid-target", "ordinary work may only integrate into staging")
    if not as_bool(event.get("containsCurrentMain")):
        add(diags, "integration:staging-missing-main", "staging integration must contain the current main baseline")


def validate_promotion(event: dict[str, Any], diags: list[Diagnostic]) -> None:
    source = event.get("from")
    target = event.get("to")
    edge = (source, target)
    if edge not in VALID_RELEASE_EDGES:
        add(diags, "promotion:invalid-edge", f"invalid release-train edge {source!r} -> {target!r}")
    if event.get("ancestorPresent") is False:
        add(diags, "promotion:ancestor-drift", f"{source!r} does not contain the required {target!r} baseline")


def validate_release_pr(event: dict[str, Any], diags: list[Diagnostic]) -> None:
    target = event.get("target")
    expected_branch = f"release-please--branches--{target}"
    if target not in {"premain", "main"}:
        add(diags, "release-pr:invalid-target", f"release-please PR target must be premain or main, got {target!r}")
    if event.get("head") != expected_branch:
        add(diags, "release-pr:wrong-head", f"release-please PR head must be {expected_branch}")
    if event.get("state") != "open":
        add(diags, "release-pr:stale-state", "stale closed or merged Release Please PR state must not remain mergeable")
    if event.get("draft") is not True:
        add(diags, "release-pr:not-draft", "Release Please PR must stay draft-locked until generated artifacts and checks are current")
    if event.get("baseCurrent") is not True:
        add(diags, "release-pr:stale-baseline", "Release Please PR base must match the current release branch baseline")
    if event.get("generatedArtifactsSynced") is not True:
        add(diags, "release-pr:generated-artifacts-not-synced", "generated release artifacts must be synchronized before readiness")
    if target == "main" and event.get("premainManifestReset") is not True:
        add(diags, "release-pr:premain-manifest-not-reset", "stable release PR must reset premain Release Please state")
    if event.get("ready") is True and event.get("checksPassed") is not True:
        add(diags, "release-pr:ready-before-checks", "release PR cannot become ready before required checks pass")


def validate_publisher(event: dict[str, Any], diags: list[Diagnostic]) -> None:
    tag = event.get("tag")
    source = event.get("source")
    if source == "premain":
        if not isinstance(tag, str) or "-rc" not in tag:
            add(diags, "publisher:wrong-prerelease-tag", "premain publisher must use an rc tag")
    elif source == "main":
        if not isinstance(tag, str) or "-rc" in tag:
            add(diags, "publisher:wrong-stable-tag", "main publisher must use a stable tag")
    else:
        add(diags, "publisher:invalid-source", f"publisher source must be premain or main, got {source!r}")

    if event.get("serialized") is not True:
        add(diags, "publisher:not-serialized", "release publishers must share the non-cancelling release-publisher queue")
    if event.get("assetsVerified") is not True:
        add(diags, "publisher:assets-not-verified", "release publisher must verify source-built assets before publication or skip")


def validate_publisher_race(event: dict[str, Any], diags: list[Diagnostic]) -> None:
    if event.get("publishedDuringRun") is not True:
        add(diags, "publisher:race-not-modeled", "publish/recovery race fixture must model publication during the rerun")
        return
    if event.get("recheckedPublishedAssets") is not True:
        add(diags, "publisher:published-race-unverified", "published release race must re-check immutable assets")
    if event.get("publishedAssetsMatchSource") is not True:
        add(diags, "publisher:published-assets-mismatch", "published release race must fail closed on asset mismatch")
    if event.get("attemptedDraftUploadAfterPublished") is True:
        add(diags, "publisher:draft-upload-after-published", "rerun must not clobber assets after the release becomes published")


def validate_back_merge(event: dict[str, Any], diags: list[Diagnostic]) -> None:
    if (event.get("from"), event.get("to")) != ("main", "staging"):
        add(diags, "back-merge:invalid-edge", "stable back-merge must be main -> staging")
    if event.get("beforeFurtherStagingWork") is not True:
        add(diags, "back-merge:late", "main must be back-merged to staging before further staging work")


def validate_happy_path(events: list[dict[str, Any]], diags: list[Diagnostic]) -> None:
    edges: list[tuple[Any, Any]] = []
    release_pr_targets: list[Any] = []
    publisher_sources: list[Any] = []
    for event in events:
        kind = event.get("kind")
        if kind in {"promotion", "back_merge"}:
            edges.append((event.get("from"), event.get("to")))
        if kind == "release_please_pr":
            release_pr_targets.append(event.get("target"))
        if kind == "publisher":
            publisher_sources.append(event.get("source"))

    if edges != HAPPY_PATH_EDGES:
        add(diags, "cycle:happy-path-order", f"expected release edges {HAPPY_PATH_EDGES}, got {edges}")
    if release_pr_targets != ["premain", "main"]:
        add(diags, "cycle:release-pr-order", f"expected prerelease then stable Release Please PRs, got {release_pr_targets}")
    if publisher_sources != ["premain", "main"]:
        add(diags, "cycle:publisher-order", f"expected prerelease then stable publishers, got {publisher_sources}")


def validate_events(fixture: dict[str, Any], diags: list[Diagnostic]) -> None:
    events = fixture.get("events", [])
    if not isinstance(events, list):
        add(diags, "fixture:events-invalid", "events must be an array")
        return

    for event in events:
        if not isinstance(event, dict):
            add(diags, "fixture:event-invalid", "event entries must be objects")
            continue
        kind = event.get("kind")
        if kind == "integration":
            validate_integration(event, diags)
        elif kind == "promotion":
            validate_promotion(event, diags)
        elif kind == "release_please_pr":
            validate_release_pr(event, diags)
        elif kind == "publisher":
            validate_publisher(event, diags)
        elif kind == "publisher_race":
            validate_publisher_race(event, diags)
        elif kind == "back_merge":
            validate_back_merge(event, diags)
        else:
            add(diags, "fixture:unknown-event", f"unknown event kind {kind!r}")

    coverage = fixture.get("coverage", [])
    if isinstance(coverage, list) and "happy_path" in coverage:
        validate_happy_path([event for event in events if isinstance(event, dict)], diags)


def validate_fixture(path: Path) -> tuple[bool, list[Diagnostic], list[str], dict[str, Any]]:
    try:
        fixture = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return False, [Diagnostic("fixture:invalid-json", f"{path}: {exc}")], [], {}
    if not isinstance(fixture, dict):
        return False, [Diagnostic("fixture:invalid-shape", f"{path}: fixture must be an object")], [], {}

    diags: list[Diagnostic] = []
    validate_state_snapshots(fixture, diags)
    validate_events(fixture, diags)

    coverage_raw = fixture.get("coverage", [])
    coverage = [item for item in coverage_raw if isinstance(item, str)] if isinstance(coverage_raw, list) else []
    return not diags, diags, coverage, fixture


def iter_fixtures(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*.json") if path.is_file())


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Verify the deterministic AppTheory full release cycle simulator.")
    parser.add_argument("--fixture", type=Path, help="run a single release-cycle fixture")
    parser.add_argument("--self-test", action="store_true", help="run all release-cycle fixtures")
    args = parser.parse_args(argv)

    fixture_root = Path("scripts/testdata/release-cycle")
    paths = [args.fixture] if args.fixture else iter_fixtures(fixture_root)
    if not paths:
        print("release-cycle: FAIL (no release-cycle fixtures found)")
        return 1

    failures: list[str] = []
    coverage_seen: set[str] = set()

    for path in paths:
        valid, diagnostics, coverage, fixture = validate_fixture(path)
        coverage_seen.update(coverage)
        case = str(fixture.get("case") or path.stem) if fixture else path.stem
        expected = fixture.get("expected", {}) if isinstance(fixture, dict) else {}
        expected_valid = expected.get("valid") if isinstance(expected, dict) else None
        expected_codes = expected.get("diagnostic_codes", []) if isinstance(expected, dict) else []
        if not isinstance(expected_codes, list):
            expected_codes = []
        actual_codes = [diag.code for diag in diagnostics]

        if isinstance(expected_valid, bool) and valid != expected_valid:
            failures.append(f"{case}: expected valid={expected_valid}, got {valid}; diagnostics={actual_codes}")
        for code in expected_codes:
            if code not in actual_codes:
                failures.append(f"{case}: expected diagnostic {code!r}, got {actual_codes!r}")
        unexpected = [code for code in actual_codes if code not in expected_codes]
        if expected_valid is False and unexpected:
            failures.append(f"{case}: unexpected diagnostics {unexpected!r}; expected {expected_codes!r}")
        if expected_valid is True and actual_codes:
            failures.append(f"{case}: valid fixture emitted diagnostics {actual_codes!r}")

        if valid:
            print(f"release-cycle: PASS {case} ({', '.join(coverage) or 'uncategorized'})")
        else:
            print(f"release-cycle: EXPECTED-FAIL {case} ({', '.join(actual_codes)})")

    missing = sorted(set(REQUIRED_COVERAGE) - coverage_seen)
    if missing:
        failures.append(
            "missing required coverage: "
            + ", ".join(f"{key} ({REQUIRED_COVERAGE[key]})" for key in missing)
        )

    if failures:
        print("release-cycle: self-test FAIL")
        for failure in failures:
            print(f"release-cycle: {failure}")
        return 1

    coverage_list = ", ".join(f"{key}={REQUIRED_COVERAGE[key]}" for key in sorted(REQUIRED_COVERAGE))
    print(f"release-cycle: self-test PASS ({len(paths)} cases; coverage: {coverage_list})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
PY
