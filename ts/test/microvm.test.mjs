import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MICROVM_ERROR_CONTROLLER_COMMAND_FAILED,
  MICROVM_ERROR_CONTROLLER_INCOMPLETE,
  MICROVM_ERROR_FORBIDDEN_FIELD,
  MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
  MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
  MICROVM_ERROR_OPERATION_CONTRACT_INCOMPLETE,
  MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
  MICROVM_ERROR_PROVIDER_OPERATION_FAILED,
  MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED,
  MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
  MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
  MICROVM_ERROR_TENANT_BINDING_VIOLATION,
  MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
  MICROVM_ERROR_LIFECYCLE_BYPASS,
  MICROVM_ERROR_LIFECYCLE_HOOK_FAILED,
  MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
  MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH,
  MICROVM_ERROR_SESSION_OWNER_MISMATCH,
  MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
  MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
  MicroVMCommand,
  MicroVMHook,
  MicroVMOperation,
  MicroVMRealHook,
  MicroVMRealState,
  MicroVMSafeError,
  MicroVMState,
  AWSLambdaMicroVMProvider,
  MICROVM_AWS_LAMBDA_PROVIDER_ID,
  MICROVM_DEFAULT_SESSION_PROVIDER_ID,
  MICROVM_ENV_EGRESS_NETWORK_CONNECTOR_REFS,
  MICROVM_ENV_EXECUTION_ROLE_ARN,
  MICROVM_ENV_LOGGING,
  MICROVM_ENV_IMAGE_REF,
  MICROVM_ENV_INGRESS_NETWORK_CONNECTOR_REFS,
  MICROVM_SESSION_REGISTRY_TABLE_ENV,
  createReconstructingMicroVMSessionRegistry,
  createAWSLambdaMicroVMClient,
  createAWSLambdaMicroVMProvider,
  createFakeMicroVMClient,
  createFakeMicroVMProvider,
  createMemoryMicroVMSessionRegistry,
  createMicroVMController,
  createMicroVMLifecycleAdapter,
  createMicroVMRegistryClient,
  createRealMicroVMController,
  createTableTheoryMicroVMSessionRegistry,
  createApp,
  defaultMicroVMControllerContract,
  defaultMicroVMLifecycleContract,
  defaultMicroVMOperationContract,
  defaultMicroVMRealLifecycleContract,
  defaultMicroVMSessionRegistryContract,
  isMicroVMTerminalState,
  mapMicroVMProviderState,
  microVMSessionFromRegistryRecord,
  microVMSessionKey,
  microVMSessionRecordToRegistryRecord,
  microVMSessionRegistryModel,
  microVMSessionRegistryPartitionKey,
  microVMSessionRegistrySortKey,
  microVMSessionRegistryTableName,
  microVMSessionTokenMetadataFromProviderToken,
  registerMicroVMControllerRoutes,
  reconstructMicroVMSessionRecord,
  validateMicroVMControllerContract,
  validateMicroVMControllerRequest,
  validateMicroVMEscapeHatches,
  validateMicroVMOperationContract,
  validateMicroVMProviderListInput,
  validateMicroVMProviderRunInput,
  validateMicroVMProviderSession,
  validateMicroVMProviderSessionInput,
  validateMicroVMProviderToken,
  validateMicroVMProviderTokenInput,
  validateMicroVMRealLifecycleContract,
  validateMicroVMLifecycleContract,
  validateMicroVMSessionRecord,
  validateMicroVMSessionRegistryContract,
  validateMicroVMSessionRegistryRecord,
  validateMicroVMSessionStatus,
  validateMicroVMSessionTokenMetadata,
} from "../dist/index.js";

function lifecycleEvent(overrides = {}) {
  return {
    request_id: "req-1",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    session_id: "session-1",
    hook: MicroVMHook.PrepareImage,
    state: MicroVMState.Requested,
    ...overrides,
  };
}

function handlers() {
  return {
    [MicroVMHook.PrepareImage]: () => {},
    [MicroVMHook.Start]: () => {},
    [MicroVMHook.Readiness]: () => {},
    [MicroVMHook.Stop]: () => {},
    [MicroVMHook.Teardown]: () => {},
    [MicroVMHook.Failure]: () => {},
  };
}

function createInput(overrides = {}) {
  return {
    request_id: "req-create",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    session_id: "session-1",
    image_ref: "image-ref",
    network_connector_ref: "network-ref",
    session_spec: { metadata: { safe: "ok" } },
    controller_id: "controller-1",
    auth_subject: "subject-1",
    now: new Date(1000),
    ...overrides,
  };
}

function commandInput(overrides = {}) {
  return {
    request_id: "req-command",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    session_id: "session-1",
    controller_id: "controller-1",
    auth_subject: "subject-1",
    desired_state: MicroVMState.Started,
    now: new Date(2000),
    ...overrides,
  };
}

function queryInput(overrides = {}) {
  return {
    request_id: "req-query",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    session_id: "session-1",
    auth_subject: "subject-1",
    ...overrides,
  };
}

function providerAuth(overrides = {}) {
  return {
    subject: "subject-1",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    ...overrides,
  };
}

function providerRunInput(overrides = {}) {
  return {
    request_id: "req-run",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    session_id: "session-1",
    auth_context: providerAuth(),
    image_ref: "image-ref",
    image_version: "1",
    network_connector_ref: "egress-default",
    ingress_network_connector_refs: ["ingress-1"],
    egress_network_connector_refs: ["egress-1"],
    session_spec: { metadata: { safe: "ok" } },
    idle_policy: {
      auto_resume_enabled: true,
      max_idle_duration_seconds: 60,
      suspended_duration_seconds: 120,
    },
    maximum_duration_seconds: 600,
    logging: { disabled: true },
    ...overrides,
  };
}

function providerBinding(overrides = {}) {
  return {
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    session_id: "session-1",
    provider_microvm_id: "microvm-000001",
    registry_version: 1,
    ...overrides,
  };
}

function providerSessionInput(overrides = {}) {
  return {
    request_id: "req-get",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_context: providerAuth(),
    binding: providerBinding(),
    ...overrides,
  };
}

function providerTokenInput(overrides = {}) {
  return {
    request_id: "req-token",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_context: providerAuth(),
    binding: providerBinding(),
    ttl_seconds: 120,
    allowed_port_scope: [{ port: 443 }],
    ...overrides,
  };
}

function validRecord(overrides = {}) {
  return {
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    session_id: "session-1",
    state: MicroVMState.Requested,
    desired_state: MicroVMState.Requested,
    provider_id: MICROVM_DEFAULT_SESSION_PROVIDER_ID,
    provider_microvm_id: "session-1",
    provider_state: MicroVMState.Requested,
    aws_lifecycle_state: MicroVMState.Requested,
    image_ref: "image-ref",
    image_version: "1",
    network_connector_ref: "network-ref",
    ingress_network_connector_refs: ["ingress-ref"],
    egress_network_connector_refs: ["egress-ref"],
    controller_id: "controller-1",
    created_at: new Date(1000),
    updated_at: new Date(1000),
    last_observed_at: new Date(1000),
    expires_at: new Date(3_601_000),
    generation: 1,
    last_action: MicroVMCommand.Create,
    last_command_id: "req-record",
    auth_subject: "subject-1",
    reason_metadata: { reason_code: "ok" },
    status_metadata: { status: "healthy" },
    token_metadata: [
      {
        token_id: "auth-token-metadata",
        token_type: "auth",
        expires_at: new Date(901_000),
        scope: ["ports:443"],
      },
    ],
    ...overrides,
  };
}

function validStatus(overrides = {}) {
  return {
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    session_id: "session-1",
    state: MicroVMState.Requested,
    desired_state: MicroVMState.Requested,
    lifecycle_state: MicroVMState.Requested,
    last_action: MicroVMCommand.Create,
    last_transition: new Date(1000),
    registry_version: 1,
    ...overrides,
  };
}

function controllerRequest(overrides = {}) {
  return {
    command: MicroVMCommand.Run,
    request_id: "req-real",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_context: {
      subject: "subject-1",
      tenant_id: "tenant-1",
      namespace: "namespace-1",
    },
    image_ref: "image-ref",
    image_version: "1",
    network_connector_ref: "network-ref",
    ingress_network_connector_refs: ["ingress-ref"],
    egress_network_connector_refs: ["egress-ref"],
    session_spec: { metadata: { safe: "ok" } },
    allowed_port_scope: [{ port: 443 }],
    ttl_seconds: 120,
    ...overrides,
  };
}

function jsonBody(response) {
  return JSON.parse(Buffer.from(response.body).toString("utf8"));
}

test("microvm lifecycle adapter runs through terminal states", async () => {
  const adapter = createMicroVMLifecycleAdapter({ handlers: handlers() });

  let state = MicroVMState.Requested;
  for (const hook of [
    MicroVMHook.PrepareImage,
    MicroVMHook.Start,
    MicroVMHook.Readiness,
    MicroVMHook.Stop,
    MicroVMHook.Teardown,
  ]) {
    const result = await adapter.handle(lifecycleEvent({ hook, state }));
    assert.equal(result.error, undefined);
    state = result.state;
  }

  assert.equal(state, MicroVMState.Terminated);
  assert.equal(isMicroVMTerminalState(state), true);

  const failure = await adapter.handle(
    lifecycleEvent({ hook: MicroVMHook.Failure, state: MicroVMState.Starting }),
  );
  assert.equal(failure.error, undefined);
  assert.equal(failure.state, MicroVMState.Failed);
  assert.equal(isMicroVMTerminalState(failure.state), true);
});

test("microvm lifecycle fails closed with safe errors", async () => {
  validateMicroVMEscapeHatches({});
  assert.throws(
    () => validateMicroVMEscapeHatches({ raw_aws_sdk: true }),
    (err) => err?.code === MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH,
  );
  assert.throws(
    () => validateMicroVMEscapeHatches({ raw_lifecycle_hook_bypass: true }),
    (err) => err?.code === MICROVM_ERROR_LIFECYCLE_BYPASS,
  );

  const broken = createMicroVMLifecycleAdapter({ handlers: handlers() });
  broken.contract.hooks = [];
  const brokenResult = await broken.handle(lifecycleEvent());
  assert.equal(brokenResult.error?.code, MICROVM_ERROR_LIFECYCLE_INCOMPLETE);

  const adapter = createMicroVMLifecycleAdapter({ handlers: handlers() });
  assert.equal(
    (await adapter.handle(lifecycleEvent({ hook: "custom_hook" }))).error?.code,
    MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
  );
  assert.equal(
    (await adapter.handle(lifecycleEvent({ hook: MicroVMHook.Readiness })))
      .error?.code,
    MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
  );

  const mismatchContract = defaultMicroVMLifecycleContract();
  mismatchContract.transitions.unshift({
    from: MicroVMState.Requested,
    hook: MicroVMHook.PrepareImage,
    to: MicroVMState.Starting,
  });
  const mismatch = await createMicroVMLifecycleAdapter({
    contract: mismatchContract,
    handlers: handlers(),
  }).handle(lifecycleEvent());
  assert.equal(mismatch.error?.code, MICROVM_ERROR_INVALID_LIFECYCLE_EVENT);

  assert.equal(
    (await createMicroVMLifecycleAdapter().handle(lifecycleEvent())).error
      ?.code,
    MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
  );
  assert.equal(
    (
      await createMicroVMLifecycleAdapter({
        handlers: {
          [MicroVMHook.PrepareImage]: () => {
            throw new Error("raw");
          },
        },
      }).handle(lifecycleEvent())
    ).error?.code,
    MICROVM_ERROR_LIFECYCLE_HOOK_FAILED,
  );
  assert.equal(
    (await adapter.handle(lifecycleEvent({ tenant_id: "" }))).error?.code,
    MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
  );
  assert.equal(
    (await adapter.handle(lifecycleEvent({ hook: "" }))).error?.code,
    MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
  );
  assert.equal(
    (
      await adapter.handle(
        lifecycleEvent({ metadata: { authorization: "redacted" } }),
      )
    ).error?.code,
    MICROVM_ERROR_FORBIDDEN_FIELD,
  );
});

