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
import fnmatch
import glob
import hashlib
import json
import os
import posixpath
import re
import subprocess
import tempfile
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
            f"release-workflows: FAIL ({description}; missing {needle!r} in step {step_name!r} of {path})"
        )


def require_job_contains(path: str, job_name: str, needle: str, description: str) -> None:
    text = Path(path).read_text(encoding="utf-8")
    match = re.search(
        rf"(?ms)^  {re.escape(job_name)}[ \t]*:\n(?P<block>.*?)(?=^  [A-Za-z0-9_-]+[ \t]*:\n|\Z)",
        text,
    )
    if match is None or needle not in match.group("block"):
        raise SystemExit(
            f"release-workflows: FAIL ({description}; missing {needle!r} in job {job_name!r} of {path})"
        )


# ---------------------------------------------------------------------------
# The guarded surface.
#
# The release path is pinned by whole-file SHA-256: the five workflows that run the release
# train, and the transitive closure of the paths they name - wherever those paths live,
# including the files outside `scripts/` and `gov-infra/` that the closure runs. There is no
# model of YAML or of bash here and no admission rule over a pinned file's bytes; the pins
# header below says what that replaced and why. What round 8 added is a *reading of the
# command line* - which word is a command, which word is the file it runs, which line is a
# command line at all - because a suffix list is not a reading: it is a guess about which
# names matter, and `node scripts/evil-helper.js` walked past it. That reading is stated
# where it lives (see "What a pinned file runs" below), together with the one carve-out it
# admits: dependency and tool code, which is git-ignored, materialised at run time, and
# unreachable by a pull request.
#
# The posture this buys: an intentional change to a pinned file is a visible two-place edit
# - the file and its digest in the manifest - in the same commit. What is *not* pinned
# anywhere in this repository is stated in docs/release-process.md, together with the reason
# it is not, and with the shapes that would weaken this file if a reviewer did not look.
# ---------------------------------------------------------------------------

ROOT = Path(".").resolve()

GUARDED_BASENAMES = ("verify-release-pairing.sh", "verify-release-workflows.sh")

GUARDED_WORKFLOWS = (
    ".github/workflows/ci.yml",
    ".github/workflows/prerelease-pr.yml",
    ".github/workflows/release-pr.yml",
    ".github/workflows/prerelease.yml",
    ".github/workflows/release.yml",
)

# This guard. A file cannot pin its own bytes, so it is read by nothing here; that boundary
# is stated in docs/release-process.md and asserted by an accepted battery case rather than
# left as prose.
GUARD_PATH = "scripts/verify-release-workflows.sh"

# A script path can be written three ways and only three. This construction is not a shell;
# it reads these spellings and refuses every other one, because a spelling it does not read
# is a spelling nobody is vouching for:
#
#   * a plain path, from the repository root or from the referencing file's directory
#   * the same behind a leading `./`
#   * the same behind a braced variable used as a directory (`${VAR}/x.sh`), read as a
#     directory relative to the referencing file, which is what `${SCRIPT_DIR}` means in
#     every script here
#
# Everything else - an unbraced `$VAR/`, a quoted segment, a command substitution, an
# absolute path, a `~` - is a finding rather than a skip. Rounds 1-6 read two spellings and
# skipped the rest, which is how `bash "$SCRIPT_DIR/new-helper.sh"`, `bash
# scripts/"new"-helper.sh`, `bash "$GITHUB_WORKSPACE/scripts/new-helper.sh"` and `make -C
# scripts pwn` each ran unpinned code past a PASS.
#
# This list bounds one of the two rules that read a name, and only one:
#
#   * the read-or-run rule: a token with one of these suffixes, anywhere in a pinned file,
#     is pinned whether the site reads it or runs it, because a byte scanner cannot tell
#     the two apart and a file that is only read is still a file the release path needs;
#   * the executed-path rule (below): a path-like token written *where a command runs it* -
#     after an executor, or as the command itself - is pinned **whatever its suffix,
#     including no suffix at all**. That rule has no extension boundary, because the
#     boundary is what `node scripts/evil-helper.js`, `perl scripts/evil.pl` and
#     `ruby scripts/new-helper.rb` each walked past: a name no suffix list covers is a name
#     no pin covers, so it was free to be introduced and free to be edited afterwards.
SCRIPT_EXTENSIONS = ("sh", "bash", "mjs", "cjs", "py", "rb")

# The trailing boundary is load bearing: without it `hashlib.sha256` reads as `hashlib.sh`.
SCRIPT_REFERENCE = re.compile(
    r"[A-Za-z0-9_@$./{}~-]+\.(?:" + "|".join(SCRIPT_EXTENSIONS) + r")\b"
)

ADMITTED_VARIABLE_DIRECTORY = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*\}/")

# A bare path may hold none of these. A `$` outside an admitted prefix is a variable this
# construction cannot read, a `~` is a home directory it cannot resolve and a `{` is a brace
# expansion it cannot expand; the rest cannot survive the token pattern above, and they are
# refused here so the rule and the reason sit in one place.
REFUSED_CHARACTERS = "$~*():\"'`{}"

# Every spelling that runs something: an interpreter, a shell, a `source`, a launcher, or one of
# the two process-spawning module names the pinned Python and Node tools use. A token written on
# a line that reaches one of these before it is executed at that site, so a token there that
# names no file is a finding rather than a comment about a file.
#
# This is the executor set, and it is closed: it is enumerated once, here, the runbook
# enumerates exactly it, and this file asserts that the runbook's sentence is this list. A
# spelling that is not in it - `ruby`, `perl`, `php`, `exec`, `deno`, `bun`, `nodejs` - is
# the surface rounds 1-7 left open by naming only interpreters and adding none: `ruby
# scripts/new-helper.rb` was written past a PASS because `ruby` was not a spelling this
# construction knew. `exec` and the pipe form are the same hole (`exec <path>`, `... | xargs
# bash`), and `.` - the POSIX spelling of `source` the runbook used to list while this tuple
# did not - is implemented here rather than removed from the prose.
#
# The word is the unit, and the boundaries are load bearing: `node-version:` is a YAML key
# and not `node`, `subprocess.PIPE` is not a call, and `source="..."` is an assignment and
# not the builtin.
#
# `npm` and `npx` are in the set because round 8 left them out entirely, and the omission was
# live: a pinned gate runs `npm run build`, and the script bytes it runs come from a package.json
# the guard never read. Round 9 closed that in two places - the invocation reads the package
# manifest it names (see "What a pinned file runs" and `package_manifest_findings`), and every
# manifest and lockfile in the repository is pinned so the dependency bytes an install and an
# `npx` binary resolve to are named by pinned bytes.
EXECUTOR_NAMES = (
    "bash",
    "sh",
    "zsh",
    "dash",
    "ksh",
    "source",
    ".",
    "env",
    "command",
    "xargs",
    "nohup",
    "exec",
    "python",
    "python3",
    "python2",
    "node",
    "nodejs",
    "ruby",
    "perl",
    "php",
    "deno",
    "bun",
    "npm",
    "npx",
    "make",
    "find",
    "subprocess",
    "child_process",
)
EXECUTOR_REFERENCE = re.compile(
    r"(?:^|[\s;&|(\"'`,[])(?P<name>" + "|".join(re.escape(name) for name in EXECUTOR_NAMES) + r")(?![-.\w])"
)

# The launchers: their first operand is another command, not a file, so the reading continues
# at command position there. `exec scripts/new-helper2.sh` is the case that matters - `exec`
# replaces the shell with the file it names, so the file is run and must be pinned.
LAUNCHER_EXECUTORS = ("env", "command", "xargs", "nohup", "exec")

# The executors whose first operand is data rather than the file they run: `make` takes a
# makefile selector (and has its own rule below), `find` takes a search root and runs nothing
# until `-exec`, the two process-spawning module names take a command line, not a path, and an
# `npm`/`npx` invocation takes a subcommand, which `package_manifest_findings` reads against the
# package manifest the invocation names.
#
# This is a pause in the reading, not the end of it. Round 8 `break`-ed here, so a file `find`
# handed to `-exec` later on the same line was never read;
# `find gov-infra -name data.txt -exec node gov-infra/evil2.js {} \;` ran unpinned code past a
# PASS. The reading now resumes at the next executor in the segment, so the operand of `find` (and
# of `make`, `subprocess`, `child_process`) is still data while nothing later on the line is
# skipped.
OPERAND_IS_DATA = ("make", "find", "subprocess", "child_process", "npm", "npx")

# The one YAML key whose value is a command line. A workflow's `run:` is shell - that is what
# the key means - so its value is read at command position even though YAML indents it. Every
# other key's value is data, which is why `cache-dependency-path: |` and a `paths:` list are
# read as names and not as commands.
RUN_COMMAND_LABEL = re.compile(r"^(?:-\s*)?run:\s*(?P<command>.*)$")

# The words that are not commands at all, so a path written after one of them is not run by
# it: a shell keyword, a condition, an option fragment or an assignment.
SHELL_KEYWORDS = (
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "for",
    "in",
    "do",
    "done",
    "while",
    "until",
    "case",
    "esac",
    "function",
    "select",
    "!",
)
CONDITION_COMMANDS = ("[[", "[", "test")
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?=")

# The shape of a token that names a file on the release path, with no extension boundary. A
# token is path-like when it holds a `/` or ends in a letter-dot-suffix, and it holds none of
# these: `@` and `:` are a git ref, a URL or a YAML key; `=` is an option value; the rest are
# quoting, a call, a redirect and a flag this construction cannot read as a path. An absolute
# path and a `~` are refused rather than resolved, and they are refused by this same test.
PATH_TOKEN = re.compile(r"[A-Za-z0-9_@$./{}~+*?\[\]-]+")
PATH_REFUSED = re.compile(r"[@:=,()\"'\\!<>]")
GLOB_CHARACTERS = re.compile(r"[*?\[\]]")

# The characters that tell this construction a token's value is computed at run time rather than
# written where it can be read: a variable, a command substitution, a brace expansion or an array
# subscript. Round 8 skipped a token that held one of these and was not path-like, which is how
# `node "${files[@]}"` ran a planted file past a PASS. A token holding one of these in an executed
# position is now refused unless it is the admitted `${VAR}/` directory spelling.
EXPANSION_CHARACTERS = "$`{}"

# A bare name - a file name with no directory component - written where a command runs it. Round 8
# read only tokens with a `/` in them, so `node evil9.js` and a piped `printf '%s\n' evil.js | xargs
# bash` both ran a file the guard never read. A name of this shape in an executed position is now a
# finding whether or not the file exists yet: every execution on this release path writes a slashed
# path, and a name with no directory in it is how a variable, a flag value and an object property
# are written everywhere else in the tree.
BARE_NAME = re.compile(r"^[A-Za-z0-9_@$~+-][A-Za-z0-9_.@$~+-]*\.[A-Za-z0-9]{1,8}$")

# A shell brace expansion written into a path, which is what makes a *command* refused: the shell
# rewrites the name before anything runs, so `./scripts/{deep,}/evil7.js` runs the file under
# `./scripts/deep/`. The shape is deliberately narrow, because every other brace at command position
# in this tree is a variable in a condition, a `case` word, an object literal or a JSON fragment -
# measured, not guessed: the wider test over this tree produces 25 false positives and this one
# produces none.
BRACE_EXPANSION = re.compile(r"^[A-Za-z0-9_./~+-]*\{[A-Za-z0-9_,./~+-]*\}[A-Za-z0-9_./~+.-]*$")

# The `find` actions that name a command to run. They are the one place a file is run later on a
# line than the executor that starts it, so they are where the reading resumes after an executor
# whose first operand is data.
FIND_EXEC_OPTIONS = ("-exec", "-execdir", "-ok", "-okdir")

# The separators between one command and the next on a line.
COMMAND_SEPARATORS = re.compile(r"(?:;|\|\||&&|\||`|\$\(|&)")

# The shell spellings, for the one question a heredoc asks: is this body a script to run.
SHELL_EXECUTORS = ("bash", "sh", "zsh", "dash", "ksh", "source", ".")
HEREDOC_OPENER = re.compile(r"<<-?\s*(?P<quote>['\"]?)(?P<delimiter>[A-Za-z_][A-Za-z0-9_]*)(?P=quote)")

# How a heredoc body is read, decided by the command that opens it: a shell body is a script, an
# interpreter's body is that language's code and is read at executor positions, and a body handed to
# a command that runs nothing (`cat`) is data. See `heredoc_bodies`.
HEREDOC_READ_EXECUTORS = "interpreters"
HEREDOC_READ_DATA = "data"

# The interpreters whose `-m` names a module rather than a file. `python3 -m evilmod` with an
# `evilmod.py` planted in the tree ran unpinned code past a PASS in round 8; the module is read like
# a path here, and a module that resolves to a file in this repository must be pinned.
PYTHON_EXECUTORS = ("python", "python3", "python2")
MODULE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")

# The package manifests. An npm invocation's directory is a `cd` this construction does not follow,
# so rather than guess which manifest an install or a script reads, every manifest and lockfile in
# the repository is pinned: the package.json whose lifecycle scripts can run and the lockfile whose
# resolved versions and integrity hashes bind the dependency bytes are then pinned content wherever
# the invocation runs. `MANIFEST_FILE_NAMES` is the closed set, and `package_manifest_findings`
# fails closed on a manifest that exists but is not pinned.
MANIFEST_FILE_NAMES = ("package.json", "package-lock.json", "npm-shrinkwrap.json")
# Directories whose manifests are dependency code or build output and never carry a release-path
# script: the carve-out roots plus the generated and vendored trees.
MANIFEST_IGNORED_DIRECTORIES = ("node_modules", ".venv", "dist", "_site", "vendor")

# An `npm`-family invocation: the subcommand, and whether it runs one of a package's scripts.
NPM_INVOCATION = re.compile(r"(?:^|[\s;&|(`])(?P<tool>npm|npx)(?=\s|$)")
NPM_DIRECTORY = re.compile(r"(?:^|[\s;&|(`])cd\s+(?P<directory>[^\s;&|)]+)")
NPM_PREFIX_OPTION = re.compile(r"--prefix[=\s]+(?P<directory>[^\s;&|)]+)")
NPM_RUN = re.compile(r"(?:^|\s)(?:run\s+(?P<run>[^\s;&|)]+)|(?P<lifecycle>test|start|stop|restart))\b")
NPM_INSTALL = re.compile(r"(?:^|\s)(?:ci|install|i|add|update)\b")
NPM_BIN_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.@/-]*$")

# A glob that names a directory and a set of files in it (`examples/testkit/*.mjs`), as opposed
# to a regular expression handed to `grep`, which is a pattern over text and names no file.
GLOB_PATH = re.compile(r"^[A-Za-z0-9_$./~+-]*[*?][A-Za-z0-9_$./~+*-]*$")

# The pipe form that hands a launcher a command to run: `... | xargs bash`.
PIPED_EXECUTOR = re.compile(r"\|\s*xargs\s+(?:-\S+\s+)*(?P<name>[A-Za-z0-9_.-]+)")

# Dependency and tool code. `node_modules/`, a `.venv/` directory and `gov-infra/.tools/` are not
# part of this repository: each is git-ignored, so no commit can change a byte of any of them, and
# each is materialised at run time by an installer a pinned file names - `scripts/` scripts and
# `gov-infra/verifiers/gov-verify-rubric.sh` run `npm ci` against the lockfile of the directory
# they `cd` into, and `stage-release-please-package.sh` pins the exact version
# `release-please@17.1.3` and installs with `--ignore-scripts` and `--no-package-lock` (so no
# lifecycle script runs and no lockfile is consulted), with its assertions held by
# `scripts/verify-release-please-token-safety.sh`, which is pinned like everything else on the
# release path; `py/.venv` and `cdk/.venv` are built by pinned scripts from
# `py/requirements-build.txt`, `py/requirements-lint.txt` and `cdk/requirements-build.txt`, whose
# versions are exact pins; `gov-infra/.tools` is built by the GovTheory verifier from exact version
# pins.
#
# So a path under one of these directories is read as **dependency code** rather than silently
# unread: it cannot be pinned (there is nothing in the tree to pin) and no commit can reach it.
#
# The claim "no commit can reach it" is not prose here: `carve_out_findings` reads `.gitignore` and
# asserts that every root below is ignored, so a root that stops being uncommittable fails the
# guard instead of being disclosed. `venv/` is deliberately NOT a root: nothing in this tree ever
# creates a non-dot venv, and an ignore rule for a directory the repository never makes would be a
# rule that makes the claim true by fiat rather than by fact.
#
# The trust model is stated exactly rather than implied, because round 8's version of this comment
# was wrong in two ways. What the pins DO fix: every `package.json`, `package-lock.json` and
# `npm-shrinkwrap.json` in this repository is pinned (`MANIFEST_FILE_NAMES`, below), so an `npm ci`
# in any directory installs exactly the resolved versions and integrity hashes a pinned lockfile
# records, and the `bin` map in that lockfile says which package provides the binary an `npx`
# invocation runs. What they do NOT fix: the tarballs themselves are fetched from the registry at
# run time, so a registry compromise is outside this guard's reach, and the release-please staging
# runs with `--no-package-lock`, so that one install's transitive bytes are registry-resolved and
# named by the exact version pin and by nothing else.
DEPENDENCY_DIRECTORY = re.compile(r"(?:^|/)(?:node_modules|\.venv)/|^gov-infra/\.tools/")

# The carve-out roots, as prefixes of a canonical repository-relative path. `carve_out_findings`
# asserts that each is git-ignored; the executed-path rule checks the *resolved* path against
# `DEPENDENCY_DIRECTORY`, so a spelling that walks out of a dependency directory into a tracked
# path (`node scripts/node_modules/../evil.js`) resolves outside the carve-out and needs a pin.
CARVE_OUT_ROOTS = ("node_modules/", ".venv/", "gov-infra/.tools/")

# A local composite action. `uses: ./...` in a pinned workflow names a directory in this
# repository that the runner checks out and runs; the guard pins no file under it, so one could
# be introduced by one PR and edited afterwards with no pin edit at all - worse than a script.
# There is no local action in the tree today; the rule refuses the spelling outright.
LOCAL_USES = re.compile(r"^\s*(?:-\s*)?uses:\s*(?P<value>\S+)")

# `make` reads a makefile. `-f` names one outright and `-C <dir>` names `<dir>/Makefile`; a
# bare `make` reads the makefile of the directory it runs in, which a byte scanner cannot
# follow through a `cd`, so the repository root's makefile and the referencing file's own
# directory are both read.
MAKE_INVOCATION = re.compile(r"(?:^|[\s;&|(`])make\b(?P<arguments>[^\n]*)")
MAKE_FILE_OPTION = re.compile(r"(?:^|\s)-f\s*(?P<file>[^\s]+)")
MAKE_DIRECTORY_OPTION = re.compile(r"(?:^|\s)-C\s*(?P<directory>[^\s]+)")

# Where the release path lives. A reference under one of these roots is inside the surface
# this guard exists for; a reference outside them is pinned all the same, because a pinned
# file may name only pinned files and where a file lives does not enter into that. The roots
# name the release path in the finding messages and in docs/release-process.md.
CLOSURE_ROOTS = ("scripts/", "gov-infra/")

# The files outside the pinned set that could gain a call site. `Makefile` exists here and a
# root `package.json` does not; `.github/**` is walked rather than enumerated, so a new
# workflow file or a new composite action is read too.
SWEEP_EXTRA_FILES = ("Makefile", "package.json")


def sweep_paths():
    """Every file the occurrence sweep reads for a guarded script name."""
    paths = []
    github = Path(".github")
    if github.is_dir():
        paths.extend(str(path) for path in sorted(github.rglob("*")) if path.is_file())
    paths.extend(extra for extra in SWEEP_EXTRA_FILES if Path(extra).is_file())
    return tuple(paths)


# The file the carve-out's own claim is read from. It is not pinned - an edit to it is what the
# assertion below is for - and it is read through `read_text` so the self-test can drive it.
GITIGNORE_PATH = ".gitignore"


def gitignore_patterns(text):
    """The live patterns of a `.gitignore`, in file order, with comments and blanks dropped."""
    patterns = []
    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        patterns.append(stripped)
    return patterns


def repository_gitignore_patterns(read_text):
    """The root `.gitignore` patterns, or an empty tuple when the file cannot be read."""
    try:
        return tuple(gitignore_patterns(read_text(GITIGNORE_PATH)))
    except (OSError, UnicodeDecodeError):
        return ()


def _gitignore_matches(pattern, path):
    """Whether one `.gitignore` pattern ignores `path`, a posix repository-relative path.

    The reading is git's own: a pattern holding a `/` (other than a trailing one) is anchored to
    the ignore file's directory, one without matches any path component, a trailing `/` makes the
    pattern directory-only, and an ignored directory ignores everything under it. Wildcards go
    through `fnmatch`.
    """
    if pattern.startswith("!"):
        pattern = pattern[1:]
    directory_only = pattern.endswith("/")
    if directory_only:
        pattern = pattern[:-1]
    if not pattern:
        return False
    anchored = pattern.startswith("/") or "/" in pattern
    if pattern.startswith("/"):
        pattern = pattern[1:]
    parts = path.split("/")
    directories = ["/".join(parts[:index]) for index in range(1, len(parts))]
    if anchored:
        candidates = directories if directory_only else [path, *directories]
        return any(fnmatch.fnmatchcase(candidate, pattern) for candidate in candidates)
    if directory_only:
        return any(fnmatch.fnmatchcase(part, pattern) for part in parts[:-1])
    return any(fnmatch.fnmatchcase(part, pattern) for part in parts)


def gitignore_ignores(patterns, path):
    """Whether git's own reading of these patterns would ignore `path`: the last match wins."""
    ignored = False
    for pattern in patterns:
        if _gitignore_matches(pattern, path):
            ignored = not pattern.startswith("!")
    return ignored


def carve_out_findings(read_text):
    """Every approved dependency root that is not git-ignored.

    The carve-out is the one shape here that is trusted rather than pinned, and its whole
    justification is that no commit can reach it. Round 8 stated that in prose and it was false:
    `.gitignore` anchored only `py/.venv/`, so `venv/evil.js` and `scripts/.venv/evil.js` were
    committable while the guard read them as dependency code. The claim is an assertion now, and a
    root that stops being uncommittable fails the guard instead of being disclosed.
    """
    patterns = repository_gitignore_patterns(read_text)
    findings = []
    if not patterns:
        return [
            (
                CLASS_CLOSURE,
                f"{GITIGNORE_PATH}: holds no live ignore pattern, so the carve-out roots cannot be "
                f"shown to be uncommittable. The carve-out is trusted only because no commit can "
                f"reach what it covers, so a missing or unreadable ignore file is refused rather "
                f"than assumed",
            )
        ]
    for root in CARVE_OUT_ROOTS:
        probe = root + "release-workflows-carve-out-probe"
        if not gitignore_ignores(patterns, probe):
            findings.append(
                (
                    CLASS_CLOSURE,
                    f"{GITIGNORE_PATH}: the carve-out root {root!r} is not git-ignored - {probe!r} "
                    f"is committable. A root that a commit can reach is not dependency code, so "
                    f"either ignore it here or drop it from CARVE_OUT_ROOTS",
                )
            )
    return findings


