import { type App } from "./app.js";
import type { ALBTargetGroupRequest, ALBTargetGroupResponse, APIGatewayProxyResponse, APIGatewayProxyRequest, APIGatewayV2HTTPRequest, APIGatewayV2HTTPResponse, DynamoDBStreamEvent, DynamoDBStreamEventResponse, DynamoDBStreamRecord, EventBridgeEvent, KinesisEventResponse, KinesisEvent, KinesisEventRecordInput, LambdaFunctionURLResponse, LambdaFunctionURLRequest, SNSEvent, SQSEventResponse, SNSEventRecordInput, SQSEvent, SQSMessage } from "./aws-types.js";
import { ManualClock } from "./clock.js";
import { ManualIdGenerator } from "./ids.js";
import type { Headers, Query, Request, Response } from "./types.js";
export declare class TestEnv {
    readonly clock: ManualClock;
    readonly ids: ManualIdGenerator;
    constructor(options?: {
        now?: Date;
    });
    app(options?: Record<string, unknown>): App;
    invoke(app: App, request: Request, ctx?: unknown): Promise<Response>;
    invokeStreaming(app: App, request: Request, ctx?: unknown): Promise<{
        status: number;
        headers: Headers;
        cookies: string[];
        chunks: Uint8Array[];
        body: Uint8Array;
        is_base64: boolean;
        stream_error_code: string;
    }>;
    invokeAPIGatewayV2(app: App, event: APIGatewayV2HTTPRequest, ctx?: unknown): Promise<APIGatewayV2HTTPResponse>;
    invokeLambdaFunctionURL(app: App, event: LambdaFunctionURLRequest, ctx?: unknown): Promise<LambdaFunctionURLResponse>;
    invokeLambdaFunctionURLStreaming(app: App, event: LambdaFunctionURLRequest, ctx?: unknown): Promise<{
        status: number;
        headers: Headers;
        cookies: string[];
        chunks: Uint8Array[];
        body: Uint8Array;
        is_base64: boolean;
        stream_error_code: string;
    }>;
    invokeAPIGatewayProxy(app: App, event: APIGatewayProxyRequest, ctx?: unknown): Promise<APIGatewayProxyResponse>;
    invokeALB(app: App, event: ALBTargetGroupRequest, ctx?: unknown): Promise<ALBTargetGroupResponse>;
    invokeSQS(app: App, event: SQSEvent, ctx?: unknown): Promise<SQSEventResponse>;
    invokeEventBridge(app: App, event: EventBridgeEvent, ctx?: unknown): Promise<unknown>;
    invokeDynamoDBStream(app: App, event: DynamoDBStreamEvent, ctx?: unknown): Promise<DynamoDBStreamEventResponse>;
    invokeKinesis(app: App, event: KinesisEvent, ctx?: unknown): Promise<KinesisEventResponse>;
    invokeSNS(app: App, event: SNSEvent, ctx?: unknown): Promise<unknown[]>;
    invokeLambda(app: App, event: unknown, ctx?: unknown): Promise<unknown>;
}
export declare function createTestEnv(options?: {
    now?: Date;
}): TestEnv;
export declare function buildAPIGatewayV2Request(method: string, path: string, options?: {
    query?: Query;
    headers?: Record<string, string>;
    cookies?: string[];
    body?: Uint8Array | string;
    isBase64?: boolean;
}): APIGatewayV2HTTPRequest;
export declare function buildLambdaFunctionURLRequest(method: string, path: string, options?: {
    query?: Query;
    headers?: Record<string, string>;
    cookies?: string[];
    body?: Uint8Array | string;
    isBase64?: boolean;
}): LambdaFunctionURLRequest;
export declare function buildALBTargetGroupRequest(method: string, path: string, options?: {
    query?: Query;
    headers?: Record<string, string>;
    multiHeaders?: Headers;
    body?: Uint8Array | string;
    isBase64?: boolean;
    targetGroupArn?: string;
}): ALBTargetGroupRequest;
export declare function buildSQSEvent(queueArn: string, records?: Array<Partial<SQSMessage>>): SQSEvent;
export declare function buildEventBridgeEvent(options?: {
    ruleArn?: string;
    resources?: string[];
    version?: string;
    id?: string;
    source?: string;
    detailType?: string;
    account?: string;
    time?: string;
    region?: string;
    detail?: unknown;
}): EventBridgeEvent;
export declare function buildDynamoDBStreamEvent(streamArn: string, records?: Array<Partial<DynamoDBStreamRecord>>): DynamoDBStreamEvent;
export declare function buildKinesisEvent(streamArn: string, records?: Array<KinesisEventRecordInput>): KinesisEvent;
export declare function buildSNSEvent(topicArn: string, records?: Array<SNSEventRecordInput>): SNSEvent;
export declare function stepFunctionsTaskToken(event: unknown): string;
export declare function buildStepFunctionsTaskTokenEvent(taskToken: string, payload?: Record<string, unknown>): Record<string, unknown>;
