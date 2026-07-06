import {
  MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
  MICROVM_ERROR_LIFECYCLE_BYPASS,
  MICROVM_ERROR_LIFECYCLE_HOOK_FAILED,
  MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
  MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH,
  MicroVMHook,
  MicroVMRealHook,
  MicroVMRealState,
  MicroVMSafeError,
  MicroVMState,
  type MicroVMLifecycleAdapterOptions,
  type MicroVMLifecycleContract,
  type MicroVMLifecycleEvent,
  type MicroVMLifecycleHandler,
  type MicroVMLifecycleHook,
  type MicroVMLifecycleHookSpec,
  type MicroVMLifecycleResult,
  type MicroVMLifecycleState,
  type MicroVMLifecycleTransition,
  type MicroVMRealLifecycleHook,
  type MicroVMRealLifecycleState,
  type MicroVMEscapeHatches,
} from "./model.js";
import { safeError } from "./errors.js";
import { validateMicroVMRealLifecycleContract } from "./operation-contract.js";
import {
  cloneStringMap,
  missingStrings,
  validateSafeMicroVMMetadata,
} from "./safety.js";

export function validateMicroVMEscapeHatches(
  escapeHatches: MicroVMEscapeHatches,
): void {
  if (escapeHatches.raw_aws_sdk === true) {
    throw safeError(
      MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH,
      "apptheory: microvm contract forbids raw AWS SDK escape hatch",
      "",
    );
  }
  if (escapeHatches.raw_lifecycle_hook_bypass === true) {
    throw safeError(
      MICROVM_ERROR_LIFECYCLE_BYPASS,
      "apptheory: microvm contract forbids raw lifecycle hook bypass",
      "",
    );
  }
}

export function defaultMicroVMLifecycleContract(): MicroVMLifecycleContract {
  return {
    hooks: [
      {
        name: MicroVMHook.PrepareImage,
        phase: "image_preparation",
        state: MicroVMState.ImagePreparing,
        success_state: MicroVMState.ImagePrepared,
        failure_state: MicroVMState.Failed,
      },
      {
        name: MicroVMHook.Start,
        phase: "start",
        state: MicroVMState.Starting,
        success_state: MicroVMState.Started,
        failure_state: MicroVMState.Failed,
      },
      {
        name: MicroVMHook.Readiness,
        phase: "readiness",
        state: MicroVMState.ReadinessProbing,
        success_state: MicroVMState.Ready,
        failure_state: MicroVMState.Failed,
      },
      {
        name: MicroVMHook.Stop,
        phase: "stop",
        state: MicroVMState.Stopping,
        success_state: MicroVMState.Stopped,
        failure_state: MicroVMState.Failed,
      },
      {
        name: MicroVMHook.Teardown,
        phase: "teardown",
        state: MicroVMState.TearingDown,
        success_state: MicroVMState.Terminated,
        failure_state: MicroVMState.Failed,
      },
      {
        name: MicroVMHook.Failure,
        phase: "failure",
        state: MicroVMState.Failed,
        success_state: MicroVMState.Failed,
        failure_state: MicroVMState.Failed,
      },
    ],
    states: requiredMicroVMLifecycleStates(),
    terminal_states: [MicroVMState.Terminated, MicroVMState.Failed],
    transitions: [
      {
        from: MicroVMState.Requested,
        hook: MicroVMHook.PrepareImage,
        to: MicroVMState.ImagePreparing,
      },
      {
        from: MicroVMState.ImagePreparing,
        hook: MicroVMHook.PrepareImage,
        to: MicroVMState.ImagePrepared,
      },
      {
        from: MicroVMState.ImagePrepared,
        hook: MicroVMHook.Start,
        to: MicroVMState.Starting,
      },
      {
        from: MicroVMState.Starting,
        hook: MicroVMHook.Start,
        to: MicroVMState.Started,
      },
      {
        from: MicroVMState.Started,
        hook: MicroVMHook.Readiness,
        to: MicroVMState.ReadinessProbing,
      },
      {
        from: MicroVMState.ReadinessProbing,
        hook: MicroVMHook.Readiness,
        to: MicroVMState.Ready,
      },
      {
        from: MicroVMState.Ready,
        hook: MicroVMHook.Stop,
        to: MicroVMState.Stopping,
      },
      {
        from: MicroVMState.Stopping,
        hook: MicroVMHook.Stop,
        to: MicroVMState.Stopped,
      },
      {
        from: MicroVMState.Stopped,
        hook: MicroVMHook.Teardown,
        to: MicroVMState.TearingDown,
      },
      {
        from: MicroVMState.TearingDown,
        hook: MicroVMHook.Teardown,
        to: MicroVMState.Terminated,
      },
      {
        from: MicroVMState.ImagePreparing,
        hook: MicroVMHook.Failure,
        to: MicroVMState.Failed,
      },
      {
        from: MicroVMState.Starting,
        hook: MicroVMHook.Failure,
        to: MicroVMState.Failed,
      },
      {
        from: MicroVMState.ReadinessProbing,
        hook: MicroVMHook.Failure,
        to: MicroVMState.Failed,
      },
      {
        from: MicroVMState.Stopping,
        hook: MicroVMHook.Failure,
        to: MicroVMState.Failed,
      },
      {
        from: MicroVMState.TearingDown,
        hook: MicroVMHook.Failure,
        to: MicroVMState.Failed,
      },
    ],
  };
}

