export type AttributeValue = {
    S: string;
} | {
    N: string;
} | {
    BOOL: boolean;
} | {
    NULL: true;
} | {
    M: Record<string, AttributeValue>;
} | {
    L: AttributeValue[];
};
export type DynamoDBKey = Record<string, AttributeValue>;
export type DynamoDBItem = Record<string, AttributeValue>;
export type GetItemInput = {
    TableName: string;
    Key: DynamoDBKey;
    ConsistentRead?: boolean;
};
export type GetItemOutput = {
    Item?: DynamoDBItem;
};
export type UpdateItemInput = {
    TableName: string;
    Key: DynamoDBKey;
    UpdateExpression: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, AttributeValue>;
    ConditionExpression?: string;
    ReturnValues?: "NONE" | "ALL_OLD" | "UPDATED_OLD" | "ALL_NEW" | "UPDATED_NEW";
};
export type UpdateItemOutput = {
    Attributes?: DynamoDBItem;
};
export type PutItemInput = {
    TableName: string;
    Item: DynamoDBItem;
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, AttributeValue>;
};
export type TransactWriteItemsInput = {
    TransactItems: Array<Record<string, unknown>>;
};
export declare class DynamoDBClient {
    readonly endpoint: string;
    readonly region: string;
    private readonly _credentials;
    constructor(options?: {
        endpoint?: unknown;
        region?: unknown;
        credentials?: unknown;
    });
    getItem(input: GetItemInput): Promise<GetItemOutput>;
    updateItem(input: UpdateItemInput): Promise<UpdateItemOutput>;
    putItem(input: PutItemInput): Promise<Record<string, unknown>>;
    transactWriteItems(input: TransactWriteItemsInput): Promise<Record<string, unknown>>;
    private _call;
}
