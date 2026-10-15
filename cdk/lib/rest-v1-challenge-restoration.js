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
exports.AppTheoryRestV1ChallengeRestoration = void 0;
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
class AppTheoryRestV1ChallengeRestoration extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryRestV1ChallengeRestoration", version: "6.0.0" };
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
        const restOrigin = buildRestV1Origin(this, origin);
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
        // All cookies and all query strings are forwarded as well, exactly as the
        // managed policy does: the derived OAuth routes carry their parameters in
        // the query string (the per-kind `.../authorize` route and the callback's
        // `?code=...&state=...`), so dropping the query string would break the
        // front channel, and a cookie-carried session must reach the origin
        // unchanged.
        const originRequestPolicy = new cloudfront.OriginRequestPolicy(this, "OriginRequestPolicy", {
            comment: "AppTheory REST v1 challenge restoration: forward all viewer headers except Host, all cookies and all query strings",
            headerBehavior: cloudfront.OriginRequestHeaderBehavior.denyList("Host"),
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
        });
    }
}
exports.AppTheoryRestV1ChallengeRestoration = AppTheoryRestV1ChallengeRestoration;
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
 * Builds the HTTPS-only `execute-api` origin for an AWS API Gateway REST API v1.
 *
 * `cloudfront-origins`' `RestApiOrigin` accepts a `RestApiBase` (it reads the
 * concrete `url` token), not the `IRestApi` this construct takes, and `IRestApi`
 * exposes neither `url` nor `urlForPath`. The execute-api origin is therefore
 * built from `restApiId`, the stack region and URL suffix, and the deployment
 * stage's origin path.
 */
