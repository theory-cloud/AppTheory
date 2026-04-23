package jobs

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"
	tablemocks "github.com/theory-cloud/tabletheory/pkg/mocks"
)

type fixedClock struct {
	now time.Time
}

func (c fixedClock) Now() time.Time { return c.now }

func TestDynamoJobLedger_CreateJob_Success(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("IfNotExists").Return(q)
	q.On("Create").Return(nil)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	meta, err := ledger.CreateJob(context.Background(), CreateJobInput{
		JobID:    "job_123",
		TenantID: "tenant_abc",
		Status:   JobStatusPending,
	})
	require.NoError(t, err)
	require.Equal(t, "JOB#job_123", meta.PK)
	require.Equal(t, "META", meta.SK)
	require.Equal(t, "job_123", meta.JobID)
	require.Equal(t, "tenant_abc", meta.TenantID)
	require.Equal(t, JobStatusPending, meta.Status)
	require.Equal(t, int64(1), meta.Version)
	require.Equal(t, now, meta.CreatedAt)
	require.Equal(t, now, meta.UpdatedAt)

	db.AssertExpectations(t)
	q.AssertExpectations(t)
}

func TestDynamoJobLedger_CreateJob_Conflict(t *testing.T) {
	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("IfNotExists").Return(q)
	q.On("Create").Return(tableerrors.ErrConditionFailed)

	ledger := NewDynamoJobLedger(db, DefaultConfig())

	meta, err := ledger.CreateJob(context.Background(), CreateJobInput{
		JobID:    "job_123",
		TenantID: "tenant_abc",
	})
	require.Nil(t, meta)
	require.Error(t, err)

	var typed *Error
	require.ErrorAs(t, err, &typed)
	require.Equal(t, ErrorTypeConflict, typed.Type)
}

func TestDynamoJobLedger_TransitionJobStatus_Success(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	ub := new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", "PK", "=", "JOB#job_123").Return(q)
	q.On("Where", "SK", "=", "META").Return(q)
	q.On("IfExists").Return(q)
	q.On("UpdateBuilder").Return(ub)

	ub.On("Set", "Status", JobStatusRunning).Return(ub)
	ub.On("Increment", "Version").Return(ub)
	ub.On("Set", "UpdatedAt", now).Return(ub)
	ub.On("ConditionVersion", int64(1)).Return(ub)
	ub.On("Condition", "Status", "=", JobStatusPending).Return()
	ub.On("ExecuteWithResult", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*JobMeta)
		require.True(t, ok)
		out.PK = "JOB#job_123"
		out.SK = "META"
		out.JobID = "job_123"
		out.TenantID = "tenant_abc"
		out.Status = JobStatusRunning
		out.Version = 2
		out.UpdatedAt = now
		out.CreatedAt = now
	}).Return(nil)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	meta, err := ledger.TransitionJobStatus(context.Background(), TransitionJobStatusInput{
		JobID:           "job_123",
		ExpectedVersion: 1,
		FromStatus:      JobStatusPending,
		ToStatus:        JobStatusRunning,
	})
	require.NoError(t, err)
	require.Equal(t, JobStatusRunning, meta.Status)
	require.Equal(t, int64(2), meta.Version)
}

func TestDynamoJobLedger_TransitionJobStatus_Conflict(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	ub := new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("IfExists").Return(q)
	q.On("UpdateBuilder").Return(ub)

	ub.On("Set", "Status", JobStatusRunning).Return(ub)
	ub.On("Increment", "Version").Return(ub)
	ub.On("Set", "UpdatedAt", now).Return(ub)
	ub.On("ConditionVersion", int64(1)).Return(ub)
	ub.On("ExecuteWithResult", mock.Anything).Return(tableerrors.ErrConditionFailed)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	meta, err := ledger.TransitionJobStatus(context.Background(), TransitionJobStatusInput{
		JobID:           "job_123",
		ExpectedVersion: 1,
		ToStatus:        JobStatusRunning,
	})
	require.Nil(t, meta)
	require.Error(t, err)

	var typed *Error
	require.ErrorAs(t, err, &typed)
	require.Equal(t, ErrorTypeConflict, typed.Type)
}

