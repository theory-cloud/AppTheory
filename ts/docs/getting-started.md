# Getting Started (TypeScript)

This guide walks you through installing and running a minimal AppTheory app in TypeScript (Node.js 24).

## Install

AppTheory is distributed via **GitHub Releases** (no npm registry publishing). Pin and verify the release tarball before installing it:

```bash
VERSION=1.14.0
TAG="v${VERSION}"
REPO="theory-cloud/AppTheory"

gh release download "${TAG}" --repo "${REPO}" \
  --pattern "theory-cloud-apptheory-${VERSION}.tgz" \
  --pattern "SHA256SUMS.txt" \
  --clobber
grep " theory-cloud-apptheory-${VERSION}.tgz$" SHA256SUMS.txt | sha256sum -c -
npm install "./theory-cloud-apptheory-${VERSION}.tgz"
```

## Minimal local invocation (P2 default)

```ts
// CORRECT: Use the deterministic test env for unit tests and local invocation.
import { createTestEnv, text } from "@theory-cloud/apptheory";

const env = createTestEnv();
const app = env.app();

app.get("/ping", () => text(200, "pong"));

const resp = await env.invoke(app, { method: "GET", path: "/ping" });
console.log(resp.status); // 200
```

## Next steps

- Read [Core Patterns](./core-patterns.md) for middleware/streaming/SSE patterns.
- Use [API Reference](./api-reference.md) to find the right adapter/helpers for your AWS integration.

