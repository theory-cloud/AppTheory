// Purpose: validate the exact reviewed vulnerability exception for
// aws-cdk-lib's bundled brace-expansion path.
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
  advisoryId: "GHSA-mh99-v99m-4gvg",
  advisoryUrl: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
  alias: "CVE-2026-14257",
  cdkVersion: "2.263.0",
  fixedVersions: ["1.1.17", "2.1.3", "3.0.3", "5.0.8"],
  lockfile: normalizePath(lockfilePath),
  minimatchVersion: "10.2.5",
  packageName: "brace-expansion",
  packagePath: "node_modules/aws-cdk-lib/node_modules/brace-expansion",
  packageVersion: "5.0.8",
};
const exception = {
  advisoryId: "GHSA-rgw5-rvv9-x895",
  advisoryUrl: "https://github.com/advisories/GHSA-rgw5-rvv9-x895",
  affectedRange: ">=4.0.0 <5.0.9",
  alias: "CVE-2026-69152",
  fixedVersions: ["1.1.18", "2.1.4", "3.0.6", "5.0.9"],
  justification:
    "New advisory; no fixed aws-cdk release available; operator-authorized exception 2026-08-03 pending upstream fix.",
  npmRange: "4.0.0 - 5.0.8",
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

function expectedOsvDependencyGroups() {
  // These deploy-only examples carry aws-cdk-lib in dependencies rather than
  // devDependencies, so osv-scanner omits dependency_groups for their locks.
  if (
    expectation.lockfile === "examples/cdk/sqs-queue/package-lock.json" ||
    expectation.lockfile === "examples/cdk/lambda-role/package-lock.json"
  ) {
    return [];
  }
  return ["dev"];
}

function matchesNpmFinding(vuln) {
  const viaObjects = (vuln.via ?? []).filter((entry) => entry && typeof entry === "object");
  const viaUrls = viaObjects.map((entry) => String(entry.url ?? "")).filter(Boolean);
  const viaRanges = viaObjects.map((entry) => String(entry.range ?? "")).filter(Boolean);

  return (
    vuln.name === expectation.packageName &&
    vuln.severity === "high" &&
    vuln.isDirect === false &&
    vuln.range === exception.npmRange &&
    Array.isArray(vuln.nodes) &&
    sameStringSet(vuln.nodes, [expectation.packagePath]) &&
    Array.isArray(vuln.effects) &&
    vuln.effects.length === 0 &&
    viaObjects.length === 1 &&
    sameStringSet(viaUrls, [exception.advisoryUrl]) &&
    sameStringSet(viaRanges, [exception.affectedRange])
  );
}

function verifyNpmReport() {
  if (report.error || !report.vulnerabilities || typeof report.vulnerabilities !== "object") {
    fail("npm audit report is missing its vulnerability map");
  }
  const vulnerabilities = Object.values(report.vulnerabilities);
  const visible = vulnerabilities.filter((vuln) => matchesNpmFinding(vuln));
  const unexpected = vulnerabilities.filter((vuln) => !matchesNpmFinding(vuln));
  if (visible.length !== 1 || unexpected.length > 0) {
    for (const vuln of unexpected) {
      const nodes = Array.isArray(vuln.nodes) ? vuln.nodes.join(", ") : "<unknown nodes>";
      const via = (vuln.via ?? [])
        .map((entry) => (entry && typeof entry === "object" ? entry.url || entry.title || entry.name : entry))
        .filter(Boolean)
        .join(", ");
      console.error(
        `npm-scanner: unexpected vulnerability ${vuln.name ?? "<unknown>"} (${vuln.severity ?? "unknown"}) at ${nodes}${via ? ` via ${via}` : ""}`,
      );
    }
    fail(`expected exactly one visible AWS CDK bundled finding, matched ${visible.length}`);
  }
}

function matchesOsvFinding(result, pkg, vuln) {
  const sourcePath = normalizePath(result?.source?.path);
  const packageInfo = pkg?.package ?? {};

  return (
    (sourcePath === expectation.lockfile || sourcePath.endsWith(`/${expectation.lockfile}`)) &&
    packageInfo.ecosystem === "npm" &&
    packageInfo.name === expectation.packageName &&
    packageInfo.version === expectation.packageVersion &&
    sameStringSet((pkg.dependency_groups ?? []).map(String), expectedOsvDependencyGroups()) &&
    vuln.id === exception.advisoryId &&
    sameStringSet((vuln.aliases ?? []).map(String), [exception.alias]) &&
    sameStringSet(fixedVersions(vuln, expectation.packageName), exception.fixedVersions)
  );
}

function verifyOsvReport() {
  if (!Array.isArray(report.results)) {
    fail("OSV report is missing its results array");
  }
  const visible = [];
  const unexpected = [];
  for (const result of report.results) {
    for (const pkg of result.packages ?? []) {
      for (const vuln of pkg.vulnerabilities ?? []) {
        if (matchesOsvFinding(result, pkg, vuln)) {
          visible.push(vuln);
        } else {
          unexpected.push({
            fixedVersions: fixedVersions(vuln, expectation.packageName),
            id: vuln.id ?? "<unknown>",
            packageName: pkg?.package?.name ?? "<unknown>",
            source: result?.source?.path ?? "<unknown>",
            version: pkg?.package?.version ?? "<unknown>",
          });
        }
      }
    }
  }

  if (visible.length !== 1 || unexpected.length > 0) {
    for (const vuln of unexpected) {
      console.error(
        `osv-scanner: unexpected vulnerability ${vuln.id} in ${vuln.packageName}@${vuln.version} from ${vuln.source} (fixed versions: ${JSON.stringify(vuln.fixedVersions)})`,
      );
    }
    fail(`expected exactly one visible AWS CDK bundled finding, matched ${visible.length}`);
  }
}

if (mode === "npm") {
  verifyNpmReport();
} else {
  verifyOsvReport();
}

console.error(
  `${mode}-scanner: WARN ${JSON.stringify({
    recordType: "reviewed-vulnerability-exception",
    exceptionId: "aws-cdk-lib-bundled-brace-expansion",
    advisoryId: exception.advisoryId,
    advisoryUrl: exception.advisoryUrl,
    affectedRange: exception.affectedRange,
    alias: exception.alias,
    fixedVersions: exception.fixedVersions,
    justification: exception.justification,
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
