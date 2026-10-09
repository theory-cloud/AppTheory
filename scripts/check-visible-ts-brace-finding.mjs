// Purpose: validate the exact reviewed, exception-free TypeScript lint-tool
// brace-expansion graph.
//
// SEC-2 grants no TypeScript dependency-audit exception. The eslint 10 +
// eslint-plugin-import-x train hoisted the lint stack onto a single
// minimatch 10.x / brace-expansion 5.x path, retiring the vulnerable
// minimatch 3.x -> brace-expansion 1.x instance that the former
// GHSA-rgw5-rvv9-x895 exception covered. This checker therefore requires both
// the exact graph below and an empty scanner report: any package, parent,
// version, path, or finding drift fails closed.
import fs from "node:fs";

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

function normalizePath(path) {
  return String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function sameStringSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  return actualSorted.every((value, index) => value === expectedSorted[index]);
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

const report = selfTest ? null : readJson(reportPath, "scanner report");
const lock = selfTest ? null : readJson(lockfilePath, "lockfile");
const expectation = {
  braceExpansion: {
    balancedMatchRange: "^4.0.2",
    dev: true,
    path: "node_modules/brace-expansion",
    version: "5.0.12",
  },
  lockfile: normalizePath(lockfilePath),
  minimatch: {
    braceExpansionRange: "^5.0.8",
    dev: true,
    path: "node_modules/minimatch",
    version: "10.2.6",
  },
  // Re-anchored for the eslint 10 + eslint-plugin-import-x train: eslint 10
  // dropped `@eslint/eslintrc` and moved to `minimatch ^10.2.5`, and the swap
  // replaced the eslint-plugin-import parent with eslint-plugin-import-x. Every
  // remaining parent now resolves the single hoisted minimatch 10.x below.
  minimatchParents: [
    {
      dependencyRange: "^10.2.4",
      path: "node_modules/@eslint/config-array",
      version: "0.23.5",
    },
    {
      dependencyRange: "^10.2.2",
      path: "node_modules/@typescript-eslint/typescript-estree",
      version: "8.71.0",
    },
    {
      dependencyRange: "^10.2.5",
      path: "node_modules/eslint",
      version: "10.11.0",
    },
    {
      dependencyRange: "^9.0.3 || ^10.1.2",
      path: "node_modules/eslint-plugin-import-x",
      version: "4.17.1",
    },
  ],
};

// Pure: every way the lockfile can deviate from the reviewed graph. An empty
// list is the only passing state. The expected brace-expansion path comes from
// `expectation` rather than being repeated here, so the two cannot drift apart.
function lockfileGraphProblems(packages) {
  const bracePaths = Object.keys(packages).filter(
    (path) =>
      path === expectation.braceExpansion.path ||
      path.endsWith(`/${expectation.braceExpansion.path}`),
  );
  const minimatchPaths = Object.keys(packages).filter(
    (path) =>
      path === expectation.minimatch.path || path.endsWith(`/${expectation.minimatch.path}`),
  );
  const minimatchParents = Object.entries(packages)
    .filter(([, pkg]) => pkg?.dependencies?.minimatch)
    .map(([path, pkg]) => ({
      dependencyRange: pkg.dependencies.minimatch,
      path,
      version: pkg.version,
    }));
  const braceExpansionPackage = packages[expectation.braceExpansion.path];
  const minimatchPackage = packages[expectation.minimatch.path];

  const matches =
    sameStringSet(bracePaths, [expectation.braceExpansion.path]) &&
    sameStringSet(minimatchPaths, [expectation.minimatch.path]) &&
    sameStringSet(
      minimatchParents.map((parent) => JSON.stringify(parent)),
      expectation.minimatchParents.map((parent) => JSON.stringify(parent)),
    ) &&
    braceExpansionPackage?.version === expectation.braceExpansion.version &&
    braceExpansionPackage?.dev === expectation.braceExpansion.dev &&
    braceExpansionPackage?.dependencies?.["balanced-match"] ===
      expectation.braceExpansion.balancedMatchRange &&
    minimatchPackage?.version === expectation.minimatch.version &&
    minimatchPackage?.dev === expectation.minimatch.dev &&
    minimatchPackage?.dependencies?.["brace-expansion"] === expectation.minimatch.braceExpansionRange;

  return matches
    ? []
    : ["lockfile graph no longer matches the reviewed TypeScript lint-tool brace-expansion path"];
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Pure. Returns { findings, problems }. A non-empty `problems` means the report
// shape would otherwise hide findings from the loop below: a missing or
// non-array results list, a malformed result entry, a non-array packages list,
// a malformed package entry, or a non-array vulnerabilities list. A
// string-valued `packages` used to iterate character by character and read as
// "no findings"; a null result entry threw an uncaught TypeError.
function collectOsvFindings(report) {
  const findings = [];
  const problems = [];
  if (!isRecord(report)) {
    return {
      findings,
      problems: [`OSV report is not a JSON object (got ${JSON.stringify(report)})`],
    };
  }
  if (!Array.isArray(report.results)) {
    return { findings, problems: ["OSV report is missing its results array"] };
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
  return { findings, problems };
}

// ---------------------------------------------------------------------------
// Self-test (offline and deterministic: drives the reviewed-graph anchors and
// the OSV report contract, including the malformed shapes that used to read as
// "no findings").
// ---------------------------------------------------------------------------

function runSelfTest() {
  const cases = [];
  const expect = (label, actual, expected) => cases.push({ label, actual, expected });

  const validPackages = () => ({
    "node_modules/brace-expansion": {
      version: "5.0.12",
      dev: true,
      dependencies: { "balanced-match": "^4.0.2" },
    },
    "node_modules/minimatch": {
      version: "10.2.6",
      dev: true,
      dependencies: { "brace-expansion": "^5.0.8" },
    },
    "node_modules/@eslint/config-array": { version: "0.23.5", dependencies: { minimatch: "^10.2.4" } },
    "node_modules/@typescript-eslint/typescript-estree": {
      version: "8.71.0",
      dependencies: { minimatch: "^10.2.2" },
    },
    "node_modules/eslint": { version: "10.11.0", dependencies: { minimatch: "^10.2.5" } },
    "node_modules/eslint-plugin-import-x": {
      version: "4.17.1",
      dependencies: { minimatch: "^9.0.3 || ^10.1.2" },
    },
  });

  expect("the reviewed graph itself passes", lockfileGraphProblems(validPackages()).length, 0);

  const plantedNested = validPackages();
  plantedNested["node_modules/brace-expansion/lib/node_modules/brace-expansion"] = {
    version: "5.0.12",
    dev: true,
  };
  expect(
    "a planted nested brace-expansion path fails the graph",
    lockfileGraphProblems(plantedNested).length,
    1,
  );

  const relocated = validPackages();
  delete relocated["node_modules/brace-expansion"];
  relocated["node_modules/foo/node_modules/brace-expansion"] = { version: "5.0.12", dev: true };
  expect("a relocated brace-expansion path fails the graph", lockfileGraphProblems(relocated).length, 1);

  const driftedVersion = validPackages();
  driftedVersion["node_modules/brace-expansion"].version = "5.0.13";
  expect(
    "a drifted brace-expansion version fails the graph",
    lockfileGraphProblems(driftedVersion).length,
    1,
  );

  const driftedRange = validPackages();
  driftedRange["node_modules/minimatch"].dependencies["brace-expansion"] = "^5.0.7";
  expect("a drifted minimatch range fails the graph", lockfileGraphProblems(driftedRange).length, 1);

  const driftedParent = validPackages();
  driftedParent["node_modules/eslint"].dependencies.minimatch = "^10.2.4";
  expect("a drifted minimatch parent fails the graph", lockfileGraphProblems(driftedParent).length, 1);

  const productionBrace = validPackages();
  productionBrace["node_modules/brace-expansion"].dev = false;
  expect("a production brace-expansion fails the graph", lockfileGraphProblems(productionBrace).length, 1);

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

  const findingReport = {
    results: [
      {
        source: { path: "ts/package-lock.json" },
        packages: [
          {
            package: { ecosystem: "npm", name: "brace-expansion", version: "5.0.12" },
            vulnerabilities: [{ id: "GHSA-0000-0000-0000", affected: [] }],
          },
        ],
      },
    ],
  };
  const collected = collectOsvFindings(findingReport);
  expect("a well-formed finding has no problems", collected.problems.length, 0);
  expect("a well-formed finding is collected", collected.findings.length, 1);
  expect("a collected finding keeps its advisory id", collected.findings[0]?.id, "GHSA-0000-0000-0000");

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
    `self-test: PASS (${cases.length} cases; reviewed brace-expansion graph and OSV report contract)`,
  );
  return 0;
}

if (selfTest) {
  process.exit(runSelfTest());
}

// No TypeScript dependency-audit exception is granted, so every reported
// vulnerability is unexpected and a clean scanner report is the only passing
// state.
const graphProblems = lockfileGraphProblems(lock.packages ?? {});
if (graphProblems.length > 0) {
  for (const problem of graphProblems) {
    console.error(`osv-scanner: ${problem}`);
  }
  fail("lockfile graph no longer matches the reviewed TypeScript lint-tool brace-expansion path");
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
  fail("TypeScript lint-tool findings must be empty; SEC-2 grants no exception");
}

console.error(
  `osv-scanner: PASS ${JSON.stringify({
    recordType: "verified-clean-dependency-graph",
    checkId: "typescript-lint-tool-brace-expansion",
    lockfile: expectation.lockfile,
    justification:
      "The eslint 10 + eslint-plugin-import-x train retired the minimatch 3.x -> brace-expansion 1.x path; SEC-2 grants no TypeScript dependency-audit exception.",
    provenance: {
      braceExpansion: {
        path: expectation.braceExpansion.path,
        version: expectation.braceExpansion.version,
      },
      minimatch: {
        braceExpansionRange: expectation.minimatch.braceExpansionRange,
        path: expectation.minimatch.path,
        version: expectation.minimatch.version,
      },
      minimatchParents: expectation.minimatchParents,
    },
  })}`,
);
