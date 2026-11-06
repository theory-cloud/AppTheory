package localrunner

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWatchGlobMatch(t *testing.T) {
	cases := []struct {
		pattern string
		path    string
		want    bool
	}{
		{"**/*", "handler/main.go", true},
		{"**/*", "main.go", true},
		{"handlers/**", "handlers/ts/app.mjs", true},
		{"handlers/**", "lib/app.ts", false},
		{"src/*.ts", "src/app.ts", true},
		{"src/*.ts", "src/deep/app.ts", false},
		{"**/*.go", "handlers/go/main.go", true},
		{"**/*.go", "handlers/go/main.mjs", false},
		{"handlers/**/test/*.py", "handlers/a/b/test/x.py", true},
	}
	for _, testCase := range cases {
		if got := watchGlobMatch(testCase.pattern, testCase.path); got != testCase.want {
			t.Fatalf("watchGlobMatch(%q, %q) = %v, want %v", testCase.pattern, testCase.path, got, testCase.want)
		}
	}
}

func TestLoadWatchConfigFollowsCDKWatch(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "cdk.json"), `{"app":"node bin/app.js","watch":{"include":["bin/**","handlers/**"],"exclude":"**/*.log"}}`)
	config := loadWatchConfig(dir)
	if config.Root != dir {
		t.Fatalf("root = %q, want %q", config.Root, dir)
	}
	if strings.Join(config.Include, ",") != "bin/**,handlers/**" {
		t.Fatalf("include = %v", config.Include)
	}
	if strings.Join(config.Exclude, ",") != "**/*.log" {
		t.Fatalf("exclude = %v", config.Exclude)
	}
}

func TestLoadWatchConfigDefaultsToTheAppDirectory(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "cdk.json"), `{"app":"node bin/app.js"}`)
	config := loadWatchConfig(dir)
	if strings.Join(config.Include, ",") != "**/*" {
		t.Fatalf("include = %v, want **/*", config.Include)
	}
}

func TestSnapshotWatchTreeSkipsGeneratedDirectories(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "handler", "main.go"), "package main")
	writeTestFile(t, filepath.Join(dir, "node_modules", "dep", "index.js"), "module.exports = {}")
	writeTestFile(t, filepath.Join(dir, ".cdk-asset-stage", "ts", "handler.mjs"), "export const x = 1")
	config := loadWatchConfig(dir)
	snapshot := snapshotWatchTree(config)
	if _, ok := snapshot["handler/main.go"]; !ok {
		t.Fatalf("snapshot does not contain the handler: %v", snapshot)
	}
	for path := range snapshot {
		if strings.HasPrefix(path, "node_modules/") || strings.HasPrefix(path, ".cdk-asset-stage/") {
			t.Fatalf("snapshot contains a generated path %q", path)
		}
	}
}

func TestFunctionReloadReasonNamesEveryExecutionInput(t *testing.T) {
	base := FunctionSpec{
		LogicalID: "Fn",
		Runtime:   "provided.al2023",
		Handler:   "bootstrap",
		MemoryMB:  128,
		Timeout:   3,
		AssetDir:  "/assembly/asset.aaa",
		Environment: map[string]string{
			"A": "1",
		},
	}
	if reason := functionReloadReason(base, base); reason != "" {
		t.Fatalf("identical functions reported %q", reason)
	}
	cases := []struct {
		change func(*FunctionSpec)
		want   string
	}{
		{func(function *FunctionSpec) { function.AssetDir = "/assembly/asset.bbb" }, "code"},
		{func(function *FunctionSpec) { function.MemoryMB = 256 }, "limits"},
		{func(function *FunctionSpec) { function.Timeout = 10 }, "limits"},
		{func(function *FunctionSpec) { function.Environment = map[string]string{"A": "2"} }, "environment"},
		{func(function *FunctionSpec) { function.Runtime = "nodejs24.x" }, "runtime"},
		{func(function *FunctionSpec) { function.Handler = "handler.handler" }, "handler"},
		{
			func(function *FunctionSpec) {
				function.Layers = []LayerSpec{{LogicalID: "Layer", AssetDir: "/assembly/asset.layer1"}}
			},
			"layers",
		},
		{
			func(function *FunctionSpec) {
				function.ImageAsset = &DockerImageAssetSpec{Hash: "abc"}
			},
			"image",
		},
	}
	for _, testCase := range cases {
		next := base
		next.Environment = map[string]string{"A": "1"}
		testCase.change(&next)
		reason := functionReloadReason(base, next)
		if !strings.Contains(reason, testCase.want) {
			t.Fatalf("change %q reported %q, want it to name %q", testCase.want, reason, testCase.want)
		}
	}
}

