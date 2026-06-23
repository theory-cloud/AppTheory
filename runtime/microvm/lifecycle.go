// Package microvm provides AppTheory's constrained AWS Lambda MicroVM runtime primitives.
package microvm

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

const (
	// ContractName is the only supported AppTheory MicroVM contract name.
	ContractName = "apptheory.lambda_microvm"
	// ContractVersion is the M15 MicroVM contract version implemented by this package.
	ContractVersion = "m15.microvm/v1"
)

// LifecycleHook names a first-class MicroVM lifecycle hook.
type LifecycleHook string

const (
	HookPrepareImage LifecycleHook = "prepare_image"
	HookStart        LifecycleHook = "start"
	HookReadiness    LifecycleHook = "readiness"
	HookStop         LifecycleHook = "stop"
	HookTeardown     LifecycleHook = "teardown"
	HookFailure      LifecycleHook = "failure"
)

// LifecycleState names a contract-defined MicroVM lifecycle state.
type LifecycleState string

const (
	StateRequested        LifecycleState = "requested"
	StateImagePreparing   LifecycleState = "image_preparing"
	StateImagePrepared    LifecycleState = "image_prepared"
	StateStarting         LifecycleState = "starting"
	StateStarted          LifecycleState = "started"
	StateReadinessProbing LifecycleState = "readiness_probing"
	StateReady            LifecycleState = "ready"
	StateStopping         LifecycleState = "stopping"
	StateStopped          LifecycleState = "stopped"
	StateTearingDown      LifecycleState = "tearing_down"
	StateTerminated       LifecycleState = "terminated"
	StateFailed           LifecycleState = "failed"
)

// LifecycleHookSpec is the contract vocabulary for one lifecycle hook.
type LifecycleHookSpec struct {
	Name         LifecycleHook  `json:"name"`
	Phase        string         `json:"phase"`
	State        LifecycleState `json:"state"`
	SuccessState LifecycleState `json:"success_state"`
	FailureState LifecycleState `json:"failure_state"`
}

// LifecycleTransition is one allowed contract transition.
type LifecycleTransition struct {
	From LifecycleState `json:"from"`
	Hook LifecycleHook  `json:"hook"`
	To   LifecycleState `json:"to"`
}

// LifecycleContract is the AppTheory MicroVM lifecycle vocabulary.
type LifecycleContract struct {
	Hooks          []LifecycleHookSpec   `json:"hooks"`
	States         []LifecycleState      `json:"states"`
	TerminalStates []LifecycleState      `json:"terminal_states"`
	Transitions    []LifecycleTransition `json:"transitions"`
}

// LifecycleEvent is the sanitized event passed to lifecycle hook handlers.
// It intentionally contains no raw Lambda payload and no raw AWS SDK client.
type LifecycleEvent struct {
	RequestID string            `json:"request_id"`
	TenantID  string            `json:"tenant_id"`
	Namespace string            `json:"namespace"`
	SessionID string            `json:"session_id"`
	Hook      LifecycleHook     `json:"hook"`
	State     LifecycleState    `json:"state"`
	Metadata  map[string]string `json:"metadata,omitempty"`
}

// LifecycleResult is the safe result returned by a lifecycle adapter.
type LifecycleResult struct {
	RequestID     string            `json:"request_id"`
	TenantID      string            `json:"tenant_id"`
	Namespace     string            `json:"namespace"`
	SessionID     string            `json:"session_id"`
	Hook          LifecycleHook     `json:"hook"`
	PreviousState LifecycleState    `json:"previous_state"`
	State         LifecycleState    `json:"state"`
	Metadata      map[string]string `json:"metadata,omitempty"`
	Error         *SafeError        `json:"error,omitempty"`
}

// LifecycleHandler handles one sanitized lifecycle hook invocation.
type LifecycleHandler func(context.Context, LifecycleEvent) error

// LifecycleAdapter executes MicroVM lifecycle hooks through the contract vocabulary.
type LifecycleAdapter struct {
	contract LifecycleContract
	handlers map[LifecycleHook]LifecycleHandler
}

// LifecycleOption configures a LifecycleAdapter.
type LifecycleOption func(*LifecycleAdapter)

