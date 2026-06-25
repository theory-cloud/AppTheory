from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import patch

import apptheory as app
from apptheory import microvm as microvm_mod


class _OfficialMicroVMClientStub:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.state = "RUNNING"
        self.auth_token: dict[str, object] = {"authToken": {"issued": True}}

    def _record(self) -> dict[str, object]:
        return {
            "microvmId": "provider-1",
            "state": self.state,
            "imageArn": "image-ref",
            "imageVersion": "1",
            "startedAt": 2.0,
            "terminatedAt": "not-a-number",
        }

    def run_microvm(self, **payload: object) -> dict[str, object]:
        self.calls.append(("run_microvm", payload))
        return self._record()

    def get_microvm(self, **payload: object) -> dict[str, object]:
        self.calls.append(("get_microvm", payload))
        return self._record()

    def list_microvms(self, **payload: object) -> dict[str, object]:
        self.calls.append(("list_microvms", payload))
        return {"items": [self._record(), {"microvmId": "unknown", "state": "RUNNING"}]}

    def suspend_microvm(self, **payload: object) -> dict[str, object]:
        self.calls.append(("suspend_microvm", payload))
        self.state = "SUSPENDED"
        return {}

    def resume_microvm(self, **payload: object) -> dict[str, object]:
        self.calls.append(("resume_microvm", payload))
        self.state = "RUNNING"
        return {}

    def terminate_microvm(self, **payload: object) -> dict[str, object]:
        self.calls.append(("terminate_microvm", payload))
        self.state = "TERMINATED"
        return {}

    def create_microvm_auth_token(self, **payload: object) -> dict[str, object]:
        self.calls.append(("create_microvm_auth_token", payload))
        return self.auth_token

    def create_microvm_shell_auth_token(self, **payload: object) -> dict[str, object]:
        self.calls.append(("create_microvm_shell_auth_token", payload))
        return self.auth_token


def _required_lambda_microvm_operations() -> set[str]:
    return {
        "RunMicrovm",
        "GetMicrovm",
        "ListMicrovms",
        "SuspendMicrovm",
        "ResumeMicrovm",
        "TerminateMicrovm",
        "CreateMicrovmAuthToken",
        "CreateMicrovmShellAuthToken",
    }


def _fake_lambda_microvm_sdk_modules(
    testcase: unittest.TestCase,
    clients: list[_OfficialMicroVMClientStub],
    operations: set[str],
    *,
    services: list[str] | None = None,
) -> dict[str, types.ModuleType]:
    def fake_boto3_client(service_name: str, **kwargs: object) -> _OfficialMicroVMClientStub:
        testcase.assertEqual("lambda-microvms", service_name)
        testcase.assertEqual({"region_name": "us-west-2"}, kwargs)
        client = _OfficialMicroVMClientStub()
        clients.append(client)
        return client

    boto3_module = types.ModuleType("boto3")
    boto3_module.client = fake_boto3_client  # type: ignore[attr-defined]
    botocore_module = types.ModuleType("botocore")
    botocore_module.__path__ = []  # type: ignore[attr-defined]
    botocore_session_module = types.ModuleType("botocore.session")

    class Session:
        def get_available_services(self) -> list[str]:
            return services if services is not None else ["lambda-microvms"]

        def get_service_model(self, service_name: str) -> object:
            testcase.assertEqual("lambda-microvms", service_name)
            return types.SimpleNamespace(operation_names=list(operations))

    botocore_session_module.get_session = lambda: Session()  # type: ignore[attr-defined]
    botocore_module.session = botocore_session_module  # type: ignore[attr-defined]
    return {
        "boto3": boto3_module,
        "botocore": botocore_module,
        "botocore.session": botocore_session_module,
    }


