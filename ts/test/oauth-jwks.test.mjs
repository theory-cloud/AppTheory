import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  createHmac,
  generateKeyPairSync,
  sign as signBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ERR_BEARER_TOKEN_EXPIRED,
  ERR_BEARER_TOKEN_INVALID_AUDIENCE,
  ERR_INVALID_BEARER_TOKEN,
  OAuthBearerError,
  assertBearerTokenReachesTransportHandler,
  bootstrapOidcDiscovery,
  canonicalResourceURL,
  countingTransportHandler,
  createApp,
  newJwksValidator,
  protectedResourceWWWAuthenticate,
  registerMcpFacade,
  resourceIndicatorMatches,
  resourceMetadataURLFromMcpEndpoint,
} from "../dist/index.js";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "contract-tests",
  "fixtures",
  "routing",
  "mcp-auth-facade",
);

const AUDIENCE = "https://mcp.example.com/acme/mcp";
const RESOURCE_METADATA_URL =
  "https://mcp.example.com/.well-known/oauth-protected-resource/acme/mcp";
const BASE_MS = Date.UTC(2026, 0, 1);
const JWKS_PATH = "/.well-known/jwks.json";
const DISCOVERY_PATH = "/.well-known/openid-configuration";

const ERROR_CODE_BY_REASON = {
  algorithm_not_allowed: ERR_INVALID_BEARER_TOKEN,
  audience_mismatch: ERR_BEARER_TOKEN_INVALID_AUDIENCE,
  expired: ERR_BEARER_TOKEN_EXPIRED,
  issuer_mismatch: ERR_INVALID_BEARER_TOKEN,
  unknown_kid: ERR_INVALID_BEARER_TOKEN,
};

const HASH_BY_ALGORITHM = {
  ES256: "sha256",
  ES384: "sha384",
  ES512: "sha512",
  HS256: "sha256",
  HS384: "sha384",
  HS512: "sha512",
  RS256: "RSA-SHA256",
  RS512: "RSA-SHA512",
};

const CURVE_BY_ALGORITHM = { ES256: "P-256", ES384: "P-384", ES512: "P-521" };

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

function rsaKey(kid) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" },
    hmacSecret: publicKey.export({ type: "spki", format: "pem" }),
  };
}

const KEY_A = rsaKey("kid-a");
const KEY_B = rsaKey("kid-b");

const ecKeys = new Map();

function ecKey(curve) {
  if (!ecKeys.has(curve)) {
    ecKeys.set(curve, generateKeyPairSync("ec", { namedCurve: curve }));
  }
  return ecKeys.get(curve);
}

function jwkWithKid(material, kid) {
  return { ...material.jwk, kid };
}

