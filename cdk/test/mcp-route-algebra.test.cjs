const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  AppTheoryMcpRouteAlgebra: Algebra,
} = require("../lib/mcp-route-algebra.js");

const expectations = JSON.parse(
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../contract-tests/fixtures/routing/mcp-route-algebra/expectations.json",
    ),
    "utf8",
  ),
);

const routeModel = JSON.parse(
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../contract-tests/fixtures/routing/mcp-auth-facade/facade-route-model.v1.json",
    ),
    "utf8",
  ),
);

function endpointFromFixture(endpoint) {
  return {
    kind: endpoint.kind,
    clientNamespace: endpoint.client_namespace,
    ...(endpoint.partner_id === undefined
      ? {}
      : { partnerId: endpoint.partner_id }),
    ...(endpoint.agent_id === undefined ? {} : { agentId: endpoint.agent_id }),
  };
}

function protectedPathForNormalized(normalized) {
  return normalized === "/"
    ? expectations.contract.protected_resource_prefix
    : expectations.contract.protected_resource_prefix + normalized;
}

test("shared expectations pin every section row count", () => {
  const sections = [
    ["contract.patterns", expectations.contract.patterns, 4],
    ["normalization", expectations.normalization, 8],
    ["derivations", expectations.derivations, 3],
    ["parser.accept", expectations.parser.accept, 4],
    ["parser.reject", expectations.parser.reject, 23],
    ["validation", expectations.validation, 23],
    ["whitespace_boundary", expectations.whitespace_boundary, 26],
    [
      "protected_resource_inverse.accept",
      expectations.protected_resource_inverse.accept,
      3,
    ],
    [
      "protected_resource_inverse.reject",
      expectations.protected_resource_inverse.reject,
      3,
    ],
    ["builders", expectations.builders, 4],
  ];

  let total = 0;
  for (const [name, rows, expectedCount] of sections) {
    assert.equal(rows.length, expectedCount, `${name} row count`);
    total += rows.length;
  }
  assert.equal(total, 101, "total expectation row count");
});

test("shared expectations pin constants and every template derivation", () => {
  const contract = expectations.contract;
  assert.equal(Algebra.CONTRACT_VERSION, contract.version);
  assert.equal(Algebra.CONTRACT_VERSION, "m17.mcp-route-algebra/v2");
  assert.equal(Algebra.CONTRACT_VERSION_V1, "m17.mcp-route-algebra/v1");
  assert.equal(
    Algebra.DEFAULT_CALLBACK_PATH,
    routeModel.contract.default_callback_path,
  );
  assert.equal(
    Algebra.PROTECTED_RESOURCE_PREFIX,
    contract.protected_resource_prefix,
  );
  assert.equal(
    Algebra.AUTHORIZATION_SERVER_PREFIX,
    contract.authorization_server_prefix,
  );
  assert.deepEqual(
    [
      Algebra.ENDPOINT_KIND_NAMESPACE,
      Algebra.ENDPOINT_KIND_PARTNER_NAMESPACE,
      Algebra.ENDPOINT_KIND_AGENT,
      Algebra.ENDPOINT_KIND_PARTNER_AGENT,
    ],
    contract.endpoint_kinds,
  );
  assert.deepEqual(
    [
      Algebra.NAMESPACE_MCP_PATTERN,
      Algebra.PARTNER_NAMESPACE_MCP_PATTERN,
      Algebra.AGENT_MCP_PATTERN,
      Algebra.PARTNER_AGENT_MCP_PATTERN,
    ],
    contract.patterns.map((row) => row.mcp_pattern),
  );
  assert.deepEqual(
    Algebra.supportedEndpointTemplates(),
    contract.patterns.map((row) => ({
      kind: row.kind,
      mcpPattern: row.mcp_pattern,
      protectedResourcePath: row.protected_resource_path,
    })),
  );
  assert.deepEqual(
    Algebra.supportedOAuthFacadeTemplates(),
    contract.patterns.map((row) => ({
      kind: row.kind,
      authorizePattern: row.authorize_path,
      tokenPattern: row.token_path,
      registerPattern: row.register_path,
    })),
  );
  assert.deepEqual(
    Algebra.supportedOAuthDiscoveryTemplates(),
    contract.patterns.map((row) => ({
      kind: row.kind,
      canonicalPattern: row.authorization_server_path,
      suffixPattern: row.authorization_server_suffix_path,
    })),
  );
});

