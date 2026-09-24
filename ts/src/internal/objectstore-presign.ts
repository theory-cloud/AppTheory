import {
  MAX_PRESIGN_PUT_EXPIRES_IN,
  OBJECTSTORE_ERROR_INVALID_STORE_CONFIG,
  ObjectStoreError,
} from "../objectstore.js";

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
export function verifyPresignPutUrl(
  rawUrl: string,
  requestedExpiresIn: number,
): void {
  let query: URLSearchParams;
  try {
    query = new URL(rawUrl).searchParams;
  } catch {
    throw invalidStoreConfig();
  }
  if ([...query.keys()].length === 0) {
    throw invalidStoreConfig();
  }

  const signedRaw = presignQueryValue(query, PRESIGN_PUT_SIGNED_HEADERS_PARAM);
  if (signedRaw === null) {
    throw invalidStoreConfig();
  }
  const signed = new Set(
    signedRaw
      .toLowerCase()
      .split(";")
      .map((name) => name.trim()),
  );
  for (const required of PRESIGN_PUT_REQUIRED_HEADERS) {
    if (!signed.has(required)) throw invalidStoreConfig();
    if (presignQueryValue(query, required) !== null) {
      throw invalidStoreConfig();
    }
  }

  const expiresRaw = presignQueryValue(query, PRESIGN_PUT_EXPIRES_PARAM);
  if (expiresRaw === null) throw invalidStoreConfig();
  const expiresSeconds = presignPutSeconds(expiresRaw);
  if (
    expiresSeconds === null ||
    expiresSeconds <= 0 ||
    expiresSeconds > MAX_PRESIGN_PUT_EXPIRES_IN
  ) {
    throw invalidStoreConfig();
  }
  if (requestedExpiresIn > 0 && expiresSeconds > requestedExpiresIn) {
    throw invalidStoreConfig();
  }
}

function presignQueryValue(
  query: URLSearchParams,
  name: string,
): string | null {
  const target = name.toLowerCase();
  for (const key of query.keys()) {
    if (key.toLowerCase() !== target) continue;
    return query.get(key);
  }
  return null;
}

function presignPutSeconds(value: string): number | null {
  if (!/^[+-]?\d+$/u.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function invalidStoreConfig(): ObjectStoreError {
  return new ObjectStoreError(
    OBJECTSTORE_ERROR_INVALID_STORE_CONFIG,
    "objectstore: invalid store config",
  );
}
