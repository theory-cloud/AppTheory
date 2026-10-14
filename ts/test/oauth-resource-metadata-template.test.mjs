import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Context,
  protectedResourceWWWAuthenticate,
  requireBearerTokenMiddleware,
} from "../dist/index.js";

// This file pins the route-parameter template seam of the RFC 9728 challenge to
// the shared cross-runtime table in contract-tests/fixtures/routing/
// mcp-auth-facade/route-challenge.v1.json, so the Go, TypeScript, and Python
// middleware resolve the same rows to the same bytes. Every expectation is read
// from the fixture: an empty or shrunken table fails here rather than passing
// vacuously.

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "contract-tests",
  "fixtures",
  "routing",
  "mcp-auth-facade",
);

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

function requestContext(params) {
  return new Context({
    request: {
      method: "GET",
      path: "/mcp/alpha",
      query: {},
      headers: {},
      cookies: {},
      body: Buffer.alloc(0),
      isBase64: false,
    },
    params,
  });
}

// Drives the real middleware for one credential-free request whose matched
// route supplies params, mirroring the Go reference's challengeHeaderFor
// helper, and returns the WWW-Authenticate value.
async function challengeHeaderFor(options, params) {
  const middleware = requireBearerTokenMiddleware(options);
  const response = await middleware(requestContext(params), () =>
    assert.fail("next must not run for a credential-free request"),
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers["www-authenticate"].length, 1);
  return response.headers["www-authenticate"][0];
}

const fixture = loadFixture("route-challenge.v1.json").resource_metadata_template;

test("route-parameter template resolves the matched route's metadata URL", async () => {
  assert.ok(fixture.accept.length > 0, "fixture must carry accept rows");
  for (const row of fixture.accept) {
    const challenge = await challengeHeaderFor(
      { resourceMetadataURLTemplate: row.template },
      row.params,
    );
    assert.equal(
      challenge,
      protectedResourceWWWAuthenticate(row.expect_url),
      `template ${row.template} with ${JSON.stringify(row.params)}`,
    );
    assert.ok(
      !challenge.includes("{"),
      "a literal placeholder must never be advertised",
    );
  }
});

test("route-parameter template fails closed on unsafe or missing values", async () => {
  assert.ok(fixture.refused_value.length > 0, "fixture must carry refused_value rows");
  assert.ok(fixture.missing_param.length > 0, "fixture must carry missing_param rows");
  const rows = [...fixture.refused_value, ...fixture.missing_param];
  for (const row of rows) {
    const challenge = await challengeHeaderFor(
      { resourceMetadataURLTemplate: fixture.template },
      row.params,
    );
    assert.equal(
      challenge,
      "Bearer",
      `template ${fixture.template} with ${JSON.stringify(row.params)}`,
    );
  }
});

test("route-parameter template fails at registration when malformed", () => {
  assert.ok(
    fixture.refused_template.length > 0,
    "fixture must carry refused_template rows",
  );
  for (const row of fixture.refused_template) {
    assert.throws(
      () =>
        requireBearerTokenMiddleware({
          resourceMetadataURLTemplate: row.template,
        }),
      (err) => {
        assert.ok(err instanceof Error, "registration must throw an Error");
        assert.match(err.message, /invalid ResourceMetadataURLTemplate/u);
        return true;
      },
      `template ${row.template} must be refused at registration`,
    );
  }
});

test("route-parameter template precedence matches the shared fixture", async () => {
  const precedence = fixture.precedence;

  const funcWins = precedence.func_wins;
  assert.equal(
    await challengeHeaderFor(
      {
        resourceMetadataURL: () => funcWins.resource_metadata_url_func,
        resourceMetadataURLTemplate: funcWins.template,
      },
      funcWins.params,
    ),
    protectedResourceWWWAuthenticate(funcWins.expect_url),
  );

  const templateWins = precedence.template_wins;
  assert.equal(
    await challengeHeaderFor(
      {
        resourceMetadataURL: templateWins.resource_metadata_url,
        resourceMetadataURLTemplate: templateWins.template,
      },
      templateWins.params,
    ),
    protectedResourceWWWAuthenticate(templateWins.expect_url),
  );
});
