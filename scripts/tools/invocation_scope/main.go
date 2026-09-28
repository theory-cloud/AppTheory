// Command invocation_scope is the repository guard for the invocation-scope
// invariant: no goroutine, thread, task or promise the runtime starts may
// outlive the Lambda invocation that started it.
//
// The guard enumerates every asynchronous primitive in the shipped runtime trees
// (Go goroutine launches in runtime/, pkg/, testkit/ and cmd/; thread, worker and
// task starts in ts/src and py/src) and compares the result against
// scripts/invocation-scope-baseline.txt. Each baseline entry carries the
// justification for why that site cannot outlive its invocation, and each entry
// names the join that makes it true.
//
// It fails when a site is not in the baseline (a new launch needs an explicit
// justification) and when a baseline entry no longer matches a site (a stale
// justification must be removed). The baseline is therefore the auditable sweep
// table for the invariant, not a description of it.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type site struct {
	path string
	fn   string
	nth  int
	line int
}

func (s site) key() string {
	return fmt.Sprintf("%s|%s[#%d]", s.path, s.fn, s.nth)
}

type entry struct {
	justification string
}

func main() {
	root := flag.String("root", ".", "repository root")
	baselinePath := flag.String("baseline", filepath.Join("scripts", "invocation-scope-baseline.txt"), "baseline file, relative to the root")
	flag.Parse()

	baseline, err := loadBaseline(filepath.Join(*root, *baselinePath))
	if err != nil {
		fail("read baseline: %v", err)
	}

	found := map[string]site{}
	for _, s := range scanGo(filepath.Join(*root, "runtime"), filepath.Join(*root, "pkg"), filepath.Join(*root, "testkit"), filepath.Join(*root, "cmd")) {
		found[s.key()] = s
	}
	for _, s := range scanPython(filepath.Join(*root, "py", "src")) {
		found[s.key()] = s
	}
	for _, s := range scanTypeScript(filepath.Join(*root, "ts", "src")) {
		found[s.key()] = s
	}

	matched := map[string]bool{}
	var newSites []string
	for key, s := range found {
		if _, ok := baseline[key]; ok {
			matched[key] = true
			continue
		}
		newSites = append(newSites, fmt.Sprintf("%s:%d (%s)", s.path, s.line, s.key()))
	}
	var stale []string
	for key := range baseline {
		if !matched[key] {
			stale = append(stale, key)
		}
	}
	sort.Strings(newSites)
	sort.Strings(stale)

	if len(newSites) > 0 {
		fmt.Fprintln(os.Stderr, "invocation-scope: new asynchronous launch site(s) without a justification:")
		for _, s := range newSites {
			fmt.Fprintf(os.Stderr, "  - %s\n", s)
		}
		fmt.Fprintln(os.Stderr, "Every launch must be joined before the invocation returns, or not exist.")
		fmt.Fprintln(os.Stderr, "Add the site to scripts/invocation-scope-baseline.txt with the join that makes it safe.")
	}
	if len(stale) > 0 {
		fmt.Fprintln(os.Stderr, "invocation-scope: baseline entries that no longer match a site:")
		for _, s := range stale {
			fmt.Fprintf(os.Stderr, "  - %s\n", s)
		}
		fmt.Fprintln(os.Stderr, "Remove the stale entry: the sweep table must describe the code that exists.")
	}
	if len(newSites) > 0 || len(stale) > 0 {
		os.Exit(1)
	}

	fmt.Printf("invocation-scope: PASS (%d justified launch sites)\n", len(found))
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "invocation-scope: "+format+"\n", args...)
	os.Exit(2)
}

func loadBaseline(path string) (map[string]entry, error) {
	f, err := os.Open(path) //nolint:gosec // The path is repository-owned (scripts/invocation-scope-baseline.txt), not caller input.
	if err != nil {
		return nil, err
	}
	defer func() {
		if closeErr := f.Close(); closeErr != nil {
			_ = closeErr
		}
	}()

	out := map[string]entry{}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "|", 3)
		if len(parts) != 3 {
			return nil, fmt.Errorf("line %d: expected '<path>|<function>[#n]|<justification>'", lineNo)
		}
		key := strings.TrimSpace(strings.Join(parts[:2], "|"))
		justification := strings.TrimSpace(parts[2])
		if key == "" || justification == "" {
			return nil, fmt.Errorf("line %d: site and justification are both required", lineNo)
		}
		if _, dup := out[key]; dup {
			return nil, fmt.Errorf("line %d: duplicate site %s", lineNo, key)
		}
		out[key] = entry{justification: justification}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// scanGo reports every `go` statement in the non-test Go sources below the given
