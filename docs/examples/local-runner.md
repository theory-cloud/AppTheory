---
title: Run an app locally
---

# Run an app locally

`apptheory local` runs an AppTheory app's **real Lambda handlers** on your
machine. The app's existing CDK definition is the only routing source: the
command synthesizes the app, reads the cloud assembly, starts each function in
the official AWS Lambda runtime image, and serves the HTTP API v2, REST API v1,
Function URL and CloudFront distribution surfaces it found. There is no second
hand-written route table.

A CloudFront distribution is served as its edge path, not as a second copy of
the origin: the gateway selects the cache behavior, runs the distribution's
generated CloudFront Functions, applies the origin request and response headers
policies, and hands origin requests to an origin implementation. A5a serves that
edge path but does not wire the origins yet; a request that would reach an
origin answers `origin "<id>" is not wired until A5b` instead of inventing one.

```bash
# Serve the app in the background, then use the printed URLs.
go run ./cmd/apptheory-local --app examples/cdk/hello-world -c lang=go \
  --profile scripts/local/examples-local.json --backend dynamodb

# Print the derived surface without starting anything.
go run ./cmd/apptheory-local plan --app examples/cdk/hello-world -c lang=go --json
```

`apptheory-local invoke` starts one function instead of an HTTP surface. It is
for event-source handlers and for examples that ship a handler but no CDK
definition; see [Invoking one function](#invoking-one-function).
`apptheory-local session` starts every function the CDK definition targets and
exposes one JSON command per line on stdin/stdout; the examples harness uses it
to receive real messages, write real items and build the provider events the
event-source mappings would deliver. See [Automation sessions](#automation-sessions).

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
during synthesis, before any function container starts.

### What your app needs

- `cdk.json` and a synthesized HTTP API v2, REST API v1 or Function URL. The
  CDK definition is the only routing source.
- A CDK v2 app with `aws-cdk-lib` and `constructs`, and the CDK CLI installed in
  the app directory as a dev dependency:

  ```bash
  npm install --save aws-cdk-lib@2.275.0 constructs@10.8.1
  npm install --save-dev aws-cdk@2.1147.0
  ```

  `HttpLambdaIntegration` is exported from
  `aws-cdk-lib/aws-apigatewayv2-integrations`, which ships inside
  `aws-cdk-lib`; there is no separate integrations package to install. The
  runner executes `node_modules/.bin/cdk`; it does not install packages.
- A local profile passed with `--profile`. It is required for `run` and
  `invoke`, because it pins every runtime image by digest and the Python image
  the preflight needs.

The minimal profile below names only the images the app uses, plus the Python
image for the in-container preflight. The complete example includes one.

### A complete minimal app

These five files are a working Node app: one Lambda function behind one HTTP
API v2 route. Create a directory outside this checkout, save each file there,
then run the commands in the next section.

#### `package.json`

```json
{
  "name": "my-local-app",
  "private": true,
  "dependencies": {
    "aws-cdk-lib": "2.275.0",
    "constructs": "10.8.1"
  },
  "devDependencies": {
    "aws-cdk": "2.1147.0"
  }
}
```

#### `cdk.json`

```json
{
  "app": "node bin/app.js"
}
```

#### `bin/app.js`

```javascript
const cdk = require("aws-cdk-lib");
const apigwv2 = require("aws-cdk-lib/aws-apigatewayv2");
const integrations = require("aws-cdk-lib/aws-apigatewayv2-integrations");
const lambda = require("aws-cdk-lib/aws-lambda");

const app = new cdk.App();
const stack = new cdk.Stack(app, "MyLocalAppStack");

const handler = new lambda.Function(stack, "Handler", {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: "index.handler",
  code: lambda.Code.fromAsset("handler"),
});

const api = new apigwv2.HttpApi(stack, "Api");
api.addRoutes({
  path: "/hello",
  methods: [apigwv2.HttpMethod.GET],
  integration: new integrations.HttpLambdaIntegration("HandlerIntegration", handler),
});
```

#### `handler/index.js`

```javascript
exports.handler = async (event) => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    message: "hello from your local app",
    path: event.rawPath,
  }),
});
```

#### `local-profile.json`

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

Add a `go` pin (`provided:al2023`) for a Go app or use `python` for a Python
app. Add `dynamodbLocal` and an `endpoints.dynamodb` entry only when you pass
`--backend dynamodb`; the [configuration reference](/reference/local-runner-configuration/)
has the full schema.

Profile validation happens in three stages. Malformed JSON fails when the command
starts, before it synthesizes anything. A missing image class or an unpinned tag
is reported after synthesis, when the runner resolves the images for the served
functions — still before any function container starts — with the profile path
and the reason. A missing Python pin for the preflight is reported after the run
network is created, before any function container starts.

### Plan, run, call and stop

From the app directory, with a sibling AppTheory checkout at `~/code/AppTheory`:

```bash
cd ~/code/my-local-app
npm install

# Print the derived surface without starting a container.
go run -C ~/code/AppTheory ./cmd/apptheory-local plan \
  --app ~/code/my-local-app --profile ~/code/my-local-app/local-profile.json

# Serve the app. Keep this terminal open.
go run -C ~/code/AppTheory ./cmd/apptheory-local \
  --app ~/code/my-local-app --profile ~/code/my-local-app/local-profile.json \
  --name-prefix my-local-app
```

The served URL is the address on the `serving …` line the runner prints before
`local-run: ready`:

```
function Handler… (nodejs24.x, public.ecr.aws/lambda/nodejs:24@sha256:…) ready on 127.0.0.1:49xxx
serving httpv2 Api… at http://127.0.0.1:18780
local-run: ready
```

Call the URL from another terminal (replace the port with the one the `serving`
line printed):

```bash
curl -i http://127.0.0.1:18780/hello
```

The response is:

```json
{"message":"hello from your local app","path":"/hello"}
```

The `127.0.0.1:<port>` on the `function …` line is the internal Runtime
Interface Emulator port, not the app URL. Stop the run with `Ctrl-C` (`SIGINT`)
or `SIGTERM`; the command closes the listeners, removes its containers and
network, deletes the scratch directory and exits 0.

A built binary replaces `go run -C` in the same commands:

```bash
go build -C ~/code/AppTheory -o ~/bin/apptheory-local ./cmd/apptheory-local
~/bin/apptheory-local plan \
  --app ~/code/my-local-app --profile ~/code/my-local-app/local-profile.json
~/bin/apptheory-local \
  --app ~/code/my-local-app --profile ~/code/my-local-app/local-profile.json \
  --name-prefix my-local-app
```

## What "locally" means

- **No AWS credentials.** The runner sets static dummy keys and removes every
  inherited `AWS_*`, `CDK_*`, proxy variable, and the `DYNAMODB_ENDPOINT`,
  `DDB_ENDPOINT`, `TABLE_NAME` and `QUEUE_URL` aliases from the processes it
  starts.
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
   - `AWS::Lambda::Url` Function URLs;
   - `AWS::CloudFront::Distribution`, its cache behaviors, origins and origin
     groups, the `AWS::CloudFront::Function` resources it associates, and the
     cache, origin request and response headers policies and origin access
     controls it references. A distribution property the gateway cannot route or
     render faithfully is reported, and the distribution is refused.
   A WebSocket API is listed under `skipped`; it does not stop an app that also
   has HTTP or REST routes. A REST `MOCK` integration is served from the
   status and headers the template declares (CDK uses it for CORS preflight).
3. **Resolve images.** The profile's digest-pinned image for each served
   function's runtime is selected before any container starts. A missing image
   class or a tag that is not pinned by digest fails here, after synthesis.
4. **Prepare the run workspace.** Inline `Code.ZipFile` code is materialized
   under the run scratch directory, then the run's private Docker network is
   created.
5. **Start backends.** `--backend dynamodb`, `--backend moto`,
   `--backend s3proxy` and `--backend sqs` start the profile's digest-pinned
   emulators on the run's private network. Before it reports a backend ready,
   the runner waits up to 60 seconds for every endpoint configured on that
   backend to answer a read-only call native to the service over its published
   loopback port: `ListTables` for DynamoDB Local, `ListKeys` and
   `GetCallerIdentity` for moto KMS/STS, `ListBuckets` for s3proxy and
   `ListQueues` for ElasticMQ. A service with no native probe is checked with a
   plain HTTP request. On timeout the run fails with the backend, its image and
   the last error, before any resource is provisioned. A backend with no
   published host port is reported ready without this wait.
6. **Provision resources.** When the backend is ready, the runner creates every
   resource the assembly declares: S3 buckets and KMS keys, DynamoDB tables
   with their key schema, GSIs, streams and TTL, and SQS queues with their
   visibility, retention and redrive policy. It records the provisioned values
   environment resolution needs. Attributes the local emulator does not
   implement (SSE, PITR, deletion protection, KMS-on-SQS) are not provisioned;
   they are not part of the local contract.
7. **Resolve environment references.** A served function's `Ref`/`Fn::GetAtt`
   environment values are resolved to deterministic local values: a DynamoDB
   table name and stream ARN, an SQS queue name or URL, an EventBridge rule
   name, an S3 bucket name or ARN, a Kinesis stream name or ARN, a KMS key id or
   ARN, and the ARNs of IAM, MicroVM-image and S3 Vectors resources. The S3
   bucket and KMS key values are the ones provisioned in the previous step. A
   `{{resolve:secretsmanager:…}}` value becomes a deterministic local secret;
   the session's `describe` returns it, and the run never prints it. An
   expression the runner cannot resolve fails closed with the function and
   variable named.
8. **Preflight.** A probe container on the run's private network proves the
   dummy credentials, every configured endpoint, the DynamoDB SDK endpoint when
   one is configured, and closed DNS.
9. **Run.** One container per function the CDK definition targets: HTTP routes,
   Function URLs, HTTP API authorizers, enabled event-source consumers and
   enabled EventBridge rule targets. Each uses the official image for its
   runtime, digest-pinned in the profile. Handlers run under the embedded
   Runtime Interface Emulator; the transport invokes
   `/2015-03-31/functions/function/invocations`.
10. **Serve, invoke or session.** One loopback listener per API (and per
    Function URL) builds the provider event for the matched route, runs a
    CUSTOM request authorizer first when the route declares one, invokes the
    handler and decodes the response — including the RIE's buffered streaming
    frame. One gateway listener per servable CloudFront distribution serves the
    distribution's local URL: it selects the cache behavior, runs the generated
    CloudFront Functions, applies the edge policies and refuses an unwired
    origin with a named 503. `invoke` instead sends explicit events to one warm
    container. A session keeps every target warm, serves the same HTTP surface,
    and answers the JSON command protocol on stdin/stdout.
11. **Shut down.** `Ctrl-C` (`SIGINT`) or `SIGTERM` stops accepting requests by
    closing the listeners, force-removes the run's containers (which aborts an
    in-flight invocation), closes any connections still in flight, removes the
    network and deletes the scratch directory. A `SIGKILL` cannot be caught:
    after one, `apptheory-local down --app <dir>` removes the containers and
    networks labelled with that app; it does not delete the stale run scratch
    directory. That directory is `<scratch>/runs/<app>-<run>`, where `--scratch`
    defaults to `<user cache>/apptheory-local`; it is safe to delete by hand.

## CloudFront distributions

A distribution in the cloud assembly is served on its own `http://127.0.0.1:<port>`
URL, printed on the `serving cloudfront …` line. The local gateway is the
delivery path a FaceTheory or AppTheory site is tested through; it is **not a
CloudFront emulator: no caching, no edge network, no TLS**.

### What is read

The gateway reads `AWS::CloudFront::Distribution` `DistributionConfig` from the
same assembly the Lambda surface comes from: origins and origin groups, the
default cache behavior and every cache behavior in listed order, and the
`AWS::CloudFront::Function` associations. It resolves the referenced
`AWS::CloudFront::CachePolicy`, `AWS::CloudFront::OriginRequestPolicy`,
`AWS::CloudFront::ResponseHeadersPolicy` and `AWS::CloudFront::OriginAccessControl`
resources. There is no second hand-written routing definition.

A behavior is selected by the **original** viewer URI: cache behaviors in the
order the template lists them, using CloudFront's path-pattern rules (an
optional leading slash, case-sensitive matching, `*` for any run of characters
and `?` for exactly one character), then the default behavior. A viewer-request
function that rewrites the URI does not change the behavior the request uses,
as CloudFront documents.

