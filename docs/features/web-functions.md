---
title: Lambda Web Functions
description: One composition for a function that serves HTTP through its own endpoint — IamAuth by default, weighted revisions through the L1 escape hatch, and a worked example proved locally.
---

# Lambda Web Functions

A Lambda **Web Function** serves HTTP directly. The application starts its own HTTP server, Lambda forwards each
request to it, and one execution environment answers many concurrent requests — 64 by default, up to 128. That is a
different execution model from the request/response runtime described in [HTTP Runtime (P0–P2)](http-runtime.md), and
this page covers the deployment surface for it, [`AppTheoryWebFunction`](../cdk/api-reference.md).

## One composition, three resources

`AppTheoryWebFunction` creates the function, its first revision, and the endpoint it serves requests on:

```ts
import { AppTheoryWebFunction } from "@theory-cloud/apptheory-cdk";
import * as lambda from "aws-cdk-lib/aws-lambda";

const web = new AppTheoryWebFunction(stack, "Web", {
  code: lambda.WebFunctionCode.fromAssetToManagedBucket("app"),
  runtime: lambda.WebFunctionRuntime.NODEJS_24_X,
  entryPoint: "server.mjs",
});

// web.domainName   — request this
// web.revisionId   — the revision the endpoint routes to
// web.endpoint     — the endpoint resource, its grants, and its L1 escape hatch
```

Nothing here reads an environment variable to decide how it deploys. The endpoint's shape, the runtime, the entry
file and the authorization mode are all encoded configuration, fixed at synthesis.

The application does not need an adapter and does not get a second entry point: it starts an HTTP server and reads
`AWS_LAMBDA_HTTP_ENDPOINT` for the address to listen on. `AWS_LAMBDA_HTTP_ENDPOINT` is set by the Lambda service, so
`props.environment` refuses it — the framework will not let you shadow a variable the service owns.

## Endpoint authorization defaults to IamAuth

`aws-cdk-lib` requires the endpoint's authorization mode to be chosen explicitly, so that an endpoint is never
accidentally public or accidentally locked down. AppTheory picks the locked-down answer as the default:

| `authType` | Endpoint | When |
| --- | --- | --- |
| `IamAuth` (default) | Not public. Lambda authorizes every request against IAM. Requests must be SigV4-signed and carry `X-Amz-Content-SHA256`, including a request with no body. | The shape to deploy. |
| `ApplicationManaged` | Public. Lambda enforces nothing; your code must authorize every request. | Only on an explicit opt-in. |

Choosing `ApplicationManaged` is an explicit opt-in and it is loud: `aws-cdk-lib` emits the documented warning at
synthesis time, and a test pins that it reaches you through this construct.

```text
WARNING WebFunction endpoint uses APPLICATION_MANAGED auth. The Lambda service will not enforce
authentication; ensure your handler code validates every request. (Construct Annotations)
   AppTheoryWebFunctionExample/Public/Function/Endpoint
   Acknowledge with 'Annotation::@aws-cdk/aws-lambda:webFunctionPublicEndpoint'
```

That warning is a signal, not a gate. It can be acknowledged — the `Annotation::` key in the output above suppresses
it — and an acknowledged warning is still an endpoint Lambda does not authenticate, so an endpoint that warns
nothing has not thereby been shown to be private. Read the endpoint's `authType` in the synthesized template: that
is what the service acts on, and it is what this construct's own assertions check.

## Traffic between revisions

A new revision is created whenever the code, the runtime or the build configuration changes, and the endpoint sends
all of its traffic to the revision this construct created. For a weighted split, the endpoint's
`CfnWebFunctionEndpoint` resource is exposed as the documented L1 escape hatch, because `aws-cdk-lib`'s
`WebFunctionTraffic` only expresses `single(revisionId)`:

```ts
web.endpoint.resource.revisionWeights = [
  { revisionId: web.revisionId, weight: 90 },
  { revisionId: nextRevisionId, weight: 10 },
];
```

The service accepts one entry with weight 100, or two entries summing to 100. AppTheory does not wrap this in a
second API: the L1 property is the way, and it is what the synthesis assertion covers.

## Runtime support

Lambda Web Functions run managed language runtimes, and the set is smaller than for event functions. AppTheory
composes what AWS supports and refuses the rest at synthesis rather than deploying a function that cannot start.

| Runtime | Upstream | AppTheory |
| --- | --- | --- |
| Node.js 24 (`nodejs24.x`) | Supported | Supported — `WebFunctionRuntime.NODEJS_24_X` |
| Node.js 26 (`nodejs26.x`) | Supported | Supported — `WebFunctionRuntime.of("nodejs26.x")` |
| Python 3.15 (`python3.15`) | **Public preview**: not covered by the Lambda SLA or Technical Support, and not for production | **Not composed.** Refused at synthesis. |
| Go | **No Web Function runtime exists upstream** | N/A — no workaround, and no custom runtime |

