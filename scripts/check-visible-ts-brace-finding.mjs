// Purpose: validate the reviewed TypeScript lint-tool dependency graph and prove
// that no vulnerable minimatch finding is visible to the ts/ OSV audit surface.
//
// ===========================================================================
// Two reviewed shapes: the patched minimatch graph and one dev-chain exception
// ===========================================================================
// minimatch: E4 (`ts-dev-import-x-minimatch`) is closed. It once kept
// minimatch 10.2.6 for eslint-plugin-import-x 4.17.1, which imported the
// `makeRe` export that minimatch 11 removed. eslint-plugin-import-x 4.18.0
// supports minimatch 9, 10, and 11 and no longer imports `makeRe` (upstream
// #570), so its published range is `^9.0.3 || ^10.1.2 || ^11.0.1`; the
// exception's removal condition was met and it was removed on 2026-11-06.
//
// E5 (`ts-dev-picomatch`): picomatch 4.0.7, reached only through the
// TypeScript lint toolchain's `@typescript-eslint/parser ->
// @typescript-eslint/typescript-estree -> tinyglobby -> picomatch` chain (and
// tinyglobby's `fdir` peer edge). GHSA-fc5q-39xc-vjpf (high) covers every
// picomatch `<= 4.0.7` with NO patched release (checked 2026-11-17: npm's
// latest picomatch is 4.0.7), so nothing installable clears it. Operator-ruled
// 2026-11-17 as a scoped, expiring exception. See `E5` below for the exact
// scope, recheck deadline, removal condition, and justification.
//
// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------
// The reviewed graph is exact and fail closed:
//   * the lockfile must carry exactly one minimatch node, the patched 11.0.9
//     at node_modules/minimatch; an additional minimatch node at any path
//     fails, and every minimatch node is also compared against the patched
//     floor 11.0.1 explicitly, so a vulnerable copy reintroduced at the old
//     eslint-plugin-import-x path fails;
//   * brace-expansion, @isaacs/nonrecursive-glob-match, the exact minimatch
//     parent set, the dev flags, and the reviewed npm `overrides` map are
//     pinned, so an unreviewed install cannot silently weaken the graph;
//   * E5 is exact: the lockfile must carry exactly one dev picomatch 4.0.7 at
//     node_modules/picomatch, reached only through the pinned dev chain, with
//     picomatch absent from the root runtime dependencies. A finding is
//     excused only when its advisory id, aliases, package, and version all
//     match E5's single advisory on this one lockfile; any other finding, any
//     other package, any other advisory, any non-dev or additional picomatch
//     path, and an expired recheck deadline all fail;
//   * E5's removal probe reads the npm registry on every invocation, so a
//     published patched picomatch cannot leave a stale exception in place.
// ===========================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const selfTest = argv[0] === "--self-test";
const [reportPath, lockfilePath] = argv;

if (!selfTest && (!reportPath || !lockfilePath)) {
  console.error(
    "usage: node scripts/check-visible-ts-brace-finding.mjs <osv-report-json> <package-lock.json> [--self-test]",
  );
  process.exit(2);
}

function fail(message) {
  console.error(`osv-scanner: FAIL (${message})`);
  process.exit(1);
}

function readJson(path, description) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (err) {
    fail(`could not parse ${description} ${path}: ${err.message}`);
  }
}

// Order-insensitive JSON rendering, so two structurally equal override maps
// compare equal regardless of key order.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizePath(path) {
  return String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function sameStringSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  return actualSorted.every((value, index) => value === expectedSorted[index]);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Numeric comparison of dotted versions. Pre-release suffixes are ignored: the
