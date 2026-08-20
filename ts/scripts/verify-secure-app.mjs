import assert from "node:assert/strict";

import {
  App,
  Authenticated,
  InternalOnly,
  Optional,
  Public,
  SecureApp,
  text,
} from "../dist/index.js";

const ok = async () => text(200, "ok");

for (const tier of [undefined, "p0", "p1", "p2"]) {
  const app = new SecureApp(tier === undefined ? {} : { tier });
  assert.ok(app instanceof SecureApp);
}
assert.throws(
  () => new SecureApp({ tier: "p3" }),
  /apptheory: invalid secure configuration/,
);
assert.throws(
  () => new SecureApp({ unknownOption: true }),
  /apptheory: invalid secure configuration/,
);
assert.throws(
  () => new SecureApp({ webSocketClientFactory: 7 }),
  /apptheory: invalid secure configuration/,
);

const requiredMethods = [
  "serve",
  "serveALB",
  "serveAPIGatewayProxy",
  "serveAPIGatewayV2",
  "serveLambdaFunctionURL",
  "serveAppSync",
  "serveWebSocket",
  "serveDynamoDBStream",
  "serveEventBridge",
  "serveKinesisEvent",
  "serveSNSEvent",
  "serveSQSEvent",
  "handleLambda",
  "use",
  "useEvents",
  "isLambda",
  "sqs",
  "sns",
  "kinesis",
  "eventBridge",
  "dynamoDB",
];
for (const method of requiredMethods) {
  assert.equal(typeof SecureApp.prototype[method], "function", method);
}
for (const forbidden of ["handleStrict", "getStrict", "core", "unwrap"]) {
  assert.equal(forbidden in SecureApp.prototype, false, forbidden);
}

const routesApp = new SecureApp();
routesApp.get(
  " widgets/:id?ignored=true ",
  ok,
  Authenticated(" read ", "write", "read"),
);
routesApp.appSyncField("Subscription", "changed", ok, Optional());
routesApp.webSocket(" $default ", ok, InternalOnly());
assert.deepEqual(routesApp.routes(), [
  {
    surface: "http",
    method: "GET",
    path: "/widgets/{id}",
    posture: "authenticated",
    scopes: ["read", "write"],
  },
  {
    surface: "appsync",
    method: "GET",
    path: "/changed",
    posture: "optional",
    appSyncParentType: "Subscription",
    appSyncField: "changed",
  },
  {
    surface: "websocket",
    method: "",
    path: "",
    posture: "internal_only",
    webSocketRouteKey: "$default",
  },
]);
const mutatedRoutes = routesApp.routes();
mutatedRoutes[0].path = "/mutated";
mutatedRoutes[0].scopes[0] = "mutated";
assert.equal(routesApp.routes()[0].path, "/widgets/{id}");
assert.deepEqual(routesApp.routes()[0].scopes, ["read", "write"]);
assert.throws(() => routesApp.get("/zero", ok, {}), /invalid auth posture/);
assert.throws(
  () => routesApp.get("/empty", ok, Authenticated(" ")),
  /normalize to empty/,
);
assert.throws(
  () => routesApp.get("/widgets/{id}", ok, Public()),
  /duplicate route/,
);
assert.throws(
  () => routesApp.webSocket("$default", ok, Public()),
  /duplicate websocket route/,
);

const sourceClaims = { nested: { values: ["original"] } };
const copyApp = new SecureApp({
  principalResolver: async () => ({
    identity: " user ",
    kind: "",
    scopes: [" read ", "read"],
    claims: sourceClaims,
  }),
});
copyApp.get(
  "/copy",
  async (ctx) => {
    const first = ctx.securePrincipal();
    first.identity = "mutated";
    first.scopes[0] = "mutated";
    first.claims.nested.values[0] = "mutated";
    const second = ctx.securePrincipal();
    assert.notEqual(first, second);
    assert.deepEqual(second, {
      identity: "user",
      kind: "external",
      scopes: ["read"],
      claims: { nested: { values: ["original"] } },
    });
    return text(200, "ok");
  },
  Authenticated(),
);
assert.equal(
  (
    await copyApp.serve({
      method: "GET",
      path: "/copy",
      query: {},
      headers: {},
      body: Buffer.alloc(0),
      isBase64: false,
    })
  ).status,
  200,
);
assert.deepEqual(sourceClaims, { nested: { values: ["original"] } });

