package localrunner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"
)

// Watch and rebuild.
//
// `--watch` follows the CDK CLI's own watch configuration: when the app's
// cdk.json declares a "watch" object, "include" and "exclude" say which files
// trigger a rebuild; otherwise the app directory is watched. Each change
// re-synthesizes the app, derives a new Spec and applies the parts a live
// session can apply:
//
//   - a function whose asset hash, image asset, environment, limits, layers or
//     runtime changed is replaced through the same reset path a Lambda
//     execution-environment reset uses; its logical id, Runtime API behavior
//     and warm-state semantics stay;
//   - routes, event sources, rules, subscriptions and delivery wiring are
//     re-derived; every listener keeps its net.Listener and URL;
//   - a function added by the change starts, and one removed stops.
//
// A change the runner cannot apply live (a new API listener, a new WebSocket
// API, a changed CloudFront distribution topology, or a new resource that needs
// a backend this run did not start) is reported by name and requires a restart;
// the previous assembly keeps serving.
//
// https://docs.aws.amazon.com/cdk/v2/guide/cli.html#cli-watch

const (
	watchPollInterval = 300 * time.Millisecond
	watchDebounce     = 500 * time.Millisecond
)

type watchSupervisor struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type watchFileState struct {
	Size    int64
	ModTime time.Time
}

type watchConfig struct {
	Root    string
	Include []string
	Exclude []string
}

// startWatch starts the polling watcher when --watch is set. The watcher stops
// before cleanup removes the containers.
func (r *Runner) startWatch(ctx context.Context) {
	if !r.options.Watch {
		return
	}
	watchCtx, cancel := context.WithCancel(ctx)
	supervisor := &watchSupervisor{cancel: cancel, done: make(chan struct{})}
	r.watch = supervisor
	config := loadWatchConfig(r.options.AppDir)
	r.logf("watch: polling %s (include %s; exclude %s)", config.Root,
		strings.Join(config.Include, ","), strings.Join(config.Exclude, ","))
	go func() {
		defer close(supervisor.done)
		r.watchLoop(watchCtx, config)
	}()
}

// stopWatch cancels the watcher and waits for an in-flight synthesis to finish.
func (r *Runner) stopWatch() {
	if r.watch == nil {
		return
	}
	r.watch.cancel()
	<-r.watch.done
	r.watch = nil
}

// watchLoop polls the watched tree, debounces a burst of edits and runs one
// synthesis at a time. An edit made while a synthesis is running schedules
// another one.
func (r *Runner) watchLoop(ctx context.Context, config watchConfig) {
	previous := snapshotWatchTree(config)
	ticker := time.NewTicker(watchPollInterval)
	defer ticker.Stop()
	var pending bool
	var lastChange time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			current := snapshotWatchTree(config)
			if !reflect.DeepEqual(previous, current) {
				previous = current
				pending = true
				lastChange = now
				continue
			}
			if !pending || now.Sub(lastChange) < watchDebounce {
				continue
			}
			pending = false
			before := previous
			if err := r.reloadWatchedApp(ctx); err != nil {
				// A reported error already carries the serving-state line from
				// applyWatchedSpec; only a pre-apply failure keeps the previous
				// assembly, so only that path appends the sentence.
				var reported *watchStateReported
				if !errors.As(err, &reported) {
					r.logf("watch: %v; the previous assembly keeps serving", err)
				}
			}
			config = loadWatchConfig(r.options.AppDir)
			after := snapshotWatchTree(config)
			if !reflect.DeepEqual(before, after) {
				pending = true
				lastChange = time.Now()
			}
			previous = after
		}
	}
}

// loadWatchConfig reads cdk.json's watch object. Without one, CDK watches the
// whole app directory ("The default value of include is **/*").
func loadWatchConfig(appDir string) watchConfig {
	config := watchConfig{Root: appDir, Include: []string{"**/*"}}
	raw, err := os.ReadFile(filepath.Join(appDir, "cdk.json")) //nolint:gosec // the app directory is the caller's
	if err != nil {
		return config
	}
	var document struct {
		Watch json.RawMessage `json:"watch"`
	}
	if err := json.Unmarshal(raw, &document); err != nil || len(document.Watch) == 0 {
		return config
	}
	var watch struct {
		Include json.RawMessage `json:"include"`
		Exclude json.RawMessage `json:"exclude"`
	}
	if err := json.Unmarshal(document.Watch, &watch); err != nil {
		return config
	}
	if include := watchPatterns(watch.Include); len(include) > 0 {
		config.Include = include
	}
	config.Exclude = watchPatterns(watch.Exclude)
	return config
}

// watchPatterns accepts the string or array form cdk.json allows.
func watchPatterns(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		if strings.TrimSpace(single) == "" {
			return nil
		}
		return []string{normalizeWatchPattern(single)}
	}
	var many []string
	if err := json.Unmarshal(raw, &many); err != nil {
		return nil
	}
	out := make([]string, 0, len(many))
	for _, pattern := range many {
		if trimmed := strings.TrimSpace(pattern); trimmed != "" {
			out = append(out, normalizeWatchPattern(trimmed))
		}
	}
	return out
}

