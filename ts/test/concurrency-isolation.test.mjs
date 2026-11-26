import test from "node:test";
import assert from "node:assert/strict";

import { SSMClient } from "@aws-sdk/client-ssm";

import { assertDistIsFresh } from "./invocation-scope-dist-freshness.mjs";
import {
  AppTheoryError,
  LOGGING_PROFILE_CLOUDWATCH_JSON,
  MICROVM_DEFAULT_SESSION_PROVIDER_ID,
  MemoryMcpSessionStore,
  MemoryMcpStreamStore,
  MemoryMcpTaskStore,
  MicroVMCommand,
  MicroVMState,
  ProfileLogger,
  createApp,
  createLambdaFunctionURLStreamingHandler,
  createMemoryMicroVMSessionRegistry,
  defaultLoggingProfile,
  getLogger,
  json,
  newJwksValidator,
  registerMcpFacade,
  setLogger,
  supportedEndpointTemplates,
} from "../dist/index.js";
import { newAutheoryProvider } from "../dist/oauth/provider.js";
import { newFakeOAuthProvider } from "../dist/testkit/oauthprovider.js";

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

// ---------------------------------------------------------------------------
// The micro:vm session registry.
//
// MemoryMicroVMSessionRegistry is constructed once per execution environment
// and shared by every request that drives a micro:vm session, exactly like the
// MCP stores above. Its methods must complete their read-modify-write inside
// one synchronous stretch; a future `await` between the read and the write is
// what these tests exist to catch.
// ---------------------------------------------------------------------------

const MICROVM_NOW = new Date(1000);
const MICROVM_EXPIRES = new Date(3_601_000);

function microvmRecord(sessionId, overrides = {}) {
  return {
    tenant_id: "tenant-a",
    namespace: "ns-a",
    session_id: sessionId,
    state: MicroVMState.Ready,
    desired_state: MicroVMState.Ready,
    provider_id: MICROVM_DEFAULT_SESSION_PROVIDER_ID,
    provider_microvm_id: sessionId,
    provider_state: MicroVMState.Ready,
    aws_lifecycle_state: MicroVMState.Ready,
    image_ref: "image-ref",
    image_version: "1",
    network_connector_ref: "network-ref",
    controller_id: "controller-1",
    created_at: MICROVM_NOW,
    updated_at: MICROVM_NOW,
    last_observed_at: MICROVM_NOW,
    expires_at: MICROVM_EXPIRES,
    generation: 1,
    last_command_id: "command-1",
    last_action: MicroVMCommand.Create,
    auth_subject: "subject-a",
    ...overrides,
  };
}

function microvmListInput(tenant, subject) {
  return { tenant_id: tenant, namespace: "ns-a", auth_subject: subject };
}

