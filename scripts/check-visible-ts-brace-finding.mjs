// Purpose: validate the visible, expiring TypeScript lint-tool
// brace-expansion vulnerability exception.
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
const exception = {
  advisoryId: "GHSA-mh99-v99m-4gvg",
  advisoryUrl: "https://github.com/advisories/GHSA-mh99-v99m-4gvg",
  alias: "CVE-2026-14257",
  expiresOn: "2026-08-05",
  fixedVersions: ["5.0.8"],
  lockfile: normalizePath(lockfilePath),
  packageName: "brace-expansion",
  packagePath: "node_modules/brace-expansion",
  packageVersion: "1.1.16",
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

if (new Date().toISOString().slice(0, 10) > exception.expiresOn) {
  fail(
    `TypeScript lint-tool ${exception.packageName} exception expired on ${exception.expiresOn}; update the lint dependency graph or re-review the finding`,
  );
}

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
const expectedParents = [...exception.legacyParents, exception.patchedParent].map((parent) =>
  JSON.stringify(parent),
);
const actualParents = minimatchParents.map((parent) => JSON.stringify(parent));
const vulnerablePackage = packages[exception.packagePath];
const patchedPackage = packages[exception.patchedPackagePath];
const patchedTransitivePackage = packages[exception.patchedTransitivePath];
const vulnerableTransitivePackage = packages[exception.vulnerableTransitivePath];

if (
  !sameStringSet(bracePaths, [exception.packagePath, exception.patchedPackagePath]) ||
  !sameStringSet(actualParents, expectedParents) ||
  vulnerablePackage?.version !== exception.packageVersion ||
  vulnerablePackage?.dev !== true ||
  vulnerablePackage?.dependencies?.["balanced-match"] !== "^1.0.0" ||
  vulnerablePackage?.dependencies?.["concat-map"] !== "0.0.1" ||
  patchedPackage?.version !== exception.patchedPackageVersion ||
  patchedPackage?.dev !== true ||
  patchedPackage?.dependencies?.["balanced-match"] !== "^4.0.2" ||
  patchedTransitivePackage?.version !== exception.patchedTransitiveVersion ||
  patchedTransitivePackage?.dev !== true ||
  patchedTransitivePackage?.dependencies?.[exception.packageName] !== "^5.0.5" ||
  vulnerableTransitivePackage?.version !== exception.vulnerableTransitiveVersion ||
  vulnerableTransitivePackage?.dev !== true ||
  vulnerableTransitivePackage?.dependencies?.[exception.packageName] !== "^1.1.7"
) {
  fail(`lockfile graph no longer matches the reviewed TypeScript lint-tool ${exception.packageName} exception`);
}

const visible = [];
const unexpected = [];
for (const result of report.results ?? []) {
  for (const pkg of result.packages ?? []) {
    for (const vuln of pkg.vulnerabilities ?? []) {
      const sourcePath = normalizePath(result?.source?.path);
      const packageInfo = pkg?.package ?? {};
      const aliases = (vuln.aliases ?? []).map(String);
      const dependencyGroups = (pkg.dependency_groups ?? []).map(String);
      const matches =
        (sourcePath === exception.lockfile || sourcePath.endsWith(`/${exception.lockfile}`)) &&
        packageInfo.ecosystem === "npm" &&
        packageInfo.name === exception.packageName &&
        packageInfo.version === exception.packageVersion &&
        sameStringSet(dependencyGroups, ["dev"]) &&
        vuln.id === exception.advisoryId &&
        sameStringSet(aliases, [exception.alias]) &&
        sameStringSet(fixedVersions(vuln, exception.packageName), exception.fixedVersions);

      if (matches) {
        visible.push(vuln);
      } else {
        unexpected.push({
          id: vuln.id ?? "<unknown>",
          packageName: packageInfo.name ?? "<unknown>",
          source: result?.source?.path ?? "<unknown>",
          version: packageInfo.version ?? "<unknown>",
        });
      }
    }
  }
}

if (unexpected.length > 0 || visible.length !== 1) {
  for (const vuln of unexpected) {
    console.error(
      `osv-scanner: unexpected vulnerability ${vuln.id} in ${vuln.packageName}@${vuln.version} from ${vuln.source}`,
    );
  }
  fail(`expected exactly one visible TypeScript lint-tool finding, matched ${visible.length}`);
}

console.error(
  `osv-scanner: WARN ${JSON.stringify({
    recordType: "reviewed-vulnerability-exception",
    exceptionId: "typescript-legacy-minimatch-brace-expansion",
    advisoryId: exception.advisoryId,
    advisoryUrl: exception.advisoryUrl,
    alias: exception.alias,
    fixedVersions: exception.fixedVersions,
    expiresOn: exception.expiresOn,
    lockfile: exception.lockfile,
    package: {
      name: exception.packageName,
      path: exception.packagePath,
      version: exception.packageVersion,
    },
    provenance: {
      legacyMinimatch: {
        dependencyRange: "^1.1.7",
        path: exception.vulnerableTransitivePath,
        version: exception.vulnerableTransitiveVersion,
      },
      legacyParents: exception.legacyParents,
      patchedBranch: {
        braceExpansion: {
          path: exception.patchedPackagePath,
          version: exception.patchedPackageVersion,
        },
        minimatch: {
          dependencyRange: "^5.0.5",
          path: exception.patchedTransitivePath,
          version: exception.patchedTransitiveVersion,
        },
        parent: exception.patchedParent,
      },
    },
  })}`,
);
