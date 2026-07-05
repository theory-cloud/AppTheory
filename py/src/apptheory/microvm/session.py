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
from .shared import *  # noqa: F403


def validate_microvm_session_record(record: MicroVMSessionRecord) -> None:
    normalized = _normalize_session_record(record)
    if (
        not normalized.tenant_id
        or not normalized.namespace
        or not normalized.session_id
        or not normalized.state
        or not normalized.desired_state
        or not normalized.provider_id
        or not normalized.provider_state
        or not normalized.aws_lifecycle_state
        or not normalized.image_ref
        or not normalized.network_connector_ref
        or not normalized.controller_id
        or not normalized.last_action
        or not normalized.last_command_id
        or not normalized.auth_subject
    ):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session record is incomplete",
            normalized.last_command_id,
        )
    if (
        normalized.created_at <= 0
        or normalized.updated_at <= 0
        or normalized.last_observed_at <= 0
        or normalized.expires_at <= 0
        or normalized.generation <= 0
    ):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session record registry fields are incomplete",
            normalized.last_command_id,
        )
    if not _valid_microvm_command(normalized.last_action):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session record last action is unsupported",
            normalized.last_command_id,
        )
    if not _valid_lifecycle_state(normalized.state) or not _valid_lifecycle_state(normalized.desired_state):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session record state is unsupported",
            normalized.last_command_id,
        )
    provider_err = _validate_session_provider_fields(normalized)
    if provider_err:
        raise provider_err
    metadata_err = _validate_safe_metadata(normalized.metadata, normalized.last_command_id)
    if metadata_err:
        raise metadata_err
    reason_err = _validate_safe_metadata(normalized.reason_metadata, normalized.last_command_id)
    if reason_err:
        raise reason_err
    status_err = _validate_safe_metadata(normalized.status_metadata, normalized.last_command_id)
    if status_err:
        raise status_err
    reason_err = _validate_safe_metadata(normalized.reason_metadata, normalized.last_command_id)
    if reason_err:
        raise reason_err
    status_err = _validate_safe_metadata(normalized.status_metadata, normalized.last_command_id)
    if status_err:
        raise status_err


def _validate_session_provider_fields(record: MicroVMSessionRecord) -> MicroVMSafeError | None:
    fields = [
        record.endpoint,
        record.microvm_id,
        record.provider_id,
        record.provider_microvm_id,
        record.provider_state,
        record.aws_lifecycle_state,
        record.image_ref,
        record.image_version,
        record.network_connector_ref,
        *record.ingress_network_connector_refs,
        *record.egress_network_connector_refs,
    ]
    for item in fields:
        err = _validate_safe_field_value(item, record.last_command_id)
        if err:
            return err
    for token in record.token_metadata:
        try:
            validate_microvm_session_token_metadata(token, record.last_command_id)
        except MicroVMSafeError as exc:
            return exc
    return None


def validate_microvm_session_token_metadata(
    token: MicroVMSessionTokenMetadata | dict[str, Any], request_id: str = ""
) -> None:
    normalized = _normalize_session_token_metadata(token)
    if not normalized.token_id or not normalized.token_type or normalized.expires_at <= 0 or not normalized.scope:
        raise _safe_error(
            MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
            "apptheory: microvm session token metadata is incomplete",
            request_id,
        )
    for item in [normalized.token_id, normalized.token_type, *normalized.scope]:
        err = _validate_safe_field_value(item, request_id)
        if err:
            raise err


def microvm_session_token_metadata_from_provider_token(
    token: MicroVMProviderToken | dict[str, Any],
) -> MicroVMSessionTokenMetadata:
    normalized = _normalize_provider_token(token)
    validate_microvm_provider_token(normalized)
    metadata = MicroVMSessionTokenMetadata(
        token_id=normalized.token_id,
        token_type=normalized.token_type,
        expires_at=normalized.expires_at,
        scope=list(normalized.scope),
    )
    validate_microvm_session_token_metadata(metadata)
    return metadata


def validate_microvm_session_status(status: MicroVMSessionStatus) -> None:
    normalized = _normalize_session_status(status)
    if (
        not normalized.tenant_id
        or not normalized.namespace
        or not normalized.session_id
        or not normalized.state
        or not normalized.desired_state
        or not normalized.lifecycle_state
        or not normalized.last_action
        or normalized.last_transition <= 0
        or normalized.registry_version <= 0
    ):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session status is incomplete",
            "",
        )
    if (
        not _valid_lifecycle_state(normalized.state)
        or not _valid_lifecycle_state(normalized.desired_state)
        or not _valid_lifecycle_state(normalized.lifecycle_state)
    ):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session status state is unsupported",
            "",
        )
    if not _valid_microvm_command(normalized.last_action):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session status last action is unsupported",
            "",
        )


def microvm_session_key(record: MicroVMSessionRecord) -> tuple[str, str, str]:
    return (str(record.tenant_id).strip(), str(record.namespace).strip(), str(record.session_id).strip())


