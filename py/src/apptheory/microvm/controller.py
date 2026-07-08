from __future__ import annotations

import hashlib
import json as jsonlib
import os
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Literal, cast

from .contracts import *  # noqa: F403

# ruff: noqa: F401,F405
from .foundation import *  # noqa: F403
from .model import *  # noqa: F403
from .registry import *  # noqa: F403
from .session import *  # noqa: F403
from .shared import *  # noqa: F403


class MicroVMController:
    def __init__(
        self,
        client: Any,
        *,
        controller_id: str = "apptheory-microvm-controller",
        clock: Callable[[], float] | None = None,
        id_generator: Callable[[], str] | None = None,
    ) -> None:
        if client is None:
            raise _safe_error(
                MICROVM_ERROR_CONTROLLER_INCOMPLETE,
                "apptheory: microvm controller requires a constrained client",
                "",
            )
        self._client = client
        self._controller_id = str(controller_id or "").strip() or "apptheory-microvm-controller"
        self._clock = clock or (lambda: 1.0)
        self._ids = id_generator or _random_microvm_session_id

    def handle(self, request: MicroVMControllerRequest | dict[str, Any]) -> MicroVMControllerResponse:
        normalized = _normalize_controller_request(request)
        validation_err = validate_microvm_controller_request(normalized)
        if validation_err:
            return _controller_error_response(normalized, validation_err)
        match normalized.command:
            case "create":
                return self._handle_create(normalized)
            case "start":
                return self._handle_command(normalized, STATE_STARTED, self._client.start)
            case "stop":
                return self._handle_command(normalized, STATE_STOPPED, self._client.stop)
            case "status":
                return self._handle_status(normalized)
            case "session":
                return self._handle_session(normalized)
            case _:
                err = _safe_error(
                    MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
                    "apptheory: microvm controller command is unsupported",
                    normalized.request_id,
                )
                return _controller_error_response(normalized, err)

    def _handle_create(self, request: MicroVMControllerRequest) -> MicroVMControllerResponse:
        session_id = str(request.session_id or "").strip() or str(self._ids() or "").strip()
        if not session_id:
            err = _safe_error(
                MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
                "apptheory: microvm controller could not allocate session id",
                request.request_id,
            )
            return _controller_error_response(request, err)
        try:
            record = self._client.create(
                MicroVMCreateSessionInput(
                    request_id=request.request_id,
                    tenant_id=request.tenant_id,
                    namespace=request.namespace,
                    session_id=session_id,
                    image_ref=request.image_ref,
                    network_connector_ref=request.network_connector_ref,
                    session_spec=_clone_session_spec(request.session_spec),
                    controller_id=self._controller_id,
                    auth_subject=request.auth_context.subject,
                    now=float(self._clock()),
                )
            )
            validate_microvm_session_record(record)
            return _response_from_session(request, record)
        except Exception as exc:  # noqa: BLE001
            return _controller_error_response(request, _as_safe_error(exc, request.request_id))

    def _handle_command(
        self,
        request: MicroVMControllerRequest,
        desired: str,
        run: Callable[[MicroVMSessionCommandInput], MicroVMSessionRecord],
    ) -> MicroVMControllerResponse:
        try:
            record = run(
                MicroVMSessionCommandInput(
                    request_id=request.request_id,
                    tenant_id=request.tenant_id,
                    namespace=request.namespace,
                    session_id=request.session_id,
                    controller_id=self._controller_id,
                    auth_subject=request.auth_context.subject,
                    desired_state=desired,
                    now=float(self._clock()),
                )
            )
            validate_microvm_session_record(record)
            return _response_from_session(request, record)
        except Exception as exc:  # noqa: BLE001
            return _controller_error_response(request, _as_safe_error(exc, request.request_id))

    def _handle_status(self, request: MicroVMControllerRequest) -> MicroVMControllerResponse:
        try:
            status = self._client.status(_controller_query_input(request))
            validate_microvm_session_status(status)
            return _response_from_status(request, status)
        except Exception as exc:  # noqa: BLE001
            return _controller_error_response(request, _as_safe_error(exc, request.request_id))

    def _handle_session(self, request: MicroVMControllerRequest) -> MicroVMControllerResponse:
        try:
            record = self._client.session(_controller_query_input(request))
            validate_microvm_session_record(record)
            return _response_from_session(request, record)
        except Exception as exc:  # noqa: BLE001
            return _controller_error_response(request, _as_safe_error(exc, request.request_id))


def create_microvm_controller(client: Any, **kwargs: Any) -> MicroVMController:
    return MicroVMController(client, **kwargs)


