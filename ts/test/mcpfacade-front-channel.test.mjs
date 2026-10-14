import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CALLBACK_PATH,
  createApp,
  hashKey,
  mcpPath,
  oauthAuthorizationServerPath,
  oauthAuthorizationServerSuffixPath,
  oauthAuthorizePath,
  oauthRegisterPath,
  oauthTokenPath,
  pkceChallengeS256,
  protectedResourcePath,
  registerMcpFacade,
} from "../dist/index.js";
import {
  BrokerVersionConflictError,
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

// The refresh grant's own upstream material. The fake serves these only for
// grant_type=refresh_token, so a refresh that returned upstream material
// instead of a framework handle is distinguishable from the code exchange, and a
// response that leaked either value is observable.
const ROTATED_UPSTREAM_REFRESH_TOKEN = "upstream-refresh-token-rotated";
const REFRESH_ACCESS_TOKEN = "upstream-rotated-access-token";
const REFRESH_ID_TOKEN = "upstream-id-token-must-not-surface";
const ROTATED_UPSTREAM_SCOPE = "mcp:tools";

// ---------------------------------------------------------------------------
// Shared conformance fixture (the same table the Go and Python loaders read)
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "contract-tests",
  "fixtures",
  "routing",
  "mcp-auth-facade",
);

const FIXTURE_NAME = "facade-conformance.v1.json";

const REDIRECT_MATCH_GROUP = "redirect_match";

/**
 * The number of redirect_match rows the shared table must carry; a change to the
 * table must also be a deliberate edit in the Go and Python loaders, so no
 * runtime can silently execute a smaller table.
 */
const REDIRECT_MATCH_CASE_COUNT = 11;

const FORM_PARSE_GROUP = "form_parse";

/**
 * The number of form_parse rows the shared table must carry; a change to the
 * table must also be a deliberate edit in the Go and Python loaders, so no
 * runtime can silently execute a smaller table.
 */
const FORM_PARSE_CASE_COUNT = 11;

const METHOD_STATUS_GROUP = "method_status";

/**
 * The number of method_status rows the shared table must carry; a change to the
 * table must also be a deliberate edit in the Go and Python loaders, so no
 * runtime can silently execute a smaller table.
 */
const METHOD_STATUS_CASE_COUNT = 10;

const DCR_GROUP = "dcr";

/**
 * The number of dcr rows the shared table must carry; a change to the table must
 * also be a deliberate edit in the Go and Python loaders, so no runtime can
 * silently execute a smaller table.
 */
const DCR_CASE_COUNT = 10;

/**
 * The number of bytes the serialized `pad` member adds around its "a" run:
 * `,"pad":"` plus `"}`.
 */
const DCR_FRAME_OVERHEAD =
  Buffer.byteLength(`,"pad":"`) + Buffer.byteLength(`"}`);

/**
 * Builds the raw body a form_parse row presents: the small rows carry a literal
 * body, and the bound rows carry `body_prefix` padded with "a" out to exactly
 * `total_bytes`, so the row pins the byte length the handler sees.
 */
function formParseBody(row) {
  if (row.total_bytes === undefined) {
    return row.body ?? "";
  }
  const prefix = row.body_prefix ?? "";
  const pad = Math.max(row.total_bytes - Buffer.byteLength(prefix, "utf8"), 0);
  return prefix + "a".repeat(pad);
}

/**
 * Keeps a failure message readable for a bound row, whose literal body is 16 KiB
 * of padding.
 */
function formParseLabel(row) {
  if (row.total_bytes === undefined) {
    return JSON.stringify(row.body ?? "");
  }
  return `${row.body_prefix}<pad>`;
}

/**
 * Builds the raw body a dcr row presents: the row's JSON request verbatim, or,
 * for a padded row, that request plus one ignored `pad` member sized so the
 * serialized body is exactly `pad_to_bytes` bytes.
 */
function dcrBody(row) {
  const compact = JSON.stringify(row.request ?? {});
  if (row.pad_to_bytes === undefined || row.pad_to_bytes === 0) {
    return Buffer.from(compact, "utf8");
  }
  const padding =
    row.pad_to_bytes -
    (Buffer.byteLength(compact, "utf8") - 1) -
    DCR_FRAME_OVERHEAD;
  if (padding < 1) {
    throw new Error(`row ${row.id} cannot pad to ${row.pad_to_bytes} bytes`);
  }
  return Buffer.from(
    `${compact.slice(0, -1)},"pad":"${"a".repeat(padding)}"}`,
    "utf8",
  );
}

function loadFixture() {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, FIXTURE_NAME), "utf8"));
}

/**
 * Resolves a method_status row's route key to the concrete path the facade
 * mounts, deriving every mounted path from the framework's route-algebra helpers
 * rather than a hard-coded string. `unmounted_token` and `unknown` are
 * deliberately not mounted: the first is a bare MCP path with a trailing
 * segment, and the second is a path no kind's pattern can match.
 */
function methodStatusRoutePath(endpoint, key) {
  switch (key) {
    case "mcp":
      return mcpPath(endpoint);
    case "token":
      return oauthTokenPath(endpoint);
    case "authorize":
      return oauthAuthorizePath(endpoint);
    case "callback":
      return DEFAULT_CALLBACK_PATH;
    case "discovery_canonical":
      return oauthAuthorizationServerPath(endpoint);
    case "discovery_suffix":
      return oauthAuthorizationServerSuffixPath(endpoint);
    case "protected_resource":
      return protectedResourcePath(endpoint);
    case "unmounted_token":
      return `${mcpPath(endpoint)}/token`;
    case "unknown":
      return "/unknown/mcp/path";
    default:
      throw new Error(`unknown method_status route key ${JSON.stringify(key)}`);
  }
}

/**
 * Returns the sorted methods the response's allow header lists, or an empty
 * list when the header is absent or empty.
 */
function allowMethods(response) {
  const raw = firstHeader(response.headers, "allow");
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .sort();
}

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

/**
 * Tunes the harness a test starts. Omitting the options is the default harness
 * every front-channel test uses.
 */
function frontChannelHarnessOptions(overrides = {}) {
  return {
    // Mutates the fake upstream's options before it starts, so a test can serve
    // a grant-specific or failing token response.
    providerOptions: overrides.providerOptions ?? (() => {}),
    // Tune the facade the harness registers. The default issuer mode is the
    // route mode every front-channel test uses.
    issuerMode: overrides.issuerMode ?? "route",
    registrationEndpointURL: overrides.registrationEndpointURL ?? null,
  };
}

