package localrunner

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Resource types the assembly reader understands.
const (
	typeLambdaFunction  = "AWS::Lambda::Function"
	typeHTTPAPI         = "AWS::ApiGatewayV2::Api"
	typeHTTPRoute       = "AWS::ApiGatewayV2::Route"
	typeHTTPIntegration = "AWS::ApiGatewayV2::Integration"
	typeHTTPStage       = "AWS::ApiGatewayV2::Stage"
	typeHTTPAuthorizer  = "AWS::ApiGatewayV2::Authorizer"
	typeRESTAPI         = "AWS::ApiGateway::RestApi"
	typeRESTResource    = "AWS::ApiGateway::Resource"
	typeRESTMethod      = "AWS::ApiGateway::Method"
	typeRESTStage       = "AWS::ApiGateway::Stage"
	typeRESTAuthorizer  = "AWS::ApiGateway::Authorizer"
	typeFunctionURL     = "AWS::Lambda::Url"
	typeCloudFront      = "AWS::CloudFront::Distribution"
	typeCloudFrontFn    = "AWS::CloudFront::Function"

	assetPathMetadataKey = "aws:asset:path"
	streamingURIMarker   = "/response-streaming-invocations"
	proxyIntegration     = "AWS_PROXY"
	httpProtocol         = "HTTP"
	websocketProtocol    = "WEBSOCKET"
	noneAuthorization    = "NONE"
	responseStreamMode   = "RESPONSE_STREAM"
)

// assemblyManifest is the cloud assembly manifest CDK writes to manifest.json.
type assemblyManifest struct {
	Version   string                      `json:"version"`
	Artifacts map[string]assemblyArtifact `json:"artifacts"`
}

type assemblyArtifact struct {
	Type       string `json:"type"`
	Properties struct {
		TemplateFile string `json:"templateFile"`
	} `json:"properties"`
}

type template struct {
	Resources map[string]templateResource `json:"Resources"`
}

type templateResource struct {
	Type       string                     `json:"Type"`
	Properties json.RawMessage            `json:"Properties"`
	Metadata   map[string]json.RawMessage `json:"Metadata"`
}

type lambdaFunctionProperties struct {
	Runtime       string            `json:"Runtime"`
	Handler       string            `json:"Handler"`
	Architectures []string          `json:"Architectures"`
	MemorySize    json.RawMessage   `json:"MemorySize"`
	Timeout       json.RawMessage   `json:"Timeout"`
	Layers        []json.RawMessage `json:"Layers"`
	Environment   struct {
		Variables map[string]json.RawMessage `json:"Variables"`
	} `json:"Environment"`
	Code struct {
		ZipFile  string `json:"ZipFile"`
		ImageURI string `json:"ImageUri"`
	} `json:"Code"`
}

type httpAPIProperties struct {
	Name         string `json:"Name"`
	ProtocolType string `json:"ProtocolType"`
}

type httpRouteProperties struct {
	APIID             json.RawMessage `json:"ApiId"`
	RouteKey          string          `json:"RouteKey"`
	AuthorizationType string          `json:"AuthorizationType"`
	AuthorizerID      json.RawMessage `json:"AuthorizerId"`
	Target            json.RawMessage `json:"Target"`
}

type httpIntegrationProperties struct {
	IntegrationType      string          `json:"IntegrationType"`
	IntegrationURI       json.RawMessage `json:"IntegrationUri"`
	PayloadFormatVersion string          `json:"PayloadFormatVersion"`
}

type httpStageProperties struct {
	APIID     json.RawMessage `json:"ApiId"`
	StageName string          `json:"StageName"`
}

type restAPIProperties struct {
	Name string `json:"Name"`
}

type restResourceProperties struct {
	RestAPIID json.RawMessage `json:"RestApiId"`
	ParentID  json.RawMessage `json:"ParentId"`
	PathPart  string          `json:"PathPart"`
}

