package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	scaffoldExceptionFile     = "scripts/verify-scaffold-examples.sh"
	scaffoldExceptionLine     = "npm install --ignore-scripts >/dev/null"
	scaffoldExceptionExpected = 3
	makefileName              = "Makefile"

	npmCommand  = "npm"
	yarnCommand = "yarn"
	pnpmCommand = "pnpm"

	// maxVariableHops bounds `$NAME` resolution so a self-referential
	// assignment cannot spin the scanner.
	maxVariableHops = 8
)

var immutableSpecPattern = regexp.MustCompile(`@[0-9]+\.[0-9]+\.[0-9]+`)

// Launcher value-taking flags: a launcher's own flag may consume the next word,
// so the launcher target must skip the flag and its value together. Boolean
// flags are skipped one word at a time.
var (
	npxValueFlags     = map[string]bool{"-p": true, "--package": true}
	corepackFlags     = map[string]bool{}
	pnpmDlxValueFlags = map[string]bool{"--package": true}
	xargsValueFlags   = map[string]bool{
		"-I": true, "-i": true, "-n": true, "-P": true, "-s": true, "-a": true,
		"-E": true, "-d": true, "-L": true, "-e": true,
		"--max-args": true, "--replace": true, "--max-procs": true,
		"--delimiter": true, "--arg-file": true, "--max-lines": true, "--eof": true,
	}

	// Command-prefix words take values too (`sudo -u root npm ci`,
	// `nice -n 10 npm ci`, `env -u FOO npm ci`), so those flags must skip their
	// value as well or the value would be read as the command name.
	prefixValueFlags = map[string]map[string]bool{
		"sudo": {
			"-u": true, "--user": true, "-g": true, "--group": true, "-p": true,
			"--prompt": true, "-C": true, "--close-from": true, "-r": true,
			"--role": true, "-t": true, "--type": true, "-h": true, "--host": true,
		},
		"nice": {"-n": true, "--adjustment": true},
		"env":  {"-u": true, "--unset": true, "-C": true, "--chdir": true},
	}
)

// reservedShellWords introduce a command rather than being one: `if CMD`,
// `while CMD`, `! CMD` and `{ CMD` all run CMD in command position, so the
// keyword is skipped and the remainder is classified.
var reservedShellWords = map[string]bool{
	"if": true, "elif": true, "while": true, "until": true, "then": true,
	"do": true, "else": true, "!": true, "{": true, "}": true,
}

type installViolation struct {
	path    string
	line    int
	message string
	text    string
}

type installScanState struct {
	violations []installViolation
	allowed    int
	env        map[string]string
}

func runInstallHygiene(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("install-hygiene", flag.ContinueOnError)
	flags.SetOutput(stderr)
	root := flags.String("root", ".", "repository root")
	if err := flags.Parse(args); err != nil {
		return exitBlocked
	}

	paths, err := readSurfacePaths(stdin)
	if err != nil {
		writeString(stderr, fmt.Sprintf("npm-install-hygiene: BLOCKED (%v)\n", err))
		return exitBlocked
	}
	if len(paths) == 0 {
		writeString(stderr, "npm-install-hygiene: BLOCKED (no executable surfaces on stdin)\n")
		return exitBlocked
	}

	state := &installScanState{}
	for _, path := range paths {
		state.scanSurface(*root, path)
	}
	if len(state.violations) > 0 {
		writeString(stderr, fmt.Sprintf("npm-install-hygiene: FAIL (%d violating install(s))\n", len(state.violations)))
		for _, violation := range state.violations {
			writeString(stderr, fmt.Sprintf("  %s:%d: %s: %s\n", violation.path, violation.line, violation.message, violation.text))
		}
		return exitFail
	}
	if state.allowed != scaffoldExceptionExpected {
		writeString(stderr, fmt.Sprintf("npm-install-hygiene: FAIL (expected %d recorded non-lockfile installs in %s, found %d)\n",
			scaffoldExceptionExpected, scaffoldExceptionFile, state.allowed))
		return exitFail
	}
	writeString(stdout, fmt.Sprintf("npm-install-hygiene: PASS (every scanned install disables lifecycle scripts; %d recorded scaffold exceptions)\n", state.allowed))
	return exitPass
}

func readSurfacePaths(stdin io.Reader) ([]string, error) {
	scanner := bufio.NewScanner(stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var paths []string
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		paths = append(paths, filepath.ToSlash(line))
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return paths, nil
}

func (s *installScanState) scanSurface(root, rel string) {
	if strings.HasPrefix(rel, "gov-infra/planning/") {
		return
	}
	//nolint:gosec // the path is a repository-relative surface enumerated from git.
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		s.record(installViolation{path: rel, message: "cannot read surface", text: err.Error()})
		return
	}
	s.resetEnv()
	if rel != makefileName && (strings.HasSuffix(rel, ".yml") || strings.HasSuffix(rel, ".yaml")) {
		if err := s.scanWorkflowYAML(rel, string(data)); err != nil {
			s.record(installViolation{path: rel, message: "cannot parse workflow YAML", text: err.Error()})
		}
		return
	}
	scanShellText(string(data), 1, func(command shellCommand) { s.checkCommand(rel, command) })
}