class MicroVMRealController:
    def __init__(
        self,
        provider: Any,
        registry: Any,
        *,
        controller_id: str = "apptheory-microvm-controller",
        provider_id: str = MICROVM_AWS_LAMBDA_PROVIDER_ID,
        clock: Callable[[], float] | None = None,
        id_generator: Callable[[], str] | None = None,
        ttl_seconds: int = 3600,
        execution_role_arn: str | None = None,
        deployment_defaults: MicroVMControllerDeploymentDefaults | dict[str, Any] | None = None,
    ) -> None:
        if provider is None:
            raise _safe_error(
                MICROVM_ERROR_CONTROLLER_INCOMPLETE,
                "apptheory: microvm controller requires a provider adapter",
                "",
            )
        if registry is None:
            raise _safe_error(
                MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                "apptheory: microvm controller requires a session registry",
                "",
            )
        self._provider = provider
        self._registry = registry
        self._controller_id = str(controller_id or "").strip() or "apptheory-microvm-controller"
        self._provider_id = str(provider_id or "").strip() or MICROVM_AWS_LAMBDA_PROVIDER_ID
        raw_execution_role_arn = (
            os.environ.get(MICROVM_ENV_EXECUTION_ROLE_ARN, "") if execution_role_arn is None else execution_role_arn
        )
        self._execution_role_arn = _normalize_execution_role_arn(raw_execution_role_arn)
        if _validate_execution_role_arn(self._execution_role_arn, ""):
            raise _safe_error(
                MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
                "apptheory: microvm execution role arn is invalid",
                "",
            )
        self._clock = clock or time.time
        self._ids = id_generator or _random_microvm_session_id
        self._ttl_seconds = int(ttl_seconds or 0) if int(ttl_seconds or 0) > 0 else 3600
        self._deployment_defaults = _normalize_deployment_defaults(
            _environment_deployment_defaults() if deployment_defaults is None else deployment_defaults
        )

    def handle(self, request: MicroVMControllerRequest | dict[str, Any]) -> MicroVMControllerResponse:
        request_envelope = _normalize_controller_request(request)
        deployment_override_err = self._deployment_override_error(request_envelope)
        if deployment_override_err:
            return _controller_error_response(request_envelope, deployment_override_err)
        normalized = self._apply_deployment_defaults(request_envelope)
        validation_err = _validate_real_controller_request(normalized)
        if validation_err:
            return _controller_error_response(normalized, validation_err)
        match normalized.command:
            case "run":
                return self._handle_run(normalized)
            case "get":
                return self._handle_session(normalized, OPERATION_GET, self._provider.get)
            case "list":
                return self._handle_list(normalized)
            case "suspend":
                return self._handle_session(normalized, OPERATION_SUSPEND, self._provider.suspend)
            case "resume":
                return self._handle_session(normalized, OPERATION_RESUME, self._provider.resume)
            case "terminate":
                return self._handle_session(normalized, OPERATION_TERMINATE, self._provider.terminate)
            case "invoke":
                err = _safe_error(
                    MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
                    "apptheory: microvm invoke requires the invoke route",
                    normalized.request_id,
                )
                return _controller_error_response(normalized, err)
            case "auth-token":
                return self._handle_token(normalized, OPERATION_AUTH_TOKEN, self._provider.create_auth_token)
            case "shell-auth-token":
                return self._handle_token(normalized, OPERATION_SHELL_AUTH_TOKEN, self._provider.create_shell_token)
            case _:
                err = _safe_error(
                    MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
                    "apptheory: microvm controller command is unsupported",
                    normalized.request_id,
                )
                return _controller_error_response(normalized, err)

    def _apply_deployment_defaults(self, request: MicroVMControllerRequest) -> MicroVMControllerRequest:
        defaults = self._deployment_defaults
        out = _normalize_controller_request(request)
        if not out.image_ref:
            out.image_ref = defaults.image_ref
        if not out.ingress_network_connector_refs:
            out.ingress_network_connector_refs = list(defaults.ingress_network_connector_refs)
        if not out.egress_network_connector_refs:
            out.egress_network_connector_refs = list(defaults.egress_network_connector_refs)
        if not out.network_connector_ref:
            out.network_connector_ref = defaults.network_connector_ref
        if not out.network_connector_ref and out.egress_network_connector_refs:
            out.network_connector_ref = out.egress_network_connector_refs[0]
        return _normalize_controller_request(out)

    def _deployment_override_error(self, request: MicroVMControllerRequest) -> MicroVMSafeError | None:
        defaults = self._deployment_defaults
        if defaults.image_ref and request.image_ref and request.image_ref != defaults.image_ref:
            return _safe_error(
                MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
                "apptheory: microvm deployment-pinned image_ref mismatch",
                request.request_id,
            )
        if (
            defaults.network_connector_ref
            and request.network_connector_ref
            and request.network_connector_ref != defaults.network_connector_ref
        ):
            return _safe_error(
                MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
                "apptheory: microvm deployment-pinned network_connector_ref mismatch",
                request.request_id,
            )
        if (
            defaults.ingress_network_connector_refs
            and request.ingress_network_connector_refs
            and request.ingress_network_connector_refs != defaults.ingress_network_connector_refs
        ):
            return _safe_error(
                MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
                "apptheory: microvm deployment-pinned ingress_network_connector_refs mismatch",
                request.request_id,
            )
        if (
            defaults.egress_network_connector_refs
            and request.egress_network_connector_refs
            and request.egress_network_connector_refs != defaults.egress_network_connector_refs
        ):
            return _safe_error(
                MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
                "apptheory: microvm deployment-pinned egress_network_connector_refs mismatch",
                request.request_id,
            )
        return None

    def _handle_run(self, request: MicroVMControllerRequest) -> MicroVMControllerResponse:
        session_id = str(request.session_id or "").strip() or str(self._ids() or "").strip()
        if not session_id:
            err = _safe_error(
                MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
                "apptheory: microvm controller could not allocate session id",
                request.request_id,
            )
            return _controller_error_response(request, err)
        request.session_id = session_id
        try:
            session = self._provider.run(
                MicroVMProviderRunInput(
                    request_id=request.request_id,
                    tenant_id=request.tenant_id,
                    namespace=request.namespace,
                    session_id=request.session_id,
                    auth_context=request.auth_context,
                    image_ref=request.image_ref,
                    image_version=request.image_version,
                    network_connector_ref=request.network_connector_ref,
                    ingress_network_connector_refs=list(request.ingress_network_connector_refs),
                    egress_network_connector_refs=list(request.egress_network_connector_refs),
                    session_spec=_clone_session_spec(request.session_spec),
                    idle_policy=request.idle_policy,
                    maximum_duration_seconds=request.maximum_duration_seconds,
                    execution_role_arn=self._execution_role_arn,
                )
            )
            validate_microvm_provider_session(session)
            record = self._put_provider_session(request, session)
            return _response_from_provider_session(request, _provider_session_from_record(record))
        except Exception as exc:  # noqa: BLE001
            return _controller_error_response(request, _as_safe_error(exc, request.request_id))

    def _handle_session(
        self,
        request: MicroVMControllerRequest,
        operation: str,
        run: Callable[[MicroVMProviderSessionInput], MicroVMProviderSession],
    ) -> MicroVMControllerResponse:
        try:
            record = self._registry.get((request.tenant_id, request.namespace, request.session_id))
            validate_microvm_session_record(record)
            session = run(
                MicroVMProviderSessionInput(
                    request_id=request.request_id,
                    tenant_id=request.tenant_id,
                    namespace=request.namespace,
                    auth_context=request.auth_context,
                    binding=_provider_binding_from_record(record),
                )
            )
            validate_microvm_provider_session(session)
            request.command = _command_from_operation(operation)
            updated = self._put_provider_session(request, session, record)
            return _response_from_provider_session(request, _provider_session_from_record(updated))
        except Exception as exc:  # noqa: BLE001
            return _controller_error_response(request, _as_safe_error(exc, request.request_id))

    def _handle_list(self, request: MicroVMControllerRequest) -> MicroVMControllerResponse:
        list_fn = getattr(self._registry, "list", None)
        if not callable(list_fn):
            err = _safe_error(
                MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                "apptheory: microvm controller list requires a tenant-bound session registry lister",
                request.request_id,
            )
            return _controller_error_response(request, err)
        try:
            records = cast(
                list[MicroVMSessionRecord],
                list_fn(
                    MicroVMSessionListInput(
                        request_id=request.request_id,
                        tenant_id=request.tenant_id,
                        namespace=request.namespace,
                        auth_subject=request.auth_context.subject,
                    )
                ),
            )
            bindings: list[MicroVMProviderSessionBinding] = []
            records_by_key: dict[tuple[str, str, str], MicroVMSessionRecord] = {}
            for record in records:
                validate_microvm_session_record(record)
                binding = _provider_binding_from_record(record)
                bindings.append(binding)
                records_by_key[(binding.tenant_id, binding.namespace, binding.session_id)] = record
            out = self._provider.list(
                MicroVMProviderListInput(
                    request_id=request.request_id,
                    tenant_id=request.tenant_id,
                    namespace=request.namespace,
                    auth_context=request.auth_context,
                    image_ref=request.image_ref,
                    image_version=request.image_version,
                    max_results=request.max_results,
                    known_sessions=bindings,
                )
            )
            sessions: list[MicroVMProviderSession] = []
            for raw_session in list(out.sessions):
                session = _clone_provider_session(raw_session)
                record = records_by_key.get((session.tenant_id, session.namespace, session.session_id))
                if record is None:
                    continue
                validate_microvm_provider_session(session)
                updated = self._put_provider_session(request, session, record)
                sessions.append(_provider_session_from_record(updated))
            return MicroVMControllerResponse(
                command=request.command,
                request_id=request.request_id,
                tenant_id=request.tenant_id,
                namespace=request.namespace,
                sessions=sessions,
                recovery_cursor=str(out.recovery_cursor or "").strip(),
            )
        except Exception as exc:  # noqa: BLE001
            return _controller_error_response(request, _as_safe_error(exc, request.request_id))

    def _handle_token(
        self,
        request: MicroVMControllerRequest,
        operation: str,
        run: Callable[[MicroVMProviderTokenInput], MicroVMProviderToken],
    ) -> MicroVMControllerResponse:
        try:
            record = self._registry.get((request.tenant_id, request.namespace, request.session_id))
            validate_microvm_session_record(record)
            token = run(
                MicroVMProviderTokenInput(
                    request_id=request.request_id,
                    tenant_id=request.tenant_id,
                    namespace=request.namespace,
                    auth_context=request.auth_context,
                    binding=_provider_binding_from_record(record),
                    ttl_seconds=request.ttl_seconds,
                    allowed_port_scope=list(request.allowed_port_scope),
                )
            )
            validate_microvm_provider_token(token)
            metadata = microvm_session_token_metadata_from_provider_token(token)
            now = self._now()
            next_record = _clone_session_record(record)
            next_record.token_metadata = [*_clone_session_token_metadata_list(record.token_metadata), metadata]
            next_record.last_action = _command_from_operation(operation)
            next_record.last_command_id = request.request_id
            next_record.auth_subject = request.auth_context.subject
            next_record.updated_at = now
            next_record.last_observed_at = now
            next_record.generation += 1
            self._registry.put(next_record)
            return _response_from_provider_token(request, token)
        except Exception as exc:  # noqa: BLE001
            return _controller_error_response(request, _as_safe_error(exc, request.request_id))

    def invoke(self, request: MicroVMControllerInvokeRequest | dict[str, Any]) -> MicroVMProviderInvokeOutput:
        normalized = _normalize_controller_invoke_request(request)
        envelope = MicroVMControllerRequest(
            command=COMMAND_INVOKE,
            request_id=normalized.request_id,
            tenant_id=normalized.tenant_id,
            namespace=normalized.namespace,
            auth_context=normalized.auth_context,
            session_id=normalized.session_id,
        )
        validation_err = _validate_real_controller_request(envelope)
        if validation_err:
            raise validation_err
        try:
            record = self._registry.get((normalized.tenant_id, normalized.namespace, normalized.session_id))
            validate_microvm_session_record(record)
            if not str(record.endpoint or "").strip():
                raise _safe_error(
                    MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
                    "apptheory: microvm invoke requires a session endpoint",
                    normalized.request_id,
                )
            return self._provider.invoke(
                MicroVMProviderInvokeInput(
                    request_id=normalized.request_id,
                    tenant_id=normalized.tenant_id,
                    namespace=normalized.namespace,
                    auth_context=normalized.auth_context,
                    binding=_provider_binding_from_record(record),
                    endpoint=record.endpoint,
                    method=normalized.method,
                    path=normalized.path,
                    query=_clone_query_values(normalized.query),
                    headers=_sanitize_provider_invoke_headers(normalized.headers),
                    body=bytes(normalized.body),
                    port=normalized.port,
                    ttl_seconds=normalized.ttl_seconds,
                )
            )
        except Exception as exc:  # noqa: BLE001
            raise _as_safe_error(exc, normalized.request_id) from None

    def _put_provider_session(
        self,
        request: MicroVMControllerRequest,
        session: MicroVMProviderSession,
        existing: MicroVMSessionRecord | None = None,
    ) -> MicroVMSessionRecord:
        record = self._session_record_from_provider_session(request, session, existing)
        validate_microvm_session_record(record)
        return self._registry.put(record)

    def _session_record_from_provider_session(
        self,
        request: MicroVMControllerRequest,
        session: MicroVMProviderSession,
        existing: MicroVMSessionRecord | None = None,
    ) -> MicroVMSessionRecord:
        current = _clone_session_record(existing) if existing is not None else None
        now = self._now()
        expires_at = (
            current.expires_at if current is not None and current.expires_at > now else now + float(self._ttl_seconds)
        )
        record = MicroVMSessionRecord(
            tenant_id=session.tenant_id,
            namespace=session.namespace,
            session_id=session.session_id,
            state=session.state,
            desired_state=_desired_state_for_real_command(request.command, session.state),
            endpoint=session.endpoint or (current.endpoint if current is not None else ""),
            microvm_id=current.microvm_id if current is not None else "",
            provider_id=(current.provider_id if current is not None and current.provider_id else self._provider_id),
            provider_microvm_id=session.provider_microvm_id,
            provider_state=session.provider_state,
            aws_lifecycle_state=session.provider_state,
            image_ref=session.image_ref or request.image_ref or (current.image_ref if current is not None else ""),
            image_version=session.image_version
            or request.image_version
            or (current.image_version if current is not None else ""),
            network_connector_ref=request.network_connector_ref
            or (current.network_connector_ref if current is not None else ""),
            ingress_network_connector_refs=list(request.ingress_network_connector_refs)
            or (list(current.ingress_network_connector_refs) if current is not None else []),
            egress_network_connector_refs=list(request.egress_network_connector_refs)
            or (list(current.egress_network_connector_refs) if current is not None else []),
            controller_id=self._controller_id,
            created_at=(current.created_at if current is not None and current.created_at > 0 else now),
            updated_at=now,
            last_observed_at=now,
            provider_started_at=session.started_at or (current.provider_started_at if current is not None else 0.0),
            provider_terminated_at=session.terminated_at
            or (current.provider_terminated_at if current is not None else 0.0),
            expires_at=expires_at,
            generation=(current.generation + 1 if current is not None and current.generation > 0 else 1),
            last_action=request.command,
            last_command_id=request.request_id,
            auth_subject=request.auth_context.subject,
            token_metadata=_clone_session_token_metadata_list(current.token_metadata if current is not None else []),
            metadata=_clone_string_map(current.metadata if current is not None else request.session_spec.metadata),
        )
        return record

    def _now(self) -> float:
        try:
            value = float(self._clock() or 0.0)
        except Exception:  # noqa: BLE001
            value = 0.0
        return value if value > 0 else time.time()


