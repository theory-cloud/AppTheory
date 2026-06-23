import { randomBytes } from "node:crypto";

export const MICROVM_CONTRACT_NAME = "apptheory.lambda_microvm";
export const MICROVM_CONTRACT_VERSION = "m15.microvm/v1";

export const MICROVM_ERROR_INVALID_CONTRACT = "m15.microvm.invalid_contract";
export const MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH =
  "m15.microvm.raw_sdk_escape_hatch";
export const MICROVM_ERROR_LIFECYCLE_BYPASS = "m15.microvm.lifecycle_bypass";
export const MICROVM_ERROR_LIFECYCLE_INCOMPLETE =
  "m15.microvm.lifecycle_incomplete";
export const MICROVM_ERROR_FORBIDDEN_FIELD = "m15.microvm.forbidden_field";
export const MICROVM_ERROR_INVALID_LIFECYCLE_EVENT =
  "m15.microvm.invalid_lifecycle_event";
export const MICROVM_ERROR_LIFECYCLE_HOOK_FAILED =
  "m15.microvm.lifecycle_hook_failed";

export const MicroVMHook = {
  PrepareImage: "prepare_image",
  Start: "start",
  Readiness: "readiness",
  Stop: "stop",
  Teardown: "teardown",
  Failure: "failure",
} as const;

export type MicroVMLifecycleHook =
  (typeof MicroVMHook)[keyof typeof MicroVMHook];

export const MicroVMState = {
  Requested: "requested",
  ImagePreparing: "image_preparing",
  ImagePrepared: "image_prepared",
  Starting: "starting",
  Started: "started",
  ReadinessProbing: "readiness_probing",
  Ready: "ready",
  Stopping: "stopping",
  Stopped: "stopped",
  TearingDown: "tearing_down",
  Terminated: "terminated",
  Failed: "failed",
} as const;

export type MicroVMLifecycleState =
  (typeof MicroVMState)[keyof typeof MicroVMState];

export interface MicroVMEscapeHatches {
  raw_aws_sdk?: boolean;
  raw_lifecycle_hook_bypass?: boolean;
}

export interface MicroVMLifecycleHookSpec {
  name: MicroVMLifecycleHook | string;
  phase: string;
  state: MicroVMLifecycleState | string;
  success_state: MicroVMLifecycleState | string;
  failure_state: MicroVMLifecycleState | string;
}

export interface MicroVMLifecycleTransition {
  from: MicroVMLifecycleState | string;
  hook: MicroVMLifecycleHook | string;
  to: MicroVMLifecycleState | string;
}

export interface MicroVMLifecycleContract {
  hooks: MicroVMLifecycleHookSpec[];
  states: Array<MicroVMLifecycleState | string>;
  terminal_states: Array<MicroVMLifecycleState | string>;
  transitions: MicroVMLifecycleTransition[];
}

export interface MicroVMLifecycleEvent {
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  hook: MicroVMLifecycleHook | string;
  state: MicroVMLifecycleState | string;
  metadata?: Record<string, string>;
}

export interface MicroVMLifecycleResult {
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  hook: MicroVMLifecycleHook | string;
  previous_state: MicroVMLifecycleState | string;
  state: MicroVMLifecycleState | string;
  metadata?: Record<string, string>;
  error?: MicroVMSafeError;
}

export type MicroVMLifecycleHandler = (
  event: MicroVMLifecycleEvent,
) => Promise<void> | void;

export interface MicroVMLifecycleAdapterOptions {
  contract?: MicroVMLifecycleContract;
  handlers?: Partial<Record<MicroVMLifecycleHook, MicroVMLifecycleHandler>>;
}

export class MicroVMSafeError extends Error {
  readonly code: string;
  readonly request_id?: string;

