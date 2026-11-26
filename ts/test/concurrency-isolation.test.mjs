import test from "node:test";
import assert from "node:assert/strict";

import { assertDistIsFresh } from "./invocation-scope-dist-freshness.mjs";
import {
  AppTheoryError,
  LOGGING_PROFILE_CLOUDWATCH_JSON,
  MemoryMcpSessionStore,
  MemoryMcpStreamStore,
  MemoryMcpTaskStore,
  ProfileLogger,
  createApp,
  defaultLoggingProfile,
  getLogger,
  setLogger,
} from "../dist/index.js";

// This file proves the multi-concurrency isolation invariant for the TypeScript
// runtime: an AWS Lambda Web Function serves many overlapping requests on one
// Node event loop, so each request must observe only its own context, identity,
// correlation id, logger binding, headers and response state, while the state
// that is intentionally process-wide stays shared AND stays correct while
// requests overlap.
//
// Node gives the runtime one thread, so the "overlap" this file manufactures is
// the only kind that exists: several handler bodies suspended at an `await` at
// the same time. Every barrier below is explicit, so a handler that reads shared
// state after an await does so with every other request's handler already
// resumed past the same point. That is the strongest interleaving the runtime
// can produce, and it is deterministic rather than racy — which is why these
// tests are a proof and not a flake.
//
// The runtime's corresponding obligation is the absence of a yield point: a
// shared store method must complete its read-modify-write without awaiting in
// the middle, or two interleaved requests observe the same "before" state. The
// MCP store tests below pin exactly that, so a future `await` inside a critical
// section fails here instead of corrupting a deployed Web Function.
//
// The tests load the built package, so assertDistIsFresh fails loudly when the
// build is older than the source it was built from instead of passing against
// stale output.
assertDistIsFresh();

/**
 * An explicit rendezvous for `size` handlers.
 *
 * Each call suspends until every participant has arrived, then releases them
 * together. A handler that reads shared state after `await barrier()` is
 * guaranteed to run after all its peers reached the same point.
 */
function rendezvous(size) {
  let arrived = 0;
  let release;
  const open = new Promise((resolve) => {
    release = resolve;
  });
  return async function wait() {
    arrived += 1;
    if (arrived === size) {
      release();
    }
    await open;
    // Yield once more so the peers that were released by the same promise get
    // to run their next synchronous stretch before this one continues.
    await new Promise((resolve) => setImmediate(resolve));
  };
}

function request(path, headers = {}) {
  return { method: "GET", path, headers, body: new Uint8Array(0) };
}

function bodyOf(response) {
  return JSON.parse(Buffer.from(response.body).toString("utf8"));
}

function headerOf(response, name) {
  return response.headers?.[name]?.[0] ?? "";
}

function echoApp(concurrency) {
  const barrier = rendezvous(concurrency);
  const app = createApp({ tier: "p2" });

  app.use(async (ctx, next) => {
    // Middleware state is request state: a value written here must be the value
    // this request's own handler reads, never a neighbour's.
    ctx.set("tenant_marker", `mw-${ctx.request.headers["x-tenant"]?.[0] ?? ""}`);
    const response = await next(ctx);
    return { ...response, headers: { ...response.headers, "x-mw-tenant": [String(ctx.get("tenant_marker"))] } };
  });

  app.get("/echo", async (ctx) => {
    const requestId = ctx.requestId;
    const marker = String(ctx.get("tenant_marker"));
    await barrier();
    // Read again after every peer resumed past the same point.
    assert.equal(ctx.requestId, requestId, "the request id moved between requests");
    assert.equal(String(ctx.get("tenant_marker")), marker, "middleware state moved between requests");
    return {
      status: 200,
      headers: { "x-request-id": [requestId] },
      cookies: [],
      body: Buffer.from(
        JSON.stringify({
          request_id: requestId,
          tenant: ctx.request.headers["x-tenant"]?.[0] ?? "",
          trace: ctx.request.headers["x-trace"]?.[0] ?? "",
          echo: ctx.request.headers["x-echo"]?.[0] ?? "",
          marker,
        }),
      ),
      isBase64: false,
    };
  });

  app.get("/fail", async (ctx) => {
    const requestId = ctx.requestId;
    await barrier();
    throw new AppTheoryError("app.boom", `failed ${requestId}`, { statusCode: 500 });
  });

  app.get("/early", async (ctx) => {
    await barrier();
    return {
      status: 204,
      headers: { "x-request-id": [ctx.requestId] },
      cookies: [],
      body: Buffer.alloc(0),
      isBase64: false,
    };
  });

  return app;
}

