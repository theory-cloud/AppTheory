import { defineModel } from "@theory-cloud/tabletheory-ts";
import { MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, MICROVM_ERROR_TOKEN_SAFETY_VIOLATION, MICROVM_SESSION_REGISTRY_MODEL_NAME, MICROVM_SESSION_REGISTRY_TABLE_ENV, MICROVM_SESSION_REGISTRY_TABLE_NAME, MicroVMSafeError, } from "./model.js";
import { safeError } from "./errors.js";
import { cloneStringMap, validateSafeMicroVMFieldValue, validateSafeMicroVMMetadata, } from "./safety.js";
import { cloneMicroVMDate, cloneMicroVMDateFromUnknown, validDate, } from "./time.js";
import { normalizeMicroVMCommand, validMicroVMCommand, validMicroVMLifecycleState, } from "./controller-contract.js";
import { normalizeMicroVMLifecycleState } from "./lifecycle.js";
import { normalizeMicroVMProviderToken, normalizeStringArray, validateMicroVMProviderToken, } from "./provider.js";
export function validateMicroVMSessionRecord(record) {
    const normalized = normalizeMicroVMSessionRecord(record);
    if (!normalized.tenant_id ||
        !normalized.namespace ||
        !normalized.session_id ||
        !normalized.state ||
        !normalized.desired_state ||
        !normalized.provider_id ||
        !normalized.provider_state ||
        !normalized.aws_lifecycle_state ||
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
        !validDate(normalized.last_observed_at) ||
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
    const providerErr = validateMicroVMSessionProviderFields(normalized);
    if (providerErr)
        throw providerErr;
    const metadataErr = validateSafeMicroVMMetadata(normalized.metadata, normalized.last_command_id);
    if (metadataErr)
        throw metadataErr;
    const reasonErr = validateSafeMicroVMMetadata(normalized.reason_metadata, normalized.last_command_id);
    if (reasonErr)
        throw reasonErr;
    const statusErr = validateSafeMicroVMMetadata(normalized.status_metadata, normalized.last_command_id);
    if (statusErr)
        throw statusErr;
}
export function validateMicroVMSessionProviderFields(record) {
    const fields = [
        record.endpoint ?? "",
        record.microvm_id ?? "",
        record.provider_id,
        record.provider_microvm_id ?? "",
        record.provider_state,
        record.aws_lifecycle_state,
        record.image_ref,
        record.image_version ?? "",
        record.network_connector_ref,
        ...(record.ingress_network_connector_refs ?? []),
        ...(record.egress_network_connector_refs ?? []),
    ];
    for (const field of fields) {
        const err = validateSafeMicroVMFieldValue(field, record.last_command_id);
        if (err)
            return err;
    }
    for (const token of record.token_metadata ?? []) {
        try {
            validateMicroVMSessionTokenMetadata(token, record.last_command_id);
        }
        catch (err) {
            if (err instanceof MicroVMSafeError)
                return err;
            return safeError(MICROVM_ERROR_TOKEN_SAFETY_VIOLATION, "apptheory: microvm session token metadata is incomplete", record.last_command_id);
        }
    }
    return null;
}
export function validateMicroVMSessionTokenMetadata(token, requestID = "") {
    const normalized = normalizeMicroVMSessionTokenMetadata(token);
    if (!normalized.token_id ||
        !normalized.token_type ||
        !validDate(normalized.expires_at) ||
        normalized.scope.length === 0) {
        throw safeError(MICROVM_ERROR_TOKEN_SAFETY_VIOLATION, "apptheory: microvm session token metadata is incomplete", requestID);
    }
    for (const field of [
        normalized.token_id,
        normalized.token_type,
        ...normalized.scope,
    ]) {
        const err = validateSafeMicroVMFieldValue(field, requestID);
        if (err)
            throw err;
    }
}
export function microVMSessionTokenMetadataFromProviderToken(token) {
    const normalized = normalizeMicroVMProviderToken(token);
    validateMicroVMProviderToken(normalized);
    const metadata = {
        token_id: normalized.token_id,
        token_type: normalized.token_type,
        expires_at: cloneMicroVMDate(normalized.expires_at),
        scope: [...normalized.scope],
    };
    validateMicroVMSessionTokenMetadata(metadata);
    return metadata;
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
            { attribute: "provider_id", type: "S", required: true },
            {
                attribute: "provider_microvm_id",
                type: "S",
                optional: true,
                omit_empty: true,
            },
            { attribute: "provider_state", type: "S", required: true },
            { attribute: "aws_lifecycle_state", type: "S", required: true },
            { attribute: "image_ref", type: "S", required: true },
            {
                attribute: "image_version",
                type: "S",
                optional: true,
                omit_empty: true,
            },
            { attribute: "network_connector_ref", type: "S", required: true },
            {
                attribute: "ingress_network_connector_refs",
                type: "L",
                optional: true,
                omit_empty: true,
            },
            {
                attribute: "egress_network_connector_refs",
                type: "L",
                optional: true,
                omit_empty: true,
            },
            { attribute: "controller_id", type: "S", required: true },
            { attribute: "created_at", type: "S", required: true },
            { attribute: "updated_at", type: "S", required: true },
            { attribute: "last_observed_at", type: "S", required: true },
            {
                attribute: "provider_started_at",
                type: "S",
                optional: true,
                omit_empty: true,
            },
            {
                attribute: "provider_terminated_at",
                type: "S",
                optional: true,
                omit_empty: true,
            },
            { attribute: "expires_at", type: "S", required: true },
            { attribute: "ttl", type: "N", roles: ["ttl"] },
            { attribute: "generation", type: "N", required: true },
            { attribute: "version", type: "N", roles: ["version"] },
            { attribute: "last_action", type: "S", required: true },
            { attribute: "last_command_id", type: "S", required: true },
            { attribute: "auth_subject", type: "S", required: true },
            {
                attribute: "reason_metadata",
                type: "M",
                optional: true,
                omit_empty: true,
            },
            {
                attribute: "status_metadata",
                type: "M",
                optional: true,
                omit_empty: true,
            },
            {
                attribute: "token_metadata",
                type: "L",
                optional: true,
                omit_empty: true,
            },
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
        provider_id: normalized.provider_id,
        provider_microvm_id: normalized.provider_microvm_id ?? "",
        provider_state: normalized.provider_state,
        aws_lifecycle_state: normalized.aws_lifecycle_state,
        image_ref: normalized.image_ref,
        image_version: normalized.image_version ?? "",
        network_connector_ref: normalized.network_connector_ref,
        ingress_network_connector_refs: [
            ...(normalized.ingress_network_connector_refs ?? []),
        ],
        egress_network_connector_refs: [
            ...(normalized.egress_network_connector_refs ?? []),
        ],
        controller_id: normalized.controller_id,
        created_at: cloneMicroVMDate(normalized.created_at),
        updated_at: cloneMicroVMDate(normalized.updated_at),
        last_observed_at: cloneMicroVMDate(normalized.last_observed_at),
        provider_started_at: cloneMicroVMDate(normalized.provider_started_at ?? new Date(Number.NaN)),
        provider_terminated_at: cloneMicroVMDate(normalized.provider_terminated_at ?? new Date(Number.NaN)),
        expires_at: cloneMicroVMDate(normalized.expires_at),
        ttl: Math.trunc(normalized.expires_at.getTime() / 1000),
        generation: normalized.generation,
        version: normalized.generation,
        last_action: normalized.last_action,
        last_command_id: normalized.last_command_id,
        auth_subject: normalized.auth_subject,
    };
    const reasonMetadata = cloneStringMap(normalized.reason_metadata);
    if (reasonMetadata)
        registry.reason_metadata = reasonMetadata;
    const statusMetadata = cloneStringMap(normalized.status_metadata);
    if (statusMetadata)
        registry.status_metadata = statusMetadata;
    const tokenMetadata = cloneMicroVMSessionTokenMetadataList(normalized.token_metadata);
    if (tokenMetadata)
        registry.token_metadata = tokenMetadata;
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
export function normalizeMicroVMSessionRecord(record) {
    const out = {
        tenant_id: String(record.tenant_id ?? "").trim(),
        namespace: String(record.namespace ?? "").trim(),
        session_id: String(record.session_id ?? "").trim(),
        state: normalizeMicroVMLifecycleState(record.state),
        desired_state: normalizeMicroVMLifecycleState(record.desired_state),
        endpoint: String(record.endpoint ?? "").trim(),
        microvm_id: String(record.microvm_id ?? "").trim(),
        provider_id: String(record.provider_id ?? "").trim(),
        provider_microvm_id: String(record.provider_microvm_id ?? "").trim(),
        provider_state: String(record.provider_state ?? "").trim(),
        aws_lifecycle_state: String(record.aws_lifecycle_state ?? "").trim(),
        image_ref: String(record.image_ref ?? "").trim(),
        image_version: String(record.image_version ?? "").trim(),
        network_connector_ref: String(record.network_connector_ref ?? "").trim(),
        ingress_network_connector_refs: normalizeStringArray(record.ingress_network_connector_refs ?? []),
        egress_network_connector_refs: normalizeStringArray(record.egress_network_connector_refs ?? []),
        controller_id: String(record.controller_id ?? "").trim(),
        created_at: cloneMicroVMDate(record.created_at),
        updated_at: cloneMicroVMDate(record.updated_at),
        last_observed_at: cloneMicroVMDate(record.last_observed_at),
        provider_started_at: cloneMicroVMDate(record.provider_started_at ?? new Date(Number.NaN)),
        provider_terminated_at: cloneMicroVMDate(record.provider_terminated_at ?? new Date(Number.NaN)),
        expires_at: cloneMicroVMDate(record.expires_at),
        generation: Math.trunc(Number(record.generation) || 0),
        last_action: normalizeMicroVMCommand(record.last_action),
        last_command_id: String(record.last_command_id ?? "").trim(),
        auth_subject: String(record.auth_subject ?? "").trim(),
    };
    const reasonMetadata = cloneStringMap(record.reason_metadata);
    if (reasonMetadata)
        out.reason_metadata = reasonMetadata;
    const statusMetadata = cloneStringMap(record.status_metadata);
    if (statusMetadata)
        out.status_metadata = statusMetadata;
    const tokenMetadata = cloneMicroVMSessionTokenMetadataList(record.token_metadata);
    if (tokenMetadata)
        out.token_metadata = tokenMetadata;
    const metadata = cloneStringMap(record.metadata);
    if (metadata)
        out.metadata = metadata;
    return out;
}
export function normalizeMicroVMSessionStatus(status) {
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
export function cloneMicroVMSessionRecord(record) {
    return normalizeMicroVMSessionRecord(record);
}
export function normalizeMicroVMSessionRegistryRecord(record) {
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
        provider_id: String(record.provider_id ?? "").trim(),
        provider_microvm_id: String(record.provider_microvm_id ?? "").trim(),
        provider_state: String(record.provider_state ?? "").trim(),
        aws_lifecycle_state: String(record.aws_lifecycle_state ?? "").trim(),
        image_ref: String(record.image_ref ?? "").trim(),
        image_version: String(record.image_version ?? "").trim(),
        network_connector_ref: String(record.network_connector_ref ?? "").trim(),
        ingress_network_connector_refs: normalizeStringArray(record.ingress_network_connector_refs ?? []),
        egress_network_connector_refs: normalizeStringArray(record.egress_network_connector_refs ?? []),
        controller_id: String(record.controller_id ?? "").trim(),
        created_at: cloneMicroVMDate(record.created_at),
        updated_at: cloneMicroVMDate(record.updated_at),
        last_observed_at: cloneMicroVMDate(record.last_observed_at),
        provider_started_at: cloneMicroVMDate(record.provider_started_at),
        provider_terminated_at: cloneMicroVMDate(record.provider_terminated_at),
        expires_at: cloneMicroVMDate(record.expires_at),
        ttl: Math.trunc(Number(record.ttl) || 0),
        generation: Math.trunc(Number(record.generation) || 0),
        version: Math.trunc(Number(record.version) || 0),
        last_action: normalizeMicroVMCommand(record.last_action),
        last_command_id: String(record.last_command_id ?? "").trim(),
        auth_subject: String(record.auth_subject ?? "").trim(),
    };
    const reasonMetadata = cloneStringMap(record.reason_metadata);
    if (reasonMetadata)
        out.reason_metadata = reasonMetadata;
    const statusMetadata = cloneStringMap(record.status_metadata);
    if (statusMetadata)
        out.status_metadata = statusMetadata;
    const tokenMetadata = cloneMicroVMSessionTokenMetadataList(record.token_metadata);
    if (tokenMetadata)
        out.token_metadata = tokenMetadata;
    const metadata = cloneStringMap(record.metadata);
    if (metadata)
        out.metadata = metadata;
    return out;
}
export function cloneMicroVMSessionRegistryRecord(record) {
    return normalizeMicroVMSessionRegistryRecord(record);
}
export function normalizeMicroVMSessionTokenMetadata(token) {
    return {
        token_id: String(token.token_id ?? "").trim(),
        token_type: String(token.token_type ?? "").trim(),
        expires_at: cloneMicroVMDate(token.expires_at),
        scope: normalizeStringArray(token.scope ?? []),
    };
}
export function cloneMicroVMSessionTokenMetadataList(tokens) {
    const out = (tokens ?? [])
        .map((token) => normalizeMicroVMSessionTokenMetadata(token))
        .filter((token) => token.token_id ||
        token.token_type ||
        validDate(token.expires_at) ||
        token.scope.length > 0);
    return out.length > 0 ? out : undefined;
}
export function microVMSessionFromRegistryRecordNoValidate(record) {
    const out = {
        tenant_id: record.tenant_id,
        namespace: record.namespace,
        session_id: record.session_id,
        state: record.state,
        desired_state: record.desired_state,
        endpoint: record.endpoint,
        microvm_id: record.microvm_id,
        provider_id: record.provider_id,
        provider_microvm_id: record.provider_microvm_id,
        provider_state: record.provider_state,
        aws_lifecycle_state: record.aws_lifecycle_state,
        image_ref: record.image_ref,
        image_version: record.image_version,
        network_connector_ref: record.network_connector_ref,
        ingress_network_connector_refs: [...record.ingress_network_connector_refs],
        egress_network_connector_refs: [...record.egress_network_connector_refs],
        controller_id: record.controller_id,
        created_at: cloneMicroVMDate(record.created_at),
        updated_at: cloneMicroVMDate(record.updated_at),
        last_observed_at: cloneMicroVMDate(record.last_observed_at),
        provider_started_at: cloneMicroVMDate(record.provider_started_at),
        provider_terminated_at: cloneMicroVMDate(record.provider_terminated_at),
        expires_at: cloneMicroVMDate(record.expires_at),
        generation: record.generation,
        last_action: record.last_action,
        last_command_id: record.last_command_id,
        auth_subject: record.auth_subject,
    };
    const reasonMetadata = cloneStringMap(record.reason_metadata);
    if (reasonMetadata)
        out.reason_metadata = reasonMetadata;
    const statusMetadata = cloneStringMap(record.status_metadata);
    if (statusMetadata)
        out.status_metadata = statusMetadata;
    const tokenMetadata = cloneMicroVMSessionTokenMetadataList(record.token_metadata);
    if (tokenMetadata)
        out.token_metadata = tokenMetadata;
    const metadata = cloneStringMap(record.metadata);
    if (metadata)
        out.metadata = metadata;
    return out;
}
export function normalizeMicroVMSessionKey(key) {
    return {
        tenant_id: String(key.tenant_id ?? "").trim(),
        namespace: String(key.namespace ?? "").trim(),
        session_id: String(key.session_id ?? "").trim(),
    };
}
export function normalizeMicroVMSessionReconstructionRequest(request) {
    const out = {
        request_id: String(request.request_id ?? "").trim(),
        tenant_id: String(request.tenant_id ?? "").trim(),
        namespace: String(request.namespace ?? "").trim(),
        session_id: String(request.session_id ?? "").trim(),
        auth_subject: String(request.auth_subject ?? "").trim(),
    };
    const now = cloneMicroVMDate(request.now ?? new Date(Number.NaN));
    if (validDate(now))
        out.now = now;
    if (request.existing)
        out.existing = normalizeMicroVMSessionRecord(request.existing);
    return out;
}
export function validateMicroVMSessionKey(key) {
    if (!key.tenant_id || !key.namespace || !key.session_id) {
        throw safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session key is incomplete", "");
    }
}
export function microVMSessionRegistryRecordKey(record) {
    return `${record.pk}\u0000${record.sk}`;
}
export function microVMSessionRegistryRecordKeyFromKey(key) {
    return `${microVMSessionRegistryPartitionKey(key.tenant_id, key.namespace)}\u0000${microVMSessionRegistrySortKey(key.session_id)}`;
}
export function microVMSessionRecordIsStale(record, now, staleAfterMs) {
    if (staleAfterMs <= 0 || !validDate(now))
        return false;
    const normalized = normalizeMicroVMSessionRecord(record);
    if (!validDate(normalized.last_observed_at))
        return true;
    return (normalized.last_observed_at.valueOf() + staleAfterMs < now.valueOf() ||
        normalized.expires_at.valueOf() <= now.valueOf());
}
export function registryRecordToTableItem(record) {
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
        provider_id: normalized.provider_id,
        provider_microvm_id: normalized.provider_microvm_id,
        provider_state: normalized.provider_state,
        aws_lifecycle_state: normalized.aws_lifecycle_state,
        image_ref: normalized.image_ref,
        image_version: normalized.image_version,
        network_connector_ref: normalized.network_connector_ref,
        ingress_network_connector_refs: [
            ...normalized.ingress_network_connector_refs,
        ],
        egress_network_connector_refs: [
            ...normalized.egress_network_connector_refs,
        ],
        controller_id: normalized.controller_id,
        created_at: normalized.created_at.toISOString(),
        updated_at: normalized.updated_at.toISOString(),
        last_observed_at: normalized.last_observed_at.toISOString(),
        provider_started_at: validDate(normalized.provider_started_at)
            ? normalized.provider_started_at.toISOString()
            : "",
        provider_terminated_at: validDate(normalized.provider_terminated_at)
            ? normalized.provider_terminated_at.toISOString()
            : "",
        expires_at: normalized.expires_at.toISOString(),
        ttl: normalized.ttl,
        generation: normalized.generation,
        version: normalized.version,
        last_action: normalized.last_action,
        last_command_id: normalized.last_command_id,
        auth_subject: normalized.auth_subject,
    };
    const reasonMetadata = cloneStringMap(normalized.reason_metadata);
    if (reasonMetadata)
        out["reason_metadata"] = reasonMetadata;
    const statusMetadata = cloneStringMap(normalized.status_metadata);
    if (statusMetadata)
        out["status_metadata"] = statusMetadata;
    const tokenMetadata = cloneMicroVMSessionTokenMetadataList(normalized.token_metadata);
    if (tokenMetadata)
        out["token_metadata"] = tokenMetadata;
    const metadata = cloneStringMap(normalized.metadata);
    if (metadata)
        out["metadata"] = metadata;
    return out;
}
export function registryRecordFromTableItem(item) {
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
        provider_id: stringRecordField(item, "provider_id"),
        provider_microvm_id: stringRecordField(item, "provider_microvm_id"),
        provider_state: stringRecordField(item, "provider_state"),
        aws_lifecycle_state: stringRecordField(item, "aws_lifecycle_state"),
        image_ref: stringRecordField(item, "image_ref"),
        image_version: stringRecordField(item, "image_version"),
        network_connector_ref: stringRecordField(item, "network_connector_ref"),
        ingress_network_connector_refs: recordStringListField(item, "ingress_network_connector_refs"),
        egress_network_connector_refs: recordStringListField(item, "egress_network_connector_refs"),
        controller_id: stringRecordField(item, "controller_id"),
        created_at: dateRecordField(item, "created_at"),
        updated_at: dateRecordField(item, "updated_at"),
        last_observed_at: dateRecordField(item, "last_observed_at"),
        provider_started_at: dateRecordField(item, "provider_started_at"),
        provider_terminated_at: dateRecordField(item, "provider_terminated_at"),
        expires_at: dateRecordField(item, "expires_at"),
        ttl: numberRecordField(item, "ttl"),
        generation: numberRecordField(item, "generation"),
        version: numberRecordField(item, "version"),
        last_action: stringRecordField(item, "last_action"),
        last_command_id: stringRecordField(item, "last_command_id"),
        auth_subject: stringRecordField(item, "auth_subject"),
    };
    const reasonMetadata = recordMapField(item, "reason_metadata");
    if (reasonMetadata)
        record.reason_metadata = reasonMetadata;
    const statusMetadata = recordMapField(item, "status_metadata");
    if (statusMetadata)
        record.status_metadata = statusMetadata;
    const tokenMetadata = recordTokenMetadataField(item, "token_metadata");
    if (tokenMetadata)
        record.token_metadata = tokenMetadata;
    const metadata = recordMapField(item, "metadata");
    if (metadata)
        record.metadata = metadata;
    return record;
}
export function asMicroVMSessionRegistryError(err, requestID) {
    if (err instanceof MicroVMSafeError) {
        return err.request_id ? err : safeError(err.code, err.message, requestID);
    }
    return safeError(MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE, "apptheory: microvm session registry operation failed", requestID);
}
export function stringRecordField(item, key) {
    return String(item[key] ?? "").trim();
}
export function numberRecordField(item, key) {
    const raw = Number(item[key] ?? 0);
    return Number.isFinite(raw) ? Math.trunc(raw) : 0;
}
export function dateRecordField(item, key) {
    return cloneMicroVMDateFromUnknown(item[key]);
}
export function recordMapField(item, key) {
    const raw = item[key];
    return raw && typeof raw === "object" && !Array.isArray(raw)
        ? cloneStringMap(raw)
        : undefined;
}
export function recordStringListField(item, key) {
    const raw = item[key];
    return Array.isArray(raw) ? normalizeStringArray(raw.map(String)) : [];
}
export function recordTokenMetadataField(item, key) {
    const raw = item[key];
    if (!Array.isArray(raw))
        return undefined;
    return cloneMicroVMSessionTokenMetadataList(raw.map((item) => {
        const value = item && typeof item === "object"
            ? item
            : {};
        return {
            token_id: stringRecordField(value, "token_id"),
            token_type: stringRecordField(value, "token_type"),
            expires_at: dateRecordField(value, "expires_at"),
            scope: recordStringListField(value, "scope"),
        };
    }));
}
export function microVMSessionRecordKey(record) {
    return microVMSessionKeyString(record.tenant_id, record.namespace, record.session_id);
}
export function microVMSessionKeyString(tenantID, namespace, sessionID) {
    return `${String(tenantID ?? "").trim()}\u0000${String(namespace ?? "").trim()}\u0000${String(sessionID ?? "").trim()}`;
}
//# sourceMappingURL=session.js.map