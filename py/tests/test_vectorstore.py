from __future__ import annotations

import io
import json
import math
import unittest

import apptheory as app


class VectorStoreTests(unittest.TestCase):
    def test_fake_query_filters_and_sorts(self) -> None:
        store = app.create_fake_vector_store(2)
        store.required_metadata_keys = ["tenant"]
        store.put_vectors(
            app.PutVectorsInput(
                records=[
                    app.VectorRecord(key="b", data=[2, 0], metadata={"tenant": "t1", "tags": ["runtime"]}),
                    app.VectorRecord(key="a", data=[0, 0], metadata={"tenant": "t1", "tags": ["semantic"]}),
                ]
            )
        )
        hits = store.query_vectors(app.QueryVectorsInput(vector=[0, 0], filter={"tenant": "t1"}, return_metadata=True))
        self.assertEqual([hit.key for hit in hits], ["a", "b"])
        self.assertEqual(hits[0].metadata, {"tenant": "t1", "tags": ["semantic"]})

        tag_hits = store.query_vectors(app.QueryVectorsInput(vector=[0, 0], filter={"tags": ["runtime"]}))
        self.assertEqual([hit.key for hit in tag_hits], ["b"])

    def test_fake_store_validation_failures_and_calls_are_cloned(self) -> None:
        store = app.create_fake_vector_store(2)
        with self.assertRaisesRegex(app.VectorStoreError, "dimension must be positive"):
            app.validate_dimension(0)
        with self.assertRaisesRegex(app.VectorStoreError, "vector is required"):
            app.validate_vector([], 2)
        with self.assertRaisesRegex(app.VectorStoreError, "dimension mismatch"):
            app.validate_vector([1], 2)
        with self.assertRaisesRegex(app.VectorStoreError, "finite"):
            app.validate_vector([math.inf, 0], 2)
        with self.assertRaisesRegex(app.VectorStoreError, "required metadata missing"):
            app.validate_required_metadata({"tenant": " "}, ["tenant"])
        with self.assertRaisesRegex(app.VectorStoreError, "vector key is required"):
            store.put_vectors(app.PutVectorsInput(records=[app.VectorRecord(key=" bad ", data=[0, 0])]))

        store.put_vectors(app.PutVectorsInput(records=[app.VectorRecord(key="a", data=[1, 1])]))
        calls = store.calls()
        calls[0].records[0].data.append(99)  # type: ignore[index,union-attr]
        self.assertEqual(store.calls()[0].records[0].data, [1, 1])  # type: ignore[index,union-attr]
        self.assertEqual(store.get_vectors(app.GetVectorsInput(keys=["a"]))[0].metadata, None)
        store.delete_vectors(app.DeleteVectorsInput(keys=["a"]))
        with self.assertRaisesRegex(app.VectorStoreError, "vector not found"):
            store.get_vectors(app.GetVectorsInput(keys=["a"]))

        injected = app.VectorStoreError(app.VECTORSTORE_ERROR_UNSUPPORTED_OPERATION, "boom")
        store.set_error("QueryVectors", injected)
        with self.assertRaises(app.VectorStoreError) as raised:
            store.query_vectors(app.QueryVectorsInput(vector=[0, 0]))
        self.assertIs(raised.exception, injected)
        store.set_error("QueryVectors", None)

    def test_s3_vector_store_client_requests_and_decoding(self) -> None:
        class Client:
            def __init__(self) -> None:
                self.put_calls: list[dict[str, object]] = []
                self.delete_calls: list[dict[str, object]] = []
                self.query_calls: list[dict[str, object]] = []

            def put_vectors(self, **kwargs: object) -> dict[str, object]:
                self.put_calls.append(kwargs)
                return {}

            def get_vectors(self, **kwargs: object) -> dict[str, object]:
                return {
                    "vectors": [
                        {"key": "a", "data": {"float32": [1, 2]}, "metadata": {"tenant": "t1"}},
                    ]
                }

            def delete_vectors(self, **kwargs: object) -> dict[str, object]:
                self.delete_calls.append(kwargs)
                return {}

            def query_vectors(self, **kwargs: object) -> dict[str, object]:
                self.query_calls.append(kwargs)
                return {"vectors": [{"key": "a", "distance": 0.5, "metadata": {"title": "A"}}]}

        with self.assertRaisesRegex(app.VectorStoreError, "bucket and index"):
            app.S3VectorStore(
                app.S3VectorStoreConfig(
                    vector_bucket_name=" ",
                    index_name="semantic",
                    dimension=2,
                    client=Client(),
                )
            )

        client = Client()
        store = app.create_s3_vector_store(
            app.S3VectorStoreConfig(
                vector_bucket_name="bucket",
                index_name="semantic",
                dimension=2,
                client=client,
                max_batch_size=1,
            )
        )
        with self.assertRaisesRegex(app.VectorStoreError, "at least one vector"):
            store.put_vectors(app.PutVectorsInput(records=[]))
        with self.assertRaisesRegex(app.VectorStoreError, "at least one key"):
            store.get_vectors(app.GetVectorsInput(keys=[]))
        with self.assertRaisesRegex(app.VectorStoreError, "vector key is required"):
            store.delete_vectors(app.DeleteVectorsInput(keys=[" bad "]))
        store.put_vectors(
            app.PutVectorsInput(
                records=[
                    app.VectorRecord(key="a", data=[1, 2], metadata={"tenant": "t1"}),
                    app.VectorRecord(key="b", data=[3, 4]),
                ]
            )
        )
        self.assertEqual(len(client.put_calls), 2)
        self.assertEqual(
            client.put_calls[0]["vectors"],
            [{"key": "a", "data": {"float32": [1, 2]}, "metadata": {"tenant": "t1"}}],
        )
        self.assertEqual(
            store.get_vectors(app.GetVectorsInput(keys=["a"], return_metadata=True))[0].metadata,
            {"tenant": "t1"},
        )
        hits = store.query_vectors(
            app.QueryVectorsInput(vector=[1, 2], top_k=99999, filter={"tenant": "t1"}, return_metadata=True)
        )
        self.assertEqual(hits[0].key, "a")
        self.assertEqual(client.query_calls[0]["topK"], app.MaxQueryTopK)
        store.delete_vectors(app.DeleteVectorsInput(keys=["a", "b"]))
        self.assertEqual(client.delete_calls[0]["keys"], ["a"])
        self.assertEqual(client.delete_calls[1]["keys"], ["b"])

    def test_titan_request_shape_and_error_paths(self) -> None:
        class Client:
            def __init__(self, responses: list[object]) -> None:
                self.responses = list(responses)
                self.requests: list[dict[str, object]] = []

            def invoke_model(self, **kwargs: object) -> dict[str, object]:
                self.requests.append(kwargs)
                response = self.responses.pop(0)
                if isinstance(response, Exception):
                    raise response
                return response  # type: ignore[return-value]

        client = Client([{"body": io.BytesIO(json.dumps({"embedding": [1.0, 2.0]}).encode())}])
        embedder = app.TitanEmbedder(app.TitanEmbedderConfig(client=client, dimensions=2, normalize=True))
        self.assertEqual(embedder.embed(" hello "), [1.0, 2.0])
        body = json.loads(client.requests[0]["body"])  # type: ignore[arg-type]
        self.assertEqual(body, {"inputText": "hello", "dimensions": 2, "normalize": True})
        self.assertEqual(embedder.embed_batch([]), [])

        cases = [
            (RuntimeError("invoke failed"), "bedrock embedding request failed"),
            ({"body": json.dumps({"embedding": []})}, "missing embedding"),
            ({"body": json.dumps({"embedding": [1.0]})}, "dimension mismatch"),
        ]
        for response, pattern in cases:
            bad = app.TitanEmbedder(app.TitanEmbedderConfig(client=Client([response]), dimensions=2))
            with self.assertRaisesRegex(app.VectorStoreError, pattern):
                bad.embed("hello")
        with self.assertRaisesRegex(app.VectorStoreError, "embedding input is required"):
            embedder.embed("  ")

    def test_semantic_index_success_and_fail_closed_paths(self) -> None:
        store = app.create_fake_vector_store(2)
        embedder = app.FakeEmbedder({"hello world": [0, 0], "query": [0, 0]})
        semantic = app.SemanticIndex(
            app.SemanticIndexConfig(store=store, embedder=embedder, dimension=2, required_metadata_keys=["tenant"])
        )
        semantic.put_text([app.SemanticRecord(key="a", text="hello world", metadata={"tenant": "t1"})])
        self.assertEqual(embedder.calls, ["hello world"])
        hits = semantic.query_text("query", filter={"tenant": "t1"}, return_metadata=True)
        self.assertEqual(hits[0].metadata, {"tenant": "t1"})

        with self.assertRaisesRegex(app.VectorStoreError, "at least one semantic record"):
            semantic.put_text([])
        with self.assertRaisesRegex(app.VectorStoreError, "semantic text is required"):
            semantic.put_text([app.SemanticRecord(key="b", text=" ", metadata={"tenant": "t1"})])
        with self.assertRaisesRegex(app.VectorStoreError, "required metadata missing"):
            semantic.put_text([app.SemanticRecord(key="b", text="hello world", metadata={})])
        with self.assertRaisesRegex(app.VectorStoreError, "query text is required"):
            semantic.query_text(" ")

        class BadBatchEmbedder:
            def embed(self, text: str) -> list[float]:
                return [0, 0]

            def embed_batch(self, texts: list[str]) -> list[list[float]]:
                return []

        bad = app.SemanticIndex(app.SemanticIndexConfig(store=store, embedder=BadBatchEmbedder(), dimension=2))
        with self.assertRaisesRegex(app.VectorStoreError, "embedding count mismatch"):
            bad.put_text([app.SemanticRecord(key="c", text="hello")])

    def test_fake_embedder_defaults_and_missing_embeddings(self) -> None:
        embedder = app.FakeEmbedder({"known": [1, 2]})
        self.assertEqual(embedder.embed(" known "), [1, 2])
        embedder.default_embedding = [3, 4]
        self.assertEqual(embedder.embed("unknown"), [3, 4])
        empty = app.FakeEmbedder()
        with self.assertRaisesRegex(app.VectorStoreError, "embedding not found"):
            empty.embed("missing")
        with self.assertRaisesRegex(app.VectorStoreError, "embedding input is required"):
            empty.embed(" ")


if __name__ == "__main__":
    unittest.main()
