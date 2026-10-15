import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CALLBACK_PATH,
  Authenticated,
  Public,
  SecureApp,
  createApp,
  insufficientScopeWWWAuthenticate,
  mcpPath,
  newJwksValidator,
  oauthRegisterPath,
  protectedResourcePath,
  protectedResourceWWWAuthenticate,
  registerMcpFacade,
  registerMcpFacadeSecure,
} from "../dist/index.js";

import {
  assertBearerTokenReachesTransportHandlerSecureApp,
  assertCredentialFreeTransportDeniedSecureApp,
  assertInsufficientScopeTransportDeniedSecureApp,
  countingTransportHandler,
} from "../dist/testkit/mcpfacade.js";

import {
  BASE_URL,
  CLIENT_ID,
  CLIENT_REDIRECT,
  CLIENT_STATE,
  UPSTREAM_CODE,
  UPSTREAM_ISS,
  bodyString,
  firstHeader,
  frontChannelSurfaces,
  locationQuery,
  noContent,
  startFrontChannelWorld,
} from "./mcpfacade-harness.mjs";

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

const SECURE_APP_MOUNT_GROUP = "secure_app_mount";

/**
 * The number of secure_app_mount rows the shared table must carry; a change to
 * the table must also be a deliberate edit in the Go and Python loaders, so no
 * runtime can silently execute a smaller table.
 */
const SECURE_APP_MOUNT_CASE_COUNT = 39;

/**
 * The rows of each scenario the shared table carries. The three loaders below
 * execute them all: a row added to the table must land in exactly one of the
 * three and be executed, so a silently dropped row cannot pass.
 */
const SECURE_APP_SCENARIO_CASE_COUNTS = new Map([
  ["posture", 25],
  ["request", 10],
  ["inventory_parity", 4],
]);

/** The route resource every row's namespace MCP route advertises. */
const SECURE_ROUTE_RESOURCE = `${BASE_URL}/acme/mcp`;

/**
 * The RFC 9728 metadata URL the mounted transport route advertises in its
 * challenges and in the front channel's requireBearerToken options.
 */
const SECURE_ROUTE_METADATA_URL = `${BASE_URL}/.well-known/oauth-protected-resource/acme/mcp`;

/**
 * The number of posture-carrying routes each row's SecureApp must carry: four
 * endpoint families, times three transport methods, plus the three public
 * per-family surface routes (protected-resource metadata and the two discovery
 * routes), plus the three routes a front channel adds per family (/authorize,
 * /token, and /register), plus the single stage-global upstream callback, plus
 * the root authorization-server document when the row configures one. The table
 * is independent of the registrar, so an undeclared extra route cannot hide
 * behind a count the registrar itself derived.
 *
 * The key is `<transport posture>|<front channel>|<root document>`.
 */
const SECURE_APP_ROUTE_COUNTS = new Map([
  ["runtime-bearer|false|false", 24],
  ["runtime-bearer|false|true", 25],
  ["runtime-bearer|true|false", 37],
  ["runtime-bearer|true|true", 38],
  ["iam|false|false", 24],
  ["iam|false|true", 25],
  ["jwt|false|false", 24],
  ["none-public|false|false", 12],
]);

/**
 * The exact number of posture-carrying routes one row's mount must declare, or a
 * failure when the table declares no count for the row's combination, so a new
 * combination cannot slip in without a deliberate count.
 */
function declaredRouteCount(row) {
  const key = `${row.transport_posture}|${row.front_channel === true}|${row.root_authorization_server === true}`;
  const expected = SECURE_APP_ROUTE_COUNTS.get(key);
  assert.notEqual(
    expected,
    undefined,
    `row ${row.id}: no declared route count for ${key}`,
  );
  return expected;
}

/** The inventory field each `posture` row's route name resolves to. */
const POSTURE_ROUTE_FIELDS = {
  transport: "mcpPattern",
  protected_resource: "protectedResourcePattern",
  discovery_canonical: "discoveryCanonicalPattern",
  discovery_suffix: "discoverySuffixPattern",
  authorize: "authorizePattern",
  token: "tokenPattern",
  register: "registerPattern",
};

