import { RemovalPolicy } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
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
export declare class AppTheoryEventBusTable extends Construct {
    readonly table: dynamodb.Table;
    constructor(scope: Construct, id: string, props?: AppTheoryEventBusTableProps);
}