**Why Python is refused rather than marked preview.** A Python Web Function is not a `def handler(event, context)`
function. It serves an **ASGI or WSGI application** — `main:app` by default — and Lambda manages the HTTP server,
passing each request through the interface. Concurrency is one event loop for ASGI, or a **pool of worker threads**
for WSGI, where an ASGI framework can also run a synchronous endpoint in a thread pool. AppTheory's Python runtime is
a request/response runtime with no ASGI or WSGI entry point, so it cannot stand in for the application a Python Web
Function requires. Composing one would produce a revision that fails to start, far from the cause. The refusal names
the reason instead:

```text
AppTheoryWebFunction does not compose the "python3.15" Web Function runtime: a Python Web Function
serves an ASGI or WSGI application, and AppTheory's Python runtime is a request/response runtime with
no such entry point. Supported runtimes are nodejs24.x, nodejs26.x
```

Python is therefore labelled preview upstream and unsupported here. Nothing in this page claims production support
for it.

**Why Go is N/A.** Go is absent from the Web Function runtime list, exactly as it is absent from the Lambda Managed
Instances runtime list. An AppTheory Go runtime is built for one invocation per environment because that is what AWS
provides for Go. Supporting Go here would mean a custom runtime, and AppTheory does not ship or maintain runtime
images. The gap is upstream, it is stated plainly, and it is not worked around:
[Concurrency and the upstream execution model](../runtimes/support.md#concurrency-and-the-upstream-execution-model).

Refusals, all of them at synthesis:

- a runtime outside `nodejs24.x` and `nodejs26.x`;
- `AWS_LAMBDA_HTTP_ENDPOINT` in `props.environment`;
- a code bucket that is not versioned (from `aws-cdk-lib`).

## What one environment must not do

One execution environment answers many requests on one event loop, so every request shares the process. Request state
belongs to the request — in its own closure or its own framework context — and never to a module-level variable. The
guarantee and its per-language shape are stated in
[Concurrency and Request Isolation](concurrency.md); the example below is the Web Function instance of it, and its
local row fails when a request reads another request's state.

## Prove it locally

The example serves a page and streams a response, and runs with no AWS credentials. It is a row in the local
harness, so it runs the way every other row does — see
[Local examples harness](../examples/local-harness.md) for prerequisites (Docker or Colima for DynamoDB Local, Node
24, and no AWS credentials). To run only this row:

```bash
python3 scripts/local/run_examples_local.py --only web-function --workers 1
```

`--only` is the harness's own debug filter and is never passed by CI; the full sweep is `make examples-local`.

Expected output:

```text
  PASS  example ports are free (http 8151, aux 8152)
  [ 1/1] examples/cdk/web-function/app/server.mjs   L2  PASS  page 200 text/html, health 200,
         unknown route 404; 3 events over 0.37s, first at 0.00s, chunked; 2 streams overlapped
         0.49s of delivery, 4 + 5 chunks interleaved before either finished, each saw only its
         own tag

counts: 1 passed, 0 failed, 0 pending-milestone
RESULT: PASS
```

The application can also be run directly, exactly as a Web Function environment runs it:

```bash
AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3000 node examples/cdk/web-function/app/server.mjs
curl -sS -D- http://127.0.0.1:3000/          # text/html page
curl -sS -N http://127.0.0.1:3000/stream     # chunked events, one every 120 ms
```

The row asserts status codes, headers, incremental delivery (the first of three events arrives as soon as the
response opens and the last about 0.37 s later, with no `content-length` to buffer it), and isolation between two
concurrent requests in one environment.

Isolation is measured on delivery, not on the calls. Every chunk carries the instant it arrived, on one clock shared
by both streams, so a server that answers the second request only after the first stream has finished does not pass
for overlapping: the row fails unless each response delivered chunks while the other one was still open. The exact
interleave counts move with scheduling; what it requires is at least two chunks from each stream before the other
finishes. `scripts/local/test_examples_local.py` runs that assertion against three loopback control servers on every
`make examples-local`: an interleaved one, which must pass, a serial one, and one that keeps the request tag in
module state. The serial control fails the row with

```text
the first stream delivered 0 chunk(s) before the second stream finished at 0.515s (its own first chunk
arrived at 0.515s), so the two responses were not delivered concurrently
```

## Proof boundary

This page and the example were verified locally: synthesis, the pinned template hash, the focused construct
assertions, and the harness row above. **Nothing was deployed**, and no AWS credentials were used.

The example's stack composes **two** functions, so both sides of the authorization decision appear in one synthesis:
`Private` keeps the default `IamAuth`, and `Public` opts into `ApplicationManaged`, which Lambda does not
authenticate. The second one is a synthesis demo — it shows what the opt-in looks like in a template — and it is not
a decision to expose a service: the example's application authenticates nothing. Anything you deploy should keep the
`IamAuth` composition. The deploy step itself, `theory app up` with the stack as written, is not part of this proof.

Install the CDK package from a pinned GitHub Releases asset:
[Installation](../getting-started.md).
