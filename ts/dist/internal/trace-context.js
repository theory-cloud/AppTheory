const TRACEPARENT_HEADER = "traceparent";
const X_AMZN_TRACE_ID_HEADER = "x-amzn-trace-id";
export function extractTraceIdFromHeaders(headers) {
    const traceparent = traceIdFromTraceparent(firstNonEmptyHeaderValue(headers, TRACEPARENT_HEADER));
    if (traceparent)
        return traceparent;
    return traceIdFromXAmznTraceId(firstNonEmptyHeaderValue(headers, X_AMZN_TRACE_ID_HEADER));
}
function firstNonEmptyHeaderValue(headers, key) {
    const values = headers?.[String(key).trim().toLowerCase()] ?? [];
    for (const value of values) {
        const trimmed = String(value ?? "").trim();
        if (trimmed)
            return trimmed;
    }
    return "";
}
function traceIdFromTraceparent(value) {
    const parts = String(value ?? "")
        .trim()
        .split("-");
    if (parts.length < 4)
        return "";
    const traceId = String(parts[1] ?? "")
        .trim()
        .toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(traceId) || /^0+$/.test(traceId))
        return "";
    return traceId;
}
function traceIdFromXAmznTraceId(value) {
    const header = String(value ?? "").trim();
    if (!header)
        return "";
    for (const part of header.split(";")) {
        const idx = part.indexOf("=");
        if (idx < 0)
            continue;
        const key = part.slice(0, idx).trim().toLowerCase();
        if (key !== "root")
            continue;
        const root = part.slice(idx + 1).trim();
        return validXRayRoot(root) ? root : "";
    }
    return "";
}
function validXRayRoot(root) {
    const parts = String(root ?? "").split("-");
    if (parts.length !== 3)
        return false;
    const version = parts[0] ?? "";
    const epoch = parts[1] ?? "";
    const unique = parts[2] ?? "";
    if (version !== "1" || epoch.length !== 8 || unique.length !== 24) {
        return false;
    }
    if (!/^[0-9a-fA-F]{8}$/.test(epoch))
        return false;
    if (!/^[0-9a-fA-F]{24}$/.test(unique))
        return false;
    return !/^0+$/.test(unique);
}
//# sourceMappingURL=trace-context.js.map