// roots.
func scanGo(roots ...string) []site {
	var out []site
	for _, root := range roots {
		walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			return visitGoEntry(path, d, err, &out)
		})
		if walkErr != nil {
			fail("walk %s: %v", root, walkErr)
		}
	}
	return out
}

func visitGoEntry(path string, d os.DirEntry, err error, out *[]site) error {
	if err != nil {
		return err
	}
	if d.IsDir() {
		if skippedDirs[d.Name()] {
			return filepath.SkipDir
		}
		return nil
	}
	if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
		return nil
	}

	fset := token.NewFileSet()
	file, parseErr := parser.ParseFile(fset, path, nil, 0)
	if parseErr != nil {
		fail("parse %s: %v", path, parseErr)
	}
	rel := filepath.ToSlash(path)
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		nth := 0
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			stmt, ok := n.(*ast.GoStmt)
			if !ok {
				return true
			}
			nth++
			*out = append(*out, site{path: rel, fn: funcName(fn), nth: nth, line: fset.Position(stmt.Pos()).Line})
			return true
		})
		*out = append(*out, goTimerSites(fset, rel, fn)...)
	}
	return nil
}

// goTimerNames are the time package constructors that start a timer or a
// ticker. AfterFunc runs its callback on a goroutine of its own; a ticker or a
// timer left running keeps that machinery alive past the invocation.
var goTimerNames = map[string]bool{
	"AfterFunc": true,
	"NewTimer":  true,
	"NewTicker": true,
	"Tick":      true,
}

// goTimerSites reports every time-package timer constructor in one function,
// except a named timer or ticker the same function stops.
//
// A timer bound to a name and stopped by the owning function cannot outlive the
// invocation: stopping it releases the runtime timer. time.Tick has no stop, so
// it is always reported. A constructor whose handle is discarded is always
// reported, because nothing can stop it.
func goTimerSites(fset *token.FileSet, rel string, fn *ast.FuncDecl) []site {
	bound := map[*ast.CallExpr]string{}
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		assign, ok := n.(*ast.AssignStmt)
		if !ok || len(assign.Lhs) != 1 || len(assign.Rhs) != 1 {
			return true
		}
		ident, ok := assign.Lhs[0].(*ast.Ident)
		if !ok || ident.Name == "_" {
			return true
		}
		if call, ok := assign.Rhs[0].(*ast.CallExpr); ok && isGoTimerCall(call) {
			bound[call] = ident.Name
		}
		return true
	})

	counts := map[string]int{}
	var out []site
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || !isGoTimerCall(call) {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		kind := "time." + sel.Sel.Name
		if kind != "time.Tick" {
			if name := bound[call]; name != "" && fnCallsMethod(fn.Body, name, "Stop") {
				return true
			}
		}
		counts[kind]++
		out = append(out, site{path: rel, fn: kind, nth: counts[kind], line: fset.Position(call.Pos()).Line})
		return true
	})
	return out
}

func isGoTimerCall(call *ast.CallExpr) bool {
	if call == nil {
		return false
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	ident, ok := sel.X.(*ast.Ident)
	if !ok || ident.Name != "time" {
		return false
	}
	return goTimerNames[sel.Sel.Name]
}

// fnCallsMethod reports whether body contains a call of the form name.method().
func fnCallsMethod(body *ast.BlockStmt, name, method string) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		if found {
			return false
		}
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != method {
			return true
		}
		if ident, ok := sel.X.(*ast.Ident); ok && ident.Name == name {
			found = true
			return false
		}
		return true
	})
	return found
}

// skippedDirs are directories the walk never descends into: dependency and build
// output, so the guard only sees shipped sources.
var skippedDirs = map[string]bool{
	"node_modules": true,
	".git":         true,
	"vendor":       true,
	"__pycache__":  true,
	"dist":         true,
}

func funcName(fn *ast.FuncDecl) string {
	if fn.Recv != nil && len(fn.Recv.List) > 0 {
		recv := typeName(fn.Recv.List[0].Type)
		return "(" + recv + ")." + fn.Name.Name
	}
	return fn.Name.Name
}

func typeName(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return typeName(t.X)
	case *ast.IndexExpr:
		return typeName(t.X)
	default:
		return "?"
	}
}

