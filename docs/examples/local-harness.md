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
| CI job | `.github/workflows/examples-local.yml` |

## Requirements

- Docker (on macOS, colima) with the daemon running, for DynamoDB Local, the
  runner's emulator containers and the official Lambda runtime images.
- Node.js 24+ and npm, for the TypeScript examples and each example's CDK CLI.
- An AWS CLI on `PATH` that starts. `upload-assets.sh` runs the real host CLI;
  the harness does not install a fallback, and a missing or unusable CLI fails
  that row with a named requirement error.
- Python 3.14 to run the harness and the repo's Go toolchain for the runner
  rows.

## Classes

- **L1** — runs fully locally; no cloud dependency.
- **L2** — runs locally with an emulator and documented fidelity limits.
- **L3** — exercised as fully as possible locally, plus a named cloud gap that
  is never faked.
- **PENDING-MILESTONE** — a row owned by a later milestone. It is listed in
  the run report and never counted as pass; the current manifest has no pending
  row.

A handler that a CDK definition would connect to a cloud event source is L3
when the harness invokes it with a generated event, because that event source is
the named gap. A handler-only row has no deployment surface to emulate — the
handler is its entire surface — so it is L1 unless a different named gap
applies. `examples/mcp/resumable-sse` is handler-only and L3 for incremental SSE
delivery, not for an event source.

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

## What runs in A1

| Row | Class | How it is verified |
| --- | --- | --- |
| `examples/testkit/ts.mjs`, `ts-streaming.mjs`, `py.py` | L1 | The real runtime code handles HTTP API v2, EventBridge work, DynamoDB Stream records and Function URL streaming; the harness asserts the example's PASS marker. |
| `examples/mcp/tools-only` (Go) | L1 | The real binary runs in a warm `provided.al2023` container; the harness sends MCP HTTP API v2 events for initialize, tools/list, tools/call and two refusals. |
| `examples/mcp/tools-resources-prompts` (Go) | L1 | Same warm container; tools, resources/read and prompts/get are asserted, plus an invalid-method refusal. |
| `examples/mcp/resumable-sse` (Go) | L3 | A warm container keeps the MCP session; the buffered stream's priming, progress and result ids are asserted, and Last-Event-ID replay returns the progress events and final result. It is handler-only (`--handler-dir`, no CDK definition). Gap: incremental SSE delivery (the RIE buffers). |
| `examples/mcp/tools-only-ts`, `tools-only-py` | L1 | The real MCP server and its exported Lambda entry, driven by the MCP testkit. |
| `examples/migration/rate-limited-http` | L1 | A real `net/http` process against DynamoDB Local: the `rate-limits` table is created from `pkg/limited`, 60 requests are allowed with the expected headers, and the 61st is the 429 refusal. |
| Every CDK app entrypoint | I | `scripts/verify-cdk-synth.sh` synthesizes the stack, checks its pinned template hash, and runs focused construct assertions for the six examples that were never synthesized in CI. |

### A3a: hello-world through the local runner

The three hello-world handler rows are no longer pending. Each row runs
`apptheory-local` against the app's own CDK definition and asserts real HTTP
behaviour; nothing is imported in process.

| Row | Class | How it is verified |
| --- | --- | --- |
| `examples/cdk/hello-world/handlers/go/main.go` | L1 | `cdk synth` derives the HTTP API v2 route table; the `provided.al2023` arm64 container runs the real Go handler; `GET /hello/AppTheory` returns the handler's JSON with the client-supplied `x-request-id`, `GET /` answers, `POST /hello/AppTheory` is the 405 refusal and `GET /missing` is the 404 refusal. The row then asserts the run removed its containers and network. |
| `examples/cdk/hello-world/handlers/ts/handler.mjs` | L1 | Same assertions in the `nodejs:24` container; the handler reports `runtime: "ts"`. |
| `examples/cdk/hello-world/handlers/py/handler.py` | L1 | Same assertions in the `python:3.14` container; the handler reports `runtime: "py"`. |

The TypeScript app module row is `coveredBy` the handler row. The runner is
described in [Run an app locally](/examples/local-runner/) and its generated
configuration in
[Local runner configuration](/reference/local-runner-configuration/).

### A3b: HTTP, REST, MCP and compiled handlers

