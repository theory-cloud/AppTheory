import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  DEFAULT_CALLBACK_PATH,
  createApp,
  hashKey,
  oauthAuthorizePath,
  oauthTokenPath,
  pkceChallengeS256,
  registerMcpFacade,
} from "../dist/index.js";
import {
  MemoryAuthorizationCodeStore,
  MemoryClientStore,
  MemoryRateLimitStore,
  MemoryRouteRefreshBrokerStore,
  MemoryTransactionStore,
} from "../dist/oauth/store.js";
import { newAutheoryProvider } from "../dist/oauth/provider.js";
import { newFakeOAuthProvider } from "../dist/testkit/oauthprovider.js";
import { ManualClock } from "../dist/clock.js";

// ---------------------------------------------------------------------------
// Fixture constants (mirroring runtime/mcpfacade/front_channel_test.go)
// ---------------------------------------------------------------------------

const BASE_URL = "https://mcp.example.com";
const UPSTREAM_ISS = "https://id.example.com";
const CLIENT_ID = "facade-client-1";
const CLIENT_REDIRECT = "https://client.example/callback";
const UPSTREAM_CODE = "upstream-authorization-code";
const UPSTREAM_REFRESH_TOKEN = "upstream-refresh-token-value";
const CLIENT_STATE = "client-state-1";
const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noContent() {
  return {
    status: 204,
    headers: {},
    cookies: [],
    body: Buffer.alloc(0),
    isBase64: false,
  };
}

function locationOf(response) {
  const values = response.headers["location"];
  return values === undefined || values.length === 0 ? "" : values[0];
}

function locationQuery(response) {
  const location = locationOf(response);
  if (location === "") {
    return new URLSearchParams();
  }
  return new URL(location).searchParams;
}

function bodyString(response) {
  return Buffer.from(response.body).toString("utf8");
}

function firstHeader(headers, name) {
  const key = name.toLowerCase();
  for (const [rawKey, values] of Object.entries(headers ?? {})) {
    if (rawKey.toLowerCase() === key) {
      return values[0];
    }
  }
  return undefined;
}

function responseScan(response) {
  let scanned = `${locationOf(response)}\n`;
  for (const values of Object.values(response.headers)) {
    scanned += `${values.join("\n")}\n`;
  }
  return scanned + bodyString(response);
}

/** Counts every form-encoded token request the fake upstream answers. */
class CountingBridge {
  constructor(publicBaseUrl, loopbackUrl, tokenPath) {
    this.loopback = new URL(loopbackUrl);
    this.host = new URL(publicBaseUrl).hostname;
    this.tokenPath = tokenPath;
    this.tokenCalls = 0;
  }

  fetch(input, init) {
    const target = new URL(String(input));
    if (target.hostname === this.host) {
      if (target.pathname === this.tokenPath) {
        this.tokenCalls += 1;
      }
      target.protocol = this.loopback.protocol;
      target.host = this.loopback.host;
    }
    return fetch(target, init);
  }
}

/**
 * Wraps the real Autheory adapter. Every leg is the adapter over the fake
 * provider's loopback HTTP except `exchangeCode`, which first runs the
 * adapter's real server-side exchange (so the upstream form and client are
 * genuinely presented and recorded) and then returns a token set whose access
 * token the fake signs, so the facade's JWKS validation of the exchanged token
 * is exercised against a real signature.
 */
class MintingProvider {
  constructor(adapter, fake, claims) {
    this.adapter = adapter;
    this.fake = fake;
    this.claims = claims;
  }

  discovery() {
    return this.adapter.discovery();
  }

  authorizationUrl(req) {
    return this.adapter.authorizationUrl(req);
  }

  async exchangeCode(req) {
    await this.adapter.exchangeCode(req);
    return {
      accessToken: this.fake.mintAccessToken(this.claims),
      refreshToken: UPSTREAM_REFRESH_TOKEN,
      tokenType: "Bearer",
      expiresIn: 900,
      scope: "mcp:tools",
    };
  }

  refresh(req) {
    return this.adapter.refresh(req);
  }

