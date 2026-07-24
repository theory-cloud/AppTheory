package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type Fixture struct {
	ID     string        `json:"id"`
	Tier   string        `json:"tier"`
	Name   string        `json:"name"`
	Setup  FixtureSetup  `json:"setup"`
	Input  FixtureInput  `json:"input"`
	Expect FixtureExpect `json:"expect"`
}

type FixtureSetup struct {
	Limits                FixtureLimits                     `json:"limits,omitempty"`
	HTTPErrorFormat       string                            `json:"http_error_format,omitempty"`
	Routes                []FixtureRoute                    `json:"routes,omitempty"`
	Middlewares           []string                          `json:"middlewares,omitempty"`
	CORS                  FixtureCORSConfig                 `json:"cors,omitempty"`
	Environment           map[string]string                 `json:"environment,omitempty"`
	LoggingProfile        json.RawMessage                   `json:"logging_profile,omitempty"`
	OpenAPI               json.RawMessage                   `json:"openapi,omitempty"`
	MCP                   FixtureMCPSetup                   `json:"mcp,omitempty"`
	OAuth                 FixtureOAuthSetup                 `json:"oauth,omitempty"`
	ObjectStore           FixtureObjectStoreSetup           `json:"objectstore,omitempty"`
	VectorStore           FixtureVectorStoreSetup           `json:"vectorstore,omitempty"`
	WebSockets            []FixtureWebSocketRoute           `json:"websockets,omitempty"`
	SQS                   []FixtureSQSRoute                 `json:"sqs,omitempty"`
	Kinesis               []FixtureKinesisRoute             `json:"kinesis,omitempty"`
	SNS                   []FixtureSNSRoute                 `json:"sns,omitempty"`
	EventBridge           []FixtureEventBridgeRoute         `json:"eventbridge,omitempty"`
	DynamoDB              []FixtureDynamoDBRoute            `json:"dynamodb,omitempty"`
	MicroVMContract       json.RawMessage                   `json:"microvm_contract,omitempty"`
	MicroVMRoute          FixtureMicroVMRouteSetup          `json:"microvm_controller_route,omitempty"`
	MicroVMExecutionRole  FixtureMicroVMExecutionRoleSetup  `json:"microvm_execution_role,omitempty"`
	MicroVMRuntimeLogging FixtureMicroVMRuntimeLoggingSetup `json:"microvm_runtime_logging,omitempty"`
}

type FixtureCORSConfig struct {
	AllowedOrigins   []string `json:"allowed_origins,omitempty"`
	AllowCredentials bool     `json:"allow_credentials,omitempty"`
	AllowHeaders     []string `json:"allow_headers,omitempty"`
}

type FixtureRoute struct {
	Method       string `json:"method"`
	Path         string `json:"path"`
	Handler      string `json:"handler"`
	AuthRequired bool   `json:"auth_required,omitempty"`
}

type FixtureWebSocketRoute struct {
	RouteKey string `json:"route_key"`
	Handler  string `json:"handler"`
}

type FixtureSQSRoute struct {
	Queue   string `json:"queue"`
	Handler string `json:"handler"`
}

type FixtureKinesisRoute struct {
	Stream  string `json:"stream"`
	Handler string `json:"handler"`
}

type FixtureSNSRoute struct {
	Topic   string `json:"topic"`
	Handler string `json:"handler"`
}

type FixtureEventBridgeRoute struct {
	RuleName   string `json:"rule_name,omitempty"`
	Source     string `json:"source,omitempty"`
	DetailType string `json:"detail_type,omitempty"`
	Handler    string `json:"handler"`
}

type FixtureDynamoDBRoute struct {
	Table   string `json:"table"`
	Handler string `json:"handler"`
}

