// Purpose: validate the exact reviewed vulnerability exception for the
// TypeScript lint-tool brace-expansion paths.
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
  advisoryId: "GHSA-mh99-v99m-4gvg",
  advisoryUrl: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
  alias: "CVE-2026-14257",
  fixedVersions: ["1.1.17", "2.1.3", "3.0.3", "5.0.8"],
  lockfile: normalizePath(lockfilePath),
  packageName: "brace-expansion",
  packagePath: "node_modules/brace-expansion",
  packageVersion: "1.1.17",
  legacyParents: [
    {
      dependencyRange: "^3.1.2",
      path: "node_modules/@eslint/config-array",
      version: "0.21.1",
    },
    {
      dependencyRange: "^3.1.2",
      path: "node_modules/@eslint/eslintrc",
      version: "3.3.3",
    },
    {
      dependencyRange: "^3.1.2",
      path: "node_modules/eslint",
      version: "9.39.2",
    },
    {
      dependencyRange: "^3.1.2",
      path: "node_modules/eslint-plugin-import",
      version: "2.32.0",
    },
  ],
  patchedParent: {
    dependencyRange: "^10.2.2",
    path: "node_modules/@typescript-eslint/typescript-estree",
    version: "8.57.2",
  },
  patchedPackagePath: "node_modules/@typescript-eslint/typescript-estree/node_modules/brace-expansion",
  patchedPackageVersion: "5.0.8",
  patchedTransitivePath: "node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch",
  patchedTransitiveVersion: "10.2.5",
  vulnerableTransitivePath: "node_modules/minimatch",
  vulnerableTransitiveVersion: "3.1.4",
};
const exception = {
  advisoryId: "GHSA-rgw5-rvv9-x895",
  advisoryUrl: "https://github.com/advisories/GHSA-rgw5-rvv9-x895",
  alias: "CVE-2026-69152",
  fixedVersions: ["1.1.18", "2.1.4", "3.0.6", "5.0.9"],
  instances: [
    {
      path: expectation.packagePath,
      version: expectation.packageVersion,
    },
    {
      path: expectation.patchedPackagePath,
      version: expectation.patchedPackageVersion,
    },
  ],
  justification:
    "New advisory; no fixed aws-cdk release available; operator-authorized exception 2026-08-03 pending upstream fix.",
};

const packages = lock.packages ?? {};
const bracePaths = Object.keys(packages).filter(
  (path) => path === "node_modules/brace-expansion" || path.endsWith("/node_modules/brace-expansion"),
);
const minimatchParents = Object.entries(packages)
  .filter(([, pkg]) => pkg?.dependencies?.minimatch)
  .map(([path, pkg]) => ({
    dependencyRange: pkg.dependencies.minimatch,
    path,
    version: pkg.version,
  }));
const expectedParents = [...expectation.legacyParents, expectation.patchedParent].map((parent) =>
  JSON.stringify(parent),
);
const actualParents = minimatchParents.map((parent) => JSON.stringify(parent));
const patchedLegacyPackage = packages[expectation.packagePath];
const patchedPackage = packages[expectation.patchedPackagePath];
const patchedTransitivePackage = packages[expectation.patchedTransitivePath];
const legacyTransitivePackage = packages[expectation.vulnerableTransitivePath];

if (
  !sameStringSet(bracePaths, [expectation.packagePath, expectation.patchedPackagePath]) ||
  !sameStringSet(actualParents, expectedParents) ||
  patchedLegacyPackage?.version !== expectation.packageVersion ||
  patchedLegacyPackage?.dev !== true ||
  patchedLegacyPackage?.dependencies?.["balanced-match"] !== "^1.0.0" ||
  patchedLegacyPackage?.dependencies?.["concat-map"] !== "0.0.1" ||
  patchedPackage?.version !== expectation.patchedPackageVersion ||
  patchedPackage?.dev !== true ||
  patchedPackage?.dependencies?.["balanced-match"] !== "^4.0.2" ||
  patchedTransitivePackage?.version !== expectation.patchedTransitiveVersion ||
  patchedTransitivePackage?.dev !== true ||
  patchedTransitivePackage?.dependencies?.[expectation.packageName] !== "^5.0.5" ||
  legacyTransitivePackage?.version !== expectation.vulnerableTransitiveVersion ||
  legacyTransitivePackage?.dev !== true ||
  legacyTransitivePackage?.dependencies?.[expectation.packageName] !== "^1.1.7"
) {
  fail(`lockfile graph no longer matches the patched TypeScript lint-tool ${expectation.packageName} path`);
}

