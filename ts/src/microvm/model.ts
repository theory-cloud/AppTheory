import type { Model } from "@theory-cloud/tabletheory-ts";
import type { Headers, Query } from "../types.js";

export const MICROVM_CONTRACT_NAME = "apptheory.lambda_microvm";

export const MICROVM_CONTRACT_VERSION = "m15.microvm/v1";

export const MICROVM_ENV_EXECUTION_ROLE_ARN =
  "APPTHEORY_MICROVM_EXECUTION_ROLE_ARN";

export const MICROVM_ENV_IMAGE_REF = "APPTHEORY_MICROVM_IMAGE_REF";

export const MICROVM_ENV_NETWORK_CONNECTOR_REFS =
  "APPTHEORY_MICROVM_NETWORK_CONNECTOR_REFS";

export const MICROVM_ENV_INGRESS_NETWORK_CONNECTOR_REFS =
  "APPTHEORY_MICROVM_INGRESS_NETWORK_CONNECTOR_REFS";

export const MICROVM_ENV_EGRESS_NETWORK_CONNECTOR_REFS =
  "APPTHEORY_MICROVM_EGRESS_NETWORK_CONNECTOR_REFS";

export const MICROVM_ERROR_INVALID_CONTRACT = "m15.microvm.invalid_contract";

export const MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH =
  "m15.microvm.raw_sdk_escape_hatch";

export const MICROVM_ERROR_LIFECYCLE_BYPASS = "m15.microvm.lifecycle_bypass";

export const MICROVM_ERROR_LIFECYCLE_INCOMPLETE =
  "m15.microvm.lifecycle_incomplete";

export const MICROVM_ERROR_FORBIDDEN_FIELD = "m15.microvm.forbidden_field";

export const MICROVM_ERROR_INVALID_LIFECYCLE_EVENT =
  "m15.microvm.invalid_lifecycle_event";

export const MICROVM_ERROR_LIFECYCLE_HOOK_FAILED =
  "m15.microvm.lifecycle_hook_failed";

export const MicroVMHook = {
  PrepareImage: "prepare_image",
  Start: "start",
  Readiness: "readiness",
  Stop: "stop",
  Teardown: "teardown",
  Failure: "failure",
} as const;

export type MicroVMLifecycleHook =
  (typeof MicroVMHook)[keyof typeof MicroVMHook];

export const MicroVMState = {
  Requested: "requested",
  ImagePreparing: "image_preparing",
  ImagePrepared: "image_prepared",
  Starting: "starting",
  Started: "started",
  ReadinessProbing: "readiness_probing",
  Ready: "ready",
  Stopping: "stopping",
  Stopped: "stopped",
  TearingDown: "tearing_down",
  Terminated: "terminated",
  Failed: "failed",
} as const;

export type MicroVMLifecycleState =
  (typeof MicroVMState)[keyof typeof MicroVMState];

export interface MicroVMEscapeHatches {
  raw_aws_sdk?: boolean;
  raw_lifecycle_hook_bypass?: boolean;
}

export interface MicroVMLifecycleHookSpec {
  name: MicroVMLifecycleHook | string;
  phase: string;
  state: MicroVMLifecycleState | string;
  success_state: MicroVMLifecycleState | string;
  failure_state: MicroVMLifecycleState | string;
}

export interface MicroVMLifecycleTransition {
  from: MicroVMLifecycleState | string;
  hook: MicroVMLifecycleHook | string;
  to: MicroVMLifecycleState | string;
}

export interface MicroVMLifecycleContract {
  hooks: MicroVMLifecycleHookSpec[];
  states: Array<MicroVMLifecycleState | string>;
  terminal_states: Array<MicroVMLifecycleState | string>;
  transitions: MicroVMLifecycleTransition[];
}

export interface MicroVMLifecycleEvent {
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  hook: MicroVMLifecycleHook | string;
  state: MicroVMLifecycleState | string;
  metadata?: Record<string, string>;
}

