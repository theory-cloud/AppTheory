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


class AWSLambdaMicroVMProvider:
    def __init__(self, *, region_name: str | None = None, clock: Callable[[], float] | None = None) -> None:
        self._client = _load_aws_lambda_microvm_provider_client(region_name=region_name)
        self._clock = clock or time.time

    def run(self, input_: MicroVMProviderRunInput | dict[str, Any]) -> MicroVMProviderSession:
        normalized = _validate_provider_run_input(input_)
        try:
            payload: dict[str, Any] = {
                "imageIdentifier": normalized.image_ref,
                "clientToken": normalized.request_id,
                "runHookPayload": _safe_run_hook_payload(normalized),
            }
            egress = _provider_egress_connectors(normalized)
            if egress:
                payload["egressNetworkConnectors"] = egress
            if normalized.execution_role_arn:
                payload["executionRoleArn"] = normalized.execution_role_arn
            if normalized.ingress_network_connector_refs:
                payload["ingressNetworkConnectors"] = list(normalized.ingress_network_connector_refs)
            if normalized.image_version:
                payload["imageVersion"] = normalized.image_version
            if normalized.idle_policy is not None:
                payload["idlePolicy"] = {
                    "autoResumeEnabled": normalized.idle_policy.auto_resume_enabled,
                    "maxIdleDurationSeconds": normalized.idle_policy.max_idle_duration_seconds,
                    "suspendedDurationSeconds": normalized.idle_policy.suspended_duration_seconds,
                }
            if normalized.maximum_duration_seconds > 0:
                payload["maximumDurationInSeconds"] = normalized.maximum_duration_seconds
            output = self._client.run_microvm(**payload)
            return _provider_session_from_run_output(normalized, output)
        except Exception as exc:  # noqa: BLE001
            raise _as_provider_safe_error(exc, normalized.request_id) from None

    def get(self, input_: MicroVMProviderSessionInput | dict[str, Any]) -> MicroVMProviderSession:
        normalized = _validate_provider_session_input(OPERATION_GET, input_)
        try:
            output = self._client.get_microvm(microvmIdentifier=normalized.binding.provider_microvm_id)
            return _provider_session_from_get_output(normalized.request_id, normalized.binding, output)
        except Exception as exc:  # noqa: BLE001
            raise _as_provider_safe_error(exc, normalized.request_id) from None

    def list(self, input_: MicroVMProviderListInput | dict[str, Any]) -> MicroVMProviderListOutput:
        normalized = _validate_provider_list_input(input_)
        try:
            payload: dict[str, Any] = {}
            if normalized.image_ref:
                payload["imageIdentifier"] = normalized.image_ref
            if normalized.image_version:
                payload["imageVersion"] = normalized.image_version
            if normalized.max_results > 0:
                payload["maxResults"] = normalized.max_results
            output = self._client.list_microvms(**payload)
            return _provider_list_output_from_sdk(normalized, output)
        except Exception as exc:  # noqa: BLE001
            raise _as_provider_safe_error(exc, normalized.request_id) from None

    def suspend(self, input_: MicroVMProviderSessionInput | dict[str, Any]) -> MicroVMProviderSession:
        return self._state_changing_operation(OPERATION_SUSPEND, input_, self._client.suspend_microvm)

    def resume(self, input_: MicroVMProviderSessionInput | dict[str, Any]) -> MicroVMProviderSession:
        return self._state_changing_operation(OPERATION_RESUME, input_, self._client.resume_microvm)

    def terminate(self, input_: MicroVMProviderSessionInput | dict[str, Any]) -> MicroVMProviderSession:
        return self._state_changing_operation(OPERATION_TERMINATE, input_, self._client.terminate_microvm)

    def create_auth_token(self, input_: MicroVMProviderTokenInput | dict[str, Any]) -> MicroVMProviderToken:
        normalized = _validate_provider_token_input(OPERATION_AUTH_TOKEN, input_)
        try:
            output = self._client.create_microvm_auth_token(
                microvmIdentifier=normalized.binding.provider_microvm_id,
                expirationInMinutes=_provider_expiration_minutes(normalized.ttl_seconds),
                allowedPorts=_aws_port_scopes(normalized.allowed_port_scope),
            )
            _ensure_provider_token_result(output, normalized.request_id)
            return _provider_token_metadata(OPERATION_AUTH_TOKEN, normalized, self._now())
        except Exception as exc:  # noqa: BLE001
            raise _as_provider_safe_error(exc, normalized.request_id) from None

    def create_shell_token(self, input_: MicroVMProviderTokenInput | dict[str, Any]) -> MicroVMProviderToken:
        normalized = _validate_provider_token_input(OPERATION_SHELL_TOKEN, input_)
        try:
            output = self._client.create_microvm_shell_auth_token(
                microvmIdentifier=normalized.binding.provider_microvm_id,
                expirationInMinutes=_provider_expiration_minutes(normalized.ttl_seconds),
            )
            _ensure_provider_token_result(output, normalized.request_id)
            return _provider_token_metadata(OPERATION_SHELL_TOKEN, normalized, self._now())
        except Exception as exc:  # noqa: BLE001
            raise _as_provider_safe_error(exc, normalized.request_id) from None

    def _state_changing_operation(
        self,
        operation: str,
        input_: MicroVMProviderSessionInput | dict[str, Any],
        run: Callable[..., Any],
    ) -> MicroVMProviderSession:
        normalized = _validate_provider_session_input(operation, input_)
        try:
            run(microvmIdentifier=normalized.binding.provider_microvm_id)
            output = self._client.get_microvm(microvmIdentifier=normalized.binding.provider_microvm_id)
            return _provider_session_from_get_output(normalized.request_id, normalized.binding, output)
        except Exception as exc:  # noqa: BLE001
            raise _as_provider_safe_error(exc, normalized.request_id) from None

    def _now(self) -> float:
        value = float(self._clock() or 0.0)
        return value if value >= 0 else 0.0


def create_aws_lambda_microvm_provider(
    *, region_name: str | None = None, clock: Callable[[], float] | None = None
) -> AWSLambdaMicroVMProvider:
    return AWSLambdaMicroVMProvider(region_name=region_name, clock=clock)


class AWSLambdaMicroVMClient:
    def __init__(self, *, region_name: str | None = None) -> None:
        _ = region_name
        raise _safe_error(
            MICROVM_ERROR_CONTROLLER_INCOMPLETE,
            "apptheory: microvm legacy AWS session client is unsupported by the official Lambda MicroVM SDK",
            "",
        )


def create_aws_lambda_microvm_client(*, region_name: str | None = None) -> AWSLambdaMicroVMClient:
    return AWSLambdaMicroVMClient(region_name=region_name)


__all__ = [
    "AWSLambdaMicroVMClient",
    "AWSLambdaMicroVMProvider",
    "create_aws_lambda_microvm_client",
    "create_aws_lambda_microvm_provider",
]
