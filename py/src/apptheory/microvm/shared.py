from __future__ import annotations

import hashlib
import json as jsonlib
import os
import time
import urllib.parse
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Literal, cast

# ruff: noqa: F401,F405
from .foundation import *  # noqa: F403
from .model import *  # noqa: F403
from .model import _MicroVMSessionRegistryKeyInput

_DEFAULT_PROVIDER_TOKEN_TTL_SECONDS = 900
_MIN_PROVIDER_TOKEN_TTL_SECONDS = 1
_MAX_PROVIDER_TOKEN_TTL_SECONDS = 900
_DEFAULT_PROVIDER_INVOKE_PORT = 8080
_DEFAULT_PROVIDER_INVOKE_TOKEN_TTL_SECONDS = 60
_MAX_PROVIDER_INVOKE_BODY_BYTES = 6 * 1024 * 1024
_PROVIDER_INVOKE_METHODS = {"DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"}
_PROVIDER_INVOKE_FORBIDDEN_HEADERS = {
    "authorization",
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "x-amz-security-token",
    "x-apptheory-microvm-port",
    "x-apptheory-microvm-token-ttl",
    "x-aws-proxy-auth",
    "x-aws-proxy-port",
    "x-namespace-id",
    "x-tenant-id",
}


def microvm_session_key(record: MicroVMSessionRecord) -> tuple[str, str, str]:
    return (str(record.tenant_id).strip(), str(record.namespace).strip(), str(record.session_id).strip())


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


def validate_microvm_provider_session(session: MicroVMProviderSession | dict[str, Any]) -> None:
    normalized = _normalize_provider_session(session)
    if (
        not normalized.tenant_id
        or not normalized.namespace
        or not normalized.session_id
        or not normalized.provider_microvm_id
    ):
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm provider session is incomplete",
            "",
        )
    state, terminal = map_microvm_provider_state(normalized.provider_state)
    if normalized.state != state or normalized.terminal != terminal:
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
            "apptheory: microvm provider session state mapping mismatch",
            "",
        )
    if (
        _forbidden_field_name(normalized.provider_microvm_id)
        or _forbidden_field_name(normalized.endpoint)
        or _forbidden_field_name(normalized.image_ref)
        or _forbidden_field_name(normalized.image_version)
    ):
        raise _safe_error(
            MICROVM_ERROR_FORBIDDEN_FIELD,
            "apptheory: microvm provider session exposes forbidden field",
            "",
        )


def validate_microvm_provider_run_input(input_: MicroVMProviderRunInput | dict[str, Any]) -> None:
    _validate_provider_run_input(input_)


def validate_microvm_provider_session_input(
    operation: str, input_: MicroVMProviderSessionInput | dict[str, Any]
) -> None:
    _validate_provider_session_input(operation, input_)


def validate_microvm_provider_list_input(input_: MicroVMProviderListInput | dict[str, Any]) -> None:
    _validate_provider_list_input(input_)


def validate_microvm_provider_token_input(operation: str, input_: MicroVMProviderTokenInput | dict[str, Any]) -> None:
    _validate_provider_token_input(operation, input_)


def validate_microvm_provider_invoke_input(input_: MicroVMProviderInvokeInput | dict[str, Any]) -> None:
    _validate_provider_invoke_input(input_)


def validate_microvm_provider_token(token: MicroVMProviderToken | dict[str, Any]) -> None:
    normalized = _normalize_provider_token(token)
    if (
        not normalized.tenant_id
        or not normalized.namespace
        or not normalized.session_id
        or not normalized.provider_microvm_id
        or not normalized.token_id
        or not normalized.token_type
        or normalized.expires_at <= 0
        or not normalized.scope
    ):
        raise _safe_error(
            MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
            "apptheory: microvm provider token metadata is incomplete",
            "",
        )
    for field_value in [
        normalized.provider_microvm_id,
        normalized.token_id,
        normalized.token_type,
        *normalized.scope,
    ]:
        if _forbidden_field_name(field_value):
            raise _safe_error(
                MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
                "apptheory: microvm provider token metadata exposes forbidden field",
                "",
            )


def _coerce_controller_contract(value: MicroVMControllerContract | dict[str, Any]) -> MicroVMControllerContract:
    if isinstance(value, MicroVMControllerContract):
        return MicroVMControllerContract(
            auth=MicroVMControllerAuthContract(value.auth.required, value.auth.default),
            envelope=MicroVMControllerEnvelopeContract(
                list(value.envelope.required_fields),
                list(value.envelope.safe_error_fields),
                list(value.envelope.forbidden_fields),
            ),
            commands=[
                MicroVMControllerCommandContract(
                    c.name, c.method, c.path, list(c.request_fields), list(c.response_fields)
                )
                for c in value.commands
            ],
        )
    raw = cast(dict[str, Any], value) if isinstance(value, dict) else {}
    auth = cast(dict[str, Any], raw.get("auth")) if isinstance(raw.get("auth"), dict) else {}
    envelope = cast(dict[str, Any], raw.get("envelope")) if isinstance(raw.get("envelope"), dict) else {}
    commands = cast(list[Any], raw.get("commands")) if isinstance(raw.get("commands"), list) else []
    return MicroVMControllerContract(
        auth=MicroVMControllerAuthContract(
            required=auth.get("required") is True,
            default=str(auth.get("default", "")),
        ),
        envelope=MicroVMControllerEnvelopeContract(
            required_fields=[str(v) for v in envelope.get("required_fields") or []],
            safe_error_fields=[str(v) for v in envelope.get("safe_error_fields") or []],
            forbidden_fields=[str(v) for v in envelope.get("forbidden_fields") or []],
        ),
        commands=[_coerce_controller_command(command) for command in commands],
    )


def _coerce_controller_command(value: Any) -> MicroVMControllerCommandContract:
    raw = value if isinstance(value, dict) else {}
    return MicroVMControllerCommandContract(
        name=str(raw.get("name", "")).strip(),
        method=str(raw.get("method", "")).strip(),
        path=str(raw.get("path", "")).strip(),
        request_fields=[str(v) for v in raw.get("request_fields") or []],
        response_fields=[str(v) for v in raw.get("response_fields") or []],
    )


def _coerce_session_registry_contract(
    value: MicroVMSessionRegistryContract | dict[str, Any],
) -> MicroVMSessionRegistryContract:
    if isinstance(value, MicroVMSessionRegistryContract):
        return MicroVMSessionRegistryContract(
            value.pattern,
            list(value.tenant_binding),
            list(value.required_fields),
            list(value.state_values),
            list(value.forbidden_fields),
        )
    raw = value if isinstance(value, dict) else {}
    return MicroVMSessionRegistryContract(
        pattern=str(raw.get("pattern", "")),
        tenant_binding=[str(v) for v in raw.get("tenant_binding") or []],
        required_fields=[str(v) for v in raw.get("required_fields") or []],
        state_values=[str(v) for v in raw.get("state_values") or []],
        forbidden_fields=[str(v) for v in raw.get("forbidden_fields") or []],
    )


def _controller_auth_defaults_deny(auth: MicroVMControllerAuthContract) -> bool:
    return auth.required and str(auth.default or "").strip().lower() == MICROVM_CONTROLLER_AUTH_DEFAULT_DENY


def _required_controller_commands() -> list[str]:
    return [COMMAND_CREATE, COMMAND_START, COMMAND_STOP, COMMAND_STATUS, COMMAND_SESSION]


def _real_controller_commands() -> list[str]:
    return [
        COMMAND_RUN,
        COMMAND_GET,
        COMMAND_LIST,
        COMMAND_SUSPEND,
        COMMAND_RESUME,
        COMMAND_TERMINATE,
        COMMAND_INVOKE,
        COMMAND_AUTH_TOKEN,
        COMMAND_SHELL_AUTH_TOKEN,
    ]


def _normalize_command(command: str) -> str:
    normalized = str(command or "").strip()
    if normalized == COMMAND_LEGACY_SHELL_TOKEN:
        return COMMAND_SHELL_AUTH_TOKEN
    return normalized


def _valid_microvm_command(command: str) -> bool:
    normalized = _normalize_command(command)
    return normalized in {*_required_controller_commands(), *_real_controller_commands()}


def _required_session_registry_contract_fields() -> list[str]:
    # Keep the original M15 vocabulary fixture compatible; durable TableTheory keys/TTL
    # are enforced by registry-record validation and runner coverage.
    return [
        "tenant_id",
        "namespace",
        "session_id",
        "state",
        "desired_state",
        "image_ref",
        "controller_id",
        "created_at",
        "updated_at",
        "expires_at",
        "generation",
        "last_command_id",
        "auth_subject",
    ]


def _valid_lifecycle_state(state: str) -> bool:
    normalized = str(state or "").strip()
    return normalized in {*_required_lifecycle_states(), *_required_real_lifecycle_states()}


