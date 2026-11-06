package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

func layerResource(asset string) map[string]any {
	return map[string]any{
		"Type": typeLambdaLayer,
		"Properties": map[string]any{
			"Content": map[string]any{"S3Bucket": "bucket", "S3Key": asset + ".zip"},
		},
		"Metadata": map[string]any{assetPathMetadataKey: asset},
	}
}

func imageFunction(t *testing.T, asset string, buildArgs map[string]any) map[string]any {
	t.Helper()
	function := lambdaFunction(nil)
	properties, ok := function["Properties"].(map[string]any)
	if !ok {
		t.Fatalf("lambdaFunction has no Properties")
	}
	delete(properties, "Runtime")
	delete(properties, "Handler")
	properties["PackageType"] = "Image"
	properties["Code"] = map[string]any{
		"ImageUri": map[string]any{"Fn::Sub": "account.dkr.ecr.region.amazonaws.com/repo:" + asset},
	}
	function["Metadata"] = map[string]any{
		assetPathMetadataKey:    asset,
		metadataDockerFile:      "Dockerfile",
		metadataDockerBuildArgs: buildArgs,
	}
	return function
}

func TestDeriveLayersResolveAssetsInOrder(t *testing.T) {
	resources := httpAPIResources("GET /")
	resources["LayerOne"] = layerResource("asset.layer-one")
	resources["LayerTwo"] = layerResource("asset.layer-two")
	resources["Fn"] = withAsset(lambdaFunction(map[string]any{
		"Runtime": "nodejs24.x",
		"Handler": "app.handler",
		"Layers":  []any{map[string]any{"Ref": "LayerOne"}, map[string]any{"Ref": "LayerTwo"}},
	}), "asset.deadbeef")
	dir := writeAssembly(t, resources)
	for _, asset := range []string{"asset.deadbeef", "asset.layer-one", "asset.layer-two"} {
		if err := os.MkdirAll(filepath.Join(dir, asset), 0o750); err != nil {
			t.Fatal(err)
		}
	}
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	function, ok := spec.Function("Fn")
	if !ok {
		t.Fatalf("function not derived")
	}
	if len(function.Layers) != 2 {
		t.Fatalf("layers = %+v", function.Layers)
	}
	if function.Layers[0].LogicalID != "LayerOne" || function.Layers[1].LogicalID != "LayerTwo" {
		t.Fatalf("layer order = %+v", function.Layers)
	}
	if function.LayerProblem != "" {
		t.Fatalf("layer problem = %s", function.LayerProblem)
	}
}

func TestDeriveRefusesMoreThanFiveLayers(t *testing.T) {
	resources := httpAPIResources("GET /")
	layers := make([]any, 0, 6)
	for index := 0; index < 6; index++ {
		id := "Layer" + string(rune('A'+index))
		resources[id] = layerResource("asset." + strings.ToLower(id))
		layers = append(layers, map[string]any{"Ref": id})
	}
	resources["Fn"] = withAsset(lambdaFunction(map[string]any{
		"Runtime": "nodejs24.x",
		"Handler": "app.handler",
		"Layers":  layers,
	}), "asset.deadbeef")
	dir := writeAssembly(t, resources)
	if err := os.MkdirAll(filepath.Join(dir, "asset.deadbeef"), 0o750); err != nil {
		t.Fatal(err)
	}
	_, err := deriveAssembly(t, dir)
	if err == nil || !strings.Contains(err.Error(), "at most 5") || !strings.Contains(err.Error(), "chapter-layers") {
		t.Fatalf("six layers must fail closed with the page cited, got %v", err)
	}
}

func TestDeriveRefusesAnExternalLayerARN(t *testing.T) {
	resources := httpAPIResources("GET /")
	resources["Fn"] = withAsset(lambdaFunction(map[string]any{
		"Runtime": "nodejs24.x",
		"Handler": "app.handler",
		"Layers":  []any{"arn:aws:lambda:us-east-1:123456789012:layer:shared:7"},
	}), "asset.deadbeef")
	dir := writeAssembly(t, resources)
	if err := os.MkdirAll(filepath.Join(dir, "asset.deadbeef"), 0o750); err != nil {
		t.Fatal(err)
	}
	_, err := deriveAssembly(t, dir)
	if err == nil || !strings.Contains(err.Error(), "is not a LayerVersion in this cloud assembly") {
		t.Fatalf("an external layer must fail closed by name, got %v", err)
	}
}