  validateAccessToken(token, expected) {
    return this.adapter.validateAccessToken(token, expected);
  }
}

/**
 * Decorates the reference broker store and records every handle it is seeded
 * with, so a test can observe the record a callback opened.
 */
class RecordingBrokerStore {
  constructor(inner, handles) {
    this.inner = inner;
    this.handles = handles;
  }

  put(record) {
    this.handles.push(record.handleHash);
    return this.inner.put(record);
  }

  get(handleHash) {
    return this.inner.get(handleHash);
  }

  acquireLock(handleHash, lockOwner, expectedVersion) {
    return this.inner.acquireLock(handleHash, lockOwner, expectedVersion);
  }

  compareAndSwap(record, expectedVersion) {
    return this.inner.compareAndSwap(record, expectedVersion);
  }

  revoke(handleHash) {
    return this.inner.revoke(handleHash);
  }

  handleHashes() {
    return [...this.handles];
  }
}

async function newFrontChannelHarness(t) {
  const clock = new ManualClock(new Date("2026-01-01T00:00:00Z"));
  const now = () => clock.now();
  const handles = [];
  const broker = new RecordingBrokerStore(
    new MemoryRouteRefreshBrokerStore({ now }),
    handles,
  );
  const stores = {
    transaction: new MemoryTransactionStore({ now }),
    authorizationCode: new MemoryAuthorizationCodeStore({ now }),
    client: new MemoryClientStore({ now }),
    routeRefreshBroker: broker,
    rateLimit: new MemoryRateLimitStore({ now }),
  };

  const fake = newFakeOAuthProvider({
    issuer: UPSTREAM_ISS,
    publicBaseUrl: UPSTREAM_ISS,
    tokenBody: {
      access_token: "placeholder-upstream-access-token",
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: UPSTREAM_REFRESH_TOKEN,
      scope: "mcp:tools",
    },
  });
  const loopbackUrl = await fake.start();
  t.after(() => fake.close());
  const bridge = new CountingBridge(UPSTREAM_ISS, loopbackUrl, fake.tokenPath);
  const adapter = await newAutheoryProvider({
    issuer: UPSTREAM_ISS,
    clientId: CLIENT_ID,
    fetchImpl: (input, init) => bridge.fetch(input, init),
    allowPrivateHosts: true,
  });
  const provider = new MintingProvider(adapter, fake, {
    issuer: UPSTREAM_ISS,
    audience: `${BASE_URL}/acme/mcp`,
    authorizedParty: CLIENT_ID,
    subject: "user-1",
    scope: "mcp:tools",
    expiresInSeconds: 900,
  });

  const kind = "namespace";
  const endpoint = { kind, clientNamespace: "acme" };
  const config = {
    issuerURL: `${BASE_URL}/acme/mcp`,
    jwksURI: `${UPSTREAM_ISS}/.well-known/jwks.json`,
    issuerMode: "route",
    urlMode: "public_base_url",
    publicBaseURL: BASE_URL,
    transportPosture: "iam",
    scopes: {
      namespace: ["mcp:tools"],
      partner_namespace: ["mcp:tools"],
      agent: ["mcp:tools"],
      partner_agent: ["mcp:tools"],
    },
    mcpHandler: () => noContent(),
    provider,
    stores,
    upstreamClientID: CLIENT_ID,
    upstreamIssuer: UPSTREAM_ISS,
  };
  await stores.client.put({
    clientIdHash: hashKey(CLIENT_ID),
    clientId: CLIENT_ID,
    redirectUris: [CLIENT_REDIRECT],
    tokenEndpointAuthMethod: "none",
    grantTypes: [],
    responseTypes: [],
    boundRoute: "",
    createdAt: new Date(0),
    version: 0,
  });

  const app = createApp({ tier: "p0" });
  registerMcpFacade(app, config);

  const serve = async (method, path, query, body) => {
    const request = {
      method,
      path,
      headers: {},
      query: query ?? {},
      body: body ?? Buffer.alloc(0),
      isBase64: false,
    };
    return await app.serve(request);
  };

  const authorize = async (mutate) => {
    const query = {
      client_id: [CLIENT_ID],
      redirect_uri: [CLIENT_REDIRECT],
      response_type: ["code"],
      code_challenge: [pkceChallengeS256(VERIFIER)],
      code_challenge_method: ["S256"],
      state: [CLIENT_STATE],
      resource: [`${BASE_URL}/acme/mcp`],
    };
    if (mutate !== undefined) {
      mutate(query);
    }
    return await serve("GET", oauthAuthorizePath(endpoint), query, null);
  };

  const callback = async (upstreamState) =>
    await serve(
      "GET",
      DEFAULT_CALLBACK_PATH,
      { code: [UPSTREAM_CODE], state: [upstreamState], iss: [UPSTREAM_ISS] },
      null,
    );

  const authorizeAndCallback = async () => {
    const authorizeResponse = await authorize(undefined);
    assert.equal(authorizeResponse.status, 302);
    const upstreamState = locationQuery(authorizeResponse).get("state");
    const callbackResponse = await callback(upstreamState);
    assert.equal(callbackResponse.status, 302);
    const code = locationQuery(callbackResponse).get("code");
    assert.ok(code !== null && code !== "");
    return { callback: callbackResponse, code };
  };

  const token = async (form) =>
    await serve(
      "POST",
      oauthTokenPath(endpoint),
      null,
      Buffer.from(new URLSearchParams(form).toString(), "utf8"),
    );

  return {
    app,
    fake,
    clock,
    stores,
    broker,
    kind,
    authorize,
    callback,
    authorizeAndCallback,
    token,
    serve,
    tokenForm: (code, overrides = {}) => ({
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      redirect_uri: CLIENT_REDIRECT,
      client_id: CLIENT_ID,
      ...overrides,
    }),
    tokenCalls: () => bridge.tokenCalls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("hashKey is the unpadded base64url SHA-256 digest", () => {
  const expected = createHash("sha256")
    .update("abc", "utf8")
    .digest("base64url");
  assert.equal(hashKey("abc"), expected);
  assert.equal(
    hashKey("abc"),
    "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
  );
  assert.ok(!hashKey("abc").includes("="));
});

test("authorize redirects upstream with the facade's own material", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const response = await harness.authorize(undefined);
  assert.equal(response.status, 302);

  const location = locationOf(response);
  assert.ok(location.startsWith(`${UPSTREAM_ISS}/`), location);
  const query = locationQuery(response);
  assert.equal(query.get("client_id"), CLIENT_ID);
  assert.equal(query.get("redirect_uri"), `${BASE_URL}/_oauth/mcp/callback`);
  assert.equal(query.get("code_challenge_method"), "S256");
  assert.ok(query.get("code_challenge"));
  assert.equal(query.get("resource"), `${BASE_URL}/acme/mcp`);
  assert.notEqual(query.get("state"), CLIENT_STATE);
  assert.notEqual(query.get("state"), "");
});

test("authorize rejects unknown client and unmatched redirect without redirect", async (t) => {
  const harness = await newFrontChannelHarness(t);

  const unknown = await harness.authorize((query) => {
    query.client_id = ["unknown-client"];
  });
  assert.equal(unknown.status, 400);
  assert.equal(locationOf(unknown), "");
  assert.match(bodyString(unknown), /"error":"invalid_client"/);

  const unmatched = await harness.authorize((query) => {
    query.redirect_uri = ["https://evil.example/cb"];
  });
  assert.equal(unmatched.status, 400);
  assert.equal(locationOf(unmatched), "");
});

test("authorize requires fresh S256 PKCE and refuses a plain challenge", async (t) => {
  const harness = await newFrontChannelHarness(t);

  const missing = await harness.authorize((query) => {
    delete query.code_challenge;
    delete query.code_challenge_method;
  });
  assert.equal(missing.status, 302);
  assert.equal(locationQuery(missing).get("error"), "invalid_request");

  const plain = await harness.authorize((query) => {
    query.code_challenge = ["plain-challenge-value"];
    query.code_challenge_method = ["plain"];
  });
  assert.equal(plain.status, 302);
  assert.equal(locationQuery(plain).get("error"), "invalid_request");
});

test("authorize rejects a resource that is not the route resource", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const response = await harness.authorize((query) => {
    query.resource = [`${BASE_URL}/other/mcp`];
  });
  assert.equal(response.status, 302);
  assert.equal(locationQuery(response).get("error"), "invalid_target");
});

