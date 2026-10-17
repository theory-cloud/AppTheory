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
  newJwksValidator,
  oauthAuthorizationServerPath,
  oauthAuthorizationServerSuffixPath,
  oauthAuthorizePath,
  oauthRegisterPath,
  oauthTokenPath,
  pkceChallengeS256,
  protectedResourcePath,
  protectedResourceWWWAuthenticate,
  insufficientScopeWWWAuthenticate,
  registerMcpFacade,
} from "../dist/index.js";
import { BrokerVersionConflictError } from "../dist/oauth/store.js";

import {
  BASE_URL,
  CLIENT_ID,
  CLIENT_REDIRECT,
  CLIENT_STATE,
  REFRESH_ACCESS_TOKEN,
  REFRESH_ID_TOKEN,
  ROTATED_UPSTREAM_REFRESH_TOKEN,
  ROTATED_UPSTREAM_SCOPE,
  UPSTREAM_CODE,
  UPSTREAM_ISS,
  UPSTREAM_REFRESH_TOKEN,
  VERIFIER,
  bodyString,
  firstHeader,
  locationOf,
  locationQuery,
  newFrontChannelHarness,
  noContent,
  responseScan,
} from "./mcpfacade-harness.mjs";

// ---------------------------------------------------------------------------
// Fixture constants (mirroring runtime/mcpfacade/front_channel_test.go)
//
// The upstream world they describe — the fake provider, the reference stores,
// the facade config, and the request helpers — is shared with the SecureApp
// suite through ./mcpfacade-harness.mjs.
// ---------------------------------------------------------------------------

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

const AUTHORIZE_PROVIDER_FAILURE_GROUP = "authorize_provider_failure";

/**
 * The number of authorize_provider_failure rows the shared table must carry; a
 * change to the table must also be a deliberate edit in the Go and Python
 * loaders, so no runtime can silently execute a smaller table.
 */
const AUTHORIZE_PROVIDER_FAILURE_CASE_COUNT = 2;

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
const DCR_CASE_COUNT = 12;

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

test("authorize enforces the shared authorize_provider_failure table through the real handler", async (t) => {
  const rows = (loadFixture().cases ?? []).filter(
    (row) => row.group === AUTHORIZE_PROVIDER_FAILURE_GROUP,
  );
  assert.equal(rows.length, AUTHORIZE_PROVIDER_FAILURE_CASE_COUNT);

  let executed = 0;
  for (const row of rows) {
    executed += 1;
    const harness = await newFrontChannelHarness(t, {
      failAuthorizationUrl: row.fail === "authorization_url",
      providerHints: async () => {
        if (row.fail === "provider_hints") {
          throw new Error("provider hints unavailable");
        }
        return {};
      },
    });

    const response = await harness.authorize(undefined);
    const context = `fail ${JSON.stringify(row.fail)}`;
    assert.equal(response.status, row.expect_status, context);
    if (row.expect_no_location) {
      assert.equal(locationOf(response), "", context);
    }
    const body = bodyString(response);
    for (const want of row.expect_body_has) {
      assert.ok(body.includes(want), `${context}: body ${body}`);
    }
  }
  assert.equal(executed, AUTHORIZE_PROVIDER_FAILURE_CASE_COUNT);
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

// ---------------------------------------------------------------------------
// Shared journey table (the same table the Go and Python loaders read)
// ---------------------------------------------------------------------------

const JOURNEY_FIXTURE_NAME = "facade-journey.v1.json";

const JOURNEY_GROUP = "journey";

/**
 * The number of journey rows the shared table must carry; a change to the table
 * must also be a deliberate edit in the Go and Python loaders, so no runtime can
 * silently execute a shorter journey.
 */
const JOURNEY_CASE_COUNT = 26;

/** The advertising resource of the namespace route the journey world describes. */
const JOURNEY_ROUTE_RESOURCE = `${BASE_URL}/acme/mcp`;

/** The route's RFC 9728 protected-resource metadata URL, named by every challenge. */
const JOURNEY_METADATA_URL = `${BASE_URL}/.well-known/oauth-protected-resource/acme/mcp`;

/** A route resource that is not the journey route's. */
const JOURNEY_WRONG_AUDIENCE = `${BASE_URL}/other/mcp`;

/** A client id no journey row registers. */
const JOURNEY_UNKNOWN_CLIENT_ID = "unknown-client";

/** A verifier that does not hash to the challenge the authorize step presented. */
const JOURNEY_WRONG_VERIFIER =
  "WRONGVERIFIERWRONGVERIFIERWRONGVERIFIER1234567890";

function loadJourneyFixture() {
  return JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, JOURNEY_FIXTURE_NAME), "utf8"),
  );
}