test("microvm lifecycle contract validation rejects incomplete contracts", () => {
  const missingHookField = defaultMicroVMLifecycleContract();
  missingHookField.hooks[0].phase = "";
  assert.throws(
    () => validateMicroVMLifecycleContract(missingHookField),
    (err) => err?.code === MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
  );

  const missingHook = defaultMicroVMLifecycleContract();
  missingHook.hooks = missingHook.hooks.slice(1);
  assert.throws(() => validateMicroVMLifecycleContract(missingHook));

  const missingState = defaultMicroVMLifecycleContract();
  missingState.states = missingState.states.filter(
    (state) => state !== MicroVMState.Ready,
  );
  assert.throws(() => validateMicroVMLifecycleContract(missingState));

  const missingTerminal = defaultMicroVMLifecycleContract();
  missingTerminal.terminal_states = [MicroVMState.Terminated];
  assert.throws(() => validateMicroVMLifecycleContract(missingTerminal));

  const missingActiveTransition = defaultMicroVMLifecycleContract();
  missingActiveTransition.transitions =
    missingActiveTransition.transitions.filter(
      (transition) =>
        !(
          transition.from === MicroVMState.Requested &&
          transition.hook === MicroVMHook.PrepareImage &&
          transition.to === MicroVMState.ImagePreparing
        ),
    );
  assert.throws(() =>
    validateMicroVMLifecycleContract(missingActiveTransition),
  );

  const missingSuccessTransition = defaultMicroVMLifecycleContract();
  missingSuccessTransition.transitions =
    missingSuccessTransition.transitions.filter(
      (transition) =>
        !(
          transition.from === MicroVMState.ImagePreparing &&
          transition.hook === MicroVMHook.PrepareImage &&
          transition.to === MicroVMState.ImagePrepared
        ),
    );
  assert.throws(() =>
    validateMicroVMLifecycleContract(missingSuccessTransition),
  );

  const missingFailureTransition = defaultMicroVMLifecycleContract();
  missingFailureTransition.transitions =
    missingFailureTransition.transitions.filter(
      (transition) =>
        !(
          transition.from === MicroVMState.ImagePreparing &&
          transition.hook === MicroVMHook.Failure &&
          transition.to === MicroVMState.Failed
        ),
    );
  assert.throws(() =>
    validateMicroVMLifecycleContract(missingFailureTransition),
  );
});

test("microvm controller, registry, record, and request contracts fail closed", () => {
  validateMicroVMControllerContract(defaultMicroVMControllerContract());
  validateMicroVMSessionRegistryContract(
    defaultMicroVMSessionRegistryContract(),
  );
  validateMicroVMSessionRecord(validRecord());
  validateMicroVMSessionStatus(validStatus());
  assert.deepEqual(microVMSessionKey(validRecord()), {
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    session_id: "session-1",
  });

  const unauth = defaultMicroVMControllerContract();
  unauth.auth.required = false;
  assert.throws(
    () => validateMicroVMControllerContract(unauth),
    (err) => err?.code === MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
  );

  for (const mutate of [
    (contract) => {
      contract.envelope.required_fields = [];
    },
    (contract) => {
      contract.envelope.safe_error_fields = [];
    },
    (contract) => {
      contract.envelope.forbidden_fields = [];
    },
    (contract) => {
      contract.commands[0].method = "";
    },
    (contract) => {
      contract.commands[0].response_fields = [];
    },
    (contract) => {
      contract.commands = contract.commands.slice(0, -1);
    },
  ]) {
    const contract = defaultMicroVMControllerContract();
    mutate(contract);
    assert.throws(
      () => validateMicroVMControllerContract(contract),
      (err) => err?.code === MICROVM_ERROR_CONTROLLER_INCOMPLETE,
    );
  }

  for (const mutate of [
    (registry) => {
      registry.pattern = "raw-sdk-table";
    },
    (registry) => {
      registry.tenant_binding = ["tenant_id"];
    },
    (registry) => {
      registry.required_fields = registry.required_fields.filter(
        (field) => field !== "tenant_id",
      );
    },
    (registry) => {
      registry.state_values = registry.state_values.slice(0, -1);
    },
    (registry) => {
      registry.forbidden_fields = ["raw_aws_credentials"];
    },
  ]) {
    const registry = defaultMicroVMSessionRegistryContract();
    mutate(registry);
    assert.throws(
      () => validateMicroVMSessionRegistryContract(registry),
      (err) => err?.code === MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
    );
  }

  for (const record of [
    validRecord({ session_id: "" }),
    validRecord({ created_at: new Date(Number.NaN) }),
    validRecord({ last_action: "" }),
    validRecord({ state: "unknown" }),
    validRecord({ metadata: { "bearer-token": "redacted" } }),
  ]) {
    assert.throws(
      () => validateMicroVMSessionRecord(record),
      (err) =>
        err?.code === MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE ||
        err?.code === MICROVM_ERROR_FORBIDDEN_FIELD,
    );
  }

  for (const status of [
    validStatus({ session_id: "" }),
    validStatus({ last_action: "" }),
    validStatus({ state: "unknown" }),
  ]) {
    assert.throws(
      () => validateMicroVMSessionStatus(status),
      (err) => err?.code === MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
    );
  }

  assert.equal(
    validateMicroVMControllerRequest({})?.code,
    MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
  );
  const baseRequest = {
    command: MicroVMCommand.Create,
    request_id: "req-1",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_context: {
      subject: "subject-1",
      tenant_id: "tenant-1",
      namespace: "namespace-1",
    },
    image_ref: "image-ref",
    network_connector_ref: "network-ref",
  };
  assert.equal(
    validateMicroVMControllerRequest({
      ...baseRequest,
      auth_context: { subject: "subject-1", tenant_id: "other" },
    })?.code,
    MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
  );
  assert.equal(
    validateMicroVMControllerRequest({
      ...baseRequest,
      auth_context: {
        subject: "subject-1",
        tenant_id: "tenant-1",
        namespace: "other",
      },
    })?.code,
    MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
  );
  assert.equal(
    validateMicroVMControllerRequest({
      ...baseRequest,
      auth_context: {
        subject: "subject-1",
        tenant_id: "tenant-1",
        metadata: { authorization: "redacted" },
      },
    })?.code,
    MICROVM_ERROR_FORBIDDEN_FIELD,
  );
  assert.equal(
    validateMicroVMControllerRequest({
      ...baseRequest,
      session_spec: { metadata: { raw_sdk_client: "redacted" } },
    })?.code,
    MICROVM_ERROR_FORBIDDEN_FIELD,
  );
  assert.equal(
    validateMicroVMControllerRequest({ ...baseRequest, image_ref: "" })?.code,
    MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
  );
  assert.equal(
    validateMicroVMControllerRequest({
      ...baseRequest,
      command: MicroVMCommand.Start,
      image_ref: "",
      network_connector_ref: "",
    })?.code,
    MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
  );
  assert.equal(
    validateMicroVMControllerRequest({ ...baseRequest, command: "reboot" })
      ?.code,
    MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
  );
});

test("microvm controller flow and fake client preserve constrained API", async () => {
  assert.throws(
    () => createMicroVMController(null),
    (err) => err?.code === MICROVM_ERROR_CONTROLLER_INCOMPLETE,
  );

  const emptyIDController = createMicroVMController(createFakeMicroVMClient(), {
    ids: { newID: () => "" },
  });
  const emptyID = await emptyIDController.handle({
    command: MicroVMCommand.Create,
    request_id: "req-empty",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_context: { subject: "subject-1", tenant_id: "tenant-1" },
    image_ref: "image-ref",
    network_connector_ref: "network-ref",
  });
  assert.equal(emptyID.error?.code, MICROVM_ERROR_INVALID_CONTROLLER_REQUEST);

  const client = createFakeMicroVMClient(new Date(1000));
  const controller = createMicroVMController(client, {
    controller_id: "controller-1",
    clock: { now: () => new Date(2000) },
    ids: { newID: () => "session-1" },
  });
  const create = await controller.handle({
    command: MicroVMCommand.Create,
    request_id: "req-create",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_context: { subject: "subject-1", tenant_id: "tenant-1" },
    image_ref: "image-ref",
    network_connector_ref: "network-ref",
  });
  assert.equal(create.error, undefined);
  assert.equal(create.session_id, "session-1");

  const start = await controller.handle({
    command: MicroVMCommand.Start,
    request_id: "req-start",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_context: { subject: "subject-1", tenant_id: "tenant-1" },
    session_id: "session-1",
  });
  assert.equal(start.state, MicroVMState.Starting);
  assert.equal(start.desired_state, MicroVMState.Started);

  const status = await controller.handle({
    command: MicroVMCommand.Status,
    request_id: "req-status",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_context: { subject: "subject-1", tenant_id: "tenant-1" },
    session_id: "session-1",
  });
  assert.equal(status.lifecycle_state, MicroVMState.Starting);

  const session = await controller.handle({
    command: MicroVMCommand.Session,
    request_id: "req-session",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_context: { subject: "subject-1", tenant_id: "tenant-1" },
    session_id: "session-1",
  });
  assert.equal(session.session_id, "session-1");

  const stop = await controller.handle({
    command: MicroVMCommand.Stop,
    request_id: "req-stop",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_context: { subject: "subject-1", tenant_id: "tenant-1" },
    session_id: "session-1",
  });
  assert.equal(stop.state, MicroVMState.Stopping);

  client.setNow(new Date(3000));
  assert.deepEqual(
    client.calls().map((call) => call.command),
    [
      MicroVMCommand.Create,
      MicroVMCommand.Start,
      MicroVMCommand.Status,
      MicroVMCommand.Session,
      MicroVMCommand.Stop,
    ],
  );
  await assert.rejects(
    () => client.create(createInput()),
    /session already exists/,
  );
  await assert.rejects(
    () => client.status(queryInput({ session_id: "missing" })),
    /session not found/,
  );

  const failingClient = {
    async create() {
      throw new MicroVMSafeError("safe", "safe");
    },
    async start() {
      throw new Error("raw start");
    },
    async stop() {
      throw new Error("raw stop");
    },
    async status() {
      throw new Error("raw status");
    },
    async session() {
      throw new Error("raw session");
    },
  };
  const failingController = createMicroVMController(failingClient, {
    ids: { newID: () => "session-x" },
  });
  assert.equal(
    (
      await failingController.handle({
        command: MicroVMCommand.Create,
        request_id: "req-safe",
        tenant_id: "tenant-1",
        namespace: "namespace-1",
        auth_context: { subject: "subject-1", tenant_id: "tenant-1" },
        image_ref: "image-ref",
        network_connector_ref: "network-ref",
      })
    ).error?.code,
    "safe",
  );
  assert.equal(
    (
      await failingController.handle({
        command: MicroVMCommand.Start,
        request_id: "req-fail",
        tenant_id: "tenant-1",
        namespace: "namespace-1",
        auth_context: { subject: "subject-1", tenant_id: "tenant-1" },
        session_id: "session-x",
      })
    ).error?.code,
    MICROVM_ERROR_CONTROLLER_COMMAND_FAILED,
  );
});

