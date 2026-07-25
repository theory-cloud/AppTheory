import {
  MICROVM_AWS_LAMBDA_PROVIDER_ID,
  MICROVM_ENV_EGRESS_NETWORK_CONNECTOR_REFS,
  MICROVM_ERROR_CONTROLLER_COMMAND_FAILED,
  MICROVM_ERROR_CONTROLLER_INCOMPLETE,
  MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
  MICROVM_ENV_IMAGE_REF,
  MICROVM_ENV_INGRESS_NETWORK_CONNECTOR_REFS,
  MICROVM_ENV_NETWORK_CONNECTOR_REFS,
  MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
  MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
  MicroVMCommand,
  MicroVMOperation,
  MicroVMRealState,
  MicroVMSafeError,
  MicroVMState,
  type MicroVMAuthContext,
  type MicroVMClock,
  type MicroVMClient,
  type MicroVMCommandName,
  type MicroVMControllerDeploymentDefaults,
  type MicroVMControllerInvokeRequest,
  type MicroVMControllerOptions,
  type MicroVMControllerRequest,
  type MicroVMControllerResponse,
  type MicroVMControllerRouteTarget,
  type MicroVMIDGenerator,
  type MicroVMLifecycleState,
  type MicroVMOperationName,
  type MicroVMProvider,
  type MicroVMProviderIdlePolicy,
  type MicroVMProviderPortScope,
  type MicroVMProviderInvokeOutput,
  type MicroVMProviderLogging,
  type MicroVMProviderRunInput,
  type MicroVMProviderSession,
  type MicroVMProviderSessionBinding,
  type MicroVMProviderSessionInput,
  type MicroVMProviderToken,
  type MicroVMProviderTokenInput,
  type MicroVMRealLifecycleState,
  type MicroVMSessionCommandInput,
  type MicroVMSessionQueryInput,
  type MicroVMSessionRecord,
  type MicroVMSessionRegistry,
  type MicroVMSessionSpec,
  type MicroVMSessionStatus,
} from "./model.js";
import { safeError } from "./errors.js";
import { normalizeMicroVMCommand } from "./controller-contract.js";
import {
  mapMicroVMProviderState,
  normalizeMicroVMOperation,
  normalizeMicroVMRealLifecycleState,
  requiredMicroVMRealLifecycleStates,
} from "./operation-contract.js";
import {
  cloneMicroVMProviderSession,
  environmentMicroVMProviderLogging,
  environmentMicroVMExecutionRoleArn,
  microVMProviderSessionKeyString,
  normalizeMicroVMExecutionRoleArn,
  normalizeMicroVMProviderInvokeInput,
  normalizeMicroVMProviderLogging,
  normalizeMicroVMProviderInvokePath,
  normalizeMicroVMProviderSession,
  normalizeMicroVMProviderToken,
  sanitizeMicroVMProviderInvokeHeaders,
  normalizeStringArray,
  validateMicroVMExecutionRoleArn,
  validateMicroVMProviderLogging,
  validateMicroVMProviderSession,
  validateMicroVMProviderToken,
} from "./provider.js";
import {
  cloneMicroVMSessionTokenMetadataList,
  microVMSessionTokenMetadataFromProviderToken,
  normalizeMicroVMSessionRecord,
  normalizeMicroVMSessionStatus,
  validateMicroVMSessionRecord,
  validateMicroVMSessionStatus,
} from "./session.js";
import {
  cloneStringMap,
  validateSafeMicroVMFieldValue,
  validateSafeMicroVMMetadata,
} from "./safety.js";
import { cloneMicroVMDate, randomMicroVMSessionID, validDate } from "./time.js";
import {
  normalizeMicroVMLifecycleState,
  requiredMicroVMLifecycleStates,
} from "./lifecycle.js";

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