class MicroVMLifecycleTests(unittest.TestCase):
    def _lifecycle_event(self, **overrides: str) -> dict[str, str]:
        event = {
            "request_id": "req-1",
            "tenant_id": "tenant-1",
            "namespace": "namespace-1",
            "session_id": "session-1",
            "hook": app.HOOK_PREPARE_IMAGE,
            "state": app.STATE_REQUESTED,
        }
        event.update(overrides)
        return event

    def _handlers(self) -> dict[str, app.MicroVMLifecycleHandler]:
        return {
            hook: lambda _event: None
            for hook in [
                app.HOOK_PREPARE_IMAGE,
                app.HOOK_START,
                app.HOOK_READINESS,
                app.HOOK_STOP,
                app.HOOK_TEARDOWN,
                app.HOOK_FAILURE,
            ]
        }

    def _create_input(self, *, session_id: str = "session-1", now: float = 1.0) -> app.MicroVMCreateSessionInput:
        return app.MicroVMCreateSessionInput(
            request_id="req-create",
            tenant_id="tenant-1",
            namespace="namespace-1",
            session_id=session_id,
            image_ref="image-ref",
            network_connector_ref="network-ref",
            session_spec=app.MicroVMSessionSpec(metadata={"safe": "ok"}),
            controller_id="controller-1",
            auth_subject="subject-1",
            now=now,
        )

    def _command_input(
        self,
        *,
        request_id: str = "req-command",
        session_id: str = "session-1",
        desired_state: str = app.STATE_STARTED,
        now: float = 1.0,
    ) -> app.MicroVMSessionCommandInput:
        return app.MicroVMSessionCommandInput(
            request_id=request_id,
            tenant_id="tenant-1",
            namespace="namespace-1",
            session_id=session_id,
            controller_id="controller-1",
            auth_subject="subject-1",
            desired_state=desired_state,
            now=now,
        )

    def _query_input(
        self, *, request_id: str = "req-query", session_id: str = "session-1"
    ) -> app.MicroVMSessionQueryInput:
        return app.MicroVMSessionQueryInput(
            request_id=request_id,
            tenant_id="tenant-1",
            namespace="namespace-1",
            session_id=session_id,
            auth_subject="subject-1",
        )

    def _valid_record(self, **overrides: object) -> app.MicroVMSessionRecord:
        record = app.MicroVMSessionRecord(
            tenant_id="tenant-1",
            namespace="namespace-1",
            session_id="session-1",
            state=app.STATE_REQUESTED,
            desired_state=app.STATE_REQUESTED,
            provider_id=app.MICROVM_DEFAULT_SESSION_PROVIDER_ID,
            provider_microvm_id="session-1",
            provider_state=app.STATE_REQUESTED,
            aws_lifecycle_state=app.STATE_REQUESTED,
            image_ref="image-ref",
            image_version="1",
            network_connector_ref="network-ref",
            ingress_network_connector_refs=["ingress-ref"],
            egress_network_connector_refs=["egress-ref"],
            controller_id="controller-1",
            created_at=1.0,
            updated_at=1.0,
            last_observed_at=1.0,
            expires_at=3601.0,
            generation=1,
            last_action=app.COMMAND_CREATE,
            last_command_id="req-record",
            auth_subject="subject-1",
            reason_metadata={"reason_code": "ok"},
            status_metadata={"status": "healthy"},
            token_metadata=[
                app.MicroVMSessionTokenMetadata(
                    token_id="auth-token-metadata",
                    token_type="auth",
                    expires_at=901.0,
                    scope=["ports:443"],
                )
            ],
        )
        for key, value in overrides.items():
            setattr(record, key, value)
        return record

    def _valid_status(self, **overrides: object) -> app.MicroVMSessionStatus:
        status = app.MicroVMSessionStatus(
            tenant_id="tenant-1",
            namespace="namespace-1",
            session_id="session-1",
            state=app.STATE_REQUESTED,
            desired_state=app.STATE_REQUESTED,
            lifecycle_state=app.STATE_REQUESTED,
            last_action=app.COMMAND_CREATE,
            last_transition=1.0,
            registry_version=1,
        )
        for key, value in overrides.items():
            setattr(status, key, value)
        return status

    def _provider_auth(self, *, tenant_id: str = "tenant-1", namespace: str = "namespace-1") -> app.MicroVMAuthContext:
        return app.MicroVMAuthContext(subject="subject-1", tenant_id=tenant_id, namespace=namespace)

    def _provider_binding(
        self,
        *,
        tenant_id: str = "tenant-1",
        namespace: str = "namespace-1",
        session_id: str = "session-1",
        provider_microvm_id: str = "microvm-1",
        registry_version: int = 1,
    ) -> app.MicroVMProviderSessionBinding:
        return app.MicroVMProviderSessionBinding(
            tenant_id=tenant_id,
            namespace=namespace,
            session_id=session_id,
            provider_microvm_id=provider_microvm_id,
            registry_version=registry_version,
        )

    def _provider_dict_inputs(
        self,
    ) -> tuple[dict[str, object], dict[str, object], dict[str, object], dict[str, object], dict[str, object]]:
        binding_dict: dict[str, object] = {
            "tenant_id": "tenant-1",
            "namespace": "namespace-1",
            "session_id": "session-1",
            "provider_microvm_id": "microvm-1",
            "registry_version": 1,
        }
        run_dict: dict[str, object] = {
            "request_id": "req-run-dict",
            "tenant_id": "tenant-1",
            "namespace": "namespace-1",
            "session_id": "session-1",
            "auth_context": {
                "subject": "subject-1",
                "tenant_id": "tenant-1",
                "namespace": "namespace-1",
                "metadata": {"safe": "ok"},
            },
            "image_ref": "image-ref",
            "image_version": "1",
            "network_connector_ref": "egress-default",
            "ingress_network_connector_refs": ["ingress-1"],
            "egress_network_connector_refs": ["egress-1"],
            "session_spec": {"metadata": {"safe": "ok"}},
            "idle_policy": {
                "auto_resume_enabled": True,
                "max_idle_duration_seconds": 60,
                "suspended_duration_seconds": 120,
            },
            "maximum_duration_seconds": 600,
        }
        session_dict: dict[str, object] = {
            "request_id": "req-get-dict",
            "tenant_id": "tenant-1",
            "namespace": "namespace-1",
            "auth_context": {"subject": "subject-1", "tenant_id": "tenant-1", "namespace": "namespace-1"},
            "binding": binding_dict,
        }
        list_dict: dict[str, object] = {
            "request_id": "req-list-dict",
            "tenant_id": "tenant-1",
            "namespace": "namespace-1",
            "auth_context": {"subject": "subject-1", "tenant_id": "tenant-1", "namespace": "namespace-1"},
            "image_ref": "image-ref",
            "image_version": "1",
            "max_results": 5,
            "known_sessions": [binding_dict],
        }
        token_dict: dict[str, object] = {
            "request_id": "req-token-dict",
            "tenant_id": "tenant-1",
            "namespace": "namespace-1",
            "auth_context": {"subject": "subject-1", "tenant_id": "tenant-1", "namespace": "namespace-1"},
            "binding": binding_dict,
            "ttl_seconds": 61,
            "allowed_port_scope": [{"all_ports": True}, {"start_port": 8080, "end_port": 8081}],
        }
        return binding_dict, run_dict, session_dict, list_dict, token_dict

    def test_lifecycle_adapter_runs_to_terminal_states(self) -> None:
        contract = app.default_microvm_lifecycle_contract()
        app.validate_microvm_lifecycle_contract(contract)
        adapter = app.create_microvm_lifecycle_adapter(
            contract=contract,
            handlers=self._handlers(),
        )

        state = app.STATE_REQUESTED
        for hook in [app.HOOK_PREPARE_IMAGE, app.HOOK_START, app.HOOK_READINESS, app.HOOK_STOP, app.HOOK_TEARDOWN]:
            result = adapter.handle(
                app.MicroVMLifecycleEvent(
                    request_id="req-1",
                    tenant_id="tenant-1",
                    namespace="namespace-1",
                    session_id="session-1",
                    hook=hook,
                    state=state,
                )
            )
            self.assertIsNone(result.error)
            state = result.state
        self.assertEqual(app.STATE_TERMINATED, state)

        failure = adapter.handle(
            {
                "request_id": "req-failure",
                "tenant_id": "tenant-1",
                "namespace": "namespace-1",
                "session_id": "session-1",
                "hook": app.HOOK_FAILURE,
                "state": app.STATE_STARTING,
            }
        )
        self.assertIsNone(failure.error)
        self.assertEqual(app.STATE_FAILED, failure.state)
        self.assertTrue(app.is_microvm_terminal_state(failure.state))

    def test_lifecycle_fails_closed_for_escape_hatches_and_metadata(self) -> None:
        with self.assertRaises(app.MicroVMSafeError) as ctx:
            app.validate_microvm_escape_hatches({"raw_lifecycle_hook_bypass": True})
        self.assertEqual(app.MICROVM_ERROR_LIFECYCLE_BYPASS, ctx.exception.code)

        adapter = app.create_microvm_lifecycle_adapter(
            handlers=self._handlers(),
        )
        result = adapter.handle(
            {
                "request_id": "req-secret",
                "tenant_id": "tenant-1",
                "namespace": "namespace-1",
                "session_id": "session-1",
                "hook": app.HOOK_PREPARE_IMAGE,
                "state": app.STATE_REQUESTED,
                "metadata": {"bearer_token": "redacted"},
            }
        )
        self.assertIsNotNone(result.error)
        self.assertEqual(app.MICROVM_ERROR_FORBIDDEN_FIELD, result.error.code if result.error else "")

    def test_controller_flow_and_aws_sdk_gate(self) -> None:
        client = app.create_fake_microvm_client(now=10.0)
        controller = app.create_microvm_controller(
            client,
            controller_id="controller-1",
            clock=lambda: 10.0,
            id_generator=lambda: "session-1",
        )
        create = controller.handle(
            {
                "command": app.COMMAND_CREATE,
                "request_id": "req-create",
                "tenant_id": "tenant-1",
                "namespace": "namespace-1",
                "auth_context": {"subject": "subject-1", "tenant_id": "tenant-1"},
                "image_ref": "image-ref",
                "network_connector_ref": "network-ref",
            }
        )
        self.assertIsNone(create.error)
        self.assertEqual("session-1", create.session_id)
        self.assertEqual(app.STATE_REQUESTED, create.state)
        self.assertEqual(app.COMMAND_CREATE, create.last_action)

        start = controller.handle(
            {
                "command": app.COMMAND_START,
                "request_id": "req-start",
                "tenant_id": "tenant-1",
                "namespace": "namespace-1",
                "auth_context": {"subject": "subject-1", "tenant_id": "tenant-1"},
                "session_id": create.session_id,
            }
        )
        self.assertIsNone(start.error)
        self.assertEqual(app.STATE_STARTING, start.state)
        self.assertEqual(app.STATE_STARTED, start.desired_state)
        self.assertEqual(app.COMMAND_START, start.last_action)

        missing_auth = controller.handle(
            {
                "command": app.COMMAND_STATUS,
                "request_id": "req-auth",
                "tenant_id": "tenant-1",
                "namespace": "namespace-1",
                "auth_context": {},
                "session_id": create.session_id,
            }
        )
        self.assertIsNotNone(missing_auth.error)
        self.assertEqual(
            app.MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER, missing_auth.error.code if missing_auth.error else ""
        )

        with self.assertRaises(app.MicroVMSafeError) as ctx:
            app.create_aws_lambda_microvm_client()
        self.assertEqual(app.MICROVM_ERROR_CONTROLLER_INCOMPLETE, ctx.exception.code)

    def test_lifecycle_errors_are_safe_and_fail_closed(self) -> None:
        adapter = app.create_microvm_lifecycle_adapter(handlers=self._handlers())
        adapter.contract.hooks = []
        broken_contract = adapter.handle(app.MicroVMLifecycleEvent(**self._lifecycle_event()))
        self.assertEqual(
            app.MICROVM_ERROR_LIFECYCLE_INCOMPLETE, broken_contract.error.code if broken_contract.error else ""
        )

        adapter = app.create_microvm_lifecycle_adapter(handlers=self._handlers())
        unsupported_hook = adapter.handle(self._lifecycle_event(hook="custom_hook"))
        self.assertEqual(
            app.MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
            unsupported_hook.error.code if unsupported_hook.error else "",
        )

        unsupported_transition = adapter.handle(self._lifecycle_event(hook=app.HOOK_READINESS))
        self.assertEqual(
            app.MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
            unsupported_transition.error.code if unsupported_transition.error else "",
        )

        mismatch_contract = app.default_microvm_lifecycle_contract()
        mismatch_contract.transitions.insert(
            0,
            app.MicroVMLifecycleTransition(
                app.STATE_REQUESTED,
                app.HOOK_PREPARE_IMAGE,
                app.STATE_STARTING,
            ),
        )
        mismatch = app.create_microvm_lifecycle_adapter(contract=mismatch_contract, handlers=self._handlers()).handle(
            self._lifecycle_event()
        )
        self.assertEqual(app.MICROVM_ERROR_INVALID_LIFECYCLE_EVENT, mismatch.error.code if mismatch.error else "")

        missing_handler = app.create_microvm_lifecycle_adapter(handlers={}).handle(self._lifecycle_event())
        self.assertEqual(
            app.MICROVM_ERROR_INVALID_LIFECYCLE_EVENT, missing_handler.error.code if missing_handler.error else ""
        )

        def fail_handler(_event: app.MicroVMLifecycleEvent) -> None:
            raise RuntimeError("raw secret must be sanitized")

        failed_handler = app.create_microvm_lifecycle_adapter(handlers={app.HOOK_PREPARE_IMAGE: fail_handler}).handle(
            self._lifecycle_event()
        )
        self.assertEqual(
            app.MICROVM_ERROR_LIFECYCLE_HOOK_FAILED, failed_handler.error.code if failed_handler.error else ""
        )

        incomplete = adapter.handle(self._lifecycle_event(tenant_id=""))
        self.assertEqual(app.MICROVM_ERROR_INVALID_LIFECYCLE_EVENT, incomplete.error.code if incomplete.error else "")

        missing_hook = adapter.handle(self._lifecycle_event(hook=""))
        self.assertEqual(
            app.MICROVM_ERROR_INVALID_LIFECYCLE_EVENT, missing_hook.error.code if missing_hook.error else ""
        )

    def test_lifecycle_contract_validation_rejects_incomplete_contracts(self) -> None:
        with self.assertRaises(app.MicroVMSafeError) as ctx:
            app.validate_microvm_escape_hatches(app.MicroVMEscapeHatches(raw_aws_sdk=True))
        self.assertEqual(app.MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH, ctx.exception.code)

        contract = app.default_microvm_lifecycle_contract()
        contract.hooks[0].phase = ""
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_lifecycle_contract(contract)

        contract = app.default_microvm_lifecycle_contract()
        contract.hooks = contract.hooks[1:]
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_lifecycle_contract(contract)

        contract = app.default_microvm_lifecycle_contract()
        contract.states = [state for state in contract.states if state != app.STATE_READY]
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_lifecycle_contract(contract)

        contract = app.default_microvm_lifecycle_contract()
        contract.terminal_states = [app.STATE_TERMINATED]
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_lifecycle_contract(contract)

        contract = app.default_microvm_lifecycle_contract()
        contract.transitions = [
            transition
            for transition in contract.transitions
            if not (
                transition.from_state == app.STATE_REQUESTED
                and transition.hook == app.HOOK_PREPARE_IMAGE
                and transition.to == app.STATE_IMAGE_PREPARING
            )
        ]
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_lifecycle_contract(contract)

        contract = app.default_microvm_lifecycle_contract()
        contract.transitions = [
            transition
            for transition in contract.transitions
            if not (
                transition.from_state == app.STATE_IMAGE_PREPARING
                and transition.hook == app.HOOK_PREPARE_IMAGE
                and transition.to == app.STATE_IMAGE_PREPARED
            )
        ]
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_lifecycle_contract(contract)

        contract = app.default_microvm_lifecycle_contract()
        contract.transitions = [
            transition
            for transition in contract.transitions
            if not (
                transition.from_state == app.STATE_IMAGE_PREPARING
                and transition.hook == app.HOOK_FAILURE
                and transition.to == app.STATE_FAILED
            )
        ]
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_lifecycle_contract(contract)

    def test_controller_contract_and_registry_validation_fail_closed(self) -> None:
        app.validate_microvm_controller_contract(app.default_microvm_controller_contract())
        app.validate_microvm_session_registry_contract(app.default_microvm_session_registry_contract())

        controller_contract = app.default_microvm_controller_contract()
        controller_contract.auth.required = False
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_controller_contract(controller_contract)

        controller_contract = app.default_microvm_controller_contract()
        controller_contract.envelope.required_fields = []
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_controller_contract(controller_contract)

        controller_contract = app.default_microvm_controller_contract()
        controller_contract.envelope.safe_error_fields = []
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_controller_contract(controller_contract)

        controller_contract = app.default_microvm_controller_contract()
        controller_contract.envelope.forbidden_fields = []
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_controller_contract(controller_contract)

        controller_contract = app.default_microvm_controller_contract()
        controller_contract.commands[0].method = ""
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_controller_contract(controller_contract)

        controller_contract = app.default_microvm_controller_contract()
        controller_contract.commands[0].response_fields = []
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_controller_contract(controller_contract)

        controller_contract = app.default_microvm_controller_contract()
        controller_contract.commands = controller_contract.commands[:-1]
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_controller_contract(controller_contract)

        registry = app.default_microvm_session_registry_contract()
        registry.pattern = "raw-sdk-table"
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_session_registry_contract(registry)

        registry = app.default_microvm_session_registry_contract()
        registry.tenant_binding = ["tenant_id"]
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_session_registry_contract(registry)

        registry = app.default_microvm_session_registry_contract()
        registry.required_fields = [field for field in registry.required_fields if field != "tenant_id"]
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_session_registry_contract(registry)

        registry = app.default_microvm_session_registry_contract()
        registry.state_values = registry.state_values[:-1]
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_session_registry_contract(registry)

        registry = app.default_microvm_session_registry_contract()
        registry.forbidden_fields = ["raw_aws_credentials"]
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_session_registry_contract(registry)

    def test_session_record_status_and_request_validation_fail_closed(self) -> None:
        app.validate_microvm_session_record(self._valid_record())
        app.validate_microvm_session_status(self._valid_status())
        self.assertEqual(("tenant-1", "namespace-1", "session-1"), app.microvm_session_key(self._valid_record()))

        for record in [
            self._valid_record(session_id=""),
            self._valid_record(created_at=0.0),
            self._valid_record(state="unknown"),
            self._valid_record(metadata={"bearer-token": "redacted"}),
        ]:
            with self.assertRaises(app.MicroVMSafeError):
                app.validate_microvm_session_record(record)

        for status in [self._valid_status(session_id=""), self._valid_status(state="unknown")]:
            with self.assertRaises(app.MicroVMSafeError):
                app.validate_microvm_session_status(status)

        self.assertEqual(app.MICROVM_ERROR_INVALID_CONTROLLER_REQUEST, app.validate_microvm_controller_request({}).code)

        base_request = {
            "command": app.COMMAND_CREATE,
            "request_id": "req-1",
            "tenant_id": "tenant-1",
            "namespace": "namespace-1",
            "auth_context": {"subject": "subject-1", "tenant_id": "tenant-1", "namespace": "namespace-1"},
            "image_ref": "image-ref",
            "network_connector_ref": "network-ref",
        }
        request = {**base_request, "auth_context": {"subject": "subject-1", "tenant_id": "other"}}
        self.assertEqual(
            app.MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
            app.validate_microvm_controller_request(request).code,
        )

        request = {
            **base_request,
            "auth_context": {"subject": "subject-1", "tenant_id": "tenant-1", "namespace": "other"},
        }
        self.assertEqual(
            app.MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
            app.validate_microvm_controller_request(request).code,
        )

        request = {
            **base_request,
            "auth_context": {
                "subject": "subject-1",
                "tenant_id": "tenant-1",
                "metadata": {"authorization": "redacted"},
            },
        }
        self.assertEqual(app.MICROVM_ERROR_FORBIDDEN_FIELD, app.validate_microvm_controller_request(request).code)

        request = {**base_request, "session_spec": {"metadata": {"raw_sdk_client": "redacted"}}}
        self.assertEqual(app.MICROVM_ERROR_FORBIDDEN_FIELD, app.validate_microvm_controller_request(request).code)

        request = {**base_request, "image_ref": ""}
        self.assertEqual(
            app.MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
            app.validate_microvm_controller_request(request).code,
        )

        request = {
            **base_request,
            "command": app.COMMAND_START,
            "image_ref": "",
            "network_connector_ref": "",
        }
        self.assertEqual(
            app.MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
            app.validate_microvm_controller_request(request).code,
        )

        request = {**base_request, "command": "reboot"}
        self.assertEqual(
            app.MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
            app.validate_microvm_controller_request(request).code,
        )

    def test_microvm_session_registry_shape_and_client(self) -> None:
        record = self._valid_record(
            state=app.STATE_STARTING,
            desired_state=app.STATE_STARTED,
            endpoint="https://microvm.example.test/session-1",
            microvm_id="microvm-1",
            generation=7,
            last_action=app.COMMAND_START,
        )
        registry_record = app.microvm_session_record_to_registry_record(record)
        self.assertEqual("TENANT#tenant-1#NAMESPACE#namespace-1", registry_record.pk)
        self.assertEqual("SESSION#session-1", registry_record.sk)
        self.assertEqual(3601, registry_record.ttl)
        self.assertEqual(7, registry_record.version)
        self.assertEqual("https://microvm.example.test/session-1", registry_record.endpoint)
        self.assertEqual("microvm-1", registry_record.microvm_id)
        self.assertEqual(record.provider_id, registry_record.provider_id)
        self.assertEqual(record.provider_state, registry_record.provider_state)
        self.assertEqual(record.image_version, registry_record.image_version)
        self.assertEqual(app.COMMAND_START, registry_record.last_action)

        round_trip = app.microvm_session_from_registry_record(registry_record)
        self.assertEqual(record.endpoint, round_trip.endpoint)
        self.assertEqual(record.microvm_id, round_trip.microvm_id)
        self.assertEqual(record.provider_id, round_trip.provider_id)
        self.assertEqual(record.token_metadata[0].token_id, round_trip.token_metadata[0].token_id)
        self.assertEqual(record.last_action, round_trip.last_action)

        bad = app.microvm_session_record_to_registry_record(record)
        bad.pk = "TENANT#other#NAMESPACE#namespace-1"
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_session_registry_record(bad)
        bad = app.microvm_session_record_to_registry_record(record)
        bad.status_metadata = {"provider_exception": "redacted"}
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_session_registry_record(bad)
        bad = app.microvm_session_record_to_registry_record(record)
        bad.token_metadata = [
            app.MicroVMSessionTokenMetadata(
                token_id="token_value",
                token_type="auth",
                expires_at=901.0,
                scope=["ports:443"],
            )
        ]
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_session_registry_record(bad)

        registry = app.create_memory_microvm_session_registry()
        stored = registry.put(record)
        self.assertEqual(app.COMMAND_START, stored.last_action)
        loaded = registry.get(record)
        self.assertEqual(record.endpoint, loaded.endpoint)
        registry.delete(record)
        with self.assertRaises(app.MicroVMSafeError):
            registry.get(record)

        client_registry = app.create_memory_microvm_session_registry()
        client = app.create_microvm_registry_client(client_registry, ttl_seconds=30)
        created = client.create(self._create_input(now=100.0))
        self.assertEqual(app.COMMAND_CREATE, created.last_action)
        self.assertEqual(130.0, created.expires_at)
        started = client.start(self._command_input(request_id="req-start", now=120.0))
        self.assertEqual(app.STATE_STARTING, started.state)
        self.assertEqual(app.COMMAND_START, started.last_action)
        self.assertEqual(2, started.generation)
        status = client.status(self._query_input(request_id="req-status"))
        self.assertEqual(app.COMMAND_START, status.last_action)
        self.assertEqual(2, status.registry_version)

    def test_microvm_registry_reconstruction_hooks_fail_closed(self) -> None:
        request = app.MicroVMSessionReconstructionRequest(
            request_id="req-reconstruct",
            tenant_id="tenant-1",
            namespace="namespace-1",
            session_id="session-1",
            now=100.0,
        )
        with self.assertRaises(app.MicroVMSafeError):
            app.reconstruct_microvm_session_record(request, None)

        with self.assertRaises(app.MicroVMSafeError):
            app.reconstruct_microvm_session_record(
                request,
                lambda _request: self._valid_record(tenant_id="tenant-other"),
            )

        with self.assertRaises(app.MicroVMSafeError):
            app.reconstruct_microvm_session_record(
                app.MicroVMSessionReconstructionRequest(
                    request_id="req-reconstruct",
                    tenant_id="tenant-1",
                    namespace="namespace-1",
                    session_id="session-1",
                    now=10_000.0,
                ),
                lambda _request: self._valid_record(),
            )

        registry = app.create_memory_microvm_session_registry()

        def hook(reconstruct_request: app.MicroVMSessionReconstructionRequest) -> app.MicroVMSessionRecord:
            return self._valid_record(
                session_id=reconstruct_request.session_id,
                provider_id=app.MICROVM_AWS_LAMBDA_PROVIDER_ID,
                provider_microvm_id="provider-1",
                provider_state="running",
                aws_lifecycle_state="running",
                last_observed_at=reconstruct_request.now,
                expires_at=reconstruct_request.now + 60.0,
            )

        reconstructing = app.create_reconstructing_microvm_session_registry(
            registry,
            hook,
            stale_after_seconds=1,
            clock=lambda: 500.0,
        )
        reconstructed = reconstructing.get(("tenant-1", "namespace-1", "session-1"))
        self.assertEqual(app.MICROVM_AWS_LAMBDA_PROVIDER_ID, reconstructed.provider_id)
        self.assertEqual("running", reconstructed.provider_state)

        with self.assertRaises(app.MicroVMSafeError):
            app.create_reconstructing_microvm_session_registry(registry, None)

    def test_controller_errors_fake_client_and_aws_adapter_are_constrained(self) -> None:
        with self.assertRaises(app.MicroVMSafeError):
            app.create_microvm_controller(None)

        controller = app.create_microvm_controller(
            app.create_fake_microvm_client(now=1.0),
            id_generator=lambda: "",
        )
        response = controller.handle(
            {
                "command": app.COMMAND_CREATE,
                "request_id": "req-create",
                "tenant_id": "tenant-1",
                "namespace": "namespace-1",
                "auth_context": {"subject": "subject-1", "tenant_id": "tenant-1"},
                "image_ref": "image-ref",
                "network_connector_ref": "network-ref",
            }
        )
        self.assertEqual(app.MICROVM_ERROR_INVALID_CONTROLLER_REQUEST, response.error.code if response.error else "")

        client = app.create_fake_microvm_client(now=1.0)
        client.set_now(22.0)
        create_input = self._create_input(now=0.0)
        record = client.create(create_input)
        self.assertEqual(22.0, record.created_at)
        self.assertEqual([app.COMMAND_CREATE], [call.command for call in client.calls()])
        with self.assertRaises(RuntimeError):
            client.create(create_input)
        with self.assertRaises(RuntimeError):
            client.status(self._query_input(session_id="missing"))

        provider = app.create_fake_microvm_provider(now=0.0)
        provider_run = app.MicroVMProviderRunInput(
            request_id="req-run",
            tenant_id="tenant-1",
            namespace="namespace-1",
            session_id="session-1",
            auth_context=app.MicroVMAuthContext(subject="subject-1", tenant_id="tenant-1", namespace="namespace-1"),
            image_ref="image-ref",
            image_version="1",
            network_connector_ref="egress-default",
            ingress_network_connector_refs=["ingress-1"],
            egress_network_connector_refs=["egress-1"],
            session_spec=app.MicroVMSessionSpec(metadata={"safe": "ok"}),
            idle_policy=app.MicroVMProviderIdlePolicy(
                auto_resume_enabled=True,
                max_idle_duration_seconds=60,
                suspended_duration_seconds=120,
            ),
            maximum_duration_seconds=600,
        )
        app.validate_microvm_provider_run_input(provider_run)
        run = provider.run(provider_run)
        self.assertEqual("microvm-000001", run.provider_microvm_id)
        self.assertEqual(app.STATE_RUNNING, run.state)
        app.validate_microvm_provider_session(run)
        binding = app.MicroVMProviderSessionBinding(
            run.tenant_id, run.namespace, run.session_id, run.provider_microvm_id, run.registry_version
        )
        session_input = app.MicroVMProviderSessionInput(
            request_id="req-get",
            tenant_id="tenant-1",
            namespace="namespace-1",
            auth_context=app.MicroVMAuthContext(subject="subject-1", tenant_id="tenant-1", namespace="namespace-1"),
            binding=binding,
        )
        app.validate_microvm_provider_session_input(app.OPERATION_GET, session_input)
        self.assertEqual("session-1", provider.get(session_input).session_id)
        self.assertEqual(app.STATE_SUSPENDED, provider.suspend(session_input).state)
        self.assertEqual(app.STATE_READY, provider.resume(session_input).state)
        listed = provider.list(
            app.MicroVMProviderListInput(
                request_id="req-list",
                tenant_id="tenant-1",
                namespace="namespace-1",
                auth_context=app.MicroVMAuthContext(subject="subject-1", tenant_id="tenant-1", namespace="namespace-1"),
            )
        )
        self.assertEqual(1, len(listed.sessions))
        token_input = app.MicroVMProviderTokenInput(
            request_id="req-token",
            tenant_id="tenant-1",
            namespace="namespace-1",
            auth_context=app.MicroVMAuthContext(subject="subject-1", tenant_id="tenant-1", namespace="namespace-1"),
            binding=binding,
            ttl_seconds=120,
            allowed_port_scope=[app.MicroVMProviderPortScope(port=443)],
        )
        app.validate_microvm_provider_token_input(app.OPERATION_AUTH_TOKEN, token_input)
        token = provider.create_auth_token(token_input)
        app.validate_microvm_provider_token(token)
        token_metadata = app.microvm_session_token_metadata_from_provider_token(token)
        app.validate_microvm_session_token_metadata(token_metadata)
        self.assertEqual("auth-000001", token.token_id)
        self.assertEqual(["ports:443"], token.scope)
        shell = provider.create_shell_token(
            app.MicroVMProviderTokenInput(
                request_id="req-shell",
                tenant_id="tenant-1",
                namespace="namespace-1",
                auth_context=app.MicroVMAuthContext(subject="subject-1", tenant_id="tenant-1", namespace="namespace-1"),
                binding=binding,
            )
        )
        self.assertEqual(["shell"], shell.scope)
        self.assertEqual(app.STATE_TERMINATED, provider.terminate(session_input).state)
        self.assertEqual(
            [
                app.OPERATION_RUN,
                app.OPERATION_GET,
                app.OPERATION_SUSPEND,
                app.OPERATION_RESUME,
                app.OPERATION_LIST,
                app.OPERATION_AUTH_TOKEN,
                app.OPERATION_SHELL_TOKEN,
                app.OPERATION_TERMINATE,
            ],
            [call.operation for call in provider.calls()],
        )
        provider.set_operation_error(app.OPERATION_GET, app.MicroVMSafeError("raw", "raw"))
        with self.assertRaises(app.MicroVMSafeError) as ctx:
            provider.get(session_input)
        self.assertEqual(app.MICROVM_ERROR_PROVIDER_OPERATION_FAILED, ctx.exception.code)

        class StubProviderClient:
            def __init__(self) -> None:
                self.calls: list[tuple[str, dict[str, object]]] = []
                self.state = "RUNNING"

            def _record(self) -> dict[str, object]:
                return {
                    "microvmId": "provider-1",
                    "state": self.state,
                    "imageArn": "image-ref",
                    "imageVersion": "1",
                    "startedAt": 0.0,
                }

            def run_microvm(self, **payload: object) -> dict[str, object]:
                self.calls.append(("run_microvm", payload))
                self.state = "RUNNING"
                return self._record()

            def get_microvm(self, **payload: object) -> dict[str, object]:
                self.calls.append(("get_microvm", payload))
                return self._record()

            def list_microvms(self, **payload: object) -> dict[str, object]:
                self.calls.append(("list_microvms", payload))
                return {"items": [self._record(), {"microvmId": "provider-other", "state": "RUNNING"}]}

            def suspend_microvm(self, **payload: object) -> dict[str, object]:
                self.calls.append(("suspend_microvm", payload))
                self.state = "SUSPENDED"
                return {}

            def resume_microvm(self, **payload: object) -> dict[str, object]:
                self.calls.append(("resume_microvm", payload))
                self.state = "RUNNING"
                return {}

            def terminate_microvm(self, **payload: object) -> dict[str, object]:
                self.calls.append(("terminate_microvm", payload))
                self.state = "TERMINATED"
                return {}

            def create_microvm_auth_token(self, **payload: object) -> dict[str, object]:
                self.calls.append(("create_microvm_auth_token", payload))
                return {"authToken": {"issued": True}}

            def create_microvm_shell_auth_token(self, **payload: object) -> dict[str, object]:
                self.calls.append(("create_microvm_shell_auth_token", payload))
                return {"authToken": {"issued": True}}

        aws_provider = object.__new__(app.AWSLambdaMicroVMProvider)
        stub = StubProviderClient()
        aws_provider._client = stub
        aws_provider._clock = lambda: 0.0
        run = aws_provider.run(provider_run)
        aws_binding = app.MicroVMProviderSessionBinding(
            "tenant-1", "namespace-1", "session-1", run.provider_microvm_id, 1
        )
        aws_session_input = app.MicroVMProviderSessionInput(
            "req-get",
            "tenant-1",
            "namespace-1",
            app.MicroVMAuthContext(subject="subject-1", tenant_id="tenant-1", namespace="namespace-1"),
            aws_binding,
        )
        self.assertEqual("session-1", aws_provider.get(aws_session_input).session_id)
        listed = aws_provider.list(
            app.MicroVMProviderListInput(
                "req-list",
                "tenant-1",
                "namespace-1",
                app.MicroVMAuthContext(subject="subject-1", tenant_id="tenant-1", namespace="namespace-1"),
                known_sessions=[aws_binding],
            )
        )
        self.assertEqual(1, len(listed.sessions))
        aws_provider.suspend(aws_session_input)
        aws_provider.resume(aws_session_input)
        aws_provider.terminate(aws_session_input)
        token = aws_provider.create_auth_token(token_input)
        shell = aws_provider.create_shell_token(
            app.MicroVMProviderTokenInput(
                "req-shell",
                "tenant-1",
                "namespace-1",
                app.MicroVMAuthContext(subject="subject-1", tenant_id="tenant-1", namespace="namespace-1"),
                aws_binding,
            )
        )
        self.assertNotIn("issued", repr(token))
        self.assertNotIn("issued", repr(shell))
        self.assertEqual(
            [
                "run_microvm",
                "get_microvm",
                "list_microvms",
                "suspend_microvm",
                "get_microvm",
                "resume_microvm",
                "get_microvm",
                "terminate_microvm",
                "get_microvm",
                "create_microvm_auth_token",
                "create_microvm_shell_auth_token",
            ],
            [name for name, _payload in stub.calls],
        )
        self.assertEqual("image-ref", stub.calls[0][1]["imageIdentifier"])
        self.assertEqual([{"port": 443}], stub.calls[-2][1]["allowedPorts"])

    def test_provider_validation_fail_closed(self) -> None:
        self.assertEqual((app.STATE_READY, False), app.map_microvm_provider_state("READY"))
        for provider_state in ["", "unknown"]:
            with self.assertRaises(app.MicroVMSafeError):
                app.map_microvm_provider_state(provider_state)

        valid_session = app.MicroVMProviderSession(
            "tenant-1",
            "namespace-1",
            "session-1",
            "microvm-1",
            app.STATE_RUNNING,
            "running",
        )
        app.validate_microvm_provider_session(valid_session)
        for bad_session in [
            app.MicroVMProviderSession("tenant-1", "namespace-1", "session-1", "", app.STATE_RUNNING, "running"),
            app.MicroVMProviderSession("tenant-1", "namespace-1", "session-1", "microvm-1", app.STATE_READY, "running"),
            app.MicroVMProviderSession(
                "tenant-1",
                "namespace-1",
                "session-1",
                "raw_sdk_client",
                app.STATE_RUNNING,
                "running",
            ),
        ]:
            with self.assertRaises(app.MicroVMSafeError):
                app.validate_microvm_provider_session(bad_session)

        valid_token = app.MicroVMProviderToken(
            "tenant-1",
            "namespace-1",
            "session-1",
            "microvm-1",
            "auth-safe",
            "auth",
            10.0,
            ["ports:443"],
        )
        app.validate_microvm_provider_token(valid_token)
        for bad_token in [
            app.MicroVMProviderToken("tenant-1", "namespace-1", "session-1", "microvm-1", "", "auth", 10.0),
            app.MicroVMProviderToken(
                "tenant-1",
                "namespace-1",
                "session-1",
                "microvm-1",
                "bearer_token",
                "auth",
                10.0,
                ["ports:443"],
            ),
        ]:
            with self.assertRaises(app.MicroVMSafeError):
                app.validate_microvm_provider_token(bad_token)

    def test_provider_input_validation_fail_closed(self) -> None:
        binding_dict, run_dict, session_dict, list_dict, token_dict = self._provider_dict_inputs()
        app.validate_microvm_provider_run_input(run_dict)
        app.validate_microvm_provider_session_input(app.OPERATION_GET, session_dict)
        app.validate_microvm_provider_list_input(list_dict)
        app.validate_microvm_provider_token_input(app.OPERATION_AUTH_TOKEN, token_dict)
        app.validate_microvm_provider_token_input(
            app.OPERATION_SHELL_TOKEN,
            {**token_dict, "request_id": "req-shell-dict", "allowed_port_scope": [], "ttl_seconds": 0},
        )

        invalid_run_cases = [
            {**run_dict, "request_id": ""},
            {**run_dict, "session_id": ""},
            {**run_dict, "image_ref": "raw_sdk_client"},
            {
                **run_dict,
                "auth_context": {"subject": "subject-1", "tenant_id": "other", "namespace": "namespace-1"},
            },
            {
                **run_dict,
                "auth_context": {"subject": "", "tenant_id": "tenant-1", "namespace": "namespace-1"},
            },
            {**run_dict, "session_spec": {"metadata": {"authorization": "redacted"}}},
            {**run_dict, "network_connector_ref": "raw_sdk_client"},
            {**run_dict, "idle_policy": {"max_idle_duration_seconds": 0, "suspended_duration_seconds": 120}},
            {**run_dict, "maximum_duration_seconds": -1},
        ]
        for invalid in invalid_run_cases:
            with self.assertRaises(app.MicroVMSafeError):
                app.validate_microvm_provider_run_input(invalid)
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_provider_session_input("not-real", session_dict)
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_provider_session_input(app.OPERATION_GET, {**session_dict, "request_id": ""})
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_provider_session_input(
                app.OPERATION_GET, {**session_dict, "binding": {**binding_dict, "tenant_id": "other"}}
            )
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_provider_list_input({**list_dict, "image_ref": "raw_sdk_client"})
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_provider_list_input({**list_dict, "max_results": -1})
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_provider_token_input(app.OPERATION_RUN, token_dict)
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_provider_token_input(app.OPERATION_AUTH_TOKEN, {**token_dict, "ttl_seconds": 901})
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_provider_token_input(
                app.OPERATION_AUTH_TOKEN, {**token_dict, "allowed_port_scope": []}
            )
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_provider_token_input(
                app.OPERATION_AUTH_TOKEN,
                {**token_dict, "allowed_port_scope": [{"start_port": 8081, "end_port": 8080}]},
            )
        with self.assertRaises(app.MicroVMSafeError):
            app.validate_microvm_provider_token_input(
                app.OPERATION_AUTH_TOKEN,
                {**token_dict, "allowed_port_scope": [{"all_ports": True, "port": 443}]},
            )

    def test_fake_provider_error_paths_remain_sanitized(self) -> None:
        binding_dict, run_dict, session_dict, list_dict, token_dict = self._provider_dict_inputs()
        fake = app.create_fake_microvm_provider(now=1.0)
        fake.set_now(2.0)
        fake.set_now(-1.0)
        fake.set_operation_error("not-real", app.MicroVMSafeError("raw", "raw"))
        fake.set_operation_error(app.OPERATION_GET, None)
        run = fake.run(run_dict)
        with self.assertRaises(app.MicroVMSafeError):
            fake.run(run_dict)
        with self.assertRaises(app.MicroVMSafeError):
            fake.get({**session_dict, "binding": {**binding_dict, "provider_microvm_id": "wrong"}})
        fake.set_operation_error(app.OPERATION_LIST, app.MicroVMSafeError("raw", "raw"))
        with self.assertRaises(app.MicroVMSafeError):
            fake.list(list_dict)
        fake.set_operation_error(app.OPERATION_LIST, None)
        self.assertEqual(1, len(fake.list(list_dict).sessions))
        fake.set_operation_error(app.OPERATION_SUSPEND, app.MicroVMSafeError("raw", "raw"))
        with self.assertRaises(app.MicroVMSafeError):
            fake.suspend({**session_dict, "binding": {**binding_dict, "provider_microvm_id": run.provider_microvm_id}})
        fake.set_operation_error(app.OPERATION_SUSPEND, None)
        fake.set_operation_error(app.OPERATION_AUTH_TOKEN, app.MicroVMSafeError("raw", "raw"))
        with self.assertRaises(app.MicroVMSafeError):
            fake.create_auth_token(
                {**token_dict, "binding": {**binding_dict, "provider_microvm_id": run.provider_microvm_id}}
            )
        fake.set_operation_error(app.OPERATION_AUTH_TOKEN, None)

    def test_official_sdk_provider_gate_and_safe_mapping(self) -> None:
        binding_dict, run_dict, session_dict, list_dict, token_dict = self._provider_dict_inputs()
        required_operations = _required_lambda_microvm_operations()
        clients: list[_OfficialMicroVMClientStub] = []
        with patch.dict(sys.modules, _fake_lambda_microvm_sdk_modules(self, clients, required_operations)):
            official = app.create_aws_lambda_microvm_provider(region_name="us-west-2", clock=lambda: -5.0)
            official_run = official.run(run_dict)
            official_binding = {**binding_dict, "provider_microvm_id": official_run.provider_microvm_id}
            official_session = {**session_dict, "binding": official_binding}
            self.assertEqual("session-1", official.get(official_session).session_id)
            listed = official.list({**list_dict, "known_sessions": [official_binding]})
            self.assertEqual(1, len(listed.sessions))
            self.assertEqual(app.STATE_SUSPENDED, official.suspend(official_session).state)
            self.assertEqual(app.STATE_RUNNING, official.resume(official_session).state)
            self.assertEqual(app.STATE_TERMINATED, official.terminate(official_session).state)
            token = official.create_auth_token({**token_dict, "binding": official_binding})
            self.assertEqual(61.0, token.expires_at)
            self.assertEqual(["ports:*", "ports:8080-8081"], token.scope)
            self.assertNotIn("issued", repr(token))
            clients[0].auth_token = {}
            with self.assertRaises(app.MicroVMSafeError):
                official.create_shell_token({**token_dict, "binding": official_binding, "allowed_port_scope": []})
            self.assertEqual(
                {"imageIdentifier": "image-ref", "imageVersion": "1", "maxResults": 5}, clients[0].calls[2][1]
            )
            self.assertEqual(
                [{"allPorts": {}}, {"range": {"startPort": 8080, "endPort": 8081}}],
                clients[0].calls[-2][1]["allowedPorts"],
            )

        clients = []
        with patch.dict(
            sys.modules,
            _fake_lambda_microvm_sdk_modules(self, clients, required_operations - {"RunMicrovm"}),
        ):
            with self.assertRaises(app.MicroVMSafeError) as ctx:
                app.create_aws_lambda_microvm_provider(region_name="us-west-2")
            self.assertEqual(app.MICROVM_ERROR_PROVIDER_OPERATION_FAILED, ctx.exception.code)

        with (
            patch.dict(
                sys.modules,
                _fake_lambda_microvm_sdk_modules(self, clients, required_operations, services=[]),
            ),
            self.assertRaises(app.MicroVMSafeError),
        ):
            app.create_aws_lambda_microvm_provider(region_name="us-west-2")


