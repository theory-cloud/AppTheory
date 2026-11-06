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
		options:     Options{Stdout: output},
		scratch:     scratch,
		docker:      &Docker{exec: fake.exec},
		clock:       RealClock{},
		delivery:    NewDeliveryEngine(RealClock{}, 0, nil, nil, nil),
		invokers:    map[string]*FunctionProcess{},
		backends:    map[string]backendProcess{},
		transports:  map[string]*Transport{},
		builtImages: map[string]string{},
		namePrefix:  "watch-test",
		images:      map[string]string{"node": "public.ecr.aws/lambda/nodejs:24@sha256:" + strings.Repeat("c", 64)},
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

// makeImageFunctions turns both fixture functions into container-image
// functions that build from imageDir, and records the tag and image id each
// running function has before the reload.
func (f *watchBatchFixture) makeImageFunctions(t *testing.T, imageDir string) (map[string]string, map[string]string) {
	t.Helper()
	if err := os.MkdirAll(imageDir, 0o750); err != nil {
		t.Fatal(err)
	}
	tags := map[string]string{}
	ids := map[string]string{}
	for index, id := range []string{"Fn1", "Fn2"} {
		previous := f.previous[id]
		previous.AssetDir = ""
		previous.PackageType = "Image"
		previous.ImageAsset = &DockerImageAssetSpec{Hash: "old", Directory: imageDir}
		tag := f.runner.functionImageTag(previous)
		tags[id] = tag
		ids[id] = "sha256:old-" + strings.TrimPrefix(id, "Fn")
		f.runner.invokers[id].Function = previous
		f.runner.invokers[id].Image = tag
		f.fake.imageStore()[tag] = ids[id]

		next := f.next.Functions[index]
		next.AssetDir = ""
		next.PackageType = "Image"
		next.ImageAsset = &DockerImageAssetSpec{Hash: "new", Directory: imageDir}
		f.next.Functions[index] = next
	}
	return tags, ids
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

func TestApplyWatchedSpecKeepsUnchangedFunctionsServing(t *testing.T) {
	fake := &restartFakeDocker{}
	fixture := newWatchBatchFixture(t, fake)
	// Fn2 is byte-identical to the running definition: the plan must leave it
	// alone, and the cleanup must keep the assembly its /var/task still mounts.
	fixture.next.Functions[1] = fixture.previous["Fn2"]
	unchanged := fixture.runner.invokers["Fn2"]

	applied, err := fixture.runner.applyWatchedSpec(context.Background(), fixture.next, []string{"Fn1", "Fn2"}, fixture.newDir)
	if err != nil || !applied {
		t.Fatalf("a valid reload was not applied: applied=%v err=%v", applied, err)
	}
	if fake.runs != 1 {
		t.Fatalf("docker run calls = %d, want 1 (only Fn1 restarted)", fake.runs)
	}
	if fixture.runner.invokers["Fn2"] != unchanged {
		t.Fatal("the unchanged function got a new process")
	}
	if unchanged.Function.AssetDir != filepath.Join(fixture.oldDir, "asset.old") {
		t.Fatalf("Fn2 mounts %q, not the previous assembly", unchanged.Function.AssetDir)
	}
	// The apply already cleaned the watch root; run it again to pin that the
	// directory a live container mounts survives every pass.
	fixture.runner.cleanupOldAssemblies(fixture.newDir)
	for _, path := range []string{
		filepath.Join(fixture.oldDir, "asset.old", "index.js"),
		filepath.Join(fixture.newDir, "asset.new", "index.js"),
	} {
		if _, statErr := os.Stat(path); statErr != nil {
			t.Fatalf("a directory a serving function mounts was removed: %v", statErr)
		}
	}
	if got := fixture.runner.invokers["Fn1"].Function.AssetDir; got != filepath.Join(fixture.newDir, "asset.new") {
		t.Fatalf("Fn1 mounts %q, not the new assembly", got)
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

func TestApplyWatchedSpecRollsBackAContainerImageFunctionByID(t *testing.T) {
	fake := &restartFakeDocker{failRuns: map[int]bool{2: true}}
	fixture := newWatchBatchFixture(t, fake)
	tags, oldIDs := fixture.makeImageFunctions(t, filepath.Join(fixture.newDir, "image"))

	applied, err := fixture.runner.applyWatchedSpec(context.Background(), fixture.next, []string{"Fn1", "Fn2"}, fixture.newDir)
	if err == nil || applied {
		t.Fatalf("a failed image function start was applied: applied=%v err=%v", applied, err)
	}
	if fake.runs != 4 {
		t.Fatalf("docker run calls = %d, want 4 (two starts, the failed start's restore and the rollback)", fake.runs)
	}
	// The rebuild moved each tag to its new image. Every restore must start the
	// immutable id the plan recorded, never the tag that now names new content.
	if got := fake.runImages[2]; got != oldIDs["Fn2"] {
		t.Fatalf("the failed start restored %q, want the old image id %q", got, oldIDs["Fn2"])
	}
	if got := fake.runImages[3]; got != oldIDs["Fn1"] {
		t.Fatalf("the batch rollback started %q, want the old image id %q", got, oldIDs["Fn1"])
	}
	for id, tag := range tags {
		if got := fake.images[tag]; got != oldIDs[id] {
			t.Fatalf("tag %s names %q after the rollback, want the old image %q", tag, got, oldIDs[id])
		}
		if got := fixture.runner.invokers[id].Image; got != oldIDs[id] {
			t.Fatalf("%s runs image %q, want the old image id %q", id, got, oldIDs[id])
		}
	}
	if fake.images[tags["Fn1"]] == "sha256:built-1" || fake.images[tags["Fn2"]] == "sha256:built-2" {
		t.Fatalf("a rebuilt image was left as the tag's target: %+v", fake.images)
	}
	removed := map[string]bool{}
	for _, id := range fake.removed {
		removed[id] = true
	}
	for _, id := range []string{"sha256:built-1", "sha256:built-2"} {
		if !removed[id] {
			t.Fatalf("the rebuilt image %s survived the rollback: %v", id, fake.removed)
		}
	}
	if len(fake.refused) != 0 {
		t.Fatalf("the daemon refused a removal of this run's own rebuild: %v", fake.refused)
	}
	if !strings.Contains(fixture.output.String(), "rolled back 1 replaced function(s); the previous assembly keeps serving") {
		t.Fatalf("the log does not name the rollback: %s", fixture.output.String())
	}
}

func TestApplyWatchedSpecKeepsAnImageAnotherTagUses(t *testing.T) {
	// Both builds produce the same content id, and a foreign tag names it, as
	// a concurrent run's tag could. After the rollback moves this run's tags
	// back, the rebuilt image carries only that foreign tag, so the inspect must
	// leave it alone without attempting an unforced removal (which the daemon
	// would answer by untagging the foreign tag and deleting the image).
	fake := &restartFakeDocker{sharedBuildID: "sha256:shared", failRuns: map[int]bool{2: true}}
	fixture := newWatchBatchFixture(t, fake)
	tags, oldIDs := fixture.makeImageFunctions(t, filepath.Join(fixture.newDir, "image"))
	fake.imageStore()["other-run-image"] = "sha256:shared"

	applied, err := fixture.runner.applyWatchedSpec(context.Background(), fixture.next, []string{"Fn1", "Fn2"}, fixture.newDir)
	if err == nil || applied {
		t.Fatalf("a failed image function start was applied: applied=%v err=%v", applied, err)
	}
	if got := fake.imageStore()["other-run-image"]; got != "sha256:shared" {
		t.Fatalf("a foreign tag's image was removed: %q", got)
	}
	if len(fake.removed) != 0 || len(fake.refused) != 0 {
		t.Fatalf("the cleanup touched an image a foreign tag names: removed=%v refused=%v", fake.removed, fake.refused)
	}
	if !strings.Contains(fixture.output.String(), "image sha256:shared is still referenced by tag other-run-image; leaving it in place") {
		t.Fatalf("the log does not explain why the image was kept: %s", fixture.output.String())
	}
	for id, tag := range tags {
		if got := fake.images[tag]; got != oldIDs[id] {
			t.Fatalf("tag %s names %q after the rollback, want the old image %q", tag, got, oldIDs[id])
		}
	}
}

func TestApplyWatchedSpecKeepsAnImageAContainerUses(t *testing.T) {
	// A stopped container, here a concurrent run's, is the reference the daemon
	// always refuses to remove an image under. The inspect must see it and skip
	// the removal rather than rely on that refusal.
	fake := &restartFakeDocker{sharedBuildID: "sha256:shared", failRuns: map[int]bool{2: true}}
	fixture := newWatchBatchFixture(t, fake)
	fixture.makeImageFunctions(t, filepath.Join(fixture.newDir, "image"))
	fake.containerStore()["other-run-container"] = "sha256:shared"

	applied, err := fixture.runner.applyWatchedSpec(context.Background(), fixture.next, []string{"Fn1", "Fn2"}, fixture.newDir)
	if err == nil || applied {
		t.Fatalf("a failed image function start was applied: applied=%v err=%v", applied, err)
	}
	if len(fake.removed) != 0 || len(fake.refused) != 0 {
		t.Fatalf("the cleanup touched an image a container uses: removed=%v refused=%v", fake.removed, fake.refused)
	}
	if !strings.Contains(fixture.output.String(), "image sha256:shared is still referenced by container other-run-container; leaving it in place") {
		t.Fatalf("the log does not explain why the image was kept: %s", fixture.output.String())
	}
}

func TestApplyWatchedSpecRemovesTheImageOfAnAddedFunctionItRollsBack(t *testing.T) {
	// Fn3 is added by the reload and starts; Fn1's replacement then fails. The
	// rollback stops Fn3; the image this run built for it has no previous
	// content and would otherwise leak.
	fake := &restartFakeDocker{failRuns: map[int]bool{2: true}}
	fixture := newWatchBatchFixture(t, fake)
	imageDir := filepath.Join(fixture.newDir, "image")
	if err := os.MkdirAll(imageDir, 0o750); err != nil {
		t.Fatal(err)
	}
	added := FunctionSpec{
		LogicalID:   "Fn3",
		Runtime:     "nodejs24.x",
		Handler:     "index.handler",
		PackageType: "Image",
		ImageAsset:  &DockerImageAssetSpec{Hash: "new", Directory: imageDir},
		MemoryMB:    128,
		Timeout:     3,
	}
	changed := fixture.previous["Fn1"]
	changed.Environment = map[string]string{"A": "3"}
	fixture.next.Functions = []FunctionSpec{added, changed}

	applied, err := fixture.runner.applyWatchedSpec(context.Background(), fixture.next, []string{"Fn3", "Fn1"}, fixture.newDir)
	if err == nil || applied {
		t.Fatalf("a failed batch was applied: applied=%v err=%v", applied, err)
	}
	tag := fixture.runner.functionImageTag(added)
	if _, ok := fake.imageStore()[tag]; ok {
		t.Fatalf("the added function's tag survived the rollback: %+v", fake.imageStore())
	}
	if len(fake.removed) != 1 || fake.removed[0] != "sha256:built-1" {
		t.Fatalf("removed images = %v, want the added function's rebuild", fake.removed)
	}
	if _, ok := fixture.runner.invokers["Fn3"]; ok {
		t.Fatal("the rolled-back added function stayed in the invoker set")
	}
}

func TestApplyWatchedSpecRemovesTheReplacedImageAfterSuccess(t *testing.T) {
	fake := &restartFakeDocker{}
	fixture := newWatchBatchFixture(t, fake)
	tags, oldIDs := fixture.makeImageFunctions(t, filepath.Join(fixture.newDir, "image"))
	// Fn2 is byte-identical to the running definition, so only Fn1 is planned.
	fixture.next.Functions[1] = fixture.runner.invokers["Fn2"].Function

	applied, err := fixture.runner.applyWatchedSpec(context.Background(), fixture.next, []string{"Fn1", "Fn2"}, fixture.newDir)
	if err != nil || !applied {
		t.Fatalf("a valid image reload was not applied: applied=%v err=%v", applied, err)
	}
	if fake.runs != 1 {
		t.Fatalf("docker run calls = %d, want 1", fake.runs)
	}
	if got := fake.images[tags["Fn1"]]; got == "" || got == oldIDs["Fn1"] {
		t.Fatalf("the tag names %q after a successful apply, want the rebuilt image", got)
	}
	if len(fake.removed) != 1 || fake.removed[0] != oldIDs["Fn1"] {
		t.Fatalf("removed images = %v, want only the replaced image %q", fake.removed, oldIDs["Fn1"])
	}
}

func TestApplyWatchedSpecFailsClosedWhenThePreviousImageIsGone(t *testing.T) {
	fake := &restartFakeDocker{}
	fixture := newWatchBatchFixture(t, fake)
	fixture.makeImageFunctions(t, filepath.Join(fixture.newDir, "image"))
	fixture.runner.invokers["Fn1"].Image = "gone-image"
	fixture.next.Functions[1] = fixture.runner.invokers["Fn2"].Function

	applied, err := fixture.runner.applyWatchedSpec(context.Background(), fixture.next, []string{"Fn1", "Fn2"}, fixture.newDir)
	if err == nil || applied {
		t.Fatalf("a reload whose previous image is gone was applied: applied=%v err=%v", applied, err)
	}
	if !strings.Contains(err.Error(), "resolve the image a rollback would restore") || !strings.Contains(err.Error(), "gone-image") {
		t.Fatalf("the error does not name the missing image: %v", err)
	}
	if fake.builds != 0 || fake.runs != 0 {
		t.Fatalf("the failed plan built %d image(s) and ran %d container(s)", fake.builds, fake.runs)
	}
	if got := fixture.runner.invokers["Fn1"].Image; got != "gone-image" {
		t.Fatalf("Fn1 changed its image before the plan failed: %q", got)
	}
	if got := fixture.runner.invokers["Fn1"].Function.ImageAsset.Hash; got != "old" {
		t.Fatalf("Fn1 took the new definition before the plan failed: %q", got)
	}
}

func TestApplyWatchedSpecLogsATagRestoreFailure(t *testing.T) {
	fake := &restartFakeDocker{failRuns: map[int]bool{2: true}, tagErr: errors.New("tag failed")}
	fixture := newWatchBatchFixture(t, fake)
	_, oldIDs := fixture.makeImageFunctions(t, filepath.Join(fixture.newDir, "image"))

	applied, err := fixture.runner.applyWatchedSpec(context.Background(), fixture.next, []string{"Fn1", "Fn2"}, fixture.newDir)
	if err == nil || applied {
		t.Fatalf("a failed image function start was applied: applied=%v err=%v", applied, err)
	}
	if fake.runs != 4 {
		t.Fatalf("docker run calls = %d, want 4", fake.runs)
	}
	if got := fake.runImages[3]; got != oldIDs["Fn1"] {
		t.Fatalf("the batch rollback started %q, want the old image id %q", got, oldIDs["Fn1"])
	}
	if len(fake.removed) != 0 {
		t.Fatalf("a failed apply removed an image: %v", fake.removed)
	}
	log := fixture.output.String()
	if !strings.Contains(log, "could not point image tag") || !strings.Contains(log, "the rolled-back container runs that image by id") {
		t.Fatalf("the log does not name the failed tag restore: %s", log)
	}
	if !strings.Contains(log, "rolled back 1 replaced function(s); the previous assembly keeps serving") {
		t.Fatalf("the rollback did not report the serving state: %s", log)
	}
}

func TestApplyWatchedSpecKeepsTheNewAssemblyWhenEveryRollbackFails(t *testing.T) {
	fake := &restartFakeDocker{failRuns: map[int]bool{2: true, 4: true}}
	fixture := newWatchBatchFixture(t, fake)

	applied, err := fixture.runner.applyWatchedSpec(context.Background(), fixture.next, []string{"Fn1", "Fn2"}, fixture.newDir)
	if err == nil || !applied {
		t.Fatalf("a batch whose only rollback failed was reported as rolled back: applied=%v err=%v", applied, err)
	}
	if fake.runs != 4 {
		t.Fatalf("docker run calls = %d, want 4", fake.runs)
	}
	if _, statErr := os.Stat(fixture.newDir); statErr != nil {
		t.Fatalf("the new assembly directory a container may mount was removed: %v", statErr)
	}
	log := fixture.output.String()
	if !strings.Contains(log, "no replaced function was restored; a restart is required") {
		t.Fatalf("the log does not report the total restore failure: %s", log)
	}
	for _, unwanted := range []string{"partially applied", "the previous assembly keeps serving"} {
		if strings.Contains(log, unwanted) {
			t.Fatalf("the total restore failure claimed %q: %s", unwanted, log)
		}
	}
}

func TestApplyWatchedSpecReportsNoApplyWhenTheFirstRestoreFails(t *testing.T) {
	fake := &restartFakeDocker{failRuns: map[int]bool{1: true, 2: true}}
	fixture := newWatchBatchFixture(t, fake)

	applied, err := fixture.runner.applyWatchedSpec(context.Background(), fixture.next, []string{"Fn1", "Fn2"}, fixture.newDir)
	if err == nil || !applied {
		t.Fatalf("a failed first restore was reported as a clean rollback: applied=%v err=%v", applied, err)
	}
	if _, statErr := os.Stat(fixture.newDir); statErr != nil {
		t.Fatalf("the new assembly directory a container may mount was removed: %v", statErr)
	}
	log := fixture.output.String()
	if !strings.Contains(log, "no function was applied and the failed function's previous definition was not restored") {
		t.Fatalf("the log does not report the failed restore: %s", log)
	}
	for _, unwanted := range []string{"partially applied", "the previous assembly keeps serving"} {
		if strings.Contains(log, unwanted) {
			t.Fatalf("the failed first restore claimed %q: %s", unwanted, log)
		}
	}
}

func TestFailWatchedApplyReportsAPartialRollback(t *testing.T) {
	fake := &restartFakeDocker{failRun: 1}
	fixture := newWatchBatchFixture(t, fake)
	applied := []appliedWatchedFunction{
		{process: fixture.runner.invokers["Fn1"], previous: fixture.previous["Fn1"]},
		{process: fixture.runner.invokers["Fn2"], previous: fixture.previous["Fn2"]},
	}
	// The reverse rollback tries Fn2 first, so the first run it starts fails.
	stillServing, err := fixture.runner.failWatchedApply(
		context.Background(), fixture.next, []string{"Fn1", "Fn2"}, fixture.newDir, applied, errors.New("apply failed"))
	if err == nil || !stillServing {
		t.Fatalf("a partial rollback was reported as a clean rollback: applied=%v err=%v", stillServing, err)
	}
	log := fixture.output.String()
	if !strings.Contains(log, "partially applied: 1 replaced function(s) restored, 1 not; a restart is required") {
		t.Fatalf("the log does not name the partial rollback: %s", log)
	}
	for _, unwanted := range []string{"no replaced function was restored", "the previous assembly keeps serving"} {
		if strings.Contains(log, unwanted) {
			t.Fatalf("the partial rollback claimed %q: %s", unwanted, log)
		}
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
