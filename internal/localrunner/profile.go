package localrunner

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// Runtime image classes the local profile pins.
const (
	imageClassGo     = "go"
	imageClassNode   = "node"
	imageClassPython = "python"
)

// imageTagPrefixes is the official Lambda image each runtime class must use.
// A profile that pins the wrong image for a runtime fails closed instead of
// starting a container that cannot load the handler.
var imageTagPrefixes = map[string]string{
	imageClassGo:     "public.ecr.aws/lambda/provided:",
	imageClassNode:   "public.ecr.aws/lambda/nodejs:",
	imageClassPython: "public.ecr.aws/lambda/python:",
}

var digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// ImagePin is one digest-pinned Lambda runtime image in the local profile.
type ImagePin struct {
	Tag    string `json:"tag"`
	Digest string `json:"digest"`
	Pinned string `json:"pinned"`
}

// ContainerPin is one digest-pinned local emulator container.
type ContainerPin struct {
	Image         string            `json:"image"`
	Command       []string          `json:"command,omitempty"`
	ContainerPort int               `json:"containerPort"`
	Environment   map[string]string `json:"environment,omitempty"`
	// Mounts are profile-declared bind mounts (host:container[:ro]).
	Mounts []string `json:"mounts,omitempty"`
}

// CodeBuildImagePin is one digest-pinned CodeBuild image (the local agent or a
// curated build image). CompressedBytes is the public registry's compressed
// size, recorded so the docs can state the colima disk requirement without a
// pull.
type CodeBuildImagePin struct {
	Tag             string `json:"tag"`
	Digest          string `json:"digest"`
	Pinned          string `json:"pinned"`
	License         string `json:"license,omitempty"`
	CompressedBytes int64  `json:"compressedBytes,omitempty"`
}

// Profile is the checked-in local execution profile the repo's harness and the
// local runner share. Only the sections the runner needs are read.
type Profile struct {
	DynamoDBLocal struct {
		Image string `json:"image"`
		Port  int    `json:"port"`
	} `json:"dynamodbLocal"`
	// Containers are the digest-pinned local emulators the runner can start
	// with --backend. dynamodbLocal remains the DynamoDB Local shortcut.
	Containers map[string]ContainerPin `json:"containers"`
	Lambda     struct {
		Images map[string]ImagePin `json:"images"`
	} `json:"lambda"`
	Endpoints map[string]struct {
		Container string   `json:"container"`
		Env       []string `json:"env"`
	} `json:"endpoints"`
	// CodeBuild pins the local agent and the curated build images. Images is
	// keyed by the deployed Environment.Image and then by host architecture
	// (aarch64 or x86_64), because AWS publishes different curated images per
	// architecture.
	CodeBuild struct {
		Agent  map[string]CodeBuildImagePin            `json:"agent"`
		Images map[string]map[string]CodeBuildImagePin `json:"images"`
	} `json:"codeBuild"`
	path string
}

