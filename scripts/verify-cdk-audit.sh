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

# Fail closed: any npm audit finding in the CDK package is a rubric failure.
# AWS CDK now publishes a tarball with brace-expansion >=5.0.6, so the former
# bundled brace-expansion exception must not remain as a fallback path.
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

const vulnerabilities = Object.values(report.vulnerabilities ?? {});
if (vulnerabilities.length === 0) {
  fail("cdk-audit: FAIL (npm audit failed without vulnerabilities in report)");
}

for (const vuln of vulnerabilities) {
  const nodes = Array.isArray(vuln.nodes) ? vuln.nodes.join(", ") : "<unknown nodes>";
  const via = (vuln.via ?? [])
    .map((entry) => (entry && typeof entry === "object" ? entry.url || entry.title || entry.name : entry))
    .filter(Boolean)
    .join(", ");
  console.error(
    `cdk-audit: vulnerability ${vuln.name ?? "<unknown>"} (${vuln.severity ?? "unknown"}) at ${nodes}${via ? ` via ${via}` : ""}`,
  );
}
process.exit(1);
NODE

echo "cdk-audit: PASS"
