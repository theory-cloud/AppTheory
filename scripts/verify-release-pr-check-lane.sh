#!/usr/bin/env bash
set -euo pipefail

# Release-lane guard: the required contexts of a generated release pull request
# are reported by the code-owner review of that pull request, and by nothing
# else.
#
# The failure this prevents is a release lane that looks wired but cannot gate
# itself. release-please (and the artifact sync) create and update their pull
# requests with the built-in token, and GitHub starts no `pull_request` workflow
# for events that token causes. GitHub also evaluates a required status check
# only for a run triggered by an eligible event, and a `workflow_dispatch` run
# is not one of them. A self-dispatch lane therefore reports check runs that no
# ruleset counts, and a generated release pull request can never become
# mergeable through it.
#
# The eligible event this repository can produce without a credential is the
# code-owner approval the premain/main ruleset already requires: `ci.yml` runs
# on `pull_request_review: [submitted]` and reports the release checks against
# the reviewed pull request's own base, head and head SHA. This guard proves
# that lane:
#
#   1. the declaration in `.github/release-lane.json` names, per release branch,
#      the required contexts, the workflow that reports each one and the job that
#      carries the context name, and names no scheduled recovery sweep;
#   2. the reporting workflow declares the eligible `pull_request_review`
#      trigger for the submitted activity on both release branches;
#   3. every declared context is a job in that workflow, reports its exact
#      context name, reads the reviewed pull request from
#      `github.event.pull_request.*`, and carries no dispatch-only path;
#   4. the producers hand the generated pull request to that review: they mark
#      the draft release pull request ready at one head, restore the draft lock
#      if the head moves, and never dispatch a workflow or hold the `actions`
#      scope they only needed to dispatch;
#   5. no workflow runs on a clock, and no workflow reintroduces a
#      release-please token or a secret-to-token fallback: the lane runs on the
#      built-in token only;
#   6. a script that a ruleset-required job runs models the review event for
#      every event-dependent input it reads: a script that branches on the event
#      name has a `pull_request_review` branch, a script that reads
#      GITHUB_BASE_REF/GITHUB_HEAD_REF (which GitHub sets only for
#      `pull_request`/`pull_request_target`) also reads them from the review
#      event, and a script that skips when it cannot derive its branch does not
#      let a review event reach that skip. Otherwise the code-owner review would
#      fail closed after the approval, or pass without validating.
#
# The self-test proves the guard is not vacuous: it mutates copies of the real
# workflows and declaration and requires each mutation to fail.
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

Fails when a generated release pull request's required contexts are not
reported by the code-owner review lane, when a producer stops handing its
draft release pull request to that review, or when a workflow reintroduces a
clock, a dispatch-only path or a credential into the lane. --self-test
additionally proves the guard rejects hostile shapes.
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
reported_review_scripts: set[tuple[str, str, str]] = set()


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
if not producers:
    print("release-pr-check-lane: FAIL (declaration names no generated release pull request)", file=sys.stderr)
    raise SystemExit(1)
# A scheduled recovery sweep re-dispatched the verifying workflow. GitHub never
# counted those runs, so the lane is gone; the declaration must not name one.
if data.get("recoverySweep") or data.get("schedule"):
    report("the declaration names a scheduled recovery sweep; the code-owner review is the only eligible event")

