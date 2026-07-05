from __future__ import annotations

import hashlib
import json as jsonlib
import os
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Literal, cast

# ruff: noqa: F401,F405
from .foundation import *  # noqa: F403
from .model import *  # noqa: F403
from .model import _MicroVMSessionRegistryKeyInput
from .session import *  # noqa: F403
from .shared import *  # noqa: F403


class MemoryMicroVMSessionRegistry:
    def __init__(self) -> None:
        self._records: dict[tuple[str, str], MicroVMSessionRegistryRecord] = {}

    def put(self, record: MicroVMSessionRecord) -> MicroVMSessionRecord:
        registry = microvm_session_record_to_registry_record(record)
        self._records[_registry_record_key(registry)] = _clone_session_registry_record(registry)
        return microvm_session_from_registry_record(registry)

    def get(self, key: _MicroVMSessionRegistryKeyInput) -> MicroVMSessionRecord:
        normalized = _normalize_session_registry_key(key)
        record = self._records.get(_registry_key_tuple(normalized))
        if record is None:
            raise _safe_error(
                MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                "apptheory: microvm session registry record not found",
                "",
            )
        return microvm_session_from_registry_record(_clone_session_registry_record(record))

    def delete(self, key: _MicroVMSessionRegistryKeyInput) -> None:
        normalized = _normalize_session_registry_key(key)
        self._records.pop(_registry_key_tuple(normalized), None)

    def list(self, input_: MicroVMSessionListInput | dict[str, Any]) -> list[MicroVMSessionRecord]:
        normalized = _normalize_session_list_input(input_)
        out: list[MicroVMSessionRecord] = []
        for record in self._records.values():
            if record.tenant_id != normalized.tenant_id or record.namespace != normalized.namespace:
                continue
            out.append(microvm_session_from_registry_record(_clone_session_registry_record(record)))
        out.sort(key=lambda record: record.session_id)
        return out


def create_memory_microvm_session_registry() -> MemoryMicroVMSessionRegistry:
    return MemoryMicroVMSessionRegistry()


MicroVMSessionReconstructionHook = Callable[[MicroVMSessionReconstructionRequest], MicroVMSessionRecord]


def reconstruct_microvm_session_record(
    request: MicroVMSessionReconstructionRequest | dict[str, Any],
    hook: MicroVMSessionReconstructionHook | None,
) -> MicroVMSessionRecord:
    normalized = _normalize_session_reconstruction_request(request)
    _normalize_session_registry_key((normalized.tenant_id, normalized.namespace, normalized.session_id))
    if hook is None:
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm registry reconstruction requires a product hook",
            normalized.request_id,
        )
    try:
        record = hook(normalized)
    except Exception as exc:  # noqa: BLE001
        if isinstance(exc, MicroVMSafeError):
            raise _safe_error(
                MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                "apptheory: microvm registry reconstruction hook failed",
                normalized.request_id,
            ) from None
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm registry reconstruction hook failed",
            normalized.request_id,
        ) from None
    reconstructed = _normalize_session_record(record)
    if (
        reconstructed.tenant_id != normalized.tenant_id
        or reconstructed.namespace != normalized.namespace
        or reconstructed.session_id != normalized.session_id
    ):
        raise _safe_error(
            MICROVM_ERROR_TENANT_BINDING_VIOLATION,
            "apptheory: microvm registry reconstruction tenant/session mismatch",
            normalized.request_id,
        )
    validate_microvm_session_record(reconstructed)
    if normalized.now > 0 and reconstructed.expires_at <= normalized.now:
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm registry reconstruction returned stale state",
            normalized.request_id,
        )
    return reconstructed


class ReconstructingMicroVMSessionRegistry:
    def __init__(
        self,
        registry: Any,
        hook: MicroVMSessionReconstructionHook | None,
        *,
        stale_after_seconds: int = 0,
        clock: Callable[[], float] | None = None,
    ) -> None:
        if registry is None:
            raise _safe_error(
                MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                "apptheory: microvm registry reconstruction requires a session registry",
                "",
            )
        if hook is None:
            raise _safe_error(
                MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                "apptheory: microvm registry reconstruction requires a product hook",
                "",
            )
        self._registry = registry
        self._hook = hook
        self._stale_after_seconds = int(stale_after_seconds or 0) if int(stale_after_seconds or 0) > 0 else 0
        self._clock = clock or time.time

    def put(self, record: MicroVMSessionRecord) -> MicroVMSessionRecord:
        return self._registry.put(record)

    def get(self, key: _MicroVMSessionRegistryKeyInput) -> MicroVMSessionRecord:
        normalized = _normalize_session_registry_key(key)
        now = float(self._clock() or 0.0)
        existing: MicroVMSessionRecord | None = None
        try:
            record = self._registry.get(normalized)
            if not _session_record_is_stale(record, now, self._stale_after_seconds):
                return record
            existing = record
        except Exception:  # noqa: BLE001
            existing = None
        reconstructed = reconstruct_microvm_session_record(
            MicroVMSessionReconstructionRequest(
                tenant_id=normalized[0],
                namespace=normalized[1],
                session_id=normalized[2],
                now=now,
                existing=existing,
            ),
            self._hook,
        )
        return self._registry.put(reconstructed)

    def delete(self, key: _MicroVMSessionRegistryKeyInput) -> None:
        self._registry.delete(key)

    def list(self, input_: MicroVMSessionListInput | dict[str, Any]) -> list[MicroVMSessionRecord]:
        list_fn = getattr(self._registry, "list", None)
        if not callable(list_fn):
            normalized = _normalize_session_list_input(input_)
            raise _safe_error(
                MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                "apptheory: microvm registry reconstruction requires tenant-bound list support",
                normalized.request_id,
            )
        return cast(list[MicroVMSessionRecord], list_fn(input_))


