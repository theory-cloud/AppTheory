# AppTheory — Multi-language Serverless Application Framework (Go, TypeScript, Python)

AppTheory is a TableTheory-style multi-language monorepo for building serverless applications with a **shared runtime
contract** and **cross-language drift prevention**.

Distribution: **GitHub Releases only** (no npm/PyPI publishing).

## Charter (M0)

AppTheory exists to provide a **portable runtime core** (and contract tests) for AWS serverless applications that must be
first-class in **Go, TypeScript, and Python**.

Target audiences and use cases:

- Platform and application teams building HTTP APIs on AWS Lambda (Lambda Function URL, API Gateway v2).
- Event-driven workloads (SQS, EventBridge, etc.) once fixture-backed by contract tests.
- Internal tooling and shared libraries that need consistent request/response semantics across languages.

Non-goals (near-term):

- Not a general-purpose web framework; contract-first serverless runtime only.
- Not registry-published packages (no npm or PyPI); releases ship via GitHub assets.

## Public Names (M0)

- Go module path: `github.com/theory-cloud/apptheory`
- npm package: `@theory-cloud/apptheory`
- Python distribution name: `apptheory`
- Python import name: `apptheory`

## Supported Runtimes (M0)

- Go toolchain: `1.25.6`
- Node.js: `24`
- Python: `3.14`

## Go runtime (P0)

The Go runtime implements the fixture-backed P0 contract (routing + request/response normalization + error envelope).

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

	event := testkit.APIGatewayV2Request("GET", "/hello", testkit.HTTPEventOptions{})
	resp := env.InvokeAPIGatewayV2(context.Background(), app, event)

	if resp.StatusCode != 200 {
		t.Fatalf("expected status 200, got %d", resp.StatusCode)
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

Start here:

- Planning index: `docs/development/planning/apptheory/README.md`
- Main roadmap: `docs/development/planning/apptheory/apptheory-multilang-roadmap.md`

Migration:

- Lift → AppTheory (draft): `docs/migration/from-lift.md`

License:

- Apache 2.0 (see `LICENSE`)