async function newFrontChannelHarness(t, overrides = {}) {
  const options = frontChannelHarnessOptions(overrides);
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

  const fakeOptions = {
    issuer: UPSTREAM_ISS,
    publicBaseUrl: UPSTREAM_ISS,
    tokenBody: {
      access_token: "placeholder-upstream-access-token",
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: UPSTREAM_REFRESH_TOKEN,
      scope: "mcp:tools",
    },
    // The refresh grant gets its own response, so a facade that returned
    // upstream refresh material or an id_token instead of a framework handle is
    // observable in the body as well as in the call counts.
    refreshTokenBody: {
      access_token: REFRESH_ACCESS_TOKEN,
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: ROTATED_UPSTREAM_REFRESH_TOKEN,
      scope: ROTATED_UPSTREAM_SCOPE,
      id_token: REFRESH_ID_TOKEN,
    },
  };
  options.providerOptions(fakeOptions);
  const fake = newFakeOAuthProvider(fakeOptions);
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
    issuerMode: options.issuerMode,
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
  if (options.registrationEndpointURL !== null) {
    config.registrationEndpointURL = options.registrationEndpointURL;
  }
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

  // The app clock is the same deterministic instant the stores observe, so
  // ctx.now() and the broker's now() move together when a test advances the
  // clock: grace windows, record lifetimes, and rotation timestamps all do.
  const app = createApp({ tier: "p0", clock });
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
    endpoint,
    tokenPath: oauthTokenPath(endpoint),
    registerPath: oauthRegisterPath(endpoint),
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
  assert.equal(hashKey("abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
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

test("authorize enforces the shared redirect_match table through the real handler", async (t) => {
  const rows = (loadFixture().cases ?? []).filter(
    (row) => row.group === REDIRECT_MATCH_GROUP,
  );
  assert.equal(rows.length, REDIRECT_MATCH_CASE_COUNT);

  const harness = await newFrontChannelHarness(t);
  let executed = 0;
  for (const row of rows) {
    executed += 1;
    const clientId = `redirect-match-${row.id}`;
    await harness.stores.client.put({
      clientIdHash: hashKey(clientId),
      clientId,
      redirectUris: [...row.registered],
      tokenEndpointAuthMethod: "none",
      grantTypes: [],
      responseTypes: [],
      boundRoute: "",
      createdAt: new Date(0),
      version: 0,
    });

    const response = await harness.authorize((query) => {
      query.client_id = [clientId];
      query.redirect_uri = [row.requested];
    });

    const context = `registered ${JSON.stringify(row.registered)}, requested ${row.requested}`;
    if (row.expect === "accept") {
      assert.equal(response.status, 302, context);
    } else if (row.expect === "reject") {
      assert.equal(response.status, 400, context);
      assert.equal(locationOf(response), "", context);
    } else {
      assert.fail(`unknown expect ${JSON.stringify(row.expect)}`);
    }
  }
  assert.equal(executed, REDIRECT_MATCH_CASE_COUNT);
});

test("token enforces the shared form_parse table through the real handler", async (t) => {
  const rows = (loadFixture().cases ?? []).filter(
    (row) => row.group === FORM_PARSE_GROUP,
  );
  assert.equal(rows.length, FORM_PARSE_CASE_COUNT);

  const harness = await newFrontChannelHarness(t);
  let executed = 0;
  for (const row of rows) {
    executed += 1;
    const body = formParseBody(row);
    if (row.total_bytes !== undefined) {
      assert.equal(
        Buffer.byteLength(body, "utf8"),
        row.total_bytes,
        `case ${row.id} must present exactly ${row.total_bytes} body bytes`,
      );
    }

    const response = await harness.serve(
      "POST",
      harness.tokenPath,
      null,
      Buffer.from(body, "utf8"),
    );
    const context = formParseLabel(row);
    assert.equal(response.status, 400, context);
    const payload = JSON.parse(bodyString(response));
    assert.equal(payload.error, row.expect_error, context);
  }
  assert.equal(executed, FORM_PARSE_CASE_COUNT);
});

test("method status enforces the shared method_status table through the real mounted app", async (t) => {
  const rows = (loadFixture().cases ?? []).filter(
    (row) => row.group === METHOD_STATUS_GROUP,
  );
  assert.equal(rows.length, METHOD_STATUS_CASE_COUNT);

  const harness = await newFrontChannelHarness(t);
  let executed = 0;
  for (const row of rows) {
    executed += 1;
    const path = methodStatusRoutePath(harness.endpoint, row.route);
    const response = await harness.serve(row.method, path, null, null);
    const context = `route ${JSON.stringify(row.route)} method ${row.method}`;
    assert.equal(response.status, row.expect_status, context);
    assert.deepEqual(allowMethods(response), row.expect_allow, context);
    if (row.expect_status === 404) {
      assert.equal(firstHeader(response.headers, "allow"), undefined, context);
    }
  }
  assert.equal(executed, METHOD_STATUS_CASE_COUNT);
});

test("register enforces the shared dcr table through the real mounted handler", async (t) => {
  const rows = (loadFixture().cases ?? []).filter(
    (row) => row.group === DCR_GROUP,
  );
  assert.equal(rows.length, DCR_CASE_COUNT);

  let executed = 0;
  for (const row of rows) {
    executed += 1;
    // A fresh harness per row: the per-route registration bucket is
    // deterministic, so the rate-limited row's eleventh attempt is the first
    // refusal.
    const harness = await newFrontChannelHarness(t);
    const body = dcrBody(row);
    if (row.pad_to_bytes !== undefined && row.pad_to_bytes !== 0) {
      assert.equal(
        Buffer.byteLength(body, "utf8"),
        row.pad_to_bytes,
        `row ${row.id} must present exactly ${row.pad_to_bytes} body bytes`,
      );
    }

    const repeat = row.repeat >= 1 ? row.repeat : 1;
    let response;
    for (let attempt = 0; attempt < repeat; attempt += 1) {
      response = await harness.serve("POST", harness.registerPath, null, body);
    }

    const context = `row ${row.id}`;
    assert.equal(response.status, row.expect_status, context);
    const scanned = bodyString(response);
    const payload = JSON.parse(scanned);
    for (const token of row.expect_body_has) {
      assert.ok(
        scanned.includes(token),
        `${context} body must include ${token}`,
      );
    }
    for (const token of row.expect_body_absent) {
      assert.ok(
        !scanned.includes(token),
        `${context} body must not include ${token}`,
      );
    }
    if (row.expect_no_store) {
      assert.equal(
        firstHeader(response.headers, "cache-control"),
        "no-store",
        context,
      );
      assert.equal(
        firstHeader(response.headers, "pragma"),
        "no-cache",
        context,
      );
    }
    if (row.expect_header !== undefined && row.expect_header !== "") {
      const value = firstHeader(response.headers, row.expect_header);
      assert.notEqual(
        value,
        undefined,
        `${context} must carry ${row.expect_header}`,
      );
      const seconds = Number.parseInt(value, 10);
      assert.ok(
        Number.isInteger(seconds) && seconds >= 1,
        `${context} must not ask for a retry sooner than one second`,
      );
    }
    if (row.expect_status === 201) {
      const clientId = payload.client_id;
      assert.ok(
        typeof clientId === "string" && clientId.length >= 22,
        `${context} must mint an id of at least 128 bits`,
      );
      assert.ok(
        Object.hasOwn(payload, "client_id_issued_at"),
        `${context} must carry client_id_issued_at`,
      );
      const record = await harness.stores.client.get(hashKey(clientId));
      assert.notEqual(
        record,
        null,
        `${context} must persist the registered client`,
      );
      assert.equal(record.tokenEndpointAuthMethod, "none", context);
      assert.ok(record.redirectUris.length > 0, context);
      assert.equal(
        record.boundRoute,
        `${BASE_URL}${mcpPath(harness.endpoint)}`,
        `${context} must bind the client to the advertising route`,
      );
    }
  }
  assert.equal(executed, DCR_CASE_COUNT);
});

const METADATA_REGISTRATION_GROUP = "metadata_registration";

/**
 * The number of metadata_registration rows the shared table must carry; a change
 * to the table must also be a deliberate edit in the Go and Python loaders, so
 * no runtime can silently execute a smaller table.
 */
const METADATA_REGISTRATION_CASE_COUNT = 6;

/** The single route the group resolves, so a row exercises only the mount shape. */
const METADATA_REGISTRATION_ENDPOINT = {
  kind: "namespace",
  clientNamespace: "acme",
};

/**
 * Mounts the facade a metadata_registration row asks for: the front-channel
 * field set only for the rows that request it, so the mounted /register route
 * and the advertised member move together.
 */
async function metadataRegistrationApp(t, row) {
  if (row.front_channel) {
    const harness = await newFrontChannelHarness(t, {
      issuerMode: row.issuer_mode,
      registrationEndpointURL: row.registration_endpoint_url ?? null,
    });
    return harness.app;
  }
  const config = {
    issuerURL: `${BASE_URL}/acme/mcp`,
    jwksURI: `${UPSTREAM_ISS}/.well-known/jwks.json`,
    issuerMode: row.issuer_mode,
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
  };
  if (row.registration_endpoint_url !== undefined) {
    config.registrationEndpointURL = row.registration_endpoint_url;
  }
  if (row.register_handler === true) {
    config.registerHandler = () => () => noContent();
  }
  const app = createApp({ tier: "p0" });
  registerMcpFacade(app, config);
  return app;
}

/**
 * Serves the routed RFC 8414 document for one app with the same request shape the
 * front-channel harness uses.
 */
async function metadataRegistrationDocument(app) {
  const response = await app.serve({
    method: "GET",
    path: oauthAuthorizationServerPath(METADATA_REGISTRATION_ENDPOINT),
    headers: {},
    query: {},
    body: Buffer.alloc(0),
    isBase64: false,
  });
  assert.equal(response.status, 200);
  return JSON.parse(bodyString(response));
}

test("routed metadata advertises registration exactly while the route is mounted", async (t) => {
  const rows = (loadFixture().cases ?? []).filter(
    (row) => row.group === METADATA_REGISTRATION_GROUP,
  );
  assert.equal(rows.length, METADATA_REGISTRATION_CASE_COUNT);

  const registerPath = oauthRegisterPath(METADATA_REGISTRATION_ENDPOINT);

  let executed = 0;
  for (const row of rows) {
    executed += 1;
    await t.test(row.id, async () => {
      const app = await metadataRegistrationApp(t, row);
      const document = await metadataRegistrationDocument(app);

      switch (row.expect) {
        case "absent":
          assert.ok(
            !("registration_endpoint" in document),
            `row ${row.id} must omit registration_endpoint; the /register route is not mounted`,
          );
          break;
        case "configured":
          assert.equal(
            document.registration_endpoint,
            row.registration_endpoint_url,
            row.id,
          );
          break;
        case "issuer_derived":
          assert.equal(
            document.registration_endpoint,
            `${BASE_URL}/acme/mcp/register`,
            row.id,
          );
          break;
        case "route_derived":
          assert.equal(
            document.registration_endpoint,
            `${BASE_URL}${registerPath}`,
            row.id,
          );
          break;
        default:
          assert.fail(`unknown expect ${row.expect}`);
      }
    });
  }
  assert.equal(executed, METADATA_REGISTRATION_CASE_COUNT);
});

const BOUND_ROUTE_GROUP = "bound_route";

/**
 * The number of bound_route rows the shared table must carry; a change to the
 * table must also be a deliberate edit in the Go and Python loaders, so no
 * runtime can silently execute a smaller table.
 */
const BOUND_ROUTE_CASE_COUNT = 5;

/**
 * A client id no bound_route row ever registers, so a refusal row can present the
 * very same request for an unknown client and prove the two refusals are
 * byte-identical (THREAT_MODEL cross-cutting: no oracle).
 */
const BOUND_ROUTE_UNKNOWN_CLIENT_ID = "bound-route-unknown-client";

/** The redirect URI every bound_route client registers and presents. */
const BOUND_ROUTE_REDIRECT_URI = CLIENT_REDIRECT;

/**
 * Resolves a bound_route row's route key to the endpoint the loader serves it
 * at, so every mounted path is derived from the framework's route algebra rather
 * than a hard-coded string. `namespace` is the harness's own route; `agent` is a
 * different mounted route whose advertising resource genuinely differs, so a
 * bound-route comparison cannot pass by coinciding on one path.
 */
function boundRouteEndpoint(key) {
  switch (key) {
    case "namespace":
      return { kind: "namespace", clientNamespace: "acme" };
    case "agent":
      return { kind: "agent", clientNamespace: "acme", agentId: "agent-1" };
    default:
      throw new Error(`unknown bound_route route key ${JSON.stringify(key)}`);
  }
}

/** The advertising route resource of an endpoint, derived as the facade does. */
function boundRouteResource(endpoint) {
  return `${BASE_URL}${mcpPath(endpoint)}`;
}

/** The valid authorize request the rows present, carrying the route resource. */
function boundRouteAuthorizeQuery(endpoint, clientId) {
  return {
    client_id: [clientId],
    redirect_uri: [BOUND_ROUTE_REDIRECT_URI],
    response_type: ["code"],
    code_challenge: [pkceChallengeS256(VERIFIER)],
    code_challenge_method: ["S256"],
    state: [CLIENT_STATE],
    resource: [boundRouteResource(endpoint)],
  };
}

/** The code-exchange form the rows present. */
function boundRouteTokenForm(clientId, code) {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: VERIFIER,
    redirect_uri: BOUND_ROUTE_REDIRECT_URI,
    client_id: clientId,
  });
}

/**
 * Registers one client through the real POST .../register handler at the row's
 * registered route and returns the server-assigned id.
 */
async function boundRouteRegister(harness, endpoint) {
  const response = await harness.serve(
    "POST",
    oauthRegisterPath(endpoint),
    null,
    Buffer.from(
      JSON.stringify({ redirect_uris: [BOUND_ROUTE_REDIRECT_URI] }),
      "utf8",
    ),
  );
  assert.equal(response.status, 201);
  const clientId = JSON.parse(bodyString(response)).client_id;
  assert.ok(typeof clientId === "string" && clientId !== "");
  return clientId;
}

/**
 * Completes authorize plus callback at the registered route and returns the
 * facade code, so a token row has a genuinely redeemable code minted for the
 * client it presents.
 */
async function boundRouteMintCode(harness, endpoint, clientId) {
  const authorizeResponse = await harness.serve(
    "GET",
    oauthAuthorizePath(endpoint),
    boundRouteAuthorizeQuery(endpoint, clientId),
    null,
  );
  assert.equal(authorizeResponse.status, 302);
  const callbackResponse = await harness.serve(
    "GET",
    DEFAULT_CALLBACK_PATH,
    {
      code: [UPSTREAM_CODE],
      state: [locationQuery(authorizeResponse).get("state")],
      iss: [UPSTREAM_ISS],
    },
    null,
  );
  assert.equal(callbackResponse.status, 302);
  const code = locationQuery(callbackResponse).get("code");
  assert.ok(code !== null && code !== "");
  return code;
}

/**
 * Pins the registration route binding to the shared cross-runtime table through
 * the real mounted handlers: a client registered through POST .../register is
 * accepted only at the advertising route it registered at and is refused at any
 * other mounted route with the same non-oracle invalid_client response an unknown
 * client gets, while a pre-registered client whose record carries no bound route
 * stays valid at every route.
 */
test("bound route enforces the shared bound_route table through the real mounted handlers", async (t) => {
  const rows = (loadFixture().cases ?? []).filter(
    (row) => row.group === BOUND_ROUTE_GROUP,
  );
  assert.equal(rows.length, BOUND_ROUTE_CASE_COUNT);

  let executed = 0;
  for (const row of rows) {
    executed += 1;
    const harness = await newFrontChannelHarness(t);
    const registered = boundRouteEndpoint(row.registered_at);
    const presented = boundRouteEndpoint(row.presented_at);
    const context = `row ${row.id}`;

    let clientId = CLIENT_ID;
    if (row.client === "dcr") {
      clientId = await boundRouteRegister(harness, registered);
    } else if (row.client !== "pre_registered") {
      assert.fail(`unknown bound_route client ${JSON.stringify(row.client)}`);
    }

    let response;
    let unknown;
    if (row.stage === "authorize") {
      const path = oauthAuthorizePath(presented);
      response = await harness.serve(
        "GET",
        path,
        boundRouteAuthorizeQuery(presented, clientId),
        null,
      );
      unknown = await harness.serve(
        "GET",
        path,
        boundRouteAuthorizeQuery(presented, BOUND_ROUTE_UNKNOWN_CLIENT_ID),
        null,
      );
    } else if (row.stage === "token") {
      const path = oauthTokenPath(presented);
      const code = await boundRouteMintCode(harness, registered, clientId);
      response = await harness.serve(
        "POST",
        path,
        null,
        Buffer.from(boundRouteTokenForm(clientId, code).toString(), "utf8"),
      );
      unknown = await harness.serve(
        "POST",
        path,
        null,
        Buffer.from(
          boundRouteTokenForm(BOUND_ROUTE_UNKNOWN_CLIENT_ID, code).toString(),
          "utf8",
        ),
      );
    } else {
      assert.fail(`unknown bound_route stage ${JSON.stringify(row.stage)}`);
    }

    assert.equal(response.status, row.expect_status, context);
    if (row.expect_status === 200) {
      assert.ok(
        bodyString(response).includes('"access_token"'),
        `${context} must return a token`,
      );
    }
    if (row.expect_status === 302) {
      assert.notEqual(locationOf(response), "", `${context} must redirect`);
    }
    if (row.expect_status !== 400) {
      continue;
    }
    // A refusal is the same non-oracle invalid_client response an unknown client
    // gets at this very route: byte-identical body, no redirect, and no mention
    // of any route the client might have registered at.
    assert.equal(unknown.status, 400, `${context} unknown-client control`);
    assert.equal(
      bodyString(response),
      bodyString(unknown),
      `${context} must be byte-identical to the unknown-client refusal`,
    );
    assert.equal(locationOf(response), "", `${context} must not redirect`);
    assert.match(bodyString(response), /"error":"invalid_client"/, context);
    assert.ok(
      !bodyString(response).includes("route"),
      `${context} must not name a route`,
    );
  }
  assert.equal(executed, BOUND_ROUTE_CASE_COUNT);
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

  const unknown = await harness.token(harness.tokenForm("never-minted-code"));
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

test("a grant type the facade does not serve is refused", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const response = await harness.token({
    grant_type: "client_credentials",
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

// ---------------------------------------------------------------------------
// Brokered refresh grant (mirrors runtime/mcpfacade/refresh_test.go)
// ---------------------------------------------------------------------------

/** The resource the harness's authorize leg binds. */
const REFRESH_BOUND_RESOURCE = `${BASE_URL}/acme/mcp`;

/** A second registered public client, used by the other-client cases. */
const REFRESH_OTHER_CLIENT_ID = "facade-client-2";

/**
 * A refresh grant form presented by the harness's own client. `overrides` adds
 * or replaces one member, so a case can present a scope or a resource beside the
 * handle, or present as another client.
 */
function refreshForm(handle, overrides = {}) {
  return {
    grant_type: "refresh_token",
    refresh_token: handle,
    client_id: CLIENT_ID,
    ...overrides,
  };
}

/** Reads the framework handle a token response handed the client. */
function responseHandle(response) {
  const payload = JSON.parse(bodyString(response));
  assert.ok(
    typeof payload.refresh_token === "string" && payload.refresh_token !== "",
    "a token response must carry a framework handle",
  );
  return payload.refresh_token;
}

/** Reads the access token a token response returned. */
function responseAccessToken(response) {
  const payload = JSON.parse(bodyString(response));
  assert.ok(
    typeof payload.access_token === "string" && payload.access_token !== "",
    "a token response must carry an access token",
  );
  return payload.access_token;
}

/** A fresh opaque handle no broker record is keyed by. */
function unknownHandle() {
  return randomBytes(32).toString("base64url");
}

/**
 * Completes authorize, callback, and the code exchange, and returns the token
 * response plus the redeemed facade code, so a refresh test starts from a
 * genuinely minted handle.
 */
async function exchangeTheCode(harness) {
  const { code } = await harness.authorizeAndCallback();
  const response = await harness.token(harness.tokenForm(code));
  assert.equal(response.status, 200, bodyString(response));
  return { exchange: response, code };
}

/** Runs the journey through the code exchange and returns the handle it minted. */
async function mintedRefreshHandle(harness) {
  const { exchange } = await exchangeTheCode(harness);
  return responseHandle(exchange);
}

/** Reads the broker record a handle is keyed by. */
async function brokerRecord(harness, handle) {
  const record = await harness.stores.routeRefreshBroker.get(hashKey(handle));
  assert.ok(record !== null, "the broker record must exist");
  return record;
}

/** Registers the second public client the other-client cases present. */
async function registerOtherClient(harness) {
  await harness.stores.client.put({
    clientIdHash: hashKey(REFRESH_OTHER_CLIENT_ID),
    clientId: REFRESH_OTHER_CLIENT_ID,
    redirectUris: [CLIENT_REDIRECT],
    tokenEndpointAuthMethod: "none",
    grantTypes: [],
    responseTypes: [],
    boundRoute: "",
    createdAt: new Date(0),
    version: 0,
  });
}

/**
 * Pins the brokered refresh framework defaults of operator ruling R3, so a
 * change to any of them is a deliberate edit here rather than a silent behavior
 * change. The TypeScript tests are external to the runtime module, so unlike the
 * Go in-package test these pin each value at the boundary it produces rather
 * than by reading the constant.
 */
test("the brokered refresh defaults are pinned", async (t) => {
  // The handle byte bound: a 512-byte handle is read (and refused as the unknown
  // handle it is), while 513 bytes are refused as invalid_request before the
  // client is even identified.
  const bound = await newFrontChannelHarness(t);
  const atBound = await bound.token(refreshForm("a".repeat(512)));
  assert.equal(atBound.status, 400);
  assert.equal(
    JSON.parse(bodyString(atBound)).error,
    "invalid_grant",
    "a 512-byte handle must be read, not refused as malformed",
  );
  const overBound = await bound.token(refreshForm("a".repeat(513)));
  assert.equal(overBound.status, 400);
  assert.equal(JSON.parse(bodyString(overBound)).error, "invalid_request");

  // The grace window: a replayed rotation is inside the window one millisecond
  // before thirty seconds and is reuse at exactly thirty seconds.
  const grace = await newFrontChannelHarness(t);
  const handle = await mintedRefreshHandle(grace);
  const first = await grace.token(refreshForm(handle));
  assert.equal(first.status, 200);
  grace.clock.advance(30_000 - 1);
  const replayed = await grace.token(refreshForm(handle));
  assert.equal(replayed.status, 200, "29.999s must still replay the successor");
  assert.equal(bodyString(replayed), bodyString(first));
  grace.clock.advance(1);
  const reused = await grace.token(refreshForm(handle));
  assert.equal(reused.status, 400, "exactly 30s must be reuse");
  assert.equal(JSON.parse(bodyString(reused)).error, "invalid_grant");

  // The reference broker store's default lock TTL: fifteen seconds, which is
  // above the three-second coalesce wait cap a waiter is bounded by.
  const lock = await newFrontChannelHarness(t);
  const lockHandle = await mintedRefreshHandle(lock);
  const lockRecord = await brokerRecord(lock, lockHandle);
  const locked = await lock.stores.routeRefreshBroker.acquireLock(
    hashKey(lockHandle),
    "owner",
    lockRecord.version,
  );
  assert.equal(
    locked.refreshLockExpiresAt.getTime() - lock.clock.now().getTime(),
    15_000,
  );
});

/**
 * Pins the happy rotation: the refresh answers 200 with the upstream access token
 * byte-for-byte, a NEW framework handle, and no upstream refresh material and no
 * id_token, and the presented record ends up holding the successor response as
 * its grace body.
 */
test("refresh rotates the handle and hides upstream material", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const first = await mintedRefreshHandle(harness);

  const response = await harness.token(refreshForm(first));
  assert.equal(response.status, 200, bodyString(response));
  const body = bodyString(response);
  assert.ok(body.includes(`"access_token":"${REFRESH_ACCESS_TOKEN}"`), body);
  assert.ok(body.includes(`"token_type":"Bearer"`), body);
  assert.ok(body.includes(`"scope":"${ROTATED_UPSTREAM_SCOPE}"`), body);
  assert.ok(!body.includes(UPSTREAM_REFRESH_TOKEN));
  assert.ok(!body.includes(ROTATED_UPSTREAM_REFRESH_TOKEN));
  assert.ok(!body.includes(REFRESH_ID_TOKEN));
  assert.ok(!body.includes("id_token"));

  const second = responseHandle(response);
  assert.notEqual(first, second);

  const successor = await brokerRecord(harness, second);
  assert.equal(
    successor.encryptedUpstreamRefreshToken,
    ROTATED_UPSTREAM_REFRESH_TOKEN,
  );
  assert.equal(
    successor.upstreamRefreshTokenHash,
    hashKey(ROTATED_UPSTREAM_REFRESH_TOKEN),
  );
  assert.equal(successor.status, "issued");
  assert.equal(successor.clientIdHash, hashKey(CLIENT_ID));
  assert.equal(successor.upstreamClientId, CLIENT_ID);
  assert.equal(successor.canonicalResource, REFRESH_BOUND_RESOURCE);

  const presented = await brokerRecord(harness, first);
  assert.equal(presented.status, "active");
  assert.equal(presented.encryptedGraceRefreshResponse, body);
  assert.equal(
    presented.graceExpiresAt.getTime(),
    harness.clock.now().getTime() + 30_000,
  );
  assert.ok(!presented.refreshLockOwner);
  assert.equal(presented.refreshLockExpiresAt, undefined);
});

/**
 * Pins the single-flight upstream contract: the code exchange makes one token
 * call, and each rotation makes exactly one more, presenting the recorded
 * upstream material and the facade's own upstream client — never the framework
 * handle.
 */
test("refresh makes exactly one upstream call per rotation", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const handle = await mintedRefreshHandle(harness);
  assert.equal(harness.tokenCalls(), 1);
  assert.equal(harness.fake.refreshCallCount(), 0);

  const first = await harness.token(refreshForm(handle));
  assert.equal(first.status, 200, bodyString(first));
  assert.equal(harness.tokenCalls(), 2);
  assert.equal(harness.fake.refreshCallCount(), 1);

  const second = await harness.token(refreshForm(responseHandle(first)));
  assert.equal(second.status, 200, bodyString(second));
  assert.equal(harness.tokenCalls(), 3);
  assert.equal(harness.fake.refreshCallCount(), 2);

  const presented = harness.fake.lastRefreshRequest();
  assert.equal(presented.get("refresh_token"), ROTATED_UPSTREAM_REFRESH_TOKEN);
  assert.equal(presented.get("client_id"), CLIENT_ID);

  // A grace replay makes no upstream call at all, so the count above is the
  // rotation count and not a call count.
  assert.equal((await harness.token(refreshForm(handle))).status, 200);
  assert.equal(harness.tokenCalls(), 3);
  assert.equal(harness.fake.refreshCallCount(), 2);
});

/**
 * Pins the idempotent lost-response path: presenting the rotated handle again
 * from the same client returns the identical status, headers, and body bytes,
 * with no second upstream call, right up to the end of the window.
 */
test("refresh replays the same successor within the grace window", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const handle = await mintedRefreshHandle(harness);

  const first = await harness.token(refreshForm(handle));
  assert.equal(first.status, 200, bodyString(first));

  const replayed = await harness.token(refreshForm(handle));
  assert.equal(replayed.status, first.status);
  assert.equal(bodyString(replayed), bodyString(first));
  assert.deepEqual(
    firstHeader(replayed.headers, "content-type"),
    firstHeader(first.headers, "content-type"),
  );
  assert.deepEqual(
    firstHeader(replayed.headers, "cache-control"),
    firstHeader(first.headers, "cache-control"),
  );
  assert.deepEqual(
    firstHeader(replayed.headers, "pragma"),
    firstHeader(first.headers, "pragma"),
  );
  assert.equal(harness.fake.refreshCallCount(), 1);

  harness.clock.advance(30_000 - 1_000);
  const justInside = await harness.token(refreshForm(handle));
  assert.equal(justInside.status, 200);
  assert.equal(bodyString(justInside), bodyString(first));
  assert.equal(harness.fake.refreshCallCount(), 1);
});

/**
 * Pins reuse: presenting the rotated handle once the window has passed is refused
 * with invalid_grant, the presented record is revoked, and the walk revokes the
 * successor the rotation minted, so the successor handle is refused too.
 */
test("refresh after the grace window revokes the successor", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const handle = await mintedRefreshHandle(harness);

  const rotated = await harness.token(refreshForm(handle));
  assert.equal(rotated.status, 200, bodyString(rotated));
  const successor = responseHandle(rotated);
  assert.equal(harness.fake.refreshCallCount(), 1);

  harness.clock.advance(30_000 + 1_000);
  const reused = await harness.token(refreshForm(handle));
  assert.equal(reused.status, 400);
  assert.match(bodyString(reused), /"error":"invalid_grant"/);

  assert.equal((await brokerRecord(harness, handle)).status, "revoked");
  assert.equal((await brokerRecord(harness, successor)).status, "revoked");

  const after = await harness.token(refreshForm(successor));
  assert.equal(after.status, 400);
  assert.match(bodyString(after), /"error":"invalid_grant"/);
  assert.equal(harness.fake.refreshCallCount(), 1);
});

/**
 * Pins the no-oracle rule: an unknown handle, a revoked handle, and a handle
 * presented by another registered client are one byte-identical invalid_grant
 * response. This is the Go test's own shape (three harnesses), and the
 * wrong-route case below proves the same identity against a route-mismatched
 * handle.
 */
test("refresh refusals are one invalid_grant body", async (t) => {
  const unknownHarness = await newFrontChannelHarness(t);
  const unknown = await unknownHarness.token(refreshForm(unknownHandle()));
  assert.equal(unknown.status, 400);

  const revokedHarness = await newFrontChannelHarness(t);
  const revokedHandle = await mintedRefreshHandle(revokedHarness);
  await revokedHarness.stores.routeRefreshBroker.revoke(hashKey(revokedHandle));
  const revoked = await revokedHarness.token(refreshForm(revokedHandle));
  assert.equal(revoked.status, 400);

  const otherHarness = await newFrontChannelHarness(t);
  const otherHandle = await mintedRefreshHandle(otherHarness);
  await registerOtherClient(otherHarness);
  const other = await otherHarness.token(
    refreshForm(otherHandle, { client_id: REFRESH_OTHER_CLIENT_ID }),
  );
  assert.equal(other.status, 400);

  const refusals = [unknown, revoked, other];
  for (const [index, response] of refusals.entries()) {
    assert.equal(response.status, 400, `refusal ${index}`);
    assert.match(bodyString(response), /"error":"invalid_grant"/, `refusal ${index}`);
    assert.equal(
      bodyString(response),
      bodyString(unknown),
      `refusal ${index} must be byte-identical`,
    );
  }
});

/**
 * Pins the route binding of the broker record (DESIGN §7: the record binds the
 * resource) against the real handlers, and pins that closing it does not open a
 * handle-existence oracle: a handle minted at one route and presented at another
 * route's token endpoint is refused with the SAME byte-identical invalid_grant an
 * unknown handle gets, while the very same handle is still redeemable at the route
 * it was minted for, and the tracked upstream refresh count proves the
 * wrong-route attempt never reached the upstream.
 */
test("refresh refuses a handle at another route", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const handle = await mintedRefreshHandle(harness);

  const unknownResponse = await harness.token(refreshForm(unknownHandle()));
  assert.equal(unknownResponse.status, 400);

  const otherRoute = boundRouteEndpoint("agent");
  const before = harness.fake.refreshCallCount();
  const wrongRoute = await harness.serve(
    "POST",
    oauthTokenPath(otherRoute),
    null,
    Buffer.from(new URLSearchParams(refreshForm(handle)).toString(), "utf8"),
  );
  assert.equal(wrongRoute.status, 400);
  assert.match(bodyString(wrongRoute), /"error":"invalid_grant"/);
  assert.equal(
    bodyString(wrongRoute),
    bodyString(unknownResponse),
    "a wrong-route handle must be the byte-identical unknown-handle refusal",
  );
  assert.equal(
    harness.fake.refreshCallCount(),
    before,
    "a wrong-route handle must not reach the upstream",
  );

  const ownRoute = await harness.token(refreshForm(handle));
  assert.equal(ownRoute.status, 200, bodyString(ownRoute));
  assert.equal(
    harness.fake.refreshCallCount(),
    before + 1,
    "the same handle must still be redeemable at the route it was minted for",
  );
});

/**
 * Pins ruling R4: an absent scope or resource takes the recorded value, an
 * exactly equal one is accepted, a subset (which the empty member expresses,
 * because the granted set has one member) and a wider set are invalid_scope, and
 * a mismatched resource is invalid_target.
 */
test("refresh binds scope and resource", async (t) => {
  const cases = [
    { name: "absent_scope_and_resource_take_the_granted_values", overrides: {} },
    {
      name: "exact_scope_and_resource_are_accepted",
      overrides: { scope: ROTATED_UPSTREAM_SCOPE, resource: REFRESH_BOUND_RESOURCE },
    },
    { name: "subset_scope_is_refused", overrides: { scope: "" }, error: "invalid_scope" },
    {
      name: "wider_scope_is_refused",
      overrides: { scope: `${ROTATED_UPSTREAM_SCOPE} extra:scope` },
      error: "invalid_scope",
    },
    {
      name: "mismatched_resource_is_refused",
      overrides: { resource: `${BASE_URL}/other/mcp` },
      error: "invalid_target",
    },
  ];

  for (const testCase of cases) {
    const harness = await newFrontChannelHarness(t);
    const handle = await mintedRefreshHandle(harness);
    const response = await harness.token(refreshForm(handle, testCase.overrides));
    const context = `refresh binding ${testCase.name}`;
    if (testCase.error === undefined) {
      assert.equal(response.status, 200, `${context}: ${bodyString(response)}`);
      assert.ok(
        bodyString(response).includes(`"access_token":"${REFRESH_ACCESS_TOKEN}"`),
        context,
      );
      assert.equal(harness.fake.refreshCallCount(), 1, context);
      continue;
    }
    assert.equal(response.status, 400, `${context}: ${bodyString(response)}`);
    assert.match(bodyString(response), new RegExp(`"error":"${testCase.error}"`), context);
    // A refused request never reached the upstream, and the handle was not
    // rotated by it.
    assert.equal(harness.fake.refreshCallCount(), 0, context);
    assert.equal((await brokerRecord(harness, handle)).status, "issued", context);
  }
});

/**
 * Pins the bound and the validation order of ruling R1: a missing, blank, or
 * oversized handle is invalid_request before the client is even identified, while
 * a well-formed handle with no client id is the client check's own
 * invalid_client.
 */
test("refresh bounds the presented handle", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const oversized = "a".repeat(512 + 1);

  const tooLong = await harness.token(refreshForm(oversized));
  assert.equal(tooLong.status, 400);
  assert.match(bodyString(tooLong), /"error":"invalid_request"/);

  const missing = await harness.token({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
  });
  assert.equal(missing.status, 400);
  assert.equal(bodyString(missing), bodyString(tooLong));

  const blank = await harness.token(refreshForm(""));
  assert.equal(blank.status, 400);
  assert.equal(bodyString(blank), bodyString(tooLong));

  // The bound is checked before the client lookup, so an oversized handle with
  // no client at all is still invalid_request ...
  const noClient = await harness.token({
    grant_type: "refresh_token",
    refresh_token: oversized,
  });
  assert.equal(noClient.status, 400);
  assert.match(bodyString(noClient), /"error":"invalid_request"/);

  // ... while a well-formed handle and no client is the client refusal.
  const unidentified = await harness.token({
    grant_type: "refresh_token",
    refresh_token: "a".repeat(43),
  });
  assert.equal(unidentified.status, 400);
  assert.match(bodyString(unidentified), /"error":"invalid_client"/);

  assert.equal(harness.fake.refreshCallCount(), 0);
});

