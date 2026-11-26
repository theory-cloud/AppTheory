// A Lambda Web Function application.
//
// A Web Function is not a request/response handler: the application starts its own HTTP server,
// Lambda forwards each request to it, and one execution environment answers many concurrent
// requests. Lambda picks the host and port and publishes them in AWS_LAMBDA_HTTP_ENDPOINT, so the
// server must read that variable and listen on exactly that address. Lambda does not set the
// variable on your machine, so the fallback below is what makes `node app/server.mjs` work
// locally.
//
// Concurrency rule this example exists to demonstrate: Node serves every request on one event
// loop, so all requests share this module's state. Request state therefore lives in the request's
// own closure and never in a module-level variable. Read a module global from two overlapping
// requests and each one sees the other's data; that is exactly what
// `scripts/local/run_examples_local.py`'s web-function row refuses to let regress.

import { createServer } from "node:http";

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || "localhost:3000").split(":");
const TICK_MILLISECONDS = 120;
const DEFAULT_TICKS = 3;
const MAX_TICKS = 20;

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>AppTheory Web Function</title>
  </head>
  <body>
    <h1>AppTheory Web Function</h1>
    <p>This page is served by the application's own HTTP server, one environment serving many
    concurrent requests.</p>
    <p><a href="/stream?tag=browser">Stream a response</a></p>
  </body>
</html>
`;

function send(response, status, contentType, body) {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function ticksFrom(query) {
  const requested = Number.parseInt(query.get("ticks") ?? "", 10);
  if (!Number.isFinite(requested) || requested < 1) {
    return DEFAULT_TICKS;
  }
  return Math.min(requested, MAX_TICKS);
}

// Streams one event per tick. Every value written here is derived from this request's own
// arguments, which is what keeps two overlapping streams from sharing a tick counter.
async function stream(response, tag, ticks) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });

  for (let tick = 1; tick <= ticks; tick += 1) {
    const event = { tag, tick, ticks };
    const written = response.write(`event: tick\ndata: ${JSON.stringify(event)}\n\n`);
    if (!written) {
      await new Promise((resolve) => response.once("drain", resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MILLISECONDS));
  }

  response.write(`event: done\ndata: ${JSON.stringify({ tag, ticks })}\n\n`);
  response.end();
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://web-function.local");

  if (url.pathname === "/") {
    send(response, 200, "text/html; charset=utf-8", PAGE);
    return;
  }

  if (url.pathname === "/health") {
    send(response, 200, "text/plain; charset=utf-8", "ok");
    return;
  }

  if (url.pathname === "/stream") {
    stream(response, url.searchParams.get("tag") ?? "anonymous", ticksFrom(url.searchParams)).catch(
      (error) => {
        if (!response.headersSent) {
          send(response, 500, "text/plain; charset=utf-8", `stream failed: ${error.message}`);
          return;
        }
        response.end();
      },
    );
    return;
  }

  send(response, 404, "text/plain; charset=utf-8", `no route for ${url.pathname}`);
});

server.listen(Number.parseInt(port, 10), host, () => {
  process.stdout.write(`web-function listening on ${host}:${port}\n`);
});