test("microvm session registry conversions keep TableTheory shape", () => {
  const previousTableName = process.env[MICROVM_SESSION_REGISTRY_TABLE_ENV];
  try {
    delete process.env[MICROVM_SESSION_REGISTRY_TABLE_ENV];
    assert.equal(
      microVMSessionRegistryTableName(),
      "apptheory-microvm-sessions",
    );

    process.env[MICROVM_SESSION_REGISTRY_TABLE_ENV] =
      " custom-microvm-sessions ";
    assert.equal(microVMSessionRegistryTableName(), "custom-microvm-sessions");
  } finally {
    if (previousTableName === undefined) {
      delete process.env[MICROVM_SESSION_REGISTRY_TABLE_ENV];
    } else {
      process.env[MICROVM_SESSION_REGISTRY_TABLE_ENV] = previousTableName;
    }
  }

  assert.equal(
    microVMSessionRegistryPartitionKey(" tenant-1 ", " namespace-1 "),
    "TENANT#8#tenant-1#NAMESPACE#11#namespace-1",
  );
  assert.equal(microVMSessionRegistryPartitionKey("", "namespace-1"), "");
  assert.equal(
    microVMSessionRegistrySortKey(" session-1 "),
    "SESSION#session-1",
  );
  assert.equal(microVMSessionRegistrySortKey(""), "");

  // THE-3413 collision witness: the un-prefixed form mapped both pairs to the same key.
  assert.notEqual(
    microVMSessionRegistryPartitionKey("a", "b#NAMESPACE#c"),
    microVMSessionRegistryPartitionKey("a#NAMESPACE#b", "c"),
  );
  assert.notEqual(
    microVMSessionRegistryPartitionKey("10", "abc"),
    microVMSessionRegistryPartitionKey("1", "0abc"),
  );

  const framed = microVMSessionRecordToRegistryRecord(
    validRecord({ namespace: "b#NAMESPACE#c" }),
  );
  assert.equal(
    framed.pk,
    microVMSessionRegistryPartitionKey("tenant-1", "b#NAMESPACE#c"),
  );
  validateMicroVMSessionRegistryRecord(framed);
  assert.equal(
    microVMSessionFromRegistryRecord(framed).namespace,
    "b#NAMESPACE#c",
  );

  const model = microVMSessionRegistryModel("microvm-table");
  assert.equal(model.tableName, "microvm-table");
  assert.equal(model.schema.keys.partition.attribute, "pk");
  assert.equal(model.schema.keys.sort.attribute, "sk");

  const record = validRecord({
    endpoint: "https://microvm.example.test/session-1",
    microvm_id: "microvm-1",
    metadata: { safe: "ok" },
  });
  const registry = microVMSessionRecordToRegistryRecord(record);
  assert.equal(registry.pk, "TENANT#8#tenant-1#NAMESPACE#11#namespace-1");
  assert.equal(registry.sk, "SESSION#session-1");
  assert.equal(registry.ttl, Math.trunc(record.expires_at.getTime() / 1000));
  assert.equal(registry.version, record.generation);
  validateMicroVMSessionRegistryRecord(registry);

  const roundTrip = microVMSessionFromRegistryRecord(registry);
  assert.equal(roundTrip.endpoint, record.endpoint);
  assert.equal(roundTrip.microvm_id, record.microvm_id);
  assert.equal(roundTrip.provider_id, record.provider_id);
  assert.equal(roundTrip.provider_state, record.provider_state);
  assert.equal(roundTrip.image_version, record.image_version);
  assert.deepEqual(roundTrip.token_metadata, record.token_metadata);
  assert.deepEqual(roundTrip.metadata, { safe: "ok" });

  for (const bad of [
    { ...registry, pk: "TENANT#other#NAMESPACE#namespace-1" },
    { ...registry, ttl: registry.ttl + 1 },
    { ...registry, version: 0 },
    { ...registry, metadata: { bearer_token: "redacted" } },
    { ...registry, status_metadata: { provider_exception: "redacted" } },
    {
      ...registry,
      token_metadata: [
        {
          token_id: "token_value",
          token_type: "auth",
          expires_at: new Date(901_000),
          scope: ["ports:443"],
        },
      ],
    },
  ]) {
    assert.throws(
      () => validateMicroVMSessionRegistryRecord(bad),
      (err) =>
        err?.code === MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE ||
        err?.code === MICROVM_ERROR_FORBIDDEN_FIELD,
    );
  }
});

test("microvm memory registry client preserves durable session flow", async () => {
  assert.throws(
    () => createMicroVMRegistryClient(null),
    (err) => err?.code === MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
  );

  const registry = createMemoryMicroVMSessionRegistry();
  await assert.rejects(
    () =>
      registry.get({
        tenant_id: "tenant-1",
        namespace: "namespace-1",
        session_id: "missing",
      }),
    (err) => err?.code === MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
  );

  const client = createMicroVMRegistryClient(registry, {
    ttl_ms: 30 * 60 * 1000,
  });
  const created = await client.create(createInput());
  assert.equal(created.state, MicroVMState.Requested);
  assert.equal(
    created.expires_at.valueOf() - created.created_at.valueOf(),
    30 * 60 * 1000,
  );

  const started = await client.start(commandInput({ request_id: "req-start" }));
  assert.equal(started.state, MicroVMState.Starting);
  assert.equal(started.desired_state, MicroVMState.Started);
  assert.equal(started.last_action, MicroVMCommand.Start);

  const status = await client.status(queryInput({ request_id: "req-status" }));
  assert.equal(status.lifecycle_state, MicroVMState.Starting);
  assert.equal(status.registry_version, 2);

  const session = await client.session(
    queryInput({ request_id: "req-session" }),
  );
  assert.equal(session.session_id, "session-1");

  const stopped = await client.stop(
    commandInput({
      request_id: "req-stop",
      desired_state: MicroVMState.Stopped,
      now: new Date(3000),
    }),
  );
  assert.equal(stopped.state, MicroVMState.Stopping);
  assert.equal(stopped.desired_state, MicroVMState.Stopped);
  assert.equal(stopped.last_action, MicroVMCommand.Stop);
  assert.equal(stopped.generation, 3);

  await registry.delete(microVMSessionKey(stopped));
  await assert.rejects(
    () => registry.get(microVMSessionKey(stopped)),
    (err) => err?.code === MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
  );
  await assert.rejects(
    () =>
      registry.delete({
        tenant_id: "",
        namespace: "namespace-1",
        session_id: "session-1",
      }),
    (err) => err?.code === MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
  );
});

test("microvm registry reconstruction hooks fail closed", async () => {
  await assert.rejects(
    () =>
      reconstructMicroVMSessionRecord(
        {
          request_id: "req-reconstruct",
          tenant_id: "tenant-1",
          namespace: "namespace-1",
          session_id: "session-1",
          now: new Date(1000),
        },
        null,
      ),
    (err) => err?.code === MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
  );

  await assert.rejects(
    () =>
      reconstructMicroVMSessionRecord(
        {
          request_id: "req-reconstruct",
          tenant_id: "tenant-1",
          namespace: "namespace-1",
          session_id: "session-1",
          now: new Date(1000),
        },
        () => validRecord({ tenant_id: "tenant-other" }),
      ),
    (err) => err?.code === MICROVM_ERROR_TENANT_BINDING_VIOLATION,
  );

  await assert.rejects(
    () =>
      reconstructMicroVMSessionRecord(
        {
          request_id: "req-reconstruct",
          tenant_id: "tenant-1",
          namespace: "namespace-1",
          session_id: "session-1",
          now: new Date(10_000_000),
        },
        () => validRecord(),
      ),
    (err) => err?.code === MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
  );

  const registry = createMemoryMicroVMSessionRegistry();
  const reconstructing = createReconstructingMicroVMSessionRegistry(
    registry,
    (request) =>
      validRecord({
        session_id: request.session_id,
        provider_id: MICROVM_AWS_LAMBDA_PROVIDER_ID,
        provider_microvm_id: "provider-1",
        provider_state: "running",
        aws_lifecycle_state: "running",
        last_observed_at: request.now,
        expires_at: new Date(request.now.valueOf() + 60_000),
      }),
    {
      stale_after_ms: 1,
      clock: { now: () => new Date(5000) },
    },
  );
  const reconstructed = await reconstructing.get({
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    session_id: "session-1",
  });
  assert.equal(reconstructed.provider_id, MICROVM_AWS_LAMBDA_PROVIDER_ID);
  assert.equal(reconstructed.provider_state, "running");

  assert.throws(
    () => createReconstructingMicroVMSessionRegistry(registry, null),
    (err) => err?.code === MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
  );
});

// Mirrors the package's length-prefixed record framing so the test can seed a store the way an
// earlier release left it. The framing is asserted through the migrated canonical key below.
const preM1PartitionKey = (tenant, namespace) =>
  `TENANT#${tenant}#NAMESPACE#${namespace}`;
const recordKeyString = (pk, sk) =>
  `${new TextEncoder().encode(pk).length}:${pk}${new TextEncoder().encode(sk).length}:${sk}`;

