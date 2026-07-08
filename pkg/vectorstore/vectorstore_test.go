package vectorstore

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/aws/aws-sdk-go-v2/service/s3vectors"
	s3document "github.com/aws/aws-sdk-go-v2/service/s3vectors/document"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3vectors/types"
)

func TestFakeStorePutQueryGetDeleteAndClones(t *testing.T) {
	ctx := context.Background()
	store := NewFakeStore(3)
	store.RequiredMetadataKeys = []string{"tenant"}

	if err := store.PutVectors(ctx, PutInput{Records: []VectorRecord{
		{Key: "alpha", Data: []float32{1, 0, 0}, Metadata: map[string]any{"tenant": "t1", "tags": []string{"runtime", "contract"}}},
		{Key: "beta", Data: []float32{0, 1, 0}, Metadata: map[string]any{"tenant": "t1", "tags": []any{"search", "contract"}}},
		{Key: "gamma", Data: []float32{0, 0, 1}, Metadata: map[string]any{"tenant": "t2", "tags": []string{"other"}}},
	}}); err != nil {
		t.Fatalf("PutVectors() error = %v", err)
	}

	hits, err := store.QueryVectors(ctx, QueryInput{
		Vector:         []float32{1, 0, 0},
		TopK:           2,
		Filter:         map[string]any{"tenant": "t1", "tags": "contract"},
		ReturnMetadata: true,
	})
	if err != nil {
		t.Fatalf("QueryVectors() error = %v", err)
	}
	if got, want := []string{hits[0].Key, hits[1].Key}, []string{"alpha", "beta"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("QueryVectors() keys = %#v, want %#v", got, want)
	}
	if hits[0].Distance != 0 {
		t.Fatalf("first distance = %v, want 0", hits[0].Distance)
	}
	hits[0].Metadata["tenant"] = "mutated"

	records, err := store.GetVectors(ctx, GetInput{Keys: []string{"alpha"}, ReturnMetadata: true})
	if err != nil {
		t.Fatalf("GetVectors() error = %v", err)
	}
	if got := records[0].Metadata["tenant"]; got != "t1" {
		t.Fatalf("metadata was not cloned, got tenant %v", got)
	}
	records[0].Data[0] = 99

	records, err = store.GetVectors(ctx, GetInput{Keys: []string{"alpha"}})
	if err != nil {
		t.Fatalf("GetVectors() without metadata error = %v", err)
	}
	if records[0].Metadata != nil {
		t.Fatalf("GetVectors() metadata = %#v, want nil", records[0].Metadata)
	}
	if records[0].Data[0] != 1 {
		t.Fatalf("record vector was not cloned, got %v", records[0].Data)
	}

	calls := store.Calls()
	if got, want := calls[1].Operation, "QueryVectors"; got != want {
		t.Fatalf("Calls()[1].Operation = %q, want %q", got, want)
	}
	calls[0].Records[0].Data[0] = 99
	if got := store.Calls()[0].Records[0].Data[0]; got != 1 {
		t.Fatalf("call log was not cloned, got %v", got)
	}

	sentinel := errors.New("forced query failure")
	store.SetError("QueryVectors", sentinel)
	if _, err := store.QueryVectors(ctx, QueryInput{Vector: []float32{1, 0, 0}}); !errors.Is(err, sentinel) {
		t.Fatalf("QueryVectors() forced error = %v, want %v", err, sentinel)
	}
	store.SetError("QueryVectors", nil)

	if err := store.DeleteVectors(ctx, DeleteInput{Keys: []string{"alpha"}}); err != nil {
		t.Fatalf("DeleteVectors() error = %v", err)
	}
	if _, err := store.GetVectors(ctx, GetInput{Keys: []string{"alpha"}}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetVectors() after delete error = %v, want ErrNotFound", err)
	}
}

