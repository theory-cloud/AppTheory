package localrunner

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	defaultMaxConcurrent = maxConcurrency
	// cleanupTimeout bounds the run-wide container listing. Each removal has its
	// own cleanupStepTimeout so one slow Docker call cannot starve the rest.
	cleanupTimeout      = 10 * time.Second
	cleanupStepTimeout  = 5 * time.Second
	labelRun            = "apptheory.local.run"
	labelApp            = "apptheory.local.app"
	labelManaged        = "apptheory.local.managed"
	backendDynamoDB     = "dynamodb"
	backendDynamoDBName = "dynamodb-local"
)

// Options configure one local run.
type Options struct {
	// AppDir is the CDK app directory (the one containing cdk.json).
	AppDir string
	// Context is passed to `cdk synth` as -c key=value.
	Context map[string]string
	// AssemblyDir skips synthesis and reads an existing cloud assembly.
	AssemblyDir string
	// ScratchDir holds synthesis output and materialized inline code. It must
	// live under $HOME or the checkout so Docker can bind-mount it.
	ScratchDir string
	// ProfilePath points at the checked-in local execution profile.
	ProfilePath string
	// Images overrides a profile pin per image class (go, node, python).
	Images map[string]string
	// Endpoints are the local AWS emulators every function container sees.
	Endpoints []Endpoint
	// AddHosts are extra --add-host entries for function containers.
	AddHosts []string
	// Backends are local emulators the runner starts on the run network from
	// the profile (currently: dynamodb). Their endpoints and /etc/hosts entries
	// are added automatically.
	Backends []string
	// PortBase pins the API listener ports; zero asks the OS for free ports.
	PortBase int
	// NamePrefix names containers and the network. It must be unique per run.
	NamePrefix string
	// MaxConcurrency bounds in-flight invocations; never above 32.
	MaxConcurrency int
	// Stdout receives the runner's progress log.
	Stdout io.Writer
	// SynthTimeout bounds `cdk synth`.
	SynthTimeout time.Duration
}

// Runner owns one local run: the derived surface, the Docker network, the
// function containers and the HTTP listeners.
type Runner struct {
	options    Options
	profile    *Profile
	docker     *Docker
	spec       *Spec
	runID      string
	appHash    string
	namePrefix string
	scratch    string
	images     map[string]string
	endpoints  []Endpoint
	invokers   map[string]*FunctionProcess
	backends   map[string]backendProcess
	servers    []*http.Server
	listeners  []net.Listener
	semaphore  chan struct{}
	network    string
}

// NewRunner validates the options and prepares the run. It contacts no Docker
// and synthesizes nothing yet.
func NewRunner(options Options) (*Runner, error) {
	options, err := normalizeOptions(options)
	if err != nil {
		return nil, err
	}

	runner := &Runner{
		options:   options,
		docker:    NewDocker(),
		appHash:   hashOf(options.AppDir),
		runID:     shortID(),
		invokers:  map[string]*FunctionProcess{},
		backends:  map[string]backendProcess{},
		endpoints: append([]Endpoint(nil), options.Endpoints...),
		images:    map[string]string{},
		semaphore: make(chan struct{}, options.MaxConcurrency),
	}
	runner.namePrefix = sanitizeNamePrefix(options.NamePrefix, "apptheory-local-"+runner.appHash)
	runner.network = runner.namePrefix + "-net"
	runner.scratch = filepath.Join(options.ScratchDir, "runs", runner.appHash+"-"+runner.runID)
	if err := ensureSharedPath(runner.scratch); err != nil {
		return nil, err
	}
	if err := runner.loadProfile(); err != nil {
		return nil, err
	}
	if err := runner.validateEndpoints(); err != nil {
		return nil, err
	}
	if err := runner.validateBackends(); err != nil {
		return nil, err
	}
	return runner, nil
}

