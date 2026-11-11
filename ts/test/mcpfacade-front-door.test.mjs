import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  createApp,
  registerMcpFacade,
  supportedEndpointTemplates,
} from "../dist/index.js";

// FRONTED origin posture (#1258): the runtime verifies the declared front-door
// header on every derived route, fails registration when the posture is declared
// without the verification, and refuses a direct-origin request.

const FRONT_DOOR_SECRET = "front-door-secret-0123456789-abcdefghi";
const RESOURCE_METADATA_URL =
  "https://front.example.com/.well-known/oauth-protected-resource/acme/mcp";

function baseConfig() {
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
      resourceMetadataURL: RESOURCE_METADATA_URL,
      validator: () => {},
    },
  };
}

function frontedConfig() {
  const config = baseConfig();
  config.originReachability = "fronted";
  config.frontDoorVerification = {
    headerName: "x-front-door",
    secretValue: FRONT_DOOR_SECRET,
  };
  return config;
}

async function serve(app, method, path, headers = {}) {
  return app.serve({
    method,
    path,
    query: {},
    headers,
    body: Buffer.alloc(0),
    isBase64: false,
  });
}

const FRONT_DOOR_HEADERS = {
  "x-front-door": [FRONT_DOOR_SECRET],
  authorization: ["Bearer admitted-token"],
};

test("front-door verification fails registration closed", () => {
  const cases = [
    {
      name: "fronted without verification",
      mutate: (config) => {
        config.originReachability = "fronted";
        config.frontDoorVerification = undefined;
      },
      error: /OriginReachability fronted requires FrontDoorVerification/,
    },
    {
      name: "verification without fronted",
      mutate: (config) => {
        config.frontDoorVerification = {
          headerName: "x-front-door",
          secretValue: FRONT_DOOR_SECRET,
        };
      },
      error: /FrontDoorVerification is only valid with OriginReachability fronted/,
    },
    {
      name: "verification with disabled",
      mutate: (config) => {
        config.originReachability = "disabled";
        config.frontDoorVerification = {
          headerName: "x-front-door",
          secretValue: FRONT_DOOR_SECRET,
        };
      },
      error: /FrontDoorVerification is only valid with OriginReachability fronted/,
    },
    {
      name: "unknown posture",
      mutate: (config) => {
        config.originReachability = "asserted";
      },
      error: /OriginReachability must be disabled, locked, or fronted/,
    },
    {
      name: "header name alphabet",
      mutate: (config) => {
        config.originReachability = "fronted";
        config.frontDoorVerification = {
          headerName: "x front door",
          secretValue: FRONT_DOOR_SECRET,
        };
      },
      error: /FrontDoorVerification header name must be 1 to 64 characters of \[A-Za-z0-9-\]/,
    },
    {
      name: "reserved header name",
      mutate: (config) => {
        config.originReachability = "fronted";
        config.frontDoorVerification = {
          headerName: "Authorization",
          secretValue: FRONT_DOOR_SECRET,
        };
      },
      error: /must be a request header the front door can set/,
    },
    {
      name: "platform header name",
      mutate: (config) => {
        config.originReachability = "fronted";
        config.frontDoorVerification = {
          headerName: "x-amzn-trace-id",
          secretValue: FRONT_DOOR_SECRET,
        };
      },
      error: /must be a request header the front door can set/,
    },
    {
      name: "secret alphabet",
      mutate: (config) => {
        config.originReachability = "fronted";
        config.frontDoorVerification = {
          headerName: "x-front-door",
          secretValue: "short",
        };
      },
      error: /FrontDoorVerification secret value must be 32 to 128 characters of \[A-Za-z0-9\._~-\]/,
    },
  ];
  for (const testCase of cases) {
    const config = baseConfig();
    testCase.mutate(config);
    assert.throws(
      () => registerMcpFacade(createApp({ tier: "p0" }), config),
      testCase.error,
      testCase.name,
    );
  }
});

test("disabled and locked stay registration-valid without a front-door declaration", () => {
  for (const posture of [undefined, "disabled", "locked"]) {
    const config = baseConfig();
    config.originReachability = posture;
    assert.doesNotThrow(() => registerMcpFacade(createApp({ tier: "p0" }), config));
  }
});

test("front-door verification refuses direct-origin requests across the inventory", async () => {
  const app = createApp({ tier: "p0" });
  const inventory = registerMcpFacade(app, frontedConfig());
  const route = inventory.routes[0];

  assert.equal((await serve(app, "POST", route.mcpPattern, FRONT_DOOR_HEADERS)).status, 204);
  for (const method of ["POST", "GET", "DELETE"]) {
    const denied = await serve(app, method, route.mcpPattern);
    assert.equal(denied.status, 403, `${method} ${route.mcpPattern} is refused without the header`);
    const body = JSON.parse(Buffer.from(denied.body).toString("utf8"));
    assert.equal(body.error.code, "app.forbidden");
  }

  assert.equal(
    (
      await serve(app, "POST", route.mcpPattern, {
        "x-front-door": ["b".repeat(FRONT_DOOR_SECRET.length)],
      })
    ).status,
    403,
    "a wrong header value is refused",
  );
  assert.equal(
    (
      await serve(app, "POST", route.mcpPattern, {
        "x-front-door": [FRONT_DOOR_SECRET.slice(0, -1)],
      })
    ).status,
    403,
    "a truncated header value is refused",
  );

  // OAuth facade documents are part of the same inventory.
  assert.equal((await serve(app, "GET", route.protectedResourcePattern)).status, 403);
  assert.equal((await serve(app, "GET", route.discoveryCanonicalPattern)).status, 403);
  assert.equal((await serve(app, "GET", route.discoverySuffixPattern)).status, 403);
  assert.equal(
    (await serve(app, "GET", route.protectedResourcePattern, FRONT_DOOR_HEADERS)).status,
    200,
  );
});

test("the front-door guard runs before the bearer guard", async () => {
  const config = frontedConfig();
  config.requireBearerToken = { resourceMetadataURL: RESOURCE_METADATA_URL };
  const app = createApp({ tier: "p0" });
  const inventory = registerMcpFacade(app, config);
  const route = inventory.routes[0];

  assert.equal(
    (await serve(app, "POST", route.mcpPattern)).status,
    403,
    "a direct-origin request is refused before credential work",
  );
  assert.equal(
    (await serve(app, "POST", route.mcpPattern, { "x-front-door": [FRONT_DOOR_SECRET] })).status,
    401,
    "a front-door request still faces the runtime-bearer challenge",
  );
});
