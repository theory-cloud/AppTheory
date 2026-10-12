from __future__ import annotations

import hashlib
import json as jsonlib
import os
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field, replace
from typing import Any, Literal, cast

# ruff: noqa: F401,F405
from .foundation import *  # noqa: F403
from .model import *  # noqa: F403
from .model import _MicroVMSessionRegistryKeyInput
from .session import *  # noqa: F403
from .shared import *  # noqa: F403


def _legacy_session_registry_partition_key(tenant_id: str, namespace: str) -> str:
    """Reconstruct the pre-M1 partition key ``TENANT#<tenant>#NAMESPACE#<namespace>``.

    Both identities are trimmed and an empty identity yields ``""``, matching the pre-M1
    implementation. It exists only so a read can fall back to an item written by an earlier release;
    the write path never produces this form.
    """
    tenant = str(tenant_id or "").strip()
    ns = str(namespace or "").strip()
    if not tenant or not ns:
        return ""
    return f"TENANT#{tenant}#NAMESPACE#{ns}"


def _legacy_registry_key(tenant_id: str, namespace: str, session_id: str) -> tuple[str, str] | None:
    """Return the pre-M1 (pk, sk) key, or ``None`` when it cannot differ from the canonical key."""
    legacy_pk = _legacy_session_registry_partition_key(tenant_id, namespace)
    canonical_pk = microvm_session_registry_partition_key(tenant_id, namespace)
    if not legacy_pk or legacy_pk == canonical_pk:
        return None
    return (legacy_pk, microvm_session_registry_sort_key(session_id))


def _session_from_registry_record_for_read(
    record: MicroVMSessionRegistryRecord | dict[str, Any], *, allow_legacy_key: bool
) -> MicroVMSessionRecord:
    """Convert a durable item for a read path.

    When ``allow_legacy_key`` is set it accepts the pre-M1 partition key carried by an item written by
    an earlier release and validates the item under the canonical key; an item whose key matches
    neither derivation is still rejected.
    """
    normalized = _normalize_session_registry_record(record)
    if allow_legacy_key and normalized.pk == _legacy_session_registry_partition_key(
        normalized.tenant_id, normalized.namespace
    ):
        normalized = replace(
            normalized,
            pk=microvm_session_registry_partition_key(normalized.tenant_id, normalized.namespace),
        )
    return microvm_session_from_registry_record(normalized)