func normalizeWatchPattern(pattern string) string {
	return strings.TrimPrefix(filepath.ToSlash(strings.TrimSpace(pattern)), "./")
}

// snapshotWatchTree records the size and mtime of every watched file.
func snapshotWatchTree(config watchConfig) map[string]watchFileState {
	snapshot := map[string]watchFileState{}
	root := config.Root
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error { //nolint:errcheck // a disappearing file is not a watch failure
		if err != nil {
			return nil
		}
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		relative = filepath.ToSlash(relative)
		if entry.IsDir() {
			if relative != "." && watchGeneratedDir(entry.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if !watchIncludes(config, relative) {
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return nil
		}
		snapshot[relative] = watchFileState{Size: info.Size(), ModTime: info.ModTime()}
		return nil
	})
	return snapshot
}

// watchGeneratedDir skips dependency and build trees. The CDK asset staging
// directory is written by synthesis itself; watching it would loop forever.
func watchGeneratedDir(name string) bool {
	switch name {
	case ".git", "cdk.out", "node_modules", ".venv", "__pycache__", ".cdk-asset-stage", ".ruff_cache":
		return true
	default:
		return false
	}
}

func watchIncludes(config watchConfig, relative string) bool {
	included := false
	for _, pattern := range config.Include {
		if watchGlobMatch(pattern, relative) {
			included = true
			break
		}
	}
	if !included {
		return false
	}
	for _, pattern := range config.Exclude {
		if watchGlobMatch(pattern, relative) {
			return false
		}
	}
	return true
}

// watchGlobMatch matches a git-style pattern against a slash-separated path.
// "**" matches zero or more path segments; "*" and "?" match within one
// segment; braces are not expanded (CDK's watch patterns do not use them).
func watchGlobMatch(pattern, path string) bool {
	patternParts := splitWatchPath(pattern)
	pathParts := splitWatchPath(path)
	var match func(patternIndex, pathIndex int) bool
	match = func(patternIndex, pathIndex int) bool {
		if patternIndex == len(patternParts) {
			return pathIndex == len(pathParts)
		}
		if patternParts[patternIndex] == "**" {
			for next := pathIndex; next <= len(pathParts); next++ {
				if match(patternIndex+1, next) {
					return true
				}
			}
			return false
		}
		if pathIndex >= len(pathParts) {
			return false
		}
		ok, err := filepath.Match(patternParts[patternIndex], pathParts[pathIndex])
		if err != nil || !ok {
			return false
		}
		return match(patternIndex+1, pathIndex+1)
	}
	return match(0, 0)
}

func splitWatchPath(value string) []string {
	trimmed := strings.Trim(value, "/")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "/")
}

// watchAssemblyIndex counts the watch syntheses so each one gets a fresh
// directory and the previous assembly can be removed after a successful swap.
func (r *Runner) nextWatchAssemblyDir() string {
	r.watchAssembly++
	dir := filepath.Join(r.scratch, "watch", fmt.Sprintf("assembly-%d", r.watchAssembly))
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return dir
	}
	return dir
}

// reloadWatchedApp synthesizes the app and applies the new surface.
func (r *Runner) reloadWatchedApp(ctx context.Context) error {
	assemblyDir := r.nextWatchAssemblyDir()
	r.logf("watch: source change detected; synthesizing into %s", assemblyDir)
	synthCtx, cancel := context.WithTimeout(ctx, r.options.SynthTimeout)
	defer cancel()
	if err := synthRunner(synthCtx, SynthOptions{
		AppDir:    r.options.AppDir,
		OutputDir: assemblyDir,
		Context:   r.options.Context,
		Stderr:    r.options.Stdout,
	}); err != nil {
		return fmt.Errorf("synth failed: %w", err)
	}
	stacks, err := loadAssembly(assemblyDir)
	if err != nil {
		return err
	}
	var spec *Spec
	if r.options.AllowNoSurface {
		spec, err = deriveSpecInternal(assemblyDir, stacks)
	} else {
		spec, err = deriveSpec(assemblyDir, stacks)
	}
	if err != nil {
		return err
	}
	if applyErr := r.applyOriginOverrides(spec); applyErr != nil {
		return applyErr
	}
	if storeErr := r.materializeKeyValueStores(spec); storeErr != nil {
		return storeErr
	}
	refreshCloudFrontSkips(spec)
	targets, err := r.runtimeFunctions(spec)
	if err != nil {
		return err
	}
	if refusals := r.watchRefusals(spec); len(refusals) > 0 {
		for _, refusal := range refusals {
			r.logf("watch: %s; a restart is required, keeping the previous assembly", refusal)
		}
		_ = os.RemoveAll(assemblyDir) //nolint:errcheck // the refused assembly is not served
		return nil
	}
	applied, err := r.applyWatchedSpec(ctx, spec, targets, assemblyDir)
	if err != nil {
		if !applied {
			_ = os.RemoveAll(assemblyDir) //nolint:errcheck // a partially applied assembly is not served
		}
		return err
	}
	return nil
}

