package vectorstore

import (
	"fmt"
	"math"
	"strings"
)

func ValidateDimension(dimension int) error {
	if dimension <= 0 {
		return NewError(ErrorCodeInvalidConfig, "vectorstore: dimension must be positive", nil)
	}
	return nil
}

func ValidateVector(vector []float32, dimension int) error {
	if len(vector) == 0 {
		return NewError(ErrorCodeInvalidVector, "vectorstore: vector is required", nil)
	}
	if dimension > 0 && len(vector) != dimension {
		return NewError(ErrorCodeDimensionMismatch, fmt.Sprintf("vectorstore: vector dimension mismatch: got %d want %d", len(vector), dimension), nil)
	}
	for _, value := range vector {
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return NewError(ErrorCodeInvalidVector, "vectorstore: vector values must be finite", nil)
		}
	}
	return nil
}

func ValidateKey(key string) error {
	if strings.TrimSpace(key) == "" || key != strings.TrimSpace(key) {
		return NewError(ErrorCodeInvalidInput, "vectorstore: vector key is required", nil)
	}
	return nil
}

func NormalizeTopK(topK int) int {
	if topK <= 0 {
		return DefaultQueryTopK
	}
	if topK > MaxQueryTopK {
		return MaxQueryTopK
	}
	return topK
}

func ValidateRequiredMetadata(metadata map[string]any, required []string) error {
	for _, key := range required {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		value, ok := metadata[key]
		if !ok || isBlankMetadataValue(value) {
			return NewError(ErrorCodeInvalidInput, "vectorstore: required metadata missing: "+key, nil)
		}
	}
	return nil
}

func isBlankMetadataValue(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(typed) == ""
	case []string:
		return len(typed) == 0
	case []any:
		return len(typed) == 0
	default:
		return false
	}
}
