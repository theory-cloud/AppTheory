---
title: TypeScript Runtime
description: The TypeScript implementation of the AppTheory contract — bundled, ESM, jsii-compatible CDK.
---

# TypeScript Runtime

The TypeScript runtime is an independent implementation of the AppTheory contract — not a port of the Go runtime. The [89 contract fixtures](../reference/contract-fixtures.md) arbitrate when Go, TS, and Python disagree.

## Install

```bash
npm install --save-dev @theory-cloud/apptheory
```

Distribution is **GitHub Releases only.** The npm registry is not used; consumers pin a release-asset tarball:

```bash
# From a GitHub Release asset
npm install ./theory-cloud-apptheory-X.Y.Z.tgz
```

The package is ESM and ships TypeScript declarations. Node.js 24+ is required.

## Module layout

| Subpath | Purpose |
| --- | --- |
| `@theory-cloud/apptheory` | Core runtime: `createApp`, `Context`, request/response model, event builders. |
| `@theory-cloud/apptheory/mcp` | MCP Streamable HTTP server + session storage. |
| `@theory-cloud/apptheory/oauth` | OAuth protected-resource metadata + middleware. |
| `@theory-cloud/apptheory/limited` | DynamoDB-backed rate limiter (`DynamoRateLimiter`, `FixedWindowStrategy`, `SlidingWindowStrategy`, `MultiWindowStrategy`). |
| `@theory-cloud/apptheory/jobs` | Jobs-ledger primitives (`DynamoJobLedger`). |

See `api-snapshots/ts.txt` for the exact exported surface — that file is the release gate.

## Minimal app

```ts
import { createApp, text } from "@theory-cloud/apptheory";

const app = createApp();

app.get("/ping", () => text(200, "pong"));

export const handler = async (event: unknown, ctx: unknown) =>
  app.handleLambda(event, ctx);
```

`handleLambda` is the single Lambda entrypoint for every AWS event shape. See [Event Shape Dispatch](../reference/event-shapes.md) for the dispatch table.

## Tier selection

```ts
import { createApp, TIER_P0 } from "@theory-cloud/apptheory";

const app = createApp({ tier: TIER_P0 });
```

See [HTTP Runtime](../features/http-runtime.md) for what each tier includes.

## Deterministic tests

```ts
import { createTestEnv, text } from "@theory-cloud/apptheory";

test("ping", async () => {
  const env = createTestEnv({ now: new Date("2026-01-01T00:00:00Z") });
  env.ids.queue("req-1");

  const app = env.app();
  app.get("/ping", () => text(200, "pong"));

  const event = env.apiGatewayV2Request("GET", "/ping");
  const resp = await env.invokeAPIGatewayV2(app, event);

  expect(resp.statusCode).toBe(200);
});
```

## Strict routes

```ts
app.handleStrict("GET", "/users/{id}", handler);
```

Strict registration throws on invalid patterns at registration time — preferred for CI and unit tests.

## HTTP error format

```ts
import { createApp, HTTP_ERROR_FORMAT_FLAT_LEGACY } from "@theory-cloud/apptheory";

const app = createApp({ httpErrorFormat: HTTP_ERROR_FORMAT_FLAT_LEGACY });
```

Applies to HTTP error serialization only.

## Lambda Function URL streaming

The TypeScript runtime ships first-class support for Lambda Function URL response streaming — useful for SSE and HTML streaming:

```ts
import { createApp, createLambdaFunctionURLStreamingHandler } from "@theory-cloud/apptheory";

const app = createApp();
app.get("/stream", (ctx) => htmlStream(/* ... */));

export const handler = createLambdaFunctionURLStreamingHandler(app);
```

Use this when latency-to-first-byte matters more than buffered responses; the standard `handleLambda` export does not stream.

## CDK constructs (jsii)

CDK constructs live in the separate `@theory-cloud/apptheory-cdk` package (jsii). The TS source under `cdk/lib/` is the canonical implementation; Go bindings under `cdk-go/` are generated.

See [CDK Getting Started](../cdk/getting-started.md).

## What's verified

The TypeScript runtime passes all 89 contract fixtures on every commit, against the same fixture corpus as Go and Python. The `ts/dist/` build output is checked in and gated by `make rubric`.

## Next reads

- [API Reference](../api-reference.md)
- [HTTP Runtime tiers](../features/http-runtime.md)
- [MCP Method Surface](../integrations/mcp.md)
- [Contract Fixtures](../reference/contract-fixtures.md)
