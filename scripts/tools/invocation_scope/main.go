// Command invocation_scope is the repository guard for the invocation-scope
// invariant: no goroutine, thread, task or promise the runtime starts may
// outlive the Lambda invocation that started it.
//
// The guard enumerates every asynchronous launch in the shipped runtime trees
// (Go goroutine and timer launches under runtime/, pkg/, testkit/ and cmd/;
// thread, task, executor and promise launches under ts/src and py/src) and
// reports each one whose join it cannot prove. Go sources are parsed with
// go/ast. TypeScript sources are parsed with the TypeScript compiler API by
// scripts/tools/invocation_scope/scan_typescript.mjs, and Python sources with
// the standard-library `ast` module by
// scripts/tools/invocation_scope/scan_python.py; a missing interpreter, a
// scanner failure, or a TypeScript parse diagnostic fails the guard instead of
// skipping the language.
//
// Every reported launch must be listed in scripts/invocation-scope-baseline.txt
// with the join that keeps it inside its invocation, and every baseline entry
// must still match a reported launch. The baseline is therefore the auditable
// sweep table for the invariant: it holds exactly the sites whose join the AST
// proof cannot show, not a description of the invariant.
//
// A launch counts as joined only when a join on the same target dominates every
// exit of the scope that contains it. The Go proof is the statement-list flow
// walk in this file; the TypeScript and Python proofs are the per-scope
// control-flow graphs in the two scanner helpers above. A join that only some
// paths execute (a join inside one `if` branch, a join after an early return, a
// join in a nested function nobody calls), a `cancel()`/`Stop()` without a wait,
// and a `defer` registered behind a branch are not joins.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

type site struct {
	path string
	fn   string
	nth  int
	kind string
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
	selvesTest := flag.Bool("selftest", false, "run the scanner self-test battery instead of the repository sweep")
	flag.Parse()

	if *selvesTest {
		if err := runSelfTest(os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "invocation-scope: selftest FAIL: %v\n", err)
			os.Exit(1)
		}
		return
	}

	baseline, err := loadBaseline(filepath.Join(*root, *baselinePath))
	if err != nil {
		fail("read baseline: %v", err)
	}

	found := make([]site, 0, 16)
	goSites, err := scanGo(filepath.Join(*root, "runtime"), filepath.Join(*root, "pkg"), filepath.Join(*root, "testkit"), filepath.Join(*root, "cmd"))
	if err != nil {
		fail("scan Go sources: %v", err)
	}
	found = append(found, goSites...)

	tsSites, err := scanTypeScript(filepath.Join(*root, "ts", "src"))
	if err != nil {
		scanFailure(err)
	}
	found = append(found, tsSites...)

	pySites, err := scanPython(filepath.Join(*root, "py", "src"))
	if err != nil {
		scanFailure(err)
	}
	found = append(found, pySites...)

	report(found, baseline)
}

// scanFailure reports a scanner error that is a *finding about the code under
// scan* — a parse error or an unparseable scanner response — as a guard failure.
func scanFailure(err error) {
	switch {
	case errors.Is(err, errInterpreterMissing):
		fail("%v", err)
	default:
		fmt.Fprintf(os.Stderr, "invocation-scope: %v\n", err)
		os.Exit(1)
	}
}

// report compares the reported launches with the baseline and fails on any
// launch without a justification and on any stale justification.
func report(found []site, baseline map[string]entry) {
	byKey := map[string]site{}
	for _, s := range found {
		if prev, dup := byKey[s.key()]; dup {
			fail("two launches share the site key %s (%s:%d and %s:%d)", s.key(), prev.path, prev.line, s.path, s.line)
		}
		byKey[s.key()] = s
	}

	var newSites []string
	for key, s := range byKey {
		if _, ok := baseline[key]; ok {
			continue
		}
		newSites = append(newSites, fmt.Sprintf("%s:%d (%s) [%s]", s.path, s.line, key, s.kind))
	}
	var stale []string
	for key := range baseline {
		if _, ok := byKey[key]; !ok {
			stale = append(stale, key)
		}
	}
	sort.Strings(newSites)
	sort.Strings(stale)

	if len(newSites) > 0 {
		fmt.Fprintln(os.Stderr, "invocation-scope: launch site(s) whose join the AST proof cannot show, and which carry no justification:")
		for _, s := range newSites {
			fmt.Fprintf(os.Stderr, "  - %s\n", s)
		}
		fmt.Fprintln(os.Stderr, "Every launch must be joined before the invocation returns, or not exist.")
		fmt.Fprintln(os.Stderr, "Add the site to scripts/invocation-scope-baseline.txt with the join that makes it safe.")
	}
	if len(stale) > 0 {
		fmt.Fprintln(os.Stderr, "invocation-scope: baseline entries that no longer match a reported launch:")
		for _, s := range stale {
			fmt.Fprintf(os.Stderr, "  - %s\n", s)
		}
		fmt.Fprintln(os.Stderr, "Remove the stale entry: the sweep table must describe the launches the proof cannot discharge.")
	}
	if len(newSites) > 0 || len(stale) > 0 {
		os.Exit(1)
	}

	fmt.Printf("invocation-scope: PASS (%d launch site(s) justified by the baseline)\n", len(byKey))
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

// assignNth numbers the sites of each (path, function) pair in the order the
// scanner reported them, so a site key is unique and stable: the enclosing
// function is part of the key, and two functions in one file cannot collide.
func assignNth(sites []site) []site {
	counts := map[string]int{}
	out := make([]site, 0, len(sites))
	for _, s := range sites {
		prefix := s.path + "|" + s.fn
		counts[prefix]++
		s.nth = counts[prefix]
		out = append(out, s)
	}
	return out
}

// ---------------------------------------------------------------------------
// Go scanning
// ---------------------------------------------------------------------------

// scanGo reports every unjoined asynchronous launch in the non-test Go sources
// below the given roots.
func scanGo(roots ...string) ([]site, error) {
	var found []site
	for _, root := range roots {
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
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			src, readErr := os.ReadFile(path) //nolint:gosec // The path comes from the repository walk, not from caller input.
			if readErr != nil {
				return readErr
			}
			fset := token.NewFileSet()
			rel := filepath.ToSlash(path)
			goSites, scanErr := scanGoSource(fset, rel, src)
			if scanErr != nil {
				return fmt.Errorf("parse %s: %w", rel, scanErr)
			}
			for _, s := range goSites {
				if s.Joined {
					continue
				}
				found = append(found, s.site())
			}
			return nil
		})
		if walkErr != nil {
			return nil, walkErr
		}
	}
	sortSites(found)
	return assignNth(found), nil
}

