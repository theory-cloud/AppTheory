package jobs

import (
	"context"
	"sort"
	"strings"
	"time"

	tablecore "github.com/theory-cloud/tabletheory/pkg/core"
	tableerrors "github.com/theory-cloud/tabletheory/pkg/errors"
)

type DynamoJobLedger struct {
	db     tablecore.DB
	config *Config
	clock  Clock
}

const maxSemaphoreAcquireLimit = 256

var _ JobLedger = (*DynamoJobLedger)(nil)

func NewDynamoJobLedger(db tablecore.DB, config *Config) *DynamoJobLedger {
	if config == nil {
		config = DefaultConfig()
	}
	return &DynamoJobLedger{
		db:     db,
		config: config,
		clock:  RealClock{},
	}
}

func (l *DynamoJobLedger) SetClock(clock Clock) {
	if clock == nil {
		l.clock = RealClock{}
		return
	}
	l.clock = clock
}

func (l *DynamoJobLedger) CreateJob(ctx context.Context, in CreateJobInput) (*JobMeta, error) {
	ctx = normalizeContext(ctx)
	if err := validateJobID(in.JobID); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.TenantID) == "" {
		return nil, NewError(ErrorTypeInvalidInput, "tenant_id is required")
	}

	status := in.Status
	if status == "" {
		status = JobStatusPending
	}

	now := l.clock.Now().UTC()
	meta := NewJobMeta(in.JobID)
	meta.TenantID = in.TenantID
	meta.Status = status
	meta.Version = 1
	meta.CreatedAt = now
	meta.UpdatedAt = now

	if ttl := normalizeTTLUnixSeconds(now, in.TTL, l.config.DefaultJobTTL); ttl > 0 {
		meta.TTL = ttl
	}

	err := l.db.Model(&meta).WithContext(ctx).IfNotExists().Create()
	if err != nil {
		if tableerrors.IsConditionFailed(err) {
			return nil, NewError(ErrorTypeConflict, "job already exists")
		}
		return nil, WrapError(err, ErrorTypeInternal, "failed to create job")
	}

	return &meta, nil
}

func (l *DynamoJobLedger) TransitionJobStatus(ctx context.Context, in TransitionJobStatusInput) (*JobMeta, error) {
	ctx = normalizeContext(ctx)
	if err := validateJobID(in.JobID); err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(in.ToStatus)) == "" {
		return nil, NewError(ErrorTypeInvalidInput, "to_status is required")
	}
	if in.ExpectedVersion <= 0 {
		return nil, NewError(ErrorTypeInvalidInput, "expected_version must be > 0")
	}

	now := l.clock.Now().UTC()
	pk := JobPartitionKey(in.JobID)
	sk := JobMetaSortKey()

	q := l.db.Model(&JobMeta{}).
		WithContext(ctx).
		Where("PK", "=", pk).
		Where("SK", "=", sk).
		IfExists()

	ub := q.UpdateBuilder().
		Set("Status", in.ToStatus).
		Increment("Version").
		Set("UpdatedAt", now).
		ConditionVersion(in.ExpectedVersion)

	if strings.TrimSpace(string(in.FromStatus)) != "" {
		ub = ub.Condition("Status", "=", in.FromStatus)
	}

	var out JobMeta
	if err := ub.ExecuteWithResult(&out); err != nil {
		if tableerrors.IsConditionFailed(err) {
			return nil, NewError(ErrorTypeConflict, "job status transition conflict")
		}
		return nil, WrapError(err, ErrorTypeInternal, "failed to transition job status")
	}

	return &out, nil
}

func (l *DynamoJobLedger) UpsertRecordStatus(ctx context.Context, in UpsertRecordStatusInput) (*JobRecord, error) {
	ctx = normalizeContext(ctx)
	if err := validateJobID(in.JobID); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.RecordID) == "" {
		return nil, NewError(ErrorTypeInvalidInput, "record_id is required")
	}
	if strings.TrimSpace(string(in.Status)) == "" {
		return nil, NewError(ErrorTypeInvalidInput, "status is required")
	}

	now := l.clock.Now().UTC()
	pk := JobPartitionKey(in.JobID)
	sk := JobRecordSortKey(in.RecordID)

	ub := l.db.Model(&JobRecord{}).
		WithContext(ctx).
		Where("PK", "=", pk).
		Where("SK", "=", sk).
		UpdateBuilder().
		Set("Status", in.Status).
		SetIfNotExists("JobID", nil, in.JobID).
		SetIfNotExists("RecordID", nil, in.RecordID).
		SetIfNotExists("CreatedAt", nil, now).
		Set("UpdatedAt", now)

	if ttl := normalizeTTLUnixSeconds(now, in.TTL, l.config.DefaultRecordTTL); ttl > 0 {
		ub = ub.Set("TTL", ttl)
	}

	if in.Error != nil {
		ub = ub.Set("Error", sanitizeErrorEnvelope(in.Error))
	} else {
		ub = ub.Remove("Error")
	}

	var out JobRecord
	if err := ub.ExecuteWithResult(&out); err != nil {
		return nil, WrapError(err, ErrorTypeInternal, "failed to upsert record status")
	}

	return &out, nil
}