export function validateMicroVMLifecycleContract(
  contract: MicroVMLifecycleContract,
): void {
  const hookSpecs = validateMicroVMLifecycleHookSpecs(contract.hooks);
  validateMicroVMLifecycleStateLists(contract);
  validateMicroVMLifecycleTransitionSet(
    hookSpecs,
    microVMTransitionSet(contract.transitions),
  );
}

export class MicroVMLifecycleAdapter {
  private readonly contract: MicroVMLifecycleContract;
  private readonly handlers: Map<string, MicroVMLifecycleHandler>;

  constructor(options: MicroVMLifecycleAdapterOptions = {}) {
    this.contract = cloneMicroVMLifecycleContract(
      options.contract ?? defaultMicroVMLifecycleContract(),
    );
    this.handlers = new Map<string, MicroVMLifecycleHandler>();
    for (const [hook, handler] of Object.entries(
      options.handlers ?? {},
    ) as Array<
      [
        MicroVMLifecycleHook | MicroVMRealLifecycleHook,
        MicroVMLifecycleHandler | undefined,
      ]
    >) {
      const normalizedHook = normalizeMicroVMLifecycleHook(hook);
      if (normalizedHook && handler) this.handlers.set(normalizedHook, handler);
    }
    validateMicroVMLifecycleAdapterContract(this.contract);
  }