func sortSites(sites []site) {
	sort.SliceStable(sites, func(i, j int) bool {
		if sites[i].path != sites[j].path {
			return sites[i].path < sites[j].path
		}
		if sites[i].line != sites[j].line {
			return sites[i].line < sites[j].line
		}
		return sites[i].kind < sites[j].kind
	})
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

// goLaunchSite is one Go launch located by the AST scanner: a goroutine launch
// (`go` statement or errgroup method) or a timer that schedules work past the
// caller's return.
type goLaunchSite struct {
	Rel      string
	Text     string
	Func     string
	Evidence string
	Kind     string
	Line     int
	Joined   bool
}

func (s goLaunchSite) site() site {
	return site{path: s.Rel, fn: s.Func, kind: s.Kind, line: s.Line}
}

// funcBody pairs a function's body with the declaration that owns it, so a
// launch can be attributed and named.
type funcBody struct {
	body *ast.BlockStmt
	decl ast.Node
}

// timerAPINames are the time package constructors that start a timer or a
// ticker. AfterFunc runs its callback on a goroutine of its own; a ticker or a
// timer left running keeps that machinery alive past the invocation.
var timerAPINames = map[string]bool{
	"AfterFunc": true,
	"NewTimer":  true,
	"NewTicker": true,
	"Tick":      true,
}

// timerAPITick is the one tracked constructor that offers no way to be stopped.
const timerAPITick = "Tick"

// scanGoSource parses Go source with go/ast — never a regex — and returns every
// launch it contains with the result of the join proof.
//
// Three launch mechanisms are found: `go` statements, errgroup-style
// `<g>.Go(func(){...})` calls (errgroup hides a goroutine behind an ordinary
// method call), and the timer APIs that run a callback or deliver ticks after
// the caller returns (time.AfterFunc, time.NewTimer, time.NewTicker, time.Tick)
// when no join dominates.
func scanGoSource(fset *token.FileSet, rel string, src []byte) ([]goLaunchSite, error) {
	file, err := parser.ParseFile(fset, rel, src, parser.ParseComments|parser.SkipObjectResolution)
	if err != nil {
		return nil, err
	}
	timePkgs := timePackageNames(file)

	var bodies []funcBody
	ast.Inspect(file, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.FuncDecl:
			if x.Body != nil {
				bodies = append(bodies, funcBody{body: x.Body, decl: x})
			}
		case *ast.FuncLit:
			if x.Body != nil {
				bodies = append(bodies, funcBody{body: x.Body, decl: x})
			}
		}
		return true
	})

	var sites []goLaunchSite
	record := func(node ast.Node, launched *ast.BlockStmt, recv string, errgroup bool, kind string) {
		owner := innermostFuncBody(bodies, node.Pos(), node.End())
		pos := fset.Position(node.Pos())
		launch := goLaunchSite{
			Rel:  rel,
			Line: pos.Line,
			Text: strings.TrimSpace(sourceLine(src, pos.Line)),
			Kind: kind,
			Func: ownerName(bodies, node.Pos(), node.End()),
		}
		if owner != nil {
			if errgroup {
				launch.Joined, launch.Evidence = errgroupLaunchJoined(owner.body, node.Pos(), recv)
			} else {
				launch.Joined, launch.Evidence = goLaunchJoined(owner.body, node.Pos(), launched)
			}
		}
		sites = append(sites, launch)
	}

	ast.Inspect(file, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.GoStmt:
			record(x, launchedFuncBody(x), "", false, "go-statement")
		case *ast.CallExpr:
			if launched, recv, ok := errgroupFuncLit(x); ok {
				record(x, launched, recv, true, "errgroup-launch")
			}
		}
		return true
	})

	scanDetachedTimers(fset, rel, src, file, bodies, timePkgs, &sites)
	return sites, nil
}

// timePackageNames returns every local name the file binds to the time package,
// so `import tm "time"` is recognized on its own terms and a file that imports
// the package twice is still understood.
func timePackageNames(file *ast.File) map[string]bool {
	names := map[string]bool{}
	for _, imp := range file.Imports {
		if strings.Trim(imp.Path.Value, `"`) != "time" {
			continue
		}
		switch {
		case imp.Name == nil:
			names["time"] = true
		case imp.Name.Name == "_" || imp.Name.Name == ".":
			// A blank or dot import gives the file no selector to match.
		default:
			names[imp.Name.Name] = true
		}
	}
	return names
}

// timerConstructor recognizes the timer APIs that keep work running past the
// caller's return. time.Tick is included because its ticker can never be
// stopped; the others are reported only when no join dominates. The returned
// name is the API's selector (for example "NewTimer"), so an aliased import is
// matched on its own terms.
func timerConstructor(call *ast.CallExpr, timePkgs map[string]bool) (string, bool) {
	if len(timePkgs) == 0 {
		return "", false
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return "", false
	}
	pkg, ok := sel.X.(*ast.Ident)
	if !ok || !timePkgs[pkg.Name] || !timerAPINames[sel.Sel.Name] {
		return "", false
	}
	return sel.Sel.Name, true
}

// timerBinding is one tracked timer constructor with the handle the statement
// binding it names, if any.
type timerBinding struct {
	call *ast.CallExpr
	api  string
	name string
}

// timerBindings collects every tracked timer constructor in the file with the
// handle binding it: an assignment or var declaration names the handle, a bare
// call binds nothing, and a constructor nested inside a larger expression binds
// nothing the proof can follow.
func timerBindings(file *ast.File, timePkgs map[string]bool) []timerBinding {
	var bindings []timerBinding
	handled := map[token.Pos]bool{}
	add := func(call *ast.CallExpr, api, name string) {
		if handled[call.Pos()] {
			return
		}
		handled[call.Pos()] = true
		bindings = append(bindings, timerBinding{call: call, api: api, name: name})
	}

	ast.Inspect(file, func(n ast.Node) bool {
		if call, api, name, ok := boundTimerCall(n, timePkgs); ok {
			add(call, api, name)
		}
		return true
	})

	// Anything the statement pass did not attribute (for example a constructor
	// nested inside a larger expression) is still a timer nobody can join.
	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || handled[call.Pos()] {
			return true
		}
		if api, isTimer := timerConstructor(call, timePkgs); isTimer {
			add(call, api, "")
		}
		return true
	})
	return bindings
}