### Request phases

1. The **viewer-request function**, when the selected cache behavior has one,
   runs before any origin dispatch. If it returns a response, that response is
   sent to the viewer and the origin is not called.
2. `AllowedMethods` is enforced on the (unchanged) request method; a method the
   behavior does not allow is a 403, the status CloudFront documents for an
   invalid method. CloudFront does not document the relative order of the
   [viewer-request trigger](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-functions.html)
   and the [403 invalid-method response](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/http-403-invalid-method.html).
   The local gateway runs the viewer-request function first by choice: a
   function can answer a request whose method the behavior does not allow (a
   CORS preflight or an authentication rejection) instead of being pre-empted by
   the local 403.
3. `DefaultRootObject` replaces a request for `/` with the declared object.
4. The cache policy and the **origin request policy** decide which headers,
   cookies and query strings reach the origin. Managed policies are pinned by
   ID; `AllViewer` forwards the viewer Host, `AllViewerExceptHostHeader` sets the
   Host to the origin domain, and `AllViewerAndCloudFrontHeaders-2022-06` also
   receives the locally derivable CloudFront headers. The **origin receives**
   the policy-filtered request plus the origin path; the selected behavior's
   target origin is then called.
5. The **viewer-response function**, when the behavior has one, runs on the
   origin's response and may change its status, headers, cookies or body. It
   never sees the origin body.
