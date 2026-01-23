export type AwsCredentials = {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
};
export declare function isAwsCredentials(value: unknown): value is AwsCredentials;
export declare function loadEnvCredentials(): AwsCredentials;
type SignedFetchOptions = {
    method: string;
    url: string;
    region: string;
    service: string;
    credentials: AwsCredentials;
    headers: Record<string, string>;
    body?: Uint8Array;
};
export declare function signedFetch({ method, url, region, service, credentials, headers, body, }: SignedFetchOptions): Promise<Response>;
export {};
