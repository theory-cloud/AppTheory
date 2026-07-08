import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandInput,
  type InvokeModelCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import {
  DeleteVectorsCommand,
  GetVectorsCommand,
  PutVectorsCommand,
  QueryVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";

export const VECTORSTORE_ERROR_INVALID_CONFIG = "vectorstore.invalid_config";
export const VECTORSTORE_ERROR_INVALID_INPUT = "vectorstore.invalid_input";
export const VECTORSTORE_ERROR_INVALID_VECTOR = "vectorstore.invalid_vector";
export const VECTORSTORE_ERROR_DIMENSION_MISMATCH =
  "vectorstore.dimension_mismatch";
export const VECTORSTORE_ERROR_NOT_FOUND = "vectorstore.not_found";
export const VECTORSTORE_ERROR_UNSUPPORTED_OPERATION =
  "vectorstore.unsupported_operation";
export const VECTORSTORE_ERROR_EMBEDDING_FAILED =
  "vectorstore.embedding_failed";

export const EnvVectorBucketName = "APPTHEORY_VECTOR_BUCKET_NAME";
export const EnvVectorIndexName = "APPTHEORY_VECTOR_INDEX_NAME";
export const EnvVectorIndexArn = "APPTHEORY_VECTOR_INDEX_ARN";
export const EnvVectorDimension = "APPTHEORY_VECTOR_DIMENSION";
export const EnvEmbeddingProvider = "APPTHEORY_EMBEDDING_PROVIDER";
export const EnvEmbeddingModelId = "APPTHEORY_EMBEDDING_MODEL_ID";
export const EnvEmbeddingDimensions = "APPTHEORY_EMBEDDING_DIMENSIONS";
export const EnvEmbeddingNormalize = "APPTHEORY_EMBEDDING_NORMALIZE";
export const DefaultTitanEmbedTextModelId = "amazon.titan-embed-text-v2:0";
export const DefaultEmbeddingDimensions = 1024;
export const DefaultQueryTopK = 12;
export const MaxQueryTopK = 10_000;
export const MaxPutDeleteBatchSize = 500;

export class VectorStoreError extends Error {
  readonly code: string;
  readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "VectorStoreError";
    this.code = code;
    this.cause = cause;
  }
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

export function validateDimension(dimension: number): void {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new VectorStoreError(
      VECTORSTORE_ERROR_INVALID_CONFIG,
      "vectorstore: dimension must be positive",
    );
  }
}

export function validateVector(vector: number[], dimension?: number): void {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new VectorStoreError(
      VECTORSTORE_ERROR_INVALID_VECTOR,
      "vectorstore: vector is required",
    );
  }
  if (dimension && vector.length !== dimension) {
    throw new VectorStoreError(
      VECTORSTORE_ERROR_DIMENSION_MISMATCH,
      `vectorstore: vector dimension mismatch: got ${vector.length} want ${dimension}`,
    );
  }
  if (!vector.every((value) => Number.isFinite(value))) {
    throw new VectorStoreError(
      VECTORSTORE_ERROR_INVALID_VECTOR,
      "vectorstore: vector values must be finite",
    );
  }
}

export function normalizeTopK(topK?: number): number {
  if (!topK || topK <= 0) return DefaultQueryTopK;
  return Math.min(Math.trunc(topK), MaxQueryTopK);
}

export function cloneVector(vector: readonly number[] | undefined): number[] {
  return vector ? Array.from(vector) : [];
}

export function cloneMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata || Object.keys(metadata).length === 0) return undefined;
  return structuredCloneCompatible(metadata) as Record<string, unknown>;
}

export function validateRequiredMetadata(
  metadata: Record<string, unknown> | undefined,
  requiredKeys: readonly string[] = [],
): void {
  for (const rawKey of requiredKeys) {
    const key = String(rawKey).trim();
    if (!key) continue;
    const value = metadata?.[key];
    if (isBlankMetadataValue(value)) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_INVALID_INPUT,
        `vectorstore: required metadata missing: ${key}`,
      );
    }
  }
}