/**
 * Pins journey step 9.1 / T2 against the refresh grant: once the authorization
 * code is replayed, the broker record the code minted is revoked, so the handle
 * it had already rotated into the client's hands is refused.
 */
test("refresh refuses a handle whose code was replayed", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const { exchange, code } = await exchangeTheCode(harness);
  const handle = responseHandle(exchange);

  const rotated = await harness.token(refreshForm(handle));
  assert.equal(rotated.status, 200, bodyString(rotated));

  const replay = await harness.token(harness.tokenForm(code));
  assert.equal(replay.status, 400);
  assert.match(bodyString(replay), /"error":"invalid_grant"/);

  assert.equal((await brokerRecord(harness, handle)).status, "revoked");

  const after = await harness.token(refreshForm(handle));
  assert.equal(after.status, 400);
  assert.match(bodyString(after), /"error":"invalid_grant"/);
  assert.equal(harness.fake.refreshCallCount(), 1);
});

/**
 * Pins single-flight under concurrency: sixteen simultaneous presentations of one
 * handle produce exactly one upstream refresh call, and every caller receives the
 * same successor body bytes — the winner's response or the grace replay of it.
 */
test("refresh concurrent callers receive one successor", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const handle = await mintedRefreshHandle(harness);
  const form = refreshForm(handle);

  const callers = 16;
  const responses = await Promise.all(
    Array.from({ length: callers }, () => harness.token(form)),
  );

  assert.equal(harness.fake.refreshCallCount(), 1);
  const bodies = responses.map((response) => bodyString(response));
  for (const [index, response] of responses.entries()) {
    assert.equal(response.status, 200, `caller ${index} body ${bodies[index]}`);
    assert.equal(
      bodies[index],
      bodies[0],
      `caller ${index} must receive the winner's successor body`,
    );
  }
  assert.ok(bodies[0].includes(`"access_token":"${REFRESH_ACCESS_TOKEN}"`));
  // The successor handle the callers were all served is a framework handle, not
  // the handle they presented.
  assert.notEqual(responseHandle(responses[0]), handle);
});