func TestDynamoDBPersistentCommand(t *testing.T) {
	got := dynamoDBPersistentCommand([]string{"-jar", "DynamoDBLocal.jar", "-sharedDb", "-inMemory"})
	want := []string{"-jar", "DynamoDBLocal.jar", "-sharedDb", "-dbPath", "/data"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("command = %v, want %v", got, want)
	}
	custom := dynamoDBPersistentCommand([]string{"-sharedDb", "-dbPath", "/old"})
	if strings.Join(custom, " ") != "-sharedDb -dbPath /data" {
		t.Fatalf("custom command = %v", custom)
	}
}

func TestConfigureBackendDataDir(t *testing.T) {
	runner := &Runner{dataDir: testSharedDir(t), scratch: t.TempDir(), options: Options{Stdout: io.Discard}}
	pin := ContainerPin{Image: "example@sha256:" + strings.Repeat("a", 64), ContainerPort: 8000}
	configured, mounts, err := runner.configureBackendDataDir("dynamodb", backendDynamoDBName, pin)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(configured.Command, " "); got != "-dbPath /data" {
		t.Fatalf("persistent command = %q", got)
	}
	if len(mounts) != 1 || !strings.HasSuffix(mounts[0], "dynamodb:/data") {
		t.Fatalf("mounts = %v", mounts)
	}

	s3, s3Mounts, err := runner.configureBackendDataDir("s3proxy", "s3proxy", pin)
	if err != nil {
		t.Fatal(err)
	}
	if s3.Environment["JCLOUDS_PROVIDER"] != "filesystem" {
		t.Fatalf("s3 environment = %v", s3.Environment)
	}
	if s3.Environment["JCLOUDS_FILESYSTEM_BASEDIR"] != "/data" {
		t.Fatalf("s3 basedir = %q", s3.Environment["JCLOUDS_FILESYSTEM_BASEDIR"])
	}
	if len(s3Mounts) != 1 || !strings.HasSuffix(s3Mounts[0], "s3proxy:/data") {
		t.Fatalf("s3 mounts = %v", s3Mounts)
	}

	_, sqsMounts, err := runner.configureBackendDataDir("sqs", "sqs", pin)
	if err != nil {
		t.Fatal(err)
	}
	if len(sqsMounts) != 2 {
		t.Fatalf("sqs mounts = %v", sqsMounts)
	}
	config, err := os.ReadFile(strings.TrimSuffix(sqsMounts[0], ":/opt/elasticmq.conf:ro"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(config), "messages-storage") || !strings.Contains(string(config), "jdbc:h2:/data/elasticmq") {
		t.Fatalf("sqs config = %s", config)
	}
}

func TestConfigureBackendDataDirIsEphemeralByDefault(t *testing.T) {
	runner := &Runner{options: Options{Stdout: io.Discard}}
	pin := ContainerPin{Command: []string{"-jar", "DynamoDBLocal.jar", "-sharedDb", "-inMemory"}}
	configured, mounts, err := runner.configureBackendDataDir("dynamodb", backendDynamoDBName, pin)
	if err != nil {
		t.Fatal(err)
	}
	if len(mounts) != 0 {
		t.Fatalf("ephemeral run has mounts %v", mounts)
	}
	if strings.Join(configured.Command, " ") != "-jar DynamoDBLocal.jar -sharedDb -inMemory" {
		t.Fatalf("ephemeral command changed: %v", configured.Command)
	}
}

func TestSeedEnvironmentCarriesEndpointsAndDummyCredentials(t *testing.T) {
	runner := &Runner{
		options:   Options{AppDir: "/app", Seed: "sh seed.sh"},
		profile:   &Profile{},
		endpoints: []Endpoint{{Service: "dynamodb", URL: "http://dynamodb-local:8000"}},
		backends: map[string]backendProcess{
			"dynamodb": {HostURL: "http://127.0.0.1:9000", Endpoints: []Endpoint{{Service: "dynamodb"}}},
		},
		eventBusURL: "http://127.0.0.1:9001",
		apiURLs:     map[string]string{"Api": "http://127.0.0.1:9002"},
	}
	env := runner.seedEnvironment(&Spec{APIs: []APISpec{{Class: APIHTTPV2, LogicalID: "Api"}}})
	if env["AWS_ACCESS_KEY_ID"] != "dummy" || env["AWS_SECRET_ACCESS_KEY"] != "dummy" {
		t.Fatalf("seed credentials = %v", env)
	}
	if env["APPTHEORY_LOCAL_ENDPOINT_DYNAMODB"] != "http://127.0.0.1:9000" {
		t.Fatalf("dynamodb endpoint = %q", env["APPTHEORY_LOCAL_ENDPOINT_DYNAMODB"])
	}
	if env["AWS_ENDPOINT_URL_DYNAMODB"] != "http://127.0.0.1:9000" {
		t.Fatalf("AWS endpoint = %q", env["AWS_ENDPOINT_URL_DYNAMODB"])
	}
	if env["APPTHEORY_LOCAL_ENDPOINT_EVENTS"] != "http://127.0.0.1:9001" {
		t.Fatalf("events endpoint = %q", env["APPTHEORY_LOCAL_ENDPOINT_EVENTS"])
	}
	if env["APPTHEORY_LOCAL_URL_API"] != "http://127.0.0.1:9002" {
		t.Fatalf("api url = %q", env["APPTHEORY_LOCAL_URL_API"])
	}
	if !strings.Contains(env["APPTHEORY_LOCAL_APIS"], `"class":"httpv2"`) {
		t.Fatalf("apis = %q", env["APPTHEORY_LOCAL_APIS"])
	}
}

func TestSeedProcessEnvironmentDropsCallerAWSNames(t *testing.T) {
	t.Setenv("AWS_PROFILE", "real")
	env := seedProcessEnvironment(map[string]string{"AWS_ACCESS_KEY_ID": "dummy"})
	for _, entry := range env {
		if strings.HasPrefix(entry, "AWS_PROFILE=") {
			t.Fatalf("seed inherited the caller's AWS_PROFILE: %v", env)
		}
	}
	if !containsEntry(env, "AWS_ACCESS_KEY_ID=dummy") {
		t.Fatalf("seed environment lost the dummy key: %v", env)
	}
}

func TestRunSeedFailsWithTheScriptOutput(t *testing.T) {
	dir := t.TempDir()
	runner := &Runner{
		options: Options{AppDir: dir, Seed: "echo seed-problem >&2; exit 7", Stdout: &bytes.Buffer{}},
		profile: &Profile{},
	}
	err := runner.runSeed(context.Background(), &Spec{})
	if err == nil {
		t.Fatal("a failing seed did not fail the run")
	}
	if !strings.Contains(err.Error(), "seed-problem") {
		t.Fatalf("seed error does not carry the script output: %v", err)
	}
}

func TestTransportSetSurfaceKeepsTheListenerContract(t *testing.T) {
	first := &recordingInvoker{response: []byte(`{"statusCode":200,"body":"first"}`)}
	second := &recordingInvoker{response: []byte(`{"statusCode":200,"body":"second"}`)}
	api := APISpec{Class: APIHTTPV2, LogicalID: "Api", Stage: LocalStageName, Routes: []Route{{
		Class: APIHTTPV2, Method: "GET", Path: "/hello", Function: "First",
	}}}
	transport := NewTransport(api, map[string]Invoker{"First": first}, nil, nil)
	if got := serveTransport(t, transport, "GET", "/hello"); got != "first" {
		t.Fatalf("initial response = %q", got)
	}
	transport.SetSurface(APISpec{Class: APIHTTPV2, LogicalID: "Api", Stage: LocalStageName, Routes: []Route{{
		Class: APIHTTPV2, Method: "GET", Path: "/hello", Function: "Second",
	}}}, map[string]Invoker{"Second": second})
	if got := serveTransport(t, transport, "GET", "/hello"); got != "second" {
		t.Fatalf("reloaded response = %q", got)
	}
}

func TestWatchRefusalsNameNewListeners(t *testing.T) {
	current := &Spec{APIs: []APISpec{{Class: APIHTTPV2, LogicalID: "Api", Routes: []Route{{Function: "Fn"}}}}}
	next := &Spec{APIs: []APISpec{
		{Class: APIHTTPV2, LogicalID: "Api", Routes: []Route{{Function: "Fn"}}},
		{Class: APIRESTV1, LogicalID: "Rest", Routes: []Route{{Function: "Fn"}}},
	}}
	runner := &Runner{}
	runner.spec = current
	refusals := runner.watchRefusals(next)
	if len(refusals) != 1 || !strings.Contains(refusals[0], "restv1/Rest") {
		t.Fatalf("refusals = %v", refusals)
	}
}

func TestWatchSupervisorStopsBeforeCleanup(t *testing.T) {
	runner := &Runner{
		options: Options{AppDir: t.TempDir(), Watch: true, Stdout: io.Discard},
		scratch: t.TempDir(),
	}
	ctx, cancel := context.WithCancel(context.Background())
	runner.startWatch(ctx)
	time.Sleep(50 * time.Millisecond)
	cancel()
	runner.stopWatch()
	if runner.watch != nil {
		t.Fatal("stopWatch left the supervisor attached")
	}
}

// testSharedDir creates a directory under $HOME, which is the only place a
// test may put a bind-mount source.
func testSharedDir(t *testing.T) string {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(home, "apptheory-local-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) }) //nolint:errcheck // test cleanup
	return dir
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// serveTransport sends one request through a transport and returns the body.
func serveTransport(t *testing.T, transport *Transport, method, path string) string {
	t.Helper()
	server := httptest.NewServer(transport)
	defer server.Close()
	request, err := http.NewRequestWithContext(context.Background(), method, server.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // test cleanup
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func containsEntry(entries []string, want string) bool {
	for _, entry := range entries {
		if entry == want {
			return true
		}
	}
	return false
}
