import { createHash, randomBytes } from "node:crypto";

import {
  CreateMicrovmAuthTokenCommand,
  CreateMicrovmShellAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
  type CreateMicrovmAuthTokenCommandInput,
  type CreateMicrovmShellAuthTokenCommandInput,
  type ListMicrovmsCommandInput,
  type RunMicrovmCommandInput,
} from "@aws-sdk/client-lambda-microvms";
import { defineModel, type Model } from "@theory-cloud/tabletheory-ts";

import type { App } from "./app.js";
import type { Context } from "./context.js";
import { json as jsonResponse } from "./response.js";
import type { Headers, Query, Response } from "./types.js";

export const MICROVM_CONTRACT_NAME = "apptheory.lambda_microvm";
export const MICROVM_CONTRACT_VERSION = "m15.microvm/v1";
export const MICROVM_ENV_EXECUTION_ROLE_ARN =
  "APPTHEORY_MICROVM_EXECUTION_ROLE_ARN";

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
  handlers?: Partial<
    Record<
      MicroVMLifecycleHook | MicroVMRealLifecycleHook,
      MicroVMLifecycleHandler
    >
  >;
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

export const MICROVM_CONTRACT_VERSION_M16 = "m16.microvm/v1";

export const MICROVM_ERROR_OPERATION_CONTRACT_INCOMPLETE =
  "m16.microvm.operation_contract_incomplete";
export const MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE =
  "m16.microvm.route_contract_incomplete";
export const MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE =
  "m16.microvm.provider_state_mapping_incomplete";
export const MICROVM_ERROR_TOKEN_SAFETY_VIOLATION =
  "m16.microvm.token_safety_violation";
export const MICROVM_ERROR_TENANT_BINDING_VIOLATION =
  "m16.microvm.tenant_binding_violation";
export const MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE =
  "m16.microvm.lifecycle_incomplete";

export const MicroVMOperation = {
  Run: "run",
  Get: "get",
  List: "list",
  Suspend: "suspend",
  Resume: "resume",
  Terminate: "terminate",
  AuthToken: "auth-token",
  ShellAuthToken: "shell-auth-token",
  ShellToken: "shell-auth-token",
} as const;

export type MicroVMOperationName =
  (typeof MicroVMOperation)[keyof typeof MicroVMOperation];

export const MicroVMRealHook = {
  Validate: "validate",
  Run: "run",
  Ready: "ready",
  Suspend: "suspend",
  Resume: "resume",
  Terminate: "terminate",
  Failure: "failure",
} as const;

export type MicroVMRealLifecycleHook =
  (typeof MicroVMRealHook)[keyof typeof MicroVMRealHook];

export const MicroVMRealState = {
  Requested: "requested",
  Validating: "validating",
  Validated: "validated",
  Running: "running",
  Ready: "ready",
  Suspending: "suspending",
  Suspended: "suspended",
  Resuming: "resuming",
  Terminating: "terminating",
  Terminated: "terminated",
  Failed: "failed",
} as const;

export type MicroVMRealLifecycleState =
  (typeof MicroVMRealState)[keyof typeof MicroVMRealState];

export interface MicroVMOperationHTTPRouteContract {
  operation: MicroVMOperationName | string;
  method: string;
  path: string;
  auth_required: boolean;
  default_auth: string;
  tenant_bound: boolean;
  recovery?: boolean;
  request_fields: string[];
  response_fields: string[];
  forbidden_fields?: string[];
}

export interface MicroVMProviderStateMapping {
  provider_state: string;
  state: MicroVMRealLifecycleState | string;
  terminal: boolean;
}

export interface MicroVMTokenIssuanceContract {
  operation: MicroVMOperationName | string;
  result_fields: string[];
  forbidden_fields: string[];
  sanitized: boolean;
  tenant_bound: boolean;
  session_bound: boolean;
  max_ttl_seconds: number;
}

export interface MicroVMTenantBindingRule {
  operation: MicroVMOperationName | string;
  request_tenant_id: string;
  request_namespace: string;
  record_tenant_id: string;
  record_namespace: string;
  recovery?: boolean;
  allowed: boolean;
}

export interface MicroVMOperationContract {
  operations: Array<MicroVMOperationName | string>;
  routes: MicroVMOperationHTTPRouteContract[];
  provider_state_mappings: MicroVMProviderStateMapping[];
  token_issuance: MicroVMTokenIssuanceContract[];
  tenant_binding: MicroVMTenantBindingRule[];
  forbidden_fields: string[];
}

export const MICROVM_ERROR_PROVIDER_REQUEST_INVALID =
  "m16.microvm.provider_request_invalid";
export const MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED =
  "m16.microvm.provider_operation_unsupported";
export const MICROVM_ERROR_PROVIDER_OPERATION_FAILED =
  "m16.microvm.provider_operation_failed";

export interface MicroVMProviderIdlePolicy {
  auto_resume_enabled: boolean;
  max_idle_duration_seconds: number;
  suspended_duration_seconds: number;
}

export interface MicroVMProviderRunInput {
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  auth_context: MicroVMAuthContext;
  image_ref: string;
  image_version?: string;
  network_connector_ref?: string;
  ingress_network_connector_refs?: string[];
  egress_network_connector_refs?: string[];
  session_spec?: MicroVMSessionSpec;
  idle_policy?: MicroVMProviderIdlePolicy;
  maximum_duration_seconds?: number;
  execution_role_arn?: string;
}

export interface MicroVMProviderSessionBinding {
  tenant_id: string;
  namespace: string;
  session_id: string;
  provider_microvm_id: string;
  registry_version?: number;
}

export interface MicroVMProviderSessionInput {
  request_id: string;
  tenant_id: string;
  namespace: string;
  auth_context: MicroVMAuthContext;
  binding: MicroVMProviderSessionBinding;
}

export interface MicroVMProviderListInput {
  request_id: string;
  tenant_id: string;
  namespace: string;
  auth_context: MicroVMAuthContext;
  image_ref?: string;
  image_version?: string;
  max_results?: number;
  known_sessions?: MicroVMProviderSessionBinding[];
}

export interface MicroVMProviderPortScope {
  all_ports?: boolean;
  port?: number;
  start_port?: number;
  end_port?: number;
}

export interface MicroVMProviderTokenInput {
  request_id: string;
  tenant_id: string;
  namespace: string;
  auth_context: MicroVMAuthContext;
  binding: MicroVMProviderSessionBinding;
  ttl_seconds?: number;
  allowed_port_scope?: MicroVMProviderPortScope[];
}

export interface MicroVMProviderSession {
  tenant_id: string;
  namespace: string;
  session_id: string;
  provider_microvm_id: string;
  state: MicroVMRealLifecycleState | string;
  provider_state: string;
  image_ref?: string;
  image_version?: string;
  started_at?: Date;
  terminated_at?: Date;
  registry_version?: number;
  terminal: boolean;
}

export interface MicroVMProviderListOutput {
  sessions: MicroVMProviderSession[];
  recovery_cursor?: string;
}

export interface MicroVMProviderToken {
  tenant_id: string;
  namespace: string;
  session_id: string;
  provider_microvm_id: string;
  token_id: string;
  token_type: string;
  expires_at: Date;
  scope: string[];
}

export interface MicroVMProviderCall {
  operation: MicroVMOperationName | string;
  request_id: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
}

export interface MicroVMProvider {
  run(input: MicroVMProviderRunInput): Promise<MicroVMProviderSession>;
  get(input: MicroVMProviderSessionInput): Promise<MicroVMProviderSession>;
  list(input: MicroVMProviderListInput): Promise<MicroVMProviderListOutput>;
  suspend(input: MicroVMProviderSessionInput): Promise<MicroVMProviderSession>;
  resume(input: MicroVMProviderSessionInput): Promise<MicroVMProviderSession>;
  terminate(
    input: MicroVMProviderSessionInput,
  ): Promise<MicroVMProviderSession>;
  createAuthToken(
    input: MicroVMProviderTokenInput,
  ): Promise<MicroVMProviderToken>;
  createShellToken(
    input: MicroVMProviderTokenInput,
  ): Promise<MicroVMProviderToken>;
}

export interface AWSLambdaMicroVMProviderOptions {
  region?: string;
  clock?: MicroVMClock;
}

export function defaultMicroVMRealLifecycleContract(): MicroVMLifecycleContract {
  return {
    hooks: [
      {
        name: MicroVMRealHook.Validate,
        phase: "validation",
        state: MicroVMRealState.Validating,
        success_state: MicroVMRealState.Validated,
        failure_state: MicroVMRealState.Failed,
      },
      {
        name: MicroVMRealHook.Run,
        phase: "provider_run",
        state: MicroVMRealState.Running,
        success_state: MicroVMRealState.Running,
        failure_state: MicroVMRealState.Failed,
      },
      {
        name: MicroVMRealHook.Ready,
        phase: "provider_ready",
        state: MicroVMRealState.Ready,
        success_state: MicroVMRealState.Ready,
        failure_state: MicroVMRealState.Failed,
      },
      {
        name: MicroVMRealHook.Suspend,
        phase: "provider_suspend",
        state: MicroVMRealState.Suspending,
        success_state: MicroVMRealState.Suspended,
        failure_state: MicroVMRealState.Failed,
      },
      {
        name: MicroVMRealHook.Resume,
        phase: "provider_resume",
        state: MicroVMRealState.Resuming,
        success_state: MicroVMRealState.Ready,
        failure_state: MicroVMRealState.Failed,
      },
      {
        name: MicroVMRealHook.Terminate,
        phase: "provider_terminate",
        state: MicroVMRealState.Terminating,
        success_state: MicroVMRealState.Terminated,
        failure_state: MicroVMRealState.Failed,
      },
      {
        name: MicroVMRealHook.Failure,
        phase: "failure",
        state: MicroVMRealState.Failed,
        success_state: MicroVMRealState.Failed,
        failure_state: MicroVMRealState.Failed,
      },
    ],
    states: requiredMicroVMRealLifecycleStates(),
    terminal_states: [MicroVMRealState.Terminated, MicroVMRealState.Failed],
    transitions: [
      {
        from: MicroVMRealState.Requested,
        hook: MicroVMRealHook.Validate,
        to: MicroVMRealState.Validating,
      },
      {
        from: MicroVMRealState.Validating,
        hook: MicroVMRealHook.Validate,
        to: MicroVMRealState.Validated,
      },
      {
        from: MicroVMRealState.Validated,
        hook: MicroVMRealHook.Run,
        to: MicroVMRealState.Running,
      },
      {
        from: MicroVMRealState.Running,
        hook: MicroVMRealHook.Run,
        to: MicroVMRealState.Running,
      },
      {
        from: MicroVMRealState.Running,
        hook: MicroVMRealHook.Ready,
        to: MicroVMRealState.Ready,
      },
      {
        from: MicroVMRealState.Ready,
        hook: MicroVMRealHook.Ready,
        to: MicroVMRealState.Ready,
      },
      {
        from: MicroVMRealState.Ready,
        hook: MicroVMRealHook.Suspend,
        to: MicroVMRealState.Suspending,
      },
      {
        from: MicroVMRealState.Suspending,
        hook: MicroVMRealHook.Suspend,
        to: MicroVMRealState.Suspended,
      },
      {
        from: MicroVMRealState.Suspended,
        hook: MicroVMRealHook.Resume,
        to: MicroVMRealState.Resuming,
      },
      {
        from: MicroVMRealState.Resuming,
        hook: MicroVMRealHook.Resume,
        to: MicroVMRealState.Ready,
      },
      {
        from: MicroVMRealState.Ready,
        hook: MicroVMRealHook.Terminate,
        to: MicroVMRealState.Terminating,
      },
      {
        from: MicroVMRealState.Suspended,
        hook: MicroVMRealHook.Terminate,
        to: MicroVMRealState.Terminating,
      },
      {
        from: MicroVMRealState.Terminating,
        hook: MicroVMRealHook.Terminate,
        to: MicroVMRealState.Terminated,
      },
      ...[
        MicroVMRealState.Validating,
        MicroVMRealState.Running,
        MicroVMRealState.Ready,
        MicroVMRealState.Suspending,
        MicroVMRealState.Suspended,
        MicroVMRealState.Resuming,
        MicroVMRealState.Terminating,
      ].map((state) => ({
        from: state,
        hook: MicroVMRealHook.Failure,
        to: MicroVMRealState.Failed,
      })),
    ],
  };
}

export function defaultMicroVMOperationContract(): MicroVMOperationContract {
  return {
    operations: requiredMicroVMOperations(),
    routes: requiredMicroVMOperations().map((operation) =>
      requiredMicroVMOperationRoute(operation),
    ),
    provider_state_mappings: defaultMicroVMProviderStateMappings(),
    token_issuance: [
      requiredMicroVMTokenIssuance(MicroVMOperation.AuthToken),
      requiredMicroVMTokenIssuance(MicroVMOperation.ShellToken),
    ],
    tenant_binding: [
      {
        operation: MicroVMOperation.List,
        request_tenant_id: "tenant-a",
        request_namespace: "namespace-a",
        record_tenant_id: "tenant-a",
        record_namespace: "namespace-a",
        recovery: true,
        allowed: true,
      },
      {
        operation: MicroVMOperation.List,
        request_tenant_id: "tenant-a",
        request_namespace: "namespace-a",
        record_tenant_id: "tenant-b",
        record_namespace: "namespace-a",
        recovery: true,
        allowed: false,
      },
      {
        operation: MicroVMOperation.Get,
        request_tenant_id: "tenant-a",
        request_namespace: "namespace-a",
        record_tenant_id: "tenant-b",
        record_namespace: "namespace-a",
        allowed: false,
      },
    ],
    forbidden_fields: requiredForbiddenMicroVMOperationFields(),
  };
}

export function defaultMicroVMProviderStateMappings(): MicroVMProviderStateMapping[] {
  return [
    {
      provider_state: "pending",
      state: MicroVMRealState.Validating,
      terminal: false,
    },
    {
      provider_state: "running",
      state: MicroVMRealState.Running,
      terminal: false,
    },
    { provider_state: "ready", state: MicroVMRealState.Ready, terminal: false },
    {
      provider_state: "suspending",
      state: MicroVMRealState.Suspending,
      terminal: false,
    },
    {
      provider_state: "suspended",
      state: MicroVMRealState.Suspended,
      terminal: false,
    },
    {
      provider_state: "resuming",
      state: MicroVMRealState.Resuming,
      terminal: false,
    },
    {
      provider_state: "terminating",
      state: MicroVMRealState.Terminating,
      terminal: false,
    },
    {
      provider_state: "terminated",
      state: MicroVMRealState.Terminated,
      terminal: true,
    },
    {
      provider_state: "failed",
      state: MicroVMRealState.Failed,
      terminal: true,
    },
  ];
}

export function requiredForbiddenMicroVMOperationFields(): string[] {
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
  ];
}

export function validateMicroVMRealLifecycleContract(
  contract: MicroVMLifecycleContract,
): void {
  const hookSpecs = validateMicroVMRealLifecycleHookSpecs(contract.hooks ?? []);
  validateMicroVMRealLifecycleStateLists(contract);
  validateMicroVMRealLifecycleTransitionSet(
    hookSpecs,
    microVMTransitionSet(contract.transitions ?? []),
  );
}

export function validateMicroVMOperationContract(
  contract: MicroVMOperationContract,
): void {
  validateMicroVMOperationVocabulary(contract.operations ?? []);
  validateMicroVMOperationRoutes(contract.routes ?? []);
  validateMicroVMProviderStateMappings(contract.provider_state_mappings ?? []);
  validateMicroVMTokenIssuanceContracts(contract.token_issuance ?? []);
  validateMicroVMTenantBindingRules(contract.tenant_binding ?? []);
  validateMicroVMForbiddenFieldCatalog(contract.forbidden_fields ?? []);
}

export function mapMicroVMProviderState(providerState: string): {
  state: MicroVMRealLifecycleState;
  terminal: boolean;
} {
  const normalized = normalizeMicroVMProviderState(providerState);
  if (!normalized) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
      "apptheory: microvm provider state is required",
      "",
    );
  }
  for (const mapping of defaultMicroVMProviderStateMappings()) {
    if (normalized === normalizeMicroVMProviderState(mapping.provider_state)) {
      return {
        state: normalizeMicroVMRealLifecycleState(
          mapping.state,
        ) as MicroVMRealLifecycleState,
        terminal: mapping.terminal === true,
      };
    }
  }
  throw safeError(
    MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
    "apptheory: microvm provider state is unsupported",
    "",
  );
}

export function validateMicroVMProviderSession(
  session: MicroVMProviderSession,
): void {
  const normalized = normalizeMicroVMProviderSession(session);
  if (
    !normalized.tenant_id ||
    !normalized.namespace ||
    !normalized.session_id ||
    !normalized.provider_microvm_id
  ) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider session is incomplete",
      "",
    );
  }
  const mapped = mapMicroVMProviderState(normalized.provider_state);
  if (
    normalized.state !== mapped.state ||
    normalized.terminal !== mapped.terminal
  ) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
      "apptheory: microvm provider session state mapping mismatch",
      "",
    );
  }
  if (
    forbiddenMicroVMFieldName(normalized.provider_microvm_id) ||
    forbiddenMicroVMFieldName(normalized.image_ref ?? "") ||
    forbiddenMicroVMFieldName(normalized.image_version ?? "")
  ) {
    throw safeError(
      MICROVM_ERROR_FORBIDDEN_FIELD,
      "apptheory: microvm provider session exposes forbidden field",
      "",
    );
  }
}

export function validateMicroVMProviderRunInput(
  input: MicroVMProviderRunInput,
): void {
  validateMicroVMProviderRunInputInternal(input);
}

export function validateMicroVMProviderSessionInput(
  operation: MicroVMOperationName | string,
  input: MicroVMProviderSessionInput,
): void {
  validateMicroVMProviderSessionInputInternal(operation, input);
}

export function validateMicroVMProviderListInput(
  input: MicroVMProviderListInput,
): void {
  validateMicroVMProviderListInputInternal(input);
}

export function validateMicroVMProviderTokenInput(
  operation: MicroVMOperationName | string,
  input: MicroVMProviderTokenInput,
): void {
  validateMicroVMProviderTokenInputInternal(operation, input);
}

export function validateMicroVMProviderToken(
  token: MicroVMProviderToken,
): void {
  const normalized = normalizeMicroVMProviderToken(token);
  if (
    !normalized.tenant_id ||
    !normalized.namespace ||
    !normalized.session_id ||
    !normalized.provider_microvm_id ||
    !normalized.token_id ||
    !normalized.token_type ||
    !validDate(normalized.expires_at) ||
    normalized.scope.length === 0
  ) {
    throw safeError(
      MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
      "apptheory: microvm provider token metadata is incomplete",
      "",
    );
  }
  for (const field of [
    normalized.provider_microvm_id,
    normalized.token_id,
    normalized.token_type,
    ...normalized.scope,
  ]) {
    if (forbiddenMicroVMFieldName(field)) {
      throw safeError(
        MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
        "apptheory: microvm provider token metadata exposes forbidden field",
        "",
      );
    }
  }
}

function validateMicroVMRealLifecycleHookSpecs(
  hooks: MicroVMLifecycleHookSpec[],
): Map<MicroVMRealLifecycleHook, MicroVMLifecycleHookSpec> {
  const hookSpecs = new Map<
    MicroVMRealLifecycleHook,
    MicroVMLifecycleHookSpec
  >();
  for (const rawHook of hooks) {
    const rawName = String(rawHook.name ?? "").trim();
    const name = normalizeMicroVMRealLifecycleHook(rawName);
    if (
      rawName === MicroVMHook.Start ||
      rawName === MicroVMHook.Stop ||
      rawName === MicroVMHook.PrepareImage ||
      rawName === MicroVMHook.Teardown
    ) {
      throw safeError(
        MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
        "apptheory: microvm real lifecycle forbids synthetic lifecycle hooks",
        "",
      );
    }
    const hook = {
      name,
      phase: String(rawHook.phase ?? "").trim(),
      state: normalizeMicroVMRealLifecycleState(rawHook.state),
      success_state: normalizeMicroVMRealLifecycleState(rawHook.success_state),
      failure_state: normalizeMicroVMRealLifecycleState(rawHook.failure_state),
    };
    if (
      !hook.name ||
      !hook.phase ||
      !hook.state ||
      !hook.success_state ||
      !hook.failure_state
    ) {
      throw safeError(
        MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
        "apptheory: microvm real lifecycle hooks must name phase, active state, success state, and failure state",
        "",
      );
    }
    hookSpecs.set(hook.name, hook);
  }
  const missing = missingStrings(requiredMicroVMRealLifecycleHooks(), [
    ...hookSpecs.keys(),
  ]);
  if (missing.length > 0) {
    throw safeError(
      MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
      `apptheory: microvm real lifecycle missing hooks: ${missing.join(",")}`,
      "",
    );
  }
  return hookSpecs;
}

