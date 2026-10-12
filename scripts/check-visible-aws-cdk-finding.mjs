// Purpose: validate the reviewed AWS CDK dependency graph - cdk/package-lock.json
// plus every example lockfile the governance gate routes here - and prove that
// the only vulnerability finding visible to the cdk npm-audit / OSV audit
// surface is the one reviewed, self-expiring exception documented below.
//
// ===========================================================================
// Reviewed, self-expiring dependency-audit exception
// ===========================================================================
// Operator ruling quoted verbatim. This is the ruling that
// gov-infra/planning/apptheory-10of10-rubric.md SEC-2 ("none may be added
// without an operator ruling") requires:
//
//   * 2026-10-04: an AWS-published build-toolchain transitive chain with no
//     upstream fix gets the same treatment as an AWS-published bundled
//     dependency ("if a vulnerable dependency is bundled in AWS we make an
//     exception until its updated there", 2026-10-03).
//
// One exception remains (EXCEPTIONS below). The npm scanner path and the OSV
// scanner path match findings against that list and nothing else; no other code
// path can suppress a finding.
//
// ---------------------------------------------------------------------------
// E2 - braces 3.0.3 in the jsii build toolchain
// ---------------------------------------------------------------------------
// Finding   GHSA-vfj7-8cjw-p6xm (high) on braces@3.0.3 at node_modules/braces,
//           reached only via jsii-pacmak -> jsii-rosetta -> fast-glob ->
//           micromatch -> braces - the dev toolchain of the cdk devDependency
//           jsii-pacmak. Build-time only; no AppTheory runtime package or Lambda
//           ships it. npm also lists the derived micromatch, fast-glob,
//           jsii-rosetta, and jsii-pacmak entries, which are pure propagation
//           of this single braces advisory.
// Why an upgrade cannot resolve it (2026-10-04): the advisory's range is
//           "affected <= 3.0.3" and npm publishes NO patched braces release, so
//           no installable version pair clears it; the jsii-pacmak /
//           jsii-rosetta / fast-glob / micromatch chain has no newer release
//           that drops the braces dependency.
// Ruling:   2026-10-04 (AWS-published build-toolchain transitive chain with no
//           upstream fix).
// Removal condition: a patched braces (> 3.0.3) is published, or the jsii
//           toolchain no longer resolves braces <= 3.0.3.
//
// ---------------------------------------------------------------------------
// Retired 2026-10-10 - brace-expansion bundled inside aws-cdk-lib
// ---------------------------------------------------------------------------
// The former E1 exception covered GHSA-6j4f-fj2g-mc7p, GHSA-q2hr-2g5m-vwhr, and
// GHSA-qhr7-859c-m2p7 on brace-expansion@5.0.9 at
// node_modules/aws-cdk-lib/node_modules/brace-expansion (inBundle), reached only
// through aws-cdk-lib's own bundled minimatch. Its documented removal condition -
// "the aws-cdk-lib version this repository pins bundles brace-expansion >=
// 5.0.12" - is now met: this repository pins aws-cdk-lib 2.273.0, whose
// published tarball bundles brace-expansion 5.0.12. Retiring the exception is
// STANDARD MAINTENANCE, not a new exception grant.
//
// Nothing excuses the bundled path any more. Exactly as before, every routed
// lockfile must satisfy the reviewed bundled-graph anchor below, and that anchor
// now asserts the FIXED graph positively (brace-expansion >= 5.0.12). A
// vulnerable bundle, an advisory on the bundled path, or any graph / node-path
// drift fails closed as an unexpected finding.
//
// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------
// The remaining exception is exact: lockfile, package, version, node path /
// dependency chain, and advisory ids. It is ALSO self-expiring and fail closed:
//   * recheck_by 2026-11-02 - after that date the exception no longer applies
//     and the checker fails, forcing a fresh review;
//   * a removal probe runs on every invocation (never only when a finding
//     happens to appear), so a stale exception cannot survive by simply never
//     matching again; when a removal condition is met the checker fails with a
//     clear "removal condition met" message.
// The bundled-graph anchor is lockfile-local and needs no network: it fails
// closed on a vulnerable bundle (any version below the patched floor), a
// different bundled version, or any node-path drift. The E2 removal probe reads
// the npm registry; an unreachable registry is reported as BLOCKED (exit 2),
// never assumed clean.
// Machine contract: when an exception is applied the checker prints one line to
// stdout per exception beginning "exception-applied: " so a calling gate can
// prove that a non-zero scanner exit was caused by exactly the reviewed finding.
// ===========================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const registryBaseUrl = "https://registry.npmjs.org";
const registryTimeoutMs = 20000;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const selfTest = argv[0] === "--self-test";
const [mode, reportPath, lockfilePath] = argv;

if (!selfTest && (!new Set(["npm", "osv"]).has(mode) || !reportPath || !lockfilePath)) {
  console.error(
    "usage: node scripts/check-visible-aws-cdk-finding.mjs <npm|osv> <report-json> <package-lock.json>",
  );
  process.exit(2);
}

function fail(message) {
  console.error(`${mode ?? "self-test"}-scanner: FAIL (${message})`);
  process.exit(1);
}