JOB_BLOCK = r"(?ms)^  {job}:\n(?P<block>.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)"
# Scripts a job invokes, and the runtime event-name read a script must map onto
# the code-owner review. A workflow expression (`github.event_name`) is expanded
# before a script runs, so the runtime signal for a script is the
# GITHUB_EVENT_NAME environment variable. Both checks are grep-level by design:
# the guard proves the review branch is present, not that every path inside the
# script reaches it.
SCRIPT_REF = re.compile(r"scripts/[A-Za-z0-9_./-]+\.(?:sh|py|mjs)")
EVENT_NAME_BRANCH = re.compile(r"GITHUB_EVENT_NAME")
# GITHUB_BASE_REF and GITHUB_HEAD_REF are set only for pull_request and
# pull_request_target runs, so a script that reads them must also read the same
# refs from a review event: the step's PR_BASE_REF/PR_HEAD_REF or the payload.
PULL_REQUEST_ONLY_REF = re.compile(r"\$\{?(?:GITHUB_BASE_REF|GITHUB_HEAD_REF)\b")
REVIEW_REF_SOURCE = re.compile(r"\bPR_BASE_REF\b|\bPR_HEAD_REF\b|\bGITHUB_EVENT_PATH\b")
# A skip-and-exit-0 path is a state where the required context reports success
# without checking anything. A review event starts the job on
# `refs/pull/<n>/merge`, whose ref name is `<n>/merge`, so a script that skips an
# unmodelled branch must first be sure it is not a review.
SKIP_EXIT = re.compile(r"(?m)^[^\n]*\bSKIP\b[^\n]*\n(?:[ \t][^\n]*\n){0,3}?[ \t]*exit 0\b")
# The reviewed pull request is the only source of the base, head and head SHA a
# review run may validate. GITHUB_BASE_REF/GITHUB_HEAD_REF are unset on that
# event and the dispatch inputs no longer exist.
REVIEW_PAYLOAD = re.compile(r"github\.event\.pull_request\.")
DISPATCH_LEFTOVER = re.compile(r"workflow_dispatch|inputs\.release_")


def job_block(text: str, job: str) -> str | None:
    match = re.search(JOB_BLOCK.format(job=re.escape(job)), text)
    return match.group("block") if match else None


def script_refs(block: str) -> set[str]:
    return {match.group(0) for match in SCRIPT_REF.finditer(block)}


def review_trigger_block(text: str) -> str | None:
    """The body of the `pull_request_review:` trigger entry, or None."""
    lines = text.splitlines()
    collected: list[str] = []
    inside = False
    for line in lines:
        if line.rstrip() == "  pull_request_review:":
            inside = True
            continue
        if inside:
            if line.startswith("  ") and not line.startswith("    "):
                break
            collected.append(line)
    return "\n".join(collected) if inside else None


def review_trigger_branches(trigger: str) -> set[str]:
    """The base branches a `pull_request_review` trigger is filtered to.

    An absent `branches:` filter means every base branch, which covers both
    release branches. The flow form (`branches: [a, b]`) and the block form are
    both read, so a narrowed filter cannot pass as a substring match.
    """
    lines = trigger.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"^[ \t]+branches:[ \t]*(.*)$", line)
        if not match:
            continue
        inline = match.group(1).strip()
        if inline:
            return {item.strip().strip("'\"") for item in inline.strip("[]").split(",") if item.strip()}
        branches: set[str] = set()
        for follow in lines[index + 1 :]:
            item = re.match(r"^[ \t]+-[ \t]*(.+)$", follow)
            if not item:
                break
            branches.add(item.group(1).strip().strip("'\""))
        return branches
    return {"premain", "main"}


def review_trigger_types(trigger: str) -> set[str] | None:
    """The activity types a `pull_request_review` trigger subscribes to.

    Returns None when the trigger declares no `types:` filter. GitHub defaults an
    unfiltered review trigger to every activity, which includes dismissals and
    comments, so an absent filter is not the submitted-only approval the lane
    needs. The flow form (`types: [submitted]`) and the block form are both read,
    and the whole set is compared, so a superset cannot pass as a substring.
    """
    lines = trigger.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"^[ \t]+types:[ \t]*(.*)$", line)
        if not match:
            continue
        inline = match.group(1).strip()
        if inline:
            return {item.strip().strip("'\"") for item in inline.strip("[]").split(",") if item.strip()}
        types: set[str] = set()
        for follow in lines[index + 1 :]:
            item = re.match(r"^[ \t]+-[ \t]*(.+)$", follow)
            if not item:
                break
            types.add(item.group(1).strip().strip("'\""))
        return types
    return None


def job_condition(block: str) -> str | None:
    """The job's `if:` expression, including its folded or literal block form."""
    lines = block.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"^[ \t]{4}if:[ \t]*(.*)$", line)
        if not match:
            continue
        value = match.group(1).strip()
        if value in (">", "|", ">-", "|-", ">+", "|+"):
            collected: list[str] = []
            for follow in lines[index + 1 :]:
                if follow.strip() and not follow.startswith("      "):
                    break
                collected.append(follow.strip())
            return " ".join(part for part in collected if part)
        return value
    return None


