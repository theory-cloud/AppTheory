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

MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER = "m15.microvm.unauthenticated_controller"
MICROVM_ERROR_CONTROLLER_INCOMPLETE = "m15.microvm.controller_incomplete"
MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE = "m15.microvm.session_registry_incomplete"
MICROVM_ERROR_INVALID_CONTROLLER_REQUEST = "m15.microvm.invalid_controller_request"
MICROVM_ERROR_CONTROLLER_COMMAND_FAILED = "m15.microvm.controller_command_failed"
MICROVM_CONTROLLER_AUTH_DEFAULT_DENY = "deny"
MICROVM_SESSION_REGISTRY_MODEL_NAME = "MicroVMSessionRegistryRecord"
MICROVM_SESSION_REGISTRY_TABLE_NAME = "apptheory-microvm-sessions"
MICROVM_SESSION_REGISTRY_TABLE_ENV = "APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE"
MICROVM_DEFAULT_SESSION_PROVIDER_ID = "apptheory.microvm.registry"
MICROVM_AWS_LAMBDA_PROVIDER_ID = "aws.lambda.microvm"

COMMAND_CREATE = "create"
COMMAND_START = "start"
COMMAND_STOP = "stop"
COMMAND_STATUS = "status"
COMMAND_SESSION = "session"
COMMAND_RUN = "run"
COMMAND_GET = "get"
COMMAND_LIST = "list"
COMMAND_SUSPEND = "suspend"
COMMAND_RESUME = "resume"
COMMAND_TERMINATE = "terminate"
COMMAND_AUTH_TOKEN = "auth-token"  # noqa: S105
COMMAND_SHELL_AUTH_TOKEN = "shell-auth-token"  # noqa: S105
COMMAND_SHELL_TOKEN = COMMAND_SHELL_AUTH_TOKEN
COMMAND_LEGACY_SHELL_TOKEN = "shell-token"  # noqa: S105

MicroVMCommand = Literal[
    "create",
    "start",
    "stop",
    "status",
    "session",
    "run",
    "get",
    "list",
    "suspend",
    "resume",
    "terminate",
    "auth-token",
    "shell-auth-token",
]


def _registry_theorydb_meta(
    name: str,
    *,
    roles: list[str] | None = None,
    omitempty: bool = False,
) -> dict[str, Any]:
    return {
        "theorydb": {
            "name": name,
            "roles": list(roles or []),
            "omitempty": bool(omitempty),
            "set": False,
            "json": False,
            "binary": False,
            "encrypted": False,
            "converter": None,
            "ignore": False,
        }
    }


def _registry_s(name: str, *, roles: list[str] | None = None, omitempty: bool = False) -> Any:
    return field(default="", metadata=_registry_theorydb_meta(name, roles=roles, omitempty=omitempty))


def _registry_n(name: str, *, roles: list[str] | None = None, omitempty: bool = False) -> Any:
    return field(default=0, metadata=_registry_theorydb_meta(name, roles=roles, omitempty=omitempty))


def _registry_f(name: str, *, omitempty: bool = False) -> Any:
    return field(default=0.0, metadata=_registry_theorydb_meta(name, omitempty=omitempty))


def _registry_m(name: str, *, omitempty: bool = False) -> Any:
    return field(default=None, metadata=_registry_theorydb_meta(name, omitempty=omitempty))


@dataclass(slots=True)
class MicroVMControllerAuthContract:
    required: bool = True
    default: str = MICROVM_CONTROLLER_AUTH_DEFAULT_DENY


@dataclass(slots=True)
class MicroVMControllerEnvelopeContract:
    required_fields: list[str] = field(default_factory=list)
    safe_error_fields: list[str] = field(default_factory=list)
    forbidden_fields: list[str] = field(default_factory=list)


@dataclass(slots=True)
class MicroVMControllerCommandContract:
    name: str
    method: str
    path: str
    request_fields: list[str] = field(default_factory=list)
    response_fields: list[str] = field(default_factory=list)


@dataclass(slots=True)
class MicroVMControllerContract:
    auth: MicroVMControllerAuthContract = field(default_factory=MicroVMControllerAuthContract)
    envelope: MicroVMControllerEnvelopeContract = field(default_factory=MicroVMControllerEnvelopeContract)
    commands: list[MicroVMControllerCommandContract] = field(default_factory=list)


@dataclass(slots=True)
class MicroVMSessionRegistryContract:
    pattern: str = ""
    tenant_binding: list[str] = field(default_factory=list)
    required_fields: list[str] = field(default_factory=list)
    state_values: list[str] = field(default_factory=list)
    forbidden_fields: list[str] = field(default_factory=list)


