// ---------------------------------------------------------------------------
// Shared front-channel harness
//
// The deterministic fake-upstream world every MCP facade test starts from: the
// fake OAuth provider and its loopback bridge, the reference stores, the facade
// config that composes them, and the request helpers that drive the mounted
// surface. It lives here so the plain-App and SecureApp suites start from one
// world definition rather than two that could drift.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  DEFAULT_CALLBACK_PATH,
  createApp,
  hashKey,
  oauthAuthorizePath,
  oauthRegisterPath,
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

export const BASE_URL = "https://mcp.example.com";
export const UPSTREAM_ISS = "https://id.example.com";
export const CLIENT_ID = "facade-client-1";
export const CLIENT_REDIRECT = "https://client.example/callback";
export const UPSTREAM_CODE = "upstream-authorization-code";
export const UPSTREAM_REFRESH_TOKEN = "upstream-refresh-token-value";
export const CLIENT_STATE = "client-state-1";
export const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU";

// The refresh grant's own upstream material. The fake serves these only for
// grant_type=refresh_token, so a refresh that returned upstream material
// instead of a framework handle is distinguishable from the code exchange, and a
// response that leaked either value is observable.
export const ROTATED_UPSTREAM_REFRESH_TOKEN = "upstream-refresh-token-rotated";
export const REFRESH_ACCESS_TOKEN = "upstream-rotated-access-token";
export const REFRESH_ID_TOKEN = "upstream-id-token-must-not-surface";
export const ROTATED_UPSTREAM_SCOPE = "mcp:tools";

export function noContent() {
  return {
    status: 204,
    headers: {},
    cookies: [],
    body: Buffer.alloc(0),
    isBase64: false,
  };
}

export function locationOf(response) {
  const values = response.headers["location"];
  return values === undefined || values.length === 0 ? "" : values[0];
}

export function locationQuery(response) {
  const location = locationOf(response);
  if (location === "") {
    return new URLSearchParams();
  }
  return new URL(location).searchParams;
}

export function bodyString(response) {
  return Buffer.from(response.body).toString("utf8");
}

export function firstHeader(headers, name) {
  const key = name.toLowerCase();
  for (const [rawKey, values] of Object.entries(headers ?? {})) {
    if (rawKey.toLowerCase() === key) {
      return values[0];
    }
  }
  return undefined;
}