  constructor(code: string, message: string, requestID = "") {
    super(String(message ?? "").trim());
    this.name = "MicroVMSafeError";
    this.code = String(code ?? "").trim();
    const trimmedRequestID = String(requestID ?? "").trim();
    if (trimmedRequestID) this.request_id = trimmedRequestID;
  }
}

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
  private readonly handlers: Map<MicroVMLifecycleHook, MicroVMLifecycleHandler>;

  constructor(options: MicroVMLifecycleAdapterOptions = {}) {
    this.contract = cloneMicroVMLifecycleContract(
      options.contract ?? defaultMicroVMLifecycleContract(),
    );
    this.handlers = new Map<MicroVMLifecycleHook, MicroVMLifecycleHandler>();
    for (const [hook, handler] of Object.entries(
      options.handlers ?? {},
    ) as Array<[MicroVMLifecycleHook, MicroVMLifecycleHandler | undefined]>) {
      const normalizedHook = normalizeMicroVMLifecycleHook(hook);
      if (normalizedHook && handler) this.handlers.set(normalizedHook, handler);
    }
    validateMicroVMLifecycleContract(this.contract);
  }

  async handle(event: MicroVMLifecycleEvent): Promise<MicroVMLifecycleResult> {
    try {
      validateMicroVMLifecycleContract(this.contract);
    } catch (err) {
      const safe = safeError(
        MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
        err instanceof Error ? err.message : String(err),
        event.request_id,
      );
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

function safeError(
  code: string,
  message: string,
  requestID: string,
): MicroVMSafeError {
  return new MicroVMSafeError(code, message, requestID);
}

function validateMicroVMLifecycleHookSpecs(
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

function validateMicroVMLifecycleStateLists(
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

function validateMicroVMLifecycleTransitionSet(
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

function validateMicroVMLifecycleFailureTransitions(
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

function normalizeMicroVMLifecycleEvent(
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

function lifecycleErrorResult(
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

function buildLifecycleResult(
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

function requiredMicroVMLifecycleHooks(): MicroVMLifecycleHook[] {
  return [
    MicroVMHook.PrepareImage,
    MicroVMHook.Start,
    MicroVMHook.Readiness,
    MicroVMHook.Stop,
    MicroVMHook.Teardown,
    MicroVMHook.Failure,
  ];
}

function requiredMicroVMLifecycleStates(): MicroVMLifecycleState[] {
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

function preStateForMicroVMHook(
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

function cloneMicroVMLifecycleContract(
  contract: MicroVMLifecycleContract,
): MicroVMLifecycleContract {
  return {
    hooks: [...(contract.hooks ?? [])],
    states: [...(contract.states ?? [])],
    terminal_states: [...(contract.terminal_states ?? [])],
    transitions: [...(contract.transitions ?? [])],
  };
}

function cloneMicroVMLifecycleEvent(
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
  if (metadata) out.metadata = metadata;
  return out;
}

function normalizeMicroVMLifecycleHook(
  hook: MicroVMLifecycleHook | string,
): MicroVMLifecycleHook | "" {
  return String(hook ?? "").trim() as MicroVMLifecycleHook | "";
}

function normalizeMicroVMLifecycleState(
  state: MicroVMLifecycleState | string,
): MicroVMLifecycleState | "" {
  return String(state ?? "").trim() as MicroVMLifecycleState | "";
}

interface MicroVMContractIndex {
  hooks: Map<MicroVMLifecycleHook, MicroVMLifecycleHookSpec>;
  transitions: MicroVMTransitionSet;
}

function lifecycleContractIndex(
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

interface MicroVMTransitionSet {
  list: MicroVMLifecycleTransition[];
  has: (
    from: MicroVMLifecycleState | string,
    hook: MicroVMLifecycleHook | string,
    to: MicroVMLifecycleState | string,
  ) => boolean;
}

function microVMTransitionSet(
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

function microVMNextState(
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

function transitionKey(
  from: MicroVMLifecycleState | string,
  hook: MicroVMLifecycleHook | string,
  to: MicroVMLifecycleState | string,
): string {
  return `${from}\u0000${hook}\u0000${to}`;
}

const FORBIDDEN_MICROVM_FIELD_NAMES = new Set([
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
]);

function forbiddenMicroVMFieldName(name: string): boolean {
  const key = String(name ?? "")
    .trim()
    .toLowerCase();
  if (!key) return false;
  return (
    FORBIDDEN_MICROVM_FIELD_NAMES.has(key) ||
    FORBIDDEN_MICROVM_FIELD_NAMES.has(key.replaceAll("-", "_"))
  );
}

function validateSafeMicroVMMetadata(
  metadata: Record<string, string> | undefined,
  requestID: string,
): MicroVMSafeError | null {
  for (const key of Object.keys(metadata ?? {})) {
    if (forbiddenMicroVMFieldName(key)) {
      return safeError(
        MICROVM_ERROR_FORBIDDEN_FIELD,
        "apptheory: microvm metadata contains forbidden field",
        requestID,
      );
    }
  }
  return null;
}

function cloneStringMap(
  input: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    const trimmed = key.trim();
    if (!trimmed) continue;
    out[trimmed] = String(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function missingStrings(required: string[], got: string[]): string[] {
  const seen = new Set(got.map((value) => value.trim()).filter(Boolean));
  return required.filter((value) => !seen.has(value)).sort();
}

export const MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER =
  "m15.microvm.unauthenticated_controller";
export const MICROVM_ERROR_CONTROLLER_INCOMPLETE =
  "m15.microvm.controller_incomplete";
export const MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE =
  "m15.microvm.session_registry_incomplete";
export const MICROVM_ERROR_INVALID_CONTROLLER_REQUEST =
  "m15.microvm.invalid_controller_request";
export const MICROVM_ERROR_CONTROLLER_COMMAND_FAILED =
  "m15.microvm.controller_command_failed";
export const MICROVM_CONTROLLER_AUTH_DEFAULT_DENY = "deny";

export type MicroVMContractKind = "lifecycle" | "controller_session";

export const MicroVMCommand = {
  Create: "create",
  Start: "start",
  Stop: "stop",
  Status: "status",
  Session: "session",
} as const;

export type MicroVMCommandName =
  (typeof MicroVMCommand)[keyof typeof MicroVMCommand];

export interface MicroVMControllerAuthContract {
  required: boolean;
  default: string;
}

export interface MicroVMControllerEnvelopeContract {
  required_fields: string[];
  safe_error_fields: string[];
  forbidden_fields: string[];
}

export interface MicroVMControllerCommandContract {
  name: MicroVMCommandName | string;
  method: string;
  path: string;
  request_fields: string[];
  response_fields: string[];
}

export interface MicroVMControllerContract {
  auth: MicroVMControllerAuthContract;
  envelope: MicroVMControllerEnvelopeContract;
  commands: MicroVMControllerCommandContract[];
}

export interface MicroVMSessionRegistryContract {
  pattern: string;
  tenant_binding: string[];
  required_fields: string[];
  state_values: string[];
  forbidden_fields: string[];
}

export interface MicroVMAuthContext {
  subject: string;
  tenant_id: string;
  namespace?: string;
  entitlements?: string[];
  metadata?: Record<string, string>;
}

export interface MicroVMSessionSpec {
  metadata?: Record<string, string>;
}

export interface MicroVMControllerRequest {
  command: MicroVMCommandName | string;
  request_id: string;
  tenant_id: string;
  namespace: string;
  auth_context: MicroVMAuthContext;
  session_id?: string;
  image_ref?: string;
  network_connector_ref?: string;
  session_spec?: MicroVMSessionSpec;
}

export interface MicroVMControllerResponse {
  command: MicroVMCommandName | string;
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  state?: MicroVMLifecycleState | string;
  desired_state?: MicroVMLifecycleState | string;
  lifecycle_state?: MicroVMLifecycleState | string;
  last_transition?: Date;
  registry_version?: number;
  error?: MicroVMSafeError;
}

export interface MicroVMCreateSessionInput {
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  image_ref: string;
  network_connector_ref: string;
  session_spec: MicroVMSessionSpec;
  controller_id: string;
  auth_subject: string;
  now: Date;
}

export interface MicroVMSessionCommandInput {
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  controller_id: string;
  auth_subject: string;
  desired_state: MicroVMLifecycleState | string;
  now: Date;
}

export interface MicroVMSessionQueryInput {
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  auth_subject: string;
}

export interface MicroVMSessionKey {
  tenant_id: string;
  namespace: string;
  session_id: string;
}

export interface MicroVMSessionRecord {
  tenant_id: string;
  namespace: string;
  session_id: string;
  state: MicroVMLifecycleState | string;
  desired_state: MicroVMLifecycleState | string;
  image_ref: string;
  network_connector_ref?: string;
  controller_id: string;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  generation: number;
  last_command_id: string;
  auth_subject: string;
  metadata?: Record<string, string>;
}

export interface MicroVMSessionStatus {
  tenant_id: string;
  namespace: string;
  session_id: string;
  state: MicroVMLifecycleState | string;
  desired_state: MicroVMLifecycleState | string;
  lifecycle_state: MicroVMLifecycleState | string;
  last_transition: Date;
  registry_version: number;
}

export interface MicroVMClient {
  create: (input: MicroVMCreateSessionInput) => Promise<MicroVMSessionRecord>;
  start: (input: MicroVMSessionCommandInput) => Promise<MicroVMSessionRecord>;
  stop: (input: MicroVMSessionCommandInput) => Promise<MicroVMSessionRecord>;
  status: (input: MicroVMSessionQueryInput) => Promise<MicroVMSessionStatus>;
  session: (input: MicroVMSessionQueryInput) => Promise<MicroVMSessionRecord>;
}

export interface MicroVMClock {
  now: () => Date;
}

export interface MicroVMIDGenerator {
  newID: () => string;
}

export interface MicroVMControllerOptions {
  controller_id?: string;
  clock?: MicroVMClock;
  ids?: MicroVMIDGenerator;
}

export interface MicroVMClientCall {
  command: MicroVMCommandName | string;
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
}

export interface AWSLambdaMicroVMClientOptions {
  region?: string;
}

export function defaultMicroVMControllerContract(): MicroVMControllerContract {
  return {
    auth: { required: true, default: MICROVM_CONTROLLER_AUTH_DEFAULT_DENY },
    envelope: {
      required_fields: ["command", "request_id", "tenant_id", "auth_context"],
      safe_error_fields: ["code", "message", "request_id"],
      forbidden_fields: [
        "aws_access_key_id",
        "aws_secret_access_key",
        "raw_sdk_client",
        "bearer_token",
      ],
    },
    commands: [
      {
        name: MicroVMCommand.Create,
        method: "POST",
        path: "/microvms",
        request_fields: ["image_ref", "network_connector_ref", "session_spec"],
        response_fields: ["session_id", "state", "registry_version"],
      },
      {
        name: MicroVMCommand.Start,
        method: "POST",
        path: "/microvms/{session_id}/start",
        request_fields: ["session_id"],
        response_fields: ["session_id", "state", "desired_state"],
      },
      {
        name: MicroVMCommand.Stop,
        method: "POST",
        path: "/microvms/{session_id}/stop",
        request_fields: ["session_id"],
        response_fields: ["session_id", "state", "desired_state"],
      },
      {
        name: MicroVMCommand.Status,
        method: "GET",
        path: "/microvms/{session_id}/status",
        request_fields: ["session_id"],
        response_fields: [
          "session_id",
          "state",
          "lifecycle_state",
          "last_transition",
        ],
      },
      {
        name: MicroVMCommand.Session,
        method: "GET",
        path: "/microvms/{session_id}",
        request_fields: ["session_id"],
        response_fields: [
          "session_id",
          "tenant_id",
          "namespace",
          "state",
          "registry_version",
        ],
      },
    ],
  };
}

export function defaultMicroVMSessionRegistryContract(): MicroVMSessionRegistryContract {
  return {
    pattern: "tabletheory-single-table",
    tenant_binding: ["tenant_id", "namespace"],
    required_fields: [
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
    state_values: requiredMicroVMLifecycleStates(),
    forbidden_fields: [
      "raw_aws_credentials",
      "raw_lifecycle_hook_payload",
      "bearer_token",
      "session_token_plaintext",
    ],
  };
}

export function validateMicroVMControllerContract(
  contract: MicroVMControllerContract,
): void {
  if (!microVMControllerAuthDefaultsDeny(contract.auth)) {
    throw safeError(
      MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
      "apptheory: microvm controller must default to authenticated deny",
      "",
    );
  }
  const missingEnvelope = missingStrings(
    ["command", "request_id", "tenant_id", "auth_context"],
    contract.envelope.required_fields ?? [],
  );
  if (missingEnvelope.length > 0) {
    throw safeError(
      MICROVM_ERROR_CONTROLLER_INCOMPLETE,
      `apptheory: microvm controller envelope missing fields: ${missingEnvelope.join(",")}`,
      "",
    );
  }
  const missingSafeError = missingStrings(
    ["code", "message", "request_id"],
    contract.envelope.safe_error_fields ?? [],
  );
  if (missingSafeError.length > 0) {
    throw safeError(
      MICROVM_ERROR_CONTROLLER_INCOMPLETE,
      `apptheory: microvm controller safe error missing fields: ${missingSafeError.join(",")}`,
      "",
    );
  }
  const missingForbidden = missingStrings(
    ["raw_sdk_client", "bearer_token"],
    contract.envelope.forbidden_fields ?? [],
  );
  if (missingForbidden.length > 0) {
    throw safeError(
      MICROVM_ERROR_CONTROLLER_INCOMPLETE,
      `apptheory: microvm controller envelope missing forbidden fields: ${missingForbidden.join(",")}`,
      "",
    );
  }

  const commands = new Map<
    MicroVMCommandName,
    MicroVMControllerCommandContract
  >();
  for (const rawCommand of contract.commands ?? []) {
    const name = normalizeMicroVMCommand(rawCommand.name);
    if (
      !name ||
      !String(rawCommand.method ?? "").trim() ||
      !String(rawCommand.path ?? "").trim()
    ) {
      throw safeError(
        MICROVM_ERROR_CONTROLLER_INCOMPLETE,
        "apptheory: microvm controller commands must define name, method, and path",
        "",
      );
    }
    if (
      (rawCommand.request_fields ?? []).length === 0 ||
      (rawCommand.response_fields ?? []).length === 0
    ) {
      throw safeError(
        MICROVM_ERROR_CONTROLLER_INCOMPLETE,
        `apptheory: microvm controller command ${name} must define request and response fields`,
        "",
      );
    }
    if (isRequiredMicroVMCommand(name)) commands.set(name, rawCommand);
  }
  for (const required of requiredMicroVMControllerCommands()) {
    if (!commands.has(required)) {
      throw safeError(
        MICROVM_ERROR_CONTROLLER_INCOMPLETE,
        `apptheory: microvm controller missing command: ${required}`,
        "",
      );
    }
  }
}

export function validateMicroVMSessionRegistryContract(
  registry: MicroVMSessionRegistryContract,
): void {
  if (String(registry.pattern ?? "").trim() !== "tabletheory-single-table") {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm session registry must use tabletheory-single-table guidance",
      "",
    );
  }
  const missingTenantBinding = missingStrings(
    ["tenant_id", "namespace"],
    registry.tenant_binding ?? [],
  );
  if (missingTenantBinding.length > 0) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      `apptheory: microvm session registry missing tenant binding: ${missingTenantBinding.join(",")}`,
      "",
    );
  }
  const missingFields = missingStrings(
    defaultMicroVMSessionRegistryContract().required_fields,
    registry.required_fields ?? [],
  );
  if (missingFields.length > 0) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      `apptheory: microvm session registry missing fields: ${missingFields.join(",")}`,
      "",
    );
  }
  const missingStates = missingStrings(
    requiredMicroVMLifecycleStates(),
    registry.state_values ?? [],
  );
  if (missingStates.length > 0) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      `apptheory: microvm session registry missing states: ${missingStates.join(",")}`,
      "",
    );
  }
  const missingForbidden = missingStrings(
    ["raw_aws_credentials", "raw_lifecycle_hook_payload", "bearer_token"],
    registry.forbidden_fields ?? [],
  );
  if (missingForbidden.length > 0) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      `apptheory: microvm session registry missing forbidden fields: ${missingForbidden.join(",")}`,
      "",
    );
  }
}

export function validateMicroVMSessionRecord(
  record: MicroVMSessionRecord,
): void {
  const normalized = normalizeMicroVMSessionRecord(record);
  if (
    !normalized.tenant_id ||
    !normalized.namespace ||
    !normalized.session_id ||
    !normalized.state ||
    !normalized.desired_state ||
    !normalized.image_ref ||
    !normalized.controller_id ||
    !normalized.last_command_id ||
    !normalized.auth_subject
  ) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm session record is incomplete",
      normalized.last_command_id,
    );
  }
  if (
    !validDate(normalized.created_at) ||
    !validDate(normalized.updated_at) ||
    !validDate(normalized.expires_at) ||
    normalized.generation <= 0
  ) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm session record registry fields are incomplete",
      normalized.last_command_id,
    );
  }
  if (
    !validMicroVMLifecycleState(normalized.state) ||
    !validMicroVMLifecycleState(normalized.desired_state)
  ) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm session record state is unsupported",
      normalized.last_command_id,
    );
  }
  const metadataErr = validateSafeMicroVMMetadata(
    normalized.metadata,
    normalized.last_command_id,
  );
  if (metadataErr) throw metadataErr;
}

export function validateMicroVMSessionStatus(
  status: MicroVMSessionStatus,
): void {
  const normalized = normalizeMicroVMSessionStatus(status);
  if (
    !normalized.tenant_id ||
    !normalized.namespace ||
    !normalized.session_id ||
    !normalized.state ||
    !normalized.desired_state ||
    !normalized.lifecycle_state ||
    !validDate(normalized.last_transition) ||
    normalized.registry_version <= 0
  ) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm session status is incomplete",
      "",
    );
  }
  if (
    !validMicroVMLifecycleState(normalized.state) ||
    !validMicroVMLifecycleState(normalized.desired_state) ||
    !validMicroVMLifecycleState(normalized.lifecycle_state)
  ) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm session status state is unsupported",
      "",
    );
  }
}