def create_reconstructing_microvm_session_registry(
    registry: Any,
    hook: MicroVMSessionReconstructionHook | None,
    *,
    stale_after_seconds: int = 0,
    clock: Callable[[], float] | None = None,
) -> ReconstructingMicroVMSessionRegistry:
    return ReconstructingMicroVMSessionRegistry(
        registry,
        hook,
        stale_after_seconds=stale_after_seconds,
        clock=clock,
    )


class TableTheoryMicroVMSessionRegistry:
    def __init__(self, table: Any | None = None, *, table_name: str | None = None) -> None:
        if table is None:
            try:
                from theorydb_py import Table  # type: ignore[import-not-found]

                table = Table(
                    microvm_session_registry_model_definition(),
                    table_name=str(table_name or "").strip() or microvm_session_registry_table_name(),
                )
            except Exception as exc:
                if isinstance(exc, MicroVMSafeError):
                    raise exc
                raise _safe_error(
                    MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                    "apptheory: microvm session registry requires TableTheory table support",
                    "",
                ) from exc
        self._table = table

    def put(self, record: MicroVMSessionRecord) -> MicroVMSessionRecord:
        registry = microvm_session_record_to_registry_record(record)
        try:
            put = getattr(self._table, "put", None) or getattr(self._table, "save", None)
            if not callable(put):
                raise RuntimeError("table put unavailable")
            put(registry)
            return microvm_session_from_registry_record(registry)
        except Exception as exc:
            if isinstance(exc, MicroVMSafeError):
                raise exc
            raise _session_registry_operation_error(registry.last_command_id) from None

    def get(self, key: _MicroVMSessionRegistryKeyInput) -> MicroVMSessionRecord:
        normalized = _normalize_session_registry_key(key)
        try:
            get = getattr(self._table, "get", None)
            if not callable(get):
                raise RuntimeError("table get unavailable")
            item = get(
                microvm_session_registry_partition_key(normalized[0], normalized[1]),
                microvm_session_registry_sort_key(normalized[2]),
            )
            if item is None:
                raise _safe_error(
                    MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                    "apptheory: microvm session registry record not found",
                    "",
                )
            return microvm_session_from_registry_record(cast(MicroVMSessionRegistryRecord | dict[str, Any], item))
        except Exception as exc:
            if isinstance(exc, MicroVMSafeError):
                raise exc
            raise _session_registry_operation_error("") from None

    def delete(self, key: _MicroVMSessionRegistryKeyInput) -> None:
        normalized = _normalize_session_registry_key(key)
        try:
            delete = getattr(self._table, "delete", None)
            if not callable(delete):
                raise RuntimeError("table delete unavailable")
            delete(
                microvm_session_registry_partition_key(normalized[0], normalized[1]),
                microvm_session_registry_sort_key(normalized[2]),
            )
        except Exception as exc:
            if isinstance(exc, MicroVMSafeError):
                raise exc
            raise _session_registry_operation_error("") from None

    def list(self, input_: MicroVMSessionListInput | dict[str, Any]) -> list[MicroVMSessionRecord]:
        normalized = _normalize_session_list_input(input_)
        try:
            list_fn = getattr(self._table, "list", None) or getattr(self._table, "all", None)
            if not callable(list_fn):
                raise RuntimeError("table list unavailable")
            partition_key = microvm_session_registry_partition_key(normalized.tenant_id, normalized.namespace)
            try:
                items = list_fn(partition_key)
            except TypeError:
                items = list_fn(pk=partition_key)
            out = [
                microvm_session_from_registry_record(cast(MicroVMSessionRegistryRecord | dict[str, Any], item))
                for item in list(cast(Any, items) or [])
            ]
            out.sort(key=lambda record: record.session_id)
            return out
        except Exception as exc:
            if isinstance(exc, MicroVMSafeError):
                raise exc
            raise _session_registry_operation_error(normalized.request_id) from None


