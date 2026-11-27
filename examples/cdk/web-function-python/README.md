# Python Lambda Web Function example

A Python **Web Function** is not a request/response handler. Lambda manages the HTTP server and passes each request to
an **ASGI** or **WSGI** application, so the deployment names an application instead of a handler. This example is one
AppTheory application served both ways — once as an ASGI app and once as a WSGI app — with a local row that proves each
without an AWS account.

Full guidance: [Lambda Web Functions](../../../docs/features/web-functions.md).

`python3.15` is an upstream **public preview**: no Lambda SLA, no Technical Support, and not for production. This
example composes it because it is the only Python Web Function runtime, and it says so where an operator reading the
template will see it — in the revisions' descriptions.

## What is here

| Path | What it is |
| --- | --- |
| `bin/app.ts` | The CDK app (`AppTheoryWebFunctionPythonExample`). |
| `lib/web-function-stack.ts` | Two compositions over one application: `Asgi` (`asgi:main:app`) and `Wsgi` (`wsgi:main_wsgi:application`), both on `python3.15` with the default `IamAuth` endpoint. |
| `app/main.py` | The ASGI entry point: `app = ASGIApp(build_app())`. |
| `app/main_wsgi.py` | The WSGI entry point: `application = WSGIApp(build_app())`. |
| `app/lib/application.py` | The AppTheory application both entry points serve: `/`, `/health` and a streamed `/stream`. |
| `scripts/serve-wsgi.py` | A local stand-in for the server Lambda manages: the standard library's WSGI server with a threading mixin. Not part of the deployment package. |

The application is written once. `apptheory.ASGIApp` and `apptheory.WSGIApp` turn a request into an AppTheory request,
call the runtime, and write the response back chunk by chunk, so `Response.html_stream` and
`apptheory.sse_event_stream` keep streaming instead of being buffered into one write.

## Prerequisites

- Node 24 or newer, for the CDK app.
- Python 3.12 or newer, with `scripts/local/requirements-examples.txt` installed (uvicorn is the ASGI server the row
  drives; the WSGI direction needs only the standard library).
- Docker or Colima, for the local rows only (the shared harness starts DynamoDB Local).
- No AWS credentials. The rows never contact AWS, and the harness strips every `AWS_*` variable it inherits.

## Run the application on its own

A Python Web Function's server is Lambda's, so locally you supply one. Nothing in the application changes:

```bash
# ASGI, exactly as the runtime loads it: asgi:main:app
cd app && PYTHONPATH=../../../py/src python3 -m uvicorn main:app --host 127.0.0.1 --port 3000

# WSGI, exactly as the runtime calls it: wsgi:main_wsgi:application
cd .. && PYTHONPATH=../../py/src PORT=3000 python3 scripts/serve-wsgi.py
```

```bash
curl -sS -D- http://127.0.0.1:3000/            # 200, text/html page
curl -sS -N  http://127.0.0.1:3000/stream      # events, one every 120 ms, no content-length
curl -sS -D- http://127.0.0.1:3000/health      # 200 ok
curl -sS -D- http://127.0.0.1:3000/nope        # 404 from AppTheory's own router
```

## Run the local rows

```bash
cd ../../..
python3 scripts/local/run_examples_local.py --only web-function-python,web-function-python-wsgi --workers 1
```

Expected output:

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

Each row starts the real server for its interface — uvicorn for ASGI, the standard library's threaded WSGI server for
WSGI — and drives it with real HTTP clients. Both rows assert status codes and headers, that the response is delivered
incrementally (the first of three events arrives as soon as the response opens and the last about 0.38 s later, with no
`content-length` declared), and that two overlapping requests each carry only their own tag and their own tick
sequence.

Concurrency is measured on delivery, not on the two client calls. Each chunk records the instant it arrived, both
requests record on one clock, and the row fails unless each response delivered chunks while the other was still open —
so a server that answers the second request only after the first stream ends is refused, even though the two calls
overlap. The seconds and the interleave counts move between runs; the requirement is at least two chunks from each
stream before the other finishes.

`scripts/local/test_examples_local.py` pins both directions of that assertion on three loopback control servers, once
for the Node.js row and once for these:

| Control | Delivery | The row |
| --- | --- | --- |
| Interleaved | both streams write chunks as they go | passes |
| Serial | the second response starts only after the first stream ends | fails: `the asgi second stream delivered 0 chunk(s) before the first stream finished at 0.509s (its own first chunk arrived at 0.510s), so the two responses were not delivered concurrently` |
| Module-level tag | the request tag lives outside the request | fails: `the wsgi first stream carried ['second', 'second', 'second'], so one request read another's state` |

The third control is the same mutation as editing this example: moving the tag out of the request's arguments into a
module-level variable makes the real row fail with `the asgi second stream carried ['first', 'first', 'first'], so one
request read another's state`.

## Synthesize the stack

```bash
npm ci
npx cdk synth
```

Both compositions keep the default `IamAuth` endpoint, so synthesis warns nothing. The entry point each revision
carries is in the template, and it is the whole Python configuration:

```text
AsgiFunctionRevision…  Runtime python3.15  AWS_LAMBDA_PYTHON_ENTRYPOINT asgi:main:app
WsgiFunctionRevision…  Runtime python3.15  AWS_LAMBDA_PYTHON_ENTRYPOINT wsgi:main_wsgi:application
```

Neither revision sets `AWS_LAMBDA_HTTP_ENDPOINT`: a Python application never learns where to listen, and the construct
refuses that variable — as it refuses `AWS_LAMBDA_PYTHON_ENTRYPOINT` — so nobody can shadow what it writes.

## Package and deploy

The deployment package is the **archive root** Lambda expects: `main.py`, `main_wsgi.py`, `lib/` and the `apptheory`
package (plus its dependencies), zipped together. AppTheory is distributed as a pinned GitHub Releases asset — see
[Installation](../../../docs/getting-started.md) — so the packaging step installs that wheel into a build directory and
zips it with `app/`. `lambda.WebFunctionCode.fromAssetToManagedBucket("app")` stages `app/` as-is, which is what makes
`synthesis` and the local rows work without a packaging step.

```bash
npx cdk deploy --all     # or: theory app up
```

Deploying is the one step this example does not prove locally, and `python3.15` is a public preview — do not treat this
example as a production Python deployment.

## Runtime support

`python3.15` is the only Python Web Function runtime, and it is an upstream public preview. Node.js 24 (`nodejs24.x`)
and Node.js 26 (`nodejs26.x`) are the supported Web Function runtimes and follow a different model — the application
starts its own HTTP server and reads `AWS_LAMBDA_HTTP_ENDPOINT`; see
[`examples/cdk/web-function`](../web-function/README.md). Go has no Web Function runtime upstream. See
[Runtime support](../../../docs/features/web-functions.md#runtime-support).
