#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

actual="$(find contract-tests/fixtures -name '*.json' | wc -l | tr -d '[:space:]')"
export APPTHEORY_FIXTURE_COUNT_ACTUAL="${actual}"

python3 <<'PY'
import os
import re
import subprocess
import sys
from pathlib import Path

actual = int(os.environ["APPTHEORY_FIXTURE_COUNT_ACTUAL"])

tracked = subprocess.check_output(["git", "ls-files", "README.md", "docs"], text=True).splitlines()
public_suffixes = {".md", ".markdown", ".html", ".yml", ".yaml"}
ignored_prefixes = (
    "docs/assets/",
    "docs/development/planning/",
)

marker_re = re.compile(r"apptheory-fixture-count(?::\s*(?P<count>\d+))?", re.IGNORECASE)
claim_patterns = [
    re.compile(r"(?<![A-Za-z0-9.])(?P<count>\d+)\s+(?:shared\s+)?(?:contract(?:\s+test)?\s+)?fixtures?\b", re.IGNORECASE),
    re.compile(r"(?<![A-Za-z0-9.])(?P<count>\d+)-fixture\b", re.IGNORECASE),
    re.compile(r"\bfixtures\s*\((?P<count>\d+)\)", re.IGNORECASE),
]

mismatches: list[str] = []
marker_count = 0
claim_count = 0
seen_claims: set[tuple[str, int, int, str]] = set()

for name in tracked:
    if name.startswith(ignored_prefixes):
        continue
    path = Path(name)
    if path.suffix.lower() not in public_suffixes:
        continue
    text = path.read_text(encoding="utf-8")
    for lineno, line in enumerate(text.splitlines(), start=1):
        for marker_match in marker_re.finditer(line):
            marker_count += 1
            explicit = marker_match.group("count")
            if explicit is not None:
                values = [int(explicit)]
            else:
                visible_line = line[: marker_match.start()]
                values = [int(value) for value in re.findall(r"(?<![\d.])\d+(?![\d.])", visible_line)]
            if not values:
                mismatches.append(f"{name}:{lineno}: fixture-count marker has no count on the same line")
                continue
            for value in values:
                if value != actual:
                    mismatches.append(f"{name}:{lineno}: marker count {value} != actual corpus count {actual}")
        for pattern in claim_patterns:
            for match in pattern.finditer(line):
                value = int(match.group("count"))
                key = (name, lineno, match.start(), match.group(0))
                if key in seen_claims:
                    continue
                seen_claims.add(key)
                claim_count += 1
                if value != actual:
                    mismatches.append(f"{name}:{lineno}: documented fixture count {value} != actual corpus count {actual}: {match.group(0)!r}")

if marker_count == 0:
    mismatches.append("no apptheory-fixture-count markers found in README/docs")

if mismatches:
    print("fixture-count: FAIL", file=sys.stderr)
    for mismatch in mismatches:
        print(f"- {mismatch}", file=sys.stderr)
    sys.exit(1)

print(f"fixture-count: PASS (actual={actual}, claims={claim_count}, markers={marker_count})")
PY