func TestDeriveImageFunctionResolvesTheDockerAsset(t *testing.T) {
	resources := httpAPIResources("GET /")
	resources["Fn"] = imageFunction(t, "asset.image", map[string]any{"IMAGE_VALUE": "go-image-build"})
	dir := writeAssembly(t, resources)
	if err := os.MkdirAll(filepath.Join(dir, "asset.image"), 0o750); err != nil {
		t.Fatal(err)
	}
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	function, ok := spec.Function("Fn")
	if !ok || function.ImageAsset == nil {
		t.Fatalf("image function not derived: %+v", function)
	}
	if function.ImageAsset.DockerFile != "Dockerfile" {
		t.Fatalf("dockerfile = %q", function.ImageAsset.DockerFile)
	}
	if function.ImageAsset.BuildArgs["IMAGE_VALUE"] != "go-image-build" {
		t.Fatalf("build args = %+v", function.ImageAsset.BuildArgs)
	}
	if function.ImageAsset.Directory != filepath.Join(dir, "asset.image") {
		t.Fatalf("directory = %q", function.ImageAsset.Directory)
	}
}

func TestDeriveRefusesLayersOnAnImageFunction(t *testing.T) {
	resources := httpAPIResources("GET /")
	resources["Layer"] = layerResource("asset.layer")
	function := imageFunction(t, "asset.image", nil)
	properties, ok := function["Properties"].(map[string]any)
	if !ok {
		t.Fatalf("imageFunction has no Properties")
	}
	properties["Layers"] = []any{map[string]any{"Ref": "Layer"}}
	resources["Fn"] = function
	dir := writeAssembly(t, resources)
	for _, asset := range []string{"asset.image", "asset.layer"} {
		if err := os.MkdirAll(filepath.Join(dir, asset), 0o750); err != nil {
			t.Fatal(err)
		}
	}
	_, err := deriveAssembly(t, dir)
	if err == nil || !strings.Contains(err.Error(), "container-image functions do not support Lambda layers") {
		t.Fatalf("image + layers must fail closed, got %v", err)
	}
}

