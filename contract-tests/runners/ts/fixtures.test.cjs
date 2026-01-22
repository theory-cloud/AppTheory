const assert = require("node:assert/strict");
const test = require("node:test");

const { runAllFixtures } = require("./run.cjs");

test("contract fixtures (ts runtime)", { timeout: 60_000 }, async () => {
  const { fixtures, failures } = await runAllFixtures({ fixturesRoot: "contract-tests/fixtures" });
  const ids = failures.map((f) => f.fixture.id).sort();
  assert.equal(
    failures.length,
    0,
    `expected 0 failing fixtures, got ${failures.length}/${fixtures.length}: ${ids.join(", ")}`,
  );
});