const unexpected = [];
const visibleCounts = new Map(exception.instances.map((instance) => [instance.version, 0]));
if (!Array.isArray(report.results)) {
  fail("OSV report is missing its results array");
}
for (const result of report.results) {
  for (const pkg of result.packages ?? []) {
    for (const vuln of pkg.vulnerabilities ?? []) {
      const sourcePath = normalizePath(result?.source?.path);
      const packageInfo = pkg?.package ?? {};
      const dependencyGroups = (pkg.dependency_groups ?? []).map(String);
      const instance = exception.instances.find(
        (candidate) => candidate.version === packageInfo.version,
      );
      const matches =
        instance &&
        (sourcePath === expectation.lockfile || sourcePath.endsWith(`/${expectation.lockfile}`)) &&
        packageInfo.ecosystem === "npm" &&
        packageInfo.name === expectation.packageName &&
        sameStringSet(dependencyGroups, ["dev"]) &&
        vuln.id === exception.advisoryId &&
        sameStringSet((vuln.aliases ?? []).map(String), [exception.alias]) &&
        sameStringSet(fixedVersions(vuln, expectation.packageName), exception.fixedVersions);

      if (matches) {
        visibleCounts.set(instance.version, visibleCounts.get(instance.version) + 1);
      } else {
        unexpected.push({
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

const incorrectCounts = [...visibleCounts].filter(([, count]) => count !== 1);
if (unexpected.length > 0 || incorrectCounts.length > 0) {
  for (const vuln of unexpected) {
    console.error(
      `osv-scanner: unexpected vulnerability ${vuln.id} in ${vuln.packageName}@${vuln.version} from ${vuln.source} (fixed versions: ${JSON.stringify(vuln.fixedVersions)})`,
    );
  }
  for (const [version, count] of incorrectCounts) {
    console.error(
      `osv-scanner: expected exactly one visible TypeScript lint-tool ${exception.advisoryId} finding for ${expectation.packageName}@${version}, matched ${count}`,
    );
  }
  fail("visible TypeScript lint-tool findings did not match the reviewed exception set");
}

for (const instance of exception.instances) {
  console.error(
    `osv-scanner: WARN ${JSON.stringify({
      recordType: "reviewed-vulnerability-exception",
      exceptionId: "typescript-brace-expansion",
      advisoryId: exception.advisoryId,
      advisoryUrl: exception.advisoryUrl,
      alias: exception.alias,
      fixedVersions: exception.fixedVersions,
      justification: exception.justification,
      lockfile: expectation.lockfile,
      package: {
        name: expectation.packageName,
        path: instance.path,
        version: instance.version,
      },
      provenance: {
        legacyMinimatch: {
          dependencyRange: "^1.1.7",
          path: expectation.vulnerableTransitivePath,
          version: expectation.vulnerableTransitiveVersion,
        },
        legacyParents: expectation.legacyParents,
        patchedBranch: {
          braceExpansion: {
            path: expectation.patchedPackagePath,
            version: expectation.patchedPackageVersion,
          },
          minimatch: {
            dependencyRange: "^5.0.5",
            path: expectation.patchedTransitivePath,
            version: expectation.patchedTransitiveVersion,
          },
          parent: expectation.patchedParent,
        },
      },
    })}`,
  );
}
