// Purpose: fail when a dependency in the CDK lockfile set declares an
// engines.node range that excludes the CDK Node floor.
//
// ===========================================================================
// Floor semantics
// ===========================================================================
// cdk/package.json declares the CDK Node floor as an exact `>=N` major claim,
// so this checker reads the floor from that manifest instead of hardcoding it.
// The matching CI leg installs the newest Node N.x release, which makes the
// floor runtime the whole `N.x` line: a dependency passes only when its
// declared engines.node range admits at least one Node N.x *release*.
//
//   floor >=22 | engines >=22                  -> pass
//   floor >=22 | engines ^22.13.0              -> pass (22.13.x is a 22.x)
//   floor >=22 | engines 18 || 20 || >=22      -> pass
//   floor >=22 | engines >=24                  -> FAIL
//   floor >=22 | engines ^20.19.0 || >=24      -> FAIL
//   floor >=22 | engines >=23.0.0-0            -> FAIL (sorts above every 22.x release)
//   floor >=22 | engines =22.13.0-rc.1         -> FAIL (a prerelease is not a release)
//   floor >=22 | engines >22.0.0 <22.0.1       -> FAIL (no release lies between them)
//   floor >=20 | engines >=22                  -> FAIL (the stream-chain case)
//
// Bounds are intersected in release space (see "release-space intersection"
// below), so a range anchored only on a prerelease of a later line - or wedged
// between two adjacent releases - is never credited with a floor-line release
// it does not admit.
//
// The matcher below is deliberately self-contained: a dependency gate must not
// depend on a transitive npm package, and it must model every range it can
// meet rather than skip the ones it cannot. Any range grammar it does not
// model fails the gate outright.
//
// ===========================================================================
// Scope
// ===========================================================================
// Dependency entries (node_modules/**) in cdk/package-lock.json plus every
// examples/cdk/*/package-lock.json - the same lockfile set
// gov-verify-rubric.sh's osv_scan_lockfile routes to the aws-cdk checker.
// Positional arguments replace that set, which is how the negative proof
// drives the checker with a synthetic lockfile.
//
// A lockfile's own root entry ("") is the project's declared floor rather than
// an upstream dependency. The fleet rule is one rule for every root: it must
// DECLARE engines.node, and the declaration must not admit a Node release below
// the CDK floor. Declaring a floor above the CDK floor is legitimate. An absent
// declaration fails closed here as an unjudged floor - no other gate owns it,
// because scripts/verify-runtime-floor-claims.sh only compares cdk/package.json
// with the cdk lockfile root and never reads examples/.
//
// There is no exception list and no waiver flag: every dependency entry with a
// declared engines.node must admit the floor, or the gate fails.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CDK_MANIFEST = "cdk/package.json";
const CDK_LOCKFILE = "cdk/package-lock.json";
const EXAMPLE_LOCKFILE_DIR = path.join("examples", "cdk");

function fail(message) {
  console.error(`cdk-engines-floor: FAIL (${message})`);
  process.exit(1);
}

function readJson(relativePath, description) {
  return readJsonFile(path.join(repositoryRoot, relativePath), description, relativePath);
}