function validateMicroVMRealLifecycleStateLists(
  contract: MicroVMLifecycleContract,
): void {
  const states = new Set(
    (contract.states ?? [])
      .map(normalizeMicroVMRealLifecycleState)
      .filter(Boolean),
  );
  const missingStates = missingStrings(requiredMicroVMRealLifecycleStates(), [
    ...states,
  ]);
  if (missingStates.length > 0) {
    throw safeError(
      MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
      `apptheory: microvm real lifecycle missing states: ${missingStates.join(",")}`,
      "",
    );
  }
  const terminalStates = new Set(
    (contract.terminal_states ?? [])
      .map(normalizeMicroVMRealLifecycleState)
      .filter(Boolean),
  );
  const missingTerminal = missingStrings(
    [MicroVMRealState.Terminated, MicroVMRealState.Failed],
    [...terminalStates],
  );
  if (missingTerminal.length > 0) {
    throw safeError(
      MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
      `apptheory: microvm real lifecycle missing terminal states: ${missingTerminal.join(",")}`,
      "",
    );
  }
}

function validateMicroVMRealLifecycleTransitionSet(
  hookSpecs: Map<MicroVMRealLifecycleHook, MicroVMLifecycleHookSpec>,
  transitions: MicroVMTransitionSet,
): void {
  for (const spec of hookSpecs.values()) {
    const name = normalizeMicroVMRealLifecycleHook(spec.name);
    if (!name || name === MicroVMRealHook.Failure) continue;
    for (const required of requiredMicroVMRealTransitionsForHook(
      name,
      spec.state,
      spec.success_state,
    )) {
      if (!transitions.has(required.from, required.hook, required.to)) {
        throw safeError(
          MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
          `apptheory: microvm real lifecycle missing transition ${required.from}/${required.hook}/${required.to}`,
          "",
        );
      }
    }
  }
  for (const state of [
    MicroVMRealState.Validating,
    MicroVMRealState.Running,
    MicroVMRealState.Ready,
    MicroVMRealState.Suspending,
    MicroVMRealState.Suspended,
    MicroVMRealState.Resuming,
    MicroVMRealState.Terminating,
  ]) {
    if (
      !transitions.has(state, MicroVMRealHook.Failure, MicroVMRealState.Failed)
    ) {
      throw safeError(
        MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
        `apptheory: microvm real lifecycle missing failure transition from ${state}`,
        "",
      );
    }
  }
}

function requiredMicroVMRealTransitionsForHook(
  hook: MicroVMRealLifecycleHook,
  active: MicroVMLifecycleState | string,
  success: MicroVMLifecycleState | string,
): MicroVMLifecycleTransition[] {
  switch (hook) {
    case MicroVMRealHook.Validate:
      return [
        { from: MicroVMRealState.Requested, hook, to: active },
        { from: active, hook, to: success },
      ];
    case MicroVMRealHook.Run:
      return [
        { from: MicroVMRealState.Validated, hook, to: active },
        { from: active, hook, to: success },
      ];
    case MicroVMRealHook.Ready:
      return [
        { from: MicroVMRealState.Running, hook, to: active },
        { from: active, hook, to: success },
      ];
    case MicroVMRealHook.Suspend:
      return [
        { from: MicroVMRealState.Ready, hook, to: active },
        { from: active, hook, to: success },
      ];
    case MicroVMRealHook.Resume:
      return [
        { from: MicroVMRealState.Suspended, hook, to: active },
        { from: active, hook, to: success },
      ];
    case MicroVMRealHook.Terminate:
      return [
        { from: MicroVMRealState.Ready, hook, to: active },
        { from: MicroVMRealState.Suspended, hook, to: active },
        { from: active, hook, to: success },
      ];
    default:
      return [];
  }
}

function validateMicroVMOperationVocabulary(
  operations: Array<MicroVMOperationName | string>,
): void {
  const seen = new Set(
    operations.map(normalizeMicroVMOperation).filter(Boolean),
  );
  const missing = missingStrings(requiredMicroVMOperations(), [...seen]);
  if (missing.length > 0) {
    throw safeError(
      MICROVM_ERROR_OPERATION_CONTRACT_INCOMPLETE,
      `apptheory: microvm operation contract missing operations: ${missing.join(",")}`,
      "",
    );
  }
  for (const operation of seen) {
    if (!isRequiredMicroVMOperation(operation)) {
      throw safeError(
        MICROVM_ERROR_OPERATION_CONTRACT_INCOMPLETE,
        `apptheory: microvm operation contract includes unsupported operation: ${operation}`,
        "",
      );
    }
  }
}

function validateMicroVMOperationRoutes(
  routes: MicroVMOperationHTTPRouteContract[],
): void {
  const seen = new Map<
    MicroVMOperationName,
    MicroVMOperationHTTPRouteContract
  >();
  for (const route of routes) {
    const operation = normalizeMicroVMOperation(route.operation);
    if (
      !operation ||
      !String(route.method ?? "").trim() ||
      !String(route.path ?? "").trim()
    ) {
      throw safeError(
        MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE,
        "apptheory: microvm operation routes must define operation, method, and path",
        "",
      );
    }
    if (
      route.auth_required !== true ||
      String(route.default_auth ?? "")
        .trim()
        .toLowerCase() !== MICROVM_CONTROLLER_AUTH_DEFAULT_DENY
    ) {
      throw safeError(
        MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
        "apptheory: microvm operation routes must default to authenticated deny",
        "",
      );
    }
    if (route.tenant_bound !== true) {
      throw safeError(
        MICROVM_ERROR_TENANT_BINDING_VIOLATION,
        "apptheory: microvm operation route is not tenant-bound",
        "",
      );
    }
    validateSafeMicroVMResultFields(route.response_fields ?? []);
    seen.set(operation, route);
  }
  for (const operation of requiredMicroVMOperations()) {
    const route = seen.get(operation);
    if (!route) {
      throw safeError(
        MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE,
        `apptheory: microvm operation contract missing route: ${operation}`,
        "",
      );
    }
    const expected = requiredMicroVMOperationRoute(operation);
    if (
      String(route.method ?? "")
        .trim()
        .toUpperCase() !== expected.method ||
      String(route.path ?? "").trim() !== expected.path
    ) {
      throw safeError(
        MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE,
        `apptheory: microvm operation route mismatch: ${operation}`,
        "",
      );
    }
    if (
      missingStrings(expected.request_fields, route.request_fields ?? [])
        .length > 0 ||
      missingStrings(expected.response_fields, route.response_fields ?? [])
        .length > 0
    ) {
      throw safeError(
        MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE,
        `apptheory: microvm operation route fields incomplete: ${operation}`,
        "",
      );
    }
  }
  if (seen.get(MicroVMOperation.List)?.recovery !== true) {
    throw safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm list route must encode tenant-bound recovery semantics",
      "",
    );
  }
}

function validateMicroVMProviderStateMappings(
  mappings: MicroVMProviderStateMapping[],
): void {
  const seen = new Map<string, MicroVMProviderStateMapping>();
  for (const mapping of mappings) {
    const providerState = normalizeMicroVMProviderState(mapping.provider_state);
    const state = normalizeMicroVMRealLifecycleState(mapping.state);
    if (!providerState || !state) {
      throw safeError(
        MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
        "apptheory: microvm provider state mapping is incomplete",
        "",
      );
    }
    if (!validMicroVMRealLifecycleState(state)) {
      throw safeError(
        MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
        "apptheory: microvm provider state maps to unsupported lifecycle state",
        "",
      );
    }
    seen.set(providerState, {
      ...mapping,
      provider_state: providerState,
      state,
    });
  }
  for (const required of defaultMicroVMProviderStateMappings()) {
    const got = seen.get(required.provider_state);
    if (!got) {
      throw safeError(
        MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
        `apptheory: microvm provider state mapping missing: ${required.provider_state}`,
        "",
      );
    }
    if (got.state !== required.state || got.terminal !== required.terminal) {
      throw safeError(
        MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
        `apptheory: microvm provider state mapping mismatch: ${required.provider_state}`,
        "",
      );
    }
  }
}

function validateMicroVMTokenIssuanceContracts(
  tokens: MicroVMTokenIssuanceContract[],
): void {
  const seen = new Map<MicroVMOperationName, MicroVMTokenIssuanceContract>();
  for (const token of tokens) {
    const operation = normalizeMicroVMOperation(token.operation);
    if (
      operation === MicroVMOperation.AuthToken ||
      operation === MicroVMOperation.ShellToken
    ) {
      seen.set(operation, token);
    }
  }
  for (const operation of [
    MicroVMOperation.AuthToken,
    MicroVMOperation.ShellToken,
  ]) {
    const token = seen.get(operation);
    if (!token) {
      throw safeError(
        MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
        `apptheory: microvm token issuance missing operation: ${operation}`,
        "",
      );
    }
    if (
      token.sanitized !== true ||
      token.tenant_bound !== true ||
      token.session_bound !== true ||
      Math.trunc(Number(token.max_ttl_seconds) || 0) <= 0
    ) {
      throw safeError(
        MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
        "apptheory: microvm token issuance must be sanitized, tenant-bound, session-bound, and ttl-limited",
        "",
      );
    }
    try {
      validateSafeMicroVMResultFields(token.result_fields ?? []);
    } catch {
      throw safeError(
        MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
        "apptheory: microvm token issuance exposes unsafe result field",
        "",
      );
    }
    const missingResult = missingStrings(
      ["token_id", "token_type", "expires_at", "scope"],
      token.result_fields ?? [],
    );
    if (missingResult.length > 0) {
      throw safeError(
        MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
        `apptheory: microvm token issuance missing safe result fields: ${missingResult.join(",")}`,
        "",
      );
    }
    const missingForbidden = missingStrings(
      requiredForbiddenMicroVMOperationFields(),
      token.forbidden_fields ?? [],
    );
    if (missingForbidden.length > 0) {
      throw safeError(
        MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
        `apptheory: microvm token issuance missing forbidden fields: ${missingForbidden.join(",")}`,
        "",
      );
    }
  }
}

function validateMicroVMTenantBindingRules(
  rules: MicroVMTenantBindingRule[],
): void {
  if (rules.length === 0) {
    throw safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm tenant binding rules are required",
      "",
    );
  }
  let hasListRecoveryDeny = false;
  let hasGetDeny = false;
  for (const rule of rules) {
    const operation = normalizeMicroVMOperation(rule.operation);
    const requestTenant = String(rule.request_tenant_id ?? "").trim();
    const requestNamespace = String(rule.request_namespace ?? "").trim();
    const recordTenant = String(rule.record_tenant_id ?? "").trim();
    const recordNamespace = String(rule.record_namespace ?? "").trim();
    if (
      !operation ||
      !requestTenant ||
      !requestNamespace ||
      !recordTenant ||
      !recordNamespace
    ) {
      throw safeError(
        MICROVM_ERROR_TENANT_BINDING_VIOLATION,
        "apptheory: microvm tenant binding rule is incomplete",
        "",
      );
    }
    const sameBinding =
      requestTenant === recordTenant && requestNamespace === recordNamespace;
    if (rule.allowed !== sameBinding) {
      throw safeError(
        MICROVM_ERROR_TENANT_BINDING_VIOLATION,
        "apptheory: microvm tenant binding rule allows cross-tenant access",
        "",
      );
    }
    if (
      rule.allowed !== true &&
      operation === MicroVMOperation.List &&
      rule.recovery === true
    ) {
      hasListRecoveryDeny = true;
    }
    if (rule.allowed !== true && operation === MicroVMOperation.Get) {
      hasGetDeny = true;
    }
  }
  if (!hasListRecoveryDeny || !hasGetDeny) {
    throw safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm tenant binding must deny cross-tenant list/recovery and get",
      "",
    );
  }
}

function validateMicroVMForbiddenFieldCatalog(fields: string[]): void {
  const missing = missingStrings(
    requiredForbiddenMicroVMOperationFields(),
    fields,
  );
  if (missing.length > 0) {
    throw safeError(
      MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
      `apptheory: microvm forbidden field catalog missing fields: ${missing.join(",")}`,
      "",
    );
  }
}

function validateSafeMicroVMResultFields(fields: string[]): void {
  for (const field of fields) {
    if (forbiddenMicroVMFieldName(field)) {
      throw safeError(
        MICROVM_ERROR_FORBIDDEN_FIELD,
        "apptheory: microvm contract exposes forbidden field",
        "",
      );
    }
  }
}

function requiredMicroVMOperations(): MicroVMOperationName[] {
  return [
    MicroVMOperation.Run,
    MicroVMOperation.Get,
    MicroVMOperation.List,
    MicroVMOperation.Suspend,
    MicroVMOperation.Resume,
    MicroVMOperation.Terminate,
    MicroVMOperation.AuthToken,
    MicroVMOperation.ShellToken,
  ];
}

function requiredMicroVMRealLifecycleHooks(): MicroVMRealLifecycleHook[] {
  return [
    MicroVMRealHook.Validate,
    MicroVMRealHook.Run,
    MicroVMRealHook.Ready,
    MicroVMRealHook.Suspend,
    MicroVMRealHook.Resume,
    MicroVMRealHook.Terminate,
    MicroVMRealHook.Failure,
  ];
}

function requiredMicroVMRealLifecycleStates(): MicroVMRealLifecycleState[] {
  return [
    MicroVMRealState.Requested,
    MicroVMRealState.Validating,
    MicroVMRealState.Validated,
    MicroVMRealState.Running,
    MicroVMRealState.Ready,
    MicroVMRealState.Suspending,
    MicroVMRealState.Suspended,
    MicroVMRealState.Resuming,
    MicroVMRealState.Terminating,
    MicroVMRealState.Terminated,
    MicroVMRealState.Failed,
  ];
}

function validMicroVMRealLifecycleState(state: string): boolean {
  return requiredMicroVMRealLifecycleStates().includes(
    normalizeMicroVMRealLifecycleState(state) as MicroVMRealLifecycleState,
  );
}

function normalizeMicroVMOperation(
  operation: MicroVMOperationName | string,
): MicroVMOperationName | "" {
  const normalized = String(operation ?? "").trim();
  if (normalized === "shell-token") return MicroVMOperation.ShellAuthToken;
  return normalized as MicroVMOperationName | "";
}

function normalizeMicroVMRealLifecycleHook(
  hook: MicroVMLifecycleHook | string,
): MicroVMRealLifecycleHook | "" {
  return String(hook ?? "").trim() as MicroVMRealLifecycleHook | "";
}

function normalizeMicroVMRealLifecycleState(
  state: MicroVMLifecycleState | string,
): MicroVMRealLifecycleState | "" {
  return String(state ?? "").trim() as MicroVMRealLifecycleState | "";
}

function normalizeMicroVMProviderState(state: string): string {
  return String(state ?? "")
    .trim()
    .toLowerCase();
}

function isRequiredMicroVMOperation(operation: string): boolean {
  return requiredMicroVMOperations().includes(
    normalizeMicroVMOperation(operation) as MicroVMOperationName,
  );
}

function requiredMicroVMOperationRoute(
  operation: MicroVMOperationName,
): MicroVMOperationHTTPRouteContract {
  switch (operation) {
    case MicroVMOperation.Run:
      return microVMOperationRoute(
        operation,
        "POST",
        "/microvms",
        [
          "tenant_id",
          "namespace",
          "image_ref",
          "network_connector_ref",
          "session_spec",
        ],
        [
          "session_id",
          "provider_microvm_id",
          "state",
          "provider_state",
          "registry_version",
        ],
        false,
      );
    case MicroVMOperation.List:
      return microVMOperationRoute(
        operation,
        "GET",
        "/microvms",
        ["tenant_id", "namespace"],
        ["sessions", "recovery_cursor"],
        true,
      );
    case MicroVMOperation.Get:
      return microVMOperationRoute(
        operation,
        "GET",
        "/microvms/{session_id}",
        ["tenant_id", "namespace", "session_id"],
        [
          "session_id",
          "provider_microvm_id",
          "state",
          "provider_state",
          "registry_version",
        ],
        false,
      );
    case MicroVMOperation.Suspend:
      return microVMOperationRoute(
        operation,
        "POST",
        "/microvms/{session_id}/suspend",
        ["tenant_id", "namespace", "session_id"],
        ["session_id", "state", "provider_state", "registry_version"],
        false,
      );
    case MicroVMOperation.Resume:
      return microVMOperationRoute(
        operation,
        "POST",
        "/microvms/{session_id}/resume",
        ["tenant_id", "namespace", "session_id"],
        ["session_id", "state", "provider_state", "registry_version"],
        false,
      );
    case MicroVMOperation.Terminate:
      return microVMOperationRoute(
        operation,
        "DELETE",
        "/microvms/{session_id}",
        ["tenant_id", "namespace", "session_id"],
        ["session_id", "state", "provider_state", "registry_version"],
        false,
      );
    case MicroVMOperation.AuthToken:
      return microVMOperationRoute(
        operation,
        "POST",
        "/microvms/{session_id}/auth-token",
        ["tenant_id", "namespace", "session_id"],
        ["token_id", "token_type", "expires_at", "scope"],
        false,
      );
    case MicroVMOperation.ShellToken:
      return microVMOperationRoute(
        operation,
        "POST",
        "/microvms/{session_id}/shell-auth-token",
        ["tenant_id", "namespace", "session_id"],
        ["token_id", "token_type", "expires_at", "scope"],
        false,
      );
  }
}

function microVMOperationRoute(
  operation: MicroVMOperationName,
  method: string,
  path: string,
  requestFields: string[],
  responseFields: string[],
  recovery: boolean,
): MicroVMOperationHTTPRouteContract {
  return {
    operation,
    method,
    path,
    auth_required: true,
    default_auth: MICROVM_CONTROLLER_AUTH_DEFAULT_DENY,
    tenant_bound: true,
    recovery,
    request_fields: requestFields,
    response_fields: responseFields,
    forbidden_fields: requiredForbiddenMicroVMOperationFields(),
  };
}

