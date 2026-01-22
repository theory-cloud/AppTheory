package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type failingWriter struct {
	calls int
}

func (w *failingWriter) Write(p []byte) (int, error) {
	w.calls++
	return 0, errors.New("write failed")
}

func TestErrWriter_StopsAfterFirstError(t *testing.T) {
	fw := &failingWriter{}
	ew := &errWriter{w: fw}
	ew.Println("a")
	callsAfterFirst := fw.calls
	ew.Println("b")
	if ew.Err() == nil {
		t.Fatal("expected error")
	}
	if fw.calls != callsAfterFirst {
		t.Fatalf("expected no further writes after error (calls=%d -> %d)", callsAfterFirst, fw.calls)
	}
}

func writeFakeGo(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "go")
	if err := os.WriteFile(path, []byte(script), 0o600); err != nil {
		t.Fatalf("write fake go: %v", err)
	}
	if err := os.Chmod(path, 0o700); err != nil { //nolint:gosec // Test helper needs an executable fake `go` binary.
		t.Fatalf("chmod fake go: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return path
}

func TestListPackages_GoListExitErrorUsesStderr(t *testing.T) {
	writeFakeGo(t, "#!/usr/bin/env bash\n\necho \"nope\" 1>&2\nexit 1\n")
	_, err := listPackages(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "go-api-snapshot: FAIL (go list): nope") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestListPackages_DecodeError(t *testing.T) {
	writeFakeGo(t, "#!/usr/bin/env bash\n\necho '{'\nexit 0\n")
	_, err := listPackages(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "decode go list output") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestListPackages_PackageErrorFails(t *testing.T) {
	writeFakeGo(t, "#!/usr/bin/env bash\n\ncat <<'JSON'\n{\"ImportPath\":\"example.com/p\",\"Dir\":\"/tmp/p\",\"GoFiles\":[\"a.go\"],\"Error\":{\"Err\":\"boom\"}}\nJSON\n")
	_, err := listPackages(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "go list package error") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestListPackages_SkipsEmptyEntries(t *testing.T) {
	writeFakeGo(t, "#!/usr/bin/env bash\n\ncat <<'JSON'\n{\"ImportPath\":\"\",\"Dir\":\"\"}\n{\"ImportPath\":\"example.com/p\",\"Dir\":\"/tmp/p\",\"GoFiles\":[\"a.go\"]}\nJSON\n")
	pkgs, err := listPackages(context.Background())
	if err != nil {
		t.Fatalf("listPackages: %v", err)
	}
	if len(pkgs) != 1 {
		t.Fatalf("expected 1 package, got %d", len(pkgs))
	}
	if pkgs[0].ImportPath != "example.com/p" {
		t.Fatalf("unexpected import path: %q", pkgs[0].ImportPath)
	}
}

func TestReceiverTypeString_UnknownOnNil(t *testing.T) {
	if got := receiverTypeString(nil); got != unknownReceiverType {
		t.Fatalf("expected (unknown), got %q", got)
	}
}
