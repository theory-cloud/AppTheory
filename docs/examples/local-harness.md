---
title: Local examples harness
---

# Local examples harness

`make examples-local` runs every classified AppTheory example against local
backends and asserts each one's real outcome. Nothing reaches AWS: the harness
sets its own endpoint overrides and static dummy credentials, and its preflight
refuses to start when a DynamoDB client would resolve anywhere else.

```bash
make examples-local        # run everything that is classified
make examples-local-down   # stop this checkout's profile container
```

The convention follows TableTheory's merged local harness (TableTheory
`origin/staging` at `8dcf8904`, 2026-11-01): the same DynamoDB Local image pin,
the same endpoint and credential semantics, the same classification manifest,
the same "a skip is a failure" rule, and the same preflight proof of SDK
resolution.

## What the harness owns

| Piece | Where it lives |
| --- | --- |
| DynamoDB Local profile | `scripts/local/docker-compose.yml` — `amazon/dynamodb-local@sha256:…` (3.1.0), loopback, in-memory |
| Classification manifest | `scripts/local/examples-local.json` |
| Harness | `scripts/local/run_examples_local.py` |
| Endpoint-resolution preflight | `scripts/local/cmd/examples-local-preflight` |
| Rate-limit table provisioning | `scripts/local/cmd/rate-limit-table` |
| Built-asset runtime proof | `scripts/local/verify-lambda-assets.py` |
| Lambda runtime image pins | `scripts/local/examples-local.json` (`lambda.images`) |
| Runner emulator pins | `scripts/local/examples-local.json` (`containers.moto`, `containers.s3proxy`, `containers.sqs` and their endpoints) |
| Local runner | `cmd/apptheory-local` with `internal/localrunner`; `session` provides the JSON command channel |
| Self-tests | `scripts/local/test_examples_local.py` |
| Runtime API conformance | `scripts/local/runtime_api_conformance.py` (row `runtime-api-conformance`, L2) |
| CI job | `.github/workflows/examples-local.yml` |

## Requirements

- Docker (on macOS, colima) with the daemon running, for DynamoDB Local, the
  runner's emulator containers and the official Lambda runtime images.
- Node.js 24+ and npm, for the TypeScript examples and each example's CDK CLI.
- An AWS CLI on `PATH` that starts. `upload-assets.sh` runs the real host CLI;
  the harness does not install a fallback, and a missing or unusable CLI fails
  that row with a named requirement error.
- Python 3.14 to run the harness and the repo's Go toolchain for the runner
  rows. Install the harness's Python dependencies once:

  ```bash
  python3 -m pip install -r scripts/local/requirements-examples.txt
  ```

  The field-level encryption row decrypts with the AWS Encryption SDK from that
  file; without it the row fails with a named requirement error. The local-TLS
  rows also need Playwright's Chromium for the browser row:

  ```bash
  python3 -m playwright install chromium
  ```

  Without it the browser row fails with a named requirement error; the other
  local-TLS rows run without a browser.

## Classes

- **L1** — runs fully locally; no cloud dependency.
- **L2** — runs locally with an emulator and a named fidelity limit.
- **L3** — exercised as fully as possible locally, plus a named cloud gap from
  the docs/125 true-limit list.
- **I** — infrastructure-only: the CDK app is synthesized and hash-checked, and
  has no runtime process.

A handler that a CDK definition would connect to a cloud event source is L3
when the harness invokes it with a generated event, because that event source is
the named gap. A handler-only row has no deployment surface to emulate — the
handler is its entire surface — so it is L1 unless a different named gap
applies. `examples/mcp/resumable-sse` is handler-only and L2: it runs fully
locally, and its named fidelity limit is that the local invoke transport
forwards each chunk at the handler's pace instead of Lambda's streaming cap, not
that it lacks an event source. The manifest has no pending row; the validator
still fails closed on a row that declares no class.

Every classified example is verified by a real process, real HTTP behavior or a
real synthesized template. There are no fake apps, fake repositories or mocked
success; unit-test fakes never count as example verification.

## Endpoint and credential semantics

The harness sets this environment for every child process and removes anything
that could redirect it: every inherited `AWS_*` variable (a profile, a session
token, an inherited endpoint), the old endpoint names, and the proxy variables
`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` in both cases.

```bash
AWS_REGION=us-east-1
AWS_DEFAULT_REGION=us-east-1
AWS_ACCESS_KEY_ID=dummy
AWS_SECRET_ACCESS_KEY=dummy
AWS_EC2_METADATA_DISABLED=true
AWS_CONFIG_FILE=/dev/null
AWS_SHARED_CREDENTIALS_FILE=/dev/null
AWS_ENDPOINT_URL=http://127.0.0.1:<leased port>
AWS_ENDPOINT_URL_DYNAMODB=http://127.0.0.1:<leased port>
DYNAMODB_ENDPOINT=http://127.0.0.1:<leased port>
DDB_ENDPOINT=http://127.0.0.1:<leased port>
```

`AWS_ENDPOINT_URL_DYNAMODB` is the AWS-standard override the Go SDK resolves;
`DYNAMODB_ENDPOINT` and `DDB_ENDPOINT` are the conventions the examples read;
`AWS_ENDPOINT_URL` keeps every other SDK client on the same local profile. The
harness also pins `APPTHEORY_RATE_LIMIT_TABLE_NAME` for the rate-limited
example.

## Concurrency isolation

Two sessions, reviewers or checkout copies on one host must never share or
recreate each other's DynamoDB. The harness therefore derives, per checkout:

- a **checkout identifier** from the absolute checkout path (SHA-256, 8 hex
  characters);
- a **compose project** `apptheory-examples-local-<id>-s<slot>`;
- a **port slot** from the dedicated `8130–8199` range (`stride` 10: DynamoDB
  plus the example HTTP and auxiliary ports), never `:8000` and never
  TableTheory's `:8123`;
- an exclusive `flock` under `~/.cache/apptheory-examples-local/`, so the same
  checkout cannot run twice at once.

The port and compose project are overridable only through the harness
(`--slot`, `--port`, `--external`), never through operator environment
variables. `--external` tells the harness that CI supplies DynamoDB Local as a
service container: it waits for the leased port instead of starting a compose
container that would fight for it.

## Discovery and the manifest

Entrypoints are discovered from the tree, not from a hand-maintained list:

- `examples/**/*.go` that declares `func main` is a Go entrypoint;
- a Go file with `//go:build ignore` is a reference document, not an entrypoint
  (`examples/migration/rate-limited-http/before`);
- `examples/**/*.sh` is a shell runner;
- files under `examples/` with a runtime suffix (`.ts`, `.mts`, `.cts`, `.js`,
  `.mjs`, `.cjs`, `.py`) are runtime entrypoints;
- any other executable file under that tree is a runner.

These are not entrypoints, and discovery skips them by documented convention:

| Rule | Covers |
| --- | --- |
| `node_modules`, `cdk.out`, `dist`, `vendor`, `__pycache__`, `.venv`, `.cdk-asset-stage` | dependency trees, build output and the CDK staging trees the examples generate |
| `lib/`, `test/`, `tests/`, `assets/` | support modules, tests and static content inside an example |
| `*.test.*`, `*.spec.*`, `*_test.*` | test files |
| first lines contain `Code generated ... DO NOT EDIT` | generated output |

`bin/` is deliberately not excluded: a CDK app entrypoint such as
`examples/cdk/hello-world/bin/apptheory-hello-world.ts` is a real entrypoint
and is classified like any other runtime file.

The run fails when the tree contains an entrypoint the manifest does not
classify, when a row names a file that does not exist (pending rows included),
when a row declares both a class and a pending milestone, when a runner id is
unknown or reused, or when the profile drifts onto a reserved port. A
`coveredBy` row may point at the row that executes it, which is how the CDK app
entrypoints share the synth row.