func (l *DynamoJobLedger) AcquireLease(ctx context.Context, in AcquireLeaseInput) (*JobLock, error) {
	ctx = normalizeContext(ctx)
	if err := validateJobID(in.JobID); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.Owner) == "" {
		return nil, NewError(ErrorTypeInvalidInput, "owner is required")
	}

	leaseDuration := in.LeaseDuration
	if leaseDuration <= 0 {
		leaseDuration = l.config.DefaultLeaseDuration
	}
	if leaseDuration <= 0 {
		return nil, NewError(ErrorTypeInvalidInput, "lease_duration must be > 0")
	}

	now := l.clock.Now().UTC()
	expiresAt := now.Add(leaseDuration).Unix()
	pk := JobPartitionKey(in.JobID)
	sk := JobLockSortKey()

	ub := l.db.Model(&JobLock{}).
		WithContext(ctx).
		Where("PK", "=", pk).
		Where("SK", "=", sk).
		UpdateBuilder().
		SetIfNotExists("JobID", nil, in.JobID).
		Set("LeaseOwner", in.Owner).
		Set("LeaseExpiresAt", expiresAt).
		SetIfNotExists("CreatedAt", nil, now).
		Set("UpdatedAt", now)

	if ttl := normalizeTTLUnixSeconds(now, in.TTL, 0); ttl > 0 {
		ub = ub.Set("TTL", ttl)
	}

	ub.ConditionNotExists("LeaseExpiresAt")
	ub.OrCondition("LeaseExpiresAt", "<", now.Unix())
	ub.OrCondition("LeaseOwner", "=", in.Owner)

	var out JobLock
	if err := ub.ExecuteWithResult(&out); err != nil {
		if tableerrors.IsConditionFailed(err) {
			return nil, NewError(ErrorTypeConflict, "lease already held")
		}
		return nil, WrapError(err, ErrorTypeInternal, "failed to acquire lease")
	}

	return &out, nil
}

func (l *DynamoJobLedger) RefreshLease(ctx context.Context, in RefreshLeaseInput) (*JobLock, error) {
	ctx = normalizeContext(ctx)
	if err := validateJobID(in.JobID); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.Owner) == "" {
		return nil, NewError(ErrorTypeInvalidInput, "owner is required")
	}

	leaseDuration := in.LeaseDuration
	if leaseDuration <= 0 {
		leaseDuration = l.config.DefaultLeaseDuration
	}
	if leaseDuration <= 0 {
		return nil, NewError(ErrorTypeInvalidInput, "lease_duration must be > 0")
	}

	now := l.clock.Now().UTC()
	expiresAt := now.Add(leaseDuration).Unix()
	pk := JobPartitionKey(in.JobID)
	sk := JobLockSortKey()

	q := l.db.Model(&JobLock{}).
		WithContext(ctx).
		Where("PK", "=", pk).
		Where("SK", "=", sk).
		IfExists()

	ub := q.UpdateBuilder().
		Set("LeaseExpiresAt", expiresAt).
		Set("UpdatedAt", now).
		Condition("LeaseOwner", "=", in.Owner).
		Condition("LeaseExpiresAt", ">", now.Unix())

	if ttl := normalizeTTLUnixSeconds(now, in.TTL, 0); ttl > 0 {
		ub = ub.Set("TTL", ttl)
	}

	var out JobLock
	if err := ub.ExecuteWithResult(&out); err != nil {
		if tableerrors.IsConditionFailed(err) {
			return nil, NewError(ErrorTypeConflict, "lease refresh conflict")
		}
		return nil, WrapError(err, ErrorTypeInternal, "failed to refresh lease")
	}

	return &out, nil
}