func TestDynamoJobLedger_UpsertRecordStatus_SetsSanitizedErrorEnvelope(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	ub := new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("UpdateBuilder").Return(ub)

	ub.On("Set", "Status", RecordStatusFailed).Return(ub)
	ub.On("SetIfNotExists", "JobID", nil, "job_123").Return(ub)
	ub.On("SetIfNotExists", "RecordID", nil, "rec_1").Return(ub)
	ub.On("SetIfNotExists", "CreatedAt", nil, now).Return(ub)
	ub.On("Set", "UpdatedAt", now).Return(ub)
	ub.On("Set", "Error", mock.MatchedBy(func(env *ErrorEnvelope) bool {
		if env == nil {
			return false
		}
		// message should be log-safe (no newlines)
		if env.Message != "badnews" {
			return false
		}
		// PAN alias should be masked
		return env.Fields["pan"] == "411111******1111"
	})).Return(ub)
	ub.On("ExecuteWithResult", mock.Anything).Return(nil)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	_, err := ledger.UpsertRecordStatus(context.Background(), UpsertRecordStatusInput{
		JobID:    "job_123",
		RecordID: "rec_1",
		Status:   RecordStatusFailed,
		Error: &ErrorEnvelope{
			Message: "bad\nnews",
			Fields: map[string]any{
				"pan": "4111111111111111",
			},
		},
	})
	require.NoError(t, err)
}

func TestDynamoJobLedger_UpsertRecordStatus_RemovesErrorWhenNil_AndSetsTTL(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	ub := new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("UpdateBuilder").Return(ub)

	ttlUnix := now.Add(time.Hour).Unix()

	ub.On("Set", "Status", RecordStatusProcessing).Return(ub)
	ub.On("SetIfNotExists", "JobID", nil, "job_123").Return(ub)
	ub.On("SetIfNotExists", "RecordID", nil, "rec_1").Return(ub)
	ub.On("SetIfNotExists", "CreatedAt", nil, now).Return(ub)
	ub.On("Set", "UpdatedAt", now).Return(ub)
	ub.On("Set", "TTL", ttlUnix).Return(ub)
	ub.On("Remove", "Error").Return(ub)
	ub.On("ExecuteWithResult", mock.Anything).Return(nil)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	_, err := ledger.UpsertRecordStatus(context.Background(), UpsertRecordStatusInput{
		JobID:    "job_123",
		RecordID: "rec_1",
		Status:   RecordStatusProcessing,
		TTL:      time.Hour,
	})
	require.NoError(t, err)
}

func TestDynamoJobLedger_AcquireLease_Success(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	ub := new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("UpdateBuilder").Return(ub)

	expiresAt := now.Add(2 * time.Minute).Unix()

	ub.On("SetIfNotExists", "JobID", nil, "job_123").Return(ub)
	ub.On("Set", "LeaseOwner", "worker_a").Return(ub)
	ub.On("Set", "LeaseExpiresAt", expiresAt).Return(ub)
	ub.On("SetIfNotExists", "CreatedAt", nil, now).Return(ub)
	ub.On("Set", "UpdatedAt", now).Return(ub)
	ub.On("ConditionNotExists", "LeaseExpiresAt").Return(ub)
	ub.On("OrCondition", "LeaseExpiresAt", "<", now.Unix()).Return(ub)
	ub.On("OrCondition", "LeaseOwner", "=", "worker_a").Return(ub)
	ub.On("ExecuteWithResult", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*JobLock)
		require.True(t, ok)
		out.LeaseOwner = "worker_a"
		out.LeaseExpiresAt = expiresAt
	}).Return(nil)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	lock, err := ledger.AcquireLease(context.Background(), AcquireLeaseInput{
		JobID:         "job_123",
		Owner:         "worker_a",
		LeaseDuration: 2 * time.Minute,
	})
	require.NoError(t, err)
	require.Equal(t, "worker_a", lock.LeaseOwner)
	require.Equal(t, expiresAt, lock.LeaseExpiresAt)
}

