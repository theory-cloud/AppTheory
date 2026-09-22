// Purpose: validate that aws-cdk-lib's bundled brace-expansion path is patched,
// that the cdk lockfile still routes the stream-json advisory only through the
// jsii toolchain, and that no other vulnerability finding is visible to the cdk
// npm-audit / OSV audit surface.
//
// ===========================================================================
// Reviewed, self-expiring exception: stream-json (GHSA-528h-pc64-c93x)
// ===========================================================================
// Advisory  GHSA-528h-pc64-c93x / CVE-2026-71429 (moderate, CWE-407):
//   "stream-json: pick/ignore/filter/replace filters are O(depth^2) on nested
//   input - small crafted JSON blocks the event loop for seconds to minutes
//   (DoS)". Affected range: stream-json < 3.5.0.
// Finding   stream-json@1.9.1 at node_modules/stream-json, reachable only
//   through jsii-rosetta, which jsii-pacmak declares as a peer dependency of the
//   cdk devDependency. OSV reports the finding under dependency group "dev" and
//   the cdk runtime graph (aws-cdk-lib, constructs) never includes it, so no
//   runtime artifact ships the vulnerable code.
//
// Why an upgrade cannot resolve it (CJS/ESM deadlock, independently reproduced
// 2026-09-20; companion PR #998 resolves the other 14 Dependabot alerts from the
// same sweep):
//   * Every patched stream-json release (3.5.0, 3.6.0, 3.7.0) is ESM-only:
//     "type": "module" with exports {".":"./src/index.js","./*":"./src/*"}.
//     jsii-rosetta's CommonJS build resolves "stream-json/Assembler" (also
//     Disassembler/Stringer) eagerly from require("jsii-rosetta"), and that
//     wildcard export maps the subpath to ./src/Assembler without the ".js"
//     extension, so the CJS require fails with MODULE_NOT_FOUND and
//     `npx jsii-pacmak -t go` - which SEC-2 itself runs - breaks.
//   * stream-json 2.x is CommonJS but still inside the affected range.
//   * Every stable jsii-rosetta inside jsii-pacmak's peer range (>= 5.9.0, all 75
//     releases from 5.9.0 through 6.0.15) declares stream-json ^1.9.1, so no
//     installable version pair clears the advisory.
//   * jsii-rosetta 6.0.16-dev.* declares stream-json ^3.6.0, but it is a
//     prerelease and does not satisfy jsii-pacmak's peer range.
//
// Operator ruling: 2026-09-20 (Factory sweep 2026-09) authorized exactly this
// one exception - advisory GHSA-528h-pc64-c93x, package stream-json, in the cdk
// npm project's jsii toolchain subtree - and nothing broader. This is not a
// severity-based, count-based, or blanket allowlist: any other finding, in any
// project, still fails the gate.
//
// Anchor maintenance (operator ruling 2026-09-20, wave-2 dependency
// consolidation): the cdk-constructs group moves aws-cdk-lib 2.265.0 -> 2.269.0,
// so `expectation.cdkVersion` below is re-anchored to 2.269.0. The bundled
// brace-expansion graph assertion was re-verified against the new lockfile:
// aws-cdk-lib still bundles minimatch 10.2.5 -> brace-expansion 5.0.9
// (both in-bundle), and no exception term changed.
//
// Scope: the exception is granted to exactly one lockfile, `cdk/package-lock.json`
// (see `streamJsonException.lockfile`). Every other lockfile this checker is
// routed - the examples/cdk projects, which also carry aws-cdk-lib's bundled
// brace-expansion path - gets the brace-expansion assertion, zero findings, and
// no registry lookups, exactly as it did before the exception existed.
//
// Removal condition (enforced automatically, never by comment alone): the
// exception EXPIRES and this checker FAILS as soon as the public npm registry
// shows an upgrade path, meaning either
//   (a) a STABLE (non-prerelease) jsii-rosetta >= 6.0.16 is published, or
//   (b) a STABLE stream-json >= 3.5.0 that is not ESM-only is published.
// Prereleases such as 6.0.16-dev.5 never trigger expiry. When it fires, bump
// jsii-rosetta to >= 6.0.16 stable / patched CJS-compatible stream-json and
// remove this exception. The lookup runs unconditionally whenever this checker
// is given the exception's own lockfile - it does not depend on the current
// report actually carrying the finding - so a stale exception cannot survive by
// simply never matching again. A registry that cannot be reached is reported as
// BLOCKED (exit 2) instead of being assumed to have no upgrade path.
//
// Machine contract: when the exception is applied, this checker prints one line
// to stdout beginning "exception-applied: " so a calling gate can prove that a
// non-zero scanner exit was caused by this exact reviewed finding.
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

