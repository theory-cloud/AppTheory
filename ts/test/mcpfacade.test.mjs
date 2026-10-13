import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  assertBearerTokenReachesTransportHandler,
  assertCredentialFreeTransportDenied,
  assertInsufficientScopeTransportDenied,
  countingTransportHandler,
  createApp,
  newMemoryBearerTokenValidator,
  registerMcpFacade,
} from "../dist/index.js";

const RESOURCE_METADATA_URL =
  "https://mcp.example.com/.well-known/oauth-protected-resource/acme/mcp";

function probeRequest(path) {
  return {
    method: "POST",
    path,
    headers: {},
    query: {},
    body: Buffer.alloc(0),
    isBase64: false,
  };
}

function bearerOptions() {
  return {
    resourceMetadataURL: RESOURCE_METADATA_URL,
    claimsValidator: newMemoryBearerTokenValidator([
      {
        token: "valid-token",
        subject: "acme",
        audience: "https://mcp.example.com",
      },
    ]),
  };
}

test("runtime-bearer scope failure returns the route-derived 403 challenge without invoking the handler", async () => {
  const ROUTE_SCOPES = ["mcp:read", "mcp:write"];

  const app = createApp();
  const handler = countingTransportHandler();
  registerMcpFacade(app, {
    mcpPaths: ["/acme/mcp"],
    mcpHandler: handler.handler,
    transportPosture: "runtime-bearer",
    requireBearerToken: {
      resourceMetadataURL: RESOURCE_METADATA_URL,
      requiredScopes: ROUTE_SCOPES,
      claimsValidator: newMemoryBearerTokenValidator(
        [
          {
            token: "scope-token",
            subject: "acme",
            audience: "https://mcp.example.com",
            scopes: ["mcp:read"],
          },
        ],
        {
          requiredAudience: "https://mcp.example.com",
          requiredScopes: ROUTE_SCOPES,
        },
      ),
    },
  });

  await assertCredentialFreeTransportDenied(
    app,
    "POST",
    "/acme/mcp",
    RESOURCE_METADATA_URL,
    handler,
  );
  await assertInsufficientScopeTransportDenied(
    app,
    "POST",
    "/acme/mcp",
    "scope-token",
    RESOURCE_METADATA_URL,
    ROUTE_SCOPES,
    handler,
  );
  assert.equal(handler.invocations(), 0);

  const allowed = createApp();
  const allowedHandler = countingTransportHandler();
  registerMcpFacade(allowed, {
    mcpPaths: ["/acme/mcp"],
    mcpHandler: allowedHandler.handler,
    transportPosture: "runtime-bearer",
    requireBearerToken: {
      resourceMetadataURL: RESOURCE_METADATA_URL,
      requiredScopes: ["mcp:read"],
      claimsValidator: newMemoryBearerTokenValidator(
        [
          {
            token: "scope-token",
            subject: "acme",
            audience: "https://mcp.example.com",
            scopes: ["mcp:read"],
          },
        ],
        {
          requiredAudience: "https://mcp.example.com",
          requiredScopes: ["mcp:read"],
        },
      ),
    },
  });

  await assertBearerTokenReachesTransportHandler(
    allowed,
    "POST",
    "/acme/mcp",
    "scope-token",
    allowedHandler,
  );
  assert.equal(allowedHandler.invocations(), 1);
});

test("runtime-bearer posture denies credential-free transport and admits a valid token", async () => {
  const app = createApp();
  const handler = countingTransportHandler();
  const registration = registerMcpFacade(app, {
    mcpPaths: ["/acme/mcp"],
    mcpHandler: handler.handler,
    transportPosture: "runtime-bearer",
    requireBearerToken: bearerOptions(),
  });

  assert.equal(registration.transportPosture, "runtime-bearer");
  assert.deepEqual(registration.transportPaths, ["/acme/mcp"]);

  await assertCredentialFreeTransportDenied(
    app,
    "POST",
    "/acme/mcp",
    RESOURCE_METADATA_URL,
    handler,
  );
  assert.equal(handler.invocations(), 0);

  await assertBearerTokenReachesTransportHandler(
    app,
    "POST",
    "/acme/mcp",
    "valid-token",
    handler,
  );
  assert.equal(handler.invocations(), 1);
});

test("default posture is iam and registers the transport handler", () => {
  const app = createApp();
  const handler = countingTransportHandler();
  const registration = registerMcpFacade(app, {
    mcpPaths: ["/acme/mcp"],
    mcpHandler: handler.handler,
  });
  assert.equal(registration.transportPosture, "iam");
});

test("registration fails closed before any route is added", async () => {
  const cases = [
    {
      name: "runtime-bearer without a bearer assertion",
      options: { transportPosture: "runtime-bearer" },
      error: /transportPosture runtime-bearer requires requireBearerToken/,
    },
    {
      name: "iam with a bearer assertion",
      options: {
        transportPosture: "iam",
        requireBearerToken: { validator: () => {} },
      },
      error: /requireBearerToken is only valid with transportPosture runtime-bearer/,
    },
    {
      name: "jwt with a bearer assertion",
      options: {
        transportPosture: "jwt",
        requireBearerToken: { validator: () => {} },
      },
      error: /requireBearerToken is only valid with transportPosture runtime-bearer/,
    },
    {
      name: "none-public with a bearer assertion",
      options: {
        transportPosture: "none-public",
        requireBearerToken: { validator: () => {} },
      },
      error: /transportPosture none-public cannot be combined with requireBearerToken/,
    },
    {
      name: "unknown posture",
      options: { transportPosture: "unauthenticated" },
      error: /transportPosture must be one of iam, jwt, runtime-bearer, none-public/,
    },
  ];

  for (const testCase of cases) {
    const app = createApp();
    const handler = countingTransportHandler();
    assert.throws(
      () =>
        registerMcpFacade(app, {
          mcpPaths: ["/acme/mcp"],
          mcpHandler: handler.handler,
          ...testCase.options,
        }),
      testCase.error,
      testCase.name,
    );

    const probe = await app.serve(probeRequest("/acme/mcp"));
    assert.equal(probe.status, 404, testCase.name);
    assert.equal(handler.invocations(), 0, testCase.name);
  }
});

test("mcpPaths are validated before any route is added", () => {
  const app = createApp();
  const handler = countingTransportHandler();
  for (const mcpPaths of [[], [""], ["relative/mcp"], [42]]) {
    assert.throws(
      () =>
        registerMcpFacade(app, {
          mcpPaths,
          mcpHandler: handler.handler,
          transportPosture: "none-public",
        }),
      /AppTheoryMcpFacade:/,
    );
  }
  assert.equal(handler.invocations(), 0);
});
