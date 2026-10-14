import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AGENT_MCP_PATTERN,
  AUTHORIZATION_SERVER_PREFIX,
  CALLBACK_PATTERN_KEY,
  CONTRACT_VERSION,
  CONTRACT_VERSION_V1,
  DEFAULT_CALLBACK_PATH,
  ENDPOINT_KIND_AGENT,
  ENDPOINT_KIND_NAMESPACE,
  ENDPOINT_KIND_PARTNER_AGENT,
  ENDPOINT_KIND_PARTNER_NAMESPACE,
  ISSUER_MODE_FAMILY,
  ISSUER_MODE_ROUTE,
  NAMESPACE_MCP_PATTERN,
  PARAM_AGENT_ID,
  PARAM_CLIENT_NAMESPACE,
  PARAM_PARTNER_ID,
  PARTNER_AGENT_MCP_PATTERN,
  PARTNER_NAMESPACE_MCP_PATTERN,
  PROTECTED_RESOURCE_PREFIX,
  authorizationAuthorizePathForResourcePath,
  authorizationRegisterPathForResourcePath,
  authorizationServerPathForResourcePath,
  authorizationServerSuffixPathForResourcePath,
  authorizationTokenPathForResourcePath,
  callbackPathForConfiguredPath,
  mcpPath,
  normalizeCallbackPath,
  oauthAuthorizationServerPath,
  oauthAuthorizationServerSuffixPath,
  oauthAuthorizePath,
  oauthRegisterPath,
  oauthTokenPath,
  parseMcpPath,
  protectedResourcePath,
  protectedResourcePathForResourcePath,
  protectedResourcePathFromMcpPath,
  resourcePathFromProtectedResourcePath,
  supportedEndpointTemplates,
  supportedIssuerModes,
  supportedOAuthDiscoveryTemplates,
  supportedOAuthFacadeTemplates,
  supportedStageGlobalRoutes,
  validateEndpointPath,
} from "../dist/index.js";