// langPattern names one asynchronous construct to look for. The kind is part of
// the site key, so a justification is attached to the construct rather than to a
// heuristic guess at the enclosing function.
type langPattern struct {
	kind string
	re   *regexp.Regexp
	// skip, when set, suppresses a hit on a line where the construct is already
	// joined (for example an awaited asyncio.to_thread).
	skip func(line string) bool
}

func lineIsAwaited(line string) bool {
	return strings.Contains(line, "await ")
}

var pyPatterns = []langPattern{
	{"thread", regexp.MustCompile(`\bthreading\.Thread\(|\b_thread\.start_new_thread\(`), nil},
	{"futures", regexp.MustCompile(`\bconcurrent\.futures`), nil},
	{"multiprocessing", regexp.MustCompile(`\bmultiprocessing\.`), nil},
	{"asyncio-task", regexp.MustCompile(`\basyncio\.(?:create_task|ensure_future)\(`), nil},
	{"to-thread", regexp.MustCompile(`\basyncio\.to_thread\s*\(`), lineIsAwaited},
	{"run-in-executor", regexp.MustCompile(`\brun_in_executor\s*\(`), lineIsAwaited},
	{"daemon-thread", regexp.MustCompile(`\bdaemon\s*=\s*True\b`), nil},
}

var tsPatterns = []langPattern{
	{"worker", regexp.MustCompile(`new\s+(?:Shared)?Worker\(`), nil},
	{"worker_threads", regexp.MustCompile(`node:worker_threads`), nil},
	{"child_process", regexp.MustCompile(`node:child_process`), nil},
	{"promise-race", regexp.MustCompile(`Promise\.race\(`), nil},
	{"timer", regexp.MustCompile(`setTimeout\(|setInterval\(`), nil},
	{"microtask", regexp.MustCompile(`\bqueueMicrotask\s*[(\[]`), nil},
	{"next-tick", regexp.MustCompile(`\bprocess\s*\.\s*nextTick\s*\(`), nil},
	{"next-tick-bracket", regexp.MustCompile("\\bprocess\\s*\\[\\s*[\"'`]nextTick[\"'`]\\s*\\]"), nil},
	{"immediate", regexp.MustCompile(`\bsetImmediate\s*\(`), nil},
	{"immediate-bracket", regexp.MustCompile("\\[\\s*[\"'`]setImmediate[\"'`]\\s*\\]"), nil},
	{"timer-bracket", regexp.MustCompile("\\[\\s*[\"'`](?:setTimeout|setInterval)[\"'`]\\s*\\]"), nil},
	{"async-iife", regexp.MustCompile(`^\s*\(\s*async\s*(?:\(|function\b)`), nil},
}

func scanPython(root string) []site {
	out := scanPatterns(root, ".py", pyPatterns)
	return append(out, scanPythonComprehensionThreads(root)...)
}

func scanTypeScript(root string) []site {
	out := scanPatterns(root, ".ts", tsPatterns)
	return append(out, scanTypeScriptExtras(root)...)
}

// scanPatterns reports every match of the given constructs in the files below
// root with the given extension, keyed by file and construct so a justification
// cannot silently move between sites.
func scanPatterns(root, ext string, patterns []langPattern) []site {
	var out []site
	walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if skippedDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ext) {
			return nil
		}
		data, readErr := os.ReadFile(path) //nolint:gosec // The path comes from the repository walk, not from caller input.
		if readErr != nil {
			fail("read %s: %v", path, readErr)
		}
		lines := strings.Split(string(data), "\n")
		rel := filepath.ToSlash(path)
		counts := map[string]int{}
		for i, line := range lines {
			trimmed := strings.TrimSpace(line)
			if isCommentLine(trimmed, ext) {
				continue
			}
			for _, pattern := range patterns {
				if !pattern.re.MatchString(line) {
					continue
				}
				if pattern.skip != nil && pattern.skip(line) {
					continue
				}
				counts[pattern.kind]++
				out = append(out, site{path: rel, fn: pattern.kind, nth: counts[pattern.kind], line: i + 1})
			}
		}
		return nil
	})
	if walkErr != nil {
		fail("walk %s: %v", root, walkErr)
	}
	return out
}

