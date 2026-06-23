import test from "node:test";
import assert from "node:assert/strict";

import {
  MICROVM_ERROR_CONTROLLER_COMMAND_FAILED,
  MICROVM_ERROR_CONTROLLER_INCOMPLETE,
  MICROVM_ERROR_FORBIDDEN_FIELD,
  MICROVM_ERROR_INVALID_CONTROLLER_REQUEST,
  MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
  MICROVM_ERROR_LIFECYCLE_BYPASS,
  MICROVM_ERROR_LIFECYCLE_HOOK_FAILED,
  MICROVM_ERROR_LIFECYCLE_INCOMPLETE,
  MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH,
  MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE,
  MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
  MicroVMCommand,
  MicroVMHook,
  MicroVMSafeError,
  MicroVMState,
  createAWSLambdaMicroVMClient,
  createFakeMicroVMClient,
  createMicroVMController,
  createMicroVMLifecycleAdapter,
  defaultMicroVMControllerContract,
  defaultMicroVMLifecycleContract,
  defaultMicroVMSessionRegistryContract,
  isMicroVMTerminalState,
  microVMSessionKey,
  validateMicroVMControllerContract,
  validateMicroVMControllerRequest,
  validateMicroVMEscapeHatches,
  validateMicroVMLifecycleContract,
  validateMicroVMSessionRecord,
  validateMicroVMSessionRegistryContract,
  validateMicroVMSessionStatus,
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

function validRecord(overrides = {}) {
  return {
    tenant_id: "tenant-1",
    namespace: "namespace-1",
    session_id: "session-1",
    state: MicroVMState.Requested,
    desired_state: MicroVMState.Requested,
    image_ref: "image-ref",
    network_connector_ref: "network-ref",
    controller_id: "controller-1",
    created_at: new Date(1000),
    updated_at: new Date(1000),
    expires_at: new Date(3_601_000),
    generation: 1,
    last_command_id: "req-record",
    auth_subject: "subject-1",
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
    last_transition: new Date(1000),
    registry_version: 1,
    ...overrides,
  };
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
    (await adapter.handle(lifecycleEvent({ hook: MicroVMHook.Readiness }))).error?.code,
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
    (await createMicroVMLifecycleAdapter().handle(lifecycleEvent())).error?.code,
    MICROVM_ERROR_INVALID_LIFECYCLE_EVENT,
  );
  assert.equal(
    (
      await createMicroVMLifecycleAdapter({
        handlers: { [MicroVMHook.PrepareImage]: () => { throw new Error("raw"); } },
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
    (await adapter.handle(lifecycleEvent({ metadata: { authorization: "secret" } }))).error?.code,
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
  missingState.states = missingState.states.filter((state) => state !== MicroVMState.Ready);
  assert.throws(() => validateMicroVMLifecycleContract(missingState));

  const missingTerminal = defaultMicroVMLifecycleContract();
  missingTerminal.terminal_states = [MicroVMState.Terminated];
  assert.throws(() => validateMicroVMLifecycleContract(missingTerminal));

  const missingActiveTransition = defaultMicroVMLifecycleContract();
  missingActiveTransition.transitions = missingActiveTransition.transitions.filter(
    (transition) =>
      !(
        transition.from === MicroVMState.Requested &&
        transition.hook === MicroVMHook.PrepareImage &&
        transition.to === MicroVMState.ImagePreparing
      ),
  );
  assert.throws(() => validateMicroVMLifecycleContract(missingActiveTransition));

  const missingSuccessTransition = defaultMicroVMLifecycleContract();
  missingSuccessTransition.transitions = missingSuccessTransition.transitions.filter(
    (transition) =>
      !(
        transition.from === MicroVMState.ImagePreparing &&
        transition.hook === MicroVMHook.PrepareImage &&
        transition.to === MicroVMState.ImagePrepared
      ),
  );
  assert.throws(() => validateMicroVMLifecycleContract(missingSuccessTransition));

  const missingFailureTransition = defaultMicroVMLifecycleContract();
  missingFailureTransition.transitions = missingFailureTransition.transitions.filter(
    (transition) =>
      !(
        transition.from === MicroVMState.ImagePreparing &&
        transition.hook === MicroVMHook.Failure &&
        transition.to === MicroVMState.Failed
      ),
  );
  assert.throws(() => validateMicroVMLifecycleContract(missingFailureTransition));
});

test("microvm controller, registry, record, and request contracts fail closed", () => {
  validateMicroVMControllerContract(defaultMicroVMControllerContract());
  validateMicroVMSessionRegistryContract(defaultMicroVMSessionRegistryContract());
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
    (contract) => { contract.envelope.required_fields = []; },
    (contract) => { contract.envelope.safe_error_fields = []; },
    (contract) => { contract.envelope.forbidden_fields = []; },
    (contract) => { contract.commands[0].method = ""; },
    (contract) => { contract.commands[0].response_fields = []; },
    (contract) => { contract.commands = contract.commands.slice(0, -1); },
  ]) {
    const contract = defaultMicroVMControllerContract();
    mutate(contract);
    assert.throws(
      () => validateMicroVMControllerContract(contract),
      (err) => err?.code === MICROVM_ERROR_CONTROLLER_INCOMPLETE,
    );
  }

  for (const mutate of [
    (registry) => { registry.pattern = "raw-sdk-table"; },
    (registry) => { registry.tenant_binding = ["tenant_id"]; },
    (registry) => { registry.required_fields = registry.required_fields.slice(0, -1); },
    (registry) => { registry.state_values = registry.state_values.slice(0, -1); },
    (registry) => { registry.forbidden_fields = ["raw_aws_credentials"]; },
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
    validRecord({ state: "unknown" }),
    validRecord({ metadata: { "bearer-token": "secret" } }),
  ]) {
    assert.throws(
      () => validateMicroVMSessionRecord(record),
      (err) => err?.code === MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE || err?.code === MICROVM_ERROR_FORBIDDEN_FIELD,
    );
  }

  for (const status of [
    validStatus({ session_id: "" }),
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
    auth_context: { subject: "subject-1", tenant_id: "tenant-1", namespace: "namespace-1" },
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
      auth_context: { subject: "subject-1", tenant_id: "tenant-1", namespace: "other" },
    })?.code,
    MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER,
  );
  assert.equal(
    validateMicroVMControllerRequest({
      ...baseRequest,
      auth_context: { subject: "subject-1", tenant_id: "tenant-1", metadata: { authorization: "secret" } },
    })?.code,
    MICROVM_ERROR_FORBIDDEN_FIELD,
  );
  assert.equal(
    validateMicroVMControllerRequest({
      ...baseRequest,
      session_spec: { metadata: { raw_sdk_client: "secret" } },
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
    validateMicroVMControllerRequest({ ...baseRequest, command: "reboot" })?.code,
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
  assert.deepEqual(client.calls().map((call) => call.command), [
    MicroVMCommand.Create,
    MicroVMCommand.Start,
    MicroVMCommand.Status,
    MicroVMCommand.Session,
    MicroVMCommand.Stop,
  ]);
  await assert.rejects(() => client.create(createInput()), /session already exists/);
  await assert.rejects(() => client.status(queryInput({ session_id: "missing" })), /session not found/);

  const failingClient = {
    async create() { throw new MicroVMSafeError("safe", "safe"); },
    async start() { throw new Error("raw start"); },
    async stop() { throw new Error("raw stop"); },
    async status() { throw new Error("raw status"); },
    async session() { throw new Error("raw session"); },
  };
  const failingController = createMicroVMController(failingClient, {
    ids: { newID: () => "session-x" },
  });
  assert.equal(
    (await failingController.handle({
      command: MicroVMCommand.Create,
      request_id: "req-safe",
      tenant_id: "tenant-1",
      namespace: "namespace-1",
      auth_context: { subject: "subject-1", tenant_id: "tenant-1" },
      image_ref: "image-ref",
      network_connector_ref: "network-ref",
    })).error?.code,
    "safe",
  );
  assert.equal(
    (await failingController.handle({
      command: MicroVMCommand.Start,
      request_id: "req-fail",
      tenant_id: "tenant-1",
      namespace: "namespace-1",
      auth_context: { subject: "subject-1", tenant_id: "tenant-1" },
      session_id: "session-x",
    })).error?.code,
    MICROVM_ERROR_CONTROLLER_COMMAND_FAILED,
  );
});

test("microvm AWS Lambda client factory fails closed without SDK support", async () => {
  await assert.rejects(
    () => createAWSLambdaMicroVMClient(),
    (err) => err?.code === MICROVM_ERROR_CONTROLLER_INCOMPLETE,
  );
});
