#!/usr/bin/env bash
set -euo pipefail

# Release-lane guard: every generated release pull request has an automatic,
# head-bound dispatch path for every required context of its base branch, and a
# recovery sweep that needs no human.
#
# The failure this prevents is a release lane that looks wired but cannot gate
# itself. release-please (and the artifact sync) create their pull request
# updates with the built-in token, and GitHub starts no `pull_request` workflow
# for events that token causes, so a generated release pull request only gets a
# context when the lane dispatches it. If that dispatch is missing, mis-targeted
# or unbound, the required context never reports and the only repair used to be
# closing and reopening the pull request or a human dispatch.
#
# The declaration in `.github/release-lane.json` names, per base branch, the
# required contexts, the workflow that reports each one and the job that carries
# the context name. This guard proves that:
#
#   1. every workflow that creates a generated release pull request declares the
#      permission to create pull requests and to dispatch workflows, and invokes
#      scripts/sync-release-pr-checks.sh for the exact head branch;
#   2. each required context is a job in a workflow that has a
#      workflow_dispatch path taking the pull request number *and* the head SHA,
#      that binds the run to the pull request head through
#      scripts/resolve-release-pr-head.sh, and that re-checks the checkout is
#      that head before any check runs;
#   3. the scheduled recovery sweep exists, is wired to the same lane, and cannot
#      be turned into a silent no-op;
#   4. no workflow reintroduces a release-please token or a secret-to-token
#      fallback: the lane runs on the built-in token only;
#   5. a script that a ruleset-required job runs and that branches on the event
#      name has a `pull_request_review` branch, so the code-owner review cannot
#      fail closed after the approval that was meant to satisfy the ruleset.
#
# The self-test proves the guard is not vacuous: it mutates copies of the real
# workflows and declaration and requires each mutation to fail, and it drives the
# head-binding resolver with hostile stub answers.
#
# Usage: bash scripts/verify-release-pr-check-lane.sh [--self-test] [--root DIR]

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
self_test=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --self-test)
      self_test=true
      shift
      ;;
    --root)
      [[ $# -ge 2 ]] || { echo "release-pr-check-lane: FAIL (--root requires a value)" >&2; exit 2; }
      root="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: bash scripts/verify-release-pr-check-lane.sh [--self-test] [--root DIR]

Fails when a generated release pull request has no head-bound dispatch path for
one of its base branch's required contexts, or when the recovery sweep that keeps
the lane self-healing is missing. --self-test additionally proves the guard and
the head-binding resolver reject hostile shapes.
USAGE
      exit 0
      ;;
    *)
      echo "release-pr-check-lane: FAIL (unknown argument: $1)" >&2
      exit 2
      ;;
  esac
done

check() {
  python3 - "${root}" <<'PY'
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
config_path = root / ".github" / "release-lane.json"
workflows = root / ".github" / "workflows"
failures: list[str] = []
reported_review_scripts: set[tuple[str, str]] = set()


def report(message: str) -> None:
    failures.append(message)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


if not config_path.is_file():
    print(f"release-pr-check-lane: FAIL (missing {config_path})", file=sys.stderr)
    raise SystemExit(1)

try:
    data = json.loads(read(config_path))
except json.JSONDecodeError as exc:
    print(f"release-pr-check-lane: FAIL (declaration is not JSON: {exc})", file=sys.stderr)
    raise SystemExit(1)

if data.get("schemaVersion") != 1:
    print("release-pr-check-lane: FAIL (declaration schemaVersion must be 1)", file=sys.stderr)
    raise SystemExit(1)

contexts = data.get("requiredContexts") or {}
producers = data.get("generatedReleasePullRequests") or []
sweep = data.get("recoverySweep") or {}
if not producers:
    print("release-pr-check-lane: FAIL (declaration names no generated release pull request)", file=sys.stderr)
    raise SystemExit(1)
if not sweep:
    print("release-pr-check-lane: FAIL (declaration names no recovery sweep)", file=sys.stderr)
    raise SystemExit(1)

JOB_BLOCK = r"(?ms)^  {job}:\n(?P<block>.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)"
# Scripts a job invokes, and the runtime event-name read a script must map onto
# the code-owner review. A workflow expression (`github.event_name`) is expanded
# before a script runs, so the runtime signal for a script is the
# GITHUB_EVENT_NAME environment variable. Both checks are grep-level by design:
# the guard proves the review branch is present, not that every path inside the
# script reaches it.
SCRIPT_REF = re.compile(r"scripts/[A-Za-z0-9_./-]+\.(?:sh|py|mjs)")
EVENT_NAME_BRANCH = re.compile(r"GITHUB_EVENT_NAME")


def job_block(text: str, job: str) -> str | None:
    match = re.search(JOB_BLOCK.format(job=re.escape(job)), text)
    return match.group("block") if match else None


def script_refs(block: str) -> set[str]:
    return {match.group(0) for match in SCRIPT_REF.finditer(block)}


def producer_checks(head: str, base: str, workflow: str) -> None:
    path = workflows / workflow
    if not path.is_file():
        report(f"declared producer {workflow} does not exist")
        return
    text = read(path)
    if not re.search(r"(?m)^[ \t]+pull-requests:[ \t]*write[ \t]*$", text):
        report(f"{workflow} creates a pull request but does not declare pull-requests: write")
    if not re.search(r"(?m)^[ \t]+actions:[ \t]*write[ \t]*$", text):
        report(f"{workflow} dispatches the verifying workflow but does not declare actions: write")
    if f"--head-branch {head}" not in text:
        report(f"{workflow} does not run scripts/sync-release-pr-checks.sh for {head}")
    if "scripts/sync-release-pr-checks.sh" not in text:
        report(f"{workflow} does not attach the required checks to its generated pull request")
    if base not in contexts:
        report(f"{workflow} targets {base}, which the declaration gives no required contexts")


def context_checks(base: str, item: dict) -> None:
    context = str(item.get("context") or "")
    workflow = str(item.get("workflow") or "")
    job = str(item.get("job") or "")
    item_checkout_proof = bool(item.get("checkoutProof", True))
    entry_note = item.get("note") or ""
    path = workflows / workflow
    if not path.is_file():
        report(f"required context {context} names a missing workflow {workflow}")
        return
    text = read(path)
    if not re.search(r"(?m)^  workflow_dispatch:[ \t]*($|#)", text):
        report(f"{workflow} reports {context} but has no workflow_dispatch path")
    # GitHub evaluates a required status check only when the reporting run was
    # triggered by an eligible event, and a generated release pull request only
    # produces one through the code-owner review it already requires.
    if not re.search(r"(?m)^  pull_request_review:[ \t]*$", text):
        report(f"{workflow} has no pull_request_review trigger, so the code-owner review can never make {context} count")
    if "types: [submitted]" not in text:
        report(f"{workflow} does not subscribe the pull_request_review trigger to the submitted activity")
    if not re.search(r"(?m)^[ \t]+release_pr_number:[ \t]*$", text):
        report(f"{workflow} has no release_pr_number dispatch input to bind the head")
    if not re.search(r"(?m)^[ \t]+release_head_sha:[ \t]*$", text):
        report(f"{workflow} has no release_head_sha dispatch input, so a dispatch cannot pin the head it reads")
    if not job:
        report(f"required context {context} declares no job id")
        return
    block = job_block(text, job)
    if block is None:
        report(f"{workflow} has no job named {job}, so {context} would never report")
        return
    name = re.search(r"(?m)^[ \t]{4}name:[ \t]*(.+?)[ \t]*$", block)
    if not name or name.group(1) != context:
        report(f"{workflow} job {job} does not report context {context} (found {name.group(1) if name else '<none>'})")
    if "scripts/resolve-release-pr-head.sh" not in block:
        report(f"{workflow} job {job} does not bind a dispatched run to the pull request head")
    if "inputs.release_head_sha" not in block:
        report(f"{workflow} job {job} does not consume the head SHA the lane dispatched")
    if item_checkout_proof and "git rev-parse HEAD" not in block:
        report(f"{workflow} job {job} does not prove the checkout is the resolved pull request head")
    if not item_checkout_proof and not str(entry_note).strip():
        report(f"{workflow} job {job} skips the checkout proof without stating why")
    # A ruleset-required context is evaluated from the code-owner review of the
    # pull request, so every script this job runs also runs on that event. A
    # script that branches on the event name must therefore map
    # pull_request_review the way it maps pull_request; otherwise the review run
    # fails closed after the approval and the ruleset keeps the pull request
    # blocked with no way to clear it. Scope: the script files the job block
    # names, matched by grep — inline workflow shell is covered by the trigger
    # and job checks above, not here.
    if item.get("rulesetRequired"):
        for script in sorted(script_refs(block)):
            script_path = root / script
            if not script_path.is_file():
                continue
            script_text = read(script_path)
            if not EVENT_NAME_BRANCH.search(script_text):
                continue
            if "pull_request_review" not in script_text and (job, script) not in reported_review_scripts:
                reported_review_scripts.add((job, script))
                report(
                    f"{workflow} job {job} runs {script}, which branches on the event name "
                    f"without a pull_request_review branch; the code-owner review would fail closed"
                )


for entry in producers:
    head = str(entry.get("head") or "")
    base = str(entry.get("base") or "")
    workflow = str(entry.get("workflow") or "")
    if not head or not base or not workflow:
        report("a producer entry is missing head, base or workflow")
        continue
    if base not in ("premain", "main"):
        report(f"producer {workflow} targets {base}, which is not a release branch")
    producer_checks(head, base, workflow)
    required = [item for item in contexts.get(base) or [] if item.get("context")]
    if not required:
        report(f"{base} declares no required context, so {head} has nothing to satisfy")
        continue
    if not any(item.get("rulesetRequired") for item in required):
        report(f"{base} declares no ruleset-required context")
    for item in required:
        context_checks(base, item)

producer_bases = {str(entry.get("base") or "") for entry in producers}
for base in contexts:
    if base not in producer_bases:
        report(f"{base} declares required contexts but no generated release pull request produces it")

sweep_workflow = str(sweep.get("workflow") or "")
sweep_path = workflows / sweep_workflow
if not sweep_workflow or not sweep_path.is_file():
    report(f"declared recovery sweep {sweep_workflow or '<empty>'} does not exist")
else:
    text = read(sweep_path)
    if not re.search(r"(?m)^  schedule:[ \t]*$", text):
        report(f"{sweep_workflow} has no schedule trigger, so a checkless release PR is never re-verified")
    if not re.search(r"(?m)^  workflow_dispatch:[ \t]*($|#)", text):
        report(f"{sweep_workflow} has no workflow_dispatch path")
    if not re.search(r"(?m)^[ \t]+pull-requests:[ \t]*write[ \t]*$", text):
        report(f"{sweep_workflow} cannot read or mark the release pull request")
    if not re.search(r"(?m)^[ \t]+actions:[ \t]*write[ \t]*$", text):
        report(f"{sweep_workflow} cannot dispatch the verifying workflow")
    if "scripts/sync-release-pr-checks.sh" not in text:
        report(f"{sweep_workflow} does not run the release check lane")
    if "--sweep" not in text:
        report(f"{sweep_workflow} does not run the release check lane in report-only sweep mode")
    for entry in producers:
        head = str(entry.get("head") or "")
        if head and head not in text:
            report(f"{sweep_workflow} does not cover the generated release branch {head}")

# The lane must dispatch the exact head it read, and the verifying workflow must
# be given that head to check. A dispatch that carries only the pull request
# number can start on a branch tip the pull request no longer contains.
lane_path = root / "scripts" / "sync-release-pr-checks.sh"
if lane_path.is_file():
    lane_text = read(lane_path)
    if 'release_head_sha=${head_sha}' not in lane_text:
        report("the release check lane does not dispatch the head SHA it read")
    if "--expected-head-sha" not in lane_text and "release_head_sha=${head_sha}" not in lane_text:
        report("the release check lane does not pass the recorded head SHA to the verifier")
    if "gh workflow run" not in lane_text and 'workflow run "${workflow}"' not in lane_text:
        report("the release check lane has no workflow dispatch path")

# The lane must run on the built-in token. A release-please token fallback makes
# the lane depend on a credential that does not exist, and a token identity would
# let the pull request authenticate as a person.
for workflow in sorted(workflows.glob("*.yml")) + sorted(workflows.glob("*.yaml")):
    name = workflow.name
    text = read(workflow)
    if "secrets.RELEASE_PLEASE_TOKEN" in text:
        report(f"{name} reintroduces the RELEASE_PLEASE_TOKEN identity")
    if re.search(r"secrets\.[A-Za-z0-9_]+[ \t]*\|\|[ \t]*secrets\.GITHUB_TOKEN", text):
        report(f"{name} declares a secret-to-GITHUB_TOKEN fallback; only the built-in token may gate the lane")

if failures:
    print("release-pr-check-lane: FAIL", file=sys.stderr)
    for failure in failures:
        print(f"- {failure}", file=sys.stderr)
    raise SystemExit(1)

print("release-pr-check-lane: PASS (every generated release PR has a head-bound dispatch path for each required context)")
PY
}

run_self_test() {
  local scratch
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/apptheory-release-pr-check-lane.XXXXXX")"
  # shellcheck disable=SC2064 # the path is expanded now; the local is gone at EXIT
  trap "rm -rf '${scratch}'" EXIT

  local guard="${root}/scripts/verify-release-pr-check-lane.sh"
  local cases=0

  expect_fixture_failure() {
    local label="$1"
    local expected="$2"
    local fixture="$3"
    local output
    cases=$((cases + 1))
    if output="$(bash "${guard}" --root "${fixture}" 2>&1)"; then
      echo "release-pr-check-lane self-test: FAIL (${label}; guard accepted the mutation)" >&2
      printf '%s\n' "${output}" >&2
      exit 1
    fi
    if ! grep -Fq -- "${expected}" <<<"${output}"; then
      echo "release-pr-check-lane self-test: FAIL (${label}; missing ${expected})" >&2
      printf '%s\n' "${output}" >&2
      exit 1
    fi
    echo "release-pr-check-lane self-test: PASS ${label}"
  }

  new_fixture() {
    local name="$1"
    local dir="${scratch}/${name}"
    mkdir -p "${dir}/.github/workflows" "${dir}/scripts"
    cp -R "${root}/.github/workflows/." "${dir}/.github/workflows/"
    cp "${root}/.github/release-lane.json" "${dir}/.github/release-lane.json"
    cp "${root}/scripts/sync-release-pr-checks.sh" "${dir}/scripts/sync-release-pr-checks.sh"
    # The review-event script check reads the script files the jobs name, so the
    # fixture carries exactly those and nothing else.
    python3 - "${root}" "${dir}" <<'PY'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
dest = Path(sys.argv[2])
text = (root / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
refs = {match.group(0) for match in re.finditer(r"scripts/[A-Za-z0-9_./-]+\.(?:sh|py|mjs)", text)}
for ref in sorted(refs):
    source = root / ref
    if not source.is_file():
        continue
    target = dest / ref
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
PY
    printf '%s\n' "${dir}"
  }

  # The unmodified copy passes: the guard reads only the declaration and the
  # workflows, so a faithful copy must be accepted before mutations mean anything.
  baseline="$(new_fixture baseline)"
  cases=$((cases + 1))
  if ! bash "${guard}" --root "${baseline}" >/dev/null 2>&1; then
    echo "release-pr-check-lane self-test: FAIL (the faithful copy of the real tree must pass)" >&2
    bash "${guard}" --root "${baseline}" >&2 || true
    exit 1
  fi
  echo "release-pr-check-lane self-test: PASS a faithful copy of the real tree passes"

  # 1. A producer that stops invoking the lane.
  fixture="$(new_fixture no-lane)"
  sed -i.bak '/scripts\/sync-release-pr-checks.sh/d' "${fixture}/.github/workflows/prerelease-pr.yml"
  rm -f "${fixture}/.github/workflows/prerelease-pr.yml.bak"
  expect_fixture_failure "a producer that stops attaching the lane fails" \
    "does not attach the required checks" "${fixture}"

  # 2. A producer that dispatches without the dispatch permission.
  fixture="$(new_fixture no-actions-write)"
  python3 - "${fixture}/.github/workflows/release-pr.yml" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
path.write_text(text.replace("  actions: write\n", "", 1), encoding="utf-8")
PY
  expect_fixture_failure "a producer without actions: write fails" \
    "does not declare actions: write" "${fixture}"

  # 3. The verifying workflow loses the head-SHA dispatch input, so nothing can
  #    pin the head the lane read.
  fixture="$(new_fixture no-head-sha-input)"
  python3 - "${fixture}/.github/workflows/ci.yml" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
out = [
    line
    for line in lines
    if line.strip() not in ("release_head_sha:", "release_pr_number:")
]
path.write_text("".join(out), encoding="utf-8")
PY
  expect_fixture_failure "a verifying workflow without the head-SHA dispatch input fails" \
    "has no release_head_sha dispatch input" "${fixture}"

  # 4. A verifying job that stops binding the run to the pull request head.
  fixture="$(new_fixture no-head-binding)"
  sed -i.bak 's|scripts/resolve-release-pr-head.sh|scripts/some-other-script.sh|g' \
    "${fixture}/.github/workflows/ci.yml"
  rm -f "${fixture}/.github/workflows/ci.yml.bak"
  expect_fixture_failure "a verifying job without the head binding fails" \
    "does not bind a dispatched run to the pull request head" "${fixture}"

  # 5. A verifying job that stops proving the checkout is the resolved head.
  fixture="$(new_fixture no-checkout-proof)"
  python3 - "${fixture}/.github/workflows/ci.yml" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
path.write_text(text.replace("git rev-parse HEAD", "git rev-parse --short HEAD"), encoding="utf-8")
PY
  expect_fixture_failure "a verifying job that stops proving the checkout fails" \
    "does not prove the checkout is the resolved pull request head" "${fixture}"

  # 6. A required context whose job id no longer matches the declaration would
  #    never report that context.
  fixture="$(new_fixture renamed-job)"
  sed -i.bak 's|^  release-security-gates:$|  release-security:|' \
    "${fixture}/.github/workflows/ci.yml"
  rm -f "${fixture}/.github/workflows/ci.yml.bak"
  expect_fixture_failure "a verifying job renamed away from its declaration fails" \
    "has no job named release-security-gates" "${fixture}"

  # 7. A job that reports a different context name than the ruleset requires.
  fixture="$(new_fixture renamed-context)"
  sed -i.bak 's|^    name: Release/security gates$|    name: Release security gates|' \
    "${fixture}/.github/workflows/ci.yml"
  rm -f "${fixture}/.github/workflows/ci.yml.bak"
  expect_fixture_failure "a job that reports a different context name fails" \
    "does not report context Release/security gates" "${fixture}"

  # 8. The recovery sweep removed: nothing re-verifies a checkless release PR.
  fixture="$(new_fixture no-sweep-workflow)"
  rm -f "${fixture}/.github/workflows/release-pr-check-sweep.yml"
  expect_fixture_failure "a missing recovery sweep fails" \
    "declared recovery sweep release-pr-check-sweep.yml does not exist" "${fixture}"

  # 9. A recovery sweep turned into a silent no-op.
  fixture="$(new_fixture sweep-without-mode)"
  sed -i.bak 's| --sweep||' "${fixture}/.github/workflows/release-pr-check-sweep.yml"
  rm -f "${fixture}/.github/workflows/release-pr-check-sweep.yml.bak"
  expect_fixture_failure "a sweep without its report-only mode fails" \
    "does not run the release check lane in report-only sweep mode" "${fixture}"

  # 10. A credential fallback reintroduced anywhere in the workflow set.
  fixture="$(new_fixture token-fallback)"
  printf '\n# fallback for the record\n# token: ${{ secrets.RELEASE_PLEASE_TOKEN }}\n' \
    >>"${fixture}/.github/workflows/release.yml"
  expect_fixture_failure "a reintroduced release-please token fails" \
    "reintroduces the RELEASE_PLEASE_TOKEN identity" "${fixture}"

  fixture="$(new_fixture secret-or-token-fallback)"
  printf '\n# fallback for the record\n# token: ${{ secrets.SOMETHING || secrets.GITHUB_TOKEN }}\n' \
    >>"${fixture}/.github/workflows/release.yml"
  expect_fixture_failure "a secret-to-token fallback fails" \
    "declares a secret-to-GITHUB_TOKEN fallback" "${fixture}"

  # 11. The declaration losing a generated release pull request.
  fixture="$(new_fixture declaration-without-producer)"
  python3 - "${fixture}/.github/release-lane.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
data["generatedReleasePullRequests"] = data["generatedReleasePullRequests"][:1]
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
  expect_fixture_failure "a declaration without a producer fails" \
    "declares required contexts but no generated release pull request produces it" "${fixture}"

  # 11b. A verifying workflow that loses the eligible-event trigger: its
  #      dispatched check runs would exist but never satisfy the ruleset.
  fixture="$(new_fixture no-review-trigger)"
  python3 - "${fixture}/.github/workflows/ci.yml" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
out: list[str] = []
skipping = False
for line in lines:
    if line.rstrip("\n") == "  pull_request_review:":
        skipping = True
        continue
    if skipping:
        if line.startswith("    "):
            continue
        skipping = False
    out.append(line)
path.write_text("".join(out), encoding="utf-8")
PY
  expect_fixture_failure "a verifying workflow without the eligible-event trigger fails" \
    "has no pull_request_review trigger" "${fixture}"

  # 11c. A script a ruleset-required job runs loses its review branch. The
  #      trigger is still there, so the workflow starts; the script then fails
  #      closed after the approval and nothing can clear the ruleset.
  fixture="$(new_fixture script-without-review-branch)"
  python3 - "${fixture}/scripts/verify-release-branch-signatures.sh" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
path.write_text(text.replace("pull_request_review", "pull_request"), encoding="utf-8")
PY
  expect_fixture_failure "a review-run script without a pull_request_review branch fails" \
    "branches on the event name without a pull_request_review branch" "${fixture}"

  # 12. The head-binding resolver itself. A stub `gh` answers the pull request
  #     read, so every hostile answer runs through the real validation.
  local resolver="${root}/scripts/resolve-release-pr-head.sh"
  local stub_dir="${scratch}/stub"
  mkdir -p "${stub_dir}"
  cat >"${stub_dir}/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "${GH_STUB_PAYLOAD}"
STUB
  chmod +x "${stub_dir}/gh"

  resolver_case() {
    local label="$1"
    local expected="$2"
    local expect_success="$3"
    local payload="$4"
    local pr="$5"
    local ref_name="$6"
    local ref_sha="$7"
    local output
    cases=$((cases + 1))
    local -a args=(--repo theory-cloud/AppTheory --pr "${pr}" --ref-name "${ref_name}" --ref-sha "${ref_sha}")
    output="$(GH_BIN="${stub_dir}/gh" GH_STUB_PAYLOAD="${payload}" \
      bash "${resolver}" "${args[@]}" 2>&1)" && status=0 || status=$?
    if [[ "${expect_success}" == "true" ]]; then
      if [[ "${status}" -ne 0 ]] || ! grep -Fq -- "${expected}" <<<"${output}"; then
        echo "release-pr-check-lane self-test: FAIL (${label})" >&2
        printf '%s\n' "${output}" >&2
        exit 1
      fi
    else
      if [[ "${status}" -eq 0 ]] || ! grep -Fq -- "${expected}" <<<"${output}"; then
        echo "release-pr-check-lane self-test: FAIL (${label})" >&2
        printf '%s\n' "${output}" >&2
        exit 1
      fi
    fi
    echo "release-pr-check-lane self-test: PASS ${label}"
  }

  local sha_head sha_other
  sha_head="1111111111111111111111111111111111111111"
  sha_other="2222222222222222222222222222222222222222"

  payload() {
    local state="$1"
    local base="$2"
    local head_repo="$3"
    local head_ref="$4"
    local head_sha="$5"
    local number="$6"
    local title="$7"
    printf '{"number": %s, "state": "%s", "title": "%s", "merged": false, "base": {"ref": "%s", "sha": "3333333333333333333333333333333333333333", "repo": {"full_name": "theory-cloud/AppTheory"}}, "head": {"ref": "%s", "sha": "%s", "repo": {"full_name": "%s"}}}' \
      "${number}" "${state}" "${title}" "${base}" "${head_ref}" "${head_sha}" "${head_repo}"
  }

  resolver_case "the resolver accepts the exact pull request head" \
    "head_sha=${sha_head}" true \
    "$(payload open premain theory-cloud/AppTheory release-please--branches--premain "${sha_head}" 1296 "fix(premain): release 7.4.0-rc")" \
    1296 release-please--branches--premain "${sha_head}"
  resolver_case "the resolver refuses a moved head" \
    "!= generated release PR head" false \
    "$(payload open premain theory-cloud/AppTheory release-please--branches--premain "${sha_other}" 1296 "fix(premain): release 7.4.0-rc")" \
    1296 release-please--branches--premain "${sha_head}"
  resolver_case "the resolver refuses a closed pull request" \
    "is closed, not open" false \
    "$(payload closed premain theory-cloud/AppTheory release-please--branches--premain "${sha_head}" 1296 "fix(premain): release 7.4.0-rc")" \
    1296 release-please--branches--premain "${sha_head}"
  resolver_case "the resolver refuses a foreign head repository" \
    "head repository" false \
    "$(payload open premain someone/AppTheory release-please--branches--premain "${sha_head}" 1296 "fix(premain): release 7.4.0-rc")" \
    1296 release-please--branches--premain "${sha_head}"
  resolver_case "the resolver refuses a non-release base" \
    "not a release branch" false \
    "$(payload open staging theory-cloud/AppTheory release-please--branches--premain "${sha_head}" 1296 "fix(premain): release 7.4.0-rc")" \
    1296 release-please--branches--premain "${sha_head}"
  resolver_case "the resolver refuses a different head branch" \
    "!= generated release PR head" false \
    "$(payload open premain theory-cloud/AppTheory release-please--branches--main "${sha_head}" 1296 "fix(premain): release 7.4.0-rc")" \
    1296 release-please--branches--premain "${sha_head}"
  resolver_case "the resolver refuses a non-numeric pull request" \
    "must be numeric" false \
    "$(payload open premain theory-cloud/AppTheory release-please--branches--premain "${sha_head}" 1296 "fix(premain): release 7.4.0-rc")" \
    release-please release-please--branches--premain "${sha_head}"

  echo "release-pr-check-lane self-test: PASS (${cases} cases)"
}

check

if [[ "${self_test}" == "true" ]]; then
  run_self_test
fi
