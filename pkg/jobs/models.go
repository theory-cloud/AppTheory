package jobs

import (
	"fmt"
	"os"
	"time"
)

const (
	EnvJobsTableName      = "APPTHEORY_JOBS_TABLE_NAME"
	defaultJobsTableName  = "apptheory-jobs"
	jobPartitionKeyPrefix = "JOB#"

	jobMetaSortKey = "META"
	jobLockSortKey = "LOCK"

	jobRecordSortKeyPrefix      = "REC#"
	jobRequestSortKeyPrefix     = "REQ#"
	semaphorePartitionKeyPrefix = "SEM#"
	semaphoreSlotSortKeyPrefix  = "SLOT#"
)

type jobsTableModel struct{}

func (jobsTableModel) TableName() string {
	if name := os.Getenv(EnvJobsTableName); name != "" {
		return name
	}
	return defaultJobsTableName
}

func JobPartitionKey(jobID string) string {
	return jobPartitionKeyPrefix + jobID
}

func JobMetaSortKey() string {
	return jobMetaSortKey
}

func JobLockSortKey() string {
	return jobLockSortKey
}

func JobRecordSortKey(recordID string) string {
	return jobRecordSortKeyPrefix + recordID
}

func JobRequestSortKey(idempotencyKey string) string {
	return jobRequestSortKeyPrefix + idempotencyKey
}

func SemaphorePartitionKey(scope, subject string) string {
	return semaphorePartitionKeyPrefix + scope + "#" + subject
}

func SemaphoreSlotSortKey(slot int) string {
	return fmt.Sprintf("%s%09d", semaphoreSlotSortKeyPrefix, slot)
}

type JobMeta struct {
	jobsTableModel
	_ struct{} `theorydb:"naming:snake_case"`

	PK string `theorydb:"pk" json:"pk"`
	SK string `theorydb:"sk" json:"sk"`

	JobID    string    `json:"job_id"`
	TenantID string    `json:"tenant_id" theorydb:"index:tenant-created-index,pk"`
	Status   JobStatus `json:"status" theorydb:"index:status-created-index,pk"`

	CreatedAt time.Time `json:"created_at" theorydb:"index:tenant-created-index,sk,index:status-created-index,sk"`
	UpdatedAt time.Time `json:"updated_at"`

	Version int64 `json:"version" theorydb:"version"`

	TTL int64 `json:"ttl,omitempty" theorydb:"ttl,omitempty"`
}

func NewJobMeta(jobID string) JobMeta {
	meta := JobMeta{JobID: jobID}
	meta.SetKeys()
	return meta
}

func (j *JobMeta) SetKeys() {
	j.PK = JobPartitionKey(j.JobID)
	j.SK = JobMetaSortKey()
}

type JobRecord struct {
	jobsTableModel
	_ struct{} `theorydb:"naming:snake_case"`

	PK string `theorydb:"pk" json:"pk"`
	SK string `theorydb:"sk" json:"sk"`

	JobID    string       `json:"job_id"`
	RecordID string       `json:"record_id"`
	Status   RecordStatus `json:"status"`

	Error *ErrorEnvelope `json:"error,omitempty" theorydb:"omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	TTL int64 `json:"ttl,omitempty" theorydb:"ttl,omitempty"`
}

func NewJobRecord(jobID, recordID string) JobRecord {
	record := JobRecord{JobID: jobID, RecordID: recordID}
	record.SetKeys()
	return record
}

func (r *JobRecord) SetKeys() {
	r.PK = JobPartitionKey(r.JobID)
	r.SK = JobRecordSortKey(r.RecordID)
}

type JobLock struct {
	jobsTableModel
	_ struct{} `theorydb:"naming:snake_case"`

	PK string `theorydb:"pk" json:"pk"`
	SK string `theorydb:"sk" json:"sk"`

	JobID string `json:"job_id"`

	LeaseOwner     string `json:"lease_owner"`
	LeaseExpiresAt int64  `json:"lease_expires_at"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	TTL int64 `json:"ttl,omitempty" theorydb:"ttl,omitempty"`
}

func NewJobLock(jobID string) JobLock {
	lock := JobLock{JobID: jobID}
	lock.SetKeys()
	return lock
}

func (l *JobLock) SetKeys() {
	l.PK = JobPartitionKey(l.JobID)
	l.SK = JobLockSortKey()
}

type JobRequest struct {
	jobsTableModel
	_ struct{} `theorydb:"naming:snake_case"`

	PK string `theorydb:"pk" json:"pk"`
	SK string `theorydb:"sk" json:"sk"`

	JobID          string            `json:"job_id"`
	IdempotencyKey string            `json:"idempotency_key"`
	Status         IdempotencyStatus `json:"status"`

	Result map[string]any `json:"result,omitempty" theorydb:"omitempty"`
	Error  *ErrorEnvelope `json:"error,omitempty" theorydb:"omitempty"`

	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	CompletedAt time.Time `json:"completed_at,omitempty" theorydb:"omitempty"`

	TTL int64 `json:"ttl,omitempty" theorydb:"ttl,omitempty"`
}

func NewJobRequest(jobID, idempotencyKey string) JobRequest {
	req := JobRequest{JobID: jobID, IdempotencyKey: idempotencyKey}
	req.SetKeys()
	return req
}

func (r *JobRequest) SetKeys() {
	r.PK = JobPartitionKey(r.JobID)
	r.SK = JobRequestSortKey(r.IdempotencyKey)
}

func (r *JobRequest) String() string {
	if r == nil {
		return "jobs.JobRequest<nil>"
	}
	return fmt.Sprintf("jobs.JobRequest{job_id:%q,key:%q,status:%q}", r.JobID, r.IdempotencyKey, r.Status)
}

type SemaphoreLease struct {
	jobsTableModel
	_ struct{} `theorydb:"naming:snake_case"`

	PK string `theorydb:"pk" json:"pk"`
	SK string `theorydb:"sk" json:"sk"`

	Scope   string `json:"scope"`
	Subject string `json:"subject"`
	Slot    int    `json:"slot"`

	LeaseOwner     string `json:"lease_owner"`
	LeaseExpiresAt int64  `json:"lease_expires_at"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	TTL int64 `json:"ttl,omitempty" theorydb:"ttl,omitempty"`
}

func NewSemaphoreLease(scope, subject string, slot int) SemaphoreLease {
	lease := SemaphoreLease{
		Scope:   scope,
		Subject: subject,
		Slot:    slot,
	}
	lease.SetKeys()
	return lease
}

func (l *SemaphoreLease) SetKeys() {
	l.PK = SemaphorePartitionKey(l.Scope, l.Subject)
	l.SK = SemaphoreSlotSortKey(l.Slot)
}