export function microVMSessionKey(
  record: MicroVMSessionRecord,
): MicroVMSessionKey {
  return {
    tenant_id: String(record.tenant_id ?? "").trim(),
    namespace: String(record.namespace ?? "").trim(),
    session_id: String(record.session_id ?? "").trim(),
  };
}

export class MicroVMController {
  private readonly client: MicroVMClient;
  private readonly controllerID: string;
  private readonly clock: MicroVMClock;
  private readonly ids: MicroVMIDGenerator;

  constructor(client: MicroVMClient, options: MicroVMControllerOptions = {}) {
    if (!client) {
      throw safeError(
        MICROVM_ERROR_CONTROLLER_INCOMPLETE,
        "apptheory: microvm controller requires a constrained client",
        "",
      );
    }
    this.client = client;
    this.controllerID =
      String(options.controller_id ?? "").trim() ||
      "apptheory-microvm-controller";
    this.clock = options.clock ?? { now: () => new Date() };
    this.ids = options.ids ?? { newID: () => randomMicroVMSessionID() };
  }

  async handle(
    request: MicroVMControllerRequest,
  ): Promise<MicroVMControllerResponse> {
    const normalized = normalizeMicroVMControllerRequest(request);
    const validationErr = validateMicroVMControllerRequest(normalized);
    if (validationErr)
      return controllerErrorResponse(normalized, validationErr);

    switch (normalized.command) {
      case MicroVMCommand.Create:
        return await this.handleCreate(normalized);
      case MicroVMCommand.Start:
        return await this.handleCommand(
          normalized,
          MicroVMState.Started,
          this.client.start,
        );
      case MicroVMCommand.Stop:
        return await this.handleCommand(
          normalized,
          MicroVMState.Stopped,
          this.client.stop,
        );
      case MicroVMCommand.Status:
        return await this.handleStatus(normalized);
      case MicroVMCommand.Session:
        return await this.handleSession(normalized);
      default: {
        const err = safeError(
          MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
          "apptheory: microvm controller command is unsupported",
          normalized.request_id,
        );
        return controllerErrorResponse(normalized, err);
      }
    }
  }

