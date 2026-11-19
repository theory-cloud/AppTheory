# Purpose: prove scripts/verify-ci-trigger-parity.sh (cmd/ci-guard) fails closed
# on every bypass reproduced in review rounds 0, 1 and 2, and still passes on the
# shipped wiring.
#
# The shipped shape is verified-once: gates run on the pull request into staging
# and nowhere else, a merge publishes instead of re-verifying, and premain/main
# pull requests run recorded release hygiene only.
#
# Round 0 reproduced bypasses that used to pass the line-matching guard:
#   - appending `|| (github.event_name != 'pull_request')`
#   - appending `|| !(github.event_name == 'pull_request')`
#   - appending `|| (github.ref == 'refs/heads/staging')`
#   - appending `|| !(github.event.pull_request.base.ref == 'staging')`
#   - a continuation-line clause broadening the rubric
#   - a folded (`>-`) rubric condition
#   - a new premain->main-only promotion job (`base.ref == 'main' && head.ref == 'premain'`)
#   - a new generic push job (`github.event_name == 'push'`)
#   - a new `github.event_name != 'pull_request'` job
#
# Round 1 reproduced bypasses (SAN/ADV-1073-R1-*), each returning exit 0 while
# the gate was vacated or a promotion-only gate hid outside ci.yml:
#   - a new workflow file with a push-only gating job (F3)
#   - a new workflow file with a promotion-only pull request trigger (F3)
#   - a promotion-only job hidden inside a `uses:` reusable-workflow callee
#   - a step-level `if:` that runs the rubric only on a manual dispatch
#   - pages.yml, an exempted non-gating publisher, gaining a pull_request trigger
#
# Round 2 covers the post-release main back-merge exemption, whose wiring must
# stay narrow:
#   - stripping the eligibility step's `--allow-main-backmerge` opt-in, which
#     hands the gate back to the plain predicate and leaves the merged staging
#     back-merge red
#   - widening the exemption's head ref binding (to `github.ref_name`), which
#     would exempt pull requests whose content has not been released
#
# The verified-once probes below keep that policy honest: ci.yml cannot regain a
# push trigger, the promotion-lane jobs cannot regain a push leg, premain/main
# pull requests cannot gain an unrecorded job, the staging pull request cannot
# gain an executing job, and no job may sit gated on a trigger the workflow no
# longer declares.
#
# plus the canonical regressions (a promotion-scoped rubric, a push-broadened
# deterministic-build job, a `pull_request` branch filter that omits staging, and
# YAML smuggling) and green controls proving the classifier is not vacuously
# failing.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

if ! command -v go >/dev/null 2>&1; then
  echo "test-verify-ci-trigger-parity: BLOCKED (go toolchain not found)" >&2
  exit 2
fi

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT
root="${workdir}/repo"
mkdir -p "${root}/.github/workflows"

out="${workdir}/out"

reset_fixture() {
  rm -f "${root}/.github/workflows/"*.yml
  cp "${repo_root}/.github/workflows/"*.yml "${root}/.github/workflows/"
}

run_guard() {
  set +e
  go run ./cmd/ci-guard workflow-triggers \
    --root "${root}" --workflows-dir ".github/workflows" >"${out}" 2>&1
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
    echo "test-verify-ci-trigger-parity: FAIL (${label}: guard must PASS, got ${status})" >&2
    exit 1
  fi
}

