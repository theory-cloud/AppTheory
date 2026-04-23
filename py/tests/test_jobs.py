from __future__ import annotations

import datetime as dt
import os
import sys
import unittest
from copy import deepcopy
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.clock import ManualClock  # noqa: E402
from apptheory.jobs import (  # noqa: E402
    DynamoJobLedger,
    JobLedgerError,
    JobLock,
    JobMeta,
    JobRecord,
    JobRequest,
    SemaphoreLease,
    DEFAULT_JOBS_TABLE_NAME,
    EnvJobsTableName,
    jobs_table_name,
    sanitize_error_envelope,
    sanitize_fields,
)
from theorydb_py import ConditionFailedError, NotFoundError, UpdateAdd, UpdateSetIfNotExists  # noqa: E402


class FakeTable:
    def __init__(self, model_cls: type, store: dict[tuple[str, str], object]) -> None:
        self.model_cls = model_cls
        self.store = store

    def get(self, pk: str, sk: str, *, consistent_read: bool = False) -> object:
        _ = consistent_read
        item = self.store.get((pk, sk))
        if item is None:
            raise NotFoundError("item not found")
        return deepcopy(item)

    def put(
        self,
        item: object,
        *,
        condition_expression: str | None = None,
        expression_attribute_names: dict[str, str] | None = None,
        expression_attribute_values: dict[str, object] | None = None,
    ) -> None:
        _ = expression_attribute_names, expression_attribute_values
        pk = str(getattr(item, "pk", "") or "")
        sk = str(getattr(item, "sk", "") or "")
        key = (pk, sk)
        if condition_expression and "attribute_not_exists" in condition_expression and key in self.store:
            raise ConditionFailedError("exists")
        self.store[key] = deepcopy(item)

    def update(
        self,
        pk: str,
        sk: str,
        updates: dict[str, object],
        *,
        condition_expression: str | None = None,
        expression_attribute_names: dict[str, str] | None = None,
        expression_attribute_values: dict[str, object] | None = None,
    ) -> object:
        key = (str(pk), str(sk))
        exists = key in self.store
        current = deepcopy(self.store.get(key) or self.model_cls(pk=key[0], sk=key[1]))

        if condition_expression:
            names = dict(expression_attribute_names or {})
            values = dict(expression_attribute_values or {})
            if not self._check_condition(condition_expression, exists, current, names, values):
                raise ConditionFailedError("condition failed")

        for field, value in dict(updates).items():
            if isinstance(value, UpdateAdd):
                cur = int(getattr(current, field) or 0)
                setattr(current, field, cur + int(value.value or 0))
                continue
            if isinstance(value, UpdateSetIfNotExists):
                cur = getattr(current, field)
                if not cur:
                    setattr(current, field, value.default_value)
                continue
            setattr(current, field, value)

        self.store[key] = deepcopy(current)
        return deepcopy(current)

    def query_all(
        self,
        partition: str,
        *,
        sort: object | None = None,
        index_name: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
        scan_forward: bool = True,
        consistent_read: bool = False,
        projection: list[str] | None = None,
        filter: object | None = None,
    ) -> list[object]:
        _ = sort, index_name, limit, cursor, consistent_read, projection, filter
        items = [deepcopy(item) for (pk, _sk), item in self.store.items() if pk == partition]
        items.sort(key=lambda item: str(getattr(item, "sk", "") or ""), reverse=not scan_forward)
        return items

    def _check_condition(
        self,
        expr: str,
        exists: bool,
        item: object,
        names: dict[str, str],
        values: dict[str, object],
    ) -> bool:
        if "attribute_exists" in expr and not exists:
            return False

        if "attribute_not_exists" in expr and exists and "#lease_expires_at" not in expr:
            return False

        if "#version" in expr:
            expected = int(values.get(":expected") or 0)
            if int(getattr(item, names.get("#version", "version")) or 0) != expected:
                return False
            if ":from" in values:
                from_status = str(values.get(":from") or "")
                if str(getattr(item, names.get("#status", "status")) or "") != from_status:
                    return False

        if "#lease_expires_at" in expr and "OR" in expr:
            if not exists:
                return True
            now = int(values.get(":now") or 0)
            owner = str(values.get(":owner") or "")
            expires_at = int(getattr(item, names.get("#lease_expires_at", "lease_expires_at")) or 0)
            lease_owner = str(getattr(item, names.get("#lease_owner", "lease_owner")) or "")
            return expires_at < now or lease_owner == owner

        if "#lease_owner" in expr and "#lease_expires_at" in expr and ">" in expr:
            if not exists:
                return False
            now = int(values.get(":now") or 0)
            owner = str(values.get(":owner") or "")
            expires_at = int(getattr(item, names.get("#lease_expires_at", "lease_expires_at")) or 0)
            lease_owner = str(getattr(item, names.get("#lease_owner", "lease_owner")) or "")
            return lease_owner == owner and expires_at > now

        if "#lease_owner" in expr and "#lease_expires_at" not in expr and "=" in expr and ":owner" in values:
            if not exists:
                return False
            owner = str(values.get(":owner") or "")
            lease_owner = str(getattr(item, names.get("#lease_owner", "lease_owner")) or "")
            return lease_owner == owner

        return True


