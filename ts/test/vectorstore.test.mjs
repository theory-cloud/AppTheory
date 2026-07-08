import assert from "node:assert/strict";
import test from "node:test";

import {
  DefaultQueryTopK,
  MaxQueryTopK,
  VECTORSTORE_ERROR_DIMENSION_MISMATCH,
  VECTORSTORE_ERROR_EMBEDDING_FAILED,
  VECTORSTORE_ERROR_INVALID_CONFIG,
  VECTORSTORE_ERROR_INVALID_INPUT,
  VECTORSTORE_ERROR_INVALID_VECTOR,
  VECTORSTORE_ERROR_NOT_FOUND,
  cloneMetadata,
  cloneVector,
  createFakeVectorStore,
  createS3VectorStore,
  normalizeTopK,
  validateDimension,
  validateRequiredMetadata,
  validateVector,
  FakeEmbedder,
  SemanticIndex,
  TitanEmbedder,
} from "../dist/index.js";

test("fake vector store pins validation, filters, sorting, and call cloning", async () => {
  const store = createFakeVectorStore(3);
  store.requiredMetadataKeys = ["tenant"];

  await assert.rejects(() => store.putVectors({ records: [] }), { code: VECTORSTORE_ERROR_INVALID_INPUT });
  await assert.rejects(
    () => store.putVectors({ records: [{ key: " bad ", data: [1, 0, 0], metadata: { tenant: "t1" } }] }),
    { code: VECTORSTORE_ERROR_INVALID_INPUT },
  );
  await assert.rejects(
    () => store.putVectors({ records: [{ key: "bad", data: [1, 0], metadata: { tenant: "t1" } }] }),
    { code: VECTORSTORE_ERROR_DIMENSION_MISMATCH },
  );
  await assert.rejects(
    () => store.putVectors({ records: [{ key: "bad", data: [1, 0, 0], metadata: { tenant: " " } }] }),
    { code: VECTORSTORE_ERROR_INVALID_INPUT },
  );

  await store.putVectors({
    records: [
      { key: "alpha", data: [1, 0, 0], metadata: { tenant: "t1", tags: ["runtime", "contract"] } },
      { key: "beta", data: [0, 1, 0], metadata: { tenant: "t1", tags: ["semantic", "contract"] } },
      { key: "gamma", data: [0, 0, 1], metadata: { tenant: "t2", tags: ["other"] } },
    ],
  });

  const hits = await store.queryVectors({
    vector: [1, 0, 0],
    topK: 2,
    filter: { tenant: "t1", tags: ["contract"] },
    returnMetadata: true,
  });
  assert.deepEqual(
    hits.map((hit) => hit.key),
    ["alpha", "beta"],
  );
  assert.equal(hits[0].distance, 0);
  hits[0].metadata.tenant = "mutated";

  const got = await store.getVectors({ keys: ["alpha"], returnMetadata: true });
  assert.equal(got[0].metadata.tenant, "t1");
  got[0].data[0] = 99;
  assert.deepEqual((await store.getVectors({ keys: ["alpha"] }))[0].data, [1, 0, 0]);
  assert.equal((await store.getVectors({ keys: ["alpha"] }))[0].metadata, undefined);

  const calls = store.calls();
  calls[0].records[0].data[0] = 99;
  assert.equal(store.calls()[0].records[0].data[0], 1);

  const injected = Object.assign(new Error("forced"), { code: "forced" });
  store.setError("QueryVectors", injected);
  await assert.rejects(() => store.queryVectors({ vector: [1, 0, 0] }), injected);
  store.setError("QueryVectors", null);

  await store.deleteVectors({ keys: ["alpha"] });
  await assert.rejects(() => store.getVectors({ keys: ["alpha"] }), { code: VECTORSTORE_ERROR_NOT_FOUND });
});

