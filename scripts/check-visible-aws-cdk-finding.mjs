// Purpose: validate the visible, expiring vulnerability exceptions for one
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
  advisories: [
    {
      advisoryId: "GHSA-mh99-v99m-4gvg",
      advisoryUrl: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
      affectedRange: ">=4.0.0 <5.0.8",
      alias: "CVE-2026-14257",
      fixedVersions: ["1.1.17", "2.1.3", "3.0.3", "5.0.8"],
      npmRange: "4.0.0 - 5.0.7",
    },
  ],
  cdkVersion: "2.262.2",
  expiresOn: "2026-08-05",
  lockfile: normalizePath(lockfilePath),
  minimatchVersion: "10.2.5",
  packageName: "brace-expansion",
  packagePath: "node_modules/aws-cdk-lib/node_modules/brace-expansion",
  packageVersion: "5.0.7",
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

function fixedVersions(vuln) {
  const versions = [];
  for (const affected of vuln.affected ?? []) {
    if (affected?.package?.ecosystem !== "npm" || affected.package.name !== exception.packageName) {
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
    vuln.range === exception.advisories[0].npmRange &&
    Array.isArray(vuln.nodes) &&
    sameStringSet(vuln.nodes, [exception.packagePath]) &&
    Array.isArray(vuln.effects) &&
    vuln.effects.length === 0 &&
    viaObjects.length === exception.advisories.length &&
    sameStringSet(
      viaUrls,
      exception.advisories.map((advisory) => advisory.advisoryUrl),
    ) &&
    sameStringSet(
      viaRanges,
      exception.advisories.map((advisory) => advisory.affectedRange),
    )
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

function matchesOsvFinding(result, pkg, vuln, advisory) {
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
    vuln.id === advisory.advisoryId &&
    sameStringSet(aliases, [advisory.alias]) &&
    sameStringSet(fixedVersions(vuln), advisory.fixedVersions)
  );
}

function verifyOsvReport() {
  const unexpected = [];
  const visibleCounts = new Map(exception.advisories.map((advisory) => [advisory.advisoryId, 0]));
  for (const result of report.results ?? []) {
    for (const pkg of result.packages ?? []) {
      for (const vuln of pkg.vulnerabilities ?? []) {
        const advisory = exception.advisories.find((candidate) =>
          matchesOsvFinding(result, pkg, vuln, candidate),
        );
        if (advisory) {
          visibleCounts.set(advisory.advisoryId, visibleCounts.get(advisory.advisoryId) + 1);
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

  const incorrectCounts = [...visibleCounts].filter(([, count]) => count !== 1);
  if (unexpected.length > 0 || incorrectCounts.length > 0) {
    for (const vuln of unexpected) {
      console.error(
        `osv-scanner: unexpected vulnerability ${vuln.id} in ${vuln.packageName}@${vuln.version} from ${vuln.source}`,
      );
    }
    for (const [advisoryId, count] of incorrectCounts) {
      console.error(
        `osv-scanner: expected exactly one visible AWS CDK bundled ${advisoryId} finding, matched ${count}`,
      );
    }
    fail("visible AWS CDK bundled findings did not match the reviewed exception set");
  }
}

if (mode === "npm") {
  verifyNpmReport();
} else {
  verifyOsvReport();
}

for (const advisory of exception.advisories) {
  console.error(
    `${mode}-scanner: WARN ${JSON.stringify({
      recordType: "reviewed-vulnerability-exception",
      exceptionId: "aws-cdk-lib-bundled-brace-expansion",
      advisoryId: advisory.advisoryId,
      advisoryUrl: advisory.advisoryUrl,
      affectedRange: advisory.affectedRange,
      alias: advisory.alias,
      fixedVersions: advisory.fixedVersions,
      expiresOn: exception.expiresOn,
      lockfile: exception.lockfile,
      package: {
        name: exception.packageName,
        path: exception.packagePath,
        version: exception.packageVersion,
      },
      provenance: {
        awsCdkLib: {
          path: "node_modules/aws-cdk-lib",
          version: exception.cdkVersion,
        },
        minimatch: {
          dependencyRange: "^5.0.5",
          path: "node_modules/aws-cdk-lib/node_modules/minimatch",
          version: exception.minimatchVersion,
        },
      },
    })}`,
  );
}