6. The **response headers policy** is applied last: remove headers, CORS,
   security headers and custom headers, with each entry's override flag.

### CloudFront Functions

The executor runs the **exact `FunctionCode` string** from the template, never a
re-implementation. Each invocation gets a fresh Node `vm` context with the
documented version 1.0 event: `context` (`distributionDomainName`,
`distributionId`, `eventType`, `requestId`), `viewer.ip`, `request` (`method`,
`uri`, `querystring`, lower-cased `headers`, `cookies`) and, for
viewer-response, `response`. `distributionId` is a local placeholder derived
from the distribution's logical id; `distributionDomainName` is the loopback
host the viewer used.

`cloudfront-js-2.0` functions get `crypto`, `querystring`, `Buffer`,
`TextEncoder`, `TextDecoder` and the `cloudfront` module. `cloudfront-js-1.0`
functions get `crypto` and `querystring` and are rejected if they use `const`,
`let`, `async` or `await`. Both runtimes are strict, have a fixed `Date` for the
whole invocation, and have no network, file system, `process`, timers, `eval` or
`Function` constructor. `require` accepts only the documented modules.

A thrown error, a rejected return shape, a changed `request.method`, a
`Set-Cookie` header in a viewer-request, a Promise return or a base64 body that
does not decode is a **503-class failure**: the gateway logs the function and
the reason and never passes the request through. `console.log` accepts one
string, as CloudFront documents.

