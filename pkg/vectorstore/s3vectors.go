package vectorstore

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3vectors"
	s3document "github.com/aws/aws-sdk-go-v2/service/s3vectors/document"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3vectors/types"
)

type S3VectorsAPI interface {
	PutVectors(context.Context, *s3vectors.PutVectorsInput, ...func(*s3vectors.Options)) (*s3vectors.PutVectorsOutput, error)
	QueryVectors(context.Context, *s3vectors.QueryVectorsInput, ...func(*s3vectors.Options)) (*s3vectors.QueryVectorsOutput, error)
	GetVectors(context.Context, *s3vectors.GetVectorsInput, ...func(*s3vectors.Options)) (*s3vectors.GetVectorsOutput, error)
	DeleteVectors(context.Context, *s3vectors.DeleteVectorsInput, ...func(*s3vectors.Options)) (*s3vectors.DeleteVectorsOutput, error)
}

type S3VectorStore struct {
	Client           S3VectorsAPI
	VectorBucketName string
	IndexName        string
	Dimension        int
	MaxBatchSize     int
}

func NewS3VectorStore(ctx context.Context, vectorBucketName, indexName string, dimension int) (*S3VectorStore, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, err
	}
	return &S3VectorStore{Client: s3vectors.NewFromConfig(cfg), VectorBucketName: strings.TrimSpace(vectorBucketName), IndexName: strings.TrimSpace(indexName), Dimension: dimension, MaxBatchSize: MaxPutDeleteBatchSize}, nil
}

func (s *S3VectorStore) validateConfig() error {
	if s == nil || s.Client == nil || strings.TrimSpace(s.VectorBucketName) == "" || strings.TrimSpace(s.IndexName) == "" {
		return ErrInvalidConfig
	}
	return ValidateDimension(s.Dimension)
}

func (s *S3VectorStore) PutVectors(ctx context.Context, input PutInput) error {
	if err := s.validateConfig(); err != nil {
		return err
	}
	if len(input.Records) == 0 {
		return NewError(ErrorCodeInvalidInput, "vectorstore: at least one vector is required", nil)
	}
	batchSize := s.MaxBatchSize
	if batchSize <= 0 || batchSize > MaxPutDeleteBatchSize {
		batchSize = MaxPutDeleteBatchSize
	}
	for start := 0; start < len(input.Records); start += batchSize {
		end := start + batchSize
		if end > len(input.Records) {
			end = len(input.Records)
		}
		vectors := make([]s3types.PutInputVector, 0, end-start)
		for _, record := range input.Records[start:end] {
			if err := ValidateKey(record.Key); err != nil {
				return err
			}
			if err := ValidateVector(record.Data, s.Dimension); err != nil {
				return err
			}
			item := s3types.PutInputVector{Key: aws.String(record.Key), Data: &s3types.VectorDataMemberFloat32{Value: record.Data}}
			if len(record.Metadata) > 0 {
				item.Metadata = s3document.NewLazyDocument(record.Metadata)
			}
			vectors = append(vectors, item)
		}
		if _, err := s.Client.PutVectors(ctx, &s3vectors.PutVectorsInput{VectorBucketName: aws.String(s.VectorBucketName), IndexName: aws.String(s.IndexName), Vectors: vectors}); err != nil {
			return NewError(ErrorCodeInvalidInput, "vectorstore: put vectors failed", err)
		}
	}
	return nil
}

