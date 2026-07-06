import { MicroVMSafeError } from "./model.js";
export function safeError(code, message, requestID) {
    return new MicroVMSafeError(code, message, requestID);
}
//# sourceMappingURL=errors.js.map