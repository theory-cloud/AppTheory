package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"

	vstore "github.com/theory-cloud/apptheory/v2/pkg/vectorstore"
)

type FixtureVectorStoreSetup struct {
	Backend              string                 `json:"backend,omitempty"`
	Dimension            int                    `json:"dimension,omitempty"`
	RequiredMetadataKeys []string               `json:"required_metadata_keys,omitempty"`
	Embeddings           map[string][]float32   `json:"embeddings,omitempty"`
	DefaultEmbedding     []float32              `json:"default_embedding,omitempty"`
	Titan                FixtureVectorTitanStub `json:"titan,omitempty"`
}

type FixtureVectorTitanStub struct {
	Embedding []float32 `json:"embedding,omitempty"`
}

type FixtureVectorStoreInput struct {
	Steps []FixtureVectorStoreStep `json:"steps"`
}

type FixtureVectorStoreStep struct {
	Name           string                `json:"name"`
	Operation      string                `json:"operation"`
	Records        []FixtureVectorRecord `json:"records,omitempty"`
	Keys           []string              `json:"keys,omitempty"`
	Vector         []float32             `json:"vector,omitempty"`
	TopK           int                   `json:"top_k,omitempty"`
	Filter         map[string]any        `json:"filter,omitempty"`
	ReturnMetadata bool                  `json:"return_metadata,omitempty"`
	Text           string                `json:"text,omitempty"`
	ModelID        string                `json:"model_id,omitempty"`
	Dimensions     int                   `json:"dimensions,omitempty"`
	Normalize      *bool                 `json:"normalize,omitempty"`
}