/** The static root discovery document the parity row's root mode mounts. */
function rootDiscoveryConfig() {
  return {
    issuerURL: "https://accounts.example.com",
    authorizationEndpointURL: "https://accounts.example.com/authorize",
    tokenEndpointURL: "https://accounts.example.com/token",
    registrationEndpointURL: "https://accounts.example.com/register",
    jwksURI: "https://accounts.example.com/.well-known/jwks.json",
    scopes: ["openid", "offline_access", "mcp:tools"],
  };
}

function loadFixture() {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, FIXTURE_NAME), "utf8"));
}

function secureAppMountRows(scenario) {
  return (loadFixture().cases ?? []).filter(
    (row) =>
      row.group === SECURE_APP_MOUNT_GROUP && row.scenario === scenario,
  );
}

/**
 * Asserts the shared table still carries exactly the rows this loader claims.
 * The filter already pins the group; the count below is what makes a table that
 * lost or gained a row fail rather than silently shrink.
 */
function declaredSecureAppRows(scenario) {
  const rows = secureAppMountRows(scenario);
  assert.equal(
    rows.length,
    SECURE_APP_SCENARIO_CASE_COUNTS.get(scenario),
    `the ${scenario} rows of the shared table moved`,
  );
  return rows;
}

/**
 * Builds the facade config a row mounts. A front-channel row mounts the world's
 * real front channel, so its config carries the provider and stores the harness
 * started; every other row mounts the transport and public surface only.
 */
async function worldForRow(t, row) {
  if (row.front_channel === true) {
    return await startFrontChannelWorld(t, {
      transportPosture: row.transport_posture,
      issuerMode: row.issuer_mode ?? "route",
      requireBearerTokenFor:
        row.transport_posture === "runtime-bearer"
          ? () => ({ resourceMetadataURL: SECURE_ROUTE_METADATA_URL })
          : null,
      ...(row.root_authorization_server === true
        ? {
            configExtra: {
              rootAuthorizationServer: rootDiscoveryConfig(),
            },
          }
        : {}),
    });
  }
  const config = {
    issuerURL: SECURE_ROUTE_RESOURCE,
    jwksURI: `${UPSTREAM_ISS}/.well-known/jwks.json`,
    issuerMode: row.issuer_mode ?? "route",
    urlMode: "public_base_url",
    publicBaseURL: BASE_URL,
    transportPosture: row.transport_posture,
    scopes: {
      namespace: ["mcp:tools"],
      partner_namespace: ["mcp:tools"],
      agent: ["mcp:tools"],
      partner_agent: ["mcp:tools"],
    },
    mcpHandler: () => noContent(),
  };
  if (row.transport_posture === "runtime-bearer") {
    config.requireBearerToken = {
      resourceMetadataURL: SECURE_ROUTE_METADATA_URL,
    };
  }
  if (row.root_authorization_server === true) {
    config.rootAuthorizationServer = rootDiscoveryConfig();
  }
  return { config };
}

/**
 * Resolves a `posture` row's route name to the concrete paths the facades
 * mount, deriving every path from the returned inventory rather than from a
 * hard-coded string. A per-family route name resolves once per endpoint family,
 * so the row pins the posture on all four and not only on the namespace.
 */
function postureRowPaths(row, inventory) {
  const field = POSTURE_ROUTE_FIELDS[row.route];
  if (field !== undefined) {
    return inventory.routes.map((route) => route[field]);
  }
  if (row.route === "callback") {
    return [inventory.callbackPattern];
  }
  if (row.route === "root_authorization_server") {
    return [inventory.rootAuthorizationServerPattern];
  }
  assert.fail(`row ${row.id} names unknown route ${JSON.stringify(row.route)}`);
}

/**
 * Mounts a row's facade on a closed-by-default SecureApp and checks the row's
 * declared authority: whether the route is present at all, and the exact posture
 * it declares when it is.
 */