# mutate <file> <mode> [args...] rewrites one workflow in the probe tree.
mutate() {
  local file="$1"
  shift
  python3 - "${root}/.github/workflows/${file}" "$@" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
text = path.read_text(encoding="utf-8")
ELIGIBILITY_JOB = "staging-release-eligibility"


def find_line(prefix):
    for line in text.splitlines():
        if line.startswith(prefix):
            return line
    raise SystemExit(f"line with prefix {prefix!r} not found")


def job_if_index(job_id):
    """Index of the `if:` line inside one job, so two identical guards stay distinct."""
    lines = text.splitlines(keepends=True)
    header = f"  {job_id}:\n"
    for index, line in enumerate(lines):
        if line == header:
            for probe in range(index + 1, len(lines)):
                if lines[probe].startswith("    if:"):
                    return probe
                if lines[probe].startswith("  ") and not lines[probe].startswith("    "):
                    break
            raise SystemExit(f"job {job_id!r} has no job-level if: line")
    raise SystemExit(f"job {job_id!r} not found")


def replace_job_if(job_id, replacement):
    global text
    lines = text.splitlines(keepends=True)
    index = job_if_index(job_id)
    lines[index] = replacement if replacement.endswith("\n") else replacement + "\n"
    text = "".join(lines)


def job_if_line(job_id):
    return text.splitlines()[job_if_index(job_id)]


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
    replace_job_if("rubric", job_if_line("rubric") + " " + sys.argv[3])
elif mode == "rubric_continuation":
    replace_job_if("rubric", job_if_line("rubric") + "\n      " + sys.argv[3])
elif mode == "rubric_replace":
    replace_job_if("rubric", "    if: " + sys.argv[3])
elif mode == "rubric_fold":
    replace_job_if("rubric", (
        "    if: >-\n"
        "      github.event_name == 'pull_request'\n"
        "      && github.event.pull_request.base.ref == 'staging'"))
elif mode == "builds_replace":
    replace_job_if("builds", "    if: " + sys.argv[3])
elif mode == "eligibility_push_leg_restored":
    replace_job_if(ELIGIBILITY_JOB,
                   "    if: (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'premain' && github.event.pull_request.head.ref == 'staging') || (github.event_name == 'push' && github.ref == 'refs/heads/staging')")
elif mode == "eligibility_pr_leg_restored":
    replace_job_if(ELIGIBILITY_JOB,
                   "    if: (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'premain' && github.event.pull_request.head.ref == 'staging') || (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging')")
elif mode == "eligibility_backmerge_removed":
    if "--allow-main-backmerge" not in text:
        raise SystemExit("eligibility back-merge opt-in fixture not found")
    text = text.replace("--allow-main-backmerge", "", 1)
elif mode == "eligibility_backmerge_head_ref_widened":
    step = ("      - name: Verify the promotion range stays release-eligible\n"
            "        env:\n")
    binding = step + "          PR_HEAD_REF: ${{ github.event.pull_request.head.ref }}\n"
    if binding not in text:
        raise SystemExit("eligibility head ref binding fixture not found")
    text = text.replace(binding, step + "          PR_HEAD_REF: ${{ github.ref_name }}\n", 1)
elif mode == "rubric_step_event_gate":
    target = ("      - name: Verify the recorded full rubric\n"
              "        run: bash scripts/evidence/verify-gate.sh --gate rubric --profile default\n")
    replacement = ("      - name: Verify the recorded full rubric\n"
                   "        if: github.event_name == 'workflow_dispatch'\n"
                   "        run: bash scripts/evidence/verify-gate.sh --gate rubric --profile default\n")
    if target not in text:
        raise SystemExit("rubric step fixture not found")
    text = text.replace(target, replacement, 1)
elif mode == "append":
    text = text.rstrip("\n") + "\n" + sys.argv[3] + "\n"
elif mode == "add_pull_request_branch_filter":
    replacement = f"    branches: [{sys.argv[3]}]\n"
    if "    branches: [staging, premain, main]\n" in text:
        text = text.replace("    branches: [staging, premain, main]\n", replacement, 1)
    else:
        text = text.replace("  pull_request:\n    types:",
                            f"  pull_request:\n{replacement}    types:", 1)
elif mode == "examples_local_filter":
    if '    branches: ["staging"]\n' not in text:
        raise SystemExit("examples-local staging filter fixture not found")
    text = text.replace('    branches: ["staging"]\n',
                        f'    branches: ["{sys.argv[3]}"]\n', 1)
elif mode == "add_yaml_smuggling":
    text = text.replace("  release-security-gates:\n", "  release-security-gates: &base\n", 1)
    text = text.rstrip("\n") + "\n  clone:\n    <<: *base\n    runs-on: ubuntu-latest\n"
elif mode == "add_push_trigger":
    text = text.replace("  pull_request:\n",
                        "  push:\n    branches: [staging, premain, main]\n  pull_request:\n", 1)
elif mode == "add_pull_request_trigger":
    text = text.replace("  push:\n    branches: [staging]\n",
                        "  push:\n    branches: [staging]\n  pull_request:\n    types: [opened, synchronize]\n", 1)
else:
    raise SystemExit(f"unknown mutation mode {mode}")
path.write_text(text, encoding="utf-8")
PY
}

new_job() {
  printf '  %s:\n    name: %s\n    if: %s\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo probe\n' "$1" "$2" "$3"
}

write_callee() {
  cat >"${root}/.github/workflows/callee.yml"
}

# Green baseline: the shipped wiring.
reset_fixture
expect_pass "shipped wiring"

# A. The rubric condition may not be broadened by any spelling.
reset_fixture
mutate ci.yml rubric_append "|| (github.event_name != 'pull_request')"
expect_fail "rubric broadened by a negated event predicate" "staging-pull-request-only"

reset_fixture
mutate ci.yml rubric_append "|| !(github.event_name == 'pull_request')"
expect_fail "rubric broadened by a unary-negated event predicate" "staging-pull-request-only"

reset_fixture
mutate ci.yml rubric_append "|| (github.ref == 'refs/heads/staging')"
expect_fail "rubric broadened by a push ref disjunct" "staging-pull-request-only"