type restMethodProperties struct {
	RestAPIID         json.RawMessage `json:"RestApiId"`
	ResourceID        json.RawMessage `json:"ResourceId"`
	HTTPMethod        string          `json:"HttpMethod"`
	AuthorizationType string          `json:"AuthorizationType"`
	AuthorizerID      json.RawMessage `json:"AuthorizerId"`
	Integration       struct {
		Type                 string          `json:"Type"`
		URI                  json.RawMessage `json:"Uri"`
		ResponseTransferMode string          `json:"ResponseTransferMode"`
	} `json:"Integration"`
}

type restStageProperties struct {
	RestAPIID json.RawMessage `json:"RestApiId"`
	StageName string          `json:"StageName"`
}

type functionURLProperties struct {
	AuthType          string          `json:"AuthType"`
	InvokeMode        string          `json:"InvokeMode"`
	TargetFunctionARN json.RawMessage `json:"TargetFunctionArn"`
}

// logicalRef is a CloudFormation Ref or Fn::GetAtt target.
type logicalRef struct {
	ID   string
	Attr string
}

// assemblyStack is one synthesized stack after the manifest and template are
// read.
type assemblyStack struct {
	Name     string
	Template template
}

// LoadAssembly reads every CloudFormation stack template in a cloud assembly
// directory.
func loadAssembly(dir string) ([]assemblyStack, error) {
	manifestPath := filepath.Join(dir, "manifest.json")
	raw, err := os.ReadFile(manifestPath) //nolint:gosec // the path is the runner's own cloud assembly
	if err != nil {
		return nil, fmt.Errorf("read cloud assembly manifest %s: %w", manifestPath, err)
	}
	var manifest assemblyManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("parse cloud assembly manifest %s: %w", manifestPath, err)
	}
	if manifest.Version == "" {
		return nil, fmt.Errorf("cloud assembly manifest %s has no version", manifestPath)
	}

	var stacks []assemblyStack
	for name, artifact := range manifest.Artifacts {
		if artifact.Type != "aws:cloudformation:stack" || artifact.Properties.TemplateFile == "" {
			continue
		}
		templatePath := filepath.Join(dir, artifact.Properties.TemplateFile)
		body, err := os.ReadFile(templatePath) //nolint:gosec // the path comes from the assembly manifest
		if err != nil {
			return nil, fmt.Errorf("read stack template %s: %w", templatePath, err)
		}
		var parsed template
		if err := json.Unmarshal(body, &parsed); err != nil {
			return nil, fmt.Errorf("parse stack template %s: %w", templatePath, err)
		}
		stacks = append(stacks, assemblyStack{Name: name, Template: parsed})
	}
	if len(stacks) == 0 {
		return nil, fmt.Errorf("cloud assembly %s contains no CloudFormation stacks", dir)
	}
	sort.Slice(stacks, func(i, j int) bool { return stacks[i].Name < stacks[j].Name })
	return stacks, nil
}

// Derive turns a cloud assembly into the local runner's specification. It fails
// closed on any construct the transport cannot serve faithfully.
func deriveSpec(dir string, stacks []assemblyStack) (*Spec, error) {
	spec := &Spec{AssemblyDir: dir}
	for _, stack := range stacks {
		if err := deriveStack(spec, dir, stacks, stack); err != nil {
			return nil, err
		}
	}
	deriveSkipped(spec)
	if err := validateServedFunctions(spec); err != nil {
		return nil, err
	}
	if len(spec.ServedFunctions()) == 0 {
		return nil, fmt.Errorf(
			"cloud assembly %s defines no HTTP API v2 route, REST API v1 route or Function URL the local runner can serve",
			dir,
		)
	}
	spec.sort()
	return spec, nil
}

// validateServedFunctions fails closed on a function the transport cannot run
// faithfully, before any container starts.
func validateServedFunctions(spec *Spec) error {
	for _, id := range spec.ServedFunctions() {
		function, ok := spec.Function(id)
		if !ok {
			return fmt.Errorf("assembly references function %q but defines no such resource", id)
		}
		if _, err := RuntimeClass(function.Runtime); err != nil {
			return fmt.Errorf("function %s: %w", id, err)
		}
		if function.CodeProblem != "" {
			return unsupported(id, "%s", function.CodeProblem)
		}
		if function.LayerCount > 0 {
			return unsupported(id, "function uses %d Lambda layer(s); the local runner does not assemble layers", function.LayerCount)
		}
		if len(function.UnresolvedEnvironment) > 0 {
			return unsupported(
				id,
				"environment variables %s are CloudFormation expressions; the local runner only injects literal values",
				strings.Join(function.UnresolvedEnvironment, ", "),
			)
		}
		if err := unresolvedLimitsError(function); err != nil {
			return err
		}
	}
	return nil
}

