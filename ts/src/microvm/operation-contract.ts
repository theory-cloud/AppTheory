import {
  MICROVM_CONTROLLER_AUTH_DEFAULT_DENY,
  MICROVM_ERROR_FORBIDDEN_FIELD,
  MICROVM_ERROR_OPERATION_CONTRACT_INCOMPLETE,
  MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
  MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
  MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE,
  MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
  MICROVM_ERROR_TENANT_BINDING_VIOLATION,
  MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
  MicroVMHook,
  MicroVMOperation,
  MicroVMRealHook,
  MicroVMRealState,
  type MicroVMLifecycleContract,
  type MicroVMLifecycleHook,
  type MicroVMLifecycleHookSpec,
  type MicroVMLifecycleState,
  type MicroVMLifecycleTransition,
  type MicroVMOperationContract,
  type MicroVMOperationHTTPRouteContract,
  type MicroVMOperationName,
  type MicroVMProviderStateMapping,
  type MicroVMRealLifecycleHook,
  type MicroVMRealLifecycleState,
  type MicroVMTenantBindingRule,
  type MicroVMTokenIssuanceContract,
} from "./model.js";
import { safeError } from "./errors.js";
import {
  type MicroVMTransitionSet,
  microVMTransitionSet,
} from "./lifecycle.js";
import { forbiddenMicroVMFieldName, missingStrings } from "./safety.js";

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

export function validateMicroVMRealLifecycleHookSpecs(
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

export function validateMicroVMRealLifecycleStateLists(
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

export function validateMicroVMRealLifecycleTransitionSet(
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

export function requiredMicroVMRealTransitionsForHook(
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

export function validateMicroVMOperationVocabulary(
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

export function validateMicroVMOperationRoutes(
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

export function validateMicroVMProviderStateMappings(
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

export function validateMicroVMTokenIssuanceContracts(
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

export function validateMicroVMTenantBindingRules(
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

export function validateMicroVMForbiddenFieldCatalog(fields: string[]): void {
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

export function validateSafeMicroVMResultFields(fields: string[]): void {
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

export function requiredMicroVMOperations(): MicroVMOperationName[] {
  return [
    MicroVMOperation.Run,
    MicroVMOperation.Get,
    MicroVMOperation.List,
    MicroVMOperation.Suspend,
    MicroVMOperation.Resume,
    MicroVMOperation.Terminate,
    MicroVMOperation.Invoke,
    MicroVMOperation.AuthToken,
    MicroVMOperation.ShellToken,
  ];
}

export function requiredMicroVMRealLifecycleHooks(): MicroVMRealLifecycleHook[] {
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

export function requiredMicroVMRealLifecycleStates(): MicroVMRealLifecycleState[] {
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

export function validMicroVMRealLifecycleState(state: string): boolean {
  return requiredMicroVMRealLifecycleStates().includes(
    normalizeMicroVMRealLifecycleState(state) as MicroVMRealLifecycleState,
  );
}

export function normalizeMicroVMOperation(
  operation: MicroVMOperationName | string,
): MicroVMOperationName | "" {
  const normalized = String(operation ?? "").trim();
  if (normalized === "shell-token") return MicroVMOperation.ShellAuthToken;
  return normalized as MicroVMOperationName | "";
}

export function normalizeMicroVMRealLifecycleHook(
  hook: MicroVMLifecycleHook | string,
): MicroVMRealLifecycleHook | "" {
  return String(hook ?? "").trim() as MicroVMRealLifecycleHook | "";
}

export function normalizeMicroVMRealLifecycleState(
  state: MicroVMLifecycleState | string,
): MicroVMRealLifecycleState | "" {
  return String(state ?? "").trim() as MicroVMRealLifecycleState | "";
}

export function normalizeMicroVMProviderState(state: string): string {
  return String(state ?? "")
    .trim()
    .toLowerCase();
}

export function isRequiredMicroVMOperation(operation: string): boolean {
  return requiredMicroVMOperations().includes(
    normalizeMicroVMOperation(operation) as MicroVMOperationName,
  );
}

export function requiredMicroVMOperationRoute(
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
    case MicroVMOperation.Invoke:
      return microVMOperationRoute(
        operation,
        "ANY",
        "/microvms/{session_id}/invoke/{proxy+}",
        ["tenant_id", "namespace", "session_id", "method", "path", "port"],
        ["status", "headers", "body"],
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

export function microVMOperationRoute(
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

export function requiredMicroVMTokenIssuance(
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