test("vector validation helpers fail closed and clone nested metadata", () => {
  assert.throws(() => validateDimension(0), { code: VECTORSTORE_ERROR_INVALID_CONFIG });
  assert.throws(() => validateVector([], 0), { code: VECTORSTORE_ERROR_INVALID_VECTOR });
  assert.throws(() => validateVector([1], 2), { code: VECTORSTORE_ERROR_DIMENSION_MISMATCH });
  assert.throws(() => validateVector([Number.NaN], 0), { code: VECTORSTORE_ERROR_INVALID_VECTOR });
  assert.throws(() => validateRequiredMetadata({ tenant: [] }, [" ", "tenant"]), {
    code: VECTORSTORE_ERROR_INVALID_INPUT,
  });
  assert.equal(normalizeTopK(0), DefaultQueryTopK);
  assert.equal(normalizeTopK(MaxQueryTopK + 1), MaxQueryTopK);

  const vector = [1, 2];
  const clonedVector = cloneVector(vector);
  clonedVector[0] = 99;
  assert.equal(vector[0], 1);

  const metadata = { tags: ["a"], nested: { values: ["one"] } };
  const clonedMetadata = cloneMetadata(metadata);
  clonedMetadata.tags[0] = "changed";
  clonedMetadata.nested.values[0] = "changed";
  assert.deepEqual(metadata, { tags: ["a"], nested: { values: ["one"] } });
});

test("s3 vector store uses bounded SDK commands without live AWS", async () => {
  const client = new RecordingS3VectorsClient();
  assert.throws(
    () => createS3VectorStore({ vectorBucketName: " ", indexName: "semantic", dimension: 2, client }),
    { code: VECTORSTORE_ERROR_INVALID_CONFIG },
  );

  const store = createS3VectorStore({
    vectorBucketName: "bucket",
    indexName: "semantic",
    dimension: 2,
    maxBatchSize: 1,
    client,
  });
  await assert.rejects(() => store.getVectors({ keys: [] }), { code: VECTORSTORE_ERROR_INVALID_INPUT });
  await assert.rejects(() => store.deleteVectors({ keys: [" bad "] }), { code: VECTORSTORE_ERROR_INVALID_INPUT });

  await store.putVectors({
    records: [
      { key: "alpha", data: [1, 0], metadata: { tenant: "t1" } },
      { key: "beta", data: [0, 1] },
    ],
  });
  assert.deepEqual(
    client.commands.filter((command) => command.name === "PutVectorsCommand").map((command) => command.input.vectors[0].key),
    ["alpha", "beta"],
  );
  assert.deepEqual(client.commands[0].input.vectors[0].data.float32, [1, 0]);
  assert.deepEqual(client.commands[0].input.vectors[0].metadata, { tenant: "t1" });

  const records = await store.getVectors({ keys: ["alpha"], returnMetadata: true });
  assert.deepEqual(records, [{ key: "alpha", data: [1, 0], metadata: { tenant: "t1" } }]);
  assert.equal(client.last("GetVectorsCommand").input.returnData, true);

  const hits = await store.queryVectors({
    vector: [1, 0],
    topK: MaxQueryTopK + 50,
    filter: { tenant: "t1" },
    returnMetadata: true,
  });
  assert.deepEqual(hits, [{ key: "alpha", distance: 0.25, metadata: { tenant: "t1" } }]);
  assert.equal(client.last("QueryVectorsCommand").input.topK, MaxQueryTopK);
  assert.equal(client.last("QueryVectorsCommand").input.returnDistance, true);

  await store.deleteVectors({ keys: ["alpha", "beta"] });
  assert.deepEqual(
    client.commands.filter((command) => command.name === "DeleteVectorsCommand").map((command) => command.input.keys),
    [["alpha"], ["beta"]],
  );

  client.error = new Error("s3 down");
  await assert.rejects(() => store.queryVectors({ vector: [1, 0] }), /s3 down/);
});

