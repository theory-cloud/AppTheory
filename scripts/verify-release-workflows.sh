#!/usr/bin/env bash
# Purpose: verify GitHub release workflows preserve the immutable release contract.
# --self-test runs the pairing-invocation attack battery without the rest of the pins.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

mode="verify"
case "${1:-}" in
  "") ;;
  --self-test) mode="self-test" ;;
  *)
    echo "usage: scripts/verify-release-workflows.sh [--self-test]" >&2
    exit 2
    ;;
esac

RELEASE_WORKFLOWS_MODE="${mode}" python3 - <<'PY'
import os
import re
import subprocess
from pathlib import Path

MODE = os.environ.get("RELEASE_WORKFLOWS_MODE", "verify")


def require_contains(path: str, needle: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    if needle not in text:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing {needle!r} in {path})")


def require_not_contains(path: str, needle: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    if needle in text:
        raise SystemExit(f"release-workflows: FAIL ({description}; unexpected {needle!r} in {path})")


def require_order(path: str, first: str, second: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    first_index = text.find(first)
    second_index = text.find(second)
    if first_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing {first!r} in {path})")
    if second_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing {second!r} in {path})")
    if first_index >= second_index:
        raise SystemExit(
            f"release-workflows: FAIL ({description}; {first!r} must appear before {second!r} in {path})"
        )


def require_order_after(path: str, anchor: str, first: str, second: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    anchor_index = text.find(anchor)
    if anchor_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing anchor {anchor!r} in {path})")
    first_index = text.find(first, anchor_index)
    second_index = text.find(second, first_index if first_index != -1 else anchor_index)
    if first_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing {first!r} after {anchor!r} in {path})")
    if second_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing {second!r} after {first!r} in {path})")
    if first_index >= second_index:
        raise SystemExit(
            f"release-workflows: FAIL ({description}; {first!r} must appear before {second!r} after {anchor!r} in {path})"
        )


def require_step_contains(path: str, step_name: str, needle: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    marker = f"      - name: {step_name}\n"
    start_index = text.find(marker)
    if start_index == -1:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing step {step_name!r} in {path})")
    next_step_index = text.find("\n      - ", start_index + len(marker))
    block = text[start_index : next_step_index if next_step_index != -1 else len(text)]
    if needle not in block:
        raise SystemExit(
            f"release-workflows: FAIL ({description}; missing {needle!r} in {step_name!r} step in {path})"
        )