func TestValidationErrorsAndCloningFailClosed(t *testing.T) {
	cause := errors.New("cause")
	err := NewError(ErrorCodeNotFound, "", cause)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("errors.Is(%v, ErrNotFound) = false", err)
	}
	if !errors.Is(err, cause) {
		t.Fatalf("wrapped cause was not preserved")
	}
	var nilVectorError *Error
	if nilVectorError.Error() != "" || nilVectorError.Unwrap() != nil {
		t.Fatalf("nil Error methods must be safe")
	}

	if err := ValidateDimension(0); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("ValidateDimension(0) = %v, want ErrInvalidConfig", err)
	}
	if err := ValidateVector(nil, 0); !errors.Is(err, ErrInvalidVector) {
		t.Fatalf("ValidateVector(nil) = %v, want ErrInvalidVector", err)
	}
	if err := ValidateVector([]float32{1}, 2); !errors.Is(err, ErrDimensionMismatch) {
		t.Fatalf("ValidateVector(dimension mismatch) = %v, want ErrDimensionMismatch", err)
	}
	if err := ValidateVector([]float32{float32(math.Inf(1))}, 0); !errors.Is(err, ErrInvalidVector) {
		t.Fatalf("ValidateVector(inf) = %v, want ErrInvalidVector", err)
	}
	if err := ValidateKey(" key"); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("ValidateKey(leading space) = %v, want ErrInvalidInput", err)
	}
	if got := NormalizeTopK(0); got != DefaultQueryTopK {
		t.Fatalf("NormalizeTopK(0) = %d, want %d", got, DefaultQueryTopK)
	}
	if got := NormalizeTopK(MaxQueryTopK + 1); got != MaxQueryTopK {
		t.Fatalf("NormalizeTopK(max+1) = %d, want %d", got, MaxQueryTopK)
	}

	for name, metadata := range map[string]map[string]any{
		"missing":  nil,
		"blank":    {"tenant": " "},
		"empty":    {"tenant": []string{}},
		"emptyAny": {"tenant": []any{}},
	} {
		if err := ValidateRequiredMetadata(metadata, []string{" ", "tenant"}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("%s ValidateRequiredMetadata() = %v, want ErrInvalidInput", name, err)
		}
	}

	metadata := CloneMetadata(map[string]any{
		"tags":   []string{"a"},
		"nested": map[string]any{"items": []any{"one"}},
	})
	requireStringSlice(t, metadata["tags"])[0] = "changed"
	requireAnySlice(t, requireMap(t, metadata["nested"])["items"])[0] = "changed"
	again := CloneMetadata(map[string]any{
		"tags":   []string{"a"},
		"nested": map[string]any{"items": []any{"one"}},
	})
	if got := requireStringSlice(t, again["tags"])[0]; got != "a" {
		t.Fatalf("CloneMetadata() did not clone []string, got %q", got)
	}
	if got := requireAnySlice(t, requireMap(t, again["nested"])["items"])[0]; got != "one" {
		t.Fatalf("CloneMetadata() did not clone nested []any, got %q", got)
	}
	if got := EmbeddingErrorCode(nil); got != "" {
		t.Fatalf("EmbeddingErrorCode(nil) = %q, want empty", got)
	}
	if got := EmbeddingErrorCode(errors.New("plain")); got != ErrorCodeEmbeddingFailed {
		t.Fatalf("EmbeddingErrorCode(plain) = %q, want %q", got, ErrorCodeEmbeddingFailed)
	}
}