func TestCopyTreeLaterLayerWins(t *testing.T) {
	first := t.TempDir()
	second := t.TempDir()
	target := t.TempDir()
	if err := os.MkdirAll(filepath.Join(first, "shared"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(first, "shared", "value.txt"), []byte("first"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(first, "only-first.txt"), []byte("one"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(second, "shared-value.txt"), []byte("second"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(second, "shared"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(second, "shared", "value.txt"), []byte("second"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{first, second} {
		if err := copyTree(source, target); err != nil {
			t.Fatalf("copy: %v", err)
		}
	}
	value, err := os.ReadFile(filepath.Join(target, "shared", "value.txt")) //nolint:gosec // the path is a test temp directory
	if err != nil {
		t.Fatal(err)
	}
	if string(value) != "second" {
		t.Fatalf("later layer did not replace the earlier file: %q", value)
	}
	if _, err := os.Stat(filepath.Join(target, "only-first.txt")); err != nil {
		t.Fatalf("an earlier layer's unique file was lost: %v", err)
	}
}

func TestLayerEnvironmentCarriesTheDocumentedPaths(t *testing.T) {
	runner := &Runner{
		imageEnvs: map[string]map[string]string{},
		docker: &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
			if len(argv) > 1 && argv[1] == "image" {
				return "PATH=/usr/bin:/bin\nLD_LIBRARY_PATH=/usr/lib\n", "", nil
			}
			return "", "", nil
		}},
	}
	node, err := runner.layerEnvironment(context.Background(), FunctionSpec{Runtime: "nodejs24.x"}, "image", map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	if node["PATH"] != "/opt/bin:/usr/bin:/bin" {
		t.Fatalf("PATH = %q", node["PATH"])
	}
	if node["LD_LIBRARY_PATH"] != "/opt/lib:/usr/lib" {
		t.Fatalf("LD_LIBRARY_PATH = %q", node["LD_LIBRARY_PATH"])
	}
	if node["NODE_PATH"] != "/opt/nodejs/node_modules:/opt/nodejs/node24/node_modules" {
		t.Fatalf("NODE_PATH = %q", node["NODE_PATH"])
	}
	python, err := runner.layerEnvironment(context.Background(), FunctionSpec{Runtime: "python3.14"}, "image", map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	if python["PYTHONPATH"] != "/opt/python:/opt/python/lib/python3.14/site-packages" {
		t.Fatalf("PYTHONPATH = %q", python["PYTHONPATH"])
	}
}

func TestBuildImageArgvIsDeterministic(t *testing.T) {
	argv := BuildImageArgv(ImageBuildOptions{
		Tag:        "tag",
		Directory:  "/asset",
		DockerFile: "Dockerfile",
		BuildArgs:  map[string]string{"B": "2", "A": "1"},
		Target:     "build",
		Platform:   "linux/arm64",
		Labels:     map[string]string{"z": "1", "a": "2"},
	})
	want := []string{
		"docker", "build", "-t", "tag",
		"--label", "a=2", "--label", "z=1",
		"-f", "/asset/Dockerfile",
		"--target", "build",
		"--platform", "linux/arm64",
		"--build-arg", "A=1", "--build-arg", "B=2",
		"/asset",
	}
	if !reflect.DeepEqual(argv, want) {
		t.Fatalf("argv = %#v", argv)
	}
}

func TestBuildFunctionImageRunsDockerBuild(t *testing.T) {
	// The build context must be under $HOME or the checkout so Docker shares it;
	// a t.TempDir() lives outside both on macOS.
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("home: %v", err)
	}
	assetDir, err := os.MkdirTemp(home, ".apptheory-image-test-")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() {
		if removeErr := os.RemoveAll(assetDir); removeErr != nil {
			t.Logf("remove %s: %v", assetDir, removeErr)
		}
	})
	var called [][]string
	runner := &Runner{
		options:     Options{Stdout: os.Stderr},
		builtImages: map[string]string{},
		images:      map[string]string{},
		imageEnvs:   map[string]map[string]string{},
		namePrefix:  "r2br4r5a-test",
		docker: &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
			called = append(called, append([]string(nil), argv...))
			return "sha256:abc", "", nil
		}},
	}
	function := FunctionSpec{
		LogicalID: "ImageFn",
		ImageAsset: &DockerImageAssetSpec{
			Directory:  assetDir,
			DockerFile: "Dockerfile",
			BuildArgs:  map[string]string{"IMAGE_VALUE": "value"},
		},
	}
	tag, err := runner.imageFor(context.Background(), function)
	if err != nil {
		t.Fatalf("imageFor: %v", err)
	}
	if len(called) != 1 || called[0][0] != "docker" || called[0][1] != "build" {
		t.Fatalf("docker build was not called: %#v", called)
	}
	if !strings.Contains(strings.Join(called[0], " "), "IMAGE_VALUE=value") {
		t.Fatalf("build args missing: %#v", called[0])
	}
	if runner.builtImages["ImageFn"] != tag {
		t.Fatalf("built image not tracked: %+v", runner.builtImages)
	}
	if _, err := runner.imageFor(context.Background(), function); err != nil {
		t.Fatalf("second imageFor: %v", err)
	}
	if len(called) != 1 {
		t.Fatalf("a cached image build must not run docker again: %#v", called)
	}
}

func TestFunctionImageTagIsUniquePerFunction(t *testing.T) {
	runner := &Runner{namePrefix: "run-prefix"}
	one := runner.functionImageTag(FunctionSpec{LogicalID: "OneFn"})
	two := runner.functionImageTag(FunctionSpec{LogicalID: "TwoFn"})
	if one == two || !strings.Contains(one, "onefn") || !strings.Contains(two, "twofn") {
		t.Fatalf("tags = %q %q", one, two)
	}
}

func TestFunctionImageTagIsUniquePerRun(t *testing.T) {
	one := (&Runner{namePrefix: "run-prefix", runID: "run-one"}).functionImageTag(FunctionSpec{LogicalID: "OneFn"})
	two := (&Runner{namePrefix: "run-prefix", runID: "run-two"}).functionImageTag(FunctionSpec{LogicalID: "OneFn"})
	if one == two {
		t.Fatalf("two runs of one app share the image tag %q", one)
	}
}

func TestImageFunctionWithoutAnAssetFailsClosed(t *testing.T) {
	resources := httpAPIResources("GET /")
	function := imageFunction(t, "asset.image", nil)
	function["Metadata"] = map[string]any{}
	resources["Fn"] = function
	dir := writeAssembly(t, resources)
	if err := os.MkdirAll(filepath.Join(dir, "asset.deadbeef"), 0o750); err != nil {
		t.Fatal(err)
	}
	_, err := deriveAssembly(t, dir)
	if err == nil || !strings.Contains(err.Error(), "no local Docker asset directory") {
		t.Fatalf("an image without an asset must fail closed, got %v", err)
	}
}

func TestLayerReferenceExpressionsAreRefused(t *testing.T) {
	for name, reference := range map[string]any{
		"import value": map[string]any{"Fn::ImportValue": "SharedLayer"},
		"fn if":        map[string]any{"Fn::If": []any{"Cond", "a", "b"}},
	} {
		t.Run(name, func(t *testing.T) {
			raw, err := json.Marshal(reference)
			if err != nil {
				t.Fatal(err)
			}
			if _, problem := layerReferenceID(raw); problem == "" {
				t.Fatalf("%s must be refused", name)
			}
		})
	}
}

func TestCopyTreeKeepsRelativeSymlinks(t *testing.T) {
	source := t.TempDir()
	target := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "regular.txt"), []byte("ok"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("regular.txt", filepath.Join(source, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if err := copyTree(source, target); err != nil {
		t.Fatalf("copy: %v", err)
	}
	if _, err := os.Stat(filepath.Join(target, "regular.txt")); err != nil {
		t.Fatalf("regular file missing: %v", err)
	}
	info, err := os.Lstat(filepath.Join(target, "link.txt"))
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("a relative symlink must be materialized in the layer directory: %v", err)
	}
	if linkTarget, err := os.Readlink(filepath.Join(target, "link.txt")); err != nil || linkTarget != "regular.txt" {
		t.Fatalf("symlink target = %q, %v", linkTarget, err)
	}
}

func TestLayerEnvironmentKeepsExistingPaths(t *testing.T) {
	runner := &Runner{
		imageEnvs: map[string]map[string]string{},
		docker: &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
			return "", "inspect failed", errors.New("no image")
		}},
	}
	env, err := runner.layerEnvironment(context.Background(), FunctionSpec{Runtime: "python3.14"}, "missing-image",
		map[string]string{"PYTHONPATH": "/custom/python", "PATH": "/custom/bin"})
	if err != nil {
		t.Fatalf("layerEnvironment: %v", err)
	}
	if env["PYTHONPATH"] != "/opt/python:/opt/python/lib/python3.14/site-packages:/custom/python" {
		t.Fatalf("PYTHONPATH = %q", env["PYTHONPATH"])
	}
	if env["PATH"] != "/opt/bin:/custom/bin" {
		t.Fatalf("PATH = %q", env["PATH"])
	}
	node, err := runner.layerEnvironment(context.Background(), FunctionSpec{Runtime: "nodejs24.x"}, "missing-image",
		map[string]string{"NODE_PATH": "/custom/node"})
	if err != nil {
		t.Fatalf("node layerEnvironment: %v", err)
	}
	if node["NODE_PATH"] != "/opt/nodejs/node_modules:/opt/nodejs/node24/node_modules:/custom/node" {
		t.Fatalf("NODE_PATH = %q", node["NODE_PATH"])
	}
}

func TestBuildFunctionImageReportsDockerFailure(t *testing.T) {
	runner := &Runner{
		options:     Options{Stdout: os.Stderr},
		builtImages: map[string]string{},
		namePrefix:  "test",
		docker: &Docker{exec: func(context.Context, []string) (string, string, error) {
			return "", "build failed", errors.New("exit 1")
		}},
	}
	_, err := runner.imageFor(context.Background(), FunctionSpec{
		LogicalID:  "ImageFn",
		ImageAsset: &DockerImageAssetSpec{Directory: "/asset", DockerFile: "Dockerfile"},
	})
	if err == nil || !strings.Contains(err.Error(), "Function ImageFn") && !strings.Contains(err.Error(), "function ImageFn") {
		t.Fatalf("build failure = %v", err)
	}
	if len(runner.builtImages) != 0 {
		t.Fatalf("a failed build must not be tracked: %+v", runner.builtImages)
	}
}

func TestImageAssetMetadataProblems(t *testing.T) {
	function := lambdaFunction(nil)
	properties, ok := function["Properties"].(map[string]any)
	if !ok {
		t.Fatalf("lambdaFunction has no Properties")
	}
	properties["PackageType"] = "Image"
	properties["Code"] = map[string]any{"ImageUri": "account/repo:hash"}
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "asset.image"), 0o750); err != nil {
		t.Fatal(err)
	}
	metadata := map[string]json.RawMessage{
		assetPathMetadataKey:    json.RawMessage(`"asset.image"`),
		metadataDockerBuildArgs: json.RawMessage(`"not-a-map"`),
	}
	if _, problem, err := parseDockerImageAsset(dir, "Fn", templateResource{Metadata: metadata}); err == nil || problem != "" {
		t.Fatalf("bad build args metadata = %q %v", problem, err)
	}
	if _, problem, err := parseDockerImageAsset(t.TempDir(), "Fn", templateResource{Metadata: map[string]json.RawMessage{}}); err != nil || problem == "" {
		t.Fatalf("missing asset = %q %v", problem, err)
	}
	if _, problem, err := parseDockerImageAsset(t.TempDir(), "Fn", templateResource{Metadata: map[string]json.RawMessage{
		assetPathMetadataKey: json.RawMessage(`"asset.missing"`),
	}}); err != nil || problem == "" {
		t.Fatalf("missing directory = %q %v", problem, err)
	}
}

