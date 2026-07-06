import type { Headers, Response } from "./types.js";
/** Creates a UTF-8 text response. */
export declare function text(status: number, body: string): Response;
/** Creates a JSON response. */
export declare function json(status: number, value: unknown): Response;
/** Creates a binary response with an optional content type. */
export declare function binary(status: number, body: Uint8Array, contentType?: string): Response;
/** Creates a UTF-8 HTML response. */
export declare function html(status: number, body: Uint8Array | string): Response;
type StreamableHTMLChunk = Uint8Array | string;
type StreamableHTMLChunks = AsyncIterable<StreamableHTMLChunk> | Iterable<StreamableHTMLChunk>;
/** Creates a streaming HTML response. */
export declare function htmlStream(status: number, chunks: StreamableHTMLChunks): Response;
/** Serializes JSON for embedding inside HTML script contexts. */
export declare function safeJSONForHTML(value: unknown): string;
/** Returns the canonical private no-store cache policy for SSR. */
export declare function cacheControlSSR(): string;
/** Returns the canonical long-lived shared cache policy for SSG. */
export declare function cacheControlSSG(): string;
/** Returns the canonical shared cache policy for ISR. */
export declare function cacheControlISR(revalidateSeconds: number, staleWhileRevalidateSeconds?: number): string;
/** Returns a strong SHA-256 ETag for response bytes. */
export declare function etag(body: Uint8Array | string): string;
/** Reports whether request validators match the supplied ETag. */
export declare function matchesIfNoneMatch(headers: Headers, tag: string): boolean;
/** Merges and canonicalizes Vary header tokens. */
export declare function vary(existing: string[] | null | undefined, ...add: string[]): string[];
/** Returns the original host from forwarding headers. */
export declare function originalHost(headers: Headers): string;
/** Returns the original URI from AppTheory or FaceTheory forwarding headers. */
export declare function originalURI(headers: Headers): string;
/** Returns the original scheme and host as a URL. */
export declare function originURL(headers: Headers): string;
/** Returns the client IP from CloudFront or forwarding headers. */
export declare function clientIP(headers: Headers): string;
export {};
//# sourceMappingURL=response.d.ts.map