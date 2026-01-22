package main

import (
	"go/ast"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeFieldList(t *testing.T) {
	if got := normalizeFieldList(nil); got != nil {
		t.Fatalf("expected nil, got %#v", got)
	}

	empty := &ast.FieldList{}
	if got := normalizeFieldList(empty); got != empty {
		t.Fatalf("expected same pointer for empty list")
	}

	in := &ast.FieldList{
		List: []*ast.Field{
			{
				Names: []*ast.Ident{ast.NewIdent("a"), ast.NewIdent("b")},
				Type:  ast.NewIdent("int"),
			},
			{
				Type: ast.NewIdent("string"),
			},
		},
	}
	out := normalizeFieldList(in)
	if out == in {
		t.Fatalf("expected new field list")
	}
	if len(out.List) != 3 {
		t.Fatalf("expected 3 fields, got %d", len(out.List))
	}
	for i, f := range out.List {
		if len(f.Names) != 0 {
			t.Fatalf("expected field %d to have no names, got %#v", i, f.Names)
		}
		if f.Type == nil {
			t.Fatalf("expected field %d to have a type", i)
		}
	}
}

func TestFuncDeclKindAndName(t *testing.T) {
	fn := &ast.FuncDecl{Name: ast.NewIdent("Foo"), Type: &ast.FuncType{}}
	if got := funcDeclKind(fn); got != "func" {
		t.Fatalf("expected kind func, got %q", got)
	}
	if got := funcDeclName(fn); got != "Foo" {
		t.Fatalf("expected name Foo, got %q", got)
	}

	m := &ast.FuncDecl{
		Name: ast.NewIdent("Meth"),
		Type: &ast.FuncType{},
		Recv: &ast.FieldList{
			List: []*ast.Field{
				{Type: &ast.StarExpr{X: ast.NewIdent("T")}},
			},
		},
	}
	if got := funcDeclKind(m); got != "method" {
		t.Fatalf("expected kind method, got %q", got)
	}
	if got := funcDeclName(m); got != "*T.Meth" {
		t.Fatalf("expected name *T.Meth, got %q", got)
	}
}

func TestFormatValueSpecExports(t *testing.T) {
	fset := token.NewFileSet()

	// Single exported name.
	vs := &ast.ValueSpec{
		Names:  []*ast.Ident{ast.NewIdent("Foo")},
		Values: []ast.Expr{&ast.BasicLit{Kind: token.INT, Value: "1"}},
	}
	out := formatValueSpecExports(fset, token.CONST, vs)
	if len(out) != 1 {
		t.Fatalf("expected 1 export, got %d", len(out))
	}
	if out[0].Kind != "const" || out[0].Name != "Foo" {
		t.Fatalf("unexpected export: %#v", out[0])
	}
	if !strings.HasPrefix(out[0].Decl, "const Foo") {
		t.Fatalf("unexpected decl: %q", out[0].Decl)
	}

	// Multiple names with per-name values; should split and only include exported.
	vs = &ast.ValueSpec{
		Names: []*ast.Ident{ast.NewIdent("Foo"), ast.NewIdent("bar")},
		Values: []ast.Expr{
			&ast.BasicLit{Kind: token.INT, Value: "1"},
			&ast.BasicLit{Kind: token.INT, Value: "2"},
		},
	}
	out = formatValueSpecExports(fset, token.VAR, vs)
	if len(out) != 1 {
		t.Fatalf("expected 1 export, got %d", len(out))
	}
	if out[0].Kind != "var" || out[0].Name != "Foo" {
		t.Fatalf("unexpected export: %#v", out[0])
	}

	// Multi-assign fallback (values count does not match names); keeps combined spec.
	vs = &ast.ValueSpec{
		Names:  []*ast.Ident{ast.NewIdent("Foo"), ast.NewIdent("bar")},
		Values: []ast.Expr{&ast.CallExpr{Fun: ast.NewIdent("f")}},
	}
	out = formatValueSpecExports(fset, token.VAR, vs)
	if len(out) != 1 {
		t.Fatalf("expected 1 export, got %d", len(out))
	}
	if out[0].Name != "Foo" {
		t.Fatalf("unexpected export name: %q", out[0].Name)
	}
	if !strings.Contains(out[0].Decl, "bar") {
		t.Fatalf("expected fallback decl to include unexported name: %q", out[0].Decl)
	}
}

func TestSnapshotPackage_Basic(t *testing.T) {
	dir := t.TempDir()
	src := strings.TrimSpace(`
package p

type Exported struct {
	A int
}

type unexported struct{}

func Foo(a int) int { return a }

func (e *Exported) Meth(b int) {}
`) + "\n"
	if err := os.WriteFile(filepath.Join(dir, "a.go"), []byte(src), 0600); err != nil {
		t.Fatalf("write file: %v", err)
	}

	exports, err := snapshotPackage(goListPackage{
		ImportPath: "example.com/p",
		Dir:        dir,
		GoFiles:    []string{"a.go"},
	})
	if err != nil {
		t.Fatalf("snapshotPackage: %v", err)
	}
	if len(exports) != 3 {
		t.Fatalf("expected 3 exports, got %d", len(exports))
	}

	found := map[string]exportDecl{}
	for _, e := range exports {
		found[e.Kind+":"+e.Name] = e
	}

	if _, ok := found["type:Exported"]; !ok {
		t.Fatalf("missing exported type; got %#v", exports)
	}
	if e, ok := found["func:Foo"]; !ok || !strings.Contains(e.Decl, "func Foo(int) int") {
		t.Fatalf("missing/incorrect exported func; got %#v", exports)
	}
	if e, ok := found["method:*Exported.Meth"]; !ok || !strings.Contains(e.Decl, "func (*Exported) Meth(int)") {
		t.Fatalf("missing/incorrect exported method; got %#v", exports)
	}
}
