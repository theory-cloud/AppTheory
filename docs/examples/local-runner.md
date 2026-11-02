---
title: Run an app locally
---

# Run an app locally

`apptheory local` runs an AppTheory app's **real Lambda handlers** on your
machine. The app's existing CDK definition is the only routing source: the
command synthesizes the app, reads the cloud assembly, starts each function in
the official AWS Lambda runtime image, and serves the HTTP API v2, REST API v1
and Function URL surfaces it found. There is no second hand-written route table.

```bash
# Serve the app in the background, then use the printed URLs.
go run ./cmd/apptheory-local --app examples/cdk/hello-world -c lang=go \
  --profile scripts/local/examples-local.json --backend dynamodb

# Print the derived surface without starting anything.
go run ./cmd/apptheory-local plan --app examples/cdk/hello-world -c lang=go --json
```

The command is language-neutral. A Go, TypeScript or Python handler is served by
the same binary because the runtime comes from the CDK stack, not from the
caller: `provided.al2023` for Go, `nodejs:24` for Node, `python:3.14` for Python.
`make examples-local` runs the three hello-world rows this way.

## Run your own app

The commands above run from this repository. An app that lives anywhere else
uses the same command; `--app` is the app's CDK directory and `--profile` pins
the runtime images:

```bash
# Run a released module without checking out AppTheory.
go run github.com/theory-cloud/apptheory/v6/cmd/apptheory-local@<version> \
  --app ~/code/my-app --profile ~/code/my-app/local-profile.json

# Or install the command once.
go install github.com/theory-cloud/apptheory/v6/cmd/apptheory-local@<version>
apptheory-local --app ~/code/my-app --profile ~/code/my-app/local-profile.json
```

`<version>` is a release that contains the command (v6.5.0 or later);
`go list -m -versions github.com/theory-cloud/apptheory/v6` lists released
versions.

Before that release, run the command from a sibling AppTheory checkout (the
same model as FaceTheory Phase 3):

```bash
# Run from the checkout without installing anything.
go run -C ~/code/AppTheory ./cmd/apptheory-local \
  --app ~/code/my-app --profile ~/code/my-app/local-profile.json

# Or build the command once and keep it outside the checkout.
go build -C ~/code/AppTheory -o ~/bin/apptheory-local ./cmd/apptheory-local
~/bin/apptheory-local --app ~/code/my-app --profile ~/code/my-app/local-profile.json
```

TypeScript and Python apps need a Go toolchain only to run `apptheory-local`;
their handlers keep running in the official Node or Python runtime image and
never see the Go toolchain. A Go handler is built by its CDK bundling step
before the runner starts, as it is for a deployment.

### What your app needs

- `cdk.json` and a synthesized HTTP API v2, REST API v1 or Function URL. The
  CDK definition is the only routing source.
- A local CDK CLI in the app directory: `npm install --save-dev aws-cdk`. The
  runner executes `node_modules/.bin/cdk`; it does not install packages.
- A local profile passed with `--profile`. It is required for `run` (and for
  any served function), because it pins every runtime image by digest.

A minimal profile only names the images the app uses, plus the Python image for
the in-container preflight. This one runs a Node app with no DynamoDB backend:

```json
{
  "profile": {
    "lambda": {
      "images": {
        "node": {
          "tag": "public.ecr.aws/lambda/nodejs:24",
          "digest": "sha256:8466f17dcfbec19afcfefff53964fac7bc3f7975fa132d5fd74dce53004827d0",
          "pinned": "2026-11-01"
        },
        "python": {
          "tag": "public.ecr.aws/lambda/python:3.14",
          "digest": "sha256:51985f11b2fb1949619bda27d121f38ef7d4db64423ca6189ab1d7e632527d27",
          "pinned": "2026-11-01"
        }
      }
    }
  }
}
```

Add a `go` pin for a Go app (`provided:al2023`) or use `python` for a Python
app. Add `dynamodbLocal` and an `endpoints.dynamodb` entry when you pass
`--backend dynamodb`; the [configuration reference](/reference/local-runner-configuration/)
has the full schema. The runner validates the profile before it synthesizes
anything: a missing image class, an unpinned tag or malformed JSON fails with
the profile path and the reason.

## What "locally" means

- **No AWS credentials.** The runner sets static dummy keys and removes every
  inherited `AWS_*`, `CDK_*` and proxy variable from the processes it starts.
- **No real AWS.** Function containers get closed DNS (`127.0.0.2`) and only the
  `/etc/hosts` entries the runner adds. Every SDK endpoint is overridden to a
  local URL. A preflight probe inside the run network must prove that a real AWS
  hostname does not resolve before the first handler starts.
- **No operator environment variables.** Endpoints, image pins and backend
  settings come from flags or the checked-in local profile
  (`scripts/local/examples-local.json`).

## How it works

1. **Synthesize.** `cdk synth` runs with dummy credentials, a fixed account and
   region (`123456789012` / `us-east-1`) and the app's local CDK CLI. Context
   passed with `-c key=value` reaches CDK unchanged.
2. **Derive.** The cloud assembly is read, not the deployed stack:
   - `AWS::Lambda::Function`: runtime, handler, architecture, memory, environment
     and the CDK asset directory (or inline `Code.ZipFile`);
   - `AWS::ApiGatewayV2::Api` (`ProtocolType: HTTP`), routes and proxy
     integrations;
   - `AWS::ApiGateway::RestApi`, its resource tree, methods and stage;
   - `AWS::Lambda::Url` Function URLs.
3. **Preflight.** A probe container on the run's private network proves the
   dummy credentials, endpoint reachability, the DynamoDB SDK endpoint and
   closed DNS.
