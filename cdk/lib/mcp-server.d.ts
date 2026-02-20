import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
/**
 * Custom domain configuration for the MCP server.
 */
export interface AppTheoryMcpServerDomainOptions {
    /**
     * The custom domain name (e.g., "mcp.example.com").
     */
    readonly domainName: string;
    /**
     * ACM certificate for the domain.
     * Provide either certificate or certificateArn.
     */
    readonly certificate?: acm.ICertificate;
    /**
     * ACM certificate ARN.
     * Provide either certificate or certificateArn.
     */
    readonly certificateArn?: string;
    /**
     * Route53 hosted zone for automatic DNS record creation.
     * If provided, a CNAME record will be created pointing to the API Gateway domain.
     * @default undefined (no DNS record created)
     */
    readonly hostedZone?: route53.IHostedZone;
}
/**
 * Stage configuration for the MCP server API Gateway.
 */
export interface AppTheoryMcpServerStageOptions {
    /**
     * Stage name.
     * @default "$default"
     */
    readonly stageName?: string;
    /**
     * Enable CloudWatch access logging for the stage.
     * @default false
     */
    readonly accessLogging?: boolean;
    /**
     * Retention period for auto-created access log group.
     * Only applies when accessLogging is true.
     * @default logs.RetentionDays.ONE_MONTH
     */
    readonly accessLogRetention?: logs.RetentionDays;
    /**
     * Throttling rate limit (requests per second) for the stage.
     * @default undefined (no throttling)
     */
    readonly throttlingRateLimit?: number;
    /**
     * Throttling burst limit for the stage.
     * @default undefined (no throttling)
     */
    readonly throttlingBurstLimit?: number;
}
/**
 * Props for the AppTheoryMcpServer construct.
 */
export interface AppTheoryMcpServerProps {
    /**
     * The Lambda function handling MCP requests.
     */
    readonly handler: lambda.IFunction;
    /**
     * Optional API name.
     * @default undefined
     */
    readonly apiName?: string;
    /**
     * Create a DynamoDB table for session state storage.
     * @default false
     */
    readonly enableSessionTable?: boolean;
    /**
     * Name for the session DynamoDB table.
     * Only used when enableSessionTable is true.
     * @default undefined (auto-generated)
     */
    readonly sessionTableName?: string;
    /**
     * TTL in minutes for session records.
     * Only used when enableSessionTable is true.
     * @default 60
     */
    readonly sessionTtlMinutes?: number;
    /**
     * Custom domain configuration.
     * @default undefined (no custom domain)
     */
    readonly domain?: AppTheoryMcpServerDomainOptions;
    /**
     * Stage configuration.
     * @default undefined (defaults applied)
     */
    readonly stage?: AppTheoryMcpServerStageOptions;
}
/**
 * An MCP (Model Context Protocol) server construct that provisions an HTTP API Gateway v2
 * with a Lambda integration on POST /mcp, optional DynamoDB session table, and optional
 * custom domain with Route53.
 *
 * @example
 * const server = new AppTheoryMcpServer(this, 'McpServer', {
 *   handler: mcpFn,
 *   enableSessionTable: true,
 *   sessionTtlMinutes: 120,
 * });
 */
export declare class AppTheoryMcpServer extends Construct {
    /**
     * The underlying HTTP API Gateway v2.
     */
    readonly api: apigwv2.HttpApi;
    /**
     * The DynamoDB session table (if enableSessionTable is true).
     */
    readonly sessionTable?: dynamodb.ITable;
    /**
     * The MCP endpoint URL (POST /mcp).
     */
    readonly endpoint: string;
    /**
     * The custom domain name resource (if domain is configured).
     */
    readonly domainName?: apigwv2.DomainName;
    /**
     * The API mapping for the custom domain (if domain is configured).
     */
    readonly apiMapping?: apigwv2.ApiMapping;
    /**
     * The Route53 CNAME record (if domain and hostedZone are configured).
     */
    readonly cnameRecord?: route53.CnameRecord;
    /**
     * The access log group (if access logging is enabled).
     */
    readonly accessLogGroup?: logs.ILogGroup;
    constructor(scope: Construct, id: string, props: AppTheoryMcpServerProps);
    /**
     * Add an environment variable to the Lambda function.
     * Uses addEnvironment if available (Function), otherwise uses L1 override.
     */
    private addEnvironment;
    /**
     * Set up custom domain with optional Route53 record.
     */
    private setupCustomDomain;
}
