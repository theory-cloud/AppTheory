<!-- AI Training: Root README for the AppTheory multi-language monorepo -->

<p align="center">
  <a href="https://theory-cloud.github.io/apptheory/">
    <img src="docs/assets/svg/icon.svg" width="84" alt="AppTheory">
  </a>
</p>

<h1 align="center">AppTheory</h1>

<p align="center">
  <strong>Contract-first serverless runtime for AWS Lambda.</strong><br>
  One application model. Three runtimes. Verified on every commit.
</p>

<p align="center">
  <a href="https://github.com/theory-cloud/AppTheory/releases"><img alt="Release" src="https://img.shields.io/github/v/release/theory-cloud/AppTheory?style=flat-square&label=release&color=2EA7FF"></a>
  <a href="https://github.com/theory-cloud/AppTheory/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-7A5CFF?style=flat-square"></a>
  <a href="https://theory-cloud.github.io/apptheory/"><img alt="Docs" src="https://img.shields.io/badge/docs-theory--cloud.github.io%2Fapptheory-2EA7FF?style=flat-square"></a>
  <a href="https://github.com/theory-cloud/AppTheory/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/theory-cloud/AppTheory/ci.yml?branch=main&style=flat-square&label=rubric&color=46D397"></a>
</p>

<p align="center">
  <img alt="Go"         src="https://img.shields.io/badge/Go-1.26-2EA7FF?style=flat-square&logo=go&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-Node%2024-7A5CFF?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Python"     src="https://img.shields.io/badge/Python-3.14-C9A96B?style=flat-square&logo=python&logoColor=white">
</p>

<p align="center">
  <a href="https://theory-cloud.github.io/apptheory/getting-started/"><strong>Get started →</strong></a> ·
  <a href="https://theory-cloud.github.io/apptheory/api-reference/">API reference</a> ·
  <a href="https://theory-cloud.github.io/apptheory/reference/contract-fixtures/">Contract fixtures</a> ·
  <a href="https://theory-cloud.github.io/apptheory/integrations/mcp/">MCP runtime</a>
</p>

---

AppTheory is a **contract-first serverless runtime for AWS Lambda** designed to keep request handling, middleware, and event normalization consistent across languages and reliable in generative coding workflows (humans + AI assistants). It ships peer implementations in Go, TypeScript, and Python — not a Go library with bindings, but three independent runtimes that pass the same contract fixtures on every commit.

```
            FaceTheory (client delivery)
                      │
      AppTheory (serverless runtime)  ← you are here
                      │
            TableTheory (data layer)
                      │
                  DynamoDB
```