// boundTimerCall returns the tracked timer constructor a binding statement
// declares and the handle name that statement gives it.
func boundTimerCall(n ast.Node, timePkgs map[string]bool) (*ast.CallExpr, string, string, bool) {
	switch x := n.(type) {
	case *ast.AssignStmt:
		for i, rhs := range x.Rhs {
			call, ok := rhs.(*ast.CallExpr)
			if !ok {
				continue
			}
			if api, isTimer := timerConstructor(call, timePkgs); isTimer && i < len(x.Lhs) {
				return call, api, exprText(x.Lhs[i]), true
			}
		}
	case *ast.ValueSpec:
		for i, value := range x.Values {
			call, ok := value.(*ast.CallExpr)
			if !ok {
				continue
			}
			if api, isTimer := timerConstructor(call, timePkgs); isTimer && i < len(x.Names) {
				return call, api, x.Names[i].Name, true
			}
		}
	case *ast.ExprStmt:
		call, ok := x.X.(*ast.CallExpr)
		if !ok {
			return nil, "", "", false
		}
		if api, isTimer := timerConstructor(call, timePkgs); isTimer {
			return call, api, "", true
		}
	}
	return nil, "", "", false
}

// scanDetachedTimers reports timer constructors that schedule work past the
// caller's return unless a join on the handle dominates every exit: a Stop() on
// every path, or (for a timer that can fire) a receive from its channel. A
// constructor the statement pass cannot attribute is reported as unmanaged.
func scanDetachedTimers(fset *token.FileSet, rel string, src []byte, file *ast.File, bodies []funcBody, timePkgs map[string]bool, sites *[]goLaunchSite) {
	for _, binding := range timerBindings(file, timePkgs) {
		call := binding.call
		owner := innermostFuncBody(bodies, call.Pos(), call.End())
		if binding.api != timerAPITick && binding.name != "" && owner != nil &&
			timerHandleJoined(owner.body, call.Pos(), binding.name, binding.api) {
			// A join on the handle dominates every exit of the owning function,
			// so nothing fires after this function returns.
			continue
		}
		pos := fset.Position(call.Pos())
		evidence := fmt.Sprintf("%s schedules work that runs after the enclosing function returns and no join on it dominates every exit", binding.api)
		if binding.name == "" && binding.api != timerAPITick {
			evidence = fmt.Sprintf("%s returns a handle nothing binds, so it cannot be joined", binding.api)
		}
		if binding.api == timerAPITick {
			evidence = "time.Tick returns a channel whose ticker can never be stopped, so it outlives every caller"
		}
		*sites = append(*sites, goLaunchSite{
			Rel:      rel,
			Line:     pos.Line,
			Text:     strings.TrimSpace(sourceLine(src, pos.Line)),
			Func:     ownerName(bodies, call.Pos(), call.End()),
			Kind:     "detached-timer",
			Joined:   false,
			Evidence: evidence,
		})
	}
}

// errgroupFuncLit recognizes an errgroup-style launch: a call to a method named
// Go whose argument is a function literal. It returns the literal's body and
// the receiver expression used to name the group.
func errgroupFuncLit(call *ast.CallExpr) (*ast.BlockStmt, string, bool) {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "Go" {
		return nil, "", false
	}
	for _, arg := range call.Args {
		if lit, ok := arg.(*ast.FuncLit); ok {
			return lit.Body, exprText(sel.X), true
		}
	}
	return nil, "", false
}

