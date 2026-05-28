---
title: Go Runtime
description: The Go implementation of the AppTheory contract — routing, middleware, MCP, AppSync, and event workloads.
---

# Go Runtime

The Go runtime is the most complete implementation of the AppTheory contract and ships with the broadest middleware and CDK surface. It is **a reference implementation, not the source of truth** — the [128 contract fixtures](../reference/contract-fixtures.md) arbitrate when the three runtimes disagree.

## Install

The Go toolchain resolves modules from the immutable git tag — no registry is involved beyond Go's standard proxy.

```bash
go get github.com/theory-cloud/apptheory@vX.Y.Z
```

Pin a specific release tag from the [releases page](https://github.com/theory-cloud/AppTheory/releases). AppTheory does not publish to the npm or PyPI registries; the Go module is the only language artifact that ships through Go's normal toolchain path.

Module layout (see `api-snapshots/go.txt` for the exact exported surface):

| Package | Purpose |
| --- | --- |
| `github.com/theory-cloud/apptheory/runtime` | Core runtime: `apptheory.New`, `Context`, `Request`, `Response`, route registration, middleware. |
| `github.com/theory-cloud/apptheory/runtime/mcp` | MCP Streamable HTTP transport, sessions, resumable SSE. |
| `github.com/theory-cloud/apptheory/runtime/oauth` | OAuth protected-resource metadata, PKCE, DCR, token-store helpers. |
| `github.com/theory-cloud/apptheory/testkit` | Deterministic test environment (clock, ID queue, event builders). |
| `github.com/theory-cloud/apptheory/testkit/mcp` | In-process MCP client for unit tests. |
| `github.com/theory-cloud/apptheory/pkg/limited` | DynamoDB-backed cross-instance rate limiter. |
| `github.com/theory-cloud/apptheory/pkg/jobs` | Jobs-ledger primitives. |
| `github.com/theory-cloud/apptheory/pkg/sanitization` | Safe logging helpers. |

## Minimal app

```go
package main

import (
    "context"
    "encoding/json"

    "github.com/aws/aws-lambda-go/lambda"
    apptheory "github.com/theory-cloud/apptheory/runtime"
)

func main() {
    app := apptheory.New()

    app.Get("/ping", func(ctx *apptheory.Context) (*apptheory.Response, error) {
        return apptheory.Text(200, "pong"), nil
    })

    lambda.Start(func(ctx context.Context, event json.RawMessage) (any, error) {
        return app.HandleLambda(ctx, event)
    })
}
```

`HandleLambda` is the **only** entrypoint you need for any AWS trigger. It detects the event shape and dispatches to the right adapter — see [Event Shape Dispatch](../reference/event-shapes.md) for the full table.

## Tier selection

The default tier is **P2**. To opt down:

```go
app := apptheory.New(apptheory.WithTier(apptheory.TierP0))
```

See [HTTP Runtime](../features/http-runtime.md) for what each tier includes.

## Deterministic tests

The Go testkit fixes time, request IDs, and AWS event shapes so handler tests do not depend on AWS:

```go
func TestHello(t *testing.T) {
    env := testkit.NewWithTime(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
    env.IDs.Queue("req-1")

    app := env.App()
    app.Get("/hello", func(ctx *apptheory.Context) (*apptheory.Response, error) {
        return apptheory.MustJSON(200, map[string]any{
            "now_unix": ctx.Now().Unix(),
            "id":       ctx.NewID(),
        }), nil
    })

    event := testkit.APIGatewayV2Request("GET", "/hello", testkit.HTTPEventOptions{
        Headers: map[string]string{"x-request-id": "request-1"},
    })
    resp := env.InvokeAPIGatewayV2(context.Background(), app, event)

    if resp.StatusCode != 200 {
        t.Fatalf("expected 200, got %d", resp.StatusCode)
    }
}
```

`env.IDs.Queue(...)` pre-fills the ID generator so any `ctx.NewID()` call returns the queued value in order — handler tests stay deterministic across rerolls.

## Strict routes

Default route registration is compatibility-oriented and may silently ignore invalid patterns. In tests and CI, prefer the strict variants:

```go
if _, err := app.GetStrict("/users/{id}", h); err != nil {
    t.Fatal(err)
}
```

Go strict helpers return `(*App, error)` on invalid patterns at registration time so a bad route fails the build instead of silently 404-ing in production. TypeScript strict helpers throw and Python strict helpers raise.

## HTTP error format

Default HTTP error envelopes are nested under `error`. To match Lift's flat shape:

```go
app := apptheory.New(apptheory.WithHTTPErrorFormat(apptheory.HTTPErrorFormatFlatLegacy))
// or
app := apptheory.New(apptheory.WithLegacyHTTPErrorShape())
```

This setting **applies to HTTP only.** AppSync and WebSocket error payloads keep their existing shapes regardless.

## MCP runtime

```go
import (
    "context"
    "encoding/json"

    apptheory "github.com/theory-cloud/apptheory/runtime"
    "github.com/theory-cloud/apptheory/runtime/mcp"
)

srv := mcp.NewServer("example", "1.0.0")

_ = srv.Registry().RegisterTool(mcp.ToolDef{
    Name:        "echo",
    Description: "Echo back the provided message.",
    InputSchema: json.RawMessage(`{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}`),
}, func(ctx context.Context, args json.RawMessage) (*mcp.ToolResult, error) {
    var in struct{ Message string `json:"message"` }
    if err := json.Unmarshal(args, &in); err != nil {
        return nil, err
    }
    content := []mcp.ContentBlock{
        {Type: "text", Text: in.Message},
    }
    return &mcp.ToolResult{Content: content}, nil
})

app := apptheory.New()
h := srv.Handler()
app.Post("/mcp", h)
app.Get("/mcp", h)
app.Delete("/mcp", h)
```

See the [MCP Method Surface](../integrations/mcp.md) for the full Streamable HTTP contract, and [Remote MCP](../integrations/remote-mcp.md) for OAuth-protected deployments.

## What's verified

The Go runtime passes all 128 contract fixtures on every commit. Any behavioral divergence between Go, TypeScript, and Python is treated as a contract bug — fix the implementation, or update the fixture and prove the change holds in all three runtimes.

## Next reads

- [API Reference](../api-reference.md) — full surface table
- [HTTP Runtime tiers](../features/http-runtime.md) — P0 / P1 / P2
- [Event Shape Dispatch](../reference/event-shapes.md) — when `HandleLambda` calls what
- [Contract Fixtures](../reference/contract-fixtures.md) — the 128-fixture covenant