type FixtureVectorRecord struct {
	Key      string         `json:"key"`
	Data     []float32      `json:"data,omitempty"`
	Text     string         `json:"text,omitempty"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

type fakeBedrockRuntime struct {
	embedding []float32
	requests  []map[string]any
}

func (f *fakeBedrockRuntime) InvokeModel(_ context.Context, params *bedrockruntime.InvokeModelInput, _ ...func(*bedrockruntime.Options)) (*bedrockruntime.InvokeModelOutput, error) {
	var body map[string]any
	if err := json.Unmarshal(params.Body, &body); err != nil {
		return nil, err
	}
	body["model_id"] = aws.ToString(params.ModelId)
	body["content_type"] = aws.ToString(params.ContentType)
	body["accept"] = aws.ToString(params.Accept)
	f.requests = append(f.requests, body)
	payload, err := json.Marshal(map[string]any{"embedding": f.embedding})
	if err != nil {
		return nil, err
	}
	return &bedrockruntime.InvokeModelOutput{Body: payload}, nil
}

func runFixtureVectorStore(f Fixture) error {
	backend := strings.TrimSpace(f.Setup.VectorStore.Backend)
	if backend == "" {
		backend = fixtureBackendFake
	}
	if backend != fixtureBackendFake {
		return fmt.Errorf("vectorstore fixture backend %q is unsupported", backend)
	}
	if len(f.Input.VectorStore.Steps) == 0 {
		return errors.New("vectorstore fixture missing input.vectorstore.steps")
	}
	dimension := f.Setup.VectorStore.Dimension
	if dimension <= 0 {
		dimension = 3
	}
	store := vstore.NewFakeStore(dimension)
	store.RequiredMetadataKeys = append([]string(nil), f.Setup.VectorStore.RequiredMetadataKeys...)
	embedder := vstore.NewFakeEmbedder(f.Setup.VectorStore.Embeddings)
	embedder.Default = vstore.CloneVector(f.Setup.VectorStore.DefaultEmbedding)
	steps := make([]map[string]any, 0, len(f.Input.VectorStore.Steps))
	for _, step := range f.Input.VectorStore.Steps {
		steps = append(steps, runVectorStoreStep(store, embedder, f.Setup.VectorStore, dimension, step))
	}
	out := map[string]any{"steps": steps, "calls": vectorStoreCallsJSON(store.Calls()), "embedder_calls": append([]string{}, embedder.Calls...)}
	return compareFixtureOutputJSON(f, out)
}

func runVectorStoreStep(store *vstore.FakeStore, embedder *vstore.FakeEmbedder, setup FixtureVectorStoreSetup, dimension int, step FixtureVectorStoreStep) map[string]any {
	operation := strings.TrimSpace(strings.ToLower(step.Operation))
	result := map[string]any{"name": step.Name, "operation": operation}
	err := applyVectorStoreStep(result, store, embedder, setup, dimension, step, operation)
	if err != nil {
		result["ok"] = false
		result["error"] = vectorStoreErrorJSON(err)
		return result
	}
	result["ok"] = true
	return result
}

func applyVectorStoreStep(result map[string]any, store *vstore.FakeStore, embedder *vstore.FakeEmbedder, setup FixtureVectorStoreSetup, dimension int, step FixtureVectorStoreStep, operation string) error {
	switch operation {
	case "put":
		return store.PutVectors(context.Background(), vstore.PutInput{Records: vectorRecords(step.Records)})
	case "get":
		return runVectorStoreGet(result, store, step)
	case "delete":
		return store.DeleteVectors(context.Background(), vstore.DeleteInput{Keys: step.Keys})
	case "query":
		return runVectorStoreQuery(result, store, step)
	case "semantic_put":
		idx := &vstore.SemanticIndex{Store: store, Embedder: embedder, Dimension: dimension, RequiredMetadataKeys: setup.RequiredMetadataKeys}
		return idx.PutText(context.Background(), semanticRecords(step.Records))
	case "semantic_query":
		return runVectorStoreSemanticQuery(result, store, embedder, setup, dimension, step)
	case "titan_embed":
		return runVectorStoreTitanEmbed(result, setup, dimension, step)
	default:
		return fmt.Errorf("vectorstore: unsupported operation: %s", operation)
	}
}

func runVectorStoreGet(result map[string]any, store *vstore.FakeStore, step FixtureVectorStoreStep) error {
	records, err := store.GetVectors(context.Background(), vstore.GetInput{Keys: step.Keys, ReturnMetadata: step.ReturnMetadata})
	if err == nil {
		result["records"] = vectorRecordsJSON(records, true)
	}
	return err
}

func runVectorStoreQuery(result map[string]any, store *vstore.FakeStore, step FixtureVectorStoreStep) error {
	hits, err := store.QueryVectors(context.Background(), vstore.QueryInput{Vector: step.Vector, TopK: step.TopK, Filter: step.Filter, ReturnMetadata: step.ReturnMetadata})
	if err == nil {
		result["hits"] = vectorHitsJSON(hits)
	}
	return err
}

func runVectorStoreSemanticQuery(result map[string]any, store *vstore.FakeStore, embedder *vstore.FakeEmbedder, setup FixtureVectorStoreSetup, dimension int, step FixtureVectorStoreStep) error {
	idx := &vstore.SemanticIndex{Store: store, Embedder: embedder, Dimension: dimension, RequiredMetadataKeys: setup.RequiredMetadataKeys}
	hits, err := idx.QueryText(context.Background(), step.Text, vstore.QueryInput{TopK: step.TopK, Filter: step.Filter, ReturnMetadata: step.ReturnMetadata})
	if err == nil {
		result["hits"] = vectorHitsJSON(hits)
	}
	return err
}

func runVectorStoreTitanEmbed(result map[string]any, setup FixtureVectorStoreSetup, dimension int, step FixtureVectorStoreStep) error {
	embedding := setup.Titan.Embedding
	if embedding == nil {
		embedding = setup.DefaultEmbedding
	}
	fake := &fakeBedrockRuntime{embedding: embedding}
	dimensions := step.Dimensions
	if dimensions == 0 {
		dimensions = dimension
	}
	emb := &vstore.TitanEmbedder{Runtime: fake, ModelID: step.ModelID, Dimensions: dimensions, Normalize: vectorStoreStepNormalize(step)}
	vector, err := emb.Embed(context.Background(), step.Text)
	if err == nil {
		result["vector"] = vector
		result["requests"] = fake.requests
	}
	return err
}

func vectorStoreStepNormalize(step FixtureVectorStoreStep) bool {
	if step.Normalize == nil {
		return true
	}
	return *step.Normalize
}

func vectorRecords(in []FixtureVectorRecord) []vstore.VectorRecord {
	out := make([]vstore.VectorRecord, 0, len(in))
	for _, record := range in {
		out = append(out, vstore.VectorRecord{Key: record.Key, Data: vstore.CloneVector(record.Data), Metadata: vstore.CloneMetadata(record.Metadata)})
	}
	return out
}

func semanticRecords(in []FixtureVectorRecord) []vstore.SemanticRecord {
	out := make([]vstore.SemanticRecord, 0, len(in))
	for _, record := range in {
		out = append(out, vstore.SemanticRecord{Key: record.Key, Text: record.Text, Metadata: vstore.CloneMetadata(record.Metadata)})
	}
	return out
}

func vectorStoreErrorJSON(err error) map[string]string {
	code := "vectorstore.error"
	var ve *vstore.Error
	if errors.As(err, &ve) && ve.Code != "" {
		code = ve.Code
	}
	if strings.HasPrefix(err.Error(), "vectorstore: unsupported operation") {
		code = vstore.ErrorCodeUnsupportedOperation
	}
	return map[string]string{"code": code, "message": err.Error()}
}

func vectorStoreCallsJSON(calls []vstore.Call) []map[string]any {
	out := make([]map[string]any, 0, len(calls))
	for _, call := range calls {
		item := map[string]any{"operation": call.Operation}
		if len(call.Keys) > 0 {
			item["keys"] = append([]string(nil), call.Keys...)
		}
		if len(call.Records) > 0 {
			item["records"] = vectorRecordsJSON(call.Records, true)
		}
		if len(call.Vector) > 0 {
			item["vector"] = call.Vector
		}
		if call.TopK != 0 {
			item["top_k"] = call.TopK
		}
		if len(call.Filter) > 0 {
			item["filter"] = sortedMap(call.Filter)
		}
		if call.ReturnMetadata {
			item["return_metadata"] = call.ReturnMetadata
		}
		out = append(out, item)
	}
	return out
}

func vectorRecordsJSON(records []vstore.VectorRecord, includeMetadata bool) []map[string]any {
	out := make([]map[string]any, 0, len(records))
	for _, record := range records {
		item := map[string]any{"key": record.Key, "data": record.Data}
		if includeMetadata && len(record.Metadata) > 0 {
			item["metadata"] = sortedMap(record.Metadata)
		}
		out = append(out, item)
	}
	return out
}

func vectorHitsJSON(hits []vstore.QueryHit) []map[string]any {
	out := make([]map[string]any, 0, len(hits))
	for _, hit := range hits {
		item := map[string]any{"key": hit.Key, "distance": hit.Distance}
		if len(hit.Metadata) > 0 {
			item["metadata"] = sortedMap(hit.Metadata)
		}
		out = append(out, item)
	}
	return out
}

func sortedMap(in map[string]any) map[string]any {
	if len(in) == 0 {
		return nil
	}
	keys := make([]string, 0, len(in))
	for k := range in {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make(map[string]any, len(in))
	for _, k := range keys {
		out[k] = in[k]
	}
	return out
}