// normalizeOptions applies defaults and rejects unusable combinations before
// any synthesis or container work.
func normalizeOptions(options Options) (Options, error) {
	options.Stdout = outputOrDefault(options.Stdout)
	if strings.TrimSpace(options.AppDir) == "" {
		return Options{}, errors.New("a CDK app directory is required (--app)")
	}
	appDir, err := filepath.Abs(options.AppDir)
	if err != nil {
		return Options{}, fmt.Errorf("resolve app directory %q: %w", options.AppDir, err)
	}
	options.AppDir = appDir
	if info, statErr := os.Stat(appDir); statErr != nil || !info.IsDir() {
		return Options{}, fmt.Errorf("app directory %s is not a directory", appDir)
	}
	if options.ScratchDir == "" {
		cache, cacheErr := os.UserCacheDir()
		if cacheErr != nil {
			return Options{}, fmt.Errorf("resolve the user cache directory for the run scratch space: %w", cacheErr)
		}
		options.ScratchDir = filepath.Join(cache, "apptheory-local")
	}
	if options.MaxConcurrency == 0 {
		options.MaxConcurrency = defaultMaxConcurrent
	}
	if options.MaxConcurrency < 1 || options.MaxConcurrency > maxConcurrency {
		return Options{}, fmt.Errorf(
			"--max-concurrency must be between 1 and %d (got %d): local invocations above that bound are unreliable",
			maxConcurrency,
			options.MaxConcurrency,
		)
	}
	if options.PortBase < 0 {
		return Options{}, fmt.Errorf("--port-base must not be negative")
	}
	if options.SynthTimeout <= 0 {
		options.SynthTimeout = 30 * time.Minute
	}
	return options, nil
}

func (r *Runner) loadProfile() error {
	if r.options.ProfilePath != "" {
		profile, err := LoadProfile(r.options.ProfilePath)
		if err != nil {
			return err
		}
		r.profile = profile
	}
	for class, image := range r.options.Images {
		if err := validateImageOverride(class, image); err != nil {
			return err
		}
		r.images[class] = image
	}
	return nil
}

func validateImageOverride(class, image string) error {
	if class != imageClassGo && class != imageClassNode && class != imageClassPython {
		return fmt.Errorf("unknown image class %q (want go, node or python)", class)
	}
	_, digest, ok := strings.Cut(image, "@")
	if !ok || !digestPattern.MatchString(digest) {
		return fmt.Errorf("image %q for the %s runtime is not pinned by digest", image, class)
	}
	if prefix := imageTagPrefixes[class]; !strings.HasPrefix(image, prefix) {
		return fmt.Errorf("image %q is not an official %s image (%s)", image, class, prefix)
	}
	return nil
}

func (r *Runner) validateBackends() error {
	for _, backend := range r.options.Backends {
		if backend != backendDynamoDB {
			return fmt.Errorf("unknown backend %q (want %s)", backend, backendDynamoDB)
		}
		if _, exists := r.backendEndpoint(backend); !exists {
			r.endpoints = append(r.endpoints, Endpoint{
				Service: backend,
				URL:     "http://" + backendDynamoDBName + ":8000",
			})
		}
	}
	sort.Slice(r.endpoints, func(i, j int) bool { return r.endpoints[i].Service < r.endpoints[j].Service })
	return nil
}

func (r *Runner) backendEndpoint(service string) (Endpoint, bool) {
	for _, endpoint := range r.endpoints {
		if endpoint.Service == service {
			return endpoint, true
		}
	}
	return Endpoint{}, false
}

func (r *Runner) validateEndpoints() error {
	seen := map[string]struct{}{}
	for _, endpoint := range r.endpoints {
		if err := ValidateEndpoint(endpoint); err != nil {
			return err
		}
		if _, exists := seen[endpoint.Service]; exists {
			return fmt.Errorf("endpoint for service %q is configured twice", endpoint.Service)
		}
		seen[endpoint.Service] = struct{}{}
	}
	sort.Slice(r.endpoints, func(i, j int) bool { return r.endpoints[i].Service < r.endpoints[j].Service })
	return nil
}

// Scratch returns the run's scratch directory.
func (r *Runner) Scratch() string {
	return r.scratch
}

// CleanScratch removes the run's scratch directory. It is safe to call more than
// once and never touches containers or the network.
func (r *Runner) CleanScratch() {
	_ = os.RemoveAll(r.scratch) //nolint:errcheck // scratch cleanup is best effort
}

