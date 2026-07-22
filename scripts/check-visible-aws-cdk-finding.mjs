// Purpose: validate the one visible, expiring vulnerability exception for an
// upstream dependency bundled inside the published aws-cdk-lib tarball.
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

const report = readJson(reportPath, "scanner report");
const lock = readJson(lockfilePath, "lockfile");
const exception = {
  advisoryId: "GHSA-3jxr-9vmj-r5cp",
  advisoryUrl: "https://github.com/advisories/GHSA-3jxr-9vmj-r5cp",
  affectedRange: ">=3.0.0 <5.0.7",
  alias: "CVE-2026-13149",
  cdkVersion: "2.261.0",
  expiresOn: "2026-08-05",
  fixedVersion: "5.0.7",
  lockfile: normalizePath(lockfilePath),
  minimatchVersion: "10.2.5",
  packageName: "brace-expansion",
  packagePath: "node_modules/aws-cdk-lib/node_modules/brace-expansion",
  packageVersion: "5.0.6",
};

if (new Date().toISOString().slice(0, 10) > exception.expiresOn) {
  fail(
    `AWS CDK bundled ${exception.packageName} exception expired on ${exception.expiresOn}; update aws-cdk-lib or re-review the finding`,
  );
}

function lockfileMatchesException() {
  const packages = lock.packages ?? {};
  const vulnerablePaths = Object.entries(packages)
    .filter(([path, pkg]) => path.endsWith(exception.packageName) && pkg?.version === exception.packageVersion)
    .map(([path]) => path);
  const cdkPackage = packages["node_modules/aws-cdk-lib"];
  const minimatchPackage = packages["node_modules/aws-cdk-lib/node_modules/minimatch"];
  const bracePackage = packages[exception.packagePath];

  return (
    sameStringSet(vulnerablePaths, [exception.packagePath]) &&
    cdkPackage?.version === exception.cdkVersion &&
    Array.isArray(cdkPackage?.bundleDependencies) &&
    cdkPackage.bundleDependencies.includes("minimatch") &&
    minimatchPackage?.version === exception.minimatchVersion &&
    minimatchPackage?.inBundle === true &&
    minimatchPackage?.dependencies?.[exception.packageName] === "^5.0.5" &&
    bracePackage?.version === exception.packageVersion &&
    bracePackage?.inBundle === true
  );
}

if (!lockfileMatchesException()) {
  fail(`lockfile graph no longer matches the reviewed ${exception.packageName} exception`);
}

function hasFixedVersion(vuln) {
  for (const affected of vuln.affected ?? []) {
    if (affected?.package?.ecosystem !== "npm" || affected.package.name !== exception.packageName) {
      continue;
    }
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event?.fixed === exception.fixedVersion) {
          return true;
        }
      }
    }
  }
  return false;
}

function expectedOsvDependencyGroups() {
  // These deploy-only examples carry aws-cdk-lib in dependencies rather than
  // devDependencies, so osv-scanner omits dependency_groups for their locks.
  if (
    exception.lockfile === "examples/cdk/sqs-queue/package-lock.json" ||
    exception.lockfile === "examples/cdk/lambda-role/package-lock.json"
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
    vuln.name === exception.packageName &&
    vuln.severity === "high" &&
    vuln.isDirect === false &&
    Array.isArray(vuln.nodes) &&
    sameStringSet(vuln.nodes, [exception.packagePath]) &&
    sameStringSet(viaUrls, [exception.advisoryUrl]) &&
    sameStringSet(viaRanges, [exception.affectedRange])
  );
}

function verifyNpmReport() {
  const vulnerabilities = Object.values(report.vulnerabilities ?? {});
  if (vulnerabilities.length === 0) {
    fail("scanner returned nonzero without vulnerabilities in report");
  }

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
  const aliases = (vuln.aliases ?? []).map(String);
  const dependencyGroups = (pkg.dependency_groups ?? []).map(String);

  return (
    (sourcePath === exception.lockfile || sourcePath.endsWith(`/${exception.lockfile}`)) &&
    packageInfo.ecosystem === "npm" &&
    packageInfo.name === exception.packageName &&
    packageInfo.version === exception.packageVersion &&
    sameStringSet(dependencyGroups, expectedOsvDependencyGroups()) &&
    vuln.id === exception.advisoryId &&
    aliases.includes(exception.alias) &&
    hasFixedVersion(vuln)
  );
}

function verifyOsvReport() {
  const unexpected = [];
  let visibleCount = 0;
  for (const result of report.results ?? []) {
    for (const pkg of result.packages ?? []) {
      for (const vuln of pkg.vulnerabilities ?? []) {
        if (matchesOsvFinding(result, pkg, vuln)) {
          visibleCount += 1;
        } else {
          unexpected.push({
            id: vuln.id ?? "<unknown>",
            packageName: pkg?.package?.name ?? "<unknown>",
            version: pkg?.package?.version ?? "<unknown>",
            source: result?.source?.path ?? "<unknown>",
          });
        }
      }
    }
  }

  if (unexpected.length > 0 || visibleCount !== 1) {
    for (const vuln of unexpected) {
      console.error(
        `osv-scanner: unexpected vulnerability ${vuln.id} in ${vuln.packageName}@${vuln.version} from ${vuln.source}`,
      );
    }
    fail(`expected exactly one visible AWS CDK bundled finding, matched ${visibleCount}`);
  }
}

if (mode === "npm") {
  verifyNpmReport();
} else {
  verifyOsvReport();
}

console.error(
  `${mode}-scanner: WARN (visible upstream AWS CDK bundle finding ${exception.advisoryId} / ${exception.alias} in ${exception.lockfile}; expires ${exception.expiresOn}; remove when aws-cdk-lib bundles >=${exception.fixedVersion})`,
);
