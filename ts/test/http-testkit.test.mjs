import test from "node:test";
import assert from "node:assert/strict";

import { createApp, json } from "../dist/index.js";
import {
  buildAPIGatewayV2Request,
  buildLambdaFunctionURLRequest,
  createTestEnv,
} from "../dist/testkit.js";

test("HTTP testkit builders set provider sourceIp metadata", async () => {
  const env = createTestEnv();
  const app = createApp({ tier: "p0" });

  app.get("/source", (ctx) => json(200, { source_ip: ctx.sourceIP() }));

  const v2Event = buildAPIGatewayV2Request("GET", "/source", {
    sourceIp: "2001:DB8::1",
  });
  assert.equal(v2Event.requestContext.http.sourceIp, "2001:DB8::1");

  const v2Out = await env.invokeAPIGatewayV2(app, v2Event);
  assert.deepEqual(JSON.parse(v2Out.body), { source_ip: "2001:db8::1" });

  const urlEvent = buildLambdaFunctionURLRequest("GET", "/source", {
    sourceIp: "198.51.100.88",
  });
  assert.equal(urlEvent.requestContext.http.sourceIp, "198.51.100.88");

  const urlOut = await env.invokeLambdaFunctionURL(app, urlEvent);
  assert.deepEqual(JSON.parse(urlOut.body), { source_ip: "198.51.100.88" });
});
