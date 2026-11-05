package localrunner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
//     execution-environment reset uses; its logical id, Runtime API behaviour
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
				r.logf("watch: %v; the previous assembly keeps serving", err)
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
	if err := Synth(synthCtx, SynthOptions{
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
	if err := r.applyOriginOverrides(spec); err != nil {
		return err
	}
	if err := r.materializeKeyValueStores(spec); err != nil {
		return err
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

// applyWatchedSpec provisions the new definitions, restarts the changed
// functions and swaps the route tables and delivery sources.
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
	if err := r.resolveImages(next, arch, targets); err != nil {
		r.restoreProvisioning(saved)
		return false, err
	}

	previousInvokers := map[string]*FunctionProcess{}
	for id, process := range r.invokers {
		previousInvokers[id] = process
	}
	targetSet := map[string]bool{}
	for _, id := range targets {
		targetSet[id] = true
	}
	// Removed functions stop first, so their names and ports are free.
	for id := range previousInvokers {
		if targetSet[id] {
			continue
		}
		r.logf("watch: function %s was removed; stopping it", id)
		r.stopFunction(ctx, previousInvokers[id])
		delete(r.invokers, id)
	}
	changed := 0
	for _, id := range targets {
		function, _ := next.Function(id)
		previous, exists := previousInvokers[id]
		if !exists {
			r.logf("watch: function %s was added; starting it", id)
			image, imageErr := r.imageFor(ctx, function)
			if imageErr != nil {
				return false, imageErr
			}
			if startErr := r.startFunction(ctx, function, image); startErr != nil {
				return false, startErr
			}
			continue
		}
		reason := functionReloadReason(previous.Function, function)
		if reason == "" {
			continue
		}
		changed++
		r.logf("watch: function %s changed (%s); replacing its execution environment", id, reason)
		// A changed image asset must be rebuilt even though the logical id (and
		// therefore the tag) is the same.
		delete(r.builtImages, id)
		image, imageErr := r.imageFor(ctx, function)
		if imageErr != nil {
			return false, imageErr
		}
		if restartErr := r.restartFunction(ctx, previous, function, image); restartErr != nil {
			return false, restartErr
		}
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
			return true, err
		}
		next.Delivery = r.delivery.State().Sources
	}
	r.cleanupOldAssemblies(assemblyDir)
	r.logf("watch: rebuilt; %d function(s) restarted, %d route table(s), %d delivery source(s)",
		changed, len(next.HTTPAPIs())+len(next.WebSockets), len(next.EventSources)+len(next.Rules)+len(next.Subscriptions))
	return true, nil
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
// describes. A failed start restores the previous definition once.
// https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html
func (r *Runner) restartFunction(ctx context.Context, process *FunctionProcess, function FunctionSpec, image string) error {
	previous := process.Function
	previousImage := process.Image
	if err := r.replaceFunctionEnvironment(ctx, process, function, image); err != nil {
		r.logf("watch: function %s restart failed (%v); restoring the previous definition", function.LogicalID, err)
		if restoreErr := r.replaceFunctionEnvironment(ctx, process, previous, previousImage); restoreErr != nil {
			return fmt.Errorf("function %s: restart failed (%v) and the previous definition could not start (%v)",
				function.LogicalID, err, restoreErr)
		}
		return fmt.Errorf("function %s: %w", function.LogicalID, err)
	}
	return nil
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
		if path == current {
			continue
		}
		_ = os.RemoveAll(path) //nolint:errcheck // the previous asset directories are no longer served
	}
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
