import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { S3Client } from "@aws-sdk/client-s3";

import { verifyPresignPutUrl } from "../dist/internal/objectstore-presign.js";
import {
  MAX_PRESIGN_PUT_EXPIRES_IN,
  OBJECTSTORE_ERROR_INVALID_ENCRYPTION_CONFIG,
  OBJECTSTORE_ERROR_INVALID_GET_LIMIT,
  OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT,
  OBJECTSTORE_ERROR_INVALID_REF,
  OBJECTSTORE_ERROR_INVALID_STORE_CONFIG,
  OBJECTSTORE_ERROR_NOT_FOUND,
  OBJECTSTORE_ERROR_OBJECT_TOO_LARGE,
  OBJECTSTORE_ERROR_UNSUPPORTED_OPERATION,
  S3Encryption,
  createFakeObjectStore,
  createS3ObjectStore,
  parseObjectRef,
  unsupportedObjectStoreOperation,
  validatePresignPutInput,
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

const uploadGrantFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../contract-tests/fixtures/objectstore/presign-put-upload-grant.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function uploadGrantFixtureSteps() {
  return uploadGrantFixture.input.objectstore.steps.filter(
    (step) => step.operation === "presign_put",
  );
}

function grantStepInput(step) {
  return {
    ref:
      typeof step.ref === "string" ? parseObjectRef(step.ref) : { ...step.ref },
    contentLength: step.content_length,
    checksumSha256: step.checksum_sha256,
    contentType: step.content_type,
    maxBytes: step.max_bytes,
    expiresIn: step.expires_in,
  };
}

function expiresAtText(value) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function objectStoreFailureMessage(code) {
  switch (code) {
    case OBJECTSTORE_ERROR_INVALID_REF:
      return "objectstore: invalid object ref";
    case OBJECTSTORE_ERROR_INVALID_GET_LIMIT:
      return "objectstore: max bytes must be positive";
    case OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT:
      return "objectstore: invalid presign put";
    default:
      return "";
  }
}

function queryParamNames(url) {
  return [...new URL(url).searchParams.keys()];
}

function queryParam(url, name) {
  const parsed = new URL(url);
  for (const key of parsed.searchParams.keys()) {
    if (key.toLowerCase() === name.toLowerCase()) return parsed.searchParams.get(key);
  }
  return null;
}

async function withStaticAwsCredentials(run) {
  const overrides = {
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    AWS_EC2_METADATA_DISABLED: "true",
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  previous.set("AWS_SESSION_TOKEN", process.env.AWS_SESSION_TOKEN);
  delete process.env.AWS_SESSION_TOKEN;
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("s3 upload grant signs content length, type and checksum without hoisting them", async () => {
  await withStaticAwsCredentials(async () => {
    const store = await createS3ObjectStore({ region: "us-east-1" });
    assert.equal(typeof store.presignPut, "function");

    const input = {
      ref: { bucket: "apptheory-contract", key: "objects/alpha.txt" },
      contentLength: 17,
      checksumSha256: "JxNUv+pEygWMdjyXew+bVUVS2rnR6IFkvTTZRH9ivHc=",
      contentType: "text/plain; charset=utf-8",
      maxBytes: 1048576,
      expiresIn: MAX_PRESIGN_PUT_EXPIRES_IN,
    };
    const before = Date.now();
    const grant = await store.presignPut(input);
    const after = Date.now();

    assert.equal(grant.method, "PUT");
    assert.deepEqual(grant.ref, input.ref);
    assert.deepEqual(grant.headers, {
      "content-length": "17",
      "content-type": "text/plain; charset=utf-8",
      "x-amz-checksum-sha256": "JxNUv+pEygWMdjyXew+bVUVS2rnR6IFkvTTZRH9ivHc=",
    });

    const signedHeaders = String(queryParam(grant.url, "X-Amz-SignedHeaders") ?? "")
      .toLowerCase()
      .split(";");
    assert.ok(signedHeaders.includes("content-length"), "content-length must be signed");
    assert.ok(signedHeaders.includes("content-type"), "content-type must be signed");
    assert.ok(
      signedHeaders.includes("x-amz-checksum-sha256"),
      "x-amz-checksum-sha256 must be signed",
    );

    const names = queryParamNames(grant.url);
    for (const hoisted of ["content-length", "content-type", "x-amz-checksum-sha256"]) {
      assert.equal(names.includes(hoisted), false, `${hoisted} must not be a query parameter`);
    }

    assert.equal(queryParam(grant.url, "X-Amz-Expires"), "900");
    const signed = new URL(grant.url);
    assert.equal(signed.pathname, "/objects/alpha.txt");
    assert.equal(signed.host, "apptheory-contract.s3.us-east-1.amazonaws.com");
    assert.equal(signed.searchParams.has("x-amz-server-side-encryption"), false);
    assert.equal(
      queryParam(grant.url, "x-amz-server-side-encryption"),
      null,
      "the upload grant path must not attach a server-side encryption header",
    );
    assert.ok(
      grant.expiresAt.getTime() >= before + 900_000,
      "expiresAt must not be earlier than the request",
    );
    assert.ok(
      grant.expiresAt.getTime() <= after + 900_000,
      "expiresAt must not outlive the requested grant",
    );

    // Shown for the record: the shipped signer configuration.
    assert.deepEqual([...signedHeaders].sort(), [
      "content-length",
      "content-type",
      "host",
      "x-amz-checksum-sha256",
    ]);
  });
});

test("presigned url post-condition rejects unsafe grant shapes", () => {
  const safeQuery =
    "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=900" +
    "&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256";
  const unsafeUrls = {
    "signature v2": "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?AWSAccessKeyId=AKIAIOSFODNN7EXAMPLE&Expires=1767225600&Signature=abc",
    "hoisted checksum": `https://bucket-a.s3.amazonaws.com/objects/alpha.txt?${safeQuery}&x-amz-checksum-sha256=JxNUv%2BpEygWMdjyXew%2BbVUVS2rnR6IFkvTTZRH9ivHc%3D`,
    "content type unsigned": "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=900&X-Amz-SignedHeaders=content-length%3Bhost%3Bx-amz-checksum-sha256",
    "expiry over ceiling": "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=1800&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256",
    "expiry not an integer": "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-Expires=9e2&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256",
    "no query": "https://bucket-a.s3.amazonaws.com/objects/alpha.txt",
    "no expiry": "https://bucket-a.s3.amazonaws.com/objects/alpha.txt?X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256",
  };
  for (const [name, url] of Object.entries(unsafeUrls)) {
    assert.throws(
      () => verifyPresignPutUrl(url, MAX_PRESIGN_PUT_EXPIRES_IN),
      { code: OBJECTSTORE_ERROR_INVALID_STORE_CONFIG, message: "objectstore: invalid store config" },
      name,
    );
  }
  assert.throws(
    () => verifyPresignPutUrl(`https://bucket-a.s3.amazonaws.com/objects/alpha.txt?${safeQuery}`, 300),
    { code: OBJECTSTORE_ERROR_INVALID_STORE_CONFIG, message: "objectstore: invalid store config" },
    "expiry above the requested value",
  );
  assert.doesNotThrow(() =>
    verifyPresignPutUrl(
      `https://bucket-a.s3.amazonaws.com/objects/alpha.txt?${safeQuery}`,
      MAX_PRESIGN_PUT_EXPIRES_IN,
    ),
  );
});

test("upload grant validation matches the frozen fail-closed table", async () => {
  const fake = createFakeObjectStore();
  const valid = {
    ref: { bucket: "bucket-a", key: "objects/alpha.txt" },
    contentLength: 17,
    checksumSha256: "JxNUv+pEygWMdjyXew+bVUVS2rnR6IFkvTTZRH9ivHc=",
    contentType: "text/plain",
    maxBytes: 1024,
    expiresIn: 900,
  };
  const refusals = [
    {
      name: "put-version-forbidden",
      code: OBJECTSTORE_ERROR_INVALID_REF,
      run: () =>
        fake.put({
          ref: { bucket: "bucket-a", key: "objects/alpha.txt", versionId: "v1" },
          payload: Buffer.from("payload"),
        }),
    },
    {
      name: "get-zero-limit",
      code: OBJECTSTORE_ERROR_INVALID_GET_LIMIT,
      run: () => fake.get({ ref: valid.ref, maxBytes: 0 }),
    },
    {
      name: "delete-invalid-ref",
      code: OBJECTSTORE_ERROR_INVALID_REF,
      run: () => fake.delete({ ref: { bucket: "bucket-a", key: "" } }),
    },
    {
      name: "grant-missing-checksum",
      code: OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT,
      run: () => validatePresignPutInput({ ...valid, checksumSha256: undefined }),
    },
    {
      name: "grant-checksum-wrong-length",
      code: OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT,
      run: () => validatePresignPutInput({ ...valid, checksumSha256: "c2hvcnQ=" }),
    },
    {
      name: "grant-checksum-not-padded",
      code: OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT,
      run: () =>
        validatePresignPutInput({
          ...valid,
          checksumSha256: "JxNUv+pEygWMdjyXew+bVUVS2rnR6IFkvTTZRH9ivHc9",
        }),
    },
    {
      name: "grant-missing-length",
      code: OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT,
      run: () => validatePresignPutInput({ ...valid, contentLength: undefined }),
    },
    {
      name: "grant-zero-length",
      code: OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT,
      run: () => validatePresignPutInput({ ...valid, contentLength: 0 }),
    },
    {
      name: "grant-negative-length",
      code: OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT,
      run: () => validatePresignPutInput({ ...valid, contentLength: -1 }),
    },
    {
      name: "grant-length-over-max-bytes",
      code: OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT,
      run: () => validatePresignPutInput({ ...valid, contentLength: 32, maxBytes: 16 }),
    },
    {
      name: "grant-missing-max-bytes",
      code: OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT,
      run: () => validatePresignPutInput({ ...valid, maxBytes: undefined }),
    },
    {
      name: "grant-missing-content-type",
      code: OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT,
      run: () => validatePresignPutInput({ ...valid, contentType: undefined }),
    },
    {
      name: "grant-padded-content-type",
      code: OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT,
      run: () => validatePresignPutInput({ ...valid, contentType: " text/plain" }),
    },
    {
      name: "grant-content-type-header-injection",
      code: OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT,
      run: () =>
        validatePresignPutInput({
          ...valid,
          contentType: "text/plain\r\nx-amz-acl: public-read",
        }),
    },
    {
      name: "grant-zero-expiry",
      code: OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT,
      run: () => validatePresignPutInput({ ...valid, expiresIn: 0 }),
    },
    {
      name: "grant-expiry-over-cap",
      code: OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT,
      run: () => validatePresignPutInput({ ...valid, expiresIn: 901 }),
    },
    {
      name: "grant-versioned-ref",
      code: OBJECTSTORE_ERROR_INVALID_REF,
      run: () =>
        validatePresignPutInput({
          ...valid,
          ref: { bucket: "bucket-a", key: "objects/alpha.txt", versionId: "v1" },
        }),
    },
    {
      name: "grant-malformed-ref",
      code: OBJECTSTORE_ERROR_INVALID_REF,
      run: () =>
        validatePresignPutInput({ ...valid, ref: parseObjectRef("s3://bucket-a") }),
    },
  ];
  for (const refusal of refusals) {
    await assert.rejects(
      async () => refusal.run(),
      {
        code: refusal.code,
        message: objectStoreFailureMessage(refusal.code),
      },
      refusal.name,
    );
  }

  assert.doesNotThrow(() => validatePresignPutInput(valid));
  assert.doesNotThrow(() =>
    validatePresignPutInput({ ...valid, expiresIn: MAX_PRESIGN_PUT_EXPIRES_IN }),
  );

  const steps = uploadGrantFixtureSteps();
  assert.equal(steps.length, 2);
  const expectedCallLog = uploadGrantFixture.expect.output_json.calls.slice(0, 2);
  const actualCallLog = [];
  for (const step of steps) {
    const input = grantStepInput(step);
    assert.doesNotThrow(() => validatePresignPutInput(input));
    await fake.presignPut(input);
    actualCallLog.push(fake.calls().at(-1));
  }
  assert.deepEqual(
    actualCallLog.map((call) => ({
      operation: call.operation,
      ref: call.ref,
      max_bytes: call.maxBytes,
      content_length: call.contentLength,
      checksum_sha256: call.checksumSha256,
      expires_in: call.expiresIn,
      content_type: call.contentType,
    })),
    expectedCallLog,
  );
});

test("fake upload grants are byte-deterministic and clock injectable", async () => {
  const steps = uploadGrantFixtureSteps();
  const expectedSteps = uploadGrantFixture.expect.output_json.steps.filter(
    (step) => step.operation === "presign_put",
  );
  const expectedCalls = uploadGrantFixture.expect.output_json.calls.slice(0, 2);

  const fake = createFakeObjectStore();
  const grants = [];
  for (const step of steps) {
    grants.push(await fake.presignPut(grantStepInput(step)));
  }
  assert.deepEqual(
    grants.map((grant) => ({
      ref: grant.ref,
      url: grant.url,
      method: grant.method,
      headers: grant.headers,
      expires_at: expiresAtText(grant.expiresAt),
    })),
    expectedSteps.map((step) => ({
      ref: step.ref,
      url: step.url,
      method: step.method,
      headers: step.headers,
      expires_at: step.expires_at,
    })),
  );
  assert.deepEqual(
    fake.calls().map((call) => ({
      operation: call.operation,
      ref: call.ref,
      max_bytes: call.maxBytes,
      content_length: call.contentLength,
      checksum_sha256: call.checksumSha256,
      expires_in: call.expiresIn,
      content_type: call.contentType,
    })),
    expectedCalls,
  );

  const clocked = createFakeObjectStore();
  clocked.setClock(() => new Date("2027-02-03T04:05:06Z"));
  const clockedGrant = await clocked.presignPut(grantStepInput(steps[0]));
  assert.equal(queryParam(clockedGrant.url, "X-Amz-Date"), "20270203T040506Z");
  assert.equal(expiresAtText(clockedGrant.expiresAt), "2027-02-03T04:20:06Z");
  clocked.setClock(null);
  const restoredGrant = await clocked.presignPut(grantStepInput(steps[0]));
  assert.equal(restoredGrant.url, expectedSteps[0].url);
  assert.equal(expiresAtText(restoredGrant.expiresAt), expectedSteps[0].expires_at);

  const refused = createFakeObjectStore();
  await assert.rejects(
    () => refused.presignPut({ ...grantStepInput(steps[0]), expiresIn: 901 }),
    { code: OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT },
  );
  await assert.rejects(
    () => refused.presignPut({ ...grantStepInput(steps[0]), contentLength: undefined }),
    { code: OBJECTSTORE_ERROR_INVALID_PRESIGN_PUT },
  );
  assert.deepEqual(refused.calls(), []);

  refused.setError("PresignPut", new Error("boom"));
  await assert.rejects(() => refused.presignPut(grantStepInput(steps[0])), {
    message: "boom",
  });
  assert.deepEqual(
    refused.calls().map((call) => call.operation),
    ["PresignPut"],
  );
});
