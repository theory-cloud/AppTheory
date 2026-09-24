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

const [reportPath, lockfilePath] = process.argv.slice(2);

if (!reportPath || !lockfilePath) {
  console.error(
    "usage: node scripts/check-visible-ts-brace-finding.mjs <osv-report-json> <package-lock.json>",
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

const report = readJson(reportPath, "scanner report");
const lock = readJson(lockfilePath, "lockfile");
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
      version: "8.70.1",
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

const packages = lock.packages ?? {};
const bracePaths = Object.keys(packages).filter(
  (path) => path === "node_modules/brace-expansion" || path.endsWith("/node_modules/brace-expansion"),
);
const minimatchPaths = Object.keys(packages).filter(
  (path) => path === "node_modules/minimatch" || path.endsWith("/node_modules/minimatch"),
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

if (
  !sameStringSet(bracePaths, [expectation.braceExpansion.path]) ||
  !sameStringSet(minimatchPaths, [expectation.minimatch.path]) ||
  !sameStringSet(
    minimatchParents.map((parent) => JSON.stringify(parent)),
    expectation.minimatchParents.map((parent) => JSON.stringify(parent)),
  ) ||
  braceExpansionPackage?.version !== expectation.braceExpansion.version ||
  braceExpansionPackage?.dev !== expectation.braceExpansion.dev ||
  braceExpansionPackage?.dependencies?.["balanced-match"] !==
    expectation.braceExpansion.balancedMatchRange ||
  minimatchPackage?.version !== expectation.minimatch.version ||
  minimatchPackage?.dev !== expectation.minimatch.dev ||
  minimatchPackage?.dependencies?.["brace-expansion"] !== expectation.minimatch.braceExpansionRange
) {
  fail("lockfile graph no longer matches the reviewed TypeScript lint-tool brace-expansion path");
}

// No TypeScript dependency-audit exception is granted, so every reported
// vulnerability is unexpected and a clean scanner report is the only passing
// state.
const findings = [];
if (!Array.isArray(report.results)) {
  fail("OSV report is missing its results array");
}
for (const result of report.results) {
  for (const pkg of result.packages ?? []) {
    for (const vuln of pkg.vulnerabilities ?? []) {
      const packageInfo = pkg?.package ?? {};
      findings.push({
        fixedVersions: fixedVersions(vuln, packageInfo.name ?? "<unknown>"),
        id: vuln.id ?? "<unknown>",
        packageName: packageInfo.name ?? "<unknown>",
        source: result?.source?.path ?? "<unknown>",
        version: packageInfo.version ?? "<unknown>",
      });
    }
  }
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