/**
 * Starts the journey harness: the front-channel harness with the runtime-bearer
 * transport posture, a real JWKS claims validator over the fake upstream's key
 * set, and an MCP handler that answers 200 and counts its invocations, so the
 * journey's transport rows exercise the mounted facade's own transport
 * middleware.
 */
async function newJourneyHarness(t) {
  const invocations = { count: 0 };
  const harness = await newFrontChannelHarness(t, {
    transportPosture: "runtime-bearer",
    requireBearerTokenFor: async (fake, bridge) => {
      const claimsValidator = await newJwksValidator({
        issuer: UPSTREAM_ISS,
        jwksUri: `${UPSTREAM_ISS}/.well-known/jwks.json`,
        fetchImpl: (input, init) => bridge.fetch(input, init),
        allowPrivateHosts: true,
        requiredAudience: JOURNEY_ROUTE_RESOURCE,
        requiredScopes: ["mcp:tools"],
      });
      return {
        resourceMetadataURL: JOURNEY_METADATA_URL,
        claimsValidator,
        requiredScopes: ["mcp:tools"],
      };
    },
    mcpHandler: () => ({
      status: 200,
      headers: {},
      cookies: [],
      body: Buffer.from("mcp-ok", "utf8"),
      isBase64: false,
    }),
    mcpInvocations: invocations,
  });
  harness.invocations = invocations;
  return harness;
}

/** The full RFC 6749 section 4.1.3 authorization_code grant the token rows present. */
function journeyTokenForm(code, verifier, overrides = {}) {
  return {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: CLIENT_REDIRECT,
    client_id: CLIENT_ID,
    ...overrides,
  };
}

