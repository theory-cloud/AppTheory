# Getting Started (Python)

This guide walks you through installing and running a minimal AppTheory app in Python (3.14).

## Install

AppTheory is distributed via **GitHub Releases** (no PyPI publishing). Pin and verify the release wheel before installing it:

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