function requiredMicroVMTokenIssuance(
  operation: MicroVMOperationName,
): MicroVMTokenIssuanceContract {
  return {
    operation,
    result_fields: ["token_id", "token_type", "expires_at", "scope"],
    forbidden_fields: requiredForbiddenMicroVMOperationFields(),
    sanitized: true,
    tenant_bound: true,
    session_bound: true,
    max_ttl_seconds: 900,
  };
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

function validateMicroVMLifecycleAdapterContract(
  contract: MicroVMLifecycleContract,
): void {
  if (isMicroVMRealLifecycleContractShape(contract)) {
    validateMicroVMRealLifecycleContract(contract);
    return;
  }
  validateMicroVMLifecycleContract(contract);
}

function isMicroVMRealLifecycleContractShape(
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

function microVMRealLifecycleOnlyHook(
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

function microVMRealLifecycleOnlyState(
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

function lifecycleContractValidationError(
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
  if (metadata) out["metadata"] = metadata;
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
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (forbiddenMicroVMFieldName(key)) {
      return safeError(
        MICROVM_ERROR_FORBIDDEN_FIELD,
        "apptheory: microvm metadata contains forbidden field",
        requestID,
      );
    }
    if (forbiddenMicroVMFieldValue(value)) {
      return safeError(
        MICROVM_ERROR_FORBIDDEN_FIELD,
        "apptheory: microvm metadata contains forbidden value",
        requestID,
      );
    }
  }
  return null;
}

function validateSafeMicroVMFieldValue(
  value: string,
  requestID: string,
): MicroVMSafeError | null {
  if (forbiddenMicroVMFieldName(value) || forbiddenMicroVMFieldValue(value)) {
    return safeError(
      MICROVM_ERROR_FORBIDDEN_FIELD,
      "apptheory: microvm field contains forbidden value",
      requestID,
    );
  }
  return null;
}

function forbiddenMicroVMFieldValue(value: string): boolean {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return (
    normalized.startsWith("bearer ") ||
    normalized.includes("x-aws-proxy-auth") ||
    normalized.includes("aws_secret_access_key") ||
    normalized.includes("aws_access_key_id") ||
    normalized.includes("aws_session_token") ||
    normalized.includes("raw provider exception") ||
    normalized.includes("raw_provider_exception") ||
    normalized.includes("raw provider error") ||
    normalized.includes("account-wide list token") ||
    normalized.includes("account_wide_list_token")
  );
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
export const MICROVM_SESSION_REGISTRY_MODEL_NAME =
  "MicroVMSessionRegistryRecord";
export const MICROVM_SESSION_REGISTRY_TABLE_NAME = "apptheory-microvm-sessions";
export const MICROVM_SESSION_REGISTRY_TABLE_ENV =
  "APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE";
export const MICROVM_DEFAULT_SESSION_PROVIDER_ID = "apptheory.microvm.registry";
export const MICROVM_AWS_LAMBDA_PROVIDER_ID = "aws.lambda.microvm";

export type MicroVMContractKind = "lifecycle" | "controller_session";

export const MicroVMCommand = {
  Create: "create",
  Start: "start",
  Stop: "stop",
  Status: "status",
  Session: "session",
  Run: "run",
  Get: "get",
  List: "list",
  Suspend: "suspend",
  Resume: "resume",
  Terminate: "terminate",
  AuthToken: "auth-token",
  ShellAuthToken: "shell-auth-token",
  ShellToken: "shell-auth-token",
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
  image_version?: string;
  network_connector_ref?: string;
  ingress_network_connector_refs?: string[];
  egress_network_connector_refs?: string[];
  session_spec?: MicroVMSessionSpec;
  idle_policy?: MicroVMProviderIdlePolicy;
  maximum_duration_seconds?: number;
  ttl_seconds?: number;
  allowed_port_scope?: MicroVMProviderPortScope[];
  max_results?: number;
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
  endpoint?: string;
  microvm_id?: string;
  provider_microvm_id?: string;
  provider_state?: string;
  last_action?: MicroVMCommandName | string;
  last_transition?: Date;
  registry_version?: number;
  sessions?: MicroVMProviderSession[];
  recovery_cursor?: string;
  token_id?: string;
  token_type?: string;
  expires_at?: Date;
  scope?: string[];
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

export interface MicroVMSessionTokenMetadata {
  token_id: string;
  token_type: string;
  expires_at: Date;
  scope: string[];
}

export interface MicroVMSessionRecord {
  tenant_id: string;
  namespace: string;
  session_id: string;
  state: MicroVMLifecycleState | string;
  desired_state: MicroVMLifecycleState | string;
  endpoint?: string;
  microvm_id?: string;
  provider_id: string;
  provider_microvm_id?: string;
  provider_state: string;
  aws_lifecycle_state: string;
  image_ref: string;
  image_version?: string;
  network_connector_ref: string;
  ingress_network_connector_refs?: string[];
  egress_network_connector_refs?: string[];
  controller_id: string;
  created_at: Date;
  updated_at: Date;
  last_observed_at: Date;
  provider_started_at?: Date;
  provider_terminated_at?: Date;
  expires_at: Date;
  generation: number;
  last_action: MicroVMCommandName | string;
  last_command_id: string;
  auth_subject: string;
  reason_metadata?: Record<string, string>;
  status_metadata?: Record<string, string>;
  token_metadata?: MicroVMSessionTokenMetadata[];
  metadata?: Record<string, string>;
}

export interface MicroVMSessionStatus {
  tenant_id: string;
  namespace: string;
  session_id: string;
  state: MicroVMLifecycleState | string;
  desired_state: MicroVMLifecycleState | string;
  lifecycle_state: MicroVMLifecycleState | string;
  endpoint?: string;
  microvm_id?: string;
  last_action: MicroVMCommandName | string;
  last_transition: Date;
  registry_version: number;
}

export interface MicroVMSessionRegistryRecord {
  pk: string;
  sk: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  state: MicroVMLifecycleState | string;
  desired_state: MicroVMLifecycleState | string;
  endpoint: string;
  microvm_id: string;
  provider_id: string;
  provider_microvm_id: string;
  provider_state: string;
  aws_lifecycle_state: string;
  image_ref: string;
  image_version: string;
  network_connector_ref: string;
  ingress_network_connector_refs: string[];
  egress_network_connector_refs: string[];
  controller_id: string;
  created_at: Date;
  updated_at: Date;
  last_observed_at: Date;
  provider_started_at: Date;
  provider_terminated_at: Date;
  expires_at: Date;
  ttl: number;
  generation: number;
  version: number;
  last_action: MicroVMCommandName | string;
  last_command_id: string;
  auth_subject: string;
  reason_metadata?: Record<string, string>;
  status_metadata?: Record<string, string>;
  token_metadata?: MicroVMSessionTokenMetadata[];
  metadata?: Record<string, string>;
}

export interface MicroVMSessionRegistry {
  put: (record: MicroVMSessionRecord) => Promise<MicroVMSessionRecord>;
  get: (key: MicroVMSessionKey) => Promise<MicroVMSessionRecord>;
  delete: (key: MicroVMSessionKey) => Promise<void>;
  list?: (input: MicroVMSessionListInput) => Promise<MicroVMSessionRecord[]>;
}

export interface MicroVMSessionListInput {
  request_id?: string;
  tenant_id: string;
  namespace: string;
  auth_subject?: string;
}

export interface MicroVMSessionReconstructionRequest {
  request_id?: string;
  tenant_id: string;
  namespace: string;
  session_id: string;
  auth_subject?: string;
  now?: Date;
  existing?: MicroVMSessionRecord;
}

export type MicroVMSessionReconstructionHook = (
  request: MicroVMSessionReconstructionRequest,
) => Promise<MicroVMSessionRecord> | MicroVMSessionRecord;

export interface ReconstructingMicroVMSessionRegistryOptions {
  stale_after_ms?: number;
  clock?: MicroVMClock;
}

export interface MicroVMTableTheoryClient {
  register?: (...models: Model[]) => unknown;
  save: (modelName: string, item: Record<string, unknown>) => Promise<void>;
  get: (
    modelName: string,
    key: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  delete: (modelName: string, key: Record<string, unknown>) => Promise<void>;
  list?: (
    modelName: string,
    key: Record<string, unknown>,
  ) => Promise<Array<Record<string, unknown>>>;
}

export interface TableTheoryMicroVMSessionRegistryOptions {
  model_name?: string;
  table_name?: string;
  auto_register?: boolean;
}

export interface MicroVMRegistryClientOptions {
  ttl_ms?: number;
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
  ttl_ms?: number;
  provider_id?: string;
  execution_role_arn?: string;
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
        response_fields: [
          "session_id",
          "state",
          "registry_version",
          "endpoint",
          "microvm_id",
          "last_action",
        ],
      },
      {
        name: MicroVMCommand.Start,
        method: "POST",
        path: "/microvms/{session_id}/start",
        request_fields: ["session_id"],
        response_fields: [
          "session_id",
          "state",
          "desired_state",
          "endpoint",
          "microvm_id",
          "last_action",
        ],
      },
      {
        name: MicroVMCommand.Stop,
        method: "POST",
        path: "/microvms/{session_id}/stop",
        request_fields: ["session_id"],
        response_fields: [
          "session_id",
          "state",
          "desired_state",
          "endpoint",
          "microvm_id",
          "last_action",
        ],
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
          "endpoint",
          "microvm_id",
          "last_action",
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
          "endpoint",
          "microvm_id",
          "last_action",
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
    state_values: requiredMicroVMLifecycleStates(),
    forbidden_fields: [
      "raw_aws_credentials",
      "raw_lifecycle_hook_payload",
      "bearer_token",
      "session_token_plaintext",
      "x-aws-proxy-auth",
      "raw_provider_exception",
      "account_wide_list_token",
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
    requiredMicroVMSessionRegistryContractFields(),
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
    !normalized.provider_id ||
    !normalized.provider_state ||
    !normalized.aws_lifecycle_state ||
    !normalized.image_ref ||
    !normalized.network_connector_ref ||
    !normalized.controller_id ||
    !normalized.last_action ||
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
    !validDate(normalized.last_observed_at) ||
    !validDate(normalized.expires_at) ||
    normalized.generation <= 0
  ) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm session record registry fields are incomplete",
      normalized.last_command_id,
    );
  }
  if (!validMicroVMCommand(normalized.last_action)) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm session record last action is unsupported",
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
  const providerErr = validateMicroVMSessionProviderFields(normalized);
  if (providerErr) throw providerErr;
  const metadataErr = validateSafeMicroVMMetadata(
    normalized.metadata,
    normalized.last_command_id,
  );
  if (metadataErr) throw metadataErr;
  const reasonErr = validateSafeMicroVMMetadata(
    normalized.reason_metadata,
    normalized.last_command_id,
  );
  if (reasonErr) throw reasonErr;
  const statusErr = validateSafeMicroVMMetadata(
    normalized.status_metadata,
    normalized.last_command_id,
  );
  if (statusErr) throw statusErr;
}

function validateMicroVMSessionProviderFields(
  record: MicroVMSessionRecord,
): MicroVMSafeError | null {
  const fields = [
    record.endpoint ?? "",
    record.microvm_id ?? "",
    record.provider_id,
    record.provider_microvm_id ?? "",
    record.provider_state,
    record.aws_lifecycle_state,
    record.image_ref,
    record.image_version ?? "",
    record.network_connector_ref,
    ...(record.ingress_network_connector_refs ?? []),
    ...(record.egress_network_connector_refs ?? []),
  ];
  for (const field of fields) {
    const err = validateSafeMicroVMFieldValue(field, record.last_command_id);
    if (err) return err;
  }
  for (const token of record.token_metadata ?? []) {
    try {
      validateMicroVMSessionTokenMetadata(token, record.last_command_id);
    } catch (err) {
      if (err instanceof MicroVMSafeError) return err;
      return safeError(
        MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
        "apptheory: microvm session token metadata is incomplete",
        record.last_command_id,
      );
    }
  }
  return null;
}

export function validateMicroVMSessionTokenMetadata(
  token: MicroVMSessionTokenMetadata,
  requestID = "",
): void {
  const normalized = normalizeMicroVMSessionTokenMetadata(token);
  if (
    !normalized.token_id ||
    !normalized.token_type ||
    !validDate(normalized.expires_at) ||
    normalized.scope.length === 0
  ) {
    throw safeError(
      MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
      "apptheory: microvm session token metadata is incomplete",
      requestID,
    );
  }
  for (const field of [
    normalized.token_id,
    normalized.token_type,
    ...normalized.scope,
  ]) {
    const err = validateSafeMicroVMFieldValue(field, requestID);
    if (err) throw err;
  }
}

export function microVMSessionTokenMetadataFromProviderToken(
  token: MicroVMProviderToken,
): MicroVMSessionTokenMetadata {
  const normalized = normalizeMicroVMProviderToken(token);
  validateMicroVMProviderToken(normalized);
  const metadata: MicroVMSessionTokenMetadata = {
    token_id: normalized.token_id,
    token_type: normalized.token_type,
    expires_at: cloneMicroVMDate(normalized.expires_at),
    scope: [...normalized.scope],
  };
  validateMicroVMSessionTokenMetadata(metadata);
  return metadata;
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
    !normalized.last_action ||
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
  if (!validMicroVMCommand(normalized.last_action)) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm session status last action is unsupported",
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

export function microVMSessionRegistryTableName(): string {
  return (
    String(process.env[MICROVM_SESSION_REGISTRY_TABLE_ENV] ?? "").trim() ||
    MICROVM_SESSION_REGISTRY_TABLE_NAME
  );
}

export function microVMSessionRegistryPartitionKey(
  tenantID: string,
  namespace: string,
): string {
  const tenant = String(tenantID ?? "").trim();
  const ns = String(namespace ?? "").trim();
  return tenant && ns ? `TENANT#${tenant}#NAMESPACE#${ns}` : "";
}

export function microVMSessionRegistrySortKey(sessionID: string): string {
  const session = String(sessionID ?? "").trim();
  return session ? `SESSION#${session}` : "";
}

export function microVMSessionRegistryModel(
  tableName = microVMSessionRegistryTableName(),
): Model {
  return defineModel({
    name: MICROVM_SESSION_REGISTRY_MODEL_NAME,
    table: { name: tableName },
    keys: {
      partition: { attribute: "pk", type: "S" },
      sort: { attribute: "sk", type: "S" },
    },
    attributes: [
      { attribute: "pk", type: "S", roles: ["pk"] },
      { attribute: "sk", type: "S", roles: ["sk"] },
      { attribute: "tenant_id", type: "S", required: true },
      { attribute: "namespace", type: "S", required: true },
      { attribute: "session_id", type: "S", required: true },
      { attribute: "state", type: "S", required: true },
      { attribute: "desired_state", type: "S", required: true },
      { attribute: "endpoint", type: "S", optional: true, omit_empty: true },
      { attribute: "microvm_id", type: "S", optional: true, omit_empty: true },
      { attribute: "provider_id", type: "S", required: true },
      {
        attribute: "provider_microvm_id",
        type: "S",
        optional: true,
        omit_empty: true,
      },
      { attribute: "provider_state", type: "S", required: true },
      { attribute: "aws_lifecycle_state", type: "S", required: true },
      { attribute: "image_ref", type: "S", required: true },
      {
        attribute: "image_version",
        type: "S",
        optional: true,
        omit_empty: true,
      },
      { attribute: "network_connector_ref", type: "S", required: true },
      {
        attribute: "ingress_network_connector_refs",
        type: "L",
        optional: true,
        omit_empty: true,
      },
      {
        attribute: "egress_network_connector_refs",
        type: "L",
        optional: true,
        omit_empty: true,
      },
      { attribute: "controller_id", type: "S", required: true },
      { attribute: "created_at", type: "S", required: true },
      { attribute: "updated_at", type: "S", required: true },
      { attribute: "last_observed_at", type: "S", required: true },
      {
        attribute: "provider_started_at",
        type: "S",
        optional: true,
        omit_empty: true,
      },
      {
        attribute: "provider_terminated_at",
        type: "S",
        optional: true,
        omit_empty: true,
      },
      { attribute: "expires_at", type: "S", required: true },
      { attribute: "ttl", type: "N", roles: ["ttl"] },
      { attribute: "generation", type: "N", required: true },
      { attribute: "version", type: "N", roles: ["version"] },
      { attribute: "last_action", type: "S", required: true },
      { attribute: "last_command_id", type: "S", required: true },
      { attribute: "auth_subject", type: "S", required: true },
      {
        attribute: "reason_metadata",
        type: "M",
        optional: true,
        omit_empty: true,
      },
      {
        attribute: "status_metadata",
        type: "M",
        optional: true,
        omit_empty: true,
      },
      {
        attribute: "token_metadata",
        type: "L",
        optional: true,
        omit_empty: true,
      },
      { attribute: "metadata", type: "M", optional: true, omit_empty: true },
    ],
  });
}

export function validateMicroVMSessionRegistryRecord(
  record: MicroVMSessionRegistryRecord,
): void {
  const normalized = normalizeMicroVMSessionRegistryRecord(record);
  validateMicroVMSessionRecord(
    microVMSessionFromRegistryRecordNoValidate(normalized),
  );
  if (
    !normalized.pk ||
    !normalized.sk ||
    normalized.ttl <= 0 ||
    normalized.version <= 0
  ) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm session registry keys are incomplete",
      normalized.last_command_id,
    );
  }
  if (
    normalized.pk !==
      microVMSessionRegistryPartitionKey(
        normalized.tenant_id,
        normalized.namespace,
      ) ||
    normalized.sk !== microVMSessionRegistrySortKey(normalized.session_id)
  ) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm session registry tenant/session key mismatch",
      normalized.last_command_id,
    );
  }
  if (normalized.ttl !== Math.trunc(normalized.expires_at.getTime() / 1000)) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm session registry ttl mismatch",
      normalized.last_command_id,
    );
  }
  const metadataErr = validateSafeMicroVMMetadata(
    normalized.metadata,
    normalized.last_command_id,
  );
  if (metadataErr) throw metadataErr;
}

export function microVMSessionRecordToRegistryRecord(
  record: MicroVMSessionRecord,
): MicroVMSessionRegistryRecord {
  const normalized = normalizeMicroVMSessionRecord(record);
  validateMicroVMSessionRecord(normalized);
  const registry: MicroVMSessionRegistryRecord = {
    pk: microVMSessionRegistryPartitionKey(
      normalized.tenant_id,
      normalized.namespace,
    ),
    sk: microVMSessionRegistrySortKey(normalized.session_id),
    tenant_id: normalized.tenant_id,
    namespace: normalized.namespace,
    session_id: normalized.session_id,
    state: normalized.state,
    desired_state: normalized.desired_state,
    endpoint: normalized.endpoint ?? "",
    microvm_id: normalized.microvm_id ?? "",
    provider_id: normalized.provider_id,
    provider_microvm_id: normalized.provider_microvm_id ?? "",
    provider_state: normalized.provider_state,
    aws_lifecycle_state: normalized.aws_lifecycle_state,
    image_ref: normalized.image_ref,
    image_version: normalized.image_version ?? "",
    network_connector_ref: normalized.network_connector_ref,
    ingress_network_connector_refs: [
      ...(normalized.ingress_network_connector_refs ?? []),
    ],
    egress_network_connector_refs: [
      ...(normalized.egress_network_connector_refs ?? []),
    ],
    controller_id: normalized.controller_id,
    created_at: cloneMicroVMDate(normalized.created_at),
    updated_at: cloneMicroVMDate(normalized.updated_at),
    last_observed_at: cloneMicroVMDate(normalized.last_observed_at),
    provider_started_at: cloneMicroVMDate(
      normalized.provider_started_at ?? new Date(Number.NaN),
    ),
    provider_terminated_at: cloneMicroVMDate(
      normalized.provider_terminated_at ?? new Date(Number.NaN),
    ),
    expires_at: cloneMicroVMDate(normalized.expires_at),
    ttl: Math.trunc(normalized.expires_at.getTime() / 1000),
    generation: normalized.generation,
    version: normalized.generation,
    last_action: normalized.last_action,
    last_command_id: normalized.last_command_id,
    auth_subject: normalized.auth_subject,
  };
  const reasonMetadata = cloneStringMap(normalized.reason_metadata);
  if (reasonMetadata) registry.reason_metadata = reasonMetadata;
  const statusMetadata = cloneStringMap(normalized.status_metadata);
  if (statusMetadata) registry.status_metadata = statusMetadata;
  const tokenMetadata = cloneMicroVMSessionTokenMetadataList(
    normalized.token_metadata,
  );
  if (tokenMetadata) registry.token_metadata = tokenMetadata;
  const metadata = cloneStringMap(normalized.metadata);
  if (metadata) registry.metadata = metadata;
  validateMicroVMSessionRegistryRecord(registry);
  return registry;
}

export function microVMSessionFromRegistryRecord(
  record: MicroVMSessionRegistryRecord,
): MicroVMSessionRecord {
  const normalized = normalizeMicroVMSessionRegistryRecord(record);
  validateMicroVMSessionRegistryRecord(normalized);
  return microVMSessionFromRegistryRecordNoValidate(normalized);
}

export class MemoryMicroVMSessionRegistry implements MicroVMSessionRegistry {
  private readonly records = new Map<string, MicroVMSessionRegistryRecord>();

  async put(record: MicroVMSessionRecord): Promise<MicroVMSessionRecord> {
    const registry = microVMSessionRecordToRegistryRecord(record);
    this.records.set(
      microVMSessionRegistryRecordKey(registry),
      cloneMicroVMSessionRegistryRecord(registry),
    );
    return microVMSessionFromRegistryRecord(registry);
  }

  async get(key: MicroVMSessionKey): Promise<MicroVMSessionRecord> {
    const normalized = normalizeMicroVMSessionKey(key);
    validateMicroVMSessionKey(normalized);
    const record = this.records.get(
      microVMSessionRegistryRecordKeyFromKey(normalized),
    );
    if (!record) {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm session registry record not found",
        "",
      );
    }
    return microVMSessionFromRegistryRecord(
      cloneMicroVMSessionRegistryRecord(record),
    );
  }

  async delete(key: MicroVMSessionKey): Promise<void> {
    const normalized = normalizeMicroVMSessionKey(key);
    validateMicroVMSessionKey(normalized);
    this.records.delete(microVMSessionRegistryRecordKeyFromKey(normalized));
  }

  async list(input: MicroVMSessionListInput): Promise<MicroVMSessionRecord[]> {
    const tenant = String(input?.tenant_id ?? "").trim();
    const namespace = String(input?.namespace ?? "").trim();
    if (!tenant || !namespace) {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm session list is incomplete",
        String(input?.request_id ?? "").trim(),
      );
    }
    const out: MicroVMSessionRecord[] = [];
    for (const record of this.records.values()) {
      if (record.tenant_id !== tenant || record.namespace !== namespace) {
        continue;
      }
      out.push(
        microVMSessionFromRegistryRecord(
          cloneMicroVMSessionRegistryRecord(record),
        ),
      );
    }
    out.sort((a, b) => a.session_id.localeCompare(b.session_id));
    return out;
  }
}

export function createMemoryMicroVMSessionRegistry(): MemoryMicroVMSessionRegistry {
  return new MemoryMicroVMSessionRegistry();
}

export async function reconstructMicroVMSessionRecord(
  request: MicroVMSessionReconstructionRequest,
  hook?: MicroVMSessionReconstructionHook | null,
): Promise<MicroVMSessionRecord> {
  const normalized = normalizeMicroVMSessionReconstructionRequest(request);
  validateMicroVMSessionKey(normalized);
  if (!hook) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm registry reconstruction requires a product hook",
      normalized.request_id ?? "",
    );
  }
  let record: MicroVMSessionRecord;
  try {
    record = await hook(normalized);
  } catch {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm registry reconstruction hook failed",
      normalized.request_id ?? "",
    );
  }
  const reconstructed = normalizeMicroVMSessionRecord(record);
  if (
    reconstructed.tenant_id !== normalized.tenant_id ||
    reconstructed.namespace !== normalized.namespace ||
    reconstructed.session_id !== normalized.session_id
  ) {
    throw safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm registry reconstruction tenant/session mismatch",
      normalized.request_id ?? "",
    );
  }
  validateMicroVMSessionRecord(reconstructed);
  const now = cloneMicroVMDate(normalized.now ?? new Date(Number.NaN));
  if (validDate(now) && reconstructed.expires_at.valueOf() <= now.valueOf()) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm registry reconstruction returned stale state",
      normalized.request_id ?? "",
    );
  }
  return reconstructed;
}

export class ReconstructingMicroVMSessionRegistry implements MicroVMSessionRegistry {
  private readonly registry: MicroVMSessionRegistry;
  private readonly hook: MicroVMSessionReconstructionHook;
  private readonly staleAfterMs: number;
  private readonly clock: MicroVMClock;