def create_real_microvm_controller(provider: Any, registry: Any, **kwargs: Any) -> MicroVMRealController:
    return MicroVMRealController(provider, registry, **kwargs)


def register_microvm_controller_routes(app: Any, controller: Any) -> Any:
    if app is None:
        raise RuntimeError("apptheory: microvm controller route registration requires an app")
    if controller is None:
        raise _safe_error(
            MICROVM_ERROR_CONTROLLER_INCOMPLETE,
            "apptheory: microvm controller route registration requires a controller",
            "",
        )
    routes = [
        ("POST", "/microvms", COMMAND_RUN),
        ("GET", "/microvms", COMMAND_LIST),
        ("GET", "/microvms/{session_id}", COMMAND_GET),
        ("POST", "/microvms/{session_id}/suspend", COMMAND_SUSPEND),
        ("POST", "/microvms/{session_id}/resume", COMMAND_RESUME),
        ("DELETE", "/microvms/{session_id}", COMMAND_TERMINATE),
        ("POST", "/microvms/{session_id}/auth-token", COMMAND_AUTH_TOKEN),
        ("POST", "/microvms/{session_id}/shell-auth-token", COMMAND_SHELL_AUTH_TOKEN),
        ("POST", "/microvms/{session_id}/shell-token", COMMAND_SHELL_AUTH_TOKEN),
    ]
    for method, path, command in routes:
        app.handle_strict(method, path, _microvm_controller_route_handler(controller, command), auth_required=True)
    for method in _microvm_controller_invoke_methods():
        for path in ["/microvms/{session_id}/invoke", "/microvms/{session_id}/invoke/{proxy+}"]:
            app.handle_strict(method, path, _microvm_controller_invoke_route_handler(controller), auth_required=True)
    return app