// WithLifecycleContract replaces the default M15 lifecycle contract.
func WithLifecycleContract(contract LifecycleContract) LifecycleOption {
	return func(adapter *LifecycleAdapter) {
		adapter.contract = cloneLifecycleContract(contract)
	}
}

// WithLifecycleHandler registers a handler for a contract lifecycle hook.
func WithLifecycleHandler(hook LifecycleHook, handler LifecycleHandler) LifecycleOption {
	return func(adapter *LifecycleAdapter) {
		if adapter.handlers == nil {
			adapter.handlers = map[LifecycleHook]LifecycleHandler{}
		}
		hook = normalizeLifecycleHook(hook)
		if hook == "" || handler == nil {
			return
		}
		adapter.handlers[hook] = handler
	}
}

// NewLifecycleAdapter creates a lifecycle adapter that fails closed when its contract is incomplete.
func NewLifecycleAdapter(opts ...LifecycleOption) (*LifecycleAdapter, error) {
	adapter := &LifecycleAdapter{
		contract: DefaultLifecycleContract(),
		handlers: map[LifecycleHook]LifecycleHandler{},
	}
	for _, opt := range opts {
		if opt != nil {
			opt(adapter)
		}
	}
	if err := ValidateLifecycleContract(adapter.contract); err != nil {
		return nil, err
	}
	return adapter, nil
}

// DefaultLifecycleContract returns the M15 MicroVM lifecycle contract vocabulary.
func DefaultLifecycleContract() LifecycleContract {
	return LifecycleContract{
		Hooks: []LifecycleHookSpec{
			{Name: HookPrepareImage, Phase: "image_preparation", State: StateImagePreparing, SuccessState: StateImagePrepared, FailureState: StateFailed},
			{Name: HookStart, Phase: "start", State: StateStarting, SuccessState: StateStarted, FailureState: StateFailed},
			{Name: HookReadiness, Phase: "readiness", State: StateReadinessProbing, SuccessState: StateReady, FailureState: StateFailed},
			{Name: HookStop, Phase: "stop", State: StateStopping, SuccessState: StateStopped, FailureState: StateFailed},
			{Name: HookTeardown, Phase: "teardown", State: StateTearingDown, SuccessState: StateTerminated, FailureState: StateFailed},
			{Name: HookFailure, Phase: "failure", State: StateFailed, SuccessState: StateFailed, FailureState: StateFailed},
		},
		States: []LifecycleState{
			StateRequested,
			StateImagePreparing,
			StateImagePrepared,
			StateStarting,
			StateStarted,
			StateReadinessProbing,
			StateReady,
			StateStopping,
			StateStopped,
			StateTearingDown,
			StateTerminated,
			StateFailed,
		},
		TerminalStates: []LifecycleState{StateTerminated, StateFailed},
		Transitions: []LifecycleTransition{
			{From: StateRequested, Hook: HookPrepareImage, To: StateImagePreparing},
			{From: StateImagePreparing, Hook: HookPrepareImage, To: StateImagePrepared},
			{From: StateImagePrepared, Hook: HookStart, To: StateStarting},
			{From: StateStarting, Hook: HookStart, To: StateStarted},
			{From: StateStarted, Hook: HookReadiness, To: StateReadinessProbing},
			{From: StateReadinessProbing, Hook: HookReadiness, To: StateReady},
			{From: StateReady, Hook: HookStop, To: StateStopping},
			{From: StateStopping, Hook: HookStop, To: StateStopped},
			{From: StateStopped, Hook: HookTeardown, To: StateTearingDown},
			{From: StateTearingDown, Hook: HookTeardown, To: StateTerminated},
			{From: StateImagePreparing, Hook: HookFailure, To: StateFailed},
			{From: StateStarting, Hook: HookFailure, To: StateFailed},
			{From: StateReadinessProbing, Hook: HookFailure, To: StateFailed},
			{From: StateStopping, Hook: HookFailure, To: StateFailed},
			{From: StateTearingDown, Hook: HookFailure, To: StateFailed},
		},
	}
}