### Edge policies

The origin request policy is applied to the viewer request; the response headers
policy is applied after the viewer-response function. Caching is not emulated:
every request is forwarded to the origin as a cache miss, and a cache policy is
used only for the values it contributes to the origin request. The
`ViewerProtocolPolicy` is reported, not enforced, because the local URL is plain
HTTP; the same is true for compression, access logging, aliases, the viewer
certificate and the distribution's HTTP/IPv6/price-class settings.

The pinned managed policy table and the exact property inventory are in the
[configuration reference](/reference/local-runner-configuration/#cloudfront-distributions).

### Origins and A5a

The gateway defines the origin interface A5b implements for the S3 emulator, the
Function URL origin and origin groups. In A5a no origin implementation is
registered: a request that reaches an origin is answered with
`origin "<id>" is not wired until A5b`, and the origin is never faked. A
viewer-request response that short-circuits the origin is fully served, so an
edge redirect or rewrite can be exercised today. The `ssr-site`,
`ssr-only-provided-assets-site`, `path-routed-frontend` and `media-cdn` example
rows remain class I in the harness until A5b wires their origins.

Distributions that use Lambda@Edge, a CloudFront KeyValueStore association,
trusted key groups or signed URLs, field-level encryption, geo restriction, a
WAF web ACL, custom error responses, a gRPC config or a legacy `ForwardedValues`
cache policy are refused with a named reason; they are listed under `skipped`
and no listener is started. Real-time logs, access logging and the properties
that only affect caching or edge placement are reported instead.

## Invoking one function

`plan` and `run` are about HTTP surfaces. `invoke` starts one function and
sends it events, which is how the harness exercises event-source handlers and
handler-only examples. It prepares the run in the same order as `run` — images,
scratch, network, backends, provisioning, environment resolution and preflight
— before it starts only the requested function:

```bash
# One CDK function with one event.
apptheory-local invoke --app examples/cdk/lesser-parity \
  --function WorkerFn847949AF --profile scripts/local/examples-local.json \
  --event sqs-event.json

# A warm container driven over stdin: one JSON event per line in, one JSON
# result per line out. The container keeps its in-memory state across requests.
apptheory-local invoke --handler-dir ~/.cache/mcp-tools-only \
  --runtime provided.al2023 --handler bootstrap \
  --profile scripts/local/examples-local.json --stdio
```

The result is one JSON object per event:

```json
{"proxy":true,"statusCode":200,"headers":{"content-type":["application/json"]},"body":"{\"ok\":true}"}
```

`proxy` is `true` when the handler returned a Lambda proxy response. Otherwise
`raw` carries the handler's JSON result unchanged, and `handlerError` names a
handler that crashed. `--handler-dir` mode derives no routes: it starts the
built handler and the caller supplies every event. It exists because the Go MCP
examples ship a handler but no CDK definition. A handler-only row is never
described as CDK-routed.

Streaming over a warm container is still buffered by the RIE: a tool call's
complete SSE body arrives after the handler finishes, and `streamed` marks the
framed response. The MCP rows assert session creation, event ids and
Last-Event-ID replay content; they never claim incremental delivery.

## Automation sessions

`session` is the machine interface behind `make examples-local`. It prepares the
same environment as `run`, starts every function the CDK definition targets
(HTTP routes, Function URLs, authorizers, event-source consumers and
EventBridge rule targets), serves the HTTP listeners, prints `local-run: ready`
on stderr, and then reads one JSON command per line on stdin. Every command
writes one JSON response per line on stdout: `{"ok":true,"result":…}` or
`{"ok":false,"error":"…"}`. Progress stays on stderr. The protocol is how the
harness receives real messages, writes real items, and builds the event an
event-source mapping would deliver; it is not a second routing definition.

```bash
apptheory-local session --app examples/cdk/sqs-queue \
  --profile scripts/local/examples-local.json --backend sqs \
  --target ProducerFn29855005
{"op":"describe"}
{"op":"invoke","function":"ProducerFn29855005","event":{…}}
{"op":"sqs.receive","queue":"ContractQueue3874DDBD","max":1,"waitSeconds":2}
```

`--target <logical-id>` starts one additional CDK function that no route, event
source or rule targets. It is how the harness runs a producer that the CDK
defines but a deployment caller invokes.

The operations, in the order the examples use them:

- `describe` — the started functions (with resolved environment and RIE port),
  HTTP listener URLs, event-source mappings, EventBridge rules, provisioned
  resources (name, URL, ARN, stream ARN) and local secrets.
- `invoke` — send one Lambda event to a started function and return the same
  decoded result as `invoke`.
- `sqs.send` — send one body to a provisioned ElasticMQ queue through the
  runner's host-side SQS client.
- `sqs.receive` — receive up to `max` messages with the requested wait and
  visibility, optionally deleting them after receipt.
- `sqs.event` — receive messages and build the `Records` event the SQS mapping
  delivers, from the messages actually returned by ElasticMQ.
- `ddb.put` — write one JSON item to a provisioned table; the previous image is
  cached for a later stream record.
- `ddb.get` — read one item by its key.
- `ddb.scan` — read every item in a provisioned table.
- `ddb.stream-event` — build a DynamoDB stream record from the stored image (and
  the previous image when one is cached), using the table's stream ARN, view
  type and the real key schema.
- `s3.put` — write one object to a provisioned s3proxy bucket.
- `eventbridge.event` — build the event an `AWS::Events::Rule` delivers,
  deriving a scheduled envelope from `ScheduleExpression` or the source and
  detail-type from the rule's declared `EventPattern`.
- `kinesis.event` — build a Kinesis event from explicit base64 record data.
- `kinesis.cloudwatch-event` — gzip a CloudWatch Logs subscription payload from
  local log events and wrap it in the Kinesis record AWS delivers.
- `shutdown` — stop the session and run the normal cleanup.

The `ddb.*` and `sqs.*` operations use the loopback endpoints the runner
published; function containers use the run-network aliases. Neither can reach a
real AWS endpoint. `describe` is the only operation that returns local secrets
or resolved environment values; `run`, `plan` and `invoke` never print them.

## Capability matrix

Classes follow the repository's local-execution convention: **L1** runs fully
locally, **L2** runs locally with an emulator and documented limits, and **L3**
is exercised as fully as possible with a named cloud gap. `apptheory local`
serving a surface is not by itself a class: the class belongs to an example, and
the harness records it.

| Capability | Local runner | Notes |
| --- | --- | --- |
| HTTP API v2 (`AWS::ApiGatewayV2::Api`, HTTP) | Supported (L1) | v2.0 events with `routeKey`, `rawPath`, `requestContext.http`, cookies and path parameters. The `cookie` header is removed when `cookies` is populated, as AWS does. |
| REST API v1 (`AWS::ApiGateway::RestApi`) | Supported (L1) | v1 events with `resource`, `multiValueHeaders`, `multiValueQueryStringParameters` and the stage. |
| Lambda Function URL | Supported (L1) | Function URL events carry `routeKey: "$default"` (top-level and in `requestContext`, with `requestContext.stage`) and a `.lambda-url.<region>.on.aws` domain, which the runtime uses to tell them apart from HTTP API v2. A URL with an auth type other than `NONE` is reported under `skipped`, not served as a standalone URL; a distribution can still reference it as an origin. |
| Response streaming (`awslambda.streamifyResponse`, SSE) | Supported, **buffered** (L3) | The RIE buffers the whole response and returns metadata JSON + eight NUL bytes + body. The transport reproduces status, headers and complete bytes; it never reproduces chunk timing. |
| Inline `Code.ZipFile` | Supported (Node, Python) | Materialized under the run scratch directory before the container starts. |
| arm64 `provided.al2023` | Supported (L1) | Uses the host-arch image; a bootstrap built for the other architecture fails closed with a clear error. |
| DynamoDB Local | Supported (L2) | `--backend dynamodb` starts the profile's digest-pinned `amazon/dynamodb-local` on the run network; SDK clients resolve through `AWS_ENDPOINT_URL_DYNAMODB`. Tables are created from the CDK key schema, GSIs, streams and TTL. SSE, PITR and deletion protection are not provisioned. |
| SQS (ElasticMQ) | Supported (L2) | `--backend sqs` starts the digest-pinned `softwaremill/elasticmq-native` container, creates the CDK queues with visibility, retention and redrive policy, and resolves `QueueUrl`/`Arn` from the created queues. Managed event-source polling is not run; a session receives real messages and builds the SQS event. |
| KMS and STS (moto) | Supported (L2) | `--backend moto` starts the profile's digest-pinned moto container and injects `AWS_ENDPOINT_URL_KMS`/`_STS` (and the profile's aliases). KMS keys declared by the assembly are created; `Ref`/`Fn::GetAtt Arn` resolve to the created key. No HSM, key policies or grants. |
| S3 (s3proxy) | Supported (L2) | `--backend s3proxy` starts the digest-pinned s3proxy container, creates the assembly's buckets, and injects the S3 endpoint as the container address so the SDK uses path-style addressing. No bucket policies, IAM or event notifications. |
| Event source mappings (SQS, DynamoDB Streams, Kinesis) | Derived and reported; invocation is explicit | The mapping's function, source, batch size and `ReportBatchItemFailures` are read from the assembly. A session receives real queue messages or builds a stream record from a real local write and invokes the handler. Managed delivery (polling, subscription, retries) is the named L3 gap. |
| EventBridge rules (schedule and pattern) | Derived and reported; invocation is explicit | A session builds the `Scheduled Event` envelope or the pattern's source/detail-type from the CDK rule and invokes its Lambda target. Managed rule delivery is not run. |
| Kinesis / CloudWatch Logs subscription events | Built from local content | The session gzips a CloudWatch Logs subscription payload from local log events and wraps it in a Kinesis record, or accepts explicit base64 record data. The Kinesis stream itself is not emulated. |
| Deploy-time Secrets Manager dynamic references | Supported | A `{{resolve:secretsmanager:…}}` environment value becomes a deterministic local secret. The session's `describe` returns it to the harness; `run` and `plan` never print it. No secret is created in a cloud. |
| Other emulators | Endpoint injection only | Pass `--endpoint service=url` and `--add-host name=address`; the profile names the environment variables. |
| WebSocket APIs | Reported, not served | A WebSocket API is listed under `skipped` with its reason, and an app with no HTTP route, Function URL, event source or rule fails with that list. Its `$connect`/`$disconnect`/`$default` routes are not invoked. |
| CloudFront distributions and CloudFront Functions | Served (A5a edge path) | The distribution is served on its own loopback URL. Cache behaviors, allowed methods, viewer-request/viewer-response functions, origin request policies and response headers policies are applied; the generated function code runs in a restricted Node sandbox. An origin-bound request is a named 503 until A5b wires the origins. No caching, no edge network, no TLS. |
| REST `MOCK` integrations | Supported (L1) | The transport returns the `IntegrationResponses` status and headers the template declares and invokes no function. CDK emits these for CORS preflight. |
| HTTP API `REQUEST` authorizers with simple responses | Supported | The transport invokes the real authorizer function with the API Gateway v2 REQUEST event, carrying every configured `$request.header.*` or `$request.querystring.*` identity source in order; a request missing one is refused with 401 before the authorizer runs. A false `isAuthorized` is a 401, the authorizer context is carried to the handler, and a malformed response fails closed. `$context`/`$stageVariables` sources fail closed at plan time. |
| Other authorizers (REST, JWT, non-simple responses) | Not served | Fails closed; the local transport must never bypass a real authorizer. |
| Lambda layers, container-image functions | Not served | Fail closed when a served function needs them. |
| CloudFormation-expression environment values | Supported for `Ref`/`Fn::GetAtt`/`Fn::Join` | Tables and stream ARNs, queues, rules, buckets, KMS keys, Kinesis streams, IAM/MicroVM-image/S3 Vectors ARNs and functions resolve to deterministic local values (KMS/S3 require their backend). An unsupported expression fails with the function and variable named. |
| CloudFormation-expression `MemorySize`/`Timeout` | Not resolved | A served function whose limit is `Ref`/`GetAtt`/`Fn::If` fails with the property named; the AWS defaults apply only when the property is absent. |
| One function, explicit events (`invoke`) | Supported | Starts one function and sends newline-delimited JSON events to a warm container; `--handler-dir` runs a handler that has no CDK definition and derives no routes. |
| Every target, explicit commands (`session`) | Supported | Starts every CDK-targeted function, serves the HTTP surface, and answers a JSON-line command protocol for invocation, SQS, DynamoDB, S3, EventBridge and Kinesis operations. `--target` adds a function no route or event source targets. |
| Stage-prefixed URLs (`/prod/...`) | Not honoured | The stage is reported in the event; URLs are served at the root, as API Gateway does for custom domains. |
| Multiple APIs in one stack | Supported | Each API gets its own listener and route table, so `ANY /` surfaces never shadow each other. |

