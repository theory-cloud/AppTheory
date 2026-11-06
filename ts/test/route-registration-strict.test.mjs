import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../dist/index.js";
import { AppTheoryError } from "../dist/errors.js";

const handler = () => ({ status: 200, body: "ok" });

const cases = [
  {
    name: "invalid pattern",
    message: "invalid route pattern",
    strict: (app) => app.handleStrict("GET", "/x/{}", handler),
    fluent: (app) => app.get("/x/{}", handler),
  },
  {
    name: "duplicate route",
    message: "duplicate route",
    strict: (app) => {
      app.handleStrict("GET", "/dup/{id}", handler);
      app.handleStrict("get", "/dup/:id", handler);
    },
    fluent: (app) => {
      app.get("/dup/{id}", handler);
      app.handle("get", "/dup/:id", handler);
    },
  },
  {
    name: "undefined handler",
    message: "route handler is nil",
    strict: (app) => app.handleStrict("GET", "/nil", undefined),
    fluent: (app) => app.get("/nil", undefined),
  },
];

for (const testCase of cases) {
  test(`handleStrict reports ${testCase.name} without a throw escaping the supported path`, () => {
    const app = createApp({ tier: "p0" });

    // A throw here is the contract: the Strict path is the supported
    // error-returning registration API. What must not happen is a swallowed
    // failure that leaves a dead route registered.
    let thrown;
    try {
      testCase.strict(app);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof AppTheoryError, `expected AppTheoryError, got ${thrown}`);
    assert.equal(thrown.code, "app.bad_request");
    assert.equal(thrown.statusCode, 400);
    assert.ok(
      String(thrown.message).includes(testCase.message),
      `expected ${JSON.stringify(testCase.message)} in ${JSON.stringify(thrown.message)}`,
    );

    // The fluent path fails closed on the same input with the same canonical error.
    let fluentThrown;
    try {
      testCase.fluent(createApp({ tier: "p0" }));
    } catch (err) {
      fluentThrown = err;
    }
    assert.ok(fluentThrown instanceof AppTheoryError, `expected AppTheoryError, got ${fluentThrown}`);
    assert.equal(fluentThrown.code, thrown.code);
    assert.equal(fluentThrown.message, thrown.message);
  });
}

test("handleStrict registers a valid route and serves it", async () => {
  const app = createApp({ tier: "p0" });
  app.handleStrict("GET", "/ping", () => ({ status: 200, body: "pong" }));

  const resp = await app.serve({ method: "GET", path: "/ping", headers: {}, body: "" });
  assert.equal(resp.status, 200);
  assert.equal(Buffer.from(resp.body).toString("utf8"), "pong");
});
