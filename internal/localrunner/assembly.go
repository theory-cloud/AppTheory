package localrunner

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/theory-cloud/apptheory/v7/internal/localcloudfront"
)

// Resource types the assembly reader understands.
const (
	typeLambdaFunction      = "AWS::Lambda::Function"
	typeLambdaPermission    = "AWS::Lambda::Permission"
	typeDynamoTable         = "AWS::DynamoDB::Table"
	typeSQSQueue            = "AWS::SQS::Queue"
	typeS3Bucket            = "AWS::S3::Bucket"
	typeKMSKey              = "AWS::KMS::Key"
	typeKMSAlias            = "AWS::KMS::Alias"
	typeEventsRule          = "AWS::Events::Rule"
	typeEventsBus           = "AWS::Events::EventBus"
	typeEventSourceMap      = "AWS::Lambda::EventSourceMapping"
	typeKinesisStream       = "AWS::Kinesis::Stream"
	typeLogsSubscription    = "AWS::Logs::SubscriptionFilter"
	typeLogGroup            = "AWS::Logs::LogGroup"
	typeLogsDestination     = "AWS::Logs::Destination"
	typeSecretsSecret       = "AWS::SecretsManager::Secret"         //nolint:gosec // CloudFormation resource type name, not a credential
	typeSecretsResourceRule = "AWS::SecretsManager::ResourcePolicy" //nolint:gosec // CloudFormation resource type name, not a credential
	typeSSMParameter        = "AWS::SSM::Parameter"
	typeSNSTopic            = "AWS::SNS::Topic"
	typeSNSSubscription     = "AWS::SNS::Subscription"
	typeSNSTopicPolicy      = "AWS::SNS::TopicPolicy"
	typeCognitoUserPool     = "AWS::Cognito::UserPool"
	typeCognitoClient       = "AWS::Cognito::UserPoolClient"
	typeCognitoDomain       = "AWS::Cognito::UserPoolDomain"
	typeIAMRole             = "AWS::IAM::Role"
	typeIAMPolicy           = "AWS::IAM::Policy"
	typeIAMManagedPolicy    = "AWS::IAM::ManagedPolicy"
	typeMicrovmImage        = "AWS::Lambda::MicrovmImage"
	typeS3VectorsIndex      = "AWS::S3Vectors::Index"
	typeHTTPAPI             = "AWS::ApiGatewayV2::Api"
	typeHTTPRoute           = "AWS::ApiGatewayV2::Route"
	typeHTTPIntegration     = "AWS::ApiGatewayV2::Integration"
	typeHTTPStage           = "AWS::ApiGatewayV2::Stage"
	typeHTTPAuthorizer      = "AWS::ApiGatewayV2::Authorizer"
	typeRESTAPI             = "AWS::ApiGateway::RestApi"
	typeRESTResource        = "AWS::ApiGateway::Resource"
	typeRESTMethod          = "AWS::ApiGateway::Method"
	typeRESTStage           = "AWS::ApiGateway::Stage"
	typeRESTAuthorizer      = "AWS::ApiGateway::Authorizer"
	typeFunctionURL         = "AWS::Lambda::Url"
	typeCodeBuildProject    = "AWS::CodeBuild::Project"
	typeBucketDeploy        = "Custom::CDKBucketDeployment"
	typeBucketAutoDelete    = "Custom::S3AutoDeleteObjects"
	typeCloudFront          = "AWS::CloudFront::Distribution"
	typeCloudFrontFn        = "AWS::CloudFront::Function"

	assetPathMetadataKey = "aws:asset:path"
	streamingURIMarker   = "/response-streaming-invocations"
	proxyIntegration     = "AWS_PROXY"
	mockIntegration      = "MOCK"
	httpProtocol         = "HTTP"
	websocketProtocol    = "WEBSOCKET"
	noneAuthorization    = "NONE"
	responseStreamMode   = "RESPONSE_STREAM"
	bufferedInvokeMode   = "BUFFERED"
)

