import { createHash } from "node:crypto";

import {
  MICROVM_ERROR_FORBIDDEN_FIELD,
  MICROVM_ERROR_PROVIDER_OPERATION_FAILED,
  MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED,
  MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
  MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
  MICROVM_ERROR_TENANT_BINDING_VIOLATION,
  MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
  MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
  MICROVM_ENV_EXECUTION_ROLE_ARN,
  MicroVMOperation,
  MicroVMSafeError,
  type MicroVMAuthContext,
  type MicroVMProviderListInput,
  type MicroVMOperationName,
  type MicroVMProviderPortScope,
  type MicroVMProviderRunInput,
  type MicroVMProviderSession,
  type MicroVMProviderSessionBinding,
  type MicroVMProviderSessionInput,
  type MicroVMProviderToken,
  type MicroVMProviderTokenInput,
} from "./model.js";
import { safeError } from "./errors.js";
import {
  isRequiredMicroVMOperation,
  mapMicroVMProviderState,
  normalizeMicroVMOperation,
  normalizeMicroVMProviderState,
  normalizeMicroVMRealLifecycleState,
} from "./operation-contract.js";
import {
  forbiddenMicroVMFieldName,
  validateSafeMicroVMFieldValue,
  validateSafeMicroVMMetadata,
} from "./safety.js";
import { cloneMicroVMDate, validDate } from "./time.js";
import {
  cloneMicroVMSessionSpec,
  normalizeMicroVMAuthContext,
} from "./controller.js";

export function validateMicroVMProviderSession(
  session: MicroVMProviderSession,
): void {
  const normalized = normalizeMicroVMProviderSession(session);
  if (
    !normalized.tenant_id ||
    !normalized.namespace ||
    !normalized.session_id ||
    !normalized.provider_microvm_id
  ) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider session is incomplete",
      "",
    );
  }
  const mapped = mapMicroVMProviderState(normalized.provider_state);
  if (
    normalized.state !== mapped.state ||
    normalized.terminal !== mapped.terminal
  ) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
      "apptheory: microvm provider session state mapping mismatch",
      "",
    );
  }
  if (
    forbiddenMicroVMFieldName(normalized.provider_microvm_id) ||
    forbiddenMicroVMFieldName(normalized.image_ref ?? "") ||
    forbiddenMicroVMFieldName(normalized.image_version ?? "")
  ) {
    throw safeError(
      MICROVM_ERROR_FORBIDDEN_FIELD,
      "apptheory: microvm provider session exposes forbidden field",
      "",
    );
  }
}

export function validateMicroVMProviderRunInput(
  input: MicroVMProviderRunInput,
): void {
  validateMicroVMProviderRunInputInternal(input);
}

export function validateMicroVMProviderSessionInput(
  operation: MicroVMOperationName | string,
  input: MicroVMProviderSessionInput,
): void {
  validateMicroVMProviderSessionInputInternal(operation, input);
}

export function validateMicroVMProviderListInput(
  input: MicroVMProviderListInput,
): void {
  validateMicroVMProviderListInputInternal(input);
}

export function validateMicroVMProviderTokenInput(
  operation: MicroVMOperationName | string,
  input: MicroVMProviderTokenInput,
): void {
  validateMicroVMProviderTokenInputInternal(operation, input);
}

export function validateMicroVMProviderToken(
  token: MicroVMProviderToken,
): void {
  const normalized = normalizeMicroVMProviderToken(token);
  if (
    !normalized.tenant_id ||
    !normalized.namespace ||
    !normalized.session_id ||
    !normalized.provider_microvm_id ||
    !normalized.token_id ||
    !normalized.token_type ||
    !validDate(normalized.expires_at) ||
    normalized.scope.length === 0
  ) {
    throw safeError(
      MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
      "apptheory: microvm provider token metadata is incomplete",
      "",
    );
  }
  for (const field of [
    normalized.provider_microvm_id,
    normalized.token_id,
    normalized.token_type,
    ...normalized.scope,
  ]) {
    if (forbiddenMicroVMFieldName(field)) {
      throw safeError(
        MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
        "apptheory: microvm provider token metadata exposes forbidden field",
        "",
      );
    }
  }
}

