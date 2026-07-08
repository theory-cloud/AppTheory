package vectorstore

import (
	"context"
	"sort"
	"strings"
)

type FakeStore struct {
	Dimension            int
	RequiredMetadataKeys []string
	records              map[string]VectorRecord
	calls                []Call
	failures             map[string]error
}

func NewFakeStore(dimension int) *FakeStore {
	return &FakeStore{Dimension: dimension, records: map[string]VectorRecord{}, failures: map[string]error{}}
}

func (s *FakeStore) SetError(operation string, err error) {
	if s.failures == nil {
		s.failures = map[string]error{}
	}
	operation = strings.TrimSpace(operation)
	if err == nil {
		delete(s.failures, operation)
		return
	}
	s.failures[operation] = err
}

func (s *FakeStore) Calls() []Call {
	out := make([]Call, len(s.calls))
	for i, call := range s.calls {
		out[i] = cloneCall(call)
	}
	return out
}

func (s *FakeStore) PutVectors(_ context.Context, input PutInput) error {
	if s == nil {
		return ErrInvalidConfig
	}
	if len(input.Records) == 0 {
		return NewError(ErrorCodeInvalidInput, "vectorstore: at least one vector is required", nil)
	}
	if len(input.Records) > MaxPutDeleteBatchSize {
		return NewError(ErrorCodeInvalidInput, "vectorstore: put batch exceeds 500 vectors", nil)
	}
	for _, record := range input.Records {
		if err := ValidateKey(record.Key); err != nil {
			return err
		}
		if err := ValidateVector(record.Data, s.Dimension); err != nil {
			return err
		}
		if err := ValidateRequiredMetadata(record.Metadata, s.RequiredMetadataKeys); err != nil {
			return err
		}
	}
	s.record(Call{Operation: "PutVectors", Records: cloneRecords(input.Records)})
	if err := s.failure("PutVectors"); err != nil {
		return err
	}
	if s.records == nil {
		s.records = map[string]VectorRecord{}
	}
	for _, record := range input.Records {
		s.records[record.Key] = cloneRecord(record)
	}
	return nil
}

func (s *FakeStore) GetVectors(_ context.Context, input GetInput) ([]VectorRecord, error) {
	if s == nil {
		return nil, ErrInvalidConfig
	}
	if len(input.Keys) == 0 {
		return nil, NewError(ErrorCodeInvalidInput, "vectorstore: at least one key is required", nil)
	}
	s.record(Call{Operation: "GetVectors", Keys: cloneStrings(input.Keys), ReturnMetadata: input.ReturnMetadata})
	if err := s.failure("GetVectors"); err != nil {
		return nil, err
	}
	out := make([]VectorRecord, 0, len(input.Keys))
	for _, key := range input.Keys {
		if err := ValidateKey(key); err != nil {
			return nil, err
		}
		record, ok := s.records[key]
		if !ok {
			return nil, NewError(ErrorCodeNotFound, "vectorstore: vector not found", nil)
		}
		cloned := cloneRecord(record)
		if !input.ReturnMetadata {
			cloned.Metadata = nil
		}
		out = append(out, cloned)
	}
	return out, nil
}

func (s *FakeStore) DeleteVectors(_ context.Context, input DeleteInput) error {
	if s == nil {
		return ErrInvalidConfig
	}
	if len(input.Keys) == 0 {
		return NewError(ErrorCodeInvalidInput, "vectorstore: at least one key is required", nil)
	}
	if len(input.Keys) > MaxPutDeleteBatchSize {
		return NewError(ErrorCodeInvalidInput, "vectorstore: delete batch exceeds 500 vectors", nil)
	}
	for _, key := range input.Keys {
		if err := ValidateKey(key); err != nil {
			return err
		}
	}
	s.record(Call{Operation: "DeleteVectors", Keys: cloneStrings(input.Keys)})
	if err := s.failure("DeleteVectors"); err != nil {
		return err
	}
	for _, key := range input.Keys {
		delete(s.records, key)
	}
	return nil
}

func (s *FakeStore) QueryVectors(_ context.Context, input QueryInput) ([]QueryHit, error) {
	if s == nil {
		return nil, ErrInvalidConfig
	}
	if err := ValidateVector(input.Vector, s.Dimension); err != nil {
		return nil, err
	}
	topK := NormalizeTopK(input.TopK)
	s.record(Call{Operation: "QueryVectors", Vector: CloneVector(input.Vector), TopK: topK, Filter: CloneMetadata(input.Filter), ReturnMetadata: input.ReturnMetadata})
	if err := s.failure("QueryVectors"); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(s.records))
	for key := range s.records {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	hits := make([]QueryHit, 0, len(keys))
	for _, key := range keys {
		record := s.records[key]
		if !metadataMatches(record.Metadata, input.Filter) {
			continue
		}
		hit := QueryHit{Key: key, Distance: squaredDistance(input.Vector, record.Data)}
		if input.ReturnMetadata {
			hit.Metadata = CloneMetadata(record.Metadata)
		}
		hits = append(hits, hit)
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].Distance == hits[j].Distance {
			return hits[i].Key < hits[j].Key
		}
		return hits[i].Distance < hits[j].Distance
	})
	if len(hits) > topK {
		hits = hits[:topK]
	}
	return hits, nil
}

func (s *FakeStore) record(call Call) { s.calls = append(s.calls, cloneCall(call)) }

func (s *FakeStore) failure(operation string) error {
	if s.failures == nil {
		return nil
	}
	return s.failures[operation]
}

func squaredDistance(a, b []float32) float32 {
	var total float32
	for i := range a {
		d := a[i] - b[i]
		total += d * d
	}
	return total
}

func metadataMatches(metadata map[string]any, filter map[string]any) bool {
	if len(filter) == 0 {
		return true
	}
	for key, expected := range filter {
		actual, ok := metadata[key]
		if !ok || !metadataValueMatches(actual, expected) {
			return false
		}
	}
	return true
}

func metadataValueMatches(actual, expected any) bool {
	switch exp := expected.(type) {
	case []any:
		for _, one := range exp {
			if metadataValueMatches(actual, one) {
				return true
			}
		}
		return false
	case []string:
		for _, one := range exp {
			if metadataValueMatches(actual, one) {
				return true
			}
		}
		return false
	case string:
		switch act := actual.(type) {
		case string:
			return act == exp
		case []string:
			for _, one := range act {
				if one == exp {
					return true
				}
			}
		case []any:
			for _, one := range act {
				if metadataValueMatches(one, exp) {
					return true
				}
			}
		}
		return false
	default:
		return actual == expected
	}
}

func cloneCall(call Call) Call {
	return Call{Operation: call.Operation, Keys: cloneStrings(call.Keys), Records: cloneRecords(call.Records), Vector: CloneVector(call.Vector), TopK: call.TopK, Filter: CloneMetadata(call.Filter), ReturnMetadata: call.ReturnMetadata}
}

func cloneRecord(record VectorRecord) VectorRecord {
	return VectorRecord{Key: record.Key, Data: CloneVector(record.Data), Metadata: CloneMetadata(record.Metadata)}
}

func cloneRecords(records []VectorRecord) []VectorRecord {
	if records == nil {
		return nil
	}
	out := make([]VectorRecord, len(records))
	for i, record := range records {
		out[i] = cloneRecord(record)
	}
	return out
}

func cloneStrings(in []string) []string {
	if in == nil {
		return nil
	}
	out := make([]string, len(in))
	copy(out, in)
	return out
}
