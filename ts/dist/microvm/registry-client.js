import { MICROVM_DEFAULT_SESSION_PROVIDER_ID, MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, MicroVMCommand, MicroVMState, } from "./model.js";
import { safeError } from "./errors.js";
import { validateMicroVMSessionStatus } from "./session.js";
import { cloneStringMap } from "./safety.js";
import { coalesceMicroVMTime } from "./time.js";
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
            provider_id: record.provider_id || MICROVM_DEFAULT_SESSION_PROVIDER_ID,
            provider_microvm_id: record.provider_microvm_id || record.session_id,
            provider_state: state,
            aws_lifecycle_state: state,
            controller_id: input.controller_id,
            auth_subject: input.auth_subject,
            last_action: action,
            last_command_id: input.request_id,
            updated_at: coalesceMicroVMTime(input.now, new Date(0)),
            last_observed_at: coalesceMicroVMTime(input.now, new Date(0)),
            generation: record.generation + 1,
        };
        return await this.registry.put(next);
    }
}
export function createMicroVMRegistryClient(registry, options = {}) {
    return new MicroVMRegistryClient(registry, options);
}
//# sourceMappingURL=registry-client.js.map