// watchRefusals names changes the live runner cannot apply. It runs before any
// state is mutated.
func (r *Runner) watchRefusals(next *Spec) []string {
	current := r.CurrentSpec()
	if current == nil {
		return []string{"the run has no current assembly"}
	}
	var refusals []string
	if added, removed := apiSetDifference(current, next); len(added) > 0 || len(removed) > 0 {
		refusals = append(refusals, fmt.Sprintf("API listeners changed (added %s, removed %s)",
			strings.Join(added, ","), strings.Join(removed, ",")))
	}
	if added, removed := webSocketSetDifference(current, next); len(added) > 0 || len(removed) > 0 {
		refusals = append(refusals, fmt.Sprintf("WebSocket API listeners changed (added %s, removed %s)",
			strings.Join(added, ","), strings.Join(removed, ",")))
	}
	if !reflect.DeepEqual(current.CloudFront, next.CloudFront) {
		refusals = append(refusals, "the CloudFront distribution topology changed")
	}
	if !reflect.DeepEqual(current.CodeBuildProjects, next.CodeBuildProjects) {
		refusals = append(refusals, "the CodeBuild project set changed")
	}
	if missing := newResourceBackends(current, next, r); len(missing) > 0 {
		refusals = append(refusals, missing...)
	}
	return refusals
}

// apiSetDifference compares the listener identities. Routes on an existing
// listener are live; a new or removed listener is not.
func apiSetDifference(current, next *Spec) (added, removed []string) {
	key := func(class APIClass, id string) string { return string(class) + "/" + id }
	currentSet := map[string]bool{}
	for _, api := range current.HTTPAPIs() {
		currentSet[key(api.Class, api.LogicalID)] = true
	}
	for _, url := range current.FunctionURLs {
		currentSet[key(APIFunctionURL, url.LogicalID)] = true
	}
	nextSet := map[string]bool{}
	for _, api := range next.HTTPAPIs() {
		nextSet[key(api.Class, api.LogicalID)] = true
	}
	for _, url := range next.FunctionURLs {
		nextSet[key(APIFunctionURL, url.LogicalID)] = true
	}
	for id := range nextSet {
		if !currentSet[id] {
			added = append(added, id)
		}
	}
	for id := range currentSet {
		if !nextSet[id] {
			removed = append(removed, id)
		}
	}
	sort.Strings(added)
	sort.Strings(removed)
	return added, removed
}

// webSocketSetDifference compares the WebSocket listener identities. A route
// change on an existing listener is live; a new listener is not.
func webSocketSetDifference(current, next *Spec) (added, removed []string) {
	currentSet := map[string]bool{}
	for _, api := range current.WebSockets {
		currentSet[api.LogicalID] = true
	}
	nextSet := map[string]bool{}
	for _, api := range next.WebSockets {
		nextSet[api.LogicalID] = true
	}
	for id := range nextSet {
		if !currentSet[id] {
			added = append(added, id)
		}
	}
	for id := range currentSet {
		if !nextSet[id] {
			removed = append(removed, id)
		}
	}
	sort.Strings(added)
	sort.Strings(removed)
	return added, removed
}

// newResourceBackends reports a newly declared resource whose backend this run
// did not start. An existing resource is not re-reported: the run already
// serves it.
func newResourceBackends(current, next *Spec, r *Runner) []string {
	existing := map[string]bool{}
	for _, resource := range current.Resources {
		existing[resource.Stack+"/"+resource.LogicalID] = true
	}
	serviceForType := map[string]string{
		typeDynamoTable:     backendDynamoDB,
		typeS3Bucket:        "s3",
		typeSQSQueue:        backendSQS,
		typeKinesisStream:   "kinesis",
		typeSNSTopic:        "sns",
		typeSSMParameter:    "ssm",
		typeSecretsSecret:   "secretsmanager",
		typeCognitoUserPool: "cognito-idp",
		typeCognitoClient:   "cognito-idp",
		typeKMSKey:          "kms",
		typeKMSAlias:        "kms",
	}
	var out []string
	for _, resource := range next.Resources {
		if existing[resource.Stack+"/"+resource.LogicalID] {
			continue
		}
		service, ok := serviceForType[resource.Type]
		if !ok {
			continue
		}
		if _, running := r.backendForService(service); running {
			continue
		}
		out = append(out, fmt.Sprintf("resource %s needs the %s backend", resource.LogicalID, service))
	}
	return out
}