def script_references(text):
    """Every script-shaped token a file writes, with the line it is written on.

    A token that is part of a glob is not read: `ts/test/*.test.mjs` is expansion, and no
    file is named until the shell expands it. That is the same boundary the occurrence sweep
    states for a glob, and it is stated here rather than left to be inferred.
    """
    for line in text.split("\n"):
        for match in SCRIPT_REFERENCE.finditer(line):
            if match.start() > 0 and line[match.start() - 1] in "*?[]":
                continue
            yield match.group(0), line, match.start()


def written_path(token):
    """The bare path a written token reads as, or None when the spelling is refused."""
    bare = ADMITTED_VARIABLE_DIRECTORY.sub("", token, count=1)
    if bare.startswith("./"):
        bare = bare[2:]
    if not bare or bare.startswith("/"):
        return None
    if any(character in bare for character in REFUSED_CHARACTERS):
        return None
    return bare


def resolve_reference(token, base_dir, root=None):
    """The file a token reads as, and whether reading it went through a symbolic link.

    `root` is the directory the path is read relative to; the real run passes nothing and
    gets the repository, and the link probe at the foot of this file passes a temporary
    directory so the probe can hold a real symbolic link without writing one into the tree.
    """
    root = ROOT if root is None else Path(root).resolve()
    bare = written_path(token)
    if bare is None:
        return None, False
    candidates = [Path(bare), Path(base_dir) / bare]
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved.is_file() and resolved.is_relative_to(root):
            lexical = os.path.normpath(os.path.join(os.getcwd(), str(candidate)))
            return resolved.relative_to(root).as_posix(), Path(lexical) != resolved
    return None, False


def canonical_reference(token, base_dir):
    """The canonical repository-relative path a token names, `..` and links already resolved.

    `Path.resolve()` is non-strict, so this answers for a path that does not exist yet as well as
    one that does, and it walks `..` out of a directory: `scripts/node_modules/../evil.js` is
    `scripts/evil.js` here, which is why the carve-out below cannot be talked out of a pin by
    walking through a dependency directory into a tracked path.
    """
    bare = written_path(token)
    if bare is None:
        return None
    for candidate in (Path(bare), Path(base_dir) / bare):
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved.is_relative_to(ROOT):
            return resolved.relative_to(ROOT).as_posix()
    return None


def dependency_reference(token, base_dir):
    """The canonical path a token names when it lies under an approved dependency root.

    This is the whole of the carve-out: it is decided on the *resolved* path and never on the
    spelling, so `node_modules/evil.js` is dependency code and `scripts/node_modules/../evil.js` is
    the tracked file it resolves to.
    """
    relative = canonical_reference(token, base_dir)
    if relative is None:
        return None
    return relative if DEPENDENCY_DIRECTORY.search(relative) else None


def brace_like(token):
    """A token a brace expansion or an unadmitted `{...}` would rewrite.

    The admitted `${VAR}/` directory spelling is stripped first, so it is not brace-like; every
    other brace is, which is what makes `node scripts/{deep,}/evil7.js` a finding rather than a
    token the `,`-refusing path test silently drops.
    """
    stripped = ADMITTED_VARIABLE_DIRECTORY.sub("", token, count=1)
    return "{" in stripped or "}" in stripped


def expansion_like(token):
    """A token whose value is computed at run time rather than written where it can be read."""
    return any(character in token for character in EXPANSION_CHARACTERS)


def bare_like(token, base_dir=""):
    """A bare name - a file name with no directory component - in an executed position.

    True when the token names a file by shape (a dot suffix) or when it resolves to a file in the
    tree at the repository root. A tool name, a flag value, a shell keyword and an object property
    are none of those, which is why `command -v python3`, `python3 -m venv` and a Python
    comparison are left alone while `node evil9.js` is refused.
    """
    if not token or "/" in token or token.startswith("-") or token.startswith("~"):
        return False
    if token in EXECUTOR_NAMES or token in SHELL_KEYWORDS or token in CONDITION_COMMANDS:
        return False
    if ASSIGNMENT.match(token):
        return False
    if BARE_NAME.match(token):
        return True
    if not base_dir:
        return resolve_reference(token, "")[0] is not None
    return False


def executed_tokens(read_text):
    """Every token the pinned set runs at an execution site.

    The site is the line, and the executor is any interpreter, shell, `source` or launcher
    written before the token on that line. The reading is deliberately coarse: it over-reads
    a line (`echo "run bash x.sh"` reads as executed) rather than under-read one, and the
    direction of the error is the safe one.
    """
    executed = set()
    for path in PINNED_FILE_DIGESTS:
        try:
            text = read_text(path)
        except (OSError, UnicodeDecodeError):
            continue
        for line in text.split("\n"):
            executors = tuple(EXECUTOR_REFERENCE.finditer(line))
            for token, _line, start in script_references(line):
                if any(executor.end() <= start for executor in executors):
                    executed.add(token)
    return executed


def path_like(token):
    """The bare path a token reads as when it is written where a command runs it, or None.

    No extension boundary: an extensionless name (`scripts/evil-helper`) and every suffix
    (`evil.js`, `evil.pl`, `evil.rb`) are the same thing here - all three ran unpinned code
    past a PASS before this rule existed. What is excluded is what is not a path this
    construction can resolve: an option, an absolute path, a home directory, a quoted segment,
    a YAML key, a git ref, a URL (`node-version:` is a key and not `node`), an attribute
    (`result.metadata` names a field, not a file) and a bare word with no directory component
    at all, because a name with no directory in it is how a variable, a flag value and an
    object property are written and this guard reads the name in any other position.
    """
    if not token or token in (".", "..", "/", "-"):
        return None
    if token.startswith("-") or token.startswith("/") or token.startswith("~"):
        return None
    if PATH_REFUSED.search(token) or token.endswith("/"):
        return None
    if "/" not in token:
        return None
    return token


def glob_like(token):
    """A token that the shell would expand before running anything it names."""
    return GLOB_CHARACTERS.search(token) is not None


def command_segments(line):
    """The words of each command on a line, split at the separators between commands."""
    for part in COMMAND_SEPARATORS.split(line):
        words = [word.strip("\"'") for word in part.split() if word.strip("\"'")]
        if words:
            yield words


def mentions_executor(text, names):
    """Whether `text` writes one of `names` as a word."""
    for name in names:
        if re.search(r"(?:^|[\s;&|(\"'`,])" + re.escape(name) + r"(?![-.\w])", text):
            return True
    return False


def heredoc_bodies(text):
    """The line numbers of a heredoc body and how the body is read.

    A heredoc body is the text a command is handed, and what it is depends on the command: when it
    is a shell (`bash <<'EOF'`) the body is a script and it is read as a command line, exactly as
    before; when it is another interpreter (`python3 - <<'PY'`, `node - <<'JS'`) the body is that
    interpreter's code and it is read at *executor* positions, because a body line's first word is
    the interpreter's own syntax rather than a command this construction knows; when the command
    reaches no executor at all (`cat <<'EOF'`) the body is data - a file being written, a PR body -
    and it is not read at command position.

    Round 8 skipped every non-shell body outright, which is how a body that names
    `node gov-infra/evil5.js` kept that file out of the pins: the helper was named only inside a
    heredoc, and the derivation never looked inside it. `read_or_run` still reads the body's
    script-shaped names on every run; what changed is that the executed-path rule reads an
    interpreter's body too.
    """
    bodies = {}
    delimiter = None
    kind = None
    for index, line in enumerate(text.split("\n"), 1):
        if delimiter is not None:
            if line.strip() == delimiter:
                delimiter = None
            elif kind is not None:
                bodies[index] = kind
            continue
        opener = HEREDOC_OPENER.search(line)
        if opener is None:
            continue
        delimiter = opener.group("delimiter")
        prefix = line[: opener.start()]
        if mentions_executor(prefix, SHELL_EXECUTORS):
            kind = None
        elif mentions_executor(prefix, EXECUTOR_NAMES):
            kind = HEREDOC_READ_EXECUTORS
        else:
            kind = HEREDOC_READ_DATA
    return bodies


def first_operand(words, start):
    """The index of a command's first non-option operand, or None.

    A bare `-` is the conventional standard-input marker, not an operand: `python3 - x` reads
    its program from stdin and hands `x` to it as data, so the reading stops there rather than
    walking on to the next argument and calling it the file that runs.
    """
    for index in range(start, len(words)):
        word = words[index]
        if word == "-":
            return None
        if word.startswith("-"):
            continue
        return index
    return None


def data_operand_resume(words, start):
    """Where the reading resumes after an executor whose first operand is data, or None.

    `find gov-infra -name data.txt -exec node gov-infra/evil2.js {} \\;` is the shape this closes:
    the search root is data, and the file `-exec` runs is later on the same line. The reading
    resumes at the command a `find` action names (`-exec`, `-execdir`, `-ok`, `-okdir`), so the
    operand of `find` - and of `make`, `subprocess`, `child_process` and an `npm` subcommand - is
    still read as data while the command `find` hands a file to is read as what it is.

    The resume is an action name and not "any later word that looks like an executor", which is the
    difference between a reading and a guess: the wider test matched the *value* of an option
    (`npx jsii-pacmak -t python -o out`), and it produced a false finding on a pinned line.
    """
    for index in range(start, len(words)):
        if words[index] in FIND_EXEC_OPTIONS and index + 1 < len(words):
            return index + 1
    return None


def path_shape(token):
    """Whether an unreadable token could be a path at all, whatever spelling it is written in.

    The refused-spelling readings below are offered only for a token that could name a file. An
    operand of `==`, `=`, `!=`, `]]`, `>` or `1` is punctuation or a value, not a refused path, and
    offering a refusal for those would make the rule fire on almost every Python and JavaScript line
    in the tree - which is exactly the shape that forces a bound to be stated rather than guessed.
    """
    if not token or token.startswith("-"):
        return False
    return any(character in token for character in "/.$")


def refused_positions(token):
    """The refused-spelling readings one written-but-unreadable executed token produces."""
    if brace_like(token):
        return (("brace", token),)
    if expansion_like(token):
        return (("refused", token),)
    if bare_like(token):
        return (("bare", token),)
    return ()


def module_name(words, start):
    """The module a Python executor's `-m` names, or None.

    `python3 -m evilmod` with an `evilmod.py` planted in the tree ran unpinned code past a PASS in
    round 8: the module was not a path, so nothing resolved it. The module is read here and
    `package_manifest_findings` decides it - a module that resolves to a file in this repository
    must be pinned, while `venv`, `pip`, `unittest` and `coverage` name the standard library and the
    built venv's own tooling and stay accepted.
    """
    for index in range(start, len(words)):
        word = words[index]
        if word == "-m":
            if index + 1 >= len(words):
                return None
            candidate = words[index + 1].strip("\"'")
            return candidate if MODULE_NAME.match(candidate) else None
        if not word.startswith("-"):
            return None
    return None


def executed_path_references(line, in_body=False):
    """Every path-like token a line would run, with the position it is written in.

    This is the executed-path rule: the token a command runs - the first non-option argument
    of an executor, the argument of a launcher (whose own operand is the next command), the
    command itself when a path is written as the command, and the items of a `for ... in ...`
    list - is a path this construction must be able to pin, whatever its suffix.

    Two readings bound it, and both are stated rather than implied. First, a *command line* is
    a line that starts at the left margin or is the value of a `run:` key; an indented line that
    is neither is a continuation, an argument list, a YAML value or a data line, and its first
    word is a name rather than a command - which is why `"${REPO_ROOT}/go.mod"` on a line of an
    array literal and `py/pyproject.toml` under a `cache-dependency-path:` block are not read as
    commands. Second, a command's own arguments stop at its first operand, so
    `python3 tool.py "ts/dist/index.d.ts"` reads the tool and leaves the data it is handed
    alone. `make`, `find`, `subprocess` and `child_process` are executors for the read-or-run
    rule above but name no file to run at their first operand - a makefile selector and a
    search root are not scripts - so the executed-path rule does not read their argument.
    Three more readings bound it, each forced by a measured false positive or a measured hole.
    Round 8 read a token only when it held a `/`, so a bare name (`node evil9.js`, a piped
    `printf '%s\n' evil.js | xargs bash`) was never read and neither was a token a brace expansion
    or an array subscript had rewritten (`node scripts/{deep,}/evil7.js`, `node "${files[@]}"`);
    all four are now refused rather than skipped. `command -v <name>` is the one executed position
    that reads nothing, because it looks a name up instead of running it. And inside an
    interpreter's heredoc body only executor positions are read, because a body line's first word
    is that interpreter's syntax.
    """
    stripped = line.strip()
    labelled = RUN_COMMAND_LABEL.match(stripped)
    if labelled is not None:
        line = labelled.group("command")
        command_line = True
    else:
        command_line = line == stripped
    for words in command_segments(line):
        if words[0] == "for":
            if "in" in words:
                # A `for` list is read because the loop variable is what a command in the loop
                # body runs: `for f in examples/testkit/*.mjs; do node "$f"; done`. A glob item
                # is read when the same line reaches an executor, and a plain item is read as a
                # name, which means it is a finding only if it is a name that resolves to a file
                # - an item that names nothing is a name, and a list of names is how this tree
                # writes a module path, a ref and a documentation pattern.
                runs_glob = mentions_executor(line, tuple(
                    name for name in EXECUTOR_NAMES if name not in OPERAND_IS_DATA
                ))
                for word in words[words.index("in") + 1:]:
                    token = path_like(word)
                    if token is None:
                        continue
                    if glob_like(token):
                        if runs_glob:
                            yield ("for-list", "for", token, line)
                    else:
                        yield ("for-list", "for", token, line)
            continue
        index = 0
        while index < len(words):
            word = words[index]
            if word in SHELL_KEYWORDS or ASSIGNMENT.match(word):
                index += 1
                continue
            if word.startswith("-") or word in CONDITION_COMMANDS or word.endswith(":"):
                break
            if word in EXECUTOR_NAMES:
                if word in OPERAND_IS_DATA:
                    # Their first operand is data, but nothing later on the line is skipped: the
                    # reading resumes at the next executor, which is the `-exec`/`-execdir` form
                    # `find gov-infra -name data.txt -exec node gov-infra/evil2.js {} \;` hid
                    # behind round 8's `break`.
                    resume = data_operand_resume(words, index + 1)
                    index = len(words) if resume is None else resume
                    continue
                # `command -v <name>` asks whether a name exists; it runs nothing. The operand is a
                # name to look up, not a file that executes, and six pinned lines write it.
                if word == "command" and any(
                    option in ("-v", "-V") for option in words[index + 1:]
                ):
                    break
                operand_index = first_operand(words, index + 1)
                if operand_index is None:
                    break
                operand = words[operand_index]
                if word in PYTHON_EXECUTORS:
                    module = module_name(words, index + 1)
                    if module is not None:
                        yield ("module", word, module, line)
                if word in LAUNCHER_EXECUTORS:
                    token = path_like(operand)
                    if token:
                        yield ("launcher", word, token, line)
                    elif path_shape(operand):
                        for position, refused in refused_positions(operand):
                            yield (position, word, refused, line)
                    index = operand_index
                    continue
                token = path_like(operand)
                if token:
                    yield ("operand", word, token, line)
                elif path_shape(operand):
                    for position, refused in refused_positions(operand):
                        yield (position, word, refused, line)
                break
            if in_body:
                # A heredoc body handed to an interpreter is that interpreter's code: its first
                # word is syntax, not a command, so only executor positions are read there.
                break
            token = path_like(word)
            if token and command_line:
                yield ("command", word, token, line)
                break
            if command_line and BRACE_EXPANSION.match(word):
                yield ("brace", word, word, line)
                break
            operand_index = first_operand(words, index + 1)
            if operand_index is not None:
                operand = path_like(words[operand_index])
                if operand and GLOB_PATH.match(operand):
                    yield ("unrecognized", word, operand, line)
            break
    # The pipe form: `... | xargs bash`. The name `xargs` runs is data on the left of the
    # pipe, which a reading of this line's own segments never reaches, so when the line pipes
    # into a launcher that names an executor, every path-like token on the line is read. This
    # is the one place the reading widens rather than narrows, and it widens in the safe
    # direction: the file xargs will be handed is a name this line writes, and a name this
    # line writes is one the pins must be able to describe.
    piped = PIPED_EXECUTOR.search(line)
    if piped is not None and piped.group("name") in EXECUTOR_NAMES:
        named = False
        for word in line.split():
            raw = word.strip("\"'")
            token = path_like(raw)
            if token:
                named = True
                yield ("piped", "xargs", token, line)
                continue
            if path_shape(raw) and bare_like(raw):
                named = True
                yield ("piped-bare", "xargs", raw, line)
        if not named:
            yield ("piped-empty", "xargs", "", line)


def makefile_candidates(text, base_dir):
    """The makefiles a file's `make` invocations read, with the selector that names each.

    A comment line is not read: `# keep the make wrapper thin` names no makefile.
    """
    candidates = []
    for invocation in MAKE_INVOCATION.finditer(text):
        line = text[: invocation.end()].split("\n")[-1]
        if line.strip().startswith("#"):
            continue
        arguments = invocation.group("arguments")
        file_option = MAKE_FILE_OPTION.search(arguments)
        directory_option = MAKE_DIRECTORY_OPTION.search(arguments)
        if file_option is not None:
            candidates.append((file_option.group("file").lstrip("/"), "make -f", line.strip()))
            continue
        if directory_option is not None:
            directory = directory_option.group("directory").lstrip("/")
            candidates.append((posixpath.join(directory, "Makefile"), "make -C", line.strip()))
            continue
        selected = [
            candidate
            for candidate in dict.fromkeys(("Makefile", posixpath.join(base_dir, "Makefile")))
            if Path(candidate).is_file()
        ]
        if not selected:
            candidates.append(("Makefile", "make", line.strip()))
            continue
        candidates.extend((candidate, "make", line.strip()) for candidate in selected)
    return candidates


# ---------------------------------------------------------------------------
# Pins.
#
# Every file the release path consists of is pinned by its whole-file SHA-256, byte for byte:
# the five workflows that run the release train, and the transitive closure of the scripts
# they name. Bytes either match the pin or they do not, and no pin is compared against a
# normalised or parsed reading of a pinned file. The one reading this construction does
# perform is over a pinned file's *text* to derive the closure - which name is a script, which
# name a command runs - and that reading is stated where it lives rather than implied here
# ("What a pinned file runs", and the executed-path rule after it).
#
# Rounds 1-5 reasoned about root keys, key identity, job spans and step spans, and each
# round produced a spelling the reasoning did not hold: a root-level key below `jobs:`, a
# quoted duplicate of a job key, a deleted job whose append absorbed the rewrite. The
# reasoning was the hole, so it is deleted rather than repaired, and with it the tolerances
# it needed - whitespace and line endings are bytes as well.
#
# The posture this buys: an intentional change to a pinned file is a visible two-place edit
# - the file and its digest in this manifest - in the same commit. What is *not* pinned
# anywhere in this repository is stated in docs/release-process.md with the reason it is not.
# ---------------------------------------------------------------------------

# The five workflows the release train runs, whole-file. The required release context, the
# release and prerelease publishers, the release PR sync, and every step, job, root key and
# line ending of each of them is one digest here, so there is no region a key could be
# written below and no spelling a key could take that this construction has to know.
WORKFLOW_FILE_DIGESTS = {
    ".github/workflows/ci.yml": "31428c2eb91329ff41c95bdc6d775efc3897089ed1de7e8dcaacafd361210e45",
    ".github/workflows/prerelease-pr.yml": "d5b56f61a63798f84bb7bc1d1fea6100508249ff8865967688d2c6a5c430285c",
    ".github/workflows/release-pr.yml": "20e9dcc2afd278d7d50328eb7eefb6f596477efd0b8e72c0ef16b326611f644d",
    ".github/workflows/prerelease.yml": "0661bc8ae58bc0a8a24c275d33282617cdf7c6981e518fcec779d5b28acdd4a1",
    ".github/workflows/release.yml": "3e2a906dddd9b905bbc840fd6173f1e8166216d4b1b6414bfb82bc27d5ebd629",
}

