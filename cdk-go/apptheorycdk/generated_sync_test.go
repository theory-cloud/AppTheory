package apptheorycdk

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestRemoteMcpServerProps_EnableWellKnownMcpDiscovery(t *testing.T) {
	enabled := true
	props := &AppTheoryRemoteMcpServerProps{
		EnableWellKnownMcpDiscovery: &enabled,
	}

	if props.EnableWellKnownMcpDiscovery == nil || !*props.EnableWellKnownMcpDiscovery {
		t.Fatal("expected EnableWellKnownMcpDiscovery to be available in Go bindings")
	}
}

func TestGeneratedJsiiVersionMatchesRepoVersion(t *testing.T) {
	dir := packageDir(t)
	wantVersion := repoVersion(t, dir)

	versionText := readText(t, filepath.Join(dir, "version"))
	if versionText != wantVersion {
		t.Fatalf("expected cdk-go version %q, got %q", wantVersion, versionText)
	}

	jsiiSource := readText(t, filepath.Join(dir, "jsii", "jsii.go"))
	wantTarball := fmt.Sprintf("theory-cloud-apptheory-cdk-%s.tgz", wantVersion)
	if !strings.Contains(jsiiSource, fmt.Sprintf("//go:embed %s", wantTarball)) {
		t.Fatalf("expected jsii embed to reference %q", wantTarball)
	}
	if !strings.Contains(jsiiSource, fmt.Sprintf(`_jsii_.Load("@theory-cloud/apptheory-cdk", "%s", tarball)`, wantVersion)) {
		t.Fatalf("expected jsii loader to reference version %q", wantVersion)
	}
	if _, err := os.Stat(filepath.Join(dir, "jsii", wantTarball)); err != nil {
		t.Fatalf("expected jsii tarball %q: %v", wantTarball, err)
	}
}

func TestGeneratedCdkRuntimeMetadataMatchesRepoVersion(t *testing.T) {
	dir := packageDir(t)
	wantVersion := repoVersion(t, dir)

	_jsiiAssembly := readText(t, filepath.Join(dir, "..", "..", "cdk", ".jsii"))
	if !strings.Contains(_jsiiAssembly, fmt.Sprintf(`"version": "%s"`, wantVersion)) {
		t.Fatalf("expected cdk/.jsii to reference version %q", wantVersion)
	}

	libFiles, err := filepath.Glob(filepath.Join(dir, "..", "..", "cdk", "lib", "*.js"))
	if err != nil {
		t.Fatalf("failed to glob cdk/lib/*.js: %v", err)
	}
	if len(libFiles) == 0 {
		t.Fatal("expected generated files in cdk/lib")
	}

	wantMarker := fmt.Sprintf(`version: "%s"`, wantVersion)
	staleFiles := make([]string, 0)
	for _, path := range libFiles {
		text := readText(t, path)
		if strings.Contains(text, `version: "`) && !strings.Contains(text, wantMarker) {
			staleFiles = append(staleFiles, filepath.Base(path))
		}
	}
	if len(staleFiles) != 0 {
		t.Fatalf("expected cdk/lib runtime metadata to reference %q, stale files: %s", wantVersion, strings.Join(staleFiles, ", "))
	}
}

func packageDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("failed to resolve test file path")
	}
	return filepath.Dir(file)
}

func repoVersion(t *testing.T, dir string) string {
	t.Helper()
	rootVersion := readText(t, filepath.Join(dir, "..", "..", "VERSION"))
	fields := strings.Fields(rootVersion)
	if len(fields) == 0 {
		t.Fatal("root VERSION file is empty")
	}
	return fields[0]
}

func readText(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read %s: %v", path, err)
	}
	return strings.TrimSpace(string(data))
}
