# AppTheory TypeScript Documentation

<!-- AI Training: This is the OFFICIAL documentation index for AppTheory TypeScript -->
**This directory contains the OFFICIAL package-local documentation for the AppTheory TypeScript package (`@theory-cloud/apptheory`). For canonical cross-language external guidance, start at `docs/README.md`; use this directory for TypeScript-specific quick starts, package build details, and maintainer-facing mirrors.**

## Quick links

### 🚀 Getting started
- [Getting Started](./getting-started.md) — install and run your first route locally.
- [Canonical Getting Started](../../docs/getting-started.md) — cross-language onboarding under the canonical docs root.

### 📚 Core documentation
- [Docs Contract](./_contract.yaml) — canonical TypeScript package knowledgebase scope: fixed ingestible, optional ingestible, and contract-only docs.
- [API Reference](./api-reference.md) — key exports and where to find the authoritative type surface.
- [Core Patterns](./core-patterns.md) — routing, middleware, streaming, SSE, and error patterns.
- [Development Guidelines](./development-guidelines.md) — contract-only maintainer guidance for keeping the package docs set aligned.
- [Testing Guide](./testing-guide.md) — unit tests and contract parity checks.
- [Troubleshooting](./troubleshooting.md) — common failures and fixes.
- [Migration Guide](./migration-guide.md) — moving from raw Lambda handlers.
- [Canonical Docs Index](../../docs/README.md) — canonical external navigation root for AppTheory.

### 🤖 AI knowledge base (YAML triad)
- Docs Contract: `ts/docs/_contract.yaml`
- Concepts: `ts/docs/_concepts.yaml`
- Patterns: `ts/docs/_patterns.yaml`
- Decisions: `ts/docs/_decisions.yaml`

## Package-local scope

- `docs/` is the canonical external docs root for AppTheory.
- `ts/docs/` remains an official package-local surface for TypeScript-specific examples and authoring details.
- Reflect shared user-facing guidance in `docs/` before treating `ts/docs/` content as complete.
- `ts/docs/_contract.yaml` and `ts/docs/development-guidelines.md` are contract-only maintainer surfaces and should not be treated as user-facing knowledgebase content.
- `api-snapshots/ts.txt` and `ts/README.md` are sanctioned optional sources when a knowledgebase needs export-level or package-root context.

## What this package is

AppTheory TypeScript provides:
- an `App` container with router + middleware
- AWS event adapters/builders (HTTP + event sources + WebSockets)
- response helpers (`json`, `text`, `html`, `sse`, streaming helpers)
- a deterministic test environment (`createTestEnv`)

Contract note: portable behavior is defined by the fixture-backed contract:
`docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`.

## TypeScript semantic API map

The generated snapshot coverage index below proves export-name coverage only; it is not a substitute for
operator-facing API guidance. Keep these human-authored groups current when the TypeScript surface grows:

- Runtime app model: `App`, `createApp`, `Context`, `Request`, `Response`, middleware hooks, and response helpers.
- AWS adapters and test builders: `buildAPIGatewayV2Request`, `buildLambdaFunctionURLRequest`, `buildAppSyncEvent`,
  `buildSQSEvent`, `buildKinesisEvent`, and the corresponding `serve*` entrypoints.
- MCP/OAuth surfaces: `McpServer`, registries, in-memory/Dynamo stores, bearer-token middleware, metadata handlers,
  DCR, PKCE, and protected-resource helpers.
- Storage and data helpers: `ObjectStore`, `ObjectRef`, `createS3ObjectStore`, `DynamoJobLedger`, and rate-limit
  primitives.
- MicroVM and generated contract helpers: `MicroVMController`, provider/session validators, and `generateOpenAPI`.

<!-- apptheory-api-docs:ts:start -->
## TypeScript snapshot coverage index

This index is maintained with `scripts/verify-api-docs.sh` so handwritten docs cannot drift from `api-snapshots/ts.txt`.