export const defaultProviderTokenTTLSeconds = 900;

export const minProviderTokenTTLSeconds = 1;

export const maxProviderTokenTTLSeconds = 900;

export function validateMicroVMProviderRunInputInternal(
  input: MicroVMProviderRunInput,
): MicroVMProviderRunInput {
  const normalized = normalizeMicroVMProviderRunInput(input);
  validateMicroVMProviderOperation(MicroVMOperation.Run, normalized.request_id);
  validateMicroVMProviderAccess(
    normalized.request_id,
    normalized.tenant_id,
    normalized.namespace,
    normalized.auth_context,
  );
  if (!normalized.request_id) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider request_id is required",
      "",
    );
  }
  if (!normalized.session_id || !normalized.image_ref) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider run requires session_id and image_ref",
      normalized.request_id,
    );
  }
  if (
    forbiddenMicroVMFieldName(normalized.image_ref) ||
    forbiddenMicroVMFieldName(normalized.image_version ?? "")
  ) {
    throw safeError(
      MICROVM_ERROR_FORBIDDEN_FIELD,
      "apptheory: microvm provider run exposes forbidden field",
      normalized.request_id,
    );
  }
  const metadataError = validateSafeMicroVMMetadata(
    normalized.session_spec?.metadata,
    normalized.request_id,
  );
  if (metadataError) throw metadataError;
  validateSafeMicroVMConnectorRefs(normalized.request_id, [
    normalized.network_connector_ref ?? "",
    ...(normalized.ingress_network_connector_refs ?? []),
    ...(normalized.egress_network_connector_refs ?? []),
  ]);
  const executionRoleErr = validateMicroVMExecutionRoleArn(
    normalized.execution_role_arn ?? "",
    normalized.request_id,
  );
  if (executionRoleErr) throw executionRoleErr;
  const policy = normalized.idle_policy;
  if (
    policy &&
    (policy.max_idle_duration_seconds <= 0 ||
      policy.suspended_duration_seconds <= 0)
  ) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider idle policy is incomplete",
      normalized.request_id,
    );
  }
  if ((normalized.maximum_duration_seconds ?? 0) < 0) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider maximum duration is invalid",
      normalized.request_id,
    );
  }
  return normalized;
}

export function validateMicroVMProviderSessionInputInternal(
  operation: MicroVMOperationName | string,
  input: MicroVMProviderSessionInput,
): MicroVMProviderSessionInput {
  const normalized = normalizeMicroVMProviderSessionInput(input);
  const normalizedOperation = normalizeMicroVMOperation(operation);
  validateMicroVMProviderOperation(normalizedOperation, normalized.request_id);
  if (!normalized.request_id) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider request_id is required",
      "",
    );
  }
  validateMicroVMProviderAccess(
    normalized.request_id,
    normalized.tenant_id,
    normalized.namespace,
    normalized.auth_context,
  );
  normalized.binding = validateMicroVMProviderBinding(
    normalized.request_id,
    normalized.tenant_id,
    normalized.namespace,
    normalized.binding,
  );
  return normalized;
}

export function validateMicroVMProviderListInputInternal(
  input: MicroVMProviderListInput,
): MicroVMProviderListInput {
  const normalized = normalizeMicroVMProviderListInput(input);
  validateMicroVMProviderOperation(
    MicroVMOperation.List,
    normalized.request_id,
  );
  if (!normalized.request_id) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider request_id is required",
      "",
    );
  }
  validateMicroVMProviderAccess(
    normalized.request_id,
    normalized.tenant_id,
    normalized.namespace,
    normalized.auth_context,
  );
  if (
    forbiddenMicroVMFieldName(normalized.image_ref ?? "") ||
    forbiddenMicroVMFieldName(normalized.image_version ?? "")
  ) {
    throw safeError(
      MICROVM_ERROR_FORBIDDEN_FIELD,
      "apptheory: microvm provider list exposes forbidden field",
      normalized.request_id,
    );
  }
  normalized.known_sessions = (normalized.known_sessions ?? []).map((binding) =>
    validateMicroVMProviderBinding(
      normalized.request_id,
      normalized.tenant_id,
      normalized.namespace,
      binding,
    ),
  );
  if ((normalized.max_results ?? 0) < 0) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider list max_results is invalid",
      normalized.request_id,
    );
  }
  return normalized;
}