reset_fixture
mutate ci.yml rubric_append "|| !(github.event.pull_request.base.ref == 'staging')"
expect_fail "rubric broadened by a negated base-ref predicate" "staging-pull-request-only"

reset_fixture
mutate ci.yml rubric_continuation "|| (github.event_name == 'push')"
expect_fail "rubric broadened on a continuation line" "staging-pull-request-only"

reset_fixture
mutate ci.yml rubric_fold
expect_fail "rubric condition written as a folded block" "not modeled"

reset_fixture
mutate ci.yml rubric_replace "github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'premain'"
expect_fail "rubric scoped to the premain promotion lane" "staging-pull-request-only"

reset_fixture
mutate ci.yml rubric_replace "github.event_name == 'push'"
expect_fail "rubric scoped to a push" "staging-pull-request-only"

# B. Deterministic builds keep the same staging-pull-request-only shape.
reset_fixture
mutate ci.yml builds_replace "github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging' || github.event_name == 'push'"
expect_fail "deterministic builds broadened to a push" "staging-pull-request-only"

# C. The release-eligibility gate is scoped to the promotion pull request and
# nowhere else. Restoring the push-to-staging leg re-creates the post-merge
# re-verification the policy removed, and restoring the
# pull-request-to-staging leg demands a verdict on a range that carries no
# release-driving commit; both widen a pinned condition and must fail.
reset_fixture
mutate ci.yml eligibility_push_leg_restored
expect_fail "eligibility gate given back its push-to-staging leg" "promotion-pull-request-only"

reset_fixture
mutate ci.yml eligibility_pr_leg_restored
expect_fail "eligibility gate run on pull requests to staging again" "promotion-pull-request-only"

# C1. A job gated only on a push can never run once ci.yml declares no push
# trigger, so it fails closed as dead wiring.
reset_fixture
mutate ci.yml append "$(new_job sneaky-push-only 'Sneaky push only' "github.event_name == 'push' && github.ref == 'refs/heads/staging'")"
expect_fail "a job gated only on the push-to-staging leg" "can never run on a modeled trigger"

# C2. The post-release main back-merge exemption stays wired and narrow: losing
# the opt-in hands the gate back to the plain predicate (the released staging SHA
# goes red), and widening the head ref binding would exempt work that has not
# been released.
reset_fixture
mutate ci.yml eligibility_backmerge_removed
expect_fail "eligibility back-merge opt-in stripped" "must opt in to the post-release main back-merge exemption"

reset_fixture
mutate ci.yml eligibility_backmerge_head_ref_widened
expect_fail "eligibility back-merge head ref binding widened" "must bind env PR_HEAD_REF"

# D. A job whose effective triggers come from `needs:` is classified accordingly.
reset_fixture
mutate ci.yml append "  needs-promotion-only:
    name: Needs promotion-only gate
    needs: prerelease-readiness
    runs-on: ubuntu-latest
    steps:
      - run: echo probe"
expect_fail "needs: on a promotion-only job makes the dependent promotion-only" "only recorded release hygiene may run there"

# E. New promotion-only jobs in either lane, and push-only jobs.
reset_fixture
mutate ci.yml append "$(new_job sneaky-premain-to-main 'Sneaky premain to main' "github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'main' && github.event.pull_request.head.ref == 'premain'")"
expect_fail "new premain-to-main promotion-only job" "only recorded release hygiene may run there"

reset_fixture
mutate ci.yml append "$(new_job sneaky-staging-to-premain 'Sneaky staging to premain' "github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'premain' && github.event.pull_request.head.ref == 'staging'")"
expect_fail "new staging-to-premain promotion-only job" "only recorded release hygiene may run there"

reset_fixture
mutate ci.yml append "$(new_job sneaky-negated-base 'Sneaky negated base' "github.event_name == 'pull_request' && github.event.pull_request.base.ref != 'staging'")"
expect_fail "new promotion-only job with a negated base ref" "only recorded release hygiene may run there"

reset_fixture
mutate ci.yml append "$(new_job sneaky-head-only 'Sneaky head-only gate' "github.event_name == 'pull_request' && github.event.pull_request.head.ref == 'staging'")"
expect_fail "new head-only gate on the staging promotion lane" "only recorded release hygiene may run there"

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
mutate ci.yml append "${folded_job}"
expect_fail "new job with a folded if: block" "not modeled"

reset_fixture
mutate ci.yml append "$(new_job sneaky-push 'Sneaky push' "github.event_name == 'push'")"
expect_fail "new generic push-only job" "can never run on a modeled trigger"

# The workflow-level regression: ci.yml cannot regain a push trigger.
reset_fixture
mutate ci.yml add_push_trigger
expect_fail "ci.yml regains a push trigger" "must not declare an on: push trigger"