test("shared expectations pin normalization equivalence", () => {
  for (const row of expectations.normalization) {
    assert.equal(
      Algebra.protectedResourcePathForResourcePath(row.input),
      protectedPathForNormalized(row.normalized),
      row.name,
    );
  }
});

test("shared expectations pin every route derivation", () => {
  for (const row of expectations.derivations) {
    assert.equal(
      Algebra.protectedResourcePathForResourcePath(row.input),
      row.protected_resource_path,
      row.name,
    );
    assert.equal(
      Algebra.protectedResourcePathFromMcpPath(row.input),
      row.protected_resource_path,
      row.name,
    );
    assert.equal(
      Algebra.authorizationServerPathForResourcePath(row.input),
      row.authorization_server_path,
      row.name,
    );
    assert.equal(
      Algebra.authorizationAuthorizePathForResourcePath(row.input),
      row.authorize_path,
      row.name,
    );
    assert.equal(
      Algebra.authorizationTokenPathForResourcePath(row.input),
      row.token_path,
      row.name,
    );
    assert.equal(
      Algebra.authorizationRegisterPathForResourcePath(row.input),
      row.register_path,
      row.name,
    );
    assert.equal(
      Algebra.authorizationServerSuffixPathForResourcePath(row.input),
      row.authorization_server_suffix_path,
      row.name,
    );
  }
});

test("shared expectations pin the exact ASCII whitespace boundary", () => {
  const included = [];
  const excluded = [];
  for (const row of expectations.whitespace_boundary) {
    assert.equal(
      Algebra.protectedResourcePathForResourcePath(row.normalization_input),
      protectedPathForNormalized(row.normalized),
      `${row.code_point} normalization`,
    );
    assert.deepEqual(
      Algebra.parseMcpPath(row.parser_input),
      endpointFromFixture(row.parser_endpoint),
      `${row.code_point} parser`,
    );
    const endpoint = { kind: "namespace", clientNamespace: row.character };
    if (row.segment_valid) {
      assert.doesNotThrow(
        () => Algebra.validateEndpointPath(endpoint),
        row.code_point,
      );
    } else {
      assert.throws(
        () => Algebra.validateEndpointPath(endpoint),
        undefined,
        row.code_point,
      );
    }
    (row.in_trim_set ? included : excluded).push(row.code_point);
  }
  assert.deepEqual(
    included.sort(),
    [...expectations.contract.ascii_trim_code_points].sort(),
  );
  assert.deepEqual(
    excluded.sort(),
    [...expectations.contract.excluded_whitespace_code_points].sort(),
  );
});

test("shared expectations pin parser accepts and rejects", () => {
  for (const row of expectations.parser.accept) {
    assert.deepEqual(
      Algebra.parseMcpPath(row.input),
      endpointFromFixture(row.endpoint),
      row.name,
    );
  }
  for (const row of expectations.parser.reject) {
    assert.throws(() => Algebra.parseMcpPath(row.input), undefined, row.name);
  }
});

test("shared expectations pin endpoint validation", () => {
  for (const row of expectations.validation) {
    const endpoint = endpointFromFixture(row.endpoint);
    if (row.valid) {
      assert.doesNotThrow(
        () => Algebra.validateEndpointPath(endpoint),
        row.name,
      );
    } else {
      assert.throws(
        () => Algebra.validateEndpointPath(endpoint),
        undefined,
        row.name,
      );
    }
  }
});

test("shared expectations pin every concrete builder", () => {
  for (const row of expectations.builders) {
    const endpoint = endpointFromFixture(row.endpoint);
    assert.equal(Algebra.mcpPath(endpoint), row.mcp_path);
    assert.equal(
      Algebra.protectedResourcePath(endpoint),
      row.protected_resource_path,
    );
    assert.equal(
      Algebra.oauthAuthorizationServerPath(endpoint),
      row.authorization_server_path,
    );
    assert.equal(Algebra.oauthAuthorizePath(endpoint), row.authorize_path);
    assert.equal(Algebra.oauthTokenPath(endpoint), row.token_path);
    assert.equal(Algebra.oauthRegisterPath(endpoint), row.register_path);
    assert.equal(
      Algebra.oauthAuthorizationServerSuffixPath(endpoint),
      row.authorization_server_suffix_path,
    );
  }
});