  constructor(
    registry: MicroVMSessionRegistry,
    hook: MicroVMSessionReconstructionHook,
    options: ReconstructingMicroVMSessionRegistryOptions = {},
  ) {
    if (!registry) {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm registry reconstruction requires a session registry",
        "",
      );
    }
    if (!hook) {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm registry reconstruction requires a product hook",
        "",
      );
    }
    this.registry = registry;
    this.hook = hook;
    const staleAfterMs = Math.trunc(Number(options.stale_after_ms) || 0);
    this.staleAfterMs = staleAfterMs > 0 ? staleAfterMs : 0;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  async put(record: MicroVMSessionRecord): Promise<MicroVMSessionRecord> {
    return await this.registry.put(record);
  }

  async get(key: MicroVMSessionKey): Promise<MicroVMSessionRecord> {
    const normalized = normalizeMicroVMSessionKey(key);
    validateMicroVMSessionKey(normalized);
    const now = this.clock.now();
    let existing: MicroVMSessionRecord | undefined;
    try {
      const record = await this.registry.get(normalized);
      if (!microVMSessionRecordIsStale(record, now, this.staleAfterMs)) {
        return record;
      }
      existing = record;
    } catch {
      existing = undefined;
    }
    const request: MicroVMSessionReconstructionRequest = {
      tenant_id: normalized.tenant_id,
      namespace: normalized.namespace,
      session_id: normalized.session_id,
      now,
    };
    if (existing) request.existing = existing;
    const reconstructed = await reconstructMicroVMSessionRecord(
      request,
      this.hook,
    );
    return await this.registry.put(reconstructed);
  }

  async delete(key: MicroVMSessionKey): Promise<void> {
    await this.registry.delete(key);
  }

  async list(input: MicroVMSessionListInput): Promise<MicroVMSessionRecord[]> {
    if (typeof this.registry.list !== "function") {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm registry reconstruction requires tenant-bound list support",
        String(input?.request_id ?? "").trim(),
      );
    }
    return await this.registry.list(input);
  }
}

export function createReconstructingMicroVMSessionRegistry(
  registry: MicroVMSessionRegistry,
  hook: MicroVMSessionReconstructionHook,
  options: ReconstructingMicroVMSessionRegistryOptions = {},
): ReconstructingMicroVMSessionRegistry {
  return new ReconstructingMicroVMSessionRegistry(registry, hook, options);
}

export class TableTheoryMicroVMSessionRegistry implements MicroVMSessionRegistry {
  private readonly db: MicroVMTableTheoryClient;
  private readonly modelName: string;

  constructor(
    db: MicroVMTableTheoryClient,
    options: TableTheoryMicroVMSessionRegistryOptions = {},
  ) {
    if (!db) {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm session registry requires TableTheory client",
        "",
      );
    }
    this.db = db;
    this.modelName =
      String(options.model_name ?? "").trim() ||
      MICROVM_SESSION_REGISTRY_MODEL_NAME;
    if (options.auto_register !== false && this.db.register) {
      this.db.register(
        microVMSessionRegistryModel(
          String(options.table_name ?? "").trim() ||
            microVMSessionRegistryTableName(),
        ),
      );
    }
  }

  async put(record: MicroVMSessionRecord): Promise<MicroVMSessionRecord> {
    const registry = microVMSessionRecordToRegistryRecord(record);
    try {
      await this.db.save(this.modelName, registryRecordToTableItem(registry));
      return microVMSessionFromRegistryRecord(registry);
    } catch (err) {
      throw asMicroVMSessionRegistryError(err, registry.last_command_id);
    }
  }

  async get(key: MicroVMSessionKey): Promise<MicroVMSessionRecord> {
    const normalized = normalizeMicroVMSessionKey(key);
    validateMicroVMSessionKey(normalized);
    try {
      const item = await this.db.get(this.modelName, {
        pk: microVMSessionRegistryPartitionKey(
          normalized.tenant_id,
          normalized.namespace,
        ),
        sk: microVMSessionRegistrySortKey(normalized.session_id),
      });
      return microVMSessionFromRegistryRecord(
        registryRecordFromTableItem(item),
      );
    } catch (err) {
      throw asMicroVMSessionRegistryError(err, "");
    }
  }

  async delete(key: MicroVMSessionKey): Promise<void> {
    const normalized = normalizeMicroVMSessionKey(key);
    validateMicroVMSessionKey(normalized);
    try {
      await this.db.delete(this.modelName, {
        pk: microVMSessionRegistryPartitionKey(
          normalized.tenant_id,
          normalized.namespace,
        ),
        sk: microVMSessionRegistrySortKey(normalized.session_id),
      });
    } catch (err) {
      throw asMicroVMSessionRegistryError(err, "");
    }
  }

  async list(input: MicroVMSessionListInput): Promise<MicroVMSessionRecord[]> {
    const tenant = String(input?.tenant_id ?? "").trim();
    const namespace = String(input?.namespace ?? "").trim();
    if (!tenant || !namespace) {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm session list is incomplete",
        String(input?.request_id ?? "").trim(),
      );
    }
    if (typeof this.db.list !== "function") {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm session registry requires tenant-bound list support",
        String(input?.request_id ?? "").trim(),
      );
    }
    try {
      const items = await this.db.list(this.modelName, {
        pk: microVMSessionRegistryPartitionKey(tenant, namespace),
      });
      return items
        .map((item) =>
          microVMSessionFromRegistryRecord(registryRecordFromTableItem(item)),
        )
        .sort((a, b) => a.session_id.localeCompare(b.session_id));
    } catch (err) {
      if (err instanceof MicroVMSafeError) throw err;
      throw asMicroVMSessionRegistryError(err, String(input?.request_id ?? ""));
    }
  }
}

export function createTableTheoryMicroVMSessionRegistry(
  db: MicroVMTableTheoryClient,
  options: TableTheoryMicroVMSessionRegistryOptions = {},
): TableTheoryMicroVMSessionRegistry {
  return new TableTheoryMicroVMSessionRegistry(db, options);
}

export class MicroVMRegistryClient implements MicroVMClient {
  private readonly registry: MicroVMSessionRegistry;
  private readonly ttlMs: number;

  constructor(
    registry: MicroVMSessionRegistry,
    options: MicroVMRegistryClientOptions = {},
  ) {
    if (!registry) {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm registry client requires a session registry",
        "",
      );
    }
    this.registry = registry;
    const ttlMs = Math.trunc(Number(options.ttl_ms) || 0);
    this.ttlMs = ttlMs > 0 ? ttlMs : 60 * 60 * 1000;
  }

  async create(
    input: MicroVMCreateSessionInput,
  ): Promise<MicroVMSessionRecord> {
    const now = coalesceMicroVMTime(input.now, new Date(0));
    const record: MicroVMSessionRecord = {
      tenant_id: input.tenant_id,
      namespace: input.namespace,
      session_id: input.session_id,
      state: MicroVMState.Requested,
      desired_state: MicroVMState.Requested,
      endpoint: "",
      microvm_id: "",
      provider_id: MICROVM_DEFAULT_SESSION_PROVIDER_ID,
      provider_microvm_id: input.session_id,
      provider_state: MicroVMState.Requested,
      aws_lifecycle_state: MicroVMState.Requested,
      image_ref: input.image_ref,
      network_connector_ref: input.network_connector_ref,
      controller_id: input.controller_id,
      created_at: now,
      updated_at: now,
      last_observed_at: now,
      expires_at: new Date(now.valueOf() + this.ttlMs),
      generation: 1,
      last_action: MicroVMCommand.Create,
      last_command_id: input.request_id,
      auth_subject: input.auth_subject,
    };
    const metadata = cloneStringMap(input.session_spec.metadata);
    if (metadata) record.metadata = metadata;
    return await this.registry.put(record);
  }

  async start(
    input: MicroVMSessionCommandInput,
  ): Promise<MicroVMSessionRecord> {
    return await this.transition(
      input,
      MicroVMCommand.Start,
      MicroVMState.Starting,
      MicroVMState.Started,
    );
  }

  async stop(input: MicroVMSessionCommandInput): Promise<MicroVMSessionRecord> {
    return await this.transition(
      input,
      MicroVMCommand.Stop,
      MicroVMState.Stopping,
      MicroVMState.Stopped,
    );
  }

  async status(input: MicroVMSessionQueryInput): Promise<MicroVMSessionStatus> {
    const record = await this.session(input);
    const status: MicroVMSessionStatus = {
      tenant_id: record.tenant_id,
      namespace: record.namespace,
      session_id: record.session_id,
      state: record.state,
      desired_state: record.desired_state,
      lifecycle_state: record.state,
      endpoint: record.endpoint ?? "",
      microvm_id: record.microvm_id ?? "",
      last_action: record.last_action,
      last_transition: record.updated_at,
      registry_version: record.generation,
    };
    validateMicroVMSessionStatus(status);
    return status;
  }

  async session(
    input: MicroVMSessionQueryInput,
  ): Promise<MicroVMSessionRecord> {
    return await this.registry.get({
      tenant_id: input.tenant_id,
      namespace: input.namespace,
      session_id: input.session_id,
    });
  }

  private async transition(
    input: MicroVMSessionCommandInput,
    action: MicroVMCommandName,
    state: MicroVMLifecycleState,
    desiredState: MicroVMLifecycleState,
  ): Promise<MicroVMSessionRecord> {
    const record = await this.registry.get({
      tenant_id: input.tenant_id,
      namespace: input.namespace,
      session_id: input.session_id,
    });
    const next: MicroVMSessionRecord = {
      ...record,
      state,
      desired_state: desiredState,
      provider_id: record.provider_id || MICROVM_DEFAULT_SESSION_PROVIDER_ID,
      provider_microvm_id: record.provider_microvm_id || record.session_id,
      provider_state: state,
      aws_lifecycle_state: state,
      controller_id: input.controller_id,
      auth_subject: input.auth_subject,
      last_action: action,
      last_command_id: input.request_id,
      updated_at: coalesceMicroVMTime(input.now, new Date(0)),
      last_observed_at: coalesceMicroVMTime(input.now, new Date(0)),
      generation: record.generation + 1,
    };
    return await this.registry.put(next);
  }
}

