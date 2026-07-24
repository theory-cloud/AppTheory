from __future__ import annotations

# ruff: noqa: F401
import hashlib
import json as jsonlib
import os
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Literal, cast

MICROVM_CONTRACT_NAME = "apptheory.lambda_microvm"
MICROVM_CONTRACT_VERSION = "m15.microvm/v1"
MICROVM_ENV_EXECUTION_ROLE_ARN = "APPTHEORY_MICROVM_EXECUTION_ROLE_ARN"
MICROVM_ENV_LOGGING = "APPTHEORY_MICROVM_LOGGING"
MICROVM_ENV_IMAGE_REF = "APPTHEORY_MICROVM_IMAGE_REF"
MICROVM_ENV_NETWORK_CONNECTOR_REFS = "APPTHEORY_MICROVM_NETWORK_CONNECTOR_REFS"
MICROVM_ENV_INGRESS_NETWORK_CONNECTOR_REFS = "APPTHEORY_MICROVM_INGRESS_NETWORK_CONNECTOR_REFS"
MICROVM_ENV_EGRESS_NETWORK_CONNECTOR_REFS = "APPTHEORY_MICROVM_EGRESS_NETWORK_CONNECTOR_REFS"

MICROVM_ERROR_INVALID_CONTRACT = "m15.microvm.invalid_contract"
MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH = "m15.microvm.raw_sdk_escape_hatch"
MICROVM_ERROR_LIFECYCLE_BYPASS = "m15.microvm.lifecycle_bypass"
MICROVM_ERROR_LIFECYCLE_INCOMPLETE = "m15.microvm.lifecycle_incomplete"
MICROVM_ERROR_FORBIDDEN_FIELD = "m15.microvm.forbidden_field"
MICROVM_ERROR_INVALID_LIFECYCLE_EVENT = "m15.microvm.invalid_lifecycle_event"
MICROVM_ERROR_LIFECYCLE_HOOK_FAILED = "m15.microvm.lifecycle_hook_failed"

HOOK_PREPARE_IMAGE = "prepare_image"
HOOK_START = "start"
HOOK_READINESS = "readiness"
HOOK_STOP = "stop"
HOOK_TEARDOWN = "teardown"
HOOK_FAILURE = "failure"

STATE_REQUESTED = "requested"
STATE_IMAGE_PREPARING = "image_preparing"
STATE_IMAGE_PREPARED = "image_prepared"
STATE_STARTING = "starting"
STATE_STARTED = "started"
STATE_READINESS_PROBING = "readiness_probing"
STATE_READY = "ready"
STATE_STOPPING = "stopping"
STATE_STOPPED = "stopped"
STATE_TEARING_DOWN = "tearing_down"
STATE_TERMINATED = "terminated"
STATE_FAILED = "failed"

MICROVM_CONTRACT_VERSION_M16 = "m16.microvm/v1"
MICROVM_ERROR_OPERATION_CONTRACT_INCOMPLETE = "m16.microvm.operation_contract_incomplete"
MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE = "m16.microvm.route_contract_incomplete"
MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE = "m16.microvm.provider_state_mapping_incomplete"
MICROVM_ERROR_TOKEN_SAFETY_VIOLATION = "m16.microvm.token_safety_violation"  # noqa: S105
MICROVM_ERROR_TENANT_BINDING_VIOLATION = "m16.microvm.tenant_binding_violation"
MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE = "m16.microvm.lifecycle_incomplete"
MICROVM_ERROR_PROVIDER_REQUEST_INVALID = "m16.microvm.provider_request_invalid"
MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED = "m16.microvm.provider_operation_unsupported"
MICROVM_ERROR_PROVIDER_OPERATION_FAILED = "m16.microvm.provider_operation_failed"

OPERATION_RUN = "run"
OPERATION_GET = "get"
OPERATION_LIST = "list"
OPERATION_SUSPEND = "suspend"
OPERATION_RESUME = "resume"
OPERATION_TERMINATE = "terminate"
OPERATION_INVOKE = "invoke"
OPERATION_AUTH_TOKEN = "auth-token"  # noqa: S105
OPERATION_SHELL_AUTH_TOKEN = "shell-auth-token"  # noqa: S105
OPERATION_SHELL_TOKEN = OPERATION_SHELL_AUTH_TOKEN
OPERATION_LEGACY_SHELL_TOKEN = "shell-token"  # noqa: S105

HOOK_VALIDATE = "validate"
HOOK_RUN = "run"
HOOK_READY = "ready"
HOOK_SUSPEND = "suspend"
HOOK_RESUME = "resume"
HOOK_TERMINATE = "terminate"

STATE_VALIDATING = "validating"
STATE_VALIDATED = "validated"
STATE_RUNNING = "running"
STATE_SUSPENDING = "suspending"
STATE_SUSPENDED = "suspended"
STATE_RESUMING = "resuming"
STATE_TERMINATING = "terminating"

MicroVMLifecycleHook = Literal["prepare_image", "start", "readiness", "stop", "teardown", "failure"]
MicroVMLifecycleState = Literal[
    "requested",
    "image_preparing",
    "image_prepared",
    "starting",
    "started",
    "readiness_probing",
    "ready",
    "stopping",
    "stopped",
    "tearing_down",
    "terminated",
    "failed",
]
MicroVMLifecycleHandler = Callable[["MicroVMLifecycleEvent"], None]


@dataclass(slots=True)
class MicroVMSafeError(Exception):
    code: str
    message: str
    request_id: str = ""

    def __post_init__(self) -> None:
        self.code = str(self.code or "").strip()
        self.message = str(self.message or "").strip()
        self.request_id = str(self.request_id or "").strip()
        Exception.__init__(self, self.message)

    def __str__(self) -> str:
        return self.message or self.code


@dataclass(slots=True)
class MicroVMEscapeHatches:
    raw_aws_sdk: bool = False
    raw_lifecycle_hook_bypass: bool = False


@dataclass(slots=True)
class MicroVMLifecycleHookSpec:
    name: str
    phase: str
    state: str
    success_state: str
    failure_state: str


@dataclass(slots=True)
class MicroVMLifecycleTransition:
    from_state: str
    hook: str
    to: str


@dataclass(slots=True)
class MicroVMLifecycleContract:
    hooks: list[MicroVMLifecycleHookSpec] = field(default_factory=list)
    states: list[str] = field(default_factory=list)
    terminal_states: list[str] = field(default_factory=list)
    transitions: list[MicroVMLifecycleTransition] = field(default_factory=list)


@dataclass(slots=True)
class MicroVMLifecycleEvent:
    request_id: str
    tenant_id: str
    namespace: str
    session_id: str
    hook: str
    state: str
    metadata: dict[str, str] | None = None


@dataclass(slots=True)
class MicroVMLifecycleResult:
    request_id: str
    tenant_id: str
    namespace: str
    session_id: str
    hook: str
    previous_state: str
    state: str
    metadata: dict[str, str] | None = None
    error: MicroVMSafeError | None = None