// Plan synthesizes the app (unless an assembly was supplied) and derives the
// surface. It starts no containers.
func (r *Runner) Plan(ctx context.Context) (*Spec, error) {
	if r.spec != nil {
		return r.spec, nil
	}
	assemblyDir := r.options.AssemblyDir
	if assemblyDir == "" {
		if mkErr := os.MkdirAll(r.scratch, 0o750); mkErr != nil {
			return nil, fmt.Errorf("create run scratch directory %s: %w", r.scratch, mkErr)
		}
		assemblyDir = filepath.Join(r.scratch, "cdk.out")
		synthCtx, cancel := context.WithTimeout(ctx, r.options.SynthTimeout)
		defer cancel()
		if err := Synth(synthCtx, SynthOptions{
			AppDir:    r.options.AppDir,
			OutputDir: assemblyDir,
			Context:   r.options.Context,
			Stderr:    r.options.Stdout,
		}); err != nil {
			return nil, err
		}
	}
	stacks, err := loadAssembly(assemblyDir)
	if err != nil {
		return nil, err
	}
	spec, err := deriveSpec(assemblyDir, stacks)
	if err != nil {
		return nil, err
	}
	r.spec = spec
	return spec, nil
}

// Run plans the app, starts the run's network, proves it cannot reach AWS,
// starts every served function container and serves the derived HTTP surface
// until the context is canceled.
func (r *Runner) Run(ctx context.Context) error {
	cleanup := r.cleanupFunc()
	defer cleanup()

	spec, err := r.Plan(ctx)
	if err != nil {
		return err
	}
	if err = r.docker.Available(ctx); err != nil {
		return err
	}
	arch, err := r.docker.ServerArch(ctx)
	if err != nil {
		return err
	}
	if err = r.resolveImages(spec, arch); err != nil {
		return err
	}
	if err = r.prepareScratch(spec); err != nil {
		return err
	}

	if err = r.docker.CreateNetwork(ctx, r.network, r.labels()); err != nil {
		return err
	}
	r.logf("network %s", r.network)
	if err = r.startBackends(ctx); err != nil {
		return err
	}
	preflight, err := r.Preflight(ctx, r.network, r.options.AddHosts)
	if err != nil {
		return err
	}
	for _, check := range sortedKeys(preflight.Checks) {
		r.logf("preflight %s: %s", check, preflight.Checks[check])
	}
	if err := r.startFunctions(ctx, spec); err != nil {
		return err
	}
	if err := r.startServers(ctx, spec); err != nil {
		return err
	}
	r.logf("local-run: ready")
	return r.serve(ctx)
}

// backendProcess is a local emulator container the run owns.
type backendProcess struct {
	Container string
	Endpoint  Endpoint
}

// startBackends starts the local emulators configured from the profile and
// resolves their network addresses for the function containers' closed DNS.
func (r *Runner) startBackends(ctx context.Context) error {
	for _, backend := range r.options.Backends {
		image, err := r.profile.DynamoDBImage()
		if err != nil {
			return fmt.Errorf("backend %s: %w", backend, err)
		}
		name := r.backendsContainerName(backend)
		// Register the container before starting it, so a signal that lands
		// while the start or the address lookup is in flight still cleans it up.
		r.backends[backend] = backendProcess{
			Container: name,
			Endpoint:  Endpoint{Service: backend, URL: "http://" + backendDynamoDBName + ":8000"},
		}
		options := ContainerOptions{
			Name:    name,
			Network: r.network,
			Image:   image,
			Command: []string{"-jar", "DynamoDBLocal.jar", "-sharedDb", "-inMemory"},
			Labels:  r.labels(),
			Detach:  true,
		}
		if _, startErr := r.docker.StartContainer(ctx, options); startErr != nil {
			return startErr
		}
		address, err := r.docker.ContainerIP(ctx, name, r.network)
		if err != nil {
			return err
		}
		r.options.AddHosts = append(r.options.AddHosts, backendDynamoDBName+":"+address)
		r.logf("backend %s (%s) ready at %s", backend, image, r.backends[backend].Endpoint.URL)
	}
	return nil
}

func (r *Runner) backendsContainerName(backend string) string {
	return r.namePrefix + "-" + backend
}

