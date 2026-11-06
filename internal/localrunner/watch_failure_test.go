package localrunner

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// watchBatchFixture is a runner with two functions running from the previous
// watch assembly while a reload derives both from the new one.
type watchBatchFixture struct {
	runner   *Runner
	fake     *restartFakeDocker
	output   *bytes.Buffer
	oldDir   string
	newDir   string
	previous map[string]FunctionSpec
	next     *Spec
}

func newWatchBatchFixture(t *testing.T, fake *restartFakeDocker) *watchBatchFixture {
	t.Helper()
	home := testSharedDir(t)
	scratch := filepath.Join(home, "scratch")
	oldDir := filepath.Join(scratch, "watch", "assembly-1")
	newDir := filepath.Join(scratch, "watch", "assembly-2")
	for _, dir := range []string{
		filepath.Join(oldDir, "asset.old"),
		filepath.Join(newDir, "asset.new"),
	} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "index.js"), []byte("exports.handler = async () => ({statusCode:200});"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	output := &bytes.Buffer{}
	runner := &Runner{
		options:    Options{Stdout: output},
		scratch:    scratch,
		docker:     &Docker{exec: fake.exec},
		clock:      RealClock{},
		delivery:   NewDeliveryEngine(RealClock{}, 0, nil, nil, nil),
		invokers:   map[string]*FunctionProcess{},
		backends:   map[string]backendProcess{},
		transports: map[string]*Transport{},
		images:     map[string]string{"node": "public.ecr.aws/lambda/nodejs:24@sha256:" + strings.Repeat("c", 64)},
	}
	t.Cleanup(func() {
		for _, process := range runner.invokers {
			runner.stopFunction(context.Background(), process)
		}
		if err := runner.delivery.Stop(context.Background()); err != nil {
			t.Errorf("stop the delivery engine: %v", err)
		}
	})
	previous := map[string]FunctionSpec{}
	for _, id := range []string{"Fn1", "Fn2"} {
		function := FunctionSpec{
			LogicalID:   id,
			Runtime:     "nodejs24.x",
			Handler:     "index.handler",
			AssetDir:    filepath.Join(oldDir, "asset.old"),
			MemoryMB:    128,
			Timeout:     3,
			Environment: map[string]string{"A": "1"},
		}
		previous[id] = function
		runner.invokers[id] = &FunctionProcess{
			Function:  function,
			Container: "container-" + id,
			Image:     "old-image",
			logf:      runner.logf,
		}
	}
	runner.spec = &Spec{Functions: []FunctionSpec{previous["Fn1"], previous["Fn2"]}}
	next := &Spec{Functions: []FunctionSpec{}}
	for _, id := range []string{"Fn1", "Fn2"} {
		changed := previous[id]
		changed.AssetDir = filepath.Join(newDir, "asset.new")
		changed.Environment = map[string]string{"A": "2"}
		next.Functions = append(next.Functions, changed)
	}
	return &watchBatchFixture{
		runner:   runner,
		fake:     fake,
		output:   output,
		oldDir:   oldDir,
		newDir:   newDir,
		previous: previous,
		next:     next,
	}
}

func TestApplyWatchedSpecPreflightFailureRestartsNothing(t *testing.T) {
	fake := &restartFakeDocker{buildErr: errors.New("build failed")}
	fixture := newWatchBatchFixture(t, fake)
	// The second function is a container-image function: its image build fails
	// in the pre-flight pass, before the first function is restarted.
	fixture.next.Functions[1].AssetDir = ""
	fixture.next.Functions[1].PackageType = "Image"
	fixture.next.Functions[1].ImageAsset = &DockerImageAssetSpec{Hash: "asset", Directory: filepath.Join(fixture.newDir, "image")}

	applied, err := fixture.runner.applyWatchedSpec(context.Background(), fixture.next, []string{"Fn1", "Fn2"}, fixture.newDir)
	if err == nil || applied {
		t.Fatalf("a failed image build was applied: applied=%v err=%v", applied, err)
	}
	if !strings.Contains(err.Error(), "build failed") {
		t.Fatalf("the error does not name the failed build: %v", err)
	}
	if fake.runs != 0 {
		t.Fatalf("the pre-flight failure restarted %d container(s)", fake.runs)
	}
	if got := fixture.runner.invokers["Fn1"].Function.Environment["A"]; got != "1" {
		t.Fatalf("Fn1 took the new definition: %+v", fixture.runner.invokers["Fn1"].Function)
	}
	if _, statErr := os.Stat(filepath.Join(fixture.oldDir, "asset.old")); statErr != nil {
		t.Fatalf("the previous assembly disappeared: %v", statErr)
	}
}