test("shared expectations pin protected-resource inverse behavior", () => {
  for (const row of expectations.protected_resource_inverse.accept) {
    assert.equal(
      Algebra.resourcePathFromProtectedResourcePath(row.input),
      row.resource_path,
    );
  }
  for (const input of expectations.protected_resource_inverse.reject) {
    assert.throws(() => Algebra.resourcePathFromProtectedResourcePath(input));
  }
});

test("all builders reject an invalid endpoint", () => {
  const endpoint = {
    kind: "partner_agent",
    clientNamespace: "acme",
    partnerId: "pay",
  };
  for (const builder of [
    Algebra.mcpPath,
    Algebra.protectedResourcePath,
    Algebra.oauthAuthorizationServerPath,
    Algebra.oauthAuthorizePath,
    Algebra.oauthTokenPath,
    Algebra.oauthRegisterPath,
    Algebra.oauthAuthorizationServerSuffixPath,
  ]) {
    assert.throws(() => builder.call(Algebra, endpoint));
  }
});

test("v2 vocabulary pins the issuer modes and stage-global routes", () => {
  assert.deepEqual(
    Algebra.supportedIssuerModes(),
    Object.keys(routeModel.issuer_modes),
  );
  assert.equal(Algebra.ISSUER_MODE_FAMILY, "family");
  assert.equal(Algebra.ISSUER_MODE_ROUTE, "route");
  assert.deepEqual(
    Algebra.supportedStageGlobalRoutes(),
    routeModel.stage_global.map((row) => ({
      name: row.name,
      pattern: row.pattern,
      methods: row.methods,
    })),
  );
  assert.deepEqual(Algebra.supportedStageGlobalRoutes(), [
    { name: "upstream_callback", pattern: "/_oauth/mcp/callback", methods: ["GET"] },
  ]);
});

test("shared route model pins the callback override derivations", () => {
  const override = routeModel.callback_override;
  assert.equal(override.default, routeModel.contract.default_callback_path);
  assert.equal(Algebra.DEFAULT_CALLBACK_PATH, override.default);
  assert.equal(Algebra.callbackPathForConfiguredPath(""), override.default);
  assert.equal(Algebra.callbackPathForConfiguredPath("   "), override.default);
  assert.equal(Algebra.normalizeCallbackPath(override.default), override.default);

  for (const row of override.cases) {
    if (row.expect_error) {
      assert.throws(
        () => Algebra.callbackPathForConfiguredPath(row.configured),
        undefined,
        `callbackPathForConfiguredPath ${JSON.stringify(row)}`,
      );
      assert.throws(
        () => Algebra.normalizeCallbackPath(row.configured),
        undefined,
        `normalizeCallbackPath ${JSON.stringify(row)}`,
      );
      continue;
    }
    assert.equal(
      Algebra.callbackPathForConfiguredPath(row.configured),
      row.expect_pattern,
      JSON.stringify(row),
    );
  }
});

test("shared route model pins the derived route-path charset", () => {
  const section = routeModel.route_path_charset;
  assert.ok(section, "the route model must carry a route_path_charset section");
  assert.ok(
    Array.isArray(section.cases) && section.cases.length > 0,
    "the route_path_charset section must carry cases",
  );
  for (const row of section.cases) {
    if (row.expect_error) {
      assert.throws(
        () => Algebra.parseMcpPath(row.path),
        undefined,
        `parseMcpPath ${JSON.stringify(row)}`,
      );
      continue;
    }
    assert.deepEqual(
      Algebra.parseMcpPath(row.path),
      { kind: Algebra.ENDPOINT_KIND_NAMESPACE, clientNamespace: "acme" },
      JSON.stringify(row),
    );
  }
});

// The shared minimal non-TMS consumer journey (the table the Go, TypeScript, and
// Python suites execute row by row). CDK does not run the journey, but its
// transport-credential-free and protected-resource-metadata rows must agree with
// the route model CDK synthesizes, so a route-algebra change cannot silently
// invalidate the challenge or the metadata path the journey pins.
const journey = JSON.parse(
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../contract-tests/fixtures/routing/mcp-auth-facade/facade-journey.v1.json",
    ),
    "utf8",
  ),
);

