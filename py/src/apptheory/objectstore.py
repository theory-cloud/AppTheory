"""Bounded object-store helpers for AppTheory."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol, cast

OBJECTSTORE_ERROR_INVALID_REF = "objectstore.invalid_ref"
OBJECTSTORE_ERROR_INVALID_GET_LIMIT = "objectstore.invalid_get_limit"
OBJECTSTORE_ERROR_OBJECT_TOO_LARGE = "objectstore.object_too_large"
OBJECTSTORE_ERROR_NOT_FOUND = "objectstore.not_found"
OBJECTSTORE_ERROR_INVALID_STORE_CONFIG = "objectstore.invalid_store_config"
OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG = "objectstore.invalid_encryption_config"
OBJECTSTORE_ERROR_UNSUPPORTED_OPERATION = "objectstore.unsupported_operation"

S3_ENCRYPTION_BUCKET_DEFAULT = "bucket-default"
S3_ENCRYPTION_S3_MANAGED = "s3-managed"
S3_ENCRYPTION_KMS = "kms"

S3EncryptionMode = Literal["bucket-default", "s3-managed", "kms"]
ObjectStoreOperation = Literal["Put", "Get", "Delete"]


class ObjectStoreError(Exception):
    """Stable object-store error with a portable code and message."""

    code: str
    message: str

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


@dataclass(frozen=True)
class ObjectRef:
    bucket: str
    key: str
    version_id: str = ""


@dataclass(frozen=True)
class ObjectStorePutInput:
    ref: ObjectRef
    payload: bytes = b""
    content_type: str = ""
    metadata: dict[str, str] | None = None


@dataclass(frozen=True)
class ObjectStoreGetInput:
    ref: ObjectRef
    max_bytes: int


@dataclass(frozen=True)
class ObjectStoreGetOutput:
    ref: ObjectRef
    payload: bytes
    content_type: str = ""
    metadata: dict[str, str] | None = None


@dataclass(frozen=True)
class ObjectStoreDeleteInput:
    ref: ObjectRef


@dataclass(frozen=True)
class ObjectStoreCall:
    operation: ObjectStoreOperation
    ref: ObjectRef
    max_bytes: int = 0
    content_type: str = ""
    metadata: dict[str, str] | None = None
    payload: bytes = b""


@dataclass(frozen=True)
class S3EncryptionConfig:
    mode: S3EncryptionMode | str = S3_ENCRYPTION_BUCKET_DEFAULT
    kms_key_id: str = ""


@dataclass(frozen=True)
class S3ObjectStoreConfig:
    region_name: str = ""
    encryption: S3EncryptionConfig | None = None


@dataclass(frozen=True)
class _StoredObject:
    ref: ObjectRef
    payload: bytes
    content_type: str = ""
    metadata: dict[str, str] | None = None


class ObjectStore(Protocol):
    def put(self, input_: ObjectStorePutInput) -> ObjectRef: ...

    def get(self, input_: ObjectStoreGetInput) -> ObjectStoreGetOutput: ...

    def delete(self, input_: ObjectStoreDeleteInput) -> None: ...


def parse_object_ref(raw: str) -> ObjectRef:
    if not raw or raw != raw.strip() or any(ch in raw for ch in "?#"):
        raise _invalid_object_ref()
    scheme = "s3://"
    if not raw.startswith(scheme):
        raise _invalid_object_ref()
    rest = raw[len(scheme) :]
    bucket, sep, key = rest.partition("/")
    if not sep:
        raise _invalid_object_ref()
    ref = ObjectRef(bucket=bucket, key=key)
    validate_object_ref(ref)
    return ref


def validate_object_ref(ref: ObjectRef) -> None:
    if not ref.bucket or not ref.key:
        raise _invalid_object_ref()
    if "/" in ref.bucket or any(ch in ref.bucket for ch in "?#"):
        raise _invalid_object_ref()
    if any(ch in ref.key for ch in "?#") or any(ch in ref.version_id for ch in "?#"):
        raise _invalid_object_ref()
    if _contains_control_or_space(ref.bucket) or _contains_control(ref.key) or _contains_control(ref.version_id):
        raise _invalid_object_ref()


def create_fake_object_store() -> FakeObjectStore:
    return FakeObjectStore()


def create_s3_object_store(config: S3ObjectStoreConfig | None = None) -> ObjectStore:
    normalized = config or S3ObjectStoreConfig()
    return _S3ObjectStore(_load_s3_client(normalized.region_name), normalized)


def unsupported_object_store_operation(operation: str) -> None:
    raise ObjectStoreError(
        OBJECTSTORE_ERROR_UNSUPPORTED_OPERATION,
        f"objectstore: unsupported operation: {operation}",
    )


class FakeObjectStore:
    def __init__(self) -> None:
        self._seq = 0
        self._latest: dict[tuple[str, str], str] = {}
        self._objects: dict[tuple[str, str, str], _StoredObject] = {}
        self._calls: list[ObjectStoreCall] = []
        self._failures: dict[ObjectStoreOperation, Exception] = {}

    def set_error(self, operation: ObjectStoreOperation, error: Exception | None) -> None:
        if error is None:
            self._failures.pop(operation, None)
            return
        self._failures[operation] = error

    def calls(self) -> list[ObjectStoreCall]:
        return [_clone_call(call) for call in self._calls]

    def put(self, input_: ObjectStorePutInput) -> ObjectRef:
        _validate_put_input(input_)
        self._record(
            ObjectStoreCall(
                operation="Put",
                ref=input_.ref,
                payload=bytes(input_.payload),
                content_type=input_.content_type,
                metadata=_clone_metadata(input_.metadata),
            )
        )
        self._raise_failure("Put")

        self._seq += 1
        ref = ObjectRef(input_.ref.bucket, input_.ref.key, f"v{self._seq:020d}")
        name = (ref.bucket, ref.key)
        self._latest[name] = ref.version_id
        self._objects[(ref.bucket, ref.key, ref.version_id)] = _StoredObject(
            ref=ref,
            payload=bytes(input_.payload),
            content_type=input_.content_type,
            metadata=_clone_metadata(input_.metadata),
        )
        return ref

    def get(self, input_: ObjectStoreGetInput) -> ObjectStoreGetOutput:
        _validate_get_input(input_)
        self._record(ObjectStoreCall(operation="Get", ref=input_.ref, max_bytes=input_.max_bytes))
        self._raise_failure("Get")

        obj = self._object(input_.ref)
        if obj is None:
            raise ObjectStoreError(OBJECTSTORE_ERROR_NOT_FOUND, "objectstore: object not found")
        if len(obj.payload) > input_.max_bytes:
            raise ObjectStoreError(OBJECTSTORE_ERROR_OBJECT_TOO_LARGE, "objectstore: object exceeds max bytes")
        return ObjectStoreGetOutput(
            ref=obj.ref,
            payload=bytes(obj.payload),
            content_type=obj.content_type,
            metadata=_clone_metadata(obj.metadata),
        )

    def delete(self, input_: ObjectStoreDeleteInput) -> None:
        _validate_delete_input(input_)
        self._record(ObjectStoreCall(operation="Delete", ref=input_.ref))
        self._raise_failure("Delete")

        name = (input_.ref.bucket, input_.ref.key)
        if not input_.ref.version_id:
            self._latest.pop(name, None)
            for key in list(self._objects):
                if key[:2] == name:
                    self._objects.pop(key, None)
            return

        self._objects.pop((input_.ref.bucket, input_.ref.key, input_.ref.version_id), None)
        if self._latest.get(name) == input_.ref.version_id:
            self._latest.pop(name, None)

    def _object(self, ref: ObjectRef) -> _StoredObject | None:
        version = ref.version_id or self._latest.get((ref.bucket, ref.key), "")
        if not version:
            return None
        return self._objects.get((ref.bucket, ref.key, version))

    def _record(self, call: ObjectStoreCall) -> None:
        self._calls.append(_clone_call(call))

    def _raise_failure(self, operation: ObjectStoreOperation) -> None:
        failure = self._failures.get(operation)
        if failure is not None:
            raise failure


class _S3ObjectStore:
    def __init__(self, client: Any, config: S3ObjectStoreConfig) -> None:
        if client is None:
            raise ObjectStoreError(OBJECTSTORE_ERROR_INVALID_STORE_CONFIG, "objectstore: invalid store config")
        self._client = client
        self._encryption = _normalize_s3_encryption(config.encryption or S3EncryptionConfig())

    def put(self, input_: ObjectStorePutInput) -> ObjectRef:
        _validate_put_input(input_)
        kwargs: dict[str, Any] = {
            "Bucket": input_.ref.bucket,
            "Key": input_.ref.key,
            "Body": bytes(input_.payload),
        }
        if input_.content_type:
            kwargs["ContentType"] = input_.content_type
        if input_.metadata:
            kwargs["Metadata"] = _clone_metadata(input_.metadata)
        _apply_s3_encryption(kwargs, self._encryption)
        output = cast(dict[str, Any], self._client.put_object(**kwargs) or {})
        return ObjectRef(input_.ref.bucket, input_.ref.key, str(output.get("VersionId") or ""))

    def get(self, input_: ObjectStoreGetInput) -> ObjectStoreGetOutput:
        _validate_get_input(input_)
        kwargs: dict[str, Any] = {"Bucket": input_.ref.bucket, "Key": input_.ref.key}
        if input_.ref.version_id:
            kwargs["VersionId"] = input_.ref.version_id
        output = cast(dict[str, Any], self._client.get_object(**kwargs) or {})
        if "Body" not in output:
            raise ObjectStoreError(OBJECTSTORE_ERROR_INVALID_STORE_CONFIG, "objectstore: invalid store config")
        payload = _read_s3_body_bounded(output["Body"], input_.max_bytes)
        return ObjectStoreGetOutput(
            ref=ObjectRef(input_.ref.bucket, input_.ref.key, str(output.get("VersionId") or input_.ref.version_id)),
            payload=payload,
            content_type=str(output.get("ContentType") or ""),
            metadata=_clone_metadata(cast(dict[str, str] | None, output.get("Metadata"))),
        )

    def delete(self, input_: ObjectStoreDeleteInput) -> None:
        _validate_delete_input(input_)
        kwargs: dict[str, Any] = {"Bucket": input_.ref.bucket, "Key": input_.ref.key}
        if input_.ref.version_id:
            kwargs["VersionId"] = input_.ref.version_id
        self._client.delete_object(**kwargs)


def _validate_put_input(input_: ObjectStorePutInput) -> None:
    validate_object_ref(input_.ref)
    if input_.ref.version_id:
        raise _invalid_object_ref()


def _validate_get_input(input_: ObjectStoreGetInput) -> None:
    validate_object_ref(input_.ref)
    if input_.max_bytes <= 0:
        raise ObjectStoreError(OBJECTSTORE_ERROR_INVALID_GET_LIMIT, "objectstore: max bytes must be positive")


def _validate_delete_input(input_: ObjectStoreDeleteInput) -> None:
    validate_object_ref(input_.ref)


def _invalid_object_ref() -> ObjectStoreError:
    return ObjectStoreError(OBJECTSTORE_ERROR_INVALID_REF, "objectstore: invalid object ref")


def _contains_control(value: str) -> bool:
    return any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value)


def _contains_control_or_space(value: str) -> bool:
    return any(ord(ch) < 0x20 or ord(ch) == 0x7F or ch.isspace() for ch in value)


def _clone_metadata(metadata: dict[str, str] | None) -> dict[str, str] | None:
    if metadata is None:
        return None
    return {key: str(metadata[key]) for key in sorted(metadata)}


def _clone_call(call: ObjectStoreCall) -> ObjectStoreCall:
    return ObjectStoreCall(
        operation=call.operation,
        ref=call.ref,
        max_bytes=call.max_bytes,
        content_type=call.content_type,
        metadata=_clone_metadata(call.metadata),
        payload=bytes(call.payload),
    )


def _normalize_s3_encryption(config: S3EncryptionConfig) -> S3EncryptionConfig:
    mode = config.mode or S3_ENCRYPTION_BUCKET_DEFAULT
    kms_key_id = config.kms_key_id or ""
    if kms_key_id != kms_key_id.strip():
        raise _invalid_encryption_config()
    if mode == S3_ENCRYPTION_KMS:
        if not kms_key_id:
            raise _invalid_encryption_config()
        return S3EncryptionConfig(mode=S3_ENCRYPTION_KMS, kms_key_id=kms_key_id)
    if mode in (S3_ENCRYPTION_BUCKET_DEFAULT, S3_ENCRYPTION_S3_MANAGED):
        if kms_key_id:
            raise _invalid_encryption_config()
        return S3EncryptionConfig(mode=cast(S3EncryptionMode, mode), kms_key_id="")
    raise _invalid_encryption_config()


def _invalid_encryption_config() -> ObjectStoreError:
    return ObjectStoreError(OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG, "objectstore: invalid encryption config")


def _apply_s3_encryption(kwargs: dict[str, Any], config: S3EncryptionConfig) -> None:
    if config.mode == S3_ENCRYPTION_S3_MANAGED:
        kwargs["ServerSideEncryption"] = "AES256"
    if config.mode == S3_ENCRYPTION_KMS:
        kwargs["ServerSideEncryption"] = "aws:kms"
        kwargs["SSEKMSKeyId"] = config.kms_key_id


def _read_s3_body_bounded(body: Any, max_bytes: int) -> bytes:
    if isinstance(body, bytes | bytearray | memoryview):
        payload = bytes(body)
    elif hasattr(body, "read") and callable(body.read):
        payload = bytes(cast(Any, body.read(max_bytes + 1)))
    else:
        raise ObjectStoreError(OBJECTSTORE_ERROR_INVALID_STORE_CONFIG, "objectstore: invalid store config")
    try:
        close = getattr(body, "close", None)
        if callable(close):
            close()
    finally:
        if len(payload) > max_bytes:
            raise ObjectStoreError(OBJECTSTORE_ERROR_OBJECT_TOO_LARGE, "objectstore: object exceeds max bytes")
    return payload


def _load_s3_client(region_name: str) -> Any:
    try:
        import boto3  # type: ignore[import-not-found]

        kwargs = {"region_name": region_name} if region_name else {}
        client = boto3.client("s3", **kwargs)
        if not all(callable(getattr(client, method, None)) for method in ("put_object", "get_object", "delete_object")):
            raise RuntimeError("s3 methods unavailable")
        return client
    except Exception:  # noqa: BLE001
        raise ObjectStoreError(
            OBJECTSTORE_ERROR_INVALID_STORE_CONFIG,
            "objectstore: S3 client requires boto3 with put/get/delete support",
        ) from None


__all__ = [
    "OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG",
    "OBJECTSTORE_ERROR_INVALID_GET_LIMIT",
    "OBJECTSTORE_ERROR_INVALID_REF",
    "OBJECTSTORE_ERROR_INVALID_STORE_CONFIG",
    "OBJECTSTORE_ERROR_NOT_FOUND",
    "OBJECTSTORE_ERROR_OBJECT_TOO_LARGE",
    "OBJECTSTORE_ERROR_UNSUPPORTED_OPERATION",
    "S3_ENCRYPTION_BUCKET_DEFAULT",
    "S3_ENCRYPTION_KMS",
    "S3_ENCRYPTION_S3_MANAGED",
    "FakeObjectStore",
    "ObjectRef",
    "ObjectStore",
    "ObjectStoreCall",
    "ObjectStoreDeleteInput",
    "ObjectStoreError",
    "ObjectStoreGetInput",
    "ObjectStoreGetOutput",
    "ObjectStoreOperation",
    "ObjectStorePutInput",
    "S3EncryptionConfig",
    "S3EncryptionMode",
    "S3ObjectStoreConfig",
    "create_fake_object_store",
    "create_s3_object_store",
    "parse_object_ref",
    "unsupported_object_store_operation",
    "validate_object_ref",
]
