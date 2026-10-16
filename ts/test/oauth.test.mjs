import test from "node:test";
import assert from "node:assert/strict";

import {
  ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE,
  ERR_BEARER_TOKEN_INVALID_AUDIENCE,
  OAuthBearerError,
  bearerTokenClaimsFromContext,
  insufficientScopeWWWAuthenticate,
  newAuthorizationServerMetadata,
  newMemoryBearerTokenValidator,
  newProtectedResourceMetadata,
  pkceChallengeS256,
  pkceVerifyS256,
  protectedResourceWWWAuthenticate,
  requireBearerTokenMiddleware,
  resourceIndicatorMatches,
  resourceMetadataURLFromMcpEndpoint,
  validateDynamicClientRegistrationRequest,
} from "../dist/index.js";

function ctx(headers = {}, path = "/mcp") {
  const values = new Map();
  return {
    request: { headers, path },
    set: (key, value) => values.set(key, value),
    get: (key) => values.get(key),
  };
}

test("OAuth protected resource metadata and challenge are deterministic", () => {
  const metadata = newProtectedResourceMetadata("https://mcp.example.com/mcp", [
    "https://auth.example.com",
  ]);
  metadata.scopes_supported = ["mcp:read"];
  metadata.bearer_methods_supported = ["header"];
  assert.deepEqual(metadata, {
    resource: "https://mcp.example.com/mcp",
    authorization_servers: ["https://auth.example.com"],
    scopes_supported: ["mcp:read"],
    bearer_methods_supported: ["header"],
  });
  assert.equal(
    resourceMetadataURLFromMcpEndpoint("https://mcp.example.com/mcp"),
    "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
  );
  assert.equal(
    protectedResourceWWWAuthenticate(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    ),
    'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
  );
});

test("OAuth bearer middleware distinguishes unauthorized, forbidden, and insufficient scope", async () => {
  const validator = newMemoryBearerTokenValidator(
    [
      {
        token: "valid",
        subject: "user-1",
        audience: "https://mcp.example.com/mcp",
        scopes: ["mcp:read"],
        expiresAt: new Date(1_700_003_600_000),
      },
      {
        token: "scope-miss",
        subject: "user-1",
        audience: "https://mcp.example.com/mcp",
        scopes: ["mcp:write"],
        expiresAt: new Date(1_700_003_600_000),
      },
      {
        token: "audience-miss",
        subject: "user-1",
        audience: "https://other.example.com/mcp",
        scopes: ["mcp:read"],
        expiresAt: new Date(1_700_003_600_000),
      },
    ],
    {
      requiredAudience: "https://mcp.example.com/mcp",
      requiredScopes: ["mcp:read"],
      now: () => new Date(1_700_000_000_000),
    },
  );
  const mw = requireBearerTokenMiddleware({
    resourceMetadataURL: "https://mcp.example.com/pr",
    requiredScopes: ["mcp:read"],
    claimsValidator: validator,
  });
  const missing = await mw(ctx(), async () =>
    assert.fail("next should not run"),
  );
  assert.equal(missing.status, 401);
  assert.equal(
    missing.headers["www-authenticate"][0],
    'Bearer resource_metadata="https://mcp.example.com/pr"',
  );
  const insufficient = await mw(
    ctx({ authorization: ["Bearer scope-miss"] }),
    async () => assert.fail("next should not run"),
  );
  assert.equal(insufficient.status, 403);
  assert.equal(
    insufficient.headers["www-authenticate"][0],
    'Bearer error="insufficient_scope", scope="mcp:read", resource_metadata="https://mcp.example.com/pr"',
  );
  assert.deepEqual(
    JSON.parse(Buffer.from(insufficient.body).toString("utf8")),
    {
      error: {
        code: "app.insufficient_scope",
        message: "insufficient scope",
        status_code: 403,
      },
    },
  );
  const forbidden = await mw(
    ctx({ authorization: ["Bearer audience-miss"] }),
    async () => assert.fail("next should not run"),
  );
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers["www-authenticate"], undefined);
  assert.deepEqual(
    JSON.parse(Buffer.from(forbidden.body).toString("utf8")),
    { error: { code: "app.forbidden", message: "forbidden", status_code: 403 } },
  );
  await assert.rejects(
    validator(ctx(), "scope-miss"),
    (err) =>
      err instanceof OAuthBearerError &&
      err.oauthCode === ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE,
  );
  await assert.rejects(
    validator(ctx(), "audience-miss"),
    (err) =>
      err instanceof OAuthBearerError &&
      err.oauthCode === ERR_BEARER_TOKEN_INVALID_AUDIENCE,
  );
  const acceptedCtx = ctx({ authorization: ["Bearer valid"] });
  const accepted = await mw(acceptedCtx, async () => ({
    status: 200,
    headers: {},
    cookies: [],
    body: new Uint8Array(),
    isBase64: false,
  }));
  assert.equal(accepted.status, 200);
  assert.deepEqual(bearerTokenClaimsFromContext(acceptedCtx).scopes, [
    "mcp:read",
  ]);
});