// isCommentLine reports whether a trimmed source line is a comment, so the
// scanners do not police documentation or commented-out code.
func isCommentLine(trimmed, ext string) bool {
	if trimmed == "" {
		return false
	}
	if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "/*") {
		return true
	}
	if ext == ".py" && strings.HasPrefix(trimmed, "#") {
		return true
	}
	return false
}

// scanPythonComprehensionThreads reports thread constructors created inside a
// comprehension. A comprehension starts its threads inside a bracket span whose
// for-clause follows the constructor, so neither the Thread regex nor the .start()
// call alone identifies it.
func scanPythonComprehensionThreads(root string) []site {
	var out []site
	walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if skippedDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".py") {
			return nil
		}
		data, readErr := os.ReadFile(path) //nolint:gosec // The path comes from the repository walk, not from caller input.
		if readErr != nil {
			fail("read %s: %v", path, readErr)
		}
		lines := strings.Split(string(data), "\n")
		rel := filepath.ToSlash(path)
		marked := pyComprehensionThreadLines(lines)
		lineNos := make([]int, 0, len(marked))
		for lineNo := range marked {
			lineNos = append(lineNos, lineNo)
		}
		sort.Ints(lineNos)
		for i, lineNo := range lineNos {
			out = append(out, site{path: rel, fn: "thread-comprehension", nth: i + 1, line: lineNo})
		}
		return nil
	})
	if walkErr != nil {
		fail("walk %s: %v", root, walkErr)
	}
	return out
}

var (
	pyThreadCtorRe    = regexp.MustCompile(`\b(?:threading\.(?:Thread|Timer)|multiprocessing\.Process)\s*\(`)
	pyComprehensionRe = regexp.MustCompile(`\bfor\b[^:]*\bin\b`)
)

// pyComprehensionThreadLines returns the 1-based line numbers of thread
// constructors created inside a comprehension.
func pyComprehensionThreadLines(lines []string) map[int]bool {
	type pending struct {
		lineNo int
		depth  int
	}

	out := map[int]bool{}
	depth := 0
	var pendings []pending
	for i, line := range lines {
		lineNo := i + 1
		startDepth := depth

		if loc := pyThreadCtorRe.FindStringIndex(line); loc != nil {
			switch {
			case pyComprehensionRe.MatchString(line[loc[1]:]):
				// The for-clause follows the constructor on the same line.
				out[lineNo] = true
			case startDepth > 0:
				pendings = append(pendings, pending{lineNo: lineNo, depth: startDepth})
			}
		}
		if pyComprehensionRe.MatchString(line) {
			for _, p := range pendings {
				if depth >= p.depth {
					out[p.lineNo] = true
				}
			}
		}

		depth += pyBracketDelta(line)
		kept := pendings[:0]
		for _, p := range pendings {
			if depth >= p.depth {
				kept = append(kept, p)
			}
		}
		pendings = kept
	}
	return out
}

// pyBracketDelta is the net bracket depth a line opens, ignoring brackets inside
// a string literal and after a comment marker.
func pyBracketDelta(line string) int {
	depth := 0
	var quote byte
	for i := 0; i < len(line); i++ {
		c := line[i]
		if quote != 0 {
			switch c {
			case '\\':
				i++
			case quote:
				quote = 0
			}
			continue
		}
		switch c {
		case '\'', '"':
			quote = c
		case '#':
			return depth
		case '(', '[', '{':
			depth++
		case ')', ']', '}':
			depth--
		}
	}
	return depth
}

var (
	tsFloatingChains = []struct {
		kind string
		re   *regexp.Regexp
	}{
		{"floating-then", regexp.MustCompile(`\.then\s*\(`)},
		{"floating-catch", regexp.MustCompile(`\.catch\s*\(`)},
		{"floating-finally", regexp.MustCompile(`\.finally\s*\(`)},
	}

	tsAsyncFunctionDeclRe = regexp.MustCompile(`^\s*(?:export\s+)?(?:default\s+)?async\s+function\s+([A-Za-z_$][\w$]*)`)
	tsAsyncArrowDeclRe    = regexp.MustCompile(`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*async\b`)
	tsAssignmentOps       = []string{"=>", "===", "==", "!==", "!=", ">=", "<=", "+=", "-=", "*=", "/="}
)

