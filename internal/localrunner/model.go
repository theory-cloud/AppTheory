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

	"github.com/theory-cloud/apptheory/v7/internal/localcloudfront"
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

	schemeHTTP  = "http"
	schemeHTTPS = "https"

	// ClosedEndpoint is the global endpoint used when no local backend is
	// configured. A connection to it is refused locally, which keeps a handler
	// that calls AWS from reaching real AWS.
	ClosedEndpoint = "http://127.0.0.1:1"

	archARM64 = "arm64"
	archAMD64 = "amd64"
	// archARM64Alias and archAMD64Alias are the CPU architecture names the
	// Lambda and CodeBuild pages and the profile pins use.
	archARM64Alias = "aarch64"
	archAMD64Alias = "x86_64"

	// FunctionURLDomainSuffix keeps synthesized Function URL events
	// distinguishable from HTTP API v2 events, which the AppTheory runtime
	// discriminates by requestContext.domainName.
	FunctionURLDomainSuffix = ".lambda-url." + LocalRegion + ".on.aws"

	// maxConcurrency is the documented local bound. Above it the runtime
	// interface emulator and Docker's port allocation become unreliable.
	maxConcurrency = 32

	// Local service names shared by the profile, event sources and readiness
	// probes. backendDynamoDB is defined with the runner's backend constants.
	backendSQS            = "sqs"
	backendKinesis        = "kinesis"
	backendSSM            = "ssm"
	backendSecretsManager = "secretsmanager"
	backendSNS            = "sns"
	backendCognito        = "cognito-idp"
	eventsService         = "events"
	defaultEventBus       = "default"
	ruleTargetFunction    = "function"
	ruleTargetSNS         = "sns"
	iteratorAtTimestamp   = "AT_TIMESTAMP"
	boolTrue              = "true"
	jsonNull              = "null"

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
	// APIWebSocket is AWS::ApiGatewayV2::Api with ProtocolType WEBSOCKET.
	APIWebSocket APIClass = "websocket"
)