// cleanupFunc removes everything the run created. It stops accepting requests
// first, then force-removes the containers (which also aborts an in-flight RIE
// invocation), then closes any transport connections that are still open. The
// order matters: waiting for a graceful HTTP shutdown before touching Docker
// can consume the whole cleanup budget and leave containers and the network
// behind when a handler is still running.
func (r *Runner) cleanupFunc() func() {
	return func() {
		for _, listener := range r.listeners {
			_ = listener.Close() //nolint:errcheck // shutting down the run's own listeners
		}
		r.removeRunContainers()
		for _, server := range r.servers {
			_ = server.Close() //nolint:errcheck // abort connections whose containers are gone
		}
		networkCtx, cancel := context.WithTimeout(context.Background(), cleanupStepTimeout)
		r.docker.RemoveNetwork(networkCtx, r.network)
		cancel()
		_ = os.RemoveAll(r.scratch) //nolint:errcheck // scratch cleanup is best effort
	}
}

// removeRunContainers removes every container the run created. It lists by the
// run label instead of trusting the tracked map, because a `docker run` that
// was interrupted by the signal can create the container before the runner has
// finished registering it. A second listing catches a container the daemon
// created while the first sweep was running. Tracked names are attempted too,
// so a failed listing cannot leak a known container.
func (r *Runner) removeRunContainers() {
	deadline := time.Now().Add(cleanupTimeout)
	removed := map[string]struct{}{}
	for pass := 0; pass < 2; pass++ {
		pending := map[string]struct{}{}
		listCtx, cancel := cleanupOperationContext(deadline)
		names, err := r.docker.ListContainers(listCtx, labelRun+"="+r.runID)
		cancel()
		if err == nil {
			for _, name := range names {
				pending[name] = struct{}{}
			}
		}
		for _, process := range r.invokers {
			pending[process.Container] = struct{}{}
		}
		for _, backend := range r.backends {
			pending[backend.Container] = struct{}{}
		}
		var wait sync.WaitGroup
		for name := range pending {
			if _, alreadyRemoved := removed[name]; alreadyRemoved {
				continue
			}
			removed[name] = struct{}{}
			wait.Add(1)
			go func(name string) {
				defer wait.Done()
				removeCtx, removeCancel := cleanupOperationContext(deadline)
				defer removeCancel()
				r.docker.RemoveContainer(removeCtx, name)
			}(name)
		}
		wait.Wait()
	}
	r.invokers = map[string]*FunctionProcess{}
	r.backends = map[string]backendProcess{}
}

// cleanupOperationContext returns a context bounded by both the remaining
// run-wide budget and one step, so a single slow Docker call cannot consume the
// budget needed to remove the rest.
func cleanupOperationContext(deadline time.Time) (context.Context, context.CancelFunc) {
	remaining := time.Until(deadline)
	if remaining <= 0 {
		remaining = time.Millisecond
	}
	if remaining > cleanupStepTimeout {
		remaining = cleanupStepTimeout
	}
	return context.WithTimeout(context.Background(), remaining)
}

// resolveImages pins every served function's runtime image and checks the
// architecture the handler was built for.
func (r *Runner) resolveImages(spec *Spec, hostArch string) error {
	for _, id := range spec.ServedFunctions() {
		function, ok := spec.Function(id)
		if !ok {
			return fmt.Errorf("assembly references function %q but defines no such resource", id)
		}
		class, err := RuntimeClass(function.Runtime)
		if err != nil {
			return err
		}
		if _, ok := r.images[class]; !ok {
			image, err := r.profile.ImageFor(function.Runtime)
			if err != nil {
				return fmt.Errorf("function %s (%s): %w", function.LogicalID, function.Runtime, err)
			}
			r.images[class] = image
		}
		if _, err := handlerArgument(function); err != nil {
			return err
		}
		if class == imageClassGo && function.Architecture != "" && !archMatches(hostArch, function.Architecture) {
			return fmt.Errorf(
				"function %s was built for %s but this Docker host is %s; a provided-runtime bootstrap cannot run cross-architecture",
				function.LogicalID,
				function.Architecture,
				hostArch,
			)
		}
	}
	return nil
}

func archMatches(host, declared string) bool {
	normalize := func(value string) string {
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "x86_64", archAMD64:
			return archAMD64
		case archARM64, "aarch64":
			return archARM64
		default:
			return strings.ToLower(strings.TrimSpace(value))
		}
	}
	return normalize(host) == normalize(declared)
}

