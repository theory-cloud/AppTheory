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
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/theory-cloud/apptheory/v6/internal/localcloudfront"
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

	// Local service names shared by the profile, event sources and readiness
	// probes. backendDynamoDB is defined with the runner's backend constants.
	backendSQS     = "sqs"
	backendKinesis = "kinesis"
	boolTrue       = "true"

	streamEventInsert = "INSERT"
	streamEventModify = "MODIFY"
	streamEventRemove = "REMOVE"
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
	// CloudFormation expression. The runner resolves the supported references
	// before a function starts; one it cannot resolve fails closed.
	UnresolvedEnvironment []string `json:"unresolvedEnvironment,omitempty"`
	// EnvironmentExpressions holds the raw CloudFormation expression behind
	// each unresolved name. It is internal: the runner resolves it to a local
	// value and never prints it.
	EnvironmentExpressions map[string]string `json:"-"`
	// UnresolvedMemorySize and UnresolvedTimeout report that the template value
	// is a CloudFormation expression. A served function with one of these fails
	// closed instead of silently applying the AWS default.
	UnresolvedMemorySize bool `json:"unresolvedMemorySize,omitempty"`
	UnresolvedTimeout    bool `json:"unresolvedTimeout,omitempty"`
	// MemorySizeExpression and TimeoutExpression name the intrinsic (Ref,
	// Fn::If, ...) behind an unresolved limit. They are display-only; the
	// Unresolved* flags remain the fail-closed signals.
	MemorySizeExpression string `json:"memorySizeExpression,omitempty"`
	TimeoutExpression    string `json:"timeoutExpression,omitempty"`
	AssetDir             string `json:"assetDir,omitempty"`
	InlineCode           string `json:"-"`
	InlineFile           string `json:"inlineFile,omitempty"`
	// CodeProblem is set when the function's code cannot be resolved locally.
	// Only a served function fails the run because of it; an event-source
	// function that the transport never invokes is reported, not blocking.
	CodeProblem string `json:"codeProblem,omitempty"`
}

// MockResponse is a REST API MOCK integration: the template declares the
// status and headers the transport returns instead of invoking a function. CDK
// uses it for CORS preflight.
type MockResponse struct {
	StatusCode int               `json:"statusCode"`
	Headers    map[string]string `json:"headers,omitempty"`
}

// Route is one HTTP route bound to a function.
type Route struct {
	Class    APIClass `json:"class"`
	Method   string   `json:"method"`
	Path     string   `json:"path"`
	Function string   `json:"function,omitempty"`
	// AuthorizerFunction is the Lambda function a CUSTOM HTTP API authorizer
	// invokes before the route handler. The transport runs it; a route with an
	// authorizer is never served without it.
	AuthorizerFunction string `json:"authorizerFunction,omitempty"`
	// AuthorizerIdentitySources lists the provider identity sources the
	// authorizer event carries, in configured order, for example
	// $request.header.Authorization. The transport refuses a request that does
	// not carry every source before invoking the authorizer.
	AuthorizerIdentitySources []string `json:"authorizerIdentitySources,omitempty"`
	// Mock is set for a REST API MOCK integration. A mock route has no
	// function and no invoker; the transport returns the declared response.
	Mock      *MockResponse `json:"mock,omitempty"`
	Streaming bool          `json:"streaming"`
	// RouteKey is the API Gateway v2 route key, kept verbatim from the
	// template. REST v1 and Function URL routes leave it empty.
	RouteKey string `json:"routeKey,omitempty"`
}

// EventSourceSpec is one AWS::Lambda::EventSourceMapping the assembly
// declares. It is reported, and its function is started, so a local session can
// receive real messages and build the provider event the mapping would deliver.
type EventSourceSpec struct {
	LogicalID string `json:"logicalId"`
	Stack     string `json:"stack"`
	Function  string `json:"function"`
	// Type is sqs, dynamodb or kinesis.
	Type string `json:"type"`
	// Source is the logical id of the queue, table or stream the mapping reads.
	Source string `json:"source"`
	// SourceName is the queue name, table name or stream name.
	SourceName string `json:"sourceName"`
	// SourceARN is the provider-shaped ARN the derived mapping reports. A
	// session builds DynamoDB stream events from the provisioned table's real
	// local stream ARN instead.
	SourceARN               string `json:"sourceArn"`
	BatchSize               int    `json:"batchSize,omitempty"`
	ReportBatchItemFailures bool   `json:"reportBatchItemFailures,omitempty"`
	Enabled                 bool   `json:"enabled"`
	StartingPosition        string `json:"startingPosition,omitempty"`
}