class MicroVMLifecycleAdapter:
    def __init__(
        self,
        contract: MicroVMLifecycleContract | dict[str, Any] | None = None,
        handlers: dict[str, MicroVMLifecycleHandler] | None = None,
    ) -> None:
        self.contract = _coerce_lifecycle_contract(contract or default_microvm_lifecycle_contract())
        self.handlers: dict[str, MicroVMLifecycleHandler] = {}
        for hook, handler in dict(handlers or {}).items():
            normalized_hook = _normalize_hook(hook)
            if normalized_hook and handler is not None:
                self.handlers[normalized_hook] = handler
        _validate_lifecycle_adapter_contract(self.contract)

    def handle(self, event: MicroVMLifecycleEvent | dict[str, Any]) -> MicroVMLifecycleResult:
        try:
            _validate_lifecycle_adapter_contract(self.contract)
        except Exception as exc:  # noqa: BLE001
            safe = _lifecycle_contract_validation_error(exc, _event_request_id(event))
            return _lifecycle_error_result(event, STATE_FAILED, safe)

        normalized = _normalize_lifecycle_event(event)
        if isinstance(normalized, MicroVMSafeError):
            return _lifecycle_error_result(event, STATE_FAILED, normalized)

        index = _lifecycle_contract_index(self.contract)
        spec = index.hooks.get(normalized.hook)
        if spec is None:
            safe = _safe_error(
                MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
                "apptheory: microvm lifecycle hook is unsupported",
                normalized.request_id,
            )
            return _lifecycle_error_result(normalized, STATE_FAILED, safe)

        active_state = _next_state(index.transitions.list, normalized.state, normalized.hook)
        if not active_state:
            safe = _safe_error(
                MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
                "apptheory: microvm lifecycle transition is unsupported",
                normalized.request_id,
            )
            return _lifecycle_error_result(normalized, STATE_FAILED, safe)
        if normalized.hook != HOOK_FAILURE and active_state != spec.state:
            safe = _safe_error(
                MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
                "apptheory: microvm lifecycle transition is not the hook active state",
                normalized.request_id,
            )
            return _lifecycle_error_result(normalized, STATE_FAILED, safe)

        handler = self.handlers.get(normalized.hook)
        if handler is None:
            safe = _safe_error(
                MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
                "apptheory: microvm lifecycle hook handler is missing",
                normalized.request_id,
            )
            return _lifecycle_error_result(normalized, spec.failure_state, safe)

        handler_event = _clone_lifecycle_event(normalized)
        handler_event.state = active_state
        try:
            handler(handler_event)
        except Exception:  # noqa: BLE001
            safe = _safe_error(
                MICROVM_ERROR_LIFECYCLE_HOOK_FAILED,
                "apptheory: microvm lifecycle hook failed",
                normalized.request_id,
            )
            return _lifecycle_error_result(normalized, spec.failure_state, safe)

        state = STATE_FAILED if normalized.hook == HOOK_FAILURE else spec.success_state
        if normalized.hook != HOOK_FAILURE and not index.transitions.has(active_state, normalized.hook, state):
            safe = _safe_error(
                MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
                "apptheory: microvm lifecycle success transition is unsupported",
                normalized.request_id,
            )
            return _lifecycle_error_result(normalized, spec.failure_state, safe)
        return _build_lifecycle_result(normalized, state)


def create_microvm_lifecycle_adapter(
    *,
    contract: MicroVMLifecycleContract | dict[str, Any] | None = None,
    handlers: dict[str, MicroVMLifecycleHandler] | None = None,
) -> MicroVMLifecycleAdapter:
    return MicroVMLifecycleAdapter(contract=contract, handlers=handlers)


def validate_microvm_escape_hatches(escape_hatches: MicroVMEscapeHatches | dict[str, Any]) -> None:
    hatches = _coerce_escape_hatches(escape_hatches)
    if hatches.raw_aws_sdk:
        raise _safe_error(
            MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH,
            "apptheory: microvm contract forbids raw AWS SDK escape hatch",
            "",
        )
    if hatches.raw_lifecycle_hook_bypass:
        raise _safe_error(
            MICROVM_ERROR_LIFECYCLE_BYPASS,
            "apptheory: microvm contract forbids raw lifecycle hook bypass",
            "",
        )


def default_microvm_lifecycle_contract() -> MicroVMLifecycleContract:
    return MicroVMLifecycleContract(
        hooks=[
            MicroVMLifecycleHookSpec(
                HOOK_PREPARE_IMAGE, "image_preparation", STATE_IMAGE_PREPARING, STATE_IMAGE_PREPARED, STATE_FAILED
            ),
            MicroVMLifecycleHookSpec(HOOK_START, "start", STATE_STARTING, STATE_STARTED, STATE_FAILED),
            MicroVMLifecycleHookSpec(HOOK_READINESS, "readiness", STATE_READINESS_PROBING, STATE_READY, STATE_FAILED),
            MicroVMLifecycleHookSpec(HOOK_STOP, "stop", STATE_STOPPING, STATE_STOPPED, STATE_FAILED),
            MicroVMLifecycleHookSpec(HOOK_TEARDOWN, "teardown", STATE_TEARING_DOWN, STATE_TERMINATED, STATE_FAILED),
            MicroVMLifecycleHookSpec(HOOK_FAILURE, "failure", STATE_FAILED, STATE_FAILED, STATE_FAILED),
        ],
        states=_required_lifecycle_states(),
        terminal_states=[STATE_TERMINATED, STATE_FAILED],
        transitions=[
            MicroVMLifecycleTransition(STATE_REQUESTED, HOOK_PREPARE_IMAGE, STATE_IMAGE_PREPARING),
            MicroVMLifecycleTransition(STATE_IMAGE_PREPARING, HOOK_PREPARE_IMAGE, STATE_IMAGE_PREPARED),
            MicroVMLifecycleTransition(STATE_IMAGE_PREPARED, HOOK_START, STATE_STARTING),
            MicroVMLifecycleTransition(STATE_STARTING, HOOK_START, STATE_STARTED),
            MicroVMLifecycleTransition(STATE_STARTED, HOOK_READINESS, STATE_READINESS_PROBING),
            MicroVMLifecycleTransition(STATE_READINESS_PROBING, HOOK_READINESS, STATE_READY),
            MicroVMLifecycleTransition(STATE_READY, HOOK_STOP, STATE_STOPPING),
            MicroVMLifecycleTransition(STATE_STOPPING, HOOK_STOP, STATE_STOPPED),
            MicroVMLifecycleTransition(STATE_STOPPED, HOOK_TEARDOWN, STATE_TEARING_DOWN),
            MicroVMLifecycleTransition(STATE_TEARING_DOWN, HOOK_TEARDOWN, STATE_TERMINATED),
            MicroVMLifecycleTransition(STATE_IMAGE_PREPARING, HOOK_FAILURE, STATE_FAILED),
            MicroVMLifecycleTransition(STATE_STARTING, HOOK_FAILURE, STATE_FAILED),
            MicroVMLifecycleTransition(STATE_READINESS_PROBING, HOOK_FAILURE, STATE_FAILED),
            MicroVMLifecycleTransition(STATE_STOPPING, HOOK_FAILURE, STATE_FAILED),
            MicroVMLifecycleTransition(STATE_TEARING_DOWN, HOOK_FAILURE, STATE_FAILED),
        ],
    )


def validate_microvm_lifecycle_contract(contract: MicroVMLifecycleContract | dict[str, Any]) -> None:
    coerced = _coerce_lifecycle_contract(contract)
    hook_specs = _validate_lifecycle_hook_specs(coerced.hooks)
    _validate_lifecycle_state_lists(coerced)
    _validate_lifecycle_transition_set(hook_specs, _transition_set(coerced.transitions))


def is_microvm_terminal_state(state: str) -> bool:
    return str(state).strip() in {STATE_TERMINATED, STATE_FAILED}