export function validateMicroVMProviderTokenInputInternal(
  operation: MicroVMOperationName | string,
  input: MicroVMProviderTokenInput,
): MicroVMProviderTokenInput {
  const normalized = normalizeMicroVMProviderTokenInput(input);
  const normalizedOperation = normalizeMicroVMOperation(operation);
  validateMicroVMProviderOperation(normalizedOperation, normalized.request_id);
  if (!normalized.request_id) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider request_id is required",
      "",
    );
  }
  if (
    normalizedOperation !== MicroVMOperation.AuthToken &&
    normalizedOperation !== MicroVMOperation.ShellToken
  ) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED,
      "apptheory: microvm provider token operation is unsupported",
      normalized.request_id,
    );
  }
  validateMicroVMProviderAccess(
    normalized.request_id,
    normalized.tenant_id,
    normalized.namespace,
    normalized.auth_context,
  );
  normalized.binding = validateMicroVMProviderBinding(
    normalized.request_id,
    normalized.tenant_id,
    normalized.namespace,
    normalized.binding,
  );
  const ttl = normalized.ttl_seconds ?? 0;
  normalized.ttl_seconds = ttl === 0 ? defaultProviderTokenTTLSeconds : ttl;
  if (
    normalized.ttl_seconds < minProviderTokenTTLSeconds ||
    normalized.ttl_seconds > maxProviderTokenTTLSeconds
  ) {
    throw safeError(
      MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
      "apptheory: microvm provider token ttl exceeds contract bounds",
      normalized.request_id,
    );
  }
  if (
    normalizedOperation === MicroVMOperation.AuthToken &&
    (normalized.allowed_port_scope ?? []).length === 0
  ) {
    throw safeError(
      MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
      "apptheory: microvm auth token requires an explicit allowed port scope",
      normalized.request_id,
    );
  }
  for (const scope of normalized.allowed_port_scope ?? []) {
    validateMicroVMProviderPortScope(scope, normalized.request_id);
  }
  return normalized;
}

export function validateMicroVMProviderOperation(
  operation: MicroVMOperationName | string,
  requestID: string,
): void {
  if (!isRequiredMicroVMOperation(operation)) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED,
      "apptheory: microvm provider operation is unsupported",
      requestID,
    );
  }
}

export function validateMicroVMProviderAccess(
  requestID: string,
  tenantID: string,
  namespace: string,
  auth: MicroVMAuthContext,
): void {
  const normalizedAuth = normalizeMicroVMAuthContext(auth);
  if (!String(tenantID ?? "").trim() || !String(namespace ?? "").trim()) {
    throw safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm provider request requires tenant and namespace",
      requestID,
    );
  }
  if (!normalizedAuth.subject || !normalizedAuth.tenant_id) {
    throw safeError(
      MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
      "apptheory: microvm provider request requires authenticated context",
      requestID,
    );
  }
  if (normalizedAuth.tenant_id !== String(tenantID ?? "").trim()) {
    throw safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm provider auth context is cross-tenant",
      requestID,
    );
  }
  if (
    normalizedAuth.namespace &&
    normalizedAuth.namespace !== String(namespace ?? "").trim()
  ) {
    throw safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm provider auth context is cross-namespace",
      requestID,
    );
  }
  const metadataError = validateSafeMicroVMMetadata(
    normalizedAuth.metadata,
    requestID,
  );
  if (metadataError) throw metadataError;
}

