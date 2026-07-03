---
title: Python Runtime
description: The Python implementation of the AppTheory contract — typed, async-friendly, fixture-backed parity.
---

# Python Runtime

The Python runtime is an independent implementation of the AppTheory contract — not a port of the Go runtime. The [171 contract fixtures](../reference/contract-fixtures.md) arbitrate when Go, TS, and Python disagree. <!-- apptheory-fixture-count -->

## Install

Distribution is **GitHub Releases only.** PyPI is not used; AppTheory does not publish to it. Pin the release wheel and verify its checksum before installing it:

```bash
VERSION=1.14.0
TAG="v${VERSION}"
REPO="theory-cloud/AppTheory"

gh release download "${TAG}" --repo "${REPO}" \
  --pattern "apptheory-${VERSION}-py3-none-any.whl" \
  --pattern "SHA256SUMS.txt" \
  --clobber
grep " apptheory-${VERSION}-py3-none-any.whl$" SHA256SUMS.txt | sha256sum -c -
python -m pip install "./apptheory-${VERSION}-py3-none-any.whl"
```

Python 3.14+ is required.

## Module layout

| Module | Purpose |
| --- | --- |
| `apptheory` | Core Python runtime exports: `create_app`, `Context`, request/response helpers, event builders, testkit helpers, jobs-ledger primitives, logging profiles, and sanitization helpers. Rate-limiter classes are not root exports. |
| `apptheory.limited` | DynamoDB-backed rate limiter exports (`DynamoRateLimiter`, `FixedWindowStrategy`, `SlidingWindowStrategy`, `MultiWindowStrategy`). |

There are no Python MCP or OAuth runtime modules. See `api-snapshots/py.txt` for the exact exported surface — that file is the release gate.

## Minimal app

```python
from apptheory import create_app, text

app = create_app()

@app.get("/ping")
def ping(ctx):
    return text(200, "pong")

def handler(event, ctx):
    return app.handle_lambda(event, ctx)
```

`handle_lambda` is the single Lambda entrypoint for every AWS event shape. See [Event Shape Dispatch](../reference/event-shapes.md) for the dispatch table.

## Tier selection

```python
from apptheory import create_app

app = create_app(tier="p0")
```

Python tiers are string literals: `"p0"`, `"p1"`, or `"p2"`.

See [HTTP Runtime](../features/http-runtime.md) for what each tier includes.

## Deterministic tests

```python
from datetime import datetime, timezone
from apptheory import build_apigw_v2_request, create_test_env, text

def test_ping():
    env = create_test_env(now=datetime(2026, 1, 1, tzinfo=timezone.utc))
    env.ids.push("req-1")

    app = env.app()
    app.get("/ping", lambda ctx: text(200, "pong"))

    event = build_apigw_v2_request("GET", "/ping")
    resp = env.invoke_apigw_v2(app, event)

    assert resp["statusCode"] == 200
```

## Strict routes

```python
app.handle_strict("GET", "/users/{id}", handler)
```

Strict registration raises on invalid patterns at registration time.

## HTTP error format

```python
from apptheory import create_app, HTTP_ERROR_FORMAT_FLAT_LEGACY

app = create_app(http_error_format=HTTP_ERROR_FORMAT_FLAT_LEGACY)
```

Applies to HTTP error serialization only.

## What's verified

The Python runtime passes all 171 contract fixtures on every commit, <!-- apptheory-fixture-count --> against the same fixture corpus as Go and TypeScript. Tests live under `py/tests/` and are exercised by `./scripts/verify-python-tests.sh` and `make rubric`.

## Next reads

- [API Reference](../api-reference.md)
- [HTTP Runtime tiers](../features/http-runtime.md)
- [MCP Method Surface](../integrations/mcp.md) — Go runtime MCP surface
- [Contract Fixtures](../reference/contract-fixtures.md)
