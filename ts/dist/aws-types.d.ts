export interface APIGatewayV2HTTPRequest {
    version: string;
    routeKey?: string;
    rawPath: string;
    rawQueryString?: string;
    cookies?: string[];
    headers?: Record<string, string>;
    queryStringParameters?: Record<string, string>;
    requestContext: {
        http: {
            method: string;
            path?: string;
        };
    };
    body?: string;
    isBase64Encoded?: boolean;
}
export interface APIGatewayV2HTTPResponse {
    statusCode: number;
    headers: Record<string, string>;
    multiValueHeaders: Record<string, string[]>;
    body: string;
    isBase64Encoded: boolean;
    cookies: string[];
}
export interface LambdaFunctionURLRequest {
    version: string;
    rawPath: string;
    rawQueryString?: string;
    cookies?: string[];
    headers?: Record<string, string>;
    queryStringParameters?: Record<string, string>;
    requestContext: {
        http: {
            method: string;
            path?: string;
        };
    };
    body?: string;
    isBase64Encoded?: boolean;
}
export interface LambdaFunctionURLResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    isBase64Encoded: boolean;
    cookies: string[];
}
export interface APIGatewayProxyRequest {
    resource?: string;
    path: string;
    httpMethod: string;
    headers?: Record<string, string>;
    multiValueHeaders?: Record<string, string[]>;
    queryStringParameters?: Record<string, string>;
    multiValueQueryStringParameters?: Record<string, string[]>;
    pathParameters?: Record<string, string>;
    stageVariables?: Record<string, string>;
    requestContext?: Record<string, unknown>;
    body?: string;
    isBase64Encoded?: boolean;
}
export interface APIGatewayProxyResponse {
    statusCode: number;
    headers: Record<string, string>;
    multiValueHeaders: Record<string, string[]>;
    body: string;
    isBase64Encoded: boolean;
}
export interface ALBTargetGroupRequest {
    httpMethod: string;
    path: string;
    queryStringParameters?: Record<string, string>;
    multiValueQueryStringParameters?: Record<string, string[]>;
    headers?: Record<string, string>;
    multiValueHeaders?: Record<string, string[]>;
    requestContext: {
        elb: {
            targetGroupArn: string;
        };
    };
    body?: string;
    isBase64Encoded?: boolean;
}
export interface ALBTargetGroupResponse {
    statusCode: number;
    statusDescription: string;
    headers: Record<string, string>;
    multiValueHeaders: Record<string, string[]>;
    body?: string;
    isBase64Encoded: boolean;
}
export interface APIGatewayWebSocketProxyRequest extends APIGatewayProxyRequest {
    requestContext?: {
        stage?: string;
        requestId?: string;
        connectionId?: string;
        domainName?: string;
        eventType?: string;
        routeKey?: string;
        [key: string]: unknown;
    };
}
export interface SQSEvent {
    Records: SQSMessage[];
}
export interface SQSMessage {
    messageId: string;
    body?: string;
    eventSource?: string;
    eventSourceARN?: string;
    [key: string]: unknown;
}
export interface SQSEventResponse {
    batchItemFailures: {
        itemIdentifier: string;
    }[];
}
export interface DynamoDBStreamEvent {
    Records: DynamoDBStreamRecord[];
}
export interface DynamoDBStreamRecord {
    eventID: string;
    eventName?: string;
    eventSource?: string;
    eventSourceARN?: string;
    dynamodb?: unknown;
    [key: string]: unknown;
}
export interface DynamoDBStreamEventResponse {
    batchItemFailures: {
        itemIdentifier: string;
    }[];
}
export interface KinesisEvent {
    Records: KinesisEventRecord[];
}
export interface KinesisEventRecord {
    eventID: string;
    eventName?: string;
    eventSource?: string;
    eventSourceARN?: string;
    awsRegion?: string;
    eventVersion?: string;
    invokeIdentityArn?: string;
    kinesis?: KinesisRecord;
    [key: string]: unknown;
}
export interface KinesisRecord {
    data?: string;
    partitionKey?: string;
    sequenceNumber?: string;
    kinesisSchemaVersion?: string;
    [key: string]: unknown;
}
export type KinesisEventRecordInput = Partial<KinesisEventRecord> & {
    data?: Uint8Array | string;
    partitionKey?: string;
    sequenceNumber?: string;
    kinesis?: Partial<KinesisRecord> & {
        data?: Uint8Array | string;
    };
};
export interface KinesisEventResponse {
    batchItemFailures: {
        itemIdentifier: string;
    }[];
}
export interface SNSEvent {
    Records: SNSEventRecord[];
}
export interface SNSEventRecord {
    EventSource?: string;
    EventVersion?: string;
    EventSubscriptionArn?: string;
    Sns?: SNSEntity;
    [key: string]: unknown;
}
export interface SNSEntity {
    MessageId?: string;
    TopicArn?: string;
    Subject?: string;
    Message?: string;
    Timestamp?: string;
    [key: string]: unknown;
}
export type SNSEventRecordInput = Partial<SNSEventRecord> & {
    eventVersion?: string;
    eventSubscriptionArn?: string;
    messageId?: string;
    topicArn?: string;
    subject?: string;
    message?: string;
    sns?: Partial<SNSEntity>;
    Sns?: Partial<SNSEntity>;
};
export interface EventBridgeEvent {
    version?: string;
    id?: string;
    "detail-type"?: string;
    detailType?: string;
    source?: string;
    resources?: string[];
    detail?: unknown;
    [key: string]: unknown;
}
export interface EventBridgeSelector {
    ruleName?: string;
    source?: string;
    detailType?: string;
}
