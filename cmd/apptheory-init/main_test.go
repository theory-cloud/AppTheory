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

func TestScaffoldGoProjectDerivesModuleMajorFromVersion(t *testing.T) {
	target := filepath.Join(t.TempDir(), "hello-go")
	if err := run([]string{"--lang=go", "--version=3.0.0-rc", target}); err != nil {
		t.Fatalf("run: %v", err)
	}
	goMod := readFile(t, filepath.Join(target, "go.mod"))
	if !strings.Contains(goMod, "require github.com/theory-cloud/apptheory/v3 v3.0.0-rc") {
		t.Fatalf("go.mod does not pin the AppTheory module matching the requested version: %s", goMod)
	}
	legacyModule := "github.com/theory-cloud/" + "apptheory v"
	if strings.Contains(goMod, legacyModule) {
		t.Fatalf("go.mod contains the legacy unsuffixed module: %s", goMod)
	}
}

func TestScaffoldRefusesNonEmptyTarget(t *testing.T) {
	target := filepath.Join(t.TempDir(), "hello-app")
	if err := os.MkdirAll(target, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "existing.txt"), []byte("x"), 0o600); err != nil {
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

func TestAppTheoryGoModuleDerivesSemanticImportMajor(t *testing.T) {
	cases := []struct {
		version string
		want    string
		wantErr bool
	}{
		{version: "0.9.0", want: "github.com/theory-cloud/apptheory"},
		{version: "1.0.0", want: "github.com/theory-cloud/apptheory"},
		{version: "2.0.0", want: "github.com/theory-cloud/apptheory/v2"},
		{version: "3.0.0-rc", want: "github.com/theory-cloud/apptheory/v3"},
		{version: "10.0.0", want: "github.com/theory-cloud/apptheory/v10"},
		{version: "+3.0.0", wantErr: true},
		{version: "03.0.0", wantErr: true},
		{version: "-1.0.0", wantErr: true},
		{version: "3", wantErr: true},
		{version: "garbage", wantErr: true},
		{version: "", wantErr: true},
	}
	for _, testCase := range cases {
		t.Run("version="+testCase.version, func(t *testing.T) {
			got, err := appTheoryGoModule(testCase.version)
			if testCase.wantErr {
				if err == nil {
					t.Fatalf("appTheoryGoModule(%q) = %q, want error", testCase.version, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("appTheoryGoModule(%q): %v", testCase.version, err)
			}
			if got != testCase.want {
				t.Fatalf("appTheoryGoModule(%q) = %q, want %q", testCase.version, got, testCase.want)
			}
		})
	}
}

func TestScaffoldGoProjectInfersVersionFromRepositoryRoot(t *testing.T) {
	cases := []struct {
		version    string
		wantModule string
		wantErr    bool
	}{
		{version: "0.9.0", wantModule: "github.com/theory-cloud/apptheory"},
		{version: "1.2.3", wantModule: "github.com/theory-cloud/apptheory"},
		{version: "2.0.0", wantModule: "github.com/theory-cloud/apptheory/v2"},
		{version: "3.0.0-rc", wantModule: "github.com/theory-cloud/apptheory/v3"},
		{version: "garbage", wantErr: true},
	}
	for _, testCase := range cases {
		t.Run("version="+testCase.version, func(t *testing.T) {
			root := t.TempDir()
			writeInferredTemplateRoot(t, root, testCase.version)
			target := filepath.Join(root, "hello-go")
			err := run([]string{
				"--lang=go",
				"--template-dir=" + filepath.Join(root, "templates", "apptheory-init"),
				target,
			})
			if testCase.wantErr {
				if err == nil {
					t.Fatalf("run with inferred version %q unexpectedly succeeded", testCase.version)
				}
				return
			}
			if err != nil {
				t.Fatalf("run with inferred version %q: %v", testCase.version, err)
			}
			goMod := readFile(t, filepath.Join(target, "go.mod"))
			wantRequire := "require " + testCase.wantModule + " v" + testCase.version
			if !strings.Contains(goMod, wantRequire) {
				t.Fatalf("inferred go.mod does not contain %q: %s", wantRequire, goMod)
			}
		})
	}
}

// writeInferredTemplateRoot lays out the minimum tree the scaffolder discovers
// when no --version is passed: templates/apptheory-init/<lang>/ plus the
// repository VERSION file the template root's grandparent carries.
func writeInferredTemplateRoot(t *testing.T, root string, version string) {
	t.Helper()
	templateRoot := filepath.Join(root, "templates", "apptheory-init")
	for _, lang := range []string{"go", "ts", "py"} {
		if err := os.MkdirAll(filepath.Join(templateRoot, lang), 0o750); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "VERSION"), []byte(version+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	requires := "module __APP_MODULE__\n\ngo 1.26.6\n\nrequire __APPTHEORY_GO_MODULE__ __APPTHEORY_TAG__\n"
	if err := os.WriteFile(filepath.Join(templateRoot, "go", "go.mod.tmpl"), []byte(requires), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path) //nolint:gosec // test helper reads files created under t.TempDir or generated scaffold output.
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