The fourteen A3b rows run through the same runner. The MCP examples have no CDK
definition, so their rows use `invoke --handler-dir` with explicit MCP HTTP
events; no route table is synthesized for them.

| Row | Class | How it is verified |
| --- | --- | --- |
| `examples/cdk/multilang/handlers/{go,py,ts}` | L3 | Each language's own HTTP API v2 listener serves root, hello, a 405 and a 404. The Go REST API serves hello and three buffered SSE events. Each language's WebSocket APIs serve real frames through the `$connect` authorizer, the custom `chat` route, `$default` and the `@connections` management API. The Go row also invokes the CDK SQS, DynamoDB stream and EventBridge handlers. Gap: managed event-source delivery. |
| `examples/cdk/lesser-parity/handlers/{api,graphql,sse}` | L1/L3 | The REST API serves the catch-all, the dedicated GraphQL route, the buffered SSE route and the declared CORS preflight. `TABLE_NAME` and `QUEUE_URL` are resolved local values. The SSE row is L3 for buffered delivery. |
| `examples/cdk/lesser-parity/handlers/worker.mjs` | L3 | A generated two-record SQS batch is processed by the real handler; the invalid record is returned as a partial batch failure. Gap: SQS event delivery. |
| `examples/cdk/restv1-router/handlers/{api,graphql,inventory}` | L1 | Catch-all GET/POST, the GraphQL route with GET falling through, and inventory GET/PUT/DELETE with path parameters, a 404 refusal and CORS preflight. |
| `examples/cdk/restv1-router/handlers/sse.mjs` | L3 | The real `streamifyResponse` handler returns all 10 events and `[DONE]` as one buffered body. Gap: incremental SSE delivery. |
| `examples/cdk/lambda-role/handlers/index.ts` | L1 | The compiled asset serves the basic, tracing and dynamic functions; each returns the expected 200 payload. |
| `examples/cdk/lambda-role/handlers/encrypted.ts` | L2 | The compiled handler round-trips plaintext through moto KMS and reports `match=true`. Gap: emulated KMS (no HSM, key policies or grants). |
| `examples/cdk/lambda-role/handlers/custom.ts` | L3 | The compiled handler writes and reads an object on s3proxy; the SSM lookup fails closed to `not-configured`. Gap: SSM Parameter Store; S3 is emulated. |
| `examples/cdk/lambda-role/handlers/authorizer.ts` | L2 | The real policy function runs behind a REST TOKEN authorizer (60 s cache), a REST REQUEST authorizer over a header and a query identity source, and an HTTP API IAM-policy authorizer (payload format 1.0). Allow invokes the method and its stringified context reaches the integration; Deny is 403, the documented `Unauthorized` error is 401, an invalid policy is 500 and a missing identity source is 401 without invoking. The function counts its own invocations in its context, so an unchanged count proves the cached policy was reused without invoking the function until `clock.advance` passes `AuthorizerResultTtlInSeconds`; the cached policy is re-evaluated per method, so `GET /token-other` is 403 inside the TTL and 200 after it. | IAM policy evaluation is a docs/125 true limit; the authorizer's returned policy is matched narrowly against the method ARN. |

### A4: event sources and data

The A4 rows use `apptheory-local session`, which starts every function the CDK
definition targets and answers a JSON command protocol. Messages come from
ElasticMQ, items and stream records come from DynamoDB Local, and every event
shape is built from the example's own CDK definition.