## Known gaps

- **Streaming is buffered.** A handler that streams is not incremental under the
  Runtime Interface Emulator. Tests can assert the complete bytes and the status
  and headers, never the timing of individual chunks.
- **WebSocket events** are not delivered. A WebSocket API is reported as not
  served; its routes are never invoked.
- **CloudFront is an edge-path gateway, not an emulator.** The distribution's
  cache behavior, generated CloudFront Functions and edge policies are applied,
  but there is no cache, no edge network, no TLS and no viewer protocol
  enforcement. A request that reaches an origin is a named 503 until A5b wires
  the S3, Function URL and origin-group origins. Lambda@Edge, KeyValueStore,
  signed URLs, field-level encryption, geo restriction, WAF and custom error
  responses refuse the distribution; caching, compression, logging and
  placement settings are reported. The Node `vm` executor matches the
  CloudFront Functions API and globals but is not a hardened security boundary,
  does not enforce CloudFront's 1 ms CPU budget, and cannot reproduce
  CloudFront-only device, location or TLS headers.
- **Managed event-source delivery is not run.** SQS, Kinesis, scheduled rules
  and DynamoDB stream mappings are derived from the CDK definition, their
  functions are started, and a session receives real messages or builds the
  provider event from a real local write. The emulator does not poll, subscribe,
  retry, or deliver the event on its own; those are the named L3 gaps.