// scanTypeScriptExtras reports the promise forms a bare regex cannot classify:
// a chained continuation whose result is discarded, and a call to a function the
// file declares async whose result is discarded. Both are reported only when the
// chain is in statement position (not awaited, returned, or assigned).
func scanTypeScriptExtras(root string) []site {
	var out []site
	walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if skippedDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".ts") {
			return nil
		}
		data, readErr := os.ReadFile(path) //nolint:gosec // The path comes from the repository walk, not from caller input.
		if readErr != nil {
			fail("read %s: %v", path, readErr)
		}
		out = append(out, tsExtraSites(filepath.ToSlash(path), strings.Split(string(data), "\n"))...)
		return nil
	})
	if walkErr != nil {
		fail("walk %s: %v", root, walkErr)
	}
	return out
}

// tsExtraSites returns the discarded-promise sites in one file's lines.
func tsExtraSites(rel string, lines []string) []site {
	var out []site
	counts := map[string]int{}

	for i, line := range lines {
		if isCommentLine(strings.TrimSpace(line), ".ts") {
			continue
		}
		for _, chain := range tsFloatingChains {
			loc := chain.re.FindStringIndex(line)
			if loc == nil || !tsChainIsFloating(lines, i, loc[0]) {
				continue
			}
			counts[chain.kind]++
			out = append(out, site{path: rel, fn: chain.kind, nth: counts[chain.kind], line: i + 1})
		}
	}

	asyncNames := tsAsyncFunctionNames(lines)
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if isCommentLine(trimmed, ".ts") || !tsDiscardedAsyncCall(trimmed, asyncNames) {
			continue
		}
		counts["discarded-async-call"]++
		out = append(out, site{path: rel, fn: "discarded-async-call", nth: counts["discarded-async-call"], line: i + 1})
	}
	return out
}

// tsChainIsFloating reports whether a chained `.then(`/`.catch(`/`.finally(`
// member at matchStart on line idx belongs to a discarded promise.
//
// A chain is joined when its statement head is awaited, returned, voided, or
// assigned. Because a chain can be split across lines, the walk follows
// member-access continuation lines back to the head before deciding.
func tsChainIsFloating(lines []string, idx, matchStart int) bool {
	line := lines[idx]
	if tsPrefixDisqualifies(line[:matchStart]) || tsStatementStartExcluded(strings.TrimSpace(line)) {
		return false
	}

	for j := idx - 1; j >= 0; j-- {
		if !strings.HasPrefix(strings.TrimSpace(lines[j+1]), ".") {
			break
		}
		prev := lines[j]
		if isCommentLine(strings.TrimSpace(prev), ".ts") || strings.TrimSpace(prev) == "" {
			continue
		}
		if tsPrefixDisqualifies(prev) || tsStatementStartExcluded(strings.TrimSpace(prev)) {
			return false
		}
	}
	return true
}

// tsPrefixDisqualifies reports whether the text before a chain member already
// joins the promise.
func tsPrefixDisqualifies(prefix string) bool {
	if strings.Contains(prefix, "await ") || strings.Contains(prefix, "return") || strings.Contains(prefix, "void ") {
		return true
	}
	stripped := prefix
	for _, op := range tsAssignmentOps {
		stripped = strings.ReplaceAll(stripped, op, "")
	}
	return strings.Contains(stripped, "=")
}

func tsStatementStartExcluded(trimmed string) bool {
	for _, prefix := range []string{"const ", "let ", "var ", "await ", "return ", "return", "void ", "export ", "//", "/*", "*"} {
		if strings.HasPrefix(trimmed, prefix) {
			return true
		}
	}
	return false
}

// tsAsyncFunctionNames collects the names of functions the file declares async,
// whose calls therefore return a promise.
func tsAsyncFunctionNames(lines []string) map[string]bool {
	out := map[string]bool{}
	for _, line := range lines {
		if m := tsAsyncFunctionDeclRe.FindStringSubmatch(line); m != nil {
			out[m[1]] = true
		}
		if m := tsAsyncArrowDeclRe.FindStringSubmatch(line); m != nil {
			out[m[1]] = true
		}
	}
	return out
}

// tsDiscardedAsyncCall reports whether a statement starts by calling an async
// function and discards the promise it returns.
func tsDiscardedAsyncCall(trimmed string, asyncNames map[string]bool) bool {
	for name := range asyncNames {
		if !strings.HasPrefix(trimmed, name) {
			continue
		}
		rest := strings.TrimSpace(strings.TrimPrefix(trimmed, name))
		if !strings.HasPrefix(rest, "(") {
			continue
		}
		if strings.Contains(trimmed, "=>") {
			continue
		}
		return true
	}
	return false
}