export interface MicroVMLifecycleResult {
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  hook: MicroVMLifecycleHook | string;
  previous_state: MicroVMLifecycleState | string;
  state: MicroVMLifecycleState | string;
  metadata?: Record<string, string>;
  error?: MicroVMSafeError;
}

export type MicroVMLifecycleHandler = (
  event: MicroVMLifecycleEvent,
) => Promise<void> | void;

export interface MicroVMLifecycleAdapterOptions {
  contract?: MicroVMLifecycleContract;
  handlers?: Partial<
    Record<
      MicroVMLifecycleHook | MicroVMRealLifecycleHook,
      MicroVMLifecycleHandler
    >
  >;
}

export class MicroVMSafeError extends Error {
  readonly code: string;
  readonly request_id?: string;

  constructor(code: string, message: string, requestID = "") {
    super(String(message ?? "").trim());
    this.name = "MicroVMSafeError";
    this.code = String(code ?? "").trim();
    const trimmedRequestID = String(requestID ?? "").trim();
    if (trimmedRequestID) this.request_id = trimmedRequestID;
  }
}

export const MICROVM_CONTRACT_VERSION_M16 = "m16.microvm/v1";

export const MICROVM_ERROR_OPERATION_CONTRACT_INCOMPLETE =
  "m16.microvm.operation_contract_incomplete";

export const MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE =
  "m16.microvm.route_contract_incomplete";

export const MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE =
  "m16.microvm.provider_state_mapping_incomplete";

export const MICROVM_ERROR_TOKEN_SAFETY_VIOLATION =
  "m16.microvm.token_safety_violation";

export const MICROVM_ERROR_TENANT_BINDING_VIOLATION =
  "m16.microvm.tenant_binding_violation";

export const MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE =
  "m16.microvm.lifecycle_incomplete";

export const MicroVMOperation = {
  Run: "run",
  Get: "get",
  List: "list",
  Suspend: "suspend",
  Resume: "resume",
  Terminate: "terminate",
  Invoke: "invoke",
  AuthToken: "auth-token",
  ShellAuthToken: "shell-auth-token",
  ShellToken: "shell-auth-token",
} as const;

export type MicroVMOperationName =
  (typeof MicroVMOperation)[keyof typeof MicroVMOperation];

export const MicroVMRealHook = {
  Validate: "validate",
  Run: "run",
  Ready: "ready",
  Suspend: "suspend",
  Resume: "resume",
  Terminate: "terminate",
  Failure: "failure",
} as const;

export type MicroVMRealLifecycleHook =
  (typeof MicroVMRealHook)[keyof typeof MicroVMRealHook];

export const MicroVMRealState = {
  Requested: "requested",
  Validating: "validating",
  Validated: "validated",
  Running: "running",
  Ready: "ready",
  Suspending: "suspending",
  Suspended: "suspended",
  Resuming: "resuming",
  Terminating: "terminating",
  Terminated: "terminated",
  Failed: "failed",
} as const;

export type MicroVMRealLifecycleState =
  (typeof MicroVMRealState)[keyof typeof MicroVMRealState];

export interface MicroVMOperationHTTPRouteContract {
  operation: MicroVMOperationName | string;
  method: string;
  path: string;
  auth_required: boolean;
  default_auth: string;
  tenant_bound: boolean;
  recovery?: boolean;
  request_fields: string[];
  response_fields: string[];
  forbidden_fields?: string[];
}

export interface MicroVMProviderStateMapping {
  provider_state: string;
  state: MicroVMRealLifecycleState | string;
  terminal: boolean;
}

export interface MicroVMTokenIssuanceContract {
  operation: MicroVMOperationName | string;
  result_fields: string[];
  forbidden_fields: string[];
  sanitized: boolean;
  tenant_bound: boolean;
  session_bound: boolean;
  max_ttl_seconds: number;
}

export interface MicroVMTenantBindingRule {
  operation: MicroVMOperationName | string;
  request_tenant_id: string;
  request_namespace: string;
  record_tenant_id: string;
  record_namespace: string;
  recovery?: boolean;
  allowed: boolean;
}

