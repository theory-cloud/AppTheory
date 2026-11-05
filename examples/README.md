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
| `examples/mcp/resumable-sse` | Streaming MCP tool call with disconnect and `Last-Event-ID` resume (Go) | L2; the warm session, incremental chunk delivery, event ids and replay are asserted |
| `examples/migration/rate-limited-http` | Lift `limited` → AppTheory `pkg/limited`: a real `net/http` server on DynamoDB Local with the allowed burst and the 429 refusal | L1 |
| `examples/cdk/hello-world` | Minimal deployable HTTP API in Go, TypeScript and Python | I for the CDK app; handlers L1 through the local runner |
| `examples/cdk/multilang` | The same app in Go/Node/Python across HTTP, REST, WebSocket, SQS, Streams and EventBridge | I for the CDK app; handlers L3 (the WebSocket authorizer is L1; IAM policy evaluation is the named gap; HTTP, REST, WebSocket and the event sources run) |
| `examples/cdk/import-pipeline` | S3 → SQS → worker import pipeline | I for the CDK app; handlers L3 (CodeBuild (R8) is the named gap; the bucket's EventBridge notification is delivered by the runner from a real object PUT, and the WorkConsumer SQS mapping delivers automatically on ElasticMQ) |
| `examples/cdk/kinesis-cloudwatch-logs` | CloudWatch Logs → Kinesis → Lambda | I for the CDK app; handlers L2 (moto emulates Kinesis and CloudWatch Logs: sequence numbers are opaque and a stream never splits or merges; the subscription filter, the Kinesis mapping, partial failure and the function-log capture are real; IAM policy evaluation is a docs/125 true limit) |
| `examples/cdk/lambda-role` | `AppTheoryLambdaRole` patterns: basic, X-Ray, encrypted KMS, custom and dynamic permissions | I for the CDK app; compiled handlers L1/L2 (moto KMS, s3proxy S3; SSM parameters, Secrets Manager secrets and the Cognito user pool are real on moto) |
| `examples/cdk/lesser-parity` | Parallelism with Lesser: HTTP, GraphQL, SSE and worker handlers | I for the CDK app; handlers L1/L2 (the SSE route streams incrementally; the worker consumes the CDK SQS mapping) |
| `examples/cdk/media-cdn` | `AppTheoryMediaCdn`: public and signed-URL private media delivery | L2 through the gateway; the public distribution serves from s3proxy and the private distribution verifies signed URLs and cookies against the key group's real public keys (CloudFront edge network and edge TLS are the named gap) |
| `examples/cdk/microvm-controller` | Lambda MicroVM image, endpoint-dispatched Go/TS/Python workloads and a TableTheory session registry | I for the CDK app; controller L3 and workloads L1, with the managed provider as the named gap |
| `examples/cdk/path-routed-frontend` | Multi-SPA CloudFront routing with generated rewrite functions | L3 through the gateway; the generated rewrite runs, probe objects are written through the runner because the example ships no SPA build output, and the external API origin is mapped with `--origin` to a loopback listener (the CloudFront edge network is the named gap) |
| `examples/cdk/restv1-router` | REST API v1 multi-Lambda routing with SSE streaming and stage controls | I for the CDK app; handlers L1/L2 (the SSE route streams incrementally) |
| `examples/cdk/s3-vectors-semantic-search` | S3 Vectors semantic recall with Bedrock Titan embeddings | I for the CDK app; handler L3 with managed S3 Vectors/Bedrock as the named gap |
| `examples/cdk/sqs-queue` | Queue, DLQ, consumer and processor constructs | I for the CDK app; handlers L2 (ElasticMQ emulates SQS; IAM, KMS encryption and AWS-managed scaling are not emulated) |
| `examples/cdk/ssr-site` | SSR site with a streaming Function URL | L2 through the gateway; origin-group failover, the real SSR handler streamed incrementally through the gateway and directly on the Function URL, with the CloudFront edge network as the gap; `scripts/upload-assets.sh` is L3 (IAM policy evaluation and s3proxy bucket policies) |
| `examples/cdk/ssr-only-provided-assets-site` | SSR site with caller-provided assets | L2 through the gateway; the AWS_IAM Function URL is reached with local OAC signing |
| `examples/cdk/codebuild-job-runner` | `AppTheoryCodeBuildJobRunner`: inline buildspec, state-change rule and grants | I |
| `examples/microvm-conformance` | Static conformance fixtures (no runtime entrypoint) | L3 via `scripts/verify-microvm-conformance-harness.sh`; the managed MicroVM provider is the named gap (dry-run and leak-scan pass, and the live conformance run stops at the provider boundary) |
