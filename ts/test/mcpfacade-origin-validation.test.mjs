import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { normalizeRequestOrigin } from "../dist/mcpfacade.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../contract-tests/fixtures/routing/mcp-auth-facade/facade-origin-validation.v1.json",
      import.meta.url,
    ),
  ),
);

test("request-origin validation enforces the shared parsed-IP table", () => {
  assert.ok(fixture.cases.length > 0);
  for (const row of fixture.cases) {
    const canonical = normalizeRequestOrigin(row.raw);
    if (row.expect === "accepted") {
      assert.equal(canonical, row.canonical, `${row.id}: ${row.raw}`);
    } else {
      assert.equal(canonical, null, `${row.id}: ${row.raw} must be rejected`);
    }
  }
});
