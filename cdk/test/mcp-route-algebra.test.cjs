const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AppTheoryMcpRouteAlgebra: Algebra,
} = require("../lib");

test("exports the versioned constants and canonical quartet", () => {
  assert.equal(Algebra.CONTRACT_VERSION, "m17.mcp-route-algebra/v1");
  assert.equal(
    Algebra.PROTECTED_RESOURCE_PREFIX,
    "/.well-known/oauth-protected-resource",
  );
  assert.equal(
    Algebra.AUTHORIZATION_SERVER_PREFIX,
    "/.well-known/oauth-authorization-server",
  );
  assert.deepEqual(
    [
      Algebra.ENDPOINT_KIND_NAMESPACE,
      Algebra.ENDPOINT_KIND_PARTNER_NAMESPACE,
      Algebra.ENDPOINT_KIND_AGENT,
      Algebra.ENDPOINT_KIND_PARTNER_AGENT,
    ],
    ["namespace", "partner_namespace", "agent", "partner_agent"],
  );
  assert.deepEqual(
    [
      Algebra.NAMESPACE_MCP_PATTERN,
      Algebra.PARTNER_NAMESPACE_MCP_PATTERN,
      Algebra.AGENT_MCP_PATTERN,
      Algebra.PARTNER_AGENT_MCP_PATTERN,
    ],
    [
      "/{client_namespace}/mcp",
      "/{client_namespace}/partners/{partner_id}/mcp",
      "/{client_namespace}/agents/{agent_id}/mcp",
      "/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp",
    ],
  );
});