  private async handleCreate(
    request: NormalizedMicroVMControllerRequest,
  ): Promise<MicroVMControllerResponse> {
    let sessionID = String(request.session_id ?? "").trim();
    if (!sessionID) sessionID = String(this.ids.newID() ?? "").trim();
    if (!sessionID) {
      const err = safeError(
        MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
        "apptheory: microvm controller could not allocate session id",
        request.request_id,
      );
      return controllerErrorResponse(request, err);
    }

    try {
      const record = await this.client.create({
        request_id: request.request_id,
        tenant_id: request.tenant_id,
        namespace: request.namespace,
        session_id: sessionID,
        image_ref: request.image_ref,
        network_connector_ref: request.network_connector_ref,
        session_spec: cloneMicroVMSessionSpec(request.session_spec),
        controller_id: this.controllerID,
        auth_subject: request.auth_context.subject,
        now: this.clock.now(),
      });
      validateMicroVMSessionRecord(record);
      return responseFromMicroVMSession(request, record);
    } catch (err) {
      return controllerErrorResponse(
        request,
        asMicroVMSafeError(err, request.request_id),
      );
    }
  }

  private async handleCommand(
    request: NormalizedMicroVMControllerRequest,
    desiredState: MicroVMLifecycleState,
    run: (input: MicroVMSessionCommandInput) => Promise<MicroVMSessionRecord>,
  ): Promise<MicroVMControllerResponse> {
    try {
      const record = await run.call(this.client, {
        request_id: request.request_id,
        tenant_id: request.tenant_id,
        namespace: request.namespace,
        session_id: request.session_id,
        controller_id: this.controllerID,
        auth_subject: request.auth_context.subject,
        desired_state: desiredState,
        now: this.clock.now(),
      });
      validateMicroVMSessionRecord(record);
      return responseFromMicroVMSession(request, record);
    } catch (err) {
      return controllerErrorResponse(
        request,
        asMicroVMSafeError(err, request.request_id),
      );
    }
  }

