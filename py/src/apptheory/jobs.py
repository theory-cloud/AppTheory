from __future__ import annotations

import datetime as dt
import os
from dataclasses import dataclass, field
from typing import Any, Literal

from theorydb_py import ConditionFailedError, ModelDefinition, NotFoundError, Table, UpdateAdd, UpdateSetIfNotExists

from apptheory.clock import Clock, RealClock
from apptheory.sanitization import sanitize_field_value, sanitize_log_string

EnvJobsTableName = "APPTHEORY_JOBS_TABLE_NAME"
DEFAULT_JOBS_TABLE_NAME = "apptheory-jobs"
MAX_SEMAPHORE_ACQUIRE_LIMIT = 256

JobStatus = Literal["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"]
RecordStatus = Literal["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "SKIPPED"]
IdempotencyStatus = Literal["IN_PROGRESS", "COMPLETED"]
IdempotencyCreateOutcome = Literal["created", "already_in_progress", "already_completed"]

ErrorType = Literal["internal_error", "invalid_input", "conflict", "not_found"]


@dataclass(slots=True)
class JobLedgerError(Exception):
    type: ErrorType
    message: str
    cause: Exception | None = None

    def __str__(self) -> str:
        if self.cause is not None:
            return f"{self.message}: {self.cause}"
        return self.message


def new_error(error_type: ErrorType, message: str) -> JobLedgerError:
    return JobLedgerError(type=error_type, message=str(message))


def wrap_error(cause: Exception, error_type: ErrorType, message: str) -> JobLedgerError:
    return JobLedgerError(type=error_type, message=str(message), cause=cause)


def jobs_table_name() -> str:
    return str(os.environ.get(EnvJobsTableName, "") or "").strip() or DEFAULT_JOBS_TABLE_NAME


def job_partition_key(job_id: str) -> str:
    return f"JOB#{job_id}"


def job_meta_sort_key() -> str:
    return "META"


def job_record_sort_key(record_id: str) -> str:
    return f"REC#{record_id}"


def job_lock_sort_key() -> str:
    return "LOCK"


def job_request_sort_key(idempotency_key: str) -> str:
    return f"REQ#{idempotency_key}"


def semaphore_partition_key(scope: str, subject: str) -> str:
    return f"SEM#{scope}#{subject}"


def semaphore_slot_sort_key(slot: int) -> str:
    return f"SLOT#{max(0, int(slot)):09d}"


def validate_semaphore_limit(limit: int) -> int:
    normalized = int(limit)
    if normalized <= 0:
        raise new_error("invalid_input", "limit must be > 0")
    if normalized > MAX_SEMAPHORE_ACQUIRE_LIMIT:
        raise new_error("invalid_input", f"limit must be <= {MAX_SEMAPHORE_ACQUIRE_LIMIT}")
    return normalized


def unix_seconds(value: dt.datetime) -> int:
    return int(value.timestamp())


def format_rfc3339_nano(value: dt.datetime) -> str:
    dt_utc = value.astimezone(dt.UTC) if value.tzinfo else value.replace(tzinfo=dt.UTC)
    # Python supports microseconds; keep deterministic RFC3339 with Z suffix.
    return dt_utc.isoformat(timespec="microseconds").replace("+00:00", "Z")


def sanitize_fields(fields: dict[str, Any] | None) -> dict[str, Any] | None:
    if not fields:
        return None
    out: dict[str, Any] = {}
    for k, v in dict(fields).items():
        key = str(k).strip()
        if not key:
            continue
        out[key] = sanitize_field_value(key, v)
    return out or None


def sanitize_error_envelope(envelope: dict[str, Any] | None) -> dict[str, Any] | None:
    if not envelope:
        return None
    msg = sanitize_log_string(str(envelope.get("message") or "")) or "unknown error"
    out: dict[str, Any] = {"message": msg}
    if str(envelope.get("type") or "").strip():
        out["type"] = sanitize_log_string(str(envelope.get("type") or ""))
    if str(envelope.get("code") or "").strip():
        out["code"] = sanitize_log_string(str(envelope.get("code") or ""))
    if bool(envelope.get("retryable")):
        out["retryable"] = True
    fields = sanitize_fields(envelope.get("fields") if isinstance(envelope.get("fields"), dict) else None)
    if fields:
        out["fields"] = fields
    return out


def _theorydb_meta(
    name: str,
    *,
    roles: list[str] | None = None,
    omitempty: bool = False,
    set_field: bool = False,
    json_field: bool = False,
) -> dict[str, Any]:
    return {
        "theorydb": {
            "name": name,
            "roles": list(roles or []),
            "omitempty": bool(omitempty),
            "set": bool(set_field),
            "json": bool(json_field),
            "binary": False,
            "encrypted": False,
            "converter": None,
            "ignore": False,
        }
    }


def _s(name: str, *, roles: list[str] | None = None, omitempty: bool = False) -> Any:
    return field(default="", metadata=_theorydb_meta(name, roles=roles, omitempty=omitempty))


def _n(name: str, *, roles: list[str] | None = None, omitempty: bool = False) -> Any:
    return field(default=0, metadata=_theorydb_meta(name, roles=roles, omitempty=omitempty))


def _m(name: str, *, omitempty: bool = False) -> Any:
    return field(default=None, metadata=_theorydb_meta(name, omitempty=omitempty))


@dataclass(slots=True)
class JobMeta:
    pk: str = _s("pk", roles=["pk"])
    sk: str = _s("sk", roles=["sk"])

    job_id: str = _s("job_id")
    tenant_id: str = _s("tenant_id")
    status: str = _s("status")

    created_at: str = _s("created_at")
    updated_at: str = _s("updated_at")

    version: int = _n("version", roles=["version"])
    ttl: int = _n("ttl", roles=["ttl"], omitempty=True)


@dataclass(slots=True)
class JobRecord:
    pk: str = _s("pk", roles=["pk"])
    sk: str = _s("sk", roles=["sk"])

    job_id: str = _s("job_id")
    record_id: str = _s("record_id")
    status: str = _s("status")

    error: dict[str, Any] | None = field(default=None, metadata=_theorydb_meta("error", omitempty=True))

    created_at: str = _s("created_at")
    updated_at: str = _s("updated_at")

    ttl: int = _n("ttl", roles=["ttl"], omitempty=True)


@dataclass(slots=True)
class JobLock:
    pk: str = _s("pk", roles=["pk"])
    sk: str = _s("sk", roles=["sk"])

    job_id: str = _s("job_id")

    lease_owner: str = _s("lease_owner")
    lease_expires_at: int = _n("lease_expires_at")

    created_at: str = _s("created_at")
    updated_at: str = _s("updated_at")

    ttl: int = _n("ttl", roles=["ttl"], omitempty=True)


@dataclass(slots=True)
class JobRequest:
    pk: str = _s("pk", roles=["pk"])
    sk: str = _s("sk", roles=["sk"])

    job_id: str = _s("job_id")
    idempotency_key: str = _s("idempotency_key")
    status: str = _s("status")

    result: dict[str, Any] | None = field(default=None, metadata=_theorydb_meta("result", omitempty=True))
    error: dict[str, Any] | None = field(default=None, metadata=_theorydb_meta("error", omitempty=True))

    created_at: str = _s("created_at")
    updated_at: str = _s("updated_at")
    completed_at: str = _s("completed_at", omitempty=True)

    ttl: int = _n("ttl", roles=["ttl"], omitempty=True)


@dataclass(slots=True)
class SemaphoreLease:
    pk: str = _s("pk", roles=["pk"])
    sk: str = _s("sk", roles=["sk"])

    scope: str = _s("scope")
    subject: str = _s("subject")
    slot: int = _n("slot")

    lease_owner: str = _s("lease_owner")
    lease_expires_at: int = _n("lease_expires_at")

    created_at: str = _s("created_at")
    updated_at: str = _s("updated_at")

    ttl: int = _n("ttl", roles=["ttl"], omitempty=True)


_JOB_META_MODEL = ModelDefinition.from_dataclass(JobMeta, table_name=None)
_JOB_RECORD_MODEL = ModelDefinition.from_dataclass(JobRecord, table_name=None)
_JOB_LOCK_MODEL = ModelDefinition.from_dataclass(JobLock, table_name=None)
_JOB_REQUEST_MODEL = ModelDefinition.from_dataclass(JobRequest, table_name=None)
_SEMAPHORE_LEASE_MODEL = ModelDefinition.from_dataclass(SemaphoreLease, table_name=None)


@dataclass(slots=True)
class JobsConfig:
    table_name: str = ""
    default_lease_duration: dt.timedelta = dt.timedelta(minutes=5)
    default_idempotency_ttl: dt.timedelta = dt.timedelta(hours=24)
    default_job_ttl: dt.timedelta = dt.timedelta(0)
    default_record_ttl: dt.timedelta = dt.timedelta(0)
    default_request_result_ttl: dt.timedelta = dt.timedelta(0)


def default_config() -> JobsConfig:
    return JobsConfig()


def _resolve_table_name(config: JobsConfig) -> str:
    value = str(getattr(config, "table_name", "") or "").strip()
    return value or jobs_table_name()


def _normalize_ttl_unix_seconds(now: dt.datetime, ttl: dt.timedelta | None, fallback: dt.timedelta) -> int:
    use = ttl if ttl is not None else fallback
    if not use or use <= dt.timedelta(0):
        return 0
    return unix_seconds(now + use)


@dataclass(slots=True)
class DynamoJobLedger:
    meta_table: Any
    record_table: Any
    lock_table: Any
    semaphore_table: Any
    request_table: Any
    config: JobsConfig
    clock: Clock

    def __init__(
        self,
        *,
        meta_table: Any | None = None,
        record_table: Any | None = None,
        lock_table: Any | None = None,
        semaphore_table: Any | None = None,
        request_table: Any | None = None,
        config: JobsConfig | None = None,
        clock: Clock | None = None,
    ) -> None:
        self.config = config or default_config()
        table_name = _resolve_table_name(self.config)

        self.meta_table = meta_table or Table(_JOB_META_MODEL, table_name=table_name)
        self.record_table = record_table or Table(_JOB_RECORD_MODEL, table_name=table_name)
        self.lock_table = lock_table or Table(_JOB_LOCK_MODEL, table_name=table_name)
        self.semaphore_table = semaphore_table or Table(_SEMAPHORE_LEASE_MODEL, table_name=table_name)
        self.request_table = request_table or Table(_JOB_REQUEST_MODEL, table_name=table_name)

        self.clock = clock or RealClock()

    def set_clock(self, clock: Clock | None) -> None:
        self.clock = clock or RealClock()

    def create_job(
        self,
        *,
        job_id: str,
        tenant_id: str,
        status: JobStatus = "PENDING",
        ttl: dt.timedelta | None = None,
    ) -> JobMeta:
        job_id = str(job_id or "").strip()
        tenant_id = str(tenant_id or "").strip()
        if not job_id:
            raise new_error("invalid_input", "job_id is required")
        if not tenant_id:
            raise new_error("invalid_input", "tenant_id is required")

        now = self.clock.now()
        now_str = format_rfc3339_nano(now)

        meta = JobMeta(
            pk=job_partition_key(job_id),
            sk=job_meta_sort_key(),
            job_id=job_id,
            tenant_id=tenant_id,
            status=str(status),
            created_at=now_str,
            updated_at=now_str,
            version=1,
            ttl=_normalize_ttl_unix_seconds(now, ttl, self.config.default_job_ttl),
        )

        try:
            self.meta_table.put(
                meta,
                condition_expression="attribute_not_exists(#pk)",
                expression_attribute_names={"#pk": "pk"},
            )
            return meta
        except Exception as exc:
            if isinstance(exc, ConditionFailedError):
                raise new_error("conflict", "job already exists") from exc
            raise wrap_error(exc, "internal_error", "failed to create job") from exc

    def transition_job_status(
        self,
        *,
        job_id: str,
        expected_version: int,
        to_status: JobStatus,
        from_status: JobStatus | None = None,
    ) -> JobMeta:
        job_id = str(job_id or "").strip()
        if not job_id:
            raise new_error("invalid_input", "job_id is required")
        if int(expected_version) <= 0:
            raise new_error("invalid_input", "expected_version must be > 0")

        now = self.clock.now()
        now_str = format_rfc3339_nano(now)

        pk = job_partition_key(job_id)
        sk = job_meta_sort_key()

        cond = "attribute_exists(#pk) AND #version = :expected"
        names: dict[str, str] = {"#pk": "pk", "#version": "version"}
        values: dict[str, object] = {":expected": int(expected_version)}
        if from_status is not None:
            cond += " AND #status = :from"
            names["#status"] = "status"
            values[":from"] = str(from_status)

        try:
            return self.meta_table.update(
                pk,
                sk,
                {
                    "status": str(to_status),
                    "version": UpdateAdd(1),
                    "updated_at": now_str,
                },
                condition_expression=cond,
                expression_attribute_names=names,
                expression_attribute_values=values,
            )
        except Exception as exc:
            if isinstance(exc, ConditionFailedError):
                raise new_error("conflict", "job status transition conflict") from exc
            raise wrap_error(exc, "internal_error", "failed to transition job status") from exc

    def upsert_record_status(
        self,
        *,
        job_id: str,
        record_id: str,
        status: RecordStatus,
        error: dict[str, Any] | None = None,
        ttl: dt.timedelta | None = None,
    ) -> JobRecord:
        job_id = str(job_id or "").strip()
        record_id = str(record_id or "").strip()
        if not job_id:
            raise new_error("invalid_input", "job_id is required")
        if not record_id:
            raise new_error("invalid_input", "record_id is required")

        now = self.clock.now()
        now_str = format_rfc3339_nano(now)

        pk = job_partition_key(job_id)
        sk = job_record_sort_key(record_id)

        ttl_unix = _normalize_ttl_unix_seconds(now, ttl, self.config.default_record_ttl)

        try:
            return self.record_table.update(
                pk,
                sk,
                {
                    "status": str(status),
                    "updated_at": now_str,
                    "job_id": UpdateSetIfNotExists(job_id),
                    "record_id": UpdateSetIfNotExists(record_id),
                    "created_at": UpdateSetIfNotExists(now_str),
                    "error": sanitize_error_envelope(error),
                    **({"ttl": ttl_unix} if ttl_unix > 0 else {}),
                },
            )
        except Exception as exc:
            raise wrap_error(exc, "internal_error", "failed to upsert record status") from exc

    def acquire_lease(
        self,
        *,
        job_id: str,
        owner: str,
        lease_duration: dt.timedelta | None = None,
        ttl: dt.timedelta | None = None,
    ) -> JobLock:
        job_id = str(job_id or "").strip()
        owner = str(owner or "").strip()
        if not job_id:
            raise new_error("invalid_input", "job_id is required")
        if not owner:
            raise new_error("invalid_input", "owner is required")

        duration = lease_duration if lease_duration is not None else self.config.default_lease_duration
        if not duration or duration <= dt.timedelta(0):
            raise new_error("invalid_input", "lease_duration must be > 0")

        now = self.clock.now()
        now_str = format_rfc3339_nano(now)
        now_unix = unix_seconds(now)
        expires_at = unix_seconds(now + duration)

        pk = job_partition_key(job_id)
        sk = job_lock_sort_key()
        ttl_unix = _normalize_ttl_unix_seconds(now, ttl, dt.timedelta(0))

        try:
            return self.lock_table.update(
                pk,
                sk,
                {
                    "job_id": UpdateSetIfNotExists(job_id),
                    "lease_owner": owner,
                    "lease_expires_at": expires_at,
                    "created_at": UpdateSetIfNotExists(now_str),
                    "updated_at": now_str,
                    **({"ttl": ttl_unix} if ttl_unix > 0 else {}),
                },
                condition_expression=(
                    "attribute_not_exists(#lease_expires_at) OR #lease_expires_at < :now OR #lease_owner = :owner"
                ),
                expression_attribute_names={"#lease_expires_at": "lease_expires_at", "#lease_owner": "lease_owner"},
                expression_attribute_values={":now": now_unix, ":owner": owner},
            )
        except Exception as exc:
            if isinstance(exc, ConditionFailedError):
                raise new_error("conflict", "lease already held") from exc
            raise wrap_error(exc, "internal_error", "failed to acquire lease") from exc

    def refresh_lease(
        self,
        *,
        job_id: str,
        owner: str,
        lease_duration: dt.timedelta | None = None,
        ttl: dt.timedelta | None = None,
    ) -> JobLock:
        job_id = str(job_id or "").strip()
        owner = str(owner or "").strip()
        if not job_id:
            raise new_error("invalid_input", "job_id is required")
        if not owner:
            raise new_error("invalid_input", "owner is required")

        duration = lease_duration if lease_duration is not None else self.config.default_lease_duration
        if not duration or duration <= dt.timedelta(0):
            raise new_error("invalid_input", "lease_duration must be > 0")

        now = self.clock.now()
        now_str = format_rfc3339_nano(now)
        now_unix = unix_seconds(now)
        expires_at = unix_seconds(now + duration)

        pk = job_partition_key(job_id)
        sk = job_lock_sort_key()
        ttl_unix = _normalize_ttl_unix_seconds(now, ttl, dt.timedelta(0))

        try:
            return self.lock_table.update(
                pk,
                sk,
                {
                    "lease_expires_at": expires_at,
                    "updated_at": now_str,
                    **({"ttl": ttl_unix} if ttl_unix > 0 else {}),
                },
                condition_expression="#lease_owner = :owner AND #lease_expires_at > :now",
                expression_attribute_names={"#lease_owner": "lease_owner", "#lease_expires_at": "lease_expires_at"},
                expression_attribute_values={":owner": owner, ":now": now_unix},
            )
        except Exception as exc:
            if isinstance(exc, ConditionFailedError):
                raise new_error("conflict", "lease refresh conflict") from exc
            raise wrap_error(exc, "internal_error", "failed to refresh lease") from exc

    def release_lease(self, *, job_id: str, owner: str) -> None:
        job_id = str(job_id or "").strip()
        owner = str(owner or "").strip()
        if not job_id:
            raise new_error("invalid_input", "job_id is required")
        if not owner:
            raise new_error("invalid_input", "owner is required")

        pk = job_partition_key(job_id)
        sk = job_lock_sort_key()
        now_str = format_rfc3339_nano(self.clock.now())

        try:
            self.lock_table.update(
                pk,
                sk,
                {
                    "lease_owner": "",
                    "lease_expires_at": 0,
                    "updated_at": now_str,
                },
                condition_expression="#lease_owner = :owner",
                expression_attribute_names={"#lease_owner": "lease_owner"},
                expression_attribute_values={":owner": owner},
            )
            return
        except Exception as exc:
            if not isinstance(exc, ConditionFailedError):
                raise wrap_error(exc, "internal_error", "failed to release lease") from exc

        try:
            current = self.lock_table.get(pk, sk)
        except NotFoundError:
            return
        except Exception as exc:
            raise wrap_error(exc, "internal_error", "failed to load lease after release conflict") from exc

        if not getattr(current, "lease_owner", ""):
            return
        if str(getattr(current, "lease_owner", "") or "") != owner:
            raise new_error("conflict", "lease not owned")

    def acquire_semaphore_slot(
        self,
        *,
        scope: str,
        subject: str,
        limit: int,
        owner: str,
        lease_duration: dt.timedelta | None = None,
        ttl: dt.timedelta | None = None,
    ) -> SemaphoreLease:
        scope = str(scope or "").strip()
        subject = str(subject or "").strip()
        owner = str(owner or "").strip()
        if not scope:
            raise new_error("invalid_input", "scope is required")
        if not subject:
            raise new_error("invalid_input", "subject is required")
        limit = validate_semaphore_limit(limit)
        if not owner:
            raise new_error("invalid_input", "owner is required")

        duration = lease_duration if lease_duration is not None else self.config.default_lease_duration
        if not duration or duration <= dt.timedelta(0):
            raise new_error("invalid_input", "lease_duration must be > 0")

        now = self.clock.now()
        now_str = format_rfc3339_nano(now)
        now_unix = unix_seconds(now)
        expires_at = unix_seconds(now + duration)
        ttl_unix = _normalize_ttl_unix_seconds(now, ttl, dt.timedelta(0))
        pk = semaphore_partition_key(scope, subject)

        for slot in range(limit):
            sk = semaphore_slot_sort_key(slot)
            try:
                return self.semaphore_table.update(
                    pk,
                    sk,
                    {
                        "scope": UpdateSetIfNotExists(scope),
                        "subject": UpdateSetIfNotExists(subject),
                        "slot": UpdateSetIfNotExists(slot),
                        "lease_owner": owner,
                        "lease_expires_at": expires_at,
                        "created_at": UpdateSetIfNotExists(now_str),
                        "updated_at": now_str,
                        **({"ttl": ttl_unix} if ttl_unix > 0 else {}),
                    },
                    condition_expression=(
                        "attribute_not_exists(#lease_expires_at) OR #lease_expires_at < :now OR #lease_owner = :owner"
                    ),
                    expression_attribute_names={"#lease_expires_at": "lease_expires_at", "#lease_owner": "lease_owner"},
                    expression_attribute_values={":now": now_unix, ":owner": owner},
                )
            except Exception as exc:
                if isinstance(exc, ConditionFailedError):
                    continue
                raise wrap_error(exc, "internal_error", "failed to acquire semaphore slot") from exc

        raise new_error("conflict", "semaphore full")

    def refresh_semaphore_slot(
        self,
        *,
        scope: str,
        subject: str,
        slot: int,
        owner: str,
        lease_duration: dt.timedelta | None = None,
        ttl: dt.timedelta | None = None,
    ) -> SemaphoreLease:
        scope = str(scope or "").strip()
        subject = str(subject or "").strip()
        owner = str(owner or "").strip()
        if not scope:
            raise new_error("invalid_input", "scope is required")
        if not subject:
            raise new_error("invalid_input", "subject is required")
        if int(slot) < 0:
            raise new_error("invalid_input", "slot must be >= 0")
        if not owner:
            raise new_error("invalid_input", "owner is required")

        duration = lease_duration if lease_duration is not None else self.config.default_lease_duration
        if not duration or duration <= dt.timedelta(0):
            raise new_error("invalid_input", "lease_duration must be > 0")

        now = self.clock.now()
        now_str = format_rfc3339_nano(now)
        now_unix = unix_seconds(now)
        expires_at = unix_seconds(now + duration)
        ttl_unix = _normalize_ttl_unix_seconds(now, ttl, dt.timedelta(0))
        pk = semaphore_partition_key(scope, subject)
        sk = semaphore_slot_sort_key(int(slot))

        try:
            return self.semaphore_table.update(
                pk,
                sk,
                {
                    "lease_expires_at": expires_at,
                    "updated_at": now_str,
                    **({"ttl": ttl_unix} if ttl_unix > 0 else {}),
                },
                condition_expression="#lease_owner = :owner AND #lease_expires_at > :now",
                expression_attribute_names={"#lease_owner": "lease_owner", "#lease_expires_at": "lease_expires_at"},
                expression_attribute_values={":owner": owner, ":now": now_unix},
            )
        except Exception as exc:
            if isinstance(exc, ConditionFailedError):
                raise new_error("conflict", "semaphore slot refresh conflict") from exc
            raise wrap_error(exc, "internal_error", "failed to refresh semaphore slot") from exc

    def release_semaphore_slot(self, *, scope: str, subject: str, slot: int, owner: str) -> None:
        scope = str(scope or "").strip()
        subject = str(subject or "").strip()
        owner = str(owner or "").strip()
        if not scope:
            raise new_error("invalid_input", "scope is required")
        if not subject:
            raise new_error("invalid_input", "subject is required")
        if int(slot) < 0:
            raise new_error("invalid_input", "slot must be >= 0")
        if not owner:
            raise new_error("invalid_input", "owner is required")

        pk = semaphore_partition_key(scope, subject)
        sk = semaphore_slot_sort_key(int(slot))
        now_str = format_rfc3339_nano(self.clock.now())

        try:
            self.semaphore_table.update(
                pk,
                sk,
                {
                    "lease_owner": "",
                    "lease_expires_at": 0,
                    "updated_at": now_str,
                },
                condition_expression="#lease_owner = :owner",
                expression_attribute_names={"#lease_owner": "lease_owner"},
                expression_attribute_values={":owner": owner},
            )
            return
        except Exception as exc:
            if not isinstance(exc, ConditionFailedError):
                raise wrap_error(exc, "internal_error", "failed to release semaphore slot") from exc

        try:
            current = self.semaphore_table.get(pk, sk)
        except NotFoundError:
            return
        except Exception as exc:
            raise wrap_error(exc, "internal_error", "failed to load semaphore slot after release conflict") from exc

        if not getattr(current, "lease_owner", ""):
            return
        if str(getattr(current, "lease_owner", "") or "") != owner:
            raise new_error("conflict", "semaphore slot not owned")

    def inspect_semaphore(self, *, scope: str, subject: str) -> dict[str, Any]:
        scope = str(scope or "").strip()
        subject = str(subject or "").strip()
        if not scope:
            raise new_error("invalid_input", "scope is required")
        if not subject:
            raise new_error("invalid_input", "subject is required")

        now_unix = unix_seconds(self.clock.now())
        try:
            leases = list(self.semaphore_table.query_all(semaphore_partition_key(scope, subject)))
        except Exception as exc:
            raise wrap_error(exc, "internal_error", "failed to inspect semaphore") from exc

        active = [lease for lease in leases if int(getattr(lease, "lease_expires_at", 0) or 0) > now_unix]
        active.sort(key=lambda lease: int(getattr(lease, "slot", 0) or 0))
        return {
            "scope": scope,
            "subject": subject,
            "occupancy": len(active),
            "active_leases": active,
        }

    def create_idempotency_record(
        self,
        *,
        job_id: str,
        idempotency_key: str,
        ttl: dt.timedelta | None = None,
    ) -> tuple[JobRequest, IdempotencyCreateOutcome]:
        job_id = str(job_id or "").strip()
        idempotency_key = str(idempotency_key or "").strip()
        if not job_id:
            raise new_error("invalid_input", "job_id is required")
        if not idempotency_key:
            raise new_error("invalid_input", "idempotency_key is required")

        now = self.clock.now()
        now_str = format_rfc3339_nano(now)

        req = JobRequest(
            pk=job_partition_key(job_id),
            sk=job_request_sort_key(idempotency_key),
            job_id=job_id,
            idempotency_key=idempotency_key,
            status="IN_PROGRESS",
            created_at=now_str,
            updated_at=now_str,
            ttl=_normalize_ttl_unix_seconds(now, ttl, self.config.default_idempotency_ttl),
        )

        try:
            self.request_table.put(
                req,
                condition_expression="attribute_not_exists(#pk)",
                expression_attribute_names={"#pk": "pk"},
            )
            return req, "created"
        except Exception as exc:
            if not isinstance(exc, ConditionFailedError):
                raise wrap_error(exc, "internal_error", "failed to create idempotency record") from exc

        try:
            existing = self.request_table.get(req.pk, req.sk)
        except Exception as exc:
            raise wrap_error(exc, "internal_error", "failed to load existing idempotency record") from exc

        outcome: IdempotencyCreateOutcome = (
            "already_completed" if str(getattr(existing, "status", "")) == "COMPLETED" else "already_in_progress"
        )
        return existing, outcome

    def complete_idempotency_record(
        self,
        *,
        job_id: str,
        idempotency_key: str,
        result: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
        ttl: dt.timedelta | None = None,
    ) -> JobRequest:
        job_id = str(job_id or "").strip()
        idempotency_key = str(idempotency_key or "").strip()
        if not job_id:
            raise new_error("invalid_input", "job_id is required")
        if not idempotency_key:
            raise new_error("invalid_input", "idempotency_key is required")

        now = self.clock.now()
        now_str = format_rfc3339_nano(now)
        pk = job_partition_key(job_id)
        sk = job_request_sort_key(idempotency_key)

        ttl_unix = _normalize_ttl_unix_seconds(now, ttl, self.config.default_request_result_ttl)

        try:
            return self.request_table.update(
                pk,
                sk,
                {
                    "status": "COMPLETED",
                    "updated_at": now_str,
                    "job_id": UpdateSetIfNotExists(job_id),
                    "idempotency_key": UpdateSetIfNotExists(idempotency_key),
                    "completed_at": UpdateSetIfNotExists(now_str),
                    **({"ttl": UpdateSetIfNotExists(ttl_unix)} if ttl_unix > 0 else {}),
                    **({"result": UpdateSetIfNotExists(sanitize_fields(result))} if result else {}),
                    **({"error": UpdateSetIfNotExists(sanitize_error_envelope(error))} if error else {}),
                },
                condition_expression="attribute_exists(#pk)",
                expression_attribute_names={"#pk": "pk"},
            )
        except Exception as exc:
            if isinstance(exc, ConditionFailedError):
                raise new_error("not_found", "idempotency record not found") from exc
            raise wrap_error(exc, "internal_error", "failed to complete idempotency record") from exc
