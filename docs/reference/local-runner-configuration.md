---
title: Local runner configuration
---

# Local runner configuration

This page describes exactly what `apptheory-local` generates: the CDK and
Docker commands it runs, the environment it injects, the provider events it
builds and the responses it accepts. Everything here is deterministic and
checked by the runner's unit tests.

## Command surface

```
apptheory-local [run] --app <cdk-app-dir> [flags]   serve the app locally
apptheory-local plan  --app <cdk-app-dir> [flags]   synthesize and print the derived surface
apptheory-local down  --app <cdk-app-dir> [flags]   remove this app's leftover containers and networks
```

`run` is the default when no subcommand is given. TypeScript, Python and Go
apps use the same command; the handler runtime comes from the CDK stack.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--app DIR` | required | CDK app directory (contains `cdk.json`). |
| `-c`, `--context key=value` | none | Passed to `cdk synth` unchanged. Repeatable. |
| `--assembly DIR` | none | Read an existing cloud assembly instead of synthesizing. |
| `--scratch DIR` | `<user cache>/apptheory-local` | Synthesis output and materialized inline code. Must be under `$HOME` or the working directory. Each run's subdirectory is removed when the command exits. |
| `--profile PATH` | none | Local execution profile with digest-pinned images and endpoint names. Required for `run`. |
| `--image class=ref` | profile | Override a runtime image pin (`go`, `node`, `python`). The reference must be `…@sha256:<64 hex>`. |
| `--endpoint service=url` | none | Inject a local AWS endpoint for `service` (`dynamodb`, `sqs`, …). Repeatable. |
| `--add-host name=address` | none | Extra `/etc/hosts` entry inside function containers. Repeatable. |
| `--backend dynamodb` | none | Start the profile's DynamoDB Local on the run network. Repeatable. |
| `--port-base N` | ephemeral | Bind the API listeners at `N`, `N+1`, …; `0` asks the OS for free ports. |
| `--name-prefix PREFIX` | derived from the app path | Container and network names. Must be unique per run. |
| `--max-concurrency N` | 32 | In-flight invocations, `1..32`. Values above 32 are refused. |
| `--json` | off | `plan`: print the derived surface as JSON on stdout; progress goes to stderr. |

Exit codes: `0` success, `1` a run/plan failure, `2` a usage error.

Run output is stable enough to script:

```
function HandlerFunction0D87A48C (provided.al2023, public.ecr.aws/lambda/provided:al2023@sha256:…) ready on 127.0.0.1:49xxx
serving httpv2 ApiCD79AAA0 at http://127.0.0.1:8131
local-run: ready
…
shutting down: removing 1 container(s) and network …
```

`plan --json` emits:

```json
{
  "assemblyDir": "/…/cdk.out",
  "functions": [{"logicalId": "…", "runtime": "provided.al2023", "architecture": "arm64", "memoryMb": 256, …}],
  "apis": [{"class": "httpv2", "logicalId": "…", "stage": "$default", "routes": [{"method": "ANY", "path": "/{proxy+}", "function": "…", "streaming": false}]}],
  "functionUrls": [],
  "skipped": [{"logicalId": "…", "kind": "AWS::Lambda::Function", "reason": "…"}]
}
```

## Local execution profile

`scripts/local/examples-local.json` is the checked-in profile. The runner reads
three sections; the harness validates the same values.

```json
{
  "profile": {
    "dynamodbLocal": {
      "image": "amazon/dynamodb-local@sha256:7ef4a2c4…",
      "port": 8130
    },
    "lambda": {
      "images": {
        "go":     {"tag": "public.ecr.aws/lambda/provided:al2023", "digest": "sha256:2dc0f1f2…", "pinned": "2026-11-01"},
        "node":   {"tag": "public.ecr.aws/lambda/nodejs:24",       "digest": "sha256:8466f17d…", "pinned": "2026-11-01"},
        "python": {"tag": "public.ecr.aws/lambda/python:3.14",      "digest": "sha256:51985f11…", "pinned": "2026-11-01"}
      }
    },
    "endpoints": {
      "dynamodb": {"container": "dynamodb-local", "env": ["AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_DYNAMODB", "DYNAMODB_ENDPOINT", "DDB_ENDPOINT"]}
    }
  }
}
```

Rules the runner enforces:

- every image is `tag@sha256:<64 hex>`; a tag-only pin is refused;
- the `go` pin must be a `public.ecr.aws/lambda/provided:` image, `node` a
  `nodejs:` image and `python` a `python:` image;
- `AWS_ENDPOINT_URL` in a service's `env` list is ignored: the runner sets the
  global override itself (the single configured endpoint, or a closed local port
  when zero or several are configured), and service-specific names always win.

## CDK synthesis

`cdk synth` runs in `--app`:

```
node_modules/.bin/cdk synth --quiet --no-notices --no-version-reporting \
  -o <scratch>/cdk.out [-c key=value …]
