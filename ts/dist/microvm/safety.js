import { MICROVM_ERROR_FORBIDDEN_FIELD, } from "./model.js";
import { safeError } from "./errors.js";
export const FORBIDDEN_MICROVM_FIELD_NAMES = new Set([
    "authorization",
    "account_wide_list_token",
    "aws_access_key_id",
    "aws_secret_access_key",
    "aws_session_token",
    "bearer_token",
    "plaintext_token",
    "provider_error",
    "provider_exception",
    "provider_secret",
    "raw_provider_error",
    "raw_provider_exception",
    "raw_aws_credentials",
    "raw_lifecycle_hook_payload",
    "raw_sdk_client",
    "session_token_plaintext",
    "token_value",
    "x-amz-security-token",
    "x-aws-proxy-auth",
    "x_aws_proxy_auth",
]);
export function forbiddenMicroVMFieldName(name) {
    const key = String(name ?? "")
        .trim()
        .toLowerCase();
    if (!key)
        return false;
    return (FORBIDDEN_MICROVM_FIELD_NAMES.has(key) ||
        FORBIDDEN_MICROVM_FIELD_NAMES.has(key.replaceAll("-", "_")));
}
export function validateSafeMicroVMMetadata(metadata, requestID) {
    for (const [key, value] of Object.entries(metadata ?? {})) {
        if (forbiddenMicroVMFieldName(key)) {
            return safeError(MICROVM_ERROR_FORBIDDEN_FIELD, "apptheory: microvm metadata contains forbidden field", requestID);
        }
        if (forbiddenMicroVMFieldValue(value)) {
            return safeError(MICROVM_ERROR_FORBIDDEN_FIELD, "apptheory: microvm metadata contains forbidden value", requestID);
        }
    }
    return null;
}
export function validateSafeMicroVMFieldValue(value, requestID) {
    if (forbiddenMicroVMFieldName(value) || forbiddenMicroVMFieldValue(value)) {
        return safeError(MICROVM_ERROR_FORBIDDEN_FIELD, "apptheory: microvm field contains forbidden value", requestID);
    }
    return null;
}
export function forbiddenMicroVMFieldValue(value) {
    const normalized = String(value ?? "")
        .trim()
        .toLowerCase();
    if (!normalized)
        return false;
    return (normalized.startsWith("bearer ") ||
        normalized.includes("x-aws-proxy-auth") ||
        normalized.includes("aws_secret_access_key") ||
        normalized.includes("aws_access_key_id") ||
        normalized.includes("aws_session_token") ||
        normalized.includes("raw provider exception") ||
        normalized.includes("raw_provider_exception") ||
        normalized.includes("raw provider error") ||
        normalized.includes("account-wide list token") ||
        normalized.includes("account_wide_list_token"));
}
export function cloneStringMap(input) {
    const out = {};
    for (const [key, value] of Object.entries(input ?? {})) {
        const trimmed = key.trim();
        if (!trimmed)
            continue;
        out[trimmed] = String(value);
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
export function missingStrings(required, got) {
    const seen = new Set(got.map((value) => value.trim()).filter(Boolean));
    return required.filter((value) => !seen.has(value)).sort();
}
//# sourceMappingURL=safety.js.map