async function executeSecurePostureRow(t, row) {
  const { config } = await worldForRow(t, row);
  const secure = new SecureApp({ tier: "p0" });
  const inventory = registerMcpFacadeSecure(secure, config);
  const routes = secure.routes();
  const context = `row ${row.id}`;

  const expectedTotal = declaredRouteCount(row);
  assert.equal(
    routes.length,
    expectedTotal,
    `${context} must carry exactly ${expectedTotal} posture-carrying routes: ${JSON.stringify(routes.map((route) => `${route.method} ${route.path}`))}`,
  );

  for (const routePath of postureRowPaths(row, inventory)) {
    assert.notEqual(routePath, "", `${context} must resolve a concrete path`);
    const matched = routes.filter(
      (route) => route.method === row.method && route.path === routePath,
    );
    if (row.expect_present === true) {
      assert.equal(
        matched.length,
        1,
        `${context} must declare ${row.method} ${routePath}`,
      );
      assert.equal(
        matched[0].posture,
        row.expect_posture,
        `${context} declares the wrong posture on ${row.method} ${routePath}`,
      );
    } else {
      assert.equal(
        matched.length,
        0,
        `${context} must not declare ${row.method} ${routePath}`,
      );
    }
  }
}

/**
 * Every scenario loader asserts the same group total, so the three of them
 * together execute exactly the shared table and no row can be dropped by
 * landing in a scenario no loader reads.
 */
function assertSecureAppGroupLedger() {
  const ledger = [...SECURE_APP_SCENARIO_CASE_COUNTS.values()].reduce(
    (total, count) => total + count,
    0,
  );
  assert.equal(
    ledger,
    SECURE_APP_MOUNT_CASE_COUNT,
    "the scenario ledger must account for every secure_app_mount row",
  );
  assert.equal(
    loadFixture().cases.filter(
      (row) => row.group === SECURE_APP_MOUNT_GROUP,
    ).length,
    SECURE_APP_MOUNT_CASE_COUNT,
    "every secure_app_mount row must carry the group",
  );
}

test("the secure_app_mount posture table pins every facade route's declared posture", async (t) => {
  assertSecureAppGroupLedger();
  const rows = declaredSecureAppRows("posture");

  let executed = 0;
  for (const row of rows) {
    executed += 1;
    await executeSecurePostureRow(t, row);
  }
  assert.equal(executed, SECURE_APP_SCENARIO_CASE_COUNTS.get("posture"));
});

// ---------------------------------------------------------------------------
// Request rows: the same authority table, driven through real requests
// ---------------------------------------------------------------------------

/** Counts resolver and PolicyHook invocations, so a row can pin both. */
function countingSecureAuthority() {
  const resolver = { count: 0 };
  const policyHook = { count: 0 };
  return {
    resolver,
    policyHook,
    principalResolver: (ctx) => {
      resolver.count += 1;
      const values = ctx.request.headers["x-tms-session"] ?? [];
      if (values[0] !== "valid") {
        return undefined;
      }
      return {
        identity: "tms-operator",
        scopes: ["mcp:tools"],
        kind: "external",
      };
    },
    hook: () => {
      policyHook.count += 1;
      return undefined;
    },
  };
}

/** The real JWKS claims validator the runtime-bearer rows present their tokens to. */
async function secureBearerTokenFor(fake, bridge) {
  const claimsValidator = await newJwksValidator({
    issuer: UPSTREAM_ISS,
    jwksUri: `${UPSTREAM_ISS}/.well-known/jwks.json`,
    fetchImpl: (input, init) => bridge.fetch(input, init),
    allowPrivateHosts: true,
    requiredAudience: SECURE_ROUTE_RESOURCE,
    requiredScopes: ["mcp:tools"],
  });
  return {
    resourceMetadataURL: SECURE_ROUTE_METADATA_URL,
    claimsValidator,
    requiredScopes: ["mcp:tools"],
  };
}

const AUDIT_HANDLER_BODY = "audit-ok";

/**
 * Starts the row's world and mounts it on a tier-P2 SecureApp that also owns one
 * non-facade route, so every request row drives the closed-by-default app the
 * application itself would run: the facade's own routes plus one route the
 * application declared under its own principal authority.
 */
