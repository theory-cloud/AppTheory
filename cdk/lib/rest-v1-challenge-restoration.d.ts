import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { Construct } from "constructs";
/**
 * The DD-2 direct-origin reachability decision for a REST v1 origin.
 *
 * DD-2 (`DEFENSE_IN_DEPTH.md`) requires the deployment to **record** whether the
 * `execute-api` default endpoint is directly reachable and, when it is, to make
 * that posture explicit. A directly reachable origin (`direct`) is **not**
 * allowed: it is not a member of this enum and the construct refuses it at
 * synthesis.
 */
export declare enum AppTheoryRestV1OriginReachability {
    /**
     * The REST API's `execute-api` default endpoint is disabled
     * (`disableExecuteApiEndpoint`), so the API is not reachable at its default
     * endpoint.
     *
     * Because the construct fronts an external `IRestApi` it cannot mutate, the
     * caller must assert the disablement with
     * `disableExecuteApiEndpointAsserted: true`.
     *
     * Note the platform shape: the disabled hostname is exactly the
     * `<restApiId>.execute-api.<region>.<urlSuffix>` hostname this construct uses
     * as its origin, so an app that disables the default endpoint must front its
     * REST API through a custom domain (AWS requires a custom domain once the
     * default endpoint is disabled). `LOCKED` is the posture for a REST v1 origin
     * this construct is expected to serve.
     */
    DISABLED = "disabled",
    /**
     * The origin is reachable only through this construct's CloudFront front door.
     *
     * Requires `originLock` carrying the origin-lock secret the construct injects
     * as a custom origin header, plus the caller's assertion that the REST API
     * verifies that header (the construct cannot attach an origin-side
     * verification to an external `IRestApi`).
     */
    LOCKED = "locked"
}
/**
 * The origin lock for `originReachability: LOCKED`.
 *
 * The construct injects `secret` as the `headerName` custom origin header on
 * **every** request it sends to the REST v1 origin, so an origin-side
 * verification can refuse a request that did not come through this
 * distribution. The construct fronts an external `IRestApi`, so it cannot attach
 * that verification itself: the caller asserts it with `asserted: true`.
 */
export interface AppTheoryRestV1OriginLockOptions {
    /**
     * The literal secret injected as the origin-lock header on every CloudFront
     * request to the origin.
     *
     * 32 to 128 characters of `[A-Za-z0-9._~-]`. The value is a literal CloudFront
     * origin custom header value, so it appears verbatim in the synthesized
     * template and must not be (or contain) a credential you cannot rotate with the
     * REST API's verification.
     */
    readonly secret: string;
    /**
     * The origin-lock header name.
     *
     * 1 to 64 characters of `[A-Za-z0-9-]`, and never a name CloudFront reserves or
     * that rewrites the origin request contract (`Host`, `Authorization`,
     * `Cookie`, `Content-Length`, `Transfer-Encoding`, `Connection`,
     * `WWW-Authenticate`, `X-Forwarded-For`, or any `x-amz-*`, `x-amzn-*`, or
     * `cloudfront-*` name).
     *
     * @default "x-apptheory-origin-lock"
     */
    readonly headerName?: string;
    /**
     * The caller's assertion that the REST API verifies the origin lock.
     *
     * This construct cannot attach a resource policy, authorizer, or any other
     * origin-side verification to an external `IRestApi` it does not own, so it
     * refuses to synthesize until the caller records that the verification exists
     * and requires the injected header. Must be `true`.
     */
    readonly asserted: boolean;
}
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
     * The mandatory DD-2 direct-origin reachability decision.
     *
     * Required. `DISABLED` and `LOCKED` synthesize; anything else — in particular a
     * directly reachable origin — fails synthesis with an error that names the
     * rejected decision.
     */
    readonly originReachability: AppTheoryRestV1OriginReachability;
    /**
     * The caller's assertion that the REST API's `disableExecuteApiEndpoint` is
     * set, required with `originReachability: DISABLED`.
     *
     * This construct fronts an external `IRestApi` it cannot mutate, so it cannot
     * set the property for the caller; it requires the assertion instead and
     * records it in the distribution metadata.
     */
    readonly disableExecuteApiEndpointAsserted?: boolean;
    /**
     * The mandatory origin lock, required with `originReachability: LOCKED`.
     */
    readonly originLock?: AppTheoryRestV1OriginLockOptions;
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
 * ## The direct-endpoint caveat (DD-2)
 *
 * A CloudFront front door does **not** by itself make the origin unreachable.
 * The REST API keeps answering at its own
 * `<restApiId>.execute-api.<region>.<urlSuffix>` endpoint, which is exactly the
 * origin this distribution uses, so a client that skips the distribution still
 * reaches the origin and observes a **challenge-less `401`** for a REST v1
 * canonical-only app — the restoration never runs, and any edge-only control
 * (throttling at the edge, edge observability, the alias bridge) is bypassed on
 * that path. Authentication itself is unaffected: the runtime bearer gate still
 * refuses the request at the origin, so this is challenge loss and edge bypass,
 * not an authentication bypass.
 *
 * `originReachability` is therefore **required** (DD-2's mandatory
 * direct-origin decision):
 *
 * - `DISABLED` — the REST API's `execute-api` default endpoint is disabled. The
 *   caller asserts it (`disableExecuteApiEndpointAsserted: true`) because this
 *   construct cannot mutate an external `IRestApi`. The construct does not
 *   verify the assertion, and the disabled hostname is the distribution's own
 *   origin hostname, so an app that disables the default endpoint must front the
 *   origin through a custom domain.
 * - `LOCKED` — the origin is reachable only through this distribution. The
 *   construct injects `originLock.secret` as a custom origin header on every
 *   request to the origin, and the caller asserts
 *   (`originLock.asserted: true`) that the REST API verifies that header; the
 *   construct cannot attach the verification to an external `IRestApi`.
 *
 * A directly reachable origin (`direct`) is refused at synthesis. The decision
 * is recorded in the distribution's CloudFormation metadata
 * (`apptheory:rest-v1-challenge-restoration`), so the posture is auditable from
 * the synthesized template.
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
    /** The recorded DD-2 direct-origin reachability decision. */
    readonly originReachability: AppTheoryRestV1OriginReachability;
    /**
     * The origin-lock header name injected on every request to the origin, or
     * `undefined` when the decision is `DISABLED`.
     */
    readonly originLockHeaderName?: string;
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