// FunctionSpec is one Lambda function the assembly defines.
type FunctionSpec struct {
	LogicalID    string `json:"logicalId"`
	Stack        string `json:"stack"`
	Runtime      string `json:"runtime"`
	Handler      string `json:"handler"`
	Architecture string `json:"architecture"`
	MemoryMB     int    `json:"memoryMb"`
	Timeout      int    `json:"timeout"`
	LayerCount   int    `json:"layerCount"`
	// Layers are the resolved Lambda layers, in the template's listed order.
	// The runner extracts every layer into /opt in that order.
	Layers []LayerSpec `json:"layers,omitempty"`
	// LayerProblem names why the declared layers cannot be assembled locally.
	// A served function with one fails closed.
	LayerProblem string `json:"layerProblem,omitempty"`
	// PackageType is Image for a container-image function.
	PackageType string `json:"packageType,omitempty"`
	// ImageAsset is the Docker image asset the function's Code.ImageUri names.
	ImageAsset  *DockerImageAssetSpec `json:"imageAsset,omitempty"`
	Environment map[string]string     `json:"environment,omitempty"`
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
	// OptDir is the merged /opt directory the run materializes from the
	// function's layers. It is internal.
	OptDir     string `json:"-"`
	InlineCode string `json:"-"`
	InlineFile string `json:"inlineFile,omitempty"`
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
	// AuthorizerKind is empty for a route with no authorizer, or one of the
	// AuthorizerKind values: http-request-simple, http-jwt, lambda-request-policy,
	// rest-cognito-user-pools.
	AuthorizerKind AuthorizerKind `json:"authorizerKind,omitempty"`
	// AuthorizerRESTType is the REST API authorizer Type (TOKEN or REQUEST) for
	// a Lambda authorizer that returns an IAM policy.
	AuthorizerRESTType string `json:"authorizerRestType,omitempty"`
	// AuthorizerCacheTTLSeconds is AuthorizerResultTtlInSeconds on the run clock.
	// Zero disables the authorizer result cache.
	AuthorizerCacheTTLSeconds int `json:"authorizerCacheTtlSeconds,omitempty"`
	// AuthorizerValidationExpression is a TOKEN authorizer's
	// IdentityValidationExpression, applied to the token before the authorizer
	// runs.
	AuthorizerValidationExpression string `json:"authorizerValidationExpression,omitempty"`
	// AuthorizerPayloadFormat is an HTTP API Lambda authorizer's payload format
	// version (1.0 or 2.0).
	AuthorizerPayloadFormat string `json:"authorizerPayloadFormat,omitempty"`
	// JWTIssuer, JWTIssuerExpression and JWTAudience describe an HTTP API JWT
	// authorizer. The expression is the raw template value until the run
	// resolves it against the provisioned Cognito pool.
	JWTIssuer              string   `json:"jwtIssuer,omitempty"`
	JWTIssuerExpression    string   `json:"jwtIssuerExpression,omitempty"`
	JWTJWTests             []string `json:"-"`
	JWTAudience            []string `json:"jwtAudience,omitempty"`
	JWTAudienceExpressions []string `json:"-"`
	// JWKSURL and AcceptedIssuers are filled at run time, after the local
	// issuer is known.
	JWKSURL         string   `json:"jwksUrl,omitempty"`
	AcceptedIssuers []string `json:"acceptedIssuers,omitempty"`
	// CognitoPoolARNs are the pools a REST COGNITO_USER_POOLS authorizer names.
	CognitoPoolARNs []string `json:"cognitoPoolArns,omitempty"`
	// AuthorizationScopes are the scopes the route requires.
	AuthorizationScopes []string `json:"authorizationScopes,omitempty"`
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
	// MaximumBatchingWindowInSeconds is how long the SQS poller gathers a batch
	// before invoking the function. AWS documents 0 as the SQS default and 300
	// as the maximum; a FIFO queue does not support a batching window.
	MaximumBatchingWindowInSeconds int `json:"maximumBatchingWindowInSeconds,omitempty"`
	// FilterCriteria is the mapping's FilterCriteria object, verbatim. AWS
	// applies the patterns to the SQS record and its parsed body; a record that
	// matches no filter is deleted without invoking the function.
	FilterCriteria json.RawMessage `json:"filterCriteria,omitempty"`
	// MaximumConcurrency is ScalingConfig.MaximumConcurrency for an SQS
	// mapping: the per-mapping bound on concurrent batches (2..1000).
	MaximumConcurrency int `json:"maximumConcurrency,omitempty"`
	// FIFO, VisibilityTimeout and MaxReceiveCount describe the source queue. The
	// deliverer reads the provisioned queue's attributes at start; these fields
	// let plan and describe report the same configuration without a backend.
	FIFO              bool `json:"fifo,omitempty"`
	VisibilityTimeout int  `json:"visibilityTimeout,omitempty"`
	MaxReceiveCount   int  `json:"maxReceiveCount,omitempty"`

	// Stream mapping settings shared by DynamoDB Streams and Kinesis.
	//
	// https://docs.aws.amazon.com/lambda/latest/dg/API_EventSourceMappingConfiguration.html
	BisectBatchOnFunctionError bool `json:"bisectBatchOnFunctionError,omitempty"`
	// MaximumRetryAttempts is -1 for unlimited, which is the AWS default. The
	// RetryAttemptsSet flag distinguishes an explicit 0 (no retries) from an
	// omitted property.
	MaximumRetryAttempts int  `json:"maximumRetryAttempts,omitempty"`
	RetryAttemptsSet     bool `json:"-"`
	// MaximumRecordAgeInSeconds is -1 or omitted for unlimited.
	MaximumRecordAgeInSeconds int `json:"maximumRecordAgeInSeconds,omitempty"`
	// ParallelizationFactor is 1..10.
	ParallelizationFactor int `json:"parallelizationFactor,omitempty"`
	// TumblingWindowInSeconds is refused: no example uses it.
	TumblingWindowInSeconds int `json:"tumblingWindowInSeconds,omitempty"`
	// StartingPositionTimestamp is the Kinesis AT_TIMESTAMP value, in epoch
	// seconds.
	StartingPositionTimestamp float64 `json:"startingPositionTimestamp,omitempty"`
	// DestinationType, DestinationName and DestinationARN describe
	// DestinationConfig.OnFailure: an SQS queue or an SNS topic.
	DestinationType string `json:"destinationType,omitempty"`
	DestinationName string `json:"destinationName,omitempty"`
	DestinationARN  string `json:"destinationArn,omitempty"`
	// StreamViewType, PartitionKey and TTLAttribute describe the source table.
	StreamViewType string `json:"streamViewType,omitempty"`
	PartitionKey   string `json:"partitionKey,omitempty"`
	TTLAttribute   string `json:"ttlAttribute,omitempty"`
	// FunctionName is the target function's physical name, used in the
	// on-failure invocation record.
	FunctionName string `json:"functionName,omitempty"`
}