// isMethodCall reports whether node is a call of the form <recv>.<method>(...).
func isMethodCall(node ast.Node, recv, method string) bool {
	call, ok := node.(*ast.CallExpr)
	if !ok {
		return false
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != method {
		return false
	}
	return exprText(sel.X) == recv
}

// innermostFuncBody returns the tightest function body containing [start,end).
func innermostFuncBody(bodies []funcBody, start, end token.Pos) *funcBody {
	var best *funcBody
	for i := range bodies {
		b := &bodies[i]
		if b.body.Pos() <= start && end <= b.body.End() {
			if best == nil || b.body.Pos() > best.body.Pos() {
				best = b
			}
		}
	}
	return best
}

// ownerName names the function that owns a launch: the innermost enclosing
// FuncDecl, plus a `<func literal>` marker when the launch sits inside a closure,
// so the key always names the enclosing function (G4) and a closure never
// borrows another function's name silently.
func ownerName(bodies []funcBody, start, end token.Pos) string {
	inner := innermostFuncBody(bodies, start, end)
	if inner == nil {
		return "<file>"
	}
	if _, isLit := inner.decl.(*ast.FuncLit); !isLit {
		return funcName(inner.decl)
	}
	// The launch is inside a closure: name the closure after the nearest
	// enclosing declaration.
	outer := enclosingDeclBody(bodies, inner.body.Pos())
	if outer == nil {
		return "<file>.<func literal>"
	}
	return funcName(outer) + ".<func literal>"
}

// enclosingDeclBody returns the tightest FuncDecl body strictly containing pos.
func enclosingDeclBody(bodies []funcBody, pos token.Pos) ast.Node {
	var best ast.Node
	for i := range bodies {
		if _, isLit := bodies[i].decl.(*ast.FuncLit); isLit {
			continue
		}
		if bodies[i].body.Pos() < pos && pos <= bodies[i].body.End() {
			if best == nil || bodies[i].body.Pos() > best.Pos() {
				best = bodies[i].decl
			}
		}
	}
	return best
}

// funcName renders a stable name for a FuncDecl owner.
func funcName(decl ast.Node) string {
	x, ok := decl.(*ast.FuncDecl)
	if !ok || x.Name == nil {
		return "<func literal>"
	}
	if x.Recv != nil && len(x.Recv.List) > 0 {
		return "(" + typeName(x.Recv.List[0].Type) + ")." + x.Name.Name
	}
	return x.Name.Name
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

// ---------------------------------------------------------------------------
// Join dominance
// ---------------------------------------------------------------------------
//
// A launch counts as joined only when the join dominates every exit from the
// scope that launched it. The analysis walks the statement lists of the owner
// function (blocks, if/else bodies, loops, switch and select clauses) and asks:
// starting at the statement after the launch, does every path that reaches a
// return of the owner execute the join first?
//
// It is deliberately structural and conservative in the direction that matters:
// a shape it does not model is reported as unjoined rather than assumed joined.

// joinFlow describes how a statement-list region treats the join.
type joinFlow int

const (
	// flowContinues: no path executed the join, and no path left the owner.
	flowContinues joinFlow = iota
	// flowJoined: every path through the region executed the join.
	flowJoined
	// flowEscaped: some path returned from the owner without the join.
	flowEscaped
	// flowStops: no path falls through the region and none escapes it (an
	// infinite loop whose body never returns without a join).
	flowStops
)

// stmtList is one statement list inside a function body, linked to the list
// that contains it so a launch can be followed forward through every enclosing
// block up to the function's own body.
type stmtList struct {
	parent    *stmtList
	stmts     []ast.Stmt
	parentIdx int
	depth     int
	ownerBody bool
}

// buildStmtLists builds the statement-list tree of a function body.
func buildStmtLists(body *ast.BlockStmt) []*stmtList {
	root := &stmtList{stmts: body.List, ownerBody: true}
	all := []*stmtList{root}
	var walk func(list *stmtList)
	walk = func(list *stmtList) {
		for i, stmt := range list.stmts {
			for _, childStmts := range childStatementLists(stmt) {
				child := &stmtList{stmts: childStmts, parent: list, parentIdx: i, depth: list.depth + 1}
				all = append(all, child)
				walk(child)
			}
		}
	}
	walk(root)
	return all
}

// childStatementLists returns the statement lists directly inside stmt. Bodies
// of closures are not returned: a function literal's body belongs to its own
// function and is analyzed as its own owner.
func childStatementLists(stmt ast.Stmt) [][]ast.Stmt {
	switch s := stmt.(type) {
	case *ast.BlockStmt:
		return [][]ast.Stmt{s.List}
	case *ast.IfStmt:
		lists := [][]ast.Stmt{s.Body.List}
		switch e := s.Else.(type) {
		case *ast.BlockStmt:
			lists = append(lists, e.List)
		case *ast.IfStmt:
			lists = append(lists, childStatementLists(e)...)
		}
		return lists
	case *ast.ForStmt:
		return [][]ast.Stmt{s.Body.List}
	case *ast.RangeStmt:
		return [][]ast.Stmt{s.Body.List}
	case *ast.SwitchStmt:
		return blockList(s.Body)
	case *ast.TypeSwitchStmt:
		return blockList(s.Body)
	case *ast.SelectStmt:
		return blockList(s.Body)
	case *ast.CaseClause:
		return [][]ast.Stmt{s.Body}
	case *ast.CommClause:
		return [][]ast.Stmt{s.Body}
	case *ast.LabeledStmt:
		return childStatementLists(s.Stmt)
	}
	return nil
}

// blockList is the statement list of a clause block, or nil when there is none.
func blockList(body *ast.BlockStmt) [][]ast.Stmt {
	if body == nil {
		return nil
	}
	return [][]ast.Stmt{body.List}
}

// launchList returns the innermost statement list holding the launch statement,
// together with that statement's index.
func launchList(all []*stmtList, launchPos token.Pos) (*stmtList, int) {
	var best *stmtList
	bestIdx := -1
	for _, list := range all {
		for i, stmt := range list.stmts {
			if stmt.Pos() <= launchPos && launchPos < stmt.End() {
				if best == nil || list.depth > best.depth {
					best, bestIdx = list, i
				}
			}
		}
	}
	return best, bestIdx
}

// joinDominates reports whether every path from the statement after the launch
// to a return of the owning function executes the join described by isJoin. A
// `defer <join>` registered before the launch counts too: it runs whenever the
// function returns, so it covers every return path the launch can reach.
func joinDominates(all []*stmtList, launchPos token.Pos, isJoin func(ast.Node) bool) bool {
	list, idx := launchList(all, launchPos)
	if list == nil {
		return false
	}
	if deferredJoinBeforeLaunch(list, idx, isJoin) {
		return true
	}
	flow := listFlow(list.stmts, idx+1, list.ownerBody, isJoin)
	for flow == flowContinues && list.parent != nil {
		parent := list.parent
		flow = listFlow(parent.stmts, list.parentIdx+1, parent.ownerBody, isJoin)
		list = parent
	}
	return flow == flowJoined
}

// deferredJoinBefore reports whether an unconditional `defer <join>` was
// registered before the launch described by launchPos reaches it. It exists for
// the join evidence wording; joinDominates already accepts the shape.
func deferredJoinBefore(all []*stmtList, launchPos token.Pos, isJoin func(ast.Node) bool) bool {
	list, idx := launchList(all, launchPos)
	if list == nil {
		return false
	}
	return deferredJoinBeforeLaunch(list, idx, isJoin)
}

// deferredJoinBeforeLaunch reports whether an unconditional `defer <join>`
// executes before the launch on every path that reaches it: the defer sits in
// the launch's own statement list ahead of the launch, or in an enclosing list
// ahead of the statement that leads down to the launch. Registered that way it
// runs before any return the launch can reach, so it covers every return path.
//
// A defer the walk cannot place that way — one behind a branch, or one
// registered after a possible return — is not a join, and a defer not reached
// on every path leaves the launch reported as unjoined.
//
// A `goto` or a labeled `break`/`continue` anywhere ahead of the launch
// disqualifies the pre-check. Such a branch can jump past the registration and
// land on the launch, so the defer's presence in the prefix no longer proves it
// ran; the launch then falls through to the forward flow walk, which reports it
// unless a join dominates from the launch onward.
func deferredJoinBeforeLaunch(list *stmtList, idx int, isJoin func(ast.Node) bool) bool {
	for list != nil {
		for i := 0; i < idx; i++ {
			if hasBranchStmt(list.stmts[i]) {
				return false
			}
			if isDeferredJoin(list.stmts[i], isJoin) {
				return true
			}
		}
		list = list.parent
		if list != nil {
			idx = list.parentIdx
		}
	}
	return false
}

// hasBranchStmt reports whether stmt contains a `goto` or a labeled
// break/continue. Any of them can transfer control to a label that the prefix
// scan cannot follow, so a defer reached through the prefix is not proven to
// have run.
func hasBranchStmt(stmt ast.Stmt) bool {
	found := false
	ast.Inspect(stmt, func(n ast.Node) bool {
		if found {
			return false
		}
		branch, ok := n.(*ast.BranchStmt)
		if ok && (branch.Tok == token.GOTO || branch.Label != nil) {
			found = true
			return false
		}
		return true
	})
	return found
}

// isDeferredJoin reports whether stmt is a `defer <join>` whose deferred call is
// the join itself, executed unconditionally.
func isDeferredJoin(stmt ast.Stmt, isJoin func(ast.Node) bool) bool {
	deferStmt, ok := stmt.(*ast.DeferStmt)
	if !ok {
		return false
	}
	return executesJoinUnconditionally(deferStmt.Call, isJoin)
}

// listFlow classifies statements[i:] of one statement list.
func listFlow(stmts []ast.Stmt, i int, ownerBody bool, isJoin func(ast.Node) bool) joinFlow {
	for ; i < len(stmts); i++ {
		flow := statementFlow(stmts[i], isJoin)
		switch flow {
		case flowEscaped, flowJoined, flowStops:
			return flow
		}
	}
	if ownerBody {
		// Falling off the end of the owner body is a return without the join.
		return flowEscaped
	}
	return flowContinues
}

// statementFlow classifies every path through stmt. The statement kinds are the
// shape of the analysis itself, so the branch count is intrinsic to it.
//
//nolint:gocyclo // One branch per Go statement kind is the analysis; splitting it would scatter the flow rules.
func statementFlow(stmt ast.Stmt, isJoin func(ast.Node) bool) joinFlow {
	if executesJoinUnconditionally(stmt, isJoin) {
		return flowJoined
	}
	switch s := stmt.(type) {
	case *ast.ReturnStmt:
		return flowEscaped
	case *ast.DeferStmt:
		// Reaching an unconditional `defer <join>` joins the work: the join runs
		// whenever the function returns, so every later return path covers it.
		if executesJoinUnconditionally(s.Call, isJoin) {
			return flowJoined
		}
		return flowContinues
	case *ast.BranchStmt:
		// break/continue without a label stay inside the enclosing loop or
		// clause and reach the join afterwards. A labeled branch, or a goto,
		// can leave the region the join is checked over.
		if s.Label != nil || s.Tok == token.GOTO {
			return flowEscaped
		}
		return flowContinues
	case *ast.ExprStmt:
		if call, ok := s.X.(*ast.CallExpr); ok {
			if id, ok := call.Fun.(*ast.Ident); ok && id.Name == "panic" {
				return flowEscaped
			}
		}
		return flowContinues
	case *ast.BlockStmt:
		return listFlow(s.List, 0, false, isJoin)
	case *ast.IfStmt:
		// A join in the condition runs before either branch is taken, so both
		// branches are covered by it. Only the left operand of a short-circuit
		// operator is evaluated unconditionally.
		if conditionJoins(s.Cond, isJoin) {
			return flowJoined
		}
		thenFlow := listFlow(s.Body.List, 0, false, isJoin)
		elseFlow := flowContinues
		if e, ok := s.Else.(*ast.BlockStmt); ok {
			elseFlow = listFlow(e.List, 0, false, isJoin)
		} else if e, ok := s.Else.(*ast.IfStmt); ok {
			elseFlow = statementFlow(e, isJoin)
		}
		return combineFlows(thenFlow, elseFlow)
	case *ast.ForStmt:
		return loopFlow(s.Body.List, isJoin, s.Cond == nil && !hasUnlabeledBreak(s.Body))
	case *ast.RangeStmt:
		return loopFlow(s.Body.List, isJoin, false)
	case *ast.SwitchStmt:
		return switchFlow(s.Body, isJoin)
	case *ast.TypeSwitchStmt:
		return switchFlow(s.Body, isJoin)
	case *ast.SelectStmt:
		return selectFlow(s, isJoin)
	case *ast.LabeledStmt:
		return statementFlow(s.Stmt, isJoin)
	}
	return flowContinues
}

// combineFlows merges the flows of an if statement's branches. An escape on
// either branch escapes; a join is claimed only when every branch either joins
// or never falls through, and at least one of them joins.
func combineFlows(flows ...joinFlow) joinFlow {
	allJoinOrStop := len(flows) > 0
	anyJoined := false
	for _, flow := range flows {
		switch flow {
		case flowEscaped:
			return flowEscaped
		case flowJoined:
			anyJoined = true
		case flowStops:
			// No fallthrough, no escape: this branch contributes nothing.
		default:
			allJoinOrStop = false
		}
	}
	switch {
	case allJoinOrStop && anyJoined:
		return flowJoined
	case allJoinOrStop:
		return flowStops
	default:
		return flowContinues
	}
}

// loopFlow handles for and range bodies. A loop that may run zero times can
// never prove the join on its own; a body that returns without the join is an
// escape. A `for {}` loop with no condition and no break never falls through, so
// a body that joins covers every path out of it.
func loopFlow(body []ast.Stmt, isJoin func(ast.Node) bool, infinite bool) joinFlow {
	bodyFlow := listFlow(body, 0, false, isJoin)
	switch bodyFlow {
	case flowEscaped:
		return flowEscaped
	case flowJoined:
		if infinite {
			return flowJoined
		}
		return flowContinues
	default:
		if infinite {
			return flowStops
		}
		return flowContinues
	}
}

// hasUnlabeledBreak reports whether body contains a break that transfers to the
// loop this body belongs to. A break inside a nested function belongs to that
// function's loop, so the walk does not descend into function literals.
func hasUnlabeledBreak(body *ast.BlockStmt) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.FuncLit:
			return false
		case *ast.BranchStmt:
			if x.Tok == token.BREAK && x.Label == nil {
				found = true
			}
		}
		return !found
	})
	return found
}