def register_controller_routes(app: Any, controller: Any) -> Any:
    return register_microvm_controller_routes(app, controller)


def validate_microvm_controller_request(request: MicroVMControllerRequest | dict[str, Any]) -> MicroVMSafeError | None:
    normalized = _normalize_controller_request(request)
    if not normalized.command or not normalized.request_id or not normalized.tenant_id or not normalized.namespace:
        return _safe_error(
            MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
            "apptheory: microvm controller envelope is incomplete",
            normalized.request_id,
        )
    if not normalized.auth_context.subject or not normalized.auth_context.tenant_id:
        return _safe_error(
            MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
            "apptheory: microvm controller must default to authenticated deny",
            normalized.request_id,
        )
    if normalized.auth_context.tenant_id != normalized.tenant_id:
        return _safe_error(
            MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
            "apptheory: microvm controller tenant binding mismatch",
            normalized.request_id,
        )
    if normalized.auth_context.namespace and normalized.auth_context.namespace != normalized.namespace:
        return _safe_error(
            MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
            "apptheory: microvm controller namespace binding mismatch",
            normalized.request_id,
        )
    metadata_err = _validate_safe_metadata(normalized.auth_context.metadata, normalized.request_id)
    if metadata_err:
        return metadata_err
    metadata_err = _validate_safe_metadata(normalized.session_spec.metadata, normalized.request_id)
    if metadata_err:
        return metadata_err
    for value in [
        normalized.image_ref,
        normalized.image_version,
        normalized.network_connector_ref,
        *normalized.ingress_network_connector_refs,
        *normalized.egress_network_connector_refs,
    ]:
        value_err = _validate_safe_field_value(value, normalized.request_id)
        if value_err:
            return value_err
    if normalized.command == COMMAND_CREATE:
        if not normalized.image_ref or not normalized.network_connector_ref:
            return _safe_error(
                MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
                "apptheory: microvm create requires image and network connector refs",
                normalized.request_id,
            )
        return None
    if normalized.command in {COMMAND_START, COMMAND_STOP, COMMAND_STATUS, COMMAND_SESSION}:
        if not normalized.session_id:
            return _safe_error(
                MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
                "apptheory: microvm controller session_id is required",
                normalized.request_id,
            )
        return None
    return _safe_error(
        MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
        "apptheory: microvm controller command is unsupported",
        normalized.request_id,
    )