async function newSecureRequestHarness(t, transportPosture) {
  const invocations = { count: 0 };
  const world = await startFrontChannelWorld(t, {
    transportPosture,
    mcpInvocations: invocations,
    mcpHandler: () => noContent(),
    ...(transportPosture === "runtime-bearer"
      ? { requireBearerTokenFor: secureBearerTokenFor }
      : {}),
  });
  const authority = countingSecureAuthority();
  const secure = new SecureApp({
    tier: "p2",
    clock: world.clock,
    principalResolver: authority.principalResolver,
    policyHook: authority.hook,
  });
  registerMcpFacadeSecure(secure, world.config);
  secure.get(
    "/internal/audit",
    () => ({
      status: 200,
      headers: {},
      cookies: [],
      body: Buffer.from(AUDIT_HANDLER_BODY, "utf8"),
      isBase64: false,
    }),
    Authenticated(),
  );

  return {
    secure,
    app: secure,
    world,
    invocations,
    resolver: authority.resolver,
    policyHook: authority.policyHook,
    ...frontChannelSurfaces(secure, world),
  };
}

function secureTransportToken(harness, scope) {
  return harness.world.fake.mintAccessToken({
    issuer: UPSTREAM_ISS,
    audience: SECURE_ROUTE_RESOURCE,
    authorizedParty: CLIENT_ID,
    subject: "user-1",
    scope,
    expiresInSeconds: 900,
  });
}

async function executeSecureRequestRow(t, row) {
  const harness = await newSecureRequestHarness(t, row.transport_posture);
  const context = `row ${row.id}`;
  const transportPath = mcpPath(harness.world.endpoint);

  let response;
  switch (row.request) {
    case "transport_credential_free":
      response = await harness.serve("POST", transportPath, null, null);
      break;
    case "transport_insufficient_scope":
      response = await harness.serve("POST", transportPath, null, null, {
        authorization: [`Bearer ${secureTransportToken(harness, "mcp:read")}`],
      });
      break;
    case "transport_valid":
      response = await harness.serve("POST", transportPath, null, null, {
        authorization: [`Bearer ${secureTransportToken(harness, "mcp:tools")}`],
      });
      break;
    case "protected_resource_metadata":
      response = await harness.serve(
        "GET",
        protectedResourcePath(harness.world.endpoint),
        null,
        null,
      );
      break;
    case "register":
      response = await harness.serve(
        "POST",
        oauthRegisterPath(harness.world.endpoint),
        null,
        Buffer.from(
          JSON.stringify({ redirect_uris: [CLIENT_REDIRECT] }),
          "utf8",
        ),
      );
      break;
    case "non_facade_anonymous":
      response = await harness.serve("GET", "/internal/audit", null, null);
      break;
    case "non_facade_resolved":
      response = await harness.serve("GET", "/internal/audit", null, null, {
        "x-tms-session": ["valid"],
      });
      break;
    case "undeclared_anonymous":
      response = await harness.serve("GET", "/internal/undeclared", null, null);
      break;
    default:
      assert.fail(
        `row ${row.id} names unknown request ${JSON.stringify(row.request)}`,
      );
  }

  assert.equal(
    response.status,
    row.expect_status,
    `${context} body ${bodyString(response)}`,
  );

  const challenge = firstHeader(response.headers, "www-authenticate");
  if (row.expect_challenge_resource_metadata === true) {
    assert.equal(
      challenge,
      protectedResourceWWWAuthenticate(SECURE_ROUTE_METADATA_URL),
      `${context} must carry the RFC 9728 discovery challenge`,
    );
  }
  if (row.expect_challenge_resource_metadata === false) {
    assert.equal(
      challenge,
      undefined,
      `${context} must advertise no discovery challenge`,
    );
  }
  if (row.expect_challenge_scope !== undefined) {
    assert.equal(
      challenge,
      insufficientScopeWWWAuthenticate(
        [row.expect_challenge_scope],
        SECURE_ROUTE_METADATA_URL,
      ),
      `${context} must carry the RFC 6750 insufficient_scope challenge`,
    );
  }
  if (row.expect_handler_invocations !== undefined) {
    assert.equal(
      harness.invocations.count,
      row.expect_handler_invocations,
      `${context} MCP handler invocations`,
    );
  }
  if (row.expect_resolver_invocations !== undefined) {
    assert.equal(
      harness.resolver.count,
      row.expect_resolver_invocations,
      `${context} principal resolver invocations`,
    );
  }
  if (row.expect_policy_hook_invocations !== undefined) {
    assert.equal(
      harness.policyHook.count,
      row.expect_policy_hook_invocations,
      `${context} PolicyHook invocations`,
    );
  }
  if (row.request === "non_facade_resolved") {
    assert.equal(
      bodyString(response),
      AUDIT_HANDLER_BODY,
      `${context} must run the non-facade handler`,
    );
  }
}

