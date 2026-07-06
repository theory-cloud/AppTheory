---
title: Python Runtime
description: The Python implementation of the AppTheory contract — typed, async-friendly, fixture-backed parity.
---

# Python Runtime

The Python runtime is an independent implementation of the AppTheory contract — not a port of the Go runtime. It executes all [216 contract fixtures](../reference/contract-fixtures.md), including the SP09 MCP tier, SP12 OAuth tier, and SP13 objectstore tier. <!-- apptheory-fixture-count: 216 -->

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

Python 3.12+ is required. The floor is pinned by `py/pyproject.toml`, Ruff, Pyright, the pinned TableTheory GitHub
Release wheel metadata, and CI. Do not document a different Python floor unless `scripts/verify-runtime-floor-claims.sh`
passes with a CI matrix that includes both the floor and Python 3.14.

## Module layout

| Module | Purpose |
| --- | --- |
| `apptheory` | Core Python runtime exports: `create_app`, `Context`, request/response helpers, event builders, testkit helpers, MCP/OAuth helpers, jobs-ledger primitives, logging profiles, object-store helpers, and sanitization helpers. Rate-limiter classes are not root exports. |
| `apptheory.mcp` | Streamable HTTP MCP server, registries, session/stream/task stores, SSE parsing, and deterministic test harness helpers. |
| `apptheory.oauth` | Protected-resource metadata, bearer-token validation, DCR, PKCE, and Remote MCP OAuth helper surfaces. |
| `apptheory.limited` | DynamoDB-backed rate limiter exports (`DynamoRateLimiter`, `FixedWindowStrategy`, `SlidingWindowStrategy`, `MultiWindowStrategy`). |

See `api-snapshots/py.txt` for the exact exported surface — that file is the release gate.

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

## Route registration

```python
app.handle("GET", "/users/{id}", handler)
app.get("/users/{id}", handler)
```

Normal fluent registration fails closed on invalid patterns, duplicates, and `None` handlers. `handle_strict` remains as
a deprecated compatibility wrapper for callers that still need the old helper shape.

## HTTP error format

```python
from apptheory import create_app, HTTP_ERROR_FORMAT_FLAT_LEGACY

app = create_app(http_error_format=HTTP_ERROR_FORMAT_FLAT_LEGACY)
```

Applies to HTTP error serialization only.

## What's verified

The Python runtime passes the full contract corpus on every commit. <!-- apptheory-fixture-count: 216 --> The runner loads and executes the full 216-fixture tree, including the SP09 MCP tier, SP12 OAuth tier, and SP13 objectstore tier. Tests live under `py/tests/` and are exercised by `./scripts/verify-python-tests.sh` and `make rubric`.

## Next reads

- [API Reference](../api-reference.md)
- [HTTP Runtime tiers](../features/http-runtime.md)
- [MCP Method Surface](../integrations/mcp.md) — transport and JSON-RPC method contract
- [Contract Fixtures](../reference/contract-fixtures.md)