test("overlapping requests keep their own request context", async () => {
  const concurrency = 8;
  const app = echoApp(concurrency);

  const results = await Promise.all(
    Array.from({ length: concurrency }, async (_, index) => {
      const response = await app.serve(
        request("/echo", {
          "x-tenant": `tenant-${index}`,
          "x-trace": `trace-${index}`,
          "x-echo": `echo-${index}`,
        }),
      );
      assert.equal(response.status, 200);
      assert.equal(headerOf(response, "x-request-id"), bodyOf(response).request_id);
      return bodyOf(response);
    }),
  );

  assert.equal(
    new Set(results.map((result) => result.request_id)).size,
    concurrency,
    "two overlapping requests shared one request id",
  );
  results.forEach((result, index) => {
    assert.equal(result.tenant, `tenant-${index}`);
    assert.equal(result.trace, `trace-${index}`);
    assert.equal(result.echo, `echo-${index}`);
    assert.equal(result.marker, `mw-tenant-${index}`);
  });
});

test("overlapping failures and early returns keep their own identity", async () => {
  const concurrency = 6;
  const app = echoApp(concurrency);

  const failures = await Promise.all(
    Array.from({ length: concurrency }, async () =>
      app.serve(request("/fail", { "x-tenant": "tenant" })),
    ),
  );
  const failureIds = new Set();
  for (const response of failures) {
    assert.equal(response.status, 500);
    const error = bodyOf(response).error;
    assert.equal(error.code, "app.boom");
    // The handler raised with the request id it observed and the envelope
    // carries that same id: neither was swapped under load.
    assert.equal(error.message, `failed ${error.request_id}`);
    failureIds.add(error.request_id);
  }
  assert.equal(failureIds.size, concurrency, "overlapping failures shared one request id");

  const early = await Promise.all(
    Array.from({ length: concurrency }, async (_, index) =>
      app.serve(request("/early", { "x-tenant": `tenant-${index}` })),
    ),
  );
  assert.equal(new Set(early.map((response) => headerOf(response, "x-request-id"))).size, concurrency);
  early.forEach((response, index) => {
    assert.equal(response.status, 204);
    assert.equal(Buffer.from(response.body).length, 0);
    assert.equal(headerOf(response, "x-mw-tenant"), `mw-tenant-${index}`);
  });
});

