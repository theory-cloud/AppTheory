package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/aws/aws-lambda-go/lambda"

	"github.com/theory-cloud/apptheory/v2/pkg/vectorstore"
	apptheory "github.com/theory-cloud/apptheory/v2/runtime"
)

const (
	defaultTenant    = "demo"
	defaultNamespace = "apptheory"
)

type dependencyProvider interface {
	Get(context.Context) (*semanticDeps, error)
}

type dependencyProviderFunc func(context.Context) (*semanticDeps, error)

func (f dependencyProviderFunc) Get(ctx context.Context) (*semanticDeps, error) { return f(ctx) }

type semanticDeps struct {
	Store            vectorstore.Store
	Embedder         vectorstore.Embedder
	Dimension        int
	VectorBucketName string
	IndexName        string
	ModelID          string
	Normalize        bool
}

type liveProvider struct {
	env  func(string) string
	once sync.Once
	deps *semanticDeps
	err  error
}

func (p *liveProvider) Get(ctx context.Context) (*semanticDeps, error) {
	p.once.Do(func() {
		p.deps, p.err = buildLiveDeps(ctx, p.env)
	})
	return p.deps, p.err
}

type seedRequest struct {
	Tenant    string `json:"tenant"`
	Namespace string `json:"namespace"`
}

