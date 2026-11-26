"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryRestV1ChallengeRestoration = exports.AppTheoryRestV1OriginReachability = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const origins = __importStar(require("aws-cdk-lib/aws-cloudfront-origins"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const constructs_1 = require("constructs");
const mcp_route_algebra_1 = require("./mcp-route-algebra");
const rest_v1_challenge_restoration_handler_1 = require("./private/rest-v1-challenge-restoration-handler");
const secure_defaults_1 = require("./private/secure-defaults");
/** Metadata key recorded on the distribution for the challenge-restoration contract. */
const CHALLENGE_RESTORATION_METADATA_KEY = "apptheory:rest-v1-challenge-restoration";
/** Contract id recorded in the distribution metadata marker. */
const CHALLENGE_RESTORATION_CONTRACT_ID = "m17.rest-v1-challenge-restoration/v1";
/**
 * The manifest constant for the AWS REST v1 remap artifact.
 *
 * AWS API Gateway REST API v1 remaps the origin's `WWW-Authenticate` response
 * header onto this header, so it is the restore source that does not depend on
 * any optional bridge.
 */
const REMAP_SOURCE_HEADER = "x-amzn-remapped-www-authenticate";
/**
 * The optional alias bridge spellings, consulted only when the alias bridge is
 * enabled, in priority order after the remap artifact.
 */
const ALIAS_SOURCE_HEADERS = ["x-theory-www-authenticate", "mcp-www-authenticate"];
/**
 * The default REST v1 transport-failure message.
 *
 * The restoration is a documented no-op on HTTP API v2, so a non-REST-v1 origin
 * fails synth rather than silently degrading.
 */
const NON_REST_V1_ORIGIN_MESSAGE = "AppTheoryRestV1ChallengeRestoration: origin must be an AWS API Gateway REST API (v1); " +
    "the WWW-Authenticate restoration is a documented no-op on HTTP API v2";
/** The origin-lock header this construct injects on any request it sends to the origin. */
const DEFAULT_ORIGIN_LOCK_HEADER = "x-apptheory-origin-lock";
/**
 * The origin-lock secret alphabet.
 *
 * The value is a literal CloudFront origin custom header value (CloudFront
 * custom origin headers carry plain strings, not template intrinsics), so the
 * secret is restricted to a header-value-safe alphabet with no whitespace and no
 * control characters.
 */
const ORIGIN_LOCK_SECRET_PATTERN = /^[A-Za-z0-9._~-]{32,128}$/;
/** The origin-lock header name alphabet. */
const ORIGIN_LOCK_HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/**
 * Header names CloudFront reserves or that would rewrite the origin request
 * contract, so they can never carry the origin lock.
 */
const RESERVED_ORIGIN_LOCK_HEADERS = new Set([
    "authorization",
    "connection",
    "content-length",
    "cookie",
    "host",
    "transfer-encoding",
    "www-authenticate",
    "x-forwarded-for",
]);
/**
 * The DD-2 direct-origin reachability decision for a REST v1 origin.
 *
 * DD-2 (`DEFENSE_IN_DEPTH.md`) requires the deployment to **record** whether the
 * `execute-api` default endpoint is directly reachable and, when it is, to make
 * that posture explicit. A directly reachable origin (`direct`) is **not**
 * allowed: it is not a member of this enum and the construct refuses it at
 * synthesis.
 */
var AppTheoryRestV1OriginReachability;
(function (AppTheoryRestV1OriginReachability) {
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
    AppTheoryRestV1OriginReachability["DISABLED"] = "disabled";
    /**
     * The origin is reachable only through this construct's CloudFront front door.
     *
     * Requires `originLock` carrying the origin-lock secret the construct injects
     * as a custom origin header, plus the caller's assertion that the REST API
     * verifies that header (the construct cannot attach an origin-side
     * verification to an external `IRestApi`).
     */
    AppTheoryRestV1OriginReachability["LOCKED"] = "locked";
})(AppTheoryRestV1OriginReachability || (exports.AppTheoryRestV1OriginReachability = AppTheoryRestV1OriginReachability = {}));
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
class AppTheoryRestV1ChallengeRestoration extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryRestV1ChallengeRestoration", version: "7.5.0" };
    /** The CloudFront distribution fronting the REST v1 origin. */
    distribution;
    /**
     * The response headers the restoration function consults, in priority order.
     *
     * `["x-amzn-remapped-www-authenticate"]` when the alias bridge is disabled;
     * `["x-amzn-remapped-www-authenticate", "x-theory-www-authenticate",
     * "mcp-www-authenticate"]` when it is enabled.
     */
    restoreSourceHeaders;
    /** True when the optional alias bridge is enabled. */
    aliasBridgeEnabled;
    /** The recorded DD-2 direct-origin reachability decision. */
    originReachability;
    /**
     * The origin-lock header name injected on every request to the origin, or
     * `undefined` when the decision is `DISABLED`.
     */
    originLockHeaderName;
    /**
     * The complete route set derived from the shared route algebra (parameterized
     * routes included), deduped and in deterministic sorted order.
     */
    derivedRoutePaths;
    /**
     * The subset of `derivedRoutePaths` emitted as explicit ordered cache
     * behaviors (the literal paths, with no `{parameter}` segment).
     *
     * CloudFront path patterns cannot express a `{param}` segment, so
     * parameterized derived routes are covered by the default behavior.
     */
    behaviorPathPatterns;
    constructor(scope, id, props) {
        super(scope, id);
        const origin = props.origin;
        assertRestV1Origin(origin);
        const reachability = resolveOriginReachability(props);
        this.originReachability = reachability.decision;
        this.originLockHeaderName = reachability.lockHeaderName;
        if (props.domainNames !== undefined &&
            props.domainNames.length > 0 &&
            props.certificate === undefined) {
            throw new Error("AppTheoryRestV1ChallengeRestoration: domainNames requires certificate");
        }
        this.aliasBridgeEnabled = props.aliasBridge?.enabled === true;
        this.restoreSourceHeaders = this.aliasBridgeEnabled
            ? [REMAP_SOURCE_HEADER, ...ALIAS_SOURCE_HEADERS]
            : [REMAP_SOURCE_HEADER];
        const derivedRoutePaths = deriveRoutePaths(props.resourcePaths);
        if (derivedRoutePaths.length === 0) {
            throw new Error("AppTheoryRestV1ChallengeRestoration: the route model derived no routes from resourcePaths");
        }
        this.derivedRoutePaths = derivedRoutePaths;
        this.behaviorPathPatterns = derivedRoutePaths.filter((pathPattern) => !pathPattern.includes("{") && !pathPattern.includes("}"));
        const restOrigin = buildRestV1Origin(this, origin, reachability);
        const restorationFunction = new cloudfront.experimental.EdgeFunction(this, "ChallengeRestorationFunction", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "index.handler",
            code: lambda.Code.fromInline((0, rest_v1_challenge_restoration_handler_1.generateRestV1ChallengeRestorationHandlerCode)(this.restoreSourceHeaders)),
            description: "Restore the canonical WWW-Authenticate challenge for AppTheory REST v1 origin responses",
        });
        // CDK's OriginRequestHeaderBehavior has no `allViewerExceptHostHeader`
        // builder and refuses `Authorization` in an allow list, so the managed
        // ALL_VIEWER_EXCEPT_HOST_HEADER policy is expressed the way AWS implements
        // it: `allExcept` with only `Host` denied. Every viewer header (the
        // `Authorization` header above all) is forwarded, and CloudFront still
        // presents the execute-api origin host.
        //
        // Under LOCKED the origin-lock header is denied to the viewer as well, so a
        // viewer-supplied copy of the lock header is stripped at the edge and the
        // CloudFront-injected origin custom header is the only copy that reaches the
        // origin through this distribution.
        //
        // All cookies and all query strings are forwarded as well, exactly as the
        // managed policy does: the derived OAuth routes carry their parameters in
        // the query string (the per-kind `.../authorize` route and the callback's
        // `?code=...&state=...`), so dropping the query string would break the
        // front channel, and a cookie-carried session must reach the origin
        // unchanged.
        const deniedViewerHeaders = [
            "Host",
            ...(this.originLockHeaderName !== undefined ? [this.originLockHeaderName] : []),
        ];
        const originRequestPolicy = new cloudfront.OriginRequestPolicy(this, "OriginRequestPolicy", {
            comment: "AppTheory REST v1 challenge restoration: forward all viewer headers except Host and any origin-lock header, all cookies and all query strings",
            headerBehavior: cloudfront.OriginRequestHeaderBehavior.denyList(...deniedViewerHeaders),
            cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
            queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
        });
        const edgeLambdas = [
            {
                eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
                functionVersion: restorationFunction.currentVersion,
            },
        ];
        const behaviorOptions = () => ({
            origin: restOrigin,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
            cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
            originRequestPolicy,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            edgeLambdas,
        });
        const additionalBehaviors = {};
        for (const pathPattern of this.behaviorPathPatterns) {
            additionalBehaviors[pathPattern] = behaviorOptions();
        }
        const frontedDomains = props.domainNames !== undefined && props.domainNames.length > 0 && props.certificate !== undefined;
        const minimumProtocolVersion = (0, secure_defaults_1.defaultMinimumProtocolVersion)(props.namingContext, frontedDomains, props.minimumProtocolVersion);
        this.distribution = new cloudfront.Distribution(this, "Distribution", {
            defaultBehavior: behaviorOptions(),
            additionalBehaviors,
            ...(frontedDomains ? { domainNames: props.domainNames, certificate: props.certificate } : {}),
            ...(minimumProtocolVersion !== undefined ? { minimumProtocolVersion } : {}),
            ...(props.priceClass !== undefined ? { priceClass: props.priceClass } : {}),
        });
        const cfnDistribution = this.distribution.node
            .defaultChild;
        cfnDistribution.addMetadata(CHALLENGE_RESTORATION_METADATA_KEY, {
            contractId: CHALLENGE_RESTORATION_CONTRACT_ID,
            aliasBridge: this.aliasBridgeEnabled,
            sourceHeaders: this.restoreSourceHeaders,
            routeCount: this.derivedRoutePaths.length,
            originReachability: this.originReachability,
            ...(this.originLockHeaderName !== undefined
                ? { originLockHeader: this.originLockHeaderName }
                : { disableExecuteApiEndpointAsserted: true }),
        });
    }
}
exports.AppTheoryRestV1ChallengeRestoration = AppTheoryRestV1ChallengeRestoration;
/** Renders a rejected decision for an error message without assuming its type. */
function describeDecision(decision) {
    return typeof decision === "string" ? JSON.stringify(decision) : String(decision);
}
/**
 * Resolves and validates the mandatory DD-2 direct-origin reachability decision.
 *
 * Fails closed at synthesis on a missing or `direct` decision, on a `DISABLED`
 * decision without the caller's disablement assertion, on a `LOCKED` decision
 * without a complete origin lock, and on contradictory props.
 */
function resolveOriginReachability(props) {
    const decision = props.originReachability;
    if (decision !== AppTheoryRestV1OriginReachability.DISABLED &&
        decision !== AppTheoryRestV1OriginReachability.LOCKED) {
        throw new Error("AppTheoryRestV1ChallengeRestoration: originReachability is required and must be " +
            "AppTheoryRestV1OriginReachability.DISABLED or .LOCKED (DD-2); a directly reachable " +
            `origin ('direct') is not allowed (received ${describeDecision(decision)}). ` +
            "The REST API's execute-api endpoint is the origin this distribution uses, so a client that " +
            "bypasses the distribution still reaches it and observes a challenge-less 401: record how that " +
            "endpoint is made unreachable (DISABLED) or reached only through this distribution (LOCKED)");
    }
    if (decision === AppTheoryRestV1OriginReachability.DISABLED) {
        if (props.originLock !== undefined) {
            throw new Error("AppTheoryRestV1ChallengeRestoration: originLock is only valid with originReachability " +
                "AppTheoryRestV1OriginReachability.LOCKED");
        }
        if (props.disableExecuteApiEndpointAsserted !== true) {
            throw new Error("AppTheoryRestV1ChallengeRestoration: originReachability DISABLED requires " +
                "disableExecuteApiEndpointAsserted: true; this construct fronts an external IRestApi it " +
                "cannot mutate, so the caller must assert that the REST API's disableExecuteApiEndpoint is set");
        }
        return { decision };
    }
    if (props.disableExecuteApiEndpointAsserted !== undefined) {
        throw new Error("AppTheoryRestV1ChallengeRestoration: disableExecuteApiEndpointAsserted is only valid with " +
            "originReachability AppTheoryRestV1OriginReachability.DISABLED");
    }
    const lock = props.originLock;
    if (lock === undefined) {
        throw new Error("AppTheoryRestV1ChallengeRestoration: originReachability LOCKED requires originLock " +
            "({ secret, asserted: true }) carrying the origin-lock material and the caller's assertion that " +
            "the REST API verifies it");
    }
    if (lock.asserted !== true) {
        throw new Error("AppTheoryRestV1ChallengeRestoration: originReachability LOCKED requires originLock.asserted: true " +
            "(the caller asserts the REST API verifies the origin-lock header this distribution injects); " +
            "this construct cannot attach the verification to an external IRestApi");
    }
    if (typeof lock.secret !== "string" || !ORIGIN_LOCK_SECRET_PATTERN.test(lock.secret)) {
        throw new Error("AppTheoryRestV1ChallengeRestoration: originLock.secret must be 32..128 characters of " +
            "[A-Za-z0-9._~-] (a literal CloudFront origin custom header value: no whitespace, no control " +
            "characters, no template intrinsics)");
    }
    const headerName = lock.headerName ?? DEFAULT_ORIGIN_LOCK_HEADER;
    if (!ORIGIN_LOCK_HEADER_NAME_PATTERN.test(headerName)) {
        throw new Error("AppTheoryRestV1ChallengeRestoration: originLock.headerName must be 1..64 characters of [A-Za-z0-9-]");
    }
    const normalizedHeaderName = headerName.toLowerCase();
    if (RESERVED_ORIGIN_LOCK_HEADERS.has(normalizedHeaderName) ||
        normalizedHeaderName.startsWith("x-amz-") ||
        normalizedHeaderName.startsWith("x-amzn-") ||
        normalizedHeaderName.startsWith("cloudfront-")) {
        throw new Error(`AppTheoryRestV1ChallengeRestoration: originLock.headerName "${headerName}" is reserved by CloudFront or the origin request contract and cannot carry the origin lock`);
    }
    return { decision, lockHeaderName: headerName, lockSecret: lock.secret };
}
/** Fails closed unless the origin is an AWS API Gateway REST API v1. */
function assertRestV1Origin(origin) {
    if (origin === undefined ||
        typeof origin.restApiId !== "string" ||
        origin.restApiId.length === 0 ||
        typeof origin.restApiRootResourceId !== "string" ||
        origin.restApiRootResourceId.length === 0) {
        throw new Error(NON_REST_V1_ORIGIN_MESSAGE);
    }
}
/**
 * Builds the HTTPS-only `execute-api` origin for an AWS API Gateway REST API v1,
 * carrying the origin-lock header when the decision is `LOCKED`.
 *
 * `cloudfront-origins`' `RestApiOrigin` accepts a `RestApiBase` (it reads the
 * concrete `url` token), not the `IRestApi` this construct takes, and `IRestApi`
 * exposes neither `url` nor `urlForPath`. The execute-api origin is therefore
 * built from `restApiId`, the stack region and URL suffix, and the deployment
 * stage's origin path.
 */