test("OAuth bearer validator honours route-derived audience and scope resolvers", async () => {
  const validator = newMemoryBearerTokenValidator(
    [
      {
        token: "acme-token",
        subject: "user-1",
        audience: "https://mcp.example.com/acme/mcp",
        scopes: ["mcp:read", "mcp:write"],
        expiresAt: new Date(1_700_003_600_000),
      },
      {
        token: "peer-token",
        subject: "user-2",
        audience: "https://mcp.example.com/other/mcp",
        scopes: ["mcp:read"],
        expiresAt: new Date(1_700_003_600_000),
      },
    ],
    {
      requiredAudience: (c) => `https://mcp.example.com${c.request.path}`,
      requiredScopes: (c) =>
        c.request.path === "/acme/mcp"
          ? ["mcp:read", "mcp:write"]
          : ["mcp:admin"],
      now: () => new Date(1_700_000_000_000),
    },
  );
  const claims = await validator(
    ctx({ authorization: ["Bearer acme-token"] }, "/acme/mcp"),
    "acme-token",
  );
  assert.deepEqual(claims.scopes, ["mcp:read", "mcp:write"]);
  await assert.rejects(
    validator(ctx({ authorization: ["Bearer peer-token"] }, "/other/mcp"), "peer-token"),
    (err) =>
      err instanceof OAuthBearerError &&
      err.oauthCode === ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE,
  );
});

test("OAuth scope failure carries the route-derived RFC 6750 challenge", async () => {
  const validator = newMemoryBearerTokenValidator(
    [
      {
        token: "scoped-token",
        subject: "user-1",
        audience: "https://mcp.example.com/acme/mcp",
        scopes: ["mcp:read"],
        expiresAt: new Date(1_700_003_600_000),
      },
    ],
    {
      requiredAudience: () => "https://mcp.example.com/acme/mcp",
      requiredScopes: () => ["mcp:read", "mcp:write"],
      now: () => new Date(1_700_000_000_000),
    },
  );
  const mw = requireBearerTokenMiddleware({
    resourceMetadataURL: () =>
      "https://mcp.example.com/.well-known/oauth-protected-resource/acme/mcp",
    requiredScopes: () => ["mcp:read", "mcp:write"],
    claimsValidator: validator,
  });
  const resp = await mw(
    ctx({ authorization: ["Bearer scoped-token"] }, "/acme/mcp"),
    async () => assert.fail("next should not run"),
  );
  assert.equal(resp.status, 403);
  assert.equal(
    resp.headers["www-authenticate"][0],
    'Bearer error="insufficient_scope", scope="mcp:read mcp:write", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/acme/mcp"',
  );
  assert.deepEqual(JSON.parse(Buffer.from(resp.body).toString("utf8")), {
    error: {
      code: "app.insufficient_scope",
      message: "insufficient scope",
      status_code: 403,
    },
  });
});

test("OAuth audience failure is a plain 403 with no challenge", async () => {
  const validator = newMemoryBearerTokenValidator(
    [
      {
        token: "wrong-audience-token",
        subject: "user-1",
        audience: "https://other.example.com/mcp",
        scopes: ["mcp:read"],
        expiresAt: new Date(1_700_003_600_000),
      },
    ],
    {
      requiredAudience: () => "https://mcp.example.com/acme/mcp",
      now: () => new Date(1_700_000_000_000),
    },
  );
  const mw = requireBearerTokenMiddleware({
    resourceMetadataURL: () =>
      "https://mcp.example.com/.well-known/oauth-protected-resource/acme/mcp",
    requiredScopes: () => ["mcp:read"],
    claimsValidator: validator,
  });
  const resp = await mw(
    ctx({ authorization: ["Bearer wrong-audience-token"] }, "/acme/mcp"),
    async () => assert.fail("next should not run"),
  );
  assert.equal(resp.status, 403);
  assert.equal(resp.headers["www-authenticate"], undefined);
  assert.deepEqual(JSON.parse(Buffer.from(resp.body).toString("utf8")), {
    error: { code: "app.forbidden", message: "forbidden", status_code: 403 },
  });
});