test("callback completes the journey and hides upstream material", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const { callback } = await harness.authorizeAndCallback();
  assert.equal(locationQuery(callback).get("iss"), `${BASE_URL}/acme/mcp`);
  assert.equal(locationQuery(callback).get("state"), CLIENT_STATE);

  const scanned = responseScan(callback);
  assert.ok(!scanned.includes(UPSTREAM_CODE));
  assert.ok(!scanned.includes(UPSTREAM_REFRESH_TOKEN));
  assert.ok(!scanned.includes("id_token"));
  assert.equal(harness.tokenCalls(), 1);
});

test("callback rejects an iss mismatch before consuming or exchanging", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const authorizeResponse = await harness.authorize(undefined);
  const state = locationQuery(authorizeResponse).get("state");

  const mismatch = await harness.serve(
    "GET",
    DEFAULT_CALLBACK_PATH,
    { code: [UPSTREAM_CODE], state: [state], iss: ["https://evil.example"] },
    null,
  );
  assert.equal(mismatch.status, 400);
  assert.equal(locationOf(mismatch), "");
  assert.equal(harness.tokenCalls(), 0);

  // The transaction was not consumed: the same state still completes.
  const retry = await harness.callback(state);
  assert.equal(retry.status, 302);
  assert.ok(locationQuery(retry).get("code"));
});

