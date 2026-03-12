export const HTTP_ERROR_FORMAT_NESTED = "nested";
export const HTTP_ERROR_FORMAT_FLAT_LEGACY = "flat_legacy";
export function normalizeHTTPErrorFormat(format) {
    return format === HTTP_ERROR_FORMAT_FLAT_LEGACY
        ? HTTP_ERROR_FORMAT_FLAT_LEGACY
        : HTTP_ERROR_FORMAT_NESTED;
}