// SubscriptionSpec is one CloudWatch Logs subscription filter or SNS topic
// subscription. It is registered with the delivery engine and reported by plan
// and session describe. CloudWatch Logs delivery lands in E5; SNS delivery
// lands in E6.
type SubscriptionSpec struct {
	LogicalID string `json:"logicalId"`
	Stack     string `json:"stack"`
	// Kind is cloudwatch-logs or sns.
	Kind string `json:"kind"`
	// LogGroup is the log group the filter reads.
	LogGroup string `json:"logGroup,omitempty"`
	// FilterName and FilterPattern are the declared filter.
	FilterName    string `json:"filterName,omitempty"`
	FilterPattern string `json:"filterPattern,omitempty"`
	// Distribution is the CloudWatch Logs distribution, when declared.
	Distribution string `json:"distribution,omitempty"`
	// Destination is the qualified logical id of the subscription target.
	Destination string `json:"destination,omitempty"`
	// DestinationType is function or stream.
	DestinationType string `json:"destinationType,omitempty"`
	// Function is set when the destination is a Lambda function.
	Function string `json:"function,omitempty"`
	// Stream and StreamName identify the Kinesis stream a CloudWatch Logs
	// destination forwards to.
	Stream     string `json:"stream,omitempty"`
	StreamName string `json:"streamName,omitempty"`

	// Topic is the qualified logical id of the SNS topic the subscription
	// targets. TopicARN is the provider ARN when it is literal or resolved from
	// the assembly. ARN is the local subscription ARN the runner reports in
	// the Lambda record, the HTTP headers and the UnsubscribeUrl.
	Topic    string `json:"topic,omitempty"`
	TopicARN string `json:"topicArn,omitempty"`
	ARN      string `json:"arn,omitempty"`
	// Protocol is lambda, sqs, http or https.
	Protocol string `json:"protocol,omitempty"`
	// Endpoint is the qualified Lambda function or SQS queue logical id, or the
	// loopback URL of an HTTP(S) subscription.
	Endpoint string `json:"endpoint,omitempty"`
	// Queue is the qualified SQS queue for an sqs subscription.
	Queue string `json:"queue,omitempty"`
	// RawMessageDelivery is the subscription's raw message delivery setting.
	RawMessageDelivery bool `json:"rawMessageDelivery,omitempty"`
	// FilterPolicy is the declared subscription filter policy, verbatim.
	FilterPolicy json.RawMessage `json:"filterPolicy,omitempty"`
	// FilterPolicyScope is MessageAttributes (the default) or MessageBody.
	FilterPolicyScope string `json:"filterPolicyScope,omitempty"`
}

// RuleSpec is one AWS::Events::Rule. It is reported so a local session can
// build the event the rule would deliver, and it carries every target the
// runner can deliver.
type RuleSpec struct {
	LogicalID string `json:"logicalId"`
	Stack     string `json:"stack"`
	Name      string `json:"name"`
	// BusName is the event bus the rule belongs to; "default" when omitted.
	BusName  string `json:"busName,omitempty"`
	ARN      string `json:"arn"`
	Schedule string `json:"schedule,omitempty"`
	// EventPattern is the rule's declared pattern, kept verbatim.
	EventPattern json.RawMessage `json:"eventPattern,omitempty"`
	// Targets lists the Lambda function targets, in declared order. It stays a
	// function-only list so existing callers and the plan output keep their
	// contract.
	Targets []string `json:"targets,omitempty"`
	// TargetSpecs is every deliverable target with its input shaping, retry
	// policy and dead-letter configuration.
	TargetSpecs []RuleTargetSpec `json:"targetSpecs,omitempty"`
	Enabled     bool             `json:"enabled"`
}

