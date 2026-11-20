import { RemovalPolicy } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import type { AppTheoryNamingContext } from "./naming-context";
export interface AppTheoryWebSocketApiProps {
    readonly handler: lambda.IFunction;
    readonly connectHandler?: lambda.IFunction;
    readonly disconnectHandler?: lambda.IFunction;
    readonly defaultHandler?: lambda.IFunction;
    readonly apiName?: string;
    readonly stageName?: string;
    readonly connectionTable?: dynamodb.ITable;
    readonly enableConnectionTable?: boolean;
    readonly connectionTableName?: string;
    readonly connectionTablePartitionKeyName?: string;
    readonly connectionTableSortKeyName?: string;
    readonly connectionTableTimeToLiveAttribute?: string;
    readonly connectionTableRemovalPolicy?: RemovalPolicy;
    readonly connectionTableEnablePointInTimeRecovery?: boolean;
    /**
     * Whether deletion protection should be enabled for the connection table.
     * @default undefined (with no naming context: the AWS default, no deletion
     * protection; under a derived naming context: on for a RETAIN table, off otherwise)
     */
    readonly connectionTableDeletionProtection?: boolean;
    readonly enableAccessLogging?: boolean;
    readonly accessLogGroup?: logs.ILogGroup;
    readonly accessLogRetention?: logs.RetentionDays;
    readonly accessLogRemovalPolicy?: RemovalPolicy;
    readonly accessLogFormat?: apigateway.AccessLogFormat;
    /**
     * Optional naming and logging context.
     *
     * With the standard logging profile access logging is on by default to a log
     * group named `logs/access/api/{logicalName}` carrying the contract's JSON
     * field set. Pass `enableAccessLogging: false` to opt out.
     *
     * With no context the construct synthesizes exactly as before.
     *
     * @default undefined
     */
    readonly namingContext?: AppTheoryNamingContext;
    /**
     * The API's logical name. Defaults to the kebab-cased construct id when a
     * naming context is present.
     *
     * @default undefined
     */
    readonly logicalName?: string;
}
export declare class AppTheoryWebSocketApi extends Construct {
    readonly api: apigwv2.WebSocketApi;
    readonly stage: apigwv2.WebSocketStage;
    readonly connectionTable?: dynamodb.ITable;
    readonly accessLogGroup?: logs.ILogGroup;
    constructor(scope: Construct, id: string, props: AppTheoryWebSocketApiProps);
}
