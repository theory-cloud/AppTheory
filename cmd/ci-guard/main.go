// Command ci-guard enforces AppTheory's CI wiring and package-install hygiene
// invariants by parsing the underlying files with real parsers instead of
// matching lines of text.
//
// Subcommands:
//
//	workflow-triggers --workflow <path> [--root <dir>]
//	    Parse the workflow YAML, classify every job by its effective triggers
//	    (workflow `on:` x job `if:`), and fail closed on any wiring the
//	    classifier does not model explicitly.
//
//	install-hygiene --root <dir>
//	    Read repository-relative surface paths (one per line) on stdin and fail
//	    closed on any package install that leaves lifecycle scripts enabled.
//
//	lockfile-config --root <dir>
//	    Read repository-relative lockfile paths (one per line) on stdin and fail
//	    closed when a lockfile directory is missing the package-manager config
//	    that disables lifecycle scripts, or sets scripts back on.
//
// Exit codes: 0 PASS, 1 FAIL, 2 BLOCKED.
package main

import (
	"fmt"
	"io"
	"os"
)

const (
	exitPass    = 0
	exitFail    = 1
	exitBlocked = 2
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		writeString(stderr, "ci-guard: missing subcommand (workflow-triggers|install-hygiene)\n")
		return exitBlocked
	}
	switch args[0] {
	case "workflow-triggers":
		return runWorkflowTriggers(args[1:], stdout, stderr)
	case "install-hygiene":
		return runInstallHygiene(args[1:], stdin, stdout, stderr)
	case "lockfile-config":
		return runLockfileConfig(args[1:], stdin, stdout, stderr)
	default:
		writeString(stderr, fmt.Sprintf("ci-guard: unknown subcommand %q\n", args[0]))
		return exitBlocked
	}
}

// writeString writes one line to a guard output stream. A failed write to
// stdout or stderr is not actionable for a guard, so the error is dropped
// deliberately rather than logged into the stream that just failed.
func writeString(w io.Writer, text string) {
	if _, err := io.WriteString(w, text); err != nil {
		return
	}
}
