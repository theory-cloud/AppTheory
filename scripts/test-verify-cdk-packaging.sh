#!/usr/bin/env bash
# Purpose: cheap controls for the composed CDK packaging step.
#
# Every case runs the real scripts/verify-cdk-packaging.sh against a throwaway
# repository whose packaging scripts only count their invocations. The last
# block checks the production wiring: one composed call from the release-gates
# step, and two real calls per packaging script inside the deterministic-build
# passes.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/apptheory-cdk-packaging.XXXXXX")"
trap 'rm -rf "${tmp}"' EXIT

fixture="${tmp}/repo"
mkdir -p "${fixture}/scripts" "${fixture}/gov-infra/verifiers" "${fixture}/state"
cp "${repo_root}/scripts/verify-cdk-packaging.sh" "${fixture}/scripts/verify-cdk-packaging.sh"
chmod +x "${fixture}/scripts/verify-cdk-packaging.sh"

cat >"${fixture}/scripts/verify-builds.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
scripts/verify-cdk-ts-pack.sh
scripts/verify-cdk-python-build.sh
SH
cat >"${fixture}/scripts/verify-cdk-ts-pack.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'ts\n' >>state/calls.log
SH
cat >"${fixture}/scripts/verify-cdk-python-build.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'py\n' >>state/calls.log
SH
cat >"${fixture}/gov-infra/verifiers/gov-verify-rubric.sh" <<'SH'
#!/usr/bin/env bash
scripts/verify-builds.sh
SH
chmod +x "${fixture}/scripts/"*.sh

pass_count=0
reset_calls() {
  : >"${fixture}/state/calls.log"
}
call_count() {
  if [[ -s "${fixture}/state/calls.log" ]]; then
    wc -l <"${fixture}/state/calls.log" | tr -d ' '
  else
    printf '0'
  fi
}
expect_success() {
  local label="$1"
  shift
  if ! "$@" >"${tmp}/out.log" 2>&1; then
    echo "test-verify-cdk-packaging: FAIL (${label})" >&2
    cat "${tmp}/out.log" >&2
    exit 1
  fi
  pass_count=$((pass_count + 1))
  echo "test-verify-cdk-packaging: PASS ${label}"
}
expect_failure() {
  local label="$1"
  local needle="$2"
  shift 2
  if "$@" >"${tmp}/out.log" 2>&1; then
    echo "test-verify-cdk-packaging: FAIL (${label}; command unexpectedly passed)" >&2
    cat "${tmp}/out.log" >&2
    exit 1
  fi
  if ! grep -Fq -- "${needle}" "${tmp}/out.log"; then
    echo "test-verify-cdk-packaging: FAIL (${label}; missing ${needle})" >&2
    cat "${tmp}/out.log" >&2
    exit 1
  fi
  pass_count=$((pass_count + 1))
  echo "test-verify-cdk-packaging: PASS ${label}"
}

# Composed at rubric nesting: zero package builds, because the two
# deterministic-build passes already built both packages.
reset_calls
expect_success "composed rubric packaging builds nothing" \
  env APPTHEORY_RUBRIC_CDK_PACKAGING_COVERED=true bash -c 'cd "$1" && bash scripts/verify-cdk-packaging.sh' _ "${fixture}"
composed_calls="$(call_count)"
if [[ "${composed_calls}" != "0" ]]; then
  echo "test-verify-cdk-packaging: FAIL (composed packaging executed ${composed_calls} scripts)" >&2
  exit 1
fi

# Force mode always executes: a forced collection never inherits a composed
# claim from another environment.
reset_calls
expect_success "forced mode packages directly" \
  env APPTHEORY_RUBRIC_CDK_PACKAGING_COVERED=true EVIDENCE_FORCE_EXECUTE=true \
    bash -c 'cd "$1" && bash scripts/verify-cdk-packaging.sh' _ "${fixture}"
