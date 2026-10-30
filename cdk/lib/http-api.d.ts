import { Duration } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import { AppTheoryApiDomain } from "./api-domain";
import type { AppTheoryRegionalWafOptions } from "./regional-waf";
export interface AppTheoryHttpApiCorsOptions {
    /**
     * Allowed origins.
     * @default ["*"]
     */
    readonly allowOrigins?: string[];
    /**
     * Allowed HTTP methods.
     * @default ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]
     */
    readonly allowMethods?: string[];
    /**
     * Allowed headers.
     * @default ["content-type", "authorization", "x-request-id", "x-tenant-id"]
     */
    readonly allowHeaders?: string[];
    /**
     * Exposed response headers.
     * @default ["x-request-id"]
     */
    readonly exposeHeaders?: string[];
    /**
     * Whether browsers may send credentials.
     * @default false
     */
    readonly allowCredentials?: boolean;
    /**
     * Browser preflight cache duration.
     * @default Duration.minutes(10)
     */
    readonly maxAge?: Duration;
}
export interface AppTheoryHttpApiDomainOptions {
    /**
     * Custom domain name, for example `api.example.com`.
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
     * Route53 hosted zone for optional CNAME record creation.
     * @default undefined
     */
    readonly hostedZone?: route53.IHostedZone;
    /**
     * API mapping key under the custom domain.
     * @default undefined
     */
    readonly apiMappingKey?: string;
    /**
     * Stage to map. Defaults to this construct's stage.
     * @default this.stage
     */
    readonly stage?: apigwv2.IStage;
    /**
     * Whether to create a CNAME when hostedZone is provided.
     * @default true when hostedZone is provided
     */
    readonly createCname?: boolean;
    /**
     * CNAME record TTL.
     * @default Duration.seconds(300)
     */
    readonly recordTtl?: Duration;
    /**
     * Mutual TLS configuration.
     * @default undefined
     */
    readonly mutualTlsAuthentication?: apigwv2.MTLSConfig;
    /**
     * TLS security policy.
     * @default API Gateway default
     */
    readonly securityPolicy?: apigwv2.SecurityPolicy;
}
export interface AppTheoryHttpApiStageOptions {
    /**
     * Stage name.
     * @default "$default"
     */
    readonly stageName?: string;
    /**
     * Enable CloudWatch access logging or provide a log group.
     * @default false
     */
    readonly accessLogging?: boolean | logs.ILogGroup;
    /**
     * Retention period for an auto-created access log group.
     * @default logs.RetentionDays.ONE_MONTH
     */
    readonly accessLogRetention?: logs.RetentionDays;
    /**
     * API Gateway v2 access-log format. Defaults to the AppTheory JSON format.
     * Valid only when `accessLogging` is enabled.
     * @default the AppTheory JSON access-log format
     */
    readonly accessLogFormat?: string;
    /**
     * Throttling rate limit.
     * @default undefined
     */
    readonly throttlingRateLimit?: number;
    /**
     * Throttling burst limit.
     * @default undefined
     */
    readonly throttlingBurstLimit?: number;
}
/**
 * @deprecated API Gateway v2 HTTP API stages are not supported WAFv2 regional
 * association targets. Use AppTheoryRestApi or AppTheoryRestApiRouter with
 * AppTheoryRegionalWafOptions for WAF-protected REST API stages.
 */
export interface AppTheoryHttpApiWafOptions extends AppTheoryRegionalWafOptions {
}
/** Gateway authorization posture for an explicit AppTheoryHttpApi route. */
export declare enum AppTheoryHttpApiRouteAuthorizer {
    /** AWS IAM (SigV4) on the route. */
    IAM = "iam",
    /** No gateway authorizer; the runtime owns admission. */
    NONE = "none"
}
/**
 * One explicit, semantically identified route added alongside the construct's
 * greedy `ANY /` and `ANY /{proxy+}` routes.
 *
 * API Gateway precedence gives a full method+path match priority over the
 * greedy routes, so a more specific route with a stricter authorizer (for
 * example `AWS_IAM`) wins for its own path. A wrong-method request on such a
 * path falls through to the runtime's fail-closed 404/405 when the runtime does
 * not declare it.
 */
