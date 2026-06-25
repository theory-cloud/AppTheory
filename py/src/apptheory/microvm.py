from __future__ import annotations

import hashlib
import json as jsonlib
import os
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

MICROVM_CONTRACT_NAME = "apptheory.lambda_microvm"
MICROVM_CONTRACT_VERSION = "m15.microvm/v1"

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
        validate_microvm_lifecycle_contract(self.contract)

    def handle(self, event: MicroVMLifecycleEvent | dict[str, Any]) -> MicroVMLifecycleResult:
        try:
            validate_microvm_lifecycle_contract(self.contract)
        except Exception as exc:  # noqa: BLE001
            safe = _safe_error(MICROVM_ERROR_LIFECYCLE_INCOMPLETE, str(exc), _event_request_id(event))
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


def validate_microvm_session_record(record: MicroVMSessionRecord) -> None:
    normalized = _normalize_session_record(record)
    if (
        not normalized.tenant_id
        or not normalized.namespace
        or not normalized.session_id
        or not normalized.state
        or not normalized.desired_state
        or not normalized.provider_id
        or not normalized.provider_state
        or not normalized.aws_lifecycle_state
        or not normalized.image_ref
        or not normalized.network_connector_ref
        or not normalized.controller_id
        or not normalized.last_action
        or not normalized.last_command_id
        or not normalized.auth_subject
    ):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session record is incomplete",
            normalized.last_command_id,
        )
    if (
        normalized.created_at <= 0
        or normalized.updated_at <= 0
        or normalized.last_observed_at <= 0
        or normalized.expires_at <= 0
        or normalized.generation <= 0
    ):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session record registry fields are incomplete",
            normalized.last_command_id,
        )
    if not _valid_microvm_command(normalized.last_action):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session record last action is unsupported",
            normalized.last_command_id,
        )
    if not _valid_lifecycle_state(normalized.state) or not _valid_lifecycle_state(normalized.desired_state):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session record state is unsupported",
            normalized.last_command_id,
        )
    provider_err = _validate_session_provider_fields(normalized)
    if provider_err:
        raise provider_err
    metadata_err = _validate_safe_metadata(normalized.metadata, normalized.last_command_id)
    if metadata_err:
        raise metadata_err
    reason_err = _validate_safe_metadata(normalized.reason_metadata, normalized.last_command_id)
    if reason_err:
        raise reason_err
    status_err = _validate_safe_metadata(normalized.status_metadata, normalized.last_command_id)
    if status_err:
        raise status_err
    reason_err = _validate_safe_metadata(normalized.reason_metadata, normalized.last_command_id)
    if reason_err:
        raise reason_err
    status_err = _validate_safe_metadata(normalized.status_metadata, normalized.last_command_id)
    if status_err:
        raise status_err


def _validate_session_provider_fields(record: MicroVMSessionRecord) -> MicroVMSafeError | None:
    fields = [
        record.endpoint,
        record.microvm_id,
        record.provider_id,
        record.provider_microvm_id,
        record.provider_state,
        record.aws_lifecycle_state,
        record.image_ref,
        record.image_version,
        record.network_connector_ref,
        *record.ingress_network_connector_refs,
        *record.egress_network_connector_refs,
    ]
    for item in fields:
        err = _validate_safe_field_value(item, record.last_command_id)
        if err:
            return err
    for token in record.token_metadata:
        try:
            validate_microvm_session_token_metadata(token, record.last_command_id)
        except MicroVMSafeError as exc:
            return exc
    return None


def validate_microvm_session_token_metadata(
    token: MicroVMSessionTokenMetadata | dict[str, Any], request_id: str = ""
) -> None:
    normalized = _normalize_session_token_metadata(token)
    if not normalized.token_id or not normalized.token_type or normalized.expires_at <= 0 or not normalized.scope:
        raise _safe_error(
            MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
            "apptheory: microvm session token metadata is incomplete",
            request_id,
        )
    for item in [normalized.token_id, normalized.token_type, *normalized.scope]:
        err = _validate_safe_field_value(item, request_id)
        if err:
            raise err