test("the secure_app_mount request table drives the mounted SecureApp", async (t) => {
  assertSecureAppGroupLedger();
  const rows = declaredSecureAppRows("request");

  let executed = 0;
  for (const row of rows) {
    executed += 1;
    await executeSecureRequestRow(t, row);
  }
  assert.equal(executed, SECURE_APP_SCENARIO_CASE_COUNTS.get("request"));
});

// ---------------------------------------------------------------------------
// Parity rows
// ---------------------------------------------------------------------------

test("the secure_app_mount parity table pins one inventory for both registrars", async (t) => {
  assertSecureAppGroupLedger();
  const rows = declaredSecureAppRows("inventory_parity");

  let executed = 0;
  for (const row of rows) {
    executed += 1;
    const world = await worldForRow(t, row);
    const secure = new SecureApp({ tier: "p0" });
    const secureInventory = registerMcpFacadeSecure(secure, world.config);
    const plainInventory = registerMcpFacade(
      createApp({ tier: "p0", clock: world.clock }),
      world.config,
    );
    assert.ok(
      plainInventory.routes.length > 0,
      `row ${row.id} must mount a real inventory`,
    );
    if (row.expect_equal === true) {
      assert.deepStrictEqual(
        secureInventory,
        plainInventory,
        `row ${row.id} must return the same inventory from both registrars`,
      );
    } else {
      assert.notDeepStrictEqual(
        secureInventory,
        plainInventory,
        `row ${row.id} must return different inventories from the two registrars`,
      );
    }
    // The parity row also proves the SecureApp mount is real, not merely equal:
    // the closed-by-default app declares exactly the routes the shared inventory
    // describes, each with a declared posture.
    assert.equal(
      secure.routes().length,
      declaredRouteCount(row),
      `row ${row.id} must mount exactly the routes its inventory describes`,
    );
  }
  assert.equal(
    executed,
    SECURE_APP_SCENARIO_CASE_COUNTS.get("inventory_parity"),
  );
});

// ---------------------------------------------------------------------------
// The TMS topology journey over the SecureApp seam
// ---------------------------------------------------------------------------

/** Reads a JSON string member a token response handed the client. */
function responseField(response, field) {
  const payload = JSON.parse(bodyString(response));
  const value = payload[field];
  assert.equal(
    typeof value,
    "string",
    `token response must carry a string ${field}`,
  );
  assert.notEqual(value, "");
  return value;
}

/**
 * Drives the complete TMS topology journey through the really-mounted
 * closed-by-default SecureApp: discovery, dynamic client registration, the
 * authorize/callback/token legs with PKCE, brokered refresh rotation, a
 * bearer-authenticated MCP call, both transport refusal classes, and the
 * application's own principal still governing its own non-facade route.
 */
