package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// Lockfile config hardening (R-G3): lifecycle scripts must be structurally
// impossible, not merely detected. A package manager reads its own config from
// the directory that holds the lockfile, so each lockfile directory must carry
// the config that disables install scripts. The tokenizer in install-hygiene
// stays as a second line of defense.
const (
	npmrcName     = ".npmrc"
	yarnrcName    = ".yarnrc.yml"
	ignoreScripts = "ignore-scripts"
	enableScripts = "enableScripts"
)

type lockfileManager int

const (
	managerNPM lockfileManager = iota
	managerPNPM
	managerYarn
)

var lockfileManagers = map[string]lockfileManager{
	"package-lock.json":   managerNPM,
	"npm-shrinkwrap.json": managerNPM,
	"pnpm-lock.yaml":      managerPNPM,
	"yarn.lock":           managerYarn,
}

func runLockfileConfig(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("lockfile-config", flag.ContinueOnError)
	flags.SetOutput(stderr)
	root := flags.String("root", ".", "repository root")
	if err := flags.Parse(args); err != nil {
		return exitBlocked
	}

	lockfiles, err := readSurfacePaths(stdin)
	if err != nil {
		writeString(stderr, fmt.Sprintf("npm-install-hygiene: BLOCKED (%v)\n", err))
		return exitBlocked
	}
	if len(lockfiles) == 0 {
		writeString(stderr, "npm-install-hygiene: BLOCKED (no lockfiles on stdin)\n")
		return exitBlocked
	}

	var failures []string
	for _, rel := range lockfiles {
		manager, ok := lockfileManagers[path.Base(rel)]
		if !ok {
			failures = append(failures, fmt.Sprintf("%s: lockfile name is not modeled by the scripts-disabled check", rel))
			continue
		}
		if failure := checkLockfileDir(*root, rel, manager); failure != "" {
			failures = append(failures, failure)
		}
	}

	if len(failures) > 0 {
		writeString(stderr, fmt.Sprintf("npm-install-hygiene: FAIL (%d lockfile directory/-ies do not disable lifecycle scripts)\n", len(failures)))
		for _, failure := range failures {
			writeString(stderr, fmt.Sprintf("  %s\n", failure))
		}
		return exitFail
	}
	writeString(stdout, fmt.Sprintf("npm-install-hygiene: PASS (%d lockfile directories disable lifecycle scripts structurally)\n", len(lockfiles)))
	return exitPass
}

func checkLockfileDir(root, rel string, manager lockfileManager) string {
	dir := path.Dir(rel)
	if dir == "." {
		dir = ""
	}
	configRel := path.Join(dir, npmrcName)
	configPath := filepath.Join(root, filepath.FromSlash(configRel))

	// Yarn Berry reads .yarnrc.yml and ignores npm's ignore-scripts, so a Berry
	// install needs `enableScripts: false` there. Yarn Classic reads .npmrc,
	// which the shared check below covers.
	if manager == managerYarn {
		yarnrcRel := path.Join(dir, yarnrcName)
		yarnrcPath := filepath.Join(root, filepath.FromSlash(yarnrcRel))
		if fileExists(yarnrcPath) {
			return checkYarnConfig(rel, yarnrcRel, yarnrcPath)
		}
	}

	value, found, err := npmIgnoreScripts(configPath)
	if err != nil {
		return fmt.Sprintf("%s: cannot read %s: %v", rel, configRel, err)
	}
	if !found {
		return fmt.Sprintf("%s: missing %s disabling lifecycle scripts (expected `ignore-scripts=true`)", rel, configRel)
	}
	if !isTrueValue(value) {
		return fmt.Sprintf("%s: %s sets `%s=%s`; lifecycle scripts must stay disabled", rel, configRel, ignoreScripts, value)
	}
	return ""
}

func checkYarnConfig(rel, yarnrcRel, yarnrcPath string) string {
	//nolint:gosec // the path is a repository-relative lockfile directory.
	data, err := os.ReadFile(yarnrcPath)
	if err != nil {
		return fmt.Sprintf("%s: cannot read %s: %v", rel, yarnrcRel, err)
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		return fmt.Sprintf("%s: cannot parse %s: %v", rel, yarnrcRel, err)
	}
	if document.Kind != yaml.DocumentNode || len(document.Content) == 0 {
		return fmt.Sprintf("%s: %s must set `%s: false`", rel, yarnrcRel, enableScripts)
	}
	root := document.Content[0]
	if root.Kind != yaml.MappingNode {
		return fmt.Sprintf("%s: %s must be a mapping", rel, yarnrcRel)
	}
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value != enableScripts {
			continue
		}
		value := root.Content[i+1]
		if value.Kind != yaml.ScalarNode || !isFalseValue(value.Value) {
			return fmt.Sprintf("%s: %s must set `%s: false`", rel, yarnrcRel, enableScripts)
		}
		return ""
	}
	return fmt.Sprintf("%s: %s must set `%s: false`", rel, yarnrcRel, enableScripts)
}

// npmIgnoreScripts returns the effective value of `ignore-scripts` in an npm
// config file, using npm's last-assignment-wins semantics so a later `=true`
// legitimately overrides an earlier `=false` and the other way round.
func npmIgnoreScripts(configPath string) (string, bool, error) {
	//nolint:gosec // the path is a repository-relative lockfile directory.
	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			// Report the missing config through the found flag so the caller
			// names the expected file and key rather than a raw syscall error.
			return "", false, nil
		}
		return "", false, err
	}
	value, found := "", false
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		key, parsed, ok := parseNPMConfigLine(scanner.Text())
		if !ok || !strings.EqualFold(key, ignoreScripts) {
			continue
		}
		value, found = parsed, true
	}
	if err := scanner.Err(); err != nil {
		return "", false, err
	}
	return value, found, nil
}

func parseNPMConfigLine(line string) (string, string, bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, ";") {
		return "", "", false
	}
	if index := strings.IndexAny(trimmed, "#;"); index > 0 {
		trimmed = strings.TrimSpace(trimmed[:index])
	}
	key, value, hasValue := strings.Cut(trimmed, "=")
	key = strings.TrimSpace(key)
	if key == "" {
		return "", "", false
	}
	if !hasValue {
		// A bare key is npm's "true" spelling.
		return key, "true", true
	}
	return key, trimConfigValue(value), true
}

func trimConfigValue(value string) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) >= 2 {
		if (trimmed[0] == '"' && trimmed[len(trimmed)-1] == '"') || (trimmed[0] == '\'' && trimmed[len(trimmed)-1] == '\'') {
			return trimmed[1 : len(trimmed)-1]
		}
	}
	return trimmed
}

func isTrueValue(value string) bool {
	return strings.EqualFold(strings.TrimSpace(value), "true")
}

func isFalseValue(value string) bool {
	return strings.EqualFold(strings.TrimSpace(value), "false")
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
