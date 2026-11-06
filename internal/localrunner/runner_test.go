package localrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type syncBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

// testBase returns a directory Docker would share: under the user cache
// directory, which is under $HOME.
func testBase(t *testing.T) string {
	t.Helper()
	cache, err := os.UserCacheDir()
	if err != nil {
		t.Fatalf("user cache dir: %v", err)
	}
	base, err := os.MkdirTemp(cache, "apptheory-local-test-")
	if err != nil {
		t.Fatalf("temp base: %v", err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(base); err != nil {
			t.Errorf("remove test base: %v", err)
		}
	})
	return base
}

func writeTestProfile(t *testing.T, base string) string {
	t.Helper()
	document := map[string]any{
		"profile": map[string]any{
			"dynamodbLocal": map[string]any{"image": "amazon/dynamodb-local@" + testDigest},
			"lambda": map[string]any{"images": map[string]any{
				"go":     map[string]any{"tag": "public.ecr.aws/lambda/provided:al2023", "digest": testDigest},
				"node":   map[string]any{"tag": "public.ecr.aws/lambda/nodejs:24", "digest": testDigest},
				"python": map[string]any{"tag": "public.ecr.aws/lambda/python:3.14", "digest": testDigest},
			}},
			"endpoints": map[string]any{"dynamodb": map[string]any{"env": []any{"AWS_ENDPOINT_URL_DYNAMODB"}}},
		},
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(base, "examples-local.json")
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// testAssembly writes a one-function, one-route cloud assembly and returns its
// directory.
func testAssembly(t *testing.T, base string) string {
	t.Helper()
	dir := filepath.Join(base, "cdk.out")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	writeJSONFile(t, filepath.Join(dir, "manifest.json"), map[string]any{
		"version": "54.0.0",
		"artifacts": map[string]any{"TestStack": map[string]any{
			"type":       "aws:cloudformation:stack",
			"properties": map[string]any{"templateFile": "TestStack.template.json"},
		}},
	})
	resources := httpAPIResources("ANY /{proxy+}")
	resources["Fn"] = withAsset(lambdaFunction(nil), "asset.deadbeef")
	writeJSONFile(t, filepath.Join(dir, "TestStack.template.json"), map[string]any{"Resources": resources})
	if err := os.Mkdir(filepath.Join(dir, "asset.deadbeef"), 0o750); err != nil {
		t.Fatal(err)
	}
	return dir
}

// fakeRunnerDocker answers the Docker commands the lifecycle issues. Function
// containers are not real: the RIE port is a listener the test owns. Backend
// containers answer on a separate loopback port owned by the test.
func fakeRunnerDocker(t *testing.T, riePort, backendPort int, calls *[]string) *Docker {
	t.Helper()
	var mu sync.Mutex
	record := func(argv []string) {
		mu.Lock()
		defer mu.Unlock()
		*calls = append(*calls, strings.Join(argv, " "))
	}
	return &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
		record(argv)
		if len(argv) < 2 {
			return "", "", nil
		}
		switch argv[1] {
		case "version":
			return "arm64\n", "", nil
		case "network":
			return "network-id\n", "", nil
		case "run":
			if hasArgument(argv, "--name", "preflight") {
				return `{"ok":true,"checks":{"credentials":"dummy static"}}`, "", nil
			}
			return "container-id\n", "", nil
		case "inspect":
			if strings.Contains(strings.Join(argv, " "), "IPAddress") {
				return "172.18.0.2\n", "", nil
			}
			return "true\n", "", nil
		case "port":
			if len(argv) > 2 && strings.Contains(argv[2], "dynamodb") {
				return "127.0.0.1:" + strconv.Itoa(backendPort) + "\n", "", nil
			}
			return "127.0.0.1:" + strconv.Itoa(riePort) + "\n", "", nil
		case "logs":
			return "function log\n", "", nil
		case "ps":
			return "", "", nil
		case "rm":
			return "", "", nil
		}
		return "", "", nil
	}}
}

func hasArgument(argv []string, flagName, fragment string) bool {
	for index := 0; index < len(argv)-1; index++ {
		if argv[index] == flagName && strings.Contains(argv[index+1], fragment) {
			return true
		}
	}
	return false
}

func newTestRunner(t *testing.T, base string) *Runner {
	t.Helper()
	runner, err := NewRunner(Options{
		AppDir:         base,
		AssemblyDir:    testAssembly(t, base),
		ScratchDir:     filepath.Join(base, "scratch"),
		ProfilePath:    writeTestProfile(t, base),
		Backends:       []string{backendDynamoDB},
		MaxConcurrency: 2,
		NamePrefix:     "test-run",
		Stdout:         &syncBuffer{},
	})
	if err != nil {
		t.Fatalf("new runner: %v", err)
	}
	return runner
}

