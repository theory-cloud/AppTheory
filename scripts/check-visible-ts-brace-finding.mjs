// Purpose: validate the reviewed, dev-only TypeScript lint-tool dependency graph
// and prove that the only vulnerability finding visible to the ts/ OSV audit
// surface is the one reviewed, self-expiring exception documented below.
//
// ===========================================================================
// Reviewed, self-expiring dependency-audit exception
// ===========================================================================
// SEC-2 ("none may be added without an operator ruling") requires a ruling for
// every exception. This checker grants exactly one, quoted verbatim:
//
//   * 2026-11-01: "Dev-only exception" - override minimatch to 11.0.1
//     everywhere except eslint-plugin-import-x, keep import-x on 10.2.6, and
//     record the single remaining minimatch 10.2.6 node path as a reviewed,
//     self-expiring exception.
//
// ---------------------------------------------------------------------------
// E4 - minimatch 10.2.6 kept for eslint-plugin-import-x
// ---------------------------------------------------------------------------
// Finding   GHSA-g3hv-75wg-m249 (moderate, CVE-2026-118764) on
//           minimatch@10.2.6 at
//           node_modules/eslint-plugin-import-x/node_modules/minimatch, resolved
//           only by the eslint-plugin-import-x lint-plugin edge. Every other
//           consumer of minimatch in this lockfile - eslint,
//           @eslint/config-array, and @typescript-eslint/typescript-estree - is
//           overridden to the patched 11.0.1 at the single hoisted
//           node_modules/minimatch node, so the 10.2.6 node has exactly one
//           parent. The graph anchor below pins both minimatch nodes, the
//           patched consumers' dedupe shape, and the exact parent set; a fifth
//           consumer, a relocated path, or a version change fails closed before
//           any finding is read.
// Why an upgrade cannot resolve it (2026-11-01): minimatch 11 removed the
//           `makeRe` export that eslint-plugin-import-x 4.17.1 imports at module
//           load (lib/rules/no-internal-modules.js), so loading the plugin under
//           a minimatch 11 override throws
//           "does not provide an export named 'makeRe'" and ESLint cannot load
//           its config. eslint-plugin-import-x 4.17.1 is the latest published
//           release and still declares minimatch `^9.0.3 || ^10.1.2`; no
//           import-x release accepts 11 yet. The rule set this repository uses
//           (extensions/first/no-duplicates/order) is evaluated by that plugin,
//           so it cannot simply be dropped without changing lint coverage.
// Dev-only  Lint tooling only. The vulnerable node is a devDependency-tree node
//           (`dev: true`), the root package's runtime `dependencies` do not
//           mention minimatch, and `npm ls --omit=dev --all` inside ts/ reports
//           no minimatch at all. No published AppTheory package and no Lambda
//           ships it: the ts/ package publishes `files: [dist, LICENSE,
//           README.md, package.json]`, none of which carry node_modules.
// Ruling:   2026-11-01 operator ruling ("Dev-only exception").
// Removal condition: eslint-plugin-import-x publishes a release compatible with
//           minimatch >= 11.0.1.
// Recheck by: 2026-12-01 (renewed/re-reviewed then, or removed when the
//           removal condition is met).
//
// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------
// The exception is exact: lockfile, package, version, node path / parent,
// advisory id, and alias. It is ALSO self-expiring and fail closed:
//   * recheck_by - 2026-12-01 - after that date the exception no longer applies
//     and the checker fails, forcing a fresh review;
//   * a lockfile-local removal probe runs on every invocation (never only when
//     a finding happens to appear), and a registry-backed probe checks whether
//     the latest published eslint-plugin-import-x accepts a published
//     minimatch >= 11.0.1; an unreachable registry is reported as BLOCKED
//     (exit 2), never assumed clean;
//   * the graph anchor is a positive assertion over every minimatch and
//     brace-expansion node, the runner dependency (@isaacs/nonrecursive-glob-
//     match), the exact parent set, the dev flags, and the reviewed npm
//     `overrides` map, so an unreviewed install cannot silently weaken the path;
//   * any other package, version, path, advisory, or alias still fails closed.
// Machine contract: when the exception is applied the checker prints one line
// to stdout beginning "exception-applied: " so a calling gate can prove that a
// non-zero scanner exit was caused by exactly the reviewed finding.
// ===========================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const registryBaseUrl = "https://registry.npmjs.org";
const registryTimeoutMs = 20000;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const selfTest = argv[0] === "--self-test";
const [reportPath, lockfilePath] = argv;

if (!selfTest && (!reportPath || !lockfilePath)) {
  console.error(
    "usage: node scripts/check-visible-ts-brace-finding.mjs <osv-report-json> <package-lock.json> [--self-test]",
  );
  process.exit(2);
}

function fail(message) {
  console.error(`osv-scanner: FAIL (${message})`);
  process.exit(1);
}

function blocked(message) {
  console.error(`osv-scanner: BLOCKED (${message})`);
  process.exit(2);
}

function readJson(path, description) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (err) {
    fail(`could not parse ${description} ${path}: ${err.message}`);
  }
}

// Order-insensitive JSON rendering, so two structurally equal override maps
// compare equal regardless of key order.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