function encodeJSON(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signToken({ header, payload, material }) {
  const algorithm = header.alg;
  const encodedHeader = encodeJSON(header);
  const encodedPayload = encodeJSON(payload);
  const signingInput = Buffer.from(
    `${encodedHeader}.${encodedPayload}`,
    "utf8",
  );
  let signature;
  if (algorithm === "none") {
    signature = Buffer.alloc(0);
  } else if (algorithm.startsWith("HS")) {
    signature = createHmac(HASH_BY_ALGORITHM[algorithm], material.hmacSecret)
      .update(signingInput)
      .digest();
  } else if (algorithm.startsWith("RS")) {
    signature = signBytes(
      HASH_BY_ALGORITHM[algorithm],
      signingInput,
      material.privateKey,
    );
  } else if (algorithm.startsWith("ES")) {
    signature = signBytes(
      HASH_BY_ALGORITHM[algorithm],
      signingInput,
      ecKey(CURVE_BY_ALGORITHM[algorithm]).privateKey,
    );
  } else {
    throw new Error(`unsupported test algorithm ${algorithm}`);
  }
  return `${encodedHeader}.${encodedPayload}.${signature.toString("base64url")}`;
}

function rs256Token(env, material, overrides = {}) {
  return signToken({
    header: { alg: "RS256", kid: material.kid, typ: "JWT" },
    payload: claims(env, overrides),
    material,
  });
}

function claims(env, overrides = {}) {
  const nowSeconds = Math.floor(env.clock.t / 1000);
  return {
    iss: env.issuer,
    aud: AUDIENCE,
    sub: "acme",
    scope: "mcp:read",
    iat: nowSeconds,
    exp: nowSeconds + 300,
    ...overrides,
  };
}

function routeContext(pathname) {
  const values = new Map();
  return {
    request: { headers: {}, path: pathname },
    set: (key, value) => values.set(key, value),
    get: (key) => values.get(key),
  };
}

function validatorOptions(env, extra = {}) {
  return {
    issuer: env.issuer,
    jwksUri: env.jwksUri,
    fetchImpl: env.fetchImpl,
    now: env.now,
    requiredAudience: (ctx) =>
      ctx.request.path === "/acme/mcp" ? AUDIENCE : "https://unmatched.example.com/acme/mcp",
    requiredScopes: (ctx) => (ctx.request.path === "/acme/mcp" ? ["mcp:read"] : []),
    ...extra,
  };
}

function respond(response, status, body, headers) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...(headers ?? {}),
  });
  response.end(payload);
}

/**
 * Starts a loopback HTTP server and the HTTPS-bound fetch bridge the validator
 * requires: the validator only ever sees `https://127.0.0.1:<port>` URLs, and
 * the bridge downgrades exactly that loopback origin to the local server, so no
 * request leaves the machine. Every fetch is counted.
 */
