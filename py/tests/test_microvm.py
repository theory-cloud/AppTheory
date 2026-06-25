from __future__ import annotations

import unittest

import apptheory as app
from apptheory import microvm as microvm_mod


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
            image_ref="image-ref",
            network_connector_ref="network-ref",
            controller_id="controller-1",
            created_at=1.0,
            updated_at=1.0,
            expires_at=3601.0,
            generation=1,
            last_action=app.COMMAND_CREATE,
            last_command_id="req-record",
            auth_subject="subject-1",
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
                "metadata": {"bearer_token": "secret"},
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
        registry.required_fields = registry.required_fields[:-1]
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
            self._valid_record(metadata={"bearer-token": "secret"}),
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
                "metadata": {"authorization": "secret"},
            },
        }
        self.assertEqual(app.MICROVM_ERROR_FORBIDDEN_FIELD, app.validate_microvm_controller_request(request).code)

        request = {**base_request, "session_spec": {"metadata": {"raw_sdk_client": "secret"}}}
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
        self.assertEqual(app.COMMAND_START, registry_record.last_action)

        round_trip = app.microvm_session_from_registry_record(registry_record)
        self.assertEqual(record.endpoint, round_trip.endpoint)
        self.assertEqual(record.microvm_id, round_trip.microvm_id)
        self.assertEqual(record.last_action, round_trip.last_action)

        bad = app.microvm_session_record_to_registry_record(record)
        bad.pk = "TENANT#other#NAMESPACE#namespace-1"
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

        class StubAWSClient:
            def _record(self, **payload: object) -> dict[str, object]:
                return {
                    "tenantId": payload.get("tenantId", "tenant-1"),
                    "namespace": payload.get("namespace", "namespace-1"),
                    "sessionId": payload.get("sessionId", "session-1"),
                    "state": payload.get("state", app.STATE_REQUESTED),
                    "desiredState": payload.get("desiredState", app.STATE_REQUESTED),
                    "imageRef": payload.get("imageRef", "image-ref"),
                    "networkConnectorRef": payload.get("networkConnectorRef", "network-ref"),
                    "controllerId": "controller-1",
                    "createdAt": 11,
                    "updatedAt": 12,
                    "expiresAt": 3611,
                    "generation": 2,
                }

            def create_microvm_session(self, **payload: object) -> dict[str, object]:
                return self._record(**payload)

            def start_microvm_session(self, **payload: object) -> dict[str, object]:
                return self._record(**payload, state=app.STATE_STARTING)

            def stop_microvm_session(self, **payload: object) -> dict[str, object]:
                return self._record(**payload, state=app.STATE_STOPPING)

            def get_microvm_session_status(self, **payload: object) -> dict[str, object]:
                return {
                    **self._record(**payload, state=app.STATE_STARTING, desiredState=app.STATE_STARTED),
                    "lifecycleState": app.STATE_STARTING,
                    "lastTransition": 12,
                    "registryVersion": 2,
                }

            def get_microvm_session(self, **payload: object) -> dict[str, object]:
                return self._record(**payload)

        aws_client = object.__new__(app.AWSLambdaMicroVMClient)
        aws_client._client = StubAWSClient()
        self.assertEqual(app.STATE_REQUESTED, aws_client.create(self._create_input()).state)
        self.assertEqual(
            app.STATE_STARTING,
            aws_client.start(self._command_input(desired_state=app.STATE_STARTED)).state,
        )
        self.assertEqual(
            app.STATE_STOPPING,
            aws_client.stop(self._command_input(desired_state=app.STATE_STOPPED)).state,
        )
        self.assertEqual(app.STATE_STARTING, aws_client.status(self._query_input()).lifecycle_state)
        self.assertEqual("session-1", aws_client.session(self._query_input()).session_id)

        class RaisingAWSClient:
            def get_microvm_session_status(self, **_payload: object) -> dict[str, object]:
                raise RuntimeError("raw aws error")

            def create_microvm_session(self, **_payload: object) -> dict[str, object]:
                raise RuntimeError("raw aws error")

        aws_client._client = RaisingAWSClient()
        with self.assertRaises(app.MicroVMSafeError) as ctx:
            aws_client.status(self._query_input(request_id="req-status"))
        self.assertEqual(app.MICROVM_ERROR_CONTROLLER_COMMAND_FAILED, ctx.exception.code)
        with self.assertRaises(app.MicroVMSafeError) as ctx:
            aws_client.create(self._create_input())
        self.assertEqual(app.MICROVM_ERROR_CONTROLLER_COMMAND_FAILED, ctx.exception.code)


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