test("the TMS topology journey completes over the SecureApp seam", async (t) => {
  const harness = await newSecureRequestHarness(t, "runtime-bearer");
  const endpoint = harness.world.endpoint;

  // The RFC 9728 document is reachable before any token exists, and reaching it
  // is not a principal decision.
  const metadata = await harness.serve(
    "GET",
    protectedResourcePath(endpoint),
    null,
    null,
  );
  assert.equal(metadata.status, 200, bodyString(metadata));
  assert.equal(harness.resolver.count, 0, "discovery is public");
  assert.ok(
    bodyString(metadata).includes(SECURE_ROUTE_RESOURCE),
    "the metadata must advertise the route resource",
  );

  // RFC 7591 registration admits a public client with no principal at all.
  const dcr = await harness.serve(
    "POST",
    oauthRegisterPath(endpoint),
    null,
    Buffer.from(JSON.stringify({ redirect_uris: [CLIENT_REDIRECT] }), "utf8"),
  );
  assert.equal(dcr.status, 201, bodyString(dcr));
  assert.notEqual(responseField(dcr, "client_id"), "");
  assert.equal(harness.resolver.count, 0, "registration is public");

  // The authorization_code journey through the mounted front channel.
  const authorize = await harness.authorize(undefined);
  assert.equal(authorize.status, 302, bodyString(authorize));
  const upstream = locationQuery(authorize);
  // The authorize leg hands the browser to the upstream with the facade's own
  // material: the upstream is given the facade's callback, never the client's
  // redirect URI, and never the client's own state.
  assert.equal(
    upstream.get("client_id"),
    CLIENT_ID,
    "authorize must present the facade's upstream client",
  );
  assert.equal(
    upstream.get("redirect_uri"),
    `${BASE_URL}/_oauth/mcp/callback`,
    "the upstream must be given the facade's callback",
  );
  const upstreamState = upstream.get("state");
  assert.ok(upstreamState, "authorize must mint an upstream state");
  assert.notEqual(
    upstreamState,
    CLIENT_STATE,
    "the upstream state must not be the client's state",
  );

  const callback = await harness.serve(
    "GET",
    DEFAULT_CALLBACK_PATH,
    {
      code: [UPSTREAM_CODE],
      state: [upstreamState],
      iss: [UPSTREAM_ISS],
    },
    null,
  );
  assert.equal(callback.status, 302, bodyString(callback));
  // The callback returns the browser to the client's own registered redirect URI
  // with the client's state and a facade code, never the upstream code.
  const callbackLocation = firstHeader(callback.headers, "location");
  assert.ok(
    callbackLocation.startsWith(CLIENT_REDIRECT),
    `the callback must return the browser to the client's redirect URI, got ${callbackLocation}`,
  );
  const delivered = locationQuery(callback);
  assert.equal(
    delivered.get("state"),
    CLIENT_STATE,
    "the facade must return the client's own state",
  );
  const facadeCode = delivered.get("code");
  assert.ok(facadeCode, "callback must hand the client a facade code");
  assert.notEqual(
    facadeCode,
    UPSTREAM_CODE,
    "the client must never receive the upstream code",
  );

  const exchange = await harness.token(harness.world.tokenForm(facadeCode));
  assert.equal(exchange.status, 200, bodyString(exchange));
  const accessToken = responseField(exchange, "access_token");
  const handle = responseField(exchange, "refresh_token");

  // The brokered refresh rotates the handle without a second authorize leg.
  const beforeRefreshCalls = harness.world.tokenCalls();
  const refresh = await harness.token({
    grant_type: "refresh_token",
    refresh_token: handle,
    client_id: CLIENT_ID,
  });
  assert.equal(refresh.status, 200, bodyString(refresh));
  const rotated = responseField(refresh, "refresh_token");
  assert.notEqual(rotated, handle, "refresh must rotate the handle");
  assert.equal(
    harness.world.tokenCalls(),
    beforeRefreshCalls + 1,
    "the refresh must make exactly one upstream call",
  );

  // A bearer-authenticated MCP call reaches the MCP handler; the app's own
  // principal resolver is not consulted on a public transport route.
  const call = await harness.serve(
    "POST",
    mcpPath(endpoint),
    null,
    Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}', "utf8"),
    { authorization: [`Bearer ${accessToken}`] },
  );
  assert.equal(call.status, 204, bodyString(call));
  assert.equal(harness.invocations.count, 1, "the MCP handler must run once");
  assert.equal(harness.resolver.count, 0, "the bearer validator is the authority");

  // A credential-free call is refused with the RFC 9728 discovery challenge.
  const credentialFree = await harness.serve("POST", mcpPath(endpoint), null, null);
  assert.equal(credentialFree.status, 401, bodyString(credentialFree));
  assert.equal(
    firstHeader(credentialFree.headers, "www-authenticate"),
    protectedResourceWWWAuthenticate(SECURE_ROUTE_METADATA_URL),
  );
  assert.equal(harness.invocations.count, 1, "a refused call reaches no handler");

  // A token that is valid but under-scoped is refused with the RFC 6750
  // insufficient_scope challenge carrying the scope the route requires.
  const underScoped = await harness.serve(
    "POST",
    mcpPath(endpoint),
    null,
    null,
    { authorization: [`Bearer ${secureTransportToken(harness, "mcp:read")}`] },
  );
  assert.equal(underScoped.status, 403, bodyString(underScoped));
  assert.equal(
    firstHeader(underScoped.headers, "www-authenticate"),
    insufficientScopeWWWAuthenticate(["mcp:tools"], SECURE_ROUTE_METADATA_URL),
  );
  assert.equal(harness.invocations.count, 1, "a refused call reaches no handler");

  // The same admission holds on the API Gateway V2 entry point, so the seam is
  // not an artifact of one runtime's request shape.
  const gateway = await harness.secure.serveAPIGatewayV2({
    version: "2.0",
    routeKey: "$default",
    rawPath: mcpPath(endpoint),
    rawQueryString: "",
    cookies: [],
    headers: { authorization: `Bearer ${accessToken}` },
    queryStringParameters: null,
    requestContext: { http: { method: "POST", path: mcpPath(endpoint) } },
    body: "",
    isBase64Encoded: false,
  });
  assert.equal(gateway.statusCode, 204, bodyString(gateway));
  assert.equal(harness.invocations.count, 2, "the gateway call must reach the handler");

  // The application's own route keeps the application's own authority: the
  // anonymous request is denied with the resolver consulted, and the resolved
  // request is admitted and runs the application's handler.
  const anonymous = await harness.serve("GET", "/internal/audit", null, null);
  assert.equal(anonymous.status, 401, bodyString(anonymous));
  assert.equal(harness.resolver.count, 1, "the denial resolves a principal");

  const resolved = await harness.serve("GET", "/internal/audit", null, null, {
    "x-tms-session": ["valid"],
  });
  assert.equal(resolved.status, 200, bodyString(resolved));
  assert.equal(bodyString(resolved), AUDIT_HANDLER_BODY);
  assert.equal(harness.resolver.count, 2, "the admission resolves a principal");

  // A route the application never declares stays undeliverable after the facade
  // mounts, and the refusal is not even a principal decision.
  const undeclared = await harness.serve("GET", "/internal/undeclared", null, null);
  assert.equal(undeclared.status, 404, bodyString(undeclared));
  assert.equal(harness.resolver.count, 2, "an undeclared route resolves no principal");
});