func TestS3VectorStoreCommandsBatchingAndDecoding(t *testing.T) {
	ctx := context.Background()
	client := &recordingS3VectorsClient{
		queryOutput: &s3vectors.QueryVectorsOutput{Vectors: []s3types.QueryOutputVector{{
			Key:      aws.String("alpha"),
			Distance: aws.Float32(0.25),
			Metadata: s3document.NewLazyDocument(map[string]any{"tenant": "t1"}),
		}}},
		getOutput: &s3vectors.GetVectorsOutput{Vectors: []s3types.GetOutputVector{{
			Key:      aws.String("alpha"),
			Data:     &s3types.VectorDataMemberFloat32{Value: []float32{1, 0}},
			Metadata: s3document.NewLazyDocument(map[string]any{"tenant": "t1"}),
		}}},
	}
	store := &S3VectorStore{Client: client, VectorBucketName: "vectors", IndexName: "semantic", Dimension: 2, MaxBatchSize: 1}

	err := store.PutVectors(ctx, PutInput{Records: []VectorRecord{
		{Key: "alpha", Data: []float32{1, 0}, Metadata: map[string]any{"tenant": "t1"}},
		{Key: "beta", Data: []float32{0, 1}},
	}})
	if err != nil {
		t.Fatalf("PutVectors() error = %v", err)
	}
	if len(client.putInputs) != 2 {
		t.Fatalf("PutVectors() batches = %d, want 2", len(client.putInputs))
	}
	firstPut := client.putInputs[0]
	if got := aws.ToString(firstPut.VectorBucketName); got != "vectors" {
		t.Fatalf("VectorBucketName = %q, want vectors", got)
	}
	if got := requireFloat32VectorData(t, firstPut.Vectors[0].Data); !reflect.DeepEqual(got, []float32{1, 0}) {
		t.Fatalf("put vector data = %#v", got)
	}
	putMetadata := map[string]any{}
	rawPutMetadata, err := firstPut.Vectors[0].Metadata.MarshalSmithyDocument()
	if err != nil {
		t.Fatalf("put metadata marshal error = %v", err)
	}
	if unmarshalErr := json.Unmarshal(rawPutMetadata, &putMetadata); unmarshalErr != nil {
		t.Fatalf("put metadata JSON error = %v", unmarshalErr)
	}
	if got := putMetadata["tenant"]; got != "t1" {
		t.Fatalf("put metadata tenant = %v, want t1", got)
	}

	hits, err := store.QueryVectors(ctx, QueryInput{
		Vector:         []float32{1, 0},
		TopK:           MaxQueryTopK + 50,
		Filter:         map[string]any{"tenant": "t1"},
		ReturnMetadata: true,
	})
	if err != nil {
		t.Fatalf("QueryVectors() error = %v", err)
	}
	if got := aws.ToInt32(client.queryInputs[0].TopK); got != int32(MaxQueryTopK) {
		t.Fatalf("QueryVectors() TopK = %d, want %d", got, MaxQueryTopK)
	}
	if !client.queryInputs[0].ReturnDistance || !client.queryInputs[0].ReturnMetadata {
		t.Fatalf("QueryVectors() did not request distance and metadata")
	}
	if got := hits[0].Metadata["tenant"]; got != "t1" {
		t.Fatalf("query hit metadata tenant = %v, want t1", got)
	}

	records, err := store.GetVectors(ctx, GetInput{Keys: []string{"alpha"}, ReturnMetadata: true})
	if err != nil {
		t.Fatalf("GetVectors() error = %v", err)
	}
	if got := records[0].Data; !reflect.DeepEqual(got, []float32{1, 0}) {
		t.Fatalf("GetVectors() data = %#v", got)
	}
	if got := client.getInputs[0].ReturnData; !got {
		t.Fatalf("GetVectors() ReturnData = false, want true")
	}

	if err := store.DeleteVectors(ctx, DeleteInput{Keys: []string{"alpha", "beta"}}); err != nil {
		t.Fatalf("DeleteVectors() error = %v", err)
	}
	if len(client.deleteInputs) != 2 {
		t.Fatalf("DeleteVectors() batches = %d, want 2", len(client.deleteInputs))
	}

	if err := (&S3VectorStore{}).PutVectors(ctx, PutInput{Records: []VectorRecord{{Key: "a", Data: []float32{1}}}}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("invalid S3 config error = %v, want ErrInvalidConfig", err)
	}
	client.err = errors.New("s3 down")
	if _, err := store.GetVectors(ctx, GetInput{Keys: []string{"alpha"}}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("GetVectors() client error = %v, want ErrInvalidInput", err)
	}
}