```

with this clean environment (everything else is inherited only if it is not
`AWS_*`, `CDK_*` or a proxy variable):

```
AWS_REGION=us-east-1
AWS_DEFAULT_REGION=us-east-1
AWS_ACCESS_KEY_ID=dummy
AWS_SECRET_ACCESS_KEY=dummy
AWS_EC2_METADATA_DISABLED=true
AWS_CONFIG_FILE=/dev/null
AWS_SHARED_CREDENTIALS_FILE=/dev/null
CDK_DEFAULT_ACCOUNT=123456789012
CDK_DEFAULT_REGION=us-east-1
TS_NODE_TRANSPILE_ONLY=1
```

`TS_NODE_TRANSPILE_ONLY=1` keeps local synthesis independent of a stale
`cdk/node_modules`; `make verify-cdk-synth` owns type checking.

## Derived surface

| Template resource | Handling |
| --- | --- |
| `AWS::Lambda::Function` with `Metadata["aws:asset:path"]` | Runs from the assembled asset directory. |
| `AWS::Lambda::Function` with `Code.ZipFile` | Materialized as `<module>.js` / `<module>.py` under `<scratch>/inline/<logicalId>/`. |
| `AWS::ApiGatewayV2::Api` (`ProtocolType: HTTP`) + `Route` + `AWS_PROXY` `Integration` | Served as HTTP API v2. `$default` routes become a catch-all. |
| `AWS::ApiGateway::RestApi` + `Resource` tree + `Method` + `AWS_PROXY` integration | Served as REST API v1 at the path reconstructed from the resource tree. `ResponseTransferMode: STREAM` and `/response-streaming-invocations` are marked streaming. |
| `AWS::Lambda::Url` (`AuthType: NONE`) | Served as a Function URL listener. `InvokeMode: RESPONSE_STREAM` is marked streaming (buffered). |
| `AWS::CloudFront::Distribution`, `AWS::CloudFront::Function` | Reported as not served. |

The run fails, naming the construct, on:

- a WebSocket API (`ProtocolType: WEBSOCKET`), or any API Gateway authorizer;
- a route or method whose authorization is not `NONE`, or that carries an
  authorizer id;
- an integration that is not `AWS_PROXY`, or HTTP API payload format other than
  `2.0`;
- a Function URL with an auth type other than `NONE`;
- a served function with no local asset, a container image, an inline code type
  the runtime cannot load, Lambda layers, an unsupported runtime, a
  CloudFormation-expression environment value, or a CloudFormation-expression
  `MemorySize`/`Timeout` (the AWS defaults apply only when the property is
  absent);
- an assembly with no HTTP API v2 route, REST v1 route or Function URL at all.

Functions that no supported route targets are listed under `skipped` with the
reason; they are never silently dropped.

## Container environment

Each function container is started with:

```
docker run -d --name <prefix>-<logicalId> --network <prefix>-net --dns 127.0.0.2 \
  --add-host <service>:<address> -p 127.0.0.1::8080 --memory <MemorySize>m \
  -v <code>:/var/task:ro -e KEY=VALUE … <image> <handler>
```

Environment, in order (later wins):

1. the function's `Environment.Variables` from the template (literal strings
   only);
2. the runner-owned values below.

| Variable | Value |
| --- | --- |
| `AWS_REGION`, `AWS_DEFAULT_REGION` | `us-east-1` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `dummy` |
| `AWS_EC2_METADATA_DISABLED` | `true` |
| `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE` | `/dev/null` |
| `AWS_ENDPOINT_URL_<SERVICE>` (and the profile's alias names) | the configured endpoint |
| `AWS_ENDPOINT_URL` | the single endpoint, or `http://127.0.0.1:1` when zero or several are configured |