def microvm_session_registry_table_name() -> str:
    return (
        str(os.environ.get(MICROVM_SESSION_REGISTRY_TABLE_ENV, "") or "").strip() or MICROVM_SESSION_REGISTRY_TABLE_NAME
    )


def microvm_session_registry_partition_key(tenant_id: str, namespace: str) -> str:
    tenant = str(tenant_id or "").strip()
    ns = str(namespace or "").strip()
    if not tenant or not ns:
        return ""
    return f"TENANT#{tenant}#NAMESPACE#{ns}"


def microvm_session_registry_sort_key(session_id: str) -> str:
    session = str(session_id or "").strip()
    if not session:
        return ""
    return f"SESSION#{session}"


def microvm_session_registry_model_definition(*, table_name: str | None = None) -> Any:
    try:
        from theorydb_py import ModelDefinition  # type: ignore[import-not-found]

        return ModelDefinition.from_dataclass(
            MicroVMSessionRegistryRecord,
            table_name=str(table_name or "").strip() or None,
        )
    except Exception as exc:
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session registry requires TableTheory model support",
            "",
        ) from exc


def validate_microvm_session_registry_record(record: MicroVMSessionRegistryRecord | dict[str, Any]) -> None:
    normalized = _normalize_session_registry_record(record)
    validate_microvm_session_record(_session_record_from_registry_no_validate(normalized))
    if not normalized.pk or not normalized.sk or normalized.ttl <= 0 or normalized.version <= 0:
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session registry keys are incomplete",
            normalized.last_command_id,
        )
    if normalized.pk != microvm_session_registry_partition_key(
        normalized.tenant_id, normalized.namespace
    ) or normalized.sk != microvm_session_registry_sort_key(normalized.session_id):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session registry tenant/session key mismatch",
            normalized.last_command_id,
        )
    if normalized.ttl != int(normalized.expires_at):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session registry ttl mismatch",
            normalized.last_command_id,
        )
    metadata_err = _validate_safe_metadata(normalized.metadata, normalized.last_command_id)
    if metadata_err:
        raise metadata_err


def microvm_session_record_to_registry_record(record: MicroVMSessionRecord) -> MicroVMSessionRegistryRecord:
    normalized = _normalize_session_record(record)
    validate_microvm_session_record(normalized)
    registry = MicroVMSessionRegistryRecord(
        pk=microvm_session_registry_partition_key(normalized.tenant_id, normalized.namespace),
        sk=microvm_session_registry_sort_key(normalized.session_id),
        tenant_id=normalized.tenant_id,
        namespace=normalized.namespace,
        session_id=normalized.session_id,
        state=normalized.state,
        desired_state=normalized.desired_state,
        endpoint=normalized.endpoint,
        microvm_id=normalized.microvm_id,
        provider_id=normalized.provider_id,
        provider_microvm_id=normalized.provider_microvm_id,
        provider_state=normalized.provider_state,
        aws_lifecycle_state=normalized.aws_lifecycle_state,
        image_ref=normalized.image_ref,
        image_version=normalized.image_version,
        network_connector_ref=normalized.network_connector_ref,
        ingress_network_connector_refs=list(normalized.ingress_network_connector_refs),
        egress_network_connector_refs=list(normalized.egress_network_connector_refs),
        controller_id=normalized.controller_id,
        created_at=normalized.created_at,
        updated_at=normalized.updated_at,
        last_observed_at=normalized.last_observed_at,
        provider_started_at=normalized.provider_started_at,
        provider_terminated_at=normalized.provider_terminated_at,
        expires_at=normalized.expires_at,
        ttl=int(normalized.expires_at),
        generation=normalized.generation,
        version=normalized.generation,
        last_action=normalized.last_action,
        last_command_id=normalized.last_command_id,
        auth_subject=normalized.auth_subject,
        reason_metadata=_clone_string_map(normalized.reason_metadata),
        status_metadata=_clone_string_map(normalized.status_metadata),
        token_metadata=_clone_session_token_metadata_list(normalized.token_metadata),
        metadata=_clone_string_map(normalized.metadata),
    )
    validate_microvm_session_registry_record(registry)
    return registry


def microvm_session_from_registry_record(record: MicroVMSessionRegistryRecord | dict[str, Any]) -> MicroVMSessionRecord:
    normalized = _normalize_session_registry_record(record)
    validate_microvm_session_registry_record(normalized)
    out = _session_record_from_registry_no_validate(normalized)
    validate_microvm_session_record(out)
    return out


__all__ = [
    "_validate_session_provider_fields",
    "microvm_session_from_registry_record",
    "microvm_session_key",
    "microvm_session_record_to_registry_record",
    "microvm_session_registry_model_definition",
    "microvm_session_registry_partition_key",
    "microvm_session_registry_sort_key",
    "microvm_session_registry_table_name",
    "microvm_session_token_metadata_from_provider_token",
    "validate_microvm_session_record",
    "validate_microvm_session_registry_record",
    "validate_microvm_session_status",
    "validate_microvm_session_token_metadata",
]