func TestEmbeddersAndSemanticIndexFailClosed(t *testing.T) {
	ctx := context.Background()
	fake := NewFakeEmbedder(map[string][]float32{"hello": {1, 0}})
	vector, err := fake.Embed(ctx, " hello ")
	if err != nil {
		t.Fatalf("FakeEmbedder.Embed() error = %v", err)
	}
	vector[0] = 99
	again, err := fake.Embed(ctx, "hello")
	if err != nil {
		t.Fatalf("FakeEmbedder.Embed() second error = %v", err)
	}
	if got := again[0]; got != 1 {
		t.Fatalf("fake embedding was not cloned, got %v", got)
	}
	fake.Default = []float32{0, 1}
	batch, err := fake.EmbedBatch(ctx, []string{"hello", "other"})
	if err != nil {
		t.Fatalf("FakeEmbedder.EmbedBatch() error = %v", err)
	}
	if got := batch[1]; !reflect.DeepEqual(got, []float32{0, 1}) {
		t.Fatalf("default embedding = %#v", got)
	}
	if _, blankErr := fake.Embed(ctx, " "); !errors.Is(blankErr, ErrInvalidInput) {
		t.Fatalf("FakeEmbedder blank error = %v, want ErrInvalidInput", blankErr)
	}

	runtime := &recordingBedrockRuntime{body: []byte(`{"embedding":[0.5,0.25]}`)}
	titan := &TitanEmbedder{Runtime: runtime, ModelID: " custom-model ", Dimensions: 2, Normalize: true, BatchConcurrency: 2}
	embedding, err := titan.Embed(ctx, " semantic query ")
	if err != nil {
		t.Fatalf("TitanEmbedder.Embed() error = %v", err)
	}
	if !reflect.DeepEqual(embedding, []float32{0.5, 0.25}) {
		t.Fatalf("TitanEmbedder.Embed() = %#v", embedding)
	}
	if got := aws.ToString(runtime.inputs[0].ModelId); got != "custom-model" {
		t.Fatalf("ModelId = %q, want custom-model", got)
	}
	var request titanEmbedRequest
	if unmarshalErr := json.Unmarshal(runtime.inputs[0].Body, &request); unmarshalErr != nil {
		t.Fatalf("request body JSON error = %v", unmarshalErr)
	}
	if request.InputText != "semantic query" || request.Dimensions != 2 || !request.Normalize {
		t.Fatalf("request body = %#v", request)
	}
	if _, batchErr := titan.EmbedBatch(ctx, []string{"a", "b"}); batchErr != nil {
		t.Fatalf("TitanEmbedder.EmbedBatch() error = %v", batchErr)
	}
	runtime.err = errors.New("bedrock down")
	if _, embedErr := titan.Embed(ctx, "boom"); !errors.Is(embedErr, ErrEmbeddingFailed) {
		t.Fatalf("TitanEmbedder client error = %v, want ErrEmbeddingFailed", embedErr)
	}
	runtime.err = nil
	runtime.body = []byte(`{"embedding":[1]}`)
	if _, embedErr := titan.Embed(ctx, "short"); !errors.Is(embedErr, ErrDimensionMismatch) {
		t.Fatalf("TitanEmbedder mismatch error = %v, want ErrDimensionMismatch", embedErr)
	}

	store := NewFakeStore(2)
	index := &SemanticIndex{
		Store:                store,
		Embedder:             NewFakeEmbedder(map[string][]float32{"doc": {1, 0}, "query": {1, 0}}),
		Dimension:            2,
		RequiredMetadataKeys: []string{"tenant"},
	}
	if putErr := index.PutText(ctx, []SemanticRecord{{Key: "doc/1", Text: "doc", Metadata: map[string]any{"tenant": "t1"}}}); putErr != nil {
		t.Fatalf("SemanticIndex.PutText() error = %v", putErr)
	}
	semanticHits, err := index.QueryText(ctx, "query", QueryInput{ReturnMetadata: true})
	if err != nil {
		t.Fatalf("SemanticIndex.QueryText() error = %v", err)
	}
	if got := semanticHits[0].Key; got != "doc/1" {
		t.Fatalf("semantic hit key = %q, want doc/1", got)
	}
	if err := index.PutText(ctx, []SemanticRecord{{Key: "doc/2", Text: "doc"}}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("SemanticIndex missing metadata error = %v, want ErrInvalidInput", err)
	}
	if err := (&SemanticIndex{}).PutText(ctx, []SemanticRecord{{Key: "doc/3", Text: "doc"}}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("SemanticIndex invalid config error = %v, want ErrInvalidConfig", err)
	}
	if err := (&SemanticIndex{Store: store, Embedder: countMismatchEmbedder{}, Dimension: 2}).PutText(ctx, []SemanticRecord{{Key: "doc/4", Text: "doc"}}); !errors.Is(err, ErrEmbeddingFailed) {
		t.Fatalf("SemanticIndex count mismatch error = %v, want ErrEmbeddingFailed", err)
	}
}