def _normalize_controller_request(request: MicroVMControllerRequest | dict[str, Any]) -> MicroVMControllerRequest:
    if isinstance(request, MicroVMControllerRequest):
        return MicroVMControllerRequest(
            command=_normalize_command(request.command),
            request_id=str(request.request_id or "").strip(),
            tenant_id=str(request.tenant_id or "").strip(),
            namespace=str(request.namespace or "").strip(),
            auth_context=_normalize_auth_context(request.auth_context),
            session_id=str(request.session_id or "").strip(),
            image_ref=str(request.image_ref or "").strip(),
            image_version=str(request.image_version or "").strip(),
            network_connector_ref=str(request.network_connector_ref or "").strip(),
            ingress_network_connector_refs=_normalize_string_list(request.ingress_network_connector_refs),
            egress_network_connector_refs=_normalize_string_list(request.egress_network_connector_refs),
            session_spec=_clone_session_spec(request.session_spec),
            idle_policy=_normalize_provider_idle_policy(request.idle_policy),
            maximum_duration_seconds=int(request.maximum_duration_seconds or 0),
            ttl_seconds=int(request.ttl_seconds or 0),
            allowed_port_scope=[
                _normalize_provider_port_scope(scope) for scope in list(request.allowed_port_scope or [])
            ],
            max_results=int(request.max_results or 0),
        )
    raw = request if isinstance(request, dict) else {}
    return MicroVMControllerRequest(
        command=_normalize_command(str(raw.get("command", ""))),
        request_id=str(raw.get("request_id", "") or "").strip(),
        tenant_id=str(raw.get("tenant_id", "") or "").strip(),
        namespace=str(raw.get("namespace", "") or "").strip(),
        auth_context=_normalize_auth_context(raw.get("auth_context") or {}),
        session_id=str(raw.get("session_id", "") or "").strip(),
        image_ref=str(raw.get("image_ref", "") or "").strip(),
        image_version=str(raw.get("image_version", "") or "").strip(),
        network_connector_ref=str(raw.get("network_connector_ref", "") or "").strip(),
        ingress_network_connector_refs=_normalize_string_list(raw.get("ingress_network_connector_refs") or []),
        egress_network_connector_refs=_normalize_string_list(raw.get("egress_network_connector_refs") or []),
        session_spec=_clone_session_spec(raw.get("session_spec") or {}),
        idle_policy=_normalize_provider_idle_policy(raw.get("idle_policy")),
        maximum_duration_seconds=int(raw.get("maximum_duration_seconds", 0) or 0),
        ttl_seconds=int(raw.get("ttl_seconds", 0) or 0),
        allowed_port_scope=[
            _normalize_provider_port_scope(scope) for scope in list(raw.get("allowed_port_scope") or [])
        ],
        max_results=int(raw.get("max_results", 0) or 0),
    )


def _normalize_auth_context(value: MicroVMAuthContext | dict[str, Any]) -> MicroVMAuthContext:
    if isinstance(value, MicroVMAuthContext):
        return MicroVMAuthContext(
            subject=str(value.subject or "").strip(),
            tenant_id=str(value.tenant_id or "").strip(),
            namespace=str(value.namespace or "").strip(),
            entitlements=[str(v) for v in value.entitlements],
            metadata=_clone_string_map(value.metadata),
        )
    raw = cast(dict[str, Any], value) if isinstance(value, dict) else {}
    entitlements = cast(list[Any], raw.get("entitlements")) if isinstance(raw.get("entitlements"), list) else []
    return MicroVMAuthContext(
        subject=str(raw.get("subject", "") or "").strip(),
        tenant_id=str(raw.get("tenant_id", "") or "").strip(),
        namespace=str(raw.get("namespace", "") or "").strip(),
        entitlements=[str(v) for v in entitlements],
        metadata=_clone_string_map(raw.get("metadata") if isinstance(raw.get("metadata"), dict) else None),
    )


def _clone_session_spec(value: MicroVMSessionSpec | dict[str, Any]) -> MicroVMSessionSpec:
    if isinstance(value, MicroVMSessionSpec):
        return MicroVMSessionSpec(metadata=_clone_string_map(value.metadata))
    raw = value if isinstance(value, dict) else {}
    return MicroVMSessionSpec(
        metadata=_clone_string_map(raw.get("metadata") if isinstance(raw.get("metadata"), dict) else None)
    )


def _normalize_session_record(record: MicroVMSessionRecord) -> MicroVMSessionRecord:
    return MicroVMSessionRecord(
        tenant_id=str(record.tenant_id or "").strip(),
        namespace=str(record.namespace or "").strip(),
        session_id=str(record.session_id or "").strip(),
        state=_normalize_state(record.state),
        desired_state=_normalize_state(record.desired_state),
        image_ref=str(record.image_ref or "").strip(),
        image_version=str(record.image_version or "").strip(),
        network_connector_ref=str(record.network_connector_ref or "").strip(),
        controller_id=str(record.controller_id or "").strip(),
        created_at=float(record.created_at or 0),
        updated_at=float(record.updated_at or 0),
        last_observed_at=float(record.last_observed_at or 0),
        provider_started_at=float(record.provider_started_at or 0),
        provider_terminated_at=float(record.provider_terminated_at or 0),
        expires_at=float(record.expires_at or 0),
        generation=int(record.generation or 0),
        endpoint=str(record.endpoint or "").strip(),
        microvm_id=str(record.microvm_id or "").strip(),
        provider_id=str(record.provider_id or "").strip(),
        provider_microvm_id=str(record.provider_microvm_id or "").strip(),
        provider_state=str(record.provider_state or "").strip(),
        aws_lifecycle_state=str(record.aws_lifecycle_state or "").strip(),
        ingress_network_connector_refs=_normalize_string_list(record.ingress_network_connector_refs),
        egress_network_connector_refs=_normalize_string_list(record.egress_network_connector_refs),
        last_action=_normalize_command(record.last_action),
        last_command_id=str(record.last_command_id or "").strip(),
        auth_subject=str(record.auth_subject or "").strip(),
        reason_metadata=_clone_string_map(record.reason_metadata),
        status_metadata=_clone_string_map(record.status_metadata),
        token_metadata=_clone_session_token_metadata_list(record.token_metadata),
        metadata=_clone_string_map(record.metadata),
    )


def _normalize_session_status(status: MicroVMSessionStatus) -> MicroVMSessionStatus:
    return MicroVMSessionStatus(
        tenant_id=str(status.tenant_id or "").strip(),
        namespace=str(status.namespace or "").strip(),
        session_id=str(status.session_id or "").strip(),
        state=_normalize_state(status.state),
        desired_state=_normalize_state(status.desired_state),
        lifecycle_state=_normalize_state(status.lifecycle_state),
        last_transition=float(status.last_transition or 0),
        registry_version=int(status.registry_version or 0),
        endpoint=str(status.endpoint or "").strip(),
        microvm_id=str(status.microvm_id or "").strip(),
        last_action=_normalize_command(status.last_action),
    )