function stringList(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Numeric comparison of dotted versions. Pre-release suffixes are ignored: the
// reviews here only ever compare release versions.
function compareVersionStrings(a, b) {
  const left = String(a).split("-")[0].split(".").map(Number);
  const right = String(b).split("-")[0].split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const l = Number.isFinite(left[index]) ? left[index] : 0;
    const r = Number.isFinite(right[index]) ? right[index] : 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

function stableVersionsAtLeast(versions, floor) {
  const stable = [];
  for (const version of versions) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    if (compareVersionStrings(version, floor) < 0) continue;
    stable.push(version);
  }
  return [...new Set(stable)].sort(compareVersionStrings);
}

// ---------------------------------------------------------------------------
// npm semver range evaluation (only needed to decide the removal condition:
// "does this published eslint-plugin-import-x accept a published minimatch
// >= 11.0.1"). Supports the comparator forms npm dependencies actually use:
// `||` alternatives, whitespace conjunctions, ^, ~, >=, >, <=, <, =, bare
// versions, and x/X/* wildcards. Anything else is reported as an unevaluable
// range instead of being guessed.
// ---------------------------------------------------------------------------

class RangeParseError extends Error {}

function parsePartialVersion(text) {
  const match = /^v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(?:-[0-9A-Za-z.-]+)?$/.exec(
    String(text).trim(),
  );
  if (!match) return null;
  const part = (raw) => {
    if (raw === undefined) return null;
    if (raw === "x" || raw === "X" || raw === "*") return "any";
    return Number(raw);
  };
  return { major: Number(match[1]), minor: part(match[2]), patch: part(match[3]) };
}

function expandedVersion(partial, overrides = {}) {
  const minor = partial.minor === null || partial.minor === "any" ? (overrides.minor ?? 0) : partial.minor;
  const patch = partial.patch === null || partial.patch === "any" ? (overrides.patch ?? 0) : partial.patch;
  return `${partial.major}.${minor}.${patch}`;
}

function comparatorSatisfied(version, token) {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(\S+)$/.exec(token);
  if (!match) throw new RangeParseError(`could not parse comparator ${JSON.stringify(token)}`);
  const operator = match[1] ?? "";
  const partial = parsePartialVersion(match[2]);
  if (!partial) throw new RangeParseError(`could not parse version ${JSON.stringify(match[2])}`);
  const atLeast = (bound) => compareVersionStrings(version, bound) >= 0;
  const above = (bound) => compareVersionStrings(version, bound) > 0;
  const below = (bound) => compareVersionStrings(version, bound) < 0;
  const lower = expandedVersion(partial);

  if (operator === "^") {
    let upper;
    if (partial.major > 0 || partial.minor === null || partial.minor === "any") {
      upper = `${partial.major + 1}.0.0`;
    } else if (partial.minor > 0 || partial.patch === null || partial.patch === "any") {
      upper = `0.${partial.minor + 1}.0`;
    } else {
      upper = `0.0.${partial.patch + 1}`;
    }
    return atLeast(lower) && below(upper);
  }
  if (operator === "~") {
    const upper =
      partial.minor === null || partial.minor === "any"
        ? `${partial.major + 1}.0.0`
        : `${partial.major}.${partial.minor + 1}.0`;
    return atLeast(lower) && below(upper);
  }
  if (operator === ">=") return atLeast(lower);
  if (operator === ">") return above(lower);
  if (operator === "<=") return below(lower) || compareVersionStrings(version, lower) === 0;
  if (operator === "<") return below(lower);
  // Bare or "=": a partial version is a range, a full version is equality.
  if (partial.minor === null || partial.minor === "any") {
    return atLeast(`${partial.major}.0.0`) && below(`${partial.major + 1}.0.0`);
  }
  if (partial.patch === null || partial.patch === "any") {
    return atLeast(lower) && below(`${partial.major}.${partial.minor + 1}.0`);
  }
  return compareVersionStrings(version, lower) === 0;
}

function versionSatisfiesRange(version, range) {
  const alternatives = String(range)
    .split("||")
    .map((alternative) => alternative.trim())
    .filter((alternative) => alternative.length > 0);
  if (alternatives.length === 0) throw new RangeParseError(`empty range ${JSON.stringify(range)}`);
  return alternatives.some((alternative) => {
    if (alternative === "*" || alternative === "x" || alternative === "X") return true;
    return alternative.split(/\s+/).every((token) => comparatorSatisfied(version, token));
  });
}

// ---------------------------------------------------------------------------
// Reviewed graph and exception
// ---------------------------------------------------------------------------

const expectation = {
  checkId: "typescript-lint-tool-minimatch-graph",
  lockfile: "ts/package-lock.json",
  packageJson: "ts/package.json",
  braceExpansion: {
    balancedMatchRange: "^4.0.2",
    dev: true,
    path: "node_modules/brace-expansion",
    version: "5.0.12",
  },
  globMatch: {
    dev: true,
    path: "node_modules/@isaacs/nonrecursive-glob-match",
    version: "1.0.3",
  },
  // The patched minimatch the lint stack moved to. The 2026-11-01 lockfile
  // refresh let npm re-hoist the override target: the patched 11.0.1 now sits
  // at the single root node, every overridden consumer dedupes onto it, and the
  // reviewed 10.2.6 node moved to its one remaining parent
  // (eslint-plugin-import-x). The anchor pins that exact shape instead of
  // assuming the older nested-per-consumer topology.
  minimatchPatched: {
    braceExpansionRange: "^5.0.12",
    dev: true,
    globMatchRange: "^1.0.1",
    paths: ["node_modules/minimatch"],
    version: "11.0.1",
  },
  minimatchReviewed: {
    braceExpansionRange: "^5.0.8",
    dev: true,
    path: "node_modules/eslint-plugin-import-x/node_modules/minimatch",
    version: "10.2.6",
  },
  // Every package in the lockfile that declares a minimatch dependency. The
  // patched consumers keep their original (10.x) ranges because the override,
  // not the range, moves them onto 11.0.1.
  minimatchParents: [
    {
      dependencyRange: "^10.2.4",
      path: "node_modules/@eslint/config-array",
      version: "0.23.5",
    },
    {
      dependencyRange: "^10.2.2",
      path: "node_modules/@typescript-eslint/typescript-estree",
      version: "8.72.1",
    },
    {
      dependencyRange: "^10.2.6",
      path: "node_modules/eslint",
      version: "10.14.0",
    },
    {
      dependencyRange: "^9.0.3 || ^10.1.2",
      path: "node_modules/eslint-plugin-import-x",
      version: "4.17.1",
    },
  ],
  // The npm overrides that produce the reviewed graph. The lockfile does not
  // record overrides, so the sibling package.json is checked directly: losing
  // an override would let a later install drift back onto 10.2.6 everywhere.
  overrides: {
    minimatch: "11.0.1",
    eslint: { minimatch: "11.0.1" },
    "@eslint/config-array": { minimatch: "11.0.1" },
    "@typescript-eslint/typescript-estree": { minimatch: "11.0.1" },
    "eslint-plugin-import-x": { minimatch: "10.2.6" },
  },
};

const E4 = {
  exceptionId: "ts-dev-import-x-minimatch",
  kind: "dev-tooling",
  lockfiles: [expectation.lockfile],
  packageName: "minimatch",
  packagePath: expectation.minimatchReviewed.path,
  packageVersion: expectation.minimatchReviewed.version,
  patchedFloor: expectation.minimatchPatched.version,
  parent: {
    name: "eslint-plugin-import-x",
    path: "node_modules/eslint-plugin-import-x",
    version: "4.17.1",
  },
  advisories: [
    {
      id: "GHSA-g3hv-75wg-m249",
      alias: "CVE-2026-118764",
      url: "https://github.com/advisories/GHSA-g3hv-75wg-m249",
    },
  ],
  operatorRuling: "2026-11-01 (dev-only exception)",
  owner: "theory-cloud/AppTheory steward (Factory dependency sweeps)",
  recheckBy: "2026-12-01",
  devOnlyEvidence:
    "npm ls --omit=dev --all inside ts/ reports no minimatch; every minimatch, brace-expansion, and @isaacs/nonrecursive-glob-match node in the lockfile is dev: true; the root package's runtime dependencies do not mention minimatch; ts/package.json publishes only dist, LICENSE, README.md, and package.json.",
  justification:
    "Dev-only lint tooling with no upstream fix: eslint-plugin-import-x 4.17.1 (the latest published release) imports the `makeRe` export that minimatch 11 removed, so a minimatch 11 override breaks ESLint config load and the plugin's rules can no longer be evaluated. The patched minimatch 11.0.1 is used everywhere else via npm overrides; import-x alone keeps 10.2.6 at the single reviewed node path. Lint-only, dev: true, and no AppTheory runtime package or Lambda ships it. Operator-ruled 2026-11-01 (dev-only exception). Self-expiring; see the removal condition in this file.",
  removalCondition:
    "eslint-plugin-import-x publishes a release compatible with minimatch >= 11.0.1",
};

// ---------------------------------------------------------------------------
// Lockfile graph assertions (the fail-closed anchors)
// ---------------------------------------------------------------------------

// Every way the lockfile can deviate from the reviewed graph. An empty list is
// the only passing state. Pure so the self-test can drive it.
function lockfileGraphProblems(packages) {
  const problems = [];
  const minimatchPaths = Object.keys(packages).filter((key) => key.endsWith("node_modules/minimatch"));
  const bracePaths = Object.keys(packages).filter(
    (key) => key === expectation.braceExpansion.path || key.endsWith(`/${expectation.braceExpansion.path}`),
  );
  const globMatchPaths = Object.keys(packages).filter(
    (key) => key === expectation.globMatch.path || key.endsWith(`/${expectation.globMatch.path}`),
  );

  const expectedMinimatchPaths = [
    expectation.minimatchReviewed.path,
    ...expectation.minimatchPatched.paths,
  ];
  if (!sameStringSet(minimatchPaths, expectedMinimatchPaths)) {
    problems.push(
      "lockfile graph no longer matches the reviewed TypeScript lint-tool minimatch paths (expected the reviewed 10.2.6 node plus one overridden 11.0.1 node per patched consumer)",
    );
  }
  if (!sameStringSet(bracePaths, [expectation.braceExpansion.path])) {
    problems.push("lockfile graph no longer matches the reviewed TypeScript brace-expansion path");
  }
  if (!sameStringSet(globMatchPaths, [expectation.globMatch.path])) {
    problems.push("lockfile graph no longer matches the reviewed @isaacs/nonrecursive-glob-match path");
  }

  const reviewed = packages[expectation.minimatchReviewed.path];
  if (
    reviewed?.version !== expectation.minimatchReviewed.version ||
    reviewed?.dev !== expectation.minimatchReviewed.dev ||
    reviewed?.dependencies?.["brace-expansion"] !== expectation.minimatchReviewed.braceExpansionRange
  ) {
    problems.push(
      `lockfile graph no longer matches the reviewed ${E4.exceptionId} exception (expected dev ${expectation.minimatchReviewed.version} at ${expectation.minimatchReviewed.path})`,
    );
  }

  for (const patchedPath of expectation.minimatchPatched.paths) {
    const patched = packages[patchedPath];
    if (
      patched?.version !== expectation.minimatchPatched.version ||
      patched?.dev !== expectation.minimatchPatched.dev ||
      patched?.dependencies?.["brace-expansion"] !== expectation.minimatchPatched.braceExpansionRange ||
      patched?.dependencies?.["@isaacs/nonrecursive-glob-match"] !== expectation.minimatchPatched.globMatchRange
    ) {
      problems.push(
        `lockfile graph no longer matches the reviewed patched minimatch at ${patchedPath} (expected dev ${expectation.minimatchPatched.version})`,
      );
    }
  }

  const brace = packages[expectation.braceExpansion.path];
  if (
    brace?.version !== expectation.braceExpansion.version ||
    brace?.dev !== expectation.braceExpansion.dev ||
    brace?.dependencies?.["balanced-match"] !== expectation.braceExpansion.balancedMatchRange
  ) {
    problems.push("lockfile graph no longer matches the reviewed TypeScript brace-expansion node");
  }

  const globMatch = packages[expectation.globMatch.path];
  if (globMatch?.version !== expectation.globMatch.version || globMatch?.dev !== expectation.globMatch.dev) {
    problems.push("lockfile graph no longer matches the reviewed @isaacs/nonrecursive-glob-match node");
  }

  const parents = Object.entries(packages)
    .filter(([, pkg]) => pkg?.dependencies?.minimatch)
    .map(([parentPath, pkg]) => ({
      dependencyRange: pkg.dependencies.minimatch,
      path: parentPath,
      version: pkg.version,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const expectedParents = [...expectation.minimatchParents].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (!sameStringSet(parents.map((parent) => JSON.stringify(parent)), expectedParents.map((parent) => JSON.stringify(parent)))) {
    problems.push("lockfile graph no longer matches the reviewed minimatch parent set");
  }

  // Dev-only proof, structural half: the runtime dependency set must never
  // mention minimatch. The command half (`npm ls --omit=dev`) is recorded in
  // the exception's devOnlyEvidence.
  const runtimeDependencies = Object.keys(packages[""]?.dependencies ?? {});
  if (runtimeDependencies.includes("minimatch")) {
    problems.push("minimatch is declared as a runtime dependency; the dev-only exception does not apply");
  }

  return problems;
}

// Identical-tree comparison of the reviewed npm overrides against the sibling
// package.json. Pure so the self-test can drive it.
function overrideProblems(packageJson) {
  const actual = packageJson?.overrides;
  if (stableJson(actual) !== stableJson(expectation.overrides)) {
    return [
      `ts/package.json overrides no longer match the reviewed ${E4.exceptionId} map (expected exactly the reviewed minimatch override map)`,
    ];
  }
  return [];
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

function canonicalLockfilePath(candidate) {
  const normalized = normalizePath(candidate);
  const relative = path.isAbsolute(normalized) ? path.relative(repositoryRoot, normalized) : normalized;
  return normalizePath(relative);
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

// Pure. Returns { entries, findings, problems }, where each entry keeps the raw
// { result, pkg, vuln } triple the exception matcher needs. A non-empty
// `problems` means the report shape would otherwise hide findings from the loop
// below: a missing or non-array results list, a malformed result entry, a
// non-array packages list, a malformed package entry, or a non-array
// vulnerabilities list. A string-valued `packages` used to iterate character by
// character and read as "no findings"; a null result entry threw an uncaught
// TypeError.
function collectOsvFindings(report) {
  const entries = [];
  const findings = [];
  const problems = [];
  if (!isRecord(report)) {
    return {
      entries,
      findings,
      problems: [`OSV report is not a JSON object (got ${JSON.stringify(report)})`],
    };
  }
  if (!Array.isArray(report.results)) {
    return { entries, findings, problems: ["OSV report is missing its results array"] };
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
        const packageInfo = isRecord(pkg.package) ? pkg.package : {};
        entries.push({ result, pkg, vuln });
        findings.push({
          fixedVersions: fixedVersions(vuln, packageInfo.name ?? "<unknown>"),
          id: vuln.id ?? "<unknown>",
          packageName: packageInfo.name ?? "<unknown>",
          source: result.source?.path ?? "<unknown>",
          version: packageInfo.version ?? "<unknown>",
        });
      }
    }
  }
  return { entries, findings, problems };
}

// OSV reports a package name and version, not a node path. The exact node path
// is enforced by lockfileGraphProblems, which runs first and proves the reviewed
// 10.2.6 node exists at exactly one path with exactly one parent; this matcher
// then accepts that one package/version/advisory shape and nothing else.
function osvMatchingException(result, pkg, vuln, canonicalLockfile) {
  if (!E4.lockfiles.includes(canonicalLockfile)) return null;
  if (!osvSourceMatchesLockfile(result?.source?.path, canonicalLockfile)) return null;
  const packageInfo = pkg?.package ?? {};
  if (packageInfo.ecosystem !== "npm") return null;
  if (packageInfo.name !== E4.packageName) return null;
  if (packageInfo.version !== E4.packageVersion) return null;
  const advisory = E4.advisories.find((candidate) => candidate.id === vuln.id);
  if (!advisory) return null;
  if (!sameStringSet(stringList(vuln.aliases), [advisory.alias])) return null;
  return E4;
}

// ---------------------------------------------------------------------------
// Removal conditions (pure, so the self-test can drive them without network)
// ---------------------------------------------------------------------------

function recheckExpired(nowIso, recheckBy) {
  return Date.parse(nowIso) >= Date.parse(`${recheckBy}T00:00:00Z`);
}

// Lockfile-local: the reviewed vulnerable node is gone, upgraded, or no longer
// resolves to the reviewed version.
function e4RemovalReasons(packages) {
  const reasons = [];
  const reviewed = packages[E4.packagePath];
  if (!reviewed) {
    reasons.push(`the reviewed ${E4.packageName} ${E4.packageVersion} node at ${E4.packagePath} is gone`);
    return reasons;
  }
  const version = reviewed.version;
  if (version && compareVersionStrings(version, E4.patchedFloor) >= 0) {
    reasons.push(`${E4.packagePath} now resolves ${E4.packageName} ${version} >= ${E4.patchedFloor}`);
  }
  return reasons;
}

// Registry-backed: the latest published eslint-plugin-import-x accepts some
// published minimatch >= 11.0.1, so the blocked upgrade is available.
function e4RegistryRemovalReasons({ latestParentVersion, minimatchRange, publishedPatchedMinimatch }) {
  const reasons = [];
  if (!latestParentVersion) return reasons;
  if (!minimatchRange) {
    reasons.push(
      `eslint-plugin-import-x ${latestParentVersion} no longer depends on ${E4.packageName}; the exception is moot`,
    );
    return reasons;
  }
  // A range this evaluator cannot parse is propagated to the caller, which
  // reports it as BLOCKED instead of guessing whether the condition is met.
  const removable = publishedPatchedMinimatch.filter((version) =>
    versionSatisfiesRange(version, minimatchRange),
  );
  if (removable.length > 0) {
    reasons.push(
      `eslint-plugin-import-x ${latestParentVersion} accepts ${E4.packageName} ${removable.join(", ")} (range ${minimatchRange})`,
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

async function e4RemovalProbe() {
  const parentDocument = await fetchRegistryDocument(
    `${registryBaseUrl}/${E4.parent.name}`,
    `${E4.parent.name} versions`,
    "application/vnd.npm.install-v1+json",
  );
  const latestParentVersion = parentDocument?.["dist-tags"]?.latest ?? null;
  const minimatchRange =
    latestParentVersion === null
      ? null
      : (parentDocument?.versions?.[latestParentVersion]?.dependencies?.[E4.packageName] ?? null);

  const minimatchDocument = await fetchRegistryDocument(
    `${registryBaseUrl}/${E4.packageName}`,
    `${E4.packageName} versions`,
    "application/vnd.npm.install-v1+json",
  );
  try {
    return e4RegistryRemovalReasons({
      latestParentVersion,
      minimatchRange,
      publishedPatchedMinimatch: stableVersionsAtLeast(
        Object.keys(minimatchDocument?.versions ?? {}),
        E4.patchedFloor,
      ),
    });
  } catch (err) {
    if (err instanceof RangeParseError) {
      blocked(
        `could not evaluate the eslint-plugin-import-x ${latestParentVersion} minimatch range ${JSON.stringify(minimatchRange)}: ${err.message}`,
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Self-test (offline and deterministic: drives the reviewed-graph anchors, the
// override map, the exception matcher, the recheck_by boundary, both removal
// conditions, and the semver range evaluator the removal probe depends on).
// ---------------------------------------------------------------------------

function runSelfTest() {
  const cases = [];
  const expect = (label, actual, expected) => cases.push({ label, actual, expected });
  const canonical = "ts/package-lock.json";

  const validPackages = () => ({
    "node_modules/minimatch": {
      version: "11.0.1",
      dev: true,
      dependencies: {
        "@isaacs/nonrecursive-glob-match": "^1.0.1",
        "brace-expansion": "^5.0.12",
      },
    },
    "node_modules/eslint-plugin-import-x/node_modules/minimatch": {
      version: "10.2.6",
      dev: true,
      dependencies: { "brace-expansion": "^5.0.8" },
    },
    "node_modules/brace-expansion": {
      version: "5.0.12",
      dev: true,
      dependencies: { "balanced-match": "^4.0.2" },
    },
    "node_modules/@isaacs/nonrecursive-glob-match": { version: "1.0.3", dev: true },
    "node_modules/@eslint/config-array": { version: "0.23.5", dependencies: { minimatch: "^10.2.4" } },
    "node_modules/@typescript-eslint/typescript-estree": {
      version: "8.72.1",
      dependencies: { minimatch: "^10.2.2" },
    },
    "node_modules/eslint": { version: "10.14.0", dependencies: { minimatch: "^10.2.6" } },
    "node_modules/eslint-plugin-import-x": {
      version: "4.17.1",
      dependencies: { minimatch: "^9.0.3 || ^10.1.2" },
    },
  });

  expect("the reviewed graph itself passes", lockfileGraphProblems(validPackages()).length, 0);

  const extraMinimatch = validPackages();
  extraMinimatch["node_modules/some-new-tool/node_modules/minimatch"] = {
    version: "10.2.6",
    dev: true,
    dependencies: { "brace-expansion": "^5.0.8" },
  };
  expect(
    "a planted extra minimatch path fails the graph",
    lockfileGraphProblems(extraMinimatch).length,
    1,
  );

  const relocated = validPackages();
  delete relocated["node_modules/eslint-plugin-import-x/node_modules/minimatch"];
  relocated["node_modules/some-new-tool/node_modules/minimatch"] = {
    version: "10.2.6",
    dev: true,
    dependencies: { "brace-expansion": "^5.0.8" },
  };
  // Two problems: the path set changed and the reviewed node is gone.
  expect("a relocated reviewed minimatch path fails the graph", lockfileGraphProblems(relocated).length, 2);

  const upgradedReviewedNode = validPackages();
  upgradedReviewedNode["node_modules/eslint-plugin-import-x/node_modules/minimatch"] = {
    version: "11.0.1",
    dev: true,
    dependencies: { "@isaacs/nonrecursive-glob-match": "^1.0.1", "brace-expansion": "^5.0.12" },
  };
  expect(
    "a 10.2.6 node upgraded in place fails the graph",
    lockfileGraphProblems(upgradedReviewedNode).length,
    1,
  );

  const driftedPatchedVersion = validPackages();
  driftedPatchedVersion["node_modules/minimatch"].version = "11.0.2";
  expect(
    "a drifted patched minimatch version fails the graph",
    lockfileGraphProblems(driftedPatchedVersion).length,
    1,
  );

  const driftedRange = validPackages();
  driftedRange["node_modules/minimatch"].dependencies["brace-expansion"] = "^5.0.7";
  expect("a drifted minimatch range fails the graph", lockfileGraphProblems(driftedRange).length, 1);

  const driftedParent = validPackages();
  driftedParent["node_modules/eslint"].dependencies.minimatch = "^10.2.4";
  expect("a drifted minimatch parent fails the graph", lockfileGraphProblems(driftedParent).length, 1);

  const fifthParent = validPackages();
  fifthParent["node_modules/eslint-plugin-unicorn"] = { version: "80.0.0", dependencies: { minimatch: "^10.0.0" } };
  expect("a fifth minimatch parent fails the graph", lockfileGraphProblems(fifthParent).length, 1);

  const productionMinimatch = validPackages();
  productionMinimatch["node_modules/minimatch"].dev = false;
  expect("a production minimatch fails the graph", lockfileGraphProblems(productionMinimatch).length, 1);

  const productionPatched = validPackages();
  productionPatched["node_modules/eslint-plugin-import-x/node_modules/minimatch"].dev = false;
  expect("a production reviewed minimatch fails the graph", lockfileGraphProblems(productionPatched).length, 1);

  const runtimeDependency = validPackages();
  runtimeDependency[""] = { dependencies: { minimatch: "^11.0.1" } };
  // Two problems: minimatch is now a runtime dependency and the root package
  // joins the minimatch parent set.
  expect(
    "a runtime minimatch dependency fails the graph",
    lockfileGraphProblems(runtimeDependency).length,
    2,
  );

  const braceDrift = validPackages();
  braceDrift["node_modules/brace-expansion"].version = "5.0.13";
  expect("a drifted brace-expansion version fails the graph", lockfileGraphProblems(braceDrift).length, 1);

  expect("the reviewed override map passes", overrideProblems({ overrides: expectation.overrides }).length, 0);
  expect("a missing override map fails", overrideProblems({}).length, 1);
  expect(
    "a dropped override fails",
    overrideProblems({ overrides: { minimatch: "11.0.1" } }).length,
    1,
  );
  const revertedOverride = JSON.parse(JSON.stringify(expectation.overrides));
  revertedOverride["eslint-plugin-import-x"].minimatch = "11.0.1";
  expect("an override that would break import-x fails", overrideProblems({ overrides: revertedOverride }).length, 1);

  expect("an empty results array has no problems", collectOsvFindings({ results: [] }).problems.length, 0);
  expect("a missing results array is a problem", collectOsvFindings({}).problems.length, 1);
  expect("a non-object report is a problem", collectOsvFindings(null).problems.length, 1);
  expect("a null result entry is a problem", collectOsvFindings({ results: [null] }).problems.length, 1);
  expect(
    "a string-valued packages list is a problem",
    collectOsvFindings({ results: [{ packages: "nope" }] }).problems.length,
    1,
  );
  expect(
    "a string-valued vulnerabilities list is a problem",
    collectOsvFindings({ results: [{ packages: [{ vulnerabilities: "nope" }] }] }).problems.length,
    1,
  );
  expect(
    "a null vulnerability entry is a problem",
    collectOsvFindings({ results: [{ packages: [{ vulnerabilities: [null] }] }] }).problems.length,
    1,
  );
  expect("a result with no packages has no problems", collectOsvFindings({ results: [{}] }).problems.length, 0);

  const osvResult = (lockfile) => ({ source: { path: lockfile } });
  const osvPkg = (name, version) => ({ package: { ecosystem: "npm", name, version } });
  const reviewedVuln = { id: E4.advisories[0].id, aliases: [E4.advisories[0].alias] };
  const expectOsv = (label, result, pkg, vuln, lockfile, expected) =>
    cases.push({
      label,
      actual: osvMatchingException(result, pkg, vuln, lockfile) !== null,
      expected,
    });

  expectOsv(
    "osv E4 real shape matches",
    osvResult(canonical),
    osvPkg("minimatch", "10.2.6"),
    reviewedVuln,
    canonical,
    true,
  );
  expectOsv(
    "osv E4 real shape matches from an absolute source path",
    osvResult(`/repo/${canonical}`),
    osvPkg("minimatch", "10.2.6"),
    reviewedVuln,
    canonical,
    true,
  );
  expectOsv(
    "osv a different advisory fails",
    osvResult(canonical),
    osvPkg("minimatch", "10.2.6"),
    { id: "GHSA-0000-0000-0000", aliases: [E4.advisories[0].alias] },
    canonical,
    false,
  );
  expectOsv(
    "osv a drifted alias fails",
    osvResult(canonical),
    osvPkg("minimatch", "10.2.6"),
    { id: E4.advisories[0].id, aliases: [] },
    canonical,
    false,
  );
  expectOsv(
    "osv a different minimatch version fails",
    osvResult(canonical),
    osvPkg("minimatch", "10.2.5"),
    reviewedVuln,
    canonical,
    false,
  );
  expectOsv(
    "osv a different patched version fails",
    osvResult(canonical),
    osvPkg("minimatch", "11.0.0"),
    reviewedVuln,
    canonical,
    false,
  );
  expectOsv(
    "osv a different package fails",
    osvResult(canonical),
    osvPkg("brace-expansion", "5.0.12"),
    reviewedVuln,
    canonical,
    false,
  );
  expectOsv(
    "osv a different lockfile fails",
    osvResult("cdk/package-lock.json"),
    osvPkg("minimatch", "10.2.6"),
    reviewedVuln,
    "cdk/package-lock.json",
    false,
  );
  expectOsv(
    "osv a non-npm ecosystem fails",
    osvResult(canonical),
    { package: { ecosystem: "Go", name: "minimatch", version: "10.2.6" } },
    reviewedVuln,
    canonical,
    false,
  );

  expect("the exception is below its patched floor", compareVersionStrings(E4.packageVersion, E4.patchedFloor) < 0, true);
  expect("the fixture clock is before recheck_by", recheckExpired("2026-11-01T23:59:59Z", E4.recheckBy), false);
  expect("the recheck_by boundary expires", recheckExpired("2026-12-01T00:00:00Z", E4.recheckBy), true);
  expect("a later clock expires", recheckExpired("2026-12-02T00:00:00Z", E4.recheckBy), true);

  expect("the reviewed lockfile has no local removal reason", e4RemovalReasons(validPackages()).length, 0);
  const upgradedNode = validPackages();
  upgradedNode["node_modules/eslint-plugin-import-x/node_modules/minimatch"] = { version: "11.0.1", dev: true };
  expect("an in-place upgrade meets the removal condition", e4RemovalReasons(upgradedNode).length, 1);
  const missingNode = validPackages();
  delete missingNode["node_modules/eslint-plugin-import-x/node_modules/minimatch"];
  expect("a removed reviewed node meets the removal condition", e4RemovalReasons(missingNode).length, 1);

  const registry = (latestParentVersion, minimatchRange, publishedPatchedMinimatch = ["11.0.1", "11.0.3"]) =>
    e4RegistryRemovalReasons({ latestParentVersion, minimatchRange, publishedPatchedMinimatch });

  expect("import-x still on ^9 || ^10 does not meet removal", registry("4.17.1", "^9.0.3 || ^10.1.2").length, 0);
  expect("import-x accepting ^11 meets removal", registry("5.0.0", "^11.0.0").length, 1);
  expect("import-x accepting >=11 meets removal", registry("5.0.0", ">=11.0.1").length, 1);
  expect("import-x accepting * meets removal", registry("5.0.0", "*").length, 1);
  expect("import-x accepting ~11.0.1 meets removal", registry("5.0.0", "~11.0.1").length, 1);
  expect("import-x accepting 11.x meets removal", registry("5.0.0", "11.x").length, 1);
  expect("import-x dropped minimatch entirely meets removal", registry("5.0.0", null).length, 1);
  expect("an unknown latest import-x does not meet removal", registry(null, null).length, 0);
  expect(
    "import-x accepting only 12.x does not meet removal for published 11.x",
    registry("5.0.0", "^12.0.0", ["11.0.1", "11.0.3"]).length,
    0,
  );

  const rangeCases = [
    ["^9.0.3 || ^10.1.2", "11.0.1", false],
    ["^10.2.5", "11.0.1", false],
    ["^11.0.0", "11.0.1", true],
    ["^11", "11.0.1", true],
    ["^0.5.0", "11.0.1", false],
    ["~11.0.1", "11.0.1", true],
    [">=11.0.1", "11.0.1", true],
    [">11.0.1", "11.0.1", false],
    ["<11.0.1", "11.0.1", false],
    ["<=11.0.1", "11.0.1", true],
    ["11.0.1", "11.0.1", true],
    ["11.0.0", "11.0.1", false],
    ["10.x", "11.0.1", false],
    ["11.x", "11.0.1", true],
    ["1.0.0 - 2.0.0", "11.0.1", false],
  ];
  for (const [range, version, expected] of rangeCases) {
    let actual;
    try {
      actual = versionSatisfiesRange(version, range);
    } catch (err) {
      actual = `error: ${err.message}`;
    }
    expect(`semver range ${JSON.stringify(range)} admits ${version}`, actual, expected);
  }
  expect("stableVersionsAtLeast drops prereleases", stableVersionsAtLeast(["11.0.1", "11.0.2-rc.1", "10.0.0"], "11.0.1").length, 1);

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
  console.log(
    `self-test: PASS (${cases.length} cases; reviewed minimatch graph, override map, exception matcher, recheck_by, removal conditions, semver ranges)`,
  );
  return 0;
}

if (selfTest) {
  process.exit(runSelfTest());
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const report = readJson(reportPath, "scanner report");
  const lock = readJson(lockfilePath, "lockfile");
  const packages = lock.packages ?? {};
  const canonicalLockfile = canonicalLockfilePath(lockfilePath);
  const inScope = E4.lockfiles.includes(canonicalLockfile);

  if (!inScope) {
    fail(`lockfile ${canonicalLockfile} is outside the reviewed TypeScript lint-tool scope`);
  }

  // Hard recheck deadline: enforced before anything can be excused.
  const nowIso = new Date().toISOString();
  if (recheckExpired(nowIso, E4.recheckBy)) {
    fail(
      `reviewed exception ${E4.exceptionId} reached its recheck_by deadline ${E4.recheckBy}; re-review and remove or renew it before the gate can pass`,
    );
  }

  // Lockfile-local removal probe, before the graph anchors, so an upgraded node
  // yields the actionable "remove the exception" message instead of a generic
  // graph-drift failure.
  const localRemovalReasons = e4RemovalReasons(packages);
  if (localRemovalReasons.length > 0) {
    for (const reason of localRemovalReasons) {
      console.error(`osv-scanner: exception removal condition met - ${reason}`);
    }
    fail("reviewed TypeScript dependency-audit exception removal condition met; remove the exception before the gate can pass");
  }

  // Fail-closed integrity anchors: the exact reviewed graph and the reviewed
  // override map that produces it.
  const packageJsonPath = path.join(path.dirname(lockfilePath), "package.json");
  const packageJson = readJson(packageJsonPath, "package.json");
  const graphProblems = [...lockfileGraphProblems(packages), ...overrideProblems(packageJson)];
  if (graphProblems.length > 0) {
    for (const problem of graphProblems) {
      console.error(`osv-scanner: ${problem}`);
    }
    fail("lockfile graph no longer matches the reviewed TypeScript lint-tool minimatch graph");
  }

  // Registry-backed removal probe: unconditional, so a stale exception cannot
  // survive by simply never matching a finding again.
  const removalReasons = await e4RemovalProbe();
  if (removalReasons.length > 0) {
    for (const reason of removalReasons) {
      console.error(`osv-scanner: exception removal condition met - ${reason}`);
    }
    fail("reviewed TypeScript dependency-audit exception removal condition met; remove the exception before the gate can pass");
  }

  const { entries, findings, problems } = collectOsvFindings(report);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`osv-scanner: ${problem}`);
    }
    fail("OSV report shape is not one this gate can evaluate");
  }

  const unexpected = [];
  const applied = [];
  for (const [index, finding] of findings.entries()) {
    const entry = entries[index];
    const exception = osvMatchingException(entry.result, entry.pkg, entry.vuln, canonicalLockfile);
    if (exception === null) {
      unexpected.push(finding);
    } else {
      applied.push(finding);
    }
  }

  if (unexpected.length > 0) {
    for (const vuln of unexpected) {
      console.error(
        `osv-scanner: unexpected vulnerability ${vuln.id} in ${vuln.packageName}@${vuln.version} from ${vuln.source} (fixed versions: ${JSON.stringify(vuln.fixedVersions)})`,
      );
    }
    fail("TypeScript lint-tool findings outside the reviewed dependency-audit exception");
  }

  if (applied.length > 0) {
    console.log(
      `exception-applied: ${E4.exceptionId} advisories=${E4.advisories
        .map((advisory) => advisory.id)
        .join(",")} findings=${applied.length}`,
    );
    console.error(
      `osv-scanner: WARN ${JSON.stringify({
        recordType: "reviewed-vulnerability-exception",
        exceptionId: E4.exceptionId,
        advisoryIds: E4.advisories.map((advisory) => advisory.id),
        operatorRuling: E4.operatorRuling,
        recheckBy: E4.recheckBy,
        removalCondition: E4.removalCondition,
        lockfile: canonicalLockfile,
        package: {
          name: E4.packageName,
          path: E4.packagePath,
          version: E4.packageVersion,
        },
        parent: E4.parent,
        devOnlyEvidence: E4.devOnlyEvidence,
      })}`,
    );
  }

  console.error(
    `osv-scanner: PASS ${JSON.stringify({
      recordType: "verified-patched-dependency-graph",
      checkId: expectation.checkId,
      lockfile: canonicalLockfile,
      reviewedExceptions: applied.length > 0 ? [E4.exceptionId] : [],
      justification:
        "The TypeScript lint stack uses minimatch 11.0.1 everywhere except eslint-plugin-import-x, which keeps 10.2.6 under the reviewed, self-expiring dev-only exception.",
      provenance: {
        braceExpansion: {
          path: expectation.braceExpansion.path,
          version: expectation.braceExpansion.version,
        },
        minimatch: {
          reviewed: {
            path: expectation.minimatchReviewed.path,
            version: expectation.minimatchReviewed.version,
          },
          patched: {
            paths: expectation.minimatchPatched.paths,
            version: expectation.minimatchPatched.version,
          },
        },
        minimatchParents: expectation.minimatchParents,
        overrides: expectation.overrides,
      },
    })}`,
  );
}

await main();