// ValidateLifecycleContract validates the lifecycle contract and returns a safe error on failure.
func ValidateLifecycleContract(contract LifecycleContract) error {
	hookSpecs := map[LifecycleHook]LifecycleHookSpec{}
	for _, hook := range contract.Hooks {
		name := normalizeLifecycleHook(hook.Name)
		if name == "" || strings.TrimSpace(hook.Phase) == "" || hook.State == "" || hook.SuccessState == "" || hook.FailureState == "" {
			return invalidContractError(ErrorCodeLifecycleIncomplete, "apptheory: microvm lifecycle hooks must name phase, active state, success state, and failure state")
		}
		hook.Name = name
		hookSpecs[name] = hook
	}
	if missing := missingLifecycleHooks(requiredLifecycleHooks(), hookSpecs); len(missing) > 0 {
		return invalidContractError(ErrorCodeLifecycleIncomplete, "apptheory: microvm lifecycle missing hooks: "+strings.Join(missing, ","))
	}
	if missing := missingLifecycleStates(requiredLifecycleStates(), lifecycleStateSet(contract.States)); len(missing) > 0 {
		return invalidContractError(ErrorCodeLifecycleIncomplete, "apptheory: microvm lifecycle missing states: "+strings.Join(missing, ","))
	}
	if missing := missingLifecycleStates([]LifecycleState{StateTerminated, StateFailed}, lifecycleStateSet(contract.TerminalStates)); len(missing) > 0 {
		return invalidContractError(ErrorCodeLifecycleIncomplete, "apptheory: microvm lifecycle missing terminal states: "+strings.Join(missing, ","))
	}
	transitions := transitionSet(contract.Transitions)
	for _, spec := range hookSpecs {
		if spec.Name == HookFailure {
			continue
		}
		if !transitions.has(preStateForHook(spec.Name), spec.Name, spec.State) {
			return invalidContractError(ErrorCodeLifecycleIncomplete, fmt.Sprintf("apptheory: microvm lifecycle missing active transition for hook %s", spec.Name))
		}
		if !transitions.has(spec.State, spec.Name, spec.SuccessState) {
			return invalidContractError(ErrorCodeLifecycleIncomplete, fmt.Sprintf("apptheory: microvm lifecycle missing success transition for hook %s", spec.Name))
		}
	}
	for _, state := range []LifecycleState{StateImagePreparing, StateStarting, StateReadinessProbing, StateStopping, StateTearingDown} {
		if !transitions.has(state, HookFailure, StateFailed) {
			return invalidContractError(ErrorCodeLifecycleIncomplete, fmt.Sprintf("apptheory: microvm lifecycle missing failure transition from %s", state))
		}
	}
	return nil
}

// Handle executes one lifecycle hook. Handler errors are sanitized and translated to failed state.
func (a *LifecycleAdapter) Handle(ctx context.Context, event LifecycleEvent) (LifecycleResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if a == nil {
		err := safeError(ErrorCodeInvalidLifecycleEvent, "apptheory: microvm lifecycle adapter is nil", event.RequestID)
		return lifecycleErrorResult(event, StateFailed, err), err
	}
	if err := ValidateLifecycleContract(a.contract); err != nil {
		safe := safeError(ErrorCodeLifecycleIncomplete, err.Error(), event.RequestID)
		return lifecycleErrorResult(event, StateFailed, safe), safe
	}
	normalized, err := normalizeLifecycleEvent(event)
	if err != nil {
		safe := err.(SafeError) //nolint:forcetypeassert // normalizeLifecycleEvent only returns SafeError.
		return lifecycleErrorResult(event, StateFailed, safe), safe
	}

	contract := a.contractIndex()
	spec, ok := contract.hooks[normalized.Hook]
	if !ok {
		err := safeError(ErrorCodeInvalidLifecycleEvent, "apptheory: microvm lifecycle hook is unsupported", normalized.RequestID)
		return lifecycleErrorResult(normalized, StateFailed, err), err
	}
	activeState, ok := contract.nextState(normalized.State, normalized.Hook)
	if !ok {
		err := safeError(ErrorCodeInvalidLifecycleEvent, "apptheory: microvm lifecycle transition is unsupported", normalized.RequestID)
		return lifecycleErrorResult(normalized, StateFailed, err), err
	}
	if normalized.Hook != HookFailure && activeState != spec.State {
		err := safeError(ErrorCodeInvalidLifecycleEvent, "apptheory: microvm lifecycle transition is not the hook active state", normalized.RequestID)
		return lifecycleErrorResult(normalized, StateFailed, err), err
	}

	handler := a.handlers[normalized.Hook]
	if handler == nil {
		err := safeError(ErrorCodeInvalidLifecycleEvent, "apptheory: microvm lifecycle hook handler is missing", normalized.RequestID)
		return lifecycleErrorResult(normalized, spec.FailureState, err), err
	}

	handlerEvent := normalized
	handlerEvent.State = activeState
	handlerEvent.Metadata = cloneStringMap(normalized.Metadata)
	if err := handler(ctx, handlerEvent); err != nil {
		safe := safeError(ErrorCodeLifecycleHookFailed, "apptheory: microvm lifecycle hook failed", normalized.RequestID)
		return lifecycleErrorResult(normalized, spec.FailureState, safe), safe
	}

	state := spec.SuccessState
	if normalized.Hook == HookFailure {
		state = StateFailed
	} else if !contract.transitions.has(activeState, normalized.Hook, state) {
		err := safeError(ErrorCodeInvalidLifecycleEvent, "apptheory: microvm lifecycle success transition is unsupported", normalized.RequestID)
		return lifecycleErrorResult(normalized, spec.FailureState, err), err
	}

	return LifecycleResult{
		RequestID:     normalized.RequestID,
		TenantID:      normalized.TenantID,
		Namespace:     normalized.Namespace,
		SessionID:     normalized.SessionID,
		Hook:          normalized.Hook,
		PreviousState: normalized.State,
		State:         state,
		Metadata:      cloneStringMap(normalized.Metadata),
	}, nil
}