// watchedFunctionApply is one function a reload batch starts or replaces. The
// image is resolved for every entry before the first container changes, so a
// build or image failure restarts nothing. An image function also carries the
// immutable id of the image it runs now: the rebuild moves the function's tag
// to the new content, so only the id identifies the content a rollback restores.
type watchedFunctionApply struct {
	function        FunctionSpec
	previous        *FunctionProcess
	image           string
	previousImageID string
	rebuiltImageID  string
	reason          string
}

// appliedWatchedFunction is one function the batch already started or
// replaced, with the definition it ran before so a later failure can restore
// it. An added function has no previous definition; its rollback stops it.
type appliedWatchedFunction struct {
	process         *FunctionProcess
	previous        FunctionSpec
	image           string
	previousImageID string
	rebuiltImageID  string
	added           bool
}

// watchStateReported marks a reload error whose serving state
// applyWatchedSpec already logged. The watcher must not append the
// previous-assembly line to it.
type watchStateReported struct{ err error }

func (e *watchStateReported) Error() string { return e.err.Error() }

func (e *watchStateReported) Unwrap() error { return e.err }

// watchedRestoreFailure marks a reload whose failed function did not start its
// previous definition again. The new assembly may still be mounted by that
// function's container, so the apply keeps it and reports that a restart is
// required instead of claiming the previous assembly keeps serving.
type watchedRestoreFailure struct{ err error }

func (e *watchedRestoreFailure) Error() string { return e.err.Error() }

func (e *watchedRestoreFailure) Unwrap() error { return e.err }

// applyWatchedSpec provisions the new definitions, restarts the changed
// functions and swaps the route tables and delivery sources.
//
// The apply is staged so a running container never loses the code directory it
// bind-mounts at /var/task: every image is resolved before the first container
// changes, and a failure after a function was replaced rolls the replaced
// functions back to their previous definition (still mounted from the previous
// assembly) before the new assembly directory is removed. A replaced
// container-image function is restored from the image id the plan recorded, not
// from its tag: the rebuild already moved that tag to the new content.
//
//nolint:gocyclo // the documented apply order.
func (r *Runner) applyWatchedSpec(ctx context.Context, next *Spec, targets []string, assemblyDir string) (bool, error) {
	r.reloadMu.Lock()
	locked := true
	defer func() {
		if locked {
			r.reloadMu.Unlock()
		}
	}()
	saved := r.snapshotProvisioning()
	if err := r.provisionResources(ctx, next); err != nil {
		r.restoreProvisioning(saved)
		return false, fmt.Errorf("provision the new assembly: %w", err)
	}
	if err := r.resolveRouteAuthorizers(next); err != nil {
		r.restoreProvisioning(saved)
		return false, err
	}
	if err := r.resolveEnvironment(next, targets); err != nil {
		r.restoreProvisioning(saved)
		return false, err
	}
	arch, err := r.docker.ServerArch(ctx)
	if err != nil {
		r.restoreProvisioning(saved)
		return false, err
	}
	if resolveErr := r.resolveImages(next, arch, targets); resolveErr != nil {
		r.restoreProvisioning(saved)
		return false, resolveErr
	}

	previousInvokers := map[string]*FunctionProcess{}
	for id, process := range r.invokers {
		previousInvokers[id] = process
	}
	targetSet := map[string]bool{}
	for _, id := range targets {
		targetSet[id] = true
	}
	plan, err := r.planWatchedFunctions(ctx, next, targets, previousInvokers)
	if err != nil {
		r.restoreProvisioning(saved)
		return false, err
	}

	applied := make([]appliedWatchedFunction, 0, len(plan))
	for _, item := range plan {
		entry, applyErr := r.startOrReplaceWatchedFunction(ctx, item)
		if applyErr != nil {
			return r.failWatchedApply(ctx, next, targets, assemblyDir, applied, applyErr)
		}
		applied = append(applied, entry)
	}
	// Removed functions stop only after every replacement succeeded, so a
	// mid-batch failure leaves the previous assembly running. A stopped
	// function's code directory stays mounted until its container is removed,
	// and cleanupOldAssemblies keeps every directory a live container mounts.
	for id := range previousInvokers {
		if targetSet[id] {
			continue
		}
		r.logf("watch: function %s was removed; stopping it", id)
		r.stopFunction(ctx, previousInvokers[id])
		delete(r.invokers, id)
	}
	r.refreshTransportSurfaces(next)
	r.specMu.Lock()
	r.spec = next
	r.specMu.Unlock()
	// The surface is swapped. Release the session lock before restarting the
	// delivery engine: a deliverer may be in flight in invokeDelivery, which
	// takes the read side of the same lock.
	r.reloadMu.Unlock()
	locked = false
	if r.delivery != nil {
		if err := r.delivery.Restart(ctx, next); err != nil {
			r.logf("watch: the new assembly is serving; restarting the delivery engine failed: %v", err)
			return true, &watchStateReported{err: fmt.Errorf("restart the delivery engine: %w", err)}
		}
		next.Delivery = r.delivery.State().Sources
	}
	r.cleanupOldAssemblies(assemblyDir)
	r.removeReplacedImages(ctx, applied)
	restarted := 0
	for _, item := range plan {
		if item.previous != nil {
			restarted++
		}
	}
	r.logf("watch: rebuilt; %d function(s) restarted, %d route table(s), %d delivery source(s)",
		restarted, len(next.HTTPAPIs())+len(next.WebSockets), len(next.EventSources)+len(next.Rules)+len(next.Subscriptions))
	return true, nil
}