# The transitive closure of the paths the five workflows name, resolved relative to the
# repository root or to the referencing file's directory. `closure_findings` re-derives that
# closure from the pinned bytes on every run, so a workflow that gains a call site, or a
# pinned script that starts running another one, fails until the same change adds the pin -
# the closure cannot rot into a stale list. The paths outside `scripts/` and `gov-infra/`
# that the closure names are pinned beside these, in OUT_OF_ROOT_FILE_DIGESTS below.
RELEASE_PATH_FILE_DIGESTS = {
    "gov-infra/verifiers/gov-verify-rubric.sh": "5c375a12d5008f671f954c983b03732095b48abd4b5f42f67937e82786f1ea3f",
    "gov-infra/verifiers/test-gov-rubric-timestamp.sh": "9efa7f7486e9049ac8a28c4416ab5a77ee2d660c30596cb025895aba4c7d574a",
    "scripts/check-cdk-engines-floor.mjs": "24d4a6d9e437b55b3fb321b63d9ff7e42e0e3bee2ba5309a8e0a7651a638110e",
    "scripts/check-visible-aws-cdk-finding.mjs": "90539460e8f70fceb1982e5e01ff3b9219acef64867c50cbdd6eb8303f110658",
    "scripts/check-visible-ts-brace-finding.mjs": "6bf7a1e14c993ce06eb75a91fbcda13492215dd8a24837aa349c4cade89527a6",
    "scripts/diagnose-release-state.sh": "53642c06ba3f9c7a561633b5c6065c1ec3008e5bf090843a23d6165b5725d60a",
    "scripts/fmt-check.sh": "de47ba4d3d1b7bfc9a8e78e9fe3ea9d958e01bc63695845624103631f6ca8f3a",
    "scripts/generate-api-snapshots.sh": "f91de9fb0853028c1ccb3ed8d660b80f365c3d17eeb8a2f4f89d3a8de85bfaee",
    "scripts/generate-checksums.sh": "cd5a6f78e5c0efebbf15d09f7b9bfe749d2ee8e85494d4b019194f311d68059e",
    "scripts/go-module-release-contract.sh": "89f98dad00324779da032b53089f562189dabc9a040bed009cdd5ba9f6cfcfe4",
    "scripts/invoke-release-please-pr.mjs": "212693f9a4debdc24d342bf7038ddfe24d5903a1e9d561cd9dbcb564bc06fe03",
    "scripts/invoke-release-please-pr.sh": "f51707ea23aac342c10b51d73b5d239f188dadaf1fd2fab5635a417c7d7b3582",
    "scripts/lib/blocked.sh": "0ea5984eec6b856df5ba2144376c152dd767e5a39e3c451216783844644bd1fa",
    "scripts/lib/cdk-runtime-deps.sh": "3e5c972d39bbef831a6c2629b5960eb5514df7f5f67057039d85a3071353f734",
    "scripts/lib/runtime-deps.sh": "a96d91d48dcad9a298582bd8a0a7a0170ad476fff74a76b04eb8fd33fab5ea55",
    "scripts/lib/ts-runtime-deps.sh": "eddc132e0185babe9adae69c9cf92119b464ac2ed09de369c586ac711364b406",
    "scripts/list-go-packages.sh": "bb7a1234c199cdccf72c20840b92d9376ad025311b79ef19bd25e3b29fa60ee2",
    "scripts/microvm_conformance.py": "c167ece1626939b44cfa41909478b8a06b5f4c7e46239f47c084add3c07587f0",
    "scripts/publish-go-module-tags.sh": "94149628cc8aea55ddd03c72fd14bb903f668ab0632086093c2bad25ea33da3b",
    "scripts/publish-release-assets.sh": "9bc3cbb3d61e1f284bbb770960c4b9c85b1bbd52804cc3d02fa7eaf23b10fe37",
    "scripts/read-version.sh": "eaa550d8d29da26c240934bdb83a1d821fd8693070e6c6a65b1ff001a310fe8c",
    "scripts/render-release-artifact-sync-plan.py": "9fd2a876baa8dbe3da7b0004896d03c17abc7962894fbd8a440869ee74f4cd33",
    "scripts/render-release-notes.sh": "3dd1c51c3fdee91017b6646f63bdce3fdb9a1aa4d795fdbf015d607fa41f1c08",
    "scripts/run-release-please-pr.sh": "e06950248bd9f0877b9992ad2551fe4442c1185d8c9f5b4e48a86c719355f8cd",
    "scripts/stage-release-please-package.sh": "8b94504cf21375b416807a7d09d67ae7f83d4a93dc52da2f165ba4961b1cb325",
    "scripts/stage-theorycloud-apptheory-subtree.sh": "af3d4a0fcee5a42f9d462b58149492e5d151e1784fea33885b16e1d5a1730603",
    "scripts/sync-release-pr-generated.sh": "8414dcdac85face1ddf9ed970b704e7d9430eac90f49c3feb8d1865854aa6c26",
    "scripts/sync-theorycloud-apptheory-subtree.sh": "e6fc9965630486883c77a5d2fa3c831726808dae75b624b8b134e01d18c50627",
    "scripts/test_microvm_conformance.py": "172ec946ddda3cfc6d9329a2721c8fe9dd719f0f2f610f5ab5e88a31ec40229d",
    "scripts/theorycloud-apptheory-env.sh": "9dea6fa6dbacaa8de7084071e3d27724c184dc12362201e658665728d0f51d91",
    "scripts/tools/api_snapshots/py_snapshot.py": "24e7fc8c03bc9955a0408220d1c475b3c941c12e0cc6a83d4827f016fa26e054",
    "scripts/tools/api_snapshots/ts_snapshot.py": "d988493161d67063aeaa702ef2c734fa0509cac70c7cb45dd511c36ef4ccacd3",
    "scripts/trigger-theorycloud-publish.sh": "953014e53db4750fd6003a866ad98734efb285ef347baa424c41695da5e2f703",
    "scripts/update-api-snapshots.sh": "6b4ac01537b94c181fadc395468001bac7f32edf678070c79ef1614f90245744",
    "scripts/update-cdk-generated.sh": "46ab89c5da216b66818b819e71172147941e7278834597283448ff5856d2721c",
    "scripts/update-cdk-readme-inventory.sh": "6166076f01d42c88778f6261d4d8beecdc88e84a4c14dac9a579d139cbf94082",
    "scripts/verify-api-docs.sh": "5021b716482317682b2f3be7e89da842b85b411d13dcf410c2e97e8601e90739",
    "scripts/verify-api-snapshots.sh": "565c444398c424bb50ebaac9aabffab07089c28bf013521ce1d502d3db7a6aed",
    "scripts/verify-branch-release-supply-chain.sh": "805c8f8af1e3a0e600859db1788d5a3ea12a19760e440528b2114e542e4bacda",
    "scripts/verify-branch-version-sync.sh": "38f749592b4b3f3f065313aa8aa33237adc45b3bc327ca5f88ebabda3f272e06",
    "scripts/verify-builds.sh": "001cdf0d9b36390d1334d081e6b9a1b310fec532dd25a2f04180fa2e7c6e21c4",
    "scripts/verify-cdk-audit.sh": "a6800ac4b499bdc778af7a0809fdba10e6a3f539110b4ab24e6a1d561c21c262",
    "scripts/verify-cdk-constructs.sh": "11e7dbc900042be4a84c0d1a8749b107271179f7bf3808fb836c565679b7c3cc",
    "scripts/verify-cdk-deprecation-warnings.sh": "afd09340ee88af80876b9167f603dcbf4940bf049c871ce478ef1c87f1bbec70",
    "scripts/verify-cdk-engines-floor.sh": "f137c37721b66bbd8f20a7a7f40d85da9f36f68f1aee7dedeb17b48a208cfc83",
    "scripts/verify-cdk-go-drift.sh": "9daf96e7746d18828f6dc3f67039fed6deb4d5922641c3f53880cca43fb0cf9c",
    "scripts/verify-cdk-go-major-version.sh": "74d63baea7dd8fdb0b2a4f80fbfc3516e15024cd13a61d39d4510637ec03008f",
    "scripts/verify-cdk-go.sh": "a3f6309d00b3c1638d875678b4c8a9ce7ef49f367d9196d8b21d5a239b19954d",
    "scripts/verify-cdk-python-build.sh": "48a907c88d77930556de8f04c5c1e1918ad798bafa7cf45d4d81dd49ccfad065",
    "scripts/verify-cdk-readme-inventory.sh": "9be0cc469831e22d922bd62c73659266409ec5204a9458b04176475461bd7cf4",
    "scripts/verify-cdk-synth.sh": "2cd8b6952a1a381f1a15e94ce6eccbc03d0708281f6a61748f69d988115f3c25",
    "scripts/verify-cdk-ts-pack.sh": "efbbb077e4b369f846506ecad95f2e21637794f8b4fb59b559fb57e9cc497f2d",
    "scripts/verify-ci-rubric-enforced.sh": "9a08d035c2c65cf10021cada1db7288cf8a18972a9881a073898e80eb392ae67",
    "scripts/verify-contract-tests.sh": "38799a0ee5dc8f6042ca772389847eea584f3a4cd990a0b962e761e22901f8ab",
    "scripts/verify-docs-standard.sh": "a7c0c72fd0d361dc3376d47488b9caede3e41c117b2148489b16d26cd600275b",
    "scripts/verify-fixture-count.sh": "9db4a7bd8cc3d01ddec49ba52004e8a839a9a67246e6e67c92d0ac93d0754569",
    "scripts/verify-fixture-schema.sh": "53aca268596cc3f7e94bed6027b22fd6810a01f53afb878a5877a35f2c28ea82",
    "scripts/verify-go-lint.sh": "799d09ef71e71a27234dd1896cf66fb2d5afe2342aed78309df141c140e3e644",
    "scripts/verify-go-module-tags.sh": "0ca622faf6844a8ee16d0965d5e08be5d9290ed02dafb0e4602cab38c941f80f",
    "scripts/verify-go.sh": "b062274123b7c12b9779eb1799c2582bfb786017ac1fe520dd8f24286282eac9",
    "scripts/verify-microvm-conformance-harness.sh": "e2adb69d12bab33ac127fb44ecaaa64e14998cee6f2d39c805a40d39c3edbf28",
    "scripts/verify-python-build.sh": "7f3b393224672047554016d544cdd8715c723136485dc0dd203649fb0e205ed2",
    "scripts/verify-python-lint.sh": "4d1397f272c70a48a3630204d3dcf7855444f41e9ee51b74ecfa2c0daeaeaf17",
    "scripts/verify-python-tests.sh": "a2c260c78f0c3f9955b1e12e8c0d4cfa23530bfe0b52318863659ff80eaf48b5",
    "scripts/verify-release-branch-signatures.sh": "b252234f19702bb1e1e9893d6047d802b81dbd7d073de64a3ebd24eb86b08c3f",
    "scripts/verify-release-branch.sh": "5707f8ab5af9a0585119cb6691827b2961056897a92537e27763ac2d5c20fd6f",
    "scripts/verify-release-cycle.sh": "63d5d122f4fd2d1f1fb6436d90513a6222543b30461220162bd14c4a26c07662",
    "scripts/verify-release-gates.sh": "ed9bfef8eee60a76437c1e51f9f405644cf6302088431aeb232a96a8450afe18",
    "scripts/verify-release-pairing.sh": "1de72ff31c814730b7c0282fe18693479f0a0ecb39c927e074e3b041d920e902",
    # No pinned workflow names this one. The guard's own verify pass runs it - it is the
    # release-credential boundary test - so it is a root of the closure from here. The guard
    # is unpinned, so this pins the verifier's bytes, not the call of it.
    "scripts/verify-release-please-token-safety.sh": "c636e05b0840ac25edb5c31280a6f49e1d216be7c3348fc95c816e60677590d9",
    "scripts/verify-release-pr-postcondition.sh": "25e41253ec2cd549ae6e85712bc2815ecf91e0d8676e1218f7a42961dbf31416",
    "scripts/verify-release-publish-postcondition.sh": "61b21485d0d97cc06b7c3d62a762fbd79632af78b12cf5e98b8adad6b2ff8766",
    "scripts/verify-release-state.sh": "a55337b19361b3604ad4552faff6077b37a217c51a7a7bf274cdc8e088636753",
    "scripts/verify-release-train-promotion.sh": "7df69fe23210d89d14f8e70bd8118fe9bd7be3e85364385cfd46796d5bca3ba5",
    "scripts/verify-rubric.sh": "c4182067f51cd9bc721b08fed9d4fe0e3ce30d6a020aa0de36e4c8b54f8cc818",
    "scripts/verify-runtime-floor-claims.sh": "d8e452ab43c7eaeb52a91e9003064b5dd5843ea49e0f6e31575ab992bc83152d",
    "scripts/verify-scaffold-examples.sh": "1e242ba49c7cb89112836a946e2964a540f1bbc7ff37fd0ab48651249cd42524",
    "scripts/verify-testkit-examples.sh": "e00d89f230f744762f0b20ef33776d45b396a2df77c0dce3d364e7946b84b973",
    "scripts/verify-theorycloud-apptheory-publish-config.sh": "0e8e1ba2266954338abc90227b08643941be55a0f0d786c71b27515ffa19b11c",
    "scripts/verify-theorycloud-apptheory-subtree.sh": "f6bad2b5ae33be44000590ad682f35ffb463d2cf8865d61547b371d3b3f9d909",
    "scripts/verify-theorycloud-publish-workflow.sh": "afadfd324ec3a81207e2b2aadfc2d88954e279d18dbc3c48b510aea9acff2033",
    "scripts/verify-ts-dist-drift.sh": "177bcfd3ce85ef75d53aef672a431723883f193162f09e8f36c82753dab5e98b",
    "scripts/verify-ts-lint.sh": "2416c9a76cf0ff8db4e06f48b8cff3e433f79a7dc6e175c2756a5fa75748253b",
    "scripts/verify-ts-pack.sh": "1b323b96cff29d81002b01e55263738f41c98da98791a9cae1d409f77b2d35b5",
    "scripts/verify-ts-tests.sh": "538de4fd733a48ab399cb591c251760212d84d8e44ccfb95dc6a7f76a8b4c410",
    "scripts/verify-version-alignment.sh": "ee6513e9f81957eaeefe208c256405ed2c74acf6bcf53cceef35a477264638f9",
}

# The files outside those roots that the pinned closure names, pinned all the same: the three
# contract runners the release gates execute, the testkit and CDK example programs they run,
# and the curated-package marker a pinned snapshot tool names. A pinned file may name only
# files that are pinned and where a file lives does not enter into it, so these are pins like
# any other and an edit to one of them is the same visible two-place edit. The derivation does
# not tell a read from a run - a byte scanner cannot - so a name is pinned whether the site
# reads it or runs it, and the doc says so rather than guessing.
OUT_OF_ROOT_FILE_DIGESTS = {
    "ts/test/appsync-context.test.mjs": "54417a837f08fab6799b80a549b7842eb28fde1563ece26f137a66899766706a",
    "ts/test/appsync-errors.test.mjs": "8a950fa63de5dbaf7b5051945b43a47db1157e8338e80edf4419e351efe0901e",
    "ts/test/appsync-handle-lambda.test.mjs": "37968f7ebbdfe02a5900413265389470476919001cd2948cc94d942a8e3f6ddd",
    "ts/test/appsync-projection.test.mjs": "b2059248e6f42ff81fbd611e51b9eb89197069ee541c67af6ce9862a3a585e2e",
    "ts/test/appsync-testkit.test.mjs": "fb79e4ab609893c80ced7d20133d163250e0ccd7c21218e45a70469ef59b8153",
    "ts/test/aws-http-streaming.test.mjs": "dff1a2087b87574f395cf4fb44ee8c1237c6393456e00106452869d0c0189527",
    "ts/test/governance-coverage.test.mjs": "1da7017c32587ba8b4597ebe1cf813d424aaa49447c5681cfe13fef027b83368",
    "ts/test/header-canonicalization.test.mjs": "36bf3fdfc55e60f7b9a6b5ad5c31bc33bf83442ffc46b5e405c5dcc8b447b70c",
    "ts/test/http-error-format.test.mjs": "486c1a41b456f7f56d749a8f2ac9d705e92c7fb5f50ae4bc18595451ecc40067",
    "ts/test/http-testkit.test.mjs": "0ece21bc6eb31a1ee86b217371b56b31517bf235496b108d9af565cccb382e68",
    "ts/test/jobs.test.mjs": "49b3f9cd23ec94729fc5a1793fff2d5082ef3917e668a753f793c2334c18c040",
    "ts/test/kinesis-cloudwatch-logs.test.mjs": "ea5a21f495a6eede088e6c4dca889b92b606d2e395bf2af6fa65ee59fcfed013",
    "ts/test/kinesis-producer.test.mjs": "32a4ea14ee38c7b60d5277e98509bb148a06239554bf293b59b92a8cb2319e93",
    "ts/test/logging-profile.test.mjs": "3e324a5b5d4290ecc6db0cbea8528f1ae899e416d4491cd46cd1a81e2b138172",
    "ts/test/mcp.test.mjs": "34c9ebf5be022f3d1070be9fd18b8da6717428be6f129e1f9892f621fa77166c",
    "ts/test/microvm.test.mjs": "4c2fc13e745ec7b973df61de471a4500e6020384861807efd6fd5b9009473a8a",
    "ts/test/oauth.test.mjs": "a7252ecc1432beed9e0cfe93f4ad3d75b4b6da4b9c15e8382ebfd7c0a826265f",
    "ts/test/objectstore.test.mjs": "c7dc6295a8582dc9d7396e715b12027e2b61fad0b10b6b4de82850dea7ff94ee",
    "ts/test/response.test.mjs": "02c0344dbe347a7b83e2f9215a8ddaa33136a68325c4314593d5d13903fc5e61",
    "ts/test/sanitization.test.mjs": "523bf569769fbb5cd87327d2415d2b069d203fb2b500aa867a028a2c387a9b91",
    "ts/test/secure-denial-headers.test.mjs": "756705f33c2457a5b6888a027e518de48010ea6da8b1e6ccf323a310b9533973",
    "ts/test/timeout-middleware.test.mjs": "d7d55ace6cc951ed2110e9eb5eb46011ed62cbe300ca1ce547a145c988ed9a4d",
    "ts/test/validation.test.mjs": "b8645379b8455cdb236714753cccb1bd8cf2dcf9c1080e1f504fa74fda986b33",
    "ts/test/vectorstore.test.mjs": "02ba6633ebf8c70592b5e54f5f0c379a176093a694d6cb695b81f7503f3567cc",
    "contract-tests/runners/py/run.py": "6861fa8273fc20a31c61f802bf0e16caea7db5a2cdf23ca3a808d9a2d67f373c",
    "contract-tests/runners/ts/fixtures.test.cjs": "75315854e6d5f922076bbd82cfeaed684b0bd1f651fd23e7c9089cbba21b1064",
    "contract-tests/runners/ts/run.cjs": "f4ca1e22d58df6b1cbb237fd8cbbbdf45534b614a12ca2b6ff795c604bcacf5b",
    "examples/cdk/hello-world/handlers/py/handler_test.py": "d5f0368f8aafc8dad1ae4bc51ffd2624c20ebe8ef5eb1961f12d136968ddfe6a",
    "examples/cdk/hello-world/handlers/ts/app.mjs": "aeaf7fa561562807b25a03e0e71667ba4e227843ddb2f9ed40fea64cc2dd1e35",
    "examples/cdk/hello-world/handlers/ts/handler.test.mjs": "4b9a225c2db54fe4c9cec24c102e0cc3283982ae538166dcdaaa33d6100134b5",
    "examples/mcp/tools-only-py/server_test.py": "3bac538273d54687b6a3fae699e9722f24ad30bda71d7bff24e94489a7635656",
    "examples/mcp/tools-only-ts/server.mjs": "7dcbdca7e4042c9bf0c07b2f4fe20c8b3c3a6fdab4967931ed7563108410bb1f",
    "examples/mcp/tools-only-ts/server.test.mjs": "54b3c1bc8359153d7fb17cd3dd370564afe35eb832ec9afa0eee3fa5bb0a1213",
    "examples/testkit/py.py": "ee20b7b54984d5f776f46078ca191ed09bd73670a9065d66c3ce5f01d4296b2f",
    "examples/testkit/ts-streaming.mjs": "fa4b04dc724c44b1d417c7c8fa8e591f590952915f653457831c4fc77105f642",
    "examples/testkit/ts.mjs": "6ccc6662c9e1e6d812f4ab7c15a34c060253eb2323b70d5a802743e8fcc11f33",
    "py/src/apptheory/__init__.py": "84ec707055fd97b8cc5b8360cbbaabcd3bd97f0edb5f83eb443d25240a7a710f",
    # The package manifests. Every `package.json`, `package-lock.json` and `npm-shrinkwrap.json`
    # this repository can commit is pinned, because an npm invocation's directory is a `cd` this
    # construction does not follow: the manifest whose lifecycle scripts can run and the lockfile
    # whose resolved versions and integrity hashes bind the dependency bytes are then pinned
    # content wherever the invocation runs. Round 8 pinned none of them, so a pinned gate's
    # `npm run build` ran bytes from a `package.json` no pin described.
    "cdk/package-lock.json": "42e3ffbb0a9181d9c48c4aad41d5f662ccf78e71ab292ac8bb2a9a9ce0a0b34d",
    "cdk/package.json": "150d6b6bcea340f2f668a70fcb95b81a41955eb687c5b9d4080314d51d4eb755",
    "examples/cdk/codebuild-job-runner/package-lock.json": "3c1a33629363474f62c6227797329547f8b56483c9933afb7398639974bb076b",
    "examples/cdk/codebuild-job-runner/package.json": "db2ab2659f4ee979de050a74c8adaa408767446d7662e21362e33d0b051c732a",
    "examples/cdk/hello-world/handlers/ts/package.json": "d2464c8d09cb127c2d88dbbcf17bd8977b31338911cc48bcdfcfc35cf7612248",
    "examples/cdk/hello-world/package-lock.json": "dab6b47a871afcd90764db1ce7d0c8972f43b17653cfd8983d2fc22c09b7aad6",
    "examples/cdk/hello-world/package.json": "cf1c429c4a670244f75435a71fa2c49ac0e394fd3b86ee423b3683c7ca3f35c6",
    "examples/cdk/import-pipeline/package-lock.json": "622dfcdf29b8ecae0bf98ad59c99bb11d7615e7f1b0b28d7c0492a100a0f9a56",
    "examples/cdk/import-pipeline/package.json": "b090f91f7e5e802e06ea9d06e2268556bb6d0fbd7ad32071acf314b683bb18ac",
    "examples/cdk/kinesis-cloudwatch-logs/package-lock.json": "38502198e4198edfec04ddaeba0703ba03c1984e21b37583132e33d380e142c6",
    "examples/cdk/kinesis-cloudwatch-logs/package.json": "bd6429d56b638876d44fbcbf7bdf767b8b1818c2be97c24f130bcd1f399a40ad",
    "examples/cdk/lambda-role/package-lock.json": "660400ec4d8195ef83a9cb14e101e68b1a63020a56d1a8d44f4fc74fcf4c4851",
    "examples/cdk/lambda-role/package.json": "08196fd6f4da4feca4ef2cae196a1d33eaed702b6117a4f701cfd0ebac56fc2c",
    "examples/cdk/lesser-parity/package-lock.json": "f73265cfb0037bdc172d947444c44d34475175482f5710adde65724b69a657f8",
    "examples/cdk/lesser-parity/package.json": "ff0360fcbcb37c511b8ded9326ccb755ca794db699af07bf012d56897903d09c",
    "examples/cdk/media-cdn/package.json": "9b5b8e128fdd09cbe5a1e411437c95a6991f63b702c758216c1b2ab8a26e06a2",
    "examples/cdk/microvm-controller/package-lock.json": "d82d2c793e7cef74aa99a53f8064ae4352a1bb9585ad50a8f0d017d6acb161e7",
    "examples/cdk/microvm-controller/package.json": "bfb14fac579a305c01ae9c03fb70cb32678b29258f20e7c44bdbeedd8f933fb6",
    "examples/cdk/microvm-controller/workloads/ts/package.json": "f69ed17eea98f49ee075f676bae79df9cb779e54d5887b94d94313d34511170c",
    "examples/cdk/multilang/handlers/ts/package.json": "631fd91d47940a1162c7d10f6d2abf71896facde9c6fc28def3fe0fc51666940",
    "examples/cdk/multilang/package-lock.json": "1baa6dce8d2b92dd0932edfac72f1af2ea9147bcea2e2fc084c7ca1623884feb",
    "examples/cdk/multilang/package.json": "1ad647e2f5f0e94881018a4b7f0d22f8145e37d5a817bee1c1f4e128b1075052",
    "examples/cdk/path-routed-frontend/package.json": "18c5883e57a7e195a950ddf6fc0fca000304be4145aa6c79b84c8047fe2b068b",
    "examples/cdk/restv1-router/package.json": "cc9b097a5b9be9c46970416865e8f296b689a9bdb9047a02e9f5ab8355e09eb0",
    "examples/cdk/s3-vectors-semantic-search/package-lock.json": "aff00d207f9ac5ccae96d42e8c552a41e3aa05f3b23e21dca0ef500f20500b3e",
    "examples/cdk/s3-vectors-semantic-search/package.json": "4d480377984d702a7456a10506bbcc78e7428f57022e8038ebe8e9bf0e6861de",
    "examples/cdk/sqs-queue/package-lock.json": "93c0c4417dee4dde293ea8bae91513a4eb816e43a6c6561561420ff4a2be4b03",
    "examples/cdk/sqs-queue/package.json": "500b9e9ed3f96f42ab9f3ec8f4b13dfc2193b123c4ab64e851358208092fe284",
    "examples/cdk/ssr-only-provided-assets-site/package-lock.json": "b44d2599a79b5b0f35e4a917159e5e59715425d334c96953c0fb503fb290eb31",
    "examples/cdk/ssr-only-provided-assets-site/package.json": "d5c4f65660ba42b2e96b6ef3256c0a799cc391567f87b7432dace15fe786ed88",
    "examples/cdk/ssr-site/package-lock.json": "1530ad6500f07fbdeee2b9cce1f2b336de3f982494f5c22f20458c1327090486",
    "examples/cdk/ssr-site/package.json": "34b1c3ee7b1512c0301d8c42660edde2506f673b2c14a15a0e839076cf79ee88",
    "examples/mcp/tools-only-ts/package.json": "f86c21ed02836ffe608286e702ae58e706a7a723ac7900b686345db6e80ec280",
    "ts/package-lock.json": "53eac22fdabd809a622fa9dbf98d61f7d7e3bf639c9a6017feced1a16e8ea26a",
    "ts/package.json": "c88de0b5966faa0caceb0882ad119172c9066564d4a2fa2f76be03feb446d5ed",
    # The files those manifests run. Pinning a manifest is what makes these reachable, and the
    # closure is re-derived from their bytes on every run like every other pinned file.
    "examples/cdk/microvm-controller/workloads/py/server.py": "e9dafe34c710298c0567eb5a98eb724242ad19de52037eccc85e1318b84213aa",
    "examples/cdk/microvm-controller/workloads/ts/server.js": "10f94316d68f1536e579f57b505025aa98d4694bc94bb7e53ba8bbaac1e93fa2",
    "ts/scripts/verify-openapi.mjs": "45339ef4f14889687d7f451601f142c801c438b498c03c19205a57a4aa99c653",
    "ts/scripts/verify-secure-app.mjs": "b74fdca6703b450e0fbe22eecec4d14df0771c6c67612dec35db0083827f6c08",
}

