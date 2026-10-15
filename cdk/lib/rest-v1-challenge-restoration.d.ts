import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { Construct } from "constructs";
/**
 * Options for the optional challenge alias bridge.
 */
export interface AppTheoryChallengeAliasBridgeOptions {
    /**
     * Enables the optional challenge alias bridge.
     *
     * When enabled the restoration consults the bridge aliases
     * (`x-theory-www-authenticate`, then `mcp-www-authenticate`) after the AWS
     * REST v1 remap artifact. When disabled only the remap artifact is consulted
     * and the alias spellings never appear in the deployed function source.
     *
     * @default false
     */
    readonly enabled?: boolean;
}
/**
 * Properties for `AppTheoryRestV1ChallengeRestoration`.
 */
export interface AppTheoryRestV1ChallengeRestorationProps {
    /**
     * The REST API v1 origin whose `WWW-Authenticate` responses must be restored.
     *
     * Only an AWS API Gateway REST API v1 (a non-empty `restApiId` and a non-empty
     * `restApiRootResourceId`) is accepted; the restoration is a documented no-op
     * on HTTP API v2.
     */
    readonly origin: apigw.IRestApi;
    /**
     * MCP resource paths whose derived routes receive an explicit ordered cache
     * behavior.
     *
     * The effective route set is derived from the shared route algebra, never
     * hand-wired. A supplied-but-empty array is treated as the default.
     *
     * @default the standard MCP patterns from the shared route algebra
     * (`AppTheoryMcpRouteAlgebra.supportedEndpointTemplates().mcpPattern`)
     */
    readonly resourcePaths?: string[];
    /**
     * Optional challenge alias bridge.
     *
     * @default disabled
     */
    readonly aliasBridge?: AppTheoryChallengeAliasBridgeOptions;
    /**
     * Optional custom domain names for the distribution.
     *
     * When set, `certificate` is required.
     */
    readonly domainNames?: string[];
    /**
     * Certificate for `domainNames`. Required when `domainNames` is set.
     */
    readonly certificate?: acm.ICertificate;
    /**
     * Optional CloudFront price class.
     */
    readonly priceClass?: cloudfront.PriceClass;
}
/**
 * A framework CloudFront front door that restores the canonical
 * `WWW-Authenticate` challenge for an AWS API Gateway REST API v1 origin.
 *
 * AWS REST API v1 remaps the origin's `WWW-Authenticate` response header onto
 * `x-amzn-remapped-www-authenticate`, so a canonical-only app loses the
 * challenge at the edge. This construct fronts the REST v1 `execute-api` origin
 * with a CloudFront distribution whose origin-response Lambda@Edge function
 * copies the first present source back onto `WWW-Authenticate` and removes the
 * consumed source headers.
 *
 * The restore **source set**, in priority order, is:
 *
 * 1. `x-amzn-remapped-www-authenticate` — the artifact AWS itself produces when
 *    REST v1 remaps the origin header. Always consulted.
 * 2. the bridge aliases `x-theory-www-authenticate`, then
 *    `mcp-www-authenticate` — consulted only when the optional alias bridge is
 *    enabled (off by default).
 *
 * The derived route set and the explicit ordered cache behaviors come from the
 * shared route algebra (`AppTheoryMcpRouteAlgebra`), so the construct is never
 * hand-wired. Parameterized derived routes (those carrying a `{parameter}`
 * segment) cannot be expressed as CloudFront path patterns and are therefore
 * covered by the distribution's default behavior.
 */
export declare class AppTheoryRestV1ChallengeRestoration extends Construct {
    /** The CloudFront distribution fronting the REST v1 origin. */
    readonly distribution: cloudfront.Distribution;
    /**
     * The response headers the restoration function consults, in priority order.
     *
     * `["x-amzn-remapped-www-authenticate"]` when the alias bridge is disabled;
     * `["x-amzn-remapped-www-authenticate", "x-theory-www-authenticate",
     * "mcp-www-authenticate"]` when it is enabled.
     */
    readonly restoreSourceHeaders: string[];
    /** True when the optional alias bridge is enabled. */
    readonly aliasBridgeEnabled: boolean;
    /**
     * The complete route set derived from the shared route algebra (parameterized
     * routes included), deduped and in deterministic sorted order.
     */
    readonly derivedRoutePaths: string[];
    /**
     * The subset of `derivedRoutePaths` emitted as explicit ordered cache
     * behaviors (the literal paths, with no `{parameter}` segment).
     *
     * CloudFront path patterns cannot express a `{param}` segment, so
     * parameterized derived routes are covered by the default behavior.
     */
    readonly behaviorPathPatterns: string[];
    constructor(scope: Construct, id: string, props: AppTheoryRestV1ChallengeRestorationProps);
}
