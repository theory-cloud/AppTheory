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
STEP_HEADER = re.compile(r"(?m)^      - name: (?P<name>.*)$")


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
SHELL_STATE_KEYS = ("PATH", "BASH_ENV", "ENV", "SHELLOPTS")

SHELL_OPENERS = ("if", "while", "until", "for", "case")
SHELL_CLOSERS = ("fi", "done", "esac")
HEREDOC_START = re.compile(
    r"(?<!<)<<(?!<)-?[ \t]*(?P<quote>['\"]?)(?P<marker>[A-Za-z_][A-Za-z0-9_]*)(?P=quote)"
)
SHELL_SEMANTICS_ENV_KEYS = ("BASH_ENV", "ENV", "SHELLOPTS")
# GitHub's built-in `bash` shell expands to `bash --noprofile --norc -eo pipefail {0}`,
# so the bare keyword keeps errexit while an explicit command template has to prove it.
SHELL_ERREXIT_FLAG = re.compile(r"(?:^|\s)-[A-Za-z]*e[A-Za-z]*(?=\s|$)")
# `<<:` is a YAML merge key. GitHub Actions does not honour one today, so it is a dead end
# there, but this guard refuses the document rather than depending on that.
MERGE_KEY = re.compile(r"(?m)^[ \t]*<<[ \t]*:")
GITHUB_EXPRESSION = re.compile(r"\$\{\{")

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
    # gov-verify-rubric.sh legitimately exports PATH for its pinned toolchain and installs a
    # RETURN trap, so only its invocation shape is classified, never its shell state.
    "shell_invokers": ("scripts/verify-release-gates.sh", "gov-infra/verifiers/gov-verify-rubric.sh"),
}
GUARDED_WORKFLOWS = tuple(dict.fromkeys(PAIRING_WORKFLOWS + META_GUARD_WORKFLOWS))
GUARDED_SHELL_INVOKERS = tuple(
    dict.fromkeys(PAIRING_SHELL_INVOKERS + META_GUARD_SPEC["shell_invokers"])
)
GUARDED_FILES = GUARDED_WORKFLOWS + GUARDED_SHELL_INVOKERS


def split_shell_comment(line: str):
    """Split a shell line into (code, comment) at the first unquoted word-initial `#`."""
    code = []
    state = None
    index = 0
    while index < len(line):
        char = line[index]
        if state == "single":
            code.append(char)
            if char == "'":
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
        elif char == "\\" and index + 1 < len(code):
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
    single-quoted word inside a substitution inside a double-quoted string.
    """
    index = 0
    started_open = bool(stack)
    while index < len(text):
        char = text[index]
        top = stack[-1] if stack else None
        if top == "single":
            if char == "'":
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
            elif char == "'":
                stack.append("single")
            elif char == '"':
                stack.append("double")
        elif char == "\\" and index + 1 < len(text):
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


def shell_errexit_flags(body: str):
    """(enabled, disabled) for errexit across a shell body's `set` statements."""
    enabled = False
    disabled = False
    for _line_number, statement, _after in shell_statements(body):
        words = statement.split()
        if not words or words[0] != "set":
            continue
        for index in range(1, len(words)):
            word = words[index]
            if word[:1] not in ("+", "-"):
                continue
            cluster = word[1:]
            named = cluster == "o" and index + 1 < len(words) and words[index + 1] == "errexit"
            if not named and "e" not in cluster:
                continue
            if word.startswith("+"):
                disabled = True
            else:
                enabled = True
    return enabled, disabled


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


def shell_state_findings(body: str, where: str, spec):
    """Findings for shell state in one body that could mask a failing guarded invocation.

    A guarded invocation is only as fail-closed as the shell it runs in: errexit cleared
    anywhere in the body, a function or alias shadowing `bash`/`exit`/`set`/the script path,
    a trap that replaces the failing status, or a reassigned PATH/BASH_ENV/ENV/SHELLOPTS all
    let a failing invocation leave the step green. None of them appear in the pinned wiring.
    """
    findings = []
    _enabled, disabled = shell_errexit_flags(body)
    if disabled:
        findings.append(
            f"{where}: clears errexit with `set +e`, so a failing {spec['label']} invocation "
            "would not fail closed"
        )
    for line_number, statement, _after in shell_statements(body):
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


