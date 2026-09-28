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
)

var immutableSpecPattern = regexp.MustCompile(`@[0-9]+\.[0-9]+\.[0-9]+`)

type installViolation struct {
	path    string
	line    int
	message string
	text    string
}

type installScanState struct {
	violations []installViolation
	allowed    int
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
	if rel != makefileName && (strings.HasSuffix(rel, ".yml") || strings.HasSuffix(rel, ".yaml")) {
		if err := s.scanWorkflowYAML(rel, string(data)); err != nil {
			s.record(installViolation{path: rel, message: "cannot parse workflow YAML", text: err.Error()})
		}
		return
	}
	scanShellText(string(data), 1, func(command shellCommand) { s.checkCommand(rel, command) })
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
	words := unwrapCommand(command.words)
	if len(words) == 0 {
		return
	}
	name := commandBase(words[0])
	args := words[1:]
	switch {
	case name == "npx" || name == "pnpx":
		s.checkNested(rel, command, args)
	case name == pnpmCommand && len(args) > 0 && args[0] == "dlx":
		s.checkNested(rel, command, args[1:])
	default:
		s.checkInstall(rel, command, name, args)
	}
}

func (s *installScanState) checkNested(rel string, command shellCommand, words []string) {
	nested := unwrapCommand(words)
	if len(nested) == 0 {
		return
	}
	s.checkInstall(rel, command, commandBase(nested[0]), nested[1:])
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

func unwrapCommand(words []string) []string {
	index := 0
	for index < len(words) {
		switch {
		case isAssignmentWord(words[index]):
			index++
		case isCommandPrefixWord(words[index]):
			index++
			for index < len(words) && strings.HasPrefix(words[index], "-") {
				index++
			}
		default:
			return words[index:]
		}
	}
	return words[index:]
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
