from __future__ import annotations

import unittest

import apptheory as app


class MicroVMLifecycleTests(unittest.TestCase):
    def test_lifecycle_adapter_runs_to_terminal_states(self) -> None:
        contract = app.default_microvm_lifecycle_contract()
        app.validate_microvm_lifecycle_contract(contract)
        adapter = app.create_microvm_lifecycle_adapter(
            contract=contract,
            handlers={
                hook: lambda _event: None
                for hook in [
                    app.HOOK_PREPARE_IMAGE,
                    app.HOOK_START,
                    app.HOOK_READINESS,
                    app.HOOK_STOP,
                    app.HOOK_TEARDOWN,
                    app.HOOK_FAILURE,
                ]
            },
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
            handlers={
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


if __name__ == "__main__":
    unittest.main()