test("interleaved microvm registry writes never lose a record or cross a tenant", async () => {
  const registry = createMemoryMicroVMSessionRegistry({
    now: () => new Date(2000),
  });
  const tenants = ["tenant-a", "tenant-b", "tenant-c"];
  const perTenant = 12;
  const sessionId = (tenant, index) => `${tenant}-${String(index).padStart(3, "0")}`;

  for (const tenant of tenants) {
    for (let index = 0; index < perTenant; index += 1) {
      await registry.put(
        microvmRecord(sessionId(tenant, index), {
          tenant_id: tenant,
          auth_subject: `subject-${tenant}`,
        }),
      );
    }
  }

  const concurrency = 6;
  const listings = [];
  await Promise.all(
    Array.from({ length: concurrency }, async (_, index) => {
      const tenant = tenants[index % tenants.length];
      const subject = `subject-${tenant}`;
      const touched = sessionId(tenant, index % perTenant);
      for (let turn = 0; turn < 60; turn += 1) {
        const listed = await registry.list(microvmListInput(tenant, subject));
        listings.push(listed.map((session) => session.session_id));
        for (const session of listed) {
          assert.equal(session.tenant_id, tenant, `${tenant} listed another tenant's session`);
        }
        await registry.put(
          microvmRecord(touched, { tenant_id: tenant, auth_subject: subject }),
        );
        const fetched = await registry.get({
          tenant_id: tenant,
          namespace: "ns-a",
          session_id: touched,
        });
        assert.equal(fetched.session_id, touched, "the registry returned another session's record");
        if (turn % 10 === 0) {
          await registry.delete({ tenant_id: tenant, namespace: "ns-a", session_id: touched });
        }
        if (turn % 5 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
    }),
  );

  for (const ids of listings) {
    assert.deepEqual(
      ids,
      [...ids].sort((left, right) => left.localeCompare(right)),
      `listing reordered: ${ids.slice(0, 6)}`,
    );
    assert.equal(new Set(ids).size, ids.length, "a listing returned the same session twice");
  }

  for (const tenant of tenants) {
    const ids = (await registry.list(microvmListInput(tenant, `subject-${tenant}`))).map(
      (session) => session.session_id,
    );
    for (let index = 0; index < perTenant; index += 1) {
      assert.ok(ids.includes(sessionId(tenant, index)), `${tenant} lost a session record`);
    }
  }
});

test("microvm registry mutations finish inside one synchronous stretch", async () => {
  const registry = createMemoryMicroVMSessionRegistry({
    now: () => new Date(2000),
  });
  const recordsOf = () => [...registry.records.values()];

  // The TypeScript half of the audit rests on one property: no `await` sits
  // inside a registry method's critical section. Node cannot pre-empt a
  // synchronous stretch, so each call's effect must be visible the instant the
  // call returns, before any microtask could run a peer's method half way.
  const pendingPut = registry.put(microvmRecord("sync-1"));
  assert.equal(recordsOf().length, 1, "put() yielded before it stored the record");
  assert.equal(recordsOf()[0].session_id, "sync-1");

  const pendingDelete = registry.delete({
    tenant_id: "tenant-a",
    namespace: "ns-a",
    session_id: "sync-1",
  });
  assert.equal(recordsOf().length, 0, "delete() yielded before it dropped the record");
  await pendingPut;
  await pendingDelete;

  // A listing takes its snapshot when it is called: a delete issued immediately
  // afterwards cannot appear inside an earlier listing.
  await registry.put(microvmRecord("sync-2"));
  const listing = registry.list(microvmListInput("tenant-a", "subject-a"));
  const removal = registry.delete({
    tenant_id: "tenant-a",
    namespace: "ns-a",
    session_id: "sync-2",
  });
  assert.deepEqual(
    (await listing).map((session) => session.session_id),
    ["sync-2"],
    "list() yielded in the middle of its snapshot",
  );
  await removal;
  assert.deepEqual(await registry.list(microvmListInput("tenant-a", "subject-a")), []);

  // The stored record is a clone: a caller mutating what it was handed cannot
  // reach into another request's read.
  const stored = await registry.put(microvmRecord("sync-3"));
  stored.state = MicroVMState.Failed;
  const reread = await registry.get({ tenant_id: "tenant-a", namespace: "ns-a", session_id: "sync-3" });
  assert.equal(reread.state, MicroVMState.Ready, "the registry handed back its live record");
});

// ---------------------------------------------------------------------------
// The AppSync resolver context and the production Function URL response writer.
// ---------------------------------------------------------------------------

test("overlapping AppSync resolvers keep their own resolver context", async () => {
  const concurrency = 6;
  const barrier = rendezvous(concurrency);
  const app = createApp({ tier: "p2" });

  app.post("/createThing", async (ctx) => {
    const appsync = ctx.asAppSync();
    assert.ok(appsync, "an AppSync route must expose its resolver context");
    const snapshot = {
      fieldName: appsync.fieldName,
      parentTypeName: appsync.parentTypeName,
      arguments: JSON.stringify(appsync.arguments),
      identity: JSON.stringify(appsync.identity),
      source: JSON.stringify(appsync.source),
      variables: JSON.stringify(appsync.variables),
      stash: JSON.stringify(appsync.stash),
      headers: JSON.stringify(appsync.requestHeaders),
      prev: String(appsync.prev),
      triggerField: String(ctx.get("apptheory.appsync.field_name")),
    };
    const requestId = ctx.requestId;
    await barrier();
    // Read again after every peer resolved its own event: nothing this resolver
    // owns may have moved.
    assert.equal(ctx.asAppSync(), appsync, "the resolver context moved");
    assert.equal(ctx.requestId, requestId, "the request id moved between resolvers");
    assert.deepEqual(
      {
        fieldName: appsync.fieldName,
        parentTypeName: appsync.parentTypeName,
        arguments: JSON.stringify(appsync.arguments),
        identity: JSON.stringify(appsync.identity),
        source: JSON.stringify(appsync.source),
        variables: JSON.stringify(appsync.variables),
        stash: JSON.stringify(appsync.stash),
        headers: JSON.stringify(appsync.requestHeaders),
        prev: String(appsync.prev),
        triggerField: String(ctx.get("apptheory.appsync.field_name")),
      },
      snapshot,
      "AppSync resolver metadata moved between requests",
    );
    return json(200, {
      field: appsync.fieldName,
      argument: appsync.arguments.id,
      identity: appsync.identity.username,
      variable: appsync.variables.tenantId,
      header: appsync.requestHeaders["x-appsync"],
      stash: appsync.stash.marker,
      trigger: snapshot.triggerField,
      request_id: requestId,
    });
  });

  const results = await Promise.all(
    Array.from({ length: concurrency }, async (_, index) =>
      app.serveAppSync({
        arguments: { id: `thing_${index}` },
        identity: { username: `user_${index}` },
        source: { id: `parent_${index}` },
        request: { headers: { "x-appsync": `header_${index}` } },
        info: {
          fieldName: "createThing",
          parentTypeName: "Mutation",
          variables: { tenantId: `tenant_${index}` },
        },
        prev: `prev_${index}`,
        stash: { marker: `stash_${index}` },
      }),
    ),
  );

  assert.equal(new Set(results.map((result) => result.request_id)).size, concurrency);
  results.forEach((result, index) => {
    assert.equal(result.field, "createThing");
    assert.equal(result.argument, `thing_${index}`);
    assert.equal(result.identity, `user_${index}`);
    assert.equal(result.variable, `tenant_${index}`);
    assert.equal(result.header, `header_${index}`);
    assert.equal(result.stash, `stash_${index}`);
    assert.equal(result.trigger, "createThing");
  });
});

class RecordingResponseStream {
  constructor() {
    this.statusCode = 0;
    this.headers = {};
    this.cookies = [];
    this.chunks = [];
    this.ended = false;
  }

  init(meta) {
    this.statusCode = Number(meta?.statusCode ?? 0);
    this.headers = { ...(meta?.headers ?? {}) };
    this.cookies = [...(meta?.cookies ?? [])];
  }

  write(chunk) {
    this.chunks.push(Buffer.from(chunk ?? []));
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.write(chunk);
    this.ended = true;
  }

  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function lambdaFunctionURLEvent(path) {
  return {
    version: "2.0",
    rawPath: path,
    rawQueryString: "",
    cookies: [],
    headers: {},
    queryStringParameters: null,
    requestContext: { http: { method: "GET", path } },
    body: "",
    isBase64Encoded: false,
  };
}

function streamingHandler(app) {
  globalThis.awslambda = { streamifyResponse: (handler) => handler };
  return createLambdaFunctionURLStreamingHandler(app);
}

/** A body stream that yields to its peer before every chunk. */
function interleavedStream(label, chunks, barrier, failAfter = -1) {
  return (async function* () {
    for (const [index, chunk] of chunks.entries()) {
      if (index < failAfter || failAfter < 0) {
        await barrier();
      } else {
        throw new AppTheoryError("stream.broken", `stream ${label} broke`, { statusCode: 500 });
      }
      yield Buffer.from(`${label}:${chunk}`, "utf8");
    }
  })();
}

function streamingApp(streamFor, tier = "p0") {
  const app = createApp({ tier });
  for (const path of ["/alpha", "/beta"]) {
    app.get(path, (ctx) => ({
      status: 200,
      headers: { "content-type": ["text/plain"], "x-request-id": [ctx.requestId] },
      cookies: [],
      body: Buffer.alloc(0),
      isBase64: false,
      bodyStream: streamFor(path.replace("/", ""), ctx.requestId),
    }));
  }
  return app;
}

test("overlapping function URL streamed responses keep their own transport state", async () => {
  const concurrency = 2;
  const barrier = rendezvous(concurrency);
  const app = streamingApp((label) => interleavedStream(label, ["1", "2", "3"], barrier), "p2");
  const handler = streamingHandler(app);
  const alpha = new RecordingResponseStream();
  const beta = new RecordingResponseStream();

  const codes = await Promise.all([
    handler(lambdaFunctionURLEvent("/alpha"), alpha, undefined),
    handler(lambdaFunctionURLEvent("/beta"), beta, undefined),
  ]);

  assert.deepEqual(codes, ["", ""], "a clean stream must not report an error code");
  assert.equal(alpha.statusCode, 200);
  assert.equal(beta.statusCode, 200);
  assert.notEqual(
    alpha.headers["x-request-id"],
    beta.headers["x-request-id"],
    "two invocations shared one response header set",
  );
  assert.equal(alpha.text(), "alpha:1alpha:2alpha:3", "a chunk crossed into another invocation's stream");
  assert.equal(beta.text(), "beta:1beta:2beta:3", "a chunk crossed into another invocation's stream");
  assert.ok(alpha.ended && beta.ended, "an invocation ended the other's stream");
});

test("a broken stream reports only its own invocation's error code", async () => {
  const concurrency = 2;
  const barrier = rendezvous(concurrency);
  const app = streamingApp(
    (label) =>
      label === "beta"
        ? interleavedStream(label, ["1", "2"], barrier, 1)
        : interleavedStream(label, ["1", "2"], barrier),
    "p2",
  );
  const handler = streamingHandler(app);
  const alpha = new RecordingResponseStream();
  const beta = new RecordingResponseStream();

  const [alphaCode, betaCode] = await Promise.all([
    handler(lambdaFunctionURLEvent("/alpha"), alpha, undefined),
    handler(lambdaFunctionURLEvent("/beta"), beta, undefined),
  ]);

  assert.equal(betaCode, "stream.broken", "the failing invocation must report its own error code");
  assert.equal(alphaCode, "", "the healthy invocation inherited the failing invocation's error code");
  assert.equal(alpha.text(), "alpha:1alpha:2");
  assert.equal(beta.text(), "beta:1", "the failed invocation wrote past its failure");
  assert.equal(alpha.statusCode, 200);
  assert.notEqual(alpha.headers["x-request-id"], beta.headers["x-request-id"]);
});

// ---------------------------------------------------------------------------
// The safe-shared holders the first round of tests reached only indirectly:
// the default (un-injected) front-door SSM reader and the OAuth provider's
// discovery/validator caches. Only the network boundary is stubbed.
// ---------------------------------------------------------------------------

const FRONT_DOOR_PARAMETER = "/apptheory/frontdoor/secret";
const FRONT_DOOR_SECRET = "front-door-secret-0123456789-abcdefghi";
const FRONT_DOOR_RESOURCE_METADATA_URL =
  "https://front.example.com/.well-known/oauth-protected-resource/acme/mcp";

function frontDoorParameterConfig() {
  const scopes = {};
  for (const template of supportedEndpointTemplates()) {
    scopes[template.kind] = ["namespace:use"];
  }
  return {
    issuerURL: "https://issuer.example.com/",
    jwksURI: "https://issuer.example.com/jwks.json?set=active",
    urlMode: "public_base_url",
    publicBaseURL: "https://front.example.com/",
    scopes,
    mcpHandler: () => ({
      status: 204,
      headers: {},
      cookies: [],
      body: Buffer.alloc(0),
      isBase64: false,
    }),
    transportPosture: "runtime-bearer",
    requireBearerToken: {
      resourceMetadataURL: FRONT_DOOR_RESOURCE_METADATA_URL,
      validator: () => {},
    },
    originReachability: "fronted",
    // No frontDoorSecretReader: the read goes through the production default
    // reader, which lazily imports the SDK and shares one module-level client.
    frontDoorVerification: {
      headerName: "x-front-door",
      secretParameterName: FRONT_DOOR_PARAMETER,
    },
  };
}

test("the default front-door parameter reader shares one SSM client under overlap", async () => {
  const sends = [];
  const originalSend = SSMClient.prototype.send;
  // The network boundary only: the SSM client under test is the real one, and
  // the recorded receiver identifies which client instance actually sent.
  SSMClient.prototype.send = async function send(command) {
    sends.push({
      client: this,
      name: command?.input?.Name,
      decryption: command?.input?.WithDecryption,
    });
    return { Parameter: { Value: FRONT_DOOR_SECRET } };
  };

  try {
    const concurrency = 6;
    const barrier = rendezvous(concurrency);
    const apps = [];
    for (let index = 0; index < concurrency; index += 1) {
      // One app per cache, so all N caches are cold at the same time and every
      // first read really does reach the shared client concurrently.
      const app = createApp({ tier: "p0" });
      const inventory = registerMcpFacade(app, frontDoorParameterConfig());
      apps.push({ app, path: inventory.routes[0].mcpPattern });
    }

    const responses = await Promise.all(
      apps.map(async ({ app, path }) => {
        await barrier();
        return await app.serve({
          method: "POST",
          path,
          query: {},
          headers: {
            "x-front-door": [FRONT_DOOR_SECRET],
            authorization: ["Bearer admitted-token"],
          },
          body: Buffer.alloc(0),
          isBase64: false,
        });
      }),
    );

    for (const response of responses) {
      assert.equal(response.status, 204, "a valid front-door secret must be admitted under overlap");
    }
    assert.equal(sends.length, concurrency, "an overlapping request skipped its parameter read");
    assert.equal(
      new Set(sends.map((send) => send.client)).size,
      1,
      "the default reader created more than one SSM client",
    );
    for (const send of sends) {
      assert.equal(send.name, FRONT_DOOR_PARAMETER);
      assert.equal(send.decryption, true, "the parameter read must ask for decryption");
    }
  } finally {
    SSMClient.prototype.send = originalSend;
  }
});

function bridgeFetch(publicBaseUrl, loopbackUrl, paths) {
  const loopback = new URL(loopbackUrl);
  const host = new URL(publicBaseUrl).hostname;
  return async (input, init) => {
    const target = new URL(String(input));
    paths.push(target.pathname);
    if (target.hostname === host) {
      target.protocol = loopback.protocol;
      target.host = loopback.host;
    }
    return await fetch(target, init);
  };
}

const PROVIDER_AUDIENCE = "https://mcp.example.test/acme/mcp";

function validatorContext(pathname = "/acme/mcp") {
  const values = new Map();
  return {
    request: { headers: {}, path: pathname },
    set: (key, value) => values.set(key, value),
    get: (key) => values.get(key),
  };
}

test("a cold key set serves every overlapping validation", async () => {
  const issuer = "https://cold-key-set.example.test";
  const upstream = newFakeOAuthProvider({ issuer, publicBaseUrl: issuer });
  const loopback = await upstream.start();
  try {
    const paths = [];
    // One validator with one cold cache is exactly what the provider hands to
    // every request in an execution environment: the first burst of valid
    // tokens must all be authorized, and none of them may be refused just
    // because a sibling request was still fetching the key set.
    const validate = await newJwksValidator({
      issuer,
      jwksUri: `${issuer}/.well-known/jwks.json`,
      fetchImpl: bridgeFetch(issuer, loopback, paths),
      allowPrivateHosts: true,
      requiredAudience: PROVIDER_AUDIENCE,
      requiredScopes: ["namespace:use"],
    });
    const token = upstream.mintAccessToken({
      audience: PROVIDER_AUDIENCE,
      subject: "user-1",
      scope: "namespace:use",
    });
    const concurrency = 8;

    const claims = await Promise.all(
      Array.from({ length: concurrency }, async () => await validate(validatorContext(), token)),
    );
    for (const result of claims) {
      assert.equal(result.subject, "user-1", "a concurrent first request was refused a valid token");
    }
    assert.equal(
      paths.filter((path) => path === "/.well-known/jwks.json").length,
      1,
      "the first burst fetched the key set more than once",
    );
    // The cooldown still bounds fetch amplification around that first burst: a
    // genuinely unknown kid is refused and, once its window is open, a repeat
    // inside the cooldown costs no further fetch.
    const unknown = upstream.mintAccessToken({
      audience: PROVIDER_AUDIENCE,
      subject: "user-1",
      scope: "namespace:use",
      kid: "never-published",
    });
    const beforeUnknown = paths.filter((path) => path === "/.well-known/jwks.json").length;
    await assert.rejects(async () => await validate(validatorContext(), unknown));
    const afterFirstUnknown = paths.filter((path) => path === "/.well-known/jwks.json").length;
    assert.ok(
      afterFirstUnknown - beforeUnknown <= 2,
      `an unknown kid fetched more than its per-kid bound: ${afterFirstUnknown - beforeUnknown}`,
    );
    await assert.rejects(async () => await validate(validatorContext(), unknown));
    assert.equal(
      paths.filter((path) => path === "/.well-known/jwks.json").length,
      afterFirstUnknown,
      "a repeat unknown kid inside the cooldown fetched again",
    );
  } finally {
    await upstream.close();
  }
});

/** A promise the test resolves by hand, so a fetch is held, not raced. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Settles a validation into an outcome instead of throwing mid-assertion. */
async function settled(promise) {
  return await promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, reason: String(error?.message ?? error) }),
  );
}