| Row | Class | How it is verified |
| --- | --- | --- |
| `examples/cdk/sqs-queue/handlers/producer.mjs` | L3 | `producer.mjs` sends through the real SQS SDK to ElasticMQ; the received body carries `eventType`, `payload` and a timestamp, and its `messageId` matches the handler's response. Gap: managed SQS event-source mapping. |
| `examples/cdk/sqs-queue/handlers/worker.mjs` | L3 | Two messages are received from `events-queue` and invoked as the CDK mapping's batch; `worker.mjs` reports only the simulated failure as a partial batch failure. Gap: managed polling/visibility/deletion. |
| `examples/cdk/sqs-queue/handlers/dlq-handler.mjs` | L3 | `events-queue` redrives a failing message to `events-queue-dlq` after `maxReceiveCount=5`; `dlq-handler.mjs` processes the message actually read from the DLQ and acknowledges it. Gap: managed SQS mapping. |
| `examples/cdk/import-pipeline/handlers/{ingest,worker}/main.go` | L3 | A real object is written to s3proxy and the CDK `IngestRule` EventBridge event is built from it. Ingest writes the job META and three work messages; worker consumes the real messages and writes SUCCEEDED/FAILED records. The raw PAN is absent and the stored error is masked. Gaps: S3 → EventBridge delivery and CodeBuild. |
| `examples/cdk/kinesis-cloudwatch-logs/handlers/go/main.go` | L3 | A gzip+base64 CloudWatch Logs subscription payload is built from local log content and accepted; a malformed Kinesis record is returned as its sequence-number partial failure. Gap: managed Kinesis/CloudWatch Logs delivery. |
| `examples/cdk/microvm-controller/controller/main.go` | L3 | The CDK authorizer refuses missing, wrong and tenant-less credentials. `list` and `run` reach the managed provider boundary; `get`, `suspend`, `resume`, `terminate`, `auth-token`, `shell-auth-token` and `invoke` read the TableTheory registry on DynamoDB Local and refuse a missing session. Gap: managed MicroVM provider. |
| `examples/cdk/microvm-controller/workloads/go/main.go`, `py/server.py`, `ts/server.js` | L1 | Each workload server runs as a host process and answers GET and POST with its HTTP contract. `server.ts` is covered by the built `server.js` the image ships. |
| `examples/cdk/s3-vectors-semantic-search/handler/main.go` | L3 | Health reports the CDK vector index; missing/wrong auth, missing query and invalid `top_k` are refused; authorized seed/search reach the closed Bedrock endpoint with `vectorstore.embedding_failed`. Gap: managed S3 Vectors/Bedrock. |
| `examples/microvm-conformance/run_local.py` | L3 | The real dry-run and token-leak scanner pass; live mode runs against the local controller, passes its auth refusals and stops at the managed provider boundary. Gap: managed MicroVM provider; no EqualToAI/Host live proof claimed. |

The `multilang` Go row's additional event assertions use the same session: the
SQS mapping, the DynamoDB stream record built from a real local write, and both
EventBridge rules are invoked and their responses asserted. Its remaining gap is
WebSocket frames and managed delivery.

Handler and script rows inside the remaining CDK examples are now classified;
no row is `PENDING-MILESTONE`.

LOCAL-A5b wires the CloudFront origins and adds no new manifest entry beyond the
two ssr-site script rows. The gateway's generated-function conformance still runs
in `go test` (and therefore in `make test`/`make rubric` and CI); the example
rows below run the real production CDK apps through the gateway.