export interface MicroVMOperationContract {
  operations: Array<MicroVMOperationName | string>;
  routes: MicroVMOperationHTTPRouteContract[];
  provider_state_mappings: MicroVMProviderStateMapping[];
  token_issuance: MicroVMTokenIssuanceContract[];
  tenant_binding: MicroVMTenantBindingRule[];
  forbidden_fields: string[];
}

export const MICROVM_ERROR_PROVIDER_REQUEST_INVALID =
  "m16.microvm.provider_request_invalid";

export const MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED =
  "m16.microvm.provider_operation_unsupported";

export const MICROVM_ERROR_PROVIDER_OPERATION_FAILED =
  "m16.microvm.provider_operation_failed";

export interface MicroVMProviderIdlePolicy {
  auto_resume_enabled: boolean;
  max_idle_duration_seconds: number;
  suspended_duration_seconds: number;
}

export interface MicroVMProviderRunInput {
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  auth_context: MicroVMAuthContext;
  image_ref: string;
  image_version?: string;
  network_connector_ref?: string;
  ingress_network_connector_refs?: string[];
  egress_network_connector_refs?: string[];
  session_spec?: MicroVMSessionSpec;
  idle_policy?: MicroVMProviderIdlePolicy;
  maximum_duration_seconds?: number;
  execution_role_arn?: string;
}

export interface MicroVMProviderSessionBinding {
  tenant_id: string;
  namespace: string;
  session_id: string;
  provider_microvm_id: string;
  registry_version?: number;
}

export interface MicroVMProviderSessionInput {
  request_id: string;
  tenant_id: string;
  namespace: string;
  auth_context: MicroVMAuthContext;
  binding: MicroVMProviderSessionBinding;
}

export interface MicroVMProviderListInput {
  request_id: string;
  tenant_id: string;
  namespace: string;
  auth_context: MicroVMAuthContext;
  image_ref?: string;
  image_version?: string;
  max_results?: number;
  known_sessions?: MicroVMProviderSessionBinding[];
}

export interface MicroVMProviderPortScope {
  all_ports?: boolean;
  port?: number;
  start_port?: number;
  end_port?: number;
}

export interface MicroVMProviderTokenInput {
  request_id: string;
  tenant_id: string;
  namespace: string;
  auth_context: MicroVMAuthContext;
  binding: MicroVMProviderSessionBinding;
  ttl_seconds?: number;
  allowed_port_scope?: MicroVMProviderPortScope[];
}

export interface MicroVMProviderInvokeInput {
  request_id: string;
  tenant_id: string;
  namespace: string;
  auth_context: MicroVMAuthContext;
  binding: MicroVMProviderSessionBinding;
  endpoint: string;
  method: string;
  path: string;
  query?: Query;
  headers?: Headers;
  body?: Uint8Array;
  port?: number;
  ttl_seconds?: number;
}

export interface MicroVMProviderInvokeOutput {
  status: number;
  headers?: Headers;
  body?: Uint8Array;
  is_base64?: boolean;
}

export interface MicroVMProviderSession {
  tenant_id: string;
  namespace: string;
  session_id: string;
  provider_microvm_id: string;
  state: MicroVMRealLifecycleState | string;
  provider_state: string;
  endpoint?: string;
  image_ref?: string;
  image_version?: string;
  started_at?: Date;
  terminated_at?: Date;
  registry_version?: number;
  terminal: boolean;
}

export interface MicroVMProviderListOutput {
  sessions: MicroVMProviderSession[];
  recovery_cursor?: string;
}

export interface MicroVMProviderToken {
  tenant_id: string;
  namespace: string;
  session_id: string;
  provider_microvm_id: string;
  token_id: string;
  token_type: string;
  expires_at: Date;
  scope: string[];
}

export interface MicroVMProviderCall {
  operation: MicroVMOperationName | string;
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
}

