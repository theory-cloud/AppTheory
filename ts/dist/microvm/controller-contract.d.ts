import { type MicroVMControllerAuthContract, type MicroVMControllerContract, type MicroVMCommandName, type MicroVMSessionRegistryContract } from "./model.js";
export declare function defaultMicroVMControllerContract(): MicroVMControllerContract;
export declare function defaultMicroVMSessionRegistryContract(): MicroVMSessionRegistryContract;
export declare function validateMicroVMControllerContract(contract: MicroVMControllerContract): void;
export declare function validateMicroVMSessionRegistryContract(registry: MicroVMSessionRegistryContract): void;
export declare function microVMControllerAuthDefaultsDeny(auth: MicroVMControllerAuthContract): boolean;
export declare function normalizeMicroVMCommand(command: MicroVMCommandName | string): MicroVMCommandName | "";
export declare function requiredMicroVMControllerCommands(): MicroVMCommandName[];
export declare function realMicroVMControllerCommands(): MicroVMCommandName[];
export declare function isRequiredMicroVMCommand(command: string): command is MicroVMCommandName;
export declare function validMicroVMCommand(command: string): boolean;
export declare function requiredMicroVMSessionRegistryContractFields(): string[];
export declare function validMicroVMLifecycleState(state: string): boolean;
//# sourceMappingURL=controller-contract.d.ts.map