import { RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
/** Custom domain configuration for an AppTheory-owned MCP HTTP API. */
export interface AppTheoryMcpServerDomainOptions {
    /** The custom domain name (for example, `mcp.example.com`). */
    readonly domainName: string;
    /** ACM certificate for the domain. Provide this or `certificateArn`. */
    readonly certificate?: acm.ICertificate;
    /** ACM certificate ARN. Provide this or `certificate`. */
    readonly certificateArn?: string;
    /**
     * Route53 hosted zone for an automatically created CNAME record.
     * @default undefined
     */
    readonly hostedZone?: route53.IHostedZone;
}
/** Stage configuration for an AppTheory-owned MCP HTTP API. */
export interface AppTheoryMcpServerStageOptions {
    /** @default "$default" */
    readonly stageName?: string;
    /** @default true */
    readonly accessLogging?: boolean;
    /**
     * Retention period for the access log group. Valid only when access logging
     * is enabled.
     * @default logs.RetentionDays.ONE_MONTH
     */
    readonly accessLogRetention?: logs.RetentionDays;
    /** @default true */
    readonly throttlingEnabled?: boolean;
    /**
     * Default-stage rate limit in requests per second.
     * @default 100
     */
    readonly throttlingRateLimit?: number;
    /**
     * Default-stage burst limit.
     * @default 200
     */
    readonly throttlingBurstLimit?: number;
}
/** Owned-API specialization for standalone MCP servers. */
export interface AppTheoryMcpServerOwnedApiOptions {
    /** Optional API name. */
    readonly apiName?: string;
    /** Optional custom domain owned by this construct. */
    readonly domain?: AppTheoryMcpServerDomainOptions;
    /**
     * Stage configuration. Access logging and throttling default on.
     * @default production defaults
     */
    readonly stage?: AppTheoryMcpServerStageOptions;
}
/** Ordered MCP route-pattern family wired as one facade. */
export interface AppTheoryMcpRouteFamily {
    /**
     * Ordered synthesis-time MCP route patterns.
     *
     * Each segment is either a literal RFC 3986 path segment or a complete
     * `{parameter_name}` segment. CDK tokens, origins, empty segments, dot
     * segments, greedy parameters, and duplicate patterns are rejected.
     */
    readonly patterns: string[];
    /**
     * Wire the algebra-derived unscoped authorization-server discovery route.
     * The runtime must supply `FacadeConfig.RootAuthorizationServer` too.
     * @default false
     */
    readonly rootAuthorizationServerDiscovery?: boolean;
}
/** DynamoDB-backed MCP session-state configuration. */
export interface AppTheoryMcpSessionStateOptions {
    /** @default true */
    readonly enabled?: boolean;
    /**
     * Session table name. Valid only when session state is enabled.
     * @default auto-generated
     */
    readonly tableName?: string;
    /**
     * TTL in minutes for session records. Valid only when session state is
     * enabled.
     * @default 60
     */
    readonly ttlMinutes?: number;
    /**
     * Session table removal policy. Valid only when session state is enabled.
     * @default RemovalPolicy.RETAIN
     */
    readonly removalPolicy?: RemovalPolicy;
}
/** One derived MCP OAuth facade route family. */
export interface AppTheoryMcpServerFacadeRoute {
    readonly mcpPattern: string;
    readonly mcpMethods: string[];
    readonly protectedResourcePattern: string;
    readonly discoveryCanonicalPattern: string;
    readonly discoverySuffixPattern: string;
    readonly authorizePattern: string;
    readonly tokenPattern: string;
    readonly authorizationRoutesAttached: boolean;
}
/** Defensive snapshot of the construct's derived facade inventory. */
export interface AppTheoryMcpServerRouteInventory {
    readonly contractVersion: string;
    readonly routes: AppTheoryMcpServerFacadeRoute[];
    readonly rootAuthorizationServerPattern: string;
    readonly rootAuthorizationServerAttached: boolean;
}
/** Props for the AppTheoryMcpServer construct. */
export interface AppTheoryMcpServerProps {
    /** Lambda function handling the runtime-composed MCP facade. */
    readonly handler: lambda.IFunction;
    /**
     * Existing HTTP API to attach to. Attach mode is the primary front-door
     * topology and never creates an `AWS::ApiGatewayV2::Api` resource.
     * @default a construct-owned HttpApi
     */
    readonly api?: apigwv2.IHttpApi;
    /**
     * Stage name used when deriving attach-mode execute-api endpoint templates.
     * Use `$default` for the API Gateway default stage. When omitted, the stage
     * is not determinable and the templates retain the bare execute-api origin.
     * This prop does not create, import, or mutate a stage.
     * @default undefined
     */
    readonly attachedApiStageName?: string;
    /**
     * Ordered MCP route family.
     *
     * Go `runtime/mcpfacade.RegisterMCPFacade` serves only the canonical default
     * family. Noncanonical patterns require app-owned runtime route registration
     * that matches the construct's `routeInventory`.
     * @default AppTheoryMcpRouteAlgebra.supportedEndpointTemplates()
     */
    readonly routeFamily?: AppTheoryMcpRouteFamily;
    /**
     * Explicitly opt out of the OAuth facade and wire only MCP transport routes.
     * This cannot be combined with legacy authorization props or root discovery.
     * `runtime/mcpfacade.RegisterMCPFacade` always installs the authenticated
     * canonical facade, so applications using this opt-out must own runtime
     * registration for the transport routes.
     * @default false
     */
    readonly unauthenticatedMcp?: boolean;
    /**
     * Session-state table configuration. The table defaults on.
     * @default enabled with production defaults
     */
    readonly sessionState?: AppTheoryMcpSessionStateOptions;
    /**
     * Owned-API configuration for standalone mode. Invalid with `api`.
     * @default production-owned API defaults
     */
    readonly ownedApi?: AppTheoryMcpServerOwnedApiOptions;
    /**
     * Single MCP route path from the v3.1.x A6 surface.
     * @deprecated Use `routeFamily.patterns`. The new default is the canonical
     * four-pattern family; use `{ patterns: ['/mcp'] }` for the old singleton.
     */
    readonly mcpPath?: string;
    /**
     * Authorization-server issuer from the v3.1.x A6 environment contract.
     * @deprecated Configure `runtime/mcpfacade.FacadeConfig.IssuerURL` in the
     * application. The construct no longer injects issuer environment values.
     */
    readonly authorizationServerIssuer?: string;
    /**
     * JWKS URI from the v3.1.x A6 environment contract.
     * @deprecated Configure `runtime/mcpfacade.FacadeConfig.JWKSURI` in the
     * application. The construct no longer injects JWKS environment values.
     */
    readonly jwksUri?: string;
    /** @deprecated Use `ownedApi.apiName`. */
    readonly apiName?: string;
    /**
     * @deprecated Use `sessionState.enabled`. Session state now defaults on.
     */
    readonly enableSessionTable?: boolean;
    /** @deprecated Use `sessionState.tableName`. */
    readonly sessionTableName?: string;
    /** @deprecated Use `sessionState.ttlMinutes`. */
    readonly sessionTtlMinutes?: number;
    /**
     * @deprecated Use `ownedApi.domain`. Domains are invalid in attach mode.
     */
    readonly domain?: AppTheoryMcpServerDomainOptions;
    /**
     * @deprecated Use `ownedApi.stage`. Stage options are invalid in attach mode.
     */
    readonly stage?: AppTheoryMcpServerStageOptions;
}
/**
 * Contract-first MCP facade deployment construct.
 *
 * The primary mode attaches the complete route-algebra family to a supplied
 * HTTP API. Omitting `api` specializes the same path into a standalone owned
 * API. The construct routes only: OAuth metadata, scopes, capabilities, and
 * authorize/token behavior remain application-owned through Go
 * `mcpfacade.RegisterMCPFacade`.
 */
export declare class AppTheoryMcpServer extends Construct {
    private routeSequence;
    readonly api: apigwv2.IHttpApi;
    readonly ownedApi?: apigwv2.HttpApi;
    readonly sessionTable?: dynamodb.ITable;
    /**
     * Derived endpoint templates for the ordered MCP route family.
     *
     * In attach mode these are execute-api origin templates, not declarations of
     * public authority. An `apiEndpoint` supplied through
     * `HttpApi.fromHttpApiAttributes` is never consulted; the origin is derived
     * from `apiId`, the stack region and URL suffix, plus
     * `attachedApiStageName` when supplied.
     */
    readonly endpoints: string[];
    readonly mcpPaths: string[];
    readonly protectedResourceMetadataPaths: string[];
    readonly routeInventory: AppTheoryMcpServerRouteInventory;
    /**
     * First derived endpoint template.
     *
     * In attach mode an `apiEndpoint` supplied through
     * `HttpApi.fromHttpApiAttributes` is never consulted. This value is an
     * execute-api origin template derived by the same rules as `endpoints`, not
     * the front door's public authority.
     * @deprecated Use `endpoints`.
     */
    readonly endpoint: string;
    /** @deprecated Use `mcpPaths`. */
    readonly mcpPath: string;
    /** @deprecated Use `protectedResourceMetadataPaths` or `routeInventory`. */
    readonly protectedResourceMetadataPath: string;
    readonly domainName?: apigwv2.DomainName;
    readonly apiMapping?: apigwv2.ApiMapping;
    readonly cnameRecord?: route53.CnameRecord;
    readonly accessLogGroup?: logs.ILogGroup;
    constructor(scope: Construct, id: string, props: AppTheoryMcpServerProps);
    private addRuntimeRoute;
    private addEnvironment;
    private setupCustomDomain;
}
