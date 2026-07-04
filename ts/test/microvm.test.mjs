import test from "node:test";
import assert from "node:assert/strict";

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
  MICROVM_ENV_EXECUTION_ROLE_ARN,
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
    "TENANT#tenant-1#NAMESPACE#namespace-1",
  );
  assert.equal(microVMSessionRegistryPartitionKey("", "namespace-1"), "");
  assert.equal(
    microVMSessionRegistrySortKey(" session-1 "),
    "SESSION#session-1",
  );
  assert.equal(microVMSessionRegistrySortKey(""), "");

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
  assert.equal(registry.pk, "TENANT#tenant-1#NAMESPACE#namespace-1");
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
        pk: "TENANT#tenant-1#NAMESPACE#namespace-1",
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
  assert.equal(saved[0].item.pk, "TENANT#tenant-1#NAMESPACE#namespace-1");
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
  const registry = createMemoryMicroVMSessionRegistry();
  const controller = createRealMicroVMController(provider, registry, {
    controller_id: "controller-1",
    provider_id: MICROVM_AWS_LAMBDA_PROVIDER_ID,
    ids: { newID: () => "session-1" },
    clock: { now: () => new Date(1000) },
    ttl_ms: 60_000,
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

test("microvm real controller carries execution role from environment", async () => {
  const roleArn = "arn:aws:iam::123456789012:role/HostMicrovmExecutionRole";
  const previous = process.env[MICROVM_ENV_EXECUTION_ROLE_ARN];
  process.env[MICROVM_ENV_EXECUTION_ROLE_ARN] = roleArn;
  try {
    const baseProvider = createFakeMicroVMProvider(new Date(0));
    let recordedExecutionRoleArn = "";
    const provider = {
      run: async (input) => {
        recordedExecutionRoleArn = String(input.execution_role_arn ?? "");
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
  } finally {
    if (previous === undefined) {
      delete process.env[MICROVM_ENV_EXECUTION_ROLE_ARN];
    } else {
      process.env[MICROVM_ENV_EXECUTION_ROLE_ARN] = previous;
    }
  }
});

test("microvm controller route adapter enforces auth and tenant binding", async () => {
  const provider = createFakeMicroVMProvider(new Date(0));
  const registry = createMemoryMicroVMSessionRegistry();
  const controller = createRealMicroVMController(provider, registry, {
    ids: { newID: () => "route-session" },
    clock: { now: () => new Date(1000) },
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
    }),
  );
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
    sent[0].input.executionRoleArn,
    "arn:aws:iam::123456789012:role/HostMicrovmExecutionRole",
  );
  assert.deepEqual(sent.at(-2).input.allowedPorts, [{ port: 443 }]);
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