test("normalizes the same contract input table as Go", () => {
  const cases = [
    ["mcp", "/.well-known/oauth-protected-resource/mcp"],
    ["/mcp/", "/.well-known/oauth-protected-resource/mcp"],
    ["//a//b//", "/.well-known/oauth-protected-resource/a/b"],
    ["/a/./b/../c", "/.well-known/oauth-protected-resource/a/c"],
    ["/", "/.well-known/oauth-protected-resource"],
    ["  /acme/mcp/  ", "/.well-known/oauth-protected-resource/acme/mcp"],
    ["   ", "/.well-known/oauth-protected-resource"],
    ["/../../a", "/.well-known/oauth-protected-resource/a"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(
      Algebra.protectedResourcePathForResourcePath(input),
      expected,
      input,
    );
  }
});

test("derives every route form including root, trailing, and nested paths", () => {
  const cases = [
    {
      input: "/",
      protected: "/.well-known/oauth-protected-resource",
      server: "/.well-known/oauth-authorization-server",
      authorize: "/.well-known/oauth-authorization-server/authorize",
      token: "/.well-known/oauth-authorization-server/token",
      suffix: "/.well-known/oauth-authorization-server",
    },
    {
      input: "/acme/mcp/",
      protected: "/.well-known/oauth-protected-resource/acme/mcp",
      server: "/.well-known/oauth-authorization-server/acme/mcp",
      authorize:
        "/.well-known/oauth-authorization-server/acme/mcp/authorize",
      token: "/.well-known/oauth-authorization-server/acme/mcp/token",
      suffix: "/acme/mcp/.well-known/oauth-authorization-server",
    },
    {
      input: "  //acme//partners/./pay/agents/old/../bot/mcp//  ",
      protected:
        "/.well-known/oauth-protected-resource/acme/partners/pay/agents/bot/mcp",
      server:
        "/.well-known/oauth-authorization-server/acme/partners/pay/agents/bot/mcp",
      authorize:
        "/.well-known/oauth-authorization-server/acme/partners/pay/agents/bot/mcp/authorize",
      token:
        "/.well-known/oauth-authorization-server/acme/partners/pay/agents/bot/mcp/token",
      suffix:
        "/acme/partners/pay/agents/bot/mcp/.well-known/oauth-authorization-server",
    },
  ];

  for (const expected of cases) {
    assert.equal(
      Algebra.protectedResourcePathForResourcePath(expected.input),
      expected.protected,
    );
    assert.equal(
      Algebra.protectedResourcePathFromMcpPath(expected.input),
      expected.protected,
    );
    assert.equal(
      Algebra.authorizationServerPathForResourcePath(expected.input),
      expected.server,
    );
    assert.equal(
      Algebra.authorizationAuthorizePathForResourcePath(expected.input),
      expected.authorize,
    );
    assert.equal(
      Algebra.authorizationTokenPathForResourcePath(expected.input),
      expected.token,
    );
    assert.equal(
      Algebra.authorizationServerSuffixPathForResourcePath(expected.input),
      expected.suffix,
    );
  }
});

test("recovers resource paths only from the protected-resource prefix", () => {
  assert.equal(
    Algebra.resourcePathFromProtectedResourcePath(
      "/.well-known/oauth-protected-resource",
    ),
    "/",
  );
  assert.equal(
    Algebra.resourcePathFromProtectedResourcePath(
      " /.well-known/oauth-protected-resource/acme/mcp/ ",
    ),
    "/acme/mcp",
  );
  assert.equal(
    Algebra.resourcePathFromProtectedResourcePath(
      "//.well-known//oauth-protected-resource//acme//mcp",
    ),
    "/acme/mcp",
  );

  for (const input of [
    "/",
    "/.well-known/oauth-protected-resources/acme/mcp",
    "/x/.well-known/oauth-protected-resource/acme/mcp",
  ]) {
    assert.throws(() => Algebra.resourcePathFromProtectedResourcePath(input));
  }
});

test("enumerates endpoint templates with hardcoded order and content", () => {
  assert.deepEqual(Algebra.supportedEndpointTemplates(), [
    {
      kind: "namespace",
      mcpPattern: "/{client_namespace}/mcp",
      protectedResourcePath:
        "/.well-known/oauth-protected-resource/{client_namespace}/mcp",
    },
    {
      kind: "partner_namespace",
      mcpPattern: "/{client_namespace}/partners/{partner_id}/mcp",
      protectedResourcePath:
        "/.well-known/oauth-protected-resource/{client_namespace}/partners/{partner_id}/mcp",
    },
    {
      kind: "agent",
      mcpPattern: "/{client_namespace}/agents/{agent_id}/mcp",
      protectedResourcePath:
        "/.well-known/oauth-protected-resource/{client_namespace}/agents/{agent_id}/mcp",
    },
    {
      kind: "partner_agent",
      mcpPattern:
        "/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp",
      protectedResourcePath:
        "/.well-known/oauth-protected-resource/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp",
    },
  ]);
});

test("enumerates OAuth facade templates with hardcoded order and content", () => {
  assert.deepEqual(Algebra.supportedOAuthFacadeTemplates(), [
    {
      kind: "namespace",
      authorizePattern:
        "/.well-known/oauth-authorization-server/{client_namespace}/mcp/authorize",
      tokenPattern:
        "/.well-known/oauth-authorization-server/{client_namespace}/mcp/token",
    },
    {
      kind: "partner_namespace",
      authorizePattern:
        "/.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/mcp/authorize",
      tokenPattern:
        "/.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/mcp/token",
    },
    {
      kind: "agent",
      authorizePattern:
        "/.well-known/oauth-authorization-server/{client_namespace}/agents/{agent_id}/mcp/authorize",
      tokenPattern:
        "/.well-known/oauth-authorization-server/{client_namespace}/agents/{agent_id}/mcp/token",
    },
    {
      kind: "partner_agent",
      authorizePattern:
        "/.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp/authorize",
      tokenPattern:
        "/.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp/token",
    },
  ]);
});

test("enumerates OAuth discovery templates with hardcoded order and content", () => {
  assert.deepEqual(Algebra.supportedOAuthDiscoveryTemplates(), [
    {
      kind: "namespace",
      canonicalPattern:
        "/.well-known/oauth-authorization-server/{client_namespace}/mcp",
      suffixPattern:
        "/{client_namespace}/mcp/.well-known/oauth-authorization-server",
    },
    {
      kind: "partner_namespace",
      canonicalPattern:
        "/.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/mcp",
      suffixPattern:
        "/{client_namespace}/partners/{partner_id}/mcp/.well-known/oauth-authorization-server",
    },
    {
      kind: "agent",
      canonicalPattern:
        "/.well-known/oauth-authorization-server/{client_namespace}/agents/{agent_id}/mcp",
      suffixPattern:
        "/{client_namespace}/agents/{agent_id}/mcp/.well-known/oauth-authorization-server",
    },
    {
      kind: "partner_agent",
      canonicalPattern:
        "/.well-known/oauth-authorization-server/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp",
      suffixPattern:
        "/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp/.well-known/oauth-authorization-server",
    },
  ]);
});

test("parses canonical and normalized MCP paths", () => {
  const cases = [
    [
      "/acme/mcp",
      { kind: "namespace", clientNamespace: "acme" },
    ],
    [
      " acme//partners/pay/mcp/ ",
      {
        kind: "partner_namespace",
        clientNamespace: "acme",
        partnerId: "pay",
      },
    ],
    [
      "/acme/old/../agents/bot/mcp",
      { kind: "agent", clientNamespace: "acme", agentId: "bot" },
    ],
    [
      "//acme/partners/pay/agents/bot/mcp//",
      {
        kind: "partner_agent",
        clientNamespace: "acme",
        partnerId: "pay",
        agentId: "bot",
      },
    ],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(Algebra.parseMcpPath(input), expected);
  }
});

test("rejects unsupported and unsafe MCP paths", () => {
  for (const input of [
    "/",
    "/acme",
    "/acme/mcp/extra",
    "/acme/partners/pay/other",
    "/acme/agents/bot/other",
    "/acme/partners/pay/agents/bot/other",
    "/acme/agents/bot/agents/other/mcp",
    "/ /mcp",
    "/acme/partners/ /mcp",
    "/acme/agents/ /mcp",
    "/acme/partners/pay/agents/ /mcp",
  ]) {
    assert.throws(() => Algebra.parseMcpPath(input), undefined, input);
  }
});

test("validates the complete kind and identifier matrix", () => {
  const cases = [
    [{ kind: "namespace", clientNamespace: "acme" }, true],
    [{ kind: "namespace", clientNamespace: "" }, false],
    [
      { kind: "namespace", clientNamespace: "acme", partnerId: "pay" },
      false,
    ],
    [
      { kind: "namespace", clientNamespace: "acme", agentId: "bot" },
      false,
    ],
    [
      {
        kind: "partner_namespace",
        clientNamespace: "acme",
        partnerId: "pay",
      },
      true,
    ],
    [{ kind: "partner_namespace", clientNamespace: "acme" }, false],
    [
      {
        kind: "partner_namespace",
        clientNamespace: "acme",
        partnerId: "pay",
        agentId: "bot",
      },
      false,
    ],
    [
      { kind: "agent", clientNamespace: "acme", agentId: "bot" },
      true,
    ],
    [{ kind: "agent", clientNamespace: "acme" }, false],
    [
      {
        kind: "agent",
        clientNamespace: "acme",
        partnerId: "pay",
        agentId: "bot",
      },
      false,
    ],
    [
      {
        kind: "partner_agent",
        clientNamespace: "acme",
        partnerId: "pay",
        agentId: "bot",
      },
      true,
    ],
    [
      {
        kind: "partner_agent",
        clientNamespace: "acme",
        agentId: "bot",
      },
      false,
    ],
    [
      {
        kind: "partner_agent",
        clientNamespace: "acme",
        partnerId: "pay",
      },
      false,
    ],
    [{ kind: "namespace", clientNamespace: "acme/bad" }, false],
    [
      {
        kind: "partner_namespace",
        clientNamespace: "acme",
        partnerId: "pay/bad",
      },
      false,
    ],
    [
      { kind: "agent", clientNamespace: "acme", agentId: "bot/bad" },
      false,
    ],
    [{ kind: "other", clientNamespace: "acme" }, false],
  ];

  for (const [endpoint, valid] of cases) {
    if (valid) {
      assert.doesNotThrow(() => Algebra.validateEndpointPath(endpoint));
    } else {
      assert.throws(() => Algebra.validateEndpointPath(endpoint));
    }
  }
});

test("builds every route form for every endpoint kind", () => {
  const cases = [
    {
      endpoint: { kind: "namespace", clientNamespace: "acme" },
      mcp: "/acme/mcp",
      protected: "/.well-known/oauth-protected-resource/acme/mcp",
      server: "/.well-known/oauth-authorization-server/acme/mcp",
      authorize:
        "/.well-known/oauth-authorization-server/acme/mcp/authorize",
      token: "/.well-known/oauth-authorization-server/acme/mcp/token",
      suffix: "/acme/mcp/.well-known/oauth-authorization-server",
    },
    {
      endpoint: {
        kind: "partner_namespace",
        clientNamespace: "acme",
        partnerId: "pay",
      },
      mcp: "/acme/partners/pay/mcp",
      protected:
        "/.well-known/oauth-protected-resource/acme/partners/pay/mcp",
      server:
        "/.well-known/oauth-authorization-server/acme/partners/pay/mcp",
      authorize:
        "/.well-known/oauth-authorization-server/acme/partners/pay/mcp/authorize",
      token:
        "/.well-known/oauth-authorization-server/acme/partners/pay/mcp/token",
      suffix:
        "/acme/partners/pay/mcp/.well-known/oauth-authorization-server",
    },
    {
      endpoint: { kind: "agent", clientNamespace: "acme", agentId: "bot" },
      mcp: "/acme/agents/bot/mcp",
      protected:
        "/.well-known/oauth-protected-resource/acme/agents/bot/mcp",
      server:
        "/.well-known/oauth-authorization-server/acme/agents/bot/mcp",
      authorize:
        "/.well-known/oauth-authorization-server/acme/agents/bot/mcp/authorize",
      token:
        "/.well-known/oauth-authorization-server/acme/agents/bot/mcp/token",
      suffix:
        "/acme/agents/bot/mcp/.well-known/oauth-authorization-server",
    },
    {
      endpoint: {
        kind: "partner_agent",
        clientNamespace: "acme",
        partnerId: "pay",
        agentId: "bot",
      },
      mcp: "/acme/partners/pay/agents/bot/mcp",
      protected:
        "/.well-known/oauth-protected-resource/acme/partners/pay/agents/bot/mcp",
      server:
        "/.well-known/oauth-authorization-server/acme/partners/pay/agents/bot/mcp",
      authorize:
        "/.well-known/oauth-authorization-server/acme/partners/pay/agents/bot/mcp/authorize",
      token:
        "/.well-known/oauth-authorization-server/acme/partners/pay/agents/bot/mcp/token",
      suffix:
        "/acme/partners/pay/agents/bot/mcp/.well-known/oauth-authorization-server",
    },
  ];

  for (const expected of cases) {
    assert.equal(Algebra.mcpPath(expected.endpoint), expected.mcp);
    assert.equal(
      Algebra.protectedResourcePath(expected.endpoint),
      expected.protected,
    );
    assert.equal(
      Algebra.oauthAuthorizationServerPath(expected.endpoint),
      expected.server,
    );
    assert.equal(
      Algebra.oauthAuthorizePath(expected.endpoint),
      expected.authorize,
    );
    assert.equal(Algebra.oauthTokenPath(expected.endpoint), expected.token);
    assert.equal(
      Algebra.oauthAuthorizationServerSuffixPath(expected.endpoint),
      expected.suffix,
    );
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