// LoadProfile reads a local execution profile.
func LoadProfile(path string) (*Profile, error) {
	raw, err := os.ReadFile(path) //nolint:gosec // the caller supplies the checked-in profile path
	if err != nil {
		return nil, fmt.Errorf("read local profile %s: %w", path, err)
	}
	var document struct {
		Profile *Profile `json:"profile"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, fmt.Errorf("parse local profile %s: %w", path, err)
	}
	profile := document.Profile
	if profile == nil {
		profile = &Profile{}
		if err := json.Unmarshal(raw, profile); err != nil {
			return nil, fmt.Errorf("parse local profile %s: %w", path, err)
		}
	}
	profile.path = path
	return profile, nil
}

// Path returns the profile file the runner loaded.
func (p *Profile) Path() string {
	if p == nil {
		return ""
	}
	return p.path
}

// DynamoDBImage returns the digest-pinned DynamoDB Local image.
func (p *Profile) DynamoDBImage() (string, error) {
	if p == nil {
		return "", fmt.Errorf("no local profile was supplied; pass --profile to pin DynamoDB Local")
	}
	image := p.DynamoDBLocal.Image
	if image == "" {
		return "", fmt.Errorf("local profile %s pins no DynamoDB Local image", p.path)
	}
	_, digest, ok := strings.Cut(image, "@")
	if !ok || !digestPattern.MatchString(digest) {
		return "", fmt.Errorf("DynamoDB Local image %q is not pinned by digest", image)
	}
	return image, nil
}

// Container returns the digest-pinned emulator container a --backend name
// selects. "dynamodb-local" falls back to the legacy dynamodbLocal section so
// an A3a profile keeps working unchanged.
func (p *Profile) Container(name string) (ContainerPin, error) {
	if p == nil {
		return ContainerPin{}, fmt.Errorf("no local profile was supplied; pass --profile to pin the %s backend", name)
	}
	if pin, ok := p.Containers[name]; ok && strings.TrimSpace(pin.Image) != "" {
		_, digest, hasDigest := strings.Cut(pin.Image, "@")
		if !hasDigest || !digestPattern.MatchString(digest) {
			return ContainerPin{}, fmt.Errorf("backend %s image %q is not pinned by digest", name, pin.Image)
		}
		if pin.ContainerPort <= 0 {
			return ContainerPin{}, fmt.Errorf("backend %s has no containerPort", name)
		}
		return pin, nil
	}
	if name == backendDynamoDBName {
		image, err := p.DynamoDBImage()
		if err != nil {
			return ContainerPin{}, err
		}
		return ContainerPin{
			Image:         image,
			Command:       []string{"-jar", "DynamoDBLocal.jar", "-sharedDb", "-inMemory"},
			ContainerPort: 8000,
		}, nil
	}
	return ContainerPin{}, fmt.Errorf("local profile %s does not define the %s backend", p.path, name)
}

// EndpointsForContainer returns the endpoints the profile binds to a container.
// The URL uses the container name, which resolves only inside the run network.
func (p *Profile) EndpointsForContainer(name string) []Endpoint {
	if p == nil {
		return nil
	}
	pin, err := p.Container(name)
	if err != nil {
		return nil
	}
	var out []Endpoint
	for service, endpoint := range p.Endpoints {
		if endpoint.Container != name {
			continue
		}
		out = append(out, Endpoint{
			Service: service,
			URL:     fmt.Sprintf("http://%s:%d", name, pin.ContainerPort),
		})
	}
	return out
}

// ImageFor returns the digest-pinned image for a Lambda runtime.
func (p *Profile) ImageFor(runtime string) (string, error) {
	class, err := RuntimeClass(runtime)
	if err != nil {
		return "", err
	}
	if p == nil {
		return "", fmt.Errorf(
			"runtime %q needs the %s Lambda image, but no local profile was supplied; pass --profile",
			runtime,
			class,
		)
	}
	pin, ok := p.Lambda.Images[class]
	if !ok {
		return "", fmt.Errorf("local profile %s pins no %s Lambda image", p.path, class)
	}
	return p.validateImagePin(class, pin)
}

// ImageForClass returns the digest-pinned image for an image class (go, node or
// python).
func (p *Profile) ImageForClass(class string) (string, error) {
	if p == nil {
		return "", fmt.Errorf("no local profile was supplied; pass --profile to pin the Lambda runtime images")
	}
	pin, ok := p.Lambda.Images[class]
	if !ok {
		return "", fmt.Errorf("local profile %s pins no %s Lambda image", p.path, class)
	}
	return p.validateImagePin(class, pin)
}

func (p *Profile) validateImagePin(class string, pin ImagePin) (string, error) {
	if pin.Tag == "" {
		return "", fmt.Errorf("local profile %s has no image tag for the %s runtime", p.path, class)
	}
	prefix := imageTagPrefixes[class]
	if prefix != "" && !strings.HasPrefix(pin.Tag, prefix) {
		return "", fmt.Errorf(
			"local profile %s pins %q for the %s runtime, which is not an official %s image",
			p.path,
			pin.Tag,
			class,
			prefix,
		)
	}
	if !digestPattern.MatchString(pin.Digest) {
		return "", fmt.Errorf(
			"local profile %s image %q for the %s runtime is not pinned by digest (got %q)",
			p.path,
			pin.Tag,
			class,
			pin.Digest,
		)
	}
	return pin.Tag + "@" + pin.Digest, nil
}

// CodeBuildAgent returns the digest-pinned local CodeBuild agent for an
// architecture. AWS publishes the x86_64 agent as :latest and the ARM agent as
// :aarch64.
func (p *Profile) CodeBuildAgent(arch string) (string, error) {
	if p == nil {
		return "", fmt.Errorf("no local profile was supplied; pass --profile to pin the CodeBuild agent")
	}
	if len(p.CodeBuild.Agent) == 0 {
		return "", fmt.Errorf("local profile %s pins no CodeBuild agent", p.path)
	}
	pin, ok := p.CodeBuild.Agent[codeBuildArch(arch)]
	if !ok {
		return "", fmt.Errorf("local profile %s pins no %s CodeBuild agent", p.path, codeBuildArch(arch))
	}
	return validateCodeBuildPin(p.path, "CodeBuild agent", pin)
}

// CodeBuildImage maps a project's Environment.Image to the profile's pinned
// local build image for the host architecture.
func (p *Profile) CodeBuildImage(arch, image string) (string, error) {
	if p == nil {
		return "", fmt.Errorf("no local profile was supplied; pass --profile to pin the CodeBuild build image")
	}
	image = strings.TrimSpace(image)
	if image == "" {
		return "", fmt.Errorf("the CodeBuild project declares no Environment.Image")
	}
	byArch, ok := p.CodeBuild.Images[image]
	if !ok {
		return "", fmt.Errorf(
			"local profile %s does not map the CodeBuild image %q; add a codeBuild.images entry with a digest per architecture",
			p.path, image,
		)
	}
	pin, ok := byArch[codeBuildArch(arch)]
	if !ok {
		return "", fmt.Errorf(
			"local profile %s maps %q but pins no %s image; AWS publishes per-architecture curated images",
			p.path, image, codeBuildArch(arch),
		)
	}
	return validateCodeBuildPin(p.path, "CodeBuild image "+image, pin)
}

func validateCodeBuildPin(profilePath, label string, pin CodeBuildImagePin) (string, error) {
	if strings.TrimSpace(pin.Tag) == "" {
		return "", fmt.Errorf("local profile %s has no %s tag", profilePath, label)
	}
	if !strings.HasPrefix(pin.Tag, "public.ecr.aws/codebuild/") {
		return "", fmt.Errorf(
			"local profile %s pins %q for %s, which is not a public.ecr.aws/codebuild image",
			profilePath, pin.Tag, label,
		)
	}
	if !digestPattern.MatchString(pin.Digest) {
		return "", fmt.Errorf(
			"local profile %s pins %s %q without a digest (got %q)",
			profilePath, label, pin.Tag, pin.Digest,
		)
	}
	return pin.Tag + "@" + pin.Digest, nil
}

func codeBuildArch(arch string) string {
	switch strings.ToLower(strings.TrimSpace(arch)) {
	case "arm64", archARM64Alias:
		return archARM64Alias
	default:
		return archAMD64Alias
	}
}

// EndpointEnvNames returns the environment variable names the profile binds to
// a service's endpoint. Without a profile the AWS-standard service override is
// used.
func (p *Profile) EndpointEnvNames(service string) []string {
	if p != nil {
		if endpoint, ok := p.Endpoints[service]; ok && len(endpoint.Env) > 0 {
			return append([]string(nil), endpoint.Env...)
		}
	}
	return defaultEndpointEnvNames(service)
}

// defaultEndpointEnvNames maps an AWS service name to the SDK's
// service-specific endpoint override. Most services use the upper-cased service
// name; Secrets Manager and Cognito Identity Provider use their documented
// environment variable names:
// https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html
func defaultEndpointEnvNames(service string) []string {
	switch strings.ToLower(strings.TrimSpace(service)) {
	case eventsService:
		// EventBridge's API-model serviceId is EventBridge. The AWS SDKs and
		// Tools reference names the service-specific override from that id
		// (AWS_ENDPOINT_URL_EVENTBRIDGE); the runner also sets the shorter
		// AWS_ENDPOINT_URL_EVENTS name the wave-2 packet names, so either
		// spelling reaches the local bus.
		return []string{"AWS_ENDPOINT_URL_EVENTS", "AWS_ENDPOINT_URL_EVENTBRIDGE", "EVENTS_ENDPOINT"}
	case backendSecretsManager:
		return []string{"AWS_ENDPOINT_URL_SECRETS_MANAGER"}
	case backendCognito:
		return []string{
			// The AWS SDK for JavaScript, Go and Python resolve the Cognito
			// Identity Provider override under the service's long name; the
			// short form is accepted too so a handler can use either spelling.
			"AWS_ENDPOINT_URL_COGNITO_IDENTITY_PROVIDER",
			"AWS_ENDPOINT_URL_COGNITO_IDP",
		}
	default:
		return []string{"AWS_ENDPOINT_URL_" + strings.ToUpper(service)}
	}
}

// handlerArgument is the command the runtime image entrypoint receives. The
// provided runtime requires the bootstrap name; the managed runtimes take the
// handler string from the template.
func handlerArgument(function FunctionSpec) (string, error) {
	class, err := RuntimeClass(function.Runtime)
	if err != nil {
		return "", err
	}
	if class == imageClassGo {
		if function.Handler == "" {
			return "bootstrap", nil
		}
		return function.Handler, nil
	}
	if function.Handler == "" {
		return "", unsupported(function.LogicalID, "function %q has no Handler", function.Runtime)
	}
	return function.Handler, nil
}
