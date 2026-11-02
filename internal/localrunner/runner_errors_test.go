package localrunner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewRunnerRejectsBadProfilesAndImages(t *testing.T) {
	base := testBase(t)
	invalidProfile := filepath.Join(base, "invalid-profile.json")
	if err := os.WriteFile(invalidProfile, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewRunner(Options{AppDir: base, ScratchDir: filepath.Join(base, "s1"), ProfilePath: invalidProfile}); err == nil {
		t.Fatal("an invalid profile must fail")
	}
	if _, err := NewRunner(Options{
		AppDir:     base,
		ScratchDir: filepath.Join(base, "s2"),
		Images:     map[string]string{"go": "public.ecr.aws/lambda/provided:al2023"},
	}); err == nil || !strings.Contains(err.Error(), "digest") {
		t.Fatalf("a tag-only image override must fail: %v", err)
	}
}

func TestRunFailsOnArchitectureMismatch(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	runner.docker = &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
		if len(argv) > 2 && argv[1] == "version" {
			return "amd64\n", "", nil
		}
		return "", "", nil
	}}
	if err := runner.Run(t.Context()); err == nil || !strings.Contains(err.Error(), "cross-architecture") {
		t.Fatalf("an architecture mismatch must fail the run: %v", err)
	}
}

func TestBackendAndFunctionStartupErrors(t *testing.T) {
	base := testBase(t)
	if _, err := NewRunner(Options{
		AppDir:     base,
		ScratchDir: filepath.Join(base, "scratch"),
		Backends:   []string{backendDynamoDB},
		Stdout:     &syncBuffer{},
	}); err == nil || !strings.Contains(err.Error(), "profile") {
		t.Fatalf("a backend without a profile must fail before any container starts: %v", err)
	}

	startup := newTestRunner(t, base)
	startup.docker = fakeRunnerDocker(t, 1, 1, &[]string{})
	cases := map[string]FunctionSpec{
		"no asset":   {LogicalID: "Fn", Runtime: "nodejs24.x", Handler: "index.handler"},
		"no handler": {LogicalID: "Fn", Runtime: "nodejs24.x", AssetDir: base},
		"unresolved env": {
			LogicalID: "Fn", Runtime: "nodejs24.x", Handler: "index.handler", AssetDir: base,
			UnresolvedEnvironment:  []string{"TABLE"},
			EnvironmentExpressions: map[string]string{"TABLE": `{"Ref":"Table"}`},
		},
		"unresolved memory": {
			LogicalID: "Fn", Runtime: "nodejs24.x", Handler: "index.handler", AssetDir: base, UnresolvedMemorySize: true,
		},
		"unresolved timeout": {
			LogicalID: "Fn", Runtime: "nodejs24.x", Handler: "index.handler", AssetDir: base, UnresolvedTimeout: true,
		},
	}
	for name, function := range cases {
		t.Run(name, func(t *testing.T) {
			if err := startup.startFunction(context.Background(), function, "image"); err == nil {
				t.Fatalf("%s must fail", name)
			}
		})
	}
	if err := startup.startFunctions(context.Background(), &Spec{
		Functions: []FunctionSpec{{LogicalID: "Fn", Runtime: "java21"}},
		APIs:      []APISpec{{Routes: []Route{{Function: "Fn"}}}},
	}, []string{"Fn"}); err == nil {
		t.Fatal("an unsupported runtime must fail startup")
	}
}

func TestPrepareScratchReportsFilesystemErrors(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	if err := os.MkdirAll(filepath.Dir(runner.Scratch()), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(runner.Scratch(), []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := runner.prepareScratch(&Spec{}); err == nil {
		t.Fatal("a scratch path that is a file must fail")
	}
}

func TestDownReportsDockerErrors(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	runner.docker = &Docker{exec: func(_ context.Context, _ []string) (string, string, error) {
		return "", "daemon down", errors.New("exit status 1")
	}}
	if _, err := runner.Down(context.Background()); err == nil {
		t.Fatal("down must report an unavailable daemon")
	}
	runner.docker = &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
		if len(argv) > 2 && argv[1] == "version" {
			return "arm64\n", "", nil
		}
		if argv[1] == "ps" {
			return "container-1\n", "", nil
		}
		return "", "network listing failed", errors.New("exit status 1")
	}}
	if _, err := runner.Down(context.Background()); err == nil {
		t.Fatal("down must report a network listing failure")
	}
}

func TestEnsureSharedPathWorkingDirectory(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := ensureSharedPath(filepath.Join(cwd, "some", "code")); err != nil {
		t.Fatalf("a path under the working directory must be accepted: %v", err)
	}
}

func TestArchMatchesUnknownValues(t *testing.T) {
	if !archMatches("riscv64", "riscv64") || archMatches("riscv64", "arm64") {
		t.Fatal("unknown architectures must compare literally")
	}
}

func TestDockerServerArchErrors(t *testing.T) {
	empty := &Docker{exec: func(_ context.Context, _ []string) (string, string, error) { return "", "", nil }}
	if _, err := empty.ServerArch(context.Background()); err == nil {
		t.Fatal("an empty server architecture must fail")
	}
	odd := &Docker{exec: func(_ context.Context, _ []string) (string, string, error) { return "sparc\n", "", nil }}
	if _, err := odd.ServerArch(context.Background()); err == nil || !strings.Contains(err.Error(), "unsupported") {
		t.Fatalf("an unknown architecture must fail: %v", err)
	}
	failing := &Docker{exec: func(_ context.Context, _ []string) (string, string, error) {
		return "", "boom", errors.New("exit status 1")
	}}
	if err := failing.CreateNetwork(context.Background(), "net", nil); err == nil {
		t.Fatal("create network must report an error")
	}
	if _, err := failing.PublishedPort(context.Background(), "fn", riePort); err == nil {
		t.Fatal("published port must report an error")
	}
	if _, err := failing.Running(context.Background(), "fn"); err == nil {
		t.Fatal("running must report an error")
	}
	noID := &Docker{exec: func(_ context.Context, _ []string) (string, string, error) { return "", "", nil }}
	if _, err := noID.StartContainer(context.Background(), ContainerOptions{Name: "fn"}); err == nil {
		t.Fatal("a run without an id must fail")
	}
}