// switchFlow handles switch and type-switch bodies. A switch with a default
// clause and every clause joining is a join; without a default the subject can
// match nothing and fall through, so it only ever continues.
func switchFlow(body *ast.BlockStmt, isJoin func(ast.Node) bool) joinFlow {
	if body == nil {
		return flowContinues
	}
	hasDefault := false
	allJoined := true
	for _, clause := range body.List {
		cc, ok := clause.(*ast.CaseClause)
		if !ok {
			allJoined = false
			continue
		}
		if cc.List == nil {
			hasDefault = true
		}
		switch listFlow(cc.Body, 0, false, isJoin) {
		case flowEscaped:
			return flowEscaped
		case flowJoined:
		default:
			allJoined = false
		}
	}
	if hasDefault && allJoined {
		return flowJoined
	}
	return flowContinues
}

// selectFlow handles select statements. A select always runs exactly one of its
// clauses, so every clause joining is a join; a clause that merely continues,
// or that escapes, is not.
func selectFlow(stmt *ast.SelectStmt, isJoin func(ast.Node) bool) joinFlow {
	if stmt.Body == nil || len(stmt.Body.List) == 0 {
		return flowContinues
	}
	allJoined := true
	for _, clause := range stmt.Body.List {
		cc, ok := clause.(*ast.CommClause)
		if !ok {
			allJoined = false
			continue
		}
		if clauseCommIsJoin(cc.Comm, isJoin) {
			// `case <-done:` is the join itself: the clause runs only when the
			// receive completes.
			continue
		}
		switch listFlow(cc.Body, 0, false, isJoin) {
		case flowEscaped:
			return flowEscaped
		case flowJoined:
		default:
			allJoined = false
		}
	}
	if allJoined {
		return flowJoined
	}
	return flowContinues
}

