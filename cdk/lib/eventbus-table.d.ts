import { RemovalPolicy } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import type { AppTheoryNamingContext } from "./naming-context";
export interface AppTheoryEventBusTableProps {
    readonly tableName?: string;
    readonly billingMode?: dynamodb.BillingMode;
    readonly removalPolicy?: RemovalPolicy;
    readonly timeToLiveAttribute?: string;
    readonly enablePointInTimeRecovery?: boolean;
    /**
     * Whether deletion protection should be enabled for the table.
     * @default undefined (with no naming context: the AWS default, no deletion
     * protection; under a derived naming context: on for a RETAIN table, off otherwise)
     */
    readonly deletionProtection?: boolean;
    readonly enableStream?: boolean;
    readonly streamViewType?: dynamodb.StreamViewType;
    readonly enableEventIdIndex?: boolean;
    readonly readCapacity?: number;
    readonly writeCapacity?: number;
    /**
     * Optional naming context. Under a derived naming context the table takes the contract's
     * Security Hub-aligned defaults: point-in-time recovery on, and deletion
     * protection on for a RETAIN table.
     *
     * With no context the construct synthesizes exactly as before.
     *
     * @default undefined
     */
    readonly namingContext?: AppTheoryNamingContext;
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