func TestRunnerLifecycle(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	rie := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNotFound)
	}))
	defer rie.Close()
	backend := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		if _, err := writer.Write([]byte(`{"TableNames":[]}`)); err != nil {
			t.Errorf("write backend response: %v", err)
		}
	}))
	defer backend.Close()
	var calls []string
	runner.docker = fakeRunnerDocker(t, serverPort(t, rie.URL), serverPort(t, backend.URL), &calls)
	// This lifecycle test models the embedded emulator container; the Runtime
	// API path is exercised by its own tests and the example harness.
	runner.options.RIEMode = true

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()

	deadline := time.Now().Add(30 * time.Second)
	for !strings.Contains(mustSyncBuffer(t, runner.options.Stdout).String(), "local-run: ready") {
		if time.Now().After(deadline) {
			t.Fatalf("runner did not become ready:\n%s", mustSyncBuffer(t, runner.options.Stdout).String())
		}
		select {
		case err := <-done:
			t.Fatalf("run returned early: %v\n%s", err, mustSyncBuffer(t, runner.options.Stdout).String())
		default:
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("run did not shut down")
	}
	output := mustSyncBuffer(t, runner.options.Stdout).String()
	for _, fragment := range []string{
		"network test-run-net",
		"backend dynamodb",
		"preflight credentials",
		"function Fn",
		"serving httpv2",
		"shutting down",
	} {
		if !strings.Contains(output, fragment) {
			t.Fatalf("run log missing %q:\n%s", fragment, output)
		}
	}
	joined := strings.Join(calls, "\n")
	for _, command := range []string{"docker network create", "docker rm -f test-run-dynamodb", "docker network rm test-run-net"} {
		if !strings.Contains(joined, command) {
			t.Fatalf("docker calls missing %q:\n%s", command, joined)
		}
	}
	if _, err := os.Stat(runner.Scratch()); !os.IsNotExist(err) {
		t.Fatalf("run scratch was not removed: %v", err)
	}
}

func TestRunnerSessionLifecycle(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	rie := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNotFound)
	}))
	defer rie.Close()
	backend := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		if _, err := writer.Write([]byte(`{"TableNames":[]}`)); err != nil {
			t.Errorf("write backend response: %v", err)
		}
	}))
	defer backend.Close()
	var calls []string
	runner.docker = fakeRunnerDocker(t, serverPort(t, rie.URL), serverPort(t, backend.URL), &calls)
	runner.options.RIEMode = true

	commands := strings.NewReader(`{"op":"describe"}` + "\n" + `{"op":"clock.now"}` + "\n" + `{"op":"shutdown"}` + "\n")
	var out bytes.Buffer
	if err := runner.RunSession(context.Background(), commands, &out); err != nil {
		t.Fatalf("session: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("one response per command: %v", lines)
	}
	for index, line := range lines[:2] {
		var response map[string]any
		if err := json.Unmarshal([]byte(line), &response); err != nil {
			t.Fatalf("response %d: %v", index, err)
		}
		if response["ok"] != true {
			t.Fatalf("response %d: %v", index, response)
		}
	}
	if !strings.Contains(mustSyncBuffer(t, runner.options.Stdout).String(), "local-run: ready") {
		t.Fatal("the session did not report ready")
	}
}

func TestRunnerDownRemovesLabelledResources(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	var calls []string
	runner.docker = &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
		calls = append(calls, strings.Join(argv, " "))
		switch argv[1] {
		case "version":
			return "arm64\n", "", nil
		case "ps":
			return "container-1\ncontainer-2\n", "", nil
		case "network":
			return "network-1\n", "", nil
		}
		return "", "", nil
	}}
	removed, err := runner.Down(context.Background())
	if err != nil {
		t.Fatalf("down: %v", err)
	}
	if removed != 3 {
		t.Fatalf("down removed %d, want 3", removed)
	}
	joined := strings.Join(calls, "\n")
	for _, command := range []string{"docker rm -f container-1", "docker network rm network-1"} {
		if !strings.Contains(joined, command) {
			t.Fatalf("down calls missing %q:\n%s", command, joined)
		}
	}
}