test("microvm session registry dual-reads the pre-M1 partition key", async () => {
  const record = validRecord({ metadata: { safe: "ok" } });
  const canonical = microVMSessionRecordToRegistryRecord(record);

  // (c) New writes never produce the legacy key.
  assert.equal(
    canonical.pk,
    microVMSessionRegistryPartitionKey(record.tenant_id, record.namespace),
  );
  assert.notEqual(
    canonical.pk,
    preM1PartitionKey(record.tenant_id, record.namespace),
  );

  // (e) The strict validator still rejects a legacy-format record; only the read path accepts it.
  assert.throws(
    () =>
      validateMicroVMSessionRegistryRecord({
        ...canonical,
        pk: preM1PartitionKey(record.tenant_id, record.namespace),
      }),
    (err) => err?.code === MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
  );

  // Seed the store as an earlier release left it: the item lives under the pre-M1 key.
  const registry = createMemoryMicroVMSessionRegistry();
  const legacyRecord = {
    ...canonical,
    pk: preM1PartitionKey(record.tenant_id, record.namespace),
  };
  registry.records.set(
    recordKeyString(legacyRecord.pk, legacyRecord.sk),
    legacyRecord,
  );

  // (a) A legacy-format item resolves via the fallback.
  const loaded = await registry.get(microVMSessionKey(record));
  assert.equal(loaded.session_id, "session-1");
  assert.equal(loaded.metadata.safe, "ok");

  // (b) The fallback read re-wrote the item under the new key (lazy re-write).
  assert.equal(
    registry.records.has(recordKeyString(legacyRecord.pk, legacyRecord.sk)),
    false,
  );
  assert.equal(
    registry.records.has(recordKeyString(canonical.pk, canonical.sk)),
    true,
  );
  const reloaded = await registry.get(microVMSessionKey(record));
  assert.equal(reloaded.session_id, "session-1");

  // (d) The canonical encoding still isolates the THE-3413 collision witness.
  assert.notEqual(
    microVMSessionRegistryPartitionKey("a", "b#NAMESPACE#c"),
    microVMSessionRegistryPartitionKey("a#NAMESPACE#b", "c"),
  );

  // A colliding pre-M1 key that addresses another identity fails closed instead of leaking it.
  const colliding = microVMSessionRecordToRegistryRecord(
    validRecord({
      tenant_id: "a",
      namespace: "b#NAMESPACE#c",
      session_id: "session-collide",
    }),
  );
  const collidingLegacy = {
    ...colliding,
    pk: preM1PartitionKey("a", "b#NAMESPACE#c"),
  };
  const collidingStore = createMemoryMicroVMSessionRegistry();
  collidingStore.records.set(
    recordKeyString(collidingLegacy.pk, collidingLegacy.sk),
    collidingLegacy,
  );
  await assert.rejects(
    () =>
      collidingStore.get({
        tenant_id: "a#NAMESPACE#b",
        namespace: "c",
        session_id: "session-collide",
      }),
    (err) => err?.code === MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
  );
});

test("microvm TableTheory registry dual-reads and re-keys a legacy item", async () => {
  const saved = [];
  let storedItem;
  const db = {
    async save(modelName, item) {
      storedItem = item;
      saved.push({ modelName, item });
    },
    async get(modelName, key) {
      if (!storedItem || key.pk !== storedItem.pk) {
        throw new Error("apptheory: microvm session registry record not found");
      }
      return storedItem;
    },
    async delete() {},
    async list() {
      return [];
    },
  };
  const registry = createTableTheoryMicroVMSessionRegistry(db, {
    auto_register: false,
  });

  const written = await registry.put(validRecord({ metadata: { safe: "ok" } }));
  assert.equal(
    saved[0].item.pk,
    microVMSessionRegistryPartitionKey("tenant-1", "namespace-1"),
  );

  // Simulate the item an earlier release persisted under the pre-M1 key.
  const legacyPK = preM1PartitionKey("tenant-1", "namespace-1");
  storedItem = {
    ...saved[0].item,
    pk: legacyPK,
  };

  // (a) The legacy item resolves via the fallback.
  const loaded = await registry.get(microVMSessionKey(written));
  assert.equal(loaded.session_id, "session-1");

  // (b) A successful fallback read re-persists the item under the new key.
  assert.equal(
    saved.at(-1).item.pk,
    microVMSessionRegistryPartitionKey("tenant-1", "namespace-1"),
  );
  assert.notEqual(saved.at(-1).item.pk, legacyPK);
});

test("microvm TableTheory registry adapter uses constrained storage model", async () => {
  const registered = [];
  const saved = [];
  const deleted = [];
  const db = {
    register(model) {
      registered.push(model);
    },
    async save(modelName, item) {
      saved.push({ modelName, item });
    },
    async get(modelName, key) {
      assert.equal(modelName, "MicroVMCustomModel");
      assert.deepEqual(key, {
        pk: "TENANT#8#tenant-1#NAMESPACE#11#namespace-1",
        sk: "SESSION#session-1",
      });
      return saved[0].item;
    },
    async delete(modelName, key) {
      deleted.push({ modelName, key });
    },
  };

  const registry = createTableTheoryMicroVMSessionRegistry(db, {
    table_name: "microvm-table",
    model_name: "MicroVMCustomModel",
  });
  assert.equal(registered[0].tableName, "microvm-table");

  const stored = await registry.put(validRecord({ metadata: { safe: "ok" } }));
  assert.equal(stored.session_id, "session-1");
  assert.equal(saved[0].modelName, "MicroVMCustomModel");
  assert.equal(saved[0].item.pk, "TENANT#8#tenant-1#NAMESPACE#11#namespace-1");
  assert.equal(saved[0].item.created_at, new Date(1000).toISOString());
  assert.deepEqual(saved[0].item.metadata, { safe: "ok" });

  const got = await registry.get(microVMSessionKey(stored));
  assert.equal(got.last_action, MicroVMCommand.Create);
  await registry.delete(microVMSessionKey(stored));
  assert.equal(deleted[0].modelName, "MicroVMCustomModel");

  assert.throws(
    () => createTableTheoryMicroVMSessionRegistry(null),
    (err) => err?.code === MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
  );

  const failingRegistry = createTableTheoryMicroVMSessionRegistry(
    {
      async save() {
        throw new Error("raw table failure");
      },
      async get() {
        throw new Error("raw table failure");
      },
      async delete() {
        throw new Error("raw table failure");
      },
    },
    { auto_register: false },
  );
  for (const op of [
    () => failingRegistry.put(validRecord()),
    () => failingRegistry.get(microVMSessionKey(validRecord())),
    () => failingRegistry.delete(microVMSessionKey(validRecord())),
  ]) {
    await assert.rejects(
      op,
      (err) =>
        err?.code === MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE &&
        !String(err.message).includes("raw table failure"),
    );
  }
});

test("microvm AWS Lambda client factory fails closed without SDK support", async () => {
  await assert.rejects(
    () => createAWSLambdaMicroVMClient(),
    (err) => err?.code === MICROVM_ERROR_CONTROLLER_INCOMPLETE,
  );
});

test("microvm provider invoke ttl is bounded to 1..900 seconds", async () => {
  const provider = createFakeMicroVMProvider(new Date(0));
  const run = await provider.run(providerRunInput());
  const binding = {
    tenant_id: run.tenant_id,
    namespace: run.namespace,
    session_id: run.session_id,
    provider_microvm_id: run.provider_microvm_id,
    registry_version: run.registry_version,
  };
  // The endpoint must be an allowlisted AWS MicroVM host so the TTL bound is
  // the check under test, not the endpoint allowlist.
  const allowlisted = "https://provider-1.microvm.us-east-1.amazonaws.com";
  const invokeInput = (ttl_seconds) => ({
    request_id: "req-invoke-ttl",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_context: providerAuth(),
    binding,
    endpoint: allowlisted,
    method: "GET",
    path: "/hello",
    port: 9090,
    ttl_seconds,
  });

  // The inclusive upper bound (900) is accepted.
  const accepted = await provider.invoke(invokeInput(900));
  assert.equal(accepted.status, 200);

  // One second over the bound fails closed with the token-safety violation.
  await assert.rejects(
    () => provider.invoke(invokeInput(901)),
    (err) => err?.code === MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
  );
});

test("microvm provider validation and fake cover M16 real operations", async () => {
  assert.deepEqual(mapMicroVMProviderState("RUNNING"), {
    state: MicroVMRealState.Running,
    terminal: false,
  });
  assert.throws(
    () => mapMicroVMProviderState("unknown"),
    (err) => err?.code === MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
  );
  validateMicroVMProviderRunInput(providerRunInput());
  validateMicroVMProviderSessionInput(
    MicroVMOperation.Get,
    providerSessionInput(),
  );
  validateMicroVMProviderListInput({
    request_id: "req-list",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_context: providerAuth(),
    known_sessions: [providerBinding()],
  });
  validateMicroVMProviderTokenInput(
    MicroVMOperation.AuthToken,
    providerTokenInput(),
  );
  assert.throws(
    () =>
      validateMicroVMProviderTokenInput(
        MicroVMOperation.Run,
        providerTokenInput(),
      ),
    (err) => err?.code === MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED,
  );
  assert.throws(
    () => validateMicroVMProviderRunInput(providerRunInput({ request_id: "" })),
    (err) => err?.code === MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
  );
  for (const logging of [
    {},
    { disabled: false },
    { disabled: true, cloud_watch: {} },
    { cloud_watch: {} },
  ]) {
    assert.throws(
      () => validateMicroVMProviderRunInput(providerRunInput({ logging })),
      (err) => err?.code === MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
    );
  }
  validateMicroVMProviderRunInput(
    providerRunInput({
      execution_role_arn:
        "arn:aws:iam::123456789012:role/HostMicrovmExecutionRole",
      logging: {
        cloud_watch: {
          log_group: "/aws/lambda/microvm/apptheory",
          log_stream: "runtime",
        },
      },
    }),
  );

  const fake = createFakeMicroVMProvider(new Date(0));
  const run = await fake.run(providerRunInput());
  assert.equal(run.provider_microvm_id, "microvm-000001");
  assert.equal(run.state, MicroVMRealState.Running);
  assert.equal(run.provider_state, "running");
  validateMicroVMProviderSession(run);

  const binding = run;
  const sessionInput = providerSessionInput({
    binding: {
      tenant_id: binding.tenant_id,
      namespace: binding.namespace,
      session_id: binding.session_id,
      provider_microvm_id: binding.provider_microvm_id,
      registry_version: binding.registry_version,
    },
  });
  assert.equal((await fake.get(sessionInput)).session_id, "session-1");
  const suspended = await fake.suspend(sessionInput);
  assert.equal(suspended.state, MicroVMRealState.Suspended);
  const resumed = await fake.resume(sessionInput);
  assert.equal(resumed.provider_state, "ready");
  const list = await fake.list({
    request_id: "req-list",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_context: providerAuth(),
  });
  assert.equal(list.sessions.length, 1);
  assert.equal(
    (
      await fake.list({
        request_id: "req-list-other",
        tenant_id: "tenant-2",
        namespace: "namespace-1",
        auth_context: providerAuth({ tenant_id: "tenant-2" }),
      })
    ).sessions.length,
    0,
  );
  const token = await fake.createAuthToken(
    providerTokenInput({ binding: sessionInput.binding }),
  );
  validateMicroVMProviderToken(token);
  const tokenMetadata = microVMSessionTokenMetadataFromProviderToken(token);
  validateMicroVMSessionTokenMetadata(tokenMetadata);
  assert.equal(token.token_id, "auth-000001");
  assert.deepEqual(token.scope, ["ports:443"]);
  const shell = await fake.createShellToken(
    providerTokenInput({
      binding: sessionInput.binding,
      allowed_port_scope: [],
    }),
  );
  assert.equal(shell.token_type, "shell");
  assert.deepEqual(shell.scope, ["shell"]);
  const terminated = await fake.terminate(sessionInput);
  assert.equal(terminated.terminal, true);
  assert.deepEqual(
    fake.calls().map((call) => call.operation),
    [
      MicroVMOperation.Run,
      MicroVMOperation.Get,
      MicroVMOperation.Suspend,
      MicroVMOperation.Resume,
      MicroVMOperation.List,
      MicroVMOperation.List,
      MicroVMOperation.AuthToken,
      MicroVMOperation.ShellToken,
      MicroVMOperation.Terminate,
    ],
  );

  fake.setOperationError(
    MicroVMOperation.Get,
    new MicroVMSafeError("raw", "raw"),
  );
  await assert.rejects(
    () => fake.get(sessionInput),
    (err) => err?.code === MICROVM_ERROR_PROVIDER_OPERATION_FAILED,
  );
});