// clauseCommIsJoin reports whether a select clause's own communication is the
// join: `case <-done:` or `case res := <-done:`.
func clauseCommIsJoin(comm ast.Stmt, isJoin func(ast.Node) bool) bool {
	switch c := comm.(type) {
	case nil:
		return false
	case *ast.ExprStmt:
		return isJoin(c.X)
	case *ast.AssignStmt:
		for _, rhs := range c.Rhs {
			if isJoin(rhs) {
				return true
			}
		}
		return false
	default:
		return isJoin(c)
	}
}

// executesJoinUnconditionally reports whether node executes the join whenever
// node itself executes: the join is not inside a closure, a conditional, a
// loop, a deferred call, or a launched goroutine.
func executesJoinUnconditionally(node ast.Node, isJoin func(ast.Node) bool) bool {
	found := false
	ast.Inspect(node, func(n ast.Node) bool {
		if n == nil {
			return true
		}
		if isJoin(n) {
			found = true
			return false
		}
		switch n.(type) {
		case *ast.FuncLit, *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt,
			*ast.SwitchStmt, *ast.TypeSwitchStmt, *ast.SelectStmt,
			*ast.DeferStmt, *ast.GoStmt:
			return false
		}
		return true
	})
	return found
}

// conditionJoins reports whether an if condition executes the join whenever the
// statement executes. The left operand of `&&`/`||` is always evaluated, so a
// join there counts; the right operand is not, so a join there does not.
func conditionJoins(node ast.Node, isJoin func(ast.Node) bool) bool {
	if node == nil {
		return false
	}
	if isJoin(node) {
		return true
	}
	switch x := node.(type) {
	case *ast.FuncLit:
		return false
	case *ast.BinaryExpr:
		if x.Op == token.LAND || x.Op == token.LOR {
			return conditionJoins(x.X, isJoin)
		}
	}
	found := false
	ast.Inspect(node, func(child ast.Node) bool {
		if child == nil || found {
			return false
		}
		if child == node {
			return true
		}
		if conditionJoins(child, isJoin) {
			found = true
		}
		return false
	})
	return found
}

// ---------------------------------------------------------------------------
// The recognized join shapes
// ---------------------------------------------------------------------------

// goLaunchJoined reports whether the goroutine started at launchPos is joined
// before the enclosing function can return: for every path from the launch to a
// return, the join runs first.
//
// Two shapes are recognized, and nothing else:
//
//  1. sync.WaitGroup — an Add on the group runs unconditionally in the same
//     statement list before the launch, the launched function calls Done on it,
//     and a Wait on the same group dominates every return path. A `defer
//     wg.Wait()` registered after the Add and before any return dominates too,
//     because it runs whenever the function returns.
//  2. A channel the launched function closes after its last send: the channel is
//     unbuffered and declared before the launch, the goroutine's only operations
//     on it are sends followed by a deferred or final close (and never a
//     receive), and the owner drains it after the launch on every return path.
//     When the goroutine sends on the channel, only a `for range` drain counts,
//     because a single receive leaves the remaining sends blocked; a close-only
//     goroutine is proven finished by any receive.
//
// Everything else — a named function launch (whose body is not visible here), a
// Wait inside a conditional or a never-called closure, a launch with a return
// before the Wait, a deferred Wait registered after a possible return, a channel
// whose sends outnumber the receives, a sent-on but unbuffered channel never
// drained — is reported as unjoined rather than assumed joined.
func goLaunchJoined(owner *ast.BlockStmt, launchPos token.Pos, launched *ast.BlockStmt) (bool, string) {
	if owner == nil {
		return false, ""
	}
	lists := buildStmtLists(owner)

	if joined, evidence := waitGroupJoined(lists, launchPos, launched); joined {
		return true, evidence
	}
	if joined, evidence := channelJoined(lists, owner, launchPos, launched); joined {
		return true, evidence
	}
	return false, ""
}

// timerHandleJoined reports whether a timer handle is joined on every path out
// of the owning function: a Stop() that dominates every exit, or — for a timer
// that fires once, whose channel receive proves it already fired — a receive
// from the handle's channel on every path. A ticker keeps firing, so only Stop
// releases it.
func timerHandleJoined(owner *ast.BlockStmt, launchPos token.Pos, name, api string) bool {
	if owner == nil || name == "" {
		return false
	}
	lists := buildStmtLists(owner)
	fires := api != "NewTicker"
	isJoin := func(n ast.Node) bool {
		if isMethodCall(n, name, "Stop") {
			return true
		}
		if !fires {
			return false
		}
		receive, ok := n.(*ast.UnaryExpr)
		return ok && receive.Op == token.ARROW && exprText(receive.X) == name+".C"
	}
	return joinDominates(lists, launchPos, isJoin)
}

// waitGroupJoined implements join shape 1.
func waitGroupJoined(lists []*stmtList, launchPos token.Pos, launched *ast.BlockStmt) (bool, string) {
	if launched == nil {
		return false, ""
	}
	list, idx := launchList(lists, launchPos)
	if list == nil {
		return false, ""
	}
	name := addBeforeLaunch(list, idx)
	if name == "" {
		return false, ""
	}
	if !bodyCallsMethod(launched, name, "Done") {
		return false, ""
	}
	isWait := func(n ast.Node) bool {
		return isMethodCall(n, name, "Wait")
	}
	if !joinDominates(lists, launchPos, isWait) {
		return false, ""
	}
	join := fmt.Sprintf("a Wait on %s runs on every return path after it", name)
	if deferredJoinBefore(lists, launchPos, isWait) {
		join = fmt.Sprintf("`defer %s.Wait()` is registered before the launch, so the join runs whenever the function returns", name)
	}
	return true, fmt.Sprintf("WaitGroup %s: Add runs before the launch, the goroutine calls Done, and %s", name, join)
}

// addBeforeLaunch returns the name of a WaitGroup whose Add runs
// unconditionally before the launch inside the launch's own statement list. The
// Add must be in that list: an Add in an enclosing block cannot be shown to
// cover this launch, so those shapes are reported as unjoined.
func addBeforeLaunch(list *stmtList, idx int) string {
	for i := 0; i < idx; i++ {
		if name := unconditionalAddTarget(list.stmts[i]); name != "" {
			return name
		}
	}
	return ""
}