// unresolvedLimitsError refuses to run a function whose MemorySize or Timeout
// is a CloudFormation expression. Falling back to the AWS defaults would give
// the handler less memory or a shorter timeout than the deployed function.
func unresolvedLimitsError(function FunctionSpec) error {
	var unresolved []string
	if function.UnresolvedMemorySize {
		unresolved = append(unresolved, "MemorySize")
	}
	if function.UnresolvedTimeout {
		unresolved = append(unresolved, "Timeout")
	}
	if len(unresolved) == 0 {
		return nil
	}
	return unsupported(
		function.LogicalID,
		"properties %s are CloudFormation expressions; the local runner only uses literal values",
		strings.Join(unresolved, ", "),
	)
}

func (s *Spec) sort() {
	sort.Slice(s.Functions, func(i, j int) bool { return s.Functions[i].LogicalID < s.Functions[j].LogicalID })
	sort.Slice(s.APIs, func(i, j int) bool {
		if s.APIs[i].Class != s.APIs[j].Class {
			return s.APIs[i].Class < s.APIs[j].Class
		}
		return s.APIs[i].LogicalID < s.APIs[j].LogicalID
	})
	sort.Slice(s.FunctionURLs, func(i, j int) bool {
		return s.FunctionURLs[i].LogicalID < s.FunctionURLs[j].LogicalID
	})
	sort.Slice(s.Skipped, func(i, j int) bool { return s.Skipped[i].LogicalID < s.Skipped[j].LogicalID })
}

func deriveStack(spec *Spec, assemblyDir string, stacks []assemblyStack, stack assemblyStack) error {
	if err := deriveFunctions(spec, assemblyDir, stacks, stack); err != nil {
		return err
	}
	if err := deriveHTTPAPIs(spec, stacks, stack); err != nil {
		return err
	}
	if err := deriveRESTAPIs(spec, stacks, stack); err != nil {
		return err
	}
	return deriveFunctionURLs(spec, stacks, stack)
}

// qualify makes a logical id unique across stacks. Single-stack assemblies keep
// the plain logical id, which is what most apps have.
func qualify(stacks []assemblyStack, stack, logicalID string) string {
	if len(stacks) <= 1 {
		return logicalID
	}
	return stack + "/" + logicalID
}

func (s assemblyStack) resourceTypes() map[string]string {
	types := make(map[string]string, len(s.Template.Resources))
	for id, resource := range s.Template.Resources {
		types[id] = resource.Type
	}
	return types
}

func deriveFunctions(spec *Spec, assemblyDir string, stacks []assemblyStack, stack assemblyStack) error {
	for _, id := range sortedKeys(stack.Template.Resources) {
		resource := stack.Template.Resources[id]
		if resource.Type != typeLambdaFunction {
			continue
		}
		function, err := parseFunction(assemblyDir, stack, id, resource)
		if err != nil {
			return err
		}
		function.LogicalID = qualify(stacks, stack.Name, id)
		spec.Functions = append(spec.Functions, function)
	}
	return nil
}