# A job `if:` is evaluated, not grepped. A positive review branch and a negative
# `!= 'pull_request'` gate both admit the code-owner review, and a `!=
# 'pull_request_review'` term excludes it while containing the name, so a
# substring check would be wrong in both directions. The parser below models the
# subset GitHub expressions use in ci.yml: comparisons, `&&`, `||`, `!` and
# parentheses. An unmodelled identifier fails closed rather than passing by
# default.
_EXPR_TOKEN = re.compile(r"\s*(?:(\(|\)|&&|\|\||==|!=|!)|('[^']*')|([A-Za-z_][A-Za-z0-9_.]*))")


def tokenize_condition(expression: str) -> list[tuple[str, str]]:
    expression = expression.strip()
    tokens: list[tuple[str, str]] = []
    position = 0
    while position < len(expression):
        match = _EXPR_TOKEN.match(expression, position)
        if not match:
            raise ValueError(f"unsupported token at {expression[position:]!r}")
        position = match.end()
        if match.group(1):
            tokens.append(("op", match.group(1)))
        elif match.group(2) is not None:
            tokens.append(("str", match.group(2)[1:-1].replace("''", "'")))
        else:
            tokens.append(("ident", match.group(3)))
    return tokens


class _ConditionParser:
    def __init__(self, tokens: list[tuple[str, str]]) -> None:
        self.tokens = tokens
        self.index = 0

    def peek(self) -> tuple[str, str] | None:
        return self.tokens[self.index] if self.index < len(self.tokens) else None

    def take(self, expected: tuple[str, str] | None = None) -> tuple[str, str]:
        token = self.peek()
        if token is None:
            raise ValueError("unexpected end of expression")
        if expected is not None and token != expected:
            raise ValueError(f"expected {expected!r}, found {token!r}")
        self.index += 1
        return token

    def parse(self) -> tuple:
        node = self.parse_or()
        if self.peek() is not None:
            raise ValueError(f"unexpected trailing token {self.peek()!r}")
        return node

    def parse_or(self) -> tuple:
        node = self.parse_and()
        while self.peek() == ("op", "||"):
            self.take()
            node = ("or", node, self.parse_and())
        return node

    def parse_and(self) -> tuple:
        node = self.parse_comparison()
        while self.peek() == ("op", "&&"):
            self.take()
            node = ("and", node, self.parse_comparison())
        return node

    # GitHub binds `!` tighter than `==` and `!=`, so `!x == y` is `(!x) == y`.
    # Comparison therefore sits above unary negation in the grammar; otherwise a
    # condition like `!github.event_name == 'pull_request'` would parse as
    # `not(x == y)` and wrongly admit a job that never runs.
    def parse_comparison(self) -> tuple:
        left = self.parse_unary()
        if self.peek() in (("op", "=="), ("op", "!=")):
            operator = self.take()[1]
            return (operator, left, self.parse_unary())
        if left[0] == "lit":
            raise ValueError("a literal cannot stand alone as a condition")
        return left

    def parse_unary(self) -> tuple:
        if self.peek() == ("op", "!"):
            self.take()
            return ("not", self.parse_unary())
        return self.parse_atom()

    def parse_atom(self) -> tuple:
        if self.peek() == ("op", "("):
            self.take()
            node = self.parse_or()
            self.take(("op", ")"))
            return node
        if self.peek() is None:
            raise ValueError("unexpected end of expression")
        return self.parse_operand()

    def parse_operand(self) -> tuple:
        token = self.take()
        if token[0] == "str":
            return ("lit", token[1])
        if token[0] == "ident":
            if token[1] in ("true", "false"):
                return ("lit", token[1] == "true")
            return ("ident", token[1])
        raise ValueError(f"unexpected operand {token!r}")


def evaluate_condition(node: tuple, state: dict[str, object]) -> object:
    kind = node[0]
    if kind == "or":
        return evaluate_condition(node[1], state) or evaluate_condition(node[2], state)
    if kind == "and":
        return evaluate_condition(node[1], state) and evaluate_condition(node[2], state)
    if kind == "not":
        return not evaluate_condition(node[1], state)
    if kind == "==":
        return evaluate_condition(node[1], state) == evaluate_condition(node[2], state)
    if kind == "!=":
        return evaluate_condition(node[1], state) != evaluate_condition(node[2], state)
    if kind == "lit":
        return node[1]
    if kind == "ident":
        if node[1] not in state:
            raise ValueError(f"unmodelled identifier {node[1]!r}")
        return state[node[1]]
    raise ValueError(f"unsupported node {kind!r}")


