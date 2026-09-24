"""Bounded object-store helpers for AppTheory."""

from __future__ import annotations

import base64
import datetime as dt
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, Protocol, cast
from urllib.parse import parse_qs, urlparse

OBJECTSTORE_ERROR_INVALID_REF = "objectstore.invalid_ref"
OBJECTSTORE_ERROR_INVALID_GET_LIMIT = "objectstore.invalid_get_limit"
OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT = "objectstore.invalid_presign_put"
OBJECTSTORE_ERROR_OBJECT_TOO_LARGE = "objectstore.object_too_large"
OBJECTSTORE_ERROR_NOT_FOUND = "objectstore.not_found"
OBJECTSTORE_ERROR_INVALID_STORE_CONFIG = "objectstore.invalid_store_config"
OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG = "objectstore.invalid_encryption_config"
OBJECTSTORE_ERROR_UNSUPPORTED_OPERATION = "objectstore.unsupported_operation"

MAX_PRESIGN_PUT_EXPIRES_IN = 900

S3_ENCRYPTION_BUCKET_DEFAULT = "bucket-default"
S3_ENCRYPTION_S3_MANAGED = "s3-managed"
S3_ENCRYPTION_KMS = "kms"

S3EncryptionMode = Literal["bucket-default", "s3-managed", "kms"]
ObjectStoreOperation = Literal["Put", "Get", "Delete", "PresignPut"]

_PRESIGN_PUT_METHOD = "PUT"
_PRESIGN_PUT_HEADER_CONTENT_LENGTH = "content-length"
_PRESIGN_PUT_HEADER_CONTENT_TYPE = "content-type"
_PRESIGN_PUT_HEADER_CHECKSUM = "x-amz-checksum-sha256"
_PRESIGN_PUT_SIGNED_HEADERS_PARAM = "X-Amz-SignedHeaders"
_PRESIGN_PUT_EXPIRES_PARAM = "X-Amz-Expires"

_PRESIGN_PUT_REQUIRED_HEADERS = (
    _PRESIGN_PUT_HEADER_CONTENT_LENGTH,
    _PRESIGN_PUT_HEADER_CONTENT_TYPE,
    _PRESIGN_PUT_HEADER_CHECKSUM,
)

_PRESIGN_PUT_ENCODED_SHA256_LENGTH = 44
_PRESIGN_PUT_SHA256_SIZE = 32
_PRESIGN_PUT_BASE64_ALPHABET = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")

_FAKE_PRESIGN_PUT_BASE_URL = "https://objectstore.fake"
_FAKE_PRESIGN_PUT_ALGORITHM = "AWS4-HMAC-SHA256"
_FAKE_PRESIGN_PUT_CREDENTIAL = "apptheory-fake"
_FAKE_PRESIGN_PUT_SIGNATURE = "fake"
_FAKE_PRESIGN_PUT_SIGNED_HEADERS = "content-length;content-type;host;x-amz-checksum-sha256"
_FAKE_PRESIGN_PUT_UNRESERVED = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~")
_FAKE_PRESIGN_PUT_DEFAULT_INSTANT = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)


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
class ObjectStorePresignPutInput:
    """One bounded upload-grant request: exact ref, declared bytes, expiry ceiling."""

    ref: ObjectRef
    content_length: int
    checksum_sha256: str
    content_type: str
    max_bytes: int
    expires_in: int


@dataclass(frozen=True)
class ObjectStorePresignPutOutput:
    """A bounded upload grant. ``headers`` are exactly the headers the client must send."""

    ref: ObjectRef
    url: str
    method: str
    headers: dict[str, str]
    expires_at: dt.datetime


@dataclass(frozen=True)
class ObjectStoreCall:
    operation: ObjectStoreOperation
    ref: ObjectRef
    max_bytes: int = 0
    content_length: int = 0
    checksum_sha256: str = ""
    expires_in: int = 0
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