func TestVectorStoreAdditionalFailClosedBranches(t *testing.T) {
	ctx := context.Background()
	var nilStore *FakeStore
	if err := nilStore.PutVectors(ctx, PutInput{Records: []VectorRecord{{Key: "a", Data: []float32{1}}}}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("nil PutVectors() error = %v, want ErrInvalidConfig", err)
	}
	if _, err := nilStore.GetVectors(ctx, GetInput{Keys: []string{"a"}}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("nil GetVectors() error = %v, want ErrInvalidConfig", err)
	}
	if err := nilStore.DeleteVectors(ctx, DeleteInput{Keys: []string{"a"}}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("nil DeleteVectors() error = %v, want ErrInvalidConfig", err)
	}
	if _, err := nilStore.QueryVectors(ctx, QueryInput{Vector: []float32{1}}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("nil QueryVectors() error = %v, want ErrInvalidConfig", err)
	}

	zero := &FakeStore{Dimension: 1}
	zero.SetError(" PutVectors ", nil)
	if err := zero.PutVectors(ctx, PutInput{Records: []VectorRecord{{Key: "a", Data: []float32{1}}}}); err != nil {
		t.Fatalf("zero fake PutVectors() error = %v", err)
	}
	if _, err := zero.GetVectors(ctx, GetInput{}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("empty fake GetVectors() error = %v, want ErrInvalidInput", err)
	}
	if err := zero.DeleteVectors(ctx, DeleteInput{}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("empty fake DeleteVectors() error = %v, want ErrInvalidInput", err)
	}
	manyRecords := make([]VectorRecord, MaxPutDeleteBatchSize+1)
	for idx := range manyRecords {
		manyRecords[idx] = VectorRecord{Key: "many", Data: []float32{1}}
	}
	if err := zero.PutVectors(ctx, PutInput{Records: manyRecords}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("oversized fake PutVectors() error = %v, want ErrInvalidInput", err)
	}
	manyKeys := make([]string, MaxPutDeleteBatchSize+1)
	for idx := range manyKeys {
		manyKeys[idx] = "many"
	}
	if err := zero.DeleteVectors(ctx, DeleteInput{Keys: manyKeys}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("oversized fake DeleteVectors() error = %v, want ErrInvalidInput", err)
	}
	if err := zero.DeleteVectors(ctx, DeleteInput{Keys: []string{" bad "}}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid fake DeleteVectors() key error = %v, want ErrInvalidInput", err)
	}
	if _, err := zero.QueryVectors(ctx, QueryInput{}); !errors.Is(err, ErrInvalidVector) {
		t.Fatalf("invalid fake QueryVectors() vector error = %v, want ErrInvalidVector", err)
	}

	filterStore := NewFakeStore(1)
	if err := filterStore.PutVectors(ctx, PutInput{Records: []VectorRecord{
		{Key: "array-any", Data: []float32{1}, Metadata: map[string]any{"tag": []any{"a", "b"}, "n": 1}},
		{Key: "string", Data: []float32{1}, Metadata: map[string]any{"tag": "c", "n": 2}},
	}}); err != nil {
		t.Fatalf("filter store PutVectors() error = %v", err)
	}
	hits, err := filterStore.QueryVectors(ctx, QueryInput{Vector: []float32{1}, Filter: map[string]any{"tag": []any{"b", "z"}}})
	if err != nil {
		t.Fatalf("QueryVectors() []any filter error = %v", err)
	}
	if got := hits[0].Key; got != "array-any" {
		t.Fatalf("[]any filter hit = %q, want array-any", got)
	}
	hits, err = filterStore.QueryVectors(ctx, QueryInput{Vector: []float32{1}, Filter: map[string]any{"tag": []string{"missing"}}})
	if err != nil {
		t.Fatalf("QueryVectors() []string filter error = %v", err)
	}
	if len(hits) != 0 {
		t.Fatalf("non-matching filter returned %d hits, want 0", len(hits))
	}

	if got := cloneRecords(nil); got != nil {
		t.Fatalf("cloneRecords(nil) = %#v, want nil", got)
	}
	if got := cloneStrings(nil); got != nil {
		t.Fatalf("cloneStrings(nil) = %#v, want nil", got)
	}
	if got := (&Error{}).Error(); got != "vectorstore: error" {
		t.Fatalf("empty Error() = %q", got)
	}
	if errors.Is(errors.New("plain"), ErrInvalidInput) {
		t.Fatalf("plain error matched vectorstore error")
	}
	if got := EmbeddingErrorCode(NewError(ErrorCodeInvalidInput, "bad input", nil)); got != ErrorCodeInvalidInput {
		t.Fatalf("EmbeddingErrorCode(vectorstore error) = %q, want %q", got, ErrorCodeInvalidInput)
	}
}