// IsTerminalState reports whether a state is terminal under the M15 contract.
func IsTerminalState(state LifecycleState) bool {
	switch state {
	case StateTerminated, StateFailed:
		return true
	default:
		return false
	}
}

func normalizeLifecycleEvent(event LifecycleEvent) (LifecycleEvent, error) {
	event.RequestID = strings.TrimSpace(event.RequestID)
	event.TenantID = strings.TrimSpace(event.TenantID)
	event.Namespace = strings.TrimSpace(event.Namespace)
	event.SessionID = strings.TrimSpace(event.SessionID)
	event.Hook = normalizeLifecycleHook(event.Hook)
	event.State = LifecycleState(strings.TrimSpace(string(event.State)))
	event.Metadata = cloneStringMap(event.Metadata)
	if event.RequestID == "" || event.TenantID == "" || event.Namespace == "" || event.SessionID == "" {
		return LifecycleEvent{}, safeError(ErrorCodeInvalidLifecycleEvent, "apptheory: microvm lifecycle envelope is incomplete", event.RequestID)
	}
	if event.Hook == "" || event.State == "" {
		return LifecycleEvent{}, safeError(ErrorCodeInvalidLifecycleEvent, "apptheory: microvm lifecycle hook and state are required", event.RequestID)
	}
	if err := validateSafeMetadata(event.Metadata, event.RequestID); err != nil {
		return LifecycleEvent{}, err
	}
	return event, nil
}

func lifecycleErrorResult(event LifecycleEvent, state LifecycleState, err SafeError) LifecycleResult {
	return LifecycleResult{
		RequestID:     strings.TrimSpace(event.RequestID),
		TenantID:      strings.TrimSpace(event.TenantID),
		Namespace:     strings.TrimSpace(event.Namespace),
		SessionID:     strings.TrimSpace(event.SessionID),
		Hook:          normalizeLifecycleHook(event.Hook),
		PreviousState: LifecycleState(strings.TrimSpace(string(event.State))),
		State:         state,
		Metadata:      cloneStringMap(event.Metadata),
		Error:         &err,
	}
}

func requiredLifecycleHooks() []LifecycleHook {
	return []LifecycleHook{HookPrepareImage, HookStart, HookReadiness, HookStop, HookTeardown, HookFailure}
}

func requiredLifecycleStates() []LifecycleState {
	return []LifecycleState{
		StateRequested,
		StateImagePreparing,
		StateImagePrepared,
		StateStarting,
		StateStarted,
		StateReadinessProbing,
		StateReady,
		StateStopping,
		StateStopped,
		StateTearingDown,
		StateTerminated,
		StateFailed,
	}
}