forced_calls="$(call_count)"
if [[ "${forced_calls}" != "2" ]]; then
  echo "test-verify-cdk-packaging: FAIL (forced packaging executed ${forced_calls} scripts, expected 2)" >&2
  exit 1
fi

# A direct caller (no rubric coverage declaration) really packages.
reset_calls
expect_success "direct packaging builds both packages" \
  bash -c 'cd "$1" && bash scripts/verify-cdk-packaging.sh' _ "${fixture}"
direct_calls="$(call_count)"
if [[ "${direct_calls}" != "2" ]]; then
  echo "test-verify-cdk-packaging: FAIL (direct packaging executed ${direct_calls} scripts, expected 2)" >&2
  exit 1
fi

# Coverage completeness fails closed: a verifier that stops running the
# deterministic builds, or one that drops a package, cannot keep the claim.
cp "${fixture}/scripts/verify-builds.sh" "${tmp}/verify-builds.good"
cp "${fixture}/gov-infra/verifiers/gov-verify-rubric.sh" "${tmp}/verifier.good"
printf '#!/usr/bin/env bash\nset -euo pipefail\nscripts/verify-cdk-python-build.sh\n' >"${fixture}/scripts/verify-builds.sh"
expect_failure "composed claim fails when a package leaves the determinism passes" "coverage would be lost" \
  env APPTHEORY_RUBRIC_CDK_PACKAGING_COVERED=true bash -c 'cd "$1" && bash scripts/verify-cdk-packaging.sh' _ "${fixture}"
cp "${tmp}/verify-builds.good" "${fixture}/scripts/verify-builds.sh"

printf '#!/usr/bin/env bash\nset -euo pipefail\ntrue\n' >"${fixture}/gov-infra/verifiers/gov-verify-rubric.sh"
expect_failure "composed claim fails when the rubric stops running the builds" "no longer runs verify-builds.sh" \
  env APPTHEORY_RUBRIC_CDK_PACKAGING_COVERED=true bash -c 'cd "$1" && bash scripts/verify-cdk-packaging.sh' _ "${fixture}"
cp "${tmp}/verifier.good" "${fixture}/gov-infra/verifiers/gov-verify-rubric.sh"

# Production wiring: exactly one composed call, with the two real builds retained
# inside each of the two determinism passes.
release_gates="${repo_root}/scripts/verify-release-gates.sh"
verify_builds="${repo_root}/scripts/verify-builds.sh"
rubric="${repo_root}/scripts/verify-rubric.sh"
for script in verify-cdk-ts-pack.sh verify-cdk-python-build.sh; do
  direct="$(grep -c "\./scripts/${script}" "${release_gates}" || true)"
  if [[ "${direct}" != "0" ]]; then
    echo "test-verify-cdk-packaging: FAIL (release-gates still calls ${script} directly)" >&2
    exit 1
  fi
  nested="$(grep -c "scripts/${script}" "${verify_builds}" || true)"
  if [[ "${nested}" != "1" ]]; then
    echo "test-verify-cdk-packaging: FAIL (verify-builds.sh must invoke ${script} once per pass, found ${nested})" >&2
    exit 1
  fi
done
composed="$(grep -c "^\./scripts/verify-cdk-packaging.sh\$" "${release_gates}" || true)"
if [[ "${composed}" != "1" ]]; then
  echo "test-verify-cdk-packaging: FAIL (release-gates must call verify-cdk-packaging.sh once, found ${composed})" >&2
  exit 1
fi
if ! grep -Fq "APPTHEORY_RUBRIC_CDK_PACKAGING_COVERED=true bash ./scripts/verify-release-gates.sh" "${rubric}"; then
  echo "test-verify-cdk-packaging: FAIL (the rubric must declare the composed packaging coverage)" >&2
  exit 1
fi
pass_count=$((pass_count + 1))
echo "test-verify-cdk-packaging: PASS production nesting and coverage attribution"

echo "test-verify-cdk-packaging: PASS (${pass_count} checks)"
