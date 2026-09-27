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
	}
	return nil
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
}

var pyPatterns = []langPattern{
	{"thread", regexp.MustCompile(`\bthreading\.Thread\(|\b_thread\.start_new_thread\(`)},
	{"futures", regexp.MustCompile(`\bconcurrent\.futures`)},
	{"multiprocessing", regexp.MustCompile(`\bmultiprocessing\.`)},
	{"asyncio-task", regexp.MustCompile(`\basyncio\.(?:create_task|ensure_future)\(`)},
}

var tsPatterns = []langPattern{
	{"worker", regexp.MustCompile(`new\s+(?:Shared)?Worker\(`)},
	{"worker_threads", regexp.MustCompile(`node:worker_threads`)},
	{"child_process", regexp.MustCompile(`node:child_process`)},
	{"promise-race", regexp.MustCompile(`Promise\.race\(`)},
	{"timer", regexp.MustCompile(`setTimeout\(|setInterval\(`)},
}

func scanPython(root string) []site {
	return scanPatterns(root, ".py", pyPatterns)
}

func scanTypeScript(root string) []site {
	return scanPatterns(root, ".ts", tsPatterns)
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
			if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "#") {
				continue
			}
			for _, pattern := range patterns {
				if !pattern.re.MatchString(line) {
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
