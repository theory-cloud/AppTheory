import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The invocation-scope join tests import the built package (`../dist/index.js`),
// so they exercise the source under test only when the build is not older than
// the sources it was made from. `scripts/verify-ts-tests.sh` and `make build`
// always rebuild in a clean copy, but a bare `node --test test/*.test.mjs` in a
// checkout would otherwise run a stale build and pass against code that no
// longer exists — the exact trap that let an inert edit look green.
//
// This guard turns that trap into a loud failure: each built file the tests load
// is compared with the source file it is compiled from, and a build that is
// meaningfully older than that source fails the run. The comparison is a
// timestamp one — `scripts/verify-ts-dist-drift.sh` is the content-level
// authority for the whole tree, and the enforced test path
// (`scripts/verify-ts-tests.sh`) rebuilds unconditionally, so this guard exists
// only to stop a local run against output that is plainly out of date.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_ROOT = path.resolve(HERE, "..");

// The built files the join tests actually load, each with the source it is
// compiled from: the package entry point, the timeout middleware, and the
// buffered adapters' drain budget.
const BUILT_FILES = [
  { built: "dist/index.js", source: "src/index.ts" },
  { built: "dist/app.js", source: "src/app.ts" },
  { built: "dist/internal/aws-http.js", source: "src/internal/aws-http.ts" },
];

// STALE_TOLERANCE_MS is the checkout jitter the guard ignores: a fresh clone
// writes every file within milliseconds of every other.
const STALE_TOLERANCE_MS = 5000;

function mtimeOf(relative) {
  const full = path.join(TS_ROOT, relative);
  try {
    return statSync(full).mtimeMs;
  } catch {
    throw new Error(
      `${relative} is missing: build the TypeScript sources before running this test (cd ts && npm run build)`,
    );
  }
}

export function assertDistIsFresh() {
  const stale = [];
  for (const { built, source } of BUILT_FILES) {
    const builtAt = mtimeOf(built);
    const sourceAt = mtimeOf(source);
    if (builtAt + STALE_TOLERANCE_MS < sourceAt) {
      stale.push(`${built} (older than ${source})`);
    }
  }
  if (stale.length > 0) {
    throw new Error(
      `the checked-in build is older than its source (${stale.join(", ")}): ` +
        "this test would run the source under test only after a rebuild. " +
        "Run `cd ts && npm run build` (or scripts/verify-ts-tests.sh itself) and re-run.",
    );
  }
}