class MicroVMRealContractTests(unittest.TestCase):
    def test_real_operation_contract_validates_safety_boundaries(self) -> None:
        lifecycle = microvm_mod.default_microvm_real_lifecycle_contract()
        microvm_mod.validate_microvm_real_lifecycle_contract(lifecycle)
        self.assertIn(microvm_mod.HOOK_RUN, [hook.name for hook in lifecycle.hooks])
        self.assertNotIn(app.HOOK_START, [hook.name for hook in lifecycle.hooks])

        lifecycle.hooks.append(
            app.MicroVMLifecycleHookSpec(
                app.HOOK_START,
                "synthetic",
                microvm_mod.STATE_RUNNING,
                app.STATE_READY,
                app.STATE_FAILED,
            )
        )
        with self.assertRaises(app.MicroVMSafeError) as ctx:
            microvm_mod.validate_microvm_real_lifecycle_contract(lifecycle)
        self.assertEqual(microvm_mod.MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE, ctx.exception.code)

        contract = microvm_mod.default_microvm_operation_contract()
        microvm_mod.validate_microvm_operation_contract(contract)
        self.assertEqual(
            [
                microvm_mod.OPERATION_RUN,
                microvm_mod.OPERATION_GET,
                microvm_mod.OPERATION_LIST,
                microvm_mod.OPERATION_SUSPEND,
                microvm_mod.OPERATION_RESUME,
                microvm_mod.OPERATION_TERMINATE,
                microvm_mod.OPERATION_AUTH_TOKEN,
                microvm_mod.OPERATION_SHELL_TOKEN,
            ],
            contract["operations"],
        )

        missing_operation = microvm_mod.default_microvm_operation_contract()
        missing_operation["operations"] = [
            operation for operation in missing_operation["operations"] if operation != microvm_mod.OPERATION_SHELL_TOKEN
        ]
        with self.assertRaises(app.MicroVMSafeError) as ctx:
            microvm_mod.validate_microvm_operation_contract(missing_operation)
        self.assertEqual(microvm_mod.MICROVM_ERROR_OPERATION_CONTRACT_INCOMPLETE, ctx.exception.code)

        unsafe_route = microvm_mod.default_microvm_operation_contract()
        unsafe_route["routes"][0]["auth_required"] = False
        with self.assertRaises(app.MicroVMSafeError) as ctx:
            microvm_mod.validate_microvm_operation_contract(unsafe_route)
        self.assertEqual(app.MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER, ctx.exception.code)

        unsafe_token = microvm_mod.default_microvm_operation_contract()
        unsafe_token["token_issuance"][0]["result_fields"].append("token_value")
        with self.assertRaises(app.MicroVMSafeError) as ctx:
            microvm_mod.validate_microvm_operation_contract(unsafe_token)
        self.assertEqual(microvm_mod.MICROVM_ERROR_TOKEN_SAFETY_VIOLATION, ctx.exception.code)

        unsafe_tenant = microvm_mod.default_microvm_operation_contract()
        unsafe_tenant["tenant_binding"][1]["allowed"] = True
        with self.assertRaises(app.MicroVMSafeError) as ctx:
            microvm_mod.validate_microvm_operation_contract(unsafe_tenant)
        self.assertEqual(microvm_mod.MICROVM_ERROR_TENANT_BINDING_VIOLATION, ctx.exception.code)

        bad_provider = microvm_mod.default_microvm_operation_contract()
        bad_provider["provider_state_mappings"][0]["state"] = app.STATE_STARTED
        with self.assertRaises(app.MicroVMSafeError) as ctx:
            microvm_mod.validate_microvm_operation_contract(bad_provider)
        self.assertEqual(microvm_mod.MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE, ctx.exception.code)


if __name__ == "__main__":
    unittest.main()
