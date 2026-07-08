# AppTheory Python Documentation

<!-- AI Training: This is the OFFICIAL documentation index for AppTheory Python -->
**This directory contains the OFFICIAL package-local documentation for the AppTheory Python package (`apptheory`). For canonical cross-language external guidance, start at `docs/README.md`; use this directory for Python-specific quick starts, package build details, and maintainer-facing mirrors.**

## Quick links

### 🚀 Getting started
- [Getting Started](./getting-started.md) — install and run your first route locally.
- [Canonical Getting Started](../../docs/getting-started.md) — cross-language onboarding under the canonical docs root.

### 📚 Core documentation
- [Docs Contract](./_contract.yaml) — canonical Python package knowledgebase scope: fixed ingestible, optional ingestible, and contract-only docs.
- [API Reference](./api-reference.md) — key exports and where to find the authoritative public surface.
- [Core Patterns](./core-patterns.md) — routing, middleware, streaming, SSE, and error patterns.
- [Development Guidelines](./development-guidelines.md) — contract-only maintainer guidance for keeping the package docs set aligned.
- [Testing Guide](./testing-guide.md) — unit tests, contract tests, and repo gates.
- [Troubleshooting](./troubleshooting.md) — common failures and fixes.
- [Migration Guide](./migration-guide.md) — moving from raw handlers/frameworks.
- [Canonical Docs Index](../../docs/README.md) — canonical external navigation root for AppTheory.

### 🤖 AI knowledge base (YAML triad)
- Docs Contract: `py/docs/_contract.yaml`
- Concepts: `py/docs/_concepts.yaml`
- Patterns: `py/docs/_patterns.yaml`
- Decisions: `py/docs/_decisions.yaml`

## Package-local scope

- `docs/` is the canonical external docs root for AppTheory.
- `py/docs/` remains an official package-local surface for Python-specific examples and authoring details.
- Reflect shared user-facing guidance in `docs/` before treating `py/docs/` content as complete.
- `py/docs/_contract.yaml` and `py/docs/development-guidelines.md` are contract-only maintainer surfaces and should not be treated as user-facing knowledgebase content.
- `api-snapshots/py.txt` and `py/README.md` are sanctioned optional sources when a knowledgebase needs export-level or package-root context.

## Contract note

Portable behavior is defined by the fixture-backed contract:
`docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md`.

## Python semantic API map

The generated snapshot coverage index below proves export-name coverage only; it is not a substitute for
operator-facing API guidance. Keep these human-authored groups current when the Python surface grows:

- Runtime app model: `App`, `create_app`, `Context`, `Request`, `Response`, `create_test_env`, middleware hooks, and
  response helpers.
- AWS adapters and test builders: `build_apigw_v2_request`, `build_lambda_function_url_request`,
  `build_appsync_event`, `build_sqs_event`, `build_kinesis_event`, and the corresponding `serve_*` entrypoints.
- MCP/OAuth surfaces: `McpServer`, registries, in-memory/Dynamo stores, bearer-token middleware, metadata handlers,
  DCR, PKCE, and protected-resource helpers.
- Storage and data helpers: `ObjectStore`, `ObjectRef`, `create_s3_object_store`, `DynamoJobLedger`, and rate-limit
  primitives.