const registryBaseUrl = "https://registry.npmjs.org";
const registryTimeoutMs = 20000;

function fail(message) {
  console.error(`${mode}-scanner: FAIL (${message})`);
  process.exit(1);
}

function blocked(message) {
  console.error(`${mode}-scanner: BLOCKED (${message})`);
  process.exit(2);
}

function readJson(file, description) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    fail(`could not parse ${description} ${file}: ${err.message}`);
  }
}

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

// Identity of the lockfile this checker was handed: the argv path with its "." and
// ".." segments resolved lexically and expressed relative to this repository. The
// exception below is granted to exactly one file, so argv has to NAME that file
// rather than merely end in its name - a copied tree, a /tmp scratch path, or any
// other path that is not this repository's cdk lockfile takes the non-exception
// path (the brace-expansion assertion, zero findings, no registry lookups), exactly
// as this checker behaved before the exception existed.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function canonicalLockfilePath(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return "";
  return path.relative(repositoryRoot, path.resolve(raw)).split(path.sep).join("/");
}

function sameStringSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  return actualSorted.every((value, index) => value === expectedSorted[index]);
}

function stringList(value) {
  return Array.isArray(value) ? value.map(String) : [];
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

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(value ?? "").trim(),
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? "",
  };
}

function compareParsedVersions(left, right) {
  for (const part of ["major", "minor", "patch"]) {
    if (left[part] !== right[part]) return left[part] - right[part];
  }
  return 0;
}

function compareVersionStrings(left, right) {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) return String(left).localeCompare(String(right));
  return compareParsedVersions(parsedLeft, parsedRight);
}

// A release counts only when it is stable (no prerelease component) and at or
// above the floor. Prereleases never satisfy a stable floor.
function isStableAtLeast(version, floor) {
  const parsed = parseVersion(version);
  const parsedFloor = parseVersion(floor);
  if (!parsed || !parsedFloor) return false;
  if (parsed.prerelease !== "") return false;
  return compareParsedVersions(parsed, parsedFloor) >= 0;
}

function isVulnerableVersion(version, patchedVersion) {
  const parsed = parseVersion(version);
  const parsedPatched = parseVersion(patchedVersion);
  return Boolean(parsed && parsedPatched) && compareParsedVersions(parsed, parsedPatched) < 0;
}

// A patched stream-json is consumable by the CommonJS jsii toolchain only when
// the release is not ESM-only: either it does not declare "type": "module", or
// its exports map exposes a "require" condition.
function exportsSupportRequire(exportsField) {
  if (typeof exportsField === "string") return false;
  if (Array.isArray(exportsField)) return exportsField.some(exportsSupportRequire);
  if (!exportsField || typeof exportsField !== "object") return false;
  return Object.entries(exportsField).some(([key, value]) =>
    key === "require" ? typeof value === "string" || Array.isArray(value) : exportsSupportRequire(value),
  );
}

function isEsmOnly(manifest) {
  if (!manifest || typeof manifest !== "object") return false;
  if (manifest.type !== "module") return false;
  return !exportsSupportRequire(manifest.exports);
}

async function fetchRegistryDocument(url, description, accept = "application/json") {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept },
      signal: AbortSignal.timeout(registryTimeoutMs),
    });
  } catch (err) {
    blocked(`could not reach the npm registry for ${description} (${url}): ${err.message}`);
  }
  if (!response.ok) {
    blocked(`npm registry returned HTTP ${response.status} for ${description} (${url})`);
  }
  try {
    return await response.json();
  } catch (err) {
    blocked(`could not parse the npm registry response for ${description} (${url}): ${err.message}`);
  }
}

