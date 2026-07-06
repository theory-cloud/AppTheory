#!/usr/bin/env bash
# Purpose: audit CDK sources for construct and dependency policy violations.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v npm >/dev/null 2>&1; then
  echo "cdk-audit: BLOCKED (npm not found)" >&2
  exit 1
fi
if [[ ! -d "cdk" ]]; then
  echo "cdk-audit: FAIL (missing cdk/)" >&2
  exit 1
fi
if [[ ! -f "cdk/package-lock.json" ]]; then
  echo "cdk-audit: FAIL (missing cdk/package-lock.json)" >&2
  exit 1
fi

tmp_report="$(mktemp)"
cleanup() {
  rm -f "${tmp_report}"
}
trap cleanup EXIT

set +e
npm --prefix cdk audit --audit-level=moderate --json >"${tmp_report}"
audit_status=$?
set -e

if [[ "${audit_status}" -eq 0 ]]; then
  echo "cdk-audit: PASS"
  exit 0
fi

# Fail closed with intentionally narrow exceptions for AWS CDK bundled
# dependencies. These vulnerable copies are not part of AppTheory
# application/runtime code, npm overrides cannot replace them inside the
# aws-cdk-lib tarball, and changing the dependency graph would break framework
# consumers. Keep each exception pinned to the exact package path, advisory URL,
# aws-cdk-lib version, dependency version, and bundled marker so any new or
# changed vulnerability still fails the rubric.
AUDIT_REPORT="${tmp_report}" node <<'NODE'
const fs = require("fs");

function fail(message) {
  console.error(message);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(process.env.AUDIT_REPORT, "utf8"));
} catch (err) {
  fail(`cdk-audit: FAIL (npm audit did not produce parseable JSON: ${err.message})`);
}

let lock;
try {
  lock = JSON.parse(fs.readFileSync("cdk/package-lock.json", "utf8"));
} catch (err) {
  fail(`cdk-audit: FAIL (cannot read cdk/package-lock.json: ${err.message})`);
}

const vulnerabilities = Object.values(report.vulnerabilities ?? {});
if (vulnerabilities.length === 0) {
  fail("cdk-audit: FAIL (npm audit failed without vulnerabilities in report)");
}

const allowedBraceExpansionAdvisories = ["https://github.com/advisories/GHSA-jxxr-4gwj-5jf2"];

function sameStringSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  return actualSorted.every((value, index) => value === expectedSorted[index]);
}

function isAllowedBundledAwsCdkBraceExpansion(vuln) {
  const cdkPackage = lock.packages?.["node_modules/aws-cdk-lib"];
  const minimatchPackage = lock.packages?.["node_modules/aws-cdk-lib/node_modules/minimatch"];
  const braceExpansionPackage = lock.packages?.["node_modules/aws-cdk-lib/node_modules/brace-expansion"];
  const viaUrls = (vuln.via ?? [])
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => String(entry.url ?? ""))
    .filter(Boolean);
  const viaRanges = (vuln.via ?? [])
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => String(entry.range ?? ""))
    .filter(Boolean);

  return (
    vuln.name === "brace-expansion" &&
    vuln.isDirect === false &&
    Array.isArray(vuln.nodes) &&
    sameStringSet(vuln.nodes, ["node_modules/aws-cdk-lib/node_modules/brace-expansion"]) &&
    sameStringSet(viaUrls, allowedBraceExpansionAdvisories) &&
    sameStringSet(viaRanges, [">=5.0.0 <5.0.6"]) &&
    cdkPackage?.version === "2.257.0" &&
    Array.isArray(cdkPackage?.bundleDependencies) &&
    cdkPackage.bundleDependencies.includes("minimatch") &&
    minimatchPackage?.version === "10.2.5" &&
    minimatchPackage?.inBundle === true &&
    minimatchPackage?.dependencies?.["brace-expansion"] === "^5.0.5" &&
    braceExpansionPackage?.version === "5.0.5" &&
    braceExpansionPackage?.inBundle === true
  );
}

const allowed = vulnerabilities.filter((vuln) => isAllowedBundledAwsCdkBraceExpansion(vuln));
const unexpected = vulnerabilities.filter((vuln) => !isAllowedBundledAwsCdkBraceExpansion(vuln));
if (unexpected.length > 0) {
  for (const vuln of unexpected) {
    const nodes = Array.isArray(vuln.nodes) ? vuln.nodes.join(", ") : "<unknown nodes>";
    console.error(`cdk-audit: unexpected vulnerability ${vuln.name ?? "<unknown>"} (${vuln.severity ?? "unknown"}) at ${nodes}`);
  }
  process.exit(1);
}

console.error(
  `cdk-audit: WARN (allowed AWS CDK bundled advisories: ${allowed
    .map(
      (vuln) =>
        `${vuln.name}:${(vuln.via ?? [])
          .map((entry) => (entry && typeof entry === "object" ? entry.url : ""))
          .filter(Boolean)
          .join(",")}`,
    )
    .join("; ")})`,
);
NODE

echo "cdk-audit: PASS"