test("the process logger keeps one instance while every request binds its own copy", async () => {
  const lines = [];
  const profile = new ProfileLogger(profileConfig(), {
    writer: (line) => lines.push(JSON.parse(line)),
    clock: () => new Date("2026-11-26T12:00:00Z"),
  });
  const previous = getLogger();
  setLogger(profile);
  try {
    const concurrency = 8;
    await Promise.all(
      Array.from({ length: concurrency }, async (_, index) => {
        const bound = getLogger();
        assert.equal(bound, profile, "the process logger must stay one object");
        const scoped = bound.withRequestID(`req-${index}`).withTenantID(`tenant-${index}`);
        // Binding derives a copy; it must never mutate the process logger in
        // place, or every overlapping request would inherit this identity.
        assert.notEqual(scoped, bound, "with* must derive a new logger, never mutate the shared one");
        for (let turn = 0; turn < 20; turn += 1) {
          scoped.info(`line ${index} ${turn}`);
          if (turn % 5 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      }),
    );
  } finally {
    setLogger(previous);
  }

  // One line logged through the unbound process logger must still carry no
  // request identity at all.
  profile.info("line root -1");
  const rootLine = lines.pop();
  assert.equal(rootLine.request_id ?? "", "");
  assert.equal(rootLine.tenant_id ?? "", "");

  assert.equal(lines.length, 8 * 20);
  for (const entry of lines) {
    const index = entry.message.split(" ")[1];
    assert.equal(entry.request_id, `req-${index}`);
    assert.equal(entry.tenant_id, `tenant-${index}`);
  }
});

test("the retained-log ring stays bounded and attributed under overlap", async () => {
  const profile = new ProfileLogger(profileConfig(), {
    writer: null,
    clock: () => new Date("2026-11-26T12:00:00Z"),
  });
  const concurrency = 8;
  const perWorker = 200;

  await Promise.all(
    Array.from({ length: concurrency }, async (_, index) => {
      const scoped = profile.withRequestID(`req-${index}`);
      for (let turn = 0; turn < perWorker; turn += 1) {
        scoped.info(`line ${index} ${turn}`);
        if (turn % 50 === 0) {
          // Yield in the middle of the run so peers interleave with this one.
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    }),
  );

  const total = concurrency * perWorker;
  const stats = profile.getStats();
  assert.equal(stats["entries_logged"], total, "the retained-log counter lost updates");
  const entries = profile.entries();
  assert.equal(entries.length, 1024, "the process-scoped ring must stay bounded");
  assert.equal(stats["entries_dropped"], total - 1024);
  for (const entry of entries) {
    assert.equal(entry.request_id, `req-${entry.message.split(" ")[1]}`);
  }
});

test("interleaved stream appends never skip or reorder an event id", async () => {
  // MemoryMcpStreamStore is process-wide by protocol and its append path is a
  // read-modify-write over the session's sequence counter. Node cannot pre-empt
  // it, so the invariant that makes it safe is the absence of an await between
  // the read and the write; this test interleaves callers aggressively and
  // fails if that invariant is ever broken.
  const store = new MemoryMcpStreamStore({ maxEventsPerSession: 4, maxTotalBytesPerSession: 1 << 30 });
  const streamId = await store.create("session-1");
  const concurrency = 8;
  const perWorker = 120;
  const observations = [];

  await Promise.all(
    Array.from({ length: concurrency }, async (_, index) => {
      if (index === 0) {
        for (let turn = 0; turn < perWorker; turn += 1) {
          observations.push((await store.subscribe("session-1", streamId)).map((event) => Number(event.id)));
          await new Promise((resolve) => setImmediate(resolve));
        }
        return;
      }
      for (let turn = 0; turn < perWorker; turn += 1) {
        await store.append("session-1", streamId, Buffer.from(`${index}:${turn}`));
        if (turn % 8 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    }),
  );

  for (const ids of observations) {
    assert.deepEqual(ids, [...ids].sort((left, right) => left - right), `subscription reordered: ${ids}`);
    // Eviction only ever removes from the front, so a snapshot may start
    // anywhere but must never skip an id in the middle.
    const expected = ids.length === 0 ? [] : Array.from({ length: ids.length }, (_, offset) => ids[0] + offset);
    assert.deepEqual(ids, expected, `subscription lost an event: ${ids}`);
  }
  const retained = await store.subscribe("session-1", streamId);
  assert.ok(retained.length <= 4, "the retention bound was exceeded");
});

test("interleaved task creates never lose a record", async () => {
  const store = new MemoryMcpTaskStore();
  const concurrency = 8;

  await Promise.all(
    Array.from({ length: concurrency }, async (_, index) => {
      if (index === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await store.create({
        sessionId: "session-1",
        method: "tools/call",
        task: { taskId: `task-${index}`, status: "working" },
      });
    }),
  );

  const listed = await store.list({ sessionId: "session-1", limit: 100 });
  assert.equal(listed.tasks.length, concurrency, "a concurrently created task was lost");
  assert.deepEqual(
    listed.tasks.map((task) => task.taskId).sort(),
    Array.from({ length: concurrency }, (_, index) => `task-${index}`).sort(),
  );
});

test("interleaved session reads never cross sessions", async () => {
  const store = new MemoryMcpSessionStore({ maxSessions: 64 });
  const concurrency = 8;

  await Promise.all(
    Array.from({ length: concurrency }, async (_, index) => {
      await store.put({ id: `session-${index}`, principal: `principal-${index}` });
    }),
  );

  const readers = await Promise.all(
    Array.from({ length: concurrency }, async () => {
      const principals = [];
      for (let other = 0; other < concurrency; other += 1) {
        const session = await store.get(`session-${other}`);
        principals.push(session.principal);
        await new Promise((resolve) => setImmediate(resolve));
      }
      return principals;
    }),
  );

  const expected = Array.from({ length: concurrency }, (_, index) => `principal-${index}`);
  for (const principals of readers) {
    assert.deepEqual(principals, expected);
  }
});

function profileConfig() {
  const config = defaultLoggingProfile(LOGGING_PROFILE_CLOUDWATCH_JSON);
  config.enrichment = { context: { request_id: "request.request_id", tenant_id: "request.tenant_id" } };
  config.required_fields = ["timestamp", "level", "message"];
  return config;
}
