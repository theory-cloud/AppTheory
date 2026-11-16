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

// Parameter form: the value lives in a well-known, stage-qualified parameter,
// is read lazily in the request path, cached, and refreshed on a mismatch or
// after the TTL, so a rotation takes effect without a redeploy. An unreadable
// parameter fails closed.

const FRONT_DOOR_PARAMETER = "/theorycloud/apptheory/test/fronted/origin-token";

function stubReader(initial, error = undefined) {
  const state = { value: initial, error, calls: 0, params: [] };
  state.read = async (parameterName) => {
    state.calls += 1;
    state.params.push(parameterName);
    if (state.error) throw state.error;
    return state.value;
  };
  return state;
}

function parameterConfig(reader, overrides = {}) {
  const config = baseConfig();
  config.originReachability = "fronted";
  config.frontDoorVerification = {
    headerName: "x-front-door",
    secretParameterName: FRONT_DOOR_PARAMETER,
  };
  config.frontDoorSecretReader = reader.read;
  Object.assign(config, overrides);
  return config;
}

function frontDoorHeadersFor(secret) {
  return { "x-front-door": [secret], authorization: ["Bearer admitted-token"] };
}

test("parameter form fails registration closed", () => {
  const cases = [
    {
      name: "both secret forms",
      mutate: (config) => {
        config.frontDoorVerification.secretValue = FRONT_DOOR_SECRET;
      },
      error: /requires exactly one of secretValue and secretParameterName/,
    },
    {
      name: "neither secret form",
      mutate: (config) => {
        config.frontDoorVerification.secretParameterName = undefined;
      },
      error: /requires exactly one of secretValue and secretParameterName/,
    },
    {
      name: "name without a leading slash",
      mutate: (config) => {
        config.frontDoorVerification.secretParameterName = "theorycloud/apptheory/fronted";
      },
      error: /secretParameterName must be a fully qualified SSM parameter name/,
    },
    {
      name: "name with a colon",
      mutate: (config) => {
        config.frontDoorVerification.secretParameterName = "/theorycloud/apptheory:fronted";
      },
      error: /secretParameterName must be a fully qualified SSM parameter name/,
    },
    {
      name: "reserved aws hierarchy",
      mutate: (config) => {
        config.frontDoorVerification.secretParameterName = "/aws/apptheory/fronted";
      },
      error: /must not use the reserved aws or ssm hierarchy/,
    },
    {
      name: "too many levels",
      mutate: (config) => {
        config.frontDoorVerification.secretParameterName = `/${Array.from({ length: 16 }, (_, i) => `l${i}`).join("/")}`;
      },
      error: /must have between one and fifteen hierarchy levels/,
    },
    {
      name: "ttl above the bound",
      mutate: (config) => {
        config.frontDoorSecretTTLSeconds = 3601;
      },
      error: /frontDoorSecretTTLSeconds must be greater than zero and at most 3600/,
    },
    {
      name: "ttl not positive",
      mutate: (config) => {
        config.frontDoorSecretTTLSeconds = 0;
      },
      error: /frontDoorSecretTTLSeconds must be greater than zero and at most 3600/,
    },
  ];
  for (const testCase of cases) {
    const reader = stubReader(FRONT_DOOR_SECRET);
    const config = parameterConfig(reader);
    testCase.mutate(config);
    assert.throws(
      () => registerMcpFacade(createApp({ tier: "p0" }), config),
      testCase.error,
      testCase.name,
    );
    assert.equal(reader.calls, 0, `${testCase.name}: registration never reads the parameter`);
  }
});

test("parameter form reads lazily and refuses a direct-origin request", async () => {
  const reader = stubReader(FRONT_DOOR_SECRET);
  const app = createApp({ tier: "p0" });
  const inventory = registerMcpFacade(app, parameterConfig(reader));
  const route = inventory.routes[0];
  assert.equal(reader.calls, 0, "registration performs no read");

  assert.equal(
    (await serve(app, "POST", route.mcpPattern, frontDoorHeadersFor(FRONT_DOOR_SECRET))).status,
    204,
  );
  assert.equal(reader.calls, 1);
  assert.deepEqual(reader.params, [FRONT_DOOR_PARAMETER]);

  assert.equal((await serve(app, "POST", route.mcpPattern)).status, 403);
  assert.equal(
    (
      await serve(app, "POST", route.mcpPattern, {
        "x-front-door": ["b".repeat(FRONT_DOOR_SECRET.length)],
      })
    ).status,
    403,
  );
  assert.equal((await serve(app, "GET", route.protectedResourcePattern)).status, 403);
});

