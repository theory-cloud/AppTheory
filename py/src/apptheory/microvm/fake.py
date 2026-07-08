from __future__ import annotations

import hashlib
import json as jsonlib
import os
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Literal, cast

from .controller import *  # noqa: F403

# ruff: noqa: F401,F405
from .foundation import *  # noqa: F403
from .model import *  # noqa: F403
from .session import *  # noqa: F403
from .shared import *  # noqa: F403


class FakeMicroVMClient:
    def __init__(self, now: float = 1.0) -> None:
        self._now = float(now or 1.0)
        self._sessions: dict[tuple[str, str, str], MicroVMSessionRecord] = {}
        self._calls: list[MicroVMClientCall] = []

    def set_now(self, now: float) -> None:
        if float(now or 0) > 0:
            self._now = float(now)

    def calls(self) -> list[MicroVMClientCall]:
        return [
            MicroVMClientCall(call.command, call.request_id, call.tenant_id, call.namespace, call.session_id)
            for call in self._calls
        ]

    def create(self, input_: MicroVMCreateSessionInput) -> MicroVMSessionRecord:
        self._record_call(COMMAND_CREATE, input_.request_id, input_.tenant_id, input_.namespace, input_.session_id)
        now = float(input_.now or self._now or 1.0)
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
            expires_at=now + 3600,
            generation=1,
            last_action=COMMAND_CREATE,
            last_command_id=input_.request_id,
            auth_subject=input_.auth_subject,
            metadata=_clone_string_map(input_.session_spec.metadata),
        )
        validate_microvm_session_record(record)
        key = microvm_session_key(record)
        if key in self._sessions:
            raise RuntimeError("session already exists")
        self._sessions[key] = _clone_session_record(record)
        return _clone_session_record(record)

    def start(self, input_: MicroVMSessionCommandInput) -> MicroVMSessionRecord:
        return self._transition(input_, COMMAND_START, STATE_STARTING, STATE_STARTED)

    def stop(self, input_: MicroVMSessionCommandInput) -> MicroVMSessionRecord:
        return self._transition(input_, COMMAND_STOP, STATE_STOPPING, STATE_STOPPED)

    def status(self, input_: MicroVMSessionQueryInput) -> MicroVMSessionStatus:
        self._record_call(COMMAND_STATUS, input_.request_id, input_.tenant_id, input_.namespace, input_.session_id)
        record = self._lookup(input_.tenant_id, input_.namespace, input_.session_id)
        return MicroVMSessionStatus(
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

    def session(self, input_: MicroVMSessionQueryInput) -> MicroVMSessionRecord:
        self._record_call(COMMAND_SESSION, input_.request_id, input_.tenant_id, input_.namespace, input_.session_id)
        return _clone_session_record(self._lookup(input_.tenant_id, input_.namespace, input_.session_id))

    def _transition(
        self, input_: MicroVMSessionCommandInput, command: str, state: str, desired: str
    ) -> MicroVMSessionRecord:
        self._record_call(command, input_.request_id, input_.tenant_id, input_.namespace, input_.session_id)
        record = self._lookup(input_.tenant_id, input_.namespace, input_.session_id)
        next_record = _clone_session_record(record)
        next_record.state = state
        next_record.desired_state = desired
        next_record.provider_id = next_record.provider_id or MICROVM_DEFAULT_SESSION_PROVIDER_ID
        next_record.provider_microvm_id = next_record.provider_microvm_id or next_record.session_id
        next_record.provider_state = state
        next_record.aws_lifecycle_state = state
        next_record.controller_id = input_.controller_id
        next_record.auth_subject = input_.auth_subject
        next_record.last_action = command
        next_record.last_command_id = input_.request_id
        next_record.updated_at = float(input_.now or self._now or 1.0)
        next_record.last_observed_at = next_record.updated_at
        next_record.generation += 1
        validate_microvm_session_record(next_record)
        self._sessions[microvm_session_key(next_record)] = _clone_session_record(next_record)
        return _clone_session_record(next_record)

    def _lookup(self, tenant_id: str, namespace: str, session_id: str) -> MicroVMSessionRecord:
        key = (str(tenant_id).strip(), str(namespace).strip(), str(session_id).strip())
        if key not in self._sessions:
            raise RuntimeError("session not found")
        return _clone_session_record(self._sessions[key])

    def _record_call(self, command: str, request_id: str, tenant_id: str, namespace: str, session_id: str) -> None:
        self._calls.append(MicroVMClientCall(command, request_id, tenant_id, namespace, session_id))


def create_fake_microvm_client(now: float = 1.0) -> FakeMicroVMClient:
    return FakeMicroVMClient(now=now)


_DEFAULT_PROVIDER_TOKEN_TTL_SECONDS = 900
_MIN_PROVIDER_TOKEN_TTL_SECONDS = 1
_MAX_PROVIDER_TOKEN_TTL_SECONDS = 900


class FakeMicroVMProvider:
    def __init__(self, now: float = 0.0) -> None:
        self._now = float(now or 0.0)
        self._next = 0
        self._tokens = 0
        self._sessions: dict[tuple[str, str, str], MicroVMProviderSession] = {}
        self._errors: dict[str, MicroVMSafeError] = {}
        self._calls: list[MicroVMProviderCall] = []

    def set_now(self, now: float) -> None:
        if float(now or 0.0) >= 0:
            self._now = float(now)

    def set_operation_error(self, operation: str, error: MicroVMSafeError | None = None) -> None:
        normalized = _normalize_operation(operation)
        if normalized not in set(_required_operations()):
            return
        if error is None:
            self._errors.pop(normalized, None)
            return
        self._errors[normalized] = error

    def calls(self) -> list[MicroVMProviderCall]:
        return [
            MicroVMProviderCall(c.operation, c.request_id, c.tenant_id, c.namespace, c.session_id) for c in self._calls
        ]

    def run(self, input_: MicroVMProviderRunInput | dict[str, Any]) -> MicroVMProviderSession:
        normalized = _validate_provider_run_input(input_)
        self._record(
            OPERATION_RUN, normalized.request_id, normalized.tenant_id, normalized.namespace, normalized.session_id
        )
        if err := self._configured_error(OPERATION_RUN, normalized.request_id):
            raise err
        key = _provider_key(normalized.tenant_id, normalized.namespace, normalized.session_id)
        if key in self._sessions:
            raise _fake_provider_error(normalized.request_id)
        self._next += 1
        session = MicroVMProviderSession(
            tenant_id=normalized.tenant_id,
            namespace=normalized.namespace,
            session_id=normalized.session_id,
            provider_microvm_id=f"microvm-{self._next:06d}",
            state=STATE_RUNNING,
            provider_state="running",
            terminal=False,
            endpoint=f"https://microvm-{self._next:06d}.example.test",
            image_ref=normalized.image_ref,
            image_version=normalized.image_version,
            started_at=self._now,
            registry_version=self._next,
        )
        validate_microvm_provider_session(session)
        self._sessions[key] = _clone_provider_session(session)
        return _clone_provider_session(session)

    def get(self, input_: MicroVMProviderSessionInput | dict[str, Any]) -> MicroVMProviderSession:
        return self._lookup(OPERATION_GET, input_)

    def list(self, input_: MicroVMProviderListInput | dict[str, Any]) -> MicroVMProviderListOutput:
        normalized = _validate_provider_list_input(input_)
        self._record(OPERATION_LIST, normalized.request_id, normalized.tenant_id, normalized.namespace, "")
        if err := self._configured_error(OPERATION_LIST, normalized.request_id):
            raise err
        sessions = [
            _clone_provider_session(session)
            for session in self._sessions.values()
            if session.tenant_id == normalized.tenant_id
            and session.namespace == normalized.namespace
            and (not normalized.image_ref or session.image_ref == normalized.image_ref)
            and (not normalized.image_version or session.image_version == normalized.image_version)
        ]
        sessions.sort(key=lambda session: session.session_id)
        return MicroVMProviderListOutput(sessions=sessions)

    def suspend(self, input_: MicroVMProviderSessionInput | dict[str, Any]) -> MicroVMProviderSession:
        return self._transition(OPERATION_SUSPEND, input_, "suspended")

    def resume(self, input_: MicroVMProviderSessionInput | dict[str, Any]) -> MicroVMProviderSession:
        return self._transition(OPERATION_RESUME, input_, "ready")

    def terminate(self, input_: MicroVMProviderSessionInput | dict[str, Any]) -> MicroVMProviderSession:
        return self._transition(OPERATION_TERMINATE, input_, "terminated")

    def create_auth_token(self, input_: MicroVMProviderTokenInput | dict[str, Any]) -> MicroVMProviderToken:
        return self._token(OPERATION_AUTH_TOKEN, input_)

    def create_shell_token(self, input_: MicroVMProviderTokenInput | dict[str, Any]) -> MicroVMProviderToken:
        return self._token(OPERATION_SHELL_TOKEN, input_)

    def invoke(self, input_: MicroVMProviderInvokeInput | dict[str, Any]) -> MicroVMProviderInvokeOutput:
        normalized = _validate_provider_invoke_input(input_)
        self._record(
            OPERATION_INVOKE,
            normalized.request_id,
            normalized.tenant_id,
            normalized.namespace,
            normalized.binding.session_id,
        )
        if err := self._configured_error(OPERATION_INVOKE, normalized.request_id):
            raise err
        self._bound_session(normalized.request_id, normalized.binding)
        body = jsonlib.dumps(
            {
                "runtime": "fake-microvm",
                "method": normalized.method,
                "path": normalized.path,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return MicroVMProviderInvokeOutput(
            status=200,
            headers={"content-type": ["application/json; charset=utf-8"]},
            body=body,
            is_base64=False,
        )

    def _lookup(self, operation: str, input_: MicroVMProviderSessionInput | dict[str, Any]) -> MicroVMProviderSession:
        normalized = _validate_provider_session_input(operation, input_)
        self._record(
            operation,
            normalized.request_id,
            normalized.tenant_id,
            normalized.namespace,
            normalized.binding.session_id,
        )
        if err := self._configured_error(operation, normalized.request_id):
            raise err
        return self._bound_session(normalized.request_id, normalized.binding)

    def _transition(
        self, operation: str, input_: MicroVMProviderSessionInput | dict[str, Any], provider_state: str
    ) -> MicroVMProviderSession:
        normalized = _validate_provider_session_input(operation, input_)
        self._record(
            operation,
            normalized.request_id,
            normalized.tenant_id,
            normalized.namespace,
            normalized.binding.session_id,
        )
        if err := self._configured_error(operation, normalized.request_id):
            raise err
        session = self._bound_session(normalized.request_id, normalized.binding)
        state, terminal = map_microvm_provider_state(provider_state)
        session.provider_state = provider_state
        session.state = state
        session.terminal = terminal
        session.registry_version += 1
        if provider_state == "terminated":
            session.terminated_at = self._now
        validate_microvm_provider_session(session)
        self._sessions[_provider_key(session.tenant_id, session.namespace, session.session_id)] = (
            _clone_provider_session(session)
        )
        return _clone_provider_session(session)

    def _token(self, operation: str, input_: MicroVMProviderTokenInput | dict[str, Any]) -> MicroVMProviderToken:
        normalized = _validate_provider_token_input(operation, input_)
        self._record(
            operation,
            normalized.request_id,
            normalized.tenant_id,
            normalized.namespace,
            normalized.binding.session_id,
        )
        if err := self._configured_error(operation, normalized.request_id):
            raise err
        self._bound_session(normalized.request_id, normalized.binding)
        token_type = "shell" if operation == OPERATION_SHELL_TOKEN else "auth"
        ttl = normalized.ttl_seconds or _DEFAULT_PROVIDER_TOKEN_TTL_SECONDS
        self._tokens += 1
        token = MicroVMProviderToken(
            tenant_id=normalized.binding.tenant_id,
            namespace=normalized.binding.namespace,
            session_id=normalized.binding.session_id,
            provider_microvm_id=normalized.binding.provider_microvm_id,
            token_id=f"{token_type}-{self._tokens:06d}",
            token_type=token_type,
            expires_at=self._now + ttl,
            scope=_provider_token_scope(operation, normalized.allowed_port_scope),
        )
        validate_microvm_provider_token(token)
        return _clone_provider_token(token)

    def _bound_session(self, request_id: str, binding: MicroVMProviderSessionBinding) -> MicroVMProviderSession:
        key = _provider_key(binding.tenant_id, binding.namespace, binding.session_id)
        session = self._sessions.get(key)
        if session is None or session.provider_microvm_id != binding.provider_microvm_id:
            raise _safe_error(
                MICROVM_ERROR_TENANT_BINDING_VIOLATION,
                "apptheory: microvm provider binding is not available",
                request_id,
            )
        return _clone_provider_session(session)

    def _configured_error(self, operation: str, request_id: str) -> MicroVMSafeError | None:
        if operation in self._errors:
            return _fake_provider_error(request_id)
        return None

    def _record(self, operation: str, request_id: str, tenant_id: str, namespace: str, session_id: str) -> None:
        self._calls.append(
            MicroVMProviderCall(
                operation=str(operation or "").strip(),
                request_id=str(request_id or "").strip(),
                tenant_id=str(tenant_id or "").strip(),
                namespace=str(namespace or "").strip(),
                session_id=str(session_id or "").strip(),
            )
        )


def create_fake_microvm_provider(now: float = 0.0) -> FakeMicroVMProvider:
    return FakeMicroVMProvider(now=now)


__all__ = [
    "_DEFAULT_PROVIDER_TOKEN_TTL_SECONDS",
    "_MAX_PROVIDER_TOKEN_TTL_SECONDS",
    "_MIN_PROVIDER_TOKEN_TTL_SECONDS",
    "FakeMicroVMClient",
    "FakeMicroVMProvider",
    "create_fake_microvm_client",
    "create_fake_microvm_provider",
]
