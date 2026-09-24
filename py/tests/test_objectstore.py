from __future__ import annotations

import datetime as dt
import json
import os
import sys
import types
import unittest
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
from unittest import mock
from urllib.parse import parse_qs, quote, urlparse

import apptheory
import boto3
import botocore.config
from apptheory.objectstore import _S3ObjectStore, _verify_presign_put_url

REPO_ROOT = Path(__file__).resolve().parents[2]
OBJECTSTORE_FIXTURE_DIR = REPO_ROOT / "contract-tests" / "fixtures" / "objectstore"

PRESIGN_PUT_CHECKSUM = "JxNUv+pEygWMdjyXew+bVUVS2rnR6IFkvTTZRH9ivHc="
PRESIGN_PUT_SIGNED_HEADER_NAMES = ("content-length", "content-type", "x-amz-checksum-sha256")
PRESIGN_PUT_SIGNED_HEADERS_VALUE = "content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256"


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
        test_case.assertEqual(kwargs.get("region_name"), "us-east-1")
        test_case.assertEqual(getattr(kwargs.get("config"), "signature_version", None), "s3v4")
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


def _real_s3_client(signature_version: str | None = None) -> Any:
    """Build a real boto3 S3 client. Presigning is offline, so no network call is made."""
    kwargs: dict[str, Any] = {
        "region_name": "us-east-1",
        "aws_access_key_id": "AKIAIOSFODNN7EXAMPLE",
        "aws_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    }
    if signature_version is not None:
        kwargs["config"] = botocore.config.Config(signature_version=signature_version)
    return boto3.client("s3", **kwargs)


def _presign_put_input(**overrides: Any) -> apptheory.ObjectStorePresignPutInput:
    values: dict[str, Any] = {
        "ref": apptheory.ObjectRef(bucket="apptheory-contract", key="objects/alpha.txt"),
        "content_length": 17,
        "checksum_sha256": PRESIGN_PUT_CHECKSUM,
        "content_type": "text/plain; charset=utf-8",
        "max_bytes": 1048576,
        "expires_in": 900,
    }
    values.update(overrides)
    return apptheory.ObjectStorePresignPutInput(**values)


def _presign_query(url: str) -> dict[str, list[str]]:
    return parse_qs(urlparse(url).query, keep_blank_values=True)


def _presign_query_names(url: str) -> list[str]:
    return [name.lower() for name in _presign_query(url)]


def _presigned_url(
    *,
    signed_headers: str = PRESIGN_PUT_SIGNED_HEADERS_VALUE,
    expires: str = "900",
    extra: list[str] | None = None,
) -> str:
    parameters = [
        "X-Amz-Algorithm=AWS4-HMAC-SHA256",
        f"X-Amz-Expires={expires}",
        f"X-Amz-SignedHeaders={signed_headers}",
    ]
    parameters.extend(extra or [])
    return f"https://s3.amazonaws.com/bucket-a/objects/alpha.txt?{'&'.join(parameters)}"


def _utc_seconds(value: dt.datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.UTC)
    return value.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _objectstore_fixture(name: str) -> dict[str, Any]:
    return json.loads((OBJECTSTORE_FIXTURE_DIR / name).read_text(encoding="utf-8"))


def _fixture_step_ref(step: dict[str, Any]) -> apptheory.ObjectRef:
    raw = step.get("ref")
    if isinstance(raw, str):
        return apptheory.parse_object_ref(raw)
    if isinstance(raw, dict):
        return apptheory.ObjectRef(
            bucket=str(raw.get("bucket") or ""),
            key=str(raw.get("key") or ""),
            version_id=str(raw.get("version_id") or ""),
        )
    return apptheory.ObjectRef(bucket="", key="")


def _fixture_presign_put_input(step: dict[str, Any]) -> apptheory.ObjectStorePresignPutInput:
    # Forward the numeric fields exactly as the fixture wrote them: coercing with int() would hide
    # the fractional length and expiry the fail-closed corpus pins as refusals.
    return apptheory.ObjectStorePresignPutInput(
        ref=_fixture_step_ref(step),
        content_length=step.get("content_length", 0),
        checksum_sha256=str(step.get("checksum_sha256") or ""),
        content_type=str(step.get("content_type") or ""),
        max_bytes=step.get("max_bytes", 0),
        expires_in=step.get("expires_in", 0),
    )


def _call_json(call: apptheory.ObjectStoreCall) -> dict[str, Any]:
    out: dict[str, Any] = {
        "operation": call.operation,
        "ref": {"bucket": call.ref.bucket, "key": call.ref.key},
    }
    if call.max_bytes:
        out["max_bytes"] = call.max_bytes
    if call.content_length:
        out["content_length"] = call.content_length
    if call.checksum_sha256:
        out["checksum_sha256"] = call.checksum_sha256
    if call.expires_in:
        out["expires_in"] = call.expires_in
    if call.content_type:
        out["content_type"] = call.content_type
    return out


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
            "presign_get_object",
            "presign_url",
            "public_url",
            "multipart",
            "create_multipart_upload",
            "upload_part",
            "complete_multipart_upload",
            "abort_multipart_upload",
            "copy",
            "copy_object",
            "head",
            "head_object",
            "client",
            "raw_client",
            "s3_client",
        ]
        for method in forbidden_methods:
            self.assertFalse(callable(getattr(fake, method, None)), method)

        self.assertFalse(callable(getattr(apptheory.ObjectStore, "presign_put", None)))
        self.assertTrue(callable(getattr(apptheory.ObjectStoreUploadGranter, "presign_put", None)))
        self.assertTrue(callable(getattr(fake, "presign_put", None)))

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

    def test_s3_presign_put_signs_the_declared_constraints(self) -> None:
        store = _S3ObjectStore(_real_s3_client("s3v4"), apptheory.S3ObjectStoreConfig(region_name="us-east-1"))
        input_ = _presign_put_input()
        grant = store.presign_put(input_)

        query = _presign_query(grant.url)
        signed = query["X-Amz-SignedHeaders"][0].lower().split(";")
        self.assertIn("content-length", signed)
        self.assertIn("content-type", signed)
        self.assertIn("x-amz-checksum-sha256", signed)
        for name in PRESIGN_PUT_SIGNED_HEADER_NAMES:
            self.assertNotIn(name, _presign_query_names(grant.url))
        self.assertEqual(query["X-Amz-Expires"], ["900"])
        self.assertNotIn("AWSAccessKeyId", query)
        self.assertEqual(grant.method, "PUT")
        self.assertEqual(grant.ref, input_.ref)
        self.assertEqual(
            grant.headers,
            {
                "content-length": "17",
                "content-type": "text/plain; charset=utf-8",
                "x-amz-checksum-sha256": PRESIGN_PUT_CHECKSUM,
            },
        )
        self.assertIsNotNone(grant.expires_at.tzinfo)
        remaining = (grant.expires_at - dt.datetime.now(dt.UTC)).total_seconds()
        self.assertGreater(remaining, 890)
        self.assertLessEqual(remaining, 900)

    def test_public_s3_store_pins_sigv4_for_real_boto3(self) -> None:
        credentials = {
            "AWS_ACCESS_KEY_ID": "AKIAIOSFODNN7EXAMPLE",
            "AWS_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        }
        with mock.patch.dict(os.environ, credentials):
            store = apptheory.create_s3_object_store(apptheory.S3ObjectStoreConfig(region_name="us-east-1"))
            grant = store.presign_put(_presign_put_input())

        query = _presign_query(grant.url)
        signed = query["X-Amz-SignedHeaders"][0].lower().split(";")
        for name in PRESIGN_PUT_SIGNED_HEADER_NAMES:
            self.assertIn(name, signed)
            self.assertNotIn(name, _presign_query_names(grant.url))
        self.assertEqual(grant.method, "PUT")

    def test_s3_presign_put_refuses_a_sigv2_client(self) -> None:
        client = _real_s3_client()
        raw_url = client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": "apptheory-contract",
                "Key": "objects/alpha.txt",
                "ContentLength": 17,
                "ContentType": "text/plain; charset=utf-8",
                "ChecksumSHA256": PRESIGN_PUT_CHECKSUM,
            },
            ExpiresIn=900,
        )
        query_names = _presign_query_names(raw_url)
        self.assertIn("awsaccesskeyid", query_names)
        self.assertIn("signature", query_names)
        self.assertNotIn("x-amz-signedheaders", query_names)
        self.assertIn("content-type", query_names)
        self.assertIn("x-amz-checksum-sha256", query_names)

        store = _S3ObjectStore(client, apptheory.S3ObjectStoreConfig(region_name="us-east-1"))
        with self.assertRaises(apptheory.ObjectStoreError) as ctx:
            store.presign_put(_presign_put_input())
        self.assert_object_store_error(apptheory.OBJECTSTORE_ERROR_INVALID_STORE_CONFIG, ctx.exception)

    def test_s3_presign_put_requires_a_url_generating_client(self) -> None:
        store = _S3ObjectStore(_FakeS3Client(), apptheory.S3ObjectStoreConfig(region_name="us-east-1"))
        with self.assertRaises(apptheory.ObjectStoreError) as ctx:
            store.presign_put(_presign_put_input())
        self.assert_object_store_error(apptheory.OBJECTSTORE_ERROR_INVALID_STORE_CONFIG, ctx.exception)

    def test_presign_put_url_verifier_refuses_unsafe_urls(self) -> None:
        unsafe = [
            (
                "sigv2",
                "https://s3.amazonaws.com/bucket-a/objects/alpha.txt"
                "?AWSAccessKeyId=AKIAIOSFODNN7EXAMPLE&Signature=abc%3D&content-type=text%2Fplain&Expires=1790269945",
                900,
            ),
            ("checksum-hoisted", _presigned_url(extra=[f"x-amz-checksum-sha256={PRESIGN_PUT_CHECKSUM}"]), 900),
            ("content-type-hoisted", _presigned_url(extra=["content-type=text%2Fplain"]), 900),
            ("content-length-hoisted", _presigned_url(extra=["content-length=17"]), 900),
            (
                "content-type-not-signed",
                _presigned_url(signed_headers="content-length%3Bhost%3Bx-amz-checksum-sha256"),
                900,
            ),
            (
                "content-length-not-signed",
                _presigned_url(signed_headers="content-type%3Bhost%3Bx-amz-checksum-sha256"),
                900,
            ),
            (
                "checksum-not-signed",
                _presigned_url(signed_headers="content-length%3Bcontent-type%3Bhost"),
                900,
            ),
            ("expires-over-framework-ceiling", _presigned_url(expires="1800"), 1800),
            ("expires-over-requested", _presigned_url(expires="600"), 300),
            ("expires-zero", _presigned_url(expires="0"), 900),
            (
                "expires-missing",
                "https://s3.amazonaws.com/bucket-a/objects/alpha.txt?X-Amz-SignedHeaders=content-length",
                900,
            ),
            ("expires-not-an-integer", _presigned_url(expires="soon"), 900),
            # X-Amz-Expires must be bare ASCII digits: int() used to tolerate a sign, padding,
            # underscores and fullwidth digits, all of which Go and TypeScript already refuse.
            ("expires-with-sign", _presigned_url(expires="%2B900"), 900),
            ("expires-padded", _presigned_url(expires="%20900"), 900),
            ("expires-trailing-pad", _presigned_url(expires="900%20"), 900),
            ("expires-underscored", _presigned_url(expires="9_00"), 900),
            ("expires-fractional", _presigned_url(expires="900.0"), 900),
            ("expires-scientific", _presigned_url(expires="9e2"), 900),
            ("expires-fullwidth-digits", _presigned_url(expires=quote("９００")), 900),
            ("signed-headers-missing", "https://s3.amazonaws.com/bucket-a/objects/alpha.txt?X-Amz-Expires=900", 900),
            ("queryless", "https://s3.amazonaws.com/bucket-a/objects/alpha.txt", 900),
        ]
        for case, url, requested in unsafe:
            with self.subTest(case=case), self.assertRaises(apptheory.ObjectStoreError) as ctx:
                _verify_presign_put_url(url, requested)
            self.assert_object_store_error(apptheory.OBJECTSTORE_ERROR_INVALID_STORE_CONFIG, ctx.exception)

        for url, requested in [
            (_presigned_url(), 900),
            (_presigned_url(expires="600"), 900),
            (_presigned_url(expires="600"), 600),
            (
                "https://s3.amazonaws.com/bucket-a/objects/alpha.txt"
                "?X-Amz-SignedHeaders=Content-Length%3BContent-Type%3BHost%3BX-Amz-Checksum-SHA256&X-Amz-Expires=900",
                900,
            ),
        ]:
            with self.subTest(url=url):
                self.assertIsNone(_verify_presign_put_url(url, requested))

    def test_presign_put_validation_refusals_match_contract_fixture(self) -> None:
        fixture = _objectstore_fixture("fail-closed-validation.json")
        steps = fixture["input"]["objectstore"]["steps"]
        expected_steps = fixture["expect"]["output_json"]["steps"]
        fake = apptheory.create_fake_object_store()
        refusals = 0
        for step, expected in zip(steps, expected_steps, strict=True):
            if step["operation"] != "presign_put":
                continue
            self.assertEqual(step["name"], expected["name"])
            refusals += 1
            with self.subTest(step=step["name"]), self.assertRaises(apptheory.ObjectStoreError) as ctx:
                fake.presign_put(_fixture_presign_put_input(step))
            self.assert_object_store_error(expected["error"]["code"], ctx.exception)
        self.assertEqual(refusals, 18)
        self.assertEqual(fake.calls(), [])

        non_canonical = "JxNUv+pEygWMdjyXew+bVUVS2rnR6IFkvTTZRH9ivHd="
        for rejected in [
            _presign_put_input(checksum_sha256=non_canonical),
            _presign_put_input(checksum_sha256=""),
            _presign_put_input(expires_in=901),
            _presign_put_input(expires_in=0),
            _presign_put_input(content_length=0),
            _presign_put_input(content_length=18, max_bytes=17),
            _presign_put_input(max_bytes=0),
            _presign_put_input(content_type=""),
            # Mistyped fields: bool is an int subclass, and a numeric string or a float must be
            # refused rather than coerced. Every runtime refuses these with the same code.
            _presign_put_input(content_length=True),
            _presign_put_input(max_bytes=True),
            _presign_put_input(expires_in=True),
            _presign_put_input(content_length=17.5),
            _presign_put_input(max_bytes=1024.5),
            _presign_put_input(expires_in=1.5),
            _presign_put_input(expires_in=0.9),
            _presign_put_input(expires_in="900"),
            _presign_put_input(content_length="17"),
        ]:
            with self.assertRaises(apptheory.ObjectStoreError) as ctx:
                apptheory.validate_presign_put_input(rejected)
            self.assert_object_store_error(apptheory.OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT, ctx.exception)

    def test_presign_put_type_mistakes_raise_object_store_errors(self) -> None:
        """A mistyped grant field must never surface a raw TypeError or SDK validation error."""
        for overrides in [
            {"content_length": True},
            {"content_length": 17.5},
            {"content_length": "17"},
            {"max_bytes": True},
            {"max_bytes": 1024.5},
            {"expires_in": True},
            {"expires_in": "900"},
            {"expires_in": 1.5},
            {"expires_in": 0.9},
        ]:
            fake = apptheory.create_fake_object_store()
            with self.subTest(overrides=overrides), self.assertRaises(apptheory.ObjectStoreError) as ctx:
                fake.presign_put(_presign_put_input(**overrides))
            self.assert_object_store_error(apptheory.OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT, ctx.exception)
            self.assertEqual(fake.calls(), [])

    def test_presign_put_validation_accepts_the_declared_boundaries(self) -> None:
        self.assertEqual(apptheory.MAX_PRESIGN_PUT_EXPIRES_IN, 900)
        self.assertIsNone(apptheory.validate_presign_put_input(_presign_put_input(expires_in=900)))
        self.assertIsNone(apptheory.validate_presign_put_input(_presign_put_input(expires_in=1)))
        self.assertIsNone(apptheory.validate_presign_put_input(_presign_put_input(content_length=5, max_bytes=5)))

        fixture = _objectstore_fixture("presign-put-upload-grant.json")
        steps = [step for step in fixture["input"]["objectstore"]["steps"] if step["operation"] == "presign_put"]
        self.assertEqual(len(steps), 2)
        for step in steps:
            with self.subTest(step=step["name"]):
                self.assertIsNone(apptheory.validate_presign_put_input(_fixture_presign_put_input(step)))

    def test_fake_presign_put_matches_contract_fixture(self) -> None:
        fixture = _objectstore_fixture("presign-put-upload-grant.json")
        steps = fixture["input"]["objectstore"]["steps"]
        expected_steps = fixture["expect"]["output_json"]["steps"]
        expected_calls = fixture["expect"]["output_json"]["calls"]
        grants = [
            (step, expected)
            for step, expected in zip(steps, expected_steps, strict=True)
            if step["operation"] == "presign_put"
        ]

        fake = apptheory.create_fake_object_store()
        for step, expected in grants:
            grant = fake.presign_put(_fixture_presign_put_input(step))
            with self.subTest(step=step["name"]):
                self.assertEqual(grant.url, expected["url"])
                self.assertEqual(grant.method, expected["method"])
                self.assertEqual(grant.headers, expected["headers"])
                self.assertEqual(grant.ref, _fixture_step_ref(step))
                self.assertEqual(_utc_seconds(grant.expires_at), expected["expires_at"])

        calls = fake.calls()
        self.assertEqual([call.operation for call in calls], ["PresignPut"] * len(grants))
        self.assertEqual([_call_json(call) for call in calls], expected_calls[: len(grants)])

    def test_fake_presign_put_clock_is_injectable(self) -> None:
        fake = apptheory.create_fake_object_store()
        fixed = fake.presign_put(_presign_put_input())
        self.assertIn("X-Amz-Date=20260101T000000Z", fixed.url)
        self.assertEqual(_utc_seconds(fixed.expires_at), "2026-01-01T00:15:00Z")

        fake.set_clock(lambda: dt.datetime(2030, 6, 1, 12, 30, 15, tzinfo=dt.UTC))
        moved = fake.presign_put(_presign_put_input(expires_in=60))
        self.assertIn("X-Amz-Date=20300601T123015Z", moved.url)
        self.assertIn("X-Amz-Expires=60", moved.url)
        self.assertEqual(_utc_seconds(moved.expires_at), "2030-06-01T12:31:15Z")

        fake.set_clock(lambda: dt.datetime(2030, 6, 1, 12, 30, 15))
        naive = fake.presign_put(_presign_put_input(expires_in=60))
        self.assertIn("X-Amz-Date=20300601T123015Z", naive.url)
        self.assertEqual(_utc_seconds(naive.expires_at), "2030-06-01T12:31:15Z")

        fake.set_clock(None)
        restored = fake.presign_put(_presign_put_input())
        self.assertEqual(restored.url, fixed.url)
        self.assertEqual(_utc_seconds(restored.expires_at), "2026-01-01T00:15:00Z")

    def test_fake_presign_put_records_nothing_for_a_refused_grant(self) -> None:
        fake = apptheory.create_fake_object_store()
        with self.assertRaises(apptheory.ObjectStoreError):
            fake.presign_put(_presign_put_input(expires_in=901))
        with self.assertRaises(apptheory.ObjectStoreError):
            fake.presign_put(_presign_put_input(ref=apptheory.ObjectRef(bucket="bucket-a", key="k", version_id="v1")))
        self.assertEqual(fake.calls(), [])


if __name__ == "__main__":
    unittest.main()