test("parameter form fails closed when the parameter is unreadable", async () => {
  const cases = [
    { name: "read error", value: "", error: new Error("AccessDeniedException") },
    { name: "empty value", value: "" },
    { name: "value outside the alphabet", value: "contains a space and is long enough" },
    { name: "value too short", value: "short" },
  ];
  for (const testCase of cases) {
    const reader = stubReader(testCase.value, testCase.error);
    const app = createApp({ tier: "p0" });
    const inventory = registerMcpFacade(app, parameterConfig(reader));
    const route = inventory.routes[0];
    assert.equal(
      (await serve(app, "POST", route.mcpPattern, frontDoorHeadersFor(FRONT_DOOR_SECRET))).status,
      403,
      testCase.name,
    );
    assert.equal((await serve(app, "GET", route.protectedResourcePattern)).status, 403);
  }
});

test("parameter form refreshes on a mismatch, bounded by the refresh floor", async () => {
  const reader = stubReader(FRONT_DOOR_SECRET);
  const app = createApp({ tier: "p0" });
  const inventory = registerMcpFacade(
    app,
    parameterConfig(reader, { frontDoorSecretTTLSeconds: 3600 }),
  );
  const route = inventory.routes[0];
  const rotated = "rotated-front-door-secret-0123456789-abcdef";

  assert.equal(
    (await serve(app, "POST", route.mcpPattern, frontDoorHeadersFor(FRONT_DOOR_SECRET))).status,
    204,
  );
  assert.equal(reader.calls, 1);

  await new Promise((resolve) => setTimeout(resolve, 1100));
  reader.value = rotated;
  assert.equal(
    (await serve(app, "POST", route.mcpPattern, frontDoorHeadersFor(rotated))).status,
    204,
    "the first request after the floor carrying the rotated value is admitted",
  );
  assert.equal(reader.calls, 2, "a mismatch forces exactly one refresh");

  assert.equal(
    (
      await serve(app, "POST", route.mcpPattern, {
        "x-front-door": ["c".repeat(rotated.length)],
      })
    ).status,
    403,
  );
  assert.equal(reader.calls, 2, "the refresh floor bounds forced reads");
  assert.equal(
    (await serve(app, "POST", route.mcpPattern, frontDoorHeadersFor(rotated))).status,
    204,
  );
});

test("parameter form refreshes after the TTL without a mismatching request", async () => {
  const reader = stubReader(FRONT_DOOR_SECRET);
  const app = createApp({ tier: "p0" });
  const inventory = registerMcpFacade(
    app,
    parameterConfig(reader, { frontDoorSecretTTLSeconds: 0.05 }),
  );
  const route = inventory.routes[0];
  const rotated = "rotated-front-door-secret-0123456789-abcdef";

  assert.equal(
    (await serve(app, "POST", route.mcpPattern, frontDoorHeadersFor(FRONT_DOOR_SECRET))).status,
    204,
  );
  reader.value = rotated;
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(
    (await serve(app, "POST", route.mcpPattern, frontDoorHeadersFor(rotated))).status,
    204,
  );
  assert.equal(reader.calls, 2, "the TTL re-reads the parameter");
  assert.equal(
    (await serve(app, "POST", route.mcpPattern, frontDoorHeadersFor(FRONT_DOOR_SECRET))).status,
    403,
    "the rotated-out value is no longer accepted",
  );
});

test("parameter form coalesces concurrent reads onto one call", async () => {
  let resolveRead;
  const state = { calls: 0 };
  const read = (parameterName) => {
    state.calls += 1;
    assert.equal(parameterName, FRONT_DOOR_PARAMETER);
    return new Promise((resolve) => {
      resolveRead = resolve;
    });
  };
  const config = parameterConfig({ read });
  const app = createApp({ tier: "p0" });
  const inventory = registerMcpFacade(app, config);
  const route = inventory.routes[0];

  const first = serve(app, "POST", route.mcpPattern, frontDoorHeadersFor(FRONT_DOOR_SECRET));
  const second = serve(app, "POST", route.mcpPattern, frontDoorHeadersFor(FRONT_DOOR_SECRET));
  await new Promise((resolve) => setTimeout(resolve, 10));
  resolveRead(FRONT_DOOR_SECRET);
  assert.equal((await first).status, 204);
  assert.equal((await second).status, 204);
  assert.equal(state.calls, 1, "concurrent requests share one in-flight read");
});
