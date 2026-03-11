import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../dist/app.js";
import { binary, htmlStream } from "../dist/response.js";
import {
  APPSYNC_PROJECTION_BINARY_REASON,
  APPSYNC_PROJECTION_MESSAGE,
  APPSYNC_PROJECTION_STREAM_REASON,
  appSyncPayloadFromResponse,
} from "../dist/internal/aws-appsync.js";
import { AppTheoryError } from "../dist/errors.js";

test("serveAppSync projects JSON, text, and empty bodies", async () => {
  const app = createApp({ tier: "p2" });

  app.post("/createThing", (ctx) => {
    return {
      status: 200,
      headers: { "content-type": ["application/json; charset=utf-8"] },
      cookies: [],
      body: Buffer.from(
        JSON.stringify({
          method: ctx.request.method,
          arguments: ctx.jsonValue(),
        }),
        "utf8",
      ),
      isBase64: false,
    };
  });
  app.get("/getThing", (ctx) => ({
    status: 200,
    headers: { "content-type": ["text/plain; charset=utf-8"] },
    cookies: [],
    body: Buffer.from(`${ctx.request.method}:${ctx.request.path}`, "utf8"),
    isBase64: false,
  }));
  app.get("/emptyThing", () => ({
    status: 204,
    headers: {},
    cookies: [],
    body: Buffer.alloc(0),
    isBase64: false,
  }));

  const jsonOut = await app.serveAppSync({
    arguments: { id: "thing_123" },
    info: { fieldName: "createThing", parentTypeName: "Mutation" },
  });
  assert.deepEqual(jsonOut, {
    method: "POST",
    arguments: { id: "thing_123" },
  });

  const textOut = await app.serveAppSync({
    arguments: {},
    info: { fieldName: "getThing", parentTypeName: "Query" },
  });
  assert.equal(textOut, "GET:/getThing");

  const emptyOut = await app.serveAppSync({
    arguments: {},
    info: { fieldName: "emptyThing", parentTypeName: "Query" },
  });
  assert.equal(emptyOut, null);
});

test("appSyncPayloadFromResponse rejects binary bodies deterministically", () => {
  assert.throws(
    () => appSyncPayloadFromResponse(binary(200, Buffer.from("abc"), "application/octet-stream")),
    (err) => {
      assert.ok(err instanceof AppTheoryError);
      assert.equal(err.code, "app.internal");
      assert.equal(err.message, APPSYNC_PROJECTION_MESSAGE);
      assert.deepEqual(err.details, {
        reason: APPSYNC_PROJECTION_BINARY_REASON,
      });
      return true;
    },
  );
});

test("appSyncPayloadFromResponse rejects streamed bodies deterministically", () => {
  assert.throws(
    () => appSyncPayloadFromResponse(htmlStream(200, ["chunk"])),
    (err) => {
      assert.ok(err instanceof AppTheoryError);
      assert.equal(err.code, "app.internal");
      assert.equal(err.message, APPSYNC_PROJECTION_MESSAGE);
      assert.deepEqual(err.details, {
        reason: APPSYNC_PROJECTION_STREAM_REASON,
      });
      return true;
    },
  );
});