/**
 * Pins that reuse detection is safe under concurrency: once the grace window has
 * passed, every concurrent presenter of the rotated handle is refused with
 * invalid_grant, no upstream call is made, and the whole grant — the presented
 * record and the successor it names — ends revoked. Revocation is idempotent, so
 * more than one caller may perform it; the contract is that no caller is served
 * and no caller can act on unrevoked state.
 */
test("refresh concurrent reuse after grace revokes once", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const handle = await mintedRefreshHandle(harness);
  const rotated = await harness.token(refreshForm(handle));
  assert.equal(rotated.status, 200, bodyString(rotated));
  const successor = responseHandle(rotated);
  harness.clock.advance(30_000 + 1_000);

  const callers = 16;
  const responses = await Promise.all(
    Array.from({ length: callers }, () => harness.token(refreshForm(handle))),
  );

  const bodies = responses.map((response) => bodyString(response));
  for (const [index, response] of responses.entries()) {
    assert.equal(response.status, 400, `caller ${index} body ${bodies[index]}`);
    assert.match(bodies[index], /"error":"invalid_grant"/, `caller ${index}`);
    assert.equal(bodies[index], bodies[0], `caller ${index} must receive the same refusal`);
  }
  assert.equal(harness.fake.refreshCallCount(), 1);
  assert.equal((await brokerRecord(harness, handle)).status, "revoked");
  assert.equal((await brokerRecord(harness, successor)).status, "revoked");
});

