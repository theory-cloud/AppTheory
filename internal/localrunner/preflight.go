package localrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Endpoint is one local AWS emulator endpoint the runner injects into every
// function container. Service is the AWS service name the SDK override uses
// (dynamodb, sqs, s3, ...).
type Endpoint struct {
	Service string
	URL     string
}

// awsHostSuffixes are the public AWS endpoint domains. An endpoint that points
// at one of them would let a handler reach real AWS, so the runner refuses it
// before any container starts.
var awsHostSuffixes = []string{
	".amazonaws.com",
	".amazonaws.com.cn",
	".api.aws",
	".on.aws",
}

// ValidateEndpoint fails closed on an endpoint that is malformed or that points
// at AWS.
func ValidateEndpoint(endpoint Endpoint) error {
	if strings.TrimSpace(endpoint.Service) == "" {
		return fmt.Errorf("endpoint %q has no service name", endpoint.URL)
	}
	parsed, err := url.Parse(strings.TrimSpace(endpoint.URL))
	if err != nil {
		return fmt.Errorf("endpoint %s=%q: %w", endpoint.Service, endpoint.URL, err)
	}
	if parsed.Scheme != schemeHTTP && parsed.Scheme != schemeHTTPS {
		return fmt.Errorf("endpoint %s=%q must use http or https", endpoint.Service, endpoint.URL)
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return fmt.Errorf("endpoint %s=%q has no host", endpoint.Service, endpoint.URL)
	}
	for _, suffix := range awsHostSuffixes {
		if strings.HasSuffix(host, suffix) || host == strings.TrimPrefix(suffix, ".") {
			return fmt.Errorf(
				"endpoint %s=%q points at a real AWS host; the local runner only accepts local endpoints",
				endpoint.Service,
				endpoint.URL,
			)
		}
	}
	return nil
}

// PreflightResult is what the in-container probe proved.
type PreflightResult struct {
	Checks map[string]string
}

type probeOutput struct {
	OK     bool              `json:"ok"`
	Error  string            `json:"error"`
	Checks map[string]string `json:"checks"`
}

// Preflight proves, from inside a function container, that the environment the
// runner is about to hand the app cannot reach real AWS: the credentials are
// the static dummy keys, every configured endpoint resolves and answers, the
// DynamoDB SDK resolves to the local endpoint, and a real AWS hostname does not
// resolve because the container has closed DNS.
func (r *Runner) Preflight(ctx context.Context, network string, addHosts []string) (PreflightResult, error) {
	image, err := r.profile.ImageForClass(imageClassPython)
	if err != nil {
		return PreflightResult{}, fmt.Errorf("the container preflight needs the pinned Python image: %w", err)
	}
	endpoints := map[string]string{}
	for _, endpoint := range r.endpoints {
		endpoints[endpoint.Service] = endpoint.URL
	}
	encoded, err := json.Marshal(endpoints)
	if err != nil {
		return PreflightResult{}, fmt.Errorf("encode preflight endpoints: %w", err)
	}
	env := r.securityEnvironment()
	env["APPTHEORY_LOCAL_PROBE_ENDPOINTS"] = string(encoded)
	options := ContainerOptions{
		Name:       r.namePrefix + "-preflight",
		Network:    network,
		Image:      image,
		Entrypoint: "python3",
		Command:    []string{"-c", probeScript},
		Env:        env,
		AddHosts:   addHosts,
		Labels:     r.labels(),
	}
	output, runErr := r.docker.RunOnce(ctx, options)
	if runErr != nil {
		return PreflightResult{}, fmt.Errorf("container preflight failed: %w\n%s", runErr, tailLines(output, 40))
	}
	var probe probeOutput
	if err := json.Unmarshal([]byte(lastJSONLine(output)), &probe); err != nil {
		return PreflightResult{}, fmt.Errorf("container preflight returned no JSON result: %w\n%s", err, tailLines(output, 40))
	}
	if !probe.OK {
		return PreflightResult{}, fmt.Errorf("container preflight failed: %s", probe.Error)
	}
	return PreflightResult{Checks: probe.Checks}, nil
}