func TestDynamoJobLedger_AcquireLease_Conflict(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	ub := new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("UpdateBuilder").Return(ub)

	expiresAt := now.Add(2 * time.Minute).Unix()

	ub.On("SetIfNotExists", "JobID", nil, "job_123").Return(ub)
	ub.On("Set", "LeaseOwner", "worker_a").Return(ub)
	ub.On("Set", "LeaseExpiresAt", expiresAt).Return(ub)
	ub.On("SetIfNotExists", "CreatedAt", nil, now).Return(ub)
	ub.On("Set", "UpdatedAt", now).Return(ub)
	ub.On("ConditionNotExists", "LeaseExpiresAt").Return(ub)
	ub.On("OrCondition", "LeaseExpiresAt", "<", now.Unix()).Return(ub)
	ub.On("OrCondition", "LeaseOwner", "=", "worker_a").Return(ub)
	ub.On("ExecuteWithResult", mock.Anything).Return(tableerrors.ErrConditionFailed)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	lock, err := ledger.AcquireLease(context.Background(), AcquireLeaseInput{
		JobID:         "job_123",
		Owner:         "worker_a",
		LeaseDuration: 2 * time.Minute,
	})
	require.Nil(t, lock)
	require.Error(t, err)

	var typed *Error
	require.ErrorAs(t, err, &typed)
	require.Equal(t, ErrorTypeConflict, typed.Type)
}

func TestDynamoJobLedger_RefreshLease_Success(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	ub := new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("IfExists").Return(q)
	q.On("UpdateBuilder").Return(ub)

	expiresAt := now.Add(2 * time.Minute).Unix()

	ub.On("Set", "LeaseExpiresAt", expiresAt).Return(ub)
	ub.On("Set", "UpdatedAt", now).Return(ub)
	ub.On("Condition", "LeaseOwner", "=", "worker_a").Return()
	ub.On("Condition", "LeaseExpiresAt", ">", now.Unix()).Return()
	ub.On("ExecuteWithResult", mock.Anything).Return(nil)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	lock, err := ledger.RefreshLease(context.Background(), RefreshLeaseInput{
		JobID:         "job_123",
		Owner:         "worker_a",
		LeaseDuration: 2 * time.Minute,
	})
	require.NoError(t, err)
	require.NotNil(t, lock)
}

func TestDynamoJobLedger_ReleaseLease_MissingLeaseIsOk(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	qDelete := new(tablemocks.MockQuery)
	qGet := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(qDelete).Once()
	db.On("Model", mock.Anything).Return(qGet).Once()

	qDelete.On("WithContext", mock.Anything).Return(qDelete)
	qDelete.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(qDelete)
	qDelete.On("WithCondition", "LeaseOwner", "=", "worker_a").Return(qDelete)
	qDelete.On("Delete").Return(tableerrors.ErrConditionFailed)

	qGet.On("WithContext", mock.Anything).Return(qGet)
	qGet.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(qGet)
	qGet.On("First", mock.Anything).Return(tableerrors.ErrItemNotFound)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	err := ledger.ReleaseLease(context.Background(), ReleaseLeaseInput{
		JobID: "job_123",
		Owner: "worker_a",
	})
	require.NoError(t, err)
}

func TestDynamoJobLedger_ReleaseLease_OwnerMismatch(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	qDelete := new(tablemocks.MockQuery)
	qGet := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(qDelete).Once()
	db.On("Model", mock.Anything).Return(qGet).Once()

	qDelete.On("WithContext", mock.Anything).Return(qDelete)
	qDelete.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(qDelete)
	qDelete.On("WithCondition", "LeaseOwner", "=", "worker_a").Return(qDelete)
	qDelete.On("Delete").Return(tableerrors.ErrConditionFailed)

	qGet.On("WithContext", mock.Anything).Return(qGet)
	qGet.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(qGet)
	qGet.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*JobLock)
		require.True(t, ok)
		out.LeaseOwner = "worker_b"
	}).Return(nil)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	err := ledger.ReleaseLease(context.Background(), ReleaseLeaseInput{
		JobID: "job_123",
		Owner: "worker_a",
	})
	require.Error(t, err)

	var typed *Error
	require.ErrorAs(t, err, &typed)
	require.Equal(t, ErrorTypeConflict, typed.Type)
}

