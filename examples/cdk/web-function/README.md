# Lambda Web Function example

A Lambda **Web Function** serves HTTP directly: the application starts its own HTTP server, and one execution
environment answers many concurrent requests. This example shows the whole path — one CDK composition, an application
that serves a page and streams a response, and a local row that proves both without an AWS account.

Full guidance: [Lambda Web Functions](../../../docs/features/web-functions.md).

## What is here

| Path | What it is |
| --- | --- |
| `bin/app.ts` | The CDK app (`AppTheoryWebFunctionExample`). |
| `lib/web-function-stack.ts` | Two compositions over one application: an `IamAuth` endpoint (the default) and an `ApplicationManaged` opt-in, so both sides of the authorization decision are visible in one synthesized stack. |
| `app/server.mjs` | The application. A zero-dependency Node HTTP server that serves `/`, `/health` and a streamed `/stream`, and reads its listen address from `AWS_LAMBDA_HTTP_ENDPOINT`. |

## Prerequisites

- Node 24 or newer, for the application and the CDK app.
- Docker or Colima, for the local row only (the shared harness starts DynamoDB Local).
- No AWS credentials. The row never contacts AWS, and the harness strips every `AWS_*` variable it inherits.

## Run the application on its own

The application is the same code a Web Function environment runs. Lambda publishes the listen address in
`AWS_LAMBDA_HTTP_ENDPOINT`; locally you set it yourself, which is the only difference:

```bash
AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:3000 node app/server.mjs
```

```bash
curl -sS -D- http://127.0.0.1:3000/            # 200, text/html page
curl -sS -N  http://127.0.0.1:3000/stream      # chunked events, one every 120 ms
curl -sS -D- http://127.0.0.1:3000/health      # 200 ok
curl -sS -D- http://127.0.0.1:3000/nope        # 404 from the application's own router
```

## Run the local row

```bash
cd ../../..
python3 scripts/local/run_examples_local.py --only web-function --workers 1
```

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

The row starts the real server on the lane's port with `AWS_LAMBDA_HTTP_ENDPOINT` set and drives it with real HTTP
clients. It asserts status codes and headers, that the response is delivered incrementally (the first of three events
arrives as soon as the response opens and the last about 0.37 s later, with no `content-length` declared), and that
two concurrent streams in one environment each carry only their own tag and their own tick sequence.

Concurrency is measured on delivery, not on the two client calls. Each chunk records the instant it arrived, both
streams record on one clock, and the row fails unless each response delivered chunks while the other was still open —
so a server that answers the second request only after the first stream ends is refused, even though the two calls
overlap. The exact interleave counts move with scheduling; the requirement is at least two chunks from each stream
before the other finishes.

Both directions of that assertion are pinned in `scripts/local/test_examples_local.py`, which runs on every
`make examples-local` against three loopback control servers:

| Control | Delivery | The row |
| --- | --- | --- |
| Interleaved | both streams write chunks as they go | passes |
| Serial | the second response starts only after the first stream ends | fails: `the first stream delivered 0 chunk(s) before the second stream finished at 0.515s (its own first chunk arrived at 0.515s), so the two responses were not delivered concurrently` |
| Module-level tag | the request tag lives outside the request | fails: `the first stream carried ['second', 'second', 'second'], so one request read another's state` |

The third control is the same mutation as editing this example: moving the tag out of the request's closure makes
the real row fail with `the second stream carried ['first', 'first', 'first'], so one request read another's state`.

## Synthesize the stack

```bash
npm ci
npx cdk synth
```

Synthesis prints the documented public-endpoint warning, because the second composition opts into
`ApplicationManaged` on purpose:

```text
WARNING WebFunction endpoint uses APPLICATION_MANAGED auth. The Lambda service will not enforce
authentication; ensure your handler code validates every request. (Construct Annotations)
   AppTheoryWebFunctionExample/Public/Function/Endpoint
```

The first composition, `Private`, keeps the default `IamAuth` endpoint and warns nothing.

## Deploy

```bash
npx cdk deploy --all     # or: theory app up
```

Deploying is the one step this example does not prove locally. The application performs no authentication of its own,
so the `ApplicationManaged` endpoint is a demonstration, not a template for anything public.

## Runtime support

Node.js 24 (`nodejs24.x`) and Node.js 26 (`nodejs26.x`) are the runtimes AppTheory composes. Upstream `python3.15` is
in public preview and serves an ASGI or WSGI application, which AppTheory's Python runtime is not, so it is refused at
synthesis rather than deployed. Go has no Web Function runtime upstream. See
[Runtime support](../../../docs/features/web-functions.md#runtime-support).
