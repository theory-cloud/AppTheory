import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import {
  SecureApp,
  createApp,
  newMemoryBearerTokenValidator,
  registerMcpFacade,
  registerMcpFacadeSecure,
  supportedEndpointTemplates,
} from "../dist/index.js";

const FIXTURE = JSON.parse(
  readFileSync(
    new URL(
      "../../contract-tests/fixtures/routing/mcp-auth-facade/facade-middleware-order.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const CASE_COUNT = 16;

function response(status, body = "") {
  return {
    status,
    headers: {},
    cookies: [],
    body: Buffer.from(body),
    isBase64: false,
  };
}

function request(method, path, headers = {}) {
  return {
    method,
    path,
    headers,
    query: {},
    body: Buffer.alloc(0),
    isBase64: false,
  };
}

function firstHeader(headers, name) {
  const key = name.toLowerCase();
  for (const [rawKey, values] of Object.entries(headers ?? {})) {
    if (rawKey.toLowerCase() === key) return values[0];
  }
  return undefined;
}

function routePath() {
  const endpoint = supportedEndpointTemplates().find(
    (candidate) => candidate.kind === "namespace",
  );
  assert.ok(endpoint);
  return `/acme/mcp`;
}

function headerValues(mount, credential) {
  if (credential === "missing") return {};
  const token =
    credential === "invalid" ? mount.invalid_token : mount.valid_token;
  return { authorization: [`Bearer ${token}`] };
}

function middlewareFor(name, recorder) {
  if (name === "short_circuit_cache") {
    return async (_ctx, _next) => {
      recorder.middlewareInvocations += 1;
      recorder.cacheLookups += 1;
      recorder.order.push("middleware");
      return response(200, "cached-protected");
    };
  }
  if (name === "pass_through_writer") {
    return async (ctx, next) => {
      recorder.middlewareInvocations += 1;
      recorder.middlewareWrites += 1;
      recorder.order.push("middleware");
      return next(ctx);
    };
  }
  throw new Error(`unknown middleware_order middleware ${name}`);
}

function policyFor(name, recorder) {
  if (name === "allow") {
    return async () => {
      recorder.policyInvocations += 1;
      recorder.order.push("policy");
      return null;
    };
  }
  if (name === "deny") {
    return async () => {
      recorder.policyInvocations += 1;
      recorder.order.push("policy");
      return { code: "app.rate_limited", message: "rate limited" };
    };
  }
  return undefined;
}

function baseConfig(mount, recorder) {
  const claimsValidator = newMemoryBearerTokenValidator([
    {
      token: mount.valid_token,
      subject: mount.subject,
      audience: mount.audience,
      scopes: mount.scopes.namespace,
    },
  ]);
  return {
    issuerURL: mount.issuer_url,
    jwksURI: mount.jwks_uri,
    urlMode: "public_base_url",
    publicBaseURL: mount.public_base_url,
    scopes: mount.scopes,
    mcpHandler: () => {
      recorder.handlerInvocations += 1;
      recorder.order.push("handler");
      return response(204);
    },
    transportPosture: "runtime-bearer",
    requireBearerToken: {
      resourceMetadataURL: mount.resource_metadata_url,
      claimsValidator: async (ctx, token) => {
        recorder.order.push("bearer");
        return claimsValidator(ctx, token);
      },
    },
  };
}

test("runtime-bearer guard executes before application middleware", async () => {
  const cases = FIXTURE.cases.filter(
    (candidate) => candidate.group === "middleware_order",
  );
  assert.equal(cases.length, CASE_COUNT);
  assert.equal(FIXTURE.mount.valid_token, "valid-token");

  const path = routePath();
  for (const testCase of cases) {
    for (const method of testCase.methods) {
      await test(`${testCase.id} ${method}`, async () => {
        const recorder = {
          order: [],
          middlewareInvocations: 0,
          cacheLookups: 0,
          middlewareWrites: 0,
          handlerInvocations: 0,
          policyInvocations: 0,
        };
        const config = baseConfig(FIXTURE.mount, recorder);
        const middleware = middlewareFor(testCase.middleware, recorder);
        let surface;
        if (testCase.surface === "plain") {
          surface = createApp({ tier: testCase.tier });
          surface.use(middleware);
          registerMcpFacade(surface, config);
        } else if (testCase.surface === "secure") {
          surface = new SecureApp({
            tier: testCase.tier,
            policyHook: policyFor(testCase.policy, recorder),
          });
          surface.use(middleware);
          registerMcpFacadeSecure(surface, config);
        } else {
          throw new Error(`unknown middleware_order surface ${testCase.surface}`);
        }

        const actual = await surface.serve(
          request(
            method,
            path,
            headerValues(FIXTURE.mount, testCase.credential),
          ),
        );

        assert.equal(actual.status, testCase.expect.status);
        if (testCase.expect.www_authenticate !== undefined) {
          assert.equal(
            firstHeader(actual.headers, "www-authenticate"),
            testCase.expect.www_authenticate,
          );
        }
        assert.deepEqual(recorder.order, testCase.expect.order);
        assert.equal(
          recorder.middlewareInvocations,
          testCase.expect.middleware_invocations,
        );
        assert.equal(recorder.cacheLookups, testCase.expect.cache_lookups);
        assert.equal(
          recorder.middlewareWrites,
          testCase.expect.middleware_writes,
        );
        assert.equal(
          recorder.handlerInvocations,
          testCase.expect.handler_invocations,
        );
        assert.equal(
          recorder.policyInvocations,
          testCase.expect.policy_hook_invocations,
        );
        if (testCase.expect.body !== undefined) {
          assert.equal(
            Buffer.from(actual.body).toString("utf8"),
            testCase.expect.body,
          );
        }
      });
    }
  }
});
