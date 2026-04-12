# AppTheory — Serverless Application Framework for AWS (Go, TypeScript, Python)

AppTheory is a contract-first serverless runtime for AWS Lambda. It provides a single application model across Go,
TypeScript, and Python — with behavioral parity enforced by 89 shared contract test fixtures, not convention.

AI code generation and multi-team environments produce drift: the same endpoint implemented in two languages behaves
differently in subtle ways. AppTheory eliminates this by constraining each language runtime to one correct path for
routing, middleware, error handling, and event normalization. The result is deterministic framework behavior that
generative coding tools can rely on.

AppTheory is part of the [Theory Cloud](THEORY_CLOUD.md) stack. [TableTheory](https://github.com/theory-cloud/TableTheory)
provides the data layer; AppTheory provides the runtime and CDK deployment constructs;
[FaceTheory](https://github.com/theory-cloud/FaceTheory) provides client application delivery.

## MCP Server Runtime

AppTheory includes a complete [Model Context Protocol](https://modelcontextprotocol.io) production stack: Streamable
HTTP transport, session management, OAuth protected resources, SSE streaming, and CDK deployment constructs.

- [MCP integration guide](docs/integrations/mcp.md) — transport, JSON-RPC surface, registries, sessions, streaming
- [Remote MCP deployment](docs/integrations/remote-mcp.md) — OAuth, protected resource metadata, Autheory integration
- [MCP examples](examples/mcp/) — tools-only, tools-resources-prompts, resumable-sse
- CDK constructs: `AppTheoryMcpServer`, `AppTheoryRemoteMcpServer`, `AppTheoryMcpProtectedResource`

## Status

AppTheory is pre-1.0 and under active development. The runtime contract is stable across Go, TypeScript, and Python,
verified by 89 contract test fixtures on every commit. Production systems at [Pay Theory](https://paytheory.com) run on
AppTheory today. See [CHANGELOG](CHANGELOG.md) for release history.

## Getting Started

- [Getting started guide](docs/getting-started.md) — local workspace, deterministic app path in each runtime, deployment
- [API reference](docs/api-reference.md) — full Go runtime surface
- [TypeScript docs](ts/docs/README.md) | [Python docs](py/docs/README.md) | [CDK docs](cdk/docs/README.md)

## Charter

AppTheory exists to provide a **portable runtime core** (and contract tests) for AWS serverless applications that must be
first-class in **Go, TypeScript, and Python**.

Target audiences and use cases:

- Platform and application teams building HTTP APIs on AWS Lambda (Lambda Function URL, API Gateway v2).
- Event-driven workloads (SQS, EventBridge, DynamoDB Streams) and WebSockets are required for Lift parity and are tracked
  as remaining contract work (see `docs/development/planning/apptheory/apptheory-gap-analysis-lesser.md`).
- Internal tooling and shared libraries that need consistent request/response semantics across languages.

Non-goals (near-term):

- Not a general-purpose web framework; contract-first serverless runtime only.
- Not registry-published packages (no npm or PyPI); releases ship via GitHub assets.

## Package Names

- Go module path: `github.com/theory-cloud/apptheory`
- Go runtime package: `github.com/theory-cloud/apptheory/runtime`
- npm package: `@theory-cloud/apptheory`
- Python distribution name: `apptheory`
- Python import name: `apptheory`

## Supported Runtimes

- Go toolchain: `1.26.2`
- Node.js: `24`
- Python: `3.14`

Distribution: **GitHub Releases only** (no npm/PyPI publishing).

## Runtime Tiers (P0/P1/P2)

- **P0:** routing + request/response normalization + error envelope
- **P1:** request-id, tenant extraction, auth hooks, CORS, size/time guardrails, middleware ordering
- **P2 (default):** P1 + observability hooks + rate limiting / load shedding policy hooks

## Architecture

```
                          AWS Event Sources
                 ┌──────────┬──────────┬──────────┐
                 │ Lambda   │ API GW   │ AppSync  │
                 │ Func URL │ v2/Proxy │ Resolver │
                 └────┬─────┴────┬─────┴────┬─────┘
                      │          │          │
                      ▼          ▼          ▼
              ┌─────────────────────────────────────┐
              │         HandleLambda (unified)       │
              │    event detection + normalization   │
              └──────────────┬──────────────────────┘
                             │
                             ▼
              ┌────────────────────────���────────────┐
              │          AppTheory Router            │
              │   path matching + method dispatch    │
              └─────────────���┬──────────────────────┘
                             │
                             ▼
              ┌─────────────────────��───────────────┐
              │        Middleware Chain (P0→P2)      │
              │  request-id, auth, CORS, guardrails  │
              │  observability, rate limiting         │
              └──────────────┬──────────────────────┘
                             │
                  ┌──────────┴──────────┐
                  ▼                     ▼
        ┌──────────────────┐  ┌──────────────────┐
        │  HTTP Handler    │  │  MCP Server       │
        │  (your code)     │  │  (Streamable HTTP)│
        └──────────────────┘  └──────────────────┘
                  │                     │
                  ▼                     ▼
              ┌─────────────────────────────────────┐
              │          Response Pipeline           │
              │    error envelope + serialization    │
              └─────────────────────────────────────┘

   ┌─────────────────────────────────────────────────────┐
   │              Contract Test Fixtures (89)             │
   │   Same fixtures run against Go, TS, and Python      │
   │   runtimes to verify behavioral parity              │
   └─────────────────────────────────────────────────────┘

   ┌────────────────────────────────────────────���────────┐
   │              CDK Constructs                          │
   │   AppTheoryHttpApi, AppTheoryMcpServer,             │
   │   AppTheoryRemoteMcpServer, AppTheoryQueue,         │
   │   AppTheoryS3Ingest, AppTheoryJobsTable, ...        │
   └────────────────────────────────────────────���────────┘
```

## Security & Production Notes

- CSRF protection and secure cookie flags are application concerns; set `Secure`/`HttpOnly`/`SameSite` explicitly in `Set-Cookie`.
- Request IDs can be supplied via `x-request-id`; validate/override if your threat model requires it.
- Retries/backoff for event sources are handled by AWS trigger settings (retry policies, DLQs/redrive), not by the runtime.

## Go Runtime (P2 default)

The Go runtime implements the fixture-backed contract across P0/P1/P2 tiers (default: P2).

Notes:

- Header names are case-insensitive, but `Request.Headers` / `Response.Headers` keys are canonicalized to lowercase.
- If two routes are equally specific, the router prefers earlier registration order.

Minimal local invocation:

```go
env := testkit.New()
app := env.App()

app.Get("/ping", func(ctx *apptheory.Context) (*apptheory.Response, error) {
	return apptheory.Text(200, "pong"), nil
})

resp := env.Invoke(context.Background(), app, apptheory.Request{Method: "GET", Path: "/ping"})
_ = resp
```

To force the P0 core (minimal surface area), pass `apptheory.WithTier(apptheory.TierP0)` when creating the app.

Unit test without AWS (deterministic time + IDs + HTTP event builder):

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
		t.Fatalf("expected status 200, got %d", resp.StatusCode)
	}
	if resp.Headers["x-request-id"] != "request-1" {
		t.Fatalf("expected x-request-id request-1, got %#v", resp.Headers["x-request-id"])
	}

	var body map[string]any
	if err := json.Unmarshal([]byte(resp.Body), &body); err != nil {
		t.Fatalf("parse response json: %v", err)
	}
	if body["id"] != "req-1" {
		t.Fatalf("expected id req-1, got %#v", body["id"])
	}
}
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report issues, run tests, and submit pull requests.

## Links

- Planning index: `docs/development/planning/apptheory/README.md`
- Main roadmap: `docs/development/planning/apptheory/apptheory-multilang-roadmap.md`
- Import pipeline reference example (CDK + handlers): `examples/cdk/import-pipeline/`
- Migration from Lift (draft): `docs/migration/from-lift.md`
- [Theory Cloud overview](THEORY_CLOUD.md)

## License

Apache 2.0 (see [LICENSE](LICENSE))