/**
 * Pins the reuse-detection revoke walk of ruling R1.4 and its bounded limit: the
 * walk revokes the presented record and then follows the successor handle each
 * revoked record names, stopping at the limit so a crafted or cyclic stored value
 * can never loop. A ten-link chain seeded by hand therefore ends with exactly the
 * first eight links revoked.
 */
test("refresh reuse revokes the grant up to the bounded walk limit", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const handles = Array.from({ length: 10 }, () => unknownHandle());
  for (const [index, handle] of handles.entries()) {
    const successor = handles[index + 1];
    await harness.stores.routeRefreshBroker.put({
      handleHash: hashKey(handle),
      issuer: UPSTREAM_ISS,
      stage: "",
      canonicalResource: REFRESH_BOUND_RESOURCE,
      clientNamespace: "acme",
      endpointKind: "namespace",
      partnerId: "",
      agentId: "",
      clientIdHash: hashKey(CLIENT_ID),
      subjectIdHash: hashKey("user-1"),
      scopes: [ROTATED_UPSTREAM_SCOPE],
      scopeFingerprint: hashKey(ROTATED_UPSTREAM_SCOPE),
      encryptedUpstreamRefreshToken: UPSTREAM_REFRESH_TOKEN,
      upstreamRefreshTokenHash: hashKey(UPSTREAM_REFRESH_TOKEN),
      upstreamClientId: CLIENT_ID,
      // Every record claims a grace window that closed long ago, so presenting
      // the first is reuse, and each names the next link as its successor.
      encryptedGraceRefreshResponse:
        successor === undefined
          ? ""
          : JSON.stringify({ refresh_token: successor }),
      graceExpiresAt: new Date(0),
      status: "issued",
      version: 0,
    });
  }

  const reused = await harness.token(refreshForm(handles[0]));
  assert.equal(reused.status, 400);
  assert.match(bodyString(reused), /"error":"invalid_grant"/);
  assert.equal(harness.fake.refreshCallCount(), 0);

  for (const [index, handle] of handles.entries()) {
    const record = await brokerRecord(harness, handle);
    const expected = index < 8 ? "revoked" : "issued";
    assert.equal(record.status, expected, `chain link ${index}`);
  }
});

