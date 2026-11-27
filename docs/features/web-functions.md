---
title: Lambda Web Functions
description: One composition for a function that serves HTTP through its own endpoint — IamAuth by default, weighted revisions through the L1 escape hatch, and a worked example proved locally.
---

# Lambda Web Functions

A Lambda **Web Function** serves HTTP directly, and one execution environment answers many concurrent requests — 64
by default, up to 128. How the application serves those requests depends on the runtime, and both upstream models are
composed here:

- **Node.js** (`nodejs24.x`, `nodejs26.x`): the application starts its own HTTP server, Lambda forwards each request
  to it, and the application reads `AWS_LAMBDA_HTTP_ENDPOINT` for the address to listen on.
- **Python** (`python3.15`, upstream public preview): Lambda manages the HTTP server and passes each request to an
  **ASGI** or **WSGI** application. The composition names the application; the entry point is written for you.

Either way, a Web Function is a different execution model from the request/response runtime described in
[HTTP Runtime (P0–P2)](http-runtime.md), and this page covers the deployment surface for it,
[`AppTheoryWebFunction`](../cdk/api-reference.md).

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

The application does not need an adapter and does not get a second entry point. On Node.js it starts an HTTP server
and reads `AWS_LAMBDA_HTTP_ENDPOINT` for the address to listen on; on Python it is an ASGI or WSGI application, and
Lambda supplies the server. Those two variables the service and this construct own — `AWS_LAMBDA_HTTP_ENDPOINT` and
the runtime's entry point — are refused in `props.environment`: the framework will not let you shadow one.

A Python Web Function composes the same way, and the entry point is not yours to spell:

```ts
import { AppTheoryPythonInterface, AppTheoryWebFunction } from "@theory-cloud/apptheory-cdk";

const pythonWeb = new AppTheoryWebFunction(stack, "PythonWeb", {
  code: lambda.WebFunctionCode.fromAssetToManagedBucket("app"),
  runtime: lambda.WebFunctionRuntime.of("python3.15"),
  // Served as `asgi:main:app`: the module, the callable and the interface, decided at synthesis.
  pythonApp: { module: "main", interface: AppTheoryPythonInterface.ASGI },
});
```

`pythonApp` names the module (without `.py`), the callable (default `app`) and the interface. The construct writes
`AWS_LAMBDA_PYTHON_ENTRYPOINT` as `interface:module:callable`, so the runtime serves the interface you declared
instead of detecting one. `entryPoint` stays Node-only: it names an entry *file*, and a Python Web Function names an
application.

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
| Python 3.15 (`python3.15`) | **Public preview**: not covered by the Lambda SLA or Technical Support, and not for production | Supported as **preview**, with `pythonApp` naming the ASGI or WSGI application — `WebFunctionRuntime.of("python3.15")` |
| Go | **No Web Function runtime exists upstream** | N/A — no workaround, and no custom runtime |

**Python Web Functions are preview, and the label is upstream's.** `python3.15` carries no SLA and no Technical
Support, and AWS says it is not for production. AppTheory composes it because composing a supported execution model is
how the framework stays the single path for it — not because the preview status has changed. Nothing on this page
claims production support for Python Web Functions.

## The Python model: Lambda's server, your ASGI or WSGI application

A Python Web Function is not a `def handler(event, context)` function and is not served by AppTheory's
request/response Lambda entry point. Lambda **manages the HTTP server** and passes each request to an application
through a declared interface:

| Interface | Concurrency in one environment | AppTheory entry point |
| --- | --- | --- |
| ASGI 3.0 | **One event loop.** Requests are concurrent: while one awaits I/O, the loop serves another, and delivers another response's chunks. | `apptheory.ASGIApp(runtime)` |
| WSGI | **A pool of worker threads**, one request per thread. | `apptheory.WSGIApp(runtime)` |

Both entry points are the same idea in two shapes: they turn a request into an AppTheory
[`Request`](../api-reference.md), call the runtime's `serve`, and write the [`Response`](../api-reference.md) back —
streaming a `Response.body_stream` chunk by chunk as it is produced, and releasing the producer when the client
disconnects. `Response.html_stream` and `apptheory.sse_event_stream` therefore keep streaming over a Web Function
instead of being buffered into one write.