When a template variable is replaced, the run prints
`function <id>: runner-owned environment overrides template values for <names>`.
A `AWS_SESSION_TOKEN` is never injected.

`--backend dynamodb` starts
`amazon/dynamodb-local@sha256:… -jar DynamoDBLocal.jar -sharedDb -inMemory` on
the run network and adds `dynamodb-local:<network address>` to every function
container's `/etc/hosts`, because closed DNS cannot resolve container names.

## Preflight

Before the first handler starts, a probe container from the pinned Python image
runs on the same network with the same environment. It must report:

- credentials are the `dummy` static keys and no session token is present;
- every configured endpoint host resolves and answers an HTTP request;
- `boto3` (from the runtime image) resolves DynamoDB to the configured local
  endpoint and `ListTables` succeeds;
- `dynamodb.us-east-1.amazonaws.com`, `s3.amazonaws.com` and
  `sqs.us-east-1.amazonaws.com` do **not** resolve.

Any failure stops the run before an app handler is invoked. Endpoints whose host
is a public AWS domain are refused earlier, on the host.

## Generated events

One event is sent per request. Fixed values: account `123456789012`, region
`us-east-1`, stage from the stack (`$default` or the REST stage), and a fresh
32-hex-character request id that also appears in `requestContext.requestId`.

**HTTP API v2** — `version`, `routeKey` (the matched template, e.g.
`ANY /{proxy+}`, or `$default`), `rawPath`, `rawQueryString`, lower-cased
`headers`, `cookies` (split on `;`), `queryStringParameters`,
`pathParameters`, `body`, `isBase64Encoded`, and
`requestContext.http` (`method`, `path`, `protocol`, `sourceIp`, `userAgent`).

**REST API v1** — `resource` (the matched template), `path`, `httpMethod`,
`headers`, `multiValueHeaders`, `queryStringParameters`,
`multiValueQueryStringParameters`, `pathParameters`, `body`,
`isBase64Encoded`, and `requestContext` (`resourcePath`, `resourceId`,
`httpMethod`, `stage`, `path`, `protocol`, `requestId`, `identity.sourceIp`,
`identity.userAgent`).

**Function URL** — the v2 shape with `routeKey: "$default"` and
`requestContext.domainName` ending in
`.lambda-url.us-east-1.on.aws`; it carries no `pathParameters`. The AppTheory
runtime uses the domain to distinguish it from HTTP API v2.

A body that is not valid UTF-8 is base64-encoded and `isBase64Encoded` is `true`.

## Response decoding

The Runtime Interface Emulator returns one JSON body:

- `statusCode`, `headers`, `multiValueHeaders`, `cookies`, `body`,
  `isBase64Encoded` are all honoured; `multiValueHeaders` wins over `headers` for
  the same name;
- a body framed as `{metadata JSON}` + eight NUL bytes + bytes is decoded as a
  buffered streaming response (`Streamed: true`) and served with its metadata
  and complete body;
- `errorType`/`errorMessage` without a `statusCode` is a handler error and is
  served as `502 {"message":"Internal Server Error"}` (the detail is logged);
- a missing or out-of-range `statusCode` and a malformed body are `502`;
- a request with no matching route is `404 {"message":"Not Found"}` from the
  local transport; bodies above 10 MB are `413`.

`Content-Length`, `Transfer-Encoding` and other hop-by-hop headers from the
handler are dropped and recomputed by the local HTTP server.

## Isolation and cleanup

- One Docker network per run: `<name-prefix>-net`, labelled
  `apptheory.local.run`, `apptheory.local.app` and `apptheory.local.managed`.
- Function containers: `<name-prefix>-<logicalId>`. Backend containers:
  `<name-prefix>-dynamodb`.
- The RIE port is published on loopback only (`-p 127.0.0.1::8080`).
- On success, failure or `SIGTERM`/`SIGINT`, the runner removes exactly its own
  containers and network, then deletes `<scratch>/runs/<app>-<run>`.
- `apptheory-local down --app <dir>` removes containers and networks labelled
  with that app, for a run that was killed with `SIGKILL`.