// RuleTargetSpec is one EventBridge rule target.
type RuleTargetSpec struct {
	ID   string `json:"id,omitempty"`
	Type string `json:"type"`
	// Function, Queue and Topic are the qualified logical ids of the target.
	Function string `json:"function,omitempty"`
	Queue    string `json:"queue,omitempty"`
	Topic    string `json:"topic,omitempty"`
	// FunctionName, QueueName and TopicARN are the physical values delivery
	// needs.
	FunctionName string `json:"functionName,omitempty"`
	QueueName    string `json:"queueName,omitempty"`
	TopicARN     string `json:"topicArn,omitempty"`
	// ARN is the target's provider ARN, used in the dead-letter attributes.
	ARN string `json:"arn,omitempty"`
	// Input, InputPath and InputTransformer are mutually exclusive shaping
	// settings.
	Input            string                `json:"input,omitempty"`
	InputPath        string                `json:"inputPath,omitempty"`
	InputTransformer *RuleInputTransformer `json:"inputTransformer,omitempty"`
	// RetryPolicy governs the target attempts; a nil policy uses the AWS
	// defaults (185 attempts, 86400 seconds).
	RetryPolicy *RuleRetryPolicy `json:"retryPolicy,omitempty"`
	// DeadLetterQueue and DeadLetterQueueName describe the target DLQ.
	DeadLetterQueue     string `json:"deadLetterQueue,omitempty"`
	DeadLetterQueueName string `json:"deadLetterQueueName,omitempty"`
	// SQSMessageGroupID is SqsParameters.MessageGroupId: a literal or a JSON
	// path such as $.detail.group.
	SQSMessageGroupID string `json:"sqsMessageGroupId,omitempty"`
}

// RuleInputTransformer is a target's InputTransformer.
type RuleInputTransformer struct {
	InputPathsMap map[string]string `json:"inputPathsMap,omitempty"`
	InputTemplate string            `json:"inputTemplate"`
}