// assemblyManifest is the cloud assembly manifest CDK writes to manifest.json.
type assemblyManifest struct {
	Version   string                      `json:"version"`
	Artifacts map[string]assemblyArtifact `json:"artifacts"`
}

type assemblyArtifact struct {
	Type        string `json:"type"`
	Environment string `json:"environment"`
	Properties  struct {
		TemplateFile string `json:"templateFile"`
	} `json:"properties"`
}

type template struct {
	// Parameters, Conditions and Mappings are read so a property expression
	// that depends only on the template (a parameter default, a condition over
	// defaults, or a mapping) resolves without a deployed stack.
	// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/parameters-section-structure.html
	Parameters map[string]templateParameter         `json:"Parameters"`
	Conditions map[string]json.RawMessage           `json:"Conditions"`
	Mappings   map[string]map[string]map[string]any `json:"Mappings"`
	Resources  map[string]templateResource          `json:"Resources"`
}

type templateParameter struct {
	Type          string            `json:"Type"`
	Default       json.RawMessage   `json:"Default"`
	AllowedValues []json.RawMessage `json:"AllowedValues"`
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
	PackageType   string            `json:"PackageType"`
	Environment   struct {
		Variables map[string]json.RawMessage `json:"Variables"`
	} `json:"Environment"`
	Code struct {
		ZipFile  string          `json:"ZipFile"`
		ImageURI json.RawMessage `json:"ImageUri"`
	} `json:"Code"`
}

type httpAPIProperties struct {
	Name         string `json:"Name"`
	ProtocolType string `json:"ProtocolType"`
}

type httpRouteProperties struct {
	APIID               json.RawMessage `json:"ApiId"`
	RouteKey            string          `json:"RouteKey"`
	AuthorizationType   string          `json:"AuthorizationType"`
	AuthorizerID        json.RawMessage `json:"AuthorizerId"`
	AuthorizationScopes []string        `json:"AuthorizationScopes"`
	Target              json.RawMessage `json:"Target"`
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
	// Policy is the API's IAM resource policy document.
	Policy json.RawMessage `json:"Policy"`
}

type restResourceProperties struct {
	RestAPIID json.RawMessage `json:"RestApiId"`
	ParentID  json.RawMessage `json:"ParentId"`
	PathPart  string          `json:"PathPart"`
}

type restMethodProperties struct {
	RestAPIID           json.RawMessage `json:"RestApiId"`
	ResourceID          json.RawMessage `json:"ResourceId"`
	HTTPMethod          string          `json:"HttpMethod"`
	AuthorizationType   string          `json:"AuthorizationType"`
	AuthorizerID        json.RawMessage `json:"AuthorizerId"`
	AuthorizationScopes []string        `json:"AuthorizationScopes"`
	Integration         struct {
		Type                 string                    `json:"Type"`
		URI                  json.RawMessage           `json:"Uri"`
		ResponseTransferMode string                    `json:"ResponseTransferMode"`
		IntegrationResponses []restIntegrationResponse `json:"IntegrationResponses"`
	} `json:"Integration"`
}

// restIntegrationResponse is a declared REST MOCK integration response. CDK
// emits one for a CORS preflight method.
type restIntegrationResponse struct {
	StatusCode         string            `json:"StatusCode"`
	ResponseParameters map[string]string `json:"ResponseParameters"`
}

type restStageProperties struct {
	RestAPIID json.RawMessage `json:"RestApiId"`
	StageName string          `json:"StageName"`
}

// lambdaPermissionProperties is the part of an AWS::Lambda::Permission the
// derivation reads. It is how a Function URL's resource-based policy is
// declared in a template.
//
// https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-permission.html
type lambdaPermissionProperties struct {
	Action       string          `json:"Action"`
	FunctionName json.RawMessage `json:"FunctionName"`
	Principal    json.RawMessage `json:"Principal"`
	// FunctionURLAuthType pins the URL auth type a resource statement applies
	// to. It is a plain string on the resource.
	FunctionURLAuthType string `json:"FunctionUrlAuthType"`
}

type functionURLProperties struct {
	AuthType          string          `json:"AuthType"`
	InvokeMode        string          `json:"InvokeMode"`
	TargetFunctionARN json.RawMessage `json:"TargetFunctionArn"`
}

