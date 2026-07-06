import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import { AppTheoryApiDomain } from "./api-domain";
import { AppTheoryFunction, type AppTheoryFunctionAliasOptions } from "./function";
import { AppTheoryHttpApi, type AppTheoryHttpApiCorsOptions, type AppTheoryHttpApiDomainOptions } from "./http-api";
import type { AppTheoryRegionalWafOptions } from "./regional-waf";
export interface AppTheoryAppProps {
    readonly appName: string;
    readonly codeAssetPath?: string;
    readonly code?: lambda.Code;
    readonly runtime?: lambda.Runtime;
    readonly handler?: string;
    readonly environment?: Record<string, string>;
    readonly memorySize?: number;
    readonly timeoutSeconds?: number;
    readonly logRetention?: logs.RetentionDays;
    readonly logGroup?: logs.ILogGroupRef;
    readonly vpc?: ec2.IVpc;
    readonly vpcSubnets?: ec2.SubnetSelection;
    readonly securityGroups?: ec2.ISecurityGroup[];
    readonly allowAllOutbound?: boolean;
    readonly allowPublicSubnet?: boolean;
    readonly alias?: AppTheoryFunctionAliasOptions;
    readonly enableDatabase?: boolean;
    readonly databaseTableName?: string;
    readonly databasePartitionKey?: string;
    readonly databaseSortKey?: string;
    readonly databaseTable?: dynamodb.ITable;
    readonly enableRateLimiting?: boolean;
    readonly rateLimitTableName?: string;
    readonly domainName?: string;
    readonly certificateArn?: string;
    readonly domain?: AppTheoryHttpApiDomainOptions;
    readonly cors?: boolean | AppTheoryHttpApiCorsOptions;
    /**
     * Regional WAF attachment is intentionally unavailable on AppTheoryApp
     * because this top-level construct deploys an API Gateway v2 HTTP API.
     * Supplying this prop fails closed during synthesis instead of producing an
     * unsupported HTTP API WebACL association.
     *
     * Use AppTheoryRestApi or AppTheoryRestApiRouter when a WAF-protected API
     * Gateway stage is required.
     * @default undefined
     * @deprecated AppTheoryApp uses AppTheoryHttpApi; HTTP API WAF association is unsupported by AWS WAFv2.
     */
    readonly waf?: boolean | AppTheoryRegionalWafOptions;
    readonly hostedZone?: route53.IHostedZone;
    readonly stage?: apigwv2.IStage;
}
export declare class AppTheoryApp extends Construct {
    readonly api: AppTheoryHttpApi;
    readonly fn: AppTheoryFunction;
    readonly databaseTable?: dynamodb.ITable;
    readonly rateLimitTable?: dynamodb.ITable;
    readonly domain?: AppTheoryApiDomain;
    readonly alias?: lambda.Alias;
    constructor(scope: Construct, id: string, props: AppTheoryAppProps);
}