// review only ever compares release versions.
function compareVersionStrings(a, b) {
  const left = String(a).split("-")[0].split(".").map(Number);
  const right = String(b).split("-")[0].split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const l = Number.isFinite(left[index]) ? left[index] : 0;
    const r = Number.isFinite(right[index]) ? right[index] : 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

function stringList(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

// A release counts only when it is stable (no prerelease component) and at or
// above the floor. Prereleases never satisfy a stable floor, so a
// `5.0.0-rc.1` publish cannot satisfy E5's removal condition.
function isStableAtLeast(version, floor) {
  const raw = String(version ?? "").trim();
  if (raw.includes("-")) return false;
  return compareVersionStrings(raw, floor) >= 0;
}

function stableVersionsAtLeast(versions, floor) {
  return versions.filter((version) => isStableAtLeast(version, floor)).sort(compareVersionStrings);
}

// ---------------------------------------------------------------------------
// Reviewed dev-chain exception E5
// ---------------------------------------------------------------------------

// The one TypeScript exception. Every field is exact: a different advisory, a
// different package, a different version, a non-dev or additional picomatch
// path, a different chain, a different lockfile, or a passed recheck_by fails.
const E5 = {
  exceptionId: "ts-dev-picomatch",
  kind: "dev-chain",
  lockfiles: ["ts/package-lock.json"],
  packageName: "picomatch",
  packagePath: "node_modules/picomatch",
  packageVersion: "4.0.7",
  // The advisory's highest affected version is 4.0.7 and it carries no fixed
  // event, so 4.0.8 is the first release outside its range. A stable publish
  // at or above this floor satisfies the removal condition and fails the gate
  // until the exception is removed (or renewed under a new operator ruling).
  patchedFloor: "4.0.8",
  // The exact dev chain, leaf first. `via` is the dependency edge that pulls
  // the link in; `range` pins the declared range so a toolchain bump that
  // changes the edge fails closed.
  chain: [
    { name: "tinyglobby", path: "node_modules/tinyglobby", via: "picomatch", range: "^4.0.4" },
    { name: "fdir", path: "node_modules/fdir", via: "picomatch", range: "^3 || ^4", peer: true },
    {
      name: "@typescript-eslint/typescript-estree",
      path: "node_modules/@typescript-eslint/typescript-estree",
      via: "tinyglobby",
      range: "^0.2.15",
    },
    {
      name: "@typescript-eslint/parser",
      path: "node_modules/@typescript-eslint/parser",
      via: "@typescript-eslint/typescript-estree",
      range: "8.73.0",
    },
  ],
  // The chain root must be a devDependency of the ts package, never a runtime
  // dependency.
  rootDevDependency: "@typescript-eslint/parser",
  advisories: [
    {
      id: "GHSA-fc5q-39xc-vjpf",
      aliases: ["CVE-2026-112366"],
      url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
    },
  ],
  operatorRuling: "2026-11-17",
  owner: "theory-cloud/AppTheory steward (Factory dependency sweeps)",
  recheckBy: "2026-12-01",
  justification:
    "Operator-ruled 2026-11-17 (Factory docs/058 DEPS-20261117): picomatch <= 4.0.7 is affected by GHSA-fc5q-39xc-vjpf and npm publishes NO patched picomatch (latest is 4.0.7, no fixed event in the advisory), so the TypeScript lint toolchain cannot be upgraded out of it. Lint/build-time only: the node is dev: true, reached only through @typescript-eslint/parser -> typescript-estree -> tinyglobby -> picomatch, and the published package's runtime dependencies never mention picomatch. Self-expiring; see the removal condition.",
  removalCondition:
    "a picomatch release patches GHSA-fc5q-39xc-vjpf (a stable picomatch >= 4.0.8 is published), or ts/ no longer resolves picomatch <= 4.0.7",
};

const EXCEPTIONS = [E5];

function recheckExpired(nowIso, recheckBy) {
  return Date.parse(nowIso) >= Date.parse(`${recheckBy}T00:00:00Z`);
}

function removalReasons({ publishedStablePatchedPicomatch }) {
  const reasons = [];
  if (publishedStablePatchedPicomatch.length > 0) {
    reasons.push(
      `a patched ${E5.packageName} (>= ${E5.patchedFloor}) is published to npm: ${publishedStablePatchedPicomatch.join(", ")}`,
    );
  }
  return reasons;
}

const registryBaseUrl = "https://registry.npmjs.org";
const registryTimeoutMs = 20000;

function blocked(message) {
  console.error(`osv-scanner: BLOCKED (${message})`);
  process.exit(2);
}

async function fetchRegistryDocument(url, description) {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(registryTimeoutMs),
    });
  } catch (err) {
    blocked(`could not reach the npm registry for ${description} (${url}): ${err.message}`);
  }
  if (!response.ok) {
    blocked(`npm registry returned HTTP ${response.status} for ${description} (${url})`);
  }
  try {
    return await response.json();
  } catch (err) {
    blocked(`could not parse the npm registry response for ${description} (${url}): ${err.message}`);
  }
}

async function removalProbe() {
  const document = await fetchRegistryDocument(
    `${registryBaseUrl}/${E5.packageName}`,
    `${E5.packageName} versions`,
  );
  return removalReasons({
    publishedStablePatchedPicomatch: stableVersionsAtLeast(
      Object.keys(document.versions ?? {}),
      E5.patchedFloor,
    ),
  });
}

// The exact dev-only proof for E5. An empty list is the only passing state.
// Pure so the self-test can drive it.
function picomatchGraphProblems(packages) {
  const problems = [];
  const picomatchPaths = Object.keys(packages).filter(
    (key) => key === E5.packagePath || key.endsWith(`/${E5.packagePath}`),
  );
  const node = packages[E5.packagePath];

  if (!sameStringSet(picomatchPaths, [E5.packagePath]) || node?.dev !== true) {
    problems.push(
      `lockfile graph no longer matches the reviewed ${E5.exceptionId} exception (expected exactly one dev ${E5.packageName} at ${E5.packagePath})`,
    );
    return problems;
  }

  const version = node?.version;
  if (version && compareVersionStrings(version, E5.patchedFloor) >= 0) {
    problems.push(
      `reviewed exception ${E5.exceptionId} removal condition met: ts/ now resolves ${E5.packageName} ${version} >= ${E5.patchedFloor}; remove the exception`,
    );
  } else if (version !== E5.packageVersion) {
    problems.push(
      `lockfile graph no longer matches the reviewed ${E5.exceptionId} exception (expected ${E5.packageName} ${E5.packageVersion})`,
    );
  }

  // Dev-only proof, structural half: the root runtime dependency set must never
  // mention picomatch, and the chain root must be a devDependency.
  const root = packages[""] ?? {};
  if (Object.keys(root.dependencies ?? {}).includes(E5.packageName)) {
    problems.push(
      `lockfile graph no longer matches the reviewed ${E5.exceptionId} exception (${E5.packageName} is declared as a runtime dependency)`,
    );
  }
  if (!Object.keys(root.devDependencies ?? {}).includes(E5.rootDevDependency)) {
    problems.push(
      `lockfile graph no longer matches the reviewed ${E5.exceptionId} exception (${E5.rootDevDependency} is not a devDependency)`,
    );
  }

  for (const link of E5.chain) {
    const linkPackage = packages[link.path];
    if (linkPackage?.dev !== true) {
      problems.push(
        `lockfile graph no longer matches the reviewed ${E5.exceptionId} exception (expected the dev ${link.name} at ${link.path})`,
      );
      continue;
    }
    const edge = link.peer
      ? linkPackage.peerDependencies?.[link.via]
      : linkPackage.dependencies?.[link.via];
    if (edge === undefined) {
      problems.push(
        `lockfile graph no longer matches the reviewed ${E5.exceptionId} exception (${link.name} no longer depends on ${link.via})`,
      );
    } else if (edge !== link.range) {
      problems.push(
        `lockfile graph no longer matches the reviewed ${E5.exceptionId} exception (${link.name} declares ${link.via} ${edge}, expected ${link.range})`,
      );
    }
  }
  return problems;
}