- Semantic vector helpers: `VectorStore`, `VectorRecord`, `QueryHit`, `SemanticIndex`, `SemanticRecord`,
  `FakeVectorStore`, `create_fake_vector_store`, `FakeEmbedder`, `S3VectorStore`, `create_s3_vector_store`,
  `S3VectorStoreConfig`, `TitanEmbedder`, `TitanEmbedderConfig`, `VectorStoreCall`, `VectorStoreError`,
  `DefaultTitanEmbedTextModelId`, `DefaultEmbeddingDimensions`, `DefaultQueryTopK`, `MaxQueryTopK`,
  `MaxPutDeleteBatchSize`, `VECTORSTORE_ERROR_INVALID_CONFIG`, `VECTORSTORE_ERROR_INVALID_INPUT`,
  `VECTORSTORE_ERROR_INVALID_VECTOR`, `VECTORSTORE_ERROR_DIMENSION_MISMATCH`, `VECTORSTORE_ERROR_EMBEDDING_FAILED`,
  `VECTORSTORE_ERROR_NOT_FOUND`, `VECTORSTORE_ERROR_UNSUPPORTED_OPERATION`, `EnvVectorBucketName`,
  `EnvVectorIndexName`, `EnvVectorIndexArn`, `EnvVectorDimension`, `EnvEmbeddingProvider`, `EnvEmbeddingModelId`,
  `EnvEmbeddingDimensions`, `EnvEmbeddingNormalize`,
  `PutVectorsInput`, `GetVectorsInput`, `DeleteVectorsInput`, `QueryVectorsInput`, `SemanticIndexConfig`,
  `normalize_top_k`, `validate_dimension`, `validate_vector`, and `validate_required_metadata`.
- MicroVM and generated contract helpers: `MicroVMController`, provider/session validators, and `generate_openapi`.

<!-- apptheory-api-docs:py:start -->
## Python snapshot coverage index

This index is maintained with `scripts/verify-api-docs.sh` so handwritten docs cannot drift from `api-snapshots/py.txt`.

<details>
<summary>611 exported top-level symbols</summary>