type FixtureInput struct {
	Context               FixtureContext          `json:"context,omitempty"`
	Request               *FixtureRequest         `json:"request,omitempty"`
	AWSEvent              *FixtureAWSEvent        `json:"aws_event,omitempty"`
	LoggingEvent          json.RawMessage         `json:"logging_event,omitempty"`
	LoggingProfileCatalog bool                    `json:"logging_profile_catalog,omitempty"`
	MCP                   *FixtureMCPInput        `json:"mcp,omitempty"`
	OAuth                 *FixtureOAuthInput      `json:"oauth,omitempty"`
	ObjectStore           FixtureObjectStoreInput `json:"objectstore,omitempty"`
	VectorStore           FixtureVectorStoreInput `json:"vectorstore,omitempty"`
}

type FixtureAWSEvent struct {
	Source string          `json:"source"`
	Event  json.RawMessage `json:"event"`
}

type FixtureContext struct {
	RemainingMS  int    `json:"remaining_ms,omitempty"`
	AWSRequestID string `json:"aws_request_id,omitempty"`
}

type FixtureRequest struct {
	Method   string              `json:"method"`
	Path     string              `json:"path"`
	Query    map[string][]string `json:"query"`
	Headers  map[string][]string `json:"headers"`
	Body     FixtureBody         `json:"body"`
	IsBase64 bool                `json:"is_base64"`
}

type FixtureExpect struct {
	Response                   *FixtureResponse                   `json:"response,omitempty"`
	Output                     json.RawMessage                    `json:"output_json,omitempty"`
	Error                      *FixtureError                      `json:"error,omitempty"`
	WebSocketCalls             []FixtureWebSocketCall             `json:"ws_calls,omitempty"`
	CloudWatchLogsSubscription *FixtureCloudWatchLogsSubscription `json:"cloudwatch_logs_subscription,omitempty"`
	Logs                       []FixtureLogRecord                 `json:"logs,omitempty"`
	Metrics                    []FixtureMetricRecord              `json:"metrics,omitempty"`
	Spans                      []FixtureSpanRecord                `json:"spans,omitempty"`
	EMFLogs                    []string                           `json:"emf_logs,omitempty"`
	ProfileLogs                []map[string]any                   `json:"profile_logs,omitempty"`
	ProfileValidationErrors    []string                           `json:"profile_validation_errors,omitempty"`
	LoggingProfileCatalog      map[string]any                     `json:"logging_profile_catalog,omitempty"`
	MicroVMContractValidation  *FixtureMicroVMContractValidation  `json:"microvm_contract_validation,omitempty"`
	MicroVMLifecycleAdapter    *FixtureMicroVMLifecycleAdapter    `json:"microvm_lifecycle_adapter,omitempty"`
	MicroVMControllerRoute     *FixtureMicroVMControllerRoute     `json:"microvm_controller_route,omitempty"`
	MicroVMExecutionRole       *FixtureMicroVMExecutionRole       `json:"microvm_execution_role,omitempty"`
	MicroVMRuntimeLogging      *FixtureMicroVMRuntimeLogging      `json:"microvm_runtime_logging,omitempty"`
	MCP                        *FixtureMCPExpect                  `json:"mcp,omitempty"`
	OAuth                      *FixtureOAuthExpect                `json:"oauth,omitempty"`
}

type FixtureOAuthSetup struct {
	ClockUnix            int64                 `json:"clock_unix,omitempty"`
	Resource             string                `json:"resource,omitempty"`
	AuthorizationServers []string              `json:"authorization_servers,omitempty"`
	ScopesSupported      []string              `json:"scopes_supported,omitempty"`
	RequiredAudience     string                `json:"required_audience,omitempty"`
	RequiredScopes       []string              `json:"required_scopes,omitempty"`
	BearerTokens         []FixtureOAuthToken   `json:"bearer_tokens,omitempty"`
	IDSequence           []string              `json:"id_sequence,omitempty"`
	DCRPolicy            FixtureOAuthDCRPolicy `json:"dcr_policy,omitempty"`
}