def default_microvm_real_lifecycle_contract() -> MicroVMLifecycleContract:
    return MicroVMLifecycleContract(
        hooks=[
            MicroVMLifecycleHookSpec(
                HOOK_VALIDATE,
                "validation",
                STATE_VALIDATING,
                STATE_VALIDATED,
                STATE_FAILED,
            ),
            MicroVMLifecycleHookSpec(HOOK_RUN, "provider_run", STATE_RUNNING, STATE_RUNNING, STATE_FAILED),
            MicroVMLifecycleHookSpec(HOOK_READY, "provider_ready", STATE_READY, STATE_READY, STATE_FAILED),
            MicroVMLifecycleHookSpec(
                HOOK_SUSPEND,
                "provider_suspend",
                STATE_SUSPENDING,
                STATE_SUSPENDED,
                STATE_FAILED,
            ),
            MicroVMLifecycleHookSpec(HOOK_RESUME, "provider_resume", STATE_RESUMING, STATE_READY, STATE_FAILED),
            MicroVMLifecycleHookSpec(
                HOOK_TERMINATE,
                "provider_terminate",
                STATE_TERMINATING,
                STATE_TERMINATED,
                STATE_FAILED,
            ),
            MicroVMLifecycleHookSpec(HOOK_FAILURE, "failure", STATE_FAILED, STATE_FAILED, STATE_FAILED),
        ],
        states=_required_real_lifecycle_states(),
        terminal_states=[STATE_TERMINATED, STATE_FAILED],
        transitions=[
            MicroVMLifecycleTransition(STATE_REQUESTED, HOOK_VALIDATE, STATE_VALIDATING),
            MicroVMLifecycleTransition(STATE_VALIDATING, HOOK_VALIDATE, STATE_VALIDATED),
            MicroVMLifecycleTransition(STATE_VALIDATED, HOOK_RUN, STATE_RUNNING),
            MicroVMLifecycleTransition(STATE_RUNNING, HOOK_RUN, STATE_RUNNING),
            MicroVMLifecycleTransition(STATE_RUNNING, HOOK_READY, STATE_READY),
            MicroVMLifecycleTransition(STATE_READY, HOOK_READY, STATE_READY),
            MicroVMLifecycleTransition(STATE_READY, HOOK_SUSPEND, STATE_SUSPENDING),
            MicroVMLifecycleTransition(STATE_SUSPENDING, HOOK_SUSPEND, STATE_SUSPENDED),
            MicroVMLifecycleTransition(STATE_SUSPENDED, HOOK_RESUME, STATE_RESUMING),
            MicroVMLifecycleTransition(STATE_RESUMING, HOOK_RESUME, STATE_READY),
            MicroVMLifecycleTransition(STATE_READY, HOOK_TERMINATE, STATE_TERMINATING),
            MicroVMLifecycleTransition(STATE_SUSPENDED, HOOK_TERMINATE, STATE_TERMINATING),
            MicroVMLifecycleTransition(STATE_TERMINATING, HOOK_TERMINATE, STATE_TERMINATED),
            *[
                MicroVMLifecycleTransition(state, HOOK_FAILURE, STATE_FAILED)
                for state in [
                    STATE_VALIDATING,
                    STATE_RUNNING,
                    STATE_READY,
                    STATE_SUSPENDING,
                    STATE_SUSPENDED,
                    STATE_RESUMING,
                    STATE_TERMINATING,
                ]
            ],
        ],
    )


def default_microvm_operation_contract() -> dict[str, Any]:
    return {
        "operations": _required_operations(),
        "routes": [_required_operation_route(operation) for operation in _required_operations()],
        "provider_state_mappings": default_microvm_provider_state_mappings(),
        "token_issuance": [
            _required_token_issuance(OPERATION_AUTH_TOKEN),
            _required_token_issuance(OPERATION_SHELL_TOKEN),
        ],
        "tenant_binding": [
            {
                "operation": OPERATION_LIST,
                "request_tenant_id": "tenant-a",
                "request_namespace": "namespace-a",
                "record_tenant_id": "tenant-a",
                "record_namespace": "namespace-a",
                "recovery": True,
                "allowed": True,
            },
            {
                "operation": OPERATION_LIST,
                "request_tenant_id": "tenant-a",
                "request_namespace": "namespace-a",
                "record_tenant_id": "tenant-b",
                "record_namespace": "namespace-a",
                "recovery": True,
                "allowed": False,
            },
            {
                "operation": OPERATION_GET,
                "request_tenant_id": "tenant-a",
                "request_namespace": "namespace-a",
                "record_tenant_id": "tenant-b",
                "record_namespace": "namespace-a",
                "allowed": False,
            },
        ],
        "forbidden_fields": required_forbidden_microvm_operation_fields(),
    }


def default_microvm_provider_state_mappings() -> list[dict[str, Any]]:
    return [
        {"provider_state": "pending", "state": STATE_VALIDATING, "terminal": False},
        {"provider_state": "running", "state": STATE_RUNNING, "terminal": False},
        {"provider_state": "ready", "state": STATE_READY, "terminal": False},
        {"provider_state": "suspending", "state": STATE_SUSPENDING, "terminal": False},
        {"provider_state": "suspended", "state": STATE_SUSPENDED, "terminal": False},
        {"provider_state": "resuming", "state": STATE_RESUMING, "terminal": False},
        {"provider_state": "terminating", "state": STATE_TERMINATING, "terminal": False},
        {"provider_state": "terminated", "state": STATE_TERMINATED, "terminal": True},
        {"provider_state": "failed", "state": STATE_FAILED, "terminal": True},
    ]


def required_forbidden_microvm_operation_fields() -> list[str]:
    return [
        "authorization",
        "aws_access_key_id",
        "aws_secret_access_key",
        "aws_session_token",
        "bearer_token",
        "plaintext_token",
        "provider_secret",
        "raw_aws_credentials",
        "raw_lifecycle_hook_payload",
        "raw_sdk_client",
        "session_token_plaintext",
        "token_value",
        "x-amz-security-token",
    ]


def validate_microvm_real_lifecycle_contract(contract: MicroVMLifecycleContract | dict[str, Any]) -> None:
    coerced = _coerce_lifecycle_contract(contract)
    hook_specs = _validate_real_lifecycle_hook_specs(coerced.hooks)
    _validate_real_lifecycle_state_lists(coerced)
    _validate_real_lifecycle_transition_set(hook_specs, _transition_set(coerced.transitions))


def validate_microvm_operation_contract(contract: dict[str, Any]) -> None:
    raw = contract if isinstance(contract, dict) else {}
    _validate_operation_vocabulary(raw.get("operations") or [])
    _validate_operation_routes(raw.get("routes") or [])
    _validate_provider_state_mappings(raw.get("provider_state_mappings") or [])
    _validate_token_issuance_contracts(raw.get("token_issuance") or [])
    _validate_tenant_binding_rules(raw.get("tenant_binding") or [])
    _validate_forbidden_field_catalog(raw.get("forbidden_fields") or [])


def map_microvm_provider_state(provider_state: str) -> tuple[str, bool]:
    normalized = _normalize_provider_state(provider_state)
    if not normalized:
        raise _safe_error(
            MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
            "apptheory: microvm provider state is required",
            "",
        )
    for mapping in default_microvm_provider_state_mappings():
        if normalized == _normalize_provider_state(str(mapping.get("provider_state", ""))):
            return (_normalize_real_state(str(mapping.get("state", ""))), mapping.get("terminal") is True)
    raise _safe_error(
        MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
        "apptheory: microvm provider state is unsupported",
        "",
    )


def _validate_real_lifecycle_hook_specs(hooks: list[MicroVMLifecycleHookSpec]) -> dict[str, MicroVMLifecycleHookSpec]:
    hook_specs: dict[str, MicroVMLifecycleHookSpec] = {}
    for raw_hook in hooks:
        name = _normalize_real_hook(raw_hook.name)
        if name in {HOOK_START, HOOK_STOP, HOOK_PREPARE_IMAGE, HOOK_TEARDOWN}:
            raise _safe_error(
                MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
                "apptheory: microvm real lifecycle forbids synthetic lifecycle hooks",
                "",
            )
        hook = MicroVMLifecycleHookSpec(
            name=name,
            phase=str(raw_hook.phase or "").strip(),
            state=_normalize_real_state(raw_hook.state),
            success_state=_normalize_real_state(raw_hook.success_state),
            failure_state=_normalize_real_state(raw_hook.failure_state),
        )
        if not hook.name or not hook.phase or not hook.state or not hook.success_state or not hook.failure_state:
            raise _safe_error(
                MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
                "apptheory: microvm real lifecycle hooks must name phase, active state, "
                "success state, and failure state",
                "",
            )
        hook_specs[hook.name] = hook
    missing = _missing_strings(_required_real_lifecycle_hooks(), list(hook_specs))
    if missing:
        raise _safe_error(
            MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
            f"apptheory: microvm real lifecycle missing hooks: {','.join(missing)}",
            "",
        )
    return hook_specs


def _validate_real_lifecycle_state_lists(contract: MicroVMLifecycleContract) -> None:
    states = {_normalize_real_state(state) for state in contract.states if _normalize_real_state(state)}
    missing = _missing_strings(_required_real_lifecycle_states(), list(states))
    if missing:
        raise _safe_error(
            MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
            f"apptheory: microvm real lifecycle missing states: {','.join(missing)}",
            "",
        )
    terminals = {_normalize_real_state(state) for state in contract.terminal_states if _normalize_real_state(state)}
    missing_terminals = _missing_strings([STATE_TERMINATED, STATE_FAILED], list(terminals))
    if missing_terminals:
        raise _safe_error(
            MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
            f"apptheory: microvm real lifecycle missing terminal states: {','.join(missing_terminals)}",
            "",
        )


