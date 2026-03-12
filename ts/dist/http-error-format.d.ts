export declare const HTTP_ERROR_FORMAT_NESTED = "nested";
export declare const HTTP_ERROR_FORMAT_FLAT_LEGACY = "flat_legacy";
export type HTTPErrorFormat = typeof HTTP_ERROR_FORMAT_NESTED | typeof HTTP_ERROR_FORMAT_FLAT_LEGACY;
export declare function normalizeHTTPErrorFormat(format: unknown): HTTPErrorFormat;