func TestS3VectorStoreAdditionalFailClosedBranches(t *testing.T) {
	ctx := context.Background()
	constructed, constructErr := NewS3VectorStore(ctx, " vectors ", " semantic ", 2)
	if constructErr != nil {
		t.Fatalf("NewS3VectorStore() error = %v", constructErr)
	}
	if constructed.VectorBucketName != "vectors" || constructed.IndexName != "semantic" {
		t.Fatalf("NewS3VectorStore() did not trim names: %#v", constructed)
	}

	client := &recordingS3VectorsClient{
		queryOutput: &s3vectors.QueryVectorsOutput{Vectors: []s3types.QueryOutputVector{{Key: aws.String("nil-metadata"), Distance: aws.Float32(1)}}},
		getOutput:   &s3vectors.GetVectorsOutput{Vectors: []s3types.GetOutputVector{{Key: aws.String("nil-data")}}},
	}
	store := &S3VectorStore{Client: client, VectorBucketName: "vectors", IndexName: "semantic", Dimension: 2}
	if err := store.PutVectors(ctx, PutInput{}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("empty S3 PutVectors() error = %v, want ErrInvalidInput", err)
	}
	if err := store.PutVectors(ctx, PutInput{Records: []VectorRecord{{Key: " bad ", Data: []float32{1, 0}}}}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid S3 put key error = %v, want ErrInvalidInput", err)
	}
	if err := store.PutVectors(ctx, PutInput{Records: []VectorRecord{{Key: "bad", Data: []float32{1}}}}); !errors.Is(err, ErrDimensionMismatch) {
		t.Fatalf("invalid S3 put vector error = %v, want ErrDimensionMismatch", err)
	}
	if _, err := store.QueryVectors(ctx, QueryInput{}); !errors.Is(err, ErrInvalidVector) {
		t.Fatalf("invalid S3 query vector error = %v, want ErrInvalidVector", err)
	}
	if _, err := store.GetVectors(ctx, GetInput{}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("empty S3 GetVectors() error = %v, want ErrInvalidInput", err)
	}
	if _, err := store.GetVectors(ctx, GetInput{Keys: []string{" bad "}}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid S3 get key error = %v, want ErrInvalidInput", err)
	}
	if err := store.DeleteVectors(ctx, DeleteInput{}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("empty S3 DeleteVectors() error = %v, want ErrInvalidInput", err)
	}
	if err := store.DeleteVectors(ctx, DeleteInput{Keys: []string{" bad "}}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid S3 delete key error = %v, want ErrInvalidInput", err)
	}
	if _, err := (&S3VectorStore{Client: client, VectorBucketName: "vectors", IndexName: "semantic"}).QueryVectors(ctx, QueryInput{Vector: []float32{1}}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("invalid S3 dimension error = %v, want ErrInvalidConfig", err)
	}

	hits, err := store.QueryVectors(ctx, QueryInput{Vector: []float32{1, 0}})
	if err != nil {
		t.Fatalf("S3 QueryVectors() nil metadata error = %v", err)
	}
	if hits[0].Metadata != nil {
		t.Fatalf("S3 nil query metadata = %#v, want nil", hits[0].Metadata)
	}
	records, err := store.GetVectors(ctx, GetInput{Keys: []string{"nil-data"}})
	if err != nil {
		t.Fatalf("S3 GetVectors() nil data error = %v", err)
	}
	if records[0].Data != nil {
		t.Fatalf("S3 nil data record = %#v, want nil data", records[0])
	}
	if metadata := decodeS3Metadata(s3document.NewLazyDocument(func() {})); metadata != nil {
		t.Fatalf("decodeS3Metadata(unsupported) = %#v, want nil", metadata)
	}

	client.err = errors.New("s3 down")
	if err := store.PutVectors(ctx, PutInput{Records: []VectorRecord{{Key: "alpha", Data: []float32{1, 0}}}}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("S3 put client error = %v, want ErrInvalidInput", err)
	}
	if _, err := store.QueryVectors(ctx, QueryInput{Vector: []float32{1, 0}}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("S3 query client error = %v, want ErrInvalidInput", err)
	}
	if err := store.DeleteVectors(ctx, DeleteInput{Keys: []string{"alpha"}}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("S3 delete client error = %v, want ErrInvalidInput", err)
	}
}

