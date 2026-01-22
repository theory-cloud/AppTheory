package main

import (
	"flag"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestShouldSkipDir(t *testing.T) {
	if !shouldSkipDir(".git") || !shouldSkipDir("node_modules") || !shouldSkipDir("vendor") {
		t.Fatal("expected known dirs to be skipped")
	}
	if shouldSkipDir("src") {
		t.Fatal("did not expect src to be skipped")
	}
}

func TestMapImport(t *testing.T) {
	got, ok := mapImport("github.com/pay-theory/limited")
	if !ok || got != "github.com/theory-cloud/apptheory/pkg/limited" {
		t.Fatalf("unexpected mapping: %q %v", got, ok)
	}
	got, ok = mapImport("github.com/pay-theory/limited/foo")
	if !ok || got != "github.com/theory-cloud/apptheory/pkg/limited/foo" {
		t.Fatalf("unexpected mapping: %q %v", got, ok)
	}
	_, ok = mapImport("github.com/example/other")
	if ok {
		t.Fatal("expected no mapping")
	}
}

func TestRewriteGoFile_RewritesImports(t *testing.T) {
	src := []byte(`package p

import (
  "fmt"
  old "github.com/pay-theory/limited"
  "github.com/pay-theory/limited/middleware"
)

func _() {
  fmt.Println(old.DefaultConfig())
  _ = middleware.Middleware
}
`)

	out, changed, err := rewriteGoFile("x.go", src)
	if err != nil {
		t.Fatalf("rewriteGoFile: %v", err)
	}
	if !changed {
		t.Fatal("expected changed")
	}
	if string(out) == string(src) {
		t.Fatal("expected output to differ")
	}
	if string(out) == "" {
		t.Fatal("expected output")
	}
	if want := `"github.com/theory-cloud/apptheory/pkg/limited"`; !contains(string(out), want) {
		t.Fatalf("expected rewritten import %q, got:\n%s", want, string(out))
	}
	if want := `"github.com/theory-cloud/apptheory/pkg/limited/middleware"`; !contains(string(out), want) {
		t.Fatalf("expected rewritten import %q, got:\n%s", want, string(out))
	}
}

func TestCollectChanges_SkipsKnownDirs(t *testing.T) {
	root := t.TempDir()

	// Should be skipped.
	skipped := filepath.Join(root, "node_modules")
	if err := os.MkdirAll(skipped, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(skipped, "x.go"), []byte(`package p; import _ "github.com/pay-theory/limited"`), 0o600); err != nil {
		t.Fatalf("write skipped: %v", err)
	}

	// Should be processed.
	if err := os.WriteFile(filepath.Join(root, "ok.go"), []byte(`package p; import _ "github.com/pay-theory/limited"`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	changes, err := collectChanges(root)
	if err != nil {
		t.Fatalf("collectChanges: %v", err)
	}
	if len(changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(changes))
	}
	if !contains(changes[0].path, "ok.go") {
		t.Fatalf("unexpected change path: %q", changes[0].path)
	}
}

func contains(s, substr string) bool {
	return strings.Contains(s, substr)
}

func TestApplyChanges_WritesAndPreservesPermissions(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "x.go")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	if err := applyChanges([]change{{path: path, after: []byte("new")}}); err != nil {
		t.Fatalf("applyChanges: %v", err)
	}

	//nolint:gosec // Test reads a temp file path created within this test.
	updated, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(updated) != "new" {
		t.Fatalf("expected updated content, got %q", string(updated))
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("expected permissions preserved, got %v", info.Mode().Perm())
	}
}

func TestPrintUnifiedDiff_IgnoresExitCode1(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires a POSIX executable on PATH")
	}

	root := t.TempDir()
	path := filepath.Join(root, "x.go")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	diffDir := t.TempDir()
	diffPath := filepath.Join(diffDir, "diff")
	if err := os.WriteFile(diffPath, []byte("#!/bin/sh\nexit 1\n"), 0o600); err != nil {
		t.Fatalf("write diff: %v", err)
	}
	//nolint:gosec // Tests need an executable stub on PATH.
	if err := os.Chmod(diffPath, 0o700); err != nil {
		t.Fatalf("chmod diff: %v", err)
	}
	t.Setenv("PATH", diffDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	if err := printUnifiedDiff(root, path, []byte("new")); err != nil {
		t.Fatalf("printUnifiedDiff: %v", err)
	}
}

func TestPrintUnifiedDiff_ReturnsErrorOnUnexpectedExitCode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires a POSIX executable on PATH")
	}

	root := t.TempDir()
	path := filepath.Join(root, "x.go")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	diffDir := t.TempDir()
	diffPath := filepath.Join(diffDir, "diff")
	if err := os.WriteFile(diffPath, []byte("#!/bin/sh\nexit 2\n"), 0o600); err != nil {
		t.Fatalf("write diff: %v", err)
	}
	//nolint:gosec // Tests need an executable stub on PATH.
	if err := os.Chmod(diffPath, 0o700); err != nil {
		t.Fatalf("chmod diff: %v", err)
	}
	t.Setenv("PATH", diffDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	if err := printUnifiedDiff(root, path, []byte("new")); err == nil {
		t.Fatal("expected error")
	}
}

func TestRun_DryRunNoChanges_Returns0(t *testing.T) {
	root := t.TempDir()
	if got := runWithArgs(t, "lift-migrate", "-root", root); got != 0 {
		t.Fatalf("expected 0, got %d", got)
	}
}

func TestRun_DryRunWithChanges_Returns1(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("requires a POSIX executable on PATH")
	}

	root := t.TempDir()
	path := filepath.Join(root, "x.go")
	if err := os.WriteFile(path, []byte(`package p; import _ "github.com/pay-theory/limited"`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	diffDir := t.TempDir()
	diffPath := filepath.Join(diffDir, "diff")
	if err := os.WriteFile(diffPath, []byte("#!/bin/sh\nexit 1\n"), 0o600); err != nil {
		t.Fatalf("write diff: %v", err)
	}
	//nolint:gosec // Tests need an executable stub on PATH.
	if err := os.Chmod(diffPath, 0o700); err != nil {
		t.Fatalf("chmod diff: %v", err)
	}
	t.Setenv("PATH", diffDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	if got := runWithArgs(t, "lift-migrate", "-root", root); got != 1 {
		t.Fatalf("expected 1, got %d", got)
	}
}

func TestRun_ApplyWithChanges_UpdatesFilesAndReturns0(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "x.go")
	if err := os.WriteFile(path, []byte(`package p; import _ "github.com/pay-theory/limited"`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	if got := runWithArgs(t, "lift-migrate", "-root", root, "-apply"); got != 0 {
		t.Fatalf("expected 0, got %d", got)
	}

	//nolint:gosec // Test reads a temp file path created within this test.
	updated, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.Contains(string(updated), "github.com/theory-cloud/apptheory/pkg/limited") {
		t.Fatalf("expected rewritten import, got:\n%s", string(updated))
	}
}

func runWithArgs(t *testing.T, args ...string) int {
	t.Helper()
	if len(args) == 0 {
		t.Fatal("missing args")
	}

	oldArgs := os.Args
	oldFlagCommandLine := flag.CommandLine
	defer func() {
		os.Args = oldArgs
		flag.CommandLine = oldFlagCommandLine
	}()

	flag.CommandLine = flag.NewFlagSet(args[0], flag.ContinueOnError)
	flag.CommandLine.SetOutput(io.Discard)
	os.Args = args

	return run()
}