def _validate_real_controller_request(request: MicroVMControllerRequest) -> MicroVMSafeError | None:
    normalized = _normalize_controller_request(request)
    if not normalized.command or not normalized.request_id or not normalized.tenant_id or not normalized.namespace:
        return _safe_error(
            MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
            "apptheory: microvm controller envelope is incomplete",
            normalized.request_id,
        )
    if not normalized.auth_context.subject or not normalized.auth_context.tenant_id:
        return _safe_error(
            MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
            "apptheory: microvm controller must default to authenticated deny",
            normalized.request_id,
        )
    if normalized.auth_context.tenant_id != normalized.tenant_id:
        return _safe_error(
            MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
            "apptheory: microvm controller tenant binding mismatch",
            normalized.request_id,
        )
    if normalized.auth_context.namespace and normalized.auth_context.namespace != normalized.namespace:
        return _safe_error(
            MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
            "apptheory: microvm controller namespace binding mismatch",
            normalized.request_id,
        )
    for metadata in [normalized.auth_context.metadata, normalized.session_spec.metadata]:
        metadata_err = _validate_safe_metadata(metadata, normalized.request_id)
        if metadata_err:
            return metadata_err
    for value in [
        normalized.image_ref,
        normalized.image_version,
        normalized.network_connector_ref,
        *normalized.ingress_network_connector_refs,
        *normalized.egress_network_connector_refs,
    ]:
        value_err = _validate_safe_field_value(value, normalized.request_id)
        if value_err:
            return value_err
    if normalized.command == COMMAND_RUN:
        if not normalized.image_ref or not normalized.network_connector_ref:
            return _safe_error(
                MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
                "apptheory: microvm run requires image and network connector refs",
                normalized.request_id,
            )
        return None
    if normalized.command == COMMAND_LIST:
        return None
    if normalized.command in {
        COMMAND_GET,
        COMMAND_SUSPEND,
        COMMAND_RESUME,
        COMMAND_TERMINATE,
        COMMAND_INVOKE,
        COMMAND_AUTH_TOKEN,
        COMMAND_SHELL_AUTH_TOKEN,
    }:
        if not normalized.session_id:
            return _safe_error(
                MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
                "apptheory: microvm controller session_id is required",
                normalized.request_id,
            )
        return None
    return _safe_error(
        MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
        "apptheory: microvm controller command is unsupported",
        normalized.request_id,
    )


def _environment_deployment_defaults() -> MicroVMControllerDeploymentDefaults:
    legacy = _split_deployment_refs(os.environ.get(MICROVM_ENV_NETWORK_CONNECTOR_REFS, ""))
    egress = _split_deployment_refs(os.environ.get(MICROVM_ENV_EGRESS_NETWORK_CONNECTOR_REFS, "")) or legacy
    return _normalize_deployment_defaults(
        MicroVMControllerDeploymentDefaults(
            image_ref=os.environ.get(MICROVM_ENV_IMAGE_REF, ""),
            network_connector_ref=legacy[0] if legacy else "",
            ingress_network_connector_refs=_split_deployment_refs(
                os.environ.get(MICROVM_ENV_INGRESS_NETWORK_CONNECTOR_REFS, "")
            ),
            egress_network_connector_refs=egress,
        )
    )


def _normalize_deployment_defaults(
    defaults: MicroVMControllerDeploymentDefaults | dict[str, Any] | None,
) -> MicroVMControllerDeploymentDefaults:
    if isinstance(defaults, MicroVMControllerDeploymentDefaults):
        out = MicroVMControllerDeploymentDefaults(
            image_ref=str(defaults.image_ref or "").strip(),
            network_connector_ref=str(defaults.network_connector_ref or "").strip(),
            ingress_network_connector_refs=_normalize_string_list(defaults.ingress_network_connector_refs),
            egress_network_connector_refs=_normalize_string_list(defaults.egress_network_connector_refs),
        )
    else:
        raw = defaults if isinstance(defaults, dict) else {}
        out = MicroVMControllerDeploymentDefaults(
            image_ref=str(raw.get("image_ref", "") or "").strip(),
            network_connector_ref=str(raw.get("network_connector_ref", "") or "").strip(),
            ingress_network_connector_refs=_normalize_string_list(raw.get("ingress_network_connector_refs") or []),
            egress_network_connector_refs=_normalize_string_list(raw.get("egress_network_connector_refs") or []),
        )
    if not out.network_connector_ref and out.egress_network_connector_refs:
        out.network_connector_ref = out.egress_network_connector_refs[0]
    return out


