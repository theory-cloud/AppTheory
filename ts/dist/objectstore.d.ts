export declare const OBJECTSTORE_ERROR_INVALID_REF = "objectstore.invalid_ref";
export declare const OBJECTSTORE_ERROR_INVALID_GET_LIMIT = "objectstore.invalid_get_limit";
export declare const OBJECTSTORE_ERROR_OBJECT_TOO_LARGE = "objectstore.object_too_large";
export declare const OBJECTSTORE_ERROR_NOT_FOUND = "objectstore.not_found";
export declare const OBJECTSTORE_ERROR_INVALID_STORE_CONFIG = "objectstore.invalid_store_config";
export declare const OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG = "objectstore.invalid_encryption_config";
export declare const OBJECTSTORE_ERROR_UNSUPPORTED_OPERATION = "objectstore.unsupported_operation";
export declare const OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT = "objectstore.invalid_presign_put";
/** Framework ceiling for a bounded upload grant, in seconds. */
export declare const MAX_PRESIGN_PUT_EXPIRES_IN = 900;
export declare const S3Encryption: {
    readonly BucketDefault: "bucket-default";
    readonly S3Managed: "s3-managed";
    readonly KMS: "kms";
};
export type S3EncryptionMode = (typeof S3Encryption)[keyof typeof S3Encryption];
export declare class ObjectStoreError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export interface ObjectRef {
    bucket: string;
    key: string;
    versionId?: string;
}
export interface ObjectStorePutInput {
    ref: ObjectRef;
    payload?: Uint8Array;
    contentType?: string;
    metadata?: Record<string, string>;
}
export interface ObjectStoreGetInput {
    ref: ObjectRef;
    maxBytes: number;
}
export interface ObjectStoreGetOutput {
    ref: ObjectRef;
    payload: Uint8Array;
    contentType?: string;
    metadata?: Record<string, string>;
}
export interface ObjectStoreDeleteInput {
    ref: ObjectRef;
}
export interface ObjectStore {
    put(input: ObjectStorePutInput): Promise<ObjectRef>;
    get(input: ObjectStoreGetInput): Promise<ObjectStoreGetOutput>;
    delete(input: ObjectStoreDeleteInput): Promise<void>;
}
/**
 * One bounded upload grant request. Every field is required: the reference
 * must be exact and unversioned, the content length must be positive and no
 * larger than maxBytes, the checksum must be the canonical base64 SHA-256
 * digest of the exact bytes the client will upload, and expiresIn must be
 * positive and at most MAX_PRESIGN_PUT_EXPIRES_IN seconds.
 */
export interface ObjectStorePresignPutInput {
    ref: ObjectRef;
    contentLength: number;
    checksumSha256: string;
    contentType: string;
    maxBytes: number;
    expiresIn: number;
}
export interface ObjectStorePresignPutOutput {
    ref: ObjectRef;
    url: string;
    method: string;
    headers: Record<string, string>;
    expiresAt: Date;
}
/**
 * The bounded upload-grant capability, deliberately separate from
 * `ObjectStore`: the Put/Get/Delete contract is unchanged, and a store opts in
 * to minting one narrow upload link. Consumers upgrade the interface rather
 * than changing how they construct the store.
 *
 * Presigned GET, presigning without a checksum, list, multipart, copy, head,
 * public URLs and raw clients stay forbidden: they have no method here.
 */
export interface ObjectStoreUploadGranter {
    presignPut(input: ObjectStorePresignPutInput): Promise<ObjectStorePresignPutOutput>;
}
export interface S3EncryptionConfig {
    mode?: S3EncryptionMode;
    kmsKeyId?: string;
}
export interface S3ObjectStoreConfig {
    region?: string;
    encryption?: S3EncryptionConfig;
}
export type ObjectStoreOperation = "Put" | "Get" | "Delete" | "PresignPut";
export interface ObjectStoreCall {
    operation: ObjectStoreOperation;
    ref: ObjectRef;
    maxBytes?: number;
    contentType?: string;
    metadata?: Record<string, string>;
    payload?: Uint8Array;
    contentLength?: number;
    checksumSha256?: string;
    expiresIn?: number;
}
export declare function parseObjectRef(raw: string): ObjectRef;
export declare function validateObjectRef(ref: ObjectRef): void;
export declare function createFakeObjectStore(): FakeObjectStore;
/** Verifies a grant request is complete and safe. Every failure is fail-closed. */
export declare function validatePresignPutInput(input: ObjectStorePresignPutInput): void;
export declare function unsupportedObjectStoreOperation(operation: string): never;
export declare function createS3ObjectStore(config?: S3ObjectStoreConfig): Promise<ObjectStore>;
export declare class FakeObjectStore implements ObjectStore, ObjectStoreUploadGranter {
    private seq;
    private clock;
    private readonly latest;
    private readonly objects;
    private readonly callLog;
    private readonly failures;
    setError(operation: ObjectStoreOperation, error: Error | null): void;
    setClock(now: (() => Date) | null): void;
    calls(): ObjectStoreCall[];
    put(input: ObjectStorePutInput): Promise<ObjectRef>;
    get(input: ObjectStoreGetInput): Promise<ObjectStoreGetOutput>;
    delete(input: ObjectStoreDeleteInput): Promise<void>;
    presignPut(input: ObjectStorePresignPutInput): Promise<ObjectStorePresignPutOutput>;
    private object;
    private now;
    private record;
    private raiseFailure;
}
//# sourceMappingURL=objectstore.d.ts.map