def _normalize_session_registry_record(
    record: MicroVMSessionRegistryRecord | dict[str, Any],
) -> MicroVMSessionRegistryRecord:
    if isinstance(record, MicroVMSessionRegistryRecord):
        raw: dict[str, Any] = {
            "pk": record.pk,
            "sk": record.sk,
            "tenant_id": record.tenant_id,
            "namespace": record.namespace,
            "session_id": record.session_id,
            "state": record.state,
            "desired_state": record.desired_state,
            "endpoint": record.endpoint,
            "microvm_id": record.microvm_id,
            "provider_id": record.provider_id,
            "provider_microvm_id": record.provider_microvm_id,
            "provider_state": record.provider_state,
            "aws_lifecycle_state": record.aws_lifecycle_state,
            "image_ref": record.image_ref,
            "image_version": record.image_version,
            "network_connector_ref": record.network_connector_ref,
            "ingress_network_connector_refs": record.ingress_network_connector_refs,
            "egress_network_connector_refs": record.egress_network_connector_refs,
            "controller_id": record.controller_id,
            "created_at": record.created_at,
            "updated_at": record.updated_at,
            "last_observed_at": record.last_observed_at,
            "provider_started_at": record.provider_started_at,
            "provider_terminated_at": record.provider_terminated_at,
            "expires_at": record.expires_at,
            "ttl": record.ttl,
            "generation": record.generation,
            "version": record.version,
            "last_action": record.last_action,
            "last_command_id": record.last_command_id,
            "auth_subject": record.auth_subject,
            "reason_metadata": record.reason_metadata,
            "status_metadata": record.status_metadata,
            "token_metadata": record.token_metadata,
            "metadata": record.metadata,
        }
    else:
        raw = record if isinstance(record, dict) else {}
    reason_metadata = raw.get("reason_metadata")
    status_metadata = raw.get("status_metadata")
    token_metadata = raw.get("token_metadata")
    metadata = raw.get("metadata")
    return MicroVMSessionRegistryRecord(
        pk=str(raw.get("pk", "") or "").strip(),
        sk=str(raw.get("sk", "") or "").strip(),
        tenant_id=str(raw.get("tenant_id", "") or "").strip(),
        namespace=str(raw.get("namespace", "") or "").strip(),
        session_id=str(raw.get("session_id", "") or "").strip(),
        state=_normalize_state(str(raw.get("state", "") or "")),
        desired_state=_normalize_state(str(raw.get("desired_state", "") or "")),
        endpoint=str(raw.get("endpoint", "") or "").strip(),
        microvm_id=str(raw.get("microvm_id", "") or "").strip(),
        provider_id=str(raw.get("provider_id", "") or "").strip(),
        provider_microvm_id=str(raw.get("provider_microvm_id", "") or "").strip(),
        provider_state=str(raw.get("provider_state", "") or "").strip(),
        aws_lifecycle_state=str(raw.get("aws_lifecycle_state", "") or "").strip(),
        image_ref=str(raw.get("image_ref", "") or "").strip(),
        image_version=str(raw.get("image_version", "") or "").strip(),
        network_connector_ref=str(raw.get("network_connector_ref", "") or "").strip(),
        ingress_network_connector_refs=_normalize_string_list(raw.get("ingress_network_connector_refs") or []),
        egress_network_connector_refs=_normalize_string_list(raw.get("egress_network_connector_refs") or []),
        controller_id=str(raw.get("controller_id", "") or "").strip(),
        created_at=float(raw.get("created_at", 0) or 0),
        updated_at=float(raw.get("updated_at", 0) or 0),
        last_observed_at=float(raw.get("last_observed_at", 0) or 0),
        provider_started_at=float(raw.get("provider_started_at", 0) or 0),
        provider_terminated_at=float(raw.get("provider_terminated_at", 0) or 0),
        expires_at=float(raw.get("expires_at", 0) or 0),
        ttl=int(raw.get("ttl", 0) or 0),
        generation=int(raw.get("generation", 0) or 0),
        version=int(raw.get("version", 0) or 0),
        last_action=_normalize_command(str(raw.get("last_action", "") or "")),
        last_command_id=str(raw.get("last_command_id", "") or "").strip(),
        auth_subject=str(raw.get("auth_subject", "") or "").strip(),
        reason_metadata=_clone_string_map(reason_metadata if isinstance(reason_metadata, dict) else None),
        status_metadata=_clone_string_map(status_metadata if isinstance(status_metadata, dict) else None),
        token_metadata=_clone_session_token_metadata_list(token_metadata if isinstance(token_metadata, list) else []),
        metadata=_clone_string_map(metadata if isinstance(metadata, dict) else None),
    )


def _session_record_from_registry_no_validate(record: MicroVMSessionRegistryRecord) -> MicroVMSessionRecord:
    return MicroVMSessionRecord(
        tenant_id=record.tenant_id,
        namespace=record.namespace,
        session_id=record.session_id,
        state=record.state,
        desired_state=record.desired_state,
        image_ref=record.image_ref,
        image_version=record.image_version,
        network_connector_ref=record.network_connector_ref,
        controller_id=record.controller_id,
        created_at=record.created_at,
        updated_at=record.updated_at,
        last_observed_at=record.last_observed_at,
        provider_started_at=record.provider_started_at,
        provider_terminated_at=record.provider_terminated_at,
        expires_at=record.expires_at,
        generation=record.generation,
        endpoint=record.endpoint,
        microvm_id=record.microvm_id,
        provider_id=record.provider_id,
        provider_microvm_id=record.provider_microvm_id,
        provider_state=record.provider_state,
        aws_lifecycle_state=record.aws_lifecycle_state,
        ingress_network_connector_refs=list(record.ingress_network_connector_refs),
        egress_network_connector_refs=list(record.egress_network_connector_refs),
        last_action=record.last_action,
        last_command_id=record.last_command_id,
        auth_subject=record.auth_subject,
        reason_metadata=_clone_string_map(record.reason_metadata),
        status_metadata=_clone_string_map(record.status_metadata),
        token_metadata=_clone_session_token_metadata_list(record.token_metadata),
        metadata=_clone_string_map(record.metadata),
    )


def _clone_session_registry_record(record: MicroVMSessionRegistryRecord) -> MicroVMSessionRegistryRecord:
    return _normalize_session_registry_record(record)


def _normalize_session_registry_key(
    key: _MicroVMSessionRegistryKeyInput,
) -> tuple[str, str, str]:
    if isinstance(key, tuple):
        values = [str(item or "").strip() for item in key]
        tenant_id = values[0] if len(values) > 0 else ""
        namespace = values[1] if len(values) > 1 else ""
        session_id = values[2] if len(values) > 2 else ""
    elif isinstance(key, MicroVMSessionRecord):
        tenant_id, namespace, session_id = microvm_session_key(key)
    elif isinstance(key, MicroVMSessionRegistryRecord):
        tenant_id = str(key.tenant_id or "").strip()
        namespace = str(key.namespace or "").strip()
        session_id = str(key.session_id or "").strip()
    else:
        raw = key if isinstance(key, dict) else {}
        tenant_id = str(raw.get("tenant_id", "") or "").strip()
        namespace = str(raw.get("namespace", "") or "").strip()
        session_id = str(raw.get("session_id", "") or "").strip()
    if not tenant_id or not namespace or not session_id:
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session key is incomplete",
            "",
        )
    return (tenant_id, namespace, session_id)


def _normalize_session_reconstruction_request(
    request: MicroVMSessionReconstructionRequest | dict[str, Any],
) -> MicroVMSessionReconstructionRequest:
    if isinstance(request, MicroVMSessionReconstructionRequest):
        return MicroVMSessionReconstructionRequest(
            tenant_id=str(request.tenant_id or "").strip(),
            namespace=str(request.namespace or "").strip(),
            session_id=str(request.session_id or "").strip(),
            request_id=str(request.request_id or "").strip(),
            auth_subject=str(request.auth_subject or "").strip(),
            now=float(request.now or 0.0),
            existing=_clone_session_record(request.existing) if request.existing is not None else None,
        )
    raw = request if isinstance(request, dict) else {}
    existing = raw.get("existing")
    return MicroVMSessionReconstructionRequest(
        tenant_id=str(raw.get("tenant_id", "") or "").strip(),
        namespace=str(raw.get("namespace", "") or "").strip(),
        session_id=str(raw.get("session_id", "") or "").strip(),
        request_id=str(raw.get("request_id", "") or "").strip(),
        auth_subject=str(raw.get("auth_subject", "") or "").strip(),
        now=float(raw.get("now", 0.0) or 0.0),
        existing=_clone_session_record(existing) if isinstance(existing, MicroVMSessionRecord) else None,
    )


def _normalize_session_list_input(input_: MicroVMSessionListInput | dict[str, Any]) -> MicroVMSessionListInput:
    if isinstance(input_, MicroVMSessionListInput):
        normalized = MicroVMSessionListInput(
            tenant_id=str(input_.tenant_id or "").strip(),
            namespace=str(input_.namespace or "").strip(),
            request_id=str(input_.request_id or "").strip(),
            auth_subject=str(input_.auth_subject or "").strip(),
        )
    else:
        raw = input_ if isinstance(input_, dict) else {}
        normalized = MicroVMSessionListInput(
            tenant_id=str(raw.get("tenant_id", "") or "").strip(),
            namespace=str(raw.get("namespace", "") or "").strip(),
            request_id=str(raw.get("request_id", "") or "").strip(),
            auth_subject=str(raw.get("auth_subject", "") or "").strip(),
        )
    if not normalized.tenant_id or not normalized.namespace:
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session list is incomplete",
            normalized.request_id,
        )
    return normalized


def _session_record_is_stale(record: MicroVMSessionRecord, now: float, stale_after_seconds: int) -> bool:
    if stale_after_seconds <= 0 or now <= 0:
        return False
    normalized = _normalize_session_record(record)
    return (
        normalized.last_observed_at <= 0
        or normalized.last_observed_at + stale_after_seconds < now
        or normalized.expires_at <= now
    )


def _registry_key_tuple(key: tuple[str, str, str]) -> tuple[str, str]:
    return (
        microvm_session_registry_partition_key(key[0], key[1]),
        microvm_session_registry_sort_key(key[2]),
    )


def _registry_record_key(record: MicroVMSessionRegistryRecord) -> tuple[str, str]:
    return (record.pk, record.sk)


def _session_registry_operation_error(request_id: str) -> MicroVMSafeError:
    return _safe_error(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm session registry operation failed",
        request_id,
    )


def _controller_query_input(request: MicroVMControllerRequest) -> MicroVMSessionQueryInput:
    return MicroVMSessionQueryInput(
        request_id=request.request_id,
        tenant_id=request.tenant_id,
        namespace=request.namespace,
        session_id=request.session_id,
        auth_subject=request.auth_context.subject,
    )