type eventSourceMappingProperties struct {
	BatchSize                      int             `json:"BatchSize"`
	Enabled                        *bool           `json:"Enabled"`
	EventSourceARN                 json.RawMessage `json:"EventSourceArn"`
	FunctionName                   json.RawMessage `json:"FunctionName"`
	FunctionResponseTypes          []string        `json:"FunctionResponseTypes"`
	StartingPosition               string          `json:"StartingPosition"`
	StartingPositionTimestamp      *float64        `json:"StartingPositionTimestamp"`
	MaximumBatchingWindowInSeconds int             `json:"MaximumBatchingWindowInSeconds"`
	FilterCriteria                 json.RawMessage `json:"FilterCriteria"`
	BisectBatchOnFunctionError     *bool           `json:"BisectBatchOnFunctionError"`
	MaximumRetryAttempts           *int            `json:"MaximumRetryAttempts"`
	MaximumRecordAgeInSeconds      *int            `json:"MaximumRecordAgeInSeconds"`
	ParallelizationFactor          *int            `json:"ParallelizationFactor"`
	TumblingWindowInSeconds        *int            `json:"TumblingWindowInSeconds"`
	DestinationConfig              *struct {
		OnFailure *struct {
			Destination json.RawMessage `json:"Destination"`
		} `json:"OnFailure"`
	} `json:"DestinationConfig"`
	ScalingConfig *struct {
		MaximumConcurrency int `json:"MaximumConcurrency"`
	} `json:"ScalingConfig"`
}

type eventRuleProperties struct {
	Name               string          `json:"Name"`
	ScheduleExpression string          `json:"ScheduleExpression"`
	EventPattern       json.RawMessage `json:"EventPattern"`
	State              string          `json:"State"`
	EventBusName       json.RawMessage `json:"EventBusName"`
	Targets            []struct {
		ID               string          `json:"Id"`
		ARN              json.RawMessage `json:"Arn"`
		Input            string          `json:"Input"`
		InputPath        string          `json:"InputPath"`
		InputTransformer *struct {
			InputPathsMap map[string]string `json:"InputPathsMap"`
			InputTemplate string            `json:"InputTemplate"`
		} `json:"InputTransformer"`
		RetryPolicy *struct {
			MaximumRetryAttempts     int `json:"MaximumRetryAttempts"`
			MaximumEventAgeInSeconds int `json:"MaximumEventAgeInSeconds"`
		} `json:"RetryPolicy"`
		DeadLetterConfig *struct {
			ARN json.RawMessage `json:"Arn"`
		} `json:"DeadLetterConfig"`
		SqsParameters *struct {
			MessageGroupID string `json:"MessageGroupId"`
		} `json:"SqsParameters"`
	} `json:"Targets"`
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
	// Account is the AWS account the assembly environment names for this stack
	// (`aws://<account>/<region>`), or empty when the environment is unresolved.
	// A synthesized ARN carries it, so the IAM path resolves policy documents
	// against the account the app deploys into rather than the runner's local
	// identity.
	Account string
	Region  string
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
		stacks = append(stacks, assemblyStack{
			Name:     name,
			Template: parsed,
			Account:  assemblyEnvironmentAccount(artifact.Environment),
			Region:   assemblyEnvironmentRegion(artifact.Environment),
		})
	}
	if len(stacks) == 0 {
		return nil, fmt.Errorf("cloud assembly %s contains no CloudFormation stacks", dir)
	}
	sort.Slice(stacks, func(i, j int) bool { return stacks[i].Name < stacks[j].Name })
	return stacks, nil
}

// assemblyEnvironmentAccount returns the account an assembly artifact's
// environment names, or empty for an unresolved environment ("aws://unknown-account/…").
func assemblyEnvironmentAccount(environment string) string {
	account, _ := splitAssemblyEnvironment(environment)
	if account == "" || account == "unknown-account" || strings.ContainsAny(account, "${}") {
		return ""
	}
	return account
}

