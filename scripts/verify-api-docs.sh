#!/usr/bin/env bash
# Purpose: verify handwritten API docs mention every exported top-level symbol.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 - <<'PY'
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path('.')


def fail(message: str) -> None:
    raise SystemExit(message)


def go_symbols() -> list[str]:
    symbols: list[str] = []
    for line in (ROOT / 'api-snapshots/go.txt').read_text(encoding='utf-8').splitlines():
        match = re.match(r'^(?:const|var|type)\s+([A-Z][A-Za-z0-9_]*)\b', line)
        if match:
            symbols.append(match.group(1))
            continue
        match = re.match(r'^func\s+([A-Z][A-Za-z0-9_]*)\s*\(', line)
        if match:
            symbols.append(match.group(1))
    return sorted(set(symbols), key=str.lower)


def ts_symbols() -> list[str]:
    symbols: list[str] = []
    inside_exports = False
    for line in (ROOT / 'api-snapshots/ts.txt').read_text(encoding='utf-8').splitlines():
        stripped = line.strip()
        if stripped == '[exports]':
            inside_exports = True
            continue
        if stripped.startswith('['):
            inside_exports = False
        if inside_exports and stripped and not stripped.startswith('#'):
            symbols.append(stripped.split()[0])
    return sorted(set(symbols), key=str.lower)


def py_symbols() -> list[str]:
    symbols: list[str] = []
    allowed_sections = {'[apptheory.__all__]', '[apptheory.limited.__all__]'}
    inside_exports = False
    for line in (ROOT / 'api-snapshots/py.txt').read_text(encoding='utf-8').splitlines():
        stripped = line.strip()
        if stripped.startswith('[') and stripped.endswith(']'):
            inside_exports = stripped in allowed_sections
            continue
        if inside_exports and stripped and not stripped.startswith('#'):
            symbols.append(stripped)
    return sorted(set(symbols), key=str.lower)


def cdk_symbols() -> list[str]:
    data = json.loads((ROOT / 'cdk/.jsii').read_text(encoding='utf-8'))
    symbols: list[str] = []
    for fqn in data.get('types', {}):
        if fqn.startswith('@theory-cloud/apptheory-cdk.'):
            symbols.append(fqn.rsplit('.', 1)[-1])
    return sorted(set(symbols), key=str.lower)


def mentioned(doc_text: str, symbol: str) -> bool:
    escaped = re.escape(symbol)
    return re.search(rf'(?<![A-Za-z0-9_]){escaped}(?![A-Za-z0-9_])', doc_text) is not None


def check(label: str, source: str, doc_path: str, symbols: list[str]) -> None:
    doc = ROOT / doc_path
    if not doc.exists():
        fail(f'api-docs: FAIL ({label}: missing doc {doc_path})')
    text = doc.read_text(encoding='utf-8')
    missing = [symbol for symbol in symbols if not mentioned(text, symbol)]
    if missing:
        preview = ', '.join(missing[:80])
        more = '' if len(missing) <= 80 else f' (+{len(missing) - 80} more)'
        fail(f'api-docs: FAIL ({label}: {doc_path} missing {len(missing)} symbols from {source}: {preview}{more})')
    print(f'api-docs: {label} PASS ({len(symbols)} symbols in {doc_path})')


check('go', 'api-snapshots/go.txt', 'docs/api-reference.md', go_symbols())
check('ts', 'api-snapshots/ts.txt', 'ts/docs/README.md', ts_symbols())
check('py', 'api-snapshots/py.txt', 'py/docs/README.md', py_symbols())
check('cdk', 'cdk/.jsii', 'cdk/docs/README.md', cdk_symbols())
print('api-docs: PASS')
PY
