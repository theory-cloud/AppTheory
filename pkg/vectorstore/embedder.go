package vectorstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
)

type FakeEmbedder struct {
	Embeddings map[string][]float32
	Default    []float32
	Calls      []string
}

func NewFakeEmbedder(embeddings map[string][]float32) *FakeEmbedder {
	cloned := make(map[string][]float32, len(embeddings))
	for key, value := range embeddings {
		cloned[key] = CloneVector(value)
	}
	return &FakeEmbedder{Embeddings: cloned}
}

func (e *FakeEmbedder) Embed(_ context.Context, text string) ([]float32, error) {
	if e == nil {
		return nil, ErrInvalidConfig
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, NewError(ErrorCodeInvalidInput, "vectorstore: embedding input is required", nil)
	}
	e.Calls = append(e.Calls, text)
	if vector, ok := e.Embeddings[text]; ok {
		return CloneVector(vector), nil
	}
	if e.Default != nil {
		return CloneVector(e.Default), nil
	}
	return nil, NewError(ErrorCodeEmbeddingFailed, "vectorstore: embedding not found", nil)
}

func (e *FakeEmbedder) EmbedBatch(ctx context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	for i, text := range texts {
		vector, err := e.Embed(ctx, text)
		if err != nil {
			return nil, err
		}
		out[i] = vector
	}
	return out, nil
}

type BedrockRuntimeAPI interface {
	InvokeModel(context.Context, *bedrockruntime.InvokeModelInput, ...func(*bedrockruntime.Options)) (*bedrockruntime.InvokeModelOutput, error)
}

type TitanEmbedder struct {
	Runtime          BedrockRuntimeAPI
	ModelID          string
	Dimensions       int
	Normalize        bool
	BatchConcurrency int
}

func NewTitanEmbedder(ctx context.Context) (*TitanEmbedder, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, err
	}
	return &TitanEmbedder{Runtime: bedrockruntime.NewFromConfig(cfg), ModelID: DefaultTitanEmbedTextModelID, Dimensions: DefaultEmbeddingDimensions, Normalize: true, BatchConcurrency: 16}, nil
}

type titanEmbedRequest struct {
	InputText  string `json:"inputText"`
	Dimensions int    `json:"dimensions,omitempty"`
	Normalize  bool   `json:"normalize,omitempty"`
}

type titanEmbedResponse struct {
	Embedding []float32 `json:"embedding"`
}

func (e *TitanEmbedder) Embed(ctx context.Context, text string) ([]float32, error) {
	if e == nil || e.Runtime == nil {
		return nil, NewError(ErrorCodeInvalidConfig, "vectorstore: bedrock runtime client is required", nil)
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, NewError(ErrorCodeInvalidInput, "vectorstore: embedding input is required", nil)
	}
	dimensions := e.Dimensions
	if dimensions <= 0 {
		dimensions = DefaultEmbeddingDimensions
	}
	body, err := json.Marshal(titanEmbedRequest{InputText: text, Dimensions: dimensions, Normalize: e.Normalize})
	if err != nil {
		return nil, NewError(ErrorCodeEmbeddingFailed, "vectorstore: marshal embedding request", err)
	}
	modelID := strings.TrimSpace(e.ModelID)
	if modelID == "" {
		modelID = DefaultTitanEmbedTextModelID
	}
	out, err := e.Runtime.InvokeModel(ctx, &bedrockruntime.InvokeModelInput{ModelId: aws.String(modelID), ContentType: aws.String("application/json"), Accept: aws.String("application/json"), Body: body})
	if err != nil {
		return nil, NewError(ErrorCodeEmbeddingFailed, "vectorstore: bedrock embedding request failed", err)
	}
	var decoded titanEmbedResponse
	if err := json.Unmarshal(out.Body, &decoded); err != nil {
		return nil, NewError(ErrorCodeEmbeddingFailed, "vectorstore: parse embedding response", err)
	}
	if len(decoded.Embedding) == 0 {
		return nil, NewError(ErrorCodeEmbeddingFailed, "vectorstore: missing embedding in response", nil)
	}
	if len(decoded.Embedding) != dimensions {
		return nil, NewError(ErrorCodeDimensionMismatch, fmt.Sprintf("vectorstore: embedding dimension mismatch: got %d want %d", len(decoded.Embedding), dimensions), nil)
	}
	return decoded.Embedding, nil
}

func (e *TitanEmbedder) EmbedBatch(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return [][]float32{}, nil
	}
	concurrency := e.BatchConcurrency
	if concurrency <= 1 {
		concurrency = 1
	}
	if concurrency > len(texts) {
		concurrency = len(texts)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make([][]float32, len(texts))
	type job struct {
		index int
		text  string
	}
	jobs := make(chan job)
	errCh := make(chan error, 1)
	var wg sync.WaitGroup
	for worker := 0; worker < concurrency; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				vector, err := e.Embed(ctx, j.text)
				if err != nil {
					select {
					case errCh <- err:
						cancel()
					default:
					}
					return
				}
				results[j.index] = vector
			}
		}()
	}
	for i, text := range texts {
		select {
		case jobs <- job{index: i, text: text}:
		case err := <-errCh:
			close(jobs)
			wg.Wait()
			return nil, err
		case <-ctx.Done():
			close(jobs)
			wg.Wait()
			select {
			case err := <-errCh:
				return nil, err
			default:
				return nil, ctx.Err()
			}
		}
	}
	close(jobs)
	wg.Wait()
	select {
	case err := <-errCh:
		return nil, err
	default:
	}
	return results, nil
}

func EmbeddingErrorCode(err error) string {
	if err == nil {
		return ""
	}
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ErrorCodeEmbeddingFailed
}
