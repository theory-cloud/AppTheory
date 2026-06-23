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