@dataclass(slots=True)
class MicroVMAuthContext:
    subject: str = ""
    tenant_id: str = ""
    namespace: str = ""
    entitlements: list[str] = field(default_factory=list)
    metadata: dict[str, str] | None = None


@dataclass(slots=True)
class MicroVMSessionSpec:
    metadata: dict[str, str] | None = None


@dataclass(slots=True)
class MicroVMProviderIdlePolicy:
    auto_resume_enabled: bool = False
    max_idle_duration_seconds: int = 0
    suspended_duration_seconds: int = 0


@dataclass(slots=True)
class MicroVMProviderRunInput:
    request_id: str
    tenant_id: str
    namespace: str
    session_id: str
    auth_context: MicroVMAuthContext
    image_ref: str
    image_version: str = ""
    network_connector_ref: str = ""
    ingress_network_connector_refs: list[str] = field(default_factory=list)
    egress_network_connector_refs: list[str] = field(default_factory=list)
    session_spec: MicroVMSessionSpec = field(default_factory=MicroVMSessionSpec)
    idle_policy: MicroVMProviderIdlePolicy | None = None
    maximum_duration_seconds: int = 0
    execution_role_arn: str = ""


@dataclass(slots=True)
class MicroVMProviderSessionBinding:
    tenant_id: str
    namespace: str
    session_id: str
    provider_microvm_id: str
    registry_version: int = 0


@dataclass(slots=True)
class MicroVMProviderSessionInput:
    request_id: str
    tenant_id: str
    namespace: str
    auth_context: MicroVMAuthContext
    binding: MicroVMProviderSessionBinding


@dataclass(slots=True)
class MicroVMProviderListInput:
    request_id: str
    tenant_id: str
    namespace: str
    auth_context: MicroVMAuthContext
    image_ref: str = ""
    image_version: str = ""
    max_results: int = 0
    known_sessions: list[MicroVMProviderSessionBinding] = field(default_factory=list)


@dataclass(slots=True)
class MicroVMProviderPortScope:
    all_ports: bool = False
    port: int = 0
    start_port: int = 0
    end_port: int = 0


@dataclass(slots=True)
class MicroVMProviderTokenInput:
    request_id: str
    tenant_id: str
    namespace: str
    auth_context: MicroVMAuthContext
    binding: MicroVMProviderSessionBinding
    ttl_seconds: int = 0
    allowed_port_scope: list[MicroVMProviderPortScope] = field(default_factory=list)


@dataclass(slots=True)
class MicroVMProviderSession:
    tenant_id: str
    namespace: str
    session_id: str
    provider_microvm_id: str
    state: str
    provider_state: str
    terminal: bool = False
    image_ref: str = ""
    image_version: str = ""
    started_at: float = 0.0
    terminated_at: float = 0.0
    registry_version: int = 0


@dataclass(slots=True)
class MicroVMProviderListOutput:
    sessions: list[MicroVMProviderSession] = field(default_factory=list)
    recovery_cursor: str = ""


@dataclass(slots=True)
class MicroVMProviderToken:
    tenant_id: str
    namespace: str
    session_id: str
    provider_microvm_id: str
    token_id: str
    token_type: str
    expires_at: float
    scope: list[str] = field(default_factory=list)


@dataclass(slots=True)
class MicroVMProviderCall:
    operation: str
    request_id: str
    tenant_id: str
    namespace: str
    session_id: str


@dataclass(slots=True)
class MicroVMControllerRequest:
    command: str
    request_id: str
    tenant_id: str
    namespace: str
    auth_context: MicroVMAuthContext
    session_id: str = ""
    image_ref: str = ""
    image_version: str = ""
    network_connector_ref: str = ""
    ingress_network_connector_refs: list[str] = field(default_factory=list)
    egress_network_connector_refs: list[str] = field(default_factory=list)
    session_spec: MicroVMSessionSpec = field(default_factory=MicroVMSessionSpec)
    idle_policy: MicroVMProviderIdlePolicy | None = None
    maximum_duration_seconds: int = 0
    ttl_seconds: int = 0
    allowed_port_scope: list[MicroVMProviderPortScope] = field(default_factory=list)
    max_results: int = 0


