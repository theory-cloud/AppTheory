import { createHash } from "node:crypto";
import { MICROVM_ERROR_FORBIDDEN_FIELD, MICROVM_ERROR_PROVIDER_OPERATION_FAILED, MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED, MICROVM_ERROR_PROVIDER_REQUEST_INVALID, MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE, MICROVM_ERROR_TENANT_BINDING_VIOLATION, MICROVM_ERROR_TOKEN_SAFETY_VIOLATION, MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER, MICROVM_ENV_EXECUTION_ROLE_ARN, MICROVM_ENV_LOGGING, MicroVMOperation, MicroVMSafeError, } from "./model.js";
import { safeError } from "./errors.js";
import { isRequiredMicroVMOperation, mapMicroVMProviderState, normalizeMicroVMOperation, normalizeMicroVMProviderState, normalizeMicroVMRealLifecycleState, } from "./operation-contract.js";
import { forbiddenMicroVMFieldName, validateSafeMicroVMFieldValue, validateSafeMicroVMMetadata, } from "./safety.js";
import { cloneMicroVMDate, validDate } from "./time.js";
import { cloneMicroVMSessionSpec, normalizeMicroVMAuthContext, } from "./controller.js";
export function validateMicroVMProviderSession(session) {
    const normalized = normalizeMicroVMProviderSession(session);
    if (!normalized.tenant_id ||
        !normalized.namespace ||
        !normalized.session_id ||
        !normalized.provider_microvm_id) {
        throw safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider session is incomplete", "");
    }
    const mapped = mapMicroVMProviderState(normalized.provider_state);
    if (normalized.state !== mapped.state ||
        normalized.terminal !== mapped.terminal) {
        throw safeError(MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE, "apptheory: microvm provider session state mapping mismatch", "");
    }
    if (forbiddenMicroVMFieldName(normalized.provider_microvm_id) ||
        forbiddenMicroVMFieldName(normalized.endpoint ?? "") ||
        forbiddenMicroVMFieldName(normalized.image_ref ?? "") ||
        forbiddenMicroVMFieldName(normalized.image_version ?? "")) {
        throw safeError(MICROVM_ERROR_FORBIDDEN_FIELD, "apptheory: microvm provider session exposes forbidden field", "");
    }
}
export function validateMicroVMProviderRunInput(input) {
    validateMicroVMProviderRunInputInternal(input);
}
export function validateMicroVMProviderSessionInput(operation, input) {
    validateMicroVMProviderSessionInputInternal(operation, input);
}
export function validateMicroVMProviderListInput(input) {
    validateMicroVMProviderListInputInternal(input);
}
export function validateMicroVMProviderTokenInput(operation, input) {
    validateMicroVMProviderTokenInputInternal(operation, input);
}
export function validateMicroVMProviderInvokeInput(input) {
    validateMicroVMProviderInvokeInputInternal(input);
}
export function validateMicroVMProviderToken(token) {
    const normalized = normalizeMicroVMProviderToken(token);
    if (!normalized.tenant_id ||
        !normalized.namespace ||
        !normalized.session_id ||
        !normalized.provider_microvm_id ||
        !normalized.token_id ||
        !normalized.token_type ||
        !validDate(normalized.expires_at) ||
        normalized.scope.length === 0) {
        throw safeError(MICROVM_ERROR_TOKEN_SAFETY_VIOLATION, "apptheory: microvm provider token metadata is incomplete", "");
    }
    for (const field of [
        normalized.provider_microvm_id,
        normalized.token_id,
        normalized.token_type,
        ...normalized.scope,
    ]) {
        if (forbiddenMicroVMFieldName(field)) {
            throw safeError(MICROVM_ERROR_TOKEN_SAFETY_VIOLATION, "apptheory: microvm provider token metadata exposes forbidden field", "");
        }
    }
}
export const defaultProviderTokenTTLSeconds = 900;
export const minProviderTokenTTLSeconds = 1;
export const maxProviderTokenTTLSeconds = 900;
export const defaultProviderInvokePort = 8080;
export const defaultProviderInvokeTTLSeconds = 60;
export const maxProviderInvokeBodyBytes = 6 * 1024 * 1024;
export function validateMicroVMProviderRunInputInternal(input) {
    const normalized = normalizeMicroVMProviderRunInput(input);
    validateMicroVMProviderOperation(MicroVMOperation.Run, normalized.request_id);
    validateMicroVMProviderAccess(normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.auth_context);
    if (!normalized.request_id) {
        throw safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider request_id is required", "");
    }
    if (!normalized.session_id || !normalized.image_ref) {
        throw safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider run requires session_id and image_ref", normalized.request_id);
    }
    if (forbiddenMicroVMFieldName(normalized.image_ref) ||
        forbiddenMicroVMFieldName(normalized.image_version ?? "")) {
        throw safeError(MICROVM_ERROR_FORBIDDEN_FIELD, "apptheory: microvm provider run exposes forbidden field", normalized.request_id);
    }
    const metadataError = validateSafeMicroVMMetadata(normalized.session_spec?.metadata, normalized.request_id);
    if (metadataError)
        throw metadataError;
    validateSafeMicroVMConnectorRefs(normalized.request_id, [
        normalized.network_connector_ref ?? "",
        ...(normalized.ingress_network_connector_refs ?? []),
        ...(normalized.egress_network_connector_refs ?? []),
    ]);
    const executionRoleErr = validateMicroVMExecutionRoleArn(normalized.execution_role_arn ?? "", normalized.request_id);
    if (executionRoleErr)
        throw executionRoleErr;
    const loggingErr = validateMicroVMProviderLogging(input.logging, normalized.execution_role_arn ?? "", normalized.request_id);
    if (loggingErr)
        throw loggingErr;
    const policy = normalized.idle_policy;
    if (policy &&
        (policy.max_idle_duration_seconds <= 0 ||
            policy.suspended_duration_seconds <= 0)) {
        throw safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider idle policy is incomplete", normalized.request_id);
    }
    if ((normalized.maximum_duration_seconds ?? 0) < 0) {
        throw safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider maximum duration is invalid", normalized.request_id);
    }
    return normalized;
}
export function validateMicroVMProviderSessionInputInternal(operation, input) {
    const normalized = normalizeMicroVMProviderSessionInput(input);
    const normalizedOperation = normalizeMicroVMOperation(operation);
    validateMicroVMProviderOperation(normalizedOperation, normalized.request_id);
    if (!normalized.request_id) {
        throw safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider request_id is required", "");
    }
    validateMicroVMProviderAccess(normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.auth_context);
    normalized.binding = validateMicroVMProviderBinding(normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.binding);
    return normalized;
}
export function validateMicroVMProviderListInputInternal(input) {
    const normalized = normalizeMicroVMProviderListInput(input);
    validateMicroVMProviderOperation(MicroVMOperation.List, normalized.request_id);
    if (!normalized.request_id) {
        throw safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider request_id is required", "");
    }
    validateMicroVMProviderAccess(normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.auth_context);
    if (forbiddenMicroVMFieldName(normalized.image_ref ?? "") ||
        forbiddenMicroVMFieldName(normalized.image_version ?? "")) {
        throw safeError(MICROVM_ERROR_FORBIDDEN_FIELD, "apptheory: microvm provider list exposes forbidden field", normalized.request_id);
    }
    normalized.known_sessions = (normalized.known_sessions ?? []).map((binding) => validateMicroVMProviderBinding(normalized.request_id, normalized.tenant_id, normalized.namespace, binding));
    if ((normalized.max_results ?? 0) < 0) {
        throw safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider list max_results is invalid", normalized.request_id);
    }
    return normalized;
}
export function validateMicroVMProviderTokenInputInternal(operation, input) {
    const normalized = normalizeMicroVMProviderTokenInput(input);
    const normalizedOperation = normalizeMicroVMOperation(operation);
    validateMicroVMProviderOperation(normalizedOperation, normalized.request_id);
    if (!normalized.request_id) {
        throw safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider request_id is required", "");
    }
    if (normalizedOperation !== MicroVMOperation.AuthToken &&
        normalizedOperation !== MicroVMOperation.ShellToken) {
        throw safeError(MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED, "apptheory: microvm provider token operation is unsupported", normalized.request_id);
    }
    validateMicroVMProviderAccess(normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.auth_context);
    normalized.binding = validateMicroVMProviderBinding(normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.binding);
    const ttl = normalized.ttl_seconds ?? 0;
    normalized.ttl_seconds = ttl === 0 ? defaultProviderTokenTTLSeconds : ttl;
    if (normalized.ttl_seconds < minProviderTokenTTLSeconds ||
        normalized.ttl_seconds > maxProviderTokenTTLSeconds) {
        throw safeError(MICROVM_ERROR_TOKEN_SAFETY_VIOLATION, "apptheory: microvm provider token ttl exceeds contract bounds", normalized.request_id);
    }
    if (normalizedOperation === MicroVMOperation.AuthToken &&
        (normalized.allowed_port_scope ?? []).length === 0) {
        throw safeError(MICROVM_ERROR_TOKEN_SAFETY_VIOLATION, "apptheory: microvm auth token requires an explicit allowed port scope", normalized.request_id);
    }
    for (const scope of normalized.allowed_port_scope ?? []) {
        validateMicroVMProviderPortScope(scope, normalized.request_id);
    }
    return normalized;
}
export function validateMicroVMProviderInvokeInputInternal(input) {
    const normalized = normalizeMicroVMProviderInvokeInput(input);
    validateMicroVMProviderOperation(MicroVMOperation.Invoke, normalized.request_id);
    if (!normalized.request_id) {
        throw safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider request_id is required", "");
    }
    validateMicroVMProviderAccess(normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.auth_context);
    normalized.binding = validateMicroVMProviderBinding(normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.binding);
    if (!providerInvokeMethods().has(normalized.method)) {
        throw safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm invoke method is unsupported", normalized.request_id);
    }
    if (!normalized.endpoint ||
        forbiddenMicroVMFieldName(normalized.endpoint) ||
        !providerInvokeURL(normalized.endpoint, normalized.path, normalized.query)) {
        throw safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm invoke endpoint is invalid", normalized.request_id);
    }
    if (!normalized.path || normalized.path.includes("\0")) {
        throw safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm invoke path is invalid", normalized.request_id);
    }
    if ((normalized.port ?? 0) <= 0 || (normalized.port ?? 0) > 65535) {
        throw safeError(MICROVM_ERROR_TOKEN_SAFETY_VIOLATION, "apptheory: microvm invoke port is invalid", normalized.request_id);
    }
    if ((normalized.ttl_seconds ?? 0) < minProviderTokenTTLSeconds ||
        (normalized.ttl_seconds ?? 0) > maxProviderTokenTTLSeconds) {
        throw safeError(MICROVM_ERROR_TOKEN_SAFETY_VIOLATION, "apptheory: microvm invoke token ttl exceeds contract bounds", normalized.request_id);
    }
    if ((normalized.body?.byteLength ?? 0) > maxProviderInvokeBodyBytes) {
        throw safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm invoke body is too large", normalized.request_id);
    }
    normalized.headers = sanitizeMicroVMProviderInvokeHeaders(normalized.headers ?? {});
    return normalized;
}
export function validateMicroVMProviderOperation(operation, requestID) {
    if (!isRequiredMicroVMOperation(operation)) {
        throw safeError(MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED, "apptheory: microvm provider operation is unsupported", requestID);
    }
}
export function validateMicroVMProviderAccess(requestID, tenantID, namespace, auth) {
    const normalizedAuth = normalizeMicroVMAuthContext(auth);
    if (!String(tenantID ?? "").trim() || !String(namespace ?? "").trim()) {
        throw safeError(MICROVM_ERROR_TENANT_BINDING_VIOLATION, "apptheory: microvm provider request requires tenant and namespace", requestID);
    }
    if (!normalizedAuth.subject || !normalizedAuth.tenant_id) {
        throw safeError(MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER, "apptheory: microvm provider request requires authenticated context", requestID);
    }
    if (normalizedAuth.tenant_id !== String(tenantID ?? "").trim()) {
        throw safeError(MICROVM_ERROR_TENANT_BINDING_VIOLATION, "apptheory: microvm provider auth context is cross-tenant", requestID);
    }
    if (normalizedAuth.namespace &&
        normalizedAuth.namespace !== String(namespace ?? "").trim()) {
        throw safeError(MICROVM_ERROR_TENANT_BINDING_VIOLATION, "apptheory: microvm provider auth context is cross-namespace", requestID);
    }
    const metadataError = validateSafeMicroVMMetadata(normalizedAuth.metadata, requestID);
    if (metadataError)
        throw metadataError;
}
export function validateMicroVMProviderBinding(requestID, tenantID, namespace, binding) {
    const normalized = normalizeMicroVMProviderBinding(binding);
    if (!normalized.tenant_id ||
        !normalized.namespace ||
        !normalized.session_id ||
        !normalized.provider_microvm_id) {
        throw safeError(MICROVM_ERROR_TENANT_BINDING_VIOLATION, "apptheory: microvm provider binding is incomplete", requestID);
    }
    if (normalized.tenant_id !== String(tenantID ?? "").trim() ||
        normalized.namespace !== String(namespace ?? "").trim()) {
        throw safeError(MICROVM_ERROR_TENANT_BINDING_VIOLATION, "apptheory: microvm provider binding is cross-tenant", requestID);
    }
    if (forbiddenMicroVMFieldName(normalized.provider_microvm_id)) {
        throw safeError(MICROVM_ERROR_FORBIDDEN_FIELD, "apptheory: microvm provider binding exposes forbidden field", requestID);
    }
    return normalized;
}
export function validateMicroVMProviderPortScope(scope, requestID) {
    let options = 0;
    if (scope.all_ports === true)
        options += 1;
    if ((scope.port ?? 0) > 0)
        options += 1;
    if ((scope.start_port ?? 0) > 0 || (scope.end_port ?? 0) > 0) {
        options += 1;
        if ((scope.start_port ?? 0) <= 0 ||
            (scope.end_port ?? 0) <= 0 ||
            (scope.start_port ?? 0) > (scope.end_port ?? 0)) {
            throw safeError(MICROVM_ERROR_TOKEN_SAFETY_VIOLATION, "apptheory: microvm provider token port range is invalid", requestID);
        }
    }
    if (options !== 1) {
        throw safeError(MICROVM_ERROR_TOKEN_SAFETY_VIOLATION, "apptheory: microvm provider token port scope must specify exactly one scope", requestID);
    }
}
export function validateSafeMicroVMConnectorRefs(requestID, refs) {
    for (const ref of refs) {
        if (forbiddenMicroVMFieldName(ref)) {
            throw safeError(MICROVM_ERROR_FORBIDDEN_FIELD, "apptheory: microvm provider connector exposes forbidden field", requestID);
        }
    }
}
export function validateMicroVMExecutionRoleArn(value, requestID) {
    const arn = normalizeMicroVMExecutionRoleArn(value);
    if (!arn)
        return null;
    const safeErr = validateSafeMicroVMFieldValue(arn, requestID);
    if (safeErr)
        return safeErr;
    if (/\s/.test(arn) || !arn.startsWith("arn:") || !arn.includes(":role/")) {
        return safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider execution role arn is invalid", requestID);
    }
    return null;
}
export function normalizeMicroVMExecutionRoleArn(value) {
    return String(value ?? "").trim();
}
export function environmentMicroVMExecutionRoleArn() {
    if (typeof process === "undefined")
        return "";
    return normalizeMicroVMExecutionRoleArn(process.env?.[MICROVM_ENV_EXECUTION_ROLE_ARN] ?? "");
}
export function validateMicroVMProviderLogging(logging, executionRoleArn, requestID) {
    const normalized = normalizeMicroVMProviderLogging(logging);
    const keys = Object.keys((logging ?? {}));
    if (keys.some((key) => key !== "cloud_watch" && key !== "disabled")) {
        return safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider logging contains an unknown field", requestID);
    }
    const hasCloudWatch = normalized.cloud_watch !== undefined;
    const hasDisabled = normalized.disabled !== undefined;
    if (hasCloudWatch === hasDisabled ||
        (hasDisabled && normalized.disabled !== true)) {
        return safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider logging must specify exactly one of cloud_watch or disabled", requestID);
    }
    if (hasDisabled)
        return null;
    if (!normalizeMicroVMExecutionRoleArn(executionRoleArn)) {
        return safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider cloudwatch logging requires execution_role_arn", requestID);
    }
    const cloudWatch = normalized.cloud_watch ?? {};
    const rawCloudWatch = (logging ?? {}).cloud_watch;
    if (rawCloudWatch === null ||
        Array.isArray(rawCloudWatch) ||
        typeof rawCloudWatch !== "object") {
        return safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider cloudwatch logging is invalid", requestID);
    }
    const cloudWatchKeys = Object.keys(rawCloudWatch);
    if (cloudWatchKeys.some((key) => key !== "log_group" && key !== "log_stream")) {
        return safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider cloudwatch logging contains an unknown field", requestID);
    }
    if (cloudWatch.log_group &&
        !/^[a-zA-Z0-9_\-/.#]{1,512}$/.test(cloudWatch.log_group)) {
        return safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider cloudwatch log_group is invalid", requestID);
    }
    if (cloudWatch.log_stream &&
        (cloudWatch.log_stream.length > 512 || /[:*]/.test(cloudWatch.log_stream))) {
        return safeError(MICROVM_ERROR_PROVIDER_REQUEST_INVALID, "apptheory: microvm provider cloudwatch log_stream is invalid", requestID);
    }
    return null;
}
export function normalizeMicroVMProviderLogging(value) {
    const raw = (value ?? {});
    const out = {};
    if (raw.cloud_watch !== undefined && raw.cloud_watch !== null) {
        out.cloud_watch = {};
        const logGroup = String(raw.cloud_watch.log_group ?? "").trim();
        const logStream = String(raw.cloud_watch.log_stream ?? "").trim();
        if (logGroup)
            out.cloud_watch.log_group = logGroup;
        if (logStream)
            out.cloud_watch.log_stream = logStream;
    }
    if (Object.prototype.hasOwnProperty.call(raw, "disabled")) {
        out.disabled = raw.disabled === true;
    }
    return out;
}
export function environmentMicroVMProviderLogging() {
    if (typeof process === "undefined")
        return {};
    const raw = String(process.env?.[MICROVM_ENV_LOGGING] ?? "").trim();
    if (!raw)
        return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
            return {};
        }
        return parsed;
    }
    catch {
        return {};
    }
}
export function normalizeMicroVMProviderRunInput(input) {
    const out = {
        request_id: String(input.request_id ?? "").trim(),
        tenant_id: String(input.tenant_id ?? "").trim(),
        namespace: String(input.namespace ?? "").trim(),
        session_id: String(input.session_id ?? "").trim(),
        auth_context: normalizeMicroVMAuthContext(input.auth_context ?? {}),
        image_ref: String(input.image_ref ?? "").trim(),
        session_spec: cloneMicroVMSessionSpec(input.session_spec ?? {}),
        logging: normalizeMicroVMProviderLogging(input.logging),
    };
    const imageVersion = String(input.image_version ?? "").trim();
    if (imageVersion)
        out.image_version = imageVersion;
    const networkConnectorRef = String(input.network_connector_ref ?? "").trim();
    if (networkConnectorRef)
        out.network_connector_ref = networkConnectorRef;
    const ingress = normalizeStringArray(input.ingress_network_connector_refs ?? []);
    if (ingress.length > 0)
        out.ingress_network_connector_refs = ingress;
    const egress = normalizeStringArray(input.egress_network_connector_refs ?? []);
    if (egress.length > 0)
        out.egress_network_connector_refs = egress;
    if (input.idle_policy) {
        out.idle_policy = {
            auto_resume_enabled: input.idle_policy.auto_resume_enabled === true,
            max_idle_duration_seconds: Math.trunc(Number(input.idle_policy.max_idle_duration_seconds) || 0),
            suspended_duration_seconds: Math.trunc(Number(input.idle_policy.suspended_duration_seconds) || 0),
        };
    }
    if (input.maximum_duration_seconds !== undefined) {
        out.maximum_duration_seconds = Math.trunc(Number(input.maximum_duration_seconds) || 0);
    }
    const executionRoleArn = normalizeMicroVMExecutionRoleArn(input.execution_role_arn ?? "");
    if (executionRoleArn)
        out.execution_role_arn = executionRoleArn;
    return out;
}
export function normalizeMicroVMProviderSessionInput(input) {
    return {
        request_id: String(input.request_id ?? "").trim(),
        tenant_id: String(input.tenant_id ?? "").trim(),
        namespace: String(input.namespace ?? "").trim(),
        auth_context: normalizeMicroVMAuthContext(input.auth_context ?? {}),
        binding: normalizeMicroVMProviderBinding(input.binding ?? {}),
    };
}
export function normalizeMicroVMProviderListInput(input) {
    const out = {
        request_id: String(input.request_id ?? "").trim(),
        tenant_id: String(input.tenant_id ?? "").trim(),
        namespace: String(input.namespace ?? "").trim(),
        auth_context: normalizeMicroVMAuthContext(input.auth_context ?? {}),
    };
    const imageRef = String(input.image_ref ?? "").trim();
    if (imageRef)
        out.image_ref = imageRef;
    const imageVersion = String(input.image_version ?? "").trim();
    if (imageVersion)
        out.image_version = imageVersion;
    if (input.max_results !== undefined) {
        out.max_results = Math.trunc(Number(input.max_results) || 0);
    }
    const known = (input.known_sessions ?? []).map(normalizeMicroVMProviderBinding);
    if (known.length > 0)
        out.known_sessions = known;
    return out;
}
export function normalizeMicroVMProviderTokenInput(input) {
    const out = {
        request_id: String(input.request_id ?? "").trim(),
        tenant_id: String(input.tenant_id ?? "").trim(),
        namespace: String(input.namespace ?? "").trim(),
        auth_context: normalizeMicroVMAuthContext(input.auth_context ?? {}),
        binding: normalizeMicroVMProviderBinding(input.binding ?? {}),
    };
    if (input.ttl_seconds !== undefined) {
        out.ttl_seconds = Math.trunc(Number(input.ttl_seconds) || 0);
    }
    const scopes = (input.allowed_port_scope ?? []).map((scope) => ({
        all_ports: scope.all_ports === true,
        port: Math.trunc(Number(scope.port) || 0),
        start_port: Math.trunc(Number(scope.start_port) || 0),
        end_port: Math.trunc(Number(scope.end_port) || 0),
    }));
    if (scopes.length > 0)
        out.allowed_port_scope = scopes;
    return out;
}
export function normalizeMicroVMProviderInvokeInput(input) {
    const out = {
        request_id: String(input.request_id ?? "").trim(),
        tenant_id: String(input.tenant_id ?? "").trim(),
        namespace: String(input.namespace ?? "").trim(),
        auth_context: normalizeMicroVMAuthContext(input.auth_context ?? {}),
        binding: normalizeMicroVMProviderBinding(input.binding ?? {}),
        endpoint: String(input.endpoint ?? "").trim(),
        method: String(input.method ?? "")
            .trim()
            .toUpperCase(),
        path: normalizeMicroVMProviderInvokePath(input.path ?? "/"),
        query: cloneMicroVMQuery(input.query ?? {}),
        headers: sanitizeMicroVMProviderInvokeHeaders(input.headers ?? {}),
        body: input.body ? new Uint8Array(input.body) : new Uint8Array(),
        port: Math.trunc(Number(input.port ?? defaultProviderInvokePort) || 0),
        ttl_seconds: Math.trunc(Number(input.ttl_seconds ?? defaultProviderInvokeTTLSeconds) || 0),
    };
    if (out.port === 0)
        out.port = defaultProviderInvokePort;
    if (out.ttl_seconds === 0)
        out.ttl_seconds = defaultProviderInvokeTTLSeconds;
    return out;
}
export function normalizeMicroVMProviderBinding(binding) {
    const out = {
        tenant_id: String(binding.tenant_id ?? "").trim(),
        namespace: String(binding.namespace ?? "").trim(),
        session_id: String(binding.session_id ?? "").trim(),
        provider_microvm_id: String(binding.provider_microvm_id ?? "").trim(),
    };
    if (binding.registry_version !== undefined) {
        out.registry_version = Math.trunc(Number(binding.registry_version) || 0);
    }
    return out;
}
export function normalizeMicroVMProviderSession(session) {
    const out = {
        tenant_id: String(session.tenant_id ?? "").trim(),
        namespace: String(session.namespace ?? "").trim(),
        session_id: String(session.session_id ?? "").trim(),
        provider_microvm_id: String(session.provider_microvm_id ?? "").trim(),
        state: normalizeMicroVMRealLifecycleState(session.state),
        provider_state: normalizeMicroVMProviderState(session.provider_state),
        terminal: session.terminal === true,
    };
    const endpoint = String(session.endpoint ?? "").trim();
    if (endpoint)
        out.endpoint = endpoint;
    const imageRef = String(session.image_ref ?? "").trim();
    if (imageRef)
        out.image_ref = imageRef;
    const imageVersion = String(session.image_version ?? "").trim();
    if (imageVersion)
        out.image_version = imageVersion;
    if (validDate(session.started_at)) {
        out.started_at = cloneMicroVMDate(session.started_at);
    }
    if (validDate(session.terminated_at)) {
        out.terminated_at = cloneMicroVMDate(session.terminated_at);
    }
    if (session.registry_version !== undefined) {
        out.registry_version = Math.trunc(Number(session.registry_version) || 0);
    }
    return out;
}
export function normalizeMicroVMProviderToken(token) {
    return {
        tenant_id: String(token.tenant_id ?? "").trim(),
        namespace: String(token.namespace ?? "").trim(),
        session_id: String(token.session_id ?? "").trim(),
        provider_microvm_id: String(token.provider_microvm_id ?? "").trim(),
        token_id: String(token.token_id ?? "").trim(),
        token_type: String(token.token_type ?? "").trim(),
        expires_at: cloneMicroVMDate(token.expires_at),
        scope: normalizeStringArray(token.scope ?? []),
    };
}
export function cloneMicroVMProviderSession(session) {
    return normalizeMicroVMProviderSession(session);
}
export function cloneMicroVMProviderToken(token) {
    return normalizeMicroVMProviderToken(token);
}
export function normalizeStringArray(values) {
    return values.map((value) => String(value ?? "").trim()).filter(Boolean);
}
export function normalizeMicroVMProviderInvokePath(path) {
    const value = String(path ?? "").trim();
    if (!value)
        return "/";
    return value.startsWith("/") ? value : `/${value}`;
}
export function sanitizeMicroVMProviderInvokeHeaders(headers) {
    const out = {};
    for (const [rawName, rawValues] of Object.entries(headers ?? {})) {
        const name = String(rawName ?? "")
            .trim()
            .toLowerCase();
        if (!name || providerInvokeForbiddenHeaders().has(name))
            continue;
        const values = normalizeStringArray((rawValues ?? []).map((value) => String(value ?? ""))).filter((value) => !forbiddenMicroVMFieldName(value));
        if (values.length > 0)
            out[name] = values;
    }
    return out;
}
export function providerInvokeURL(endpoint, path, query = {}) {
    const raw = String(endpoint ?? "").trim();
    if (!raw)
        return "";
    let parsed;
    try {
        parsed = new URL(raw.startsWith("http://") || raw.startsWith("https://")
            ? raw
            : `https://${raw}`);
    }
    catch {
        return "";
    }
    if (!parsed.host)
        return "";
    parsed.protocol = "https:";
    parsed.pathname = normalizeMicroVMProviderInvokePath(path);
    parsed.search = "";
    const params = new URLSearchParams();
    for (const key of Object.keys(query ?? {}).sort()) {
        for (const value of query[key] ?? []) {
            params.append(key, String(value ?? "").trim());
        }
    }
    parsed.search = params.toString();
    return parsed.toString();
}
export function providerInvokePortHeader(port) {
    const normalized = Math.trunc(Number(port) || defaultProviderInvokePort);
    return String(normalized > 0 ? normalized : defaultProviderInvokePort);
}
export function providerInvokeResponseIsBase64(headers) {
    const contentType = String(headers["content-type"]?.[0] ?? "").toLowerCase();
    if (!contentType)
        return false;
    return ![
        "text/",
        "application/json",
        "application/xml",
        "application/javascript",
        "application/problem+json",
    ].some((prefix) => contentType.startsWith(prefix));
}
function cloneMicroVMQuery(query) {
    const out = {};
    for (const [rawKey, rawValues] of Object.entries(query ?? {})) {
        const key = String(rawKey ?? "").trim();
        if (!key)
            continue;
        out[key] = (rawValues ?? []).map((value) => String(value ?? "").trim());
    }
    return out;
}
function providerInvokeMethods() {
    return new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
}
function providerInvokeForbiddenHeaders() {
    return new Set([
        "authorization",
        "connection",
        "content-length",
        "host",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "x-amz-security-token",
        "x-apptheory-microvm-port",
        "x-apptheory-microvm-token-ttl",
        "x-aws-proxy-auth",
        "x-aws-proxy-port",
        "x-namespace-id",
        "x-tenant-id",
    ]);
}
export function microVMProviderSessionKeyString(tenantID, namespace, sessionID) {
    return `${String(tenantID ?? "").trim()}\u0000${String(namespace ?? "").trim()}\u0000${String(sessionID ?? "").trim()}`;
}
export function providerEgressConnectorRefs(input) {
    return uniqueStringArray([
        ...(input.egress_network_connector_refs ?? []),
        input.network_connector_ref ?? "",
    ]);
}
function uniqueStringArray(values) {
    return [...new Set(normalizeStringArray(values))];
}
export function safeMicroVMRunHookPayload(input) {
    return JSON.stringify({
        request_id: input.request_id,
        tenant_id: input.tenant_id,
        namespace: input.namespace,
        session_id: input.session_id,
    });
}
export function microVMProviderTokenMetadata(operation, input, now) {
    const tokenType = operation === MicroVMOperation.ShellToken ? "shell" : "auth";
    const ttl = input.ttl_seconds ?? defaultProviderTokenTTLSeconds;
    const expiresAt = new Date(now.valueOf() + ttl * 1000);
    const scope = microVMProviderTokenScope(operation, input.allowed_port_scope ?? []);
    const token = {
        tenant_id: input.binding.tenant_id,
        namespace: input.binding.namespace,
        session_id: input.binding.session_id,
        provider_microvm_id: input.binding.provider_microvm_id,
        token_id: safeMicroVMProviderTokenID(input.binding, tokenType, expiresAt, scope),
        token_type: tokenType,
        expires_at: expiresAt,
        scope,
    };
    validateMicroVMProviderToken(token);
    return token;
}
export function microVMProviderTokenScope(operation, scopes) {
    if (operation === MicroVMOperation.ShellToken)
        return ["shell"];
    return scopes
        .map((scope) => {
        if (scope.all_ports === true)
            return "ports:*";
        if ((scope.port ?? 0) > 0)
            return `ports:${Math.trunc(scope.port ?? 0)}`;
        return `ports:${Math.trunc(scope.start_port ?? 0)}-${Math.trunc(scope.end_port ?? 0)}`;
    })
        .sort();
}
export function safeMicroVMProviderTokenID(binding, tokenType, expiresAt, scope) {
    const parts = [
        binding.tenant_id,
        binding.namespace,
        binding.session_id,
        binding.provider_microvm_id,
        tokenType,
        formatMicroVMProviderDate(expiresAt),
        ...scope,
    ];
    const digest = createHash("sha256")
        .update(parts.join("\u0000"))
        .digest("hex")
        .slice(0, 16);
    return `${tokenType}-${digest}`;
}
export function formatMicroVMProviderDate(value) {
    const iso = value.toISOString();
    return iso.endsWith(".000Z") ? `${iso.slice(0, -5)}Z` : iso;
}
export function fakeMicroVMProviderError(requestID) {
    return safeError(MICROVM_ERROR_PROVIDER_OPERATION_FAILED, "apptheory: microvm provider operation failed", requestID);
}
export function asMicroVMProviderSafeError(err, requestID) {
    if (err instanceof MicroVMSafeError) {
        return err.request_id ? err : safeError(err.code, err.message, requestID);
    }
    return fakeMicroVMProviderError(requestID);
}
//# sourceMappingURL=provider.js.map