def _validate_real_lifecycle_transition_set(
    hook_specs: dict[str, MicroVMLifecycleHookSpec], transitions: _TransitionSet
) -> None:
    for spec in hook_specs.values():
        name = _normalize_real_hook(spec.name)
        if not name or name == HOOK_FAILURE:
            continue
        for required in _required_real_transitions_for_hook(name, spec.state, spec.success_state):
            if not transitions.has(required.from_state, required.hook, required.to):
                raise _safe_error(
                    MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
                    "apptheory: microvm real lifecycle missing transition "
                    f"{required.from_state}/{required.hook}/{required.to}",
                    "",
                )
    for state in [
        STATE_VALIDATING,
        STATE_RUNNING,
        STATE_READY,
        STATE_SUSPENDING,
        STATE_SUSPENDED,
        STATE_RESUMING,
        STATE_TERMINATING,
    ]:
        if not transitions.has(state, HOOK_FAILURE, STATE_FAILED):
            raise _safe_error(
                MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
                f"apptheory: microvm real lifecycle missing failure transition from {state}",
                "",
            )


def _required_real_transitions_for_hook(hook: str, active: str, success: str) -> list[MicroVMLifecycleTransition]:
    if hook == HOOK_VALIDATE:
        return [
            MicroVMLifecycleTransition(STATE_REQUESTED, hook, active),
            MicroVMLifecycleTransition(active, hook, success),
        ]
    if hook == HOOK_RUN:
        return [
            MicroVMLifecycleTransition(STATE_VALIDATED, hook, active),
            MicroVMLifecycleTransition(active, hook, success),
        ]
    if hook == HOOK_READY:
        return [
            MicroVMLifecycleTransition(STATE_RUNNING, hook, active),
            MicroVMLifecycleTransition(active, hook, success),
        ]
    if hook == HOOK_SUSPEND:
        return [
            MicroVMLifecycleTransition(STATE_READY, hook, active),
            MicroVMLifecycleTransition(active, hook, success),
        ]
    if hook == HOOK_RESUME:
        return [
            MicroVMLifecycleTransition(STATE_SUSPENDED, hook, active),
            MicroVMLifecycleTransition(active, hook, success),
        ]
    if hook == HOOK_TERMINATE:
        return [
            MicroVMLifecycleTransition(STATE_READY, hook, active),
            MicroVMLifecycleTransition(STATE_SUSPENDED, hook, active),
            MicroVMLifecycleTransition(active, hook, success),
        ]
    return []


def _validate_operation_vocabulary(operations: Any) -> None:
    seen = {_normalize_operation(operation) for operation in operations if _normalize_operation(operation)}
    missing = _missing_strings(_required_operations(), list(seen))
    if missing:
        raise _safe_error(
            MICROVM_ERROR_OPERATION_CONTRACT_INCOMPLETE,
            f"apptheory: microvm operation contract missing operations: {','.join(missing)}",
            "",
        )
    for operation in seen:
        if operation not in set(_required_operations()):
            raise _safe_error(
                MICROVM_ERROR_OPERATION_CONTRACT_INCOMPLETE,
                f"apptheory: microvm operation contract includes unsupported operation: {operation}",
                "",
            )


def _validate_operation_routes(routes: Any) -> None:
    seen: dict[str, dict[str, Any]] = {}
    for value in routes:
        route = value if isinstance(value, dict) else {}
        operation = _normalize_operation(route.get("operation", ""))
        method = str(route.get("method", "") or "").strip().upper()
        path = str(route.get("path", "") or "").strip()
        if not operation or not method or not path:
            raise _safe_error(
                MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE,
                "apptheory: microvm operation routes must define operation, method, and path",
                "",
            )
        if route.get("auth_required") is not True or str(route.get("default_auth", "")).strip().lower() != "deny":
            raise _safe_error(
                MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
                "apptheory: microvm operation routes must default to authenticated deny",
                "",
            )
        if route.get("tenant_bound") is not True:
            raise _safe_error(
                MICROVM_ERROR_TENANT_BINDING_VIOLATION,
                "apptheory: microvm operation route is not tenant-bound",
                "",
            )
        _validate_safe_result_fields(route.get("response_fields") or [])
        seen[operation] = route
    for operation in _required_operations():
        route = seen.get(operation)
        if route is None:
            raise _safe_error(
                MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE,
                f"apptheory: microvm operation contract missing route: {operation}",
                "",
            )
        expected = _required_operation_route(operation)
        method = str(route.get("method", "") or "").strip().upper()
        path = str(route.get("path", "") or "").strip()
        if method != expected["method"] or path != expected["path"]:
            raise _safe_error(
                MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE,
                f"apptheory: microvm operation route mismatch: {operation}",
                "",
            )
        if _missing_strings(expected["request_fields"], route.get("request_fields") or []) or _missing_strings(
            expected["response_fields"], route.get("response_fields") or []
        ):
            raise _safe_error(
                MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE,
                f"apptheory: microvm operation route fields incomplete: {operation}",
                "",
            )
    if seen[OPERATION_LIST].get("recovery") is not True:
        raise _safe_error(
            MICROVM_ERROR_TENANT_BINDING_VIOLATION,
            "apptheory: microvm list route must encode tenant-bound recovery semantics",
            "",
        )


def _validate_provider_state_mappings(mappings: Any) -> None:
    seen: dict[str, dict[str, Any]] = {}
    for value in mappings:
        mapping = value if isinstance(value, dict) else {}
        provider_state = str(mapping.get("provider_state", "") or "").strip().lower()
        state = _normalize_real_state(str(mapping.get("state", "") or ""))
        if not provider_state or not state:
            raise _safe_error(
                MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
                "apptheory: microvm provider state mapping is incomplete",
                "",
            )
        if state not in set(_required_real_lifecycle_states()):
            raise _safe_error(
                MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
                "apptheory: microvm provider state maps to unsupported lifecycle state",
                "",
            )
        seen[provider_state] = {
            "provider_state": provider_state,
            "state": state,
            "terminal": mapping.get("terminal") is True,
        }
    for required in default_microvm_provider_state_mappings():
        got = seen.get(required["provider_state"])
        if got is None:
            raise _safe_error(
                MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
                f"apptheory: microvm provider state mapping missing: {required['provider_state']}",
                "",
            )
        if got["state"] != required["state"] or got["terminal"] != required["terminal"]:
            raise _safe_error(
                MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
                f"apptheory: microvm provider state mapping mismatch: {required['provider_state']}",
                "",
            )


def _validate_token_issuance_contracts(tokens: Any) -> None:
    seen: dict[str, dict[str, Any]] = {}
    for value in tokens:
        token = value if isinstance(value, dict) else {}
        operation = _normalize_operation(token.get("operation", ""))
        if operation in {OPERATION_AUTH_TOKEN, OPERATION_SHELL_TOKEN}:
            seen[operation] = token
    for operation in [OPERATION_AUTH_TOKEN, OPERATION_SHELL_TOKEN]:
        token = seen.get(operation)
        if token is None:
            raise _safe_error(
                MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
                f"apptheory: microvm token issuance missing operation: {operation}",
                "",
            )
        if (
            token.get("sanitized") is not True
            or token.get("tenant_bound") is not True
            or token.get("session_bound") is not True
            or int(token.get("max_ttl_seconds") or 0) <= 0
        ):
            raise _safe_error(
                MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
                "apptheory: microvm token issuance must be sanitized, tenant-bound, session-bound, and ttl-limited",
                "",
            )
        try:
            _validate_safe_result_fields(token.get("result_fields") or [])
        except MicroVMSafeError as exc:
            raise _safe_error(
                MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
                "apptheory: microvm token issuance exposes unsafe result field",
                "",
            ) from exc
        missing_result = _missing_strings(
            ["token_id", "token_type", "expires_at", "scope"],
            token.get("result_fields") or [],
        )
        if missing_result:
            raise _safe_error(
                MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
                f"apptheory: microvm token issuance missing safe result fields: {','.join(missing_result)}",
                "",
            )
        missing_forbidden = _missing_strings(
            required_forbidden_microvm_operation_fields(),
            token.get("forbidden_fields") or [],
        )
        if missing_forbidden:
            raise _safe_error(
                MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
                f"apptheory: microvm token issuance missing forbidden fields: {','.join(missing_forbidden)}",
                "",
            )


