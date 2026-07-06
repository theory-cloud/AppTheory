import { CreateMicrovmAuthTokenCommand, CreateMicrovmShellAuthTokenCommand, GetMicrovmCommand, LambdaMicrovmsClient, ListMicrovmsCommand, ResumeMicrovmCommand, RunMicrovmCommand, SuspendMicrovmCommand, TerminateMicrovmCommand, } from "@aws-sdk/client-lambda-microvms";
import { MICROVM_ERROR_CONTROLLER_INCOMPLETE, MICROVM_ERROR_TOKEN_SAFETY_VIOLATION, MICROVM_ERROR_TENANT_BINDING_VIOLATION, MicroVMOperation, } from "./model.js";
import { safeError } from "./errors.js";
import { mapMicroVMProviderState, normalizeMicroVMProviderState, } from "./operation-contract.js";
import { asMicroVMProviderSafeError, defaultProviderTokenTTLSeconds, microVMProviderTokenMetadata, providerEgressConnectorRefs, safeMicroVMRunHookPayload, validateMicroVMProviderListInputInternal, validateMicroVMProviderRunInputInternal, validateMicroVMProviderSessionInputInternal, validateMicroVMProviderTokenInputInternal, validateMicroVMProviderSession, } from "./provider.js";
import { validDate } from "./time.js";
export async function createAWSLambdaMicroVMClient(_options = {}) {
    throw safeError(MICROVM_ERROR_CONTROLLER_INCOMPLETE, "apptheory: microvm legacy AWS session client is unsupported by the official Lambda MicroVM SDK", "");
}
export class AWSLambdaMicroVMProvider {
    client;
    clock;
    constructor(options = {}) {
        const region = String(options.region ?? "").trim();
        this.client = new LambdaMicrovmsClient(region ? { region } : {});
        this.clock = options.clock ?? { now: () => new Date() };
    }
    async run(input) {
        const normalized = validateMicroVMProviderRunInputInternal(input);
        try {
            const commandInput = {
                clientToken: normalized.request_id,
                imageIdentifier: normalized.image_ref,
                runHookPayload: safeMicroVMRunHookPayload(normalized),
            };
            const egress = providerEgressConnectorRefs(normalized);
            if (egress.length > 0)
                commandInput.egressNetworkConnectors = egress;
            if (normalized.execution_role_arn) {
                commandInput.executionRoleArn = normalized.execution_role_arn;
            }
            if ((normalized.ingress_network_connector_refs ?? []).length > 0) {
                commandInput.ingressNetworkConnectors = [
                    ...(normalized.ingress_network_connector_refs ?? []),
                ];
            }
            if (normalized.image_version)
                commandInput.imageVersion = normalized.image_version;
            if (normalized.idle_policy) {
                commandInput.idlePolicy = {
                    autoResumeEnabled: normalized.idle_policy.auto_resume_enabled,
                    maxIdleDurationSeconds: normalized.idle_policy.max_idle_duration_seconds,
                    suspendedDurationSeconds: normalized.idle_policy.suspended_duration_seconds,
                };
            }
            if ((normalized.maximum_duration_seconds ?? 0) > 0) {
                commandInput.maximumDurationInSeconds = Math.trunc(normalized.maximum_duration_seconds ?? 0);
            }
            const output = await this.client.send(new RunMicrovmCommand(commandInput));
            return microVMProviderSessionFromRunOutput(normalized, output);
        }
        catch (err) {
            throw asMicroVMProviderSafeError(err, normalized.request_id);
        }
    }
    async get(input) {
        const normalized = validateMicroVMProviderSessionInputInternal(MicroVMOperation.Get, input);
        try {
            const output = await this.client.send(new GetMicrovmCommand({
                microvmIdentifier: normalized.binding.provider_microvm_id,
            }));
            return microVMProviderSessionFromGetOutput(normalized.request_id, normalized.binding, output);
        }
        catch (err) {
            throw asMicroVMProviderSafeError(err, normalized.request_id);
        }
    }
    async list(input) {
        const normalized = validateMicroVMProviderListInputInternal(input);
        try {
            const commandInput = {};
            if (normalized.image_ref)
                commandInput.imageIdentifier = normalized.image_ref;
            if (normalized.image_version)
                commandInput.imageVersion = normalized.image_version;
            if ((normalized.max_results ?? 0) > 0) {
                commandInput.maxResults = Math.trunc(normalized.max_results ?? 0);
            }
            const output = await this.client.send(new ListMicrovmsCommand(commandInput));
            return microVMProviderListOutputFromSDK(normalized, output);
        }
        catch (err) {
            throw asMicroVMProviderSafeError(err, normalized.request_id);
        }
    }
    async suspend(input) {
        return await this.runStateChangingOperation(MicroVMOperation.Suspend, input, async (providerID) => {
            await this.client.send(new SuspendMicrovmCommand({ microvmIdentifier: providerID }));
        });
    }
    async resume(input) {
        return await this.runStateChangingOperation(MicroVMOperation.Resume, input, async (providerID) => {
            await this.client.send(new ResumeMicrovmCommand({ microvmIdentifier: providerID }));
        });
    }
    async terminate(input) {
        return await this.runStateChangingOperation(MicroVMOperation.Terminate, input, async (providerID) => {
            await this.client.send(new TerminateMicrovmCommand({ microvmIdentifier: providerID }));
        });
    }
    async createAuthToken(input) {
        const normalized = validateMicroVMProviderTokenInputInternal(MicroVMOperation.AuthToken, input);
        try {
            const commandInput = {
                allowedPorts: awsMicroVMPortScopes(normalized.allowed_port_scope ?? []),
                expirationInMinutes: providerExpirationMinutes(normalized.ttl_seconds ?? defaultProviderTokenTTLSeconds),
                microvmIdentifier: normalized.binding.provider_microvm_id,
            };
            const output = await this.client.send(new CreateMicrovmAuthTokenCommand(commandInput));
            ensureMicroVMProviderTokenResult(output, normalized.request_id);
            return microVMProviderTokenMetadata(MicroVMOperation.AuthToken, normalized, this.now());
        }
        catch (err) {
            throw asMicroVMProviderSafeError(err, normalized.request_id);
        }
    }
    async createShellToken(input) {
        const normalized = validateMicroVMProviderTokenInputInternal(MicroVMOperation.ShellToken, input);
        try {
            const commandInput = {
                expirationInMinutes: providerExpirationMinutes(normalized.ttl_seconds ?? defaultProviderTokenTTLSeconds),
                microvmIdentifier: normalized.binding.provider_microvm_id,
            };
            const output = await this.client.send(new CreateMicrovmShellAuthTokenCommand(commandInput));
            ensureMicroVMProviderTokenResult(output, normalized.request_id);
            return microVMProviderTokenMetadata(MicroVMOperation.ShellToken, normalized, this.now());
        }
        catch (err) {
            throw asMicroVMProviderSafeError(err, normalized.request_id);
        }
    }
    async runStateChangingOperation(operation, input, run) {
        const normalized = validateMicroVMProviderSessionInputInternal(operation, input);
        try {
            await run(normalized.binding.provider_microvm_id);
            const output = await this.client.send(new GetMicrovmCommand({
                microvmIdentifier: normalized.binding.provider_microvm_id,
            }));
            return microVMProviderSessionFromGetOutput(normalized.request_id, normalized.binding, output);
        }
        catch (err) {
            throw asMicroVMProviderSafeError(err, normalized.request_id);
        }
    }
    now() {
        const now = this.clock.now();
        return validDate(now) ? new Date(now.valueOf()) : new Date(0);
    }
}
export function createAWSLambdaMicroVMProvider(options = {}) {
    return new AWSLambdaMicroVMProvider(options);
}
export function microVMProviderSessionFromRunOutput(input, output) {
    const binding = {
        tenant_id: input.tenant_id,
        namespace: input.namespace,
        session_id: input.session_id,
        provider_microvm_id: stringField(output, "microvmId"),
    };
    return microVMProviderSessionFromProviderState(binding, stringField(output, "state"), stringField(output, "imageArn") || input.image_ref, stringField(output, "imageVersion") || input.image_version || "", dateField(output, "startedAt"), dateField(output, "terminatedAt"));
}
export function microVMProviderSessionFromGetOutput(requestID, binding, output) {
    const providerID = stringField(output, "microvmId");
    if (providerID && providerID !== binding.provider_microvm_id) {
        throw safeError(MICROVM_ERROR_TENANT_BINDING_VIOLATION, "apptheory: microvm provider returned mismatched session binding", requestID);
    }
    return microVMProviderSessionFromProviderState(binding, stringField(output, "state"), stringField(output, "imageArn"), stringField(output, "imageVersion"), dateField(output, "startedAt"), dateField(output, "terminatedAt"));
}
export function microVMProviderListOutputFromSDK(input, output) {
    const bindings = new Map();
    for (const binding of input.known_sessions ?? []) {
        bindings.set(binding.provider_microvm_id, binding);
    }
    const sessions = [];
    for (const item of arrayField(output, "items")) {
        const providerID = stringField(item, "microvmId");
        const binding = bindings.get(providerID);
        if (!binding)
            continue;
        sessions.push(microVMProviderSessionFromProviderState(binding, stringField(item, "state"), stringField(item, "imageArn"), stringField(item, "imageVersion"), dateField(item, "startedAt"), null));
    }
    return { sessions };
}
export function microVMProviderSessionFromProviderState(binding, providerState, imageRef, imageVersion, startedAt, terminatedAt) {
    const mapped = mapMicroVMProviderState(providerState);
    const session = {
        tenant_id: binding.tenant_id,
        namespace: binding.namespace,
        session_id: binding.session_id,
        provider_microvm_id: binding.provider_microvm_id,
        state: mapped.state,
        provider_state: normalizeMicroVMProviderState(providerState),
        terminal: mapped.terminal,
    };
    const cleanImageRef = String(imageRef ?? "").trim();
    if (cleanImageRef)
        session.image_ref = cleanImageRef;
    const cleanImageVersion = String(imageVersion ?? "").trim();
    if (cleanImageVersion)
        session.image_version = cleanImageVersion;
    if (startedAt && validDate(startedAt))
        session.started_at = startedAt;
    if (terminatedAt && validDate(terminatedAt))
        session.terminated_at = terminatedAt;
    if (binding.registry_version !== undefined) {
        session.registry_version = Math.trunc(Number(binding.registry_version) || 0);
    }
    validateMicroVMProviderSession(session);
    return session;
}
export function awsMicroVMPortScopes(scopes) {
    return scopes.map((scope) => {
        if (scope.all_ports === true)
            return { allPorts: {} };
        if ((scope.port ?? 0) > 0)
            return { port: Math.trunc(scope.port ?? 0) };
        return {
            range: {
                endPort: Math.trunc(scope.end_port ?? 0),
                startPort: Math.trunc(scope.start_port ?? 0),
            },
        };
    });
}
export function ensureMicroVMProviderTokenResult(output, requestID) {
    const authToken = asRecord(output)["authToken"];
    if (!authToken ||
        typeof authToken !== "object" ||
        Array.isArray(authToken) ||
        Object.keys(authToken).length === 0) {
        throw safeError(MICROVM_ERROR_TOKEN_SAFETY_VIOLATION, "apptheory: microvm provider returned incomplete token metadata", requestID);
    }
}
export function providerExpirationMinutes(ttlSeconds) {
    return Math.ceil(ttlSeconds / 60);
}
export function arrayField(value, key) {
    const raw = asRecord(value)[key];
    return Array.isArray(raw) ? raw : [];
}
export function asRecord(value) {
    return value && typeof value === "object"
        ? value
        : {};
}
export function stringField(value, key) {
    return String(asRecord(value)[key] ?? "").trim();
}
export function dateField(value, key) {
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
//# sourceMappingURL=aws-provider.js.map