const expectation = {
  advisoryId: "GHSA-rgw5-rvv9-x895",
  advisoryUrl: "https://github.com/advisories/GHSA-rgw5-rvv9-x895",
  alias: "CVE-2026-69152",
  // Re-anchored 2026-09-20 (operator ruling, wave-2 dependency consolidation):
  // the cdk-constructs group moves aws-cdk-lib 2.265.0 -> 2.269.0. Re-verified
  // against the new lockfile: the release still bundles the patched
  // minimatch 10.2.5 -> brace-expansion 5.0.9 path asserted below.
  cdkVersion: "2.269.0",
  fixedVersions: ["1.1.18", "2.1.4", "3.0.6", "5.0.9"],
  lockfile: canonicalLockfilePath(lockfilePath),
  minimatchVersion: "10.2.5",
  packageName: "brace-expansion",
  packagePath: "node_modules/aws-cdk-lib/node_modules/brace-expansion",
  packageVersion: "5.0.9",
};

const streamJsonException = {
  exceptionId: "stream-json-jsii-toolchain",
  advisoryId: "GHSA-528h-pc64-c93x",
  advisoryUrl: "https://github.com/advisories/GHSA-528h-pc64-c93x",
  alias: "CVE-2026-71429",
  patchedVersion: "3.5.0",
  packageName: "stream-json",
  packagePath: "node_modules/stream-json",
  parentName: "jsii-rosetta",
  parentPath: "node_modules/jsii-rosetta",
  parentToolName: "jsii-pacmak",
  parentToolPath: "node_modules/jsii-pacmak",
  lockfile: "cdk/package-lock.json",
  operatorRuling: "2026-09-20",
  companion: "https://github.com/theory-cloud/AppTheory/pull/998",
  justification:
    "Upstream-blocked: every stable jsii-rosetta in jsii-pacmak's peer range (>= 5.9.0, 5.9.0 through 6.0.15) pins stream-json ^1.9.1 while every patched stream-json is ESM-only and breaks jsii-rosetta's CommonJS subpath requires under jsii-pacmak. Dev-toolchain-only exposure. Operator-ruled 2026-09-20 (Factory sweep 2026-09), companion to PR #998. Self-expiring; see the removal condition in this file.",
  removalCondition:
    "bump jsii-rosetta to >= 6.0.16 stable / patched CJS-compatible stream-json and remove this exception",
};

// Scoping. The exception is granted to exactly one lockfile - the cdk jsii
// toolchain project - and to nothing else. osv_scan_lockfile in
// gov-verify-rubric.sh routes every lockfile carrying aws-cdk-lib's bundled
// brace-expansion path to this checker, which includes the examples/cdk
// projects; those carry neither the jsii toolchain nor stream-json, so for them
// this checker behaves exactly as it did before the exception existed: the
// brace-expansion graph assertion, zero findings, no registry lookups.
//
// The comparison is equality against the canonical repo-relative path computed
// above, never a path-suffix convention: a path that merely ends in
// "cdk/package-lock.json" - an absolute path into a copied tree, a /tmp scratch
// copy - is a different file and must not inherit the grant.
const streamJsonExceptionApplies = expectation.lockfile === streamJsonException.lockfile;

// Expiry gate. For the exception's own lockfile the lookup is unconditional: it
// runs whether or not the current report actually carries the finding, so the
// exception cannot survive by simply never matching again.
async function findUpgradePaths() {
  const reasons = [];

  const rosetta = await fetchRegistryDocument(
    `${registryBaseUrl}/${streamJsonException.parentName}`,
    `${streamJsonException.parentName} versions`,
    "application/vnd.npm.install-v1+json",
  );
  const rosettaStable = Object.keys(rosetta.versions ?? {})
    .filter((version) => isStableAtLeast(version, "6.0.16"))
    .sort(compareVersionStrings);
  if (rosettaStable.length > 0) {
    reasons.push(
      `stable ${streamJsonException.parentName} >= 6.0.16 is published to npm: ${rosettaStable.join(", ")}`,
    );
  }

  const streamJson = await fetchRegistryDocument(
    `${registryBaseUrl}/${streamJsonException.packageName}`,
    `${streamJsonException.packageName} versions`,
  );
  const streamJsonStable = Object.keys(streamJson.versions ?? {})
    .filter(
      (version) =>
        isStableAtLeast(version, streamJsonException.patchedVersion) &&
        !isEsmOnly(streamJson.versions[version]),
    )
    .sort(compareVersionStrings);
  if (streamJsonStable.length > 0) {
    reasons.push(
      `stable non-ESM-only ${streamJsonException.packageName} >= ${streamJsonException.patchedVersion} is published to npm: ${streamJsonStable.join(", ")}`,
    );
  }

  return reasons;
}