// RuleRetryPolicy is a target's RetryPolicy.
type RuleRetryPolicy struct {
	MaximumRetryAttempts     int `json:"maximumRetryAttempts"`
	MaximumEventAgeInSeconds int `json:"maximumEventAgeInSeconds"`
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

// CodeBuildProjectSpec is one AWS::CodeBuild::Project the local runner serves.
// It carries the deployed image name and the buildspec; the profile maps the
// image to a digest-pinned local build image per architecture.
type CodeBuildProjectSpec struct {
	LogicalID string `json:"logicalId"`
	Stack     string `json:"stack"`
	// Name is the local physical project name. AWS generates a name when the
	// template omits one; the runner uses resourceName's deterministic local
	// name, which is also the Ref the state-change rule's event pattern uses.
	Name string `json:"name"`
	// Image is the project's Environment.Image, for example
	// aws/codebuild/standard:7.0.
	Image string `json:"image"`
	// BuildSpec is the inline buildspec (JSON or YAML). BuildSpecPath is the
	// source-relative path form.
	BuildSpec     string `json:"buildSpec,omitempty"`
	BuildSpecPath string `json:"buildSpecPath,omitempty"`
	// SourceType is the project's Source.Type, for example NO_SOURCE.
	SourceType string `json:"sourceType,omitempty"`
	// EnvironmentVariables are the project's literal Environment.Variables.
	EnvironmentVariables map[string]string `json:"environmentVariables,omitempty"`
	Privileged           bool              `json:"privileged,omitempty"`
	TimeoutMinutes       int               `json:"timeoutMinutes,omitempty"`
	// Deviations name project features the local agent does not reproduce.
	Deviations []string `json:"deviations,omitempty"`
}

// PlannedResource is one resource the run provisions, with the local identifier
// the CDK definition determines before any backend starts.
type PlannedResource struct {
	LogicalID string `json:"logicalId"`
	Stack     string `json:"stack"`
	Type      string `json:"type"`
	LocalID   string `json:"localId"`
	// Generated is true when the provider creates the identifier at run time
	// (a KMS key id, a secret ARN suffix, a Cognito client id).
	Generated bool `json:"generated,omitempty"`
}

// Spec is everything the local runner derived from the cloud assembly.
type Spec struct {
	AssemblyDir   string             `json:"assemblyDir"`
	Functions     []FunctionSpec     `json:"functions"`
	APIs          []APISpec          `json:"apis"`
	WebSockets    []WebSocketAPISpec `json:"webSockets,omitempty"`
	FunctionURLs  []FunctionURLSpec  `json:"functionUrls"`
	EventSources  []EventSourceSpec  `json:"eventSources,omitempty"`
	Rules         []RuleSpec         `json:"rules,omitempty"`
	Subscriptions []SubscriptionSpec `json:"subscriptions,omitempty"`
	// Notifications are the S3 bucket notification configurations. Each entry is
	// one destination (function, queue, topic) or the bucket's EventBridge
	// configuration, so plan and describe report them one by one.
	Notifications []NotificationSpec `json:"notifications,omitempty"`
	// CodeBuildProjects are the AWS::CodeBuild::Project resources the runner
	// serves through AWS's local CodeBuild agent.
	CodeBuildProjects []CodeBuildProjectSpec `json:"codeBuild,omitempty"`
	Skipped           []Skipped              `json:"skipped"`
	// Delivery is the state the engine would register for every source. Plan
	// fills it; a live session reports the engine's own state instead.
	Delivery []DeliveryState `json:"delivery,omitempty"`
	// PlannedResources lists every resource the run provisions with the local
	// identifier the CDK definition fixes before a backend starts.
	PlannedResources []PlannedResource `json:"resources,omitempty"`
	// CloudFront is the delivery topology read from the assembly. A refused
	// distribution is also listed under Skipped with its reasons.
	CloudFront               []*localcloudfront.Distribution  `json:"cloudFront,omitempty"`
	CloudFrontFunctions      []*localcloudfront.Function      `json:"cloudFrontFunctions,omitempty"`
	CloudFrontKeyGroups      []*localcloudfront.KeyGroup      `json:"cloudFrontKeyGroups,omitempty"`
	CloudFrontPublicKeys     []*localcloudfront.PublicKey     `json:"cloudFrontPublicKeys,omitempty"`
	CloudFrontKeyValueStores []*localcloudfront.KeyValueStore `json:"cloudFrontKeyValueStores,omitempty"`
	// Resources is the assembly index used to resolve function environment
	// references. It is internal and not part of the plan document.
	Resources []ResourceSpec `json:"-"`
	// Templates holds each stack's parameters, conditions and mappings for the
	// intrinsic resolver. It never appears in plan output.
	Templates map[string]templateContext `json:"-"`
	// cloudFrontTopology keeps the parsed policies and function code the
	// gateway needs. It never appears in plan output.
	cloudFrontTopology *localcloudfront.Topology
	// functionURLTargets maps a qualified AWS::Lambda::Url logical id to the
	// qualified Lambda function it targets, including URLs the transport does
	// not serve. It lets the skip report name CloudFront origin functions.
	functionURLTargets map[string]string
	// functionURLModes maps a qualified AWS::Lambda::Url logical id to its
	// InvokeMode: RESPONSE_STREAM or BUFFERED (the template default).
	functionURLModes map[string]string
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
// Function URL targets, HTTP API authorizers, enabled event-source consumers,
// enabled EventBridge rule targets and Lambda log-subscription destinations. It
// is the local run's function set.
//
//nolint:gocyclo // one explicit branch per supported provider value.
func (s *Spec) RuntimeFunctions() []string { //nolint:gocyclo // one explicit loop per derived source kind.
	seen := map[string]struct{}{}
	for _, id := range s.ServedFunctions() {
		seen[id] = struct{}{}
	}
	for _, id := range s.CloudFrontOriginFunctions() {
		seen[id] = struct{}{}
	}
	for _, id := range s.CloudFrontEdgeFunctions() {
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
	for _, subscription := range s.Subscriptions {
		if subscription.Function != "" {
			seen[subscription.Function] = struct{}{}
		}
	}
	for _, notification := range s.Notifications {
		if notification.DestinationType == notificationDestinationFunction && notification.Destination != "" {
			seen[notification.Destination] = struct{}{}
		}
	}
	for id := range webSocketRouteFunctionSet(s) {
		seen[id] = struct{}{}
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
// unsupported property refused it. The runner registers an origin
// implementation for every origin of such a distribution.
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

// LayerSpec is one Lambda layer a function declares.
type LayerSpec struct {
	LogicalID string `json:"logicalId"`
	// AssetDir is the layer content directory the cloud assembly holds.
	AssetDir string `json:"-"`
}

// DockerImageAssetSpec is the CDK Docker image asset a container-image
// function's Code.ImageUri names. It comes from the function resource's
// aws:asset:* metadata, the same assembly the zip functions read.
type DockerImageAssetSpec struct {
	// Hash is the content hash CDK put in the image URI.
	Hash string `json:"hash"`
	// Directory, DockerFile, BuildArgs and Target describe the local build.
	Directory  string            `json:"-"`
	DockerFile string            `json:"dockerFile,omitempty"`
	BuildArgs  map[string]string `json:"buildArgs,omitempty"`
	Target     string            `json:"target,omitempty"`
	Platform   string            `json:"platform,omitempty"`
}
