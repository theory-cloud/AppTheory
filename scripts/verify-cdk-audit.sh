#!/usr/bin/env bash
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

# Fail closed with one intentionally narrow exception:
# aws-cdk-lib bundles fast-uri inside its published package. The vulnerable copy
# is not part of AppTheory application/runtime code, npm overrides cannot replace
# it, and npm audit fix reports that the bundled dependency cannot be fixed
# automatically. Keep this exception pinned to the exact package path, advisory
# URLs, aws-cdk-lib version, fast-uri version, and bundled marker so any new or
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

const allowedFastUriAdvisories = [
  "https://github.com/advisories/GHSA-q3j6-qgpj-74h6",
  "https://github.com/advisories/GHSA-v39h-62p7-jpjc",
];

function sameStringSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  return actualSorted.every((value, index) => value === expectedSorted[index]);
}

function isAllowedBundledAwsCdkFastUri(vuln) {
  const cdkPackage = lock.packages?.["node_modules/aws-cdk-lib"];
  const fastUriPackage = lock.packages?.["node_modules/aws-cdk-lib/node_modules/fast-uri"];
  const viaUrls = (vuln.via ?? [])
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => String(entry.url ?? ""))
    .filter(Boolean);

  return (
    vuln.name === "fast-uri" &&
    vuln.isDirect === false &&
    Array.isArray(vuln.nodes) &&
    sameStringSet(vuln.nodes, ["node_modules/aws-cdk-lib/node_modules/fast-uri"]) &&
    sameStringSet(viaUrls, allowedFastUriAdvisories) &&
    cdkPackage?.version === "2.253.0" &&
    fastUriPackage?.version === "3.1.0" &&
    fastUriPackage?.inBundle === true
  );
}

const unexpected = vulnerabilities.filter((vuln) => !isAllowedBundledAwsCdkFastUri(vuln));
if (unexpected.length > 0) {
  for (const vuln of unexpected) {
    const nodes = Array.isArray(vuln.nodes) ? vuln.nodes.join(", ") : "<unknown nodes>";
    console.error(`cdk-audit: unexpected vulnerability ${vuln.name ?? "<unknown>"} (${vuln.severity ?? "unknown"}) at ${nodes}`);
  }
  process.exit(1);
}

console.error(
  "cdk-audit: WARN (allowed aws-cdk-lib bundled fast-uri advisories GHSA-q3j6-qgpj-74h6, GHSA-v39h-62p7-jpjc)",
);
NODE

echo "cdk-audit: PASS"
