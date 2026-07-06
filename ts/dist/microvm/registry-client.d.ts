import { type MicroVMClient, type MicroVMRegistryClientOptions, type MicroVMSessionCommandInput, type MicroVMSessionQueryInput, type MicroVMSessionRecord, type MicroVMSessionRegistry, type MicroVMSessionStatus, type MicroVMCreateSessionInput } from "./model.js";
export declare class MicroVMRegistryClient implements MicroVMClient {
    private readonly registry;
    private readonly ttlMs;
    constructor(registry: MicroVMSessionRegistry, options?: MicroVMRegistryClientOptions);
    create(input: MicroVMCreateSessionInput): Promise<MicroVMSessionRecord>;
    start(input: MicroVMSessionCommandInput): Promise<MicroVMSessionRecord>;
    stop(input: MicroVMSessionCommandInput): Promise<MicroVMSessionRecord>;
    status(input: MicroVMSessionQueryInput): Promise<MicroVMSessionStatus>;
    session(input: MicroVMSessionQueryInput): Promise<MicroVMSessionRecord>;
    private transition;
}
export declare function createMicroVMRegistryClient(registry: MicroVMSessionRegistry, options?: MicroVMRegistryClientOptions): MicroVMRegistryClient;
//# sourceMappingURL=registry-client.d.ts.map