// securityEnvironment is the complete AWS environment every function container
// receives. Template environment is applied first and these values override it,
// so an app declaration can never redirect the container at real AWS.
func (r *Runner) securityEnvironment() map[string]string {
	env := map[string]string{ //nolint:gosec // fixed dummy credentials, never used against real AWS
		"AWS_REGION":                  LocalRegion,
		"AWS_DEFAULT_REGION":          LocalRegion,
		"AWS_ACCESS_KEY_ID":           "dummy",
		"AWS_SECRET_ACCESS_KEY":       "dummy",
		"AWS_EC2_METADATA_DISABLED":   "true",
		"AWS_CONFIG_FILE":             "/dev/null",
		"AWS_SHARED_CREDENTIALS_FILE": "/dev/null",
		// S3 emulators do not implement the SDK's default flexible-checksum
		// trailers. The SDK still validates checksums when a service requires
		// them; it stops adding them to every request.
		"AWS_REQUEST_CHECKSUM_CALCULATION": "WHEN_REQUIRED",
		"AWS_RESPONSE_CHECKSUM_VALIDATION": "WHEN_REQUIRED",
	}
	for _, endpoint := range r.endpoints {
		for _, name := range r.profile.EndpointEnvNames(endpoint.Service) {
			if name == "AWS_ENDPOINT_URL" {
				continue
			}
			env[name] = endpoint.URL
		}
	}
	// A WebSocket API's @connections management API is a runner-owned TLS
	// endpoint. Its SDK endpoint override and the CA every container trusts are
	// added here, so a handler's client reaches it with no extra configuration.
	// The documented service-specific name is the one the SDKs derive from the
	// service id ApiGatewayManagementApi.
	// https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html
	if r.webSocketManagement != nil {
		env[webSocketManagementEndpointEnv] = r.webSocketManagement.ContainerURL
		env["AWS_CA_BUNDLE"] = webSocketManagementCACertPath
		env["NODE_EXTRA_CA_CERTS"] = webSocketManagementCACertPath
		env["SSL_CERT_FILE"] = webSocketManagementCACertPath
	}
	// The global override is the single local backend when there is exactly
	// one, so SDK clients for other services also stay local; otherwise it
	// points at a closed local port and fails closed. Service-specific
	// overrides above always win.
	if len(r.endpoints) == 1 {
		env["AWS_ENDPOINT_URL"] = r.endpoints[0].URL
	} else {
		env["AWS_ENDPOINT_URL"] = ClosedEndpoint
	}
	return env
}

// functionEnvironment merges the template environment with the runner-owned
// security values and, in the default runtime mode, the reserved runtime
// environment variables the configuration page lists. The returned list names
// template variables the runner overrides, so a run reports them instead of
// silently replacing an app value.
//
// https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html#configuration-envvars-runtime
func (r *Runner) functionEnvironment(function FunctionSpec, api *runtimeAPI) (map[string]string, []string) {
	env := map[string]string{}
	for name, value := range function.Environment {
		env[name] = value
	}
	owned := r.securityEnvironment()
	for name, value := range runtimeEnvironment(function, api) {
		owned[name] = value
	}
	var overridden []string
	for name, value := range owned {
		if _, exists := env[name]; exists {
			overridden = append(overridden, name)
		}
		env[name] = value
	}
	sort.Strings(overridden)
	return env, overridden
}

// runtimeEnvironment is the reserved environment Lambda sets for a runtime.
// The values the runner cannot know (a physical function name and a deployed
// log stream) use the local identity the runner reports elsewhere.
//
// https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html#configuration-envvars-runtime
func runtimeEnvironment(function FunctionSpec, api *runtimeAPI) map[string]string {
	if api == nil {
		// RIE mode: the image's entry script sets the emulator's own values and
		// AWS_LAMBDA_RUNTIME_API must stay unset, which is what selects the
		// emulator.
		return nil
	}
	memory := function.MemoryMB
	if memory <= 0 {
		memory = 128
	}
	name := function.LogicalID
	if strings.TrimSpace(name) == "" {
		name = "function"
	}
	env := map[string]string{
		// AWS_LAMBDA_RUNTIME_API is "the host and port of the runtime API".
		// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html
		"AWS_LAMBDA_RUNTIME_API":          api.ContainerAddress(),
		"AWS_LAMBDA_FUNCTION_NAME":        name,
		"AWS_LAMBDA_FUNCTION_VERSION":     "$LATEST",
		"AWS_LAMBDA_FUNCTION_MEMORY_SIZE": strconv.Itoa(memory),
		"AWS_LAMBDA_LOG_GROUP_NAME":       "/aws/lambda/" + name,
		"AWS_LAMBDA_LOG_STREAM_NAME":      time.Now().UTC().Format("2006/01/02") + "/[$LATEST]" + name,
		"AWS_LAMBDA_INITIALIZATION_TYPE":  "on-demand",
		"LAMBDA_TASK_ROOT":                "/var/task",
		"LAMBDA_RUNTIME_DIR":              "/var/runtime",
		"TZ":                              ":UTC",
	}
	if strings.TrimSpace(function.Handler) != "" {
		env["_HANDLER"] = function.Handler
	}
	return env
}

