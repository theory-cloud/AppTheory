import assert from "node:assert/strict";
import test from "node:test";

import { S3Client } from "@aws-sdk/client-s3";

import {
  OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG,
  OBJECTSTORE_ERROR_INVALID_GET_LIMIT,
  OBJECTSTORE_ERROR_INVALID_REF,
  OBJECTSTORE_ERROR_NOT_FOUND,
  OBJECTSTORE_ERROR_OBJECT_TOO_LARGE,
  OBJECTSTORE_ERROR_UNSUPPORTED_OPERATION,
  S3Encryption,
  createFakeObjectStore,
  createS3ObjectStore,
  parseObjectRef,
  unsupportedObjectStoreOperation,
} from "../dist/index.js";

test("object refs parse strict s3 bucket/key URIs", () => {
  assert.deepEqual(parseObjectRef("s3://bucket-a/path/object.json"), {
    bucket: "bucket-a",
    key: "path/object.json",
  });
  for (const raw of [
    "s3://bucket-a/path?version=1",
    "s3://bucket-a/path#frag",
    "s3://bucket-a/",
    "s3://bucket a/path",
    " https://bucket-a/path ",
  ]) {
    assert.throws(() => parseObjectRef(raw), { code: OBJECTSTORE_ERROR_INVALID_REF });
  }
});

test("fake object store pins put, bounded get, delete, and call copies", async () => {
  const fake = createFakeObjectStore();
  const ref = await fake.put({
    ref: { bucket: "bucket-a", key: "objects/1.txt" },
    payload: Buffer.from("payload"),
    contentType: "text/plain",
    metadata: { sha256: "abc" },
  });
  assert.equal(ref.versionId, "v00000000000000000001");

  await assert.rejects(
    () => fake.get({ ref: { bucket: "bucket-a", key: "objects/1.txt" }, maxBytes: 3 }),
    { code: OBJECTSTORE_ERROR_OBJECT_TOO_LARGE },
  );

  const got = await fake.get({ ref, maxBytes: 16 });
  assert.equal(Buffer.from(got.payload).toString("utf8"), "payload");
  assert.deepEqual(got.metadata, { sha256: "abc" });
  got.payload[0] = 80;
  got.metadata.sha256 = "changed";

  const gotAgain = await fake.get({ ref, maxBytes: 16 });
  assert.equal(Buffer.from(gotAgain.payload).toString("utf8"), "payload");
  assert.deepEqual(gotAgain.metadata, { sha256: "abc" });

  await fake.delete({ ref: { bucket: "bucket-a", key: "objects/1.txt" } });
  await assert.rejects(() => fake.get({ ref, maxBytes: 16 }), { code: OBJECTSTORE_ERROR_NOT_FOUND });

  const calls = fake.calls();
  assert.deepEqual(calls.map((call) => call.operation), ["Put", "Get", "Get", "Get", "Delete", "Get"]);
  calls[0].payload[0] = 80;
  assert.equal(Buffer.from(fake.calls()[0].payload).toString("utf8"), "payload");
});

test("object store validation and unsupported operations fail closed", async () => {
  const fake = createFakeObjectStore();
  await assert.rejects(
    () => fake.put({ ref: { bucket: "bucket-a", key: "key", versionId: "v1" }, payload: Buffer.from("x") }),
    { code: OBJECTSTORE_ERROR_INVALID_REF },
  );
  await assert.rejects(() => fake.get({ ref: { bucket: "bucket-a", key: "key" }, maxBytes: 0 }), {
    code: OBJECTSTORE_ERROR_INVALID_GET_LIMIT,
  });
  assert.throws(() => unsupportedObjectStoreOperation("list"), {
    code: OBJECTSTORE_ERROR_UNSUPPORTED_OPERATION,
    message: "objectstore: unsupported operation: list",
  });
  assert.equal("list" in fake, false);
  assert.equal("presign" in fake, false);
  assert.equal("multipart" in fake, false);
});

test("s3 object store uses bounded commands without live AWS", async () => {
  const originalSend = S3Client.prototype.send;
  const commands = [];
  S3Client.prototype.send = async function send(command) {
    commands.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === "PutObjectCommand") {
      return { VersionId: "s3-v1" };
    }
    if (command.constructor.name === "GetObjectCommand") {
      return {
        Body: asyncBytes("payload"),
        VersionId: "s3-v2",
        ContentType: "text/plain",
        Metadata: { sha256: "abc" },
      };
    }
    return {};
  };
  try {
    const store = await createS3ObjectStore({
      region: "us-east-1",
      encryption: { mode: S3Encryption.KMS, kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/abc" },
    });
    const putRef = await store.put({
      ref: { bucket: "bucket-a", key: "objects/1.txt" },
      payload: Buffer.from("payload"),
      contentType: "text/plain",
      metadata: { sha256: "abc" },
    });
    assert.equal(putRef.versionId, "s3-v1");
    assert.equal(commands[0].input.ServerSideEncryption, "aws:kms");
    assert.equal(commands[0].input.SSEKMSKeyId, "arn:aws:kms:us-east-1:123456789012:key/abc");

    const got = await store.get({ ref: { bucket: "bucket-a", key: "objects/1.txt", versionId: "s3-v2" }, maxBytes: 16 });
    assert.equal(Buffer.from(got.payload).toString("utf8"), "payload");
    assert.deepEqual(got.metadata, { sha256: "abc" });

    await assert.rejects(
      () => store.get({ ref: { bucket: "bucket-a", key: "objects/1.txt" }, maxBytes: 3 }),
      { code: OBJECTSTORE_ERROR_OBJECT_TOO_LARGE },
    );

    await store.delete({ ref: { bucket: "bucket-a", key: "objects/1.txt", versionId: "s3-v2" } });
    assert.deepEqual(commands.map((entry) => entry.name), [
      "PutObjectCommand",
      "GetObjectCommand",
      "GetObjectCommand",
      "DeleteObjectCommand",
    ]);
  } finally {
    S3Client.prototype.send = originalSend;
  }
});

test("s3 encryption config fails closed before client use", async () => {
  await assert.rejects(() => createS3ObjectStore({ encryption: { mode: S3Encryption.KMS } }), {
    code: OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG,
  });
  await assert.rejects(
    () => createS3ObjectStore({ encryption: { mode: S3Encryption.S3Managed, kmsKeyId: "kms-key" } }),
    { code: OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG },
  );
});

async function* asyncBytes(value) {
  yield Buffer.from(value, "utf8");
}