// prepareScratch materializes inline function code under the run scratch
// directory, which lives under $HOME so Docker can bind-mount it.
func (r *Runner) prepareScratch(spec *Spec) error {
	if err := os.MkdirAll(r.scratch, 0o750); err != nil {
		return fmt.Errorf("create run scratch directory %s: %w", r.scratch, err)
	}
	for _, function := range spec.Functions {
		if function.InlineCode == "" {
			continue
		}
		dir := filepath.Join(r.scratch, "inline", sanitizeName(function.LogicalID))
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return fmt.Errorf("materialize inline code for %s: %w", function.LogicalID, err)
		}
		path := filepath.Join(dir, function.InlineFile)
		if err := os.WriteFile(path, []byte(function.InlineCode), 0o600); err != nil {
			return fmt.Errorf("write inline code %s: %w", path, err)
		}
	}
	for index := range spec.Functions {
		if spec.Functions[index].InlineCode == "" {
			continue
		}
		spec.Functions[index].AssetDir = filepath.Join(r.scratch, "inline", sanitizeName(spec.Functions[index].LogicalID))
	}
	return nil
}

func (r *Runner) startFunctions(ctx context.Context, spec *Spec) error {
	for _, id := range spec.ServedFunctions() {
		function, _ := spec.Function(id)
		image, err := r.imageFor(function)
		if err != nil {
			return err
		}
		if err := r.startFunction(ctx, function, image); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runner) imageFor(function FunctionSpec) (string, error) {
	class, err := RuntimeClass(function.Runtime)
	if err != nil {
		return "", err
	}
	image, ok := r.images[class]
	if !ok {
		return "", fmt.Errorf("function %s has no resolved image for class %s", function.LogicalID, class)
	}
	return image, nil
}

func (r *Runner) startFunction(ctx context.Context, function FunctionSpec, image string) error {
	codeDir := function.AssetDir
	if codeDir == "" {
		return fmt.Errorf("function %s has no code directory", function.LogicalID)
	}
	if err := ensureSharedPath(codeDir); err != nil {
		return fmt.Errorf("function %s: %w", function.LogicalID, err)
	}
	handler, err := handlerArgument(function)
	if err != nil {
		return err
	}
	env, overridden := r.functionEnvironment(function)
	if len(overridden) > 0 {
		r.logf("function %s: runner-owned environment overrides template values for %s", function.LogicalID, strings.Join(overridden, ", "))
	}
	if len(function.UnresolvedEnvironment) > 0 {
		return unsupported(
			function.LogicalID,
			"environment variables %s are CloudFormation expressions; the local runner only injects literal values",
			strings.Join(function.UnresolvedEnvironment, ", "),
		)
	}
	if limitErr := unresolvedLimitsError(function); limitErr != nil {
		return limitErr
	}
	name := r.containerName(function.LogicalID)
	options := ContainerOptions{
		Name:     name,
		Network:  r.network,
		Image:    image,
		Command:  []string{handler},
		Env:      env,
		AddHosts: r.options.AddHosts,
		MemoryMB: function.MemoryMB,
		Mounts:   []string{codeDir + ":/var/task:ro"},
		Publish:  riePort,
		Labels:   r.labels(),
		Detach:   true,
	}
	// Register the container before starting it, so a signal that lands while
	// the runtime image is still starting or waiting to accept connections
	// still removes it.
	process := &FunctionProcess{
		Function:  function,
		Container: name,
		Image:     image,
	}
	r.invokers[function.LogicalID] = process
	if _, startErr := r.docker.StartContainer(ctx, options); startErr != nil {
		return startErr
	}
	port, err := waitForContainerReady(ctx, r.docker, name)
	if err != nil {
		return err
	}
	process.Port = port
	r.logf("function %s (%s, %s) ready on 127.0.0.1:%d", function.LogicalID, function.Runtime, image, port)
	return nil
}

func (r *Runner) startServers(ctx context.Context, spec *Spec) error {
	targets := append([]APISpec(nil), spec.HTTPAPIs()...)
	for _, url := range spec.FunctionURLs {
		targets = append(targets, APISpec{
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
		})
	}
	invokers := make(map[string]Invoker, len(r.invokers))
	for id, process := range r.invokers {
		invokers[id] = process
	}
	for index, target := range targets {
		listener, err := r.listen(ctx, index)
		if err != nil {
			return fmt.Errorf("bind %s listener: %w", target.LogicalID, err)
		}
		transport := NewTransport(target, invokers, r.semaphore, r.logf)
		server := &http.Server{
			Handler:           transport,
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       60 * time.Second,
		}
		r.listeners = append(r.listeners, listener)
		r.servers = append(r.servers, server)
		go func() {
			if serveErr := server.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
				r.logf("listener for %s stopped: %v", target.LogicalID, serveErr)
			}
		}()
		r.logf("serving %s %s at http://%s", target.Class, target.LogicalID, listener.Addr().String())
	}
	return nil
}