func TestEmbeddersAndSemanticIndexAdditionalBranches(t *testing.T) {
	ctx := context.Background()
	constructed, constructErr := NewTitanEmbedder(ctx)
	if constructErr != nil {
		t.Fatalf("NewTitanEmbedder() error = %v", constructErr)
	}
	if constructed.ModelID != DefaultTitanEmbedTextModelID || constructed.Dimensions != DefaultEmbeddingDimensions {
		t.Fatalf("NewTitanEmbedder() defaults = %#v", constructed)
	}

	var nilFake *FakeEmbedder
	if _, err := nilFake.Embed(ctx, "x"); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("nil FakeEmbedder error = %v, want ErrInvalidConfig", err)
	}
	missing := NewFakeEmbedder(nil)
	if _, err := missing.EmbedBatch(ctx, []string{"missing"}); !errors.Is(err, ErrEmbeddingFailed) {
		t.Fatalf("FakeEmbedder.EmbedBatch() missing error = %v, want ErrEmbeddingFailed", err)
	}

	defaultVector := make([]float32, DefaultEmbeddingDimensions)
	defaultVector[0] = 1
	defaultBody, marshalErr := json.Marshal(titanEmbedResponse{Embedding: defaultVector})
	if marshalErr != nil {
		t.Fatalf("marshal default embedding error = %v", marshalErr)
	}
	runtime := &recordingBedrockRuntime{body: defaultBody}
	defaultTitan := &TitanEmbedder{Runtime: runtime}
	embedding, embedErr := defaultTitan.Embed(ctx, "default dimensions")
	if embedErr != nil {
		t.Fatalf("TitanEmbedder default dimensions error = %v", embedErr)
	}
	if len(embedding) != DefaultEmbeddingDimensions {
		t.Fatalf("default embedding length = %d, want %d", len(embedding), DefaultEmbeddingDimensions)
	}
	if got := aws.ToString(runtime.inputs[0].ModelId); got != DefaultTitanEmbedTextModelID {
		t.Fatalf("default model ID = %q, want %q", got, DefaultTitanEmbedTextModelID)
	}
	if _, err := (*TitanEmbedder)(nil).Embed(ctx, "x"); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("nil TitanEmbedder error = %v, want ErrInvalidConfig", err)
	}
	if _, err := (&TitanEmbedder{}).Embed(ctx, "x"); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("missing runtime TitanEmbedder error = %v, want ErrInvalidConfig", err)
	}
	if _, err := defaultTitan.Embed(ctx, " "); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("blank TitanEmbedder error = %v, want ErrInvalidInput", err)
	}
	if out, err := defaultTitan.EmbedBatch(ctx, nil); err != nil || len(out) != 0 {
		t.Fatalf("empty TitanEmbedder.EmbedBatch() = %#v, %v; want empty nil error", out, err)
	}
	runtime.body = []byte(`not-json`)
	if _, err := defaultTitan.Embed(ctx, "bad json"); !errors.Is(err, ErrEmbeddingFailed) {
		t.Fatalf("TitanEmbedder JSON error = %v, want ErrEmbeddingFailed", err)
	}
	runtime.body = []byte(`{"embedding":[]}`)
	if _, err := defaultTitan.Embed(ctx, "missing embedding"); !errors.Is(err, ErrEmbeddingFailed) {
		t.Fatalf("TitanEmbedder missing embedding error = %v, want ErrEmbeddingFailed", err)
	}

	store := NewFakeStore(2)
	embedder := NewFakeEmbedder(map[string][]float32{"ok": {1, 0}, "bad-dimension": {1}, "query": {1, 0}})
	index := &SemanticIndex{Store: store, Embedder: embedder, Dimension: 2}
	if err := index.PutText(ctx, nil); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("SemanticIndex empty PutText() error = %v, want ErrInvalidInput", err)
	}
	if err := index.PutText(ctx, []SemanticRecord{{Key: " bad ", Text: "ok"}}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("SemanticIndex invalid key error = %v, want ErrInvalidInput", err)
	}
	if err := index.PutText(ctx, []SemanticRecord{{Key: "blank", Text: " "}}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("SemanticIndex blank text error = %v, want ErrInvalidInput", err)
	}
	if err := index.PutText(ctx, []SemanticRecord{{Key: "missing", Text: "missing"}}); !errors.Is(err, ErrEmbeddingFailed) {
		t.Fatalf("SemanticIndex embed failure = %v, want ErrEmbeddingFailed", err)
	}
	if err := index.PutText(ctx, []SemanticRecord{{Key: "bad-dimension", Text: "bad-dimension"}}); !errors.Is(err, ErrDimensionMismatch) {
		t.Fatalf("SemanticIndex embedding dimension error = %v, want ErrDimensionMismatch", err)
	}
	store.SetError("PutVectors", errors.New("store put failed"))
	if err := index.PutText(ctx, []SemanticRecord{{Key: "ok", Text: "ok"}}); err == nil {
		t.Fatalf("SemanticIndex should surface store PutVectors errors")
	}
	store.SetError("PutVectors", nil)
	if _, err := (&SemanticIndex{}).QueryText(ctx, "query", QueryInput{}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("SemanticIndex invalid query config error = %v, want ErrInvalidConfig", err)
	}
	if _, err := index.QueryText(ctx, " ", QueryInput{}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("SemanticIndex blank query error = %v, want ErrInvalidInput", err)
	}
	if _, err := index.QueryText(ctx, "missing", QueryInput{}); !errors.Is(err, ErrEmbeddingFailed) {
		t.Fatalf("SemanticIndex query embed failure = %v, want ErrEmbeddingFailed", err)
	}
	store.SetError("QueryVectors", errors.New("store query failed"))
	if _, err := index.QueryText(ctx, "query", QueryInput{}); err == nil {
		t.Fatalf("SemanticIndex should surface store QueryVectors errors")
	}
}

