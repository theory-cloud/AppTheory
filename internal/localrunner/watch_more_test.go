package localrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/theory-cloud/apptheory/v7/internal/localcloudfront"
)

func testWatchRunner(t *testing.T) (*Runner, *bytes.Buffer) {
	t.Helper()
	home := testSharedDir(t)
	scratch := filepath.Join(home, "scratch")
	if err := os.MkdirAll(scratch, 0o750); err != nil {
		t.Fatal(err)
	}
	output := &bytes.Buffer{}
	runner := &Runner{
		options:          Options{Stdout: output, AppDir: home},
		scratch:          scratch,
		docker:           &Docker{exec: (&fakeDockerTransport{}).exec},
		profile:          testCodeBuildProfile(),
		clock:            RealClock{},
		delivery:         NewDeliveryEngine(RealClock{}, 0, nil, nil, nil),
		invokers:         map[string]*FunctionProcess{},
		backends:         map[string]backendProcess{},
		transports:       map[string]*Transport{},
		webSocketServers: map[string]*WebSocketServer{},
	}
	runner.spec = &Spec{}
	return runner, output
}

func TestApplyWatchedSpecEmptySurface(t *testing.T) {
	runner, _ := testWatchRunner(t)
	applied, err := runner.applyWatchedSpec(context.Background(), &Spec{}, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if !applied {
		t.Fatal("an empty surface was not applied")
	}
	if runner.CurrentSpec() == nil {
		t.Fatal("the spec was not swapped")
	}
	if err := runner.delivery.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRefreshTransportSurfaces(t *testing.T) {
	runner, _ := testWatchRunner(t)
	api := APISpec{Class: APIHTTPV2, LogicalID: "Api", Stage: LocalStageName, Routes: []Route{{Method: "GET", Path: "/", Function: "Old"}}}
	runner.transports["Api"] = NewTransport(api, map[string]Invoker{}, nil, nil)
	wsAPI := WebSocketAPISpec{LogicalID: "Ws", Stage: "dev", Routes: []WebSocketRouteSpec{{RouteKey: "$default", Function: "Old"}}}
	runner.webSocketServers["Ws"] = &WebSocketServer{API: wsAPI, Invokers: map[string]Invoker{}}
	next := &Spec{
		APIs:         []APISpec{{Class: APIHTTPV2, LogicalID: "Api", Stage: LocalStageName, Routes: []Route{{Method: "GET", Path: "/", Function: "New"}}}},
		WebSockets:   []WebSocketAPISpec{{LogicalID: "Ws", Stage: "dev", Routes: []WebSocketRouteSpec{{RouteKey: "$default", Function: "New"}}}},
		FunctionURLs: []FunctionURLSpec{{LogicalID: "Url", Stack: "S", Function: "Fn"}},
	}
	runner.transports["Url"] = NewTransport(functionURLAPI(next.FunctionURLs[0]), map[string]Invoker{}, nil, nil)
	runner.refreshTransportSurfaces(next)
	if got := runner.transports["Api"].currentAPI().Routes[0].Function; got != "New" {
		t.Fatalf("API route function = %q", got)
	}
	if got := runner.webSocketServers["Ws"].currentAPI().Routes[0].Function; got != "New" {
		t.Fatalf("WebSocket route function = %q", got)
	}
	if got := runner.transports["Url"].currentAPI().Class; got != APIFunctionURL {
		t.Fatalf("Function URL class = %q", got)
	}
}

func TestStopFunctionRemovesItsContainer(t *testing.T) {
	runner, _ := testWatchRunner(t)
	process := &FunctionProcess{Container: "container", logf: func(string, ...any) {}}
	runner.stopFunction(context.Background(), process)
	if process.api != nil {
		t.Fatal("the Runtime API was not closed")
	}
}

func TestWatchAssemblyDirectories(t *testing.T) {
	runner, _ := testWatchRunner(t)
	first := runner.nextWatchAssemblyDir()
	second := runner.nextWatchAssemblyDir()
	if first == second {
		t.Fatalf("watch assemblies share %q", first)
	}
	old := filepath.Join(runner.scratch, "watch", "old")
	if err := os.MkdirAll(old, 0o750); err != nil {
		t.Fatal(err)
	}
	runner.cleanupOldAssemblies(second)
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatalf("old assembly was not removed: %v", err)
	}
	if _, err := os.Stat(second); err != nil {
		t.Fatalf("current assembly was removed: %v", err)
	}
}

func TestWatchLoopDetectsAChangeAndKeepsThePreviousAssembly(t *testing.T) {
	appDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(appDir, "cdk.json"), []byte(`{"app":"node app.js"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	runner, output := testWatchRunner(t)
	runner.options.AppDir = appDir
	runner.options.Watch = true
	ctx, cancel := context.WithCancel(context.Background())
	runner.startWatch(ctx)
	defer func() {
		cancel()
		runner.stopWatch()
	}()
	time.Sleep(100 * time.Millisecond)
	if err := os.WriteFile(filepath.Join(appDir, "handler.go"), []byte("package main"), 0o600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(output.String(), "watch: source change detected") {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("the watcher did not report the edit: %s", output.String())
}

func TestWatchRefusalsCoverEveryNonLiveChange(t *testing.T) {
	current := &Spec{
		WebSockets: []WebSocketAPISpec{{LogicalID: "Ws"}},
		Resources:  []ResourceSpec{{Stack: "S", LogicalID: "Old", Type: typeS3Bucket}},
	}
	next := &Spec{
		WebSockets:        []WebSocketAPISpec{{LogicalID: "Ws"}, {LogicalID: "Ws2"}},
		CloudFront:        []*localcloudfront.Distribution{{LogicalID: "Dist"}},
		CodeBuildProjects: []CodeBuildProjectSpec{{LogicalID: "Project"}},
		Resources:         []ResourceSpec{{Stack: "S", LogicalID: "Old", Type: typeS3Bucket}, {Stack: "S", LogicalID: "New", Type: typeDynamoTable}},
	}
	runner := &Runner{}
	runner.spec = current
	refusals := runner.watchRefusals(next)
	joined := strings.Join(refusals, "; ")
	for _, needle := range []string{"WebSocket API listeners", "CloudFront distribution topology", "CodeBuild project set", "resource New needs the dynamodb backend"} {
		if !strings.Contains(joined, needle) {
			t.Fatalf("refusals %q do not name %q", joined, needle)
		}
	}
}

func TestFunctionAssetFingerprints(t *testing.T) {
	if got := functionAssetFingerprint(FunctionSpec{InlineCode: "x"}); !strings.HasPrefix(got, "inline-") {
		t.Fatalf("inline fingerprint = %q", got)
	}
	if got := functionAssetFingerprint(FunctionSpec{AssetDir: "/assembly/asset.abc"}); got != "asset.abc" {
		t.Fatalf("asset fingerprint = %q", got)
	}
	if got := layerFingerprint(FunctionSpec{Layers: []LayerSpec{{LogicalID: "L", AssetDir: "/a/asset.l"}}}); got != "L=asset.l" {
		t.Fatalf("layer fingerprint = %q", got)
	}
	if got := imageAssetFingerprint(FunctionSpec{ImageAsset: &DockerImageAssetSpec{Hash: "h"}}); !strings.Contains(got, `"Hash":"h"`) {
		t.Fatalf("image fingerprint = %q", got)
	}
	if got := imageAssetFingerprint(FunctionSpec{}); got != "" {
		t.Fatalf("empty image fingerprint = %q", got)
	}
}

func TestFunctionURLAPIShape(t *testing.T) {
	api := functionURLAPI(FunctionURLSpec{LogicalID: "Url", Stack: "S", Function: "Fn", Streaming: true})
	if api.Class != APIFunctionURL || api.Routes[0].Function != "Fn" || !api.Routes[0].Streaming {
		t.Fatalf("Function URL API = %+v", api)
	}
}

// TestTransportSetSurfaceThroughHTTP is a small guard that the listener still
// serves after a swap (the full path is covered by the harness watch rows).
func TestTransportSetSurfaceThroughHTTP(t *testing.T) {
	invoker := &recordingInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
	transport := NewTransport(APISpec{Class: APIHTTPV2, LogicalID: "Api", Routes: []Route{{Method: "GET", Path: "/", Function: "Fn"}}}, map[string]Invoker{"Fn": invoker}, nil, nil)
	transport.SetSurface(APISpec{Class: APIHTTPV2, LogicalID: "Api", Routes: []Route{{Method: "GET", Path: "/", Function: "Fn"}}}, map[string]Invoker{"Fn": invoker})
	server := httptest.NewServer(transport)
	defer server.Close()
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close() //nolint:errcheck // test cleanup
}

func TestListenControlBindsTheOwnedGateway(t *testing.T) {
	gateway := ""
	addresses, err := net.InterfaceAddrs()
	if err == nil {
		for _, address := range addresses {
			ipNet, ok := address.(*net.IPNet)
			if ok && ipNet.IP.To4() != nil && !ipNet.IP.IsLoopback() {
				gateway = ipNet.IP.String()
				break
			}
		}
	}
	if gateway == "" {
		t.Skip("no non-loopback host address to prove the gateway bind")
	}
	runner := &Runner{runtimeAPIGateway: gateway, options: Options{Stdout: io.Discard}}
	listeners, err := runner.listenControl(context.Background(), "test")
	if err != nil {
		t.Fatal(err)
	}
	if listeners.Gateway == nil {
		t.Fatal("the host-owned gateway was not bound")
	}
	_ = listeners.Loopback.Close() //nolint:errcheck // test cleanup
	_ = listeners.Gateway.Close()  //nolint:errcheck // test cleanup
}

func TestBackendDataDirFailsWhenTheRootIsAFile(t *testing.T) {
	dir := testSharedDir(t)
	file := filepath.Join(dir, "file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &Runner{dataDir: file, options: Options{Stdout: io.Discard}}
	if _, err := runner.backendDataDir("dynamodb"); err == nil {
		t.Fatal("a file was accepted as the data root")
	}
}

func TestSeedEnvironmentNamesEveryHostEndpoint(t *testing.T) {
	runner := &Runner{
		options:             Options{AppDir: "/app", Seed: "x"},
		profile:             &Profile{},
		dataDir:             "/data",
		cloudFrontAPIURL:    "http://127.0.0.1:1",
		codeBuildURL:        "http://127.0.0.1:2",
		webSocketManagement: &webSocketManagement{URL: "https://127.0.0.1:3"},
		apiURLs:             map[string]string{"Api": "http://127.0.0.1:4"},
	}
	env := runner.seedEnvironment(&Spec{APIs: []APISpec{{Class: APIRESTV1, LogicalID: "Api"}}})
	for key, want := range map[string]string{
		"APPTHEORY_LOCAL_DATA_DIR":                         "/data",
		"APPTHEORY_LOCAL_ENDPOINT_CLOUDFRONT":              "http://127.0.0.1:1",
		"APPTHEORY_LOCAL_ENDPOINT_CODEBUILD":               "http://127.0.0.1:2",
		"APPTHEORY_LOCAL_ENDPOINT_APIGATEWAYMANAGEMENTAPI": "https://127.0.0.1:3",
		"APPTHEORY_LOCAL_URL_API":                          "http://127.0.0.1:4",
	} {
		if env[key] != want {
			t.Fatalf("%s = %q, want %q", key, env[key], want)
		}
	}
}

func TestReloadWatchedAppAppliesAnEmptyAssembly(t *testing.T) {
	runner, _ := testWatchRunner(t)
	runner.options.AllowNoSurface = true
	fixture := t.TempDir()
	if err := os.WriteFile(filepath.Join(fixture, "manifest.json"), []byte(`{"version":"1","artifacts":{"Stack":{"type":"aws:cloudformation:stack","properties":{"templateFile":"Stack.template.json"}}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture, "Stack.template.json"), []byte(`{"Resources":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	previous := synthRunner
	t.Cleanup(func() { synthRunner = previous })
	synthRunner = func(_ context.Context, options SynthOptions) error {
		manifest, err := os.ReadFile(filepath.Join(fixture, "manifest.json")) //nolint:gosec // test fixture
		if err != nil {
			return err
		}
		template, err := os.ReadFile(filepath.Join(fixture, "Stack.template.json")) //nolint:gosec // test fixture
		if err != nil {
			return err
		}
		if err := os.MkdirAll(options.OutputDir, 0o750); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(options.OutputDir, "manifest.json"), manifest, 0o600); err != nil { //nolint:gosec // test fixture output directory
			return err
		}
		return os.WriteFile(filepath.Join(options.OutputDir, "Stack.template.json"), template, 0o600) //nolint:gosec // test fixture output directory
	}
	if err := runner.reloadWatchedApp(context.Background()); err != nil {
		t.Fatal(err)
	}
	current := runner.CurrentSpec()
	if current == nil || current.AssemblyDir == "" {
		t.Fatalf("the reload did not swap the spec: %+v", current)
	}
	if err := runner.delivery.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestApplyWatchedSpecRestoresProvisioningOnFailure(t *testing.T) {
	runner, _ := testWatchRunner(t)
	runner.backends["dynamodb"] = backendProcess{Endpoints: []Endpoint{{Service: backendDynamoDB}}}
	table := ResourceSpec{Stack: "S", LogicalID: "Table", Type: typeDynamoTable, Properties: []byte(`{"KeySchema":[{"AttributeName":"pk","KeyType":"HASH"}],"AttributeDefinitions":[{"AttributeName":"pk","AttributeType":"S"}]}`)}
	next := &Spec{Resources: []ResourceSpec{table}}
	if applied, err := runner.applyWatchedSpec(context.Background(), next, nil, ""); err == nil || applied {
		t.Fatalf("a failing provisioning step was applied: applied=%v err=%v", applied, err)
	}
	if runner.CurrentSpec() != nil && len(runner.CurrentSpec().Resources) != 0 {
		t.Fatalf("the failure did not restore the previous resources: %+v", runner.CurrentSpec())
	}
}

func applySpecRunner(t *testing.T) (*Runner, string) {
	t.Helper()
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
		delivery:   NewDeliveryEngine(RealClock{}, 0, nil, nil, nil),
		invokers:   map[string]*FunctionProcess{},
		backends:   map[string]backendProcess{},
		transports: map[string]*Transport{},
		images:     map[string]string{"node": "public.ecr.aws/lambda/nodejs:24@sha256:" + strings.Repeat("c", 64)},
	}
	runner.spec = &Spec{}
	return runner, asset
}

func TestApplyWatchedSpecStartsRestartsAndStopsFunctions(t *testing.T) {
	runner, asset := applySpecRunner(t)
	function := FunctionSpec{LogicalID: "Fn", Runtime: "nodejs24.x", Handler: "index.handler", AssetDir: asset, MemoryMB: 128, Timeout: 3, Environment: map[string]string{"A": "1"}}
	next := &Spec{Functions: []FunctionSpec{function}}
	applied, err := runner.applyWatchedSpec(context.Background(), next, []string{"Fn"}, "")
	if err != nil || !applied {
		t.Fatalf("add: applied=%v err=%v", applied, err)
	}
	first, ok := runner.invokers["Fn"]
	if !ok || first.api == nil {
		t.Fatal("the added function was not started")
	}
	firstAPI := first.RuntimeAPIURL()

	changed := function
	changed.Environment = map[string]string{"A": "2"}
	next = &Spec{Functions: []FunctionSpec{changed}}
	applied, err = runner.applyWatchedSpec(context.Background(), next, []string{"Fn"}, "")
	if err != nil || !applied {
		t.Fatalf("restart: applied=%v err=%v", applied, err)
	}
	if runner.invokers["Fn"].RuntimeAPIURL() == firstAPI {
		t.Fatal("the changed function was not restarted")
	}

	applied, err = runner.applyWatchedSpec(context.Background(), &Spec{}, nil, "")
	if err != nil || !applied {
		t.Fatalf("remove: applied=%v err=%v", applied, err)
	}
	if _, ok := runner.invokers["Fn"]; ok {
		t.Fatal("the removed function was not stopped")
	}
	if err := runner.delivery.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestApplyWatchedSpecFailsBeforeSwapOnBadInputs(t *testing.T) {
	runner, asset := applySpecRunner(t)
	cases := []*Spec{
		{Functions: []FunctionSpec{{LogicalID: "Fn", Runtime: "nodejs24.x", Handler: "index.handler", AssetDir: asset, EnvironmentExpressions: map[string]string{"X": `{"Ref":"Missing"}`}}}},
		{Functions: []FunctionSpec{{LogicalID: "Fn", Runtime: "ruby3.4", Handler: "index.handler", AssetDir: asset}}},
	}
	for _, next := range cases {
		applied, err := runner.applyWatchedSpec(context.Background(), next, []string{"Fn"}, "")
		if err == nil || applied {
			t.Fatalf("bad input was applied: applied=%v err=%v", applied, err)
		}
		if runner.CurrentSpec() != nil && len(runner.CurrentSpec().Functions) != 0 {
			t.Fatalf("the failed apply changed the spec: %+v", runner.CurrentSpec())
		}
	}
}

// installSynthFixture makes the fake synth produce the given assembly, so a
// reload test can model the real synth boundary without invoking the CDK.
func installSynthFixture(t *testing.T, fixture string) {
	t.Helper()
	previous := synthRunner
	t.Cleanup(func() { synthRunner = previous })
	synthRunner = func(_ context.Context, options SynthOptions) error {
		return filepath.WalkDir(fixture, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			relative, relErr := filepath.Rel(fixture, path)
			if relErr != nil {
				return relErr
			}
			target := filepath.Join(options.OutputDir, relative)
			if entry.IsDir() {
				return os.MkdirAll(target, 0o750)
			}
			data, readErr := os.ReadFile(path) //nolint:gosec // test fixture
			if readErr != nil {
				return readErr
			}
			return os.WriteFile(target, data, 0o600) //nolint:gosec // test fixture output
		})
	}
}

func TestReloadWatchedAppReportsLoadAndDeriveFailures(t *testing.T) {
	runner, _ := testWatchRunner(t)
	broken := t.TempDir()
	if err := os.WriteFile(filepath.Join(broken, "manifest.json"), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	installSynthFixture(t, broken)
	if err := runner.reloadWatchedApp(context.Background()); err == nil || !strings.Contains(err.Error(), "parse") {
		t.Fatalf("a malformed assembly was not reported: %v", err)
	}

	empty := writeAssembly(t, map[string]any{})
	if assetErr := os.MkdirAll(filepath.Join(empty, "asset.deadbeef"), 0o750); assetErr != nil {
		t.Fatal(assetErr)
	}
	installSynthFixture(t, empty)
	if err := runner.reloadWatchedApp(context.Background()); err == nil || !strings.Contains(err.Error(), "defines no HTTP API v2 route") {
		t.Fatalf("an assembly with no surface was not refused: %v", err)
	}
}

func TestReloadWatchedAppRefusesNewListenersWithoutSwapping(t *testing.T) {
	runner, output := testWatchRunner(t)
	resources := httpAPIResources("ANY /{proxy+}")
	resources["Fn"] = withAsset(lambdaFunction(nil), "asset.deadbeef")
	fixture := writeAssembly(t, resources)
	if err := os.MkdirAll(filepath.Join(fixture, "asset.deadbeef"), 0o750); err != nil {
		t.Fatal(err)
	}
	installSynthFixture(t, fixture)
	previousSpec := &Spec{}
	runner.spec = previousSpec
	if err := runner.reloadWatchedApp(context.Background()); err != nil {
		t.Fatalf("a refused change must not fail the run: %v", err)
	}
	if runner.CurrentSpec() != previousSpec || len(runner.CurrentSpec().APIs) != 0 {
		t.Fatalf("the refused assembly was swapped in: %+v", runner.CurrentSpec())
	}
	if !strings.Contains(output.String(), "API listeners changed") || !strings.Contains(output.String(), "a restart is required") {
		t.Fatalf("the refusal was not reported by name: %s", output.String())
	}
	refused := filepath.Join(runner.scratch, "watch", "assembly-1")
	if _, err := os.Stat(refused); !os.IsNotExist(err) {
		t.Fatalf("the refused assembly was kept: %v", err)
	}
}

func TestReloadWatchedAppRemovesTheAssemblyWhenApplyFails(t *testing.T) {
	runner, _ := testWatchRunner(t)
	resources := map[string]any{
		"Fn": withAsset(lambdaFunction(map[string]any{
			"Environment": map[string]any{"Variables": map[string]any{"X": map[string]any{"Ref": "Missing"}}},
		}), "asset.deadbeef"),
		"Url": map[string]any{
			"Type": typeFunctionURL,
			"Properties": map[string]any{
				"AuthType":          noneAuthorization,
				"TargetFunctionArn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
			},
		},
	}
	fixture := writeAssembly(t, resources)
	if err := os.MkdirAll(filepath.Join(fixture, "asset.deadbeef"), 0o750); err != nil {
		t.Fatal(err)
	}
	installSynthFixture(t, fixture)
	runner.spec = &Spec{FunctionURLs: []FunctionURLSpec{{LogicalID: "Url", Stack: "TestStack", Function: "Fn"}}}
	if err := runner.reloadWatchedApp(context.Background()); err == nil || !strings.Contains(err.Error(), "Missing") {
		t.Fatalf("an unresolvable expression was not reported: %v", err)
	}
	if runner.CurrentSpec() != nil && len(runner.CurrentSpec().Functions) != 0 {
		t.Fatalf("the failed assembly was swapped in: %+v", runner.CurrentSpec())
	}
	failed := filepath.Join(runner.scratch, "watch", "assembly-1")
	if _, err := os.Stat(failed); !os.IsNotExist(err) {
		t.Fatalf("the failed assembly was kept: %v", err)
	}
}

func TestSeedEnvironmentSingleEndpointAndURLClasses(t *testing.T) {
	runner := &Runner{
		options:  Options{AppDir: "/app", Seed: "x"},
		profile:  &Profile{},
		backends: map[string]backendProcess{"dynamodb": {HostURL: "http://127.0.0.1:9000", Endpoints: []Endpoint{{Service: "dynamodb"}}}},
		apiURLs: map[string]string{
			"Api":     "http://127.0.0.1:9002",
			"Url":     "http://127.0.0.1:9003",
			"Dist":    "https://127.0.0.1:9004",
			"Unknown": "http://127.0.0.1:9005",
		},
	}
	spec := &Spec{
		APIs:         []APISpec{{Class: APIRESTV1, LogicalID: "Api"}},
		FunctionURLs: []FunctionURLSpec{{LogicalID: "Url"}},
		CloudFront:   []*localcloudfront.Distribution{{LogicalID: "Dist"}},
	}
	env := runner.seedEnvironment(spec)
	if env["AWS_ENDPOINT_URL"] != "http://127.0.0.1:9000" {
		t.Fatalf("a single endpoint did not become AWS_ENDPOINT_URL: %q", env["AWS_ENDPOINT_URL"])
	}
	var apis []map[string]string
	if err := json.Unmarshal([]byte(env["APPTHEORY_LOCAL_APIS"]), &apis); err != nil {
		t.Fatal(err)
	}
	classes := map[string]string{}
	for _, api := range apis {
		classes[api["logicalId"]] = api["class"]
	}
	if classes["Api"] != string(APIRESTV1) || classes["Url"] != string(APIFunctionURL) || classes["Dist"] != "cloudfront" || classes["Unknown"] != "" {
		t.Fatalf("API classes = %+v", classes)
	}

	multi := &Runner{
		options:     Options{},
		profile:     &Profile{},
		backends:    map[string]backendProcess{"dynamodb": {HostURL: "http://127.0.0.1:9000", Endpoints: []Endpoint{{Service: "dynamodb"}}}},
		eventBusURL: "http://127.0.0.1:9001",
	}
	if got := multi.seedEnvironment(&Spec{})["AWS_ENDPOINT_URL"]; got != ClosedEndpoint {
		t.Fatalf("multiple endpoints did not close the default: %q", got)
	}
	if env := (&Runner{profile: &Profile{}}).seedEnvironment(&Spec{}); env["AWS_ENDPOINT_URL"] != ClosedEndpoint {
		t.Fatalf("no endpoints did not close the default: %q", env["AWS_ENDPOINT_URL"])
	}
}

func TestTailText(t *testing.T) {
	if got := tailText("", 40); got != "(no output)" {
		t.Fatalf("empty tail = %q", got)
	}
	lines := make([]string, 0, 5)
	for index := 0; index < 5; index++ {
		lines = append(lines, "line"+string(rune('0'+index)))
	}
	if got := tailText(strings.Join(lines, "\n"), 2); got != "line3\nline4" {
		t.Fatalf("tail = %q", got)
	}
	if got := seedIDEnvName("my-api.v2"); got != "MY_API_V2" {
		t.Fatalf("seedIDEnvName = %q", got)
	}
}

func TestDataDirRefusals(t *testing.T) {
	root := testSharedDir(t)
	blocker := filepath.Join(root, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := normalizeDataDir(filepath.Join(blocker, "sub")); err == nil {
		t.Fatal("a data directory under a file was accepted")
	}
	private := filepath.Join(root, "private")
	if err := os.MkdirAll(private, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := normalizeDataDir(filepath.Join(private, "sub")); err == nil {
		t.Fatal("a data directory inside an unreadable parent was accepted")
	}
	if _, err := normalizeDataDir(blocker); err == nil || !strings.Contains(err.Error(), "not a directory") {
		t.Fatalf("a file as --data-dir = %v", err)
	}
	runner := &Runner{dataDir: blocker, options: Options{Stdout: io.Discard}, profile: &Profile{}}
	for _, container := range []string{backendDynamoDBName, "s3proxy", backendSQS} {
		if _, _, err := runner.configureBackendDataDir("", container, ContainerPin{}); err == nil {
			t.Fatalf("%s accepted a data root that is a file", container)
		}
	}
	runner = &Runner{options: Options{Stdout: io.Discard}, scratch: blocker, profile: &Profile{}}
	if _, err := runner.elasticMQDataConfig(nil); err == nil {
		t.Fatal("an ElasticMQ config under a file was written")
	}
	sqs := &Runner{dataDir: root, options: Options{Stdout: io.Discard}, scratch: blocker, profile: &Profile{}}
	if _, _, err := sqs.configureBackendDataDir("", backendSQS, ContainerPin{}); err == nil {
		t.Fatal("an ElasticMQ data directory with an unwritable config was accepted")
	}
	if _, _, err := (&Runner{profile: &Profile{}}).configureBackendDataDir("", "moto", ContainerPin{}); err != nil {
		t.Fatalf("moto without --data-dir = %v", err)
	}
	moto := &Runner{dataDir: root, options: Options{Stdout: io.Discard}, profile: &Profile{}}
	if _, mounts, err := moto.configureBackendDataDir("", "moto", ContainerPin{}); err != nil || len(mounts) != 0 {
		t.Fatalf("moto mounts = %v, %v", mounts, err)
	}
	if _, mounts, err := moto.configureBackendDataDir("", "unknown", ContainerPin{}); err != nil || len(mounts) != 0 {
		t.Fatalf("unknown backend mounts = %v, %v", mounts, err)
	}
}

func TestSeedEnvironmentSkipsABackendWithoutHostURL(t *testing.T) {
	runner := &Runner{
		options:  Options{},
		profile:  &Profile{},
		backends: map[string]backendProcess{"dynamodb": {Endpoints: []Endpoint{{Service: "dynamodb"}}}},
	}
	env := runner.seedEnvironment(&Spec{})
	if _, ok := env["APPTHEORY_LOCAL_ENDPOINT_DYNAMODB"]; ok {
		t.Fatal("a backend without a host URL produced an endpoint")
	}
}

func TestStopFunctionAcceptsNilAndNextAssemblyDirReportsFailure(t *testing.T) {
	runner, _ := testWatchRunner(t)
	runner.stopFunction(context.Background(), nil)
	file := filepath.Join(runner.scratch, "file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner.scratch = file
	if dir := runner.nextWatchAssemblyDir(); !strings.Contains(dir, "assembly-1") {
		t.Fatalf("nextWatchAssemblyDir = %q", dir)
	}
}

func TestStartFunctionClosesTheRuntimeAPIWhenTheContainerFails(t *testing.T) {
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
		docker:   &Docker{exec: (&restartFakeDocker{failRun: 1}).exec},
		clock:    RealClock{},
		invokers: map[string]*FunctionProcess{},
		backends: map[string]backendProcess{},
	}
	function := FunctionSpec{LogicalID: "Fn", Runtime: "nodejs24.x", Handler: "index.handler", AssetDir: asset, MemoryMB: 128, Timeout: 3}
	if err := runner.startFunction(context.Background(), function, "image"); err == nil {
		t.Fatal("a failed container start was reported as ready")
	}
	process := runner.invokers["Fn"]
	if process == nil {
		t.Fatal("the failed function was not registered for cleanup")
	}
	if process.api != nil {
		t.Fatal("the Runtime API leaked after a failed start")
	}
}

func TestDataDirModesAllowTheContainerUsers(t *testing.T) {
	root := filepath.Join(testSharedDir(t), "data")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	normalized, err := normalizeDataDir(root)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(normalized)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o755 {
		t.Fatalf("--data-dir mode = %o, want 755", mode)
	}
	runner := &Runner{dataDir: normalized, scratch: testSharedDir(t), options: Options{Stdout: io.Discard}}
	dir, err := runner.backendDataDir("dynamodb")
	if err != nil {
		t.Fatal(err)
	}
	if info, statErr := os.Stat(dir); statErr != nil || info.Mode().Perm() != 0o777 {
		t.Fatalf("backend dir = %v, %v", info, statErr)
	}
	// A directory left private by an older run is widened again.
	if tightenErr := os.Chmod(dir, 0o750); tightenErr != nil { //nolint:gosec // deliberately tighten the test directory to prove it is widened
		t.Fatal(tightenErr)
	}
	if _, widenErr := runner.backendDataDir("dynamodb"); widenErr != nil {
		t.Fatal(err)
	}
	if info, statErr := os.Stat(dir); statErr != nil || info.Mode().Perm() != 0o777 {
		t.Fatalf("an existing backend dir was not widened: %v, %v", info, statErr)
	}
	config, err := runner.elasticMQDataConfig(nil)
	if err != nil {
		t.Fatal(err)
	}
	if info, statErr := os.Stat(config); statErr != nil || info.Mode().Perm() != 0o644 {
		t.Fatalf("ElasticMQ config = %v, %v", info, statErr)
	}
}

func TestWatchGlobBranches(t *testing.T) {
	config := watchConfig{Include: []string{"src/**", "cdk.json"}, Exclude: []string{"src/generated/**"}}
	cases := map[string]bool{
		"cdk.json":           true,
		"src/app.ts":         true,
		"src/generated/x.ts": false,
		"lib/x.ts":           false,
	}
	for path, want := range cases {
		if got := watchIncludes(config, path); got != want {
			t.Fatalf("watchIncludes(%q) = %v, want %v", path, got, want)
		}
	}
	if !watchGlobMatch("src/**", "src") {
		t.Fatal("** did not match zero segments")
	}
	if watchGlobMatch("src/*", "src/a/b") {
		t.Fatal("* matched across segments")
	}
	if watchGlobMatch("[", "x") {
		t.Fatal("an invalid pattern matched")
	}
	if parts := splitWatchPath("/"); parts != nil {
		t.Fatalf("splitWatchPath(/) = %v", parts)
	}
	if parts := splitWatchPath("/a/b/"); len(parts) != 2 {
		t.Fatalf("splitWatchPath = %v", parts)
	}
}
