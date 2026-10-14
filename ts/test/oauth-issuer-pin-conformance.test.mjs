import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizeIssuerURL } from "../dist/oauth/index.js";

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

const ISSUER_PIN_GROUP = "issuer_pin";

/**
 * `redirect_match` is the sibling group the same shared table carries. It is
 * executed by the facade front-channel test through the real `/authorize`
 * handler, not here; the group ledger below keeps a new group from appearing
 * without a loader.
 */
const REDIRECT_MATCH_GROUP = "redirect_match";

/**
 * `form_parse` is the sibling group holding the `/token` request-body rule. It
 * is executed by the facade front-channel test through the real token handler,
 * not here; the group ledger below still lists it so a new group cannot appear
 * without a loader.
 */
const FORM_PARSE_GROUP = "form_parse";

/**
 * `method_status` is the sibling group holding the route-model method-mismatch
 * contract. It is executed by the facade front-channel test through the real
 * mounted app, not here; the group ledger below still lists it so a new group
 * cannot appear without a loader.
 */
const METHOD_STATUS_GROUP = "method_status";

/**
 * `dcr` is the sibling group holding the RFC 7591 dynamic-client registration
 * rule. It is executed by the facade front-channel test through the real mounted
 * POST .../register handler, not here; the group ledger below still lists it so a
 * new group cannot appear without a loader.
 */
const DCR_GROUP = "dcr";

/**
 * `bound_route` is the sibling group holding the registration route-binding
 * rule: a client registered through DCR is accepted only at the advertising route
 * it registered at. It is executed by the facade front-channel test through the
 * real mounted /register, /authorize, and /token handlers, not here; the group
 * ledger below still lists it so a new group cannot appear without a loader.
 */
const BOUND_ROUTE_GROUP = "bound_route";

const FIXTURE_GROUPS = [
  ISSUER_PIN_GROUP,
  REDIRECT_MATCH_GROUP,
  FORM_PARSE_GROUP,
  METHOD_STATUS_GROUP,
  DCR_GROUP,
  BOUND_ROUTE_GROUP,
];

/**
 * The number of issuer_pin rows the shared table must carry; a change to the
 * table must also be a deliberate edit here and in the Go and Python loaders,
 * so no runtime can silently execute a smaller table.
 */
const ISSUER_PIN_CASE_COUNT = 27;

function loadFixture() {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, FIXTURE_NAME), "utf8"));
}

const fixture = loadFixture();
const CASES = fixture.cases ?? [];
const ISSUER_PIN_CASES = CASES.filter((row) => row.group === ISSUER_PIN_GROUP);

test("the fixture carries only the known conformance groups", () => {
  const groups = [...new Set(CASES.map((row) => row.group))].sort();
  assert.deepEqual(groups, [...FIXTURE_GROUPS].sort());
  assert.equal(ISSUER_PIN_CASES.length, ISSUER_PIN_CASE_COUNT);
});

/**
 * Pins the RFC 9207 `iss` check to the shared cross-runtime table. A row
 * matches exactly when both the configured and the claimed value canonicalize
 * and the canonical forms are byte-equal, so the host-case and fragment rows
 * fail closed on a canonicalizer that lowercases the host (WHATWG URL) or
 * drops the fragment.
 */
for (const row of ISSUER_PIN_CASES) {
  test(`issuer pin ${row.id}`, () => {
    assert.ok(
      row.expect === "match" || row.expect === "mismatch",
      `unknown expect ${JSON.stringify(row.expect)}`,
    );
    const configured = canonicalizeIssuerURL(row.configured);
    const claimed = canonicalizeIssuerURL(row.claimed);
    const matched =
      configured !== null && claimed !== null && configured === claimed;
    assert.equal(
      matched,
      row.expect === "match",
      `configured ${JSON.stringify(row.configured)} -> ${JSON.stringify(configured)}, claimed ${JSON.stringify(row.claimed)} -> ${JSON.stringify(claimed)}`,
    );
  });
}