test("callback rejects an absent iss", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const authorizeResponse = await harness.authorize(undefined);
  const state = locationQuery(authorizeResponse).get("state");

  const response = await harness.serve(
    "GET",
    DEFAULT_CALLBACK_PATH,
    { code: [UPSTREAM_CODE], state: [state] },
    null,
  );
  assert.equal(response.status, 400);
  assert.equal(locationOf(response), "");
  assert.equal(harness.tokenCalls(), 0);
});

test("callback rejects forged and replayed state", async (t) => {
  const harness = await newFrontChannelHarness(t);

  const forged = await harness.serve(
    "GET",
    DEFAULT_CALLBACK_PATH,
    { code: ["attacker-code"], state: ["attacker-state"], iss: [UPSTREAM_ISS] },
    null,
  );
  assert.equal(forged.status, 400);
  assert.equal(locationOf(forged), "");
  assert.equal(harness.tokenCalls(), 0);

  const authorizeResponse = await harness.authorize(undefined);
  const state = locationQuery(authorizeResponse).get("state");
  const first = await harness.callback(state);
  assert.equal(first.status, 302);
  assert.equal(harness.tokenCalls(), 1);

  const replayed = await harness.serve(
    "GET",
    DEFAULT_CALLBACK_PATH,
    { code: ["c"], state: [state], iss: [UPSTREAM_ISS] },
    null,
  );
  assert.equal(replayed.status, 400);
  assert.equal(locationOf(replayed), "");
  assert.equal(harness.tokenCalls(), 1);
});

test("token exchange returns the opaque handle and the unmodified token", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const { code } = await harness.authorizeAndCallback();
  const minted = harness.fake.mintAccessToken({
    issuer: UPSTREAM_ISS,
    audience: `${BASE_URL}/acme/mcp`,
    authorizedParty: CLIENT_ID,
    subject: "user-1",
    scope: "mcp:tools",
    expiresInSeconds: 900,
  });

  const response = await harness.token(harness.tokenForm(code));
  assert.equal(response.status, 200);
  const body = bodyString(response);
  assert.ok(body.includes(`"access_token":"${minted}"`));
  assert.ok(body.includes(`"refresh_token":"`));
  assert.ok(!body.includes(UPSTREAM_REFRESH_TOKEN));
  assert.ok(!body.includes("id_token"));
  assert.ok(body.includes(`"token_type":"Bearer"`));
  assert.equal(firstHeader(response.headers, "cache-control"), "no-store");
  assert.equal(firstHeader(response.headers, "pragma"), "no-cache");
});