export function validateMicroVMProviderBinding(
  requestID: string,
  tenantID: string,
  namespace: string,
  binding: MicroVMProviderSessionBinding,
): MicroVMProviderSessionBinding {
  const normalized = normalizeMicroVMProviderBinding(binding);
  if (
    !normalized.tenant_id ||
    !normalized.namespace ||
    !normalized.session_id ||
    !normalized.provider_microvm_id
  ) {
    throw safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm provider binding is incomplete",
      requestID,
    );
  }
  if (
    normalized.tenant_id !== String(tenantID ?? "").trim() ||
    normalized.namespace !== String(namespace ?? "").trim()
  ) {
    throw safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm provider binding is cross-tenant",
      requestID,
    );
  }
  if (forbiddenMicroVMFieldName(normalized.provider_microvm_id)) {
    throw safeError(
      MICROVM_ERROR_FORBIDDEN_FIELD,
      "apptheory: microvm provider binding exposes forbidden field",
      requestID,
    );
  }
  return normalized;
}

export function validateMicroVMProviderPortScope(
  scope: MicroVMProviderPortScope,
  requestID: string,
): void {
  let options = 0;
  if (scope.all_ports === true) options += 1;
  if ((scope.port ?? 0) > 0) options += 1;
  if ((scope.start_port ?? 0) > 0 || (scope.end_port ?? 0) > 0) {
    options += 1;
    if (
      (scope.start_port ?? 0) <= 0 ||
      (scope.end_port ?? 0) <= 0 ||
      (scope.start_port ?? 0) > (scope.end_port ?? 0)
    ) {
      throw safeError(
        MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
        "apptheory: microvm provider token port range is invalid",
        requestID,
      );
    }
  }
  if (options !== 1) {
    throw safeError(
      MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
      "apptheory: microvm provider token port scope must specify exactly one scope",
      requestID,
    );
  }
}

export function validateSafeMicroVMConnectorRefs(
  requestID: string,
  refs: string[],
): void {
  for (const ref of refs) {
    if (forbiddenMicroVMFieldName(ref)) {
      throw safeError(
        MICROVM_ERROR_FORBIDDEN_FIELD,
        "apptheory: microvm provider connector exposes forbidden field",
        requestID,
      );
    }
  }
}

export function validateMicroVMExecutionRoleArn(
  value: string,
  requestID: string,
): MicroVMSafeError | null {
  const arn = normalizeMicroVMExecutionRoleArn(value);
  if (!arn) return null;
  const safeErr = validateSafeMicroVMFieldValue(arn, requestID);
  if (safeErr) return safeErr;
  if (/\s/.test(arn) || !arn.startsWith("arn:") || !arn.includes(":role/")) {
    return safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider execution role arn is invalid",
      requestID,
    );
  }
  return null;
}

export function normalizeMicroVMExecutionRoleArn(value: string): string {
  return String(value ?? "").trim();
}

export function environmentMicroVMExecutionRoleArn(): string {
  if (typeof process === "undefined") return "";
  return normalizeMicroVMExecutionRoleArn(
    process.env?.[MICROVM_ENV_EXECUTION_ROLE_ARN] ?? "",
  );
}

export function normalizeMicroVMProviderRunInput(
  input: MicroVMProviderRunInput,
): MicroVMProviderRunInput {
  const out: MicroVMProviderRunInput = {
    request_id: String(input.request_id ?? "").trim(),
    tenant_id: String(input.tenant_id ?? "").trim(),
    namespace: String(input.namespace ?? "").trim(),
    session_id: String(input.session_id ?? "").trim(),
    auth_context: normalizeMicroVMAuthContext(input.auth_context ?? {}),
    image_ref: String(input.image_ref ?? "").trim(),
    session_spec: cloneMicroVMSessionSpec(input.session_spec ?? {}),
  };
  const imageVersion = String(input.image_version ?? "").trim();
  if (imageVersion) out.image_version = imageVersion;
  const networkConnectorRef = String(input.network_connector_ref ?? "").trim();
  if (networkConnectorRef) out.network_connector_ref = networkConnectorRef;
  const ingress = normalizeStringArray(
    input.ingress_network_connector_refs ?? [],
  );
  if (ingress.length > 0) out.ingress_network_connector_refs = ingress;
  const egress = normalizeStringArray(
    input.egress_network_connector_refs ?? [],
  );
  if (egress.length > 0) out.egress_network_connector_refs = egress;
  if (input.idle_policy) {
    out.idle_policy = {
      auto_resume_enabled: input.idle_policy.auto_resume_enabled === true,
      max_idle_duration_seconds: Math.trunc(
        Number(input.idle_policy.max_idle_duration_seconds) || 0,
      ),
      suspended_duration_seconds: Math.trunc(
        Number(input.idle_policy.suspended_duration_seconds) || 0,
      ),
    };
  }
  if (input.maximum_duration_seconds !== undefined) {
    out.maximum_duration_seconds = Math.trunc(
      Number(input.maximum_duration_seconds) || 0,
    );
  }
  const executionRoleArn = normalizeMicroVMExecutionRoleArn(
    input.execution_role_arn ?? "",
  );
  if (executionRoleArn) out.execution_role_arn = executionRoleArn;
  return out;
}

