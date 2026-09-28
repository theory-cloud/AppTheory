package main

import (
	"os"
	"path/filepath"
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

// TestInstallHygieneRejectsLauncherBypasses covers the launcher spellings the
// round-1 review reproduced (SAN-AT1073-R1-F1 / ADV-1073-R1-02): each one ran a
// scripts-enabled install while the scanner reported zero violations.
func TestInstallHygieneRejectsLauncherBypasses(t *testing.T) {
	cases := map[string]string{
		"npx -y short flag":                "npx -y npm ci",
		"npx --yes with pinned version":    "npx --yes npm@10.9.0 ci",
		"npx with pinned version":          "npx npm@10.9.0 ci",
		"npx --package value then install": "npx --package npm npm ci",
		"pnpm dlx install":                 "pnpm dlx npm ci",
		"pnpm dlx with flag":               "pnpm dlx -y npm ci",
		"corepack npm":                     "corepack npm ci",
		"corepack pnpm":                    "corepack pnpm install",
		"corepack with pinned version":     "corepack npm@10 ci",
		"bash flags before -c":             "bash -eu -c 'npm ci'",
		"sh flags before -c":               "sh -e -c 'cd ts && npm ci'",
		"bash clustered flags before -c":   "bash -euc 'npm ci'",
		"variable command":                 "NPM=npm; $NPM ci",
		"braced variable command":          "NPM=npm; ${NPM} ci",
		"variable holding the whole line":  "CMD='npm ci'; $CMD",
		"env with assignment":              "env NPM=npm $NPM ci",
		"xargs launcher":                   "xargs npm ci",
		"xargs with a flag":                "xargs -0 npm ci",
		"sudo flag with a value":           "sudo -u root npm ci",
		"nice flag with a value":           "nice -n 10 npm ci",
		"env unset flag with a value":      "env -u FOO npm ci",
		"eval launcher":                    "eval npm ci",
		"if keyword":                       "if npm ci; then :; fi",
		"while keyword":                    "while npm ci; do :; done",
		"negation keyword":                 "! npm ci",
		"heredoc piped to bash":            "cat <<'EOF' | bash\nnpm ci\nEOF",
		"heredoc piped to sh":              "cat <<EOF | sh\nnpm install\nEOF",
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

// TestInstallHygieneAcceptsLauncherControls keeps the launcher unwrapping from
// becoming a blanket failure: a launcher that runs something other than a
// package manager, and a dynamically built command that cannot be resolved,
// must stay clean.
func TestInstallHygieneAcceptsLauncherControls(t *testing.T) {
	cases := map[string]string{
		"npx of another tool":             "npx jsii-pacmak -t go --code-only -o dist/go --force",
		"npx of the cdk cli":              "npx cdk synth --quiet --no-notices",
		"npx --yes of another tool":       "npx --yes jsii-pacmak -t python",
		"corepack enabling a manager":     "corepack enable",
		"corepack pinned use":             "corepack use pnpm@9",
		"xargs running another tool":      "xargs grep -n needle",
		"unresolved variable command":     "eval \"${cmd}\"",
		"unresolved variable with args":   "runner=; $runner deploy",
		"data heredoc through a pipeline": "cat <<'DOC' | tee out.txt\nnpm ci\nDOC",
		"if running another tool":         "if npm run build; then :; fi",
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

func TestLaunchTarget(t *testing.T) {
	cases := []struct {
		words []string
		flags map[string]bool
		want  string
	}{
		{[]string{"npm", "ci"}, nil, "npm"},
		{[]string{"-y", "npm", "ci"}, nil, "npm"},
		{[]string{"--yes", "npm@10.9.0", "ci"}, nil, "npm"},
		{[]string{"--package", "npm", "npm", "ci"}, npxValueFlags, "npm"},
		{[]string{"-0", "npm", "ci"}, xargsValueFlags, "npm"},
		{[]string{"-I", "{}", "npm", "ci"}, xargsValueFlags, "npm"},
		{[]string{"jsii-pacmak", "-t", "go"}, nil, "jsii-pacmak"},
		{[]string{"--version"}, nil, ""},
	}
	for _, testCase := range cases {
		target := launchTarget(testCase.words, testCase.flags)
		got := ""
		if len(target) > 0 {
			got = target[0]
		}
		if got != testCase.want {
			t.Fatalf("launchTarget(%v) -> %q, want %q", testCase.words, got, testCase.want)
		}
	}
}

func TestStripPackageVersion(t *testing.T) {
	cases := map[string]string{
		"npm@10.9.0":       "npm",
		"@scope/pkg@1.2.3": "@scope/pkg",
		"@scope/pkg":       "@scope/pkg",
		"jsii-pacmak":      "jsii-pacmak",
		"./local/npm":      "./local/npm",
		"npm":              "npm",
	}
	for spec, want := range cases {
		if got := stripPackageVersion(spec); got != want {
			t.Fatalf("stripPackageVersion(%q) = %q, want %q", spec, got, want)
		}
	}
}

func TestVariableReference(t *testing.T) {
	if name, ok := variableReference("${NPM}"); !ok || name != "NPM" {
		t.Fatalf("braced reference not modeled: %q %v", name, ok)
	}
	if name, ok := variableReference("$npm_bin"); !ok || name != "npm_bin" {
		t.Fatalf("plain reference not modeled: %q %v", name, ok)
	}
	for _, word := range []string{"npm", "$1", "${}", "$(npm)", "$a-b"} {
		if _, ok := variableReference(word); ok {
			t.Fatalf("%q must not read as a variable reference", word)
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
		words, _ := unwrapCommand(testCase.words)
		name := commandBase(words[0])
		if !strings.EqualFold(name, testCase.want) {
			t.Fatalf("unwrapCommand(%v) -> %q, want %q", testCase.words, name, testCase.want)
		}
	}
}

func TestUnwrapCommandCapturesAssignments(t *testing.T) {
	words, assignments := unwrapCommand([]string{"env", "NPM=npm", "$NPM", "ci"})
	if words[0] != "$NPM" {
		t.Fatalf("unwrapCommand head = %q, want $NPM", words[0])
	}
	if assignments["NPM"] != "npm" {
		t.Fatalf("unwrapCommand assignments = %v, want NPM=npm", assignments)
	}
}

func TestCheckLockfileDir(t *testing.T) {
	cases := []struct {
		label   string
		rel     string
		manager lockfileManager
		files   map[string]string
		want    string
	}{
		{
			label:   "npm lockfile with ignore-scripts",
			rel:     "ts/package-lock.json",
			manager: managerNPM,
			files:   map[string]string{"ts/.npmrc": "ignore-scripts=true\n"},
		},
		{
			label:   "npm lockfile with spacing and quotes",
			rel:     "cdk/package-lock.json",
			manager: managerNPM,
			files:   map[string]string{"cdk/.npmrc": "ignore-scripts = \"true\"\n; other = 1\n"},
		},
		{
			label:   "npm lockfile with a bare key",
			rel:     "cdk/package-lock.json",
			manager: managerNPM,
			files:   map[string]string{"cdk/.npmrc": "ignore-scripts\n"},
		},
		{
			label:   "npm lockfile without config",
			rel:     "ts/package-lock.json",
			manager: managerNPM,
			want:    "missing",
		},
		{
			label:   "npm lockfile turning scripts back on",
			rel:     "ts/package-lock.json",
			manager: managerNPM,
			files:   map[string]string{"ts/.npmrc": "ignore-scripts=true\nignore-scripts=false\n"},
			want:    "must stay disabled",
		},
		{
			label:   "pnpm lockfile with ignore-scripts",
			rel:     "app/pnpm-lock.yaml",
			manager: managerPNPM,
			files:   map[string]string{"app/.npmrc": "ignore-scripts=true\n"},
		},
		{
			label:   "pnpm lockfile without config",
			rel:     "app/pnpm-lock.yaml",
			manager: managerPNPM,
			want:    "missing",
		},
		{
			label:   "yarn berry with enableScripts false",
			rel:     "app/yarn.lock",
			manager: managerYarn,
			files:   map[string]string{"app/.yarnrc.yml": "nodeLinker: node-modules\nenableScripts: false\n"},
		},
		{
			label:   "yarn berry with enableScripts true",
			rel:     "app/yarn.lock",
			manager: managerYarn,
			files:   map[string]string{"app/.yarnrc.yml": "enableScripts: true\n"},
			want:    "enableScripts",
		},
		{
			label:   "yarn berry without enableScripts",
			rel:     "app/yarn.lock",
			manager: managerYarn,
			files:   map[string]string{"app/.yarnrc.yml": "nodeLinker: node-modules\n"},
			want:    "enableScripts",
		},
		{
			label:   "yarn classic via npmrc",
			rel:     "app/yarn.lock",
			manager: managerYarn,
			files:   map[string]string{"app/.npmrc": "ignore-scripts=true\n"},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.label, func(t *testing.T) {
			root := t.TempDir()
			for rel, content := range testCase.files {
				path := filepath.Join(root, filepath.FromSlash(rel))
				if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
					t.Fatalf("mkdir: %v", err)
				}
				if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
					t.Fatalf("write %s: %v", rel, err)
				}
			}
			failure := checkLockfileDir(root, testCase.rel, testCase.manager)
			if testCase.want == "" && failure != "" {
				t.Fatalf("checkLockfileDir = %q, want no failure", failure)
			}
			if testCase.want != "" && !strings.Contains(failure, testCase.want) {
				t.Fatalf("checkLockfileDir = %q, want it to mention %q", failure, testCase.want)
			}
		})
	}
}

func TestNPMIgnoreScriptsLastAssignmentWins(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, ".npmrc")
	if err := os.WriteFile(path, []byte("ignore-scripts=false\n# comment\nignore-scripts=true\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	value, found, err := npmIgnoreScripts(path)
	if err != nil {
		t.Fatalf("npmIgnoreScripts: %v", err)
	}
	if !found || !isTrueValue(value) {
		t.Fatalf("npmIgnoreScripts = %q found=%v, want a true value", value, found)
	}
}
