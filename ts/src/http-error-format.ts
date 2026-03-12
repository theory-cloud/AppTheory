export const HTTP_ERROR_FORMAT_NESTED = "nested";
export const HTTP_ERROR_FORMAT_FLAT_LEGACY = "flat_legacy";

export type HTTPErrorFormat =
  | typeof HTTP_ERROR_FORMAT_NESTED
  | typeof HTTP_ERROR_FORMAT_FLAT_LEGACY;

export function normalizeHTTPErrorFormat(format: unknown): HTTPErrorFormat {
  return format === HTTP_ERROR_FORMAT_FLAT_LEGACY
    ? HTTP_ERROR_FORMAT_FLAT_LEGACY
    : HTTP_ERROR_FORMAT_NESTED;
}
