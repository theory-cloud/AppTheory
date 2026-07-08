export const MICROVM_CONTRACT_NAME = "apptheory.lambda_microvm";
export const MICROVM_CONTRACT_VERSION = "m15.microvm/v1";
export const MICROVM_ENV_EXECUTION_ROLE_ARN = "APPTHEORY_MICROVM_EXECUTION_ROLE_ARN";
export const MICROVM_ENV_IMAGE_REF = "APPTHEORY_MICROVM_IMAGE_REF";
export const MICROVM_ENV_NETWORK_CONNECTOR_REFS = "APPTHEORY_MICROVM_NETWORK_CONNECTOR_REFS";
export const MICROVM_ENV_INGRESS_NETWORK_CONNECTOR_REFS = "APPTHEORY_MICROVM_INGRESS_NETWORK_CONNECTOR_REFS";
export const MICROVM_ENV_EGRESS_NETWORK_CONNECTOR_REFS = "APPTHEORY_MICROVM_EGRESS_NETWORK_CONNECTOR_REFS";
export const MICROVM_ERROR_INVALID_CONTRACT = "m15.microvm.invalid_contract";
export const MICROVM_ERROR_RAW_SDK_ESCAPE_HATCH = "m15.microvm.raw_sdk_escape_hatch";
export const MICROVM_ERROR_LIFECYCLE_BYPASS = "m15.microvm.lifecycle_bypass";
export const MICROVM_ERROR_LIFECYCLE_INCOMPLETE = "m15.microvm.lifecycle_incomplete";
export const MICROVM_ERROR_FORBIDDEN_FIELD = "m15.microvm.forbidden_field";
export const MICROVM_ERROR_INVALID_LIFECYCLE_EVENT = "m15.microvm.invalid_lifecycle_event";
export const MICROVM_ERROR_LIFECYCLE_HOOK_FAILED = "m15.microvm.lifecycle_hook_failed";
export const MicroVMHook = {
    PrepareImage: "prepare_image",
    Start: "start",
    Readiness: "readiness",
    Stop: "stop",
    Teardown: "teardown",
    Failure: "failure",
};
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
};
export class MicroVMSafeError extends Error {
    code;
    request_id;
    constructor(code, message, requestID = "") {
        super(String(message ?? "").trim());
        this.name = "MicroVMSafeError";
        this.code = String(code ?? "").trim();
        const trimmedRequestID = String(requestID ?? "").trim();
        if (trimmedRequestID)
            this.request_id = trimmedRequestID;
    }
}
export const MICROVM_CONTRACT_VERSION_M16 = "m16.microvm/v1";
export const MICROVM_ERROR_OPERATION_CONTRACT_INCOMPLETE = "m16.microvm.operation_contract_incomplete";
export const MICROVM_ERROR_ROUTE_CONTRACT_INCOMPLETE = "m16.microvm.route_contract_incomplete";
export const MICROVM_ERROR_PROVIDER_STATE_MAPPING_INCOMPLETE = "m16.microvm.provider_state_mapping_incomplete";
export const MICROVM_ERROR_TOKEN_SAFETY_VIOLATION = "m16.microvm.token_safety_violation";
export const MICROVM_ERROR_TENANT_BINDING_VIOLATION = "m16.microvm.tenant_binding_violation";
export const MICROVM_ERROR_REAL_LIFECYCLE_INCOMPLETE = "m16.microvm.lifecycle_incomplete";
export const MicroVMOperation = {
    Run: "run",
    Get: "get",
    List: "list",
    Suspend: "suspend",
    Resume: "resume",
    Terminate: "terminate",
    Invoke: "invoke",
    AuthToken: "auth-token",
    ShellAuthToken: "shell-auth-token",
    ShellToken: "shell-auth-token",
};
export const MicroVMRealHook = {
    Validate: "validate",
    Run: "run",
    Ready: "ready",
    Suspend: "suspend",
    Resume: "resume",
    Terminate: "terminate",
    Failure: "failure",
};
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
};
export const MICROVM_ERROR_PROVIDER_REQUEST_INVALID = "m16.microvm.provider_request_invalid";
export const MICROVM_ERROR_PROVIDER_OPERATION_UNSUPPORTED = "m16.microvm.provider_operation_unsupported";
export const MICROVM_ERROR_PROVIDER_OPERATION_FAILED = "m16.microvm.provider_operation_failed";
export const MICROVM_ERROR_UNAUTHENTICATED_CONTROLLER = "m15.microvm.unauthenticated_controller";
export const MICROVM_ERROR_CONTROLLER_INCOMPLETE = "m15.microvm.controller_incomplete";
export const MICROVM_ERROR_SESSION_REGISTRY_INCOMPLETE = "m15.microvm.session_registry_incomplete";
export const MICROVM_ERROR_INVALID_CONTROLLER_REQUEST = "m15.microvm.invalid_controller_request";
export const MICROVM_ERROR_CONTROLLER_COMMAND_FAILED = "m15.microvm.controller_command_failed";
export const MICROVM_CONTROLLER_AUTH_DEFAULT_DENY = "deny";
export const MICROVM_SESSION_REGISTRY_MODEL_NAME = "MicroVMSessionRegistryRecord";
export const MICROVM_SESSION_REGISTRY_TABLE_NAME = "apptheory-microvm-sessions";
export const MICROVM_SESSION_REGISTRY_TABLE_ENV = "APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE";
export const MICROVM_DEFAULT_SESSION_PROVIDER_ID = "apptheory.microvm.registry";
export const MICROVM_AWS_LAMBDA_PROVIDER_ID = "aws.lambda.microvm";
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
    Invoke: "invoke",
    AuthToken: "auth-token",
    ShellAuthToken: "shell-auth-token",
    ShellToken: "shell-auth-token",
};
//# sourceMappingURL=model.js.map