function buildRestV1Origin(scope, origin, reachability) {
    const stack = aws_cdk_lib_1.Stack.of(scope);
    const originDomainName = `${origin.restApiId}.execute-api.${stack.region}.${stack.urlSuffix}`;
    const stageName = origin.deploymentStage?.stageName;
    return new origins.HttpOrigin(originDomainName, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        ...(stageName ? { originPath: `/${stageName}` } : {}),
        ...(reachability.lockHeaderName !== undefined && reachability.lockSecret !== undefined
            ? { customHeaders: { [reachability.lockHeaderName]: reachability.lockSecret } }
            : {}),
    });
}
/**
 * Derives the complete deduped, sorted route set for the effective resource
 * paths using only the shared route algebra (never hand-wired).
 */
function deriveRoutePaths(configuredResourcePaths) {
    const effectiveResourcePaths = configuredResourcePaths !== undefined && configuredResourcePaths.length > 0
        ? configuredResourcePaths
        : mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.supportedEndpointTemplates().map((template) => template.mcpPattern);
    const derivations = [
        (resourcePath) => resourcePath,
        (resourcePath) => mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.protectedResourcePathForResourcePath(resourcePath),
        (resourcePath) => mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath(resourcePath),
        (resourcePath) => mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.authorizationAuthorizePathForResourcePath(resourcePath),
        (resourcePath) => mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.authorizationTokenPathForResourcePath(resourcePath),
        (resourcePath) => mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.authorizationRegisterPathForResourcePath(resourcePath),
        (resourcePath) => mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.authorizationServerSuffixPathForResourcePath(resourcePath),
    ];
    const derived = new Set();
    for (const resourcePath of effectiveResourcePaths) {
        for (const derive of derivations) {
            try {
                derived.add(derive(resourcePath));
            }
            catch (error) {
                throw new Error(`AppTheoryRestV1ChallengeRestoration: resourcePaths entry "${resourcePath}" is not a route the route model can derive: ${errorMessage(error)}`);
            }
        }
    }
    // The upstream OAuth callback is stage-global, so it is derived exactly once
    // rather than per resource path. The contract default is always derivable.
    derived.add(mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.callbackPathForConfiguredPath(mcp_route_algebra_1.AppTheoryMcpRouteAlgebra.DEFAULT_CALLBACK_PATH));
    return Array.from(derived).sort();
}
/** Returns a thrown value's message without assuming it is an Error. */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC12MS1jaGFsbGVuZ2UtcmVzdG9yYXRpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyZXN0LXYxLWNoYWxsZW5nZS1yZXN0b3JhdGlvbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQW9DO0FBR3BDLHVFQUF5RDtBQUN6RCw0RUFBOEQ7QUFDOUQsK0RBQWlEO0FBQ2pELDJDQUF1QztBQUV2QywyREFBK0Q7QUFDL0QsMkdBQWdIO0FBQ2hILCtEQUEwRTtBQUcxRSx3RkFBd0Y7QUFDeEYsTUFBTSxrQ0FBa0MsR0FBRyx5Q0FBeUMsQ0FBQztBQUVyRixnRUFBZ0U7QUFDaEUsTUFBTSxpQ0FBaUMsR0FBRyxzQ0FBc0MsQ0FBQztBQUVqRjs7Ozs7O0dBTUc7QUFDSCxNQUFNLG1CQUFtQixHQUFHLGtDQUFrQyxDQUFDO0FBRS9EOzs7R0FHRztBQUNILE1BQU0sb0JBQW9CLEdBQUcsQ0FBQywyQkFBMkIsRUFBRSxzQkFBc0IsQ0FBQyxDQUFDO0FBRW5GOzs7OztHQUtHO0FBQ0gsTUFBTSwwQkFBMEIsR0FDOUIsd0ZBQXdGO0lBQ3hGLHVFQUF1RSxDQUFDO0FBRTFFLDJGQUEyRjtBQUMzRixNQUFNLDBCQUEwQixHQUFHLHlCQUF5QixDQUFDO0FBRTdEOzs7Ozs7O0dBT0c7QUFDSCxNQUFNLDBCQUEwQixHQUFHLDJCQUEyQixDQUFDO0FBRS9ELDRDQUE0QztBQUM1QyxNQUFNLCtCQUErQixHQUFHLHNCQUFzQixDQUFDO0FBRS9EOzs7R0FHRztBQUNILE1BQU0sNEJBQTRCLEdBQUcsSUFBSSxHQUFHLENBQUM7SUFDM0MsZUFBZTtJQUNmLFlBQVk7SUFDWixnQkFBZ0I7SUFDaEIsUUFBUTtJQUNSLE1BQU07SUFDTixtQkFBbUI7SUFDbkIsa0JBQWtCO0lBQ2xCLGlCQUFpQjtDQUNsQixDQUFDLENBQUM7QUFFSDs7Ozs7Ozs7R0FRRztBQUNILElBQVksaUNBMkJYO0FBM0JELFdBQVksaUNBQWlDO0lBQzNDOzs7Ozs7Ozs7Ozs7Ozs7T0FlRztJQUNILDBEQUFxQixDQUFBO0lBQ3JCOzs7Ozs7O09BT0c7SUFDSCxzREFBaUIsQ0FBQTtBQUNuQixDQUFDLEVBM0JXLGlDQUFpQyxpREFBakMsaUNBQWlDLFFBMkI1QztBQThKRDs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBeURHO0FBQ0gsTUFBYSxtQ0FBb0MsU0FBUSxzQkFBUzs7SUFDaEUsK0RBQStEO0lBQy9DLFlBQVksQ0FBMEI7SUFFdEQ7Ozs7OztPQU1HO0lBQ2Esb0JBQW9CLENBQVc7SUFFL0Msc0RBQXNEO0lBQ3RDLGtCQUFrQixDQUFVO0lBRTVDLDZEQUE2RDtJQUM3QyxrQkFBa0IsQ0FBb0M7SUFFdEU7OztPQUdHO0lBQ2Esb0JBQW9CLENBQVU7SUFFOUM7OztPQUdHO0lBQ2EsaUJBQWlCLENBQVc7SUFFNUM7Ozs7OztPQU1HO0lBQ2Esb0JBQW9CLENBQVc7SUFFL0MsWUFDRSxLQUFnQixFQUNoQixFQUFVLEVBQ1YsS0FBK0M7UUFFL0MsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLE1BQU0sR0FBSSxLQUFxQyxDQUFDLE1BQU0sQ0FBQztRQUM3RCxrQkFBa0IsQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUUzQixNQUFNLFlBQVksR0FBRyx5QkFBeUIsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN0RCxJQUFJLENBQUMsa0JBQWtCLEdBQUcsWUFBWSxDQUFDLFFBQVEsQ0FBQztRQUNoRCxJQUFJLENBQUMsb0JBQW9CLEdBQUcsWUFBWSxDQUFDLGNBQWMsQ0FBQztRQUV4RCxJQUNFLEtBQUssQ0FBQyxXQUFXLEtBQUssU0FBUztZQUMvQixLQUFLLENBQUMsV0FBVyxDQUFDLE1BQU0sR0FBRyxDQUFDO1lBQzVCLEtBQUssQ0FBQyxXQUFXLEtBQUssU0FBUyxFQUMvQixDQUFDO1lBQ0QsTUFBTSxJQUFJLEtBQUssQ0FDYix1RUFBdUUsQ0FDeEUsQ0FBQztRQUNKLENBQUM7UUFFRCxJQUFJLENBQUMsa0JBQWtCLEdBQUcsS0FBSyxDQUFDLFdBQVcsRUFBRSxPQUFPLEtBQUssSUFBSSxDQUFDO1FBQzlELElBQUksQ0FBQyxvQkFBb0IsR0FBRyxJQUFJLENBQUMsa0JBQWtCO1lBQ2pELENBQUMsQ0FBQyxDQUFDLG1CQUFtQixFQUFFLEdBQUcsb0JBQW9CLENBQUM7WUFDaEQsQ0FBQyxDQUFDLENBQUMsbUJBQW1CLENBQUMsQ0FBQztRQUUxQixNQUFNLGlCQUFpQixHQUFHLGdCQUFnQixDQUFDLEtBQUssQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUNoRSxJQUFJLGlCQUFpQixDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsQ0FBQztZQUNuQyxNQUFNLElBQUksS0FBSyxDQUNiLDJGQUEyRixDQUM1RixDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksQ0FBQyxpQkFBaUIsR0FBRyxpQkFBaUIsQ0FBQztRQUMzQyxJQUFJLENBQUMsb0JBQW9CLEdBQUcsaUJBQWlCLENBQUMsTUFBTSxDQUNsRCxDQUFDLFdBQVcsRUFBRSxFQUFFLENBQUMsQ0FBQyxXQUFXLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FDMUUsQ0FBQztRQUVGLE1BQU0sVUFBVSxHQUFHLGlCQUFpQixDQUFDLElBQUksRUFBRSxNQUFNLEVBQUUsWUFBWSxDQUFDLENBQUM7UUFFakUsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLFVBQVUsQ0FBQyxZQUFZLENBQUMsWUFBWSxDQUNsRSxJQUFJLEVBQ0osOEJBQThCLEVBQzlCO1lBQ0UsT0FBTyxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsV0FBVztZQUNuQyxPQUFPLEVBQUUsZUFBZTtZQUN4QixJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQzFCLElBQUEscUZBQTZDLEVBQUMsSUFBSSxDQUFDLG9CQUFvQixDQUFDLENBQ3pFO1lBQ0QsV0FBVyxFQUNULHlGQUF5RjtTQUM1RixDQUNGLENBQUM7UUFFRix1RUFBdUU7UUFDdkUsdUVBQXVFO1FBQ3ZFLDJFQUEyRTtRQUMzRSxvRUFBb0U7UUFDcEUsdUVBQXVFO1FBQ3ZFLHdDQUF3QztRQUN4QyxFQUFFO1FBQ0YsNEVBQTRFO1FBQzVFLDBFQUEwRTtRQUMxRSw2RUFBNkU7UUFDN0Usb0NBQW9DO1FBQ3BDLEVBQUU7UUFDRiwwRUFBMEU7UUFDMUUsMEVBQTBFO1FBQzFFLDBFQUEwRTtRQUMxRSx1RUFBdUU7UUFDdkUsb0VBQW9FO1FBQ3BFLGFBQWE7UUFDYixNQUFNLG1CQUFtQixHQUFHO1lBQzFCLE1BQU07WUFDTixHQUFHLENBQUMsSUFBSSxDQUFDLG9CQUFvQixLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsb0JBQW9CLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1NBQ2hGLENBQUM7UUFDRixNQUFNLG1CQUFtQixHQUFHLElBQUksVUFBVSxDQUFDLG1CQUFtQixDQUM1RCxJQUFJLEVBQ0oscUJBQXFCLEVBQ3JCO1lBQ0UsT0FBTyxFQUNMLCtJQUErSTtZQUNqSixjQUFjLEVBQ1osVUFBVSxDQUFDLDJCQUEyQixDQUFDLFFBQVEsQ0FBQyxHQUFHLG1CQUFtQixDQUFDO1lBQ3pFLGNBQWMsRUFBRSxVQUFVLENBQUMsMkJBQTJCLENBQUMsR0FBRyxFQUFFO1lBQzVELG1CQUFtQixFQUFFLFVBQVUsQ0FBQyxnQ0FBZ0MsQ0FBQyxHQUFHLEVBQUU7U0FDdkUsQ0FDRixDQUFDO1FBRUYsTUFBTSxXQUFXLEdBQTRCO1lBQzNDO2dCQUNFLFNBQVMsRUFBRSxVQUFVLENBQUMsbUJBQW1CLENBQUMsZUFBZTtnQkFDekQsZUFBZSxFQUFFLG1CQUFtQixDQUFDLGNBQWM7YUFDcEQ7U0FDRixDQUFDO1FBQ0YsTUFBTSxlQUFlLEdBQUcsR0FBK0IsRUFBRSxDQUFDLENBQUM7WUFDekQsTUFBTSxFQUFFLFVBQVU7WUFDbEIsY0FBYyxFQUFFLFVBQVUsQ0FBQyxjQUFjLENBQUMsU0FBUztZQUNuRCxXQUFXLEVBQUUsVUFBVSxDQUFDLFdBQVcsQ0FBQyxnQkFBZ0I7WUFDcEQsbUJBQW1CO1lBQ25CLG9CQUFvQixFQUFFLFVBQVUsQ0FBQyxvQkFBb0IsQ0FBQyxpQkFBaUI7WUFDdkUsV0FBVztTQUNaLENBQUMsQ0FBQztRQUVILE1BQU0sbUJBQW1CLEdBQStDLEVBQUUsQ0FBQztRQUMzRSxLQUFLLE1BQU0sV0FBVyxJQUFJLElBQUksQ0FBQyxvQkFBb0IsRUFBRSxDQUFDO1lBQ3BELG1CQUFtQixDQUFDLFdBQVcsQ0FBQyxHQUFHLGVBQWUsRUFBRSxDQUFDO1FBQ3ZELENBQUM7UUFFRCxNQUFNLGNBQWMsR0FDbEIsS0FBSyxDQUFDLFdBQVcsS0FBSyxTQUFTLElBQUksS0FBSyxDQUFDLFdBQVcsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxJQUFJLEtBQUssQ0FBQyxXQUFXLEtBQUssU0FBUyxDQUFDO1FBQ3JHLE1BQU0sc0JBQXNCLEdBQUcsSUFBQSwrQ0FBNkIsRUFDMUQsS0FBSyxDQUFDLGFBQWEsRUFDbkIsY0FBYyxFQUNkLEtBQUssQ0FBQyxzQkFBc0IsQ0FDN0IsQ0FBQztRQUVGLElBQUksQ0FBQyxZQUFZLEdBQUcsSUFBSSxVQUFVLENBQUMsWUFBWSxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7WUFDcEUsZUFBZSxFQUFFLGVBQWUsRUFBRTtZQUNsQyxtQkFBbUI7WUFDbkIsR0FBRyxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsRUFBRSxXQUFXLEVBQUUsS0FBSyxDQUFDLFdBQVcsRUFBRSxXQUFXLEVBQUUsS0FBSyxDQUFDLFdBQVcsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDN0YsR0FBRyxDQUFDLHNCQUFzQixLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRSxzQkFBc0IsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDM0UsR0FBRyxDQUFDLEtBQUssQ0FBQyxVQUFVLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLFVBQVUsRUFBRSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztTQUM1RSxDQUFDLENBQUM7UUFFSCxNQUFNLGVBQWUsR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDLElBQUk7YUFDM0MsWUFBMEMsQ0FBQztRQUM5QyxlQUFlLENBQUMsV0FBVyxDQUFDLGtDQUFrQyxFQUFFO1lBQzlELFVBQVUsRUFBRSxpQ0FBaUM7WUFDN0MsV0FBVyxFQUFFLElBQUksQ0FBQyxrQkFBa0I7WUFDcEMsYUFBYSxFQUFFLElBQUksQ0FBQyxvQkFBb0I7WUFDeEMsVUFBVSxFQUFFLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxNQUFNO1lBQ3pDLGtCQUFrQixFQUFFLElBQUksQ0FBQyxrQkFBa0I7WUFDM0MsR0FBRyxDQUFDLElBQUksQ0FBQyxvQkFBb0IsS0FBSyxTQUFTO2dCQUN6QyxDQUFDLENBQUMsRUFBRSxnQkFBZ0IsRUFBRSxJQUFJLENBQUMsb0JBQW9CLEVBQUU7Z0JBQ2pELENBQUMsQ0FBQyxFQUFFLGlDQUFpQyxFQUFFLElBQUksRUFBRSxDQUFDO1NBQ2pELENBQUMsQ0FBQztJQUNMLENBQUM7O0FBbkxILGtGQW9MQztBQVNELGtGQUFrRjtBQUNsRixTQUFTLGdCQUFnQixDQUFDLFFBQWlCO0lBQ3pDLE9BQU8sT0FBTyxRQUFRLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDcEYsQ0FBQztBQUVEOzs7Ozs7R0FNRztBQUNILFNBQVMseUJBQXlCLENBQ2hDLEtBQStDO0lBRS9DLE1BQU0sUUFBUSxHQUFHLEtBQUssQ0FBQyxrQkFBa0IsQ0FBQztJQUMxQyxJQUNFLFFBQVEsS0FBSyxpQ0FBaUMsQ0FBQyxRQUFRO1FBQ3ZELFFBQVEsS0FBSyxpQ0FBaUMsQ0FBQyxNQUFNLEVBQ3JELENBQUM7UUFDRCxNQUFNLElBQUksS0FBSyxDQUNiLGtGQUFrRjtZQUNoRixxRkFBcUY7WUFDckYsOENBQThDLGdCQUFnQixDQUFDLFFBQVEsQ0FBQyxLQUFLO1lBQzdFLDZGQUE2RjtZQUM3RixnR0FBZ0c7WUFDaEcsNEZBQTRGLENBQy9GLENBQUM7SUFDSixDQUFDO0lBRUQsSUFBSSxRQUFRLEtBQUssaUNBQWlDLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDNUQsSUFBSSxLQUFLLENBQUMsVUFBVSxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ25DLE1BQU0sSUFBSSxLQUFLLENBQ2Isd0ZBQXdGO2dCQUN0RiwwQ0FBMEMsQ0FDN0MsQ0FBQztRQUNKLENBQUM7UUFDRCxJQUFJLEtBQUssQ0FBQyxpQ0FBaUMsS0FBSyxJQUFJLEVBQUUsQ0FBQztZQUNyRCxNQUFNLElBQUksS0FBSyxDQUNiLDRFQUE0RTtnQkFDMUUseUZBQXlGO2dCQUN6RiwrRkFBK0YsQ0FDbEcsQ0FBQztRQUNKLENBQUM7UUFDRCxPQUFPLEVBQUUsUUFBUSxFQUFFLENBQUM7SUFDdEIsQ0FBQztJQUVELElBQUksS0FBSyxDQUFDLGlDQUFpQyxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQzFELE1BQU0sSUFBSSxLQUFLLENBQ2IsNEZBQTRGO1lBQzFGLCtEQUErRCxDQUNsRSxDQUFDO0lBQ0osQ0FBQztJQUVELE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxVQUFVLENBQUM7SUFDOUIsSUFBSSxJQUFJLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDdkIsTUFBTSxJQUFJLEtBQUssQ0FDYixxRkFBcUY7WUFDbkYsaUdBQWlHO1lBQ2pHLDBCQUEwQixDQUM3QixDQUFDO0lBQ0osQ0FBQztJQUNELElBQUksSUFBSSxDQUFDLFFBQVEsS0FBSyxJQUFJLEVBQUUsQ0FBQztRQUMzQixNQUFNLElBQUksS0FBSyxDQUNiLG9HQUFvRztZQUNsRywrRkFBK0Y7WUFDL0YsdUVBQXVFLENBQzFFLENBQUM7SUFDSixDQUFDO0lBQ0QsSUFBSSxPQUFPLElBQUksQ0FBQyxNQUFNLEtBQUssUUFBUSxJQUFJLENBQUMsMEJBQTBCLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBQ3JGLE1BQU0sSUFBSSxLQUFLLENBQ2IsdUZBQXVGO1lBQ3JGLDhGQUE4RjtZQUM5RixxQ0FBcUMsQ0FDeEMsQ0FBQztJQUNKLENBQUM7SUFFRCxNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsVUFBVSxJQUFJLDBCQUEwQixDQUFDO0lBQ2pFLElBQUksQ0FBQywrQkFBK0IsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQztRQUN0RCxNQUFNLElBQUksS0FBSyxDQUNiLHFHQUFxRyxDQUN0RyxDQUFDO0lBQ0osQ0FBQztJQUNELE1BQU0sb0JBQW9CLEdBQUcsVUFBVSxDQUFDLFdBQVcsRUFBRSxDQUFDO0lBQ3RELElBQ0UsNEJBQTRCLENBQUMsR0FBRyxDQUFDLG9CQUFvQixDQUFDO1FBQ3RELG9CQUFvQixDQUFDLFVBQVUsQ0FBQyxRQUFRLENBQUM7UUFDekMsb0JBQW9CLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQztRQUMxQyxvQkFBb0IsQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLEVBQzlDLENBQUM7UUFDRCxNQUFNLElBQUksS0FBSyxDQUNiLCtEQUErRCxVQUFVLDZGQUE2RixDQUN2SyxDQUFDO0lBQ0osQ0FBQztJQUVELE9BQU8sRUFBRSxRQUFRLEVBQUUsY0FBYyxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDO0FBQzNFLENBQUM7QUFFRCx3RUFBd0U7QUFDeEUsU0FBUyxrQkFBa0IsQ0FDekIsTUFBa0M7SUFFbEMsSUFDRSxNQUFNLEtBQUssU0FBUztRQUNwQixPQUFPLE1BQU0sQ0FBQyxTQUFTLEtBQUssUUFBUTtRQUNwQyxNQUFNLENBQUMsU0FBUyxDQUFDLE1BQU0sS0FBSyxDQUFDO1FBQzdCLE9BQU8sTUFBTSxDQUFDLHFCQUFxQixLQUFLLFFBQVE7UUFDaEQsTUFBTSxDQUFDLHFCQUFxQixDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQ3pDLENBQUM7UUFDRCxNQUFNLElBQUksS0FBSyxDQUFDLDBCQUEwQixDQUFDLENBQUM7SUFDOUMsQ0FBQztBQUNILENBQUM7QUFFRDs7Ozs7Ozs7O0dBU0c7QUFDSCxTQUFTLGlCQUFpQixDQUN4QixLQUFnQixFQUNoQixNQUFzQixFQUN0QixZQUF3QztJQUV4QyxNQUFNLEtBQUssR0FBRyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM5QixNQUFNLGdCQUFnQixHQUFHLEdBQUcsTUFBTSxDQUFDLFNBQVMsZ0JBQWdCLEtBQUssQ0FBQyxNQUFNLElBQUksS0FBSyxDQUFDLFNBQVMsRUFBRSxDQUFDO0lBQzlGLE1BQU0sU0FBUyxHQUFHLE1BQU0sQ0FBQyxlQUFlLEVBQUUsU0FBUyxDQUFDO0lBQ3BELE9BQU8sSUFBSSxPQUFPLENBQUMsVUFBVSxDQUFDLGdCQUFnQixFQUFFO1FBQzlDLGNBQWMsRUFBRSxVQUFVLENBQUMsb0JBQW9CLENBQUMsVUFBVTtRQUMxRCxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLFVBQVUsRUFBRSxJQUFJLFNBQVMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUNyRCxHQUFHLENBQUMsWUFBWSxDQUFDLGNBQWMsS0FBSyxTQUFTLElBQUksWUFBWSxDQUFDLFVBQVUsS0FBSyxTQUFTO1lBQ3BGLENBQUMsQ0FBQyxFQUFFLGFBQWEsRUFBRSxFQUFFLENBQUMsWUFBWSxDQUFDLGNBQWMsQ0FBQyxFQUFFLFlBQVksQ0FBQyxVQUFVLEVBQUUsRUFBRTtZQUMvRSxDQUFDLENBQUMsRUFBRSxDQUFDO0tBQ1IsQ0FBQyxDQUFDO0FBQ0wsQ0FBQztBQUVEOzs7R0FHRztBQUNILFNBQVMsZ0JBQWdCLENBQUMsdUJBQWtDO0lBQzFELE1BQU0sc0JBQXNCLEdBQzFCLHVCQUF1QixLQUFLLFNBQVMsSUFBSSx1QkFBdUIsQ0FBQyxNQUFNLEdBQUcsQ0FBQztRQUN6RSxDQUFDLENBQUMsdUJBQXVCO1FBQ3pCLENBQUMsQ0FBQyw0Q0FBd0IsQ0FBQywwQkFBMEIsRUFBRSxDQUFDLEdBQUcsQ0FDdkQsQ0FBQyxRQUFRLEVBQUUsRUFBRSxDQUFDLFFBQVEsQ0FBQyxVQUFVLENBQ2xDLENBQUM7SUFFUixNQUFNLFdBQVcsR0FBNEM7UUFDM0QsQ0FBQyxZQUFZLEVBQUUsRUFBRSxDQUFDLFlBQVk7UUFDOUIsQ0FBQyxZQUFZLEVBQUUsRUFBRSxDQUNmLDRDQUF3QixDQUFDLG9DQUFvQyxDQUFDLFlBQVksQ0FBQztRQUM3RSxDQUFDLFlBQVksRUFBRSxFQUFFLENBQ2YsNENBQXdCLENBQUMsc0NBQXNDLENBQUMsWUFBWSxDQUFDO1FBQy9FLENBQUMsWUFBWSxFQUFFLEVBQUUsQ0FDZiw0Q0FBd0IsQ0FBQyx5Q0FBeUMsQ0FBQyxZQUFZLENBQUM7UUFDbEYsQ0FBQyxZQUFZLEVBQUUsRUFBRSxDQUNmLDRDQUF3QixDQUFDLHFDQUFxQyxDQUFDLFlBQVksQ0FBQztRQUM5RSxDQUFDLFlBQVksRUFBRSxFQUFFLENBQ2YsNENBQXdCLENBQUMsd0NBQXdDLENBQUMsWUFBWSxDQUFDO1FBQ2pGLENBQUMsWUFBWSxFQUFFLEVBQUUsQ0FDZiw0Q0FBd0IsQ0FBQyw0Q0FBNEMsQ0FBQyxZQUFZLENBQUM7S0FDdEYsQ0FBQztJQUVGLE1BQU0sT0FBTyxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7SUFDbEMsS0FBSyxNQUFNLFlBQVksSUFBSSxzQkFBc0IsRUFBRSxDQUFDO1FBQ2xELEtBQUssTUFBTSxNQUFNLElBQUksV0FBVyxFQUFFLENBQUM7WUFDakMsSUFBSSxDQUFDO2dCQUNILE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUM7WUFDcEMsQ0FBQztZQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7Z0JBQ2YsTUFBTSxJQUFJLEtBQUssQ0FDYiw2REFBNkQsWUFBWSxnREFBZ0QsWUFBWSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQy9JLENBQUM7WUFDSixDQUFDO1FBQ0gsQ0FBQztJQUNILENBQUM7SUFFRCw2RUFBNkU7SUFDN0UsMkVBQTJFO0lBQzNFLE9BQU8sQ0FBQyxHQUFHLENBQ1QsNENBQXdCLENBQUMsNkJBQTZCLENBQ3BELDRDQUF3QixDQUFDLHFCQUFxQixDQUMvQyxDQUNGLENBQUM7SUFFRixPQUFPLEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7QUFDcEMsQ0FBQztBQUVELHdFQUF3RTtBQUN4RSxTQUFTLFlBQVksQ0FBQyxLQUFjO0lBQ2xDLE9BQU8sS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ2hFLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBTdGFjayB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBhcGlndyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXlcIjtcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250XCI7XG5pbXBvcnQgKiBhcyBvcmlnaW5zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udC1vcmlnaW5zXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYSB9IGZyb20gXCIuL21jcC1yb3V0ZS1hbGdlYnJhXCI7XG5pbXBvcnQgeyBnZW5lcmF0ZVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uSGFuZGxlckNvZGUgfSBmcm9tIFwiLi9wcml2YXRlL3Jlc3QtdjEtY2hhbGxlbmdlLXJlc3RvcmF0aW9uLWhhbmRsZXJcIjtcbmltcG9ydCB7IGRlZmF1bHRNaW5pbXVtUHJvdG9jb2xWZXJzaW9uIH0gZnJvbSBcIi4vcHJpdmF0ZS9zZWN1cmUtZGVmYXVsdHNcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuL25hbWluZy1jb250ZXh0XCI7XG5cbi8qKiBNZXRhZGF0YSBrZXkgcmVjb3JkZWQgb24gdGhlIGRpc3RyaWJ1dGlvbiBmb3IgdGhlIGNoYWxsZW5nZS1yZXN0b3JhdGlvbiBjb250cmFjdC4gKi9cbmNvbnN0IENIQUxMRU5HRV9SRVNUT1JBVElPTl9NRVRBREFUQV9LRVkgPSBcImFwcHRoZW9yeTpyZXN0LXYxLWNoYWxsZW5nZS1yZXN0b3JhdGlvblwiO1xuXG4vKiogQ29udHJhY3QgaWQgcmVjb3JkZWQgaW4gdGhlIGRpc3RyaWJ1dGlvbiBtZXRhZGF0YSBtYXJrZXIuICovXG5jb25zdCBDSEFMTEVOR0VfUkVTVE9SQVRJT05fQ09OVFJBQ1RfSUQgPSBcIm0xNy5yZXN0LXYxLWNoYWxsZW5nZS1yZXN0b3JhdGlvbi92MVwiO1xuXG4vKipcbiAqIFRoZSBtYW5pZmVzdCBjb25zdGFudCBmb3IgdGhlIEFXUyBSRVNUIHYxIHJlbWFwIGFydGlmYWN0LlxuICpcbiAqIEFXUyBBUEkgR2F0ZXdheSBSRVNUIEFQSSB2MSByZW1hcHMgdGhlIG9yaWdpbidzIGBXV1ctQXV0aGVudGljYXRlYCByZXNwb25zZVxuICogaGVhZGVyIG9udG8gdGhpcyBoZWFkZXIsIHNvIGl0IGlzIHRoZSByZXN0b3JlIHNvdXJjZSB0aGF0IGRvZXMgbm90IGRlcGVuZCBvblxuICogYW55IG9wdGlvbmFsIGJyaWRnZS5cbiAqL1xuY29uc3QgUkVNQVBfU09VUkNFX0hFQURFUiA9IFwieC1hbXpuLXJlbWFwcGVkLXd3dy1hdXRoZW50aWNhdGVcIjtcblxuLyoqXG4gKiBUaGUgb3B0aW9uYWwgYWxpYXMgYnJpZGdlIHNwZWxsaW5ncywgY29uc3VsdGVkIG9ubHkgd2hlbiB0aGUgYWxpYXMgYnJpZGdlIGlzXG4gKiBlbmFibGVkLCBpbiBwcmlvcml0eSBvcmRlciBhZnRlciB0aGUgcmVtYXAgYXJ0aWZhY3QuXG4gKi9cbmNvbnN0IEFMSUFTX1NPVVJDRV9IRUFERVJTID0gW1wieC10aGVvcnktd3d3LWF1dGhlbnRpY2F0ZVwiLCBcIm1jcC13d3ctYXV0aGVudGljYXRlXCJdO1xuXG4vKipcbiAqIFRoZSBkZWZhdWx0IFJFU1QgdjEgdHJhbnNwb3J0LWZhaWx1cmUgbWVzc2FnZS5cbiAqXG4gKiBUaGUgcmVzdG9yYXRpb24gaXMgYSBkb2N1bWVudGVkIG5vLW9wIG9uIEhUVFAgQVBJIHYyLCBzbyBhIG5vbi1SRVNULXYxIG9yaWdpblxuICogZmFpbHMgc3ludGggcmF0aGVyIHRoYW4gc2lsZW50bHkgZGVncmFkaW5nLlxuICovXG5jb25zdCBOT05fUkVTVF9WMV9PUklHSU5fTUVTU0FHRSA9XG4gIFwiQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb246IG9yaWdpbiBtdXN0IGJlIGFuIEFXUyBBUEkgR2F0ZXdheSBSRVNUIEFQSSAodjEpOyBcIiArXG4gIFwidGhlIFdXVy1BdXRoZW50aWNhdGUgcmVzdG9yYXRpb24gaXMgYSBkb2N1bWVudGVkIG5vLW9wIG9uIEhUVFAgQVBJIHYyXCI7XG5cbi8qKiBUaGUgb3JpZ2luLWxvY2sgaGVhZGVyIHRoaXMgY29uc3RydWN0IGluamVjdHMgb24gYW55IHJlcXVlc3QgaXQgc2VuZHMgdG8gdGhlIG9yaWdpbi4gKi9cbmNvbnN0IERFRkFVTFRfT1JJR0lOX0xPQ0tfSEVBREVSID0gXCJ4LWFwcHRoZW9yeS1vcmlnaW4tbG9ja1wiO1xuXG4vKipcbiAqIFRoZSBvcmlnaW4tbG9jayBzZWNyZXQgYWxwaGFiZXQuXG4gKlxuICogVGhlIHZhbHVlIGlzIGEgbGl0ZXJhbCBDbG91ZEZyb250IG9yaWdpbiBjdXN0b20gaGVhZGVyIHZhbHVlIChDbG91ZEZyb250XG4gKiBjdXN0b20gb3JpZ2luIGhlYWRlcnMgY2FycnkgcGxhaW4gc3RyaW5ncywgbm90IHRlbXBsYXRlIGludHJpbnNpY3MpLCBzbyB0aGVcbiAqIHNlY3JldCBpcyByZXN0cmljdGVkIHRvIGEgaGVhZGVyLXZhbHVlLXNhZmUgYWxwaGFiZXQgd2l0aCBubyB3aGl0ZXNwYWNlIGFuZCBub1xuICogY29udHJvbCBjaGFyYWN0ZXJzLlxuICovXG5jb25zdCBPUklHSU5fTE9DS19TRUNSRVRfUEFUVEVSTiA9IC9eW0EtWmEtejAtOS5ffi1dezMyLDEyOH0kLztcblxuLyoqIFRoZSBvcmlnaW4tbG9jayBoZWFkZXIgbmFtZSBhbHBoYWJldC4gKi9cbmNvbnN0IE9SSUdJTl9MT0NLX0hFQURFUl9OQU1FX1BBVFRFUk4gPSAvXltBLVphLXowLTktXXsxLDY0fSQvO1xuXG4vKipcbiAqIEhlYWRlciBuYW1lcyBDbG91ZEZyb250IHJlc2VydmVzIG9yIHRoYXQgd291bGQgcmV3cml0ZSB0aGUgb3JpZ2luIHJlcXVlc3RcbiAqIGNvbnRyYWN0LCBzbyB0aGV5IGNhbiBuZXZlciBjYXJyeSB0aGUgb3JpZ2luIGxvY2suXG4gKi9cbmNvbnN0IFJFU0VSVkVEX09SSUdJTl9MT0NLX0hFQURFUlMgPSBuZXcgU2V0KFtcbiAgXCJhdXRob3JpemF0aW9uXCIsXG4gIFwiY29ubmVjdGlvblwiLFxuICBcImNvbnRlbnQtbGVuZ3RoXCIsXG4gIFwiY29va2llXCIsXG4gIFwiaG9zdFwiLFxuICBcInRyYW5zZmVyLWVuY29kaW5nXCIsXG4gIFwid3d3LWF1dGhlbnRpY2F0ZVwiLFxuICBcIngtZm9yd2FyZGVkLWZvclwiLFxuXSk7XG5cbi8qKlxuICogVGhlIERELTIgZGlyZWN0LW9yaWdpbiByZWFjaGFiaWxpdHkgZGVjaXNpb24gZm9yIGEgUkVTVCB2MSBvcmlnaW4uXG4gKlxuICogREQtMiAoYERFRkVOU0VfSU5fREVQVEgubWRgKSByZXF1aXJlcyB0aGUgZGVwbG95bWVudCB0byAqKnJlY29yZCoqIHdoZXRoZXIgdGhlXG4gKiBgZXhlY3V0ZS1hcGlgIGRlZmF1bHQgZW5kcG9pbnQgaXMgZGlyZWN0bHkgcmVhY2hhYmxlIGFuZCwgd2hlbiBpdCBpcywgdG8gbWFrZVxuICogdGhhdCBwb3N0dXJlIGV4cGxpY2l0LiBBIGRpcmVjdGx5IHJlYWNoYWJsZSBvcmlnaW4gKGBkaXJlY3RgKSBpcyAqKm5vdCoqXG4gKiBhbGxvd2VkOiBpdCBpcyBub3QgYSBtZW1iZXIgb2YgdGhpcyBlbnVtIGFuZCB0aGUgY29uc3RydWN0IHJlZnVzZXMgaXQgYXRcbiAqIHN5bnRoZXNpcy5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5UmVzdFYxT3JpZ2luUmVhY2hhYmlsaXR5IHtcbiAgLyoqXG4gICAqIFRoZSBSRVNUIEFQSSdzIGBleGVjdXRlLWFwaWAgZGVmYXVsdCBlbmRwb2ludCBpcyBkaXNhYmxlZFxuICAgKiAoYGRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnRgKSwgc28gdGhlIEFQSSBpcyBub3QgcmVhY2hhYmxlIGF0IGl0cyBkZWZhdWx0XG4gICAqIGVuZHBvaW50LlxuICAgKlxuICAgKiBCZWNhdXNlIHRoZSBjb25zdHJ1Y3QgZnJvbnRzIGFuIGV4dGVybmFsIGBJUmVzdEFwaWAgaXQgY2Fubm90IG11dGF0ZSwgdGhlXG4gICAqIGNhbGxlciBtdXN0IGFzc2VydCB0aGUgZGlzYWJsZW1lbnQgd2l0aFxuICAgKiBgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludEFzc2VydGVkOiB0cnVlYC5cbiAgICpcbiAgICogTm90ZSB0aGUgcGxhdGZvcm0gc2hhcGU6IHRoZSBkaXNhYmxlZCBob3N0bmFtZSBpcyBleGFjdGx5IHRoZVxuICAgKiBgPHJlc3RBcGlJZD4uZXhlY3V0ZS1hcGkuPHJlZ2lvbj4uPHVybFN1ZmZpeD5gIGhvc3RuYW1lIHRoaXMgY29uc3RydWN0IHVzZXNcbiAgICogYXMgaXRzIG9yaWdpbiwgc28gYW4gYXBwIHRoYXQgZGlzYWJsZXMgdGhlIGRlZmF1bHQgZW5kcG9pbnQgbXVzdCBmcm9udCBpdHNcbiAgICogUkVTVCBBUEkgdGhyb3VnaCBhIGN1c3RvbSBkb21haW4gKEFXUyByZXF1aXJlcyBhIGN1c3RvbSBkb21haW4gb25jZSB0aGVcbiAgICogZGVmYXVsdCBlbmRwb2ludCBpcyBkaXNhYmxlZCkuIGBMT0NLRURgIGlzIHRoZSBwb3N0dXJlIGZvciBhIFJFU1QgdjEgb3JpZ2luXG4gICAqIHRoaXMgY29uc3RydWN0IGlzIGV4cGVjdGVkIHRvIHNlcnZlLlxuICAgKi9cbiAgRElTQUJMRUQgPSBcImRpc2FibGVkXCIsXG4gIC8qKlxuICAgKiBUaGUgb3JpZ2luIGlzIHJlYWNoYWJsZSBvbmx5IHRocm91Z2ggdGhpcyBjb25zdHJ1Y3QncyBDbG91ZEZyb250IGZyb250IGRvb3IuXG4gICAqXG4gICAqIFJlcXVpcmVzIGBvcmlnaW5Mb2NrYCBjYXJyeWluZyB0aGUgb3JpZ2luLWxvY2sgc2VjcmV0IHRoZSBjb25zdHJ1Y3QgaW5qZWN0c1xuICAgKiBhcyBhIGN1c3RvbSBvcmlnaW4gaGVhZGVyLCBwbHVzIHRoZSBjYWxsZXIncyBhc3NlcnRpb24gdGhhdCB0aGUgUkVTVCBBUElcbiAgICogdmVyaWZpZXMgdGhhdCBoZWFkZXIgKHRoZSBjb25zdHJ1Y3QgY2Fubm90IGF0dGFjaCBhbiBvcmlnaW4tc2lkZVxuICAgKiB2ZXJpZmljYXRpb24gdG8gYW4gZXh0ZXJuYWwgYElSZXN0QXBpYCkuXG4gICAqL1xuICBMT0NLRUQgPSBcImxvY2tlZFwiLFxufVxuXG4vKipcbiAqIFRoZSBvcmlnaW4gbG9jayBmb3IgYG9yaWdpblJlYWNoYWJpbGl0eTogTE9DS0VEYC5cbiAqXG4gKiBUaGUgY29uc3RydWN0IGluamVjdHMgYHNlY3JldGAgYXMgdGhlIGBoZWFkZXJOYW1lYCBjdXN0b20gb3JpZ2luIGhlYWRlciBvblxuICogKipldmVyeSoqIHJlcXVlc3QgaXQgc2VuZHMgdG8gdGhlIFJFU1QgdjEgb3JpZ2luLCBzbyBhbiBvcmlnaW4tc2lkZVxuICogdmVyaWZpY2F0aW9uIGNhbiByZWZ1c2UgYSByZXF1ZXN0IHRoYXQgZGlkIG5vdCBjb21lIHRocm91Z2ggdGhpc1xuICogZGlzdHJpYnV0aW9uLiBUaGUgY29uc3RydWN0IGZyb250cyBhbiBleHRlcm5hbCBgSVJlc3RBcGlgLCBzbyBpdCBjYW5ub3QgYXR0YWNoXG4gKiB0aGF0IHZlcmlmaWNhdGlvbiBpdHNlbGY6IHRoZSBjYWxsZXIgYXNzZXJ0cyBpdCB3aXRoIGBhc3NlcnRlZDogdHJ1ZWAuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdFYxT3JpZ2luTG9ja09wdGlvbnMge1xuICAvKipcbiAgICogVGhlIGxpdGVyYWwgc2VjcmV0IGluamVjdGVkIGFzIHRoZSBvcmlnaW4tbG9jayBoZWFkZXIgb24gZXZlcnkgQ2xvdWRGcm9udFxuICAgKiByZXF1ZXN0IHRvIHRoZSBvcmlnaW4uXG4gICAqXG4gICAqIDMyIHRvIDEyOCBjaGFyYWN0ZXJzIG9mIGBbQS1aYS16MC05Ll9+LV1gLiBUaGUgdmFsdWUgaXMgYSBsaXRlcmFsIENsb3VkRnJvbnRcbiAgICogb3JpZ2luIGN1c3RvbSBoZWFkZXIgdmFsdWUsIHNvIGl0IGFwcGVhcnMgdmVyYmF0aW0gaW4gdGhlIHN5bnRoZXNpemVkXG4gICAqIHRlbXBsYXRlIGFuZCBtdXN0IG5vdCBiZSAob3IgY29udGFpbikgYSBjcmVkZW50aWFsIHlvdSBjYW5ub3Qgcm90YXRlIHdpdGggdGhlXG4gICAqIFJFU1QgQVBJJ3MgdmVyaWZpY2F0aW9uLlxuICAgKi9cbiAgcmVhZG9ubHkgc2VjcmV0OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBvcmlnaW4tbG9jayBoZWFkZXIgbmFtZS5cbiAgICpcbiAgICogMSB0byA2NCBjaGFyYWN0ZXJzIG9mIGBbQS1aYS16MC05LV1gLCBhbmQgbmV2ZXIgYSBuYW1lIENsb3VkRnJvbnQgcmVzZXJ2ZXMgb3JcbiAgICogdGhhdCByZXdyaXRlcyB0aGUgb3JpZ2luIHJlcXVlc3QgY29udHJhY3QgKGBIb3N0YCwgYEF1dGhvcml6YXRpb25gLFxuICAgKiBgQ29va2llYCwgYENvbnRlbnQtTGVuZ3RoYCwgYFRyYW5zZmVyLUVuY29kaW5nYCwgYENvbm5lY3Rpb25gLFxuICAgKiBgV1dXLUF1dGhlbnRpY2F0ZWAsIGBYLUZvcndhcmRlZC1Gb3JgLCBvciBhbnkgYHgtYW16LSpgLCBgeC1hbXpuLSpgLCBvclxuICAgKiBgY2xvdWRmcm9udC0qYCBuYW1lKS5cbiAgICpcbiAgICogQGRlZmF1bHQgXCJ4LWFwcHRoZW9yeS1vcmlnaW4tbG9ja1wiXG4gICAqL1xuICByZWFkb25seSBoZWFkZXJOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY2FsbGVyJ3MgYXNzZXJ0aW9uIHRoYXQgdGhlIFJFU1QgQVBJIHZlcmlmaWVzIHRoZSBvcmlnaW4gbG9jay5cbiAgICpcbiAgICogVGhpcyBjb25zdHJ1Y3QgY2Fubm90IGF0dGFjaCBhIHJlc291cmNlIHBvbGljeSwgYXV0aG9yaXplciwgb3IgYW55IG90aGVyXG4gICAqIG9yaWdpbi1zaWRlIHZlcmlmaWNhdGlvbiB0byBhbiBleHRlcm5hbCBgSVJlc3RBcGlgIGl0IGRvZXMgbm90IG93biwgc28gaXRcbiAgICogcmVmdXNlcyB0byBzeW50aGVzaXplIHVudGlsIHRoZSBjYWxsZXIgcmVjb3JkcyB0aGF0IHRoZSB2ZXJpZmljYXRpb24gZXhpc3RzXG4gICAqIGFuZCByZXF1aXJlcyB0aGUgaW5qZWN0ZWQgaGVhZGVyLiBNdXN0IGJlIGB0cnVlYC5cbiAgICovXG4gIHJlYWRvbmx5IGFzc2VydGVkOiBib29sZWFuO1xufVxuXG4vKipcbiAqIE9wdGlvbnMgZm9yIHRoZSBvcHRpb25hbCBjaGFsbGVuZ2UgYWxpYXMgYnJpZGdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUNoYWxsZW5nZUFsaWFzQnJpZGdlT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBFbmFibGVzIHRoZSBvcHRpb25hbCBjaGFsbGVuZ2UgYWxpYXMgYnJpZGdlLlxuICAgKlxuICAgKiBXaGVuIGVuYWJsZWQgdGhlIHJlc3RvcmF0aW9uIGNvbnN1bHRzIHRoZSBicmlkZ2UgYWxpYXNlc1xuICAgKiAoYHgtdGhlb3J5LXd3dy1hdXRoZW50aWNhdGVgLCB0aGVuIGBtY3Atd3d3LWF1dGhlbnRpY2F0ZWApIGFmdGVyIHRoZSBBV1NcbiAgICogUkVTVCB2MSByZW1hcCBhcnRpZmFjdC4gV2hlbiBkaXNhYmxlZCBvbmx5IHRoZSByZW1hcCBhcnRpZmFjdCBpcyBjb25zdWx0ZWRcbiAgICogYW5kIHRoZSBhbGlhcyBzcGVsbGluZ3MgbmV2ZXIgYXBwZWFyIGluIHRoZSBkZXBsb3llZCBmdW5jdGlvbiBzb3VyY2UuXG4gICAqXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBlbmFibGVkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBQcm9wZXJ0aWVzIGZvciBgQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb25gLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uUHJvcHMge1xuICAvKipcbiAgICogVGhlIFJFU1QgQVBJIHYxIG9yaWdpbiB3aG9zZSBgV1dXLUF1dGhlbnRpY2F0ZWAgcmVzcG9uc2VzIG11c3QgYmUgcmVzdG9yZWQuXG4gICAqXG4gICAqIE9ubHkgYW4gQVdTIEFQSSBHYXRld2F5IFJFU1QgQVBJIHYxIChhIG5vbi1lbXB0eSBgcmVzdEFwaUlkYCBhbmQgYSBub24tZW1wdHlcbiAgICogYHJlc3RBcGlSb290UmVzb3VyY2VJZGApIGlzIGFjY2VwdGVkOyB0aGUgcmVzdG9yYXRpb24gaXMgYSBkb2N1bWVudGVkIG5vLW9wXG4gICAqIG9uIEhUVFAgQVBJIHYyLlxuICAgKi9cbiAgcmVhZG9ubHkgb3JpZ2luOiBhcGlndy5JUmVzdEFwaTtcblxuICAvKipcbiAgICogVGhlIG1hbmRhdG9yeSBERC0yIGRpcmVjdC1vcmlnaW4gcmVhY2hhYmlsaXR5IGRlY2lzaW9uLlxuICAgKlxuICAgKiBSZXF1aXJlZC4gYERJU0FCTEVEYCBhbmQgYExPQ0tFRGAgc3ludGhlc2l6ZTsgYW55dGhpbmcgZWxzZSDigJQgaW4gcGFydGljdWxhciBhXG4gICAqIGRpcmVjdGx5IHJlYWNoYWJsZSBvcmlnaW4g4oCUIGZhaWxzIHN5bnRoZXNpcyB3aXRoIGFuIGVycm9yIHRoYXQgbmFtZXMgdGhlXG4gICAqIHJlamVjdGVkIGRlY2lzaW9uLlxuICAgKi9cbiAgcmVhZG9ubHkgb3JpZ2luUmVhY2hhYmlsaXR5OiBBcHBUaGVvcnlSZXN0VjFPcmlnaW5SZWFjaGFiaWxpdHk7XG5cbiAgLyoqXG4gICAqIFRoZSBjYWxsZXIncyBhc3NlcnRpb24gdGhhdCB0aGUgUkVTVCBBUEkncyBgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludGAgaXNcbiAgICogc2V0LCByZXF1aXJlZCB3aXRoIGBvcmlnaW5SZWFjaGFiaWxpdHk6IERJU0FCTEVEYC5cbiAgICpcbiAgICogVGhpcyBjb25zdHJ1Y3QgZnJvbnRzIGFuIGV4dGVybmFsIGBJUmVzdEFwaWAgaXQgY2Fubm90IG11dGF0ZSwgc28gaXQgY2Fubm90XG4gICAqIHNldCB0aGUgcHJvcGVydHkgZm9yIHRoZSBjYWxsZXI7IGl0IHJlcXVpcmVzIHRoZSBhc3NlcnRpb24gaW5zdGVhZCBhbmRcbiAgICogcmVjb3JkcyBpdCBpbiB0aGUgZGlzdHJpYnV0aW9uIG1ldGFkYXRhLlxuICAgKi9cbiAgcmVhZG9ubHkgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludEFzc2VydGVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogVGhlIG1hbmRhdG9yeSBvcmlnaW4gbG9jaywgcmVxdWlyZWQgd2l0aCBgb3JpZ2luUmVhY2hhYmlsaXR5OiBMT0NLRURgLlxuICAgKi9cbiAgcmVhZG9ubHkgb3JpZ2luTG9jaz86IEFwcFRoZW9yeVJlc3RWMU9yaWdpbkxvY2tPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBNQ1AgcmVzb3VyY2UgcGF0aHMgd2hvc2UgZGVyaXZlZCByb3V0ZXMgcmVjZWl2ZSBhbiBleHBsaWNpdCBvcmRlcmVkIGNhY2hlXG4gICAqIGJlaGF2aW9yLlxuICAgKlxuICAgKiBUaGUgZWZmZWN0aXZlIHJvdXRlIHNldCBpcyBkZXJpdmVkIGZyb20gdGhlIHNoYXJlZCByb3V0ZSBhbGdlYnJhLCBuZXZlclxuICAgKiBoYW5kLXdpcmVkLiBBIHN1cHBsaWVkLWJ1dC1lbXB0eSBhcnJheSBpcyB0cmVhdGVkIGFzIHRoZSBkZWZhdWx0LlxuICAgKlxuICAgKiBAZGVmYXVsdCB0aGUgc3RhbmRhcmQgTUNQIHBhdHRlcm5zIGZyb20gdGhlIHNoYXJlZCByb3V0ZSBhbGdlYnJhXG4gICAqIChgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnN1cHBvcnRlZEVuZHBvaW50VGVtcGxhdGVzKCkubWNwUGF0dGVybmApXG4gICAqL1xuICByZWFkb25seSByZXNvdXJjZVBhdGhzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIGNoYWxsZW5nZSBhbGlhcyBicmlkZ2UuXG4gICAqXG4gICAqIEBkZWZhdWx0IGRpc2FibGVkXG4gICAqL1xuICByZWFkb25seSBhbGlhc0JyaWRnZT86IEFwcFRoZW9yeUNoYWxsZW5nZUFsaWFzQnJpZGdlT3B0aW9ucztcblxuICAvKipcbiAgICogT3B0aW9uYWwgY3VzdG9tIGRvbWFpbiBuYW1lcyBmb3IgdGhlIGRpc3RyaWJ1dGlvbi5cbiAgICpcbiAgICogV2hlbiBzZXQsIGBjZXJ0aWZpY2F0ZWAgaXMgcmVxdWlyZWQuXG4gICAqL1xuICByZWFkb25seSBkb21haW5OYW1lcz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBDZXJ0aWZpY2F0ZSBmb3IgYGRvbWFpbk5hbWVzYC4gUmVxdWlyZWQgd2hlbiBgZG9tYWluTmFtZXNgIGlzIHNldC5cbiAgICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAvKipcbiAgICogT3B0aW9uYWwgQ2xvdWRGcm9udCBwcmljZSBjbGFzcy5cbiAgICovXG4gIHJlYWRvbmx5IHByaWNlQ2xhc3M/OiBjbG91ZGZyb250LlByaWNlQ2xhc3M7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIG5hbWluZyBjb250ZXh0IHRoYXQgc2VsZWN0cyB0aGUgU2VjdXJpdHkgSHViLWFsaWduZWQgZGVmYXVsdHMuXG4gICAqXG4gICAqIFVuZGVyIGEgZGVyaXZlZCBjb250ZXh0IGEgZGlzdHJpYnV0aW9uIHRoYXQgc2VydmVzIGBkb21haW5OYW1lc2AgdGhyb3VnaFxuICAgKiBgY2VydGlmaWNhdGVgIHRha2VzIHRoZSBDbG91ZEZyb250LjE1IGBUTFNfVjFfMl8yMDI1YCB2aWV3ZXIgcG9saWN5LiBJdHNcbiAgICogb3JpZ2lucyBhcmUgdGhlIFJFU1QgQVBJIG9ubHksIHNvIGl0IGNhcnJpZXMgbm8gUzMgb3JpZ2luIGFuZCBDbG91ZEZyb250LjFcbiAgICogZG9lcyBub3QgZXZhbHVhdGUgaXQ7IG5vIGRlZmF1bHQgcm9vdCBvYmplY3QgYXBwbGllcy5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dDtcblxuICAvKipcbiAgICogTWluaW11bSBUTFMgcHJvdG9jb2wgdmVyc2lvbiBmb3Igdmlld2VycyBvZiBgZG9tYWluTmFtZXNgLlxuICAgKlxuICAgKiBAZGVmYXVsdCBUTFNfVjFfMl8yMDI1IHVuZGVyIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dCB3aXRoIGEgY2VydGlmaWNhdGUsXG4gICAqIG90aGVyd2lzZSB0aGUgQ2xvdWRGcm9udCBkZWZhdWx0IGZvciB0aGUgY2VydGlmaWNhdGVcbiAgICovXG4gIHJlYWRvbmx5IG1pbmltdW1Qcm90b2NvbFZlcnNpb24/OiBjbG91ZGZyb250LlNlY3VyaXR5UG9saWN5UHJvdG9jb2w7XG59XG5cbi8qKlxuICogQSBmcmFtZXdvcmsgQ2xvdWRGcm9udCBmcm9udCBkb29yIHRoYXQgcmVzdG9yZXMgdGhlIGNhbm9uaWNhbFxuICogYFdXVy1BdXRoZW50aWNhdGVgIGNoYWxsZW5nZSBmb3IgYW4gQVdTIEFQSSBHYXRld2F5IFJFU1QgQVBJIHYxIG9yaWdpbi5cbiAqXG4gKiBBV1MgUkVTVCBBUEkgdjEgcmVtYXBzIHRoZSBvcmlnaW4ncyBgV1dXLUF1dGhlbnRpY2F0ZWAgcmVzcG9uc2UgaGVhZGVyIG9udG9cbiAqIGB4LWFtem4tcmVtYXBwZWQtd3d3LWF1dGhlbnRpY2F0ZWAsIHNvIGEgY2Fub25pY2FsLW9ubHkgYXBwIGxvc2VzIHRoZVxuICogY2hhbGxlbmdlIGF0IHRoZSBlZGdlLiBUaGlzIGNvbnN0cnVjdCBmcm9udHMgdGhlIFJFU1QgdjEgYGV4ZWN1dGUtYXBpYCBvcmlnaW5cbiAqIHdpdGggYSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbiB3aG9zZSBvcmlnaW4tcmVzcG9uc2UgTGFtYmRhQEVkZ2UgZnVuY3Rpb25cbiAqIGNvcGllcyB0aGUgZmlyc3QgcHJlc2VudCBzb3VyY2UgYmFjayBvbnRvIGBXV1ctQXV0aGVudGljYXRlYCBhbmQgcmVtb3ZlcyB0aGVcbiAqIGNvbnN1bWVkIHNvdXJjZSBoZWFkZXJzLlxuICpcbiAqIFRoZSByZXN0b3JlICoqc291cmNlIHNldCoqLCBpbiBwcmlvcml0eSBvcmRlciwgaXM6XG4gKlxuICogMS4gYHgtYW16bi1yZW1hcHBlZC13d3ctYXV0aGVudGljYXRlYCDigJQgdGhlIGFydGlmYWN0IEFXUyBpdHNlbGYgcHJvZHVjZXMgd2hlblxuICogICAgUkVTVCB2MSByZW1hcHMgdGhlIG9yaWdpbiBoZWFkZXIuIEFsd2F5cyBjb25zdWx0ZWQuXG4gKiAyLiB0aGUgYnJpZGdlIGFsaWFzZXMgYHgtdGhlb3J5LXd3dy1hdXRoZW50aWNhdGVgLCB0aGVuXG4gKiAgICBgbWNwLXd3dy1hdXRoZW50aWNhdGVgIOKAlCBjb25zdWx0ZWQgb25seSB3aGVuIHRoZSBvcHRpb25hbCBhbGlhcyBicmlkZ2UgaXNcbiAqICAgIGVuYWJsZWQgKG9mZiBieSBkZWZhdWx0KS5cbiAqXG4gKiAjIyBUaGUgZGlyZWN0LWVuZHBvaW50IGNhdmVhdCAoREQtMilcbiAqXG4gKiBBIENsb3VkRnJvbnQgZnJvbnQgZG9vciBkb2VzICoqbm90KiogYnkgaXRzZWxmIG1ha2UgdGhlIG9yaWdpbiB1bnJlYWNoYWJsZS5cbiAqIFRoZSBSRVNUIEFQSSBrZWVwcyBhbnN3ZXJpbmcgYXQgaXRzIG93blxuICogYDxyZXN0QXBpSWQ+LmV4ZWN1dGUtYXBpLjxyZWdpb24+Ljx1cmxTdWZmaXg+YCBlbmRwb2ludCwgd2hpY2ggaXMgZXhhY3RseSB0aGVcbiAqIG9yaWdpbiB0aGlzIGRpc3RyaWJ1dGlvbiB1c2VzLCBzbyBhIGNsaWVudCB0aGF0IHNraXBzIHRoZSBkaXN0cmlidXRpb24gc3RpbGxcbiAqIHJlYWNoZXMgdGhlIG9yaWdpbiBhbmQgb2JzZXJ2ZXMgYSAqKmNoYWxsZW5nZS1sZXNzIGA0MDFgKiogZm9yIGEgUkVTVCB2MVxuICogY2Fub25pY2FsLW9ubHkgYXBwIOKAlCB0aGUgcmVzdG9yYXRpb24gbmV2ZXIgcnVucywgYW5kIGFueSBlZGdlLW9ubHkgY29udHJvbFxuICogKHRocm90dGxpbmcgYXQgdGhlIGVkZ2UsIGVkZ2Ugb2JzZXJ2YWJpbGl0eSwgdGhlIGFsaWFzIGJyaWRnZSkgaXMgYnlwYXNzZWQgb25cbiAqIHRoYXQgcGF0aC4gQXV0aGVudGljYXRpb24gaXRzZWxmIGlzIHVuYWZmZWN0ZWQ6IHRoZSBydW50aW1lIGJlYXJlciBnYXRlIHN0aWxsXG4gKiByZWZ1c2VzIHRoZSByZXF1ZXN0IGF0IHRoZSBvcmlnaW4sIHNvIHRoaXMgaXMgY2hhbGxlbmdlIGxvc3MgYW5kIGVkZ2UgYnlwYXNzLFxuICogbm90IGFuIGF1dGhlbnRpY2F0aW9uIGJ5cGFzcy5cbiAqXG4gKiBgb3JpZ2luUmVhY2hhYmlsaXR5YCBpcyB0aGVyZWZvcmUgKipyZXF1aXJlZCoqIChERC0yJ3MgbWFuZGF0b3J5XG4gKiBkaXJlY3Qtb3JpZ2luIGRlY2lzaW9uKTpcbiAqXG4gKiAtIGBESVNBQkxFRGAg4oCUIHRoZSBSRVNUIEFQSSdzIGBleGVjdXRlLWFwaWAgZGVmYXVsdCBlbmRwb2ludCBpcyBkaXNhYmxlZC4gVGhlXG4gKiAgIGNhbGxlciBhc3NlcnRzIGl0IChgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludEFzc2VydGVkOiB0cnVlYCkgYmVjYXVzZSB0aGlzXG4gKiAgIGNvbnN0cnVjdCBjYW5ub3QgbXV0YXRlIGFuIGV4dGVybmFsIGBJUmVzdEFwaWAuIFRoZSBjb25zdHJ1Y3QgZG9lcyBub3RcbiAqICAgdmVyaWZ5IHRoZSBhc3NlcnRpb24sIGFuZCB0aGUgZGlzYWJsZWQgaG9zdG5hbWUgaXMgdGhlIGRpc3RyaWJ1dGlvbidzIG93blxuICogICBvcmlnaW4gaG9zdG5hbWUsIHNvIGFuIGFwcCB0aGF0IGRpc2FibGVzIHRoZSBkZWZhdWx0IGVuZHBvaW50IG11c3QgZnJvbnQgdGhlXG4gKiAgIG9yaWdpbiB0aHJvdWdoIGEgY3VzdG9tIGRvbWFpbi5cbiAqIC0gYExPQ0tFRGAg4oCUIHRoZSBvcmlnaW4gaXMgcmVhY2hhYmxlIG9ubHkgdGhyb3VnaCB0aGlzIGRpc3RyaWJ1dGlvbi4gVGhlXG4gKiAgIGNvbnN0cnVjdCBpbmplY3RzIGBvcmlnaW5Mb2NrLnNlY3JldGAgYXMgYSBjdXN0b20gb3JpZ2luIGhlYWRlciBvbiBldmVyeVxuICogICByZXF1ZXN0IHRvIHRoZSBvcmlnaW4sIGFuZCB0aGUgY2FsbGVyIGFzc2VydHNcbiAqICAgKGBvcmlnaW5Mb2NrLmFzc2VydGVkOiB0cnVlYCkgdGhhdCB0aGUgUkVTVCBBUEkgdmVyaWZpZXMgdGhhdCBoZWFkZXI7IHRoZVxuICogICBjb25zdHJ1Y3QgY2Fubm90IGF0dGFjaCB0aGUgdmVyaWZpY2F0aW9uIHRvIGFuIGV4dGVybmFsIGBJUmVzdEFwaWAuXG4gKlxuICogQSBkaXJlY3RseSByZWFjaGFibGUgb3JpZ2luIChgZGlyZWN0YCkgaXMgcmVmdXNlZCBhdCBzeW50aGVzaXMuIFRoZSBkZWNpc2lvblxuICogaXMgcmVjb3JkZWQgaW4gdGhlIGRpc3RyaWJ1dGlvbidzIENsb3VkRm9ybWF0aW9uIG1ldGFkYXRhXG4gKiAoYGFwcHRoZW9yeTpyZXN0LXYxLWNoYWxsZW5nZS1yZXN0b3JhdGlvbmApLCBzbyB0aGUgcG9zdHVyZSBpcyBhdWRpdGFibGUgZnJvbVxuICogdGhlIHN5bnRoZXNpemVkIHRlbXBsYXRlLlxuICpcbiAqIFRoZSBkZXJpdmVkIHJvdXRlIHNldCBhbmQgdGhlIGV4cGxpY2l0IG9yZGVyZWQgY2FjaGUgYmVoYXZpb3JzIGNvbWUgZnJvbSB0aGVcbiAqIHNoYXJlZCByb3V0ZSBhbGdlYnJhIChgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhYCksIHNvIHRoZSBjb25zdHJ1Y3QgaXMgbmV2ZXJcbiAqIGhhbmQtd2lyZWQuIFBhcmFtZXRlcml6ZWQgZGVyaXZlZCByb3V0ZXMgKHRob3NlIGNhcnJ5aW5nIGEgYHtwYXJhbWV0ZXJ9YFxuICogc2VnbWVudCkgY2Fubm90IGJlIGV4cHJlc3NlZCBhcyBDbG91ZEZyb250IHBhdGggcGF0dGVybnMgYW5kIGFyZSB0aGVyZWZvcmVcbiAqIGNvdmVyZWQgYnkgdGhlIGRpc3RyaWJ1dGlvbidzIGRlZmF1bHQgYmVoYXZpb3IuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbiBleHRlbmRzIENvbnN0cnVjdCB7XG4gIC8qKiBUaGUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gZnJvbnRpbmcgdGhlIFJFU1QgdjEgb3JpZ2luLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZGlzdHJpYnV0aW9uOiBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbjtcblxuICAvKipcbiAgICogVGhlIHJlc3BvbnNlIGhlYWRlcnMgdGhlIHJlc3RvcmF0aW9uIGZ1bmN0aW9uIGNvbnN1bHRzLCBpbiBwcmlvcml0eSBvcmRlci5cbiAgICpcbiAgICogYFtcIngtYW16bi1yZW1hcHBlZC13d3ctYXV0aGVudGljYXRlXCJdYCB3aGVuIHRoZSBhbGlhcyBicmlkZ2UgaXMgZGlzYWJsZWQ7XG4gICAqIGBbXCJ4LWFtem4tcmVtYXBwZWQtd3d3LWF1dGhlbnRpY2F0ZVwiLCBcIngtdGhlb3J5LXd3dy1hdXRoZW50aWNhdGVcIixcbiAgICogXCJtY3Atd3d3LWF1dGhlbnRpY2F0ZVwiXWAgd2hlbiBpdCBpcyBlbmFibGVkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHJlc3RvcmVTb3VyY2VIZWFkZXJzOiBzdHJpbmdbXTtcblxuICAvKiogVHJ1ZSB3aGVuIHRoZSBvcHRpb25hbCBhbGlhcyBicmlkZ2UgaXMgZW5hYmxlZC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGFsaWFzQnJpZGdlRW5hYmxlZDogYm9vbGVhbjtcblxuICAvKiogVGhlIHJlY29yZGVkIERELTIgZGlyZWN0LW9yaWdpbiByZWFjaGFiaWxpdHkgZGVjaXNpb24uICovXG4gIHB1YmxpYyByZWFkb25seSBvcmlnaW5SZWFjaGFiaWxpdHk6IEFwcFRoZW9yeVJlc3RWMU9yaWdpblJlYWNoYWJpbGl0eTtcblxuICAvKipcbiAgICogVGhlIG9yaWdpbi1sb2NrIGhlYWRlciBuYW1lIGluamVjdGVkIG9uIGV2ZXJ5IHJlcXVlc3QgdG8gdGhlIG9yaWdpbiwgb3JcbiAgICogYHVuZGVmaW5lZGAgd2hlbiB0aGUgZGVjaXNpb24gaXMgYERJU0FCTEVEYC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBvcmlnaW5Mb2NrSGVhZGVyTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGNvbXBsZXRlIHJvdXRlIHNldCBkZXJpdmVkIGZyb20gdGhlIHNoYXJlZCByb3V0ZSBhbGdlYnJhIChwYXJhbWV0ZXJpemVkXG4gICAqIHJvdXRlcyBpbmNsdWRlZCksIGRlZHVwZWQgYW5kIGluIGRldGVybWluaXN0aWMgc29ydGVkIG9yZGVyLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGRlcml2ZWRSb3V0ZVBhdGhzOiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogVGhlIHN1YnNldCBvZiBgZGVyaXZlZFJvdXRlUGF0aHNgIGVtaXR0ZWQgYXMgZXhwbGljaXQgb3JkZXJlZCBjYWNoZVxuICAgKiBiZWhhdmlvcnMgKHRoZSBsaXRlcmFsIHBhdGhzLCB3aXRoIG5vIGB7cGFyYW1ldGVyfWAgc2VnbWVudCkuXG4gICAqXG4gICAqIENsb3VkRnJvbnQgcGF0aCBwYXR0ZXJucyBjYW5ub3QgZXhwcmVzcyBhIGB7cGFyYW19YCBzZWdtZW50LCBzb1xuICAgKiBwYXJhbWV0ZXJpemVkIGRlcml2ZWQgcm91dGVzIGFyZSBjb3ZlcmVkIGJ5IHRoZSBkZWZhdWx0IGJlaGF2aW9yLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGJlaGF2aW9yUGF0aFBhdHRlcm5zOiBzdHJpbmdbXTtcblxuICBwdWJsaWMgY29uc3RydWN0b3IoXG4gICAgc2NvcGU6IENvbnN0cnVjdCxcbiAgICBpZDogc3RyaW5nLFxuICAgIHByb3BzOiBBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvblByb3BzLFxuICApIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3Qgb3JpZ2luID0gKHByb3BzIGFzIHsgb3JpZ2luPzogYXBpZ3cuSVJlc3RBcGkgfSkub3JpZ2luO1xuICAgIGFzc2VydFJlc3RWMU9yaWdpbihvcmlnaW4pO1xuXG4gICAgY29uc3QgcmVhY2hhYmlsaXR5ID0gcmVzb2x2ZU9yaWdpblJlYWNoYWJpbGl0eShwcm9wcyk7XG4gICAgdGhpcy5vcmlnaW5SZWFjaGFiaWxpdHkgPSByZWFjaGFiaWxpdHkuZGVjaXNpb247XG4gICAgdGhpcy5vcmlnaW5Mb2NrSGVhZGVyTmFtZSA9IHJlYWNoYWJpbGl0eS5sb2NrSGVhZGVyTmFtZTtcblxuICAgIGlmIChcbiAgICAgIHByb3BzLmRvbWFpbk5hbWVzICE9PSB1bmRlZmluZWQgJiZcbiAgICAgIHByb3BzLmRvbWFpbk5hbWVzLmxlbmd0aCA+IDAgJiZcbiAgICAgIHByb3BzLmNlcnRpZmljYXRlID09PSB1bmRlZmluZWRcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbjogZG9tYWluTmFtZXMgcmVxdWlyZXMgY2VydGlmaWNhdGVcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgdGhpcy5hbGlhc0JyaWRnZUVuYWJsZWQgPSBwcm9wcy5hbGlhc0JyaWRnZT8uZW5hYmxlZCA9PT0gdHJ1ZTtcbiAgICB0aGlzLnJlc3RvcmVTb3VyY2VIZWFkZXJzID0gdGhpcy5hbGlhc0JyaWRnZUVuYWJsZWRcbiAgICAgID8gW1JFTUFQX1NPVVJDRV9IRUFERVIsIC4uLkFMSUFTX1NPVVJDRV9IRUFERVJTXVxuICAgICAgOiBbUkVNQVBfU09VUkNFX0hFQURFUl07XG5cbiAgICBjb25zdCBkZXJpdmVkUm91dGVQYXRocyA9IGRlcml2ZVJvdXRlUGF0aHMocHJvcHMucmVzb3VyY2VQYXRocyk7XG4gICAgaWYgKGRlcml2ZWRSb3V0ZVBhdGhzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uOiB0aGUgcm91dGUgbW9kZWwgZGVyaXZlZCBubyByb3V0ZXMgZnJvbSByZXNvdXJjZVBhdGhzXCIsXG4gICAgICApO1xuICAgIH1cbiAgICB0aGlzLmRlcml2ZWRSb3V0ZVBhdGhzID0gZGVyaXZlZFJvdXRlUGF0aHM7XG4gICAgdGhpcy5iZWhhdmlvclBhdGhQYXR0ZXJucyA9IGRlcml2ZWRSb3V0ZVBhdGhzLmZpbHRlcihcbiAgICAgIChwYXRoUGF0dGVybikgPT4gIXBhdGhQYXR0ZXJuLmluY2x1ZGVzKFwie1wiKSAmJiAhcGF0aFBhdHRlcm4uaW5jbHVkZXMoXCJ9XCIpLFxuICAgICk7XG5cbiAgICBjb25zdCByZXN0T3JpZ2luID0gYnVpbGRSZXN0VjFPcmlnaW4odGhpcywgb3JpZ2luLCByZWFjaGFiaWxpdHkpO1xuXG4gICAgY29uc3QgcmVzdG9yYXRpb25GdW5jdGlvbiA9IG5ldyBjbG91ZGZyb250LmV4cGVyaW1lbnRhbC5FZGdlRnVuY3Rpb24oXG4gICAgICB0aGlzLFxuICAgICAgXCJDaGFsbGVuZ2VSZXN0b3JhdGlvbkZ1bmN0aW9uXCIsXG4gICAgICB7XG4gICAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yNF9YLFxuICAgICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUlubGluZShcbiAgICAgICAgICBnZW5lcmF0ZVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uSGFuZGxlckNvZGUodGhpcy5yZXN0b3JlU291cmNlSGVhZGVycyksXG4gICAgICAgICksXG4gICAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAgIFwiUmVzdG9yZSB0aGUgY2Fub25pY2FsIFdXVy1BdXRoZW50aWNhdGUgY2hhbGxlbmdlIGZvciBBcHBUaGVvcnkgUkVTVCB2MSBvcmlnaW4gcmVzcG9uc2VzXCIsXG4gICAgICB9LFxuICAgICk7XG5cbiAgICAvLyBDREsncyBPcmlnaW5SZXF1ZXN0SGVhZGVyQmVoYXZpb3IgaGFzIG5vIGBhbGxWaWV3ZXJFeGNlcHRIb3N0SGVhZGVyYFxuICAgIC8vIGJ1aWxkZXIgYW5kIHJlZnVzZXMgYEF1dGhvcml6YXRpb25gIGluIGFuIGFsbG93IGxpc3QsIHNvIHRoZSBtYW5hZ2VkXG4gICAgLy8gQUxMX1ZJRVdFUl9FWENFUFRfSE9TVF9IRUFERVIgcG9saWN5IGlzIGV4cHJlc3NlZCB0aGUgd2F5IEFXUyBpbXBsZW1lbnRzXG4gICAgLy8gaXQ6IGBhbGxFeGNlcHRgIHdpdGggb25seSBgSG9zdGAgZGVuaWVkLiBFdmVyeSB2aWV3ZXIgaGVhZGVyICh0aGVcbiAgICAvLyBgQXV0aG9yaXphdGlvbmAgaGVhZGVyIGFib3ZlIGFsbCkgaXMgZm9yd2FyZGVkLCBhbmQgQ2xvdWRGcm9udCBzdGlsbFxuICAgIC8vIHByZXNlbnRzIHRoZSBleGVjdXRlLWFwaSBvcmlnaW4gaG9zdC5cbiAgICAvL1xuICAgIC8vIFVuZGVyIExPQ0tFRCB0aGUgb3JpZ2luLWxvY2sgaGVhZGVyIGlzIGRlbmllZCB0byB0aGUgdmlld2VyIGFzIHdlbGwsIHNvIGFcbiAgICAvLyB2aWV3ZXItc3VwcGxpZWQgY29weSBvZiB0aGUgbG9jayBoZWFkZXIgaXMgc3RyaXBwZWQgYXQgdGhlIGVkZ2UgYW5kIHRoZVxuICAgIC8vIENsb3VkRnJvbnQtaW5qZWN0ZWQgb3JpZ2luIGN1c3RvbSBoZWFkZXIgaXMgdGhlIG9ubHkgY29weSB0aGF0IHJlYWNoZXMgdGhlXG4gICAgLy8gb3JpZ2luIHRocm91Z2ggdGhpcyBkaXN0cmlidXRpb24uXG4gICAgLy9cbiAgICAvLyBBbGwgY29va2llcyBhbmQgYWxsIHF1ZXJ5IHN0cmluZ3MgYXJlIGZvcndhcmRlZCBhcyB3ZWxsLCBleGFjdGx5IGFzIHRoZVxuICAgIC8vIG1hbmFnZWQgcG9saWN5IGRvZXM6IHRoZSBkZXJpdmVkIE9BdXRoIHJvdXRlcyBjYXJyeSB0aGVpciBwYXJhbWV0ZXJzIGluXG4gICAgLy8gdGhlIHF1ZXJ5IHN0cmluZyAodGhlIHBlci1raW5kIGAuLi4vYXV0aG9yaXplYCByb3V0ZSBhbmQgdGhlIGNhbGxiYWNrJ3NcbiAgICAvLyBgP2NvZGU9Li4uJnN0YXRlPS4uLmApLCBzbyBkcm9wcGluZyB0aGUgcXVlcnkgc3RyaW5nIHdvdWxkIGJyZWFrIHRoZVxuICAgIC8vIGZyb250IGNoYW5uZWwsIGFuZCBhIGNvb2tpZS1jYXJyaWVkIHNlc3Npb24gbXVzdCByZWFjaCB0aGUgb3JpZ2luXG4gICAgLy8gdW5jaGFuZ2VkLlxuICAgIGNvbnN0IGRlbmllZFZpZXdlckhlYWRlcnMgPSBbXG4gICAgICBcIkhvc3RcIixcbiAgICAgIC4uLih0aGlzLm9yaWdpbkxvY2tIZWFkZXJOYW1lICE9PSB1bmRlZmluZWQgPyBbdGhpcy5vcmlnaW5Mb2NrSGVhZGVyTmFtZV0gOiBbXSksXG4gICAgXTtcbiAgICBjb25zdCBvcmlnaW5SZXF1ZXN0UG9saWN5ID0gbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeShcbiAgICAgIHRoaXMsXG4gICAgICBcIk9yaWdpblJlcXVlc3RQb2xpY3lcIixcbiAgICAgIHtcbiAgICAgICAgY29tbWVudDpcbiAgICAgICAgICBcIkFwcFRoZW9yeSBSRVNUIHYxIGNoYWxsZW5nZSByZXN0b3JhdGlvbjogZm9yd2FyZCBhbGwgdmlld2VyIGhlYWRlcnMgZXhjZXB0IEhvc3QgYW5kIGFueSBvcmlnaW4tbG9jayBoZWFkZXIsIGFsbCBjb29raWVzIGFuZCBhbGwgcXVlcnkgc3RyaW5nc1wiLFxuICAgICAgICBoZWFkZXJCZWhhdmlvcjpcbiAgICAgICAgICBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5kZW55TGlzdCguLi5kZW5pZWRWaWV3ZXJIZWFkZXJzKSxcbiAgICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdENvb2tpZUJlaGF2aW9yLmFsbCgpLFxuICAgICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RRdWVyeVN0cmluZ0JlaGF2aW9yLmFsbCgpLFxuICAgICAgfSxcbiAgICApO1xuXG4gICAgY29uc3QgZWRnZUxhbWJkYXM6IGNsb3VkZnJvbnQuRWRnZUxhbWJkYVtdID0gW1xuICAgICAge1xuICAgICAgICBldmVudFR5cGU6IGNsb3VkZnJvbnQuTGFtYmRhRWRnZUV2ZW50VHlwZS5PUklHSU5fUkVTUE9OU0UsXG4gICAgICAgIGZ1bmN0aW9uVmVyc2lvbjogcmVzdG9yYXRpb25GdW5jdGlvbi5jdXJyZW50VmVyc2lvbixcbiAgICAgIH0sXG4gICAgXTtcbiAgICBjb25zdCBiZWhhdmlvck9wdGlvbnMgPSAoKTogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPT4gKHtcbiAgICAgIG9yaWdpbjogcmVzdE9yaWdpbixcbiAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTCxcbiAgICAgIGNhY2hlUG9saWN5OiBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRUQsXG4gICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICBlZGdlTGFtYmRhcyxcbiAgICB9KTtcblxuICAgIGNvbnN0IGFkZGl0aW9uYWxCZWhhdmlvcnM6IFJlY29yZDxzdHJpbmcsIGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zPiA9IHt9O1xuICAgIGZvciAoY29uc3QgcGF0aFBhdHRlcm4gb2YgdGhpcy5iZWhhdmlvclBhdGhQYXR0ZXJucykge1xuICAgICAgYWRkaXRpb25hbEJlaGF2aW9yc1twYXRoUGF0dGVybl0gPSBiZWhhdmlvck9wdGlvbnMoKTtcbiAgICB9XG5cbiAgICBjb25zdCBmcm9udGVkRG9tYWlucyA9XG4gICAgICBwcm9wcy5kb21haW5OYW1lcyAhPT0gdW5kZWZpbmVkICYmIHByb3BzLmRvbWFpbk5hbWVzLmxlbmd0aCA+IDAgJiYgcHJvcHMuY2VydGlmaWNhdGUgIT09IHVuZGVmaW5lZDtcbiAgICBjb25zdCBtaW5pbXVtUHJvdG9jb2xWZXJzaW9uID0gZGVmYXVsdE1pbmltdW1Qcm90b2NvbFZlcnNpb24oXG4gICAgICBwcm9wcy5uYW1pbmdDb250ZXh0LFxuICAgICAgZnJvbnRlZERvbWFpbnMsXG4gICAgICBwcm9wcy5taW5pbXVtUHJvdG9jb2xWZXJzaW9uLFxuICAgICk7XG5cbiAgICB0aGlzLmRpc3RyaWJ1dGlvbiA9IG5ldyBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbih0aGlzLCBcIkRpc3RyaWJ1dGlvblwiLCB7XG4gICAgICBkZWZhdWx0QmVoYXZpb3I6IGJlaGF2aW9yT3B0aW9ucygpLFxuICAgICAgYWRkaXRpb25hbEJlaGF2aW9ycyxcbiAgICAgIC4uLihmcm9udGVkRG9tYWlucyA/IHsgZG9tYWluTmFtZXM6IHByb3BzLmRvbWFpbk5hbWVzLCBjZXJ0aWZpY2F0ZTogcHJvcHMuY2VydGlmaWNhdGUgfSA6IHt9KSxcbiAgICAgIC4uLihtaW5pbXVtUHJvdG9jb2xWZXJzaW9uICE9PSB1bmRlZmluZWQgPyB7IG1pbmltdW1Qcm90b2NvbFZlcnNpb24gfSA6IHt9KSxcbiAgICAgIC4uLihwcm9wcy5wcmljZUNsYXNzICE9PSB1bmRlZmluZWQgPyB7IHByaWNlQ2xhc3M6IHByb3BzLnByaWNlQ2xhc3MgfSA6IHt9KSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGNmbkRpc3RyaWJ1dGlvbiA9IHRoaXMuZGlzdHJpYnV0aW9uLm5vZGVcbiAgICAgIC5kZWZhdWx0Q2hpbGQgYXMgY2xvdWRmcm9udC5DZm5EaXN0cmlidXRpb247XG4gICAgY2ZuRGlzdHJpYnV0aW9uLmFkZE1ldGFkYXRhKENIQUxMRU5HRV9SRVNUT1JBVElPTl9NRVRBREFUQV9LRVksIHtcbiAgICAgIGNvbnRyYWN0SWQ6IENIQUxMRU5HRV9SRVNUT1JBVElPTl9DT05UUkFDVF9JRCxcbiAgICAgIGFsaWFzQnJpZGdlOiB0aGlzLmFsaWFzQnJpZGdlRW5hYmxlZCxcbiAgICAgIHNvdXJjZUhlYWRlcnM6IHRoaXMucmVzdG9yZVNvdXJjZUhlYWRlcnMsXG4gICAgICByb3V0ZUNvdW50OiB0aGlzLmRlcml2ZWRSb3V0ZVBhdGhzLmxlbmd0aCxcbiAgICAgIG9yaWdpblJlYWNoYWJpbGl0eTogdGhpcy5vcmlnaW5SZWFjaGFiaWxpdHksXG4gICAgICAuLi4odGhpcy5vcmlnaW5Mb2NrSGVhZGVyTmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgICAgID8geyBvcmlnaW5Mb2NrSGVhZGVyOiB0aGlzLm9yaWdpbkxvY2tIZWFkZXJOYW1lIH1cbiAgICAgICAgOiB7IGRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnRBc3NlcnRlZDogdHJ1ZSB9KSxcbiAgICB9KTtcbiAgfVxufVxuXG4vKiogVGhlIHJlc29sdmVkIERELTIgZGVjaXNpb24sIHdpdGggdGhlIG9yaWdpbi1sb2NrIG1hdGVyaWFsIHdoZW4gTE9DS0VELiAqL1xuaW50ZXJmYWNlIE9yaWdpblJlYWNoYWJpbGl0eURlY2lzaW9uIHtcbiAgcmVhZG9ubHkgZGVjaXNpb246IEFwcFRoZW9yeVJlc3RWMU9yaWdpblJlYWNoYWJpbGl0eTtcbiAgcmVhZG9ubHkgbG9ja0hlYWRlck5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGxvY2tTZWNyZXQ/OiBzdHJpbmc7XG59XG5cbi8qKiBSZW5kZXJzIGEgcmVqZWN0ZWQgZGVjaXNpb24gZm9yIGFuIGVycm9yIG1lc3NhZ2Ugd2l0aG91dCBhc3N1bWluZyBpdHMgdHlwZS4gKi9cbmZ1bmN0aW9uIGRlc2NyaWJlRGVjaXNpb24oZGVjaXNpb246IHVua25vd24pOiBzdHJpbmcge1xuICByZXR1cm4gdHlwZW9mIGRlY2lzaW9uID09PSBcInN0cmluZ1wiID8gSlNPTi5zdHJpbmdpZnkoZGVjaXNpb24pIDogU3RyaW5nKGRlY2lzaW9uKTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlcyBhbmQgdmFsaWRhdGVzIHRoZSBtYW5kYXRvcnkgREQtMiBkaXJlY3Qtb3JpZ2luIHJlYWNoYWJpbGl0eSBkZWNpc2lvbi5cbiAqXG4gKiBGYWlscyBjbG9zZWQgYXQgc3ludGhlc2lzIG9uIGEgbWlzc2luZyBvciBgZGlyZWN0YCBkZWNpc2lvbiwgb24gYSBgRElTQUJMRURgXG4gKiBkZWNpc2lvbiB3aXRob3V0IHRoZSBjYWxsZXIncyBkaXNhYmxlbWVudCBhc3NlcnRpb24sIG9uIGEgYExPQ0tFRGAgZGVjaXNpb25cbiAqIHdpdGhvdXQgYSBjb21wbGV0ZSBvcmlnaW4gbG9jaywgYW5kIG9uIGNvbnRyYWRpY3RvcnkgcHJvcHMuXG4gKi9cbmZ1bmN0aW9uIHJlc29sdmVPcmlnaW5SZWFjaGFiaWxpdHkoXG4gIHByb3BzOiBBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvblByb3BzLFxuKTogT3JpZ2luUmVhY2hhYmlsaXR5RGVjaXNpb24ge1xuICBjb25zdCBkZWNpc2lvbiA9IHByb3BzLm9yaWdpblJlYWNoYWJpbGl0eTtcbiAgaWYgKFxuICAgIGRlY2lzaW9uICE9PSBBcHBUaGVvcnlSZXN0VjFPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRUQgJiZcbiAgICBkZWNpc2lvbiAhPT0gQXBwVGhlb3J5UmVzdFYxT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uOiBvcmlnaW5SZWFjaGFiaWxpdHkgaXMgcmVxdWlyZWQgYW5kIG11c3QgYmUgXCIgK1xuICAgICAgICBcIkFwcFRoZW9yeVJlc3RWMU9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRCBvciAuTE9DS0VEIChERC0yKTsgYSBkaXJlY3RseSByZWFjaGFibGUgXCIgK1xuICAgICAgICBgb3JpZ2luICgnZGlyZWN0JykgaXMgbm90IGFsbG93ZWQgKHJlY2VpdmVkICR7ZGVzY3JpYmVEZWNpc2lvbihkZWNpc2lvbil9KS4gYCArXG4gICAgICAgIFwiVGhlIFJFU1QgQVBJJ3MgZXhlY3V0ZS1hcGkgZW5kcG9pbnQgaXMgdGhlIG9yaWdpbiB0aGlzIGRpc3RyaWJ1dGlvbiB1c2VzLCBzbyBhIGNsaWVudCB0aGF0IFwiICtcbiAgICAgICAgXCJieXBhc3NlcyB0aGUgZGlzdHJpYnV0aW9uIHN0aWxsIHJlYWNoZXMgaXQgYW5kIG9ic2VydmVzIGEgY2hhbGxlbmdlLWxlc3MgNDAxOiByZWNvcmQgaG93IHRoYXQgXCIgK1xuICAgICAgICBcImVuZHBvaW50IGlzIG1hZGUgdW5yZWFjaGFibGUgKERJU0FCTEVEKSBvciByZWFjaGVkIG9ubHkgdGhyb3VnaCB0aGlzIGRpc3RyaWJ1dGlvbiAoTE9DS0VEKVwiLFxuICAgICk7XG4gIH1cblxuICBpZiAoZGVjaXNpb24gPT09IEFwcFRoZW9yeVJlc3RWMU9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRCkge1xuICAgIGlmIChwcm9wcy5vcmlnaW5Mb2NrICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbjogb3JpZ2luTG9jayBpcyBvbmx5IHZhbGlkIHdpdGggb3JpZ2luUmVhY2hhYmlsaXR5IFwiICtcbiAgICAgICAgICBcIkFwcFRoZW9yeVJlc3RWMU9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRURcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChwcm9wcy5kaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50QXNzZXJ0ZWQgIT09IHRydWUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbjogb3JpZ2luUmVhY2hhYmlsaXR5IERJU0FCTEVEIHJlcXVpcmVzIFwiICtcbiAgICAgICAgICBcImRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnRBc3NlcnRlZDogdHJ1ZTsgdGhpcyBjb25zdHJ1Y3QgZnJvbnRzIGFuIGV4dGVybmFsIElSZXN0QXBpIGl0IFwiICtcbiAgICAgICAgICBcImNhbm5vdCBtdXRhdGUsIHNvIHRoZSBjYWxsZXIgbXVzdCBhc3NlcnQgdGhhdCB0aGUgUkVTVCBBUEkncyBkaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50IGlzIHNldFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgZGVjaXNpb24gfTtcbiAgfVxuXG4gIGlmIChwcm9wcy5kaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50QXNzZXJ0ZWQgIT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb246IGRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnRBc3NlcnRlZCBpcyBvbmx5IHZhbGlkIHdpdGggXCIgK1xuICAgICAgICBcIm9yaWdpblJlYWNoYWJpbGl0eSBBcHBUaGVvcnlSZXN0VjFPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRURcIixcbiAgICApO1xuICB9XG5cbiAgY29uc3QgbG9jayA9IHByb3BzLm9yaWdpbkxvY2s7XG4gIGlmIChsb2NrID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIHJlcXVpcmVzIG9yaWdpbkxvY2sgXCIgK1xuICAgICAgICBcIih7IHNlY3JldCwgYXNzZXJ0ZWQ6IHRydWUgfSkgY2FycnlpbmcgdGhlIG9yaWdpbi1sb2NrIG1hdGVyaWFsIGFuZCB0aGUgY2FsbGVyJ3MgYXNzZXJ0aW9uIHRoYXQgXCIgK1xuICAgICAgICBcInRoZSBSRVNUIEFQSSB2ZXJpZmllcyBpdFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGxvY2suYXNzZXJ0ZWQgIT09IHRydWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uOiBvcmlnaW5SZWFjaGFiaWxpdHkgTE9DS0VEIHJlcXVpcmVzIG9yaWdpbkxvY2suYXNzZXJ0ZWQ6IHRydWUgXCIgK1xuICAgICAgICBcIih0aGUgY2FsbGVyIGFzc2VydHMgdGhlIFJFU1QgQVBJIHZlcmlmaWVzIHRoZSBvcmlnaW4tbG9jayBoZWFkZXIgdGhpcyBkaXN0cmlidXRpb24gaW5qZWN0cyk7IFwiICtcbiAgICAgICAgXCJ0aGlzIGNvbnN0cnVjdCBjYW5ub3QgYXR0YWNoIHRoZSB2ZXJpZmljYXRpb24gdG8gYW4gZXh0ZXJuYWwgSVJlc3RBcGlcIixcbiAgICApO1xuICB9XG4gIGlmICh0eXBlb2YgbG9jay5zZWNyZXQgIT09IFwic3RyaW5nXCIgfHwgIU9SSUdJTl9MT0NLX1NFQ1JFVF9QQVRURVJOLnRlc3QobG9jay5zZWNyZXQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbjogb3JpZ2luTG9jay5zZWNyZXQgbXVzdCBiZSAzMi4uMTI4IGNoYXJhY3RlcnMgb2YgXCIgK1xuICAgICAgICBcIltBLVphLXowLTkuX34tXSAoYSBsaXRlcmFsIENsb3VkRnJvbnQgb3JpZ2luIGN1c3RvbSBoZWFkZXIgdmFsdWU6IG5vIHdoaXRlc3BhY2UsIG5vIGNvbnRyb2wgXCIgK1xuICAgICAgICBcImNoYXJhY3RlcnMsIG5vIHRlbXBsYXRlIGludHJpbnNpY3MpXCIsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGhlYWRlck5hbWUgPSBsb2NrLmhlYWRlck5hbWUgPz8gREVGQVVMVF9PUklHSU5fTE9DS19IRUFERVI7XG4gIGlmICghT1JJR0lOX0xPQ0tfSEVBREVSX05BTUVfUEFUVEVSTi50ZXN0KGhlYWRlck5hbWUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbjogb3JpZ2luTG9jay5oZWFkZXJOYW1lIG11c3QgYmUgMS4uNjQgY2hhcmFjdGVycyBvZiBbQS1aYS16MC05LV1cIixcbiAgICApO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWRIZWFkZXJOYW1lID0gaGVhZGVyTmFtZS50b0xvd2VyQ2FzZSgpO1xuICBpZiAoXG4gICAgUkVTRVJWRURfT1JJR0lOX0xPQ0tfSEVBREVSUy5oYXMobm9ybWFsaXplZEhlYWRlck5hbWUpIHx8XG4gICAgbm9ybWFsaXplZEhlYWRlck5hbWUuc3RhcnRzV2l0aChcIngtYW16LVwiKSB8fFxuICAgIG5vcm1hbGl6ZWRIZWFkZXJOYW1lLnN0YXJ0c1dpdGgoXCJ4LWFtem4tXCIpIHx8XG4gICAgbm9ybWFsaXplZEhlYWRlck5hbWUuc3RhcnRzV2l0aChcImNsb3VkZnJvbnQtXCIpXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbjogb3JpZ2luTG9jay5oZWFkZXJOYW1lIFwiJHtoZWFkZXJOYW1lfVwiIGlzIHJlc2VydmVkIGJ5IENsb3VkRnJvbnQgb3IgdGhlIG9yaWdpbiByZXF1ZXN0IGNvbnRyYWN0IGFuZCBjYW5ub3QgY2FycnkgdGhlIG9yaWdpbiBsb2NrYCxcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIHsgZGVjaXNpb24sIGxvY2tIZWFkZXJOYW1lOiBoZWFkZXJOYW1lLCBsb2NrU2VjcmV0OiBsb2NrLnNlY3JldCB9O1xufVxuXG4vKiogRmFpbHMgY2xvc2VkIHVubGVzcyB0aGUgb3JpZ2luIGlzIGFuIEFXUyBBUEkgR2F0ZXdheSBSRVNUIEFQSSB2MS4gKi9cbmZ1bmN0aW9uIGFzc2VydFJlc3RWMU9yaWdpbihcbiAgb3JpZ2luOiBhcGlndy5JUmVzdEFwaSB8IHVuZGVmaW5lZCxcbik6IGFzc2VydHMgb3JpZ2luIGlzIGFwaWd3LklSZXN0QXBpIHtcbiAgaWYgKFxuICAgIG9yaWdpbiA9PT0gdW5kZWZpbmVkIHx8XG4gICAgdHlwZW9mIG9yaWdpbi5yZXN0QXBpSWQgIT09IFwic3RyaW5nXCIgfHxcbiAgICBvcmlnaW4ucmVzdEFwaUlkLmxlbmd0aCA9PT0gMCB8fFxuICAgIHR5cGVvZiBvcmlnaW4ucmVzdEFwaVJvb3RSZXNvdXJjZUlkICE9PSBcInN0cmluZ1wiIHx8XG4gICAgb3JpZ2luLnJlc3RBcGlSb290UmVzb3VyY2VJZC5sZW5ndGggPT09IDBcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKE5PTl9SRVNUX1YxX09SSUdJTl9NRVNTQUdFKTtcbiAgfVxufVxuXG4vKipcbiAqIEJ1aWxkcyB0aGUgSFRUUFMtb25seSBgZXhlY3V0ZS1hcGlgIG9yaWdpbiBmb3IgYW4gQVdTIEFQSSBHYXRld2F5IFJFU1QgQVBJIHYxLFxuICogY2FycnlpbmcgdGhlIG9yaWdpbi1sb2NrIGhlYWRlciB3aGVuIHRoZSBkZWNpc2lvbiBpcyBgTE9DS0VEYC5cbiAqXG4gKiBgY2xvdWRmcm9udC1vcmlnaW5zYCcgYFJlc3RBcGlPcmlnaW5gIGFjY2VwdHMgYSBgUmVzdEFwaUJhc2VgIChpdCByZWFkcyB0aGVcbiAqIGNvbmNyZXRlIGB1cmxgIHRva2VuKSwgbm90IHRoZSBgSVJlc3RBcGlgIHRoaXMgY29uc3RydWN0IHRha2VzLCBhbmQgYElSZXN0QXBpYFxuICogZXhwb3NlcyBuZWl0aGVyIGB1cmxgIG5vciBgdXJsRm9yUGF0aGAuIFRoZSBleGVjdXRlLWFwaSBvcmlnaW4gaXMgdGhlcmVmb3JlXG4gKiBidWlsdCBmcm9tIGByZXN0QXBpSWRgLCB0aGUgc3RhY2sgcmVnaW9uIGFuZCBVUkwgc3VmZml4LCBhbmQgdGhlIGRlcGxveW1lbnRcbiAqIHN0YWdlJ3Mgb3JpZ2luIHBhdGguXG4gKi9cbmZ1bmN0aW9uIGJ1aWxkUmVzdFYxT3JpZ2luKFxuICBzY29wZTogQ29uc3RydWN0LFxuICBvcmlnaW46IGFwaWd3LklSZXN0QXBpLFxuICByZWFjaGFiaWxpdHk6IE9yaWdpblJlYWNoYWJpbGl0eURlY2lzaW9uLFxuKTogb3JpZ2lucy5IdHRwT3JpZ2luIHtcbiAgY29uc3Qgc3RhY2sgPSBTdGFjay5vZihzY29wZSk7XG4gIGNvbnN0IG9yaWdpbkRvbWFpbk5hbWUgPSBgJHtvcmlnaW4ucmVzdEFwaUlkfS5leGVjdXRlLWFwaS4ke3N0YWNrLnJlZ2lvbn0uJHtzdGFjay51cmxTdWZmaXh9YDtcbiAgY29uc3Qgc3RhZ2VOYW1lID0gb3JpZ2luLmRlcGxveW1lbnRTdGFnZT8uc3RhZ2VOYW1lO1xuICByZXR1cm4gbmV3IG9yaWdpbnMuSHR0cE9yaWdpbihvcmlnaW5Eb21haW5OYW1lLCB7XG4gICAgcHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuT3JpZ2luUHJvdG9jb2xQb2xpY3kuSFRUUFNfT05MWSxcbiAgICAuLi4oc3RhZ2VOYW1lID8geyBvcmlnaW5QYXRoOiBgLyR7c3RhZ2VOYW1lfWAgfSA6IHt9KSxcbiAgICAuLi4ocmVhY2hhYmlsaXR5LmxvY2tIZWFkZXJOYW1lICE9PSB1bmRlZmluZWQgJiYgcmVhY2hhYmlsaXR5LmxvY2tTZWNyZXQgIT09IHVuZGVmaW5lZFxuICAgICAgPyB7IGN1c3RvbUhlYWRlcnM6IHsgW3JlYWNoYWJpbGl0eS5sb2NrSGVhZGVyTmFtZV06IHJlYWNoYWJpbGl0eS5sb2NrU2VjcmV0IH0gfVxuICAgICAgOiB7fSksXG4gIH0pO1xufVxuXG4vKipcbiAqIERlcml2ZXMgdGhlIGNvbXBsZXRlIGRlZHVwZWQsIHNvcnRlZCByb3V0ZSBzZXQgZm9yIHRoZSBlZmZlY3RpdmUgcmVzb3VyY2VcbiAqIHBhdGhzIHVzaW5nIG9ubHkgdGhlIHNoYXJlZCByb3V0ZSBhbGdlYnJhIChuZXZlciBoYW5kLXdpcmVkKS5cbiAqL1xuZnVuY3Rpb24gZGVyaXZlUm91dGVQYXRocyhjb25maWd1cmVkUmVzb3VyY2VQYXRocz86IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBjb25zdCBlZmZlY3RpdmVSZXNvdXJjZVBhdGhzID1cbiAgICBjb25maWd1cmVkUmVzb3VyY2VQYXRocyAhPT0gdW5kZWZpbmVkICYmIGNvbmZpZ3VyZWRSZXNvdXJjZVBhdGhzLmxlbmd0aCA+IDBcbiAgICAgID8gY29uZmlndXJlZFJlc291cmNlUGF0aHNcbiAgICAgIDogQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnN1cHBvcnRlZEVuZHBvaW50VGVtcGxhdGVzKCkubWFwKFxuICAgICAgICAgICh0ZW1wbGF0ZSkgPT4gdGVtcGxhdGUubWNwUGF0dGVybixcbiAgICAgICAgKTtcblxuICBjb25zdCBkZXJpdmF0aW9uczogQXJyYXk8KHJlc291cmNlUGF0aDogc3RyaW5nKSA9PiBzdHJpbmc+ID0gW1xuICAgIChyZXNvdXJjZVBhdGgpID0+IHJlc291cmNlUGF0aCxcbiAgICAocmVzb3VyY2VQYXRoKSA9PlxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnByb3RlY3RlZFJlc291cmNlUGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGgpLFxuICAgIChyZXNvdXJjZVBhdGgpID0+XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclBhdGhGb3JSZXNvdXJjZVBhdGgocmVzb3VyY2VQYXRoKSxcbiAgICAocmVzb3VyY2VQYXRoKSA9PlxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25BdXRob3JpemVQYXRoRm9yUmVzb3VyY2VQYXRoKHJlc291cmNlUGF0aCksXG4gICAgKHJlc291cmNlUGF0aCkgPT5cbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uVG9rZW5QYXRoRm9yUmVzb3VyY2VQYXRoKHJlc291cmNlUGF0aCksXG4gICAgKHJlc291cmNlUGF0aCkgPT5cbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uUmVnaXN0ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKHJlc291cmNlUGF0aCksXG4gICAgKHJlc291cmNlUGF0aCkgPT5cbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyU3VmZml4UGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGgpLFxuICBdO1xuXG4gIGNvbnN0IGRlcml2ZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCByZXNvdXJjZVBhdGggb2YgZWZmZWN0aXZlUmVzb3VyY2VQYXRocykge1xuICAgIGZvciAoY29uc3QgZGVyaXZlIG9mIGRlcml2YXRpb25zKSB7XG4gICAgICB0cnkge1xuICAgICAgICBkZXJpdmVkLmFkZChkZXJpdmUocmVzb3VyY2VQYXRoKSk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYEFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uOiByZXNvdXJjZVBhdGhzIGVudHJ5IFwiJHtyZXNvdXJjZVBhdGh9XCIgaXMgbm90IGEgcm91dGUgdGhlIHJvdXRlIG1vZGVsIGNhbiBkZXJpdmU6ICR7ZXJyb3JNZXNzYWdlKGVycm9yKX1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIFRoZSB1cHN0cmVhbSBPQXV0aCBjYWxsYmFjayBpcyBzdGFnZS1nbG9iYWwsIHNvIGl0IGlzIGRlcml2ZWQgZXhhY3RseSBvbmNlXG4gIC8vIHJhdGhlciB0aGFuIHBlciByZXNvdXJjZSBwYXRoLiBUaGUgY29udHJhY3QgZGVmYXVsdCBpcyBhbHdheXMgZGVyaXZhYmxlLlxuICBkZXJpdmVkLmFkZChcbiAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuY2FsbGJhY2tQYXRoRm9yQ29uZmlndXJlZFBhdGgoXG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuREVGQVVMVF9DQUxMQkFDS19QQVRILFxuICAgICksXG4gICk7XG5cbiAgcmV0dXJuIEFycmF5LmZyb20oZGVyaXZlZCkuc29ydCgpO1xufVxuXG4vKiogUmV0dXJucyBhIHRocm93biB2YWx1ZSdzIG1lc3NhZ2Ugd2l0aG91dCBhc3N1bWluZyBpdCBpcyBhbiBFcnJvci4gKi9cbmZ1bmN0aW9uIGVycm9yTWVzc2FnZShlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG59XG4iXX0=