def _response_from_session(
    request: MicroVMControllerRequest, record: MicroVMSessionRecord
) -> MicroVMControllerResponse:
    normalized = _normalize_session_record(record)
    return MicroVMControllerResponse(
        command=request.command,
        request_id=request.request_id,
        tenant_id=normalized.tenant_id,
        namespace=normalized.namespace,
        session_id=normalized.session_id,
        state=normalized.state,
        desired_state=normalized.desired_state,
        lifecycle_state=normalized.state,
        endpoint=normalized.endpoint,
        microvm_id=normalized.microvm_id,
        last_action=normalized.last_action,
        last_transition=normalized.updated_at,
        registry_version=normalized.generation,
    )


def _response_from_status(request: MicroVMControllerRequest, status: MicroVMSessionStatus) -> MicroVMControllerResponse:
    normalized = _normalize_session_status(status)
    return MicroVMControllerResponse(
        command=request.command,
        request_id=request.request_id,
        tenant_id=normalized.tenant_id,
        namespace=normalized.namespace,
        session_id=normalized.session_id,
        state=normalized.state,
        desired_state=normalized.desired_state,
        lifecycle_state=normalized.lifecycle_state,
        endpoint=normalized.endpoint,
        microvm_id=normalized.microvm_id,
        last_action=normalized.last_action,
        last_transition=normalized.last_transition,
        registry_version=normalized.registry_version,
    )


def _controller_error_response(request: MicroVMControllerRequest, error: MicroVMSafeError) -> MicroVMControllerResponse:
    normalized = _normalize_controller_request(request)
    return MicroVMControllerResponse(
        command=normalized.command,
        request_id=normalized.request_id,
        tenant_id=normalized.tenant_id,
        namespace=normalized.namespace,
        session_id=normalized.session_id,
        error=error,
    )


def _as_safe_error(exc: Exception, request_id: str) -> MicroVMSafeError:
    if isinstance(exc, MicroVMSafeError):
        if exc.request_id:
            return exc
        return _safe_error(exc.code, exc.message, request_id)
    return _safe_error(
        MICROVM_ERROR_CONTROLLER_COMMAND_FAILED,
        "apptheory: microvm controller command failed",
        request_id,
    )


def _normalize_session_token_metadata(
    token: MicroVMSessionTokenMetadata | dict[str, Any],
) -> MicroVMSessionTokenMetadata:
    if isinstance(token, MicroVMSessionTokenMetadata):
        return MicroVMSessionTokenMetadata(
            token_id=str(token.token_id or "").strip(),
            token_type=str(token.token_type or "").strip(),
            expires_at=float(token.expires_at or 0.0),
            scope=_normalize_string_list(token.scope),
        )
    raw = token if isinstance(token, dict) else {}
    return MicroVMSessionTokenMetadata(
        token_id=str(raw.get("token_id", "") or "").strip(),
        token_type=str(raw.get("token_type", "") or "").strip(),
        expires_at=float(raw.get("expires_at", 0.0) or 0.0),
        scope=_normalize_string_list(raw.get("scope") or []),
    )


def _clone_session_token_metadata_list(values: Any) -> list[MicroVMSessionTokenMetadata]:
    if not isinstance(values, list):
        return []
    out: list[MicroVMSessionTokenMetadata] = []
    for item in values:
        normalized = _normalize_session_token_metadata(item)
        if normalized.token_id or normalized.token_type or normalized.expires_at > 0 or normalized.scope:
            out.append(normalized)
    return out


def _clone_session_record(record: MicroVMSessionRecord) -> MicroVMSessionRecord:
    return _normalize_session_record(record)


def _random_microvm_session_id() -> str:
    import secrets

    return f"microvm-{secrets.token_hex(16)}"


def _load_aws_lambda_microvm_provider_client(*, region_name: str | None) -> Any:
    try:
        import boto3  # type: ignore[import-not-found]
        import botocore.session  # type: ignore[import-not-found]

        session = botocore.session.get_session()
        if "lambda-microvms" not in set(session.get_available_services()):
            raise RuntimeError("lambda-microvms service model unavailable")
        model = session.get_service_model("lambda-microvms")
        required_operations = {
            "RunMicrovm",
            "GetMicrovm",
            "ListMicrovms",
            "SuspendMicrovm",
            "ResumeMicrovm",
            "TerminateMicrovm",
            "CreateMicrovmAuthToken",
            "CreateMicrovmShellAuthToken",
        }
        operation_names = set(cast(Iterable[str], model.operation_names))
        if not required_operations.issubset(operation_names):
            raise RuntimeError("lambda-microvms service model incomplete")
        kwargs = {"region_name": region_name} if region_name else {}
        client = cast(Any, boto3).client("lambda-microvms", **kwargs)
        required_methods = [
            "run_microvm",
            "get_microvm",
            "list_microvms",
            "suspend_microvm",
            "resume_microvm",
            "terminate_microvm",
            "create_microvm_auth_token",
            "create_microvm_shell_auth_token",
        ]
        if not all(callable(getattr(client, method, None)) for method in required_methods):
            raise RuntimeError("lambda-microvms methods unavailable")
        return client
    except Exception:  # noqa: BLE001
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_OPERATION_FAILED,
            "apptheory: microvm provider adapter requires official AWS Lambda MicroVM SDK client",
            "",
        ) from None


def _validate_provider_run_input(input_: MicroVMProviderRunInput | dict[str, Any]) -> MicroVMProviderRunInput:
    normalized = _normalize_provider_run_input(input_)
    _validate_provider_operation(OPERATION_RUN, normalized.request_id)
    _validate_provider_access(
        normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.auth_context
    )
    if not normalized.request_id:
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm provider request_id is required",
            "",
        )
    if not normalized.session_id or not normalized.image_ref:
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm provider run requires session_id and image_ref",
            normalized.request_id,
        )
    if _forbidden_field_name(normalized.image_ref) or _forbidden_field_name(normalized.image_version):
        raise _safe_error(
            MICROVM_ERROR_FORBIDDEN_FIELD,
            "apptheory: microvm provider run exposes forbidden field",
            normalized.request_id,
        )
    if err := _validate_safe_metadata(normalized.session_spec.metadata, normalized.request_id):
        raise err
    _validate_safe_connector_refs(
        normalized.request_id,
        [
            normalized.network_connector_ref,
            *normalized.ingress_network_connector_refs,
            *normalized.egress_network_connector_refs,
        ],
    )
    if err := _validate_execution_role_arn(normalized.execution_role_arn, normalized.request_id):
        raise err
    if normalized.idle_policy is not None and (
        normalized.idle_policy.max_idle_duration_seconds <= 0 or normalized.idle_policy.suspended_duration_seconds <= 0
    ):
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm provider idle policy is incomplete",
            normalized.request_id,
        )
    if normalized.maximum_duration_seconds < 0:
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm provider maximum duration is invalid",
            normalized.request_id,
        )
    return normalized


def _validate_provider_session_input(
    operation: str, input_: MicroVMProviderSessionInput | dict[str, Any]
) -> MicroVMProviderSessionInput:
    normalized = _normalize_provider_session_input(input_)
    _validate_provider_operation(operation, normalized.request_id)
    if not normalized.request_id:
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm provider request_id is required",
            "",
        )
    _validate_provider_access(
        normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.auth_context
    )
    normalized.binding = _validate_provider_binding(
        normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.binding
    )
    return normalized


def _validate_provider_list_input(input_: MicroVMProviderListInput | dict[str, Any]) -> MicroVMProviderListInput:
    normalized = _normalize_provider_list_input(input_)
    _validate_provider_operation(OPERATION_LIST, normalized.request_id)
    if not normalized.request_id:
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm provider request_id is required",
            "",
        )
    _validate_provider_access(
        normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.auth_context
    )
    if _forbidden_field_name(normalized.image_ref) or _forbidden_field_name(normalized.image_version):
        raise _safe_error(
            MICROVM_ERROR_FORBIDDEN_FIELD,
            "apptheory: microvm provider list exposes forbidden field",
            normalized.request_id,
        )
    normalized.known_sessions = [
        _validate_provider_binding(normalized.request_id, normalized.tenant_id, normalized.namespace, binding)
        for binding in normalized.known_sessions
    ]
    if normalized.max_results < 0:
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm provider list max_results is invalid",
            normalized.request_id,
        )
    return normalized


