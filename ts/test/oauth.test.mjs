import test from "node:test";
import assert from "node:assert/strict";

import {
  ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE,
  OAuthBearerError,
  bearerTokenClaimsFromContext,
  newMemoryBearerTokenValidator,
  newProtectedResourceMetadata,
  pkceChallengeS256,
  pkceVerifyS256,
  protectedResourceWWWAuthenticate,
  requireBearerTokenMiddleware,
  resourceMetadataURLFromMcpEndpoint,
  validateDynamicClientRegistrationRequest,
} from "../dist/index.js";

function ctx(headers = {}) {
  const values = new Map();
  return {
    request: { headers },
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

test("OAuth bearer middleware distinguishes unauthorized and forbidden", async () => {
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
    ],
    {
      requiredAudience: "https://mcp.example.com/mcp",
      requiredScopes: ["mcp:read"],
      now: () => new Date(1_700_000_000_000),
    },
  );
  const mw = requireBearerTokenMiddleware({
    resourceMetadataURL: "https://mcp.example.com/pr",
    claimsValidator: validator,
  });
  const missing = await mw(ctx(), async () =>
    assert.fail("next should not run"),
  );
  assert.equal(missing.status, 401);
  const forbidden = await mw(
    ctx({ authorization: ["Bearer scope-miss"] }),
    async () => assert.fail("next should not run"),
  );
  assert.equal(forbidden.status, 403);
  assert.throws(
    () => validator(ctx(), "scope-miss"),
    (err) =>
      err instanceof OAuthBearerError &&
      err.oauthCode === ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE,
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