type hitResponse struct {
	Key      string         `json:"key"`
	Distance float32        `json:"distance"`
	Title    string         `json:"title,omitempty"`
	Content  string         `json:"content,omitempty"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

func buildApp(provider dependencyProvider, tier string) *apptheory.App {
	if provider == nil {
		provider = dependencyProviderFunc(func(context.Context) (*semanticDeps, error) {
			return nil, fmt.Errorf("semantic dependencies not configured")
		})
	}
	if strings.TrimSpace(tier) == "" {
		tier = "p2"
	}
	app := apptheory.New(apptheory.WithTier(apptheory.Tier(tier)))
	app.Get("/", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return health(ctx, provider)
	})
	app.Get("/health", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return health(ctx, provider)
	})
	app.Post("/seed", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return seed(ctx, provider)
	})
	app.Get("/search", func(ctx *apptheory.Context) (*apptheory.Response, error) {
		return search(ctx, provider)
	})
	return app
}

func health(ctx *apptheory.Context, provider dependencyProvider) (*apptheory.Response, error) {
	deps, err := provider.Get(ctx.Context())
	if err != nil {
		return jsonResponse(http.StatusOK, map[string]any{
			"ok":         false,
			"configured": false,
			"error":      err.Error(),
		})
	}
	return jsonResponse(http.StatusOK, map[string]any{
		"ok":                  true,
		"configured":          true,
		"dimension":           deps.Dimension,
		"embedding_model_id":  deps.ModelID,
		"embedding_normalize": deps.Normalize,
		"vector_bucket_name":  deps.VectorBucketName,
		"vector_index_name":   deps.IndexName,
	})
}

func seed(ctx *apptheory.Context, provider dependencyProvider) (*apptheory.Response, error) {
	deps, err := provider.Get(ctx.Context())
	if err != nil {
		return errorResponse(http.StatusInternalServerError, "example.invalid_config", err.Error())
	}
	tenant, namespace, err := seedScope(ctx)
	if err != nil {
		return errorResponse(http.StatusBadRequest, "example.invalid_seed_request", err.Error())
	}
	records := sampleRecords(tenant, namespace)
	semantic := vectorstore.SemanticIndex{Store: deps.Store, Embedder: deps.Embedder, Dimension: deps.Dimension, RequiredMetadataKeys: []string{"scope", "tenant", "namespace"}}
	if err := semantic.PutText(ctx.Context(), records); err != nil {
		return errorResponse(http.StatusBadGateway, vectorstore.EmbeddingErrorCode(err), err.Error())
	}
	keys := make([]string, 0, len(records))
	for _, record := range records {
		keys = append(keys, record.Key)
	}
	return jsonResponse(http.StatusOK, map[string]any{
		"seeded":             len(records),
		"keys":               keys,
		"tenant":             tenant,
		"namespace":          namespace,
		"vector_bucket_name": deps.VectorBucketName,
		"vector_index_name":  deps.IndexName,
	})
}

func search(ctx *apptheory.Context, provider dependencyProvider) (*apptheory.Response, error) {
	query := strings.TrimSpace(ctx.Query("q"))
	if query == "" {
		return errorResponse(http.StatusBadRequest, "example.missing_query", "search requires ?q=")
	}
	deps, err := provider.Get(ctx.Context())
	if err != nil {
		return errorResponse(http.StatusInternalServerError, "example.invalid_config", err.Error())
	}
	tenant := firstNonEmpty(ctx.Query("tenant"), defaultTenant)
	namespace := firstNonEmpty(ctx.Query("namespace"), defaultNamespace)
	topK, err := parseTopK(ctx.Query("top_k"))
	if err != nil {
		return errorResponse(http.StatusBadRequest, "example.invalid_top_k", err.Error())
	}
	semantic := vectorstore.SemanticIndex{Store: deps.Store, Embedder: deps.Embedder, Dimension: deps.Dimension}
	hits, err := semantic.QueryText(ctx.Context(), query, vectorstore.QueryInput{
		TopK:           topK,
		Filter:         map[string]any{"scope": metadataScope(tenant, namespace)},
		ReturnMetadata: true,
	})
	if err != nil {
		return errorResponse(http.StatusBadGateway, vectorstore.EmbeddingErrorCode(err), err.Error())
	}
	out := make([]hitResponse, 0, len(hits))
	for _, hit := range hits {
		out = append(out, hitResponse{
			Key:      hit.Key,
			Distance: hit.Distance,
			Title:    metadataString(hit.Metadata, "title"),
			Content:  metadataString(hit.Metadata, "content"),
			Metadata: hit.Metadata,
		})
	}
	return jsonResponse(http.StatusOK, map[string]any{
		"query":     query,
		"tenant":    tenant,
		"namespace": namespace,
		"top_k":     vectorstore.NormalizeTopK(topK),
		"count":     len(out),
		"hits":      out,
	})
}

func seedScope(ctx *apptheory.Context) (string, string, error) {
	req := seedRequest{}
	if len(ctx.Request.Body) > 0 {
		if err := json.Unmarshal(ctx.Request.Body, &req); err != nil {
			return "", "", fmt.Errorf("invalid JSON body")
		}
	}
	tenant := firstNonEmpty(ctx.Query("tenant"), req.Tenant, defaultTenant)
	namespace := firstNonEmpty(ctx.Query("namespace"), req.Namespace, defaultNamespace)
	if !safeScopePart(tenant) {
		return "", "", fmt.Errorf("tenant must contain only letters, numbers, dot, dash, or underscore")
	}
	if !safeScopePart(namespace) {
		return "", "", fmt.Errorf("namespace must contain only letters, numbers, dot, dash, or underscore")
	}
	return tenant, namespace, nil
}

func sampleRecords(tenant string, namespace string) []vectorstore.SemanticRecord {
	scope := metadataScope(tenant, namespace)
	samples := []struct {
		Slug    string
		Title   string
		Content string
	}{
		{
			Slug:    "runtime-contract",
			Title:   "Contract-first Lambda runtime",
			Content: "AppTheory normalizes Lambda events into one request model so Go, TypeScript, and Python handlers produce fixture-backed HTTP responses.",
		},
		{
			Slug:    "middleware-ordering",
			Title:   "Middleware ordering is part of the contract",
			Content: "Runtime tiers define the only valid middleware order. Applications choose P0, P1, or P2 instead of inserting bespoke middleware before request-id or tenant extraction.",
		},
		{
			Slug:    "semantic-recall",
			Title:   "S3 Vectors as semantic recall",
			Content: "S3 Vectors stores keyed embeddings and retrieval metadata. Canonical content and audit ledgers stay in TableTheory-backed or application-owned stores.",
		},
		{
			Slug:    "bedrock-embedding",
			Title:   "Bedrock Titan embeddings",
			Content: "The AppTheory helper invokes Amazon Titan Text Embeddings V2 through Bedrock with 1024 dimensions and normalized vectors for semantic queries.",
		},
	}
	records := make([]vectorstore.SemanticRecord, 0, len(samples))
	for idx, sample := range samples {
		key := fmt.Sprintf("%s/%s/%02d-%s", tenant, namespace, idx+1, sample.Slug)
		records = append(records, vectorstore.SemanticRecord{
			Key:  key,
			Text: sample.Title + ". " + sample.Content,
			Metadata: map[string]any{
				"scope":     scope,
				"tenant":    tenant,
				"namespace": namespace,
				"title":     sample.Title,
				"content":   sample.Content,
				"source":    "apptheory-example",
			},
		})
	}
	return records
}

func buildLiveDeps(ctx context.Context, env func(string) string) (*semanticDeps, error) {
	if env == nil {
		env = os.Getenv
	}
	bucketName := strings.TrimSpace(env(vectorstore.EnvVectorBucketName))
	indexName := strings.TrimSpace(env(vectorstore.EnvVectorIndexName))
	if bucketName == "" || indexName == "" {
		return nil, fmt.Errorf("%s and %s are required", vectorstore.EnvVectorBucketName, vectorstore.EnvVectorIndexName)
	}
	dimension, err := parsePositiveInt(env(vectorstore.EnvVectorDimension), vectorstore.EnvVectorDimension)
	if err != nil {
		return nil, err
	}
	if rawEmbeddingDimension := strings.TrimSpace(env(vectorstore.EnvEmbeddingDimensions)); rawEmbeddingDimension != "" {
		embeddingDimension, err := parsePositiveInt(rawEmbeddingDimension, vectorstore.EnvEmbeddingDimensions)
		if err != nil {
			return nil, err
		}
		if embeddingDimension != dimension {
			return nil, fmt.Errorf("%s must match %s", vectorstore.EnvEmbeddingDimensions, vectorstore.EnvVectorDimension)
		}
	}
	normalize, err := parseBoolDefault(env(vectorstore.EnvEmbeddingNormalize), true, vectorstore.EnvEmbeddingNormalize)
	if err != nil {
		return nil, err
	}
	modelID := strings.TrimSpace(env(vectorstore.EnvEmbeddingModelID))
	if modelID == "" {
		modelID = vectorstore.DefaultTitanEmbedTextModelID
	}
	embedder, err := vectorstore.NewTitanEmbedder(ctx)
	if err != nil {
		return nil, fmt.Errorf("configure Bedrock runtime: %w", err)
	}
	embedder.ModelID = modelID
	embedder.Dimensions = dimension
	embedder.Normalize = normalize
	store, err := vectorstore.NewS3VectorStore(ctx, bucketName, indexName, dimension)
	if err != nil {
		return nil, fmt.Errorf("configure S3 Vectors: %w", err)
	}
	return &semanticDeps{Store: store, Embedder: embedder, Dimension: dimension, VectorBucketName: bucketName, IndexName: indexName, ModelID: modelID, Normalize: normalize}, nil
}

func parseTopK(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 3, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("top_k must be a positive integer")
	}
	return vectorstore.NormalizeTopK(value), nil
}

func parsePositiveInt(raw string, name string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, fmt.Errorf("%s is required", name)
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return value, nil
}

func parseBoolDefault(raw string, fallback bool, name string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return fallback, nil
	case "1", "true", "t", "yes", "y":
		return true, nil
	case "0", "false", "f", "no", "n":
		return false, nil
	default:
		return false, fmt.Errorf("%s must be true or false", name)
	}
}

func metadataScope(tenant string, namespace string) string {
	return strings.TrimSpace(tenant) + "/" + strings.TrimSpace(namespace)
}

func metadataString(metadata map[string]any, key string) string {
	if len(metadata) == 0 {
		return ""
	}
	value, ok := metadata[key]
	if !ok {
		return ""
	}
	if s, ok := value.(string); ok {
		return strings.TrimSpace(s)
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func safeScopePart(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 63 {
		return false
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			continue
		}
		return false
	}
	return true
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			return value
		}
	}
	return ""
}

func jsonResponse(status int, value any) (*apptheory.Response, error) {
	return apptheory.JSON(status, value)
}

func errorResponse(status int, code string, message string) (*apptheory.Response, error) {
	return jsonResponse(status, map[string]any{"error": map[string]any{"code": code, "message": message}})
}

func main() {
	app := buildApp(&liveProvider{env: os.Getenv}, firstNonEmpty(os.Getenv("APPTHEORY_TIER"), "p2"))
	lambda.Start(func(ctx context.Context, event json.RawMessage) (any, error) {
		return app.HandleLambda(ctx, event)
	})
}
