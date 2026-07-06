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


def default_microvm_controller_contract() -> MicroVMControllerContract:
    return MicroVMControllerContract(
        auth=MicroVMControllerAuthContract(required=True, default=MICROVM_CONTROLLER_AUTH_DEFAULT_DENY),
        envelope=MicroVMControllerEnvelopeContract(
            required_fields=["command", "request_id", "tenant_id", "auth_context"],
            safe_error_fields=["code", "message", "request_id"],
            forbidden_fields=["aws_access_key_id", "aws_secret_access_key", "raw_sdk_client", "bearer_token"],
        ),
        commands=[
            MicroVMControllerCommandContract(
                COMMAND_CREATE,
                "POST",
                "/microvms",
                ["image_ref", "network_connector_ref", "session_spec"],
                ["session_id", "state", "registry_version", "endpoint", "microvm_id", "last_action"],
            ),
            MicroVMControllerCommandContract(
                COMMAND_START,
                "POST",
                "/microvms/{session_id}/start",
                ["session_id"],
                ["session_id", "state", "desired_state", "endpoint", "microvm_id", "last_action"],
            ),
            MicroVMControllerCommandContract(
                COMMAND_STOP,
                "POST",
                "/microvms/{session_id}/stop",
                ["session_id"],
                ["session_id", "state", "desired_state", "endpoint", "microvm_id", "last_action"],
            ),
            MicroVMControllerCommandContract(
                COMMAND_STATUS,
                "GET",
                "/microvms/{session_id}/status",
                ["session_id"],
                [
                    "session_id",
                    "state",
                    "lifecycle_state",
                    "last_transition",
                    "endpoint",
                    "microvm_id",
                    "last_action",
                ],
            ),
            MicroVMControllerCommandContract(
                COMMAND_SESSION,
                "GET",
                "/microvms/{session_id}",
                ["session_id"],
                [
                    "session_id",
                    "tenant_id",
                    "namespace",
                    "state",
                    "registry_version",
                    "endpoint",
                    "microvm_id",
                    "last_action",
                ],
            ),
        ],
    )


def default_microvm_session_registry_contract() -> MicroVMSessionRegistryContract:
    return MicroVMSessionRegistryContract(
        pattern="tabletheory-single-table",
        tenant_binding=["tenant_id", "namespace"],
        required_fields=[
            "pk",
            "sk",
            "tenant_id",
            "namespace",
            "session_id",
            "state",
            "desired_state",
            "endpoint",
            "microvm_id",
            "provider_id",
            "provider_microvm_id",
            "provider_state",
            "aws_lifecycle_state",
            "image_ref",
            "image_version",
            "network_connector_ref",
            "ingress_network_connector_refs",
            "egress_network_connector_refs",
            "controller_id",
            "created_at",
            "updated_at",
            "last_observed_at",
            "provider_started_at",
            "provider_terminated_at",
            "expires_at",
            "ttl",
            "generation",
            "version",
            "last_action",
            "last_command_id",
            "auth_subject",
            "reason_metadata",
            "status_metadata",
            "token_metadata",
        ],
        state_values=_required_lifecycle_states(),
        forbidden_fields=[
            "raw_aws_credentials",
            "raw_lifecycle_hook_payload",
            "bearer_token",
            "session_token_plaintext",
            "x-aws-proxy-auth",
            "raw_provider_exception",
            "account_wide_list_token",
        ],
    )


def validate_microvm_controller_contract(contract: MicroVMControllerContract | dict[str, Any]) -> None:
    coerced = _coerce_controller_contract(contract)
    if not _controller_auth_defaults_deny(coerced.auth):
        raise _safe_error(
            MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
            "apptheory: microvm controller must default to authenticated deny",
            "",
        )
    missing_envelope = _missing_strings(
        ["command", "request_id", "tenant_id", "auth_context"], coerced.envelope.required_fields
    )
    if missing_envelope:
        raise _safe_error(
            MICROVM_ERROR_CONTROLLER_INCOMPLETE,
            f"apptheory: microvm controller envelope missing fields: {','.join(missing_envelope)}",
            "",
        )
    missing_safe_error = _missing_strings(["code", "message", "request_id"], coerced.envelope.safe_error_fields)
    if missing_safe_error:
        raise _safe_error(
            MICROVM_ERROR_CONTROLLER_INCOMPLETE,
            f"apptheory: microvm controller safe error missing fields: {','.join(missing_safe_error)}",
            "",
        )
    missing_forbidden = _missing_strings(["raw_sdk_client", "bearer_token"], coerced.envelope.forbidden_fields)
    if missing_forbidden:
        raise _safe_error(
            MICROVM_ERROR_CONTROLLER_INCOMPLETE,
            f"apptheory: microvm controller envelope missing forbidden fields: {','.join(missing_forbidden)}",
            "",
        )
    commands: dict[str, MicroVMControllerCommandContract] = {}
    for command in coerced.commands:
        name = _normalize_command(command.name)
        if not name or not str(command.method or "").strip() or not str(command.path or "").strip():
            raise _safe_error(
                MICROVM_ERROR_CONTROLLER_INCOMPLETE,
                "apptheory: microvm controller commands must define name, method, and path",
                "",
            )
        if not command.request_fields or not command.response_fields:
            raise _safe_error(
                MICROVM_ERROR_CONTROLLER_INCOMPLETE,
                f"apptheory: microvm controller command {name} must define request and response fields",
                "",
            )
        commands[name] = command
    for required in _required_controller_commands():
        if required not in commands:
            raise _safe_error(
                MICROVM_ERROR_CONTROLLER_INCOMPLETE,
                f"apptheory: microvm controller missing command: {required}",
                "",
            )


def validate_microvm_session_registry_contract(registry: MicroVMSessionRegistryContract | dict[str, Any]) -> None:
    coerced = _coerce_session_registry_contract(registry)
    if str(coerced.pattern or "").strip() != "tabletheory-single-table":
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session registry must use tabletheory-single-table guidance",
            "",
        )
    missing_tenant = _missing_strings(["tenant_id", "namespace"], coerced.tenant_binding)
    if missing_tenant:
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            f"apptheory: microvm session registry missing tenant binding: {','.join(missing_tenant)}",
            "",
        )
    missing_fields = _missing_strings(_required_session_registry_contract_fields(), coerced.required_fields)
    if missing_fields:
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            f"apptheory: microvm session registry missing fields: {','.join(missing_fields)}",
            "",
        )
    missing_states = _missing_strings(_required_lifecycle_states(), coerced.state_values)
    if missing_states:
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            f"apptheory: microvm session registry missing states: {','.join(missing_states)}",
            "",
        )
    missing_forbidden = _missing_strings(
        ["raw_aws_credentials", "raw_lifecycle_hook_payload", "bearer_token"], coerced.forbidden_fields
    )
    if missing_forbidden:
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            f"apptheory: microvm session registry missing forbidden fields: {','.join(missing_forbidden)}",
            "",
        )


__all__ = [
    "default_microvm_controller_contract",
    "default_microvm_session_registry_contract",
    "validate_microvm_controller_contract",
    "validate_microvm_session_registry_contract",
]
