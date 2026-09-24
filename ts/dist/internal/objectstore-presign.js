import { MAX_PRESIGN_PUT_EXPIRES_IN, OBJECTSTORE_ERROR_INVALID_STORE_CONFIG, ObjectStoreError, } from "../objectstore.js";
const PRESIGN_PUT_SIGNED_HEADERS_PARAM = "X-Amz-SignedHeaders";
const PRESIGN_PUT_EXPIRES_PARAM = "X-Amz-Expires";
const PRESIGN_PUT_REQUIRED_HEADERS = [
    "content-length",
    "content-type",
    "x-amz-checksum-sha256",
];
/**
 * Enforces the bounded upload grant's post-condition on a presigned URL.
 *
 * A URL may only be handed back when the constraint headers really are signed
 * headers, are not hoisted into unsigned query parameters, and when the
 * embedded expiry cannot outlive the requested one. Anything else is a
 * misconfigured signer and fails closed.
 */
export function verifyPresignPutUrl(rawUrl, requestedExpiresIn) {
    let query;
    try {
        query = new URL(rawUrl).searchParams;
    }
    catch {
        throw invalidStoreConfig();
    }
    if ([...query.keys()].length === 0) {
        throw invalidStoreConfig();
    }
    const signedRaw = presignQueryValue(query, PRESIGN_PUT_SIGNED_HEADERS_PARAM);
    if (signedRaw === null) {
        throw invalidStoreConfig();
    }
    const signed = new Set(signedRaw
        .toLowerCase()
        .split(";")
        .map((name) => name.trim()));
    for (const required of PRESIGN_PUT_REQUIRED_HEADERS) {
        if (!signed.has(required))
            throw invalidStoreConfig();
        if (presignQueryValue(query, required) !== null) {
            throw invalidStoreConfig();
        }
    }
    const expiresRaw = presignQueryValue(query, PRESIGN_PUT_EXPIRES_PARAM);
    if (expiresRaw === null)
        throw invalidStoreConfig();
    const expiresSeconds = presignPutSeconds(expiresRaw);
    if (expiresSeconds === null ||
        expiresSeconds <= 0 ||
        expiresSeconds > MAX_PRESIGN_PUT_EXPIRES_IN) {
        throw invalidStoreConfig();
    }
    if (requestedExpiresIn > 0 && expiresSeconds > requestedExpiresIn) {
        throw invalidStoreConfig();
    }
}
function presignQueryValue(query, name) {
    const target = name.toLowerCase();
    for (const key of query.keys()) {
        if (key.toLowerCase() !== target)
            continue;
        return query.get(key);
    }
    return null;
}
// X-Amz-Expires is always a bare decimal integer. The pattern deliberately excludes a sign,
// whitespace, underscores and non-ASCII digits, which the Go and Python parsers used to tolerate, so
// every runtime's post-condition accepts exactly [0-9]+.
function presignPutSeconds(value) {
    if (!/^[0-9]+$/u.test(value))
        return null;
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : null;
}
function invalidStoreConfig() {
    return new ObjectStoreError(OBJECTSTORE_ERROR_INVALID_STORE_CONFIG, "objectstore: invalid store config");
}
//# sourceMappingURL=objectstore-presign.js.map