```text
App, AppError, AppSyncContext, AppSyncResolverEvent, AppSyncResolverInfo, AppSyncResolverRequest
AppTheoryError, AtomicRateLimiter, authorization_server_metadata_handler, AuthorizationServerMetadata, AWSLambdaMicroVMClient, AWSLambdaMicroVMProvider
base_name, bearer_token_claims_from_context, bearer_token_from_headers, BearerTokenClaims, BearerTokenClaimsValidator, BearerTokenRecord
BearerTokenValidationOptions, BearerTokenValidator, binary, bind_handler, bind_request, BindConfig
BindField, body, build_alb_target_group_request, build_apigw_v2_request, build_appsync_event, build_dynamodb_stream_event
build_eventbridge_event, build_kinesis_event, build_lambda_function_url_request, build_sns_event, build_sqs_event, build_stepfunctions_task_token_event
build_websocket_event, built_in_logging_profile_names, cache_control_isr, cache_control_ssg, cache_control_ssr, canonical_resource_url
canonicalize_issuer_url, claude_dynamic_client_registration_policy, client_ip, Clock, cloudwatch_logs_subscription_data, CloudWatchLogsSubscription
CloudWatchLogsSubscriptionLogEvent, CloudWatchLogsSubscriptionSummary, COMMAND_AUTH_TOKEN, COMMAND_CREATE, COMMAND_GET, COMMAND_INVOKE
COMMAND_LIST, COMMAND_RESUME, COMMAND_RUN, COMMAND_SESSION, COMMAND_SHELL_AUTH_TOKEN, COMMAND_SHELL_TOKEN
COMMAND_START, COMMAND_STATUS, COMMAND_STOP, COMMAND_SUSPEND, COMMAND_TERMINATE, Config
Context, CONTEXT_KEY_BEARER_CLAIMS, CONTEXT_KEY_BEARER_TOKEN, CORSConfig, create_app, create_aws_lambda_microvm_client
create_aws_lambda_microvm_provider, create_emf_metric_sink, create_fake_microvm_client, create_fake_microvm_provider, create_fake_object_store, create_fake_vector_store
create_fake_websocket_client_factory, create_kinesis_json_record, create_mcp_server, create_mcp_test_harness, create_memory_microvm_session_registry, create_microvm_controller
create_microvm_lifecycle_adapter, create_microvm_registry_client, create_real_microvm_controller, create_reconstructing_microvm_session_registry, create_s3_object_store, create_s3_vector_store
create_tabletheory_microvm_session_registry, create_test_env, decode_cloudwatch_logs_subscription, decode_logging_profile_json, default_config, default_jobs_config
DEFAULT_JOBS_TABLE_NAME, default_logging_profile, default_mcp_stream_model, default_mcp_task_model, default_microvm_controller_contract, default_microvm_lifecycle_contract
default_microvm_operation_contract, default_microvm_provider_state_mappings, default_microvm_real_lifecycle_contract, default_microvm_session_registry_contract, DEFAULT_STREAM_TABLE_NAME, DEFAULT_TASK_TABLE_NAME
DefaultEmbeddingDimensions, DefaultQueryTopK, DefaultTitanEmbedTextModelId, DeleteVectorsInput, DynamicClientRegistrationPolicy, DynamicClientRegistrationRequest
DynamicClientRegistrationResponse, DynamoDBStreamRecordSummary, DynamoJobLedger, DynamoMcpStreamStore, DynamoMcpTaskStore, DynamoRateLimiter
EMFMetricSink, encode_logging_profile_event, encode_logging_profile_event_with_sanitizer, EnvEmbeddingDimensions, EnvEmbeddingModelId, EnvEmbeddingNormalize
EnvEmbeddingProvider, EnvJobsTableName, EnvVectorBucketName, EnvVectorDimension, EnvVectorIndexArn, EnvVectorIndexName
ERR_BEARER_TOKEN_EXPIRED, ERR_BEARER_TOKEN_INSUFFICIENT_SCOPE, ERR_BEARER_TOKEN_INVALID_AUDIENCE, ERR_INVALID_AUTHORIZATION_HEADER, ERR_INVALID_BEARER_TOKEN, ERR_INVALID_URL
ERR_MISSING_BEARER_TOKEN, ErrorType, etag, event_bridge_pattern, event_bridge_rule, EventBridgeScheduledWorkloadResultSummary
EventBridgeScheduledWorkloadSummary, EventBridgeSelector, EventBridgeWorkloadEnvelope, EventContext, FakeEmbedder, FakeMicroVMClient
FakeMicroVMProvider, FakeObjectStore, FakeVectorStore, FakeWebSocketClientFactory, FakeWebSocketManagementClient, fixed_mcp_id_generator
FixedWindowStrategy, format_duration, format_rfc3339_nano, format_window_id, generate_openapi, generate_openapi_json
get_day_window, get_fixed_window, get_hour_window, get_logger, get_minute_window, GetVectorsInput
header, HOOK_FAILURE, HOOK_PREPARE_IMAGE, HOOK_READINESS, HOOK_READY, HOOK_RESUME
HOOK_RUN, HOOK_START, HOOK_STOP, HOOK_SUSPEND, HOOK_TEARDOWN, HOOK_TERMINATE
HOOK_VALIDATE, hooks_from_emf_metric_sink, hooks_from_logger, hooks_from_profile_logger, html, html_stream
HTTP_ERROR_FORMAT_FLAT_LEGACY, HTTP_ERROR_FORMAT_NESTED, IdGenerator, IDGenerator, is_microvm_terminal_state, is_supported_profile_output_field
job_lock_sort_key, job_meta_sort_key, job_partition_key, job_record_sort_key, job_request_sort_key, JobLedgerError
jobs_table_name, JobsConfig, json, kinesis_cloudwatch_logs_subscription_record, KinesisJsonRecord, KinesisJsonRecordSummary
KinesisPutRecordsFailure, KinesisPutRecordsFailureReport, KinesisPutRecordsFailureReportSummary, KinesisPutRecordsResultRecord, Limit, LimitDecision
Limits, logging_profile_catalog, LOGGING_PROFILE_CLOUDWATCH_JSON, LOGGING_PROFILE_LEGACY, LOGGING_PROFILE_LOCAL_DEV, LOGGING_PROFILE_PAYTHEORY_ALERT_V1
LOGGING_PROFILE_SCHEMA_VERSION, logging_profile_validation_errors, LoggingProfileAlertingHints, LoggingProfileConfig, LoggingProfileEncoding, LoggingProfileEnrichment
LoggingProfileError, LoggingProfileErrorCapture, LoggingProfileEvent, LoggingProfileJobContext, LoggingProfileRequestContext, LoggingProfileSanitization
LoggingProfileSanitizer, LoggingProfileValidationError, ManualClock, ManualIdGenerator, map_microvm_provider_state, mask_first_last
mask_first_last4, matches_if_none_match, max_length, max_value, MaxPutDeleteBatchSize, MaxQueryTopK
MCP_CODE_INTERNAL_ERROR, MCP_CODE_INVALID_PARAMS, MCP_CODE_INVALID_REQUEST, MCP_CODE_METHOD_NOT_FOUND, MCP_CODE_PARSE_ERROR, MCP_CODE_SERVER_ERROR
MCP_HEADER_LAST_EVENT_ID, MCP_HEADER_PROTOCOL_VERSION, MCP_HEADER_SESSION_ID, MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION_LEGACY, MCP_PROTOCOL_VERSION_PRIOR
McpContentBlock, McpEventNotFoundError, McpJSONRecord, McpJSONValue, McpPromptArgument, McpPromptDef
McpPromptHandler, McpPromptMessage, McpPromptRegistry, McpPromptResult, McpRequestID, McpResourceContent
McpResourceContext, McpResourceDef, McpResourceHandler, McpResourceRegistry, McpResourceTemplateDef, McpRPCError
McpRPCRequest, McpRPCResponse, McpServer, McpServerOptions, McpSession, McpSessionNotFoundError
McpSessionStore, McpSSEEvent, McpStreamEvent, McpStreamingToolHandler, McpStreamNotFoundError, McpStreamStore
McpTask, McpTaskInvalidCursorError, McpTaskListRequest, McpTaskListResult, McpTaskLookup, McpTaskNotFoundError
McpTaskRecord, McpTaskRuntimeOptions, McpTaskStatus, McpTaskStore, McpTaskSupport, McpTaskTerminalError
McpTestHarness, McpTestResult, McpTestSSEFrame, McpToolContext, McpToolDef, McpToolExecution
McpToolHandler, McpToolRegistry, McpToolResult, MemoryMcpSessionStore, MemoryMcpStreamStore, MemoryMcpTaskStore
MemoryMicroVMSessionRegistry, MICROVM_AWS_LAMBDA_PROVIDER_ID, MICROVM_CONTRACT_NAME, MICROVM_CONTRACT_VERSION, MICROVM_CONTRACT_VERSION_M16, MICROVM_CONTROLLER_AUTH_DEFAULT_DENY
MICROVM_DEFAULT_SESSION_PROVIDER_ID, MICROVM_ENV_EGRESS_NETWORK_CONNECTOR_REFS, MICROVM_ENV_EXECUTION_ROLE_ARN, MICROVM_ENV_IMAGE_REF, MICROVM_ENV_INGRESS_NETWORK_CONNECTOR_REFS, MICROVM_ENV_NETWORK_CONNECTOR_REFS
MICROVM_ERROR_CONTROLLER_COMMAND_FAILED, MICROVM_ERROR_CONTROLLER_INCOMPLETE, MICROVM_ERROR_FORBIDDEN_FIELD, MICROVM_ERROR_INVALID_CONTRACT, MICROVM_ERROR_INVALID_CONTROLLER_REQUEST, MICROVM_ERROR_INVALID_LIFECYCLE_EVENT
MICROVM_ERROR_LIFECYCLE_BYPASS, MICROVM_ERROR_LIFECYCLE_HOOK_FAILED, MICROVM_ERROR_LIFECYCLE_INCOMPLETE, MICROVM_ERROR_OPERATION_CONTRACT_INCOMPLETE, MICROVM_ERROR_PROVIDER_OPERATION_FAILED, MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED
MICROVM_ERROR_PROVIDER_REQUEST_INVALID, MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE, MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH, MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE, MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE, MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE
MICROVM_ERROR_TENANT_BINDING_VIOLATION, MICROVM_ERROR_TOKEN_SAFETY_VIOLATION, MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER, microvm_session_from_registry_record, microvm_session_key, microvm_session_record_to_registry_record
microvm_session_registry_model_definition, MICROVM_SESSION_REGISTRY_MODEL_NAME, microvm_session_registry_partition_key, microvm_session_registry_sort_key, MICROVM_SESSION_REGISTRY_TABLE_ENV, MICROVM_SESSION_REGISTRY_TABLE_NAME
microvm_session_registry_table_name, microvm_session_token_metadata_from_provider_token, MicroVMAuthContext, MicroVMClientCall, MicroVMCommand, MicroVMController
MicroVMControllerAuthContract, MicroVMControllerCommandContract, MicroVMControllerContract, MicroVMControllerDeploymentDefaults, MicroVMControllerEnvelopeContract, MicroVMControllerInvokeRequest
MicroVMControllerRequest, MicroVMControllerResponse, MicroVMCreateSessionInput, MicroVMEscapeHatches, MicroVMLifecycleAdapter, MicroVMLifecycleContract
MicroVMLifecycleEvent, MicroVMLifecycleHandler, MicroVMLifecycleHook, MicroVMLifecycleHookSpec, MicroVMLifecycleResult, MicroVMLifecycleState
MicroVMLifecycleTransition, MicroVMProviderCall, MicroVMProviderIdlePolicy, MicroVMProviderInvokeInput, MicroVMProviderInvokeOutput, MicroVMProviderListInput
MicroVMProviderListOutput, MicroVMProviderPortScope, MicroVMProviderRunInput, MicroVMProviderSession, MicroVMProviderSessionBinding, MicroVMProviderSessionInput
MicroVMProviderToken, MicroVMProviderTokenInput, MicroVMRealController, MicroVMRegistryClient, MicroVMSafeError, MicroVMSessionCommandInput
MicroVMSessionListInput, MicroVMSessionQueryInput, MicroVMSessionReconstructionHook, MicroVMSessionReconstructionRequest, MicroVMSessionRecord, MicroVMSessionRegistryContract
MicroVMSessionRegistryRecord, MicroVMSessionSpec, MicroVMSessionStatus, MicroVMSessionTokenMetadata, min_length, min_value
MultiWindowStrategy, new_authorization_server_metadata, new_error, new_job_ledger_error, new_memory_bearer_token_validator, new_pkce_code_verifier
new_protected_resource_metadata, NoOpLogger, normalize_dynamodb_stream_record, normalize_eventbridge_scheduled_workload, normalize_eventbridge_workload_envelope, normalize_stage
normalize_top_k, OAuthBearerError, ObjectRef, ObjectStore, OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG, OBJECTSTORE_ERROR_INVALID_GET_LIMIT
OBJECTSTORE_ERROR_INVALID_REF, OBJECTSTORE_ERROR_INVALID_STORE_CONFIG, OBJECTSTORE_ERROR_NOT_FOUND, OBJECTSTORE_ERROR_OBJECT_TOO_LARGE, OBJECTSTORE_ERROR_UNSUPPORTED_OPERATION, ObjectStoreCall
ObjectStoreDeleteInput, ObjectStoreError, ObjectStoreGetInput, ObjectStoreGetOutput, ObjectStoreOperation, ObjectStorePutInput
ObservabilityHooks, one_of, OpenAPIFieldSpec, OpenAPIRequestSpec, OpenAPIResponseSpec, OpenAPIRouteSpec
OpenAPISpec, OpenAPIValidationRule, OPERATION_AUTH_TOKEN, OPERATION_GET, OPERATION_INVOKE, OPERATION_LIST
OPERATION_RESUME, OPERATION_RUN, OPERATION_SHELL_AUTH_TOKEN, OPERATION_SHELL_TOKEN, OPERATION_SUSPEND, OPERATION_TERMINATE
origin_url, original_host, original_uri, parse_mcp_test_sse_frames, parse_object_ref, path
pattern, payment_xml_patterns, pkce_challenge_s256, pkce_verify_s256, PolicyDecision, ProfileLogger
ProfileLoggerOptions, protected_resource_metadata_handler, protected_resource_www_authenticate, ProtectedResourceMetadata, PutVectorsInput, query
QueryHit, QueryVectorsInput, rapid_connect_xml_patterns, rate_limit_table_name, RateLimitEntry, RateLimiter
RateLimiterError, RateLimitKey, RateLimitStrategy, RateLimitWindow, RealClock, RealIdGenerator
reconstruct_microvm_session_record, ReconstructingMicroVMSessionRegistry, register_controller_routes, register_microvm_controller_routes, report_kinesis_put_records_failures, Request
require_bearer_token_middleware, require_eventbridge_workload_envelope, RequireBearerTokenOptions, required, required_forbidden_microvm_operation_fields, resource_metadata_url_from_mcp_endpoint
resource_name, Response, rfc9728_resource_metadata_url, S3_ENCRYPTION_BUCKET_DEFAULT, S3_ENCRYPTION_KMS, S3_ENCRYPTION_S3_MANAGED
S3EncryptionConfig, S3EncryptionMode, S3ObjectStoreConfig, S3VectorStore, S3VectorStoreConfig, safe_json_for_html
sanitize_error_envelope, sanitize_field_value, sanitize_fields, sanitize_json, sanitize_json_value, sanitize_log_string
sanitize_xml, SemanticIndex, SemanticIndexConfig, SemanticRecord, sequence_mcp_id_generator, set_keys
set_logger, SlidingWindowStrategy, SourceProvenance, sse, sse_event_stream, SSEEvent
STATE_FAILED, STATE_IMAGE_PREPARED, STATE_IMAGE_PREPARING, STATE_READINESS_PROBING, STATE_READY, STATE_REQUESTED
STATE_RESUMING, STATE_RUNNING, STATE_STARTED, STATE_STARTING, STATE_STOPPED, STATE_STOPPING
STATE_SUSPENDED, STATE_SUSPENDING, STATE_TEARING_DOWN, STATE_TERMINATED, STATE_TERMINATING, STATE_VALIDATED
STATE_VALIDATING, stepfunctions_task_token, StreamResult, StructuredLogger, TableTheoryMicroVMSessionRegistry, TestEnv
text, timeout_middleware, TimeoutConfig, TimeWindow, TitanEmbedder, TitanEmbedderConfig
unix_seconds, unsupported_object_store_operation, UsageStats, UsageWindow, validate_dimension, validate_dynamic_client_registration_request
validate_logging_profile, validate_microvm_controller_contract, validate_microvm_controller_request, validate_microvm_escape_hatches, validate_microvm_lifecycle_contract, validate_microvm_operation_contract
validate_microvm_provider_invoke_input, validate_microvm_provider_list_input, validate_microvm_provider_run_input, validate_microvm_provider_session, validate_microvm_provider_session_input, validate_microvm_provider_token
validate_microvm_provider_token_input, validate_microvm_real_lifecycle_contract, validate_microvm_session_record, validate_microvm_session_registry_contract, validate_microvm_session_registry_record, validate_microvm_session_status
validate_microvm_session_token_metadata, validate_object_ref, validate_or_raise, validate_pkce_code_verifier, validate_required_metadata, validate_value
validate_vector, validation_error, VALIDATION_RULE_ENUM, VALIDATION_RULE_MAX, VALIDATION_RULE_MAX_LENGTH, VALIDATION_RULE_MIN
VALIDATION_RULE_MIN_LENGTH, VALIDATION_RULE_PATTERN, VALIDATION_RULE_REQUIRED, ValidationFieldError, ValidationRule, vary
VectorRecord, VectorStore, VECTORSTORE_ERROR_DIMENSION_MISMATCH, VECTORSTORE_ERROR_EMBEDDING_FAILED, VECTORSTORE_ERROR_INVALID_CONFIG, VECTORSTORE_ERROR_INVALID_INPUT
VECTORSTORE_ERROR_INVALID_VECTOR, VECTORSTORE_ERROR_NOT_FOUND, VECTORSTORE_ERROR_UNSUPPORTED_OPERATION, VectorStoreCall, VectorStoreError, WebSocketCall
WebSocketContext, WindowConfig, WindowLimit, wrap_error, wrap_job_ledger_error
```

</details>
<!-- apptheory-api-docs:py:end -->