function journeyTokenField(response, field) {
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
 * Mints the token a transport row presents. The fault tokens are minted by the
 * fake's own key, so only the pinned claim differs and the refusal cannot come
 * from a bad signature.
 */
function journeyTransportToken(harness, token) {
  const claims = (audience, scope, expiresInSeconds) => ({
    issuer: UPSTREAM_ISS,
    audience,
    authorizedParty: CLIENT_ID,
    subject: "user-1",
    scope,
    expiresInSeconds,
  });
  switch (token) {
    case "wrong_audience":
      return harness.fake.mintAccessToken(
        claims(JOURNEY_WRONG_AUDIENCE, "mcp:tools", 900),
      );
    case "expired":
      return harness.fake.mintAccessToken(
        claims(JOURNEY_ROUTE_RESOURCE, "mcp:tools", -60),
      );
    case "insufficient_scope":
      return harness.fake.mintAccessToken(
        claims(JOURNEY_ROUTE_RESOURCE, "mcp:read", 900),
      );
    default:
      throw new Error(`unknown journey transport token ${JSON.stringify(token)}`);
  }
}

/**
 * Starts a journey harness and applies the row's declared precondition. Each row
 * is executable in isolation: a row that needs facade material names the
 * precondition that mints it, so dropping or reordering rows cannot silently
 * weaken a later row.
 */
async function newJourneySession(t, precondition) {
  const harness = await newJourneyHarness(t);
  const session = {
    harness,
    invocations: harness.invocations,
    upstreamState: "",
    facadeCode: "",
    handle: "",
    accessToken: "",
  };
  if (precondition === undefined || precondition === "") {
    return session;
  }

  const mintsAuthorize =
    precondition === "authorize" ||
    precondition === "authorize_consumed" ||
    precondition.startsWith("authorize_callback");
  if (!mintsAuthorize) {
    assert.fail(`unknown journey precondition ${JSON.stringify(precondition)}`);
  }

  const authorizeResponse = await harness.authorize(undefined);
  assert.equal(authorizeResponse.status, 302, `${precondition} authorize`);
  session.upstreamState = locationQuery(authorizeResponse).get("state");
  assert.ok(session.upstreamState, `${precondition} upstream state`);
  if (precondition === "authorize") {
    return session;
  }

  const callbackResponse = await harness.serve(
    "GET",
    DEFAULT_CALLBACK_PATH,
    { code: [UPSTREAM_CODE], state: [session.upstreamState], iss: [UPSTREAM_ISS] },
    null,
  );
  assert.equal(callbackResponse.status, 302, `${precondition} callback`);
  session.facadeCode = locationQuery(callbackResponse).get("code");
  assert.ok(session.facadeCode, `${precondition} facade code`);
  if (precondition === "authorize_consumed" || precondition === "authorize_callback") {
    return session;
  }

  const exchange = await harness.token(
    journeyTokenForm(session.facadeCode, VERIFIER),
  );
  assert.equal(exchange.status, 200, `${precondition} exchange`);
  session.accessToken = journeyTokenField(exchange, "access_token");
  session.handle = journeyTokenField(exchange, "refresh_token");
  if (precondition === "authorize_callback_exchange") {
    return session;
  }

  const replay = await harness.token(
    journeyTokenForm(session.facadeCode, VERIFIER),
  );
  assert.equal(replay.status, 400, `${precondition} replay`);
  return session;
}

async function executeJourneyTransportRow(t, row) {
  const session = await newJourneySession(t, row.precondition);
  const harness = session.harness;

  const headers = {};
  switch (row.token) {
    case "none":
      break;
    case "valid":
      assert.ok(session.accessToken, `${row.id} needs the precondition's exchange`);
      headers.authorization = [`Bearer ${session.accessToken}`];
      break;
    case "wrong_audience":
    case "expired":
    case "insufficient_scope":
      headers.authorization = [
        `Bearer ${journeyTransportToken(harness, row.token)}`,
      ];
      break;
    default:
      assert.fail(`row ${row.id} carries unknown token ${JSON.stringify(row.token)}`);
  }

  const response = await harness.serve(
    "POST",
    mcpPath(harness.endpoint),
    null,
    Buffer.from(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, "utf8"),
    headers,
  );

  assert.equal(response.status, row.expect_status, `row ${row.id}`);
  const challenge = firstHeader(response.headers, "www-authenticate");
  if (row.expect_challenge_resource_metadata === true) {
    assert.equal(
      challenge,
      protectedResourceWWWAuthenticate(JOURNEY_METADATA_URL),
      `row ${row.id} must carry the RFC 9728 discovery challenge`,
    );
  } else if (row.expect_challenge_error !== undefined) {
    assert.equal(
      challenge,
      insufficientScopeWWWAuthenticate([row.expect_challenge_scope], JOURNEY_METADATA_URL),
      `row ${row.id} must carry the RFC 6750 insufficient_scope challenge`,
    );
  } else {
    assert.equal(challenge, undefined, `row ${row.id} must advertise no challenge`);
  }
  if (row.expect_handler_invocations !== undefined) {
    assert.equal(
      session.invocations.count,
      row.expect_handler_invocations,
      `row ${row.id} handler invocations`,
    );
  }
}

async function executeJourneyMetadataRow(t, row, authorizationServer) {
  const session = await newJourneySession(t, row.precondition);
  const harness = session.harness;
  const path_ = authorizationServer
    ? oauthAuthorizationServerPath(harness.endpoint)
    : protectedResourcePath(harness.endpoint);

  const response = await harness.serve("GET", path_, null, null);
  assert.equal(response.status, row.expect_status, `row ${row.id}`);

  const body = bodyString(response);
  for (const token of row.expect_body_has ?? []) {
    assert.ok(body.includes(token), `row ${row.id} body must carry ${token}`);
  }
  if (row.expect_no_store === true) {
    assert.equal(
      firstHeader(response.headers, "cache-control"),
      "no-store",
      `row ${row.id}`,
    );
  }
}

async function executeJourneyRegisterRow(t, row) {
  const harness = await newJourneyHarness(t);
  const registerPath = oauthRegisterPath(harness.endpoint);

  const body =
    row.request === undefined
      ? Buffer.alloc(0)
      : Buffer.from(JSON.stringify(row.request), "utf8");
  for (let attempt = 0; attempt < (row.prime_registrations ?? 0); attempt += 1) {
    const primed = await harness.serve(
      "POST",
      registerPath,
      null,
      Buffer.from(`{"redirect_uris":["https://client.example/callback"]}`, "utf8"),
    );
    assert.equal(primed.status, 201, `row ${row.id} priming attempt ${attempt + 1}`);
  }

  const response = await harness.serve("POST", registerPath, null, body);
  assert.equal(response.status, row.expect_status, `row ${row.id}`);

  const scanned = bodyString(response);
  for (const token of row.expect_body_has ?? []) {
    assert.ok(scanned.includes(token), `row ${row.id} body must carry ${token}`);
  }
  if (row.expect_no_store === true) {
    assert.equal(firstHeader(response.headers, "cache-control"), "no-store", `row ${row.id}`);
    assert.equal(firstHeader(response.headers, "pragma"), "no-cache", `row ${row.id}`);
  }
  if (row.expect_retry_after === true) {
    const value = firstHeader(response.headers, "retry-after");
    assert.notEqual(value, undefined, `row ${row.id} must carry a retry-after header`);
    assert.ok(
      Number.parseInt(value, 10) >= 1,
      `row ${row.id} must not ask for a retry sooner than one second`,
    );
  }
  if (row.expect_bound_route === true) {
    const clientId = JSON.parse(scanned).client_id;
    assert.ok(clientId, `row ${row.id} must mint a client id`);
    const record = await harness.stores.client.get(hashKey(clientId));
    assert.ok(record !== null, `row ${row.id} must persist the registered client`);
    assert.equal(record.boundRoute, JOURNEY_ROUTE_RESOURCE, `row ${row.id}`);
  }
}

async function executeJourneyAuthorizeRow(t, row) {
  const session = await newJourneySession(t, row.precondition);
  const harness = session.harness;

  const query = {
    client_id: [row.client === "unknown" ? JOURNEY_UNKNOWN_CLIENT_ID : CLIENT_ID],
    redirect_uri: [CLIENT_REDIRECT],
    response_type: ["code"],
    code_challenge: [pkceChallengeS256(VERIFIER)],
    code_challenge_method: ["S256"],
    state: [CLIENT_STATE],
    resource: [JOURNEY_ROUTE_RESOURCE],
  };
  if (row.redirect_uri !== undefined) {
    query.redirect_uri = [row.redirect_uri];
  }
  for (const key of row.omit ?? []) {
    delete query[key];
  }
  for (const [key, value] of Object.entries(row.set ?? {})) {
    query[key] = [value];
  }

  const response = await harness.serve(
    "GET",
    oauthAuthorizePath(harness.endpoint),
    query,
    null,
  );
  assert.equal(response.status, row.expect_status, `row ${row.id}`);

  const location = locationOf(response);
  if (row.expect_no_location === true) {
    assert.equal(location, "", `row ${row.id} must not redirect`);
  }
  if (row.expect_error !== undefined) {
    assert.ok(
      locationQuery(response).get("error") === row.expect_error ||
        bodyString(response).includes(`"error":"${row.expect_error}"`),
      `row ${row.id} must answer error ${row.expect_error}; location ${location} body ${bodyString(response)}`,
    );
  }
  if (row.expect_location_host !== undefined) {
    assert.ok(
      location.startsWith(`${row.expect_location_host}/`),
      `row ${row.id} location ${location} must be beneath ${row.expect_location_host}`,
    );
  }
  const queryResult = locationQuery(response);
  for (const key of row.expect_location_query_has ?? []) {
    assert.ok(queryResult.has(key), `row ${row.id} location must carry ${key}`);
  }
  for (const [key, value] of Object.entries(row.expect_location_query_equals ?? {})) {
    assert.equal(queryResult.get(key), value, `row ${row.id} location ${key}`);
  }
  if (row.expect_upstream_state_distinct === true) {
    const upstreamState = queryResult.get("state");
    assert.ok(upstreamState, `row ${row.id} must mint an upstream state`);
    assert.notEqual(
      upstreamState,
      CLIENT_STATE,
      `row ${row.id} must mint an upstream state distinct from the client's`,
    );
  }
}

async function executeJourneyCallbackRow(t, row) {
  const session = await newJourneySession(t, row.precondition);
  const harness = session.harness;

  const state = row.state === "precondition" ? session.upstreamState : row.state;
  assert.ok(state !== "", `row ${row.id} needs the precondition's upstream state`);
  const code = row.code === "upstream" ? UPSTREAM_CODE : row.code;
  const query = { code: [code], state: [state] };
  if (row.iss !== undefined && row.iss !== null) {
    query.iss = [row.iss];
  }

  const before = harness.tokenCalls();
  const response = await harness.serve("GET", DEFAULT_CALLBACK_PATH, query, null);

  assert.equal(response.status, row.expect_status, `row ${row.id}`);
  const location = locationOf(response);
  if (row.expect_no_location === true) {
    assert.equal(location, "", `row ${row.id} must not redirect`);
  }
  const body = bodyString(response);
  for (const token of row.expect_body_has ?? []) {
    assert.ok(body.includes(token), `row ${row.id} body must carry ${token}`);
  }
  if (row.expect_location_host !== undefined) {
    assert.ok(
      location.startsWith(`${row.expect_location_host}/`),
      `row ${row.id} location ${location} must be beneath ${row.expect_location_host}`,
    );
  }
  const queryResult = locationQuery(response);
  for (const key of row.expect_location_query_has ?? []) {
    assert.ok(queryResult.has(key), `row ${row.id} location must carry ${key}`);
  }
  for (const [key, value] of Object.entries(row.expect_location_query_equals ?? {})) {
    assert.equal(queryResult.get(key), value, `row ${row.id} location ${key}`);
  }
  if ((row.expect_absent_from_location ?? []).length > 0) {
    const leaked = responseScan(response);
    for (const token of row.expect_absent_from_location) {
      assert.ok(
        !leaked.includes(token),
        `row ${row.id} must not leak ${JSON.stringify(token)} anywhere in the response`,
      );
    }
  }
  if (row.expect_handler_invocations !== undefined) {
    assert.equal(
      session.invocations.count,
      row.expect_handler_invocations,
      `row ${row.id} handler invocations`,
    );
  }
  if (row.expect_upstream_exchange_attempted === false) {
    assert.equal(
      harness.tokenCalls(),
      before,
      `row ${row.id} must attempt no upstream exchange`,
    );
  }
  if (row.expect_transaction_consumed === false) {
    const retry = await harness.serve(
      "GET",
      DEFAULT_CALLBACK_PATH,
      { code: [code], state: [state], iss: [UPSTREAM_ISS] },
      null,
    );
    assert.equal(
      retry.status,
      302,
      `row ${row.id} must leave the transaction unconsumed for a correct retry`,
    );
    assert.ok(
      locationQuery(retry).get("code"),
      `row ${row.id} must complete on the retry`,
    );
  }
  if (row.terminal === true) {
    assert.equal(response.status, 400, `row ${row.id}: a consumed state is terminal`);
    assert.equal(location, "", `row ${row.id}: a consumed state must not redirect`);
    assert.equal(
      harness.tokenCalls(),
      before,
      `row ${row.id}: a consumed state must never re-exchange`,
    );
  }
}

async function executeJourneyTokenRow(t, row) {
  const session = await newJourneySession(t, row.precondition);
  const harness = session.harness;

  let response;
  switch (row.mode) {
    case "exchange":
      response = await harness.token(
        journeyTokenForm(session.facadeCode, VERIFIER),
      );
      break;
    case "replay":
      response = await harness.token(
        journeyTokenForm(session.facadeCode, VERIFIER),
      );
      break;
    case "wrong_verifier":
      response = await harness.token(
        journeyTokenForm(session.facadeCode, JOURNEY_WRONG_VERIFIER),
      );
      break;
    case "refresh":
    case "revoked_refresh":
      assert.ok(session.handle, `row ${row.id} needs the precondition's handle`);
      response = await harness.token({
        grant_type: "refresh_token",
        refresh_token: session.handle,
        client_id: CLIENT_ID,
      });
      break;
    default:
      assert.fail(`row ${row.id} carries unknown token mode ${JSON.stringify(row.mode)}`);
  }

  assert.equal(response.status, row.expect_status, `row ${row.id}`);
  const scanned = bodyString(response);
  for (const token of row.expect_body_has ?? []) {
    assert.ok(scanned.includes(token), `row ${row.id} body must carry ${token}`);
  }
  for (const token of row.expect_body_absent ?? []) {
    assert.ok(!scanned.includes(token), `row ${row.id} must not carry ${token}`);
  }
  if (row.expect_error !== undefined) {
    assert.ok(
      scanned.includes(`"error":"${row.expect_error}"`),
      `row ${row.id} must answer error ${row.expect_error}`,
    );
  }
  if (row.expect_access_token_unchanged === true) {
    const accessToken = journeyTokenField(response, "access_token");
    if (row.mode === "refresh") {
      assert.equal(
        accessToken,
        REFRESH_ACCESS_TOKEN,
        `row ${row.id} must return the upstream refresh access token byte-for-byte`,
      );
    } else {
      assert.ok(
        harness.bearerValidator !== null,
        `row ${row.id} needs the harness's JWKS claims validator`,
      );
      const claims = await harness.bearerValidator(undefined, accessToken);
      assert.ok(
        claims !== null,
        `row ${row.id} must return the upstream-minted access token unchanged`,
      );
    }
  }
  if (row.expect_refresh_handle_opaque === true) {
    const handle = journeyTokenField(response, "refresh_token");
    assert.notEqual(
      handle,
      UPSTREAM_REFRESH_TOKEN,
      `row ${row.id} must not hand back the upstream refresh token`,
    );
  }
  if (row.expect_rotated_handle === true) {
    const handle = journeyTokenField(response, "refresh_token");
    assert.notEqual(handle, session.handle, `row ${row.id} must rotate the route handle`);
  }
  if (row.expect_broker_revoked === true) {
    const record = await harness.stores.routeRefreshBroker.get(
      hashKey(session.handle),
    );
    assert.ok(record !== null, `row ${row.id}`);
    assert.equal(
      record.status,
      "revoked",
      `row ${row.id} must revoke the broker record the code minted`,
    );
  }
  if (row.expect_handler_invocations !== undefined) {
    assert.equal(
      session.invocations.count,
      row.expect_handler_invocations,
      `row ${row.id} handler invocations`,
    );
  }
}

/**
 * Executes the whole minimal non-TMS consumer journey from the shared table
 * through the real mounted routes: every step of MINIMAL_CONSUMER.md is one data
 * row, and the Go, TypeScript, and Python loaders each execute all of them, so
 * the journey is executed from shared data rather than narrated.
 */
test("the shared journey table executes every step through the mounted routes", async (t) => {
  const document = loadJourneyFixture();
  const rows = [];
  for (const row of document.cases ?? []) {
    assert.ok(row.group, `case ${row.id} must carry a group`);
    assert.equal(
      row.group,
      JOURNEY_GROUP,
      `case ${row.id} carries group ${row.group}; the journey loader executes only ${JOURNEY_GROUP}`,
    );
    rows.push(row);
  }
  assert.equal(rows.length, JOURNEY_CASE_COUNT);

  let executed = 0;
  for (const row of rows) {
    executed += 1;
    await t.test(row.id, async (t2) => {
      switch (row.stage) {
        case "transport":
          await executeJourneyTransportRow(t2, row);
          break;
        case "protected_resource":
          await executeJourneyMetadataRow(t2, row, false);
          break;
        case "authorization_server_metadata":
          await executeJourneyMetadataRow(t2, row, true);
          break;
        case "register":
          await executeJourneyRegisterRow(t2, row);
          break;
        case "authorize":
          await executeJourneyAuthorizeRow(t2, row);
          break;
        case "callback":
          await executeJourneyCallbackRow(t2, row);
          break;
        case "token":
          await executeJourneyTokenRow(t2, row);
          break;
        default:
          assert.fail(`row ${row.id} carries unknown stage ${JSON.stringify(row.stage)}`);
      }
    });
  }
  assert.equal(executed, JOURNEY_CASE_COUNT);
});

// ---------------------------------------------------------------------------
// Shared threat-controls table (the same table the Go and Python checkers read)
// ---------------------------------------------------------------------------

const THREAT_CONTROLS_FIXTURE_NAME = "facade-threat-controls.v1.json";

const THREAT_CONTROLS_GROUP = "threat_controls";

/**
 * The number of threat rows the shared table must carry; a change to the table
 * must also be a deliberate edit in the Go and Python checkers, so no runtime
 * can silently check fewer rows.
 */
const THREAT_CONTROLS_CASE_COUNT = 11;

/**
 * The closed pin vocabulary: each source names a table in the corpus and the row
 * shapes a pin is resolved in — a cases[].id, a cases[].name, or a dotted key
 * path.
 */
const THREAT_PIN_SOURCES = {
  journey: { file: "facade-journey.v1.json", byCaseID: true, byKey: true },
  conformance: { file: "facade-conformance.v1.json", byCaseID: true },
  route_model: { file: "facade-route-model.v1.json", byKey: true },
  transport_posture: { file: "facade-transport-posture.v1.json", byKey: true },
  jwks_validator: { file: "jwks-validator.v1.json", byCaseName: true },
  discovery_bootstrap: {
    file: "discovery-bootstrap.v1.json",
    byCaseName: true,
    byKey: true,
  },
  provider_conformance: {
    file: "facade-provider-conformance.v1.json",
    byCaseID: true,
  },
  store_conformance: { file: "facade-store-conformance.v1.json", byCaseID: true },
  route_challenge: { file: "route-challenge.v1.json", byKey: true },
};

function loadThreatControlsFixture() {
  return JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, THREAT_CONTROLS_FIXTURE_NAME), "utf8"),
  );
}

