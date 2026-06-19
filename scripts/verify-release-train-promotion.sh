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
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

RELEASE_BRANCHES = {"staging", "premain", "main"}
PREMAIN_RELEASE_PLEASE_BRANCH = "release-please--branches--premain"
MAIN_RELEASE_PLEASE_BRANCH = "release-please--branches--main"
RELEASE_PLEASE_BRANCHES = {PREMAIN_RELEASE_PLEASE_BRANCH, MAIN_RELEASE_PLEASE_BRANCH}
RC_VERSION_RE = re.compile(r"\bv?[0-9]+\.[0-9]+\.[0-9]+-rc(?:\.[0-9]+)?\b", re.IGNORECASE)
VALID_PROMOTIONS = {
    ("staging", "premain"): "staging → premain prerelease promotion",
    ("premain", "main"): "premain → main stable promotion",
    ("main", "staging"): "main → staging stable back-merge",
    (PREMAIN_RELEASE_PLEASE_BRANCH, "premain"): "generated premain RC release-please PR",
    (MAIN_RELEASE_PLEASE_BRANCH, "main"): "generated main stable release-please PR",
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


def normalize_sha(value: str, label: str) -> str:
    candidate = value.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{40}", candidate):
        fail(f"{label} must be a 40-character git commit SHA")
    return candidate


def normalize_repository(repository: str) -> str:
    parts = repository.split("/")
    if len(parts) != 2 or not all(re.fullmatch(r"[A-Za-z0-9_.-]+", part) for part in parts):
        fail(f"GitHub repository must be in owner/name form, got {repository!r}")
    return repository


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


def github_api_json(repository: str, path: str) -> dict[str, object]:
    repository = normalize_repository(repository)
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        fail("GITHUB_TOKEN or GH_TOKEN is required to verify PR head ancestry without fetching it")

    owner, repo = repository.split("/", 1)
    api_base = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
    url = (
        f"{api_base}/repos/"
        f"{urllib.parse.quote(owner, safe='')}/"
        f"{urllib.parse.quote(repo, safe='')}/"
        f"{path}"
    )
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "apptheory-release-train-verifier",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read(512).decode("utf-8", errors="replace").strip()
        fail(f"GitHub API request failed with HTTP {exc.code}: {detail or exc.reason}")
    except urllib.error.URLError as exc:
        fail(f"GitHub API request failed: {exc.reason}")

    if not isinstance(payload, dict):
        fail("GitHub API returned an invalid response")
    return payload


def compare_response_is_ancestor(payload: dict[str, object], ancestor_sha: str) -> bool:
    ancestor_sha = normalize_sha(ancestor_sha, "ancestor SHA")
    status = payload.get("status")
    if status not in {"ahead", "identical"}:
        return False

    base_commit = payload.get("base_commit")
    merge_base_commit = payload.get("merge_base_commit")
    if not isinstance(base_commit, dict) or not isinstance(merge_base_commit, dict):
        return False

    base_sha = base_commit.get("sha")
    merge_base_sha = merge_base_commit.get("sha")
    if not isinstance(base_sha, str) or not isinstance(merge_base_sha, str):
        return False

    return base_sha.lower() == ancestor_sha and merge_base_sha.lower() == ancestor_sha


def github_compare_is_ancestor(repository: str, ancestor_sha: str, descendant_sha: str) -> bool:
    ancestor_sha = normalize_sha(ancestor_sha, "ancestor SHA")
    descendant_sha = normalize_sha(descendant_sha, "head SHA")
    payload = github_api_json(repository, f"compare/{ancestor_sha}...{descendant_sha}")
    return compare_response_is_ancestor(payload, ancestor_sha)


def trusted_release_please_head_ref(
    head: str,
    remote: str,
    head_ref: str | None,
    expected_head_sha: str | None,
    github_repository: str | None,
    github_head_repository: str | None,
) -> str:
    if head not in RELEASE_PLEASE_BRANCHES:
        raise AssertionError(f"{head!r} is not a release-please branch")
    if not github_repository:
        fail("GitHub repository is required to verify generated release-please branch provenance")
    if not github_head_repository:
        fail("GitHub head repository is required to verify generated release-please branch provenance")
    if expected_head_sha is None:
        fail(f"event head SHA is required to verify generated release-please branch {head}")

    repository = normalize_repository(github_repository)
    head_repository = normalize_repository(github_head_repository)
    if repository.lower() != head_repository.lower():
        fail(
            f"generated release-please PR head {head} must originate from trusted repository "
            f"{repository}; got {head_repository}"
        )

    trusted_ref = trusted_release_ref(remote, head)
    trusted_sha = commit_sha(trusted_ref).lower()
    if expected_head_sha != trusted_sha:
        fail(
            f"event head SHA for generated release-please branch {head} "
            f"does not match trusted {remote}/{head}"
        )

    if head_ref is not None:
        if not ref_exists(head_ref):
            fail(f"could not resolve explicit ref {head_ref!r} for generated release-please branch {head}")
        explicit_sha = commit_sha(head_ref).lower()
        if explicit_sha != trusted_sha:
            fail(
                f"explicit ref {head_ref!r} for generated release-please branch {head} "
                f"does not match trusted {remote}/{head}"
            )

    return trusted_ref


def expected_base_for_release_head(head: str) -> str:
    if head == "staging":
        return "premain"
    if head == "premain":
        return "main"
    if head == "main":
        return "staging"
    raise ValueError(f"{head!r} is not a release branch")


def has_rc_version(value: str | None) -> bool:
    return bool(value and RC_VERSION_RE.search(value))


def classify(base: str, head: str) -> PromotionPlan:
    if base == "premain":
        if head == PREMAIN_RELEASE_PLEASE_BRANCH:
            return PromotionPlan(True, VALID_PROMOTIONS[(head, base)], ancestor_branch="premain", descendant_branch=head)
        if head != "staging":
            return PromotionPlan(
                False,
                "invalid release-train PR "
                f"{head} → premain; premain only accepts staging → premain prerelease promotions "
                f"or {PREMAIN_RELEASE_PLEASE_BRANCH} → premain RC release PRs",
            )
        return PromotionPlan(True, VALID_PROMOTIONS[(head, base)], ancestor_branch="premain", descendant_branch=head)

    if base == "main":
        if head == MAIN_RELEASE_PLEASE_BRANCH:
            return PromotionPlan(True, VALID_PROMOTIONS[(head, base)], ancestor_branch="main", descendant_branch=head)
        if head != "premain":
            return PromotionPlan(
                False,
                "invalid release-train PR "
                f"{head} → main; main only accepts premain → main stable promotions "
                f"or {MAIN_RELEASE_PLEASE_BRANCH} → main stable release PRs",
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
            # A stable back-merge is allowed to reconcile a current staging head
            # that has moved ahead of main after the stable release was cut. The
            # protected invariant is that main remains connected to the premain
            # train line; requiring the transient staging tip itself to be an
            # ancestor of main falsely rejects legitimate back-merges while not
            # adding protection against merge-around-the-train paths.
            return PromotionPlan(True, VALID_PROMOTIONS[(head, base)], ancestor_branch="premain", descendant_branch=head)

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


def validate(
    base: str,
    head: str,
    remote: str,
    base_ref: str | None,
    head_ref: str | None,
    head_sha: str | None,
    github_repository: str | None,
    github_head_repository: str | None,
    pr_title: str | None,
) -> None:
    plan = classify(base, head)
    if not plan.valid:
        fail(plan.message)

    if base == "main" and has_rc_version(pr_title):
        fail("main release gate rejects RC-shaped PR titles/versions")

    if head == PREMAIN_RELEASE_PLEASE_BRANCH and pr_title and not has_rc_version(pr_title):
        fail("generated premain release-please PR must advertise an RC-shaped version")

    if head == MAIN_RELEASE_PLEASE_BRANCH and has_rc_version(pr_title):
        fail("generated main release-please PR must be stable-shaped, not RC-shaped")

    expected_head_sha = normalize_sha(head_sha, "head SHA") if head_sha else None
    trusted_release_please_ref = None
    if head in RELEASE_PLEASE_BRANCHES:
        trusted_release_please_ref = trusted_release_please_head_ref(
            head,
            remote,
            head_ref,
            expected_head_sha,
            github_repository,
            github_head_repository,
        )

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

    if base_ref and base in RELEASE_BRANCHES and plan.ancestor_branch != base:
        resolve_branch_ref(remote, base, base_ref)

    ancestor_ref = resolve_branch_ref(
        remote,
        plan.ancestor_branch,
        base_ref if plan.ancestor_branch == base else None,
    )

    if (
        plan.descendant_branch == head
        and expected_head_sha is not None
        and head_ref is None
        and head not in RELEASE_BRANCHES
        and trusted_release_please_ref is None
    ):
        compare_repository = github_head_repository or github_repository
        if not compare_repository:
            fail("GitHub repository is required to verify PR head ancestry without fetching it")
        if not github_compare_is_ancestor(compare_repository, commit_sha(ancestor_ref), expected_head_sha):
            if base == "staging":
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
        return

    if trusted_release_please_ref is not None and plan.descendant_branch == head:
        descendant_ref = trusted_release_please_ref
    else:
        descendant_ref = resolve_branch_ref(
            remote,
            plan.descendant_branch,
            head_ref if plan.descendant_branch == head else None,
        )

    if plan.descendant_branch == head and expected_head_sha is not None:
        actual_head_sha = commit_sha(descendant_ref).lower()
        if actual_head_sha != expected_head_sha:
            if head in RELEASE_BRANCHES:
                fail(
                    f"event head SHA for protected release branch {head} "
                    f"does not match trusted {remote}/{head}; "
                    "release-train PRs must use the protected branch head content"
                )
            fail(f"event head SHA does not match resolved PR head ref {descendant_ref!r}")

    if not is_ancestor(ancestor_ref, descendant_ref):
        if (
            base == "staging"
            and head == "main"
            and plan.ancestor_branch == "premain"
            and plan.descendant_branch == "main"
            and is_ancestor(descendant_ref, ancestor_ref)
        ):
            print(f"release-train-promotion: PASS ({plan.message}; {head} → {base})")
            return
        if (
            base == "staging"
            and head == "main"
            and plan.ancestor_branch == "premain"
            and plan.descendant_branch == "main"
        ):
            fail(
                "premain and main have diverged; recreate the release-train PR from the current "
                "branch heads and do not merge around staging → premain → main → staging"
            )
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

    run(["git", "switch", "-q", "-c", PREMAIN_RELEASE_PLEASE_BRANCH])
    commit_marker("chore: release 1.0.1-rc.1")

    run(["git", "switch", "-q", "main"])
    run(["git", "switch", "-q", "-c", MAIN_RELEASE_PLEASE_BRANCH])
    commit_marker("chore: release 1.0.1")

    run(["git", "switch", "-q", "premain"])
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
    run(
        [
            "git",
            "push",
            "-q",
            "origin",
            "main",
            "staging",
            "premain",
            PREMAIN_RELEASE_PLEASE_BRANCH,
            MAIN_RELEASE_PLEASE_BRANCH,
            "feature/without-main",
            "feature/with-main",
        ]
    )


def validate_exit(
    base: str,
    head: str,
    *,
    base_ref: str | None = None,
    head_ref: str | None = None,
    head_sha: str | None = None,
    github_repository: str | None = None,
    github_head_repository: str | None = None,
    pr_title: str | None = None,
) -> tuple[int, str]:
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        try:
            validate(
                base,
                head,
                "origin",
                base_ref,
                head_ref,
                head_sha,
                github_repository,
                github_head_repository,
                pr_title,
            )
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
    head_sha: str | None = None,
    github_repository: str | None = None,
    github_head_repository: str | None = None,
    pr_title: str | None = None,
    contains: str | None = None,
) -> None:
    code, output = validate_exit(
        base,
        head,
        base_ref=base_ref,
        head_ref=head_ref,
        head_sha=head_sha,
        github_repository=github_repository,
        github_head_repository=github_head_repository,
        pr_title=pr_title,
    )
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
            assert_validation(
                "premain",
                "staging",
                0,
                base_ref="premain",
                head_sha=commit_sha("staging"),
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
            assert_validation(
                "premain",
                "staging",
                1,
                base_ref="premain",
                head_sha=commit_sha("refs/remotes/origin/pr/1/head"),
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
                "premain",
                PREMAIN_RELEASE_PLEASE_BRANCH,
                0,
                base_ref="premain",
                head_ref=PREMAIN_RELEASE_PLEASE_BRANCH,
                head_sha=commit_sha(PREMAIN_RELEASE_PLEASE_BRANCH),
                github_repository="theory-cloud/AppTheory",
                github_head_repository="theory-cloud/AppTheory",
                pr_title="chore: release 1.0.1-rc.1",
                contains="generated premain RC release-please PR",
            )
            assert_validation(
                "premain",
                PREMAIN_RELEASE_PLEASE_BRANCH,
                1,
                base_ref="premain",
                head_sha=commit_sha(PREMAIN_RELEASE_PLEASE_BRANCH),
                github_repository="theory-cloud/AppTheory",
                github_head_repository="fork-owner/AppTheory",
                pr_title="chore: release 1.0.1-rc.1",
                contains="must originate from trusted repository",
            )
            assert_validation(
                "premain",
                PREMAIN_RELEASE_PLEASE_BRANCH,
                1,
                base_ref="premain",
                head_sha=commit_sha("refs/remotes/origin/pr/1/head"),
                github_repository="theory-cloud/AppTheory",
                github_head_repository="theory-cloud/AppTheory",
                pr_title="chore: release 1.0.1-rc.1",
                contains="does not match trusted origin/release-please--branches--premain",
            )
            assert_validation(
                "premain",
                PREMAIN_RELEASE_PLEASE_BRANCH,
                1,
                base_ref="premain",
                head_ref="refs/remotes/origin/pr/1/head",
                head_sha=commit_sha(PREMAIN_RELEASE_PLEASE_BRANCH),
                github_repository="theory-cloud/AppTheory",
                github_head_repository="theory-cloud/AppTheory",
                pr_title="chore: release 1.0.1-rc.1",
                contains="explicit ref 'refs/remotes/origin/pr/1/head' for generated release-please branch",
            )
            assert_validation(
                "main",
                MAIN_RELEASE_PLEASE_BRANCH,
                0,
                base_ref="main",
                head_ref=MAIN_RELEASE_PLEASE_BRANCH,
                head_sha=commit_sha(MAIN_RELEASE_PLEASE_BRANCH),
                github_repository="theory-cloud/AppTheory",
                github_head_repository="theory-cloud/AppTheory",
                pr_title="chore: release 1.0.1",
                contains="generated main stable release-please PR",
            )
            assert_validation(
                "main",
                MAIN_RELEASE_PLEASE_BRANCH,
                1,
                base_ref="main",
                head_ref=MAIN_RELEASE_PLEASE_BRANCH,
                head_sha=commit_sha(MAIN_RELEASE_PLEASE_BRANCH),
                github_repository="theory-cloud/AppTheory",
                github_head_repository="theory-cloud/AppTheory",
                pr_title="chore: release 1.0.1-rc.1",
                contains="rejects RC-shaped",
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

            run(["git", "switch", "-q", "main"])
            run(["git", "merge", "-q", "--ff-only", "premain"])
            commit_marker("main-stable-release")
            run(["git", "push", "-q", "--force", "origin", "main"])
            if is_ancestor("staging", "main"):
                raise AssertionError("self-test back-merge must allow staging to diverge from main")
            if not is_ancestor("premain", "main"):
                raise AssertionError("self-test stable main must descend from premain")
            assert_validation(
                "staging",
                "main",
                0,
                base_ref="staging",
                head_ref="main",
                head_sha=commit_sha("main"),
                contains="main → staging stable back-merge",
            )
            print("release-train-promotion: positive main → staging back-merge topology accepted")

            run(["git", "switch", "-q", "premain"])
            run(["git", "merge", "-q", "--ff-only", "main"])
            commit_marker("premain-next-rc")
            run(["git", "push", "-q", "--force", "origin", "premain"])
            run(["git", "fetch", "-q", "origin", "premain"])
            if not is_ancestor("main", "premain"):
                raise AssertionError("self-test current premain should be allowed to advance after main")
            assert_validation(
                "staging",
                "main",
                0,
                base_ref="staging",
                head_ref="main",
                head_sha=commit_sha("main"),
                contains="main → staging stable back-merge",
            )
            print("release-train-promotion: positive main → staging back-merge with advanced premain accepted")

            run(["git", "switch", "-q", "--detach", "main~2"])
            run(["git", "switch", "-q", "-c", "main-around-premain"])
            commit_marker("main-around-premain")
            run(["git", "push", "-q", "--force", "origin", "main-around-premain:main"])
            run(["git", "fetch", "-q", "origin", "main"])
            assert_validation(
                "staging",
                "main",
                1,
                base_ref="staging",
                head_sha=commit_sha("refs/remotes/origin/main"),
                contains="premain and main have diverged",
            )
            print("release-train-promotion: negative main → staging merge-around topology rejected")


def self_test() -> None:
    assert_plan("premain", "staging", True, "premain", "staging")
    assert_plan("main", "premain", True, "main", "premain")
    assert_plan("staging", "main", True, "premain", "main")
    assert_plan("premain", PREMAIN_RELEASE_PLEASE_BRANCH, True, "premain", PREMAIN_RELEASE_PLEASE_BRANCH)
    assert_plan("main", MAIN_RELEASE_PLEASE_BRANCH, True, "main", MAIN_RELEASE_PLEASE_BRANCH)
    assert_plan("staging", "feature/release-fix", True, "main", "feature/release-fix")
    assert_plan("main", "staging", False, None, None)
    assert_plan("premain", "main", False, None, None)
    assert_plan("premain", "feature/release-fix", False, None, None)
    assert_plan("project/apptheory-release-process-reliability", "main", False, None, None)
    assert_plan("project/apptheory-release-process-reliability", "milestone/release-hardening", True, None, None)

    ancestor = "0" * 40
    descendant = "1" * 40
    if not compare_response_is_ancestor(
        {
            "status": "ahead",
            "base_commit": {"sha": ancestor},
            "merge_base_commit": {"sha": ancestor},
        },
        ancestor,
    ):
        raise AssertionError("GitHub compare ancestry must accept head commits ahead of the baseline")
    if compare_response_is_ancestor(
        {
            "status": "diverged",
            "base_commit": {"sha": ancestor},
            "merge_base_commit": {"sha": descendant},
        },
        ancestor,
    ):
        raise AssertionError("GitHub compare ancestry must reject branches missing the baseline")

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
    parser.add_argument("--head-sha", default=None)
    parser.add_argument("--github-repository", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--github-head-repository", default=None)
    parser.add_argument("--pr-title", default=None)
    args = parser.parse_args(argv)

    if args.self_test:
        self_test()
        return 0

    if not args.base or not args.head:
        fail("base and head branches are required; pass --base/--head or run on a pull_request event")

    validate(
        args.base,
        args.head,
        args.remote,
        args.base_ref,
        args.head_ref,
        args.head_sha,
        args.github_repository,
        args.github_head_repository,
        args.pr_title,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
PY