func (l *DynamoJobLedger) ReleaseLease(ctx context.Context, in ReleaseLeaseInput) error {
	ctx = normalizeContext(ctx)
	if err := validateJobID(in.JobID); err != nil {
		return err
	}
	if strings.TrimSpace(in.Owner) == "" {
		return NewError(ErrorTypeInvalidInput, "owner is required")
	}

	pk := JobPartitionKey(in.JobID)
	sk := JobLockSortKey()

	err := l.db.Model(&JobLock{}).
		WithContext(ctx).
		Where("PK", "=", pk).
		Where("SK", "=", sk).
		WithCondition("LeaseOwner", "=", in.Owner).
		Delete()
	if err == nil {
		return nil
	}
	if !tableerrors.IsConditionFailed(err) {
		return WrapError(err, ErrorTypeInternal, "failed to release lease")
	}

	// The conditional delete may fail because the item does not exist or is owned by another worker.
	var current JobLock
	getErr := l.db.Model(&JobLock{}).
		WithContext(ctx).
		Where("PK", "=", pk).
		Where("SK", "=", sk).
		First(&current)
	if getErr == nil {
		if current.LeaseOwner != in.Owner {
			return NewError(ErrorTypeConflict, "lease not owned")
		}
		return nil
	}
	if tableerrors.IsNotFound(getErr) {
		return nil
	}
	return WrapError(getErr, ErrorTypeInternal, "failed to load lease after release conflict")
}

func (l *DynamoJobLedger) AcquireSemaphoreSlot(ctx context.Context, in AcquireSemaphoreSlotInput) (*SemaphoreLease, error) {
	ctx = normalizeContext(ctx)
	if err := validateSemaphoreKey(in.Scope, in.Subject); err != nil {
		return nil, err
	}
	if err := validateSemaphoreLimit(in.Limit); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.Owner) == "" {
		return nil, NewError(ErrorTypeInvalidInput, "owner is required")
	}

	leaseDuration := in.LeaseDuration
	if leaseDuration <= 0 {
		leaseDuration = l.config.DefaultLeaseDuration
	}
	if leaseDuration <= 0 {
		return nil, NewError(ErrorTypeInvalidInput, "lease_duration must be > 0")
	}

	now := l.clock.Now().UTC()
	expiresAt := now.Add(leaseDuration).Unix()
	pk := SemaphorePartitionKey(in.Scope, in.Subject)

	for slot := 0; slot < in.Limit; slot++ {
		sk := SemaphoreSlotSortKey(slot)
		ub := l.db.Model(&SemaphoreLease{}).
			WithContext(ctx).
			Where("PK", "=", pk).
			Where("SK", "=", sk).
			UpdateBuilder().
			SetIfNotExists("Scope", nil, in.Scope).
			SetIfNotExists("Subject", nil, in.Subject).
			SetIfNotExists("Slot", nil, slot).
			Set("LeaseOwner", in.Owner).
			Set("LeaseExpiresAt", expiresAt).
			SetIfNotExists("CreatedAt", nil, now).
			Set("UpdatedAt", now)

		if ttl := normalizeTTLUnixSeconds(now, in.TTL, 0); ttl > 0 {
			ub = ub.Set("TTL", ttl)
		}

		ub.ConditionNotExists("LeaseExpiresAt")
		ub.OrCondition("LeaseExpiresAt", "<", now.Unix())
		ub.OrCondition("LeaseOwner", "=", in.Owner)

		var out SemaphoreLease
		if err := ub.ExecuteWithResult(&out); err != nil {
			if tableerrors.IsConditionFailed(err) {
				continue
			}
			return nil, WrapError(err, ErrorTypeInternal, "failed to acquire semaphore slot")
		}

		return &out, nil
	}

	return nil, NewError(ErrorTypeConflict, "semaphore full")
}

func (l *DynamoJobLedger) RefreshSemaphoreSlot(ctx context.Context, in RefreshSemaphoreSlotInput) (*SemaphoreLease, error) {
	ctx = normalizeContext(ctx)
	if err := validateSemaphoreKey(in.Scope, in.Subject); err != nil {
		return nil, err
	}
	if err := validateSemaphoreSlot(in.Slot); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.Owner) == "" {
		return nil, NewError(ErrorTypeInvalidInput, "owner is required")
	}

	leaseDuration := in.LeaseDuration
	if leaseDuration <= 0 {
		leaseDuration = l.config.DefaultLeaseDuration
	}
	if leaseDuration <= 0 {
		return nil, NewError(ErrorTypeInvalidInput, "lease_duration must be > 0")
	}

	now := l.clock.Now().UTC()
	expiresAt := now.Add(leaseDuration).Unix()
	pk := SemaphorePartitionKey(in.Scope, in.Subject)
	sk := SemaphoreSlotSortKey(in.Slot)

	q := l.db.Model(&SemaphoreLease{}).
		WithContext(ctx).
		Where("PK", "=", pk).
		Where("SK", "=", sk).
		IfExists()

	ub := q.UpdateBuilder().
		Set("LeaseExpiresAt", expiresAt).
		Set("UpdatedAt", now).
		Condition("LeaseOwner", "=", in.Owner).
		Condition("LeaseExpiresAt", ">", now.Unix())

	if ttl := normalizeTTLUnixSeconds(now, in.TTL, 0); ttl > 0 {
		ub = ub.Set("TTL", ttl)
	}

	var out SemaphoreLease
	if err := ub.ExecuteWithResult(&out); err != nil {
		if tableerrors.IsConditionFailed(err) {
			return nil, NewError(ErrorTypeConflict, "semaphore slot refresh conflict")
		}
		return nil, WrapError(err, ErrorTypeInternal, "failed to refresh semaphore slot")
	}

	return &out, nil
}