// ---------------------------------------------------------------------------
// Testkit conformance kit on the SecureApp surface
// ---------------------------------------------------------------------------

/**
 * Pins the SecureApp variants of the consumer conformance kit against the same
 * three transport outcomes the plain-App kit asserts, and additionally proves
 * that mounting the facade on a SecureApp leaves the application's own principal
 * gate in force for every route the facade does not own. Without that second half
 * the helpers would only show that the facade's bearer validator works, not that
 * the closed-by-default surface survived the mount.
 */
test("the SecureApp conformance kit denies and admits on the closed-by-default surface", async (t) => {
  const handler = countingTransportHandler();
  const world = await startFrontChannelWorld(t, {
    transportPosture: "runtime-bearer",
    mcpHandler: handler.handler,
    requireBearerTokenFor: secureBearerTokenFor,
  });
  const authority = countingSecureAuthority();
  const secure = new SecureApp({
    tier: "p2",
    clock: world.clock,
    principalResolver: authority.principalResolver,
    policyHook: authority.hook,
  });
  registerMcpFacadeSecure(secure, world.config);
  secure.get(
    "/internal/audit",
    () => ({
      status: 200,
      headers: {},
      cookies: [],
      body: Buffer.from(AUDIT_HANDLER_BODY, "utf8"),
      isBase64: false,
    }),
    Authenticated(),
  );

  const transportPath = mcpPath(world.endpoint);
  await assertCredentialFreeTransportDeniedSecureApp(
    secure,
    "POST",
    transportPath,
    SECURE_ROUTE_METADATA_URL,
    handler,
  );
  assert.equal(handler.invocations(), 0, "a denied transport request must not reach the MCP handler");
  await assertBearerTokenReachesTransportHandlerSecureApp(
    secure,
    "POST",
    transportPath,
    secureTransportToken({ world }, "mcp:tools"),
    handler,
  );
  assert.equal(handler.invocations(), 1);
  await assertInsufficientScopeTransportDeniedSecureApp(
    secure,
    "POST",
    transportPath,
    secureTransportToken({ world }, "mcp:read"),
    SECURE_ROUTE_METADATA_URL,
    ["mcp:tools"],
    handler,
  );
  assert.equal(handler.invocations(), 1, "a scope denial must not reach the MCP handler");

  // The facade's own transport route never consults the app resolver: its
  // authority is the RFC 9728 bearer validator, so the three calls above add no
  // resolver traffic.
  assert.equal(
    authority.resolver.count,
    0,
    "the facade transport route must not consult the SecureApp resolver",
  );

  // The application's non-facade route still demands its own principal, and the
  // denial is the app's, not the facade's: no RFC 9728 challenge is attached.
  const anonymous = await secure.serve({
    method: "GET",
    path: "/internal/audit",
    headers: {},
    query: {},
    body: Buffer.alloc(0),
    isBase64: false,
  });
  assert.equal(anonymous.status, 401);
  assert.equal(firstHeader(anonymous.headers, "www-authenticate"), undefined);
  assert.equal(
    authority.resolver.count,
    1,
    "the non-facade route must consult the app resolver",
  );

  const resolved = await secure.serve({
    method: "GET",
    path: "/internal/audit",
    headers: { "x-tms-session": ["valid"] },
    query: {},
    body: Buffer.alloc(0),
    isBase64: false,
  });
  assert.equal(resolved.status, 200);
  assert.equal(authority.resolver.count, 2);
});

