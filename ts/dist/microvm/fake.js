import { MICROVM_DEFAULT_SESSION_PROVIDER_ID, MICROVM_ERROR_TENANT_BINDING_VIOLATION, MICROVM_ERROR_PROVIDER_OPERATION_FAILED, MicroVMCommand, MicroVMOperation, MicroVMRealState, MicroVMState, } from "./model.js";
import { safeError } from "./errors.js";
import { mapMicroVMProviderState, normalizeMicroVMOperation, normalizeMicroVMProviderState, isRequiredMicroVMOperation, } from "./operation-contract.js";
import { cloneMicroVMSessionRecord, microVMSessionRecordKey, microVMSessionKeyString, validateMicroVMSessionRecord, } from "./session.js";
import { cloneMicroVMProviderSession, cloneMicroVMProviderToken, defaultProviderTokenTTLSeconds, fakeMicroVMProviderError, microVMProviderTokenScope, microVMProviderSessionKeyString, validateMicroVMProviderSession, validateMicroVMProviderToken, validateMicroVMProviderListInputInternal, validateMicroVMProviderRunInputInternal, validateMicroVMProviderSessionInputInternal, validateMicroVMProviderTokenInputInternal, } from "./provider.js";
import { cloneStringMap } from "./safety.js";
import { coalesceMicroVMTime, validDate } from "./time.js";
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
            provider_id: MICROVM_DEFAULT_SESSION_PROVIDER_ID,
            provider_microvm_id: input.session_id,
            provider_state: MicroVMState.Requested,
            aws_lifecycle_state: MicroVMState.Requested,
            image_ref: input.image_ref,
            network_connector_ref: input.network_connector_ref,
            controller_id: input.controller_id,
            created_at: now,
            updated_at: now,
            last_observed_at: now,
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
            provider_id: record.provider_id || MICROVM_DEFAULT_SESSION_PROVIDER_ID,
            provider_microvm_id: record.provider_microvm_id || record.session_id,
            provider_state: state,
            aws_lifecycle_state: state,
            controller_id: input.controller_id,
            auth_subject: input.auth_subject,
            last_action: command,
            last_command_id: input.request_id,
            updated_at: coalesceMicroVMTime(input.now, this.currentTime),
            last_observed_at: coalesceMicroVMTime(input.now, this.currentTime),
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
export class FakeMicroVMProvider {
    currentTime;
    next = 0;
    tokens = 0;
    sessions = new Map();
    errors = new Map();
    recordedCalls = [];
    constructor(now = new Date(0)) {
        this.currentTime = coalesceMicroVMTime(now, new Date(0));
    }
    setNow(now) {
        if (validDate(now))
            this.currentTime = new Date(now.valueOf());
    }
    setOperationError(operation, err = safeError(MICROVM_ERROR_PROVIDER_OPERATION_FAILED, "apptheory: microvm provider operation failed", "")) {
        const normalized = normalizeMicroVMOperation(operation);
        if (!isRequiredMicroVMOperation(normalized))
            return;
        if (err == null) {
            this.errors.delete(normalized);
            return;
        }
        this.errors.set(normalized, err);
    }
    calls() {
        return this.recordedCalls.map((call) => ({ ...call }));
    }
    async run(input) {
        const normalized = validateMicroVMProviderRunInputInternal(input);
        this.recordCall(MicroVMOperation.Run, normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.session_id);
        const configured = this.configuredError(MicroVMOperation.Run, normalized.request_id);
        if (configured)
            throw configured;
        const key = microVMProviderSessionKeyString(normalized.tenant_id, normalized.namespace, normalized.session_id);
        if (this.sessions.has(key)) {
            throw fakeMicroVMProviderError(normalized.request_id);
        }
        this.next += 1;
        const session = {
            tenant_id: normalized.tenant_id,
            namespace: normalized.namespace,
            session_id: normalized.session_id,
            provider_microvm_id: `microvm-${String(this.next).padStart(6, "0")}`,
            state: MicroVMRealState.Running,
            provider_state: "running",
            image_ref: normalized.image_ref,
            terminal: false,
            registry_version: this.next,
            started_at: new Date(this.currentTime.valueOf()),
        };
        if (normalized.image_version)
            session.image_version = normalized.image_version;
        validateMicroVMProviderSession(session);
        this.sessions.set(key, cloneMicroVMProviderSession(session));
        return cloneMicroVMProviderSession(session);
    }
    async get(input) {
        return this.lookup(MicroVMOperation.Get, input);
    }
    async list(input) {
        const normalized = validateMicroVMProviderListInputInternal(input);
        this.recordCall(MicroVMOperation.List, normalized.request_id, normalized.tenant_id, normalized.namespace, "");
        const configured = this.configuredError(MicroVMOperation.List, normalized.request_id);
        if (configured)
            throw configured;
        const sessions = [...this.sessions.values()]
            .filter((session) => session.tenant_id === normalized.tenant_id &&
            session.namespace === normalized.namespace &&
            (!normalized.image_ref ||
                session.image_ref === normalized.image_ref) &&
            (!normalized.image_version ||
                session.image_version === normalized.image_version))
            .sort((left, right) => left.session_id.localeCompare(right.session_id))
            .map(cloneMicroVMProviderSession);
        return { sessions };
    }
    async suspend(input) {
        return this.transition(MicroVMOperation.Suspend, input, "suspended");
    }
    async resume(input) {
        return this.transition(MicroVMOperation.Resume, input, "ready");
    }
    async terminate(input) {
        return this.transition(MicroVMOperation.Terminate, input, "terminated");
    }
    async createAuthToken(input) {
        return this.token(MicroVMOperation.AuthToken, input);
    }
    async createShellToken(input) {
        return this.token(MicroVMOperation.ShellToken, input);
    }
    async lookup(operation, input) {
        const normalized = validateMicroVMProviderSessionInputInternal(operation, input);
        this.recordCall(operation, normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.binding.session_id);
        const configured = this.configuredError(operation, normalized.request_id);
        if (configured)
            throw configured;
        return this.boundSession(normalized.request_id, normalized.binding);
    }
    async transition(operation, input, providerState) {
        const normalized = validateMicroVMProviderSessionInputInternal(operation, input);
        this.recordCall(operation, normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.binding.session_id);
        const configured = this.configuredError(operation, normalized.request_id);
        if (configured)
            throw configured;
        const session = this.boundSession(normalized.request_id, normalized.binding);
        const mapped = mapMicroVMProviderState(providerState);
        const next = {
            ...session,
            provider_state: normalizeMicroVMProviderState(providerState),
            state: mapped.state,
            terminal: mapped.terminal,
            registry_version: Math.trunc(Number(session.registry_version ?? 0)) + 1,
        };
        if (providerState === "terminated") {
            next.terminated_at = new Date(this.currentTime.valueOf());
        }
        validateMicroVMProviderSession(next);
        this.sessions.set(microVMProviderSessionKeyString(next.tenant_id, next.namespace, next.session_id), cloneMicroVMProviderSession(next));
        return cloneMicroVMProviderSession(next);
    }
    async token(operation, input) {
        const normalized = validateMicroVMProviderTokenInputInternal(operation, input);
        this.recordCall(operation, normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.binding.session_id);
        const configured = this.configuredError(operation, normalized.request_id);
        if (configured)
            throw configured;
        this.boundSession(normalized.request_id, normalized.binding);
        const tokenType = operation === MicroVMOperation.ShellToken ? "shell" : "auth";
        const scope = microVMProviderTokenScope(operation, normalized.allowed_port_scope ?? []);
        const ttl = normalized.ttl_seconds ?? defaultProviderTokenTTLSeconds;
        this.tokens += 1;
        const token = {
            tenant_id: normalized.binding.tenant_id,
            namespace: normalized.binding.namespace,
            session_id: normalized.binding.session_id,
            provider_microvm_id: normalized.binding.provider_microvm_id,
            token_id: `${tokenType}-${String(this.tokens).padStart(6, "0")}`,
            token_type: tokenType,
            expires_at: new Date(this.currentTime.valueOf() + ttl * 1000),
            scope,
        };
        validateMicroVMProviderToken(token);
        return cloneMicroVMProviderToken(token);
    }
    boundSession(requestID, binding) {
        const key = microVMProviderSessionKeyString(binding.tenant_id, binding.namespace, binding.session_id);
        const session = this.sessions.get(key);
        if (!session ||
            session.provider_microvm_id !== binding.provider_microvm_id) {
            throw safeError(MICROVM_ERROR_TENANT_BINDING_VIOLATION, "apptheory: microvm provider binding is not available", requestID);
        }
        return cloneMicroVMProviderSession(session);
    }
    configuredError(operation, requestID) {
        if (!this.errors.has(operation))
            return null;
        return fakeMicroVMProviderError(requestID);
    }
    recordCall(operation, requestID, tenantID, namespace, sessionID) {
        this.recordedCalls.push({
            operation,
            request_id: String(requestID ?? "").trim(),
            tenant_id: String(tenantID ?? "").trim(),
            namespace: String(namespace ?? "").trim(),
            session_id: String(sessionID ?? "").trim(),
        });
    }
}
export function createFakeMicroVMProvider(now = new Date(0)) {
    return new FakeMicroVMProvider(now);
}
//# sourceMappingURL=fake.js.map