// unconditionalAddTarget returns the receiver of an `.Add(` call that executes
// whenever the statement executes.
func unconditionalAddTarget(stmt ast.Stmt) string {
	found := ""
	ast.Inspect(stmt, func(n ast.Node) bool {
		if found != "" {
			return false
		}
		if call, ok := n.(*ast.CallExpr); ok {
			if sel, ok := call.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "Add" {
				found = exprText(sel.X)
				return false
			}
		}
		switch n.(type) {
		case *ast.FuncLit, *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt,
			*ast.SwitchStmt, *ast.TypeSwitchStmt, *ast.SelectStmt,
			*ast.DeferStmt, *ast.GoStmt:
			return false
		}
		return true
	})
	return found
}

// channelJoined implements join shape 2.
func channelJoined(lists []*stmtList, owner *ast.BlockStmt, launchPos token.Pos, launched *ast.BlockStmt) (bool, string) {
	if launched == nil {
		return false, ""
	}
	for _, name := range unbufferedChannelsBefore(owner, launchPos) {
		if !bodyClosesChannel(launched, name) {
			continue
		}
		if bodyReceivesOn(launched, name) {
			continue
		}
		sends := bodySendsOn(launched, name)
		isJoin := func(n ast.Node) bool {
			if receive, ok := n.(*ast.UnaryExpr); ok && receive.Op == token.ARROW {
				return exprText(receive.X) == name
			}
			if rng, ok := n.(*ast.RangeStmt); ok {
				if _, ok := rng.X.(*ast.Ident); ok && exprText(rng.X) == name {
					return true
				}
			}
			return false
		}
		if sends {
			// A range drain consumes every send up to the close; a single
			// receive would leave the remaining sends blocked, so only the drain
			// proves the goroutine finished.
			isJoin = func(n ast.Node) bool {
				rng, ok := n.(*ast.RangeStmt)
				return ok && exprText(rng.X) == name
			}
		}
		if !joinDominates(lists, launchPos, isJoin) {
			continue
		}
		data := "a `for range` drain on every return path after the launch consumes every send it makes"
		if !sends {
			data = "a receive on every return path after the launch proves the close ran"
		}
		return true, fmt.Sprintf("channel %s (unbuffered): declared before the launch, closed by the goroutine as its last action, and %s", name, data)
	}
	return false, ""
}

// unbufferedChannelsBefore returns the names of unbuffered channels declared
// with make(chan T) before launchPos in the owner body.
func unbufferedChannelsBefore(owner *ast.BlockStmt, launchPos token.Pos) []string {
	var names []string
	ast.Inspect(owner, func(n ast.Node) bool {
		assign, ok := n.(*ast.AssignStmt)
		if !ok {
			return true
		}
		for i, rhs := range assign.Rhs {
			if i >= len(assign.Lhs) || !isUnbufferedMakeChan(rhs) {
				continue
			}
			id, ok := assign.Lhs[i].(*ast.Ident)
			if ok && assign.Pos() < launchPos {
				names = append(names, id.Name)
			}
		}
		return true
	})
	return names
}

// bodyClosesChannel reports whether body closes name as its last action: a
// deferred close, or a close that is the last top-level statement. A close that
// happens before other work proves nothing about the goroutine finishing.
func bodyClosesChannel(body *ast.BlockStmt, name string) bool {
	if body == nil {
		return false
	}
	for _, stmt := range body.List {
		if deferStmt, ok := stmt.(*ast.DeferStmt); ok {
			if call, ok := deferStmt.Call.Fun.(*ast.Ident); ok && call.Name == "close" &&
				len(deferStmt.Call.Args) == 1 && exprText(deferStmt.Call.Args[0]) == name {
				return true
			}
		}
	}
	if len(body.List) == 0 {
		return false
	}
	last, ok := body.List[len(body.List)-1].(*ast.ExprStmt)
	if !ok {
		return false
	}
	call, ok := last.X.(*ast.CallExpr)
	if !ok {
		return false
	}
	id, ok := call.Fun.(*ast.Ident)
	return ok && id.Name == "close" && len(call.Args) == 1 && exprText(call.Args[0]) == name
}

// bodyReceivesOn reports whether body receives from name.
func bodyReceivesOn(body *ast.BlockStmt, name string) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		receive, ok := n.(*ast.UnaryExpr)
		if ok && receive.Op == token.ARROW && exprText(receive.X) == name {
			found = true
		}
		return true
	})
	return found
}

// bodySendsOn reports whether body sends on name.
func bodySendsOn(body *ast.BlockStmt, name string) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		send, ok := n.(*ast.SendStmt)
		if ok && exprText(send.Chan) == name {
			found = true
		}
		return true
	})
	return found
}

// errgroupLaunchJoined reports whether an errgroup-style launch is joined: a
// Wait on the same group runs on every return path after the launch, whether it
// is an ordinary Wait or a deferred one registered before the launch. errgroup's
// Wait is the only join it offers, and it joins every launch on that group.
func errgroupLaunchJoined(owner *ast.BlockStmt, launchPos token.Pos, recv string) (bool, string) {
	if owner == nil || recv == "" {
		return false, ""
	}
	lists := buildStmtLists(owner)
	isWait := func(n ast.Node) bool {
		return isMethodCall(n, recv, "Wait")
	}
	if !joinDominates(lists, launchPos, isWait) {
		return false, ""
	}
	join := fmt.Sprintf("a Wait on %s runs on every return path after the launch", recv)
	if deferredJoinBefore(lists, launchPos, isWait) {
		join = fmt.Sprintf("`defer %s.Wait()` is registered before the launch, so the join runs whenever the function returns", recv)
	}
	return true, fmt.Sprintf("errgroup %s: %s", recv, join)
}

// bodyCallsMethod reports whether body calls <name>.<method>(...).
func bodyCallsMethod(body *ast.BlockStmt, name, method string) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		if isMethodCall(n, name, method) {
			found = true
		}
		return !found
	})
	return found
}

// launchedFuncBody returns the body of a `go func(){...}()` launch, or nil when
// the launched callable is a named function (whose body cannot be inspected
// here, so the launch is treated as unjoined).
func launchedFuncBody(goStmt *ast.GoStmt) *ast.BlockStmt {
	call, ok := goStmt.Call.Fun.(*ast.FuncLit)
	if !ok {
		return nil
	}
	return call.Body
}