if (streamJsonExceptionApplies) {
  const upgradePaths = await findUpgradePaths();
  if (upgradePaths.length > 0) {
    for (const reason of upgradePaths) {
      console.error(`${mode}-scanner: exception expired - ${reason}`);
    }
    fail(`exception expired: ${streamJsonException.removalCondition}`);
  }
}

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

const streamJsonPackage = packages[streamJsonException.packagePath];
const jsiiRosettaPackage = packages[streamJsonException.parentPath];
const jsiiPacmakPackage = packages[streamJsonException.parentToolPath];

// The graph re-assertion belongs to the exception, so it is scoped with it: a
// lockfile the exception does not cover must never be asked to carry the jsii
// toolchain.
if (streamJsonExceptionApplies) {
  const streamJsonPaths = Object.keys(packages).filter(
    (path) =>
      path === `node_modules/${streamJsonException.packageName}` ||
      path.endsWith(`/node_modules/${streamJsonException.packageName}`),
  );

  if (
    !sameStringSet(streamJsonPaths, [streamJsonException.packagePath]) ||
    streamJsonPackage?.dev !== true ||
    !isVulnerableVersion(streamJsonPackage?.version, streamJsonException.patchedVersion) ||
    jsiiRosettaPackage?.dev !== true ||
    jsiiRosettaPackage?.dependencies?.[streamJsonException.packageName] === undefined ||
    jsiiPacmakPackage?.dev !== true ||
    jsiiPacmakPackage?.peerDependencies?.[streamJsonException.parentName] === undefined
  ) {
    fail(
      `lockfile graph no longer matches the reviewed ${streamJsonException.packageName} exception (expected one dev-only ${streamJsonException.packageName} below the patched ${streamJsonException.patchedVersion} release, reachable only as a ${streamJsonException.parentName} dependency of the ${streamJsonException.parentToolName} devDependency)`,
    );
  }
}

function npmViaEntries(vuln) {
  return Array.isArray(vuln.via) ? vuln.via : [];
}

// Advisory URL identity. Deliberately NOT normalizePath: folding "\" into "/"
// would let "https:\\github.com/advisories/GHSA-..." compare equal to the reviewed
// https URL. Only the scheme separator's slash run is normalized (https:/x and
// https://x are the same URL form) and backslashes are never touched, so a
// backslash-spelled or otherwise non-canonical URL fails closed. Both sides go
// through the same function.
function normalizeAdvisoryUrl(value) {
  return String(value ?? "")
    .trim()
    .replace(/^(https?):\/+/i, (_match, scheme) => `${scheme}://`);
}

// npm audit merges every advisory that affects one package into a single
// vulnerabilities entry, so the reviewed advisory must be the ONLY entry in that
// entry's `via` list. `.some()` semantics would bless an entry that also carries a
// second, unreviewed advisory (a future critical on the same package, say) and the
// merge would be silently swallowed; every entry - string propagation, other
// advisory object, or otherwise - must be this exact advisory object or the
// finding fails closed.
function npmViaMentionsAdvisory(vuln) {
  const entries = npmViaEntries(vuln);
  return (
    entries.length > 0 &&
    entries.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        normalizeAdvisoryUrl(entry.url) === normalizeAdvisoryUrl(streamJsonException.advisoryUrl),
    )
  );
}

function npmViaIsParentPropagation(vuln) {
  const entries = npmViaEntries(vuln);
  const names = entries.filter((entry) => typeof entry === "string");
  return entries.length > 0 && names.length === entries.length && sameStringSet(names, [streamJsonException.packageName]);
}

function npmFindingIsReviewedException(name, vuln) {
  if (!streamJsonExceptionApplies) return false;
  if (name === streamJsonException.packageName) {
    return (
      vuln.name === streamJsonException.packageName &&
      npmViaMentionsAdvisory(vuln) &&
      sameStringSet(stringList(vuln.nodes), [streamJsonException.packagePath]) &&
      sameStringSet(stringList(vuln.effects), [streamJsonException.parentName])
    );
  }
  if (name === streamJsonException.parentName) {
    return (
      vuln.name === streamJsonException.parentName &&
      npmViaIsParentPropagation(vuln) &&
      sameStringSet(stringList(vuln.nodes), [streamJsonException.parentPath]) &&
      sameStringSet(stringList(vuln.effects), [])
    );
  }
  return false;
}

