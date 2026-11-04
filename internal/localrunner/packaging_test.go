package localrunner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
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
	if python["PYTHONPATH"] != "/opt/python" {
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
			Directory:  "/asset",
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
