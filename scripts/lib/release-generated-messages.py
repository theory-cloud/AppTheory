#!/usr/bin/env python3
"""Render the generated release-please messages the release gates bind to.

Pinned release-please 17.11.2 renders each lane's `pull-request-title-pattern`
and uses the rendered title as the release-branch commit message
(`build/src/manifest.js` `createOrUpdatePullRequest` and
`build/src/github.js` `updatePullRequest` both set
`message = releasePullRequest.title.toString()`). The artifact sync subject is
declared in `scripts/sync-release-pr-generated.sh`.

This helper only renders and reads those generated messages. It deliberately
does not classify arbitrary commit subjects: the release predicates compare
commits and immutable tags directly, so a human commit whose subject resembles
a generated one still counts as release-driving work.

Subcommands:
  render-title --config P --branch B --version V
                                render the configured release PR title (and
                                therefore the release-branch commit subject)
                                exactly as release-please does
  sync-message                  print the generated artifact sync commit subject

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

SYNC_SCRIPT = "scripts/sync-release-pr-generated.sh"
DEFAULT_TITLE_PATTERN = "chore${scope}: release${component} ${version}"
SUPPORTED_VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-rc(?:\.[0-9]+)?)?$")


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


def title_pattern(config_path: Path) -> str:
    pattern = read_json(config_path).get("pull-request-title-pattern", DEFAULT_TITLE_PATTERN)
    if not isinstance(pattern, str) or not pattern:
        raise ConfigError(f"{config_path} has an invalid pull-request-title-pattern")
    return pattern


def component_from_config(config_path: Path) -> str:
    component = read_json(config_path).get("component", "")
    if component is None:
        return ""
    if not isinstance(component, str):
        raise ConfigError(f"{config_path} has a non-string component")
    return component


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


def render_title(config_path: Path, branch: str, version: str) -> str:
    if not SUPPORTED_VERSION_RE.fullmatch(version):
        raise ConfigError(f"version is not a supported stable/RC semver value: {version}")
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


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=REPO_ROOT)
    subparsers = parser.add_subparsers(dest="command", required=True)

    render_parser = subparsers.add_parser("render-title")
    render_parser.add_argument("--config", type=Path, required=True)
    render_parser.add_argument("--branch", required=True)
    render_parser.add_argument("--version", required=True)
    subparsers.add_parser("sync-message")

    args = parser.parse_args(argv)
    root = args.root.resolve()

    try:
        if args.command == "render-title":
            print(render_title(args.config, args.branch, args.version))
            return 0
        if args.command == "sync-message":
            print(sync_message(root))
            return 0
    except ConfigError as exc:
        print(f"release-generated-messages: FAIL ({exc})", file=sys.stderr)
        return 2

    print(f"release-generated-messages: FAIL (unknown command {args.command})", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