type FixtureOAuthToken struct {
	Token       string   `json:"token"`
	Subject     string   `json:"subject,omitempty"`
	Audience    string   `json:"audience,omitempty"`
	Scope       string   `json:"scope,omitempty"`
	Scopes      []string `json:"scopes,omitempty"`
	ExpiresUnix int64    `json:"expires_unix,omitempty"`
}

type FixtureOAuthDCRPolicy struct {
	AllowedRedirectURIs []string `json:"allowed_redirect_uris,omitempty"`
	RequirePublicClient bool     `json:"require_public_client,omitempty"`
	RequireRefreshToken bool     `json:"require_refresh_token,omitempty"`
}

type FixtureOAuthInput struct {
	Steps []FixtureOAuthStep `json:"steps"`
}

type FixtureOAuthStep struct {
	Name    string         `json:"name"`
	Request FixtureRequest `json:"request"`
}

type FixtureOAuthExpect struct {
	Steps []FixtureOAuthExpectedStep `json:"steps"`
}

type FixtureOAuthExpectedStep struct {
	Status   int                 `json:"status"`
	Headers  map[string][]string `json:"headers"`
	Cookies  []string            `json:"cookies"`
	Body     *FixtureBody        `json:"body,omitempty"`
	BodyJSON json.RawMessage     `json:"body_json,omitempty"`
	IsBase64 bool                `json:"is_base64"`
}

type FixtureMCPSetup struct {
	Server            FixtureMCPServer             `json:"server,omitempty"`
	IDSequence        []string                     `json:"id_sequence,omitempty"`
	StreamIDSequence  []string                     `json:"stream_id_sequence,omitempty"`
	Tools             []FixtureMCPTool             `json:"tools,omitempty"`
	Resources         []FixtureMCPResource         `json:"resources,omitempty"`
	ResourceTemplates []FixtureMCPResourceTemplate `json:"resource_templates,omitempty"`
	Prompts           []FixtureMCPPrompt           `json:"prompts,omitempty"`
	SessionStore      FixtureMCPSessionStore       `json:"session_store,omitempty"`
	TaskRuntime       *FixtureMCPTaskRuntime       `json:"task_runtime,omitempty"`
}

type FixtureMCPServer struct {
	Name    string `json:"name,omitempty"`
	Version string `json:"version,omitempty"`
}

type FixtureMCPTool struct {
	Name         string          `json:"name"`
	Title        string          `json:"title,omitempty"`
	Description  string          `json:"description,omitempty"`
	InputSchema  json.RawMessage `json:"input_schema"`
	OutputSchema json.RawMessage `json:"output_schema,omitempty"`
	Handler      string          `json:"handler"`
	Streaming    bool            `json:"streaming,omitempty"`
	TaskSupport  string          `json:"task_support,omitempty"`
}

type FixtureMCPResource struct {
	URI         string                      `json:"uri"`
	Name        string                      `json:"name"`
	Title       string                      `json:"title,omitempty"`
	Description string                      `json:"description,omitempty"`
	MimeType    string                      `json:"mime_type,omitempty"`
	Size        int64                       `json:"size,omitempty"`
	Contents    []FixtureMCPResourceContent `json:"contents"`
}

type FixtureMCPResourceTemplate struct {
	URITemplate string `json:"uri_template"`
	Name        string `json:"name"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	MimeType    string `json:"mime_type,omitempty"`
}

type FixtureMCPResourceContent struct {
	URI      string `json:"uri"`
	MimeType string `json:"mime_type,omitempty"`
	Text     string `json:"text,omitempty"`
	Blob     string `json:"blob,omitempty"`
}

type FixtureMCPPrompt struct {
	Name        string                     `json:"name"`
	Title       string                     `json:"title,omitempty"`
	Description string                     `json:"description,omitempty"`
	Arguments   []FixtureMCPPromptArgument `json:"arguments,omitempty"`
	Handler     string                     `json:"handler"`
}

type FixtureMCPPromptArgument struct {
	Name        string `json:"name"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Required    bool   `json:"required,omitempty"`
}