// The journey world's route, expressed the way the algebra helpers take it.
const journeyEndpoint = {
  kind: journey.notes.world.route_kind,
  clientNamespace: journey.notes.world.client_namespace,
};

// The ordered step names MINIMAL_CONSUMER.md numbers 1 through 11 (the composite
// steps carry dotted names), so a dropped or renamed step row fails here too.
const journeyStepNames = [
  "transport-credential-free",
  "protected-resource-metadata",
  "authorization-server-metadata",
  "register-public-client",
  "register-disallowed-redirect",
  "register-rate-limited",
  "authorize-front-channel",
  "authorize-unregistered-client",
  "authorize-unmatched-redirect",
  "authorize-missing-challenge",
  "authorize-plain-challenge",
  "authorize-wrong-resource",
  "callback-upstream-return",
  "callback-iss-mismatch",
  "callback-replayed-state",
  "callback-forged-state",
  "callback-absent-iss",
  "token-code-exchange",
  "token-replay-code",
  "token-wrong-verifier",
  "transport-with-valid-token",
  "transport-wrong-audience",
  "token-refresh",
  "refresh-revoked-handle",
  "transport-expired-token",
  "transport-insufficient-scope",
];

test("the shared journey table exists, carries one group, and agrees with the route model", () => {
  assert.equal(journey.id, "mcp.auth.facade.journey");
  assert.equal(journey.kind, "conformance");
  assert.equal(typeof journey.description, "string");
  assert.ok(journey.description.length > 0, "the journey table must carry a description");
  assert.ok(Array.isArray(journey.cases), "the journey table must carry cases");

  const groups = new Set(journey.cases.map((row) => row.group));
  assert.deepEqual([...groups], ["journey"], "the journey table carries exactly one group");
  assert.equal(journey.cases.length, journeyStepNames.length, "journey step count");
  assert.deepEqual(
    journey.cases.map((row) => row.id),
    journeyStepNames.map((name) => `journey.${name}`),
    "journey step ids must be the ordered steps 1-11",
  );

  // The world the journey pins must be the world the route model derives, member
  // for member, from the framework's own route algebra.
  const world = journey.notes.world;
  const worked = routeModel.worked_example;
  assert.equal(world.public_base_url, worked.public_base_url);
  assert.equal(world.route_kind, worked.kind);
  assert.equal(world.client_namespace, worked.params.client_namespace);
  assert.equal(world.resource, worked.resolved.resource);
  assert.equal(
    world.protected_resource_metadata_url,
    worked.resolved.protected_resource_metadata_url,
  );
  assert.equal(world.discovery_url, worked.resolved.discovery_url);
  assert.equal(world.authorization_endpoint, worked.resolved.authorization_endpoint);
  assert.equal(world.token_endpoint, worked.resolved.token_endpoint);
  assert.equal(world.issuer, worked.resolved.issuer);

  assert.equal(Algebra.mcpPath(journeyEndpoint), "/acme/mcp");
  assert.equal(
    worked.resolved.resource,
    world.public_base_url + Algebra.mcpPath(journeyEndpoint),
  );
  assert.equal(
    worked.resolved.protected_resource_metadata_url,
    world.public_base_url + Algebra.protectedResourcePath(journeyEndpoint),
  );
  assert.equal(
    worked.resolved.authorization_endpoint,
    world.public_base_url + Algebra.oauthAuthorizePath(journeyEndpoint),
  );
  assert.equal(
    worked.resolved.token_endpoint,
    world.public_base_url + Algebra.oauthTokenPath(journeyEndpoint),
  );
  assert.equal(
    world.registration_endpoint,
    world.public_base_url + Algebra.oauthRegisterPath(journeyEndpoint),
  );
  assert.equal(
    world.callback_url,
    world.public_base_url + routeModel.contract.default_callback_path,
  );

  // The transport-credential-free row's challenge names exactly that
  // algebra-derived protected-resource metadata URL, and the
  // protected-resource-metadata row advertises exactly the algebra-derived
  // resource.
  const byId = new Map(journey.cases.map((row) => [row.id, row]));
  const credentialFree = byId.get("journey.transport-credential-free");
  assert.equal(credentialFree.expect_status, 401);
  assert.equal(credentialFree.expect_challenge_resource_metadata, true);
  assert.equal(credentialFree.expect_handler_invocations, 0);

  const metadata = byId.get("journey.protected-resource-metadata");
  assert.equal(metadata.expect_status, 200);
  assert.equal(metadata.expect_no_store, true);
  assert.ok(
    metadata.expect_body_has.includes(`"resource":"${worked.resolved.resource}"`),
    "the protected-resource row must pin the algebra-derived route resource",
  );
  assert.ok(
    metadata.expect_body_has.includes(
      `"authorization_servers":["${worked.resolved.issuer}"]`,
    ),
    "the protected-resource row must pin the algebra-derived authorization server",
  );
});

