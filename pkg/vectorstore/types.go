package vectorstore

import "context"

const (
	EnvVectorBucketName          = "APPTHEORY_VECTOR_BUCKET_NAME"
	EnvVectorIndexName           = "APPTHEORY_VECTOR_INDEX_NAME"
	EnvVectorIndexARN            = "APPTHEORY_VECTOR_INDEX_ARN"
	EnvVectorDimension           = "APPTHEORY_VECTOR_DIMENSION"
	EnvEmbeddingProvider         = "APPTHEORY_EMBEDDING_PROVIDER"
	EnvEmbeddingModelID          = "APPTHEORY_EMBEDDING_MODEL_ID"
	EnvEmbeddingDimensions       = "APPTHEORY_EMBEDDING_DIMENSIONS"
	EnvEmbeddingNormalize        = "APPTHEORY_EMBEDDING_NORMALIZE"
	DefaultTitanEmbedTextModelID = "amazon.titan-embed-text-v2:0"
)

const (
	DefaultEmbeddingDimensions = 1024
	DefaultQueryTopK           = 12
	MaxQueryTopK               = 10000
	MaxPutDeleteBatchSize      = 500
)

type VectorRecord struct {
	Key      string         `json:"key"`
	Data     []float32      `json:"data"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

type PutInput struct {
	Records []VectorRecord
}

type GetInput struct {
	Keys           []string
	ReturnMetadata bool
}

type DeleteInput struct {
	Keys []string
}

type QueryInput struct {
	Vector         []float32
	TopK           int
	Filter         map[string]any
	ReturnMetadata bool
}

type QueryHit struct {
	Key      string         `json:"key"`
	Distance float32        `json:"distance"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

type Call struct {
	Operation      string
	Keys           []string
	Records        []VectorRecord
	Vector         []float32
	TopK           int
	Filter         map[string]any
	ReturnMetadata bool
}

type Store interface {
	PutVectors(context.Context, PutInput) error
	GetVectors(context.Context, GetInput) ([]VectorRecord, error)
	DeleteVectors(context.Context, DeleteInput) error
	QueryVectors(context.Context, QueryInput) ([]QueryHit, error)
}

type Embedder interface {
	Embed(context.Context, string) ([]float32, error)
	EmbedBatch(context.Context, []string) ([][]float32, error)
}

func CloneVector(in []float32) []float32 {
	if in == nil {
		return nil
	}
	out := make([]float32, len(in))
	copy(out, in)
	return out
}

func CloneMetadata(in map[string]any) map[string]any {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = cloneMetadataValue(v)
	}
	return out
}

func cloneMetadataValue(v any) any {
	switch typed := v.(type) {
	case []string:
		out := make([]string, len(typed))
		copy(out, typed)
		return out
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = cloneMetadataValue(item)
		}
		return out
	case map[string]any:
		return CloneMetadata(typed)
	default:
		return typed
	}
}
