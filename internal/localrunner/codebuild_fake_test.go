package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeDockerTransport lets the CodeBuild tests exercise the real build path
// without a Docker daemon. It models only the commands the service issues.
type fakeDockerTransport struct {
	mu       sync.Mutex
	output   string
	runErr   error
	arch     string
	commands []string
}

func (f *fakeDockerTransport) exec(_ context.Context, argv []string) (string, string, error) {
	f.mu.Lock()
	f.commands = append(f.commands, strings.Join(argv, " "))
	f.mu.Unlock()
	if len(argv) < 2 {
		return "", "", nil
	}
	switch argv[1] {
	case "version":
		arch := f.arch
		if arch == "" {
			arch = "arm64"
		}
		return arch + "\n", "", nil
	case "image":
		return "sha256:image-id", "", nil
	case "run":
		return f.output, "", f.runErr
	case "inspect":
		return "true", "", nil
	case "ps":
		return "", "", nil
	case "rm", "network", "volume":
		return "", "", nil
	default:
		return "", "", nil
	}
}

func testCodeBuildProfile() *Profile {
	profile := &Profile{path: "test-profile.json"}
	profile.CodeBuild.Agent = map[string]CodeBuildImagePin{
		"aarch64": {Tag: "public.ecr.aws/codebuild/local-builds:aarch64", Digest: "sha256:" + strings.Repeat("a", 64)},
	}
	profile.CodeBuild.Images = map[string]map[string]CodeBuildImagePin{
		"aws/codebuild/standard:7.0": {
			"aarch64": {Tag: "public.ecr.aws/codebuild/amazonlinux-aarch64-lambda-standard:nodejs24", Digest: "sha256:" + strings.Repeat("b", 64)},
		},
	}
	return profile
}

func testCodeBuildService(t *testing.T, output string, runErr error) (*codeBuildService, *fakeDockerTransport) {
	t.Helper()
	home := testSharedDir(t)
	scratch := filepath.Join(home, "scratch")
	if err := os.MkdirAll(scratch, 0o750); err != nil {
		t.Fatal(err)
	}
	transport := &fakeDockerTransport{output: output, runErr: runErr}
	runner := &Runner{
		options:   Options{Stdout: io.Discard},
		scratch:   scratch,
		docker:    &Docker{exec: transport.exec},
		eventBus:  newEventBridgeBus(RealClock{}),
		clock:     RealClock{},
		profile:   testCodeBuildProfile(),
		backends:  map[string]backendProcess{},
		listeners: nil,
	}
	spec := &Spec{CodeBuildProjects: []CodeBuildProjectSpec{{
		LogicalID:      "Project",
		Name:           "local-project",
		Image:          "aws/codebuild/standard:7.0",
		BuildSpec:      `{"version":"0.2","phases":{"build":{"commands":["echo batch step placeholder"]}}}`,
		TimeoutMinutes: 5,
	}}}
	service, err := newCodeBuildService(runner, spec, "aarch64")
	if err != nil {
		t.Fatal(err)
	}
	return service, transport
}

func codeBuildCall(t *testing.T, server *httptest.Server, operation string, payload any) (int, map[string]any) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPost, server.URL+"/", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/x-amz-json-1.1")
	request.Header.Set("X-Amz-Target", "CodeBuild_20161006."+operation)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	var decoded map[string]any
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		t.Fatalf("%s response is not JSON: %v", operation, err)
	}
	return response.StatusCode, decoded
}

const fakeCodeBuildOutput = `agent-1  | [Container] 2026/11/05 22:22:27.023014 Phase is DOWNLOAD_SOURCE
agent-1  | [Container] 2026/11/05 22:22:27.035645 Phase complete: DOWNLOAD_SOURCE State: SUCCEEDED
agent-1  | [Container] 2026/11/05 22:22:27.038376 Entering phase PRE_BUILD
agent-1  | [Container] 2026/11/05 22:22:27.038770 Phase complete: PRE_BUILD State: SUCCEEDED
agent-1  | [Container] 2026/11/05 22:22:27.039475 Entering phase BUILD
agent-1  | [Container] 2026/11/05 22:22:27.039803 Running command echo batch step placeholder
agent-1  | batch step placeholder
agent-1  | [Container] 2026/11/05 22:22:27.042289 Phase complete: BUILD State: SUCCEEDED
agent-1  | [Container] 2026/11/05 22:22:27.043322 Entering phase POST_BUILD
agent-1  | [Container] 2026/11/05 22:22:27.043649 Phase complete: POST_BUILD State: SUCCEEDED
`