func TestDynamoJobLedger_AcquireSemaphoreSlot_SuccessAfterScanningSlots(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	q0 := new(tablemocks.MockQuery)
	q1 := new(tablemocks.MockQuery)
	ub0 := new(tablemocks.MockUpdateBuilder)
	ub1 := new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q0).Once()
	db.On("Model", mock.Anything).Return(q1).Once()

	pk := SemaphorePartitionKey("email", "customer_1")
	expiresAt := now.Add(2 * time.Minute).Unix()

	q0.On("WithContext", mock.Anything).Return(q0)
	q0.On("Where", "PK", "=", pk).Return(q0).Once()
	q0.On("Where", "SK", "=", SemaphoreSlotSortKey(0)).Return(q0).Once()
	q0.On("UpdateBuilder").Return(ub0)

	ub0.On("SetIfNotExists", "Scope", nil, "email").Return(ub0)
	ub0.On("SetIfNotExists", "Subject", nil, "customer_1").Return(ub0)
	ub0.On("SetIfNotExists", "Slot", nil, 0).Return(ub0)
	ub0.On("Set", "LeaseOwner", "worker_a").Return(ub0)
	ub0.On("Set", "LeaseExpiresAt", expiresAt).Return(ub0)
	ub0.On("SetIfNotExists", "CreatedAt", nil, now).Return(ub0)
	ub0.On("Set", "UpdatedAt", now).Return(ub0)
	ub0.On("ConditionNotExists", "LeaseExpiresAt").Return(ub0)
	ub0.On("OrCondition", "LeaseExpiresAt", "<", now.Unix()).Return(ub0)
	ub0.On("OrCondition", "LeaseOwner", "=", "worker_a").Return(ub0)
	ub0.On("ExecuteWithResult", mock.Anything).Return(tableerrors.ErrConditionFailed)

	q1.On("WithContext", mock.Anything).Return(q1)
	q1.On("Where", "PK", "=", pk).Return(q1).Once()
	q1.On("Where", "SK", "=", SemaphoreSlotSortKey(1)).Return(q1).Once()
	q1.On("UpdateBuilder").Return(ub1)

	ub1.On("SetIfNotExists", "Scope", nil, "email").Return(ub1)
	ub1.On("SetIfNotExists", "Subject", nil, "customer_1").Return(ub1)
	ub1.On("SetIfNotExists", "Slot", nil, 1).Return(ub1)
	ub1.On("Set", "LeaseOwner", "worker_a").Return(ub1)
	ub1.On("Set", "LeaseExpiresAt", expiresAt).Return(ub1)
	ub1.On("SetIfNotExists", "CreatedAt", nil, now).Return(ub1)
	ub1.On("Set", "UpdatedAt", now).Return(ub1)
	ub1.On("ConditionNotExists", "LeaseExpiresAt").Return(ub1)
	ub1.On("OrCondition", "LeaseExpiresAt", "<", now.Unix()).Return(ub1)
	ub1.On("OrCondition", "LeaseOwner", "=", "worker_a").Return(ub1)
	ub1.On("ExecuteWithResult", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*SemaphoreLease)
		require.True(t, ok)
		out.Scope = "email"
		out.Subject = "customer_1"
		out.Slot = 1
		out.LeaseOwner = "worker_a"
		out.LeaseExpiresAt = expiresAt
	}).Return(nil)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	lease, err := ledger.AcquireSemaphoreSlot(context.Background(), AcquireSemaphoreSlotInput{
		Scope:         "email",
		Subject:       "customer_1",
		Limit:         2,
		Owner:         "worker_a",
		LeaseDuration: 2 * time.Minute,
	})
	require.NoError(t, err)
	require.Equal(t, 1, lease.Slot)
	require.Equal(t, "worker_a", lease.LeaseOwner)
}

func TestDynamoJobLedger_AcquireSemaphoreSlot_Full(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	ub := new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", "PK", "=", SemaphorePartitionKey("email", "customer_1")).Return(q).Once()
	q.On("Where", "SK", "=", SemaphoreSlotSortKey(0)).Return(q).Once()
	q.On("UpdateBuilder").Return(ub)

	expiresAt := now.Add(2 * time.Minute).Unix()
	ub.On("SetIfNotExists", "Scope", nil, "email").Return(ub)
	ub.On("SetIfNotExists", "Subject", nil, "customer_1").Return(ub)
	ub.On("SetIfNotExists", "Slot", nil, 0).Return(ub)
	ub.On("Set", "LeaseOwner", "worker_a").Return(ub)
	ub.On("Set", "LeaseExpiresAt", expiresAt).Return(ub)
	ub.On("SetIfNotExists", "CreatedAt", nil, now).Return(ub)
	ub.On("Set", "UpdatedAt", now).Return(ub)
	ub.On("ConditionNotExists", "LeaseExpiresAt").Return(ub)
	ub.On("OrCondition", "LeaseExpiresAt", "<", now.Unix()).Return(ub)
	ub.On("OrCondition", "LeaseOwner", "=", "worker_a").Return(ub)
	ub.On("ExecuteWithResult", mock.Anything).Return(tableerrors.ErrConditionFailed)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	lease, err := ledger.AcquireSemaphoreSlot(context.Background(), AcquireSemaphoreSlotInput{
		Scope:         "email",
		Subject:       "customer_1",
		Limit:         1,
		Owner:         "worker_a",
		LeaseDuration: 2 * time.Minute,
	})
	require.Nil(t, lease)
	require.Error(t, err)

	var typed *Error
	require.ErrorAs(t, err, &typed)
	require.Equal(t, ErrorTypeConflict, typed.Type)
}

