import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ProviderError, newAutheoryProvider } from "../dist/oauth/provider.js";
import { newFakeOAuthProvider } from "../dist/testkit/oauthprovider.js";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "contract-tests",
  "fixtures",
  "routing",
  "mcp-auth-facade",
);

const FIXTURE_NAME = "facade-provider-conformance.v1.json";

function loadFixture() {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, FIXTURE_NAME), "utf8"));
}

const fixture = loadFixture();
const CASES = fixture.cases ?? [];
const SECOND_PROVIDER_ISSUER = "https://second-provider.example.test";

/**
 * Bridges the HTTPS names the adapter is configured with onto the fake
 * provider's loopback listener, exactly as the JWKS suite does: the adapter
 * only ever sees HTTPS URLs, and no request leaves the machine.
 */
function bridgeFetch(publicBaseUrl, loopbackUrl) {
  const loopback = new URL(loopbackUrl);
  const host = new URL(publicBaseUrl).hostname;
  return async (input, init) => {
    const target = new URL(String(input));
    if (target.hostname === host) {
      target.protocol = loopback.protocol;
      target.host = loopback.host;
    }
    return await fetch(target, init);
  };
}

function errorObservation(err) {
  assert.ok(
    err instanceof ProviderError,
    `expected a provider error, got ${String(err)}`,
  );
  return {
    outcome: "error",
    error_class: err.errorClass,
    message: err.message,
  };
}

async function withProvider(testCase, body) {
  const upstream = testCase.upstream ?? {};
  const issuer = String(upstream.issuer);
  const fake = newFakeOAuthProvider({
    issuer: String(upstream.discovery_issuer ?? issuer),
    publicBaseUrl: issuer,
    discoveryRedirectTo: upstream.redirect_to,
    tokenStatus: upstream.token_status,
    tokenBody: upstream.token_body,
    tokenBodyBytes: upstream.token_body_bytes,
    tokenBodyPaddingBytes: upstream.token_body_padding_bytes,
    tokenDelaySeconds: upstream.token_delay_seconds,
  });
  const loopbackUrl = await fake.start();
  try {
    const provider = await newAutheoryProvider({
      issuer,
      fetchImpl: bridgeFetch(issuer, loopbackUrl),
      allowPrivateHosts: true,
      ...(testCase.fetch_timeout_seconds === undefined
        ? {}
        : { fetchTimeoutSeconds: testCase.fetch_timeout_seconds }),
    });
    return await body(provider, fake);
  } finally {
    await fake.close();
  }
}

/** A tiny second adapter, present only to prove the SPI is provider-neutral. */
function secondAdapter() {
  return {
    async discovery() {
      return {
        issuer: SECOND_PROVIDER_ISSUER,
        authorizationEndpoint: `${SECOND_PROVIDER_ISSUER}/oauth/authorize`,
        tokenEndpoint: `${SECOND_PROVIDER_ISSUER}/oauth/token`,
        jwksUri: `${SECOND_PROVIDER_ISSUER}/.well-known/jwks.json`,
        codeChallengeMethodsSupported: ["S256"],
        authorizationResponseIssParameterSupported: false,
        resourceParameterSupported: false,
      };
    },
    async authorizationUrl() {
      return `${SECOND_PROVIDER_ISSUER}/oauth/authorize`;
    },
    async exchangeCode() {
      return { accessToken: "second-provider-access-token" };
    },
    async refresh() {
      return { accessToken: "second-provider-access-token" };
    },
    async validateAccessToken() {
      return {
        subject: "second-provider-subject",
        audience: SECOND_PROVIDER_ISSUER,
        scopes: [],
        authorizedParty: "second-provider-client",
      };
    },
  };
}