/**
 * Pins the coalesce wait cap: a caller that cannot take a lock another caller
 * holds answers 503 temporarily_unavailable with a Retry-After, makes no upstream
 * call, and waits the whole cap first. This test takes about three seconds,
 * because the cap is real elapsed time and the point is that the caller waits it
 * rather than sampling less than it.
 */
test("refresh lock contention answers retryable", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const handle = await mintedRefreshHandle(harness);
  const record = await brokerRecord(harness, handle);
  const locked = await harness.stores.routeRefreshBroker.acquireLock(
    hashKey(handle),
    "test-holder",
    record.version,
  );
  assert.equal(locked.status, "refreshing");

  const start = Date.now();
  const response = await harness.token(refreshForm(handle));
  const elapsed = Date.now() - start;

  assert.equal(response.status, 503, bodyString(response));
  assert.match(bodyString(response), /"error":"temporarily_unavailable"/);
  const retryAfter = firstHeader(response.headers, "retry-after");
  assert.notEqual(retryAfter, undefined);
  assert.ok(Number.parseInt(retryAfter, 10) >= 1);
  assert.ok(elapsed >= 3_000, `waited ${elapsed}ms, must wait the whole cap`);
  assert.ok(elapsed < 33_000, `waited ${elapsed}ms`);
  assert.equal(harness.fake.refreshCallCount(), 0);

  // The caller that holds the lock is untouched by the waiter.
  const held = await brokerRecord(harness, handle);
  assert.equal(held.refreshLockOwner, "test-holder");
});