AppTheory is the runtime layer of the [Theory Cloud](THEORY_CLOUD.md) stack — used in production by [Pay Theory](https://paytheory.com).

## Install

AppTheory is distributed exclusively through immutable **[GitHub Releases](https://github.com/theory-cloud/AppTheory/releases)** — no PyPI, no npm. The single distribution path keeps versions aligned across all three runtimes.

| Runtime | Install |
|---|---|
| **Go** | `go get github.com/theory-cloud/apptheory@vX.Y.Z` |
| **TypeScript** | install the `.tgz` release asset — see [TypeScript getting started](https://theory-cloud.github.io/apptheory/runtimes/typescript/) |
| **Python** | install the `.whl` release asset — see [Python getting started](https://theory-cloud.github.io/apptheory/runtimes/python/) |

## At a glance

| | |
|---|---|
| **Contract test fixtures** | 128 — routing, normalization, error envelope, event dispatch, MCP, jobs ledger |
| **Runtimes** | Go · TypeScript · Python (peers, not ports) |
| **Tiers** | P0 (core) · P1 (+request-id, auth, CORS, guardrails) · P2 (+observability, rate limiting) — default P2 |
| **Event sources** | Lambda Function URL · API Gateway v2 · ALB · AppSync · SQS · EventBridge · DynamoDB Streams · Kinesis · WebSockets |
| **Distribution** | Immutable GitHub Releases — version-aligned across all runtimes |
| **License** | Apache-2.0 — open source, production use |
| **Status** | Pre-1.0, runtime contract stable across Go · TS · Python |

## Why AppTheory?

Use AppTheory when you want AWS-Lambda-backed services that are:

- **Serverless-first** — one unified `HandleLambda` entrypoint dispatches Lambda Function URL, API Gateway v2, ALB, AppSync, SQS, EventBridge, DynamoDB Streams, Kinesis, and WebSockets. The same handler shape covers every event source.
- **Cross-language consistent** — one routing model, one middleware order, one error envelope — across three runtimes — without behavioral drift. Verified on every commit by the [128 contract fixtures](https://theory-cloud.github.io/apptheory/reference/contract-fixtures/).
- **Generative-coding friendly** — explicit tiers, canonical patterns, and strict verification so AI-generated code stays correct and maintainable.

✅ Treat routing, middleware, and event normalization as a contract
❌ Don't reinvent "the same" middleware chain independently per service/language

## MCP server runtime

AppTheory includes a complete [Model Context Protocol](https://modelcontextprotocol.io) production stack: Streamable HTTP transport, session management, OAuth protected resources, resumable SSE streaming, and CDK deployment constructs. The MCP runtime is a **first-class part of the contract**, not an experimental add-on — `theory-mcp-server` itself runs on it.

- [MCP integration guide](https://theory-cloud.github.io/apptheory/integrations/mcp/) — transport, JSON-RPC surface, registries, sessions, streaming
- [Remote MCP deployment](https://theory-cloud.github.io/apptheory/integrations/remote-mcp/) — OAuth, protected resource metadata, Autheory integration
- [MCP examples](examples/mcp/) — `tools-only`, `tools-resources-prompts`, `resumable-sse`
- CDK constructs: `AppTheoryMcpServer`, `AppTheoryRemoteMcpServer`, `AppTheoryMcpProtectedResource`

## Documentation

The full documentation site lives at **[theory-cloud.github.io/apptheory](https://theory-cloud.github.io/apptheory/)** — branded with the Theory Cloud design system, with a ⌘K search palette, runtime tabs, and surface-tinted pages.

**Most-used entry points:**

| Section | Link |
|---|---|
| Getting started | [theory-cloud.github.io/apptheory/getting-started/](https://theory-cloud.github.io/apptheory/getting-started/) |
| API reference | [theory-cloud.github.io/apptheory/api-reference/](https://theory-cloud.github.io/apptheory/api-reference/) |
| HTTP runtime tiers | [theory-cloud.github.io/apptheory/features/http-runtime/](https://theory-cloud.github.io/apptheory/features/http-runtime/) |
| Event workloads | [theory-cloud.github.io/apptheory/features/event-workloads/](https://theory-cloud.github.io/apptheory/features/event-workloads/) |
| Logging profiles | [theory-cloud.github.io/apptheory/features/logging-profiles/](https://theory-cloud.github.io/apptheory/features/logging-profiles/) |
| Source provenance | [theory-cloud.github.io/apptheory/features/source-provenance/](https://theory-cloud.github.io/apptheory/features/source-provenance/) |
| Migration from Lift | [theory-cloud.github.io/apptheory/migration/from-lift/](https://theory-cloud.github.io/apptheory/migration/from-lift/) |

**Per-runtime entry points:**

- **Go** — [theory-cloud.github.io/apptheory/runtimes/go/](https://theory-cloud.github.io/apptheory/runtimes/go/)
- **TypeScript** — [theory-cloud.github.io/apptheory/runtimes/typescript/](https://theory-cloud.github.io/apptheory/runtimes/typescript/)
- **Python** — [theory-cloud.github.io/apptheory/runtimes/python/](https://theory-cloud.github.io/apptheory/runtimes/python/)

**Contract reference and feature pages:**

- [Contract Fixtures](https://theory-cloud.github.io/apptheory/reference/contract-fixtures/) — the 128-fixture covenant every runtime is tested against
- [Event Shape Dispatch](https://theory-cloud.github.io/apptheory/reference/event-shapes/) — which Lambda event shapes route to which handler
- [HTTP Runtime](https://theory-cloud.github.io/apptheory/features/http-runtime/) — P0/P1/P2 tier surface
- [Jobs Ledger](https://theory-cloud.github.io/apptheory/features/jobs-ledger/)
- [Sanitization](https://theory-cloud.github.io/apptheory/features/sanitization/)

**Integrations** — how AppTheory connects to the rest of the stack:

- [MCP Method Surface](https://theory-cloud.github.io/apptheory/integrations/mcp/)
- [Remote MCP](https://theory-cloud.github.io/apptheory/integrations/remote-mcp/)
- [Remote MCP + Autheory](https://theory-cloud.github.io/apptheory/integrations/remote-mcp-autheory/)
- [Bedrock AgentCore MCP](https://theory-cloud.github.io/apptheory/integrations/agentcore-mcp/)

**CDK** — the blessed deployment surface:

- [CDK Getting Started](https://theory-cloud.github.io/apptheory/cdk/getting-started/)
- [CDK API Reference](https://theory-cloud.github.io/apptheory/cdk/api-reference/)
- [SSR Site (FaceTheory-first)](https://theory-cloud.github.io/apptheory/cdk/ssr-site/)

## Repository layout

| Path | What |
|---|---|
| `docs/` | Public documentation site (Jekyll) — also the canonical doc tree |
| `runtime/` | Go runtime — fixture-backed contract implementation (default P2) |
| `ts/` | TypeScript runtime (ESM, Node.js 24) |
| `py/` | Python runtime (3.14+) |
| `cdk/` | CDK constructs (jsii) — `AppTheoryHttpApi`, `AppTheoryMcpServer`, `AppTheoryQueue`, ... |
| `cdk-go/` | Generated Go bindings for the jsii CDK package |
| `contract-tests/` | Cross-language contract fixtures (128) + runners for Go, TS, Python |
| `api-snapshots/` | Public API surface lockfiles for each runtime — the release gate |
| `examples/` | CDK + handler examples: `multilang`, `import-pipeline`, `ssr-site`, MCP, ... |
| `.github/workflows/` | CI: rubric, release-please (stable + prerelease), Pages publish, subtree publish |

## Universal Lambda dispatcher (CDK)

The CDK multilang demo deploys one HTTP entry + three Lambda runtimes (Go, Node.js 24, Python 3.14) that route the same request through the same middleware chain and assert identical responses:

→ [`examples/cdk/multilang/`](examples/cdk/multilang/)

For infrastructure patterns, see the [CDK integration guide](https://theory-cloud.github.io/apptheory/cdk/getting-started/).

## Runtime tiers

AppTheory's middleware surface is tiered, not flag-based. Each tier is additive over the previous one.

| Tier | Surface |
|---|---|
| **P0** | Routing + request/response normalization + error envelope |
| **P1** | P0 + request-id, tenant extraction, auth hooks, CORS, size/time guardrails, middleware ordering |
| **P2** *(default)* | P1 + observability hooks, rate limiting / load-shedding policy hooks |

Tiers are a **contract**, not a menu — see [HTTP Runtime](https://theory-cloud.github.io/apptheory/features/http-runtime/) for the exact slot list and per-tier behavior.

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

    // One entrypoint handles HTTP, AppSync, SQS, EventBridge,
    // DynamoDB Streams, Kinesis, and WebSockets.
    lambda.Start(func(ctx context.Context, event json.RawMessage) (any, error) {
        return app.HandleLambda(ctx, event)
    })
}
```

```ts
import { createApp, text } from "@theory-cloud/apptheory";

const app = createApp();
app.get("/ping", () => text(200, "pong"));

export const handler = async (event: unknown, ctx: unknown) =>
  app.handleLambda(event, ctx);
```

```python
from apptheory import create_app, text

app = create_app()

@app.get("/ping")
def ping(ctx):
    return text(200, "pong")

def handler(event, ctx):
    return app.handle_lambda(event, ctx)
```

The same contract fixtures verify all three.

## Development & verification

```bash
make rubric        # full repo verification (the all-gates gate)
make test          # full test suite incl. contract fixtures
```

For multi-language work:

```bash
cd ts && npm run lint && npm run typecheck && npm test
uv --directory py run pytest -q
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for full contributor docs, including the [Authoring documentation](CONTRIBUTING.md#authoring-documentation) section if you're updating the docs site.

## Security & production notes

- CSRF protection and secure cookie flags are application concerns; set `Secure`/`HttpOnly`/`SameSite` explicitly in `Set-Cookie`.
- Request IDs can be supplied via `x-request-id`; validate/override if your threat model requires it.
- Retries/backoff for event sources are handled by AWS trigger settings (retry policies, DLQs/redrive), not by the runtime.
- Distribution is **GitHub Releases only** — there is no npm publish, no PyPI publish, and no raw-SDK escape hatch.

## Theory Cloud

AppTheory is the runtime layer of the Theory Cloud stack. It depends on [TableTheory](https://github.com/theory-cloud/TableTheory) for data access, and is depended on by [FaceTheory](https://github.com/theory-cloud/FaceTheory) for client delivery.

- [TableTheory](https://github.com/theory-cloud/TableTheory) (data layer) → AppTheory builds on it
- [FaceTheory](https://github.com/theory-cloud/FaceTheory) (client delivery) → depends on AppTheory
- KnowledgeTheory (platform state + knowledge graph) → depends on AppTheory
- Autheory (identity) → depends on AppTheory
- theory-mcp-server → runs on AppTheory

The single-path philosophy applies here: one way to register a route, one way to order middleware, one way to dispatch a Lambda event — enforced by the framework, not by convention. When generative coding tools produce AppTheory code, the constrained API surface means the output converges on correct implementations instead of drifting across equivalent-but-incompatible patterns.

## License & contributing

- [LICENSE](LICENSE) — Apache-2.0
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CHANGELOG.md](CHANGELOG.md)
- [THEORY_CLOUD.md](THEORY_CLOUD.md)

<p align="center"><sub>Made with <a href="https://github.com/theory-cloud">Theory Cloud</a> · <a href="https://theory-cloud.github.io/apptheory/">docs</a></sub></p>