def microvm_session_token_metadata_from_provider_token(
    token: MicroVMProviderToken | dict[str, Any],
) -> MicroVMSessionTokenMetadata:
    normalized = _normalize_provider_token(token)
    validate_microvm_provider_token(normalized)
    metadata = MicroVMSessionTokenMetadata(
        token_id=normalized.token_id,
        token_type=normalized.token_type,
        expires_at=normalized.expires_at,
        scope=list(normalized.scope),
    )
    validate_microvm_session_token_metadata(metadata)
    return metadata


def validate_microvm_session_status(status: MicroVMSessionStatus) -> None:
    normalized = _normalize_session_status(status)
    if (
        not normalized.tenant_id
        or not normalized.namespace
        or not normalized.session_id
        or not normalized.state
        or not normalized.desired_state
        or not normalized.lifecycle_state
        or not normalized.last_action
        or normalized.last_transition <= 0
        or normalized.registry_version <= 0
    ):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session status is incomplete",
            "",
        )
    if (
        not _valid_lifecycle_state(normalized.state)
        or not _valid_lifecycle_state(normalized.desired_state)
        or not _valid_lifecycle_state(normalized.lifecycle_state)
    ):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session status state is unsupported",
            "",
        )
    if not _valid_microvm_command(normalized.last_action):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session status last action is unsupported",
            "",
        )


def microvm_session_key(record: MicroVMSessionRecord) -> tuple[str, str, str]:
    return (str(record.tenant_id).strip(), str(record.namespace).strip(), str(record.session_id).strip())


def microvm_session_registry_table_name() -> str:
    return (
        str(os.environ.get(MICROVM_SESSION_REGISTRY_TABLE_ENV, "") or "").strip() or MICROVM_SESSION_REGISTRY_TABLE_NAME
    )


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


def microvm_session_registry_model_definition(*, table_name: str | None = None) -> Any:
    try:
        from theorydb_py import ModelDefinition  # type: ignore[import-not-found]

        return ModelDefinition.from_dataclass(
            MicroVMSessionRegistryRecord,
            table_name=str(table_name or "").strip() or None,
        )
    except Exception as exc:
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session registry requires TableTheory model support",
            "",
        ) from exc


def validate_microvm_session_registry_record(record: MicroVMSessionRegistryRecord | dict[str, Any]) -> None:
    normalized = _normalize_session_registry_record(record)
    validate_microvm_session_record(_session_record_from_registry_no_validate(normalized))
    if not normalized.pk or not normalized.sk or normalized.ttl <= 0 or normalized.version <= 0:
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session registry keys are incomplete",
            normalized.last_command_id,
        )
    if normalized.pk != microvm_session_registry_partition_key(
        normalized.tenant_id, normalized.namespace
    ) or normalized.sk != microvm_session_registry_sort_key(normalized.session_id):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session registry tenant/session key mismatch",
            normalized.last_command_id,
        )
    if normalized.ttl != int(normalized.expires_at):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session registry ttl mismatch",
            normalized.last_command_id,
        )
    metadata_err = _validate_safe_metadata(normalized.metadata, normalized.last_command_id)
    if metadata_err:
        raise metadata_err


def microvm_session_record_to_registry_record(record: MicroVMSessionRecord) -> MicroVMSessionRegistryRecord:
    normalized = _normalize_session_record(record)
    validate_microvm_session_record(normalized)
    registry = MicroVMSessionRegistryRecord(
        pk=microvm_session_registry_partition_key(normalized.tenant_id, normalized.namespace),
        sk=microvm_session_registry_sort_key(normalized.session_id),
        tenant_id=normalized.tenant_id,
        namespace=normalized.namespace,
        session_id=normalized.session_id,
        state=normalized.state,
        desired_state=normalized.desired_state,
        endpoint=normalized.endpoint,
        microvm_id=normalized.microvm_id,
        provider_id=normalized.provider_id,
        provider_microvm_id=normalized.provider_microvm_id,
        provider_state=normalized.provider_state,
        aws_lifecycle_state=normalized.aws_lifecycle_state,
        image_ref=normalized.image_ref,
        image_version=normalized.image_version,
        network_connector_ref=normalized.network_connector_ref,
        ingress_network_connector_refs=list(normalized.ingress_network_connector_refs),
        egress_network_connector_refs=list(normalized.egress_network_connector_refs),
        controller_id=normalized.controller_id,
        created_at=normalized.created_at,
        updated_at=normalized.updated_at,
        last_observed_at=normalized.last_observed_at,
        provider_started_at=normalized.provider_started_at,
        provider_terminated_at=normalized.provider_terminated_at,
        expires_at=normalized.expires_at,
        ttl=int(normalized.expires_at),
        generation=normalized.generation,
        version=normalized.generation,
        last_action=normalized.last_action,
        last_command_id=normalized.last_command_id,
        auth_subject=normalized.auth_subject,
        reason_metadata=_clone_string_map(normalized.reason_metadata),
        status_metadata=_clone_string_map(normalized.status_metadata),
        token_metadata=_clone_session_token_metadata_list(normalized.token_metadata),
        metadata=_clone_string_map(normalized.metadata),
    )
    validate_microvm_session_registry_record(registry)
    return registry