/**
 * Pins ADV-1146-3: a lock acquisition that fails with a version conflict is
 * retried until the coalesce cap, and every retry waits one poll interval first.
 * A store that keeps returning a stale version would otherwise re-poll in a tight
 * spin for the whole cap. With the 50 ms poll interval the loop takes about
 * cap/interval ≈ 60 iterations over three seconds, so a bounded iteration count
 * and the measured gap between attempts are what prove the wait rather than a
 * spin, and they pin the interval: removing the poll sleep makes the count jump
 * by orders of magnitude (and the gaps vanish), a drifted-down interval shows as
 * too-short a gap, and a drifted-up one as too long a fastest gap. The constant
 * is module-private, so this behavioral numeric pin is TypeScript's counterpart
 * of the exact-value pins Go and Python assert directly.
 */
test("refresh version conflict retry yields", async (t) => {
  const harness = await newFrontChannelHarness(t);
  const handle = await mintedRefreshHandle(harness);

  const attempts = [];
  harness.stores.routeRefreshBroker.acquireLock = () => {
    attempts.push(Date.now());
    return Promise.reject(new BrokerVersionConflictError());
  };

  const start = Date.now();
  const response = await harness.token(refreshForm(handle));
  const elapsed = Date.now() - start;

  assert.equal(response.status, 503, bodyString(response));
  assert.match(bodyString(response), /"error":"temporarily_unavailable"/);
  assert.ok(elapsed >= 3_000, `waited ${elapsed}ms, must wait the whole cap`);
  assert.equal(harness.fake.refreshCallCount(), 0);

  // cap/interval = 3 000 / 50 = 60. A spin reaches this count in microseconds and
  // would be orders of magnitude larger, so the upper bound is the mutation
  // tripwire.
  assert.ok(attempts.length >= 5, `attempts ${attempts.length}`);
  assert.ok(attempts.length <= 100, `attempts ${attempts.length}`);
  const gaps = attempts.slice(1).map((at, index) => at - attempts[index]);
  assert.ok(gaps.length > 0, "the loop must re-poll at least once");
  // Date.now() is millisecond-granular and a timer may land a millisecond under
  // its delay (CI has observed 49ms for a 50ms sleep), so the lower bound carries
  // a small tolerance; a spin is ~0ms. The fastest gap pins the interval from
  // above, so a constant drifted up also fails.
  for (const gap of gaps) {
    assert.ok(
      gap >= 40,
      `every version-conflict re-poll must wait about the 50 ms poll interval, saw ${gap}ms`,
    );
  }
  const fastestGap = Math.min(...gaps);
  assert.ok(
    fastestGap <= 120,
    `the poll interval must be about 50 ms, saw a fastest gap of ${fastestGap}ms`,
  );
});

/**
 * Pins the terminal provider failure: the recorded upstream material is dead, so
 * the facade answers invalid_grant and revokes the presented record, and a later
 * attempt never reaches the upstream again.
 */
test("refresh terminal upstream failure revokes", async (t) => {
  const harness = await newFrontChannelHarness(t, {
    providerOptions: (options) => {
      options.refreshTokenStatus = 400;
      options.refreshTokenBody = { error: "invalid_grant" };
    },
  });
  const handle = await mintedRefreshHandle(harness);

  const response = await harness.token(refreshForm(handle));
  assert.equal(response.status, 400, bodyString(response));
  assert.match(bodyString(response), /"error":"invalid_grant"/);
  assert.equal(harness.fake.refreshCallCount(), 1);
  assert.equal((await brokerRecord(harness, handle)).status, "revoked");

  const after = await harness.token(refreshForm(handle));
  assert.equal(after.status, 400);
  assert.match(bodyString(after), /"error":"invalid_grant"/);
  assert.equal(harness.fake.refreshCallCount(), 1);
});

/**
 * Pins the transient provider failure: the facade answers 503
 * temporarily_unavailable with a Retry-After, releases the lock and restores the
 * record's status, and does not revoke the grant, so the very next attempt
 * reaches the upstream again and rotates.
 */
test("refresh transient upstream failure keeps the handle", async (t) => {
  const harness = await newFrontChannelHarness(t, {
    providerOptions: (options) => {
      options.refreshTokenStages = [
        { status: 503, body: { error: "temporarily_unavailable" } },
      ];
    },
  });
  const handle = await mintedRefreshHandle(harness);

  const failed = await harness.token(refreshForm(handle));
  assert.equal(failed.status, 503, bodyString(failed));
  assert.match(bodyString(failed), /"error":"temporarily_unavailable"/);
  assert.deepEqual(firstHeader(failed.headers, "retry-after"), "1");
  assert.equal(harness.fake.refreshCallCount(), 1);

  const released = await brokerRecord(harness, handle);
  assert.equal(released.status, "issued");
  assert.ok(!released.refreshLockOwner);
  assert.equal(released.refreshLockExpiresAt, undefined);

  const recovered = await harness.token(refreshForm(handle));
  assert.equal(recovered.status, 200, bodyString(recovered));
  assert.ok(bodyString(recovered).includes(`"access_token":"${REFRESH_ACCESS_TOKEN}"`));
  assert.notEqual(responseHandle(recovered), handle);
  assert.equal(harness.fake.refreshCallCount(), 2);
  assert.equal((await brokerRecord(harness, handle)).status, "active");
});

/**
 * Scans every response and every client-presented form of a whole refresh journey
 * against the upstream material the fake served: the upstream refresh tokens, the
 * upstream id_token, the PKCE verifier, the upstream code, and the client state
 * never appear anywhere, the upstream access tokens appear only in the responses
 * that deliberately return them to their owner, and the facade code appears only
 * in the callback that delivers it.
 */
