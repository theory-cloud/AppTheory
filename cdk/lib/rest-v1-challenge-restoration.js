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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryRestV1ChallengeRestoration", version: "6.1.0" };
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
        this.distribution = new cloudfront.Distribution(this, "Distribution", {
            defaultBehavior: behaviorOptions(),
            additionalBehaviors,
            ...(props.domainNames !== undefined &&
                props.domainNames.length > 0 &&
                props.certificate !== undefined
                ? { domainNames: props.domainNames, certificate: props.certificate }
                : {}),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC12MS1jaGFsbGVuZ2UtcmVzdG9yYXRpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyZXN0LXYxLWNoYWxsZW5nZS1yZXN0b3JhdGlvbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQW9DO0FBR3BDLHVFQUF5RDtBQUN6RCw0RUFBOEQ7QUFDOUQsK0RBQWlEO0FBQ2pELDJDQUF1QztBQUV2QywyREFBK0Q7QUFDL0QsMkdBQWdIO0FBRWhILHdGQUF3RjtBQUN4RixNQUFNLGtDQUFrQyxHQUFHLHlDQUF5QyxDQUFDO0FBRXJGLGdFQUFnRTtBQUNoRSxNQUFNLGlDQUFpQyxHQUFHLHNDQUFzQyxDQUFDO0FBRWpGOzs7Ozs7R0FNRztBQUNILE1BQU0sbUJBQW1CLEdBQUcsa0NBQWtDLENBQUM7QUFFL0Q7OztHQUdHO0FBQ0gsTUFBTSxvQkFBb0IsR0FBRyxDQUFDLDJCQUEyQixFQUFFLHNCQUFzQixDQUFDLENBQUM7QUFFbkY7Ozs7O0dBS0c7QUFDSCxNQUFNLDBCQUEwQixHQUM5Qix3RkFBd0Y7SUFDeEYsdUVBQXVFLENBQUM7QUFFMUUsMkZBQTJGO0FBQzNGLE1BQU0sMEJBQTBCLEdBQUcseUJBQXlCLENBQUM7QUFFN0Q7Ozs7Ozs7R0FPRztBQUNILE1BQU0sMEJBQTBCLEdBQUcsMkJBQTJCLENBQUM7QUFFL0QsNENBQTRDO0FBQzVDLE1BQU0sK0JBQStCLEdBQUcsc0JBQXNCLENBQUM7QUFFL0Q7OztHQUdHO0FBQ0gsTUFBTSw0QkFBNEIsR0FBRyxJQUFJLEdBQUcsQ0FBQztJQUMzQyxlQUFlO0lBQ2YsWUFBWTtJQUNaLGdCQUFnQjtJQUNoQixRQUFRO0lBQ1IsTUFBTTtJQUNOLG1CQUFtQjtJQUNuQixrQkFBa0I7SUFDbEIsaUJBQWlCO0NBQ2xCLENBQUMsQ0FBQztBQUVIOzs7Ozs7OztHQVFHO0FBQ0gsSUFBWSxpQ0EyQlg7QUEzQkQsV0FBWSxpQ0FB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QUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUNoRSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgU3RhY2sgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgYXBpZ3cgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgb3JpZ2lucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2luc1wiO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEgfSBmcm9tIFwiLi9tY3Atcm91dGUtYWxnZWJyYVwiO1xuaW1wb3J0IHsgZ2VuZXJhdGVSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbkhhbmRsZXJDb2RlIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZXN0LXYxLWNoYWxsZW5nZS1yZXN0b3JhdGlvbi1oYW5kbGVyXCI7XG5cbi8qKiBNZXRhZGF0YSBrZXkgcmVjb3JkZWQgb24gdGhlIGRpc3RyaWJ1dGlvbiBmb3IgdGhlIGNoYWxsZW5nZS1yZXN0b3JhdGlvbiBjb250cmFjdC4gKi9cbmNvbnN0IENIQUxMRU5HRV9SRVNUT1JBVElPTl9NRVRBREFUQV9LRVkgPSBcImFwcHRoZW9yeTpyZXN0LXYxLWNoYWxsZW5nZS1yZXN0b3JhdGlvblwiO1xuXG4vKiogQ29udHJhY3QgaWQgcmVjb3JkZWQgaW4gdGhlIGRpc3RyaWJ1dGlvbiBtZXRhZGF0YSBtYXJrZXIuICovXG5jb25zdCBDSEFMTEVOR0VfUkVTVE9SQVRJT05fQ09OVFJBQ1RfSUQgPSBcIm0xNy5yZXN0LXYxLWNoYWxsZW5nZS1yZXN0b3JhdGlvbi92MVwiO1xuXG4vKipcbiAqIFRoZSBtYW5pZmVzdCBjb25zdGFudCBmb3IgdGhlIEFXUyBSRVNUIHYxIHJlbWFwIGFydGlmYWN0LlxuICpcbiAqIEFXUyBBUEkgR2F0ZXdheSBSRVNUIEFQSSB2MSByZW1hcHMgdGhlIG9yaWdpbidzIGBXV1ctQXV0aGVudGljYXRlYCByZXNwb25zZVxuICogaGVhZGVyIG9udG8gdGhpcyBoZWFkZXIsIHNvIGl0IGlzIHRoZSByZXN0b3JlIHNvdXJjZSB0aGF0IGRvZXMgbm90IGRlcGVuZCBvblxuICogYW55IG9wdGlvbmFsIGJyaWRnZS5cbiAqL1xuY29uc3QgUkVNQVBfU09VUkNFX0hFQURFUiA9IFwieC1hbXpuLXJlbWFwcGVkLXd3dy1hdXRoZW50aWNhdGVcIjtcblxuLyoqXG4gKiBUaGUgb3B0aW9uYWwgYWxpYXMgYnJpZGdlIHNwZWxsaW5ncywgY29uc3VsdGVkIG9ubHkgd2hlbiB0aGUgYWxpYXMgYnJpZGdlIGlzXG4gKiBlbmFibGVkLCBpbiBwcmlvcml0eSBvcmRlciBhZnRlciB0aGUgcmVtYXAgYXJ0aWZhY3QuXG4gKi9cbmNvbnN0IEFMSUFTX1NPVVJDRV9IRUFERVJTID0gW1wieC10aGVvcnktd3d3LWF1dGhlbnRpY2F0ZVwiLCBcIm1jcC13d3ctYXV0aGVudGljYXRlXCJdO1xuXG4vKipcbiAqIFRoZSBkZWZhdWx0IFJFU1QgdjEgdHJhbnNwb3J0LWZhaWx1cmUgbWVzc2FnZS5cbiAqXG4gKiBUaGUgcmVzdG9yYXRpb24gaXMgYSBkb2N1bWVudGVkIG5vLW9wIG9uIEhUVFAgQVBJIHYyLCBzbyBhIG5vbi1SRVNULXYxIG9yaWdpblxuICogZmFpbHMgc3ludGggcmF0aGVyIHRoYW4gc2lsZW50bHkgZGVncmFkaW5nLlxuICovXG5jb25zdCBOT05fUkVTVF9WMV9PUklHSU5fTUVTU0FHRSA9XG4gIFwiQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb246IG9yaWdpbiBtdXN0IGJlIGFuIEFXUyBBUEkgR2F0ZXdheSBSRVNUIEFQSSAodjEpOyBcIiArXG4gIFwidGhlIFdXVy1BdXRoZW50aWNhdGUgcmVzdG9yYXRpb24gaXMgYSBkb2N1bWVudGVkIG5vLW9wIG9uIEhUVFAgQVBJIHYyXCI7XG5cbi8qKiBUaGUgb3JpZ2luLWxvY2sgaGVhZGVyIHRoaXMgY29uc3RydWN0IGluamVjdHMgb24gYW55IHJlcXVlc3QgaXQgc2VuZHMgdG8gdGhlIG9yaWdpbi4gKi9cbmNvbnN0IERFRkFVTFRfT1JJR0lOX0xPQ0tfSEVBREVSID0gXCJ4LWFwcHRoZW9yeS1vcmlnaW4tbG9ja1wiO1xuXG4vKipcbiAqIFRoZSBvcmlnaW4tbG9jayBzZWNyZXQgYWxwaGFiZXQuXG4gKlxuICogVGhlIHZhbHVlIGlzIGEgbGl0ZXJhbCBDbG91ZEZyb250IG9yaWdpbiBjdXN0b20gaGVhZGVyIHZhbHVlIChDbG91ZEZyb250XG4gKiBjdXN0b20gb3JpZ2luIGhlYWRlcnMgY2FycnkgcGxhaW4gc3RyaW5ncywgbm90IHRlbXBsYXRlIGludHJpbnNpY3MpLCBzbyB0aGVcbiAqIHNlY3JldCBpcyByZXN0cmljdGVkIHRvIGEgaGVhZGVyLXZhbHVlLXNhZmUgYWxwaGFiZXQgd2l0aCBubyB3aGl0ZXNwYWNlIGFuZCBub1xuICogY29udHJvbCBjaGFyYWN0ZXJzLlxuICovXG5jb25zdCBPUklHSU5fTE9DS19TRUNSRVRfUEFUVEVSTiA9IC9eW0EtWmEtejAtOS5ffi1dezMyLDEyOH0kLztcblxuLyoqIFRoZSBvcmlnaW4tbG9jayBoZWFkZXIgbmFtZSBhbHBoYWJldC4gKi9cbmNvbnN0IE9SSUdJTl9MT0NLX0hFQURFUl9OQU1FX1BBVFRFUk4gPSAvXltBLVphLXowLTktXXsxLDY0fSQvO1xuXG4vKipcbiAqIEhlYWRlciBuYW1lcyBDbG91ZEZyb250IHJlc2VydmVzIG9yIHRoYXQgd291bGQgcmV3cml0ZSB0aGUgb3JpZ2luIHJlcXVlc3RcbiAqIGNvbnRyYWN0LCBzbyB0aGV5IGNhbiBuZXZlciBjYXJyeSB0aGUgb3JpZ2luIGxvY2suXG4gKi9cbmNvbnN0IFJFU0VSVkVEX09SSUdJTl9MT0NLX0hFQURFUlMgPSBuZXcgU2V0KFtcbiAgXCJhdXRob3JpemF0aW9uXCIsXG4gIFwiY29ubmVjdGlvblwiLFxuICBcImNvbnRlbnQtbGVuZ3RoXCIsXG4gIFwiY29va2llXCIsXG4gIFwiaG9zdFwiLFxuICBcInRyYW5zZmVyLWVuY29kaW5nXCIsXG4gIFwid3d3LWF1dGhlbnRpY2F0ZVwiLFxuICBcIngtZm9yd2FyZGVkLWZvclwiLFxuXSk7XG5cbi8qKlxuICogVGhlIERELTIgZGlyZWN0LW9yaWdpbiByZWFjaGFiaWxpdHkgZGVjaXNpb24gZm9yIGEgUkVTVCB2MSBvcmlnaW4uXG4gKlxuICogREQtMiAoYERFRkVOU0VfSU5fREVQVEgubWRgKSByZXF1aXJlcyB0aGUgZGVwbG95bWVudCB0byAqKnJlY29yZCoqIHdoZXRoZXIgdGhlXG4gKiBgZXhlY3V0ZS1hcGlgIGRlZmF1bHQgZW5kcG9pbnQgaXMgZGlyZWN0bHkgcmVhY2hhYmxlIGFuZCwgd2hlbiBpdCBpcywgdG8gbWFrZVxuICogdGhhdCBwb3N0dXJlIGV4cGxpY2l0LiBBIGRpcmVjdGx5IHJlYWNoYWJsZSBvcmlnaW4gKGBkaXJlY3RgKSBpcyAqKm5vdCoqXG4gKiBhbGxvd2VkOiBpdCBpcyBub3QgYSBtZW1iZXIgb2YgdGhpcyBlbnVtIGFuZCB0aGUgY29uc3RydWN0IHJlZnVzZXMgaXQgYXRcbiAqIHN5bnRoZXNpcy5cbiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5UmVzdFYxT3JpZ2luUmVhY2hhYmlsaXR5IHtcbiAgLyoqXG4gICAqIFRoZSBSRVNUIEFQSSdzIGBleGVjdXRlLWFwaWAgZGVmYXVsdCBlbmRwb2ludCBpcyBkaXNhYmxlZFxuICAgKiAoYGRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnRgKSwgc28gdGhlIEFQSSBpcyBub3QgcmVhY2hhYmxlIGF0IGl0cyBkZWZhdWx0XG4gICAqIGVuZHBvaW50LlxuICAgKlxuICAgKiBCZWNhdXNlIHRoZSBjb25zdHJ1Y3QgZnJvbnRzIGFuIGV4dGVybmFsIGBJUmVzdEFwaWAgaXQgY2Fubm90IG11dGF0ZSwgdGhlXG4gICAqIGNhbGxlciBtdXN0IGFzc2VydCB0aGUgZGlzYWJsZW1lbnQgd2l0aFxuICAgKiBgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludEFzc2VydGVkOiB0cnVlYC5cbiAgICpcbiAgICogTm90ZSB0aGUgcGxhdGZvcm0gc2hhcGU6IHRoZSBkaXNhYmxlZCBob3N0bmFtZSBpcyBleGFjdGx5IHRoZVxuICAgKiBgPHJlc3RBcGlJZD4uZXhlY3V0ZS1hcGkuPHJlZ2lvbj4uPHVybFN1ZmZpeD5gIGhvc3RuYW1lIHRoaXMgY29uc3RydWN0IHVzZXNcbiAgICogYXMgaXRzIG9yaWdpbiwgc28gYW4gYXBwIHRoYXQgZGlzYWJsZXMgdGhlIGRlZmF1bHQgZW5kcG9pbnQgbXVzdCBmcm9udCBpdHNcbiAgICogUkVTVCBBUEkgdGhyb3VnaCBhIGN1c3RvbSBkb21haW4gKEFXUyByZXF1aXJlcyBhIGN1c3RvbSBkb21haW4gb25jZSB0aGVcbiAgICogZGVmYXVsdCBlbmRwb2ludCBpcyBkaXNhYmxlZCkuIGBMT0NLRURgIGlzIHRoZSBwb3N0dXJlIGZvciBhIFJFU1QgdjEgb3JpZ2luXG4gICAqIHRoaXMgY29uc3RydWN0IGlzIGV4cGVjdGVkIHRvIHNlcnZlLlxuICAgKi9cbiAgRElTQUJMRUQgPSBcImRpc2FibGVkXCIsXG4gIC8qKlxuICAgKiBUaGUgb3JpZ2luIGlzIHJlYWNoYWJsZSBvbmx5IHRocm91Z2ggdGhpcyBjb25zdHJ1Y3QncyBDbG91ZEZyb250IGZyb250IGRvb3IuXG4gICAqXG4gICAqIFJlcXVpcmVzIGBvcmlnaW5Mb2NrYCBjYXJyeWluZyB0aGUgb3JpZ2luLWxvY2sgc2VjcmV0IHRoZSBjb25zdHJ1Y3QgaW5qZWN0c1xuICAgKiBhcyBhIGN1c3RvbSBvcmlnaW4gaGVhZGVyLCBwbHVzIHRoZSBjYWxsZXIncyBhc3NlcnRpb24gdGhhdCB0aGUgUkVTVCBBUElcbiAgICogdmVyaWZpZXMgdGhhdCBoZWFkZXIgKHRoZSBjb25zdHJ1Y3QgY2Fubm90IGF0dGFjaCBhbiBvcmlnaW4tc2lkZVxuICAgKiB2ZXJpZmljYXRpb24gdG8gYW4gZXh0ZXJuYWwgYElSZXN0QXBpYCkuXG4gICAqL1xuICBMT0NLRUQgPSBcImxvY2tlZFwiLFxufVxuXG4vKipcbiAqIFRoZSBvcmlnaW4gbG9jayBmb3IgYG9yaWdpblJlYWNoYWJpbGl0eTogTE9DS0VEYC5cbiAqXG4gKiBUaGUgY29uc3RydWN0IGluamVjdHMgYHNlY3JldGAgYXMgdGhlIGBoZWFkZXJOYW1lYCBjdXN0b20gb3JpZ2luIGhlYWRlciBvblxuICogKipldmVyeSoqIHJlcXVlc3QgaXQgc2VuZHMgdG8gdGhlIFJFU1QgdjEgb3JpZ2luLCBzbyBhbiBvcmlnaW4tc2lkZVxuICogdmVyaWZpY2F0aW9uIGNhbiByZWZ1c2UgYSByZXF1ZXN0IHRoYXQgZGlkIG5vdCBjb21lIHRocm91Z2ggdGhpc1xuICogZGlzdHJpYnV0aW9uLiBUaGUgY29uc3RydWN0IGZyb250cyBhbiBleHRlcm5hbCBgSVJlc3RBcGlgLCBzbyBpdCBjYW5ub3QgYXR0YWNoXG4gKiB0aGF0IHZlcmlmaWNhdGlvbiBpdHNlbGY6IHRoZSBjYWxsZXIgYXNzZXJ0cyBpdCB3aXRoIGBhc3NlcnRlZDogdHJ1ZWAuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdFYxT3JpZ2luTG9ja09wdGlvbnMge1xuICAvKipcbiAgICogVGhlIGxpdGVyYWwgc2VjcmV0IGluamVjdGVkIGFzIHRoZSBvcmlnaW4tbG9jayBoZWFkZXIgb24gZXZlcnkgQ2xvdWRGcm9udFxuICAgKiByZXF1ZXN0IHRvIHRoZSBvcmlnaW4uXG4gICAqXG4gICAqIDMyIHRvIDEyOCBjaGFyYWN0ZXJzIG9mIGBbQS1aYS16MC05Ll9+LV1gLiBUaGUgdmFsdWUgaXMgYSBsaXRlcmFsIENsb3VkRnJvbnRcbiAgICogb3JpZ2luIGN1c3RvbSBoZWFkZXIgdmFsdWUsIHNvIGl0IGFwcGVhcnMgdmVyYmF0aW0gaW4gdGhlIHN5bnRoZXNpemVkXG4gICAqIHRlbXBsYXRlIGFuZCBtdXN0IG5vdCBiZSAob3IgY29udGFpbikgYSBjcmVkZW50aWFsIHlvdSBjYW5ub3Qgcm90YXRlIHdpdGggdGhlXG4gICAqIFJFU1QgQVBJJ3MgdmVyaWZpY2F0aW9uLlxuICAgKi9cbiAgcmVhZG9ubHkgc2VjcmV0OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBvcmlnaW4tbG9jayBoZWFkZXIgbmFtZS5cbiAgICpcbiAgICogMSB0byA2NCBjaGFyYWN0ZXJzIG9mIGBbQS1aYS16MC05LV1gLCBhbmQgbmV2ZXIgYSBuYW1lIENsb3VkRnJvbnQgcmVzZXJ2ZXMgb3JcbiAgICogdGhhdCByZXdyaXRlcyB0aGUgb3JpZ2luIHJlcXVlc3QgY29udHJhY3QgKGBIb3N0YCwgYEF1dGhvcml6YXRpb25gLFxuICAgKiBgQ29va2llYCwgYENvbnRlbnQtTGVuZ3RoYCwgYFRyYW5zZmVyLUVuY29kaW5nYCwgYENvbm5lY3Rpb25gLFxuICAgKiBgV1dXLUF1dGhlbnRpY2F0ZWAsIGBYLUZvcndhcmRlZC1Gb3JgLCBvciBhbnkgYHgtYW16LSpgLCBgeC1hbXpuLSpgLCBvclxuICAgKiBgY2xvdWRmcm9udC0qYCBuYW1lKS5cbiAgICpcbiAgICogQGRlZmF1bHQgXCJ4LWFwcHRoZW9yeS1vcmlnaW4tbG9ja1wiXG4gICAqL1xuICByZWFkb25seSBoZWFkZXJOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgY2FsbGVyJ3MgYXNzZXJ0aW9uIHRoYXQgdGhlIFJFU1QgQVBJIHZlcmlmaWVzIHRoZSBvcmlnaW4gbG9jay5cbiAgICpcbiAgICogVGhpcyBjb25zdHJ1Y3QgY2Fubm90IGF0dGFjaCBhIHJlc291cmNlIHBvbGljeSwgYXV0aG9yaXplciwgb3IgYW55IG90aGVyXG4gICAqIG9yaWdpbi1zaWRlIHZlcmlmaWNhdGlvbiB0byBhbiBleHRlcm5hbCBgSVJlc3RBcGlgIGl0IGRvZXMgbm90IG93biwgc28gaXRcbiAgICogcmVmdXNlcyB0byBzeW50aGVzaXplIHVudGlsIHRoZSBjYWxsZXIgcmVjb3JkcyB0aGF0IHRoZSB2ZXJpZmljYXRpb24gZXhpc3RzXG4gICAqIGFuZCByZXF1aXJlcyB0aGUgaW5qZWN0ZWQgaGVhZGVyLiBNdXN0IGJlIGB0cnVlYC5cbiAgICovXG4gIHJlYWRvbmx5IGFzc2VydGVkOiBib29sZWFuO1xufVxuXG4vKipcbiAqIE9wdGlvbnMgZm9yIHRoZSBvcHRpb25hbCBjaGFsbGVuZ2UgYWxpYXMgYnJpZGdlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUNoYWxsZW5nZUFsaWFzQnJpZGdlT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBFbmFibGVzIHRoZSBvcHRpb25hbCBjaGFsbGVuZ2UgYWxpYXMgYnJpZGdlLlxuICAgKlxuICAgKiBXaGVuIGVuYWJsZWQgdGhlIHJlc3RvcmF0aW9uIGNvbnN1bHRzIHRoZSBicmlkZ2UgYWxpYXNlc1xuICAgKiAoYHgtdGhlb3J5LXd3dy1hdXRoZW50aWNhdGVgLCB0aGVuIGBtY3Atd3d3LWF1dGhlbnRpY2F0ZWApIGFmdGVyIHRoZSBBV1NcbiAgICogUkVTVCB2MSByZW1hcCBhcnRpZmFjdC4gV2hlbiBkaXNhYmxlZCBvbmx5IHRoZSByZW1hcCBhcnRpZmFjdCBpcyBjb25zdWx0ZWRcbiAgICogYW5kIHRoZSBhbGlhcyBzcGVsbGluZ3MgbmV2ZXIgYXBwZWFyIGluIHRoZSBkZXBsb3llZCBmdW5jdGlvbiBzb3VyY2UuXG4gICAqXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBlbmFibGVkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBQcm9wZXJ0aWVzIGZvciBgQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb25gLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uUHJvcHMge1xuICAvKipcbiAgICogVGhlIFJFU1QgQVBJIHYxIG9yaWdpbiB3aG9zZSBgV1dXLUF1dGhlbnRpY2F0ZWAgcmVzcG9uc2VzIG11c3QgYmUgcmVzdG9yZWQuXG4gICAqXG4gICAqIE9ubHkgYW4gQVdTIEFQSSBHYXRld2F5IFJFU1QgQVBJIHYxIChhIG5vbi1lbXB0eSBgcmVzdEFwaUlkYCBhbmQgYSBub24tZW1wdHlcbiAgICogYHJlc3RBcGlSb290UmVzb3VyY2VJZGApIGlzIGFjY2VwdGVkOyB0aGUgcmVzdG9yYXRpb24gaXMgYSBkb2N1bWVudGVkIG5vLW9wXG4gICAqIG9uIEhUVFAgQVBJIHYyLlxuICAgKi9cbiAgcmVhZG9ubHkgb3JpZ2luOiBhcGlndy5JUmVzdEFwaTtcblxuICAvKipcbiAgICogVGhlIG1hbmRhdG9yeSBERC0yIGRpcmVjdC1vcmlnaW4gcmVhY2hhYmlsaXR5IGRlY2lzaW9uLlxuICAgKlxuICAgKiBSZXF1aXJlZC4gYERJU0FCTEVEYCBhbmQgYExPQ0tFRGAgc3ludGhlc2l6ZTsgYW55dGhpbmcgZWxzZSDigJQgaW4gcGFydGljdWxhciBhXG4gICAqIGRpcmVjdGx5IHJlYWNoYWJsZSBvcmlnaW4g4oCUIGZhaWxzIHN5bnRoZXNpcyB3aXRoIGFuIGVycm9yIHRoYXQgbmFtZXMgdGhlXG4gICAqIHJlamVjdGVkIGRlY2lzaW9uLlxuICAgKi9cbiAgcmVhZG9ubHkgb3JpZ2luUmVhY2hhYmlsaXR5OiBBcHBUaGVvcnlSZXN0VjFPcmlnaW5SZWFjaGFiaWxpdHk7XG5cbiAgLyoqXG4gICAqIFRoZSBjYWxsZXIncyBhc3NlcnRpb24gdGhhdCB0aGUgUkVTVCBBUEkncyBgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludGAgaXNcbiAgICogc2V0LCByZXF1aXJlZCB3aXRoIGBvcmlnaW5SZWFjaGFiaWxpdHk6IERJU0FCTEVEYC5cbiAgICpcbiAgICogVGhpcyBjb25zdHJ1Y3QgZnJvbnRzIGFuIGV4dGVybmFsIGBJUmVzdEFwaWAgaXQgY2Fubm90IG11dGF0ZSwgc28gaXQgY2Fubm90XG4gICAqIHNldCB0aGUgcHJvcGVydHkgZm9yIHRoZSBjYWxsZXI7IGl0IHJlcXVpcmVzIHRoZSBhc3NlcnRpb24gaW5zdGVhZCBhbmRcbiAgICogcmVjb3JkcyBpdCBpbiB0aGUgZGlzdHJpYnV0aW9uIG1ldGFkYXRhLlxuICAgKi9cbiAgcmVhZG9ubHkgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludEFzc2VydGVkPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogVGhlIG1hbmRhdG9yeSBvcmlnaW4gbG9jaywgcmVxdWlyZWQgd2l0aCBgb3JpZ2luUmVhY2hhYmlsaXR5OiBMT0NLRURgLlxuICAgKi9cbiAgcmVhZG9ubHkgb3JpZ2luTG9jaz86IEFwcFRoZW9yeVJlc3RWMU9yaWdpbkxvY2tPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBNQ1AgcmVzb3VyY2UgcGF0aHMgd2hvc2UgZGVyaXZlZCByb3V0ZXMgcmVjZWl2ZSBhbiBleHBsaWNpdCBvcmRlcmVkIGNhY2hlXG4gICAqIGJlaGF2aW9yLlxuICAgKlxuICAgKiBUaGUgZWZmZWN0aXZlIHJvdXRlIHNldCBpcyBkZXJpdmVkIGZyb20gdGhlIHNoYXJlZCByb3V0ZSBhbGdlYnJhLCBuZXZlclxuICAgKiBoYW5kLXdpcmVkLiBBIHN1cHBsaWVkLWJ1dC1lbXB0eSBhcnJheSBpcyB0cmVhdGVkIGFzIHRoZSBkZWZhdWx0LlxuICAgKlxuICAgKiBAZGVmYXVsdCB0aGUgc3RhbmRhcmQgTUNQIHBhdHRlcm5zIGZyb20gdGhlIHNoYXJlZCByb3V0ZSBhbGdlYnJhXG4gICAqIChgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnN1cHBvcnRlZEVuZHBvaW50VGVtcGxhdGVzKCkubWNwUGF0dGVybmApXG4gICAqL1xuICByZWFkb25seSByZXNvdXJjZVBhdGhzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIGNoYWxsZW5nZSBhbGlhcyBicmlkZ2UuXG4gICAqXG4gICAqIEBkZWZhdWx0IGRpc2FibGVkXG4gICAqL1xuICByZWFkb25seSBhbGlhc0JyaWRnZT86IEFwcFRoZW9yeUNoYWxsZW5nZUFsaWFzQnJpZGdlT3B0aW9ucztcblxuICAvKipcbiAgICogT3B0aW9uYWwgY3VzdG9tIGRvbWFpbiBuYW1lcyBmb3IgdGhlIGRpc3RyaWJ1dGlvbi5cbiAgICpcbiAgICogV2hlbiBzZXQsIGBjZXJ0aWZpY2F0ZWAgaXMgcmVxdWlyZWQuXG4gICAqL1xuICByZWFkb25seSBkb21haW5OYW1lcz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBDZXJ0aWZpY2F0ZSBmb3IgYGRvbWFpbk5hbWVzYC4gUmVxdWlyZWQgd2hlbiBgZG9tYWluTmFtZXNgIGlzIHNldC5cbiAgICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAvKipcbiAgICogT3B0aW9uYWwgQ2xvdWRGcm9udCBwcmljZSBjbGFzcy5cbiAgICovXG4gIHJlYWRvbmx5IHByaWNlQ2xhc3M/OiBjbG91ZGZyb250LlByaWNlQ2xhc3M7XG59XG5cbi8qKlxuICogQSBmcmFtZXdvcmsgQ2xvdWRGcm9udCBmcm9udCBkb29yIHRoYXQgcmVzdG9yZXMgdGhlIGNhbm9uaWNhbFxuICogYFdXVy1BdXRoZW50aWNhdGVgIGNoYWxsZW5nZSBmb3IgYW4gQVdTIEFQSSBHYXRld2F5IFJFU1QgQVBJIHYxIG9yaWdpbi5cbiAqXG4gKiBBV1MgUkVTVCBBUEkgdjEgcmVtYXBzIHRoZSBvcmlnaW4ncyBgV1dXLUF1dGhlbnRpY2F0ZWAgcmVzcG9uc2UgaGVhZGVyIG9udG9cbiAqIGB4LWFtem4tcmVtYXBwZWQtd3d3LWF1dGhlbnRpY2F0ZWAsIHNvIGEgY2Fub25pY2FsLW9ubHkgYXBwIGxvc2VzIHRoZVxuICogY2hhbGxlbmdlIGF0IHRoZSBlZGdlLiBUaGlzIGNvbnN0cnVjdCBmcm9udHMgdGhlIFJFU1QgdjEgYGV4ZWN1dGUtYXBpYCBvcmlnaW5cbiAqIHdpdGggYSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbiB3aG9zZSBvcmlnaW4tcmVzcG9uc2UgTGFtYmRhQEVkZ2UgZnVuY3Rpb25cbiAqIGNvcGllcyB0aGUgZmlyc3QgcHJlc2VudCBzb3VyY2UgYmFjayBvbnRvIGBXV1ctQXV0aGVudGljYXRlYCBhbmQgcmVtb3ZlcyB0aGVcbiAqIGNvbnN1bWVkIHNvdXJjZSBoZWFkZXJzLlxuICpcbiAqIFRoZSByZXN0b3JlICoqc291cmNlIHNldCoqLCBpbiBwcmlvcml0eSBvcmRlciwgaXM6XG4gKlxuICogMS4gYHgtYW16bi1yZW1hcHBlZC13d3ctYXV0aGVudGljYXRlYCDigJQgdGhlIGFydGlmYWN0IEFXUyBpdHNlbGYgcHJvZHVjZXMgd2hlblxuICogICAgUkVTVCB2MSByZW1hcHMgdGhlIG9yaWdpbiBoZWFkZXIuIEFsd2F5cyBjb25zdWx0ZWQuXG4gKiAyLiB0aGUgYnJpZGdlIGFsaWFzZXMgYHgtdGhlb3J5LXd3dy1hdXRoZW50aWNhdGVgLCB0aGVuXG4gKiAgICBgbWNwLXd3dy1hdXRoZW50aWNhdGVgIOKAlCBjb25zdWx0ZWQgb25seSB3aGVuIHRoZSBvcHRpb25hbCBhbGlhcyBicmlkZ2UgaXNcbiAqICAgIGVuYWJsZWQgKG9mZiBieSBkZWZhdWx0KS5cbiAqXG4gKiAjIyBUaGUgZGlyZWN0LWVuZHBvaW50IGNhdmVhdCAoREQtMilcbiAqXG4gKiBBIENsb3VkRnJvbnQgZnJvbnQgZG9vciBkb2VzICoqbm90KiogYnkgaXRzZWxmIG1ha2UgdGhlIG9yaWdpbiB1bnJlYWNoYWJsZS5cbiAqIFRoZSBSRVNUIEFQSSBrZWVwcyBhbnN3ZXJpbmcgYXQgaXRzIG93blxuICogYDxyZXN0QXBpSWQ+LmV4ZWN1dGUtYXBpLjxyZWdpb24+Ljx1cmxTdWZmaXg+YCBlbmRwb2ludCwgd2hpY2ggaXMgZXhhY3RseSB0aGVcbiAqIG9yaWdpbiB0aGlzIGRpc3RyaWJ1dGlvbiB1c2VzLCBzbyBhIGNsaWVudCB0aGF0IHNraXBzIHRoZSBkaXN0cmlidXRpb24gc3RpbGxcbiAqIHJlYWNoZXMgdGhlIG9yaWdpbiBhbmQgb2JzZXJ2ZXMgYSAqKmNoYWxsZW5nZS1sZXNzIGA0MDFgKiogZm9yIGEgUkVTVCB2MVxuICogY2Fub25pY2FsLW9ubHkgYXBwIOKAlCB0aGUgcmVzdG9yYXRpb24gbmV2ZXIgcnVucywgYW5kIGFueSBlZGdlLW9ubHkgY29udHJvbFxuICogKHRocm90dGxpbmcgYXQgdGhlIGVkZ2UsIGVkZ2Ugb2JzZXJ2YWJpbGl0eSwgdGhlIGFsaWFzIGJyaWRnZSkgaXMgYnlwYXNzZWQgb25cbiAqIHRoYXQgcGF0aC4gQXV0aGVudGljYXRpb24gaXRzZWxmIGlzIHVuYWZmZWN0ZWQ6IHRoZSBydW50aW1lIGJlYXJlciBnYXRlIHN0aWxsXG4gKiByZWZ1c2VzIHRoZSByZXF1ZXN0IGF0IHRoZSBvcmlnaW4sIHNvIHRoaXMgaXMgY2hhbGxlbmdlIGxvc3MgYW5kIGVkZ2UgYnlwYXNzLFxuICogbm90IGFuIGF1dGhlbnRpY2F0aW9uIGJ5cGFzcy5cbiAqXG4gKiBgb3JpZ2luUmVhY2hhYmlsaXR5YCBpcyB0aGVyZWZvcmUgKipyZXF1aXJlZCoqIChERC0yJ3MgbWFuZGF0b3J5XG4gKiBkaXJlY3Qtb3JpZ2luIGRlY2lzaW9uKTpcbiAqXG4gKiAtIGBESVNBQkxFRGAg4oCUIHRoZSBSRVNUIEFQSSdzIGBleGVjdXRlLWFwaWAgZGVmYXVsdCBlbmRwb2ludCBpcyBkaXNhYmxlZC4gVGhlXG4gKiAgIGNhbGxlciBhc3NlcnRzIGl0IChgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludEFzc2VydGVkOiB0cnVlYCkgYmVjYXVzZSB0aGlzXG4gKiAgIGNvbnN0cnVjdCBjYW5ub3QgbXV0YXRlIGFuIGV4dGVybmFsIGBJUmVzdEFwaWAuIFRoZSBjb25zdHJ1Y3QgZG9lcyBub3RcbiAqICAgdmVyaWZ5IHRoZSBhc3NlcnRpb24sIGFuZCB0aGUgZGlzYWJsZWQgaG9zdG5hbWUgaXMgdGhlIGRpc3RyaWJ1dGlvbidzIG93blxuICogICBvcmlnaW4gaG9zdG5hbWUsIHNvIGFuIGFwcCB0aGF0IGRpc2FibGVzIHRoZSBkZWZhdWx0IGVuZHBvaW50IG11c3QgZnJvbnQgdGhlXG4gKiAgIG9yaWdpbiB0aHJvdWdoIGEgY3VzdG9tIGRvbWFpbi5cbiAqIC0gYExPQ0tFRGAg4oCUIHRoZSBvcmlnaW4gaXMgcmVhY2hhYmxlIG9ubHkgdGhyb3VnaCB0aGlzIGRpc3RyaWJ1dGlvbi4gVGhlXG4gKiAgIGNvbnN0cnVjdCBpbmplY3RzIGBvcmlnaW5Mb2NrLnNlY3JldGAgYXMgYSBjdXN0b20gb3JpZ2luIGhlYWRlciBvbiBldmVyeVxuICogICByZXF1ZXN0IHRvIHRoZSBvcmlnaW4sIGFuZCB0aGUgY2FsbGVyIGFzc2VydHNcbiAqICAgKGBvcmlnaW5Mb2NrLmFzc2VydGVkOiB0cnVlYCkgdGhhdCB0aGUgUkVTVCBBUEkgdmVyaWZpZXMgdGhhdCBoZWFkZXI7IHRoZVxuICogICBjb25zdHJ1Y3QgY2Fubm90IGF0dGFjaCB0aGUgdmVyaWZpY2F0aW9uIHRvIGFuIGV4dGVybmFsIGBJUmVzdEFwaWAuXG4gKlxuICogQSBkaXJlY3RseSByZWFjaGFibGUgb3JpZ2luIChgZGlyZWN0YCkgaXMgcmVmdXNlZCBhdCBzeW50aGVzaXMuIFRoZSBkZWNpc2lvblxuICogaXMgcmVjb3JkZWQgaW4gdGhlIGRpc3RyaWJ1dGlvbidzIENsb3VkRm9ybWF0aW9uIG1ldGFkYXRhXG4gKiAoYGFwcHRoZW9yeTpyZXN0LXYxLWNoYWxsZW5nZS1yZXN0b3JhdGlvbmApLCBzbyB0aGUgcG9zdHVyZSBpcyBhdWRpdGFibGUgZnJvbVxuICogdGhlIHN5bnRoZXNpemVkIHRlbXBsYXRlLlxuICpcbiAqIFRoZSBkZXJpdmVkIHJvdXRlIHNldCBhbmQgdGhlIGV4cGxpY2l0IG9yZGVyZWQgY2FjaGUgYmVoYXZpb3JzIGNvbWUgZnJvbSB0aGVcbiAqIHNoYXJlZCByb3V0ZSBhbGdlYnJhIChgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhYCksIHNvIHRoZSBjb25zdHJ1Y3QgaXMgbmV2ZXJcbiAqIGhhbmQtd2lyZWQuIFBhcmFtZXRlcml6ZWQgZGVyaXZlZCByb3V0ZXMgKHRob3NlIGNhcnJ5aW5nIGEgYHtwYXJhbWV0ZXJ9YFxuICogc2VnbWVudCkgY2Fubm90IGJlIGV4cHJlc3NlZCBhcyBDbG91ZEZyb250IHBhdGggcGF0dGVybnMgYW5kIGFyZSB0aGVyZWZvcmVcbiAqIGNvdmVyZWQgYnkgdGhlIGRpc3RyaWJ1dGlvbidzIGRlZmF1bHQgYmVoYXZpb3IuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbiBleHRlbmRzIENvbnN0cnVjdCB7XG4gIC8qKiBUaGUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gZnJvbnRpbmcgdGhlIFJFU1QgdjEgb3JpZ2luLiAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZGlzdHJpYnV0aW9uOiBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbjtcblxuICAvKipcbiAgICogVGhlIHJlc3BvbnNlIGhlYWRlcnMgdGhlIHJlc3RvcmF0aW9uIGZ1bmN0aW9uIGNvbnN1bHRzLCBpbiBwcmlvcml0eSBvcmRlci5cbiAgICpcbiAgICogYFtcIngtYW16bi1yZW1hcHBlZC13d3ctYXV0aGVudGljYXRlXCJdYCB3aGVuIHRoZSBhbGlhcyBicmlkZ2UgaXMgZGlzYWJsZWQ7XG4gICAqIGBbXCJ4LWFtem4tcmVtYXBwZWQtd3d3LWF1dGhlbnRpY2F0ZVwiLCBcIngtdGhlb3J5LXd3dy1hdXRoZW50aWNhdGVcIixcbiAgICogXCJtY3Atd3d3LWF1dGhlbnRpY2F0ZVwiXWAgd2hlbiBpdCBpcyBlbmFibGVkLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHJlc3RvcmVTb3VyY2VIZWFkZXJzOiBzdHJpbmdbXTtcblxuICAvKiogVHJ1ZSB3aGVuIHRoZSBvcHRpb25hbCBhbGlhcyBicmlkZ2UgaXMgZW5hYmxlZC4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGFsaWFzQnJpZGdlRW5hYmxlZDogYm9vbGVhbjtcblxuICAvKiogVGhlIHJlY29yZGVkIERELTIgZGlyZWN0LW9yaWdpbiByZWFjaGFiaWxpdHkgZGVjaXNpb24uICovXG4gIHB1YmxpYyByZWFkb25seSBvcmlnaW5SZWFjaGFiaWxpdHk6IEFwcFRoZW9yeVJlc3RWMU9yaWdpblJlYWNoYWJpbGl0eTtcblxuICAvKipcbiAgICogVGhlIG9yaWdpbi1sb2NrIGhlYWRlciBuYW1lIGluamVjdGVkIG9uIGV2ZXJ5IHJlcXVlc3QgdG8gdGhlIG9yaWdpbiwgb3JcbiAgICogYHVuZGVmaW5lZGAgd2hlbiB0aGUgZGVjaXNpb24gaXMgYERJU0FCTEVEYC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBvcmlnaW5Mb2NrSGVhZGVyTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGNvbXBsZXRlIHJvdXRlIHNldCBkZXJpdmVkIGZyb20gdGhlIHNoYXJlZCByb3V0ZSBhbGdlYnJhIChwYXJhbWV0ZXJpemVkXG4gICAqIHJvdXRlcyBpbmNsdWRlZCksIGRlZHVwZWQgYW5kIGluIGRldGVybWluaXN0aWMgc29ydGVkIG9yZGVyLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGRlcml2ZWRSb3V0ZVBhdGhzOiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogVGhlIHN1YnNldCBvZiBgZGVyaXZlZFJvdXRlUGF0aHNgIGVtaXR0ZWQgYXMgZXhwbGljaXQgb3JkZXJlZCBjYWNoZVxuICAgKiBiZWhhdmlvcnMgKHRoZSBsaXRlcmFsIHBhdGhzLCB3aXRoIG5vIGB7cGFyYW1ldGVyfWAgc2VnbWVudCkuXG4gICAqXG4gICAqIENsb3VkRnJvbnQgcGF0aCBwYXR0ZXJucyBjYW5ub3QgZXhwcmVzcyBhIGB7cGFyYW19YCBzZWdtZW50LCBzb1xuICAgKiBwYXJhbWV0ZXJpemVkIGRlcml2ZWQgcm91dGVzIGFyZSBjb3ZlcmVkIGJ5IHRoZSBkZWZhdWx0IGJlaGF2aW9yLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGJlaGF2aW9yUGF0aFBhdHRlcm5zOiBzdHJpbmdbXTtcblxuICBwdWJsaWMgY29uc3RydWN0b3IoXG4gICAgc2NvcGU6IENvbnN0cnVjdCxcbiAgICBpZDogc3RyaW5nLFxuICAgIHByb3BzOiBBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvblByb3BzLFxuICApIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3Qgb3JpZ2luID0gKHByb3BzIGFzIHsgb3JpZ2luPzogYXBpZ3cuSVJlc3RBcGkgfSkub3JpZ2luO1xuICAgIGFzc2VydFJlc3RWMU9yaWdpbihvcmlnaW4pO1xuXG4gICAgY29uc3QgcmVhY2hhYmlsaXR5ID0gcmVzb2x2ZU9yaWdpblJlYWNoYWJpbGl0eShwcm9wcyk7XG4gICAgdGhpcy5vcmlnaW5SZWFjaGFiaWxpdHkgPSByZWFjaGFiaWxpdHkuZGVjaXNpb247XG4gICAgdGhpcy5vcmlnaW5Mb2NrSGVhZGVyTmFtZSA9IHJlYWNoYWJpbGl0eS5sb2NrSGVhZGVyTmFtZTtcblxuICAgIGlmIChcbiAgICAgIHByb3BzLmRvbWFpbk5hbWVzICE9PSB1bmRlZmluZWQgJiZcbiAgICAgIHByb3BzLmRvbWFpbk5hbWVzLmxlbmd0aCA+IDAgJiZcbiAgICAgIHByb3BzLmNlcnRpZmljYXRlID09PSB1bmRlZmluZWRcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbjogZG9tYWluTmFtZXMgcmVxdWlyZXMgY2VydGlmaWNhdGVcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgdGhpcy5hbGlhc0JyaWRnZUVuYWJsZWQgPSBwcm9wcy5hbGlhc0JyaWRnZT8uZW5hYmxlZCA9PT0gdHJ1ZTtcbiAgICB0aGlzLnJlc3RvcmVTb3VyY2VIZWFkZXJzID0gdGhpcy5hbGlhc0JyaWRnZUVuYWJsZWRcbiAgICAgID8gW1JFTUFQX1NPVVJDRV9IRUFERVIsIC4uLkFMSUFTX1NPVVJDRV9IRUFERVJTXVxuICAgICAgOiBbUkVNQVBfU09VUkNFX0hFQURFUl07XG5cbiAgICBjb25zdCBkZXJpdmVkUm91dGVQYXRocyA9IGRlcml2ZVJvdXRlUGF0aHMocHJvcHMucmVzb3VyY2VQYXRocyk7XG4gICAgaWYgKGRlcml2ZWRSb3V0ZVBhdGhzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uOiB0aGUgcm91dGUgbW9kZWwgZGVyaXZlZCBubyByb3V0ZXMgZnJvbSByZXNvdXJjZVBhdGhzXCIsXG4gICAgICApO1xuICAgIH1cbiAgICB0aGlzLmRlcml2ZWRSb3V0ZVBhdGhzID0gZGVyaXZlZFJvdXRlUGF0aHM7XG4gICAgdGhpcy5iZWhhdmlvclBhdGhQYXR0ZXJucyA9IGRlcml2ZWRSb3V0ZVBhdGhzLmZpbHRlcihcbiAgICAgIChwYXRoUGF0dGVybikgPT4gIXBhdGhQYXR0ZXJuLmluY2x1ZGVzKFwie1wiKSAmJiAhcGF0aFBhdHRlcm4uaW5jbHVkZXMoXCJ9XCIpLFxuICAgICk7XG5cbiAgICBjb25zdCByZXN0T3JpZ2luID0gYnVpbGRSZXN0VjFPcmlnaW4odGhpcywgb3JpZ2luLCByZWFjaGFiaWxpdHkpO1xuXG4gICAgY29uc3QgcmVzdG9yYXRpb25GdW5jdGlvbiA9IG5ldyBjbG91ZGZyb250LmV4cGVyaW1lbnRhbC5FZGdlRnVuY3Rpb24oXG4gICAgICB0aGlzLFxuICAgICAgXCJDaGFsbGVuZ2VSZXN0b3JhdGlvbkZ1bmN0aW9uXCIsXG4gICAgICB7XG4gICAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18yMl9YLFxuICAgICAgICBoYW5kbGVyOiBcImluZGV4LmhhbmRsZXJcIixcbiAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUlubGluZShcbiAgICAgICAgICBnZW5lcmF0ZVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uSGFuZGxlckNvZGUodGhpcy5yZXN0b3JlU291cmNlSGVhZGVycyksXG4gICAgICAgICksXG4gICAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAgIFwiUmVzdG9yZSB0aGUgY2Fub25pY2FsIFdXVy1BdXRoZW50aWNhdGUgY2hhbGxlbmdlIGZvciBBcHBUaGVvcnkgUkVTVCB2MSBvcmlnaW4gcmVzcG9uc2VzXCIsXG4gICAgICB9LFxuICAgICk7XG5cbiAgICAvLyBDREsncyBPcmlnaW5SZXF1ZXN0SGVhZGVyQmVoYXZpb3IgaGFzIG5vIGBhbGxWaWV3ZXJFeGNlcHRIb3N0SGVhZGVyYFxuICAgIC8vIGJ1aWxkZXIgYW5kIHJlZnVzZXMgYEF1dGhvcml6YXRpb25gIGluIGFuIGFsbG93IGxpc3QsIHNvIHRoZSBtYW5hZ2VkXG4gICAgLy8gQUxMX1ZJRVdFUl9FWENFUFRfSE9TVF9IRUFERVIgcG9saWN5IGlzIGV4cHJlc3NlZCB0aGUgd2F5IEFXUyBpbXBsZW1lbnRzXG4gICAgLy8gaXQ6IGBhbGxFeGNlcHRgIHdpdGggb25seSBgSG9zdGAgZGVuaWVkLiBFdmVyeSB2aWV3ZXIgaGVhZGVyICh0aGVcbiAgICAvLyBgQXV0aG9yaXphdGlvbmAgaGVhZGVyIGFib3ZlIGFsbCkgaXMgZm9yd2FyZGVkLCBhbmQgQ2xvdWRGcm9udCBzdGlsbFxuICAgIC8vIHByZXNlbnRzIHRoZSBleGVjdXRlLWFwaSBvcmlnaW4gaG9zdC5cbiAgICAvL1xuICAgIC8vIFVuZGVyIExPQ0tFRCB0aGUgb3JpZ2luLWxvY2sgaGVhZGVyIGlzIGRlbmllZCB0byB0aGUgdmlld2VyIGFzIHdlbGwsIHNvIGFcbiAgICAvLyB2aWV3ZXItc3VwcGxpZWQgY29weSBvZiB0aGUgbG9jayBoZWFkZXIgaXMgc3RyaXBwZWQgYXQgdGhlIGVkZ2UgYW5kIHRoZVxuICAgIC8vIENsb3VkRnJvbnQtaW5qZWN0ZWQgb3JpZ2luIGN1c3RvbSBoZWFkZXIgaXMgdGhlIG9ubHkgY29weSB0aGF0IHJlYWNoZXMgdGhlXG4gICAgLy8gb3JpZ2luIHRocm91Z2ggdGhpcyBkaXN0cmlidXRpb24uXG4gICAgLy9cbiAgICAvLyBBbGwgY29va2llcyBhbmQgYWxsIHF1ZXJ5IHN0cmluZ3MgYXJlIGZvcndhcmRlZCBhcyB3ZWxsLCBleGFjdGx5IGFzIHRoZVxuICAgIC8vIG1hbmFnZWQgcG9saWN5IGRvZXM6IHRoZSBkZXJpdmVkIE9BdXRoIHJvdXRlcyBjYXJyeSB0aGVpciBwYXJhbWV0ZXJzIGluXG4gICAgLy8gdGhlIHF1ZXJ5IHN0cmluZyAodGhlIHBlci1raW5kIGAuLi4vYXV0aG9yaXplYCByb3V0ZSBhbmQgdGhlIGNhbGxiYWNrJ3NcbiAgICAvLyBgP2NvZGU9Li4uJnN0YXRlPS4uLmApLCBzbyBkcm9wcGluZyB0aGUgcXVlcnkgc3RyaW5nIHdvdWxkIGJyZWFrIHRoZVxuICAgIC8vIGZyb250IGNoYW5uZWwsIGFuZCBhIGNvb2tpZS1jYXJyaWVkIHNlc3Npb24gbXVzdCByZWFjaCB0aGUgb3JpZ2luXG4gICAgLy8gdW5jaGFuZ2VkLlxuICAgIGNvbnN0IGRlbmllZFZpZXdlckhlYWRlcnMgPSBbXG4gICAgICBcIkhvc3RcIixcbiAgICAgIC4uLih0aGlzLm9yaWdpbkxvY2tIZWFkZXJOYW1lICE9PSB1bmRlZmluZWQgPyBbdGhpcy5vcmlnaW5Mb2NrSGVhZGVyTmFtZV0gOiBbXSksXG4gICAgXTtcbiAgICBjb25zdCBvcmlnaW5SZXF1ZXN0UG9saWN5ID0gbmV3IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeShcbiAgICAgIHRoaXMsXG4gICAgICBcIk9yaWdpblJlcXVlc3RQb2xpY3lcIixcbiAgICAgIHtcbiAgICAgICAgY29tbWVudDpcbiAgICAgICAgICBcIkFwcFRoZW9yeSBSRVNUIHYxIGNoYWxsZW5nZSByZXN0b3JhdGlvbjogZm9yd2FyZCBhbGwgdmlld2VyIGhlYWRlcnMgZXhjZXB0IEhvc3QgYW5kIGFueSBvcmlnaW4tbG9jayBoZWFkZXIsIGFsbCBjb29raWVzIGFuZCBhbGwgcXVlcnkgc3RyaW5nc1wiLFxuICAgICAgICBoZWFkZXJCZWhhdmlvcjpcbiAgICAgICAgICBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5kZW55TGlzdCguLi5kZW5pZWRWaWV3ZXJIZWFkZXJzKSxcbiAgICAgICAgY29va2llQmVoYXZpb3I6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdENvb2tpZUJlaGF2aW9yLmFsbCgpLFxuICAgICAgICBxdWVyeVN0cmluZ0JlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RRdWVyeVN0cmluZ0JlaGF2aW9yLmFsbCgpLFxuICAgICAgfSxcbiAgICApO1xuXG4gICAgY29uc3QgZWRnZUxhbWJkYXM6IGNsb3VkZnJvbnQuRWRnZUxhbWJkYVtdID0gW1xuICAgICAge1xuICAgICAgICBldmVudFR5cGU6IGNsb3VkZnJvbnQuTGFtYmRhRWRnZUV2ZW50VHlwZS5PUklHSU5fUkVTUE9OU0UsXG4gICAgICAgIGZ1bmN0aW9uVmVyc2lvbjogcmVzdG9yYXRpb25GdW5jdGlvbi5jdXJyZW50VmVyc2lvbixcbiAgICAgIH0sXG4gICAgXTtcbiAgICBjb25zdCBiZWhhdmlvck9wdGlvbnMgPSAoKTogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPT4gKHtcbiAgICAgIG9yaWdpbjogcmVzdE9yaWdpbixcbiAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTCxcbiAgICAgIGNhY2hlUG9saWN5OiBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRUQsXG4gICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICBlZGdlTGFtYmRhcyxcbiAgICB9KTtcblxuICAgIGNvbnN0IGFkZGl0aW9uYWxCZWhhdmlvcnM6IFJlY29yZDxzdHJpbmcsIGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zPiA9IHt9O1xuICAgIGZvciAoY29uc3QgcGF0aFBhdHRlcm4gb2YgdGhpcy5iZWhhdmlvclBhdGhQYXR0ZXJucykge1xuICAgICAgYWRkaXRpb25hbEJlaGF2aW9yc1twYXRoUGF0dGVybl0gPSBiZWhhdmlvck9wdGlvbnMoKTtcbiAgICB9XG5cbiAgICB0aGlzLmRpc3RyaWJ1dGlvbiA9IG5ldyBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbih0aGlzLCBcIkRpc3RyaWJ1dGlvblwiLCB7XG4gICAgICBkZWZhdWx0QmVoYXZpb3I6IGJlaGF2aW9yT3B0aW9ucygpLFxuICAgICAgYWRkaXRpb25hbEJlaGF2aW9ycyxcbiAgICAgIC4uLihwcm9wcy5kb21haW5OYW1lcyAhPT0gdW5kZWZpbmVkICYmXG4gICAgICBwcm9wcy5kb21haW5OYW1lcy5sZW5ndGggPiAwICYmXG4gICAgICBwcm9wcy5jZXJ0aWZpY2F0ZSAhPT0gdW5kZWZpbmVkXG4gICAgICAgID8geyBkb21haW5OYW1lczogcHJvcHMuZG9tYWluTmFtZXMsIGNlcnRpZmljYXRlOiBwcm9wcy5jZXJ0aWZpY2F0ZSB9XG4gICAgICAgIDoge30pLFxuICAgICAgLi4uKHByb3BzLnByaWNlQ2xhc3MgIT09IHVuZGVmaW5lZCA/IHsgcHJpY2VDbGFzczogcHJvcHMucHJpY2VDbGFzcyB9IDoge30pLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY2ZuRGlzdHJpYnV0aW9uID0gdGhpcy5kaXN0cmlidXRpb24ubm9kZVxuICAgICAgLmRlZmF1bHRDaGlsZCBhcyBjbG91ZGZyb250LkNmbkRpc3RyaWJ1dGlvbjtcbiAgICBjZm5EaXN0cmlidXRpb24uYWRkTWV0YWRhdGEoQ0hBTExFTkdFX1JFU1RPUkFUSU9OX01FVEFEQVRBX0tFWSwge1xuICAgICAgY29udHJhY3RJZDogQ0hBTExFTkdFX1JFU1RPUkFUSU9OX0NPTlRSQUNUX0lELFxuICAgICAgYWxpYXNCcmlkZ2U6IHRoaXMuYWxpYXNCcmlkZ2VFbmFibGVkLFxuICAgICAgc291cmNlSGVhZGVyczogdGhpcy5yZXN0b3JlU291cmNlSGVhZGVycyxcbiAgICAgIHJvdXRlQ291bnQ6IHRoaXMuZGVyaXZlZFJvdXRlUGF0aHMubGVuZ3RoLFxuICAgICAgb3JpZ2luUmVhY2hhYmlsaXR5OiB0aGlzLm9yaWdpblJlYWNoYWJpbGl0eSxcbiAgICAgIC4uLih0aGlzLm9yaWdpbkxvY2tIZWFkZXJOYW1lICE9PSB1bmRlZmluZWRcbiAgICAgICAgPyB7IG9yaWdpbkxvY2tIZWFkZXI6IHRoaXMub3JpZ2luTG9ja0hlYWRlck5hbWUgfVxuICAgICAgICA6IHsgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludEFzc2VydGVkOiB0cnVlIH0pLFxuICAgIH0pO1xuICB9XG59XG5cbi8qKiBUaGUgcmVzb2x2ZWQgREQtMiBkZWNpc2lvbiwgd2l0aCB0aGUgb3JpZ2luLWxvY2sgbWF0ZXJpYWwgd2hlbiBMT0NLRUQuICovXG5pbnRlcmZhY2UgT3JpZ2luUmVhY2hhYmlsaXR5RGVjaXNpb24ge1xuICByZWFkb25seSBkZWNpc2lvbjogQXBwVGhlb3J5UmVzdFYxT3JpZ2luUmVhY2hhYmlsaXR5O1xuICByZWFkb25seSBsb2NrSGVhZGVyTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgbG9ja1NlY3JldD86IHN0cmluZztcbn1cblxuLyoqIFJlbmRlcnMgYSByZWplY3RlZCBkZWNpc2lvbiBmb3IgYW4gZXJyb3IgbWVzc2FnZSB3aXRob3V0IGFzc3VtaW5nIGl0cyB0eXBlLiAqL1xuZnVuY3Rpb24gZGVzY3JpYmVEZWNpc2lvbihkZWNpc2lvbjogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiB0eXBlb2YgZGVjaXNpb24gPT09IFwic3RyaW5nXCIgPyBKU09OLnN0cmluZ2lmeShkZWNpc2lvbikgOiBTdHJpbmcoZGVjaXNpb24pO1xufVxuXG4vKipcbiAqIFJlc29sdmVzIGFuZCB2YWxpZGF0ZXMgdGhlIG1hbmRhdG9yeSBERC0yIGRpcmVjdC1vcmlnaW4gcmVhY2hhYmlsaXR5IGRlY2lzaW9uLlxuICpcbiAqIEZhaWxzIGNsb3NlZCBhdCBzeW50aGVzaXMgb24gYSBtaXNzaW5nIG9yIGBkaXJlY3RgIGRlY2lzaW9uLCBvbiBhIGBESVNBQkxFRGBcbiAqIGRlY2lzaW9uIHdpdGhvdXQgdGhlIGNhbGxlcidzIGRpc2FibGVtZW50IGFzc2VydGlvbiwgb24gYSBgTE9DS0VEYCBkZWNpc2lvblxuICogd2l0aG91dCBhIGNvbXBsZXRlIG9yaWdpbiBsb2NrLCBhbmQgb24gY29udHJhZGljdG9yeSBwcm9wcy5cbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZU9yaWdpblJlYWNoYWJpbGl0eShcbiAgcHJvcHM6IEFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uUHJvcHMsXG4pOiBPcmlnaW5SZWFjaGFiaWxpdHlEZWNpc2lvbiB7XG4gIGNvbnN0IGRlY2lzaW9uID0gcHJvcHMub3JpZ2luUmVhY2hhYmlsaXR5O1xuICBpZiAoXG4gICAgZGVjaXNpb24gIT09IEFwcFRoZW9yeVJlc3RWMU9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRCAmJlxuICAgIGRlY2lzaW9uICE9PSBBcHBUaGVvcnlSZXN0VjFPcmlnaW5SZWFjaGFiaWxpdHkuTE9DS0VEXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb246IG9yaWdpblJlYWNoYWJpbGl0eSBpcyByZXF1aXJlZCBhbmQgbXVzdCBiZSBcIiArXG4gICAgICAgIFwiQXBwVGhlb3J5UmVzdFYxT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEIG9yIC5MT0NLRUQgKERELTIpOyBhIGRpcmVjdGx5IHJlYWNoYWJsZSBcIiArXG4gICAgICAgIGBvcmlnaW4gKCdkaXJlY3QnKSBpcyBub3QgYWxsb3dlZCAocmVjZWl2ZWQgJHtkZXNjcmliZURlY2lzaW9uKGRlY2lzaW9uKX0pLiBgICtcbiAgICAgICAgXCJUaGUgUkVTVCBBUEkncyBleGVjdXRlLWFwaSBlbmRwb2ludCBpcyB0aGUgb3JpZ2luIHRoaXMgZGlzdHJpYnV0aW9uIHVzZXMsIHNvIGEgY2xpZW50IHRoYXQgXCIgK1xuICAgICAgICBcImJ5cGFzc2VzIHRoZSBkaXN0cmlidXRpb24gc3RpbGwgcmVhY2hlcyBpdCBhbmQgb2JzZXJ2ZXMgYSBjaGFsbGVuZ2UtbGVzcyA0MDE6IHJlY29yZCBob3cgdGhhdCBcIiArXG4gICAgICAgIFwiZW5kcG9pbnQgaXMgbWFkZSB1bnJlYWNoYWJsZSAoRElTQUJMRUQpIG9yIHJlYWNoZWQgb25seSB0aHJvdWdoIHRoaXMgZGlzdHJpYnV0aW9uIChMT0NLRUQpXCIsXG4gICAgKTtcbiAgfVxuXG4gIGlmIChkZWNpc2lvbiA9PT0gQXBwVGhlb3J5UmVzdFYxT3JpZ2luUmVhY2hhYmlsaXR5LkRJU0FCTEVEKSB7XG4gICAgaWYgKHByb3BzLm9yaWdpbkxvY2sgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uOiBvcmlnaW5Mb2NrIGlzIG9ubHkgdmFsaWQgd2l0aCBvcmlnaW5SZWFjaGFiaWxpdHkgXCIgK1xuICAgICAgICAgIFwiQXBwVGhlb3J5UmVzdFYxT3JpZ2luUmVhY2hhYmlsaXR5LkxPQ0tFRFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHByb3BzLmRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnRBc3NlcnRlZCAhPT0gdHJ1ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uOiBvcmlnaW5SZWFjaGFiaWxpdHkgRElTQUJMRUQgcmVxdWlyZXMgXCIgK1xuICAgICAgICAgIFwiZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludEFzc2VydGVkOiB0cnVlOyB0aGlzIGNvbnN0cnVjdCBmcm9udHMgYW4gZXh0ZXJuYWwgSVJlc3RBcGkgaXQgXCIgK1xuICAgICAgICAgIFwiY2Fubm90IG11dGF0ZSwgc28gdGhlIGNhbGxlciBtdXN0IGFzc2VydCB0aGF0IHRoZSBSRVNUIEFQSSdzIGRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQgaXMgc2V0XCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4geyBkZWNpc2lvbiB9O1xuICB9XG5cbiAgaWYgKHByb3BzLmRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnRBc3NlcnRlZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbjogZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludEFzc2VydGVkIGlzIG9ubHkgdmFsaWQgd2l0aCBcIiArXG4gICAgICAgIFwib3JpZ2luUmVhY2hhYmlsaXR5IEFwcFRoZW9yeVJlc3RWMU9yaWdpblJlYWNoYWJpbGl0eS5ESVNBQkxFRFwiLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBsb2NrID0gcHJvcHMub3JpZ2luTG9jaztcbiAgaWYgKGxvY2sgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb246IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgcmVxdWlyZXMgb3JpZ2luTG9jayBcIiArXG4gICAgICAgIFwiKHsgc2VjcmV0LCBhc3NlcnRlZDogdHJ1ZSB9KSBjYXJyeWluZyB0aGUgb3JpZ2luLWxvY2sgbWF0ZXJpYWwgYW5kIHRoZSBjYWxsZXIncyBhc3NlcnRpb24gdGhhdCBcIiArXG4gICAgICAgIFwidGhlIFJFU1QgQVBJIHZlcmlmaWVzIGl0XCIsXG4gICAgKTtcbiAgfVxuICBpZiAobG9jay5hc3NlcnRlZCAhPT0gdHJ1ZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb246IG9yaWdpblJlYWNoYWJpbGl0eSBMT0NLRUQgcmVxdWlyZXMgb3JpZ2luTG9jay5hc3NlcnRlZDogdHJ1ZSBcIiArXG4gICAgICAgIFwiKHRoZSBjYWxsZXIgYXNzZXJ0cyB0aGUgUkVTVCBBUEkgdmVyaWZpZXMgdGhlIG9yaWdpbi1sb2NrIGhlYWRlciB0aGlzIGRpc3RyaWJ1dGlvbiBpbmplY3RzKTsgXCIgK1xuICAgICAgICBcInRoaXMgY29uc3RydWN0IGNhbm5vdCBhdHRhY2ggdGhlIHZlcmlmaWNhdGlvbiB0byBhbiBleHRlcm5hbCBJUmVzdEFwaVwiLFxuICAgICk7XG4gIH1cbiAgaWYgKHR5cGVvZiBsb2NrLnNlY3JldCAhPT0gXCJzdHJpbmdcIiB8fCAhT1JJR0lOX0xPQ0tfU0VDUkVUX1BBVFRFUk4udGVzdChsb2NrLnNlY3JldCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uOiBvcmlnaW5Mb2NrLnNlY3JldCBtdXN0IGJlIDMyLi4xMjggY2hhcmFjdGVycyBvZiBcIiArXG4gICAgICAgIFwiW0EtWmEtejAtOS5ffi1dIChhIGxpdGVyYWwgQ2xvdWRGcm9udCBvcmlnaW4gY3VzdG9tIGhlYWRlciB2YWx1ZTogbm8gd2hpdGVzcGFjZSwgbm8gY29udHJvbCBcIiArXG4gICAgICAgIFwiY2hhcmFjdGVycywgbm8gdGVtcGxhdGUgaW50cmluc2ljcylcIixcbiAgICApO1xuICB9XG5cbiAgY29uc3QgaGVhZGVyTmFtZSA9IGxvY2suaGVhZGVyTmFtZSA/PyBERUZBVUxUX09SSUdJTl9MT0NLX0hFQURFUjtcbiAgaWYgKCFPUklHSU5fTE9DS19IRUFERVJfTkFNRV9QQVRURVJOLnRlc3QoaGVhZGVyTmFtZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uOiBvcmlnaW5Mb2NrLmhlYWRlck5hbWUgbXVzdCBiZSAxLi42NCBjaGFyYWN0ZXJzIG9mIFtBLVphLXowLTktXVwiLFxuICAgICk7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZEhlYWRlck5hbWUgPSBoZWFkZXJOYW1lLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChcbiAgICBSRVNFUlZFRF9PUklHSU5fTE9DS19IRUFERVJTLmhhcyhub3JtYWxpemVkSGVhZGVyTmFtZSkgfHxcbiAgICBub3JtYWxpemVkSGVhZGVyTmFtZS5zdGFydHNXaXRoKFwieC1hbXotXCIpIHx8XG4gICAgbm9ybWFsaXplZEhlYWRlck5hbWUuc3RhcnRzV2l0aChcIngtYW16bi1cIikgfHxcbiAgICBub3JtYWxpemVkSGVhZGVyTmFtZS5zdGFydHNXaXRoKFwiY2xvdWRmcm9udC1cIilcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uOiBvcmlnaW5Mb2NrLmhlYWRlck5hbWUgXCIke2hlYWRlck5hbWV9XCIgaXMgcmVzZXJ2ZWQgYnkgQ2xvdWRGcm9udCBvciB0aGUgb3JpZ2luIHJlcXVlc3QgY29udHJhY3QgYW5kIGNhbm5vdCBjYXJyeSB0aGUgb3JpZ2luIGxvY2tgLFxuICAgICk7XG4gIH1cblxuICByZXR1cm4geyBkZWNpc2lvbiwgbG9ja0hlYWRlck5hbWU6IGhlYWRlck5hbWUsIGxvY2tTZWNyZXQ6IGxvY2suc2VjcmV0IH07XG59XG5cbi8qKiBGYWlscyBjbG9zZWQgdW5sZXNzIHRoZSBvcmlnaW4gaXMgYW4gQVdTIEFQSSBHYXRld2F5IFJFU1QgQVBJIHYxLiAqL1xuZnVuY3Rpb24gYXNzZXJ0UmVzdFYxT3JpZ2luKFxuICBvcmlnaW46IGFwaWd3LklSZXN0QXBpIHwgdW5kZWZpbmVkLFxuKTogYXNzZXJ0cyBvcmlnaW4gaXMgYXBpZ3cuSVJlc3RBcGkge1xuICBpZiAoXG4gICAgb3JpZ2luID09PSB1bmRlZmluZWQgfHxcbiAgICB0eXBlb2Ygb3JpZ2luLnJlc3RBcGlJZCAhPT0gXCJzdHJpbmdcIiB8fFxuICAgIG9yaWdpbi5yZXN0QXBpSWQubGVuZ3RoID09PSAwIHx8XG4gICAgdHlwZW9mIG9yaWdpbi5yZXN0QXBpUm9vdFJlc291cmNlSWQgIT09IFwic3RyaW5nXCIgfHxcbiAgICBvcmlnaW4ucmVzdEFwaVJvb3RSZXNvdXJjZUlkLmxlbmd0aCA9PT0gMFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoTk9OX1JFU1RfVjFfT1JJR0lOX01FU1NBR0UpO1xuICB9XG59XG5cbi8qKlxuICogQnVpbGRzIHRoZSBIVFRQUy1vbmx5IGBleGVjdXRlLWFwaWAgb3JpZ2luIGZvciBhbiBBV1MgQVBJIEdhdGV3YXkgUkVTVCBBUEkgdjEsXG4gKiBjYXJyeWluZyB0aGUgb3JpZ2luLWxvY2sgaGVhZGVyIHdoZW4gdGhlIGRlY2lzaW9uIGlzIGBMT0NLRURgLlxuICpcbiAqIGBjbG91ZGZyb250LW9yaWdpbnNgJyBgUmVzdEFwaU9yaWdpbmAgYWNjZXB0cyBhIGBSZXN0QXBpQmFzZWAgKGl0IHJlYWRzIHRoZVxuICogY29uY3JldGUgYHVybGAgdG9rZW4pLCBub3QgdGhlIGBJUmVzdEFwaWAgdGhpcyBjb25zdHJ1Y3QgdGFrZXMsIGFuZCBgSVJlc3RBcGlgXG4gKiBleHBvc2VzIG5laXRoZXIgYHVybGAgbm9yIGB1cmxGb3JQYXRoYC4gVGhlIGV4ZWN1dGUtYXBpIG9yaWdpbiBpcyB0aGVyZWZvcmVcbiAqIGJ1aWx0IGZyb20gYHJlc3RBcGlJZGAsIHRoZSBzdGFjayByZWdpb24gYW5kIFVSTCBzdWZmaXgsIGFuZCB0aGUgZGVwbG95bWVudFxuICogc3RhZ2UncyBvcmlnaW4gcGF0aC5cbiAqL1xuZnVuY3Rpb24gYnVpbGRSZXN0VjFPcmlnaW4oXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIG9yaWdpbjogYXBpZ3cuSVJlc3RBcGksXG4gIHJlYWNoYWJpbGl0eTogT3JpZ2luUmVhY2hhYmlsaXR5RGVjaXNpb24sXG4pOiBvcmlnaW5zLkh0dHBPcmlnaW4ge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3Qgb3JpZ2luRG9tYWluTmFtZSA9IGAke29yaWdpbi5yZXN0QXBpSWR9LmV4ZWN1dGUtYXBpLiR7c3RhY2sucmVnaW9ufS4ke3N0YWNrLnVybFN1ZmZpeH1gO1xuICBjb25zdCBzdGFnZU5hbWUgPSBvcmlnaW4uZGVwbG95bWVudFN0YWdlPy5zdGFnZU5hbWU7XG4gIHJldHVybiBuZXcgb3JpZ2lucy5IdHRwT3JpZ2luKG9yaWdpbkRvbWFpbk5hbWUsIHtcbiAgICBwcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5PcmlnaW5Qcm90b2NvbFBvbGljeS5IVFRQU19PTkxZLFxuICAgIC4uLihzdGFnZU5hbWUgPyB7IG9yaWdpblBhdGg6IGAvJHtzdGFnZU5hbWV9YCB9IDoge30pLFxuICAgIC4uLihyZWFjaGFiaWxpdHkubG9ja0hlYWRlck5hbWUgIT09IHVuZGVmaW5lZCAmJiByZWFjaGFiaWxpdHkubG9ja1NlY3JldCAhPT0gdW5kZWZpbmVkXG4gICAgICA/IHsgY3VzdG9tSGVhZGVyczogeyBbcmVhY2hhYmlsaXR5LmxvY2tIZWFkZXJOYW1lXTogcmVhY2hhYmlsaXR5LmxvY2tTZWNyZXQgfSB9XG4gICAgICA6IHt9KSxcbiAgfSk7XG59XG5cbi8qKlxuICogRGVyaXZlcyB0aGUgY29tcGxldGUgZGVkdXBlZCwgc29ydGVkIHJvdXRlIHNldCBmb3IgdGhlIGVmZmVjdGl2ZSByZXNvdXJjZVxuICogcGF0aHMgdXNpbmcgb25seSB0aGUgc2hhcmVkIHJvdXRlIGFsZ2VicmEgKG5ldmVyIGhhbmQtd2lyZWQpLlxuICovXG5mdW5jdGlvbiBkZXJpdmVSb3V0ZVBhdGhzKGNvbmZpZ3VyZWRSZXNvdXJjZVBhdGhzPzogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGVmZmVjdGl2ZVJlc291cmNlUGF0aHMgPVxuICAgIGNvbmZpZ3VyZWRSZXNvdXJjZVBhdGhzICE9PSB1bmRlZmluZWQgJiYgY29uZmlndXJlZFJlc291cmNlUGF0aHMubGVuZ3RoID4gMFxuICAgICAgPyBjb25maWd1cmVkUmVzb3VyY2VQYXRoc1xuICAgICAgOiBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuc3VwcG9ydGVkRW5kcG9pbnRUZW1wbGF0ZXMoKS5tYXAoXG4gICAgICAgICAgKHRlbXBsYXRlKSA9PiB0ZW1wbGF0ZS5tY3BQYXR0ZXJuLFxuICAgICAgICApO1xuXG4gIGNvbnN0IGRlcml2YXRpb25zOiBBcnJheTwocmVzb3VyY2VQYXRoOiBzdHJpbmcpID0+IHN0cmluZz4gPSBbXG4gICAgKHJlc291cmNlUGF0aCkgPT4gcmVzb3VyY2VQYXRoLFxuICAgIChyZXNvdXJjZVBhdGgpID0+XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEucHJvdGVjdGVkUmVzb3VyY2VQYXRoRm9yUmVzb3VyY2VQYXRoKHJlc291cmNlUGF0aCksXG4gICAgKHJlc291cmNlUGF0aCkgPT5cbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uU2VydmVyUGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGgpLFxuICAgIChyZXNvdXJjZVBhdGgpID0+XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvbkF1dGhvcml6ZVBhdGhGb3JSZXNvdXJjZVBhdGgocmVzb3VyY2VQYXRoKSxcbiAgICAocmVzb3VyY2VQYXRoKSA9PlxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25Ub2tlblBhdGhGb3JSZXNvdXJjZVBhdGgocmVzb3VyY2VQYXRoKSxcbiAgICAocmVzb3VyY2VQYXRoKSA9PlxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25SZWdpc3RlclBhdGhGb3JSZXNvdXJjZVBhdGgocmVzb3VyY2VQYXRoKSxcbiAgICAocmVzb3VyY2VQYXRoKSA9PlxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJTdWZmaXhQYXRoRm9yUmVzb3VyY2VQYXRoKHJlc291cmNlUGF0aCksXG4gIF07XG5cbiAgY29uc3QgZGVyaXZlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHJlc291cmNlUGF0aCBvZiBlZmZlY3RpdmVSZXNvdXJjZVBhdGhzKSB7XG4gICAgZm9yIChjb25zdCBkZXJpdmUgb2YgZGVyaXZhdGlvbnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGRlcml2ZWQuYWRkKGRlcml2ZShyZXNvdXJjZVBhdGgpKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb246IHJlc291cmNlUGF0aHMgZW50cnkgXCIke3Jlc291cmNlUGF0aH1cIiBpcyBub3QgYSByb3V0ZSB0aGUgcm91dGUgbW9kZWwgY2FuIGRlcml2ZTogJHtlcnJvck1lc3NhZ2UoZXJyb3IpfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gVGhlIHVwc3RyZWFtIE9BdXRoIGNhbGxiYWNrIGlzIHN0YWdlLWdsb2JhbCwgc28gaXQgaXMgZGVyaXZlZCBleGFjdGx5IG9uY2VcbiAgLy8gcmF0aGVyIHRoYW4gcGVyIHJlc291cmNlIHBhdGguIFRoZSBjb250cmFjdCBkZWZhdWx0IGlzIGFsd2F5cyBkZXJpdmFibGUuXG4gIGRlcml2ZWQuYWRkKFxuICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5jYWxsYmFja1BhdGhGb3JDb25maWd1cmVkUGF0aChcbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5ERUZBVUxUX0NBTExCQUNLX1BBVEgsXG4gICAgKSxcbiAgKTtcblxuICByZXR1cm4gQXJyYXkuZnJvbShkZXJpdmVkKS5zb3J0KCk7XG59XG5cbi8qKiBSZXR1cm5zIGEgdGhyb3duIHZhbHVlJ3MgbWVzc2FnZSB3aXRob3V0IGFzc3VtaW5nIGl0IGlzIGFuIEVycm9yLiAqL1xuZnVuY3Rpb24gZXJyb3JNZXNzYWdlKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbn1cbiJdfQ==