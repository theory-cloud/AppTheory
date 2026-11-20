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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryRestV1ChallengeRestoration", version: "7.4.0" };
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
            runtime: lambda.Runtime.NODEJS_22_X,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC12MS1jaGFsbGVuZ2UtcmVzdG9yYXRpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyZXN0LXYxLWNoYWxsZW5nZS1yZXN0b3JhdGlvbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQW9DO0FBR3BDLHVFQUF5RDtBQUN6RCw0RUFBOEQ7QUFDOUQsK0RBQWlEO0FBQ2pELDJDQUF1QztBQUV2QywyREFBK0Q7QUFDL0QsMkdBQWdIO0FBQ2hILCtEQUEwRTtBQUcxRSx3RkFBd0Y7QUFDeEYsTUFBTSxrQ0FBa0MsR0FBRyx5Q0FBeUMsQ0FBQztBQUVyRixnRUFBZ0U7QUFDaEUsTUFBTSxpQ0FBaUMsR0FBRyxzQ0FBc0MsQ0FBQztBQUVqRjs7Ozs7O0dBTUc7QUFDSCxNQUFNLG1CQUFtQixHQUFHLGtDQUFrQyxDQUFDO0FBRS9EOzs7R0FHRztBQUNILE1BQU0sb0JBQW9CLEdBQUcsQ0FBQywyQkFBMkIsRUFBRSxzQkFBc0IsQ0FBQyxDQUFDO0FBRW5GOzs7OztHQUtHO0FBQ0gsTUFBTSwwQkFBMEIsR0FDOUIsd0ZBQXdGO0lBQ3hGLHVFQUF1RSxDQUFDO0FBRTFFLDJGQUEyRjtBQUMzRixNQUFNLDBCQUEwQixHQUFHLHlCQUF5QixDQUFDO0FBRTdEOzs7Ozs7O0dBT0c7QUFDSCxNQUFNLDBCQUEwQixHQUFHLDJCQUEyQixDQUFDO0FBRS9ELDRDQUE0QztBQUM1QyxNQUFNLCtCQUErQixHQUFHLHNCQUFzQixDQUFDO0FBRS9EOzs7R0FHRztBQUNILE1BQU0sNEJBQTRCLEdBQUcsSUFBSSxHQUFHLENBQUM7SUFDM0MsZUFBZTtJQUNmLFlBQVk7SUFDWixnQkFBZ0I7SUFDaEIsUUFBUTtJQUNSLE1BQU07SUFDTixtQkFBbUI7SUFDbkIsa0JBQWtCO0lBQ2xCLGlCQUFpQjtDQUNsQixDQUFDLENBQUM7QUFFSDs7Ozs7Ozs7R0FRRztBQUNILElBQVksaUNBMkJYO0FBM0JELFdBQVksaUNBQWlDO0lBQzNDOzs7Ozs7Ozs7Ozs7Ozs7T0FlRztJQUNILDBEQUFxQixDQUFBO0lBQ3JCOzs7Ozs7O09BT0c7SUFDSCxzREFBaUIsQ0FBQTtBQUNuQixDQUFDLEVBM0JXLGlDQUFpQyxpREFBakMsaUNBQWlDLFFBMkI1QztBQThKRDs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBeURHO0FBQ0gsTUFBYSxtQ0FBb0MsU0FBUSxzQkFBUzs7SUFDaEUsK0RBQStEO0lBQy9DLFlBQVksQ0FBMEI7SUFFdEQ7Ozs7OztPQU1HO0lBQ2Esb0JBQW9CLENBQVc7SUFFL0Msc0RBQXNEO0lBQ3RDLGtCQUFrQixDQUFVO0lBRTVDLDZEQUE2RDtJQUM3QyxrQkFBa0IsQ0FBb0M7SUFFdEU7OztPQUdHO0lBQ2Esb0JBQW9CLENBQVU7SUFFOUM7OztPQUdHO0lBQ2EsaUJBQWlCLENBQVc7SUFFNUM7Ozs7OztPQU1HO0lBQ2Esb0JBQW9CLENBQVc7SUFFL0MsWUFDRSxLQUFnQixFQUNoQixFQUFVLEVBQ1YsS0FBK0M7UUFFL0MsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLE1BQU0sR0FBSSxLQUFxQyxDQUFDLE1BQU0sQ0FBQztRQUM3RCxrQkFBa0IsQ0FBQyxNQUFNLENBQUMsQ0FBQztRQUUzQixNQUFNLFlBQVksR0FBRyx5QkFBeUIsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN0RCxJQUFJLENBQUMsa0JBQWtCLEdBQUcsWUFBWSxDQUFDLFFBQVEsQ0FBQztRQUNoRCxJQUFJLENBQUMsb0JBQW9CLEdBQUcsWUFBWSxDQUFDLGNBQWMsQ0FBQztRQUV4RCxJQUNFLEtBQUssQ0FBQyxXQUFXLEtBQUssU0FBUztZQUMvQixLQUFLLENBQUMsV0FBVyxDQUFDLE1BQU0sR0FBRyxDQUFDO1lBQzVCLEtBQUssQ0FBQyxXQUFXLEtBQUssU0FBUyxFQUMvQixDQUFDO1lBQ0QsTUFBTSxJQUFJLEtBQUssQ0FDYix1RUFBdUUsQ0FDeEUsQ0FBQztRQUNKLENBQUM7UUFFRCxJQUFJLENBQUMsa0JBQWtCLEdBQUcsS0FBSyxDQUFDLFdBQVcsRUFBRSxPQUFPLEtBQUssSUFBSSxDQUFDO1FBQzlELElBQUksQ0FBQyxvQkFBb0IsR0FBRyxJQUFJLENBQUMsa0JBQWtCO1lBQ2pELENBQUMsQ0FBQyxDQUFDLG1CQUFtQixFQUFFLEdBQUcsb0JBQW9CLENBQUM7WUFDaEQsQ0FBQyxDQUFDLENBQUMsbUJBQW1CLENBQUMsQ0FBQztRQUUxQixNQUFNLGlCQUFpQixHQUFHLGdCQUFnQixDQUFDLEtBQUssQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUNoRSxJQUFJLGlCQUFpQixDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsQ0FBQztZQUNuQyxNQUFNLElBQUksS0FBSyxDQUNiLDJGQUEyRixDQUM1RixDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksQ0FBQyxpQkFBaUIsR0FBRyxpQkFBaUIsQ0FBQztRQUMzQyxJQUFJLENBQUMsb0JBQW9CLEdBQUcsaUJBQWlCLENBQUMsTUFBTSxDQUNsRCxDQUFDLFdBQVcsRUFBRSxFQUFFLENBQUMsQ0FBQyxXQUFXLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FDMUUsQ0FBQztRQUVGLE1BQU0sVUFBVSxHQUFHLGlCQUFpQixDQUFDLElBQUksRUFBRSxNQUFNLEVBQUUsWUFBWSxDQUFDLENBQUM7UUFFakUsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLFVBQVUsQ0FBQyxZQUFZLENBQUMsWUFBWSxDQUNsRSxJQUFJLEVBQ0osOEJBQThCLEVBQzlCO1lBQ0UsT0FBTyxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsV0FBVztZQUNuQyxPQUFPLEVBQUUsZUFBZTtZQUN4QixJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQzFCLElBQUEscUZBQTZDLEVBQUMsSUFBSSxDQUFDLG9CQUFvQixDQUFDLENBQ3pFO1lBQ0QsV0FBVyxFQUNULHlGQUF5RjtTQUM1RixDQUNGLENBQUM7UUFFRix1RUFBdUU7UUFDdkUsdUVBQXVFO1FBQ3ZFLDJFQUEyRTtRQUMzRSxvRUFBb0U7UUFDcEUsdUVBQXVFO1FBQ3ZFLHdDQUF3QztRQUN4QyxFQUFFO1FBQ0YsNEVBQTRFO1FBQzVFLDBFQUEwRTtRQUMxRSw2RUFBNkU7UUFDN0Usb0NBQW9DO1FBQ3BDLEVBQUU7UUFDRiwwRUFBMEU7UUFDMUUsMEVBQTBFO1FBQzFFLDBFQUEwRTtRQUMxRSx1RUFBdUU7UUFDdkUsb0VBQW9FO1FBQ3BFLGFBQWE7UUFDYixNQUFNLG1CQUFtQixHQUFHO1lBQzFCLE1BQU07WUFDTixHQUFHLENBQUMsSUFBSSxDQUFDLG9CQUFvQixLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsb0JBQW9CLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1NBQ2hGLENBQUM7UUFDRixNQUFNLG1CQUFtQixHQUFHLElBQUksVUFBVSxDQUFDLG1CQUFtQixDQUM1RCxJQUFJLEVBQ0oscUJBQXFCLEVBQ3JCO1lBQ0UsT0FBTyxFQUNMLCtJQUErSTtZQUNqSixjQUFjLEVBQ1osVUFBVSxDQUFDLDJCQUEyQixDQUFDLFFBQVEsQ0FBQyxHQUFHLG1CQUFtQixDQUFDO1lBQ3pFLGNBQWMsRUFBRSxVQUFVLENBQUMsMkJBQTJCLENBQUMsR0FBRyxFQUFFO1lBQzVELG1CQUFtQixFQUFFLFVBQVUsQ0FBQyxnQ0FBZ0MsQ0FBQyxHQUFHLEVBQUU7U0FDdkUsQ0FDRixDQUFDO1FBRUYsTUFBTSxXQUFXLEdBQTRCO1lBQzNDO2dCQUNFLFNBQVMsRUFBRSxVQUFVLENBQUMsbUJBQW1CLENBQUMsZUFBZTtnQkFDekQsZUFBZSxFQUFFLG1CQUFtQixDQUFDLGNBQWM7YUFDcEQ7U0FDRixDQUFDO1FBQ0YsTUFBTSxlQUFlLEdBQUcsR0FBK0IsRUFBRSxDQUFDLENBQUM7WUFDekQsTUFBTSxFQUFFLFVBQVU7WUFDbEIsY0FBYyxFQUFFLFVBQVUsQ0FBQyxjQUFjLENBQUMsU0FBUztZQUNuRCxXQUFXLEVBQUUsVUFBVSxDQUFDLFdBQVcsQ0FBQyxnQkFBZ0I7WUFDcEQsbUJBQW1CO1lBQ25CLG9CQUFvQixFQUFFLFVBQVUsQ0FBQyxvQkFBb0IsQ0FBQyxpQkFBaUI7WUFDdkUsV0FBVztTQUNaLENBQUMsQ0FBQztRQUVILE1BQU0sbUJBQW1CLEdBQStDLEVBQUUsQ0FBQztRQUMzRSxLQUFLLE1BQU0sV0FBVyxJQUFJLElBQUksQ0FBQyxvQkFBb0IsRUFBRSxDQUFDO1lBQ3BELG1CQUFtQixDQUFDLFdBQVcsQ0FBQyxHQUFHLGVBQWUsRUFBRSxDQUFDO1FBQ3ZELENBQUM7UUFFRCxNQUFNLGNBQWMsR0FDbEIsS0FBSyxDQUFDLFdBQVcsS0FBSyxTQUFTLElBQUksS0FBSyxDQUFDLFdBQVcsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxJQUFJLEtBQUssQ0FBQyxXQUFXLEtBQUssU0FBUyxDQUFDO1FBQ3JHLE1BQU0sc0JBQXNCLEdBQUcsSUFBQSwrQ0FBNkIsRUFDMUQsS0FBSyxDQUFDLGFBQWEsRUFDbkIsY0FBYyxFQUNkLEtBQUssQ0FBQyxzQkFBc0IsQ0FDN0IsQ0FBQztRQUVGLElBQUksQ0FBQyxZQUFZLEdBQUcsSUFBSSxVQUFVLENBQUMsWUFBWSxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7WUFDcEUsZUFBZSxFQUFFLGVBQWUsRUFBRTtZQUNsQyxtQkFBbUI7WUFDbkIsR0FBRyxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsRUFBRSxXQUFXLEVBQUUsS0FBSyxDQUFDLFdBQVcsRUFBRSxXQUFXLEVBQUUsS0FBSyxDQUFDLFdBQVcsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDN0YsR0FBRyxDQUFDLHNCQUFzQixLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRSxzQkFBc0IsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDM0UsR0FBRyxDQUFDLEtBQUssQ0FBQyxVQUFVLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLFVBQVUsRUFBRSxLQUFLLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztTQUM1RSxDQUFDLENBQUM7UUFFSCxNQUFNLGVBQWUsR0FBRyxJQUFJLENBQUMsWUFBWSxDQUFDLElBQUk7YUFDM0MsWUFBMEMsQ0FBQztRQUM5QyxlQUFlLENBQUMsV0FBVyxDQUFDLGtDQUFrQyxFQUFFO1lBQzlELFVBQVUsRUFBRSxpQ0FBaUM7WUFDN0MsV0FBVyxFQUFFLElBQUksQ0FBQyxrQkFBa0I7WUFDcEMsYUFBYSxFQUFFLElBQUksQ0FBQyxvQkFBb0I7WUFDeEMsVUFBVSxFQUFFLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxNQUFNO1lBQ3pDLGtCQUFrQixFQUFFLElBQUksQ0FBQyxrQkFBa0I7WUFDM0MsR0FBRyxDQUFDLElBQUksQ0FBQyxvQkFBb0IsS0FBSyxTQUFTO2dCQUN6QyxDQUFDLENBQUMsRUFBRSxnQkFBZ0IsRUFBRSxJQUFJLENBQUMsb0JBQW9CLEVBQUU7Z0JBQ2pELENBQUMsQ0FBQyxFQUFFLGlDQUFpQyxFQUFFLElBQUksRUFBRSxDQUFDO1NBQ2pELENBQUMsQ0FBQztJQUNMLENBQUM7O0FBbkxILGtGQW9MQztBQVNELGtGQUFrRjtBQUNsRixTQUFTLGdCQUFnQixDQUFDLFFBQWlCO0lBQ3pDLE9BQU8sT0FBTyxRQUFRLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDcEYsQ0FBQztBQUVEOzs7Ozs7R0FNRztBQUNILFNBQVMseUJBQXlCLENBQ2hDLEtBQStDO0lBRS9DLE1BQU0sUUFBUSxHQUFHLEtBQUssQ0FBQyxrQkFBa0IsQ0FBQztJQUMxQyxJQUNFLFFBQVEsS0FBSyxpQ0FBaUMsQ0FBQyxRQUFRO1FBQ3ZELFFBQVEsS0FBSyxpQ0FBaUMsQ0FBQyxNQUFNLEVBQ3JELENBQUM7UUFDRCxNQUFNLElBQUksS0FBSyxDQUNiLGtGQUFrRjtZQUNoRixxRkFBcUY7WUFDckYsOENBQThDLGdCQUFnQixDQUFDLFFBQVEsQ0FBQyxLQUFLO1lBQzdFLDZGQUE2RjtZQUM3RixnR0FBZ0c7WUFDaEcsNEZBQTRGLENBQy9GLENBQUM7SUFDSixDQUFDO0lBRUQsSUFBSSxRQUFRLEtBQUssaUNBQWlDLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDNUQsSUFBSSxLQUFLLENBQUMsVUFBVSxLQUFLLFNBQVMsRUFBRSxDQUFDO1lBQ25DLE1BQU0sSUFBSSxLQUFLLENBQ2Isd0ZBQXdGO2dCQUN0RiwwQ0FBMEMsQ0FDN0MsQ0FBQztRQUNKLENBQUM7UUFDRCxJQUFJLEtBQUssQ0FBQyxpQ0FBaUMsS0FBSyxJQUFJLEVBQUUsQ0FBQztZQUNyRCxNQUFNLElBQUksS0FBSyxDQUNiLDRFQUE0RTtnQkFDMUUseUZBQXlGO2dCQUN6RiwrRkFBK0YsQ0FDbEcsQ0FBQztRQUNKLENBQUM7UUFDRCxPQUFPLEVBQUUsUUFBUSxFQUFFLENBQUM7SUFDdEIsQ0FBQztJQUVELElBQUksS0FBSyxDQUFDLGlDQUFpQyxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQzFELE1BQU0sSUFBSSxLQUFLLENBQ2IsNEZBQTRGO1lBQzFGLCtEQUErRCxDQUNsRSxDQUFDO0lBQ0osQ0FBQztJQUVELE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxVQUFVLENBQUM7SUFDOUIsSUFBSSxJQUFJLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDdkIsTUFBTSxJQUFJLEtBQUssQ0FDYixxRkFBcUY7WUFDbkYsaUdBQWlHO1lBQ2pHLDBCQUEwQixDQUM3QixDQUFDO0lBQ0osQ0FBQztJQUNELElBQUksSUFBSSxDQUFDLFFBQVEsS0FBSyxJQUFJLEVBQUUsQ0FBQztRQUMzQixNQUFNLElBQUksS0FBSyxDQUNiLG9HQUFvRztZQUNsRywrRkFBK0Y7WUFDL0YsdUVBQXVFLENBQzFFLENBQUM7SUFDSixDQUFDO0lBQ0QsSUFBSSxPQUFPLElBQUksQ0FBQyxNQUFNLEtBQUssUUFBUSxJQUFJLENBQUMsMEJBQTBCLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBQ3JGLE1BQU0sSUFBSSxLQUFLLENBQ2IsdUZBQXVGO1lBQ3JGLDhGQUE4RjtZQUM5RixxQ0FBcUMsQ0FDeEMsQ0FBQztJQUNKLENBQUM7SUFFRCxNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsVUFBVSxJQUFJLDBCQUEwQixDQUFDO0lBQ2pFLElBQUksQ0FBQywrQkFBK0IsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQztRQUN0RCxNQUFNLElBQUksS0FBSyxDQUNiLHFHQUFxRyxDQUN0RyxDQUFDO0lBQ0osQ0FBQztJQUNELE1BQU0sb0JBQW9CLEdBQUcsVUFBVSxDQUFDLFdBQVcsRUFBRSxDQUFDO0lBQ3RELElBQ0UsNEJBQTRCLENBQUMsR0FBRyxDQUFDLG9CQUFvQixDQUFDO1FBQ3RELG9CQUFvQixDQUFDLFVBQVUsQ0FBQyxRQUFRLENBQUM7UUFDekMsb0JBQW9CLENBQUMsVUFBVSxDQUFDLFNBQVMsQ0FBQztRQUMxQyxvQkFBb0IsQ0FBQyxVQUFVLENBQUMsYUFBYSxDQUFDLEVBQzlDLENBQUM7UUFDRCxNQUFNLElBQUksS0FBSyxDQUNiLCtEQUErRCxVQUFVLDZGQUE2RixDQUN2SyxDQUFDO0lBQ0osQ0FBQztJQUVELE9BQU8sRUFBRSxRQUFRLEVBQUUsY0FBYyxFQUFFLFVBQVUsRUFBRSxVQUFVLEVBQUUsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDO0FBQzNFLENBQUM7QUFFRCx3RUFBd0U7QUFDeEUsU0FBUyxrQkFBa0IsQ0FDekIsTUFBa0M7SUFFbEMsSUFDRSxNQUFNLEtBQUssU0FBUztRQUNwQixPQUFPLE1BQU0sQ0FBQyxTQUFTLEtBQUssUUFBUTtRQUNwQyxNQUFNLENBQUMsU0FBUyxDQUFDLE1BQU0sS0FBSyxDQUFDO1FBQzdCLE9BQU8sTUFBTSxDQUFDLHFCQUFxQixLQUFLLFFBQVE7UUFDaEQsTUFBTSxDQUFDLHFCQUFxQixDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQ3pDLENBQUM7UUFDRCxNQUFNLElBQUksS0FBSyxDQUFDLDBCQUEwQixDQUFDLENBQUM7SUFDOUMsQ0FBQztBQUNILENBQUM7QUFFRDs7Ozs7Ozs7O0dBU0c7QUFDSCxTQUFTLGlCQUFpQixDQUN4QixLQUFnQixFQUNoQixNQUFzQixFQUN0QixZQUF3QztJQUV4QyxNQUFNLEtBQUssR0FBRyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM5QixNQUFNLGdCQUFnQixHQUFHLEdBQUcsTUFBTSxDQUFDLFNBQVMsZ0JBQWdCLEtBQUssQ0FBQyxNQUFNLElBQUksS0FBSyxDQUFDLFNBQVMsRUFBRSxDQUFDO0lBQzlGLE1BQU0sU0FBUyxHQUFHLE1BQU0sQ0FBQyxlQUFlLEVBQUUsU0FBUyxDQUFDO0lBQ3BELE9BQU8sSUFBSSxPQUFPLENBQUMsVUFBVSxDQUFDLGdCQUFnQixFQUFFO1FBQzlDLGNBQWMsRUFBRSxVQUFVLENBQUMsb0JBQW9CLENBQUMsVUFBVTtRQUMxRCxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLFVBQVUsRUFBRSxJQUFJLFNBQVMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUNyRCxHQUFHLENBQUMsWUFBWSxDQUFDLGNBQWMsS0FBSyxTQUFTLElBQUksWUFBWSxDQUFDLFVBQVUsS0FBSyxTQUFTO1lBQ3BGLENBQUMsQ0FBQyxFQUFFLGFBQWEsRUFBRSxFQUFFLENBQUMsWUFBWSxDQUFDLGNBQWMsQ0FBQyxFQUFFLFlBQVksQ0FBQyxVQUFVLEVBQUUsRUFBRTtZQUMvRSxDQUFDLENBQUMsRUFBRSxDQUFDO0tBQ1IsQ0FBQyxDQUFDO0FBQ0wsQ0FBQztBQUVEOzs7R0FHRztBQUNILFNBQVMsZ0JBQWdCLENBQUMsdUJBQWtDO0lBQzFELE1BQU0sc0JBQXNCLEdBQzFCLHVCQUF1QixLQUFLLFNBQVMsSUFBSSx1QkFBdUIsQ0FBQyxNQUFNLEdBQUcsQ0FBQztRQUN6RSxDQUFDLENBQUMsdUJBQXVCO1FBQ3pCLENBQUMsQ0FBQyw0Q0FBd0IsQ0FBQywwQkFBMEIsRUFBRSxDQUFDLEdBQUcsQ0FDdkQsQ0FBQyxRQUFRLEVBQUUsRUFBRSxDQUFDLFFBQVEsQ0FBQyxVQUFVLENBQ2xDLENBQUM7SUFFUixNQUFNLFdBQVcsR0FBNEM7UUFDM0QsQ0FBQyxZQUFZLEVBQUUsRUFBRSxDQUFDLFlBQVk7UUFDOUIsQ0FBQyxZQUFZLEVBQUUsRUFBRSxDQUNmLDRDQUF3QixDQUFDLG9DQUFvQyxDQUFDLFlBQVksQ0FBQztRQUM3RSxDQUFDLFlBQVksRUFBRSxFQUFFLENBQ2YsNENBQXdCLENBQUMsc0NBQXNDLENBQUMsWUFBWSxDQUFDO1FBQy9FLENBQUMsWUFBWSxFQUFFLEVBQUUsQ0FDZiw0Q0FBd0IsQ0FBQyx5Q0FBeUMsQ0FBQyxZQUFZLENBQUM7UUFDbEYsQ0FBQyxZQUFZLEVBQUUsRUFBRSxDQUNmLDRDQUF3QixDQUFDLHFDQUFxQyxDQUFDLFlBQVksQ0FBQztRQUM5RSxDQUFDLFlBQVksRUFBRSxFQUFFLENBQ2YsNENBQXdCLENBQUMsd0NBQXdDLENBQUMsWUFBWSxDQUFDO1FBQ2pGLENBQUMsWUFBWSxFQUFFLEVBQUUsQ0FDZiw0Q0FBd0IsQ0FBQyw0Q0FBNEMsQ0FBQyxZQUFZLENBQUM7S0FDdEYsQ0FBQztJQUVGLE1BQU0sT0FBTyxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7SUFDbEMsS0FBSyxNQUFNLFlBQVksSUFBSSxzQkFBc0IsRUFBRSxDQUFDO1FBQ2xELEtBQUssTUFBTSxNQUFNLElBQUksV0FBVyxFQUFFLENBQUM7WUFDakMsSUFBSSxDQUFDO2dCQUNILE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUM7WUFDcEMsQ0FBQztZQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7Z0JBQ2YsTUFBTSxJQUFJLEtBQUssQ0FDYiw2REFBNkQsWUFBWSxnREFBZ0QsWUFBWSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQy9JLENBQUM7WUFDSixDQUFDO1FBQ0gsQ0FBQztJQUNILENBQUM7SUFFRCw2RUFBNkU7SUFDN0UsMkVBQTJFO0lBQzNFLE9BQU8sQ0FBQyxHQUFHLENBQ1QsNENBQXdCLENBQUMsNkJBQTZCLENBQ3BELDRDQUF3QixDQUFDLHFCQUFxQixDQUMvQyxDQUNGLENBQUM7SUFFRixPQUFPLEtBQUssQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7QUFDcEMsQ0FBQztBQUVELHdFQUF3RTtBQUN4RSxTQUFTLFlBQVksQ0FBQyxLQUFjO0lBQ2xDLE9BQU8sS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ2hFLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBTdGFjayB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBhcGlndyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXlcIjtcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250XCI7XG5pbXBvcnQgKiBhcyBvcmlnaW5zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udC1vcmlnaW5zXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYSB9IGZyb20gXCIuL21jcC1yb3V0ZS1hbGdlYnJhXCI7XG5pbXBvcnQgeyBnZW5lcmF0ZVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uSGFuZGxlckNvZGUgfSBmcm9tIFwiLi9wcml2YXRlL3Jlc3QtdjEtY2hhbGxlbmdlLXJlc3RvcmF0aW9uLWhhbmRsZXJcIjtcbmltcG9ydCB7IGRlZmF1bHRNaW5pbXVtUHJvdG9jb2xWZXJzaW9uIH0gZnJvbSBcIi4vcHJpdmF0ZS9zZWN1cmUtZGVmYXVsdHNcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuL25hbWluZy1jb250ZXh0XCI7XG5cbi8qKiBNZXRhZGF0YSBrZXkgcmVjb3JkZWQgb24gdGhlIGRpc3RyaWJ1dGlvbiBmb3IgdGhlIGNoYWxsZW5nZS1yZXN0b3JhdGlvbiBjb250cmFjdC4gKi9cbmNvbnN0IENIQUxMRU5HRV9SRVNUT1JBVElPTl9NRVRBREFUQV9LRVkgPSBcImFwcHRoZW9yeTpyZXN0LXYxLWNoYWxsZW5nZS1yZXN0b3JhdGlvblwiO1xuXG4vKiogQ29udHJhY3QgaWQgcmVjb3JkZWQgaW4gdGhlIGRpc3RyaWJ1dGlvbiBtZXRhZGF0YSBtYXJrZXIuICovXG5jb25zdCBDSEFMTEVOR0VfUkVTVE9SQVRJT05fQ09OVFJBQ1RfSUQgPSBcIm0xNy5yZXN0LXYxLWNoYWxsZW5nZS1yZXN0b3JhdGlvbi92MVwiO1xuXG4vKipcbiAqIFRoZSBtYW5pZmVzdCBjb25zdGFudCBmb3IgdGhlIEFXUyBSRVNUIHYxIHJlbWFwIGFydGlmYWN0LlxuICpcbiAqIEFXUyBBUEkgR2F0ZXdheSBSRVNUIEFQSSB2MSByZW1hcHMgdGhlIG9yaWdpbidzIGBXV1ctQXV0aGVudGljYXRlYCByZXNwb25zZVxuICogaGVhZGVyIG9udG8gdGhpcyBoZWFkZXIsIHNvIGl0IGlzIHRoZSByZXN0b3JlIHNvdXJjZSB0aGF0IGRvZXMgbm90IGRlcGVuZCBvblxuICogYW55IG9wdGlvbmFsIGJyaWRnZS5cbiAqL1xuY29uc3QgUkVNQVBfU09VUkNFX0hFQURFUiA9IFwieC1hbXpuLXJlbWFwcGVkLXd3dy1hdXRoZW50aWNhdGVcIjtcblxuLyoqXG4gKiBUaGUgb3B0aW9uYWwgYWxpYXMgYnJpZGdlIHNwZWxsaW5ncywgY29uc3VsdGVkIG9ubHkgd2hlbiB0aGUgYWxpYXMgYnJpZGdlIGlzXG4gKiBlbmFibGVkLCBpbiBwcmlvcml0eSBvcmRlciBhZnRlciB0aGUgcmVtYXAgYXJ0aWZhY3QuXG4gKi9cbmNvbnN0IEFMSUFTX1NPVVJDRV9IRUFERVJTID0gW1wieC10aGVvcnktd3d3LWF1dGhlbnRpY2F0ZVwiLCBcIm1jcC13d3ctYXV0aGVudGljYXRlXCJdO1xuXG4vKipcbiAqIFRoZSBkZWZhdWx0IFJFU1QgdjEgdHJhbnNwb3J0LWZhaWx1cmUgbWVzc2FnZS5cbiAqXG4gKiBUaGUgcmVzdG9yYXRpb24gaXMgYSBkb2N1bWVudGVkIG5vLW9wIG9uIEhUVFAgQVBJIHYyLCBzbyBhIG5vbi1SRVNULXYxIG9yaWdpblxuICogZmFpbHMgc3ludGggcmF0aGVyIHRoYW4gc2lsZW50bHkgZGVncmFkaW5nLlxuICovXG5jb25zdCBOT05fUkVTVF9WMV9PUklHSU5fTUVTU0FHRSA9XG4gIFwiQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb246IG9yaWdpbiBtdXN0IGJlIGFuIEFXUyBBUEkgR2F0ZXdheSBSRVNUIEFQSSAodjEpOyBcIiArXG4gIFwidGhlIFdXVy1BdXRoZW50aWNhdGUgcmVzdG9yYXRpb24gaXMgYSBkb2N1bWVudGVkIG5vLW9wIG9uIEhUVFAgQVBJIHYyXCI7XG5cbi8qKiBUaGUgb3JpZ2luLWxvY2sgaGVhZGVyIHRoaXMgY29uc3RydWN0IGluamVjdHMgb24gYW55IHJlcXVlc3QgaXQgc2VuZHMgdG8gdGhlIG9yaWdpbi4gKi9cbmNvbnN0IERFRkFVTFRfT1JJR0lOX0xPQ0tfSEVBREVSID0gXCJ4LWFwcHRoZW9yeS1vcmlnaW4tbG9ja1wiO1xuXG4vKipcbiAqIFRoZSBvcmlnaW4tbG9jayBzZWNyZXQgYWxwaGFiZXQuXG4gKlxuICogVGhlIHZhbHVlIGlzIGEgbGl0ZXJhbCBDbG91ZEZyb250IG9yaWdpbiBjdXN0b20gaGVhZGVyIHZhbHVlIChDbG91ZEZyb250XG4gKiBjdXN0b20gb3JpZ2luIGhlYWRlcnMgY2FycnkgcGxhaW4gc3RyaW5ncywgbm90IHRlbXBsYXRlIGludHJpbnNpY3MpLCBzbyB0aGVcbiAqIHNlY3JldCBpcyByZXN0cmljdGVkIHRvIGEgaGVhZGVyLXZhbHVlLXNhZmUgYWxwaGFiZXQgd2l0aCBubyB3aGl0ZXNwYWNlIGFuZCBub1xuICogY29udHJvbCBjaGFyYWN0ZXJzLlxuICovXG5jb25zdCBPUklHSU5fTE9DS19TRUNSRVRfUEFUVEVSTiA9IC9eW0EtWmEtejAtOS5ffi1dezMyLDEyOH0kLztcblxuLyoqIFRoZSBvcmlnaW4tbG9jayBoZWFkZXIgbmFtZSBhbHBoYWJldC4gKi9cbmNvbnN0IE9SSUdJTl9MT0NLX0hFQURFUl9OQU1FX1BBVFRFUk4gPSAvXltBLVphLXowLTktXXsxLDY0fSQvO1xuXG4vKipcbiAqIEhlYWRlciBuYW1lcyBDbG91ZEZyb250IHJlc2VydmVzIG9yIHRoYXQgd291bGQgcmV3cml0ZSB0aGUgb3JpZ2luIHJlcXVlc3RcbiAqIGNvbnRyYWN0LCBzbyB0aGV5IGNhbiBuZXZlciBjYXJyeSB0aGUgb3JpZ2luIGxvY2suXG4gKi9cbmNvbnN0IFJFU0VSVkVEX09SSUdJTl9MT0NLX0hFQURFUlMgPSBuZXcgU2V0KFtcbiAgXCJhdXRob3JpemF0aW9uXCIsXG4gIFwiY29ubmVjdGlvblwiLFxuICBcImNvbnRlbnQtbGVuZ3RoXCIsXG4gIFwiY29va2llXCIsXG4gIFwiaG9zdFwiLFxuICBcInRyYW5zZmVyLWVuY29kaW5nXCIsXG4gIFwid3d3LWF1dGhlbnRpY2F0ZVwiLFxuICBcIngtZm9yd2FyZGVkLWZvclwiLFxuXSk7XG5cbi8qKlxuICogVGhlIERELTIgZGlyZWN0LW9yaWdpbiByZWFjaGFiaWxpdHkgZGVjaXNpb24gZm9yIGEgUkVTVCB2MSBvcmlnaW4uXG4gKlxuICogREQtMiAoYERFRkVOU0VfSU5fREVQVEgubWRgKSByZXF1aXJlcyB0aGUgZGVwbG95bWVudCB0byAqKnJlY29yZCoqIHdoZXRoZXIgdGhlXG4gKiBgZXhlY3V0ZS1hcGlgIGRlZmF1bHQgZW5kcG9pbnQgaXMgZGlyZWN0bHkgcmVhY2hhYmxlIGFuZCwgd2hlbiBpdCBpcywgdG8gbWFrZVxuICogdGhhdCBwb3N0dXJlIGV4cGxpY2l0LiBBIGRpcmVjdGx5IHJlYWNoYWJsZSBvcmlnaW4gKGBkaXJlY3RgKSBpcyAqKm5vdCoqXG4gKiBhbGxvd2VkOiBpdCBpcyBub3QgYSBtZW1iZXIgb2YgdGhpcyBlbnVtIGFuZCB0aGUgY29uc3RydWN0IHJlZnVzZXMgaXQgYXRcbiAqIHN5bnRoZXNpcy5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5UmVzdFYxT3JpZ2luUmVhY2hhYmlsaXR5IHtcbiAgLyoqXG4gICAqIFRoZSBSRVNUIEFQSSdzIGBleGVjdXRlLWFwaWAgZGVmYXVsdCBlbmRwb2ludCBpcyBkaXNhYmxlZFxuICAgKiAoYGRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnRgKSwgc28gdGhlIEFQSSBpcyBub3QgcmVhY2hhYmxlIGF0IGl0cyBkZWZhdWx0XG4gICAqIGVuZHBvaW50LlxuICAgKlxuICAgKiBCZWNhdXNlIHRoZSBjb25zdHJ1Y3QgZnJvbnRzIGFuIGV4dGVybmFsIGBJUmVzdEFwaWAgaXQgY2Fubm90IG11dGF0ZSwgdGhlXG4gICAqIGNhbGxlciBtdXN0IGFzc2VydCB0aGUgZGlzYWJsZW1lbnQgd2l0aFxuICAgKiBgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludEFzc2VydGVkOiB0cnVlYC5cbiAgICpcbiAgICogTm90ZSB0aGUgcGxhdGZvcm0gc2hhcGU6IHRoZSBkaXNhYmxlZCBob3N0bmFtZSBpcyBleGFjdGx5IHRoZVxuICAgKiBgPHJlc3RBcGlJZD4uZXhlY3V0ZS1hcGkuPHJlZ2lvbj4uPHVybFN1ZmZpeD5gIGhvc3RuYW1lIHRoaXMgY29uc3RydWN0IHVzZXNcbiAgICogYXMgaXRzIG9yaWdpbiwgc28gYW4gYXBwIHRoYXQgZGlzYWJsZXMgdGhlIGRlZmF1bHQgZW5kcG9pbnQgbXVzdCBmcm9udCBpdHNcbiAgICogUkVTVCBBUEkgdGhyb3VnaCBhIGN1c3RvbSBkb21haW4gKEFXUyByZXF1aXJlcyBhIGN1c3RvbSBkb21haW4gb25jZSB0aGVcbiAgICogZGVmYXVsdCBlbmRwb2ludCBpcyBkaXNhYmxlZCkuIGBMT0NLRURgIGlzIHRoZSBwb3N0dXJlIGZvciBhIFJFU1QgdjEgb3JpZ2luXG4gICAqIHRoaXMgY29uc3RydWN0IGlzIGV4cGVjdGVkIHRvIHNlcnZlLlxuICAgKi9cbiAgRElTQUJMRUQgPSBcImRpc2FibGVkXCIsXG4gIC8qKlxuICAgKiBUaGUgb3JpZ2luIGlzIHJlYWNoYWJsZSBvbmx5IHRocm91Z2ggdGhpcyBjb25zdHJ1Y3QncyBDbG91ZEZyb250IGZyb250IGRvb3IuXG4gICAqXG4gICAqIFJlcXVpcmVzIGBvcmlnaW5Mb2NrYCBjYXJyeWluZyB0aGUgb3JpZ2luLWxvY2sgc2VjcmV0IHRoZSBjb25zdHJ1Y3QgaW5qZWN0c1xuICAgKiBhcyBhIGN1c3RvbSBvcmlnaW4gaGVhZGVyLCBwbHVzIHRoZSBjYWxsZXIncyBhc3NlcnRpb24gdGhhdCB0aGUgUkVTVCBBUElcbiAgICogdmVyaWZpZXMgdGhhdCBoZWFkZXIgKHRoZSBjb25zdHJ1Y3QgY2Fubm90IGF0dGFjaCBhbiBvcmlnaW4tc2lkZVxuICAgKiB2ZXJpZmljYXRpb24gdG8gYW4gZXh0ZXJuYWwgYElSZXN0QXBpYCkuXG4gICAqL1xuICBMT0NLRUQgPSBcImxvY2tlZFwiLFxufVxuXG4vKipcbiAqIFRoZSBvcmlnaW4gbG9jayBmb3IgYG9yaWdpblJlYWNoYWJpbGl0eTogTE9DS0VEYC5cbiAqXG4gKiBUaGUgY29uc3RydWN0IGluamVjdHMgYHNlY3JldGAgYXMgdGhlIGBoZWFkZXJOYW1lYCBjdXN0b20gb3JpZ2luIGhlYWRlciBvblxuICogKipldmVyeSoqIHJlcXVlc3QgaXQgc2VuZHMgdG8gdGhlIFJFU1QgdjEgb3JpZ2luLCBzbyBhbiBvcmlnaW4tc2lkZVxuICogdmVyaWZpY2F0aW9uIGNhbiByZWZ1c2UgYSByZXF1ZXN0IHRoYXQgZGlkIG5vdCBjb21lIHRocm91Z2ggdGhpc1xuICogZGlzdHJpYnV0aW9uLiBUaGUgY29uc3RydWN0IGZyb250cyBhbiBleHRlcm5hbCBgSVJlc3RBcGlgLCBzbyBpdCBjYW5ub3QgYXR0YWNoXG4gKiB0aGF0IHZlcmlmaWNhdGlvbiBpdHNlbGY6IHRoZSBjYWxsZXIgYXNzZXJ0cyBpdCB3aXRoIGBhc3NlcnRlZDogdHJ1ZWAuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdFYxT3JpZ2luTG9ja09wdGlvbnMge1xuICAvKipcbiAgICogVGhlIGxpdGVyYWwgc2VjcmV0IGluamVjdGVkIGFzIHRoZSBvcmlnaW4tbG9jayBoZWFkZXIgb24gZXZlcnkgQ2xvdWRGcm9udFxuICAgKiByZXF1ZXN0IHRvIHRoZSBvcmlnaW4uXG4gICAqXG4gICAqIDMyIHRvIDEyOCBjaGFyYWN0ZXJzIG9mIGBbQS1aYS16MC05Ll9+LV1gLiBUaGUgdmFsdWUgaXMgYSBsaXRlcmFsIENsb3VkRnJvbnRcbiAgICogb3JpZ2luIGN1c3RvbSBoZWFkZXIgdmFsdWUsIHNvIGl0IGFwcGVhcnMgdmVyYmF0aW0gaW4gdGhlIHN5bnRoZXNpemVkXG4gICAqIHRlbXBsYXRlIGFuZCBtdXN0IG5vdCBiZSAob3IgY29udGFpbikgYSBjcmVkZW50aWFsIHlvdSBjYW5ub3Qgcm90YXRlIHdpdGggdGhlXG4gICAqIFJFU1QgQVBJJ3MgdmVyaWZpY2F0aW9uLlxuICAgKi9cbiAgcmVhZG9ubHkgc2VjcmV0OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBvcmlnaW4tbG9jayBoZWFkZXIgbmFtZS5cbiAgICpcbiAgICogMSB0byA2NCBjaGFyYWN0ZXJzIG9mIGBbQS1aYS16MC05LV1gLCBhbmQgbmV2ZXIgYSBuYW1lIENsb3VkRnJvbnQgcmVzZXJ2ZXMgb3JcbiAgICogdGhhdCByZXdyaXRlcyB0aGUgb3JpZ2luIHJlcXVlc3QgY29udHJhY3QgKGBIb3N0YCwgYEF1dGhvcml6YXRpb25gLFxuICAgKiBgQ29va2llYCwgYENvbnRlbnQtTGVuZ3RoYCwgYFRyYW5zZmVyLUVuY29kaW5nYCwgYENvbm5lY3Rpb25gLFxuICAgKiBgV1dXLUF1dGhlbnRpY2F0ZWAsIGBYLUZvcndhcmRlZC1Gb3JgLCBvciBhbnkgYHgtYW16LSpgLCBgeC1hbXpuLSpgLCBvclxuICAgKiBgY2xvdWRmcm9udC0qYCBuYW1lKS5cbiAgICpcbiAgICogQGRlZmF1bHQgXCJ4LWFwcHRoZW9yeS1vcmlnaW4tbG9ja1wiXG4gICAqL1xuICByZWFkb25seSBoZWFkZXJOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY2FsbGVyJ3MgYXNzZXJ0aW9uIHRoYXQgdGhlIFJFU1QgQVBJIHZlcmlmaWVzIHRoZSBvcmlnaW4gbG9jay5cbiAgICpcbiAgICogVGhpcyBjb25zdHJ1Y3QgY2Fubm90IGF0dGFjaCBhIHJlc291cmNlIHBvbGljeSwgYXV0aG9yaXplciwgb3IgYW55IG90aGVyXG4gICAqIG9yaWdpbi1zaWRlIHZlcmlmaWNhdGlvbiB0byBhbiBleHRlcm5hbCBgSVJlc3RBcGlgIGl0IGRvZXMgbm90IG93biwgc28gaXRcbiAgICogcmVmdXNlcyB0byBzeW50aGVzaXplIHVudGlsIHRoZSBjYWxsZXIgcmVjb3JkcyB0aGF0IHRoZSB2ZXJpZmljYXRpb24gZXhpc3RzXG4gICAqIGFuZCByZXF1aXJlcyB0aGUgaW5qZWN0ZWQgaGVhZGVyLiBNdXN0IGJlIGB0cnVlYC5cbiAgICovXG4gIHJlYWRvbmx5IGFzc2VydGVkOiBib29sZWFuO1xufVxuXG4vKipcbiAqIE9wdGlvbnMgZm9yIHRoZSBvcHRpb25hbCBjaGFsbGVuZ2UgYWxpYXMgYnJpZGdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUNoYWxsZW5nZUFsaWFzQnJpZGdlT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBFbmFibGVzIHRoZSBvcHRpb25hbCBjaGFsbGVuZ2UgYWxpYXMgYnJpZGdlLlxuICAgKlxuICAgKiBXaGVuIGVuYWJsZWQgdGhlIHJlc3RvcmF0aW9uIGNvbnN1bHRzIHRoZSBicmlkZ2UgYWxpYXNlc1xuICAgKiAoYHgtdGhlb3J5LXd3dy1hdXRoZW50aWNhdGVgLCB0aGVuIGBtY3Atd3d3LWF1dGhlbnRpY2F0ZWApIGFmdGVyIHRoZSBBV1NcbiAgICogUkVTVCB2MSByZW1hcCBhcnRpZmFjdC4gV2hlbiBkaXNhYmxlZCBvbmx5IHRoZSByZW1hcCBhcnRpZmFjdCBpcyBjb25zdWx0ZWRcbiAgICogYW5kIHRoZSBhbGlhcyBzcGVsbGluZ3MgbmV2ZXIgYXBwZWFyIGluIHRoZSBkZXBsb3llZCBmdW5jdGlvbiBzb3VyY2UuXG4gICAqXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBlbmFibGVkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBQcm9wZXJ0aWVzIGZvciBgQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb25gLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uUHJvcHMge1xuICAvKipcbiAgICogVGhlIFJFU1QgQVBJIHYxIG9yaWdpbiB3aG9zZSBgV1dXLUF1dGhlbnRpY2F0ZWAgcmVzcG9uc2VzIG11c3QgYmUgcmVzdG9yZWQuXG4gICAqXG4gICAqIE9ubHkgYW4gQVdTIEFQSSBHYXRld2F5IFJFU1QgQVBJIHYxIChhIG5vbi1lbXB0eSBgcmVzdEFwaUlkYCBhbmQgYSBub24tZW1wdHlcbiAgICogYHJlc3RBcGlSb290UmVzb3VyY2VJZGApIGlzIGFjY2VwdGVkOyB0aGUgcmVzdG9yYXRpb24gaXMgYSBkb2N1bWVudGVkIG5vLW9wXG4gICAqIG9uIEhUVFAgQVBJIHYyLlxuICAgKi9cbiAgcmVhZG9ubHkgb3JpZ2luOiBhcGlndy5JUmVzdEFwaTtcblxuICAvKipcbiAgICogVGhlIG1hbmRhdG9yeSBERC0yIGRpcmVjdC1vcmlnaW4gcmVhY2hhYmlsaXR5IGRlY2lzaW9uLlxuICAgKlxuICAgKiBSZXF1aXJlZC4gYERJU0FCTEVEYCBhbmQgYExPQ0tFRGAgc3ludGhlc2l6ZTsgYW55dGhpbmcgZWxzZSDigJQgaW4gcGFydGljdWxhciBhXG4gICAqIGRpcmVjdGx5IHJlYWNoYWJsZSBvcmlnaW4g4oCUIGZhaWxzIHN5bnRoZXNpcyB3aXRoIGFuIGVycm9yIHRoYXQgbmFtZXMgdGhlXG4gICAqIHJlamVjdGVkIGRlY2lzaW9uLlxuICAgKi9cbiAgcmVhZG9ubHkgb3JpZ2luUmVhY2hhYmlsaXR5OiBBcHBUaGVvcnlSZXN0VjFPcmlnaW5SZWFjaGFiaWxpdHk7XG5cbiAgLyoqXG4gICAqIFRoZSBjYWxsZXIncyBhc3NlcnRpb24gdGhhdCB0aGUgUkVTVCBBUEkncyBgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludGAgaXNcbiAgICogc2V0LCByZXF1aXJlZCB3aXRoIGBvcmlnaW5SZWFjaGFiaWxpdHk6IERJU0FCTEVEYC5cbiAgICpcbiAgICogVGhpcyBjb25zdHJ1Y3QgZnJvbnRzIGFuIGV4dGVybmFsIGBJUmVzdEFwaWAgaXQgY2Fubm90IG11dGF0ZSwgc28gaXQgY2Fubm90XG4gICAqIHNldCB0aGUgcHJvcGVydHkgZm9yIHRoZSBjYWxsZXI7IGl0IHJlcXVpcmVzIHRoZSBhc3NlcnRpb24gaW5zdGVhZCBhbmRcbiAgICogcmVjb3JkcyBpdCBpbiB0aGUgZGlzdHJpYnV0aW9uIG1ldGFkYXRhLlxuICAgKi9cbiAgcmVhZG9ubHkgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludEFzc2VydGVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogVGhlIG1hbmRhdG9yeSBvcmlnaW4gbG9jaywgcmVxdWlyZWQgd2l0aCBgb3JpZ2luUmVhY2hhYmlsaXR5OiBMT0NLRURgLlxuICAgKi9cbiAgcmVhZG9ubHkgb3JpZ2luTG9jaz86IEFwcFRoZW9yeVJlc3RWMU9yaWdpbkxvY2tPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBNQ1AgcmVzb3VyY2UgcGF0aHMgd2hvc2UgZGVyaXZlZCByb3V0ZXMgcmVjZWl2ZSBhbiBleHBsaWNpdCBvcmRlcmVkIGNhY2hlXG4gICAqIGJlaGF2aW9yLlxuICAgKlxuICAgKiBUaGUgZWZmZWN0aXZlIHJvdXRlIHNldCBpcyBkZXJpdmVkIGZyb20gdGhlIHNoYXJlZCByb3V0ZSBhbGdlYnJhLCBuZXZlclxuICAgKiBoYW5kLXdpcmVkLiBBIHN1cHBsaWVkLWJ1dC1lbXB0eSBhcnJheSBpcyB0cmVhdGVkIGFzIHRoZSBkZWZhdWx0LlxuICAgKlxuICAgKiBAZGVmYXVsdCB0aGUgc3RhbmRhcmQgTUNQIHBhdHRlcm5zIGZyb20gdGhlIHNoYXJlZCByb3V0ZSBhbGdlYnJhXG4gICAqIChgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnN1cHBvcnRlZEVuZHBvaW50VGVtcGxhdGVzKCkubWNwUGF0dGVybmApXG4gICAqL1xuICByZWFkb25seSByZXNvdXJjZVBhdGhzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIGNoYWxsZW5nZSBhbGlhcyBicmlkZ2UuXG4gICAqXG4gICAqIEBkZWZhdWx0IGRpc2FibGVkXG4gICAqL1xuICByZWFkb25seSBhbGlhc0JyaWRnZT86IEFwcFRoZW9yeUNoYWxsZW5nZUFsaWFzQnJpZGdlT3B0aW9ucztcblxuICAvKipcbiAgICogT3B0aW9uYWwgY3VzdG9tIGRvbWFpbiBuYW1lcyBmb3IgdGhlIGRpc3RyaWJ1dGlvbi5cbiAgICpcbiAgICogV2hlbiBzZXQsIGBjZXJ0aWZpY2F0ZWAgaXMgcmVxdWlyZWQuXG4gICAqL1xuICByZWFkb25seSBkb21haW5OYW1lcz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBDZXJ0aWZpY2F0ZSBmb3IgYGRvbWFpbk5hbWVzYC4gUmVxdWlyZWQgd2hlbiBgZG9tYWluTmFtZXNgIGlzIHNldC5cbiAgICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAvKipcbiAgICogT3B0aW9uYWwgQ2xvdWRGcm9udCBwcmljZSBjbGFzcy5cbiAgICovXG4gIHJlYWRvbmx5IHByaWNlQ2xhc3M/OiBjbG91ZGZyb250LlByaWNlQ2xhc3M7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIG5hbWluZyBjb250ZXh0IHRoYXQgc2VsZWN0cyB0aGUgU2VjdXJpdHkgSHViLWFsaWduZWQgZGVmYXVsdHMuXG4gICAqXG4gICAqIFVuZGVyIGEgZGVyaXZlZCBjb250ZXh0IGEgZGlzdHJpYnV0aW9uIHRoYXQgc2VydmVzIGBkb21haW5OYW1lc2AgdGhyb3VnaFxuICAgKiBgY2VydGlmaWNhdGVgIHRha2VzIHRoZSBDbG91ZEZyb250LjE1IGBUTFNfVjFfMl8yMDI1YCB2aWV3ZXIgcG9saWN5LiBUaGVcbiAgICogcm9vdCBpcyB0aGUgUkVTVCBBUEkgb3JpZ2luLCBhIGN1c3RvbSBvcmlnaW4gQ2xvdWRGcm9udC4xIGRvZXMgbm90XG4gICAqIGV2YWx1YXRlLCBzbyBubyBkZWZhdWx0IHJvb3Qgb2JqZWN0IGFwcGxpZXMuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgLyoqXG4gICAqIE1pbmltdW0gVExTIHByb3RvY29sIHZlcnNpb24gZm9yIHZpZXdlcnMgb2YgYGRvbWFpbk5hbWVzYC5cbiAgICpcbiAgICogQGRlZmF1bHQgVExTX1YxXzJfMjAyNSB1bmRlciBhIGRlcml2ZWQgbmFtaW5nIGNvbnRleHQgd2l0aCBhIGNlcnRpZmljYXRlLFxuICAgKiBvdGhlcndpc2UgdGhlIENsb3VkRnJvbnQgZGVmYXVsdCBmb3IgdGhlIGNlcnRpZmljYXRlXG4gICAqL1xuICByZWFkb25seSBtaW5pbXVtUHJvdG9jb2xWZXJzaW9uPzogY2xvdWRmcm9udC5TZWN1cml0eVBvbGljeVByb3RvY29sO1xufVxuXG4vKipcbiAqIEEgZnJhbWV3b3JrIENsb3VkRnJvbnQgZnJvbnQgZG9vciB0aGF0IHJlc3RvcmVzIHRoZSBjYW5vbmljYWxcbiAqIGBXV1ctQXV0aGVudGljYXRlYCBjaGFsbGVuZ2UgZm9yIGFuIEFXUyBBUEkgR2F0ZXdheSBSRVNUIEFQSSB2MSBvcmlnaW4uXG4gKlxuICogQVdTIFJFU1QgQVBJIHYxIHJlbWFwcyB0aGUgb3JpZ2luJ3MgYFdXVy1BdXRoZW50aWNhdGVgIHJlc3BvbnNlIGhlYWRlciBvbnRvXG4gKiBgeC1hbXpuLXJlbWFwcGVkLXd3dy1hdXRoZW50aWNhdGVgLCBzbyBhIGNhbm9uaWNhbC1vbmx5IGFwcCBsb3NlcyB0aGVcbiAqIGNoYWxsZW5nZSBhdCB0aGUgZWRnZS4gVGhpcyBjb25zdHJ1Y3QgZnJvbnRzIHRoZSBSRVNUIHYxIGBleGVjdXRlLWFwaWAgb3JpZ2luXG4gKiB3aXRoIGEgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gd2hvc2Ugb3JpZ2luLXJlc3BvbnNlIExhbWJkYUBFZGdlIGZ1bmN0aW9uXG4gKiBjb3BpZXMgdGhlIGZpcnN0IHByZXNlbnQgc291cmNlIGJhY2sgb250byBgV1dXLUF1dGhlbnRpY2F0ZWAgYW5kIHJlbW92ZXMgdGhlXG4gKiBjb25zdW1lZCBzb3VyY2UgaGVhZGVycy5cbiAqXG4gKiBUaGUgcmVzdG9yZSAqKnNvdXJjZSBzZXQqKiwgaW4gcHJpb3JpdHkgb3JkZXIsIGlzOlxuICpcbiAqIDEuIGB4LWFtem4tcmVtYXBwZWQtd3d3LWF1dGhlbnRpY2F0ZWAg4oCUIHRoZSBhcnRpZmFjdCBBV1MgaXRzZWxmIHByb2R1Y2VzIHdoZW5cbiAqICAgIFJFU1QgdjEgcmVtYXBzIHRoZSBvcmlnaW4gaGVhZGVyLiBBbHdheXMgY29uc3VsdGVkLlxuICogMi4gdGhlIGJyaWRnZSBhbGlhc2VzIGB4LXRoZW9yeS13d3ctYXV0aGVudGljYXRlYCwgdGhlblxuICogICAgYG1jcC13d3ctYXV0aGVudGljYXRlYCDigJQgY29uc3VsdGVkIG9ubHkgd2hlbiB0aGUgb3B0aW9uYWwgYWxpYXMgYnJpZGdlIGlzXG4gKiAgICBlbmFibGVkIChvZmYgYnkgZGVmYXVsdCkuXG4gKlxuICogIyMgVGhlIGRpcmVjdC1lbmRwb2ludCBjYXZlYXQgKERELTIpXG4gKlxuICogQSBDbG91ZEZyb250IGZyb250IGRvb3IgZG9lcyAqKm5vdCoqIGJ5IGl0c2VsZiBtYWtlIHRoZSBvcmlnaW4gdW5yZWFjaGFibGUuXG4gKiBUaGUgUkVTVCBBUEkga2VlcHMgYW5zd2VyaW5nIGF0IGl0cyBvd25cbiAqIGA8cmVzdEFwaUlkPi5leGVjdXRlLWFwaS48cmVnaW9uPi48dXJsU3VmZml4PmAgZW5kcG9pbnQsIHdoaWNoIGlzIGV4YWN0bHkgdGhlXG4gKiBvcmlnaW4gdGhpcyBkaXN0cmlidXRpb24gdXNlcywgc28gYSBjbGllbnQgdGhhdCBza2lwcyB0aGUgZGlzdHJpYnV0aW9uIHN0aWxsXG4gKiByZWFjaGVzIHRoZSBvcmlnaW4gYW5kIG9ic2VydmVzIGEgKipjaGFsbGVuZ2UtbGVzcyBgNDAxYCoqIGZvciBhIFJFU1QgdjFcbiAqIGNhbm9uaWNhbC1vbmx5IGFwcCDigJQgdGhlIHJlc3RvcmF0aW9uIG5ldmVyIHJ1bnMsIGFuZCBhbnkgZWRnZS1vbmx5IGNvbnRyb2xcbiAqICh0aHJvdHRsaW5nIGF0IHRoZSBlZGdlLCBlZGdlIG9ic2VydmFiaWxpdHksIHRoZSBhbGlhcyBicmlkZ2UpIGlzIGJ5cGFzc2VkIG9uXG4gKiB0aGF0IHBhdGguIEF1dGhlbnRpY2F0aW9uIGl0c2VsZiBpcyB1bmFmZmVjdGVkOiB0aGUgcnVudGltZSBiZWFyZXIgZ2F0ZSBzdGlsbFxuICogcmVmdXNlcyB0aGUgcmVxdWVzdCBhdCB0aGUgb3JpZ2luLCBzbyB0aGlzIGlzIGNoYWxsZW5nZSBsb3NzIGFuZCBlZGdlIGJ5cGFzcyxcbiAqIG5vdCBhbiBhdXRoZW50aWNhdGlvbiBieXBhc3MuXG4gKlxuICogYG9yaWdpblJlYWNoYWJpbGl0eWAgaXMgdGhlcmVmb3JlICoqcmVxdWlyZWQqKiAoREQtMidzIG1hbmRhdG9yeVxuICogZGlyZWN0LW9yaWdpbiBkZWNpc2lvbik6XG4gKlxuICogLSBgRElTQUJMRURgIOKAlCB0aGUgUkVTVCBBUEkncyBgZXhlY3V0ZS1hcGlgIGRlZmF1bHQgZW5kcG9pbnQgaXMgZGlzYWJsZWQuIFRoZVxuICogICBjYWxsZXIgYXNzZXJ0cyBpdCAoYGRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnRBc3NlcnRlZDogdHJ1ZWApIGJlY2F1c2UgdGhpc1xuICogICBjb25zdHJ1Y3QgY2Fubm90IG11dGF0ZSBhbiBleHRlcm5hbCBgSVJlc3RBcGlgLiBUaGUgY29uc3RydWN0IGRvZXMgbm90XG4gKiAgIHZlcmlmeSB0aGUgYXNzZXJ0aW9uLCBhbmQgdGhlIGRpc2FibGVkIGhvc3RuYW1lIGlzIHRoZSBkaXN0cmlidXRpb24ncyBvd25cbiAqICAgb3JpZ2luIGhvc3RuYW1lLCBzbyBhbiBhcHAgdGhhdCBkaXNhYmxlcyB0aGUgZGVmYXVsdCBlbmRwb2ludCBtdXN0IGZyb250IHRoZVxuICogICBvcmlnaW4gdGhyb3VnaCBhIGN1c3RvbSBkb21haW4uXG4gKiAtIGBMT0NLRURgIOKAlCB0aGUgb3JpZ2luIGlzIHJlYWNoYWJsZSBvbmx5IHRocm91Z2ggdGhpcyBkaXN0cmlidXRpb24uIFRoZVxuICogICBjb25zdHJ1Y3QgaW5qZWN0cyBgb3JpZ2luTG9jay5zZWNyZXRgIGFzIGEgY3VzdG9tIG9yaWdpbiBoZWFkZXIgb24gZXZlcnlcbiAqICAgcmVxdWVzdCB0byB0aGUgb3JpZ2luLCBhbmQgdGhlIGNhbGxlciBhc3NlcnRzXG4gKiAgIChgb3JpZ2luTG9jay5hc3NlcnRlZDogdHJ1ZWApIHRoYXQgdGhlIFJFU1QgQVBJIHZlcmlmaWVzIHRoYXQgaGVhZGVyOyB0aGVcbiAqICAgY29uc3RydWN0IGNhbm5vdCBhdHRhY2ggdGhlIHZlcmlmaWNhdGlvbiB0byBhbiBleHRlcm5hbCBgSVJlc3RBcGlgLlxuICpcbiAqIEEgZGlyZWN0bHkgcmVhY2hhYmxlIG9yaWdpbiAoYGRpcmVjdGApIGlzIHJlZnVzZWQgYXQgc3ludGhlc2lzLiBUaGUgZGVjaXNpb25cbiAqIGlzIHJlY29yZGVkIGluIHRoZSBkaXN0cmlidXRpb24ncyBDbG91ZEZvcm1hdGlvbiBtZXRhZGF0YVxuICogKGBhcHB0aGVvcnk6cmVzdC12MS1jaGFsbGVuZ2UtcmVzdG9yYXRpb25gKSwgc28gdGhlIHBvc3R1cmUgaXMgYXVkaXRhYmxlIGZyb21cbiAqIHRoZSBzeW50aGVzaXplZCB0ZW1wbGF0ZS5cbiAqXG4gKiBUaGUgZGVyaXZlZCByb3V0ZSBzZXQgYW5kIHRoZSBleHBsaWNpdCBvcmRlcmVkIGNhY2hlIGJlaGF2aW9ycyBjb21lIGZyb20gdGhlXG4gKiBzaGFyZWQgcm91dGUgYWxnZWJyYSAoYEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYWApLCBzbyB0aGUgY29uc3RydWN0IGlzIG5ldmVyXG4gKiBoYW5kLXdpcmVkLiBQYXJhbWV0ZXJpemVkIGRlcml2ZWQgcm91dGVzICh0aG9zZSBjYXJyeWluZyBhIGB7cGFyYW1ldGVyfWBcbiAqIHNlZ21lbnQpIGNhbm5vdCBiZSBleHByZXNzZWQgYXMgQ2xvdWRGcm9udCBwYXRoIHBhdHRlcm5zIGFuZCBhcmUgdGhlcmVmb3JlXG4gKiBjb3ZlcmVkIGJ5IHRoZSBkaXN0cmlidXRpb24ncyBkZWZhdWx0IGJlaGF2aW9yLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb24gZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAvKiogVGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uIGZyb250aW5nIHRoZSBSRVNUIHYxIG9yaWdpbi4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGRpc3RyaWJ1dGlvbjogY2xvdWRmcm9udC5EaXN0cmlidXRpb247XG5cbiAgLyoqXG4gICAqIFRoZSByZXNwb25zZSBoZWFkZXJzIHRoZSByZXN0b3JhdGlvbiBmdW5jdGlvbiBjb25zdWx0cywgaW4gcHJpb3JpdHkgb3JkZXIuXG4gICAqXG4gICAqIGBbXCJ4LWFtem4tcmVtYXBwZWQtd3d3LWF1dGhlbnRpY2F0ZVwiXWAgd2hlbiB0aGUgYWxpYXMgYnJpZGdlIGlzIGRpc2FibGVkO1xuICAgKiBgW1wieC1hbXpuLXJlbWFwcGVkLXd3dy1hdXRoZW50aWNhdGVcIiwgXCJ4LXRoZW9yeS13d3ctYXV0aGVudGljYXRlXCIsXG4gICAqIFwibWNwLXd3dy1hdXRoZW50aWNhdGVcIl1gIHdoZW4gaXQgaXMgZW5hYmxlZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSByZXN0b3JlU291cmNlSGVhZGVyczogc3RyaW5nW107XG5cbiAgLyoqIFRydWUgd2hlbiB0aGUgb3B0aW9uYWwgYWxpYXMgYnJpZGdlIGlzIGVuYWJsZWQuICovXG4gIHB1YmxpYyByZWFkb25seSBhbGlhc0JyaWRnZUVuYWJsZWQ6IGJvb2xlYW47XG5cbiAgLyoqIFRoZSByZWNvcmRlZCBERC0yIGRpcmVjdC1vcmlnaW4gcmVhY2hhYmlsaXR5IGRlY2lzaW9uLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgb3JpZ2luUmVhY2hhYmlsaXR5OiBBcHBUaGVvcnlSZXN0VjFPcmlnaW5SZWFjaGFiaWxpdHk7XG5cbiAgLyoqXG4gICAqIFRoZSBvcmlnaW4tbG9jayBoZWFkZXIgbmFtZSBpbmplY3RlZCBvbiBldmVyeSByZXF1ZXN0IHRvIHRoZSBvcmlnaW4sIG9yXG4gICAqIGB1bmRlZmluZWRgIHdoZW4gdGhlIGRlY2lzaW9uIGlzIGBESVNBQkxFRGAuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgb3JpZ2luTG9ja0hlYWRlck5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBjb21wbGV0ZSByb3V0ZSBzZXQgZGVyaXZlZCBmcm9tIHRoZSBzaGFyZWQgcm91dGUgYWxnZWJyYSAocGFyYW1ldGVyaXplZFxuICAgKiByb3V0ZXMgaW5jbHVkZWQpLCBkZWR1cGVkIGFuZCBpbiBkZXRlcm1pbmlzdGljIHNvcnRlZCBvcmRlci5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBkZXJpdmVkUm91dGVQYXRoczogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFRoZSBzdWJzZXQgb2YgYGRlcml2ZWRSb3V0ZVBhdGhzYCBlbWl0dGVkIGFzIGV4cGxpY2l0IG9yZGVyZWQgY2FjaGVcbiAgICogYmVoYXZpb3JzICh0aGUgbGl0ZXJhbCBwYXRocywgd2l0aCBubyBge3BhcmFtZXRlcn1gIHNlZ21lbnQpLlxuICAgKlxuICAgKiBDbG91ZEZyb250IHBhdGggcGF0dGVybnMgY2Fubm90IGV4cHJlc3MgYSBge3BhcmFtfWAgc2VnbWVudCwgc29cbiAgICogcGFyYW1ldGVyaXplZCBkZXJpdmVkIHJvdXRlcyBhcmUgY292ZXJlZCBieSB0aGUgZGVmYXVsdCBiZWhhdmlvci5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBiZWhhdmlvclBhdGhQYXR0ZXJuczogc3RyaW5nW107XG5cbiAgcHVibGljIGNvbnN0cnVjdG9yKFxuICAgIHNjb3BlOiBDb25zdHJ1Y3QsXG4gICAgaWQ6IHN0cmluZyxcbiAgICBwcm9wczogQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb25Qcm9wcyxcbiAgKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IG9yaWdpbiA9IChwcm9wcyBhcyB7IG9yaWdpbj86IGFwaWd3LklSZXN0QXBpIH0pLm9yaWdpbjtcbiAgICBhc3NlcnRSZXN0VjFPcmlnaW4ob3JpZ2luKTtcblxuICAgIGNvbnN0IHJlYWNoYWJpbGl0eSA9IHJlc29sdmVPcmlnaW5SZWFjaGFiaWxpdHkocHJvcHMpO1xuICAgIHRoaXMub3JpZ2luUmVhY2hhYmlsaXR5ID0gcmVhY2hhYmlsaXR5LmRlY2lzaW9uO1xuICAgIHRoaXMub3JpZ2luTG9ja0hlYWRlck5hbWUgPSByZWFjaGFiaWxpdHkubG9ja0hlYWRlck5hbWU7XG5cbiAgICBpZiAoXG4gICAgICBwcm9wcy5kb21haW5OYW1lcyAhPT0gdW5kZWZpbmVkICYmXG4gICAgICBwcm9wcy5kb21haW5OYW1lcy5sZW5ndGggPiAwICYmXG4gICAgICBwcm9wcy5jZXJ0aWZpY2F0ZSA9PT0gdW5kZWZpbmVkXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb246IGRvbWFpbk5hbWVzIHJlcXVpcmVzIGNlcnRpZmljYXRlXCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIHRoaXMuYWxpYXNCcmlkZ2VFbmFibGVkID0gcHJvcHMuYWxpYXNCcmlkZ2U/LmVuYWJsZWQgPT09IHRydWU7XG4gICAgdGhpcy5yZXN0b3JlU291cmNlSGVhZGVycyA9IHRoaXMuYWxpYXNCcmlkZ2VFbmFibGVkXG4gICAgICA/IFtSRU1BUF9TT1VSQ0VfSEVBREVSLCAuLi5BTElBU19TT1VSQ0VfSEVBREVSU11cbiAgICAgIDogW1JFTUFQX1NPVVJDRV9IRUFERVJdO1xuXG4gICAgY29uc3QgZGVyaXZlZFJvdXRlUGF0aHMgPSBkZXJpdmVSb3V0ZVBhdGhzKHByb3BzLnJlc291cmNlUGF0aHMpO1xuICAgIGlmIChkZXJpdmVkUm91dGVQYXRocy5sZW5ndGggPT09IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbjogdGhlIHJvdXRlIG1vZGVsIGRlcml2ZWQgbm8gcm91dGVzIGZyb20gcmVzb3VyY2VQYXRoc1wiLFxuICAgICAgKTtcbiAgICB9XG4gICAgdGhpcy5kZXJpdmVkUm91dGVQYXRocyA9IGRlcml2ZWRSb3V0ZVBhdGhzO1xuICAgIHRoaXMuYmVoYXZpb3JQYXRoUGF0dGVybnMgPSBkZXJpdmVkUm91dGVQYXRocy5maWx0ZXIoXG4gICAgICAocGF0aFBhdHRlcm4pID0+ICFwYXRoUGF0dGVybi5pbmNsdWRlcyhcIntcIikgJiYgIXBhdGhQYXR0ZXJuLmluY2x1ZGVzKFwifVwiKSxcbiAgICApO1xuXG4gICAgY29uc3QgcmVzdE9yaWdpbiA9IGJ1aWxkUmVzdFYxT3JpZ2luKHRoaXMsIG9yaWdpbiwgcmVhY2hhYmlsaXR5KTtcblxuICAgIGNvbnN0IHJlc3RvcmF0aW9uRnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5leHBlcmltZW50YWwuRWRnZUZ1bmN0aW9uKFxuICAgICAgdGhpcyxcbiAgICAgIFwiQ2hhbGxlbmdlUmVzdG9yYXRpb25GdW5jdGlvblwiLFxuICAgICAge1xuICAgICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjJfWCxcbiAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21JbmxpbmUoXG4gICAgICAgICAgZ2VuZXJhdGVSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbkhhbmRsZXJDb2RlKHRoaXMucmVzdG9yZVNvdXJjZUhlYWRlcnMpLFxuICAgICAgICApLFxuICAgICAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgICBcIlJlc3RvcmUgdGhlIGNhbm9uaWNhbCBXV1ctQXV0aGVudGljYXRlIGNoYWxsZW5nZSBmb3IgQXBwVGhlb3J5IFJFU1QgdjEgb3JpZ2luIHJlc3BvbnNlc1wiLFxuICAgICAgfSxcbiAgICApO1xuXG4gICAgLy8gQ0RLJ3MgT3JpZ2luUmVxdWVzdEhlYWRlckJlaGF2aW9yIGhhcyBubyBgYWxsVmlld2VyRXhjZXB0SG9zdEhlYWRlcmBcbiAgICAvLyBidWlsZGVyIGFuZCByZWZ1c2VzIGBBdXRob3JpemF0aW9uYCBpbiBhbiBhbGxvdyBsaXN0LCBzbyB0aGUgbWFuYWdlZFxuICAgIC8vIEFMTF9WSUVXRVJfRVhDRVBUX0hPU1RfSEVBREVSIHBvbGljeSBpcyBleHByZXNzZWQgdGhlIHdheSBBV1MgaW1wbGVtZW50c1xuICAgIC8vIGl0OiBgYWxsRXhjZXB0YCB3aXRoIG9ubHkgYEhvc3RgIGRlbmllZC4gRXZlcnkgdmlld2VyIGhlYWRlciAodGhlXG4gICAgLy8gYEF1dGhvcml6YXRpb25gIGhlYWRlciBhYm92ZSBhbGwpIGlzIGZvcndhcmRlZCwgYW5kIENsb3VkRnJvbnQgc3RpbGxcbiAgICAvLyBwcmVzZW50cyB0aGUgZXhlY3V0ZS1hcGkgb3JpZ2luIGhvc3QuXG4gICAgLy9cbiAgICAvLyBVbmRlciBMT0NLRUQgdGhlIG9yaWdpbi1sb2NrIGhlYWRlciBpcyBkZW5pZWQgdG8gdGhlIHZpZXdlciBhcyB3ZWxsLCBzbyBhXG4gICAgLy8gdmlld2VyLXN1cHBsaWVkIGNvcHkgb2YgdGhlIGxvY2sgaGVhZGVyIGlzIHN0cmlwcGVkIGF0IHRoZSBlZGdlIGFuZCB0aGVcbiAgICAvLyBDbG91ZEZyb250LWluamVjdGVkIG9yaWdpbiBjdXN0b20gaGVhZGVyIGlzIHRoZSBvbmx5IGNvcHkgdGhhdCByZWFjaGVzIHRoZVxuICAgIC8vIG9yaWdpbiB0aHJvdWdoIHRoaXMgZGlzdHJpYnV0aW9uLlxuICAgIC8vXG4gICAgLy8gQWxsIGNvb2tpZXMgYW5kIGFsbCBxdWVyeSBzdHJpbmdzIGFyZSBmb3J3YXJkZWQgYXMgd2VsbCwgZXhhY3RseSBhcyB0aGVcbiAgICAvLyBtYW5hZ2VkIHBvbGljeSBkb2VzOiB0aGUgZGVyaXZlZCBPQXV0aCByb3V0ZXMgY2FycnkgdGhlaXIgcGFyYW1ldGVycyBpblxuICAgIC8vIHRoZSBxdWVyeSBzdHJpbmcgKHRoZSBwZXIta2luZCBgLi4uL2F1dGhvcml6ZWAgcm91dGUgYW5kIHRoZSBjYWxsYmFjaydzXG4gICAgLy8gYD9jb2RlPS4uLiZzdGF0ZT0uLi5gKSwgc28gZHJvcHBpbmcgdGhlIHF1ZXJ5IHN0cmluZyB3b3VsZCBicmVhayB0aGVcbiAgICAvLyBmcm9udCBjaGFubmVsLCBhbmQgYSBjb29raWUtY2FycmllZCBzZXNzaW9uIG11c3QgcmVhY2ggdGhlIG9yaWdpblxuICAgIC8vIHVuY2hhbmdlZC5cbiAgICBjb25zdCBkZW5pZWRWaWV3ZXJIZWFkZXJzID0gW1xuICAgICAgXCJIb3N0XCIsXG4gICAgICAuLi4odGhpcy5vcmlnaW5Mb2NrSGVhZGVyTmFtZSAhPT0gdW5kZWZpbmVkID8gW3RoaXMub3JpZ2luTG9ja0hlYWRlck5hbWVdIDogW10pLFxuICAgIF07XG4gICAgY29uc3Qgb3JpZ2luUmVxdWVzdFBvbGljeSA9IG5ldyBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RQb2xpY3koXG4gICAgICB0aGlzLFxuICAgICAgXCJPcmlnaW5SZXF1ZXN0UG9saWN5XCIsXG4gICAgICB7XG4gICAgICAgIGNvbW1lbnQ6XG4gICAgICAgICAgXCJBcHBUaGVvcnkgUkVTVCB2MSBjaGFsbGVuZ2UgcmVzdG9yYXRpb246IGZvcndhcmQgYWxsIHZpZXdlciBoZWFkZXJzIGV4Y2VwdCBIb3N0IGFuZCBhbnkgb3JpZ2luLWxvY2sgaGVhZGVyLCBhbGwgY29va2llcyBhbmQgYWxsIHF1ZXJ5IHN0cmluZ3NcIixcbiAgICAgICAgaGVhZGVyQmVoYXZpb3I6XG4gICAgICAgICAgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0SGVhZGVyQmVoYXZpb3IuZGVueUxpc3QoLi4uZGVuaWVkVmlld2VySGVhZGVycyksXG4gICAgICAgIGNvb2tpZUJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RDb29raWVCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIGNvbnN0IGVkZ2VMYW1iZGFzOiBjbG91ZGZyb250LkVkZ2VMYW1iZGFbXSA9IFtcbiAgICAgIHtcbiAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkxhbWJkYUVkZ2VFdmVudFR5cGUuT1JJR0lOX1JFU1BPTlNFLFxuICAgICAgICBmdW5jdGlvblZlcnNpb246IHJlc3RvcmF0aW9uRnVuY3Rpb24uY3VycmVudFZlcnNpb24sXG4gICAgICB9LFxuICAgIF07XG4gICAgY29uc3QgYmVoYXZpb3JPcHRpb25zID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICBvcmlnaW46IHJlc3RPcmlnaW4sXG4gICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICBjYWNoZVBvbGljeTogY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVELFxuICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgZWRnZUxhbWJkYXMsXG4gICAgfSk7XG5cbiAgICBjb25zdCBhZGRpdGlvbmFsQmVoYXZpb3JzOiBSZWNvcmQ8c3RyaW5nLCBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucz4gPSB7fTtcbiAgICBmb3IgKGNvbnN0IHBhdGhQYXR0ZXJuIG9mIHRoaXMuYmVoYXZpb3JQYXRoUGF0dGVybnMpIHtcbiAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnNbcGF0aFBhdHRlcm5dID0gYmVoYXZpb3JPcHRpb25zKCk7XG4gICAgfVxuXG4gICAgY29uc3QgZnJvbnRlZERvbWFpbnMgPVxuICAgICAgcHJvcHMuZG9tYWluTmFtZXMgIT09IHVuZGVmaW5lZCAmJiBwcm9wcy5kb21haW5OYW1lcy5sZW5ndGggPiAwICYmIHByb3BzLmNlcnRpZmljYXRlICE9PSB1bmRlZmluZWQ7XG4gICAgY29uc3QgbWluaW11bVByb3RvY29sVmVyc2lvbiA9IGRlZmF1bHRNaW5pbXVtUHJvdG9jb2xWZXJzaW9uKFxuICAgICAgcHJvcHMubmFtaW5nQ29udGV4dCxcbiAgICAgIGZyb250ZWREb21haW5zLFxuICAgICAgcHJvcHMubWluaW11bVByb3RvY29sVmVyc2lvbixcbiAgICApO1xuXG4gICAgdGhpcy5kaXN0cmlidXRpb24gPSBuZXcgY2xvdWRmcm9udC5EaXN0cmlidXRpb24odGhpcywgXCJEaXN0cmlidXRpb25cIiwge1xuICAgICAgZGVmYXVsdEJlaGF2aW9yOiBiZWhhdmlvck9wdGlvbnMoKSxcbiAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnMsXG4gICAgICAuLi4oZnJvbnRlZERvbWFpbnMgPyB7IGRvbWFpbk5hbWVzOiBwcm9wcy5kb21haW5OYW1lcywgY2VydGlmaWNhdGU6IHByb3BzLmNlcnRpZmljYXRlIH0gOiB7fSksXG4gICAgICAuLi4obWluaW11bVByb3RvY29sVmVyc2lvbiAhPT0gdW5kZWZpbmVkID8geyBtaW5pbXVtUHJvdG9jb2xWZXJzaW9uIH0gOiB7fSksXG4gICAgICAuLi4ocHJvcHMucHJpY2VDbGFzcyAhPT0gdW5kZWZpbmVkID8geyBwcmljZUNsYXNzOiBwcm9wcy5wcmljZUNsYXNzIH0gOiB7fSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBjZm5EaXN0cmlidXRpb24gPSB0aGlzLmRpc3RyaWJ1dGlvbi5ub2RlXG4gICAgICAuZGVmYXVsdENoaWxkIGFzIGNsb3VkZnJvbnQuQ2ZuRGlzdHJpYnV0aW9uO1xuICAgIGNmbkRpc3RyaWJ1dGlvbi5hZGRNZXRhZGF0YShDSEFMTEVOR0VfUkVTVE9SQVRJT05fTUVUQURBVEFfS0VZLCB7XG4gICAgICBjb250cmFjdElkOiBDSEFMTEVOR0VfUkVTVE9SQVRJT05fQ09OVFJBQ1RfSUQsXG4gICAgICBhbGlhc0JyaWRnZTogdGhpcy5hbGlhc0JyaWRnZUVuYWJsZWQsXG4gICAgICBzb3VyY2VIZWFkZXJzOiB0aGlzLnJlc3RvcmVTb3VyY2VIZWFkZXJzLFxuICAgICAgcm91dGVDb3VudDogdGhpcy5kZXJpdmVkUm91dGVQYXRocy5sZW5ndGgsXG4gICAgICBvcmlnaW5SZWFjaGFiaWxpdHk6IHRoaXMub3JpZ2luUmVhY2hhYmlsaXR5LFxuICAgICAgLi4uKHRoaXMub3JpZ2luTG9ja0hlYWRlck5hbWUgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IHsgb3JpZ2luTG9ja0hlYWRlcjogdGhpcy5vcmlnaW5Mb2NrSGVhZGVyTmFtZSB9XG4gICAgICAgIDogeyBkaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50QXNzZXJ0ZWQ6IHRydWUgfSksXG4gICAgfSk7XG4gIH1cbn1cblxuLyoqIFRoZSByZXNvbHZlZCBERC0yIGRlY2lzaW9uLCB3aXRoIHRoZSBvcmlnaW4tbG9jayBtYXRlcmlhbCB3aGVuIExPQ0tFRC4gKi9cbmludGVyZmFjZSBPcmlnaW5SZWFjaGFiaWxpdHlEZWNpc2lvbiB7XG4gIHJlYWRvbmx5IGRlY2lzaW9uOiBBcHBUaGVvcnlSZXN0VjFPcmlnaW5SZWFjaGFiaWxpdHk7XG4gIHJlYWRvbmx5IGxvY2tIZWFkZXJOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBsb2NrU2VjcmV0Pzogc3RyaW5nO1xufVxuXG4vKiogUmVuZGVycyBhIHJlamVjdGVkIGRlY2lzaW9uIGZvciBhbiBlcnJvciBtZXNzYWdlIHdpdGhvdXQgYXNzdW1pbmcgaXRzIHR5cGUuICovXG5mdW5jdGlvbiBkZXNjcmliZURlY2lzaW9uKGRlY2lzaW9uOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIHR5cGVvZiBkZWNpc2lvbiA9PT0gXCJzdHJpbmdcIiA/IEpTT04uc3RyaW5naWZ5KGRlY2lzaW9uKSA6IFN0cmluZyhkZWNpc2lvbik7XG59XG5cbi8qKlxuICogUmVzb2x2ZXMgYW5kIHZhbGlkYXRlcyB0aGUgbWFuZGF0b3J5IERELTIgZGlyZWN0LW9yaWdpbiByZWFjaGFiaWxpdHkgZGVjaXNpb24uXG4gKlxuICogRmFpbHMgY2xvc2VkIGF0IHN5bnRoZXNpcyBvbiBhIG1pc3Npbmcgb3IgYGRpcmVjdGAgZGVjaXNpb24sIG9uIGEgYERJU0FCTEVEYFxuICogZGVjaXNpb24gd2l0aG91dCB0aGUgY2FsbGVyJ3MgZGlzYWJsZW1lbnQgYXNzZXJ0aW9uLCBvbiBhIGBMT0NLRURgIGRlY2lzaW9uXG4gKiB3aXRob3V0IGEgY29tcGxldGUgb3JpZ2luIGxvY2ssIGFuZCBvbiBjb250cmFkaWN0b3J5IHByb3BzLlxuICovXG5mdW5jdGlvbiByZXNvbHZlT3JpZ2luUmVhY2hhYmlsaXR5KFxuICBwcm9wczogQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb25Qcm9wcyxcbik6IE9yaWdpblJlYWNoYWJpbGl0eURlY2lzaW9uIHtcbiAgY29uc3QgZGVjaXNpb24gPSBwcm9wcy5vcmlnaW5SZWFjaGFiaWxpdHk7XG4gIGlmIChcbiAgICBkZWNpc2lvbiAhPT0gQXBwVGhlb3J5UmVzdFYxT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEICYmXG4gICAgZGVjaXNpb24gIT09IEFwcFRoZW9yeVJlc3RWMU9yaWdpblJlYWNoYWJpbGl0eS5MT0NLRURcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbjogb3JpZ2luUmVhY2hhYmlsaXR5IGlzIHJlcXVpcmVkIGFuZCBtdXN0IGJlIFwiICtcbiAgICAgICAgXCJBcHBUaGVvcnlSZXN0VjFPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRUQgb3IgLkxPQ0tFRCAoREQtMik7IGEgZGlyZWN0bHkgcmVhY2hhYmxlIFwiICtcbiAgICAgICAgYG9yaWdpbiAoJ2RpcmVjdCcpIGlzIG5vdCBhbGxvd2VkIChyZWNlaXZlZCAke2Rlc2NyaWJlRGVjaXNpb24oZGVjaXNpb24pfSkuIGAgK1xuICAgICAgICBcIlRoZSBSRVNUIEFQSSdzIGV4ZWN1dGUtYXBpIGVuZHBvaW50IGlzIHRoZSBvcmlnaW4gdGhpcyBkaXN0cmlidXRpb24gdXNlcywgc28gYSBjbGllbnQgdGhhdCBcIiArXG4gICAgICAgIFwiYnlwYXNzZXMgdGhlIGRpc3RyaWJ1dGlvbiBzdGlsbCByZWFjaGVzIGl0IGFuZCBvYnNlcnZlcyBhIGNoYWxsZW5nZS1sZXNzIDQwMTogcmVjb3JkIGhvdyB0aGF0IFwiICtcbiAgICAgICAgXCJlbmRwb2ludCBpcyBtYWRlIHVucmVhY2hhYmxlIChESVNBQkxFRCkgb3IgcmVhY2hlZCBvbmx5IHRocm91Z2ggdGhpcyBkaXN0cmlidXRpb24gKExPQ0tFRClcIixcbiAgICApO1xuICB9XG5cbiAgaWYgKGRlY2lzaW9uID09PSBBcHBUaGVvcnlSZXN0VjFPcmlnaW5SZWFjaGFiaWxpdHkuRElTQUJMRUQpIHtcbiAgICBpZiAocHJvcHMub3JpZ2luTG9jayAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb246IG9yaWdpbkxvY2sgaXMgb25seSB2YWxpZCB3aXRoIG9yaWdpblJlYWNoYWJpbGl0eSBcIiArXG4gICAgICAgICAgXCJBcHBUaGVvcnlSZXN0VjFPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocHJvcHMuZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludEFzc2VydGVkICE9PSB0cnVlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb246IG9yaWdpblJlYWNoYWJpbGl0eSBESVNBQkxFRCByZXF1aXJlcyBcIiArXG4gICAgICAgICAgXCJkaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50QXNzZXJ0ZWQ6IHRydWU7IHRoaXMgY29uc3RydWN0IGZyb250cyBhbiBleHRlcm5hbCBJUmVzdEFwaSBpdCBcIiArXG4gICAgICAgICAgXCJjYW5ub3QgbXV0YXRlLCBzbyB0aGUgY2FsbGVyIG11c3QgYXNzZXJ0IHRoYXQgdGhlIFJFU1QgQVBJJ3MgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludCBpcyBzZXRcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiB7IGRlY2lzaW9uIH07XG4gIH1cblxuICBpZiAocHJvcHMuZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludEFzc2VydGVkICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uOiBkaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50QXNzZXJ0ZWQgaXMgb25seSB2YWxpZCB3aXRoIFwiICtcbiAgICAgICAgXCJvcmlnaW5SZWFjaGFiaWxpdHkgQXBwVGhlb3J5UmVzdFYxT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEXCIsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGxvY2sgPSBwcm9wcy5vcmlnaW5Mb2NrO1xuICBpZiAobG9jayA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBvcmlnaW5Mb2NrIFwiICtcbiAgICAgICAgXCIoeyBzZWNyZXQsIGFzc2VydGVkOiB0cnVlIH0pIGNhcnJ5aW5nIHRoZSBvcmlnaW4tbG9jayBtYXRlcmlhbCBhbmQgdGhlIGNhbGxlcidzIGFzc2VydGlvbiB0aGF0IFwiICtcbiAgICAgICAgXCJ0aGUgUkVTVCBBUEkgdmVyaWZpZXMgaXRcIixcbiAgICApO1xuICB9XG4gIGlmIChsb2NrLmFzc2VydGVkICE9PSB0cnVlKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbjogb3JpZ2luUmVhY2hhYmlsaXR5IExPQ0tFRCByZXF1aXJlcyBvcmlnaW5Mb2NrLmFzc2VydGVkOiB0cnVlIFwiICtcbiAgICAgICAgXCIodGhlIGNhbGxlciBhc3NlcnRzIHRoZSBSRVNUIEFQSSB2ZXJpZmllcyB0aGUgb3JpZ2luLWxvY2sgaGVhZGVyIHRoaXMgZGlzdHJpYnV0aW9uIGluamVjdHMpOyBcIiArXG4gICAgICAgIFwidGhpcyBjb25zdHJ1Y3QgY2Fubm90IGF0dGFjaCB0aGUgdmVyaWZpY2F0aW9uIHRvIGFuIGV4dGVybmFsIElSZXN0QXBpXCIsXG4gICAgKTtcbiAgfVxuICBpZiAodHlwZW9mIGxvY2suc2VjcmV0ICE9PSBcInN0cmluZ1wiIHx8ICFPUklHSU5fTE9DS19TRUNSRVRfUEFUVEVSTi50ZXN0KGxvY2suc2VjcmV0KSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb246IG9yaWdpbkxvY2suc2VjcmV0IG11c3QgYmUgMzIuLjEyOCBjaGFyYWN0ZXJzIG9mIFwiICtcbiAgICAgICAgXCJbQS1aYS16MC05Ll9+LV0gKGEgbGl0ZXJhbCBDbG91ZEZyb250IG9yaWdpbiBjdXN0b20gaGVhZGVyIHZhbHVlOiBubyB3aGl0ZXNwYWNlLCBubyBjb250cm9sIFwiICtcbiAgICAgICAgXCJjaGFyYWN0ZXJzLCBubyB0ZW1wbGF0ZSBpbnRyaW5zaWNzKVwiLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBoZWFkZXJOYW1lID0gbG9jay5oZWFkZXJOYW1lID8/IERFRkFVTFRfT1JJR0lOX0xPQ0tfSEVBREVSO1xuICBpZiAoIU9SSUdJTl9MT0NLX0hFQURFUl9OQU1FX1BBVFRFUk4udGVzdChoZWFkZXJOYW1lKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb246IG9yaWdpbkxvY2suaGVhZGVyTmFtZSBtdXN0IGJlIDEuLjY0IGNoYXJhY3RlcnMgb2YgW0EtWmEtejAtOS1dXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkSGVhZGVyTmFtZSA9IGhlYWRlck5hbWUudG9Mb3dlckNhc2UoKTtcbiAgaWYgKFxuICAgIFJFU0VSVkVEX09SSUdJTl9MT0NLX0hFQURFUlMuaGFzKG5vcm1hbGl6ZWRIZWFkZXJOYW1lKSB8fFxuICAgIG5vcm1hbGl6ZWRIZWFkZXJOYW1lLnN0YXJ0c1dpdGgoXCJ4LWFtei1cIikgfHxcbiAgICBub3JtYWxpemVkSGVhZGVyTmFtZS5zdGFydHNXaXRoKFwieC1hbXpuLVwiKSB8fFxuICAgIG5vcm1hbGl6ZWRIZWFkZXJOYW1lLnN0YXJ0c1dpdGgoXCJjbG91ZGZyb250LVwiKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb246IG9yaWdpbkxvY2suaGVhZGVyTmFtZSBcIiR7aGVhZGVyTmFtZX1cIiBpcyByZXNlcnZlZCBieSBDbG91ZEZyb250IG9yIHRoZSBvcmlnaW4gcmVxdWVzdCBjb250cmFjdCBhbmQgY2Fubm90IGNhcnJ5IHRoZSBvcmlnaW4gbG9ja2AsXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiB7IGRlY2lzaW9uLCBsb2NrSGVhZGVyTmFtZTogaGVhZGVyTmFtZSwgbG9ja1NlY3JldDogbG9jay5zZWNyZXQgfTtcbn1cblxuLyoqIEZhaWxzIGNsb3NlZCB1bmxlc3MgdGhlIG9yaWdpbiBpcyBhbiBBV1MgQVBJIEdhdGV3YXkgUkVTVCBBUEkgdjEuICovXG5mdW5jdGlvbiBhc3NlcnRSZXN0VjFPcmlnaW4oXG4gIG9yaWdpbjogYXBpZ3cuSVJlc3RBcGkgfCB1bmRlZmluZWQsXG4pOiBhc3NlcnRzIG9yaWdpbiBpcyBhcGlndy5JUmVzdEFwaSB7XG4gIGlmIChcbiAgICBvcmlnaW4gPT09IHVuZGVmaW5lZCB8fFxuICAgIHR5cGVvZiBvcmlnaW4ucmVzdEFwaUlkICE9PSBcInN0cmluZ1wiIHx8XG4gICAgb3JpZ2luLnJlc3RBcGlJZC5sZW5ndGggPT09IDAgfHxcbiAgICB0eXBlb2Ygb3JpZ2luLnJlc3RBcGlSb290UmVzb3VyY2VJZCAhPT0gXCJzdHJpbmdcIiB8fFxuICAgIG9yaWdpbi5yZXN0QXBpUm9vdFJlc291cmNlSWQubGVuZ3RoID09PSAwXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihOT05fUkVTVF9WMV9PUklHSU5fTUVTU0FHRSk7XG4gIH1cbn1cblxuLyoqXG4gKiBCdWlsZHMgdGhlIEhUVFBTLW9ubHkgYGV4ZWN1dGUtYXBpYCBvcmlnaW4gZm9yIGFuIEFXUyBBUEkgR2F0ZXdheSBSRVNUIEFQSSB2MSxcbiAqIGNhcnJ5aW5nIHRoZSBvcmlnaW4tbG9jayBoZWFkZXIgd2hlbiB0aGUgZGVjaXNpb24gaXMgYExPQ0tFRGAuXG4gKlxuICogYGNsb3VkZnJvbnQtb3JpZ2luc2AnIGBSZXN0QXBpT3JpZ2luYCBhY2NlcHRzIGEgYFJlc3RBcGlCYXNlYCAoaXQgcmVhZHMgdGhlXG4gKiBjb25jcmV0ZSBgdXJsYCB0b2tlbiksIG5vdCB0aGUgYElSZXN0QXBpYCB0aGlzIGNvbnN0cnVjdCB0YWtlcywgYW5kIGBJUmVzdEFwaWBcbiAqIGV4cG9zZXMgbmVpdGhlciBgdXJsYCBub3IgYHVybEZvclBhdGhgLiBUaGUgZXhlY3V0ZS1hcGkgb3JpZ2luIGlzIHRoZXJlZm9yZVxuICogYnVpbHQgZnJvbSBgcmVzdEFwaUlkYCwgdGhlIHN0YWNrIHJlZ2lvbiBhbmQgVVJMIHN1ZmZpeCwgYW5kIHRoZSBkZXBsb3ltZW50XG4gKiBzdGFnZSdzIG9yaWdpbiBwYXRoLlxuICovXG5mdW5jdGlvbiBidWlsZFJlc3RWMU9yaWdpbihcbiAgc2NvcGU6IENvbnN0cnVjdCxcbiAgb3JpZ2luOiBhcGlndy5JUmVzdEFwaSxcbiAgcmVhY2hhYmlsaXR5OiBPcmlnaW5SZWFjaGFiaWxpdHlEZWNpc2lvbixcbik6IG9yaWdpbnMuSHR0cE9yaWdpbiB7XG4gIGNvbnN0IHN0YWNrID0gU3RhY2sub2Yoc2NvcGUpO1xuICBjb25zdCBvcmlnaW5Eb21haW5OYW1lID0gYCR7b3JpZ2luLnJlc3RBcGlJZH0uZXhlY3V0ZS1hcGkuJHtzdGFjay5yZWdpb259LiR7c3RhY2sudXJsU3VmZml4fWA7XG4gIGNvbnN0IHN0YWdlTmFtZSA9IG9yaWdpbi5kZXBsb3ltZW50U3RhZ2U/LnN0YWdlTmFtZTtcbiAgcmV0dXJuIG5ldyBvcmlnaW5zLkh0dHBPcmlnaW4ob3JpZ2luRG9tYWluTmFtZSwge1xuICAgIHByb3RvY29sUG9saWN5OiBjbG91ZGZyb250Lk9yaWdpblByb3RvY29sUG9saWN5LkhUVFBTX09OTFksXG4gICAgLi4uKHN0YWdlTmFtZSA/IHsgb3JpZ2luUGF0aDogYC8ke3N0YWdlTmFtZX1gIH0gOiB7fSksXG4gICAgLi4uKHJlYWNoYWJpbGl0eS5sb2NrSGVhZGVyTmFtZSAhPT0gdW5kZWZpbmVkICYmIHJlYWNoYWJpbGl0eS5sb2NrU2VjcmV0ICE9PSB1bmRlZmluZWRcbiAgICAgID8geyBjdXN0b21IZWFkZXJzOiB7IFtyZWFjaGFiaWxpdHkubG9ja0hlYWRlck5hbWVdOiByZWFjaGFiaWxpdHkubG9ja1NlY3JldCB9IH1cbiAgICAgIDoge30pLFxuICB9KTtcbn1cblxuLyoqXG4gKiBEZXJpdmVzIHRoZSBjb21wbGV0ZSBkZWR1cGVkLCBzb3J0ZWQgcm91dGUgc2V0IGZvciB0aGUgZWZmZWN0aXZlIHJlc291cmNlXG4gKiBwYXRocyB1c2luZyBvbmx5IHRoZSBzaGFyZWQgcm91dGUgYWxnZWJyYSAobmV2ZXIgaGFuZC13aXJlZCkuXG4gKi9cbmZ1bmN0aW9uIGRlcml2ZVJvdXRlUGF0aHMoY29uZmlndXJlZFJlc291cmNlUGF0aHM/OiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgZWZmZWN0aXZlUmVzb3VyY2VQYXRocyA9XG4gICAgY29uZmlndXJlZFJlc291cmNlUGF0aHMgIT09IHVuZGVmaW5lZCAmJiBjb25maWd1cmVkUmVzb3VyY2VQYXRocy5sZW5ndGggPiAwXG4gICAgICA/IGNvbmZpZ3VyZWRSZXNvdXJjZVBhdGhzXG4gICAgICA6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5zdXBwb3J0ZWRFbmRwb2ludFRlbXBsYXRlcygpLm1hcChcbiAgICAgICAgICAodGVtcGxhdGUpID0+IHRlbXBsYXRlLm1jcFBhdHRlcm4sXG4gICAgICAgICk7XG5cbiAgY29uc3QgZGVyaXZhdGlvbnM6IEFycmF5PChyZXNvdXJjZVBhdGg6IHN0cmluZykgPT4gc3RyaW5nPiA9IFtcbiAgICAocmVzb3VyY2VQYXRoKSA9PiByZXNvdXJjZVBhdGgsXG4gICAgKHJlc291cmNlUGF0aCkgPT5cbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5wcm90ZWN0ZWRSZXNvdXJjZVBhdGhGb3JSZXNvdXJjZVBhdGgocmVzb3VyY2VQYXRoKSxcbiAgICAocmVzb3VyY2VQYXRoKSA9PlxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKHJlc291cmNlUGF0aCksXG4gICAgKHJlc291cmNlUGF0aCkgPT5cbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uQXV0aG9yaXplUGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGgpLFxuICAgIChyZXNvdXJjZVBhdGgpID0+XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblRva2VuUGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGgpLFxuICAgIChyZXNvdXJjZVBhdGgpID0+XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblJlZ2lzdGVyUGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGgpLFxuICAgIChyZXNvdXJjZVBhdGgpID0+XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclN1ZmZpeFBhdGhGb3JSZXNvdXJjZVBhdGgocmVzb3VyY2VQYXRoKSxcbiAgXTtcblxuICBjb25zdCBkZXJpdmVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgcmVzb3VyY2VQYXRoIG9mIGVmZmVjdGl2ZVJlc291cmNlUGF0aHMpIHtcbiAgICBmb3IgKGNvbnN0IGRlcml2ZSBvZiBkZXJpdmF0aW9ucykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgZGVyaXZlZC5hZGQoZGVyaXZlKHJlc291cmNlUGF0aCkpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbjogcmVzb3VyY2VQYXRocyBlbnRyeSBcIiR7cmVzb3VyY2VQYXRofVwiIGlzIG5vdCBhIHJvdXRlIHRoZSByb3V0ZSBtb2RlbCBjYW4gZGVyaXZlOiAke2Vycm9yTWVzc2FnZShlcnJvcil9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBUaGUgdXBzdHJlYW0gT0F1dGggY2FsbGJhY2sgaXMgc3RhZ2UtZ2xvYmFsLCBzbyBpdCBpcyBkZXJpdmVkIGV4YWN0bHkgb25jZVxuICAvLyByYXRoZXIgdGhhbiBwZXIgcmVzb3VyY2UgcGF0aC4gVGhlIGNvbnRyYWN0IGRlZmF1bHQgaXMgYWx3YXlzIGRlcml2YWJsZS5cbiAgZGVyaXZlZC5hZGQoXG4gICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmNhbGxiYWNrUGF0aEZvckNvbmZpZ3VyZWRQYXRoKFxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkRFRkFVTFRfQ0FMTEJBQ0tfUEFUSCxcbiAgICApLFxuICApO1xuXG4gIHJldHVybiBBcnJheS5mcm9tKGRlcml2ZWQpLnNvcnQoKTtcbn1cblxuLyoqIFJldHVybnMgYSB0aHJvd24gdmFsdWUncyBtZXNzYWdlIHdpdGhvdXQgYXNzdW1pbmcgaXQgaXMgYW4gRXJyb3IuICovXG5mdW5jdGlvbiBlcnJvck1lc3NhZ2UoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICByZXR1cm4gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xufVxuIl19