  async handle(event: MicroVMLifecycleEvent): Promise<MicroVMLifecycleResult> {
    try {
      validateMicroVMLifecycleAdapterContract(this.contract);
    } catch (err) {
      const safe = lifecycleContractValidationError(err, event.request_id);
      return lifecycleErrorResult(event, MicroVMState.Failed, safe);
    }

    const normalizedResult = normalizeMicroVMLifecycleEvent(event);
    if (normalizedResult instanceof MicroVMSafeError) {
      return lifecycleErrorResult(event, MicroVMState.Failed, normalizedResult);
    }
    const normalized = normalizedResult;
    const normalizedHook = normalizeMicroVMLifecycleHook(normalized.hook);
    const normalizedState = normalizeMicroVMLifecycleState(normalized.state);
    if (!normalizedHook || !normalizedState) {
      const safe = safeError(
        MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
        "apptheory: microvm lifecycle hook and state are required",
        normalized.request_id,
      );
      return lifecycleErrorResult(normalized, MicroVMState.Failed, safe);
    }
    const index = lifecycleContractIndex(this.contract);
    const spec = index.hooks.get(normalizedHook);
    if (!spec) {
      const safe = safeError(
        MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
        "apptheory: microvm lifecycle hook is unsupported",
        normalized.request_id,
      );
      return lifecycleErrorResult(normalized, MicroVMState.Failed, safe);
    }
    const activeState = microVMNextState(
      index.transitions.list,
      normalizedState,
      normalizedHook,
    );
    if (!activeState) {
      const safe = safeError(
        MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
        "apptheory: microvm lifecycle transition is unsupported",
        normalized.request_id,
      );
      return lifecycleErrorResult(normalized, MicroVMState.Failed, safe);
    }
    if (normalizedHook !== MicroVMHook.Failure && activeState !== spec.state) {
      const safe = safeError(
        MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
        "apptheory: microvm lifecycle transition is not the hook active state",
        normalized.request_id,
      );
      return lifecycleErrorResult(normalized, MicroVMState.Failed, safe);
    }

    const handler = this.handlers.get(normalizedHook);
    if (!handler) {
      const safe = safeError(
        MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
        "apptheory: microvm lifecycle hook handler is missing",
        normalized.request_id,
      );
      return lifecycleErrorResult(normalized, spec.failure_state, safe);
    }

    const handlerEvent = cloneMicroVMLifecycleEvent({
      ...normalized,
      state: activeState,
    });
    try {
      await handler(handlerEvent);
    } catch {
      const safe = safeError(
        MICROVM_ERROR_LIFECYCLE_HOOK_FAILED,
        "apptheory: microvm lifecycle hook failed",
        normalized.request_id,
      );
      return lifecycleErrorResult(normalized, spec.failure_state, safe);
    }

    const state =
      normalizedHook === MicroVMHook.Failure
        ? MicroVMState.Failed
        : spec.success_state;
    if (
      normalizedHook !== MicroVMHook.Failure &&
      !index.transitions.has(activeState, normalizedHook, state)
    ) {
      const safe = safeError(
        MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
        "apptheory: microvm lifecycle success transition is unsupported",
        normalized.request_id,
      );
      return lifecycleErrorResult(normalized, spec.failure_state, safe);
    }

    return buildLifecycleResult(normalized, state);
  }
}

export function createMicroVMLifecycleAdapter(
  options: MicroVMLifecycleAdapterOptions = {},
): MicroVMLifecycleAdapter {
  return new MicroVMLifecycleAdapter(options);
}

export function isMicroVMTerminalState(
  state: MicroVMLifecycleState | string,
): boolean {
  return state === MicroVMState.Terminated || state === MicroVMState.Failed;
}

export function validateMicroVMLifecycleHookSpecs(
  hooks: MicroVMLifecycleHookSpec[],
): Map<MicroVMLifecycleHook, MicroVMLifecycleHookSpec> {
  const hookSpecs = new Map<MicroVMLifecycleHook, MicroVMLifecycleHookSpec>();
  for (const rawHook of hooks) {
    const name = normalizeMicroVMLifecycleHook(rawHook.name);
    const hook = {
      name,
      phase: String(rawHook.phase ?? "").trim(),
      state: normalizeMicroVMLifecycleState(rawHook.state),
      success_state: normalizeMicroVMLifecycleState(rawHook.success_state),
      failure_state: normalizeMicroVMLifecycleState(rawHook.failure_state),
    };
    if (
      !hook.name ||
      !hook.phase ||
      !hook.state ||
      !hook.success_state ||
      !hook.failure_state
    ) {
      throw safeError(
        MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
        "apptheory: microvm lifecycle hooks must name phase, active state, success state, and failure state",
        "",
      );
    }
    hookSpecs.set(hook.name, hook);
  }
  const missing = missingStrings(requiredMicroVMLifecycleHooks(), [
    ...hookSpecs.keys(),
  ]);
  if (missing.length > 0) {
    throw safeError(
      MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
      `apptheory: microvm lifecycle missing hooks: ${missing.join(",")}`,
      "",
    );
  }
  return hookSpecs;
}

export function validateMicroVMLifecycleStateLists(
  contract: MicroVMLifecycleContract,
): void {
  const states = new Set(
    (contract.states ?? []).map(normalizeMicroVMLifecycleState).filter(Boolean),
  );
  const missingStates = missingStrings(requiredMicroVMLifecycleStates(), [
    ...states,
  ]);
  if (missingStates.length > 0) {
    throw safeError(
      MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
      `apptheory: microvm lifecycle missing states: ${missingStates.join(",")}`,
      "",
    );
  }

  const terminalStates = new Set(
    (contract.terminal_states ?? [])
      .map(normalizeMicroVMLifecycleState)
      .filter(Boolean),
  );
  const missingTerminal = missingStrings(
    [MicroVMState.Terminated, MicroVMState.Failed],
    [...terminalStates],
  );
  if (missingTerminal.length > 0) {
    throw safeError(
      MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
      `apptheory: microvm lifecycle missing terminal states: ${missingTerminal.join(",")}`,
      "",
    );
  }
}