/** Loads one table of the closed pin vocabulary, located exactly as the journey
 * and conformance loaders locate theirs.
 */
function loadPinnedTable(fileName) {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, fileName), "utf8"));
}

/** Reports whether the pin's row is a real id, name, or key inside the table. */
function threatPinResolves(source, row, table) {
  if (source.byCaseID || source.byCaseName) {
    for (const entry of table.cases ?? []) {
      if (
        source.byCaseID &&
        typeof entry.id === "string" &&
        entry.id !== "" &&
        entry.id === row
      ) {
        return true;
      }
      if (
        source.byCaseName &&
        typeof entry.name === "string" &&
        entry.name !== "" &&
        entry.name === row
      ) {
        return true;
      }
    }
  }
  if (!source.byKey) {
    return false;
  }
  let current = table;
  for (const part of row.split(".")) {
    if (current === null || typeof current !== "object" || !(part in current)) {
      return false;
    }
    current = current[part];
  }
  return current !== undefined && current !== null;
}

/**
 * Proves every threat row's pin resolves to an executed row in the table it
 * names, so the shared threat-controls table is bidirectional: dropping a
 * referenced row fails the check, and adding a pin that resolves to nothing
 * fails it too.
 */
test("the shared threat-controls table pins every threat row to an executed row", async (t) => {
  const document = loadThreatControlsFixture();
  assert.equal(document.id, "mcp.auth.facade.threat_controls");
  assert.equal(document.kind, "conformance");
  assert.ok(typeof document.status === "string" && document.status.length > 0);
  assert.ok(
    typeof document.description === "string" && document.description.length > 0,
  );

  const tables = new Map();
  const tableFor = (sourceKey) => {
    if (!tables.has(sourceKey)) {
      tables.set(sourceKey, loadPinnedTable(THREAT_PIN_SOURCES[sourceKey].file));
    }
    return tables.get(sourceKey);
  };

  const rows = [];
  for (const row of document.cases ?? []) {
    assert.ok(row.group, `case ${row.id} must carry a group`);
    assert.equal(
      row.group,
      THREAT_CONTROLS_GROUP,
      `case ${row.id} carries group ${row.group}; the threat-controls checker reads only ${THREAT_CONTROLS_GROUP}`,
    );
    rows.push(row);
  }
  assert.equal(rows.length, THREAT_CONTROLS_CASE_COUNT);

  let checked = 0;
  for (const row of rows) {
    checked += 1;
    await t.test(row.id, () => {
      assert.ok(row.threat, `case ${row.id} must name the attack class`);
      assert.ok(row.control, `case ${row.id} must name the framework control`);
      assert.ok(
        Array.isArray(row.source_pins) && row.source_pins.length > 0,
        `case ${row.id} must preserve the pin strings it was lifted from`,
      );
      if (row.runtime_executable === true) {
        assert.ok(
          Array.isArray(row.pins) && row.pins.length > 0,
          `case ${row.id} is runtime_executable but carries no fixture-backed pin`,
        );
      }
      for (const pin of row.pins ?? []) {
        const source = THREAT_PIN_SOURCES[pin.source];
        assert.ok(
          source,
          `case ${row.id} pin source ${pin.source} is outside the closed pin vocabulary`,
        );
        assert.ok(
          threatPinResolves(source, pin.row, tableFor(pin.source)),
          `case ${row.id} pin ${pin.source}:${pin.row} does not resolve inside ${source.file}`,
        );
      }
    });
  }
  assert.equal(checked, THREAT_CONTROLS_CASE_COUNT);
});

// ---------------------------------------------------------------------------
// RFC 9207 advertisement
// ---------------------------------------------------------------------------

test("front-channel routed metadata advertises the iss it sends", async (t) => {
  const harness = await newFrontChannelHarness(t);

  const metadata = await harness.serve(
    "GET",
    oauthAuthorizationServerPath(harness.endpoint),
    null,
    null,
  );
  assert.equal(metadata.status, 200);
  const document = JSON.parse(bodyString(metadata));
  assert.equal(document.authorization_response_iss_parameter_supported, true);
  assert.equal(typeof document.issuer, "string");
  assert.notEqual(document.issuer, "");

  // The advertised issuer is byte-equal to the `iss` the client callback
  // carries, so the claim matches the front channel's own behavior.
  const { callback } = await harness.authorizeAndCallback();
  assert.equal(locationQuery(callback).get("iss"), document.issuer);
});
