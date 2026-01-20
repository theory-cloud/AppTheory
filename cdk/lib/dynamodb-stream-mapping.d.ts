import type { Duration } from "aws-cdk-lib";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
export interface AppTheoryDynamoDBStreamMappingProps {
    readonly consumer: lambda.Function;
    readonly table: dynamodb.ITable;
    readonly startingPosition?: lambda.StartingPosition;
    readonly batchSize?: number;
    readonly bisectBatchOnError?: boolean;
    readonly retryAttempts?: number;
    readonly maxRecordAge?: Duration;
    readonly reportBatchItemFailures?: boolean;
}
export declare class AppTheoryDynamoDBStreamMapping extends Construct {
    constructor(scope: Construct, id: string, props: AppTheoryDynamoDBStreamMappingProps);
}