export function validateMicroVMLifecycleTransitionSet(
  hookSpecs: Map<MicroVMLifecycleHook, MicroVMLifecycleHookSpec>,
  transitions: MicroVMTransitionSet,
): void {
  for (const spec of hookSpecs.values()) {
    const name = normalizeMicroVMLifecycleHook(spec.name);
    if (!name || name === MicroVMHook.Failure) continue;
    const preState = preStateForMicroVMHook(name);
    if (!transitions.has(preState, name, spec.state)) {
      throw safeError(
        MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
        `apptheory: microvm lifecycle missing active transition for hook ${name}`,
        "",
      );
    }
    if (!transitions.has(spec.state, name, spec.success_state)) {
      throw safeError(
        MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
        `apptheory: microvm lifecycle missing success transition for hook ${name}`,
        "",
      );
    }
  }
  validateMicroVMLifecycleFailureTransitions(transitions);
}

export function validateMicroVMLifecycleFailureTransitions(
  transitions: MicroVMTransitionSet,
): void {
  for (const state of [
    MicroVMState.ImagePreparing,
    MicroVMState.Starting,
    MicroVMState.ReadinessProbing,
    MicroVMState.Stopping,
    MicroVMState.TearingDown,
  ]) {
    if (!transitions.has(state, MicroVMHook.Failure, MicroVMState.Failed)) {
      throw safeError(
        MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
        `apptheory: microvm lifecycle missing failure transition from ${state}`,
        "",
      );
    }
  }
}

export function validateMicroVMLifecycleAdapterContract(
  contract: MicroVMLifecycleContract,
): void {
  if (isMicroVMRealLifecycleContractShape(contract)) {
    validateMicroVMRealLifecycleContract(contract);
    return;
  }
  validateMicroVMLifecycleContract(contract);
}

export function isMicroVMRealLifecycleContractShape(
  contract: MicroVMLifecycleContract,
): boolean {
  for (const hook of contract.hooks ?? []) {
    if (microVMRealLifecycleOnlyHook(hook.name)) return true;
  }
  for (const state of contract.states ?? []) {
    if (microVMRealLifecycleOnlyState(state)) return true;
  }
  for (const transition of contract.transitions ?? []) {
    if (
      microVMRealLifecycleOnlyHook(transition.hook) ||
      microVMRealLifecycleOnlyState(transition.from) ||
      microVMRealLifecycleOnlyState(transition.to)
    ) {
      return true;
    }
  }
  return false;
}

export function microVMRealLifecycleOnlyHook(
  hook: MicroVMLifecycleHook | MicroVMRealLifecycleHook | string,
): boolean {
  switch (String(hook ?? "").trim()) {
    case MicroVMRealHook.Validate:
    case MicroVMRealHook.Run:
    case MicroVMRealHook.Ready:
    case MicroVMRealHook.Suspend:
    case MicroVMRealHook.Resume:
    case MicroVMRealHook.Terminate:
      return true;
    default:
      return false;
  }
}

export function microVMRealLifecycleOnlyState(
  state: MicroVMLifecycleState | MicroVMRealLifecycleState | string,
): boolean {
  switch (String(state ?? "").trim()) {
    case MicroVMRealState.Validating:
    case MicroVMRealState.Validated:
    case MicroVMRealState.Running:
    case MicroVMRealState.Suspending:
    case MicroVMRealState.Suspended:
    case MicroVMRealState.Resuming:
    case MicroVMRealState.Terminating:
      return true;
    default:
      return false;
  }
}

export function lifecycleContractValidationError(
  err: unknown,
  requestID: string,
): MicroVMSafeError {
  if (err instanceof MicroVMSafeError) {
    return safeError(err.code, err.message, requestID);
  }
  return safeError(
    MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
    err instanceof Error ? err.message : String(err),
    requestID,
  );
}