def _validate_provider_token_input(
    operation: str, input_: MicroVMProviderTokenInput | dict[str, Any]
) -> MicroVMProviderTokenInput:
    normalized = _normalize_provider_token_input(input_)
    normalized_operation = _normalize_operation(operation)
    _validate_provider_operation(normalized_operation, normalized.request_id)
    if not normalized.request_id:
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm provider request_id is required",
            "",
        )
    if normalized_operation not in {OPERATION_AUTH_TOKEN, OPERATION_SHELL_TOKEN}:
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED,
            "apptheory: microvm provider token operation is unsupported",
            normalized.request_id,
        )
    _validate_provider_access(
        normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.auth_context
    )
    normalized.binding = _validate_provider_binding(
        normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.binding
    )
    if normalized.ttl_seconds == 0:
        normalized.ttl_seconds = _DEFAULT_PROVIDER_TOKEN_TTL_SECONDS
    if not _MIN_PROVIDER_TOKEN_TTL_SECONDS <= normalized.ttl_seconds <= _MAX_PROVIDER_TOKEN_TTL_SECONDS:
        raise _safe_error(
            MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
            "apptheory: microvm provider token ttl exceeds contract bounds",
            normalized.request_id,
        )
    if normalized_operation == OPERATION_AUTH_TOKEN and not normalized.allowed_port_scope:
        raise _safe_error(
            MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
            "apptheory: microvm auth token requires an explicit allowed port scope",
            normalized.request_id,
        )
    for scope in normalized.allowed_port_scope:
        _validate_provider_port_scope(scope, normalized.request_id)
    return normalized


def _validate_provider_invoke_input(input_: MicroVMProviderInvokeInput | dict[str, Any]) -> MicroVMProviderInvokeInput:
    normalized = _normalize_provider_invoke_input(input_)
    _validate_provider_operation(OPERATION_INVOKE, normalized.request_id)
    if not normalized.request_id:
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm provider request_id is required",
            "",
        )
    _validate_provider_access(
        normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.auth_context
    )
    normalized.binding = _validate_provider_binding(
        normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.binding
    )
    if normalized.method not in _PROVIDER_INVOKE_METHODS:
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm invoke method is unsupported",
            normalized.request_id,
        )
    if not normalized.endpoint or _forbidden_field_name(normalized.endpoint):
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm invoke endpoint is invalid",
            normalized.request_id,
        )
    try:
        _provider_invoke_url(normalized.endpoint, normalized.path, normalized.query)
    except MicroVMSafeError as exc:
        raise _safe_error(exc.code, exc.message, normalized.request_id) from None
    if not normalized.path or "\x00" in normalized.path:
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm invoke path is invalid",
            normalized.request_id,
        )
    if normalized.port <= 0 or normalized.port > 65535:
        raise _safe_error(
            MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
            "apptheory: microvm invoke port is invalid",
            normalized.request_id,
        )
    if not _MIN_PROVIDER_TOKEN_TTL_SECONDS <= normalized.ttl_seconds <= _MAX_PROVIDER_TOKEN_TTL_SECONDS:
        raise _safe_error(
            MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
            "apptheory: microvm invoke token ttl exceeds contract bounds",
            normalized.request_id,
        )
    if len(normalized.body) > _MAX_PROVIDER_INVOKE_BODY_BYTES:
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm invoke body is too large",
            normalized.request_id,
        )
    normalized.headers = _sanitize_provider_invoke_headers(normalized.headers)
    return normalized


def _validate_provider_operation(operation: str, request_id: str) -> None:
    if _normalize_operation(operation) not in set(_required_operations()):
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED,
            "apptheory: microvm provider operation is unsupported",
            request_id,
        )


def _validate_provider_access(request_id: str, tenant_id: str, namespace: str, auth: MicroVMAuthContext) -> None:
    normalized = _normalize_auth_context(auth)
    if not str(tenant_id or "").strip() or not str(namespace or "").strip():
        raise _safe_error(
            MICROVM_ERROR_TENANT_BINDING_VIOLATION,
            "apptheory: microvm provider request requires tenant and namespace",
            request_id,
        )
    if not normalized.subject or not normalized.tenant_id:
        raise _safe_error(
            MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
            "apptheory: microvm provider request requires authenticated context",
            request_id,
        )
    if normalized.tenant_id != str(tenant_id or "").strip():
        raise _safe_error(
            MICROVM_ERROR_TENANT_BINDING_VIOLATION,
            "apptheory: microvm provider auth context is cross-tenant",
            request_id,
        )
    if normalized.namespace and normalized.namespace != str(namespace or "").strip():
        raise _safe_error(
            MICROVM_ERROR_TENANT_BINDING_VIOLATION,
            "apptheory: microvm provider auth context is cross-namespace",
            request_id,
        )
    if err := _validate_safe_metadata(normalized.metadata, request_id):
        raise err


def _validate_provider_binding(
    request_id: str, tenant_id: str, namespace: str, binding: MicroVMProviderSessionBinding
) -> MicroVMProviderSessionBinding:
    normalized = _normalize_provider_binding(binding)
    if (
        not normalized.tenant_id
        or not normalized.namespace
        or not normalized.session_id
        or not normalized.provider_microvm_id
    ):
        raise _safe_error(
            MICROVM_ERROR_TENANT_BINDING_VIOLATION,
            "apptheory: microvm provider binding is incomplete",
            request_id,
        )
    if normalized.tenant_id != str(tenant_id or "").strip() or normalized.namespace != str(namespace or "").strip():
        raise _safe_error(
            MICROVM_ERROR_TENANT_BINDING_VIOLATION,
            "apptheory: microvm provider binding is cross-tenant",
            request_id,
        )
    if _forbidden_field_name(normalized.provider_microvm_id):
        raise _safe_error(
            MICROVM_ERROR_FORBIDDEN_FIELD,
            "apptheory: microvm provider binding exposes forbidden field",
            request_id,
        )
    return normalized


def _validate_provider_port_scope(scope: MicroVMProviderPortScope, request_id: str) -> None:
    options = 0
    if scope.all_ports:
        options += 1
    if scope.port > 0:
        options += 1
    if scope.start_port > 0 or scope.end_port > 0:
        options += 1
        if scope.start_port <= 0 or scope.end_port <= 0 or scope.start_port > scope.end_port:
            raise _safe_error(
                MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
                "apptheory: microvm provider token port range is invalid",
                request_id,
            )
    if options != 1:
        raise _safe_error(
            MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
            "apptheory: microvm provider token port scope must specify exactly one scope",
            request_id,
        )


def _validate_safe_connector_refs(request_id: str, refs: list[str]) -> None:
    for ref in refs:
        if _forbidden_field_name(ref):
            raise _safe_error(
                MICROVM_ERROR_FORBIDDEN_FIELD,
                "apptheory: microvm provider connector exposes forbidden field",
                request_id,
            )


def _normalize_provider_run_input(value: MicroVMProviderRunInput | dict[str, Any]) -> MicroVMProviderRunInput:
    if isinstance(value, MicroVMProviderRunInput):
        return MicroVMProviderRunInput(
            request_id=str(value.request_id or "").strip(),
            tenant_id=str(value.tenant_id or "").strip(),
            namespace=str(value.namespace or "").strip(),
            session_id=str(value.session_id or "").strip(),
            auth_context=_normalize_auth_context(value.auth_context),
            image_ref=str(value.image_ref or "").strip(),
            image_version=str(value.image_version or "").strip(),
            network_connector_ref=str(value.network_connector_ref or "").strip(),
            ingress_network_connector_refs=_normalize_string_list(value.ingress_network_connector_refs),
            egress_network_connector_refs=_normalize_string_list(value.egress_network_connector_refs),
            session_spec=_clone_session_spec(value.session_spec),
            idle_policy=_normalize_provider_idle_policy(value.idle_policy),
            maximum_duration_seconds=int(value.maximum_duration_seconds or 0),
            execution_role_arn=_normalize_execution_role_arn(value.execution_role_arn),
        )
    raw = value if isinstance(value, dict) else {}
    return MicroVMProviderRunInput(
        request_id=str(raw.get("request_id", "") or "").strip(),
        tenant_id=str(raw.get("tenant_id", "") or "").strip(),
        namespace=str(raw.get("namespace", "") or "").strip(),
        session_id=str(raw.get("session_id", "") or "").strip(),
        auth_context=_normalize_auth_context(raw.get("auth_context") or {}),
        image_ref=str(raw.get("image_ref", "") or "").strip(),
        image_version=str(raw.get("image_version", "") or "").strip(),
        network_connector_ref=str(raw.get("network_connector_ref", "") or "").strip(),
        ingress_network_connector_refs=_normalize_string_list(raw.get("ingress_network_connector_refs") or []),
        egress_network_connector_refs=_normalize_string_list(raw.get("egress_network_connector_refs") or []),
        session_spec=_clone_session_spec(raw.get("session_spec") or {}),
        idle_policy=_normalize_provider_idle_policy(raw.get("idle_policy")),
        maximum_duration_seconds=int(raw.get("maximum_duration_seconds", 0) or 0),
        execution_role_arn=_normalize_execution_role_arn(raw.get("execution_role_arn")),
    )