func TestDynamoJobLedger_AcquireSemaphoreSlot_RejectsPathologicalLimit(t *testing.T) {
	ledger := NewDynamoJobLedger(nil, DefaultConfig())

	lease, err := ledger.AcquireSemaphoreSlot(context.Background(), AcquireSemaphoreSlotInput{
		Scope:         "email",
		Subject:       "customer_1",
		Limit:         maxSemaphoreAcquireLimit + 1,
		Owner:         "worker_a",
		LeaseDuration: 2 * time.Minute,
	})
	require.Nil(t, lease)
	require.Error(t, err)

	var typed *Error
	require.ErrorAs(t, err, &typed)
	require.Equal(t, ErrorTypeInvalidInput, typed.Type)
	require.Equal(t, "limit must be <= 256", typed.Message)
}

func TestDynamoJobLedger_RefreshSemaphoreSlot_Success(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	ub := new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", "PK", "=", SemaphorePartitionKey("email", "customer_1")).Return(q).Once()
	q.On("Where", "SK", "=", SemaphoreSlotSortKey(2)).Return(q).Once()
	q.On("IfExists").Return(q)
	q.On("UpdateBuilder").Return(ub)

	expiresAt := now.Add(2 * time.Minute).Unix()
	ub.On("Set", "LeaseExpiresAt", expiresAt).Return(ub)
	ub.On("Set", "UpdatedAt", now).Return(ub)
	ub.On("Condition", "LeaseOwner", "=", "worker_a").Return()
	ub.On("Condition", "LeaseExpiresAt", ">", now.Unix()).Return()
	ub.On("ExecuteWithResult", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*SemaphoreLease)
		require.True(t, ok)
		out.Scope = "email"
		out.Subject = "customer_1"
		out.Slot = 2
		out.LeaseOwner = "worker_a"
		out.LeaseExpiresAt = expiresAt
	}).Return(nil)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	lease, err := ledger.RefreshSemaphoreSlot(context.Background(), RefreshSemaphoreSlotInput{
		Scope:         "email",
		Subject:       "customer_1",
		Slot:          2,
		Owner:         "worker_a",
		LeaseDuration: 2 * time.Minute,
	})
	require.NoError(t, err)
	require.NotNil(t, lease)
	require.Equal(t, 2, lease.Slot)
}

func TestDynamoJobLedger_ReleaseSemaphoreSlot_OwnerMismatch(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	qDelete := new(tablemocks.MockQuery)
	qGet := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(qDelete).Once()
	db.On("Model", mock.Anything).Return(qGet).Once()

	pk := SemaphorePartitionKey("email", "customer_1")
	sk := SemaphoreSlotSortKey(1)

	qDelete.On("WithContext", mock.Anything).Return(qDelete)
	qDelete.On("Where", "PK", "=", pk).Return(qDelete).Once()
	qDelete.On("Where", "SK", "=", sk).Return(qDelete).Once()
	qDelete.On("WithCondition", "LeaseOwner", "=", "worker_a").Return(qDelete)
	qDelete.On("Delete").Return(tableerrors.ErrConditionFailed)

	qGet.On("WithContext", mock.Anything).Return(qGet)
	qGet.On("Where", "PK", "=", pk).Return(qGet).Once()
	qGet.On("Where", "SK", "=", sk).Return(qGet).Once()
	qGet.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*SemaphoreLease)
		require.True(t, ok)
		out.LeaseOwner = "worker_b"
	}).Return(nil)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	err := ledger.ReleaseSemaphoreSlot(context.Background(), ReleaseSemaphoreSlotInput{
		Scope:   "email",
		Subject: "customer_1",
		Slot:    1,
		Owner:   "worker_a",
	})
	require.Error(t, err)

	var typed *Error
	require.ErrorAs(t, err, &typed)
	require.Equal(t, ErrorTypeConflict, typed.Type)
}