func parseFunction(assemblyDir string, stack assemblyStack, id string, resource templateResource) (FunctionSpec, error) {
	var props lambdaFunctionProperties
	if err := json.Unmarshal(resource.Properties, &props); err != nil {
		return FunctionSpec{}, fmt.Errorf("%s/%s: parse function properties: %w", stack.Name, id, err)
	}
	memoryMB, memoryResolved := decodeInt(props.MemorySize, 128)
	timeout, timeoutResolved := decodeInt(props.Timeout, 3)
	function := FunctionSpec{
		Stack:                stack.Name,
		Runtime:              props.Runtime,
		Handler:              props.Handler,
		Architecture:         "x86_64",
		MemoryMB:             memoryMB,
		Timeout:              timeout,
		LayerCount:           len(props.Layers),
		Environment:          map[string]string{},
		UnresolvedMemorySize: !memoryResolved,
		UnresolvedTimeout:    !timeoutResolved,
	}
	if !memoryResolved {
		function.MemorySizeExpression = intExpression(props.MemorySize)
	}
	if !timeoutResolved {
		function.TimeoutExpression = intExpression(props.Timeout)
	}
	if len(props.Architectures) > 0 {
		function.Architecture = props.Architectures[0]
	}
	if props.Code.ImageURI != "" {
		function.CodeProblem = "container-image Lambda functions (Code.ImageUri) are not supported locally"
		return function, nil
	}
	for name, raw := range props.Environment.Variables {
		value, err := decodeString(raw)
		if err != nil {
			function.UnresolvedEnvironment = append(function.UnresolvedEnvironment, name)
			continue
		}
		function.Environment[name] = value
	}
	sort.Strings(function.UnresolvedEnvironment)

	if props.Code.ZipFile != "" {
		function.InlineCode = props.Code.ZipFile
		function.InlineFile = inlineFileName(function.Runtime, function.Handler)
		if function.InlineFile == "" {
			function.CodeProblem = fmt.Sprintf(
				"inline Code.ZipFile is only supported for Node and Python runtimes, not %q",
				function.Runtime,
			)
		}
		return function, nil
	}

	assetPath, err := metadataString(resource.Metadata, assetPathMetadataKey)
	if err != nil {
		return FunctionSpec{}, fmt.Errorf("%s/%s: %w", stack.Name, id, err)
	}
	if assetPath == "" {
		function.CodeProblem = "function code has no local asset directory (aws:asset:path) and no inline Code.ZipFile"
		return function, nil
	}
	if !filepath.IsAbs(assetPath) {
		assetPath = filepath.Join(assemblyDir, assetPath)
	}
	info, err := os.Stat(assetPath)
	if err != nil {
		function.CodeProblem = fmt.Sprintf("function asset %s is unavailable: %v", assetPath, err)
		return function, nil
	}
	if !info.IsDir() {
		function.CodeProblem = fmt.Sprintf("function asset %s is not a directory", assetPath)
		return function, nil
	}
	function.AssetDir = filepath.Clean(assetPath)
	return function, nil
}

func metadataString(metadata map[string]json.RawMessage, key string) (string, error) {
	raw, ok := metadata[key]
	if !ok {
		return "", nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("metadata %q is not a string: %w", key, err)
	}
	return value, nil
}

func decodeString(raw json.RawMessage) (string, error) {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("value is not a literal string: %w", err)
	}
	return value, nil
}

// decodeInt decodes a literal integer. The fallback is used only when the
// property is absent; a CloudFormation expression is reported as unresolved so
// the caller can fail closed instead of applying the default silently.
func decodeInt(raw json.RawMessage, fallback int) (int, bool) {
	if len(raw) == 0 {
		return fallback, true
	}
	var value int
	if err := json.Unmarshal(raw, &value); err != nil {
		return fallback, false
	}
	return value, true
}

// intExpression names the CloudFormation intrinsic that kept an integer
// property from resolving. It is display-only: decodeInt's resolved flag is
// the fail-closed signal.
func intExpression(raw json.RawMessage) string {
	var expression map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &expression) != nil || len(expression) != 1 {
		return ""
	}
	for key := range expression {
		if key == "Ref" || strings.HasPrefix(key, "Fn::") {
			return key
		}
	}
	return ""
}

// inlineFileName is the file an inline handler is written to, matching the
// deployed runtime's expectation for the handler module.
func inlineFileName(runtime, handler string) string {
	module := handler
	if index := strings.Index(module, "."); index > 0 {
		module = module[:index]
	}
	if module == "" {
		return ""
	}
	switch {
	case strings.HasPrefix(runtime, "nodejs"):
		return module + ".js"
	case strings.HasPrefix(runtime, "python"):
		return module + ".py"
	default:
		return ""
	}
}