func TestApplyWatchedSpecRollsBackAFailedBatch(t *testing.T) {
	fake := &restartFakeDocker{failRuns: map[int]bool{2: true}}
	fixture := newWatchBatchFixture(t, fake)

	applied, err := fixture.runner.applyWatchedSpec(context.Background(), fixture.next, []string{"Fn1", "Fn2"}, fixture.newDir)
	if err == nil || applied {
		t.Fatalf("a failed restart was applied: applied=%v err=%v", applied, err)
	}
	if fake.runs != 4 {
		t.Fatalf("docker run calls = %d, want 4 (two restarts, the failed function's restore and the rollback)", fake.runs)
	}
	for _, id := range []string{"Fn1", "Fn2"} {
		process := fixture.runner.invokers[id]
		if process.Function.Environment["A"] != "1" {
			t.Fatalf("%s was not rolled back: %+v", id, process.Function)
		}
		if process.Function.AssetDir != filepath.Join(fixture.oldDir, "asset.old") {
			t.Fatalf("%s mounts %q, not the previous assembly", id, process.Function.AssetDir)
		}
	}
	if _, statErr := os.Stat(filepath.Join(fixture.oldDir, "asset.old")); statErr != nil {
		t.Fatalf("the previous assembly disappeared: %v", statErr)
	}
	if _, statErr := os.Stat(fixture.newDir); !os.IsNotExist(statErr) {
		t.Fatalf("the rolled-back assembly directory was kept: %v", statErr)
	}
	if !strings.Contains(fixture.output.String(), "rolled back 1 replaced function(s); the previous assembly keeps serving") {
		t.Fatalf("the log does not name the rollback: %s", fixture.output.String())
	}
}

func TestApplyWatchedSpecKeepsTheNewAssemblyWhenTheRollbackFails(t *testing.T) {
	fake := &restartFakeDocker{failRuns: map[int]bool{2: true, 4: true}}
	fixture := newWatchBatchFixture(t, fake)

	applied, err := fixture.runner.applyWatchedSpec(context.Background(), fixture.next, []string{"Fn1", "Fn2"}, fixture.newDir)
	if err == nil || !applied {
		t.Fatalf("a partially applied batch was reported as rolled back: applied=%v err=%v", applied, err)
	}
	if fake.runs != 4 {
		t.Fatalf("docker run calls = %d, want 4", fake.runs)
	}
	if _, statErr := os.Stat(fixture.newDir); statErr != nil {
		t.Fatalf("the new assembly directory a container may mount was removed: %v", statErr)
	}
	if !strings.Contains(fixture.output.String(), "partially applied: 1 restarted, 1 not; a restart is required") {
		t.Fatalf("the log does not name the partial apply: %s", fixture.output.String())
	}
	if strings.Contains(fixture.output.String(), "the previous assembly keeps serving") {
		t.Fatalf("the partial apply claimed the previous assembly keeps serving: %s", fixture.output.String())
	}
}

func TestCleanupOldAssembliesKeepsMountedDirectories(t *testing.T) {
	fake := &restartFakeDocker{}
	fixture := newWatchBatchFixture(t, fake)
	unmounted := filepath.Join(fixture.runner.scratch, "watch", "assembly-3")
	if err := os.MkdirAll(unmounted, 0o750); err != nil {
		t.Fatal(err)
	}

	fixture.runner.cleanupOldAssemblies(fixture.newDir)
	if _, err := os.Stat(filepath.Join(fixture.oldDir, "asset.old")); err != nil {
		t.Fatalf("a directory a running function mounts was removed: %v", err)
	}
	if _, err := os.Stat(unmounted); !os.IsNotExist(err) {
		t.Fatalf("an unmounted assembly directory was kept: %v", err)
	}
}