export class FakeVectorStore implements VectorStore {
  readonly dimension: number;
  requiredMetadataKeys: string[] = [];
  private readonly records = new Map<string, VectorRecord>();
  private readonly callLog: VectorStoreCall[] = [];
  private readonly failures = new Map<string, Error>();

  constructor(dimension: number) {
    validateDimension(dimension);
    this.dimension = dimension;
  }

  setError(operation: string, error: Error | null): void {
    if (error) this.failures.set(operation, error);
    else this.failures.delete(operation);
  }

  calls(): VectorStoreCall[] {
    return this.callLog.map(cloneCall);
  }

  async putVectors(input: PutVectorsInput): Promise<void> {
    if (!input.records?.length) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_INVALID_INPUT,
        "vectorstore: at least one vector is required",
      );
    }
    if (input.records.length > MaxPutDeleteBatchSize) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_INVALID_INPUT,
        "vectorstore: put batch exceeds 500 vectors",
      );
    }
    for (const record of input.records) {
      validateKey(record.key);
      validateVector(record.data, this.dimension);
      validateRequiredMetadata(record.metadata, this.requiredMetadataKeys);
    }
    this.record({
      operation: "PutVectors",
      records: cloneRecords(input.records),
    });
    this.raiseFailure("PutVectors");
    for (const record of input.records) {
      this.records.set(record.key, cloneRecord(record));
    }
  }

  async getVectors(input: GetVectorsInput): Promise<VectorRecord[]> {
    if (!input.keys?.length) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_INVALID_INPUT,
        "vectorstore: at least one key is required",
      );
    }
    this.record({
      operation: "GetVectors",
      keys: Array.from(input.keys),
      returnMetadata: Boolean(input.returnMetadata),
    });
    this.raiseFailure("GetVectors");
    return input.keys.map((key) => {
      validateKey(key);
      const record = this.records.get(key);
      if (!record) {
        throw new VectorStoreError(
          VECTORSTORE_ERROR_NOT_FOUND,
          "vectorstore: vector not found",
        );
      }
      const cloned = cloneRecord(record);
      if (!input.returnMetadata) delete cloned.metadata;
      return cloned;
    });
  }

  async deleteVectors(input: DeleteVectorsInput): Promise<void> {
    if (!input.keys?.length) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_INVALID_INPUT,
        "vectorstore: at least one key is required",
      );
    }
    if (input.keys.length > MaxPutDeleteBatchSize) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_INVALID_INPUT,
        "vectorstore: delete batch exceeds 500 vectors",
      );
    }
    for (const key of input.keys) validateKey(key);
    this.record({ operation: "DeleteVectors", keys: Array.from(input.keys) });
    this.raiseFailure("DeleteVectors");
    for (const key of input.keys) this.records.delete(key);
  }

  async queryVectors(input: QueryVectorsInput): Promise<QueryHit[]> {
    validateVector(input.vector, this.dimension);
    const topK = normalizeTopK(input.topK);
    this.record({
      operation: "QueryVectors",
      vector: cloneVector(input.vector),
      topK,
      filter: cloneMetadata(input.filter),
      returnMetadata: Boolean(input.returnMetadata),
    });
    this.raiseFailure("QueryVectors");
    const hits = Array.from(this.records.values())
      .filter((record) => metadataMatches(record.metadata, input.filter))
      .map((record) => ({
        key: record.key,
        distance: squaredDistance(input.vector, record.data),
        ...(input.returnMetadata && record.metadata
          ? { metadata: cloneMetadata(record.metadata) }
          : {}),
      }))
      .sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key));
    return hits.slice(0, topK);
  }

  private record(call: VectorStoreCall): void {
    this.callLog.push(cloneCall(call));
  }

  private raiseFailure(operation: string): void {
    const failure = this.failures.get(operation);
    if (failure) throw failure;
  }
}

