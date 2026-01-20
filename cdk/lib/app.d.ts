import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import { AppTheoryApiDomain } from "./api-domain";
import { AppTheoryFunction } from "./function";
import { AppTheoryHttpApi } from "./http-api";
export interface AppTheoryAppProps {
    readonly appName: string;
    readonly codeAssetPath?: string;
    readonly code?: lambda.Code;
    readonly runtime?: lambda.Runtime;
    readonly handler?: string;
    readonly environment?: Record<string, string>;
    readonly memorySize?: number;
    readonly timeoutSeconds?: number;
    readonly enableDatabase?: boolean;
    readonly databaseTableName?: string;
    readonly databasePartitionKey?: string;
    readonly databaseSortKey?: string;
    readonly databaseTable?: dynamodb.ITable;
    readonly enableRateLimiting?: boolean;
    readonly rateLimitTableName?: string;
    readonly domainName?: string;
    readonly certificateArn?: string;
    readonly hostedZone?: route53.IHostedZone;
    readonly stage?: apigwv2.IStage;
}
export declare class AppTheoryApp extends Construct {
    readonly api: AppTheoryHttpApi;
    readonly fn: AppTheoryFunction;
    readonly databaseTable?: dynamodb.ITable;
    readonly rateLimitTable?: dynamodb.ITable;
    readonly domain?: AppTheoryApiDomain;
    constructor(scope: Construct, id: string, props: AppTheoryAppProps);
}
