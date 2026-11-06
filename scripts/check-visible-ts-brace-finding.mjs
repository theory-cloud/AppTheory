// Purpose: validate the reviewed TypeScript lint-tool dependency graph and prove
// that no vulnerable minimatch finding is visible to the ts/ OSV audit surface.
//
// ===========================================================================
// No dependency-audit exception
// ===========================================================================
// SEC-2 ("none may be added without an operator ruling") previously granted one
// dev-only exception, E4 (`ts-dev-import-x-minimatch`), for minimatch 10.2.6
// kept for eslint-plugin-import-x 4.17.1. minimatch 11 removed the `makeRe`
// export that the plugin imported at module load, so a minimatch 11 override
// broke ESLint config load.
//
// E4 is closed. eslint-plugin-import-x 4.18.0 supports minimatch 9, 10, and 11
// and no longer imports `makeRe` (upstream #570), so its published dependency
// range is `^9.0.3 || ^10.1.2 || ^11.0.1`; the exception's removal condition
// ("eslint-plugin-import-x publishes a release compatible with minimatch
// >= 11.0.1") was met and the exception was removed on 2026-11-06.
//
// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------
// The reviewed graph is exact and fail closed:
//   * the lockfile must carry exactly one minimatch node, the patched 11.0.1
//     at node_modules/minimatch; an additional minimatch node at any path
//     fails, and every minimatch node is also compared against the patched
//     floor 11.0.1 explicitly, so a vulnerable copy reintroduced at the old
//     eslint-plugin-import-x path fails;
//   * brace-expansion, @isaacs/nonrecursive-glob-match, the exact minimatch
//     parent set, the dev flags, and the reviewed npm `overrides` map are
//     pinned, so an unreviewed install cannot silently weaken the graph;
//   * any OSV finding for this lockfile fails; there is no exception matcher.
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
    version: "1.0.3",
  },
  // The single patched minimatch node. eslint-plugin-import-x 4.18.0 accepts
  // minimatch 11, so every consumer dedupes onto the same hoisted 11.0.1.
  minimatch: {
    braceExpansionRange: "^5.0.12",
    dev: true,
    globMatchRange: "^1.0.1",
    paths: ["node_modules/minimatch"],
    version: "11.0.1",
  },
  // Every package in the lockfile that declares a minimatch dependency. The
  // consumers keep their original 10.x ranges; the override, not the range,
  // moves them onto the patched 11.0.1.
  minimatchParents: [
    {
      dependencyRange: "^10.2.4",
      path: "node_modules/@eslint/config-array",
      version: "0.23.5",
    },
    {
      dependencyRange: "^10.2.2",
      path: "node_modules/@typescript-eslint/typescript-estree",
      version: "8.72.1",
    },
    {
      dependencyRange: "^10.2.6",
      path: "node_modules/eslint",
      version: "10.14.0",
    },
    {
      dependencyRange: "^9.0.3 || ^10.1.2 || ^11.0.1",
      path: "node_modules/eslint-plugin-import-x",
      version: "4.18.0",
    },
  ],
  // The npm overrides that produce the reviewed graph. The lockfile does not
  // record overrides, so the sibling package.json is checked directly: losing
  // an override would let a later install drift back onto a vulnerable
  // minimatch, and re-adding an import-x exception would recreate the retired
  // exception's shape.
  overrides: {
    minimatch: "11.0.1",
    eslint: { minimatch: "11.0.1" },
    "@eslint/config-array": { minimatch: "11.0.1" },
    "@typescript-eslint/typescript-estree": { minimatch: "11.0.1" },
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
      "lockfile graph no longer matches the reviewed TypeScript lint-tool minimatch paths (expected exactly one patched 11.0.1 node at node_modules/minimatch)",
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
      "ts/package.json overrides no longer match the reviewed minimatch override map (expected exactly the reviewed 11.0.1 overrides and no import-x exception)",
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
// override map, and the OSV report shape; no exception path exists).
// ---------------------------------------------------------------------------

function runSelfTest() {
  const cases = [];
  const expect = (label, actual, expected) => cases.push({ label, actual, expected });

  const validPackages = () => ({
    "node_modules/minimatch": {
      version: "11.0.1",
      dev: true,
      dependencies: {
        "@isaacs/nonrecursive-glob-match": "^1.0.1",
        "brace-expansion": "^5.0.12",
      },
    },
    "node_modules/brace-expansion": {
      version: "5.0.12",
      dev: true,
      dependencies: { "balanced-match": "^4.0.2" },
    },
    "node_modules/@isaacs/nonrecursive-glob-match": { version: "1.0.3", dev: true },
    "node_modules/@eslint/config-array": { version: "0.23.5", dependencies: { minimatch: "^10.2.4" } },
    "node_modules/@typescript-eslint/typescript-estree": {
      version: "8.72.1",
      dependencies: { minimatch: "^10.2.2" },
    },
    "node_modules/eslint": { version: "10.14.0", dependencies: { minimatch: "^10.2.6" } },
    "node_modules/eslint-plugin-import-x": {
      version: "4.18.0",
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
    `self-test: PASS (${cases.length} cases; reviewed minimatch graph, override map, no-exception OSV findings)`,
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

  // Fail-closed integrity anchors: the exact reviewed graph and the reviewed
  // override map that produces it.
  const packageJsonPath = path.join(path.dirname(lockfilePath), "package.json");
  const packageJson = readJson(packageJsonPath, "package.json");
  const graphProblems = [...lockfileGraphProblems(packages), ...overrideProblems(packageJson)];
  if (graphProblems.length > 0) {
    for (const problem of graphProblems) {
      console.error(`osv-scanner: ${problem}`);
    }
    fail("lockfile graph no longer matches the reviewed TypeScript lint-tool minimatch graph");
  }

  const { findings, problems } = collectOsvFindings(report);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`osv-scanner: ${problem}`);
    }
    fail("OSV report shape is not one this gate can evaluate");
  }

  if (findings.length > 0) {
    for (const vuln of findings) {
      console.error(
        `osv-scanner: unexpected vulnerability ${vuln.id} in ${vuln.packageName}@${vuln.version} from ${vuln.source} (fixed versions: ${JSON.stringify(vuln.fixedVersions)})`,
      );
    }
    fail("TypeScript lint-tool dependency findings are not excepted");
  }

  console.error(
    `osv-scanner: PASS ${JSON.stringify({
      recordType: "verified-patched-dependency-graph",
      checkId: expectation.checkId,
      lockfile: canonicalLockfile,
      justification:
        "The TypeScript lint stack uses the patched minimatch 11.0.1 for every consumer; no dependency-audit exception applies.",
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
      },
    })}`,
  );
}

await main();