class ObjectStoreUploadGranter(Protocol):
    """Bounded upload-grant capability, deliberately separate from ``ObjectStore``.

    The method here can only mint a single PUT grant whose signed headers carry the declared
    content length, content type and SHA-256 checksum, for at most ``MAX_PRESIGN_PUT_EXPIRES_IN``.
    Presigned GET, presigning without a checksum, list, multipart, copy, head, public URLs and raw
    clients have no method here and none on ``ObjectStore``.
    """

    def presign_put(self, input_: ObjectStorePresignPutInput) -> ObjectStorePresignPutOutput: ...


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


def validate_presign_put_input(input_: ObjectStorePresignPutInput) -> None:
    """Verify an upload-grant request is complete and safe, failing closed on every doubt.

    An unversioned exact reference, a positive content length no larger than ``max_bytes``, a
    non-empty unpadded content type, the canonical base64 SHA-256 digest, and an expiry above zero
    and at most ``MAX_PRESIGN_PUT_EXPIRES_IN``.
    """
    validate_object_ref(input_.ref)
    if input_.ref.version_id:
        raise _invalid_object_ref()
    if input_.content_length <= 0 or input_.max_bytes <= 0 or input_.content_length > input_.max_bytes:
        raise _invalid_presign_put()
    if not _valid_presign_put_content_type(input_.content_type):
        raise _invalid_presign_put()
    if not _valid_presign_put_checksum(input_.checksum_sha256):
        raise _invalid_presign_put()
    if input_.expires_in <= 0 or input_.expires_in > MAX_PRESIGN_PUT_EXPIRES_IN:
        raise _invalid_presign_put()


def _valid_presign_put_content_type(content_type: str) -> bool:
    if not content_type or content_type != content_type.strip():
        return False
    return not _contains_control(content_type)


def _valid_presign_put_checksum(checksum: str) -> bool:
    """Accept only the canonical base64 encoding of a 32-byte digest.

    The explicit length, alphabet, padding and round-trip checks keep the runtimes identical:
    ``base64.b64decode`` is tolerant of non-canonical padding bits.
    """
    if len(checksum) != _PRESIGN_PUT_ENCODED_SHA256_LENGTH or not checksum.endswith("="):
        return False
    if any(ch not in _PRESIGN_PUT_BASE64_ALPHABET for ch in checksum[:-1]):
        return False
    try:
        decoded = base64.b64decode(checksum, validate=True)
    except ValueError:
        return False
    if len(decoded) != _PRESIGN_PUT_SHA256_SIZE:
        return False
    return base64.b64encode(decoded).decode("ascii") == checksum


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
        self._clock: Callable[[], dt.datetime] | None = None

    def set_error(self, operation: ObjectStoreOperation, error: Exception | None) -> None:
        if error is None:
            self._failures.pop(operation, None)
            return
        self._failures[operation] = error

    def set_clock(self, now: Callable[[], dt.datetime] | None) -> None:
        """Inject the grant clock. ``None`` restores the fixed default instant."""
        self._clock = now

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

    def presign_put(self, input_: ObjectStorePresignPutInput) -> ObjectStorePresignPutOutput:
        """Mint a deterministic fake upload grant.

        The URL encodes the signed constraints instead of hashing them, so tests assert the exact
        grant without AWS. A real S3 store additionally signs the request host; the fake signs it
        too, which keeps the signed-header set identical between fake and real.
        """
        validate_presign_put_input(input_)
        expires_in = int(input_.expires_in)
        self._record(
            ObjectStoreCall(
                operation="PresignPut",
                ref=input_.ref,
                max_bytes=input_.max_bytes,
                content_length=input_.content_length,
                checksum_sha256=input_.checksum_sha256,
                expires_in=expires_in,
                content_type=input_.content_type,
            )
        )
        self._raise_failure("PresignPut")

        now = self._now()
        return ObjectStorePresignPutOutput(
            ref=input_.ref,
            url=_fake_presign_put_url(input_, now, expires_in),
            method=_PRESIGN_PUT_METHOD,
            headers=_presign_put_headers(input_),
            expires_at=now + dt.timedelta(seconds=expires_in),
        )

    def _now(self) -> dt.datetime:
        if self._clock is None:
            return _FAKE_PRESIGN_PUT_DEFAULT_INSTANT
        return _as_utc(self._clock())

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

    def presign_put(self, input_: ObjectStorePresignPutInput) -> ObjectStorePresignPutOutput:
        """Mint one bounded upload grant for an exact object reference.

        The grant signs the declared content length, content type and SHA-256 checksum, so S3
        rejects any other bytes, and it never outlives ``MAX_PRESIGN_PUT_EXPIRES_IN``. No
        server-side encryption header is attached: the upload is the client's own request against
        the one bucket, which owns its default encryption policy.
        """
        validate_presign_put_input(input_)
        generate = getattr(self._client, "generate_presigned_url", None)
        if not callable(generate):
            raise _invalid_store_config()
        raw_url = generate(
            "put_object",
            Params={
                "Bucket": input_.ref.bucket,
                "Key": input_.ref.key,
                "ContentLength": input_.content_length,
                "ContentType": input_.content_type,
                "ChecksumSHA256": input_.checksum_sha256,
            },
            ExpiresIn=input_.expires_in,
        )
        _verify_presign_put_url(str(raw_url or ""), input_.expires_in)
        return ObjectStorePresignPutOutput(
            ref=input_.ref,
            url=str(raw_url),
            method=_PRESIGN_PUT_METHOD,
            headers=_presign_put_headers(input_),
            expires_at=dt.datetime.now(dt.UTC) + dt.timedelta(seconds=input_.expires_in),
        )


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


