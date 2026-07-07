import { MicroVMSafeError } from "./model.js";

export function safeError(
  code: string,
  message: string,
  requestID: string,
): MicroVMSafeError {
  return new MicroVMSafeError(code, message, requestID);
}
