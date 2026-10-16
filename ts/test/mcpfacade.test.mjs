import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import {
  assertBearerTokenReachesTransportHandler,
  assertCredentialFreeTransportDenied,
  countingTransportHandler,
  createApp,
  defaultCapabilities,
  newMemoryBearerTokenValidator,
  registerMcpFacade,
  supportedEndpointTemplates,
  supportedOAuthDiscoveryTemplates,
  supportedOAuthFacadeTemplates,
} from "../dist/index.js";
import {
  MemoryAuthorizationCodeStore,
  MemoryClientStore,
  MemoryRateLimitStore,
  MemoryRouteRefreshBrokerStore,
  MemoryTransactionStore,
} from "../dist/oauth/store.js";

// ---------------------------------------------------------------------------
// Shared contract fixtures (README: consume the same rows as Go)
// ---------------------------------------------------------------------------

function fixture(relative) {
  return JSON.parse(
    readFileSync(new URL(`../../contract-tests/${relative}`, import.meta.url)),
  );
}

const ROUTE_INVENTORY = fixture(
  "fixtures/routing/mcp-route-algebra/facade-route-inventory.json",
);
const EXPECTATIONS = fixture(
  "fixtures/routing/mcp-route-algebra/expectations.json",
);
const TRANSPORT_POSTURE = fixture(
  "fixtures/routing/mcp-auth-facade/facade-transport-posture.v1.json",
);
const ROUTE_MODEL = fixture(
  "fixtures/routing/mcp-auth-facade/facade-route-model.v1.json",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const METADATA_VARY =
  "Host, X-Forwarded-Host, X-AppTheory-Original-Host, X-FaceTheory-Original-Host, Forwarded, CloudFront-Forwarded-Proto, X-Forwarded-Proto";

function validConfig(mode = "public_base_url", overrides = {}) {
  const config = {
    issuerURL: "https://issuer.example.com/",
    jwksURI: "https://issuer.example.com/jwks.json?set=active",
    urlMode: mode,
    publicBaseURL: "https://front.example.com/",
    scopes: {
      namespace: ["namespace:use"],
      partner_namespace: ["partner_namespace:use"],
      agent: ["agent:use"],
      partner_agent: ["partner_agent:use"],
    },
    mcpHandler: () => noContent(),
    transportPosture: "iam",
    ...overrides,
  };
  if (mode === "request_host") {
    config.publicBaseURL = "";
    config.allowedHostnames = ["direct.example.com", "api.example.com"];
  }
  return config;
}

function noContent() {
  return {
    status: 204,
    headers: {},
    cookies: [],
    body: Buffer.alloc(0),
    isBase64: false,
  };
}

function textResponse(body) {
  return {
    status: 200,
    headers: { "content-type": ["text/plain; charset=utf-8"] },
    cookies: [],
    body: Buffer.from(body, "utf8"),
    isBase64: false,
  };
}

function kindHandlerFactory(prefix) {
  return (kind) => () => textResponse(`${prefix}:${kind}`);
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

function serve(app, method, path, headers = {}) {
  return app.serve(request(method, path, headers));
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

function assertMetadataHeaders(response) {
  assert.deepEqual(firstHeader(response.headers, "cache-control"), "no-store");
  assert.deepEqual(firstHeader(response.headers, "vary"), METADATA_VARY);
}

const TEST_ENDPOINTS = [
  { kind: "namespace", path: "/acme/mcp" },
  { kind: "partner_namespace", path: "/acme/partners/reseller/mcp" },
  { kind: "agent", path: "/acme/agents/helper/mcp" },
  {
    kind: "partner_agent",
    path: "/acme/partners/reseller/agents/helper/mcp",
  },
];

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

test("registers the complete contract surface with app-owned handler factories", async () => {
  const app = createApp({ tier: "p0" });
  const config = validConfig();
  config.authorizeHandler = kindHandlerFactory("authorize");
  config.tokenHandler = kindHandlerFactory("token");
  config.registerHandler = kindHandlerFactory("register");
  config.callbackHandler = () => textResponse("callback");

  const inventory = registerMcpFacade(app, config);
  assert.equal(inventory.contractVersion, "m17.mcp-route-algebra/v2");
  assert.equal(inventory.issuerMode, "family");
  assert.equal(inventory.callbackPattern, "/_oauth/mcp/callback");
  assert.equal(inventory.routes.length, 4);

  for (const endpoint of TEST_ENDPOINTS) {
    for (const method of ["POST", "GET", "DELETE"]) {
      assert.equal(
        (await serve(app, method, endpoint.path)).status,
        204,
        `${method} ${endpoint.path}`,
      );
    }
    const prefix = endpoint.path.replace(/\/mcp$/, "");
    assert.equal(
      (await serve(app, "GET", `/.well-known/oauth-protected-resource${prefix}/mcp`))
        .status,
      200,
    );
    assert.equal(
      (
        await serve(
          app,
          "GET",
          `/.well-known/oauth-authorization-server${prefix}/mcp`,
        )
      ).status,
      200,
    );
    assert.equal(
      (await serve(app, "GET", `${prefix}/mcp/.well-known/oauth-authorization-server`))
        .status,
      200,
    );
    const authorize = await serve(
      app,
      "GET",
      `/.well-known/oauth-authorization-server${prefix}/mcp/authorize`,
    );
    assert.equal(authorize.status, 200);
    assert.equal(bodyString(authorize), `authorize:${endpoint.kind}`);
    const token = await serve(
      app,
      "POST",
      `/.well-known/oauth-authorization-server${prefix}/mcp/token`,
    );
    assert.equal(token.status, 200);
    assert.equal(bodyString(token), `token:${endpoint.kind}`);
    const register = await serve(
      app,
      "POST",
      `/.well-known/oauth-authorization-server${prefix}/mcp/register`,
    );
    assert.equal(register.status, 200);
    assert.equal(bodyString(register), `register:${endpoint.kind}`);
  }

  // The callback is one stage-global route, not per kind.
  const callback = await serve(app, "GET", "/_oauth/mcp/callback");
  assert.equal(callback.status, 200);
  assert.equal(bodyString(callback), "callback");
});

test("inventory matches the shared construct fixture", () => {
  const app = createApp({ tier: "p0" });
  const config = validConfig();
  config.authorizeHandler = kindHandlerFactory("authorize");
  config.tokenHandler = kindHandlerFactory("token");
  const inventory = registerMcpFacade(app, config);

  assert.equal(inventory.contractVersion, ROUTE_INVENTORY.contract_version);
  assert.equal(
    inventory.rootAuthorizationServerPattern,
    ROUTE_INVENTORY.root_authorization_server_pattern,
  );
  assert.equal(
    inventory.rootAuthorizationServerAttached,
    ROUTE_INVENTORY.root_authorization_server_attached,
  );
  assert.equal(inventory.callbackPattern, ROUTE_INVENTORY.callback_pattern);
  assert.equal(inventory.issuerMode, ROUTE_INVENTORY.issuer_mode);
  assert.equal(inventory.routes.length, ROUTE_INVENTORY.routes.length);
  inventory.routes.forEach((route, index) => {
    const expected = ROUTE_INVENTORY.routes[index];
    assert.deepEqual(route, {
      kind: expected.kind,
      mcpPattern: expected.mcp_pattern,
      mcpMethods: expected.mcp_methods,
      protectedResourcePattern: expected.protected_resource_pattern,
      discoveryCanonicalPattern: expected.discovery_canonical_pattern,
      discoverySuffixPattern: expected.discovery_suffix_pattern,
      authorizePattern: expected.authorize_pattern,
      tokenPattern: expected.token_pattern,
      registerPattern: expected.register_pattern,
      authorizationRoutesAttached: expected.authorization_routes_attached,
    });
  });
});

// ---------------------------------------------------------------------------
// Metadata byte golden (cross-language)
// ---------------------------------------------------------------------------

test("metadata documents byte-match the shared golden for every kind and URL mode", async () => {
  assert.equal(EXPECTATIONS.documents.length, 10);
  for (const row of EXPECTATIONS.documents) {
    const app = createApp({ tier: "p0" });
    const config = validConfig(row.mode);
    if (row.jwks_uri !== undefined) config.jwksURI = row.jwks_uri;
    if (row.scopes !== undefined) {
      config.scopes = { ...config.scopes, [row.kind]: row.scopes };
    }
    registerMcpFacade(app, config);
    const headers =
      row.mode === "request_host"
        ? { host: ["direct.example.com"], "x-forwarded-proto": ["https"] }
        : {};

    const protectedResource = await serve(
      app,
      "GET",
      row.protected_resource_path,
      headers,
    );
    assert.equal(protectedResource.status, 200, row.name);
    assert.equal(
      bodyString(protectedResource),
      row.protected_resource_document,
      `protected resource document for ${row.name}`,
    );

    const canonical = await serve(app, "GET", row.authorization_server_path, headers);
    assert.equal(canonical.status, 200, row.name);
    assert.equal(
      bodyString(canonical),
      row.authorization_server_document,
      `authorization server document for ${row.name}`,
    );
    const suffix = await serve(
      app,
      "GET",
      row.authorization_server_suffix_path,
      headers,
    );
    assert.equal(
      bodyString(suffix),
      row.authorization_server_document,
      `suffix document for ${row.name}`,
    );
  }
});

test("routed metadata advertises RFC 9207 iss parameter support", async () => {
  const app = createApp({ tier: "p0" });
  const config = validConfig();
  config.rootAuthorizationServer = validRootDiscoveryConfig();
  const inventory = registerMcpFacade(app, config);

  for (const route of inventory.routes) {
    for (const routePath of [
      route.discoveryCanonicalPattern,
      route.discoverySuffixPattern,
    ]) {
      const response = await serve(app, "GET", routePath);
      assert.equal(response.status, 200, routePath);
      assert.equal(
        JSON.parse(bodyString(response))
          .authorization_response_iss_parameter_supported,
        true,
        routePath,
      );
    }
  }

  // Root discovery describes the upstream authorization server, so it does not
  // claim `iss` support.
  const root = await serve(app, "GET", inventory.rootAuthorizationServerPattern);
  assert.equal(root.status, 200);
  assert.equal(
    bodyString(root).includes("authorization_response_iss_parameter_supported"),
    false,
  );
});

test("discovery rebuilds path-parameter identity for every kind", async () => {
  const app = createApp({ tier: "p0" });
  registerMcpFacade(app, validConfig());
  for (const endpoint of TEST_ENDPOINTS) {
    const prefix = endpoint.path.replace(/\/mcp$/, "");
    for (const path of [
      `/.well-known/oauth-authorization-server${prefix}/mcp`,
      `${prefix}/mcp/.well-known/oauth-authorization-server`,
    ]) {
      const response = await serve(app, "GET", path);
      const doc = JSON.parse(bodyString(response));
      assert.equal(
        doc.authorization_endpoint,
        `https://front.example.com/.well-known/oauth-authorization-server${prefix}/mcp/authorize`,
      );
      assert.equal(
        doc.token_endpoint,
        `https://front.example.com/.well-known/oauth-authorization-server${prefix}/mcp/token`,
      );
    }
  }
});

test("every facade metadata response is no-store and varies on origin headers", async () => {
  for (const mode of ["public_base_url", "request_host"]) {
    const app = createApp({ tier: "p0" });
    const config = validConfig(mode);
    config.rootAuthorizationServer = validRootDiscoveryConfig();
    registerMcpFacade(app, config);
    const headers =
      mode === "request_host"
        ? { host: ["direct.example.com"], "x-forwarded-proto": ["https"] }
        : {};
    for (const endpoint of TEST_ENDPOINTS) {
      const prefix = endpoint.path.replace(/\/mcp$/, "");
      for (const path of [
        `/.well-known/oauth-protected-resource${prefix}/mcp`,
        `/.well-known/oauth-authorization-server${prefix}/mcp`,
        `${prefix}/mcp/.well-known/oauth-authorization-server`,
      ]) {
        const response = await serve(app, "GET", path, headers);
        assert.equal(response.status, 200, `${mode} ${path}`);
        assertMetadataHeaders(response);
      }
    }
    const root = await serve(
      app,
      "GET",
      "/.well-known/oauth-authorization-server",
      headers,
    );
    assert.equal(root.status, 200);
    assertMetadataHeaders(root);
  }
});

test("route issuer mode metadata is no-store on both discovery shapes", async () => {
  const app = createApp({ tier: "p0" });
  const config = validConfig();
  config.issuerMode = "route";
  registerMcpFacade(app, config);
  const routeURL = "https://front.example.com/acme/mcp";
  for (const path of [
    "/.well-known/oauth-protected-resource/acme/mcp",
    "/.well-known/oauth-authorization-server/acme/mcp",
    "/acme/mcp/.well-known/oauth-authorization-server",
  ]) {
    const response = await serve(app, "GET", path);
    assert.equal(response.status, 200, path);
    assertMetadataHeaders(response);
    // In route issuer mode the route is its own authorization server.
    const document = JSON.parse(bodyString(response));
    assert.ok(
      document.resource === routeURL || document.issuer === routeURL,
      `${path} must name the route as its own authorization server`,
    );
  }
});

// ---------------------------------------------------------------------------
// Request-host mode
// ---------------------------------------------------------------------------

test("request-host mode uses normalized request headers", async () => {
  const app = createApp({ tier: "p0" });
  registerMcpFacade(app, validConfig("request_host"));
  const response = await serve(
    app,
    "GET",
    "/.well-known/oauth-protected-resource/acme/mcp",
    { host: ["api.example.com"], "x-forwarded-proto": ["https"] },
  );
  assert.equal(response.status, 200);
  assert.equal(
    bodyString(response),
    `{"resource":"https://api.example.com/acme/mcp","authorization_servers":["https://issuer.example.com"],"jwks_uri":"https://issuer.example.com/jwks.json?set=active","scopes_supported":["namespace:use"]}`,
  );
});

test("request-host mode fails closed for spoofed higher-precedence host headers", async () => {
  const spoofs = [
    { host: ["direct.example.com"], "x-forwarded-host": ["evil.example"], "x-forwarded-proto": ["https"] },
    { host: ["direct.example.com"], "x-apptheory-original-host": ["evil.example"], "x-forwarded-proto": ["https"] },
    { host: ["direct.example.com"], "x-facetheory-original-host": ["evil.example"], "x-forwarded-proto": ["https"] },
    { host: ["direct.example.com"], forwarded: ["for=192.0.2.1;host=evil.example;proto=https"] },
  ];
  for (const headers of spoofs) {
    const app = createApp({ tier: "p0" });
    registerMcpFacade(app, validConfig("request_host"));
    const response = await serve(
      app,
      "GET",
      "/.well-known/oauth-authorization-server/acme/mcp",
      headers,
    );
    assert.equal(response.status, 400);
    assert.equal(bodyString(response), '{"error":"invalid_request_host"}');
    assertMetadataHeaders(response);
  }
});

test("request-host mode allows only normalized allowlist matches", async () => {
  const app = createApp({ tier: "p0" });
  const config = validConfig("request_host");
  config.allowedHostnames = ["DIRECT.EXAMPLE.COM.:443", "edge.example.com"];
  registerMcpFacade(app, config);

  const legit = await serve(
    app,
    "GET",
    "/.well-known/oauth-protected-resource/acme/mcp",
    { host: ["direct.example.com:443"], "x-forwarded-proto": ["https"] },
  );
  assert.equal(legit.status, 200);
  assert.equal(
    bodyString(legit),
    `{"resource":"https://direct.example.com/acme/mcp","authorization_servers":["https://issuer.example.com"],"jwks_uri":"https://issuer.example.com/jwks.json?set=active","scopes_supported":["namespace:use"]}`,
  );

  const forwarded = await serve(
    app,
    "GET",
    "/.well-known/oauth-protected-resource/acme/mcp",
    { host: ["direct.example.com"], "x-forwarded-host": ["EDGE.EXAMPLE.COM.:443"], "x-forwarded-proto": ["https"] },
  );
  assert.equal(forwarded.status, 200);
  assert.match(bodyString(forwarded), /"resource":"https:\/\/edge\.example\.com\/acme\/mcp"/);

  const wrongPort = await serve(
    app,
    "GET",
    "/.well-known/oauth-protected-resource/acme/mcp",
    { host: ["edge.example.com:8443"], "x-forwarded-proto": ["https"] },
  );
  assert.equal(wrongPort.status, 400);
  assert.equal(bodyString(wrongPort), '{"error":"invalid_request_host"}');
});

// Pins the shared request_host_allowlist rows: a request whose raw authority
// differs from its decoded canonical form (non-ASCII, percent-escaped, IPv6
// zone, mixed case/trailing dot/default port) must match the allowlist exactly
// as Go does.
test("request-host allowlist canonicalizes the request authority like the shared rows", async () => {
  const rows = EXPECTATIONS.request_host_allowlist;
  assert.ok(rows.length > 0);
  for (const row of rows) {
    const app = createApp({ tier: "p0" });
    const config = validConfig("request_host");
    config.allowedHostnames = [...row.allowed_hostnames];
    registerMcpFacade(app, config);
    const response = await serve(
      app,
      "GET",
      "/.well-known/oauth-protected-resource/acme/mcp",
      { host: [row.request_host], "x-forwarded-proto": ["https"] },
    );
    assert.equal(response.status, row.expect_status, row.name);
    if (row.expect_status !== 200) {
      assert.equal(bodyString(response), '{"error":"invalid_request_host"}', row.name);
      continue;
    }
    assert.equal(JSON.parse(bodyString(response)).resource, row.expect_resource, row.name);
  }
});

// ---------------------------------------------------------------------------
// Root authorization-server discovery
// ---------------------------------------------------------------------------

function validRootDiscoveryConfig() {
  return {
    issuerURL: "https://accounts.example.com",
    authorizationEndpointURL: "https://accounts.example.com/authorize",
    tokenEndpointURL: "https://accounts.example.com/token",
    registrationEndpointURL: "https://accounts.example.com/register",
    jwksURI: "https://accounts.example.com/.well-known/jwks.json",
    scopes: ["openid", "offline_access", "mcp:tools"],
  };
}

test("root authorization-server discovery is opt-in and static", async () => {
  const withoutRoot = createApp({ tier: "p0" });
  let inventory = registerMcpFacade(withoutRoot, validConfig());
  assert.equal(inventory.rootAuthorizationServerAttached, false);
  assert.equal(
    inventory.rootAuthorizationServerPattern,
    "/.well-known/oauth-authorization-server",
  );
  assert.equal(
    (await serve(withoutRoot, "GET", inventory.rootAuthorizationServerPattern)).status,
    404,
  );

  const withRoot = createApp({ tier: "p0" });
  const config = validConfig();
  config.rootAuthorizationServer = validRootDiscoveryConfig();
  inventory = registerMcpFacade(withRoot, config);
  assert.equal(inventory.rootAuthorizationServerAttached, true);
  const response = await serve(withRoot, "GET", inventory.rootAuthorizationServerPattern);
  assert.equal(response.status, 200);
  assert.equal(
    bodyString(response),
    `{"issuer":"https://accounts.example.com","authorization_endpoint":"https://accounts.example.com/authorize","token_endpoint":"https://accounts.example.com/token","registration_endpoint":"https://accounts.example.com/register","jwks_uri":"https://accounts.example.com/.well-known/jwks.json","response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"token_endpoint_auth_methods_supported":["none"],"code_challenge_methods_supported":["S256"],"scopes_supported":["openid","offline_access","mcp:tools"]}`,
  );
});

test("root authorization-server rejects every unsafe URL field before registering", async () => {
  const cases = [
    { mutate: (c) => { c.issuerURL = "https://accounts.example.com?tenant=acme"; }, field: "issuer URL" },
    { mutate: (c) => { c.authorizationEndpointURL = "javascript:alert(1)"; }, field: "authorization endpoint URL" },
    { mutate: (c) => { c.tokenEndpointURL = "https:///token"; }, field: "token endpoint URL" },
    { mutate: (c) => { c.registrationEndpointURL = "https://operator@accounts.example.com/register"; }, field: "registration endpoint URL" },
    { mutate: (c) => { c.jwksURI = "https://accounts.example.com/.well-known/jwks.json#active"; }, field: "JWKS URI" },
  ];
  for (const testCase of cases) {
    const app = createApp({ tier: "p0" });
    const config = validConfig();
    const root = validRootDiscoveryConfig();
    testCase.mutate(root);
    config.rootAuthorizationServer = root;
    assert.throws(() => registerMcpFacade(app, config), new RegExp(testCase.field));
    assert.equal((await serve(app, "POST", "/acme/mcp")).status, 404);
    assert.equal(
      (await serve(app, "GET", "/.well-known/oauth-authorization-server")).status,
      404,
    );
  }
});

// ---------------------------------------------------------------------------
// Application-owned scopes / capabilities / registration endpoint
// ---------------------------------------------------------------------------

test("scopes, capabilities and registration endpoint are application-owned", async () => {
  const app = createApp({ tier: "p0" });
  const config = validConfig();
  config.scopes.agent = [" custom:read ", "custom:read", "custom:write"];
  config.capabilities = {
    responseTypes: [" device_code ", "device_code"],
    grantTypes: ["urn:custom:grant"],
    tokenEndpointAuthMethods: ["client_secret_post"],
    codeChallengeMethods: ["plain"],
  };
  config.registrationEndpointURL = "https://accounts.example.com/custom-register";
  // The configured endpoint is advertised only while the register route is
  // mounted, so this config mounts a register handler.
  config.registerHandler = kindHandlerFactory("register");
  registerMcpFacade(app, config);

  const protectedResource = await serve(
    app,
    "GET",
    "/.well-known/oauth-protected-resource/acme/agents/helper/mcp",
  );
  assert.match(
    bodyString(protectedResource),
    /"scopes_supported":\["custom:read","custom:write"\]/,
  );
  const discovery = await serve(
    app,
    "GET",
    "/.well-known/oauth-authorization-server/acme/agents/helper/mcp",
  );
  assert.equal(
    bodyString(discovery),
    `{"issuer":"https://issuer.example.com","authorization_endpoint":"https://front.example.com/.well-known/oauth-authorization-server/acme/agents/helper/mcp/authorize","token_endpoint":"https://front.example.com/.well-known/oauth-authorization-server/acme/agents/helper/mcp/token","registration_endpoint":"https://accounts.example.com/custom-register","jwks_uri":"https://issuer.example.com/jwks.json?set=active","response_types_supported":["device_code"],"grant_types_supported":["urn:custom:grant"],"token_endpoint_auth_methods_supported":["client_secret_post"],"code_challenge_methods_supported":["plain"],"scopes_supported":["custom:read","custom:write"],"authorization_response_iss_parameter_supported":true}`,
  );
});

test("missing plug points leave the OAuth authorize/token routes unregistered", async () => {
  const app = createApp({ tier: "p0" });
  const inventory = registerMcpFacade(app, validConfig());
  for (const route of inventory.routes) {
    assert.equal(route.authorizationRoutesAttached, true);
  }
  assert.equal(
    (await serve(app, "GET", "/.well-known/oauth-authorization-server/acme/mcp/authorize")).status,
    404,
  );
  assert.equal(
    (await serve(app, "POST", "/.well-known/oauth-authorization-server/acme/mcp/token")).status,
    404,
  );
});

// ---------------------------------------------------------------------------
// Fail-closed mounting
// ---------------------------------------------------------------------------

test("configuration is validated before any route is registered", async () => {
  const cases = [
    { name: "nil MCP handler", mutate: (c) => { c.mcpHandler = null; } },
    { name: "invalid issuer", mutate: (c) => { c.issuerURL = "http://issuer.example.com"; } },
    { name: "issuer query", mutate: (c) => { c.issuerURL += "?tenant=acme"; } },
    { name: "invalid JWKS", mutate: (c) => { c.jwksURI = "/jwks"; } },
    { name: "invalid registration endpoint", mutate: (c) => { c.registrationEndpointURL = "http://accounts.example.com/register"; } },
    { name: "missing URL mode", mutate: (c) => { c.urlMode = ""; } },
    { name: "missing public base", mutate: (c) => { c.publicBaseURL = ""; } },
    { name: "public base query", mutate: (c) => { c.publicBaseURL += "?bad=1"; } },
    { name: "public base path", mutate: (c) => { c.publicBaseURL = "https://front.example.com/base"; } },
    { name: "public base with allowlist", mutate: (c) => { c.allowedHostnames = ["front.example.com"]; } },
    { name: "request host with public base", mutate: (c) => { c.urlMode = "request_host"; } },
    { name: "request host without allowlist", mutate: (c) => { c.urlMode = "request_host"; c.publicBaseURL = ""; } },
    { name: "request host invalid allowlist", mutate: (c) => { c.urlMode = "request_host"; c.publicBaseURL = ""; c.allowedHostnames = ["https://front.example.com"]; } },
    { name: "missing scopes", mutate: (c) => { delete c.scopes.agent; } },
    { name: "empty scope", mutate: (c) => { c.scopes.agent = [" "]; } },
    { name: "unknown scope kind", mutate: (c) => { c.scopes.unknown = ["scope"]; } },
    { name: "empty capability override", mutate: (c) => { c.capabilities = { grantTypes: [] }; } },
    { name: "blank capability", mutate: (c) => { c.capabilities = { responseTypes: [" "] }; } },
    { name: "authorize only", mutate: (c) => { c.authorizeHandler = kindHandlerFactory("authorize"); } },
    { name: "token only", mutate: (c) => { c.tokenHandler = kindHandlerFactory("token"); } },
    { name: "nil authorize result", mutate: (c) => { c.authorizeHandler = () => null; c.tokenHandler = kindHandlerFactory("token"); } },
    { name: "nil token result", mutate: (c) => { c.authorizeHandler = kindHandlerFactory("authorize"); c.tokenHandler = () => null; } },
    { name: "incomplete root discovery", mutate: (c) => { const r = validRootDiscoveryConfig(); r.tokenEndpointURL = ""; c.rootAuthorizationServer = r; } },
    { name: "empty root scopes", mutate: (c) => { const r = validRootDiscoveryConfig(); r.scopes = []; c.rootAuthorizationServer = r; } },
    { name: "invalid callback path", mutate: (c) => { c.upstreamCallbackPath = "callback"; } },
  ];
  for (const testCase of cases) {
    const app = createApp({ tier: "p0" });
    const config = validConfig();
    testCase.mutate(config);
    assert.throws(
      () => registerMcpFacade(app, config),
      undefined,
      `${testCase.name} must throw`,
    );
    assert.equal(
      (await serve(app, "POST", "/acme/mcp")).status,
      404,
      `${testCase.name} must leave no route registered`,
    );
  }
  assert.throws(() => registerMcpFacade(null, validConfig()), /app is required/);
});

test("malformed and unknown paths fail closed", async () => {
  const app = createApp({ tier: "p0" });
  registerMcpFacade(app, validConfig());
  assert.equal((await serve(app, "POST", "/ /mcp")).status, 500);
  assert.equal(
    (await serve(app, "GET", "/.well-known/oauth-protected-resource/ /mcp")).status,
    500,
  );
  assert.equal(
    (await serve(app, "GET", "/.well-known/oauth-authorization-server/ /mcp")).status,
    500,
  );
  assert.equal((await serve(app, "GET", "/unknown/mcp/path")).status, 404);
});

// ---------------------------------------------------------------------------
// Issuer mode + callback override
// ---------------------------------------------------------------------------

test("route issuer mode derives per-route issuer, resource and registration", async () => {
  const app = createApp({ tier: "p0" });
  const config = validConfig();
  config.issuerMode = "route";
  // The route-derived registration URL is advertised only while the register
  // route is mounted, so this config mounts a register handler.
  config.registerHandler = kindHandlerFactory("register");
  const inventory = registerMcpFacade(app, config);
  assert.equal(inventory.issuerMode, "route");

  const routeURL = "https://front.example.com/acme/mcp";
  const protectedResource = await serve(
    app,
    "GET",
    "/.well-known/oauth-protected-resource/acme/mcp",
  );
  assert.deepEqual(JSON.parse(bodyString(protectedResource)), {
    resource: routeURL,
    authorization_servers: [routeURL],
    jwks_uri: "https://issuer.example.com/jwks.json?set=active",
    scopes_supported: ["namespace:use"],
  });

  const discovery = JSON.parse(
    bodyString(await serve(app, "GET", "/.well-known/oauth-authorization-server/acme/mcp")),
  );
  assert.equal(discovery.issuer, routeURL);
  assert.equal(
    discovery.registration_endpoint,
    "https://front.example.com/.well-known/oauth-authorization-server/acme/mcp/register",
  );
});

test("routed metadata advertises registration only while the register route is mounted", async () => {
  const advertised = async (config) => {
    const app = createApp({ tier: "p0" });
    registerMcpFacade(app, config);
    const document = JSON.parse(
      bodyString(
        await serve(
          app,
          "GET",
          "/.well-known/oauth-authorization-server/acme/mcp",
        ),
      ),
    );
    return document.registration_endpoint;
  };

  const family = validConfig();
  assert.equal(await advertised(family), undefined);
  family.registerHandler = kindHandlerFactory("register");
  assert.equal(await advertised(family), "https://issuer.example.com/register");

  const configured = validConfig();
  configured.registrationEndpointURL =
    "https://accounts.example.com/custom-register";
  assert.equal(await advertised(configured), undefined);
  configured.registerHandler = kindHandlerFactory("register");
  assert.equal(
    await advertised(configured),
    "https://accounts.example.com/custom-register",
  );

  const route = validConfig();
  route.issuerMode = "route";
  assert.equal(await advertised(route), undefined);
  route.registerHandler = kindHandlerFactory("register");
  assert.equal(
    await advertised(route),
    "https://front.example.com/.well-known/oauth-authorization-server/acme/mcp/register",
  );
});

test("unknown issuer mode is rejected", () => {
  const config = validConfig();
  config.issuerMode = "tenant";
  assert.throws(() => registerMcpFacade(createApp({ tier: "p0" }), config), /IssuerMode "tenant"/);
});

test("upstream callback path is overridable and defaults to the contract default", async () => {
  const defaultApp = createApp({ tier: "p0" });
  const defaultConfig = validConfig();
  defaultConfig.callbackHandler = () => textResponse("callback");
  const defaultInventory = registerMcpFacade(defaultApp, defaultConfig);
  assert.equal(defaultInventory.callbackPattern, "/_oauth/mcp/callback");
  assert.equal((await serve(defaultApp, "GET", "/_oauth/mcp/callback")).status, 200);

  const customApp = createApp({ tier: "p0" });
  const customConfig = validConfig();
  customConfig.upstreamCallbackPath = "/_oauth/callback";
  customConfig.callbackHandler = () => textResponse("callback");
  const customInventory = registerMcpFacade(customApp, customConfig);
  assert.equal(customInventory.callbackPattern, "/_oauth/callback");
  assert.equal((await serve(customApp, "GET", "/_oauth/callback")).status, 200);
  assert.equal((await serve(customApp, "GET", "/_oauth/mcp/callback")).status, 404);
});

// ---------------------------------------------------------------------------
// Transport posture
// ---------------------------------------------------------------------------

test("default transport posture is authenticated on the default tier", async () => {
  const app = createApp();
  const handler = countingTransportHandler();
  const config = validConfig();
  config.mcpHandler = handler.handler;
  registerMcpFacade(app, config);
  for (const endpoint of TEST_ENDPOINTS) {
    for (const method of ["POST", "GET", "DELETE"]) {
      const response = await serve(app, method, endpoint.path);
      assert.equal(response.status, 401, `${method} ${endpoint.path}`);
    }
  }
  assert.equal(handler.invocations(), 0);
});

test("none-public posture registers no OAuth surface and rejects OAuth configuration", async () => {
  const app = createApp();
  const handler = countingTransportHandler();
  const config = validConfig();
  config.transportPosture = "none-public";
  config.mcpHandler = handler.handler;
  const inventory = registerMcpFacade(app, config);
  for (const route of inventory.routes) {
    assert.equal(route.authorizationRoutesAttached, false);
  }
  assert.equal((await serve(app, "POST", "/acme/mcp")).status, 204);
  assert.equal(handler.invocations(), 1);
  for (const path of [
    "/.well-known/oauth-protected-resource/acme/mcp",
    "/.well-known/oauth-authorization-server/acme/mcp",
    "/acme/mcp/.well-known/oauth-authorization-server",
    "/_oauth/mcp/callback",
  ]) {
    assert.equal((await serve(app, "GET", path)).status, 404, path);
  }
  assert.equal(
    (await serve(app, "GET", "/.well-known/oauth-authorization-server/acme/mcp/authorize")).status,
    404,
  );
  assert.equal(
    (await serve(app, "POST", "/.well-known/oauth-authorization-server/acme/mcp/token")).status,
    404,
  );
});

test("none-public posture rejects OAuth-surface configuration before registering", async () => {
  const cases = [
    { mutate: (c) => { c.authorizeHandler = kindHandlerFactory("authorize"); c.tokenHandler = kindHandlerFactory("token"); }, message: /none-public registers no OAuth surface; authorize\/token handlers/ },
    { mutate: (c) => { c.registerHandler = kindHandlerFactory("register"); }, message: /none-public registers no OAuth surface; RegisterHandler/ },
    { mutate: (c) => { c.callbackHandler = () => textResponse("callback"); }, message: /none-public registers no OAuth surface; CallbackHandler/ },
    { mutate: (c) => { c.rootAuthorizationServer = validRootDiscoveryConfig(); }, message: /none-public cannot enable RootAuthorizationServer/ },
  ];
  for (const testCase of cases) {
    const app = createApp({ tier: "p0" });
    const config = validConfig();
    config.transportPosture = "none-public";
    testCase.mutate(config);
    assert.throws(() => registerMcpFacade(app, config), testCase.message);
    assert.equal((await serve(app, "POST", "/acme/mcp")).status, 404);
  }
});

test("transport posture fails closed before any route is registered", async () => {
  const validator = { validator: () => undefined };
  const cases = [
    { posture: "runtime-bearer", message: /runtime-bearer requires RequireBearerToken/ },
    { posture: "iam", bearer: validator, message: /RequireBearerToken is only valid with TransportPosture runtime-bearer/ },
    { posture: "jwt", bearer: validator, message: /RequireBearerToken is only valid with TransportPosture runtime-bearer/ },
    { posture: "none-public", bearer: validator, message: /none-public cannot be combined with RequireBearerToken/ },
    { posture: "unauthenticated", message: /must be one of iam, jwt, runtime-bearer, none-public/ },
  ];
  for (const testCase of cases) {
    const app = createApp({ tier: "p0" });
    const config = validConfig();
    config.transportPosture = testCase.posture;
    config.requireBearerToken = testCase.bearer;
    assert.throws(() => registerMcpFacade(app, config), testCase.message);
    for (const method of ["POST", "GET", "DELETE"]) {
      assert.equal((await serve(app, method, "/acme/mcp")).status, 404);
    }
    assert.equal(
      (await serve(app, "GET", "/.well-known/oauth-protected-resource/acme/mcp")).status,
      404,
    );
  }
});

test("runtime-bearer denies credential-free requests without invoking the handler", async () => {
  const resourceMetadataURL =
    "https://front.example.com/.well-known/oauth-protected-resource/acme/mcp";
  const app = createApp();
  const handler = countingTransportHandler();
  const config = validConfig();
  config.transportPosture = "runtime-bearer";
  config.mcpHandler = handler.handler;
  config.requireBearerToken = {
    resourceMetadataURL,
    claimsValidator: newMemoryBearerTokenValidator([
      { token: "valid-token", subject: "acme", audience: "https://front.example.com" },
    ]),
  };
  registerMcpFacade(app, config);

  await assertCredentialFreeTransportDenied(app, "POST", "/acme/mcp", resourceMetadataURL, handler);
  await assertBearerTokenReachesTransportHandler(app, "POST", "/acme/mcp", "valid-token", handler);
});

// ---------------------------------------------------------------------------
// Posture fixture
// ---------------------------------------------------------------------------

test("transport posture fixture rows agree with the built inventory", async () => {
  const expectedRuntimeValidation = {
    iam: false,
    jwt: false,
    "runtime-bearer": true,
    "none-public": false,
  };
  const expectedSurfaceAttached = {
    iam: true,
    jwt: true,
    "runtime-bearer": true,
    "none-public": false,
  };
  assert.deepEqual(
    Object.keys(TRANSPORT_POSTURE.postures).sort(),
    Object.keys(expectedRuntimeValidation).sort(),
  );
  for (const posture of Object.keys(expectedRuntimeValidation)) {
    const row = TRANSPORT_POSTURE.postures[posture];
    assert.equal(row.runtime_validation_required, expectedRuntimeValidation[posture]);
    assert.equal(row.oauth_surface_attached, expectedSurfaceAttached[posture]);

    const config = validConfig();
    config.transportPosture = posture;
    if (posture === "runtime-bearer") {
      config.requireBearerToken = { validator: () => undefined };
    }
    const inventory = registerMcpFacade(createApp({ tier: "p0" }), config);
    for (const route of inventory.routes) {
      assert.equal(route.authorizationRoutesAttached, row.oauth_surface_attached, posture);
    }
  }

  // The fixture's credential-free behavior matches the runtime under runtime-bearer.
  const resourceMetadataURL =
    "https://front.example.com/.well-known/oauth-protected-resource/acme/mcp";
  const app = createApp();
  const handler = countingTransportHandler();
  const config = validConfig();
  config.transportPosture = "runtime-bearer";
  config.mcpHandler = handler.handler;
  config.requireBearerToken = {
    resourceMetadataURL,
    claimsValidator: newMemoryBearerTokenValidator([{ token: "valid-token", subject: "acme" }]),
  };
  registerMcpFacade(app, config);
  const response = await serve(app, "POST", "/acme/mcp");
  assert.equal(response.status, TRANSPORT_POSTURE.credential_free_behavior.status);
  const challengeTemplate =
    TRANSPORT_POSTURE.credential_free_behavior.headers["www-authenticate"];
  const expectedChallenge = challengeTemplate.replace(
    "<route protected-resource metadata URL>",
    resourceMetadataURL,
  );
  assert.equal(firstHeader(response.headers, "www-authenticate"), expectedChallenge);
  assert.equal(handler.invocations(), TRANSPORT_POSTURE.credential_free_behavior.handler_invocations);
});

// ---------------------------------------------------------------------------
// Shared route model + helpers
// ---------------------------------------------------------------------------

test("route model fixture patterns, stage-global route and worked example are pinned", async () => {
  assert.deepEqual(Object.keys(ROUTE_MODEL.issuer_modes), ["family", "route"]);
  assert.equal(ROUTE_MODEL.stage_global.length, 1);
  assert.equal(ROUTE_MODEL.stage_global[0].name, "upstream_callback");
  assert.equal(ROUTE_MODEL.stage_global[0].pattern, "/_oauth/mcp/callback");
  assert.deepEqual(ROUTE_MODEL.stage_global[0].methods, ["GET"]);

  // The shared patterns table is exactly the algebra's route enumeration.
  const facadeTemplates = supportedOAuthFacadeTemplates();
  const discoveryTemplates = supportedOAuthDiscoveryTemplates();
  const endpointTemplates = supportedEndpointTemplates();
  ROUTE_MODEL.patterns.forEach((pattern, index) => {
    assert.equal(pattern.mcp_pattern, endpointTemplates[index].mcpPattern);
    assert.equal(pattern.authorize_pattern, facadeTemplates[index].authorizePattern);
    assert.equal(pattern.token_pattern, facadeTemplates[index].tokenPattern);
    assert.equal(pattern.register_pattern, facadeTemplates[index].registerPattern);
    assert.equal(
      pattern.discovery_canonical_pattern,
      discoveryTemplates[index].canonicalPattern,
    );
    assert.equal(
      pattern.discovery_suffix_pattern,
      discoveryTemplates[index].suffixPattern,
    );
  });

  const app = createApp({ tier: "p0" });
  const config = validConfig();
  config.issuerMode = ROUTE_MODEL.worked_example.issuer_mode;
  config.publicBaseURL = ROUTE_MODEL.worked_example.public_base_url;
  registerMcpFacade(app, config);
  const resolved = ROUTE_MODEL.worked_example.resolved;
  const protectedResource = JSON.parse(
    bodyString(await serve(app, "GET", "/.well-known/oauth-protected-resource/acme/mcp")),
  );
  assert.equal(protectedResource.resource, resolved.resource);
  assert.deepEqual(protectedResource.authorization_servers, resolved.authorization_servers);
  const discovery = JSON.parse(
    bodyString(await serve(app, "GET", "/.well-known/oauth-authorization-server/acme/mcp")),
  );
  assert.equal(discovery.issuer, resolved.issuer);
  assert.equal(discovery.authorization_endpoint, resolved.authorization_endpoint);
  assert.equal(discovery.token_endpoint, resolved.token_endpoint);
  // The worked example mounts no register route, so the routed document must
  // omit registration_endpoint rather than advertise a URL that 404s.
  assert.ok(!("registration_endpoint" in discovery));
});

test("default capabilities and defensive inventory clone", () => {
  assert.deepEqual(defaultCapabilities(), {
    responseTypes: ["code"],
    grantTypes: ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethods: ["none"],
    codeChallengeMethods: ["S256"],
  });

  const app = createApp({ tier: "p0" });
  const inventory = registerMcpFacade(app, validConfig());
  const first = inventory.routes[0];
  first.mcpMethods[0] = "PATCH";
  // The returned inventory is a defensive copy of the installed surface.
  const fresh = registerMcpFacade(createApp({ tier: "p0" }), validConfig());
  assert.equal(fresh.routes[0].mcpMethods[0], "POST");
});

// ---------------------------------------------------------------------------
// Shared URL normalization rows (Go is the reference runtime)
// ---------------------------------------------------------------------------

const NAMESPACE_AUTHORIZATION_SERVER_PATH =
  "/.well-known/oauth-authorization-server/acme/mcp";

test("advertised URLs match the shared normalization rows", async () => {
  const rows = EXPECTATIONS.url_normalization;
  assert.equal(rows.length, 66);

  for (const row of rows) {
    const app = createApp({ tier: "p0" });
    const config = validConfig();
    if (row.issuer) {
      config.issuerURL = row.input;
    } else {
      config.jwksURI = row.input;
      config.registrationEndpointURL = row.input;
    }
    // The registration URL is advertised only while the register route is
    // mounted, so the row's expected endpoint is observable.
    config.registerHandler = kindHandlerFactory("register");

    if (row.reject) {
      assert.throws(
        () => registerMcpFacade(app, config),
        undefined,
        `${row.name} must be rejected`,
      );
      continue;
    }

    registerMcpFacade(app, config);
    const document = JSON.parse(
      bodyString(
        await serve(app, "GET", NAMESPACE_AUTHORIZATION_SERVER_PATH),
      ),
    );
    if (row.issuer) {
      assert.equal(document.issuer, row.expect, row.name);
      // The registration endpoint derives from the normalized issuer.
      assert.equal(
        document.registration_endpoint,
        `${row.expect}/register`,
        row.name,
      );
    } else {
      assert.equal(document.jwks_uri, row.expect, row.name);
      assert.equal(document.registration_endpoint, row.expect, row.name);
    }
  }
});

// ---------------------------------------------------------------------------
// Shared registration rejection rows (Go is the reference runtime)
// ---------------------------------------------------------------------------

const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource/acme/mcp";

test("registration rejections match the shared rejection rows", async () => {
  const rows = EXPECTATIONS.rejection_rows;
  assert.equal(rows.length, 51);

  for (const row of rows) {
    const mode = row.kind === "allowed_hostname" ? "request_host" : "public_base_url";
    const app = createApp({ tier: "p0" });
    const config = validConfig(mode);
    if (row.kind === "allowed_hostname") {
      config.allowedHostnames = [row.input];
    } else if (row.kind === "issuer") {
      config.issuerURL = row.input;
    } else if (row.kind === "registration") {
      // The registration endpoint option normalizes through the same
      // non-issuer rule, so a row pins the endpoint position itself.
      config.registrationEndpointURL = row.input;
    } else if (row.kind === "scope") {
      // A lone surrogate cannot be JSON text, so the row names the malformed
      // code point and the runner builds the runtime's ill-formed value.
      assert.equal(row.input_malformed, "lone_surrogate");
      config.scopes = {
        ...config.scopes,
        namespace: [row.input_prefix + "\ud800" + row.input_suffix],
      };
    } else {
      config.jwksURI = row.input;
      config.registrationEndpointURL = row.input;
    }

    if (row.reject) {
      assert.throws(
        () => registerMcpFacade(app, config),
        undefined,
        `${row.name} must be rejected`,
      );
      continue;
    }

    registerMcpFacade(app, config);
    if (row.kind === "allowed_hostname") {
      const response = await serve(app, "GET", PROTECTED_RESOURCE_PATH, {
        host: [row.input],
        "x-forwarded-proto": ["https"],
      });
      assert.equal(response.status, 200, row.name);
      assert.equal(
        JSON.parse(bodyString(response)).resource,
        `https://${row.accept.value}/acme/mcp`,
        row.name,
      );
    } else {
      const document = JSON.parse(
        bodyString(await serve(app, "GET", NAMESPACE_AUTHORIZATION_SERVER_PATH)),
      );
      if (row.kind === "issuer") {
        assert.equal(document.issuer, row.accept.value, row.name);
      } else {
        assert.equal(document.jwks_uri, row.accept.value, row.name);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Framework-owned front-channel field set (DESIGN §8): declared by `provider`
// ---------------------------------------------------------------------------

/** A no-op Provider adapter used only to declare a front channel. */
function stubProvider() {
  return {
    discovery: async () => ({
      issuer: "https://id.example.com",
      authorizationEndpoint: "https://id.example.com/authorize",
      tokenEndpoint: "https://id.example.com/token",
      jwksUri: "https://id.example.com/jwks.json",
      codeChallengeMethodsSupported: ["S256"],
      authorizationResponseIssParameterSupported: true,
      resourceParameterSupported: true,
    }),
    authorizationUrl: async () => "https://id.example.com/authorize",
    exchangeCode: async () => ({ accessToken: "upstream", tokenType: "Bearer" }),
    refresh: async () => ({ accessToken: "upstream", tokenType: "Bearer" }),
    validateAccessToken: async () => ({
      subject: "subject",
      audience: "audience",
      scopes: [],
      authorizedParty: "",
    }),
  };
}

/** The five in-memory reference stores, as one bundle. */
function referenceStores() {
  return {
    transaction: new MemoryTransactionStore(),
    authorizationCode: new MemoryAuthorizationCodeStore(),
    client: new MemoryClientStore(),
    routeRefreshBroker: new MemoryRouteRefreshBrokerStore(),
    rateLimit: new MemoryRateLimitStore(),
  };
}

/** A complete, valid front-channel field set built on the reference stores. */
function frontChannelConfig() {
  return {
    ...validConfig(),
    provider: stubProvider(),
    stores: referenceStores(),
    upstreamClientID: "mcp_facade_client",
    upstreamIssuer: "https://id.example.com",
  };
}

test("front channel config accepts a complete set", () => {
  const app = createApp({ tier: "p0" });
  registerMcpFacade(app, frontChannelConfig());
});

test("front channel config requires every field", () => {
  const cases = [
    ["upstream client id", (c) => (c.upstreamClientID = ""), "upstream client id"],
    [
      "upstream client id whitespace",
      (c) => (c.upstreamClientID = "   "),
      "upstream client id",
    ],
    ["upstream issuer empty", (c) => (c.upstreamIssuer = ""), "upstream issuer"],
    [
      "upstream issuer not https",
      (c) => (c.upstreamIssuer = "http://id.example.com"),
      "upstream issuer",
    ],
    [
      "upstream issuer with query",
      (c) => (c.upstreamIssuer = "https://id.example.com?a=1"),
      "upstream issuer",
    ],
    [
      "empty lifecycle scope",
      (c) => (c.lifecycleScopes = ["offline_access", "  "]),
      "lifecycle scope",
    ],
  ];
  for (const [name, mutate, want] of cases) {
    const config = frontChannelConfig();
    mutate(config);
    assert.throws(() => registerMcpFacade(createApp({ tier: "p0" }), config), {
      message: new RegExp(want),
    }, name);
  }
});

test("front channel config requires every store", () => {
  const cases = [
    ["transaction", (s) => (s.transaction = undefined), "Transaction"],
    [
      "authorization code",
      (s) => (s.authorizationCode = undefined),
      "AuthorizationCode",
    ],
    ["client", (s) => (s.client = undefined), "Client"],
    [
      "route refresh broker",
      (s) => (s.routeRefreshBroker = undefined),
      "RouteRefreshBroker",
    ],
    ["rate limit", (s) => (s.rateLimit = undefined), "RateLimit"],
  ];
  for (const [name, mutate, want] of cases) {
    const config = frontChannelConfig();
    mutate(config.stores);
    let thrown;
    assert.throws(
      () => registerMcpFacade(createApp({ tier: "p0" }), config),
      (err) => {
        thrown = err;
        return true;
      },
      name,
    );
    assert.match(thrown.message, new RegExp(want), name);
    assert.match(thrown.message, /all five stores/, name);
  }
});

test("front channel field set fails closed without provider", () => {
  const cases = [
    ["stores", (c) => (c.stores = referenceStores()), "Stores"],
    ["upstream client id", (c) => (c.upstreamClientID = "mcp_x"), "UpstreamClientID"],
    [
      "upstream issuer",
      (c) => (c.upstreamIssuer = "https://id.example.com"),
      "UpstreamIssuer",
    ],
    [
      "lifecycle scopes",
      (c) => (c.lifecycleScopes = ["offline_access"]),
      "LifecycleScopes",
    ],
    [
      "provider hints",
      (c) => (c.providerHints = () => ({ account_id: "acme" })),
      "ProviderHints",
    ],
  ];
  for (const [name, mutate, want] of cases) {
    const config = validConfig();
    mutate(config);
    let thrown;
    assert.throws(
      () => registerMcpFacade(createApp({ tier: "p0" }), config),
      (err) => {
        thrown = err;
        return true;
      },
      name,
    );
    assert.match(thrown.message, new RegExp(want), name);
    assert.match(thrown.message, /without Provider/, name);
  }
});

test("front channel rejects application-owned handler factories", () => {
  const authorizeAndToken = frontChannelConfig();
  authorizeAndToken.authorizeHandler = kindHandlerFactory("authorize");
  authorizeAndToken.tokenHandler = kindHandlerFactory("token");
  assert.throws(
    () => registerMcpFacade(createApp({ tier: "p0" }), authorizeAndToken),
    /AuthorizeHandler and TokenHandler must not be configured with a front channel/,
  );

  const callback = frontChannelConfig();
  callback.callbackHandler = () => noContent();
  assert.throws(
    () => registerMcpFacade(createApp({ tier: "p0" }), callback),
    /CallbackHandler must not be configured with a front channel/,
  );
});

test("front channel lifecycle scopes are validated like scopes", () => {
  const duplicated = frontChannelConfig();
  duplicated.lifecycleScopes = ["offline_access", "offline_access"];
  registerMcpFacade(createApp({ tier: "p0" }), duplicated);

  const short = frontChannelConfig();
  short.lifecycleScopes = ["aaa"];
  registerMcpFacade(createApp({ tier: "p0" }), short);
});

test("front channel config is validated before any route is registered", async () => {
  const app = createApp({ tier: "p0" });
  const config = frontChannelConfig();
  config.upstreamIssuer = "http://id.example.com";
  assert.throws(() => registerMcpFacade(app, config));

  const response = await serve(app, "GET", PROTECTED_RESOURCE_PATH);
  assert.equal(response.status, 404);
});