def runs_on_generated_release_review(condition: str, base: str) -> bool:
    """Whether a job `if:` is true for a submitted code-owner review of the
    generated release pull request that merges into `base`."""
    state: dict[str, object] = {
        "github.event_name": "pull_request_review",
        "github.event.pull_request.base.ref": base,
        "github.event.pull_request.head.ref": f"release-please--branches--{base}",
        "github.event.pull_request.draft": False,
        "github.repository": "theory-cloud/AppTheory",
    }
    node = _ConditionParser(tokenize_condition(condition)).parse()
    return bool(evaluate_condition(node, state))


def producer_checks(head: str, base: str, workflow: str) -> None:
    path = workflows / workflow
    if not path.is_file():
        report(f"declared producer {workflow} does not exist")
        return
    text = read(path)
    if not re.search(r"(?m)^[ \t]+pull-requests:[ \t]*write[ \t]*$", text):
        report(f"{workflow} creates a pull request but does not declare pull-requests: write")
    if "gh workflow run" in text:
        report(f"{workflow} dispatches the verifying workflow; a dispatched run never satisfies a required check")
    if re.search(r"(?m)^[ \t]+actions:[ \t]*write[ \t]*$", text):
        report(f"{workflow} still holds actions: write; the producer only needed it to dispatch")
    if "sync-release-pr-checks" in text:
        report(f"{workflow} still runs the removed self-dispatch lane")
    if not re.search(r"(?m)^[ \t]+gh pr ready \"\$\{RELEASE_PR_NUMBER\}\"[ \t]*$", text):
        report(f"{workflow} does not hand the generated draft pull request to the code-owner review")
    if not re.search(r"(?m)gh pr ready \"\$\{RELEASE_PR_NUMBER\}\" --undo", text):
        report(f"{workflow} does not restore the draft lock when the head moves while marking ready")
    if base not in contexts:
        report(f"{workflow} targets {base}, which the declaration gives no required contexts")