def _call_registry_list(list_fn: Any, partition_key: str) -> list[Any]:
    try:
        return list(cast(Any, list_fn(partition_key)) or [])
    except TypeError:
        return list(cast(Any, list_fn(pk=partition_key)) or [])


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
            record = self._legacy_record(normalized)
            if record is not None:
                session = _session_from_registry_record_for_read(
                    _clone_session_registry_record(record), allow_legacy_key=True
                )
                migrated = microvm_session_record_to_registry_record(session)
                # The in-memory store has no TTL, so move the legacy entry rather than copy it, which
                # keeps a later list from returning the same session twice.
                self._records[_registry_record_key(migrated)] = _clone_session_registry_record(migrated)
                legacy_key = _legacy_registry_key(normalized[0], normalized[1], normalized[2])
                if legacy_key is not None:
                    self._records.pop(legacy_key, None)
                return microvm_session_from_registry_record(migrated)
            raise _safe_error(
                MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                "apptheory: microvm session registry record not found",
                "",
            )
        return microvm_session_from_registry_record(_clone_session_registry_record(record))

    def _legacy_record(self, normalized: tuple[str, str, str]) -> MicroVMSessionRegistryRecord | None:
        legacy_key = _legacy_registry_key(normalized[0], normalized[1], normalized[2])
        if legacy_key is None:
            return None
        record = self._records.get(legacy_key)
        # A colliding pre-M1 key can address more than one identity; require the item to be exactly the
        # one that was requested before accepting it.
        if record is not None and (
            record.tenant_id != normalized[0] or record.namespace != normalized[1] or record.session_id != normalized[2]
        ):
            raise _safe_error(
                MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                "apptheory: microvm session registry tenant/session key mismatch",
                "",
            )
        return record

    def delete(self, key: _MicroVMSessionRegistryKeyInput) -> None:
        normalized = _normalize_session_registry_key(key)
        self._records.pop(_registry_key_tuple(normalized), None)
        # Also drop the pre-M1 entry so a deleted session cannot be resurrected by the dual-read fallback.
        legacy_key = _legacy_registry_key(normalized[0], normalized[1], normalized[2])
        if legacy_key is not None:
            self._records.pop(legacy_key, None)

    def list(self, input_: MicroVMSessionListInput | dict[str, Any]) -> list[MicroVMSessionRecord]:
        normalized = _normalize_session_list_input(input_)
        canonical_pk = microvm_session_registry_partition_key(normalized.tenant_id, normalized.namespace)
        out: list[MicroVMSessionRecord] = []
        seen: set[str] = set()
        for record in self._records.values():
            if (
                record.tenant_id != normalized.tenant_id
                or record.namespace != normalized.namespace
                or record.pk != canonical_pk
            ):
                continue
            session = microvm_session_from_registry_record(_clone_session_registry_record(record))
            seen.add(session.session_id)
            out.append(session)
        for record in self._records.values():
            if (
                record.tenant_id != normalized.tenant_id
                or record.namespace != normalized.namespace
                or record.pk == canonical_pk
                or record.session_id in seen
            ):
                continue
            session = _session_from_registry_record_for_read(
                _clone_session_registry_record(record), allow_legacy_key=True
            )
            seen.add(session.session_id)
            out.append(session)
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
                from tabletheory_py import Table  # type: ignore[import-not-found]

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
        canonical_pk = microvm_session_registry_partition_key(normalized[0], normalized[1])
        sort_key = microvm_session_registry_sort_key(normalized[2])
        try:
            get = getattr(self._table, "get", None)
            if not callable(get):
                raise RuntimeError("table get unavailable")
            try:
                item = get(canonical_pk, sort_key)
            except Exception:  # noqa: BLE001 - a failed canonical read is treated as a candidate miss.
                item = None
            if item is not None:
                return microvm_session_from_registry_record(cast(MicroVMSessionRegistryRecord | dict[str, Any], item))
            legacy_key = _legacy_registry_key(normalized[0], normalized[1], normalized[2])
            if legacy_key is None:
                raise _safe_error(
                    MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                    "apptheory: microvm session registry record not found",
                    "",
                )
            legacy_item = get(legacy_key[0], legacy_key[1])
            if legacy_item is None:
                raise _safe_error(
                    MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                    "apptheory: microvm session registry record not found",
                    "",
                )
            legacy_record = _normalize_session_registry_record(
                cast(MicroVMSessionRegistryRecord | dict[str, Any], legacy_item)
            )
            # A colliding pre-M1 key can address more than one identity; require the item to be exactly
            # the one that was requested before accepting it.
            if (
                legacy_record.tenant_id != normalized[0]
                or legacy_record.namespace != normalized[1]
                or legacy_record.session_id != normalized[2]
            ):
                raise _safe_error(
                    MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                    "apptheory: microvm session registry tenant/session key mismatch",
                    "",
                )
            session = _session_from_registry_record_for_read(
                cast(MicroVMSessionRegistryRecord | dict[str, Any], legacy_item), allow_legacy_key=True
            )
            try:
                # Lazy re-write: migrate the item on touch. Best-effort, because the read already succeeded.
                put = getattr(self._table, "put", None) or getattr(self._table, "save", None)
                if callable(put):
                    put(microvm_session_record_to_registry_record(session))
            except Exception:  # noqa: BLE001,S110 - best-effort; the legacy item resolves until its TTL retires it.
                pass
            return session
        except Exception as exc:
            if isinstance(exc, MicroVMSafeError):
                raise exc
            raise _session_registry_operation_error("") from None

    def delete(self, key: _MicroVMSessionRegistryKeyInput) -> None:
        normalized = _normalize_session_registry_key(key)
        canonical_pk = microvm_session_registry_partition_key(normalized[0], normalized[1])
        sort_key = microvm_session_registry_sort_key(normalized[2])
        try:
            delete = getattr(self._table, "delete", None)
            if not callable(delete):
                raise RuntimeError("table delete unavailable")
            delete(canonical_pk, sort_key)
            # Also drop the pre-M1 item so a deleted session cannot be resurrected by the dual-read fallback.
            legacy_key = _legacy_registry_key(normalized[0], normalized[1], normalized[2])
            if legacy_key is not None:
                delete(legacy_key[0], legacy_key[1])
        except Exception as exc:
            if isinstance(exc, MicroVMSafeError):
                raise exc
            raise _session_registry_operation_error("") from None

    def list(self, input_: MicroVMSessionListInput | dict[str, Any]) -> list[MicroVMSessionRecord]:
        normalized = _normalize_session_list_input(input_)
        canonical_pk = microvm_session_registry_partition_key(normalized.tenant_id, normalized.namespace)
        try:
            list_fn = getattr(self._table, "list", None) or getattr(self._table, "all", None)
            if not callable(list_fn):
                raise RuntimeError("table list unavailable")
            out: list[MicroVMSessionRecord] = []
            seen: set[str] = set()
            for item in _call_registry_list(list_fn, canonical_pk):
                session = microvm_session_from_registry_record(
                    cast(MicroVMSessionRegistryRecord | dict[str, Any], item)
                )
                seen.add(session.session_id)
                out.append(session)
            # Union in the pre-M1 partition so un-migrated items stay listable; the canonical item wins.
            legacy_pk = _legacy_session_registry_partition_key(normalized.tenant_id, normalized.namespace)
            if legacy_pk and legacy_pk != canonical_pk:
                for item in _call_registry_list(list_fn, legacy_pk):
                    record = _normalize_session_registry_record(item)
                    if (
                        record.tenant_id != normalized.tenant_id
                        or record.namespace != normalized.namespace
                        or record.session_id in seen
                    ):
                        continue
                    session = _session_from_registry_record_for_read(item, allow_legacy_key=True)
                    seen.add(session.session_id)
                    out.append(session)
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
