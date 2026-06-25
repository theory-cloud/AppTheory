import { type Model } from "@theory-cloud/tabletheory-ts";
export declare const MICROVM_CONTRACT_NAME = "apptheory.lambda_microvm";
export declare const MICROVM_CONTRACT_VERSION = "m15.microvm/v1";
export declare const MICROVM_ERROR_INVALID_CONTRACT = "m15.microvm.invalid_contract";
export declare const MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH = "m15.microvm.raw_sdk_escape_hatch";
export declare const MICROVM_ERROR_LIFECYCLE_BYPASS = "m15.microvm.lifecycle_bypass";
export declare const MICROVM_ERROR_LIFECYCLE_INCOMPLETE = "m15.microvm.lifecycle_incomplete";
export declare const MICROVM_ERROR_FORBIDDEN_FIELD = "m15.microvm.forbidden_field";
export declare const MICROVM_ERROR_INVALID_LIFECYCLE_EVENT = "m15.microvm.invalid_lifecycle_event";
export declare const MICROVM_ERROR_LIFECYCLE_HOOK_FAILED = "m15.microvm.lifecycle_hook_failed";
export declare const MicroVMHook: {
    readonly PrepareImage: "prepare_image";
    readonly Start: "start";
    readonly Readiness: "readiness";
    readonly Stop: "stop";
    readonly Teardown: "teardown";
    readonly Failure: "failure";
};
export type MicroVMLifecycleHook = (typeof MicroVMHook)[keyof typeof MicroVMHook];
export declare const MicroVMState: {
    readonly Requested: "requested";
    readonly ImagePreparing: "image_preparing";
    readonly ImagePrepared: "image_prepared";
    readonly Starting: "starting";
    readonly Started: "started";
    readonly ReadinessProbing: "readiness_probing";
    readonly Ready: "ready";
    readonly Stopping: "stopping";
    readonly Stopped: "stopped";
    readonly TearingDown: "tearing_down";
    readonly Terminated: "terminated";
    readonly Failed: "failed";
};
export type MicroVMLifecycleState = (typeof MicroVMState)[keyof typeof MicroVMState];
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
export type MicroVMLifecycleHandler = (event: MicroVMLifecycleEvent) => Promise<void> | void;
export interface MicroVMLifecycleAdapterOptions {
    contract?: MicroVMLifecycleContract;
    handlers?: Partial<Record<MicroVMLifecycleHook, MicroVMLifecycleHandler>>;
}
export declare class MicroVMSafeError extends Error {
    readonly code: string;
    readonly request_id?: string;
    constructor(code: string, message: string, requestID?: string);
}
export declare function validateMicroVMEscapeHatches(escapeHatches: MicroVMEscapeHatches): void;
export declare function defaultMicroVMLifecycleContract(): MicroVMLifecycleContract;
export declare function validateMicroVMLifecycleContract(contract: MicroVMLifecycleContract): void;
export declare class MicroVMLifecycleAdapter {
    private readonly contract;
    private readonly handlers;
    constructor(options?: MicroVMLifecycleAdapterOptions);
    handle(event: MicroVMLifecycleEvent): Promise<MicroVMLifecycleResult>;
}
export declare function createMicroVMLifecycleAdapter(options?: MicroVMLifecycleAdapterOptions): MicroVMLifecycleAdapter;
export declare function isMicroVMTerminalState(state: MicroVMLifecycleState | string): boolean;
export declare const MICROVM_CONTRACT_VERSION_M16 = "m16.microvm/v1";
export declare const MICROVM_ERROR_OPERATION_CONTRACT_INCOMPLETE = "m16.microvm.operation_contract_incomplete";
export declare const MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE = "m16.microvm.route_contract_incomplete";
export declare const MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE = "m16.microvm.provider_state_mapping_incomplete";
export declare const MICROVM_ERROR_TOKEN_SAFETY_VIOLATION = "m16.microvm.token_safety_violation";
export declare const MICROVM_ERROR_TENANT_BINDING_VIOLATION = "m16.microvm.tenant_binding_violation";
export declare const MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE = "m16.microvm.lifecycle_incomplete";
export declare const MicroVMOperation: {
    readonly Run: "run";
    readonly Get: "get";
    readonly List: "list";
    readonly Suspend: "suspend";
    readonly Resume: "resume";
    readonly Terminate: "terminate";
    readonly AuthToken: "auth-token";
    readonly ShellToken: "shell-token";
};
export type MicroVMOperationName = (typeof MicroVMOperation)[keyof typeof MicroVMOperation];
export declare const MicroVMRealHook: {
    readonly Validate: "validate";
    readonly Run: "run";
    readonly Ready: "ready";
    readonly Suspend: "suspend";
    readonly Resume: "resume";
    readonly Terminate: "terminate";
    readonly Failure: "failure";
};
export type MicroVMRealLifecycleHook = (typeof MicroVMRealHook)[keyof typeof MicroVMRealHook];
export declare const MicroVMRealState: {
    readonly Requested: "requested";
    readonly Validating: "validating";
    readonly Validated: "validated";
    readonly Running: "running";
    readonly Ready: "ready";
    readonly Suspending: "suspending";
    readonly Suspended: "suspended";
    readonly Resuming: "resuming";
    readonly Terminating: "terminating";
    readonly Terminated: "terminated";
    readonly Failed: "failed";
};
export type MicroVMRealLifecycleState = (typeof MicroVMRealState)[keyof typeof MicroVMRealState];
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
export declare function defaultMicroVMRealLifecycleContract(): MicroVMLifecycleContract;
export declare function defaultMicroVMOperationContract(): MicroVMOperationContract;
export declare function defaultMicroVMProviderStateMappings(): MicroVMProviderStateMapping[];
export declare function requiredForbiddenMicroVMOperationFields(): string[];
export declare function validateMicroVMRealLifecycleContract(contract: MicroVMLifecycleContract): void;
export declare function validateMicroVMOperationContract(contract: MicroVMOperationContract): void;
export declare const MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER = "m15.microvm.unauthenticated_controller";
export declare const MICROVM_ERROR_CONTROLLER_INCOMPLETE = "m15.microvm.controller_incomplete";
export declare const MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE = "m15.microvm.session_registry_incomplete";
export declare const MICROVM_ERROR_INVALID_CONTROLLER_REQUEST = "m15.microvm.invalid_controller_request";
export declare const MICROVM_ERROR_CONTROLLER_COMMAND_FAILED = "m15.microvm.controller_command_failed";
export declare const MICROVM_CONTROLLER_AUTH_DEFAULT_DENY = "deny";
export declare const MICROVM_SESSION_REGISTRY_MODEL_NAME = "MicroVMSessionRegistryRecord";
export declare const MICROVM_SESSION_REGISTRY_TABLE_NAME = "apptheory-microvm-sessions";
export declare const MICROVM_SESSION_REGISTRY_TABLE_ENV = "APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE";
export type MicroVMContractKind = "lifecycle" | "controller_session";
export declare const MicroVMCommand: {
    readonly Create: "create";
    readonly Start: "start";
    readonly Stop: "stop";
    readonly Status: "status";
    readonly Session: "session";
};
export type MicroVMCommandName = (typeof MicroVMCommand)[keyof typeof MicroVMCommand];
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
    network_connector_ref?: string;
    session_spec?: MicroVMSessionSpec;
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
    last_action?: MicroVMCommandName | string;
    last_transition?: Date;
    registry_version?: number;
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
export interface MicroVMSessionRecord {
    tenant_id: string;
    namespace: string;
    session_id: string;
    state: MicroVMLifecycleState | string;
    desired_state: MicroVMLifecycleState | string;
    endpoint?: string;
    microvm_id?: string;
    image_ref: string;
    network_connector_ref: string;
    controller_id: string;
    created_at: Date;
    updated_at: Date;
    expires_at: Date;
    generation: number;
    last_action: MicroVMCommandName | string;
    last_command_id: string;
    auth_subject: string;
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
    image_ref: string;
    network_connector_ref: string;
    controller_id: string;
    created_at: Date;
    updated_at: Date;
    expires_at: Date;
    ttl: number;
    generation: number;
    version: number;
    last_action: MicroVMCommandName | string;
    last_command_id: string;
    auth_subject: string;
    metadata?: Record<string, string>;
}
export interface MicroVMSessionRegistry {
    put: (record: MicroVMSessionRecord) => Promise<MicroVMSessionRecord>;
    get: (key: MicroVMSessionKey) => Promise<MicroVMSessionRecord>;
    delete: (key: MicroVMSessionKey) => Promise<void>;
}
export interface MicroVMTableTheoryClient {
    register?: (...models: Model[]) => unknown;
    save: (modelName: string, item: Record<string, unknown>) => Promise<void>;
    get: (modelName: string, key: Record<string, unknown>) => Promise<Record<string, unknown>>;
    delete: (modelName: string, key: Record<string, unknown>) => Promise<void>;
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
export declare function defaultMicroVMControllerContract(): MicroVMControllerContract;
export declare function defaultMicroVMSessionRegistryContract(): MicroVMSessionRegistryContract;
export declare function validateMicroVMControllerContract(contract: MicroVMControllerContract): void;
export declare function validateMicroVMSessionRegistryContract(registry: MicroVMSessionRegistryContract): void;
export declare function validateMicroVMSessionRecord(record: MicroVMSessionRecord): void;
export declare function validateMicroVMSessionStatus(status: MicroVMSessionStatus): void;
export declare function microVMSessionKey(record: MicroVMSessionRecord): MicroVMSessionKey;
export declare function microVMSessionRegistryTableName(): string;
export declare function microVMSessionRegistryPartitionKey(tenantID: string, namespace: string): string;
export declare function microVMSessionRegistrySortKey(sessionID: string): string;
export declare function microVMSessionRegistryModel(tableName?: string): Model;
export declare function validateMicroVMSessionRegistryRecord(record: MicroVMSessionRegistryRecord): void;
export declare function microVMSessionRecordToRegistryRecord(record: MicroVMSessionRecord): MicroVMSessionRegistryRecord;
export declare function microVMSessionFromRegistryRecord(record: MicroVMSessionRegistryRecord): MicroVMSessionRecord;
export declare class MemoryMicroVMSessionRegistry implements MicroVMSessionRegistry {
    private readonly records;
    put(record: MicroVMSessionRecord): Promise<MicroVMSessionRecord>;
    get(key: MicroVMSessionKey): Promise<MicroVMSessionRecord>;
    delete(key: MicroVMSessionKey): Promise<void>;
}
export declare function createMemoryMicroVMSessionRegistry(): MemoryMicroVMSessionRegistry;
export declare class TableTheoryMicroVMSessionRegistry implements MicroVMSessionRegistry {
    private readonly db;
    private readonly modelName;
    constructor(db: MicroVMTableTheoryClient, options?: TableTheoryMicroVMSessionRegistryOptions);
    put(record: MicroVMSessionRecord): Promise<MicroVMSessionRecord>;
    get(key: MicroVMSessionKey): Promise<MicroVMSessionRecord>;
    delete(key: MicroVMSessionKey): Promise<void>;
}
export declare function createTableTheoryMicroVMSessionRegistry(db: MicroVMTableTheoryClient, options?: TableTheoryMicroVMSessionRegistryOptions): TableTheoryMicroVMSessionRegistry;
export declare class MicroVMRegistryClient implements MicroVMClient {
    private readonly registry;
    private readonly ttlMs;
    constructor(registry: MicroVMSessionRegistry, options?: MicroVMRegistryClientOptions);
    create(input: MicroVMCreateSessionInput): Promise<MicroVMSessionRecord>;
    start(input: MicroVMSessionCommandInput): Promise<MicroVMSessionRecord>;
    stop(input: MicroVMSessionCommandInput): Promise<MicroVMSessionRecord>;
    status(input: MicroVMSessionQueryInput): Promise<MicroVMSessionStatus>;
    session(input: MicroVMSessionQueryInput): Promise<MicroVMSessionRecord>;
    private transition;
}
export declare function createMicroVMRegistryClient(registry: MicroVMSessionRegistry, options?: MicroVMRegistryClientOptions): MicroVMRegistryClient;
export declare class MicroVMController {
    private readonly client;
    private readonly controllerID;
    private readonly clock;
    private readonly ids;
    constructor(client: MicroVMClient, options?: MicroVMControllerOptions);
    handle(request: MicroVMControllerRequest): Promise<MicroVMControllerResponse>;
    private handleCreate;
    private handleCommand;
    private handleStatus;
    private handleSession;
}
export declare function createMicroVMController(client: MicroVMClient, options?: MicroVMControllerOptions): MicroVMController;
export declare function validateMicroVMControllerRequest(request: MicroVMControllerRequest): MicroVMSafeError | null;
export declare class FakeMicroVMClient implements MicroVMClient {
    private currentTime;
    private readonly sessions;
    private readonly recordedCalls;
    constructor(now?: Date);
    setNow(now: Date): void;
    calls(): MicroVMClientCall[];
    create(input: MicroVMCreateSessionInput): Promise<MicroVMSessionRecord>;
    start(input: MicroVMSessionCommandInput): Promise<MicroVMSessionRecord>;
    stop(input: MicroVMSessionCommandInput): Promise<MicroVMSessionRecord>;
    status(input: MicroVMSessionQueryInput): Promise<MicroVMSessionStatus>;
    session(input: MicroVMSessionQueryInput): Promise<MicroVMSessionRecord>;
    private transition;
    private lookup;
    private recordCall;
}
export declare function createFakeMicroVMClient(now?: Date): FakeMicroVMClient;
export declare function createAWSLambdaMicroVMClient(options?: AWSLambdaMicroVMClientOptions): Promise<MicroVMClient>;
