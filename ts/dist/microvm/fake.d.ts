import { MicroVMSafeError, type MicroVMClient, type MicroVMClientCall, type MicroVMCreateSessionInput, type MicroVMOperationName, type MicroVMProvider, type MicroVMProviderCall, type MicroVMProviderListInput, type MicroVMProviderListOutput, type MicroVMProviderRunInput, type MicroVMProviderSession, type MicroVMProviderSessionInput, type MicroVMProviderToken, type MicroVMProviderTokenInput, type MicroVMSessionCommandInput, type MicroVMSessionQueryInput, type MicroVMSessionRecord, type MicroVMSessionStatus } from "./model.js";
export declare class FakeMicroVMClient implements MicroVMClient {
    private currentTime;
    private readonly sessions;
    private readonly recordedCalls;
    constructor(now?: Date);
    setNow(now: Date): void;
    calls(): MicroVMClientCall[];
    create(input: MicroVMCreateSessionInput): Promise<MicroVMSessionRecord>;
    start(input: MicroVMSessionCommandInput): Promise<MicroVMSessionRecord>;
    stop(input: MicroVMSessionCommandInput): Promise<MicroVMSessionRecord>;
    status(input: MicroVMSessionQueryInput): Promise<MicroVMSessionStatus>;
    session(input: MicroVMSessionQueryInput): Promise<MicroVMSessionRecord>;
    private transition;
    private lookup;
    private recordCall;
}
export declare function createFakeMicroVMClient(now?: Date): FakeMicroVMClient;
export declare class FakeMicroVMProvider implements MicroVMProvider {
    private currentTime;
    private next;
    private tokens;
    private readonly sessions;
    private readonly errors;
    private readonly recordedCalls;
    constructor(now?: Date);
    setNow(now: Date): void;
    setOperationError(operation: MicroVMOperationName | string, err?: MicroVMSafeError | null): void;
    calls(): MicroVMProviderCall[];
    run(input: MicroVMProviderRunInput): Promise<MicroVMProviderSession>;
    get(input: MicroVMProviderSessionInput): Promise<MicroVMProviderSession>;
    list(input: MicroVMProviderListInput): Promise<MicroVMProviderListOutput>;
    suspend(input: MicroVMProviderSessionInput): Promise<MicroVMProviderSession>;
    resume(input: MicroVMProviderSessionInput): Promise<MicroVMProviderSession>;
    terminate(input: MicroVMProviderSessionInput): Promise<MicroVMProviderSession>;
    createAuthToken(input: MicroVMProviderTokenInput): Promise<MicroVMProviderToken>;
    createShellToken(input: MicroVMProviderTokenInput): Promise<MicroVMProviderToken>;
    private lookup;
    private transition;
    private token;
    private boundSession;
    private configuredError;
    private recordCall;
}
export declare function createFakeMicroVMProvider(now?: Date): FakeMicroVMProvider;
//# sourceMappingURL=fake.d.ts.map