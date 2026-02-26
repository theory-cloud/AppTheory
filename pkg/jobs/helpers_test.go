package jobs

import (
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestJobsTableModel_TableName_EnvOverride(t *testing.T) {
	var m jobsTableModel

	t.Setenv(EnvJobsTableName, "custom-table")
	require.Equal(t, "custom-table", m.TableName())

	t.Setenv(EnvJobsTableName, "")
	require.Equal(t, "apptheory-jobs", m.TableName())
}

func TestJobsKeyHelpers(t *testing.T) {
	require.Equal(t, "JOB#j1", JobPartitionKey("j1"))
	require.Equal(t, "META", JobMetaSortKey())
	require.Equal(t, "LOCK", JobLockSortKey())
	require.Equal(t, "REC#r1", JobRecordSortKey("r1"))
	require.Equal(t, "REQ#k1", JobRequestSortKey("k1"))
}

func TestJobsModels_SetKeys_AndString(t *testing.T) {
	meta := NewJobMeta("j1")
	require.Equal(t, "JOB#j1", meta.PK)
	require.Equal(t, "META", meta.SK)

	record := NewJobRecord("j1", "r1")
	require.Equal(t, "JOB#j1", record.PK)
	require.Equal(t, "REC#r1", record.SK)

	lock := NewJobLock("j1")
	require.Equal(t, "JOB#j1", lock.PK)
	require.Equal(t, "LOCK", lock.SK)

	req := NewJobRequest("j1", "k1")
	require.Equal(t, "JOB#j1", req.PK)
	require.Equal(t, "REQ#k1", req.SK)
	require.Equal(t, `jobs.JobRequest{job_id:"j1",key:"k1",status:""}`, req.String())

	var nilReq *JobRequest
	require.Equal(t, "jobs.JobRequest<nil>", nilReq.String())
}

func TestJobsError_Helpers(t *testing.T) {
	var nilErr *Error
	require.Equal(t, "jobs error", nilErr.Error())
	require.Nil(t, nilErr.Unwrap())

	cfg := DefaultConfig()
	require.Equal(t, 5*time.Minute, cfg.DefaultLeaseDuration)
	require.Equal(t, 24*time.Hour, cfg.DefaultIdempotencyTTL)
	require.Equal(t, time.Duration(0), cfg.DefaultJobTTL)

	root := errors.New("boom")
	wrapped := WrapError(root, ErrorTypeInternal, "failed")
	require.Equal(t, "failed: boom", wrapped.Error())
	require.ErrorIs(t, wrapped, root)
}

func TestJobsSafeLogging(t *testing.T) {
	require.Nil(t, SanitizeFields(nil))
	require.Nil(t, SanitizeFields(map[string]any{}))

	safe := SanitizeFields(map[string]any{"pan": "4111111111111111", "ok": "hi"})
	require.Equal(t, "411111******1111", safe["pan"])
	require.Equal(t, "hi", safe["ok"])

	env := NewErrorEnvelope("bad\nnews", map[string]any{"pan": "4111111111111111"})
	require.Equal(t, "badnews", env.Message)
	require.Equal(t, "411111******1111", env.Fields["pan"])

	unknown := NewErrorEnvelope("\n", nil)
	require.Equal(t, "unknown error", unknown.Message)

	require.Nil(t, ErrorEnvelopeFromError(nil, nil))
	typed := ErrorEnvelopeFromError(NewError(ErrorTypeConflict, "boom\n"), map[string]any{"pan": "4111111111111111"})
	require.Equal(t, "conflict", typed.Type)
	require.Equal(t, "boom", typed.Message)
	require.Equal(t, "411111******1111", typed.Fields["pan"])
}