type FixtureMCPSessionStore struct {
	Seed []FixtureMCPSession `json:"seed,omitempty"`
}

type FixtureMCPSession struct {
	ID            string            `json:"id"`
	CreatedUnixMS int64             `json:"created_unix_ms,omitempty"`
	ExpiresUnixMS int64             `json:"expires_unix_ms"`
	Data          map[string]string `json:"data,omitempty"`
}

type FixtureMCPTaskRuntime struct {
	Enabled                bool   `json:"enabled,omitempty"`
	DefaultTTLMS           int64  `json:"default_ttl_ms,omitempty"`
	MaxTTLMS               int64  `json:"max_ttl_ms,omitempty"`
	PollIntervalMS         int64  `json:"poll_interval_ms,omitempty"`
	ListLimit              int    `json:"list_limit,omitempty"`
	ModelImmediateResponse string `json:"model_immediate_response,omitempty"`
	ClockUnixMS            int64  `json:"clock_unix_ms,omitempty"`
	UpdateClockUnixMS      int64  `json:"update_clock_unix_ms,omitempty"`
}

type FixtureMCPInput struct {
	Steps []FixtureMCPStep `json:"steps"`
}

type FixtureMCPStep struct {
	Name     string         `json:"name"`
	Request  FixtureRequest `json:"request"`
	ReadBody bool           `json:"read_body,omitempty"`
}

type FixtureMCPExpect struct {
	Steps []FixtureMCPExpectedStep `json:"steps"`
}

type FixtureMCPExpectedStep struct {
	Status    int                   `json:"status"`
	Headers   map[string][]string   `json:"headers"`
	Cookies   []string              `json:"cookies"`
	Body      *FixtureBody          `json:"body,omitempty"`
	BodyJSON  json.RawMessage       `json:"body_json,omitempty"`
	SSEFrames *[]FixtureMCPSSEFrame `json:"sse_frames,omitempty"`
	IsBase64  bool                  `json:"is_base64"`
}

type FixtureMCPSSEFrame struct {
	ID    string `json:"id"`
	Event string `json:"event,omitempty"`
	Data  string `json:"data"`
}

type FixtureMicroVMContractValidation struct {
	Valid        bool   `json:"valid"`
	Kind         string `json:"kind,omitempty"`
	Version      string `json:"version,omitempty"`
	ErrorCode    string `json:"error_code,omitempty"`
	ErrorMessage string `json:"error_message,omitempty"`
}

type FixtureMicroVMLifecycleAdapter struct {
	Valid         bool     `json:"valid"`
	Version       string   `json:"version,omitempty"`
	FinalState    string   `json:"final_state,omitempty"`
	FailureState  string   `json:"failure_state,omitempty"`
	HandlerStates []string `json:"handler_states,omitempty"`
	ErrorCode     string   `json:"error_code,omitempty"`
	ErrorMessage  string   `json:"error_message,omitempty"`
}

type FixtureMicroVMRouteSetup struct {
	Authenticated      bool                             `json:"authenticated,omitempty"`
	SeedSession        bool                             `json:"seed_session,omitempty"`
	TenantID           string                           `json:"tenant_id,omitempty"`
	Namespace          string                           `json:"namespace,omitempty"`
	SessionID          string                           `json:"session_id,omitempty"`
	DeploymentDefaults FixtureMicroVMDeploymentDefaults `json:"deployment_defaults,omitempty"`
}

type FixtureMicroVMDeploymentDefaults struct {
	ImageRef                    string   `json:"image_ref,omitempty"`
	NetworkConnectorRef         string   `json:"network_connector_ref,omitempty"`
	IngressNetworkConnectorRefs []string `json:"ingress_network_connector_refs,omitempty"`
	EgressNetworkConnectorRefs  []string `json:"egress_network_connector_refs,omitempty"`
}