test("microvm real controller uses canonical commands and stores only token metadata", async () => {
  const provider = createFakeMicroVMProvider(new Date(0));
  const registry = createMemoryMicroVMSessionRegistry({
    now: () => new Date(1000),
  });
  const controller = createRealMicroVMController(provider, registry, {
    controller_id: "controller-1",
    provider_id: MICROVM_AWS_LAMBDA_PROVIDER_ID,
    ids: { newID: () => "session-1" },
    clock: { now: () => new Date(1000) },
    ttl_ms: 60_000,
    logging: { disabled: true },
  });

  const run = await controller.handle(controllerRequest());
  assert.equal(run.error, undefined);
  assert.equal(run.command, MicroVMCommand.Run);
  assert.equal(run.session_id, "session-1");
  assert.equal(run.state, MicroVMRealState.Running);

  const get = await controller.handle(
    controllerRequest({
      command: MicroVMCommand.Get,
      request_id: "req-get",
      session_id: "session-1",
    }),
  );
  assert.equal(get.provider_microvm_id, run.provider_microvm_id);

  const suspended = await controller.handle(
    controllerRequest({
      command: MicroVMCommand.Suspend,
      request_id: "req-suspend",
      session_id: "session-1",
    }),
  );
  assert.equal(suspended.state, MicroVMRealState.Suspended);

  const resumed = await controller.handle(
    controllerRequest({
      command: MicroVMCommand.Resume,
      request_id: "req-resume",
      session_id: "session-1",
    }),
  );
  assert.equal(resumed.state, MicroVMRealState.Ready);

  const list = await controller.handle(
    controllerRequest({
      command: MicroVMCommand.List,
      request_id: "req-list",
      session_id: "",
    }),
  );
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].session_id, "session-1");

  const token = await controller.handle(
    controllerRequest({
      command: MicroVMCommand.AuthToken,
      request_id: "req-token",
      session_id: "session-1",
      allowed_port_scope: [{ port: 443 }],
    }),
  );
  assert.equal(token.error, undefined);
  assert.equal(token.token_type, "auth");
  assert.deepEqual(token.scope, ["ports:443"]);
  const tokenJSON = JSON.stringify(token);
  for (const forbidden of [
    "token_value",
    "bearer_token",
    "x-aws-proxy-auth",
    "session_token_plaintext",
  ]) {
    assert.equal(tokenJSON.includes(forbidden), false);
  }

  const shell = await controller.handle(
    controllerRequest({
      command: "shell-token",
      request_id: "req-shell",
      session_id: "session-1",
      allowed_port_scope: [],
    }),
  );
  assert.equal(shell.command, MicroVMCommand.ShellAuthToken);
  assert.equal(shell.token_type, "shell");

  const stored = await registry.get({
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    session_id: "session-1",
  });
  assert.equal(stored.token_metadata.length, 2);
  const storedJSON = JSON.stringify(stored.token_metadata);
  assert.equal(storedJSON.includes("token_value"), false);
  assert.equal(storedJSON.includes("bearer_token"), false);

  const denied = await controller.handle(
    controllerRequest({
      command: MicroVMCommand.Get,
      request_id: "req-denied",
      tenant_id: "tenant-2",
      auth_context: {
        subject: "subject-1",
        tenant_id: "tenant-1",
        namespace: "namespace-1",
      },
      session_id: "session-1",
    }),
  );
  assert.equal(denied.error?.code, MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER);

  const terminated = await controller.handle(
    controllerRequest({
      command: MicroVMCommand.Terminate,
      request_id: "req-terminate",
      session_id: "session-1",
    }),
  );
  assert.equal(terminated.state, MicroVMRealState.Terminated);
});

test("microvm real controller enforces session ownership on keyed loads", async () => {
  const provider = createFakeMicroVMProvider(new Date(0));
  const registry = createMemoryMicroVMSessionRegistry({
    now: () => new Date(1000),
  });
  const controller = createRealMicroVMController(provider, registry, {
    controller_id: "controller-1",
    ids: { newID: () => "owned-session" },
    clock: { now: () => new Date(1000) },
    logging: { disabled: true },
  });

  const run = await controller.handle(controllerRequest({ session_id: "" }));
  assert.equal(run.error, undefined);
  assert.equal(run.session_id, "owned-session");

  const otherAuth = {
    subject: "subject-2",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
  };
  const other = (overrides = {}) =>
    controllerRequest({
      session_id: "owned-session",
      auth_context: otherAuth,
      ...overrides,
    });

  const sameOwnerGet = await controller.handle(
    controllerRequest({
      command: MicroVMCommand.Get,
      request_id: "req-owner-get",
      session_id: "owned-session",
    }),
  );
  assert.equal(sameOwnerGet.error, undefined);

  for (const [command, requestID] of [
    [MicroVMCommand.Get, "req-other-get"],
    [MicroVMCommand.Suspend, "req-other-suspend"],
    [MicroVMCommand.Resume, "req-other-resume"],
    [MicroVMCommand.Terminate, "req-other-terminate"],
    [MicroVMCommand.AuthToken, "req-other-auth-token"],
    [MicroVMCommand.ShellAuthToken, "req-other-shell-token"],
  ]) {
    const denied = await controller.handle(
      other({
        command,
        request_id: requestID,
        allowed_port_scope: [{ port: 443 }],
      }),
    );
    assert.equal(
      denied.error?.code,
      MICROVM_ERROR_SESSION_OWNER_MISMATCH,
      `${command} must be denied for a different subject`,
    );
  }

  await assert.rejects(
    () =>
      controller.invoke({
        request_id: "req-other-invoke",
        tenant_id: "tenant-1",
        namespace: "namespace-1",
        auth_context: otherAuth,
        session_id: "owned-session",
        method: "GET",
        path: "ping",
      }),
    (err) => err?.code === MICROVM_ERROR_SESSION_OWNER_MISMATCH,
  );

  // List semantics now require exact, non-empty owner equality: another
  // subject in the same tenant does not see this session, and listing never
  // rewrites its owner.
  const listedByOther = await controller.handle(
    other({ command: MicroVMCommand.List, request_id: "req-other-list" }),
  );
  assert.equal(listedByOther.error, undefined);
  assert.equal(listedByOther.sessions.length, 0);

  const listedByOwner = await controller.handle(
    controllerRequest({
      command: MicroVMCommand.List,
      request_id: "req-owner-list",
      session_id: "",
    }),
  );
  assert.equal(listedByOwner.error, undefined);
  assert.equal(listedByOwner.sessions.length, 1);
  assert.equal(listedByOwner.sessions[0].session_id, "owned-session");

  const stored = await registry.get({
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    session_id: "owned-session",
  });
  assert.equal(stored.auth_subject, "subject-1");
  assert.equal(stored.state, MicroVMRealState.Running);
  // A same-subject token refresh preserves the stored owner.
  const token = await controller.handle(
    controllerRequest({
      command: MicroVMCommand.AuthToken,
      request_id: "req-owner-token",
      session_id: "owned-session",
      allowed_port_scope: [{ port: 443 }],
    }),
  );
  assert.equal(token.error, undefined);
  const refreshed = await registry.get({
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    session_id: "owned-session",
  });
  assert.equal(refreshed.auth_subject, "subject-1");

  const terminated = await controller.handle(
    controllerRequest({
      command: MicroVMCommand.Terminate,
      request_id: "req-owner-terminate",
      session_id: "owned-session",
    }),
  );
  assert.equal(terminated.state, MicroVMRealState.Terminated);
});

test("microvm real controller carries execution role from environment", async () => {
  const roleArn = "arn:aws:iam::123456789012:role/HostMicrovmExecutionRole";
  const previous = process.env[MICROVM_ENV_EXECUTION_ROLE_ARN];
  const previousLogging = process.env[MICROVM_ENV_LOGGING];
  process.env[MICROVM_ENV_EXECUTION_ROLE_ARN] = roleArn;
  process.env[MICROVM_ENV_LOGGING] = JSON.stringify({
    cloud_watch: {
      log_group: "/aws/lambda/microvm/apptheory",
      log_stream: "runtime",
    },
  });
  try {
    const baseProvider = createFakeMicroVMProvider(new Date(0));
    let recordedExecutionRoleArn = "";
    let recordedLogging;
    const provider = {
      run: async (input) => {
        recordedExecutionRoleArn = String(input.execution_role_arn ?? "");
        recordedLogging = input.logging;
        return await baseProvider.run(input);
      },
      get: (input) => baseProvider.get(input),
      list: (input) => baseProvider.list(input),
      suspend: (input) => baseProvider.suspend(input),
      resume: (input) => baseProvider.resume(input),
      terminate: (input) => baseProvider.terminate(input),
      createAuthToken: (input) => baseProvider.createAuthToken(input),
      createShellToken: (input) => baseProvider.createShellToken(input),
    };
    const controller = createRealMicroVMController(
      provider,
      createMemoryMicroVMSessionRegistry(),
      {
        ids: { newID: () => "session-role" },
        clock: { now: () => new Date(1000) },
      },
    );
    const run = await controller.handle(controllerRequest());
    assert.equal(run.error, undefined);
    assert.equal(recordedExecutionRoleArn, roleArn);
    assert.deepEqual(recordedLogging, {
      cloud_watch: {
        log_group: "/aws/lambda/microvm/apptheory",
        log_stream: "runtime",
      },
    });
  } finally {
    if (previous === undefined) {
      delete process.env[MICROVM_ENV_EXECUTION_ROLE_ARN];
    } else {
      process.env[MICROVM_ENV_EXECUTION_ROLE_ARN] = previous;
    }
    if (previousLogging === undefined) {
      delete process.env[MICROVM_ENV_LOGGING];
    } else {
      process.env[MICROVM_ENV_LOGGING] = previousLogging;
    }
  }
});