// Returns E5 only when the finding is exactly E5's single advisory, on E5's
// package and version, from E5's lockfile. Any other finding returns null and
// therefore fails. Node paths are not in OSV reports; `picomatchGraphProblems`
// enforces the dev-only, single-path shape.
function sourceMatchesLockfile(sourcePath, canonicalLockfile) {
  const normalized = normalizePath(sourcePath);
  if (normalized === "") return false;
  if (normalized === canonicalLockfile) return true;
  if (normalized.endsWith(`/${canonicalLockfile}`)) return true;
  return normalizePath(path.isAbsolute(normalized) ? path.relative(repositoryRoot, normalized) : normalized) ===
    canonicalLockfile;
}

function matchingException(entry, canonicalLockfile) {
  const packageInfo = entry.pkg?.package ?? {};
  for (const exception of EXCEPTIONS) {
    if (!exception.lockfiles.includes(canonicalLockfile)) continue;
    if (!sourceMatchesLockfile(entry.result?.source?.path, canonicalLockfile)) continue;
    if (packageInfo.ecosystem !== "npm") continue;
    if (packageInfo.name !== exception.packageName) continue;
    if (packageInfo.version !== exception.packageVersion) continue;
    const advisory = exception.advisories.find((candidate) => candidate.id === entry.vuln.id);
    if (!advisory) continue;
    if (!sameStringSet(stringList(entry.vuln.aliases), advisory.aliases)) continue;
    return exception;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reviewed graph
// ---------------------------------------------------------------------------

const minimatchFloor = "11.0.1";

const expectation = {
  checkId: "typescript-lint-tool-minimatch-graph",
  lockfile: "ts/package-lock.json",
  packageJson: "ts/package.json",
  braceExpansion: {
    balancedMatchRange: "^4.0.2",
    dev: true,
    path: "node_modules/brace-expansion",
    version: "5.0.12",
  },
  globMatch: {
    dev: true,
    path: "node_modules/@isaacs/nonrecursive-glob-match",
    version: "1.1.0",
  },
  // The single patched minimatch node. Every consumer's own 11.x range admits
  // it, so the override dedupes them onto the same hoisted 11.0.9.
  minimatch: {
    braceExpansionRange: "^5.0.12",
    dev: true,
    globMatchRange: "^1.1.0",
    paths: ["node_modules/minimatch"],
    version: "11.0.9",
  },
  // Every package in the lockfile that declares a minimatch dependency. eslint,
  // @eslint/config-array and @typescript-eslint/typescript-estree now declare an
  // 11.x range themselves; the override still moves every consumer onto the
  // reviewed patched node.
  minimatchParents: [
    {
      dependencyRange: "^11.0.5",
      path: "node_modules/@eslint/config-array",
      version: "0.23.6",
    },
    {
      dependencyRange: "^11.0.1",
      path: "node_modules/@typescript-eslint/typescript-estree",
      version: "8.73.0",
    },
    {
      dependencyRange: "^11.0.5",
      path: "node_modules/eslint",
      version: "10.15.0",
    },
    {
      dependencyRange: "^9.0.3 || ^10.1.2 || ^11.0.1",
      path: "node_modules/eslint-plugin-import-x",
      version: "4.18.1",
    },
  ],
  // The npm overrides that produce the reviewed graph. The lockfile does not
  // record overrides, so the sibling package.json is checked directly: losing
  // an override would let a later install drift back onto a vulnerable
  // minimatch, and re-adding an import-x exception would recreate the retired
  // exception's shape.
  overrides: {
    minimatch: "11.0.9",
    eslint: { minimatch: "11.0.9" },
    "@eslint/config-array": { minimatch: "11.0.9" },
    "@typescript-eslint/typescript-estree": { minimatch: "11.0.9" },
  },
};

// ---------------------------------------------------------------------------
// Lockfile graph assertions (the fail-closed anchors)
// ---------------------------------------------------------------------------

// Every way the lockfile can deviate from the reviewed graph. An empty list is
// the only passing state. Pure so the self-test can drive it.
function lockfileGraphProblems(packages) {
  const problems = [];
  const minimatchPaths = Object.keys(packages).filter((key) => key.endsWith("node_modules/minimatch"));
  const bracePaths = Object.keys(packages).filter(
    (key) => key === expectation.braceExpansion.path || key.endsWith(`/${expectation.braceExpansion.path}`),
  );
  const globMatchPaths = Object.keys(packages).filter(
    (key) => key === expectation.globMatch.path || key.endsWith(`/${expectation.globMatch.path}`),
  );

  if (!sameStringSet(minimatchPaths, expectation.minimatch.paths)) {
    problems.push(
      "lockfile graph no longer matches the reviewed TypeScript lint-tool minimatch paths (expected exactly one patched 11.0.9 node at node_modules/minimatch)",
    );
  }
  for (const minimatchPath of minimatchPaths) {
    const version = packages[minimatchPath]?.version;
    if (!version || compareVersionStrings(version, minimatchFloor) < 0) {
      problems.push(
        `minimatch ${version ?? "<missing>"} at ${minimatchPath} is below the patched floor ${minimatchFloor}`,
      );
    }
  }
  if (!sameStringSet(bracePaths, [expectation.braceExpansion.path])) {
    problems.push("lockfile graph no longer matches the reviewed TypeScript brace-expansion path");
  }
  if (!sameStringSet(globMatchPaths, [expectation.globMatch.path])) {
    problems.push("lockfile graph no longer matches the reviewed @isaacs/nonrecursive-glob-match path");
  }

  for (const patchedPath of expectation.minimatch.paths) {
    const patched = packages[patchedPath];
    if (
      patched?.version !== expectation.minimatch.version ||
      patched?.dev !== expectation.minimatch.dev ||
      patched?.dependencies?.["brace-expansion"] !== expectation.minimatch.braceExpansionRange ||
      patched?.dependencies?.["@isaacs/nonrecursive-glob-match"] !== expectation.minimatch.globMatchRange
    ) {
      problems.push(
        `lockfile graph no longer matches the reviewed patched minimatch at ${patchedPath} (expected dev ${expectation.minimatch.version})`,
      );
    }
  }

  const brace = packages[expectation.braceExpansion.path];
  if (
    brace?.version !== expectation.braceExpansion.version ||
    brace?.dev !== expectation.braceExpansion.dev ||
    brace?.dependencies?.["balanced-match"] !== expectation.braceExpansion.balancedMatchRange
  ) {
    problems.push("lockfile graph no longer matches the reviewed TypeScript brace-expansion node");
  }

  const globMatch = packages[expectation.globMatch.path];
  if (globMatch?.version !== expectation.globMatch.version || globMatch?.dev !== expectation.globMatch.dev) {
    problems.push("lockfile graph no longer matches the reviewed @isaacs/nonrecursive-glob-match node");
  }

  const parents = Object.entries(packages)
    .filter(([, pkg]) => pkg?.dependencies?.minimatch)
    .map(([parentPath, pkg]) => ({
      dependencyRange: pkg.dependencies.minimatch,
      path: parentPath,
      version: pkg.version,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const expectedParents = [...expectation.minimatchParents].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (!sameStringSet(parents.map((parent) => JSON.stringify(parent)), expectedParents.map((parent) => JSON.stringify(parent)))) {
    problems.push("lockfile graph no longer matches the reviewed minimatch parent set");
  }

  // Dev-only proof, structural half: the runtime dependency set must never
  // mention minimatch.
  const runtimeDependencies = Object.keys(packages[""]?.dependencies ?? {});
  if (runtimeDependencies.includes("minimatch")) {
    problems.push("minimatch is declared as a runtime dependency; the reviewed graph is dev-only");
  }

  return problems;
}

// Identical-tree comparison of the reviewed npm overrides against the sibling
// package.json. Pure so the self-test can drive it.
function overrideProblems(packageJson) {
  const actual = packageJson?.overrides;
  if (stableJson(actual) !== stableJson(expectation.overrides)) {
    return [
      "ts/package.json overrides no longer match the reviewed minimatch override map (expected exactly the reviewed 11.0.9 overrides and no import-x exception)",
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// OSV finding collector
// ---------------------------------------------------------------------------

// Pure. Returns { entries, findings, problems }, where each entry keeps the raw
// { result, pkg, vuln } triple. A non-empty `problems` means the report shape
// would otherwise hide findings from the loop below: a missing or non-array
// results list, a malformed result entry, a non-array packages list, a
// malformed package entry, or a non-array vulnerabilities list. A string-valued
// `packages` used to iterate character by character and read as "no findings";
// a null result entry threw an uncaught TypeError.
function collectOsvFindings(report) {
  const entries = [];
  const findings = [];
  const problems = [];
  if (!isRecord(report)) {
    return {
      entries,
      findings,
      problems: [`OSV report is not a JSON object (got ${JSON.stringify(report)})`],
    };
  }
  if (!Array.isArray(report.results)) {
    return { entries, findings, problems: ["OSV report is missing its results array"] };
  }
  for (const result of report.results) {
    if (!isRecord(result)) {
      problems.push(`OSV report has a malformed result entry (got ${JSON.stringify(result)})`);
      continue;
    }
    const packages = result.packages;
    if (packages === undefined || packages === null) continue;
    if (!Array.isArray(packages)) {
      problems.push(`OSV report result.packages must be an array (got ${JSON.stringify(packages)})`);
      continue;
    }
    for (const pkg of packages) {
      if (!isRecord(pkg)) {
        problems.push(`OSV report has a malformed package entry (got ${JSON.stringify(pkg)})`);
        continue;
      }
      const vulnerabilities = pkg.vulnerabilities;
      if (vulnerabilities === undefined || vulnerabilities === null) continue;
      if (!Array.isArray(vulnerabilities)) {
        problems.push(
          `OSV report package.vulnerabilities must be an array (got ${JSON.stringify(vulnerabilities)})`,
        );
        continue;
      }
      for (const vuln of vulnerabilities) {
        if (!isRecord(vuln)) {
          problems.push(`OSV report has a malformed vulnerability entry (got ${JSON.stringify(vuln)})`);
          continue;
        }
        const packageInfo = isRecord(pkg.package) ? pkg.package : {};
        entries.push({ result, pkg, vuln });
        findings.push({
          fixedVersions: fixedVersions(vuln, packageInfo.name ?? "<unknown>"),
          id: vuln.id ?? "<unknown>",
          packageName: packageInfo.name ?? "<unknown>",
          source: result.source?.path ?? "<unknown>",
          version: packageInfo.version ?? "<unknown>",
        });
      }
    }
  }
  return { entries, findings, problems };
}

function fixedVersions(vuln, packageName) {
  const versions = [];
  for (const affected of vuln.affected ?? []) {
    if (affected?.package?.ecosystem !== "npm" || affected.package.name !== packageName) {
      continue;
    }
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event?.fixed) {
          versions.push(String(event.fixed));
        }
      }
    }
  }
  return [...new Set(versions)];
}

// ---------------------------------------------------------------------------
// Self-test (offline and deterministic: drives the reviewed-graph anchors, the
// override map, the E5 dev-chain exception and its negatives, the OSV report
// shape, the recheck_by boundary, and the removal condition; no network).
// ---------------------------------------------------------------------------

function runSelfTest() {
  const cases = [];
  const expect = (label, actual, expected) => cases.push({ label, actual, expected });

  const validPackages = () => ({
    "node_modules/minimatch": {
      version: "11.0.9",
      dev: true,
      dependencies: {
        "@isaacs/nonrecursive-glob-match": "^1.1.0",
        "brace-expansion": "^5.0.12",
      },
    },
    "node_modules/brace-expansion": {
      version: "5.0.12",
      dev: true,
      dependencies: { "balanced-match": "^4.0.2" },
    },
    "node_modules/@isaacs/nonrecursive-glob-match": { version: "1.1.0", dev: true },
    "node_modules/@eslint/config-array": { version: "0.23.6", dependencies: { minimatch: "^11.0.5" } },
    "node_modules/@typescript-eslint/typescript-estree": {
      version: "8.73.0",
      dependencies: { minimatch: "^11.0.1" },
    },
    "node_modules/eslint": { version: "10.15.0", dependencies: { minimatch: "^11.0.5" } },
    "node_modules/eslint-plugin-import-x": {
      version: "4.18.1",
      dependencies: { minimatch: "^9.0.3 || ^10.1.2 || ^11.0.1" },
    },
  });

  expect("the reviewed graph itself passes", lockfileGraphProblems(validPackages()).length, 0);

  const extraMinimatch = validPackages();
  extraMinimatch["node_modules/some-new-tool/node_modules/minimatch"] = {
    version: "10.2.6",
    dev: true,
    dependencies: { "brace-expansion": "^5.0.8" },
  };
  // Two problems: the path set changed and the extra node is below the floor.
  expect(
    "a planted extra minimatch path fails the graph",
    lockfileGraphProblems(extraMinimatch).length,
    2,
  );

  const restoredException = validPackages();
  restoredException["node_modules/eslint-plugin-import-x/node_modules/minimatch"] = {
    version: "10.2.6",
    dev: true,
    dependencies: { "brace-expansion": "^5.0.8" },
  };
  // The new "no exception" shape: a vulnerable copy reintroduced at the old
  // eslint-plugin-import-x path must fail both the exact path set and the floor.
  expect(
    "a vulnerable minimatch reintroduced at the old import-x path fails the graph",
    lockfileGraphProblems(restoredException).length,
    2,
  );

  const secondPatchedNode = validPackages();
  secondPatchedNode["node_modules/some-new-tool/node_modules/minimatch"] = {
    version: "11.0.1",
    dev: true,
    dependencies: { "@isaacs/nonrecursive-glob-match": "^1.0.1", "brace-expansion": "^5.0.12" },
  };
  expect(
    "a second minimatch node at another path fails the graph",
    lockfileGraphProblems(secondPatchedNode).length,
    1,
  );

  const driftedPatchedVersion = validPackages();
  driftedPatchedVersion["node_modules/minimatch"].version = "11.0.2";
  expect(
    "a drifted patched minimatch version fails the graph",
    lockfileGraphProblems(driftedPatchedVersion).length,
    1,
  );

  const driftedRange = validPackages();
  driftedRange["node_modules/minimatch"].dependencies["brace-expansion"] = "^5.0.7";
  expect("a drifted minimatch range fails the graph", lockfileGraphProblems(driftedRange).length, 1);

  const driftedParent = validPackages();
  driftedParent["node_modules/eslint"].dependencies.minimatch = "^10.2.4";
  expect("a drifted minimatch parent fails the graph", lockfileGraphProblems(driftedParent).length, 1);

  const retiredImportX = validPackages();
  retiredImportX["node_modules/eslint-plugin-import-x"] = {
    version: "4.17.1",
    dependencies: { minimatch: "^9.0.3 || ^10.1.2" },
  };
  expect("the retired import-x version fails the graph", lockfileGraphProblems(retiredImportX).length, 1);

  const fifthParent = validPackages();
  fifthParent["node_modules/eslint-plugin-unicorn"] = { version: "80.0.0", dependencies: { minimatch: "^10.0.0" } };
  expect("a fifth minimatch parent fails the graph", lockfileGraphProblems(fifthParent).length, 1);

  const productionMinimatch = validPackages();
  productionMinimatch["node_modules/minimatch"].dev = false;
  expect("a production minimatch fails the graph", lockfileGraphProblems(productionMinimatch).length, 1);

  const runtimeDependency = validPackages();
  runtimeDependency[""] = { dependencies: { minimatch: "^11.0.1" } };
  // Two problems: minimatch is now a runtime dependency and the root package
  // joins the minimatch parent set.
  expect(
    "a runtime minimatch dependency fails the graph",
    lockfileGraphProblems(runtimeDependency).length,
    2,
  );

  const braceDrift = validPackages();
  braceDrift["node_modules/brace-expansion"].version = "5.0.13";
  expect("a drifted brace-expansion version fails the graph", lockfileGraphProblems(braceDrift).length, 1);

  expect("the reviewed override map passes", overrideProblems({ overrides: expectation.overrides }).length, 0);
  expect("a missing override map fails", overrideProblems({}).length, 1);
  expect(
    "a dropped override fails",
    overrideProblems({ overrides: { minimatch: "11.0.1" } }).length,
    1,
  );
  const restoredOverride = JSON.parse(JSON.stringify(expectation.overrides));
  restoredOverride["eslint-plugin-import-x"] = { minimatch: "10.2.6" };
  expect(
    "a reintroduced import-x override fails",
    overrideProblems({ overrides: restoredOverride }).length,
    1,
  );

  expect("an empty results array has no problems", collectOsvFindings({ results: [] }).problems.length, 0);
  expect("a missing results array is a problem", collectOsvFindings({}).problems.length, 1);
  expect("a non-object report is a problem", collectOsvFindings(null).problems.length, 1);
  expect("a null result entry is a problem", collectOsvFindings({ results: [null] }).problems.length, 1);
  expect(
    "a string-valued packages list is a problem",
    collectOsvFindings({ results: [{ packages: "nope" }] }).problems.length,
    1,
  );
  expect(
    "a string-valued vulnerabilities list is a problem",
    collectOsvFindings({ results: [{ packages: [{ vulnerabilities: "nope" }] }] }).problems.length,
    1,
  );
  expect(
    "a null vulnerability entry is a problem",
    collectOsvFindings({ results: [{ packages: [{ vulnerabilities: [null] }] }] }).problems.length,
    1,
  );
  expect("a result with no packages has no problems", collectOsvFindings({ results: [{}] }).problems.length, 0);

  const oldExceptionFinding = collectOsvFindings({
    results: [
      {
        source: { path: "ts/package-lock.json" },
        packages: [
          {
            package: { ecosystem: "npm", name: "minimatch", version: "10.2.6" },
            vulnerabilities: [{ id: "GHSA-g3hv-75wg-m249", aliases: ["CVE-2026-118764"] }],
          },
        ],
      },
    ],
  });
  expect("a vulnerable minimatch finding is never excused", oldExceptionFinding.findings.length, 1);
  expect(
    "the old exception finding has no report-shape problems",
    oldExceptionFinding.problems.length,
    0,
  );

  // E5 (picomatch dev chain): the reviewed graph passes, and every deviation —
  // a non-dev path, an extra path, a runtime dependency, a drifted version, a
  // satisfied removal condition, or a drifted chain — fails closed.
  const validPicomatchPackages = () => ({
    "": { devDependencies: { "@typescript-eslint/parser": "^8.57.2" } },
    "node_modules/picomatch": { version: "4.0.7", dev: true },
    "node_modules/tinyglobby": {
      version: "0.2.17",
      dev: true,
      dependencies: { fdir: "^6.5.0", picomatch: "^4.0.4" },
    },
    "node_modules/fdir": {
      version: "6.5.0",
      dev: true,
      peerDependencies: { picomatch: "^3 || ^4" },
      peerDependenciesMeta: { picomatch: { optional: true } },
    },
    "node_modules/@typescript-eslint/typescript-estree": {
      version: "8.73.0",
      dev: true,
      dependencies: { tinyglobby: "^0.2.15" },
    },
    "node_modules/@typescript-eslint/parser": {
      version: "8.73.0",
      dev: true,
      dependencies: { "@typescript-eslint/typescript-estree": "8.73.0" },
    },
  });

  expect("(E5) the reviewed picomatch dev chain itself passes", picomatchGraphProblems(validPicomatchPackages()).length, 0);

  const productionPicomatch = validPicomatchPackages();
  productionPicomatch["node_modules/picomatch"].dev = false;
  expect("(E5) a non-dev picomatch fails the graph", picomatchGraphProblems(productionPicomatch).length, 1);

  const nestedPicomatch = validPicomatchPackages();
  delete nestedPicomatch["node_modules/picomatch"];
  nestedPicomatch["node_modules/tinyglobby/node_modules/picomatch"] = { version: "4.0.7", dev: true };
  expect("(E5) a picomatch at a nested path fails the graph", picomatchGraphProblems(nestedPicomatch).length, 1);

  const runtimePicomatch = validPicomatchPackages();
  runtimePicomatch[""].dependencies = { picomatch: "^4.0.4" };
  expect("(E5) a runtime picomatch dependency fails the graph", picomatchGraphProblems(runtimePicomatch).length, 1);

  const driftedPicomatch = validPicomatchPackages();
  driftedPicomatch["node_modules/picomatch"].version = "4.0.6";
  expect("(E5) a drifted picomatch version fails the graph", picomatchGraphProblems(driftedPicomatch).length, 1);

  const patchedPicomatch = validPicomatchPackages();
  patchedPicomatch["node_modules/picomatch"].version = "4.0.8";
  expect("(E5) a patched picomatch reports the removal condition", picomatchGraphProblems(patchedPicomatch).length, 1);

  const driftedChainRange = validPicomatchPackages();
  driftedChainRange["node_modules/tinyglobby"].dependencies.picomatch = "^4.0.0";
  expect("(E5) a drifted chain range fails the graph", picomatchGraphProblems(driftedChainRange).length, 1);

  const nonDevChainLink = validPicomatchPackages();
  nonDevChainLink["node_modules/tinyglobby"].dev = false;
  expect("(E5) a non-dev chain link fails the graph", picomatchGraphProblems(nonDevChainLink).length, 1);

  const droppedRootDevDep = validPicomatchPackages();
  delete droppedRootDevDep[""].devDependencies;
  expect("(E5) a chain root that is not a devDependency fails the graph", picomatchGraphProblems(droppedRootDevDep).length, 1);

  const e5Advisory = E5.advisories[0];
  const e5Entry = (overrides = {}) => {
    const entry = {
      result: { source: { path: "ts/package-lock.json" } },
      pkg: { package: { ecosystem: "npm", name: "picomatch", version: "4.0.7" } },
      vuln: { id: e5Advisory.id, aliases: e5Advisory.aliases },
    };
    Object.assign(entry, overrides.entry ?? {});
    if (overrides.pkg) Object.assign(entry.pkg.package, overrides.pkg);
    if (overrides.vuln) Object.assign(entry.vuln, overrides.vuln);
    return entry;
  };
  expect(
    "(E5) the exact OSV finding on this lockfile is excused",
    matchingException(e5Entry(), "ts/package-lock.json") === E5,
    true,
  );
  expect(
    "(E3) the same GHSA on another package is not excused",
    matchingException(e5Entry({ pkg: { name: "fast-glob" } }), "ts/package-lock.json") === null,
    true,
  );
  expect(
    "(E3) another advisory on picomatch is not excused",
    matchingException(
      e5Entry({ vuln: { id: "GHSA-0000-0000-0000", aliases: e5Advisory.aliases } }),
      "ts/package-lock.json",
    ) === null,
    true,
  );
  expect(
    "(E3) a different picomatch version is not excused",
    matchingException(e5Entry({ pkg: { version: "4.0.8" } }), "ts/package-lock.json") === null,
    true,
  );
  expect(
    "(E3) a different advisory alias is not excused",
    matchingException(
      e5Entry({ vuln: { aliases: ["CVE-0000-0000"] } }),
      "ts/package-lock.json",
    ) === null,
    true,
  );
  expect(
    "(E3) the same finding on another lockfile is not excused",
    matchingException(e5Entry(), "examples/cdk/multilang/package-lock.json") === null,
    true,
  );
  expect(
    "(E3) a finding whose OSV source path is the wrong lockfile is not excused",
    matchingException(
      e5Entry({ entry: { result: { source: { path: "examples/cdk/multilang/package-lock.json" } } } }),
      "ts/package-lock.json",
    ) === null,
    true,
  );

  expect("(E5) recheck_by: the day before is live", recheckExpired("2026-11-30T23:59:59Z", E5.recheckBy), false);
  expect("(E5) recheck_by: the deadline itself expires", recheckExpired("2026-12-01T00:00:00Z", E5.recheckBy), true);
  expect("(E5) recheck_by: a past deadline is expired", recheckExpired("2026-12-05T00:00:00Z", E5.recheckBy), true);
  expect(
    "(E5) removal: a patched picomatch is published",
    removalReasons({ publishedStablePatchedPicomatch: ["4.0.8"] }).length > 0,
    true,
  );
  expect(
    "(E5) stays live: no patched picomatch published",
    removalReasons({ publishedStablePatchedPicomatch: [] }).length === 0,
    true,
  );
  expect(
    "(E5) removal: a prerelease above the floor does not satisfy the removal condition",
    removalReasons({ publishedStablePatchedPicomatch: stableVersionsAtLeast(["4.0.8-rc.1"], E5.patchedFloor) })
      .length === 0,
    true,
  );

  let failures = 0;
  for (const testCase of cases) {
    if (testCase.actual !== testCase.expected) {
      console.error(
        `  self-test: ${testCase.label} expected ${testCase.expected}, got ${testCase.actual}`,
      );
      failures += 1;
    }
  }
  if (failures > 0) {
    console.error(`self-test: FAIL (${failures} of ${cases.length} cases)`);
    return 1;
  }
  console.log(
    `self-test: PASS (${cases.length} cases; reviewed minimatch graph, override map, E5 dev-chain exception, recheck_by, removal condition)`,
  );
  return 0;
}

if (selfTest) {
  process.exit(runSelfTest());
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function canonicalLockfilePath(candidate) {
  const normalized = normalizePath(candidate);
  const relative = path.isAbsolute(normalized) ? path.relative(repositoryRoot, normalized) : normalized;
  return normalizePath(relative);
}

async function main() {
  const report = readJson(reportPath, "scanner report");
  const lock = readJson(lockfilePath, "lockfile");
  const packages = lock.packages ?? {};
  const canonicalLockfile = canonicalLockfilePath(lockfilePath);

  if (canonicalLockfile !== expectation.lockfile) {
    fail(`lockfile ${canonicalLockfile} is outside the reviewed TypeScript lint-tool scope`);
  }

  // Hard recheck deadline: enforced before anything can be excused, so an
  // expired exception cannot survive by simply never matching a finding.
  const nowIso = new Date().toISOString();
  for (const exception of EXCEPTIONS) {
    if (recheckExpired(nowIso, exception.recheckBy)) {
      fail(
        `reviewed exception ${exception.exceptionId} reached its recheck_by deadline ${exception.recheckBy}; re-review and remove or renew it before the gate can pass`,
      );
    }
  }

  // Registry-backed removal probe: unconditional, so a patched picomatch
  // release cannot leave a stale exception in place.
  const removal = await removalProbe();
  if (removal.length > 0) {
    for (const reason of removal) {
      console.error(`osv-scanner: exception removal condition met - ${reason}`);
    }
    fail(
      "reviewed TypeScript dependency-audit exception removal condition met; remove the exception before the gate can pass",
    );
  }

  // Fail-closed integrity anchors: the exact reviewed graph, the reviewed
  // override map that produces it, and the E5 dev-only picomatch chain.
  const packageJsonPath = path.join(path.dirname(lockfilePath), "package.json");
  const packageJson = readJson(packageJsonPath, "package.json");
  const graphProblems = [
    ...lockfileGraphProblems(packages),
    ...overrideProblems(packageJson),
    ...picomatchGraphProblems(packages),
  ];
  if (graphProblems.length > 0) {
    for (const problem of graphProblems) {
      console.error(`osv-scanner: ${problem}`);
    }
    fail("lockfile graph no longer matches the reviewed TypeScript lint-tool dependency graph");
  }

  const { entries, findings, problems } = collectOsvFindings(report);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`osv-scanner: ${problem}`);
    }
    fail("OSV report shape is not one this gate can evaluate");
  }

  const unexpected = [];
  const applied = [];
  for (const entry of entries) {
    const exception = matchingException(entry, canonicalLockfile);
    const finding = {
      exceptionId: exception?.exceptionId ?? null,
      id: entry.vuln.id ?? "<unknown>",
      packageName: entry.pkg?.package?.name ?? "<unknown>",
      source: entry.result?.source?.path ?? "<unknown>",
      version: entry.pkg?.package?.version ?? "<unknown>",
    };
    (exception ? applied : unexpected).push(finding);
  }

  if (unexpected.length > 0) {
    for (const vuln of unexpected) {
      console.error(
        `osv-scanner: unexpected vulnerability ${vuln.id} in ${vuln.packageName}@${vuln.version} from ${vuln.source}`,
      );
    }
    fail("TypeScript lint-tool dependency findings are not excepted");
  }

  const appliedIds = [...new Set(applied.map((finding) => finding.exceptionId))].sort();
  for (const exceptionId of appliedIds) {
    const exception = EXCEPTIONS.find((candidate) => candidate.exceptionId === exceptionId);
    const count = applied.filter((finding) => finding.exceptionId === exceptionId).length;
    // Machine marker: the calling gate accepts a status-1 scanner exit only
    // when this exact marker is on stdout.
    console.log(
      `exception-applied: ${exceptionId} advisories=${exception.advisories
        .map((advisory) => advisory.id)
        .join(",")} findings=${count}`,
    );
    console.error(
      `osv-scanner: WARN ${JSON.stringify({
        recordType: "reviewed-vulnerability-exception",
        exceptionId,
        advisoryIds: exception.advisories.map((advisory) => advisory.id),
        operatorRuling: exception.operatorRuling,
        recheckBy: exception.recheckBy,
        removalCondition: exception.removalCondition,
        lockfile: canonicalLockfile,
        package: { name: exception.packageName, path: exception.packagePath, version: exception.packageVersion },
        devChain: exception.chain.map((link) => link.name),
      })}`,
    );
  }

  console.error(
    `osv-scanner: PASS ${JSON.stringify({
      recordType: "verified-patched-dependency-graph",
      checkId: expectation.checkId,
      lockfile: canonicalLockfile,
      justification:
        "The TypeScript lint stack uses the patched minimatch 11.0.9 for every consumer; the only picomatch finding is the reviewed dev-only E5 exception.",
      provenance: {
        braceExpansion: {
          path: expectation.braceExpansion.path,
          version: expectation.braceExpansion.version,
        },
        minimatch: {
          paths: expectation.minimatch.paths,
          version: expectation.minimatch.version,
        },
        minimatchParents: expectation.minimatchParents,
        overrides: expectation.overrides,
        picomatch: {
          path: E5.packagePath,
          version: E5.packageVersion,
          devChain: E5.chain.map((link) => link.name),
        },
      },
      reviewedExceptions: appliedIds,
    })}`,
  );
}

await main();