test("a replayed code returns invalid_grant and revokes the broker record", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const { code } = await harness.authorizeAndCallback();
  const form = harness.tokenForm(code);

  const first = await harness.token(form);
  assert.equal(first.status, 200);
  const handle = JSON.parse(bodyString(first)).refresh_token;
  assert.ok(handle);
  const handleHash = hashKey(handle);

  const replay = await harness.token(form);
  assert.equal(replay.status, 400);
  assert.match(bodyString(replay), /"error":"invalid_grant"/);

  const record = await harness.stores.routeRefreshBroker.get(handleHash);
  assert.ok(record !== null);
  assert.equal(record.status, "revoked");
});

test("a wrong verifier and an unknown code produce identical invalid_grant bodies", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const { code } = await harness.authorizeAndCallback();

  const wrong = await harness.token(
    harness.tokenForm(code, {
      code_verifier: "WRONGVERIFIERWRONGVERIFIERWRONGVERIFIER1234567890",
    }),
  );
  assert.equal(wrong.status, 400);
  assert.match(bodyString(wrong), /"error":"invalid_grant"/);

  const unknown = await harness.token(
    harness.tokenForm("never-minted-code"),
  );
  assert.equal(unknown.status, 400);
  assert.equal(bodyString(wrong), bodyString(unknown));
});

test("a code issued to one client cannot be redeemed by another", async (t) => {
  const harness = await newFrontChannelHarness(t);
  await harness.stores.client.put({
    clientIdHash: hashKey("other-client"),
    clientId: "other-client",
    redirectUris: [CLIENT_REDIRECT],
    tokenEndpointAuthMethod: "none",
    grantTypes: [],
    responseTypes: [],
    boundRoute: "",
    createdAt: new Date(0),
    version: 0,
  });
  const { code } = await harness.authorizeAndCallback();

  const response = await harness.token(
    harness.tokenForm(code, { client_id: "other-client" }),
  );
  assert.equal(response.status, 400);
  assert.match(bodyString(response), /"error":"invalid_grant"/);
});

test("the refresh_token grant is refused until M3c", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const response = await harness.token({
    grant_type: "refresh_token",
    refresh_token: "whatever-handle",
    client_id: CLIENT_ID,
  });
  assert.equal(response.status, 400);
  assert.match(bodyString(response), /"error":"unsupported_grant_type"/);
});

test("an expired code burns then replays", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const { code } = await harness.authorizeAndCallback();
  const form = harness.tokenForm(code);
  harness.clock.advance(2 * 60 * 1000);

  const expired = await harness.token(form);
  assert.equal(expired.status, 400);
  assert.match(bodyString(expired), /"error":"invalid_grant"/);

  const handles = harness.broker.handleHashes();
  assert.equal(handles.length, 1);

  const replay = await harness.token(form);
  assert.equal(replay.status, 400);
  const record = await harness.stores.routeRefreshBroker.get(handles[0]);
  assert.ok(record !== null);
  assert.equal(record.status, "revoked");
});

test("concurrent redemption of one code has exactly one winner", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const { code } = await harness.authorizeAndCallback();
  const form = harness.tokenForm(code);

  const callers = 8;
  const responses = await Promise.all(
    Array.from({ length: callers }, () => harness.token(form)),
  );
  const winners = responses.filter((response) => response.status === 200);
  assert.equal(winners.length, 1);
  for (const response of responses) {
    assert.ok(response.status === 200 || response.status === 400);
  }

  const handles = harness.broker.handleHashes();
  assert.equal(handles.length, 1);
  const record = await harness.stores.routeRefreshBroker.get(handles[0]);
  assert.ok(record !== null);
  assert.equal(record.status, "revoked");
});