export class MicroVMRealController implements MicroVMControllerRouteTarget {
  private readonly provider: MicroVMProvider;
  private readonly registry: MicroVMSessionRegistry;
  private readonly controllerID: string;
  private readonly providerID: string;
  private readonly executionRoleArn: string;
  private readonly logging: MicroVMProviderLogging;
  private readonly deploymentDefaults: Required<MicroVMControllerDeploymentDefaults>;
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
    const configuredLogging =
      options.logging ?? environmentMicroVMProviderLogging();
    const loggingErr = validateMicroVMProviderLogging(
      configuredLogging,
      this.executionRoleArn,
      "",
    );
    if (loggingErr) {
      throw safeError(
        MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
        "apptheory: microvm runtime logging configuration is invalid",
        "",
      );
    }
    this.logging = normalizeMicroVMProviderLogging(configuredLogging);
    this.deploymentDefaults = normalizeMicroVMControllerDeploymentDefaults(
      options.deployment_defaults ??
        environmentMicroVMControllerDeploymentDefaults(),
    );
    this.clock = options.clock ?? { now: () => new Date() };
    this.ids = options.ids ?? { newID: () => randomMicroVMSessionID() };
    const ttlMs = Math.trunc(Number(options.ttl_ms) || 0);
    this.ttlMs = ttlMs > 0 ? ttlMs : 60 * 60 * 1000;
  }

  async handle(
    request: MicroVMControllerRequest,
  ): Promise<MicroVMControllerResponse> {
    const requestEnvelope = normalizeMicroVMControllerRequest(request);
    const deploymentOverrideErr = this.deploymentOverrideError(requestEnvelope);
    if (deploymentOverrideErr) {
      return controllerErrorResponse(requestEnvelope, deploymentOverrideErr);
    }
    const normalized = this.applyDeploymentDefaults(requestEnvelope);
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

  async invoke(
    request: MicroVMControllerInvokeRequest,
  ): Promise<MicroVMProviderInvokeOutput> {
    const normalized = normalizeMicroVMControllerInvokeRequest(request);
    const envelope = normalizeMicroVMControllerRequest({
      command: MicroVMCommand.Invoke,
      request_id: normalized.request_id,
      tenant_id: normalized.tenant_id,
      namespace: normalized.namespace,
      auth_context: normalized.auth_context,
      session_id: normalized.session_id,
    });
    const validationErr = validateMicroVMRealControllerRequest(envelope);
    if (validationErr) throw validationErr;
    const record = await this.registry.get({
      tenant_id: normalized.tenant_id,
      namespace: normalized.namespace,
      session_id: normalized.session_id,
    });
    validateMicroVMSessionRecord(record);
    if (!String(record.endpoint ?? "").trim()) {
      throw safeError(
        MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
        "apptheory: microvm invoke requires a session endpoint",
        normalized.request_id,
      );
    }
    return await this.provider.invoke(
      normalizeMicroVMProviderInvokeInput({
        request_id: normalized.request_id,
        tenant_id: normalized.tenant_id,
        namespace: normalized.namespace,
        auth_context: normalized.auth_context,
        binding: microVMProviderBindingFromRecord(record),
        endpoint: record.endpoint ?? "",
        method: normalized.method,
        path: normalized.path,
        query: normalized.query,
        headers: sanitizeMicroVMProviderInvokeHeaders(normalized.headers ?? {}),
        body: normalized.body,
        port: normalized.port,
        ttl_seconds: normalized.ttl_seconds,
      }),
    );
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
        logging: normalizeMicroVMProviderLogging(this.logging),
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

  private applyDeploymentDefaults(
    request: NormalizedMicroVMControllerRequest,
  ): NormalizedMicroVMControllerRequest {
    const defaults = this.deploymentDefaults;
    const out: NormalizedMicroVMControllerRequest = {
      ...request,
      image_ref: request.image_ref || defaults.image_ref,
      ingress_network_connector_refs:
        request.ingress_network_connector_refs.length > 0
          ? [...request.ingress_network_connector_refs]
          : [...defaults.ingress_network_connector_refs],
      egress_network_connector_refs:
        request.egress_network_connector_refs.length > 0
          ? [...request.egress_network_connector_refs]
          : [...defaults.egress_network_connector_refs],
      network_connector_ref:
        request.network_connector_ref || defaults.network_connector_ref,
    };
    if (
      !out.network_connector_ref &&
      out.egress_network_connector_refs.length
    ) {
      out.network_connector_ref = out.egress_network_connector_refs[0] ?? "";
    }
    return normalizeMicroVMControllerRequest(out);
  }

  private deploymentOverrideError(
    request: NormalizedMicroVMControllerRequest,
  ): MicroVMSafeError | undefined {
    const defaults = this.deploymentDefaults;
    if (
      defaults.image_ref &&
      request.image_ref &&
      request.image_ref !== defaults.image_ref
    ) {
      return safeError(
        MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
        "apptheory: microvm deployment-pinned image_ref mismatch",
        request.request_id,
      );
    }
    if (
      defaults.network_connector_ref &&
      request.network_connector_ref &&
      request.network_connector_ref !== defaults.network_connector_ref
    ) {
      return safeError(
        MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
        "apptheory: microvm deployment-pinned network_connector_ref mismatch",
        request.request_id,
      );
    }
    if (
      defaults.ingress_network_connector_refs.length > 0 &&
      request.ingress_network_connector_refs.length > 0 &&
      !equalStringArrays(
        request.ingress_network_connector_refs,
        defaults.ingress_network_connector_refs,
      )
    ) {
      return safeError(
        MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
        "apptheory: microvm deployment-pinned ingress_network_connector_refs mismatch",
        request.request_id,
      );
    }
    if (
      defaults.egress_network_connector_refs.length > 0 &&
      request.egress_network_connector_refs.length > 0 &&
      !equalStringArrays(
        request.egress_network_connector_refs,
        defaults.egress_network_connector_refs,
      )
    ) {
      return safeError(
        MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
        "apptheory: microvm deployment-pinned egress_network_connector_refs mismatch",
        request.request_id,
      );
    }
    return undefined;
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
      endpoint: session.endpoint || current?.endpoint || "",
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

export function validateMicroVMRealControllerRequest(
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
    case MicroVMCommand.Invoke:
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

export function microVMCommandFromOperation(
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
    case MicroVMOperation.Invoke:
      return MicroVMCommand.Invoke;
    case MicroVMOperation.AuthToken:
      return MicroVMCommand.AuthToken;
    case MicroVMOperation.ShellAuthToken:
      return MicroVMCommand.ShellAuthToken;
    default:
      return normalizeMicroVMCommand(String(operation)) as MicroVMCommandName;
  }
}

export function desiredStateForMicroVMRealCommand(
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

export function microVMProviderBindingFromRecord(
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

export function microVMProviderSessionFromRegistryRecord(
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
  if (normalized.endpoint) session.endpoint = normalized.endpoint;
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

export function responseFromMicroVMProviderSession(
  request: NormalizedMicroVMControllerRequest,
  session: MicroVMProviderSession,
): MicroVMControllerResponse {
  const normalized = normalizeMicroVMProviderSession(session);
  const response: MicroVMControllerResponse = {
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
  if (normalized.endpoint) response.endpoint = normalized.endpoint;
  return response;
}

export function responseFromMicroVMProviderToken(
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

export function validMicroVMLifecycleState(state: string): boolean {
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

export type NormalizedMicroVMControllerRequest = {
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

export type NormalizedMicroVMControllerInvokeRequest = {
  request_id: string;
  tenant_id: string;
  namespace: string;
  auth_context: MicroVMAuthContext;
  session_id: string;
  method: string;
  path: string;
  query: Record<string, string[]>;
  headers: Record<string, string[]>;
  body: Uint8Array;
  port: number;
  ttl_seconds: number;
};

export function normalizeMicroVMControllerRequest(
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

export function normalizeMicroVMControllerInvokeRequest(
  request: MicroVMControllerInvokeRequest,
): NormalizedMicroVMControllerInvokeRequest {
  return {
    request_id: String(request.request_id ?? "").trim(),
    tenant_id: String(request.tenant_id ?? "").trim(),
    namespace: String(request.namespace ?? "").trim(),
    auth_context: normalizeMicroVMAuthContext(request.auth_context ?? {}),
    session_id: String(request.session_id ?? "").trim(),
    method: String(request.method ?? "")
      .trim()
      .toUpperCase(),
    path: normalizeMicroVMProviderInvokePath(request.path ?? "/"),
    query: cloneControllerInvokeQuery(request.query ?? {}),
    headers: sanitizeMicroVMProviderInvokeHeaders(request.headers ?? {}),
    body: request.body ? new Uint8Array(request.body) : new Uint8Array(),
    port: Math.trunc(Number(request.port ?? 8080) || 0) || 8080,
    ttl_seconds: Math.trunc(Number(request.ttl_seconds ?? 60) || 0) || 60,
  };
}

export function normalizeMicroVMControllerDeploymentDefaults(
  defaults: MicroVMControllerDeploymentDefaults = {},
): Required<MicroVMControllerDeploymentDefaults> {
  const egress = normalizeStringArray(
    defaults.egress_network_connector_refs ?? [],
  );
  const out: Required<MicroVMControllerDeploymentDefaults> = {
    image_ref: String(defaults.image_ref ?? "").trim(),
    network_connector_ref: String(defaults.network_connector_ref ?? "").trim(),
    ingress_network_connector_refs: normalizeStringArray(
      defaults.ingress_network_connector_refs ?? [],
    ),
    egress_network_connector_refs: egress,
  };
  if (!out.network_connector_ref && out.egress_network_connector_refs.length) {
    out.network_connector_ref = out.egress_network_connector_refs[0] ?? "";
  }
  return out;
}

export function environmentMicroVMControllerDeploymentDefaults(): Required<MicroVMControllerDeploymentDefaults> {
  const legacy = splitMicroVMControllerDeploymentRefs(
    process.env?.[MICROVM_ENV_NETWORK_CONNECTOR_REFS] ?? "",
  );
  const configuredEgress = splitMicroVMControllerDeploymentRefs(
    process.env?.[MICROVM_ENV_EGRESS_NETWORK_CONNECTOR_REFS] ?? "",
  );
  const egress = configuredEgress.length > 0 ? configuredEgress : legacy;
  return normalizeMicroVMControllerDeploymentDefaults({
    image_ref: process.env?.[MICROVM_ENV_IMAGE_REF] ?? "",
    network_connector_ref: legacy[0] ?? "",
    ingress_network_connector_refs: splitMicroVMControllerDeploymentRefs(
      process.env?.[MICROVM_ENV_INGRESS_NETWORK_CONNECTOR_REFS] ?? "",
    ),
    egress_network_connector_refs: egress,
  });
}

function splitMicroVMControllerDeploymentRefs(value: string): string[] {
  return normalizeStringArray(String(value ?? "").split(","));
}

function equalStringArrays(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function cloneControllerInvokeQuery(
  query: Record<string, string[] | undefined>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [rawKey, rawValues] of Object.entries(query ?? {})) {
    const key = String(rawKey ?? "").trim();
    if (!key) continue;
    out[key] = (rawValues ?? []).map((value) => String(value ?? "").trim());
  }
  return out;
}

export function normalizeMicroVMAuthContext(
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

export function cloneMicroVMSessionSpec(
  spec: MicroVMSessionSpec,
): MicroVMSessionSpec {
  const out: MicroVMSessionSpec = {};
  const metadata = cloneStringMap(spec.metadata);
  if (metadata) out.metadata = metadata;
  return out;
}

export function controllerQueryInput(
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

export function responseFromMicroVMSession(
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

export function responseFromMicroVMStatus(
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

export function controllerErrorResponse(
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

export function asMicroVMSafeError(
  err: unknown,
  requestID: string,
): MicroVMSafeError {
  if (err instanceof MicroVMSafeError) {
    return err.request_id ? err : safeError(err.code, err.message, requestID);
  }
  return safeError(
    MICROVM_ERROR_CONTROLLER_COMMAND_FAILED,
    "apptheory: microvm controller command failed",
    requestID,
  );
}