func (s *installScanState) resetEnv() {
	s.env = map[string]string{}
}

func (s *installScanState) scanWorkflowYAML(rel, data string) error {
	var document yaml.Node
	if err := yaml.Unmarshal([]byte(data), &document); err != nil {
		return err
	}
	if document.Kind != yaml.DocumentNode || len(document.Content) == 0 {
		return nil
	}
	s.walkRuns(rel, document.Content[0])
	return nil
}

func (s *installScanState) walkRuns(rel string, node *yaml.Node) {
	switch node.Kind {
	case yaml.MappingNode:
		for i := 0; i+1 < len(node.Content); i += 2 {
			key, value := node.Content[i], node.Content[i+1]
			if key.Kind == yaml.ScalarNode && key.Value == "run" {
				if value.Kind != yaml.ScalarNode {
					// GitHub requires `run:` to be a string; an alias, mapping
					// or sequence there could smuggle an install past a scan.
					s.record(installViolation{path: rel, line: value.Line, message: "run: value must be a plain string", text: "unmodeled run: value"})
					continue
				}
				s.resetEnv()
				scanShellText(value.Value, value.Line, func(command shellCommand) { s.checkCommand(rel, command) })
				continue
			}
			s.walkRuns(rel, value)
		}
	default:
		for _, child := range node.Content {
			s.walkRuns(rel, child)
		}
	}
}

func (s *installScanState) checkCommand(rel string, command shellCommand) {
	s.scanCommand(rel, command, command.words)
}

func (s *installScanState) scanCommand(rel string, command shellCommand, raw []string) {
	words, assignments := unwrapCommand(raw)
	s.absorb(assignments)
	if len(words) == 0 {
		return
	}
	words = s.resolveHead(rel, command, words)
	if len(words) == 0 {
		return
	}
	name := commandBase(words[0])
	args := words[1:]
	switch {
	case name == "npx" || name == "pnpx":
		s.checkLaunched(rel, command, args, npxValueFlags)
	case name == "corepack":
		s.checkLaunched(rel, command, args, corepackFlags)
	case name == "xargs":
		s.checkLaunched(rel, command, args, xargsValueFlags)
	case name == pnpmCommand && len(args) > 0 && args[0] == "dlx":
		s.checkLaunched(rel, command, args[1:], pnpmDlxValueFlags)
	case name == "eval":
		payload := strings.Join(args, " ")
		if strings.TrimSpace(payload) != "" {
			scanShellText(payload, command.line, func(nested shellCommand) { s.checkCommand(rel, nested) })
		}
	case reservedShellWords[name]:
		s.scanCommand(rel, command, words[1:])
	default:
		s.checkInstall(rel, command, name, args)
	}
}

// checkLaunched classifies the command a launcher ultimately runs, skipping the
// launcher's own flags (and the values they consume) and stripping a pinned
// version from the package spec (`npx npm@10.9.0 ci`).
func (s *installScanState) checkLaunched(rel string, command shellCommand, words []string, valueFlags map[string]bool) {
	target := launchTarget(words, valueFlags)
	if len(target) == 0 {
		return
	}
	s.checkInstall(rel, command, commandBase(target[0]), target[1:])
}

func launchTarget(words []string, valueFlags map[string]bool) []string {
	index := 0
	for index < len(words) {
		word := words[index]
		if word == "-" || !strings.HasPrefix(word, "-") {
			break
		}
		if valueFlags[word] && index+1 < len(words) {
			index += 2
			continue
		}
		index++
	}
	if index >= len(words) {
		return nil
	}
	target := append([]string{}, words[index:]...)
	target[0] = stripPackageVersion(target[0])
	return target
}

func stripPackageVersion(spec string) string {
	if index := strings.LastIndexByte(spec, '@'); index > 0 {
		return spec[:index]
	}
	return spec
}

// resolveHead replaces a leading `$NAME` / `${NAME}` command word with the
// literal value recorded for it. A value containing whitespace is a whole
// command line (`CMD='npm ci'; $CMD`), so it is re-scanned as shell text. An
// unrecorded variable is left alone: a dynamically constructed command cannot
// be resolved statically, and treating every `$VAR` as an install would fail
// every script that uses one.
func (s *installScanState) resolveHead(rel string, command shellCommand, words []string) []string {
	for hop := 0; hop < maxVariableHops; hop++ {
		if len(words) == 0 {
			return nil
		}
		name, ok := variableReference(words[0])
		if !ok {
			return words
		}
		value, found := s.env[name]
		if !found {
			return words
		}
		if strings.ContainsAny(value, " \t") {
			scanShellText(value, command.line, func(nested shellCommand) { s.checkCommand(rel, nested) })
			return nil
		}
		words = append([]string{value}, words[1:]...)
	}
	return words
}

