#!/usr/bin/env bash
# Purpose: verify handwritten API docs cover exported top-level symbols and semantic docs anchors.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 - "$@" <<'PY'
from __future__ import annotations

from collections import Counter
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(os.environ.get('APPTHEORY_API_DOCS_ROOT', '.'))


class CheckError(Exception):
    pass


def fail(message: str) -> None:
    raise CheckError(message)


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


def strip_coverage_block(label: str, doc_path: str, text: str) -> tuple[str, str]:
    start = f'<!-- apptheory-api-docs:{label}:start -->'
    end = f'<!-- apptheory-api-docs:{label}:end -->'
    if text.count(start) != 1:
        fail(f'api-docs: FAIL ({label}: {doc_path} must contain exactly one {start} marker)')
    if text.count(end) != 1:
        fail(f'api-docs: FAIL ({label}: {doc_path} must contain exactly one {end} marker)')
    start_index = text.index(start)
    end_index = text.index(end)
    if end_index <= start_index:
        fail(f'api-docs: FAIL ({label}: {doc_path} coverage end marker appears before start marker)')
    block = text[start_index + len(start) : end_index]
    outside = text[:start_index] + text[end_index + len(end) :]
    return block, outside


def index_symbols(label: str, doc_path: str, block: str) -> list[str]:
    fences = re.findall(r'```text\s*\n(.*?)\n```', block, flags=re.DOTALL)
    if len(fences) != 1:
        fail(f'api-docs: FAIL ({label}: {doc_path} coverage block must contain exactly one ```text code fence)')
    return re.findall(r'\b[A-Za-z_][A-Za-z0-9_]*\b', fences[0])


def check_coverage_index(label: str, source: str, doc_path: str, block: str, symbols: list[str]) -> None:
    summary_match = re.search(r'<summary>\s*(\d+)\s+exported top-level symbols\s*</summary>', block)
    if not summary_match:
        fail(f'api-docs: FAIL ({label}: {doc_path} coverage block missing exported-symbol summary)')
    summary_count = int(summary_match.group(1))
    if summary_count != len(symbols):
        fail(
            f'api-docs: FAIL ({label}: {doc_path} summary count {summary_count} != '
            f'{len(symbols)} symbols from {source})'
        )

    listed = index_symbols(label, doc_path, block)
    counts = Counter(listed)
    duplicates = sorted(symbol for symbol, count in counts.items() if count > 1)
    if duplicates:
        preview = ', '.join(duplicates[:40])
        more = '' if len(duplicates) <= 40 else f' (+{len(duplicates) - 40} more)'
        fail(f'api-docs: FAIL ({label}: {doc_path} duplicates {len(duplicates)} coverage symbols: {preview}{more})')

    expected = set(symbols)
    observed = set(listed)
    missing = sorted(expected - observed, key=str.lower)
    extra = sorted(observed - expected, key=str.lower)
    if missing or extra:
        parts = []
        if missing:
            preview = ', '.join(missing[:40])
            more = '' if len(missing) <= 40 else f' (+{len(missing) - 40} more)'
            parts.append(f'missing {len(missing)} from {source}: {preview}{more}')
        if extra:
            preview = ', '.join(extra[:40])
            more = '' if len(extra) <= 40 else f' (+{len(extra) - 40} more)'
            parts.append(f'extra {len(extra)} not in {source}: {preview}{more}')
        fail(f'api-docs: FAIL ({label}: {doc_path} coverage index drift: {"; ".join(parts)})')


def human_anchor_present(text: str, anchor: str) -> bool:
    if re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', anchor):
        return mentioned(text, anchor)
    return anchor.lower() in text.lower()


