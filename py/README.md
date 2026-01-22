# AppTheory (Python)

This folder contains the Python SDK/runtime for AppTheory.

The portable runtime behavior is defined by the fixture-backed contract:
`docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`.

## Documentation

- Python docs index: `py/docs/README.md`
- Repo docs index: `docs/README.md`

## Minimal local invocation (P2 default)

To force the P0 core (minimal surface area), pass `tier="p0"` when creating the app.

Note: header names are case-insensitive, but response headers are emitted with lowercase keys.

```py
from apptheory import Request, create_test_env, text

env = create_test_env()
app = env.app()

app.get("/ping", lambda ctx: text(200, "pong"))

resp = env.invoke(app, Request(method="GET", path="/ping"))
assert resp.status == 200
```

## Unit test without AWS (M7)

Deterministic time + IDs, invoked using an API Gateway v2 event shape:

```py
import json as jsonlib
from datetime import UTC, datetime

from apptheory import build_apigw_v2_request, create_test_env, json


def test_unit_without_aws():
    env = create_test_env(now=datetime(2026, 1, 1, tzinfo=UTC))
    env.ids.push("req-1")

    app = env.app()

    def mw(ctx, next_handler):
        ctx.set("mw", "ok")
        resp = next_handler(ctx)
        resp.headers["x-middleware"] = ["1"]
        return resp

    app.use(mw)
    app.get("/hello", lambda ctx: json(200, {"now": ctx.now().isoformat(), "id": ctx.new_id(), "mw": ctx.get("mw")}))

    event = build_apigw_v2_request("GET", "/hello", headers={"x-request-id": "request-1"})
    resp = env.invoke_apigw_v2(app, event)

    assert resp["statusCode"] == 200
    assert resp["headers"]["x-request-id"] == "request-1"
    assert resp["headers"]["x-middleware"] == "1"
    body = jsonlib.loads(resp["body"])
    assert body["id"] == "req-1"
    assert body["now"] == "2026-01-01T00:00:00+00:00"
    assert body["mw"] == "ok"
```

## Lint

```bash
./scripts/verify-python-lint.sh
```
