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
