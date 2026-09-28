package vectorstore

import (
	"context"
	"encoding/json"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
)

// This file holds the strict (join-dominance) test for the
// (TitanEmbedder).EmbedBatch baseline entry: the batch's worker pool is joined by
// its WaitGroup before EmbedBatch returns. Each worker's embed call lingers, so
// removing the WaitGroup wait makes EmbedBatch return before its workers
// finished, which the elapsed-time and completion-count assertions catch.

// lingeringBedrockRuntime delays every InvokeModel call and records how many
// completed, so a batch that returned early is observable.
type lingeringBedrockRuntime struct {
	linger time.Duration
	done   atomic.Int64

	mu     sync.Mutex
	inputs []*bedrockruntime.InvokeModelInput
}

func (r *lingeringBedrockRuntime) InvokeModel(_ context.Context, input *bedrockruntime.InvokeModelInput, _ ...func(*bedrockruntime.Options)) (*bedrockruntime.InvokeModelOutput, error) {
	time.Sleep(r.linger)

	body, err := json.Marshal(titanEmbedResponse{Embedding: []float32{0.5, 0.25}})
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	r.inputs = append(r.inputs, input)
	r.mu.Unlock()
	r.done.Add(1)
	return &bedrockruntime.InvokeModelOutput{Body: body}, nil
}

func TestTitanEmbedBatchWaitsForItsWorkers(t *testing.T) {
	const linger = 200 * time.Millisecond
	runtime := &lingeringBedrockRuntime{linger: linger}
	embedder := &TitanEmbedder{Runtime: runtime, Dimensions: 2, Normalize: true, BatchConcurrency: 2}

	started := time.Now()
	vectors, err := embedder.EmbedBatch(context.Background(), []string{"alpha", "beta"})
	elapsed := time.Since(started)

	if err != nil {
		t.Fatalf("EmbedBatch: %v", err)
	}
	if elapsed < linger/2 {
		t.Fatalf("EmbedBatch returned after %s, before its workers finished (linger %s)", elapsed, linger)
	}
	if finished := runtime.done.Load(); finished != 2 {
		t.Fatalf("EmbedBatch returned with %d of 2 workers finished", finished)
	}
	if len(vectors) != 2 {
		t.Fatalf("EmbedBatch returned %d vectors, want 2", len(vectors))
	}
	want := []float32{0.5, 0.25}
	for i, vector := range vectors {
		if !reflect.DeepEqual(vector, want) {
			t.Fatalf("vector %d = %v, want %v", i, vector, want)
		}
	}
	runtime.mu.Lock()
	calls := len(runtime.inputs)
	runtime.mu.Unlock()
	if calls != 2 {
		t.Fatalf("EmbedBatch issued %d model calls, want 2", calls)
	}
}
