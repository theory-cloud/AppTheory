package localrunner

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Function packaging: Lambda layers and container images.
//
// A zip function's Layers are LayerVersion resources in the same cloud
// assembly; the runner extracts every layer into /opt in the listed order. A
// container-image function's Code.ImageUri names a CDK Docker image asset in the
// same assembly; the runner builds it with docker and starts it under the
// image's own runtime interface emulator.
//
// https://docs.aws.amazon.com/lambda/latest/dg/chapter-layers.html
// https://docs.aws.amazon.com/lambda/latest/dg/images-create.html

const (
	// maxLambdaLayers is the documented per-function layer limit.
	maxLambdaLayers = 5
	// typeLambdaLayer is the CloudFormation layer resource.
	typeLambdaLayer = "AWS::Lambda::LayerVersion"

	metadataDockerFile      = "aws:asset:dockerfile-path"
	metadataDockerBuildArgs = "aws:asset:docker-build-args"
	metadataDockerTarget    = "aws:asset:docker-build-target"
	metadataDockerPlatform  = "aws:asset:docker-platform"
)

var imageURIHashPattern = regexp.MustCompile(`[0-9a-f]{64}`)

// resolveFunctionPackaging fills the function's layers or container image from
// the cloud assembly. A zip function with layers and a container-image function
// are mutually exclusive, as the layers page states.
func resolveFunctionPackaging(
	assemblyDir string,
	stack assemblyStack,
	id string,
	resource templateResource,
	props lambdaFunctionProperties,
	function *FunctionSpec,
) error {
	image := strings.EqualFold(strings.TrimSpace(props.PackageType), "image") || hasImageURI(props.Code.ImageURI)
	if image {
		function.PackageType = "Image"
		if len(props.Layers) > 0 {
			function.LayerProblem = "container-image functions do not support Lambda layers; remove Layers from the function " +
				"(https://docs.aws.amazon.com/lambda/latest/dg/chapter-layers.html)"
			return nil
		}
		asset, problem, err := parseDockerImageAsset(assemblyDir, id, resource)
		if err != nil {
			return fmt.Errorf("%s/%s: %w", stack.Name, id, err)
		}
		if problem != "" {
			function.CodeProblem = problem
			return nil
		}
		function.ImageAsset = asset
		return nil
	}
	if len(props.Layers) > maxLambdaLayers {
		function.LayerProblem = fmt.Sprintf(
			"function declares %d Lambda layers; Lambda attaches at most %d (https://docs.aws.amazon.com/lambda/latest/dg/chapter-layers.html)",
			len(props.Layers), maxLambdaLayers,
		)
		return nil
	}
	layers, problem := parseFunctionLayers(assemblyDir, stack, props.Layers)
	if problem != "" {
		function.LayerProblem = problem
		return nil
	}
	function.Layers = layers
	return nil
}

// parseFunctionLayers resolves the layer resources the function lists, in the
// template's order.
func parseFunctionLayers(assemblyDir string, stack assemblyStack, raws []json.RawMessage) ([]LayerSpec, string) {
	layers := make([]LayerSpec, 0, len(raws))
	for _, raw := range raws {
		layer, problem := parseLayerReference(assemblyDir, stack, raw)
		if problem != "" {
			return nil, problem
		}
		layers = append(layers, layer)
	}
	return layers, ""
}

// parseLayerReference resolves one Layers entry. Only a LayerVersion in this
// stack is assembled; a cross-stack or external layer ARN is refused by name,
// because the runner cannot obtain its content.
func parseLayerReference(assemblyDir string, stack assemblyStack, raw json.RawMessage) (LayerSpec, string) {
	id, problem := layerReferenceID(raw)
	if problem != "" {
		return LayerSpec{}, problem
	}
	resource, ok := stack.Template.Resources[id]
	if !ok {
		return LayerSpec{}, fmt.Sprintf("layer reference names %s, which is not in this stack's template", id)
	}
	if resource.Type != typeLambdaLayer {
		return LayerSpec{}, fmt.Sprintf(
			"layer reference names %s, which is an %s, not an AWS::Lambda::LayerVersion",
			id, resource.Type,
		)
	}
	assetPath, err := metadataString(resource.Metadata, assetPathMetadataKey)
	if err != nil {
		return LayerSpec{}, err.Error()
	}
	if assetPath == "" {
		return LayerSpec{}, fmt.Sprintf(
			"layer %s has no local asset directory (aws:asset:path) in the cloud assembly",
			id,
		)
	}
	if !filepath.IsAbs(assetPath) {
		assetPath = filepath.Join(assemblyDir, assetPath)
	}
	info, statErr := os.Stat(assetPath)
	if statErr != nil || !info.IsDir() {
		return LayerSpec{}, fmt.Sprintf("layer %s asset %s is not a directory", id, assetPath)
	}
	return LayerSpec{LogicalID: id, AssetDir: filepath.Clean(assetPath)}, ""
}

