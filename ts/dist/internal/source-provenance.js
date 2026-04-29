import { isIP } from "node:net";
const PROVIDER_APIGW_V2 = "apigw-v2";
const PROVIDER_LAMBDA_URL = "lambda-url";
const PROVIDER_APIGW_V1 = "apigw-v1";
const PROVIDER_UNKNOWN = "unknown";
const SOURCE_PROVIDER_REQUEST_CONTEXT = "provider_request_context";
const SOURCE_UNKNOWN = "unknown";
export function unknownSourceProvenance() {
    return {
        sourceIP: "",
        provider: PROVIDER_UNKNOWN,
        source: SOURCE_UNKNOWN,
        valid: false,
    };
}
export function sourceProvenanceFromProviderRequestContext(provider, sourceIP) {
    const providerValue = String(provider ?? "").trim();
    if (!isKnownProvider(providerValue)) {
        return unknownSourceProvenance();
    }
    const sourceIPValue = String(sourceIP ?? "").trim();
    if (isIP(sourceIPValue) === 0) {
        return unknownSourceProvenance();
    }
    return {
        sourceIP: sourceIPValue,
        provider: providerValue,
        source: SOURCE_PROVIDER_REQUEST_CONTEXT,
        valid: true,
    };
}
export function normalizeSourceProvenance(input) {
    if (!input || typeof input !== "object") {
        return unknownSourceProvenance();
    }
    const record = input;
    if (record["valid"] !== true) {
        return unknownSourceProvenance();
    }
    const provider = String(record["provider"] ?? "").trim();
    if (!isKnownProvider(provider)) {
        return unknownSourceProvenance();
    }
    const source = String(record["source"] ?? "").trim();
    if (source !== SOURCE_PROVIDER_REQUEST_CONTEXT) {
        return unknownSourceProvenance();
    }
    const sourceIP = String(record["sourceIP"] ?? "").trim();
    if (isIP(sourceIP) === 0) {
        return unknownSourceProvenance();
    }
    return {
        sourceIP,
        provider,
        source,
        valid: true,
    };
}
function isKnownProvider(provider) {
    return (provider === PROVIDER_APIGW_V2 ||
        provider === PROVIDER_LAMBDA_URL ||
        provider === PROVIDER_APIGW_V1);
}
