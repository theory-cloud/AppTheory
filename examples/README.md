# Examples

Deployable examples and templates (CDK, etc).

## Index

- `examples/cdk/hello-world` — minimal deployable AppTheory HTTP API in Go, TypeScript, and Python.
- `examples/cdk/multilang` — CDK demo deploying the same app in Go/Node/Python.
- `examples/cdk/kinesis-cloudwatch-logs` — CDK demo for CloudWatch Logs → Kinesis → AppTheory Lambda.
- `examples/cdk/microvm-controller` — deployable CDK demo for Lambda MicroVM image, endpoint-dispatched Go/TypeScript/Python workloads, protected controller invoke routes, and TableTheory-shaped session registry.
- `examples/cdk/s3-vectors-semantic-search` — deployable CDK demo for S3 Vectors semantic recall with Bedrock Titan embeddings.
- `examples/migration/rate-limited-http` — Lift `limited` → AppTheory `pkg/limited` migration example (Go + TableTheory).
- `examples/mcp/tools-only` — Minimal Streamable HTTP MCP server (tools only).
- `examples/mcp/tools-only-ts` — Minimal Streamable HTTP MCP server using the TypeScript runtime and MCP testkit.
- `examples/mcp/tools-only-py` — Minimal Streamable HTTP MCP server using the Python runtime and MCP testkit.
- `examples/mcp/tools-resources-prompts` — MCP server exposing tools + resources + prompts.
- `examples/mcp/resumable-sse` — Streaming tool call with disconnect + resume via `Last-Event-ID`.
- `examples/testkit` — no-AWS testkit examples (TypeScript + Python).
