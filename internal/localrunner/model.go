// Package localrunner derives an HTTP surface from a synthesized AWS CDK cloud
// assembly and serves it from the app's real Lambda handlers running in the
// official AWS Lambda runtime images.
//
// The cloud assembly is the only routing definition: functions, HTTP API v2
// routes, REST API v1 resources and Function URLs are read from the templates
// the app already deploys. Nothing here calls AWS; every function container is
// started with static dummy credentials, closed DNS and endpoint overrides that
// point at the local profile.
package localrunner

import (
	"fmt"
	"sort"
	"strings"
)

const (
	// LocalAccountID and LocalRegion are the fixed values every synthesized
	// event carries. They are syntactically valid AWS values, so handlers that
	// validate them behave as they would in a deployment.
	LocalAccountID = "123456789012"
	LocalRegion    = "us-east-1"
	LocalPartition = "aws"

	// LocalStageName is the stage the local transport reports when an API has
	// no explicit stage resource.
	LocalStageName = "$default"

	// ClosedDNSServer points function containers at an address that answers no
	// DNS query. Anything the runner does not add to /etc/hosts fails to
	// resolve, so an SDK cannot reach a real AWS endpoint.
	ClosedDNSServer = "127.0.0.2"

	// ClosedEndpoint is the global endpoint used when no local backend is
	// configured. A connection to it is refused locally, which keeps a handler
	// that calls AWS from reaching real AWS.
	ClosedEndpoint = "http://127.0.0.1:1"

	archARM64 = "arm64"
	archAMD64 = "amd64"

	// FunctionURLDomainSuffix keeps synthesized Function URL events
	// distinguishable from HTTP API v2 events, which the AppTheory runtime
	// discriminates by requestContext.domainName.
	FunctionURLDomainSuffix = ".lambda-url." + LocalRegion + ".on.aws"

	// maxConcurrency is the documented local bound. Above it the runtime
	// interface emulator and Docker's port allocation become unreliable.
	maxConcurrency = 32
)

// APIClass names a supported HTTP surface kind.
type APIClass string

const (
	// APIHTTPV2 is AWS::ApiGatewayV2::Api with ProtocolType HTTP.
	APIHTTPV2 APIClass = "httpv2"
	// APIRESTV1 is AWS::ApiGateway::RestApi.
	APIRESTV1 APIClass = "restv1"
	// APIFunctionURL is AWS::Lambda::Url.
	APIFunctionURL APIClass = "fnurl"
)

// FunctionSpec is one Lambda function the assembly defines.
type FunctionSpec struct {
	LogicalID    string            `json:"logicalId"`
	Stack        string            `json:"stack"`
	Runtime      string            `json:"runtime"`
	Handler      string            `json:"handler"`
	Architecture string            `json:"architecture"`
	MemoryMB     int               `json:"memoryMb"`
	Timeout      int               `json:"timeout"`
	LayerCount   int               `json:"layerCount"`
	Environment  map[string]string `json:"environment,omitempty"`
	// UnresolvedEnvironment lists environment names whose template value is a
	// CloudFormation expression. A served function with one of these fails
	// closed instead of inventing a value.
	UnresolvedEnvironment []string `json:"unresolvedEnvironment,omitempty"`
	AssetDir              string   `json:"assetDir,omitempty"`
	InlineCode            string   `json:"-"`
	InlineFile            string   `json:"inlineFile,omitempty"`
	// CodeProblem is set when the function's code cannot be resolved locally.
	// Only a served function fails the run because of it; an event-source
	// function that the transport never invokes is reported, not blocking.
	CodeProblem string `json:"codeProblem,omitempty"`
}

// Route is one HTTP route bound to a function.
type Route struct {
	Class     APIClass `json:"class"`
	Method    string   `json:"method"`
	Path      string   `json:"path"`
	Function  string   `json:"function"`
	Streaming bool     `json:"streaming"`
	// RouteKey is the API Gateway v2 route key, kept verbatim from the
	// template. REST v1 and Function URL routes leave it empty.
	RouteKey string `json:"routeKey,omitempty"`
}

// APISpec is one supported HTTP surface.
type APISpec struct {
	Class     APIClass `json:"class"`
	LogicalID string   `json:"logicalId"`
	Stack     string   `json:"stack"`
	Name      string   `json:"name"`
	Stage     string   `json:"stage"`
	Routes    []Route  `json:"routes"`
	Streaming bool     `json:"streaming"`
}

// FunctionURLSpec is one Lambda Function URL.
type FunctionURLSpec struct {
	LogicalID string `json:"logicalId"`
	Stack     string `json:"stack"`
	Function  string `json:"function"`
	Streaming bool   `json:"streaming"`
}

// Skipped is a construct the assembly defines that the local transport does not
// serve. It is always reported, never silently dropped.
type Skipped struct {
	LogicalID string `json:"logicalId"`
	Kind      string `json:"kind"`
	Reason    string `json:"reason"`
}

// Spec is everything the local runner derived from the cloud assembly.
type Spec struct {
	AssemblyDir  string            `json:"assemblyDir"`
	Functions    []FunctionSpec    `json:"functions"`
	APIs         []APISpec         `json:"apis"`
	FunctionURLs []FunctionURLSpec `json:"functionUrls"`
	Skipped      []Skipped         `json:"skipped"`
}

// RuntimeClass maps a Lambda runtime name to the image class the profile pins.
func RuntimeClass(runtime string) (string, error) {
	switch {
	case runtime == "provided.al2023" || runtime == "provided.al2":
		return imageClassGo, nil
	case strings.HasPrefix(runtime, "nodejs"):
		return imageClassNode, nil
	case strings.HasPrefix(runtime, "python"):
		return imageClassPython, nil
	default:
		return "", unsupported("runtime", "%q is not supported locally", runtime)
	}
}

// Function returns the function spec for a logical id.
func (s *Spec) Function(logicalID string) (FunctionSpec, bool) {
	for _, function := range s.Functions {
		if function.LogicalID == logicalID {
			return function, true
		}
	}
	return FunctionSpec{}, false
}

// ServedFunctions returns the logical ids any supported surface targets, in
// sorted order.
func (s *Spec) ServedFunctions() []string {
	seen := map[string]struct{}{}
	for _, api := range s.APIs {
		for _, route := range api.Routes {
			seen[route.Function] = struct{}{}
		}
	}
	for _, url := range s.FunctionURLs {
		seen[url.Function] = struct{}{}
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// FunctionURLsFor returns the Function URL surfaces bound to one function.
func (s *Spec) FunctionURLsFor(function string) []FunctionURLSpec {
	var out []FunctionURLSpec
	for _, url := range s.FunctionURLs {
		if url.Function == function {
			out = append(out, url)
		}
	}
	return out
}

// HTTPAPIs returns the API surfaces the transport binds to a listener.
func (s *Spec) HTTPAPIs() []APISpec {
	var out []APISpec
	for _, api := range s.APIs {
		if len(api.Routes) > 0 {
			out = append(out, api)
		}
	}
	return out
}

// UnsupportedError reports a construct the local runner refuses to guess about.
type UnsupportedError struct {
	Construct string
	Reason    string
}

func (e *UnsupportedError) Error() string {
	return fmt.Sprintf("%s: %s", e.Construct, e.Reason)
}

func unsupported(construct, format string, args ...any) error {
	return &UnsupportedError{Construct: construct, Reason: fmt.Sprintf(format, args...)}
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
