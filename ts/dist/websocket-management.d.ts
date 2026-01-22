export interface WebSocketCall {
    op: "post_to_connection" | "get_connection" | "delete_connection";
    connectionId: string;
    data: Uint8Array | null;
}
export declare class WebSocketManagementClient {
    readonly endpoint: string;
    readonly region: string;
    private readonly _credentials;
    constructor(options?: {
        endpoint?: string;
        region?: string;
        credentials?: unknown;
    });
    postToConnection(connectionId: string, data: Uint8Array): Promise<void>;
    getConnection(connectionId: string): Promise<unknown>;
    deleteConnection(connectionId: string): Promise<void>;
}
export declare class FakeWebSocketManagementClient {
    readonly endpoint: string;
    readonly calls: WebSocketCall[];
    readonly connections: Map<string, unknown>;
    postError: Error | null;
    getError: Error | null;
    deleteError: Error | null;
    constructor(options?: {
        endpoint?: string;
    });
    postToConnection(connectionId: string, data: Uint8Array): Promise<void>;
    getConnection(connectionId: string): Promise<unknown>;
    deleteConnection(connectionId: string): Promise<void>;
}