def _validate_tenant_binding_rules(rules: Any) -> None:
    if not isinstance(rules, list) or not rules:
        raise _safe_error(
            MICROVM_ERROR_TENANT_BINDING_VIOLATION,
            "apptheory: microvm tenant binding rules are required",
            "",
        )
    has_list_recovery_deny = False
    has_get_deny = False
    for value in rules:
        rule = value if isinstance(value, dict) else {}
        operation = _normalize_operation(rule.get("operation", ""))
        request_tenant = str(rule.get("request_tenant_id", "") or "").strip()
        request_namespace = str(rule.get("request_namespace", "") or "").strip()
        record_tenant = str(rule.get("record_tenant_id", "") or "").strip()
        record_namespace = str(rule.get("record_namespace", "") or "").strip()
        if not operation or not request_tenant or not request_namespace or not record_tenant or not record_namespace:
            raise _safe_error(
                MICROVM_ERROR_TENANT_BINDING_VIOLATION,
                "apptheory: microvm tenant binding rule is incomplete",
                "",
            )
        same_binding = request_tenant == record_tenant and request_namespace == record_namespace
        if (rule.get("allowed") is True) != same_binding:
            raise _safe_error(
                MICROVM_ERROR_TENANT_BINDING_VIOLATION,
                "apptheory: microvm tenant binding rule allows cross-tenant access",
                "",
            )
        if rule.get("allowed") is not True and operation == OPERATION_LIST and rule.get("recovery") is True:
            has_list_recovery_deny = True
        if rule.get("allowed") is not True and operation == OPERATION_GET:
            has_get_deny = True
    if not has_list_recovery_deny or not has_get_deny:
        raise _safe_error(
            MICROVM_ERROR_TENANT_BINDING_VIOLATION,
            "apptheory: microvm tenant binding must deny cross-tenant list/recovery and get",
            "",
        )


def _validate_forbidden_field_catalog(fields: Any) -> None:
    missing = _missing_strings(
        required_forbidden_microvm_operation_fields(),
        fields if isinstance(fields, list) else [],
    )
    if missing:
        raise _safe_error(
            MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
            f"apptheory: microvm forbidden field catalog missing fields: {','.join(missing)}",
            "",
        )


def _validate_safe_result_fields(fields: Any) -> None:
    for result_field in fields if isinstance(fields, list) else []:
        if _forbidden_field_name(str(result_field)):
            raise _safe_error(
                MICROVM_ERROR_FORBIDDEN_FIELD,
                "apptheory: microvm contract exposes forbidden field",
                "",
            )


def _required_operations() -> list[str]:
    return [
        OPERATION_RUN,
        OPERATION_GET,
        OPERATION_LIST,
        OPERATION_SUSPEND,
        OPERATION_RESUME,
        OPERATION_TERMINATE,
        OPERATION_INVOKE,
        OPERATION_AUTH_TOKEN,
        OPERATION_SHELL_TOKEN,
    ]


def _required_real_lifecycle_hooks() -> list[str]:
    return [HOOK_VALIDATE, HOOK_RUN, HOOK_READY, HOOK_SUSPEND, HOOK_RESUME, HOOK_TERMINATE, HOOK_FAILURE]


def _required_real_lifecycle_states() -> list[str]:
    return [
        STATE_REQUESTED,
        STATE_VALIDATING,
        STATE_VALIDATED,
        STATE_RUNNING,
        STATE_READY,
        STATE_SUSPENDING,
        STATE_SUSPENDED,
        STATE_RESUMING,
        STATE_TERMINATING,
        STATE_TERMINATED,
        STATE_FAILED,
    ]


def _normalize_operation(operation: object) -> str:
    normalized = str(operation or "").strip()
    if normalized == OPERATION_LEGACY_SHELL_TOKEN:
        return OPERATION_SHELL_AUTH_TOKEN
    return normalized


def _normalize_real_hook(hook: object) -> str:
    return str(hook or "").strip()


def _normalize_real_state(state: object) -> str:
    return str(state or "").strip()


def _required_operation_route(operation: str) -> dict[str, Any]:
    if operation == OPERATION_RUN:
        return _operation_route(
            operation,
            "POST",
            "/microvms",
            ["tenant_id", "namespace", "image_ref", "network_connector_ref", "session_spec"],
            ["session_id", "provider_microvm_id", "state", "provider_state", "registry_version"],
            False,
        )
    if operation == OPERATION_LIST:
        return _operation_route(
            operation,
            "GET",
            "/microvms",
            ["tenant_id", "namespace"],
            ["sessions", "recovery_cursor"],
            True,
        )
    if operation == OPERATION_GET:
        return _operation_route(
            operation,
            "GET",
            "/microvms/{session_id}",
            ["tenant_id", "namespace", "session_id"],
            ["session_id", "provider_microvm_id", "state", "provider_state", "registry_version"],
            False,
        )
    if operation == OPERATION_SUSPEND:
        return _operation_route(
            operation,
            "POST",
            "/microvms/{session_id}/suspend",
            ["tenant_id", "namespace", "session_id"],
            ["session_id", "state", "provider_state", "registry_version"],
            False,
        )
    if operation == OPERATION_RESUME:
        return _operation_route(
            operation,
            "POST",
            "/microvms/{session_id}/resume",
            ["tenant_id", "namespace", "session_id"],
            ["session_id", "state", "provider_state", "registry_version"],
            False,
        )
    if operation == OPERATION_TERMINATE:
        return _operation_route(
            operation,
            "DELETE",
            "/microvms/{session_id}",
            ["tenant_id", "namespace", "session_id"],
            ["session_id", "state", "provider_state", "registry_version"],
            False,
        )
    if operation == OPERATION_INVOKE:
        return _operation_route(
            operation,
            "ANY",
            "/microvms/{session_id}/invoke/{proxy+}",
            ["tenant_id", "namespace", "session_id", "method", "path", "port"],
            ["status", "headers", "body"],
            False,
        )
    if operation == OPERATION_AUTH_TOKEN:
        return _operation_route(
            operation,
            "POST",
            "/microvms/{session_id}/auth-token",
            ["tenant_id", "namespace", "session_id"],
            ["token_id", "token_type", "expires_at", "scope"],
            False,
        )
    if operation == OPERATION_SHELL_TOKEN:
        return _operation_route(
            operation,
            "POST",
            "/microvms/{session_id}/shell-auth-token",
            ["tenant_id", "namespace", "session_id"],
            ["token_id", "token_type", "expires_at", "scope"],
            False,
        )
    return {}


def _operation_route(
    operation: str,
    method: str,
    path: str,
    request_fields: list[str],
    response_fields: list[str],
    recovery: bool,
) -> dict[str, Any]:
    return {
        "operation": operation,
        "method": method,
        "path": path,
        "auth_required": True,
        "default_auth": "deny",
        "tenant_bound": True,
        "recovery": recovery,
        "request_fields": request_fields,
        "response_fields": response_fields,
        "forbidden_fields": required_forbidden_microvm_operation_fields(),
    }


def _required_token_issuance(operation: str) -> dict[str, Any]:
    return {
        "operation": operation,
        "result_fields": ["token_id", "token_type", "expires_at", "scope"],
        "forbidden_fields": required_forbidden_microvm_operation_fields(),
        "sanitized": True,
        "tenant_bound": True,
        "session_bound": True,
        "max_ttl_seconds": 900,
    }


# Controller/provider helpers duplicated here for operation-contract validation helpers that live
# in the MicroVM foundation module before controller/provider declarations are imported.
MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER = "m15.microvm.unauthenticated_controller"