  private async handleStatus(
    request: NormalizedMicroVMControllerRequest,
  ): Promise<MicroVMControllerResponse> {
    try {
      const status = await this.client.status(controllerQueryInput(request));
      validateMicroVMSessionStatus(status);
      return responseFromMicroVMStatus(request, status);
    } catch (err) {
      return controllerErrorResponse(
        request,
        asMicroVMSafeError(err, request.request_id),
      );
    }
  }

  private async handleSession(
    request: NormalizedMicroVMControllerRequest,
  ): Promise<MicroVMControllerResponse> {
    try {
      const record = await this.client.session(controllerQueryInput(request));
      validateMicroVMSessionRecord(record);
      return responseFromMicroVMSession(request, record);
    } catch (err) {
      return controllerErrorResponse(
        request,
        asMicroVMSafeError(err, request.request_id),
      );
    }
  }
}

export function createMicroVMController(
  client: MicroVMClient,
  options: MicroVMControllerOptions = {},
): MicroVMController {
  return new MicroVMController(client, options);
}

export function validateMicroVMControllerRequest(
  request: MicroVMControllerRequest,
): MicroVMSafeError | null {
  const normalized = normalizeMicroVMControllerRequest(request);
  if (
    !normalized.command ||
    !normalized.request_id ||
    !normalized.tenant_id ||
    !normalized.namespace
  ) {
    return safeError(
      MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
      "apptheory: microvm controller envelope is incomplete",
      normalized.request_id,
    );
  }
  if (!normalized.auth_context.subject || !normalized.auth_context.tenant_id) {
    return safeError(
      MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
      "apptheory: microvm controller must default to authenticated deny",
      normalized.request_id,
    );
  }
  if (normalized.auth_context.tenant_id !== normalized.tenant_id) {
    return safeError(
      MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
      "apptheory: microvm controller tenant binding mismatch",
      normalized.request_id,
    );
  }
  if (
    normalized.auth_context.namespace &&
    normalized.auth_context.namespace !== normalized.namespace
  ) {
    return safeError(
      MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
      "apptheory: microvm controller namespace binding mismatch",
      normalized.request_id,
    );
  }
  const authMetadataErr = validateSafeMicroVMMetadata(
    normalized.auth_context.metadata,
    normalized.request_id,
  );
  if (authMetadataErr) return authMetadataErr;
  const specMetadataErr = validateSafeMicroVMMetadata(
    normalized.session_spec.metadata,
    normalized.request_id,
  );
  if (specMetadataErr) return specMetadataErr;

  switch (normalized.command) {
    case MicroVMCommand.Create:
      if (!normalized.image_ref || !normalized.network_connector_ref) {
        return safeError(
          MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
          "apptheory: microvm create requires image and network connector refs",
          normalized.request_id,
        );
      }
      return null;
    case MicroVMCommand.Start:
    case MicroVMCommand.Stop:
    case MicroVMCommand.Status:
    case MicroVMCommand.Session:
      if (!normalized.session_id) {
        return safeError(
          MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
          "apptheory: microvm controller session_id is required",
          normalized.request_id,
        );
      }
      return null;
    default:
      return safeError(
        MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
        "apptheory: microvm controller command is unsupported",
        normalized.request_id,
      );
  }
}

export class FakeMicroVMClient implements MicroVMClient {
  private currentTime: Date;
  private readonly sessions = new Map<string, MicroVMSessionRecord>();
  private readonly recordedCalls: MicroVMClientCall[] = [];

  constructor(now: Date = new Date(0)) {
    this.currentTime = coalesceMicroVMTime(now, new Date(0));
  }

  setNow(now: Date): void {
    if (validDate(now)) this.currentTime = new Date(now.valueOf());
  }

  calls(): MicroVMClientCall[] {
    return this.recordedCalls.map((call) => ({ ...call }));
  }

  async create(
    input: MicroVMCreateSessionInput,
  ): Promise<MicroVMSessionRecord> {
    this.recordCall(
      MicroVMCommand.Create,
      input.request_id,
      input.tenant_id,
      input.namespace,
      input.session_id,
    );
    const now = coalesceMicroVMTime(input.now, this.currentTime);
    const record: MicroVMSessionRecord = {
      tenant_id: input.tenant_id,
      namespace: input.namespace,
      session_id: input.session_id,
      state: MicroVMState.Requested,
      desired_state: MicroVMState.Requested,
      image_ref: input.image_ref,
      controller_id: input.controller_id,
      created_at: now,
      updated_at: now,
      expires_at: new Date(now.valueOf() + 60 * 60 * 1000),
      generation: 1,
      last_command_id: input.request_id,
      auth_subject: input.auth_subject,
    };
    if (input.network_connector_ref) {
      record.network_connector_ref = input.network_connector_ref;
    }
    const metadata = cloneStringMap(input.session_spec.metadata);
    if (metadata) record.metadata = metadata;
    validateMicroVMSessionRecord(record);
    const key = microVMSessionRecordKey(record);
    if (this.sessions.has(key)) throw new Error("session already exists");
    this.sessions.set(key, cloneMicroVMSessionRecord(record));
    return cloneMicroVMSessionRecord(record);
  }

  async start(
    input: MicroVMSessionCommandInput,
  ): Promise<MicroVMSessionRecord> {
    return this.transition(
      input,
      MicroVMCommand.Start,
      MicroVMState.Starting,
      MicroVMState.Started,
    );
  }

  async stop(input: MicroVMSessionCommandInput): Promise<MicroVMSessionRecord> {
    return this.transition(
      input,
      MicroVMCommand.Stop,
      MicroVMState.Stopping,
      MicroVMState.Stopped,
    );
  }

  async status(input: MicroVMSessionQueryInput): Promise<MicroVMSessionStatus> {
    this.recordCall(
      MicroVMCommand.Status,
      input.request_id,
      input.tenant_id,
      input.namespace,
      input.session_id,
    );
    const record = this.lookup(
      input.tenant_id,
      input.namespace,
      input.session_id,
    );
    return {
      tenant_id: record.tenant_id,
      namespace: record.namespace,
      session_id: record.session_id,
      state: record.state,
      desired_state: record.desired_state,
      lifecycle_state: record.state,
      last_transition: record.updated_at,
      registry_version: record.generation,
    };
  }

  async session(
    input: MicroVMSessionQueryInput,
  ): Promise<MicroVMSessionRecord> {
    this.recordCall(
      MicroVMCommand.Session,
      input.request_id,
      input.tenant_id,
      input.namespace,
      input.session_id,
    );
    return cloneMicroVMSessionRecord(
      this.lookup(input.tenant_id, input.namespace, input.session_id),
    );
  }