HUMAN_DOC_ANCHORS: dict[str, list[str]] = {
    'go': [
        'Core runtime entrypoints',
        'HTTP source provenance',
        'Universal Lambda entrypoint',
        'Route registration',
        'Rate limiting',
        'Sanitization',
        'Object store helper',
        'AWS Lambda MicroVM support',
        'MCP and OAuth',
        'CDK construct overview',
    ],
    'ts': [
        'TypeScript semantic API map',
        'App',
        'createApp',
        'Context',
        'createTestEnv',
        'buildAPIGatewayV2Request',
        'McpServer',
        'ObjectStore',
        'MicroVMController',
        'generateOpenAPI',
    ],
    'py': [
        'Python semantic API map',
        'create_app',
        'Context',
        'create_test_env',
        'build_apigw_v2_request',
        'McpServer',
        'ObjectStore',
        'MicroVMController',
        'generate_openapi',
    ],
    'cdk': [
        'CDK semantic construct map',
        'AppTheoryHttpApi',
        'AppTheoryRestApi',
        'AppTheoryMcpServer',
        'AppTheoryRemoteMcpServer',
        'AppTheoryQueue',
        'AppTheoryKinesisStream',
        'AppTheoryMicrovmController',
        'AppTheorySsrSite',
    ],
}


def check_human_depth(label: str, doc_path: str, outside_coverage: str) -> None:
    anchors = HUMAN_DOC_ANCHORS[label]
    missing = [anchor for anchor in anchors if not human_anchor_present(outside_coverage, anchor)]
    if missing:
        preview = ', '.join(missing)
        fail(
            f'api-docs: FAIL ({label}: {doc_path} missing semantic docs anchors outside '
            f'generated coverage index: {preview})'
        )


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
    block, outside_coverage = strip_coverage_block(label, doc_path, text)
    check_coverage_index(label, source, doc_path, block, symbols)
    check_human_depth(label, doc_path, outside_coverage)
    print(
        f'api-docs: {label} PASS '
        f'({len(symbols)} symbols + {len(HUMAN_DOC_ANCHORS[label])} semantic anchors in {doc_path})'
    )


def self_test() -> None:
    symbols = ['App', 'Context', 'createApp']
    block = '''
<details>
<summary>3 exported top-level symbols</summary>

```text
App, Context, createApp
```
</details>
'''
    check_coverage_index('ts', 'self-test.md', 'fixture', block, symbols)

    try:
        check_coverage_index('ts', 'self-test.md', 'fixture', block.replace('3 exported', '2 exported'), symbols)
    except CheckError:
        pass
    else:  # pragma: no cover - this is the proof condition
        fail('api-docs self-test: stale summary count was not rejected')

    try:
        check_coverage_index('ts', 'self-test.md', 'fixture', block.replace('createApp', 'staleSymbol'), symbols)
    except CheckError:
        pass
    else:  # pragma: no cover - this is the proof condition
        fail('api-docs self-test: stale coverage symbols were not rejected')

    try:
        check_human_depth('ts', 'self-test.md', 'This document only has generated coverage, not narrative docs.')
    except CheckError:
        pass
    else:  # pragma: no cover - this is the proof condition
        fail('api-docs self-test: missing semantic anchors were not rejected')

    rich_text = '''
## TypeScript semantic API map
Use App and createApp with Context, createTestEnv, buildAPIGatewayV2Request,
McpServer, ObjectStore, MicroVMController, and generateOpenAPI.
'''
    check_human_depth('ts', 'self-test.md', rich_text)
    print('api-docs: self-test PASS')


def main(argv: list[str]) -> None:
    if argv == ['--self-test']:
        self_test()
        return
    if argv:
        fail(f'api-docs: FAIL (unknown arguments: {" ".join(argv)})')
    check('go', 'api-snapshots/go.txt', 'docs/api-reference.md', go_symbols())
    check('ts', 'api-snapshots/ts.txt', 'ts/docs/README.md', ts_symbols())
    check('py', 'api-snapshots/py.txt', 'py/docs/README.md', py_symbols())
    check('cdk', 'cdk/.jsii', 'cdk/docs/README.md', cdk_symbols())
    print('api-docs: PASS')


try:
    main(sys.argv[1:])
except CheckError as exc:
    raise SystemExit(str(exc))
PY