export function createFakeVectorStore(dimension: number): FakeVectorStore {
  return new FakeVectorStore(dimension);
}

export interface S3VectorStoreConfig {
  vectorBucketName: string;
  indexName: string;
  dimension: number;
  region?: string | undefined;
  maxBatchSize?: number | undefined;
  client?: Pick<S3VectorsClient, "send"> | undefined;
}

export class S3VectorStore implements VectorStore {
  private readonly client: Pick<S3VectorsClient, "send">;
  private readonly vectorBucketName: string;
  private readonly indexName: string;
  private readonly dimension: number;
  private readonly maxBatchSize: number;

  constructor(config: S3VectorStoreConfig) {
    this.vectorBucketName = config.vectorBucketName?.trim();
    this.indexName = config.indexName?.trim();
    this.dimension = config.dimension;
    if (!this.vectorBucketName || !this.indexName) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_INVALID_CONFIG,
        "vectorstore: vector bucket and index name are required",
      );
    }
    validateDimension(this.dimension);
    this.maxBatchSize = Math.min(
      Math.max(1, config.maxBatchSize ?? MaxPutDeleteBatchSize),
      MaxPutDeleteBatchSize,
    );
    this.client =
      config.client ??
      new S3VectorsClient(config.region ? { region: config.region } : {});
  }

  async putVectors(input: PutVectorsInput): Promise<void> {
    if (!input.records?.length) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_INVALID_INPUT,
        "vectorstore: at least one vector is required",
      );
    }
    for (
      let start = 0;
      start < input.records.length;
      start += this.maxBatchSize
    ) {
      const records = input.records.slice(start, start + this.maxBatchSize);
      const vectors = records.map((record) => {
        validateKey(record.key);
        validateVector(record.data, this.dimension);
        return {
          key: record.key,
          data: { float32: record.data },
          ...(record.metadata ? { metadata: record.metadata } : {}),
        };
      });
      await this.client.send(
        new PutVectorsCommand({
          vectorBucketName: this.vectorBucketName,
          indexName: this.indexName,
          vectors,
        } as never),
      );
    }
  }

  async getVectors(input: GetVectorsInput): Promise<VectorRecord[]> {
    if (!input.keys?.length) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_INVALID_INPUT,
        "vectorstore: at least one key is required",
      );
    }
    for (const key of input.keys) validateKey(key);
    const output = (await this.client.send(
      new GetVectorsCommand({
        vectorBucketName: this.vectorBucketName,
        indexName: this.indexName,
        keys: input.keys,
        returnData: true,
        returnMetadata: Boolean(input.returnMetadata),
      } as never),
    )) as { vectors?: unknown[] };
    return (output.vectors ?? []).map(s3VectorToRecord);
  }

  async deleteVectors(input: DeleteVectorsInput): Promise<void> {
    if (!input.keys?.length) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_INVALID_INPUT,
        "vectorstore: at least one key is required",
      );
    }
    for (const key of input.keys) validateKey(key);
    for (let start = 0; start < input.keys.length; start += this.maxBatchSize) {
      await this.client.send(
        new DeleteVectorsCommand({
          vectorBucketName: this.vectorBucketName,
          indexName: this.indexName,
          keys: input.keys.slice(start, start + this.maxBatchSize),
        } as never),
      );
    }
  }

  async queryVectors(input: QueryVectorsInput): Promise<QueryHit[]> {
    validateVector(input.vector, this.dimension);
    const output = (await this.client.send(
      new QueryVectorsCommand({
        vectorBucketName: this.vectorBucketName,
        indexName: this.indexName,
        queryVector: { float32: input.vector },
        topK: normalizeTopK(input.topK),
        returnDistance: true,
        returnMetadata: Boolean(input.returnMetadata),
        ...(input.filter ? { filter: input.filter } : {}),
      } as never),
    )) as { vectors?: unknown[] };
    return (output.vectors ?? []).map(s3VectorToHit);
  }
}