def _normalize_controller_invoke_request(
    request: MicroVMControllerInvokeRequest | dict[str, Any],
) -> MicroVMControllerInvokeRequest:
    if isinstance(request, MicroVMControllerInvokeRequest):
        out = MicroVMControllerInvokeRequest(
            request_id=str(request.request_id or "").strip(),
            tenant_id=str(request.tenant_id or "").strip(),
            namespace=str(request.namespace or "").strip(),
            auth_context=_normalize_auth_context(request.auth_context),
            session_id=str(request.session_id or "").strip(),
            method=str(request.method or "").strip().upper(),
            path=_normalize_provider_invoke_path(request.path),
            query=_clone_query_values(request.query),
            headers=_sanitize_provider_invoke_headers(request.headers),
            body=_coerce_body_bytes(request.body),
            port=int(request.port or 0),
            ttl_seconds=int(request.ttl_seconds or 0),
        )
    else:
        raw = cast(dict[str, Any], request) if isinstance(request, dict) else {}
        out = MicroVMControllerInvokeRequest(
            request_id=str(raw.get("request_id", "") or "").strip(),
            tenant_id=str(raw.get("tenant_id", "") or "").strip(),
            namespace=str(raw.get("namespace", "") or "").strip(),
            auth_context=_normalize_auth_context(raw.get("auth_context") or {}),
            session_id=str(raw.get("session_id", "") or "").strip(),
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


def _split_deployment_refs(value: str) -> list[str]:
    return _normalize_string_list(str(value or "").split(","))


def _command_from_operation(operation: str) -> str:
    match _normalize_operation(operation):
        case "run":
            return COMMAND_RUN
        case "get":
            return COMMAND_GET
        case "list":
            return COMMAND_LIST
        case "suspend":
            return COMMAND_SUSPEND
        case "resume":
            return COMMAND_RESUME
        case "terminate":
            return COMMAND_TERMINATE
        case "invoke":
            return COMMAND_INVOKE
        case "auth-token":
            return COMMAND_AUTH_TOKEN
        case "shell-auth-token":
            return COMMAND_SHELL_AUTH_TOKEN
        case _:
            return _normalize_command(operation)


def _desired_state_for_real_command(command: str, fallback: str) -> str:
    match _normalize_command(command):
        case "run":
            return STATE_RUNNING
        case "suspend":
            return STATE_SUSPENDED
        case "resume":
            return STATE_READY
        case "terminate":
            return STATE_TERMINATED
        case _:
            return fallback


def _provider_binding_from_record(record: MicroVMSessionRecord) -> MicroVMProviderSessionBinding:
    normalized = _normalize_session_record(record)
    return MicroVMProviderSessionBinding(
        tenant_id=normalized.tenant_id,
        namespace=normalized.namespace,
        session_id=normalized.session_id,
        provider_microvm_id=normalized.provider_microvm_id,
        registry_version=normalized.generation,
    )


def _provider_session_from_record(record: MicroVMSessionRecord) -> MicroVMProviderSession:
    normalized = _normalize_session_record(record)
    try:
        state, terminal = map_microvm_provider_state(normalized.provider_state)
    except MicroVMSafeError:
        state = normalized.state
        terminal = normalized.state in {STATE_TERMINATED, STATE_FAILED}
    return _normalize_provider_session(
        MicroVMProviderSession(
            tenant_id=normalized.tenant_id,
            namespace=normalized.namespace,
            session_id=normalized.session_id,
            provider_microvm_id=normalized.provider_microvm_id,
            state=state,
            provider_state=normalized.provider_state,
            endpoint=normalized.endpoint,
            image_ref=normalized.image_ref,
            image_version=normalized.image_version,
            started_at=normalized.provider_started_at,
            terminated_at=normalized.provider_terminated_at,
            registry_version=normalized.generation,
            terminal=terminal,
        )
    )


def _response_from_provider_session(
    request: MicroVMControllerRequest, session: MicroVMProviderSession
) -> MicroVMControllerResponse:
    normalized = _normalize_provider_session(session)
    return MicroVMControllerResponse(
        command=request.command,
        request_id=request.request_id,
        tenant_id=normalized.tenant_id,
        namespace=normalized.namespace,
        session_id=normalized.session_id,
        state=normalized.state,
        desired_state=_desired_state_for_real_command(request.command, normalized.state),
        lifecycle_state=normalized.state,
        endpoint=normalized.endpoint,
        provider_microvm_id=normalized.provider_microvm_id,
        provider_state=normalized.provider_state,
        last_action=request.command,
        registry_version=normalized.registry_version,
    )


def _response_from_provider_token(
    request: MicroVMControllerRequest, token: MicroVMProviderToken
) -> MicroVMControllerResponse:
    normalized = _normalize_provider_token(token)
    return MicroVMControllerResponse(
        command=request.command,
        request_id=request.request_id,
        tenant_id=normalized.tenant_id,
        namespace=normalized.namespace,
        session_id=normalized.session_id,
        provider_microvm_id=normalized.provider_microvm_id,
        token_id=normalized.token_id,
        token_type=normalized.token_type,
        expires_at=normalized.expires_at,
        scope=list(normalized.scope),
    )


def _microvm_controller_route_handler(controller: Any, command: str) -> Callable[[Any], Any]:
    def handler(ctx: Any) -> Any:
        from apptheory.response import json as response_json

        request_or_error = _controller_request_from_http(ctx, command)
        if isinstance(request_or_error, MicroVMSafeError):
            request = MicroVMControllerRequest(
                command=_normalize_command(command),
                request_id=str(getattr(ctx, "request_id", "") or "").strip(),
                tenant_id=str(getattr(ctx, "tenant_id", "") or "").strip(),
                namespace="",
                auth_context=MicroVMAuthContext(
                    subject=str(getattr(ctx, "auth_identity", "") or "").strip(),
                    tenant_id=str(getattr(ctx, "tenant_id", "") or "").strip(),
                ),
            )
            response = _controller_error_response(request, request_or_error)
        else:
            response = controller.handle(request_or_error)
        return response_json(_controller_http_status(response.error), _controller_response_to_dict(response))

    return handler


def _microvm_controller_invoke_route_handler(controller: Any) -> Callable[[Any], Any]:
    def handler(ctx: Any) -> Any:
        from apptheory.response import json as response_json

        request_or_error = _controller_invoke_request_from_http(ctx)
        if isinstance(request_or_error, MicroVMSafeError):
            request = MicroVMControllerRequest(
                command=COMMAND_INVOKE,
                request_id=str(getattr(ctx, "request_id", "") or "").strip(),
                tenant_id=str(getattr(ctx, "tenant_id", "") or "").strip(),
                namespace="",
                auth_context=MicroVMAuthContext(
                    subject=str(getattr(ctx, "auth_identity", "") or "").strip(),
                    tenant_id=str(getattr(ctx, "tenant_id", "") or "").strip(),
                ),
            )
            response = _controller_error_response(request, request_or_error)
            return response_json(_controller_http_status(response.error), _controller_response_to_dict(response))

        invoke = getattr(controller, "invoke", None)
        if not callable(invoke):
            safe = _safe_error(
                MICROVM_ERROR_CONTROLLER_INCOMPLETE,
                "apptheory: microvm controller invoke route requires a provider-backed controller",
                request_or_error.request_id,
            )
            response = _controller_error_response(_invoke_request_envelope(request_or_error), safe)
            return response_json(_controller_http_status(response.error), _controller_response_to_dict(response))

        try:
            output = cast(MicroVMProviderInvokeOutput, invoke(request_or_error))
        except Exception as exc:  # noqa: BLE001
            safe = _as_safe_error(exc, request_or_error.request_id)
            response = _controller_error_response(_invoke_request_envelope(request_or_error), safe)
            return response_json(_controller_http_status(response.error), _controller_response_to_dict(response))

        return _controller_invoke_http_response(output)

    return handler


def _controller_request_from_http(ctx: Any, command: str) -> MicroVMControllerRequest | MicroVMSafeError:
    if ctx is None:
        return _safe_error(
            MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
            "apptheory: microvm controller route context is missing",
            "",
        )
    payload_or_error = _controller_route_payload(ctx)
    if isinstance(payload_or_error, MicroVMSafeError):
        return payload_or_error
    payload = payload_or_error
    request_id = str(getattr(ctx, "request_id", "") or "").strip()
    path_session_id = str(ctx.param("session_id") if callable(getattr(ctx, "param", None)) else "").strip()
    body_session_id = str(payload.get("session_id", "") or "").strip()
    if path_session_id and body_session_id and path_session_id != body_session_id:
        return _safe_error(
            MICROVM_ERROR_TENANT_BINDING_VIOLATION,
            "apptheory: microvm controller route session binding mismatch",
            request_id,
        )
    ctx_tenant = str(getattr(ctx, "tenant_id", "") or "").strip()
    body_tenant = str(payload.get("tenant_id", "") or "").strip()
    query = getattr(getattr(ctx, "request", None), "query", {}) or {}
    headers = getattr(getattr(ctx, "request", None), "headers", {}) or {}
    query_tenant = _first_query_value(query, "tenant_id")
    if ctx_tenant and body_tenant and body_tenant != ctx_tenant:
        return _safe_error(
            MICROVM_ERROR_TENANT_BINDING_VIOLATION,
            "apptheory: microvm controller route tenant binding mismatch",
            request_id,
        )
    if ctx_tenant and query_tenant and query_tenant != ctx_tenant:
        return _safe_error(
            MICROVM_ERROR_TENANT_BINDING_VIOLATION,
            "apptheory: microvm controller route tenant binding mismatch",
            request_id,
        )
    namespace = (
        str(payload.get("namespace", "") or "").strip()
        or _first_header_value(headers, "x-namespace-id")
        or _first_query_value(query, "namespace")
    )
    request = MicroVMControllerRequest(
        command=_normalize_command(command),
        request_id=request_id,
        tenant_id=ctx_tenant or body_tenant or query_tenant,
        namespace=namespace,
        auth_context=MicroVMAuthContext(
            subject=str(getattr(ctx, "auth_identity", "") or "").strip(),
            tenant_id=ctx_tenant,
            namespace=namespace,
        ),
        session_id=path_session_id or body_session_id,
        image_ref=str(payload.get("image_ref", "") or "").strip(),
        image_version=str(payload.get("image_version", "") or "").strip(),
        network_connector_ref=str(payload.get("network_connector_ref", "") or "").strip(),
        ingress_network_connector_refs=_normalize_string_list(payload.get("ingress_network_connector_refs") or []),
        egress_network_connector_refs=_normalize_string_list(payload.get("egress_network_connector_refs") or []),
        session_spec=_clone_session_spec(payload.get("session_spec") or {}),
        idle_policy=_normalize_provider_idle_policy(payload.get("idle_policy")),
        maximum_duration_seconds=int(payload.get("maximum_duration_seconds", 0) or 0),
        ttl_seconds=int(payload.get("ttl_seconds", 0) or 0),
        allowed_port_scope=[
            _normalize_provider_port_scope(scope) for scope in list(payload.get("allowed_port_scope") or [])
        ],
        max_results=int(payload.get("max_results", 0) or 0) or _positive_int(_first_query_value(query, "max_results")),
    )
    return _normalize_controller_request(request)


def _controller_invoke_request_from_http(ctx: Any) -> MicroVMControllerInvokeRequest | MicroVMSafeError:
    if ctx is None:
        return _safe_error(
            MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
            "apptheory: microvm controller route context is missing",
            "",
        )
    request_id = str(getattr(ctx, "request_id", "") or "").strip()
    request_obj = getattr(ctx, "request", None)
    query = getattr(request_obj, "query", {}) or {}
    headers = getattr(request_obj, "headers", {}) or {}
    ctx_tenant = str(getattr(ctx, "tenant_id", "") or "").strip()
    query_tenant = _first_query_value(query, "tenant_id")
    if ctx_tenant and query_tenant and query_tenant != ctx_tenant:
        return _safe_error(
            MICROVM_ERROR_TENANT_BINDING_VIOLATION,
            "apptheory: microvm controller route tenant binding mismatch",
            request_id,
        )
    session_id = str(ctx.param("session_id") if callable(getattr(ctx, "param", None)) else "").strip()
    proxy_path = str(ctx.param("proxy") if callable(getattr(ctx, "param", None)) else "").strip()
    if not proxy_path:
        proxy_path = "/"
    namespace = _first_header_value(headers, "x-namespace-id") or _first_query_value(query, "namespace")
    request = MicroVMControllerInvokeRequest(
        request_id=request_id,
        tenant_id=ctx_tenant,
        namespace=namespace,
        auth_context=MicroVMAuthContext(
            subject=str(getattr(ctx, "auth_identity", "") or "").strip(),
            tenant_id=ctx_tenant,
            namespace=namespace,
        ),
        session_id=session_id,
        method=str(getattr(request_obj, "method", "") or "").strip().upper(),
        path=proxy_path,
        query=_clone_invoke_query_values(query),
        headers=_sanitize_provider_invoke_headers(headers),
        body=_coerce_body_bytes(getattr(request_obj, "body", b"") or b""),
        port=_positive_int(_first_header_value(headers, "x-apptheory-microvm-port")) or _DEFAULT_PROVIDER_INVOKE_PORT,
        ttl_seconds=_positive_int(_first_header_value(headers, "x-apptheory-microvm-token-ttl"))
        or _DEFAULT_PROVIDER_INVOKE_TOKEN_TTL_SECONDS,
    )
    return _normalize_controller_invoke_request(request)


def _controller_route_payload(ctx: Any) -> dict[str, Any] | MicroVMSafeError:
    body = getattr(getattr(ctx, "request", None), "body", b"") or b""
    if not body:
        return {}
    try:
        parsed = jsonlib.loads(bytes(body).decode("utf-8"))
    except Exception:  # noqa: BLE001
        return _safe_error(
            MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
            "apptheory: microvm controller route request is malformed",
            str(getattr(ctx, "request_id", "") or "").strip(),
        )
    if not isinstance(parsed, dict):
        return _safe_error(
            MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
            "apptheory: microvm controller route request is malformed",
            str(getattr(ctx, "request_id", "") or "").strip(),
        )
    return parsed


def _invoke_request_envelope(request: MicroVMControllerInvokeRequest) -> MicroVMControllerRequest:
    return MicroVMControllerRequest(
        command=COMMAND_INVOKE,
        request_id=request.request_id,
        tenant_id=request.tenant_id,
        namespace=request.namespace,
        auth_context=request.auth_context,
        session_id=request.session_id,
    )


def _controller_invoke_http_response(output: MicroVMProviderInvokeOutput) -> Any:
    from apptheory.response import Response, normalize_response

    status = int(output.status or 0) or 502
    return normalize_response(
        Response(
            status=status,
            headers=_sanitize_provider_invoke_headers(output.headers),
            cookies=[],
            body=bytes(output.body),
            is_base64=bool(output.is_base64),
        )
    )


def _microvm_controller_invoke_methods() -> list[str]:
    return ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]