class TestJobs(unittest.TestCase):
    def test_jobs_helpers(self) -> None:
        self.assertIsNone(sanitize_fields(None))
        self.assertIsNone(sanitize_fields({}))
        self.assertEqual(sanitize_fields({"": "skip", "pan": "4111111111111111"}), {"pan": "411111******1111"})

        self.assertIsNone(sanitize_error_envelope(None))
        self.assertEqual(sanitize_error_envelope({"message": "\n"}), {"message": "unknown error"})
        self.assertEqual(
            sanitize_error_envelope(
                {
                    "message": "bad\nnews",
                    "type": "t1\n",
                    "code": "c1\n",
                    "retryable": True,
                    "fields": {"password": "secret"},
                }
            ),
            {
                "message": "badnews",
                "type": "t1",
                "code": "c1",
                "retryable": True,
                "fields": {"password": "[REDACTED]"},
            },
        )

        with mock.patch.dict(os.environ, {EnvJobsTableName: " custom "}, clear=False):
            self.assertEqual(jobs_table_name(), "custom")
        with mock.patch.dict(os.environ, {EnvJobsTableName: "   "}, clear=False):
            self.assertEqual(jobs_table_name(), DEFAULT_JOBS_TABLE_NAME)

    def test_jobs_ledger_end_to_end(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 30, tzinfo=dt.UTC)
        clock = ManualClock(now)

        store: dict[tuple[str, str], object] = {}
        ledger = DynamoJobLedger(
            meta_table=FakeTable(JobMeta, store),
            record_table=FakeTable(JobRecord, store),
            lock_table=FakeTable(JobLock, store),
            semaphore_table=FakeTable(SemaphoreLease, store),
            request_table=FakeTable(JobRequest, store),
            clock=clock,
        )

        meta = ledger.create_job(job_id="j1", tenant_id="t1")
        self.assertEqual(meta.pk, "JOB#j1")
        self.assertEqual(meta.sk, "META")
        self.assertEqual(meta.status, "PENDING")
        self.assertEqual(int(meta.version), 1)

        running = ledger.transition_job_status(job_id="j1", expected_version=1, to_status="RUNNING", from_status="PENDING")
        self.assertEqual(running.status, "RUNNING")
        self.assertEqual(int(running.version), 2)

        with self.assertRaises(JobLedgerError):
            ledger.transition_job_status(job_id="j1", expected_version=1, to_status="SUCCEEDED")

        record = ledger.upsert_record_status(
            job_id="j1",
            record_id="r1",
            status="FAILED",
            error={"message": "bad\nnews", "fields": {"pan": "4111111111111111"}},
        )
        self.assertIsNotNone(record.error)
        self.assertEqual(str(record.error.get("message")), "badnews")
        self.assertEqual(str(record.error.get("fields", {}).get("pan")), "411111******1111")

        cleared = ledger.upsert_record_status(job_id="j1", record_id="r1", status="PROCESSING")
        self.assertTrue(cleared.error is None or cleared.error == {})

        lease = ledger.acquire_lease(job_id="j1", owner="w1", lease_duration=dt.timedelta(minutes=2))
        self.assertEqual(lease.lease_owner, "w1")

        with self.assertRaises(JobLedgerError):
            ledger.acquire_lease(job_id="j1", owner="w2", lease_duration=dt.timedelta(minutes=2))

        refreshed = ledger.refresh_lease(job_id="j1", owner="w1", lease_duration=dt.timedelta(minutes=2))
        self.assertEqual(refreshed.lease_owner, "w1")

        ledger.release_lease(job_id="j1", owner="w1")
        ledger.release_lease(job_id="j1", owner="w1")  # idempotent

        sem1 = ledger.acquire_semaphore_slot(
            scope="email",
            subject="customer_1",
            limit=2,
            owner="w1",
            lease_duration=dt.timedelta(minutes=2),
        )
        sem2 = ledger.acquire_semaphore_slot(
            scope="email",
            subject="customer_1",
            limit=2,
            owner="w2",
            lease_duration=dt.timedelta(minutes=2),
        )
        self.assertEqual({sem1.slot, sem2.slot}, {0, 1})

        with self.assertRaises(JobLedgerError):
            ledger.acquire_semaphore_slot(
                scope="email",
                subject="customer_1",
                limit=2,
                owner="w3",
                lease_duration=dt.timedelta(minutes=2),
            )

        refreshed_sem = ledger.refresh_semaphore_slot(
            scope="email",
            subject="customer_1",
            slot=sem1.slot,
            owner="w1",
            lease_duration=dt.timedelta(minutes=2),
        )
        self.assertEqual(refreshed_sem.lease_owner, "w1")

        inspection = ledger.inspect_semaphore(scope="email", subject="customer_1")
        self.assertEqual(int(inspection["occupancy"]), 2)
        self.assertEqual([lease.slot for lease in inspection["active_leases"]], [0, 1])

        ledger.release_semaphore_slot(scope="email", subject="customer_1", slot=sem1.slot, owner="w1")
        with self.assertRaises(JobLedgerError):
            ledger.release_semaphore_slot(scope="email", subject="customer_1", slot=sem2.slot, owner="w1")

        req1, out1 = ledger.create_idempotency_record(job_id="j1", idempotency_key="k1")
        self.assertEqual(out1, "created")
        self.assertEqual(req1.status, "IN_PROGRESS")

        req2, out2 = ledger.create_idempotency_record(job_id="j1", idempotency_key="k1")
        self.assertEqual(out2, "already_in_progress")
        self.assertEqual(req2.pk, req1.pk)
        self.assertEqual(req2.sk, req1.sk)

        completed = ledger.complete_idempotency_record(
            job_id="j1",
            idempotency_key="k1",
            result={"pan": "4111111111111111"},
        )
        self.assertEqual(completed.status, "COMPLETED")
        self.assertEqual(str((completed.result or {}).get("pan")), "411111******1111")

        req3, out3 = ledger.create_idempotency_record(job_id="j1", idempotency_key="k1")
        self.assertEqual(out3, "already_completed")
        self.assertEqual(req3.status, "COMPLETED")

        with self.assertRaises(JobLedgerError):
            ledger.complete_idempotency_record(job_id="j1", idempotency_key="missing")

    def test_jobs_ledger_conflicts_and_invalid_input(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 30, tzinfo=dt.UTC)
        clock = ManualClock(now)

        store: dict[tuple[str, str], object] = {}
        ledger = DynamoJobLedger(
            meta_table=FakeTable(JobMeta, store),
            record_table=FakeTable(JobRecord, store),
            lock_table=FakeTable(JobLock, store),
            semaphore_table=FakeTable(SemaphoreLease, store),
            request_table=FakeTable(JobRequest, store),
            clock=clock,
        )

        with self.assertRaises(JobLedgerError) as ctx:
            ledger.create_job(job_id="", tenant_id="t1")
        self.assertEqual(ctx.exception.type, "invalid_input")

        ledger.create_job(job_id="j1", tenant_id="t1")

        with self.assertRaises(JobLedgerError) as ctx:
            ledger.create_job(job_id="j1", tenant_id="t1")
        self.assertEqual(ctx.exception.type, "conflict")

        ledger.acquire_lease(job_id="j1", owner="w1", lease_duration=dt.timedelta(minutes=2))
        with self.assertRaises(JobLedgerError) as ctx:
            ledger.release_lease(job_id="j1", owner="w2")
        self.assertEqual(ctx.exception.type, "conflict")

    def test_jobs_ledger_validation_errors(self) -> None:
        now = dt.datetime(2026, 1, 1, 0, 0, 30, tzinfo=dt.UTC)
        clock = ManualClock(now)

        store: dict[tuple[str, str], object] = {}
        ledger = DynamoJobLedger(
            meta_table=FakeTable(JobMeta, store),
            record_table=FakeTable(JobRecord, store),
            lock_table=FakeTable(JobLock, store),
            semaphore_table=FakeTable(SemaphoreLease, store),
            request_table=FakeTable(JobRequest, store),
            clock=clock,
        )

        with self.assertRaises(JobLedgerError) as ctx:
            ledger.transition_job_status(job_id="", expected_version=1, to_status="RUNNING")
        self.assertEqual(ctx.exception.type, "invalid_input")

        with self.assertRaises(JobLedgerError) as ctx:
            ledger.transition_job_status(job_id="j1", expected_version=0, to_status="RUNNING")
        self.assertEqual(ctx.exception.type, "invalid_input")

        with self.assertRaises(JobLedgerError) as ctx:
            ledger.upsert_record_status(job_id="j1", record_id="", status="PROCESSING")
        self.assertEqual(ctx.exception.type, "invalid_input")

        with self.assertRaises(JobLedgerError) as ctx:
            ledger.acquire_lease(job_id="j1", owner="", lease_duration=dt.timedelta(minutes=2))
        self.assertEqual(ctx.exception.type, "invalid_input")

        with self.assertRaises(JobLedgerError) as ctx:
            ledger.acquire_lease(job_id="j1", owner="w1", lease_duration=dt.timedelta(0))
        self.assertEqual(ctx.exception.type, "invalid_input")

        with self.assertRaises(JobLedgerError) as ctx:
            ledger.acquire_semaphore_slot(
                scope="",
                subject="customer_1",
                limit=1,
                owner="w1",
                lease_duration=dt.timedelta(minutes=2),
            )
        self.assertEqual(ctx.exception.type, "invalid_input")

        with self.assertRaises(JobLedgerError) as ctx:
            ledger.acquire_semaphore_slot(
                scope="email",
                subject="customer_1",
                limit=10_000,
                owner="w1",
                lease_duration=dt.timedelta(minutes=2),
            )
        self.assertEqual(ctx.exception.type, "invalid_input")
        self.assertEqual(ctx.exception.message, "limit must be <= 256")

        with self.assertRaises(JobLedgerError) as ctx:
            ledger.refresh_semaphore_slot(
                scope="email",
                subject="customer_1",
                slot=-1,
                owner="w1",
                lease_duration=dt.timedelta(minutes=2),
            )
        self.assertEqual(ctx.exception.type, "invalid_input")

        with self.assertRaises(JobLedgerError) as ctx:
            ledger.create_idempotency_record(job_id="j1", idempotency_key="")
        self.assertEqual(ctx.exception.type, "invalid_input")

        with self.assertRaises(JobLedgerError) as ctx:
            ledger.complete_idempotency_record(job_id="j1", idempotency_key="")
        self.assertEqual(ctx.exception.type, "invalid_input")

        ledger.release_lease(job_id="j1", owner="w1")