export function createS3VectorStore(config: S3VectorStoreConfig): VectorStore {
  return new S3VectorStore(config);
}

export class FakeEmbedder implements Embedder {
  readonly embeddings: Map<string, number[]>;
  defaultEmbedding?: number[] | undefined;
  readonly calls: string[] = [];

  constructor(embeddings: Record<string, number[]> = {}) {
    this.embeddings = new Map(
      Object.entries(embeddings).map(([key, value]) => [
        key,
        cloneVector(value),
      ]),
    );
  }

  async embed(text: string): Promise<number[]> {
    const normalized = text.trim();
    if (!normalized) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_INVALID_INPUT,
        "vectorstore: embedding input is required",
      );
    }
    this.calls.push(normalized);
    const found = this.embeddings.get(normalized) ?? this.defaultEmbedding;
    if (!found) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_EMBEDDING_FAILED,
        "vectorstore: embedding not found",
      );
    }
    return cloneVector(found);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) out.push(await this.embed(text));
    return out;
  }
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

export class TitanEmbedder implements Embedder {
  private readonly client: BedrockRuntimeLike;
  readonly modelId: string;
  readonly dimensions: number;
  readonly normalize: boolean;

  constructor(config: TitanEmbedderConfig = {}) {
    this.client =
      config.client ??
      new BedrockRuntimeClient(config.region ? { region: config.region } : {});
    this.modelId = config.modelId?.trim() || DefaultTitanEmbedTextModelId;
    this.dimensions = config.dimensions ?? DefaultEmbeddingDimensions;
    this.normalize = config.normalize ?? true;
    validateDimension(this.dimensions);
  }

  async embed(text: string): Promise<number[]> {
    const normalized = text.trim();
    if (!normalized) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_INVALID_INPUT,
        "vectorstore: embedding input is required",
      );
    }
    const input: InvokeModelCommandInput = {
      modelId: this.modelId,
      contentType: "application/json",
      accept: "application/json",
      body: new TextEncoder().encode(
        JSON.stringify({
          inputText: normalized,
          dimensions: this.dimensions,
          normalize: this.normalize,
        }),
      ),
    };
    let output: InvokeModelCommandOutput;
    try {
      output = await this.client.send(new InvokeModelCommand(input));
    } catch (error) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_EMBEDDING_FAILED,
        "vectorstore: bedrock embedding request failed",
        error,
      );
    }
    const decoded = JSON.parse(new TextDecoder().decode(output.body)) as {
      embedding?: unknown;
    };
    const rawEmbedding = decoded.embedding;
    if (!Array.isArray(rawEmbedding) || rawEmbedding.length === 0) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_EMBEDDING_FAILED,
        "vectorstore: missing embedding in response",
      );
    }
    const embedding = rawEmbedding.map((value) => Number(value));
    validateVector(embedding, this.dimensions);
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) out.push(await this.embed(text));
    return out;
  }
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

export class SemanticIndex {
  private readonly store: VectorStore;
  private readonly embedder: Embedder;
  private readonly dimension: number;
  private readonly requiredMetadataKeys: string[];

  constructor(config: SemanticIndexConfig) {
    this.store = config.store;
    this.embedder = config.embedder;
    this.dimension = config.dimension;
    this.requiredMetadataKeys = config.requiredMetadataKeys ?? [];
    validateDimension(this.dimension);
  }