async function startEnv(documents = {}) {
  const clock = { t: BASE_MS };
  const state = { fetches: 0, urls: [] };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const origin = `https://127.0.0.1:${server.address().port}`;
    const factory =
      url.pathname === JWKS_PATH
        ? documents.jwks
        : url.pathname === DISCOVERY_PATH
          ? documents.discovery
          : undefined;
    if (!factory) {
      respond(response, 404, { error: "not_found" });
      return;
    }
    const result = factory(origin);
    respond(response, result.status ?? 200, result.body ?? {}, result.headers);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${server.address().port}`;
  return {
    origin,
    issuer: origin,
    jwksUri: `${origin}${JWKS_PATH}`,
    discoveryUrl: `${origin}${DISCOVERY_PATH}`,
    clock,
    state,
    now: () => new Date(clock.t),
    fetchImpl: async (input, init) => {
      state.fetches += 1;
      const requested = String(input);
      state.urls.push(requested);
      const bridged = new URL(requested);
      assert.equal(
        bridged.protocol,
        "https:",
        `requested a non-https document URL: ${requested}`,
      );
      bridged.protocol = "http:";
      return await fetch(bridged, init);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withEnv(documents, body) {
  const env = await startEnv(documents);
  try {
    return await body(env);
  } finally {
    await env.close();
  }
}

async function assertRejectedWithReason(validate, token, reason, label) {
  const expectedCode = ERROR_CODE_BY_REASON[reason];
  assert.ok(
    expectedCode,
    `${label}: no OAuthBearerError code is mapped for fixture reason ${reason}`,
  );
  await assert.rejects(
    async () => await validate(routeContext("/acme/mcp"), token),
    (error) => {
      assert.ok(
        error instanceof OAuthBearerError,
        `${label}: want OAuthBearerError, got ${error}`,
      );
      assert.equal(error.oauthCode, expectedCode, `${label}: oauthCode`);
      assert.match(
        error.message,
        new RegExp(reason, "u"),
        `${label}: message must name ${reason}`,
      );
      return true;
    },
    label,
  );
}

const JWKS_CASE_EXECUTORS = {
  "alg-none-rejected": async (row) => {
    await withEnv({ jwks: () => ({ body: { keys: [KEY_A.jwk] } }) }, async (env) => {
      const validate = await newJwksValidator(validatorOptions(env));
      const token = signToken({
        header: { alg: "none", kid: KEY_A.kid, typ: "JWT" },
        payload: claims(env),
        material: KEY_A,
      });
      await assertRejectedWithReason(validate, token, row.reason, row.name);
      assert.equal(
        env.state.fetches,
        0,
        `${row.name}: a rejected algorithm must not trigger a key fetch`,
      );
    });
  },

  "hs256-rejected": async (row) => {
    await withEnv({ jwks: () => ({ body: { keys: [KEY_A.jwk] } }) }, async (env) => {
      const validate = await newJwksValidator(validatorOptions(env));
      const token = signToken({
        header: { alg: "HS256", kid: KEY_A.kid, typ: "JWT" },
        payload: claims(env),
        material: KEY_A,
      });
      await assertRejectedWithReason(validate, token, row.reason, row.name);
      assert.equal(
        env.state.fetches,
        0,
        `${row.name}: a rejected algorithm must not trigger a key fetch`,
      );
    });
  },

  "unknown-kid-triggers-one-refresh": async (row) => {
    let served = 0;
    const jwks = () => {
      served += 1;
      return {
        body: { keys: served === 1 ? [KEY_A.jwk] : [KEY_A.jwk, KEY_B.jwk] },
      };
    };
    await withEnv({ jwks }, async (env) => {
      const validate = await newJwksValidator(validatorOptions(env));
      const result = await validate(
        routeContext("/acme/mcp"),
        rs256Token(env, KEY_B),
      );
      assert.equal(result.subject, "acme", `${row.name}: subject`);
      assert.equal(result.audience, AUDIENCE, `${row.name}: audience`);
      assert.deepEqual(result.scopes, ["mcp:read"], `${row.name}: scopes`);
      assert.equal(
        env.state.fetches,
        row.jwks_fetches,
        `${row.name}: jwks fetches`,
      );
    });
  },

  "unknown-kid-refresh-is-bounded": async (row) => {
    await withEnv({ jwks: () => ({ body: { keys: [KEY_A.jwk] } }) }, async (env) => {
      const validate = await newJwksValidator(validatorOptions(env));
      // The fixture's bound is per kid: the second token carries the same
      // still-unknown kid inside the refresh cooldown.
      const header = { alg: "RS256", kid: "kid-unknown-1", typ: "JWT" };
      const firstUnknown = signToken({
        header,
        payload: claims(env),
        material: KEY_B,
      });
      const secondUnknown = signToken({
        header,
        payload: claims(env, { iat: Math.floor(env.clock.t / 1000) + 1 }),
        material: KEY_B,
      });
      await assertRejectedWithReason(validate, firstUnknown, "unknown_kid", row.name);
      await assertRejectedWithReason(validate, secondUnknown, "unknown_kid", row.name);
      assert.equal(
        env.state.fetches,
        row.jwks_fetches,
        `${row.name}: jwks fetches`,
      );
    });
  },

  "expired-key-refresh": async (row) => {
    let served = 0;
    const jwks = () => {
      served += 1;
      return {
        body: {
          keys: [
            served === 1 ? KEY_A.jwk : jwkWithKid(KEY_B, KEY_A.kid),
          ],
        },
      };
    };
    await withEnv({ jwks }, async (env) => {
      const validate = await newJwksValidator(
        validatorOptions(env, { cacheTtlSeconds: 30, refreshCooldownSeconds: 1 }),
      );
      // Warm the cache with the pre-rotation key, then let that entry expire.
      const warm = await validate(routeContext("/acme/mcp"), rs256Token(env, KEY_A));
      assert.equal(warm.subject, "acme", `${row.name}: warm-up`);
      assert.equal(env.state.fetches, 1, `${row.name}: warm-up fetches`);

      env.clock.t += 31_000;
      const rotated = signToken({
        header: { alg: "RS256", kid: KEY_A.kid, typ: "JWT" },
        payload: claims(env),
        material: KEY_B,
      });
      const result = await validate(routeContext("/acme/mcp"), rotated);
      assert.equal(result.subject, "acme", `${row.name}: subject`);
      assert.equal(
        env.state.fetches,
        row.jwks_fetches,
        `${row.name}: jwks fetches`,
      );
    });
  },

  "issuer-mismatch-rejected": async (row) => {
    await withEnv({ jwks: () => ({ body: { keys: [KEY_A.jwk] } }) }, async (env) => {
      const validate = await newJwksValidator(validatorOptions(env));
      const token = rs256Token(env, KEY_A, { iss: "https://other.example.com" });
      await assertRejectedWithReason(validate, token, row.reason, row.name);
      assert.equal(
        env.state.fetches,
        0,
        `${row.name}: the issuer is checked before the key lookup`,
      );
    });
  },

  "audience-mismatch-rejected": async (row) => {
    await withEnv({ jwks: () => ({ body: { keys: [KEY_A.jwk] } }) }, async (env) => {
      const validate = await newJwksValidator(validatorOptions(env));
      const token = rs256Token(env, KEY_A, {
        aud: "https://other.example.com/acme/mcp",
      });
      await assertRejectedWithReason(validate, token, row.reason, row.name);
      assert.equal(env.state.fetches, 1, `${row.name}: jwks fetches`);
    });
  },

  "expired-token-rejected": async (row) => {
    await withEnv({ jwks: () => ({ body: { keys: [KEY_A.jwk] } }) }, async (env) => {
      const validate = await newJwksValidator(validatorOptions(env));
      const token = rs256Token(env, KEY_A, {
        exp: Math.floor(env.clock.t / 1000) - 60,
      });
      await assertRejectedWithReason(validate, token, row.reason, row.name);
      assert.equal(env.state.fetches, 1, `${row.name}: jwks fetches`);
    });
  },
};

const DISCOVERY_CASE_EXECUTORS = {
  "same-origin-https-accepted": async (row) => {
    const documents = {
      jwks: () => ({ body: { keys: [KEY_A.jwk] } }),
      discovery: (origin) => ({
        body: { issuer: origin, jwks_uri: `${origin}${JWKS_PATH}` },
      }),
    };
    await withEnv(documents, async (env) => {
      const jwksUri = await bootstrapOidcDiscovery(
        env.discoveryUrl,
        env.issuer,
        env.fetchImpl,
      );
      assert.equal(jwksUri, env.jwksUri, `${row.name}: bootstrapped jwks_uri`);

      const validate = await newJwksValidator({
        issuer: env.issuer,
        discoveryUrl: env.discoveryUrl,
        fetchImpl: env.fetchImpl,
        now: env.now,
        requiredAudience: AUDIENCE,
        requiredScopes: ["mcp:read"],
      });
      const result = await validate(
        routeContext("/acme/mcp"),
        rs256Token(env, KEY_A),
      );
      assert.equal(result.subject, "acme", `${row.name}: bootstrapped validator`);
      assert.deepEqual(
        env.state.urls,
        [env.discoveryUrl, env.discoveryUrl, env.jwksUri],
        `${row.name}: discovery then jwks, https only`,
      );
    });
  },

  "issuer-mismatch-rejected": async (row) => {
    const documents = {
      discovery: (origin) => ({
        body: { issuer: `${origin}/other`, jwks_uri: `${origin}${JWKS_PATH}` },
      }),
    };
    await withEnv(documents, async (env) => {
      await assert.rejects(
        async () =>
          await bootstrapOidcDiscovery(env.discoveryUrl, env.issuer, env.fetchImpl),
        new RegExp(row.reason, "u"),
        row.name,
      );
      assert.equal(env.state.fetches, 1, `${row.name}: discovery fetches`);
    });
  },

  "non-https-rejected": async (row) => {
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      throw new Error("the non-https discovery url must never be fetched");
    };
    await assert.rejects(
      async () =>
        await bootstrapOidcDiscovery(
          "http://127.0.0.1:9/.well-known/openid-configuration",
          "https://issuer.example.com",
          fetchImpl,
        ),
      new RegExp(row.reason, "u"),
      row.name,
    );
    assert.equal(fetches, 0, `${row.name}: fetches`);
  },

  "cross-origin-redirect-rejected": async (row) => {
    const documents = {
      discovery: () => ({
        status: 302,
        headers: { location: "https://evil.example.com/.well-known/openid-configuration" },
        body: {},
      }),
    };
    await withEnv(documents, async (env) => {
      await assert.rejects(
        async () =>
          await bootstrapOidcDiscovery(env.discoveryUrl, env.issuer, env.fetchImpl),
        new RegExp(row.reason, "u"),
        row.name,
      );
      assert.equal(env.state.fetches, 1, `${row.name}: discovery fetches`);
    });
  },

  "missing-jwks-uri-rejected": async (row) => {
    const documents = { discovery: (origin) => ({ body: { issuer: origin } }) };
    await withEnv(documents, async (env) => {
      await assert.rejects(
        async () =>
          await bootstrapOidcDiscovery(env.discoveryUrl, env.issuer, env.fetchImpl),
        new RegExp(row.reason, "u"),
        row.name,
      );
      assert.equal(env.state.fetches, 1, `${row.name}: discovery fetches`);
    });
  },
};

test("jwks-validator.v1 pins the RS256 allow-list and refuses every rejected algorithm", async () => {
  const fixture = loadFixture("jwks-validator.v1.json");
  assert.deepEqual(fixture.algorithm.allowed, ["RS256"]);
  assert.equal(fixture.defaults.max_refresh_per_kid, 1);

  await withEnv({ jwks: () => ({ body: { keys: [KEY_A.jwk] } }) }, async (env) => {
    const validate = await newJwksValidator(validatorOptions(env));
    for (const algorithm of fixture.algorithm.allowed) {
      const result = await validate(
        routeContext("/acme/mcp"),
        signToken({
          header: { alg: algorithm, kid: KEY_A.kid, typ: "JWT" },
          payload: claims(env),
          material: KEY_A,
        }),
      );
      assert.equal(result.subject, "acme", `allowed algorithm ${algorithm}`);
    }
    const fetchesAfterAllowed = env.state.fetches;
    assert.equal(
      fetchesAfterAllowed,
      1,
      "resolving the pinned RS256 key fetches the key set once",
    );
    for (const algorithm of fixture.algorithm.rejected) {
      assert.ok(
        !fixture.algorithm.allowed.includes(algorithm),
        `${algorithm} must not also be allowed`,
      );
      const token = signToken({
        header: { alg: algorithm, kid: KEY_A.kid, typ: "JWT" },
        payload: claims(env),
        material: KEY_A,
      });
      await assertRejectedWithReason(
        validate,
        token,
        "algorithm_not_allowed",
        `algorithm.rejected ${algorithm}`,
      );
    }
    assert.equal(
      env.state.fetches,
      fetchesAfterAllowed,
      "a rejected algorithm must not trigger a key fetch",
    );
  });
});

test("jwks-validator.v1 executes every fixture case against real RSA keys", async () => {
  const fixture = loadFixture("jwks-validator.v1.json");
  const names = fixture.cases.map((testCase) => testCase.name).sort();
  assert.deepEqual(
    names,
    Object.keys(JWKS_CASE_EXECUTORS).sort(),
    "every fixture case must have an executor and every executor a fixture case",
  );

  let executed = 0;
  for (const row of fixture.cases) {
    await JWKS_CASE_EXECUTORS[row.name](row);
    executed += 1;
  }
  assert.equal(executed, fixture.cases.length);
});

test("discovery-bootstrap.v1 executes every fixture case over a loopback server", async () => {
  const fixture = loadFixture("discovery-bootstrap.v1.json");
  assert.equal(fixture.security.https_only, true);
  assert.equal(fixture.security.issuer_must_match_discovery_document, true);
  assert.equal(fixture.security.cross_origin_redirect, "rejected");

  const names = fixture.cases.map((testCase) => testCase.name).sort();
  assert.deepEqual(
    names,
    Object.keys(DISCOVERY_CASE_EXECUTORS).sort(),
    "every fixture case must have an executor and every executor a fixture case",
  );

  let executed = 0;
  for (const row of fixture.cases) {
    await DISCOVERY_CASE_EXECUTORS[row.name](row);
    executed += 1;
  }
  assert.equal(executed, fixture.cases.length);
});

test("route-challenge.v1 pins the route-derived resource indicator surface", () => {
  const fixture = loadFixture("route-challenge.v1.json");
  const rows = fixture.resource_indicator;
  assert.ok(rows.accept.length > 0, "fixture must carry accept rows");
  assert.ok(rows.reject.length > 0, "fixture must carry reject rows");

  for (const row of rows.accept) {
    assert.equal(
      canonicalResourceURL(row.requested),
      canonicalResourceURL(row.route_resource),
      `accept ${row.requested}`,
    );
    assert.equal(
      resourceIndicatorMatches(row.route_resource, row.requested),
      row.match,
      `accept ${row.requested}`,
    );
  }
  for (const row of rows.reject) {
    assert.equal(
      resourceIndicatorMatches(row.route_resource, row.requested),
      false,
      `reject ${row.requested}`,
    );
  }

  const example = fixture.route_derived.example;
  assert.equal(
    resourceMetadataURLFromMcpEndpoint(example.resource),
    example.resource_metadata_url,
  );
  assert.equal(
    protectedResourceWWWAuthenticate(example.resource_metadata_url),
    example.challenge,
  );
});

test("an RS256 token from OIDC discovery reaches the MCP transport handler", async () => {
  const documents = {
    jwks: () => ({ body: { keys: [KEY_A.jwk] } }),
    discovery: (origin) => ({
      body: { issuer: origin, jwks_uri: `${origin}${JWKS_PATH}` },
    }),
  };
  await withEnv(documents, async (env) => {
    const validate = await newJwksValidator({
      issuer: env.issuer,
      discoveryUrl: env.discoveryUrl,
      fetchImpl: env.fetchImpl,
      now: env.now,
      requiredAudience: AUDIENCE,
      requiredScopes: ["mcp:read"],
    });

    const app = createApp();
    const handler = countingTransportHandler();
    registerMcpFacade(app, {
      mcpPaths: ["/acme/mcp"],
      mcpHandler: handler.handler,
      transportPosture: "runtime-bearer",
      requireBearerToken: {
        resourceMetadataURL: RESOURCE_METADATA_URL,
        requiredScopes: ["mcp:read"],
        claimsValidator: validate,
      },
    });

    await assertBearerTokenReachesTransportHandler(
      app,
      "POST",
      "/acme/mcp",
      rs256Token(env, KEY_A),
      handler,
    );

    const expired = rs256Token(env, KEY_A, {
      exp: Math.floor(env.clock.t / 1000) - 60,
    });
    const response = await app.serve({
      method: "POST",
      path: "/acme/mcp",
      headers: { authorization: [`Bearer ${expired}`] },
      query: {},
      body: Buffer.alloc(0),
      isBase64: false,
    });
    assert.equal(response.status, 401);
    assert.equal(
      firstHeader(response.headers, "www-authenticate"),
      protectedResourceWWWAuthenticate(RESOURCE_METADATA_URL),
    );
    assert.equal(handler.invocations(), 1);
  });
});

function firstHeader(headers, name) {
  const key = String(name).toLowerCase();
  for (const [rawKey, values] of Object.entries(headers ?? {})) {
    if (rawKey.toLowerCase() !== key) {
      continue;
    }
    return String(values?.[0] ?? "");
  }
  return "";
}
