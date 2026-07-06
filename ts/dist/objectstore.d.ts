export declare const OBJECTSTORE_ERROR_INVALID_REF = "objectstore.invalid_ref";
export declare const OBJECTSTORE_ERROR_INVALID_GET_LIMIT = "objectstore.invalid_get_limit";
export declare const OBJECTSTORE_ERROR_OBJECT_TOO_LARGE = "objectstore.object_too_large";
export declare const OBJECTSTORE_ERROR_NOT_FOUND = "objectstore.not_found";
export declare const OBJECTSTORE_ERROR_INVALID_STORE_CONFIG = "objectstore.invalid_store_config";
export declare const OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG = "objectstore.invalid_encryption_config";
export declare const OBJECTSTORE_ERROR_UNSUPPORTED_OPERATION = "objectstore.unsupported_operation";
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
export interface S3EncryptionConfig {
    mode?: S3EncryptionMode;
    kmsKeyId?: string;
}
export interface S3ObjectStoreConfig {
    region?: string;
    encryption?: S3EncryptionConfig;
}
export type ObjectStoreOperation = "Put" | "Get" | "Delete";
export interface ObjectStoreCall {
    operation: ObjectStoreOperation;
    ref: ObjectRef;
    maxBytes?: number;
    contentType?: string;
    metadata?: Record<string, string>;
    payload?: Uint8Array;
}
export declare function parseObjectRef(raw: string): ObjectRef;
export declare function validateObjectRef(ref: ObjectRef): void;
export declare function createFakeObjectStore(): FakeObjectStore;
export declare function unsupportedObjectStoreOperation(operation: string): never;
export declare function createS3ObjectStore(config?: S3ObjectStoreConfig): Promise<ObjectStore>;
export declare class FakeObjectStore implements ObjectStore {
    private seq;
    private readonly latest;
    private readonly objects;
    private readonly callLog;
    private readonly failures;
    setError(operation: ObjectStoreOperation, error: Error | null): void;
    calls(): ObjectStoreCall[];
    put(input: ObjectStorePutInput): Promise<ObjectRef>;
    get(input: ObjectStoreGetInput): Promise<ObjectStoreGetOutput>;
    delete(input: ObjectStoreDeleteInput): Promise<void>;
    private object;
    private record;
    private raiseFailure;
}
//# sourceMappingURL=objectstore.d.ts.map