func TestRunnerPlanAndPlanJSON(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	spec, err := runner.Plan(context.Background())
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if len(spec.APIs) != 1 || len(spec.FunctionURLsFor("Fn")) != 0 {
		t.Fatalf("unexpected spec: %+v", spec)
	}
	document, err := runner.PlanJSON(spec)
	if err != nil {
		t.Fatalf("plan json: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(document, &decoded); err != nil {
		t.Fatalf("plan json is not JSON: %v", err)
	}
	functions, ok := decoded["functions"].([]any)
	if !ok || len(functions) != 1 {
		t.Fatalf("plan json functions: %v", decoded["functions"])
	}
	if runner.Scratch() == "" {
		t.Fatal("scratch path is empty")
	}
	runner.CleanScratch()
	if _, err := os.Stat(runner.Scratch()); !os.IsNotExist(err) {
		t.Fatalf("clean scratch left the directory: %v", err)
	}
}

func TestNormalizeOptions(t *testing.T) {
	base := testBase(t)
	cases := []struct {
		name    string
		options Options
		wantErr string
	}{
		{"missing app", Options{}, "app directory is required"},
		{"missing directory", Options{AppDir: filepath.Join(base, "nope")}, "is not a directory"},
		{"bad concurrency", Options{AppDir: base, MaxConcurrency: maxConcurrency + 1}, "max-concurrency"},
		{"negative port", Options{AppDir: base, PortBase: -1}, "port-base"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := normalizeOptions(testCase.options)
			if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
				t.Fatalf("expected %q, got %v", testCase.wantErr, err)
			}
		})
	}
	normalized, err := normalizeOptions(Options{AppDir: base})
	if err != nil {
		t.Fatalf("defaults: %v", err)
	}
	if normalized.MaxConcurrency != maxConcurrency || normalized.SynthTimeout <= 0 || normalized.ScratchDir == "" {
		t.Fatalf("defaults not applied: %+v", normalized)
	}
}

func TestValidateEndpointsAndBackends(t *testing.T) {
	base := testBase(t)
	runner, err := NewRunner(Options{AppDir: base, ScratchDir: filepath.Join(base, "scratch")})
	if err != nil {
		t.Fatalf("new runner: %v", err)
	}
	if _, exists := runner.backendEndpoint("dynamodb"); exists {
		t.Fatal("no backend endpoint should exist yet")
	}
	if err := runner.validateBackends(); err != nil {
		t.Fatalf("validate backends: %v", err)
	}
	duplicated := &Runner{endpoints: []Endpoint{{Service: "dynamodb", URL: "http://a:1"}, {Service: "dynamodb", URL: "http://b:2"}}}
	if err := duplicated.validateEndpoints(); err == nil {
		t.Fatal("duplicate endpoints must fail")
	}
	badBackend := &Runner{options: Options{Backends: []string{"sqs"}}}
	if err := badBackend.validateBackends(); err == nil {
		t.Fatal("unknown backends must fail")
	}
}

func TestResolveImagesAndArchitecture(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	spec, err := runner.Plan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.resolveImages(spec, archARM64, spec.ServedFunctions()); err != nil {
		t.Fatalf("resolve images: %v", err)
	}
	if err := runner.resolveImages(spec, archAMD64, spec.ServedFunctions()); err == nil || !strings.Contains(err.Error(), "cross-architecture") {
		t.Fatalf("architecture mismatch must fail: %v", err)
	}
	missing := &Spec{APIs: []APISpec{{Routes: []Route{{Function: "Missing"}}}}}
	if err := runner.resolveImages(missing, archARM64, missing.ServedFunctions()); err == nil {
		t.Fatal("a route to an undefined function must fail")
	}
	unsupportedRuntime := &Spec{
		Functions: []FunctionSpec{{LogicalID: "Fn", Runtime: "java21", AssetDir: base}},
		APIs:      []APISpec{{Routes: []Route{{Function: "Fn"}}}},
	}
	if err := runner.resolveImages(unsupportedRuntime, archARM64, unsupportedRuntime.ServedFunctions()); err == nil {
		t.Fatal("an unsupported runtime must fail")
	}
	noProfile := &Runner{images: map[string]string{}}
	if err := noProfile.resolveImages(spec, archARM64, spec.ServedFunctions()); err == nil {
		t.Fatal("a run without a profile must fail")
	}
}

func TestPrepareScratchMaterializesInlineCode(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	spec := &Spec{Functions: []FunctionSpec{{
		LogicalID:  "InlineFn",
		InlineCode: "exports.handler = async () => ({statusCode: 200});",
		InlineFile: "index.js",
	}}}
	if err := runner.prepareScratch(spec); err != nil {
		t.Fatalf("prepare scratch: %v", err)
	}
	dir := filepath.Join(runner.Scratch(), "inline", "inlinefn")
	if _, err := os.Stat(filepath.Join(dir, "index.js")); err != nil {
		t.Fatalf("inline code not materialized: %v", err)
	}
	if spec.Functions[0].AssetDir != dir {
		t.Fatalf("inline asset dir not set: %+v", spec.Functions[0])
	}
}