  private async transition(
    input: MicroVMSessionCommandInput,
    command: MicroVMCommandName,
    state: MicroVMLifecycleState,
    desiredState: MicroVMLifecycleState,
  ): Promise<MicroVMSessionRecord> {
    this.recordCall(
      command,
      input.request_id,
      input.tenant_id,
      input.namespace,
      input.session_id,
    );
    const record = this.lookup(
      input.tenant_id,
      input.namespace,
      input.session_id,
    );
    const next: MicroVMSessionRecord = {
      ...record,
      state,
      desired_state: desiredState,
      controller_id: input.controller_id,
      auth_subject: input.auth_subject,
      last_command_id: input.request_id,
      updated_at: coalesceMicroVMTime(input.now, this.currentTime),
      generation: record.generation + 1,
    };
    validateMicroVMSessionRecord(next);
    this.sessions.set(
      microVMSessionRecordKey(next),
      cloneMicroVMSessionRecord(next),
    );
    return cloneMicroVMSessionRecord(next);
  }

  private lookup(
    tenantID: string,
    namespace: string,
    sessionID: string,
  ): MicroVMSessionRecord {
    const key = microVMSessionKeyString(tenantID, namespace, sessionID);
    const record = this.sessions.get(key);
    if (!record) throw new Error("session not found");
    return cloneMicroVMSessionRecord(record);
  }

  private recordCall(
    command: MicroVMCommandName,
    requestID: string,
    tenantID: string,
    namespace: string,
    sessionID: string,
  ): void {
    this.recordedCalls.push({
      command,
      request_id: requestID,
      tenant_id: tenantID,
      namespace,
      session_id: sessionID,
    });
  }
}

export function createFakeMicroVMClient(
  now: Date = new Date(0),
): FakeMicroVMClient {
  return new FakeMicroVMClient(now);
}

export async function createAWSLambdaMicroVMClient(
  options: AWSLambdaMicroVMClientOptions = {},
): Promise<MicroVMClient> {
  try {
    const packageName = "@aws-sdk/client-lambda-microvms";
    const sdk = (await import(packageName)) as Record<string, unknown>;
    const ClientCtor = getSDKConstructor(sdk, [
      "LambdaMicrovmsClient",
      "LambdaMicroVMsClient",
      "LambdaMicroVMClient",
    ]);
    const commands = {
      create: getSDKConstructor(sdk, [
        "CreateMicrovmSessionCommand",
        "CreateMicroVMSessionCommand",
      ]),
      start: getSDKConstructor(sdk, [
        "StartMicrovmSessionCommand",
        "StartMicroVMSessionCommand",
      ]),
      stop: getSDKConstructor(sdk, [
        "StopMicrovmSessionCommand",
        "StopMicroVMSessionCommand",
      ]),
      status: getSDKConstructor(sdk, [
        "GetMicrovmSessionStatusCommand",
        "GetMicroVMSessionStatusCommand",
      ]),
      session: getSDKConstructor(sdk, [
        "GetMicrovmSessionCommand",
        "GetMicroVMSessionCommand",
      ]),
    };
    const client = new ClientCtor(
      options.region ? { region: options.region } : {},
    ) as SDKSendClient;
    return new AWSLambdaMicroVMConstrainedClient(client, commands);
  } catch (err) {
    if (err instanceof MicroVMSafeError) throw err;
    throw safeError(
      MICROVM_ERROR_CONTROLLER_INCOMPLETE,
      "apptheory: microvm AWS SDK lacks Lambda MicroVM support",
      "",
    );
  }
}

type SDKCommandConstructor = new (input: Record<string, unknown>) => unknown;

type SDKSendClient = {
  send: (command: unknown) => Promise<unknown>;
};

interface AWSLambdaMicroVMCommandSet {
  create: SDKCommandConstructor;
  start: SDKCommandConstructor;
  stop: SDKCommandConstructor;
  status: SDKCommandConstructor;
  session: SDKCommandConstructor;
}

class AWSLambdaMicroVMConstrainedClient implements MicroVMClient {
  constructor(
    private readonly client: SDKSendClient,
    private readonly commands: AWSLambdaMicroVMCommandSet,
  ) {}

  async create(
    input: MicroVMCreateSessionInput,
  ): Promise<MicroVMSessionRecord> {
    try {
      const output = await this.client.send(
        new this.commands.create({
          sessionId: input.session_id,
          tenantId: input.tenant_id,
          namespace: input.namespace,
          imageRef: input.image_ref,
          networkConnectorRef: input.network_connector_ref,
          metadata: input.session_spec.metadata ?? {},
        }),
      );
      return sessionRecordFromAWSOutput(
        input,
        output,
        MicroVMState.Requested,
        MicroVMState.Requested,
      );
    } catch (err) {
      throw asMicroVMSafeError(err, input.request_id);
    }
  }

  async start(
    input: MicroVMSessionCommandInput,
  ): Promise<MicroVMSessionRecord> {
    return await this.runRecordCommand(
      this.commands.start,
      input,
      MicroVMState.Starting,
    );
  }

  async stop(input: MicroVMSessionCommandInput): Promise<MicroVMSessionRecord> {
    return await this.runRecordCommand(
      this.commands.stop,
      input,
      MicroVMState.Stopping,
    );
  }

  async status(input: MicroVMSessionQueryInput): Promise<MicroVMSessionStatus> {
    try {
      const output = await this.client.send(
        new this.commands.status(queryAWSInput(input)),
      );
      const status = sessionStatusFromAWSOutput(input, output);
      validateMicroVMSessionStatus(status);
      return status;
    } catch (err) {
      throw asMicroVMSafeError(err, input.request_id);
    }
  }

  async session(
    input: MicroVMSessionQueryInput,
  ): Promise<MicroVMSessionRecord> {
    try {
      const output = await this.client.send(
        new this.commands.session(queryAWSInput(input)),
      );
      const record = sessionRecordFromAWSOutput(
        {
          request_id: input.request_id,
          tenant_id: input.tenant_id,
          namespace: input.namespace,
          session_id: input.session_id,
          image_ref: stringField(output, "imageRef") || "microvm-image",
          network_connector_ref: stringField(output, "networkConnectorRef"),
          session_spec: {},
          controller_id:
            stringField(output, "controllerId") ||
            "apptheory-microvm-controller",
          auth_subject: input.auth_subject,
          now: new Date(),
        },
        output,
        stringField(output, "state") || MicroVMState.Requested,
        stringField(output, "desiredState") || MicroVMState.Requested,
      );
      validateMicroVMSessionRecord(record);
      return record;
    } catch (err) {
      throw asMicroVMSafeError(err, input.request_id);
    }
  }

