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

import {
  MICROVM_ERROR_CONTROLLER_INCOMPLETE,
  MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
  MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
  MICROVM_ERROR_TENANT_BINDING_VIOLATION,
  MicroVMOperation,
  type AWSLambdaMicroVMClientOptions,
  type AWSLambdaMicroVMProviderOptions,
  type MicroVMClient,
  type MicroVMClock,
  type MicroVMOperationName,
  type MicroVMProvider,
  type MicroVMProviderListInput,
  type MicroVMProviderListOutput,
  type MicroVMProviderInvokeInput,
  type MicroVMProviderInvokeOutput,
  type MicroVMProviderPortScope,
  type MicroVMProviderRunInput,
  type MicroVMProviderSession,
  type MicroVMProviderSessionBinding,
  type MicroVMProviderSessionInput,
  type MicroVMProviderToken,
  type MicroVMProviderTokenInput,
} from "./model.js";
import { safeError } from "./errors.js";
import {
  mapMicroVMProviderState,
  normalizeMicroVMProviderState,
} from "./operation-contract.js";
import {
  asMicroVMProviderSafeError,
  defaultProviderTokenTTLSeconds,
  microVMProviderTokenMetadata,
  maxProviderInvokeBodyBytes,
  providerEgressConnectorRefs,
  providerInvokePortHeader,
  providerInvokeResponseIsBase64,
  providerInvokeURL,
  sanitizeMicroVMProviderInvokeHeaders,
  validateMicroVMProviderListInputInternal,
  validateMicroVMProviderInvokeInputInternal,
  validateMicroVMProviderRunInputInternal,
  validateMicroVMProviderSessionInputInternal,
  validateMicroVMProviderTokenInputInternal,
  validateMicroVMProviderSession,
} from "./provider.js";
import { validDate } from "./time.js";

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

  async invoke(
    input: MicroVMProviderInvokeInput,
  ): Promise<MicroVMProviderInvokeOutput> {
    const normalized = validateMicroVMProviderInvokeInputInternal(input);
    try {
      const invokePort = normalized.port ?? 8080;
      const tokenOutput = await this.client.send(
        new CreateMicrovmAuthTokenCommand({
          allowedPorts: awsMicroVMPortScopes([{ port: invokePort }]),
          expirationInMinutes: providerExpirationMinutes(
            normalized.ttl_seconds ?? defaultProviderTokenTTLSeconds,
          ),
          microvmIdentifier: normalized.binding.provider_microvm_id,
        }),
      );
      const authToken = microVMAuthHeaderValue(tokenOutput);
      if (!authToken) {
        throw safeError(
          MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
          "apptheory: microvm provider returned incomplete token metadata",
          normalized.request_id,
        );
      }
      const target = providerInvokeURL(
        normalized.endpoint,
        normalized.path,
        normalized.query,
      );
      if (!target) {
        throw safeError(
          MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
          "apptheory: microvm invoke endpoint is invalid",
          normalized.request_id,
        );
      }
      const headers = new Headers();
      for (const [name, values] of Object.entries(
        sanitizeMicroVMProviderInvokeHeaders(normalized.headers ?? {}),
      )) {
        for (const value of values) headers.append(name, value);
      }
      headers.set("X-aws-proxy-auth", authToken);
      headers.set("X-aws-proxy-port", providerInvokePortHeader(invokePort));
      const init: RequestInit = {
        method: normalized.method,
        headers,
      };
      if (normalized.method !== "GET" && normalized.method !== "HEAD") {
        init.body = normalized.body ?? new Uint8Array();
      }
      const response = await fetch(target, init);
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength > maxProviderInvokeBodyBytes) {
        throw safeError(
          MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
          "apptheory: microvm invoke response is too large",
          normalized.request_id,
        );
      }
      const responseHeaders: Record<string, string[]> = {};
      response.headers.forEach((value, name) => {
        responseHeaders[name] = [...(responseHeaders[name] ?? []), value];
      });
      const sanitized = sanitizeMicroVMProviderInvokeHeaders(responseHeaders);
      return {
        status: response.status,
        headers: sanitized,
        body,
        is_base64: providerInvokeResponseIsBase64(sanitized),
      };
    } catch (err) {
      throw asMicroVMProviderSafeError(err, normalized.request_id);
    }
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

export function microVMProviderSessionFromRunOutput(
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
    stringField(output, "endpoint"),
    stringField(output, "imageArn") || input.image_ref,
    stringField(output, "imageVersion") || input.image_version || "",
    dateField(output, "startedAt"),
    dateField(output, "terminatedAt"),
  );
}

export function microVMProviderSessionFromGetOutput(
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
    stringField(output, "endpoint"),
    stringField(output, "imageArn"),
    stringField(output, "imageVersion"),
    dateField(output, "startedAt"),
    dateField(output, "terminatedAt"),
  );
}

export function microVMProviderListOutputFromSDK(
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
        "",
        stringField(item, "imageArn"),
        stringField(item, "imageVersion"),
        dateField(item, "startedAt"),
        null,
      ),
    );
  }
  return { sessions };
}

export function microVMProviderSessionFromProviderState(
  binding: MicroVMProviderSessionBinding,
  providerState: string,
  endpoint: string,
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
  const cleanEndpoint = String(endpoint ?? "").trim();
  if (cleanEndpoint) session.endpoint = cleanEndpoint;
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

export function awsMicroVMPortScopes(
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

export function ensureMicroVMProviderTokenResult(
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

function microVMAuthHeaderValue(output: unknown): string {
  const authToken = asRecord(output)["authToken"];
  if (!authToken || typeof authToken !== "object" || Array.isArray(authToken)) {
    return "";
  }
  const record = authToken as Record<string, unknown>;
  return String(
    record["X-aws-proxy-auth"] ?? record["x-aws-proxy-auth"] ?? "",
  ).trim();
}

export function providerExpirationMinutes(ttlSeconds: number): number {
  return Math.ceil(ttlSeconds / 60);
}

export function arrayField(value: unknown, key: string): unknown[] {
  const raw = asRecord(value)[key];
  return Array.isArray(raw) ? raw : [];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function stringField(value: unknown, key: string): string {
  return String(asRecord(value)[key] ?? "").trim();
}

export function dateField(value: unknown, key: string): Date | null {
  const raw = asRecord(value)[key];
  if (raw instanceof Date && validDate(raw)) return new Date(raw.valueOf());
  if (typeof raw === "string" || typeof raw === "number") {
    const parsed = new Date(raw);
    if (validDate(parsed)) return parsed;
  }
  return null;
}