// RuleSpec is one AWS::Events::Rule with a Lambda target. It is reported so a
// local session can build the event the rule would deliver.
type RuleSpec struct {
	LogicalID string `json:"logicalId"`
	Stack     string `json:"stack"`
	Name      string `json:"name"`
	ARN       string `json:"arn"`
	Schedule  string `json:"schedule,omitempty"`
	// EventPattern is the rule's declared pattern, kept verbatim.
	EventPattern json.RawMessage `json:"eventPattern,omitempty"`
	Targets      []string        `json:"targets,omitempty"`
	Enabled      bool            `json:"enabled"`
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

// ResourceSpec is one template resource the runner can resolve a reference to.
type ResourceSpec struct {
	Stack      string          `json:"stack"`
	LogicalID  string          `json:"logicalId"`
	Type       string          `json:"type"`
	Properties json.RawMessage `json:"-"`
}

// Spec is everything the local runner derived from the cloud assembly.
type Spec struct {
	AssemblyDir  string            `json:"assemblyDir"`
	Functions    []FunctionSpec    `json:"functions"`
	APIs         []APISpec         `json:"apis"`
	FunctionURLs []FunctionURLSpec `json:"functionUrls"`
	EventSources []EventSourceSpec `json:"eventSources,omitempty"`
	Rules        []RuleSpec        `json:"rules,omitempty"`
	Skipped      []Skipped         `json:"skipped"`
	// CloudFront is the delivery topology read from the assembly. A refused
	// distribution is also listed under Skipped with its reasons.
	CloudFront          []*localcloudfront.Distribution `json:"cloudFront,omitempty"`
	CloudFrontFunctions []*localcloudfront.Function     `json:"cloudFrontFunctions,omitempty"`
	// Resources is the assembly index used to resolve function environment
	// references. It is internal and not part of the plan document.
	Resources []ResourceSpec `json:"-"`
	// cloudFrontTopology keeps the parsed policies and function code the
	// gateway needs. It never appears in plan output.
	cloudFrontTopology *localcloudfront.Topology
	// functionURLTargets maps a qualified AWS::Lambda::Url logical id to the
	// qualified Lambda function it targets, including URLs the transport does
	// not serve. It lets the skip report name CloudFront origin functions.
	functionURLTargets map[string]string
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

// ServedFunctions returns the logical ids any HTTP surface targets, in sorted
// order. A function that only an event source mapping or EventBridge rule
// targets is not served over HTTP; use RuntimeFunctions for everything the
// runner must start.
func (s *Spec) ServedFunctions() []string {
	seen := map[string]struct{}{}
	for _, api := range s.APIs {
		for _, route := range api.Routes {
			if route.Function == "" {
				continue
			}
			seen[route.Function] = struct{}{}
			if route.AuthorizerFunction != "" {
				seen[route.AuthorizerFunction] = struct{}{}
			}
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

// RuntimeFunctions returns every function the runner must start: HTTP route and
// Function URL targets, HTTP API authorizers, enabled event-source consumers
// and enabled EventBridge rule targets. It is the local run's function set.
func (s *Spec) RuntimeFunctions() []string {
	seen := map[string]struct{}{}
	for _, id := range s.ServedFunctions() {
		seen[id] = struct{}{}
	}
	for _, id := range s.CloudFrontOriginFunctions() {
		seen[id] = struct{}{}
	}
	for _, source := range s.EventSources {
		if source.Enabled && source.Function != "" {
			seen[source.Function] = struct{}{}
		}
	}
	for _, rule := range s.Rules {
		if !rule.Enabled {
			continue
		}
		for _, target := range rule.Targets {
			if target != "" {
				seen[target] = struct{}{}
			}
		}
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// CloudFrontOriginFunctions returns the functions the served distributions
// invoke as origins: every Function URL an origin or origin-group member
// targets. The gateway invokes the same container the runner starts for a
// standalone Function URL; an AWS_IAM URL is only reachable through the signed
// CloudFront origin path.
func (s *Spec) CloudFrontOriginFunctions() []string {
	seen := map[string]struct{}{}
	for _, distribution := range s.ServableCloudFront() {
		for _, origin := range distribution.Origins {
			if origin.FunctionURL == "" {
				continue
			}
			if functionID, ok := s.functionURLTargets[origin.FunctionURL]; ok {
				seen[functionID] = struct{}{}
			}
		}
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

// ServableCloudFront returns the distributions the gateway can serve: no
// unsupported property refused it. A servable distribution still refuses its
// origins until A5b wires them.
func (s *Spec) ServableCloudFront() []*localcloudfront.Distribution {
	var out []*localcloudfront.Distribution
	for _, distribution := range s.CloudFront {
		if distribution.Servable() {
			out = append(out, distribution)
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
