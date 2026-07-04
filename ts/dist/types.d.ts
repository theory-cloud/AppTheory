/** Canonical multi-value HTTP headers used by AppTheory. */
export type Headers = Record<string, string[]>;
/** Canonical multi-value query parameters used by AppTheory. */
export type Query = Record<string, string[]>;
/** Byte stream accepted by streaming AppTheory responses. */
export type BodyStream = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
/** Provider-derived source provenance for an HTTP request. */
export interface SourceProvenance {
    /** Canonical source IP, or an empty string when unavailable. */
    sourceIP: string;
    /** Provider that supplied the source value. */
    provider: string;
    /** Source channel used to derive the value. */
    source: string;
    /** Whether the source IP was present and valid. */
    valid: boolean;
}
/** Normalized request consumed by the AppTheory runtime. */
export interface Request {
    /** HTTP method. */
    method: string;
    /** Normalized request path. */
    path: string;
    /** Multi-value query parameters. */
    query?: Query;
    /** Multi-value request headers. */
    headers?: Headers;
    /** Request body bytes. */
    body?: Uint8Array;
    /** Whether the provider encoded the inbound body as base64. */
    isBase64?: boolean;
    /** Provider-derived source provenance. */
    sourceProvenance?: SourceProvenance;
    /** Extracted trace ID for correlation. */
    traceId?: string;
}
/** Normalized response returned by AppTheory handlers. */
export interface Response {
    /** HTTP status code. */
    status: number;
    /** Multi-value response headers. */
    headers: Headers;
    /** Set-Cookie header values. */
    cookies: string[];
    /** Response body bytes. */
    body: Uint8Array;
    /** Optional streaming response body. */
    bodyStream?: BodyStream | null;
    /** Whether the response body must be serialized as base64. */
    isBase64: boolean;
}
//# sourceMappingURL=types.d.ts.map