export interface MicroVMProvider {
  run(input: MicroVMProviderRunInput): Promise<MicroVMProviderSession>;
  get(input: MicroVMProviderSessionInput): Promise<MicroVMProviderSession>;
  list(input: MicroVMProviderListInput): Promise<MicroVMProviderListOutput>;
  suspend(input: MicroVMProviderSessionInput): Promise<MicroVMProviderSession>;
  resume(input: MicroVMProviderSessionInput): Promise<MicroVMProviderSession>;
  terminate(
    input: MicroVMProviderSessionInput,
  ): Promise<MicroVMProviderSession>;
  invoke(
    input: MicroVMProviderInvokeInput,
  ): Promise<MicroVMProviderInvokeOutput>;
  createAuthToken(
    input: MicroVMProviderTokenInput,
  ): Promise<MicroVMProviderToken>;
  createShellToken(
    input: MicroVMProviderTokenInput,
  ): Promise<MicroVMProviderToken>;
}

export interface AWSLambdaMicroVMProviderOptions {
  region?: string;
  clock?: MicroVMClock;
}

export const MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER =
  "m15.microvm.unauthenticated_controller";

export const MICROVM_ERROR_CONTROLLER_INCOMPLETE =
  "m15.microvm.controller_incomplete";

export const MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE =
  "m15.microvm.session_registry_incomplete";

export const MICROVM_ERROR_INVALID_CONTROLLER_REQUEST =
  "m15.microvm.invalid_controller_request";

export const MICROVM_ERROR_CONTROLLER_COMMAND_FAILED =
  "m15.microvm.controller_command_failed";

export const MICROVM_CONTROLLER_AUTH_DEFAULT_DENY = "deny";

export const MICROVM_SESSION_REGISTRY_MODEL_NAME =
  "MicroVMSessionRegistryRecord";

export const MICROVM_SESSION_REGISTRY_TABLE_NAME = "apptheory-microvm-sessions";

export const MICROVM_SESSION_REGISTRY_TABLE_ENV =
  "APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE";

export const MICROVM_DEFAULT_SESSION_PROVIDER_ID = "apptheory.microvm.registry";

export const MICROVM_AWS_LAMBDA_PROVIDER_ID = "aws.lambda.microvm";

export type MicroVMContractKind = "lifecycle" | "controller_session";

export const MicroVMCommand = {
  Create: "create",
  Start: "start",
  Stop: "stop",
  Status: "status",
  Session: "session",
  Run: "run",
  Get: "get",
  List: "list",
  Suspend: "suspend",
  Resume: "resume",
  Terminate: "terminate",
  Invoke: "invoke",
  AuthToken: "auth-token",
  ShellAuthToken: "shell-auth-token",
  ShellToken: "shell-auth-token",
} as const;

export type MicroVMCommandName =
  (typeof MicroVMCommand)[keyof typeof MicroVMCommand];

export interface MicroVMControllerAuthContract {
  required: boolean;
  default: string;
}

export interface MicroVMControllerEnvelopeContract {
  required_fields: string[];
  safe_error_fields: string[];
  forbidden_fields: string[];
}

export interface MicroVMControllerCommandContract {
  name: MicroVMCommandName | string;
  method: string;
  path: string;
  request_fields: string[];
  response_fields: string[];
}

export interface MicroVMControllerContract {
  auth: MicroVMControllerAuthContract;
  envelope: MicroVMControllerEnvelopeContract;
  commands: MicroVMControllerCommandContract[];
}

export interface MicroVMSessionRegistryContract {
  pattern: string;
  tenant_binding: string[];
  required_fields: string[];
  state_values: string[];
  forbidden_fields: string[];
}

export interface MicroVMAuthContext {
  subject: string;
  tenant_id: string;
  namespace?: string;
  entitlements?: string[];
  metadata?: Record<string, string>;
}

export interface MicroVMSessionSpec {
  metadata?: Record<string, string>;
}