def microvm_session_from_registry_record(record: MicroVMSessionRegistryRecord | dict[str, Any]) -> MicroVMSessionRecord:
    normalized = _normalize_session_registry_record(record)
    validate_microvm_session_registry_record(normalized)
    out = _session_record_from_registry_no_validate(normalized)
    validate_microvm_session_record(out)
    return out


class MemoryMicroVMSessionRegistry:
    def __init__(self) -> None:
        self._records: dict[tuple[str, str], MicroVMSessionRegistryRecord] = {}

    def put(self, record: MicroVMSessionRecord) -> MicroVMSessionRecord:
        registry = microvm_session_record_to_registry_record(record)
        self._records[_registry_record_key(registry)] = _clone_session_registry_record(registry)
        return microvm_session_from_registry_record(registry)

    def get(self, key: _MicroVMSessionRegistryKeyInput) -> MicroVMSessionRecord:
        normalized = _normalize_session_registry_key(key)
        record = self._records.get(_registry_key_tuple(normalized))
        if record is None:
            raise _safe_error(
                MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                "apptheory: microvm session registry record not found",
                "",
            )
        return microvm_session_from_registry_record(_clone_session_registry_record(record))

    def delete(self, key: _MicroVMSessionRegistryKeyInput) -> None:
        normalized = _normalize_session_registry_key(key)
        self._records.pop(_registry_key_tuple(normalized), None)

    def list(self, input_: MicroVMSessionListInput | dict[str, Any]) -> list[MicroVMSessionRecord]:
        normalized = _normalize_session_list_input(input_)
        out: list[MicroVMSessionRecord] = []
        for record in self._records.values():
            if record.tenant_id != normalized.tenant_id or record.namespace != normalized.namespace:
                continue
            out.append(microvm_session_from_registry_record(_clone_session_registry_record(record)))
        out.sort(key=lambda record: record.session_id)
        return out


def create_memory_microvm_session_registry() -> MemoryMicroVMSessionRegistry:
    return MemoryMicroVMSessionRegistry()


MicroVMSessionReconstructionHook = Callable[[MicroVMSessionReconstructionRequest], MicroVMSessionRecord]


def reconstruct_microvm_session_record(
    request: MicroVMSessionReconstructionRequest | dict[str, Any],
    hook: MicroVMSessionReconstructionHook | None,
) -> MicroVMSessionRecord:
    normalized = _normalize_session_reconstruction_request(request)
    _normalize_session_registry_key((normalized.tenant_id, normalized.namespace, normalized.session_id))
    if hook is None:
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm registry reconstruction requires a product hook",
            normalized.request_id,
        )
    try:
        record = hook(normalized)
    except Exception as exc:  # noqa: BLE001
        if isinstance(exc, MicroVMSafeError):
            raise _safe_error(
                MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                "apptheory: microvm registry reconstruction hook failed",
                normalized.request_id,
            ) from None
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm registry reconstruction hook failed",
            normalized.request_id,
        ) from None
    reconstructed = _normalize_session_record(record)
    if (
        reconstructed.tenant_id != normalized.tenant_id
        or reconstructed.namespace != normalized.namespace
        or reconstructed.session_id != normalized.session_id
    ):
        raise _safe_error(
            MICROVM_ERROR_TENANT_BINDING_VIOLATION,
            "apptheory: microvm registry reconstruction tenant/session mismatch",
            normalized.request_id,
        )
    validate_microvm_session_record(reconstructed)
    if normalized.now > 0 and reconstructed.expires_at <= normalized.now:
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm registry reconstruction returned stale state",
            normalized.request_id,
        )
    return reconstructed


