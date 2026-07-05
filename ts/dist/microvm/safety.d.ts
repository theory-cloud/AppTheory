import { type MicroVMSafeError } from "./model.js";
export declare const FORBIDDEN_MICROVM_FIELD_NAMES: Set<string>;
export declare function forbiddenMicroVMFieldName(name: string): boolean;
export declare function validateSafeMicroVMMetadata(metadata: Record<string, string> | undefined, requestID: string): MicroVMSafeError | null;
export declare function validateSafeMicroVMFieldValue(value: string, requestID: string): MicroVMSafeError | null;
export declare function forbiddenMicroVMFieldValue(value: string): boolean;
export declare function cloneStringMap(input: Record<string, string> | undefined): Record<string, string> | undefined;
export declare function missingStrings(required: string[], got: string[]): string[];
//# sourceMappingURL=safety.d.ts.map