export interface MicroVMControllerRequest {
  command: MicroVMCommandName | string;
  request_id: string;
  tenant_id: string;
  namespace: string;
  auth_context: MicroVMAuthContext;
  session_id?: string;
  image_ref?: string;
  image_version?: string;
  network_connector_ref?: string;
  ingress_network_connector_refs?: string[];
  egress_network_connector_refs?: string[];
  session_spec?: MicroVMSessionSpec;
  idle_policy?: MicroVMProviderIdlePolicy;
  maximum_duration_seconds?: number;
  ttl_seconds?: number;
  allowed_port_scope?: MicroVMProviderPortScope[];
  max_results?: number;
}

export interface MicroVMControllerInvokeRequest {
  request_id: string;
  tenant_id: string;
  namespace: string;
  auth_context: MicroVMAuthContext;
  session_id: string;
  method: string;
  path: string;
  query?: Query;
  headers?: Headers;
  body?: Uint8Array;
  port?: number;
  ttl_seconds?: number;
}

export interface MicroVMControllerDeploymentDefaults {
  image_ref?: string;
  network_connector_ref?: string;
  ingress_network_connector_refs?: string[];
  egress_network_connector_refs?: string[];
}

export interface MicroVMControllerResponse {
  command: MicroVMCommandName | string;
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  state?: MicroVMLifecycleState | string;
  desired_state?: MicroVMLifecycleState | string;
  lifecycle_state?: MicroVMLifecycleState | string;
  endpoint?: string;
  microvm_id?: string;
  provider_microvm_id?: string;
  provider_state?: string;
  last_action?: MicroVMCommandName | string;
  last_transition?: Date;
  registry_version?: number;
  sessions?: MicroVMProviderSession[];
  recovery_cursor?: string;
  token_id?: string;
  token_type?: string;
  expires_at?: Date;
  scope?: string[];
  error?: MicroVMSafeError;
}

export interface MicroVMCreateSessionInput {
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  image_ref: string;
  network_connector_ref: string;
  session_spec: MicroVMSessionSpec;
  controller_id: string;
  auth_subject: string;
  now: Date;
}

export interface MicroVMSessionCommandInput {
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  controller_id: string;
  auth_subject: string;
  desired_state: MicroVMLifecycleState | string;
  now: Date;
}

export interface MicroVMSessionQueryInput {
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  auth_subject: string;
}

export interface MicroVMSessionKey {
  tenant_id: string;
  namespace: string;
  session_id: string;
}

export interface MicroVMSessionTokenMetadata {
  token_id: string;
  token_type: string;
  expires_at: Date;
  scope: string[];
}

export interface MicroVMSessionRecord {
  tenant_id: string;
  namespace: string;
  session_id: string;
  state: MicroVMLifecycleState | string;
  desired_state: MicroVMLifecycleState | string;
  endpoint?: string;
  microvm_id?: string;
  provider_id: string;
  provider_microvm_id?: string;
  provider_state: string;
  aws_lifecycle_state: string;
  image_ref: string;
  image_version?: string;
  network_connector_ref: string;
  ingress_network_connector_refs?: string[];
  egress_network_connector_refs?: string[];
  controller_id: string;
  created_at: Date;
  updated_at: Date;
  last_observed_at: Date;
  provider_started_at?: Date;
  provider_terminated_at?: Date;
  expires_at: Date;
  generation: number;
  last_action: MicroVMCommandName | string;
  last_command_id: string;
  auth_subject: string;
  reason_metadata?: Record<string, string>;
  status_metadata?: Record<string, string>;
  token_metadata?: MicroVMSessionTokenMetadata[];
  metadata?: Record<string, string>;
}

export interface MicroVMSessionStatus {
  tenant_id: string;
  namespace: string;
  session_id: string;
  state: MicroVMLifecycleState | string;
  desired_state: MicroVMLifecycleState | string;
  lifecycle_state: MicroVMLifecycleState | string;
  endpoint?: string;
  microvm_id?: string;
  last_action: MicroVMCommandName | string;
  last_transition: Date;
  registry_version: number;
}