test("OAuth insufficient_scope challenge and resource indicator match are pinned", () => {
  assert.equal(
    insufficientScopeWWWAuthenticate([]),
    'Bearer error="insufficient_scope"',
  );
  assert.equal(
    insufficientScopeWWWAuthenticate(["mcp:read", "mcp:write"]),
    'Bearer error="insufficient_scope", scope="mcp:read mcp:write"',
  );
  assert.equal(
    insufficientScopeWWWAuthenticate(
      ["mcp:read"],
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    ),
    'Bearer error="insufficient_scope", scope="mcp:read", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
  );
  assert.equal(
    resourceIndicatorMatches(
      "https://mcp.example.com/mcp",
      " https://mcp.example.com/mcp/ ",
    ),
    true,
  );
  assert.equal(
    resourceIndicatorMatches(
      "https://mcp.example.com/mcp",
      "https://other.example.com/mcp",
    ),
    false,
  );
  assert.equal(resourceIndicatorMatches("", ""), false);
});

test("OAuth authorization server metadata supports opt-in revocation/device endpoints", () => {
  const plain = newAuthorizationServerMetadata("https://auth.example.com/base/path");
  assert.equal(JSON.stringify(plain).includes("revocation_endpoint"), false);
  assert.equal(
    JSON.stringify(plain).includes("device_authorization_endpoint"),
    false,
  );
  assert.deepEqual(plain, {
    issuer: "https://auth.example.com/base/path",
    authorization_endpoint: "https://auth.example.com/base/path/authorize",
    token_endpoint: "https://auth.example.com/base/path/token",
    registration_endpoint: "https://auth.example.com/base/path/register",
    jwks_uri: "https://auth.example.com/base/path/.well-known/jwks.json",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  });

  const derived = newAuthorizationServerMetadata(
    "https://auth.example.com/base/path",
    { revocationEndpoint: true, deviceAuthorizationEndpoint: true },
  );
  assert.equal(derived.revocation_endpoint, "https://auth.example.com/base/path/revoke");
  assert.equal(
    derived.device_authorization_endpoint,
    "https://auth.example.com/base/path/device",
  );
  assert.equal(
    JSON.parse(JSON.stringify(derived)).revocation_endpoint,
    "https://auth.example.com/base/path/revoke",
  );

  const explicit = newAuthorizationServerMetadata("https://auth.example.com", {
    revocationEndpoint: "https://auth.example.com/oauth/revoke",
    deviceAuthorizationEndpoint: "https://device.example.com/device_authorization",
  });
  assert.equal(explicit.revocation_endpoint, "https://auth.example.com/oauth/revoke");
  assert.equal(
    explicit.device_authorization_endpoint,
    "https://device.example.com/device_authorization",
  );

  assert.throws(
    () =>
      newAuthorizationServerMetadata("https://auth.example.com", {
        revocationEndpoint: "not a url",
      }),
    /invalid url/,
  );
  assert.throws(
    () =>
      newAuthorizationServerMetadata("https://auth.example.com", {
        deviceAuthorizationEndpoint: "/device",
      }),
    /invalid url/,
  );
});

test("OAuth DCR policy and PKCE verifier are pinned", () => {
  validateDynamicClientRegistrationRequest(
    {
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    {
      allowedRedirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      requirePublicClient: true,
      requireRefreshToken: true,
    },
  );
  assert.throws(() =>
    validateDynamicClientRegistrationRequest(
      {
        redirect_uris: ["https://evil.example/callback"],
        token_endpoint_auth_method: "none",
      },
      {
        allowedRedirectUris: ["https://claude.ai/api/mcp/auth_callback"],
        requirePublicClient: true,
      },
    ),
  );
  const verifier = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.equal(
    pkceChallengeS256(verifier),
    "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA",
  );
  assert.equal(
    pkceVerifyS256(verifier, "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA"),
    true,
  );
});

test("the bearer challenge never derives from the MCP_ENDPOINT environment", async () => {
  const previous = process.env.MCP_ENDPOINT;
  process.env.MCP_ENDPOINT = "https://evil.example/mcp/{actor}";
  try {
    const unconfigured = requireBearerTokenMiddleware({});
    const bare = await unconfigured(ctx({}, "/mcp/Arch"), async () =>
      assert.fail("next should not run"),
    );
    assert.equal(bare.status, 401);
    assert.equal(bare.headers["www-authenticate"][0], "Bearer");

    const configured = requireBearerTokenMiddleware({
      resourceMetadataURL:
        "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    });
    const challenge = await configured(ctx({}, "/mcp/Arch"), async () =>
      assert.fail("next should not run"),
    );
    assert.equal(challenge.status, 401);
    assert.equal(
      challenge.headers["www-authenticate"][0],
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  } finally {
    if (previous === undefined) {
      delete process.env.MCP_ENDPOINT;
    } else {
      process.env.MCP_ENDPOINT = previous;
    }
  }
});