func preStateForHook(hook LifecycleHook) LifecycleState {
	switch hook {
	case HookPrepareImage:
		return StateRequested
	case HookStart:
		return StateImagePrepared
	case HookReadiness:
		return StateStarted
	case HookStop:
		return StateReady
	case HookTeardown:
		return StateStopped
	default:
		return ""
	}
}

func cloneLifecycleContract(contract LifecycleContract) LifecycleContract {
	out := LifecycleContract{
		Hooks:          append([]LifecycleHookSpec(nil), contract.Hooks...),
		States:         append([]LifecycleState(nil), contract.States...),
		TerminalStates: append([]LifecycleState(nil), contract.TerminalStates...),
		Transitions:    append([]LifecycleTransition(nil), contract.Transitions...),
	}
	return out
}

func normalizeLifecycleHook(hook LifecycleHook) LifecycleHook {
	return LifecycleHook(strings.TrimSpace(string(hook)))
}

type lifecycleContractIndex struct {
	hooks       map[LifecycleHook]LifecycleHookSpec
	transitions lifecycleTransitionSet
}

func (a *LifecycleAdapter) contractIndex() lifecycleContractIndex {
	idx := lifecycleContractIndex{
		hooks:       map[LifecycleHook]LifecycleHookSpec{},
		transitions: transitionSet(a.contract.Transitions),
	}
	for _, hook := range a.contract.Hooks {
		hook.Name = normalizeLifecycleHook(hook.Name)
		idx.hooks[hook.Name] = hook
	}
	return idx
}

func (idx lifecycleContractIndex) nextState(from LifecycleState, hook LifecycleHook) (LifecycleState, bool) {
	from = LifecycleState(strings.TrimSpace(string(from)))
	hook = normalizeLifecycleHook(hook)
	for _, transition := range idx.transitions.list {
		if transition.From == from && transition.Hook == hook {
			return transition.To, true
		}
	}
	return "", false
}

type lifecycleTransitionSet struct {
	set  map[string]struct{}
	list []LifecycleTransition
}

func transitionSet(transitions []LifecycleTransition) lifecycleTransitionSet {
	out := lifecycleTransitionSet{set: map[string]struct{}{}, list: make([]LifecycleTransition, 0, len(transitions))}
	for _, transition := range transitions {
		transition.From = LifecycleState(strings.TrimSpace(string(transition.From)))
		transition.Hook = normalizeLifecycleHook(transition.Hook)
		transition.To = LifecycleState(strings.TrimSpace(string(transition.To)))
		if transition.From == "" || transition.Hook == "" || transition.To == "" {
			continue
		}
		out.set[transitionKey(transition.From, transition.Hook, transition.To)] = struct{}{}
		out.list = append(out.list, transition)
	}
	return out
}

func (s lifecycleTransitionSet) has(from LifecycleState, hook LifecycleHook, to LifecycleState) bool {
	_, ok := s.set[transitionKey(from, hook, to)]
	return ok
}

func transitionKey(from LifecycleState, hook LifecycleHook, to LifecycleState) string {
	return string(from) + "\x00" + string(hook) + "\x00" + string(to)
}

func lifecycleStateSet(states []LifecycleState) map[LifecycleState]struct{} {
	out := map[LifecycleState]struct{}{}
	for _, state := range states {
		state = LifecycleState(strings.TrimSpace(string(state)))
		if state != "" {
			out[state] = struct{}{}
		}
	}
	return out
}

func missingLifecycleHooks(required []LifecycleHook, got map[LifecycleHook]LifecycleHookSpec) []string {
	missing := make([]string, 0)
	for _, hook := range required {
		if _, ok := got[hook]; !ok {
			missing = append(missing, string(hook))
		}
	}
	sort.Strings(missing)
	return missing
}

func missingLifecycleStates(required []LifecycleState, got map[LifecycleState]struct{}) []string {
	missing := make([]string, 0)
	for _, state := range required {
		if _, ok := got[state]; !ok {
			missing = append(missing, string(state))
		}
	}
	sort.Strings(missing)
	return missing
}