func TestCodeBuildStartBuildThroughTheFakeAgent(t *testing.T) {
	service, transport := testCodeBuildService(t, fakeCodeBuildOutput, nil)
	server := httptest.NewServer(service)
	defer server.Close()

	status, started := codeBuildCall(t, server, "StartBuild", map[string]any{
		"projectName": "local-project",
		"environmentVariablesOverride": []map[string]string{
			{"name": "STAGE", "value": "test", "type": "PLAINTEXT"},
		},
	})
	if status != 200 {
		t.Fatalf("StartBuild = %d %v", status, started)
	}
	buildID := (started["build"].(map[string]any))["id"].(string)
	deadline := time.Now().Add(10 * time.Second)
	var build map[string]any
	for time.Now().Before(deadline) {
		_, got := codeBuildCall(t, server, "BatchGetBuilds", map[string]any{"ids": []string{buildID}})
		builds := got["builds"].([]any)
		if len(builds) == 1 {
			build = builds[0].(map[string]any)
			if build["buildStatus"] == "SUCCEEDED" || build["buildStatus"] == "FAILED" {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if build == nil || build["buildStatus"] != "SUCCEEDED" {
		t.Fatalf("build = %v", build)
	}
	phases := map[string]string{}
	for _, raw := range build["phases"].([]any) {
		phase := raw.(map[string]any)
		phases[phase["phaseType"].(string)] = phase["phaseStatus"].(string)
	}
	if phases["BUILD"] != "SUCCEEDED" || phases["COMPLETED"] != "SUCCEEDED" {
		t.Fatalf("phases = %v", phases)
	}
	logs := build["logs"].(map[string]any)
	if !strings.Contains(logs["text"].(string), "batch step placeholder") {
		t.Fatalf("log text = %q", logs["text"])
	}
	_, listed := codeBuildCall(t, server, "ListBuildsForProject", map[string]any{"projectName": "local-project"})
	if len(listed["ids"].([]any)) != 1 || listed["ids"].([]any)[0] != buildID {
		t.Fatalf("ListBuildsForProject = %v", listed)
	}
	_, projects := codeBuildCall(t, server, "BatchGetProjects", map[string]any{"names": []string{"local-project"}})
	if len(projects["projects"].([]any)) != 1 {
		t.Fatalf("BatchGetProjects = %v", projects)
	}

	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/codebuild/builds/"+buildID+"/logs", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != 200 || !strings.Contains(string(body), "batch step placeholder") {
		t.Fatalf("log endpoint = %d %q", response.StatusCode, body)
	}
	if len(service.CodeBuildBuilds()) != 1 {
		t.Fatalf("CodeBuildBuilds = %v", service.CodeBuildBuilds())
	}
	if len(transport.commands) == 0 {
		t.Fatal("the fake Docker transport saw no commands")
	}
}

func TestCodeBuildFailingAgentMarksTheBuildFailed(t *testing.T) {
	service, _ := testCodeBuildService(t, "agent failed", errors.New("agent exited 1"))
	server := httptest.NewServer(service)
	defer server.Close()
	_, started := codeBuildCall(t, server, "StartBuild", map[string]any{"projectName": "local-project"})
	buildID := (started["build"].(map[string]any))["id"].(string)
	deadline := time.Now().Add(10 * time.Second)
	var build map[string]any
	for time.Now().Before(deadline) {
		_, got := codeBuildCall(t, server, "BatchGetBuilds", map[string]any{"ids": []string{buildID}})
		builds := got["builds"].([]any)
		if len(builds) == 1 {
			build = builds[0].(map[string]any)
			if build["buildStatus"] == "FAILED" {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if build == nil || build["buildStatus"] != "FAILED" {
		t.Fatalf("failing build = %v", build)
	}
}

func TestStartCodeBuildControl(t *testing.T) {
	home := testSharedDir(t)
	runner := &Runner{
		options:  Options{Stdout: io.Discard},
		scratch:  filepath.Join(home, "scratch"),
		docker:   &Docker{exec: (&fakeDockerTransport{}).exec},
		profile:  testCodeBuildProfile(),
		clock:    RealClock{},
		eventBus: newEventBridgeBus(RealClock{}),
	}
	if err := os.MkdirAll(runner.scratch, 0o750); err != nil {
		t.Fatal(err)
	}
	spec := &Spec{CodeBuildProjects: []CodeBuildProjectSpec{{
		LogicalID: "Project", Name: "local-project", Image: "aws/codebuild/standard:7.0",
		BuildSpec: "version: 0.2", TimeoutMinutes: 5,
	}}}
	if err := runner.startCodeBuildControl(context.Background(), spec, "aarch64"); err != nil {
		t.Fatal(err)
	}
	if runner.codeBuildURL == "" || runner.codeBuild == nil {
		t.Fatal("the CodeBuild endpoint was not started")
	}
	if _, ok := runner.backendEndpoint(serviceCodeBuild); !ok {
		t.Fatal("the codebuild service endpoint was not registered")
	}
	for _, listener := range runner.listeners {
		_ = listener.Close() //nolint:errcheck // test cleanup
	}
}

func TestNewCodeBuildServiceRefusesUnmappedImages(t *testing.T) {
	runner := &Runner{options: Options{Stdout: io.Discard}, profile: &Profile{path: "p.json"}}
	spec := &Spec{CodeBuildProjects: []CodeBuildProjectSpec{{LogicalID: "P", Name: "p", Image: "aws/codebuild/standard:7.0"}}}
	if _, err := newCodeBuildService(runner, spec, "aarch64"); err == nil {
		t.Fatal("an unmapped image did not fail closed")
	}
}

func TestNormalizeDataDir(t *testing.T) {
	if value, err := normalizeDataDir(""); err != nil || value != "" {
		t.Fatalf("empty = %q, %v", value, err)
	}
	dir := testSharedDir(t)
	resolved, err := normalizeDataDir(dir)
	if err != nil || resolved != dir {
		t.Fatalf("valid = %q, %v", resolved, err)
	}
	file := filepath.Join(dir, "file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := normalizeDataDir(file); err == nil {
		t.Fatal("a file was accepted as a data directory")
	}
}

func TestIntrinsicHelpersCoverEveryValueShape(t *testing.T) {
	if _, ok := templateString(true); !ok {
		t.Fatal("a bool did not convert to a string")
	}
	if _, ok := templateString(nil); !ok {
		t.Fatal("nil did not convert to a string")
	}
	if _, ok := templateString([]any{}); ok {
		t.Fatal("a list converted to a string")
	}
	if _, err := templateInt(1.5); err == nil {
		t.Fatal("a fractional value became an integer")
	}
	if _, err := templateInt("x"); err == nil {
		t.Fatal("a non-numeric string became an integer")
	}
	if name := intrinsicName(map[string]any{"Fn::Sub": "x"}); name != "Fn::Sub" {
		t.Fatalf("intrinsicName = %q", name)
	}
	context := testTemplateContext()
	if _, err := context.resolve(map[string]any{"Fn::Sub": "x"}); err == nil {
		t.Fatal("an unsupported intrinsic resolved")
	}
}

func TestDeliveryEngineRestart(t *testing.T) {
	engine := NewDeliveryEngine(RealClock{}, 0, nil, nil, nil)
	spec := &Spec{}
	if err := engine.Start(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	if err := engine.Restart(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	if state := engine.State(); !state.Running {
		t.Fatalf("state = %+v", state)
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := engine.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
	if state := engine.State(); state.Concurrency != 4 {
		t.Fatalf("state = %+v", state)
	}
}

// restartFakeDocker starts a goroutine that sends the runtime's first /next
// request to the Runtime API the container was given, so the restart path can
// be exercised without a real runtime image. It models the daemon's image
// store just enough for a watch reload: a build produces a new immutable id
// and moves the tag, image inspect resolves a reference to its id, and tag
// points a tag at an id.
type restartFakeDocker struct {
	mu        sync.Mutex
	runs      int
	failRun   int
	failRuns  map[int]bool
	buildErr  error
	images    map[string]string
	builds    int
	runImages []string
	removed   []string
	tagErr    error
}

func (f *restartFakeDocker) imageStore() map[string]string {
	if f.images == nil {
		f.images = map[string]string{}
	}
	return f.images
}

func (f *restartFakeDocker) exec(ctx context.Context, argv []string) (string, string, error) {
	if len(argv) < 2 {
		return "", "", nil
	}
	switch argv[1] {
	case "build":
		if f.buildErr != nil {
			return "", "build failed", f.buildErr
		}
		f.mu.Lock()
		f.builds++
		id := fmt.Sprintf("sha256:built-%d", f.builds)
		for index, argument := range argv {
			if argument == "-t" && index+1 < len(argv) {
				f.imageStore()[argv[index+1]] = id
			}
		}
		f.mu.Unlock()
		return id, "", nil
	case "run":
		f.mu.Lock()
		f.runs++
		run := f.runs
		image := ""
		for _, argument := range argv {
			if _, known := f.imageStore()[argument]; known || strings.HasPrefix(argument, "sha256:") {
				image = argument
			}
		}
		if image != "" {
			f.runImages = append(f.runImages, image)
		}
		f.mu.Unlock()
		if (f.failRun > 0 && run == f.failRun) || f.failRuns[run] {
			return "", "restart failed", errors.New("restart failed")
		}
		for _, argument := range argv {
			if !strings.HasPrefix(argument, "AWS_LAMBDA_RUNTIME_API=") {
				continue
			}
			address := strings.TrimPrefix(argument, "AWS_LAMBDA_RUNTIME_API=")
			_, port, ok := strings.Cut(address, ":")
			if !ok {
				continue
			}
			go func() {
				time.Sleep(20 * time.Millisecond)
				request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+port+"/2018-06-01/runtime/invocation/next", nil)
				if err != nil {
					return
				}
				client := &http.Client{Timeout: 2 * time.Second}
				response, err := client.Do(request)
				if err == nil {
					_ = response.Body.Close() //nolint:errcheck // test cleanup
				}
			}()
		}
		return "container-id", "", nil
	case "tag":
		if len(argv) < 4 {
			return "", "", nil
		}
		if f.tagErr != nil {
			return "", "tag failed", f.tagErr
		}
		f.mu.Lock()
		source := f.imageStore()[argv[2]]
		if source == "" {
			source = argv[2]
		}
		f.imageStore()[argv[3]] = source
		f.mu.Unlock()
		return "", "", nil
	case "image":
		if len(argv) < 3 {
			return "", "", nil
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		switch argv[2] {
		case "inspect":
			reference := argv[len(argv)-1]
			id, ok := f.imageStore()[reference]
			if !ok && strings.HasPrefix(reference, "sha256:") {
				return reference, "", nil
			}
			if !ok {
				return "", "no such image", fmt.Errorf("no such image: %s", reference)
			}
			return id, "", nil
		case "rm":
			for _, reference := range argv[3:] {
				f.removed = append(f.removed, reference)
				delete(f.imageStore(), reference)
			}
			return "", "", nil
		case "ls":
			references := make([]string, 0, len(f.imageStore()))
			for reference := range f.imageStore() {
				references = append(references, reference)
			}
			sort.Strings(references)
			return strings.Join(references, "\n"), "", nil
		}
		return "", "", nil
	case "inspect":
		return "true", "", nil
	case "version":
		return "arm64", "", nil
	case "rm", "network", "volume", "ps":
		return "", "", nil
	default:
		return "", "", nil
	}
}

func TestRestartFunctionReplacesTheExecutionEnvironment(t *testing.T) {
	home := testSharedDir(t)
	asset := filepath.Join(home, "asset")
	if err := os.MkdirAll(asset, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(asset, "index.js"), []byte("exports.handler = async () => ({statusCode:200});"), 0o600); err != nil {
		t.Fatal(err)
	}
	scratch := filepath.Join(home, "scratch")
	if err := os.MkdirAll(scratch, 0o750); err != nil {
		t.Fatal(err)
	}
	runner := &Runner{
		options:    Options{Stdout: io.Discard},
		scratch:    scratch,
		docker:     &Docker{exec: (&restartFakeDocker{}).exec},
		clock:      RealClock{},
		invokers:   map[string]*FunctionProcess{},
		backends:   map[string]backendProcess{},
		transports: map[string]*Transport{},
	}
	base := FunctionSpec{LogicalID: "Fn", Runtime: "nodejs24.x", Handler: "index.handler", AssetDir: asset, MemoryMB: 128, Timeout: 3, Environment: map[string]string{"A": "1"}}
	process := &FunctionProcess{Function: base, Container: "c", Image: "img", options: ContainerOptions{Name: "c", Image: "img"}, logf: func(string, ...any) {}}
	next := base
	next.Environment = map[string]string{"A": "2"}
	if err := runner.replaceFunctionEnvironment(context.Background(), process, next, "img"); err != nil {
		t.Fatal(err)
	}
	if process.Function.Environment["A"] != "2" {
		t.Fatalf("process did not take the new definition: %+v", process.Function)
	}
	runner.stopFunction(context.Background(), process)
}

func TestRestartFunctionRestoresThePreviousDefinition(t *testing.T) {
	home := testSharedDir(t)
	asset := filepath.Join(home, "asset")
	if err := os.MkdirAll(asset, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(asset, "index.js"), []byte("exports.handler = async () => ({statusCode:200});"), 0o600); err != nil {
		t.Fatal(err)
	}
	scratch := filepath.Join(home, "scratch")
	if err := os.MkdirAll(scratch, 0o750); err != nil {
		t.Fatal(err)
	}
	fake := &restartFakeDocker{failRun: 1}
	runner := &Runner{
		options:  Options{Stdout: io.Discard},
		scratch:  scratch,
		docker:   &Docker{exec: fake.exec},
		clock:    RealClock{},
		invokers: map[string]*FunctionProcess{},
		backends: map[string]backendProcess{},
	}
	base := FunctionSpec{LogicalID: "Fn", Runtime: "nodejs24.x", Handler: "index.handler", AssetDir: asset, MemoryMB: 128, Timeout: 3}
	process := &FunctionProcess{Function: base, Container: "c", Image: "img", options: ContainerOptions{Name: "c", Image: "img"}, logf: func(string, ...any) {}}
	next := base
	next.MemoryMB = 256
	if err := runner.restartFunction(context.Background(), process, next, "img", ""); err == nil {
		t.Fatal("a failed restart did not report the failure")
	}
	if process.Function.MemoryMB != 128 {
		t.Fatalf("the previous definition was not restored: %+v", process.Function)
	}
	runner.stopFunction(context.Background(), process)
}

func TestStartFunctionStartsTheContainerThroughTheRuntimeAPI(t *testing.T) {
	home := testSharedDir(t)
	asset := filepath.Join(home, "asset")
	if err := os.MkdirAll(asset, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(asset, "index.js"), []byte("exports.handler = async () => ({statusCode:200});"), 0o600); err != nil {
		t.Fatal(err)
	}
	scratch := filepath.Join(home, "scratch")
	if err := os.MkdirAll(scratch, 0o750); err != nil {
		t.Fatal(err)
	}
	runner := &Runner{
		options:  Options{Stdout: io.Discard},
		scratch:  scratch,
		docker:   &Docker{exec: (&restartFakeDocker{}).exec},
		clock:    RealClock{},
		invokers: map[string]*FunctionProcess{},
		backends: map[string]backendProcess{},
	}
	function := FunctionSpec{LogicalID: "Fn", Runtime: "nodejs24.x", Handler: "index.handler", AssetDir: asset, MemoryMB: 128, Timeout: 3}
	if err := runner.startFunction(context.Background(), function, "image"); err != nil {
		t.Fatal(err)
	}
	process, ok := runner.invokers["Fn"]
	if !ok || process.api == nil {
		t.Fatalf("the function was not registered: %+v", runner.invokers)
	}
	if process.RuntimeAPIURL() == "" {
		t.Fatal("the function has no Runtime API URL")
	}
	runner.stopFunction(context.Background(), process)
}
