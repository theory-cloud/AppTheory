package vectorstore

import "errors"

const (
	ErrorCodeInvalidConfig        = "vectorstore.invalid_config"
	ErrorCodeInvalidInput         = "vectorstore.invalid_input"
	ErrorCodeInvalidVector        = "vectorstore.invalid_vector"
	ErrorCodeDimensionMismatch    = "vectorstore.dimension_mismatch"
	ErrorCodeNotFound             = "vectorstore.not_found"
	ErrorCodeUnsupportedOperation = "vectorstore.unsupported_operation"
	ErrorCodeEmbeddingFailed      = "vectorstore.embedding_failed"
)

var (
	ErrInvalidConfig        = &Error{Code: ErrorCodeInvalidConfig, Message: "vectorstore: invalid config"}
	ErrInvalidInput         = &Error{Code: ErrorCodeInvalidInput, Message: "vectorstore: invalid input"}
	ErrInvalidVector        = &Error{Code: ErrorCodeInvalidVector, Message: "vectorstore: invalid vector"}
	ErrDimensionMismatch    = &Error{Code: ErrorCodeDimensionMismatch, Message: "vectorstore: vector dimension mismatch"}
	ErrNotFound             = &Error{Code: ErrorCodeNotFound, Message: "vectorstore: vector not found"}
	ErrUnsupportedOperation = &Error{Code: ErrorCodeUnsupportedOperation, Message: "vectorstore: unsupported operation"}
	ErrEmbeddingFailed      = &Error{Code: ErrorCodeEmbeddingFailed, Message: "vectorstore: embedding failed"}
)

type Error struct {
	Code    string
	Message string
	Cause   error
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Message != "" {
		return e.Message
	}
	if e.Code != "" {
		return e.Code
	}
	return "vectorstore: error"
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func (e *Error) Is(target error) bool {
	var other *Error
	if errors.As(target, &other) {
		return e != nil && other != nil && e.Code == other.Code
	}
	return false
}

func NewError(code, message string, cause error) *Error {
	if message == "" {
		message = code
	}
	return &Error{Code: code, Message: message, Cause: cause}
}