- **Kinesis has no stream emulator.** A Kinesis event is built locally (from a
  CloudWatch Logs subscription payload or explicit record data) and invoked
  through the real handler; the stream service itself is not emulated.
- **HTTP API authorizers** are run only for `REQUEST` authorizers with simple
  responses. They carry every configured `$request.header.*` or
  `$request.querystring.*` identity source in order, and a request missing one
  is refused with 401 before the authorizer runs. REST, JWT and IAM authorizers,
  and `$context`/`$stageVariables` identity sources, fail closed rather than
  bypassing a real authorization decision.
- **SSM Parameter Store** has no local emulator. A handler that reads a
  parameter sees the call fail and must handle it; the lambda-role custom row
  asserts that fallback and is class L3 with the named gap.
- **S3 event notifications** are absent from s3proxy. The import-pipeline row
  writes a real object and builds the CDK rule's EventBridge event; S3 →
  EventBridge delivery itself is the named gap.
- **Managed services** remain L3 gaps where the examples use them: the MicroVM
  provider in the controller and conformance rows, and S3 Vectors/Bedrock in
  the semantic-search row. The runner stops at those boundaries; it never fakes
  a success.
- **One container per function.** In-flight invocations are bounded to 32 and
  queue behind the function's container; the local runner is not a load test.

## Requirements

- Go 1.27+ to build or run the `apptheory-local` command. TypeScript and Python
  handlers never need Go: they run in their own runtime images.
- Node.js 24+ when a served CloudFront distribution has CloudFront Functions.
  The function code runs in the host Node `vm`; the runner refuses to start that
  distribution if Node is not on `PATH`.
- Docker (on macOS, colima) with the daemon running. The runner creates one
  private network per run and publishes the RIE port on `127.0.0.1` only.
- The app's CDK CLI installed in the app directory
  (`node_modules/.bin/cdk`); run `npm install` there once, or `npm ci` when the
  app has a lockfile. The runner does not install packages.
- Bind-mounted code must live under `$HOME` or the working directory (the
  checkout): colima does not share `/private/tmp`. The runner refuses a mount
  outside those roots.

## Where to next

- [Local examples harness](/examples/local-harness/) — the classification
  manifest and `make examples-local`.
- [Local runner configuration](/reference/local-runner-configuration/) — flags,
  profile schema and the exact container environment and events the runner
  generates.