export interface AppTheoryHttpApiRouteOptions {
    /** Absolute route path. Segments are literals, `{parameter}`, or `{proxy+}` segments. */
    readonly path: string;
    /** HTTP methods wired for the route, for example `["GET"]` or `["ANY"]`. */
    readonly methods: string[];
    /**
     * Gateway authorization posture for the route.
     *
     * Omit for `NONE`. Every explicit value other than `IAM` or `NONE` — an
     * uppercase spelling, a misspelling, `null`, a number, an object, or any
     * unchecked configuration value — fails synthesis before this route is
     * emitted instead of silently falling back to `NONE`.
     * @default AppTheoryHttpApiRouteAuthorizer.NONE
     */
    readonly authorizer?: AppTheoryHttpApiRouteAuthorizer;
}
/** Route-level throttling applied to one API Gateway route key. */
export interface AppTheoryHttpApiRouteThrottling {
    /** Requests per second for the route key. @default the stage default */
    readonly rateLimit?: number;
    /** Burst limit for the route key. @default the stage default */
    readonly burstLimit?: number;
}
export interface AppTheoryHttpApiProps {
    readonly handler: lambda.IFunction;
    readonly apiName?: string;
    /**
     * Whether Lambda invoke permissions should be scoped to individual HTTP API v2 routes.
     *
     * When false, the construct grants one API-scoped invoke permission per Lambda instead of
     * one permission per route. This is the scalable choice for route families that share one
     * Lambda, where the per-route permissions can exhaust the Lambda resource policy size
     * limit.
     *
     * The trade-off is explicit: the API-scoped permission allows every route on that HTTP API
     * to invoke the handler, not only the routes this construct owns.
     *
     * @default true
     */
    readonly scopePermissionToRoute?: boolean;
    /**
     * CORS configuration. Set to true for AppTheory defaults.
     * @default undefined
     */
    readonly cors?: boolean | AppTheoryHttpApiCorsOptions;
    /**
     * Explicit, semantically identified routes added alongside the construct's
     * greedy `ANY /` and `ANY /{proxy+}` routes.
     *
     * Use this where a stricter per-path gateway posture (for example
     * `AppTheoryHttpApiRouteAuthorizer.IAM`) must win over the greedy routes: a
     * full method+path match outranks the greedy route by API Gateway precedence,
     * and a wrong-method request on such a path is denied by the runtime with the
     * fail-closed 404/405 envelope.
     *
     * Route construct ids are derived from the method and path, so inserting,
     * removing, or reordering an entry never renames an unrelated route.
     *
     * A declared `OPTIONS` route coexists with, and can be shadowed by, the
     * API-level CORS configuration `cors` installs. `buildCorsPreflight` includes
     * `OPTIONS` in its default `allowMethods`, and while `OPTIONS` is in that
     * list API Gateway answers matching preflight requests itself before the
     * route integration runs, so a declared `OPTIONS` route on the same path is
     * never reached. Setting `cors.allowMethods` without `OPTIONS` removes gateway
     * preflight handling entirely; a declared `OPTIONS` route is then the only
     * thing that answers a preflight request, and it is subject to that route's
     * own authorizer. Declare the methods you need in `cors.allowMethods` rather
     * than depending on a declared `OPTIONS` route.
     * @default undefined
     */
    readonly routes?: AppTheoryHttpApiRouteOptions[];
    /**
     * Route-level throttling keyed by API Gateway route key (for example
     * `"ANY /{proxy+}"`). Applied to the stage's route settings.
     *
     * Every key is validated at synthesis time against the route keys this
     * construct emits — the greedy `ANY /` and `ANY /{proxy+}` routes plus one
     * `<METHOD> <path>` key per `routes` entry. A key that matches no emitted
     * route fails synthesis with a named error listing the emitted keys, rather
     * than being silently ignored by API Gateway.
     * @default undefined
     */
    readonly routeSettings?: {
        [routeKey: string]: AppTheoryHttpApiRouteThrottling;
    };
    /**
     * Custom domain configuration.
     *
     * When `domain.mutualTlsAuthentication` is set, AppTheory fails closed and
     * disables the default `execute-api` endpoint so the API is reachable only
     * through the mutual-TLS custom domain. Without mutual TLS the default
     * endpoint keeps the AWS default (enabled), so ordinary custom domains are
     * unaffected.
     *
     * @default undefined
     */
    readonly domain?: AppTheoryHttpApiDomainOptions;
    /**
     * Stage configuration.
     * @default undefined
     */
    readonly stage?: AppTheoryHttpApiStageOptions;
    /**
     * Regional WAF attachment is intentionally unavailable for API Gateway v2
     * HTTP APIs. Supplying this prop fails closed during synthesis instead of
     * producing an unsupported `/apis/.../stages/...` WebACL association.
     *
     * Use AppTheoryRestApi or AppTheoryRestApiRouter when a WAF-protected API
     * Gateway stage is required.
     * @default undefined
     * @deprecated HTTP API WAF association is unsupported by AWS WAFv2.
     */
    readonly waf?: boolean | AppTheoryHttpApiWafOptions;
}
export declare class AppTheoryHttpApi extends Construct {
    readonly api: apigwv2.HttpApi;
    readonly stage: apigwv2.IStage;
    readonly accessLogGroup?: logs.ILogGroup;
    readonly domain?: AppTheoryApiDomain;
    constructor(scope: Construct, id: string, props: AppTheoryHttpApiProps);
    private addExplicitRoutes;
    private configureAccessLogging;
    private configureDomain;
}
