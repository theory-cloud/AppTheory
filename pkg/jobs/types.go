package jobs

import (
	"context"
	"time"
)

type JobStatus string

const (
	JobStatusPending   JobStatus = "PENDING"
	JobStatusRunning   JobStatus = "RUNNING"
	JobStatusSucceeded JobStatus = "SUCCEEDED"
	JobStatusFailed    JobStatus = "FAILED"
	JobStatusCanceled  JobStatus = "CANCELED"
)

type RecordStatus string

const (
	RecordStatusPending    RecordStatus = "PENDING"
	RecordStatusProcessing RecordStatus = "PROCESSING"
	RecordStatusSucceeded  RecordStatus = "SUCCEEDED"
	RecordStatusFailed     RecordStatus = "FAILED"
	RecordStatusSkipped    RecordStatus = "SKIPPED"
)

type IdempotencyStatus string

const (
	IdempotencyStatusInProgress IdempotencyStatus = "IN_PROGRESS"
	IdempotencyStatusCompleted  IdempotencyStatus = "COMPLETED"
)

type IdempotencyCreateOutcome string

const (
	IdempotencyOutcomeCreated           IdempotencyCreateOutcome = "created"
	IdempotencyOutcomeAlreadyInProgress IdempotencyCreateOutcome = "already_in_progress"
	IdempotencyOutcomeAlreadyCompleted  IdempotencyCreateOutcome = "already_completed"
)

type ErrorType string

const (
	ErrorTypeInternal     ErrorType = "internal_error"
	ErrorTypeInvalidInput ErrorType = "invalid_input"
	ErrorTypeConflict     ErrorType = "conflict"
	ErrorTypeNotFound     ErrorType = "not_found"
)

type Error struct {
	Type    ErrorType
	Message string
	Cause   error
}

func (e *Error) Error() string {
	if e == nil {
		return "jobs error"
	}
	if e.Cause != nil {
		return e.Message + ": " + e.Cause.Error()
	}
	return e.Message
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func NewError(errorType ErrorType, message string) *Error {
	return &Error{Type: errorType, Message: message}
}

func WrapError(cause error, errorType ErrorType, message string) *Error {
	return &Error{Type: errorType, Message: message, Cause: cause}
}

type Clock interface {
	Now() time.Time
}

type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }

type Config struct {
	DefaultLeaseDuration    time.Duration
	DefaultIdempotencyTTL   time.Duration
	DefaultJobTTL           time.Duration
	DefaultRecordTTL        time.Duration
	DefaultRequestResultTTL time.Duration
}

func DefaultConfig() *Config {
	return &Config{
		DefaultLeaseDuration:    5 * time.Minute,
		DefaultIdempotencyTTL:   24 * time.Hour,
		DefaultJobTTL:           0,
		DefaultRecordTTL:        0,
		DefaultRequestResultTTL: 0,
	}
}

type CreateJobInput struct {
	JobID    string
	TenantID string
	Status   JobStatus

	TTL time.Duration
}

type TransitionJobStatusInput struct {
	JobID           string
	ExpectedVersion int64
	ToStatus        JobStatus

	FromStatus JobStatus
}

type UpsertRecordStatusInput struct {
	JobID    string
	RecordID string
	Status   RecordStatus
	Error    *ErrorEnvelope

	TTL time.Duration
}

type AcquireLeaseInput struct {
	JobID         string
	Owner         string
	LeaseDuration time.Duration
	TTL           time.Duration
}

type RefreshLeaseInput struct {
	JobID         string
	Owner         string
	LeaseDuration time.Duration
	TTL           time.Duration
}

type ReleaseLeaseInput struct {
	JobID string
	Owner string
}

type CreateIdempotencyRecordInput struct {
	JobID          string
	IdempotencyKey string
	TTL            time.Duration
}

type CompleteIdempotencyRecordInput struct {
	JobID          string
	IdempotencyKey string

	Result map[string]any
	Error  *ErrorEnvelope

	TTL time.Duration
}

type JobLedger interface {
	CreateJob(ctx context.Context, in CreateJobInput) (*JobMeta, error)
	TransitionJobStatus(ctx context.Context, in TransitionJobStatusInput) (*JobMeta, error)

	UpsertRecordStatus(ctx context.Context, in UpsertRecordStatusInput) (*JobRecord, error)

	AcquireLease(ctx context.Context, in AcquireLeaseInput) (*JobLock, error)
	RefreshLease(ctx context.Context, in RefreshLeaseInput) (*JobLock, error)
	ReleaseLease(ctx context.Context, in ReleaseLeaseInput) error

	CreateIdempotencyRecord(ctx context.Context, in CreateIdempotencyRecordInput) (*JobRequest, IdempotencyCreateOutcome, error)
	CompleteIdempotencyRecord(ctx context.Context, in CompleteIdempotencyRecordInput) (*JobRequest, error)
}