func (l *DynamoJobLedger) ReleaseSemaphoreSlot(ctx context.Context, in ReleaseSemaphoreSlotInput) error {
	ctx = normalizeContext(ctx)
	if err := validateSemaphoreKey(in.Scope, in.Subject); err != nil {
		return err
	}
	if err := validateSemaphoreSlot(in.Slot); err != nil {
		return err
	}
	if strings.TrimSpace(in.Owner) == "" {
		return NewError(ErrorTypeInvalidInput, "owner is required")
	}

	pk := SemaphorePartitionKey(in.Scope, in.Subject)
	sk := SemaphoreSlotSortKey(in.Slot)

	err := l.db.Model(&SemaphoreLease{}).
		WithContext(ctx).
		Where("PK", "=", pk).
		Where("SK", "=", sk).
		WithCondition("LeaseOwner", "=", in.Owner).
		Delete()
	if err == nil {
		return nil
	}
	if !tableerrors.IsConditionFailed(err) {
		return WrapError(err, ErrorTypeInternal, "failed to release semaphore slot")
	}

	var current SemaphoreLease
	getErr := l.db.Model(&SemaphoreLease{}).
		WithContext(ctx).
		Where("PK", "=", pk).
		Where("SK", "=", sk).
		First(&current)
	if getErr == nil {
		if current.LeaseOwner != in.Owner {
			return NewError(ErrorTypeConflict, "semaphore slot not owned")
		}
		return nil
	}
	if tableerrors.IsNotFound(getErr) {
		return nil
	}
	return WrapError(getErr, ErrorTypeInternal, "failed to load semaphore slot after release conflict")
}

func (l *DynamoJobLedger) InspectSemaphore(ctx context.Context, in InspectSemaphoreInput) (*SemaphoreInspection, error) {
	ctx = normalizeContext(ctx)
	if err := validateSemaphoreKey(in.Scope, in.Subject); err != nil {
		return nil, err
	}

	pk := SemaphorePartitionKey(in.Scope, in.Subject)

	var leases []SemaphoreLease
	err := l.db.Model(&SemaphoreLease{}).
		WithContext(ctx).
		Where("PK", "=", pk).
		All(&leases)
	if err != nil {
		if tableerrors.IsNotFound(err) {
			return &SemaphoreInspection{
				Scope:   in.Scope,
				Subject: in.Subject,
			}, nil
		}
		return nil, WrapError(err, ErrorTypeInternal, "failed to inspect semaphore")
	}

	nowUnix := l.clock.Now().UTC().Unix()
	active := make([]SemaphoreLease, 0, len(leases))
	for _, lease := range leases {
		if lease.LeaseExpiresAt > nowUnix {
			active = append(active, lease)
		}
	}

	sort.Slice(active, func(i, j int) bool {
		return active[i].Slot < active[j].Slot
	})

	return &SemaphoreInspection{
		Scope:        in.Scope,
		Subject:      in.Subject,
		Occupancy:    len(active),
		ActiveLeases: active,
	}, nil
}