func TestResolveZipCodeProblems(t *testing.T) {
	var function FunctionSpec
	if err := resolveZipCode(t.TempDir(), assemblyStack{Name: "Stack"}, "Fn", templateResource{}, &function); err != nil {
		t.Fatalf("resolveZipCode: %v", err)
	}
	if !strings.Contains(function.CodeProblem, "no local asset directory") {
		t.Fatalf("missing asset problem = %q", function.CodeProblem)
	}
	function = FunctionSpec{}
	if err := resolveZipCode(t.TempDir(), assemblyStack{Name: "Stack"}, "Fn", templateResource{
		Metadata: map[string]json.RawMessage{assetPathMetadataKey: json.RawMessage(`"control\u0000name"`)},
	}, &function); err != nil {
		t.Fatalf("resolveZipCode: %v", err)
	}
	if function.CodeProblem == "" {
		t.Fatal("a NUL in the asset path must be reported")
	}
}

func TestImageURIHashWithoutAHash(t *testing.T) {
	if got := imageURIHash(json.RawMessage(`{"Code":{"ImageUri":"account/repo:latest"}}`)); got != "" {
		t.Fatalf("hash = %q", got)
	}
	if got := imageURIHash(json.RawMessage(`not-json`)); got != "" {
		t.Fatalf("invalid properties hash = %q", got)
	}
	if !hasImageURI(json.RawMessage(`{"Fn::Sub":"x"}`)) || hasImageURI(json.RawMessage(`null`)) || hasImageURI(nil) {
		t.Fatal("hasImageURI is wrong")
	}
}

