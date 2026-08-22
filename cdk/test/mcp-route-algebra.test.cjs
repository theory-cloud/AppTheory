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
    Algebra.oauthAuthorizationServerSuffixPath,
  ]) {
    assert.throws(() => builder.call(Algebra, endpoint));
  }
});