// The shared threat-controls table (the table the Go, TypeScript, and Python
// suites resolve every threat row against). CDK does not run the facade
// mechanics, but the rows it can see -- the per-route issuer the mix-up defense
// depends on, above all -- must resolve against the tables CDK already loads, so
// a route-algebra change cannot silently invalidate a threat-control pin.
const threatControls = JSON.parse(
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../contract-tests/fixtures/routing/mcp-auth-facade/facade-threat-controls.v1.json",
    ),
    "utf8",
  ),
);

/** The number of threat rows the shared table must carry (T1-T11). */
const THREAT_CONTROLS_CASE_COUNT = 11;

/** Reports whether a dotted key path exists inside a loaded table. */
function dottedKeyExists(document, keyPath) {
  let current = document;
  for (const part of keyPath.split(".")) {
    if (current === null || typeof current !== "object" || !(part in current)) {
      return false;
    }
    current = current[part];
  }
  return current !== undefined && current !== null;
}

/**
 * Resolves one threat-control pin against the tables this suite loads, or null
 * when the pin names a table CDK does not load.
 */
function cdkPinResolves(pin) {
  if (pin.source === "journey") {
    return (
      journey.cases.some((row) => row.id === pin.row) ||
      dottedKeyExists(journey, pin.row)
    );
  }
  if (pin.source === "route_model") {
    return dottedKeyExists(routeModel, pin.row);
  }
  return null;
}

test("the shared threat-controls table resolves every CDK-visible pin against the loaded tables", () => {
  assert.equal(threatControls.id, "mcp.auth.facade.threat_controls");
  assert.equal(threatControls.kind, "conformance");
  assert.ok(
    typeof threatControls.description === "string" &&
      threatControls.description.length > 0,
    "the threat-controls table must carry a description",
  );
  assert.ok(Array.isArray(threatControls.cases), "the threat-controls table must carry cases");

  const groups = new Set(threatControls.cases.map((row) => row.group));
  assert.deepEqual(
    [...groups],
    ["threat_controls"],
    "the threat-controls table carries exactly one group",
  );
  assert.equal(
    threatControls.cases.length,
    THREAT_CONTROLS_CASE_COUNT,
    "threat row count",
  );
  assert.deepEqual(
    threatControls.cases.map((row) => row.id),
    Array.from(
      { length: THREAT_CONTROLS_CASE_COUNT },
      (_unused, index) => `threat.t${index + 1}`,
    ),
    "threat row ids must be T1-T11",
  );

  const visible = threatControls.cases.filter((row) => row.cdk_visible === true);
  assert.ok(visible.length > 0, "at least one threat row must be CDK-visible");
  for (const row of visible) {
    assert.ok(
      Array.isArray(row.pins) && row.pins.length > 0,
      `CDK-visible case ${row.id} must carry fixture-backed pins`,
    );
    for (const pin of row.pins) {
      const resolved = cdkPinResolves(pin);
      assert.notEqual(
        resolved,
        null,
        `CDK-visible case ${row.id} pins ${pin.source}:${pin.row}, whose source this suite does not load`,
      );
      assert.ok(
        resolved,
        `case ${row.id} pin ${pin.source}:${pin.row} does not resolve inside the table CDK loads`,
      );
    }
  }

  // T4 (mix-up / confused deputy) is the row the CDK side can see: the facade's
  // per-route issuer mode is what makes a proxied upstream's tokens unusable at
  // any other route.
  const t4 = threatControls.cases.find((row) => row.id === "threat.t4");
  assert.ok(
    t4.pins.some(
      (pin) => pin.source === "route_model" && pin.row === "issuer_modes.route",
    ),
    "T4 must pin the per-route issuer mode",
  );
  assert.equal(routeModel.issuer_modes.route.discovery_issuer, "<route URL>");
});
