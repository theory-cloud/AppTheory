import { RemovalPolicy } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
export interface AppTheoryEventBusTableProps {
    readonly tableName?: string;
    readonly billingMode?: dynamodb.BillingMode;
    readonly removalPolicy?: RemovalPolicy;
    readonly timeToLiveAttribute?: string;
    readonly enablePointInTimeRecovery?: boolean;
    readonly enableStream?: boolean;
    readonly streamViewType?: dynamodb.StreamViewType;
    readonly enableEventIdIndex?: boolean;
    readonly readCapacity?: number;
    readonly writeCapacity?: number;
}
export interface AppTheoryEventBusTableBindingOptions {
    /**
     * Grant read-only access for replay/query consumers.
     * When false, the handler receives read/write access for publish + replay flows.
     * @default false
     */
    readonly readOnly?: boolean;
    /**
     * Environment variable name used for the table name binding.
     * AppTheory runtime code reads `APPTHEORY_EVENTBUS_TABLE_NAME` by default.
     * @default APPTHEORY_EVENTBUS_TABLE_NAME
     */
    readonly envVarName?: string;
}
export declare class AppTheoryEventBusTable extends Construct {
    readonly table: dynamodb.Table;
    constructor(scope: Construct, id: string, props?: AppTheoryEventBusTableProps);
    /**
     * Binds the table to a Lambda function for EventBus publish/query/replay flows.
     */
    bind(handler: lambda.IFunction, options?: AppTheoryEventBusTableBindingOptions): void;
    private addEnvironment;
}
