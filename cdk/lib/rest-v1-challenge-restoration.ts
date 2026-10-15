import { Stack } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

import { AppTheoryMcpRouteAlgebra } from "./mcp-route-algebra";
import { generateRestV1ChallengeRestorationHandlerCode } from "./private/rest-v1-challenge-restoration-handler";

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
const NON_REST_V1_ORIGIN_MESSAGE =
  "AppTheoryRestV1ChallengeRestoration: origin must be an AWS API Gateway REST API (v1); " +
  "the WWW-Authenticate restoration is a documented no-op on HTTP API v2";

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
export class AppTheoryRestV1ChallengeRestoration extends Construct {
  /** The CloudFront distribution fronting the REST v1 origin. */
  public readonly distribution: cloudfront.Distribution;

  /**
   * The response headers the restoration function consults, in priority order.
   *
   * `["x-amzn-remapped-www-authenticate"]` when the alias bridge is disabled;
   * `["x-amzn-remapped-www-authenticate", "x-theory-www-authenticate",
   * "mcp-www-authenticate"]` when it is enabled.
   */
  public readonly restoreSourceHeaders: string[];

  /** True when the optional alias bridge is enabled. */
  public readonly aliasBridgeEnabled: boolean;

  /**
   * The complete route set derived from the shared route algebra (parameterized
   * routes included), deduped and in deterministic sorted order.
   */
  public readonly derivedRoutePaths: string[];

  /**
   * The subset of `derivedRoutePaths` emitted as explicit ordered cache
   * behaviors (the literal paths, with no `{parameter}` segment).
   *
   * CloudFront path patterns cannot express a `{param}` segment, so
   * parameterized derived routes are covered by the default behavior.
   */
  public readonly behaviorPathPatterns: string[];

  public constructor(
    scope: Construct,
    id: string,
    props: AppTheoryRestV1ChallengeRestorationProps,
  ) {
    super(scope, id);

    const origin = (props as { origin?: apigw.IRestApi }).origin;
    assertRestV1Origin(origin);

    if (
      props.domainNames !== undefined &&
      props.domainNames.length > 0 &&
      props.certificate === undefined
    ) {
      throw new Error(
        "AppTheoryRestV1ChallengeRestoration: domainNames requires certificate",
      );
    }

    this.aliasBridgeEnabled = props.aliasBridge?.enabled === true;
    this.restoreSourceHeaders = this.aliasBridgeEnabled
      ? [REMAP_SOURCE_HEADER, ...ALIAS_SOURCE_HEADERS]
      : [REMAP_SOURCE_HEADER];

    const derivedRoutePaths = deriveRoutePaths(props.resourcePaths);
    if (derivedRoutePaths.length === 0) {
      throw new Error(
        "AppTheoryRestV1ChallengeRestoration: the route model derived no routes from resourcePaths",
      );
    }
    this.derivedRoutePaths = derivedRoutePaths;
    this.behaviorPathPatterns = derivedRoutePaths.filter(
      (pathPattern) => !pathPattern.includes("{") && !pathPattern.includes("}"),
    );

    const restOrigin = buildRestV1Origin(this, origin);

    const restorationFunction = new cloudfront.experimental.EdgeFunction(
      this,
      "ChallengeRestorationFunction",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: lambda.Code.fromInline(
          generateRestV1ChallengeRestorationHandlerCode(this.restoreSourceHeaders),
        ),
        description:
          "Restore the canonical WWW-Authenticate challenge for AppTheory REST v1 origin responses",
      },
    );

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
    const originRequestPolicy = new cloudfront.OriginRequestPolicy(
      this,
      "OriginRequestPolicy",
      {
        comment:
          "AppTheory REST v1 challenge restoration: forward all viewer headers except Host, all cookies and all query strings",
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.denyList("Host"),
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
        queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      },
    );

    const edgeLambdas: cloudfront.EdgeLambda[] = [
      {
        eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
        functionVersion: restorationFunction.currentVersion,
      },
    ];
    const behaviorOptions = (): cloudfront.BehaviorOptions => ({
      origin: restOrigin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      edgeLambdas,
    });

    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};
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
      .defaultChild as cloudfront.CfnDistribution;
    cfnDistribution.addMetadata(CHALLENGE_RESTORATION_METADATA_KEY, {
      contractId: CHALLENGE_RESTORATION_CONTRACT_ID,
      aliasBridge: this.aliasBridgeEnabled,
      sourceHeaders: this.restoreSourceHeaders,
      routeCount: this.derivedRoutePaths.length,
    });
  }
}

/** Fails closed unless the origin is an AWS API Gateway REST API v1. */
function assertRestV1Origin(
  origin: apigw.IRestApi | undefined,
): asserts origin is apigw.IRestApi {
  if (
    origin === undefined ||
    typeof origin.restApiId !== "string" ||
    origin.restApiId.length === 0 ||
    typeof origin.restApiRootResourceId !== "string" ||
    origin.restApiRootResourceId.length === 0
  ) {
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
function buildRestV1Origin(
  scope: Construct,
  origin: apigw.IRestApi,
): origins.HttpOrigin {
  const stack = Stack.of(scope);
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
function deriveRoutePaths(configuredResourcePaths?: string[]): string[] {
  const effectiveResourcePaths =
    configuredResourcePaths !== undefined && configuredResourcePaths.length > 0
      ? configuredResourcePaths
      : AppTheoryMcpRouteAlgebra.supportedEndpointTemplates().map(
          (template) => template.mcpPattern,
        );

  const derivations: Array<(resourcePath: string) => string> = [
    (resourcePath) => resourcePath,
    (resourcePath) =>
      AppTheoryMcpRouteAlgebra.protectedResourcePathForResourcePath(resourcePath),
    (resourcePath) =>
      AppTheoryMcpRouteAlgebra.authorizationServerPathForResourcePath(resourcePath),
    (resourcePath) =>
      AppTheoryMcpRouteAlgebra.authorizationAuthorizePathForResourcePath(resourcePath),
    (resourcePath) =>
      AppTheoryMcpRouteAlgebra.authorizationTokenPathForResourcePath(resourcePath),
    (resourcePath) =>
      AppTheoryMcpRouteAlgebra.authorizationRegisterPathForResourcePath(resourcePath),
    (resourcePath) =>
      AppTheoryMcpRouteAlgebra.authorizationServerSuffixPathForResourcePath(resourcePath),
  ];

  const derived = new Set<string>();
  for (const resourcePath of effectiveResourcePaths) {
    for (const derive of derivations) {
      try {
        derived.add(derive(resourcePath));
      } catch (error) {
        throw new Error(
          `AppTheoryRestV1ChallengeRestoration: resourcePaths entry "${resourcePath}" is not a route the route model can derive: ${errorMessage(error)}`,
        );
      }
    }
  }

  // The upstream OAuth callback is stage-global, so it is derived exactly once
  // rather than per resource path. The contract default is always derivable.
  derived.add(
    AppTheoryMcpRouteAlgebra.callbackPathForConfiguredPath(
      AppTheoryMcpRouteAlgebra.DEFAULT_CALLBACK_PATH,
    ),
  );

  return Array.from(derived).sort();
}

/** Returns a thrown value's message without assuming it is an Error. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