def require_job_contains(path: str, job_name: str, needle: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    match = re.search(
        rf"(?ms)^  {re.escape(job_name)}:\n(?P<block>.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)",
        text,
    )
    if not match:
        raise SystemExit(f"release-workflows: FAIL ({description}; missing job {job_name!r} in {path})")
    if needle not in match.group("block"):
        raise SystemExit(
            f"release-workflows: FAIL ({description}; missing {needle!r} in {job_name!r} job in {path})"
        )


STEP_START = re.compile(r"(?m)^      - ")
STEP_HEADER = re.compile(r"(?m)^      - name[ \t]*:[ \t]*(?P<name>.*)$")
FLOW_STYLE_STEP = re.compile(r"(?m)^      - \{")


def non_canonical_keys(lines):
    """(line_number, text) for key lines that are not spelled in the canonical form.

    YAML accepts `key : value`, `"key": value` and an explicit `? key` line as the same mapping
    key, so a reader that matches `^key:` does not see the first two at all. Every reader here
    tolerates the pre-colon whitespace, and any of these spellings at a key's own indentation is
    refused as well, so a key this guard does not enumerate cannot hide either. The pinned wiring
    is always canonical: `key: value` at the key's indentation.
    """
    found = []
    for index, line in enumerate(lines):
        for prefix in KEY_LINE_PREFIXES:
            if not line.startswith(prefix):
                continue
            rest = line[len(prefix) :]
            if any(form.match(rest) for form in NON_CANONICAL_KEY_FORMS):
                found.append((index + 1, line.strip()))
            break
    return found


def workflow_step_blocks(text: str):
    """(step_name, step_text) for every step of a workflow, bounded by the next step or job.

    Bounds use `- ` step markers, not only named steps, so a step without a name (`- uses:`)
    is a block of its own rather than being folded into the step above it.
    """
    starts = [match.start() for match in STEP_START.finditer(text)]
    names = {match.start(): match.group("name").strip() for match in STEP_HEADER.finditer(text)}
    blocks = []
    for position, start in enumerate(starts):
        end = starts[position + 1] if position + 1 < len(starts) else len(text)
        next_job = re.search(r"\n  [A-Za-z0-9_-]+:\n", text[start:])
        if next_job:
            end = min(end, start + next_job.start())
        blocks.append((names.get(start, ""), text[start:end]))
    return blocks


def body_mentions(body: str, script: str) -> bool:
    """True when a run body names the script in code or in a comment, never in masked data."""
    return any(
        script in line
        for line in join_shell_continuations(mask_shell_data(body.splitlines()))
    )


PAIRING_SCRIPT = "verify-release-pairing.sh"
PAIRING_SCRIPT_PATH = "scripts/verify-release-pairing.sh"
META_GUARD_SCRIPT = "verify-release-workflows.sh"
META_GUARD_SCRIPT_PATH = "scripts/verify-release-workflows.sh"

PAIRING_STEP_NAME = "Verify apptheory-init template/release pairing"
META_GUARD_STEP_CI = "Verify release/security invariants"
META_GUARD_STEP_PREMAIN = "Verify release workflow invariants (release preflight)"
META_GUARD_STEP_MAIN = "Verify release workflow invariants (stable release preflight)"
RELEASE_PR_STEP_CONDITION = "steps.release_pr.outputs.exists == 'true'"
RELEASE_MAIN_PREFLIGHT_IF = "github.ref == 'refs/heads/main' && inputs.tag_name == ''"
PAIRING_WORKFLOWS = (
    ".github/workflows/ci.yml",
    ".github/workflows/prerelease-pr.yml",
    ".github/workflows/release-pr.yml",
)
PAIRING_SHELL_INVOKERS = (
    "scripts/verify-release-branch.sh",
    "scripts/verify-release-publish-postcondition.sh",
    "scripts/verify-release-gates.sh",
)
# The release publishers run the meta-guard in their precondition step, so a weakened call
# there would let a stale release path publish unnoticed.
META_GUARD_WORKFLOWS = (
    ".github/workflows/ci.yml",
    ".github/workflows/prerelease.yml",
    ".github/workflows/release.yml",
)

# `-h`, `--help` and `--usage` exit 0 before any check. `|| return N` / `|| exit N` with a
# non-zero status is the only trailing list operator that keeps a failing invocation
# fail-closed, and it is accepted only when nothing else follows it in the same list:
# `|| exit 1 &` backgrounds the whole list and `|| exit 1; true` runs past the tail, so
# neither of those decides the step's exit status.
PAIRING_USAGE_FLAGS = re.compile(r"(?:^|\s)(-h|--help|--usage)(?=\s|$)")
PAIRING_FAIL_CLOSED_TAIL = re.compile(r"^(?:return|exit)\s+[1-9][0-9]*$")
# A call site that ends with `|| exit N` is fail-closed whatever surrounds it, because `exit` in a
# function leaves the shell rather than handing a status back to a caller bash may have exempted.
EXIT_TAIL = re.compile(r"^exit\s+[1-9][0-9]*$")

# An invocation may only carry one of these literal argument vectors. GitHub substitutes
# `${{ }}` and expands variables before bash parses the line, so an argument the guard
# cannot read literally can place a list operator (`|| true`) or a usage flag (`--help`)
# into the command line. The expansions below are the only ones any legitimate call site
# carries, and each value is separately pinned literally by the release-workflow pins
# further down this file.
PAIRING_ALLOWED_ARG_VECTORS = (
    (),
    ("--self-test",),
    ("--published",),
    ("--published", "--tag", "${release_tag}"),
    ("--tag", "${expected_tag}"),
)
META_GUARD_ALLOWED_ARG_VECTORS = ((), ("--self-test",))

# Shadowing any of these names would let a failing guarded invocation report success: a
# function or alias named `bash`, `exit` or `set` replaces the command the fail-closed
# shape depends on. SHELL_STATE_KEYS are the variables that change what a later command in
# the same shell executes.
SHADOWING_COMMANDS = (
    "bash",
    "sh",
    "env",
    "command",
    "builtin",
    "exec",
    "eval",
    "set",
    "trap",
    "exit",
    "return",
)
# Variables that decide which program a later command runs, or how a shell starts: PATH resolves
# `bash` itself, and CDPATH can send a relative `cd` - such as the `cd "$(dirname "$0")/.."` every
# guarded script opens with - to a different directory. BASH_ENV, ENV, SHELLOPTS and BASHOPTS are
# read by a shell as it starts, so they can install code or shell options ahead of the invocation.
# None of them is set in the pinned wiring at any level - workflow, job, step or invoking script -
# apart from the gov verifier's own toolchain export, which is pinned by exact statement text in
# SHELL_STATE_EXEMPTIONS. BASH_FUNC_* is matched by prefix, because bash exports one variable per
# exported function under that prefix.
SHELL_SEMANTICS_VARIABLES = ("PATH", "CDPATH", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS")
SHELL_STATE_KEYS = SHELL_SEMANTICS_VARIABLES

SHELL_OPENERS = ("if", "while", "until", "for", "case")
SHELL_CLOSERS = ("fi", "done", "esac")
HEREDOC_START = re.compile(
    r"(?<!<)<<(?!<)-?[ \t]*(?P<quote>['\"]?)(?P<marker>[A-Za-z_][A-Za-z0-9_]*)(?P=quote)"
)
SHELL_SEMANTICS_ENV_KEYS = SHELL_SEMANTICS_VARIABLES
# GitHub's built-in `bash` shell expands to `bash --noprofile --norc -eo pipefail {0}`,
# so the bare keyword keeps errexit while an explicit command template has to prove it.
SHELL_ERREXIT_FLAG = re.compile(r"(?:^|\s)-[A-Za-z]*e[A-Za-z]*(?=\s|$)")
# `<<:` is a YAML merge key. GitHub Actions does not honour one today, so it is a dead end
# there, but this guard refuses the document rather than depending on that.
MERGE_KEY = re.compile(r"(?m)^[ \t]*<<[ \t]*:")
# YAML forms this text-level classifier cannot follow. An alias re-points a key's value at a node
# defined elsewhere in the document (`run: *weakened`), and a second document is a file GitHub
# refuses to load as one workflow, so the two would be read differently by the guard and by the
# runner. Both are refused outright rather than read past.
YAML_ALIAS = re.compile(
    r"(?m)(?::[ \t]+|^[ \t]*-[ \t]+|\[|\{|,[ \t]*)\*[A-Za-z_][A-Za-z0-9_-]*[ \t]*(?:$|[,}\]])"
)
DOCUMENT_SEPARATOR = re.compile(r"(?m)^---[ \t]*$")
# YAML spells `key : value` and `key: value` as the same key, so a reader that matches `^key:`
# does not see the first form at all. Every key reader below tolerates the whitespace, and these
# forms at a key's own indentation are additionally refused, so a key the guard does not enumerate
# cannot hide either. Longest prefix first, so the step-key indent is not mistaken for the job-key
# indent of the four spaces it starts with.
KEY_LINE_PREFIXES = ("        ", "      - ", "    ")
NON_CANONICAL_KEY_FORMS = (
    re.compile(r"\?[ \t]"),  # an explicit `? key` line
    re.compile(r"[\"'][^\"']*[\"'][ \t]*:"),  # a quoted `"key": value`
    re.compile(r"[A-Za-z_][A-Za-z0-9_-]*[ \t]+:"),  # `key : value`
)
GITHUB_EXPRESSION = re.compile(r"\$\{\{")

# `verify_release_pairing_postcondition` in the release publisher is the one function a pairing
# invocation may sit inside, and its call sites are classified in full: every call has to be a
# fail-closed one, and any other function that holds the invocation is refused rather than guessed
# at, so an added `gate() { ... }` shape fails closed.
PAIRING_FUNCTION_HOSTS = (
    {
        "path": "scripts/verify-release-publish-postcondition.sh",
        "function": "verify_release_pairing_postcondition",
        "kind": "direct",
    },
)
# The gov verifier dispatches each check by name through `run_check`, which evaluates the command
# in a subshell that re-enables `set -euo pipefail`, so the invocation inside
# `check_release_lifecycle_invariants` is reached through a dispatch the guard cannot follow by
# name. The dispatch is pinned here as exact text and must itself be a governed statement; any
# other statement that expands the dispatch variable has to be governed too.
META_GUARD_FUNCTION_HOSTS = (
    {
        "path": "gov-infra/verifiers/gov-verify-rubric.sh",
        "function": "check_release_lifecycle_invariants",
        "kind": "indirect",
        "variable": "CMD_RELEASE_LIFECYCLE",
        "assignment": 'CMD_RELEASE_LIFECYCLE="check_release_lifecycle_invariants"',
        "dispatch": 'run_check "CMP-4" "Compliance" "$CMD_RELEASE_LIFECYCLE"',
        # `run_check` evaluates the command in a subshell that re-enables errexit, so the evaluated
        # check fails closed. Deleting that line - or softening it - would silently turn a failing
        # check into a reported PASS, so the exact statement is pinned inside the function.
        "dispatch_function": "run_check",
        "dispatch_setup": "set -euo pipefail",
    },
)

# Each guarded script is classified the same way: which steps and shell scripts may invoke
# it, which conditionals those call sites are pinned to, and which literal argument vectors
# the invocation may carry. Adding a call site without a pin here fails closed.
PAIRING_SPEC = {
    "label": "pairing gate",
    "script": PAIRING_SCRIPT,
    "path": PAIRING_SCRIPT_PATH,
    "usage_flags": PAIRING_USAGE_FLAGS,
    "allowed_args": PAIRING_ALLOWED_ARG_VECTORS,
    "jobs": (
        (
            ".github/workflows/ci.yml",
            "release-security-gates",
            None,
        ),
        (
            ".github/workflows/prerelease-pr.yml",
            "release-please",
            "github.event_name == 'workflow_dispatch' || !contains("
            "github.event.head_commit.message, 'release-please--branches--premain')",
        ),
        (
            ".github/workflows/release-pr.yml",
            "release-please",
            "github.event_name == 'workflow_dispatch' || !contains("
            "github.event.head_commit.message, 'release-please--branches--main')",
        ),
    ),
    "workflow_steps": (
        (".github/workflows/ci.yml", PAIRING_STEP_NAME, None),
        (".github/workflows/prerelease-pr.yml", PAIRING_STEP_NAME, RELEASE_PR_STEP_CONDITION),
        (".github/workflows/release-pr.yml", PAIRING_STEP_NAME, RELEASE_PR_STEP_CONDITION),
    ),
    "shell_invokers": PAIRING_SHELL_INVOKERS,
    # `verify_release_pairing_postcondition` is the release publisher's post-publish leg, whose
    # call sites are pinned here: every call has to be a fail-closed one, and any other function
    # that tries to hold the invocation is refused rather than guessed at.
    "function_hosts": PAIRING_FUNCTION_HOSTS,
}
META_GUARD_SPEC = {
    "label": "release-workflow meta-guard",
    "script": META_GUARD_SCRIPT,
    "path": META_GUARD_SCRIPT_PATH,
    "usage_flags": PAIRING_USAGE_FLAGS,
    "allowed_args": META_GUARD_ALLOWED_ARG_VECTORS,
    "jobs": (),
    "workflow_steps": (
        (".github/workflows/ci.yml", META_GUARD_STEP_CI, None),
        (".github/workflows/prerelease.yml", META_GUARD_STEP_PREMAIN, None),
        (".github/workflows/release.yml", META_GUARD_STEP_MAIN, RELEASE_MAIN_PREFLIGHT_IF),
    ),
    # gov-verify-rubric.sh is a generated verifier whose shell state is checked like any other,
    # exempting only the two constructs it legitimately needs - the pinned toolchain PATH export
    # and the RETURN trap that removes a scratch file - each named by exact statement text. Its
    # `set +e` / `set -e` pairs around individual commands are handled by scoping the errexit
    # check to the region that can actually run the invocation (see errexit_findings).
    "shell_invokers": ("scripts/verify-release-gates.sh", "gov-infra/verifiers/gov-verify-rubric.sh"),
    "function_hosts": META_GUARD_FUNCTION_HOSTS,
}
# Statements the gov verifier legitimately needs, pinned by exact text. Anything else - a different
# PATH value, another trap, a shadowing definition - is classified normally, so the exemption
# cannot be widened into a general licence.
SHELL_STATE_EXEMPTIONS = {
    "gov-infra/verifiers/gov-verify-rubric.sh": (
        'export PATH="${GOV_TOOLS_BIN}:${GOV_TOOLS_PY_BIN}:${GOV_TOOLS_PY_RUNTIME_BIN}:${PATH}"',
        "trap 'rm -f \"${tmp}\"' RETURN",
    ),
}
GUARDED_WORKFLOWS = tuple(dict.fromkeys(PAIRING_WORKFLOWS + META_GUARD_WORKFLOWS))
GUARDED_SHELL_INVOKERS = tuple(
    dict.fromkeys(PAIRING_SHELL_INVOKERS + META_GUARD_SPEC["shell_invokers"])
)
GUARDED_FILES = GUARDED_WORKFLOWS + GUARDED_SHELL_INVOKERS


def split_shell_comment(line: str):
    """Split a shell line into (code, comment) at the first unquoted word-initial `#`.

    Quoting follows bash, including ANSI-C quoting: `$'...'` honours backslash escapes, so
    `$'it\\'s'` is one word and does not end at the escaped apostrophe, while `$"..."` is an
    ordinary double-quoted string and a backslash inside a plain `'...'` is literal.
    """
    code = []
    state = None
    index = 0
    while index < len(line):
        char = line[index]
        if state == "single":
            code.append(char)
            if char == "'":
                state = None
        elif state == "ansi":
            code.append(char)
            if char == "\\" and index + 1 < len(line):
                index += 1
                code.append(line[index])
            elif char == "'":
                state = None
        elif state == "double":
            if char == "\\" and index + 1 < len(line):
                code.append(char)
                index += 1
                code.append(line[index])
            else:
                code.append(char)
                if char == '"':
                    state = None
        elif char == "\\" and index + 1 < len(line):
            code.append(char)
            index += 1
            code.append(line[index])
        elif line.startswith("$'", index):
            state = "ansi"
            code.append(char)
            index += 1
            code.append(line[index])
        elif char == "'":
            state = "single"
            code.append(char)
        elif char == '"':
            state = "double"
            code.append(char)
        elif char == "#" and (index == 0 or line[index - 1] in " \t;&|("):
            return "".join(code), line[index:]
        else:
            code.append(char)
        index += 1
    return "".join(code), ""


def split_shell_statements(code: str):
    """[(separator_before, statement, separator_after)] split at top-level `;`, `&&`, `||`, `|`, `&`.

    The separator that follows a statement is kept too: a tolerated fail-closed tail can be
    chained into a backgrounded or piped list (`|| exit 1 &`), and bash backgrounds the
    whole list, so the tail alone would not decide the step's exit status.
    """
    raw = []
    current = []
    separator = None
    state = None
    index = 0
    while index < len(code):
        char = code[index]
        if state == "single":
            current.append(char)
            if char == "'":
                state = None
        elif state == "double":
            if char == "\\" and index + 1 < len(code):
                current.append(char)
                index += 1
            current.append(code[index])
            if code[index] == '"':
                state = None
        elif state == "ansi":
            current.append(char)
            if char == "\\" and index + 1 < len(code):
                index += 1
                current.append(code[index])
            elif char == "'":
                state = None
        elif char == "\\" and index + 1 < len(code):
            current.append(char)
            index += 1
            current.append(code[index])
        elif code.startswith("$'", index):
            state = "ansi"
            current.append(char)
            index += 1
            current.append(code[index])
        elif char == "'":
            state = "single"
            current.append(char)
        elif char == '"':
            state = "double"
            current.append(char)
        elif code.startswith("&&", index) or code.startswith("||", index):
            raw.append((separator, "".join(current)))
            separator = code[index : index + 2]
            current = []
            index += 1
        elif char in ";|&":
            raw.append((separator, "".join(current)))
            separator = char
            current = []
        else:
            current.append(char)
        index += 1
    raw.append((separator, "".join(current)))
    statements = []
    for position, (before, text) in enumerate(raw):
        after = raw[position + 1][0] if position + 1 < len(raw) else None
        if text.strip():
            statements.append((before, text.strip(), after))
    return statements


def mask_heredoc_bodies(lines):
    """Blank out heredoc bodies so fixture data is never mistaken for shell code."""
    masked = list(lines)
    index = 0
    while index < len(lines):
        match = HEREDOC_START.search(split_shell_comment(lines[index])[0])
        if not match:
            index += 1
            continue
        marker = match.group("marker")
        index += 1
        while index < len(lines) and lines[index].strip() != marker:
            masked[index] = ""
            index += 1
        if index < len(lines):
            masked[index] = ""
        index += 1
    return masked


def scan_quotes(text: str, stack: list):
    """Advance a quote-context stack over one line; return the index where it first empties.

    The stack tracks nesting, because a quoted shell word can contain a command substitution
    that starts its own quoting context: in `x="$(awk '...')"` the embedded program is a
    single-quoted word inside a substitution inside a double-quoted string. ANSI-C quoting
    (`$'...'`) is its own context, because a backslash there escapes the next character: without
    that, `$'it\\'s'` would close at the escaped apostrophe and leave the scanner believing a
    single quote is still open, so every later line would be read as data instead of code.
    """
    index = 0
    started_open = bool(stack)
    while index < len(text):
        char = text[index]
        top = stack[-1] if stack else None
        if top == "single":
            if char == "'":
                stack.pop()
        elif top == "ansi":
            if char == "\\" and index + 1 < len(text):
                index += 1
            elif char == "'":
                stack.pop()
        elif top == "double":
            if char == "\\" and index + 1 < len(text):
                index += 1
            elif char == '"':
                stack.pop()
            elif text.startswith("$(", index):
                stack.append("substitution")
                index += 1
        elif top == "substitution":
            if char == "\\" and index + 1 < len(text):
                index += 1
            elif char == ")":
                stack.pop()
            elif text.startswith("$'", index):
                stack.append("ansi")
                index += 1
            elif char == "'":
                stack.append("single")
            elif char == '"':
                stack.append("double")
        elif char == "\\" and index + 1 < len(text):
            index += 1
        elif text.startswith("$'", index):
            stack.append("ansi")
            index += 1
        elif char == "'":
            stack.append("single")
        elif char == '"':
            stack.append("double")
        elif text.startswith("$(", index):
            stack.append("substitution")
            index += 1
        index += 1
        if started_open and not stack:
            return index
    return None


def mask_quoted_bodies(lines):
    """Blank multi-line quoted-string bodies: an embedded program is data, not shell code.

    An `awk '...'` script or a multi-line message is one shell word, so its lines are not
    statements and must never be read as conditionals, loops, or invocations.
    """
    masked = list(lines)
    stack = []
    for index, line in enumerate(lines):
        if stack:
            remainder_at = scan_quotes(line, stack)
            masked[index] = "" if remainder_at is None else line[remainder_at:]
            continue
        scan_quotes(split_shell_comment(line)[0], stack)
    return masked


def mask_shell_data(lines):
    """Blank heredoc bodies and multi-line quoted strings; both are data, not shell code."""
    return mask_quoted_bodies(mask_heredoc_bodies(lines))


def join_shell_continuations(lines):
    """Join backslash continuations so a weakening operator cannot hide on the next line."""
    joined = []
    buffer = None
    for line in lines:
        text = line if buffer is None else buffer + " " + line.lstrip()
        stripped = text.rstrip()
        trailing = 0
        while trailing < len(stripped) and stripped[len(stripped) - 1 - trailing] == "\\":
            trailing += 1
        if trailing % 2 == 1:
            buffer = stripped[:-1]
        else:
            joined.append(text)
            buffer = None
    if buffer is not None:
        joined.append(buffer.rstrip())
    return joined


def shell_statements(body: str):
    """(line_number, statement, separator_after) for every top-level statement in a body."""
    for line_number, line in enumerate(join_shell_continuations(mask_shell_data(body.splitlines())), 1):
        code, _comment = split_shell_comment(line)
        for _separator, statement, after in split_shell_statements(code):
            yield line_number, statement, after


def normalize_statement(statement: str) -> str:
    """A statement's text with runs of whitespace collapsed, so two spellings compare equal."""
    return " ".join(statement.split())


def unquoted_view(text: str) -> str:
    """`text` with every quoted region blanked, so only unquoted words and braces are read.

    A glob, a parameter expansion or a brace inside quotes is not a word the shell will run and
    not a block boundary, so it must not be read as one. Quoting follows bash here too, which
    matters for ANSI-C words: `$'a\\'b'` is one word, not a quote that ends early.
    """
    out = []
    state = None
    index = 0
    while index < len(text):
        char = text[index]
        if state == "single":
            if char == "'":
                state = None
            out.append(" ")
        elif state == "ansi":
            if char == "\\" and index + 1 < len(text):
                index += 1
            elif char == "'":
                state = None
            out.append(" ")
        elif state == "double":
            if char == "\\" and index + 1 < len(text):
                index += 1
            elif char == '"':
                state = None
            out.append(" ")
        elif char == "\\" and index + 1 < len(text):
            out.append(" ")
            index += 1
            out.append(" ")
        elif text.startswith("$'", index):
            state = "ansi"
            out.append(" ")
            index += 1
            out.append(" ")
        elif char == "'":
            state = "single"
            out.append(" ")
        elif char == '"':
            state = "double"
            out.append(" ")
        else:
            out.append(char)
        index += 1
    return "".join(out)


# A function definition opens a body that bash treats as one unit for errexit: when the function is
# entered from an `if` test or a `||`/`&&`/`|` list, -e is ignored for every command inside it.
FUNCTION_OPEN = re.compile(
    r"^(?:function[ \t]+)?(?P<name>[^\s(=]+)[ \t]*\([ \t]*\)[ \t]*(?P<rest>.*)$"
)


def function_frames(body: str):
    """(name, open_line, close_line) for every function definition that opens a body.

    A one-line definition whose braces balance (`bash() { return 0; }`) opens nothing and is not a
    frame; a definition that opens a block is, and it closes on the statement where the brace
    depth returns to where it started.
    """
    frames = []
    stack = []
    depth = 0
    pending = None
    for line_number, line in enumerate(join_shell_continuations(mask_shell_data(body.splitlines())), 1):
        code, _comment = split_shell_comment(line)
        for _separator, statement, _after in split_shell_statements(code):
            view = unquoted_view(statement)
            if pending is not None:
                if normalize_statement(statement) == "{":
                    stack.append([pending, line_number, depth])
                    pending = None
                    depth += view.count("{") - view.count("}")
                    continue
                # A definition with no body on its line only opens a frame when the next statement
                # is its `{`; anything else means the definition did not open a block.
                pending = None
            definition = FUNCTION_OPEN.match(statement)
            if definition:
                if "{" in view:
                    stack.append([definition.group("name"), line_number, depth])
                elif not view.strip():
                    pending = definition.group("name")
            depth += view.count("{") - view.count("}")
            while stack and depth <= stack[-1][2]:
                name, open_line, _open_depth = stack.pop()
                frames.append((name, open_line, line_number))
    while stack:
        name, open_line, _open_depth = stack.pop()
        frames.append((name, open_line, None))
    return frames


def shell_statement_contexts(body: str):
    """(line, index, separator_before, statement, separator_after, depth, function, statements).

    `depth` is how many conditional or loop blocks the statement runs inside - the nesting that
    makes bash ignore errexit - and `function` names the function definition the line sits in, or
    None at file level. `statements` is the statement list the statement belongs to, so a caller
    can see what follows it on the same line.
    """
    containing = {}
    for name, open_line, close_line in function_frames(body):
        end = close_line if close_line is not None else 10**9
        for line in range(open_line, end + 1):
            containing.setdefault(line, name)
    depth = 0
    for line_number, line in enumerate(join_shell_continuations(mask_shell_data(body.splitlines())), 1):
        code, _comment = split_shell_comment(line)
        statements = split_shell_statements(code)
        for index, (separator, statement, after) in enumerate(statements):
            words = statement.split()
            first = words[0] if words else ""
            if first in SHELL_CLOSERS:
                depth = max(depth - 1, 0)
            yield (
                line_number,
                index,
                separator,
                statement,
                after,
                depth,
                containing.get(line_number),
                statements,
            )
            if first in SHELL_OPENERS:
                depth += 1


def governed_position(index, statement, after, statements, depth):
    """True when a statement's exit status reaches the shell's errexit check.

    It has to be first in its list, unnegated, outside a conditional or loop block, and either last
    on its line or followed only by a tolerated fail-closed `|| return N` / `|| exit N` tail with
    nothing after it in the same list.
    """
    if depth != 0 or index != 0 or statement.startswith("!"):
        return False
    if index + 1 < len(statements):
        separator, next_statement, next_after = statements[index + 1]
        if separator != "||" or not PAIRING_FAIL_CLOSED_TAIL.match(
            normalize_statement(next_statement)
        ):
            return False
        return next_after in (None, ";") and index + 2 >= len(statements)
    return after in (None, ";")


def fail_closed_exit_call(index, statement, after, statements):
    """True when a statement ends with a `|| exit N` tail that nothing else follows in its list.

    `exit` in a function leaves the shell, so this tail propagates a failure no matter which
    conditional or list context the call sits in - unlike `|| return N`, which hands the status
    back to a caller that bash may have exempted from errexit.
    """
    if index != 0 or statement.startswith("!"):
        return False
    if index + 1 >= len(statements):
        return False
    separator, next_statement, next_after = statements[index + 1]
    if separator != "||" or not EXIT_TAIL.match(normalize_statement(next_statement)):
        return False
    return next_after in (None, ";") and index + 2 >= len(statements)


def pinned_call_site_findings(host, contexts, spec, where):
    """Findings for the call sites of a function the spec pins as a direct invocation host.

    Every occurrence of the function's name in the file has to be either its own definition or a
    call that fails closed in its own right, and at least one such call has to exist. A call is
    fail-closed when it sits at file level - where errexit governs it - or when it carries a
    `|| exit N` tail anywhere, because that leaves the shell whatever the caller's context is. A
    call the guard cannot place - `if f; then`, `! f`, `f || true`, a plain call inside a wrapper
    function - is reported rather than counted: a wrapper can be entered from a condition, and
    bash then ignores errexit for everything inside it, host and wrapper alike.
    """
    function = host["function"]
    token = re.compile(rf"(?<![A-Za-z0-9_./-]){re.escape(function)}(?![A-Za-z0-9_.-])")
    findings = []
    calls = 0
    for (
        line_number,
        index,
        _before,
        statement,
        after,
        depth,
        function_of_line,
        statements,
    ) in contexts:
        if not token.search(statement):
            continue
        if FUNCTION_OPEN.match(statement):
            continue
        top_level_governed = function_of_line is None and governed_position(
            index, statement, after, statements, depth
        )
        if top_level_governed or fail_closed_exit_call(index, statement, after, statements):
            calls += 1
            continue
        findings.append(
            f"{where}:{line_number}: the {spec['label']} invocation host {function!r} is called from "
            f"a position that is not fail-closed ({statement!r}), so bash could ignore errexit for "
            f"everything inside it"
        )
    if not calls:
        findings.append(
            f"{where}: the pinned {spec['label']} invocation host {function!r} has no fail-closed "
            "call site"
        )
    return findings


def function_host_findings(contexts, spec, path, where):
    """Findings for a guarded invocation that runs inside a function definition body.

    bash ignores errexit for every command in a function body when the function is entered from an
    `if`, `while` or `until` test, from a `&&`, `||` or `|` list that is not the command deciding
    it, from a negation, or from a command substitution - and whatever the function calls inherits
    that. So a function body may hold a guarded invocation only where the spec pins that function
    as a host and the pin's own evidence checks out: the release publisher's post-publish leg,
    whose call sites are classified directly, and the gov verifier's check, which is reached
    through the pinned indirect dispatch. Any other function holding an invocation is refused
    rather than guessed at, so a new `gate() { ... }` shape fails closed.
    """
    hosts = {}
    for context in contexts:
        if context[6] is not None and spec["script"] in context[3]:
            hosts.setdefault(context[6], context[0])
    if not hosts:
        return []
    pinned = {
        host["function"]: host
        for host in spec.get("function_hosts", ())
        if host["path"] == path
    }
    findings = []
    for function in sorted(hosts):
        line_number = hosts[function]
        host = pinned.get(function)
        if host is None:
            findings.append(
                f"{where}:{line_number}: the {spec['label']} invocation runs inside the function "
                f"{function!r}, which is not a pinned invocation host; bash ignores errexit for "
                f"commands in a function entered from a condition, so an unpinned host cannot be "
                f"proved fail-closed"
            )
            continue
        if host["kind"] == "indirect":
            findings.extend(pinned_dispatch_findings(host, contexts, where))
        else:
            findings.extend(pinned_call_site_findings(host, contexts, spec, where))
    return findings


def pinned_dispatch_findings(host, contexts, where):
    """Findings for the pinned indirect dispatch that reaches a function-embedded invocation.

    The pin says the file reaches this function by name through one exact dispatch statement, and
    that the function running that dispatch re-enables errexit around it - which is what makes the
    invocation fail-closed even though bash cannot follow the dispatch by name. Both halves are
    checked rather than assumed: the assignment and the dispatch statement have to be present, every
    statement that expands the dispatch variable has to be a governed one, and the dispatch function
    has to contain an errexit-enabling statement of its own.
    """
    findings = []
    variable = host["variable"]
    pattern = re.compile(r"\$\{?" + re.escape(variable) + r"\}?")
    texts = [normalize_statement(context[3]) for context in contexts]
    if texts.count(host["assignment"]) != 1:
        findings.append(
            f"{where}: the pinned dispatch assignment {host['assignment']!r} for "
            f"{host['function']!r} is missing"
        )
    dispatch_seen = False
    for line_number, index, _before, statement, after, depth, _function, statements in contexts:
        if not pattern.search(statement):
            continue
        if normalize_statement(statement) == host["dispatch"]:
            dispatch_seen = True
        if not governed_position(index, statement, after, statements, depth):
            findings.append(
                f"{where}:{line_number}: {host['function']!r} is dispatched through "
                f"${variable} from a position that is not fail-closed ({statement!r}), so bash "
                f"would not apply errexit to the command it runs"
            )
    if not dispatch_seen:
        findings.append(
            f"{where}: the pinned dispatch {host['dispatch']!r} that reaches "
            f"{host['function']!r} is missing"
        )
    dispatch_function = host.get("dispatch_function")
    dispatch_setup = host.get("dispatch_setup")
    if dispatch_function and dispatch_setup:
        inside = any(
            normalize_statement(context[3]) == dispatch_setup
            and context[6] == dispatch_function
            for context in contexts
        )
        if not inside:
            findings.append(
                f"{where}: the pinned dispatch function {dispatch_function!r} no longer contains the "
                f"pinned {dispatch_setup!r} that makes the command it evaluates fail closed, so a "
                f"failing {host['function']!r} would be reported as a PASS"
            )
    return findings


FUNCTION_DEFINITION = re.compile(r"^(?:function[ \t]+)?(?P<name>[^\s(=]+)[ \t]*\([ \t]*\)")
ALIAS_DEFINITION = re.compile(r"^alias[ \t]+(?P<name>[^=\s]+)=")
ASSIGNMENT_STATEMENT = re.compile(
    r"^(?:(?:export|declare|typeset|readonly|local)[ \t]+(?:-[A-Za-z]+[ \t]+)*)?"
    r"(?P<key>[A-Za-z_][A-Za-z0-9_]*)\+?="
)


def shadowing_target(name: str, spec) -> bool:
    """True when shadowing `name` would replace the command a guarded invocation needs."""
    bare = name[2:] if name.startswith("./") else name
    return (
        bare in SHADOWING_COMMANDS
        or bare in (spec["script"], spec["path"])
        or name in (spec["script"], spec["path"])
    )


def unquote_argument(argument: str) -> str:
    """One layer of matching surrounding quotes, so a quoted literal still matches its pin."""
    if len(argument) >= 2 and argument[0] == argument[-1] and argument[0] in "\"'":
        return argument[1:-1]
    return argument


def assignment_target(statement: str):
    """The shell-state variable a statement assigns, or None when it assigns nothing of interest."""
    match = ASSIGNMENT_STATEMENT.match(statement)
    if not match:
        return None
    key = match.group("key")
    if key in SHELL_STATE_KEYS or key.startswith("BASH_FUNC"):
        return key
    return None


def shell_state_findings(body: str, where: str, spec, exemptions=()):
    """Findings for shell state in one body that could mask a failing guarded invocation.

    A guarded invocation is only as fail-closed as the shell it runs in: a function or alias
    shadowing `bash`/`exit`/`set`/the script path, a trap that replaces the failing status, or a
    reassigned PATH/CDPATH/BASH_ENV/ENV/SHELLOPTS/BASHOPTS all let a failing invocation leave the
    step green. None of them appear in the pinned wiring, except the gov verifier's own toolchain
    export and RETURN trap, which are named by exact statement text in `exemptions`. The statement
    has to match the whole pinned text, so the exemption cannot be widened by editing the value.
    """
    findings = []
    exempt = {normalize_statement(statement) for statement in exemptions}
    for line_number, statement, _after in shell_statements(body):
        if normalize_statement(statement) in exempt:
            continue
        definition = FUNCTION_DEFINITION.match(statement) or ALIAS_DEFINITION.match(statement)
        if definition and shadowing_target(definition.group("name"), spec):
            findings.append(
                f"{where}:{line_number}: the {spec['label']} invocation's command is shadowed by a "
                f"function or alias definition ({statement!r})"
            )
        words = statement.split()
        if words and words[0] == "trap":
            findings.append(
                f"{where}:{line_number}: installs a trap that can replace the exit status of a failing "
                f"{spec['label']} invocation ({statement!r})"
            )
        target = assignment_target(statement)
        if target:
            findings.append(
                f"{where}:{line_number}: reassigns {target} in the same shell as the {spec['label']} "
                f"invocation, so a later invocation need not be the pinned command ({statement!r})"
            )
    return findings


def invocation_functions(body: str, spec):
    """The function definitions whose bodies contain an invocation of the guarded script."""
    return {
        context[6]
        for context in shell_statement_contexts(body)
        if context[6] and spec["script"] in context[3]
    }


def scoped_errexit(contexts, scope_functions):
    """(enabled, disabled_line) for errexit over the statements that can run the invocation."""
    enabled = False
    disabled_line = None
    for (
        line_number,
        _index,
        _before,
        statement,
        _after,
        _depth,
        function,
        _statements,
    ) in contexts:
        if function is not None and function not in scope_functions:
            continue
        words = statement.split()
        if not words or words[0] != "set":
            continue
        for word_index in range(1, len(words)):
            word = words[word_index]
            if word[:1] not in ("+", "-"):
                continue
            cluster = word[1:]
            named = (
                cluster == "o"
                and word_index + 1 < len(words)
                and words[word_index + 1] == "errexit"
            )
            if not named and "e" not in cluster:
                continue
            if word.startswith("+"):
                disabled_line = disabled_line if disabled_line is not None else line_number
            else:
                enabled = True
    return enabled, disabled_line


def errexit_findings(body: str, where: str, spec, scope_functions, require_enabled):
    """Findings for errexit in the region that can actually run the guarded invocation.

    `set +e` anywhere in a file is not the question: the gov verifier captures exit codes by
    clearing errexit around individual commands in functions of its own, far from the invocation.
    What decides the invocation is the region that executes it - the file-level statements plus the
    body of the function that holds it - so `set +e` there is a finding and one in an unrelated
    function is not. A workflow step body reaches bash through GitHub's
    `bash --noprofile --norc -eo pipefail {0}` template, so only a shell invoker that has to
    establish errexit itself is required to contain a `set -e`.
    """
    enabled, disabled_line = scoped_errexit(shell_statement_contexts(body), scope_functions)
    findings = []
    if require_enabled and not enabled:
        findings.append(
            f"{where}: does not set errexit, so a failing {spec['label']} invocation would not fail "
            "the gate"
        )
    if disabled_line is not None:
        findings.append(
            f"{where}:{disabled_line}: clears errexit with `set +e` in the shell that runs the "
            f"{spec['label']} invocation, so a failing invocation would not fail closed"
        )
    return findings


def classify_invocations(body: str, where: str, spec, path=None):
    """Findings for every invocation of one guarded script in a run block or shell script.

    An invocation is accepted only as the pinned fail-closed call: a first-on-line,
    unnegated, top-level statement that names the guarded script directly, carries a pinned
    literal argument vector, and is not followed by anything that decides the result in its
    place. Anything else - negated, commented out, wrapped in a condition or loop, chained
    into another list, backgrounded, quoted, reached through a variable or a `${{ }}`
    expression, or taking a usage-exit flag - is reported instead of passing. An invocation
    inside a function definition body is accepted only for a function the spec pins as a host,
    with that host's own call sites or dispatch classified (see `function_host_findings`),
    because bash ignores errexit for everything in a function entered from a condition.
    """
    findings = []
    mentions = 0
    real = 0
    contexts = list(shell_statement_contexts(body))
    candidates = []
    for line_number, line in enumerate(join_shell_continuations(mask_shell_data(body.splitlines())), 1):
        code, _comment = split_shell_comment(line)
        if spec["script"] not in code and spec["script"] in line:
            mentions += 1
            findings.append(
                f"{where}:{line_number}: the {spec['label']} script is named in a comment, "
                f"not invoked ({line.strip()!r})"
            )
    for line_number, index, separator, statement, _after, depth, _function, statements in contexts:
        if spec["script"] in statement:
            mentions += 1
            candidates.append((line_number, index, separator, statement, depth, statements))
    for line_number, index, separator, statement, depth, statements in candidates:
        label = f"{where}:{line_number}"
        if depth != 0:
            findings.append(
                f"{label}: {spec['label']} invocation runs inside a conditional or loop block ({statement!r})"
            )
        if statement.startswith("!"):
            findings.append(
                f"{label}: {spec['label']} invocation is negated, and bash exempts negated commands "
                f"from errexit ({statement!r})"
            )
        if index != 0:
            findings.append(
                f"{label}: {spec['label']} invocation is not the first command on its line, so {separator!r} "
                f"decides whether it runs at all ({statement!r})"
            )
        words = statement.split()
        if len(words) > 1 and words[0] == "bash":
            command, args = words[1], words[2:]
        elif words:
            command, args = words[0], words[1:]
        else:
            command, args = "", []
        args = tuple(unquote_argument(argument) for argument in args)
        if command not in (spec["path"], "./" + spec["path"]):
            findings.append(
                f"{label}: {spec['label']} invocation is not positively classifiable as an unquoted "
                f"`bash {spec['path']}` call ({statement!r})"
            )
            continue
        if GITHUB_EXPRESSION.search(statement):
            findings.append(
                f"{label}: {spec['label']} invocation is built from a `${{{{ }}}}` expression, which GitHub "
                f"substitutes into the command line before bash parses it ({statement!r})"
            )
        if spec["usage_flags"].search(" " + " ".join(args)):
            findings.append(
                f"{label}: {spec['label']} invocation takes a usage flag, which exits 0 before any "
                f"verification is checked ({statement!r})"
            )
        if tuple(args) not in spec["allowed_args"]:
            findings.append(
                f"{label}: {spec['label']} invocation arguments {tuple(args)!r} are not one of the pinned "
                f"literal forms {spec['allowed_args']!r}; a variable, expansion or substitution here cannot "
                f"be read literally ({statement!r})"
            )
        if index + 1 < len(statements):
            next_separator, next_statement, next_after = statements[index + 1]
            fail_closed = next_separator == "||" and PAIRING_FAIL_CLOSED_TAIL.match(
                " ".join(next_statement.split())
            )
            if not fail_closed:
                findings.append(
                    f"{label}: the {spec['label']} invocation's exit status does not govern the step; "
                    f"{next_separator!r} {next_statement!r} follows it ({statement!r})"
                )
            else:
                if next_after not in (None, ";"):
                    findings.append(
                        f"{label}: the tolerated fail-closed tail {next_statement!r} trails {next_after!r}, "
                        f"so it is chained into a list instead of ending the step ({statement!r})"
                    )
                if index + 2 < len(statements):
                    findings.append(
                        f"{label}: {statements[index + 2][1]!r} follows the tolerated fail-closed tail "
                        f"{next_statement!r}, so the tail no longer decides the result ({statement!r})"
                    )
        else:
            after = statements[index][2]
            if after not in (None, ";"):
                findings.append(
                    f"{label}: the {spec['label']} invocation is the last command on a line trailing "
                    f"{after!r}, so the step does not wait for or observe its exit status ({statement!r})"
                )
        if tuple(args) != ("--self-test",):
            real += 1
    findings.extend(function_host_findings(contexts, spec, path, where))
    return findings, real, mentions


def workflow_job_block(text: str, job_name: str):
    match = re.search(
        rf"(?ms)^  {re.escape(job_name)}[ \t]*:\n(?P<block>.*?)(?=^  [A-Za-z0-9_-]+[ \t]*:\n|\Z)",
        text,
    )
    return match.group("block") if match else None


def subtree_scalar(lines, index: int, key: str):
    """The value of `key:` anywhere below lines[index]'s indentation level."""
    parent_indent = len(lines[index]) - len(lines[index].lstrip())
    pattern = re.compile(rf"^\s*{re.escape(key)}[ \t]*:[ \t]*(?P<value>\S.*)$")
    for line in lines[index + 1 :]:
        if not line.strip():
            continue
        if len(line) - len(line.lstrip()) <= parent_indent:
            break
        match = pattern.match(line)
        if match:
            return match.group("value").strip()
    return None


def find_key_index(lines, indent: int, key: str):
    """The first `key:` at one indentation level, tolerating YAML's `key : value` spelling.

    YAML treats `key : value` and `key: value` as the same key, so a reader that requires the
    colon to touch the key would simply not see the first form.
    """
    pattern = re.compile(rf"^ {{{indent}}}{re.escape(key)}[ \t]*:[ \t]*(?P<value>.*)$")
    for index, line in enumerate(lines):
        match = pattern.match(line)
        if match:
            return index, match.group("value").strip()
    return None, None


def shell_template_is_fail_closed(value):
    if value is None:
        return True
    text = value.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        text = text[1:-1].strip()
    if not text:
        return False
    if text == "bash":
        return True
    words = text.split()
    if words[0] not in ("bash", "sh"):
        return False
    rest = " ".join(words[1:])
    return bool(SHELL_ERREXIT_FLAG.search(" " + rest)) or "-o errexit" in rest


def step_run_body(step_text: str):
    """The `run:` body of one workflow step, or None when the step has no `run:` key."""
    lines = step_text.splitlines()
    run_index, run_value = find_key_index(lines, 8, "run")
    if run_index is None:
        return None
    if run_value in ("|", "|-", "|+", ">", ">-", ">+", ""):
        collected = []
        for line in lines[run_index + 1 :]:
            if not line.strip():
                collected.append("")
                continue
            if len(line) - len(line.lstrip()) <= 8:
                break
            collected.append(line)
        while collected and not collected[-1].strip():
            collected.pop()
        indents = [len(line) - len(line.lstrip()) for line in collected if line.strip()]
        base = min(indents) if indents else 0
        dedented = [line[base:] if len(line) > base else "" for line in collected]
        if run_value.startswith(">"):
            return " ".join(part for part in dedented if part.strip())
        return "\n".join(dedented)
    if len(run_value) >= 2 and run_value[0] == run_value[-1] and run_value[0] in "\"'":
        return run_value[1:-1]
    return run_value


def env_keys_at(lines, indent: int):
    """Variable names declared under an `env:` mapping at one indentation level."""
    keys = []
    marker = re.compile(rf"^ {{{indent}}}env[ \t]*:[ \t]*$")
    for index, line in enumerate(lines):
        if not marker.match(line):
            continue
        for following in lines[index + 1 :]:
            if not following.strip():
                continue
            if len(following) - len(following.lstrip()) <= indent:
                break
            match = re.match(r"^\s*(?P<key>[A-Za-z_][A-Za-z0-9_]*)\s*:", following)
            if match:
                keys.append(match.group("key"))
    return keys


def shell_semantics_env_keys(lines, indent: int):
    """Command-line `env:` keys that can change how a later command is executed."""
    return [
        key
        for key in env_keys_at(lines, indent)
        if key in SHELL_SEMANTICS_ENV_KEYS or key.startswith("BASH_FUNC")
    ]


def duplicate_keys(lines, indent: int):
    """Keys repeated at one mapping level: YAML keeps the last, so a duplicate can hide a value."""
    seen = set()
    duplicates = []
    pattern = re.compile(rf"^ {{{indent}}}(?P<key>[A-Za-z_][A-Za-z0-9_-]*)[ \t]*:")
    for line in lines:
        match = pattern.match(line)
        if not match:
            continue
        if match.group("key") in seen:
            duplicates.append(match.group("key"))
        seen.add(match.group("key"))
    return duplicates


def flow_style_mappings(lines, indent: int, key: str):
    """True when `key:` at one indentation level carries an inline flow mapping."""
    return any(
        re.match(rf"^ {{{indent}}}{re.escape(key)}[ \t]*:[ \t]*\S", line) for line in lines
    )


def job_findings(read_text, spec, workflow, job, expected_job_if):
    """Job-level findings that would let a guarded step be skipped, softened, or mis-executed."""
    findings = []
    text = read_text(workflow)
    job_text = workflow_job_block(text, job)
    if job_text is None:
        return [f"{workflow}: missing job {job!r}"]
    job_lines = job_text.splitlines()
    job_if = find_key_index(job_lines, 4, "if")[1]
    if job_if != expected_job_if:
        findings.append(
            f"{workflow}: job {job!r} conditional {job_if!r} is not the pinned legitimate one "
            f"{expected_job_if!r}"
        )
    job_continue_on_error = find_key_index(job_lines, 4, "continue-on-error")[1]
    if job_continue_on_error is not None and job_continue_on_error.lower() != "false":
        findings.append(
            f"{workflow}: job {job!r} continue-on-error makes a failed {spec['label']} advisory"
        )
    workflow_lines = text.splitlines()
    workflow_defaults_index = next(
        (i for i, line in enumerate(workflow_lines) if re.match(r"^defaults[ \t]*:[ \t]*$", line)),
        None,
    )
    workflow_shell = (
        subtree_scalar(workflow_lines, workflow_defaults_index, "shell")
        if workflow_defaults_index is not None
        else None
    )
    if not shell_template_is_fail_closed(workflow_shell):
        findings.append(
            f"{workflow}: workflow defaults shell {workflow_shell!r} drops errexit for the "
            f"{spec['label']}"
        )
    job_defaults_index = next(
        (i for i, line in enumerate(job_lines) if re.match(r"^ {4}defaults[ \t]*:[ \t]*$", line)),
        None,
    )
    job_shell = (
        subtree_scalar(job_lines, job_defaults_index, "shell")
        if job_defaults_index is not None
        else None
    )
    if not shell_template_is_fail_closed(job_shell):
        findings.append(
            f"{workflow}: job {job!r} defaults shell {job_shell!r} drops errexit for the "
            f"{spec['label']}"
        )
    for line_number, text_line in non_canonical_keys(job_lines):
        findings.append(
            f"{workflow}: job {job!r} line {line_number} spells a key as {text_line!r}; YAML reads "
            "`key : value` as `key: value`"
        )
    for key in duplicate_keys(job_lines, 4):
        findings.append(f"{workflow}: job {job!r} declares {key!r} more than once; YAML keeps the last value")
    if flow_style_mappings(job_lines, 4, "env"):
        findings.append(
            f"{workflow}: job {job!r} declares a flow-style env mapping this guard cannot classify"
        )
    for key in shell_semantics_env_keys(job_lines, 4):
        findings.append(
            f"{workflow}: job {job!r} env {key!r} can change how the {spec['label']} is executed"
        )
    return findings


def step_findings(spec, workflow, step_name, step_text, expected_step_if):
    """Findings for one workflow step whose run body names a guarded script.

    YAML key order carries no meaning, so every step key is read from the whole step block -
    a conditional or `continue-on-error:` written after the `run:` body is the same step key
    as one written before it and is classified the same way.
    """
    findings = []
    where = f"{workflow} step {step_name!r}"
    step_lines = step_text.splitlines()
    step_if = find_key_index(step_lines, 8, "if")[1]
    if step_if != expected_step_if:
        findings.append(
            f"{where}: conditional {step_if!r} is not the pinned legitimate one {expected_step_if!r}; "
            f"every step that invokes {spec['script']} must carry exactly one pinned conditional"
        )
    step_continue_on_error = find_key_index(step_lines, 8, "continue-on-error")[1]
    if step_continue_on_error is not None and step_continue_on_error.lower() != "false":
        findings.append(f"{where}: continue-on-error makes a failed {spec['label']} advisory")
    step_shell = find_key_index(step_lines, 8, "shell")[1]
    if not shell_template_is_fail_closed(step_shell):
        findings.append(f"{where}: shell {step_shell!r} drops errexit for the {spec['label']} step")
    if flow_style_mappings(step_lines, 8, "env"):
        findings.append(f"{where}: declares a flow-style env mapping this guard cannot classify")
    for key in shell_semantics_env_keys(step_lines, 8):
        findings.append(f"{where}: env {key!r} can change how the {spec['label']} is executed")
    for line_number, text_line in non_canonical_keys(step_lines):
        findings.append(
            f"{where}: line {line_number} spells a key as {text_line!r}; YAML reads `key : value` "
            "as `key: value`, so a reader that requires the colon to touch the key would miss it"
        )
    for key in duplicate_keys(step_lines, 8):
        findings.append(
            f"{where}: declares {key!r} more than once; YAML keeps the last value and hides the first"
        )
    run_body = step_run_body(step_text)
    if run_body is None:
        findings.append(f"{where}: has no run body")
        return findings
    findings.extend(shell_state_findings(run_body, where, spec))
    findings.extend(errexit_findings(run_body, where, spec, invocation_functions(run_body, spec), False))
    body_findings, real, mentions = classify_invocations(run_body, where, spec, workflow)
    findings.extend(body_findings)
    if mentions == 0:
        findings.append(f"{where}: never invokes {spec['script']}")
    elif real == 0:
        findings.append(
            f"{where}: only a --self-test arm invokes {spec['script']}; "
            f"the {spec['label']} itself is never verified"
        )
    return findings


def check_workflow_steps(read_text, spec):
    """Findings for every step that invokes a guarded script, and for every pin that lost its step.

    Steps are discovered from the workflow text rather than from a fixed list, so a call site
    added to a new step is classified instead of being ignored, and a new step may not carry a
    conditional the guard has no pin for. A flow-style step mapping (`- {name: ..., run: ...}`) is
    one line of YAML that no line-oriented reader can take apart, so a step written that way and
    naming the guarded script is refused rather than skipped.
    """
    findings = []
    pinned_ifs = {(workflow, name): expected for workflow, name, expected in spec["workflow_steps"]}
    workflows = tuple(dict.fromkeys(workflow for workflow, _name, _if in spec["workflow_steps"]))
    for workflow in workflows:
        seen = set()
        for step_name, step_text in workflow_step_blocks(read_text(workflow)):
            if FLOW_STYLE_STEP.match(step_text):
                if spec["script"] in step_text:
                    findings.append(
                        f"{workflow}: a flow-style step mapping names {spec['script']} inside one "
                        "line of YAML this guard cannot classify"
                    )
                continue
            run_body = step_run_body(step_text)
            if run_body is None or not body_mentions(run_body, spec["script"]):
                continue
            seen.add(step_name)
            findings.extend(
                step_findings(spec, workflow, step_name, step_text, pinned_ifs.get((workflow, step_name)))
            )
        for pinned_name in (name for w, name, _if in spec["workflow_steps"] if w == workflow):
            if pinned_name not in seen:
                findings.append(f"{workflow}: missing {spec['label']} step {pinned_name!r}")
    return findings


def check_invocation_shapes(read_text):
    """Every finding that makes a guarded release-gate invocation anything but the pinned call."""
    findings = []
    for spec in (PAIRING_SPEC, META_GUARD_SPEC):
        for workflow, job, expected_job_if in spec["jobs"]:
            findings.extend(job_findings(read_text, spec, workflow, job, expected_job_if))
        findings.extend(check_workflow_steps(read_text, spec))
        for path in spec["shell_invokers"]:
            text = read_text(path)
            body_findings, real, mentions = classify_invocations(text, path, spec, path)
            findings.extend(body_findings)
            if mentions == 0:
                findings.append(f"{path}: never invokes {spec['script']}")
            elif real == 0:
                findings.append(
                    f"{path}: only a --self-test arm invokes {spec['script']}; "
                    f"the {spec['label']} itself is never verified"
                )
            # The shell state is checked like any other body: the shell invoker has to establish
            # errexit itself, and only the constructs named in SHELL_STATE_EXEMPTIONS are passed.
            findings.extend(
                shell_state_findings(text, path, spec, SHELL_STATE_EXEMPTIONS.get(path, ()))
            )
            findings.extend(
                errexit_findings(text, path, spec, invocation_functions(text, spec), True)
            )
    for workflow in GUARDED_WORKFLOWS:
        text = read_text(workflow)
        if MERGE_KEY.search(text):
            findings.append(
                f"{workflow}: declares a YAML merge key (`<<:`) this guard refuses to classify"
            )
        if DOCUMENT_SEPARATOR.search(text):
            findings.append(
                f"{workflow}: contains a YAML document separator; GitHub loads one workflow per "
                "file, so a second document would be read differently by the runner"
            )
        if YAML_ALIAS.search(text):
            findings.append(
                f"{workflow}: uses a YAML alias, which re-points a value at a node defined "
                "elsewhere; this guard reads literal text and cannot follow the reference"
            )
        workflow_lines = text.splitlines()
        for key in shell_semantics_env_keys(workflow_lines, 0):
            findings.append(
                f"{workflow}: workflow-level env {key!r} can change how a guarded release-gate "
                "invocation is executed"
            )
        if flow_style_mappings(workflow_lines, 0, "env"):
            findings.append(
                f"{workflow}: declares a workflow-level flow-style env mapping this guard cannot "
                "classify"
            )
    return findings


CI_STEP_HEADER = f"      - name: {PAIRING_STEP_NAME}\n"
CI_BARE = f"          bash {PAIRING_SCRIPT_PATH}\n"
CI_SELF_TEST = f"          bash {PAIRING_SCRIPT_PATH} --self-test\n"
CI_STEP_RUN = CI_STEP_HEADER + "        run: |\n"
CI_STEP = CI_STEP_RUN + CI_SELF_TEST + CI_BARE
CI_JOB = "  release-security-gates:\n    name: Release/security gates\n"
CI_HEAD = "name: CI\n\non:\n"
CI_GUARD_BARE = f"          bash {META_GUARD_SCRIPT_PATH}\n"
GATES_GUARD_BARE = f"bash ./{META_GUARD_SCRIPT_PATH}\n"
GATES_GUARD_SELF_TEST = f"bash ./{META_GUARD_SCRIPT_PATH} --self-test\n"
PREMAIN_GUARD_RUN = f"        run: bash {META_GUARD_SCRIPT_PATH}\n"
RELEASE_PR_STEP_IF = "        if: steps.release_pr.outputs.exists == 'true'\n"
RELEASE_PR_STEP_HEAD = RELEASE_PR_STEP_IF + "        run: |\n" + CI_SELF_TEST
RELEASE_BRANCH_BARE = f'{PAIRING_SCRIPT_PATH} --tag "${{expected_tag}}"\n'
GATES_BARE = f"bash ./{PAIRING_SCRIPT_PATH}\n"
GOV_VERIFIER = "gov-infra/verifiers/gov-verify-rubric.sh"
GOV_CALL_ANCHOR = (
    '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n'
)

# One attack per weakening shape. Each anchor is asserted to exist so a drifted fixture
# fails the self-test loudly instead of silently dropping coverage.
SELF_TEST_ATTACKS = (
    ("`!` prefix negation", ".github/workflows/ci.yml", CI_BARE, f"          ! bash {PAIRING_SCRIPT_PATH}\n", "negated"),
    ("`|| echo advisory`", ".github/workflows/ci.yml", CI_BARE, f"          bash {PAIRING_SCRIPT_PATH} || echo advisory\n", "exit status does not govern"),
    ("`if false; then ... fi` wrap", ".github/workflows/ci.yml", CI_BARE, f"          if false; then\n            bash {PAIRING_SCRIPT_PATH}\n          fi\n", "conditional or loop block"),
    ("commented-out invocation", ".github/workflows/ci.yml", CI_BARE, f"          # bash {PAIRING_SCRIPT_PATH}\n", "named in a comment"),
    ("step-level `if: false`", ".github/workflows/ci.yml", CI_STEP_RUN, CI_STEP_HEADER + "        if: false\n        run: |\n", "not the pinned legitimate one"),
    ("step-level `if: ${{ false }}`", ".github/workflows/ci.yml", CI_STEP_RUN, CI_STEP_HEADER + "        if: ${{ false }}\n        run: |\n", "not the pinned legitimate one"),
    ("step-level `if: always()`", ".github/workflows/ci.yml", CI_STEP_RUN, CI_STEP_HEADER + "        if: always()\n        run: |\n", "not the pinned legitimate one"),
    ("job-level `if: false`", ".github/workflows/ci.yml", CI_JOB, "  release-security-gates:\n    if: false\n    name: Release/security gates\n", "not the pinned legitimate one"),
    ("`|| true`", ".github/workflows/ci.yml", CI_BARE, f"          bash {PAIRING_SCRIPT_PATH} || true\n", "exit status does not govern"),
    ("`|| :`", ".github/workflows/ci.yml", CI_BARE, f"          bash {PAIRING_SCRIPT_PATH} || :\n", "exit status does not govern"),
    ("`||:`", ".github/workflows/ci.yml", CI_BARE, f"          bash {PAIRING_SCRIPT_PATH} ||:\n", "exit status does not govern"),
    ("`&& true`", ".github/workflows/ci.yml", CI_BARE, f"          bash {PAIRING_SCRIPT_PATH} && true\n", "exit status does not govern"),
    ("`|| exit 0`", ".github/workflows/ci.yml", CI_BARE, f"          bash {PAIRING_SCRIPT_PATH} || exit 0\n", "exit status does not govern"),
    ("`; true`", ".github/workflows/ci.yml", CI_BARE, f"          bash {PAIRING_SCRIPT_PATH}; true\n", "exit status does not govern"),
    ("usage-exit flag `--help`", ".github/workflows/ci.yml", CI_BARE, f"          bash {PAIRING_SCRIPT_PATH} --help\n", "usage flag"),
    ("usage-exit flag `-h`", ".github/workflows/ci.yml", CI_BARE, f"          bash {PAIRING_SCRIPT_PATH} -h\n", "usage flag"),
    ("step-level continue-on-error", ".github/workflows/ci.yml", CI_STEP_RUN, CI_STEP_HEADER + "        continue-on-error: true\n        run: |\n", "continue-on-error"),
    ("job-level continue-on-error", ".github/workflows/ci.yml", CI_JOB, "  release-security-gates:\n    continue-on-error: true\n    name: Release/security gates\n", "continue-on-error"),
    ("backslash continuation hiding `|| true`", ".github/workflows/ci.yml", CI_BARE, f"          bash {PAIRING_SCRIPT_PATH} \\\n            || true\n", "exit status does not govern"),
    ("`--self-test`-only step", ".github/workflows/ci.yml", CI_STEP, CI_STEP_RUN + CI_SELF_TEST, "never verified"),
    ("step-level `shell: bash {0}`", ".github/workflows/ci.yml", CI_STEP_RUN, CI_STEP_HEADER + "        shell: bash {0}\n        run: |\n", "drops errexit"),
    ("workflow-level `defaults: run: shell: bash {0}`", ".github/workflows/ci.yml", CI_HEAD, "name: CI\ndefaults:\n  run:\n    shell: bash {0}\n\non:\n", "drops errexit"),
    ("env indirection via `BASH_ENV`", ".github/workflows/ci.yml", CI_STEP_RUN, CI_STEP_HEADER + "        env:\n          BASH_ENV: ./weaken.sh\n        run: |\n", "BASH_ENV"),
    ("flow-style `env: {BASH_ENV: ...}`", ".github/workflows/ci.yml", CI_STEP_RUN, CI_STEP_HEADER + "        env: {BASH_ENV: ./weaken.sh}\n        run: |\n", "flow-style env"),
    ("job-level `env: BASH_ENV`", ".github/workflows/ci.yml", CI_JOB, "  release-security-gates:\n    env:\n      BASH_ENV: ./weaken.sh\n    name: Release/security gates\n", "BASH_ENV"),
    ("backgrounded invocation (`&`)", ".github/workflows/ci.yml", CI_BARE, f"          bash {PAIRING_SCRIPT_PATH} &\n", "trailing '&'"),
    ("duplicate `run:` key in the step", ".github/workflows/ci.yml", CI_BARE, CI_BARE + f"        run: bash {PAIRING_SCRIPT_PATH} || true\n", "more than once"),
    ("duplicate `if:` key on the release PR step", ".github/workflows/release-pr.yml", RELEASE_PR_STEP_HEAD, RELEASE_PR_STEP_IF + "        if: false\n" + "        run: |\n" + CI_SELF_TEST, "more than once"),
    ("folded `run: >-` hiding `|| true`", ".github/workflows/ci.yml", CI_STEP, CI_STEP_HEADER + "        run: >-\n" + CI_SELF_TEST + f"          bash {PAIRING_SCRIPT_PATH} || true\n", "exit status does not govern"),
    ("heredoc-smuggled invocation", ".github/workflows/ci.yml", CI_BARE, f"          cat <<EOF\n{CI_BARE}          EOF\n", "never verified"),
    ("shell invoker: backgrounded invocation (`&`)", "scripts/verify-release-branch.sh", RELEASE_BRANCH_BARE, RELEASE_BRANCH_BARE.rstrip("\n") + " &\n", "trailing '&'"),
    ("quoted script path", "scripts/verify-release-gates.sh", GATES_BARE, f'bash "./{PAIRING_SCRIPT_PATH}"\n', "not positively classifiable"),
    ("variable indirection", ".github/workflows/ci.yml", CI_BARE, f'          PAIR="{PAIRING_SCRIPT_PATH}"\n          bash "${{PAIR}}"\n', "not positively classifiable"),
    ("release PR step-level `if: false`", ".github/workflows/release-pr.yml", RELEASE_PR_STEP_HEAD, "        if: false\n        run: |\n" + CI_SELF_TEST, "not the pinned legitimate one"),
    ("shell invoker: commented-out invocation", "scripts/verify-release-branch.sh", RELEASE_BRANCH_BARE, f"# {RELEASE_BRANCH_BARE}", "named in a comment"),
    ("shell invoker: `if false; then ... fi` wrap", "scripts/verify-release-branch.sh", RELEASE_BRANCH_BARE, f'if false; then\n  {RELEASE_BRANCH_BARE}fi\n', "conditional or loop block"),
    ("shell invoker: errexit disabled with `set +e`", "scripts/verify-release-branch.sh", "# The apptheory-init templates substitute", "set +e\n# The apptheory-init templates substitute", "clears errexit"),
    ("shell invoker: errexit never set", "scripts/verify-release-branch.sh", "set -euo pipefail\n", "set -uo pipefail\n", "does not set errexit"),
    ("shell invoker: `bash` shadowed by a function", "scripts/verify-release-gates.sh", GATES_BARE, GATES_BARE + "bash() { return 0; }\n", "shadowed"),
    # B1 - a step key written after the run body is the same step key (YAML key order carries
    # no meaning), so every step key is classified from the whole step block.
    ("step-level `if: false` written after the run body", ".github/workflows/ci.yml", CI_STEP, CI_STEP + "        if: false\n", "not the pinned legitimate one"),
    ("step-level `continue-on-error: true` written after the run body", ".github/workflows/ci.yml", CI_STEP, CI_STEP + "        continue-on-error: true\n", "continue-on-error"),
    ("step-level `shell: bash {0}` written after the run body", ".github/workflows/ci.yml", CI_STEP, CI_STEP + "        shell: bash {0}\n", "drops errexit"),
    ("step-level `env: BASH_ENV` written after the run body", ".github/workflows/ci.yml", CI_STEP, CI_STEP + "        env:\n          BASH_ENV: ./weaken.sh\n", "BASH_ENV"),
    ("meta-guard step `if: false` written after the run body", ".github/workflows/ci.yml", CI_GUARD_BARE, CI_GUARD_BARE + "        if: false\n", "not the pinned legitimate one"),
    # B2 - the whole run body is the shell that executes the invocation, so shadowing, errexit
    # and shell state anywhere in that body decide whether the invocation can fail the step.
    ("step body shadows `bash` with a function", ".github/workflows/ci.yml", CI_BARE, "          bash() { return 0; }\n" + CI_BARE, "shadowed"),
    ("step body shadows `exit` with a function", ".github/workflows/ci.yml", CI_BARE, f'          exit() {{ :; }}\n          bash {PAIRING_SCRIPT_PATH} || exit 1\n', "shadowed"),
    ("step body reassigns PATH", ".github/workflows/ci.yml", CI_BARE, "          PATH=/tmp/evil:$PATH\n" + CI_BARE, "reassigns PATH"),
    ("PATH prefix on the invocation line", ".github/workflows/ci.yml", CI_BARE, f"          PATH=/tmp/evil:$PATH bash {PAIRING_SCRIPT_PATH}\n", "not positively classifiable"),
    ("step body clears errexit with `set +e` and a trailing success", ".github/workflows/ci.yml", CI_BARE, f"          set +e\n          bash {PAIRING_SCRIPT_PATH}\n          true\n", "clears errexit"),
    ("step body installs a trap that overrides the exit status", ".github/workflows/ci.yml", CI_BARE, f"          trap 'exit 0' ERR\n          bash {PAIRING_SCRIPT_PATH}\n", "installs a trap"),
    ("step body reassigns BASH_ENV", ".github/workflows/ci.yml", CI_BARE, f"          export BASH_ENV=./weaken.sh\n          bash {PAIRING_SCRIPT_PATH}\n", "reassigns BASH_ENV"),
    ("meta-guard step body shadows `bash`", ".github/workflows/ci.yml", CI_GUARD_BARE, "          bash() { return 0; }\n" + CI_GUARD_BARE, "shadowed"),
    ("shell invoker: function shadows `bash` before the invocation", "scripts/verify-release-gates.sh", GATES_BARE, f"bash() {{ return 0; }}\n" + GATES_BARE, "shadowed"),
    ("shell invoker: `exit() { :; }` with a tolerated fail-closed tail", "scripts/verify-release-branch.sh", RELEASE_BRANCH_BARE, f'exit() {{ :; }}\n{PAIRING_SCRIPT_PATH} --tag "${{expected_tag}}" || exit 1\n', "shadowed"),
    ("shell invoker: PATH prefix on the invocation line", "scripts/verify-release-branch.sh", RELEASE_BRANCH_BARE, f'PATH=/tmp/evil:$PATH {PAIRING_SCRIPT_PATH} --tag "${{expected_tag}}"\n', "not positively classifiable"),
    ("shell invoker: PATH reassignment before the invocation", "scripts/verify-release-branch.sh", RELEASE_BRANCH_BARE, "PATH=/tmp/evil:$PATH\n" + RELEASE_BRANCH_BARE, "reassigns PATH"),
    # B3 - GitHub substitutes `${{ }}` and expands variables before bash parses the line, so an
    # argument the guard cannot read literally can inject a list operator or a usage flag.
    ("`${{ }}` expression as an argument", ".github/workflows/ci.yml", CI_BARE, f"          bash {PAIRING_SCRIPT_PATH} ${{{{ env.WEAKEN }}}}\n", "substitutes into the command line"),
    ("variable-indirected `--help` argument", ".github/workflows/ci.yml", CI_BARE, f'          PAIRING_ARGS=--help\n          bash {PAIRING_SCRIPT_PATH} "${{PAIRING_ARGS}}"\n', "cannot be read literally"),
    ("variable-indirected `--self-test` argument in a release PR workflow", ".github/workflows/release-pr.yml", CI_BARE, f'          PAIRING_ARGS=--self-test\n          bash {PAIRING_SCRIPT_PATH} "${{PAIRING_ARGS}}"\n', "cannot be read literally"),
    ("shell invoker: variable-indirected argument", "scripts/verify-release-gates.sh", GATES_BARE, f'{PAIRING_SCRIPT_PATH} "${{PAIRING_ARGS}}"\n', "cannot be read literally"),
    # B4 - `|| exit 1 &` backgrounds the whole list, so the tolerated tail no longer decides
    # the step's exit status. Any separator after the tail is reported.
    ("tolerated tail backgrounded with `&`", ".github/workflows/ci.yml", CI_BARE, f"          bash {PAIRING_SCRIPT_PATH} || exit 1 &\n", "trails '&'"),
    ("statement after the tolerated tail", ".github/workflows/ci.yml", CI_BARE, f"          bash {PAIRING_SCRIPT_PATH} || exit 1; true\n", "follows the tolerated fail-closed tail"),
    ("tolerated tail piped into a command", ".github/workflows/ci.yml", CI_BARE, f"          bash {PAIRING_SCRIPT_PATH} || exit 1 | tee log\n", "trails '|'"),
    ("shell invoker: tolerated tail backgrounded with `&`", "scripts/verify-release-branch.sh", RELEASE_BRANCH_BARE, f'{PAIRING_SCRIPT_PATH} --tag "${{expected_tag}}" || return 1 &\n', "trails '&'"),
    # H1 - the meta-guard's own invocations are classified the same way, so weakening a call of
    # the guard fails as loudly as weakening a call of the gate it guards.
    ("meta-guard call with `|| true` in CI", ".github/workflows/ci.yml", CI_GUARD_BARE, f"          bash {META_GUARD_SCRIPT_PATH} || true\n", "exit status does not govern"),
    ("meta-guard call with `|| true` in the full release gates", "scripts/verify-release-gates.sh", GATES_GUARD_BARE, f"bash ./{META_GUARD_SCRIPT_PATH} || true\n", "exit status does not govern"),
    ("meta-guard call backgrounded in the full release gates", "scripts/verify-release-gates.sh", GATES_GUARD_BARE, GATES_GUARD_BARE.rstrip("\n") + " &\n", "trailing '&'"),
    ("meta-guard self-test arm negated in the full release gates", "scripts/verify-release-gates.sh", GATES_GUARD_SELF_TEST, "! " + GATES_GUARD_SELF_TEST, "negated"),
    ("meta-guard call with `|| true` in the prerelease preflight", ".github/workflows/prerelease.yml", PREMAIN_GUARD_RUN, f"        run: bash {META_GUARD_SCRIPT_PATH} || true\n", "exit status does not govern"),
    ("meta-guard step conditional changed in the stable preflight", ".github/workflows/release.yml", "        if: " + RELEASE_MAIN_PREFLIGHT_IF + "\n" + PREMAIN_GUARD_RUN, "        if: false\n" + PREMAIN_GUARD_RUN, "not the pinned legitimate one"),
    ("YAML merge key in a guarded workflow", ".github/workflows/ci.yml", CI_HEAD, "name: CI\n<<: *defaults\n\non:\n", "merge key"),
    # A call site added to a new step is discovered and classified rather than ignored, and an
    # unpinned conditional on a new call site fails closed.
    ("unpinned new step invoking the meta-guard with `|| true`", ".github/workflows/ci.yml", CI_STEP_HEADER, "      - name: Unpinned extra gate\n        run: |\n" + CI_GUARD_BARE.rstrip("\n") + " || true\n" + CI_STEP_HEADER, "exit status does not govern"),
    ("unpinned new step invoking the pairing gate with `|| true`", ".github/workflows/ci.yml", CI_STEP_HEADER, "      - name: Unpinned pairing gate\n        run: |\n" + CI_BARE.rstrip("\n") + " || true\n" + CI_STEP_HEADER, "exit status does not govern"),
    ("unpinned new step carrying a conditional", ".github/workflows/ci.yml", CI_STEP_HEADER, "      - name: Unpinned conditional gate\n        if: always()\n        run: |\n" + CI_GUARD_BARE + CI_STEP_HEADER, "every step that invokes"),
    # R3-1 - YAML reads `key : value` as `key: value`, so every key reader tolerates the
    # whitespace, and a non-canonical key line at a key's own indentation is refused as well.
    ("step-level `if : false` (pre-colon whitespace) after the run body", ".github/workflows/ci.yml", CI_STEP, CI_STEP + "        if : false\n", "not the pinned legitimate one"),
    ("job-level `if : false` (pre-colon whitespace)", ".github/workflows/ci.yml", CI_JOB, "  release-security-gates:\n    if : false\n    name: Release/security gates\n", "not the pinned legitimate one"),
    ("step-level `continue-on-error : true` (pre-colon whitespace)", ".github/workflows/ci.yml", CI_STEP, CI_STEP + "        continue-on-error : true\n", "continue-on-error"),
    ("step-level `shell : bash {0}` (pre-colon whitespace)", ".github/workflows/ci.yml", CI_STEP, CI_STEP + "        shell : bash {0}\n", "drops errexit"),
    ("step-level duplicate `run :` key (pre-colon whitespace)", ".github/workflows/ci.yml", CI_BARE, CI_BARE + f"        run : bash {PAIRING_SCRIPT_PATH} || true\n", "more than once"),
    ("step-level `env :` with `PATH:` (pre-colon whitespace)", ".github/workflows/ci.yml", CI_STEP_RUN, CI_STEP_HEADER + "        env :\n          PATH: /tmp/evil\n        run: |\n", "env 'PATH'"),
    ("step-level non-canonical key the guard does not enumerate", ".github/workflows/ci.yml", CI_STEP, CI_STEP + "        timeout-minutes : 5\n", "spells a key as"),
    ("step-level quoted key `\"if\": false`", ".github/workflows/ci.yml", CI_STEP, CI_STEP + '        "if": false\n', "spells a key as"),
    ("step-level quoted key `'if' : false`", ".github/workflows/ci.yml", CI_STEP, CI_STEP + "        'if' : false\n", "spells a key as"),
    ("step-level explicit key `? if`", ".github/workflows/ci.yml", CI_STEP, CI_STEP + "        ? if\n        : false\n", "spells a key as"),
    # R3-2 - ANSI-C quoting honours backslash escapes, so `$'it\'s ok'` closes where bash closes
    # it instead of leaving a quote open that swallows every following line as data.
    ("ANSI-C quoting hiding a `PATH` reassignment", ".github/workflows/ci.yml", CI_BARE, "          echo $'it\\'s ok'\n          PATH=/tmp/evil:$PATH\n          echo 'a' 'b'\n" + CI_BARE, "reassigns PATH"),
    ("ANSI-C quoting hiding a weakened invocation", ".github/workflows/ci.yml", CI_BARE, "          echo $'it\\'s ok'\n" + f"          bash {PAIRING_SCRIPT_PATH} || true\n" + "          echo it is ok\n" + CI_BARE, "exit status does not govern"),
    # R3-3 - bash ignores errexit for every command in a function entered from a condition, so a
    # function body may hold a guarded invocation only where the spec pins that host.
    ("invocation inside a function called from an `if` condition", ".github/workflows/ci.yml", CI_BARE, "          gate() {\n" + CI_BARE + "          }\n          if gate; then\n            :\n          fi\n", "not a pinned invocation host"),
    ("invocation inside a function that is never called", ".github/workflows/ci.yml", CI_BARE, "          gate() {\n" + CI_BARE + "          }\n", "not a pinned invocation host"),
    ("invocation inside a negated function call", ".github/workflows/ci.yml", CI_BARE, "          gate() {\n" + CI_BARE + "          }\n          ! gate\n", "not a pinned invocation host"),
    ("invocation inside a function in a guarded shell invoker", "scripts/verify-release-branch.sh", RELEASE_BRANCH_BARE, f'gate() {{\n  {RELEASE_BRANCH_BARE}}}\nif gate; then\n  :\nfi\n', "not a pinned invocation host"),
    ("pinned publisher host called with `|| true`", "scripts/verify-release-publish-postcondition.sh", 'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || exit 1\n', 'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || true\n', "not fail-closed"),
    ("pinned publisher host called inside a command substitution", "scripts/verify-release-publish-postcondition.sh", 'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || exit 1\n', 'x="$(verify_release_pairing_postcondition "${tag_name:-${expected_tag}}")"\n', "not fail-closed"),
    ("pinned publisher host called plainly inside a wrapper function", "scripts/verify-release-publish-postcondition.sh", 'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || exit 1\n', 'A() {\n  verify_release_pairing_postcondition "${tag_name:-${expected_tag}}"\n}\nif A; then\n  :\nfi\n', "not fail-closed"),
    ("pinned publisher host with `|| return 1` inside a wrapper function", "scripts/verify-release-publish-postcondition.sh", 'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || exit 1\n', 'A() {\n  verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || return 1\n}\nA\n', "not fail-closed"),
    ("pinned indirect dispatch with a trailing `|| true`", "gov-infra/verifiers/gov-verify-rubric.sh", 'run_check "CMP-4" "Compliance" "$CMD_RELEASE_LIFECYCLE"\n', 'run_check "CMP-4" "Compliance" "$CMD_RELEASE_LIFECYCLE" || true\n', "not fail-closed"),
    ("pinned indirect dispatch removed", "gov-infra/verifiers/gov-verify-rubric.sh", 'run_check "CMP-4" "Compliance" "$CMD_RELEASE_LIFECYCLE"\n', "", "is missing"),
    ("pinned dispatch function stops re-enabling errexit", "gov-infra/verifiers/gov-verify-rubric.sh", '    set -euo pipefail\n    eval "${cmd}"\n', '    eval "${cmd}"\n', "no longer contains the pinned"),
    ("pinned dispatch function softens its errexit setup", "gov-infra/verifiers/gov-verify-rubric.sh", '    set -euo pipefail\n    eval "${cmd}"\n', '    set -e\n    eval "${cmd}"\n', "no longer contains the pinned"),
    # R3-4 - the runner applies step, job and workflow `env:` before bash starts, so the variables
    # that decide which program runs or how a shell starts are checked at every level.
    ("step-level `env: PATH`", ".github/workflows/ci.yml", CI_STEP_RUN, CI_STEP_HEADER + "        env:\n          PATH: /tmp/evil\n        run: |\n", "env 'PATH'"),
    ("job-level `env: PATH`", ".github/workflows/ci.yml", CI_JOB, "  release-security-gates:\n    env:\n      PATH: /tmp/evil\n    name: Release/security gates\n", "env 'PATH'"),
    ("workflow-level `env: CDPATH`", ".github/workflows/ci.yml", CI_HEAD, "name: CI\nenv:\n  CDPATH: /tmp/evil\n\non:\n", "workflow-level env 'CDPATH'"),
    ("step-level `env: BASHOPTS`", ".github/workflows/ci.yml", CI_STEP_RUN, CI_STEP_HEADER + "        env:\n          BASHOPTS: expand_aliases\n        run: |\n", "env 'BASHOPTS'"),
    ("step-level `env: PATH` written as a flow mapping", ".github/workflows/ci.yml", CI_STEP_RUN, CI_STEP_HEADER + "        env: {PATH: /tmp/evil}\n        run: |\n", "flow-style env"),
    # R3-5 - the gov verifier is state-checked like any other body. Only the two constructs it
    # legitimately needs are exempted, by exact statement text.
    ("gov verifier: `bash` shadowed in the checked function", GOV_VERIFIER, GOV_CALL_ANCHOR, '  echo "==> release workflow invariants"\n  bash() { return 0; }\n  bash ./scripts/verify-release-workflows.sh\n', "shadowed"),
    ("gov verifier: stray `PATH` reassignment in the checked function", GOV_VERIFIER, GOV_CALL_ANCHOR, '  echo "==> release workflow invariants"\n  export PATH="/tmp/evil:${PATH}"\n  bash ./scripts/verify-release-workflows.sh\n', "reassigns PATH"),
    ("gov verifier: extra trap in the checked function", GOV_VERIFIER, GOV_CALL_ANCHOR, '  echo "==> release workflow invariants"\n  trap \'exit 0\' EXIT\n  bash ./scripts/verify-release-workflows.sh\n', "installs a trap"),
    ("gov verifier: errexit cleared in the checked function", GOV_VERIFIER, GOV_CALL_ANCHOR, '  echo "==> release workflow invariants"\n  set +e\n  bash ./scripts/verify-release-workflows.sh\n', "clears errexit"),
    ("gov verifier: the pinned toolchain export renamed", GOV_VERIFIER, 'export PATH="${GOV_TOOLS_BIN}:${GOV_TOOLS_PY_BIN}:${GOV_TOOLS_PY_RUNTIME_BIN}:${PATH}"\n', 'export PATH="${GOV_TOOLS_BIN}:${PATH}"\n', "reassigns PATH"),
    # R3-6 - a flow-style step mapping is one line of YAML no line-oriented reader can take apart,
    # so a step written that way and naming the guarded script is refused instead of skipped.
    ("flow-style step mapping invoking the pairing gate", ".github/workflows/ci.yml", CI_STEP, CI_STEP + f'      - {{name: Extra gate, run: "bash {PAIRING_SCRIPT_PATH} || true"}}\n', "flow-style step mapping"),
    ("flow-style step mapping invoking the meta-guard", ".github/workflows/ci.yml", CI_STEP_HEADER, '      - {name: Extra guard, run: "bash scripts/verify-release-workflows.sh || true"}\n' + CI_STEP_HEADER, "flow-style step mapping"),
    # Claim boundaries: the classes the doc says are refused rather than read past.
    ("second YAML document in a guarded workflow", ".github/workflows/ci.yml", CI_HEAD, CI_HEAD + "---\njobs: {}\n", "document separator"),
    ("YAML alias as a step run body", ".github/workflows/ci.yml", CI_STEP, CI_STEP + '      - name: Extra anchored gate\n        run: &weak "bash scripts/verify-release-pairing.sh || true"\n      - name: Extra aliased gate\n        run: *weak\n', "YAML alias"),
)

# Shapes GLM confirmed are correctly accepted. Each must produce no finding at all, so the battery
# fails if the classifier starts over-blocking a fail-closed spelling that differs from the pinned
# one in a way that does not weaken it.
SELF_TEST_ACCEPTED = (
    ("trailing comment after the invocation", ".github/workflows/ci.yml", CI_BARE, f"          bash {PAIRING_SCRIPT_PATH} # pinned in the release doc\n"),
    ("next-line `true` after the invocation", ".github/workflows/ci.yml", CI_BARE, CI_BARE + "          true\n"),
    ("quoted pinned `--self-test` argument", ".github/workflows/ci.yml", CI_SELF_TEST, f'          bash {PAIRING_SCRIPT_PATH} "--self-test"\n'),
    ("set +e / set -e capture pair in an unrelated gov verifier function", GOV_VERIFIER, "check_file_budgets() {\n", "check_file_budgets() {\n  set +e\n  :\n  set -e\n"),
    ("YAML anchor defined in an inert `x-` section", ".github/workflows/ci.yml", CI_HEAD, 'name: CI\nx-bodies:\n  weak: &weak "bash scripts/verify-release-pairing.sh || true"\n\non:\n'),
)


def run_self_test() -> None:
    real = {path: Path(path).read_text(encoding="utf-8") for path in GUARDED_FILES}

    def read_from(source):
        def read_text(path):
            if path not in source:
                raise SystemExit(
                    f"release-workflows: FAIL (self-test read {path!r} outside the fixture set)"
                )
            return source[path]

        return read_text

    baseline = check_invocation_shapes(read_from(real))
    if baseline:
        raise SystemExit(
            "release-workflows: FAIL (self-test: the legitimate guarded wiring was REJECTED, so the "
            "guard over-blocks: " + "; ".join(baseline)
        )
    print("release-workflows: PASS-PROOF (self-test accepted: the legitimate guarded wiring at HEAD)")

    for label, path, anchor, replacement, expected in SELF_TEST_ATTACKS:
        source = dict(real)
        if anchor not in source[path]:
            raise SystemExit(
                f"release-workflows: FAIL (self-test fixture drifted: the {label!r} anchor is missing "
                f"from {path})"
            )
        source[path] = source[path].replace(anchor, replacement, 1)
        findings = check_invocation_shapes(read_from(source))
        if not findings:
            raise SystemExit(
                f"release-workflows: FAIL (self-test MISSED the {label!r} weakening in {path})"
            )
        joined = " | ".join(findings)
        if expected not in joined:
            raise SystemExit(
                f"release-workflows: FAIL (self-test caught the {label!r} weakening but reported an "
                f"unexpected diagnostic; expected {expected!r} in {joined!r})"
            )
        print(f"release-workflows: FAIL-PROOF (self-test rejected: {label} in {path})")

    for label, path, anchor, replacement in SELF_TEST_ACCEPTED:
        source = dict(real)
        if anchor not in source[path]:
            raise SystemExit(
                f"release-workflows: FAIL (self-test fixture drifted: the {label!r} anchor is missing "
                f"from {path})"
            )
        source[path] = source[path].replace(anchor, replacement, 1)
        findings = check_invocation_shapes(read_from(source))
        if findings:
            raise SystemExit(
                f"release-workflows: FAIL (self-test OVER-BLOCKS the accepted shape {label!r} in "
                f"{path}: " + "; ".join(findings)
            )
        print(f"release-workflows: ACCEPT-PROOF (self-test accepted: {label} in {path})")

    print(
        f"release-workflows: PASS (self-test: {len(SELF_TEST_ATTACKS)} weakening shape(s) failed closed, "
        f"{len(SELF_TEST_ACCEPTED)} fail-closed spelling(s) accepted, legitimate wiring accepted)"
    )


if MODE == "self-test":
    run_self_test()
    raise SystemExit(0)

invocation_shape_findings = check_invocation_shapes(
    lambda path: Path(path).read_text(encoding="utf-8")
)
if invocation_shape_findings:
    raise SystemExit(
        "release-workflows: FAIL (a guarded release-gate invocation is not the pinned fail-closed "
        "call; " + "; ".join(invocation_shape_findings) + ")"
    )


require_order(
    ".github/workflows/prerelease.yml",
    "Verify branch version sync (release preflight)",
    "Release Please (Prerelease)",
    "prerelease creation must fail closed on stale branch release state before release-please can publish",
)
require_order(
    ".github/workflows/release.yml",
    "Verify branch version sync (stable release preflight)",
    "Release Please (Stable)",
    "stable release creation must fail closed on stale branch release state before release-please can publish",
)
require_order(
    ".github/workflows/prerelease.yml",
    "Release Please (Prerelease)",
    "Verify prerelease publish postcondition",
    "prerelease publisher must validate release-please outputs before asset publishing",
)
require_order(
    ".github/workflows/release.yml",
    "Release Please (Stable)",
    "Verify stable publish postcondition",
    "stable publisher must validate release-please outputs before asset publishing",
)
for workflow in (".github/workflows/prerelease.yml", ".github/workflows/release.yml"):
    require_contains(
        workflow,
        "concurrency:\n  group: release-publisher-${{ github.repository }}\n  cancel-in-progress: false",
        "release publisher workflows must share one non-cancelling concurrency group",
    )
    require_not_contains(
        workflow,
        "cancel-in-progress: true",
        "release publisher workflows must queue reruns and workflow_dispatch events instead of cancelling an active publisher",
    )
    require_order(
        workflow,
        "workflow_dispatch",
        "concurrency:",
        "release publisher concurrency must apply at workflow scope, including workflow_dispatch reruns",
    )
    require_order(
        workflow,
        "concurrency:",
        "permissions:",
        "release publisher concurrency must be declared before jobs so the whole publisher workflow is serialized",
    )
release_pr_concurrency = {
    ".github/workflows/prerelease-pr.yml": (
        "concurrency:\n"
        "  group: release-pr-${{ github.repository }}-release-please--branches--premain\n"
        "  cancel-in-progress: false"
    ),
    ".github/workflows/release-pr.yml": (
        "concurrency:\n"
        "  group: release-pr-${{ github.repository }}-release-please--branches--main\n"
        "  cancel-in-progress: false"
    ),
}
for workflow, snippet in release_pr_concurrency.items():
    require_contains(
        workflow,
        snippet,
        "generated release PR workflows must serialize per release PR without cancelling an active sync",
    )
    require_not_contains(
        workflow,
        "cancel-in-progress: true",
        "generated release PR workflows must queue overlapping runs instead of cancelling an active sync",
    )
    require_order(
        workflow,
        "workflow_dispatch",
        "concurrency:",
        "generated release PR concurrency must apply at workflow scope, including workflow_dispatch reruns",
    )
    require_order(
        workflow,
        "concurrency:",
        "jobs:",
        "generated release PR concurrency must be declared before jobs so PR sync is serialized",
    )
release_please_draft_guard = (
    "if: github.event_name != 'pull_request' || github.event.pull_request.draft == false || "
    "(github.event.pull_request.head.ref != 'release-please--branches--premain' && "
    "github.event.pull_request.head.ref != 'release-please--branches--main')"
)
for job in ("version-alignment", "go", "ts", "py", "contract-tests"):
    require_job_contains(
        ".github/workflows/ci.yml",
        job,
        release_please_draft_guard,
        "required CI checks must not evaluate draft release-please heads before generated artifacts are synced",
    )
require_not_contains(
    ".github/workflows/release.yml",
    "if: github.ref == 'refs/heads/main'\n",
    "workflow_dispatch existing-tag uploads must not run stable main preflight from branch HEAD",
)
require_contains(
    ".github/workflows/release.yml",
    "if: github.ref == 'refs/heads/main' && inputs.tag_name == ''",
    "stable release branch preflight must be skipped for workflow_dispatch existing-tag uploads",
)
require_not_contains(
    ".github/workflows/release.yml",
    "ref: ${{ steps.release.outputs.tag_name }}",
    "stable release asset build must not assume release-please draft releases have materialized git tags",
)
for workflow in (".github/workflows/prerelease.yml", ".github/workflows/release.yml"):
    require_contains(
        workflow,
        'scripts/publish-release-assets.sh "${TAG_NAME}"',
        "release workflows must publish assets through the shared draft-release-safe path",
    )
    require_not_contains(
        workflow,
        "make rubric",
        "release publisher workflows must use release hygiene and publish postconditions instead of the full rubric",
    )
require_contains(
    ".github/workflows/prerelease.yml",
    "scripts/verify-release-publish-postcondition.sh prerelease",
    "prerelease publisher must fail closed when a generated RC release PR merge does not create an RC release",
)
require_contains(
    ".github/workflows/release.yml",
    "scripts/verify-release-publish-postcondition.sh stable",
    "stable publisher must fail closed when a generated stable release PR merge does not create a stable release",
)
require_contains(
    ".github/workflows/prerelease.yml",
    "Recover or verify existing prerelease",
    "prerelease reruns must recover drafts and verify already-published immutable releases",
)
require_contains(
    ".github/workflows/release.yml",
    "Recover or verify existing stable release",
    "stable reruns must recover drafts and verify already-published immutable releases",
)
for workflow, channel, closure_step in (
    (".github/workflows/prerelease.yml", "prerelease", "Verify prerelease publication closure"),
    (".github/workflows/release.yml", "stable", "Verify stable publication closure"),
):
    require_not_contains(
        workflow,
        "--json isDraft",
        "release reruns must verify already-published releases instead of skipping non-drafts",
    )
    require_contains(
        workflow,
        f'scripts/verify-release-publish-postcondition.sh {channel} "${{RELEASE_CREATED}}" "${{TAG_NAME}}" prepublish',
        "release workflows must validate Release Please output before the publisher mutates tag state",
    )
    require_contains(
        workflow,
        f'scripts/verify-release-publish-postcondition.sh {channel} "${{RELEASE_CREATED}}" "${{TAG_NAME}}" complete',
        "release workflows must prove Go module publication closure after the publisher",
    )
    require_order(
        workflow,
        "prepublish",
        closure_step,
        "release workflows must run the prepublish gate before the complete publication postcondition",
    )
    require_order(
        workflow,
        'scripts/publish-release-assets.sh "${TAG_NAME}"',
        closure_step,
        "release workflows must finish the serialized publisher before the complete postcondition",
    )
for workflow in (".github/workflows/prerelease.yml", ".github/workflows/release.yml"):
    require_contains(
        workflow,
        "scripts/diagnose-release-state.sh --tag",
        "failed release publisher jobs must print read-only release diagnostics",
    )
require_contains(
    ".github/workflows/release.yml",
    "- name: Diagnose failed release state (read-only)\n        if: failure()",
    "stable diagnostics must run for main, tag, and workflow_dispatch publisher failures",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "release-diagnostics: branch=",
    "release diagnostics must print the current branch and head",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "release-diagnostics: tag=",
    "release diagnostics must print the active tag state",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "go-module-tag=",
    "release diagnostics must report nested Go module tag state",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "cut a new version",
    "release diagnostics must refuse repair by moving a conflicting immutable module tag",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "release-diagnostics: release=",
    "release diagnostics must print GitHub Release state",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "release-diagnostics: manifests:",
    "release diagnostics must print manifest state",
)
require_contains(
    "scripts/diagnose-release-state.sh",
    "release-diagnostics: safe-next-action=",
    "release diagnostics must print the safe next action",
)
for forbidden in (
    "gh release upload",
    "gh release edit",
    "gh release create",
    "gh release delete",
    "gh release delete-asset",
):
    require_not_contains(
        "scripts/diagnose-release-state.sh",
        forbidden,
        "release diagnostics must not mutate GitHub Releases",
    )
require_contains(
    "scripts/publish-release-assets.sh",
    'git fetch "${remote}" "${main_branch}" "${premain_branch}" --tags --force',
    "release asset publisher must fetch branch and tag refs before provenance checks",
)
require_order(
    "scripts/publish-release-assets.sh",
    'scripts/verify-release-branch.sh "${tag}"',
    "scripts/verify-version-alignment.sh",
    "release asset publisher must verify the resolved source before version/package checks",
)
require_order(
    "scripts/publish-release-assets.sh",
    "scripts/verify-version-alignment.sh",
    "make build",
    "release asset publisher must verify version alignment before building release assets",
)
require_not_contains(
    "scripts/publish-release-assets.sh",
    "make rubric",
    "release asset publisher must not run the full rubric",
)
require_order(
    "scripts/publish-release-assets.sh",
    "make build",
    "scripts/generate-checksums.sh",
    "release asset publisher must build dist artifacts before generating checksums",
)
require_order(
    "scripts/publish-release-assets.sh",
    "scripts/generate-checksums.sh",
    'gh release upload "${tag}"',
    "release asset publisher must checksum artifacts before upload",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    "scripts/generate-checksums.sh",
    "collect_release_assets asset_paths",
    "publish_and_verify_go_modules",
    "release asset publisher must finish deterministic source builds before creating module tags",
)
require_order(
    "scripts/publish-release-assets.sh",
    "scripts/publish-go-module-tags.sh",
    "scripts/verify-go-module-tags.sh",
    "release asset publisher must create immutable module tags before exact resolution",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    "collect_release_assets asset_paths",
    "publish_and_verify_go_modules",
    'gh release upload "${tag}"',
    "release asset publisher must prove Go modules before uploading draft assets",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    "collect_release_assets asset_paths",
    "publish_and_verify_go_modules",
    'gh release edit "${tag}" --target "${source_commit}" --draft=false',
    "release asset publisher must prove Go modules before publication becomes visible",
)
for path in (
    "scripts/go-module-release-contract.sh",
    "scripts/publish-go-module-tags.sh",
    "scripts/verify-go-module-tags.sh",
):
    require_contains(
        "scripts/verify-branch-release-supply-chain.sh",
        path,
        f"release supply-chain verifier must require {path}",
    )
for forbidden in (
    "git push --force",
    "git push -f",
    "git tag -f",
    "git push --delete",
):
    require_not_contains(
        "scripts/publish-go-module-tags.sh",
        forbidden,
        "Go module tag publisher must never move or delete an existing tag",
    )
require_contains(
    "scripts/publish-go-module-tags.sh",
    "refs are immutable",
    "Go module tag publisher must fail closed on a conflicting existing ref",
)
require_contains(
    "scripts/publish-go-module-tags.sh",
    "concurrently created",
    "Go module tag publisher must safely accept a same-SHA create race",
)
require_contains(
    "scripts/verify-go-module-tags.sh",
    "GOPROXY=direct",
    "Go module postcondition must bypass stale proxy state and resolve the exact Git refs",
)
require_contains(
    "scripts/verify-go-module-tags.sh",
    'origin.get("Hash")',
    "Go module postcondition must prove the resolved commit hash",
)
require_contains(
    "scripts/verify-go-module-tags.sh",
    'origin.get("Ref")',
    "Go module postcondition must prove the root or nested tag ref",
)
require_contains(
    "scripts/publish-release-assets.sh",
    '--clobber',
    "release asset publisher must replace any existing draft assets during recovery",
)
require_not_contains(
    "scripts/publish-release-assets.sh",
    "is already published; immutable releases prevent adding assets/notes",
    "release asset publisher reruns must verify published immutable assets instead of failing before integrity checks",
)
require_contains(
    "scripts/publish-release-assets.sh",
    "verify_published_release_assets",
    "release asset publisher must verify immutable assets when a rerun finds the release already published",
)
require_contains(
    "scripts/publish-release-assets.sh",
    "published release is missing immutable asset",
    "release asset publisher must fail closed when a published release is missing an expected asset",
)
require_contains(
    "scripts/publish-release-assets.sh",
    "does not match source build",
    "release asset publisher must fail closed when a published release asset checksum differs from the source build",
)
require_contains(
    "scripts/publish-release-assets.sh",
    "already published with matching immutable assets",
    "release asset publisher must skip safely when rerun after successful publication",
)
require_not_contains(
    "scripts/publish-release-assets.sh",
    "release-assets: skip existing",
    "release asset publisher must not trust existing draft assets by filename",
)
require_order(
    "scripts/publish-release-assets.sh",
    "scripts/generate-checksums.sh",
    "collect_release_assets asset_paths",
    "release asset publisher must enumerate source-built assets after checksums are generated",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    "collect_release_assets asset_paths",
    "verify_published_release_assets",
    'gh release upload "${tag}" "${asset_path}" --clobber',
    "release asset publisher must verify-and-skip published releases before any clobbering draft upload",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    'if ! gh release upload "${tag}" "${asset_path}" --clobber; then',
    "verify_published_release_assets",
    "failed to upload draft asset",
    "release asset publisher must re-check immutable publication races before failing an upload rerun",
)
require_order(
    "scripts/publish-release-assets.sh",
    'gh release upload "${tag}"',
    'gh release edit "${tag}" --target "${source_commit}" --draft=false',
    "release asset publisher must upload assets before publishing the immutable release",
)
require_order_after(
    "scripts/publish-release-assets.sh",
    'gh release edit "${tag}" --target "${source_commit}" --draft=false',
    'git fetch "${remote}" tag "${tag}" --force',
    'scripts/verify-release-branch.sh "${tag}"',
    "release asset publisher must verify the materialized tag after publishing",
)
require_contains(
    "scripts/verify-release-branch.sh",
    "ALLOW_UNTAGGED_DRAFT_RELEASE",
    "release branch verifier must only allow missing tag refs for explicitly verified draft releases",
)
require_order(
    "scripts/verify-release-branch.sh",
    'tag_commit="$(git rev-parse "${DRAFT_RELEASE_TARGET}^{commit}")"',
    'if [[ "${commit}" != "${tag_commit}" ]]',
    "release branch verifier must compare HEAD to the tag or draft target commit before allowing asset builds",
)
require_contains(
    "scripts/verify-release-pairing.sh",
    "union ranges are not verified",
    "template/release pairing verifier must fail closed on range syntax it cannot decide",
)
require_contains(
    "scripts/verify-release-pairing.sh",
    "release candidate packed at the wrong version",
    "template/release pairing verifier must reject a CDK tarball packed at a version other than VERSION",
)
require_contains(
    "scripts/verify-release-branch.sh",
    'scripts/verify-release-pairing.sh --tag "${expected_tag}"',
    "release branch verifier must pair apptheory-init templates with the release-candidate CDK tarball before assets are built",
)
require_contains(
    "scripts/verify-release-publish-postcondition.sh",
    "bash scripts/verify-release-pairing.sh --published",
    "publish postcondition verifier must pair the published release CDK asset with the shipped templates",
)
require_order(
    "scripts/verify-release-publish-postcondition.sh",
    'if [[ "${phase}" != "complete" ]]',
    "bash scripts/verify-release-pairing.sh --published",
    "publish postcondition verifier must only pair against the published asset once publication completes",
)
require_contains(
    "scripts/verify-release-publish-postcondition.sh",
    'if [[ "${release_created}" != "true" ]]; then\n    return 0\n  fi\n\n  # Post-publish leg',
    "publish postcondition verifier must pair only the release created by the run, not a republished older release",
)
require_contains(
    "scripts/verify-release-gates.sh",
    "bash ./scripts/verify-release-pairing.sh",
    "full release gates must pair apptheory-init templates with the release-candidate CDK tarball",
)
require_contains(
    ".github/workflows/ci.yml",
    "bash scripts/verify-release-pairing.sh",
    "CI release/security gates must run the template/release pairing verifier",
)
for release_pr_workflow in (".github/workflows/prerelease-pr.yml", ".github/workflows/release-pr.yml"):
    require_contains(
        release_pr_workflow,
        "bash scripts/verify-release-pairing.sh",
        f"{release_pr_workflow} must pair apptheory-init templates with the release-candidate CDK tarball before generated artifact sync",
    )
    require_order(
        release_pr_workflow,
        "Verify apptheory-init template/release pairing",
        "Sync generated CDK artifacts on release PR",
        f"{release_pr_workflow} must fail closed on template/release skew before syncing generated CDK artifacts",
    )
require_contains(
    ".github/workflows/ci.yml",
    "ready_for_review",
    "CI must run when humans mark draft release PRs ready",
)
require_contains(
    ".github/workflows/ci.yml",
    "workflow_dispatch:\n    inputs:\n      run_full_rubric:",
    "CI must be dispatchable for bot-authored release PR branch updates with explicit rubric control",
)
require_contains(
    ".github/workflows/ci.yml",
    "default: true",
    "manual CI workflow_dispatch must continue to run the full rubric by default",
)
require_contains(
    ".github/workflows/ci.yml",
    'release_pr_number:\n        description: "Generated release PR number for head-bound release checks"',
    "generated release CI dispatch must identify the exact release PR",
)
require_contains(
    ".github/workflows/ci.yml",
    "github.event_name == 'workflow_dispatch' && inputs.release_pr_number != ''",
    "release promotion verification must run inside generated release CI dispatches",
)
require_contains(
    ".github/workflows/ci.yml",
    "permissions:\n  contents: read\n  pull-requests: read",
    "head-bound release CI dispatch must have read-only pull request metadata access",
)
require_contains(
    ".github/workflows/ci.yml",
    'if [[ "${PR_HEAD_REF}" != "${DISPATCH_HEAD_REF}" || "${PR_HEAD_SHA}" != "${DISPATCH_HEAD_SHA}" ]]; then',
    "release promotion dispatch must bind the requested PR to the dispatched branch and SHA",
)
require_contains(
    ".github/workflows/ci.yml",
    "if: (github.event_name == 'workflow_dispatch' && (inputs.run_full_rubric == true || inputs.run_full_rubric == 'true')) || (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging')",
    "full rubric must run only on staging PRs and opted-in manual dispatch",
)
require_contains(
    ".github/workflows/ci.yml",
    "name: Verify deterministic builds",
    "CI must keep the standalone deterministic-build job name stable",
)
require_contains(
    ".github/workflows/ci.yml",
    "if: github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging'",
    "deterministic builds must run only on staging PRs",
)
require_contains(
    ".github/workflows/ci.yml",
    "Release train promotion gate",
    "CI must gate release train promotion PRs before release state can advance",
)
require_contains(
    ".github/workflows/ci.yml",
    "scripts/verify-release-train-promotion.sh",
    "CI must run the release train promotion verifier",
)
require_contains(
    ".github/workflows/ci.yml",
    "ref: refs/heads/staging",
    "release train promotion verifier must run from trusted protected release gate code",
)
require_not_contains(
    ".github/workflows/ci.yml",
    "ref: ${{ github.event.pull_request.head.sha }}",
    "release train promotion verifier must not execute verifier code from the untrusted PR head",
)
require_not_contains(
    ".github/workflows/ci.yml",
    "refs/pull/${PR_NUMBER}/head:${pr_head_data_ref}",
    "release train promotion verifier must not fetch untrusted PR head content in CI",
)
require_contains(
    ".github/workflows/ci.yml",
    "GITHUB_TOKEN: ${{ github.token }}",
    "release train promotion verifier must use the read-only workflow token for compare API ancestry checks",
)
require_contains(
    ".github/workflows/ci.yml",
    "base_ref_args=(--base-ref \"refs/remotes/origin/${PR_BASE_REF}\")",
    "release train promotion verifier must use fetched protected base refs instead of PR-head checkout data",
)
require_contains(
    ".github/workflows/ci.yml",
    'release_ref_depth_args=(--unshallow)',
    "release train promotion verifier must unshallow trusted protected release branch history",
)
for branch in ("staging", "premain", "main"):
    require_contains(
        ".github/workflows/ci.yml",
        f"+refs/heads/{branch}:refs/remotes/origin/{branch}",
        f"release train promotion verifier must fetch protected {branch} history for topology checks",
    )
require_contains(
    ".github/workflows/ci.yml",
    '--head-sha "${PR_HEAD_SHA}"',
    "release train promotion verifier must pass the event head SHA without fetching PR head content",
)
require_contains(
    ".github/workflows/ci.yml",
    'pr_title_args=(--pr-title "${PR_TITLE}")',
    "release train promotion verifier must pass PR titles when trusted verifier code supports title checks",
)
require_contains(
    ".github/workflows/ci.yml",
    '--github-repository "${GITHUB_REPOSITORY}"',
    "release train promotion verifier must identify the protected repository for compare checks",
)
require_contains(
    ".github/workflows/ci.yml",
    '--github-head-repository "${PR_HEAD_REPOSITORY}"',
    "release train promotion verifier must compare fork PR heads in their source repository",
)
require_not_contains(
    ".github/workflows/ci.yml",
    "--head-ref HEAD",
    "release train promotion verifier must not trust the checkout HEAD as release PR head content",
)
require_contains(
    ".github/workflows/ci.yml",
    "persist-credentials: false",
    "release train promotion checkout must not persist credentials",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    'ancestor_branch="premain", descendant_branch=head',
    "prerelease promotion verifier must topology-check staging to premain promotions",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "does not match trusted {remote}/{branch}",
    "release train promotion verifier must reject forged release branch head content",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "compare/{ancestor_sha}...{descendant_sha}",
    "release train promotion verifier must use GitHub compare data for untrusted PR head ancestry",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "refs/remotes/origin/pr/1/head",
    "release train promotion self-test must cover fetched PR head data that forges a release branch name",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "staging → premain → main → staging",
    "release train promotion verifier must preserve the single valid branch ordering",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "release-please--branches--premain",
    "release train promotion verifier must allow generated premain RC release-please PRs only on premain",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "release-please--branches--main",
    "release train promotion verifier must allow generated main stable release-please PRs only on main",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "must originate from trusted repository",
    "release train promotion verifier must reject forked generated release-please branch spoofing",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "event head SHA is required to verify generated release-please branch",
    "release train promotion verifier must require exact release-please head SHA provenance",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "does not match trusted origin/release-please--branches--premain",
    "release train promotion self-test must reject forged release-please head SHA",
)
require_contains(
    "scripts/verify-release-train-promotion.sh",
    "main release gate rejects RC-shaped PR titles/versions",
    "main release promotion gate must reject RC-shaped main PR titles/versions",
)
require_contains(
    ".github/workflows/ci.yml",
    "name: Release/security gates",
    "CI must expose release/security gates as a stable non-skipped branch-protection context",
)
require_contains(
    ".github/workflows/ci.yml",
    "bash scripts/verify-release-train-promotion.sh --self-test",
    "CI release/security gates must exercise release train provenance self-tests",
)
require_contains(
    ".github/workflows/ci.yml",
    "bash scripts/verify-ci-rubric-enforced.sh",
    "CI release/security gates must verify rubric enforcement separately from the full rubric",
)
require_contains(
    ".github/workflows/ci.yml",
    "bash scripts/verify-runtime-floor-claims.sh",
    "CI release/security gates must fail closed on unsupported Python/Node floor claims",
)
require_contains(
    "scripts/verify-release-gates.sh",
    "bash ./scripts/verify-release-train-promotion.sh --self-test",
    "full release gates must include release train provenance self-tests",
)
require_contains(
    "scripts/verify-release-gates.sh",
    "bash ./scripts/verify-release-cycle.sh",
    "full release gates must include deterministic full-cycle release regression",
)
require_contains(
    "scripts/verify-release-gates.sh",
    "bash ./scripts/verify-runtime-floor-claims.sh",
    "full release gates must fail closed on unsupported Python/Node floor claims",
)
require_contains(
    "scripts/verify-release-cycle.sh",
    "REQUIRED_COVERAGE",
    "release cycle verifier must declare required coverage cases",
)
for coverage in (
    "happy_path",
    "go_module_tags",
    "publish_recovery_race",
    "stale_release_please_pr",
    "promotion_drift",
    "back_merge_drift",
):
    require_contains(
        "scripts/verify-release-cycle.sh",
        coverage,
        f"release cycle verifier must cover {coverage}",
    )
require_contains(
    ".github/workflows/ci.yml",
    "scripts/verify-branch-version-sync.sh",
    "CI must run the branch release-version sync verifier with git metadata",
)
require_order(
    ".github/workflows/prerelease-pr.yml",
    "Verify branch version sync before release PR",
    "Release Please (PR only)",
    "prerelease PR generation must fail closed before opening stale release-please PRs",
)
for workflow in (".github/workflows/prerelease-pr.yml", ".github/workflows/release-pr.yml"):
    require_contains(
        workflow,
        "scripts/run-release-please-pr.sh",
        "release PR workflows must create release-please PRs through the stale-state-tolerant wrapper",
    )
require_not_contains(
    "scripts/run-release-please-pr.sh",
    'valid release PR already exists',
    "release-please PR generation must not short-circuit before release-please can refresh stale open PRs",
)
require_order(
    "scripts/run-release-please-pr.sh",
    "draft_lock_existing_open_release_pr_before_refresh",
    "bash scripts/invoke-release-please-pr.sh",
    "release-please PR generation may draft-lock already-open PRs but must still invoke release-please",
)
require_order(
    "scripts/run-release-please-pr.sh",
    "bash scripts/invoke-release-please-pr.sh",
    'if use_existing_open_release_pr "release-please exited ${release_please_status} after creating or finding a release PR"; then',
    "release-please PR generation must recover when stale release-please state errors after a valid PR exists",
)
require_not_contains(
    "scripts/run-release-please-pr.sh",
    "--token",
    "release-please credentials must never be forwarded through npm or shell process arguments",
)
require_contains(
    "scripts/run-release-please-pr.sh",
    'gh pr ready "${pr_number}" --undo',
    "release-please PR generation must draft-lock valid open release PRs before artifact setup",
)
for workflow, step_name in (
    (".github/workflows/prerelease-pr.yml", "Release Please (PR only)"),
    (".github/workflows/release-pr.yml", "Release Please (PR only) (aligned)"),
    (".github/workflows/release-pr.yml", "Release Please (PR only)"),
):
    require_step_contains(
        workflow,
        step_name,
        "GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}",
        "release-please wrapper steps must authenticate gh CLI with the release token fallback",
    )
require_order(
    ".github/workflows/prerelease.yml",
    "Verify branch version sync (release preflight)",
    "Verify release workflow invariants (release preflight)",
    "prerelease creation must fail closed on stale branch release state before release workflow checks",
)
require_order(
    ".github/workflows/prerelease.yml",
    "actions/setup-go",
    "Verify release workflow invariants (release preflight)",
    "prerelease workflow checks must use the pinned Go toolchain for module probe self-tests",
)
require_order(
    ".github/workflows/release.yml",
    "actions/setup-go",
    "Verify release workflow invariants (stable release preflight)",
    "stable workflow checks must use the pinned Go toolchain for module probe self-tests",
)
require_contains(
    ".github/workflows/prerelease-pr.yml",
    "scripts/verify-release-pr-postcondition.sh prerelease",
    "prerelease PR generation must fail closed when release-please no-ops",
)
require_contains(
    ".github/workflows/release-pr.yml",
    "scripts/verify-release-pr-postcondition.sh stable",
    "stable Release PR generation must fail closed when release-please no-ops",
)
require_contains(
    "scripts/verify-release-pr-postcondition.sh",
    "parse_version_value",
    "release PR postcondition verifier must parse annotated VERSION values before shape validation",
)
require_contains(
    "scripts/verify-release-pr-postcondition.sh",
    "1.12.2-rc # x-release-please-version",
    "release PR postcondition verifier self-test must cover annotated RC VERSION values",
)
require_contains(
    "docs/release-process.md",
    "watch the first generated",
    "release process runbook must keep an evidence-bounded first-RC watch for release-please extra-files changes",
)
require_contains(
    "docs/release-process.md",
    "CI is not a signing key holder",
    "release process runbook must document the no-CI-signing-secrets policy",
)
require_contains(
    "docs/release-process.md",
    "local_status=N",
    "release process runbook must distinguish local unresolved SSH verification from GitHub verified-valid evidence",
)
for forbidden in (
    "RELEASE_ARTIFACT_SYNC_" + "GPG",
    "RELEASE_ARTIFACT_SYNC_" + "GPG_" + "PRIVATE" + "_KEY",
    "RELEASE_ARTIFACT_SYNC_" + "GPG_KEY_ID",
    "RELEASE_ARTIFACT_SYNC_" + "GPG_PASSPHRASE",
):
    for path in (
        ".github/workflows/prerelease-pr.yml",
        ".github/workflows/release-pr.yml",
        "scripts/render-release-artifact-sync-plan.py",
        "scripts/sync-release-pr-generated.sh",
        "docs/release-process.md",
    ):
        require_not_contains(
            path,
            forbidden,
            "release artifact sync must not depend on CI-held signing secrets",
        )
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "--raw-field run_full_rubric=false",
    "automated release PR CI dispatch must disable the full rubric",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    '--raw-field release_pr_number="${pr_number}"',
    "automated release PR CI dispatch must bind checks to the exact release PR",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "Release train promotion gate\nRelease/security gates",
    "release PR sync must wait for promotion and release/security checks in the single dispatched run",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "Rubric (full gate set)",
    "release PR sync required checks must exclude the full rubric context",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "Verify deterministic builds",
    "release PR sync required checks must exclude skipped deterministic-build contexts",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'gh pr ready "${pr_number}" --undo',
    "release PR sync must force the release PR back to draft before generated artifact work",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "--local-signed-sync",
    "release PR sync must retain an explicit offline local signed artifact sync fallback",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'artifact_sync_commit_message="chore(release): sync generated release artifacts"',
    "release PR sync must use one stable generated artifact sync commit message",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'artifact_sync_commit_body="[skip ci]"',
    "generated artifact commits must suppress redundant pull_request CI events",
)
require_contains(
    "scripts/render-release-artifact-sync-plan.py",
    '"body": args.body',
    "GitHub-created generated artifact commits must carry the automatic-event suppression marker",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    '--body "${artifact_sync_commit_body}"',
    "release PR sync must pass the automatic-event suppression marker into the GitHub commit plan",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'git commit -m "${artifact_sync_commit_message}" -m "${artifact_sync_commit_body}"',
    "local signed release PR sync fallback must use normal local git commit signing configuration",
)
require_contains(
    "scripts/invoke-release-please-pr.mjs",
    '`${options.message}\\n\\n[skip ci]`',
    "release-please commits must suppress redundant pull_request CI events",
)
require_contains(
    "docs/release-process.md",
    "one explicit `workflow_dispatch` CI run",
    "release runbook must document the single-trigger generated release PR contract",
)
require_contains(
    "scripts/render-release-artifact-sync-plan.py",
    "createCommitOnBranch",
    "CI release PR sync must create generated artifact commits through GitHub server-side verified automation",
)
require_contains(
    "scripts/render-release-artifact-sync-plan.py",
    '"--no-renames"',
    "GitHub artifact plans must represent module-root moves as explicit additions and deletions",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "github-verified-api",
    "release PR sync self-test must prove CI selects the GitHub-verified API mode",
)
require_contains(
    "scripts/render-release-artifact-sync-plan.py",
    '"expectedHeadOid": args.expected_head',
    "GitHub API generated artifact sync must use optimistic expectedHeadOid concurrency",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "scripts/render-release-artifact-sync-plan.py",
    "release PR sync must use the shared fail-closed artifact plan renderer",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "gh api graphql --input",
    "CI generated artifact sync must send a GraphQL createCommitOnBranch mutation",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "verify_github_synced_head",
    "CI generated artifact sync must fetch and verify the GitHub-created commit before continuing",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "push_local_signed_release_artifact_sync",
    "release PR sync must isolate git push to the offline local signed fallback",
)
require_order_after(
    "scripts/sync-release-pr-generated.sh",
    'case "${sync_mode}" in',
    "local-signed)",
    "push_local_signed_release_artifact_sync",
    "only the local signed fallback may push a generated artifact commit",
)
require_order_after(
    "scripts/sync-release-pr-generated.sh",
    'case "${sync_mode}" in',
    "github-verified-api)",
    "commit_release_artifact_sync_via_github",
    "CI generated artifact sync must use GitHub API commit creation instead of git push",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'scripts/verify-release-branch-signatures.sh',
    "CI generated artifact sync must prove the new release branch commit is accepted by the signature gate",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    '--range "${expected_head}..${new_head}"',
    "CI generated artifact sync signature proof must scan exactly the created commit range",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    'git commit -S -m "chore(release): sync generated release artifacts"',
    "release PR sync must not force a bespoke CI signing path",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "gpg --import",
    "release PR sync must not import signing material",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "git config user.signingkey",
    "release PR sync must not set signing keys",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "git config gpg.program",
    "release PR sync must not replace the local signing program",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "git config commit.gpgsign true",
    "release PR sync must not mutate commit-signing configuration",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "git verify-commit HEAD",
    "release PR sync must verify generated artifact commit signatures before pushing",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "git log -1 --format=%G?",
    "release PR sync must report and gate the generated commit signature status",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "GitHub Actions must select createCommitOnBranch sync mode",
    "release PR sync self-test must prove CI uses GitHub-verified product automation instead of a manual stop",
)
require_contains(
    ".github/workflows/ci.yml",
    "scripts/verify-release-branch-signatures.sh",
    "release/security gates must scan branch signatures",
)
require_contains(
    "scripts/verify-release-branch-signatures.sh",
    "HISTORICAL_UNSIGNED_FIXTURE",
    "release signature gate must have a historical unsigned negative fixture",
)
require_contains(
    "scripts/verify-release-branch-signatures.sh",
    "github-verified",
    "release signature gate must distinguish GitHub-verified signatures from local signatures",
)
require_contains(
    "scripts/verify-release-branch-signatures.sh",
    "self-test:github-verified-fallback",
    "release signature gate self-test must prove GitHub verified-valid fallback without unsigned commits",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "Keep the PR ready only until the required check contexts exist",
    "release PR sync must not depend on recursive pull_request events from bot-authored PR mutations",
)
for workflow in (".github/workflows/prerelease-pr.yml", ".github/workflows/release-pr.yml"):
    require_contains(
        workflow,
        "actions: write",
        "release PR workflow must be able to dispatch independent CI for bot-authored branch updates",
    )
    require_not_contains(
        workflow,
        "statuses: write",
        "release PR workflow must not be able to self-attest protected release PR gate statuses",
    )
    require_order(
        workflow,
        "actions/setup-python",
        "Sync generated CDK artifacts on release PR",
        "release PR workflow must install Python before running the full release PR gate set",
    )
    require_step_contains(
        workflow,
        "Sync generated CDK artifacts on release PR",
        "GH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}",
        "release PR artifact sync step must authenticate gh without signing secrets",
    )
    require_order(
        workflow,
        "Draft-lock release PR before artifact setup",
        "actions/setup-go",
        "release PR workflow must draft-lock release PRs before installing artifact-generation toolchains",
    )
    require_order(
        workflow,
        "Draft-lock release PR before artifact setup",
        "Sync generated CDK artifacts on release PR",
        "release PR workflow must draft-lock release PRs before artifact sync",
    )
require_order(
    "scripts/sync-release-pr-generated.sh",
    'ensure_release_pr_is_draft "before generated artifacts are synced"',
    "scripts/update-cdk-generated.sh",
    "generated artifact sync must draft-lock the release PR before regenerating artifacts",
)
require_order_after(
    "scripts/sync-release-pr-generated.sh",
    'git switch --detach "${expected_head}"',
    "sync_stable_release_premain_manifest",
    "scripts/update-cdk-generated.sh",
    "stable premain manifest reset must happen before regenerating artifacts",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "git add -A",
    "stable release PR sync must commit the premain manifest reset with generated release artifacts",
)
for generated_path in (
    ".release-please-manifest.premain.json",
    "cdk/.jsii",
    "cdk/lib",
    "cdk-go/go.mod",
    "cdk-go/go.sum",
    "cdk-go/apptheorycdk",
):
    require_contains(
        "scripts/sync-release-pr-generated.sh",
        generated_path,
        f"release PR sync must include {generated_path} in the generated artifact transaction",
    )
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "bash scripts/verify-cdk-go.sh",
    "release PR sync must validate generated CDK Go bindings through the nested-module verifier",
)
require_not_contains(
    "scripts/sync-release-pr-generated.sh",
    "go test ./cdk-go/apptheorycdk",
    "release PR sync must not test the nested cdk-go package from the root Go module",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'synced_head="$(git rev-parse HEAD)"',
    "local signed release PR sync must capture the local signed generated-artifact head",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'synced_head="$(commit_release_artifact_sync_via_github "${expected_head}" "${repo}")"',
    "CI release PR sync must capture the GitHub-created generated-artifact head",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'synced_head="${expected_head}"',
    "release PR sync must preserve the fetched release PR head when generated artifacts are already current",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    'synced_head="$(commit_release_artifact_sync_via_github "${expected_head}" "${repo}")"',
    'verify_github_synced_head "${expected_head}" "${synced_head}" "${repo}"',
    "CI release PR sync must verify the GitHub-created generated-artifact head before waiting for it",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    'verify_github_synced_head "${expected_head}" "${synced_head}" "${repo}"',
    'wait_for_pr_head "${synced_head}"',
    "release PR sync must prove the GitHub-created commit signature before checking independent CI",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    'wait_for_pr_head "${synced_head}"',
    "After the generated-artifact head is visible",
    "release PR sync must wait for the pushed artifact commit before checking independent CI",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    "After the generated-artifact head is visible",
    "dispatch_required_checks\nwait_for_required_checks_to_start\nwait_for_required_checks",
    "release PR sync must dispatch and wait for independent CI after the generated-artifact head is visible",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "check-runs?per_page=100",
    "release PR sync must read commit check-runs because workflow_dispatch checks are not always surfaced by PR checks",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "COMMIT_CHECKS_JSON",
    "release PR sync must merge commit-attached check-runs into the required check view",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "headSha",
    "release PR sync must only pass required checks attached to the current PR head",
)
require_order_after(
    "scripts/sync-release-pr-generated.sh",
    "dispatch_required_checks\nwait_for_required_checks_to_start\nwait_for_required_checks",
    "wait_for_required_checks",
    'require_pr_head "${synced_head}" "after required checks passed"',
    "release PR must re-check the generated-artifact head after required checks pass",
)
require_order(
    "scripts/sync-release-pr-generated.sh",
    'require_pr_head "${synced_head}" "after required checks passed"',
    'if ! gh pr ready "${pr_number}"; then',
    "release PR must wait for required checks before becoming ready",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'current_pr_state}" != "OPEN" && "${current_pr_state}" != "MERGED"',
    "release PR sync must keep checking required contexts if an externally merged release PR is already terminal",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    "already merged after generated artifacts and required checks matched",
    "release PR sync must treat an externally merged synced PR as a benign terminal state after checks pass",
)
require_contains(
    "scripts/sync-release-pr-generated.sh",
    'gh pr ready "${pr_number}" --undo || true',
    "release PR sync must restore draft state if the PR head changes while becoming ready",
)
for forbidden in (
    "repos/${GITHUB_REPOSITORY}/statuses",
    "set_release_pr_status",
    "run_release_pr_status_check",
    "run_release_pr_required_checks",
):
    require_not_contains(
        "scripts/sync-release-pr-generated.sh",
        forbidden,
        "release PR sync must not self-attest protected contexts",
    )

subprocess.run(["bash", "scripts/verify-branch-version-sync.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/verify-release-pr-postcondition.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/verify-release-publish-postcondition.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/publish-go-module-tags.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/verify-go-module-tags.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/render-release-notes.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/diagnose-release-state.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/sync-release-pr-generated.sh", "--self-test"], check=True)
subprocess.run(["bash", "scripts/verify-release-please-token-safety.sh"], check=True)

print("release-workflows: PASS")
PY
