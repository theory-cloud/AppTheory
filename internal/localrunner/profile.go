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

// Profile is the checked-in local execution profile the repo's harness and the
// local runner share. Only the sections the runner needs are read.
type Profile struct {
	DynamoDBLocal struct {
		Image string `json:"image"`
		Port  int    `json:"port"`
	} `json:"dynamodbLocal"`
	Lambda struct {
		Images map[string]ImagePin `json:"images"`
	} `json:"lambda"`
	Endpoints map[string]struct {
		Container string   `json:"container"`
		Env       []string `json:"env"`
	} `json:"endpoints"`
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
	return validateImagePin(class, pin)
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
	return validateImagePin(class, pin)
}

func validateImagePin(class string, pin ImagePin) (string, error) {
	if pin.Tag == "" {
		return "", fmt.Errorf("local profile %s has no image tag for the %s runtime", class, class)
	}
	prefix := imageTagPrefixes[class]
	if prefix != "" && !strings.HasPrefix(pin.Tag, prefix) {
		return "", fmt.Errorf(
			"local profile pins %q for the %s runtime, which is not an official %s image",
			pin.Tag,
			class,
			prefix,
		)
	}
	if !digestPattern.MatchString(pin.Digest) {
		return "", fmt.Errorf(
			"local profile image %q for the %s runtime is not pinned by digest (got %q)",
			pin.Tag,
			class,
			pin.Digest,
		)
	}
	return pin.Tag + "@" + pin.Digest, nil
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
	return []string{"AWS_ENDPOINT_URL_" + strings.ToUpper(service)}
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