@dataclass(slots=True)
class MicroVMControllerResponse:
    command: str
    request_id: str
    tenant_id: str = ""
    namespace: str = ""
    session_id: str = ""
    state: str = ""
    desired_state: str = ""
    lifecycle_state: str = ""
    endpoint: str = ""
    microvm_id: str = ""
    provider_microvm_id: str = ""
    provider_state: str = ""
    last_action: str = ""
    last_transition: float = 0.0
    registry_version: int = 0
    sessions: list[MicroVMProviderSession] = field(default_factory=list)
    recovery_cursor: str = ""
    token_id: str = ""
    token_type: str = ""
    expires_at: float = 0.0
    scope: list[str] = field(default_factory=list)
    error: MicroVMSafeError | None = None


@dataclass(slots=True)
class MicroVMCreateSessionInput:
    request_id: str
    tenant_id: str
    namespace: str
    session_id: str
    image_ref: str
    network_connector_ref: str
    session_spec: MicroVMSessionSpec
    controller_id: str
    auth_subject: str
    now: float


@dataclass(slots=True)
class MicroVMSessionCommandInput:
    request_id: str
    tenant_id: str
    namespace: str
    session_id: str
    controller_id: str
    auth_subject: str
    desired_state: str
    now: float


@dataclass(slots=True)
class MicroVMSessionQueryInput:
    request_id: str
    tenant_id: str
    namespace: str
    session_id: str
    auth_subject: str = ""


@dataclass(slots=True)
class MicroVMSessionTokenMetadata:
    token_id: str
    token_type: str
    expires_at: float
    scope: list[str] = field(default_factory=list)


@dataclass(slots=True)
class MicroVMSessionRecord:
    tenant_id: str
    namespace: str
    session_id: str
    state: str
    desired_state: str
    image_ref: str
    controller_id: str
    created_at: float
    updated_at: float
    expires_at: float
    generation: int
    last_command_id: str
    auth_subject: str
    network_connector_ref: str = ""
    endpoint: str = ""
    microvm_id: str = ""
    provider_id: str = MICROVM_DEFAULT_SESSION_PROVIDER_ID
    provider_microvm_id: str = ""
    provider_state: str = ""
    aws_lifecycle_state: str = ""
    image_version: str = ""
    ingress_network_connector_refs: list[str] = field(default_factory=list)
    egress_network_connector_refs: list[str] = field(default_factory=list)
    last_observed_at: float = 0.0
    provider_started_at: float = 0.0
    provider_terminated_at: float = 0.0
    last_action: str = ""
    reason_metadata: dict[str, str] | None = None
    status_metadata: dict[str, str] | None = None
    token_metadata: list[MicroVMSessionTokenMetadata] = field(default_factory=list)
    metadata: dict[str, str] | None = None


@dataclass(slots=True)
class MicroVMSessionStatus:
    tenant_id: str
    namespace: str
    session_id: str
    state: str
    desired_state: str
    lifecycle_state: str
    last_transition: float
    registry_version: int
    endpoint: str = ""
    microvm_id: str = ""
    last_action: str = ""


@dataclass(slots=True)
class MicroVMSessionRegistryRecord:
    pk: str = _registry_s("pk", roles=["pk"])
    sk: str = _registry_s("sk", roles=["sk"])
    tenant_id: str = _registry_s("tenant_id")
    namespace: str = _registry_s("namespace")
    session_id: str = _registry_s("session_id")
    state: str = _registry_s("state")
    desired_state: str = _registry_s("desired_state")
    endpoint: str = _registry_s("endpoint", omitempty=True)
    microvm_id: str = _registry_s("microvm_id", omitempty=True)
    provider_id: str = _registry_s("provider_id")
    provider_microvm_id: str = _registry_s("provider_microvm_id", omitempty=True)
    provider_state: str = _registry_s("provider_state")
    aws_lifecycle_state: str = _registry_s("aws_lifecycle_state")
    image_ref: str = _registry_s("image_ref")
    image_version: str = _registry_s("image_version", omitempty=True)
    network_connector_ref: str = _registry_s("network_connector_ref")
    ingress_network_connector_refs: list[str] = field(
        default_factory=list,
        metadata=_registry_theorydb_meta("ingress_network_connector_refs", omitempty=True),
    )
    egress_network_connector_refs: list[str] = field(
        default_factory=list,
        metadata=_registry_theorydb_meta("egress_network_connector_refs", omitempty=True),
    )
    controller_id: str = _registry_s("controller_id")
    created_at: float = _registry_f("created_at")
    updated_at: float = _registry_f("updated_at")
    last_observed_at: float = _registry_f("last_observed_at")
    provider_started_at: float = _registry_f("provider_started_at", omitempty=True)
    provider_terminated_at: float = _registry_f("provider_terminated_at", omitempty=True)
    expires_at: float = _registry_f("expires_at")
    ttl: int = _registry_n("ttl", roles=["ttl"])
    generation: int = _registry_n("generation")
    version: int = _registry_n("version", roles=["version"])
    last_action: str = _registry_s("last_action")
    last_command_id: str = _registry_s("last_command_id")
    auth_subject: str = _registry_s("auth_subject")
    reason_metadata: dict[str, str] | None = field(
        default=None,
        metadata=_registry_theorydb_meta("reason_metadata", omitempty=True),
    )
    status_metadata: dict[str, str] | None = field(
        default=None,
        metadata=_registry_theorydb_meta("status_metadata", omitempty=True),
    )
    token_metadata: list[MicroVMSessionTokenMetadata] = field(
        default_factory=list,
        metadata=_registry_theorydb_meta("token_metadata", omitempty=True),
    )
    metadata: dict[str, str] | None = field(
        default=None,
        metadata=_registry_theorydb_meta("metadata", omitempty=True),
    )