type recordingS3VectorsClient struct {
	putInputs    []*s3vectors.PutVectorsInput
	queryInputs  []*s3vectors.QueryVectorsInput
	getInputs    []*s3vectors.GetVectorsInput
	deleteInputs []*s3vectors.DeleteVectorsInput
	queryOutput  *s3vectors.QueryVectorsOutput
	getOutput    *s3vectors.GetVectorsOutput
	err          error
}

func (c *recordingS3VectorsClient) PutVectors(_ context.Context, input *s3vectors.PutVectorsInput, _ ...func(*s3vectors.Options)) (*s3vectors.PutVectorsOutput, error) {
	c.putInputs = append(c.putInputs, input)
	if c.err != nil {
		return nil, c.err
	}
	return &s3vectors.PutVectorsOutput{}, nil
}

func (c *recordingS3VectorsClient) QueryVectors(_ context.Context, input *s3vectors.QueryVectorsInput, _ ...func(*s3vectors.Options)) (*s3vectors.QueryVectorsOutput, error) {
	c.queryInputs = append(c.queryInputs, input)
	if c.err != nil {
		return nil, c.err
	}
	return c.queryOutput, nil
}

func (c *recordingS3VectorsClient) GetVectors(_ context.Context, input *s3vectors.GetVectorsInput, _ ...func(*s3vectors.Options)) (*s3vectors.GetVectorsOutput, error) {
	c.getInputs = append(c.getInputs, input)
	if c.err != nil {
		return nil, c.err
	}
	return c.getOutput, nil
}

func (c *recordingS3VectorsClient) DeleteVectors(_ context.Context, input *s3vectors.DeleteVectorsInput, _ ...func(*s3vectors.Options)) (*s3vectors.DeleteVectorsOutput, error) {
	c.deleteInputs = append(c.deleteInputs, input)
	if c.err != nil {
		return nil, c.err
	}
	return &s3vectors.DeleteVectorsOutput{}, nil
}

type recordingBedrockRuntime struct {
	inputs []*bedrockruntime.InvokeModelInput
	body   []byte
	err    error
}

func (r *recordingBedrockRuntime) InvokeModel(_ context.Context, input *bedrockruntime.InvokeModelInput, _ ...func(*bedrockruntime.Options)) (*bedrockruntime.InvokeModelOutput, error) {
	r.inputs = append(r.inputs, input)
	if r.err != nil {
		return nil, r.err
	}
	return &bedrockruntime.InvokeModelOutput{Body: r.body}, nil
}

type countMismatchEmbedder struct{}

func (countMismatchEmbedder) Embed(context.Context, string) ([]float32, error) {
	return []float32{1, 0}, nil
}

func (countMismatchEmbedder) EmbedBatch(context.Context, []string) ([][]float32, error) {
	return nil, nil
}

func requireStringSlice(t *testing.T, value any) []string {
	t.Helper()
	out, ok := value.([]string)
	if !ok {
		t.Fatalf("value has type %T, want []string", value)
	}
	return out
}

func requireAnySlice(t *testing.T, value any) []any {
	t.Helper()
	out, ok := value.([]any)
	if !ok {
		t.Fatalf("value has type %T, want []any", value)
	}
	return out
}

func requireMap(t *testing.T, value any) map[string]any {
	t.Helper()
	out, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("value has type %T, want map[string]any", value)
	}
	return out
}

func requireFloat32VectorData(t *testing.T, value s3types.VectorData) []float32 {
	t.Helper()
	out, ok := value.(*s3types.VectorDataMemberFloat32)
	if !ok {
		t.Fatalf("vector data has type %T, want *VectorDataMemberFloat32", value)
	}
	return out.Value
}