export function createMicroVMRegistryClient(
  registry: MicroVMSessionRegistry,
  options: MicroVMRegistryClientOptions = {},
): MicroVMRegistryClient {
  return new MicroVMRegistryClient(registry, options);
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

export interface MicroVMControllerRouteTarget {
  handle: (
    request: MicroVMControllerRequest,
  ) => MicroVMControllerResponse | Promise<MicroVMControllerResponse>;
}

export class MicroVMRealController implements MicroVMControllerRouteTarget {
  private readonly provider: MicroVMProvider;
  private readonly registry: MicroVMSessionRegistry;
  private readonly controllerID: string;
  private readonly providerID: string;
  private readonly executionRoleArn: string;
  private readonly clock: MicroVMClock;
  private readonly ids: MicroVMIDGenerator;
  private readonly ttlMs: number;

  constructor(
    provider: MicroVMProvider,
    registry: MicroVMSessionRegistry,
    options: MicroVMControllerOptions = {},
  ) {
    if (!provider) {
      throw safeError(
        MICROVM_ERROR_CONTROLLER_INCOMPLETE,
        "apptheory: microvm controller requires a provider adapter",
        "",
      );
    }
    if (!registry) {
      throw safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm controller requires a session registry",
        "",
      );
    }
    this.provider = provider;
    this.registry = registry;
    this.controllerID =
      String(options.controller_id ?? "").trim() ||
      "apptheory-microvm-controller";
    this.providerID =
      String(options.provider_id ?? "").trim() ||
      MICROVM_AWS_LAMBDA_PROVIDER_ID;
    this.executionRoleArn = normalizeMicroVMExecutionRoleArn(
      options.execution_role_arn ?? environmentMicroVMExecutionRoleArn(),
    );
    const executionRoleErr = validateMicroVMExecutionRoleArn(
      this.executionRoleArn,
      "",
    );
    if (executionRoleErr) {
      throw safeError(
        MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
        "apptheory: microvm execution role arn is invalid",
        "",
      );
    }
    this.clock = options.clock ?? { now: () => new Date() };
    this.ids = options.ids ?? { newID: () => randomMicroVMSessionID() };
    const ttlMs = Math.trunc(Number(options.ttl_ms) || 0);
    this.ttlMs = ttlMs > 0 ? ttlMs : 60 * 60 * 1000;
  }

  async handle(
    request: MicroVMControllerRequest,
  ): Promise<MicroVMControllerResponse> {
    const normalized = normalizeMicroVMControllerRequest(request);
    const validationErr = validateMicroVMRealControllerRequest(normalized);
    if (validationErr) {
      return controllerErrorResponse(normalized, validationErr);
    }

    switch (normalized.command) {
      case MicroVMCommand.Run:
        return await this.handleRun(normalized);
      case MicroVMCommand.Get:
        return await this.handleSession(
          normalized,
          MicroVMOperation.Get,
          this.provider.get.bind(this.provider),
        );
      case MicroVMCommand.List:
        return await this.handleList(normalized);
      case MicroVMCommand.Suspend:
        return await this.handleSession(
          normalized,
          MicroVMOperation.Suspend,
          this.provider.suspend.bind(this.provider),
        );
      case MicroVMCommand.Resume:
        return await this.handleSession(
          normalized,
          MicroVMOperation.Resume,
          this.provider.resume.bind(this.provider),
        );
      case MicroVMCommand.Terminate:
        return await this.handleSession(
          normalized,
          MicroVMOperation.Terminate,
          this.provider.terminate.bind(this.provider),
        );
      case MicroVMCommand.AuthToken:
        return await this.handleToken(
          normalized,
          MicroVMOperation.AuthToken,
          this.provider.createAuthToken.bind(this.provider),
        );
      case MicroVMCommand.ShellAuthToken:
        return await this.handleToken(
          normalized,
          MicroVMOperation.ShellAuthToken,
          this.provider.createShellToken.bind(this.provider),
        );
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

  private async handleRun(
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

    const requestWithSession = { ...request, session_id: sessionID };
    try {
      const input: MicroVMProviderRunInput = {
        request_id: requestWithSession.request_id,
        tenant_id: requestWithSession.tenant_id,
        namespace: requestWithSession.namespace,
        session_id: requestWithSession.session_id,
        auth_context: requestWithSession.auth_context,
        image_ref: requestWithSession.image_ref,
        image_version: requestWithSession.image_version,
        network_connector_ref: requestWithSession.network_connector_ref,
        ingress_network_connector_refs: [
          ...requestWithSession.ingress_network_connector_refs,
        ],
        egress_network_connector_refs: [
          ...requestWithSession.egress_network_connector_refs,
        ],
        session_spec: cloneMicroVMSessionSpec(requestWithSession.session_spec),
        maximum_duration_seconds: requestWithSession.maximum_duration_seconds,
      };
      if (this.executionRoleArn) {
        input.execution_role_arn = this.executionRoleArn;
      }
      if (requestWithSession.idle_policy) {
        input.idle_policy = requestWithSession.idle_policy;
      }
      const session = await this.provider.run(input);
      validateMicroVMProviderSession(session);
      const record = await this.putProviderSession(requestWithSession, session);
      return responseFromMicroVMProviderSession(
        requestWithSession,
        microVMProviderSessionFromRegistryRecord(record),
      );
    } catch (err) {
      return controllerErrorResponse(
        requestWithSession,
        asMicroVMSafeError(err, requestWithSession.request_id),
      );
    }
  }

  private async handleSession(
    request: NormalizedMicroVMControllerRequest,
    operation: MicroVMOperationName,
    run: (
      input: MicroVMProviderSessionInput,
    ) => Promise<MicroVMProviderSession>,
  ): Promise<MicroVMControllerResponse> {
    try {
      const record = await this.registry.get({
        tenant_id: request.tenant_id,
        namespace: request.namespace,
        session_id: request.session_id,
      });
      validateMicroVMSessionRecord(record);
      const session = await run({
        request_id: request.request_id,
        tenant_id: request.tenant_id,
        namespace: request.namespace,
        auth_context: request.auth_context,
        binding: microVMProviderBindingFromRecord(record),
      });
      validateMicroVMProviderSession(session);
      const commandRequest = {
        ...request,
        command: microVMCommandFromOperation(operation),
      };
      const updated = await this.putProviderSession(
        commandRequest,
        session,
        record,
      );
      return responseFromMicroVMProviderSession(
        commandRequest,
        microVMProviderSessionFromRegistryRecord(updated),
      );
    } catch (err) {
      return controllerErrorResponse(
        request,
        asMicroVMSafeError(err, request.request_id),
      );
    }
  }

  private async handleList(
    request: NormalizedMicroVMControllerRequest,
  ): Promise<MicroVMControllerResponse> {
    if (typeof this.registry.list !== "function") {
      const err = safeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "apptheory: microvm controller list requires a tenant-bound session registry lister",
        request.request_id,
      );
      return controllerErrorResponse(request, err);
    }
    try {
      const records = await this.registry.list({
        request_id: request.request_id,
        tenant_id: request.tenant_id,
        namespace: request.namespace,
        auth_subject: request.auth_context.subject,
      });
      const bindings: MicroVMProviderSessionBinding[] = [];
      const recordsByKey = new Map<string, MicroVMSessionRecord>();
      for (const record of records) {
        validateMicroVMSessionRecord(record);
        const binding = microVMProviderBindingFromRecord(record);
        bindings.push(binding);
        recordsByKey.set(
          microVMProviderSessionKeyString(
            binding.tenant_id,
            binding.namespace,
            binding.session_id,
          ),
          record,
        );
      }
      const out = await this.provider.list({
        request_id: request.request_id,
        tenant_id: request.tenant_id,
        namespace: request.namespace,
        auth_context: request.auth_context,
        image_ref: request.image_ref,
        image_version: request.image_version,
        max_results: request.max_results,
        known_sessions: bindings,
      });
      const sessions: MicroVMProviderSession[] = [];
      for (const rawSession of out.sessions ?? []) {
        const session = cloneMicroVMProviderSession(rawSession);
        const record = recordsByKey.get(
          microVMProviderSessionKeyString(
            session.tenant_id,
            session.namespace,
            session.session_id,
          ),
        );
        if (!record) continue;
        validateMicroVMProviderSession(session);
        const updated = await this.putProviderSession(request, session, record);
        sessions.push(microVMProviderSessionFromRegistryRecord(updated));
      }
      return {
        command: request.command,
        request_id: request.request_id,
        tenant_id: request.tenant_id,
        namespace: request.namespace,
        session_id: "",
        sessions,
        recovery_cursor: String(out.recovery_cursor ?? "").trim(),
      };
    } catch (err) {
      return controllerErrorResponse(
        request,
        asMicroVMSafeError(err, request.request_id),
      );
    }
  }

  private async handleToken(
    request: NormalizedMicroVMControllerRequest,
    operation: MicroVMOperationName,
    run: (input: MicroVMProviderTokenInput) => Promise<MicroVMProviderToken>,
  ): Promise<MicroVMControllerResponse> {
    try {
      const record = await this.registry.get({
        tenant_id: request.tenant_id,
        namespace: request.namespace,
        session_id: request.session_id,
      });
      validateMicroVMSessionRecord(record);
      const token = await run({
        request_id: request.request_id,
        tenant_id: request.tenant_id,
        namespace: request.namespace,
        auth_context: request.auth_context,
        binding: microVMProviderBindingFromRecord(record),
        ttl_seconds: request.ttl_seconds,
        allowed_port_scope: [...request.allowed_port_scope],
      });
      validateMicroVMProviderToken(token);
      const metadata = microVMSessionTokenMetadataFromProviderToken(token);
      const now = this.now();
      const next: MicroVMSessionRecord = {
        ...record,
        token_metadata: [
          ...(cloneMicroVMSessionTokenMetadataList(record.token_metadata) ??
            []),
          metadata,
        ],
        last_action: microVMCommandFromOperation(operation),
        last_command_id: request.request_id,
        auth_subject: request.auth_context.subject,
        updated_at: now,
        last_observed_at: now,
        generation: record.generation + 1,
      };
      await this.registry.put(next);
      return responseFromMicroVMProviderToken(request, token);
    } catch (err) {
      return controllerErrorResponse(
        request,
        asMicroVMSafeError(err, request.request_id),
      );
    }
  }

  private async putProviderSession(
    request: NormalizedMicroVMControllerRequest,
    session: MicroVMProviderSession,
    existing?: MicroVMSessionRecord,
  ): Promise<MicroVMSessionRecord> {
    const record = this.sessionRecordFromProviderSession(
      request,
      session,
      existing,
    );
    validateMicroVMSessionRecord(record);
    return await this.registry.put(record);
  }

  private sessionRecordFromProviderSession(
    request: NormalizedMicroVMControllerRequest,
    session: MicroVMProviderSession,
    existing?: MicroVMSessionRecord,
  ): MicroVMSessionRecord {
    const now = this.now();
    const current = existing ? normalizeMicroVMSessionRecord(existing) : null;
    const expiresAt =
      current && validDate(current.expires_at) && current.expires_at > now
        ? current.expires_at
        : new Date(now.valueOf() + this.ttlMs);
    const record: MicroVMSessionRecord = {
      tenant_id: session.tenant_id,
      namespace: session.namespace,
      session_id: session.session_id,
      state: session.state,
      desired_state: desiredStateForMicroVMRealCommand(
        request.command,
        session.state,
      ),
      endpoint: current?.endpoint ?? "",
      microvm_id: current?.microvm_id ?? "",
      provider_id: current?.provider_id || this.providerID,
      provider_microvm_id: session.provider_microvm_id,
      provider_state: session.provider_state,
      aws_lifecycle_state: session.provider_state,
      image_ref:
        session.image_ref || request.image_ref || current?.image_ref || "",
      image_version:
        session.image_version ||
        request.image_version ||
        current?.image_version ||
        "",
      network_connector_ref:
        request.network_connector_ref || current?.network_connector_ref || "",
      ingress_network_connector_refs:
        request.ingress_network_connector_refs.length > 0
          ? [...request.ingress_network_connector_refs]
          : [...(current?.ingress_network_connector_refs ?? [])],
      egress_network_connector_refs:
        request.egress_network_connector_refs.length > 0
          ? [...request.egress_network_connector_refs]
          : [...(current?.egress_network_connector_refs ?? [])],
      controller_id: this.controllerID,
      created_at:
        current?.created_at && validDate(current.created_at)
          ? current.created_at
          : now,
      updated_at: now,
      last_observed_at: now,
      expires_at: expiresAt,
      generation:
        current && current.generation > 0 ? current.generation + 1 : 1,
      last_action: request.command,
      last_command_id: request.request_id,
      auth_subject: request.auth_context.subject,
    };
    if (validDate(session.started_at as Date)) {
      record.provider_started_at = cloneMicroVMDate(session.started_at as Date);
    } else if (current?.provider_started_at) {
      record.provider_started_at = current.provider_started_at;
    }
    if (validDate(session.terminated_at as Date)) {
      record.provider_terminated_at = cloneMicroVMDate(
        session.terminated_at as Date,
      );
    } else if (current?.provider_terminated_at) {
      record.provider_terminated_at = current.provider_terminated_at;
    }
    const metadata = current
      ? cloneStringMap(current.metadata)
      : cloneStringMap(request.session_spec.metadata);
    if (metadata) record.metadata = metadata;
    const tokenMetadata = cloneMicroVMSessionTokenMetadataList(
      current?.token_metadata,
    );
    if (tokenMetadata) record.token_metadata = tokenMetadata;
    return record;
  }

  private now(): Date {
    const now = cloneMicroVMDate(this.clock.now());
    return validDate(now) ? now : new Date();
  }
}

export function createRealMicroVMController(
  provider: MicroVMProvider,
  registry: MicroVMSessionRegistry,
  options: MicroVMControllerOptions = {},
): MicroVMRealController {
  return new MicroVMRealController(provider, registry, options);
}

export function registerMicroVMControllerRoutes(
  app: App,
  controller: MicroVMControllerRouteTarget,
): App {
  if (!app) {
    throw new Error(
      "apptheory: microvm controller route registration requires an app",
    );
  }
  if (!controller) {
    throw safeError(
      MICROVM_ERROR_CONTROLLER_INCOMPLETE,
      "apptheory: microvm controller route registration requires a controller",
      "",
    );
  }
  const routes: Array<{
    method: string;
    path: string;
    command: MicroVMCommandName;
  }> = [
    { method: "POST", path: "/microvms", command: MicroVMCommand.Run },
    { method: "GET", path: "/microvms", command: MicroVMCommand.List },
    {
      method: "GET",
      path: "/microvms/{session_id}",
      command: MicroVMCommand.Get,
    },
    {
      method: "POST",
      path: "/microvms/{session_id}/suspend",
      command: MicroVMCommand.Suspend,
    },
    {
      method: "POST",
      path: "/microvms/{session_id}/resume",
      command: MicroVMCommand.Resume,
    },
    {
      method: "DELETE",
      path: "/microvms/{session_id}",
      command: MicroVMCommand.Terminate,
    },
    {
      method: "POST",
      path: "/microvms/{session_id}/auth-token",
      command: MicroVMCommand.AuthToken,
    },
    {
      method: "POST",
      path: "/microvms/{session_id}/shell-auth-token",
      command: MicroVMCommand.ShellAuthToken,
    },
    {
      method: "POST",
      path: "/microvms/{session_id}/shell-token",
      command: MicroVMCommand.ShellAuthToken,
    },
  ];
  for (const route of routes) {
    app.handleStrict(
      route.method,
      route.path,
      microVMControllerRouteHandler(controller, route.command),
      { authRequired: true },
    );
  }
  return app;
}

export function registerControllerRoutes(
  app: App,
  controller: MicroVMControllerRouteTarget,
): App {
  return registerMicroVMControllerRoutes(app, controller);
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

function validateMicroVMRealControllerRequest(
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
  for (const value of [
    normalized.image_ref,
    normalized.image_version,
    normalized.network_connector_ref,
    ...normalized.ingress_network_connector_refs,
    ...normalized.egress_network_connector_refs,
  ]) {
    const err = validateSafeMicroVMFieldValue(value, normalized.request_id);
    if (err) return err;
  }

  switch (normalized.command) {
    case MicroVMCommand.Run:
      if (!normalized.image_ref || !normalized.network_connector_ref) {
        return safeError(
          MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
          "apptheory: microvm run requires image and network connector refs",
          normalized.request_id,
        );
      }
      return null;
    case MicroVMCommand.List:
      return null;
    case MicroVMCommand.Get:
    case MicroVMCommand.Suspend:
    case MicroVMCommand.Resume:
    case MicroVMCommand.Terminate:
    case MicroVMCommand.AuthToken:
    case MicroVMCommand.ShellAuthToken:
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

function microVMCommandFromOperation(
  operation: MicroVMOperationName | string,
): MicroVMCommandName {
  switch (normalizeMicroVMOperation(operation)) {
    case MicroVMOperation.Run:
      return MicroVMCommand.Run;
    case MicroVMOperation.Get:
      return MicroVMCommand.Get;
    case MicroVMOperation.List:
      return MicroVMCommand.List;
    case MicroVMOperation.Suspend:
      return MicroVMCommand.Suspend;
    case MicroVMOperation.Resume:
      return MicroVMCommand.Resume;
    case MicroVMOperation.Terminate:
      return MicroVMCommand.Terminate;
    case MicroVMOperation.AuthToken:
      return MicroVMCommand.AuthToken;
    case MicroVMOperation.ShellAuthToken:
      return MicroVMCommand.ShellAuthToken;
    default:
      return normalizeMicroVMCommand(String(operation)) as MicroVMCommandName;
  }
}

function desiredStateForMicroVMRealCommand(
  command: MicroVMCommandName | string,
  fallback: MicroVMLifecycleState | string,
): MicroVMLifecycleState | string {
  switch (normalizeMicroVMCommand(command)) {
    case MicroVMCommand.Run:
      return MicroVMRealState.Running;
    case MicroVMCommand.Suspend:
      return MicroVMRealState.Suspended;
    case MicroVMCommand.Resume:
      return MicroVMRealState.Ready;
    case MicroVMCommand.Terminate:
      return MicroVMRealState.Terminated;
    default:
      return fallback;
  }
}

function microVMProviderBindingFromRecord(
  record: MicroVMSessionRecord,
): MicroVMProviderSessionBinding {
  const normalized = normalizeMicroVMSessionRecord(record);
  const binding: MicroVMProviderSessionBinding = {
    tenant_id: normalized.tenant_id,
    namespace: normalized.namespace,
    session_id: normalized.session_id,
    provider_microvm_id: normalized.provider_microvm_id ?? "",
    registry_version: normalized.generation,
  };
  return binding;
}

function microVMProviderSessionFromRegistryRecord(
  record: MicroVMSessionRecord,
): MicroVMProviderSession {
  const normalized = normalizeMicroVMSessionRecord(record);
  let state = normalized.state;
  let terminal =
    state === MicroVMRealState.Terminated || state === MicroVMRealState.Failed;
  try {
    const mapped = mapMicroVMProviderState(normalized.provider_state);
    state = mapped.state;
    terminal = mapped.terminal;
  } catch {
    // Keep the registry state when a provider reported a state before mapping
    // validation was introduced. The record itself remains contract-validated.
  }
  const session: MicroVMProviderSession = {
    tenant_id: normalized.tenant_id,
    namespace: normalized.namespace,
    session_id: normalized.session_id,
    provider_microvm_id: normalized.provider_microvm_id ?? "",
    state,
    provider_state: normalized.provider_state,
    registry_version: normalized.generation,
    terminal,
  };
  if (normalized.image_ref) session.image_ref = normalized.image_ref;
  if (normalized.image_version)
    session.image_version = normalized.image_version;
  const startedAt = normalized.provider_started_at;
  if (startedAt && validDate(startedAt)) {
    session.started_at = startedAt;
  }
  const terminatedAt = normalized.provider_terminated_at;
  if (terminatedAt && validDate(terminatedAt)) {
    session.terminated_at = terminatedAt;
  }
  return normalizeMicroVMProviderSession(session);
}

function responseFromMicroVMProviderSession(
  request: NormalizedMicroVMControllerRequest,
  session: MicroVMProviderSession,
): MicroVMControllerResponse {
  const normalized = normalizeMicroVMProviderSession(session);
  return {
    command: request.command,
    request_id: request.request_id,
    tenant_id: normalized.tenant_id,
    namespace: normalized.namespace,
    session_id: normalized.session_id,
    state: normalized.state,
    desired_state: desiredStateForMicroVMRealCommand(
      request.command,
      normalized.state,
    ),
    lifecycle_state: normalized.state,
    provider_microvm_id: normalized.provider_microvm_id,
    provider_state: normalized.provider_state,
    last_action: request.command,
    registry_version: normalized.registry_version ?? 0,
  };
}

function responseFromMicroVMProviderToken(
  request: NormalizedMicroVMControllerRequest,
  token: MicroVMProviderToken,
): MicroVMControllerResponse {
  const normalized = normalizeMicroVMProviderToken(token);
  return {
    command: request.command,
    request_id: request.request_id,
    tenant_id: normalized.tenant_id,
    namespace: normalized.namespace,
    session_id: normalized.session_id,
    provider_microvm_id: normalized.provider_microvm_id,
    token_id: normalized.token_id,
    token_type: normalized.token_type,
    expires_at: normalized.expires_at,
    scope: [...normalized.scope],
  };
}

function microVMControllerRouteHandler(
  controller: MicroVMControllerRouteTarget,
  command: MicroVMCommandName,
): (ctx: Context) => Promise<Response> {
  return async (ctx: Context): Promise<Response> => {
    const parsed = microVMControllerRequestFromHTTP(ctx, command);
    if (parsed instanceof MicroVMSafeError) {
      const request: MicroVMControllerRequest = {
        command,
        request_id: String(ctx?.requestId ?? "").trim(),
        tenant_id: String(ctx?.tenantId ?? "").trim(),
        namespace: "",
        auth_context: {
          subject: String(ctx?.authIdentity ?? "").trim(),
          tenant_id: String(ctx?.tenantId ?? "").trim(),
        },
      };
      return microVMControllerHTTPResponse(
        controllerErrorResponse(request, parsed),
      );
    }
    const response = await controller.handle(parsed);
    return microVMControllerHTTPResponse(response);
  };
}

function microVMControllerRequestFromHTTP(
  ctx: Context,
  command: MicroVMCommandName,
): MicroVMControllerRequest | MicroVMSafeError {
  if (!ctx) {
    return safeError(
      MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
      "apptheory: microvm controller route context is missing",
      "",
    );
  }
  const payloadResult = microVMControllerRoutePayload(ctx);
  if (payloadResult instanceof MicroVMSafeError) return payloadResult;
  const payload = payloadResult;
  const pathSessionID = String(ctx.param("session_id") ?? "").trim();
  const bodySessionID = stringFromPayload(payload, "session_id");
  if (pathSessionID && bodySessionID && pathSessionID !== bodySessionID) {
    return safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm controller route session binding mismatch",
      ctx.requestId,
    );
  }
  const ctxTenant = String(ctx.tenantId ?? "").trim();
  const bodyTenant = stringFromPayload(payload, "tenant_id");
  const queryTenant = firstQueryValue(ctx.request.query, "tenant_id");
  if (ctxTenant && bodyTenant && bodyTenant !== ctxTenant) {
    return safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm controller route tenant binding mismatch",
      ctx.requestId,
    );
  }
  if (ctxTenant && queryTenant && queryTenant !== ctxTenant) {
    return safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm controller route tenant binding mismatch",
      ctx.requestId,
    );
  }
  const namespace =
    stringFromPayload(payload, "namespace") ||
    firstHeaderValueFromMap(ctx.request.headers, "x-namespace-id") ||
    firstQueryValue(ctx.request.query, "namespace");
  const request: MicroVMControllerRequest = {
    command: normalizeMicroVMCommand(command),
    request_id: String(ctx.requestId ?? "").trim(),
    tenant_id: ctxTenant || bodyTenant || queryTenant,
    namespace,
    auth_context: {
      subject: String(ctx.authIdentity ?? "").trim(),
      tenant_id: ctxTenant,
      namespace,
    },
    session_id: pathSessionID || bodySessionID,
    image_ref: stringFromPayload(payload, "image_ref"),
    image_version: stringFromPayload(payload, "image_version"),
    network_connector_ref: stringFromPayload(payload, "network_connector_ref"),
    ingress_network_connector_refs: stringListFromPayload(
      payload,
      "ingress_network_connector_refs",
    ),
    egress_network_connector_refs: stringListFromPayload(
      payload,
      "egress_network_connector_refs",
    ),
    session_spec: sessionSpecFromPayload(payload),
    maximum_duration_seconds: intFromPayload(
      payload,
      "maximum_duration_seconds",
    ),
    ttl_seconds: intFromPayload(payload, "ttl_seconds"),
    allowed_port_scope: portScopesFromPayload(payload),
    max_results:
      positiveIntFromPayload(payload, "max_results") ||
      positiveIntFromString(firstQueryValue(ctx.request.query, "max_results")),
  };
  const idlePolicy = idlePolicyFromPayload(payload);
  if (idlePolicy) request.idle_policy = idlePolicy;
  return normalizeMicroVMControllerRequest(request);
}

function microVMControllerRoutePayload(
  ctx: Context,
): Record<string, unknown> | MicroVMSafeError {
  if ((ctx.request.body?.length ?? 0) === 0) return {};
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(ctx.request.body).toString("utf8"),
    );
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return safeError(
        MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
        "apptheory: microvm controller route request is malformed",
        ctx.requestId,
      );
    }
    return parsed as Record<string, unknown>;
  } catch {
    return safeError(
      MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
      "apptheory: microvm controller route request is malformed",
      ctx.requestId,
    );
  }
}

function microVMControllerHTTPResponse(
  response: MicroVMControllerResponse,
): Response {
  return jsonResponse(
    microVMControllerHTTPStatus(response.error),
    serializableMicroVMControllerResponse(response),
  );
}

function microVMControllerHTTPStatus(err?: MicroVMSafeError): number {
  if (!err || !err.code) return 200;
  switch (err.code) {
    case MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER:
      return 401;
    case MICROVM_ERROR_TENANT_BINDING_VIOLATION:
      return 403;
    case MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE:
      return 404;
    case MICROVM_ERROR_CONTROLLER_INCOMPLETE:
      return 500;
    case MICROVM_ERROR_CONTROLLER_COMMAND_FAILED:
    case MICROVM_ERROR_PROVIDER_OPERATION_FAILED:
      return 502;
    default:
      return 400;
  }
}

function serializableMicroVMControllerResponse(
  response: MicroVMControllerResponse,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...response };
  if (response.error) {
    out["error"] = {
      code: response.error.code,
      message: response.error.message,
      request_id: response.error.request_id ?? "",
    };
  }
  return out;
}

function firstHeaderValueFromMap(headers: Headers, name: string): string {
  const key = String(name ?? "")
    .trim()
    .toLowerCase();
  const values = headers[key] ?? headers[String(name ?? "").trim()] ?? [];
  return String(values[0] ?? "").trim();
}

function firstQueryValue(query: Query, name: string): string {
  const values = query[String(name ?? "").trim()] ?? [];
  return String(values[0] ?? "").trim();
}

function stringFromPayload(
  payload: Record<string, unknown>,
  key: string,
): string {
  return String(payload[key] ?? "").trim();
}

function stringListFromPayload(
  payload: Record<string, unknown>,
  key: string,
): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return normalizeStringArray(value.map((item) => String(item ?? "")));
}

function intFromPayload(payload: Record<string, unknown>, key: string): number {
  return Math.trunc(Number(payload[key] ?? 0) || 0);
}

function positiveIntFromPayload(
  payload: Record<string, unknown>,
  key: string,
): number {
  const value = intFromPayload(payload, key);
  return value > 0 ? value : 0;
}

function positiveIntFromString(value: string): number {
  const parsed = Math.trunc(Number(String(value ?? "").trim()) || 0);
  return parsed > 0 ? parsed : 0;
}

function sessionSpecFromPayload(
  payload: Record<string, unknown>,
): MicroVMSessionSpec {
  const raw = payload["session_spec"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const metadata = (raw as Record<string, unknown>)["metadata"];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    out[String(key).trim()] = String(value ?? "");
  }
  return Object.keys(out).length > 0 ? { metadata: out } : {};
}

function idlePolicyFromPayload(
  payload: Record<string, unknown>,
): MicroVMProviderIdlePolicy | undefined {
  const raw = payload["idle_policy"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  return {
    auto_resume_enabled: record["auto_resume_enabled"] === true,
    max_idle_duration_seconds: Math.trunc(
      Number(record["max_idle_duration_seconds"] ?? 0) || 0,
    ),
    suspended_duration_seconds: Math.trunc(
      Number(record["suspended_duration_seconds"] ?? 0) || 0,
    ),
  };
}

function portScopesFromPayload(
  payload: Record<string, unknown>,
): MicroVMProviderPortScope[] {
  const raw = payload["allowed_port_scope"];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    )
    .map((scope) => ({
      all_ports: scope["all_ports"] === true,
      port: Math.trunc(Number(scope["port"] ?? 0) || 0),
      start_port: Math.trunc(Number(scope["start_port"] ?? 0) || 0),
      end_port: Math.trunc(Number(scope["end_port"] ?? 0) || 0),
    }));
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
      endpoint: "",
      microvm_id: "",
      provider_id: MICROVM_DEFAULT_SESSION_PROVIDER_ID,
      provider_microvm_id: input.session_id,
      provider_state: MicroVMState.Requested,
      aws_lifecycle_state: MicroVMState.Requested,
      image_ref: input.image_ref,
      network_connector_ref: input.network_connector_ref,
      controller_id: input.controller_id,
      created_at: now,
      updated_at: now,
      last_observed_at: now,
      expires_at: new Date(now.valueOf() + 60 * 60 * 1000),
      generation: 1,
      last_action: MicroVMCommand.Create,
      last_command_id: input.request_id,
      auth_subject: input.auth_subject,
    };
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
      endpoint: record.endpoint ?? "",
      microvm_id: record.microvm_id ?? "",
      last_action: record.last_action,
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
      provider_id: record.provider_id || MICROVM_DEFAULT_SESSION_PROVIDER_ID,
      provider_microvm_id: record.provider_microvm_id || record.session_id,
      provider_state: state,
      aws_lifecycle_state: state,
      controller_id: input.controller_id,
      auth_subject: input.auth_subject,
      last_action: command,
      last_command_id: input.request_id,
      updated_at: coalesceMicroVMTime(input.now, this.currentTime),
      last_observed_at: coalesceMicroVMTime(input.now, this.currentTime),
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

export class FakeMicroVMProvider implements MicroVMProvider {
  private currentTime: Date;
  private next = 0;
  private tokens = 0;
  private readonly sessions = new Map<string, MicroVMProviderSession>();
  private readonly errors = new Map<MicroVMOperationName, MicroVMSafeError>();
  private readonly recordedCalls: MicroVMProviderCall[] = [];

  constructor(now: Date = new Date(0)) {
    this.currentTime = coalesceMicroVMTime(now, new Date(0));
  }

  setNow(now: Date): void {
    if (validDate(now)) this.currentTime = new Date(now.valueOf());
  }

  setOperationError(
    operation: MicroVMOperationName | string,
    err: MicroVMSafeError | null = safeError(
      MICROVM_ERROR_PROVIDER_OPERATION_FAILED,
      "apptheory: microvm provider operation failed",
      "",
    ),
  ): void {
    const normalized = normalizeMicroVMOperation(operation);
    if (!isRequiredMicroVMOperation(normalized)) return;
    if (err == null) {
      this.errors.delete(normalized as MicroVMOperationName);
      return;
    }
    this.errors.set(normalized as MicroVMOperationName, err);
  }

  calls(): MicroVMProviderCall[] {
    return this.recordedCalls.map((call) => ({ ...call }));
  }