def _normalize_provider_idle_policy(
    value: MicroVMProviderIdlePolicy | dict[str, Any] | None,
) -> MicroVMProviderIdlePolicy | None:
    if value is None:
        return None
    if isinstance(value, MicroVMProviderIdlePolicy):
        return MicroVMProviderIdlePolicy(
            auto_resume_enabled=value.auto_resume_enabled,
            max_idle_duration_seconds=int(value.max_idle_duration_seconds or 0),
            suspended_duration_seconds=int(value.suspended_duration_seconds or 0),
        )
    raw = value if isinstance(value, dict) else {}
    return MicroVMProviderIdlePolicy(
        auto_resume_enabled=raw.get("auto_resume_enabled") is True,
        max_idle_duration_seconds=int(raw.get("max_idle_duration_seconds", 0) or 0),
        suspended_duration_seconds=int(raw.get("suspended_duration_seconds", 0) or 0),
    )


def _normalize_provider_session_input(
    value: MicroVMProviderSessionInput | dict[str, Any],
) -> MicroVMProviderSessionInput:
    if isinstance(value, MicroVMProviderSessionInput):
        return MicroVMProviderSessionInput(
            request_id=str(value.request_id or "").strip(),
            tenant_id=str(value.tenant_id or "").strip(),
            namespace=str(value.namespace or "").strip(),
            auth_context=_normalize_auth_context(value.auth_context),
            binding=_normalize_provider_binding(value.binding),
        )
    raw = value if isinstance(value, dict) else {}
    return MicroVMProviderSessionInput(
        request_id=str(raw.get("request_id", "") or "").strip(),
        tenant_id=str(raw.get("tenant_id", "") or "").strip(),
        namespace=str(raw.get("namespace", "") or "").strip(),
        auth_context=_normalize_auth_context(raw.get("auth_context") or {}),
        binding=_normalize_provider_binding(raw.get("binding") or {}),
    )


def _normalize_provider_list_input(value: MicroVMProviderListInput | dict[str, Any]) -> MicroVMProviderListInput:
    if isinstance(value, MicroVMProviderListInput):
        return MicroVMProviderListInput(
            request_id=str(value.request_id or "").strip(),
            tenant_id=str(value.tenant_id or "").strip(),
            namespace=str(value.namespace or "").strip(),
            auth_context=_normalize_auth_context(value.auth_context),
            image_ref=str(value.image_ref or "").strip(),
            image_version=str(value.image_version or "").strip(),
            max_results=int(value.max_results or 0),
            known_sessions=[_normalize_provider_binding(binding) for binding in value.known_sessions],
        )
    raw = cast(dict[str, Any], value) if isinstance(value, dict) else {}
    known = cast(list[Any], raw.get("known_sessions")) if isinstance(raw.get("known_sessions"), list) else []
    return MicroVMProviderListInput(
        request_id=str(raw.get("request_id", "") or "").strip(),
        tenant_id=str(raw.get("tenant_id", "") or "").strip(),
        namespace=str(raw.get("namespace", "") or "").strip(),
        auth_context=_normalize_auth_context(raw.get("auth_context") or {}),
        image_ref=str(raw.get("image_ref", "") or "").strip(),
        image_version=str(raw.get("image_version", "") or "").strip(),
        max_results=int(raw.get("max_results", 0) or 0),
        known_sessions=[_normalize_provider_binding(binding) for binding in known],
    )


def _normalize_provider_token_input(value: MicroVMProviderTokenInput | dict[str, Any]) -> MicroVMProviderTokenInput:
    if isinstance(value, MicroVMProviderTokenInput):
        return MicroVMProviderTokenInput(
            request_id=str(value.request_id or "").strip(),
            tenant_id=str(value.tenant_id or "").strip(),
            namespace=str(value.namespace or "").strip(),
            auth_context=_normalize_auth_context(value.auth_context),
            binding=_normalize_provider_binding(value.binding),
            ttl_seconds=int(value.ttl_seconds or 0),
            allowed_port_scope=[_normalize_provider_port_scope(scope) for scope in value.allowed_port_scope],
        )
    raw = cast(dict[str, Any], value) if isinstance(value, dict) else {}
    scopes = cast(list[Any], raw.get("allowed_port_scope")) if isinstance(raw.get("allowed_port_scope"), list) else []
    return MicroVMProviderTokenInput(
        request_id=str(raw.get("request_id", "") or "").strip(),
        tenant_id=str(raw.get("tenant_id", "") or "").strip(),
        namespace=str(raw.get("namespace", "") or "").strip(),
        auth_context=_normalize_auth_context(raw.get("auth_context") or {}),
        binding=_normalize_provider_binding(raw.get("binding") or {}),
        ttl_seconds=int(raw.get("ttl_seconds", 0) or 0),
        allowed_port_scope=[_normalize_provider_port_scope(scope) for scope in scopes],
    )


def _normalize_provider_invoke_input(value: MicroVMProviderInvokeInput | dict[str, Any]) -> MicroVMProviderInvokeInput:
    if isinstance(value, MicroVMProviderInvokeInput):
        out = MicroVMProviderInvokeInput(
            request_id=str(value.request_id or "").strip(),
            tenant_id=str(value.tenant_id or "").strip(),
            namespace=str(value.namespace or "").strip(),
            auth_context=_normalize_auth_context(value.auth_context),
            binding=_normalize_provider_binding(value.binding),
            endpoint=str(value.endpoint or "").strip(),
            method=str(value.method or "").strip().upper(),
            path=_normalize_provider_invoke_path(value.path),
            query=_clone_query_values(value.query),
            headers=_sanitize_provider_invoke_headers(value.headers),
            body=_coerce_body_bytes(value.body),
            port=int(value.port or 0),
            ttl_seconds=int(value.ttl_seconds or 0),
        )
    else:
        raw = cast(dict[str, Any], value) if isinstance(value, dict) else {}
        out = MicroVMProviderInvokeInput(
            request_id=str(raw.get("request_id", "") or "").strip(),
            tenant_id=str(raw.get("tenant_id", "") or "").strip(),
            namespace=str(raw.get("namespace", "") or "").strip(),
            auth_context=_normalize_auth_context(raw.get("auth_context") or {}),
            binding=_normalize_provider_binding(raw.get("binding") or {}),
            endpoint=str(raw.get("endpoint", "") or "").strip(),
            method=str(raw.get("method", "") or "").strip().upper(),
            path=_normalize_provider_invoke_path(str(raw.get("path", "") or "")),
            query=_clone_query_values(raw.get("query") if isinstance(raw.get("query"), dict) else {}),
            headers=_sanitize_provider_invoke_headers(
                cast(dict[str, Any], raw.get("headers")) if isinstance(raw.get("headers"), dict) else {}
            ),
            body=_coerce_body_bytes(raw.get("body", b"")),
            port=int(raw.get("port", 0) or 0),
            ttl_seconds=int(raw.get("ttl_seconds", 0) or 0),
        )
    if out.port == 0:
        out.port = _DEFAULT_PROVIDER_INVOKE_PORT
    if out.ttl_seconds == 0:
        out.ttl_seconds = _DEFAULT_PROVIDER_INVOKE_TOKEN_TTL_SECONDS
    return out


def _normalize_provider_invoke_path(path: str) -> str:
    normalized = str(path or "").strip()
    if not normalized:
        return "/"
    if not normalized.startswith("/"):
        normalized = "/" + normalized
    return normalized


def _sanitize_provider_invoke_headers(headers: dict[str, Any]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for raw_name, raw_values in dict(headers or {}).items():
        name = str(raw_name or "").strip().lower()
        if not name or name in _PROVIDER_INVOKE_FORBIDDEN_HEADERS:
            continue
        values = _header_values(raw_values)
        clean = [
            value
            for value in (str(item or "").strip() for item in values)
            if value and not _forbidden_field_name(value)
        ]
        if clean:
            out[name] = clean
    return out


def _provider_invoke_url(endpoint: str, path: str, query: dict[str, list[str]]) -> str:
    raw_endpoint = str(endpoint or "").strip()
    if not raw_endpoint:
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm invoke endpoint is invalid",
            "",
        )
    if not raw_endpoint.startswith(("http://", "https://")):
        raw_endpoint = f"https://{raw_endpoint}"
    parsed = urllib.parse.urlparse(raw_endpoint)
    if not parsed.netloc:
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm invoke endpoint is invalid",
            "",
        )
    normalized_query = _clone_query_values(query)
    pairs: list[tuple[str, str]] = []
    for key in sorted(normalized_query):
        pairs.extend((key, value) for value in normalized_query.get(key, []))
    return urllib.parse.urlunparse(
        parsed._replace(
            scheme="https",
            params="",
            path=_normalize_provider_invoke_path(path),
            query=urllib.parse.urlencode(pairs, doseq=True),
            fragment="",
        )
    )


def _provider_invoke_port_header(port: int) -> str:
    value = int(port or 0) or _DEFAULT_PROVIDER_INVOKE_PORT
    return str(value)