export interface MicroVMSessionRegistryRecord {
  pk: string;
  sk: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  state: MicroVMLifecycleState | string;
  desired_state: MicroVMLifecycleState | string;
  endpoint: string;
  microvm_id: string;
  provider_id: string;
  provider_microvm_id: string;
  provider_state: string;
  aws_lifecycle_state: string;
  image_ref: string;
  image_version: string;
  network_connector_ref: string;
  ingress_network_connector_refs: string[];
  egress_network_connector_refs: string[];
  controller_id: string;
  created_at: Date;
  updated_at: Date;
  last_observed_at: Date;
  provider_started_at: Date;
  provider_terminated_at: Date;
  expires_at: Date;
  ttl: number;
  generation: number;
  version: number;
  last_action: MicroVMCommandName | string;
  last_command_id: string;
  auth_subject: string;
  reason_metadata?: Record<string, string>;
  status_metadata?: Record<string, string>;
  token_metadata?: MicroVMSessionTokenMetadata[];
  metadata?: Record<string, string>;
}

export interface MicroVMSessionRegistry {
  put: (record: MicroVMSessionRecord) => Promise<MicroVMSessionRecord>;
  get: (key: MicroVMSessionKey) => Promise<MicroVMSessionRecord>;
  delete: (key: MicroVMSessionKey) => Promise<void>;
  list?: (input: MicroVMSessionListInput) => Promise<MicroVMSessionRecord[]>;
}

export interface MicroVMSessionListInput {
  request_id?: string;
  tenant_id: string;
  namespace: string;
  auth_subject?: string;
}

export interface MicroVMSessionReconstructionRequest {
  request_id?: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  auth_subject?: string;
  now?: Date;
  existing?: MicroVMSessionRecord;
}

export type MicroVMSessionReconstructionHook = (
  request: MicroVMSessionReconstructionRequest,
) => Promise<MicroVMSessionRecord> | MicroVMSessionRecord;

export interface ReconstructingMicroVMSessionRegistryOptions {
  stale_after_ms?: number;
  clock?: MicroVMClock;
}

export interface MicroVMTableTheoryClient {
  register?: (...models: Model[]) => unknown;
  save: (modelName: string, item: Record<string, unknown>) => Promise<void>;
  get: (
    modelName: string,
    key: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  delete: (modelName: string, key: Record<string, unknown>) => Promise<void>;
  list?: (
    modelName: string,
    key: Record<string, unknown>,
  ) => Promise<Array<Record<string, unknown>>>;
}

export interface TableTheoryMicroVMSessionRegistryOptions {
  model_name?: string;
  table_name?: string;
  auto_register?: boolean;
}

export interface MicroVMRegistryClientOptions {
  ttl_ms?: number;
}

export interface MicroVMClient {
  create: (input: MicroVMCreateSessionInput) => Promise<MicroVMSessionRecord>;
  start: (input: MicroVMSessionCommandInput) => Promise<MicroVMSessionRecord>;
  stop: (input: MicroVMSessionCommandInput) => Promise<MicroVMSessionRecord>;
  status: (input: MicroVMSessionQueryInput) => Promise<MicroVMSessionStatus>;
  session: (input: MicroVMSessionQueryInput) => Promise<MicroVMSessionRecord>;
}

export interface MicroVMClock {
  now: () => Date;
}

export interface MicroVMIDGenerator {
  newID: () => string;
}

export interface MicroVMControllerOptions {
  controller_id?: string;
  clock?: MicroVMClock;
  ids?: MicroVMIDGenerator;
  ttl_ms?: number;
  provider_id?: string;
  execution_role_arn?: string;
  deployment_defaults?: MicroVMControllerDeploymentDefaults;
}

export interface MicroVMClientCall {
  command: MicroVMCommandName | string;
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
}

export interface AWSLambdaMicroVMClientOptions {
  region?: string;
}

export interface MicroVMControllerRouteTarget {
  handle: (
    request: MicroVMControllerRequest,
  ) => MicroVMControllerResponse | Promise<MicroVMControllerResponse>;
  invoke?: (
    request: MicroVMControllerInvokeRequest,
  ) => MicroVMProviderInvokeOutput | Promise<MicroVMProviderInvokeOutput>;
}