Where your handler runs, and why it is safe there:

- **ASGI** — the entry point is one async callable on the server's single event loop. Each request's synchronous
  `serve` call, and every blocking `next()` on a streamed body, runs on the loop's default worker thread, which is
  the shape an ASGI framework gives a `def` endpoint and what upstream describes ("when you create a synchronous
  endpoint using `def` instead of `async def`, ASGI frameworks such as FastAPI and Starlette can run the endpoint in a
  thread pool"). The loop stays free to accept requests and deliver other responses while one handler works.
- **WSGI** — the server calls the entry point on one of its worker threads, which is upstream's WSGI model, and the
  handler runs there.

**The runtime's loop-bound state is the reason the ASGI entry point dispatches, not a workaround.** `serve()` resolves
an `async def` handler with `asyncio.run`, which raises when the calling thread already has a running loop. Every
entry into `serve` from these two wrappers therefore happens off the loop, and an `async def` AppTheory handler keeps
working unchanged. Per-request state itself is not loop-bound: it lives in the request's `Request`, its `Context`, its
handler's return value and its body stream, and nothing in the wrappers is stored on a module, on the runtime or in a
thread-local — so two overlapping requests cannot observe each other. `py/tests/test_serving.py` pins
that (including an assertion that the handler never runs on the event-loop thread), and the example's local row fails
when a request reads another request's state.

**This is not the Managed Instances model.** Lambda Managed Instances runs each concurrent Python invocation in a
**separate process**; that is a different upstream feature, and
[Concurrency and Request Isolation](concurrency.md#python-specifics) states it as such. A Python Web Function keeps one
event loop, or one worker-thread pool, inside one environment. The two models are not interchangeable, and neither of
them serves Python with a thread per request in the sense of a thread-per-connection server you write yourself.

**Why Go is N/A.** Go is absent from the Web Function runtime list, exactly as it is absent from the Lambda Managed
Instances runtime list. An AppTheory Go runtime is built for one invocation per environment because that is what AWS
provides for Go. Supporting Go here would mean a custom runtime, and AppTheory does not ship or maintain runtime
images. The gap is upstream, it is stated plainly, and it is not worked around:
[Concurrency and the upstream execution model](../runtimes/support.md#concurrency-and-the-upstream-execution-model).

Refusals, all of them at synthesis:

- a runtime outside `nodejs24.x`, `nodejs26.x` and `python3.15`;
- a Python runtime without `pythonApp`, or `pythonApp` with a Node.js runtime;
- `entryPoint` with a Python runtime (a Python Web Function names an application, not a file);
- a `pythonApp.module` or `pythonApp.callable` that carries a colon, which would smuggle in an interface prefix or a
  second entry point, and a `pythonApp.interface` outside `asgi` and `wsgi`;
- `AWS_LAMBDA_HTTP_ENDPOINT`, `AWS_LAMBDA_NODEJS_ENTRYPOINT` or `AWS_LAMBDA_PYTHON_ENTRYPOINT` in `props.environment`;
- a code bucket that is not versioned (from `aws-cdk-lib`).

## What one environment must not do

One execution environment answers many requests — on one event loop for Node.js and ASGI Python, in a worker-thread
pool for WSGI — so every request shares the process (and, on Python, the interpreter). Request state belongs to the
request: its own closure, its own framework context, or its own request-scoped arguments, and never a module-level
variable. AWS states the same rule for Python Web Functions ("avoid storing request-specific data in global
variables"), and it is the rule AppTheory's `Context` exists to make easy to follow. The guarantee and its
per-language shape are stated in [Concurrency and Request Isolation](concurrency.md); the examples below are the Web
Function instance of it, and each local row fails when a request reads another request's state.

## Prove it locally

Two examples serve a page and stream a response, and both run with no AWS credentials:
[`examples/cdk/web-function`](../../examples/cdk/web-function/README.md) for the Node.js model and
[`examples/cdk/web-function-python`](../../examples/cdk/web-function-python/README.md) for the Python one, which is
one AppTheory application served once as an ASGI app and once as a WSGI app. Each is a row in the local harness, so it
runs the way every other row does — see [Local examples harness](../examples/local-harness.md) for prerequisites
(Docker or Colima for DynamoDB Local, Node 24, Python 3.12+ with `scripts/local/requirements-examples.txt` installed,
and no AWS credentials). To run only these rows:

```bash
python3 scripts/local/run_examples_local.py --only web-function --workers 1
```

```bash
python3 scripts/local/run_examples_local.py --only web-function-python,web-function-python-wsgi --workers 1
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

The Python rows report the same assertions against the two interfaces, each behind a real server:

```text
  [ 1/2] examples/cdk/web-function-python/app/main.py        L2  PASS  page 200 text/html, health 200,
         unknown route 404; 3 events over 0.38s, first at 0.00s, chunked; 2 streams overlapped 0.51s
         of delivery, 5 + 4 chunks interleaved before either finished, each saw only its own tag
  [ 2/2] examples/cdk/web-function-python/app/main_wsgi.py   L2  PASS  page 200 text/html, health 200,
         unknown route 404; 3 events over 0.39s, first at 0.00s, chunked; 2 streams overlapped 0.50s
         of delivery, 4 + 5 chunks interleaved before either finished, each saw only its own tag

counts: 2 passed, 0 failed, 0 pending-milestone
RESULT: PASS
```

Neither row invents a server: ASGI is served by uvicorn (the reference ASGI server, one event loop) and WSGI by the
standard library's WSGI server with a threading mixin (one worker thread per request). Both are the local stand-ins
for the server Lambda manages, and both are named as the row's fidelity limit.

The applications can also be run directly. The Node.js one reads its listen address from the variable the service
sets; the Python ones are called by a server, because that is what a Python Web Function is:

```bash
AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3000 node examples/cdk/web-function/app/server.mjs
curl -sS -D- http://127.0.0.1:3000/          # text/html page
curl -sS -N http://127.0.0.1:3000/stream     # chunked events, one every 120 ms
```

```bash
# ASGI, the way Lambda loads it: main:app
cd examples/cdk/web-function-python/app && PYTHONPATH=../../../py/src python3 -m uvicorn main:app --port 3000
# WSGI, the way Lambda calls it: wsgi:main_wsgi:application
cd examples/cdk/web-function-python && PYTHONPATH=../../py/src PORT=3000 python3 scripts/serve-wsgi.py
```

The row asserts status codes, headers, incremental delivery (the first of three events arrives as soon as the
response opens and the last about 0.37 s later, with no `content-length` to buffer it), and isolation between two
concurrent requests in one environment.

Isolation is measured on delivery, not on the calls. Every chunk carries the instant it arrived, on one clock shared
by both streams, so a server that answers the second request only after the first stream has finished does not pass
for overlapping: the row fails unless each response delivered chunks while the other one was still open. The seconds
and the interleave counts move between runs — a four-worker sweep of the same row reports 0.48 s and the same
4 + 5 — and what the row requires is at least two chunks from each stream before the other finishes.
`scripts/local/test_examples_local.py` runs that assertion against three loopback control servers on every
`make examples-local`: an interleaved one, which must pass, a serial one, and one that keeps the request tag in
module state. The serial control fails the row with

```text
the first stream delivered 0 chunk(s) before the second stream finished at 0.515s (its own first chunk
arrived at 0.515s), so the two responses were not delivered concurrently
```

## Proof boundary

This page and both examples were verified locally: synthesis, the pinned template hashes, the focused construct
assertions, and the harness rows above — including the Python rows, which drive the real ASGI and WSGI servers in this
repository's own Python runtime. **Nothing was deployed**, and no AWS credentials were used. Python Web Functions
remain an upstream public preview; the local proof says the composition and the entry points behave, not that the
preview is production-ready.

The example's stack composes **two** functions, so both sides of the authorization decision appear in one synthesis:
`Private` keeps the default `IamAuth`, and `Public` opts into `ApplicationManaged`, which Lambda does not
authenticate. The second one is a synthesis demo — it shows what the opt-in looks like in a template — and it is not
a decision to expose a service: the example's application authenticates nothing. Anything you deploy should keep the
`IamAuth` composition. The deploy step itself, `theory app up` with the stack as written, is not part of this proof.

Install the CDK package from a pinned GitHub Releases asset:
[Installation](../getting-started.md).