const websocketEvent = {
  requestContext: {
    routeKey: "$default",
    connectionId: "c1",
    requestId: "r1",
  },
};
await assert.rejects(
  () => new SecureApp().handleLambda(websocketEvent),
  /unknown event type/,
);
assert.equal(
  (await new SecureApp({ webSocketSupport: true }).handleLambda(websocketEvent))
    .statusCode,
  404,
);

const synthetic = new App({ tier: "p0" });
synthetic._secure = true;
synthetic._router.addSecure("GET", "/synthetic", ok, {
  surface: "http",
  posture: "public",
  scopes: [],
  posturePresent: false,
});
let response = await synthetic.serve({
  method: "GET",
  path: "/synthetic",
  query: {},
  headers: {},
  body: Buffer.alloc(0),
  isBase64: false,
});
assert.equal(response.status, 500);
assert.equal(
  JSON.parse(Buffer.from(response.body).toString()).error.code,
  "app.internal",
);
synthetic._webSocketRoutes.push({
  routeKey: "synthetic",
  handler: ok,
  posturePresent: false,
  posture: null,
});
const wsOutput = await synthetic.serveWebSocket({
  requestContext: {
    routeKey: "synthetic",
    connectionId: "c1",
    requestId: "r1",
  },
});
assert.equal(wsOutput.statusCode, 500);
assert.equal(JSON.parse(wsOutput.body).error.code, "app.internal");

const openapiApp = new SecureApp();
openapiApp.get("/items/{id}", ok, Authenticated("items:read"));
const baseSpec = {
  title: "Secure",
  version: "1.0.0",
  routes: [
    {
      method: "GET",
      path: "/items/:id",
      operationId: "item",
      response: { description: "ok", fields: [] },
    },
  ],
  securitySchemes: { Bearer: { type: "http", scheme: "bearer" } },
  authSchemes: { authenticated: ["Bearer"], internalOnly: [] },
};
const document = openapiApp.generateOpenAPI(baseSpec);
assert.equal(document["x-apptheory-contract-mode"], "secure-v1");
assert.deepEqual(document.paths["/items/{id}"].get.security, [
  { Bearer: ["items:read"] },
]);
assert.throws(
  () => openapiApp.generateOpenAPI({ ...baseSpec, routes: [] }),
  /missing route/,
);
assert.throws(
  () =>
    openapiApp.generateOpenAPI({
      ...baseSpec,
      routes: [
        ...baseSpec.routes,
        {
          method: "GET",
          path: "/extra",
          operationId: "extra",
          response: {},
        },
      ],
    }),
  /extra route/,
);
assert.throws(
  () =>
    openapiApp.generateOpenAPI({
      ...baseSpec,
      authSchemes: { authenticated: [], internalOnly: [] },
    }),
  /binding is required/,
);
assert.throws(
  () =>
    openapiApp.generateOpenAPI({
      ...baseSpec,
      securitySchemes: { Bearer: { type: "http", number: 1 } },
    }),
  /numeric and undefined values are not allowed/,
);
const cycle = {};
cycle.self = cycle;
assert.throws(
  () =>
    openapiApp.generateOpenAPI({
      ...baseSpec,
      securitySchemes: { Bearer: cycle },
    }),
  /cyclic value is not allowed/,
);
assert.doesNotThrow(() =>
  openapiApp.generateOpenAPI({
    ...baseSpec,
    securitySchemes: {
      " Bearer ": { type: "http", scheme: "bearer" },
    },
  }),
);
assert.throws(
  () =>
    openapiApp.generateOpenAPI({
      ...baseSpec,
      securitySchemes: {
        Bearer: { type: "http", scheme: "bearer" },
        " Bearer ": { type: "http", scheme: "bearer" },
      },
    }),
  /duplicated/,
);

console.log("verify-secure-app: PASS");
