package localrunner

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The packaging-layers page lists two Python layer paths: "python" and
// "python/lib/python3.x/site-packages (site directories)". A layer built with
// pip's site-packages layout imports on AWS and must import locally too.
// https://docs.aws.amazon.com/lambda/latest/dg/packaging-layers.html
func TestLayerEnvironmentAddsBothPythonLayerPaths(t *testing.T) {
	runner := &Runner{imageEnvs: map[string]map[string]string{
		"python:3.14": {"PATH": "/usr/local/bin:/usr/bin:/bin"},
	}}
	env, err := runner.layerEnvironment(context.Background(),
		FunctionSpec{Runtime: "python3.14"}, "python:3.14", map[string]string{})
	if err != nil {
		t.Fatalf("layerEnvironment: %v", err)
	}
	want := "/opt/python:/opt/python/lib/python3.14/site-packages"
	if env["PYTHONPATH"] != want {
		t.Fatalf("PYTHONPATH = %q, want %q", env["PYTHONPATH"], want)
	}

	env, err = runner.layerEnvironment(context.Background(),
		FunctionSpec{Runtime: "python3.14"}, "python:3.14", map[string]string{"PYTHONPATH": "/custom/python"})
	if err != nil {
		t.Fatalf("layerEnvironment with an existing PYTHONPATH: %v", err)
	}
	want = "/opt/python:/opt/python/lib/python3.14/site-packages:/custom/python"
	if env["PYTHONPATH"] != want {
		t.Fatalf("PYTHONPATH = %q, want %q", env["PYTHONPATH"], want)
	}
}

func TestPythonSitePackagesDerivesFromTheRuntime(t *testing.T) {
	cases := map[string]string{
		"python3.14": "/opt/python/lib/python3.14/site-packages",
		"python3.13": "/opt/python/lib/python3.13/site-packages",
		"python3":    "",
		"python":     "",
		"provided":   "",
	}
	for runtime, want := range cases {
		if got := pythonSitePackages(runtime); got != want {
			t.Errorf("pythonSitePackages(%q) = %q, want %q", runtime, got, want)
		}
	}
}

// A CDK Code.fromAsset layer directory keeps symlinks (CDK's default
// SymlinkFollowMode.NEVER stores them as symlinks) and Lambda extracts them. A
// Node layer built by `npm install` carries node_modules/.bin shims as
// symlinks, so the merged /opt must keep them.
func TestCopyTreeMaterializesInLayerSymlinks(t *testing.T) {
	source := t.TempDir()
	target := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "regular.js"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("regular.js", filepath.Join(source, "bin-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(source, "nested"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "nested", "real.txt"), []byte("y"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("real.txt", filepath.Join(source, "nested", "linked.txt")); err != nil {
		t.Fatal(err)
	}
	if err := copyTree(source, target); err != nil {
		t.Fatalf("copyTree: %v", err)
	}
	for name, want := range map[string]string{"bin-link": "regular.js", "nested/linked.txt": "real.txt"} {
		info, err := os.Lstat(filepath.Join(target, name))
		if err != nil {
			t.Errorf("entry %s was dropped: %v", name, err)
			continue
		}
		if info.Mode()&os.ModeSymlink == 0 {
			t.Errorf("entry %s is not a symlink", name)
			continue
		}
		linkTarget, err := os.Readlink(filepath.Join(target, name))
		if err != nil || linkTarget != want {
			t.Errorf("entry %s target = %q, %v; want %q", name, linkTarget, err, want)
		}
	}
}

func TestCopyTreeRefusesEscapingSymlinks(t *testing.T) {
	outside := t.TempDir()
	cases := map[string]string{
		"absolute":            "/etc/passwd",
		"escapes-the-layer":   "../../outside.txt",
		"escapes-from-nested": "../../../outside.txt",
	}
	for name, linkTarget := range cases {
		t.Run(name, func(t *testing.T) {
			source := t.TempDir()
			target := t.TempDir()
			nested := filepath.Join(source, "nested")
			if err := os.MkdirAll(nested, 0o750); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(outside, "outside.txt"), []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
			link := filepath.Join(nested, "escape")
			if err := os.Symlink(linkTarget, link); err != nil {
				t.Fatal(err)
			}
			err := copyTree(source, target)
			if err == nil {
				t.Fatal("an escaping layer symlink was accepted")
			}
			if !strings.Contains(err.Error(), "nested"+string(filepath.Separator)+"escape") {
				t.Fatalf("the refusal does not name the symlink: %v", err)
			}
		})
	}
}