def _normalize_provider_state(state: str) -> str:
    return str(state or "").strip().lower().replace("_", "-")


def _safe_error(code: str, message: str, request_id: str) -> MicroVMSafeError:
    return MicroVMSafeError(code=code, message=message, request_id=request_id)


def _coerce_escape_hatches(value: MicroVMEscapeHatches | dict[str, Any]) -> MicroVMEscapeHatches:
    if isinstance(value, MicroVMEscapeHatches):
        return MicroVMEscapeHatches(
            raw_aws_sdk=bool(value.raw_aws_sdk),
            raw_lifecycle_hook_bypass=bool(value.raw_lifecycle_hook_bypass),
        )
    raw = value if isinstance(value, dict) else {}
    return MicroVMEscapeHatches(
        raw_aws_sdk=raw.get("raw_aws_sdk") is True,
        raw_lifecycle_hook_bypass=raw.get("raw_lifecycle_hook_bypass") is True,
    )


def _coerce_lifecycle_contract(value: MicroVMLifecycleContract | dict[str, Any]) -> MicroVMLifecycleContract:
    if isinstance(value, MicroVMLifecycleContract):
        return MicroVMLifecycleContract(
            hooks=[
                MicroVMLifecycleHookSpec(h.name, h.phase, h.state, h.success_state, h.failure_state)
                for h in value.hooks
            ],
            states=[str(state) for state in value.states],
            terminal_states=[str(state) for state in value.terminal_states],
            transitions=[MicroVMLifecycleTransition(t.from_state, t.hook, t.to) for t in value.transitions],
        )
    raw = value if isinstance(value, dict) else {}
    return MicroVMLifecycleContract(
        hooks=[_coerce_lifecycle_hook_spec(hook) for hook in raw.get("hooks") or []],
        states=[str(state) for state in raw.get("states") or []],
        terminal_states=[str(state) for state in raw.get("terminal_states") or []],
        transitions=[_coerce_lifecycle_transition(transition) for transition in raw.get("transitions") or []],
    )


def _coerce_lifecycle_hook_spec(value: Any) -> MicroVMLifecycleHookSpec:
    raw = value if isinstance(value, dict) else {}
    return MicroVMLifecycleHookSpec(
        name=str(raw.get("name", "")).strip(),
        phase=str(raw.get("phase", "")).strip(),
        state=str(raw.get("state", "")).strip(),
        success_state=str(raw.get("success_state", "")).strip(),
        failure_state=str(raw.get("failure_state", "")).strip(),
    )


def _coerce_lifecycle_transition(value: Any) -> MicroVMLifecycleTransition:
    raw = value if isinstance(value, dict) else {}
    return MicroVMLifecycleTransition(
        from_state=str(raw.get("from", "")).strip(),
        hook=str(raw.get("hook", "")).strip(),
        to=str(raw.get("to", "")).strip(),
    )


def _validate_lifecycle_hook_specs(
    hooks: list[MicroVMLifecycleHookSpec],
) -> dict[str, MicroVMLifecycleHookSpec]:
    hook_specs: dict[str, MicroVMLifecycleHookSpec] = {}
    for raw_hook in hooks:
        hook = MicroVMLifecycleHookSpec(
            name=_normalize_hook(raw_hook.name),
            phase=str(raw_hook.phase or "").strip(),
            state=_normalize_state(raw_hook.state),
            success_state=_normalize_state(raw_hook.success_state),
            failure_state=_normalize_state(raw_hook.failure_state),
        )
        if not hook.name or not hook.phase or not hook.state or not hook.success_state or not hook.failure_state:
            raise _safe_error(
                MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
                "apptheory: microvm lifecycle hooks must name phase, active state, success state, and failure state",
                "",
            )
        hook_specs[hook.name] = hook
    missing = _missing_strings(_required_lifecycle_hooks(), list(hook_specs.keys()))
    if missing:
        raise _safe_error(
            MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
            f"apptheory: microvm lifecycle missing hooks: {','.join(missing)}",
            "",
        )
    return hook_specs


def _validate_lifecycle_state_lists(contract: MicroVMLifecycleContract) -> None:
    missing_states = _missing_strings(
        _required_lifecycle_states(), [_normalize_state(state) for state in contract.states]
    )
    if missing_states:
        raise _safe_error(
            MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
            f"apptheory: microvm lifecycle missing states: {','.join(missing_states)}",
            "",
        )
    missing_terminal = _missing_strings(
        [STATE_TERMINATED, STATE_FAILED],
        [_normalize_state(state) for state in contract.terminal_states],
    )
    if missing_terminal:
        raise _safe_error(
            MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
            f"apptheory: microvm lifecycle missing terminal states: {','.join(missing_terminal)}",
            "",
        )


def _validate_lifecycle_transition_set(hooks: dict[str, MicroVMLifecycleHookSpec], transitions: _TransitionSet) -> None:
    for spec in hooks.values():
        if spec.name == HOOK_FAILURE:
            continue
        pre_state = _pre_state_for_hook(spec.name)
        if not transitions.has(pre_state, spec.name, spec.state):
            raise _safe_error(
                MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
                f"apptheory: microvm lifecycle missing active transition for hook {spec.name}",
                "",
            )
        if not transitions.has(spec.state, spec.name, spec.success_state):
            raise _safe_error(
                MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
                f"apptheory: microvm lifecycle missing success transition for hook {spec.name}",
                "",
            )
    _validate_lifecycle_failure_transitions(transitions)


def _validate_lifecycle_failure_transitions(transitions: _TransitionSet) -> None:
    for state in [STATE_IMAGE_PREPARING, STATE_STARTING, STATE_READINESS_PROBING, STATE_STOPPING, STATE_TEARING_DOWN]:
        if not transitions.has(state, HOOK_FAILURE, STATE_FAILED):
            raise _safe_error(
                MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
                f"apptheory: microvm lifecycle missing failure transition from {state}",
                "",
            )


def _validate_lifecycle_adapter_contract(contract: MicroVMLifecycleContract) -> None:
    if _is_real_lifecycle_contract_shape(contract):
        validate_microvm_real_lifecycle_contract(contract)
        return
    validate_microvm_lifecycle_contract(contract)


def _is_real_lifecycle_contract_shape(contract: MicroVMLifecycleContract) -> bool:
    for hook in contract.hooks:
        if _real_lifecycle_only_hook(hook.name):
            return True
    for state in contract.states:
        if _real_lifecycle_only_state(state):
            return True
    for transition in contract.transitions:
        if (
            _real_lifecycle_only_hook(transition.hook)
            or _real_lifecycle_only_state(transition.from_state)
            or _real_lifecycle_only_state(transition.to)
        ):
            return True
    return False


def _real_lifecycle_only_hook(hook: object) -> bool:
    return str(hook or "").strip() in {HOOK_VALIDATE, HOOK_RUN, HOOK_READY, HOOK_SUSPEND, HOOK_RESUME, HOOK_TERMINATE}


def _real_lifecycle_only_state(state: object) -> bool:
    return str(state or "").strip() in {
        STATE_VALIDATING,
        STATE_VALIDATED,
        STATE_RUNNING,
        STATE_SUSPENDING,
        STATE_SUSPENDED,
        STATE_RESUMING,
        STATE_TERMINATING,
    }


def _lifecycle_contract_validation_error(exc: Exception, request_id: str) -> MicroVMSafeError:
    if isinstance(exc, MicroVMSafeError):
        return _safe_error(exc.code, exc.message, request_id)
    return _safe_error(MICROVM_ERROR_LIFECYCLE_INCOMPLETE, str(exc), request_id)