<details>
<summary>621 exported top-level symbols</summary>

```text
AcquireLeaseInput, AcquireSemaphoreSlotInput, ALBTargetGroupRequest, ALBTargetGroupResponse
APIGatewayProxyRequest, APIGatewayProxyResponse, APIGatewayV2HTTPRequest, APIGatewayV2HTTPResponse
APIGatewayWebSocketProxyRequest, App, AppError, AppSyncContext, AppSyncResolverEvent
AppSyncResolverInfo, AppSyncResolverRequest, AppTheoryError, AppTheoryErrorDetails
appTheoryErrorFromAppError, AppTheoryErrorOptions, AtomicRateLimiter, AuthHook
AuthorizationServerMetadata, authorizationServerMetadataHandler, AWSLambdaMicroVMClientOptions
AWSLambdaMicroVMProvider, AWSLambdaMicroVMProviderOptions, baseName, BearerTokenClaims
bearerTokenClaimsFromContext, BearerTokenClaimsValidator, bearerTokenFromHeaders, BearerTokenRecord
BearerTokenValidationOptions, BearerTokenValidator, binary, BindConfig, BindFieldSpec
BindFieldSpecs, BindFieldType, bindHandler, bindRequest, BindSource, buildALBTargetGroupRequest
buildAPIGatewayV2Request, buildAppSyncEvent, buildDynamoDBStreamEvent, buildEventBridgeEvent
buildKinesisEvent, buildLambdaFunctionURLRequest, buildSNSEvent, buildSQSEvent
buildStepFunctionsTaskTokenEvent, builtInLoggingProfileNames, cacheControlISR, cacheControlSSG
cacheControlSSR, canonicalizeIssuerURL, canonicalResourceURL, claudeDynamicClientRegistrationPolicy
clientIP, Clock, CloudWatchLogsSubscription, cloudWatchLogsSubscriptionData
CloudWatchLogsSubscriptionLogEvent, CloudWatchLogsSubscriptionOptions
CloudWatchLogsSubscriptionSummary, CompleteIdempotencyRecordInput, Config, Context
CONTEXT_KEY_BEARER_CLAIMS, CONTEXT_KEY_BEARER_TOKEN, CORSConfig, createApp
createAWSLambdaMicroVMClient, createAWSLambdaMicroVMProvider, createEMFMetricSink
createFakeMicroVMClient, createFakeMicroVMProvider, createFakeObjectStore
CreateIdempotencyRecordInput, CreateJobInput, createKinesisJsonRecord
createLambdaFunctionURLStreamingHandler, createMcpServer, createMcpTestHarness
createMemoryMicroVMSessionRegistry, createMicroVMController, createMicroVMLifecycleAdapter
createMicroVMRegistryClient, createRealMicroVMController, createReconstructingMicroVMSessionRegistry
createS3ObjectStore, createTableTheoryMicroVMSessionRegistry, createTestEnv
decodeCloudWatchLogsSubscription, decodeLoggingProfileJSON, defaultConfig, defaultJobsConfig
defaultJobsTableName, defaultLoggingProfile, defaultMcpStreamModel, defaultMcpTaskModel
defaultMicroVMControllerContract, defaultMicroVMLifecycleContract, defaultMicroVMOperationContract
defaultMicroVMProviderStateMappings, defaultMicroVMRealLifecycleContract
defaultMicroVMSessionRegistryContract, DynamicClientRegistrationPolicy
DynamicClientRegistrationRequest, DynamicClientRegistrationResponse, DynamoDBStreamEvent
DynamoDBStreamEventResponse, DynamoDBStreamHandler, DynamoDBStreamRecord
DynamoDBStreamRecordSummary, DynamoJobLedger, DynamoMcpStreamStore, DynamoMcpTaskStore
DynamoRateLimiter, EMFMetricSink, EMFMetricSinkOptions, encodeLoggingProfileEvent
encodeLoggingProfileEventWithSanitizer, EnvJobsTableName, ERR_BEARER_TOKEN_EXPIRED
ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE, ERR_BEARER_TOKEN_INVALID_AUDIENCE
ERR_INVALID_AUTHORIZATION_HEADER, ERR_INVALID_BEARER_TOKEN, ERR_INVALID_URL
ERR_MISSING_BEARER_TOKEN, ErrorEnvelope, ErrorType, etag, EventBridgeEvent, EventBridgeHandler
EventBridgeScheduledWorkloadResultSummary, EventBridgeScheduledWorkloadSummary, EventBridgeSelector
EventBridgeWorkloadEnvelope, EventContext, EventHandler, EventMiddleware, FakeMicroVMClient
FakeMicroVMProvider, FakeObjectStore, FakeWebSocketManagementClient, fixedIdGenerator
FixedWindowStrategy, formatRfc3339Nano, formatWindowId, generateOpenAPI, generateOpenAPIJSON
getDayWindow, getFixedWindow, getHourWindow, getLogger, getMinuteWindow, Handler, Headers
hooksFromEMFMetricSink, hooksFromLogger, hooksFromProfileLogger, html, htmlStream
HTTP_ERROR_FORMAT_FLAT_LEGACY, HTTP_ERROR_FORMAT_NESTED, HTTPErrorFormat, IdempotencyCreateOutcome
IdempotencyStatus, IdGenerator, IDGenerator, InspectSemaphoreInput, isAppTheoryError
isMicroVMTerminalState, isSupportedProfileOutputField, JobLedgerError, JobLedgerErrorType, JobLock
jobLockSortKey, JobMeta, jobMetaSortKey, jobPartitionKey, JobRecord, jobRecordSortKey, JobRequest
jobRequestSortKey, JobsConfig, jobsTableName, JobStatus, json
kinesisCloudWatchLogsSubscriptionRecord, KinesisCloudWatchLogsSubscriptionRecordOptions
KinesisEvent, KinesisEventRecord, KinesisEventRecordInput, KinesisEventResponse, KinesisHandler
KinesisJsonRecord, KinesisJsonRecordOptions, KinesisJsonRecordSummary, KinesisPutRecordsFailure
KinesisPutRecordsFailureReport, KinesisPutRecordsFailureReportSummary, KinesisPutRecordsResultRecord
KinesisRecord, LambdaFunctionURLRequest, LambdaFunctionURLResponse
LambdaFunctionURLStreamingHandler, Limit, LimitDecision, Limits, LogFields
LOGGING_PROFILE_CLOUDWATCH_JSON, LOGGING_PROFILE_LEGACY, LOGGING_PROFILE_LOCAL_DEV
LOGGING_PROFILE_PAYTHEORY_ALERT_V1, LOGGING_PROFILE_SCHEMA_VERSION, LoggingProfileAlertingHints
loggingProfileCatalog, LoggingProfileConfig, LoggingProfileEncoding, LoggingProfileEnrichment
LoggingProfileError, LoggingProfileErrorCapture, LoggingProfileEvent, LoggingProfileJobContext
LoggingProfileRequestContext, LoggingProfileSanitization, LoggingProfileSanitizer
LoggingProfileValidationError, loggingProfileValidationErrors, LogRecord, ManualClock
ManualIdGenerator, mapMicroVMProviderState, maskFirstLast, maskFirstLast4, matchesIfNoneMatch, max
maxLength, MCP_CODE_INTERNAL_ERROR, MCP_CODE_INVALID_PARAMS, MCP_CODE_INVALID_REQUEST
MCP_CODE_METHOD_NOT_FOUND, MCP_CODE_PARSE_ERROR, MCP_CODE_SERVER_ERROR, MCP_HEADER_LAST_EVENT_ID
MCP_HEADER_PROTOCOL_VERSION, MCP_HEADER_SESSION_ID, MCP_PROTOCOL_VERSION
MCP_PROTOCOL_VERSION_LEGACY, MCP_PROTOCOL_VERSION_PRIOR, McpContentBlock, McpEventNotFoundError
McpJSONRecord, McpJSONValue, McpPromptArgument, McpPromptDef, McpPromptHandler, McpPromptMessage
McpPromptRegistry, McpPromptResult, McpRequestID, McpResourceContent, McpResourceContext
McpResourceDef, McpResourceHandler, McpResourceRegistry, McpResourceTemplateDef, McpRPCError
McpRPCRequest, McpRPCResponse, McpServer, McpServerOptions, McpSession, McpSessionNotFoundError
McpSessionStore, McpSSEEvent, McpStreamEvent, McpStreamingToolHandler, McpStreamNotFoundError
McpStreamStore, McpTask, McpTaskInvalidCursorError, McpTaskListRequest, McpTaskListResult
McpTaskLookup, McpTaskMetadata, McpTaskNotFoundError, McpTaskRecord, McpTaskRuntimeOptions
McpTaskStatus, McpTaskStore, McpTaskSupport, McpTaskTerminalError, McpTestHarness
McpTestHarnessOptions, McpTestInvokeOptions, McpTestResult, McpTestSSEFrame, McpToolContext
McpToolDef, McpToolExecution, McpToolHandler, McpToolRegistry, McpToolResult, MemoryMcpSessionStore
MemoryMcpStreamStore, MemoryMcpTaskStore, MemoryMicroVMSessionRegistry, MetricRecord
MICROVM_AWS_LAMBDA_PROVIDER_ID, MICROVM_CONTRACT_NAME, MICROVM_CONTRACT_VERSION
MICROVM_CONTRACT_VERSION_M16, MICROVM_CONTROLLER_AUTH_DEFAULT_DENY
MICROVM_DEFAULT_SESSION_PROVIDER_ID, MICROVM_ENV_EGRESS_NETWORK_CONNECTOR_REFS
MICROVM_ENV_EXECUTION_ROLE_ARN, MICROVM_ENV_IMAGE_REF, MICROVM_ENV_INGRESS_NETWORK_CONNECTOR_REFS
MICROVM_ENV_NETWORK_CONNECTOR_REFS, MICROVM_ERROR_CONTROLLER_COMMAND_FAILED
MICROVM_ERROR_CONTROLLER_INCOMPLETE, MICROVM_ERROR_FORBIDDEN_FIELD, MICROVM_ERROR_INVALID_CONTRACT
MICROVM_ERROR_INVALID_CONTROLLER_REQUEST, MICROVM_ERROR_INVALID_LIFECYCLE_EVENT
MICROVM_ERROR_LIFECYCLE_BYPASS, MICROVM_ERROR_LIFECYCLE_HOOK_FAILED
MICROVM_ERROR_LIFECYCLE_INCOMPLETE, MICROVM_ERROR_OPERATION_CONTRACT_INCOMPLETE
MICROVM_ERROR_PROVIDER_OPERATION_FAILED, MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED
MICROVM_ERROR_PROVIDER_REQUEST_INVALID, MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE
MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH, MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE
MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE, MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE
MICROVM_ERROR_TENANT_BINDING_VIOLATION, MICROVM_ERROR_TOKEN_SAFETY_VIOLATION
MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER, MICROVM_SESSION_REGISTRY_MODEL_NAME
MICROVM_SESSION_REGISTRY_TABLE_ENV, MICROVM_SESSION_REGISTRY_TABLE_NAME, MicroVMAuthContext
MicroVMClient, MicroVMClientCall, MicroVMClock, MicroVMCommand, MicroVMCommandName
MicroVMContractKind, MicroVMController, MicroVMControllerAuthContract
MicroVMControllerCommandContract, MicroVMControllerContract, MicroVMControllerDeploymentDefaults
MicroVMControllerEnvelopeContract, MicroVMControllerInvokeRequest, MicroVMControllerOptions
MicroVMControllerRequest, MicroVMControllerResponse, MicroVMControllerRouteTarget
MicroVMCreateSessionInput, MicroVMEscapeHatches, MicroVMHook, MicroVMIDGenerator
MicroVMLifecycleAdapter, MicroVMLifecycleAdapterOptions, MicroVMLifecycleContract
MicroVMLifecycleEvent, MicroVMLifecycleHandler, MicroVMLifecycleHook, MicroVMLifecycleHookSpec
MicroVMLifecycleResult, MicroVMLifecycleState, MicroVMLifecycleTransition, MicroVMOperation
MicroVMOperationContract, MicroVMOperationHTTPRouteContract, MicroVMOperationName, MicroVMProvider
MicroVMProviderCall, MicroVMProviderIdlePolicy, MicroVMProviderInvokeInput
MicroVMProviderInvokeOutput, MicroVMProviderListInput, MicroVMProviderListOutput
MicroVMProviderPortScope, MicroVMProviderRunInput, MicroVMProviderSession
MicroVMProviderSessionBinding, MicroVMProviderSessionInput, MicroVMProviderStateMapping
MicroVMProviderToken, MicroVMProviderTokenInput, MicroVMRealController, MicroVMRealHook
MicroVMRealLifecycleHook, MicroVMRealLifecycleState, MicroVMRealState, MicroVMRegistryClient
MicroVMRegistryClientOptions, MicroVMSafeError, MicroVMSessionCommandInput
microVMSessionFromRegistryRecord, microVMSessionKey, MicroVMSessionKey, MicroVMSessionListInput
MicroVMSessionQueryInput, MicroVMSessionReconstructionHook, MicroVMSessionReconstructionRequest
MicroVMSessionRecord, microVMSessionRecordToRegistryRecord, MicroVMSessionRegistry
MicroVMSessionRegistryContract, microVMSessionRegistryModel, microVMSessionRegistryPartitionKey
MicroVMSessionRegistryRecord, microVMSessionRegistrySortKey, microVMSessionRegistryTableName
MicroVMSessionSpec, MicroVMSessionStatus, MicroVMSessionTokenMetadata
microVMSessionTokenMetadataFromProviderToken, MicroVMState, MicroVMTableTheoryClient
MicroVMTenantBindingRule, MicroVMTokenIssuanceContract, Middleware, min, minLength
MultiWindowStrategy, newAuthorizationServerMetadata, newError, newJobLedgerError
newMemoryBearerTokenValidator, newPKCECodeVerifier, newProtectedResourceMetadata
normalizeDynamoDBStreamRecord, normalizeEventBridgeScheduledWorkload
normalizeEventBridgeWorkloadEnvelope, normalizeHTTPErrorFormat, normalizeStage, OAuthBearerError
ObjectRef, ObjectStore, OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG
OBJECTSTORE_ERROR_INVALID_GET_LIMIT, OBJECTSTORE_ERROR_INVALID_REF
OBJECTSTORE_ERROR_INVALID_STORE_CONFIG, OBJECTSTORE_ERROR_NOT_FOUND
OBJECTSTORE_ERROR_OBJECT_TOO_LARGE, OBJECTSTORE_ERROR_UNSUPPORTED_OPERATION, ObjectStoreCall
ObjectStoreDeleteInput, ObjectStoreError, ObjectStoreGetInput, ObjectStoreGetOutput
ObjectStoreOperation, ObjectStorePutInput, ObservabilityHooks, oneOf, OpenAPIDocument
OpenAPIFieldSource, OpenAPIFieldSpec, OpenAPIFieldType, OpenAPIRequestSpec, OpenAPIResponseSpec
OpenAPIRouteSpec, OpenAPISpec, OpenAPIValidationRuleSpec, originalHost, originalURI, originURL
parseMcpTestSSEFrames, parseObjectRef, pattern, paymentXMLPatterns, pkceChallengeS256
pkceVerifyS256, PolicyDecision, PolicyHook, ProfileLogger, ProfileLoggerOptions
ProtectedResourceMetadata, protectedResourceMetadataHandler, protectedResourceWWWAuthenticate, Query
RandomIdGenerator, rapidConnectXMLPatterns, RateLimitEntry, RateLimiter, RateLimiterError
RateLimitKey, RateLimitStrategy, rateLimitTableName, RateLimitWindow, RealClock
ReconstructingMicroVMSessionRegistry, ReconstructingMicroVMSessionRegistryOptions
reconstructMicroVMSessionRecord, RecordStatus, RefreshLeaseInput, RefreshSemaphoreSlotInput
registerControllerRoutes, registerMicroVMControllerRoutes, ReleaseLeaseInput
ReleaseSemaphoreSlotInput, reportKinesisPutRecordsFailures, Request, requireBearerTokenMiddleware
RequireBearerTokenOptions, required, requiredForbiddenMicroVMOperationFields
requireEventBridgeWorkloadEnvelope, resourceMetadataURLFromMcpEndpoint, resourceName, Response
rfc9728ResourceMetadataURL, RouteOptions, S3Encryption, S3EncryptionConfig, S3EncryptionMode
S3ObjectStoreConfig, safeJSONForHTML, sanitizeErrorEnvelope, sanitizeFields, sanitizeFieldValue
sanitizeJSON, sanitizeJSONValue, sanitizeLogString, sanitizeXML, SemaphoreInspection, SemaphoreLease
semaphorePartitionKey, semaphoreSlotSortKey, sequenceIdGenerator, setKeys, setLogger
SlidingWindowStrategy, SNSEntity, SNSEvent, SNSEventRecord, SNSEventRecordInput, SNSHandler
SourceProvenance, SpanRecord, SQSEvent, SQSEventResponse, SQSHandler, SQSMessage, sse, SSEEvent
sseEventStream, stepFunctionsTaskToken, StructuredLogger, TableTheoryMicroVMSessionRegistry
TableTheoryMicroVMSessionRegistryOptions, TestEnv, text, Tier, TimeoutConfig, timeoutMiddleware
TimeWindow, TransitionJobStatusInput, TypedHandler, unixSeconds, unsupportedObjectStoreOperation
UpsertRecordStatusInput, UsageStats, UsageWindow, validateDynamicClientRegistrationRequest
validateLoggingProfile, validateMicroVMControllerContract, validateMicroVMControllerRequest
validateMicroVMEscapeHatches, validateMicroVMLifecycleContract, validateMicroVMOperationContract
validateMicroVMProviderListInput, validateMicroVMProviderRunInput, validateMicroVMProviderSession
validateMicroVMProviderSessionInput, validateMicroVMProviderToken, validateMicroVMProviderTokenInput
validateMicroVMRealLifecycleContract, validateMicroVMSessionRecord
validateMicroVMSessionRegistryContract, validateMicroVMSessionRegistryRecord
validateMicroVMSessionStatus, validateMicroVMSessionTokenMetadata, validateObjectRef
validateOrThrow, validatePKCECodeVerifier, validateValue, VALIDATION_RULE_ENUM, VALIDATION_RULE_MAX
VALIDATION_RULE_MAX_LENGTH, VALIDATION_RULE_MIN, VALIDATION_RULE_MIN_LENGTH, VALIDATION_RULE_PATTERN
VALIDATION_RULE_REQUIRED, validationError, ValidationFieldError, ValidationRuleName
ValidationRuleSpec, ValidationSchema, vary, WebSocketCall, WebSocketClientFactory, WebSocketContext
WebSocketManagementClient, WebSocketManagementClientLike, WindowConfig, WindowLimit, wrapError
wrapJobLedgerError, XMLSanitizationPattern
```

</details>
<!-- apptheory-api-docs:ts:end -->