// startOrReplaceWatchedFunction applies one planned function. An added
// function that fails to start is removed from the invoker set before the
// error is returned, so the rollback never sees a dead process.
func (r *Runner) startOrReplaceWatchedFunction(ctx context.Context, item watchedFunctionApply) (appliedWatchedFunction, error) {
	if item.previous == nil {
		r.logf("watch: function %s was added; starting it", item.function.LogicalID)
		if err := r.startFunction(ctx, item.function, item.image); err != nil {
			// startFunction registers the process before starting the container;
			// the dead entry must not stay in the invoker set.
			if process, ok := r.invokers[item.function.LogicalID]; ok {
				r.stopFunction(ctx, process)
				delete(r.invokers, item.function.LogicalID)
			}
			return appliedWatchedFunction{}, err
		}
		return appliedWatchedFunction{
			process:        r.invokers[item.function.LogicalID],
			rebuiltImageID: item.rebuiltImageID,
			added:          true,
		}, nil
	}
	r.logf("watch: function %s changed (%s); replacing its execution environment", item.function.LogicalID, item.reason)
	previous := item.previous.Function
	previousImage := item.previous.Image
	if err := r.restartFunction(ctx, item.previous, item.function, item.image, item.previousImageID); err != nil {
		return appliedWatchedFunction{}, err
	}
	return appliedWatchedFunction{
		process:         item.previous,
		previous:        previous,
		image:           previousImage,
		previousImageID: item.previousImageID,
		rebuiltImageID:  item.rebuiltImageID,
	}, nil
}

// planWatchedFunctions resolves the image every added or changed function
// needs before anything is stopped or restarted. A failure here leaves every
// running container on the previous assembly.
//
// A changed container-image function is rebuilt under the same logical-id tag,
// so the tag stops naming the content the running container uses. The plan
// records that image's immutable id first; every rollback starts it by id.
func (r *Runner) planWatchedFunctions(ctx context.Context, next *Spec, targets []string, previousInvokers map[string]*FunctionProcess) ([]watchedFunctionApply, error) {
	plan := make([]watchedFunctionApply, 0, len(targets))
	for _, id := range targets {
		function, _ := next.Function(id)
		previous, exists := previousInvokers[id]
		if !exists {
			image, err := r.imageFor(ctx, function)
			if err != nil {
				return nil, err
			}
			rebuiltImageID, err := r.rebuiltImageID(ctx, function, image)
			if err != nil {
				return nil, err
			}
			plan = append(plan, watchedFunctionApply{function: function, image: image, rebuiltImageID: rebuiltImageID})
			continue
		}
		reason := functionReloadReason(previous.Function, function)
		if reason == "" {
			continue
		}
		previousImageID, err := r.rollbackImageID(ctx, previous.Function, previous.Image)
		if err != nil {
			return nil, err
		}
		// A changed image asset must be rebuilt even though the logical id (and
		// therefore the tag) is the same.
		delete(r.builtImages, id)
		image, err := r.imageFor(ctx, function)
		if err != nil {
			return nil, err
		}
		rebuiltImageID, err := r.rebuiltImageID(ctx, function, image)
		if err != nil {
			return nil, err
		}
		plan = append(plan, watchedFunctionApply{
			function:        function,
			previous:        previous,
			image:           image,
			previousImageID: previousImageID,
			rebuiltImageID:  rebuiltImageID,
			reason:          reason,
		})
	}
	return plan, nil
}

// rollbackImageID resolves the immutable id of the image a running function
// uses, before a rebuild moves its tag. A zip function shares the runtime
// image, which a reload never rebuilds, so it keeps the reference it has.
func (r *Runner) rollbackImageID(ctx context.Context, function FunctionSpec, image string) (string, error) {
	if function.ImageAsset == nil {
		return "", nil
	}
	id, err := r.docker.ImageID(ctx, image)
	if err != nil {
		return "", fmt.Errorf("function %s: resolve the image a rollback would restore: %w", function.LogicalID, err)
	}
	return id, nil
}

// rebuiltImageID resolves the immutable id of the image this reload built,
// before a rollback moves the tag back to the previous content. Only that id
// is removed after a successful rollback; the tag never identifies a foreign
// image because the build wrote it in this run.
func (r *Runner) rebuiltImageID(ctx context.Context, function FunctionSpec, image string) (string, error) {
	if function.ImageAsset == nil {
		return "", nil
	}
	id, err := r.docker.ImageID(ctx, image)
	if err != nil {
		return "", fmt.Errorf("function %s: resolve the image this rebuild produced: %w", function.LogicalID, err)
	}
	return id, nil
}

