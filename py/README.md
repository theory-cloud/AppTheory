# AppTheory (Python)

This folder contains the Python SDK/runtime for AppTheory.

The portable runtime behavior is defined by the fixture-backed contract:
`docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`.

## Minimal local invocation (P0)

```py
from apptheory import Request, create_test_env, text

env = create_test_env()
app = env.app()

app.get("/ping", lambda ctx: text(200, "pong"))

resp = env.invoke(app, Request(method="GET", path="/ping"))
assert resp.status == 200
```