test("bedrock and fake embedders trim inputs, decode responses, and fail closed", async () => {
  const fake = new FakeEmbedder({ known: [1, 0] });
  assert.deepEqual(await fake.embed(" known "), [1, 0]);
  fake.defaultEmbedding = [0, 1];
  assert.deepEqual(await fake.embedBatch(["known", "missing"]), [
    [1, 0],
    [0, 1],
  ]);
  assert.deepEqual(fake.calls, ["known", "known", "missing"]);
  await assert.rejects(() => new FakeEmbedder().embed("missing"), { code: VECTORSTORE_ERROR_EMBEDDING_FAILED });
  await assert.rejects(() => fake.embed(" "), { code: VECTORSTORE_ERROR_INVALID_INPUT });

  const client = new RecordingBedrockClient([{ embedding: [0.5, 0.25] }, { embedding: [0.5, 0.25] }]);
  const titan = new TitanEmbedder({ client, modelId: " custom-model ", dimensions: 2, normalize: false });
  assert.deepEqual(await titan.embed(" hello "), [0.5, 0.25]);
  assert.equal(client.requests[0].modelId, "custom-model");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(client.requests[0].body)), {
    inputText: "hello",
    dimensions: 2,
    normalize: false,
  });
  assert.deepEqual(await titan.embedBatch(["a"]), [[0.5, 0.25]]);

  await assert.rejects(() => new TitanEmbedder({ client: new RecordingBedrockClient([new Error("bedrock down")]) }).embed("x"), {
    code: VECTORSTORE_ERROR_EMBEDDING_FAILED,
  });
  await assert.rejects(() => new TitanEmbedder({ client: new RecordingBedrockClient([{ embedding: [] }]) }).embed("x"), {
    code: VECTORSTORE_ERROR_EMBEDDING_FAILED,
  });
  await assert.rejects(() => new TitanEmbedder({ client: new RecordingBedrockClient([{ embedding: [1] }]), dimensions: 2 }).embed("x"), {
    code: VECTORSTORE_ERROR_DIMENSION_MISMATCH,
  });
});

test("semantic index composes embedding and vector storage through the single path", async () => {
  const store = createFakeVectorStore(2);
  const embedder = new FakeEmbedder({ doc: [1, 0], query: [1, 0] });
  const semantic = new SemanticIndex({ store, embedder, dimension: 2, requiredMetadataKeys: ["tenant"] });

  await semantic.putText([{ key: "doc/1", text: "doc", metadata: { tenant: "t1" } }]);
  const hits = await semantic.queryText("query", { filter: { tenant: "t1" }, returnMetadata: true });
  assert.equal(hits[0].key, "doc/1");
  assert.deepEqual(hits[0].metadata, { tenant: "t1" });

  await assert.rejects(() => semantic.putText([]), { code: VECTORSTORE_ERROR_INVALID_INPUT });
  await assert.rejects(() => semantic.putText([{ key: "doc/2", text: " ", metadata: { tenant: "t1" } }]), {
    code: VECTORSTORE_ERROR_INVALID_INPUT,
  });
  await assert.rejects(() => semantic.putText([{ key: "doc/3", text: "doc" }]), {
    code: VECTORSTORE_ERROR_INVALID_INPUT,
  });
  await assert.rejects(() => semantic.queryText(" "), { code: VECTORSTORE_ERROR_INVALID_INPUT });

  const badEmbedder = {
    async embed() {
      return [1, 0];
    },
    async embedBatch() {
      return [];
    },
  };
  await assert.rejects(() => new SemanticIndex({ store, embedder: badEmbedder, dimension: 2 }).putText([{ key: "bad", text: "x" }]), {
    code: VECTORSTORE_ERROR_EMBEDDING_FAILED,
  });
});

class RecordingS3VectorsClient {
  commands = [];
  error = null;

  async send(command) {
    const entry = { name: command.constructor.name, input: command.input };
    this.commands.push(entry);
    if (this.error) throw this.error;
    if (entry.name === "GetVectorsCommand") {
      return { vectors: [{ key: "alpha", data: { float32: [1, 0] }, metadata: { tenant: "t1" } }] };
    }
    if (entry.name === "QueryVectorsCommand") {
      return { vectors: [{ key: "alpha", distance: 0.25, metadata: { tenant: "t1" } }] };
    }
    return {};
  }

  last(name) {
    return this.commands.filter((command) => command.name === name).at(-1);
  }
}

class RecordingBedrockClient {
  constructor(responses) {
    this.responses = Array.from(responses);
    this.requests = [];
  }

  async send(command) {
    this.requests.push(command.input);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return { body: new TextEncoder().encode(JSON.stringify(response)) };
  }
}
