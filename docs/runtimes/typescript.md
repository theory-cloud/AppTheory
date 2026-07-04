---
title: TypeScript Runtime
description: The TypeScript implementation of the AppTheory contract — bundled, ESM, jsii-compatible CDK.
---

# TypeScript Runtime

The TypeScript runtime is an independent implementation of the AppTheory contract — not a port of the Go runtime. The [147 contract fixtures](../reference/contract-fixtures.md) arbitrate when Go, TS, and Python disagree.

## Install

Distribution is **GitHub Releases only.** The npm registry is not used; AppTheory does not publish to it. Consumers pin a release-asset tarball downloaded from the [releases page](https://github.com/theory-cloud/AppTheory/releases):

```bash
# After downloading the .tgz asset from the GitHub Release
npm i ./theory-cloud-apptheory-X.Y.Z.tgz
```

The package is ESM and ships TypeScript declarations. Node.js 24+ is required.

## Module layout

| Import path | Purpose |
| --- | --- |
| `@theory-cloud/apptheory` | All public TypeScript runtime exports: `createApp`, `Context`, request/response helpers, event builders, testkit helpers, jobs-ledger primitives, rate limiter classes, logging profiles, and sanitization helpers. |

The package exports only the root import path above; there are no documented TypeScript subpath exports for MCP, OAuth, jobs, or rate limiting. See `api-snapshots/ts.txt` for the exact exported surface — that file is the release gate.

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
import { createApp } from "@theory-cloud/apptheory";

const app = createApp({ tier: "p0" });
```

TypeScript tiers are string literals: `"p0"`, `"p1"`, or `"p2"`.

See [HTTP Runtime](../features/http-runtime.md) for what each tier includes.

## Deterministic tests

```ts
import {
  buildAPIGatewayV2Request,
  createTestEnv,
  text,
} from "@theory-cloud/apptheory";

test("ping", async () => {
  const env = createTestEnv({ now: new Date("2026-01-01T00:00:00Z") });
  env.ids.queue("req-1");

  const app = env.app();
  app.get("/ping", () => text(200, "pong"));

  const event = buildAPIGatewayV2Request("GET", "/ping");
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
import {
  createApp,
  createLambdaFunctionURLStreamingHandler,
  htmlStream,
} from "@theory-cloud/apptheory";

const app = createApp();
app.get("/stream", () => htmlStream(200, ["<!doctype html>"]));

export const handler = createLambdaFunctionURLStreamingHandler(app);
```

Use this when latency-to-first-byte matters more than buffered responses; the standard `handleLambda` export does not stream.

## CDK constructs (jsii)

CDK constructs live in the separate `@theory-cloud/apptheory-cdk` package (jsii). The TS source under `cdk/lib/` is the canonical implementation; Go bindings under `cdk-go/` are generated.

See [CDK Getting Started](../cdk/getting-started.md).

## What's verified

The TypeScript runtime passes all 147 contract fixtures on every commit, against the same fixture corpus as Go and Python. The `ts/dist/` build output is checked in and gated by `make rubric`.

## Next reads

- [API Reference](../api-reference.md)
- [HTTP Runtime tiers](../features/http-runtime.md)
- [MCP Method Surface](../integrations/mcp.md) — Go runtime MCP surface
- [Contract Fixtures](../reference/contract-fixtures.md)
