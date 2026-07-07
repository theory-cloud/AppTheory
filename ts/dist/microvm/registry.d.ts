import { type MicroVMSessionKey, type MicroVMSessionListInput, type MicroVMSessionRecord, type MicroVMSessionReconstructionHook, type MicroVMSessionReconstructionRequest, type MicroVMSessionRegistry, type MicroVMTableTheoryClient, type ReconstructingMicroVMSessionRegistryOptions, type TableTheoryMicroVMSessionRegistryOptions } from "./model.js";
export declare class MemoryMicroVMSessionRegistry implements MicroVMSessionRegistry {
    private readonly records;
    put(record: MicroVMSessionRecord): Promise<MicroVMSessionRecord>;
    get(key: MicroVMSessionKey): Promise<MicroVMSessionRecord>;
    delete(key: MicroVMSessionKey): Promise<void>;
    list(input: MicroVMSessionListInput): Promise<MicroVMSessionRecord[]>;
}
export declare function createMemoryMicroVMSessionRegistry(): MemoryMicroVMSessionRegistry;
export declare function reconstructMicroVMSessionRecord(request: MicroVMSessionReconstructionRequest, hook?: MicroVMSessionReconstructionHook | null): Promise<MicroVMSessionRecord>;
export declare class ReconstructingMicroVMSessionRegistry implements MicroVMSessionRegistry {
    private readonly registry;
    private readonly hook;
    private readonly staleAfterMs;
    private readonly clock;
    constructor(registry: MicroVMSessionRegistry, hook: MicroVMSessionReconstructionHook, options?: ReconstructingMicroVMSessionRegistryOptions);
    put(record: MicroVMSessionRecord): Promise<MicroVMSessionRecord>;
    get(key: MicroVMSessionKey): Promise<MicroVMSessionRecord>;
    delete(key: MicroVMSessionKey): Promise<void>;
    list(input: MicroVMSessionListInput): Promise<MicroVMSessionRecord[]>;
}
export declare function createReconstructingMicroVMSessionRegistry(registry: MicroVMSessionRegistry, hook: MicroVMSessionReconstructionHook, options?: ReconstructingMicroVMSessionRegistryOptions): ReconstructingMicroVMSessionRegistry;
export declare class TableTheoryMicroVMSessionRegistry implements MicroVMSessionRegistry {
    private readonly db;
    private readonly modelName;
    constructor(db: MicroVMTableTheoryClient, options?: TableTheoryMicroVMSessionRegistryOptions);
    put(record: MicroVMSessionRecord): Promise<MicroVMSessionRecord>;
    get(key: MicroVMSessionKey): Promise<MicroVMSessionRecord>;
    delete(key: MicroVMSessionKey): Promise<void>;
    list(input: MicroVMSessionListInput): Promise<MicroVMSessionRecord[]>;
}
export declare function createTableTheoryMicroVMSessionRegistry(db: MicroVMTableTheoryClient, options?: TableTheoryMicroVMSessionRegistryOptions): TableTheoryMicroVMSessionRegistry;
//# sourceMappingURL=registry.d.ts.map