func (s *installScanState) absorb(assignments map[string]string) {
	if len(assignments) == 0 {
		return
	}
	if s.env == nil {
		s.env = map[string]string{}
	}
	for name, value := range assignments {
		s.env[name] = value
	}
}

func variableReference(word string) (string, bool) {
	if strings.HasPrefix(word, "${") && strings.HasSuffix(word, "}") {
		name := word[2 : len(word)-1]
		if isVariableName(name) {
			return name, true
		}
		return "", false
	}
	if strings.HasPrefix(word, "$") && isVariableName(word[1:]) {
		return word[1:], true
	}
	return "", false
}

func isVariableName(name string) bool {
	if name == "" {
		return false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		switch {
		case c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'):
		case i > 0 && c >= '0' && c <= '9':
		default:
			return false
		}
	}
	return true
}

func (s *installScanState) checkInstall(rel string, command shellCommand, name string, args []string) {
	if name != npmCommand && name != yarnCommand && name != pnpmCommand {
		return
	}
	subcommand := ""
	if len(args) > 0 {
		subcommand = args[0]
	}
	if !isInstallSubcommand(name, subcommand, args) {
		return
	}
	var flags []string
	if len(args) > 1 {
		flags = args[1:]
	}
	if !hasIgnoreScriptsTrue(flags) {
		s.record(installViolation{path: rel, line: command.line, message: "install without --ignore-scripts", text: command.raw})
		return
	}
	if name == npmCommand && subcommand == "ci" {
		return
	}
	if rel == scaffoldExceptionFile && strings.TrimSpace(command.raw) == scaffoldExceptionLine {
		s.allowed++
		return
	}
	if immutableSpecPattern.MatchString(command.raw) || strings.Contains(command.raw, ".tgz") || strings.Contains(command.raw, "file:") {
		return
	}
	s.record(installViolation{path: rel, line: command.line, message: "install without a lockfile or immutable spec", text: command.raw})
}

func (s *installScanState) record(violation installViolation) {
	s.violations = append(s.violations, violation)
}

func isInstallSubcommand(name, subcommand string, args []string) bool {
	switch name {
	case npmCommand:
		return containsString([]string{"ci", "install", "i", "add"}, subcommand)
	case yarnCommand:
		if len(args) == 0 {
			return true
		}
		return containsString([]string{"install", "add"}, subcommand)
	case pnpmCommand:
		return containsString([]string{"install", "i", "add"}, subcommand)
	default:
		return false
	}
}

// hasIgnoreScriptsTrue reports whether the flags disable lifecycle scripts. Any
// spelling that turns scripts back on (`--ignore-scripts=false`,
// `--ignore-scripts=<other>`, `--no-ignore-scripts`) fails closed.
func hasIgnoreScriptsTrue(flags []string) bool {
	found := false
	for _, flagValue := range flags {
		switch {
		case flagValue == "--ignore-scripts":
			found = true
		case flagValue == "--no-ignore-scripts":
			return false
		case strings.HasPrefix(flagValue, "--ignore-scripts="):
			if !strings.EqualFold(strings.TrimPrefix(flagValue, "--ignore-scripts="), "true") {
				return false
			}
			found = true
		}
	}
	return found
}

// unwrapCommand peels the leading assignment words and launcher words
// (`sudo`, `env`, `time`, ...) off a command, returning the words that form the
// command itself plus the literal `NAME=value` assignments it saw. The
// assignments are what let `NPM=npm; $NPM ci` and `env NPM=npm $NPM ci` be
// classified instead of escaping as an unknown command word.
func unwrapCommand(words []string) ([]string, map[string]string) {
	index := 0
	assignments := map[string]string{}
	for index < len(words) {
		switch {
		case isAssignmentWord(words[index]):
			name, value := splitAssignment(words[index])
			assignments[name] = value
			index++
		case isCommandPrefixWord(words[index]):
			prefix := words[index]
			index++
			for index < len(words) && strings.HasPrefix(words[index], "-") {
				if prefixValueFlags[prefix][words[index]] && index+1 < len(words) {
					index += 2
					continue
				}
				index++
			}
		default:
			return words[index:], assignments
		}
	}
	return words[index:], assignments
}

func splitAssignment(word string) (string, string) {
	equals := strings.IndexByte(word, '=')
	return word[:equals], word[equals+1:]
}

func isAssignmentWord(word string) bool {
	equals := strings.IndexByte(word, '=')
	if equals <= 0 {
		return false
	}
	for i := 0; i < equals; i++ {
		c := word[i]
		if c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') {
			continue
		}
		if i > 0 && c >= '0' && c <= '9' {
			continue
		}
		return false
	}
	return true
}

func isCommandPrefixWord(word string) bool {
	switch word {
	case "sudo", "command", "env", "time", "nohup", "exec", "nice", "shell":
		// "shell" is the make `$(shell ...)` function: its payload is a shell
		// command, so the launcher word is unwrapped like the others.
		return true
	default:
		return false
	}
}

func commandBase(word string) string {
	if index := strings.LastIndexByte(word, '/'); index >= 0 {
		return word[index+1:]
	}
	return word
}
