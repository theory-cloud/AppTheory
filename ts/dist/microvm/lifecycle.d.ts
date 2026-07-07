import { MicroVMSafeError, type MicroVMLifecycleAdapterOptions, type MicroVMLifecycleContract, type MicroVMLifecycleEvent, type MicroVMLifecycleHook, type MicroVMLifecycleHookSpec, type MicroVMLifecycleResult, type MicroVMLifecycleState, type MicroVMLifecycleTransition, type MicroVMRealLifecycleHook, type MicroVMRealLifecycleState, type MicroVMEscapeHatches } from "./model.js";
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
export declare function validateMicroVMLifecycleHookSpecs(hooks: MicroVMLifecycleHookSpec[]): Map<MicroVMLifecycleHook, MicroVMLifecycleHookSpec>;
export declare function validateMicroVMLifecycleStateLists(contract: MicroVMLifecycleContract): void;
export declare function validateMicroVMLifecycleTransitionSet(hookSpecs: Map<MicroVMLifecycleHook, MicroVMLifecycleHookSpec>, transitions: MicroVMTransitionSet): void;
export declare function validateMicroVMLifecycleFailureTransitions(transitions: MicroVMTransitionSet): void;
export declare function validateMicroVMLifecycleAdapterContract(contract: MicroVMLifecycleContract): void;
export declare function isMicroVMRealLifecycleContractShape(contract: MicroVMLifecycleContract): boolean;
export declare function microVMRealLifecycleOnlyHook(hook: MicroVMLifecycleHook | MicroVMRealLifecycleHook | string): boolean;
export declare function microVMRealLifecycleOnlyState(state: MicroVMLifecycleState | MicroVMRealLifecycleState | string): boolean;
export declare function lifecycleContractValidationError(err: unknown, requestID: string): MicroVMSafeError;
export declare function normalizeMicroVMLifecycleEvent(event: MicroVMLifecycleEvent): MicroVMLifecycleEvent | MicroVMSafeError;
export declare function lifecycleErrorResult(event: MicroVMLifecycleEvent, state: MicroVMLifecycleState | string, error: MicroVMSafeError): MicroVMLifecycleResult;
export declare function buildLifecycleResult(event: MicroVMLifecycleEvent, state: MicroVMLifecycleState | string): MicroVMLifecycleResult;
export declare function requiredMicroVMLifecycleHooks(): MicroVMLifecycleHook[];
export declare function requiredMicroVMLifecycleStates(): MicroVMLifecycleState[];
export declare function preStateForMicroVMHook(hook: MicroVMLifecycleHook): MicroVMLifecycleState | "";
export declare function cloneMicroVMLifecycleContract(contract: MicroVMLifecycleContract): MicroVMLifecycleContract;
export declare function cloneMicroVMLifecycleEvent(event: MicroVMLifecycleEvent): MicroVMLifecycleEvent;
export declare function normalizeMicroVMLifecycleHook(hook: MicroVMLifecycleHook | string): MicroVMLifecycleHook | "";
export declare function normalizeMicroVMLifecycleState(state: MicroVMLifecycleState | string): MicroVMLifecycleState | "";
export interface MicroVMContractIndex {
    hooks: Map<MicroVMLifecycleHook, MicroVMLifecycleHookSpec>;
    transitions: MicroVMTransitionSet;
}
export declare function lifecycleContractIndex(contract: MicroVMLifecycleContract): MicroVMContractIndex;
export interface MicroVMTransitionSet {
    list: MicroVMLifecycleTransition[];
    has: (from: MicroVMLifecycleState | string, hook: MicroVMLifecycleHook | string, to: MicroVMLifecycleState | string) => boolean;
}
export declare function microVMTransitionSet(transitions: MicroVMLifecycleTransition[]): MicroVMTransitionSet;
export declare function microVMNextState(transitions: MicroVMLifecycleTransition[], from: MicroVMLifecycleState | string, hook: MicroVMLifecycleHook | string): MicroVMLifecycleState | "";
export declare function transitionKey(from: MicroVMLifecycleState | string, hook: MicroVMLifecycleHook | string, to: MicroVMLifecycleState | string): string;
//# sourceMappingURL=lifecycle.d.ts.map