func TestDynamoJobLedger_InspectSemaphore_ReturnsActiveLeasesSorted(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", "PK", "=", SemaphorePartitionKey("email", "customer_1")).Return(q).Once()
	q.On("All", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*[]SemaphoreLease)
		require.True(t, ok)
		*out = []SemaphoreLease{
			{Scope: "email", Subject: "customer_1", Slot: 3, LeaseOwner: "worker_c", LeaseExpiresAt: now.Add(2 * time.Minute).Unix()},
			{Scope: "email", Subject: "customer_1", Slot: 1, LeaseOwner: "worker_a", LeaseExpiresAt: now.Add(2 * time.Minute).Unix()},
			{Scope: "email", Subject: "customer_1", Slot: 2, LeaseOwner: "worker_b", LeaseExpiresAt: now.Add(-time.Minute).Unix()},
		}
	}).Return(nil)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	inspection, err := ledger.InspectSemaphore(context.Background(), InspectSemaphoreInput{
		Scope:   "email",
		Subject: "customer_1",
	})
	require.NoError(t, err)
	require.Equal(t, 2, inspection.Occupancy)
	require.Len(t, inspection.ActiveLeases, 2)
	require.Equal(t, 1, inspection.ActiveLeases[0].Slot)
	require.Equal(t, 3, inspection.ActiveLeases[1].Slot)
}

func TestDynamoJobLedger_CreateIdempotencyRecord_ExistingCompleted(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	qCreate := new(tablemocks.MockQuery)
	qGet := new(tablemocks.MockQuery)

	db.On("Model", mock.Anything).Return(qCreate).Once()
	db.On("Model", mock.Anything).Return(qGet).Once()

	qCreate.On("WithContext", mock.Anything).Return(qCreate)
	qCreate.On("IfNotExists").Return(qCreate)
	qCreate.On("Create").Return(tableerrors.ErrConditionFailed)

	qGet.On("WithContext", mock.Anything).Return(qGet)
	qGet.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(qGet)
	qGet.On("First", mock.Anything).Run(func(args mock.Arguments) {
		out, ok := args.Get(0).(*JobRequest)
		require.True(t, ok)
		out.Status = IdempotencyStatusCompleted
	}).Return(nil)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	req, outcome, err := ledger.CreateIdempotencyRecord(context.Background(), CreateIdempotencyRecordInput{
		JobID:          "job_123",
		IdempotencyKey: "k1",
	})
	require.NoError(t, err)
	require.NotNil(t, req)
	require.Equal(t, IdempotencyOutcomeAlreadyCompleted, outcome)
}

func TestDynamoJobLedger_CompleteIdempotencyRecord_SanitizesResult(t *testing.T) {
	now := time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)

	db := new(tablemocks.MockDB)
	q := new(tablemocks.MockQuery)
	ub := new(tablemocks.MockUpdateBuilder)

	db.On("Model", mock.Anything).Return(q)
	q.On("WithContext", mock.Anything).Return(q)
	q.On("Where", mock.Anything, mock.Anything, mock.Anything).Return(q)
	q.On("IfExists").Return(q)
	q.On("UpdateBuilder").Return(ub)

	ub.On("Set", "Status", IdempotencyStatusCompleted).Return(ub)
	ub.On("SetIfNotExists", "CompletedAt", nil, now).Return(ub)
	ub.On("Set", "UpdatedAt", now).Return(ub)
	ub.On("SetIfNotExists", "JobID", nil, "job_123").Return(ub)
	ub.On("SetIfNotExists", "IdempotencyKey", nil, "k1").Return(ub)
	ub.On("SetIfNotExists", "Result", nil, mock.MatchedBy(func(v map[string]any) bool {
		return v["pan"] == "411111******1111"
	})).Return(ub)
	ub.On("ExecuteWithResult", mock.Anything).Return(nil)

	ledger := NewDynamoJobLedger(db, DefaultConfig())
	ledger.SetClock(fixedClock{now: now})

	_, err := ledger.CompleteIdempotencyRecord(context.Background(), CompleteIdempotencyRecordInput{
		JobID:          "job_123",
		IdempotencyKey: "k1",
		Result: map[string]any{
			"pan": "4111111111111111",
		},
	})
	require.NoError(t, err)
}

func TestSanitizeFields_MasksPAN(t *testing.T) {
	out := SanitizeFields(map[string]any{
		"pan": "4111111111111111",
	})
	require.Equal(t, "411111******1111", out["pan"])
}