PINNED_FILE_DIGESTS = dict(
    WORKFLOW_FILE_DIGESTS, **RELEASE_PATH_FILE_DIGESTS, **OUT_OF_ROOT_FILE_DIGESTS
)

# Finding classes. Each attack case in the battery names the class it must fail on, and each
# accepted case names a shape that must produce no finding at all, so a case that starts
# failing - or passing - for an unrelated reason fails the battery loudly.
#
# `digest` is the whole of the pinning construction: a byte of a pinned file changed. There
# is no finer class because there is no finer rule.
CLASS_DIGEST = "digest"
CLASS_CLOSURE = "closure"
CLASS_SWEEP = "sweep"


def read_source(path: str) -> str:
    """Read a pinned file without newline translation.

    `Path.read_text()` opens in universal-newlines mode, so it would hand back `\\r\\n` as `\\n`
    and a CRLF copy of a pinned file would hash equal to its pin. A pinned file is compared
    byte for byte, so its bytes are what is read. The reader probe below fails loudly if this
    function ever stops being byte-faithful.
    """
    with Path(path).open("r", encoding="utf-8", newline="") as handle:
        return handle.read()


# The probe that keeps the claim above honest. It is the one place the guard tests its own
# reader: a universal-newline reader is a whitespace tolerance by another name, it was
# written into this construction once, and string-mutating battery cases cannot see it.
_reader_probe_body = "line\r\nline\rline\n\ufeffmark"
_reader_probe = Path(tempfile.mkdtemp(prefix="release-workflows-reader-")) / "probe.txt"
_reader_probe.write_text(_reader_probe_body, encoding="utf-8", newline="")
if read_source(str(_reader_probe)) != _reader_probe_body:
    raise SystemExit(
        "release-workflows: FAIL (the pin reader is not byte-faithful: it returned different text "
        "than the file holds, so a CRLF or CR line ending would hash equal to an LF pin)"
    )
_reader_probe.unlink()