function blocked(message) {
  console.error(`${mode ?? "self-test"}-scanner: BLOCKED (${message})`);
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

function sameStringSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  return actualSorted.every((value, index) => value === expectedSorted[index]);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Pure: the OSV report entries this checker can honestly evaluate. Returns
// { entries, problems }; a non-empty `problems` means the report shape would
// otherwise hide findings from the loop below (a missing results array, a
// malformed result entry, a non-array packages list, a malformed package
// entry, or a non-array vulnerabilities list). A string-valued `packages`
// used to iterate character by character and read as "no findings". Pure so
// the self-test can drive it offline.
function collectOsvEntries(report) {
  const entries = [];
  const problems = [];
  if (!isRecord(report)) {
    return {
      entries,
      problems: [`OSV report is not a JSON object (got ${JSON.stringify(report)})`],
    };
  }
  if (!Array.isArray(report.results)) {
    return { entries, problems: ["OSV report is missing its results array"] };
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
        entries.push({ result, pkg, vuln });
      }
    }
  }
  return { entries, problems };
}

function stringList(value) {
  return Array.isArray(value) ? value.map(String) : [];
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

function stableVersionsAtLeast(versions, floor) {
  return versions.filter((version) => isStableAtLeast(version, floor)).sort(compareVersionStrings);
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
function canonicalLockfilePath(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return "";
  return path.relative(repositoryRoot, path.resolve(raw)).split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// The one shared exception list.
// ---------------------------------------------------------------------------

// The reviewed bundled graph anchor: the exact AWS CDK bundled brace-expansion
// path this repository resolves after the aws-cdk-lib 2.273.0 bump, whose
// published tarball bundles the patched brace-expansion 5.0.12. It is not an
// exception; it is the integrity assertion every routed lockfile must satisfy.
// It fails closed on a vulnerable bundle (any version below the patched floor),
// on a different bundled version, and on any node-path drift.
const AWS_CDK_BUNDLE = {
  packageName: "brace-expansion",
  packagePath: "node_modules/aws-cdk-lib/node_modules/brace-expansion",
  packageVersion: "5.0.12",
  cdkVersion: "2.273.0",
  minimatchVersion: "10.2.5",
  patchedFloor: "5.0.12",
};

const expectation = {
  advisoryId: "GHSA-rgw5-rvv9-x895",
  advisoryUrl: "https://github.com/advisories/GHSA-rgw5-rvv9-x895",
  alias: "CVE-2026-69152",
  cdkVersion: AWS_CDK_BUNDLE.cdkVersion,
  // Asserted, not derived: the advisory's published fixed versions, recorded for the PASS record.
  fixedVersions: ["1.1.18", "2.1.4", "3.0.6", "5.0.9"],
  minimatchVersion: AWS_CDK_BUNDLE.minimatchVersion,
  packageName: AWS_CDK_BUNDLE.packageName,
  packagePath: AWS_CDK_BUNDLE.packagePath,
  packageVersion: AWS_CDK_BUNDLE.packageVersion,
};

// Every npm lockfile in this repository whose installed tree carries the
// bundled AWS CDK path. Each resolves exactly one brace-expansion, at
// node_modules/aws-cdk-lib/node_modules/brace-expansion inside the pinned
// aws-cdk-lib tarball, and the SEC-2 gate scans this same set (plus
// ts/package-lock.json, whose class routes to the TypeScript checker instead).
// This list must stay identical to the Node lockfile set gov-verify-rubric.sh
// scans; any lockfile outside this list that starts routing here still fails
// closed, because the bundled-graph anchor above is enforced on every routed
// lockfile.
const AWS_CDK_LOCKFILES = [
  "cdk/package-lock.json",
  "examples/cdk/codebuild-job-runner/package-lock.json",
  "examples/cdk/hello-world/package-lock.json",
  "examples/cdk/import-pipeline/package-lock.json",
  "examples/cdk/kinesis-cloudwatch-logs/package-lock.json",
  "examples/cdk/lambda-role/package-lock.json",
  "examples/cdk/lesser-parity/package-lock.json",
  "examples/cdk/microvm-controller/package-lock.json",
  "examples/cdk/multilang/package-lock.json",
  "examples/cdk/s3-vectors-semantic-search/package-lock.json",
  "examples/cdk/sqs-queue/package-lock.json",
  "examples/cdk/ssr-only-provided-assets-site/package-lock.json",
  "examples/cdk/ssr-site/package-lock.json",
];

const E2 = {
  exceptionId: "jsii-toolchain-braces",
  kind: "dev-chain",
  lockfiles: ["cdk/package-lock.json"],
  packageName: "braces",
  packagePath: "node_modules/braces",
  packageVersion: "3.0.3",
  patchedFloor: "3.0.4",
  effects: ["micromatch"],
  // The exact npm propagation chain, root first: braces <- micromatch <-
  // fast-glob <- jsii-rosetta <- jsii-pacmak. npm reports each link as a pure
  // propagation of the single braces advisory.
  chain: [
    { name: "micromatch", path: "node_modules/micromatch", via: "braces", effects: ["fast-glob"] },
    { name: "fast-glob", path: "node_modules/fast-glob", via: "micromatch", effects: ["jsii-rosetta"] },
    { name: "jsii-rosetta", path: "node_modules/jsii-rosetta", via: "fast-glob", effects: ["jsii-pacmak"] },
    { name: "jsii-pacmak", path: "node_modules/jsii-pacmak", via: "jsii-rosetta", effects: [] },
  ],
  advisories: [
    {
      id: "GHSA-vfj7-8cjw-p6xm",
      alias: "CVE-2026-93687",
      url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
    },
  ],
  operatorRuling: "2026-10-04",
  owner: "theory-cloud/AppTheory steward (Factory dependency sweeps)",
  recheckBy: "2026-11-02",
  justification:
    "AWS-published build-toolchain transitive chain with no upstream fix: braces <= 3.0.3 is affected and npm publishes no patched release, so the jsii-pacmak dev toolchain cannot be upgraded out of it. Build-time only; AppTheory ships no runtime package or Lambda with it. Operator-ruled 2026-10-04, same treatment as the retired bundled-dependency exception. Self-expiring; see the removal condition in this file.",
  removalCondition:
    "a patched braces (> 3.0.3) is published, or the jsii toolchain no longer resolves braces <= 3.0.3",
};

const EXCEPTIONS = [E2];

function exceptionById(exceptionId) {
  return EXCEPTIONS.find((exception) => exception.exceptionId === exceptionId) ?? null;
}

// ---------------------------------------------------------------------------
// npm-audit finding matcher
// ---------------------------------------------------------------------------

// Advisory objects carry a url; propagation entries are bare package-name
// strings. Returns the url list only when the via list is purely advisory
// objects, otherwise null (an unmatchable shape).
function npmViaAdvisoryUrls(via) {
  const entries = Array.isArray(via) ? via : [];
  const urls = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.url !== "string" || entry.url === "") {
      return null;
    }
    urls.push(normalizePath(entry.url));
  }
  return urls;
}

// Returns the propagation parent names only when the via list is purely
// package-name strings, otherwise null.
function npmViaPropagationNames(via) {
  const entries = Array.isArray(via) ? via : [];
  if (entries.length === 0) return null;
  if (!entries.every((entry) => typeof entry === "string")) return null;
  return entries.slice();
}

// The only reviewed finding shapes are E2's: the braces root and its exact
// propagation chain, on the cdk lockfile alone. A finding on the bundled
// aws-cdk-lib path (the retired E1 shape) no longer matches anything here.
function npmMatchingException(name, vuln, canonicalLockfile) {
  const exception = E2;
  if (!exception.lockfiles.includes(canonicalLockfile)) return null;
  if (name === exception.packageName) {
    const urls = npmViaAdvisoryUrls(vuln.via);
    if (
      vuln.name === exception.packageName &&
      urls !== null &&
      sameStringSet(urls, exception.advisories.map((advisory) => advisory.url)) &&
      sameStringSet(stringList(vuln.nodes), [exception.packagePath]) &&
      sameStringSet(stringList(vuln.effects), exception.effects)
    ) {
      return exception;
    }
    return null;
  }
  const link = exception.chain.find((candidate) => candidate.name === name);
  if (!link) return null;
  const propagation = npmViaPropagationNames(vuln.via);
  if (
    vuln.name === link.name &&
    propagation !== null &&
    sameStringSet(propagation, [link.via]) &&
    sameStringSet(stringList(vuln.nodes), [link.path]) &&
    sameStringSet(stringList(vuln.effects), link.effects)
  ) {
    return exception;
  }
  return null;
}

// ---------------------------------------------------------------------------
// OSV finding matcher
// ---------------------------------------------------------------------------

function osvSourceMatchesLockfile(sourcePath, canonicalLockfile) {
  const normalized = normalizePath(sourcePath);
  if (normalized === "") return false;
  if (normalized === canonicalLockfile) return true;
  if (normalized.endsWith(`/${canonicalLockfile}`)) return true;
  return canonicalLockfilePath(normalized) === canonicalLockfile;
}

function osvMatchingException(result, pkg, vuln, canonicalLockfile) {
  const packageInfo = pkg?.package ?? {};
  for (const exception of EXCEPTIONS) {
    if (!exception.lockfiles.includes(canonicalLockfile)) continue;
    if (!osvSourceMatchesLockfile(result?.source?.path, canonicalLockfile)) continue;
    if (packageInfo.ecosystem !== "npm") continue;
    if (packageInfo.name !== exception.packageName) continue;
    if (packageInfo.version !== exception.packageVersion) continue;
    const advisory = exception.advisories.find((candidate) => candidate.id === vuln.id);
    if (!advisory) continue;
    if (!sameStringSet(stringList(vuln.aliases), [advisory.alias])) continue;
    return exception;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lockfile graph assertions (the fail-closed anchors)
// ---------------------------------------------------------------------------

// Problems with the fixed bundled AWS CDK brace-expansion graph. An empty list
// means the lockfile matches the reviewed fixed bundle exactly. Pure so the
// self-test can drive it.
function awsCdkBundleGraphProblems(packages) {
  const problems = [];
  const bracePaths = Object.keys(packages).filter(
    (key) =>
      key === `node_modules/${expectation.packageName}` ||
      key.endsWith(`/node_modules/${expectation.packageName}`),
  );
  const cdkPackage = packages["node_modules/aws-cdk-lib"];
  const minimatchPackage = packages["node_modules/aws-cdk-lib/node_modules/minimatch"];
  const bracePackage = packages[expectation.packagePath];

  const graphMatches =
    sameStringSet(bracePaths, [expectation.packagePath]) &&
    cdkPackage?.version === expectation.cdkVersion &&
    Array.isArray(cdkPackage?.bundleDependencies) &&
    cdkPackage.bundleDependencies.includes("minimatch") &&
    minimatchPackage?.version === expectation.minimatchVersion &&
    minimatchPackage?.inBundle === true &&
    minimatchPackage?.dependencies?.[expectation.packageName] === "^5.0.5" &&
    bracePackage?.inBundle === true &&
    bracePackage?.dependencies?.["balanced-match"] === "^4.0.2";

  if (!graphMatches) {
    problems.push(
      `lockfile graph no longer matches the reviewed fixed AWS CDK bundled ${expectation.packageName} path`,
    );
    return problems;
  }

  const bundledVersion = bracePackage?.version;
  if (bundledVersion !== expectation.packageVersion) {
    if (bundledVersion && compareVersionStrings(bundledVersion, AWS_CDK_BUNDLE.patchedFloor) < 0) {
      problems.push(
        `the bundled aws-cdk-lib ${expectation.packageName} ${bundledVersion} is below the fixed floor ${AWS_CDK_BUNDLE.patchedFloor}; the vulnerable bundle must not ship`,
      );
    } else {
      problems.push(
        `lockfile graph no longer matches the reviewed fixed AWS CDK bundled ${expectation.packageName} path`,
      );
    }
  }
  return problems;
}

// Problems with the reviewed jsii braces chain. An empty list means the cdk
// lockfile matches the reviewed chain exactly. Pure so the self-test can drive
// it.
function jsiiBracesChainProblems(packages) {
  const problems = [];
  const bracePaths = Object.keys(packages).filter(
    (key) => key === `node_modules/${E2.packageName}` || key.endsWith(`/node_modules/${E2.packageName}`),
  );
  const bracePackage = packages[E2.packagePath];

  if (!sameStringSet(bracePaths, [E2.packagePath]) || bracePackage?.dev !== true) {
    problems.push(
      `lockfile graph no longer matches the reviewed ${E2.exceptionId} exception (expected exactly one dev ${E2.packageName} at ${E2.packagePath})`,
    );
    return problems;
  }

  // braces always depends on fill-range; a braces package without it is not the
  // reviewed release.
  if (bracePackage?.dependencies?.["fill-range"] === undefined) {
    problems.push(
      `lockfile graph no longer matches the reviewed ${E2.exceptionId} exception (${E2.packageName} is missing its fill-range dependency)`,
    );
  }

  const version = bracePackage?.version;
  if (version && compareVersionStrings(version, E2.patchedFloor) >= 0) {
    problems.push(
      `reviewed exception ${E2.exceptionId} removal condition met: the jsii toolchain now resolves ${E2.packageName} ${version} >= ${E2.patchedFloor}; remove the exception`,
    );
  } else if (version !== E2.packageVersion) {
    problems.push(
      `lockfile graph no longer matches the reviewed ${E2.exceptionId} exception (expected ${E2.packageName} ${E2.packageVersion})`,
    );
  }

  for (const link of E2.chain) {
    const linkPackage = packages[link.path];
    if (linkPackage?.dev !== true) {
      problems.push(
        `lockfile graph no longer matches the reviewed ${E2.exceptionId} exception (expected the dev ${link.name} at ${link.path})`,
      );
      continue;
    }
    if (!linkPackage.dependencies?.[link.via] && !linkPackage.peerDependencies?.[link.via]) {
      problems.push(
        `lockfile graph no longer matches the reviewed ${E2.exceptionId} exception (${link.name} no longer depends on ${link.via})`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Removal conditions (pure, so the self-test can drive them without network)
// ---------------------------------------------------------------------------

function recheckExpired(nowIso, recheckBy) {
  return Date.parse(nowIso) >= Date.parse(`${recheckBy}T00:00:00Z`);
}

function e2RemovalReasons({ publishedStablePatchedBraces }) {
  const reasons = [];
  if (publishedStablePatchedBraces.length > 0) {
    reasons.push(
      `a patched ${E2.packageName} (>= ${E2.patchedFloor}) is published to npm: ${publishedStablePatchedBraces.join(", ")}`,
    );
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Registry-backed removal probe
// ---------------------------------------------------------------------------

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

async function e2RemovalProbe() {
  const bracesDocument = await fetchRegistryDocument(
    `${registryBaseUrl}/${E2.packageName}`,
    `${E2.packageName} versions`,
    "application/vnd.npm.install-v1+json",
  );
  return e2RemovalReasons({
    publishedStablePatchedBraces: stableVersionsAtLeast(
      Object.keys(bracesDocument.versions ?? {}),
      E2.patchedFloor,
    ),
  });
}

// ---------------------------------------------------------------------------
// Self-test (offline, deterministic: exercises every negative the gate relies
// on, plus the recheck_by boundary and each removal condition).
// ---------------------------------------------------------------------------

// Reads the SEC-2 Node scan set out of the governance verifier, so the scanned
// lockfile scope and the gate's scan surface cannot drift apart silently.
// Returns null when the array cannot be found, which fails the comparison that
// uses it.
function rubricNodeLockfiles() {
  const verifierPath = path.join(repositoryRoot, "gov-infra/verifiers/gov-verify-rubric.sh");
  let source;
  try {
    source = fs.readFileSync(verifierPath, "utf8");
  } catch {
    return null;
  }
  const block = /local -a node_lockfiles=\(([\s\S]*?)\n\s*\)/.exec(source);
  if (!block) return null;
  const entries = [];
  for (const line of block[1].split("\n")) {
    const match = /^\s*"([^"]+)"\s*$/.exec(line);
    if (match) entries.push(match[1]);
  }
  return entries.length > 0 ? entries : null;
}

function runSelfTest() {
  const now = "2026-10-04T00:00:00Z";
  const canonical = "cdk/package-lock.json";
  const otherLockfile = "examples/cdk/multilang/package-lock.json";
  // A lockfile that is deliberately NOT in AWS_CDK_LOCKFILES. It stands in for
  // an npm lockfile that starts routing to this checker without being reviewed.
  const unroutedLockfile = "examples/cdk/not-yet-routed-site/package-lock.json";
  const cases = [];

  const osvResult = (lockfile) => ({ source: { path: lockfile } });
  const osvPkg = (name, version) => ({ package: { ecosystem: "npm", name, version } });

  // A synthetic lockfile that matches the reviewed fixed bundle exactly, used to
  // drive the graph assertions.
  const validPackages = () => ({
    "node_modules/aws-cdk-lib": { version: expectation.cdkVersion, bundleDependencies: ["minimatch"] },
    "node_modules/aws-cdk-lib/node_modules/minimatch": {
      version: expectation.minimatchVersion,
      inBundle: true,
      dependencies: { "brace-expansion": "^5.0.5" },
    },
    "node_modules/aws-cdk-lib/node_modules/brace-expansion": {
      version: "5.0.12",
      inBundle: true,
      dependencies: { "balanced-match": "^4.0.2" },
    },
    "node_modules/braces": { version: "3.0.3", dev: true, dependencies: { "fill-range": "^7.1.1" } },
    "node_modules/micromatch": { version: "4.0.8", dev: true, dependencies: { braces: "^3.0.3" } },
    "node_modules/fast-glob": { version: "3.3.3", dev: true, dependencies: { micromatch: "^4.0.8" } },
    "node_modules/jsii-rosetta": { version: "6.0.16", dev: true, dependencies: { "fast-glob": "^3.3.3" } },
    "node_modules/jsii-pacmak": {
      version: "1.140.0",
      dev: true,
      peerDependencies: { "jsii-rosetta": ">=5.9.0" },
    },
  });

  const expectNpm = (label, name, vuln, lockfile, expected) =>
    cases.push({
      label,
      actual: npmMatchingException(name, vuln, lockfile) !== null,
      expected,
    });
  const expectOsv = (label, result, pkg, vuln, lockfile, expected) =>
    cases.push({
      label,
      actual: osvMatchingException(result, pkg, vuln, lockfile) !== null,
      expected,
    });

  // Real positive shape: E2's exact braces chain, on the cdk lockfile only.
  expectNpm(
    "npm E2 root real shape matches",
    "braces",
    { name: "braces", nodes: [E2.packagePath], effects: ["micromatch"], via: [{ url: E2.advisories[0].url }] },
    canonical,
    true,
  );
  for (const link of E2.chain) {
    expectNpm(
      `npm E2 chain link ${link.name} matches`,
      link.name,
      { name: link.name, nodes: [link.path], effects: link.effects, via: [link.via] },
      canonical,
      true,
    );
  }
  expectOsv(
    "osv E2 real shape matches",
    osvResult(canonical),
    osvPkg("braces", "3.0.3"),
    { id: E2.advisories[0].id, aliases: [E2.advisories[0].alias] },
    canonical,
    true,
  );

  // The retired E1 exception must excuse nothing: the exact bundled
  // brace-expansion shapes it used to cover now fail on every routed lockfile.
  const retiredE1Vuln = {
    name: "brace-expansion",
    nodes: [expectation.packagePath],
    effects: [],
    via: [
      { url: "https://github.com/advisories/GHSA-6j4f-fj2g-mc7p" },
      { url: "https://github.com/advisories/GHSA-q2hr-2g5m-vwhr" },
      { url: "https://github.com/advisories/GHSA-qhr7-859c-m2p7" },
    ],
  };
  expectNpm(
    "retired E1: the former bundled brace-expansion npm shape is no longer excepted",
    "brace-expansion",
    retiredE1Vuln,
    canonical,
    false,
  );
  expectNpm(
    "retired E1: the former bundled npm shape is not excepted for a routed example lockfile",
    "brace-expansion",
    retiredE1Vuln,
    otherLockfile,
    false,
  );
  expectOsv(
    "retired E1: an osv brace-expansion 5.0.9 finding is no longer excepted",
    osvResult(canonical),
    osvPkg("brace-expansion", "5.0.9"),
    { id: "GHSA-6j4f-fj2g-mc7p", aliases: ["CVE-2026-102276"] },
    canonical,
    false,
  );

  // Every lockfile in AWS_CDK_LOCKFILES is a real, reviewed file: a named
  // lockfile that does not exist in the worktree would be a silent hole in the
  // scanned set, so every entry must resolve to a real file.
  for (const routedLockfile of AWS_CDK_LOCKFILES) {
    cases.push({
      label: `AWS_CDK_LOCKFILES named lockfile exists: ${routedLockfile}`,
      actual: fs.existsSync(path.join(repositoryRoot, routedLockfile)),
      expected: true,
    });
  }
  // The reviewed bundled lockfile set and the SEC-2 gate's Node scan set must
  // not drift apart: a lockfile the gate scans but this checker omits fails the
  // gate, and one this checker names but the gate never scans is unexamined.
  cases.push({
    label: "AWS_CDK_LOCKFILES and gov-verify-rubric.sh node_lockfiles agree",
    actual: sameStringSet(rubricNodeLockfiles(), [...AWS_CDK_LOCKFILES, "ts/package-lock.json"]),
    expected: true,
  });

  // (a) a different advisory id on the same package still fails.
  expectNpm(
    "(a) npm E2 a different advisory url fails",
    "braces",
    { name: "braces", nodes: [E2.packagePath], effects: ["micromatch"], via: [{ url: "https://github.com/advisories/GHSA-0000-0000-0000" }] },
    canonical,
    false,
  );
  expectOsv(
    "(a) osv E2 a different advisory id fails",
    osvResult(canonical),
    osvPkg("braces", "3.0.3"),
    { id: "GHSA-0000-0000-0000", aliases: [E2.advisories[0].alias] },
    canonical,
    false,
  );

  // (b) a different version still fails.
  expectOsv(
    "(b) osv E2 a different version fails",
    osvResult(canonical),
    osvPkg("braces", "3.0.2"),
    { id: E2.advisories[0].id, aliases: [E2.advisories[0].alias] },
    canonical,
    false,
  );

  // (c) a different-path copy still fails. OSV reports carry no node paths, so
  // the bundled-vs-elsewhere distinction is enforced by the lockfile graph
  // assertions, which the cases below drive directly.
  const nonBundledPackages = { ...validPackages(), "node_modules/brace-expansion": { version: "5.0.12" } };
  cases.push({
    label: "(c) a non-bundled copy of brace-expansion fails the fixed-graph anchor",
    actual: awsCdkBundleGraphProblems(nonBundledPackages).length > 0,
    expected: true,
  });
  const plantedTopLevel = { ...validPackages(), "node_modules/brace-expansion": { version: "5.0.12" } };
  cases.push({
    label: "(c) a planted top-level brace-expansion fails the fixed-graph anchor",
    actual: awsCdkBundleGraphProblems(plantedTopLevel).length > 0,
    expected: true,
  });
  const nestedBraces = { ...validPackages() };
  delete nestedBraces["node_modules/braces"];
  nestedBraces["node_modules/jsii-rosetta/node_modules/braces"] = {
    version: "3.0.3",
    dev: true,
    dependencies: { "fill-range": "^7.1.1" },
  };
  cases.push({
    label: "(c) E2 braces at a nested path fails the graph",
    actual: jsiiBracesChainProblems(nestedBraces).length > 0,
    expected: true,
  });
  cases.push({
    label: "(c) the reviewed fixed graph itself must be clean",
    actual:
      awsCdkBundleGraphProblems(validPackages()).length === 0 &&
      jsiiBracesChainProblems(validPackages()).length === 0,
    expected: true,
  });

  // (d) any other package or lockfile still fails.
  expectOsv(
    "(d) osv an unrelated package fails",
    osvResult(canonical),
    osvPkg("lodash", "4.17.0"),
    { id: "GHSA-0000-0000-0000", aliases: [] },
    canonical,
    false,
  );
  expectNpm(
    "(d) npm E2 chain link from an unrouted lockfile fails",
    "micromatch",
    { name: "micromatch", nodes: ["node_modules/micromatch"], effects: ["fast-glob"], via: ["braces"] },
    otherLockfile,
    false,
  );

  // (d2) the fixed-graph anchor fails closed on a vulnerable bundle, a drifted
  // bundled version, or a drifted bundled minimatch.
  const vulnerableBundle = { ...validPackages() };
  vulnerableBundle["node_modules/aws-cdk-lib/node_modules/brace-expansion"] = {
    version: "5.0.9",
    inBundle: true,
    dependencies: { "balanced-match": "^4.0.2" },
  };
  cases.push({
    label: "(d2) a vulnerable bundled brace-expansion (5.0.9) fails the fixed-graph anchor",
    actual: awsCdkBundleGraphProblems(vulnerableBundle).length > 0,
    expected: true,
  });
  const driftedBundleVersion = { ...validPackages() };
  driftedBundleVersion["node_modules/aws-cdk-lib/node_modules/brace-expansion"].version = "5.0.13";
  cases.push({
    label: "(d2) a drifted bundled brace-expansion version fails the fixed-graph anchor",
    actual: awsCdkBundleGraphProblems(driftedBundleVersion).length > 0,
    expected: true,
  });
  const driftedBundleMinimatch = { ...validPackages() };
  driftedBundleMinimatch["node_modules/aws-cdk-lib/node_modules/minimatch"].version = "10.2.4";
  cases.push({
    label: "(d2) a drifted bundled minimatch version fails the fixed-graph anchor",
    actual: awsCdkBundleGraphProblems(driftedBundleMinimatch).length > 0,
    expected: true,
  });
  const driftedCdk = { ...validPackages() };
  driftedCdk["node_modules/aws-cdk-lib"].version = "2.272.0";
  cases.push({
    label: "(d2) a drifted aws-cdk-lib version fails the fixed-graph anchor",
    actual: awsCdkBundleGraphProblems(driftedCdk).length > 0,
    expected: true,
  });

  // (e) after recheck_by the remaining exception stops applying.
  cases.push({
    label: "(e) recheck_by boundary: the day before is live",
    actual: recheckExpired("2026-11-01T23:59:59Z", E2.recheckBy),
    expected: false,
  });
  cases.push({
    label: "(e) recheck_by boundary: the deadline itself expires",
    actual: recheckExpired("2026-11-02T00:00:00Z", E2.recheckBy),
    expected: true,
  });
  cases.push({
    label: "(e) recheck_by boundary: after the deadline expires",
    actual: recheckExpired("2026-12-01T00:00:00Z", E2.recheckBy),
    expected: true,
  });

  // (f) the removal condition is detected.
  cases.push({
    label: "(f) E2 removal: a patched braces is published",
    actual: e2RemovalReasons({ publishedStablePatchedBraces: ["3.0.4"] }).length > 0,
    expected: true,
  });
  cases.push({
    label: "(f) E2 stays live: no patched braces published",
    actual: e2RemovalReasons({ publishedStablePatchedBraces: [] }).length === 0,
    expected: true,
  });

  // (g) the OSV report contract: any shape that could hide a finding is a
  // problem, and a well-formed finding is collected so the matcher can judge it.
  const expectOsvEntries = (label, report, expectedEntries, expectedProblemCount) => {
    const collected = collectOsvEntries(report);
    cases.push({ label: `${label}: entries`, actual: collected.entries.length, expected: expectedEntries });
    cases.push({
      label: `${label}: problems`,
      actual: collected.problems.length,
      expected: expectedProblemCount,
    });
  };
  expectOsvEntries("(g) an empty results array", { results: [] }, 0, 0);
  expectOsvEntries("(g) a missing results array", {}, 0, 1);
  expectOsvEntries("(g) a non-object report", null, 0, 1);
  expectOsvEntries("(g) a null result entry", { results: [null] }, 0, 1);
  expectOsvEntries("(g) a string-valued packages list", { results: [{ packages: "nope" }] }, 0, 1);
  expectOsvEntries("(g) a result with no packages", { results: [{}] }, 0, 0);
  expectOsvEntries(
    "(g) a package with no vulnerabilities",
    { results: [{ packages: [{ package: { ecosystem: "npm", name: "braces", version: "3.0.3" } }] }] },
    0,
    0,
  );
  expectOsvEntries(
    "(g) a string-valued vulnerabilities list",
    { results: [{ packages: [{ vulnerabilities: "nope" }] }] },
    0,
    1,
  );
  expectOsvEntries(
    "(g) a null vulnerability entry",
    { results: [{ packages: [{ vulnerabilities: [null] }] }] },
    0,
    1,
  );
  expectOsvEntries(
    "(g) a well-formed finding",
    {
      results: [
        {
          source: { path: canonical },
          packages: [
            {
              package: { ecosystem: "npm", name: "braces", version: "3.0.3" },
              vulnerabilities: [{ id: E2.advisories[0].id, aliases: [E2.advisories[0].alias] }],
            },
          ],
        },
      ],
    },
    1,
    0,
  );

  // The clock the fake-cases above assume must be the real one's relative order.
  cases.push({
    label: "self-test: the fixture clock is before recheck_by",
    actual: recheckExpired(now, E2.recheckBy),
    expected: false,
  });

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
  console.log(`self-test: PASS (${cases.length} cases; exception matcher, recheck_by, removal condition, fixed-graph anchor)`);
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const report = readJson(reportPath, "scanner report");
  const lock = readJson(lockfilePath, "lockfile");
  const packages = lock.packages ?? {};
  const canonicalLockfile = canonicalLockfilePath(lockfilePath);
  const inScopeExceptions = EXCEPTIONS.filter((exception) =>
    exception.lockfiles.includes(canonicalLockfile),
  );

  // Hard recheck deadline: shared, and enforced before anything can be excused.
  const nowIso = new Date().toISOString();
  for (const exception of inScopeExceptions) {
    if (recheckExpired(nowIso, exception.recheckBy)) {
      fail(
        `reviewed exception ${exception.exceptionId} reached its recheck_by deadline ${exception.recheckBy}; re-review and remove or renew it before the gate can pass`,
      );
    }
  }

  // Fail-closed integrity anchors. The bundled-graph anchor runs for every
  // routed lockfile; the jsii chain anchor only where its exception is in scope.
  const graphProblems = awsCdkBundleGraphProblems(packages);
  if (inScopeExceptions.includes(E2)) {
    graphProblems.push(...jsiiBracesChainProblems(packages));
  }
  if (graphProblems.length > 0) {
    for (const problem of graphProblems) {
      console.error(`${mode}-scanner: ${problem}`);
    }
    fail("lockfile graph does not match the reviewed AWS CDK dependency-audit scope");
  }

  // Registry-backed removal probe: unconditional for every in-scope exception,
  // so a stale exception cannot survive by simply never matching a finding.
  const removalReasons = [];
  if (inScopeExceptions.includes(E2)) {
    removalReasons.push(...(await e2RemovalProbe()));
  }
  if (removalReasons.length > 0) {
    for (const reason of removalReasons) {
      console.error(`${mode}-scanner: exception removal condition met - ${reason}`);
    }
    fail(
      `reviewed AWS CDK dependency-audit exception removal condition met; remove the exception(s) before the gate can pass`,
    );
  }

  // Parse the scanner report into findings, tagging each with the exception (if
  // any) that reviewed it.
  const findings = [];
  if (mode === "npm") {
    if (report.error || !report.vulnerabilities || typeof report.vulnerabilities !== "object") {
      fail("npm audit report is missing its vulnerability map");
    }
    for (const [name, vuln] of Object.entries(report.vulnerabilities)) {
      const exception = npmMatchingException(name, vuln, canonicalLockfile);
      findings.push({
        exceptionId: exception?.exceptionId ?? null,
        id:
          (vuln.via ?? [])
            .map((entry) =>
              entry && typeof entry === "object" ? entry.url || entry.title || entry.name : entry,
            )
            .filter(Boolean)
            .join(", ") || "<unknown>",
        packageName: vuln.name ?? "<unknown>",
        source: canonicalLockfile,
        version: (vuln.nodes ?? []).join(", ") || "<unknown>",
      });
    }
  } else {
    const collected = collectOsvEntries(report);
    for (const problem of collected.problems) {
      console.error(`${mode}-scanner: ${problem}`);
    }
    if (collected.problems.length > 0) {
      fail("OSV report shape is not one this gate can evaluate");
    }
    for (const { result, pkg, vuln } of collected.entries) {
      const packageInfo = pkg?.package ?? {};
      const exception = osvMatchingException(result, pkg, vuln, canonicalLockfile);
      findings.push({
        exceptionId: exception?.exceptionId ?? null,
        fixedVersions: fixedVersions(vuln, packageInfo.name ?? "<unknown>"),
        id: vuln.id ?? "<unknown>",
        packageName: packageInfo.name ?? "<unknown>",
        source: result?.source?.path ?? "<unknown>",
        version: packageInfo.version ?? "<unknown>",
      });
    }
  }

  const unexpected = findings.filter((finding) => finding.exceptionId === null);
  const applied = findings.filter((finding) => finding.exceptionId !== null);

  if (unexpected.length > 0) {
    for (const vuln of unexpected) {
      const fixed = vuln.fixedVersions
        ? ` (fixed versions: ${JSON.stringify(vuln.fixedVersions)})`
        : "";
      console.error(
        `${mode}-scanner: unexpected vulnerability ${vuln.id} in ${vuln.packageName}@${vuln.version} from ${vuln.source}${fixed}`,
      );
    }
    fail(`AWS CDK findings outside the reviewed dependency-audit exceptions`);
  }

  const appliedIds = [...new Set(applied.map((finding) => finding.exceptionId))].sort();
  for (const exceptionId of appliedIds) {
    const exception = exceptionById(exceptionId);
    const count = applied.filter((finding) => finding.exceptionId === exceptionId).length;
    console.log(
      `exception-applied: ${exceptionId} advisories=${exception.advisories
        .map((advisory) => advisory.id)
        .join(",")} findings=${count}`,
    );
    console.error(
      `${mode}-scanner: WARN ${JSON.stringify({
        recordType: "reviewed-vulnerability-exception",
        exceptionId,
        advisoryIds: exception.advisories.map((advisory) => advisory.id),
        operatorRuling: exception.operatorRuling,
        recheckBy: exception.recheckBy,
        removalCondition: exception.removalCondition,
        lockfile: canonicalLockfile,
        package: { name: exception.packageName, path: exception.packagePath, version: exception.packageVersion },
      })}`,
    );
  }

  console.error(
    `${mode}-scanner: PASS ${JSON.stringify({
      recordType: "verified-patched-dependency",
      checkId: "aws-cdk-lib-bundled-brace-expansion",
      advisoryId: expectation.advisoryId,
      advisoryUrl: expectation.advisoryUrl,
      alias: expectation.alias,
      fixedVersions: expectation.fixedVersions,
      lockfile: canonicalLockfile,
      package: {
        name: expectation.packageName,
        path: expectation.packagePath,
        version: expectation.packageVersion,
      },
      reviewedExceptions: appliedIds,
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
}

if (selfTest) {
  process.exit(runSelfTest());
}

await main();