// assemblyEnvironmentRegion returns the region an assembly artifact's
// environment names, or empty when it names none.
func assemblyEnvironmentRegion(environment string) string {
	_, region := splitAssemblyEnvironment(environment)
	if region == "" || region == "unknown-region" || strings.ContainsAny(region, "${}") {
		return ""
	}
	return region
}

// splitAssemblyEnvironment splits the `aws://<account>/<region>` form a CDK
// cloud assembly manifest records for a stack.
func splitAssemblyEnvironment(environment string) (string, string) {
	value := strings.TrimSpace(environment)
	value = strings.TrimPrefix(value, "aws://")
	if value == "" || value == environment {
		return "", ""
	}
	parts := strings.SplitN(value, "/", 2)
	if len(parts) != 2 {
		return parts[0], ""
	}
	return parts[0], parts[1]
}

// deriveSpec turns a cloud assembly into the local runner's specification and
// refuses an assembly with no HTTP surface. Invoke uses deriveSpecInternal
// directly: a function can be invoked without an HTTP route.
func deriveSpec(dir string, stacks []assemblyStack) (*Spec, error) {
	spec, err := deriveSpecInternal(dir, stacks)
	if err != nil {
		return nil, err
	}
	if len(spec.RuntimeFunctions()) == 0 && len(spec.ServableCloudFront()) == 0 {
		return nil, noSurfaceError(spec, dir)
	}
	return spec, nil
}

// Derive turns a cloud assembly into the local runner's specification. It fails
// closed on any construct the transport cannot serve faithfully.
func deriveSpecInternal(dir string, stacks []assemblyStack) (*Spec, error) {
	spec := &Spec{
		AssemblyDir:        dir,
		functionURLTargets: map[string]string{},
		functionURLModes:   map[string]string{},
		Templates:          map[string]templateContext{},
		accounts:           map[string]string{},
		regions:            map[string]string{},
	}
	for _, stack := range stacks {
		spec.Templates[stack.Name] = templateContext{
			Parameters: stack.Template.Parameters,
			Conditions: stack.Template.Conditions,
			Mappings:   stack.Template.Mappings,
		}
		if stack.Account != "" {
			spec.accounts[stack.Name] = stack.Account
		}
		if stack.Region != "" {
			spec.regions[stack.Name] = stack.Region
		}
		if err := deriveStack(spec, dir, stacks, stack); err != nil {
			return nil, err
		}
		for _, id := range sortedKeys(stack.Template.Resources) {
			resource := stack.Template.Resources[id]
			spec.Resources = append(spec.Resources, ResourceSpec{
				Stack:      stack.Name,
				LogicalID:  id,
				Type:       resource.Type,
				Properties: resource.Properties,
			})
		}
	}
	topology, err := localcloudfront.ParseTemplates(cloudFrontTemplates(stacks))
	if err != nil {
		return nil, err
	}
	spec.cloudFrontTopology = topology
	spec.CloudFront = topology.Distributions
	spec.CloudFrontFunctions = topology.Functions
	spec.CloudFrontKeyGroups = topology.KeyGroups
	spec.CloudFrontPublicKeys = topology.PublicKeys
	spec.CloudFrontKeyValueStores = topology.KeyValueStores
	for _, distribution := range topology.Distributions {
		if len(distribution.Refusals) == 0 {
			continue
		}
		spec.Skipped = append(spec.Skipped, Skipped{
			LogicalID: distribution.LogicalID,
			Kind:      "cloudfront distribution",
			Reason:    strings.Join(distribution.Refusals, "; "),
		})
	}
	deriveIAMRoles(spec, stacks)
	deriveCustomResources(spec, stacks)
	deriveReceiptRules(spec, stacks)
	classifyProblemResources(spec)
	deriveSkipped(spec)
	deriveProvisioningSkips(spec, stacks)
	spec.PlannedResources = plannedProvisionedResources(spec)
	if err := validateServedFunctions(spec); err != nil {
		return nil, err
	}
	spec.sort()
	return spec, nil
}