  async run(input: MicroVMProviderRunInput): Promise<MicroVMProviderSession> {
    const normalized = validateMicroVMProviderRunInputInternal(input);
    this.recordCall(
      MicroVMOperation.Run,
      normalized.request_id,
      normalized.tenant_id,
      normalized.namespace,
      normalized.session_id,
    );
    const configured = this.configuredError(
      MicroVMOperation.Run,
      normalized.request_id,
    );
    if (configured) throw configured;
    const key = microVMProviderSessionKeyString(
      normalized.tenant_id,
      normalized.namespace,
      normalized.session_id,
    );
    if (this.sessions.has(key)) {
      throw fakeMicroVMProviderError(normalized.request_id);
    }
    this.next += 1;
    const session: MicroVMProviderSession = {
      tenant_id: normalized.tenant_id,
      namespace: normalized.namespace,
      session_id: normalized.session_id,
      provider_microvm_id: `microvm-${String(this.next).padStart(6, "0")}`,
      state: MicroVMRealState.Running,
      provider_state: "running",
      image_ref: normalized.image_ref,
      terminal: false,
      registry_version: this.next,
      started_at: new Date(this.currentTime.valueOf()),
    };
    if (normalized.image_version)
      session.image_version = normalized.image_version;
    validateMicroVMProviderSession(session);
    this.sessions.set(key, cloneMicroVMProviderSession(session));
    return cloneMicroVMProviderSession(session);
  }

  async get(
    input: MicroVMProviderSessionInput,
  ): Promise<MicroVMProviderSession> {
    return this.lookup(MicroVMOperation.Get, input);
  }

  async list(
    input: MicroVMProviderListInput,
  ): Promise<MicroVMProviderListOutput> {
    const normalized = validateMicroVMProviderListInputInternal(input);
    this.recordCall(
      MicroVMOperation.List,
      normalized.request_id,
      normalized.tenant_id,
      normalized.namespace,
      "",
    );
    const configured = this.configuredError(
      MicroVMOperation.List,
      normalized.request_id,
    );
    if (configured) throw configured;
    const sessions = [...this.sessions.values()]
      .filter(
        (session) =>
          session.tenant_id === normalized.tenant_id &&
          session.namespace === normalized.namespace &&
          (!normalized.image_ref ||
            session.image_ref === normalized.image_ref) &&
          (!normalized.image_version ||
            session.image_version === normalized.image_version),
      )
      .sort((left, right) => left.session_id.localeCompare(right.session_id))
      .map(cloneMicroVMProviderSession);
    return { sessions };
  }

  async suspend(
    input: MicroVMProviderSessionInput,
  ): Promise<MicroVMProviderSession> {
    return this.transition(MicroVMOperation.Suspend, input, "suspended");
  }

  async resume(
    input: MicroVMProviderSessionInput,
  ): Promise<MicroVMProviderSession> {
    return this.transition(MicroVMOperation.Resume, input, "ready");
  }

  async terminate(
    input: MicroVMProviderSessionInput,
  ): Promise<MicroVMProviderSession> {
    return this.transition(MicroVMOperation.Terminate, input, "terminated");
  }

  async createAuthToken(
    input: MicroVMProviderTokenInput,
  ): Promise<MicroVMProviderToken> {
    return this.token(MicroVMOperation.AuthToken, input);
  }

  async createShellToken(
    input: MicroVMProviderTokenInput,
  ): Promise<MicroVMProviderToken> {
    return this.token(MicroVMOperation.ShellToken, input);
  }

  private async lookup(
    operation: MicroVMOperationName,
    input: MicroVMProviderSessionInput,
  ): Promise<MicroVMProviderSession> {
    const normalized = validateMicroVMProviderSessionInputInternal(
      operation,
      input,
    );
    this.recordCall(
      operation,
      normalized.request_id,
      normalized.tenant_id,
      normalized.namespace,
      normalized.binding.session_id,
    );
    const configured = this.configuredError(operation, normalized.request_id);
    if (configured) throw configured;
    return this.boundSession(normalized.request_id, normalized.binding);
  }

  private async transition(
    operation: MicroVMOperationName,
    input: MicroVMProviderSessionInput,
    providerState: string,
  ): Promise<MicroVMProviderSession> {
    const normalized = validateMicroVMProviderSessionInputInternal(
      operation,
      input,
    );
    this.recordCall(
      operation,
      normalized.request_id,
      normalized.tenant_id,
      normalized.namespace,
      normalized.binding.session_id,
    );
    const configured = this.configuredError(operation, normalized.request_id);
    if (configured) throw configured;
    const session = this.boundSession(
      normalized.request_id,
      normalized.binding,
    );
    const mapped = mapMicroVMProviderState(providerState);
    const next: MicroVMProviderSession = {
      ...session,
      provider_state: normalizeMicroVMProviderState(providerState),
      state: mapped.state,
      terminal: mapped.terminal,
      registry_version: Math.trunc(Number(session.registry_version ?? 0)) + 1,
    };
    if (providerState === "terminated") {
      next.terminated_at = new Date(this.currentTime.valueOf());
    }
    validateMicroVMProviderSession(next);
    this.sessions.set(
      microVMProviderSessionKeyString(
        next.tenant_id,
        next.namespace,
        next.session_id,
      ),
      cloneMicroVMProviderSession(next),
    );
    return cloneMicroVMProviderSession(next);
  }

  private async token(
    operation: MicroVMOperationName,
    input: MicroVMProviderTokenInput,
  ): Promise<MicroVMProviderToken> {
    const normalized = validateMicroVMProviderTokenInputInternal(
      operation,
      input,
    );
    this.recordCall(
      operation,
      normalized.request_id,
      normalized.tenant_id,
      normalized.namespace,
      normalized.binding.session_id,
    );
    const configured = this.configuredError(operation, normalized.request_id);
    if (configured) throw configured;
    this.boundSession(normalized.request_id, normalized.binding);
    const tokenType =
      operation === MicroVMOperation.ShellToken ? "shell" : "auth";
    const scope = microVMProviderTokenScope(
      operation,
      normalized.allowed_port_scope ?? [],
    );
    const ttl = normalized.ttl_seconds ?? defaultProviderTokenTTLSeconds;
    this.tokens += 1;
    const token: MicroVMProviderToken = {
      tenant_id: normalized.binding.tenant_id,
      namespace: normalized.binding.namespace,
      session_id: normalized.binding.session_id,
      provider_microvm_id: normalized.binding.provider_microvm_id,
      token_id: `${tokenType}-${String(this.tokens).padStart(6, "0")}`,
      token_type: tokenType,
      expires_at: new Date(this.currentTime.valueOf() + ttl * 1000),
      scope,
    };
    validateMicroVMProviderToken(token);
    return cloneMicroVMProviderToken(token);
  }

  private boundSession(
    requestID: string,
    binding: MicroVMProviderSessionBinding,
  ): MicroVMProviderSession {
    const key = microVMProviderSessionKeyString(
      binding.tenant_id,
      binding.namespace,
      binding.session_id,
    );
    const session = this.sessions.get(key);
    if (
      !session ||
      session.provider_microvm_id !== binding.provider_microvm_id
    ) {
      throw safeError(
        MICROVM_ERROR_TENANT_BINDING_VIOLATION,
        "apptheory: microvm provider binding is not available",
        requestID,
      );
    }
    return cloneMicroVMProviderSession(session);
  }

  private configuredError(
    operation: MicroVMOperationName,
    requestID: string,
  ): MicroVMSafeError | null {
    if (!this.errors.has(operation)) return null;
    return fakeMicroVMProviderError(requestID);
  }

  private recordCall(
    operation: MicroVMOperationName,
    requestID: string,
    tenantID: string,
    namespace: string,
    sessionID: string,
  ): void {
    this.recordedCalls.push({
      operation,
      request_id: String(requestID ?? "").trim(),
      tenant_id: String(tenantID ?? "").trim(),
      namespace: String(namespace ?? "").trim(),
      session_id: String(sessionID ?? "").trim(),
    });
  }
}

export function createFakeMicroVMProvider(
  now: Date = new Date(0),
): FakeMicroVMProvider {
  return new FakeMicroVMProvider(now);
}

export async function createAWSLambdaMicroVMClient(
  _options: AWSLambdaMicroVMClientOptions = {},
): Promise<MicroVMClient> {
  throw safeError(
    MICROVM_ERROR_CONTROLLER_INCOMPLETE,
    "apptheory: microvm legacy AWS session client is unsupported by the official Lambda MicroVM SDK",
    "",
  );
}

export class AWSLambdaMicroVMProvider implements MicroVMProvider {
  private readonly client: LambdaMicrovmsClient;
  private readonly clock: MicroVMClock;

  constructor(options: AWSLambdaMicroVMProviderOptions = {}) {
    const region = String(options.region ?? "").trim();
    this.client = new LambdaMicrovmsClient(region ? { region } : {});
    this.clock = options.clock ?? { now: () => new Date() };
  }

  async run(input: MicroVMProviderRunInput): Promise<MicroVMProviderSession> {
    const normalized = validateMicroVMProviderRunInputInternal(input);
    try {
      const commandInput: RunMicrovmCommandInput = {
        clientToken: normalized.request_id,
        imageIdentifier: normalized.image_ref,
        runHookPayload: safeMicroVMRunHookPayload(normalized),
      };
      const egress = providerEgressConnectorRefs(normalized);
      if (egress.length > 0) commandInput.egressNetworkConnectors = egress;
      if (normalized.execution_role_arn) {
        commandInput.executionRoleArn = normalized.execution_role_arn;
      }
      if ((normalized.ingress_network_connector_refs ?? []).length > 0) {
        commandInput.ingressNetworkConnectors = [
          ...(normalized.ingress_network_connector_refs ?? []),
        ];
      }
      if (normalized.image_version)
        commandInput.imageVersion = normalized.image_version;
      if (normalized.idle_policy) {
        commandInput.idlePolicy = {
          autoResumeEnabled: normalized.idle_policy.auto_resume_enabled,
          maxIdleDurationSeconds:
            normalized.idle_policy.max_idle_duration_seconds,
          suspendedDurationSeconds:
            normalized.idle_policy.suspended_duration_seconds,
        };
      }
      if ((normalized.maximum_duration_seconds ?? 0) > 0) {
        commandInput.maximumDurationInSeconds = Math.trunc(
          normalized.maximum_duration_seconds ?? 0,
        );
      }
      const output = await this.client.send(
        new RunMicrovmCommand(commandInput),
      );
      return microVMProviderSessionFromRunOutput(normalized, output);
    } catch (err) {
      throw asMicroVMProviderSafeError(err, normalized.request_id);
    }
  }

  async get(
    input: MicroVMProviderSessionInput,
  ): Promise<MicroVMProviderSession> {
    const normalized = validateMicroVMProviderSessionInputInternal(
      MicroVMOperation.Get,
      input,
    );
    try {
      const output = await this.client.send(
        new GetMicrovmCommand({
          microvmIdentifier: normalized.binding.provider_microvm_id,
        }),
      );
      return microVMProviderSessionFromGetOutput(
        normalized.request_id,
        normalized.binding,
        output,
      );
    } catch (err) {
      throw asMicroVMProviderSafeError(err, normalized.request_id);
    }
  }

  async list(
    input: MicroVMProviderListInput,
  ): Promise<MicroVMProviderListOutput> {
    const normalized = validateMicroVMProviderListInputInternal(input);
    try {
      const commandInput: ListMicrovmsCommandInput = {};
      if (normalized.image_ref)
        commandInput.imageIdentifier = normalized.image_ref;
      if (normalized.image_version)
        commandInput.imageVersion = normalized.image_version;
      if ((normalized.max_results ?? 0) > 0) {
        commandInput.maxResults = Math.trunc(normalized.max_results ?? 0);
      }
      const output = await this.client.send(
        new ListMicrovmsCommand(commandInput),
      );
      return microVMProviderListOutputFromSDK(normalized, output);
    } catch (err) {
      throw asMicroVMProviderSafeError(err, normalized.request_id);
    }
  }

  async suspend(
    input: MicroVMProviderSessionInput,
  ): Promise<MicroVMProviderSession> {
    return await this.runStateChangingOperation(
      MicroVMOperation.Suspend,
      input,
      async (providerID) => {
        await this.client.send(
          new SuspendMicrovmCommand({ microvmIdentifier: providerID }),
        );
      },
    );
  }

  async resume(
    input: MicroVMProviderSessionInput,
  ): Promise<MicroVMProviderSession> {
    return await this.runStateChangingOperation(
      MicroVMOperation.Resume,
      input,
      async (providerID) => {
        await this.client.send(
          new ResumeMicrovmCommand({ microvmIdentifier: providerID }),
        );
      },
    );
  }

  async terminate(
    input: MicroVMProviderSessionInput,
  ): Promise<MicroVMProviderSession> {
    return await this.runStateChangingOperation(
      MicroVMOperation.Terminate,
      input,
      async (providerID) => {
        await this.client.send(
          new TerminateMicrovmCommand({ microvmIdentifier: providerID }),
        );
      },
    );
  }

  async createAuthToken(
    input: MicroVMProviderTokenInput,
  ): Promise<MicroVMProviderToken> {
    const normalized = validateMicroVMProviderTokenInputInternal(
      MicroVMOperation.AuthToken,
      input,
    );
    try {
      const commandInput: CreateMicrovmAuthTokenCommandInput = {
        allowedPorts: awsMicroVMPortScopes(normalized.allowed_port_scope ?? []),
        expirationInMinutes: providerExpirationMinutes(
          normalized.ttl_seconds ?? defaultProviderTokenTTLSeconds,
        ),
        microvmIdentifier: normalized.binding.provider_microvm_id,
      };
      const output = await this.client.send(
        new CreateMicrovmAuthTokenCommand(commandInput),
      );
      ensureMicroVMProviderTokenResult(output, normalized.request_id);
      return microVMProviderTokenMetadata(
        MicroVMOperation.AuthToken,
        normalized,
        this.now(),
      );
    } catch (err) {
      throw asMicroVMProviderSafeError(err, normalized.request_id);
    }
  }

  async createShellToken(
    input: MicroVMProviderTokenInput,
  ): Promise<MicroVMProviderToken> {
    const normalized = validateMicroVMProviderTokenInputInternal(
      MicroVMOperation.ShellToken,
      input,
    );
    try {
      const commandInput: CreateMicrovmShellAuthTokenCommandInput = {
        expirationInMinutes: providerExpirationMinutes(
          normalized.ttl_seconds ?? defaultProviderTokenTTLSeconds,
        ),
        microvmIdentifier: normalized.binding.provider_microvm_id,
      };
      const output = await this.client.send(
        new CreateMicrovmShellAuthTokenCommand(commandInput),
      );
      ensureMicroVMProviderTokenResult(output, normalized.request_id);
      return microVMProviderTokenMetadata(
        MicroVMOperation.ShellToken,
        normalized,
        this.now(),
      );
    } catch (err) {
      throw asMicroVMProviderSafeError(err, normalized.request_id);
    }
  }

  private async runStateChangingOperation(
    operation: MicroVMOperationName,
    input: MicroVMProviderSessionInput,
    run: (providerID: string) => Promise<void>,
  ): Promise<MicroVMProviderSession> {
    const normalized = validateMicroVMProviderSessionInputInternal(
      operation,
      input,
    );
    try {
      await run(normalized.binding.provider_microvm_id);
      const output = await this.client.send(
        new GetMicrovmCommand({
          microvmIdentifier: normalized.binding.provider_microvm_id,
        }),
      );
      return microVMProviderSessionFromGetOutput(
        normalized.request_id,
        normalized.binding,
        output,
      );
    } catch (err) {
      throw asMicroVMProviderSafeError(err, normalized.request_id);
    }
  }

  private now(): Date {
    const now = this.clock.now();
    return validDate(now) ? new Date(now.valueOf()) : new Date(0);
  }
}

export function createAWSLambdaMicroVMProvider(
  options: AWSLambdaMicroVMProviderOptions = {},
): AWSLambdaMicroVMProvider {
  return new AWSLambdaMicroVMProvider(options);
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
  const normalized = String(command ?? "").trim();
  if (normalized === "shell-token") return MicroVMCommand.ShellAuthToken;
  return normalized as MicroVMCommandName | "";
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

function realMicroVMControllerCommands(): MicroVMCommandName[] {
  return [
    MicroVMCommand.Run,
    MicroVMCommand.Get,
    MicroVMCommand.List,
    MicroVMCommand.Suspend,
    MicroVMCommand.Resume,
    MicroVMCommand.Terminate,
    MicroVMCommand.AuthToken,
    MicroVMCommand.ShellAuthToken,
  ];
}

function isRequiredMicroVMCommand(
  command: string,
): command is MicroVMCommandName {
  return (requiredMicroVMControllerCommands() as string[]).includes(command);
}

function validMicroVMCommand(command: string): boolean {
  const normalized = normalizeMicroVMCommand(command);
  return (
    requiredMicroVMControllerCommands().includes(
      normalized as MicroVMCommandName,
    ) ||
    realMicroVMControllerCommands().includes(normalized as MicroVMCommandName)
  );
}

function requiredMicroVMSessionRegistryContractFields(): string[] {
  // Keep the original M15 vocabulary fixture compatible; durable TableTheory
  // keys/TTL are enforced by registry-record validation and runner coverage.
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
  ];
}

function validMicroVMLifecycleState(state: string): boolean {
  const legacy = normalizeMicroVMLifecycleState(state);
  const real = normalizeMicroVMRealLifecycleState(state);
  return (
    requiredMicroVMLifecycleStates().includes(
      legacy as MicroVMLifecycleState,
    ) ||
    requiredMicroVMRealLifecycleStates().includes(
      real as MicroVMRealLifecycleState,
    )
  );
}

type NormalizedMicroVMControllerRequest = {
  command: MicroVMCommandName | string;
  request_id: string;
  tenant_id: string;
  namespace: string;
  auth_context: MicroVMAuthContext;
  session_id: string;
  image_ref: string;
  image_version: string;
  network_connector_ref: string;
  ingress_network_connector_refs: string[];
  egress_network_connector_refs: string[];
  session_spec: MicroVMSessionSpec;
  idle_policy?: MicroVMProviderIdlePolicy;
  maximum_duration_seconds: number;
  ttl_seconds: number;
  allowed_port_scope: MicroVMProviderPortScope[];
  max_results: number;
};

function normalizeMicroVMControllerRequest(
  request: MicroVMControllerRequest,
): NormalizedMicroVMControllerRequest {
  const out: NormalizedMicroVMControllerRequest = {
    command: normalizeMicroVMCommand(request.command),
    request_id: String(request.request_id ?? "").trim(),
    tenant_id: String(request.tenant_id ?? "").trim(),
    namespace: String(request.namespace ?? "").trim(),
    auth_context: normalizeMicroVMAuthContext(request.auth_context ?? {}),
    session_id: String(request.session_id ?? "").trim(),
    image_ref: String(request.image_ref ?? "").trim(),
    image_version: String(request.image_version ?? "").trim(),
    network_connector_ref: String(request.network_connector_ref ?? "").trim(),
    ingress_network_connector_refs: normalizeStringArray(
      request.ingress_network_connector_refs ?? [],
    ),
    egress_network_connector_refs: normalizeStringArray(
      request.egress_network_connector_refs ?? [],
    ),
    session_spec: cloneMicroVMSessionSpec(request.session_spec ?? {}),
    maximum_duration_seconds: Math.trunc(
      Number(request.maximum_duration_seconds ?? 0) || 0,
    ),
    ttl_seconds: Math.trunc(Number(request.ttl_seconds ?? 0) || 0),
    allowed_port_scope: [...(request.allowed_port_scope ?? [])],
    max_results: Math.trunc(Number(request.max_results ?? 0) || 0),
  };
  if (request.idle_policy) {
    out.idle_policy = {
      auto_resume_enabled: request.idle_policy.auto_resume_enabled === true,
      max_idle_duration_seconds: Math.trunc(
        Number(request.idle_policy.max_idle_duration_seconds) || 0,
      ),
      suspended_duration_seconds: Math.trunc(
        Number(request.idle_policy.suspended_duration_seconds) || 0,
      ),
    };
  }
  return out;
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
    endpoint: normalized.endpoint ?? "",
    microvm_id: normalized.microvm_id ?? "",
    last_action: normalized.last_action,
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
    endpoint: normalized.endpoint ?? "",
    microvm_id: normalized.microvm_id ?? "",
    last_action: normalized.last_action,
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
    endpoint: String(record.endpoint ?? "").trim(),
    microvm_id: String(record.microvm_id ?? "").trim(),
    provider_id: String(record.provider_id ?? "").trim(),
    provider_microvm_id: String(record.provider_microvm_id ?? "").trim(),
    provider_state: String(record.provider_state ?? "").trim(),
    aws_lifecycle_state: String(record.aws_lifecycle_state ?? "").trim(),
    image_ref: String(record.image_ref ?? "").trim(),
    image_version: String(record.image_version ?? "").trim(),
    network_connector_ref: String(record.network_connector_ref ?? "").trim(),
    ingress_network_connector_refs: normalizeStringArray(
      record.ingress_network_connector_refs ?? [],
    ),
    egress_network_connector_refs: normalizeStringArray(
      record.egress_network_connector_refs ?? [],
    ),
    controller_id: String(record.controller_id ?? "").trim(),
    created_at: cloneMicroVMDate(record.created_at),
    updated_at: cloneMicroVMDate(record.updated_at),
    last_observed_at: cloneMicroVMDate(record.last_observed_at),
    provider_started_at: cloneMicroVMDate(
      record.provider_started_at ?? new Date(Number.NaN),
    ),
    provider_terminated_at: cloneMicroVMDate(
      record.provider_terminated_at ?? new Date(Number.NaN),
    ),
    expires_at: cloneMicroVMDate(record.expires_at),
    generation: Math.trunc(Number(record.generation) || 0),
    last_action: normalizeMicroVMCommand(record.last_action),
    last_command_id: String(record.last_command_id ?? "").trim(),
    auth_subject: String(record.auth_subject ?? "").trim(),
  };
  const reasonMetadata = cloneStringMap(record.reason_metadata);
  if (reasonMetadata) out.reason_metadata = reasonMetadata;
  const statusMetadata = cloneStringMap(record.status_metadata);
  if (statusMetadata) out.status_metadata = statusMetadata;
  const tokenMetadata = cloneMicroVMSessionTokenMetadataList(
    record.token_metadata,
  );
  if (tokenMetadata) out.token_metadata = tokenMetadata;
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
    endpoint: String(status.endpoint ?? "").trim(),
    microvm_id: String(status.microvm_id ?? "").trim(),
    last_action: normalizeMicroVMCommand(status.last_action),
    last_transition: cloneMicroVMDate(status.last_transition),
    registry_version: Math.trunc(Number(status.registry_version) || 0),
  };
}

