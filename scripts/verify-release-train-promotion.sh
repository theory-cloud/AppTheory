#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 - "$@" <<'PY'
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

RELEASE_BRANCHES = {"staging", "premain", "main"}
VALID_PROMOTIONS = {
    ("staging", "premain"): "staging → premain prerelease promotion",
    ("premain", "main"): "premain → main stable promotion",
    ("main", "staging"): "main → staging stable back-merge",
}


@dataclass(frozen=True)
class PromotionPlan:
    valid: bool
    message: str
    ancestor_branch: str | None = None
    descendant_branch: str | None = None
    non_release_pr: bool = False


def run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, check=check, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def fail(message: str) -> None:
    print(f"release-train-promotion: FAIL ({message})")
    raise SystemExit(1)


def ref_exists(ref: str) -> bool:
    return run(["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"], check=False).returncode == 0


def fetch_branch(remote: str, branch: str) -> None:
    result = run(
        ["git", "fetch", "--no-tags", remote, f"+refs/heads/{branch}:refs/remotes/{remote}/{branch}"],
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        fail(f"could not fetch {remote}/{branch}; {detail or 'git fetch failed'}")


def commit_sha(ref: str) -> str:
    result = run(["git", "rev-parse", "--verify", f"{ref}^{{commit}}"], check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        fail(f"could not resolve commit for {ref!r}; {detail or 'git rev-parse failed'}")
    return result.stdout.strip()


def trusted_release_ref(remote: str, branch: str) -> str:
    remote_ref = f"refs/remotes/{remote}/{branch}"
    fetch_branch(remote, branch)
    if ref_exists(remote_ref):
        return remote_ref
    fail(f"could not resolve trusted {remote}/{branch} after fetch")
    raise AssertionError("unreachable")


def resolve_branch_ref(remote: str, branch: str, explicit_ref: str | None = None) -> str:
    if branch in RELEASE_BRANCHES:
        release_ref = trusted_release_ref(remote, branch)
        if explicit_ref:
            if not ref_exists(explicit_ref):
                fail(f"could not resolve explicit ref {explicit_ref!r} for {branch}")
            explicit_sha = commit_sha(explicit_ref)
            trusted_sha = commit_sha(release_ref)
            if explicit_sha != trusted_sha:
                fail(
                    f"explicit ref {explicit_ref!r} for protected release branch {branch} "
                    f"does not match trusted {remote}/{branch}; "
                    "release-train PRs must use the protected branch head content"
                )
            return explicit_ref
        return release_ref

    if explicit_ref:
        if not ref_exists(explicit_ref):
            fail(f"could not resolve explicit ref {explicit_ref!r} for {branch}")
        return explicit_ref

    remote_ref = f"refs/remotes/{remote}/{branch}"
    if not ref_exists(remote_ref):
        fetch_branch(remote, branch)
    if ref_exists(remote_ref):
        return remote_ref

    if branch == os.environ.get("GITHUB_HEAD_REF") and ref_exists("HEAD"):
        return "HEAD"

    fail(f"could not resolve {remote}/{branch}; use fetch-depth: 0 and fetch release train branches")
    raise AssertionError("unreachable")


def is_ancestor(ancestor_ref: str, descendant_ref: str) -> bool:
    return run(["git", "merge-base", "--is-ancestor", ancestor_ref, descendant_ref], check=False).returncode == 0


def expected_base_for_release_head(head: str) -> str:
    if head == "staging":
        return "premain"
    if head == "premain":
        return "main"
    if head == "main":
        return "staging"
    raise ValueError(f"{head!r} is not a release branch")


def classify(base: str, head: str) -> PromotionPlan:
    if base == "premain":
        if head != "staging":
            return PromotionPlan(
                False,
                "invalid release-train PR "
                f"{head} → premain; premain only accepts staging → premain prerelease promotions",
            )
        return PromotionPlan(True, VALID_PROMOTIONS[(head, base)], ancestor_branch="premain", descendant_branch=head)

    if base == "main":
        if head != "premain":
            return PromotionPlan(
                False,
                "invalid release-train PR "
                f"{head} → main; main only accepts premain → main stable promotions",
            )
        return PromotionPlan(True, VALID_PROMOTIONS[(head, base)], ancestor_branch="main", descendant_branch=head)

    if base == "staging":
        if head in RELEASE_BRANCHES:
            if head != "main":
                return PromotionPlan(
                    False,
                    "invalid release-train PR "
                    f"{head} → staging; staging only accepts main → staging release back-merges from release branches",
                )
            return PromotionPlan(True, VALID_PROMOTIONS[(head, base)], ancestor_branch="staging", descendant_branch=head)

        return PromotionPlan(
            True,
            "ordinary staging PR with current main baseline",
            ancestor_branch="main",
            descendant_branch=head,
        )

    if head in RELEASE_BRANCHES:
        expected_base = expected_base_for_release_head(head)
        return PromotionPlan(
            False,
            "invalid release-train PR "
            f"{head} → {base}; {head} may only promote to {expected_base}",
        )

    return PromotionPlan(True, "non-release-train PR", non_release_pr=True)


def validate(base: str, head: str, remote: str, base_ref: str | None, head_ref: str | None) -> None:
    plan = classify(base, head)
    if not plan.valid:
        fail(plan.message)

    if plan.non_release_pr:
        print(f"release-train-promotion: PASS ({plan.message}; {head} → {base})")
        return

    if plan.ancestor_branch is None and plan.descendant_branch is None:
        if base_ref:
            resolve_branch_ref(remote, base, base_ref)
        if head_ref:
            resolve_branch_ref(remote, head, head_ref)
        print(f"release-train-promotion: PASS ({plan.message}; {head} → {base})")
        return

    assert plan.ancestor_branch is not None
    assert plan.descendant_branch is not None

    ancestor_ref = resolve_branch_ref(
        remote,
        plan.ancestor_branch,
        base_ref if plan.ancestor_branch == base else None,
    )
    descendant_ref = resolve_branch_ref(
        remote,
        plan.descendant_branch,
        head_ref if plan.descendant_branch == head else None,
    )

    if not is_ancestor(ancestor_ref, descendant_ref):
        if base == "staging" and head not in RELEASE_BRANCHES:
            fail(
                "staging PR branch does not contain the current main baseline; "
                "merge origin/main into the PR branch before targeting staging"
            )
        fail(
            f"{plan.ancestor_branch} is not an ancestor of {plan.descendant_branch}; "
            "recreate the release-train PR from the current branch heads and do not merge around "
            "staging → premain → main → staging"
        )

    print(f"release-train-promotion: PASS ({plan.message}; {head} → {base})")


def assert_plan(base: str, head: str, valid: bool, ancestor: str | None, descendant: str | None) -> None:
    plan = classify(base, head)
    if plan.valid != valid:
        raise AssertionError(f"{head} → {base}: expected valid={valid}, got {plan.valid} ({plan.message})")
    if plan.ancestor_branch != ancestor or plan.descendant_branch != descendant:
        raise AssertionError(
            f"{head} → {base}: expected ancestry {ancestor}->{descendant}, "
            f"got {plan.ancestor_branch}->{plan.descendant_branch}"
        )


@contextlib.contextmanager
def pushd(path: str):
    previous = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def commit_marker(label: str) -> None:
    marker = Path("release-train-self-test.txt")
    marker.write_text(f"{label}\n", encoding="utf-8")
    run(["git", "add", str(marker)])
    run(["git", "commit", "-q", "-m", label])


def build_release_train_self_test_repo() -> None:
    run(["git", "init", "-q", "--initial-branch=main"])
    run(["git", "config", "user.email", "apptheory-release-train@example.invalid"])
    run(["git", "config", "user.name", "AppTheory Release Train Self Test"])

    commit_marker("main-1")

    run(["git", "switch", "-q", "-c", "feature/without-main"])
    commit_marker("feature-without-current-main")

    run(["git", "switch", "-q", "main"])
    commit_marker("main-2")

    run(["git", "switch", "-q", "main"])
    run(["git", "switch", "-q", "-c", "premain"])
    commit_marker("premain")

    run(["git", "switch", "-q", "-c", "staging"])
    commit_marker("staging")

    run(["git", "switch", "-q", "premain"])
    run(["git", "switch", "-q", "-c", "forged-staging"])
    commit_marker("forged-staging")
    run(["git", "update-ref", "refs/remotes/origin/pr/1/head", "forged-staging"])

    run(["git", "switch", "-q", "main"])
    run(["git", "switch", "-q", "-c", "feature/with-main"])
    commit_marker("feature-with-current-main")

    remote_path = Path("origin.git").resolve()
    run(["git", "init", "-q", "--bare", str(remote_path)])
    run(["git", "remote", "add", "origin", str(remote_path)])
    run(["git", "push", "-q", "origin", "main", "staging", "premain", "feature/without-main", "feature/with-main"])


def validate_exit(
    base: str,
    head: str,
    *,
    base_ref: str | None = None,
    head_ref: str | None = None,
) -> tuple[int, str]:
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        try:
            validate(base, head, "origin", base_ref, head_ref)
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else 1
            return code, output.getvalue()
    return 0, output.getvalue()


def assert_validation(
    base: str,
    head: str,
    expected_exit: int,
    *,
    base_ref: str | None = None,
    head_ref: str | None = None,
    contains: str | None = None,
) -> None:
    code, output = validate_exit(base, head, base_ref=base_ref, head_ref=head_ref)
    if code != expected_exit:
        raise AssertionError(
            f"{head} → {base}: expected exit {expected_exit}, got {code}; output:\n{output}"
        )
    if contains is not None and contains not in output:
        raise AssertionError(
            f"{head} → {base}: expected output containing {contains!r}; output:\n{output}"
        )


def self_test_git_topology() -> None:
    with tempfile.TemporaryDirectory(prefix="apptheory-release-train-") as tmp:
        with pushd(tmp):
            build_release_train_self_test_repo()
            if not is_ancestor("premain", "staging"):
                raise AssertionError("self-test topology must keep premain as an ancestor of staging")

            assert_validation(
                "premain",
                "staging",
                0,
                base_ref="premain",
                head_ref="staging",
                contains="staging → premain prerelease promotion",
            )
            print("release-train-promotion: positive staging → premain topology accepted")
            assert_validation(
                "premain",
                "staging",
                1,
                base_ref="premain",
                head_ref="refs/remotes/origin/pr/1/head",
                contains="does not match trusted origin/staging",
            )
            print("release-train-promotion: negative forged staging head rejected")
            assert_validation(
                "main",
                "premain",
                0,
                base_ref="main",
                head_ref="premain",
                contains="premain → main stable promotion",
            )
            assert_validation(
                "staging",
                "feature/with-main",
                0,
                base_ref="staging",
                head_ref="feature/with-main",
                contains="ordinary staging PR with current main baseline",
            )
            assert_validation(
                "staging",
                "feature/without-main",
                1,
                base_ref="staging",
                head_ref="feature/without-main",
                contains="current main baseline",
            )


def self_test() -> None:
    assert_plan("premain", "staging", True, "premain", "staging")
    assert_plan("main", "premain", True, "main", "premain")
    assert_plan("staging", "main", True, "staging", "main")
    assert_plan("staging", "feature/release-fix", True, "main", "feature/release-fix")
    assert_plan("main", "staging", False, None, None)
    assert_plan("premain", "main", False, None, None)
    assert_plan("premain", "feature/release-fix", False, None, None)
    assert_plan("project/apptheory-release-process-reliability", "main", False, None, None)
    assert_plan("project/apptheory-release-process-reliability", "milestone/release-hardening", True, None, None)

    self_test_git_topology()

    print("release-train-promotion: self-test PASS")


def event_value(name: str) -> str:
    path = os.environ.get("GITHUB_EVENT_PATH")
    if not path:
        return ""
    try:
        with open(path, encoding="utf-8") as handle:
            event = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return ""
    pr = event.get("pull_request")
    if not isinstance(pr, dict):
        return ""
    ref = pr.get(name, {}).get("ref") if isinstance(pr.get(name), dict) else ""
    return ref if isinstance(ref, str) else ""


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Verify AppTheory release train promotion PRs")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--base", default=os.environ.get("GITHUB_BASE_REF") or event_value("base"))
    parser.add_argument("--head", default=os.environ.get("GITHUB_HEAD_REF") or event_value("head"))
    parser.add_argument("--remote", default="origin")
    parser.add_argument("--base-ref", default=None)
    parser.add_argument("--head-ref", default=None)
    args = parser.parse_args(argv)

    if args.self_test:
        self_test()
        return 0

    if not args.base or not args.head:
        fail("base and head branches are required; pass --base/--head or run on a pull_request event")

    validate(args.base, args.head, args.remote, args.base_ref, args.head_ref)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
PY