// cloneEnvironment copies an environment map so a replacement container cannot
// mutate the configuration the previous one used.
func cloneEnvironment(env map[string]string) map[string]string {
	out := make(map[string]string, len(env))
	for name, value := range env {
		out[name] = value
	}
	return out
}

func lastJSONLine(output string) string {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		line := strings.TrimSpace(lines[index])
		if strings.HasPrefix(line, "{") {
			return line
		}
	}
	return ""
}

// probeScript runs inside the pinned Python runtime image. It is a real
// environment probe, not a handler invocation: it proves what a function
// container can reach before the app's handlers start.
const probeScript = `
import json, os, socket, sys, time, urllib.error, urllib.request
from urllib.parse import urlsplit

def emit(payload, code):
    print(json.dumps(payload, sort_keys=True))
    sys.exit(code)

def fail(message):
    emit({"ok": False, "error": message}, 1)

checks = {}
endpoints = json.loads(os.environ.get("APPTHEORY_LOCAL_PROBE_ENDPOINTS") or "{}")
if os.environ.get("AWS_ACCESS_KEY_ID") != "dummy" or os.environ.get("AWS_SECRET_ACCESS_KEY") != "dummy":
    fail("credentials are not the runner dummy static keys")
if os.environ.get("AWS_SESSION_TOKEN"):
    fail("AWS_SESSION_TOKEN is set; the runner must not hand a session token to a function")
checks["credentials"] = "dummy static"

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for service in sorted(endpoints):
    raw = endpoints[service]
    parsed = urlsplit(raw)
    host = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        fail("%s endpoint %s does not resolve from the function container: %s" % (service, host, exc))
    checks[service + ".dns"] = "resolved " + host
    status = None
    last_error = None
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            with opener.open(urllib.request.Request(raw, method="GET"), timeout=10) as response:
                status = response.status
        except urllib.error.HTTPError as exc:
            status = exc.code
        except Exception as exc:
            last_error = exc
            time.sleep(1)
            continue
        break
    if status is None:
        fail("%s endpoint %s is not reachable from the function container: %s" % (service, raw, last_error))
    checks[service + ".http"] = str(status)

for host in ("dynamodb.us-east-1.amazonaws.com", "s3.amazonaws.com", "sqs.us-east-1.amazonaws.com"):
    try:
        socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError:
        continue
    fail("real AWS host %s resolved from the function container" % host)
checks["aws_dns"] = "unresolved"

if "dynamodb" in endpoints:
    sys.path.insert(0, "/var/runtime")
    try:
        import boto3
    except Exception as exc:
        fail("the probe image cannot import boto3 for the SDK endpoint check: %s" % exc)
    client = boto3.client("dynamodb")
    resolved = client.meta.endpoint_url.rstrip("/")
    if resolved != endpoints["dynamodb"].rstrip("/"):
        fail("boto3 resolved DynamoDB to %s, not the local endpoint %s" % (resolved, endpoints["dynamodb"]))
    checks["dynamodb.sdk"] = "resolved " + resolved
    tables = None
    last_error = None
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            tables = client.list_tables()
        except Exception as exc:
            last_error = exc
            time.sleep(1)
            continue
        break
    if tables is None:
        fail("DynamoDB ListTables failed against the local endpoint: %s" % last_error)
    checks["dynamodb.list_tables"] = "%d table(s)" % len(tables.get("TableNames", []))

emit({"ok": True, "checks": checks}, 0)
`