def _normalize_lifecycle_event(
    event: MicroVMLifecycleEvent | dict[str, Any],
) -> MicroVMLifecycleEvent | MicroVMSafeError:
    normalized = _event_from_any(event)
    normalized.request_id = str(normalized.request_id or "").strip()
    normalized.tenant_id = str(normalized.tenant_id or "").strip()
    normalized.namespace = str(normalized.namespace or "").strip()
    normalized.session_id = str(normalized.session_id or "").strip()
    normalized.hook = _normalize_hook(normalized.hook)
    normalized.state = _normalize_state(normalized.state)
    normalized.metadata = _clone_string_map(normalized.metadata)
    if not normalized.request_id or not normalized.tenant_id or not normalized.namespace or not normalized.session_id:
        return _safe_error(
            MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
            "apptheory: microvm lifecycle envelope is incomplete",
            normalized.request_id,
        )
    if not normalized.hook or not normalized.state:
        return _safe_error(
            MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
            "apptheory: microvm lifecycle hook and state are required",
            normalized.request_id,
        )
    metadata_err = _validate_safe_metadata(normalized.metadata, normalized.request_id)
    return metadata_err or normalized


def _event_from_any(value: MicroVMLifecycleEvent | dict[str, Any]) -> MicroVMLifecycleEvent:
    if isinstance(value, MicroVMLifecycleEvent):
        return _clone_lifecycle_event(value)
    raw = value if isinstance(value, dict) else {}
    return MicroVMLifecycleEvent(
        request_id=str(raw.get("request_id", "")),
        tenant_id=str(raw.get("tenant_id", "")),
        namespace=str(raw.get("namespace", "")),
        session_id=str(raw.get("session_id", "")),
        hook=str(raw.get("hook", "")),
        state=str(raw.get("state", "")),
        metadata=_clone_string_map(raw.get("metadata") if isinstance(raw.get("metadata"), dict) else None),
    )


def _event_request_id(event: MicroVMLifecycleEvent | dict[str, Any]) -> str:
    if isinstance(event, MicroVMLifecycleEvent):
        return str(event.request_id or "").strip()
    if isinstance(event, dict):
        return str(event.get("request_id", "") or "").strip()
    return ""


def _lifecycle_error_result(
    event: MicroVMLifecycleEvent | dict[str, Any],
    state: str,
    error: MicroVMSafeError,
) -> MicroVMLifecycleResult:
    normalized = _event_from_any(event)
    return MicroVMLifecycleResult(
        request_id=str(normalized.request_id or "").strip(),
        tenant_id=str(normalized.tenant_id or "").strip(),
        namespace=str(normalized.namespace or "").strip(),
        session_id=str(normalized.session_id or "").strip(),
        hook=_normalize_hook(normalized.hook),
        previous_state=_normalize_state(normalized.state),
        state=state,
        metadata=_clone_string_map(normalized.metadata),
        error=error,
    )


def _build_lifecycle_result(event: MicroVMLifecycleEvent, state: str) -> MicroVMLifecycleResult:
    return MicroVMLifecycleResult(
        request_id=event.request_id,
        tenant_id=event.tenant_id,
        namespace=event.namespace,
        session_id=event.session_id,
        hook=event.hook,
        previous_state=event.state,
        state=state,
        metadata=_clone_string_map(event.metadata),
    )


def _required_lifecycle_hooks() -> list[str]:
    return [HOOK_PREPARE_IMAGE, HOOK_START, HOOK_READINESS, HOOK_STOP, HOOK_TEARDOWN, HOOK_FAILURE]


def _required_lifecycle_states() -> list[str]:
    return [
        STATE_REQUESTED,
        STATE_IMAGE_PREPARING,
        STATE_IMAGE_PREPARED,
        STATE_STARTING,
        STATE_STARTED,
        STATE_READINESS_PROBING,
        STATE_READY,
        STATE_STOPPING,
        STATE_STOPPED,
        STATE_TEARING_DOWN,
        STATE_TERMINATED,
        STATE_FAILED,
    ]


def _pre_state_for_hook(hook: str) -> str:
    match hook:
        case "prepare_image":
            return STATE_REQUESTED
        case "start":
            return STATE_IMAGE_PREPARED
        case "readiness":
            return STATE_STARTED
        case "stop":
            return STATE_READY
        case "teardown":
            return STATE_STOPPED
        case _:
            return ""


def _normalize_hook(hook: str) -> str:
    return str(hook or "").strip()


def _normalize_state(state: str) -> str:
    return str(state or "").strip()


@dataclass(slots=True)
class _TransitionSet:
    items: set[str]
    list: list[MicroVMLifecycleTransition]

    def has(self, from_state: str, hook: str, to: str) -> bool:
        return _transition_key(from_state, hook, to) in self.items


def _transition_set(transitions: list[MicroVMLifecycleTransition]) -> _TransitionSet:
    items: set[str] = set()
    out: list[MicroVMLifecycleTransition] = []
    for raw in transitions:
        transition = MicroVMLifecycleTransition(
            from_state=_normalize_state(raw.from_state),
            hook=_normalize_hook(raw.hook),
            to=_normalize_state(raw.to),
        )
        if not transition.from_state or not transition.hook or not transition.to:
            continue
        items.add(_transition_key(transition.from_state, transition.hook, transition.to))
        out.append(transition)
    return _TransitionSet(items=items, list=out)


def _next_state(transitions: list[MicroVMLifecycleTransition], from_state: str, hook: str) -> str:
    normalized_from = _normalize_state(from_state)
    normalized_hook = _normalize_hook(hook)
    for transition in transitions:
        if transition.from_state == normalized_from and transition.hook == normalized_hook:
            return _normalize_state(transition.to)
    return ""


def _transition_key(from_state: str, hook: str, to: str) -> str:
    return f"{from_state}\0{hook}\0{to}"


def _lifecycle_contract_index(contract: MicroVMLifecycleContract) -> _LifecycleContractIndex:
    hooks: dict[str, MicroVMLifecycleHookSpec] = {}
    for hook in contract.hooks:
        name = _normalize_hook(hook.name)
        if name:
            hooks[name] = MicroVMLifecycleHookSpec(
                name=name,
                phase=str(hook.phase or "").strip(),
                state=_normalize_state(hook.state),
                success_state=_normalize_state(hook.success_state),
                failure_state=_normalize_state(hook.failure_state),
            )
    return _LifecycleContractIndex(hooks=hooks, transitions=_transition_set(contract.transitions))


@dataclass(slots=True)
class _LifecycleContractIndex:
    hooks: dict[str, MicroVMLifecycleHookSpec]
    transitions: _TransitionSet


_FORBIDDEN_FIELD_NAMES = {
    "authorization",
    "account_wide_list_token",
    "aws_access_key_id",
    "aws_secret_access_key",
    "aws_session_token",
    "bearer_token",
    "plaintext_token",
    "provider_error",
    "provider_exception",
    "provider_secret",
    "raw_provider_error",
    "raw_provider_exception",
    "raw_aws_credentials",
    "raw_lifecycle_hook_payload",
    "raw_sdk_client",
    "session_token_plaintext",
    "token_value",
    "x-amz-security-token",
    "x-aws-proxy-auth",
    "x_aws_proxy_auth",
}


def _forbidden_field_name(name: str) -> bool:
    key = str(name or "").strip().lower()
    return bool(key) and (key in _FORBIDDEN_FIELD_NAMES or key.replace("-", "_") in _FORBIDDEN_FIELD_NAMES)


def _validate_safe_metadata(metadata: dict[str, str] | None, request_id: str) -> MicroVMSafeError | None:
    for key, value in (metadata or {}).items():
        if _forbidden_field_name(key):
            return _safe_error(
                MICROVM_ERROR_FORBIDDEN_FIELD,
                "apptheory: microvm metadata contains forbidden field",
                request_id,
            )
        if _forbidden_field_value(value):
            return _safe_error(
                MICROVM_ERROR_FORBIDDEN_FIELD,
                "apptheory: microvm metadata contains forbidden value",
                request_id,
            )
    return None


def _validate_safe_field_value(value: str, request_id: str) -> MicroVMSafeError | None:
    if _forbidden_field_name(value) or _forbidden_field_value(value):
        return _safe_error(
            MICROVM_ERROR_FORBIDDEN_FIELD,
            "apptheory: microvm field contains forbidden value",
            request_id,
        )
    return None


def _validate_execution_role_arn(value: str, request_id: str) -> MicroVMSafeError | None:
    arn = _normalize_execution_role_arn(value)
    if not arn:
        return None
    safe_err = _validate_safe_field_value(arn, request_id)
    if safe_err:
        return safe_err
    if any(ch.isspace() for ch in arn) or not arn.startswith("arn:") or ":role/" not in arn:
        return _safe_error(
            MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
            "apptheory: microvm provider execution role arn is invalid",
            request_id,
        )
    return None