def _clone_invoke_query_values(query: dict[str, Any]) -> dict[str, list[str]]:
    out = _clone_query_values(query)
    out.pop("tenant_id", None)
    out.pop("namespace", None)
    return out


def _controller_http_status(error: MicroVMSafeError | None) -> int:
    if error is None or not error.code:
        return 200
    if error.code == MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER:
        return 401
    if error.code == MICROVM_ERROR_TENANT_BINDING_VIOLATION:
        return 403
    if error.code == MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE:
        return 404
    if error.code == MICROVM_ERROR_CONTROLLER_INCOMPLETE:
        return 500
    if error.code in {MICROVM_ERROR_CONTROLLER_COMMAND_FAILED, MICROVM_ERROR_PROVIDER_OPERATION_FAILED}:
        return 502
    return 400


def _controller_response_to_dict(response: MicroVMControllerResponse) -> dict[str, Any]:
    out: dict[str, Any] = {
        "command": response.command,
        "request_id": response.request_id,
        "tenant_id": response.tenant_id,
        "namespace": response.namespace,
        "session_id": response.session_id,
    }
    out.update(
        {
            key: value
            for key, value in [
                ("state", response.state),
                ("desired_state", response.desired_state),
                ("lifecycle_state", response.lifecycle_state),
                ("endpoint", response.endpoint),
                ("microvm_id", response.microvm_id),
                ("provider_microvm_id", response.provider_microvm_id),
                ("provider_state", response.provider_state),
                ("last_action", response.last_action),
                ("last_transition", response.last_transition),
                ("registry_version", response.registry_version),
                ("recovery_cursor", response.recovery_cursor),
                ("token_id", response.token_id),
                ("token_type", response.token_type),
                ("expires_at", response.expires_at),
            ]
            if value not in ("", 0, 0.0, None)
        }
    )
    if response.scope:
        out["scope"] = list(response.scope)
    if response.sessions:
        out["sessions"] = [_provider_session_to_dict(session) for session in response.sessions]
    if response.error is not None:
        out["error"] = {
            "code": response.error.code,
            "message": response.error.message,
            "request_id": response.error.request_id,
        }
    return out


