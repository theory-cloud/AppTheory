package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestScaffoldTypeScriptProject(t *testing.T) {
	target := filepath.Join(t.TempDir(), "hello-app")
	if err := run([]string{"--lang=ts", "--version=1.2.3", target}); err != nil {
		t.Fatalf("run: %v", err)
	}
	pkg := readFile(t, filepath.Join(target, "package.json"))
	if !strings.Contains(pkg, "https://github.com/theory-cloud/AppTheory/releases/download/v1.2.3/theory-cloud-apptheory-1.2.3.tgz") {
		t.Fatalf("package.json does not pin AppTheory release asset: %s", pkg)
	}
	if strings.Contains(pkg, "__APP_") {
		t.Fatalf("package.json contains an unresolved placeholder: %s", pkg)
	}
	if _, err := os.Stat(filepath.Join(target, "src", "app.mjs")); err != nil {
		t.Fatalf("missing app source: %v", err)
	}
}

func TestScaffoldRefusesNonEmptyTarget(t *testing.T) {
	target := filepath.Join(t.TempDir(), "hello-app")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "existing.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"--lang=go", "--version=1.2.3", target}); err == nil {
		t.Fatal("expected non-empty target to fail")
	}
}

func TestNormalizeLang(t *testing.T) {
	cases := map[string]string{"go": "go", "golang": "go", "typescript": "ts", "nodejs": "ts", "python": "py"}
	for input, want := range cases {
		got, err := normalizeLang(input)
		if err != nil {
			t.Fatalf("normalizeLang(%q): %v", input, err)
		}
		if got != want {
			t.Fatalf("normalizeLang(%q) = %q, want %q", input, got, want)
		}
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