function buildRestV1Origin(scope, origin) {
    const stack = aws_cdk_lib_1.Stack.of(scope);
    const originDomainName = `${origin.restApiId}.execute-api.${stack.region}.${stack.urlSuffix}`;
    const stageName = origin.deploymentStage?.stageName;
    return new origins.HttpOrigin(originDomainName, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        ...(stageName ? { originPath: `/${stageName}` } : {}),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC12MS1jaGFsbGVuZ2UtcmVzdG9yYXRpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyZXN0LXYxLWNoYWxsZW5nZS1yZXN0b3JhdGlvbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQW9DO0FBR3BDLHVFQUF5RDtBQUN6RCw0RUFBOEQ7QUFDOUQsK0RBQWlEO0FBQ2pELDJDQUF1QztBQUV2QywyREFBK0Q7QUFDL0QsMkdBQWdIO0FBRWhILHdGQUF3RjtBQUN4RixNQUFNLGtDQUFrQyxHQUFHLHlDQUF5QyxDQUFDO0FBRXJGLGdFQUFnRTtBQUNoRSxNQUFNLGlDQUFpQyxHQUFHLHNDQUFzQyxDQUFDO0FBRWpGOzs7Ozs7R0FNRztBQUNILE1BQU0sbUJBQW1CLEdBQUcsa0NBQWtDLENBQUM7QUFFL0Q7OztHQUdHO0FBQ0gsTUFBTSxvQkFBb0IsR0FBRyxDQUFDLDJCQUEyQixFQUFFLHNCQUFzQixDQUFDLENBQUM7QUFFbkY7Ozs7O0dBS0c7QUFDSCxNQUFNLDBCQUEwQixHQUM5Qix3RkFBd0Y7SUFDeEYsdUVBQXVFLENBQUM7QUFxRTFFOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0F3Qkc7QUFDSCxNQUFhLG1DQUFvQyxTQUFRLHNCQUFTOztJQUNoRSwrREFBK0Q7SUFDL0MsWUFBWSxDQUEwQjtJQUV0RDs7Ozs7O09BTUc7SUFDYSxvQkFBb0IsQ0FBVztJQUUvQyxzREFBc0Q7SUFDdEMsa0JBQWtCLENBQVU7SUFFNUM7OztPQUdHO0lBQ2EsaUJBQWlCLENBQVc7SUFFNUM7Ozs7OztPQU1HO0lBQ2Esb0JBQW9CLENBQVc7SUFFL0MsWUFDRSxLQUFnQixFQUNoQixFQUFVLEVBQ1YsS0FBK0M7UUFFL0MsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLE1BQU0sR0FBSSxLQUFxQyxDQUFDLE1BQU0sQ0FBQztRQUM3RCxrQkFB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QWdELFlBQVksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUMvSSxDQUFDO1lBQ0osQ0FBQztRQUNILENBQUM7SUFDSCxDQUFDO0lBRUQsNkVBQTZFO0lBQzdFLDJFQUEyRTtJQUMzRSxPQUFPLENBQUMsR0FBRyxDQUNULDRDQUF3QixDQUFDLDZCQUE2QixDQUNwRCw0Q0FBd0IsQ0FBQyxxQkFBcUIsQ0FDL0MsQ0FDRixDQUFDO0lBRUYsT0FBTyxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0FBQ3BDLENBQUM7QUFFRCx3RUFBd0U7QUFDeEUsU0FBUyxZQUFZLENBQUMsS0FBYztJQUNsQyxPQUFPLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUNoRSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgU3RhY2sgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgYXBpZ3cgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgb3JpZ2lucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2luc1wiO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEgfSBmcm9tIFwiLi9tY3Atcm91dGUtYWxnZWJyYVwiO1xuaW1wb3J0IHsgZ2VuZXJhdGVSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbkhhbmRsZXJDb2RlIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZXN0LXYxLWNoYWxsZW5nZS1yZXN0b3JhdGlvbi1oYW5kbGVyXCI7XG5cbi8qKiBNZXRhZGF0YSBrZXkgcmVjb3JkZWQgb24gdGhlIGRpc3RyaWJ1dGlvbiBmb3IgdGhlIGNoYWxsZW5nZS1yZXN0b3JhdGlvbiBjb250cmFjdC4gKi9cbmNvbnN0IENIQUxMRU5HRV9SRVNUT1JBVElPTl9NRVRBREFUQV9LRVkgPSBcImFwcHRoZW9yeTpyZXN0LXYxLWNoYWxsZW5nZS1yZXN0b3JhdGlvblwiO1xuXG4vKiogQ29udHJhY3QgaWQgcmVjb3JkZWQgaW4gdGhlIGRpc3RyaWJ1dGlvbiBtZXRhZGF0YSBtYXJrZXIuICovXG5jb25zdCBDSEFMTEVOR0VfUkVTVE9SQVRJT05fQ09OVFJBQ1RfSUQgPSBcIm0xNy5yZXN0LXYxLWNoYWxsZW5nZS1yZXN0b3JhdGlvbi92MVwiO1xuXG4vKipcbiAqIFRoZSBtYW5pZmVzdCBjb25zdGFudCBmb3IgdGhlIEFXUyBSRVNUIHYxIHJlbWFwIGFydGlmYWN0LlxuICpcbiAqIEFXUyBBUEkgR2F0ZXdheSBSRVNUIEFQSSB2MSByZW1hcHMgdGhlIG9yaWdpbidzIGBXV1ctQXV0aGVudGljYXRlYCByZXNwb25zZVxuICogaGVhZGVyIG9udG8gdGhpcyBoZWFkZXIsIHNvIGl0IGlzIHRoZSByZXN0b3JlIHNvdXJjZSB0aGF0IGRvZXMgbm90IGRlcGVuZCBvblxuICogYW55IG9wdGlvbmFsIGJyaWRnZS5cbiAqL1xuY29uc3QgUkVNQVBfU09VUkNFX0hFQURFUiA9IFwieC1hbXpuLXJlbWFwcGVkLXd3dy1hdXRoZW50aWNhdGVcIjtcblxuLyoqXG4gKiBUaGUgb3B0aW9uYWwgYWxpYXMgYnJpZGdlIHNwZWxsaW5ncywgY29uc3VsdGVkIG9ubHkgd2hlbiB0aGUgYWxpYXMgYnJpZGdlIGlzXG4gKiBlbmFibGVkLCBpbiBwcmlvcml0eSBvcmRlciBhZnRlciB0aGUgcmVtYXAgYXJ0aWZhY3QuXG4gKi9cbmNvbnN0IEFMSUFTX1NPVVJDRV9IRUFERVJTID0gW1wieC10aGVvcnktd3d3LWF1dGhlbnRpY2F0ZVwiLCBcIm1jcC13d3ctYXV0aGVudGljYXRlXCJdO1xuXG4vKipcbiAqIFRoZSBkZWZhdWx0IFJFU1QgdjEgdHJhbnNwb3J0LWZhaWx1cmUgbWVzc2FnZS5cbiAqXG4gKiBUaGUgcmVzdG9yYXRpb24gaXMgYSBkb2N1bWVudGVkIG5vLW9wIG9uIEhUVFAgQVBJIHYyLCBzbyBhIG5vbi1SRVNULXYxIG9yaWdpblxuICogZmFpbHMgc3ludGggcmF0aGVyIHRoYW4gc2lsZW50bHkgZGVncmFkaW5nLlxuICovXG5jb25zdCBOT05fUkVTVF9WMV9PUklHSU5fTUVTU0FHRSA9XG4gIFwiQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb246IG9yaWdpbiBtdXN0IGJlIGFuIEFXUyBBUEkgR2F0ZXdheSBSRVNUIEFQSSAodjEpOyBcIiArXG4gIFwidGhlIFdXVy1BdXRoZW50aWNhdGUgcmVzdG9yYXRpb24gaXMgYSBkb2N1bWVudGVkIG5vLW9wIG9uIEhUVFAgQVBJIHYyXCI7XG5cbi8qKlxuICogT3B0aW9ucyBmb3IgdGhlIG9wdGlvbmFsIGNoYWxsZW5nZSBhbGlhcyBicmlkZ2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5Q2hhbGxlbmdlQWxpYXNCcmlkZ2VPcHRpb25zIHtcbiAgLyoqXG4gICAqIEVuYWJsZXMgdGhlIG9wdGlvbmFsIGNoYWxsZW5nZSBhbGlhcyBicmlkZ2UuXG4gICAqXG4gICAqIFdoZW4gZW5hYmxlZCB0aGUgcmVzdG9yYXRpb24gY29uc3VsdHMgdGhlIGJyaWRnZSBhbGlhc2VzXG4gICAqIChgeC10aGVvcnktd3d3LWF1dGhlbnRpY2F0ZWAsIHRoZW4gYG1jcC13d3ctYXV0aGVudGljYXRlYCkgYWZ0ZXIgdGhlIEFXU1xuICAgKiBSRVNUIHYxIHJlbWFwIGFydGlmYWN0LiBXaGVuIGRpc2FibGVkIG9ubHkgdGhlIHJlbWFwIGFydGlmYWN0IGlzIGNvbnN1bHRlZFxuICAgKiBhbmQgdGhlIGFsaWFzIHNwZWxsaW5ncyBuZXZlciBhcHBlYXIgaW4gdGhlIGRlcGxveWVkIGZ1bmN0aW9uIHNvdXJjZS5cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZWQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIFByb3BlcnRpZXMgZm9yIGBBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbmAuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb25Qcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgUkVTVCBBUEkgdjEgb3JpZ2luIHdob3NlIGBXV1ctQXV0aGVudGljYXRlYCByZXNwb25zZXMgbXVzdCBiZSByZXN0b3JlZC5cbiAgICpcbiAgICogT25seSBhbiBBV1MgQVBJIEdhdGV3YXkgUkVTVCBBUEkgdjEgKGEgbm9uLWVtcHR5IGByZXN0QXBpSWRgIGFuZCBhIG5vbi1lbXB0eVxuICAgKiBgcmVzdEFwaVJvb3RSZXNvdXJjZUlkYCkgaXMgYWNjZXB0ZWQ7IHRoZSByZXN0b3JhdGlvbiBpcyBhIGRvY3VtZW50ZWQgbm8tb3BcbiAgICogb24gSFRUUCBBUEkgdjIuXG4gICAqL1xuICByZWFkb25seSBvcmlnaW46IGFwaWd3LklSZXN0QXBpO1xuXG4gIC8qKlxuICAgKiBNQ1AgcmVzb3VyY2UgcGF0aHMgd2hvc2UgZGVyaXZlZCByb3V0ZXMgcmVjZWl2ZSBhbiBleHBsaWNpdCBvcmRlcmVkIGNhY2hlXG4gICAqIGJlaGF2aW9yLlxuICAgKlxuICAgKiBUaGUgZWZmZWN0aXZlIHJvdXRlIHNldCBpcyBkZXJpdmVkIGZyb20gdGhlIHNoYXJlZCByb3V0ZSBhbGdlYnJhLCBuZXZlclxuICAgKiBoYW5kLXdpcmVkLiBBIHN1cHBsaWVkLWJ1dC1lbXB0eSBhcnJheSBpcyB0cmVhdGVkIGFzIHRoZSBkZWZhdWx0LlxuICAgKlxuICAgKiBAZGVmYXVsdCB0aGUgc3RhbmRhcmQgTUNQIHBhdHRlcm5zIGZyb20gdGhlIHNoYXJlZCByb3V0ZSBhbGdlYnJhXG4gICAqIChgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLnN1cHBvcnRlZEVuZHBvaW50VGVtcGxhdGVzKCkubWNwUGF0dGVybmApXG4gICAqL1xuICByZWFkb25seSByZXNvdXJjZVBhdGhzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIGNoYWxsZW5nZSBhbGlhcyBicmlkZ2UuXG4gICAqXG4gICAqIEBkZWZhdWx0IGRpc2FibGVkXG4gICAqL1xuICByZWFkb25seSBhbGlhc0JyaWRnZT86IEFwcFRoZW9yeUNoYWxsZW5nZUFsaWFzQnJpZGdlT3B0aW9ucztcblxuICAvKipcbiAgICogT3B0aW9uYWwgY3VzdG9tIGRvbWFpbiBuYW1lcyBmb3IgdGhlIGRpc3RyaWJ1dGlvbi5cbiAgICpcbiAgICogV2hlbiBzZXQsIGBjZXJ0aWZpY2F0ZWAgaXMgcmVxdWlyZWQuXG4gICAqL1xuICByZWFkb25seSBkb21haW5OYW1lcz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBDZXJ0aWZpY2F0ZSBmb3IgYGRvbWFpbk5hbWVzYC4gUmVxdWlyZWQgd2hlbiBgZG9tYWluTmFtZXNgIGlzIHNldC5cbiAgICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAvKipcbiAgICogT3B0aW9uYWwgQ2xvdWRGcm9udCBwcmljZSBjbGFzcy5cbiAgICovXG4gIHJlYWRvbmx5IHByaWNlQ2xhc3M/OiBjbG91ZGZyb250LlByaWNlQ2xhc3M7XG59XG5cbi8qKlxuICogQSBmcmFtZXdvcmsgQ2xvdWRGcm9udCBmcm9udCBkb29yIHRoYXQgcmVzdG9yZXMgdGhlIGNhbm9uaWNhbFxuICogYFdXVy1BdXRoZW50aWNhdGVgIGNoYWxsZW5nZSBmb3IgYW4gQVdTIEFQSSBHYXRld2F5IFJFU1QgQVBJIHYxIG9yaWdpbi5cbiAqXG4gKiBBV1MgUkVTVCBBUEkgdjEgcmVtYXBzIHRoZSBvcmlnaW4ncyBgV1dXLUF1dGhlbnRpY2F0ZWAgcmVzcG9uc2UgaGVhZGVyIG9udG9cbiAqIGB4LWFtem4tcmVtYXBwZWQtd3d3LWF1dGhlbnRpY2F0ZWAsIHNvIGEgY2Fub25pY2FsLW9ubHkgYXBwIGxvc2VzIHRoZVxuICogY2hhbGxlbmdlIGF0IHRoZSBlZGdlLiBUaGlzIGNvbnN0cnVjdCBmcm9udHMgdGhlIFJFU1QgdjEgYGV4ZWN1dGUtYXBpYCBvcmlnaW5cbiAqIHdpdGggYSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbiB3aG9zZSBvcmlnaW4tcmVzcG9uc2UgTGFtYmRhQEVkZ2UgZnVuY3Rpb25cbiAqIGNvcGllcyB0aGUgZmlyc3QgcHJlc2VudCBzb3VyY2UgYmFjayBvbnRvIGBXV1ctQXV0aGVudGljYXRlYCBhbmQgcmVtb3ZlcyB0aGVcbiAqIGNvbnN1bWVkIHNvdXJjZSBoZWFkZXJzLlxuICpcbiAqIFRoZSByZXN0b3JlICoqc291cmNlIHNldCoqLCBpbiBwcmlvcml0eSBvcmRlciwgaXM6XG4gKlxuICogMS4gYHgtYW16bi1yZW1hcHBlZC13d3ctYXV0aGVudGljYXRlYCDigJQgdGhlIGFydGlmYWN0IEFXUyBpdHNlbGYgcHJvZHVjZXMgd2hlblxuICogICAgUkVTVCB2MSByZW1hcHMgdGhlIG9yaWdpbiBoZWFkZXIuIEFsd2F5cyBjb25zdWx0ZWQuXG4gKiAyLiB0aGUgYnJpZGdlIGFsaWFzZXMgYHgtdGhlb3J5LXd3dy1hdXRoZW50aWNhdGVgLCB0aGVuXG4gKiAgICBgbWNwLXd3dy1hdXRoZW50aWNhdGVgIOKAlCBjb25zdWx0ZWQgb25seSB3aGVuIHRoZSBvcHRpb25hbCBhbGlhcyBicmlkZ2UgaXNcbiAqICAgIGVuYWJsZWQgKG9mZiBieSBkZWZhdWx0KS5cbiAqXG4gKiBUaGUgZGVyaXZlZCByb3V0ZSBzZXQgYW5kIHRoZSBleHBsaWNpdCBvcmRlcmVkIGNhY2hlIGJlaGF2aW9ycyBjb21lIGZyb20gdGhlXG4gKiBzaGFyZWQgcm91dGUgYWxnZWJyYSAoYEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYWApLCBzbyB0aGUgY29uc3RydWN0IGlzIG5ldmVyXG4gKiBoYW5kLXdpcmVkLiBQYXJhbWV0ZXJpemVkIGRlcml2ZWQgcm91dGVzICh0aG9zZSBjYXJyeWluZyBhIGB7cGFyYW1ldGVyfWBcbiAqIHNlZ21lbnQpIGNhbm5vdCBiZSBleHByZXNzZWQgYXMgQ2xvdWRGcm9udCBwYXRoIHBhdHRlcm5zIGFuZCBhcmUgdGhlcmVmb3JlXG4gKiBjb3ZlcmVkIGJ5IHRoZSBkaXN0cmlidXRpb24ncyBkZWZhdWx0IGJlaGF2aW9yLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb24gZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAvKiogVGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uIGZyb250aW5nIHRoZSBSRVNUIHYxIG9yaWdpbi4gKi9cbiAgcHVibGljIHJlYWRvbmx5IGRpc3RyaWJ1dGlvbjogY2xvdWRmcm9udC5EaXN0cmlidXRpb247XG5cbiAgLyoqXG4gICAqIFRoZSByZXNwb25zZSBoZWFkZXJzIHRoZSByZXN0b3JhdGlvbiBmdW5jdGlvbiBjb25zdWx0cywgaW4gcHJpb3JpdHkgb3JkZXIuXG4gICAqXG4gICAqIGBbXCJ4LWFtem4tcmVtYXBwZWQtd3d3LWF1dGhlbnRpY2F0ZVwiXWAgd2hlbiB0aGUgYWxpYXMgYnJpZGdlIGlzIGRpc2FibGVkO1xuICAgKiBgW1wieC1hbXpuLXJlbWFwcGVkLXd3dy1hdXRoZW50aWNhdGVcIiwgXCJ4LXRoZW9yeS13d3ctYXV0aGVudGljYXRlXCIsXG4gICAqIFwibWNwLXd3dy1hdXRoZW50aWNhdGVcIl1gIHdoZW4gaXQgaXMgZW5hYmxlZC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSByZXN0b3JlU291cmNlSGVhZGVyczogc3RyaW5nW107XG5cbiAgLyoqIFRydWUgd2hlbiB0aGUgb3B0aW9uYWwgYWxpYXMgYnJpZGdlIGlzIGVuYWJsZWQuICovXG4gIHB1YmxpYyByZWFkb25seSBhbGlhc0JyaWRnZUVuYWJsZWQ6IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFRoZSBjb21wbGV0ZSByb3V0ZSBzZXQgZGVyaXZlZCBmcm9tIHRoZSBzaGFyZWQgcm91dGUgYWxnZWJyYSAocGFyYW1ldGVyaXplZFxuICAgKiByb3V0ZXMgaW5jbHVkZWQpLCBkZWR1cGVkIGFuZCBpbiBkZXRlcm1pbmlzdGljIHNvcnRlZCBvcmRlci5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBkZXJpdmVkUm91dGVQYXRoczogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFRoZSBzdWJzZXQgb2YgYGRlcml2ZWRSb3V0ZVBhdGhzYCBlbWl0dGVkIGFzIGV4cGxpY2l0IG9yZGVyZWQgY2FjaGVcbiAgICogYmVoYXZpb3JzICh0aGUgbGl0ZXJhbCBwYXRocywgd2l0aCBubyBge3BhcmFtZXRlcn1gIHNlZ21lbnQpLlxuICAgKlxuICAgKiBDbG91ZEZyb250IHBhdGggcGF0dGVybnMgY2Fubm90IGV4cHJlc3MgYSBge3BhcmFtfWAgc2VnbWVudCwgc29cbiAgICogcGFyYW1ldGVyaXplZCBkZXJpdmVkIHJvdXRlcyBhcmUgY292ZXJlZCBieSB0aGUgZGVmYXVsdCBiZWhhdmlvci5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBiZWhhdmlvclBhdGhQYXR0ZXJuczogc3RyaW5nW107XG5cbiAgcHVibGljIGNvbnN0cnVjdG9yKFxuICAgIHNjb3BlOiBDb25zdHJ1Y3QsXG4gICAgaWQ6IHN0cmluZyxcbiAgICBwcm9wczogQXBwVGhlb3J5UmVzdFYxQ2hhbGxlbmdlUmVzdG9yYXRpb25Qcm9wcyxcbiAgKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IG9yaWdpbiA9IChwcm9wcyBhcyB7IG9yaWdpbj86IGFwaWd3LklSZXN0QXBpIH0pLm9yaWdpbjtcbiAgICBhc3NlcnRSZXN0VjFPcmlnaW4ob3JpZ2luKTtcblxuICAgIGlmIChcbiAgICAgIHByb3BzLmRvbWFpbk5hbWVzICE9PSB1bmRlZmluZWQgJiZcbiAgICAgIHByb3BzLmRvbWFpbk5hbWVzLmxlbmd0aCA+IDAgJiZcbiAgICAgIHByb3BzLmNlcnRpZmljYXRlID09PSB1bmRlZmluZWRcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbjogZG9tYWluTmFtZXMgcmVxdWlyZXMgY2VydGlmaWNhdGVcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgdGhpcy5hbGlhc0JyaWRnZUVuYWJsZWQgPSBwcm9wcy5hbGlhc0JyaWRnZT8uZW5hYmxlZCA9PT0gdHJ1ZTtcbiAgICB0aGlzLnJlc3RvcmVTb3VyY2VIZWFkZXJzID0gdGhpcy5hbGlhc0JyaWRnZUVuYWJsZWRcbiAgICAgID8gW1JFTUFQX1NPVVJDRV9IRUFERVIsIC4uLkFMSUFTX1NPVVJDRV9IRUFERVJTXVxuICAgICAgOiBbUkVNQVBfU09VUkNFX0hFQURFUl07XG5cbiAgICBjb25zdCBkZXJpdmVkUm91dGVQYXRocyA9IGRlcml2ZVJvdXRlUGF0aHMocHJvcHMucmVzb3VyY2VQYXRocyk7XG4gICAgaWYgKGRlcml2ZWRSb3V0ZVBhdGhzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeVJlc3RWMUNoYWxsZW5nZVJlc3RvcmF0aW9uOiB0aGUgcm91dGUgbW9kZWwgZGVyaXZlZCBubyByb3V0ZXMgZnJvbSByZXNvdXJjZVBhdGhzXCIsXG4gICAgICApO1xuICAgIH1cbiAgICB0aGlzLmRlcml2ZWRSb3V0ZVBhdGhzID0gZGVyaXZlZFJvdXRlUGF0aHM7XG4gICAgdGhpcy5iZWhhdmlvclBhdGhQYXR0ZXJucyA9IGRlcml2ZWRSb3V0ZVBhdGhzLmZpbHRlcihcbiAgICAgIChwYXRoUGF0dGVybikgPT4gIXBhdGhQYXR0ZXJuLmluY2x1ZGVzKFwie1wiKSAmJiAhcGF0aFBhdHRlcm4uaW5jbHVkZXMoXCJ9XCIpLFxuICAgICk7XG5cbiAgICBjb25zdCByZXN0T3JpZ2luID0gYnVpbGRSZXN0VjFPcmlnaW4odGhpcywgb3JpZ2luKTtcblxuICAgIGNvbnN0IHJlc3RvcmF0aW9uRnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5leHBlcmltZW50YWwuRWRnZUZ1bmN0aW9uKFxuICAgICAgdGhpcyxcbiAgICAgIFwiQ2hhbGxlbmdlUmVzdG9yYXRpb25GdW5jdGlvblwiLFxuICAgICAge1xuICAgICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMjJfWCxcbiAgICAgICAgaGFuZGxlcjogXCJpbmRleC5oYW5kbGVyXCIsXG4gICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21JbmxpbmUoXG4gICAgICAgICAgZ2VuZXJhdGVSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbkhhbmRsZXJDb2RlKHRoaXMucmVzdG9yZVNvdXJjZUhlYWRlcnMpLFxuICAgICAgICApLFxuICAgICAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgICBcIlJlc3RvcmUgdGhlIGNhbm9uaWNhbCBXV1ctQXV0aGVudGljYXRlIGNoYWxsZW5nZSBmb3IgQXBwVGhlb3J5IFJFU1QgdjEgb3JpZ2luIHJlc3BvbnNlc1wiLFxuICAgICAgfSxcbiAgICApO1xuXG4gICAgLy8gQ0RLJ3MgT3JpZ2luUmVxdWVzdEhlYWRlckJlaGF2aW9yIGhhcyBubyBgYWxsVmlld2VyRXhjZXB0SG9zdEhlYWRlcmBcbiAgICAvLyBidWlsZGVyIGFuZCByZWZ1c2VzIGBBdXRob3JpemF0aW9uYCBpbiBhbiBhbGxvdyBsaXN0LCBzbyB0aGUgbWFuYWdlZFxuICAgIC8vIEFMTF9WSUVXRVJfRVhDRVBUX0hPU1RfSEVBREVSIHBvbGljeSBpcyBleHByZXNzZWQgdGhlIHdheSBBV1MgaW1wbGVtZW50c1xuICAgIC8vIGl0OiBgYWxsRXhjZXB0YCB3aXRoIG9ubHkgYEhvc3RgIGRlbmllZC4gRXZlcnkgdmlld2VyIGhlYWRlciAodGhlXG4gICAgLy8gYEF1dGhvcml6YXRpb25gIGhlYWRlciBhYm92ZSBhbGwpIGlzIGZvcndhcmRlZCwgYW5kIENsb3VkRnJvbnQgc3RpbGxcbiAgICAvLyBwcmVzZW50cyB0aGUgZXhlY3V0ZS1hcGkgb3JpZ2luIGhvc3QuXG4gICAgLy9cbiAgICAvLyBBbGwgY29va2llcyBhbmQgYWxsIHF1ZXJ5IHN0cmluZ3MgYXJlIGZvcndhcmRlZCBhcyB3ZWxsLCBleGFjdGx5IGFzIHRoZVxuICAgIC8vIG1hbmFnZWQgcG9saWN5IGRvZXM6IHRoZSBkZXJpdmVkIE9BdXRoIHJvdXRlcyBjYXJyeSB0aGVpciBwYXJhbWV0ZXJzIGluXG4gICAgLy8gdGhlIHF1ZXJ5IHN0cmluZyAodGhlIHBlci1raW5kIGAuLi4vYXV0aG9yaXplYCByb3V0ZSBhbmQgdGhlIGNhbGxiYWNrJ3NcbiAgICAvLyBgP2NvZGU9Li4uJnN0YXRlPS4uLmApLCBzbyBkcm9wcGluZyB0aGUgcXVlcnkgc3RyaW5nIHdvdWxkIGJyZWFrIHRoZVxuICAgIC8vIGZyb250IGNoYW5uZWwsIGFuZCBhIGNvb2tpZS1jYXJyaWVkIHNlc3Npb24gbXVzdCByZWFjaCB0aGUgb3JpZ2luXG4gICAgLy8gdW5jaGFuZ2VkLlxuICAgIGNvbnN0IG9yaWdpblJlcXVlc3RQb2xpY3kgPSBuZXcgY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UG9saWN5KFxuICAgICAgdGhpcyxcbiAgICAgIFwiT3JpZ2luUmVxdWVzdFBvbGljeVwiLFxuICAgICAge1xuICAgICAgICBjb21tZW50OlxuICAgICAgICAgIFwiQXBwVGhlb3J5IFJFU1QgdjEgY2hhbGxlbmdlIHJlc3RvcmF0aW9uOiBmb3J3YXJkIGFsbCB2aWV3ZXIgaGVhZGVycyBleGNlcHQgSG9zdCwgYWxsIGNvb2tpZXMgYW5kIGFsbCBxdWVyeSBzdHJpbmdzXCIsXG4gICAgICAgIGhlYWRlckJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RIZWFkZXJCZWhhdmlvci5kZW55TGlzdChcIkhvc3RcIiksXG4gICAgICAgIGNvb2tpZUJlaGF2aW9yOiBjbG91ZGZyb250Lk9yaWdpblJlcXVlc3RDb29raWVCZWhhdmlvci5hbGwoKSxcbiAgICAgICAgcXVlcnlTdHJpbmdCZWhhdmlvcjogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UXVlcnlTdHJpbmdCZWhhdmlvci5hbGwoKSxcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIGNvbnN0IGVkZ2VMYW1iZGFzOiBjbG91ZGZyb250LkVkZ2VMYW1iZGFbXSA9IFtcbiAgICAgIHtcbiAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkxhbWJkYUVkZ2VFdmVudFR5cGUuT1JJR0lOX1JFU1BPTlNFLFxuICAgICAgICBmdW5jdGlvblZlcnNpb246IHJlc3RvcmF0aW9uRnVuY3Rpb24uY3VycmVudFZlcnNpb24sXG4gICAgICB9LFxuICAgIF07XG4gICAgY29uc3QgYmVoYXZpb3JPcHRpb25zID0gKCk6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0+ICh7XG4gICAgICBvcmlnaW46IHJlc3RPcmlnaW4sXG4gICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICBjYWNoZVBvbGljeTogY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVELFxuICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgZWRnZUxhbWJkYXMsXG4gICAgfSk7XG5cbiAgICBjb25zdCBhZGRpdGlvbmFsQmVoYXZpb3JzOiBSZWNvcmQ8c3RyaW5nLCBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucz4gPSB7fTtcbiAgICBmb3IgKGNvbnN0IHBhdGhQYXR0ZXJuIG9mIHRoaXMuYmVoYXZpb3JQYXRoUGF0dGVybnMpIHtcbiAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnNbcGF0aFBhdHRlcm5dID0gYmVoYXZpb3JPcHRpb25zKCk7XG4gICAgfVxuXG4gICAgdGhpcy5kaXN0cmlidXRpb24gPSBuZXcgY2xvdWRmcm9udC5EaXN0cmlidXRpb24odGhpcywgXCJEaXN0cmlidXRpb25cIiwge1xuICAgICAgZGVmYXVsdEJlaGF2aW9yOiBiZWhhdmlvck9wdGlvbnMoKSxcbiAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnMsXG4gICAgICAuLi4ocHJvcHMuZG9tYWluTmFtZXMgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgcHJvcHMuZG9tYWluTmFtZXMubGVuZ3RoID4gMCAmJlxuICAgICAgcHJvcHMuY2VydGlmaWNhdGUgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IHsgZG9tYWluTmFtZXM6IHByb3BzLmRvbWFpbk5hbWVzLCBjZXJ0aWZpY2F0ZTogcHJvcHMuY2VydGlmaWNhdGUgfVxuICAgICAgICA6IHt9KSxcbiAgICAgIC4uLihwcm9wcy5wcmljZUNsYXNzICE9PSB1bmRlZmluZWQgPyB7IHByaWNlQ2xhc3M6IHByb3BzLnByaWNlQ2xhc3MgfSA6IHt9KSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGNmbkRpc3RyaWJ1dGlvbiA9IHRoaXMuZGlzdHJpYnV0aW9uLm5vZGVcbiAgICAgIC5kZWZhdWx0Q2hpbGQgYXMgY2xvdWRmcm9udC5DZm5EaXN0cmlidXRpb247XG4gICAgY2ZuRGlzdHJpYnV0aW9uLmFkZE1ldGFkYXRhKENIQUxMRU5HRV9SRVNUT1JBVElPTl9NRVRBREFUQV9LRVksIHtcbiAgICAgIGNvbnRyYWN0SWQ6IENIQUxMRU5HRV9SRVNUT1JBVElPTl9DT05UUkFDVF9JRCxcbiAgICAgIGFsaWFzQnJpZGdlOiB0aGlzLmFsaWFzQnJpZGdlRW5hYmxlZCxcbiAgICAgIHNvdXJjZUhlYWRlcnM6IHRoaXMucmVzdG9yZVNvdXJjZUhlYWRlcnMsXG4gICAgICByb3V0ZUNvdW50OiB0aGlzLmRlcml2ZWRSb3V0ZVBhdGhzLmxlbmd0aCxcbiAgICB9KTtcbiAgfVxufVxuXG4vKiogRmFpbHMgY2xvc2VkIHVubGVzcyB0aGUgb3JpZ2luIGlzIGFuIEFXUyBBUEkgR2F0ZXdheSBSRVNUIEFQSSB2MS4gKi9cbmZ1bmN0aW9uIGFzc2VydFJlc3RWMU9yaWdpbihcbiAgb3JpZ2luOiBhcGlndy5JUmVzdEFwaSB8IHVuZGVmaW5lZCxcbik6IGFzc2VydHMgb3JpZ2luIGlzIGFwaWd3LklSZXN0QXBpIHtcbiAgaWYgKFxuICAgIG9yaWdpbiA9PT0gdW5kZWZpbmVkIHx8XG4gICAgdHlwZW9mIG9yaWdpbi5yZXN0QXBpSWQgIT09IFwic3RyaW5nXCIgfHxcbiAgICBvcmlnaW4ucmVzdEFwaUlkLmxlbmd0aCA9PT0gMCB8fFxuICAgIHR5cGVvZiBvcmlnaW4ucmVzdEFwaVJvb3RSZXNvdXJjZUlkICE9PSBcInN0cmluZ1wiIHx8XG4gICAgb3JpZ2luLnJlc3RBcGlSb290UmVzb3VyY2VJZC5sZW5ndGggPT09IDBcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKE5PTl9SRVNUX1YxX09SSUdJTl9NRVNTQUdFKTtcbiAgfVxufVxuXG4vKipcbiAqIEJ1aWxkcyB0aGUgSFRUUFMtb25seSBgZXhlY3V0ZS1hcGlgIG9yaWdpbiBmb3IgYW4gQVdTIEFQSSBHYXRld2F5IFJFU1QgQVBJIHYxLlxuICpcbiAqIGBjbG91ZGZyb250LW9yaWdpbnNgJyBgUmVzdEFwaU9yaWdpbmAgYWNjZXB0cyBhIGBSZXN0QXBpQmFzZWAgKGl0IHJlYWRzIHRoZVxuICogY29uY3JldGUgYHVybGAgdG9rZW4pLCBub3QgdGhlIGBJUmVzdEFwaWAgdGhpcyBjb25zdHJ1Y3QgdGFrZXMsIGFuZCBgSVJlc3RBcGlgXG4gKiBleHBvc2VzIG5laXRoZXIgYHVybGAgbm9yIGB1cmxGb3JQYXRoYC4gVGhlIGV4ZWN1dGUtYXBpIG9yaWdpbiBpcyB0aGVyZWZvcmVcbiAqIGJ1aWx0IGZyb20gYHJlc3RBcGlJZGAsIHRoZSBzdGFjayByZWdpb24gYW5kIFVSTCBzdWZmaXgsIGFuZCB0aGUgZGVwbG95bWVudFxuICogc3RhZ2UncyBvcmlnaW4gcGF0aC5cbiAqL1xuZnVuY3Rpb24gYnVpbGRSZXN0VjFPcmlnaW4oXG4gIHNjb3BlOiBDb25zdHJ1Y3QsXG4gIG9yaWdpbjogYXBpZ3cuSVJlc3RBcGksXG4pOiBvcmlnaW5zLkh0dHBPcmlnaW4ge1xuICBjb25zdCBzdGFjayA9IFN0YWNrLm9mKHNjb3BlKTtcbiAgY29uc3Qgb3JpZ2luRG9tYWluTmFtZSA9IGAke29yaWdpbi5yZXN0QXBpSWR9LmV4ZWN1dGUtYXBpLiR7c3RhY2sucmVnaW9ufS4ke3N0YWNrLnVybFN1ZmZpeH1gO1xuICBjb25zdCBzdGFnZU5hbWUgPSBvcmlnaW4uZGVwbG95bWVudFN0YWdlPy5zdGFnZU5hbWU7XG4gIHJldHVybiBuZXcgb3JpZ2lucy5IdHRwT3JpZ2luKG9yaWdpbkRvbWFpbk5hbWUsIHtcbiAgICBwcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5PcmlnaW5Qcm90b2NvbFBvbGljeS5IVFRQU19PTkxZLFxuICAgIC4uLihzdGFnZU5hbWUgPyB7IG9yaWdpblBhdGg6IGAvJHtzdGFnZU5hbWV9YCB9IDoge30pLFxuICB9KTtcbn1cblxuLyoqXG4gKiBEZXJpdmVzIHRoZSBjb21wbGV0ZSBkZWR1cGVkLCBzb3J0ZWQgcm91dGUgc2V0IGZvciB0aGUgZWZmZWN0aXZlIHJlc291cmNlXG4gKiBwYXRocyB1c2luZyBvbmx5IHRoZSBzaGFyZWQgcm91dGUgYWxnZWJyYSAobmV2ZXIgaGFuZC13aXJlZCkuXG4gKi9cbmZ1bmN0aW9uIGRlcml2ZVJvdXRlUGF0aHMoY29uZmlndXJlZFJlc291cmNlUGF0aHM/OiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgZWZmZWN0aXZlUmVzb3VyY2VQYXRocyA9XG4gICAgY29uZmlndXJlZFJlc291cmNlUGF0aHMgIT09IHVuZGVmaW5lZCAmJiBjb25maWd1cmVkUmVzb3VyY2VQYXRocy5sZW5ndGggPiAwXG4gICAgICA/IGNvbmZpZ3VyZWRSZXNvdXJjZVBhdGhzXG4gICAgICA6IEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5zdXBwb3J0ZWRFbmRwb2ludFRlbXBsYXRlcygpLm1hcChcbiAgICAgICAgICAodGVtcGxhdGUpID0+IHRlbXBsYXRlLm1jcFBhdHRlcm4sXG4gICAgICAgICk7XG5cbiAgY29uc3QgZGVyaXZhdGlvbnM6IEFycmF5PChyZXNvdXJjZVBhdGg6IHN0cmluZykgPT4gc3RyaW5nPiA9IFtcbiAgICAocmVzb3VyY2VQYXRoKSA9PiByZXNvdXJjZVBhdGgsXG4gICAgKHJlc291cmNlUGF0aCkgPT5cbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5wcm90ZWN0ZWRSZXNvdXJjZVBhdGhGb3JSZXNvdXJjZVBhdGgocmVzb3VyY2VQYXRoKSxcbiAgICAocmVzb3VyY2VQYXRoKSA9PlxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmF1dGhvcml6YXRpb25TZXJ2ZXJQYXRoRm9yUmVzb3VyY2VQYXRoKHJlc291cmNlUGF0aCksXG4gICAgKHJlc291cmNlUGF0aCkgPT5cbiAgICAgIEFwcFRoZW9yeU1jcFJvdXRlQWxnZWJyYS5hdXRob3JpemF0aW9uQXV0aG9yaXplUGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGgpLFxuICAgIChyZXNvdXJjZVBhdGgpID0+XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblRva2VuUGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGgpLFxuICAgIChyZXNvdXJjZVBhdGgpID0+XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblJlZ2lzdGVyUGF0aEZvclJlc291cmNlUGF0aChyZXNvdXJjZVBhdGgpLFxuICAgIChyZXNvdXJjZVBhdGgpID0+XG4gICAgICBBcHBUaGVvcnlNY3BSb3V0ZUFsZ2VicmEuYXV0aG9yaXphdGlvblNlcnZlclN1ZmZpeFBhdGhGb3JSZXNvdXJjZVBhdGgocmVzb3VyY2VQYXRoKSxcbiAgXTtcblxuICBjb25zdCBkZXJpdmVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgcmVzb3VyY2VQYXRoIG9mIGVmZmVjdGl2ZVJlc291cmNlUGF0aHMpIHtcbiAgICBmb3IgKGNvbnN0IGRlcml2ZSBvZiBkZXJpdmF0aW9ucykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgZGVyaXZlZC5hZGQoZGVyaXZlKHJlc291cmNlUGF0aCkpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBBcHBUaGVvcnlSZXN0VjFDaGFsbGVuZ2VSZXN0b3JhdGlvbjogcmVzb3VyY2VQYXRocyBlbnRyeSBcIiR7cmVzb3VyY2VQYXRofVwiIGlzIG5vdCBhIHJvdXRlIHRoZSByb3V0ZSBtb2RlbCBjYW4gZGVyaXZlOiAke2Vycm9yTWVzc2FnZShlcnJvcil9YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBUaGUgdXBzdHJlYW0gT0F1dGggY2FsbGJhY2sgaXMgc3RhZ2UtZ2xvYmFsLCBzbyBpdCBpcyBkZXJpdmVkIGV4YWN0bHkgb25jZVxuICAvLyByYXRoZXIgdGhhbiBwZXIgcmVzb3VyY2UgcGF0aC4gVGhlIGNvbnRyYWN0IGRlZmF1bHQgaXMgYWx3YXlzIGRlcml2YWJsZS5cbiAgZGVyaXZlZC5hZGQoXG4gICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLmNhbGxiYWNrUGF0aEZvckNvbmZpZ3VyZWRQYXRoKFxuICAgICAgQXBwVGhlb3J5TWNwUm91dGVBbGdlYnJhLkRFRkFVTFRfQ0FMTEJBQ0tfUEFUSCxcbiAgICApLFxuICApO1xuXG4gIHJldHVybiBBcnJheS5mcm9tKGRlcml2ZWQpLnNvcnQoKTtcbn1cblxuLyoqIFJldHVybnMgYSB0aHJvd24gdmFsdWUncyBtZXNzYWdlIHdpdGhvdXQgYXNzdW1pbmcgaXQgaXMgYW4gRXJyb3IuICovXG5mdW5jdGlvbiBlcnJvck1lc3NhZ2UoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICByZXR1cm4gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xufVxuIl19