// failWatchedApply restores the previous assembly after a start or restart
// failure. A successful rollback removes the new assembly directory, which no
// running container mounts any more; a failed rollback keeps it, because a
// container may still run from it, and the spec is set to what is serving. A
// container-image function restarts from the immutable image id recorded at
// plan time, and its tag is pointed back at that image; the image this reload
// built is then removed by id, unforced, so a foreign or pinned image that
// shares the id is never touched.
func (r *Runner) failWatchedApply(ctx context.Context, next *Spec, targets []string, assemblyDir string, applied []appliedWatchedFunction, applyErr error) (bool, error) {
	var restoreFailure *watchedRestoreFailure
	restoreFailed := errors.As(applyErr, &restoreFailure)
	if len(applied) == 0 {
		if restoreFailed {
			r.logf("watch: %v; no function was applied and the failed function's previous definition was not restored; a restart is required", applyErr)
			return true, &watchStateReported{err: applyErr}
		}
		_ = os.RemoveAll(assemblyDir) //nolint:errcheck // no container mounts the assembly the apply never used
		r.logf("watch: %v; no function was applied; the previous assembly keeps serving", applyErr)
		return false, &watchStateReported{err: applyErr}
	}
	var rollbackFailures []string
	for index := len(applied) - 1; index >= 0; index-- {
		entry := applied[index]
		if entry.added {
			r.stopFunction(ctx, entry.process)
			delete(r.invokers, entry.process.Function.LogicalID)
			continue
		}
		rollbackImage := entry.image
		if entry.previousImageID != "" {
			rollbackImage = entry.previousImageID
		}
		if err := r.replaceFunctionEnvironment(ctx, entry.process, entry.previous, rollbackImage); err != nil {
			rollbackFailures = append(rollbackFailures, fmt.Sprintf("function %s: %v", entry.previous.LogicalID, err))
			continue
		}
		if entry.rebuiltImageID != "" && r.restoreFunctionImageTag(ctx, entry.previous, entry.previousImageID) {
			// The tag no longer names the rebuild's image. Remove it by the id
			// captured before the tag moved; docker refuses if anything else
			// still references it.
			r.docker.RemoveImageIfUnused(ctx, entry.rebuiltImageID)
		}
	}
	if len(rollbackFailures) == 0 {
		if restoreFailed {
			r.specMu.Lock()
			r.spec = r.servingWatchedSpec(next, targets)
			r.specMu.Unlock()
			r.logf("watch: %v; rolled back %d replaced function(s), but the failed function's previous definition was not restored; a restart is required",
				applyErr, len(applied))
			return true, &watchStateReported{err: applyErr}
		}
		_ = os.RemoveAll(assemblyDir) //nolint:errcheck // every replaced function is mounted from the previous assembly again
		r.logf("watch: %v; rolled back %d replaced function(s); the previous assembly keeps serving", applyErr, len(applied))
		return false, &watchStateReported{err: applyErr}
	}
	r.specMu.Lock()
	r.spec = r.servingWatchedSpec(next, targets)
	r.specMu.Unlock()
	if len(rollbackFailures) == len(applied) {
		r.logf("watch: %v; no replaced function was restored; a restart is required (%s)",
			applyErr, strings.Join(rollbackFailures, "; "))
		return true, &watchStateReported{err: applyErr}
	}
	restored := len(applied) - len(rollbackFailures)
	r.logf("watch: %v; partially applied: %d replaced function(s) restored, %d not; a restart is required (%s)",
		applyErr, restored, len(rollbackFailures), strings.Join(rollbackFailures, "; "))
	return true, &watchStateReported{err: applyErr}
}

// servingWatchedSpec is the spec a failed rollback leaves behind: every target
// function carries the definition its live process runs, and a target with no
// live process is dropped. The rest of the derived assembly stays.
func (r *Runner) servingWatchedSpec(next *Spec, targets []string) *Spec {
	targetSet := map[string]bool{}
	for _, id := range targets {
		targetSet[id] = true
	}
	serving := *next
	serving.Functions = make([]FunctionSpec, 0, len(next.Functions))
	for _, function := range next.Functions {
		if !targetSet[function.LogicalID] {
			serving.Functions = append(serving.Functions, function)
			continue
		}
		if process, ok := r.invokers[function.LogicalID]; ok {
			serving.Functions = append(serving.Functions, process.Function)
		}
	}
	return &serving
}

// stopFunction removes one function's container and closes its Runtime API.
func (r *Runner) stopFunction(ctx context.Context, process *FunctionProcess) {
	if process == nil {
		return
	}
	r.docker.RemoveContainer(ctx, process.Container)
	process.closeRuntimeAPI()
}