def _invalid_presign_put() -> ObjectStoreError:
    return ObjectStoreError(OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT, "objectstore: invalid presign put")


def _invalid_store_config() -> ObjectStoreError:
    return ObjectStoreError(OBJECTSTORE_ERROR_INVALID_STORE_CONFIG, "objectstore: invalid store config")


def _presign_put_headers(input_: ObjectStorePresignPutInput) -> dict[str, str]:
    return {
        _PRESIGN_PUT_HEADER_CONTENT_LENGTH: str(input_.content_length),
        _PRESIGN_PUT_HEADER_CONTENT_TYPE: input_.content_type,
        _PRESIGN_PUT_HEADER_CHECKSUM: input_.checksum_sha256,
    }


def _as_utc(value: dt.datetime) -> dt.datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=dt.UTC)
    return value.astimezone(dt.UTC)


def _fake_presign_put_url(input_: ObjectStorePresignPutInput, now: dt.datetime, expires_in: int) -> str:
    parameters = [
        _fake_query_parameter("X-Amz-Algorithm", _FAKE_PRESIGN_PUT_ALGORITHM),
        _fake_query_parameter("X-Amz-Credential", _FAKE_PRESIGN_PUT_CREDENTIAL),
        _fake_query_parameter("X-Amz-Date", now.strftime("%Y%m%dT%H%M%SZ")),
        _fake_query_parameter("X-Amz-Expires", str(expires_in)),
        _fake_query_parameter("X-Amz-Signature", _FAKE_PRESIGN_PUT_SIGNATURE),
        _fake_query_parameter("X-Amz-SignedHeaders", _FAKE_PRESIGN_PUT_SIGNED_HEADERS),
        _fake_query_parameter(_PRESIGN_PUT_HEADER_CHECKSUM, input_.checksum_sha256),
        _fake_query_parameter("x-amz-content-length", str(input_.content_length)),
        _fake_query_parameter("x-amz-content-type", input_.content_type),
    ]
    bucket = _fake_percent_encode(input_.ref.bucket, keep_slash=True)
    key = _fake_percent_encode(input_.ref.key, keep_slash=True)
    return f"{_FAKE_PRESIGN_PUT_BASE_URL}/{bucket}/{key}?{'&'.join(parameters)}"