// isUnbufferedMakeChan reports whether e is make(chan ...) with no buffer. A
// buffered channel's receive can complete before the goroutine finished, so only
// unbuffered channels can carry the close-signal join.
func isUnbufferedMakeChan(e ast.Expr) bool {
	call, ok := e.(*ast.CallExpr)
	if !ok {
		return false
	}
	id, ok := call.Fun.(*ast.Ident)
	if !ok || id.Name != "make" || len(call.Args) != 1 {
		return false
	}
	_, ok = call.Args[0].(*ast.ChanType)
	return ok
}

// exprText renders a short, stable source form for an expression, used only for
// naming (WaitGroup and channel identities) in join evidence.
func exprText(e ast.Expr) string {
	switch x := e.(type) {
	case *ast.Ident:
		return x.Name
	case *ast.SelectorExpr:
		return exprText(x.X) + "." + x.Sel.Name
	case *ast.StarExpr:
		return "*" + exprText(x.X)
	case *ast.IndexExpr:
		return exprText(x.X) + "[...]"
	default:
		return "?"
	}
}

// sourceLine returns the 1-based line from src, or "" when it is out of range.
func sourceLine(src []byte, line int) string {
	if line < 1 {
		return ""
	}
	lines := strings.Split(string(src), "\n")
	if line > len(lines) {
		return ""
	}
	return lines[line-1]
}

// ---------------------------------------------------------------------------
// Interpreter-invoked AST scanners
// ---------------------------------------------------------------------------

// errInterpreterMissing marks a scanner that could not run because the
// repository has no interpreter for that language. It is never a skip: the
// guard fails.
var errInterpreterMissing = errors.New("interpreter missing")

// guardDir is the directory holding this source file, so the guard finds its
// scanner helpers and the repository's Python virtualenv no matter which
// directory it is invoked from.
func guardDir() string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return "."
	}
	return filepath.Dir(file)
}

func repoRoot() string {
	return filepath.Dir(filepath.Dir(filepath.Dir(guardDir())))
}

type scanRequest struct {
	Files []scanFile `json:"files"`
}

type scanFile struct {
	Path   string `json:"path"`
	Source string `json:"source"`
}

type scanResponse struct {
	Results []scanResult `json:"results"`
}

type scanResult struct {
	Path     string        `json:"path"`
	Findings []scanFinding `json:"findings"`
	Error    string        `json:"error"`
}

type scanFinding struct {
	Path  string `json:"-"`
	Line  int    `json:"line"`
	Rule  string `json:"rule"`
	Scope string `json:"scope"`
	Text  string `json:"text"`
}

// collectSources gathers the files below root with the given extension, sorted
// by path so the scan is deterministic.
func collectSources(root, ext string) ([]scanFile, error) {
	var files []scanFile
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
			return readErr
		}
		files = append(files, scanFile{Path: filepath.ToSlash(path), Source: string(data)})
		return nil
	})
	if walkErr != nil {
		return nil, walkErr
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}

// runScanner invokes one interpreter-driven scanner over the given sources and
// returns its findings. A scanner that cannot run, or that reports a parse
// error, is an error the caller must not ignore.
func runScanner(interpreter string, script string, files []scanFile) ([]scanFinding, error) {
	request := scanRequest{Files: files}
	payload, err := json.Marshal(request)
	if err != nil {
		return nil, fmt.Errorf("encode scanner request: %w", err)
	}

	cmd := exec.CommandContext(context.Background(), interpreter, script) //nolint:gosec // interpreter and script are repository-resolved, not caller input.
	cmd.Stdin = bytes.NewReader(payload)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("run %s: %w: %s", filepath.Base(script), err, strings.TrimSpace(stderr.String()))
	}

	var response scanResponse
	if err := json.Unmarshal(stdout.Bytes(), &response); err != nil {
		return nil, fmt.Errorf("decode %s output: %w: %s", filepath.Base(script), err, strings.TrimSpace(stdout.String()))
	}
	if len(response.Results) != len(files) {
		return nil, fmt.Errorf("%s reported %d file(s) for %d input file(s)", filepath.Base(script), len(response.Results), len(files))
	}

	var findings []scanFinding
	for _, result := range response.Results {
		if result.Error != "" {
			return nil, fmt.Errorf("%s: %s", result.Path, result.Error)
		}
		for _, finding := range result.Findings {
			finding.Path = result.Path
			findings = append(findings, finding)
		}
	}
	return findings, nil
}

// scanTypeScript runs the TypeScript compiler-API scanner over the sources below
// root. A missing node interpreter fails the guard.
func scanTypeScript(root string) ([]site, error) {
	files, err := collectSources(root, ".ts")
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no TypeScript sources under %s: the guard would be vacuous", root)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return nil, fmt.Errorf("%w: node is required to parse TypeScript with the compiler API", errInterpreterMissing)
	}
	findings, err := runScanner(node, filepath.Join(guardDir(), "scan_typescript.mjs"), files)
	if err != nil {
		return nil, err
	}
	return findingsToSites(findings), nil
}

// scanPython runs the standard-library `ast` scanner over the sources below
// root. A missing Python interpreter fails the guard.
func scanPython(root string) ([]site, error) {
	files, err := collectSources(root, ".py")
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no Python sources under %s: the guard would be vacuous", root)
	}
	interpreter, err := pythonInterpreterAt(repoRoot())
	if err != nil {
		return nil, err
	}
	findings, err := runScanner(interpreter, filepath.Join(guardDir(), "scan_python.py"), files)
	if err != nil {
		return nil, err
	}
	return findingsToSites(findings), nil
}

// pythonInterpreterAt resolves the Python interpreter for a repository root: the
// py/.venv virtualenv when it exists, otherwise python3 on PATH. A missing
// interpreter is an error, never a skip.
func pythonInterpreterAt(root string) (string, error) {
	venv := filepath.Join(root, "py", ".venv", "bin", "python3")
	if info, err := os.Stat(venv); err == nil && !info.IsDir() {
		return venv, nil
	}
	if path, err := exec.LookPath("python3"); err == nil {
		return path, nil
	}
	if path, err := exec.LookPath("python"); err == nil {
		return path, nil
	}
	return "", fmt.Errorf("%w: python3 is required to parse Python with the ast module", errInterpreterMissing)
}

// findingsToSites converts scanner findings into sites keyed by the enclosing
// scope, numbering each (path, scope) pair in the order the scanner reported.
func findingsToSites(findings []scanFinding) []site {
	sites := make([]site, 0, len(findings))
	for _, finding := range findings {
		sites = append(sites, site{path: finding.Path, fn: finding.Scope, kind: finding.Rule, line: finding.Line})
	}
	sortSites(sites)
	return assignNth(sites)
}