// restartFunction replaces one function's execution environment with the new
// definition. It keeps the FunctionProcess (and therefore the logical id every
// transport holds), which is the reset semantics the Lambda lifecycle page
// describes. A failed start restores the previous definition once, from the
// image id the plan recorded when the rebuild moved the tag.
// https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html
func (r *Runner) restartFunction(ctx context.Context, process *FunctionProcess, function FunctionSpec, image, previousImageID string) error {
	previous := process.Function
	previousImage := process.Image
	restoreImage := previousImage
	if previousImageID != "" {
		restoreImage = previousImageID
	}
	if err := r.replaceFunctionEnvironment(ctx, process, function, image); err != nil {
		r.logf("watch: function %s restart failed (%v); restoring the previous definition", function.LogicalID, err)
		rebuiltImageID := ""
		if function.ImageAsset != nil {
			// The tag still names the image this attempt built; capture it
			// before the restore moves the tag.
			rebuiltImageID, _ = r.docker.ImageID(ctx, image) //nolint:errcheck // best-effort cleanup; a missing id leaves the image
		}
		if restoreErr := r.replaceFunctionEnvironment(ctx, process, previous, restoreImage); restoreErr != nil {
			return &watchedRestoreFailure{err: fmt.Errorf(
				"function %s: restart failed (%v) and the previous definition could not start (%v)",
				function.LogicalID, err, restoreErr)}
		}
		if rebuiltImageID != "" && r.restoreFunctionImageTag(ctx, previous, previousImageID) {
			r.docker.RemoveImageIfUnused(ctx, rebuiltImageID)
		}
		return fmt.Errorf("function %s: %w", function.LogicalID, err)
	}
	return nil
}

// restoreFunctionImageTag points a container-image function's tag back at the
// image its rollback container runs. The rebuild moved the tag to the new
// content; without this, the next plan would read the new image as the
// function's previous content and a later rollback would restore it again.
func (r *Runner) restoreFunctionImageTag(ctx context.Context, function FunctionSpec, imageID string) bool {
	if function.ImageAsset == nil || imageID == "" {
		return true
	}
	tag := r.functionImageTag(function)
	if tag == imageID {
		return true
	}
	if err := r.docker.TagImage(ctx, imageID, tag); err != nil {
		r.logf("watch: could not point image tag %s back at %s (%v); the rolled-back container runs that image by id",
			tag, imageID, err)
		return false
	}
	// The rebuild's tag is gone; a later imageFor must build under the tag
	// again rather than trust a cached name that now names the old content.
	delete(r.builtImages, function.LogicalID)
	return true
}

// removeReplacedImages removes the image a replaced container-image function
// ran before the reload, once the new assembly is fully serving. Docker
// refuses to remove an image another tag or a container holds, so an image
// shared with a live function survives.
func (r *Runner) removeReplacedImages(ctx context.Context, applied []appliedWatchedFunction) {
	for _, entry := range applied {
		if entry.previousImageID == "" {
			continue
		}
		r.docker.RemoveImageIfUnused(ctx, entry.previousImageID)
	}
}

func (r *Runner) replaceFunctionEnvironment(ctx context.Context, process *FunctionProcess, function FunctionSpec, image string) error {
	api, options, err := r.functionRunOptions(ctx, function, image)
	if err != nil {
		return err
	}
	r.docker.RemoveContainer(ctx, process.Container)
	process.closeRuntimeAPI()
	process.Function = function
	process.Image = image
	process.rie = r.options.RIEMode
	process.api = api
	process.options = options
	process.Started = time.Now().UTC()
	if api != nil {
		api.running = func(checkCtx context.Context) (bool, error) {
			return r.docker.Running(checkCtx, process.Container)
		}
		process.reset = r.resetFunction
	}
	if _, err := r.docker.StartContainer(ctx, options); err != nil {
		return err
	}
	if err := process.awaitReady(ctx, r.docker); err != nil {
		return err
	}
	r.rememberRuntimeAPIAddress(process)
	return nil
}

// refreshTransportSurfaces swaps the route tables and invoker sets of every
// live listener. The listeners, ports and URLs do not change.
func (r *Runner) refreshTransportSurfaces(spec *Spec) {
	invokers := r.invokerSnapshot()
	for _, api := range spec.HTTPAPIs() {
		if transport, ok := r.transports[api.LogicalID]; ok {
			transport.SetSurface(api, invokers)
		}
	}
	for _, url := range spec.FunctionURLs {
		if transport, ok := r.transports[url.LogicalID]; ok {
			transport.SetSurface(functionURLAPI(url), invokers)
		}
	}
	for _, api := range spec.WebSockets {
		if server, ok := r.webSocketServers[api.LogicalID]; ok {
			server.SetSurface(api, invokers)
		}
	}
}

func (r *Runner) invokerSnapshot() map[string]Invoker {
	out := make(map[string]Invoker, len(r.invokers))
	for id, process := range r.invokers {
		out[id] = process
	}
	return out
}