def digest_of(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def tolerance_hint(text: str) -> str:
    """What a mismatch looks like when it is a normalisation a pin does not tolerate."""
    hints = []
    if text.startswith("\ufeff"):
        hints.append("begins with a byte-order mark")
    if "\r" in text:
        hints.append("contains carriage returns (CRLF line endings)")
    if not text.endswith("\n"):
        hints.append("does not end with a newline")
    if not hints:
        return ""
    return (
        "; the file " + " and ".join(hints) + ". Pinned files are compared byte for byte, so the "
        "fix is to normalise the file - the normalisation is visible in the diff - because a "
        "tolerance here is a tolerance an attacker can write through"
    )


def digest_findings(read_text):
    """Every pinned file that is not its pinned revision, byte for byte."""
    findings = []
    for path, pinned in PINNED_FILE_DIGESTS.items():
        if Path(path).is_symlink():
            findings.append(
                (
                    CLASS_DIGEST,
                    f"{path}: is a symbolic link. A pinned file is pinned by the bytes that execute, and a "
                    f"link's bytes belong to whatever it points at, so a pin over a link pins an object the "
                    f"release path does not name. Make it a file",
                )
            )
            continue
        try:
            text = read_text(path)
        except (OSError, UnicodeDecodeError) as error:
            findings.append(
                (
                    CLASS_DIGEST,
                    f"{path}: cannot be read as UTF-8 text ({error}); the release path pins this file by "
                    f"its whole-file SHA-256",
                )
            )
            continue
        actual = digest_of(text)
        if actual != pinned:
            findings.append(
                (
                    CLASS_DIGEST,
                    f"{path}: is not the pinned revision. This file is part of the release path and is "
                    f"pinned by its whole-file SHA-256, so it changes only together with the pin that "
                    f"describes it: replace {pinned} with {actual}{tolerance_hint(text)}",
                )
            )
    return findings


def closure_findings(read_text):
    """Script paths a pinned file names that are pinned by nothing, or that name no file.

    A pinned file may name only files that are pinned. Where those files live does not enter
    into it: a workflow names a script, a pinned script runs another, and a pinned script runs
    the contract runners under `contract-tests/` and the examples under `examples/`, so those
    are pinned too. A name that resolves to no file is a finding when the line it is written
    on runs it, because that is exactly what a spelling this construction does not read looks
    like; a name that resolves through a symbolic link is a finding, because the bytes that
    execute are the linked bytes. A name that resolves to no file and that nothing runs is a
    name - a message, a comment, an output path - and is left alone.

    Anything else is a call site the pins do not reach, and it is refused here rather than
    left to an editor's memory of the manifest.
    """
    findings = []
    executed = executed_tokens(read_text)
    swept = set(sweep_paths())
    for path in PINNED_FILE_DIGESTS:
        try:
            text = read_text(path)
        except (OSError, UnicodeDecodeError):
            continue
        base_dir = posixpath.dirname(path)
        for token, line, _start in script_references(text):
            resolved, through_link = resolve_reference(token, base_dir)
            if resolved is None:
                if written_path(token) is None:
                    findings.append(
                        (
                            CLASS_CLOSURE,
                            f"{path}: names {token!r}, which is not one of the spellings this guard reads. A "
                            f"path is read as a plain path, with a leading `./`, or behind a braced variable "
                            f"directory; an unbraced variable, a quoted segment, a command substitution, an "
                            f"absolute path and a `~` are refused rather than skipped, because a spelling this "
                            f"guard cannot canonicalise is a script it cannot vouch for",
                        )
                    )
                elif token in executed:
                    findings.append(
                        (
                            CLASS_CLOSURE,
                            f"{path}: runs {token!r}, which names no file. The line runs it - {line.strip()!r}"
                            f" - and it resolves to nothing, so the release path would run whatever that name "
                            f"means at run time and no pin could say what it is",
                        )
                    )
                continue
            if through_link:
                findings.append(
                    (
                        CLASS_CLOSURE,
                        f"{path}: names {token!r}, which resolves to {resolved!r} through a symbolic link. The "
                        f"bytes that execute are the linked bytes, so a pin over the written path would pin "
                        f"something other than what runs",
                    )
                )
                continue
            if resolved == GUARD_PATH or resolved in PINNED_FILE_DIGESTS:
                continue
            findings.append(
                (
                    CLASS_CLOSURE,
                    f"{path}: names {token!r}, which resolves to {resolved!r} and is pinned by nothing"
                    + (
                        ""
                        if resolved.startswith(CLOSURE_ROOTS)
                        else " (it is outside `scripts/` and `gov-infra/`)"
                    )
                    + f". A pinned file may name only files that are pinned themselves, so the reference "
                    f"and the pin are one change",
                )
            )
        for candidate, selector, line in makefile_candidates(text, base_dir):
            if candidate in PINNED_FILE_DIGESTS or candidate == GUARD_PATH or candidate in swept:
                continue
            findings.append(
                (
                    CLASS_CLOSURE,
                    f"{path}: runs `{selector}` against {candidate!r} in {line!r}, and that makefile is "
                    f"pinned by nothing. A make with a directory or a file selector reads the makefile the "
                    f"selector names, so the selector and the pin are one change",
                )
            )
    return findings


def glob_members(token, base_dir):
    """The repository files a glob in an executed position expands to, right now.

    Re-derived on every run, like the closure: the guard resolves the glob the way the shell
    would, from the repository root and from the referencing file's directory, and asks for the
    files that exist at this revision. A glob whose matches are all pinned is a set the pins
    describe; a glob that matches nothing is a set nobody describes.
    """
    bare = ADMITTED_VARIABLE_DIRECTORY.sub("", token, count=1)
    if bare.startswith("./"):
        bare = bare[2:]
    members = set()
    for candidate in (bare, posixpath.join(base_dir, bare)):
        for match in glob.glob(candidate, recursive=True):
            path = Path(match)
            try:
                resolved = path.resolve()
            except OSError:
                continue
            if path.is_file() and resolved.is_relative_to(ROOT):
                members.add(resolved.relative_to(ROOT).as_posix())
    return sorted(members)


def module_file_for(name):
    """The repository file a Python `-m` module name resolves to, or None.

    A module is a file or a package: `evilmod`, `evilmod.py` and `evilmod/__init__.py` are the same
    module to the interpreter. Only a name that resolves to a file *in this repository* is a
    finding; `venv`, `pip`, `unittest`, `coverage`, `ensurepip` and `build` are resolved by the
    interpreter out of its own standard library and site-packages, name no file here, and stay
    accepted.
    """
    for candidate in (f"{name}.py", posixpath.join(name, "__init__.py"), name):
        resolved, _through_link = resolve_reference(candidate, "")
        if resolved is not None:
            return resolved
    return None


def executed_path_findings(read_text):
    """Paths a pinned file runs that are pinned by nothing, or that name no file.

    Every token the executed-path rule reads must resolve to a file this construction pins.
    Where it lives does not enter into it and neither does its suffix: a name the guard cannot
    pin is a name a later commit may edit with no pin edit at all, which is the whole reason
    the extension allowlist above was not enough.

    The shapes that are findings rather than skips are each a spelling the guard cannot
    canonicalise into a pin: an unrecognized command whose non-option argument is a glob (the
    guard cannot say which command runs what it expands to), a glob in a running position at
    all (the matched set is named at run time, by nothing), a brace expansion, an array or
    variable expansion, a bare name with no directory component, a `python -m` module that
    resolves to a file here, a pipe into a launcher with no name on the line, a spelling the
    guard refuses to resolve (an unbraced variable, a quoted segment, a command substitution, an
    absolute path, a `~`), and a name that resolves to no file. A glob in a reading position - an
    option value, a pathspec, a coverage filter - is not one of these, and neither is dependency
    code: the carve-out is decided on the *resolved* path, so a spelling that walks out of a
    dependency directory into a tracked file is a finding like any other unpinned name.
    """
    findings = []
    for path in PINNED_FILE_DIGESTS:
        try:
            text = read_text(path)
        except (OSError, UnicodeDecodeError):
            continue
        base_dir = posixpath.dirname(path)
        bodies = heredoc_bodies(text)
        for index, line in enumerate(text.split("\n"), 1):
            in_body = bodies.get(index)
            if in_body == HEREDOC_READ_DATA:
                continue
            stripped = line.strip()
            if stripped.startswith("#") or stripped.startswith("//"):
                continue
            for position, command, token, _line in executed_path_references(
                line, in_body=in_body is not None
            ):
                where = f"{path}:{index}"
                if position == "brace":
                    findings.append(
                        (
                            CLASS_CLOSURE,
                            f"{where}: runs `{command}` against {token!r}, which holds a brace "
                            f"expansion. The shell rewrites the name before anything runs, so the token "
                            f"written here is not the name that executes - `node scripts/{{deep,}}/evil7.js` "
                            f"runs the file under `scripts/deep/` - and a set named by an expansion is a set "
                            f"no pin describes. Write the name out",
                        )
                    )
                    continue
                if position == "refused":
                    findings.append(
                        (
                            CLASS_CLOSURE,
                            f"{where}: runs `{command}` against {token!r}, an expansion rather than a name "
                            f"this guard can read. A path is read as a plain path, with a leading `./`, or "
                            f"behind a braced variable directory; an array subscript, a bare variable, a "
                            f"command substitution and every other expansion are refused rather than "
                            f"skipped, because a spelling this guard cannot canonicalise is a file it cannot "
                            f"vouch for",
                        )
                    )
                    continue
                if position in ("bare", "piped-bare"):
                    findings.append(
                        (
                            CLASS_CLOSURE,
                            f"{where}: runs `{command}` against the bare name {token!r}. A name with no "
                            f"directory component is how a variable, a flag value and an object property are "
                            f"written everywhere else in this file, and every execution on this release path "
                            f"writes a slashed path - so a bare name in an executed position is refused rather "
                            f"than read as a path",
                        )
                    )
                    continue
                if position == "module":
                    module_file = module_file_for(token)
                    if module_file is not None:
                        findings.append(
                            (
                                CLASS_CLOSURE,
                                f"{where}: runs `{command} -m {token}`, and {module_file!r} is a file in "
                                f"this repository. A Python module that resolves to a file here is a file the "
                                f"release path runs, and it is pinned by nothing, so the reference and the pin "
                                f"are one change - a module the interpreter resolves out of its own standard "
                                f"library and site-packages (`venv`, `pip`, `unittest`, `coverage`) names no "
                                f"file in this tree and is left alone",
                            )
                        )
                    continue
                if position == "piped-empty":
                    findings.append(
                        (
                            CLASS_CLOSURE,
                            f"{where}: pipes into `{command}` with no name on the line - {line.strip()!r}. "
                            f"The names that launcher will run come from the left of the pipe, which is data "
                            f"in another command this guard cannot read, so the set it runs is named at run "
                            f"time by nothing. Name the file on the line",
                        )
                    )
                    continue
                if position == "unrecognized":
                    findings.append(
                        (
                            CLASS_CLOSURE,
                            f"{where}: runs `{command}` against the glob {token!r}. The command is not one "
                            f"of the executor spellings this guard reads, so what it does with what the "
                            f"glob expands to is a guess, and a guess is not a pin",
                        )
                    )
                    continue
                if glob_like(token):
                    members = glob_members(token, base_dir)
                    unpinned = [
                        member
                        for member in members
                        if member not in PINNED_FILE_DIGESTS and member != GUARD_PATH
                    ]
                    if not members:
                        findings.append(
                            (
                                CLASS_CLOSURE,
                                f"{where}: writes the glob {token!r} where `{command}` runs it, and the "
                                f"repository holds no file that glob matches. A glob names no file until the "
                                f"shell expands it, so the set it runs is named at run time by nothing - "
                                f"enumerate the names, or write the glob over a matched set the pins describe",
                            )
                        )
                    elif unpinned:
                        findings.append(
                            (
                                CLASS_CLOSURE,
                                f"{where}: runs `{command}` against the glob {token!r}, which expands to "
                                f"{len(members)} file(s) and pins {len(members) - len(unpinned)} of them. "
                                f"A pinned file runs only files that are pinned, so every file the glob "
                                f"matches must be pinned: {', '.join(unpinned[:4])}"
                                + (", ..." if len(unpinned) > 4 else ""),
                            )
                        )
                    continue
                if dependency_reference(token, base_dir):
                    continue
                resolved, through_link = resolve_reference(token, base_dir)
                if position == "for-list" and resolved is None:
                    continue
                if resolved == GUARD_PATH or resolved in PINNED_FILE_DIGESTS:
                    continue
                if resolved is None:
                    if written_path(token) is None:
                        findings.append(
                            (
                                CLASS_CLOSURE,
                                f"{where}: runs `{command}` against {token!r}, which is not one of the "
                                f"spellings this guard reads. A path is read as a plain path, with a leading "
                                f"`./`, or behind a braced variable directory; an unbraced variable, a quoted "
                                f"segment, a command substitution, an absolute path and a `~` are refused "
                                f"rather than skipped, because a spelling this guard cannot canonicalise is a "
                                f"script it cannot vouch for",
                            )
                        )
                        continue
                    findings.append(
                        (
                            CLASS_CLOSURE,
                            f"{where}: runs `{command}` against {token!r}, and nothing in the repository has "
                            f"that name. A pinned file runs only files that are pinned, so a name that "
                            f"resolves to nothing is a spelling no pin describes - {line.strip()!r}",
                        )
                    )
                    continue
                findings.append(
                    (
                        CLASS_CLOSURE,
                        f"{where}: runs `{command}` against {token!r}, which resolves to {resolved!r} and is "
                        f"pinned by nothing. A pinned file runs only files that are pinned themselves, so the "
                        f"reference and the pin are one change",
                    )
                )
    return findings


def uses_findings(read_text):
    """Local composite actions in a pinned workflow.

    `uses: ./path` names a directory in this repository that the runner checks out and runs.
    No pin covers a file under it, and - unlike a script, which at least has to be named
    again to change what runs - the action's own content is what executes, so after the pull
    request that introduces it every later commit can edit the code the release train runs
    with no pin edit anywhere. There is no local action in the tree today, so the honest rule
    is to refuse the spelling: adding one means extending the pin closure over the action
    directory in the same change.
    """
    findings = []
    for path in WORKFLOW_FILE_DIGESTS:
        try:
            text = read_text(path)
        except (OSError, UnicodeDecodeError):
            continue
        for index, line in enumerate(text.split("\n"), 1):
            match = LOCAL_USES.match(line)
            if match is None or not match.group("value").startswith("./"):
                continue
            findings.append(
                (
                    CLASS_CLOSURE,
                    f"{path}:{index}: uses the local action {match.group('value')!r}. A `uses:` that names a "
                    f"path in this repository runs code no pin covers, and the action's own files stay "
                    f"editable after the pull request that adds it - worse than a script, which at least has "
                    f"to be named again to change what runs. Pin the action directory in the same change or "
                    f"call a script that is pinned",
                )
            )
    return findings


def pinned_invocation_lines(read_text):
    """The stripped lines of the pinned workflows that name a guarded script.

    A file no pin covers may repeat one of these lines and only these. The line is the pinned
    workflow's own text, so repeating it adds a run of the gate or the guard and cannot weaken
    the step that already runs it.
    """
    lines = set()
    for path in WORKFLOW_FILE_DIGESTS:
        for line in read_text(path).split("\n"):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if any(name in stripped for name in GUARDED_BASENAMES):
                lines.add(stripped)
    return lines


def sweep_findings(read_text, paths=None):
    """Every naming of a guarded script in a file no pin covers.

    A name is admitted from exactly one place: on a line byte-identical to a line a pinned
    workflow holds. That is additive strengthening - running the gate or the guard from
    somewhere else cannot make the step that already runs it stop running - and it is the whole
    of what a file outside the pinned set may say about a guarded script. Every other naming is a
    finding, including one in a new workflow, in a composite action, in the `Makefile` or in
    a root `package.json`.
    """
    findings = []
    admitted = pinned_invocation_lines(read_text)
    for path in (sweep_paths() if paths is None else paths):
        if path in PINNED_FILE_DIGESTS:
            continue
        try:
            text = read_text(path)
        except (OSError, UnicodeDecodeError):
            continue
        for index, line in enumerate(text.split("\n")):
            if not any(name in line for name in GUARDED_BASENAMES):
                continue
            if line.strip() in admitted:
                continue
            findings.append(
                (
                    CLASS_SWEEP,
                    f"{path}:{index + 1}: names a guarded script and is not a byte-identical duplicate of a "
                    f"line a pinned workflow holds ({line.strip()!r}); a file no pin covers may only repeat a "
                    f"pinned invocation line, because repeating it can add a run of the gate and cannot "
                    f"weaken one",
                )
            )
    return findings


def manifest_paths(patterns):
    """Every package manifest this repository can commit, ignoring the ignored trees.

    Dependency code and build output are excluded - a manifest under a carve-out root is dependency
    code, one under `dist/` or a generated docs tree is build output - and a path `.gitignore`
    ignores is excluded too, because a local materialisation (`.codex/`, `.claude/`, `.theory/`) is
    not part of this repository and no commit can reach it. Everything else is walked rather than
    enumerated, so a manifest added anywhere is found rather than missed.
    """
    paths = []
    for name in MANIFEST_FILE_NAMES:
        for path in sorted(Path(".").rglob(name)):
            relative = path.as_posix()
            if any(part in MANIFEST_IGNORED_DIRECTORIES for part in path.parts[:-1]):
                continue
            if gitignore_ignores(patterns, relative):
                continue
            paths.append(relative)
    return tuple(sorted(set(paths)))


def npm_invocations(text):
    """Every npm/npx invocation in a file, with the line it is written on and the text after it.

    This is read over the whole file rather than at command position, because the invocation that
    matters is written inside a subshell - `if ! (cd cdk && npm run build >/dev/null); then` - and a
    reading that only looked at lines starting in column zero would miss every one of them. That is
    the same shape `makefile_candidates` uses, and for the same reason.
    """
    for match in NPM_INVOCATION.finditer(text):
        end = match.end("tool")
        line = text[:end].split("\n")[-1]
        tail = text[end:].split("\n")[0]
        # The tool must be the command word of its segment. A mention inside a condition or a
        # message is not a run: `if ! command -v npx >/dev/null` and an `echo` that says
        # "(npx not found)" are both prose about the tool, and treating them as invocations
        # produced two false findings on pinned lines before this gate existed.
        words = [
            word.strip("\"'")
            for word in COMMAND_SEPARATORS.split(line)[-1].split()
            if word.strip("\"'")
        ]
        command_word = False
        for word in words:
            if word in SHELL_KEYWORDS or ASSIGNMENT.match(word):
                continue
            command_word = word == match.group("tool")
            break
        if not command_word:
            continue
        yield match.group("tool"), line, tail


def npm_directory_spellings(line):
    """The directory spellings an npm invocation's line names, in the order they are written."""
    spellings = []
    for pattern in (NPM_DIRECTORY, NPM_PREFIX_OPTION):
        for match in pattern.finditer(line):
            spelling = match.group("directory").strip("\"'")
            if spelling and spelling not in spellings:
                spellings.append(spelling)
    return spellings


def npm_package_json_candidates(line, base_dir):
    """The package.json files an npm invocation could read, nearest first."""
    candidates = []
    for spelling in npm_directory_spellings(line):
        bare = written_path(spelling)
        if bare is not None:
            candidates.append(posixpath.normpath(posixpath.join(bare, "package.json")))
    for fallback in (posixpath.join(base_dir, "package.json"), "package.json"):
        if fallback not in candidates:
            candidates.append(fallback)
    return candidates


def package_scripts(read_text, manifest):
    """The scripts a pinned package.json declares, or None when it cannot be read as JSON."""
    try:
        data = json.loads(read_text(manifest))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    scripts = data.get("scripts")
    return scripts if isinstance(scripts, dict) else {}


def lockfile_bins(text):
    """The binaries the packages a pinned lockfile installs provide.

    A lockfile records, for every installed package, the `bin` names it puts on `node_modules/.bin`,
    so `npx <name>` can be resolved to the package that provides it without leaving the pinned
    bytes. That is what makes the `npx` rule a pin rather than a guess: what it does not say is
    which tarball the registry served, and that limit is stated in docs/release-process.md.
    """
    try:
        data = json.loads(text)
    except ValueError:
        return set()
    bins = set()
    packages = data.get("packages")
    if not isinstance(packages, dict):
        return bins
    for key, entry in packages.items():
        if not isinstance(entry, dict):
            continue
        name = key.rsplit("node_modules/", 1)[-1]
        recorded = entry.get("bin")
        if isinstance(recorded, str):
            bins.add(name)
        elif isinstance(recorded, dict):
            bins.update(str(item) for item in recorded)
    return bins


def npx_bin(tail):
    """The binary name an `npx` invocation hands the launcher, or None.

    The name is the first non-option word after the tool, and only that word: `npx cdk synth` runs
    `cdk`, and `npx >/dev/null 2>&1` (a condition check) runs nothing, so a first word that is not a
    name makes this None rather than the next word that happens to look like one.
    """
    for word in tail.split():
        if word.startswith("-"):
            continue
        candidate = word.strip("\"'")
        return candidate if NPM_BIN_NAME.match(candidate) else None
    return None


def package_manifest_findings(read_text):
    """Package manifests and npm invocations that the pins do not reach.

    Round 8 did not read npm at all, and the omission was live: a pinned gate runs `npm run build`,
    whose bytes come from a `package.json` nothing pinned, and `npm run evil` in a pinned gate with
    an `evil` script added to a root `package.json` passed with the plant running.

    Three readings, each stated where it lives:

      * every manifest in this repository is pinned. An npm invocation's directory is a `cd` this
        construction does not follow, so rather than guess which manifest an install reads, the
        closed set of manifests and lockfiles is pinned: the `package.json` whose lifecycle scripts
        can run and the lockfile whose resolved versions and integrity hashes bind the dependency
        bytes are then pinned content wherever the invocation runs;
      * `npm run <name>` (and `npm test` and the other lifecycles) must be declared by a pinned
        `package.json` the invocation's line names, and its `pre`/`post` variants come with it. A
        name no pinned manifest declares is a finding, and so is an invocation whose line names no
        manifest that exists;
      * `npx <bin>` runs a binary out of the `node_modules` of the directory it runs in. When that
        directory canonicalises, the pinned lockfile there must record the binary's package; when
        the directory is a spelling this construction cannot follow, the same pinned file must
        install into that spelling first (`npm ci` with the same spelling), which is what makes the
        binary local rather than a registry fetch.

    An install (`npm ci`, `npm install`) is admitted by the first reading, and that is the honest
    statement rather than a skip: whatever directory it installs into, both the `package.json` whose
    lifecycle scripts run and the lockfile whose integrity hashes bind the installed bytes are
    pinned, and npm refuses to run `npm ci` at all without that lockfile.
    """
    findings = []
    patterns = repository_gitignore_patterns(read_text)
    for manifest in manifest_paths(patterns):
        if manifest in PINNED_FILE_DIGESTS:
            continue
        findings.append(
            (
                CLASS_CLOSURE,
                f"{manifest}: is a package manifest in this repository and is pinned by nothing. An npm "
                f"invocation's directory is a `cd` this construction does not follow, so every package "
                f"manifest and lockfile in the repository is pinned: the manifest whose lifecycle scripts "
                f"can run and the lockfile whose resolved versions and integrity hashes bind the "
                f"dependency bytes are then pinned content wherever the invocation runs",
            )
        )
    pinned_manifests = [
        path for path in PINNED_FILE_DIGESTS if posixpath.basename(path) == "package.json"
    ]
    declared_scripts = {}
    for manifest in pinned_manifests:
        try:
            declared_scripts[manifest] = package_scripts(read_text, manifest) or {}
        except (OSError, UnicodeDecodeError):
            declared_scripts[manifest] = {}
    provided_bins = {}
    for lockfile in PINNED_FILE_DIGESTS:
        if posixpath.basename(lockfile) not in ("package-lock.json", "npm-shrinkwrap.json"):
            continue
        try:
            provided_bins[lockfile] = lockfile_bins(read_text(lockfile))
        except (OSError, UnicodeDecodeError):
            provided_bins[lockfile] = set()

    def declares(name):
        return any(
            any(key in scripts for key in (name, f"pre{name}", f"post{name}"))
            for scripts in declared_scripts.values()
        )

    def provides(name):
        return any(name in bins for bins in provided_bins.values())

    for path in PINNED_FILE_DIGESTS:
        try:
            text = read_text(path)
        except (OSError, UnicodeDecodeError):
            continue
        base_dir = posixpath.dirname(path)
        invocations = list(npm_invocations(text))
        installs_state = any(NPM_INSTALL.search(tail) for _tool, _line, tail in invocations)
        for index, (tool, line, tail) in enumerate(invocations, 1):
            where = f"{path} (npm invocation {index} on {line.strip()!r})"
            directories = []
            for spelling in npm_directory_spellings(line):
                bare = written_path(spelling)
                if bare is not None:
                    directories.append(bare)
            if tool == "npx":
                wanted = npx_bin(tail)
                if wanted is None:
                    continue
                named = False
                for bare in directories:
                    for lock_name in ("package-lock.json", "npm-shrinkwrap.json"):
                        lockfile = posixpath.normpath(posixpath.join(bare, lock_name))
                        if wanted in provided_bins.get(lockfile, set()):
                            named = True
                if not named and installs_state and provides(wanted):
                    # The directory is a `cd` this construction does not follow, and the file
                    # materialises it from a pinned lockfile first, so the binary is the one that
                    # lockfile records rather than a registry fetch.
                    named = True
                if not named:
                    findings.append(
                        (
                            CLASS_CLOSURE,
                            f"{where}: runs `npx {wanted}`, and no pinned lockfile the invocation names "
                            f"provides that binary. `npx` runs a binary out of the `node_modules` of the "
                            f"directory it runs in, and falls back to fetching one from the registry when "
                            f"that directory has none - so either name a directory whose pinned lockfile "
                            f"records the package, or install into it from one in the same file",
                        )
                    )
                continue
            run = NPM_RUN.search(tail)
            if run is None:
                continue
            name = run.group("run") or run.group("lifecycle")
            if name is None:
                continue
            candidates = npm_package_json_candidates(line, base_dir)
            existing = [candidate for candidate in candidates if Path(candidate).is_file()]
            declaring = [
                candidate
                for candidate in existing
                if candidate in declared_scripts
                and any(
                    key in declared_scripts[candidate]
                    for key in (name, f"pre{name}", f"post{name}")
                )
            ]
            if declaring:
                continue
            if not existing:
                # No package.json the line names exists. The invocation's directory is a `cd` this
                # construction does not follow, so the reading is file-wide instead: the pinned file
                # installs npm state from a pinned lockfile, and a pinned manifest declares the
                # script. `npm run evil` in a pinned gate has neither.
                if not declares(name):
                    findings.append(
                        (
                            CLASS_CLOSURE,
                            f"{where}: runs `npm run {name}`, and no pinned `package.json` declares that "
                            f"script. A pinned file runs only files that are pinned, and a package script "
                            f"is a file's worth of code: the script and the pin are one change",
                        )
                    )
                elif not installs_state:
                    findings.append(
                        (
                            CLASS_CLOSURE,
                            f"{where}: runs `npm run {name}`, names no `package.json` this construction "
                            f"can read, and installs nothing itself. The bytes that run are a script whose "
                            f"manifest is named nowhere on the line and materialised nowhere in the file, "
                            f"so no pin describes them",
                        )
                    )
                continue
            findings.append(
                (
                    CLASS_CLOSURE,
                    f"{where}: runs `npm run {name}`, and no pinned `package.json` among "
                    f"{', '.join(repr(candidate) for candidate in existing)} declares it. A pinned file "
                    f"runs only files that are pinned, and a package script is a file's worth of code: "
                    f"the script and the pin are one change",
                )
            )
    return findings


def guarded_surface_findings(read_text, sweep=None):
    findings = digest_findings(read_text)
    findings += closure_findings(read_text)
    findings += executed_path_findings(read_text)
    findings += carve_out_findings(read_text)
    findings += package_manifest_findings(read_text)
    findings += uses_findings(read_text)
    findings += spelling_witness_findings(read_text)
    findings += sweep_findings(read_text, paths=sweep)
    return findings


CI_STEP_HEADER = '      - name: Verify apptheory-init template/release pairing\n'
CI_BARE = '          bash scripts/verify-release-pairing.sh\n'
CI_SELF_TEST = '          bash scripts/verify-release-pairing.sh --self-test\n'
CI_STEP_RUN = '      - name: Verify apptheory-init template/release pairing\n        run: |\n'
CI_STEP = '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n'
CI_JOB = '  release-security-gates:\n    name: Release/security gates\n'
CI_HEAD = 'name: CI\n\non:\n'
CI_GUARD_BARE = '          bash scripts/verify-release-workflows.sh\n'
PREMAIN_GUARD_RUN = '        run: bash scripts/verify-release-workflows.sh\n'
GATES_BARE = 'bash ./scripts/verify-release-pairing.sh\n'
CI_TAIL = '      - name: Run full rubric\n        run: make rubric\n'
RELEASE_TAIL = '          gh workflow run pages.yml --repo "${GITHUB_REPOSITORY}" --ref "${TAG_NAME}" -f tag="${TAG_NAME}"\n'

# Every weakening shape rounds 1-4 closed, verbatim, labels included: a label is the historical
# name of the shape - several of them name a classifier tolerance that no longer exists - and not
# a statement about the pins. Under whole-file pins every one of them fails on the digest of the
# file it edits, and the `Makefile` cases fail on the sweep, so each case names the class it must
# fail on; a case that starts failing, or passing, for an unrelated reason fails the battery too.
ROUND_4_ATTACKS = (
    ('`!` prefix negation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          ! bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('`|| echo advisory`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || echo advisory\n',
     CLASS_DIGEST,
    ),
    ('`if false; then ... fi` wrap', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          if false; then\n            bash scripts/verify-release-pairing.sh\n          fi\n',
     CLASS_DIGEST,
    ),
    ('commented-out invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          # bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('step-level `if: false`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        if: false\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('step-level `if: ${{ false }}`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        if: ${{ false }}\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('step-level `if: always()`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        if: always()\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('job-level `if: false`', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    if: false\n    name: Release/security gates\n',
     CLASS_DIGEST,
    ),
    ('`|| true`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || true\n',
     CLASS_DIGEST,
    ),
    ('`|| :`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || :\n',
     CLASS_DIGEST,
    ),
    ('`||:`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh ||:\n',
     CLASS_DIGEST,
    ),
    ('`&& true`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh && true\n',
     CLASS_DIGEST,
    ),
    ('`|| exit 0`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || exit 0\n',
     CLASS_DIGEST,
    ),
    ('`; true`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh; true\n',
     CLASS_DIGEST,
    ),
    ('usage-exit flag `--help`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh --help\n',
     CLASS_DIGEST,
    ),
    ('usage-exit flag `-h`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh -h\n',
     CLASS_DIGEST,
    ),
    ('step-level continue-on-error', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        continue-on-error: true\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('job-level continue-on-error', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    continue-on-error: true\n    name: Release/security gates\n',
     CLASS_DIGEST,
    ),
    ('backslash continuation hiding `|| true`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh \\\n            || true\n',
     CLASS_DIGEST,
    ),
    ('`--self-test`-only step', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n',
     CLASS_DIGEST,
    ),
    ('step-level `shell: bash {0}`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        shell: bash {0}\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('workflow-level `defaults: run: shell: bash {0}`', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\ndefaults:\n  run:\n    shell: bash {0}\n\non:\n',
     CLASS_DIGEST,
    ),
    ('env indirection via `BASH_ENV`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env:\n          BASH_ENV: ./weaken.sh\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('flow-style `env: {BASH_ENV: ...}`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env: {BASH_ENV: ./weaken.sh}\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('job-level `env: BASH_ENV`', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    env:\n      BASH_ENV: ./weaken.sh\n    name: Release/security gates\n',
     CLASS_DIGEST,
    ),
    ('backgrounded invocation (`&`)', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh &\n',
     CLASS_DIGEST,
    ),
    ('duplicate `run:` key in the step', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh\n        run: bash scripts/verify-release-pairing.sh || true\n',
     CLASS_DIGEST,
    ),
    ('duplicate `if:` key on the release PR step', '.github/workflows/release-pr.yml',
     "        if: steps.release_pr.outputs.exists == 'true'\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n",
     "        if: steps.release_pr.outputs.exists == 'true'\n        if: false\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n",
     CLASS_DIGEST,
    ),
    ('folded `run: >-` hiding `|| true`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: >-\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh || true\n',
     CLASS_DIGEST,
    ),
    ('heredoc-smuggled invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          cat <<EOF\n          bash scripts/verify-release-pairing.sh\n          EOF\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: backgrounded invocation (`&`)', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}" &\n',
     CLASS_DIGEST,
    ),
    ('quoted script path', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-pairing.sh\n',
     'bash "./scripts/verify-release-pairing.sh"\n',
     CLASS_DIGEST,
    ),
    ('variable indirection', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          PAIR="scripts/verify-release-pairing.sh"\n          bash "${PAIR}"\n',
     CLASS_DIGEST,
    ),
    ('release PR step-level `if: false`', '.github/workflows/release-pr.yml',
     "        if: steps.release_pr.outputs.exists == 'true'\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n",
     '        if: false\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: commented-out invocation', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     '# scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: `if false; then ... fi` wrap', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'if false; then\n  scripts/verify-release-pairing.sh --tag "${expected_tag}"\nfi\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: errexit disabled with `set +e`', 'scripts/verify-release-branch.sh',
     '# The apptheory-init templates substitute',
     'set +e\n# The apptheory-init templates substitute',
     CLASS_DIGEST,
    ),
    ('shell invoker: errexit never set', 'scripts/verify-release-branch.sh',
     'set -euo pipefail\n',
     'set -uo pipefail\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: `bash` shadowed by a function', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-pairing.sh\n',
     'bash ./scripts/verify-release-pairing.sh\nbash() { return 0; }\n',
     CLASS_DIGEST,
    ),
    ('step-level `if: false` written after the run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        if: false\n',
     CLASS_DIGEST,
    ),
    ('step-level `continue-on-error: true` written after the run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        continue-on-error: true\n',
     CLASS_DIGEST,
    ),
    ('step-level `shell: bash {0}` written after the run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        shell: bash {0}\n',
     CLASS_DIGEST,
    ),
    ('step-level `env: BASH_ENV` written after the run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        env:\n          BASH_ENV: ./weaken.sh\n',
     CLASS_DIGEST,
    ),
    ('meta-guard step `if: false` written after the run body', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-workflows.sh\n',
     '          bash scripts/verify-release-workflows.sh\n        if: false\n',
     CLASS_DIGEST,
    ),
    ('step body shadows `bash` with a function', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash() { return 0; }\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('step body shadows `exit` with a function', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          exit() { :; }\n          bash scripts/verify-release-pairing.sh || exit 1\n',
     CLASS_DIGEST,
    ),
    ('step body reassigns PATH', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          PATH=/tmp/evil:$PATH\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('PATH prefix on the invocation line', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          PATH=/tmp/evil:$PATH bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('step body clears errexit with `set +e` and a trailing success', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          set +e\n          bash scripts/verify-release-pairing.sh\n          true\n',
     CLASS_DIGEST,
    ),
    ('step body installs a trap that overrides the exit status', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     "          trap 'exit 0' ERR\n          bash scripts/verify-release-pairing.sh\n",
     CLASS_DIGEST,
    ),
    ('step body reassigns BASH_ENV', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          export BASH_ENV=./weaken.sh\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('meta-guard step body shadows `bash`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-workflows.sh\n',
     '          bash() { return 0; }\n          bash scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: function shadows `bash` before the invocation', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-pairing.sh\n',
     'bash() { return 0; }\nbash ./scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: `exit() { :; }` with a tolerated fail-closed tail', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'exit() { :; }\nscripts/verify-release-pairing.sh --tag "${expected_tag}" || exit 1\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: PATH prefix on the invocation line', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'PATH=/tmp/evil:$PATH scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: PATH reassignment before the invocation', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'PATH=/tmp/evil:$PATH\nscripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     CLASS_DIGEST,
    ),
    ('`${{ }}` expression as an argument', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh ${{ env.WEAKEN }}\n',
     CLASS_DIGEST,
    ),
    ('variable-indirected `--help` argument', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          PAIRING_ARGS=--help\n          bash scripts/verify-release-pairing.sh "${PAIRING_ARGS}"\n',
     CLASS_DIGEST,
    ),
    ('variable-indirected `--self-test` argument in a release PR workflow', '.github/workflows/release-pr.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          PAIRING_ARGS=--self-test\n          bash scripts/verify-release-pairing.sh "${PAIRING_ARGS}"\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: variable-indirected argument', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-pairing.sh\n',
     'scripts/verify-release-pairing.sh "${PAIRING_ARGS}"\n',
     CLASS_DIGEST,
    ),
    ('tolerated tail backgrounded with `&`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || exit 1 &\n',
     CLASS_DIGEST,
    ),
    ('statement after the tolerated tail', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || exit 1; true\n',
     CLASS_DIGEST,
    ),
    ('tolerated tail piped into a command', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh || exit 1 | tee log\n',
     CLASS_DIGEST,
    ),
    ('shell invoker: tolerated tail backgrounded with `&`', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}" || return 1 &\n',
     CLASS_DIGEST,
    ),
    ('meta-guard call with `|| true` in CI', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-workflows.sh\n',
     '          bash scripts/verify-release-workflows.sh || true\n',
     CLASS_DIGEST,
    ),
    ('meta-guard call with `|| true` in the full release gates', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-workflows.sh\n',
     'bash ./scripts/verify-release-workflows.sh || true\n',
     CLASS_DIGEST,
    ),
    ('meta-guard call backgrounded in the full release gates', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-workflows.sh\n',
     'bash ./scripts/verify-release-workflows.sh &\n',
     CLASS_DIGEST,
    ),
    ('meta-guard self-test arm negated in the full release gates', 'scripts/verify-release-gates.sh',
     'bash ./scripts/verify-release-workflows.sh --self-test\n',
     '! bash ./scripts/verify-release-workflows.sh --self-test\n',
     CLASS_DIGEST,
    ),
    ('meta-guard call with `|| true` in the prerelease preflight', '.github/workflows/prerelease.yml',
     '        run: bash scripts/verify-release-workflows.sh\n',
     '        run: bash scripts/verify-release-workflows.sh || true\n',
     CLASS_DIGEST,
    ),
    ('meta-guard step conditional changed in the stable preflight', '.github/workflows/release.yml',
     "        if: github.ref == 'refs/heads/main' && inputs.tag_name == ''\n        run: bash scripts/verify-release-workflows.sh\n",
     '        if: false\n        run: bash scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('YAML merge key in a guarded workflow', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\n<<: *defaults\n\non:\n',
     CLASS_DIGEST,
    ),
    ('unpinned new step invoking the meta-guard with `|| true`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      - name: Unpinned extra gate\n        run: |\n          bash scripts/verify-release-workflows.sh || true\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_DIGEST,
    ),
    ('unpinned new step invoking the pairing gate with `|| true`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      - name: Unpinned pairing gate\n        run: |\n          bash scripts/verify-release-pairing.sh || true\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_DIGEST,
    ),
    ('unpinned new step carrying a conditional', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      - name: Unpinned conditional gate\n        if: always()\n        run: |\n          bash scripts/verify-release-workflows.sh\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_DIGEST,
    ),
    ('step-level `if : false` (pre-colon whitespace) after the run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        if : false\n',
     CLASS_DIGEST,
    ),
    ('job-level `if : false` (pre-colon whitespace)', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    if : false\n    name: Release/security gates\n',
     CLASS_DIGEST,
    ),
    ('step-level `continue-on-error : true` (pre-colon whitespace)', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        continue-on-error : true\n',
     CLASS_DIGEST,
    ),
    ('step-level `shell : bash {0}` (pre-colon whitespace)', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        shell : bash {0}\n',
     CLASS_DIGEST,
    ),
    ('step-level duplicate `run :` key (pre-colon whitespace)', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh\n        run : bash scripts/verify-release-pairing.sh || true\n',
     CLASS_DIGEST,
    ),
    ('step-level `env :` with `PATH:` (pre-colon whitespace)', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env :\n          PATH: /tmp/evil\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('step-level non-canonical key the guard does not enumerate', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        timeout-minutes : 5\n',
     CLASS_DIGEST,
    ),
    ('step-level quoted key `"if": false`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        "if": false\n',
     CLASS_DIGEST,
    ),
    ("step-level quoted key `'if' : false`", '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     "      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        'if' : false\n",
     CLASS_DIGEST,
    ),
    ('step-level explicit key `? if`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        ? if\n        : false\n',
     CLASS_DIGEST,
    ),
    ('ANSI-C quoting hiding a `PATH` reassignment', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     "          echo $'it\\'s ok'\n          PATH=/tmp/evil:$PATH\n          echo 'a' 'b'\n          bash scripts/verify-release-pairing.sh\n",
     CLASS_DIGEST,
    ),
    ('ANSI-C quoting hiding a weakened invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     "          echo $'it\\'s ok'\n          bash scripts/verify-release-pairing.sh || true\n          echo it is ok\n          bash scripts/verify-release-pairing.sh\n",
     CLASS_DIGEST,
    ),
    ('invocation inside a function called from an `if` condition', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() {\n          bash scripts/verify-release-pairing.sh\n          }\n          if gate; then\n            :\n          fi\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a function that is never called', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() {\n          bash scripts/verify-release-pairing.sh\n          }\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a negated function call', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() {\n          bash scripts/verify-release-pairing.sh\n          }\n          ! gate\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a function in a guarded shell invoker', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'gate() {\n  scripts/verify-release-pairing.sh --tag "${expected_tag}"\n}\nif gate; then\n  :\nfi\n',
     CLASS_DIGEST,
    ),
    ('pinned publisher host called with `|| true`', 'scripts/verify-release-publish-postcondition.sh',
     'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || exit 1\n',
     'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || true\n',
     CLASS_DIGEST,
    ),
    ('pinned publisher host called inside a command substitution', 'scripts/verify-release-publish-postcondition.sh',
     'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || exit 1\n',
     'x="$(verify_release_pairing_postcondition "${tag_name:-${expected_tag}}")"\n',
     CLASS_DIGEST,
    ),
    ('pinned publisher host called plainly inside a wrapper function', 'scripts/verify-release-publish-postcondition.sh',
     'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || exit 1\n',
     'A() {\n  verify_release_pairing_postcondition "${tag_name:-${expected_tag}}"\n}\nif A; then\n  :\nfi\n',
     CLASS_DIGEST,
    ),
    ('pinned publisher host with `|| return 1` inside a wrapper function', 'scripts/verify-release-publish-postcondition.sh',
     'verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || exit 1\n',
     'A() {\n  verify_release_pairing_postcondition "${tag_name:-${expected_tag}}" || return 1\n}\nA\n',
     CLASS_DIGEST,
    ),
    ('pinned indirect dispatch with a trailing `|| true`', 'gov-infra/verifiers/gov-verify-rubric.sh',
     'run_check "CMP-4" "Compliance" "$CMD_RELEASE_LIFECYCLE"\n',
     'run_check "CMP-4" "Compliance" "$CMD_RELEASE_LIFECYCLE" || true\n',
     CLASS_DIGEST,
    ),
    ('pinned indirect dispatch removed', 'gov-infra/verifiers/gov-verify-rubric.sh',
     'run_check "CMP-4" "Compliance" "$CMD_RELEASE_LIFECYCLE"\n',
     '',
     CLASS_DIGEST,
    ),
    ('pinned dispatch function stops re-enabling errexit', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '    set -euo pipefail\n    eval "${cmd}"\n',
     '    eval "${cmd}"\n',
     CLASS_DIGEST,
    ),
    ('pinned dispatch function softens its errexit setup', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '    set -euo pipefail\n    eval "${cmd}"\n',
     '    set -e\n    eval "${cmd}"\n',
     CLASS_DIGEST,
    ),
    ('step-level `env: PATH`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env:\n          PATH: /tmp/evil\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('job-level `env: PATH`', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    env:\n      PATH: /tmp/evil\n    name: Release/security gates\n',
     CLASS_DIGEST,
    ),
    ('workflow-level `env: CDPATH`', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\nenv:\n  CDPATH: /tmp/evil\n\non:\n',
     CLASS_DIGEST,
    ),
    ('step-level `env: BASHOPTS`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env:\n          BASHOPTS: expand_aliases\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('step-level `env: PATH` written as a flow mapping', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n',
     '      - name: Verify apptheory-init template/release pairing\n        env: {PATH: /tmp/evil}\n        run: |\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: `bash` shadowed in the checked function', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  bash() { return 0; }\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: stray `PATH` reassignment in the checked function', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  export PATH="/tmp/evil:${PATH}"\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: extra trap in the checked function', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  trap \'exit 0\' EXIT\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: errexit cleared in the checked function', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  set +e\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: the pinned toolchain export renamed', 'gov-infra/verifiers/gov-verify-rubric.sh',
     'export PATH="${GOV_TOOLS_BIN}:${GOV_TOOLS_PY_BIN}:${GOV_TOOLS_PY_RUNTIME_BIN}:${PATH}"\n',
     'export PATH="${GOV_TOOLS_BIN}:${PATH}"\n',
     CLASS_DIGEST,
    ),
    ('flow-style step mapping invoking the pairing gate', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n      - {name: Extra gate, run: "bash scripts/verify-release-pairing.sh || true"}\n',
     CLASS_DIGEST,
    ),
    ('flow-style step mapping invoking the meta-guard', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      - {name: Extra guard, run: "bash scripts/verify-release-workflows.sh || true"}\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_DIGEST,
    ),
    ('second YAML document in a guarded workflow', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\n\non:\n---\njobs: {}\n',
     CLASS_DIGEST,
    ),
    ('YAML alias as a step run body', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n      - name: Extra anchored gate\n        run: &weak "bash scripts/verify-release-pairing.sh || true"\n      - name: Extra aliased gate\n        run: *weak\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a parens-less `function` body in a step', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          function gate {\n          bash scripts/verify-release-pairing.sh\n          }\n          if gate; then\n            :\n          fi\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a subshell function body', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() (\n          bash scripts/verify-release-pairing.sh\n          )\n          if gate; then\n            :\n          fi\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a conditional function body', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() if true; then\n          bash scripts/verify-release-pairing.sh\n          fi\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a brace-poisoned parens-less function body', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          gate() { echo }\n          function evil {\n          bash scripts/verify-release-pairing.sh\n          }\n          if evil; then\n            :\n          fi\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a parens-less `function` body in the gov verifier', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  function gate {\n  bash ./scripts/verify-release-workflows.sh\n  }\n  if gate; then\n    :\n  fi\n',
     CLASS_DIGEST,
    ),
    ('invocation inside a parens-less `function` body in a shell invoker', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'function gate {\nscripts/verify-release-pairing.sh --tag "${expected_tag}"\n}\nif gate; then\n  :\nfi\n',
     CLASS_DIGEST,
    ),
    ('`bash` shadowed by a parens-less `function` definition in a step', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          function bash { return 0; }\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('`bash` shadowed by a parens-less `function` definition in the gov verifier', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  function bash { return 0; }\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('`bash` shadowed by a parens-less `function` definition in a shell invoker', 'scripts/verify-release-branch.sh',
     'scripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     'function bash { return 0; }\nscripts/verify-release-pairing.sh --tag "${expected_tag}"\n',
     CLASS_DIGEST,
    ),
    ('backquote substitution hiding `set +e`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          x="`echo "it\'s"`"\n          set +e\n          echo "it\'s fine"\n          bash scripts/verify-release-pairing.sh\n          true\n',
     CLASS_DIGEST,
    ),
    ('backquote substitution hiding a `PATH` reassignment in the gov verifier', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  x="`echo "it\'s"`"\n  export PATH="/tmp/evil:${PATH}"\n  echo "it\'s fine"\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('workflow-level quoted key `"env":`', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\n"env":\n  PATH: /tmp/evil\n\non:\n',
     CLASS_DIGEST,
    ),
    ('workflow-level quoted key `"defaults":`', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\n"defaults":\n  run:\n    shell: bash -c \'exit 0\' {0}\n\non:\n',
     CLASS_DIGEST,
    ),
    ('step keys written after extra list-item space', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      -   {name: Fake gate, run: "bash scripts/verify-release-pairing.sh || true"}\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_DIGEST,
    ),
    ('unnamed step written after extra list-item space', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n',
     '      -   run: |\n          bash scripts/verify-release-pairing.sh || true\n      - name: Verify apptheory-init template/release pairing\n',
     CLASS_DIGEST,
    ),
    ("gov verifier: the pinned toolchain export's input redirected", 'gov-infra/verifiers/gov-verify-rubric.sh',
     'mkdir -p "${GOV_TOOLS_BIN}"\n',
     'GOV_TOOLS_BIN="/tmp/evil:${GOV_TOOLS_BIN}"\nmkdir -p "${GOV_TOOLS_BIN}"\n',
     CLASS_DIGEST,
    ),
    ('unpinned step key added to a pinned step', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        working-directory: /tmp/evil\n',
     CLASS_DIGEST,
    ),
    ('second line naming the meta-guard in the gov verifier', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n  bash ./scripts/verify-release-workflows.sh --self-test\n',
     CLASS_DIGEST,
    ),
    ("step body sources a file into the invocation's shell", '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          source /tmp/evil.sh\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ("step body dot-sources a file into the invocation's shell", '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          . /tmp/evil.sh\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ("step body evaluates text into the invocation's shell", '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          eval "$(cat /tmp/evil.sh)"\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('step body moves the shell before the invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          cd /tmp/evil\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: the checked function sources a file', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  source /tmp/evil.sh\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('gov verifier: the checked function moves the shell', 'gov-infra/verifiers/gov-verify-rubric.sh',
     '  echo "==> release workflow invariants"\n  bash ./scripts/verify-release-workflows.sh\n',
     '  echo "==> release workflow invariants"\n  cd /tmp/evil\n  bash ./scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
    ('workflow-level `defaults.run.working-directory`', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\ndefaults:\n  run:\n    working-directory: /tmp/evil\n\non:\n',
     CLASS_DIGEST,
    ),
    ('job-level `defaults.run.working-directory`', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    defaults:\n      run:\n        working-directory: /tmp/evil\n    name: Release/security gates\n',
     CLASS_DIGEST,
    ),
    ('step-level `working-directory`', '.github/workflows/ci.yml',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n',
     '      - name: Verify apptheory-init template/release pairing\n        run: |\n          bash scripts/verify-release-pairing.sh --self-test\n          bash scripts/verify-release-pairing.sh\n        working-directory: /tmp/evil\n',
     CLASS_DIGEST,
    ),
    ('workflow-level `defaults.run.shell` in a meta-guard workflow', '.github/workflows/release.yml',
     'name: Release (main)\n',
     "name: Release (main)\ndefaults:\n  run:\n    shell: bash -c 'exit 0' {0}\n",
     CLASS_DIGEST,
    ),
    ('exported shell function shadow via `BASH_FUNC_`', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     "          export BASH_FUNC_bash%%='() { return 0; }'\n          bash scripts/verify-release-pairing.sh\n",
     CLASS_DIGEST,
    ),
    ('`hash -p` re-pins the command name', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          hash -p /tmp/evil/bash bash\n          bash scripts/verify-release-pairing.sh\n',
     CLASS_DIGEST,
    ),
    ('duplicate job name carrying `if: false`', '.github/workflows/ci.yml',
     '  release-security-gates:\n    name: Release/security gates\n',
     '  release-security-gates:\n    name: Release/security gates\n  release-security-gates:\n    name: Decoy\n    if: false\n',
     CLASS_DIGEST,
    ),
    ('second workflow-level `defaults:` with a poisoned shell', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     "name: CI\ndefaults:\n  run:\n    shell: bash\n\ndefaults:\n  run:\n    shell: bash -c 'exit 0' {0}\n\non:\n",
     CLASS_DIGEST,
    ),
)

# Constants the battery anchors on.

# The discarded accepted table, re-evaluated under the collapse. Each of these was admitted
# by round 4's freedom to add a statement or an inert section; each either changes the bytes
# of a pinned file or names a guarded script outside the pins. All six fail closed now. The
# workflow for any of them is to update the pin in the same PR - a documented two-place edit.
ROUND_4_ACCEPTED_RECYCLED = (
    ('trailing comment after the invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh # pinned in the release doc\n',
     CLASS_DIGEST,
    ),
    ('next-line `true` after the invocation', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh\n',
     '          bash scripts/verify-release-pairing.sh\n          true\n',
     CLASS_DIGEST,
    ),
    ('quoted pinned `--self-test` argument', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-pairing.sh --self-test\n',
     '          bash scripts/verify-release-pairing.sh "--self-test"\n',
     CLASS_DIGEST,
    ),
    ('set +e / set -e capture pair in an unrelated gov verifier function', 'gov-infra/verifiers/gov-verify-rubric.sh',
     'check_file_budgets() {\n',
     'check_file_budgets() {\n  set +e\n  :\n  set -e\n',
     CLASS_DIGEST,
    ),
    ('YAML anchor defined in an inert `x-` section', '.github/workflows/ci.yml',
     'name: CI\n\non:\n',
     'name: CI\nx-bodies:\n  weak: &weak "bash scripts/verify-release-pairing.sh || true"\n\non:\n',
     CLASS_DIGEST,
    ),
    ('unrelated verifier added to a pinned release/security step', '.github/workflows/ci.yml',
     '          bash scripts/verify-release-workflows.sh\n',
     '          bash scripts/verify-api-snapshots.sh\n          bash scripts/verify-release-workflows.sh\n',
     CLASS_DIGEST,
    ),
)


# ---------------------------------------------------------------------------
# Round 5: the collapse. Every case below is a repro of a finding from the
# adversarial review of round 4 (head 0c85ad5d), re-run against byte-exact pins,
# plus the pin-policy cases the new construction is claimed to have.
# ---------------------------------------------------------------------------

META_GUARD_BODY_FIRST = "          bash scripts/verify-branch-release-supply-chain.sh\n"

ROUND_5_ATTACKS = (
    # F1 - round 4 admitted an own-line extra statement it judged inert. `exit 0`
    # as the first line of a run body is inert in no sense: the pinned statements
    # below it stay byte-identical and never run.
    ("F1 own-line `exit 0` first in the pairing step", ".github/workflows/ci.yml",
     CI_STEP_RUN, CI_STEP_RUN + "          exit 0\n", CLASS_DIGEST),
    ("F1 own-line `exec true` first in the pairing step", ".github/workflows/ci.yml",
     CI_STEP_RUN, CI_STEP_RUN + "          exec true\n", CLASS_DIGEST),
    ("F1 own-line `exit 0` first in the release/security step", ".github/workflows/ci.yml",
     META_GUARD_BODY_FIRST, "          exit 0\n" + META_GUARD_BODY_FIRST, CLASS_DIGEST),
    ("F1 own-line `exit 0` first in the prerelease preflight", ".github/workflows/prerelease.yml",
     PREMAIN_GUARD_RUN,
     "        run: |\n          exit 0\n          bash scripts/verify-release-workflows.sh\n",
     CLASS_DIGEST),
    ("F1 own-line `exec true` first in the stable preflight", ".github/workflows/release.yml",
     PREMAIN_GUARD_RUN,
     "        run: |\n          exec true\n          bash scripts/verify-release-workflows.sh\n",
     CLASS_DIGEST),
    # F2 - the heredoc mask ran on comment-split code without the quoting walker,
    # so a quoted `<<` opened a mask that hid the lines below it.
    ("F2 quoted `<<` opens a mask over a shadowed `bash` and a redirected PATH", ".github/workflows/ci.yml",
     CI_BARE,
     '          echo "docs say << true marker"\n'
     "          bash() { return 0; }\n"
     "          PATH=/tmp/evil:$PATH\n"
     "          true\n" + CI_BARE,
     CLASS_DIGEST),
    ("F2 quoted `<<` opens a mask in the release/security step", ".github/workflows/ci.yml",
     META_GUARD_BODY_FIRST,
     '          echo "docs say << true marker"\n'
     "          bash() { return 0; }\n"
     "          true\n" + META_GUARD_BODY_FIRST,
     CLASS_DIGEST),
    # F3 - the pinned toolchain closure was incomplete: GOV_INFRA was read by a pinned
    # statement and never pinned itself, and REPO_ROOT and SCRIPT_DIR were pinned by nothing,
    # so one appended assignment re-pointed the toolchain while the pinned statements stayed
    # byte-identical. The whole file is one digest now, so the three cases below are ordinary
    # byte changes - the mechanism they attacked no longer exists.
    ("F3 `GOV_INFRA` redirected above the toolchain setup", "gov-infra/verifiers/gov-verify-rubric.sh",
     'mkdir -p "${GOV_TOOLS_BIN}"\n',
     'GOV_INFRA="/tmp/evilgov"\nmkdir -p "${GOV_TOOLS_BIN}"\n',
     CLASS_DIGEST),
    ("F3 `REPO_ROOT` re-pointed at the head of the toolchain setup", "gov-infra/verifiers/gov-verify-rubric.sh",
     'PLANNING_DIR="${GOV_INFRA}/planning"\n',
     'REPO_ROOT="/tmp/evilrepo"\nPLANNING_DIR="${GOV_INFRA}/planning"\n',
     CLASS_DIGEST),
    ("F3 `SCRIPT_DIR` re-pointed at the head of the toolchain setup", "gov-infra/verifiers/gov-verify-rubric.sh",
     'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n',
     'SCRIPT_DIR="/tmp/evil"\n',
     CLASS_DIGEST),
    # F4 - pins keyed by (workflow, step name) only, so the pinned step could be
    # moved verbatim into a job that never runs.
    ("F4 pinned ci.yml pairing step moved verbatim into an `if: false` job", ".github/workflows/ci.yml",
     CI_STEP,
     "  quarantined-pairing:\n"
     "    name: Quarantined pairing\n"
     "    if: false\n"
     "    runs-on: ubuntu-latest\n"
     "    steps:\n" + CI_STEP,
     CLASS_DIGEST),
    ("F4 `if: false` added to the pinned ci.yml pairing job", ".github/workflows/ci.yml",
     CI_JOB,
     "  release-security-gates:\n    if: false\n    name: Release/security gates\n",
     CLASS_DIGEST),
    # F5 - the same admitted-freedom rule as F1: an extra statement that names no
    # guarded basename was admitted as inert, and a glob truncate leaves the
    # pinned invocations byte-identical while they run an empty file.
    ("F5 glob truncate of the paired gate before the pinned invocations", ".github/workflows/ci.yml",
     CI_BARE,
     "          printf '' > scripts/verify-release-pa*\n" + CI_BARE,
     CLASS_DIGEST),
    # Round 5's own pin policy.
    ("a new step in a guarded workflow on an unpinned invocation line", ".github/workflows/ci.yml",
     CI_STEP_HEADER,
     "      - name: Extra pairing arm\n        run: |\n"
     "          bash scripts/verify-release-pairing.sh --published\n" + CI_STEP_HEADER,
     CLASS_DIGEST),
    ("a call site added to the Makefile on an unpinned line", "Makefile",
     "test: test-unit\n",
     "bash scripts/verify-release-workflows.sh --self-test\ntest: test-unit\n",
     CLASS_SWEEP),
    ("a workflow-level key added above `jobs:`", ".github/workflows/ci.yml",
     CI_HEAD,
     "name: CI\nenv:\n  FOO: bar\n\non:\n",
     CLASS_DIGEST),
    ("a second root-level `jobs:` mapping added below the first", ".github/workflows/ci.yml",
     "      - name: Run full rubric\n        run: make rubric\n",
     "      - name: Run full rubric\n        run: make rubric\n"
     "jobs:\n  decoy:\n    name: Release/security gates\n    runs-on: ubuntu-latest\n    steps: []\n",
     CLASS_DIGEST),
    ("a job-level key added to a pinned job", ".github/workflows/prerelease.yml",
     "  release-please:\n    runs-on: ubuntu-latest\n",
     "  release-please:\n    timeout-minutes: 1\n    runs-on: ubuntu-latest\n",
     CLASS_DIGEST),
    ("a sibling step added to a pinned job", ".github/workflows/ci.yml",
     META_GUARD_BODY_FIRST,
     "      - name: Extra unguarded helper\n"
     "        run: bash scripts/verify-api-snapshots.sh\n" + CI_GUARD_BARE + META_GUARD_BODY_FIRST,
     CLASS_DIGEST),
    ("the pinned job key defined a second time", ".github/workflows/prerelease.yml",
     "  release-please:\n    runs-on: ubuntu-latest\n",
     "  release-please:\n    if: false\n    runs-on: ubuntu-latest\n  release-please:\n",
     CLASS_DIGEST),
)


# ---------------------------------------------------------------------------
# Round 6: the collapse completed. Rounds 1-5 pinned *regions* inside the five
# workflows, which left every root key below `jobs:`, every key spelling YAML
# resolves to a pinned key, and every script below the pinned steps outside the
# pins. The five workflows are whole-file digests now and the release path is a
# digest closure, so every case below fails on a pin rather than on a rule about
# YAML or bash. Each is a repro from the adversarial review of round 5
# (head b12f6d4a) - R5-1 .. R5-5 - or the battery row the runbook was missing
# (R5-6), plus the closure row this construction carries.
# ---------------------------------------------------------------------------

ROUND_6_ATTACKS = (
    # R5-1 - a root key below `jobs:` was outside every pin. `env: BASH_ENV` sources an
    # attacker's file into every bash step of every job, including the pinned gate steps;
    # a root-level `defaults: run: shell:` replaces the shell of every `run:` step. Both
    # are appended at EOF, which the trailing unpinned `pages-dispatch` job absorbed.
    ("R5-1 root-level `env: BASH_ENV` appended at ci.yml EOF", ".github/workflows/ci.yml",
     CI_TAIL, CI_TAIL + "env:\n  BASH_ENV: ./weaken.sh\n", CLASS_DIGEST),
    ("R5-1 root-level `defaults.run.shell` appended at ci.yml EOF", ".github/workflows/ci.yml",
     CI_TAIL, CI_TAIL + "defaults:\n  run:\n    shell: bash -c 'exit 0' {0}\n", CLASS_DIGEST),
    ("R5-1 root-level `defaults.run.shell` appended at release.yml EOF", ".github/workflows/release.yml",
     RELEASE_TAIL, RELEASE_TAIL + "defaults:\n  run:\n    shell: bash -c 'exit 0' {0}\n", CLASS_DIGEST),
    # R5-2 - key identity is not byte identity. YAML reads `"jobs":`, `jobs :` and `jobs:` as
    # the same key and keeps the last mapping, so a quoted shadow, a quoted duplicate job key
    # and a space-drifted duplicate all resolved to a definition the guard had never read.
    ("R5-2 quoted `\"jobs\":` shadow mapping appended at ci.yml EOF", ".github/workflows/ci.yml",
     CI_TAIL,
     CI_TAIL
     + '"jobs":\n  decoy:\n    name: Release/security gates\n    runs-on: ubuntu-latest\n    steps: []\n',
     CLASS_DIGEST),
    ("R5-2 quoted duplicate job key appended inside the ci.yml `jobs:` mapping",
     ".github/workflows/ci.yml",
     CI_TAIL,
     CI_TAIL + '  "release-security-gates":\n    name: Decoy release/security gates\n'
     "    runs-on: ubuntu-latest\n    steps: []\n",
     CLASS_DIGEST),
    ("R5-2 space-drifted duplicate job key inside the ci.yml `jobs:` mapping",
     ".github/workflows/ci.yml",
     CI_TAIL,
     CI_TAIL + "  release-security-gates :\n    name: Decoy release/security gates\n"
     "    runs-on: ubuntu-latest\n    steps: []\n",
     CLASS_DIGEST),
    ("R5-2 quoted duplicate `\"release-please\":` job key in release.yml", ".github/workflows/release.yml",
     RELEASE_TAIL, RELEASE_TAIL + '  "release-please":\n    runs-on: ubuntu-latest\n    steps: []\n',
     CLASS_DIGEST),
    # R5-4 - the YAML 1.1 boolean alias: `true:` and `on:` are one key to PyYAML, so a `true:`
    # block below `jobs:` could redefine the value the workflow is keyed on.
    ("R5-4 root-level `true:` block appended below `jobs:` in ci.yml", ".github/workflows/ci.yml",
     CI_TAIL, CI_TAIL + "true:\n  cancel-in-progress: true\n", CLASS_DIGEST),
    # R5-3 - the publish path below the pinned steps was substring-guarded only. Wrapping the
    # branch-provenance call in `if false` left every needle present and correctly ordered
    # while the pairing gate stopped running on every tagged publish.
    ("R5-3 `if false` wrap of the branch-provenance call in publish-release-assets.sh",
     "scripts/publish-release-assets.sh",
     'else\n  scripts/verify-release-branch.sh "${tag}"\nfi\n',
     'else\n  if false; then\n    scripts/verify-release-branch.sh "${tag}"\n  fi\nfi\n',
     CLASS_DIGEST),
    # R5-5 - a tolerance that is not semantics-preserving, and the two normalisations the
    # construction used to tolerate. They are byte changes now, like anything else.
    ("R5-5 trailing whitespace after a backslash continuation in a pinned workflow",
     ".github/workflows/ci.yml",
     '          git fetch --no-tags "${release_ref_depth_args[@]}" origin \\\n',
     '          git fetch --no-tags "${release_ref_depth_args[@]}" origin \\ \n',
     CLASS_DIGEST),
    ("R5-5 trailing whitespace on a pinned step line", ".github/workflows/ci.yml",
     CI_SELF_TEST, CI_SELF_TEST.rstrip("\n") + "   \n", CLASS_DIGEST),
    ("R5-5 trailing whitespace on a pinned release-path script line", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE.rstrip("\n") + "   \n", CLASS_DIGEST),
    ("R5-5 CRLF line endings in a pinned workflow", ".github/workflows/ci.yml",
     CI_HEAD, lambda text: text.replace("\n", "\r\n"), CLASS_DIGEST),
    ("R5-5 CRLF line endings in a pinned release-path script", "scripts/verify-release-gates.sh",
     "#!/usr/bin/env bash\n", lambda text: text.replace("\n", "\r\n"), CLASS_DIGEST),
    ("R5-5 byte-order mark prepended to a pinned workflow", ".github/workflows/ci.yml",
     "name: CI\n", "\ufeffname: CI\n", CLASS_DIGEST),
    # R5-6 - the runbook carried a row for an action reference changed inside a pinned job and
    # no battery case behind it. The row stays; the case exists now.
    ("R5-6 action reference changed inside a pinned job", ".github/workflows/ci.yml",
     "      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0\n",
     "      - uses: actions/setup-go@main # v7.0.0\n",
     CLASS_DIGEST),
    # The closure row: a pinned workflow that names a script nothing pins. It fails on the
    # digest of the workflow it edits and on the closure, which is the class of that row.
    ("the closure row: a pinned workflow names a script pinned by nothing", ".github/workflows/ci.yml",
     CI_TAIL, CI_TAIL + "      - name: Closure probe\n        run: bash scripts/verify-ssr-site-smoke.sh\n",
     CLASS_CLOSURE),
    # The round-5 disclosure moved into the interior. At round 5 these two files were read by
    # nothing and were disclosed as unpinned; ci.yml invokes both, so both are in the closure
    # now and an edit to either is a digest finding like any other. Two accepted cases became
    # two attack cases, and the disclosed set is one file - this guard.
    ("the closed boundary: an edit to verify-ci-rubric-enforced.sh",
     "scripts/verify-ci-rubric-enforced.sh",
     'require_contains "${ci}" "bash scripts/verify-release-workflows.sh" \\\n',
     'require_contains "${ci}" "bash scripts/verify-branch-release-supply-chain.sh" \\\n',
     CLASS_DIGEST),
    ("the closed boundary: an edit to the paired gate's own file", "scripts/verify-release-pairing.sh",
     "set -euo pipefail\n", "set -euo pipefail\necho tampered\n", CLASS_DIGEST),
)


# ---------------------------------------------------------------------------
# Round 7: the derivation's silence becomes refusal. Rounds 1-6 stopped at the
# spellings they had been taught: every other spelling resolved to `None` and was
# skipped, and a path outside `scripts/` and `gov-infra/` was read as data whether
# the closure ran it or not. Every case below is a repro from the adversarial
# review of round 6 (head 527215dd) - R6-F1 and R6-F2 - plus a row per spelling the
# derivation reads and per spelling it refuses, which is the table the runbook
# states.
#
# A refused spelling no longer resolves to `None` and no longer stops there: it is
# a finding on its own. A name that resolves to nothing is a finding when the line
# it is written on runs it, a name that resolves outside the release-path roots is
# a finding unless it is pinned, and a name that resolves through a symbolic link
# is a finding because the bytes that execute are the linked bytes.
# ---------------------------------------------------------------------------

SELF_TEST_LINKS = []

SYMLINK_PROBE_LINK = "scripts/.release-workflows-self-test-link.sh"


def _attack_symlink_through_the_root(text):
    """A pinned gate that runs a symbolic link, in the tree, at a pinned file.

    A battery case mutates text; a symbolic link is not text, so this row writes a real link
    into the tree as a side effect of the mutation and the battery unlinks it when the case is
    done. The name is dot-prefixed so no glob in the tree reads it, and the case fails loudly
    rather than overwriting a link that is already there.
    """
    link = Path(SYMLINK_PROBE_LINK)
    if link.is_symlink() or link.exists():
        raise SystemExit(
            f"release-workflows: FAIL (self-test: {SYMLINK_PROBE_LINK} already exists, so the "
            f"symbolic-link row cannot write its link without overwriting the tree)"
        )
    link.symlink_to("verify-release-gates.sh")
    SELF_TEST_LINKS.append(link)
    return text.replace(GATES_BARE, GATES_BARE + f"bash {SYMLINK_PROBE_LINK}\n", 1)


ROUND_7_ATTACKS = (
    # R6-F1 - the unbraced variable directory. Rounds 1-6 stripped only `${VAR}/`, so
    # `$SCRIPT_DIR/` resolved to `None` and was skipped; the braced form was read.
    ("R6-F1 unbraced variable directory in a pinned gate", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + 'bash "$SCRIPT_DIR/new-helper.sh"\n', CLASS_CLOSURE),
    ("R6-F1 unbraced variable directory in a pinned workflow", ".github/workflows/ci.yml",
     CI_TAIL,
     CI_TAIL + '      - name: Unbraced variable probe\n        run: bash "$SCRIPT_DIR/new-helper.sh"\n',
     CLASS_CLOSURE),
    # R6-F1 - the quoted segment. The token the pattern sees is the `-helper.sh` tail, which
    # names no file, and the line runs it.
    ("R6-F1 quoted path segment in a pinned gate", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + 'bash scripts/"new"-helper.sh\n', CLASS_CLOSURE),
    # R6-F1 - `$GITHUB_WORKSPACE` at the release root.
    ("R6-F1 unbraced `$GITHUB_WORKSPACE` at the repository root", ".github/workflows/ci.yml",
     CI_TAIL,
     CI_TAIL + '      - name: Workspace probe\n        run: bash "$GITHUB_WORKSPACE/scripts/new-helper.sh"\n',
     CLASS_CLOSURE),
    # R6-F1 - the command substitution the three shared runtime-dependency libraries used
    # until this round, re-run against the admitted spelling they carry now.
    ("R6-F1 the command-substitution source spelling a shared library used",
     "scripts/lib/ts-runtime-deps.sh",
     'source "${_APPTHEORY_SCRIPTS_LIB_DIR}/runtime-deps.sh"\n',
     'source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime-deps.sh"\n',
     CLASS_CLOSURE),
    ("R6-F1 the command-substitution source spelling in the blocked-tool library",
     "scripts/lib/runtime-deps.sh",
     'source "${_APPTHEORY_SCRIPTS_LIB_DIR}/blocked.sh"\n',
     'source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/blocked.sh"\n',
     CLASS_CLOSURE),
    # The refused spellings that are refused on their own, with no line to run them: an
    # absolute path and a home directory.
    ("an absolute path in a pinned gate", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "# see /opt/evil/new-helper.sh for the details\n", CLASS_CLOSURE),
    ("a home directory path in a pinned gate", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "# see ~/evil-helper.sh for the details\n", CLASS_CLOSURE),
    # R6-F1 - `make -C`, which names `<dir>/Makefile`; the repro creates that makefile and
    # nothing pinned it.
    ("R6-F1 `make -C` against a makefile pinned by nothing", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "make -C scripts pwn\n", CLASS_CLOSURE),
    # R6-F2(a) - the two-hop re-entry: a name that resolves to nothing, run by a line.
    ("R6-F2 a pinned gate runs a helper that names no file", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "bash examples/evil-helper.sh\n", CLASS_CLOSURE),
    # R6-F2 - a real file outside the release-path roots, run by a line and pinned by nothing.
    # Round 8 changed the file this row names: the ts unit-test set is pinned now (round 8's
    # glob membership rule reads the set `verify-ts-tests.sh` runs), so `ts/test/*.test.mjs` is
    # no longer an unpinned name and the row moved to the built output, which is generated and
    # stays unpinned by design.
    ("R6-F2 a pinned gate runs an out-of-root file it does not pin",
     "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "node ts/dist/index.js\n", CLASS_CLOSURE),
    # R6-F2(c) - the live blind spot: a runner under `contract-tests/runners/` that the
    # closure executes and nothing pinned, beside the one this round pinned.
    ("R6-F2 an unpinned runner beside a pinned one", "scripts/verify-contract-tests.sh",
     "python3 contract-tests/runners/py/run.py\n",
     "python3 contract-tests/runners/py/run.py\npython3 contract-tests/runners/py/run_self_test.py\n",
     CLASS_CLOSURE),
    # R6-F2(b) - the symbolic link. A case mutates text and a link is not text, so this row
    # writes a real link into the tree and the battery unlinks it when it finishes.
    ("R6-F2 a pinned gate runs a symbolic link into a pinned file", "scripts/verify-release-gates.sh",
     GATES_BARE, _attack_symlink_through_the_root, CLASS_CLOSURE),
    # The executor family the derivation reads includes the two process-spawning module names a
    # pinned Python or Node tool uses, so a name that resolves to nothing on one of those lines
    # is a finding too and not a comment.
    ("a pinned tool spawns a name that resolves to nothing", "scripts/diagnose-release-state.sh",
     "import subprocess\n",
     'import subprocess\ncompleted = subprocess.run(["bash", "scripts/evil-helper.sh"], check=False)\n',
     CLASS_CLOSURE),
)


# ---------------------------------------------------------------------------
# Round 8: the extension boundary comes off, the reading becomes a reading of the
# command line, and the last two classifiers that were never read at all - a local
# action and a glob - become findings. Every case below is a repro from the
# adversarial review of round 7 (head cd3ee4e9), R7-F1 to R7-F7, plus the rows the
# new rules need in both directions.
#
# The hole rounds 1-7 left was the suffix list: `node scripts/evil-helper.js` and
# `perl scripts/evil.pl` were names no suffix list covered, so they were introduced
# with the documented two-place edit and then free to be edited forever, because
# nothing read them again. The executed-path rule reads the token a command runs,
# whatever its suffix, and the executor set is closed and enumerated (the runbook
# enumerates exactly it and the guard asserts that sentence).
# ---------------------------------------------------------------------------

SELF_TEST_PLANT = "examples/testkit/release-workflows-self-test-plant.mjs"


def _attack_planted_glob_member(text):
    """A pinned gate that runs a glob over a directory, with a file planted in it.

    A glob's matched set is a property of the tree, not of the text, so this row writes the
    file the glob picks up - the plant is unpinned, which is the whole point - and the battery
    removes it when the case is done, exactly as the symbolic-link row does.
    """
    plant = Path(SELF_TEST_PLANT)
    if plant.exists():
        raise SystemExit(
            f"release-workflows: FAIL (self-test: {SELF_TEST_PLANT} already exists, so the "
            f"planted-glob row cannot write its plant without overwriting the tree)"
        )
    plant.write_text("// planted by the release-workflows self-test\n", encoding="utf-8")
    SELF_TEST_LINKS.append(plant)
    return text.replace(
        GATES_BARE,
        GATES_BARE + 'for planted in examples/testkit/*.mjs; do node "${planted}"; done\n',
        1,
    )


def _attack_witness_in_a_comment(text):
    """The braced-variable witness moved into a comment, leaving a real line that writes another.

    Round 7's witness check read the file as text, so a comment that *mentioned* the spelling
    satisfied it. This is the swap the review described: the code that wrote the spelling is
    commented out and the file goes on writing a different, real, pinned library.
    """
    return text.replace(
        'source "${SCRIPT_DIR}/lib/ts-runtime-deps.sh"\n',
        '# source "${SCRIPT_DIR}/lib/ts-runtime-deps.sh"\nsource "${SCRIPT_DIR}/lib/blocked.sh"\n',
        1,
    )


ROUND_8_ATTACKS = (
    # R7-F1 - the live one. `.js`, `.pl` and every other suffix were outside the suffix list, so
    # the reference was never read: add the helper, update the pin, and the guard was green. The
    # executed-path rule reads the name the command runs whatever its suffix, and the same row
    # covers the extensionless case, which is what "whatever its suffix, including no extension"
    # has to mean for the rule to be a rule.
    ("R7-F1 a pinned gate runs an unpinned .js helper", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "node scripts/evil-helper.js\n", CLASS_CLOSURE),
    ("R7-F1 a pinned gate runs an unpinned .pl helper", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "perl scripts/evil.pl\n", CLASS_CLOSURE),
    ("R7-F1 a pinned gate runs an extensionless helper", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "bash scripts/evil-helper\n", CLASS_CLOSURE),
    # R7-F4 - the executor set was narrower than the runbook said it was, and `ruby`, `exec`
    # and the pipe form each named a file the guard never read.
    ("R7-F4 a pinned gate runs ruby against an unpinned helper", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "ruby scripts/new-helper.rb\n", CLASS_CLOSURE),
    ("R7-F4 a pinned gate execs an unpinned helper", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "exec scripts/new-helper2.sh\n", CLASS_CLOSURE),
    ("R7-F4 a pinned gate pipes a name into xargs bash", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "printf '%s\\n' scripts/existing-helper.sh | xargs bash\n",
     CLASS_CLOSURE),
    # R7-F4 - the `.` the runbook listed and the code did not implement.
    ("R7-F4 a pinned gate dot-sources an unpinned helper", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + ". scripts/new-helper3.sh\n", CLASS_CLOSURE),
    # The command itself. A path written as the command is the one executed position that is not
    # an executor's argument, and it is read whatever its suffix.
    ("R7-F1 a pinned gate runs a path as the command itself", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "./scripts/new-helper4.js\n", CLASS_CLOSURE),
    # R7-F1 - a suffix-free spelling behind a variable directory, which the read-or-run rule
    # does not read either (no suffix): the executed-path rule reads it, and the refused-spelling
    # branch refuses an unbraced variable at the same site.
    ("R7-F1 a pinned gate runs an unbraced variable directory helper",
     "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + 'bash "$SCRIPT_DIR/new-helper5.js"\n', CLASS_CLOSURE),
    # R7-F3 - the glob carve-out. `<executor> <glob>` and `for f in <glob>; do <executor> "$f"`.
    # The first case has no plant, so the glob matches nothing: a set that names no file is a set
    # nothing describes. The second writes the plant, and the matched set then holds a file no
    # pin covers - which is what the review's repro did.
    ("R7-F3 a pinned gate runs a glob that matches nothing", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "bash scripts/*/helper.sh\n", CLASS_CLOSURE),
    ("R7-F3 a pinned gate runs a glob the matched set of which holds a plant",
     "scripts/verify-release-gates.sh",
     GATES_BARE, _attack_planted_glob_member, CLASS_CLOSURE),
    # A glob written where a command that is not an executor would run it. The guard cannot say
    # what an unrecognized command does with what the glob expands to, so it refuses the pair.
    ("R7-F3 an unrecognized command runs a glob", "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "foobar scripts/*/helper.sh\n", CLASS_CLOSURE),
    # The up-walk spelling the witness table used to carry. Nothing in the tree writes it as a
    # path it resolves, so it is no longer an admitted *witnessed* spelling - but it is still a
    # spelling the guard *reads*, and this row is what proves that: `../` names a file outside
    # the referencing directory and the name must be pinned like any other.
    ("the dropped witness spelling is still read: an up-walk path to an unpinned file",
     "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "bash ../ts/dist/index.js\n", CLASS_CLOSURE),
    # R7-F2 - the local composite action. `uses: ./...` runs a directory in this repository that
    # no pin covers, and after the pull request that adds it the action's own files stay editable
    # with no pin edit at all. There is none in the tree; the rule refuses the spelling.
    ("R7-F2 a pinned workflow uses a local composite action", ".github/workflows/ci.yml",
     CI_TAIL, CI_TAIL + "      - uses: ./.github/actions/evil\n", CLASS_CLOSURE),
    # R7-F5 - a witness satisfied by a comment. The braced-variable witness is written in code
    # by `scripts/verify-testkit-examples.sh`; this row comments that line out and leaves the
    # text behind, which is exactly the swap the review made.
    ("R7-F5 the witness for an admitted spelling is written only in a comment",
     "scripts/verify-testkit-examples.sh",
     'source "${SCRIPT_DIR}/lib/ts-runtime-deps.sh"\n', _attack_witness_in_a_comment,
     CLASS_CLOSURE),
)


# ---------------------------------------------------------------------------
# Round 9: the carve-out is decided on the resolved path, npm and npx enter the closure, a bare
# name and an expansion are refused in an executed position, a heredoc body handed to an
# interpreter is read, and a witness must be a name the file runs rather than one it prints.
# Every case below is a reproduction from the adversarial review of round 8 (head 2f73bc19),
# R8-F1 to R8-F5 and the four disclosed residual bounds, each of which passed with the plant
# running and exit 0 before this round.
# ---------------------------------------------------------------------------

# A manifest planted in the tree. It is the file a `npm run` reads, and nothing pins it: the case
# that matters is a gate that gains the invocation while the script lives in a manifest no pin
# describes. It is written under a directory that already exists so the battery's cleanup - which
# unlinks files - leaves the tree as it found it.
SELF_TEST_MANIFEST_PLANT = "examples/testkit/package.json"


def _attack_planted_package_manifest(text):
    """A pinned gate that runs `npm run evil`, declared by a manifest nothing pins."""
    manifest = Path(SELF_TEST_MANIFEST_PLANT)
    if manifest.exists():
        raise SystemExit(
            f"release-workflows: FAIL (self-test: {SELF_TEST_MANIFEST_PLANT} already exists, so the "
            f"planted-manifest row cannot write its plant without overwriting the tree)"
        )
    manifest.write_text(
        '{\n  "name": "release-workflows-self-test-plant",\n  "private": true,\n'
        '  "scripts": {\n    "evil": "node scripts/evil-helper.js"\n  }\n}\n',
        encoding="utf-8",
    )
    SELF_TEST_LINKS.append(manifest)
    return text.replace(GATES_BARE, GATES_BARE + "npm run evil\n", 1)


def _attack_planted_module(text):
    """A pinned gate that runs `python3 -m <plant>`, with the module planted in the tree.

    A module resolves like a path here, so the row needs the file it resolves to: the module is the
    shape that ran past round 8 because `evilmod` is not a path and nothing resolved it.
    """
    plant = Path("release_workflows_self_test_plant.py")
    if plant.exists():
        raise SystemExit(
            "release-workflows: FAIL (self-test: the planted-module row's plant already exists)"
        )
    plant.write_text("# planted by the release-workflows self-test\n", encoding="utf-8")
    SELF_TEST_LINKS.append(plant)
    return text.replace(
        GATES_BARE, GATES_BARE + "python3 -m release_workflows_self_test_plant\n", 1
    )


def _attack_unignored_carve_out(text):
    """`.gitignore` with the `.venv/` rule removed, so the carve-out root is committable again."""
    return text.replace(".venv/\n", "", 1)


def _attack_planted_relative_walk(text):
    """A spelling that walks out of a dependency directory into a tracked path.

    `scripts/node_modules/../evil.js` reads as dependency code if the carve-out is decided on the
    spelling, and as `scripts/evil.js` once it is decided on the resolved path. The plant is the
    tracked file it resolves to.
    """
    plant = Path("scripts/release-workflows-self-test-walk.js")
    if plant.exists():
        raise SystemExit(
            "release-workflows: FAIL (self-test: the relative-walk row's plant already exists)"
        )
    plant.write_text("// planted by the release-workflows self-test\n", encoding="utf-8")
    SELF_TEST_LINKS.append(plant)
    return text.replace(
        GATES_BARE,
        GATES_BARE + "node scripts/node_modules/../release-workflows-self-test-walk.js\n",
        1,
    )


ROUND_9_ATTACKS = (
    # R8-F1 - the carve-out was decided on the spelling, so five spellings walked it. The first is
    # the one that matters: it resolves to a *tracked* file, and the walk is normalised before the
    # carve-out test, so the tracked file needs a pin.
    ("R8-F1 a node_modules walk out of the carve-out into a tracked path",
     "scripts/verify-release-gates.sh", GATES_BARE, _attack_planted_relative_walk, CLASS_CLOSURE),
    ("R8-F1 a `.tools` walk out of the carve-out into a tracked path",
     "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "node gov-infra/.tools/../release-workflows-self-test-plant.js\n",
     CLASS_CLOSURE),
    # R8-F1 - `venv/` and a `.venv/` outside `py/` were named as carve-outs while `.gitignore`
    # ignored neither. `venv/` is out of the carve-out entirely because nothing in this tree makes
    # one; `.venv/` is a root and `.gitignore` ignores it at any depth, which the row below proves.
    ("R8-F1 a bare `venv/` path is no longer a carve-out",
     "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "node venv/release-workflows-self-test-plant.js\n", CLASS_CLOSURE),
    ("R8-F1 a `scripts/venv/` path is no longer a carve-out",
     "scripts/verify-release-gates.sh",
     GATES_BARE, GATES_BARE + "node scripts/venv/release-workflows-self-test-plant.js\n",
     CLASS_CLOSURE),
    # The assertion behind the surviving `.venv/` carve-out: a root that stops being git-ignored
    # fails closed instead of being disclosed, which is what round 8 claimed in prose only.
    ("R8-F1 an un-ignored carve-out root", GITIGNORE_PATH,
     ".venv/\n", _attack_unignored_carve_out, CLASS_CLOSURE),
    # R8-F2 - npm and npx were not read at all, and a pinned gate runs `npm run build`.
    ("R8-F2 a pinned gate runs an npm script no pinned manifest declares",
     "scripts/verify-release-gates.sh", GATES_BARE, _attack_planted_package_manifest,
     CLASS_CLOSURE),
    ("R8-F2 a pinned gate runs npx against a binary no pinned lockfile provides",
     "scripts/verify-release-gates.sh", GATES_BARE, GATES_BARE + "npx release-workflows-evil\n",
     CLASS_CLOSURE),
    # R8-F2 - `python3 -m evilmod`, with an `evilmod.py` planted in the tree.
    ("R8-F2 a pinned gate runs a python module that resolves to a planted file",
     "scripts/verify-release-gates.sh", GATES_BARE, _attack_planted_module, CLASS_CLOSURE),
    # R8-F3 - the `find` operand is data and the executor after it was skipped.
    ("R8-F3 a find `-exec` runs a name the guard skipped after the search root",
     "scripts/verify-release-gates.sh", GATES_BARE,
     GATES_BARE + "find gov-infra -name data.txt -exec node gov-infra/release-workflows-self-test.js {} \\;\n",
     CLASS_CLOSURE),
    # R8-F4 - a brace expansion in an executed path.
    ("R8-F4 a pinned gate runs a brace expansion",
     "scripts/verify-release-gates.sh", GATES_BARE,
     GATES_BARE + "node scripts/{release-workflows-self-test,}/plant.js\n", CLASS_CLOSURE),
    # The four disclosed residual bounds of round 8, each of which ran a plant past a PASS.
    ("R8 bound a piped bare name (round 8 disclosed this as a limit)",
     "scripts/verify-release-gates.sh", GATES_BARE,
     GATES_BARE + "printf '%s\\n' release-workflows-self-test-plant.js | xargs bash\n",
     CLASS_CLOSURE),
    ("R8 bound a bare name run directly (round 8 disclosed this as a limit)",
     "scripts/verify-release-gates.sh", GATES_BARE,
     GATES_BARE + "node release-workflows-self-test-plant.js\n", CLASS_CLOSURE),
    ("R8 bound a variable-mediated glob (round 8 disclosed this as a limit)",
     "scripts/verify-release-gates.sh", GATES_BARE,
     GATES_BARE + 'files=(examples/testkit/*.mjs); node "${files[@]}"\n', CLASS_CLOSURE),
    ("R8 bound an executed path inside a heredoc body (round 8 disclosed this as a limit)",
     "scripts/verify-release-gates.sh", GATES_BARE,
     GATES_BARE + "python3 - <<'PY'\nnode gov-infra/release-workflows-self-test.py\nPY\n",
     CLASS_CLOSURE),
    # R8-F5 - the witness satisfied by a string. The real `source` line is replaced by an `echo`
    # that prints the spelling, so the file no longer runs what it once did.
    ("R8-F5 the witness for an admitted spelling is printed, not run",
     "scripts/verify-testkit-examples.sh",
     'source "${SCRIPT_DIR}/lib/ts-runtime-deps.sh"\n',
     'echo \'source "${SCRIPT_DIR}/lib/ts-runtime-deps.sh"\'\n', CLASS_CLOSURE),
)


SELF_TEST_ATTACKS = (
    ROUND_4_ATTACKS
    + ROUND_4_ACCEPTED_RECYCLED
    + ROUND_5_ATTACKS
    + ROUND_6_ATTACKS
    + ROUND_7_ATTACKS
    + ROUND_8_ATTACKS
    + ROUND_9_ATTACKS
)


# The spellings the derivation reads, each witnessed by a name the pinned tree itself writes.
# This is the accepted side of the spelling table: a spelling nothing in the tree writes is a
# spelling nothing tests, and a future edit that removes the last witness fails the battery
# rather than quietly shrinking what the derivation is asked to read.
#
# A witness is a *code* witness. Round 7 satisfied the up-walk row with the shellcheck directive
# at `gov-infra/verifiers/gov-verify-rubric.sh:33` - a comment about a spelling - while the code
# below it wrote the braced form; removing the comment failed the battery and putting the same
# text in front of a real line left it green, which is a witness for prose and not for code. The
# witness is now read out of the file with its comments stripped (and a trailing comment does not
# count either), and the up-walk spelling is gone from this table because nothing in the pinned
# tree writes it as a path it resolves: the two `../` occurrences that remain are `${SCRIPT_DIR}/../..`
# and a `[[ "${spec}" == ../* ]]` comparison, neither of which is a name the guard resolves. An
# admitted spelling nothing writes is surface, so it is dropped rather than witnessed by prose;
# the `../` *read* is kept, and the battery carries an attack row that proves it (a `../` path
# that resolves to no pinned file is refused).
ADMITTED_SPELLING_WITNESSES = (
    ("a plain path", "scripts/verify-release-workflows.sh"),
    ("a path behind a leading `./`", "./scripts/verify-release-pairing.sh"),
    ("a path behind a braced variable directory", "${SCRIPT_DIR}/lib/ts-runtime-deps.sh"),
)


def code_text(text):
    """The code of a file: comments removed, so a witness is a witness for code.

    A full-line comment in either the `#` or the `//` dialect is dropped, and so is the tail of
    a line from an unquoted `#`, which is the spelling both this tree's shell and its Python use.
    A string that *looks* like a path is still a string and this cannot tell it apart from code;
    what it does tell apart is prose about a spelling from a use of one, which is the direction
    the round-7 finding went.
    """
    lines = []
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("#") or stripped.startswith("//"):
            continue
        for index, character in enumerate(line):
            if character == "#" and (index == 0 or line[index - 1].isspace()):
                line = line[:index]
                break
        lines.append(line)
    return "\n".join(lines)


def spelling_witness_findings(read_text):
    """The admitted spellings, each proven by a pinned file that *runs* the token it writes.

    Round 7 satisfied this with a comment, and round 8 stripped comments but not strings:
    `echo 'source "${SCRIPT_DIR}/lib/ts-runtime-deps.sh"'` kept the row green while the line that
    ran the library was gone. A witness must now be written in the file's code *and* be a token the
    file's own executed-path reading yields - a name a command runs - so prose about a spelling, a
    string a file merely prints and a commented-out line are none of them a witness.
    """
    findings = []
    for spelling, token in ADMITTED_SPELLING_WITNESSES:
        witnessed = False
        for path in PINNED_FILE_DIGESTS:
            try:
                text = read_text(path)
            except (OSError, UnicodeDecodeError):
                continue
            if token not in code_text(text):
                continue
            resolved, through_link = resolve_reference(token, posixpath.dirname(path))
            if resolved is None or through_link:
                continue
            bodies = heredoc_bodies(text)
            for index, line in enumerate(text.split("\n"), 1):
                in_body = bodies.get(index)
                if in_body == HEREDOC_READ_DATA:
                    continue
                for _position, _command, found, _line in executed_path_references(
                    line, in_body=in_body is not None
                ):
                    if found == token:
                        witnessed = True
                        break
                if witnessed:
                    break
            if witnessed:
                break
        if not witnessed:
            findings.append(
                (
                    CLASS_CLOSURE,
                    f"the admitted spelling {spelling} is written by no pinned file as a name that file "
                    f"runs ({token!r} is the witness it is checked against), so nothing in the tree "
                    f"proves that spelling is admitted - a comment about a spelling and a string that "
                    f"prints one are not a use of it",
                )
            )
    return findings


def _accepted_makefile(source):
    source["Makefile"] = source["Makefile"].replace(
        "test: test-unit\n", "bash scripts/verify-release-workflows.sh\ntest: test-unit\n", 1
    )
    return source


def _accepted_new_workflow(source):
    source[".github/workflows/pages-preview.yml"] = (
        "name: Pages preview\n\non:\n  workflow_dispatch:\n\njobs:\n  preview:\n"
        "    runs-on: ubuntu-latest\n    steps:\n      - run: echo preview\n"
    )
    return source


def _accepted_new_job(source):
    source[".github/workflows/pages.yml"] = source[".github/workflows/pages.yml"] + (
        "\n  preview:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preview\n"
    )
    return source


def _accepted_guard_own_file(source):
    source[GUARD_PATH] = source[GUARD_PATH].replace(
        "GUARDED_BASENAMES = ", "GUARDED_BASENAMES = ()  # tampered\n", 1
    )
    return source


# The shapes that must stay accepted, so a construction that over-blocks fails the self-test
# as loudly as one that starts missing. Every admitted shape is additive: it adds a workflow,
# adds a job to a file no pin covers, or repeats a pinned invocation line. None of them can
# change a byte of a pinned file, and none can stop a pinned step from running. One entry is
# the disclosure - this guard is read by nothing here - and the battery asserts that boundary
# rather than leaving it claimed in prose only.
SELF_TEST_ACCEPTED = (
    (
        "a byte-identical pinned invocation line added to the Makefile",
        _accepted_makefile,
    ),
    (
        "a new unguarded workflow added under .github/workflows",
        _accepted_new_workflow,
    ),
    (
        "a new unguarded job added to an unpinned workflow",
        _accepted_new_job,
    ),
    (
        "the disclosed boundary: the guard's own file is read by nothing",
        _accepted_guard_own_file,
    ),
)


# The accepted shapes that are *edits to a pinned file*, which is the two-place edit the whole
# construction is built around: the file changes and its digest changes with it, in the same
# commit. The harness applies the digest update to the fixture, so a row here proves that the
# new content is accepted on its merits rather than masked by a digest finding. Each of these
# is the accepted mirror of a rule above, and a construction that refuses them over-blocks.
def _accepted_dependency_path(source):
    source["scripts/verify-release-gates.sh"] = source["scripts/verify-release-gates.sh"].replace(
        GATES_BARE,
        GATES_BARE
        + "node node_modules/release-please/build/src/bin/release-please.js\n",
        1,
    )
    return source


def _accepted_matched_glob(source):
    source["scripts/verify-release-gates.sh"] = source["scripts/verify-release-gates.sh"].replace(
        GATES_BARE, GATES_BARE + "node examples/testkit/*.mjs\n", 1
    )
    return source


def _accepted_command_lookup(source):
    """`command -v <name>` is a lookup, not a run: the operand is a name to look for.

    Six pinned lines write it, and the executed-path rule does not read the operand there. A
    construction that refused it would over-block on all six, so the bound is exercised instead of
    implied.
    """
    source["scripts/verify-release-gates.sh"] = source["scripts/verify-release-gates.sh"].replace(
        GATES_BARE, GATES_BARE + "command -v node >/dev/null 2>&1 || true\n", 1
    )
    return source


def _accepted_data_body(source):
    """A heredoc body handed to a command that runs nothing is data, not a command line.

    `cat <<'EOF'` writes its body to a file or to stdout; the body is read by the read-or-run rule
    (a script-shaped name in it must still be pinned) but not at command position, because a line of
    another format is not a command this construction knows. The tree's PR-body template is the
    measured case: `Release/security gates` is a line of a `cat <<'EOF'` body, and reading it as a
    command produced a false finding on a pinned line.
    """
    source["scripts/verify-release-gates.sh"] = source["scripts/verify-release-gates.sh"].replace(
        GATES_BARE,
        GATES_BARE + "cat <<'EOF'\nRelease/security gates\nnode scripts/a-name-that-is-not-a-file.js\nEOF\n",
        1,
    )
    return source


SELF_TEST_ACCEPTED_PINNED = (
    (
        "a pinned gate runs a node_modules dependency path (the declared carve-out)",
        "scripts/verify-release-gates.sh",
        _accepted_dependency_path,
    ),
    (
        "a pinned gate runs a glob whose matched set is pinned",
        "scripts/verify-release-gates.sh",
        _accepted_matched_glob,
    ),
    (
        "a pinned gate looks a tool up with `command -v` (the executed position that runs nothing)",
        "scripts/verify-release-gates.sh",
        _accepted_command_lookup,
    ),
    (
        "a pinned gate writes a heredoc body to a file (a body no command runs)",
        "scripts/verify-release-gates.sh",
        _accepted_data_body,
    ),
)


def fixture_paths():
    paths = set(sweep_paths())
    paths.update(PINNED_FILE_DIGESTS)
    paths.add(GUARD_PATH)
    paths.add(GITIGNORE_PATH)
    return tuple(sorted(paths))


def release_self_test_links() -> None:
    """Remove every file a battery case wrote, so the battery leaves the tree as it found it.

    A link and a planted file are not text, so the two rows that need one write it into the tree
    and register it here; the battery calls this after every case and again in its `finally`.
    """
    while SELF_TEST_LINKS:
        written = SELF_TEST_LINKS.pop()
        try:
            written.unlink()
        except FileNotFoundError:
            pass


def run_self_test() -> None:
    fixture = {path: read_source(path) for path in fixture_paths()}
    base_sweep = sweep_paths()

    def read_from(source):
        def read_text(path):
            if path not in source:
                raise SystemExit(
                    f"release-workflows: FAIL (self-test read {path!r} outside the fixture set)"
                )
            return source[path]

        return read_text

    def sweep_for(source):
        # The sweep set the real run would use, plus any file an accepted case adds. The
        # guard's own file is in the fixture but is never swept, exactly as in the real run.
        return tuple(sorted(set(base_sweep) | (set(source) - set(fixture))))

    try:
        baseline = guarded_surface_findings(read_from(fixture), sweep=sweep_for(fixture))
        if baseline:
            raise SystemExit(
                "release-workflows: FAIL (self-test: the legitimate guarded wiring was REJECTED, so the "
                "guard over-blocks: " + "; ".join(message for _kind, message in baseline)
            )
        print("release-workflows: PASS-PROOF (self-test accepted: the legitimate guarded wiring at HEAD)")

        for label, path, anchor, replacement, expected in SELF_TEST_ATTACKS:
            source = dict(fixture)
            if anchor not in source[path]:
                raise SystemExit(
                    f"release-workflows: FAIL (self-test fixture drifted: the {label!r} anchor is missing "
                    f"from {path})"
                )
            mutated = (
                replacement(source[path])
                if callable(replacement)
                else source[path].replace(anchor, replacement, 1)
            )
            if mutated == source[path]:
                raise SystemExit(
                    f"release-workflows: FAIL (self-test fixture drifted: the {label!r} mutation changed "
                    f"nothing in {path})"
                )
            source[path] = mutated
            findings = guarded_surface_findings(read_from(source), sweep=sweep_for(source))
            release_self_test_links()
            if not findings:
                raise SystemExit(
                    f"release-workflows: FAIL (self-test MISSED the {label!r} weakening in {path})"
                )
            kinds = {kind for kind, _message in findings}
            if expected not in kinds:
                joined = " | ".join(f"{kind}: {message}" for kind, message in findings)
                raise SystemExit(
                    f"release-workflows: FAIL (self-test caught the {label!r} weakening but reported an "
                    f"unexpected diagnostic; expected {expected!r} in {joined!r})"
                )
            print(f"release-workflows: FAIL-PROOF (self-test rejected: {label} in {path} -> {expected})")

        for label, mutate in SELF_TEST_ACCEPTED:
            source = mutate(dict(fixture))
            if source == fixture:
                raise SystemExit(
                    f"release-workflows: FAIL (self-test fixture drifted: the {label!r} mutation changed "
                    f"nothing)"
                )
            findings = guarded_surface_findings(read_from(source), sweep=sweep_for(source))
            release_self_test_links()
            if findings:
                raise SystemExit(
                    f"release-workflows: FAIL (self-test OVER-BLOCKS the accepted shape {label!r}: "
                    + "; ".join(message for _kind, message in findings)
                )
            print(f"release-workflows: ACCEPT-PROOF (self-test accepted: {label})")

        for label, path, mutate in SELF_TEST_ACCEPTED_PINNED:
            source = mutate(dict(fixture))
            if source == fixture:
                raise SystemExit(
                    f"release-workflows: FAIL (self-test fixture drifted: the {label!r} mutation changed "
                    f"nothing)"
                )
            original = dict(PINNED_FILE_DIGESTS)
            PINNED_FILE_DIGESTS[path] = digest_of(source[path])
            try:
                findings = guarded_surface_findings(read_from(source), sweep=sweep_for(source))
            finally:
                PINNED_FILE_DIGESTS.clear()
                PINNED_FILE_DIGESTS.update(original)
            release_self_test_links()
            if findings:
                raise SystemExit(
                    f"release-workflows: FAIL (self-test OVER-BLOCKS the accepted change {label!r}, whose "
                    f"pin update is applied with it: " + "; ".join(message for _kind, message in findings)
                )
            print(f"release-workflows: ACCEPT-PROOF (self-test accepted: {label})")
    finally:
        release_self_test_links()

    print(
        f"release-workflows: PASS (self-test: {len(SELF_TEST_ATTACKS)} weakening shape(s) failed closed, "
        f"{len(SELF_TEST_ACCEPTED)} fail-closed spelling(s) accepted, "
        f"{len(SELF_TEST_ACCEPTED_PINNED)} accepted pinned-file change(s), the legitimate wiring accepted)"
    )


if MODE == "self-test":
    run_self_test()
    raise SystemExit(0)

# The runbook states the counts and the mechanisms in prose: the two battery counts, the size
# of the pinned closure, the spellings the derivation reads and the spellings it refuses, the
# Makefile sentence and the disclosure. Reflowed line breaks are normal in Markdown and are not
# drift, so the document is compared with its whitespace collapsed; every number is read out of
# the artifact that produces it, never restated.
_doc_text = " ".join(Path("docs/release-process.md").read_text(encoding="utf-8").split())
_executor_sentence = (
    "The executor spellings are "
    + ", ".join(f"`{name}`" for name in EXECUTOR_NAMES[:-1])
    + f" and `{EXECUTOR_NAMES[-1]}`"
)
for _doc_claim in (
    f"{len(SELF_TEST_ATTACKS)} weakening shapes fail closed and "
    f"{len(SELF_TEST_ACCEPTED)} fail-closed spellings are accepted, and "
    f"{len(SELF_TEST_ACCEPTED_PINNED)} accepted pinned-file changes are admitted with the pin update",
    f"the transitive closure of the script paths they name: "
    f"{len(RELEASE_PATH_FILE_DIGESTS)} files under `scripts/` and `gov-infra/`, and "
    f"{len(OUT_OF_ROOT_FILE_DIGESTS)} files outside them",
    f"{len(RELEASE_PATH_FILE_DIGESTS) + len(OUT_OF_ROOT_FILE_DIGESTS)} files in the closure and "
    f"{len(WORKFLOW_FILE_DIGESTS)} workflows",
    _executor_sentence,
    "There is no call site of a guarded script",
    "are refused rather than skipped",
    "is refused with the other refused spellings",
    "`make -C <dir>` and `make -f <file>` name the makefile the selector reads",
    "A glob in a running position is now a finding unless the pins describe the set it matches",
    "A `uses:` that names a local path (`./.github/actions/...`) is refused outright, in a pinned "
    "workflow",
    "is **dependency or tool code**",
    "A witness is an *executed* witness",
    "has **no call site today**",
    "Any weakening of this file is caught by review and by nothing else",
    # Round 9's rules, each a sentence the artifact must keep true: the carve-out decided on the
    # resolved path, the ignores read as an assertion, the manifest pins, the body read as what it
    # is, the three refused spellings and the `find` action the reading resumes at.
    "It is decided on the **resolved path** now",
    "the guard reads `.gitignore` and fails closed unless every approved dependency root is ignored",
    "every package manifest and lockfile in this repository",
    "a body handed to another interpreter",
    "A **bare name**",
    "A **brace expansion**",
    "the reading resumes there",
    "`npm run <name>` must be declared by a pinned manifest",
):
    if _doc_claim not in _doc_text:
        raise SystemExit(
            "release-workflows: FAIL (docs/release-process.md must state what the pins actually cover - "
            "the battery counts, the size of the closure, the spellings the derivation reads and "
            "refuses, the executor set, the executed-path rule, the glob rule, the local-action rule, "
            "the dependency carve-out, the Makefile boundary and the disclosure - so a documented claim "
            f"cannot drift from the artifact behind it; missing {_doc_claim!r})"
        )

guarded_surface = guarded_surface_findings(read_source)
if guarded_surface:
    raise SystemExit(
        "release-workflows: FAIL (a guarded release-gate region is not its pinned revision; "
        + "; ".join(message for _kind, message in guarded_surface) + ")"
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
