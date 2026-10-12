package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/theory-cloud/apptheory/v6/pkg/vectorstore"
	apptheory "github.com/theory-cloud/apptheory/v6/runtime"
	"github.com/theory-cloud/apptheory/v6/testkit"
)

const testToken = "example-test-token"

func testProvider() dependencyProvider {
	store := vectorstore.NewFakeStore(3)
	embeddings := map[string][]float32{}
	for index, record := range sampleRecords(defaultTenant, defaultNamespace) {
		embeddings[record.Text] = sampleVector(index)
	}
	embeddings["middleware ordering"] = sampleVector(1)
	embedder := vectorstore.NewFakeEmbedder(embeddings)
	return dependencyProviderFunc(func(context.Context) (*semanticDeps, error) {
		return &semanticDeps{
			Store:            store,
			Embedder:         embedder,
			Dimension:        3,
			VectorBucketName: "example-vectors",
			IndexName:        "semantic",
			ModelID:          vectorstore.DefaultTitanEmbedTextModelID,
			Normalize:        true,
		}, nil
	})
}

func authHeaders(token string) map[string][]string {
	return map[string][]string{"authorization": {"Bearer " + token}}
}

func TestSeedAndSearchRequireAuth(t *testing.T) {
	t.Setenv(exampleTokenEnv, testToken)
	app := buildApp(testProvider(), "p2")
	env := testkit.New()

	cases := []struct {
		name    string
		request apptheory.Request
		headers map[string][]string
	}{
		{
			name:    "seed without token",
			request: apptheory.Request{Method: "POST", Path: "/seed"},
		},
		{
			name: "search without token",
			request: apptheory.Request{Method: "GET", Path: "/search", Query: map[string][]string{
				"q": {"middleware ordering"},
			}},
		},
		{
			name:    "seed with wrong token",
			request: apptheory.Request{Method: "POST", Path: "/seed"},
			headers: authHeaders("wrong-token"),
		},
		{
			name: "search with wrong token",
			request: apptheory.Request{Method: "GET", Path: "/search", Query: map[string][]string{
				"q": {"middleware ordering"},
			}},
			headers: authHeaders("wrong-token"),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := tc.request
			request.Headers = tc.headers
			resp := env.Invoke(context.Background(), app, request)
			if resp.Status != 401 {
				t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
			}
		})
	}
}

func TestSemanticSearchRoutes(t *testing.T) {
	t.Setenv(exampleTokenEnv, testToken)
	provider := testProvider()

	env := testkit.New()
	app := buildApp(provider, "p2")

	seed := env.Invoke(context.Background(), app, apptheory.Request{
		Method:  "POST",
		Path:    "/seed",
		Headers: authHeaders(testToken),
	})
	if seed.Status != 200 {
		t.Fatalf("seed status=%d body=%s", seed.Status, string(seed.Body))
	}
	var seedBody map[string]any
	if err := json.Unmarshal(seed.Body, &seedBody); err != nil {
		t.Fatalf("decode seed body: %v", err)
	}
	if got := int(seedBody["seeded"].(float64)); got != len(sampleRecords(defaultTenant, defaultNamespace)) {
		t.Fatalf("seeded=%d", got)
	}

	search := env.Invoke(context.Background(), app, apptheory.Request{
		Method: "GET",
		Path:   "/search",
		Query: map[string][]string{
			"q": {"middleware ordering"},
		},
		Headers: authHeaders(testToken),
	})
	if search.Status != 200 {
		t.Fatalf("search status=%d body=%s", search.Status, string(search.Body))
	}
	var searchBody struct {
		Count int `json:"count"`
		Hits  []struct {
			Key   string `json:"key"`
			Title string `json:"title"`
		} `json:"hits"`
	}
	if err := json.Unmarshal(search.Body, &searchBody); err != nil {
		t.Fatalf("decode search body: %v", err)
	}
	if searchBody.Count == 0 || len(searchBody.Hits) == 0 {
		t.Fatalf("expected hits: %#v", searchBody)
	}
	if searchBody.Hits[0].Title != "Middleware ordering is part of the contract" {
		t.Fatalf("unexpected first hit: %#v", searchBody.Hits[0])
	}
}

func TestSearchRejectsOversizedTopK(t *testing.T) {
	t.Setenv(exampleTokenEnv, testToken)
	app := buildApp(testProvider(), "p2")
	env := testkit.New()

	resp := env.Invoke(context.Background(), app, apptheory.Request{
		Method: "GET",
		Path:   "/search",
		Query: map[string][]string{
			"q":     {"middleware ordering"},
			"top_k": {"26"},
		},
		Headers: authHeaders(testToken),
	})
	if resp.Status != 400 {
		t.Fatalf("status=%d body=%s", resp.Status, string(resp.Body))
	}
}

func TestLiveDependencyValidation(t *testing.T) {
	_, err := buildLiveDeps(context.Background(), func(string) string { return "" })
	if err == nil {
		t.Fatalf("expected missing env error")
	}

	_, err = buildLiveDeps(context.Background(), func(name string) string {
		switch name {
		case vectorstore.EnvVectorBucketName:
			return "bucket"
		case vectorstore.EnvVectorIndexName:
			return "semantic"
		case vectorstore.EnvVectorDimension:
			return "1024"
		case vectorstore.EnvEmbeddingDimensions:
			return "3"
		default:
			return ""
		}
	})
	if err == nil || err.Error() != "APPTHEORY_EMBEDDING_DIMENSIONS must match APPTHEORY_VECTOR_DIMENSION" {
		t.Fatalf("expected dimension mismatch error, got %v", err)
	}
}

func sampleVector(index int) []float32 {
	switch index {
	case 0:
		return []float32{0.1, 0.1, 0.1}
	case 1:
		return []float32{0.9, 0.1, 0.1}
	case 2:
		return []float32{0.1, 0.9, 0.1}
	default:
		return []float32{0.1, 0.1, 0.9}
	}
}