// deriveProvisioningSkips records the resource policies and hosted UI a local
// run deliberately does not evaluate. The resources they attach to are still
// provisioned; only the policy surface is absent.
func deriveProvisioningSkips(spec *Spec, stacks []assemblyStack) {
	for _, resource := range spec.Resources {
		logicalID := qualify(stacks, resource.Stack, resource.LogicalID)
		switch resource.Type {
		case typeSecretsResourceRule:
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: logicalID,
				Kind:      typeSecretsResourceRule,
				Reason: "IAM resource-policy evaluation is a docs/125 true limit; " +
					"the secret itself is provisioned and GetSecretValue works at runtime",
			})
		case typeSNSTopicPolicy:
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: logicalID,
				Kind:      typeSNSTopicPolicy,
				Reason: "IAM topic-policy evaluation is a docs/125 true limit; " +
					"the topic itself is provisioned and publish works at runtime",
			})
		case typeCognitoDomain:
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: logicalID,
				Kind:      typeCognitoDomain,
				Reason: "the local runner serves the user pool issuer and JWKS for token validation " +
					"but does not serve the Cognito hosted UI/OAuth domain",
			})
		case typeS3BucketPolicy:
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: logicalID,
				Kind:      typeS3BucketPolicy,
				Reason: "IAM bucket-policy evaluation is a docs/125 true limit; " +
					"the bucket itself is provisioned and object operations work at runtime",
			})
		case typeLogsResourcePolicy:
			spec.Skipped = append(spec.Skipped, Skipped{
				LogicalID: logicalID,
				Kind:      typeLogsResourcePolicy,
				Reason: "IAM log-group policy evaluation is a docs/125 true limit; " +
					"the runner captures function logs itself and evaluates no log policy",
			})
		}
	}
}

// plannedProvisionedResources lists the resources a run creates from the
// assembly, with the local identifier the definition fixes. A generated
// identifier is marked so plan never presents it as a known value.
func plannedProvisionedResources(spec *Spec) []PlannedResource {
	var planned []PlannedResource
	for _, resource := range spec.Resources {
		localID, generated, ok := plannedLocalID(resource)
		if !ok {
			continue
		}
		planned = append(planned, PlannedResource{
			LogicalID: resource.LogicalID,
			Stack:     resource.Stack,
			Type:      resource.Type,
			LocalID:   localID,
			Generated: generated,
		})
	}
	return planned
}

func plannedLocalID(resource ResourceSpec) (string, bool, bool) {
	switch resource.Type {
	case typeS3Bucket, typeDynamoTable, typeSQSQueue, typeSSMParameter, typeSNSTopic,
		typeKinesisStream, typeCognitoUserPool, typeCognitoClient, typeKMSAlias:
		name, err := resourceName(resource)
		if err != nil {
			return "", false, false
		}
		if resource.Type == typeSSMParameter {
			name = ssmParameterName(resource)
		}
		return name, false, true
	case typeCodeBuildProject:
		name, err := resourceName(resource)
		if err != nil {
			return "", false, false
		}
		return name, false, true
	case typeSecretsSecret:
		return secretLocalName(resource), true, true
	case typeKMSKey:
		return "key-id-created-at-run", true, true
	case typeSecretsResourceRule, typeSNSTopicPolicy, typeCognitoDomain:
		return "", false, false
	default:
		return "", false, false
	}
}

// cloudFrontTemplates adapts the runner's assembly stacks to the CloudFront
// topology reader. It is the same cloud assembly, not a second definition.
func cloudFrontTemplates(stacks []assemblyStack) []localcloudfront.Template {
	templates := make([]localcloudfront.Template, 0, len(stacks))
	for _, stack := range stacks {
		resources := make(map[string]localcloudfront.Resource, len(stack.Template.Resources))
		for id, resource := range stack.Template.Resources {
			resources[id] = localcloudfront.Resource{Type: resource.Type, Properties: resource.Properties}
		}
		templates = append(templates, localcloudfront.Template{Stack: stack.Name, Resources: resources})
	}
	return templates
}