def create_tabletheory_microvm_session_registry(
    table: Any | None = None, *, table_name: str | None = None
) -> TableTheoryMicroVMSessionRegistry:
    return TableTheoryMicroVMSessionRegistry(table=table, table_name=table_name)


class MicroVMRegistryClient:
    def __init__(self, registry: Any, *, ttl_seconds: int = 3600) -> None:
        if registry is None:
            raise _safe_error(
                MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                "apptheory: microvm registry client requires a session registry",
                "",
            )
        self._registry = registry
        self._ttl_seconds = int(ttl_seconds) if int(ttl_seconds or 0) > 0 else 3600

    def create(self, input_: MicroVMCreateSessionInput) -> MicroVMSessionRecord:
        now = float(input_.now or 0) if float(input_.now or 0) > 0 else 1.0
        record = MicroVMSessionRecord(
            tenant_id=input_.tenant_id,
            namespace=input_.namespace,
            session_id=input_.session_id,
            state=STATE_REQUESTED,
            desired_state=STATE_REQUESTED,
            endpoint="",
            microvm_id="",
            provider_id=MICROVM_DEFAULT_SESSION_PROVIDER_ID,
            provider_microvm_id=input_.session_id,
            provider_state=STATE_REQUESTED,
            aws_lifecycle_state=STATE_REQUESTED,
            image_ref=input_.image_ref,
            network_connector_ref=input_.network_connector_ref,
            controller_id=input_.controller_id,
            created_at=now,
            updated_at=now,
            last_observed_at=now,
            expires_at=now + self._ttl_seconds,
            generation=1,
            last_action=COMMAND_CREATE,
            last_command_id=input_.request_id,
            auth_subject=input_.auth_subject,
            metadata=_clone_string_map(input_.session_spec.metadata),
        )
        return self._registry.put(record)

    def start(self, input_: MicroVMSessionCommandInput) -> MicroVMSessionRecord:
        return self._transition(input_, COMMAND_START, STATE_STARTING, input_.desired_state)

    def stop(self, input_: MicroVMSessionCommandInput) -> MicroVMSessionRecord:
        return self._transition(input_, COMMAND_STOP, STATE_STOPPING, input_.desired_state)

    def status(self, input_: MicroVMSessionQueryInput) -> MicroVMSessionStatus:
        record = self.session(input_)
        status = MicroVMSessionStatus(
            tenant_id=record.tenant_id,
            namespace=record.namespace,
            session_id=record.session_id,
            state=record.state,
            desired_state=record.desired_state,
            lifecycle_state=record.state,
            endpoint=record.endpoint,
            microvm_id=record.microvm_id,
            last_action=record.last_action,
            last_transition=record.updated_at,
            registry_version=record.generation,
        )
        validate_microvm_session_status(status)
        return status

    def session(self, input_: MicroVMSessionQueryInput) -> MicroVMSessionRecord:
        return self._registry.get((input_.tenant_id, input_.namespace, input_.session_id))

    def _transition(
        self, input_: MicroVMSessionCommandInput, action: str, state: str, desired_state: str
    ) -> MicroVMSessionRecord:
        record = self._registry.get((input_.tenant_id, input_.namespace, input_.session_id))
        next_record = _clone_session_record(record)
        next_record.state = state
        next_record.desired_state = desired_state
        next_record.provider_id = next_record.provider_id or MICROVM_DEFAULT_SESSION_PROVIDER_ID
        next_record.provider_microvm_id = next_record.provider_microvm_id or next_record.session_id
        next_record.provider_state = state
        next_record.aws_lifecycle_state = state
        next_record.controller_id = input_.controller_id
        next_record.auth_subject = input_.auth_subject
        next_record.last_action = action
        next_record.last_command_id = input_.request_id
        next_record.updated_at = float(input_.now or 0) if float(input_.now or 0) > 0 else next_record.updated_at
        next_record.last_observed_at = next_record.updated_at
        next_record.generation += 1
        return self._registry.put(next_record)


def create_microvm_registry_client(registry: Any, *, ttl_seconds: int = 3600) -> MicroVMRegistryClient:
    return MicroVMRegistryClient(registry, ttl_seconds=ttl_seconds)


__all__ = [
    "MemoryMicroVMSessionRegistry",
    "MicroVMRegistryClient",
    "MicroVMSessionReconstructionHook",
    "ReconstructingMicroVMSessionRegistry",
    "TableTheoryMicroVMSessionRegistry",
    "create_memory_microvm_session_registry",
    "create_microvm_registry_client",
    "create_reconstructing_microvm_session_registry",
    "create_tabletheory_microvm_session_registry",
    "reconstruct_microvm_session_record",
]