class ReconstructingMicroVMSessionRegistry:
    def __init__(
        self,
        registry: Any,
        hook: MicroVMSessionReconstructionHook | None,
        *,
        stale_after_seconds: int = 0,
        clock: Callable[[], float] | None = None,
    ) -> None:
        if registry is None:
            raise _safe_error(
                MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                "apptheory: microvm registry reconstruction requires a session registry",
                "",
            )
        if hook is None:
            raise _safe_error(
                MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                "apptheory: microvm registry reconstruction requires a product hook",
                "",
            )
        self._registry = registry
        self._hook = hook
        self._stale_after_seconds = int(stale_after_seconds or 0) if int(stale_after_seconds or 0) > 0 else 0
        self._clock = clock or time.time

    def put(self, record: MicroVMSessionRecord) -> MicroVMSessionRecord:
        return self._registry.put(record)

    def get(self, key: _MicroVMSessionRegistryKeyInput) -> MicroVMSessionRecord:
        normalized = _normalize_session_registry_key(key)
        now = float(self._clock() or 0.0)
        existing: MicroVMSessionRecord | None = None
        try:
            record = self._registry.get(normalized)
            if not _session_record_is_stale(record, now, self._stale_after_seconds):
                return record
            existing = record
        except Exception:  # noqa: BLE001
            existing = None
        reconstructed = reconstruct_microvm_session_record(
            MicroVMSessionReconstructionRequest(
                tenant_id=normalized[0],
                namespace=normalized[1],
                session_id=normalized[2],
                now=now,
                existing=existing,
            ),
            self._hook,
        )
        return self._registry.put(reconstructed)

    def delete(self, key: _MicroVMSessionRegistryKeyInput) -> None:
        self._registry.delete(key)

    def list(self, input_: MicroVMSessionListInput | dict[str, Any]) -> list[MicroVMSessionRecord]:
        list_fn = getattr(self._registry, "list", None)
        if not callable(list_fn):
            normalized = _normalize_session_list_input(input_)
            raise _safe_error(
                MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                "apptheory: microvm registry reconstruction requires tenant-bound list support",
                normalized.request_id,
            )
        return list_fn(input_)


def create_reconstructing_microvm_session_registry(
    registry: Any,
    hook: MicroVMSessionReconstructionHook | None,
    *,
    stale_after_seconds: int = 0,
    clock: Callable[[], float] | None = None,
) -> ReconstructingMicroVMSessionRegistry:
    return ReconstructingMicroVMSessionRegistry(
        registry,
        hook,
        stale_after_seconds=stale_after_seconds,
        clock=clock,
    )