The self-tests (`make examples-local-selftest`) build throwaway trees and pin
these rules, so a validator that stops failing closed fails the harness.

## Fidelity table

`scripts/local/examples-local.json` classifies 126 rows: 125 entrypoints plus the
`runtime-api-conformance` suite. The classes are 34 L1, 69 L2, 10 L3 and 12 I;
91 rows execute a runner (90 entrypoints and the suite) and 35 entrypoints are
covered by another row's real run. The harness's `counts:` line reports every
row as passed or failed; a covered row shares its target's result.

Classes: **L1** runs fully locally with no cloud dependency. **L2** runs locally
with an emulator and the named fidelity limit in its row. **L3** is exercised as
fully as possible locally and its named gap is a docs/125 true limit; the only
permitted reasons are AWS-only services with no emulator (the MicroVM managed
provider, Bedrock, S3 Vectors), real network properties (the edge network and
edge TLS), IAM policy evaluation in general, managed rule content owned by AWS,
third-party identity providers, deploy-time-only resources, examples whose
subject is a real AWS account or deployed stack, and runtime state in a
memory-only emulator. **I** is infrastructure-only: the CDK app is synthesized
and hash-checked, has no runtime process, and fails closed to the synth proof.

### L1 rows

| Row | Class | How it is verified | Named limit or gap |
| --- | --- | --- | --- |
| `examples/testkit/ts.mjs` | L1 | TypeScript testkit example: HTTP API v2 request/response, EventBridge workload envelopes and schedules, and DynamoDB stream normalization, all in process with no AWS. | — |
| `examples/testkit/ts-streaming.mjs` | L1 | TypeScript testkit streaming example: Lambda Function URL streaming chunks, cookies, header mutation and late-error framing. | — |
| `examples/testkit/py.py` | L1 | Python testkit example: HTTP API v2 request/response, EventBridge workload envelopes and schedules, and DynamoDB stream normalization, all in process with no AWS. | — |
| `examples/mcp/tools-only-ts/server.mjs` | L1 | TypeScript MCP Streamable HTTP server: initialize, tools/list, tools/call and the exported Lambda entry, driven by the real server and the MCP testkit. | — |
| `examples/mcp/tools-only-py/server.py` | L1 | Python MCP Streamable HTTP server: initialize, tools/list, tools/call and the exported Lambda entry, driven by the real server and the MCP testkit. | — |
| `examples/mcp/tools-only/main.go` | L1 | Go MCP tools-only server: the real binary runs in a warm provided.al2023 container and is driven with explicit MCP HTTP API v2 events (initialize, tools/list, tools/call and two JSON-RPC refusals). Handler-only example: it ships no CDK definition, so no route table is synthesized. | — |
| `examples/mcp/tools-resources-prompts/main.go` | L1 | Go MCP server exposing tools, resources and prompts: the real binary runs in a warm provided.al2023 container and is driven with explicit MCP HTTP API v2 events (tools, resources/read, prompts/get and a refusal). Handler-only example: it ships no CDK definition. | — |
| `examples/migration/rate-limited-http/main.go` | L1 | Lift-to-AppTheory migration server as a real net/http process on DynamoDB Local: real pkg/limited middleware, the rate-limits table provisioned from the real model, 60 allowed requests and the 429 refusal. | — |
| `examples/cdk/hello-world/handlers/go/main.go` | L1 | hello-world Go handler: the app's synthesized CDK stack, the provided.al2023 arm64 container through the runner's Lambda Runtime API, and four HTTP assertions over the derived HTTP API v2 transport (request id, root, 405, 404). | — |
| `examples/cdk/hello-world/handlers/py/handler.py` | L1 | hello-world Python handler: the app's synthesized CDK stack, the python:3.14 container through the runner's Lambda Runtime API, and four HTTP assertions over the derived HTTP API v2 transport. | — |
| `examples/cdk/hello-world/handlers/ts/handler.mjs`, `examples/cdk/hello-world/handlers/ts/app.mjs` | L1 | hello-world TypeScript handler: the app's synthesized CDK stack, the nodejs:24 container through the runner's Lambda Runtime API, and four HTTP assertions over the derived HTTP API v2 transport. | — |
| `examples/cdk/restv1-router/scripts/stage-prefix.sh` | L1 | Stage-prefixed REST URL: the API is served at /stage-probe at the root and /prod/stage-probe under the named stage; the v1 event carries path/resource without the stage and requestContext.path with it, and requestContext.stage=prod. plan prints both forms. | — |
| `examples/cdk/hello-world/handlers/stage-echo/handler.mjs` | L1 | Stage-prefixed HTTP API URL: an HTTP API with a named (dev) stage served /echo at the root and /dev/echo under the stage; the payload-format-2.0 event carried rawPath=/dev/echo, requestContext.http.path=/dev/echo and requestContext.stage=dev. | — |
| `examples/cdk/restv1-router/scripts/intrinsic-limits.sh` | L1 | CloudFormation-expression MemorySize/Timeout: the L1 CfnFunction escape hatch declares a Ref to a parameter Default (256 MB), an Fn::If over a condition evaluable from that default (10 s), and an Fn::FindInMap pair (512 MB / 30 s); plan resolves them with no unresolved flags, the inventory handler answers, and docker inspect proves the resolved 256 MB reached the real container. | — |
| `examples/cdk/lambda-role/handlers/index.ts` | L1 | lambda-role baseline handler: the compiled asset serves the basic, tracing and dynamic functions and returns the expected 200 payload from each. | — |
| `examples/cdk/lambda-packaging/handlers/node/app.js`, `examples/cdk/lambda-packaging/handlers/python/app.py`, `examples/cdk/lambda-packaging/images/go/main.go`, `examples/cdk/lambda-packaging/images/node/app.js`, `examples/cdk/lambda-packaging/images/python/app.py`, `examples/cdk/lambda-packaging/layers/node/bin/layer-tool`, `examples/cdk/lambda-packaging/layers/python/bin/layer-tool`, `examples/cdk/lambda-packaging/layers/python/python/layer_tool.py` | L1 | The Node zip function declares the CDK layer; the handler imports layer-greeting from /opt/nodejs/node_modules, executes /opt/bin/layer-tool from PATH and reports /opt/bin and /opt/lib in the runtime paths. | — |
| `examples/cdk/lesser-parity/handlers/api.mjs` | L1 | Lesser-parity catch-all REST handler: GET and POST assertions with resolved TABLE_NAME/QUEUE_URL values. | — |
| `examples/cdk/lesser-parity/handlers/graphql.mjs` | L1 | Lesser-parity GraphQL handler: a dedicated POST route, the resolved table name, and GET falling through to the catch-all. | — |
| `examples/cdk/microvm-controller/workloads/go/main.go` | L1 | MicroVM Go workload: the built server runs as a host process and answers GET and POST with its HTTP contract. | — |
| `examples/cdk/microvm-controller/workloads/py/server.py` | L1 | MicroVM Python workload: the stdlib server runs as a host process and answers GET and POST with its HTTP contract. | — |
| `examples/cdk/microvm-controller/workloads/ts/server.js`, `examples/cdk/microvm-controller/workloads/ts/server.ts` | L1 | MicroVM TypeScript workload (the built server.js shipped in the image): it runs as a host process and answers GET and POST with its HTTP contract. | — |
| `examples/cdk/restv1-router/handlers/api.mjs` | L1 | REST v1 router catch-all handler: GET and POST assertions with the matched proxy path parameter. | — |
| `examples/cdk/restv1-router/handlers/graphql.mjs` | L1 | REST v1 router GraphQL handler: POST query handling and GET falling through to the catch-all route. | — |
| `examples/cdk/restv1-router/handlers/inventory.mjs` | L1 | REST v1 router inventory handler: GET/PUT/DELETE with path parameters, 404 refusals and the declared CORS preflight. | — |
| `examples/cdk/multilang/handlers/ws-authorizer.mjs` | L1 | WebSocket `$connect` REQUEST authorizer, covered by the multilang Go run (`examples/cdk/multilang/handlers/go/main.go`): the runner invokes it during the handshake and matches its returned policy against the `$connect` method ARN; a wrong token is refused with 401 and the correct one connects. | — |