function cloneMicroVMSessionRecord(
  record: MicroVMSessionRecord,
): MicroVMSessionRecord {
  return normalizeMicroVMSessionRecord(record);
}

function normalizeMicroVMSessionRegistryRecord(
  record: MicroVMSessionRegistryRecord,
): MicroVMSessionRegistryRecord {
  const out: MicroVMSessionRegistryRecord = {
    pk: String(record.pk ?? "").trim(),
    sk: String(record.sk ?? "").trim(),
    tenant_id: String(record.tenant_id ?? "").trim(),
    namespace: String(record.namespace ?? "").trim(),
    session_id: String(record.session_id ?? "").trim(),
    state: normalizeMicroVMLifecycleState(record.state),
    desired_state: normalizeMicroVMLifecycleState(record.desired_state),
    endpoint: String(record.endpoint ?? "").trim(),
    microvm_id: String(record.microvm_id ?? "").trim(),
    provider_id: String(record.provider_id ?? "").trim(),
    provider_microvm_id: String(record.provider_microvm_id ?? "").trim(),
    provider_state: String(record.provider_state ?? "").trim(),
    aws_lifecycle_state: String(record.aws_lifecycle_state ?? "").trim(),
    image_ref: String(record.image_ref ?? "").trim(),
    image_version: String(record.image_version ?? "").trim(),
    network_connector_ref: String(record.network_connector_ref ?? "").trim(),
    ingress_network_connector_refs: normalizeStringArray(
      record.ingress_network_connector_refs ?? [],
    ),
    egress_network_connector_refs: normalizeStringArray(
      record.egress_network_connector_refs ?? [],
    ),
    controller_id: String(record.controller_id ?? "").trim(),
    created_at: cloneMicroVMDate(record.created_at),
    updated_at: cloneMicroVMDate(record.updated_at),
    last_observed_at: cloneMicroVMDate(record.last_observed_at),
    provider_started_at: cloneMicroVMDate(record.provider_started_at),
    provider_terminated_at: cloneMicroVMDate(record.provider_terminated_at),
    expires_at: cloneMicroVMDate(record.expires_at),
    ttl: Math.trunc(Number(record.ttl) || 0),
    generation: Math.trunc(Number(record.generation) || 0),
    version: Math.trunc(Number(record.version) || 0),
    last_action: normalizeMicroVMCommand(record.last_action),
    last_command_id: String(record.last_command_id ?? "").trim(),
    auth_subject: String(record.auth_subject ?? "").trim(),
  };
  const reasonMetadata = cloneStringMap(record.reason_metadata);
  if (reasonMetadata) out.reason_metadata = reasonMetadata;
  const statusMetadata = cloneStringMap(record.status_metadata);
  if (statusMetadata) out.status_metadata = statusMetadata;
  const tokenMetadata = cloneMicroVMSessionTokenMetadataList(
    record.token_metadata,
  );
  if (tokenMetadata) out.token_metadata = tokenMetadata;
  const metadata = cloneStringMap(record.metadata);
  if (metadata) out.metadata = metadata;
  return out;
}

function cloneMicroVMSessionRegistryRecord(
  record: MicroVMSessionRegistryRecord,
): MicroVMSessionRegistryRecord {
  return normalizeMicroVMSessionRegistryRecord(record);
}

function normalizeMicroVMSessionTokenMetadata(
  token: MicroVMSessionTokenMetadata,
): MicroVMSessionTokenMetadata {
  return {
    token_id: String(token.token_id ?? "").trim(),
    token_type: String(token.token_type ?? "").trim(),
    expires_at: cloneMicroVMDate(token.expires_at),
    scope: normalizeStringArray(token.scope ?? []),
  };
}

function cloneMicroVMSessionTokenMetadataList(
  tokens: MicroVMSessionTokenMetadata[] | undefined,
): MicroVMSessionTokenMetadata[] | undefined {
  const out = (tokens ?? [])
    .map((token) => normalizeMicroVMSessionTokenMetadata(token))
    .filter(
      (token) =>
        token.token_id ||
        token.token_type ||
        validDate(token.expires_at) ||
        token.scope.length > 0,
    );
  return out.length > 0 ? out : undefined;
}

function microVMSessionFromRegistryRecordNoValidate(
  record: MicroVMSessionRegistryRecord,
): MicroVMSessionRecord {
  const out: MicroVMSessionRecord = {
    tenant_id: record.tenant_id,
    namespace: record.namespace,
    session_id: record.session_id,
    state: record.state,
    desired_state: record.desired_state,
    endpoint: record.endpoint,
    microvm_id: record.microvm_id,
    provider_id: record.provider_id,
    provider_microvm_id: record.provider_microvm_id,
    provider_state: record.provider_state,
    aws_lifecycle_state: record.aws_lifecycle_state,
    image_ref: record.image_ref,
    image_version: record.image_version,
    network_connector_ref: record.network_connector_ref,
    ingress_network_connector_refs: [...record.ingress_network_connector_refs],
    egress_network_connector_refs: [...record.egress_network_connector_refs],
    controller_id: record.controller_id,
    created_at: cloneMicroVMDate(record.created_at),
    updated_at: cloneMicroVMDate(record.updated_at),
    last_observed_at: cloneMicroVMDate(record.last_observed_at),
    provider_started_at: cloneMicroVMDate(record.provider_started_at),
    provider_terminated_at: cloneMicroVMDate(record.provider_terminated_at),
    expires_at: cloneMicroVMDate(record.expires_at),
    generation: record.generation,
    last_action: record.last_action,
    last_command_id: record.last_command_id,
    auth_subject: record.auth_subject,
  };
  const reasonMetadata = cloneStringMap(record.reason_metadata);
  if (reasonMetadata) out.reason_metadata = reasonMetadata;
  const statusMetadata = cloneStringMap(record.status_metadata);
  if (statusMetadata) out.status_metadata = statusMetadata;
  const tokenMetadata = cloneMicroVMSessionTokenMetadataList(
    record.token_metadata,
  );
  if (tokenMetadata) out.token_metadata = tokenMetadata;
  const metadata = cloneStringMap(record.metadata);
  if (metadata) out.metadata = metadata;
  return out;
}

function normalizeMicroVMSessionKey(key: MicroVMSessionKey): MicroVMSessionKey {
  return {
    tenant_id: String(key.tenant_id ?? "").trim(),
    namespace: String(key.namespace ?? "").trim(),
    session_id: String(key.session_id ?? "").trim(),
  };
}

function normalizeMicroVMSessionReconstructionRequest(
  request: MicroVMSessionReconstructionRequest,
): MicroVMSessionReconstructionRequest {
  const out: MicroVMSessionReconstructionRequest = {
    request_id: String(request.request_id ?? "").trim(),
    tenant_id: String(request.tenant_id ?? "").trim(),
    namespace: String(request.namespace ?? "").trim(),
    session_id: String(request.session_id ?? "").trim(),
    auth_subject: String(request.auth_subject ?? "").trim(),
  };
  const now = cloneMicroVMDate(request.now ?? new Date(Number.NaN));
  if (validDate(now)) out.now = now;
  if (request.existing)
    out.existing = normalizeMicroVMSessionRecord(request.existing);
  return out;
}

function validateMicroVMSessionKey(key: MicroVMSessionKey): void {
  if (!key.tenant_id || !key.namespace || !key.session_id) {
    throw safeError(
      MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
      "apptheory: microvm session key is incomplete",
      "",
    );
  }
}

function microVMSessionRegistryRecordKey(
  record: MicroVMSessionRegistryRecord,
): string {
  return `${record.pk}\u0000${record.sk}`;
}

function microVMSessionRegistryRecordKeyFromKey(
  key: MicroVMSessionKey,
): string {
  return `${microVMSessionRegistryPartitionKey(key.tenant_id, key.namespace)}\u0000${microVMSessionRegistrySortKey(key.session_id)}`;
}

function microVMSessionRecordIsStale(
  record: MicroVMSessionRecord,
  now: Date,
  staleAfterMs: number,
): boolean {
  if (staleAfterMs <= 0 || !validDate(now)) return false;
  const normalized = normalizeMicroVMSessionRecord(record);
  if (!validDate(normalized.last_observed_at)) return true;
  return (
    normalized.last_observed_at.valueOf() + staleAfterMs < now.valueOf() ||
    normalized.expires_at.valueOf() <= now.valueOf()
  );
}

function registryRecordToTableItem(
  record: MicroVMSessionRegistryRecord,
): Record<string, unknown> {
  const normalized = normalizeMicroVMSessionRegistryRecord(record);
  const out: Record<string, unknown> = {
    pk: normalized.pk,
    sk: normalized.sk,
    tenant_id: normalized.tenant_id,
    namespace: normalized.namespace,
    session_id: normalized.session_id,
    state: normalized.state,
    desired_state: normalized.desired_state,
    endpoint: normalized.endpoint,
    microvm_id: normalized.microvm_id,
    provider_id: normalized.provider_id,
    provider_microvm_id: normalized.provider_microvm_id,
    provider_state: normalized.provider_state,
    aws_lifecycle_state: normalized.aws_lifecycle_state,
    image_ref: normalized.image_ref,
    image_version: normalized.image_version,
    network_connector_ref: normalized.network_connector_ref,
    ingress_network_connector_refs: [
      ...normalized.ingress_network_connector_refs,
    ],
    egress_network_connector_refs: [
      ...normalized.egress_network_connector_refs,
    ],
    controller_id: normalized.controller_id,
    created_at: normalized.created_at.toISOString(),
    updated_at: normalized.updated_at.toISOString(),
    last_observed_at: normalized.last_observed_at.toISOString(),
    provider_started_at: validDate(normalized.provider_started_at)
      ? normalized.provider_started_at.toISOString()
      : "",
    provider_terminated_at: validDate(normalized.provider_terminated_at)
      ? normalized.provider_terminated_at.toISOString()
      : "",
    expires_at: normalized.expires_at.toISOString(),
    ttl: normalized.ttl,
    generation: normalized.generation,
    version: normalized.version,
    last_action: normalized.last_action,
    last_command_id: normalized.last_command_id,
    auth_subject: normalized.auth_subject,
  };
  const reasonMetadata = cloneStringMap(normalized.reason_metadata);
  if (reasonMetadata) out["reason_metadata"] = reasonMetadata;
  const statusMetadata = cloneStringMap(normalized.status_metadata);
  if (statusMetadata) out["status_metadata"] = statusMetadata;
  const tokenMetadata = cloneMicroVMSessionTokenMetadataList(
    normalized.token_metadata,
  );
  if (tokenMetadata) out["token_metadata"] = tokenMetadata;
  const metadata = cloneStringMap(normalized.metadata);
  if (metadata) out["metadata"] = metadata;
  return out;
}

function registryRecordFromTableItem(
  item: Record<string, unknown>,
): MicroVMSessionRegistryRecord {
  const record: MicroVMSessionRegistryRecord = {
    pk: stringRecordField(item, "pk"),
    sk: stringRecordField(item, "sk"),
    tenant_id: stringRecordField(item, "tenant_id"),
    namespace: stringRecordField(item, "namespace"),
    session_id: stringRecordField(item, "session_id"),
    state: stringRecordField(item, "state"),
    desired_state: stringRecordField(item, "desired_state"),
    endpoint: stringRecordField(item, "endpoint"),
    microvm_id: stringRecordField(item, "microvm_id"),
    provider_id: stringRecordField(item, "provider_id"),
    provider_microvm_id: stringRecordField(item, "provider_microvm_id"),
    provider_state: stringRecordField(item, "provider_state"),
    aws_lifecycle_state: stringRecordField(item, "aws_lifecycle_state"),
    image_ref: stringRecordField(item, "image_ref"),
    image_version: stringRecordField(item, "image_version"),
    network_connector_ref: stringRecordField(item, "network_connector_ref"),
    ingress_network_connector_refs: recordStringListField(
      item,
      "ingress_network_connector_refs",
    ),
    egress_network_connector_refs: recordStringListField(
      item,
      "egress_network_connector_refs",
    ),
    controller_id: stringRecordField(item, "controller_id"),
    created_at: dateRecordField(item, "created_at"),
    updated_at: dateRecordField(item, "updated_at"),
    last_observed_at: dateRecordField(item, "last_observed_at"),
    provider_started_at: dateRecordField(item, "provider_started_at"),
    provider_terminated_at: dateRecordField(item, "provider_terminated_at"),
    expires_at: dateRecordField(item, "expires_at"),
    ttl: numberRecordField(item, "ttl"),
    generation: numberRecordField(item, "generation"),
    version: numberRecordField(item, "version"),
    last_action: stringRecordField(item, "last_action"),
    last_command_id: stringRecordField(item, "last_command_id"),
    auth_subject: stringRecordField(item, "auth_subject"),
  };
  const reasonMetadata = recordMapField(item, "reason_metadata");
  if (reasonMetadata) record.reason_metadata = reasonMetadata;
  const statusMetadata = recordMapField(item, "status_metadata");
  if (statusMetadata) record.status_metadata = statusMetadata;
  const tokenMetadata = recordTokenMetadataField(item, "token_metadata");
  if (tokenMetadata) record.token_metadata = tokenMetadata;
  const metadata = recordMapField(item, "metadata");
  if (metadata) record.metadata = metadata;
  return record;
}

function asMicroVMSessionRegistryError(
  err: unknown,
  requestID: string,
): MicroVMSafeError {
  if (err instanceof MicroVMSafeError) {
    return err.request_id ? err : safeError(err.code, err.message, requestID);
  }
  return safeError(
    MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
    "apptheory: microvm session registry operation failed",
    requestID,
  );
}

function stringRecordField(item: Record<string, unknown>, key: string): string {
  return String(item[key] ?? "").trim();
}

function numberRecordField(item: Record<string, unknown>, key: string): number {
  const raw = Number(item[key] ?? 0);
  return Number.isFinite(raw) ? Math.trunc(raw) : 0;
}

function dateRecordField(item: Record<string, unknown>, key: string): Date {
  return cloneMicroVMDateFromUnknown(item[key]);
}

function recordMapField(
  item: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const raw = item[key];
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? cloneStringMap(raw as Record<string, string>)
    : undefined;
}

function recordStringListField(
  item: Record<string, unknown>,
  key: string,
): string[] {
  const raw = item[key];
  return Array.isArray(raw) ? normalizeStringArray(raw.map(String)) : [];
}

function recordTokenMetadataField(
  item: Record<string, unknown>,
  key: string,
): MicroVMSessionTokenMetadata[] | undefined {
  const raw = item[key];
  if (!Array.isArray(raw)) return undefined;
  return cloneMicroVMSessionTokenMetadataList(
    raw.map((item) => {
      const value =
        item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : {};
      return {
        token_id: stringRecordField(value, "token_id"),
        token_type: stringRecordField(value, "token_type"),
        expires_at: dateRecordField(value, "expires_at"),
        scope: recordStringListField(value, "scope"),
      };
    }),
  );
}

function cloneMicroVMDateFromUnknown(value: unknown): Date {
  if (value instanceof Date) {
    return cloneMicroVMDate(value);
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (validDate(parsed)) return parsed;
  }
  return new Date(Number.NaN);
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

const defaultProviderTokenTTLSeconds = 900;
const minProviderTokenTTLSeconds = 1;
const maxProviderTokenTTLSeconds = 900;

function validateMicroVMProviderRunInputInternal(
  input: MicroVMProviderRunInput,
): MicroVMProviderRunInput {
  const normalized = normalizeMicroVMProviderRunInput(input);
  validateMicroVMProviderOperation(MicroVMOperation.Run, normalized.request_id);
  validateMicroVMProviderAccess(
    normalized.request_id,
    normalized.tenant_id,
    normalized.namespace,
    normalized.auth_context,
  );
  if (!normalized.request_id) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider request_id is required",
      "",
    );
  }
  if (!normalized.session_id || !normalized.image_ref) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider run requires session_id and image_ref",
      normalized.request_id,
    );
  }
  if (
    forbiddenMicroVMFieldName(normalized.image_ref) ||
    forbiddenMicroVMFieldName(normalized.image_version ?? "")
  ) {
    throw safeError(
      MICROVM_ERROR_FORBIDDEN_FIELD,
      "apptheory: microvm provider run exposes forbidden field",
      normalized.request_id,
    );
  }
  const metadataError = validateSafeMicroVMMetadata(
    normalized.session_spec?.metadata,
    normalized.request_id,
  );
  if (metadataError) throw metadataError;
  validateSafeMicroVMConnectorRefs(normalized.request_id, [
    normalized.network_connector_ref ?? "",
    ...(normalized.ingress_network_connector_refs ?? []),
    ...(normalized.egress_network_connector_refs ?? []),
  ]);
  const executionRoleErr = validateMicroVMExecutionRoleArn(
    normalized.execution_role_arn ?? "",
    normalized.request_id,
  );
  if (executionRoleErr) throw executionRoleErr;
  const policy = normalized.idle_policy;
  if (
    policy &&
    (policy.max_idle_duration_seconds <= 0 ||
      policy.suspended_duration_seconds <= 0)
  ) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider idle policy is incomplete",
      normalized.request_id,
    );
  }
  if ((normalized.maximum_duration_seconds ?? 0) < 0) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider maximum duration is invalid",
      normalized.request_id,
    );
  }
  return normalized;
}

function validateMicroVMProviderSessionInputInternal(
  operation: MicroVMOperationName | string,
  input: MicroVMProviderSessionInput,
): MicroVMProviderSessionInput {
  const normalized = normalizeMicroVMProviderSessionInput(input);
  const normalizedOperation = normalizeMicroVMOperation(operation);
  validateMicroVMProviderOperation(normalizedOperation, normalized.request_id);
  if (!normalized.request_id) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider request_id is required",
      "",
    );
  }
  validateMicroVMProviderAccess(
    normalized.request_id,
    normalized.tenant_id,
    normalized.namespace,
    normalized.auth_context,
  );
  normalized.binding = validateMicroVMProviderBinding(
    normalized.request_id,
    normalized.tenant_id,
    normalized.namespace,
    normalized.binding,
  );
  return normalized;
}

function validateMicroVMProviderListInputInternal(
  input: MicroVMProviderListInput,
): MicroVMProviderListInput {
  const normalized = normalizeMicroVMProviderListInput(input);
  validateMicroVMProviderOperation(
    MicroVMOperation.List,
    normalized.request_id,
  );
  if (!normalized.request_id) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider request_id is required",
      "",
    );
  }
  validateMicroVMProviderAccess(
    normalized.request_id,
    normalized.tenant_id,
    normalized.namespace,
    normalized.auth_context,
  );
  if (
    forbiddenMicroVMFieldName(normalized.image_ref ?? "") ||
    forbiddenMicroVMFieldName(normalized.image_version ?? "")
  ) {
    throw safeError(
      MICROVM_ERROR_FORBIDDEN_FIELD,
      "apptheory: microvm provider list exposes forbidden field",
      normalized.request_id,
    );
  }
  normalized.known_sessions = (normalized.known_sessions ?? []).map((binding) =>
    validateMicroVMProviderBinding(
      normalized.request_id,
      normalized.tenant_id,
      normalized.namespace,
      binding,
    ),
  );
  if ((normalized.max_results ?? 0) < 0) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider list max_results is invalid",
      normalized.request_id,
    );
  }
  return normalized;
}