// layerReferenceID accepts a Ref or GetAtt to a layer resource. A literal layer
// ARN names a layer the assembly does not contain and is refused with that
// reason; every other expression is refused too.
func layerReferenceID(raw json.RawMessage) (string, string) {
	var literal string
	if err := json.Unmarshal(raw, &literal); err == nil {
		if strings.HasPrefix(strings.TrimSpace(literal), "arn:") {
			return "", fmt.Sprintf(
				"layer ARN %q is not a LayerVersion in this cloud assembly; the runner assembles only layers the assembly built",
				literal,
			)
		}
		return "", fmt.Sprintf("layer %q is not an AWS::Lambda::LayerVersion reference", literal)
	}
	var ref struct {
		Ref         string            `json:"Ref"`
		GetAtt      []json.RawMessage `json:"Fn::GetAtt"`
		ImportValue json.RawMessage   `json:"Fn::ImportValue"`
	}
	if err := json.Unmarshal(raw, &ref); err != nil {
		return "", "layer reference is not an AWS::Lambda::LayerVersion reference"
	}
	if ref.Ref != "" {
		return ref.Ref, ""
	}
	if len(ref.GetAtt) >= 1 {
		var id string
		if err := json.Unmarshal(ref.GetAtt[0], &id); err == nil && id != "" {
			return id, ""
		}
	}
	if len(ref.ImportValue) > 0 {
		return "", "layer reference is a cross-stack Fn::ImportValue; the runner assembles only layers in the same assembly"
	}
	return "", "layer reference is a CloudFormation expression the runner cannot resolve"
}

// parseDockerImageAsset reads the aws:asset:* metadata CDK writes on a
// container-image function. The asset directory and Dockerfile are the same
// files docker build would use.
func parseDockerImageAsset(assemblyDir, id string, resource templateResource) (*DockerImageAssetSpec, string, error) {
	assetPath, err := metadataString(resource.Metadata, assetPathMetadataKey)
	if err != nil {
		return nil, "", err
	}
	if assetPath == "" {
		return nil, "container-image function has no local Docker asset directory (aws:asset:path); only a CDK DockerImageAsset can be built locally", nil
	}
	dockerFile, err := metadataString(resource.Metadata, metadataDockerFile)
	if err != nil {
		return nil, "", err
	}
	target, err := metadataString(resource.Metadata, metadataDockerTarget)
	if err != nil {
		return nil, "", err
	}
	platform, err := metadataString(resource.Metadata, metadataDockerPlatform)
	if err != nil {
		return nil, "", err
	}
	buildArgs, err := metadataStringMap(resource.Metadata, metadataDockerBuildArgs)
	if err != nil {
		return nil, "", err
	}
	if !filepath.IsAbs(assetPath) {
		assetPath = filepath.Join(assemblyDir, assetPath)
	}
	info, statErr := os.Stat(assetPath)
	if statErr != nil || !info.IsDir() {
		return nil, fmt.Sprintf("Docker asset %s for function %s is not a directory", assetPath, id), nil
	}
	if strings.TrimSpace(dockerFile) == "" {
		dockerFile = "Dockerfile"
	}
	return &DockerImageAssetSpec{
		Hash:       imageURIHash(resource.Properties),
		Directory:  filepath.Clean(assetPath),
		DockerFile: dockerFile,
		BuildArgs:  buildArgs,
		Target:     target,
		Platform:   platform,
	}, "", nil
}

// imageURIHash returns the content hash CDK put in Code.ImageUri. The hash is
// used only to name the locally built image.
func imageURIHash(properties json.RawMessage) string {
	var props lambdaFunctionProperties
	if err := json.Unmarshal(properties, &props); err != nil {
		return ""
	}
	if match := imageURIHashPattern.FindString(string(props.Code.ImageURI)); match != "" {
		return match
	}
	return ""
}

// hasImageURI reports whether Code.ImageUri is present and not null.
func hasImageURI(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return trimmed != "" && trimmed != "null"
}

func metadataStringMap(metadata map[string]json.RawMessage, key string) (map[string]string, error) {
	raw, ok := metadata[key]
	if !ok {
		return nil, nil
	}
	var values map[string]string
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, fmt.Errorf("metadata %q is not a string map: %w", key, err)
	}
	return values, nil
}

// sortedBuildArgs renders docker build arguments in a stable order.
func sortedBuildArgs(args map[string]string) []string {
	keys := make([]string, 0, len(args))
	for key := range args {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, key+"="+args[key])
	}
	return out
}
