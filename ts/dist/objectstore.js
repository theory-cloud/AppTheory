import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, ServerSideEncryption, } from "@aws-sdk/client-s3";
export const OBJECTSTORE_ERROR_INVALID_REF = "objectstore.invalid_ref";
export const OBJECTSTORE_ERROR_INVALID_GET_LIMIT = "objectstore.invalid_get_limit";
export const OBJECTSTORE_ERROR_OBJECT_TOO_LARGE = "objectstore.object_too_large";
export const OBJECTSTORE_ERROR_NOT_FOUND = "objectstore.not_found";
export const OBJECTSTORE_ERROR_INVALID_STORE_CONFIG = "objectstore.invalid_store_config";
export const OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG = "objectstore.invalid_encryption_config";
export const OBJECTSTORE_ERROR_UNSUPPORTED_OPERATION = "objectstore.unsupported_operation";
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
export function unsupportedObjectStoreOperation(operation) {
    throw new ObjectStoreError(OBJECTSTORE_ERROR_UNSUPPORTED_OPERATION, `objectstore: unsupported operation: ${operation}`);
}
export async function createS3ObjectStore(config = {}) {
    return new S3ObjectStore(new S3Client(s3ClientConfig(config)), config);
}
export class FakeObjectStore {
    seq = 0;
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
    object(ref) {
        const versionId = ref.versionId || this.latest.get(objectName(ref));
        if (!versionId)
            return null;
        return this.objects.get(objectVersion({ ...ref, versionId })) ?? null;
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