func noSurfaceError(spec *Spec, dir string) error {
	message := fmt.Sprintf(
		"cloud assembly %s defines no HTTP API v2 route, WebSocket route, REST API v1 route, Function URL, CloudFront distribution, event source mapping or EventBridge rule target the local runner can serve",
		dir,
	)
	for _, skipped := range spec.Skipped {
		message += fmt.Sprintf("; %s is not served (%s)", skipped.LogicalID, skipped.Reason)
	}
	return errors.New(message)
}

// validateServedFunctions fails closed on a function the transport cannot run
// faithfully, before any container starts.
func validateServedFunctions(spec *Spec) error {
	for _, id := range spec.RuntimeFunctions() {
		function, ok := spec.Function(id)
		if !ok {
			return fmt.Errorf("assembly references function %q but defines no such resource", id)
		}
		if function.CodeProblem != "" {
			return unsupported(id, "%s", function.CodeProblem)
		}
		if function.LayerProblem != "" {
			return unsupported(id, "%s", function.LayerProblem)
		}
		if function.ImageAsset == nil {
			if _, err := RuntimeClass(function.Runtime); err != nil {
				return fmt.Errorf("function %s: %w", id, err)
			}
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
	sort.Slice(s.WebSockets, func(i, j int) bool { return s.WebSockets[i].LogicalID < s.WebSockets[j].LogicalID })
	sort.Slice(s.EventSources, func(i, j int) bool {
		return s.EventSources[i].LogicalID < s.EventSources[j].LogicalID
	})
	sort.Slice(s.Rules, func(i, j int) bool {
		return s.Rules[i].LogicalID < s.Rules[j].LogicalID
	})
	sort.Slice(s.Subscriptions, func(i, j int) bool {
		return s.Subscriptions[i].LogicalID < s.Subscriptions[j].LogicalID
	})
	sort.Slice(s.CodeBuildProjects, func(i, j int) bool {
		return s.CodeBuildProjects[i].LogicalID < s.CodeBuildProjects[j].LogicalID
	})
	SortNotifications(s.Notifications)
	sort.Slice(s.Skipped, func(i, j int) bool { return s.Skipped[i].LogicalID < s.Skipped[j].LogicalID })
	sort.Slice(s.CloudFront, func(i, j int) bool { return s.CloudFront[i].LogicalID < s.CloudFront[j].LogicalID })
	sort.Slice(s.CloudFrontFunctions, func(i, j int) bool {
		return s.CloudFrontFunctions[i].LogicalID < s.CloudFrontFunctions[j].LogicalID
	})
}

func deriveStack(spec *Spec, assemblyDir string, stacks []assemblyStack, stack assemblyStack) error {
	if err := deriveFunctions(spec, assemblyDir, stacks, stack); err != nil {
		return err
	}
	if err := deriveHTTPAPIs(spec, stacks, stack); err != nil {
		return err
	}
	if err := deriveWebSocketAPIs(spec, stacks, stack); err != nil {
		return err
	}
	if err := deriveRESTAPIs(spec, stacks, stack); err != nil {
		return err
	}
	if err := deriveFunctionURLs(spec, stacks, stack); err != nil {
		return err
	}
	if err := deriveEventSourceMappings(spec, stacks, stack); err != nil {
		return err
	}
	if err := deriveEventRules(spec, stacks, stack); err != nil {
		return err
	}
	if err := deriveSNSSubscriptions(spec, stacks, stack); err != nil {
		return err
	}
	if err := deriveS3Notifications(spec, stacks, stack); err != nil {
		return err
	}
	if err := deriveCodeBuildProjects(spec, stacks, stack); err != nil {
		return err
	}
	return deriveSubscriptions(spec, stacks, stack)
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

//nolint:gocyclo // one branch per function shape.
func parseFunction(assemblyDir string, stack assemblyStack, id string, resource templateResource) (FunctionSpec, error) {
	var props lambdaFunctionProperties
	if err := json.Unmarshal(resource.Properties, &props); err != nil {
		return FunctionSpec{}, fmt.Errorf("%s/%s: parse function properties: %w", stack.Name, id, err)
	}
	context := templateContext{
		Parameters: stack.Template.Parameters,
		Conditions: stack.Template.Conditions,
		Mappings:   stack.Template.Mappings,
	}
	memoryMB, memoryResolved, memoryExpression, memoryErr := resolveTemplateInt(props.MemorySize, context, 128)
	if memoryErr != nil {
		return FunctionSpec{}, fmt.Errorf("%s/%s: MemorySize: %w", stack.Name, id, memoryErr)
	}
	timeout, timeoutResolved, timeoutExpression, timeoutErr := resolveTemplateInt(props.Timeout, context, 3)
	if timeoutErr != nil {
		return FunctionSpec{}, fmt.Errorf("%s/%s: Timeout: %w", stack.Name, id, timeoutErr)
	}
	if memoryResolved {
		if err := validateFunctionLimit(id, "MemorySize", memoryMB, 128, 32768); err != nil {
			return FunctionSpec{}, err
		}
	}
	if timeoutResolved {
		if err := validateFunctionLimit(id, "Timeout", timeout, 1, 900); err != nil {
			return FunctionSpec{}, err
		}
	}
	function := FunctionSpec{
		Stack:                stack.Name,
		Runtime:              props.Runtime,
		Handler:              props.Handler,
		Architecture:         archAMD64Alias,
		MemoryMB:             memoryMB,
		Timeout:              timeout,
		LayerCount:           len(props.Layers),
		Environment:          map[string]string{},
		UnresolvedMemorySize: !memoryResolved,
		UnresolvedTimeout:    !timeoutResolved,
	}
	if !memoryResolved {
		function.MemorySizeExpression = memoryExpression
	}
	if !timeoutResolved {
		function.TimeoutExpression = timeoutExpression
	}
	if len(props.Architectures) > 0 {
		function.Architecture = props.Architectures[0]
	}
	function.EnvironmentExpressions = map[string]string{}
	for name, raw := range props.Environment.Variables {
		value, err := decodeString(raw)
		if err != nil {
			function.UnresolvedEnvironment = append(function.UnresolvedEnvironment, name)
			function.EnvironmentExpressions[name] = string(raw)
			continue
		}
		function.Environment[name] = value
	}
	sort.Strings(function.UnresolvedEnvironment)

	if err := resolveFunctionPackaging(assemblyDir, stack, id, resource, props, &function); err != nil {
		return FunctionSpec{}, err
	}
	if function.PackageType == "Image" {
		return function, nil
	}
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

	if err := resolveZipCode(assemblyDir, stack, id, resource, &function); err != nil {
		return FunctionSpec{}, err
	}
	return function, nil
}

// resolveZipCode fills AssetDir from the cloud assembly's aws:asset:path, or
// records why the function's zip code cannot be materialized locally.
func resolveZipCode(assemblyDir string, stack assemblyStack, id string, resource templateResource, function *FunctionSpec) error {
	assetPath, err := metadataString(resource.Metadata, assetPathMetadataKey)
	if err != nil {
		return fmt.Errorf("%s/%s: %w", stack.Name, id, err)
	}
	if assetPath == "" {
		function.CodeProblem = "function code has no local asset directory (aws:asset:path) and no inline Code.ZipFile"
		return nil
	}
	if !filepath.IsAbs(assetPath) {
		assetPath = filepath.Join(assemblyDir, assetPath)
	}
	info, statErr := os.Stat(assetPath)
	if statErr != nil {
		function.CodeProblem = fmt.Sprintf("function asset %s is unavailable: %v", assetPath, statErr)
		return nil
	}
	if !info.IsDir() {
		function.CodeProblem = fmt.Sprintf("function asset %s is not a directory", assetPath)
		return nil
	}
	function.AssetDir = filepath.Clean(assetPath)
	return nil
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

// intExpression names the CloudFormation intrinsic that kept an integer
// property from resolving. It is display-only: decodeInt's resolved flag is
// the fail-closed signal.
func intExpression(raw json.RawMessage) string {
	var expression map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &expression) != nil || len(expression) != 1 {
		return ""
	}
	for key := range expression {
		if key == intrinsicRef || strings.HasPrefix(key, "Fn::") {
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