function validateMicroVMProviderTokenInputInternal(
  operation: MicroVMOperationName | string,
  input: MicroVMProviderTokenInput,
): MicroVMProviderTokenInput {
  const normalized = normalizeMicroVMProviderTokenInput(input);
  const normalizedOperation = normalizeMicroVMOperation(operation);
  validateMicroVMProviderOperation(normalizedOperation, normalized.request_id);
  if (!normalized.request_id) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider request_id is required",
      "",
    );
  }
  if (
    normalizedOperation !== MicroVMOperation.AuthToken &&
    normalizedOperation !== MicroVMOperation.ShellToken
  ) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED,
      "apptheory: microvm provider token operation is unsupported",
      normalized.request_id,
    );
  }
  validateMicroVMProviderAccess(
    normalized.request_id,
    normalized.tenant_id,
    normalized.namespace,
    normalized.auth_context,
  );
  normalized.binding = validateMicroVMProviderBinding(
    normalized.request_id,
    normalized.tenant_id,
    normalized.namespace,
    normalized.binding,
  );
  const ttl = normalized.ttl_seconds ?? 0;
  normalized.ttl_seconds = ttl === 0 ? defaultProviderTokenTTLSeconds : ttl;
  if (
    normalized.ttl_seconds < minProviderTokenTTLSeconds ||
    normalized.ttl_seconds > maxProviderTokenTTLSeconds
  ) {
    throw safeError(
      MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
      "apptheory: microvm provider token ttl exceeds contract bounds",
      normalized.request_id,
    );
  }
  if (
    normalizedOperation === MicroVMOperation.AuthToken &&
    (normalized.allowed_port_scope ?? []).length === 0
  ) {
    throw safeError(
      MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
      "apptheory: microvm auth token requires an explicit allowed port scope",
      normalized.request_id,
    );
  }
  for (const scope of normalized.allowed_port_scope ?? []) {
    validateMicroVMProviderPortScope(scope, normalized.request_id);
  }
  return normalized;
}

function validateMicroVMProviderOperation(
  operation: MicroVMOperationName | string,
  requestID: string,
): void {
  if (!isRequiredMicroVMOperation(operation)) {
    throw safeError(
      MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED,
      "apptheory: microvm provider operation is unsupported",
      requestID,
    );
  }
}

function validateMicroVMProviderAccess(
  requestID: string,
  tenantID: string,
  namespace: string,
  auth: MicroVMAuthContext,
): void {
  const normalizedAuth = normalizeMicroVMAuthContext(auth);
  if (!String(tenantID ?? "").trim() || !String(namespace ?? "").trim()) {
    throw safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm provider request requires tenant and namespace",
      requestID,
    );
  }
  if (!normalizedAuth.subject || !normalizedAuth.tenant_id) {
    throw safeError(
      MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
      "apptheory: microvm provider request requires authenticated context",
      requestID,
    );
  }
  if (normalizedAuth.tenant_id !== String(tenantID ?? "").trim()) {
    throw safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm provider auth context is cross-tenant",
      requestID,
    );
  }
  if (
    normalizedAuth.namespace &&
    normalizedAuth.namespace !== String(namespace ?? "").trim()
  ) {
    throw safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm provider auth context is cross-namespace",
      requestID,
    );
  }
  const metadataError = validateSafeMicroVMMetadata(
    normalizedAuth.metadata,
    requestID,
  );
  if (metadataError) throw metadataError;
}

function validateMicroVMProviderBinding(
  requestID: string,
  tenantID: string,
  namespace: string,
  binding: MicroVMProviderSessionBinding,
): MicroVMProviderSessionBinding {
  const normalized = normalizeMicroVMProviderBinding(binding);
  if (
    !normalized.tenant_id ||
    !normalized.namespace ||
    !normalized.session_id ||
    !normalized.provider_microvm_id
  ) {
    throw safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm provider binding is incomplete",
      requestID,
    );
  }
  if (
    normalized.tenant_id !== String(tenantID ?? "").trim() ||
    normalized.namespace !== String(namespace ?? "").trim()
  ) {
    throw safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm provider binding is cross-tenant",
      requestID,
    );
  }
  if (forbiddenMicroVMFieldName(normalized.provider_microvm_id)) {
    throw safeError(
      MICROVM_ERROR_FORBIDDEN_FIELD,
      "apptheory: microvm provider binding exposes forbidden field",
      requestID,
    );
  }
  return normalized;
}

function validateMicroVMProviderPortScope(
  scope: MicroVMProviderPortScope,
  requestID: string,
): void {
  let options = 0;
  if (scope.all_ports === true) options += 1;
  if ((scope.port ?? 0) > 0) options += 1;
  if ((scope.start_port ?? 0) > 0 || (scope.end_port ?? 0) > 0) {
    options += 1;
    if (
      (scope.start_port ?? 0) <= 0 ||
      (scope.end_port ?? 0) <= 0 ||
      (scope.start_port ?? 0) > (scope.end_port ?? 0)
    ) {
      throw safeError(
        MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
        "apptheory: microvm provider token port range is invalid",
        requestID,
      );
    }
  }
  if (options !== 1) {
    throw safeError(
      MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
      "apptheory: microvm provider token port scope must specify exactly one scope",
      requestID,
    );
  }
}

function validateSafeMicroVMConnectorRefs(
  requestID: string,
  refs: string[],
): void {
  for (const ref of refs) {
    if (forbiddenMicroVMFieldName(ref)) {
      throw safeError(
        MICROVM_ERROR_FORBIDDEN_FIELD,
        "apptheory: microvm provider connector exposes forbidden field",
        requestID,
      );
    }
  }
}

function validateMicroVMExecutionRoleArn(
  value: string,
  requestID: string,
): MicroVMSafeError | null {
  const arn = normalizeMicroVMExecutionRoleArn(value);
  if (!arn) return null;
  const safeErr = validateSafeMicroVMFieldValue(arn, requestID);
  if (safeErr) return safeErr;
  if (/\s/.test(arn) || !arn.startsWith("arn:") || !arn.includes(":role/")) {
    return safeError(
      MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
      "apptheory: microvm provider execution role arn is invalid",
      requestID,
    );
  }
  return null;
}

function normalizeMicroVMExecutionRoleArn(value: string): string {
  return String(value ?? "").trim();
}

function environmentMicroVMExecutionRoleArn(): string {
  if (typeof process === "undefined") return "";
  return normalizeMicroVMExecutionRoleArn(
    process.env?.[MICROVM_ENV_EXECUTION_ROLE_ARN] ?? "",
  );
}

function normalizeMicroVMProviderRunInput(
  input: MicroVMProviderRunInput,
): MicroVMProviderRunInput {
  const out: MicroVMProviderRunInput = {
    request_id: String(input.request_id ?? "").trim(),
    tenant_id: String(input.tenant_id ?? "").trim(),
    namespace: String(input.namespace ?? "").trim(),
    session_id: String(input.session_id ?? "").trim(),
    auth_context: normalizeMicroVMAuthContext(input.auth_context ?? {}),
    image_ref: String(input.image_ref ?? "").trim(),
    session_spec: cloneMicroVMSessionSpec(input.session_spec ?? {}),
  };
  const imageVersion = String(input.image_version ?? "").trim();
  if (imageVersion) out.image_version = imageVersion;
  const networkConnectorRef = String(input.network_connector_ref ?? "").trim();
  if (networkConnectorRef) out.network_connector_ref = networkConnectorRef;
  const ingress = normalizeStringArray(
    input.ingress_network_connector_refs ?? [],
  );
  if (ingress.length > 0) out.ingress_network_connector_refs = ingress;
  const egress = normalizeStringArray(
    input.egress_network_connector_refs ?? [],
  );
  if (egress.length > 0) out.egress_network_connector_refs = egress;
  if (input.idle_policy) {
    out.idle_policy = {
      auto_resume_enabled: input.idle_policy.auto_resume_enabled === true,
      max_idle_duration_seconds: Math.trunc(
        Number(input.idle_policy.max_idle_duration_seconds) || 0,
      ),
      suspended_duration_seconds: Math.trunc(
        Number(input.idle_policy.suspended_duration_seconds) || 0,
      ),
    };
  }
  if (input.maximum_duration_seconds !== undefined) {
    out.maximum_duration_seconds = Math.trunc(
      Number(input.maximum_duration_seconds) || 0,
    );
  }
  const executionRoleArn = normalizeMicroVMExecutionRoleArn(
    input.execution_role_arn ?? "",
  );
  if (executionRoleArn) out.execution_role_arn = executionRoleArn;
  return out;
}

function normalizeMicroVMProviderSessionInput(
  input: MicroVMProviderSessionInput,
): MicroVMProviderSessionInput {
  return {
    request_id: String(input.request_id ?? "").trim(),
    tenant_id: String(input.tenant_id ?? "").trim(),
    namespace: String(input.namespace ?? "").trim(),
    auth_context: normalizeMicroVMAuthContext(input.auth_context ?? {}),
    binding: normalizeMicroVMProviderBinding(input.binding ?? {}),
  };
}

function normalizeMicroVMProviderListInput(
  input: MicroVMProviderListInput,
): MicroVMProviderListInput {
  const out: MicroVMProviderListInput = {
    request_id: String(input.request_id ?? "").trim(),
    tenant_id: String(input.tenant_id ?? "").trim(),
    namespace: String(input.namespace ?? "").trim(),
    auth_context: normalizeMicroVMAuthContext(input.auth_context ?? {}),
  };
  const imageRef = String(input.image_ref ?? "").trim();
  if (imageRef) out.image_ref = imageRef;
  const imageVersion = String(input.image_version ?? "").trim();
  if (imageVersion) out.image_version = imageVersion;
  if (input.max_results !== undefined) {
    out.max_results = Math.trunc(Number(input.max_results) || 0);
  }
  const known = (input.known_sessions ?? []).map(
    normalizeMicroVMProviderBinding,
  );
  if (known.length > 0) out.known_sessions = known;
  return out;
}

function normalizeMicroVMProviderTokenInput(
  input: MicroVMProviderTokenInput,
): MicroVMProviderTokenInput {
  const out: MicroVMProviderTokenInput = {
    request_id: String(input.request_id ?? "").trim(),
    tenant_id: String(input.tenant_id ?? "").trim(),
    namespace: String(input.namespace ?? "").trim(),
    auth_context: normalizeMicroVMAuthContext(input.auth_context ?? {}),
    binding: normalizeMicroVMProviderBinding(input.binding ?? {}),
  };
  if (input.ttl_seconds !== undefined) {
    out.ttl_seconds = Math.trunc(Number(input.ttl_seconds) || 0);
  }
  const scopes = (input.allowed_port_scope ?? []).map((scope) => ({
    all_ports: scope.all_ports === true,
    port: Math.trunc(Number(scope.port) || 0),
    start_port: Math.trunc(Number(scope.start_port) || 0),
    end_port: Math.trunc(Number(scope.end_port) || 0),
  }));
  if (scopes.length > 0) out.allowed_port_scope = scopes;
  return out;
}

function normalizeMicroVMProviderBinding(
  binding: Partial<MicroVMProviderSessionBinding>,
): MicroVMProviderSessionBinding {
  const out: MicroVMProviderSessionBinding = {
    tenant_id: String(binding.tenant_id ?? "").trim(),
    namespace: String(binding.namespace ?? "").trim(),
    session_id: String(binding.session_id ?? "").trim(),
    provider_microvm_id: String(binding.provider_microvm_id ?? "").trim(),
  };
  if (binding.registry_version !== undefined) {
    out.registry_version = Math.trunc(Number(binding.registry_version) || 0);
  }
  return out;
}

function normalizeMicroVMProviderSession(
  session: MicroVMProviderSession,
): MicroVMProviderSession {
  const out: MicroVMProviderSession = {
    tenant_id: String(session.tenant_id ?? "").trim(),
    namespace: String(session.namespace ?? "").trim(),
    session_id: String(session.session_id ?? "").trim(),
    provider_microvm_id: String(session.provider_microvm_id ?? "").trim(),
    state: normalizeMicroVMRealLifecycleState(session.state),
    provider_state: normalizeMicroVMProviderState(session.provider_state),
    terminal: session.terminal === true,
  };
  const imageRef = String(session.image_ref ?? "").trim();
  if (imageRef) out.image_ref = imageRef;
  const imageVersion = String(session.image_version ?? "").trim();
  if (imageVersion) out.image_version = imageVersion;
  if (validDate(session.started_at as Date)) {
    out.started_at = cloneMicroVMDate(session.started_at as Date);
  }
  if (validDate(session.terminated_at as Date)) {
    out.terminated_at = cloneMicroVMDate(session.terminated_at as Date);
  }
  if (session.registry_version !== undefined) {
    out.registry_version = Math.trunc(Number(session.registry_version) || 0);
  }
  return out;
}

function normalizeMicroVMProviderToken(
  token: MicroVMProviderToken,
): MicroVMProviderToken {
  return {
    tenant_id: String(token.tenant_id ?? "").trim(),
    namespace: String(token.namespace ?? "").trim(),
    session_id: String(token.session_id ?? "").trim(),
    provider_microvm_id: String(token.provider_microvm_id ?? "").trim(),
    token_id: String(token.token_id ?? "").trim(),
    token_type: String(token.token_type ?? "").trim(),
    expires_at: cloneMicroVMDate(token.expires_at),
    scope: normalizeStringArray(token.scope ?? []),
  };
}

function cloneMicroVMProviderSession(
  session: MicroVMProviderSession,
): MicroVMProviderSession {
  return normalizeMicroVMProviderSession(session);
}

function cloneMicroVMProviderToken(
  token: MicroVMProviderToken,
): MicroVMProviderToken {
  return normalizeMicroVMProviderToken(token);
}

function normalizeStringArray(values: string[]): string[] {
  return values.map((value) => String(value ?? "").trim()).filter(Boolean);
}

function microVMProviderSessionKeyString(
  tenantID: string,
  namespace: string,
  sessionID: string,
): string {
  return `${String(tenantID ?? "").trim()}\u0000${String(namespace ?? "").trim()}\u0000${String(sessionID ?? "").trim()}`;
}

function providerEgressConnectorRefs(input: MicroVMProviderRunInput): string[] {
  return normalizeStringArray([
    ...(input.egress_network_connector_refs ?? []),
    input.network_connector_ref ?? "",
  ]);
}

function safeMicroVMRunHookPayload(input: MicroVMProviderRunInput): string {
  return JSON.stringify({
    request_id: input.request_id,
    tenant_id: input.tenant_id,
    namespace: input.namespace,
    session_id: input.session_id,
  });
}

function microVMProviderSessionFromRunOutput(
  input: MicroVMProviderRunInput,
  output: unknown,
): MicroVMProviderSession {
  const binding: MicroVMProviderSessionBinding = {
    tenant_id: input.tenant_id,
    namespace: input.namespace,
    session_id: input.session_id,
    provider_microvm_id: stringField(output, "microvmId"),
  };
  return microVMProviderSessionFromProviderState(
    binding,
    stringField(output, "state"),
    stringField(output, "imageArn") || input.image_ref,
    stringField(output, "imageVersion") || input.image_version || "",
    dateField(output, "startedAt"),
    dateField(output, "terminatedAt"),
  );
}

function microVMProviderSessionFromGetOutput(
  requestID: string,
  binding: MicroVMProviderSessionBinding,
  output: unknown,
): MicroVMProviderSession {
  const providerID = stringField(output, "microvmId");
  if (providerID && providerID !== binding.provider_microvm_id) {
    throw safeError(
      MICROVM_ERROR_TENANT_BINDING_VIOLATION,
      "apptheory: microvm provider returned mismatched session binding",
      requestID,
    );
  }
  return microVMProviderSessionFromProviderState(
    binding,
    stringField(output, "state"),
    stringField(output, "imageArn"),
    stringField(output, "imageVersion"),
    dateField(output, "startedAt"),
    dateField(output, "terminatedAt"),
  );
}

function microVMProviderListOutputFromSDK(
  input: MicroVMProviderListInput,
  output: unknown,
): MicroVMProviderListOutput {
  const bindings = new Map<string, MicroVMProviderSessionBinding>();
  for (const binding of input.known_sessions ?? []) {
    bindings.set(binding.provider_microvm_id, binding);
  }
  const sessions: MicroVMProviderSession[] = [];
  for (const item of arrayField(output, "items")) {
    const providerID = stringField(item, "microvmId");
    const binding = bindings.get(providerID);
    if (!binding) continue;
    sessions.push(
      microVMProviderSessionFromProviderState(
        binding,
        stringField(item, "state"),
        stringField(item, "imageArn"),
        stringField(item, "imageVersion"),
        dateField(item, "startedAt"),
        null,
      ),
    );
  }
  return { sessions };
}

function microVMProviderSessionFromProviderState(
  binding: MicroVMProviderSessionBinding,
  providerState: string,
  imageRef: string,
  imageVersion: string,
  startedAt: Date | null,
  terminatedAt: Date | null,
): MicroVMProviderSession {
  const mapped = mapMicroVMProviderState(providerState);
  const session: MicroVMProviderSession = {
    tenant_id: binding.tenant_id,
    namespace: binding.namespace,
    session_id: binding.session_id,
    provider_microvm_id: binding.provider_microvm_id,
    state: mapped.state,
    provider_state: normalizeMicroVMProviderState(providerState),
    terminal: mapped.terminal,
  };
  const cleanImageRef = String(imageRef ?? "").trim();
  if (cleanImageRef) session.image_ref = cleanImageRef;
  const cleanImageVersion = String(imageVersion ?? "").trim();
  if (cleanImageVersion) session.image_version = cleanImageVersion;
  if (startedAt && validDate(startedAt)) session.started_at = startedAt;
  if (terminatedAt && validDate(terminatedAt))
    session.terminated_at = terminatedAt;
  if (binding.registry_version !== undefined) {
    session.registry_version = Math.trunc(
      Number(binding.registry_version) || 0,
    );
  }
  validateMicroVMProviderSession(session);
  return session;
}

function awsMicroVMPortScopes(
  scopes: MicroVMProviderPortScope[],
): NonNullable<CreateMicrovmAuthTokenCommandInput["allowedPorts"]> {
  return scopes.map((scope) => {
    if (scope.all_ports === true) return { allPorts: {} };
    if ((scope.port ?? 0) > 0) return { port: Math.trunc(scope.port ?? 0) };
    return {
      range: {
        endPort: Math.trunc(scope.end_port ?? 0),
        startPort: Math.trunc(scope.start_port ?? 0),
      },
    };
  });
}

function ensureMicroVMProviderTokenResult(
  output: unknown,
  requestID: string,
): void {
  const authToken = asRecord(output)["authToken"];
  if (
    !authToken ||
    typeof authToken !== "object" ||
    Array.isArray(authToken) ||
    Object.keys(authToken).length === 0
  ) {
    throw safeError(
      MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
      "apptheory: microvm provider returned incomplete token metadata",
      requestID,
    );
  }
}

function microVMProviderTokenMetadata(
  operation: MicroVMOperationName,
  input: MicroVMProviderTokenInput,
  now: Date,
): MicroVMProviderToken {
  const tokenType =
    operation === MicroVMOperation.ShellToken ? "shell" : "auth";
  const ttl = input.ttl_seconds ?? defaultProviderTokenTTLSeconds;
  const expiresAt = new Date(now.valueOf() + ttl * 1000);
  const scope = microVMProviderTokenScope(
    operation,
    input.allowed_port_scope ?? [],
  );
  const token: MicroVMProviderToken = {
    tenant_id: input.binding.tenant_id,
    namespace: input.binding.namespace,
    session_id: input.binding.session_id,
    provider_microvm_id: input.binding.provider_microvm_id,
    token_id: safeMicroVMProviderTokenID(
      input.binding,
      tokenType,
      expiresAt,
      scope,
    ),
    token_type: tokenType,
    expires_at: expiresAt,
    scope,
  };
  validateMicroVMProviderToken(token);
  return token;
}

function microVMProviderTokenScope(
  operation: MicroVMOperationName,
  scopes: MicroVMProviderPortScope[],
): string[] {
  if (operation === MicroVMOperation.ShellToken) return ["shell"];
  return scopes
    .map((scope) => {
      if (scope.all_ports === true) return "ports:*";
      if ((scope.port ?? 0) > 0) return `ports:${Math.trunc(scope.port ?? 0)}`;
      return `ports:${Math.trunc(scope.start_port ?? 0)}-${Math.trunc(scope.end_port ?? 0)}`;
    })
    .sort();
}

function safeMicroVMProviderTokenID(
  binding: MicroVMProviderSessionBinding,
  tokenType: string,
  expiresAt: Date,
  scope: string[],
): string {
  const parts = [
    binding.tenant_id,
    binding.namespace,
    binding.session_id,
    binding.provider_microvm_id,
    tokenType,
    formatMicroVMProviderDate(expiresAt),
    ...scope,
  ];
  const digest = createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  return `${tokenType}-${digest}`;
}

function formatMicroVMProviderDate(value: Date): string {
  const iso = value.toISOString();
  return iso.endsWith(".000Z") ? `${iso.slice(0, -5)}Z` : iso;
}

function providerExpirationMinutes(ttlSeconds: number): number {
  return Math.ceil(ttlSeconds / 60);
}

function fakeMicroVMProviderError(requestID: string): MicroVMSafeError {
  return safeError(
    MICROVM_ERROR_PROVIDER_OPERATION_FAILED,
    "apptheory: microvm provider operation failed",
    requestID,
  );
}

function asMicroVMProviderSafeError(
  err: unknown,
  requestID: string,
): MicroVMSafeError {
  if (err instanceof MicroVMSafeError) {
    return err.request_id ? err : safeError(err.code, err.message, requestID);
  }
  return fakeMicroVMProviderError(requestID);
}

function arrayField(value: unknown, key: string): unknown[] {
  const raw = asRecord(value)[key];
  return Array.isArray(raw) ? raw : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown, key: string): string {
  return String(asRecord(value)[key] ?? "").trim();
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