/**
 * One validator whose key-set fetch serves a first document without the
 * requested key and a second document with it — the publication lag
 * `unknown-kid-triggers-one-refresh` requires a single request to survive.
 * Both fetches are held at the transport boundary, so a test arranges the
 * overlap exactly instead of hoping for it.
 */
function stagedKeyPublication(issuer, published, late) {
  const first = deferred();
  const retry = deferred();
  const state = {
    fetches: 0,
    firstStarted: deferred(),
    retryStarted: deferred(),
  };
  const fetchImpl = async () => {
    state.fetches += 1;
    if (state.fetches === 1) {
      state.firstStarted.resolve();
      return await first.promise;
    }
    if (state.fetches === 2) {
      state.retryStarted.resolve();
      return await retry.promise;
    }
    // Every later fetch answers with a steady document, so the negative
    // controls are refused by the key set rather than by a transport error.
    return Response.json(published.jwksDocument());
  };
  return {
    state,
    publishFirst: () => first.resolve(Response.json(published.jwksDocument())),
    publishLate: () => retry.resolve(Response.json(late.jwksDocument())),
    build: async (overrides = {}) =>
      await newJwksValidator({
        issuer,
        jwksUri: `${issuer}/jwks`,
        fetchImpl,
        allowPrivateHosts: true,
        requiredAudience: PROVIDER_AUDIENCE,
        requiredScopes: ["namespace:use"],
        ...overrides,
      }),
  };
}

