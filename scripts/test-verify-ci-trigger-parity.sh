#!/usr/bin/env bash
# Purpose: prove scripts/verify-ci-trigger-parity.sh (cmd/ci-guard) fails closed
# on every R-F1 bypass reproduced in review round 0, and still passes on the
# shipped wiring.
#
# Reproduced bypasses that used to pass the line-matching guard:
#   - appending `|| (github.event_name != 'pull_request')`
#   - appending `|| !(github.event_name == 'pull_request')`
#   - appending `|| (github.ref == 'refs/heads/staging')`
#   - appending `|| !(github.event.pull_request.base.ref == 'staging')`
#   - a continuation-line clause broadening the rubric
#   - a folded (`>-`) rubric condition
#   - a new premain->main-only promotion job (`base.ref == 'main' && head.ref == 'premain'`)
#   - a new generic push job (`github.event_name == 'push'`)
#   - a new `github.event_name != 'pull_request'` job
# plus the canonical regressions (a promotion-scoped rubric, a push Broadened
# deterministic-build job, a `pull_request` branch filter, and YAML smuggling).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

if ! command -v go >/dev/null 2>&1; then
  echo "test-verify-ci-trigger-parity: BLOCKED (go toolchain not found)" >&2
  exit 2
fi

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT
mkdir -p "${workdir}/.github/workflows"

source_ci="${repo_root}/.github/workflows/ci.yml"
probe_ci="${workdir}/.github/workflows/ci.yml"

out="${workdir}/out"

reset_fixture() {
  cp "${source_ci}" "${probe_ci}"
}

run_guard() {
  set +e
  go run ./cmd/ci-guard workflow-triggers \
    --root "${workdir}" --workflow ".github/workflows/ci.yml" >"${out}" 2>&1
  local status=$?
  set -e
  printf '%s' "${status}"
}

must_report() {
  local label="$1"
  local status="$2"
  local needle="$3"
  if [[ "${status}" != "1" ]]; then
    cat "${out}" >&2
    echo "test-verify-ci-trigger-parity: FAIL (${label}: expected guard exit 1, got ${status})" >&2
    exit 1
  fi
  if ! grep -Fq -- "${needle}" "${out}"; then
    cat "${out}" >&2
    echo "test-verify-ci-trigger-parity: FAIL (${label}: guard output does not mention ${needle})" >&2
    exit 1
  fi
}

expect_fail() {
  must_report "$1" "$(run_guard)" "${2:-}"
}

expect_pass() {
  local label="$1"
  local status
  status="$(run_guard)"
  if [[ "${status}" != "0" ]]; then
    cat "${out}" >&2
    echo "test-verify-ci-trigger-parity: FAIL (${label}: guard must PASS on the canonical wiring, got ${status})" >&2
    exit 1
  fi
}

# mutate <mode> [args...] rewrites the probe workflow copy.
mutate() {
  python3 - "${probe_ci}" "$@" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
text = path.read_text(encoding="utf-8")
RUBRIC_PREFIX = "    if: (github.event_name == 'workflow_dispatch'"
BUILDS_PREFIX = "    if: github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging'"


def find_line(prefix):
    for line in text.splitlines():
        if line.startswith(prefix):
            return line
    raise SystemExit(f"line with prefix {prefix!r} not found")


def replace_line(prefix, replacement):
    global text
    lines = text.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line.startswith(prefix):
            lines[index] = replacement if replacement.endswith("\n") else replacement + "\n"
            text = "".join(lines)
            return
    raise SystemExit(f"line with prefix {prefix!r} not found")


if mode == "rubric_append":
    replace_line(RUBRIC_PREFIX, find_line(RUBRIC_PREFIX) + " " + sys.argv[3])
elif mode == "rubric_continuation":
    replace_line(RUBRIC_PREFIX, find_line(RUBRIC_PREFIX) + "\n      " + sys.argv[3])
elif mode == "rubric_replace":
    replace_line(RUBRIC_PREFIX, "    if: " + sys.argv[3])
elif mode == "rubric_fold":
    replace_line(RUBRIC_PREFIX, (
        "    if: >-\n"
        "      (github.event_name == 'workflow_dispatch' && (inputs.run_full_rubric == true || inputs.run_full_rubric == 'true'))\n"
        "      || (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging')"))
elif mode == "builds_replace":
    replace_line(BUILDS_PREFIX, "    if: " + sys.argv[3])
elif mode == "append":
    text = text.rstrip("\n") + "\n" + sys.argv[3] + "\n"
elif mode == "add_pull_request_branch_filter":
    text = text.replace("  pull_request:\n    types:", "  pull_request:\n    branches: [staging]\n    types:", 1)
elif mode == "add_yaml_smuggling":
    text = text.replace("  release-security-gates:\n", "  release-security-gates: &base\n", 1)
    text = text.rstrip("\n") + "\n  clone:\n    <<: *base\n    runs-on: ubuntu-latest\n"
else:
    raise SystemExit(f"unknown mutation mode {mode}")
path.write_text(text, encoding="utf-8")
PY
}

