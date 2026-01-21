package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMapImport(t *testing.T) {
	got, ok := mapImport("github.com/pay-theory/limited")
	if !ok || got != "github.com/theory-cloud/apptheory/pkg/limited" {
		t.Fatalf("unexpected mapping: %q ok=%v", got, ok)
	}

	got, ok = mapImport("github.com/pay-theory/limited/middleware")
	if !ok || got != "github.com/theory-cloud/apptheory/pkg/limited/middleware" {
		t.Fatalf("unexpected mapping: %q ok=%v", got, ok)
	}

	if _, ok := mapImport("github.com/example/other"); ok {
		t.Fatal("expected unrelated import to be unmapped")
	}
}

func TestRewriteGoFile_RewritesImports(t *testing.T) {
	src := []byte(`package p

import (
	_ "fmt"
	_ "github.com/pay-theory/limited"
	_ "github.com/pay-theory/limited/middleware"
)
`)

	out, changed, err := rewriteGoFile("x.go", src)
	if err != nil {
		t.Fatalf("rewriteGoFile returned error: %v", err)
	}
	if !changed {
		t.Fatal("expected change")
	}
	s := string(out)
	if strings.Contains(s, "github.com/pay-theory/limited") {
		t.Fatalf("expected old import to be removed, got:\n%s", s)
	}
	if !strings.Contains(s, "github.com/theory-cloud/apptheory/pkg/limited") {
		t.Fatalf("expected new import to be present, got:\n%s", s)
	}

	out, changed, err = rewriteGoFile("x.go", []byte(`package p

import _ "github.com/theory-cloud/apptheory/pkg/limited"
`))
	if err != nil || changed || out != nil {
		t.Fatalf("expected no change, got changed=%v out=%v err=%v", changed, out, err)
	}
}

func TestCollectChangesAndApplyChanges(t *testing.T) {
	dir := t.TempDir()

	needsRewrite := filepath.Join(dir, "a.go")
	clean := filepath.Join(dir, "b.go")
	vendorDir := filepath.Join(dir, "vendor")

	if err := os.MkdirAll(vendorDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(vendorDir, "ignored.go"), []byte(`package ignored`), 0o600); err != nil {
		t.Fatalf("write ignored: %v", err)
	}

	if err := os.WriteFile(needsRewrite, []byte(`package p

import _ "github.com/pay-theory/limited"
`), 0o600); err != nil {
		t.Fatalf("write a.go: %v", err)
	}
	if err := os.WriteFile(clean, []byte(`package p

import _ "fmt"
`), 0o600); err != nil {
		t.Fatalf("write b.go: %v", err)
	}

	changes, err := collectChanges(dir)
	if err != nil {
		t.Fatalf("collectChanges returned error: %v", err)
	}
	if len(changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(changes))
	}

	err = applyChanges(changes)
	if err != nil {
		t.Fatalf("applyChanges returned error: %v", err)
	}
	//nolint:gosec // Test reads a temp file path controlled by the test harness.
	updated, err := os.ReadFile(needsRewrite)
	if err != nil {
		t.Fatalf("read updated: %v", err)
	}
	if !strings.Contains(string(updated), "github.com/theory-cloud/apptheory/pkg/limited") {
		t.Fatalf("expected rewritten import, got:\n%s", string(updated))
	}
}