  private async runRecordCommand(
    CommandCtor: SDKCommandConstructor,
    input: MicroVMSessionCommandInput,
    activeState: MicroVMLifecycleState,
  ): Promise<MicroVMSessionRecord> {
    try {
      const output = await this.client.send(
        new CommandCtor({
          ...queryAWSInput(input),
          desiredState: input.desired_state,
        }),
      );
      const record = sessionRecordFromAWSOutput(
        {
          request_id: input.request_id,
          tenant_id: input.tenant_id,
          namespace: input.namespace,
          session_id: input.session_id,
          image_ref: stringField(output, "imageRef") || "microvm-image",
          network_connector_ref: stringField(output, "networkConnectorRef"),
          session_spec: {},
          controller_id: input.controller_id,
          auth_subject: input.auth_subject,
          now: input.now,
        },
        output,
        activeState,
        input.desired_state,
      );
      validateMicroVMSessionRecord(record);
      return record;
    } catch (err) {
      throw asMicroVMSafeError(err, input.request_id);
    }
  }
}

function microVMControllerAuthDefaultsDeny(
  auth: MicroVMControllerAuthContract,
): boolean {
  return (
    auth.required === true &&
    String(auth.default ?? "")
      .trim()
      .toLowerCase() === MICROVM_CONTROLLER_AUTH_DEFAULT_DENY
  );
}

function normalizeMicroVMCommand(
  command: MicroVMCommandName | string,
): MicroVMCommandName | "" {
  return String(command ?? "").trim() as MicroVMCommandName | "";
}

function requiredMicroVMControllerCommands(): MicroVMCommandName[] {
  return [
    MicroVMCommand.Create,
    MicroVMCommand.Start,
    MicroVMCommand.Stop,
    MicroVMCommand.Status,
    MicroVMCommand.Session,
  ];
}

function isRequiredMicroVMCommand(
  command: string,
): command is MicroVMCommandName {
  return (requiredMicroVMControllerCommands() as string[]).includes(command);
}

function validMicroVMLifecycleState(state: string): boolean {
  return requiredMicroVMLifecycleStates().includes(
    normalizeMicroVMLifecycleState(state) as MicroVMLifecycleState,
  );
}

type NormalizedMicroVMControllerRequest = Required<
  Pick<
    MicroVMControllerRequest,
    | "command"
    | "request_id"
    | "tenant_id"
    | "namespace"
    | "auth_context"
    | "session_id"
    | "image_ref"
    | "network_connector_ref"
    | "session_spec"
  >
>;

function normalizeMicroVMControllerRequest(
  request: MicroVMControllerRequest,
): NormalizedMicroVMControllerRequest {
  return {
    command: normalizeMicroVMCommand(request.command),
    request_id: String(request.request_id ?? "").trim(),
    tenant_id: String(request.tenant_id ?? "").trim(),
    namespace: String(request.namespace ?? "").trim(),
    auth_context: normalizeMicroVMAuthContext(request.auth_context ?? {}),
    session_id: String(request.session_id ?? "").trim(),
    image_ref: String(request.image_ref ?? "").trim(),
    network_connector_ref: String(request.network_connector_ref ?? "").trim(),
    session_spec: cloneMicroVMSessionSpec(request.session_spec ?? {}),
  };
}

function normalizeMicroVMAuthContext(
  auth: Partial<MicroVMAuthContext>,
): MicroVMAuthContext {
  const out: MicroVMAuthContext = {
    subject: String(auth.subject ?? "").trim(),
    tenant_id: String(auth.tenant_id ?? "").trim(),
  };
  const namespace = String(auth.namespace ?? "").trim();
  if (namespace) out.namespace = namespace;
  const entitlements = [...(auth.entitlements ?? [])]
    .map(String)
    .filter(Boolean);
  if (entitlements.length > 0) out.entitlements = entitlements;
  const metadata = cloneStringMap(auth.metadata);
  if (metadata) out.metadata = metadata;
  return out;
}

function cloneMicroVMSessionSpec(spec: MicroVMSessionSpec): MicroVMSessionSpec {
  const out: MicroVMSessionSpec = {};
  const metadata = cloneStringMap(spec.metadata);
  if (metadata) out.metadata = metadata;
  return out;
}

function controllerQueryInput(
  request: NormalizedMicroVMControllerRequest,
): MicroVMSessionQueryInput {
  return {
    request_id: request.request_id,
    tenant_id: request.tenant_id,
    namespace: request.namespace,
    session_id: request.session_id,
    auth_subject: request.auth_context.subject,
  };
}

function responseFromMicroVMSession(
  request: NormalizedMicroVMControllerRequest,
  record: MicroVMSessionRecord,
): MicroVMControllerResponse {
  const normalized = normalizeMicroVMSessionRecord(record);
  return {
    command: request.command,
    request_id: request.request_id,
    tenant_id: normalized.tenant_id,
    namespace: normalized.namespace,
    session_id: normalized.session_id,
    state: normalized.state,
    desired_state: normalized.desired_state,
    lifecycle_state: normalized.state,
    last_transition: normalized.updated_at,
    registry_version: normalized.generation,
  };
}

function responseFromMicroVMStatus(
  request: NormalizedMicroVMControllerRequest,
  status: MicroVMSessionStatus,
): MicroVMControllerResponse {
  const normalized = normalizeMicroVMSessionStatus(status);
  return {
    command: request.command,
    request_id: request.request_id,
    tenant_id: normalized.tenant_id,
    namespace: normalized.namespace,
    session_id: normalized.session_id,
    state: normalized.state,
    desired_state: normalized.desired_state,
    lifecycle_state: normalized.lifecycle_state,
    last_transition: normalized.last_transition,
    registry_version: normalized.registry_version,
  };
}

function controllerErrorResponse(
  request: MicroVMControllerRequest,
  err: MicroVMSafeError,
): MicroVMControllerResponse {
  const normalized = normalizeMicroVMControllerRequest(request);
  return {
    command: normalized.command,
    request_id: normalized.request_id,
    tenant_id: normalized.tenant_id,
    namespace: normalized.namespace,
    session_id: normalized.session_id,
    error: err,
  };
}

function asMicroVMSafeError(err: unknown, requestID: string): MicroVMSafeError {
  if (err instanceof MicroVMSafeError) {
    return err.request_id ? err : safeError(err.code, err.message, requestID);
  }
  return safeError(
    MICROVM_ERROR_CONTROLLER_COMMAND_FAILED,
    "apptheory: microvm controller command failed",
    requestID,
  );
}