type FixtureMicroVMExecutionRoleSetup struct {
	TenantID         string `json:"tenant_id,omitempty"`
	Namespace        string `json:"namespace,omitempty"`
	SessionID        string `json:"session_id,omitempty"`
	ExecutionRoleArn string `json:"execution_role_arn,omitempty"`
}

type FixtureMicroVMControllerRoute struct {
	Status                     int      `json:"status"`
	Command                    string   `json:"command,omitempty"`
	TenantID                   string   `json:"tenant_id,omitempty"`
	Namespace                  string   `json:"namespace,omitempty"`
	SessionID                  string   `json:"session_id,omitempty"`
	State                      string   `json:"state,omitempty"`
	TokenType                  string   `json:"token_type,omitempty"`
	Scope                      []string `json:"scope,omitempty"`
	ErrorCode                  string   `json:"error_code,omitempty"`
	BodyContains               []string `json:"body_contains,omitempty"`
	ForbiddenBodySubstrings    []string `json:"forbidden_body_substrings,omitempty"`
	RegistryTokenMetadataCount *int     `json:"registry_token_metadata_count,omitempty"`
}

type FixtureMicroVMExecutionRole struct {
	Valid                    bool   `json:"valid"`
	SessionID                string `json:"session_id,omitempty"`
	State                    string `json:"state,omitempty"`
	ProviderExecutionRoleArn string `json:"provider_execution_role_arn,omitempty"`
	ErrorCode                string `json:"error_code,omitempty"`
	ErrorMessage             string `json:"error_message,omitempty"`
}

type FixtureMicroVMRuntimeLoggingSetup struct {
	Cases []FixtureMicroVMRuntimeLoggingCaseSetup `json:"cases,omitempty"`
}

type FixtureMicroVMRuntimeLoggingCaseSetup struct {
	Name             string          `json:"name"`
	Logging          json.RawMessage `json:"logging,omitempty"`
	ExecutionRoleArn string          `json:"execution_role_arn,omitempty"`
}

type FixtureMicroVMRuntimeLogging struct {
	Cases []FixtureMicroVMRuntimeLoggingCase `json:"cases"`
}

type FixtureMicroVMRuntimeLoggingCase struct {
	Name            string                         `json:"name"`
	Valid           bool                           `json:"valid"`
	SessionID       string                         `json:"session_id,omitempty"`
	State           string                         `json:"state,omitempty"`
	ProviderLogging *FixtureMicroVMProviderLogging `json:"provider_logging,omitempty"`
	ErrorCode       string                         `json:"error_code,omitempty"`
	ErrorMessage    string                         `json:"error_message,omitempty"`
}

type FixtureMicroVMProviderLogging struct {
	CloudWatch *FixtureMicroVMProviderCloudWatchLogging `json:"cloud_watch,omitempty"`
	Disabled   bool                                     `json:"disabled,omitempty"`
}

type FixtureMicroVMProviderCloudWatchLogging struct {
	LogGroup  string `json:"log_group,omitempty"`
	LogStream string `json:"log_stream,omitempty"`
}

type FixtureError struct {
	Code       string `json:"code,omitempty"`
	Message    string `json:"message"`
	StatusCode int    `json:"status_code,omitempty"`
}

type FixtureResponse struct {
	Status   int                 `json:"status"`
	Headers  map[string][]string `json:"headers"`
	Cookies  []string            `json:"cookies"`
	Body     *FixtureBody        `json:"body,omitempty"`
	Chunks   []FixtureBody       `json:"chunks,omitempty"`
	BodyJSON json.RawMessage     `json:"body_json,omitempty"`
	IsBase64 bool                `json:"is_base64"`

	StreamErrorCode string `json:"stream_error_code,omitempty"`
}

type FixtureWebSocketCall struct {
	Op           string       `json:"op"`
	Endpoint     string       `json:"endpoint,omitempty"`
	ConnectionID string       `json:"connection_id"`
	Data         *FixtureBody `json:"data,omitempty"`
}

