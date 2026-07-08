import { type CreateMicrovmAuthTokenCommandInput } from "@aws-sdk/client-lambda-microvms";
import { type AWSLambdaMicroVMClientOptions, type AWSLambdaMicroVMProviderOptions, type MicroVMClient, type MicroVMProvider, type MicroVMProviderListInput, type MicroVMProviderListOutput, type MicroVMProviderInvokeInput, type MicroVMProviderInvokeOutput, type MicroVMProviderPortScope, type MicroVMProviderRunInput, type MicroVMProviderSession, type MicroVMProviderSessionBinding, type MicroVMProviderSessionInput, type MicroVMProviderToken, type MicroVMProviderTokenInput } from "./model.js";
export declare function createAWSLambdaMicroVMClient(_options?: AWSLambdaMicroVMClientOptions): Promise<MicroVMClient>;
export declare class AWSLambdaMicroVMProvider implements MicroVMProvider {
    private readonly client;
    private readonly clock;
    constructor(options?: AWSLambdaMicroVMProviderOptions);
    run(input: MicroVMProviderRunInput): Promise<MicroVMProviderSession>;
    get(input: MicroVMProviderSessionInput): Promise<MicroVMProviderSession>;
    list(input: MicroVMProviderListInput): Promise<MicroVMProviderListOutput>;
    suspend(input: MicroVMProviderSessionInput): Promise<MicroVMProviderSession>;
    resume(input: MicroVMProviderSessionInput): Promise<MicroVMProviderSession>;
    terminate(input: MicroVMProviderSessionInput): Promise<MicroVMProviderSession>;
    invoke(input: MicroVMProviderInvokeInput): Promise<MicroVMProviderInvokeOutput>;
    createAuthToken(input: MicroVMProviderTokenInput): Promise<MicroVMProviderToken>;
    createShellToken(input: MicroVMProviderTokenInput): Promise<MicroVMProviderToken>;
    private runStateChangingOperation;
    private now;
}
export declare function createAWSLambdaMicroVMProvider(options?: AWSLambdaMicroVMProviderOptions): AWSLambdaMicroVMProvider;
export declare function microVMProviderSessionFromRunOutput(input: MicroVMProviderRunInput, output: unknown): MicroVMProviderSession;
export declare function microVMProviderSessionFromGetOutput(requestID: string, binding: MicroVMProviderSessionBinding, output: unknown): MicroVMProviderSession;
export declare function microVMProviderListOutputFromSDK(input: MicroVMProviderListInput, output: unknown): MicroVMProviderListOutput;
export declare function microVMProviderSessionFromProviderState(binding: MicroVMProviderSessionBinding, providerState: string, endpoint: string, imageRef: string, imageVersion: string, startedAt: Date | null, terminatedAt: Date | null): MicroVMProviderSession;
export declare function awsMicroVMPortScopes(scopes: MicroVMProviderPortScope[]): NonNullable<CreateMicrovmAuthTokenCommandInput["allowedPorts"]>;
export declare function ensureMicroVMProviderTokenResult(output: unknown, requestID: string): void;
export declare function providerExpirationMinutes(ttlSeconds: number): number;
export declare function arrayField(value: unknown, key: string): unknown[];
export declare function asRecord(value: unknown): Record<string, unknown>;
export declare function stringField(value: unknown, key: string): string;
export declare function dateField(value: unknown, key: string): Date | null;
//# sourceMappingURL=aws-provider.d.ts.map