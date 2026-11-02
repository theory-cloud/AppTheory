# Examples

Runnable examples and deployable CDK templates.

## Run them locally

```bash
make examples-local        # every classified example, against DynamoDB Local
make examples-local-down   # stop this checkout's profile container
```

`make examples-local` enumerates the tree, runs each classified row against the
checked-in local profile (`scripts/local/docker-compose.yml`), and fails on a
skip. It never contacts AWS: the harness sets dummy credentials and endpoint
overrides, and its preflight refuses to start when a DynamoDB client would
resolve anywhere else. The classification manifest is
`scripts/local/examples-local.json`; the full contract, including the class
definitions and named gaps, is [docs/examples/local-harness.md](../docs/examples/local-harness.md).

Classes:

- **L1** — runs fully locally, no cloud dependency.
- **L2** — runs locally against an emulator; fidelity limits are documented.
- **L3** — exercised as fully as possible locally, with a named cloud gap that
  is never faked.
- **I** — infrastructure-only: synthesized and asserted, no runtime process
  (yet). Handler rows owned by a later milestone are listed as
  `PENDING-MILESTONE` and never counted as pass.

## Index and local class

| Example | What it shows | Local class |
| --- | --- | --- |
| `examples/testkit` | Testkit-driven HTTP API v2, EventBridge and DynamoDB Stream handling, plus Function URL streaming (TS and Python) | L1 |
| `examples/mcp/tools-only` | Minimal Streamable HTTP MCP server, tools only (Go) | L1 |
| `examples/mcp/tools-only-ts` | Minimal Streamable HTTP MCP server using the TypeScript runtime and MCP testkit | L1 |
| `examples/mcp/tools-only-py` | Minimal Streamable HTTP MCP server using the Python runtime and MCP testkit | L1 |
| `examples/mcp/tools-resources-prompts` | MCP server exposing tools, resources and prompts (Go) | L1 |
| `examples/mcp/resumable-sse` | Streaming MCP tool call with disconnect and `Last-Event-ID` resume (Go) | L3; the RIE buffers delivery, while the warm session, event ids and replay are asserted |
| `examples/migration/rate-limited-http` | Lift `limited` → AppTheory `pkg/limited`: a real `net/http` server on DynamoDB Local with the allowed burst and the 429 refusal | L1 |
| `examples/cdk/hello-world` | Minimal deployable HTTP API in Go, TypeScript and Python | I for the CDK app; handlers L1 through the local runner |
| `examples/cdk/multilang` | The same app in Go/Node/Python across HTTP, REST, WebSocket, SQS, Streams and EventBridge | I for the CDK app; handlers L3 (HTTP and REST run, WebSocket and event sources are the named gap) |
| `examples/cdk/import-pipeline` | S3 → SQS → worker import pipeline | I for the CDK app; handlers L3 (S3 → EventBridge and CodeBuild are the named gap) |
| `examples/cdk/kinesis-cloudwatch-logs` | CloudWatch Logs → Kinesis → Lambda | I for the CDK app; handler L3 (managed Kinesis/CloudWatch Logs delivery is the gap) |
| `examples/cdk/lambda-role` | `AppTheoryLambdaRole` patterns: basic, X-Ray, encrypted KMS, custom and dynamic permissions | I for the CDK app; compiled handlers L1/L2/L3 (moto KMS, s3proxy S3, SSM gap) |
| `examples/cdk/lesser-parity` | Parallelism with Lesser: HTTP, GraphQL, SSE and worker handlers | I for the CDK app; handlers L1/L3 (SSE buffered; worker uses a generated SQS batch) |
| `examples/cdk/media-cdn` | `AppTheoryMediaCdn`: public and signed-URL private media delivery | L3 through the gateway; the public distribution serves from s3proxy and the private signed-URL distribution stays refused |
| `examples/cdk/microvm-controller` | Lambda MicroVM image, endpoint-dispatched Go/TS/Python workloads and a TableTheory session registry | I for the CDK app; controller L3 and workloads L1, with the managed provider as the named gap |
| `examples/cdk/path-routed-frontend` | Multi-SPA CloudFront routing with generated rewrite functions | L3 through the gateway; the generated rewrite runs and the external API origin is refused by name |
| `examples/cdk/restv1-router` | REST API v1 multi-Lambda routing with SSE streaming and stage controls | I for the CDK app; handlers L1/L3 (SSE is buffered under the RIE) |
| `examples/cdk/s3-vectors-semantic-search` | S3 Vectors semantic recall with Bedrock Titan embeddings | I for the CDK app; handler L3 with managed S3 Vectors/Bedrock as the named gap |
| `examples/cdk/sqs-queue` | Queue, DLQ, consumer and processor constructs | I for the CDK app; handlers L3 (managed SQS event-source mapping is the gap) |
| `examples/cdk/ssr-site` | SSR site with a streaming Function URL | L2 through the gateway; origin-group failover and the real SSR handler, with CloudFront caching/edge and buffered streaming as the gap |
| `examples/cdk/ssr-only-provided-assets-site` | SSR site with caller-provided assets | L2 through the gateway; the AWS_IAM Function URL is reached with local OAC signing |
| `examples/cdk/codebuild-job-runner` | `AppTheoryCodeBuildJobRunner`: inline buildspec, state-change rule and grants | I |
| `examples/microvm-conformance` | Static conformance fixtures (no runtime entrypoint) | covered by `scripts/verify-microvm-conformance-harness.sh` |
