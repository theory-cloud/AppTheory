package main

import (
	"strings"
	"testing"
)

func violationsFor(text string) []installViolation {
	state := &installScanState{}
	scanShellText(text, 1, func(command shellCommand) { state.checkCommand("scripts/probe.sh", command) })
	return state.violations
}

func assertFlagged(t *testing.T, text, label string) {
	t.Helper()
	violations := violationsFor(text)
	if len(violations) == 0 {
		t.Fatalf("%s: guard must fail closed on %q", label, text)
	}
}

func assertClean(t *testing.T, text, label string) {
	t.Helper()
	violations := violationsFor(text)
	if len(violations) > 0 {
		t.Fatalf("%s: guard must accept %q, got: %v", label, text, violations)
	}
}

func TestInstallHygieneRejectsReproducedBypasses(t *testing.T) {
	cases := map[string]string{
		"flag hidden in a trailing comment":        "npm ci # --ignore-scripts",
		"subshell install with a masked flag":      "(cd ts && npm ci >/dev/null) # --ignore-scripts",
		"bash -c payload with a masked flag":       "bash -c 'cd ts && npm ci --no-audit >/dev/null' # --ignore-scripts",
		"sh -c payload with a masked flag":         "sh -c 'npm ci' # --ignore-scripts",
		"command substitution with a masked flag":  "x=\"$(cd ts && npm ci)\" # --ignore-scripts",
		"explicitly re-enabled scripts":            "npm ci --ignore-scripts=false",
		"non-true scripts value":                   "npm ci --ignore-scripts=0",
		"negated scripts flag":                     "npm ci --no-ignore-scripts",
		"second unprotected install on the line":   "npm ci --ignore-scripts && npm ci",
		"bare npm ci":                              "npm ci",
		"bare npm install":                         "npm install",
		"npx-prefixed install":                     "npx npm ci",
		"indirect shell heredoc":                   "bash <<'EOF'\nnpm ci\nEOF",
		"make recipe":                              "\t@(cd ts && npm ci)",
		"make shell function":                      "X := $(shell npm ci)",
		"hardened heredoc shell with bare install": "sh <<'EOF'\n(cd cdk && npm ci)\nEOF",
	}
	for label, text := range cases {
		assertFlagged(t, text, label)
	}
}

func TestInstallHygieneAcceptsHardenedForms(t *testing.T) {
	cases := map[string]string{
		"direct":                            "(cd ts && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)",
		"trailing comment":                  "npm ci --ignore-scripts # ok",
		"bash -c payload":                   "bash -c 'cd ts && npm ci --ignore-scripts --no-audit >/dev/null'",
		"command substitution":              "stamp=\"$(npm ci --ignore-scripts >/dev/null)\"",
		"double quoted flag":                "npm ci \"--ignore-scripts\"",
		"explicit true value":               "npm ci --ignore-scripts=true",
		"message emitting line":             "echo \"cdk-synth: FAIL (run 'cd cdk && npm ci')\"",
		"immutable non-lockfile":            "npm install --ignore-scripts --prefix \"${p}\" release-please@17.1.3",
		"tarball install":                   "npm i --ignore-scripts ./theory-cloud-apptheory-1.0.0.tgz",
		"pnpm with immutable spec":          "pnpm add --ignore-scripts pkg@1.2.3",
		"heredoc documentation body":        "cat <<'DOC'\n- `npm i ./apptheory.tgz`\nDOC",
		"python heredoc mentioning install": "python3 <<'PY'\nfail(\"(npm install would fail ERESOLVE)\")\nPY",
		"make shell function hardened":      "X := $(shell npm ci --ignore-scripts)",
	}
	for label, text := range cases {
		assertClean(t, text, label)
	}
}

func TestInstallHygieneRejectsNonScalarRun(t *testing.T) {
	state := &installScanState{}
	err := state.scanWorkflowYAML(".github/workflows/probe.yml", "jobs:\n  probe:\n    steps:\n      - run:\n          - npm ci\n")
	if err != nil {
		t.Fatalf("scanWorkflowYAML: %v", err)
	}
	if len(state.violations) == 0 {
		t.Fatal("a non-scalar run: value must fail closed")
	}
}

func TestHasIgnoreScriptsTrue(t *testing.T) {
	if !hasIgnoreScriptsTrue([]string{"--no-audit", "--ignore-scripts"}) {
		t.Fatal("bare --ignore-scripts must count")
	}
	if !hasIgnoreScriptsTrue([]string{"--ignore-scripts=true"}) {
		t.Fatal("--ignore-scripts=true must count")
	}
	for _, flags := range [][]string{{"--ignore-scripts=false"}, {"--ignore-scripts=0"}, {"--no-ignore-scripts"}, {}} {
		if hasIgnoreScriptsTrue(flags) {
			t.Fatalf("flags %v must not count as disabling scripts", flags)
		}
	}
}

func TestUnwrapCommand(t *testing.T) {
	cases := []struct {
		words []string
		want  string
	}{
		{[]string{"npm", "ci"}, "npm"},
		{[]string{"sudo", "-E", "npm", "ci"}, "npm"},
		{[]string{"env", "CI=1", "npm", "ci"}, "npm"},
		{[]string{"FOO=bar", "npm", "ci"}, "npm"},
		{[]string{"/usr/local/bin/npm", "ci"}, "npm"},
	}
	for _, testCase := range cases {
		words := unwrapCommand(testCase.words)
		name := commandBase(words[0])
		if !strings.EqualFold(name, testCase.want) {
			t.Fatalf("unwrapCommand(%v) -> %q, want %q", testCase.words, name, testCase.want)
		}
	}
}