export function normalizeMicroVMProviderSessionInput(
  input: MicroVMProviderSessionInput,
): MicroVMProviderSessionInput {
  return {
    request_id: String(input.request_id ?? "").trim(),
    tenant_id: String(input.tenant_id ?? "").trim(),
    namespace: String(input.namespace ?? "").trim(),
    auth_context: normalizeMicroVMAuthContext(input.auth_context ?? {}),
    binding: normalizeMicroVMProviderBinding(input.binding ?? {}),
  };
}

export function normalizeMicroVMProviderListInput(
  input: MicroVMProviderListInput,
): MicroVMProviderListInput {
  const out: MicroVMProviderListInput = {
    request_id: String(input.request_id ?? "").trim(),
    tenant_id: String(input.tenant_id ?? "").trim(),
    namespace: String(input.namespace ?? "").trim(),
    auth_context: normalizeMicroVMAuthContext(input.auth_context ?? {}),
  };
  const imageRef = String(input.image_ref ?? "").trim();
  if (imageRef) out.image_ref = imageRef;
  const imageVersion = String(input.image_version ?? "").trim();
  if (imageVersion) out.image_version = imageVersion;
  if (input.max_results !== undefined) {
    out.max_results = Math.trunc(Number(input.max_results) || 0);
  }
  const known = (input.known_sessions ?? []).map(
    normalizeMicroVMProviderBinding,
  );
  if (known.length > 0) out.known_sessions = known;
  return out;
}