export function normalizeMicroVMLifecycleEvent(
  event: MicroVMLifecycleEvent,
): MicroVMLifecycleEvent | MicroVMSafeError {
  const normalizedInput: MicroVMLifecycleEvent = {
    request_id: String(event.request_id ?? "").trim(),
    tenant_id: String(event.tenant_id ?? "").trim(),
    namespace: String(event.namespace ?? "").trim(),
    session_id: String(event.session_id ?? "").trim(),
    hook: normalizeMicroVMLifecycleHook(event.hook),
    state: normalizeMicroVMLifecycleState(event.state),
  };
  const metadata = cloneStringMap(event.metadata);
  if (metadata) normalizedInput.metadata = metadata;
  const normalized = cloneMicroVMLifecycleEvent(normalizedInput);
  if (
    !normalized.request_id ||
    !normalized.tenant_id ||
    !normalized.namespace ||
    !normalized.session_id
  ) {
    return safeError(
      MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
      "apptheory: microvm lifecycle envelope is incomplete",
      normalized.request_id,
    );
  }
  if (!normalized.hook || !normalized.state) {
    return safeError(
      MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
      "apptheory: microvm lifecycle hook and state are required",
      normalized.request_id,
    );
  }
  const metadataErr = validateSafeMicroVMMetadata(
    normalized.metadata,
    normalized.request_id,
  );
  return metadataErr ?? normalized;
}

export function lifecycleErrorResult(
  event: MicroVMLifecycleEvent,
  state: MicroVMLifecycleState | string,
  error: MicroVMSafeError,
): MicroVMLifecycleResult {
  const result: MicroVMLifecycleResult = {
    request_id: String(event.request_id ?? "").trim(),
    tenant_id: String(event.tenant_id ?? "").trim(),
    namespace: String(event.namespace ?? "").trim(),
    session_id: String(event.session_id ?? "").trim(),
    hook: normalizeMicroVMLifecycleHook(event.hook),
    previous_state: normalizeMicroVMLifecycleState(event.state),
    state,
    error,
  };
  const metadata = cloneStringMap(event.metadata);
  if (metadata) result.metadata = metadata;
  return result;
}

export function buildLifecycleResult(
  event: MicroVMLifecycleEvent,
  state: MicroVMLifecycleState | string,
): MicroVMLifecycleResult {
  const result: MicroVMLifecycleResult = {
    request_id: event.request_id,
    tenant_id: event.tenant_id,
    namespace: event.namespace,
    session_id: event.session_id,
    hook: event.hook,
    previous_state: event.state,
    state,
  };
  const metadata = cloneStringMap(event.metadata);
  if (metadata) result.metadata = metadata;
  return result;
}

export function requiredMicroVMLifecycleHooks(): MicroVMLifecycleHook[] {
  return [
    MicroVMHook.PrepareImage,
    MicroVMHook.Start,
    MicroVMHook.Readiness,
    MicroVMHook.Stop,
    MicroVMHook.Teardown,
    MicroVMHook.Failure,
  ];
}

export function requiredMicroVMLifecycleStates(): MicroVMLifecycleState[] {
  return [
    MicroVMState.Requested,
    MicroVMState.ImagePreparing,
    MicroVMState.ImagePrepared,
    MicroVMState.Starting,
    MicroVMState.Started,
    MicroVMState.ReadinessProbing,
    MicroVMState.Ready,
    MicroVMState.Stopping,
    MicroVMState.Stopped,
    MicroVMState.TearingDown,
    MicroVMState.Terminated,
    MicroVMState.Failed,
  ];
}

export function preStateForMicroVMHook(
  hook: MicroVMLifecycleHook,
): MicroVMLifecycleState | "" {
  switch (hook) {
    case MicroVMHook.PrepareImage:
      return MicroVMState.Requested;
    case MicroVMHook.Start:
      return MicroVMState.ImagePrepared;
    case MicroVMHook.Readiness:
      return MicroVMState.Started;
    case MicroVMHook.Stop:
      return MicroVMState.Ready;
    case MicroVMHook.Teardown:
      return MicroVMState.Stopped;
    default:
      return "";
  }
}