def _provider_invoke_response_is_base64(headers: dict[str, list[str]]) -> bool:
    content_type = ""
    for name, values in dict(headers or {}).items():
        if str(name or "").strip().lower() == "content-type" and values:
            content_type = str(values[0] or "").strip().lower()
            break
    if not content_type:
        return False
    textual_prefixes = (
        "text/",
        "application/json",
        "application/xml",
        "application/javascript",
        "application/problem+json",
    )
    return not any(content_type.startswith(prefix) for prefix in textual_prefixes)


def _clone_query_values(query: Any) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    raw = query if isinstance(query, dict) else {}
    for raw_key, raw_values in raw.items():
        key = str(raw_key or "").strip()
        if not key:
            continue
        out[key] = [str(value or "").strip() for value in _header_values(raw_values)]
    return {key: values for key, values in out.items() if key}


def _coerce_body_bytes(value: Any) -> bytes:
    if value is None:
        return b""
    if isinstance(value, bytes):
        return bytes(value)
    if isinstance(value, bytearray | memoryview):
        return bytes(value)
    if isinstance(value, str):
        return value.encode("utf-8")
    return bytes(str(value), "utf-8")


def _header_values(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item or "") for item in value]
    if isinstance(value, tuple):
        return [str(item or "") for item in value]
    return [str(value or "")]


def _normalize_provider_binding(value: MicroVMProviderSessionBinding | dict[str, Any]) -> MicroVMProviderSessionBinding:
    if isinstance(value, MicroVMProviderSessionBinding):
        return MicroVMProviderSessionBinding(
            tenant_id=str(value.tenant_id or "").strip(),
            namespace=str(value.namespace or "").strip(),
            session_id=str(value.session_id or "").strip(),
            provider_microvm_id=str(value.provider_microvm_id or "").strip(),
            registry_version=int(value.registry_version or 0),
        )
    raw = value if isinstance(value, dict) else {}
    return MicroVMProviderSessionBinding(
        tenant_id=str(raw.get("tenant_id", "") or "").strip(),
        namespace=str(raw.get("namespace", "") or "").strip(),
        session_id=str(raw.get("session_id", "") or "").strip(),
        provider_microvm_id=str(raw.get("provider_microvm_id", "") or "").strip(),
        registry_version=int(raw.get("registry_version", 0) or 0),
    )


def _normalize_provider_port_scope(value: MicroVMProviderPortScope | dict[str, Any]) -> MicroVMProviderPortScope:
    if isinstance(value, MicroVMProviderPortScope):
        return MicroVMProviderPortScope(
            all_ports=value.all_ports,
            port=int(value.port or 0),
            start_port=int(value.start_port or 0),
            end_port=int(value.end_port or 0),
        )
    raw = value if isinstance(value, dict) else {}
    return MicroVMProviderPortScope(
        all_ports=raw.get("all_ports") is True,
        port=int(raw.get("port", 0) or 0),
        start_port=int(raw.get("start_port", 0) or 0),
        end_port=int(raw.get("end_port", 0) or 0),
    )


def _normalize_provider_session(value: MicroVMProviderSession | dict[str, Any]) -> MicroVMProviderSession:
    if isinstance(value, MicroVMProviderSession):
        return MicroVMProviderSession(
            tenant_id=str(value.tenant_id or "").strip(),
            namespace=str(value.namespace or "").strip(),
            session_id=str(value.session_id or "").strip(),
            provider_microvm_id=str(value.provider_microvm_id or "").strip(),
            state=_normalize_real_state(value.state),
            provider_state=_normalize_provider_state(value.provider_state),
            terminal=value.terminal,
            endpoint=str(value.endpoint or "").strip(),
            image_ref=str(value.image_ref or "").strip(),
            image_version=str(value.image_version or "").strip(),
            started_at=float(value.started_at or 0.0),
            terminated_at=float(value.terminated_at or 0.0),
            registry_version=int(value.registry_version or 0),
        )
    raw = value if isinstance(value, dict) else {}
    return MicroVMProviderSession(
        tenant_id=str(raw.get("tenant_id", "") or "").strip(),
        namespace=str(raw.get("namespace", "") or "").strip(),
        session_id=str(raw.get("session_id", "") or "").strip(),
        provider_microvm_id=str(raw.get("provider_microvm_id", "") or "").strip(),
        state=_normalize_real_state(str(raw.get("state", "") or "")),
        provider_state=_normalize_provider_state(str(raw.get("provider_state", "") or "")),
        terminal=raw.get("terminal") is True,
        endpoint=str(raw.get("endpoint", "") or "").strip(),
        image_ref=str(raw.get("image_ref", "") or "").strip(),
        image_version=str(raw.get("image_version", "") or "").strip(),
        started_at=float(raw.get("started_at", 0.0) or 0.0),
        terminated_at=float(raw.get("terminated_at", 0.0) or 0.0),
        registry_version=int(raw.get("registry_version", 0) or 0),
    )


def _normalize_provider_token(value: MicroVMProviderToken | dict[str, Any]) -> MicroVMProviderToken:
    if isinstance(value, MicroVMProviderToken):
        return MicroVMProviderToken(
            tenant_id=str(value.tenant_id or "").strip(),
            namespace=str(value.namespace or "").strip(),
            session_id=str(value.session_id or "").strip(),
            provider_microvm_id=str(value.provider_microvm_id or "").strip(),
            token_id=str(value.token_id or "").strip(),
            token_type=str(value.token_type or "").strip(),
            expires_at=float(value.expires_at or 0.0),
            scope=_normalize_string_list(value.scope),
        )
    raw = value if isinstance(value, dict) else {}
    return MicroVMProviderToken(
        tenant_id=str(raw.get("tenant_id", "") or "").strip(),
        namespace=str(raw.get("namespace", "") or "").strip(),
        session_id=str(raw.get("session_id", "") or "").strip(),
        provider_microvm_id=str(raw.get("provider_microvm_id", "") or "").strip(),
        token_id=str(raw.get("token_id", "") or "").strip(),
        token_type=str(raw.get("token_type", "") or "").strip(),
        expires_at=float(raw.get("expires_at", 0.0) or 0.0),
        scope=_normalize_string_list(raw.get("scope") or []),
    )


