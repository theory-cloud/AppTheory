#!/usr/bin/env python3
"""Classify Release Please release-automation commits for the shared release predicates.

The release train's own commits are release-driving `fix(...)` commits by design:
one lane configures `pull-request-title-pattern`, and release-please uses that same
rendered title as the release-branch commit message (pinned release-please 17.11.2:
build/src/manifest.js createOrUpdatePullRequest and build/src/github.js
updatePullRequest set `message = releasePullRequest.title.toString()`). The artifact
sync message lives in scripts/sync-release-pr-generated.sh.

Because those generated subjects are `fix:`-typed, a naive `feat|fix|perf` subject
scan counts the released automation as fresh user-facing work. That would make a
post-release promotion look release-eligible and make an already-published no-op
look illegitimate. This helper derives the generated subjects from the live
configuration so every predicate excludes exactly what the train generates, and
nothing else.

Subcommands:
  filter-user-facing            read commit subjects on stdin; print only the
                                subjects that are not release automation
  is-automation --subject S     exit 0 when S is a generated release-automation subject
  render-title --config P --branch B --version V
                                render the configured release PR title (and therefore
                                the release-branch commit subject) exactly as
                                release-please does
  sync-message                  print the configured artifact sync commit subject
  patterns                      print the two generated-subject match patterns

Configuration errors exit 2 so callers fail closed.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent

LANE_CONFIGS = (
    "release-please-config.premain.json",
    "release-please-config.json",
)
SYNC_SCRIPT = "scripts/sync-release-pr-generated.sh"
DEFAULT_TITLE_PATTERN = "chore${scope}: release${component} ${version}"

PLACEHOLDER_MATCHERS = {
    # Mirrors generateMatchPattern in pinned release-please
    # build/src/util/pull-request-title.js.
    "${scope}": r"(?:\([\w\-./]+\))?",
    "${component}": r"(?: ?@?[\w\-./]*)?",
    "${version}": r"v?[0-9].*",
    "${branch}": r"(?:[\w\-./]+)?",
}
PLACEHOLDER_RE = re.compile(r"\$\{(?:scope|component|version|branch)\}")


class ConfigError(RuntimeError):
    pass


def read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError(f"could not read {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ConfigError(f"{path} must contain a JSON object")
    return data


def lane_config_paths(root: Path) -> list[Path]:
    return [root / name for name in LANE_CONFIGS]


def title_pattern(config_path: Path) -> str:
    config = read_json(config_path)
    pattern = config.get("pull-request-title-pattern", DEFAULT_TITLE_PATTERN)
    if not isinstance(pattern, str) or not pattern:
        raise ConfigError(f"{config_path} has an invalid pull-request-title-pattern")
    return pattern


def sync_message(root: Path) -> str:
    script = root / SYNC_SCRIPT
    try:
        text = script.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"could not read {script}: {exc}") from exc
    match = re.search(r'^artifact_sync_commit_message="([^"]+)"$', text, re.MULTILINE)
    if not match:
        raise ConfigError(f"{script} does not declare artifact_sync_commit_message")
    return match.group(1)


def subject_regex(pattern: str) -> re.Pattern[str]:
    out: list[str] = []
    last = 0
    for match in PLACEHOLDER_RE.finditer(pattern):
        out.append(re.escape(pattern[last : match.start()]))
        out.append(PLACEHOLDER_MATCHERS[match.group(0)])
        last = match.end()
    out.append(re.escape(pattern[last:]))
    return re.compile("^" + "".join(out) + "$")


def component_from_config(config_path: Path) -> str:
    config = read_json(config_path)
    component = config.get("component", "")
    if component is None:
        return ""
    if not isinstance(component, str):
        raise ConfigError(f"{config_path} has a non-string component")
    return component


def render_title(config_path: Path, branch: str, version: str) -> str:
    pattern = title_pattern(config_path)
    component = component_from_config(config_path)
    rendered_component = f" {component}" if component else ""
    title = (
        pattern.replace("${scope}", f"({branch})" if branch else "")
        .replace("${component}", rendered_component)
        .replace("${version}", version)
        .replace("${branch}", branch)
        .strip()
    )
    if "${" in title:
        raise ConfigError(f"{config_path} title pattern has an unsupported placeholder: {pattern}")
    return title


def generated_patterns(root: Path) -> list[re.Pattern[str]]:
    patterns: list[re.Pattern[str]] = []
    for config_path in lane_config_paths(root):
        if not config_path.is_file():
            raise ConfigError(f"missing lane config {config_path}")
        patterns.append(subject_regex(title_pattern(config_path)))
    patterns.append(re.compile("^" + re.escape(sync_message(root)) + "$"))
    return patterns


def is_automation(subject: str, patterns: list[re.Pattern[str]]) -> bool:
    return any(pattern.match(subject) for pattern in patterns)


def cmd_filter(root: Path) -> int:
    patterns = generated_patterns(root)
    for line in sys.stdin.read().splitlines():
        if line and not is_automation(line, patterns):
            print(line)
    return 0


def cmd_is_automation(root: Path, subject: str) -> int:
    return 0 if is_automation(subject, generated_patterns(root)) else 1


def cmd_render_title(config_path: Path, branch: str, version: str) -> int:
    print(render_title(config_path, branch, version))
    return 0


def cmd_sync_message(root: Path) -> int:
    print(sync_message(root))
    return 0


def cmd_patterns(root: Path) -> int:
    for pattern in generated_patterns(root):
        print(pattern.pattern)
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=REPO_ROOT)
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("filter-user-facing")
    is_automation_parser = subparsers.add_parser("is-automation")
    is_automation_parser.add_argument("--subject", required=True)
    render_parser = subparsers.add_parser("render-title")
    render_parser.add_argument("--config", type=Path, required=True)
    render_parser.add_argument("--branch", required=True)
    render_parser.add_argument("--version", required=True)
    subparsers.add_parser("sync-message")
    subparsers.add_parser("patterns")

    args = parser.parse_args(argv)
    root = args.root.resolve()

    try:
        if args.command == "filter-user-facing":
            return cmd_filter(root)
        if args.command == "is-automation":
            return cmd_is_automation(root, args.subject)
        if args.command == "render-title":
            return cmd_render_title(args.config, args.branch, args.version)
        if args.command == "sync-message":
            return cmd_sync_message(root)
        if args.command == "patterns":
            return cmd_patterns(root)
    except ConfigError as exc:
        print(f"release-automation-commits: FAIL ({exc})", file=sys.stderr)
        return 2

    print(f"release-automation-commits: FAIL (unknown command {args.command})", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