4. **Run.** One container per served function, from the official image for its
   runtime, digest-pinned in the profile. Handlers run under the embedded
   Runtime Interface Emulator; the transport invokes
   `/2015-03-31/functions/function/invocations`.
5. **Serve.** One loopback listener per API (and per Function URL) builds the
   provider event for the matched route, invokes the handler and decodes the
   response — including the RIE's buffered streaming frame.
6. **Shut down.** `Ctrl-C` (`SIGINT`) or `SIGTERM` stops accepting requests,
   force-removes the run's containers (which aborts an in-flight invocation),
   closes the listeners, removes the network and deletes the scratch directory.
   A `SIGKILL` cannot be caught: after one, `apptheory-local down --app <dir>`
   removes everything that run left behind.

## Capability matrix

Classes follow the repository's local-execution convention: **L1** runs fully
locally, **L2** runs locally with an emulator and documented limits, and **L3**
is exercised as fully as possible with a named cloud gap. `apptheory local`
serving a surface is not by itself a class: the class belongs to an example, and
the harness records it.

| Capability | Local runner | Notes |
| --- | --- | --- |
| HTTP API v2 (`AWS::ApiGatewayV2::Api`, HTTP) | Supported (L1) | v2.0 events with `routeKey`, `rawPath`, `requestContext.http`, cookies and path parameters. |
| REST API v1 (`AWS::ApiGateway::RestApi`) | Supported (L1) | v1 events with `resource`, `multiValueHeaders`, `multiValueQueryStringParameters` and the stage. |
| Lambda Function URL | Supported (L1) | Function URL events carry `routeKey: "$default"` and a `.lambda-url.<region>.on.aws` domain, which the runtime uses to tell them apart from HTTP API v2. |
| Response streaming (`awslambda.streamifyResponse`, SSE) | Supported, **buffered** (L3) | The RIE buffers the whole response and returns metadata JSON + eight NUL bytes + body. The transport reproduces status, headers and complete bytes; it never reproduces chunk timing. |
| Inline `Code.ZipFile` | Supported (Node, Python) | Materialized under the run scratch directory before the container starts. |
| arm64 `provided.al2023` | Supported (L1) | Uses the host-arch image; a bootstrap built for the other architecture fails closed with a clear error. |
| DynamoDB Local | Supported (L2) | `--backend dynamodb` starts the profile's digest-pinned `amazon/dynamodb-local` on the run network; SDK clients resolve through `AWS_ENDPOINT_URL_DYNAMODB`. |
| Other emulators (SQS, S3, KMS, ...) | Endpoint injection only | Pass `--endpoint service=url` and `--add-host name=address`; the profile names the environment variables. Example wiring is A4. |
| WebSocket APIs | Not served (A3b) | A WebSocket API in the assembly fails the run with a clear error. |
| CloudFront / CloudFront Functions | Not served (A5) | The Function URL behind a distribution runs; the distribution itself is reported as not served. |
| REST `MOCK` integrations | Not served (A3b) | Fails closed instead of returning a synthesized response. |
| Authorizers (REST, HTTP API, Function URL `AWS_IAM`) | Not served | Fails closed; the local transport must never bypass a real authorizer. |
| Lambda layers, container-image functions | Not served | Fail closed when a served function needs them. |
| CloudFormation-expression environment values | Not resolved (A4) | A served function whose environment value is `Ref`/`GetAtt` fails with the variable names; only literal values are injected. |
| CloudFormation-expression `MemorySize`/`Timeout` | Not resolved | A served function whose limit is `Ref`/`GetAtt`/`Fn::If` fails with the property named; the AWS defaults apply only when the property is absent. |
| Stage-prefixed URLs (`/prod/...`) | Not honoured | The stage is reported in the event; URLs are served at the root, as API Gateway does for custom domains. |
| Multiple APIs in one stack | Supported | Each API gets its own listener and route table, so `ANY /` surfaces never shadow each other. |

## Known gaps

- **Streaming is buffered.** A handler that streams is not incremental under the
  Runtime Interface Emulator. Tests can assert the complete bytes and the status
  and headers, never the timing of individual chunks.
- **WebSocket events** are not delivered; A3b owns a local WebSocket front end.
- **CloudFront** is not emulated; A5 owns the local gateway.
- **Event sources** (SQS, Kinesis, scheduled rules, DynamoDB streams) are not
  delivered by the HTTP transport. Those functions are listed as "not served
  locally" by `plan` and by the run log.
- **CloudFormation intrinsics in function environment** are not resolved. Apps
  that pass a table name or bucket name through `Ref` are A3b/A4 work. The same
  applies to `MemorySize` and `Timeout`: an expression is refused rather than
  replaced by the AWS default.
- **One container per function.** In-flight invocations are bounded to 32 and
  queue behind the function's container; the local runner is not a load test.

## Requirements

- Go 1.27+ to build or run the `apptheory-local` command. TypeScript and Python
  handlers never need Go: they run in their own runtime images.
- Docker (on macOS, colima) with the daemon running. The runner creates one
  private network per run and publishes the RIE port on `127.0.0.1` only.
- The app's CDK CLI installed in the app directory
  (`node_modules/.bin/cdk`); run `npm ci` there once. The runner does not
  install packages.
- Bind-mounted code must live under `$HOME` or the working directory (the
  checkout): colima does not share `/private/tmp`. The runner refuses a mount
  outside those roots.

## Where to next

- [Local examples harness](/examples/local-harness/) — the classification
  manifest and `make examples-local`.
- [Local runner configuration](/reference/local-runner-configuration/) — flags,
  profile schema and the exact container environment and events the runner
  generates.