// ---------------------------------------------------------------------------
// Fail-closed registration
// ---------------------------------------------------------------------------

test("a rejected config adds no route to the SecureApp", async () => {
  const secure = new SecureApp({ tier: "p0" });
  assert.throws(
    () =>
      registerMcpFacadeSecure(secure, {
        issuerURL: SECURE_ROUTE_RESOURCE,
        jwksURI: `${UPSTREAM_ISS}/.well-known/jwks.json`,
        issuerMode: "route",
        urlMode: "public_base_url",
        publicBaseURL: BASE_URL,
        // runtime-bearer without its bearer options is refused by
        // normalizeConfig, before any route is added.
        transportPosture: "runtime-bearer",
        scopes: {
          namespace: ["mcp:tools"],
          partner_namespace: ["mcp:tools"],
          agent: ["mcp:tools"],
          partner_agent: ["mcp:tools"],
        },
        mcpHandler: () => noContent(),
      }),
    /TransportPosture runtime-bearer requires RequireBearerToken/,
  );
  assert.deepStrictEqual(secure.routes(), []);
  assert.throws(
    () => registerMcpFacadeSecure(null, { mcpHandler: () => noContent() }),
    /secure app is required/,
  );
});

test("a second mount of the same config fails instead of shadowing routes", async (t) => {
  const { config } = await worldForRow(t, {
    transport_posture: "iam",
    front_channel: false,
  });
  const secure = new SecureApp({ tier: "p0" });
  registerMcpFacadeSecure(secure, config);
  const mounted = secure.routes().length;
  assert.ok(mounted > 0, "the first mount must declare routes");

  assert.throws(
    () => registerMcpFacadeSecure(secure, config),
    (err) => {
      assert.match(
        err.message,
        /^AppTheoryMcpFacade: route (POST|GET|DELETE) \S+ is already registered on the secure app$/,
        `unexpected message ${err.message}`,
      );
      return true;
    },
  );
  assert.equal(
    secure.routes().length,
    mounted,
    "the failed second mount must not add a route",
  );
});

test("secure mount rejects a non-first collision without mounting anything", async (t) => {
  const { config } = await worldForRow(t, {
    transport_posture: "iam",
    front_channel: false,
  });

  // The plan's fourth registration is the first route family's RFC 9728
  // protected-resource GET (buildRegistrations pushes transport POST/GET/DELETE
  // and then that GET per family), so the application owning it is a collision
  // a mount-as-it-goes registrar could not see until it had already installed
  // the three transport routes.
  const plain = createApp({ tier: "p0" });
  const inventory = registerMcpFacade(plain, config);
  assert.ok(inventory.routes.length > 0, "the plan must declare a route family");
  const collisionMethod = "GET";
  const collisionPattern = inventory.routes[0].protectedResourcePattern;

  const secure = new SecureApp({ tier: "p0" });
  secure.handle(collisionMethod, collisionPattern, () => noContent(), Public());
  const declared = secure.routes();
  assert.equal(declared.length, 1, "the application must own exactly one route");

  assert.throws(
    () => registerMcpFacadeSecure(secure, config),
    /already registered on the secure app/,
  );
  assert.deepStrictEqual(
    secure.routes(),
    declared,
    "the refused mount must not add a single facade route",
  );
});