| Example | Class | Verified | Named gap |
| --- | --- | --- | --- |
| `examples/cdk/ssr-site` | L2 | The origin group fails over from the S3 HTML primary (403 under OAC) to the real SSR handler; the viewer-response function echoes the viewer `x-request-id`; `/marketing/` proves the viewer-request rewrite and `/isr` origin path; the assets and hydration deployments are served from s3proxy with ETag/Last-Modified; full and ranged HEAD (206 with `Content-Range`), matching and non-matching `If-None-Match` GETs (304 with the origin's validators, and 200 with the body), OPTIONS and a missing object (403 `AccessDenied`) are asserted. Caching: the static-assets behavior answered a miss then a hit with `x-cache`/`age`, the CACHING_DISABLED SSR behavior never cached, an invalidation through the local API and the `aws` CLI removed the object, and the clock past the TTL was a miss. | CloudFront edge network and edge TLS (docs/125 true limits); response streaming is buffered by the RIE. |
| `examples/cdk/ssr-only-provided-assets-site` | L2 | The real handler is reached through the `AWS_IAM` Function URL with local SigV4 OAC signing and echoes the viewer request id into the HTML; the provided bucket serves `app.js`, `site.css` and `probe.txt`; a missing object is 403 under OAC and OPTIONS is refused. | CloudFront edge network (docs/125 true limit); IAM policy evaluation is not emulated. |
| `examples/cdk/path-routed-frontend` | L2 | The generated SPA function rewrites `/l/...` and `/auth/...` to each prefix's `index.html`, files with an extension are served unchanged, the external API origin is mapped to a loopback listener the row starts and receives the documented origin-request shape (origin path `/prod`, origin Host, method) with a CACHING_DISABLED `x-cache` miss, POST is refused by `AllowedMethods`, and a missing file is 403 under OAC. | The example ships no SPA build output, so probe objects are written through the runner to the provisioned buckets. CloudFront edge network and edge TLS (docs/125 true limits). |
| `examples/cdk/media-cdn` | L2 | The public distribution serves a probe object from its provisioned bucket with ETag and content type; a missing object serves the configured custom error page with the configured status. The s3proxy 403 carries `Content-Type` and `x-amz-request-id` but no `Cache-Control` max-age/s-maxage, so the page is served on both requests and the second is a miss (a 403 is cached only with that header; the `ErrorCachingMinTTL` expiry proof for a 404 origin lives in the localcloudfront unit tests). When the page itself is unavailable the status comes from the pages origin (403 `AccessDenied`). The private trusted-key-group distribution requires a signature: an unsigned request is 403, a canned-policy SHA-256 URL and a custom-policy signed cookie are served, a query string added after signing is 403, an unknown `Key-Pair-Id` is 403, OPTIONS passes unsigned, and the expired URL is 403 after `clock.advance`. The row generates an RSA key pair at run time and passes the public key through CDK context; no private key is committed. | CloudFront edge network and edge TLS (docs/125 true limits); the example ships no media, so probe objects are used. |
| `examples/cdk/edge-gateway` | L2 | Four Lambda@Edge associations run through the real Node containers: a viewer-request uri rewrite (and a header returned without `key`, which CloudFront inserts with initial capitalization), an origin-request generated response that is cached without a second invocation (the function counts its own invocations), an origin-response body replacement and header, and a viewer-response header that stays out of viewer-request generated responses and custom error pages. `IncludeBody` exposes the base64 body to both request events; an origin rewrite reaches the other origin the assembly declares; a runtime 2.0 CloudFront Function reads get/exists/meta from its key value store; geo restriction serves `US`, refuses `JP` with 403 and serves an undetermined location; and the origin decrypts the field-level encryption ciphertext with the real AWS Encryption SDK and the run-time private key. | CloudFront edge network and edge TLS (docs/125 true limits); the viewer is plain HTTP, so the field-level encryption HTTPS/method/origin-protocol preconditions are reported, not enforced. The field-level encryption row needs the AWS Encryption SDK on the harness interpreter (`scripts/local/requirements-examples.txt`). |
| `examples/cdk/ssr-site/scripts/generate-assets-manifest.mjs` | L2 | The generator runs against the real `assets` directory, its `hello.txt` sha256 and byte count are asserted, and the served asset through the gateway matches the manifest. | CloudFront edge network (docs/125 true limit); the manifest is matched to the gateway response, not a deployed bucket. |
| `examples/cdk/ssr-site/scripts/upload-assets.sh` | L3 | The host AWS CLI on `PATH` runs `s3 sync` and `s3 cp` against the session's s3proxy endpoint with dummy credentials; the gateway serves the assets and the generated manifest with the script's cache-control and content type. A CLI that is missing or cannot start fails the row with a named requirement error, never a skip. | s3proxy has no IAM, bucket policy or event notifications. CloudFront edge network (docs/125 true limit). |

### R4: layers and container images

`examples/cdk/lambda-packaging` is the layer and container-image example. The
two zip functions declare a CDK `LayerVersion`; the three image functions declare
a CDK `DockerImageAsset` and read `IMAGE_VALUE` from a Dockerfile build
argument.

| Row | Class | How it is verified |
| --- | --- | --- |
| `examples/cdk/lambda-packaging/handlers/node/app.js` | L1 | The real runner extracts the Node and Python layers into `/opt`, builds the three images with `docker build` before serving, and serves one HTTP API. The Node handler imports `layer-greeting` from `/opt/nodejs/node_modules`, executes `/opt/bin/layer-tool` from `PATH` and reports `/opt/bin` and `/opt/lib`; the Python handler imports `layer_tool` from `/opt/python`, executes its own `/opt/bin/layer-tool` and reports `PYTHONPATH`, `PATH` and `LD_LIBRARY_PATH`; the Go, Node and Python image handlers return the value the Dockerfile wrote from `IMAGE_VALUE`, so a stale or missing image cannot pass. |
| `examples/cdk/lambda-packaging/handlers/python/app.py`, `images/{go,node,python}`, `layers/python/python/layer_tool.py`, `Layers/*/bin/layer-tool` | L1 | Covered by the Node handler row: each is executed inside the same run. |

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