func TestNodeMajorVersionRejectsANonNumericRuntime(t *testing.T) {
	if got := nodeMajorVersion("nodejsPro"); got != "" {
		t.Fatalf("major = %q", got)
	}
	if got := nodeMajorVersion("python3.14"); got != "" {
		t.Fatalf("major = %q", got)
	}
}

func TestFunctionCommandAndMounts(t *testing.T) {
	command, err := functionCommand(FunctionSpec{ImageAsset: &DockerImageAssetSpec{}})
	if err != nil || command != nil {
		t.Fatalf("image command = %v %v", command, err)
	}
	if _, err := functionCommand(FunctionSpec{Runtime: "nodejs24.x"}); err == nil {
		t.Fatal("a zip function without a handler must fail")
	}
	mounts := functionMounts(FunctionSpec{AssetDir: "/code", OptDir: "/opt"})
	if len(mounts) != 2 || mounts[0] != "/code:/var/task:ro" || mounts[1] != "/opt:/opt:ro" {
		t.Fatalf("mounts = %+v", mounts)
	}
	if len(functionMounts(FunctionSpec{})) != 0 {
		t.Fatal("a function with no code or layers must have no mounts")
	}
}

func TestLayerReferenceRejectsLiteralAndBrokenExpressions(t *testing.T) {
	if _, problem := layerReferenceID(json.RawMessage(`"layer-name"`)); problem == "" {
		t.Fatal("a literal layer name must be refused")
	}
	if _, problem := layerReferenceID(json.RawMessage(`"not-json`)); problem == "" {
		t.Fatal("invalid JSON must be refused")
	}
	if _, problem := layerReferenceID(json.RawMessage(`{"Fn::GetAtt":["Layer"]}`)); problem != "" {
		t.Fatalf("a one-element GetAtt must resolve: %q", problem)
	}
	if _, problem := layerReferenceID(json.RawMessage(`{"Fn::GetAtt":[]}`)); problem == "" {
		t.Fatal("an empty GetAtt must be refused")
	}
}

