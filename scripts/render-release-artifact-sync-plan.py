#!/usr/bin/env python3
"""Render the createCommitOnBranch payload for generated release artifacts."""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
from pathlib import Path


ARTIFACT_PATHS = (
    ".release-please-manifest.premain.json",
    "cdk/.jsii",
    "cdk/lib",
    "cdk-go/go.mod",
    "cdk-go/go.sum",
    "cdk-go/apptheorycdk",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--branch", required=True)
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--message", required=True)
    parser.add_argument("--body", required=True)
    parser.add_argument("--mode", default="")
    parser.add_argument("--payload-file", required=True, type=Path)
    parser.add_argument("--summary-file", required=True, type=Path)
    parser.add_argument(
        "--baseline-root",
        type=Path,
        help="Compare against this filesystem snapshot instead of git HEAD (test fixtures only).",
    )
    return parser.parse_args()


def zlines(args: list[str]) -> list[str]:
    raw = subprocess.check_output(args)
    return [item for item in raw.decode("utf-8", "surrogateescape").split("\0") if item]


def git_changes() -> tuple[list[str], list[str]]:
    paths = list(ARTIFACT_PATHS)
    tracked_additions = zlines(
        [
            "git",
            "diff",
            "--no-renames",
            "--name-only",
            "-z",
            "--diff-filter=ACMRT",
            "HEAD",
            "--",
            *paths,
        ]
    )
    tracked_deletions = zlines(
        [
            "git",
            "diff",
            "--no-renames",
            "--name-only",
            "-z",
            "--diff-filter=D",
            "HEAD",
            "--",
            *paths,
        ]
    )
    untracked_additions = zlines(
        ["git", "ls-files", "--others", "--exclude-standard", "-z", "--", *paths]
    )

    addition_paths = sorted(set(tracked_additions + untracked_additions))
    deletion_paths = sorted(set(tracked_deletions) - set(addition_paths))
    return addition_paths, deletion_paths


def files_under(root: Path) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    for relative in ARTIFACT_PATHS:
        path = root / relative
        if path.is_file():
            files[relative] = path.read_bytes()
            continue
        if not path.is_dir():
            continue
        for child in sorted(path.rglob("*")):
            if child.is_file():
                files[child.relative_to(root).as_posix()] = child.read_bytes()
    return files


def filesystem_changes(
    baseline_root: Path, worktree_root: Path
) -> tuple[list[str], list[str]]:
    baseline = files_under(baseline_root)
    worktree = files_under(worktree_root)
    additions = sorted(
        path for path, contents in worktree.items() if baseline.get(path) != contents
    )
    deletions = sorted(path for path in baseline if path not in worktree)
    return additions, deletions


def main() -> int:
    args = parse_args()
    worktree_root = Path.cwd()
    if args.baseline_root is None:
        addition_paths, deletion_paths = git_changes()
    else:
        addition_paths, deletion_paths = filesystem_changes(
            args.baseline_root.resolve(), worktree_root
        )

    additions = []
    for relative in addition_paths:
        path = worktree_root / relative
        if not path.is_file():
            print(
                f"sync-release-pr-generated: FAIL (planned addition is not a file: {relative})",
                file=sys.stderr,
            )
            return 1
        additions.append(
            {
                "path": relative,
                "contents": base64.b64encode(path.read_bytes()).decode("ascii"),
            }
        )

    deletions = [{"path": path} for path in deletion_paths]
    summary = {
        "mode": args.mode,
        "branch": args.branch,
        "expectedHeadOid": args.expected_head,
        "message": args.message,
        "additionCount": len(additions),
        "deletionCount": len(deletions),
        "additions": addition_paths,
        "deletions": deletion_paths,
    }
    payload = {
        "query": """
mutation CreateReleaseArtifactSyncCommit($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit {
      oid
      url
    }
  }
}
""",
        "variables": {
            "input": {
                "branch": {
                    "repositoryNameWithOwner": args.repository,
                    "branchName": args.branch,
                },
                "message": {
                    "headline": args.message,
                    "body": args.body,
                },
                "fileChanges": {
                    "additions": additions,
                    "deletions": deletions,
                },
                "expectedHeadOid": args.expected_head,
            },
        },
    }

    args.payload_file.write_text(
        json.dumps(payload, separators=(",", ":")), encoding="utf-8"
    )
    args.summary_file.write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