// The fixture lives at <repo>/contract-tests/...; this test file is in ts/test/.
const expectations = JSON.parse(
  readFileSync(
    new URL(
      "../../contract-tests/fixtures/routing/mcp-route-algebra/expectations.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

// The stage-global callback override is pinned by the facade route model so the
// CDK construct and every runtime resolve the same derivations.
const facadeRouteModel = JSON.parse(
  readFileSync(
    new URL(
      "../../contract-tests/fixtures/routing/mcp-auth-facade/facade-route-model.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function expectedEndpoint(expectation) {
  const endpoint = {
    kind: expectation.kind,
    clientNamespace: expectation.client_namespace,
  };
  if (expectation.partner_id !== undefined) {
    endpoint.partnerId = expectation.partner_id;
  }
  if (expectation.agent_id !== undefined) {
    endpoint.agentId = expectation.agent_id;
  }
  return endpoint;
}

function expectedProtectedResource(normalized) {
  if (normalized === "/") {
    return PROTECTED_RESOURCE_PREFIX;
  }
  return `${PROTECTED_RESOURCE_PREFIX}${normalized}`;
}

test("shared expectation row counts", () => {
  const sections = [
    ["contract.patterns", expectations.contract.patterns.length, 4],
    ["normalization", expectations.normalization.length, 8],
    ["derivations", expectations.derivations.length, 3],
    ["parser.accept", expectations.parser.accept.length, 4],
    ["parser.reject", expectations.parser.reject.length, 23],
    ["validation", expectations.validation.length, 23],
    ["whitespace_boundary", expectations.whitespace_boundary.length, 26],
    [
      "protected_resource_inverse.accept",
      expectations.protected_resource_inverse.accept.length,
      3,
    ],
    [
      "protected_resource_inverse.reject",
      expectations.protected_resource_inverse.reject.length,
      3,
    ],
    ["builders", expectations.builders.length, 4],
  ];

  let total = 0;
  for (const [name, got, want] of sections) {
    assert.equal(got, want, name);
    total += got;
  }
  assert.equal(total, 101);
});

test("contract constants and template enumerations match the fixture", () => {
  assert.equal(CONTRACT_VERSION, expectations.contract.version);
  assert.equal(CONTRACT_VERSION_V1, "m17.mcp-route-algebra/v1");
  assert.equal(
    PROTECTED_RESOURCE_PREFIX,
    expectations.contract.protected_resource_prefix,
  );
  assert.equal(
    AUTHORIZATION_SERVER_PREFIX,
    expectations.contract.authorization_server_prefix,
  );
  assert.equal(PARAM_CLIENT_NAMESPACE, "client_namespace");
  assert.equal(PARAM_PARTNER_ID, "partner_id");
  assert.equal(PARAM_AGENT_ID, "agent_id");

  assert.deepEqual(
    [
      ENDPOINT_KIND_NAMESPACE,
      ENDPOINT_KIND_PARTNER_NAMESPACE,
      ENDPOINT_KIND_AGENT,
      ENDPOINT_KIND_PARTNER_AGENT,
    ],
    expectations.contract.endpoint_kinds,
  );
  assert.deepEqual(
    [
      NAMESPACE_MCP_PATTERN,
      PARTNER_NAMESPACE_MCP_PATTERN,
      AGENT_MCP_PATTERN,
      PARTNER_AGENT_MCP_PATTERN,
    ],
    expectations.contract.patterns.map((row) => row.mcp_pattern),
  );

  assert.deepEqual(
    supportedEndpointTemplates(),
    expectations.contract.patterns.map((row) => ({
      kind: row.kind,
      mcpPattern: row.mcp_pattern,
      protectedResourcePath: row.protected_resource_path,
    })),
  );
  assert.deepEqual(
    supportedOAuthFacadeTemplates(),
    expectations.contract.patterns.map((row) => ({
      kind: row.kind,
      authorizePattern: row.authorize_path,
      tokenPattern: row.token_path,
      registerPattern: row.register_path,
    })),
  );
  assert.deepEqual(
    supportedOAuthDiscoveryTemplates(),
    expectations.contract.patterns.map((row) => ({
      kind: row.kind,
      canonicalPattern: row.authorization_server_path,
      suffixPattern: row.authorization_server_suffix_path,
    })),
  );
});

test("normalization rows resolve through the protected-resource prefix rule", () => {
  for (const row of expectations.normalization) {
    assert.equal(
      protectedResourcePathForResourcePath(row.input),
      expectedProtectedResource(row.normalized),
      `normalization ${row.name}`,
    );
  }
});

test("derivation rows match every pure derivation", () => {
  for (const row of expectations.derivations) {
    assert.equal(
      protectedResourcePathForResourcePath(row.input),
      row.protected_resource_path,
      `protected resource ${row.name}`,
    );
    assert.equal(
      protectedResourcePathFromMcpPath(row.input),
      row.protected_resource_path,
      `protected resource from mcp ${row.name}`,
    );
    assert.equal(
      authorizationServerPathForResourcePath(row.input),
      row.authorization_server_path,
      `authorization server ${row.name}`,
    );
    assert.equal(
      authorizationAuthorizePathForResourcePath(row.input),
      row.authorize_path,
      `authorize ${row.name}`,
    );
    assert.equal(
      authorizationTokenPathForResourcePath(row.input),
      row.token_path,
      `token ${row.name}`,
    );
    assert.equal(
      authorizationRegisterPathForResourcePath(row.input),
      row.register_path,
      `register ${row.name}`,
    );
    assert.equal(
      authorizationServerSuffixPathForResourcePath(row.input),
      row.authorization_server_suffix_path,
      `authorization server suffix ${row.name}`,
    );
  }
});

test("parser accepts and rejects the fixture rows", () => {
  for (const row of expectations.parser.accept) {
    assert.deepEqual(
      parseMcpPath(row.input),
      expectedEndpoint(row.endpoint),
      `accept ${row.name}`,
    );
  }
  for (const row of expectations.parser.reject) {
    assert.throws(
      () => parseMcpPath(row.input),
      undefined,
      `reject ${row.name}`,
    );
  }
});

test("validation rows validate or throw per `valid`", () => {
  for (const row of expectations.validation) {
    const endpoint = expectedEndpoint(row.endpoint);
    if (row.valid) {
      assert.doesNotThrow(
        () => validateEndpointPath(endpoint),
        `valid ${row.name}`,
      );
    } else {
      assert.throws(
        () => validateEndpointPath(endpoint),
        undefined,
        `invalid ${row.name}`,
      );
    }
  }
});

test("whitespace boundary rows match normalization, parsing, and segment safety", () => {
  for (const row of expectations.whitespace_boundary) {
    assert.equal(
      protectedResourcePathForResourcePath(row.normalization_input),
      expectedProtectedResource(row.normalized),
      `normalization ${row.code_point}`,
    );
    assert.deepEqual(
      parseMcpPath(row.parser_input),
      expectedEndpoint(row.parser_endpoint),
      `parser ${row.code_point}`,
    );
    if (row.segment_valid) {
      assert.deepEqual(
        parseMcpPath(`/${row.character}/mcp`),
        {
          kind: ENDPOINT_KIND_NAMESPACE,
          clientNamespace: row.character,
        },
        `segment valid ${row.code_point}`,
      );
    } else {
      assert.throws(
        () => parseMcpPath(`/${row.character}/mcp`),
        undefined,
        `segment invalid ${row.code_point}`,
      );
    }
  }
});

test("protected-resource inverse accepts and rejects the fixture rows", () => {
  for (const row of expectations.protected_resource_inverse.accept) {
    assert.equal(
      resourcePathFromProtectedResourcePath(row.input),
      row.resource_path,
      row.input,
    );
  }
  for (const input of expectations.protected_resource_inverse.reject) {
    assert.throws(
      () => resourcePathFromProtectedResourcePath(input),
      undefined,
      input,
    );
  }
});

test("endpoint builders match the fixture rows", () => {
  for (const row of expectations.builders) {
    const endpoint = expectedEndpoint(row.endpoint);
    assert.equal(mcpPath(endpoint), row.mcp_path);
    assert.equal(protectedResourcePath(endpoint), row.protected_resource_path);
    assert.equal(
      oauthAuthorizationServerPath(endpoint),
      row.authorization_server_path,
    );
    assert.equal(oauthAuthorizePath(endpoint), row.authorize_path);
    assert.equal(oauthTokenPath(endpoint), row.token_path);
    assert.equal(oauthRegisterPath(endpoint), row.register_path);
    assert.equal(
      oauthAuthorizationServerSuffixPath(endpoint),
      row.authorization_server_suffix_path,
    );
  }
});

test("builders reject an invalid endpoint", () => {
  const invalid = {
    kind: ENDPOINT_KIND_PARTNER_AGENT,
    clientNamespace: "acme",
    partnerId: "pay",
  };
  const builders = [
    mcpPath,
    protectedResourcePath,
    oauthAuthorizationServerPath,
    oauthAuthorizePath,
    oauthTokenPath,
    oauthRegisterPath,
    oauthAuthorizationServerSuffixPath,
  ];
  for (const builder of builders) {
    assert.throws(() => builder(invalid));
  }
});

test("stage-global callback route and issuer modes", () => {
  const rows = expectations.stage_global;
  assert.equal(
    rows.length,
    1,
    "the fixture pins exactly one stage-global route",
  );
  const routes = supportedStageGlobalRoutes();
  assert.equal(routes.length, rows.length);
  assert.deepEqual(
    routes.map((route) => ({
      name: route.name,
      pattern: route.pattern,
      methods: route.methods,
    })),
    rows,
    "stage-global routes must match the shared fixture",
  );
  assert.equal(CALLBACK_PATTERN_KEY, rows[0].name);
  assert.equal(DEFAULT_CALLBACK_PATH, rows[0].pattern);
  assert.equal(ISSUER_MODE_FAMILY, expectations.issuer_modes[0]);
  assert.equal(ISSUER_MODE_ROUTE, expectations.issuer_modes[1]);
  assert.deepEqual(supportedIssuerModes(), expectations.issuer_modes);
});

test("callback path resolution and normalization", () => {
  const table = expectations.callback_path;
  assert.equal(DEFAULT_CALLBACK_PATH, table.default);
  for (const row of table.accept) {
    assert.equal(
      callbackPathForConfiguredPath(row.configured),
      row.expected,
      JSON.stringify(row.configured),
    );
  }
  for (const bad of table.reject) {
    assert.throws(() => normalizeCallbackPath(bad), undefined, bad);
  }
  assert.throws(() => callbackPathForConfiguredPath(table.reject[0]));
});

test("shared facade route model pins the callback override derivations", () => {
  const override = facadeRouteModel.callback_override;
  assert.equal(override.default, facadeRouteModel.contract.default_callback_path);
  assert.equal(DEFAULT_CALLBACK_PATH, override.default);
  for (const row of override.cases) {
    if (row.expect_error) {
      assert.throws(
        () => callbackPathForConfiguredPath(row.configured),
        undefined,
        `callbackPathForConfiguredPath ${JSON.stringify(row)}`,
      );
      assert.throws(
        () => normalizeCallbackPath(row.configured),
        undefined,
        `normalizeCallbackPath ${JSON.stringify(row)}`,
      );
      continue;
    }
    assert.equal(
      callbackPathForConfiguredPath(row.configured),
      row.expect_pattern,
      JSON.stringify(row),
    );
  }
});

test("shared facade route model pins the derived route-path charset", () => {
  const section = facadeRouteModel.route_path_charset;
  assert.ok(section, "the route model must carry a route_path_charset section");
  assert.ok(
    Array.isArray(section.cases) && section.cases.length > 0,
    "the route_path_charset section must carry cases",
  );
  for (const row of section.cases) {
    if (row.expect_error) {
      assert.throws(
        () => parseMcpPath(row.path),
        undefined,
        `parseMcpPath ${JSON.stringify(row)}`,
      );
      continue;
    }
    assert.deepEqual(
      parseMcpPath(row.path),
      { kind: ENDPOINT_KIND_NAMESPACE, clientNamespace: "acme" },
      JSON.stringify(row),
    );
  }
});