func TestPrepareScratchMergesLayersIntheListedOrder(t *testing.T) {
	scratch := t.TempDir()
	first := t.TempDir()
	second := t.TempDir()
	if err := os.MkdirAll(filepath.Join(first, "nodejs", "node_modules"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(first, "nodejs", "node_modules", "keep.txt"), []byte("first"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(second, "keep.txt"), []byte("second"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &Runner{scratch: scratch}
	spec := &Spec{Functions: []FunctionSpec{{
		LogicalID: "Layered",
		Layers:    []LayerSpec{{LogicalID: "First", AssetDir: first}, {LogicalID: "Second", AssetDir: second}},
	}}}
	if err := runner.prepareScratch(spec); err != nil {
		t.Fatalf("prepareScratch: %v", err)
	}
	optDir := spec.Functions[0].OptDir
	if optDir == "" {
		t.Fatal("the layer directory was not materialized")
	}
	value, err := os.ReadFile(filepath.Join(optDir, "keep.txt")) //nolint:gosec // the path is a test temp directory
	if err != nil || string(value) != "second" {
		t.Fatalf("later layer did not replace the file: %q %v", value, err)
	}
	if _, err := os.Stat(filepath.Join(optDir, "nodejs", "node_modules", "keep.txt")); err != nil {
		t.Fatalf("earlier layer content missing: %v", err)
	}
}

func TestRemoveRunImagesRemovesTrackedAndLabelledImages(t *testing.T) {
	var removed []string
	runner := &Runner{
		options:     Options{Stdout: os.Stderr},
		runID:       "run-1",
		builtImages: map[string]string{"Fn": "tracked-image"},
		docker: &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
			if len(argv) > 2 && argv[1] == "image" && argv[2] == "ls" {
				return "labeled-image\n", "", nil
			}
			if len(argv) > 2 && argv[1] == "image" && argv[2] == "rm" {
				removed = append(removed, argv[len(argv)-1])
			}
			return "", "", nil
		}},
	}
	runner.removeRunImages(time.Now().Add(time.Minute))
	if len(removed) != 2 {
		t.Fatalf("removed = %+v", removed)
	}
	sort.Strings(removed)
	if removed[0] != "labeled-image" || removed[1] != "tracked-image" {
		t.Fatalf("removed = %+v", removed)
	}
	if len(runner.builtImages) != 0 {
		t.Fatalf("built images were not cleared: %+v", runner.builtImages)
	}
}

func TestBuildFunctionImageRequiresASharedContext(t *testing.T) {
	runner := &Runner{
		options:     Options{Stdout: os.Stderr},
		builtImages: map[string]string{},
		namePrefix:  "test",
		docker:      &Docker{exec: func(context.Context, []string) (string, string, error) { return "", "", nil }},
	}
	_, err := runner.imageFor(context.Background(), FunctionSpec{
		LogicalID:  "ImageFn",
		ImageAsset: &DockerImageAssetSpec{Directory: "/asset", DockerFile: "Dockerfile"},
	})
	if err == nil || !strings.Contains(err.Error(), "Docker") {
		t.Fatalf("a build context outside the shared paths must fail: %v", err)
	}
}
