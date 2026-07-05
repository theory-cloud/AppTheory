import {
  MICROVM_CONTROLLER_AUTH_DEFAULT_DENY,
  MICROVM_ERROR_CONTROLLER_INCOMPLETE,
  MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
  MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
  MicroVMCommand,
  type MicroVMControllerAuthContract,
  type MicroVMControllerCommandContract,
  type MicroVMControllerContract,
  type MicroVMCommandName,
  type MicroVMLifecycleState,
  type MicroVMRealLifecycleState,
  type MicroVMSessionRegistryContract,
} from "./model.js";
import { safeError } from "./errors.js";
import {
  normalizeMicroVMLifecycleState,
  requiredMicroVMLifecycleStates,
} from "./lifecycle.js";
import {
  normalizeMicroVMRealLifecycleState,
  requiredMicroVMRealLifecycleStates,
} from "./operation-contract.js";
import { missingStrings } from "./safety.js";

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

export function microVMControllerAuthDefaultsDeny(
  auth: MicroVMControllerAuthContract,
): boolean {
  return (
    auth.required === true &&
    String(auth.default ?? "")
      .trim()
      .toLowerCase() === MICROVM_CONTROLLER_AUTH_DEFAULT_DENY
  );
}

export function normalizeMicroVMCommand(
  command: MicroVMCommandName | string,
): MicroVMCommandName | "" {
  const normalized = String(command ?? "").trim();
  if (normalized === "shell-token") return MicroVMCommand.ShellAuthToken;
  return normalized as MicroVMCommandName | "";
}

export function requiredMicroVMControllerCommands(): MicroVMCommandName[] {
  return [
    MicroVMCommand.Create,
    MicroVMCommand.Start,
    MicroVMCommand.Stop,
    MicroVMCommand.Status,
    MicroVMCommand.Session,
  ];
}

export function realMicroVMControllerCommands(): MicroVMCommandName[] {
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

export function isRequiredMicroVMCommand(
  command: string,
): command is MicroVMCommandName {
  return (requiredMicroVMControllerCommands() as string[]).includes(command);
}

export function validMicroVMCommand(command: string): boolean {
  const normalized = normalizeMicroVMCommand(command);
  return (
    requiredMicroVMControllerCommands().includes(
      normalized as MicroVMCommandName,
    ) ||
    realMicroVMControllerCommands().includes(normalized as MicroVMCommandName)
  );
}

export function requiredMicroVMSessionRegistryContractFields(): string[] {
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