test("refresh responses never carry upstream material", async (t) => {
  const harness = await newFrontChannelHarness(t);

  const authorize = await harness.authorize(undefined);
  assert.equal(authorize.status, 302);
  const callback = await harness.serve(
    "GET",
    DEFAULT_CALLBACK_PATH,
    {
      code: [UPSTREAM_CODE],
      state: [locationQuery(authorize).get("state")],
      iss: [UPSTREAM_ISS],
    },
    null,
  );
  assert.equal(callback.status, 302);
  const code = locationQuery(callback).get("code");
  assert.ok(code !== null && code !== "");

  const exchangeForm = harness.tokenForm(code);
  const exchange = await harness.token(exchangeForm);
  assert.equal(exchange.status, 200, bodyString(exchange));
  const handle = responseHandle(exchange);

  const rotated = await harness.token(refreshForm(handle));
  assert.equal(rotated.status, 200, bodyString(rotated));
  const grace = await harness.token(refreshForm(handle));
  const scopeRefused = await harness.token(
    refreshForm(handle, { scope: `${ROTATED_UPSTREAM_SCOPE} extra:scope` }),
  );
  const resourceRefused = await harness.token(
    refreshForm(handle, { resource: `${BASE_URL}/other/mcp` }),
  );
  const oversized = await harness.token(refreshForm("a".repeat(512 + 1)));

  // The two access tokens the design delivers, and the only responses allowed to
  // carry each one.
  const exchangedToken = responseAccessToken(exchange);
  const rotatedToken = responseAccessToken(rotated);
  const delivered = new Map([
    [exchangedToken, new Set(["code_exchange"])],
    [rotatedToken, new Set(["refresh", "grace_replay"])],
  ]);

  const responses = [
    { name: "authorize", response: authorize, codeOK: false, stateOK: false },
    { name: "callback", response: callback, codeOK: true, stateOK: true },
    { name: "code_exchange", response: exchange, codeOK: false, stateOK: false },
    { name: "refresh", response: rotated, codeOK: false, stateOK: false },
    { name: "grace_replay", response: grace, codeOK: false, stateOK: false },
    { name: "scope_refused", response: scopeRefused, codeOK: false, stateOK: false },
    {
      name: "resource_refused",
      response: resourceRefused,
      codeOK: false,
      stateOK: false,
    },
    { name: "oversized_handle", response: oversized, codeOK: false, stateOK: false },
  ];

  const secrets = [
    UPSTREAM_REFRESH_TOKEN,
    ROTATED_UPSTREAM_REFRESH_TOKEN,
    REFRESH_ID_TOKEN,
    "id_token",
    VERIFIER,
    UPSTREAM_CODE,
  ];
  for (const entry of responses) {
    const scanned = responseScan(entry.response);
    for (const secret of secrets) {
      assert.ok(
        !scanned.includes(secret),
        `${entry.name} response must not carry ${JSON.stringify(secret)}`,
      );
    }
    // The client's own state is returned to it by the callback that receives it
    // and by nothing else.
    if (!entry.stateOK) {
      assert.ok(
        !scanned.includes(CLIENT_STATE),
        `${entry.name} response must not carry the client state`,
      );
    }
    if (!entry.codeOK) {
      assert.ok(!scanned.includes(code), `${entry.name} response must not carry the facade code`);
    }
    for (const [token, names] of delivered) {
      if (names.has(entry.name)) continue;
      assert.ok(
        !scanned.includes(token),
        `${entry.name} response must not carry an access token delivered elsewhere`,
      );
    }
  }
  assert.ok(responseScan(exchange).includes(exchangedToken));
  assert.ok(responseScan(rotated).includes(rotatedToken));
  assert.ok(responseScan(grace).includes(rotatedToken));

  // The client-presented forms carry the framework handle and nothing upstream.
  const forms = [
    exchangeForm,
    refreshForm(handle),
    refreshForm(responseHandle(rotated)),
  ];
  for (const form of forms) {
    const encoded = new URLSearchParams(form).toString();
    assert.ok(!encoded.includes(UPSTREAM_REFRESH_TOKEN));
    assert.ok(!encoded.includes(ROTATED_UPSTREAM_REFRESH_TOKEN));
    assert.ok(!encoded.includes(REFRESH_ID_TOKEN));
    assert.ok(!encoded.includes(REFRESH_ACCESS_TOKEN));
  }

  // Positive control: the one form that must carry the upstream material — the
  // facade's own upstream refresh call — does, with the facade's own upstream
  // client, and never the framework handle the client presented.
  const upstreamForm = harness.fake.lastRefreshRequest();
  assert.equal(upstreamForm.get("refresh_token"), UPSTREAM_REFRESH_TOKEN);
  assert.equal(upstreamForm.get("client_id"), CLIENT_ID);
  assert.notEqual(upstreamForm.get("refresh_token"), handle);
});

const REFRESH_GROUP = "refresh";

/**
 * The number of refresh rows the shared table must carry; a change to the table
 * must also be a deliberate edit in the Go, TypeScript, and Python loaders, so no
 * runtime can silently execute a smaller table.
 */
const REFRESH_CASE_COUNT = 15;

/**
 * Stages the fake upstream a refresh row's scenario needs. Only the two
 * upstream-failure scenarios need anything but the default fake.
 */
function refreshScenarioProviderOptions(scenario) {
  switch (scenario) {
    case "upstream_terminal_failure":
      return (options) => {
        options.refreshTokenStatus = 400;
        options.refreshTokenBody = { error: "invalid_grant" };
      };
    case "upstream_transient_failure":
      return (options) => {
        options.refreshTokenStatus = 503;
        options.refreshTokenBody = { error: "temporarily_unavailable" };
      };
    default:
      return () => {};
  }
}

/**
 * Performs the common setup (authorize, callback, code exchange → a genuinely
 * minted handle) and then the row's scenario, returning the response the row's
 * expectation applies to.
 */
async function refreshScenarioResponse(harness, scenario) {
  const { exchange, code } = await exchangeTheCode(harness);
  const handle = responseHandle(exchange);

  switch (scenario) {
    case "happy_rotation":
      return await harness.token(refreshForm(handle));
    case "reuse_within_grace_returns_same_tokens": {
      const first = await harness.token(refreshForm(handle));
      assert.equal(first.status, 200);
      const replayed = await harness.token(refreshForm(handle));
      assert.equal(
        bodyString(replayed),
        bodyString(first),
        "the grace replay must be byte-identical",
      );
      return replayed;
    }
    case "reuse_after_grace_revokes":
      assert.equal((await harness.token(refreshForm(handle))).status, 200);
      harness.clock.advance(30_000 + 1_000);
      return await harness.token(refreshForm(handle));
    case "unknown_handle":
      return await harness.token(refreshForm(unknownHandle()));
    case "other_client_handle":
      await registerOtherClient(harness);
      return await harness.token(
        refreshForm(handle, { client_id: REFRESH_OTHER_CLIENT_ID }),
      );
    case "handle_at_another_route_refused":
      return await harness.serve(
        "POST",
        oauthTokenPath(boundRouteEndpoint("agent")),
        null,
        Buffer.from(new URLSearchParams(refreshForm(handle)).toString(), "utf8"),
      );
    case "scope_subset_refused":
      return await harness.token(refreshForm(handle, { scope: "" }));
    case "scope_exact_accepted":
      return await harness.token(
        refreshForm(handle, { scope: ROTATED_UPSTREAM_SCOPE }),
      );
    case "resource_mismatch_refused":
      return await harness.token(
        refreshForm(handle, { resource: `${BASE_URL}/other/mcp` }),
      );
    case "resource_exact_accepted":
      return await harness.token(
        refreshForm(handle, { resource: REFRESH_BOUND_RESOURCE }),
      );
    case "oversized_handle_refused":
      return await harness.token(refreshForm("a".repeat(512 + 1)));
    case "missing_handle_refused":
      return await harness.token({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
      });
    case "replayed_code_revokes_handle":
      assert.equal((await harness.token(refreshForm(handle))).status, 200);
      assert.equal((await harness.token(harness.tokenForm(code))).status, 400);
      return await harness.token(refreshForm(handle));
    case "upstream_terminal_failure":
    case "upstream_transient_failure":
      return await harness.token(refreshForm(handle));
    default:
      return assert.fail(`unknown refresh scenario ${JSON.stringify(scenario)}`);
  }
}

/**
 * Pins the brokered refresh grant to the shared cross-runtime table through the
 * real token handler. Every row runs against a fresh mounted app and starts from
 * the same setup — authorize, callback, and the code exchange — so each row
 * presents a genuinely minted route handle rather than a seeded record.
 */
test("refresh enforces the shared refresh table through the real handlers", async (t) => {
  const rows = (loadFixture().cases ?? []).filter(
    (row) => row.group === REFRESH_GROUP,
  );
  assert.equal(rows.length, REFRESH_CASE_COUNT);

  let executed = 0;
  for (const row of rows) {
    executed += 1;
    const harness = await newFrontChannelHarness(t, {
      providerOptions: refreshScenarioProviderOptions(row.scenario),
    });
    const response = await refreshScenarioResponse(harness, row.scenario);
    const context = `row ${row.id}`;

    assert.equal(response.status, row.expect_status, `${context} body ${bodyString(response)}`);
    if (row.expect_error !== undefined && row.expect_error !== "") {
      assert.match(
        bodyString(response),
        new RegExp(`"error":"${row.expect_error}"`),
        context,
      );
    }
    if (row.expect_retry_after === true) {
      const value = firstHeader(response.headers, "retry-after");
      assert.notEqual(value, undefined, `${context} must carry a Retry-After header`);
      assert.ok(
        Number.parseInt(value, 10) >= 1,
        `${context} must not ask for a retry sooner than one second`,
      );
    }
    const scanned = responseScan(response);
    for (const absent of row.expect_absent ?? []) {
      assert.ok(!scanned.includes(absent), `${context} must not carry ${JSON.stringify(absent)}`);
    }
  }
  assert.equal(executed, REFRESH_CASE_COUNT);
});
