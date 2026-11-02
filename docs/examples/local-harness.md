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
| Local runner | `cmd/apptheory-local` with `internal/localrunner` |
| Self-tests | `scripts/local/test_examples_local.py` |
| CI job | `.github/workflows/examples-local.yml` |

## Classes

- **L1** — runs fully locally; no cloud dependency.
- **L2** — runs locally with an emulator and documented fidelity limits.
- **L3** — exercised as fully as possible locally, plus a named cloud gap that
  is never faked.
- **PENDING-MILESTONE** — a row owned by a later milestone (`A3a`, `A3b`, `A4`,
  `A5a`, `A5b`). It is listed in the run report and never counted as pass.

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
| `examples/mcp/tools-only` (Go) | L1 | Real MCP protocol messages through the testkit transport; named tests must run and pass. |
| `examples/mcp/tools-resources-prompts` (Go) | L1 | Same transport, tools + resources + prompts. |
| `examples/mcp/resumable-sse` (Go) | L1 | Real streaming tool call, disconnect, cursor resume and replay. Warm-container delivery is A3b. |
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

Handler and script rows inside the other CDK examples remain
`PENDING-MILESTONE` (A3b, A4, A5a, A5b) and are never counted as pass.

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
the run's private network; the runner's in-container preflight proves the SDK
resolves to it and that no real AWS hostname resolves. This keeps each runner
row isolated from the host-side examples.

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
closed with a clear architecture error rather than silently emulating it.