func (r *Runner) listen(ctx context.Context, index int) (net.Listener, error) {
	var listenConfig net.ListenConfig
	if r.options.PortBase > 0 {
		return listenConfig.Listen(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", r.options.PortBase+index))
	}
	return listenConfig.Listen(ctx, "tcp", "127.0.0.1:0")
}

func (r *Runner) serve(ctx context.Context) error {
	<-ctx.Done()
	r.logf("shutting down: removing %d container(s) and network %s", len(r.invokers), r.network)
	return nil
}

// Down removes containers and networks a previous run of this app left behind.
func (r *Runner) Down(ctx context.Context) (int, error) {
	if err := r.docker.Available(ctx); err != nil {
		return 0, err
	}
	containers, err := r.docker.ListContainers(ctx, labelApp+"="+r.appHash)
	if err != nil {
		return 0, err
	}
	for _, container := range containers {
		r.docker.RemoveContainer(ctx, container)
	}
	networks, err := r.docker.ListNetworks(ctx, labelApp+"="+r.appHash)
	if err != nil {
		return 0, err
	}
	for _, network := range networks {
		r.docker.RemoveNetwork(ctx, network)
	}
	return len(containers) + len(networks), nil
}

// PlanJSON renders the derived surface for machines (the examples harness and
// future tooling).
func (r *Runner) PlanJSON(spec *Spec) ([]byte, error) {
	return json.MarshalIndent(spec, "", "  ")
}

func (r *Runner) labels() map[string]string {
	return map[string]string{
		labelRun:     r.runID,
		labelApp:     r.appHash,
		labelManaged: "true",
	}
}

func (r *Runner) containerName(logicalID string) string {
	return r.namePrefix + "-" + sanitizeName(logicalID)
}

func (r *Runner) logf(format string, args ...any) {
	_, _ = fmt.Fprintf(r.options.Stdout, format+"\n", args...) //nolint:errcheck // progress logging
}

func outputOrDefault(writer io.Writer) io.Writer {
	if writer == nil {
		return os.Stdout
	}
	return writer
}

func hashOf(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:8]
}

func shortID() string {
	var raw [4]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return hashOf(time.Now().UTC().Format(time.RFC3339Nano))[:8]
	}
	return hex.EncodeToString(raw[:])
}

// sanitizeName makes a logical id usable in a Docker container name.
func sanitizeName(value string) string {
	var builder strings.Builder
	for _, char := range strings.ToLower(value) {
		switch {
		case char >= 'a' && char <= 'z', char >= '0' && char <= '9', char == '-', char == '_', char == '.':
			builder.WriteRune(char)
		default:
			builder.WriteByte('-')
		}
	}
	name := strings.Trim(builder.String(), "-_.")
	if name == "" {
		return "function"
	}
	if len(name) > 40 {
		return name[:31] + "-" + hashOf(name)
	}
	return name
}

func sanitizeNamePrefix(value, fallback string) string {
	prefix := sanitizeName(value)
	if strings.TrimSpace(value) == "" {
		prefix = sanitizeName(fallback)
	}
	return prefix
}

// ensureSharedPath fails when a path Docker must bind-mount is outside the
// directories the Docker VM shares: $HOME and the working directory (the
// checkout).
func ensureSharedPath(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve path %q: %w", path, err)
	}
	home, homeErr := os.UserHomeDir()
	if homeErr != nil {
		home = ""
	}
	cwd, cwdErr := os.Getwd()
	if cwdErr != nil {
		cwd = ""
	}
	for _, root := range []string{home, cwd} {
		if root == "" {
			continue
		}
		rel, err := filepath.Rel(root, absolute)
		if err != nil {
			continue
		}
		if rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil
		}
	}
	return fmt.Errorf(
		"%s is not under $HOME or the working directory; Docker (colima) does not share it",
		absolute,
	)
}