export function normalizeMicroVMProviderTokenInput(
  input: MicroVMProviderTokenInput,
): MicroVMProviderTokenInput {
  const out: MicroVMProviderTokenInput = {
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
  if (scopes.length > 0) out.allowed_port_scope = scopes;
  return out;
}

export function normalizeMicroVMProviderBinding(
  binding: Partial<MicroVMProviderSessionBinding>,
): MicroVMProviderSessionBinding {
  const out: MicroVMProviderSessionBinding = {
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

export function normalizeMicroVMProviderSession(
  session: MicroVMProviderSession,
): MicroVMProviderSession {
  const out: MicroVMProviderSession = {
    tenant_id: String(session.tenant_id ?? "").trim(),
    namespace: String(session.namespace ?? "").trim(),
    session_id: String(session.session_id ?? "").trim(),
    provider_microvm_id: String(session.provider_microvm_id ?? "").trim(),
    state: normalizeMicroVMRealLifecycleState(session.state),
    provider_state: normalizeMicroVMProviderState(session.provider_state),
    terminal: session.terminal === true,
  };
  const imageRef = String(session.image_ref ?? "").trim();
  if (imageRef) out.image_ref = imageRef;
  const imageVersion = String(session.image_version ?? "").trim();
  if (imageVersion) out.image_version = imageVersion;
  if (validDate(session.started_at as Date)) {
    out.started_at = cloneMicroVMDate(session.started_at as Date);
  }
  if (validDate(session.terminated_at as Date)) {
    out.terminated_at = cloneMicroVMDate(session.terminated_at as Date);
  }
  if (session.registry_version !== undefined) {
    out.registry_version = Math.trunc(Number(session.registry_version) || 0);
  }
  return out;
}

export function normalizeMicroVMProviderToken(
  token: MicroVMProviderToken,
): MicroVMProviderToken {
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

export function cloneMicroVMProviderSession(
  session: MicroVMProviderSession,
): MicroVMProviderSession {
  return normalizeMicroVMProviderSession(session);
}

export function cloneMicroVMProviderToken(
  token: MicroVMProviderToken,
): MicroVMProviderToken {
  return normalizeMicroVMProviderToken(token);
}

export function normalizeStringArray(values: string[]): string[] {
  return values.map((value) => String(value ?? "").trim()).filter(Boolean);
}

export function microVMProviderSessionKeyString(
  tenantID: string,
  namespace: string,
  sessionID: string,
): string {
  return `${String(tenantID ?? "").trim()}\u0000${String(namespace ?? "").trim()}\u0000${String(sessionID ?? "").trim()}`;
}

export function providerEgressConnectorRefs(
  input: MicroVMProviderRunInput,
): string[] {
  return normalizeStringArray([
    ...(input.egress_network_connector_refs ?? []),
    input.network_connector_ref ?? "",
  ]);
}

export function safeMicroVMRunHookPayload(
  input: MicroVMProviderRunInput,
): string {
  return JSON.stringify({
    request_id: input.request_id,
    tenant_id: input.tenant_id,
    namespace: input.namespace,
    session_id: input.session_id,
  });
}

export function microVMProviderTokenMetadata(
  operation: MicroVMOperationName,
  input: MicroVMProviderTokenInput,
  now: Date,
): MicroVMProviderToken {
  const tokenType =
    operation === MicroVMOperation.ShellToken ? "shell" : "auth";
  const ttl = input.ttl_seconds ?? defaultProviderTokenTTLSeconds;
  const expiresAt = new Date(now.valueOf() + ttl * 1000);
  const scope = microVMProviderTokenScope(
    operation,
    input.allowed_port_scope ?? [],
  );
  const token: MicroVMProviderToken = {
    tenant_id: input.binding.tenant_id,
    namespace: input.binding.namespace,
    session_id: input.binding.session_id,
    provider_microvm_id: input.binding.provider_microvm_id,
    token_id: safeMicroVMProviderTokenID(
      input.binding,
      tokenType,
      expiresAt,
      scope,
    ),
    token_type: tokenType,
    expires_at: expiresAt,
    scope,
  };
  validateMicroVMProviderToken(token);
  return token;
}

export function microVMProviderTokenScope(
  operation: MicroVMOperationName,
  scopes: MicroVMProviderPortScope[],
): string[] {
  if (operation === MicroVMOperation.ShellToken) return ["shell"];
  return scopes
    .map((scope) => {
      if (scope.all_ports === true) return "ports:*";
      if ((scope.port ?? 0) > 0) return `ports:${Math.trunc(scope.port ?? 0)}`;
      return `ports:${Math.trunc(scope.start_port ?? 0)}-${Math.trunc(scope.end_port ?? 0)}`;
    })
    .sort();
}

export function safeMicroVMProviderTokenID(
  binding: MicroVMProviderSessionBinding,
  tokenType: string,
  expiresAt: Date,
  scope: string[],
): string {
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

export function formatMicroVMProviderDate(value: Date): string {
  const iso = value.toISOString();
  return iso.endsWith(".000Z") ? `${iso.slice(0, -5)}Z` : iso;
}

export function fakeMicroVMProviderError(requestID: string): MicroVMSafeError {
  return safeError(
    MICROVM_ERROR_PROVIDER_OPERATION_FAILED,
    "apptheory: microvm provider operation failed",
    requestID,
  );
}

export function asMicroVMProviderSafeError(
  err: unknown,
  requestID: string,
): MicroVMSafeError {
  if (err instanceof MicroVMSafeError) {
    return err.request_id ? err : safeError(err.code, err.message, requestID);
  }
  return fakeMicroVMProviderError(requestID);
}