export function responseScan(response) {
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
  constructor(adapter, fake, claims, failAuthorizationUrl = false) {
    this.adapter = adapter;
    this.fake = fake;
    this.claims = claims;
    this.failAuthorizationUrl = failAuthorizationUrl;
  }

  discovery() {
    return this.adapter.discovery();
  }

  authorizationUrl(req) {
    if (this.failAuthorizationUrl) {
      throw new Error("minting provider: authorization URL unavailable");
    }
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

  // The family capabilities are forwarded so a suite sees the reference
  // store's real transactional behavior and lifetime report through the
  // decorator.
  listFamily(familyHash) {
    return this.inner.listFamily(familyHash);
  }

  revokeFamily(familyHash) {
    return this.inner.revokeFamily(familyHash);
  }

  createFamily(root) {
    this.handles.push(root.handleHash);
    return this.inner.createFamily(root);
  }

  rotateFamily(rotation) {
    return this.inner.rotateFamily(rotation);
  }

  routeRefreshBrokerHandleTTLSeconds() {
    return this.inner.routeRefreshBrokerHandleTTLSeconds();
  }

  handleHashes() {
    return [...this.handles];
  }
}

/**
 * Tunes the harness a test starts. Omitting the options is the default harness
 * every front-channel test uses.
 */
export function frontChannelHarnessOptions(overrides = {}) {
  return {
    // Mutates the fake upstream's options before it starts, so a test can serve
    // a grant-specific or failing token response.
    providerOptions: overrides.providerOptions ?? (() => {}),
    // Tune the facade the harness registers. The default issuer mode is the
    // route mode every front-channel test uses.
    issuerMode: overrides.issuerMode ?? "route",
    registrationEndpointURL: overrides.registrationEndpointURL ?? null,
    // Installs the front channel's app-supplied provider-hint seam when set, so
    // a test can drive a failing providerHints.
    providerHints: overrides.providerHints ?? null,
    // Makes the upstream provider's authorizationUrl builder fail, so a test can
    // drive the authorize leg's provider-call failure class.
    failAuthorizationUrl: overrides.failAuthorizationUrl ?? false,
    // Selects the transport posture the harness registers. The journey loader
    // selects runtime-bearer so its transport rows exercise the real RFC 9728
    // middleware; the default stays the IAM posture every front-channel test
    // uses.
    transportPosture: overrides.transportPosture ?? "iam",
    // Maps the started fake and its bridge to the transport claims validator, so
    // a validator can read the fake's key set and loopback rewrites.
    requireBearerTokenFor: overrides.requireBearerTokenFor ?? null,
    // Replaces the harness's default 204 MCP handler; a suite whose transport row
    // pins a body (the SecureApp seam's journey answers 200) supplies its own.
    mcpHandler: overrides.mcpHandler ?? null,
    // Counts every MCP handler invocation, so a transport row can pin
    // handler_invocations.
    mcpInvocations: overrides.mcpInvocations ?? null,
    // Optional extra facade config fields, so a suite can describe a world the
    // base options do not reach (for example a root discovery document).
    configExtra: overrides.configExtra ?? null,
    // The route refresh policy. The default handle lifetime matches the
    // reference broker store's 900-second default, so registration's
    // TTL-reporter agreement check holds, and the default ceiling is the
    // framework floor.
    routeRefreshPolicy: overrides.routeRefreshPolicy ?? {
      handleTTLSeconds: 900,
      reuseRateCeiling: 9,
    },
    // Receives every route refresh event the facade emits.
    routeRefreshEvents: overrides.routeRefreshEvents ?? null,
    // The reference broker store's handle lifetime, which must match the
    // policy's handle TTL.
    brokerTtlSeconds: overrides.brokerTtlSeconds ?? 900,
  };
}

/**
 * Starts the world a harness mounts: the fake upstream and its bridge, the
 * reference stores, the facade config that composes them, and the started
 * provider. It registers no route, so the plain-App and SecureApp harnesses can
 * each mount the same world on their own surface.
 */
export async function startFrontChannelWorld(t, overrides = {}) {
  const options = frontChannelHarnessOptions(overrides);
  const clock = new ManualClock(new Date("2026-01-01T00:00:00Z"));
  const now = () => clock.now();
  const handles = [];
  const broker = new RecordingBrokerStore(
    new MemoryRouteRefreshBrokerStore({
      now,
      ttlSeconds: options.brokerTtlSeconds,
    }),
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
  const provider = new MintingProvider(
    adapter,
    fake,
    {
      issuer: UPSTREAM_ISS,
      audience: `${BASE_URL}/acme/mcp`,
      authorizedParty: CLIENT_ID,
      subject: "user-1",
      scope: "mcp:tools",
      expiresInSeconds: 900,
    },
    options.failAuthorizationUrl,
  );

  const kind = "namespace";
  const endpoint = { kind, clientNamespace: "acme" };
  const invocationCounter = options.mcpInvocations;
  const baseMcpHandler = options.mcpHandler ?? (() => noContent());
  const mcpHandler = invocationCounter
    ? (ctx) => {
        invocationCounter.count += 1;
        return baseMcpHandler(ctx);
      }
    : baseMcpHandler;
  const config = {
    issuerURL: `${BASE_URL}/acme/mcp`,
    jwksURI: `${UPSTREAM_ISS}/.well-known/jwks.json`,
    issuerMode: options.issuerMode,
    urlMode: "public_base_url",
    publicBaseURL: BASE_URL,
    transportPosture: options.transportPosture,
    scopes: {
      namespace: ["mcp:tools"],
      partner_namespace: ["mcp:tools"],
      agent: ["mcp:tools"],
      partner_agent: ["mcp:tools"],
    },
    mcpHandler,
    provider,
    stores,
    upstreamClientID: CLIENT_ID,
    upstreamIssuer: UPSTREAM_ISS,
    routeRefreshPolicy: options.routeRefreshPolicy,
  };
  if (options.routeRefreshEvents !== null) {
    config.routeRefreshEvents = options.routeRefreshEvents;
  }
  let bearerValidator = null;
  if (options.requireBearerTokenFor !== null) {
    const bearerOptions = await options.requireBearerTokenFor(fake, bridge);
    config.requireBearerToken = bearerOptions;
    bearerValidator = bearerOptions.claimsValidator ?? null;
  }
  if (options.registrationEndpointURL !== null) {
    config.registrationEndpointURL = options.registrationEndpointURL;
  }
  if (options.providerHints !== null) {
    config.providerHints = options.providerHints;
  }
  if (options.configExtra !== null) {
    Object.assign(config, options.configExtra);
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

  return {
    config,
    fake,
    clock,
    stores,
    broker,
    kind,
    endpoint,
    tokenPath: oauthTokenPath(endpoint),
    registerPath: oauthRegisterPath(endpoint),
    tokenForm: (code, overrides = {}) => ({
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      redirect_uri: CLIENT_REDIRECT,
      client_id: CLIENT_ID,
      ...overrides,
    }),
    tokenCalls: () => bridge.tokenCalls,
    bearerValidator,
    invocations: invocationCounter,
    bridge,
  };
}

/** Builds the request helpers that drive whichever app mounts the world. */
export function frontChannelSurfaces(app, world) {
  const endpoint = world.endpoint;
  const serve = async (method, path, query, body, headers = {}) => {
    const request = {
      method,
      path,
      headers,
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

  return { serve, authorize, callback, authorizeAndCallback, token };
}

/** Starts the world and mounts it on a plain App, as every front-channel test does. */
export async function newFrontChannelHarness(t, overrides = {}) {
  const world = await startFrontChannelWorld(t, overrides);
  // The app clock is the same deterministic instant the stores observe, so
  // ctx.now() and the broker's now() move together when a test advances the
  // clock: grace windows, record lifetimes, and rotation timestamps all do.
  const app = createApp({ tier: "p0", clock: world.clock });
  registerMcpFacade(app, world.config);
  return { app, ...world, ...frontChannelSurfaces(app, world) };
}
