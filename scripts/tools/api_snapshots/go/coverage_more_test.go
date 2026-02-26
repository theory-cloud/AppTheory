package main

import (
	"context"
	"go/ast"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRun_CoversSortingAndNoExportSkips(t *testing.T) {
	dirA := t.TempDir()
	srcA := "package a\n\ntype ExportedA struct{}\n"
	if err := os.WriteFile(filepath.Join(dirA, "a.go"), []byte(srcA), 0o600); err != nil {
		t.Fatalf("write a.go: %v", err)
	}

	dirB := t.TempDir()
	srcB := "package b\n\ntype ExportedB struct{}\n"
	if err := os.WriteFile(filepath.Join(dirB, "b.go"), []byte(srcB), 0o600); err != nil {
		t.Fatalf("write b.go: %v", err)
	}

	dirNoExports := t.TempDir()
	srcNoExports := "package c\n\ntype unexported struct{}\n"
	if err := os.WriteFile(filepath.Join(dirNoExports, "c.go"), []byte(srcNoExports), 0o600); err != nil {
		t.Fatalf("write c.go: %v", err)
	}

	// Return packages out of order so sort.Slice comparator is exercised.
	writeFakeGo(t, strings.Join([]string{
		"#!/usr/bin/env bash",
		"",
		"cat <<'JSON'",
		`{"ImportPath":"example.com/b","Dir":"` + dirB + `","GoFiles":["b.go"]}`,
		`{"ImportPath":"example.com/c","Dir":"` + dirNoExports + `","GoFiles":["c.go"]}`,
		`{"ImportPath":"example.com/a","Dir":"` + dirA + `","GoFiles":["a.go"]}`,
		"JSON",
		"",
	}, "\n"))

	out := captureStdout(t, func() {
		if err := run(); err != nil {
			t.Fatalf("run: %v", err)
		}
	})

	// Ensure the no-exports package is skipped (len(exports) == 0 -> continue).
	if strings.Contains(out, "## example.com/c") {
		t.Fatalf("expected package with no exports to be skipped, got:\n%s", out)
	}

	// Ensure packages are sorted by import path.
	posA := strings.Index(out, "## example.com/a")
	posB := strings.Index(out, "## example.com/b")
	if posA < 0 || posB < 0 || posA > posB {
		t.Fatalf("expected example.com/a to appear before example.com/b, got:\n%s", out)
	}
}

func TestRun_ReturnsErrorWhenSnapshotPackageFails(t *testing.T) {
	dir := t.TempDir()
	// Invalid Go source -> parser.ParseFile error.
	if err := os.WriteFile(filepath.Join(dir, "bad.go"), []byte("{"), 0o600); err != nil {
		t.Fatalf("write bad.go: %v", err)
	}

	writeFakeGo(t, strings.Join([]string{
		"#!/usr/bin/env bash",
		"",
		"cat <<'JSON'",
		`{"ImportPath":"example.com/bad","Dir":"` + dir + `","GoFiles":["bad.go"]}`,
		"JSON",
		"",
	}, "\n"))

	_ = captureStdout(t, func() {
		if err := run(); err == nil {
			t.Fatalf("expected run to error")
		}
	})
}

func TestRun_ReturnsErrorWhenListPackagesFails(t *testing.T) {
	writeFakeGo(t, "#!/usr/bin/env bash\n\nexit 1\n")
	if err := run(); err == nil {
		t.Fatalf("expected run to return listPackages error")
	}
}

func TestListPackages_FailsWhenGoBinaryMissing(t *testing.T) {
	t.Setenv("PATH", "")
	_, err := listPackages(context.Background())
	if err == nil {
		t.Fatalf("expected listPackages to fail when go is missing")
	}
}

func TestSnapshotPackage_NoFilesIsNoOp(t *testing.T) {
	exports, err := snapshotPackage(goListPackage{ImportPath: "example.com/empty", Dir: t.TempDir()})
	if err != nil {
		t.Fatalf("snapshotPackage: %v", err)
	}
	if exports != nil {
		t.Fatalf("expected nil exports, got %#v", exports)
	}
}

func TestSnapshotPackage_AndParseAndNormalizeFiles_ErrorCases(t *testing.T) {
	// snapshotPackage should return an error when a file cannot be parsed.
	_, err := snapshotPackage(goListPackage{
		ImportPath: "example.com/p",
		Dir:        t.TempDir(),
		GoFiles:    []string{"missing.go"},
	})
	if err == nil {
		t.Fatalf("expected snapshotPackage to error")
	}

	// parseAndNormalizeFiles should fail closed on parse errors.
	_, _, err = parseAndNormalizeFiles(t.TempDir(), []string{"missing.go"})
	if err == nil {
		t.Fatalf("expected parseAndNormalizeFiles to error")
	}
}

func TestCollectExports_MiscBranches(t *testing.T) {
	fset := token.NewFileSet()

	// collectDeclExports default branch (decl type not handled).
	if out := collectDeclExports(fset, &ast.BadDecl{}); out != nil {
		t.Fatalf("expected nil exports for bad decl, got %#v", out)
	}

	// collectGenDeclExports default branch.
	if out := collectGenDeclExports(fset, &ast.GenDecl{Tok: token.IMPORT}); out != nil {
		t.Fatalf("expected nil exports for import decl, got %#v", out)
	}

	// collectTypeSpecExports should skip non-TypeSpec specs.
	typeDecl := &ast.GenDecl{Tok: token.TYPE, Specs: []ast.Spec{&ast.ValueSpec{}}}
	if out := collectTypeSpecExports(fset, typeDecl); len(out) != 0 {
		t.Fatalf("expected nil exports for non-TypeSpec, got %#v", out)
	}

	// collectValueSpecExports should skip non-ValueSpec specs.
	valueDecl := &ast.GenDecl{Tok: token.VAR, Specs: []ast.Spec{&ast.TypeSpec{Name: ast.NewIdent("X")}}}
	if out := collectValueSpecExports(fset, valueDecl); len(out) != 0 {
		t.Fatalf("expected nil exports for non-ValueSpec, got %#v", out)
	}
}

func TestSortExports_OrdersByDeclWhenKindAndNameEqual(t *testing.T) {
	exports := []exportDecl{
		{Kind: exportKindFunc, Name: "A", Decl: "func A2()"},
		{Kind: exportKindFunc, Name: "A", Decl: "func A1()"},
	}
	sortExports(exports)
	if exports[0].Decl != "func A1()" || exports[1].Decl != "func A2()" {
		t.Fatalf("unexpected decl order: %#v", exports)
	}
}

func TestFormatValueSpecExports_EmptyAndUnexportedOnly(t *testing.T) {
	fset := token.NewFileSet()

	if out := formatValueSpecExports(fset, token.VAR, &ast.ValueSpec{}); out != nil {
		t.Fatalf("expected nil exports for empty names, got %#v", out)
	}
	if out := formatValueSpecExports(fset, token.VAR, &ast.ValueSpec{Names: []*ast.Ident{ast.NewIdent("x")}}); out != nil {
		t.Fatalf("expected nil exports for unexported-only names, got %#v", out)
	}
}