def _normalize_execution_role_arn(value: str | None) -> str:
    return str(value or "").strip()


def _forbidden_field_value(value: str) -> bool:
    normalized = str(value or "").strip().lower()
    return bool(normalized) and (
        normalized.startswith("bearer ")
        or "x-aws-proxy-auth" in normalized
        or "aws_secret_access_key" in normalized
        or "aws_access_key_id" in normalized
        or "aws_session_token" in normalized
        or "raw provider exception" in normalized
        or "raw_provider_exception" in normalized
        or "raw provider error" in normalized
        or "account-wide list token" in normalized
        or "account_wide_list_token" in normalized
    )


def _clone_string_map(value: dict[str, Any] | None) -> dict[str, str] | None:
    if not value:
        return None
    out: dict[str, str] = {}
    for key, item in dict(value).items():
        trimmed = str(key or "").strip()
        if trimmed:
            out[trimmed] = str(item)
    return out or None


def _clone_lifecycle_event(event: MicroVMLifecycleEvent) -> MicroVMLifecycleEvent:
    return MicroVMLifecycleEvent(
        request_id=str(event.request_id),
        tenant_id=str(event.tenant_id),
        namespace=str(event.namespace),
        session_id=str(event.session_id),
        hook=str(event.hook),
        state=str(event.state),
        metadata=_clone_string_map(event.metadata),
    )


def _missing_strings(required: list[str], got: list[str]) -> list[str]:
    seen = {str(value or "").strip() for value in got if str(value or "").strip()}
    return sorted(value for value in required if value not in seen)


__all__ = [
    "HOOK_FAILURE",
    "HOOK_PREPARE_IMAGE",
    "HOOK_READINESS",
    "HOOK_READY",
    "HOOK_RESUME",
    "HOOK_RUN",
    "HOOK_START",
    "HOOK_STOP",
    "HOOK_SUSPEND",
    "HOOK_TEARDOWN",
    "HOOK_TERMINATE",
    "HOOK_VALIDATE",
    "MICROVM_CONTRACT_NAME",
    "MICROVM_CONTRACT_VERSION",
    "MICROVM_CONTRACT_VERSION_M16",
    "MICROVM_ENV_EGRESS_NETWORK_CONNECTOR_REFS",
    "MICROVM_ENV_EXECUTION_ROLE_ARN",
    "MICROVM_ENV_IMAGE_REF",
    "MICROVM_ENV_INGRESS_NETWORK_CONNECTOR_REFS",
    "MICROVM_ENV_LOGGING",
    "MICROVM_ENV_NETWORK_CONNECTOR_REFS",
    "MICROVM_ERROR_FORBIDDEN_FIELD",
    "MICROVM_ERROR_INVALID_CONTRACT",
    "MICROVM_ERROR_INVALID_LIFECYCLE_EVENT",
    "MICROVM_ERROR_LIFECYCLE_BYPASS",
    "MICROVM_ERROR_LIFECYCLE_HOOK_FAILED",
    "MICROVM_ERROR_LIFECYCLE_INCOMPLETE",
    "MICROVM_ERROR_OPERATION_CONTRACT_INCOMPLETE",
    "MICROVM_ERROR_PROVIDER_OPERATION_FAILED",
    "MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED",
    "MICROVM_ERROR_PROVIDER_REQUEST_INVALID",
    "MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE",
    "MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH",
    "MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE",
    "MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE",
    "MICROVM_ERROR_TENANT_BINDING_VIOLATION",
    "MICROVM_ERROR_TOKEN_SAFETY_VIOLATION",
    "MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER",
    "OPERATION_AUTH_TOKEN",
    "OPERATION_GET",
    "OPERATION_INVOKE",
    "OPERATION_LEGACY_SHELL_TOKEN",
    "OPERATION_LIST",
    "OPERATION_RESUME",
    "OPERATION_RUN",
    "OPERATION_SHELL_AUTH_TOKEN",
    "OPERATION_SHELL_TOKEN",
    "OPERATION_SUSPEND",
    "OPERATION_TERMINATE",
    "STATE_FAILED",
    "STATE_IMAGE_PREPARED",
    "STATE_IMAGE_PREPARING",
    "STATE_READINESS_PROBING",
    "STATE_READY",
    "STATE_REQUESTED",
    "STATE_RESUMING",
    "STATE_RUNNING",
    "STATE_STARTED",
    "STATE_STARTING",
    "STATE_STOPPED",
    "STATE_STOPPING",
    "STATE_SUSPENDED",
    "STATE_SUSPENDING",
    "STATE_TEARING_DOWN",
    "STATE_TERMINATED",
    "STATE_TERMINATING",
    "STATE_VALIDATED",
    "STATE_VALIDATING",
    "_FORBIDDEN_FIELD_NAMES",
    "MicroVMEscapeHatches",
    "MicroVMLifecycleAdapter",
    "MicroVMLifecycleContract",
    "MicroVMLifecycleEvent",
    "MicroVMLifecycleHandler",
    "MicroVMLifecycleHook",
    "MicroVMLifecycleHookSpec",
    "MicroVMLifecycleResult",
    "MicroVMLifecycleState",
    "MicroVMLifecycleTransition",
    "MicroVMSafeError",
    "_LifecycleContractIndex",
    "_TransitionSet",
    "_build_lifecycle_result",
    "_clone_lifecycle_event",
    "_clone_string_map",
    "_coerce_escape_hatches",
    "_coerce_lifecycle_contract",
    "_coerce_lifecycle_hook_spec",
    "_coerce_lifecycle_transition",
    "_event_from_any",
    "_event_request_id",
    "_forbidden_field_name",
    "_forbidden_field_value",
    "_is_real_lifecycle_contract_shape",
    "_lifecycle_contract_index",
    "_lifecycle_contract_validation_error",
    "_lifecycle_error_result",
    "_missing_strings",
    "_next_state",
    "_normalize_execution_role_arn",
    "_normalize_hook",
    "_normalize_lifecycle_event",
    "_normalize_operation",
    "_normalize_provider_state",
    "_normalize_real_hook",
    "_normalize_real_state",
    "_normalize_state",
    "_operation_route",
    "_pre_state_for_hook",
    "_real_lifecycle_only_hook",
    "_real_lifecycle_only_state",
    "_required_lifecycle_hooks",
    "_required_lifecycle_states",
    "_required_operation_route",
    "_required_operations",
    "_required_real_lifecycle_hooks",
    "_required_real_lifecycle_states",
    "_required_real_transitions_for_hook",
    "_required_token_issuance",
    "_safe_error",
    "_transition_key",
    "_transition_set",
    "_validate_execution_role_arn",
    "_validate_forbidden_field_catalog",
    "_validate_lifecycle_adapter_contract",
    "_validate_lifecycle_failure_transitions",
    "_validate_lifecycle_hook_specs",
    "_validate_lifecycle_state_lists",
    "_validate_lifecycle_transition_set",
    "_validate_operation_routes",
    "_validate_operation_vocabulary",
    "_validate_provider_state_mappings",
    "_validate_real_lifecycle_hook_specs",
    "_validate_real_lifecycle_state_lists",
    "_validate_real_lifecycle_transition_set",
    "_validate_safe_field_value",
    "_validate_safe_metadata",
    "_validate_safe_result_fields",
    "_validate_tenant_binding_rules",
    "_validate_token_issuance_contracts",
    "create_microvm_lifecycle_adapter",
    "default_microvm_lifecycle_contract",
    "default_microvm_operation_contract",
    "default_microvm_provider_state_mappings",
    "default_microvm_real_lifecycle_contract",
    "is_microvm_terminal_state",
    "map_microvm_provider_state",
    "required_forbidden_microvm_operation_fields",
    "validate_microvm_escape_hatches",
    "validate_microvm_lifecycle_contract",
    "validate_microvm_operation_contract",
    "validate_microvm_real_lifecycle_contract",
]