def _provider_session_to_dict(session: MicroVMProviderSession) -> dict[str, Any]:
    normalized = _normalize_provider_session(session)
    return {
        "tenant_id": normalized.tenant_id,
        "namespace": normalized.namespace,
        "session_id": normalized.session_id,
        "provider_microvm_id": normalized.provider_microvm_id,
        "state": normalized.state,
        "provider_state": normalized.provider_state,
        "image_ref": normalized.image_ref,
        "image_version": normalized.image_version,
        "started_at": normalized.started_at,
        "terminated_at": normalized.terminated_at,
        "registry_version": normalized.registry_version,
        "terminal": normalized.terminal,
    }


def _first_header_value(headers: dict[str, Any], key: str) -> str:
    values = headers.get(str(key or "").strip().lower()) or headers.get(str(key or "").strip()) or []
    if isinstance(values, list):
        return str(values[0] if values else "").strip()
    return str(values or "").strip()


def _first_query_value(query: dict[str, Any], key: str) -> str:
    values = query.get(str(key or "").strip()) or []
    if isinstance(values, list):
        return str(values[0] if values else "").strip()
    return str(values or "").strip()


def _positive_int(value: object) -> int:
    try:
        parsed = int(str(value or "").strip())
    except Exception:  # noqa: BLE001
        return 0
    return parsed if parsed > 0 else 0


__all__ = [
    "MicroVMController",
    "MicroVMRealController",
    "_clone_invoke_query_values",
    "_command_from_operation",
    "_controller_http_status",
    "_controller_invoke_http_response",
    "_controller_invoke_request_from_http",
    "_controller_request_from_http",
    "_controller_response_to_dict",
    "_controller_route_payload",
    "_desired_state_for_real_command",
    "_first_header_value",
    "_first_query_value",
    "_invoke_request_envelope",
    "_microvm_controller_invoke_methods",
    "_microvm_controller_invoke_route_handler",
    "_microvm_controller_route_handler",
    "_normalize_controller_invoke_request",
    "_positive_int",
    "_provider_binding_from_record",
    "_provider_session_from_record",
    "_provider_session_to_dict",
    "_response_from_provider_session",
    "_response_from_provider_token",
    "_validate_real_controller_request",
    "create_microvm_controller",
    "create_real_microvm_controller",
    "register_controller_routes",
    "register_microvm_controller_routes",
    "validate_microvm_controller_request",
]