type FixtureCloudWatchLogsSubscription struct {
	Records []FixtureCloudWatchLogsSubscriptionRecord `json:"records,omitempty"`
}

type FixtureCloudWatchLogsSubscriptionRecord struct {
	RecordID                   string                                      `json:"record_id"`
	DecodeError                bool                                        `json:"decode_error,omitempty"`
	MessageType                string                                      `json:"message_type,omitempty"`
	Owner                      string                                      `json:"owner,omitempty"`
	LogGroup                   string                                      `json:"log_group,omitempty"`
	LogStream                  string                                      `json:"log_stream,omitempty"`
	SubscriptionFilters        []string                                    `json:"subscription_filters,omitempty"`
	LogEvents                  []FixtureCloudWatchLogsSubscriptionLogEvent `json:"log_events,omitempty"`
	SafeSummary                map[string]any                              `json:"safe_summary,omitempty"`
	ForbiddenSafeLogSubstrings []string                                    `json:"forbidden_safe_log_substrings,omitempty"`
}

type FixtureCloudWatchLogsSubscriptionLogEvent struct {
	ID        string `json:"id"`
	Timestamp int64  `json:"timestamp"`
	Message   string `json:"message"`
}

type FixtureBody struct {
	Encoding string `json:"encoding"`
	Value    string `json:"value"`
}

type FixtureLimits struct {
	MaxRequestBytes  int `json:"max_request_bytes,omitempty"`
	MaxResponseBytes int `json:"max_response_bytes,omitempty"`
}

type FixtureLogRecord struct {
	Level         string `json:"level"`
	Event         string `json:"event"`
	RequestID     string `json:"request_id"`
	TraceID       string `json:"trace_id,omitempty"`
	TenantID      string `json:"tenant_id"`
	Method        string `json:"method"`
	Path          string `json:"path"`
	Status        int    `json:"status"`
	ErrorCode     string `json:"error_code"`
	DurationMS    int    `json:"duration_ms,omitempty"`
	Trigger       string `json:"trigger,omitempty"`
	CorrelationID string `json:"correlation_id,omitempty"`
	Source        string `json:"source,omitempty"`
	DetailType    string `json:"detail_type,omitempty"`
	TableName     string `json:"table_name,omitempty"`
	EventID       string `json:"event_id,omitempty"`
	EventName     string `json:"event_name,omitempty"`
}

type FixtureMetricRecord struct {
	Name       string            `json:"name"`
	Value      int               `json:"value"`
	DurationMS int               `json:"duration_ms,omitempty"`
	Tags       map[string]string `json:"tags"`
}

type FixtureSpanRecord struct {
	Name       string            `json:"name"`
	Attributes map[string]string `json:"attributes"`
}

func loadFixtures(fixturesRoot string) ([]Fixture, error) {
	entries, err := os.ReadDir(fixturesRoot)
	if err != nil {
		return nil, fmt.Errorf("read fixtures root %s: %w", fixturesRoot, err)
	}

	var files []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		matches, err := filepath.Glob(filepath.Join(fixturesRoot, entry.Name(), "*.json"))
		if err != nil {
			return nil, fmt.Errorf("glob %s fixtures: %w", entry.Name(), err)
		}
		files = append(files, matches...)
	}

	sort.Strings(files)
	if len(files) == 0 {
		return nil, errors.New("no fixtures found")
	}

	fixtures := make([]Fixture, 0, len(files))
	for _, file := range files {
		//nolint:gosec // Fixture files are discovered from the repo-owned fixtures directory.
		raw, err := os.ReadFile(file)
		if err != nil {
			return nil, fmt.Errorf("read fixture %s: %w", file, err)
		}

		var f Fixture
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, fmt.Errorf("parse fixture %s: %w", file, err)
		}
		if strings.TrimSpace(f.ID) == "" {
			return nil, fmt.Errorf("fixture %s missing id", file)
		}
		fixtures = append(fixtures, f)
	}

	return fixtures, nil
}