function normalizeMicroVMSessionRecord(
  record: MicroVMSessionRecord,
): MicroVMSessionRecord {
  const out: MicroVMSessionRecord = {
    tenant_id: String(record.tenant_id ?? "").trim(),
    namespace: String(record.namespace ?? "").trim(),
    session_id: String(record.session_id ?? "").trim(),
    state: normalizeMicroVMLifecycleState(record.state),
    desired_state: normalizeMicroVMLifecycleState(record.desired_state),
    image_ref: String(record.image_ref ?? "").trim(),
    controller_id: String(record.controller_id ?? "").trim(),
    created_at: cloneMicroVMDate(record.created_at),
    updated_at: cloneMicroVMDate(record.updated_at),
    expires_at: cloneMicroVMDate(record.expires_at),
    generation: Math.trunc(Number(record.generation) || 0),
    last_command_id: String(record.last_command_id ?? "").trim(),
    auth_subject: String(record.auth_subject ?? "").trim(),
  };
  const networkConnectorRef = String(record.network_connector_ref ?? "").trim();
  if (networkConnectorRef) out.network_connector_ref = networkConnectorRef;
  const metadata = cloneStringMap(record.metadata);
  if (metadata) out.metadata = metadata;
  return out;
}

function normalizeMicroVMSessionStatus(
  status: MicroVMSessionStatus,
): MicroVMSessionStatus {
  return {
    tenant_id: String(status.tenant_id ?? "").trim(),
    namespace: String(status.namespace ?? "").trim(),
    session_id: String(status.session_id ?? "").trim(),
    state: normalizeMicroVMLifecycleState(status.state),
    desired_state: normalizeMicroVMLifecycleState(status.desired_state),
    lifecycle_state: normalizeMicroVMLifecycleState(status.lifecycle_state),
    last_transition: cloneMicroVMDate(status.last_transition),
    registry_version: Math.trunc(Number(status.registry_version) || 0),
  };
}

function cloneMicroVMSessionRecord(
  record: MicroVMSessionRecord,
): MicroVMSessionRecord {
  return normalizeMicroVMSessionRecord(record);
}

function microVMSessionRecordKey(record: MicroVMSessionRecord): string {
  return microVMSessionKeyString(
    record.tenant_id,
    record.namespace,
    record.session_id,
  );
}

function microVMSessionKeyString(
  tenantID: string,
  namespace: string,
  sessionID: string,
): string {
  return `${String(tenantID ?? "").trim()}\u0000${String(namespace ?? "").trim()}\u0000${String(sessionID ?? "").trim()}`;
}

function coalesceMicroVMTime(value: Date, fallback: Date): Date {
  if (validDate(value)) return new Date(value.valueOf());
  if (validDate(fallback)) return new Date(fallback.valueOf());
  return new Date(0);
}

function cloneMicroVMDate(value: Date): Date {
  return validDate(value) ? new Date(value.valueOf()) : new Date(Number.NaN);
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.valueOf());
}

function randomMicroVMSessionID(): string {
  try {
    return `microvm-${randomBytes(16).toString("hex")}`;
  } catch {
    return `microvm-${new Date().toISOString().replace(/[^0-9]/g, "")}`;
  }
}

function getSDKConstructor(
  sdk: Record<string, unknown>,
  names: string[],
): SDKCommandConstructor {
  for (const name of names) {
    const candidate = sdk[name];
    if (typeof candidate === "function")
      return candidate as SDKCommandConstructor;
  }
  throw safeError(
    MICROVM_ERROR_CONTROLLER_INCOMPLETE,
    "apptheory: microvm AWS SDK lacks Lambda MicroVM support",
    "",
  );
}

function queryAWSInput(
  input: MicroVMSessionQueryInput,
): Record<string, unknown> {
  return {
    tenantId: input.tenant_id,
    namespace: input.namespace,
    sessionId: input.session_id,
  };
}

function sessionRecordFromAWSOutput(
  input: MicroVMCreateSessionInput,
  output: unknown,
  state: MicroVMLifecycleState | string,
  desiredState: MicroVMLifecycleState | string,
): MicroVMSessionRecord {
  const now = coalesceMicroVMTime(input.now, new Date());
  const createdAt = dateField(output, "createdAt") ?? now;
  const updatedAt = dateField(output, "updatedAt") ?? now;
  const expiresAt =
    dateField(output, "expiresAt") ?? new Date(now.valueOf() + 60 * 60 * 1000);
  const record: MicroVMSessionRecord = {
    tenant_id: stringField(output, "tenantId") || input.tenant_id,
    namespace: stringField(output, "namespace") || input.namespace,
    session_id: stringField(output, "sessionId") || input.session_id,
    state: stringField(output, "state") || state,
    desired_state: stringField(output, "desiredState") || desiredState,
    image_ref: stringField(output, "imageRef") || input.image_ref,
    controller_id: stringField(output, "controllerId") || input.controller_id,
    created_at: createdAt,
    updated_at: updatedAt,
    expires_at: expiresAt,
    generation: numberField(output, "generation") || 1,
    last_command_id: input.request_id,
    auth_subject: input.auth_subject,
  };
  const networkConnectorRef =
    stringField(output, "networkConnectorRef") || input.network_connector_ref;
  if (networkConnectorRef) record.network_connector_ref = networkConnectorRef;
  const metadata = cloneStringMap(input.session_spec.metadata);
  if (metadata) record.metadata = metadata;
  return record;
}

function sessionStatusFromAWSOutput(
  input: MicroVMSessionQueryInput,
  output: unknown,
): MicroVMSessionStatus {
  return {
    tenant_id: stringField(output, "tenantId") || input.tenant_id,
    namespace: stringField(output, "namespace") || input.namespace,
    session_id: stringField(output, "sessionId") || input.session_id,
    state: stringField(output, "state") || MicroVMState.Requested,
    desired_state:
      stringField(output, "desiredState") || MicroVMState.Requested,
    lifecycle_state:
      stringField(output, "lifecycleState") ||
      stringField(output, "state") ||
      MicroVMState.Requested,
    last_transition: dateField(output, "lastTransition") ?? new Date(),
    registry_version: numberField(output, "registryVersion") || 1,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown, key: string): string {
  return String(asRecord(value)[key] ?? "").trim();
}

function numberField(value: unknown, key: string): number {
  const raw = Number(asRecord(value)[key] ?? 0);
  return Number.isFinite(raw) ? Math.trunc(raw) : 0;
}

function dateField(value: unknown, key: string): Date | null {
  const raw = asRecord(value)[key];
  if (raw instanceof Date && validDate(raw)) return new Date(raw.valueOf());
  if (typeof raw === "string" || typeof raw === "number") {
    const parsed = new Date(raw);
    if (validDate(parsed)) return parsed;
  }
  return null;
}