export function cloneMicroVMLifecycleContract(
  contract: MicroVMLifecycleContract,
): MicroVMLifecycleContract {
  return {
    hooks: [...(contract.hooks ?? [])],
    states: [...(contract.states ?? [])],
    terminal_states: [...(contract.terminal_states ?? [])],
    transitions: [...(contract.transitions ?? [])],
  };
}

export function cloneMicroVMLifecycleEvent(
  event: MicroVMLifecycleEvent,
): MicroVMLifecycleEvent {
  const out: MicroVMLifecycleEvent = {
    request_id: event.request_id,
    tenant_id: event.tenant_id,
    namespace: event.namespace,
    session_id: event.session_id,
    hook: event.hook,
    state: event.state,
  };
  const metadata = cloneStringMap(event.metadata);
  if (metadata) out["metadata"] = metadata;
  return out;
}

export function normalizeMicroVMLifecycleHook(
  hook: MicroVMLifecycleHook | string,
): MicroVMLifecycleHook | "" {
  return String(hook ?? "").trim() as MicroVMLifecycleHook | "";
}

export function normalizeMicroVMLifecycleState(
  state: MicroVMLifecycleState | string,
): MicroVMLifecycleState | "" {
  return String(state ?? "").trim() as MicroVMLifecycleState | "";
}

export interface MicroVMContractIndex {
  hooks: Map<MicroVMLifecycleHook, MicroVMLifecycleHookSpec>;
  transitions: MicroVMTransitionSet;
}

export function lifecycleContractIndex(
  contract: MicroVMLifecycleContract,
): MicroVMContractIndex {
  const hooks = new Map<MicroVMLifecycleHook, MicroVMLifecycleHookSpec>();
  for (const hook of contract.hooks) {
    const name = normalizeMicroVMLifecycleHook(hook.name);
    if (!name) continue;
    hooks.set(name, {
      name,
      phase: String(hook.phase ?? "").trim(),
      state: normalizeMicroVMLifecycleState(hook.state),
      success_state: normalizeMicroVMLifecycleState(hook.success_state),
      failure_state: normalizeMicroVMLifecycleState(hook.failure_state),
    });
  }
  return { hooks, transitions: microVMTransitionSet(contract.transitions) };
}

export interface MicroVMTransitionSet {
  list: MicroVMLifecycleTransition[];
  has: (
    from: MicroVMLifecycleState | string,
    hook: MicroVMLifecycleHook | string,
    to: MicroVMLifecycleState | string,
  ) => boolean;
}

export function microVMTransitionSet(
  transitions: MicroVMLifecycleTransition[],
): MicroVMTransitionSet {
  const set = new Set<string>();
  const list: MicroVMLifecycleTransition[] = [];
  for (const transition of transitions ?? []) {
    const from = normalizeMicroVMLifecycleState(transition.from);
    const hook = normalizeMicroVMLifecycleHook(transition.hook);
    const to = normalizeMicroVMLifecycleState(transition.to);
    if (!from || !hook || !to) continue;
    set.add(transitionKey(from, hook, to));
    list.push({ from, hook, to });
  }
  return {
    list,
    has: (from, hook, to) =>
      set.has(
        transitionKey(
          normalizeMicroVMLifecycleState(from),
          normalizeMicroVMLifecycleHook(hook),
          normalizeMicroVMLifecycleState(to),
        ),
      ),
  };
}

export function microVMNextState(
  transitions: MicroVMLifecycleTransition[],
  from: MicroVMLifecycleState | string,
  hook: MicroVMLifecycleHook | string,
): MicroVMLifecycleState | "" {
  const normalizedFrom = normalizeMicroVMLifecycleState(from);
  const normalizedHook = normalizeMicroVMLifecycleHook(hook);
  for (const transition of transitions) {
    if (
      transition.from === normalizedFrom &&
      transition.hook === normalizedHook
    ) {
      return normalizeMicroVMLifecycleState(transition.to);
    }
  }
  return "";
}

export function transitionKey(
  from: MicroVMLifecycleState | string,
  hook: MicroVMLifecycleHook | string,
  to: MicroVMLifecycleState | string,
): string {
  return `${from}\u0000${hook}\u0000${to}`;
}
