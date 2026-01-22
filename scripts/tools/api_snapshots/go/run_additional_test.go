package main

import (
	"go/ast"
	"go/token"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()

	orig := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stdout = w
	defer func() {
		os.Stdout = orig
	}()

	fn()

	if closeErr := w.Close(); closeErr != nil {
		t.Fatalf("close writer: %v", closeErr)
	}
	b, readErr := io.ReadAll(r)
	if readErr != nil {
		t.Fatalf("read stdout: %v", readErr)
	}
	if closeErr := r.Close(); closeErr != nil {
		t.Fatalf("close reader: %v", closeErr)
	}
	return string(b)
}

func TestErrWriter_PrintfStopsAfterFirstError(t *testing.T) {
	fw := &failingWriter{}
	ew := &errWriter{w: fw}
	ew.Printf("%s", "a")
	callsAfterFirst := fw.calls
	ew.Printf("%s", "b")
	if ew.Err() == nil {
		t.Fatal("expected error")
	}
	if fw.calls != callsAfterFirst {
		t.Fatalf("expected no further writes after error (calls=%d -> %d)", callsAfterFirst, fw.calls)
	}
}

func TestRun_EmitsSnapshotSections(t *testing.T) {
	dir := t.TempDir()
	src := strings.TrimSpace(`
package p

const Foo = 1

var Bar = 2

type Exported struct{}

func Baz() {}
`) + "\n"
	if err := os.WriteFile(filepath.Join(dir, "a.go"), []byte(src), 0o600); err != nil {
		t.Fatalf("write file: %v", err)
	}

	writeFakeGo(t, "#!/usr/bin/env bash\n\ncat <<'JSON'\n{\"ImportPath\":\"example.com/p\",\"Dir\":\""+dir+"\",\"GoFiles\":[\"a.go\"]}\nJSON\n")

	out := captureStdout(t, func() {
		if err := run(); err != nil {
			t.Fatalf("run: %v", err)
		}
	})

	if !strings.Contains(out, "# AppTheory Go public API snapshot") {
		t.Fatalf("expected header, got:\n%s", out)
	}
	if !strings.Contains(out, "## example.com/p") {
		t.Fatalf("expected package section, got:\n%s", out)
	}
	if !strings.Contains(out, "type Exported struct{}") {
		t.Fatalf("expected exported type decl, got:\n%s", out)
	}
	if !strings.Contains(out, "const Foo") || !strings.Contains(out, "var Bar") || !strings.Contains(out, "func Baz()") {
		t.Fatalf("expected exported const/var/func decls, got:\n%s", out)
	}
}

func TestCollectDeclExports_CoversValueSpecAndUnexportedFunc(t *testing.T) {
	fset := token.NewFileSet()

	g := &ast.GenDecl{
		Tok: token.VAR,
		Specs: []ast.Spec{
			&ast.ValueSpec{
				Names:  []*ast.Ident{ast.NewIdent("Foo"), ast.NewIdent("bar")},
				Values: []ast.Expr{&ast.BasicLit{Kind: token.INT, Value: "1"}, &ast.BasicLit{Kind: token.INT, Value: "2"}},
			},
		},
	}
	exports := collectGenDeclExports(fset, g)
	if len(exports) != 1 || exports[0].Kind != "var" || exports[0].Name != "Foo" {
		t.Fatalf("unexpected exports: %#v", exports)
	}

	if out := collectFuncDeclExports(fset, &ast.FuncDecl{Name: ast.NewIdent("foo"), Type: &ast.FuncType{}}); out != nil {
		t.Fatalf("expected unexported func to be skipped, got %#v", out)
	}
}

func TestSortExports_OrdersKindThenNameThenDecl(t *testing.T) {
	exports := []exportDecl{
		{Kind: "func", Name: "B", Decl: "func B()"},
		{Kind: "type", Name: "A", Decl: "type A struct{}"},
		{Kind: "var", Name: "Z", Decl: "var Z = 1"},
		{Kind: "const", Name: "Y", Decl: "const Y = 1"},
		{Kind: "func", Name: "A", Decl: "func A()"},
	}
	sortExports(exports)

	got := make([]string, 0, len(exports))
	for _, e := range exports {
		got = append(got, e.Kind+":"+e.Name)
	}

	// const -> var -> type -> func, and within kind by name.
	want := []string{"const:Y", "var:Z", "type:A", "func:A", "func:B"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("unexpected order: %v", got)
	}
}
