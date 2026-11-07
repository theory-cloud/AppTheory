package localrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// Seed hooks.
//
// A seed command runs after provisioning and before the run reports ready, so
// it drives the application through the same local endpoints the functions
// use: the local HTTP API, `apptheory-local invoke`, or the app's own CLI. It is
// never a backend write behind the app's back.
//
// The choice between a flag and a profile entry is deliberate: a seed command
// belongs to one run (the data a developer wants to load now), while the
// committed local profile is shared by every example and pins images and
// endpoints. `--seed` keeps that separation.

// seedTimeout bounds one seed command. A seed that has not finished in this
// window is a failed run, not a silently abandoned process.
const seedTimeout = 10 * time.Minute

// runSeed executes the configured seed command with the run's local endpoint
// environment. A non-zero exit fails the run with the command's output.
func (r *Runner) runSeed(ctx context.Context, spec *Spec) error {
	command := strings.TrimSpace(r.options.Seed)
	if command == "" {
		return nil
	}
	env := r.seedEnvironment(spec)
	names := make([]string, 0, len(env))
	for name := range env {
		names = append(names, name)
	}
	sort.Strings(names)
	r.logf("seed: running %q (endpoints: %s)", command, strings.Join(names, ", "))

	seedCtx, cancel := context.WithTimeout(ctx, seedTimeout)
	defer cancel()
	process := exec.CommandContext(seedCtx, "sh", "-c", command) //nolint:gosec // the operator supplies the seed command
	process.Dir = r.options.AppDir
	process.Env = seedProcessEnvironment(env)
	var output bytes.Buffer
	writer := io.Writer(&output)
	if r.options.Stdout != nil {
		writer = io.MultiWriter(&output, r.options.Stdout)
	}
	process.Stdout = writer
	process.Stderr = writer
	err := process.Run()
	if err == nil {
		return nil
	}
	if seedCtx.Err() != nil {
		return fmt.Errorf("seed command %q timed out after %s\n%s", command, seedTimeout, tailText(output.String(), 40))
	}
	return fmt.Errorf("seed command %q failed: %w\n%s", command, err, tailText(output.String(), 40))
}