### L2 rows

| Row | Class | How it is verified | Named limit or gap |
| --- | --- | --- | --- |
| `examples/mcp/resumable-sse/main.go` | L2 | Go MCP resumable SSE server: a warm provided.al2023 container keeps the session, the tool-call stream is forwarded incrementally (the row observes the first chunk before the 0.5s-per-step countdown finishes), and Last-Event-ID replay returns the progress events and final result. Handler-only example: it ships no CDK definition, so no route table is synthesized. | The warm handler is driven over the local invoke transport, not a deployed API Gateway; the runner forwards each chunk at the handler's pace and does not reproduce Lambda's 6 MB uncapped burst and 2 MBps streaming cap (docs/125 streaming deviation). |
| `examples/cdk/multilang/scripts/watch-go.sh` | L2 | Dev-loop watch (Go): a real edit to handlers/go/main.go triggers the runner's own cdk synth; the new response arrives on the unchanged GoApi listener, the Go function's execution environment is replaced, and the TypeScript and Python functions keep their Runtime API listeners and still answer on their own API listeners (they were not restarted); the source is restored and rebuilt before shutdown. | The runner re-synthesizes with cdk synth and polls the app directory with a 500 ms debounce; a change it cannot apply live (a new API listener, a new WebSocket API, a changed CloudFront topology, a new backend) is reported by name and requires a restart. |
| `examples/cdk/multilang/scripts/watch-ts.sh` | L2 | Dev-loop watch (TypeScript): a real edit to handlers/ts/handler.mjs triggers the runner's own cdk synth; the new response arrives on the unchanged TsApi listener, the TypeScript function's execution environment is replaced, and the Go and Python functions keep their Runtime API listeners and still answer on their own API listeners (they were not restarted); the source is restored and rebuilt before shutdown. | The runner re-synthesizes with cdk synth and polls the app directory with a 500 ms debounce; a change it cannot apply live (a new API listener, a new WebSocket API, a changed CloudFront topology, a new backend) is reported by name and requires a restart. |
| `examples/cdk/multilang/scripts/watch-py.sh` | L2 | Dev-loop watch (Python): a real edit to handlers/py/handler.py triggers the runner's own cdk synth; the new response arrives on the unchanged PyApi listener, the Python function's execution environment is replaced, and the Go and TypeScript functions keep their Runtime API listeners and still answer on their own API listeners (they were not restarted); the source is restored and rebuilt before shutdown. | The runner re-synthesizes with cdk synth and polls the app directory with a 500 ms debounce; a change it cannot apply live (a new API listener, a new WebSocket API, a changed CloudFront topology, a new backend) is reported by name and requires a restart. |
| `examples/cdk/multilang/scripts/watch-two-edit.sh` | L2 | Dev-loop watch (two successive edits): a real edit to handlers/go replaces the Go function and its new response arrives on the unchanged GoApi listener; a second real edit to handlers/ts replaces the TypeScript function while the already-restarted Go function keeps its Runtime API and still answers its new response, and the Python function answers throughout; both sources are restored and rebuilt before shutdown. | The runner re-synthesizes with cdk synth and polls the app directory with a 500 ms debounce; a change it cannot apply live (a new API listener, a new WebSocket API, a changed CloudFront topology, a new backend) is reported by name and requires a restart. |
| `examples/cdk/lesser-parity/scripts/data-dir.sh` | L2 | DynamoDB --data-dir: a real item was written through the API handler's DynamoDB SDK in one session; a second session with the same --data-dir read it back through the same handler from shared-local-instance.db; a third session without --data-dir answered 404 (the default stays ephemeral). | DynamoDB Local persists through -dbPath; moto runtime state is memory-only (the docs/125 true limit). A table key-schema change cannot be applied by UpdateTable and fails closed by name. |
| `examples/cdk/lambda-role/scripts/data-dir-s3.sh` | L2 | S3 --data-dir: the custom handler wrote an object through the real S3 SDK in one invoke; a second invoke with the same --data-dir read the object back through the handler, and the s3proxy base directory holds the object file. | s3proxy's filesystem provider persists objects; bucket policies and server-side event hooks are not served by the store. |
| `examples/cdk/sqs-queue/scripts/data-dir-sqs.sh` | L2 | SQS --data-dir: a real ElasticMQ message was sent to an unconsumed queue in one session; a second session with the same --data-dir found it visible and received its body; the messages-storage H2 database held it. | ElasticMQ 1.7.1 persists queues and messages through messages-storage (verified on the pinned image); IAM, KMS encryption and AWS-managed scaling are not emulated. |
| `examples/cdk/restv1-router/scripts/seed-local.sh` | L2 | Seed hook: the committed seed script ran after provisioning and before `local-run: ready`, used APPTHEORY_LOCAL_APIS to PUT and GET through the real inventory handler, and the seeded item was visible; a failing seed failed the run with the script's output. | The seed command runs on the host with the run's dummy credentials and host endpoint URLs against DynamoDB Local (emulated); it drives the app's own handler (HTTP here), never the backend directly. |
| `examples/cdk/import-pipeline/scripts/codebuild-local.sh` | L2 | CodeBuild through AWS's local agent: StartBuild on the synthesized BatchStep project ran its inline buildspec with the pinned agent and build image; BatchGetBuilds reported BUILD/COMPLETED SUCCEEDED and the command log; ListBuildsForProject returned the id; the state-change rule delivered the SUCCEEDED event to the import-build-events SQS target. No mock. | The local agent runs the build in a Docker container on its own compose network; there is no VPC, cache, artifact upload or report group, and the project's aws/codebuild/standard:7.0 image is mapped to the profile's digest-pinned aarch64 Lambda-standard image. The agent and image are the published AWS images, not a mock. |
| `examples/cdk/kinesis-cloudwatch-logs/handlers/go/main.go`, `examples/cdk/kinesis-cloudwatch-logs/handlers/logtap/main.go` | L2 | Kinesis/CloudWatch Logs handler: the CDK stream is provisioned on moto; PutLogEvents through the real Logs SDK is forwarded by the subscription filter through its Logs destination to the stream and delivered to the consumer; the consumer's captured stdout is delivered to a Lambda-destination filter as awslogs.data; a direct PutRecords batch delivers its valid record and discards the malformed one after its retries. | moto emulates Kinesis and CloudWatch Logs: sequence numbers are opaque and a stream never splits or merges. The subscription filter, the Kinesis mapping, partial failure and the function-log capture are real; IAM policy evaluation is a docs/125 true limit. |
| `examples/cdk/kinesis-cloudwatch-logs/handlers/signing/main.go` | L2 | Kinesis signing handler: the CDK RSA_2048 SIGN_VERIFY key and alias are provisioned through the runner's KMS front; the handler signs and verifies with the alias (usable as KeyId) and the key ARN, reads the public key, and signs a precomputed SHA-256 digest with MessageType=DIGEST that it verifies outside KMS with the GetPublicKey public key (the double hash does not verify). | KMS is emulated by the runner's KMS front over the pinned moto (no HSM, key policies or grants); Sign, Verify and GetPublicKey are real, including DIGEST. |
| `examples/cdk/kinesis-cloudwatch-logs/scripts/data-dir-kms.sh` | L2 | KMS --data-dir: run 1 encrypted under the CDK symmetric key, generated a 32-byte data key and signed a precomputed digest with the CDK RSA_2048 key; run 2 with the same --data-dir saw the same KeyId/ARN for both keys, decrypted both ciphertexts by the run-1 key id, read the same public key, and verified the run-1 signature through KMS by the run-1 key id and ARN and outside KMS. | KMS key material and the key identity (`KeyId`/`Arn`) are persisted by the runner's KMS front (moto is memory-only, so the front re-creates the key and reports the persisted identity); the remaining metadata, notably `CreationDate`, is the current run's. No HSM, key policies or grants. |
| `examples/cdk/lambda-role/handlers/custom.ts` | L2 | lambda-role custom handler: the compiled asset runs in nodejs:24 and reads String/SecureString/StringList SSM parameters through Ref and GetAtt, both Secrets Manager secrets through GetSecretValue, and the provisioned Cognito pool/client; the runner's local issuer serves the pool JWKS and discovery document; the S3 object round-trip stays real on s3proxy. | IAM policy evaluation is a docs/125 true limit; S3 is emulated by s3proxy (no bucket policies and no server-side notification hook; the runner delivers bucket notification configurations from observed object state). SSM parameters, Secrets Manager secrets and the Cognito user pool are real on moto. |
| `examples/cdk/lambda-role/scripts/s3-sse.sh` | L2 | SSE-S3 through the real SDK: the compiled Node handler put an object with x-amz-server-side-encryption: AES256 under a key containing `=` and a space and the PutObject response reported AES256; the front re-signed the put over the forwarded path, and HeadObject and GetObject through the same handler returned the SSE-S3 header and the stored body; one DeleteObjects request at AWS's maximum shape (999 keys of exactly 1024 bytes plus the short recorded key, about 1.05 MiB, above the front's record buffer) was forwarded to s3proxy and deleted the object. | s3proxy's filesystem store refuses server-side encryption by design; the runner's S3 front records SSE-S3 for a verified header-signed put and forwards every other SSE put unchanged so the store keeps its answer. The re-signed canonical URI is the URI-encoded path encoded once, so keys with `=`, spaces, `+`, `%`, unicode and `/` survive. SSE-KMS and SSE-C remain refused (the runner cannot honour a key binding or customer key). A DeleteObjects body above the front's 1 MiB buffer is forwarded unchanged and its SSE-S3 records are left for a later plain `PutObject`, plain `CopyObject`, successful `CompleteMultipartUpload`, `DeleteObject` or plain `DeleteBucket` to clear; an abort of a multipart upload and a metadata subresource read change nothing. Bucket policies and server-side notification hooks are not served by the store. |
| `examples/cdk/lambda-role/handlers/authorizer.ts`, `examples/cdk/lambda-role/handlers/policy-authorizer.ts` | L2 | HTTP API JWT, REST Cognito and Lambda policy authorizers: a real user was created in the moto pool and real id/access tokens were minted through the Cognito API; the JWT-protected route received requestContext.authorizer.jwt.claims and the Cognito-protected route received requestContext.authorizer.claims; a REST TOKEN authorizer, a REST REQUEST authorizer over a header and a query source, and an HTTP API IAM-policy authorizer ran the real policy function and carried its stringified context to the integration, Allow invoked the method, Deny was 403, the documented Unauthorized error was 401, an invalid policy was 500 and a missing identity source was 401 without invoking; a cached TOKEN and HTTP API decision did not invoke the function again until the run clock passed AuthorizerResultTtlInSeconds. | moto signs the user pool's tokens and serves the pool JWKS; the runner serves the local OIDC issuer the template's issuer resolves to. Token validation, audience and issuer matching, expiry on the run clock, scopes and the documented claims are real. IAM policy evaluation is a docs/125 true limit. |
| `examples/cdk/lambda-role/handlers/encrypted.ts` | L2 | lambda-role encrypted handler: the compiled asset runs in nodejs:24 and round-trips plaintext through the emulated KMS with match=true. | KMS is emulated by moto (no HSM, key policies or grants); the encrypt/decrypt round-trip is real. |
| `examples/cdk/lesser-parity/handlers/sse.mjs` | L2 | Lesser-parity SSE handler: the streaming REST integration writes the three events incrementally (the row observes the first event 0.7s apart from the rest) and the declared CORS preflight is served from the same REST API. | The local REST API integration forwards each chunk at the handler's pace; Lambda's 6 MB uncapped burst and 2 MBps streaming cap are not reproduced. |
| `examples/cdk/lesser-parity/handlers/worker.mjs` | L2 | Lesser-parity queue worker: two real ElasticMQ messages were delivered as the CDK mapping's batch; the handler returned the invalid record as its only partial failure, so exactly that message remained in the queue. | ElasticMQ emulates SQS; IAM, KMS encryption and AWS-managed scaling are not emulated. |
| `examples/cdk/media-cdn/bin/app.ts` | L2 | Media CDN: the public distribution serves a probe object from the local S3 emulator with its metadata and a custom 403 error page; the private trusted-key-group distribution requires a signature: unsigned 403, a canned-policy SHA-256 URL, a custom-policy signed cookie, a query added after signing 403, an unknown Key-Pair-Id 403, OPTIONS exempt, and the expired URL 403 after clock.advance. | CloudFront edge network and edge TLS (docs/125 true limits); the private distribution's signed URLs and cookies are verified against the key group's real public keys, and the local S3 origin uses the OAC access model without bucket policies. |
| `examples/cdk/restv1-router/handlers/sse.mjs` | L2 | REST v1 router SSE handler: the real streamifyResponse handler writes the 10 events and [DONE] incrementally; the row observes the first event before the stream ends. | The local REST API integration forwards each chunk at the handler's pace; Lambda's 6 MB uncapped burst and 2 MBps streaming cap are not reproduced. |
| `examples/cdk/sqs-queue/handlers/dlq-handler.mjs` | L2 | SQS DLQ handler: the EventsConsumer mapping failed the real message five times on the test clock; ElasticMQ redrove it to events-queue-dlq after maxReceiveCount=5 and the DlqConsumer mapping delivered and deleted it. | ElasticMQ emulates SQS; IAM, KMS encryption and AWS-managed scaling are not emulated. |
| `examples/cdk/sqs-queue/handlers/producer.mjs` | L2 | SQS producer handler: the real producer sends through the AWS SQS SDK to ElasticMQ; the ContractConsumer mapping delivered the message to worker.handler and deleted it, with no manual receive or invoke. | ElasticMQ emulates SQS; IAM, KMS encryption and AWS-managed scaling are not emulated. |
| `examples/cdk/sqs-queue/handlers/sns-publisher.mjs`, `examples/cdk/sqs-queue/handlers/sns-consumer.mjs` | L2 | SQS queue SNS publisher: the standard and FIFO topics are provisioned on moto from the CDK definition; the handler publishes through the real SDK; the inline Lambda subscription receives the documented SNS record (message id, subject, timestamp, UnsubscribeUrl, String attributes); the FIFO topic delivers three ordered messages and collapses two identical content-based publishes to one; the FIFO queue carries MessageGroupId and the explicit or content SHA-256 MessageDeduplicationId. | moto emulates SNS (no managed delivery infrastructure); IAM policy evaluation is a docs/125 true limit. The topics, the publish call and the runner's fan-out are real. |
| `examples/cdk/sqs-queue/handlers/sns-scenario-publisher.mjs` | L2 | SNS fan-out targets: an attribute-scope policy (AND across keys, OR within a key) and a body-scope policy (nested keys) each admit one message and filter two; an SQS raw subscription receives the body and native attributes while the envelope subscription receives the documented JSON notification; a loopback HTTP subscription receives the documented body and x-amz-sns-* headers. | moto emulates SNS (no managed delivery infrastructure) and ElasticMQ emulates SQS; IAM policy evaluation is a docs/125 true limit. The publishes, the runner's filter evaluation and every target delivery are real. |
| `examples/cdk/sqs-queue/handlers/s3-consumer.mjs` | L2 | S3 event notifications: the CDK bucket's Lambda, SQS and SNS configurations delivered the documented s3:TestEvent on configuration; the two ObjectCreated configurations share the incoming/ prefix with non-overlapping suffixes, and a real SDK PUT of incoming/a.json delivered ObjectCreated:Put to the Lambda function only (which wrote a real SQS receipt) while the SNS .csv suffix and the queue's event type filtered it; a real SDK PUT of incoming/b.csv delivered ObjectCreated:Put to the SNS topic only; ignored/a.txt was filtered by every prefix/suffix rule; a real SDK DELETE delivered ObjectRemoved:Delete to the queue; describe reported exact per-destination delivered/filtered counts (lambda 1/3, queue 2/3, topic 2/3). | s3proxy emulates S3 object storage and has no server-side event hook: the runner observes every object change with ListObjectsV2 and therefore reports an observed create as ObjectCreated:Put and an observed delete as ObjectRemoved:Delete; CloudFront caching and the edge network are not involved. |
| `examples/cdk/sqs-queue/handlers/rule-publisher.mjs`, `examples/cdk/sqs-queue/handlers/rule-failing-target.mjs`, `examples/cdk/sqs-queue/handlers/rule-target.mjs` | L2 | EventBridge rule targets: the publisher calls PutEvents through the real SDK for four rules on the default and a custom bus; an SQS target receives its InputPath body, an SNS target receives the input-transformer message, a Lambda target receives the static Input object, and a failing Lambda target exhausts two retries into the real DLQ with the documented error attributes. | ElasticMQ emulates SQS and moto emulates SNS; the runner serves the EventBridge bus. IAM policy evaluation is a docs/125 true limit. The PutEvents calls, pattern matching, input shaping, target delivery, retries and DLQ are real. |
| `examples/cdk/sqs-queue/handlers/worker.mjs` | L2 | SQS worker handler: the EventsConsumer mapping batched two real ElasticMQ messages on the 10s window and left only the reported failure; FilteredConsumer deleted a non-matching message without invocation; FifoConsumer kept a failed group's records in order; ConcurrencyConsumer's live peak stayed at MaximumConcurrency=2. | ElasticMQ emulates SQS; IAM, KMS encryption and AWS-managed scaling are not emulated. |
| `examples/cdk/ssr-only-provided-assets-site/bin/app.ts` | L2 | SSR_ONLY provided assets: the real handler runs behind an AWS_IAM Function URL origin with local OAC signing and echoes the viewer request id; the provided bucket serves app.js, site.css and probe.txt; a missing object is 403 under OAC and OPTIONS is refused. | CloudFront edge network (docs/125 true limit: real network properties); the AWS_IAM Function URL is reached through local SigV4 OAC signing, but IAM policy evaluation is not emulated. |
| `examples/cdk/ssr-site/bin/apptheory-ssr-site.ts` | L2 | SSR site: the origin group fails over from the S3 HTML primary (403 under OAC) to the real SSR handler; the SSR stream reaches the viewer through the gateway and directly on the Function URL as the handler writes it, the viewer-response function echoes the request id, and the assets and hydrate deployments, full and ranged HEAD, conditional If-None-Match GETs, OPTIONS and the missing-object 403 are asserted. Caching is real: the static-assets behavior answered a miss then a hit with x-cache and age, the CACHING_DISABLED SSR behavior never cached, an invalidation through the local API and through the aws CLI removed the object, and clock.advance past the TTL was a miss again. | CloudFront edge network (docs/125 true limit: real network properties); the gateway forwards a streamed response at the origin's pace and caches it in full after it completes (Lambda's 6 MB uncapped burst and 2 MBps streaming cap are not reproduced). |
| `examples/cdk/ssr-site/scripts/generate-assets-manifest.mjs` | L2 | SSR site asset manifest generator: runs against the real assets directory, asserts hello.txt's sha256 and byte count, then matches the served asset through the gateway to the manifest. | CloudFront edge network (docs/125 true limit: real network properties); the manifest is matched against the gateway response, not a deployed bucket. |
| `examples/cdk/edge-gateway/bin/app.ts`, `examples/cdk/edge-gateway/handlers/kvs.js`, `examples/cdk/edge-gateway/handlers/origin-request.js`, `examples/cdk/edge-gateway/handlers/origin-response.js`, `examples/cdk/edge-gateway/handlers/viewer-request.js`, `examples/cdk/edge-gateway/handlers/viewer-response.js` | L2 | Edge gateway: four Lambda@Edge associations run through the real Node containers (viewer-request uri rewrite, origin-request generated response cached without a second invocation, origin-response body replacement, viewer-response header), IncludeBody exposes the base64 body, an origin rewrite reaches the other declared origin, a runtime 2.0 CloudFront Function reads get/exists/meta from its key value store, geo restriction serves US, refuses JP and serves an undetermined location, and the origin decrypts the field-level encryption ciphertext with the real AWS Encryption SDK. | CloudFront edge network and edge TLS (docs/125 true limits: real network properties); viewer events run against the viewer's plain-HTTP connection, so ViewerProtocolPolicy is reported rather than enforced. The field-level encryption row needs the AWS Encryption SDK on the harness interpreter. |
| `examples/cdk/local-tls/bin/app.ts` | L2 | Local TLS opt-in surfaces: with `--tls`, the HTTP API, REST API, Function URL, WebSocket API and CloudFront distribution all answer over verified https/wss at app.localhost; the listener negotiates HTTP/2, refuses an unserved SNI name, and every reported URL starts `https://` or `wss://`. | The certificate chains to a runner-generated local CA, not a public one, and the listener has no edge certificate or managed security policy (docs/125 real network properties: edge TLS certificates). |
| `examples/cdk/local-tls/handlers/go/main.go` | L2 | Go caller: a provided.al2023 container reads SSL_CERT_FILE, fetches the app's OIDC discovery document and JWKS over verified https from the runner's own listener, and returns the issuer and key count. | The Go container verifies the runner's local CA, not a public certificate. |
| `examples/cdk/local-tls/scripts/callback-node.sh` | L2 | Node caller: a nodejs24.x container reads NODE_EXTRA_CA_CERTS, fetches the app's OIDC discovery document and JWKS over verified https from the runner's own listener, and returns the issuer and key count. | The Node container verifies the runner's local CA, not a public certificate. |
| `examples/cdk/local-tls/handlers/python/caller.py` | L2 | Python caller: a python3.14 container reads SSL_CERT_FILE through ssl.create_default_context, fetches the app's OIDC discovery document and JWKS over verified https from the runner's own listener, and returns the issuer and key count. | The Python container verifies the runner's local CA, not a public certificate. |
| `examples/cdk/local-tls/scripts/oidc.sh` | L2 | OIDC-shaped row: the issuer's discovery document names the exact https URL it is served at, a host client fetches discovery then JWKS over verified TLS, and a Go container fetches both from its own container and reports the same issuer. | The issuer is a local Lambda behind the runner's listener; it is not a public OIDC provider and its certificate is not publicly trusted. |
| `examples/cdk/local-tls/scripts/browser-webauthn.sh` | L2 | Browser row: headless Chromium loads the opted-in CloudFront page over https with the run leaf's SPKI allowlisted (a secure context), registers a WebAuthn credential with RP ID app.localhost through the CDP virtual authenticator, asserts it, and the authenticator holds exactly one credential. | Chromium is launched with the run leaf's SPKI allowlisted instead of installing the CA in a system trust store; the credential lives in a CDP virtual authenticator rather than a hardware or platform authenticator. |
| `examples/cdk/local-tls/scripts/aux-cert.sh` | L2 | Auxiliary-service certificate: `tls leaf` issues a certificate from the run CA for idp.localhost, and a host client and a Python container fetch the service's discovery and JWKS over verified TLS. | The auxiliary identity provider is a local test service signed by the runner CA, not a third-party identity provider (docs/125 decision D3). |
| `examples/cdk/local-tls/scripts/awssdk-go.sh` | L2 | AWS SDK in a Go container: a caller-supplied `*http.Client` loads the aws-sdk-go-v2 config (the shape TableTheory/DynamORM uses), lists DynamoDB Local tables, gets 410 GONE from the runner's TLS @connections endpoint, and the same invocation fetches the app's discovery document and JWKS over verified https. | The Go container verifies the runner's local CA, not a public certificate, and the @connections endpoint is the runner's own listener. |
| `examples/cdk/local-tls/scripts/awssdk-node.sh` | L2 | AWS SDK in a Node container: the JavaScript SDK v3 the nodejs24.x image ships lists DynamoDB Local tables and gets 410 GONE from the runner's TLS @connections endpoint, and the same invocation fetches the app's discovery document and JWKS over verified https with NODE_EXTRA_CA_CERTS as its only added trust anchor. | The Node container verifies the runner's local CA, not a public certificate. |
| `examples/cdk/local-tls/scripts/awssdk-py.sh` | L2 | AWS SDK in a Python container: boto3 lists DynamoDB Local tables and gets 410 GONE from the runner's TLS @connections endpoint, and the same invocation fetches the app's discovery document and JWKS over verified https with AWS_CA_BUNDLE and SSL_CERT_FILE. | The Python container verifies the runner's local CA, not a public certificate. |
| `examples/cdk/local-tls/scripts/cloudfront-origin.sh` | L2 | CloudFront in front of the run's own API over TLS: the distribution declares an https-only custom origin `auth-api.localhost` mapped to the API listener, verifies the run CA against that declared origin domain, forwards the origin Host header, and returns the API's GET `/.well-known/oauth-authorization-server` and a form POST `/auth/token` body unchanged. | The origin certificate chains to the runner's CA and names the app's declared local origin domain, not a public origin certificate; the local edge is not the CloudFront network. |
| `examples/cdk/local-tls/scripts/cloudfront-redirect.sh` | L2 | CloudFront returns an origin redirect to the viewer: a form POST the auth-api answers with `303 See Other` reaches the viewer with the exact `Location` at the auxiliary `idp.localhost` certificate and both `Set-Cookie` values, the hop never follows it, and headless Chromium then follows it to the IdP over TLS verified against the run CA. | The identity provider is a local test service signed by the runner CA, not a third-party provider, and the local edge is not the CloudFront network. |
| `examples/cdk/local-tls/scripts/cloudfront-http-only-error.sh` | L2 | A plain http origin mapping to the run's TLS-only API listener is refused before the distribution starts, naming `OriginProtocolPolicy HTTPS_ONLY` and the https mapping to use instead of surfacing the TLS listener's bare 400. | The check is a local runner rule for a mapping the runner owns; a deployed distribution never maps an origin to the run. |
| `scripts/local/runtime_api_conformance.py` | L2 | Runtime API conformance: one handler set per language on the real digest-pinned runtime images, run once under the embedded Runtime Interface Emulator and once under the runner's Lambda Runtime API, comparing status, headers, body bytes, handler errors, timeouts and initialization failures. | The comparison runs this host's architecture; the Lambda service's Init-phase billing and its 10-second Init limit are not emulated. |

