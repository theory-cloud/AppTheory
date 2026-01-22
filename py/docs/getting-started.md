# Getting Started (Python)

This guide walks you through installing and running a minimal AppTheory app in Python (3.14).

## Install

AppTheory is distributed via **GitHub Releases** (no PyPI publishing).

Example (install from a downloaded release wheel):

```bash
python -m pip install ./apptheory-X.Y.Z-py3-none-any.whl
```

## Minimal local invocation (P2 default)

```py
# CORRECT: Use the deterministic test env for unit tests and local invocation.
from apptheory import Request, create_test_env, text

env = create_test_env()
app = env.app()

app.get("/ping", lambda ctx: text(200, "pong"))

resp = env.invoke(app, Request(method="GET", path="/ping"))
assert resp.status == 200
```

## Next steps

- Read [Core Patterns](./core-patterns.md) for middleware/streaming/SSE patterns.
- Use [API Reference](./api-reference.md) to find the right adapter/helpers for your AWS integration.