def context_checks(base: str, item: dict) -> None:
    context = str(item.get("context") or "")
    workflow = str(item.get("workflow") or "")
    job = str(item.get("job") or "")
    path = workflows / workflow
    if not path.is_file():
        report(f"required context {context} names a missing workflow {workflow}")
        return
    text = read(path)
    trigger = review_trigger_block(text)
    if trigger is None:
        report(f"{workflow} has no pull_request_review trigger, so the code-owner review can never make {context} count")
    else:
        review_types = review_trigger_types(trigger)
        if review_types != {"submitted"}:
            found = "no types filter" if review_types is None else ", ".join(sorted(review_types))
            report(
                f"{workflow} does not subscribe the pull_request_review trigger to exactly "
                f"the submitted activity (found {found})"
            )
        if base not in review_trigger_branches(trigger):
            report(f"{workflow} does not cover the {base} base in its pull_request_review trigger")
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
    if not REVIEW_PAYLOAD.search(block):
        report(f"{workflow} job {job} does not read the reviewed pull request from github.event.pull_request.*")
    # A declared required context is evaluated from the code-owner review of the
    # pull request. A job condition that is false for a submitted review of the
    # generated release pull request never reports there, so the declaration
    # would claim a context the review can never make count.
    condition = job_condition(block)
    if condition is not None:
        try:
            reports_on_review = runs_on_generated_release_review(condition, base)
        except ValueError as exc:
            report(
                f"{workflow} job {job} condition cannot be modelled ({exc}); "
                f"the guard cannot prove the code-owner review reaches {context}"
            )
        else:
            if not reports_on_review:
                report(
                    f"{workflow} job {job} cannot report on the code-owner review of a generated release PR; "
                    f"its if: is false for a submitted review into {base}"
                )
    leftover = DISPATCH_LEFTOVER.search(block)
    if leftover:
        report(f"{workflow} job {job} carries a dispatch-only path ({leftover.group(0)}); nothing dispatches it any more")
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
            if EVENT_NAME_BRANCH.search(script_text):
                if "pull_request_review" not in script_text and (job, script, "event") not in reported_review_scripts:
                    reported_review_scripts.add((job, script, "event"))
                    report(
                        f"{workflow} job {job} runs {script}, which branches on the event name "
                        f"without a pull_request_review branch; the code-owner review would fail closed"
                    )
            if PULL_REQUEST_ONLY_REF.search(script_text) and not REVIEW_REF_SOURCE.search(script_text):
                if (job, script, "refs") not in reported_review_scripts:
                    reported_review_scripts.add((job, script, "refs"))
                    report(
                        f"{workflow} job {job} runs {script}, which reads GITHUB_BASE_REF/GITHUB_HEAD_REF "
                        f"without a review-event source (PR_BASE_REF/PR_HEAD_REF or GITHUB_EVENT_PATH); "
                        f"GitHub sets those variables only for pull_request, so the review run cannot derive "
                        f"the pull request the ruleset requires it to validate"
                    )
            if SKIP_EXIT.search(script_text) and "pull_request_review" not in script_text:
                if (job, script, "skip") not in reported_review_scripts:
                    reported_review_scripts.add((job, script, "skip"))
                    report(
                        f"{workflow} job {job} runs {script}, which skips when it cannot derive its branch; "
                        f"a pull_request_review run starts on refs/pull/<n>/merge and reaches that skip, "
                        f"so the required context would report success without validating"
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
    if head != f"release-please--branches--{base}":
        report(f"producer {workflow} names head {head or '<empty>'}, which is not the generated release branch for {base}")
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

# The lane must run on the built-in token, must not schedule work, and must not
# reintroduce the removed self-dispatch path. A release-please token fallback
# makes the lane depend on a credential that does not exist, and a token
# identity would let the pull request authenticate as a person.
for workflow in sorted(workflows.glob("*.yml")) + sorted(workflows.glob("*.yaml")):
    name = workflow.name
    text = read(workflow)
    if re.search(r"(?m)^  schedule:", text):
        report(f"{name} declares an on: schedule trigger; no workflow may run on a clock")
    if "release-pr-check-sweep" in text or "sync-release-pr-checks" in text:
        report(f"{name} names the removed self-dispatch lane")
    if "secrets.RELEASE_PLEASE_TOKEN" in text:
        report(f"{name} reintroduces the RELEASE_PLEASE_TOKEN identity")
    if re.search(r"secrets\.[A-Za-z0-9_]+[ \t]*\|\|[ \t]*secrets\.GITHUB_TOKEN", text):
        report(f"{name} declares a secret-to-GITHUB_TOKEN fallback; only the built-in token may gate the lane")

if failures:
    print("release-pr-check-lane: FAIL", file=sys.stderr)
    for failure in failures:
        print(f"- {failure}", file=sys.stderr)
    raise SystemExit(1)

print("release-pr-check-lane: PASS (the code-owner review reports every required release context)")
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

  # 1. A declaration that reintroduces a scheduled recovery sweep.
  fixture="$(new_fixture declaration-with-sweep)"
  python3 - "${fixture}/.github/release-lane.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
data["recoverySweep"] = {"workflow": "release-pr-check-sweep.yml", "schedule": "*/20 * * * *"}
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
  expect_fixture_failure "a declared recovery sweep fails" \
    "names a scheduled recovery sweep" "${fixture}"

  # 2. The eligible-event trigger removed: no review run can ever report.
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
  expect_fixture_failure "a reporting workflow without the eligible-event trigger fails" \
    "has no pull_request_review trigger" "${fixture}"

  # 3. The review trigger subscribed to an activity that is not an approval.
  fixture="$(new_fixture wrong-review-activity)"
  sed -i.bak 's|    types: \[submitted\]|    types: [dismissed]|' "${fixture}/.github/workflows/ci.yml"
  rm -f "${fixture}/.github/workflows/ci.yml.bak"
  expect_fixture_failure "a review trigger without the submitted activity fails" \
    "does not subscribe the pull_request_review trigger to exactly the submitted activity" "${fixture}"

  # 3b. The review trigger widened to a superset. A dismissal is not an
  #     approval, so subscribing to one alongside `submitted` would let the lane
  #     report on an event that carries no approval at all.
  fixture="$(new_fixture review-activity-superset)"
  sed -i.bak 's|    types: \[submitted\]|    types: [submitted, dismissed]|' "${fixture}/.github/workflows/ci.yml"
  rm -f "${fixture}/.github/workflows/ci.yml.bak"
  expect_fixture_failure "a review trigger widened to a superset fails" \
    "does not subscribe the pull_request_review trigger to exactly the submitted activity" "${fixture}"

  # 4. The review trigger narrowed away from a release branch.
  fixture="$(new_fixture review-trigger-omits-main)"
  sed -i.bak 's|    branches: \[premain, main\]|    branches: [premain]|' "${fixture}/.github/workflows/ci.yml"
  rm -f "${fixture}/.github/workflows/ci.yml.bak"
  expect_fixture_failure "a review trigger that omits main fails" \
    "does not cover the main base" "${fixture}"

  # 5. A required context whose job id no longer matches the declaration would
  #    never report that context.
  fixture="$(new_fixture renamed-job)"
  sed -i.bak 's|^  release-security-gates:$|  release-security:|' \
    "${fixture}/.github/workflows/ci.yml"
  rm -f "${fixture}/.github/workflows/ci.yml.bak"
  expect_fixture_failure "a reporting job renamed away from its declaration fails" \
    "has no job named release-security-gates" "${fixture}"

  # 6. A job that reports a different context name than the ruleset requires.
  fixture="$(new_fixture renamed-context)"
  sed -i.bak 's|^    name: Release/security gates$|    name: Release security gates|' \
    "${fixture}/.github/workflows/ci.yml"
  rm -f "${fixture}/.github/workflows/ci.yml.bak"
  expect_fixture_failure "a job that reports a different context name fails" \
    "does not report context Release/security gates" "${fixture}"

  # 6b. Prefix `!` binds tighter than `==`, so `!github.event_name ==
  #     'pull_request'` is `(!github.event_name) == 'pull_request'`: false for a
  #     review event. A guard that parses it as `not(x == y)` accepts a job that
  #     never runs on the code-owner review.
  fixture="$(new_fixture negated-event-name)"
  python3 - "${fixture}/.github/workflows/ci.yml" <<'PYEOF'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
pattern = re.compile(
    r"(?m)^(?P<indent>[ \t]+)if: \(github\.event_name == 'pull_request' \|\| github\.event_name == 'pull_request_review'\)"
    r" && .*release-please--branches--premain.*$"
)
replaced, count = pattern.subn(
    lambda match: f"{match.group('indent')}if: !github.event_name == 'pull_request'",
    text,
)
if count != 1:
    raise SystemExit(f"expected one generated-release job condition, replaced {count}")
path.write_text(replaced, encoding="utf-8")
PYEOF
  expect_fixture_failure "a prefix-negated event name is not read as a whole comparison" \
    "cannot report on the code-owner review" "${fixture}"

  # 7. A reporting job that stops reading the reviewed pull request: on a review
  #    run GITHUB_BASE_REF/GITHUB_HEAD_REF are unset, so the job has nothing to
  #    validate.
  fixture="$(new_fixture job-without-review-payload)"
  python3 - "${fixture}/.github/workflows/ci.yml" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
block = re.search(r"(?ms)^  release-security-gates:\n(?P<block>.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)", text)
assert block, "fixture is missing the release-security-gates job"
mutation = block.group("block").replace("github.event.pull_request.", "github.event.base_ref.")
path.write_text(text.replace(block.group("block"), mutation, 1), encoding="utf-8")
PY
  expect_fixture_failure "a reporting job without the reviewed pull request fails" \
    "does not read the reviewed pull request" "${fixture}"

  # 7b. The release-delta smoke gated only on `pull_request`. A generated release
  #     pull request is created and updated with the built-in token, so its
  #     `pull_request` events never start a run; without the review branch the
  #     declared context can never report while the declaration and docs still
  #     claim it does.
  fixture="$(new_fixture release-delta-without-review-branch)"
  python3 - "${fixture}/.github/workflows/ci.yml" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
review = "(github.event_name == 'pull_request' || github.event_name == 'pull_request_review')"
assert review in text, "fixture is missing the release-delta review branch"
path.write_text(text.replace(review, "github.event_name == 'pull_request'", 1), encoding="utf-8")
PY
  expect_fixture_failure "a release-delta job gated only on pull_request fails" \
    "cannot report on the code-owner review of a generated release PR" "${fixture}"

  # 8. A dispatch-only path creeping back into a reporting job.
  fixture="$(new_fixture job-with-dispatch-path)"
  python3 - "${fixture}/.github/workflows/ci.yml" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
text = text.replace(
    "      - name: Verify versions match VERSION\n",
    "      - name: Bind a dispatched run\n        if: github.event_name == 'workflow_dispatch'\n        run: echo dispatch\n      - name: Verify versions match VERSION\n",
    1,
)
path.write_text(text, encoding="utf-8")
PY
  expect_fixture_failure "a reporting job with a dispatch-only path fails" \
    "carries a dispatch-only path" "${fixture}"

  # 9. A producer that starts dispatching the verifying workflow again.
  fixture="$(new_fixture producer-dispatches)"
  printf '\n# lane fallback\n# run: gh workflow run ci.yml\n' >>"${fixture}/.github/workflows/release-pr.yml"
  expect_fixture_failure "a producer that dispatches fails" \
    "dispatches the verifying workflow" "${fixture}"

  # 10. A producer that stops handing its draft to the code-owner review.
  fixture="$(new_fixture producer-without-ready)"
  python3 - "${fixture}/.github/workflows/prerelease-pr.yml" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
text = text.replace('          gh pr ready "${RELEASE_PR_NUMBER}"\n', "", 1)
path.write_text(text, encoding="utf-8")
PY
  expect_fixture_failure "a producer that never marks its pull request ready fails" \
    "does not hand the generated draft pull request to the code-owner review" "${fixture}"

  # 11. A clock reintroduced anywhere in the workflow set.
  fixture="$(new_fixture scheduled-workflow)"
  python3 - "${fixture}/.github/workflows/ci.yml" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
text = text.replace(
    "  pull_request_review:\n",
    "  schedule:\n    - cron: '*/20 * * * *'\n  pull_request_review:\n",
    1,
)
path.write_text(text, encoding="utf-8")
PY
  expect_fixture_failure "a workflow that runs on a clock fails" \
    "declares an on: schedule trigger" "${fixture}"

  # 12. A credential fallback reintroduced anywhere in the workflow set.
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

  # 13. A declaration losing a generated release pull request.
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

  # 14. A script a ruleset-required job runs loses its review branch. The
  #     trigger is still there, so the workflow starts; the script then fails
  #     closed after the approval and nothing can clear the ruleset.
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

  # 15. A ruleset-required script keeps the pull_request-only refs but loses
  #     the review-event source.
  fixture="$(new_fixture script-without-review-ref-source)"
  python3 - "${fixture}/scripts/verify-branch-version-sync.sh" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
for name in ("PR_BASE_REF", "PR_HEAD_REF", "GITHUB_EVENT_PATH"):
    text = text.replace(name, f"{name}_LEGACY")
path.write_text(text, encoding="utf-8")
PY
  expect_fixture_failure "a review-run script reading only the pull_request refs fails" \
    "without a review-event source" "${fixture}"

  # 16. A ruleset-required script that skips on a branch it cannot derive. A
  #     review run reaches that skip on `refs/pull/<n>/merge`, so the required
  #     context would report success without checking anything.
  fixture="$(new_fixture script-that-skips-on-review)"
  python3 - "${fixture}/scripts/verify-branch-version-sync.sh" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
for name in ("pull_request_review", "PR_BASE_REF", "PR_HEAD_REF", "GITHUB_EVENT_PATH"):
    text = text.replace(name, "")
path.write_text(text, encoding="utf-8")
PY
  expect_fixture_failure "a review-run script that skips an underivable branch fails" \
    "skips when it cannot derive its branch" "${fixture}"

  echo "release-pr-check-lane self-test: PASS (${cases} cases)"
}

check

if [[ "${self_test}" == "true" ]]; then
  run_self_test
fi