# F. Unmodeled trigger and YAML shapes fail closed. A pull_request branch filter
# is modeled only when it keeps pull requests to staging: a filter that omits
# staging could hide the lane the parity gate is anchored to.
reset_fixture
mutate ci.yml add_pull_request_branch_filter premain
expect_fail "pull_request trigger filtered away from staging" "must include \"staging\""

reset_fixture
mutate examples-local.yml examples_local_filter premain
expect_fail "examples harness filtered away from staging" "must include \"staging\""

reset_fixture
mutate ci.yml add_yaml_smuggling
expect_fail "YAML merge key smuggled through an anchor" "not modeled"

# G. A workflow other than ci.yml cannot gate silently.
reset_fixture
cat >"${root}/.github/workflows/evil-push.yml" <<'YAML'
name: evil-push
on:
  push:
    branches: [staging]
jobs:
  gating:
    name: Evil gating
    runs-on: ubuntu-latest
    steps:
      - run: echo evil
YAML
expect_fail "new workflow with a partial push trigger" "protected branch"

reset_fixture
cat >"${root}/.github/workflows/evil-push.yml" <<'YAML'
name: evil-push
on:
  push:
    branches: [staging, main, premain]
jobs:
  gating:
    name: Evil gating
    runs-on: ubuntu-latest
    steps:
      - run: echo evil
YAML
expect_fail "new workflow whose push-only job would re-run a gate after the merge" "never on a merge"

reset_fixture
cat >"${root}/.github/workflows/evil-promo.yml" <<'YAML'
name: evil-promo
on:
  pull_request:
    branches: [premain]
jobs:
  gating:
    name: Evil gating
    if: github.event.pull_request.base.ref == 'premain'
    runs-on: ubuntu-latest
    steps:
      - run: echo evil
YAML
expect_fail "new workflow scoped to the promotion lane" "must include \"staging\""

# The recorded staging-lane scope exception is scoped to ci.yml: a same-named job
# in another workflow file does not inherit the carve-out.
reset_fixture
cat >"${root}/.github/workflows/evil-eligibility.yml" <<'YAML'
name: evil-eligibility
on:
  push:
    branches: [staging, main, premain]
jobs:
  staging-release-eligibility:
    name: Release eligibility (staging -> premain)
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - run: echo evil
YAML
expect_fail "a same-named job outside ci.yml cannot ride the ci.yml shape" "never on a merge"

# H. A reusable workflow's jobs are classified in the caller's context.
reset_fixture
mutate ci.yml append "  calls-callee:
    name: Calls callee
    uses: ./.github/workflows/callee.yml"
write_callee <<'YAML'
name: callee
on:
  workflow_call:
jobs:
  promoted:
    name: Promoted only
    if: github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'premain'
    runs-on: ubuntu-latest
    steps:
      - run: echo promoted
YAML
expect_fail "promotion-only job hidden in a reusable-workflow callee" "callee.yml:promoted"

# A callee job that runs on every lane is classified as such, so it fails both
# lane-shape rules: an unrecorded job cannot ride into the staging or release
# lanes just because it lives in another file.
reset_fixture
mutate ci.yml append "  calls-callee:
    name: Calls callee
    uses: ./.github/workflows/callee.yml"
write_callee <<'YAML'
name: callee
on:
  workflow_call:
jobs:
  shared:
    name: Shared
    runs-on: ubuntu-latest
    steps:
      - run: echo shared
YAML
expect_fail "all-lane job in a reusable-workflow callee" "neither verifies a recorded gate result"

reset_fixture
mutate ci.yml append "  calls-remote:
    name: Calls a remote reusable workflow
    uses: octo/example/.github/workflows/reuse.yml@1111111111111111111111111111111111111111"
expect_fail "remote reusable workflow is not classified" "not modeled"

# I. The rubric job's steps must run unconditionally on its staging-PR trigger
# (a step-level dispatch-only gate vacates the check while it stays green).
reset_fixture
mutate ci.yml rubric_step_event_gate
expect_fail "rubric run step gated to a manual dispatch" "must run unconditionally"

# J. An exempted non-gating publisher that starts gating pull requests fails.
reset_fixture
mutate pages.yml add_pull_request_trigger
expect_fail "exempted publisher gained a pull_request trigger" "must be classified"

# K. Positive control: the shipped wiring is green again.
reset_fixture
expect_pass "restored shipped wiring"

# L. The wrapper runs the real workflow directory in the real tree.
if ! bash "${repo_root}/scripts/verify-ci-trigger-parity.sh" >"${out}" 2>&1; then
  cat "${out}" >&2
  echo "test-verify-ci-trigger-parity: FAIL (the guard must PASS on the real tree)" >&2
  exit 1
fi

echo "test-verify-ci-trigger-parity: PASS"
