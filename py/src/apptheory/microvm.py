from __future__ import annotations

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
    "aws_access_key_id",
    "aws_secret_access_key",
    "aws_session_token",
    "bearer_token",
    "raw_aws_credentials",
    "raw_lifecycle_hook_payload",
    "raw_sdk_client",
    "session_token_plaintext",
    "x-amz-security-token",
}


def _forbidden_field_name(name: str) -> bool:
    key = str(name or "").strip().lower()
    return bool(key) and (key in _FORBIDDEN_FIELD_NAMES or key.replace("-", "_") in _FORBIDDEN_FIELD_NAMES)


def _validate_safe_metadata(metadata: dict[str, str] | None, request_id: str) -> MicroVMSafeError | None:
    for key in metadata or {}:
        if _forbidden_field_name(key):
            return _safe_error(
                MICROVM_ERROR_FORBIDDEN_FIELD,
                "apptheory: microvm metadata contains forbidden field",
                request_id,
            )
    return None


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

COMMAND_CREATE = "create"
COMMAND_START = "start"
COMMAND_STOP = "stop"
COMMAND_STATUS = "status"
COMMAND_SESSION = "session"

MicroVMCommand = Literal["create", "start", "stop", "status", "session"]


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
class MicroVMControllerRequest:
    command: str
    request_id: str
    tenant_id: str
    namespace: str
    auth_context: MicroVMAuthContext
    session_id: str = ""
    image_ref: str = ""
    network_connector_ref: str = ""
    session_spec: MicroVMSessionSpec = field(default_factory=MicroVMSessionSpec)


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
    last_transition: float = 0.0
    registry_version: int = 0
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
                ["session_id", "state", "registry_version"],
            ),
            MicroVMControllerCommandContract(
                COMMAND_START,
                "POST",
                "/microvms/{session_id}/start",
                ["session_id"],
                ["session_id", "state", "desired_state"],
            ),
            MicroVMControllerCommandContract(
                COMMAND_STOP,
                "POST",
                "/microvms/{session_id}/stop",
                ["session_id"],
                ["session_id", "state", "desired_state"],
            ),
            MicroVMControllerCommandContract(
                COMMAND_STATUS,
                "GET",
                "/microvms/{session_id}/status",
                ["session_id"],
                ["session_id", "state", "lifecycle_state", "last_transition"],
            ),
            MicroVMControllerCommandContract(
                COMMAND_SESSION,
                "GET",
                "/microvms/{session_id}",
                ["session_id"],
                ["session_id", "tenant_id", "namespace", "state", "registry_version"],
            ),
        ],
    )


def default_microvm_session_registry_contract() -> MicroVMSessionRegistryContract:
    return MicroVMSessionRegistryContract(
        pattern="tabletheory-single-table",
        tenant_binding=["tenant_id", "namespace"],
        required_fields=[
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
        ],
        state_values=_required_lifecycle_states(),
        forbidden_fields=[
            "raw_aws_credentials",
            "raw_lifecycle_hook_payload",
            "bearer_token",
            "session_token_plaintext",
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
    missing_fields = _missing_strings(
        default_microvm_session_registry_contract().required_fields, coerced.required_fields
    )
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
        or not normalized.image_ref
        or not normalized.controller_id
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
        or normalized.expires_at <= 0
        or normalized.generation <= 0
    ):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session record registry fields are incomplete",
            normalized.last_command_id,
        )
    if not _valid_lifecycle_state(normalized.state) or not _valid_lifecycle_state(normalized.desired_state):
        raise _safe_error(
            MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
            "apptheory: microvm session record state is unsupported",
            normalized.last_command_id,
        )
    metadata_err = _validate_safe_metadata(normalized.metadata, normalized.last_command_id)
    if metadata_err:
        raise metadata_err


