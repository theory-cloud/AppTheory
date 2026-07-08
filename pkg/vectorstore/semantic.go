package vectorstore

import (
	"context"
	"strings"
)

type SemanticRecord struct {
	Key      string
	Text     string
	Metadata map[string]any
}

type SemanticIndex struct {
	Store                Store
	Embedder             Embedder
	Dimension            int
	RequiredMetadataKeys []string
}

func (i *SemanticIndex) PutText(ctx context.Context, records []SemanticRecord) error {
	if i == nil || i.Store == nil || i.Embedder == nil {
		return ErrInvalidConfig
	}
	if len(records) == 0 {
		return NewError(ErrorCodeInvalidInput, "vectorstore: at least one semantic record is required", nil)
	}
	texts := make([]string, 0, len(records))
	for _, record := range records {
		if err := ValidateKey(record.Key); err != nil {
			return err
		}
		if strings.TrimSpace(record.Text) == "" {
			return NewError(ErrorCodeInvalidInput, "vectorstore: semantic text is required", nil)
		}
		if err := ValidateRequiredMetadata(record.Metadata, i.RequiredMetadataKeys); err != nil {
			return err
		}
		texts = append(texts, record.Text)
	}
	embeddings, err := i.Embedder.EmbedBatch(ctx, texts)
	if err != nil {
		return err
	}
	if len(embeddings) != len(records) {
		return NewError(ErrorCodeEmbeddingFailed, "vectorstore: embedding count mismatch", nil)
	}
	vectors := make([]VectorRecord, 0, len(records))
	for idx, record := range records {
		if err := ValidateVector(embeddings[idx], i.Dimension); err != nil {
			return err
		}
		vectors = append(vectors, VectorRecord{Key: record.Key, Data: embeddings[idx], Metadata: CloneMetadata(record.Metadata)})
	}
	return i.Store.PutVectors(ctx, PutInput{Records: vectors})
}

func (i *SemanticIndex) QueryText(ctx context.Context, text string, input QueryInput) ([]QueryHit, error) {
	if i == nil || i.Store == nil || i.Embedder == nil {
		return nil, ErrInvalidConfig
	}
	if strings.TrimSpace(text) == "" {
		return nil, NewError(ErrorCodeInvalidInput, "vectorstore: query text is required", nil)
	}
	vector, err := i.Embedder.Embed(ctx, text)
	if err != nil {
		return nil, err
	}
	if err := ValidateVector(vector, i.Dimension); err != nil {
		return nil, err
	}
	input.Vector = vector
	return i.Store.QueryVectors(ctx, input)
}