test("the key-publication retry serves every overlapping valid caller", async () => {
  // The shared fixture already promises that a valid token is accepted when its
  // signing key is published after the first key-set fetch. On a Web Function
  // that token arrives as a burst, so every caller inside the validator's
  // bounded retry must reach the outcome the single request reaches — not
  // `unknown_kid` because a sibling request was mid-resolution. The controls
  // below keep the refusal paths exactly where they were.
  const issuer = "https://key-publication.example.test";
  const published = newFakeOAuthProvider({ issuer, kid: "kid-published" });
  const late = newFakeOAuthProvider({ issuer, kid: "kid-late" });
  const minted = (subject, overrides = {}) =>
    late.mintAccessToken({
      audience: PROVIDER_AUDIENCE,
      subject,
      scope: "namespace:use",
      ...overrides,
    });

  // The single-request control: one caller, one resolution, two fetches.
  const control = stagedKeyPublication(issuer, published, late);
  const single = await control.build();
  const singleRun = settled(single(validatorContext(), minted("single")));
  await control.state.firstStarted.promise;
  assert.equal(control.state.fetches, 1, "the control fetched the key set twice at once");
  control.publishFirst();
  await control.state.retryStarted.promise;
  control.publishLate();
  const singleOutcome = await singleRun;
  assert.equal(singleOutcome.ok, true, `the single-request control was refused: ${singleOutcome.reason}`);
  assert.equal(singleOutcome.value.subject, "single");
  assert.equal(control.state.fetches, 2, "the single-request control outspent its retry");

  // The same retry, arrived at by eight overlapping callers at once. They are
  // started synchronously, which is how a burst reaches one event loop: every
  // caller runs into the resolution before the first document is published.
  const overlap = stagedKeyPublication(issuer, published, late);
  const validate = await overlap.build({ maxUnknownKidFetches: 4 });
  const concurrency = 8;
  const tokens = Array.from({ length: concurrency }, (_, index) => minted(`user-${index}`));
  const burst = tokens.map(
    async (token) => await settled(validate(validatorContext(), token)),
  );
  assert.equal(overlap.state.fetches, 1, "the first key-set document was fetched more than once");
  overlap.publishFirst();
  await overlap.state.retryStarted.promise;
  // Let the peers observe the first document, so the row covers the retry and
  // not a lucky single fetch.
  await new Promise((resolve) => setTimeout(resolve, 20));
  overlap.publishLate();
  const outcomes = await Promise.all(burst);
  outcomes.forEach((outcome, index) => {
    assert.equal(outcome.ok, true, `overlapping caller ${index} was refused a valid token: ${outcome.reason}`);
    assert.equal(outcome.value.subject, `user-${index}`, "an overlapping caller received another caller's claims");
  });
  assert.equal(overlap.state.fetches, 2, "the overlapping burst outspent the single request's retry");

  // Control: an unpublished kid is still refused, inside its per-kid bound.
  const stranger = minted("stranger", { kid: "never-published" });
  const strangerOutcome = await settled(validate(validatorContext(), stranger));
  assert.equal(strangerOutcome.ok, false, "an unpublished kid was authorized");
  assert.match(strangerOutcome.reason, /unknown_kid/);
  const afterStranger = overlap.state.fetches;
  assert.ok(
    afterStranger - 2 <= 2,
    `an unknown kid outspent its per-kid bound: ${afterStranger - 2}`,
  );
  const repeated = await settled(validate(validatorContext(), stranger));
  assert.equal(repeated.ok, false, "a repeat unknown kid was authorized");
  assert.equal(overlap.state.fetches, afterStranger, "a repeat unknown kid inside the cooldown fetched again");

  // Control: the global unknown-kid fetch budget still refuses, without a fetch.
  const budgeted = await settled(
    validate(validatorContext(), minted("budgeted", { kid: "never-published-either" })),
  );
  assert.equal(budgeted.ok, false, "a kid past the fetch budget was authorized");
  assert.match(budgeted.reason, /unknown_kid/);
  assert.equal(overlap.state.fetches, afterStranger, "an exhausted fetch budget still fetched");

  // Control: a failing key set fails closed on one fetch, however many callers.
  let failures = 0;
  const failing = await newJwksValidator({
    issuer,
    jwksUri: `${issuer}/jwks`,
    allowPrivateHosts: true,
    requiredAudience: PROVIDER_AUDIENCE,
    requiredScopes: ["namespace:use"],
    fetchImpl: async () => {
      failures += 1;
      return new Response(null, { status: 503 });
    },
  });
  const failureOutcomes = await Promise.all(
    tokens.map(async (token) => await settled(failing(validatorContext(), token))),
  );
  for (const outcome of failureOutcomes) {
    assert.equal(outcome.ok, false, "a 503 key set authorized a valid token");
  }
  assert.equal(failures, 1, `a failing key set was fetched ${failures} times`);

  // Control: a hanging key set fails closed on one fetch, however many callers.
  const hang = deferred();
  let hangs = 0;
  const hanging = await newJwksValidator({
    issuer,
    jwksUri: `${issuer}/jwks`,
    allowPrivateHosts: true,
    fetchTimeoutSeconds: 0.05,
    requiredAudience: PROVIDER_AUDIENCE,
    requiredScopes: ["namespace:use"],
    fetchImpl: async () => {
      hangs += 1;
      return await hang.promise;
    },
  });
  const hangOutcomes = await Promise.all(
    tokens.map(async (token) => await settled(hanging(validatorContext(), token))),
  );
  for (const outcome of hangOutcomes) {
    assert.equal(outcome.ok, false, "a never-resolving key set authorized a valid token");
  }
  assert.equal(hangs, 1, `a hanging key set was fetched ${hangs} times`);
  hang.resolve(new Response(null, { status: 503 }));
});