The CodeBuild row pulls the agent and the curated build image. The aarch64 pair
needs about 8 GB of colima disk, and the opt-in full-toolchain image adds about
10.9 GB on disk. Colima's disk is not a fixed limit, so grow it before a pull
when it is short ([colima](https://github.com/abiosoft/colima)); a pull that
fails for capacity fails the row with the registry error rather than mocking the
build.

### L3 rows

| Row | Class | How it is verified | Named limit or gap |
| --- | --- | --- | --- |
| `examples/cdk/import-pipeline/handlers/ingest/main.go` | L3 | Import pipeline ingest handler: a real object is written to s3proxy, the runner's S3 notification watcher publishes the documented aws.s3 Object Created event to the local bus, and IngestRule invokes the handler with no harness PutEvents; the handler writes the job meta and three work messages that the WorkConsumer mapping delivers to the worker and deletes. | IAM policy evaluation in general (docs/125 true limit: identity and resource policies, SCPs, permission boundaries and STS trust policies depend on account-level state and AWS publishes no reference evaluator); the bucket's EventBridge notification is delivered by the runner from a real object PUT, the WorkConsumer SQS mapping delivers automatically on ElasticMQ, and the CodeBuild step is proven by the codebuild-import row. |
| `examples/cdk/import-pipeline/handlers/worker/main.go` | L3 | Import pipeline worker handler: the full ingest → worker flow runs on the CDK jobs table after the runner delivered the bucket's EventBridge notification; the WorkConsumer mapping delivers the three real work messages automatically and they produce SUCCEEDED/FAILED records and a sanitized error envelope. | IAM policy evaluation in general (docs/125 true limit: identity and resource policies, SCPs, permission boundaries and STS trust policies depend on account-level state and AWS publishes no reference evaluator); the bucket's EventBridge notification is delivered by the runner from a real object PUT, the WorkConsumer SQS mapping delivers automatically on ElasticMQ, and the CodeBuild step is proven by the codebuild-import row. |
| `examples/cdk/microvm-controller/controller/main.go` | L3 | MicroVM controller: the CDK authorizer refuses missing/wrong/tenant-less credentials; list/run reach the managed provider boundary; get/suspend/resume/terminate/auth-token/shell-auth-token/invoke read the TableTheory registry on DynamoDB Local and refuse a missing session. | The MicroVM managed provider (docs/125 true limit: AWS-only services with no emulator); the real CDK authorizer and controller routes run locally and every provider-backed operation stops at that boundary. |
| `examples/microvm-conformance/run_local.py` | L3 | MicroVM conformance harness: the real dry-run and token-leak scanner pass; live mode runs against the local microvm-controller, passes its auth refusals, and stops at the managed provider boundary. | The MicroVM managed provider (docs/125 true limit: AWS-only services with no emulator); dry-run and leak-scan pass, and the live conformance run stops at the provider boundary. No EqualToAI/Host live proof is claimed. |
| `examples/cdk/multilang/handlers/go/main.go` | L3 | Multilang Go handler: its own HTTP API v2 listener serves root, hello, 405 and 404; the Go REST API serves hello and the three SSE events written incrementally; three WebSocket APIs serve real frames through the $connect authorizer, the custom chat route, $default and the @connections management API; the CDK SQS mapping delivered a real message to the Go handler and deleted it; a real SDK-written table item reached the handler through the DynamoDB Streams mapping with the CDK stream ARN, the test clock expired a TTL item into the documented REMOVE record, and a poison record was bisected and discarded to the on-failure queue; both EventBridge rules are invoked. The `$connect` authorizer handler, `examples/cdk/multilang/handlers/ws-authorizer.mjs`, is covered by this run and has its own L1 row. | IAM policy evaluation in general (docs/125 true limit: identity and resource policies, SCPs, permission boundaries and STS trust policies depend on account-level state and AWS publishes no reference evaluator). Backends are emulated (DynamoDB Local, ElasticMQ, moto); SQS delivery, DynamoDB Streams, EventBridge rules, WebSocket frames and incremental response streaming are real. The REST v1 surface is defined only for the Go handler in this stack. |
| `examples/cdk/multilang/handlers/py/handler.py` | L3 | Multilang Python handler: its own HTTP API v2 listener serves root, hello, 405 and 404; the CDK SQS mapping delivered a real message to the Python handler and deleted it; a real SDK-written table item reached the handler through the DynamoDB Streams mapping with the CDK stream ARN, and the test clock expired a TTL item into the documented REMOVE record; the rate schedule fired and a real SDK PutEvents reached the pattern rule; the Go-only REST surface is also asserted. | IAM policy evaluation in general (docs/125 true limit: identity and resource policies, SCPs, permission boundaries and STS trust policies depend on account-level state and AWS publishes no reference evaluator). Backends are emulated (DynamoDB Local, ElasticMQ, moto); SQS delivery, DynamoDB Streams, EventBridge rules, WebSocket frames and incremental response streaming are real. The REST v1 surface is defined only for the Go handler in this stack. |
| `examples/cdk/multilang/handlers/ts/handler.mjs` | L3 | Multilang TypeScript handler: its own HTTP API v2 listener serves root, hello, 405 and 404; the CDK SQS mapping delivered a real message to the TypeScript handler and deleted it; a real SDK-written table item reached the handler through the DynamoDB Streams mapping with the CDK stream ARN, and the test clock expired a TTL item into the documented REMOVE record; the rate schedule fired and a real SDK PutEvents reached the pattern rule; the Go-only REST surface is also asserted. | IAM policy evaluation in general (docs/125 true limit: identity and resource policies, SCPs, permission boundaries and STS trust policies depend on account-level state and AWS publishes no reference evaluator). Backends are emulated (DynamoDB Local, ElasticMQ, moto); SQS delivery, DynamoDB Streams, EventBridge rules, WebSocket frames and incremental response streaming are real. The REST v1 surface is defined only for the Go handler in this stack. |
| `examples/cdk/path-routed-frontend/bin/app.ts` | L3 | Path-routed frontend: the generated SPA function rewrites /l and /auth to index.html, files are served unchanged, the external API origin is refused by name, POST is refused by AllowedMethods and a missing object is 403 under OAC. The example ships no SPA build output, so probe objects are written through the runner to the provisioned buckets. The external API origin is mapped with --origin to a loopback listener the row starts; the gateway sent the documented origin-request shape (origin path /prod, origin Host, method) and the CACHING_DISABLED behavior reported x-cache miss. | The CloudFront edge network (docs/125 true limit: real network properties — the edge network, anycast and the edge TLS certificates). |
| `examples/cdk/s3-vectors-semantic-search/handler/main.go` | L3 | S3 Vectors semantic search handler: health reports the CDK vector index; missing/wrong auth, missing query and invalid top_k are refused; authorized seed/search reach the Bedrock boundary with vectorstore.embedding_failed. | S3 Vectors and Bedrock (docs/125 true limit: AWS-only services with no emulator); the HTTP and auth surface runs locally, refusals are asserted, and authorized provider calls stop at the closed Bedrock endpoint. |
| `examples/cdk/ssr-site/scripts/upload-assets.sh` | L3 | SSR site asset uploader: the real AWS CLI syncs the assets and copies the generated manifest to the local s3proxy endpoint with dummy credentials; the gateway serves both with the script's cache-control and the uploaded manifest. The site's bucket declares no event notification; the notification destinations are proven by the sqs-queue row. s3proxy serves the objects without bucket policies or IAM. | The edge network and IAM policy evaluation in general (docs/125 true limits: real network properties; IAM policy evaluation in general). |

| `examples/cdk/local-iam-peer/bin/app.ts` | L2 | The second app of the shared-plane row: it defines the role the other run assumes and the REST API that run's session calls. | — |
| `examples/cdk/local-iam/bin/app.ts` | L2 | The local IAM app: a REST API with AWS_IAM methods and a resource policy, an HTTP API AWS_IAM route, an AWS_IAM Function URL, and the caller, other and vending roles the rows resolve. | IAM policy evaluation is narrow (docs/127 W3-D1): only the enumerated statement shapes are evaluated, and the STS trust policy alone decides AssumeRole locally. |
| `examples/cdk/local-iam/handlers/go/main.go` | L2 | Go caller: a provided.al2023 container signs an execute-api request with the AWS SDK for Go v2's SigV4 signer, using the credentials the runner issued to it, and the gateway resolves its role ARN from the signature. | IAM policy evaluation is narrow (docs/127 W3-D1): only the enumerated shapes are evaluated, and the STS trust policy alone decides AssumeRole locally. |
| `examples/cdk/local-iam/handlers/node/caller.js` | L2 | Node caller: a nodejs24.x container signs an execute-api request with the AWS SDK for JavaScript v3's SignatureV4 (the SDK the image ships under /var/runtime/node_modules), using the credentials the runner issued to it. | IAM policy evaluation is narrow (docs/127 W3-D1): only the enumerated shapes are evaluated, and the STS trust policy alone decides AssumeRole locally. |
| `examples/cdk/local-iam/handlers/python/caller.py` | L2 | Python caller: a python3.14 container signs an execute-api request with botocore's SigV4Auth, using the credentials the runner issued to it. | IAM policy evaluation is narrow (docs/127 W3-D1): only the enumerated shapes are evaluated, and the STS trust policy alone decides AssumeRole locally. |
| `examples/cdk/local-iam/scripts/function-url.sh` | L2 | AWS_IAM Function URL: a signed call is served with the resolved principal in requestContext.authorizer.iam, and an unsigned call is refused with a named reason. | The Function URL is served on a loopback URL by the local runner, not by the Lambda service; the trust store is the run CA when TLS is opted in. |
| `examples/cdk/local-iam/scripts/grants.sh` | L2 | Narrow IAM grants: a resource-policy allow, an identity-policy-only allow, an account-root principal, an aws:PrincipalArn-conditioned statement, a trailing path wildcard and an HTTP API AWS_IAM route each grant a real SigV4-signed call, and the handler sees the resolved role ARN, account and access key in its event identity. | IAM policy evaluation is a docs/125 true limit in general; the local runner evaluates only the enumerated statement shapes docs/127 W3-D1 defines and fails closed on anything else. |
| `examples/cdk/local-iam/scripts/refusals.sh` | L2 | Narrow IAM refusals: an unsigned request, a tampered signature, a wrong principal, an out-of-subset condition and an explicit Deny are each refused with a named reason. | Only the enumerated statement shapes are evaluated (docs/125 true limit: IAM policy evaluation in general); an out-of-subset statement is refused by name instead of guessed. |
| `examples/cdk/local-iam/scripts/shared-plane.sh` | L2 | Shared IAM plane: run A's function assumes a role run B's stack defined, through run A's STS endpoint; run B verifies the session's signature from the shared credential registry and grants the call against its own resource policy and the role's identity policy. | The two runs share one directory on this host; they are not two deployments, and the session that signs the second call is minted by the first run's STS endpoint rather than by a container-to-container hop (that hop is the co-residence work). |
| `examples/cdk/local-resources/bin/app.ts` | L2 | The resource-type app: a bucket with autoDeleteObjects, a Custom::Trigger, a provider-framework custom resource, a Custom::AWS SDK call, an SES receipt rule with S3 and Lambda actions, an SES identity, and the deploy-time-only and MicroVM types. | The reported types have no local runtime behavior (docs/125 true limit: deploy-time-only resources), and a MicroVM image is an AWS-only service with no emulator. |
| `examples/cdk/local-resources/handlers/go/main.go` | L2 | The receipt rule's Lambda action: the provided.al2023 handler renders the received-message record SES documents and reads the raw body the rule's S3 action wrote. | The message is injected through the documented session operation; real SMTP ingress is the mail-surface work that follows (docs/127 X4). The S3 action's store is s3proxy. |
| `examples/cdk/local-resources/scripts/custom-resources.sh` | L2 | Served custom resources: the Custom::Trigger provider invokes its target through the local Lambda endpoint at start, the provider-framework handler returns its Data and physical id over the response URL, the Custom::AWS handler creates an SES rule set on moto, and the bucket auto-delete handler deletes a real object on its delete leg. | The provider handlers run in their real containers; the AWS SDK calls inside them reach the pinned moto, whose state is memory-only (docs/125 true limit). |
| `examples/cdk/local-resources/scripts/inventory.sh` | L2 | Resource-type inventory: a real synth declares a Custom::Trigger, a provider-framework custom resource, a Custom::AWS SDK call, a bucket auto-delete handler, an SES receipt rule, and the deploy-time-only and MicroVM types; plan reports each as served, deploy-time-only with its docs/125 reason, or refused by name. | The reported types have no local runtime behavior (docs/125 true limit: deploy-time-only resources), and a MicroVM image is an AWS-only service with no emulator. |
| `examples/cdk/local-resources/scripts/ses-receipt.sh` | L2 | SES receipt rule: ses.receive injects one message at a recipient the derived rule accepts; the rule's S3 action writes the raw body under its prefix, and its Lambda action receives the documented received-message record (message id, headers, action, receipt timestamp, no body), which the handler reads back from the bucket. | The message is injected through the documented session operation; real SMTP ingress is the mail-surface work that follows (docs/127 X4). The S3 action's store is s3proxy. |

### I rows

| Row | Class | How it is verified | Fail-closed reason |
| --- | --- | --- | --- |
| `examples/cdk/hello-world/bin/apptheory-hello-world.ts`, `examples/cdk/codebuild-job-runner/bin/app.ts`, `examples/cdk/import-pipeline/bin/app.ts`, `examples/cdk/kinesis-cloudwatch-logs/bin/app.ts`, `examples/cdk/lambda-packaging/bin/app.ts`, `examples/cdk/lambda-role/bin/app.ts`, `examples/cdk/lesser-parity/bin/app.ts`, `examples/cdk/microvm-controller/bin/app.ts`, `examples/cdk/multilang/bin/apptheory-multilang.ts`, `examples/cdk/restv1-router/bin/app.ts`, `examples/cdk/s3-vectors-semantic-search/bin/app.ts`, `examples/cdk/sqs-queue/bin/app.ts` | I | CDK app anchor for the synth row: every CDK example in the tree is synthesized and compared with its pinned template hash (plus focused construct assertions for the six once-uncovered examples, and an official Lambda runtime image invocation of the staged TypeScript and Python assets). | Infrastructure-only: the CDK app entrypoint is synthesized and hash-checked by this row; it has no runtime process to serve, so it is never invoked. |

## Runtime API conformance

The `runtime-api-conformance` row (L2, `scripts/local/runtime_api_conformance.py`)
builds one handler set per language on the real, digest-pinned runtime images and
runs each case twice through the runner's own `invoke` path: once under the
image's Runtime Interface Emulator (`--rie`) and once under the runner's Lambda
Runtime API. It compares status, headers, body bytes, handler error type and
message, the timeout outcome and the initialization-failure outcome, and it
prints every remaining difference. Python is buffered only, because "Lambda
supports response streaming on Node.js managed runtimes. For other languages,
including Python, you can use a custom runtime with a custom Runtime API
integration"
([response streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)).
The suite is described in
[the runner guide](/examples/local-runner/#conformance-suite).

## Preflight

The run stops before any example if:

- DynamoDB Local is not listening and cannot be started from the profile (or,
  with `--external`, does not answer the leased port);
- a DynamoDB client built from the harness environment resolves to an empty
  endpoint (unresolved) or to any endpoint other than the profile's;
- the resolved credentials are not the static dummy keys;
- the example HTTP or auxiliary port is already in use;
- `ListTables` against the profile fails.

The profile's in-memory database is recreated when the harness owns the
container, so every run starts from an empty backend.

The runner rows do not share that container. `apptheory-local --backend dynamodb`
starts its own in-memory DynamoDB Local, from the same digest-pinned image, on
the run's private network. `--backend moto`, `--backend s3proxy` and
`--backend sqs` add the digest-pinned KMS/STS, S3 and ElasticMQ emulators and
provision the assembly's keys, buckets, tables and queues. The runner's
in-container preflight proves every endpoint answers and that no real AWS
hostname resolves. This keeps each runner row isolated from the host-side
examples.

`upload-assets.sh` is a real AWS CLI script and requires an AWS CLI on `PATH`.
The harness runs the host `aws`; it never installs or substitutes one. If `aws`
is missing or cannot start (for example a Homebrew `awscli` whose native library
no longer loads), the row **fails** with a named requirement error instead of
being skipped or reported as passing. The script, its flags and its AWS path are
unchanged.

## Built Lambda assets run in the official runtime

`scripts/verify-cdk-synth.sh` proves the templates are deterministic; it cannot
prove the deployed code starts. LOCAL-A0 found that the hello-world and
multilang TypeScript assets shipped only `ts/dist`, so the handlers failed at
init in a clean Lambda runtime with `ERR_MODULE_NOT_FOUND` for
`@theory-cloud/tabletheory-ts`.

The asset staging now vendors the TypeScript runtime's production dependency
closure (`npm ls --omit=dev --all --parseable`) next to the vendored `dist`, and
the `staged-asset.test.mjs` regression test stages the same tree without a
symlink. `scripts/local/verify-lambda-assets.py` then synthesizes the
hello-world TypeScript/Python stacks and both multilang assets (TypeScript and
Python), finds the asset directories, and invokes each one through the Runtime
Interface Emulator in `public.ecr.aws/lambda/nodejs:24` and
`public.ecr.aws/lambda/python:3.14`. The harness runs this proof as part of the
CDK row.

The script is runnable standalone on a fresh checkout:
`python3 scripts/local/verify-lambda-assets.py`. It requires a running Docker
daemon and installs the `cdk/` and `ts/` dependency trees with `npm ci` when
they are missing, the same prerequisite `scripts/verify-cdk-synth.sh`
provisions, so it does not fail with a bare module-resolution error. Use
`--keep` to inspect the synthesized assets.

The Python assets do not have the init failure: `apptheory` guards
`tabletheory_py` behind the jobs import, so the hello-world and multilang Python
handlers load and answer in the official Python image. The Python assets still
do not vendor `tabletheory_py`, so jobs and rate-limit paths are not available
in them; that is a named gap, not a passing check.

## CI

`.github/workflows/examples-local.yml` runs `make examples-local` with only a
DynamoDB Local service container on `8130` and no AWS secrets. The harness
supplies dummy credentials and `--external` keeps it from starting a second
container. The job does not need an AWS account, role or region. It also runs
`make verify-cdk-synth-location-independent`, which re-synthesizes the examples
from a copy under `$HOME` and requires every pinned hash to match again.

The job runs on `ubuntu-24.04-arm`: the hello-world Go function deploys an arm64
`provided.al2023` bootstrap, and the local runner runs the official image for
the function's declared architecture. On an amd64 host the same function fails
closed with a clear architecture error rather than silently emulating it. The
MCP handler rows build the real Go binaries for linux/arm64 and run them in the
same official runtime image; the moto, s3proxy and ElasticMQ rows start their
profile containers on the CI host's Docker daemon, and the MicroVM workload rows
run as host processes.