def classify_invocations(body: str, where: str, spec):
    """Findings for every invocation of one guarded script in a run block or shell script.

    An invocation is accepted only as the pinned fail-closed call: a first-on-line,
    unnegated, top-level statement that names the guarded script directly, carries a pinned
    literal argument vector, and is not followed by anything that decides the result in its
    place. Anything else - negated, commented out, wrapped in a condition or loop, chained
    into another list, backgrounded, quoted, reached through a variable or a `${{ }}`
    expression, or taking a usage-exit flag - is reported instead of passing.
    """
    findings = []
    mentions = 0
    real = 0
    candidates = []
    depth = 0
    for line_number, line in enumerate(join_shell_continuations(mask_shell_data(body.splitlines())), 1):
        code, _comment = split_shell_comment(line)
        if spec["script"] not in code and spec["script"] in line:
            mentions += 1
            findings.append(
                f"{where}:{line_number}: the {spec['label']} script is named in a comment, "
                f"not invoked ({line.strip()!r})"
            )
        statements = split_shell_statements(code)
        for index, (separator, statement, _after) in enumerate(statements):
            words = statement.split()
            first = words[0] if words else ""
            if first in SHELL_CLOSERS:
                depth = max(depth - 1, 0)
            if spec["script"] in statement:
                mentions += 1
                candidates.append((line_number, index, separator, statement, depth, statements))
            if first in SHELL_OPENERS:
                depth += 1
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
    return findings, real, mentions


def workflow_job_block(text: str, job_name: str):
    match = re.search(
        rf"(?ms)^  {re.escape(job_name)}:\n(?P<block>.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)",
        text,
    )
    return match.group("block") if match else None


def subtree_scalar(lines, index: int, key: str):
    """The value of `key:` anywhere below lines[index]'s indentation level."""
    parent_indent = len(lines[index]) - len(lines[index].lstrip())
    pattern = re.compile(rf"^\s*{re.escape(key)}:\s*(?P<value>\S.*)$")
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
    pattern = re.compile(rf"^ {{{indent}}}{re.escape(key)}:\s*(?P<value>.*)$")
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
    marker = re.compile(rf"^ {{{indent}}}env:\s*$")
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
    pattern = re.compile(rf"^ {{{indent}}}(?P<key>[A-Za-z_][A-Za-z0-9_-]*):")
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
    return any(re.match(rf"^ {{{indent}}}{re.escape(key)}:\s*\S", line) for line in lines)


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
        (i for i, line in enumerate(workflow_lines) if re.match(r"^defaults:\s*$", line)), None
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
        (i for i, line in enumerate(job_lines) if re.match(r"^ {4}defaults:\s*$", line)), None
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
    for key in duplicate_keys(step_lines, 8):
        findings.append(
            f"{where}: declares {key!r} more than once; YAML keeps the last value and hides the first"
        )
    run_body = step_run_body(step_text)
    if run_body is None:
        findings.append(f"{where}: has no run body")
        return findings
    findings.extend(shell_state_findings(run_body, where, spec))
    body_findings, real, mentions = classify_invocations(run_body, where, spec)
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
    conditional the guard has no pin for.
    """
    findings = []
    pinned_ifs = {(workflow, name): expected for workflow, name, expected in spec["workflow_steps"]}
    workflows = tuple(dict.fromkeys(workflow for workflow, _name, _if in spec["workflow_steps"]))
    for workflow in workflows:
        seen = set()
        for step_name, step_text in workflow_step_blocks(read_text(workflow)):
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
            body_findings, real, mentions = classify_invocations(text, path, spec)
            findings.extend(body_findings)
            if mentions == 0:
                findings.append(f"{path}: never invokes {spec['script']}")
            elif real == 0:
                findings.append(
                    f"{path}: only a --self-test arm invokes {spec['script']}; "
                    f"the {spec['label']} itself is never verified"
                )
    for path in PAIRING_SHELL_INVOKERS:
        text = read_text(path)
        enabled, _disabled = shell_errexit_flags(text)
        if not enabled:
            findings.append(
                f"{path}: does not set errexit, so a failing {PAIRING_SPEC['label']} invocation "
                "would not fail the gate"
            )
        findings.extend(shell_state_findings(text, path, PAIRING_SPEC))
    for workflow in GUARDED_WORKFLOWS:
        if MERGE_KEY.search(read_text(workflow)):
            findings.append(
                f"{workflow}: declares a YAML merge key (`<<:`) this guard refuses to classify"
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

    print(
        f"release-workflows: PASS (self-test: {len(SELF_TEST_ATTACKS)} weakening shape(s) failed closed, "
        "legitimate wiring accepted)"
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