def validate_microvm_session_status(status: MicroVMSessionStatus) -> None:
    normalized = _normalize_session_status(status)
    if (
        not normalized.tenant_id
        or not normalized.namespace
        or not normalized.session_id
        or not normalized.state
        or not normalized.desired_state
        or not normalized.lifecycle_state
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


def microvm_session_key(record: MicroVMSessionRecord) -> tuple[str, str, str]:
    return (str(record.tenant_id).strip(), str(record.namespace).strip(), str(record.session_id).strip())


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
            image_ref=input_.image_ref,
            network_connector_ref=input_.network_connector_ref,
            controller_id=input_.controller_id,
            created_at=now,
            updated_at=now,
            expires_at=now + 3600,
            generation=1,
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
        next_record.controller_id = input_.controller_id
        next_record.auth_subject = input_.auth_subject
        next_record.last_command_id = input_.request_id
        next_record.updated_at = float(input_.now or self._now or 1.0)
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


class AWSLambdaMicroVMClient:
    def __init__(self, *, region_name: str | None = None) -> None:
        self._client = _load_aws_lambda_microvm_sdk_client(region_name=region_name)

    def create(self, input_: MicroVMCreateSessionInput) -> MicroVMSessionRecord:
        return self._run_record_call(
            "create_microvm_session",
            input_,
            STATE_REQUESTED,
            STATE_REQUESTED,
            image_ref=input_.image_ref,
            network_connector_ref=input_.network_connector_ref,
        )

    def start(self, input_: MicroVMSessionCommandInput) -> MicroVMSessionRecord:
        return self._run_record_call("start_microvm_session", input_, STATE_STARTING, input_.desired_state)

    def stop(self, input_: MicroVMSessionCommandInput) -> MicroVMSessionRecord:
        return self._run_record_call("stop_microvm_session", input_, STATE_STOPPING, input_.desired_state)

    def status(self, input_: MicroVMSessionQueryInput) -> MicroVMSessionStatus:
        try:
            output = self._client.get_microvm_session_status(**_query_aws_input(input_))
            status = _session_status_from_aws_output(input_, output)
            validate_microvm_session_status(status)
            return status
        except Exception as exc:  # noqa: BLE001
            raise _as_safe_error(exc, input_.request_id) from None

    def session(self, input_: MicroVMSessionQueryInput) -> MicroVMSessionRecord:
        try:
            output = self._client.get_microvm_session(**_query_aws_input(input_))
            record = _session_record_from_aws_output(
                request_id=input_.request_id,
                tenant_id=input_.tenant_id,
                namespace=input_.namespace,
                session_id=input_.session_id,
                auth_subject=input_.auth_subject,
                controller_id=_string_field(output, "controllerId") or "apptheory-microvm-controller",
                image_ref=_string_field(output, "imageRef") or "microvm-image",
                network_connector_ref=_string_field(output, "networkConnectorRef"),
                state=_string_field(output, "state") or STATE_REQUESTED,
                desired_state=_string_field(output, "desiredState") or STATE_REQUESTED,
                output=output,
            )
            validate_microvm_session_record(record)
            return record
        except Exception as exc:  # noqa: BLE001
            raise _as_safe_error(exc, input_.request_id) from None

    def _run_record_call(
        self,
        method: str,
        input_: MicroVMCreateSessionInput | MicroVMSessionCommandInput,
        state: str,
        desired_state: str,
        *,
        image_ref: str = "microvm-image",
        network_connector_ref: str = "",
    ) -> MicroVMSessionRecord:
        try:
            payload = {
                "tenantId": input_.tenant_id,
                "namespace": input_.namespace,
                "sessionId": input_.session_id,
            }
            if isinstance(input_, MicroVMCreateSessionInput):
                payload.update(
                    {
                        "imageRef": input_.image_ref,
                        "networkConnectorRef": input_.network_connector_ref,
                        "metadata": input_.session_spec.metadata or {},
                    }
                )
            else:
                payload["desiredState"] = input_.desired_state
            output = getattr(self._client, method)(**payload)
            record = _session_record_from_aws_output(
                request_id=input_.request_id,
                tenant_id=input_.tenant_id,
                namespace=input_.namespace,
                session_id=input_.session_id,
                auth_subject=input_.auth_subject,
                controller_id=input_.controller_id,
                image_ref=image_ref,
                network_connector_ref=network_connector_ref,
                state=state,
                desired_state=desired_state,
                output=output,
            )
            validate_microvm_session_record(record)
            return record
        except Exception as exc:  # noqa: BLE001
            raise _as_safe_error(exc, input_.request_id) from None


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


def _normalize_command(command: str) -> str:
    return str(command or "").strip()


def _valid_lifecycle_state(state: str) -> bool:
    return str(state or "").strip() in set(_required_lifecycle_states())


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
            network_connector_ref=str(request.network_connector_ref or "").strip(),
            session_spec=_clone_session_spec(request.session_spec),
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
        network_connector_ref=str(raw.get("network_connector_ref", "") or "").strip(),
        session_spec=_clone_session_spec(raw.get("session_spec") or {}),
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
        network_connector_ref=str(record.network_connector_ref or "").strip(),
        controller_id=str(record.controller_id or "").strip(),
        created_at=float(record.created_at or 0),
        updated_at=float(record.updated_at or 0),
        expires_at=float(record.expires_at or 0),
        generation=int(record.generation or 0),
        last_command_id=str(record.last_command_id or "").strip(),
        auth_subject=str(record.auth_subject or "").strip(),
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


def _clone_session_record(record: MicroVMSessionRecord) -> MicroVMSessionRecord:
    return _normalize_session_record(record)


def _random_microvm_session_id() -> str:
    import secrets

    return f"microvm-{secrets.token_hex(16)}"


def _load_aws_lambda_microvm_sdk_client(*, region_name: str | None) -> Any:
    try:
        import boto3  # type: ignore[import-not-found]

        kwargs = {"region_name": region_name} if region_name else {}
        client = boto3.client("lambda-microvms", **kwargs)
        required = [
            "create_microvm_session",
            "start_microvm_session",
            "stop_microvm_session",
            "get_microvm_session_status",
            "get_microvm_session",
        ]
        if not all(callable(getattr(client, name, None)) for name in required):
            raise RuntimeError("lambda microvms methods unavailable")
        return client
    except Exception as exc:
        raise _safe_error(
            MICROVM_ERROR_CONTROLLER_INCOMPLETE,
            "apptheory: microvm AWS SDK lacks Lambda MicroVM support",
            "",
        ) from exc


def _query_aws_input(input_: MicroVMSessionQueryInput) -> dict[str, str]:
    return {"tenantId": input_.tenant_id, "namespace": input_.namespace, "sessionId": input_.session_id}


def _session_record_from_aws_output(
    *,
    request_id: str,
    tenant_id: str,
    namespace: str,
    session_id: str,
    auth_subject: str,
    controller_id: str,
    image_ref: str,
    network_connector_ref: str,
    state: str,
    desired_state: str,
    output: Any,
) -> MicroVMSessionRecord:
    now = 1.0
    record = MicroVMSessionRecord(
        tenant_id=_string_field(output, "tenantId") or tenant_id,
        namespace=_string_field(output, "namespace") or namespace,
        session_id=_string_field(output, "sessionId") or session_id,
        state=_string_field(output, "state") or state,
        desired_state=_string_field(output, "desiredState") or desired_state,
        image_ref=_string_field(output, "imageRef") or image_ref,
        network_connector_ref=_string_field(output, "networkConnectorRef") or network_connector_ref,
        controller_id=_string_field(output, "controllerId") or controller_id,
        created_at=_number_field(output, "createdAt") or now,
        updated_at=_number_field(output, "updatedAt") or now,
        expires_at=_number_field(output, "expiresAt") or now + 3600,
        generation=_number_field(output, "generation") or 1,
        last_command_id=request_id,
        auth_subject=auth_subject,
    )
    return record


def _session_status_from_aws_output(input_: MicroVMSessionQueryInput, output: Any) -> MicroVMSessionStatus:
    return MicroVMSessionStatus(
        tenant_id=_string_field(output, "tenantId") or input_.tenant_id,
        namespace=_string_field(output, "namespace") or input_.namespace,
        session_id=_string_field(output, "sessionId") or input_.session_id,
        state=_string_field(output, "state") or STATE_REQUESTED,
        desired_state=_string_field(output, "desiredState") or STATE_REQUESTED,
        lifecycle_state=_string_field(output, "lifecycleState") or _string_field(output, "state") or STATE_REQUESTED,
        last_transition=_number_field(output, "lastTransition") or 1,
        registry_version=_number_field(output, "registryVersion") or 1,
    )


def _string_field(value: Any, key: str) -> str:
    raw = value.get(key, "") if isinstance(value, dict) else getattr(value, key, "")
    return str(raw or "").strip()


def _number_field(value: Any, key: str) -> int:
    raw = value.get(key, 0) if isinstance(value, dict) else getattr(value, key, 0)
    try:
        return int(raw or 0)
    except TypeError, ValueError:
        return 0