async function observeCase(testCase) {
  const request = testCase.request ?? {};
  switch (testCase.operation) {
    case "discovery":
      return await withProvider(testCase, async (provider) => {
        try {
          const metadata = await provider.discovery();
          return {
            outcome: "ok",
            issuer: metadata.issuer,
            code_challenge_methods_supported:
              metadata.codeChallengeMethodsSupported,
            authorization_response_iss_parameter_supported:
              metadata.authorizationResponseIssParameterSupported,
            resource_parameter_supported: metadata.resourceParameterSupported,
          };
        } catch (err) {
          return errorObservation(err);
        }
      });
    case "authorization_url":
      return await withProvider(testCase, async (provider) => {
        try {
          const raw = await provider.authorizationUrl({
            upstreamClientId: request.upstream_client_id,
            callbackUrl: request.callback_url,
            codeChallenge: request.code_challenge,
            codeChallengeMethod: request.code_challenge_method,
            state: request.state,
            resource: request.resource,
            scopes: request.scopes ?? [],
            hints: request.hints,
          });
          const url = new URL(raw);
          const query = {};
          for (const key of Object.keys(testCase.expect?.query ?? {})) {
            query[key] = url.searchParams.get(key);
          }
          for (const [key, value] of Object.entries(request.hints ?? {})) {
            assert.equal(
              url.searchParams.get(key),
              value,
              `authorize URL must carry the ${key} hint`,
            );
          }
          return { outcome: "ok", query };
        } catch (err) {
          return errorObservation(err);
        }
      });
    case "exchange_code":
      return await withProvider(testCase, async (provider) => {
        try {
          const tokenSet = await provider.exchangeCode({
            code: request.code,
            upstreamClientId: request.upstream_client_id,
            callbackUrl: request.callback_url,
            codeVerifier: request.code_verifier,
          });
          return {
            outcome: "ok",
            access_token: tokenSet.accessToken,
            refresh_token: tokenSet.refreshToken,
            id_token: tokenSet.idToken,
            token_type: tokenSet.tokenType,
            expires_in: tokenSet.expiresIn,
          };
        } catch (err) {
          return errorObservation(err);
        }
      });
    case "refresh":
      return await withProvider(testCase, async (provider, fake) => {
        try {
          const tokenSet = await provider.refresh({
            refreshMaterial: request.refresh_material,
            upstreamClientId: request.upstream_client_id,
          });
          return {
            outcome: "ok",
            access_token: tokenSet.accessToken,
            refresh_token: tokenSet.refreshToken,
            upstream_client_id: fake.lastTokenRequest()?.clientId,
          };
        } catch (err) {
          return errorObservation(err);
        }
      });
    case "validate_access_token":
      return await withProvider(testCase, async (provider, fake) => {
        const spec = testCase.token ?? {};
        const token = fake.mintAccessToken({
          issuer: spec.iss,
          audience: spec.aud,
          authorizedParty: spec.azp,
          subject: spec.sub,
          scope: spec.scope,
          expiresInSeconds: spec.expires_in,
          tamperSignature: spec.tamper_signature,
        });
        const expectations = testCase.expectations ?? {};
        try {
          const claims = await provider.validateAccessToken(token, {
            expectedIssuer: expectations.expected_issuer,
            expectedAudience: expectations.expected_audience,
            requiredScopes: expectations.required_scopes,
            allowedAuthorizedParties: expectations.allowed_authorized_parties,
          });
          return {
            outcome: "ok",
            subject: claims.subject,
            audience: claims.audience,
            scopes: claims.scopes,
            authorized_party: claims.authorizedParty,
          };
        } catch (err) {
          return errorObservation(err);
        }
      });
    case "second_adapter": {
      const metadata = await secondAdapter().discovery();
      return { outcome: "ok", issuer: metadata.issuer };
    }
    default:
      throw new Error(`unknown provider conformance operation ${testCase.operation}`);
  }
}

function assertCase(testCase, observed) {
  const expected = testCase.expect ?? {};
  const actual = {};
  for (const key of Object.keys(expected)) {
    if (key === "message_excludes") continue;
    actual[key] = observed[key];
  }
  const compared = {};
  for (const key of Object.keys(expected)) {
    if (key !== "message_excludes") compared[key] = expected[key];
  }
  assert.deepEqual(
    actual,
    compared,
    `provider conformance case ${testCase.id} produced ${JSON.stringify(observed)}`,
  );
  const message = String(observed.message ?? "");
  for (const marker of expected.message_excludes ?? []) {
    assert.ok(
      !message.includes(marker),
      `provider conformance case ${testCase.id} leaked ${marker} into the error message`,
    );
  }
}

test("provider conformance fixture carries 22 cases", () => {
  assert.equal(CASES.length, 22);
  assert.equal(new Set(CASES.map((c) => c.id)).size, 22);
});

test("the Autheory adapter satisfies the provider conformance table", async () => {
  let ran = 0;
  for (const testCase of CASES) {
    assertCase(testCase, await observeCase(testCase));
    ran += 1;
  }
  assert.equal(ran, 22);
  console.log(
    `provider conformance: ${ran}/${CASES.length} cases passed (adapter + testkit fake upstream)`,
  );
});
