package main

import (
	"flag"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMapImport(t *testing.T) {
	t.Parallel()

	got, ok := mapImport("github.com/pay-theory/limited")
	if !ok || got != "github.com/theory-cloud/apptheory/pkg/limited" {
		t.Fatalf("mapImport base: got %q ok=%v", got, ok)
	}

	got, ok = mapImport("github.com/pay-theory/limited/strategies")
	if !ok || got != "github.com/theory-cloud/apptheory/pkg/limited/strategies" {
		t.Fatalf("mapImport prefix: got %q ok=%v", got, ok)
	}

	_, ok = mapImport("github.com/other/module")
	if ok {
		t.Fatalf("expected unrelated import to not map")
	}
}

func TestShouldSkipDir(t *testing.T) {
	t.Parallel()

	for _, name := range []string{".git", "node_modules", "dist", "vendor", ".venv"} {
		if !shouldSkipDir(name) {
			t.Fatalf("expected %q to be skipped", name)
		}
	}
	if shouldSkipDir("src") {
		t.Fatalf("did not expect src to be skipped")
	}
}

func TestRewriteGoFile_AndCollectApplyChanges(t *testing.T) {
	t.Parallel()

	srcWithOldImport := `package p

import "github.com/pay-theory/limited/strategies"

func f() {}
`

	out, changed, err := rewriteGoFile("x.go", []byte(srcWithOldImport))
	if err != nil {
		t.Fatalf("rewriteGoFile: %v", err)
	}
	if !changed {
		t.Fatalf("expected rewriteGoFile to report changed=true")
	}
	if !strings.Contains(string(out), `github.com/theory-cloud/apptheory/pkg/limited/strategies`) {
		t.Fatalf("expected import to be rewritten, got:\n%s", string(out))
	}

	out, changed, err = rewriteGoFile("x.go", []byte(`package p; func f() {}`))
	if err != nil {
		t.Fatalf("rewriteGoFile(no-change): %v", err)
	}
	if changed || out != nil {
		t.Fatalf("expected no change for file without target import")
	}

	root := t.TempDir()

	// A file that should change.
	goFile := filepath.Join(root, "a.go")
	if writeErr := os.WriteFile(goFile, []byte(srcWithOldImport), 0o600); writeErr != nil {
		t.Fatalf("write a.go: %v", writeErr)
	}

	// A file that should not change.
	otherGo := filepath.Join(root, "b.go")
	if writeErr := os.WriteFile(otherGo, []byte(`package p; func g() {}`), 0o600); writeErr != nil {
		t.Fatalf("write b.go: %v", writeErr)
	}

	// A file in a skipped directory.
	skippedDir := filepath.Join(root, "node_modules")
	if mkdirErr := os.MkdirAll(skippedDir, 0o750); mkdirErr != nil {
		t.Fatalf("mkdir node_modules: %v", mkdirErr)
	}
	if writeErr := os.WriteFile(filepath.Join(skippedDir, "c.go"), []byte(srcWithOldImport), 0o600); writeErr != nil {
		t.Fatalf("write node_modules/c.go: %v", writeErr)
	}

	changes, err := collectChanges(root)
	if err != nil {
		t.Fatalf("collectChanges: %v", err)
	}
	if len(changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(changes))
	}
	if filepath.Clean(changes[0].path) != filepath.Clean(goFile) {
		t.Fatalf("unexpected change path: %q", changes[0].path)
	}

	if applyErr := applyChanges(changes); applyErr != nil {
		t.Fatalf("applyChanges: %v", applyErr)
	}

	//nolint:gosec // reading from a temp dir controlled by the test
	updated, err := os.ReadFile(goFile)
	if err != nil {
		t.Fatalf("read updated a.go: %v", err)
	}
	if !strings.Contains(string(updated), `github.com/theory-cloud/apptheory/pkg/limited/strategies`) {
		t.Fatalf("expected updated file to contain rewritten import, got:\n%s", string(updated))
	}
}

func runWithArgs(t *testing.T, args ...string) int {
	t.Helper()

	oldArgs := os.Args
	oldCommandLine := flag.CommandLine
	oldOutput := flag.CommandLine.Output()

	flag.CommandLine = flag.NewFlagSet(args[0], flag.ContinueOnError)
	flag.CommandLine.SetOutput(io.Discard)
	os.Args = args
	defer func() {
		os.Args = oldArgs
		flag.CommandLine = oldCommandLine
		flag.CommandLine.SetOutput(oldOutput)
	}()

	return run()
}