def _normalize_string_list(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    return [trimmed for value in values if (trimmed := str(value or "").strip())]


def _clone_provider_session(session: MicroVMProviderSession) -> MicroVMProviderSession:
    return _normalize_provider_session(session)


def _clone_provider_token(token: MicroVMProviderToken) -> MicroVMProviderToken:
    return _normalize_provider_token(token)


def _provider_key(tenant_id: str, namespace: str, session_id: str) -> tuple[str, str, str]:
    return (str(tenant_id or "").strip(), str(namespace or "").strip(), str(session_id or "").strip())


def _provider_egress_connectors(input_: MicroVMProviderRunInput) -> list[str]:
    values = _normalize_string_list([*input_.egress_network_connector_refs, input_.network_connector_ref])
    return list(dict.fromkeys(values))


def _safe_run_hook_payload(input_: MicroVMProviderRunInput) -> str:
    import json

    return json.dumps(
        {
            "request_id": input_.request_id,
            "tenant_id": input_.tenant_id,
            "namespace": input_.namespace,
            "session_id": input_.session_id,
        },
        separators=(",", ":"),
    )


def _provider_session_from_run_output(input_: MicroVMProviderRunInput, output: Any) -> MicroVMProviderSession:
    binding = MicroVMProviderSessionBinding(
        tenant_id=input_.tenant_id,
        namespace=input_.namespace,
        session_id=input_.session_id,
        provider_microvm_id=_string_field(output, "microvmId"),
    )
    return _provider_session_from_state(
        binding,
        _string_field(output, "state"),
        _string_field(output, "endpoint"),
        _string_field(output, "imageArn") or input_.image_ref,
        _string_field(output, "imageVersion") or input_.image_version,
        _time_field(output, "startedAt"),
        _time_field(output, "terminatedAt"),
    )


def _provider_session_from_get_output(
    request_id: str, binding: MicroVMProviderSessionBinding, output: Any
) -> MicroVMProviderSession:
    provider_id = _string_field(output, "microvmId")
    if provider_id and provider_id != binding.provider_microvm_id:
        raise _safe_error(
            MICROVM_ERROR_TENANT_BINDING_VIOLATION,
            "apptheory: microvm provider returned mismatched session binding",
            request_id,
        )
    return _provider_session_from_state(
        binding,
        _string_field(output, "state"),
        _string_field(output, "endpoint"),
        _string_field(output, "imageArn"),
        _string_field(output, "imageVersion"),
        _time_field(output, "startedAt"),
        _time_field(output, "terminatedAt"),
    )


def _provider_list_output_from_sdk(input_: MicroVMProviderListInput, output: Any) -> MicroVMProviderListOutput:
    bindings = {binding.provider_microvm_id: binding for binding in input_.known_sessions}
    raw_items = output.get("items", []) if isinstance(output, dict) else getattr(output, "items", [])
    items = raw_items if isinstance(raw_items, list) else []
    sessions: list[MicroVMProviderSession] = []
    for item in items:
        provider_id = _string_field(item, "microvmId")
        binding = bindings.get(provider_id)
        if binding is None:
            continue
        sessions.append(
            _provider_session_from_state(
                binding,
                _string_field(item, "state"),
                "",
                _string_field(item, "imageArn"),
                _string_field(item, "imageVersion"),
                _time_field(item, "startedAt"),
                0.0,
            )
        )
    return MicroVMProviderListOutput(sessions=sessions)


def _provider_session_from_state(
    binding: MicroVMProviderSessionBinding,
    provider_state: str,
    endpoint: str,
    image_ref: str,
    image_version: str,
    started_at: float,
    terminated_at: float,
) -> MicroVMProviderSession:
    state, terminal = map_microvm_provider_state(provider_state)
    session = MicroVMProviderSession(
        tenant_id=binding.tenant_id,
        namespace=binding.namespace,
        session_id=binding.session_id,
        provider_microvm_id=binding.provider_microvm_id,
        state=state,
        provider_state=_normalize_provider_state(provider_state),
        terminal=terminal,
        endpoint=str(endpoint or "").strip(),
        image_ref=str(image_ref or "").strip(),
        image_version=str(image_version or "").strip(),
        started_at=float(started_at or 0.0),
        terminated_at=float(terminated_at or 0.0),
        registry_version=int(binding.registry_version or 0),
    )
    validate_microvm_provider_session(session)
    return session


def _aws_port_scopes(scopes: list[MicroVMProviderPortScope]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for scope in scopes:
        if scope.all_ports:
            out.append({"allPorts": {}})
        elif scope.port > 0:
            out.append({"port": scope.port})
        else:
            out.append({"range": {"startPort": scope.start_port, "endPort": scope.end_port}})
    return out


def _ensure_provider_token_result(output: Any, request_id: str) -> None:
    auth_token = output.get("authToken") if isinstance(output, dict) else getattr(output, "authToken", None)
    if not isinstance(auth_token, dict) or not auth_token:
        raise _safe_error(
            MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
            "apptheory: microvm provider returned incomplete token metadata",
            request_id,
        )


def _provider_token_metadata(operation: str, input_: MicroVMProviderTokenInput, now: float) -> MicroVMProviderToken:
    token_type = "shell" if operation == OPERATION_SHELL_TOKEN else "auth"
    scope = _provider_token_scope(operation, input_.allowed_port_scope)
    expires_at = float(now or 0.0) + float(input_.ttl_seconds or _DEFAULT_PROVIDER_TOKEN_TTL_SECONDS)
    token = MicroVMProviderToken(
        tenant_id=input_.binding.tenant_id,
        namespace=input_.binding.namespace,
        session_id=input_.binding.session_id,
        provider_microvm_id=input_.binding.provider_microvm_id,
        token_id=_safe_provider_token_id(input_.binding, token_type, expires_at, scope),
        token_type=token_type,
        expires_at=expires_at,
        scope=scope,
    )
    validate_microvm_provider_token(token)
    return token


def _provider_token_scope(operation: str, scopes: list[MicroVMProviderPortScope]) -> list[str]:
    if operation == OPERATION_SHELL_TOKEN:
        return ["shell"]
    out: list[str] = []
    for scope in scopes:
        if scope.all_ports:
            out.append("ports:*")
        elif scope.port > 0:
            out.append(f"ports:{scope.port}")
        else:
            out.append(f"ports:{scope.start_port}-{scope.end_port}")
    return sorted(out)


def _safe_provider_token_id(
    binding: MicroVMProviderSessionBinding, token_type: str, expires_at: float, scope: list[str]
) -> str:
    parts = [
        binding.tenant_id,
        binding.namespace,
        binding.session_id,
        binding.provider_microvm_id,
        token_type,
        str(float(expires_at or 0.0)),
        *scope,
    ]
    digest = hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()[:16]
    return f"{token_type}-{digest}"


def _provider_expiration_minutes(ttl_seconds: int) -> int:
    return max(1, int((int(ttl_seconds or 0) + 59) // 60))


def _fake_provider_error(request_id: str) -> MicroVMSafeError:
    return _safe_error(
        MICROVM_ERROR_PROVIDER_OPERATION_FAILED,
        "apptheory: microvm provider operation failed",
        request_id,
    )


def _as_provider_safe_error(exc: Exception, request_id: str) -> MicroVMSafeError:
    if isinstance(exc, MicroVMSafeError):
        if exc.request_id:
            return exc
        return _safe_error(exc.code, exc.message, request_id)
    return _fake_provider_error(request_id)


def _normalize_provider_state(state: str) -> str:
    return str(state or "").strip().lower()


def _time_field(value: Any, key: str) -> float:
    raw = value.get(key, 0) if isinstance(value, dict) else getattr(value, key, 0)
    timestamp = getattr(raw, "timestamp", None)
    if callable(timestamp):
        try:
            return float(cast(Any, timestamp)())
        except (TypeError, ValueError, OSError):
            return 0.0
    try:
        return float(raw or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _string_field(value: Any, key: str) -> str:
    raw = value.get(key, "") if isinstance(value, dict) else getattr(value, key, "")
    return str(raw or "").strip()


def _number_field(value: Any, key: str) -> int:
    raw = value.get(key, 0) if isinstance(value, dict) else getattr(value, key, 0)
    try:
        return int(raw or 0)
    except (TypeError, ValueError):
        return 0


__all__ = [
    "_DEFAULT_PROVIDER_INVOKE_PORT",
    "_DEFAULT_PROVIDER_INVOKE_TOKEN_TTL_SECONDS",
    "_MAX_PROVIDER_INVOKE_BODY_BYTES",
    "_PROVIDER_INVOKE_FORBIDDEN_HEADERS",
    "_PROVIDER_INVOKE_METHODS",
    "_as_provider_safe_error",
    "_as_safe_error",
    "_aws_port_scopes",
    "_clone_provider_session",
    "_clone_provider_token",
    "_clone_query_values",
    "_clone_session_record",
    "_clone_session_registry_record",
    "_clone_session_spec",
    "_clone_session_token_metadata_list",
    "_coerce_body_bytes",
    "_coerce_controller_command",
    "_coerce_controller_contract",
    "_coerce_session_registry_contract",
    "_controller_auth_defaults_deny",
    "_controller_error_response",
    "_controller_query_input",
    "_ensure_provider_token_result",
    "_fake_provider_error",
    "_header_values",
    "_load_aws_lambda_microvm_provider_client",
    "_normalize_auth_context",
    "_normalize_command",
    "_normalize_controller_request",
    "_normalize_provider_binding",
    "_normalize_provider_idle_policy",
    "_normalize_provider_invoke_input",
    "_normalize_provider_invoke_path",
    "_normalize_provider_list_input",
    "_normalize_provider_port_scope",
    "_normalize_provider_run_input",
    "_normalize_provider_session",
    "_normalize_provider_session_input",
    "_normalize_provider_state",
    "_normalize_provider_token",
    "_normalize_provider_token_input",
    "_normalize_session_list_input",
    "_normalize_session_reconstruction_request",
    "_normalize_session_record",
    "_normalize_session_registry_key",
    "_normalize_session_registry_record",
    "_normalize_session_status",
    "_normalize_session_token_metadata",
    "_normalize_string_list",
    "_number_field",
    "_provider_egress_connectors",
    "_provider_expiration_minutes",
    "_provider_invoke_port_header",
    "_provider_invoke_response_is_base64",
    "_provider_invoke_url",
    "_provider_key",
    "_provider_list_output_from_sdk",
    "_provider_session_from_get_output",
    "_provider_session_from_run_output",
    "_provider_session_from_state",
    "_provider_token_metadata",
    "_provider_token_scope",
    "_random_microvm_session_id",
    "_real_controller_commands",
    "_registry_key_tuple",
    "_registry_record_key",
    "_required_controller_commands",
    "_required_session_registry_contract_fields",
    "_response_from_session",
    "_response_from_status",
    "_safe_provider_token_id",
    "_safe_run_hook_payload",
    "_sanitize_provider_invoke_headers",
    "_session_record_from_registry_no_validate",
    "_session_record_is_stale",
    "_session_registry_operation_error",
    "_string_field",
    "_time_field",
    "_valid_lifecycle_state",
    "_valid_microvm_command",
    "_validate_provider_access",
    "_validate_provider_binding",
    "_validate_provider_invoke_input",
    "_validate_provider_list_input",
    "_validate_provider_operation",
    "_validate_provider_port_scope",
    "_validate_provider_run_input",
    "_validate_provider_session_input",
    "_validate_provider_token_input",
    "_validate_safe_connector_refs",
    "validate_microvm_provider_invoke_input",
    "validate_microvm_provider_list_input",
    "validate_microvm_provider_run_input",
    "validate_microvm_provider_session",
    "validate_microvm_provider_session_input",
    "validate_microvm_provider_token",
    "validate_microvm_provider_token_input",
]