function readJsonFile(absolutePath, description, label) {
  let text;
  try {
    text = fs.readFileSync(absolutePath, "utf8");
  } catch (err) {
    fail(`could not read ${description} ${label}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`could not parse ${description} ${label}: ${err.message}`);
  }
}

// === floor =================================================================

function readFloorMajor() {
  const manifest = readJson(CDK_MANIFEST, "CDK manifest");
  const spec = manifest?.engines?.node;
  if (typeof spec !== "string") {
    fail(`${CDK_MANIFEST} must declare engines.node as a string`);
  }
  const match = /^\s*>=\s*(\d+)(?:\.\d+){0,2}\s*$/.exec(spec);
  if (match === null) {
    fail(
      `${CDK_MANIFEST} engines.node must use an exact >=N Node major floor, found ${JSON.stringify(spec)}`,
    );
  }
  return { major: Number(match[1]), spec };
}

// === semver range support ==================================================

class UnmodelledRange extends Error {}

// Grammar the matcher deliberately does not model, including the legacy `~>`
// tilde alias. npm has no `~>` operator - it is a RubyGems-ism that reaches
// lockfiles through hand-authored engine claims - so it must fail the gate
// closed rather than be skipped or silently widened.
const UNMODELLED_CASES = ["~>3.0.0", "~> 3.0.0", "lts/*", "nightly", ">=22 || ^foo", ">=20 || lts/*"];

const PARTIAL_RE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parsePartial(raw) {
  const match = PARTIAL_RE.exec(raw.trim());
  if (match === null) return null;
  const component = (value) => {
    if (value === undefined || /^[xX*]$/.test(value)) return null;
    return Number(value);
  };
  const major = component(match[1]);
  const minor = component(match[2]);
  const patch = component(match[3]);
  const prerelease = match[4] ?? null;
  if (major === null) {
    // `*`, `x`, `X` and `v*` leave the major unconstrained.
    if (minor !== null || patch !== null || prerelease !== null) return null;
    return { any: true };
  }
  const wildcarded = minor === null || patch === null;
  if (wildcarded && prerelease !== null) return null;
  return {
    any: false,
    major,
    minor: minor ?? 0,
    patch: patch === null ? 0 : patch,
    prerelease,
    minorWildcard: minor === null,
    patchWildcard: minor !== null && patch === null,
  };
}

// A concrete version for comparisons: partial components already default to 0.
function concrete(version) {
  return {
    major: version.major,
    minor: version.minor,
    patch: version.patch,
    prerelease: version.prerelease ?? null,
  };
}

function bump(version, level) {
  if (level === "major") return { major: version.major + 1, minor: 0, patch: 0, prerelease: null };
  if (level === "minor") return { major: version.major, minor: version.minor + 1, patch: 0, prerelease: null };
  return { major: version.major, minor: version.minor, patch: version.patch + 1, prerelease: null };
}

function comparePrerelease(a, b) {
  const left = a.split(".");
  const right = b.split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);
    if (lNumeric && rNumeric) {
      if (Number(l) !== Number(r)) return Number(l) < Number(r) ? -1 : 1;
      continue;
    }
    if (lNumeric !== rNumeric) return lNumeric ? -1 : 1;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function maxLower(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  const order = compareVersions(a.version, b.version);
  if (order > 0) return a;
  if (order < 0) return b;
  return { version: a.version, inclusive: a.inclusive && b.inclusive };
}

function minUpper(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  const order = compareVersions(a.version, b.version);
  if (order < 0) return a;
  if (order > 0) return b;
  return { version: a.version, inclusive: a.inclusive && b.inclusive };
}

function applyXRange(version, bounds) {
  if (version.minorWildcard) {
    bounds.lower = maxLower(bounds.lower, { version: concrete(version), inclusive: true });
    bounds.upper = minUpper(bounds.upper, { version: bump(version, "major"), inclusive: false });
    return;
  }
  if (version.patchWildcard) {
    bounds.lower = maxLower(bounds.lower, { version: concrete(version), inclusive: true });
    bounds.upper = minUpper(bounds.upper, { version: bump(version, "minor"), inclusive: false });
    return;
  }
  bounds.lower = maxLower(bounds.lower, { version: concrete(version), inclusive: true });
  bounds.upper = minUpper(bounds.upper, { version: concrete(version), inclusive: true });
}

function caretUpper(version) {
  if (version.major > 0 || version.minorWildcard) return bump(version, "major");
  if (version.minor > 0 || version.patchWildcard) return bump(version, "minor");
  return bump(version, "patch");
}

function applyComparator(rawToken, bounds) {
  const token = rawToken.trim();
  if (token === "" || token === "*" || /^[xX]$/.test(token)) return;

  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token);
  if (match === null) throw new UnmodelledRange(token);
  const operator = match[1] ?? "";
  const version = parsePartial(match[2]);
  if (version === null) throw new UnmodelledRange(token);
  if (version.any) {
    if (operator === "" || operator === "=") return;
    throw new UnmodelledRange(token);
  }

  const lower = (candidate, inclusive) => {
    bounds.lower = maxLower(bounds.lower, { version: candidate, inclusive });
  };
  const upper = (candidate, inclusive) => {
    bounds.upper = minUpper(bounds.upper, { version: candidate, inclusive });
  };

  switch (operator) {
    case ">=":
      lower(concrete(version), true);
      return;
    case ">":
      if (version.minorWildcard) lower(bump(version, "major"), true);
      else if (version.patchWildcard) lower(bump(version, "minor"), true);
      else lower(concrete(version), false);
      return;
    case "<=":
      if (version.minorWildcard) upper(bump(version, "major"), false);
      else if (version.patchWildcard) upper(bump(version, "minor"), false);
      else upper(concrete(version), true);
      return;
    case "<":
      upper(concrete(version), false);
      return;
    case "=":
    case "":
      applyXRange(version, bounds);
      return;
    case "^":
      lower(concrete(version), true);
      upper(caretUpper(version), false);
      return;
    case "~":
      lower(concrete(version), true);
      upper(version.minorWildcard ? bump(version, "major") : bump(version, "minor"), false);
      return;
    default:
      throw new UnmodelledRange(token);
  }
}

function applyHyphen(leftText, rightText, bounds) {
  const lowerVersion = parsePartial(leftText);
  const upperVersion = parsePartial(rightText);
  if (lowerVersion === null || upperVersion === null || lowerVersion.any || upperVersion.any) {
    throw new UnmodelledRange(`${leftText} - ${rightText}`);
  }
  bounds.lower = maxLower(bounds.lower, { version: concrete(lowerVersion), inclusive: true });
  if (upperVersion.minorWildcard) {
    bounds.upper = minUpper(bounds.upper, { version: bump(upperVersion, "major"), inclusive: false });
  } else if (upperVersion.patchWildcard) {
    bounds.upper = minUpper(bounds.upper, { version: bump(upperVersion, "minor"), inclusive: false });
  } else {
    bounds.upper = minUpper(bounds.upper, { version: concrete(upperVersion), inclusive: true });
  }
}

function branchBounds(rawBranch) {
  // `>= 4.0.0` and `>=4.0.0` are the same range; glue the operator back onto its
  // version so whitespace splitting only separates comparator sets.
  const text = rawBranch.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").trim();
  const bounds = { lower: null, upper: null };
  if (text === "" || text === "*" || /^[xX]$/.test(text)) return bounds;

  const hyphen = /^([^\s]+)\s+-\s+([^\s]+)$/.exec(text);
  if (hyphen !== null) {
    applyHyphen(hyphen[1], hyphen[2], bounds);
    return bounds;
  }

  for (const token of text.split(/\s+/)) applyComparator(token, bounds);
  return bounds;
}

// Every branch is parsed before any of them is evaluated, so an unmodelled
// branch fails the gate even when an earlier branch already admits the floor;
// strictness must not depend on the order of the alternatives.
function parseBranches(rawRange) {
  return String(rawRange)
    .split("||")
    .map((branch) => branchBounds(branch));
}

// === release-space intersection ============================================
// A band is a pair of version bounds; `null` means unbounded on that side. The
// bounds are compared over concrete releases, so a prerelease bound collapses
// to the release edge it delimits:
//   lower `23.0.0-x` inclusive -> `23.0.0` inclusive (23.0.0 is the first release >= it)
//   lower `23.0.0-x` exclusive -> `23.0.0` inclusive (23.0.0 is the first release > it)
//   upper `23.0.0-x` inclusive -> `23.0.0` exclusive (no release <= it reaches 23.0.0)
//   upper `23.0.0-x` exclusive -> `23.0.0` exclusive (no release lies between them)
//
// Without this collapse, raw bound comparison credits a range such as
// `>=23.0.0-0` with an intersection against the 22.x line: 23.0.0-0 sorts
// below 23.0.0, so the interval [23.0.0-0, 23.0.0) looks non-empty even though
// it contains no release at all, let alone a 22.x one.

function toReleaseLower(bound) {
  if (bound === null || bound.version.prerelease === null) return bound;
  return { version: { ...bound.version, prerelease: null }, inclusive: true };
}

function toReleaseUpper(bound) {
  if (bound === null || bound.version.prerelease === null) return bound;
  return { version: { ...bound.version, prerelease: null }, inclusive: false };
}

const ZERO_RELEASE = { major: 0, minor: 0, patch: 0, prerelease: null };

// Smallest concrete release admitted by an already-normalized lower bound.
function firstRelease(lower) {
  if (lower.inclusive) return lower.version;
  return bump(lower.version, "patch");
}

// True when at least one concrete release satisfies both the range bounds and
// the band.
function bandAdmitsRelease(bounds, band) {
  const lower = maxLower(toReleaseLower(bounds.lower), toReleaseLower(band.lower));
  const upper = minUpper(toReleaseUpper(bounds.upper), toReleaseUpper(band.upper));
  if (upper === null) return true;
  if (lower === null) {
    // The band's upper edge is itself a release, so it witnesses the band
    // unless it is exclusive at the 0.0.0 floor.
    return upper.inclusive || compareVersions(upper.version, ZERO_RELEASE) > 0;
  }
  const order = compareVersions(firstRelease(lower), upper.version);
  return upper.inclusive ? order <= 0 : order < 0;
}

// True when the declared range admits at least one release on the floor's
// major line, i.e. when a release in [floorMajor.0.0, (floorMajor + 1).0.0)
// satisfies it.
function rangeAdmitsFloorMajor(rawRange, floorMajor) {
  const band = {
    lower: { version: { major: floorMajor, minor: 0, patch: 0, prerelease: null }, inclusive: true },
    upper: { version: { major: floorMajor + 1, minor: 0, patch: 0, prerelease: null }, inclusive: false },
  };
  return parseBranches(rawRange).some((bounds) => bandAdmitsRelease(bounds, band));
}

// True when the declared range admits a release below the floor line, i.e.
// when a release in [0.0.0, floorMajor.0.0) satisfies it. This is the
// project-floor rule: a floor claim that admits a Node release the CDK floor
// no longer supports is drift.
function rangeAdmitsBelowFloorMajor(rawRange, floorMajor) {
  const band = {
    lower: null,
    upper: { version: { major: floorMajor, minor: 0, patch: 0, prerelease: null }, inclusive: false },
  };
  return parseBranches(rawRange).some((bounds) => bandAdmitsRelease(bounds, band));
}

// === lockfile set ==========================================================

function defaultLockfiles() {
  const examplesDir = path.join(repositoryRoot, EXAMPLE_LOCKFILE_DIR);
  let entries = [];
  try {
    entries = fs.readdirSync(examplesDir, { withFileTypes: true });
  } catch (err) {
    fail(`could not read ${EXAMPLE_LOCKFILE_DIR}: ${err.message}`);
  }
  const examples = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(EXAMPLE_LOCKFILE_DIR, entry.name, "package-lock.json"))
    .filter((relative) => fs.existsSync(path.join(repositoryRoot, relative)))
    .sort();
  if (examples.length === 0) {
    fail(`expected at least one ${EXAMPLE_LOCKFILE_DIR}/*/package-lock.json example lockfile`);
  }
  return [CDK_LOCKFILE, ...examples].map((relative) => ({
    absolute: path.join(repositoryRoot, relative),
    label: relative.split(path.sep).join("/"),
  }));
}

// Positional arguments replace the audit-scanner lockfile set so the negative
// proof can point the checker at a synthetic lockfile. Every lockfile is still
// judged by the same rules; there is no way to exempt one.
function resolveLockfileArgument(value) {
  const absolute = path.isAbsolute(value) ? value : path.join(repositoryRoot, value);
  const relative = path.relative(repositoryRoot, absolute).split(path.sep).join("/");
  // Out-of-tree lockfiles (the synthetic negative-proof case) read better as
  // absolute paths than as a wall of "../".
  const label = relative === "" || relative.startsWith("../") ? absolute : relative;
  return { absolute, label };
}

// === scan ==================================================================

function judge(declared, predicate, label, packagePath) {
  try {
    return predicate(declared);
  } catch (err) {
    if (err instanceof UnmodelledRange) {
      fail(
        `${label} ${packagePath || "<root>"} declares engines.node ${JSON.stringify(declared)}, ` +
          `which scripts/check-cdk-engines-floor.mjs does not model (${err.message}); ` +
          "extend the matcher - ranges are never skipped",
      );
    }
    throw err;
  }
}

function scanLockfile(lockfile, floorMajor) {
  const { absolute, label } = lockfile;
  const packages = readJsonFile(absolute, "lockfile", label)?.packages;
  if (packages === undefined || typeof packages !== "object" || packages === null) {
    fail(`${label} is missing its packages map`);
  }

  const result = { checked: 0, projectFloors: 0, projectFloorsAbsent: 0, violations: [] };
  for (const [packagePath, entry] of Object.entries(packages)) {
    const declared = entry?.engines?.node;
    if (packagePath === "") {
      // The lockfile's own project floor, not an upstream dependency.
      if (declared === undefined || declared === null) {
        // An absent root declaration is an unjudged floor, so it fails closed:
        // every root must state the floor it supports.
        result.projectFloorsAbsent += 1;
        result.violations.push({
          kind: "project-absent",
          lockfile: label,
          packagePath,
          version: null,
          declared: null,
        });
        continue;
      }
      if (typeof declared !== "string") {
        fail(`${label} <root> engines.node is not a string`);
      }
      result.projectFloors += 1;
      const belowFloor = judge(
        declared,
        (range) => rangeAdmitsBelowFloorMajor(range, floorMajor),
        label,
        packagePath,
      );
      if (belowFloor) {
        result.violations.push({
          kind: "project",
          lockfile: label,
          packagePath,
          version: null,
          declared,
        });
      }
      continue;
    }

    if (declared === undefined || declared === null) continue;
    if (typeof declared !== "string") {
      fail(`${label} ${packagePath} engines.node is not a string`);
    }
    result.checked += 1;
    const admits = judge(declared, (range) => rangeAdmitsFloorMajor(range, floorMajor), label, packagePath);
    if (!admits) {
      result.violations.push({
        kind: "dependency",
        lockfile: label,
        packagePath,
        version: entry?.version ?? "<unknown>",
        declared,
      });
    }
  }
  return result;
}

function describeViolation(violation, floorMajor, floorSpec) {
  if (violation.kind === "project-absent") {
    return (
      `cdk-engines-floor: project floor absent in ${violation.lockfile} <root>, which declares no engines.node, ` +
      `so the ${CDK_MANIFEST} floor ${JSON.stringify(floorSpec)} (Node ${floorMajor}.0.0) is unjudged`
    );
  }
  if (violation.kind === "project") {
    return (
      `cdk-engines-floor: project floor ${JSON.stringify(violation.declared)} in ${violation.lockfile} ` +
      `admits a Node release below ${floorMajor}.0.0 (the ${CDK_MANIFEST} floor ${JSON.stringify(floorSpec)})`
    );
  }
  return (
    `cdk-engines-floor: unexpected engines.node ${JSON.stringify(violation.declared)} in ` +
    `${violation.packagePath}@${violation.version} from ${violation.lockfile} ` +
    `(excludes Node ${floorMajor}.x, the ${CDK_MANIFEST} floor ${JSON.stringify(floorSpec)})`
  );
}

function runSelfTest() {
  const FLOOR = 22;
  const matcherCases = [
    // Ranges that admit the floor major.
    ["*", FLOOR, true],
    ["x", FLOOR, true],
    [">=22", FLOOR, true],
    [">=22.0.0", FLOOR, true],
    [">= 22.0.0", FLOOR, true],
    [">=20", FLOOR, true],
    [">= 0.4", FLOOR, true],
    [">= 4", FLOOR, true],
    [">=16.20.0", FLOOR, true],
    [">= 20.16.0", FLOOR, true],
    [">=21", FLOOR, true],
    [">21", FLOOR, true],
    ["<=22", FLOOR, true],
    ["<=22.0.0", FLOOR, true],
    ["<23", FLOOR, true],
    ["<23.0.0", FLOOR, true],
    ["22.x", FLOOR, true],
    ["22.4.x", FLOOR, true],
    ["=22.0.0", FLOOR, true],
    ["22.0.0", FLOOR, true],
    ["22", FLOOR, true],
    ["22.0", FLOOR, true],
    ["^22.13.0", FLOOR, true],
    ["^20.19.0 || ^22.13.0 || >=24", FLOOR, true],
    ["^18.18.0 || ^20.9.0 || >=21.1.0", FLOOR, true],
    ["^20.10.0 || >=21.0.0", FLOOR, true],
    ["18 || 20 || >=22", FLOOR, true],
    ["20 || >=22", FLOOR, true],
    ["^14.17.0 || ^16.0.0 || >=18.0.0", FLOOR, true],
    ["^12.22.0 || ^14.17.0 || >=16.0.0", FLOOR, true],
    ["6.* || 8.* || >= 10.*", FLOOR, true],
    [">=6 <7 || >=8", FLOOR, true],
    ["^6 || ^7 || ^8 || ^9 || ^10 || ^11 || ^12 || >=13.7", FLOOR, true],
    ["~22.1.0", FLOOR, true],
    ["21 - 22", FLOOR, true],
    ["20.1 - 22.3.4", FLOOR, true],
    ["22.0.0 - 22.0.5", FLOOR, true],
    ["1 - 22", FLOOR, true],
    [">=22.13.0-0", FLOOR, true],
    ["<24.0.0", FLOOR, true],
    ["^20.19.0 || ^22.13.0 || >=24.0.0", FLOOR, true],
    // Ranges that exclude the floor major.
    [">=24", FLOOR, false],
    [">24", FLOOR, false],
    ["^24.0.0", FLOOR, false],
    ["24.x", FLOOR, false],
    ["^20.19.0 || >=24", FLOOR, false],
    ["^20.19.0 || ^23.0.0 || >=24", FLOOR, false],
    [">=26", FLOOR, false],
    ["<22", FLOOR, false],
    ["<=21", FLOOR, false],
    ["<=21.9", FLOOR, false],
    ["<22.0.0", FLOOR, false],
    ["18 || 20", FLOOR, false],
    [">=6 <7", FLOOR, false],
    ["^6 || ^7 || ^8", FLOOR, false],
    ["0.10.x", FLOOR, false],
    ["^0.2.3", FLOOR, false],
    ["23.x", FLOOR, false],
    ["21 - 21.9", FLOOR, false],
    ["18.0.0 - 20.19.5", FLOOR, false],
    // The stream-chain class against the previous floor: this is the drift the
    // gate exists to catch.
    [">=22", 20, false],
    [">=20", 20, true],
    [">= 20.16.0", 20, true],
    [">=24", 22, false],
    // A range anchored only on a prerelease of the line above the floor admits
    // no floor release: a prerelease sorts below its own release but above
    // every release of the previous line.
    [">=23.0.0-0", FLOOR, false],
    ["23.0.0-0", FLOOR, false],
    ["=23.0.0-rc.0", FLOOR, false],
    ["v23.0.0-0", FLOOR, false],
    ["^23.0.0-alpha", FLOOR, false],
    ["~23.0.0-beta", FLOOR, false],
    [">23.0.0-0", FLOOR, false],
    [">23.0.0-beta.1", FLOOR, false],
    [">=23.0.0-0 <23.0.0", FLOOR, false],
    [">=24.0.0-0 || >=23.0.0-0", FLOOR, false],
    [">=23.0.0-0 || >=24", FLOOR, false],
    // A prerelease is not a release, so pinning to one admits nothing.
    ["=22.13.0-rc.1", FLOOR, false],
    ["22.13.0-rc.1", FLOOR, false],
    ["=22.13.0-rc.1 || <20", FLOOR, false],
    ["^23.0.0-alpha || ^20.19.0", FLOOR, false],
    // Exclusive bounds on adjacent releases admit no release either.
    [">22.0.0 <22.0.1", FLOOR, false],
    ["22.0.0-0 - 22.0.0-1", FLOOR, false],
    ["23.0.0-0 - 23.0.0", FLOOR, false],
    ["1.0.0 - 22.0.0-0", FLOOR, false],
    // Prerelease bounds that do admit floor releases still pass.
    ["", FLOOR, true],
    [">=22.0.0-0", FLOOR, true],
    ["<=23.0.0-0", FLOOR, true],
    ["<23.0.0-0", FLOOR, true],
    [">=22.0.0-0 <23.0.0", FLOOR, true],
    ["22.0.0-0 - 22.0.0", FLOOR, true],
    ["22.0.0 - 22.5.0-0", FLOOR, true],
    [">=23.0.0-0 || >=22.0.0", FLOOR, true],
  ];

  // The project-floor rule: a declared floor is drift only when it admits a
  // release below the CDK floor. A floor anchored on its own line's prerelease
  // admits none, so it must not be flagged.
  const projectFloorCases = [
    [">=22", false],
    [">=22.0.0", false],
    ["22.x", false],
    [">=24", false],
    [">22.0.0", false],
    [">=22.0.0-0", false],
    [">=22.13.0-0", false],
    ["~22.1.0", false],
    ["^22.0.0", false],
    [">=22.0.0 <23.0.0", false],
    ["*", true],
    [">=20", true],
    ["<22", true],
    ["<=21.9", true],
    ["21 - 21.9", true],
    ["18 || 20", true],
    [">=21.0.0-0", true],
    // Admits prereleases of the floor line only: still no release at all.
    [">=22.0.0-0 <22.0.0", false],
  ];

  // Policy probes drive the shipped scanner over synthetic lockfiles, so every
  // rule - including the fail-closed absent-root rule - is exercised through the
  // same code path the gate uses rather than only at the matcher.
  const policyCases = [
    ["dependency anchored only on a later major's prerelease", ">=22", ">=23.0.0-0", true],
    ["dependency pinned to a 22.x prerelease", ">=22", "=22.13.0-rc.1", true],
    ["dependency wedged between adjacent releases", ">=22", ">22.0.0 <22.0.1", true],
    ["dependency admitting the floor through a prerelease bound", ">=22", ">=22.0.0-0", false],
    ["project floor anchored on the floor's own prerelease", ">=22.0.0-0", ">=22", false],
    ["project floor equal to the CDK floor", ">=22", ">=22", false],
    ["project floor with a minor inside the CDK floor line", ">=22.13.0", ">=22", false],
    ["project floor below the CDK floor", ">=20", ">=22", true],
    ["project floor spanning the line below the CDK floor", "^20.19.0 || ^22.13.0", ">=22", true],
    ["project floor above the CDK floor", ">=24", ">=22", false],
    ["no project floor declared", null, ">=22", true],
    ["no project floor declared beside a clean dependency", null, "^22.13.0", true],
  ];

  let failures = 0;
  let cases = 0;

  for (const [range, floor, expected] of matcherCases) {
    cases += 1;
    let actual;
    try {
      actual = rangeAdmitsFloorMajor(range, floor);
    } catch (err) {
      console.error(`  self-test: ${JSON.stringify(range)} at floor ${floor} threw ${err.message}`);
      failures += 1;
      continue;
    }
    if (actual !== expected) {
      console.error(
        `  self-test: ${JSON.stringify(range)} at floor ${floor} expected ${expected}, got ${actual}`,
      );
      failures += 1;
    }
  }

  for (const [range, expected] of projectFloorCases) {
    cases += 1;
    let actual;
    try {
      actual = rangeAdmitsBelowFloorMajor(range, FLOOR);
    } catch (err) {
      console.error(`  self-test: project floor ${JSON.stringify(range)} threw ${err.message}`);
      failures += 1;
      continue;
    }
    if (actual !== expected) {
      console.error(`  self-test: project floor ${JSON.stringify(range)} expected ${expected}, got ${actual}`);
      failures += 1;
    }
  }

  for (const range of UNMODELLED_CASES) {
    cases += 1;
    let refused = false;
    try {
      rangeAdmitsFloorMajor(range, FLOOR);
    } catch (err) {
      if (!(err instanceof UnmodelledRange)) {
        console.error(`  self-test: unmodelled ${JSON.stringify(range)} threw ${err.message}`);
        failures += 1;
        continue;
      }
      refused = true;
    }
    if (!refused) {
      console.error(`  self-test: unmodelled grammar ${JSON.stringify(range)} was accepted`);
      failures += 1;
    }
  }

  const probe = runPolicyProbes(FLOOR, policyCases);
  cases += probe.cases;
  failures += probe.failures;

  if (failures > 0) fail(`self-test failed (${failures} of ${cases} cases)`);
  return cases;
}

function runPolicyProbes(floorMajor, policyCases) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cdk-engines-floor-probe-"));
  let failures = 0;
  try {
    policyCases.forEach(([description, rootEngines, dependencyEngines, expectViolation], index) => {
      const root = { name: "cdk-engines-floor-probe", version: "1.0.0" };
      if (rootEngines !== null) root.engines = { node: rootEngines };
      const packages = {
        "": root,
        "node_modules/probe": { version: "1.0.0", engines: { node: dependencyEngines } },
      };
      const absolute = path.join(directory, `probe-${index}`, "package-lock.json");
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(
        absolute,
        JSON.stringify({ name: "cdk-engines-floor-probe", lockfileVersion: 3, packages }, null, 2),
      );

      let violated;
      try {
        violated = scanLockfile({ absolute, label: `probe-${index}` }, floorMajor).violations.length > 0;
      } catch (err) {
        console.error(`  policy probe: ${description} threw ${err.message}`);
        failures += 1;
        return;
      }
      if (violated !== expectViolation) {
        console.error(`  policy probe: ${description} expected violation=${expectViolation}, got ${violated}`);
        failures += 1;
      }
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return { cases: policyCases.length, failures };
}

function main() {
  const args = process.argv.slice(2);
  const selfTest = args[0] === "--self-test";
  const lockfileArgs = selfTest ? args.slice(1) : args;

  const { major: floorMajor, spec: floorSpec } = readFloorMajor();
  const selfTestCases = selfTest ? runSelfTest() : 0;

  const lockfiles =
    lockfileArgs.length > 0 ? lockfileArgs.map(resolveLockfileArgument) : defaultLockfiles();

  let checked = 0;
  let projectFloors = 0;
  let projectFloorsAbsent = 0;
  const violations = [];
  for (const lockfile of lockfiles) {
    const result = scanLockfile(lockfile, floorMajor);
    checked += result.checked;
    projectFloors += result.projectFloors;
    projectFloorsAbsent += result.projectFloorsAbsent;
    violations.push(...result.violations);
  }

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(describeViolation(violation, floorMajor, floorSpec));
    }
    fail(
      `${violations.length} engine floor violation(s) in ${lockfiles.length} CDK lockfiles against ` +
        `the Node ${floorMajor} floor`,
    );
  }

  const selfTestSummary = selfTest ? `self-test ${selfTestCases} cases; ` : "";
  console.log(
    `cdk-engines-floor: PASS (${selfTestSummary}floor ${JSON.stringify(floorSpec)}; ` +
      `lockfiles ${lockfiles.length}; dependency engine ranges ${checked}; ` +
      `project floors judged ${projectFloors}; project floors absent ${projectFloorsAbsent}; excluded 0)`,
  );
}

main();