// functionURLAPI is the transport surface one Function URL serves.
func functionURLAPI(url FunctionURLSpec) APISpec {
	return APISpec{
		Class:     APIFunctionURL,
		LogicalID: url.LogicalID,
		Stack:     url.Stack,
		Name:      url.LogicalID,
		Routes: []Route{{
			Class:     APIFunctionURL,
			Method:    "ANY",
			Path:      catchAllPath,
			Function:  url.Function,
			Streaming: url.Streaming,
		}},
	}
}

// functionReloadReason names the execution inputs that differ between two
// definitions. It returns "" when the running environment is still correct.
func functionReloadReason(previous, next FunctionSpec) string {
	var reasons []string
	if previous.Runtime != next.Runtime {
		reasons = append(reasons, "runtime")
	}
	if previous.Handler != next.Handler {
		reasons = append(reasons, "handler")
	}
	if previous.Architecture != next.Architecture {
		reasons = append(reasons, "architecture")
	}
	if previous.MemoryMB != next.MemoryMB || previous.Timeout != next.Timeout {
		reasons = append(reasons, "limits")
	}
	if !reflect.DeepEqual(previous.Environment, next.Environment) {
		reasons = append(reasons, "environment")
	}
	if functionAssetFingerprint(previous) != functionAssetFingerprint(next) {
		reasons = append(reasons, "code")
	}
	if layerFingerprint(previous) != layerFingerprint(next) {
		reasons = append(reasons, "layers")
	}
	if imageAssetFingerprint(previous) != imageAssetFingerprint(next) {
		reasons = append(reasons, "image")
	}
	return strings.Join(reasons, ", ")
}

// functionAssetFingerprint identifies a zip function's code. CDK names the
// asset directory with the content hash (aws:asset:path), and a changed source
// changes that hash; inline code is hashed directly.
// https://docs.aws.amazon.com/cdk/v2/guide/assets.html
func functionAssetFingerprint(function FunctionSpec) string {
	if function.InlineCode != "" {
		sum := sha256.Sum256([]byte(function.InlineCode))
		return "inline-" + hex.EncodeToString(sum[:])
	}
	if function.AssetDir == "" {
		return ""
	}
	return filepath.Base(function.AssetDir)
}

func layerFingerprint(function FunctionSpec) string {
	parts := make([]string, 0, len(function.Layers))
	for _, layer := range function.Layers {
		parts = append(parts, layer.LogicalID+"="+filepath.Base(layer.AssetDir))
	}
	return strings.Join(parts, "|")
}

func imageAssetFingerprint(function FunctionSpec) string {
	asset := function.ImageAsset
	if asset == nil {
		return ""
	}
	encoded, err := json.Marshal(struct {
		Hash       string
		Directory  string
		DockerFile string
		BuildArgs  map[string]string
		Target     string
		Platform   string
	}{asset.Hash, filepath.Base(asset.Directory), asset.DockerFile, asset.BuildArgs, asset.Target, asset.Platform})
	if err != nil {
		return asset.Hash
	}
	return string(encoded)
}

// cleanupOldAssemblies removes the watch assemblies no running container
// mounts. A function the reload did not replace keeps its previous code
// directory, so the assembly its /var/task is bound from stays until that
// function is replaced; removing it would empty the container's /var/task.
func (r *Runner) cleanupOldAssemblies(current string) {
	watchRoot := filepath.Join(r.scratch, "watch")
	entries, err := os.ReadDir(watchRoot)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(watchRoot, entry.Name())
		if path == current || r.watchAssemblyMounted(path) {
			continue
		}
		_ = os.RemoveAll(path) //nolint:errcheck // nothing mounts the assembly any more
	}
}

// watchAssemblyMounted reports whether a live function's code or layer
// directory lives under one assembly directory.
func (r *Runner) watchAssemblyMounted(assemblyDir string) bool {
	prefix := assemblyDir + string(filepath.Separator)
	for _, process := range r.invokers {
		if strings.HasPrefix(process.Function.AssetDir, prefix) || strings.HasPrefix(process.Function.OptDir, prefix) {
			return true
		}
	}
	return false
}

type provisioningSnapshot struct {
	values       resourceValues
	tables       map[string]tableInfo
	secretValues map[string]string
	localSecrets map[string]string
	ttlTables    map[string]ttlTable
}

func (r *Runner) snapshotProvisioning() provisioningSnapshot {
	return provisioningSnapshot{
		values:       r.resourceValues,
		tables:       r.tables,
		secretValues: r.secretValues,
		localSecrets: r.localSecrets,
		ttlTables:    r.ttlTables,
	}
}

func (r *Runner) restoreProvisioning(snapshot provisioningSnapshot) {
	r.resourceValues = snapshot.values
	r.tables = snapshot.tables
	r.secretValues = snapshot.secretValues
	r.localSecrets = snapshot.localSecrets
	r.ttlTables = snapshot.ttlTables
}