@dataclass(slots=True)
class MicroVMSessionReconstructionRequest:
    tenant_id: str
    namespace: str
    session_id: str
    request_id: str = ""
    auth_subject: str = ""
    now: float = 0.0
    existing: MicroVMSessionRecord | None = None


@dataclass(slots=True)
class MicroVMSessionListInput:
    tenant_id: str
    namespace: str
    request_id: str = ""
    auth_subject: str = ""


type _MicroVMSessionRegistryKeyInput = (
    tuple[str, str, str] | MicroVMSessionRecord | MicroVMSessionRegistryRecord | dict[str, Any]
)


@dataclass(slots=True)
class MicroVMClientCall:
    command: str
    request_id: str
    tenant_id: str
    namespace: str
    session_id: str


__all__ = [
    "COMMAND_AUTH_TOKEN",
    "COMMAND_CREATE",
    "COMMAND_GET",
    "COMMAND_LEGACY_SHELL_TOKEN",
    "COMMAND_LIST",
    "COMMAND_RESUME",
    "COMMAND_RUN",
    "COMMAND_SESSION",
    "COMMAND_SHELL_AUTH_TOKEN",
    "COMMAND_SHELL_TOKEN",
    "COMMAND_START",
    "COMMAND_STATUS",
    "COMMAND_STOP",
    "COMMAND_SUSPEND",
    "COMMAND_TERMINATE",
    "MICROVM_AWS_LAMBDA_PROVIDER_ID",
    "MICROVM_CONTROLLER_AUTH_DEFAULT_DENY",
    "MICROVM_DEFAULT_SESSION_PROVIDER_ID",
    "MICROVM_ERROR_CONTROLLER_COMMAND_FAILED",
    "MICROVM_ERROR_CONTROLLER_INCOMPLETE",
    "MICROVM_ERROR_INVALID_CONTROLLER_REQUEST",
    "MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE",
    "MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER",
    "MICROVM_SESSION_REGISTRY_MODEL_NAME",
    "MICROVM_SESSION_REGISTRY_TABLE_ENV",
    "MICROVM_SESSION_REGISTRY_TABLE_NAME",
    "MicroVMAuthContext",
    "MicroVMClientCall",
    "MicroVMCommand",
    "MicroVMControllerAuthContract",
    "MicroVMControllerCommandContract",
    "MicroVMControllerContract",
    "MicroVMControllerEnvelopeContract",
    "MicroVMControllerRequest",
    "MicroVMControllerResponse",
    "MicroVMCreateSessionInput",
    "MicroVMProviderCall",
    "MicroVMProviderIdlePolicy",
    "MicroVMProviderListInput",
    "MicroVMProviderListOutput",
    "MicroVMProviderPortScope",
    "MicroVMProviderRunInput",
    "MicroVMProviderSession",
    "MicroVMProviderSessionBinding",
    "MicroVMProviderSessionInput",
    "MicroVMProviderToken",
    "MicroVMProviderTokenInput",
    "MicroVMSessionCommandInput",
    "MicroVMSessionListInput",
    "MicroVMSessionQueryInput",
    "MicroVMSessionReconstructionRequest",
    "MicroVMSessionRecord",
    "MicroVMSessionRegistryContract",
    "MicroVMSessionRegistryRecord",
    "MicroVMSessionSpec",
    "MicroVMSessionStatus",
    "MicroVMSessionTokenMetadata",
    "_registry_f",
    "_registry_m",
    "_registry_n",
    "_registry_s",
    "_registry_theorydb_meta",
]
