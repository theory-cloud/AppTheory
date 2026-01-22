package main

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMapImport(t *testing.T) {
	if got, ok := mapImport("github.com/pay-theory/limited"); !ok || got != "github.com/theory-cloud/apptheory/pkg/limited" {
		t.Fatalf("unexpected mapping: ok=%v got=%q", ok, got)
	}
	if got, ok := mapImport("github.com/pay-theory/limited/middleware"); !ok || got != "github.com/theory-cloud/apptheory/pkg/limited/middleware" {
		t.Fatalf("unexpected mapping: ok=%v got=%q", ok, got)
	}
	if _, ok := mapImport("github.com/pay-theory/other"); ok {
		t.Fatal("expected unknown import to not map")
	}
}

func TestRewriteGoFile_NoChange_Change_AndParseError(t *testing.T) {
	const unchanged = `package main

import "fmt"

func main() { fmt.Println("ok") }
`
	if out, changed, err := rewriteGoFile("x.go", []byte(unchanged)); err != nil || changed || out != nil {
		t.Fatalf("expected no changes; out=%v changed=%v err=%v", out, changed, err)
	}

	const needsChange = `package main

import (
	"github.com/pay-theory/limited"
	"github.com/pay-theory/limited/middleware"
)

var _ = limited.DefaultConfig
var _ = middleware.FromHTTP
`
	out, changed, err := rewriteGoFile("y.go", []byte(needsChange))
	if err != nil || !changed {
		t.Fatalf("expected rewrite to change file; changed=%v err=%v", changed, err)
	}
	contents := string(out)
	if !strings.Contains(contents, `github.com/theory-cloud/apptheory/pkg/limited"`) {
		t.Fatalf("expected base import to be rewritten, got:\n%s", contents)
	}
	if !strings.Contains(contents, `github.com/theory-cloud/apptheory/pkg/limited/middleware"`) {
		t.Fatalf("expected sub-import to be rewritten, got:\n%s", contents)
	}

	if _, _, err := rewriteGoFile("bad.go", []byte("not go")); err == nil {
		t.Fatal("expected parse error")
	}
}

func TestCollectChanges_SkipsDirsAndFindsGoFiles(t *testing.T) {
	root := t.TempDir()
	mainPath := filepath.Join(root, "main.go")
	if err := os.WriteFile(mainPath, []byte(`package main

import "github.com/pay-theory/limited"

var _ = limited.DefaultConfig
`), 0o600); err != nil {
		t.Fatalf("write main.go: %v", err)
	}

	vendorDir := filepath.Join(root, "vendor")
	if err := os.MkdirAll(vendorDir, 0o700); err != nil {
		t.Fatalf("mkdir vendor: %v", err)
	}
	if err := os.WriteFile(filepath.Join(vendorDir, "ignored.go"), []byte(`package ignored

import "github.com/pay-theory/limited"
`), 0o600); err != nil {
		t.Fatalf("write vendor/ignored.go: %v", err)
	}

	changes, err := collectChanges(root)
	if err != nil {
		t.Fatalf("collectChanges: %v", err)
	}
	if len(changes) != 1 || changes[0].path != mainPath {
		t.Fatalf("expected 1 change for main.go, got %#v", changes)
	}
	if !strings.Contains(string(changes[0].after), "github.com/theory-cloud/apptheory/pkg/limited") {
		t.Fatalf("expected rewritten import, got:\n%s", string(changes[0].after))
	}
}

func TestRun_CodesForNoChanges_DryRun_Apply_AndErrors(t *testing.T) {
	// NOTE: This test mutates global flag/os state; it must not run in parallel.
	root := t.TempDir()

	// No changes.
	noChangeFile := filepath.Join(root, "a.go")
	if err := os.WriteFile(noChangeFile, []byte(`package main

import "fmt"

var _ = fmt.Println
`), 0o600); err != nil {
		t.Fatalf("write a.go: %v", err)
	}
	if code := runWithArgs(t, []string{"-root", root}); code != 0 {
		t.Fatalf("expected exit code 0 for no changes, got %d", code)
	}

	// Add a file that will change.
	changeFile := filepath.Join(root, "b.go")
	if err := os.WriteFile(changeFile, []byte(`package main

import "github.com/pay-theory/limited"

var _ = limited.DefaultConfig
`), 0o600); err != nil {
		t.Fatalf("write b.go: %v", err)
	}

	// Use a fake diff so tests don't depend on host tooling.
	binDir := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatalf("mkdir bin: %v", err)
	}
	diffPath := filepath.Join(binDir, "diff")
	if err := os.WriteFile(diffPath, []byte("#!/bin/sh\nexit 1\n"), 0o600); err != nil {
		t.Fatalf("write diff: %v", err)
	}
	//nolint:gosec // The test installs an executable stub diff in a temp dir.
	if err := os.Chmod(diffPath, 0o700); err != nil {
		t.Fatalf("chmod diff: %v", err)
	}

	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	// Dry-run should report changes (exit code 1).
	if code := runWithArgs(t, []string{"-root", root}); code != 1 {
		t.Fatalf("expected exit code 1 for dry-run changes, got %d", code)
	}

	// Apply should rewrite and exit 0.
	if code := runWithArgs(t, []string{"-root", root, "-apply"}); code != 0 {
		t.Fatalf("expected exit code 0 for apply, got %d", code)
	}
	//nolint:gosec // File path is controlled by the test (TempDir).
	updated, err := os.ReadFile(changeFile)
	if err != nil {
		t.Fatalf("read rewritten file: %v", err)
	}
	if !strings.Contains(string(updated), "github.com/theory-cloud/apptheory/pkg/limited") {
		t.Fatalf("expected file to be rewritten, got:\n%s", string(updated))
	}

	// Invalid root should fail.
	if code := runWithArgs(t, []string{"-root", filepath.Join(root, "does-not-exist")}); code != 2 {
		t.Fatalf("expected exit code 2 for invalid root, got %d", code)
	}
}

func runWithArgs(t *testing.T, args []string) int {
	t.Helper()

	oldArgs := os.Args
	oldCommandLine := flag.CommandLine
	t.Cleanup(func() {
		os.Args = oldArgs
		flag.CommandLine = oldCommandLine
	})

	flag.CommandLine = flag.NewFlagSet("lift-migrate", flag.ContinueOnError)
	flag.CommandLine.SetOutput(os.Stderr)
	os.Args = append([]string{"lift-migrate"}, args...)
	return run()
}