test("microvm real controller requires explicit runtime logging", () => {
  const previous = process.env[MICROVM_ENV_LOGGING];
  delete process.env[MICROVM_ENV_LOGGING];
  try {
    assert.throws(
      () =>
        createRealMicroVMController(
          createFakeMicroVMProvider(new Date(0)),
          createMemoryMicroVMSessionRegistry(),
        ),
      (err) => err?.code === MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
    );
  } finally {
    if (previous === undefined) {
      delete process.env[MICROVM_ENV_LOGGING];
    } else {
      process.env[MICROVM_ENV_LOGGING] = previous;
    }
  }
});

test("microvm real controller applies deployment-pinned defaults", async () => {
  const previous = {
    image: process.env[MICROVM_ENV_IMAGE_REF],
    ingress: process.env[MICROVM_ENV_INGRESS_NETWORK_CONNECTOR_REFS],
    egress: process.env[MICROVM_ENV_EGRESS_NETWORK_CONNECTOR_REFS],
  };
  process.env[MICROVM_ENV_IMAGE_REF] = "env-image-ref";
  process.env[MICROVM_ENV_INGRESS_NETWORK_CONNECTOR_REFS] =
    "ingress-ref,shell-ingress-ref";
  process.env[MICROVM_ENV_EGRESS_NETWORK_CONNECTOR_REFS] = "egress-ref";
  try {
    const baseProvider = createFakeMicroVMProvider(new Date(0));
    let recordedRun;
    const provider = {
      run: async (input) => {
        recordedRun = input;
        return await baseProvider.run(input);
      },
      get: (input) => baseProvider.get(input),
      list: (input) => baseProvider.list(input),
      suspend: (input) => baseProvider.suspend(input),
      resume: (input) => baseProvider.resume(input),
      terminate: (input) => baseProvider.terminate(input),
      createAuthToken: (input) => baseProvider.createAuthToken(input),
      createShellToken: (input) => baseProvider.createShellToken(input),
    };
    const controller = createRealMicroVMController(
      provider,
      createMemoryMicroVMSessionRegistry(),
      {
        ids: { newID: () => "session-defaults" },
        clock: { now: () => new Date(1000) },
        logging: { disabled: true },
      },
    );
    const run = await controller.handle(
      controllerRequest({
        session_id: "",
        image_ref: "",
        network_connector_ref: "",
        ingress_network_connector_refs: [],
        egress_network_connector_refs: [],
      }),
    );
    assert.equal(run.error, undefined);
    assert.equal(recordedRun.image_ref, "env-image-ref");
    assert.equal(recordedRun.network_connector_ref, "egress-ref");
    assert.deepEqual(recordedRun.ingress_network_connector_refs, [
      "ingress-ref",
      "shell-ingress-ref",
    ]);
    assert.deepEqual(recordedRun.egress_network_connector_refs, ["egress-ref"]);

    const override = await controller.handle(
      controllerRequest({
        request_id: "req-defaults-override",
        session_id: "",
        image_ref: "other-image-ref",
        network_connector_ref: "egress-ref",
      }),
    );
    assert.equal(
      override.error?.code,
      MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
    );
  } finally {
    for (const [key, value] of [
      [MICROVM_ENV_IMAGE_REF, previous.image],
      [MICROVM_ENV_INGRESS_NETWORK_CONNECTOR_REFS, previous.ingress],
      [MICROVM_ENV_EGRESS_NETWORK_CONNECTOR_REFS, previous.egress],
    ]) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("microvm controller registry miss fails closed before any provider call", async () => {
  const provider = createFakeMicroVMProvider(new Date(0));
  const controller = createRealMicroVMController(
    provider,
    createMemoryMicroVMSessionRegistry(),
    {
      ids: { newID: () => "session-pin" },
      clock: { now: () => new Date(1000) },
      logging: { disabled: true },
    },
  );

  const missGet = await controller.handle(
    controllerRequest({
      command: MicroVMCommand.Get,
      request_id: "req-pin-miss-get",
      session_id: "session-absent",
    }),
  );
  assert.equal(missGet.error?.code, MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE);
  assert.equal(provider.calls().length, 0);

  await assert.rejects(
    controller.invoke({
      request_id: "req-pin-miss-invoke",
      tenant_id: "tenant-1",
      namespace: "namespace-1",
      auth_context: {
        subject: "subject-1",
        tenant_id: "tenant-1",
        namespace: "namespace-1",
      },
      session_id: "session-absent",
      method: "GET",
      path: "pin",
      port: 8081,
      ttl_seconds: 30,
    }),
  );
  assert.equal(provider.calls().length, 0);

  const missToken = await controller.handle(
    controllerRequest({
      command: MicroVMCommand.AuthToken,
      request_id: "req-pin-miss-token",
      session_id: "session-absent",
    }),
  );
  assert.equal(missToken.error?.code, MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE);
  assert.equal(provider.calls().length, 0);
});

test("microvm controller dispatches provider calls bound to the registry record", async () => {
  const base = createFakeMicroVMProvider(new Date(0));
  let sessionInput;
  let invokeInput;
  let tokenInput;
  const provider = {
    run: (input) => base.run(input),
    get: (input) => {
      sessionInput = input;
      return base.get(input);
    },
    list: (input) => base.list(input),
    suspend: (input) => base.suspend(input),
    resume: (input) => base.resume(input),
    terminate: (input) => base.terminate(input),
    invoke: (input) => {
      invokeInput = input;
      return base.invoke(input);
    },
    createAuthToken: (input) => {
      tokenInput = input;
      return base.createAuthToken(input);
    },
    createShellToken: (input) => {
      tokenInput = input;
      return base.createShellToken(input);
    },
  };
  const registry = createMemoryMicroVMSessionRegistry();
  const controller = createRealMicroVMController(provider, registry, {
    ids: { newID: () => "session-pin" },
    clock: { now: () => new Date(1000) },
    logging: { disabled: true },
  });

  const run = await controller.handle(controllerRequest({ session_id: "" }));
  assert.equal(run.error, undefined);
  const stored = await registry.get({
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    session_id: "session-pin",
  });

  const get = await controller.handle(
    controllerRequest({
      command: MicroVMCommand.Get,
      request_id: "req-pin-get",
      session_id: "session-pin",
    }),
  );
  assert.equal(get.error, undefined);
  assert.equal(sessionInput.binding.provider_microvm_id, stored.provider_microvm_id);
  assert.equal(sessionInput.binding.tenant_id, stored.tenant_id);
  assert.equal(sessionInput.binding.namespace, stored.namespace);
  assert.equal(sessionInput.binding.session_id, stored.session_id);
  assert.equal(sessionInput.binding.registry_version, stored.generation);

  const invoked = await controller.invoke({
    request_id: "req-pin-invoke",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_context: {
      subject: "subject-1",
      tenant_id: "tenant-1",
      namespace: "namespace-1",
    },
    session_id: "session-pin",
    method: "GET",
    path: "pin",
    headers: {
      "x-provider-microvm-id": ["provider-microvm-decoy"],
      "x-microvm-endpoint": [
        "https://provider-microvm-decoy.microvm.us-east-1.amazonaws.com",
      ],
    },
    query: {
      provider_microvm_id: ["provider-microvm-decoy"],
      endpoint: [
        "https://provider-microvm-decoy.microvm.us-east-1.amazonaws.com",
      ],
    },
    port: 8081,
    ttl_seconds: 30,
  });
  assert.equal(invoked.status, 200);
  assert.equal(invokeInput.endpoint, stored.endpoint);
  assert.equal(invokeInput.binding.provider_microvm_id, stored.provider_microvm_id);
  assert.notEqual(invokeInput.binding.provider_microvm_id, "provider-microvm-decoy");
  assert.notEqual(
    invokeInput.endpoint,
    "https://provider-microvm-decoy.microvm.us-east-1.amazonaws.com",
  );

  const token = await controller.handle(
    controllerRequest({
      command: MicroVMCommand.AuthToken,
      request_id: "req-pin-token",
      session_id: "session-pin",
    }),
  );
  assert.equal(token.error, undefined);
  assert.equal(tokenInput.binding.provider_microvm_id, stored.provider_microvm_id);
  assert.equal(tokenInput.binding.tenant_id, stored.tenant_id);
});

test("microvm controller route adapter enforces auth and tenant binding", async () => {
  const provider = createFakeMicroVMProvider(new Date(0));
  const registry = createMemoryMicroVMSessionRegistry();
  const controller = createRealMicroVMController(provider, registry, {
    ids: { newID: () => "route-session" },
    clock: { now: () => new Date(1000) },
    logging: { disabled: true },
  });
  const app = createApp({
    tier: "p1",
    authHook: (ctx) => `identity:${ctx.tenantId}`,
  });
  registerMicroVMControllerRoutes(app, controller);

  const serve = (method, path, body = {}, headers = {}) =>
    app.serve({
      method,
      path,
      headers: {
        "content-type": ["application/json"],
        "x-tenant-id": ["tenant-1"],
        "x-request-id": [`req-${method}-${path}`],
        ...headers,
      },
      body: Buffer.from(JSON.stringify(body), "utf8"),
    });

  const run = await serve("POST", "/microvms", {
    namespace: "namespace-1",
    image_ref: "image-ref",
    image_version: "1",
    network_connector_ref: "network-ref",
    session_spec: { metadata: { safe: "ok" } },
  });
  assert.equal(run.status, 200);
  const runBody = jsonBody(run);
  assert.equal(runBody.command, MicroVMCommand.Run);
  assert.equal(runBody.session_id, "route-session");

  const token = await serve("POST", "/microvms/route-session/auth-token", {
    namespace: "namespace-1",
    allowed_port_scope: [{ port: 443 }],
  });
  assert.equal(token.status, 200);
  const tokenText = Buffer.from(token.body).toString("utf8");
  assert.equal(tokenText.includes("token_value"), false);
  assert.equal(tokenText.includes("bearer_token"), false);
  assert.equal(jsonBody(token).token_type, "auth");

  const crossTenant = await serve(
    "POST",
    "/microvms/route-session/auth-token",
    {
      tenant_id: "tenant-2",
      namespace: "namespace-1",
      allowed_port_scope: [{ port: 443 }],
    },
  );
  assert.equal(crossTenant.status, 403);
  assert.equal(
    jsonBody(crossTenant).error.code,
    MICROVM_ERROR_TENANT_BINDING_VIOLATION,
  );

  const unauthenticated = createApp({ tier: "p1" });
  registerMicroVMControllerRoutes(unauthenticated, controller);
  const denied = await unauthenticated.serve({
    method: "GET",
    path: "/microvms/route-session",
    query: { namespace: ["namespace-1"] },
    headers: {
      "x-tenant-id": ["tenant-1"],
      "x-request-id": ["req-denied"],
    },
  });
  assert.equal(denied.status, 401);
});

test("microvm controller route adapter returns 403 for a session owner mismatch", async () => {
  const provider = createFakeMicroVMProvider(new Date(0));
  const registry = createMemoryMicroVMSessionRegistry();
  const controller = createRealMicroVMController(provider, registry, {
    ids: { newID: () => "owner-session" },
    clock: { now: () => new Date(1000) },
    logging: { disabled: true },
  });
  const owner = createApp({
    tier: "p1",
    authHook: () => "identity:owner",
  });
  registerMicroVMControllerRoutes(owner, controller);

  const run = await owner.serve({
    method: "POST",
    path: "/microvms",
    headers: {
      "content-type": ["application/json"],
      "x-tenant-id": ["tenant-1"],
      "x-request-id": ["req-owner-run"],
    },
    body: Buffer.from(
      JSON.stringify({
        namespace: "namespace-1",
        image_ref: "image-ref",
        image_version: "1",
        network_connector_ref: "network-ref",
        session_spec: { metadata: { safe: "ok" } },
      }),
      "utf8",
    ),
  });
  assert.equal(run.status, 200);

  const other = createApp({
    tier: "p1",
    authHook: () => "identity:other",
  });
  registerMicroVMControllerRoutes(other, controller);
  const denied = await other.serve({
    method: "GET",
    path: "/microvms/owner-session",
    query: { namespace: ["namespace-1"] },
    headers: {
      "x-tenant-id": ["tenant-1"],
      "x-request-id": ["req-owner-get"],
    },
  });
  assert.equal(denied.status, 403);
  assert.equal(
    jsonBody(denied).error.code,
    MICROVM_ERROR_SESSION_OWNER_MISMATCH,
  );
});

test("microvm controller route adapter binds tenant to the verified claim", async () => {
  const provider = createFakeMicroVMProvider(new Date(0));
  const registry = createMemoryMicroVMSessionRegistry();
  const controller = createRealMicroVMController(provider, registry, {
    ids: { newID: () => "claim-session" },
    clock: { now: () => new Date(1000) },
    logging: { disabled: true },
  });

  const claimApp = (claims) => {
    const app = createApp({
      tier: "p1",
      authPrincipalHook: () => ({ identity: "subject-1", claims }),
      tenantClaim: "tenant_id",
    });
    registerMicroVMControllerRoutes(app, controller);
    return app;
  };

  const serve = (app, method, path, body = {}, headers = {}) =>
    app.serve({
      method,
      path,
      headers: {
        "content-type": ["application/json"],
        "x-tenant-id": ["tenant-1"],
        "x-request-id": [`req-claim-${method}-${path}`],
        ...headers,
      },
      body: Buffer.from(JSON.stringify(body), "utf8"),
    });

  const runBody = {
    tenant_id: "tenant-2",
    namespace: "namespace-1",
    image_ref: "image-ref",
    image_version: "1",
    network_connector_ref: "network-ref",
  };

  const headerMismatch = await serve(
    claimApp({ tenant_id: "tenant-1" }),
    "POST",
    "/microvms",
    runBody,
    { "x-tenant-id": ["tenant-2"] },
  );
  assert.equal(headerMismatch.status, 403);
  assert.equal(
    jsonBody(headerMismatch).error.code,
    MICROVM_ERROR_TENANT_BINDING_VIOLATION,
  );

  const bodyMismatch = await serve(
    claimApp({ tenant_id: "tenant-1" }),
    "POST",
    "/microvms",
    runBody,
  );
  assert.equal(bodyMismatch.status, 403);
  assert.equal(
    jsonBody(bodyMismatch).error.code,
    MICROVM_ERROR_TENANT_BINDING_VIOLATION,
  );

  const unbound = await serve(claimApp({ other: "value" }), "POST", "/microvms", {
    ...runBody,
    tenant_id: "tenant-1",
  });
  assert.equal(unbound.status, 403);
  assert.equal(
    jsonBody(unbound).error.code,
    MICROVM_ERROR_TENANT_BINDING_VIOLATION,
  );

  const invokeMismatch = await claimApp({ tenant_id: "tenant-1" }).serve({
    method: "GET",
    path: "/microvms/claim-session/invoke/hello",
    query: { tenant_id: ["tenant-2"] },
    headers: {
      "x-tenant-id": ["tenant-2"],
      "x-request-id": ["req-claim-invoke-mismatch"],
    },
  });
  assert.equal(invokeMismatch.status, 403);
  assert.equal(
    jsonBody(invokeMismatch).error.code,
    MICROVM_ERROR_TENANT_BINDING_VIOLATION,
  );

  const bound = await serve(claimApp({ tenant_id: "tenant-1" }), "POST", "/microvms", {
    ...runBody,
    tenant_id: "tenant-1",
  });
  assert.equal(bound.status, 200);
  assert.equal(jsonBody(bound).session_id, "claim-session");
});

test("microvm AWS provider uses official command classes and sanitizes tokens", async () => {
  assert.equal(typeof AWSLambdaMicroVMProvider, "function");
  const provider = createAWSLambdaMicroVMProvider({
    clock: { now: () => new Date(0) },
  });
  const sent = [];
  let state = "RUNNING";
  const output = () => ({
    microvmId: "provider-1",
    state,
    imageArn: "image-ref",
    imageVersion: "1",
    startedAt: new Date(0),
  });
  provider.client = {
    async send(command) {
      sent.push({ name: command.constructor.name, input: command.input });
      switch (command.constructor.name) {
        case "RunMicrovmCommand":
          state = "RUNNING";
          return output();
        case "GetMicrovmCommand":
          return output();
        case "ListMicrovmsCommand":
          return {
            items: [
              output(),
              {
                microvmId: "provider-other",
                state: "RUNNING",
                imageArn: "image-ref",
                imageVersion: "1",
                startedAt: new Date(0),
              },
            ],
          };
        case "SuspendMicrovmCommand":
          state = "SUSPENDED";
          return {};
        case "ResumeMicrovmCommand":
          state = "RUNNING";
          return {};
        case "TerminateMicrovmCommand":
          state = "TERMINATED";
          return {};
        case "CreateMicrovmAuthTokenCommand":
        case "CreateMicrovmShellAuthTokenCommand":
          return { authToken: { issued: true } };
        default:
          throw new Error(`unexpected command ${command.constructor.name}`);
      }
    },
  };

  const run = await provider.run(
    providerRunInput({
      session_id: "session-1",
      execution_role_arn:
        "arn:aws:iam::123456789012:role/HostMicrovmExecutionRole",
      logging: {
        cloud_watch: {
          log_group: "/aws/lambda/microvm/apptheory",
          log_stream: "runtime",
        },
      },
    }),
  );
  assert.deepEqual(sent[0].input.logging, {
    cloudWatch: {
      logGroup: "/aws/lambda/microvm/apptheory",
      logStream: "runtime",
    },
  });
  const binding = {
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    session_id: "session-1",
    provider_microvm_id: run.provider_microvm_id,
    registry_version: 1,
  };
  await provider.get(providerSessionInput({ binding }));
  const list = await provider.list({
    request_id: "req-list",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_context: providerAuth(),
    known_sessions: [binding],
  });
  assert.equal(list.sessions.length, 1);
  await provider.suspend(providerSessionInput({ binding }));
  await provider.resume(providerSessionInput({ binding }));
  await provider.terminate(providerSessionInput({ binding }));
  const token = await provider.createAuthToken(providerTokenInput({ binding }));
  const shell = await provider.createShellToken(
    providerTokenInput({ binding, allowed_port_scope: [] }),
  );
  assert.equal(JSON.stringify([token, shell]).includes("issued"), false);
  assert.deepEqual(
    sent.map((entry) => entry.name),
    [
      "RunMicrovmCommand",
      "GetMicrovmCommand",
      "ListMicrovmsCommand",
      "SuspendMicrovmCommand",
      "GetMicrovmCommand",
      "ResumeMicrovmCommand",
      "GetMicrovmCommand",
      "TerminateMicrovmCommand",
      "GetMicrovmCommand",
      "CreateMicrovmAuthTokenCommand",
      "CreateMicrovmShellAuthTokenCommand",
    ],
  );
  assert.equal(sent[0].input.imageIdentifier, "image-ref");
  assert.equal(
    Object.hasOwn(sent[0].input, "runHookPayload"),
    false,
    "endpoint-dispatched MicroVM images must not receive AWS run-hook payloads",
  );
  assert.equal(
    sent[0].input.executionRoleArn,
    "arn:aws:iam::123456789012:role/HostMicrovmExecutionRole",
  );
  assert.deepEqual(sent.at(-2).input.allowedPorts, [{ port: 443 }]);
  await provider.run(
    providerRunInput({
      request_id: "req-run-disabled",
      session_id: "session-disabled",
    }),
  );
  assert.deepEqual(sent.at(-1).input.logging, { disabled: {} });
});

test("microvm real M16 operation contract validates route, token, and tenant safety", () => {
  const realLifecycle = defaultMicroVMRealLifecycleContract();
  validateMicroVMRealLifecycleContract(realLifecycle);
  assert.equal(
    realLifecycle.hooks.some((hook) => hook.name === MicroVMRealHook.Run),
    true,
  );
  assert.equal(
    realLifecycle.hooks.some((hook) => hook.name === MicroVMHook.Start),
    false,
  );

  const synthetic = defaultMicroVMRealLifecycleContract();
  synthetic.hooks.push({
    name: MicroVMHook.Start,
    phase: "synthetic",
    state: MicroVMRealState.Running,
    success_state: MicroVMRealState.Ready,
    failure_state: MicroVMRealState.Failed,
  });
  assert.throws(
    () => validateMicroVMRealLifecycleContract(synthetic),
    (err) => err?.code === MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE,
  );

  const contract = defaultMicroVMOperationContract();
  validateMicroVMOperationContract(contract);
  assert.deepEqual(contract.operations, [
    MicroVMOperation.Run,
    MicroVMOperation.Get,
    MicroVMOperation.List,
    MicroVMOperation.Suspend,
    MicroVMOperation.Resume,
    MicroVMOperation.Terminate,
    MicroVMOperation.Invoke,
    MicroVMOperation.AuthToken,
    MicroVMOperation.ShellToken,
  ]);

  const missingOperation = defaultMicroVMOperationContract();
  missingOperation.operations = missingOperation.operations.filter(
    (operation) => operation !== MicroVMOperation.ShellToken,
  );
  assert.throws(
    () => validateMicroVMOperationContract(missingOperation),
    (err) => err?.code === MICROVM_ERROR_OPERATION_CONTRACT_INCOMPLETE,
  );

  const unsafeRoute = defaultMicroVMOperationContract();
  unsafeRoute.routes[0].auth_required = false;
  assert.throws(
    () => validateMicroVMOperationContract(unsafeRoute),
    (err) => err?.code === MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
  );

  const unsafeToken = defaultMicroVMOperationContract();
  unsafeToken.token_issuance[0].result_fields.push("token_value");
  assert.throws(
    () => validateMicroVMOperationContract(unsafeToken),
    (err) => err?.code === MICROVM_ERROR_TOKEN_SAFETY_VIOLATION,
  );

  const unsafeTenant = defaultMicroVMOperationContract();
  unsafeTenant.tenant_binding[1].allowed = true;
  assert.throws(
    () => validateMicroVMOperationContract(unsafeTenant),
    (err) => err?.code === MICROVM_ERROR_TENANT_BINDING_VIOLATION,
  );

  const badProvider = defaultMicroVMOperationContract();
  badProvider.provider_state_mappings[0].state = "started";
  assert.throws(
    () => validateMicroVMOperationContract(badProvider),
    (err) => err?.code === MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE,
  );
});
test("microvm AWS provider invoke denies redirects and non-AWS endpoints", async () => {
  const provider = createAWSLambdaMicroVMProvider({
    clock: { now: () => new Date(0) },
  });
  const sent = [];
  provider.client = {
    async send(command) {
      sent.push(command.constructor.name);
      if (command.constructor.name === "CreateMicrovmAuthTokenCommand") {
        return { authToken: { "X-aws-proxy-auth": "provider-token-value" } };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };

  const invokeInput = (endpoint) => ({
    request_id: "req-invoke",
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_context: providerAuth(),
    binding: providerBinding(),
    endpoint,
    method: "POST",
    path: "/hello",
    query: { b: ["2"], a: ["1"] },
    headers: { "x-workload": ["ok"] },
    body: new Uint8Array([1, 2, 3]),
    port: 9090,
    ttl_seconds: 120,
  });
  const allowlisted = "https://provider-1.microvm.us-east-1.amazonaws.com";

  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    let firstInit;
    globalThis.fetch = async (target, init) => {
      calls += 1;
      firstInit = init;
      assert.equal(
        String(target),
        "https://provider-1.microvm.us-east-1.amazonaws.com/hello?a=1&b=2",
      );
      return new Response(new Uint8Array([9]), {
        status: 201,
        headers: { "content-type": "application/octet-stream" },
      });
    };
    const ok = await provider.invoke(invokeInput(allowlisted));
    assert.equal(ok.status, 201);
    assert.equal(ok.is_base64, true);
    assert.equal(calls, 1);
    assert.equal(firstInit.redirect, "manual");
    assert.equal(
      firstInit.headers.get("X-aws-proxy-auth"),
      "provider-token-value",
    );

    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example.com/steal" },
      });
    };
    await assert.rejects(
      () => provider.invoke(invokeInput(allowlisted)),
      (err) => err?.code === MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
    );
    assert.equal(calls, 1, "a cross-origin redirect must not be followed");

    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("fetch must not be called for a non-allowlisted endpoint");
    };
    sent.length = 0;
    await assert.rejects(
      () => provider.invoke(invokeInput("https://evil.example.com")),
      (err) => err?.code === MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
    );
    assert.equal(calls, 0);
    assert.deepEqual(sent, [], "the token must not be minted for a rejected endpoint");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("microvm AWS provider bounds invoke responses while reading", async () => {
  const provider = createAWSLambdaMicroVMProvider({
    clock: { now: () => new Date(0) },
  });
  provider.client = {
    async send(command) {
      if (command.constructor.name === "CreateMicrovmAuthTokenCommand") {
        return { authToken: { "X-aws-proxy-auth": "provider-token-value" } };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };

  const originalFetch = globalThis.fetch;
  try {
    let cancelled = false;
    const oversized = new Uint8Array(6 * 1024 * 1024 + 1);
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(oversized);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      );

    await assert.rejects(
      () =>
        provider.invoke({
          request_id: "req-invoke",
          tenant_id: "tenant-1",
          namespace: "namespace-1",
          auth_context: providerAuth(),
          binding: providerBinding(),
          endpoint: "https://provider-1.microvm.us-east-1.amazonaws.com",
          method: "GET",
          path: "/hello",
          headers: {},
          port: 9090,
          ttl_seconds: 120,
        }),
      (err) => err?.code === MICROVM_ERROR_PROVIDER_REQUEST_INVALID,
    );
    assert.equal(
      cancelled,
      true,
      "the response stream must be cancelled at the size bound",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pre-auth policy hook sees only the requested tenant", async () => {
  const policyViews = [];
  const handlerViews = [];
  const app = createApp({
    tier: "p2",
    authHook: () => "subject-1",
    policyHook: (ctx) => {
      policyViews.push({
        tenantId: ctx.tenantId,
        requestedTenantId: ctx.requestedTenantId,
      });
      return undefined;
    },
  });
  app.handle(
    "GET",
    "/secure",
    (ctx) => {
      handlerViews.push({
        tenantId: ctx.tenantId,
        requestedTenantId: ctx.requestedTenantId,
      });
      return {
        status: 200,
        headers: {},
        cookies: [],
        body: Buffer.from("ok", "utf8"),
        isBase64: false,
      };
    },
    { authRequired: true },
  );

  const response = await app.serve({
    method: "GET",
    path: "/secure",
    headers: { "x-tenant-id": ["caller-tenant"] },
    body: Buffer.alloc(0),
  });
  assert.equal(response.status, 200);

  assert.equal(policyViews.length, 1);
  assert.equal(policyViews[0].tenantId, "");
  assert.equal(policyViews[0].requestedTenantId, "caller-tenant");

  assert.equal(handlerViews.length, 1);
  assert.equal(handlerViews[0].tenantId, "caller-tenant");
  assert.equal(handlerViews[0].requestedTenantId, "caller-tenant");
});

const M3_OWNERSHIP_FIXTURE = JSON.parse(
  readFileSync(
    new URL(
      "../../contract-tests/conformance/microvm-list-ownership.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("M3 shared list-ownership fixture pins required cases and denial shapes", () => {
  assert.equal(M3_OWNERSHIP_FIXTURE.contract.id, "m3.microvm-list-ownership/v1");
  assert.equal(
    M3_OWNERSHIP_FIXTURE.errors.owner_mismatch.code,
    MICROVM_ERROR_SESSION_OWNER_MISMATCH,
  );
  assert.equal(M3_OWNERSHIP_FIXTURE.errors.owner_mismatch.status, 403);
  assert.equal(
    M3_OWNERSHIP_FIXTURE.errors.registry_incomplete,
    MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
  );
  const ids = new Set(M3_OWNERSHIP_FIXTURE.cases.map((item) => item.id));
  for (const id of [
    "list.same_subject_live_records_only",
    "list.empty_subject_returns_empty",
    "list.cross_subject_excluded",
    "list.ownerless_excluded",
    "list.canonical_precedence_over_legacy_duplicate",
    "list.caller_owned_legacy_duplicate_cannot_override_canonical_ownerless",
    "list.expired_records_excluded_before_provider",
    "controller.list.defense_in_depth_filters_registry_ignoring_subject",
    "keyed.owner_mismatch_preserves_denial_shape",
    "keyed.ownerless_record_preserves_registry_incomplete_shape",
    "keyed.ownerless_legacy_read_not_rekeyed_and_owned_rekey_preserves_owner",
    "write.existing_ownerless_record_not_adopted",
  ]) {
    assert.equal(ids.has(id), true, `fixture must carry ${id}`);
  }
});

test("M3 memory registry list applies exact owner, expiry, and canonical precedence", async () => {
  const now = new Date(2000);
  const registry = createMemoryMicroVMSessionRegistry({ now: () => now });
  const legacyPK = "TENANT#tenant-1#NAMESPACE#namespace-1";

  const put = async (overrides) => {
    const record = validRecord({ expires_at: new Date(4000), ...overrides });
    await registry.put(record);
    return record;
  };
  await put({ session_id: "own-live", auth_subject: "subject-a", endpoint: "canonical-live" });
  await put({ session_id: "session-other", auth_subject: "subject-b" });
  await put({ session_id: "own-expired", auth_subject: "subject-a", expires_at: new Date(1000) });
  await put({ session_id: "ownerless", auth_subject: "subject-a" });
  await put({ session_id: "prefer", auth_subject: "subject-a", endpoint: "canonical" });
  await put({ session_id: "dup", auth_subject: "subject-a" });

  const keys = [...registry.records.keys()];
  for (const key of keys) {
    const value = registry.records.get(key);
    if (value.session_id === "ownerless" || value.session_id === "dup") {
      registry.records.set(key, { ...value, auth_subject: "" });
    }
    if (value.session_id === "prefer") {
      registry.records.set("legacy-prefer", {
        ...value,
        pk: legacyPK,
        endpoint: "legacy",
      });
    }
    if (value.session_id === "dup") {
      registry.records.set("legacy-dup-owned", {
        ...value,
        pk: legacyPK,
        auth_subject: "subject-a",
        endpoint: "legacy-owned",
      });
    }
  }

  const ownerList = await registry.list({
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_subject: "subject-a",
  });
  assert.deepEqual(
    ownerList.map((item) => item.session_id),
    ["own-live", "prefer"],
  );
  assert.equal(
    ownerList.find((item) => item.session_id === "prefer").endpoint,
    "canonical",
    "canonical record wins over its legacy duplicate",
  );

  const emptySubject = await registry.list({
    tenant_id: "tenant-1",
    namespace: "namespace-1",
  });
  assert.deepEqual(emptySubject, []);

  const otherList = await registry.list({
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    auth_subject: "subject-b",
  });
  assert.deepEqual(
    otherList.map((item) => item.session_id),
    ["session-other"],
  );
});

test("M3 controller list defense in depth filters a subject-ignoring registry", async () => {
  const now = new Date(1000);
  const provider = createFakeMicroVMProvider(now);
  const originalList = provider.list.bind(provider);
  let known = [];
  provider.list = async (input) => {
    known = input.known_sessions;
    return originalList(input);
  };
  let puts = 0;
  const records = [
    validRecord({ session_id: "own-live", auth_subject: "subject-a", expires_at: new Date(4000) }),
    validRecord({ session_id: "other", auth_subject: "subject-b", expires_at: new Date(4000) }),
    { ...validRecord({ session_id: "ownerless", expires_at: new Date(4000) }), auth_subject: "" },
  ];
  const registry = {
    async put(record) {
      puts += 1;
      return record;
    },
    async get() {
      throw new MicroVMSafeError(
        MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
        "not found",
        "",
      );
    },
    async delete() {},
    async list() {
      return records;
    },
  };
  const controller = createRealMicroVMController(provider, registry, {
    controller_id: "controller-1",
    provider_id: MICROVM_AWS_LAMBDA_PROVIDER_ID,
    clock: { now: () => now },
    ttl_ms: 60_000,
    logging: { disabled: true },
  });
  const response = await controller.handle(
    controllerRequest({
      command: MicroVMCommand.List,
      request_id: "req-defense",
      session_id: "",
      auth_context: {
        subject: "subject-a",
        tenant_id: "tenant-1",
        namespace: "namespace-1",
      },
    }),
  );
  assert.equal(response.error, undefined);
  assert.equal(known.length, 1);
  assert.equal(known[0].session_id, "own-live");
  assert.equal(puts, 0);
});