// seedEnvironment is the documented seed interface. It carries the run's
// host-side endpoint URLs (the URLs a process on this machine calls), the
// served HTTP URLs, the data directory and the dummy credentials. It never
// carries real AWS credentials: every AWS_* name from the caller's shell is
// removed and only the run's dummy values are added.
//
//nolint:gocognit,gocyclo // one branch per endpoint family.
func (r *Runner) seedEnvironment(spec *Spec) map[string]string {
	env := map[string]string{ //nolint:gosec // the dummy static credentials the local run injects, not secrets
		"APPTHEORY_LOCAL_APP":              r.options.AppDir,
		"APPTHEORY_LOCAL_SEED":             r.options.Seed,
		"AWS_ACCESS_KEY_ID":                "dummy", //nolint:gosec // a static dummy, not a secret
		"AWS_SECRET_ACCESS_KEY":            "dummy",
		"AWS_REGION":                       LocalRegion,
		"AWS_DEFAULT_REGION":               LocalRegion,
		"AWS_EC2_METADATA_DISABLED":        "true",
		"AWS_CONFIG_FILE":                  "/dev/null",
		"AWS_SHARED_CREDENTIALS_FILE":      "/dev/null",
		"AWS_REQUEST_CHECKSUM_CALCULATION": "WHEN_REQUIRED",
		"AWS_RESPONSE_CHECKSUM_VALIDATION": "WHEN_REQUIRED",
		"APPTHEORY_LOCAL_RUNTIME":          r.RuntimeMode(),
	}
	if r.dataDir != "" {
		env["APPTHEORY_LOCAL_DATA_DIR"] = r.dataDir
	}

	hostEndpoints := map[string]string{}
	for _, backend := range r.backends {
		if backend.HostURL == "" {
			continue
		}
		for _, endpoint := range backend.Endpoints {
			hostEndpoints[endpoint.Service] = backend.HostURL
		}
	}
	if r.eventBusURL != "" {
		hostEndpoints[eventsService] = r.eventBusURL
	}
	if r.cloudFrontAPIURL != "" {
		hostEndpoints["cloudfront"] = r.cloudFrontAPIURL
	}
	if r.webSocketManagement != nil && r.webSocketManagement.URL != "" {
		hostEndpoints["apigatewaymanagementapi"] = r.webSocketManagement.URL
	}
	if r.codeBuildURL != "" {
		hostEndpoints[serviceCodeBuild] = r.codeBuildURL
	}
	if r.kmsFront != nil && r.kmsFront.hostURL != "" {
		hostEndpoints["kms"] = r.kmsFront.hostURL
	}
	for service, url := range hostEndpoints {
		env[seedEndpointEnvName(service)] = url
		for _, name := range r.profile.EndpointEnvNames(service) {
			env[name] = url
		}
	}
	if len(hostEndpoints) == 1 {
		for _, url := range hostEndpoints {
			env["AWS_ENDPOINT_URL"] = url
		}
	} else {
		env["AWS_ENDPOINT_URL"] = ClosedEndpoint
	}

	apis := make([]map[string]string, 0, len(r.apiURLs))
	keys := make([]string, 0, len(r.apiURLs))
	for logicalID := range r.apiURLs {
		keys = append(keys, logicalID)
	}
	sort.Strings(keys)
	for _, logicalID := range keys {
		url := r.apiURLs[logicalID]
		class := string(APIClass(""))
		for _, api := range spec.APIs {
			if api.LogicalID == logicalID {
				class = string(api.Class)
				break
			}
		}
		if class == "" {
			for _, urlSpec := range spec.FunctionURLs {
				if urlSpec.LogicalID == logicalID {
					class = string(APIFunctionURL)
					break
				}
			}
		}
		if class == "" {
			for _, distribution := range spec.CloudFront {
				if distribution.LogicalID == logicalID {
					class = "cloudfront"
					break
				}
			}
		}
		entry := map[string]string{"logicalId": logicalID, "class": class, "url": url}
		apis = append(apis, entry)
		env["APPTHEORY_LOCAL_URL_"+seedIDEnvName(logicalID)] = url
	}
	encoded, err := json.Marshal(apis)
	if err == nil {
		env["APPTHEORY_LOCAL_APIS"] = string(encoded)
	}
	return env
}

// seedEndpointEnvName turns a service name into its endpoint variable.
func seedEndpointEnvName(service string) string {
	return "APPTHEORY_LOCAL_ENDPOINT_" + seedIDEnvName(service)
}

// seedIDEnvName turns a service or logical id into an environment-variable-safe
// upper-case name.
func seedIDEnvName(value string) string {
	var builder strings.Builder
	for _, char := range strings.ToUpper(value) {
		switch {
		case char >= 'A' && char <= 'Z', char >= '0' && char <= '9':
			builder.WriteRune(char)
		default:
			builder.WriteByte('_')
		}
	}
	return builder.String()
}

// seedProcessEnvironment starts from the caller's PATH, HOME and locale so a
// seed script can run its own tools, then applies the run's variables. Every
// AWS_* name from the caller is dropped so a seed script can never inherit real
// credentials.
func seedProcessEnvironment(seed map[string]string) []string {
	env := map[string]string{}
	for _, entry := range os.Environ() {
		name, value, ok := strings.Cut(entry, "=")
		if !ok || strings.HasPrefix(name, "AWS_") {
			continue
		}
		env[name] = value
	}
	for name, value := range seed {
		env[name] = value
	}
	names := make([]string, 0, len(env))
	for name := range env {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]string, 0, len(names))
	for _, name := range names {
		out = append(out, name+"="+env[name])
	}
	return out
}

func tailText(text string, lines int) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "(no output)"
	}
	parts := strings.Split(trimmed, "\n")
	if len(parts) > lines {
		parts = parts[len(parts)-lines:]
	}
	return strings.Join(parts, "\n")
}
