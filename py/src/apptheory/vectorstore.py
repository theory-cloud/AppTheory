"""AppTheory semantic vector-store and Bedrock embedding helpers."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

VECTORSTORE_ERROR_INVALID_CONFIG = "vectorstore.invalid_config"
VECTORSTORE_ERROR_INVALID_INPUT = "vectorstore.invalid_input"
VECTORSTORE_ERROR_INVALID_VECTOR = "vectorstore.invalid_vector"
VECTORSTORE_ERROR_DIMENSION_MISMATCH = "vectorstore.dimension_mismatch"
VECTORSTORE_ERROR_NOT_FOUND = "vectorstore.not_found"
VECTORSTORE_ERROR_UNSUPPORTED_OPERATION = "vectorstore.unsupported_operation"
VECTORSTORE_ERROR_EMBEDDING_FAILED = "vectorstore.embedding_failed"

EnvVectorBucketName = "APPTHEORY_VECTOR_BUCKET_NAME"
EnvVectorIndexName = "APPTHEORY_VECTOR_INDEX_NAME"
EnvVectorIndexArn = "APPTHEORY_VECTOR_INDEX_ARN"
EnvVectorDimension = "APPTHEORY_VECTOR_DIMENSION"
EnvEmbeddingProvider = "APPTHEORY_EMBEDDING_PROVIDER"
EnvEmbeddingModelId = "APPTHEORY_EMBEDDING_MODEL_ID"
EnvEmbeddingDimensions = "APPTHEORY_EMBEDDING_DIMENSIONS"
EnvEmbeddingNormalize = "APPTHEORY_EMBEDDING_NORMALIZE"
DefaultTitanEmbedTextModelId = "amazon.titan-embed-text-v2:0"
DefaultEmbeddingDimensions = 1024
DefaultQueryTopK = 12
MaxQueryTopK = 10_000
MaxPutDeleteBatchSize = 500

VectorStoreOperation = Literal["PutVectors", "GetVectors", "DeleteVectors", "QueryVectors"]


class VectorStoreError(Exception):
    """Portable vector-store error with a stable AppTheory code."""

    code: str
    message: str

    def __init__(self, code: str, message: str, cause: Exception | None = None) -> None:
        self.code = code
        self.message = message
        self.__cause__ = cause
        super().__init__(message)


@dataclass(frozen=True)
class VectorRecord:
    key: str
    data: list[float]
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class PutVectorsInput:
    records: list[VectorRecord]


@dataclass(frozen=True)
class GetVectorsInput:
    keys: list[str]
    return_metadata: bool = False


@dataclass(frozen=True)
class DeleteVectorsInput:
    keys: list[str]


@dataclass(frozen=True)
class QueryVectorsInput:
    vector: list[float]
    top_k: int = 0
    filter: dict[str, Any] | None = None
    return_metadata: bool = False


@dataclass(frozen=True)
class QueryHit:
    key: str
    distance: float
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class VectorStoreCall:
    operation: VectorStoreOperation
    keys: list[str] | None = None
    records: list[VectorRecord] | None = None
    vector: list[float] | None = None
    top_k: int = 0
    filter: dict[str, Any] | None = None
    return_metadata: bool = False


class VectorStore(Protocol):
    def put_vectors(self, input_: PutVectorsInput) -> None: ...

    def get_vectors(self, input_: GetVectorsInput) -> list[VectorRecord]: ...

    def delete_vectors(self, input_: DeleteVectorsInput) -> None: ...

    def query_vectors(self, input_: QueryVectorsInput) -> list[QueryHit]: ...


class Embedder(Protocol):
    def embed(self, text: str) -> list[float]: ...

    def embed_batch(self, texts: list[str]) -> list[list[float]]: ...


def validate_dimension(dimension: int) -> None:
    if not isinstance(dimension, int) or dimension <= 0:
        raise VectorStoreError(VECTORSTORE_ERROR_INVALID_CONFIG, "vectorstore: dimension must be positive")


def validate_vector(vector: list[float], dimension: int = 0) -> None:
    if not vector:
        raise VectorStoreError(VECTORSTORE_ERROR_INVALID_VECTOR, "vectorstore: vector is required")
    if dimension > 0 and len(vector) != dimension:
        raise VectorStoreError(
            VECTORSTORE_ERROR_DIMENSION_MISMATCH,
            f"vectorstore: vector dimension mismatch: got {len(vector)} want {dimension}",
        )
    if not all(math.isfinite(float(value)) for value in vector):
        raise VectorStoreError(VECTORSTORE_ERROR_INVALID_VECTOR, "vectorstore: vector values must be finite")


def normalize_top_k(top_k: int = 0) -> int:
    if top_k <= 0:
        return DefaultQueryTopK
    return min(int(top_k), MaxQueryTopK)


def validate_required_metadata(metadata: dict[str, Any] | None, required_keys: list[str] | None = None) -> None:
    for raw_key in required_keys or []:
        key = str(raw_key).strip()
        if not key:
            continue
        if metadata is None or _blank_metadata_value(metadata.get(key)):
            raise VectorStoreError(VECTORSTORE_ERROR_INVALID_INPUT, f"vectorstore: required metadata missing: {key}")


class FakeVectorStore:
    def __init__(self, dimension: int) -> None:
        validate_dimension(dimension)
        self.dimension = dimension
        self.required_metadata_keys: list[str] = []
        self._records: dict[str, VectorRecord] = {}
        self._calls: list[VectorStoreCall] = []
        self._failures: dict[VectorStoreOperation, Exception] = {}

    def set_error(self, operation: VectorStoreOperation, error: Exception | None) -> None:
        if error is None:
            self._failures.pop(operation, None)
        else:
            self._failures[operation] = error

    def calls(self) -> list[VectorStoreCall]:
        return [_clone_call(call) for call in self._calls]

    def put_vectors(self, input_: PutVectorsInput) -> None:
        if not input_.records:
            raise VectorStoreError(VECTORSTORE_ERROR_INVALID_INPUT, "vectorstore: at least one vector is required")
        if len(input_.records) > MaxPutDeleteBatchSize:
            raise VectorStoreError(VECTORSTORE_ERROR_INVALID_INPUT, "vectorstore: put batch exceeds 500 vectors")
        for record in input_.records:
            _validate_key(record.key)
            validate_vector(record.data, self.dimension)
            validate_required_metadata(record.metadata, self.required_metadata_keys)
        self._record(
            VectorStoreCall(operation="PutVectors", records=[_clone_record(record) for record in input_.records])
        )
        self._raise_failure("PutVectors")
        for record in input_.records:
            self._records[record.key] = _clone_record(record)

    def get_vectors(self, input_: GetVectorsInput) -> list[VectorRecord]:
        if not input_.keys:
            raise VectorStoreError(VECTORSTORE_ERROR_INVALID_INPUT, "vectorstore: at least one key is required")
        self._record(
            VectorStoreCall(
                operation="GetVectors",
                keys=list(input_.keys),
                return_metadata=input_.return_metadata,
            )
        )
        self._raise_failure("GetVectors")
        out: list[VectorRecord] = []
        for key in input_.keys:
            _validate_key(key)
            record = self._records.get(key)
            if record is None:
                raise VectorStoreError(VECTORSTORE_ERROR_NOT_FOUND, "vectorstore: vector not found")
            out.append(
                VectorRecord(
                    key=record.key,
                    data=list(record.data),
                    metadata=_clone_metadata(record.metadata) if input_.return_metadata else None,
                )
            )
        return out

    def delete_vectors(self, input_: DeleteVectorsInput) -> None:
        if not input_.keys:
            raise VectorStoreError(VECTORSTORE_ERROR_INVALID_INPUT, "vectorstore: at least one key is required")
        if len(input_.keys) > MaxPutDeleteBatchSize:
            raise VectorStoreError(VECTORSTORE_ERROR_INVALID_INPUT, "vectorstore: delete batch exceeds 500 vectors")
        for key in input_.keys:
            _validate_key(key)
        self._record(VectorStoreCall(operation="DeleteVectors", keys=list(input_.keys)))
        self._raise_failure("DeleteVectors")
        for key in input_.keys:
            self._records.pop(key, None)

    def query_vectors(self, input_: QueryVectorsInput) -> list[QueryHit]:
        validate_vector(input_.vector, self.dimension)
        top_k = normalize_top_k(input_.top_k)
        self._record(
            VectorStoreCall(
                operation="QueryVectors",
                vector=list(input_.vector),
                top_k=top_k,
                filter=_clone_metadata(input_.filter),
                return_metadata=input_.return_metadata,
            )
        )
        self._raise_failure("QueryVectors")
        hits = [
            QueryHit(
                key=record.key,
                distance=_squared_distance(input_.vector, record.data),
                metadata=_clone_metadata(record.metadata) if input_.return_metadata else None,
            )
            for record in self._records.values()
            if _metadata_matches(record.metadata, input_.filter)
        ]
        hits.sort(key=lambda hit: (hit.distance, hit.key))
        return hits[:top_k]

    def _record(self, call: VectorStoreCall) -> None:
        self._calls.append(_clone_call(call))

    def _raise_failure(self, operation: VectorStoreOperation) -> None:
        failure = self._failures.get(operation)
        if failure is not None:
            raise failure


def create_fake_vector_store(dimension: int) -> FakeVectorStore:
    return FakeVectorStore(dimension)


@dataclass(frozen=True)
class S3VectorStoreConfig:
    vector_bucket_name: str
    index_name: str
    dimension: int
    region_name: str | None = None
    client: Any | None = None
    max_batch_size: int = MaxPutDeleteBatchSize


class S3VectorStore:
    def __init__(self, config: S3VectorStoreConfig) -> None:
        self.vector_bucket_name = config.vector_bucket_name.strip()
        self.index_name = config.index_name.strip()
        self.dimension = config.dimension
        if not self.vector_bucket_name or not self.index_name:
            raise VectorStoreError(
                VECTORSTORE_ERROR_INVALID_CONFIG,
                "vectorstore: vector bucket and index name are required",
            )
        validate_dimension(self.dimension)
        self.max_batch_size = min(max(1, config.max_batch_size), MaxPutDeleteBatchSize)
        self.client = config.client or _load_s3vectors_client(config.region_name)

    def put_vectors(self, input_: PutVectorsInput) -> None:
        if not input_.records:
            raise VectorStoreError(VECTORSTORE_ERROR_INVALID_INPUT, "vectorstore: at least one vector is required")
        for start in range(0, len(input_.records), self.max_batch_size):
            records = input_.records[start : start + self.max_batch_size]
            vectors = []
            for record in records:
                _validate_key(record.key)
                validate_vector(record.data, self.dimension)
                item: dict[str, Any] = {"key": record.key, "data": {"float32": record.data}}
                if record.metadata:
                    item["metadata"] = record.metadata
                vectors.append(item)
            self.client.put_vectors(
                vectorBucketName=self.vector_bucket_name,
                indexName=self.index_name,
                vectors=vectors,
            )

    def get_vectors(self, input_: GetVectorsInput) -> list[VectorRecord]:
        if not input_.keys:
            raise VectorStoreError(VECTORSTORE_ERROR_INVALID_INPUT, "vectorstore: at least one key is required")
        for key in input_.keys:
            _validate_key(key)
        out = self.client.get_vectors(
            vectorBucketName=self.vector_bucket_name,
            indexName=self.index_name,
            keys=input_.keys,
            returnData=True,
            returnMetadata=input_.return_metadata,
        )
        return [_record_from_s3_vector(item) for item in out.get("vectors", [])]

    def delete_vectors(self, input_: DeleteVectorsInput) -> None:
        if not input_.keys:
            raise VectorStoreError(VECTORSTORE_ERROR_INVALID_INPUT, "vectorstore: at least one key is required")
        for key in input_.keys:
            _validate_key(key)
        for start in range(0, len(input_.keys), self.max_batch_size):
            self.client.delete_vectors(
                vectorBucketName=self.vector_bucket_name,
                indexName=self.index_name,
                keys=input_.keys[start : start + self.max_batch_size],
            )

    def query_vectors(self, input_: QueryVectorsInput) -> list[QueryHit]:
        validate_vector(input_.vector, self.dimension)
        request: dict[str, Any] = {
            "vectorBucketName": self.vector_bucket_name,
            "indexName": self.index_name,
            "queryVector": {"float32": input_.vector},
            "topK": normalize_top_k(input_.top_k),
            "returnDistance": True,
            "returnMetadata": input_.return_metadata,
        }
        if input_.filter:
            request["filter"] = input_.filter
        out = self.client.query_vectors(**request)
        return [_hit_from_s3_vector(item) for item in out.get("vectors", [])]


def create_s3_vector_store(config: S3VectorStoreConfig) -> VectorStore:
    return S3VectorStore(config)


class FakeEmbedder:
    def __init__(self, embeddings: dict[str, list[float]] | None = None) -> None:
        self.embeddings = {str(key): list(value) for key, value in (embeddings or {}).items()}
        self.default_embedding: list[float] | None = None
        self.calls: list[str] = []

    def embed(self, text: str) -> list[float]:
        normalized = text.strip()
        if not normalized:
            raise VectorStoreError(VECTORSTORE_ERROR_INVALID_INPUT, "vectorstore: embedding input is required")
        self.calls.append(normalized)
        vector = self.embeddings.get(normalized) or self.default_embedding
        if vector is None:
            raise VectorStoreError(VECTORSTORE_ERROR_EMBEDDING_FAILED, "vectorstore: embedding not found")
        return list(vector)

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        return [self.embed(text) for text in texts]


@dataclass(frozen=True)
class TitanEmbedderConfig:
    client: Any | None = None
    region_name: str | None = None
    model_id: str = DefaultTitanEmbedTextModelId
    dimensions: int = DefaultEmbeddingDimensions
    normalize: bool = True


class TitanEmbedder:
    def __init__(self, config: TitanEmbedderConfig | None = None) -> None:
        cfg = config or TitanEmbedderConfig()
        self.client = cfg.client or _load_bedrock_runtime_client(cfg.region_name)
        self.model_id = cfg.model_id.strip() or DefaultTitanEmbedTextModelId
        self.dimensions = cfg.dimensions
        self.normalize = cfg.normalize
        validate_dimension(self.dimensions)

    def embed(self, text: str) -> list[float]:
        normalized = text.strip()
        if not normalized:
            raise VectorStoreError(VECTORSTORE_ERROR_INVALID_INPUT, "vectorstore: embedding input is required")
        request = {
            "inputText": normalized,
            "dimensions": self.dimensions,
            "normalize": self.normalize,
        }
        try:
            out = self.client.invoke_model(
                modelId=self.model_id,
                contentType="application/json",
                accept="application/json",
                body=json.dumps(request).encode("utf-8"),
            )
        except Exception as exc:
            raise VectorStoreError(
                VECTORSTORE_ERROR_EMBEDDING_FAILED,
                "vectorstore: bedrock embedding request failed",
                exc,
            ) from exc
        body = out.get("body")
        if hasattr(body, "read"):
            body = body.read()
        decoded = json.loads(bytes(body).decode("utf-8") if isinstance(body, (bytes, bytearray)) else str(body))
        embedding = decoded.get("embedding")
        if not isinstance(embedding, list) or not embedding:
            raise VectorStoreError(VECTORSTORE_ERROR_EMBEDDING_FAILED, "vectorstore: missing embedding in response")
        vector = [float(value) for value in embedding]
        validate_vector(vector, self.dimensions)
        return vector

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        return [self.embed(text) for text in texts]


@dataclass(frozen=True)
class SemanticRecord:
    key: str
    text: str
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class SemanticIndexConfig:
    store: VectorStore
    embedder: Embedder
    dimension: int
    required_metadata_keys: list[str] = field(default_factory=list)


class SemanticIndex:
    def __init__(self, config: SemanticIndexConfig) -> None:
        self.store = config.store
        self.embedder = config.embedder
        self.dimension = config.dimension
        self.required_metadata_keys = list(config.required_metadata_keys)
        validate_dimension(self.dimension)

    def put_text(self, records: list[SemanticRecord]) -> None:
        if not records:
            raise VectorStoreError(
                VECTORSTORE_ERROR_INVALID_INPUT, "vectorstore: at least one semantic record is required"
            )
        for record in records:
            _validate_key(record.key)
            if not record.text.strip():
                raise VectorStoreError(VECTORSTORE_ERROR_INVALID_INPUT, "vectorstore: semantic text is required")
            validate_required_metadata(record.metadata, self.required_metadata_keys)
        embeddings = self.embedder.embed_batch([record.text for record in records])
        if len(embeddings) != len(records):
            raise VectorStoreError(VECTORSTORE_ERROR_EMBEDDING_FAILED, "vectorstore: embedding count mismatch")
        self.store.put_vectors(
            PutVectorsInput(
                records=[
                    VectorRecord(
                        key=record.key, data=list(embeddings[index]), metadata=_clone_metadata(record.metadata)
                    )
                    for index, record in enumerate(records)
                ]
            )
        )

    def query_text(
        self,
        text: str,
        *,
        top_k: int = 0,
        filter: dict[str, Any] | None = None,
        return_metadata: bool = False,
    ) -> list[QueryHit]:
        if not text.strip():
            raise VectorStoreError(VECTORSTORE_ERROR_INVALID_INPUT, "vectorstore: query text is required")
        vector = self.embedder.embed(text)
        validate_vector(vector, self.dimension)
        return self.store.query_vectors(
            QueryVectorsInput(vector=vector, top_k=top_k, filter=filter, return_metadata=return_metadata)
        )


def _validate_key(key: str) -> None:
    if not key or key != key.strip():
        raise VectorStoreError(VECTORSTORE_ERROR_INVALID_INPUT, "vectorstore: vector key is required")


def _blank_metadata_value(value: Any) -> bool:
    return (
        value is None
        or (isinstance(value, str) and value.strip() == "")
        or (isinstance(value, list) and len(value) == 0)
    )


def _clone_metadata(metadata: dict[str, Any] | None) -> dict[str, Any] | None:
    if not metadata:
        return None
    return json.loads(json.dumps(metadata))


def _clone_record(record: VectorRecord) -> VectorRecord:
    return VectorRecord(key=record.key, data=list(record.data), metadata=_clone_metadata(record.metadata))


def _clone_call(call: VectorStoreCall) -> VectorStoreCall:
    return VectorStoreCall(
        operation=call.operation,
        keys=list(call.keys) if call.keys is not None else None,
        records=[_clone_record(record) for record in call.records] if call.records is not None else None,
        vector=list(call.vector) if call.vector is not None else None,
        top_k=call.top_k,
        filter=_clone_metadata(call.filter),
        return_metadata=call.return_metadata,
    )


def _squared_distance(a: list[float], b: list[float]) -> float:
    return sum((float(value) - float(b[index])) ** 2 for index, value in enumerate(a))


def _metadata_matches(metadata: dict[str, Any] | None, filter_: dict[str, Any] | None) -> bool:
    if not filter_:
        return True
    return all(_metadata_value_matches((metadata or {}).get(key), expected) for key, expected in filter_.items())


def _metadata_value_matches(actual: Any, expected: Any) -> bool:
    if isinstance(expected, list):
        return any(_metadata_value_matches(actual, value) for value in expected)
    if isinstance(actual, list):
        return any(_metadata_value_matches(value, expected) for value in actual)
    return actual == expected


def _load_s3vectors_client(region_name: str | None) -> Any:
    try:
        import boto3  # type: ignore[import-not-found]
    except ModuleNotFoundError as exc:  # pragma: no cover
        raise VectorStoreError(
            VECTORSTORE_ERROR_INVALID_CONFIG,
            "vectorstore: boto3 is required for S3VectorStore",
            exc,
        ) from exc
    return boto3.client("s3vectors", region_name=region_name)


def _load_bedrock_runtime_client(region_name: str | None) -> Any:
    try:
        import boto3  # type: ignore[import-not-found]
    except ModuleNotFoundError as exc:  # pragma: no cover
        raise VectorStoreError(
            VECTORSTORE_ERROR_INVALID_CONFIG,
            "vectorstore: boto3 is required for TitanEmbedder",
            exc,
        ) from exc
    return boto3.client("bedrock-runtime", region_name=region_name)


def _record_from_s3_vector(item: dict[str, Any]) -> VectorRecord:
    return VectorRecord(
        key=str(item.get("key", "")),
        data=[float(value) for value in ((item.get("data") or {}).get("float32") or [])],
        metadata=_clone_metadata(item.get("metadata")),
    )


def _hit_from_s3_vector(item: dict[str, Any]) -> QueryHit:
    return QueryHit(
        key=str(item.get("key", "")),
        distance=float(item.get("distance") or 0),
        metadata=_clone_metadata(item.get("metadata")),
    )


__all__ = [
    "VECTORSTORE_ERROR_DIMENSION_MISMATCH",
    "VECTORSTORE_ERROR_EMBEDDING_FAILED",
    "VECTORSTORE_ERROR_INVALID_CONFIG",
    "VECTORSTORE_ERROR_INVALID_INPUT",
    "VECTORSTORE_ERROR_INVALID_VECTOR",
    "VECTORSTORE_ERROR_NOT_FOUND",
    "VECTORSTORE_ERROR_UNSUPPORTED_OPERATION",
    "DefaultEmbeddingDimensions",
    "DefaultQueryTopK",
    "DefaultTitanEmbedTextModelId",
    "DeleteVectorsInput",
    "Embedder",
    "EnvEmbeddingDimensions",
    "EnvEmbeddingModelId",
    "EnvEmbeddingNormalize",
    "EnvEmbeddingProvider",
    "EnvVectorBucketName",
    "EnvVectorDimension",
    "EnvVectorIndexArn",
    "EnvVectorIndexName",
    "FakeEmbedder",
    "FakeVectorStore",
    "GetVectorsInput",
    "MaxPutDeleteBatchSize",
    "MaxQueryTopK",
    "PutVectorsInput",
    "QueryHit",
    "QueryVectorsInput",
    "S3VectorStore",
    "S3VectorStoreConfig",
    "SemanticIndex",
    "SemanticIndexConfig",
    "SemanticRecord",
    "TitanEmbedder",
    "TitanEmbedderConfig",
    "VectorRecord",
    "VectorStore",
    "VectorStoreCall",
    "VectorStoreError",
    "VectorStoreOperation",
    "create_fake_vector_store",
    "create_s3_vector_store",
    "normalize_top_k",
    "validate_dimension",
    "validate_required_metadata",
    "validate_vector",
]
