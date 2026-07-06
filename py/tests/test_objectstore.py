from __future__ import annotations

import sys
import types
import unittest
from contextlib import contextmanager
from typing import Any, Iterator

import apptheory


class _Body:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.read_limit = 0
        self.closed = False

    def read(self, limit: int) -> bytes:
        self.read_limit = limit
        return self.payload[:limit]

    def close(self) -> None:
        self.closed = True


class _FakeS3Client:
    def __init__(self, body: bytes = b"payload") -> None:
        self.body = body
        self.last_body: _Body | None = None
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def put_object(self, **kwargs: Any) -> dict[str, str]:
        self.calls.append(("put", dict(kwargs)))
        return {"VersionId": "v-s3-1"}

    def get_object(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("get", dict(kwargs)))
        self.last_body = _Body(self.body)
        return {
            "Body": self.last_body,
            "VersionId": "v-s3-2",
            "ContentType": "text/plain",
            "Metadata": {"z": "last", "a": "first"},
        }

    def delete_object(self, **kwargs: Any) -> dict[str, str]:
        self.calls.append(("delete", dict(kwargs)))
        return {}


@contextmanager
def _fake_boto3(client: _FakeS3Client, test_case: unittest.TestCase) -> Iterator[None]:
    fake_boto3 = types.ModuleType("boto3")

    def factory(service_name: str, **kwargs: Any) -> _FakeS3Client:
        test_case.assertEqual(service_name, "s3")
        test_case.assertEqual(kwargs, {"region_name": "us-east-1"})
        return client

    fake_boto3.client = factory  # type: ignore[attr-defined]
    previous = sys.modules.get("boto3")
    sys.modules["boto3"] = fake_boto3
    try:
        yield
    finally:
        if previous is None:
            sys.modules.pop("boto3", None)
        else:
            sys.modules["boto3"] = previous


