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
// declared engines.node range admits at least one Node N.x release.
//
//   floor >=22 | engines >=22                  -> pass
//   floor >=22 | engines ^22.13.0              -> pass (22.13.x is a 22.x)
//   floor >=22 | engines 18 || 20 || >=22      -> pass
//   floor >=22 | engines >=24                  -> FAIL
//   floor >=22 | engines ^20.19.0 || >=24      -> FAIL
//   floor >=20 | engines >=22                  -> FAIL (the stream-chain case)
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
// an upstream dependency, so it is counted and left unjudged here;
// scripts/verify-runtime-floor-claims.sh is the gate that owns it.
//
// There is no exception list and no waiver flag: every dependency entry with a
// declared engines.node must admit the floor, or the gate fails.
import fs from "node:fs";
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

// True when the declared range admits at least one release on the floor's
// major line, i.e. when it intersects [floorMajor.0.0, (floorMajor + 1).0.0).
//
// Every branch is parsed before any of them is evaluated, so an unmodelled
// branch fails the gate even when an earlier branch already admits the floor;
// strictness must not depend on the order of the alternatives.
function rangeAdmitsFloorMajor(rawRange, floorMajor) {
  const range = String(rawRange);
  if (range.trim() === "") return true;
  const floorLower = { version: { major: floorMajor, minor: 0, patch: 0, prerelease: null }, inclusive: true };
  const floorUpper = { version: { major: floorMajor + 1, minor: 0, patch: 0, prerelease: null }, inclusive: false };

  const branches = range.split("||").map((branch) => branchBounds(branch));
  for (const bounds of branches) {
    const lower = maxLower(bounds.lower, floorLower);
    const upper = minUpper(bounds.upper, floorUpper);
    const order = compareVersions(lower.version, upper.version);
    if (order < 0) return true;
    if (order === 0 && lower.inclusive && upper.inclusive) return true;
  }
  return false;
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

function scanLockfile(lockfile, floorMajor) {
  const { absolute, label } = lockfile;
  const packages = readJsonFile(absolute, "lockfile", label)?.packages;
  if (packages === undefined || typeof packages !== "object" || packages === null) {
    fail(`${label} is missing its packages map`);
  }

  const result = { checked: 0, skippedRoots: 0, violations: [] };
  for (const [packagePath, entry] of Object.entries(packages)) {
    const declared = entry?.engines?.node;
    if (declared === undefined || declared === null) continue;
    if (typeof declared !== "string") {
      fail(`${label} ${packagePath || "<root>"} engines.node is not a string`);
    }
    if (packagePath === "") {
      // The lockfile's own project floor, not an upstream dependency.
      result.skippedRoots += 1;
      continue;
    }

    let admits;
    try {
      admits = rangeAdmitsFloorMajor(declared, floorMajor);
    } catch (err) {
      if (err instanceof UnmodelledRange) {
        fail(
          `${label} ${packagePath} declares engines.node ${JSON.stringify(declared)}, ` +
            `which scripts/check-cdk-engines-floor.mjs does not model (${err.message}); ` +
            "extend the matcher - ranges are never skipped",
        );
      }
      throw err;
    }

    result.checked += 1;
    if (!admits) {
      result.violations.push({
        lockfile: label,
        packagePath,
        version: entry?.version ?? "<unknown>",
        declared,
      });
    }
  }
  return result;
}

function runSelfTest() {
  const FLOOR = 22;
  const cases = [
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
  ];

  let failures = 0;
  for (const [range, floor, expected] of cases) {
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
  if (failures > 0) fail(`self-test failed (${failures} of ${cases.length} cases)`);
  return cases.length;
}

function main() {
  const args = process.argv.slice(2);
  const selfTest = args[0] === "--self-test";
  const lockfileArgs = selfTest ? args.slice(1) : args;

  const selfTestCases = selfTest ? runSelfTest() : 0;

  const { major: floorMajor, spec: floorSpec } = readFloorMajor();
  const lockfiles =
    lockfileArgs.length > 0 ? lockfileArgs.map(resolveLockfileArgument) : defaultLockfiles();

  let checked = 0;
  let skippedRoots = 0;
  const violations = [];
  for (const lockfile of lockfiles) {
    const result = scanLockfile(lockfile, floorMajor);
    checked += result.checked;
    skippedRoots += result.skippedRoots;
    violations.push(...result.violations);
  }

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `cdk-engines-floor: unexpected engines.node ${JSON.stringify(violation.declared)} in ` +
          `${violation.packagePath}@${violation.version} from ${violation.lockfile} ` +
          `(excludes Node ${floorMajor}.x, the ${CDK_MANIFEST} floor ${JSON.stringify(floorSpec)})`,
      );
    }
    fail(
      `${violations.length} of ${checked} CDK dependency engine ranges exclude the Node ${floorMajor} floor`,
    );
  }

  const selfTestSummary = selfTest ? `self-test ${selfTestCases} cases; ` : "";
  console.log(
    `cdk-engines-floor: PASS (${selfTestSummary}floor ${JSON.stringify(floorSpec)}; ` +
      `lockfiles ${lockfiles.length}; dependency engine ranges ${checked}; ` +
      `own-project engine declarations not judged ${skippedRoots}; excluded 0)`,
  );
}

main();