func (l *DynamoJobLedger) CreateIdempotencyRecord(ctx context.Context, in CreateIdempotencyRecordInput) (*JobRequest, IdempotencyCreateOutcome, error) {
	ctx = normalizeContext(ctx)
	if err := validateJobID(in.JobID); err != nil {
		return nil, "", err
	}
	if strings.TrimSpace(in.IdempotencyKey) == "" {
		return nil, "", NewError(ErrorTypeInvalidInput, "idempotency_key is required")
	}

	now := l.clock.Now().UTC()
	req := NewJobRequest(in.JobID, in.IdempotencyKey)
	req.Status = IdempotencyStatusInProgress
	req.CreatedAt = now
	req.UpdatedAt = now

	if ttl := normalizeTTLUnixSeconds(now, in.TTL, l.config.DefaultIdempotencyTTL); ttl > 0 {
		req.TTL = ttl
	}

	err := l.db.Model(&req).WithContext(ctx).IfNotExists().Create()
	if err == nil {
		return &req, IdempotencyOutcomeCreated, nil
	}
	if !tableerrors.IsConditionFailed(err) {
		return nil, "", WrapError(err, ErrorTypeInternal, "failed to create idempotency record")
	}

	var existing JobRequest
	getErr := l.db.Model(&JobRequest{}).
		WithContext(ctx).
		Where("PK", "=", req.PK).
		Where("SK", "=", req.SK).
		First(&existing)
	if getErr != nil {
		return nil, "", WrapError(getErr, ErrorTypeInternal, "failed to load existing idempotency record")
	}

	if existing.Status == IdempotencyStatusCompleted {
		return &existing, IdempotencyOutcomeAlreadyCompleted, nil
	}
	return &existing, IdempotencyOutcomeAlreadyInProgress, nil
}

func (l *DynamoJobLedger) CompleteIdempotencyRecord(ctx context.Context, in CompleteIdempotencyRecordInput) (*JobRequest, error) {
	ctx = normalizeContext(ctx)
	if err := validateJobID(in.JobID); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.IdempotencyKey) == "" {
		return nil, NewError(ErrorTypeInvalidInput, "idempotency_key is required")
	}

	now := l.clock.Now().UTC()
	pk := JobPartitionKey(in.JobID)
	sk := JobRequestSortKey(in.IdempotencyKey)

	q := l.db.Model(&JobRequest{}).
		WithContext(ctx).
		Where("PK", "=", pk).
		Where("SK", "=", sk).
		IfExists()

	ub := q.UpdateBuilder().
		Set("Status", IdempotencyStatusCompleted).
		SetIfNotExists("CompletedAt", nil, now).
		Set("UpdatedAt", now).
		SetIfNotExists("JobID", nil, in.JobID).
		SetIfNotExists("IdempotencyKey", nil, in.IdempotencyKey)

	if len(in.Result) > 0 {
		ub = ub.SetIfNotExists("Result", nil, SanitizeFields(in.Result))
	}
	if in.Error != nil {
		ub = ub.SetIfNotExists("Error", nil, sanitizeErrorEnvelope(in.Error))
	}
	if ttl := normalizeTTLUnixSeconds(now, in.TTL, l.config.DefaultRequestResultTTL); ttl > 0 {
		ub = ub.SetIfNotExists("TTL", nil, ttl)
	}

	var out JobRequest
	if err := ub.ExecuteWithResult(&out); err != nil {
		if tableerrors.IsConditionFailed(err) {
			return nil, NewError(ErrorTypeNotFound, "idempotency record not found")
		}
		return nil, WrapError(err, ErrorTypeInternal, "failed to complete idempotency record")
	}

	return &out, nil
}

func normalizeContext(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return ctx
}

func validateJobID(jobID string) error {
	if strings.TrimSpace(jobID) == "" {
		return NewError(ErrorTypeInvalidInput, "job_id is required")
	}
	return nil
}

func validateSemaphoreKey(scope, subject string) error {
	if strings.TrimSpace(scope) == "" {
		return NewError(ErrorTypeInvalidInput, "scope is required")
	}
	if strings.TrimSpace(subject) == "" {
		return NewError(ErrorTypeInvalidInput, "subject is required")
	}
	return nil
}

func validateSemaphoreSlot(slot int) error {
	if slot < 0 {
		return NewError(ErrorTypeInvalidInput, "slot must be >= 0")
	}
	return nil
}

func validateSemaphoreLimit(limit int) error {
	if limit <= 0 {
		return NewError(ErrorTypeInvalidInput, "limit must be > 0")
	}
	if limit > maxSemaphoreAcquireLimit {
		return NewError(ErrorTypeInvalidInput, "limit must be <= 256")
	}
	return nil
}

func normalizeTTLUnixSeconds(now time.Time, ttl time.Duration, fallback time.Duration) int64 {
	if ttl == 0 {
		ttl = fallback
	}
	if ttl <= 0 {
		return 0
	}
	return now.Add(ttl).Unix()
}

func sanitizeErrorEnvelope(env *ErrorEnvelope) *ErrorEnvelope {
	if env == nil {
		return nil
	}
	out := &ErrorEnvelope{
		Type:      SanitizeLogString(env.Type),
		Code:      SanitizeLogString(env.Code),
		Message:   SanitizeLogString(env.Message),
		Retryable: env.Retryable,
		Fields:    SanitizeFields(env.Fields),
	}
	if strings.TrimSpace(out.Message) == "" {
		out.Message = "unknown error"
	}
	return out
}
