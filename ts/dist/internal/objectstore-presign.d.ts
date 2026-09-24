/**
 * Enforces the bounded upload grant's post-condition on a presigned URL.
 *
 * A URL may only be handed back when the constraint headers really are signed
 * headers, are not hoisted into unsigned query parameters, and when the
 * embedded expiry cannot outlive the requested one. Anything else is a
 * misconfigured signer and fails closed.
 */
export declare function verifyPresignPutUrl(rawUrl: string, requestedExpiresIn: number): void;
//# sourceMappingURL=objectstore-presign.d.ts.map