class TableTheoryMicroVMSessionRegistry:
    def __init__(self, table: Any | None = None, *, table_name: str | None = None) -> None:
        if table is None:
            try:
                from theorydb_py import Table  # type: ignore[import-not-found]

                table = Table(
                    microvm_session_registry_model_definition(),
                    table_name=str(table_name or "").strip() or microvm_session_registry_table_name(),
                )
            except Exception as exc:
                if isinstance(exc, MicroVMSafeError):
                    raise exc
                raise _safe_error(
                    MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                    "apptheory: microvm session registry requires TableTheory table support",
                    "",
                ) from exc
        self._table = table

    def put(self, record: MicroVMSessionRecord) -> MicroVMSessionRecord:
        registry = microvm_session_record_to_registry_record(record)
        try:
            put = getattr(self._table, "put", None) or getattr(self._table, "save", None)
            if not callable(put):
                raise RuntimeError("table put unavailable")
            put(registry)
            return microvm_session_from_registry_record(registry)
        except Exception as exc:
            if isinstance(exc, MicroVMSafeError):
                raise exc
            raise _session_registry_operation_error(registry.last_command_id) from None

    def get(self, key: _MicroVMSessionRegistryKeyInput) -> MicroVMSessionRecord:
        normalized = _normalize_session_registry_key(key)
        try:
            get = getattr(self._table, "get", None)
            if not callable(get):
                raise RuntimeError("table get unavailable")
            item = get(
                microvm_session_registry_partition_key(normalized[0], normalized[1]),
                microvm_session_registry_sort_key(normalized[2]),
            )
            if item is None:
                raise _safe_error(
                    MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                    "apptheory: microvm session registry record not found",
                    "",
                )
            return microvm_session_from_registry_record(item)
        except Exception as exc:
            if isinstance(exc, MicroVMSafeError):
                raise exc
            raise _session_registry_operation_error("") from None

    def delete(self, key: _MicroVMSessionRegistryKeyInput) -> None:
        normalized = _normalize_session_registry_key(key)
        try:
            delete = getattr(self._table, "delete", None)
            if not callable(delete):
                raise RuntimeError("table delete unavailable")
            delete(
                microvm_session_registry_partition_key(normalized[0], normalized[1]),
                microvm_session_registry_sort_key(normalized[2]),
            )
        except Exception as exc:
            if isinstance(exc, MicroVMSafeError):
                raise exc
            raise _session_registry_operation_error("") from None

    def list(self, input_: MicroVMSessionListInput | dict[str, Any]) -> list[MicroVMSessionRecord]:
        normalized = _normalize_session_list_input(input_)
        try:
            list_fn = getattr(self._table, "list", None) or getattr(self._table, "all", None)
            if not callable(list_fn):
                raise RuntimeError("table list unavailable")
            partition_key = microvm_session_registry_partition_key(normalized.tenant_id, normalized.namespace)
            try:
                items = list_fn(partition_key)
            except TypeError:
                items = list_fn(pk=partition_key)
            out = [microvm_session_from_registry_record(item) for item in list(items or [])]
            out.sort(key=lambda record: record.session_id)
            return out
        except Exception as exc:
            if isinstance(exc, MicroVMSafeError):
                raise exc
            raise _session_registry_operation_error(normalized.request_id) from None


def create_tabletheory_microvm_session_registry(
    table: Any | None = None, *, table_name: str | None = None
) -> TableTheoryMicroVMSessionRegistry:
    return TableTheoryMicroVMSessionRegistry(table=table, table_name=table_name)