def _fake_query_parameter(name: str, value: str) -> str:
    return f"{name}={_fake_percent_encode(value, keep_slash=False)}"


def _fake_percent_encode(value: str, *, keep_slash: bool) -> str:
    """Escape every byte outside the RFC 3986 unreserved set, using uppercase hex.

    Path segments additionally keep ``/`` literal. All three runtimes share this rule byte-for-byte.
    """
    out: list[str] = []
    for byte in value.encode("utf-8"):
        if byte in _FAKE_PRESIGN_PUT_UNRESERVED or (keep_slash and byte == 0x2F):
            out.append(chr(byte))
            continue
        out.append(f"%{byte:02X}")
    return "".join(out)


def _verify_presign_put_url(raw_url: str, requested_expires_in: int) -> None:
    """Enforce the grant's post-condition on a presigned URL, failing closed on any doubt.

    A URL is only accepted when the constraint headers really are signed headers and are not
    hoisted into unsigned query parameters, and when the embedded expiry cannot outlive the
    requested one. Anything else is a misconfigured signer.
    """
    try:
        parsed = urlparse(raw_url)
    except ValueError:
        raise _invalid_store_config() from None
    query = parse_qs(parsed.query, keep_blank_values=True)
    if not query:
        raise _invalid_store_config()

    signed_raw = _presign_query_value(query, _PRESIGN_PUT_SIGNED_HEADERS_PARAM)
    if signed_raw is None:
        raise _invalid_store_config()
    signed = {name.strip() for name in signed_raw.lower().split(";")}
    for required in _PRESIGN_PUT_REQUIRED_HEADERS:
        if required not in signed:
            raise _invalid_store_config()
        if _presign_query_value(query, required) is not None:
            raise _invalid_store_config()

    expires_raw = _presign_query_value(query, _PRESIGN_PUT_EXPIRES_PARAM)
    if expires_raw is None:
        raise _invalid_store_config()
    try:
        expires_seconds = int(expires_raw)
    except ValueError:
        raise _invalid_store_config() from None
    if expires_seconds <= 0 or expires_seconds > MAX_PRESIGN_PUT_EXPIRES_IN:
        raise _invalid_store_config()
    if requested_expires_in > 0 and expires_seconds > requested_expires_in:
        raise _invalid_store_config()


def _presign_query_value(query: dict[str, list[str]], name: str) -> str | None:
    for key, values in query.items():
        if key.lower() != name.lower() or not values:
            continue
        return values[0]
    return None


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
        content_length=call.content_length,
        checksum_sha256=call.checksum_sha256,
        expires_in=call.expires_in,
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
        from botocore.config import Config  # type: ignore[import-not-found]

        kwargs: dict[str, Any] = {"region_name": region_name} if region_name else {}
        # botocore's bundled S3 model declares signatureVersion "s3", which presigns with SigV2 and
        # signs neither content-length nor the checksum header. Pin s3v4 so the post-condition can
        # hold; _verify_presign_put_url still refuses anything a misconfigured client returns.
        kwargs["config"] = Config(signature_version="s3v4")
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
    "MAX_PRESIGN_PUT_EXPIRES_IN",
    "OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG",
    "OBJECTSTORE_ERROR_INVALID_GET_LIMIT",
    "OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT",
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
    "ObjectStorePresignPutInput",
    "ObjectStorePresignPutOutput",
    "ObjectStorePutInput",
    "ObjectStoreUploadGranter",
    "S3EncryptionConfig",
    "S3EncryptionMode",
    "S3ObjectStoreConfig",
    "create_fake_object_store",
    "create_s3_object_store",
    "parse_object_ref",
    "unsupported_object_store_operation",
    "validate_object_ref",
    "validate_presign_put_input",
]
