// Purpose: validate that aws-cdk-lib's bundled brace-expansion path is
// patched and no longer produces npm-audit or OSV findings.
import fs from "node:fs";

const [mode, reportPath, lockfilePath] = process.argv.slice(2);

if (!new Set(["npm", "osv"]).has(mode) || !reportPath || !lockfilePath) {
  console.error(
    "usage: node scripts/check-visible-aws-cdk-finding.mjs <npm|osv> <report-json> <package-lock.json>",
  );
  process.exit(2);
}

function fail(message) {
  console.error(`${mode}-scanner: FAIL (${message})`);
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
        if (event?.fixed) versions.push(String(event.fixed));
      }
    }
  }
  return [...new Set(versions)];
}

const report = readJson(reportPath, "scanner report");
const lock = readJson(lockfilePath, "lockfile");
const expectation = {
  advisoryId: "GHSA-rgw5-rvv9-x895",
  advisoryUrl: "https://github.com/advisories/GHSA-rgw5-rvv9-x895",
  alias: "CVE-2026-69152",
  cdkVersion: "2.265.0",
  fixedVersions: ["1.1.18", "2.1.4", "3.0.6", "5.0.9"],
  lockfile: normalizePath(lockfilePath),
  minimatchVersion: "10.2.5",
  packageName: "brace-expansion",
  packagePath: "node_modules/aws-cdk-lib/node_modules/brace-expansion",
  packageVersion: "5.0.9",
};

const packages = lock.packages ?? {};
const bracePaths = Object.keys(packages).filter(
  (path) =>
    path === `node_modules/${expectation.packageName}` ||
    path.endsWith(`/node_modules/${expectation.packageName}`),
);
const cdkPackage = packages["node_modules/aws-cdk-lib"];
const minimatchPackage = packages["node_modules/aws-cdk-lib/node_modules/minimatch"];
const bracePackage = packages[expectation.packagePath];

if (
  !sameStringSet(bracePaths, [expectation.packagePath]) ||
  cdkPackage?.version !== expectation.cdkVersion ||
  !Array.isArray(cdkPackage?.bundleDependencies) ||
  !cdkPackage.bundleDependencies.includes("minimatch") ||
  minimatchPackage?.version !== expectation.minimatchVersion ||
  minimatchPackage?.inBundle !== true ||
  minimatchPackage?.dependencies?.[expectation.packageName] !== "^5.0.5" ||
  bracePackage?.version !== expectation.packageVersion ||
  bracePackage?.inBundle !== true ||
  bracePackage?.dependencies?.["balanced-match"] !== "^4.0.2"
) {
  fail(`lockfile graph no longer matches the patched AWS CDK bundled ${expectation.packageName} path`);
}

const findings = [];
if (mode === "npm") {
  if (report.error || !report.vulnerabilities || typeof report.vulnerabilities !== "object") {
    fail("npm audit report is missing its vulnerability map");
  }
  for (const vuln of Object.values(report.vulnerabilities)) {
    findings.push({
      id: (vuln.via ?? [])
        .map((entry) => (entry && typeof entry === "object" ? entry.url || entry.title || entry.name : entry))
        .filter(Boolean)
        .join(", ") || "<unknown>",
      packageName: vuln.name ?? "<unknown>",
      source: expectation.lockfile,
      version: (vuln.nodes ?? []).join(", ") || "<unknown>",
    });
  }
} else {
  if (!Array.isArray(report.results)) {
    fail("OSV report is missing its results array");
  }
  for (const result of report.results) {
    for (const pkg of result.packages ?? []) {
      for (const vuln of pkg.vulnerabilities ?? []) {
        const packageInfo = pkg?.package ?? {};
        findings.push({
          fixedVersions: fixedVersions(vuln, expectation.packageName),
          id: vuln.id ?? "<unknown>",
          packageName: packageInfo.name ?? "<unknown>",
          source: result?.source?.path ?? "<unknown>",
          version: packageInfo.version ?? "<unknown>",
        });
      }
    }
  }
}

if (findings.length > 0) {
  for (const vuln of findings) {
    const fixed = vuln.fixedVersions ? ` (fixed versions: ${JSON.stringify(vuln.fixedVersions)})` : "";
    console.error(
      `${mode}-scanner: unexpected vulnerability ${vuln.id} in ${vuln.packageName}@${vuln.version} from ${vuln.source}${fixed}`,
    );
  }
  fail("expected no AWS CDK findings after the bundled brace-expansion patch");
}

console.error(
  `${mode}-scanner: PASS ${JSON.stringify({
    recordType: "verified-patched-dependency",
    checkId: "aws-cdk-lib-bundled-brace-expansion",
    advisoryId: expectation.advisoryId,
    advisoryUrl: expectation.advisoryUrl,
    alias: expectation.alias,
    fixedVersions: expectation.fixedVersions,
    lockfile: expectation.lockfile,
    package: {
      name: expectation.packageName,
      path: expectation.packagePath,
      version: expectation.packageVersion,
    },
    provenance: {
      awsCdkLib: {
        path: "node_modules/aws-cdk-lib",
        version: expectation.cdkVersion,
      },
      minimatch: {
        dependencyRange: "^5.0.5",
        path: "node_modules/aws-cdk-lib/node_modules/minimatch",
        version: expectation.minimatchVersion,
      },
    },
  })}`,
);