class MicroVMRegistryClient:
    def __init__(self, registry: Any, *, ttl_seconds: int = 3600) -> None:
        if registry is None:
            raise _safe_error(
                MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
                "apptheory: microvm registry client requires a session registry",
                "",
            )
        self._registry = registry
        self._ttl_seconds = int(ttl_seconds) if int(ttl_seconds or 0) > 0 else 3600

    def create(self, input_: MicroVMCreateSessionInput) -> MicroVMSessionRecord:
        now = float(input_.now or 0) if float(input_.now or 0) > 0 else 1.0
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
            expires_at=now + self._ttl_seconds,
            generation=1,
            last_action=COMMAND_CREATE,
            last_command_id=input_.request_id,
            auth_subject=input_.auth_subject,
            metadata=_clone_string_map(input_.session_spec.metadata),
        )
        return self._registry.put(record)

    def start(self, input_: MicroVMSessionCommandInput) -> MicroVMSessionRecord:
        return self._transition(input_, COMMAND_START, STATE_STARTING, input_.desired_state)

    def stop(self, input_: MicroVMSessionCommandInput) -> MicroVMSessionRecord:
        return self._transition(input_, COMMAND_STOP, STATE_STOPPING, input_.desired_state)

    def status(self, input_: MicroVMSessionQueryInput) -> MicroVMSessionStatus:
        record = self.session(input_)
        status = MicroVMSessionStatus(
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
        validate_microvm_session_status(status)
        return status

    def session(self, input_: MicroVMSessionQueryInput) -> MicroVMSessionRecord:
        return self._registry.get((input_.tenant_id, input_.namespace, input_.session_id))

    def _transition(
        self, input_: MicroVMSessionCommandInput, action: str, state: str, desired_state: str
    ) -> MicroVMSessionRecord:
        record = self._registry.get((input_.tenant_id, input_.namespace, input_.session_id))
        next_record = _clone_session_record(record)
        next_record.state = state
        next_record.desired_state = desired_state
        next_record.provider_id = next_record.provider_id or MICROVM_DEFAULT_SESSION_PROVIDER_ID
        next_record.provider_microvm_id = next_record.provider_microvm_id or next_record.session_id
        next_record.provider_state = state
        next_record.aws_lifecycle_state = state
        next_record.controller_id = input_.controller_id
        next_record.auth_subject = input_.auth_subject
        next_record.last_action = action
        next_record.last_command_id = input_.request_id
        next_record.updated_at = float(input_.now or 0) if float(input_.now or 0) > 0 else next_record.updated_at
        next_record.last_observed_at = next_record.updated_at
        next_record.generation += 1
        return self._registry.put(next_record)


def create_microvm_registry_client(registry: Any, *, ttl_seconds: int = 3600) -> MicroVMRegistryClient:
    return MicroVMRegistryClient(registry, ttl_seconds=ttl_seconds)


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
        self._clock = clock or time.time
        self._ids = id_generator or _random_microvm_session_id
        self._ttl_seconds = int(ttl_seconds or 0) if int(ttl_seconds or 0) > 0 else 3600

    def handle(self, request: MicroVMControllerRequest | dict[str, Any]) -> MicroVMControllerResponse:
        normalized = _normalize_controller_request(request)
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
            records = list_fn(
                MicroVMSessionListInput(
                    request_id=request.request_id,
                    tenant_id=request.tenant_id,
                    namespace=request.namespace,
                    auth_subject=request.auth_context.subject,
                )
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
            endpoint=current.endpoint if current is not None else "",
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
    raw = value if isinstance(value, dict) else {}
    auth = raw.get("auth") if isinstance(raw.get("auth"), dict) else {}
    envelope = raw.get("envelope") if isinstance(raw.get("envelope"), dict) else {}
    commands = raw.get("commands") if isinstance(raw.get("commands"), list) else []
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
    raw = value if isinstance(value, dict) else {}
    entitlements = raw.get("entitlements") if isinstance(raw.get("entitlements"), list) else []
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
        if not required_operations.issubset(set(model.operation_names)):
            raise RuntimeError("lambda-microvms service model incomplete")
        kwargs = {"region_name": region_name} if region_name else {}
        client = boto3.client("lambda-microvms", **kwargs)
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
    raw = value if isinstance(value, dict) else {}
    known = raw.get("known_sessions") if isinstance(raw.get("known_sessions"), list) else []
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
    raw = value if isinstance(value, dict) else {}
    scopes = raw.get("allowed_port_scope") if isinstance(raw.get("allowed_port_scope"), list) else []
    return MicroVMProviderTokenInput(
        request_id=str(raw.get("request_id", "") or "").strip(),
        tenant_id=str(raw.get("tenant_id", "") or "").strip(),
        namespace=str(raw.get("namespace", "") or "").strip(),
        auth_context=_normalize_auth_context(raw.get("auth_context") or {}),
        binding=_normalize_provider_binding(raw.get("binding") or {}),
        ttl_seconds=int(raw.get("ttl_seconds", 0) or 0),
        allowed_port_scope=[_normalize_provider_port_scope(scope) for scope in scopes],
    )


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
    return _normalize_string_list([*input_.egress_network_connector_refs, input_.network_connector_ref])


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
    if hasattr(raw, "timestamp"):
        try:
            return float(raw.timestamp())
        except TypeError, ValueError, OSError:
            return 0.0
    try:
        return float(raw or 0.0)
    except TypeError, ValueError:
        return 0.0


def _string_field(value: Any, key: str) -> str:
    raw = value.get(key, "") if isinstance(value, dict) else getattr(value, key, "")
    return str(raw or "").strip()


def _number_field(value: Any, key: str) -> int:
    raw = value.get(key, 0) if isinstance(value, dict) else getattr(value, key, 0)
    try:
        return int(raw or 0)
    except TypeError, ValueError:
        return 0