func TestRun_NoChanges_Returns0(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.go"), []byte(`package p; func f() {}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	code := runWithArgs(t, "lift-migrate", "-root", root)
	if code != 0 {
		t.Fatalf("expected exit code 0, got %d", code)
	}
}

func TestRun_DryRun_Returns1(t *testing.T) {
	root := t.TempDir()
	srcWithOldImport := `package p
import "github.com/pay-theory/limited/strategies"
func f() {}
`
	if err := os.WriteFile(filepath.Join(root, "a.go"), []byte(srcWithOldImport), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	code := runWithArgs(t, "lift-migrate", "-root", root)
	if code != 1 {
		t.Fatalf("expected exit code 1 for dry-run changes, got %d", code)
	}
}

func TestRun_Apply_Returns0_AndUpdatesFile(t *testing.T) {
	root := t.TempDir()
	srcWithOldImport := `package p
import "github.com/pay-theory/limited/strategies"
func f() {}
`
	path := filepath.Join(root, "a.go")
	if err := os.WriteFile(path, []byte(srcWithOldImport), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	code := runWithArgs(t, "lift-migrate", "-root", root, "-apply")
	if code != 0 {
		t.Fatalf("expected exit code 0 for apply, got %d", code)
	}

	//nolint:gosec // reading from a temp dir controlled by the test
	updated, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.Contains(string(updated), "github.com/theory-cloud/apptheory/pkg/limited/strategies") {
		t.Fatalf("expected file to be updated, got:\n%s", string(updated))
	}
}

func TestRun_InvalidRoot_Returns2(t *testing.T) {
	code := runWithArgs(t, "lift-migrate", "-root", filepath.Join(t.TempDir(), "does-not-exist"))
	if code != 2 {
		t.Fatalf("expected exit code 2 for invalid root, got %d", code)
	}
}

func TestRun_DryRun_DiffMissing_Returns2(t *testing.T) {
	root := t.TempDir()
	srcWithOldImport := `package p
import "github.com/pay-theory/limited/strategies"
func f() {}
`
	if err := os.WriteFile(filepath.Join(root, "a.go"), []byte(srcWithOldImport), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	t.Setenv("PATH", "")
	code := runWithArgs(t, "lift-migrate", "-root", root)
	if code != 2 {
		t.Fatalf("expected exit code 2 when diff is missing, got %d", code)
	}
}

func TestRun_Apply_ReadOnlyFile_Returns2(t *testing.T) {
	root := t.TempDir()
	srcWithOldImport := `package p
import "github.com/pay-theory/limited/strategies"
func f() {}
`
	path := filepath.Join(root, "a.go")
	if err := os.WriteFile(path, []byte(srcWithOldImport), 0o400); err != nil {
		t.Fatalf("write: %v", err)
	}

	code := runWithArgs(t, "lift-migrate", "-root", root, "-apply")
	if code != 2 {
		t.Fatalf("expected exit code 2 for apply permission error, got %d", code)
	}
}

func TestCollectChanges_IgnoresNonGoFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	changes, err := collectChanges(root)
	if err != nil {
		t.Fatalf("collectChanges: %v", err)
	}
	if len(changes) != 0 {
		t.Fatalf("expected no changes, got %#v", changes)
	}
}

func TestCollectChanges_ReturnsReadError(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.go"), []byte("package p\n"), 0o000); err != nil {
		t.Fatalf("write: %v", err)
	}

	if _, err := collectChanges(root); err == nil {
		t.Fatalf("expected collectChanges to return a read error")
	}
}

func TestCollectChanges_ReturnsRewriteError(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.go"), []byte("{"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	if _, err := collectChanges(root); err == nil {
		t.Fatalf("expected collectChanges to return a rewrite error")
	}
}

func TestRewriteGoFile_EmptyImportPath_DoesNotChange(t *testing.T) {
	out, changed, err := rewriteGoFile("x.go", []byte(`package p; import ""; func f() {}`))
	if err != nil {
		t.Fatalf("rewriteGoFile: %v", err)
	}
	if changed || out != nil {
		t.Fatalf("expected no change for empty import path")
	}
}

func TestPrintUnifiedDiff_NoChanges_ReturnsNil(t *testing.T) {
	root := t.TempDir()
	src := []byte("package p\n\nfunc f() {}\n")
	path := filepath.Join(root, "a.go")
	if err := os.WriteFile(path, src, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := printUnifiedDiff(root, path, src); err != nil {
		t.Fatalf("printUnifiedDiff: %v", err)
	}
}