func (s *S3VectorStore) QueryVectors(ctx context.Context, input QueryInput) ([]QueryHit, error) {
	if err := s.validateConfig(); err != nil {
		return nil, err
	}
	if err := ValidateVector(input.Vector, s.Dimension); err != nil {
		return nil, err
	}
	topK := NormalizeTopK(input.TopK)
	// #nosec G115 -- NormalizeTopK clamps TopK to MaxQueryTopK (10000), which fits int32.
	topK32 := int32(topK)
	params := &s3vectors.QueryVectorsInput{VectorBucketName: aws.String(s.VectorBucketName), IndexName: aws.String(s.IndexName), QueryVector: &s3types.VectorDataMemberFloat32{Value: input.Vector}, TopK: aws.Int32(topK32), ReturnDistance: true, ReturnMetadata: input.ReturnMetadata}
	if len(input.Filter) > 0 {
		params.Filter = s3document.NewLazyDocument(input.Filter)
	}
	out, err := s.Client.QueryVectors(ctx, params)
	if err != nil {
		return nil, NewError(ErrorCodeInvalidInput, "vectorstore: query vectors failed", err)
	}
	hits := make([]QueryHit, 0, len(out.Vectors))
	for _, vector := range out.Vectors {
		hits = append(hits, QueryHit{Key: aws.ToString(vector.Key), Distance: aws.ToFloat32(vector.Distance), Metadata: decodeS3Metadata(vector.Metadata)})
	}
	return hits, nil
}

func (s *S3VectorStore) GetVectors(ctx context.Context, input GetInput) ([]VectorRecord, error) {
	if err := s.validateConfig(); err != nil {
		return nil, err
	}
	if len(input.Keys) == 0 {
		return nil, NewError(ErrorCodeInvalidInput, "vectorstore: at least one key is required", nil)
	}
	for _, key := range input.Keys {
		if err := ValidateKey(key); err != nil {
			return nil, err
		}
	}
	out, err := s.Client.GetVectors(ctx, &s3vectors.GetVectorsInput{VectorBucketName: aws.String(s.VectorBucketName), IndexName: aws.String(s.IndexName), Keys: input.Keys, ReturnData: true, ReturnMetadata: input.ReturnMetadata})
	if err != nil {
		return nil, NewError(ErrorCodeInvalidInput, "vectorstore: get vectors failed", err)
	}
	records := make([]VectorRecord, 0, len(out.Vectors))
	for _, vector := range out.Vectors {
		record := VectorRecord{Key: aws.ToString(vector.Key)}
		if data, ok := vector.Data.(*s3types.VectorDataMemberFloat32); ok {
			record.Data = CloneVector(data.Value)
		}
		record.Metadata = decodeS3Metadata(vector.Metadata)
		records = append(records, record)
	}
	return records, nil
}

func (s *S3VectorStore) DeleteVectors(ctx context.Context, input DeleteInput) error {
	if err := s.validateConfig(); err != nil {
		return err
	}
	if len(input.Keys) == 0 {
		return NewError(ErrorCodeInvalidInput, "vectorstore: at least one key is required", nil)
	}
	for _, key := range input.Keys {
		if err := ValidateKey(key); err != nil {
			return err
		}
	}
	batchSize := s.MaxBatchSize
	if batchSize <= 0 || batchSize > MaxPutDeleteBatchSize {
		batchSize = MaxPutDeleteBatchSize
	}
	for start := 0; start < len(input.Keys); start += batchSize {
		end := start + batchSize
		if end > len(input.Keys) {
			end = len(input.Keys)
		}
		if _, err := s.Client.DeleteVectors(ctx, &s3vectors.DeleteVectorsInput{VectorBucketName: aws.String(s.VectorBucketName), IndexName: aws.String(s.IndexName), Keys: input.Keys[start:end]}); err != nil {
			return NewError(ErrorCodeInvalidInput, "vectorstore: delete vectors failed", err)
		}
	}
	return nil
}

func decodeS3Metadata(metadata s3document.Interface) map[string]any {
	if metadata == nil {
		return nil
	}
	decoded := map[string]any{}
	if err := metadata.UnmarshalSmithyDocument(&decoded); err == nil && len(decoded) > 0 {
		return decoded
	}
	raw, err := metadata.MarshalSmithyDocument()
	if err != nil {
		return nil
	}
	decoded = map[string]any{}
	if err := json.Unmarshal(raw, &decoded); err != nil || len(decoded) == 0 {
		return nil
	}
	return decoded
}