class ObjectStoreTests(unittest.TestCase):
    def assert_object_store_error(self, code: str, exc: BaseException) -> None:
        self.assertIsInstance(exc, apptheory.ObjectStoreError)
        self.assertEqual(getattr(exc, "code", ""), code)

    def test_parse_object_ref_is_strict(self) -> None:
        ref = apptheory.parse_object_ref("s3://bucket-a/prefix/object.json")
        self.assertEqual(ref, apptheory.ObjectRef(bucket="bucket-a", key="prefix/object.json"))

        invalid_refs = [
            "",
            " s3://bucket-a/object.json",
            "https://bucket-a/object.json",
            "s3://bucket-a/",
            "s3://bucket a/object.json",
            "s3://bucket-a/object.json?versionId=1",
            "s3://bucket-a/object.json#fragment",
        ]
        for raw in invalid_refs:
            with self.subTest(raw=raw), self.assertRaises(apptheory.ObjectStoreError) as ctx:
                apptheory.parse_object_ref(raw)
            self.assert_object_store_error(apptheory.OBJECTSTORE_ERROR_INVALID_REF, ctx.exception)

    def test_fake_store_put_bounded_get_delete_and_calls_are_copied(self) -> None:
        fake = apptheory.create_fake_object_store()
        stored = fake.put(
            apptheory.ObjectStorePutInput(
                ref=apptheory.ObjectRef(bucket="bucket-a", key="objects/alpha.txt"),
                payload=b"hello objectstore",
                content_type="text/plain",
                metadata={"sha256": "abc"},
            )
        )
        self.assertEqual(stored.version_id, "v00000000000000000001")

        with self.assertRaises(apptheory.ObjectStoreError) as too_large:
            fake.get(apptheory.ObjectStoreGetInput(ref=stored, max_bytes=5))
        self.assert_object_store_error(apptheory.OBJECTSTORE_ERROR_OBJECT_TOO_LARGE, too_large.exception)

        got = fake.get(apptheory.ObjectStoreGetInput(ref=stored, max_bytes=64))
        self.assertEqual(got.ref, stored)
        self.assertEqual(got.payload, b"hello objectstore")
        self.assertEqual(got.content_type, "text/plain")
        self.assertEqual(got.metadata, {"sha256": "abc"})

        fake.delete(
            apptheory.ObjectStoreDeleteInput(ref=apptheory.ObjectRef(bucket="bucket-a", key="objects/alpha.txt"))
        )
        with self.assertRaises(apptheory.ObjectStoreError) as missing:
            fake.get(apptheory.ObjectStoreGetInput(ref=stored, max_bytes=64))
        self.assert_object_store_error(apptheory.OBJECTSTORE_ERROR_NOT_FOUND, missing.exception)

        calls = fake.calls()
        self.assertEqual([call.operation for call in calls], ["Put", "Get", "Get", "Delete", "Get"])
        self.assertEqual(calls[1].max_bytes, 5)
        self.assertEqual(calls[2].ref.version_id, stored.version_id)
        calls[0].metadata["sha256"] = "mutated"  # type: ignore[index]
        self.assertEqual(fake.calls()[0].metadata, {"sha256": "abc"})

    def test_fake_store_validation_fails_before_recording_calls(self) -> None:
        fake = apptheory.create_fake_object_store()
        checks = [
            lambda: fake.put(
                apptheory.ObjectStorePutInput(
                    ref=apptheory.ObjectRef(bucket="bucket-a", key="object.txt", version_id="v1"),
                    payload=b"payload",
                )
            ),
            lambda: fake.get(
                apptheory.ObjectStoreGetInput(
                    ref=apptheory.ObjectRef(bucket="bucket-a", key="object.txt"),
                    max_bytes=0,
                )
            ),
            lambda: fake.delete(apptheory.ObjectStoreDeleteInput(ref=apptheory.ObjectRef(bucket="bucket-a", key=""))),
        ]
        expected_codes = [
            apptheory.OBJECTSTORE_ERROR_INVALID_REF,
            apptheory.OBJECTSTORE_ERROR_INVALID_GET_LIMIT,
            apptheory.OBJECTSTORE_ERROR_INVALID_REF,
        ]
        for check, code in zip(checks, expected_codes, strict=True):
            with self.subTest(code=code), self.assertRaises(apptheory.ObjectStoreError) as ctx:
                check()
            self.assert_object_store_error(code, ctx.exception)
        self.assertEqual(fake.calls(), [])

    def test_forbidden_operations_are_not_store_methods(self) -> None:
        fake = apptheory.create_fake_object_store()
        forbidden_methods = [
            "list",
            "list_objects",
            "presign",
            "presign_get",
            "presign_put",
            "public_url",
            "multipart",
            "create_multipart_upload",
            "upload_part",
            "complete_multipart_upload",
            "abort_multipart_upload",
        ]
        for method in forbidden_methods:
            self.assertFalse(callable(getattr(fake, method, None)), method)

        with self.assertRaises(apptheory.ObjectStoreError) as ctx:
            apptheory.unsupported_object_store_operation("list")
        self.assert_object_store_error(apptheory.OBJECTSTORE_ERROR_UNSUPPORTED_OPERATION, ctx.exception)

    def test_s3_store_uses_local_boto3_client_with_bounded_get(self) -> None:
        client = _FakeS3Client(body=b"s3-payload")
        with _fake_boto3(client, self):
            store = apptheory.create_s3_object_store(
                apptheory.S3ObjectStoreConfig(
                    region_name="us-east-1",
                    encryption=apptheory.S3EncryptionConfig(
                        mode=apptheory.S3_ENCRYPTION_KMS,
                        kms_key_id="kms-key-1",
                    ),
                )
            )

            stored = store.put(
                apptheory.ObjectStorePutInput(
                    ref=apptheory.ObjectRef(bucket="bucket-a", key="objects/alpha.txt"),
                    payload=b"payload",
                    content_type="text/plain",
                    metadata={"z": "last", "a": "first"},
                )
            )
            self.assertEqual(stored.version_id, "v-s3-1")
            put_call = client.calls[0][1]
            self.assertEqual(put_call["ServerSideEncryption"], "aws:kms")
            self.assertEqual(put_call["SSEKMSKeyId"], "kms-key-1")
            self.assertEqual(put_call["Metadata"], {"a": "first", "z": "last"})

            got = store.get(apptheory.ObjectStoreGetInput(ref=stored, max_bytes=16))
            self.assertEqual(got.payload, b"s3-payload")
            self.assertEqual(got.content_type, "text/plain")
            self.assertEqual(got.metadata, {"a": "first", "z": "last"})
            self.assertEqual(got.ref.version_id, "v-s3-2")
            self.assertIsNotNone(client.last_body)
            self.assertEqual(client.last_body.read_limit, 17)
            self.assertTrue(client.last_body.closed)

            store.delete(apptheory.ObjectStoreDeleteInput(ref=stored))
            self.assertEqual(
                client.calls[-1], ("delete", {"Bucket": "bucket-a", "Key": "objects/alpha.txt", "VersionId": "v-s3-1"})
            )

            client.body = b"too-large"
            with self.assertRaises(apptheory.ObjectStoreError) as too_large:
                store.get(apptheory.ObjectStoreGetInput(ref=stored, max_bytes=3))
            self.assert_object_store_error(apptheory.OBJECTSTORE_ERROR_OBJECT_TOO_LARGE, too_large.exception)

    def test_s3_encryption_config_fails_closed(self) -> None:
        client = _FakeS3Client()
        with _fake_boto3(client, self), self.assertRaises(apptheory.ObjectStoreError) as missing_key:
            apptheory.create_s3_object_store(
                apptheory.S3ObjectStoreConfig(
                    region_name="us-east-1",
                    encryption=apptheory.S3EncryptionConfig(mode=apptheory.S3_ENCRYPTION_KMS),
                )
            )
        self.assert_object_store_error(apptheory.OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG, missing_key.exception)

        with _fake_boto3(client, self), self.assertRaises(apptheory.ObjectStoreError) as unexpected_key:
            apptheory.create_s3_object_store(
                apptheory.S3ObjectStoreConfig(
                    region_name="us-east-1",
                    encryption=apptheory.S3EncryptionConfig(
                        mode=apptheory.S3_ENCRYPTION_BUCKET_DEFAULT,
                        kms_key_id="kms-key-1",
                    ),
                )
            )
        self.assert_object_store_error(apptheory.OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG, unexpected_key.exception)


if __name__ == "__main__":
    unittest.main()