test("the provider caches discovery and validators under overlap", async () => {
  const issuer = "https://provider-cache-a.example.test";
  const otherIssuer = "https://provider-cache-b.example.test";
  const upstream = newFakeOAuthProvider({ issuer, publicBaseUrl: issuer });
  const otherUpstream = newFakeOAuthProvider({
    issuer: otherIssuer,
    publicBaseUrl: otherIssuer,
    kid: "fake-provider-key-2",
  });
  const loopback = await upstream.start();
  const otherLoopback = await otherUpstream.start();
  try {
    const paths = [];
    const otherPaths = [];
    const provider = await newAutheoryProvider({
      issuer,
      fetchImpl: bridgeFetch(issuer, loopback, paths),
      allowPrivateHosts: true,
    });
    const otherProvider = await newAutheoryProvider({
      issuer: otherIssuer,
      fetchImpl: bridgeFetch(otherIssuer, otherLoopback, otherPaths),
      allowPrivateHosts: true,
    });
    const concurrency = 8;

    const discovered = await Promise.all(
      Array.from({ length: concurrency }, async () => await provider.discovery()),
    );
    assert.equal(new Set(discovered).size, 1, "concurrent callers received different metadata objects");
    assert.equal(
      paths.filter((path) => path === "/.well-known/oauth-authorization-server").length,
      1,
      "discovery was fetched once per concurrent caller",
    );

    const token = upstream.mintAccessToken({
      audience: PROVIDER_AUDIENCE,
      subject: "user-1",
      scope: "namespace:use",
    });
    const expected = {
      expectedIssuer: issuer,
      expectedAudience: PROVIDER_AUDIENCE,
      requiredScopes: ["namespace:use"],
    };
    const claims = await Promise.all(
      Array.from({ length: concurrency }, async () => await provider.validateAccessToken(token, expected)),
    );
    for (const result of claims) {
      assert.equal(result.subject, "user-1", "a valid token was refused under overlap");
      assert.equal(result.audience, PROVIDER_AUDIENCE);
      assert.deepEqual(result.scopes, ["namespace:use"]);
    }
    assert.equal(
      paths.filter((path) => path === "/.well-known/jwks.json").length,
      1,
      "the validator cache was bypassed and the key set refetched per caller",
    );

    // Two issuers, two keys, interleaved: each cached validator must answer only
    // for its own issuer.
    const otherToken = otherUpstream.mintAccessToken({
      audience: PROVIDER_AUDIENCE,
      subject: "user-2",
      scope: "namespace:use",
    });
    const otherExpected = {
      expectedIssuer: otherIssuer,
      expectedAudience: PROVIDER_AUDIENCE,
      requiredScopes: ["namespace:use"],
    };
    const mixed = await Promise.all(
      Array.from({ length: 4 }, async (_, index) =>
        index % 2 === 0
          ? ["a", (await provider.validateAccessToken(token, expected)).subject]
          : ["b", (await otherProvider.validateAccessToken(otherToken, otherExpected)).subject],
      ),
    );
    for (const [which, subject] of mixed) {
      assert.equal(subject, which === "a" ? "user-1" : "user-2", "a cached validator answered for the wrong issuer");
    }
    assert.equal(otherPaths.filter((path) => path === "/.well-known/jwks.json").length, 1);

    await assert.rejects(
      async () => await otherProvider.validateAccessToken(token, otherExpected),
      "issuer B must not verify issuer A's token",
    );
    await assert.rejects(
      async () => await provider.validateAccessToken(otherToken, expected),
      "issuer A must not verify issuer B's token",
    );
  } finally {
    await upstream.close();
    await otherUpstream.close();
  }
});
