import { InvokeModelCommand, type InvokeModelCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { S3VectorsClient } from "@aws-sdk/client-s3vectors";
export declare const VECTORSTORE_ERROR_INVALID_CONFIG = "vectorstore.invalid_config";
export declare const VECTORSTORE_ERROR_INVALID_INPUT = "vectorstore.invalid_input";
export declare const VECTORSTORE_ERROR_INVALID_VECTOR = "vectorstore.invalid_vector";
export declare const VECTORSTORE_ERROR_DIMENSION_MISMATCH = "vectorstore.dimension_mismatch";
export declare const VECTORSTORE_ERROR_NOT_FOUND = "vectorstore.not_found";
export declare const VECTORSTORE_ERROR_UNSUPPORTED_OPERATION = "vectorstore.unsupported_operation";
export declare const VECTORSTORE_ERROR_EMBEDDING_FAILED = "vectorstore.embedding_failed";
export declare const EnvVectorBucketName = "APPTHEORY_VECTOR_BUCKET_NAME";
export declare const EnvVectorIndexName = "APPTHEORY_VECTOR_INDEX_NAME";
export declare const EnvVectorIndexArn = "APPTHEORY_VECTOR_INDEX_ARN";
export declare const EnvVectorDimension = "APPTHEORY_VECTOR_DIMENSION";
export declare const EnvEmbeddingProvider = "APPTHEORY_EMBEDDING_PROVIDER";
export declare const EnvEmbeddingModelId = "APPTHEORY_EMBEDDING_MODEL_ID";
export declare const EnvEmbeddingDimensions = "APPTHEORY_EMBEDDING_DIMENSIONS";
export declare const EnvEmbeddingNormalize = "APPTHEORY_EMBEDDING_NORMALIZE";
export declare const DefaultTitanEmbedTextModelId = "amazon.titan-embed-text-v2:0";
export declare const DefaultEmbeddingDimensions = 1024;
export declare const DefaultQueryTopK = 12;
export declare const MaxQueryTopK = 10000;
export declare const MaxPutDeleteBatchSize = 500;
export declare class VectorStoreError extends Error {
    readonly code: string;
    readonly cause?: unknown;
    constructor(code: string, message: string, cause?: unknown);
}
export interface VectorRecord {
    key: string;
    data: number[];
    metadata?: Record<string, unknown> | undefined;
}
export interface PutVectorsInput {
    records: VectorRecord[];
}
export interface GetVectorsInput {
    keys: string[];
    returnMetadata?: boolean | undefined;
}
export interface DeleteVectorsInput {
    keys: string[];
}
export interface QueryVectorsInput {
    vector: number[];
    topK?: number | undefined;
    filter?: Record<string, unknown> | undefined;
    returnMetadata?: boolean | undefined;
}
export interface QueryHit {
    key: string;
    distance: number;
    metadata?: Record<string, unknown> | undefined;
}
export interface VectorStoreCall {
    operation: string;
    keys?: string[] | undefined;
    records?: VectorRecord[] | undefined;
    vector?: number[] | undefined;
    topK?: number | undefined;
    filter?: Record<string, unknown> | undefined;
    returnMetadata?: boolean | undefined;
}
export interface VectorStore {
    putVectors(input: PutVectorsInput): Promise<void>;
    getVectors(input: GetVectorsInput): Promise<VectorRecord[]>;
    deleteVectors(input: DeleteVectorsInput): Promise<void>;
    queryVectors(input: QueryVectorsInput): Promise<QueryHit[]>;
}
export interface Embedder {
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
}
export declare function validateDimension(dimension: number): void;
export declare function validateVector(vector: number[], dimension?: number): void;
export declare function normalizeTopK(topK?: number): number;
export declare function cloneVector(vector: readonly number[] | undefined): number[];
export declare function cloneMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined;
export declare function validateRequiredMetadata(metadata: Record<string, unknown> | undefined, requiredKeys?: readonly string[]): void;
export declare class FakeVectorStore implements VectorStore {
    readonly dimension: number;
    requiredMetadataKeys: string[];
    private readonly records;
    private readonly callLog;
    private readonly failures;
    constructor(dimension: number);
    setError(operation: string, error: Error | null): void;
    calls(): VectorStoreCall[];
    putVectors(input: PutVectorsInput): Promise<void>;
    getVectors(input: GetVectorsInput): Promise<VectorRecord[]>;
    deleteVectors(input: DeleteVectorsInput): Promise<void>;
    queryVectors(input: QueryVectorsInput): Promise<QueryHit[]>;
    private record;
    private raiseFailure;
}
export declare function createFakeVectorStore(dimension: number): FakeVectorStore;
export interface S3VectorStoreConfig {
    vectorBucketName: string;
    indexName: string;
    dimension: number;
    region?: string | undefined;
    maxBatchSize?: number | undefined;
    client?: Pick<S3VectorsClient, "send"> | undefined;
}
export declare class S3VectorStore implements VectorStore {
    private readonly client;
    private readonly vectorBucketName;
    private readonly indexName;
    private readonly dimension;
    private readonly maxBatchSize;
    constructor(config: S3VectorStoreConfig);
    putVectors(input: PutVectorsInput): Promise<void>;
    getVectors(input: GetVectorsInput): Promise<VectorRecord[]>;
    deleteVectors(input: DeleteVectorsInput): Promise<void>;
    queryVectors(input: QueryVectorsInput): Promise<QueryHit[]>;
}
export declare function createS3VectorStore(config: S3VectorStoreConfig): VectorStore;
export declare class FakeEmbedder implements Embedder {
    readonly embeddings: Map<string, number[]>;
    defaultEmbedding?: number[] | undefined;
    readonly calls: string[];
    constructor(embeddings?: Record<string, number[]>);
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
}
export interface BedrockRuntimeLike {
    send(command: InvokeModelCommand): Promise<InvokeModelCommandOutput>;
}
export interface TitanEmbedderConfig {
    client?: BedrockRuntimeLike | undefined;
    region?: string | undefined;
    modelId?: string | undefined;
    dimensions?: number | undefined;
    normalize?: boolean | undefined;
}
export declare class TitanEmbedder implements Embedder {
    private readonly client;
    readonly modelId: string;
    readonly dimensions: number;
    readonly normalize: boolean;
    constructor(config?: TitanEmbedderConfig);
    embed(text: string): Promise<number[]>;
    embedBatch(texts: string[]): Promise<number[][]>;
}
export interface SemanticRecord {
    key: string;
    text: string;
    metadata?: Record<string, unknown> | undefined;
}
export interface SemanticIndexConfig {
    store: VectorStore;
    embedder: Embedder;
    dimension: number;
    requiredMetadataKeys?: string[] | undefined;
}
export declare class SemanticIndex {
    private readonly store;
    private readonly embedder;
    private readonly dimension;
    private readonly requiredMetadataKeys;
    constructor(config: SemanticIndexConfig);
    putText(records: SemanticRecord[]): Promise<void>;
    queryText(text: string, input?: Omit<QueryVectorsInput, "vector">): Promise<QueryHit[]>;
}
//# sourceMappingURL=vectorstore.d.ts.map