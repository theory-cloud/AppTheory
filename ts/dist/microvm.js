import { randomBytes } from "node:crypto";
import { defineModel } from "@theory-cloud/tabletheory-ts";
export const MICROVM_CONTRACT_NAME = "apptheory.lambda_microvm";
export const MICROVM_CONTRACT_VERSION = "m15.microvm/v1";
export const MICROVM_ERROR_INVALID_CONTRACT = "m15.microvm.invalid_contract";
export const MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH = "m15.microvm.raw_sdk_escape_hatch";
export const MICROVM_ERROR_LIFECYCLE_BYPASS = "m15.microvm.lifecycle_bypass";
export const MICROVM_ERROR_LIFECYCLE_INCOMPLETE = "m15.microvm.lifecycle_incomplete";
export const MICROVM_ERROR_FORBIDDEN_FIELD = "m15.microvm.forbidden_field";
export const MICROVM_ERROR_INVALID_LIFECYCLE_EVENT = "m15.microvm.invalid_lifecycle_event";
export const MICROVM_ERROR_LIFECYCLE_HOOK_FAILED = "m15.microvm.lifecycle_hook_failed";
export const MicroVMHook = {
    PrepareImage: "prepare_image",
    Start: "start",
    Readiness: "readiness",
    Stop: "stop",
    Teardown: "teardown",
    Failure: "failure",
};
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
};
export class MicroVMSafeError extends Error {
    code;
    request_id;
    constructor(code, message, requestID = "") {
        super(String(message ?? "").trim());
        this.name = "MicroVMSafeError";
        this.code = String(code ?? "").trim();
        const trimmedRequestID = String(requestID ?? "").trim();
        if (trimmedRequestID)
            this.request_id = trimmedRequestID;
    }
}
export function validateMicroVMEscapeHatches(escapeHatches) {
    if (escapeHatches.raw_aws_sdk === true) {
        throw safeError(MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH, "apptheory: microvm contract forbids raw AWS SDK escape hatch", "");
    }
    if (escapeHatches.raw_lifecycle_hook_bypass === true) {
        throw safeError(MICROVM_ERROR_LIFECYCLE_BYPASS, "apptheory: microvm contract forbids raw lifecycle hook bypass", "");
    }
}
export function defaultMicroVMLifecycleContract() {
    return {
        hooks: [
            {
                name: MicroVMHook.PrepareImage,
                phase: "image_preparation",
                state: MicroVMState.ImagePreparing,
                success_state: MicroVMState.ImagePrepared,
                failure_state: MicroVMState.Failed,
            },
            {
                name: MicroVMHook.Start,
                phase: "start",
                state: MicroVMState.Starting,
                success_state: MicroVMState.Started,
                failure_state: MicroVMState.Failed,
            },
            {
                name: MicroVMHook.Readiness,
                phase: "readiness",
                state: MicroVMState.ReadinessProbing,
                success_state: MicroVMState.Ready,
                failure_state: MicroVMState.Failed,
            },
            {
                name: MicroVMHook.Stop,
                phase: "stop",
                state: MicroVMState.Stopping,
                success_state: MicroVMState.Stopped,
                failure_state: MicroVMState.Failed,
            },
            {
                name: MicroVMHook.Teardown,
                phase: "teardown",
                state: MicroVMState.TearingDown,
                success_state: MicroVMState.Terminated,
                failure_state: MicroVMState.Failed,
            },
            {
                name: MicroVMHook.Failure,
                phase: "failure",
                state: MicroVMState.Failed,
                success_state: MicroVMState.Failed,
                failure_state: MicroVMState.Failed,
            },
        ],
        states: requiredMicroVMLifecycleStates(),
        terminal_states: [MicroVMState.Terminated, MicroVMState.Failed],
        transitions: [
            {
                from: MicroVMState.Requested,
                hook: MicroVMHook.PrepareImage,
                to: MicroVMState.ImagePreparing,
            },
            {
                from: MicroVMState.ImagePreparing,
                hook: MicroVMHook.PrepareImage,
                to: MicroVMState.ImagePrepared,
            },
            {
                from: MicroVMState.ImagePrepared,
                hook: MicroVMHook.Start,
                to: MicroVMState.Starting,
            },
            {
                from: MicroVMState.Starting,
                hook: MicroVMHook.Start,
                to: MicroVMState.Started,
            },
            {
                from: MicroVMState.Started,
                hook: MicroVMHook.Readiness,
                to: MicroVMState.ReadinessProbing,
            },
            {
                from: MicroVMState.ReadinessProbing,
                hook: MicroVMHook.Readiness,
                to: MicroVMState.Ready,
            },
            {
                from: MicroVMState.Ready,
                hook: MicroVMHook.Stop,
                to: MicroVMState.Stopping,
            },
            {
                from: MicroVMState.Stopping,
                hook: MicroVMHook.Stop,
                to: MicroVMState.Stopped,
            },
            {
                from: MicroVMState.Stopped,
                hook: MicroVMHook.Teardown,
                to: MicroVMState.TearingDown,
            },
            {
                from: MicroVMState.TearingDown,
                hook: MicroVMHook.Teardown,
                to: MicroVMState.Terminated,
            },
            {
                from: MicroVMState.ImagePreparing,
                hook: MicroVMHook.Failure,
                to: MicroVMState.Failed,
            },
            {
                from: MicroVMState.Starting,
                hook: MicroVMHook.Failure,
                to: MicroVMState.Failed,
            },
            {
                from: MicroVMState.ReadinessProbing,
                hook: MicroVMHook.Failure,
                to: MicroVMState.Failed,
            },
            {
                from: MicroVMState.Stopping,
                hook: MicroVMHook.Failure,
                to: MicroVMState.Failed,
            },
            {
                from: MicroVMState.TearingDown,
                hook: MicroVMHook.Failure,
                to: MicroVMState.Failed,
            },
        ],
    };
}
export function validateMicroVMLifecycleContract(contract) {
    const hookSpecs = validateMicroVMLifecycleHookSpecs(contract.hooks);
    validateMicroVMLifecycleStateLists(contract);
    validateMicroVMLifecycleTransitionSet(hookSpecs, microVMTransitionSet(contract.transitions));
}
export class MicroVMLifecycleAdapter {
    contract;
    handlers;
    constructor(options = {}) {
        this.contract = cloneMicroVMLifecycleContract(options.contract ?? defaultMicroVMLifecycleContract());
        this.handlers = new Map();
        for (const [hook, handler] of Object.entries(options.handlers ?? {})) {
            const normalizedHook = normalizeMicroVMLifecycleHook(hook);
            if (normalizedHook && handler)
                this.handlers.set(normalizedHook, handler);
        }
        validateMicroVMLifecycleContract(this.contract);
    }
    async handle(event) {
        try {
            validateMicroVMLifecycleContract(this.contract);
        }
        catch (err) {
            const safe = safeError(MICROVM_ERROR_LIFECYCLE_INCOMPLETE, err instanceof Error ? err.message : String(err), event.request_id);
            return lifecycleErrorResult(event, MicroVMState.Failed, safe);
        }
        const normalizedResult = normalizeMicroVMLifecycleEvent(event);
        if (normalizedResult instanceof MicroVMSafeError) {
            return lifecycleErrorResult(event, MicroVMState.Failed, normalizedResult);
        }
        const normalized = normalizedResult;
        const normalizedHook = normalizeMicroVMLifecycleHook(normalized.hook);
        const normalizedState = normalizeMicroVMLifecycleState(normalized.state);
        if (!normalizedHook || !normalizedState) {
            const safe = safeError(MICROVM_ERROR_INVALID_LIFECYCLE_EVENT, "apptheory: microvm lifecycle hook and state are required", normalized.request_id);
            return lifecycleErrorResult(normalized, MicroVMState.Failed, safe);
        }
        const index = lifecycleContractIndex(this.contract);
        const spec = index.hooks.get(normalizedHook);
        if (!spec) {
            const safe = safeError(MICROVM_ERROR_INVALID_LIFECYCLE_EVENT, "apptheory: microvm lifecycle hook is unsupported", normalized.request_id);
            return lifecycleErrorResult(normalized, MicroVMState.Failed, safe);
        }
        const activeState = microVMNextState(index.transitions.list, normalizedState, normalizedHook);
        if (!activeState) {
            const safe = safeError(MICROVM_ERROR_INVALID_LIFECYCLE_EVENT, "apptheory: microvm lifecycle transition is unsupported", normalized.request_id);
            return lifecycleErrorResult(normalized, MicroVMState.Failed, safe);
        }
        if (normalizedHook !== MicroVMHook.Failure && activeState !== spec.state) {
            const safe = safeError(MICROVM_ERROR_INVALID_LIFECYCLE_EVENT, "apptheory: microvm lifecycle transition is not the hook active state", normalized.request_id);
            return lifecycleErrorResult(normalized, MicroVMState.Failed, safe);
        }
        const handler = this.handlers.get(normalizedHook);
        if (!handler) {
            const safe = safeError(MICROVM_ERROR_INVALID_LIFECYCLE_EVENT, "apptheory: microvm lifecycle hook handler is missing", normalized.request_id);
            return lifecycleErrorResult(normalized, spec.failure_state, safe);
        }
        const handlerEvent = cloneMicroVMLifecycleEvent({
            ...normalized,
            state: activeState,
        });
        try {
            await handler(handlerEvent);
        }
        catch {
            const safe = safeError(MICROVM_ERROR_LIFECYCLE_HOOK_FAILED, "apptheory: microvm lifecycle hook failed", normalized.request_id);
            return lifecycleErrorResult(normalized, spec.failure_state, safe);
        }
        const state = normalizedHook === MicroVMHook.Failure
            ? MicroVMState.Failed
            : spec.success_state;
        if (normalizedHook !== MicroVMHook.Failure &&
            !index.transitions.has(activeState, normalizedHook, state)) {
            const safe = safeError(MICROVM_ERROR_INVALID_LIFECYCLE_EVENT, "apptheory: microvm lifecycle success transition is unsupported", normalized.request_id);
            return lifecycleErrorResult(normalized, spec.failure_state, safe);
        }
        return buildLifecycleResult(normalized, state);
    }
}
export function createMicroVMLifecycleAdapter(options = {}) {
    return new MicroVMLifecycleAdapter(options);
}
export function isMicroVMTerminalState(state) {
    return state === MicroVMState.Terminated || state === MicroVMState.Failed;
}
function safeError(code, message, requestID) {
    return new MicroVMSafeError(code, message, requestID);
}
function validateMicroVMLifecycleHookSpecs(hooks) {
    const hookSpecs = new Map();
    for (const rawHook of hooks) {
        const name = normalizeMicroVMLifecycleHook(rawHook.name);
        const hook = {
            name,
            phase: String(rawHook.phase ?? "").trim(),
            state: normalizeMicroVMLifecycleState(rawHook.state),
            success_state: normalizeMicroVMLifecycleState(rawHook.success_state),
            failure_state: normalizeMicroVMLifecycleState(rawHook.failure_state),
        };
        if (!hook.name ||
            !hook.phase ||
            !hook.state ||
            !hook.success_state ||
            !hook.failure_state) {
            throw safeError(MICROVM_ERROR_LIFECYCLE_INCOMPLETE, "apptheory: microvm lifecycle hooks must name phase, active state, success state, and failure state", "");
        }
        hookSpecs.set(hook.name, hook);
    }
    const missing = missingStrings(requiredMicroVMLifecycleHooks(), [
        ...hookSpecs.keys(),
    ]);
    if (missing.length > 0) {
        throw safeError(MICROVM_ERROR_LIFECYCLE_INCOMPLETE, `apptheory: microvm lifecycle missing hooks: ${missing.join(",")}`, "");
    }
    return hookSpecs;
}
function validateMicroVMLifecycleStateLists(contract) {
    const states = new Set((contract.states ?? []).map(normalizeMicroVMLifecycleState).filter(Boolean));
    const missingStates = missingStrings(requiredMicroVMLifecycleStates(), [
        ...states,
    ]);
    if (missingStates.length > 0) {
        throw safeError(MICROVM_ERROR_LIFECYCLE_INCOMPLETE, `apptheory: microvm lifecycle missing states: ${missingStates.join(",")}`, "");
    }
    const terminalStates = new Set((contract.terminal_states ?? [])
        .map(normalizeMicroVMLifecycleState)
        .filter(Boolean));
    const missingTerminal = missingStrings([MicroVMState.Terminated, MicroVMState.Failed], [...terminalStates]);
    if (missingTerminal.length > 0) {
        throw safeError(MICROVM_ERROR_LIFECYCLE_INCOMPLETE, `apptheory: microvm lifecycle missing terminal states: ${missingTerminal.join(",")}`, "");
    }
}
function validateMicroVMLifecycleTransitionSet(hookSpecs, transitions) {
    for (const spec of hookSpecs.values()) {
        const name = normalizeMicroVMLifecycleHook(spec.name);
        if (!name || name === MicroVMHook.Failure)
            continue;
        const preState = preStateForMicroVMHook(name);
        if (!transitions.has(preState, name, spec.state)) {
            throw safeError(MICROVM_ERROR_LIFECYCLE_INCOMPLETE, `apptheory: microvm lifecycle missing active transition for hook ${name}`, "");
        }
        if (!transitions.has(spec.state, name, spec.success_state)) {
            throw safeError(MICROVM_ERROR_LIFECYCLE_INCOMPLETE, `apptheory: microvm lifecycle missing success transition for hook ${name}`, "");
        }
    }
    validateMicroVMLifecycleFailureTransitions(transitions);
}
function validateMicroVMLifecycleFailureTransitions(transitions) {
    for (const state of [
        MicroVMState.ImagePreparing,
        MicroVMState.Starting,
        MicroVMState.ReadinessProbing,
        MicroVMState.Stopping,
        MicroVMState.TearingDown,
    ]) {
        if (!transitions.has(state, MicroVMHook.Failure, MicroVMState.Failed)) {
            throw safeError(MICROVM_ERROR_LIFECYCLE_INCOMPLETE, `apptheory: microvm lifecycle missing failure transition from ${state}`, "");
        }
    }
}
function normalizeMicroVMLifecycleEvent(event) {
    const normalizedInput = {
        request_id: String(event.request_id ?? "").trim(),
        tenant_id: String(event.tenant_id ?? "").trim(),
        namespace: String(event.namespace ?? "").trim(),
        session_id: String(event.session_id ?? "").trim(),
        hook: normalizeMicroVMLifecycleHook(event.hook),
        state: normalizeMicroVMLifecycleState(event.state),
    };
    const metadata = cloneStringMap(event.metadata);
    if (metadata)
        normalizedInput.metadata = metadata;
    const normalized = cloneMicroVMLifecycleEvent(normalizedInput);
    if (!normalized.request_id ||
        !normalized.tenant_id ||
        !normalized.namespace ||
        !normalized.session_id) {
        return safeError(MICROVM_ERROR_INVALID_LIFECYCLE_EVENT, "apptheory: microvm lifecycle envelope is incomplete", normalized.request_id);
    }
    if (!normalized.hook || !normalized.state) {
        return safeError(MICROVM_ERROR_INVALID_LIFECYCLE_EVENT, "apptheory: microvm lifecycle hook and state are required", normalized.request_id);
    }
    const metadataErr = validateSafeMicroVMMetadata(normalized.metadata, normalized.request_id);
    return metadataErr ?? normalized;
}
function lifecycleErrorResult(event, state, error) {
    const result = {
        request_id: String(event.request_id ?? "").trim(),
        tenant_id: String(event.tenant_id ?? "").trim(),
        namespace: String(event.namespace ?? "").trim(),
        session_id: String(event.session_id ?? "").trim(),
        hook: normalizeMicroVMLifecycleHook(event.hook),
        previous_state: normalizeMicroVMLifecycleState(event.state),
        state,
        error,
    };
    const metadata = cloneStringMap(event.metadata);
    if (metadata)
        result.metadata = metadata;
    return result;
}
function buildLifecycleResult(event, state) {
    const result = {
        request_id: event.request_id,
        tenant_id: event.tenant_id,
        namespace: event.namespace,
        session_id: event.session_id,
        hook: event.hook,
        previous_state: event.state,
        state,
    };
    const metadata = cloneStringMap(event.metadata);
    if (metadata)
        result.metadata = metadata;
    return result;
}
function requiredMicroVMLifecycleHooks() {
    return [
        MicroVMHook.PrepareImage,
        MicroVMHook.Start,
        MicroVMHook.Readiness,
        MicroVMHook.Stop,
        MicroVMHook.Teardown,
        MicroVMHook.Failure,
    ];
}
function requiredMicroVMLifecycleStates() {
    return [
        MicroVMState.Requested,
        MicroVMState.ImagePreparing,
        MicroVMState.ImagePrepared,
        MicroVMState.Starting,
        MicroVMState.Started,
        MicroVMState.ReadinessProbing,
        MicroVMState.Ready,
        MicroVMState.Stopping,
        MicroVMState.Stopped,
        MicroVMState.TearingDown,
        MicroVMState.Terminated,
        MicroVMState.Failed,
    ];
}
function preStateForMicroVMHook(hook) {
    switch (hook) {
        case MicroVMHook.PrepareImage:
            return MicroVMState.Requested;
        case MicroVMHook.Start:
            return MicroVMState.ImagePrepared;
        case MicroVMHook.Readiness:
            return MicroVMState.Started;
        case MicroVMHook.Stop:
            return MicroVMState.Ready;
        case MicroVMHook.Teardown:
            return MicroVMState.Stopped;
        default:
            return "";
    }
}
function cloneMicroVMLifecycleContract(contract) {
    return {
        hooks: [...(contract.hooks ?? [])],
        states: [...(contract.states ?? [])],
        terminal_states: [...(contract.terminal_states ?? [])],
        transitions: [...(contract.transitions ?? [])],
    };
}
function cloneMicroVMLifecycleEvent(event) {
    const out = {
        request_id: event.request_id,
        tenant_id: event.tenant_id,
        namespace: event.namespace,
        session_id: event.session_id,
        hook: event.hook,
        state: event.state,
    };
    const metadata = cloneStringMap(event.metadata);
    if (metadata)
        out["metadata"] = metadata;
    return out;
}
function normalizeMicroVMLifecycleHook(hook) {
    return String(hook ?? "").trim();
}
function normalizeMicroVMLifecycleState(state) {
    return String(state ?? "").trim();
}
function lifecycleContractIndex(contract) {
    const hooks = new Map();
    for (const hook of contract.hooks) {
        const name = normalizeMicroVMLifecycleHook(hook.name);
        if (!name)
            continue;
        hooks.set(name, {
            name,
            phase: String(hook.phase ?? "").trim(),
            state: normalizeMicroVMLifecycleState(hook.state),
            success_state: normalizeMicroVMLifecycleState(hook.success_state),
            failure_state: normalizeMicroVMLifecycleState(hook.failure_state),
        });
    }
    return { hooks, transitions: microVMTransitionSet(contract.transitions) };
}
function microVMTransitionSet(transitions) {
    const set = new Set();
    const list = [];
    for (const transition of transitions ?? []) {
        const from = normalizeMicroVMLifecycleState(transition.from);
        const hook = normalizeMicroVMLifecycleHook(transition.hook);
        const to = normalizeMicroVMLifecycleState(transition.to);
        if (!from || !hook || !to)
            continue;
        set.add(transitionKey(from, hook, to));
        list.push({ from, hook, to });
    }
    return {
        list,
        has: (from, hook, to) => set.has(transitionKey(normalizeMicroVMLifecycleState(from), normalizeMicroVMLifecycleHook(hook), normalizeMicroVMLifecycleState(to))),
    };
}
function microVMNextState(transitions, from, hook) {
    const normalizedFrom = normalizeMicroVMLifecycleState(from);
    const normalizedHook = normalizeMicroVMLifecycleHook(hook);
    for (const transition of transitions) {
        if (transition.from === normalizedFrom &&
            transition.hook === normalizedHook) {
            return normalizeMicroVMLifecycleState(transition.to);
        }
    }
    return "";
}
function transitionKey(from, hook, to) {
    return `${from}\u0000${hook}\u0000${to}`;
}
const FORBIDDEN_MICROVM_FIELD_NAMES = new Set([
    "authorization",
    "aws_access_key_id",
    "aws_secret_access_key",
    "aws_session_token",
    "bearer_token",
    "raw_aws_credentials",
    "raw_lifecycle_hook_payload",
    "raw_sdk_client",
    "session_token_plaintext",
    "x-amz-security-token",
]);
function forbiddenMicroVMFieldName(name) {
    const key = String(name ?? "")
        .trim()
        .toLowerCase();
    if (!key)
        return false;
    return (FORBIDDEN_MICROVM_FIELD_NAMES.has(key) ||
        FORBIDDEN_MICROVM_FIELD_NAMES.has(key.replaceAll("-", "_")));
}
function validateSafeMicroVMMetadata(metadata, requestID) {
    for (const key of Object.keys(metadata ?? {})) {
        if (forbiddenMicroVMFieldName(key)) {
            return safeError(MICROVM_ERROR_FORBIDDEN_FIELD, "apptheory: microvm metadata contains forbidden field", requestID);
        }
    }
    return null;
}
function cloneStringMap(input) {
    const out = {};
    for (const [key, value] of Object.entries(input ?? {})) {
        const trimmed = key.trim();
        if (!trimmed)
            continue;
        out[trimmed] = String(value);
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
function missingStrings(required, got) {
    const seen = new Set(got.map((value) => value.trim()).filter(Boolean));
    return required.filter((value) => !seen.has(value)).sort();
}
export const MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER = "m15.microvm.unauthenticated_controller";
export const MICROVM_ERROR_CONTROLLER_INCOMPLETE = "m15.microvm.controller_incomplete";
export const MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE = "m15.microvm.session_registry_incomplete";
export const MICROVM_ERROR_INVALID_CONTROLLER_REQUEST = "m15.microvm.invalid_controller_request";
export const MICROVM_ERROR_CONTROLLER_COMMAND_FAILED = "m15.microvm.controller_command_failed";
export const MICROVM_CONTROLLER_AUTH_DEFAULT_DENY = "deny";
export const MICROVM_SESSION_REGISTRY_MODEL_NAME = "MicroVMSessionRegistryRecord";
export const MICROVM_SESSION_REGISTRY_TABLE_NAME = "apptheory-microvm-sessions";
export const MICROVM_SESSION_REGISTRY_TABLE_ENV = "APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE";
export const MicroVMCommand = {
    Create: "create",
    Start: "start",
    Stop: "stop",
    Status: "status",
    Session: "session",
};
export function defaultMicroVMControllerContract() {
    return {
        auth: { required: true, default: MICROVM_CONTROLLER_AUTH_DEFAULT_DENY },
        envelope: {
            required_fields: ["command", "request_id", "tenant_id", "auth_context"],
            safe_error_fields: ["code", "message", "request_id"],
            forbidden_fields: [
                "aws_access_key_id",
                "aws_secret_access_key",
                "raw_sdk_client",
                "bearer_token",
            ],
        },
        commands: [
            {
                name: MicroVMCommand.Create,
                method: "POST",
                path: "/microvms",
                request_fields: ["image_ref", "network_connector_ref", "session_spec"],
                response_fields: [
                    "session_id",
                    "state",
                    "registry_version",
                    "endpoint",
                    "microvm_id",
                    "last_action",
                ],
            },
            {
                name: MicroVMCommand.Start,
                method: "POST",
                path: "/microvms/{session_id}/start",
                request_fields: ["session_id"],
                response_fields: [
                    "session_id",
                    "state",
                    "desired_state",
                    "endpoint",
                    "microvm_id",
                    "last_action",
                ],
            },
            {
                name: MicroVMCommand.Stop,
                method: "POST",
                path: "/microvms/{session_id}/stop",
                request_fields: ["session_id"],
                response_fields: [
                    "session_id",
                    "state",
                    "desired_state",
                    "endpoint",
                    "microvm_id",
                    "last_action",
                ],
            },
            {
                name: MicroVMCommand.Status,
                method: "GET",
                path: "/microvms/{session_id}/status",
                request_fields: ["session_id"],
                response_fields: [
                    "session_id",
                    "state",
                    "lifecycle_state",
                    "last_transition",
                    "endpoint",
                    "microvm_id",
                    "last_action",
                ],
            },
            {
                name: MicroVMCommand.Session,
                method: "GET",
                path: "/microvms/{session_id}",
                request_fields: ["session_id"],
                response_fields: [
                    "session_id",
                    "tenant_id",
                    "namespace",
                    "state",
                    "registry_version",
                    "endpoint",
                    "microvm_id",
                    "last_action",
                ],
            },
        ],
    };
}
export function defaultMicroVMSessionRegistryContract() {
    return {
        pattern: "tabletheory-single-table",
        tenant_binding: ["tenant_id", "namespace"],
        required_fields: [
            "pk",
            "sk",
            "tenant_id",
            "namespace",
            "session_id",
            "state",
            "desired_state",
            "endpoint",
            "microvm_id",
            "image_ref",
            "network_connector_ref",
            "controller_id",
            "created_at",
            "updated_at",
            "expires_at",
            "ttl",
            "generation",
            "version",
            "last_action",
            "last_command_id",
            "auth_subject",
        ],
        state_values: requiredMicroVMLifecycleStates(),
        forbidden_fields: [
            "raw_aws_credentials",
            "raw_lifecycle_hook_payload",
            "bearer_token",
            "session_token_plaintext",
        ],
    };
}
export function validateMicroVMControllerContract(contract) {
    if (!microVMControllerAuthDefaultsDeny(contract.auth)) {
        throw safeError(MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER, "apptheory: microvm controller must default to authenticated deny", "");
    }
    const missingEnvelope = missingStrings(["command", "request_id", "tenant_id", "auth_context"], contract.envelope.required_fields ?? []);
    if (missingEnvelope.length > 0) {
        throw safeError(MICROVM_ERROR_CONTROLLER_INCOMPLETE, `apptheory: microvm controller envelope missing fields: ${missingEnvelope.join(",")}`, "");
    }
    const missingSafeError = missingStrings(["code", "message", "request_id"], contract.envelope.safe_error_fields ?? []);
    if (missingSafeError.length > 0) {
        throw safeError(MICROVM_ERROR_CONTROLLER_INCOMPLETE, `apptheory: microvm controller safe error missing fields: ${missingSafeError.join(",")}`, "");
    }
    const missingForbidden = missingStrings(["raw_sdk_client", "bearer_token"], contract.envelope.forbidden_fields ?? []);
    if (missingForbidden.length > 0) {
        throw safeError(MICROVM_ERROR_CONTROLLER_INCOMPLETE, `apptheory: microvm controller envelope missing forbidden fields: ${missingForbidden.join(",")}`, "");
    }
    const commands = new Map();
    for (const rawCommand of contract.commands ?? []) {
        const name = normalizeMicroVMCommand(rawCommand.name);
        if (!name ||
            !String(rawCommand.method ?? "").trim() ||
            !String(rawCommand.path ?? "").trim()) {
            throw safeError(MICROVM_ERROR_CONTROLLER_INCOMPLETE, "apptheory: microvm controller commands must define name, method, and path", "");
        }
        if ((rawCommand.request_fields ?? []).length === 0 ||
            (rawCommand.response_fields ?? []).length === 0) {
            throw safeError(MICROVM_ERROR_CONTROLLER_INCOMPLETE, `apptheory: microvm controller command ${name} must define request and response fields`, "");
        }
        if (isRequiredMicroVMCommand(name))
            commands.set(name, rawCommand);
    }
    for (const required of requiredMicroVMControllerCommands()) {
        if (!commands.has(required)) {
            throw safeError(MICROVM_ERROR_CONTROLLER_INCOMPLETE, `apptheory: microvm controller missing command: ${required}`, "");
        }
    }
}
export function validateMicroVMSessionRegistryContract(registry) {
    if (String(registry.pattern ?? "").trim() !== "tabletheory-single-table") {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session registry must use tabletheory-single-table guidance", "");
    }
    const missingTenantBinding = missingStrings(["tenant_id", "namespace"], registry.tenant_binding ?? []);
    if (missingTenantBinding.length > 0) {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, `apptheory: microvm session registry missing tenant binding: ${missingTenantBinding.join(",")}`, "");
    }
    const missingFields = missingStrings(requiredMicroVMSessionRegistryContractFields(), registry.required_fields ?? []);
    if (missingFields.length > 0) {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, `apptheory: microvm session registry missing fields: ${missingFields.join(",")}`, "");
    }
    const missingStates = missingStrings(requiredMicroVMLifecycleStates(), registry.state_values ?? []);
    if (missingStates.length > 0) {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, `apptheory: microvm session registry missing states: ${missingStates.join(",")}`, "");
    }
    const missingForbidden = missingStrings(["raw_aws_credentials", "raw_lifecycle_hook_payload", "bearer_token"], registry.forbidden_fields ?? []);
    if (missingForbidden.length > 0) {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, `apptheory: microvm session registry missing forbidden fields: ${missingForbidden.join(",")}`, "");
    }
}
export function validateMicroVMSessionRecord(record) {
    const normalized = normalizeMicroVMSessionRecord(record);
    if (!normalized.tenant_id ||
        !normalized.namespace ||
        !normalized.session_id ||
        !normalized.state ||
        !normalized.desired_state ||
        !normalized.image_ref ||
        !normalized.network_connector_ref ||
        !normalized.controller_id ||
        !normalized.last_action ||
        !normalized.last_command_id ||
        !normalized.auth_subject) {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session record is incomplete", normalized.last_command_id);
    }
    if (!validDate(normalized.created_at) ||
        !validDate(normalized.updated_at) ||
        !validDate(normalized.expires_at) ||
        normalized.generation <= 0) {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session record registry fields are incomplete", normalized.last_command_id);
    }
    if (!validMicroVMCommand(normalized.last_action)) {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session record last action is unsupported", normalized.last_command_id);
    }
    if (!validMicroVMLifecycleState(normalized.state) ||
        !validMicroVMLifecycleState(normalized.desired_state)) {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session record state is unsupported", normalized.last_command_id);
    }
    const metadataErr = validateSafeMicroVMMetadata(normalized.metadata, normalized.last_command_id);
    if (metadataErr)
        throw metadataErr;
}
export function validateMicroVMSessionStatus(status) {
    const normalized = normalizeMicroVMSessionStatus(status);
    if (!normalized.tenant_id ||
        !normalized.namespace ||
        !normalized.session_id ||
        !normalized.state ||
        !normalized.desired_state ||
        !normalized.lifecycle_state ||
        !normalized.last_action ||
        !validDate(normalized.last_transition) ||
        normalized.registry_version <= 0) {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session status is incomplete", "");
    }
    if (!validMicroVMLifecycleState(normalized.state) ||
        !validMicroVMLifecycleState(normalized.desired_state) ||
        !validMicroVMLifecycleState(normalized.lifecycle_state)) {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session status state is unsupported", "");
    }
    if (!validMicroVMCommand(normalized.last_action)) {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session status last action is unsupported", "");
    }
}
export function microVMSessionKey(record) {
    return {
        tenant_id: String(record.tenant_id ?? "").trim(),
        namespace: String(record.namespace ?? "").trim(),
        session_id: String(record.session_id ?? "").trim(),
    };
}
export function microVMSessionRegistryTableName() {
    return (String(process.env[MICROVM_SESSION_REGISTRY_TABLE_ENV] ?? "").trim() ||
        MICROVM_SESSION_REGISTRY_TABLE_NAME);
}
export function microVMSessionRegistryPartitionKey(tenantID, namespace) {
    const tenant = String(tenantID ?? "").trim();
    const ns = String(namespace ?? "").trim();
    return tenant && ns ? `TENANT#${tenant}#NAMESPACE#${ns}` : "";
}
export function microVMSessionRegistrySortKey(sessionID) {
    const session = String(sessionID ?? "").trim();
    return session ? `SESSION#${session}` : "";
}
export function microVMSessionRegistryModel(tableName = microVMSessionRegistryTableName()) {
    return defineModel({
        name: MICROVM_SESSION_REGISTRY_MODEL_NAME,
        table: { name: tableName },
        keys: {
            partition: { attribute: "pk", type: "S" },
            sort: { attribute: "sk", type: "S" },
        },
        attributes: [
            { attribute: "pk", type: "S", roles: ["pk"] },
            { attribute: "sk", type: "S", roles: ["sk"] },
            { attribute: "tenant_id", type: "S", required: true },
            { attribute: "namespace", type: "S", required: true },
            { attribute: "session_id", type: "S", required: true },
            { attribute: "state", type: "S", required: true },
            { attribute: "desired_state", type: "S", required: true },
            { attribute: "endpoint", type: "S", optional: true, omit_empty: true },
            { attribute: "microvm_id", type: "S", optional: true, omit_empty: true },
            { attribute: "image_ref", type: "S", required: true },
            { attribute: "network_connector_ref", type: "S", required: true },
            { attribute: "controller_id", type: "S", required: true },
            { attribute: "created_at", type: "S", required: true },
            { attribute: "updated_at", type: "S", required: true },
            { attribute: "expires_at", type: "S", required: true },
            { attribute: "ttl", type: "N", roles: ["ttl"] },
            { attribute: "generation", type: "N", required: true },
            { attribute: "version", type: "N", roles: ["version"] },
            { attribute: "last_action", type: "S", required: true },
            { attribute: "last_command_id", type: "S", required: true },
            { attribute: "auth_subject", type: "S", required: true },
            { attribute: "metadata", type: "M", optional: true, omit_empty: true },
        ],
    });
}
export function validateMicroVMSessionRegistryRecord(record) {
    const normalized = normalizeMicroVMSessionRegistryRecord(record);
    validateMicroVMSessionRecord(microVMSessionFromRegistryRecordNoValidate(normalized));
    if (!normalized.pk ||
        !normalized.sk ||
        normalized.ttl <= 0 ||
        normalized.version <= 0) {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session registry keys are incomplete", normalized.last_command_id);
    }
    if (normalized.pk !==
        microVMSessionRegistryPartitionKey(normalized.tenant_id, normalized.namespace) ||
        normalized.sk !== microVMSessionRegistrySortKey(normalized.session_id)) {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session registry tenant/session key mismatch", normalized.last_command_id);
    }
    if (normalized.ttl !== Math.trunc(normalized.expires_at.getTime() / 1000)) {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session registry ttl mismatch", normalized.last_command_id);
    }
    const metadataErr = validateSafeMicroVMMetadata(normalized.metadata, normalized.last_command_id);
    if (metadataErr)
        throw metadataErr;
}
export function microVMSessionRecordToRegistryRecord(record) {
    const normalized = normalizeMicroVMSessionRecord(record);
    validateMicroVMSessionRecord(normalized);
    const registry = {
        pk: microVMSessionRegistryPartitionKey(normalized.tenant_id, normalized.namespace),
        sk: microVMSessionRegistrySortKey(normalized.session_id),
        tenant_id: normalized.tenant_id,
        namespace: normalized.namespace,
        session_id: normalized.session_id,
        state: normalized.state,
        desired_state: normalized.desired_state,
        endpoint: normalized.endpoint ?? "",
        microvm_id: normalized.microvm_id ?? "",
        image_ref: normalized.image_ref,
        network_connector_ref: normalized.network_connector_ref,
        controller_id: normalized.controller_id,
        created_at: cloneMicroVMDate(normalized.created_at),
        updated_at: cloneMicroVMDate(normalized.updated_at),
        expires_at: cloneMicroVMDate(normalized.expires_at),
        ttl: Math.trunc(normalized.expires_at.getTime() / 1000),
        generation: normalized.generation,
        version: normalized.generation,
        last_action: normalized.last_action,
        last_command_id: normalized.last_command_id,
        auth_subject: normalized.auth_subject,
    };
    const metadata = cloneStringMap(normalized.metadata);
    if (metadata)
        registry.metadata = metadata;
    validateMicroVMSessionRegistryRecord(registry);
    return registry;
}
export function microVMSessionFromRegistryRecord(record) {
    const normalized = normalizeMicroVMSessionRegistryRecord(record);
    validateMicroVMSessionRegistryRecord(normalized);
    return microVMSessionFromRegistryRecordNoValidate(normalized);
}
export class MemoryMicroVMSessionRegistry {
    records = new Map();
    async put(record) {
        const registry = microVMSessionRecordToRegistryRecord(record);
        this.records.set(microVMSessionRegistryRecordKey(registry), cloneMicroVMSessionRegistryRecord(registry));
        return microVMSessionFromRegistryRecord(registry);
    }
    async get(key) {
        const normalized = normalizeMicroVMSessionKey(key);
        validateMicroVMSessionKey(normalized);
        const record = this.records.get(microVMSessionRegistryRecordKeyFromKey(normalized));
        if (!record) {
            throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session registry record not found", "");
        }
        return microVMSessionFromRegistryRecord(cloneMicroVMSessionRegistryRecord(record));
    }
    async delete(key) {
        const normalized = normalizeMicroVMSessionKey(key);
        validateMicroVMSessionKey(normalized);
        this.records.delete(microVMSessionRegistryRecordKeyFromKey(normalized));
    }
}
export function createMemoryMicroVMSessionRegistry() {
    return new MemoryMicroVMSessionRegistry();
}
export class TableTheoryMicroVMSessionRegistry {
    db;
    modelName;
    constructor(db, options = {}) {
        if (!db) {
            throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session registry requires TableTheory client", "");
        }
        this.db = db;
        this.modelName =
            String(options.model_name ?? "").trim() ||
                MICROVM_SESSION_REGISTRY_MODEL_NAME;
        if (options.auto_register !== false && this.db.register) {
            this.db.register(microVMSessionRegistryModel(String(options.table_name ?? "").trim() ||
                microVMSessionRegistryTableName()));
        }
    }
    async put(record) {
        const registry = microVMSessionRecordToRegistryRecord(record);
        try {
            await this.db.save(this.modelName, registryRecordToTableItem(registry));
            return microVMSessionFromRegistryRecord(registry);
        }
        catch (err) {
            throw asMicroVMSessionRegistryError(err, registry.last_command_id);
        }
    }
    async get(key) {
        const normalized = normalizeMicroVMSessionKey(key);
        validateMicroVMSessionKey(normalized);
        try {
            const item = await this.db.get(this.modelName, {
                pk: microVMSessionRegistryPartitionKey(normalized.tenant_id, normalized.namespace),
                sk: microVMSessionRegistrySortKey(normalized.session_id),
            });
            return microVMSessionFromRegistryRecord(registryRecordFromTableItem(item));
        }
        catch (err) {
            throw asMicroVMSessionRegistryError(err, "");
        }
    }
    async delete(key) {
        const normalized = normalizeMicroVMSessionKey(key);
        validateMicroVMSessionKey(normalized);
        try {
            await this.db.delete(this.modelName, {
                pk: microVMSessionRegistryPartitionKey(normalized.tenant_id, normalized.namespace),
                sk: microVMSessionRegistrySortKey(normalized.session_id),
            });
        }
        catch (err) {
            throw asMicroVMSessionRegistryError(err, "");
        }
    }
}
export function createTableTheoryMicroVMSessionRegistry(db, options = {}) {
    return new TableTheoryMicroVMSessionRegistry(db, options);
}
export class MicroVMRegistryClient {
    registry;
    ttlMs;
    constructor(registry, options = {}) {
        if (!registry) {
            throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm registry client requires a session registry", "");
        }
        this.registry = registry;
        const ttlMs = Math.trunc(Number(options.ttl_ms) || 0);
        this.ttlMs = ttlMs > 0 ? ttlMs : 60 * 60 * 1000;
    }
    async create(input) {
        const now = coalesceMicroVMTime(input.now, new Date(0));
        const record = {
            tenant_id: input.tenant_id,
            namespace: input.namespace,
            session_id: input.session_id,
            state: MicroVMState.Requested,
            desired_state: MicroVMState.Requested,
            endpoint: "",
            microvm_id: "",
            image_ref: input.image_ref,
            network_connector_ref: input.network_connector_ref,
            controller_id: input.controller_id,
            created_at: now,
            updated_at: now,
            expires_at: new Date(now.valueOf() + this.ttlMs),
            generation: 1,
            last_action: MicroVMCommand.Create,
            last_command_id: input.request_id,
            auth_subject: input.auth_subject,
        };
        const metadata = cloneStringMap(input.session_spec.metadata);
        if (metadata)
            record.metadata = metadata;
        return await this.registry.put(record);
    }
    async start(input) {
        return await this.transition(input, MicroVMCommand.Start, MicroVMState.Starting, MicroVMState.Started);
    }
    async stop(input) {
        return await this.transition(input, MicroVMCommand.Stop, MicroVMState.Stopping, MicroVMState.Stopped);
    }
    async status(input) {
        const record = await this.session(input);
        const status = {
            tenant_id: record.tenant_id,
            namespace: record.namespace,
            session_id: record.session_id,
            state: record.state,
            desired_state: record.desired_state,
            lifecycle_state: record.state,
            endpoint: record.endpoint ?? "",
            microvm_id: record.microvm_id ?? "",
            last_action: record.last_action,
            last_transition: record.updated_at,
            registry_version: record.generation,
        };
        validateMicroVMSessionStatus(status);
        return status;
    }
    async session(input) {
        return await this.registry.get({
            tenant_id: input.tenant_id,
            namespace: input.namespace,
            session_id: input.session_id,
        });
    }
    async transition(input, action, state, desiredState) {
        const record = await this.registry.get({
            tenant_id: input.tenant_id,
            namespace: input.namespace,
            session_id: input.session_id,
        });
        const next = {
            ...record,
            state,
            desired_state: desiredState,
            controller_id: input.controller_id,
            auth_subject: input.auth_subject,
            last_action: action,
            last_command_id: input.request_id,
            updated_at: coalesceMicroVMTime(input.now, new Date(0)),
            generation: record.generation + 1,
        };
        return await this.registry.put(next);
    }
}
export function createMicroVMRegistryClient(registry, options = {}) {
    return new MicroVMRegistryClient(registry, options);
}
export class MicroVMController {
    client;
    controllerID;
    clock;
    ids;
    constructor(client, options = {}) {
        if (!client) {
            throw safeError(MICROVM_ERROR_CONTROLLER_INCOMPLETE, "apptheory: microvm controller requires a constrained client", "");
        }
        this.client = client;
        this.controllerID =
            String(options.controller_id ?? "").trim() ||
                "apptheory-microvm-controller";
        this.clock = options.clock ?? { now: () => new Date() };
        this.ids = options.ids ?? { newID: () => randomMicroVMSessionID() };
    }
    async handle(request) {
        const normalized = normalizeMicroVMControllerRequest(request);
        const validationErr = validateMicroVMControllerRequest(normalized);
        if (validationErr)
            return controllerErrorResponse(normalized, validationErr);
        switch (normalized.command) {
            case MicroVMCommand.Create:
                return await this.handleCreate(normalized);
            case MicroVMCommand.Start:
                return await this.handleCommand(normalized, MicroVMState.Started, this.client.start);
            case MicroVMCommand.Stop:
                return await this.handleCommand(normalized, MicroVMState.Stopped, this.client.stop);
            case MicroVMCommand.Status:
                return await this.handleStatus(normalized);
            case MicroVMCommand.Session:
                return await this.handleSession(normalized);
            default: {
                const err = safeError(MICROVM_ERROR_INVALID_CONTROLLER_REQUEST, "apptheory: microvm controller command is unsupported", normalized.request_id);
                return controllerErrorResponse(normalized, err);
            }
        }
    }
    async handleCreate(request) {
        let sessionID = String(request.session_id ?? "").trim();
        if (!sessionID)
            sessionID = String(this.ids.newID() ?? "").trim();
        if (!sessionID) {
            const err = safeError(MICROVM_ERROR_INVALID_CONTROLLER_REQUEST, "apptheory: microvm controller could not allocate session id", request.request_id);
            return controllerErrorResponse(request, err);
        }
        try {
            const record = await this.client.create({
                request_id: request.request_id,
                tenant_id: request.tenant_id,
                namespace: request.namespace,
                session_id: sessionID,
                image_ref: request.image_ref,
                network_connector_ref: request.network_connector_ref,
                session_spec: cloneMicroVMSessionSpec(request.session_spec),
                controller_id: this.controllerID,
                auth_subject: request.auth_context.subject,
                now: this.clock.now(),
            });
            validateMicroVMSessionRecord(record);
            return responseFromMicroVMSession(request, record);
        }
        catch (err) {
            return controllerErrorResponse(request, asMicroVMSafeError(err, request.request_id));
        }
    }
    async handleCommand(request, desiredState, run) {
        try {
            const record = await run.call(this.client, {
                request_id: request.request_id,
                tenant_id: request.tenant_id,
                namespace: request.namespace,
                session_id: request.session_id,
                controller_id: this.controllerID,
                auth_subject: request.auth_context.subject,
                desired_state: desiredState,
                now: this.clock.now(),
            });
            validateMicroVMSessionRecord(record);
            return responseFromMicroVMSession(request, record);
        }
        catch (err) {
            return controllerErrorResponse(request, asMicroVMSafeError(err, request.request_id));
        }
    }
    async handleStatus(request) {
        try {
            const status = await this.client.status(controllerQueryInput(request));
            validateMicroVMSessionStatus(status);
            return responseFromMicroVMStatus(request, status);
        }
        catch (err) {
            return controllerErrorResponse(request, asMicroVMSafeError(err, request.request_id));
        }
    }
    async handleSession(request) {
        try {
            const record = await this.client.session(controllerQueryInput(request));
            validateMicroVMSessionRecord(record);
            return responseFromMicroVMSession(request, record);
        }
        catch (err) {
            return controllerErrorResponse(request, asMicroVMSafeError(err, request.request_id));
        }
    }
}
export function createMicroVMController(client, options = {}) {
    return new MicroVMController(client, options);
}
export function validateMicroVMControllerRequest(request) {
    const normalized = normalizeMicroVMControllerRequest(request);
    if (!normalized.command ||
        !normalized.request_id ||
        !normalized.tenant_id ||
        !normalized.namespace) {
        return safeError(MICROVM_ERROR_INVALID_CONTROLLER_REQUEST, "apptheory: microvm controller envelope is incomplete", normalized.request_id);
    }
    if (!normalized.auth_context.subject || !normalized.auth_context.tenant_id) {
        return safeError(MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER, "apptheory: microvm controller must default to authenticated deny", normalized.request_id);
    }
    if (normalized.auth_context.tenant_id !== normalized.tenant_id) {
        return safeError(MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER, "apptheory: microvm controller tenant binding mismatch", normalized.request_id);
    }
    if (normalized.auth_context.namespace &&
        normalized.auth_context.namespace !== normalized.namespace) {
        return safeError(MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER, "apptheory: microvm controller namespace binding mismatch", normalized.request_id);
    }
    const authMetadataErr = validateSafeMicroVMMetadata(normalized.auth_context.metadata, normalized.request_id);
    if (authMetadataErr)
        return authMetadataErr;
    const specMetadataErr = validateSafeMicroVMMetadata(normalized.session_spec.metadata, normalized.request_id);
    if (specMetadataErr)
        return specMetadataErr;
    switch (normalized.command) {
        case MicroVMCommand.Create:
            if (!normalized.image_ref || !normalized.network_connector_ref) {
                return safeError(MICROVM_ERROR_INVALID_CONTROLLER_REQUEST, "apptheory: microvm create requires image and network connector refs", normalized.request_id);
            }
            return null;
        case MicroVMCommand.Start:
        case MicroVMCommand.Stop:
        case MicroVMCommand.Status:
        case MicroVMCommand.Session:
            if (!normalized.session_id) {
                return safeError(MICROVM_ERROR_INVALID_CONTROLLER_REQUEST, "apptheory: microvm controller session_id is required", normalized.request_id);
            }
            return null;
        default:
            return safeError(MICROVM_ERROR_INVALID_CONTROLLER_REQUEST, "apptheory: microvm controller command is unsupported", normalized.request_id);
    }
}
export class FakeMicroVMClient {
    currentTime;
    sessions = new Map();
    recordedCalls = [];
    constructor(now = new Date(0)) {
        this.currentTime = coalesceMicroVMTime(now, new Date(0));
    }
    setNow(now) {
        if (validDate(now))
            this.currentTime = new Date(now.valueOf());
    }
    calls() {
        return this.recordedCalls.map((call) => ({ ...call }));
    }
    async create(input) {
        this.recordCall(MicroVMCommand.Create, input.request_id, input.tenant_id, input.namespace, input.session_id);
        const now = coalesceMicroVMTime(input.now, this.currentTime);
        const record = {
            tenant_id: input.tenant_id,
            namespace: input.namespace,
            session_id: input.session_id,
            state: MicroVMState.Requested,
            desired_state: MicroVMState.Requested,
            endpoint: "",
            microvm_id: "",
            image_ref: input.image_ref,
            network_connector_ref: input.network_connector_ref,
            controller_id: input.controller_id,
            created_at: now,
            updated_at: now,
            expires_at: new Date(now.valueOf() + 60 * 60 * 1000),
            generation: 1,
            last_action: MicroVMCommand.Create,
            last_command_id: input.request_id,
            auth_subject: input.auth_subject,
        };
        const metadata = cloneStringMap(input.session_spec.metadata);
        if (metadata)
            record.metadata = metadata;
        validateMicroVMSessionRecord(record);
        const key = microVMSessionRecordKey(record);
        if (this.sessions.has(key))
            throw new Error("session already exists");
        this.sessions.set(key, cloneMicroVMSessionRecord(record));
        return cloneMicroVMSessionRecord(record);
    }
    async start(input) {
        return this.transition(input, MicroVMCommand.Start, MicroVMState.Starting, MicroVMState.Started);
    }
    async stop(input) {
        return this.transition(input, MicroVMCommand.Stop, MicroVMState.Stopping, MicroVMState.Stopped);
    }
    async status(input) {
        this.recordCall(MicroVMCommand.Status, input.request_id, input.tenant_id, input.namespace, input.session_id);
        const record = this.lookup(input.tenant_id, input.namespace, input.session_id);
        return {
            tenant_id: record.tenant_id,
            namespace: record.namespace,
            session_id: record.session_id,
            state: record.state,
            desired_state: record.desired_state,
            lifecycle_state: record.state,
            endpoint: record.endpoint ?? "",
            microvm_id: record.microvm_id ?? "",
            last_action: record.last_action,
            last_transition: record.updated_at,
            registry_version: record.generation,
        };
    }
    async session(input) {
        this.recordCall(MicroVMCommand.Session, input.request_id, input.tenant_id, input.namespace, input.session_id);
        return cloneMicroVMSessionRecord(this.lookup(input.tenant_id, input.namespace, input.session_id));
    }
    async transition(input, command, state, desiredState) {
        this.recordCall(command, input.request_id, input.tenant_id, input.namespace, input.session_id);
        const record = this.lookup(input.tenant_id, input.namespace, input.session_id);
        const next = {
            ...record,
            state,
            desired_state: desiredState,
            controller_id: input.controller_id,
            auth_subject: input.auth_subject,
            last_action: command,
            last_command_id: input.request_id,
            updated_at: coalesceMicroVMTime(input.now, this.currentTime),
            generation: record.generation + 1,
        };
        validateMicroVMSessionRecord(next);
        this.sessions.set(microVMSessionRecordKey(next), cloneMicroVMSessionRecord(next));
        return cloneMicroVMSessionRecord(next);
    }
    lookup(tenantID, namespace, sessionID) {
        const key = microVMSessionKeyString(tenantID, namespace, sessionID);
        const record = this.sessions.get(key);
        if (!record)
            throw new Error("session not found");
        return cloneMicroVMSessionRecord(record);
    }
    recordCall(command, requestID, tenantID, namespace, sessionID) {
        this.recordedCalls.push({
            command,
            request_id: requestID,
            tenant_id: tenantID,
            namespace,
            session_id: sessionID,
        });
    }
}
export function createFakeMicroVMClient(now = new Date(0)) {
    return new FakeMicroVMClient(now);
}
export async function createAWSLambdaMicroVMClient(options = {}) {
    try {
        const packageName = "@aws-sdk/client-lambda-microvms";
        const sdk = (await import(packageName));
        const ClientCtor = getSDKConstructor(sdk, [
            "LambdaMicrovmsClient",
            "LambdaMicroVMsClient",
            "LambdaMicroVMClient",
        ]);
        const commands = {
            create: getSDKConstructor(sdk, [
                "CreateMicrovmSessionCommand",
                "CreateMicroVMSessionCommand",
            ]),
            start: getSDKConstructor(sdk, [
                "StartMicrovmSessionCommand",
                "StartMicroVMSessionCommand",
            ]),
            stop: getSDKConstructor(sdk, [
                "StopMicrovmSessionCommand",
                "StopMicroVMSessionCommand",
            ]),
            status: getSDKConstructor(sdk, [
                "GetMicrovmSessionStatusCommand",
                "GetMicroVMSessionStatusCommand",
            ]),
            session: getSDKConstructor(sdk, [
                "GetMicrovmSessionCommand",
                "GetMicroVMSessionCommand",
            ]),
        };
        const client = new ClientCtor(options.region ? { region: options.region } : {});
        return new AWSLambdaMicroVMConstrainedClient(client, commands);
    }
    catch (err) {
        if (err instanceof MicroVMSafeError)
            throw err;
        throw safeError(MICROVM_ERROR_CONTROLLER_INCOMPLETE, "apptheory: microvm AWS SDK lacks Lambda MicroVM support", "");
    }
}
class AWSLambdaMicroVMConstrainedClient {
    client;
    commands;
    constructor(client, commands) {
        this.client = client;
        this.commands = commands;
    }
    async create(input) {
        try {
            const output = await this.client.send(new this.commands.create({
                sessionId: input.session_id,
                tenantId: input.tenant_id,
                namespace: input.namespace,
                imageRef: input.image_ref,
                networkConnectorRef: input.network_connector_ref,
                metadata: input.session_spec.metadata ?? {},
            }));
            return sessionRecordFromAWSOutput(input, output, MicroVMState.Requested, MicroVMState.Requested);
        }
        catch (err) {
            throw asMicroVMSafeError(err, input.request_id);
        }
    }
    async start(input) {
        return await this.runRecordCommand(this.commands.start, input, MicroVMState.Starting);
    }
    async stop(input) {
        return await this.runRecordCommand(this.commands.stop, input, MicroVMState.Stopping);
    }
    async status(input) {
        try {
            const output = await this.client.send(new this.commands.status(queryAWSInput(input)));
            const status = sessionStatusFromAWSOutput(input, output);
            validateMicroVMSessionStatus(status);
            return status;
        }
        catch (err) {
            throw asMicroVMSafeError(err, input.request_id);
        }
    }
    async session(input) {
        try {
            const output = await this.client.send(new this.commands.session(queryAWSInput(input)));
            const record = sessionRecordFromAWSOutput({
                request_id: input.request_id,
                tenant_id: input.tenant_id,
                namespace: input.namespace,
                session_id: input.session_id,
                image_ref: stringField(output, "imageRef") || "microvm-image",
                network_connector_ref: stringField(output, "networkConnectorRef"),
                session_spec: {},
                controller_id: stringField(output, "controllerId") ||
                    "apptheory-microvm-controller",
                auth_subject: input.auth_subject,
                now: new Date(),
            }, output, stringField(output, "state") || MicroVMState.Requested, stringField(output, "desiredState") || MicroVMState.Requested);
            validateMicroVMSessionRecord(record);
            return record;
        }
        catch (err) {
            throw asMicroVMSafeError(err, input.request_id);
        }
    }
    async runRecordCommand(CommandCtor, input, activeState) {
        try {
            const output = await this.client.send(new CommandCtor({
                ...queryAWSInput(input),
                desiredState: input.desired_state,
            }));
            const record = sessionRecordFromAWSOutput({
                request_id: input.request_id,
                tenant_id: input.tenant_id,
                namespace: input.namespace,
                session_id: input.session_id,
                image_ref: stringField(output, "imageRef") || "microvm-image",
                network_connector_ref: stringField(output, "networkConnectorRef"),
                session_spec: {},
                controller_id: input.controller_id,
                auth_subject: input.auth_subject,
                now: input.now,
            }, output, activeState, input.desired_state);
            validateMicroVMSessionRecord(record);
            return record;
        }
        catch (err) {
            throw asMicroVMSafeError(err, input.request_id);
        }
    }
}
function microVMControllerAuthDefaultsDeny(auth) {
    return (auth.required === true &&
        String(auth.default ?? "")
            .trim()
            .toLowerCase() === MICROVM_CONTROLLER_AUTH_DEFAULT_DENY);
}
function normalizeMicroVMCommand(command) {
    return String(command ?? "").trim();
}
function requiredMicroVMControllerCommands() {
    return [
        MicroVMCommand.Create,
        MicroVMCommand.Start,
        MicroVMCommand.Stop,
        MicroVMCommand.Status,
        MicroVMCommand.Session,
    ];
}
function isRequiredMicroVMCommand(command) {
    return requiredMicroVMControllerCommands().includes(command);
}
function validMicroVMCommand(command) {
    return requiredMicroVMControllerCommands().includes(normalizeMicroVMCommand(command));
}
function requiredMicroVMSessionRegistryContractFields() {
    // Keep the original M15 vocabulary fixture compatible; durable TableTheory
    // keys/TTL are enforced by registry-record validation and runner coverage.
    return [
        "tenant_id",
        "namespace",
        "session_id",
        "state",
        "desired_state",
        "image_ref",
        "controller_id",
        "created_at",
        "updated_at",
        "expires_at",
        "generation",
        "last_command_id",
        "auth_subject",
    ];
}
function validMicroVMLifecycleState(state) {
    return requiredMicroVMLifecycleStates().includes(normalizeMicroVMLifecycleState(state));
}
function normalizeMicroVMControllerRequest(request) {
    return {
        command: normalizeMicroVMCommand(request.command),
        request_id: String(request.request_id ?? "").trim(),
        tenant_id: String(request.tenant_id ?? "").trim(),
        namespace: String(request.namespace ?? "").trim(),
        auth_context: normalizeMicroVMAuthContext(request.auth_context ?? {}),
        session_id: String(request.session_id ?? "").trim(),
        image_ref: String(request.image_ref ?? "").trim(),
        network_connector_ref: String(request.network_connector_ref ?? "").trim(),
        session_spec: cloneMicroVMSessionSpec(request.session_spec ?? {}),
    };
}
function normalizeMicroVMAuthContext(auth) {
    const out = {
        subject: String(auth.subject ?? "").trim(),
        tenant_id: String(auth.tenant_id ?? "").trim(),
    };
    const namespace = String(auth.namespace ?? "").trim();
    if (namespace)
        out.namespace = namespace;
    const entitlements = [...(auth.entitlements ?? [])]
        .map(String)
        .filter(Boolean);
    if (entitlements.length > 0)
        out.entitlements = entitlements;
    const metadata = cloneStringMap(auth.metadata);
    if (metadata)
        out.metadata = metadata;
    return out;
}
function cloneMicroVMSessionSpec(spec) {
    const out = {};
    const metadata = cloneStringMap(spec.metadata);
    if (metadata)
        out.metadata = metadata;
    return out;
}
function controllerQueryInput(request) {
    return {
        request_id: request.request_id,
        tenant_id: request.tenant_id,
        namespace: request.namespace,
        session_id: request.session_id,
        auth_subject: request.auth_context.subject,
    };
}
function responseFromMicroVMSession(request, record) {
    const normalized = normalizeMicroVMSessionRecord(record);
    return {
        command: request.command,
        request_id: request.request_id,
        tenant_id: normalized.tenant_id,
        namespace: normalized.namespace,
        session_id: normalized.session_id,
        state: normalized.state,
        desired_state: normalized.desired_state,
        lifecycle_state: normalized.state,
        endpoint: normalized.endpoint ?? "",
        microvm_id: normalized.microvm_id ?? "",
        last_action: normalized.last_action,
        last_transition: normalized.updated_at,
        registry_version: normalized.generation,
    };
}
function responseFromMicroVMStatus(request, status) {
    const normalized = normalizeMicroVMSessionStatus(status);
    return {
        command: request.command,
        request_id: request.request_id,
        tenant_id: normalized.tenant_id,
        namespace: normalized.namespace,
        session_id: normalized.session_id,
        state: normalized.state,
        desired_state: normalized.desired_state,
        lifecycle_state: normalized.lifecycle_state,
        endpoint: normalized.endpoint ?? "",
        microvm_id: normalized.microvm_id ?? "",
        last_action: normalized.last_action,
        last_transition: normalized.last_transition,
        registry_version: normalized.registry_version,
    };
}
function controllerErrorResponse(request, err) {
    const normalized = normalizeMicroVMControllerRequest(request);
    return {
        command: normalized.command,
        request_id: normalized.request_id,
        tenant_id: normalized.tenant_id,
        namespace: normalized.namespace,
        session_id: normalized.session_id,
        error: err,
    };
}
function asMicroVMSafeError(err, requestID) {
    if (err instanceof MicroVMSafeError) {
        return err.request_id ? err : safeError(err.code, err.message, requestID);
    }
    return safeError(MICROVM_ERROR_CONTROLLER_COMMAND_FAILED, "apptheory: microvm controller command failed", requestID);
}
function normalizeMicroVMSessionRecord(record) {
    const out = {
        tenant_id: String(record.tenant_id ?? "").trim(),
        namespace: String(record.namespace ?? "").trim(),
        session_id: String(record.session_id ?? "").trim(),
        state: normalizeMicroVMLifecycleState(record.state),
        desired_state: normalizeMicroVMLifecycleState(record.desired_state),
        endpoint: String(record.endpoint ?? "").trim(),
        microvm_id: String(record.microvm_id ?? "").trim(),
        image_ref: String(record.image_ref ?? "").trim(),
        network_connector_ref: String(record.network_connector_ref ?? "").trim(),
        controller_id: String(record.controller_id ?? "").trim(),
        created_at: cloneMicroVMDate(record.created_at),
        updated_at: cloneMicroVMDate(record.updated_at),
        expires_at: cloneMicroVMDate(record.expires_at),
        generation: Math.trunc(Number(record.generation) || 0),
        last_action: normalizeMicroVMCommand(record.last_action),
        last_command_id: String(record.last_command_id ?? "").trim(),
        auth_subject: String(record.auth_subject ?? "").trim(),
    };
    const metadata = cloneStringMap(record.metadata);
    if (metadata)
        out.metadata = metadata;
    return out;
}
function normalizeMicroVMSessionStatus(status) {
    return {
        tenant_id: String(status.tenant_id ?? "").trim(),
        namespace: String(status.namespace ?? "").trim(),
        session_id: String(status.session_id ?? "").trim(),
        state: normalizeMicroVMLifecycleState(status.state),
        desired_state: normalizeMicroVMLifecycleState(status.desired_state),
        lifecycle_state: normalizeMicroVMLifecycleState(status.lifecycle_state),
        endpoint: String(status.endpoint ?? "").trim(),
        microvm_id: String(status.microvm_id ?? "").trim(),
        last_action: normalizeMicroVMCommand(status.last_action),
        last_transition: cloneMicroVMDate(status.last_transition),
        registry_version: Math.trunc(Number(status.registry_version) || 0),
    };
}
function cloneMicroVMSessionRecord(record) {
    return normalizeMicroVMSessionRecord(record);
}
function normalizeMicroVMSessionRegistryRecord(record) {
    const out = {
        pk: String(record.pk ?? "").trim(),
        sk: String(record.sk ?? "").trim(),
        tenant_id: String(record.tenant_id ?? "").trim(),
        namespace: String(record.namespace ?? "").trim(),
        session_id: String(record.session_id ?? "").trim(),
        state: normalizeMicroVMLifecycleState(record.state),
        desired_state: normalizeMicroVMLifecycleState(record.desired_state),
        endpoint: String(record.endpoint ?? "").trim(),
        microvm_id: String(record.microvm_id ?? "").trim(),
        image_ref: String(record.image_ref ?? "").trim(),
        network_connector_ref: String(record.network_connector_ref ?? "").trim(),
        controller_id: String(record.controller_id ?? "").trim(),
        created_at: cloneMicroVMDate(record.created_at),
        updated_at: cloneMicroVMDate(record.updated_at),
        expires_at: cloneMicroVMDate(record.expires_at),
        ttl: Math.trunc(Number(record.ttl) || 0),
        generation: Math.trunc(Number(record.generation) || 0),
        version: Math.trunc(Number(record.version) || 0),
        last_action: normalizeMicroVMCommand(record.last_action),
        last_command_id: String(record.last_command_id ?? "").trim(),
        auth_subject: String(record.auth_subject ?? "").trim(),
    };
    const metadata = cloneStringMap(record.metadata);
    if (metadata)
        out.metadata = metadata;
    return out;
}
function cloneMicroVMSessionRegistryRecord(record) {
    return normalizeMicroVMSessionRegistryRecord(record);
}
function microVMSessionFromRegistryRecordNoValidate(record) {
    const out = {
        tenant_id: record.tenant_id,
        namespace: record.namespace,
        session_id: record.session_id,
        state: record.state,
        desired_state: record.desired_state,
        endpoint: record.endpoint,
        microvm_id: record.microvm_id,
        image_ref: record.image_ref,
        network_connector_ref: record.network_connector_ref,
        controller_id: record.controller_id,
        created_at: cloneMicroVMDate(record.created_at),
        updated_at: cloneMicroVMDate(record.updated_at),
        expires_at: cloneMicroVMDate(record.expires_at),
        generation: record.generation,
        last_action: record.last_action,
        last_command_id: record.last_command_id,
        auth_subject: record.auth_subject,
    };
    const metadata = cloneStringMap(record.metadata);
    if (metadata)
        out.metadata = metadata;
    return out;
}
function normalizeMicroVMSessionKey(key) {
    return {
        tenant_id: String(key.tenant_id ?? "").trim(),
        namespace: String(key.namespace ?? "").trim(),
        session_id: String(key.session_id ?? "").trim(),
    };
}
function validateMicroVMSessionKey(key) {
    if (!key.tenant_id || !key.namespace || !key.session_id) {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session key is incomplete", "");
    }
}
function microVMSessionRegistryRecordKey(record) {
    return `${record.pk}\u0000${record.sk}`;
}
function microVMSessionRegistryRecordKeyFromKey(key) {
    return `${microVMSessionRegistryPartitionKey(key.tenant_id, key.namespace)}\u0000${microVMSessionRegistrySortKey(key.session_id)}`;
}
function registryRecordToTableItem(record) {
    const normalized = normalizeMicroVMSessionRegistryRecord(record);
    const out = {
        pk: normalized.pk,
        sk: normalized.sk,
        tenant_id: normalized.tenant_id,
        namespace: normalized.namespace,
        session_id: normalized.session_id,
        state: normalized.state,
        desired_state: normalized.desired_state,
        endpoint: normalized.endpoint,
        microvm_id: normalized.microvm_id,
        image_ref: normalized.image_ref,
        network_connector_ref: normalized.network_connector_ref,
        controller_id: normalized.controller_id,
        created_at: normalized.created_at.toISOString(),
        updated_at: normalized.updated_at.toISOString(),
        expires_at: normalized.expires_at.toISOString(),
        ttl: normalized.ttl,
        generation: normalized.generation,
        version: normalized.version,
        last_action: normalized.last_action,
        last_command_id: normalized.last_command_id,
        auth_subject: normalized.auth_subject,
    };
    const metadata = cloneStringMap(normalized.metadata);
    if (metadata)
        out["metadata"] = metadata;
    return out;
}
function registryRecordFromTableItem(item) {
    const record = {
        pk: stringRecordField(item, "pk"),
        sk: stringRecordField(item, "sk"),
        tenant_id: stringRecordField(item, "tenant_id"),
        namespace: stringRecordField(item, "namespace"),
        session_id: stringRecordField(item, "session_id"),
        state: stringRecordField(item, "state"),
        desired_state: stringRecordField(item, "desired_state"),
        endpoint: stringRecordField(item, "endpoint"),
        microvm_id: stringRecordField(item, "microvm_id"),
        image_ref: stringRecordField(item, "image_ref"),
        network_connector_ref: stringRecordField(item, "network_connector_ref"),
        controller_id: stringRecordField(item, "controller_id"),
        created_at: dateRecordField(item, "created_at"),
        updated_at: dateRecordField(item, "updated_at"),
        expires_at: dateRecordField(item, "expires_at"),
        ttl: numberRecordField(item, "ttl"),
        generation: numberRecordField(item, "generation"),
        version: numberRecordField(item, "version"),
        last_action: stringRecordField(item, "last_action"),
        last_command_id: stringRecordField(item, "last_command_id"),
        auth_subject: stringRecordField(item, "auth_subject"),
    };
    const metadata = recordMapField(item, "metadata");
    if (metadata)
        record.metadata = metadata;
    return record;
}
function asMicroVMSessionRegistryError(err, requestID) {
    if (err instanceof MicroVMSafeError) {
        return err.request_id ? err : safeError(err.code, err.message, requestID);
    }
    return safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session registry operation failed", requestID);
}
function stringRecordField(item, key) {
    return String(item[key] ?? "").trim();
}
function numberRecordField(item, key) {
    const raw = Number(item[key] ?? 0);
    return Number.isFinite(raw) ? Math.trunc(raw) : 0;
}
function dateRecordField(item, key) {
    return cloneMicroVMDateFromUnknown(item[key]);
}
function recordMapField(item, key) {
    const raw = item[key];
    return raw && typeof raw === "object" && !Array.isArray(raw)
        ? cloneStringMap(raw)
        : undefined;
}
function cloneMicroVMDateFromUnknown(value) {
    if (value instanceof Date) {
        return cloneMicroVMDate(value);
    }
    if (typeof value === "string" || typeof value === "number") {
        const parsed = new Date(value);
        if (validDate(parsed))
            return parsed;
    }
    return new Date(Number.NaN);
}
function microVMSessionRecordKey(record) {
    return microVMSessionKeyString(record.tenant_id, record.namespace, record.session_id);
}
function microVMSessionKeyString(tenantID, namespace, sessionID) {
    return `${String(tenantID ?? "").trim()}\u0000${String(namespace ?? "").trim()}\u0000${String(sessionID ?? "").trim()}`;
}
function coalesceMicroVMTime(value, fallback) {
    if (validDate(value))
        return new Date(value.valueOf());
    if (validDate(fallback))
        return new Date(fallback.valueOf());
    return new Date(0);
}
function cloneMicroVMDate(value) {
    return validDate(value) ? new Date(value.valueOf()) : new Date(Number.NaN);
}
function validDate(value) {
    return value instanceof Date && Number.isFinite(value.valueOf());
}
function randomMicroVMSessionID() {
    try {
        return `microvm-${randomBytes(16).toString("hex")}`;
    }
    catch {
        return `microvm-${new Date().toISOString().replace(/[^0-9]/g, "")}`;
    }
}
function getSDKConstructor(sdk, names) {
    for (const name of names) {
        const candidate = sdk[name];
        if (typeof candidate === "function") {
            return candidate;
        }
    }
    throw safeError(MICROVM_ERROR_CONTROLLER_INCOMPLETE, "apptheory: microvm AWS SDK lacks Lambda MicroVM support", "");
}
function queryAWSInput(input) {
    return {
        tenantId: input.tenant_id,
        namespace: input.namespace,
        sessionId: input.session_id,
    };
}
function sessionRecordFromAWSOutput(input, output, state, desiredState) {
    const now = coalesceMicroVMTime(input.now, new Date());
    const createdAt = dateField(output, "createdAt") ?? now;
    const updatedAt = dateField(output, "updatedAt") ?? now;
    const expiresAt = dateField(output, "expiresAt") ?? new Date(now.valueOf() + 60 * 60 * 1000);
    const record = {
        tenant_id: stringField(output, "tenantId") || input.tenant_id,
        namespace: stringField(output, "namespace") || input.namespace,
        session_id: stringField(output, "sessionId") || input.session_id,
        state: stringField(output, "state") || state,
        desired_state: stringField(output, "desiredState") || desiredState,
        endpoint: stringField(output, "endpoint"),
        microvm_id: stringField(output, "microvmId"),
        image_ref: stringField(output, "imageRef") || input.image_ref,
        network_connector_ref: stringField(output, "networkConnectorRef") || input.network_connector_ref,
        controller_id: stringField(output, "controllerId") || input.controller_id,
        created_at: createdAt,
        updated_at: updatedAt,
        expires_at: expiresAt,
        generation: numberField(output, "generation") || 1,
        last_action: stringField(output, "lastAction") ||
            defaultMicroVMLastAction(state, desiredState),
        last_command_id: input.request_id,
        auth_subject: input.auth_subject,
    };
    const metadata = cloneStringMap(input.session_spec.metadata);
    if (metadata)
        record.metadata = metadata;
    return record;
}
function defaultMicroVMLastAction(state, desiredState) {
    const normalizedState = normalizeMicroVMLifecycleState(state);
    const normalizedDesired = normalizeMicroVMLifecycleState(desiredState);
    if (normalizedState === MicroVMState.Requested &&
        normalizedDesired === MicroVMState.Requested) {
        return MicroVMCommand.Create;
    }
    if (normalizedDesired === MicroVMState.Started) {
        return MicroVMCommand.Start;
    }
    if (normalizedDesired === MicroVMState.Stopped) {
        return MicroVMCommand.Stop;
    }
    return MicroVMCommand.Session;
}
function sessionStatusFromAWSOutput(input, output) {
    return {
        tenant_id: stringField(output, "tenantId") || input.tenant_id,
        namespace: stringField(output, "namespace") || input.namespace,
        session_id: stringField(output, "sessionId") || input.session_id,
        state: stringField(output, "state") || MicroVMState.Requested,
        desired_state: stringField(output, "desiredState") || MicroVMState.Requested,
        lifecycle_state: stringField(output, "lifecycleState") ||
            stringField(output, "state") ||
            MicroVMState.Requested,
        endpoint: stringField(output, "endpoint"),
        microvm_id: stringField(output, "microvmId"),
        last_action: stringField(output, "lastAction") || MicroVMCommand.Status,
        last_transition: dateField(output, "lastTransition") ?? new Date(),
        registry_version: numberField(output, "registryVersion") || 1,
    };
}
function asRecord(value) {
    return value && typeof value === "object"
        ? value
        : {};
}
function stringField(value, key) {
    return String(asRecord(value)[key] ?? "").trim();
}
function numberField(value, key) {
    const raw = Number(asRecord(value)[key] ?? 0);
    return Number.isFinite(raw) ? Math.trunc(raw) : 0;
}
function dateField(value, key) {
    const raw = asRecord(value)[key];
    if (raw instanceof Date && validDate(raw))
        return new Date(raw.valueOf());
    if (typeof raw === "string" || typeof raw === "number") {
        const parsed = new Date(raw);
        if (validDate(parsed))
            return parsed;
    }
    return null;
}
