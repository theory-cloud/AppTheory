// Purpose: validate that aws-cdk-lib's bundled brace-expansion path is patched
// and that no vulnerability finding is visible to the cdk npm-audit / OSV audit
// surface.
//
// ===========================================================================
// No dependency-audit exceptions
// ===========================================================================
// This checker grants no exceptions: every finding it sees fails the gate. It
// used to hold exactly one reviewed, self-expiring exception - advisory
// GHSA-528h-pc64-c93x / CVE-2026-71429 for stream-json < 3.5.0, reachable only
// through the jsii-rosetta dev toolchain of the jsii-pacmak cdk devDependency -
// scoped to the single lockfile cdk/package-lock.json.
//
// RESOLVED 2026-09-22. The exception's own removal condition was met: the npm
// registry published a STABLE jsii-rosetta >= 6.0.16. jsii-rosetta 6.0.16
// moves to stream-json ^3.6.0 and loads it by dynamic ESM import() of the
// extension-suffixed subpaths (stream-json/parser.js, assembler.js,
// disassembler.js, stringer.js) - the patched, CJS-consumable form the
// exception was blocked on, and the reason its earlier CJS subpath requires
// failed with MODULE_NOT_FOUND. cdk/package.json now pins
// jsii-rosetta 6.0.16 (jsii-pacmak 1.140.0's `jsii-rosetta: >=5.9.0` peer range
// already admits it, so no jsii or jsii-pacmak bump was required); the lockfile
// resolves stream-json 3.7.0 and `npm audit` reports an empty vulnerability map.
// The exception and all of its machinery - the registry-backed expiry lookup,
// the exception matcher, and the `exception-applied:` machine marker - were
// removed with the bump.
//
// There is no longer any dependency-audit exception in this repository, and
// none may be added without an operator ruling. History, including the CJS/ESM
// deadlock analysis and the operator ruling that authorized the exception, is
// recorded in gov-infra/planning/apptheory-10of10-rubric.md.
//
// Scope: gov-verify-rubric.sh's osv_scan_lockfile routes every lockfile
// carrying aws-cdk-lib's bundled brace-expansion path to this checker, which
// includes the examples/cdk projects as well as cdk/package-lock.json. Every
// one of them gets the same treatment: the bundled brace-expansion graph
// assertion and a zero-findings requirement.
// ===========================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function readJson(file, description) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    fail(`could not parse ${description} ${file}: ${err.message}`);
  }
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

// Identity of the lockfile this checker was handed, expressed relative to this
// repository so the PASS record names the file that was actually checked rather
// than the caller's spelling of it.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function canonicalLockfilePath(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return "";
  return path.relative(repositoryRoot, path.resolve(raw)).split(path.sep).join("/");
}

const expectation = {
  advisoryId: "GHSA-rgw5-rvv9-x895",
  advisoryUrl: "https://github.com/advisories/GHSA-rgw5-rvv9-x895",
  alias: "CVE-2026-69152",
  // Re-anchored 2026-09-22 (cdk-constructs group dependency consolidation):
  // the group moves aws-cdk-lib 2.269.0 -> 2.270.0 across cdk/ and every
  // examples/cdk project. Re-verified against the new lockfiles: the release
  // still bundles the patched minimatch 10.2.5 -> brace-expansion 5.0.9 path
  // asserted below, so only the cdkVersion anchor moves.
  cdkVersion: "2.270.0",
  fixedVersions: ["1.1.18", "2.1.4", "3.0.6", "5.0.9"],
  lockfile: canonicalLockfilePath(lockfilePath),
  minimatchVersion: "10.2.5",
  packageName: "brace-expansion",
  packagePath: "node_modules/aws-cdk-lib/node_modules/brace-expansion",
  packageVersion: "5.0.9",
};

const report = readJson(reportPath, "scanner report");
const lock = readJson(lockfilePath, "lockfile");

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
          fixedVersions: fixedVersions(vuln, packageInfo.name ?? "<unknown>"),
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
  fail(`AWS CDK findings outside the patched bundled ${expectation.packageName} path`);
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
