package vectorstore

import (
	"context"
	"fmt"
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
	params := &s3vectors.QueryVectorsInput{VectorBucketName: aws.String(s.VectorBucketName), IndexName: aws.String(s.IndexName), QueryVector: &s3types.VectorDataMemberFloat32{Value: input.Vector}, TopK: aws.Int32(int32(topK)), ReturnDistance: true, ReturnMetadata: input.ReturnMetadata}
	if len(input.Filter) > 0 {
		params.Filter = s3document.NewLazyDocument(input.Filter)
	}
	out, err := s.Client.QueryVectors(ctx, params)
	if err != nil {
		return nil, NewError(ErrorCodeInvalidInput, "vectorstore: query vectors failed", err)
	}
	hits := make([]QueryHit, 0, len(out.Vectors))
	for _, vector := range out.Vectors {
		metadata := map[string]any(nil)
		if vector.Metadata != nil {
			var raw any
			if err := vector.Metadata.UnmarshalSmithyDocument(&raw); err == nil {
				if decoded, ok := raw.(map[string]any); ok {
					metadata = decoded
				}
			}
		}
		hits = append(hits, QueryHit{Key: aws.ToString(vector.Key), Distance: aws.ToFloat32(vector.Distance), Metadata: metadata})
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
		if vector.Metadata != nil {
			var raw any
			if err := vector.Metadata.UnmarshalSmithyDocument(&raw); err == nil {
				if decoded, ok := raw.(map[string]any); ok {
					record.Metadata = decoded
				}
			}
		}
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
			return NewError(ErrorCodeInvalidInput, fmt.Sprintf("vectorstore: delete vectors failed"), err)
		}
	}
	return nil
}