new_job() {
  printf '  %s:\n    name: %s\n    if: %s\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo probe\n' "$1" "$2" "$3"
}

# Green baseline: the shipped wiring.
reset_fixture
expect_pass "shipped wiring"

# A. The rubric condition may not be broadened by any spelling.
reset_fixture
mutate rubric_append "|| (github.event_name != 'pull_request')"
expect_fail "rubric broadened by a negated event predicate" "staging-pull-request-only"

reset_fixture
mutate rubric_append "|| !(github.event_name == 'pull_request')"
expect_fail "rubric broadened by a unary-negated event predicate" "staging-pull-request-only"

reset_fixture
mutate rubric_append "|| (github.ref == 'refs/heads/staging')"
expect_fail "rubric broadened by a push ref disjunct" "staging-pull-request-only"

reset_fixture
mutate rubric_append "|| !(github.event.pull_request.base.ref == 'staging')"
expect_fail "rubric broadened by a negated base-ref predicate" "staging-pull-request-only"

reset_fixture
mutate rubric_continuation "|| (github.event_name == 'push')"
expect_fail "rubric broadened on a continuation line" "staging-pull-request-only"

reset_fixture
mutate rubric_fold
expect_fail "rubric condition written as a folded block" "not modeled"

reset_fixture
mutate rubric_replace "github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'premain'"
expect_fail "rubric scoped to the premain promotion lane" "staging-pull-request-only"

reset_fixture
mutate rubric_replace "github.event_name == 'push'"
expect_fail "rubric scoped to a push" "staging-pull-request-only"

# B. Deterministic builds keep the same staging-pull-request-only shape.
reset_fixture
mutate builds_replace "github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging' || github.event_name == 'push'"
expect_fail "deterministic builds broadened to a push" "staging-pull-request-only"

# C. New promotion-only jobs in either lane, and push-only jobs.
reset_fixture
mutate append "$(new_job sneaky-premain-to-main 'Sneaky premain to main' "github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'main' && github.event.pull_request.head.ref == 'premain'")"
expect_fail "new premain-to-main promotion-only job" "no pull-request-to-staging equivalent"

reset_fixture
mutate append "$(new_job sneaky-staging-to-premain 'Sneaky staging to premain' "github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'premain' && github.event.pull_request.head.ref == 'staging'")"
expect_fail "new staging-to-premain promotion-only job" "no pull-request-to-staging equivalent"

reset_fixture
mutate append "$(new_job sneaky-negated-base 'Sneaky negated base' "github.event_name == 'pull_request' && github.event.pull_request.base.ref != 'staging'")"
expect_fail "new promotion-only job with a negated base ref" "no pull-request-to-staging equivalent"

reset_fixture
mutate append "$(new_job sneaky-head-only 'Sneaky head-only gate' "github.event_name == 'pull_request' && github.event.pull_request.head.ref == 'staging'")"
expect_fail "new head-only gate on the staging promotion lane" "no pull-request-to-staging equivalent"

folded_job="$(cat <<'YAML'
  sneaky-folded:
    name: Sneaky folded
    if: >-
      github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'premain'
    runs-on: ubuntu-latest
    steps:
      - run: echo probe
YAML
)"
reset_fixture
mutate append "${folded_job}"
expect_fail "new job with a folded if: block" "not modeled"

reset_fixture
mutate append "$(new_job sneaky-push 'Sneaky push' "github.event_name == 'push'")"
expect_fail "new generic push-only job" "push parity"

reset_fixture
mutate append "$(new_job sneaky-not-pr 'Sneaky not pull request' "github.event_name != 'pull_request'")"
expect_fail "new negated-event push-only job" "push parity"

# D. Unmodelled trigger and YAML shapes fail closed.
reset_fixture
mutate add_pull_request_branch_filter
expect_fail "pull_request trigger gained a branch filter" "not modeled"

reset_fixture
mutate add_yaml_smuggling
expect_fail "YAML merge key smuggled through an anchor" "not modeled"

# E. Positive control: the shipped wiring is green again.
reset_fixture
expect_pass "restored shipped wiring"

# F. The wrapper runs the real workflow in the real tree.
if ! bash "${repo_root}/scripts/verify-ci-trigger-parity.sh" >"${out}" 2>&1; then
  cat "${out}" >&2
  echo "test-verify-ci-trigger-parity: FAIL (the guard must PASS on the real tree)" >&2
  exit 1
fi

echo "test-verify-ci-trigger-parity: PASS"
