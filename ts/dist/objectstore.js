import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, ServerSideEncryption, } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { verifyPresignPutUrl } from "./internal/objectstore-presign.js";
export const OBJECTSTORE_ERROR_INVALID_REF = "objectstore.invalid_ref";
export const OBJECTSTORE_ERROR_INVALID_GET_LIMIT = "objectstore.invalid_get_limit";
export const OBJECTSTORE_ERROR_OBJECT_TOO_LARGE = "objectstore.object_too_large";
export const OBJECTSTORE_ERROR_NOT_FOUND = "objectstore.not_found";
export const OBJECTSTORE_ERROR_INVALID_STORE_CONFIG = "objectstore.invalid_store_config";
export const OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG = "objectstore.invalid_encryption_config";
export const OBJECTSTORE_ERROR_UNSUPPORTED_OPERATION = "objectstore.unsupported_operation";
export const OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT = "objectstore.invalid_presign_put";
/** Framework ceiling for a bounded upload grant, in seconds. */
export const MAX_PRESIGN_PUT_EXPIRES_IN = 900;
export const S3Encryption = {
    BucketDefault: "bucket-default",
    S3Managed: "s3-managed",
    KMS: "kms",
};
export class ObjectStoreError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "ObjectStoreError";
        this.code = code;
    }
}
export function parseObjectRef(raw) {
    if (!raw || raw !== raw.trim() || /[?#]/u.test(raw)) {
        throw invalidObjectRef();
    }
    const scheme = "s3://";
    if (!raw.startsWith(scheme)) {
        throw invalidObjectRef();
    }
    const rest = raw.slice(scheme.length);
    const slash = rest.indexOf("/");
    if (slash < 0) {
        throw invalidObjectRef();
    }
    const ref = { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
    validateObjectRef(ref);
    return ref;
}
export function validateObjectRef(ref) {
    if (!ref.bucket || !ref.key) {
        throw invalidObjectRef();
    }
    if (ref.bucket.includes("/") || /[?#]/u.test(ref.bucket)) {
        throw invalidObjectRef();
    }
    if (/[?#]/u.test(ref.key) || /[?#]/u.test(ref.versionId ?? "")) {
        throw invalidObjectRef();
    }
    if (containsControlOrSpace(ref.bucket) ||
        containsControl(ref.key) ||
        containsControl(ref.versionId ?? "")) {
        throw invalidObjectRef();
    }
}
export function createFakeObjectStore() {
    return new FakeObjectStore();
}
/**
 * Verifies a grant request is complete and safe. Every failure is fail-closed.
 *
 * The byte counts and the expiry must be integers: `Number.isSafeInteger`
 * refuses a fractional content length, a boolean, a numeric string and
 * `undefined` alike, matching the integer-typed Go grant input and Python's
 * explicit type check. The expiry must further be a whole number of seconds,
 * because the grant carries it as the integer `X-Amz-Expires`; a fractional
 * expiry would be truncated or rejected by the signer.
 */
export function validatePresignPutInput(input) {
    validateObjectRef(input.ref);
    if (input.ref.versionId)
        throw invalidObjectRef();
    if (!Number.isSafeInteger(input.contentLength) ||
        !Number.isSafeInteger(input.maxBytes) ||
        input.contentLength <= 0 ||
        input.maxBytes <= 0 ||
        input.contentLength > input.maxBytes) {
        throw invalidPresignPut();
    }
    if (!validPresignPutContentType(input.contentType)) {
        throw invalidPresignPut();
    }
    if (!validPresignPutChecksumSha256(input.checksumSha256)) {
        throw invalidPresignPut();
    }
    if (!Number.isSafeInteger(input.expiresIn) ||
        input.expiresIn <= 0 ||
        input.expiresIn > MAX_PRESIGN_PUT_EXPIRES_IN) {
        throw invalidPresignPut();
    }
}
export function unsupportedObjectStoreOperation(operation) {
    throw new ObjectStoreError(OBJECTSTORE_ERROR_UNSUPPORTED_OPERATION, `objectstore: unsupported operation: ${operation}`);
}
export async function createS3ObjectStore(config = {}) {
    return new S3ObjectStore(new S3Client(s3ClientConfig(config)), config);
}
// The fake clock's default instant keeps fake upload grants byte-identical
// across runs and across the Go, TypeScript and Python fakes.
const FAKE_PRESIGN_PUT_INSTANT = "2026-01-01T00:00:00Z";
const FAKE_PRESIGN_PUT_BASE_URL = "https://objectstore.fake";
const FAKE_PRESIGN_PUT_SIGNED_HEADERS = "content-length;content-type;host;x-amz-checksum-sha256";
export class FakeObjectStore {
    seq = 0;
    clock = null;
    latest = new Map();
    objects = new Map();
    callLog = [];
    failures = new Map();
    setError(operation, error) {
        if (error) {
            this.failures.set(operation, error);
            return;
        }
        this.failures.delete(operation);
    }
    setClock(now) {
        this.clock = now;
    }
    calls() {
        return this.callLog.map((call) => cloneCall(call));
    }
    async put(input) {
        validatePutInput(input);
        this.record({
            operation: "Put",
            ref: input.ref,
            payload: cloneBytes(input.payload ?? new Uint8Array()),
            ...(input.contentType ? { contentType: input.contentType } : {}),
            ...(input.metadata ? { metadata: cloneMetadata(input.metadata) } : {}),
        });
        this.raiseFailure("Put");
        this.seq += 1;
        const ref = {
            ...input.ref,
            versionId: `v${String(this.seq).padStart(20, "0")}`,
        };
        const name = objectName(ref);
        this.latest.set(name, ref.versionId);
        this.objects.set(objectVersion(ref), {
            ref,
            payload: cloneBytes(input.payload ?? new Uint8Array()),
            ...(input.contentType ? { contentType: input.contentType } : {}),
            ...(input.metadata ? { metadata: cloneMetadata(input.metadata) } : {}),
        });
        return cloneRef(ref);
    }
    async get(input) {
        validateGetInput(input);
        this.record({ operation: "Get", ref: input.ref, maxBytes: input.maxBytes });
        this.raiseFailure("Get");
        const obj = this.object(input.ref);
        if (!obj) {
            throw new ObjectStoreError(OBJECTSTORE_ERROR_NOT_FOUND, "objectstore: object not found");
        }
        if (obj.payload.byteLength > input.maxBytes) {
            throw new ObjectStoreError(OBJECTSTORE_ERROR_OBJECT_TOO_LARGE, "objectstore: object exceeds max bytes");
        }
        return cloneOutput(obj);
    }
    async delete(input) {
        validateDeleteInput(input);
        this.record({ operation: "Delete", ref: input.ref });
        this.raiseFailure("Delete");
        const name = objectName(input.ref);
        if (!input.ref.versionId) {
            this.latest.delete(name);
            for (const key of [...this.objects.keys()]) {
                if (key.startsWith(`${name}\0`))
                    this.objects.delete(key);
            }
            return;
        }
        this.objects.delete(objectVersion(input.ref));
        if (this.latest.get(name) === input.ref.versionId) {
            this.latest.delete(name);
        }
    }
    async presignPut(input) {
        validatePresignPutInput(input);
        this.record({
            operation: "PresignPut",
            ref: input.ref,
            maxBytes: input.maxBytes,
            contentLength: input.contentLength,
            checksumSha256: input.checksumSha256,
            expiresIn: input.expiresIn,
            contentType: input.contentType,
        });
        this.raiseFailure("PresignPut");
        // validatePresignPutInput is the same gate the S3 store runs, so the fake refuses exactly what
        // the real store refuses; expiresIn is already a whole number of seconds when it is minted.
        const now = this.now();
        return {
            ref: cloneRef(input.ref),
            url: fakePresignPutUrl(input, now, input.expiresIn),
            method: "PUT",
            headers: presignPutHeaders(input),
            expiresAt: new Date(now.valueOf() + input.expiresIn * 1000),
        };
    }
    object(ref) {
        const versionId = ref.versionId || this.latest.get(objectName(ref));
        if (!versionId)
            return null;
        return this.objects.get(objectVersion({ ...ref, versionId })) ?? null;
    }
    now() {
        const clock = this.clock;
        return clock ? clock() : new Date(FAKE_PRESIGN_PUT_INSTANT);
    }
    record(call) {
        this.callLog.push(cloneCall(call));
    }
    raiseFailure(operation) {
        const failure = this.failures.get(operation);
        if (failure)
            throw failure;
    }
}
class S3ObjectStore {
    client;
    encryption;
    constructor(client, config) {
        this.client = client;
        this.encryption = normalizeS3Encryption(config.encryption ?? {});
    }
    async put(input) {
        validatePutInput(input);
        const commandInput = {
            Bucket: input.ref.bucket,
            Key: input.ref.key,
            Body: input.payload ?? new Uint8Array(),
        };
        if (input.contentType)
            commandInput.ContentType = input.contentType;
        if (input.metadata && Object.keys(input.metadata).length > 0) {
            commandInput.Metadata = cloneMetadata(input.metadata);
        }
        applyS3Encryption(commandInput, this.encryption);
        const output = await this.client.send(new PutObjectCommand(commandInput));
        return cloneRef({
            ...input.ref,
            ...(output.VersionId ? { versionId: output.VersionId } : {}),
        });
    }
    async get(input) {
        validateGetInput(input);
        const commandInput = {
            Bucket: input.ref.bucket,
            Key: input.ref.key,
        };
        if (input.ref.versionId)
            commandInput.VersionId = input.ref.versionId;
        const output = await this.client.send(new GetObjectCommand(commandInput));
        if (!output.Body) {
            throw new ObjectStoreError(OBJECTSTORE_ERROR_INVALID_STORE_CONFIG, "objectstore: invalid store config");
        }
        const payload = await readS3BodyBounded(output.Body, input.maxBytes);
        const ref = cloneRef({
            ...input.ref,
            ...(output.VersionId ? { versionId: output.VersionId } : {}),
        });
        return {
            ref,
            payload,
            ...(output.ContentType ? { contentType: output.ContentType } : {}),
            ...(output.Metadata ? { metadata: cloneMetadata(output.Metadata) } : {}),
        };
    }
    async delete(input) {
        validateDeleteInput(input);
        const commandInput = {
            Bucket: input.ref.bucket,
            Key: input.ref.key,
        };
        if (input.ref.versionId)
            commandInput.VersionId = input.ref.versionId;
        await this.client.send(new DeleteObjectCommand(commandInput));
    }
    /**
     * Mints one bounded upload grant for an exact object reference.
     *
     * Both presigner header sets are required and must not be "simplified":
     * without `signableHeaders` the SDK drops `content-type` from the signature,
     * and without `unhoistableHeaders` it hoists `x-amz-checksum-sha256` into the
     * unsigned query. The post-condition check refuses such a URL. No
     * server-side-encryption header is attached on this path.
     */
    async presignPut(input) {
        validatePresignPutInput(input);
        const url = await getSignedUrl(this.client, new PutObjectCommand({
            Bucket: input.ref.bucket,
            Key: input.ref.key,
            ContentLength: input.contentLength,
            ContentType: input.contentType,
            ChecksumSHA256: input.checksumSha256,
        }), {
            expiresIn: input.expiresIn,
            signableHeaders: new Set([
                "content-length",
                "content-type",
                "x-amz-checksum-sha256",
            ]),
            unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
        });
        verifyPresignPutUrl(url, input.expiresIn);
        return {
            ref: cloneRef(input.ref),
            url,
            method: "PUT",
            headers: presignPutHeaders(input),
            expiresAt: new Date(Date.now() + input.expiresIn * 1000),
        };
    }
}
function validatePutInput(input) {
    validateObjectRef(input.ref);
    if (input.ref.versionId)
        throw invalidObjectRef();
}
function validateGetInput(input) {
    validateObjectRef(input.ref);
    if (!Number.isFinite(input.maxBytes) || input.maxBytes <= 0) {
        throw new ObjectStoreError(OBJECTSTORE_ERROR_INVALID_GET_LIMIT, "objectstore: max bytes must be positive");
    }
}
function validateDeleteInput(input) {
    validateObjectRef(input.ref);
}
function invalidObjectRef() {
    return new ObjectStoreError(OBJECTSTORE_ERROR_INVALID_REF, "objectstore: invalid object ref");
}
function invalidPresignPut() {
    return new ObjectStoreError(OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT, "objectstore: invalid presign put");
}
function validPresignPutContentType(contentType) {
    if (!contentType || contentType !== contentType.trim())
        return false;
    return !containsControl(contentType);
}
// validPresignPutChecksumSha256 accepts only the canonical base64 encoding of a
// 32-byte digest. The explicit length, alphabet, padding and round-trip checks
// keep every runtime identical, because Buffer.from(value, "base64") silently
// accepts non-canonical input.
function validPresignPutChecksumSha256(checksum) {
    const encodedLength = 44;
    if (typeof checksum !== "string" ||
        checksum.length !== encodedLength ||
        !checksum.endsWith("=")) {
        return false;
    }
    for (let index = 0; index < encodedLength - 1; index += 1) {
        if (!isBase64StandardByte(checksum.charCodeAt(index)))
            return false;
    }
    const decoded = Buffer.from(checksum, "base64");
    if (decoded.length !== 32)
        return false;
    return decoded.toString("base64") === checksum;
}
function isBase64StandardByte(value) {
    return ((value >= 0x41 && value <= 0x5a) ||
        (value >= 0x61 && value <= 0x7a) ||
        (value >= 0x30 && value <= 0x39) ||
        value === 0x2b ||
        value === 0x2f);
}
function presignPutHeaders(input) {
    return {
        "content-length": String(input.contentLength),
        "content-type": input.contentType,
        "x-amz-checksum-sha256": input.checksumSha256,
    };
}
function containsControl(value) {
    for (const ch of value) {
        if (ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f)
            return true;
    }
    return false;
}
function containsControlOrSpace(value) {
    for (const ch of value) {
        const cp = ch.codePointAt(0);
        if (cp < 0x20 || cp === 0x7f || /\s/u.test(ch))
            return true;
    }
    return false;
}
function objectName(ref) {
    return `${ref.bucket}\0${ref.key}`;
}
function objectVersion(ref) {
    return `${objectName(ref)}\0${ref.versionId ?? ""}`;
}
// The fake encodes the signed constraints instead of hashing them, so tests can
// assert the exact grant without AWS. This URL format is shared byte-for-byte
// with the Go and Python fakes because a contract fixture asserts it.
function fakePresignPutUrl(input, now, expiresIn) {
    const parameters = [
        fakeQueryParameter("X-Amz-Algorithm", "AWS4-HMAC-SHA256"),
        fakeQueryParameter("X-Amz-Credential", "apptheory-fake"),
        fakeQueryParameter("X-Amz-Date", fakePresignPutDate(now)),
        fakeQueryParameter("X-Amz-Expires", String(expiresIn)),
        fakeQueryParameter("X-Amz-Signature", "fake"),
        fakeQueryParameter("X-Amz-SignedHeaders", FAKE_PRESIGN_PUT_SIGNED_HEADERS),
        fakeQueryParameter("x-amz-checksum-sha256", input.checksumSha256),
        fakeQueryParameter("x-amz-content-length", String(input.contentLength)),
        fakeQueryParameter("x-amz-content-type", input.contentType),
    ];
    const path = `${fakePercentEncode(input.ref.bucket, true)}/${fakePercentEncode(input.ref.key, true)}`;
    return `${FAKE_PRESIGN_PUT_BASE_URL}/${path}?${parameters.join("&")}`;
}
function fakePresignPutDate(now) {
    return now
        .toISOString()
        .replace(/[-:]/gu, "")
        .replace(/\.\d{3}Z$/u, "Z");
}
function fakeQueryParameter(name, value) {
    return `${name}=${fakePercentEncode(value, false)}`;
}
// Escapes every byte outside the RFC 3986 unreserved set with uppercase hex.
// Path segments additionally keep "/" literal. All three runtimes share this
// rule byte-for-byte.
function fakePercentEncode(value, keepSlash) {
    let out = "";
    for (const byte of Buffer.from(value, "utf8")) {
        if (fakePercentEncodeLiteral(byte, keepSlash)) {
            out += String.fromCharCode(byte);
            continue;
        }
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    return out;
}
function fakePercentEncodeLiteral(value, keepSlash) {
    if ((value >= 0x41 && value <= 0x5a) ||
        (value >= 0x61 && value <= 0x7a) ||
        (value >= 0x30 && value <= 0x39)) {
        return true;
    }
    if (value === 0x2d || value === 0x5f || value === 0x2e || value === 0x7e) {
        return true;
    }
    return keepSlash && value === 0x2f;
}
function cloneRef(ref) {
    return {
        bucket: ref.bucket,
        key: ref.key,
        ...(ref.versionId ? { versionId: ref.versionId } : {}),
    };
}
function cloneBytes(input) {
    return new Uint8Array(input);
}
function cloneMetadata(input) {
    return Object.fromEntries(Object.keys(input)
        .sort()
        .map((key) => [key, input[key] ?? ""]));
}
function cloneCall(call) {
    return {
        operation: call.operation,
        ref: cloneRef(call.ref),
        ...(call.maxBytes !== undefined ? { maxBytes: call.maxBytes } : {}),
        ...(call.contentType ? { contentType: call.contentType } : {}),
        ...(call.metadata ? { metadata: cloneMetadata(call.metadata) } : {}),
        ...(call.payload ? { payload: cloneBytes(call.payload) } : {}),
        ...(call.contentLength !== undefined
            ? { contentLength: call.contentLength }
            : {}),
        ...(call.checksumSha256 ? { checksumSha256: call.checksumSha256 } : {}),
        ...(call.expiresIn !== undefined ? { expiresIn: call.expiresIn } : {}),
    };
}
function cloneOutput(obj) {
    return {
        ref: cloneRef(obj.ref),
        payload: cloneBytes(obj.payload),
        ...(obj.contentType ? { contentType: obj.contentType } : {}),
        ...(obj.metadata ? { metadata: cloneMetadata(obj.metadata) } : {}),
    };
}
function s3ClientConfig(config) {
    const region = String(config.region ?? "").trim();
    return region ? { region } : {};
}
function normalizeS3Encryption(encryption) {
    const mode = encryption.mode || S3Encryption.BucketDefault;
    const kmsKeyId = String(encryption.kmsKeyId ?? "");
    if (kmsKeyId !== kmsKeyId.trim()) {
        throw invalidEncryptionConfig();
    }
    if (mode === S3Encryption.KMS) {
        if (!kmsKeyId)
            throw invalidEncryptionConfig();
        return { mode, kmsKeyId };
    }
    if (mode === S3Encryption.BucketDefault || mode === S3Encryption.S3Managed) {
        if (kmsKeyId)
            throw invalidEncryptionConfig();
        return { mode, kmsKeyId: "" };
    }
    throw invalidEncryptionConfig();
}
function invalidEncryptionConfig() {
    return new ObjectStoreError(OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG, "objectstore: invalid encryption config");
}
function applyS3Encryption(input, encryption) {
    if (encryption.mode === S3Encryption.S3Managed) {
        input.ServerSideEncryption = ServerSideEncryption.AES256;
    }
    if (encryption.mode === S3Encryption.KMS) {
        input.ServerSideEncryption = ServerSideEncryption.aws_kms;
        input.SSEKMSKeyId = encryption.kmsKeyId;
    }
}
async function readS3BodyBounded(body, maxBytes) {
    if (body instanceof Uint8Array)
        return ensureBounded(body, maxBytes);
    if (typeof body === "string")
        return ensureBounded(Buffer.from(body), maxBytes);
    if (isAsyncIterable(body))
        return readAsyncIterableBounded(body, maxBytes);
    throw new ObjectStoreError(OBJECTSTORE_ERROR_INVALID_STORE_CONFIG, "objectstore: invalid store config");
}
async function readAsyncIterableBounded(body, maxBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
        const bytes = chunkToBytes(chunk);
        total += bytes.byteLength;
        if (total > maxBytes) {
            closeBody(body);
            throw new ObjectStoreError(OBJECTSTORE_ERROR_OBJECT_TOO_LARGE, "objectstore: object exceeds max bytes");
        }
        chunks.push(bytes);
    }
    return concatBytes(chunks, total);
}
function ensureBounded(bytes, maxBytes) {
    if (bytes.byteLength > maxBytes) {
        throw new ObjectStoreError(OBJECTSTORE_ERROR_OBJECT_TOO_LARGE, "objectstore: object exceeds max bytes");
    }
    return cloneBytes(bytes);
}
function concatBytes(chunks, total) {
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
function chunkToBytes(chunk) {
    if (chunk instanceof Uint8Array)
        return chunk;
    if (typeof chunk === "string")
        return Buffer.from(chunk);
    if (chunk instanceof ArrayBuffer)
        return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk)) {
        return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    throw new ObjectStoreError(OBJECTSTORE_ERROR_INVALID_STORE_CONFIG, "objectstore: invalid store config");
}
function isAsyncIterable(value) {
    return (typeof value === "object" && value !== null && Symbol.asyncIterator in value);
}
function closeBody(body) {
    if (typeof body !== "object" || body === null)
        return;
    const maybeDestroy = body.destroy;
    if (typeof maybeDestroy === "function")
        maybeDestroy.call(body);
}
//# sourceMappingURL=objectstore.js.map