  async putText(records: SemanticRecord[]): Promise<void> {
    if (!records.length) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_INVALID_INPUT,
        "vectorstore: at least one semantic record is required",
      );
    }
    for (const record of records) {
      validateKey(record.key);
      if (!record.text.trim()) {
        throw new VectorStoreError(
          VECTORSTORE_ERROR_INVALID_INPUT,
          "vectorstore: semantic text is required",
        );
      }
      validateRequiredMetadata(record.metadata, this.requiredMetadataKeys);
    }
    const embeddings = await this.embedder.embedBatch(
      records.map((record) => record.text),
    );
    if (embeddings.length !== records.length) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_EMBEDDING_FAILED,
        "vectorstore: embedding count mismatch",
      );
    }
    await this.store.putVectors({
      records: records.map((record, index) => {
        validateVector(embeddings[index] ?? [], this.dimension);
        return {
          key: record.key,
          data: cloneVector(embeddings[index]),
          metadata: cloneMetadata(record.metadata),
        };
      }),
    });
  }

  async queryText(
    text: string,
    input: Omit<QueryVectorsInput, "vector"> = {},
  ): Promise<QueryHit[]> {
    if (!text.trim()) {
      throw new VectorStoreError(
        VECTORSTORE_ERROR_INVALID_INPUT,
        "vectorstore: query text is required",
      );
    }
    const vector = await this.embedder.embed(text);
    validateVector(vector, this.dimension);
    return this.store.queryVectors({ ...input, vector });
  }
}

function validateKey(key: string): void {
  if (!key || key !== key.trim()) {
    throw new VectorStoreError(
      VECTORSTORE_ERROR_INVALID_INPUT,
      "vectorstore: vector key is required",
    );
  }
}

function squaredDistance(a: readonly number[], b: readonly number[]): number {
  return a.reduce((total, value, index) => {
    const delta = value - (b[index] ?? 0);
    return total + delta * delta;
  }, 0);
}

function metadataMatches(
  metadata: Record<string, unknown> | undefined,
  filter: Record<string, unknown> | undefined,
): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  return Object.entries(filter).every(([key, expected]) =>
    metadataValueMatches(metadata?.[key], expected),
  );
}

function metadataValueMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return expected.some((value) => metadataValueMatches(actual, value));
  }
  if (Array.isArray(actual)) {
    return actual.some((value) => metadataValueMatches(value, expected));
  }
  return actual === expected;
}

function isBlankMetadataValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

function cloneRecord(record: VectorRecord): VectorRecord {
  return {
    key: record.key,
    data: cloneVector(record.data),
    ...(record.metadata ? { metadata: cloneMetadata(record.metadata) } : {}),
  };
}

function cloneRecords(records: readonly VectorRecord[]): VectorRecord[] {
  return records.map(cloneRecord);
}

function cloneCall(call: VectorStoreCall): VectorStoreCall {
  return {
    operation: call.operation,
    ...(call.keys ? { keys: Array.from(call.keys) } : {}),
    ...(call.records ? { records: cloneRecords(call.records) } : {}),
    ...(call.vector ? { vector: cloneVector(call.vector) } : {}),
    ...(call.topK !== undefined ? { topK: call.topK } : {}),
    ...(call.filter ? { filter: cloneMetadata(call.filter) } : {}),
    ...(call.returnMetadata !== undefined
      ? { returnMetadata: call.returnMetadata }
      : {}),
  };
}

function structuredCloneCompatible(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function s3VectorToRecord(raw: unknown): VectorRecord {
  const item = raw as {
    key?: string;
    data?: { float32?: number[] };
    metadata?: Record<string, unknown>;
  };
  return {
    key: item.key ?? "",
    data: cloneVector(item.data?.float32 ?? []),
    ...(item.metadata ? { metadata: cloneMetadata(item.metadata) } : {}),
  };
}

function s3VectorToHit(raw: unknown): QueryHit {
  const item = raw as {
    key?: string;
    distance?: number;
    metadata?: Record<string, unknown>;
  };
  return {
    key: item.key ?? "",
    distance: Number(item.distance ?? 0),
    ...(item.metadata ? { metadata: cloneMetadata(item.metadata) } : {}),
  };
}