func TestStartFunctionRejectsUnsharedPaths(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	function := FunctionSpec{LogicalID: "Fn", Runtime: "nodejs24.x", Handler: "index.handler", AssetDir: "/private/tmp/not-shared"}
	if err := runner.startFunction(context.Background(), function, "image"); err == nil ||
		!strings.Contains(err.Error(), "Docker (colima) does not share") {
		t.Fatalf("unshared path must fail: %v", err)
	}
}

func TestEnsureSharedPath(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	if err := ensureSharedPath(filepath.Join(home, "code")); err != nil {
		t.Fatalf("home path rejected: %v", err)
	}
	if err := ensureSharedPath(filepath.Join(t.TempDir(), "outside")); err == nil {
		t.Fatal("a path outside $HOME and the working directory must be refused")
	}
}

func TestNamingAndListeners(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	if runner.containerName("Stack/Function") != "test-run-stack-function" {
		t.Fatalf("unexpected container name: %s", runner.containerName("Stack/Function"))
	}
	if runner.backendsContainerName("dynamodb") != "test-run-dynamodb" {
		t.Fatalf("unexpected backend name: %s", runner.backendsContainerName("dynamodb"))
	}
	if archMatches("arm64", "x86_64") || !archMatches("amd64", "x86_64") {
		t.Fatal("architecture matching is wrong")
	}
	if sanitizeNamePrefix("", "apptheory-local-deadbeef") != "apptheory-local-deadbeef" {
		t.Fatal("fallback name prefix not used")
	}
	if len(hashOf("a")) != 8 || len(shortID()) != 8 {
		t.Fatal("unexpected id lengths")
	}
	ctx := context.Background()
	listener, err := runner.listen(ctx, 0)
	if err != nil {
		t.Fatalf("ephemeral listener: %v", err)
	}
	port := listenerPort(t, listener)
	if closeErr := listener.Close(); closeErr != nil {
		t.Fatalf("close listener: %v", closeErr)
	}
	var config net.ListenConfig
	blocked, err := config.Listen(ctx, "tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if closeErr := blocked.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
			t.Errorf("close blocked listener: %v", closeErr)
		}
	})
	runner.options.PortBase = port
	if _, err := runner.listen(ctx, 0); err == nil {
		t.Fatal("an occupied port must fail")
	}
}

func TestImageForAndLabels(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	if err := runner.resolveImages(&Spec{
		Functions: []FunctionSpec{{LogicalID: "Fn", Runtime: "nodejs24.x", Handler: "index.handler"}},
		APIs:      []APISpec{{Routes: []Route{{Function: "Fn"}}}},
	}, archARM64, []string{"Fn"}); err != nil {
		t.Fatalf("resolve node image: %v", err)
	}
	if _, err := runner.imageFor(context.Background(), FunctionSpec{LogicalID: "Fn", Runtime: "nodejs24.x"}); err != nil {
		t.Fatalf("image for: %v", err)
	}
	if _, err := runner.imageFor(context.Background(), FunctionSpec{LogicalID: "Fn", Runtime: "java21"}); err == nil {
		t.Fatal("unsupported runtime must fail")
	}
	labels := runner.labels()
	for _, name := range []string{labelRun, labelApp, labelManaged} {
		if labels[name] == "" {
			t.Fatalf("label %s missing", name)
		}
	}
}

func TestPreflightParsesProbeOutput(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	runner.docker = fakeRunnerDocker(t, 1, 1, &[]string{})
	result, err := runner.Preflight(context.Background(), "test-run-net", nil)
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	if result.Checks["credentials"] != "dummy static" {
		t.Fatalf("unexpected preflight checks: %+v", result.Checks)
	}

	runner.docker = &Docker{exec: func(_ context.Context, _ []string) (string, string, error) {
		return "not json", "", nil
	}}
	if _, err := runner.Preflight(context.Background(), "net", nil); err == nil {
		t.Fatal("a probe without JSON must fail")
	}
	runner.docker = &Docker{exec: func(_ context.Context, _ []string) (string, string, error) {
		return `{"ok":false,"error":"aws hostname resolved"}`, "", nil
	}}
	if _, err := runner.Preflight(context.Background(), "net", nil); err == nil ||
		!strings.Contains(err.Error(), "aws hostname resolved") {
		t.Fatalf("a failed probe must report its reason: %v", err)
	}
}