function osvSourceMatchesLockfile(sourcePath) {
  return (
    sourcePath === expectation.lockfile || sourcePath.endsWith(`/${expectation.lockfile}`)
  );
}

function osvFindingIsReviewedException(result, pkg, vuln) {
  if (!streamJsonExceptionApplies) return false;
  const packageInfo = pkg?.package ?? {};
  return (
    packageInfo.ecosystem === "npm" &&
    packageInfo.name === streamJsonException.packageName &&
    vuln.id === streamJsonException.advisoryId &&
    stringList(vuln.aliases).includes(streamJsonException.alias) &&
    isVulnerableVersion(packageInfo.version, streamJsonException.patchedVersion) &&
    sameStringSet(stringList(pkg.dependency_groups), ["dev"]) &&
    osvSourceMatchesLockfile(normalizePath(result?.source?.path))
  );
}

const findings = [];
if (mode === "npm") {
  if (report.error || !report.vulnerabilities || typeof report.vulnerabilities !== "object") {
    fail("npm audit report is missing its vulnerability map");
  }
  for (const [name, vuln] of Object.entries(report.vulnerabilities)) {
    findings.push({
      allowed: npmFindingIsReviewedException(name, vuln),
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
          allowed: osvFindingIsReviewedException(result, pkg, vuln),
          fixedVersions: fixedVersions(vuln, packageInfo.name ?? streamJsonException.packageName),
          id: vuln.id ?? "<unknown>",
          packageName: packageInfo.name ?? "<unknown>",
          source: result?.source?.path ?? "<unknown>",
          version: packageInfo.version ?? "<unknown>",
        });
      }
    }
  }
}

const unexpected = findings.filter((finding) => !finding.allowed);
const applied = findings.filter((finding) => finding.allowed);

if (unexpected.length > 0) {
  for (const vuln of unexpected) {
    const fixed = vuln.fixedVersions ? ` (fixed versions: ${JSON.stringify(vuln.fixedVersions)})` : "";
    console.error(
      `${mode}-scanner: unexpected vulnerability ${vuln.id} in ${vuln.packageName}@${vuln.version} from ${vuln.source}${fixed}`,
    );
  }
  fail(
    streamJsonExceptionApplies
      ? `AWS CDK findings outside the reviewed ${streamJsonException.advisoryId} exception (${streamJsonException.packageName} in the cdk ${streamJsonException.parentToolName} toolchain)`
      : `AWS CDK findings outside the patched bundled ${expectation.packageName} path`,
  );
}

if (applied.length > 0) {
  const record = {
    recordType: "reviewed-vulnerability-exception",
    exceptionId: streamJsonException.exceptionId,
    advisoryId: streamJsonException.advisoryId,
    advisoryUrl: streamJsonException.advisoryUrl,
    alias: streamJsonException.alias,
    operatorRuling: streamJsonException.operatorRuling,
    companion: streamJsonException.companion,
    justification: streamJsonException.justification,
    removalCondition: streamJsonException.removalCondition,
    lockfile: expectation.lockfile,
    package: {
      name: streamJsonException.packageName,
      path: streamJsonException.packagePath,
      version: streamJsonPackage?.version ?? "<unknown>",
    },
    provenance: {
      parent: {
        name: streamJsonException.parentName,
        path: streamJsonException.parentPath,
        version: jsiiRosettaPackage?.version ?? "<unknown>",
      },
      parentTool: {
        name: streamJsonException.parentToolName,
        path: streamJsonException.parentToolPath,
        version: jsiiPacmakPackage?.version ?? "<unknown>",
        peerRange: jsiiPacmakPackage?.peerDependencies?.[streamJsonException.parentName] ?? "<unknown>",
      },
    },
  };
  console.log(`exception-applied: ${streamJsonException.exceptionId} ${streamJsonException.advisoryId} findings=${applied.length}`);
  console.error(`${mode}-scanner: WARN ${JSON.stringify(record)}`);
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
    // A lockfile the exception does not cover reports exactly what this checker
    // reported before the exception existed, so the field is omitted rather
    // than reported empty.
    ...(streamJsonExceptionApplies
      ? { reviewedExceptions: applied.length > 0 ? [streamJsonException.exceptionId] : [] }
      : {}),
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
