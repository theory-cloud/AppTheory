from __future__ import annotations

import json
import unittest

import apptheory as app


class VectorStoreTests(unittest.TestCase):
    def test_fake_query_filters_and_sorts(self) -> None:
        store = app.create_fake_vector_store(2)
        store.required_metadata_keys = ["tenant"]
        store.put_vectors(
            app.PutVectorsInput(
                records=[
                    app.VectorRecord(key="b", data=[2, 0], metadata={"tenant": "t1"}),
                    app.VectorRecord(key="a", data=[0, 0], metadata={"tenant": "t1"}),
                ]
            )
        )
        hits = store.query_vectors(app.QueryVectorsInput(vector=[0, 0], filter={"tenant": "t1"}, return_metadata=True))
        self.assertEqual([hit.key for hit in hits], ["a", "b"])
        self.assertEqual(hits[0].metadata, {"tenant": "t1"})

    def test_titan_request_shape(self) -> None:
        class Client:
            def __init__(self) -> None:
                self.requests: list[dict[str, object]] = []

            def invoke_model(self, **kwargs: object) -> dict[str, object]:
                self.requests.append(kwargs)
                return {"body": json.dumps({"embedding": [1.0, 2.0]}).encode()}

        client = Client()
        embedder = app.TitanEmbedder(app.TitanEmbedderConfig(client=client, dimensions=2, normalize=True))
        self.assertEqual(embedder.embed(" hello "), [1.0, 2.0])
        body = json.loads(client.requests[0]["body"])  # type: ignore[arg-type]
        self.assertEqual(body, {"inputText": "hello", "dimensions": 2, "normalize": True})


if __name__ == "__main__":
    unittest.main()
